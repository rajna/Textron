/**
 * Textron — Trainable Textual Neural Network for Agent Context Optimization
 *
 * HYBRID MODE (LLM + programmatic):
 *   1. before_agent_start: pairing judge (match pending task to current message)
 *   2. If feedback matched → defer backward to agent_end (set _backwardPendingMatch)
 *   3. Before_agent_start continues: auto-route network + blocking LLM L0 scores + propagate
 *   4. Compiled path context injected as tool result
 *   5. LLM executes task with compiled context; generates HighEntropy response (经验总结)
 *   6. agent_end: extract HighEntropy → if _backwardPendingMatch set, run backward NOW
 *      → backward LLM receives enhanced feedback with assistant's just-generated HighEntropy
 *      → higher quality training signal vs asking backward LLM to fabricate from raw context
 *
 * Storage: ~/.textron/{task_family}/
 *   hyperparams.json / weights.json / layer_N/node_X.html
 *
 * Live Monitor: http://localhost:8766
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import {
  createNodeState, updateCounts, maybeDistill,
  serializeState, deserializeState, calcSignalScores,
  type NodeNgramState,
} from "./ngram_distill";
import { buildTextronPromptInjection } from "./prompt_injection";
import { buildBackwardTaskContext, serializeTaskForState, restoreTaskPrompt } from "./lifecycle_context";
// 任务侧域闸（n8 第十五轮）：与 rule 0 对称的另一半 —— 离域任务的内容零写入。
// 裁决逻辑与规则文本均从模块导入，禁止在此内联复刻（单一事实来源）。
import { evaluateTaskDomainGate, taskDomainGateRule } from "./domain_gate";
import { chooseTaskFamilyRoute } from "./learning_policy";
import { assistantMessageText, extractHighEntropy, extractLatestHighEntropyFromMessages, parseHighEntropyCrystal } from "./highentropy";
import { distillNodeName, buildAtomKey } from "./name_distill.ts";
import { applyExplorationPolicy, buildLocalScores, lexicalRelevance, parseNodeScores, rankLayerWithExploration } from "./scoring_policy";
import { routeL0ThroughMoe } from "./moe_router.ts";
import { decideNoveltyExpansion } from "./novelty_policy.ts";
import { DEFAULT_COMPILED_CONTEXT_MAX_CHARS, NODE_CONTENT_MAX_CHARS, applyContentLimit } from "./content_limits.ts";

// ─── Lib modules ────────────────────────────────────────────────
import { ensureDir, readJson, writeJson, ts, dlog, clamp, completeContent,
         parseLayerNodeId, seedRandom, formatNodesForLLM, previewText } from "./lib/utils";
import { shannonEntropy, wordEntropy, isTruncated, isTemporalSummary, isMetaInstruction } from "./lib/entropy";
import { lastUserMessageText, rebuildToolsFromMessages, rebuildToolsFromMessagesDetailed, rebuildThinkingFromMessages,
         rebuildThinkingFromMessagesDetailed } from "./lib/round_snapshot";
import type { ToolsFidelityStats, ThinkingFidelityStats } from "./lib/round_snapshot";
import { readNodeContent, compressNodeName, readNodeName, writeNodeHtml, readNodeFunction, writeNodeFunction,
         validateKnowledgeCrystal, intraLayerOrthogonalityCheck, NODE_FN_BLOCK_MAX,
         isNgramFragmentContent, isNgramFragmentName, contextSimilarity, prepareContextLine } from "./lib/node_io";
import { normalizeMergeFragment, mergeDistinctContentFragments,
         mergeNodeContent, mergeContent } from "./lib/merge";
import { tfidfTokens, buildTfidfIndex, cosineSim, tfidfSimilarity, stripFunctionBlocks,
         nameTokens, jaccard, tokenSimilarity, findSimilarNode, findSimilarKnowledgeNode } from "./lib/similarity";
import { TEXTRON_HOME, DEFAULT_HYPERPARAMS, DEFAULT_WEIGHT, NGRAM_DISTILL_PROMOTE,
         TEXTRON_ALLOW_NODE_GROWTH, getTaskFamilyPath, networkExists, listNetworks,
         initNetwork, loadNetwork, layerCapFor, DEFAULT_LAYER_CAP,
         readNetworkGoal, writeNetworkGoal, NETWORK_GOAL_MAX_CHARS } from "./lib/network";
import { compileContext, selectedEdgeIdToWeightKey } from "./lib/compile";
import { computePageRank } from "./lib/pagerank";
import { lateralDiffuse, materialize, trainPair } from "./lib/topology";
import { buildBudgetParams, canBoundThinking, readCompatFromDisk } from "./lib/llm_budget";
import { RESCALE_DOWN_REASONS, RESCALE_UP_REASONS, RESCALE_PENDING_LIMIT,
         RESCALE_PAIR_MIN_SIM, rescalePendingPath, readRescalePending,
         writeRescalePending, tryUpscalePair, rescaleRejectedCrystal,
         type RescalePendingItem } from "./lib/rescale";
import { setRecordArtifactEvent, chooseExpansionLayer, updateExistingNodeByPolicy,
         addPolicyNode, compactMergeEmptiedNodes, compactEmptyNodes, addDynamicNode, commitNodeHtmlEdges } from "./lib/node_policy";
import { liftMergeNodes, mergeLayerAllowed } from "./lib/lift_merge";

// ─── Types ──────────────────────────────────────────────────────────

interface Hyperparams {
  layers: number[];
  /** 每层节点容量上限（用户显式配置）。缺省回落 DEFAULT_LAYER_CAP(40)。 */
  layerCaps?: number[];
  threshold: number;
  learningRate: number;
  createdAt: string;
  updatedAt: string;
}

interface Edge {
  from: string;
  to: string;
  weight: number;
}

interface WeightsFile {
  layer_connections: Record<string, Edge[]>;
}

interface ActivatedNode {
  id: string;
  layer: number;
  content: string;
  activation: number;
}

// ─── Remaining locals (not extracted) ───────────────────────────────

// const HIGH_ENTROPY_INSTRUCTION = `

// ## Textron HighEntropy Output Contract
// At the very end of your final user-facing answer, append exactly one XML block. **NEVER skip this block** — even for short replies like "收到" or brief summaries. Textron backward consumes it as training data; missing HighEntropy = lost learning opportunity.
// <HighEntropy>
// Name: ≤48 chars. Join 3-6 highest-entropy ORIGINAL terms lifted from Task+Technique (identifiers, domain signals, key numbers). Routing sees only Name, so avoid generic summary sentences or prefix truncation.
// TaskType: ≤15 chars. Task category label for feedback matching, e.g. "A股涨跌预测" "Textron协议修复" "代码审查". Write in the language of the task domain.
// isTask: true|false. Whether this reply is part of a task that may receive follow-up feedback. true = save to taskStack for later backward matching; false = intermediate/transient reply, do not push.
// Task: ≤100 chars. State the concrete problem being solved: object, goal, and decisive constraint. Do not narrate steps taken.
// Technique: ≤500 chars. **CRITICAL for reflection/feedback replies**: pack root cause analysis AND corrective rules into this field. Preserve the highest-information "道或术" used to solve the task: reusable principle plus concrete method, causal mechanism, decision boundary, failure correction, and validation signal. Prefer the answer's most information-dense sentences and distinctive vocabulary; keep exact identifiers/numbers when they change future decisions. No raw logs, file lists, URLs, vague progress, or boilerplate.
// <Function> OPTIONAL block — emitted IN ADDITION to the 5 fields above (they stay unchanged). Function = 从本轮解法蒸馏的可执行代码。
// 1. Functionability self-check (ALL 3 yes → emit; else omit the block entirely): ① Will this task family recur (loop / repeated executions)? ② Is the input parameterizable (structured data: quotes / horoscope / error codes / metrics)? ③ Is the output objectively verifiable (an actual result exists to check against)? One-off creative tasks (PPT, drawing, copywriting) → omit.
// 2. Emit exactly two fields:
// functionSymbol: short snake_case symbol name mirroring Name's core terms — later node contents cite it verbatim (substring-matchable), enabling citation-chain routing.
// functionAbstract: generalized executable code distilled from THIS round's solution path — concrete numbers → params, solution steps → function body. Distill the 术 (reusable computation), never narrate the session.
// 3. NO action/target/version/diff metadata, NO rule-number maintenance — create/modify/dedup/version evolution is backward+merge's system job. The LLM only distills code; same-symbol functions merge and evolve naturally in the network.
// </Function>
// </HighEntropy>`;

const HIGH_ENTROPY_INSTRUCTION = `

## Textron HighEntropy 输出契约
在面向用户的最终回答的末尾，**必须追加一个且仅一个HighEntropy块**。**绝不允许省略该代码块**——即便是“收到”这类简短回复、简短摘要也不能例外。Textron的反向流程会将该块用作训练数据；缺失HighEntropy等同于丢失训练学习机会。
格式和要求如下:
<HighEntropy>
Name：≤25字符。从Task与Technique中提取3‑6个信息熵最高的原始术语拼接而成（标识符、领域特征、关键数值）。路由模块仅读取Name字段，因此禁止使用泛化概括语句，也不要做前缀截断。
TaskType：≤15字符。用于反馈匹配的任务分类标签，示例：“A股涨跌预测”“Textron协议修复”“代码审查”。使用任务所属领域的专业语言填写。
isTask：true|false。标记该回复是否属于会接收后续反馈的任务。true = 存入任务栈，供后续反向匹配；false = 中间临时回复，不压入任务栈。
Task：≤100字符。描述待解决的具体问题：对象、目标、决定性约束条件。不要复述执行步骤。
Technique：≤500字符:本字段需要抽象，归纳，总结，泛化，解决同类任务时信息密度最高的“道或术”：成功经验，失败教训，模式识别 ，未来遇到同样问题的可复用原理+具体方法、因果机制、判定边界、错误修正方案、校验信号。优先选用回答中信息最密集的语句与专属术语，满足高熵 凝练 抽象 压缩 多维 正交原则；凡是会影响后续决策的标识符、数值必须原样保留。禁止原始日志、文件列表、链接、模糊进度描述、模板套话。
<Function>在上述5个字段之外额外输出（原有5个字段保持不变）。Function = 基于上面Technique的分析，落地解决同类任务的可执行python代码。
1. 功能可用性自检（全部3项满足才输出该块，否则直接省略整个块）：
① 该类任务会重复发生（循环/可多次执行/可泛化/可被编程）？
② 输入可参数化？
③ 输出可客观校验（存在可供核对的真实结果）？
一次性创作类任务（PPT、绘图、文案撰写）→ 省略该块。
2. 仅输出两个字段：
functionSymbol：简短函数名，命名符号高熵，任务相关；后续节点会直接引用该名称（支持子串匹配），实现引用链路由。
functionAbstract：由本轮求解路径抽象得到的通用可执行代码 — 把硬编码具体数值改为参数，求解步骤转为函数体。只提炼可复用的“术”（计算逻辑），不要复述会话过程，不要重复Technique。
3. 禁止动作/目标/版本/差异元数据，无需维护规则编号；函数的创建、修改、去重、版本迭代由后端合并系统负责。大模型只负责蒸馏代码；同名符号的函数会在网络中自动完成合并迭代。
</Function>
</HighEntropy>`;

// 2026-09-03: 反馈轮 content 全量护栏(正常消息远小于此, 仅防御异常巨包; 不再 2000c 截断)
const FEEDBACK_PROMPT_MAX = 30000;

function readonlyNgramPath(nodePath: string): string {
  return nodePath.replace(/\.html$/, ".ngram.json");
}

function readNgramState(nodePath: string): NodeNgramState {
  try {
    const raw = fs.readFileSync(readonlyNgramPath(nodePath), "utf-8");
    return deserializeState(raw);
  } catch {
    return createNodeState();
  }
}

function writeNgramState(nodePath: string, state: NodeNgramState): void {
  fs.writeFileSync(readonlyNgramPath(nodePath), serializeState(state), "utf-8");
}

function loadAllNgramStates(net: NonNullable<ReturnType<typeof loadNetwork>>): NodeNgramState[] {
  const states: NodeNgramState[] = [];
  for (let l = 0; l < net.hyperparams.layers.length; l++) {
    for (let n = 0; n < net.hyperparams.layers[l]; n++) {
      const np = path.join(net.path, `layer_${l}`, `node_${n}.html`);
      states.push(readNgramState(np));
    }
  }
  return states;
}

function getNgramStats(net: NonNullable<ReturnType<typeof loadNetwork>>): { stateFiles: number; totalActivations: number; successfulActivations: number; distillReady: number } {
  let stateFiles = 0, totalActivations = 0, successfulActivations = 0, distillReady = 0;
  for (let l = 0; l < net.hyperparams.layers.length; l++) {
    for (let n = 0; n < net.hyperparams.layers[l]; n++) {
      const np = path.join(net.path, `layer_${l}`, `node_${n}.html`);
      const sp = readonlyNgramPath(np);
      if (!fs.existsSync(sp)) continue;
      stateFiles++;
      const st = readNgramState(np);
      totalActivations += st.totalActivations || 0;
      successfulActivations += st.successfulActivations || 0;
      if ((st.successfulActivations || 0) - (st.lastDistillAt || 0) >= 3) distillReady++;
    }
  }
  return { stateFiles, totalActivations, successfulActivations, distillReady };
}

function recordArtifactEvent(data: Record<string, unknown>) {
  const eventsPath = path.join(TEXTRON_HOME, "_events.jsonl");
  try {
    fs.appendFileSync(eventsPath, JSON.stringify({ ...data, ts: new Date().toISOString() }) + "\n", "utf-8");
  } catch {}
}

// Wire recordArtifactEvent into node_policy/rescale modules
setRecordArtifactEvent(recordArtifactEvent);

function topScores(scores: Record<string, number>): Record<string, number> {
  const entries = Object.entries(scores).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  return Object.fromEntries(entries.slice(0, 5));
}


// ─── Extension Entry ─────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // Session-level state
  let currentTaskFamily: string | null = null;
  let currentActivatedIds: string[] = [];
  let currentActivationScores: Record<string, number> = {};
  let currentSelectedEdgeIds: string[] = [];
  let currentRawUserPrompt = "";
  let currentEffectivePrompt = "";
  let currentUserInjection = "";
  let currentContextAuditLogged = false;
  let currentProviderAuditLogged = false;
  let currentAssistantBuffer = "";
  let currentAssistantHighEntropy = "";
  // 2026-09-04: 回合执行记录缓冲(tool_call/tool_result 摘要)——agent_end 统一拼接进任务 processLog,
  // 使 backward/pairing LLM 能见到决策/结果/复盘等工具通道信息(修复 tool_result 只 recordMonitorEvent 不消费的配对盲区)。
  let currentTurnTools: string[] = [];
  let currentTurnThinking = "";
  let currentHighEntropyLogged = false;
  let currentRouteUncertain = false;
  let currentMoeMaxScore = 0;
  // ── Task Stack: multi-task feedback pairing (replaces single-pending slot) ──
  interface TaskEntry {
    taskType: string;         // ≤15 chars, from HighEntropy, for LLM fast matching
    taskFamily: string;
    rawUserPrompt: string;
    effectivePrompt: string;
    highEntropy: string;
    activatedIds: string[];
    selectedEdgeIds: string[];
    routeUncertain: boolean;
    moeMaxScore: number;
    ts: string;
    /** 中间动作消息的过程累积: 任务开始后→反馈到达前 该任务经历的执行轮次(供反传上下文) */
    processLog: string[];
  }
  const MAX_TASK_STACK = 5;
  const MAX_PROCESS_ENTRY_CHARS = 20000;     // 单条过程记录上限(字符)
  // 2026-09-15 n8 第十一轮：轨迹保真 —— 原值 700 使单条 exec 上下文被截到 1200c，
  // 叠加 tool_result 640c / tools 尾截 1800c / 总预算 4800c，使一轮 20+ 次工具调用 +
  // 数 KB 的交易 JSON 到反传手里只剩 ≤1.2KB 碎片 ⇒ reward 恒 0 / quality=low。
  // 实测真值（决定阈值）：/api/prompt 响应 9009B（prompt 字段 4348c）；/api/saves 135694c。
  // 因此单条上限必须 ≥ 单次交易 API 响应的完整长度，否则「最原始数据」必被砍。
  const MAX_TASK_PROCESS_ENTRIES = 24;        // 每任务最多保留过程条数(超出滚动丢最旧)
  const MAX_TASK_PROCESS_TOTAL_CHARS = 40000; // 每任务过程总字符上限(防反传上下文膨胀)
  // 2026-09-03 信息获取策略: 中间轮 HE 优先→无HE用 LLM 蒸馏(非slice); 反馈轮全量; AI思考默认排除(参数可选)
  const DISTILL_INTERMEDIATE = process.env.TEXTRON_DISTILL_INTERMEDIATE !== "0"; // 默认开
  const INCLUDE_THINKING = process.env.TEXTRON_INCLUDE_THINKING === "1";          // 默认关
  const MAX_DISTILL_OUTPUT = 520;        // 蒸馏输出目标长(字符)
  const MAX_FALLBACK_TAIL = 640;         // 无HE且蒸馏不可用时的正文尾保底长度
  let activeTask: TaskEntry | null = null;
  let taskStack: TaskEntry[] = [];  // FIFO, max MAX_TASK_STACK
  let lastBackwardState: Record<string, unknown> | null = null;
  let _backwardPendingMatch: TaskEntry | null = null;  // backward deferred to agent_end
  let _lastTurnId: string | null = null;   // 轨迹配对链：上一轮 turnId（任务→行动→反馈）
  let _backwardPendingCtx: any = null;
  // 2026-08-19: 异步 backward 串行队列 —— 防并发写网络文件(节点/边/权重)
  let _backwardChain: Promise<void> = Promise.resolve();
  function enqueueBackward(fn: () => Promise<void>) {
    _backwardChain = _backwardChain.then(fn).catch((e) => console.error(`[textron] async backward crashed:`, e));
  }
  // 2026-09-03: 蒸馏/思考过滤——中间轮信息获取策略的核心工具
  function stripThinkingText(text: unknown): string {
    const s = String(text || "");
    if (INCLUDE_THINKING) return s.trim();
    return s.replace(/<thinking>[\s\S]*?<\/thinking>/gi, " ")
      .replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, " ")
      .replace(/\[思维链[\s\S]*?\]\]/gi, " ")
      .replace(/\s{2,}/g, " ").trim();
  }
  // 中间轮无 HE 时用 LLM 蒸馏(而非机械 slice): 输入本轮原文(不含思考), 输出 ≤MAX_DISTILL_OUTPUT 结构化要点。
  // 失败返回 "" → 调用方回退正文尾保底。串行队列由调用方(enqueueBackward)保证不阻塞 agent_end。
  async function distillTurnEntry(rawIn: string, rawOut: string, ctx: any): Promise<string> {
    try {
      const model = _textronModel;
      if (!model?.id || !model?.baseUrl) return "";
      const budget = buildBudgetParams(
        { id: model.id, provider: model.provider, baseUrl: model.baseUrl },
        resolveModelCompat(model), 1024, { noThinking: true },
      );
      const baseUrl = String(model.baseUrl).replace(/\/+$/, "");
      const { apiKey } = await resolveModelApiKey(ctx, model);
      if (!apiKey) return "";
      const distillPrompt = `把下面这轮 agent 交互过程压缩为 ≤${MAX_DISTILL_OUTPUT} 字符的结构化中文摘要。保留: 决策/方向/关键数值/原因/结果/硬性约束。禁止思维链、禁止逐句流水账、禁止空话。\n\n[用户消息]\n${String(rawIn || "").slice(0, 6000)}\n[助手回复]\n${String(rawOut || "").slice(0, 6000)}\n\n输出 ONLY 原始 JSON: {\"summary\":\"…\"}`;
      const res = await fetch(joinApiEndpoint(baseUrl, "/chat/completions"), {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
        body: JSON.stringify({ model: model.id, messages: [{ role: "user", content: distillPrompt }], ...budget, temperature: 0.2 }),
        signal: AbortSignal.timeout(25000),
      });
      if (!res.ok) return "";
      const data = await res.json();
      const raw = data?.choices?.[0]?.message?.content || "";
      const parsed = JSON.parse(raw.replace(/```json\n?|```/g, "").trim());
      const sum = String(parsed?.summary || "").trim();
      return sum.slice(0, MAX_DISTILL_OUTPUT + 20);
    } catch (e) {
      dlog("DISTILL", "distill failed", { error: e instanceof Error ? e.message : String(e) });
      return "";
    }
  }
  function enqueueBackwardWithResult<T>(fn: () => Promise<T>): Promise<T> {
    let resolveFn!: (v: T) => void;
    let rejectFn!: (e: any) => void;
    const p = new Promise<T>((res, rej) => { resolveFn = res; rejectFn = rej; });
    enqueueBackward(async () => {
      try { resolveFn(await fn()); } catch (e) { rejectFn(e); }
    });
    return p;
  }

  const log = (msg: string) => {
    try { pi.appendEntry("textron-log", { msg, ts: new Date().toISOString() }); } catch {}
    broadcast({ type: "log", msg, ts: Date.now() });
  };

  // ── HTTP Server for live monitoring ────────────────────────────
  const SSE_CLIENTS = new Set<http.ServerResponse>();
  const PORT = parseInt(process.env.TEXTRON_MONITOR_PORT || "8766", 10);

  function broadcast(data: Record<string, unknown>) {
    const eventType = data.type || "message";
    const msg = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of SSE_CLIENTS) {
      try { res.write(msg); } catch { SSE_CLIENTS.delete(res); }
    }
  }

  const EVENTS_PATH = path.join(TEXTRON_HOME, "_events.jsonl");
  // ── 统一轨迹文件: _trajectories.jsonl 同时承载 kind:"turn"(对话) 与 kind:"backward"(反传输入输出)
  //    对话行 turnId ↔ backward 行 turnId 关联; turn 行 backward.ran 标记该轮是否发生反传 ──
  function genTurnId(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }
  function appendTrajectoryLine(entry: Record<string, unknown>): void {
    try {
      ensureDir(TEXTRON_HOME);
      const p = path.join(TEXTRON_HOME, "_trajectories.jsonl");
      fs.appendFileSync(p, JSON.stringify(entry) + "\n", "utf-8");
      // 真·永久: 主文件限 800 条内, 超限最旧段转存 _trajectories_archive/archive_YYYY-MM.jsonl(不删除)
      archiveTrajectoryOverflow(p, 800);
    } catch { /* 轨迹记录失败不影响主流程 */ }
  }
  // backward 完成后回填对应对话行的 backward 结果字段(ran/ts/reward/rationale/status)
  function updateTrajectoryTurnBackward(turnId: string, patch: Record<string, unknown>): void {
    try {
      const p = path.join(TEXTRON_HOME, "_trajectories.jsonl");
      if (!fs.existsSync(p)) return;
      const lines = fs.readFileSync(p, "utf-8").split("\n");
      let changed = false;
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i];
        if (!line.trim()) continue;
        try {
          const e = JSON.parse(line);
          if (e && e.kind === "turn" && e.turnId === turnId) {
            // patch 携带 ran/status/reward 等; 调用点显式给 ran(skip 场景 ran:false)
            e.backward = { ran: false, ts: new Date().toISOString(), ...patch };
            lines[i] = JSON.stringify(e);
            changed = true;
            break;
          }
        } catch { /* 坏行跳过 */ }
      }
      if (changed) fs.writeFileSync(p, lines.join("\n"), "utf-8");
    } catch { /* 忽略 */ }
  }
  // 回填 turn 行的任务元信息(顶层字段, 不碰 backward): isTask/TaskType/入栈状态
  function updateTrajectoryTurnMeta(turnId: string, patch: Record<string, unknown>): void {
    try {
      const p = path.join(TEXTRON_HOME, "_trajectories.jsonl");
      if (!fs.existsSync(p)) return;
      const lines = fs.readFileSync(p, "utf-8").split("\n");
      let changed = false;
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i];
        if (!line.trim()) continue;
        try {
          const e = JSON.parse(line);
          if (e && e.kind === "turn" && e.turnId === turnId) {
            Object.assign(e, patch);
            lines[i] = JSON.stringify(e);
            changed = true;
            break;
          }
        } catch { /* 坏行跳过 */ }
      }
      if (changed) fs.writeFileSync(p, lines.join("\n"), "utf-8");
    } catch { /* 忽略 */ }
  }
  // Default is global for normal pi sessions; spawned workflows can set TEXTRON_STATE_FILE
  // to keep backward state scoped to a job/beat chain instead of racing other Pi sessions.
  const LAST_STATE_PATH = process.env.TEXTRON_STATE_FILE || path.join(TEXTRON_HOME, "_last_state.json");
  let _monitorEventWriteFailed = false;
  function recordMonitorEvent(data: Record<string, unknown>) {
    try {
      ensureDir(TEXTRON_HOME);
      const line = JSON.stringify({ ...data, ts: new Date().toISOString() }) + "\n";
      fs.appendFileSync(EVENTS_PATH, line, "utf-8");
      // 旁路心跳文件：每次成功写入更新 mtime，用于诊断是否真的在写入
      if (!_monitorEventWriteFailed) {
        try { fs.writeFileSync(path.join(TEXTRON_HOME, "_events_heartbeat"), line.slice(0, 200), "utf-8"); } catch {}
      }
    } catch (e) {
      _monitorEventWriteFailed = true;
      const errMsg = (e as Error).message || String(e);
      console.error(`[textron] recordMonitorEvent failed: ${errMsg}`, { path: EVENTS_PATH, size: fs.existsSync(EVENTS_PATH) ? fs.statSync(EVENTS_PATH).size : -1 });
      // 旁路写入失败日志
      try { fs.appendFileSync(path.join(TEXTRON_HOME, "_events_error.log"), `${new Date().toISOString()} | ${errMsg}\n`, "utf-8"); } catch {}
    }
  }
  function appendArtifactAudit(data: Record<string, unknown>) {
    const entry = { ...data, ts: new Date().toISOString() };
    recordMonitorEvent(entry);
    try { pi.appendEntry("textron-artifact-quarantine", entry); } catch {}
  }
  function recordPromptAudit(data: Record<string, unknown>) {
    const entry = { ...data, ts: new Date().toISOString() };
    recordMonitorEvent(entry);
    try { pi.appendEntry("textron-effective-prompt-audit", entry); } catch {}
  }
  function preview(text: unknown, max = 160): string {
    return String(text || "").replace(/\s+/g, " ").trim().slice(0, max);
  }
  // 2026-09-04: tool_result content 是 (TextContent|ImageContent)[] 结构化数组(元素 {type:"text",text:...}),
  // String() 直接转得 "[object Object]" → 工具结果全失真。递归白名单取叶子: text/content/output_text/value,
  // 数组逐项递归 join、纯对象 JSON.stringify 兜底(与 highentropy.ts assistantTextPart 同构)。
  function extractToolResultText(content: unknown, depth = 0): string {
    if (depth > 6 || content == null) return "";
    if (typeof content === "string") return content;
    if (typeof content === "number" || typeof content === "boolean") return String(content);
    if (Array.isArray(content)) {
      const parts: string[] = [];
      for (const item of content) {
        const s = extractToolResultText(item, depth + 1).trim();
        if (s) parts.push(s);
      }
      return parts.join("\n");
    }
    if (typeof content === "object") {
      // 1) 白名单叶子键优先(TextContent/Responses 结构)
      for (const k of ["text", "content", "output_text", "outputText", "value"]) {
        const v = (content as Record<string, unknown>)[k];
        if (v == null) continue;
        const s = extractToolResultText(v, depth + 1).trim();
        if (s) return s;
      }
      // 2) 标记型内容(如图片)无文本→空, 不 JSON.stringify 整个 part 防噪音
      const type = String((content as Record<string, unknown>).type || "");
      if (type === "image" || type === "input_image") return "[image]";
      if (type === "text") return "";
      // 3) 兜底: 非 content 结构对象才序列化(如 details 展开)
      try { return JSON.stringify(content); } catch { return String(content); }
    }
    return String(content);
  }
  function topScores(scores: Record<string, number>, limit = 5) {
    return Object.entries(scores)
      .filter(([k]) => k.startsWith("L"))
      .sort((a, b) => Number(b[1]) - Number(a[1]))
      .slice(0, limit)
      .map(([id, score]) => ({ id, score: Number(Number(score).toFixed(4)) }));
  }
  function topLayerNodes(nodes: { id: string; score: number }[], limit = 3) {
    return [...nodes]
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((n) => ({ id: n.id, score: Number(n.score.toFixed(4)) }));
  }
  function forwardTopK(): number {
    // 2026-09-14: monitor 可配置激活数(_network_config.json topK)优先于环境变量。
    const cfgTopK = readNetConfig().topK;
    const raw = Number(cfgTopK != null ? cfgTopK : (process.env.TEXTRON_FORWARD_TOP_K || "3"));
    return Number.isFinite(raw) ? Math.max(1, Math.min(8, Math.floor(raw))) : 3;
  }

  // ── 网络运行配置(monitor 可改, 持久化于 ~/.textron/_network_config.json) ──
  // pinnedTaskFamily: 手动锁定路由网络(旧网络全保留, null=回到自动路由);
  // topK: 全局每层激活数; topKByLayer: {"0":3,...} 按层覆盖(如 L0 3个/L1 2个)。
  const NET_CONFIG_PATH = path.join(TEXTRON_HOME, "_network_config.json");
  interface NetConfig { pinnedTaskFamily: string | null; topK: number | null; topKByLayer: Record<string, number> | null; }
  function readNetConfig(): NetConfig {
    const c = readJson<Partial<NetConfig> | null>(NET_CONFIG_PATH, null);
    if (!c || typeof c !== "object") return { pinnedTaskFamily: null, topK: null, topKByLayer: null };
    return {
      pinnedTaskFamily: typeof c.pinnedTaskFamily === "string" && c.pinnedTaskFamily ? c.pinnedTaskFamily : null,
      topK: typeof c.topK === "number" && c.topK > 0 ? c.topK : null,
      topKByLayer: c.topKByLayer && typeof c.topKByLayer === "object" ? c.topKByLayer : null,
    };
  }
  function writeNetConfig(patch: Partial<NetConfig>): NetConfig {
    const next = { ...readNetConfig(), ...patch };
    writeJson(NET_CONFIG_PATH, next);
    recordMonitorEvent({ type: "trace", action: "net_config_updated", ...next });
    broadcast({ type: "update", action: "net_config_updated", ...next });
    return next;
  }
  function topKForLayer(layer: number, cfg: NetConfig): number {
    const per = cfg.topKByLayer ? Number(cfg.topKByLayer[String(layer)]) : NaN;
    const base = Number.isFinite(per) && per > 0 ? per : (cfg.topK ?? 3);
    return Math.max(1, Math.min(8, Math.floor(base)));
  }
  function routeAbstainScore(): number {
    const raw = Number(process.env.TEXTRON_ROUTE_ABSTAIN_SCORE || "0.08");
    return Number.isFinite(raw) ? Math.max(0, Math.min(1, raw)) : 0.08;
  }
  function moeExpertCount(): number | undefined {
    const raw = Number(process.env.TEXTRON_MOE_EXPERTS || "0");
    return Number.isFinite(raw) && raw > 0 ? Math.max(1, Math.min(16, Math.floor(raw))) : undefined;
  }
  function moeTopK(): number {
    const raw = Number(process.env.TEXTRON_MOE_TOP_K || "2");
    return Number.isFinite(raw) ? Math.max(1, Math.min(8, Math.floor(raw))) : 2;
  }
  function downstreamRelevanceFloor(): number {
    const raw = Number(process.env.TEXTRON_DOWNSTREAM_RELEVANCE_FLOOR || "0.015");
    return Number.isFinite(raw) ? Math.max(0, Math.min(0.2, raw)) : 0.015;
  }
  function tokenSet(text: string): Set<string> {
    return new Set(String(text || "").toLowerCase().split(/[\s,，。！？、:：;；()\[\]{}<>"'`/\\|+=_-]+/).filter((w) => w.length > 2));
  }
  function overlapScore(a: string, b: string): number {
    const aa = tokenSet(a);
    const bb = tokenSet(b);
    if (!aa.size || !bb.size) return 0;
    let hit = 0;
    for (const w of aa) if (bb.has(w)) hit++;
    return Number((hit / Math.min(aa.size, bb.size)).toFixed(4));
  }
  function readMonitorEvents(limit = 60): Record<string, unknown>[] {
    try {
      if (!fs.existsSync(EVENTS_PATH)) return [];
      const lines = fs.readFileSync(EVENTS_PATH, "utf-8").trim().split("\n").filter(Boolean).slice(-limit);
      return lines.map((line) => JSON.parse(line)).filter((e) => e && typeof e === "object");
    } catch { return []; }
  }

  // 从 _events.jsonl 尾部读最后 n 行（分页需要，避免 42MB 全量读）
  function readTailLines(filePath: string, n: number): string[] {
    try {
      const fd = fs.openSync(filePath, "r");
      const size = fs.fstatSync(fd).size;
      if (size <= 0) { fs.closeSync(fd); return []; }
      const CHUNK = 128 * 1024;
      const collected: string[] = [];
      let pos = size;
      let carry = "";
      while (pos > 0 && collected.length < n) {
        const readLen = Math.min(CHUNK, pos);
        pos -= readLen;
        const buf = Buffer.alloc(readLen);
        fs.readSync(fd, buf, 0, readLen, pos);
        const text = buf.toString("utf-8") + carry;
        const lines = text.split("\n");
        carry = lines[0];
        for (let i = lines.length - 1; i >= 1 && collected.length < n; i--) {
          const l = lines[i].trim();
          if (l) collected.push(l);
        }
      }
      if (carry.trim() && collected.length < n) collected.push(carry.trim());
      fs.closeSync(fd);
      return collected.reverse(); // 旧→新
    } catch { return []; }
  }

  // ── 轨迹真·永久: 主文件超限时最旧段转存归档分卷(按月 archive_YYYY-MM.jsonl), 不删除 ──
  function trajectoryArchiveDir(): string { return path.join(TEXTRON_HOME, "_trajectories_archive"); }
  function trajectoryArchiveMonths(): string[] {
    try {
      const ad = trajectoryArchiveDir();
      if (!fs.existsSync(ad)) return [];
      return fs.readdirSync(ad)
        .filter(f => /^archive_\d{4}-\d{2}\.jsonl$/.test(f))
        .map(f => f.replace(/^archive_/, "").replace(/\.jsonl$/, ""))
        .sort().reverse();
    } catch { return []; }
  }
  function archiveTrajectoryOverflow(trajPath: string, maxLines: number): void {
    try {
      if (!fs.existsSync(trajPath)) return;
      const lines = fs.readFileSync(trajPath, "utf-8").split("\n").filter(Boolean);
      if (lines.length <= maxLines) return;
      const overflow = lines.slice(0, lines.length - maxLines); // 最旧段
      const keep = lines.slice(lines.length - maxLines);        // 保留最新
      fs.writeFileSync(trajPath, keep.join("\n") + "\n", "utf-8");
      ensureDir(trajectoryArchiveDir());
      // 按每条记录的 ts 月份落卷(避免跨月边界记录错卷)
      for (const ln of overflow) {
        let month = "";
        try { month = String(JSON.parse(ln).ts || "").slice(0, 7); } catch { /* */ }
        if (!/^\d{4}-\d{2}$/.test(month)) month = new Date().toISOString().slice(0, 7);
        fs.appendFileSync(path.join(trajectoryArchiveDir(), `archive_${month}.jsonl`), ln + "\n", "utf-8");
      }
    } catch (e) { console.error("[textron] trajectory archive overflow failed:", (e as Error).message); }
  }
  // backward 输入输出日志按体积分卷: >maxMB 改名(时间戳)保留, 新建空卷 —— 真·永久且单文件有界
  function rolloverLogBySize(logPath: string, maxMB = 4): void {
    try {
      if (!fs.existsSync(logPath)) return;
      if (fs.statSync(logPath).size <= maxMB * 1024 * 1024) return;
      const ts = new Date().toISOString().replace(/[:T]/g, "").slice(0, 14);
      fs.renameSync(logPath, logPath.replace(/\.jsonl$/, `.${ts}.jsonl`));
    } catch { /* 忽略 */ }
  }

  // 事件总数（流式数换行，带 size+mtime 缓存，42MB 全读仅当文件变化时发生一次）
  let _eventsCountCache = { size: 0, mtimeMs: 0, count: 0 };
  function countEventsLines(): number {
    try {
      const stat = fs.statSync(EVENTS_PATH);
      if (_eventsCountCache.size === stat.size && _eventsCountCache.mtimeMs === stat.mtimeMs) return _eventsCountCache.count;
      const content = fs.readFileSync(EVENTS_PATH, "utf-8");
      let count = 0;
      for (let i = 0; i < content.length; i++) if (content.charCodeAt(i) === 10) count++;
      _eventsCountCache = { size: stat.size, mtimeMs: stat.mtimeMs, count };
      return count;
    } catch { return 0; }
  }

  // 通用 jsonl 行数统计（带 size+mtime 缓存）——trajectories/backward-logs 分页 total
  let _jsonlCountCache: Record<string, { size: number; mtimeMs: number; count: number }> = {};
  function countJsonlLines(filePath: string): number {
    try {
      const stat = fs.statSync(filePath);
      const c = _jsonlCountCache[filePath];
      if (c && c.size === stat.size && c.mtimeMs === stat.mtimeMs) return c.count;
      const content = fs.readFileSync(filePath, "utf-8");
      let count = 0;
      for (let i = 0; i < content.length; i++) if (content.charCodeAt(i) === 10) count++;
      _jsonlCountCache[filePath] = { size: stat.size, mtimeMs: stat.mtimeMs, count };
      return count;
    } catch { return 0; }
  }

  function monitorEventTime(e: Record<string, unknown> | null | undefined): number {
    if (!e) return 0;
    const raw = e.ts || e.at || e.startedAt;
    const ms = typeof raw === "string" ? Date.parse(raw) : 0;
    return Number.isFinite(ms) ? ms : 0;
  }
  function isBackwardStateEvent(e: Record<string, unknown> | null | undefined): boolean {
    if (!e) return false;
    const action = String(e.action || "");
    return action === "semantic_backward" || action === "semantic_backward_start" || action === "semantic_backward_done" || action === "semantic_backward_failed";
  }

  const server = http.createServer((req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    const urlPath = (req.url || "/").split("?")[0];

    if (urlPath === "/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      });
      res.write("data: {\"type\":\"connected\"}\n\n");
      SSE_CLIENTS.add(res);
      req.on("close", () => SSE_CLIENTS.delete(res));
      return;
    }

    if (urlPath === "/api/state") {
      const state = buildStateJSON();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(state));
      return;
    }

    // 轨迹事件分页: ?page=1&pageSize=50&filter=xxx (倒序, 最新在前)
    if (urlPath === "/api/events") {
      try {
        const u = new URL(req.url || "/", "http://localhost");
        const page = Math.max(1, parseInt(u.searchParams.get("page") || "1", 10) || 1);
        const pageSize = Math.min(200, Math.max(10, parseInt(u.searchParams.get("pageSize") || "50", 10) || 50));
        const filter = String(u.searchParams.get("filter") || "").toLowerCase().trim();
        const total = countEventsLines();
        const tailLines = readTailLines(EVENTS_PATH, page * pageSize);
        // tailLines = 最后 page*pageSize 行(旧→新)。本页取其中更旧的 pageSize 条：
        // page=1 取最后 pageSize 条；page=k 取倒数第 ((k-1)*pageSize+1)..(k*pageSize) 条
        const endIdx = tailLines.length - (page - 1) * pageSize;
        const startIdx = Math.max(0, endIdx - pageSize);
        const pageLines = tailLines.slice(startIdx, endIdx);
        const events: Record<string, unknown>[] = [];
        for (const line of pageLines) {
          try {
            const e = JSON.parse(line);
            if (!e || typeof e !== "object") continue;
            if (filter && !JSON.stringify(e).toLowerCase().includes(filter)) continue;
            events.push(e);
          } catch { /* 坏行跳过 */ }
        }
        events.reverse(); // 最新在前
        res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        res.end(JSON.stringify({ total, page, pageSize, events }));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: (e as Error).message || String(e) }));
      }
      return;
    }

    // 完整对话轨迹分页: ?page=1&pageSize=50 (倒序, 最新在前) — user原文+AI回复原文
    if (urlPath === "/api/trajectories") {
      try {
        const u = new URL(req.url || "/", "http://localhost");
        const page = Math.max(1, parseInt(u.searchParams.get("page") || "1", 10) || 1);
        const pageSize = Math.min(100, Math.max(5, parseInt(u.searchParams.get("pageSize") || "20", 10) || 20));
        const filter = String(u.searchParams.get("filter") || "").toLowerCase().trim();
        const months = trajectoryArchiveMonths();
        // 仅列归档月份
        if (u.searchParams.get("months")) {
          res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
          res.end(JSON.stringify({ ok: true, months }));
          return;
        }
        // archive=YYYY-MM(或 1/auto=最新一卷) → 读归档; 缺省读主文件
        const archParam = String(u.searchParams.get("archive") || "").trim();
        let trajPath = path.join(TEXTRON_HOME, "_trajectories.jsonl");
        let archiveMonth = "";
        if (archParam) {
          archiveMonth = /^\d{4}-\d{2}$/.test(archParam) ? archParam : (months[0] || "");
          if (!archiveMonth) {
            res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
            res.end(JSON.stringify({ ok: true, total: 0, page, pageSize, items: [], archive: "", months }));
            return;
          }
          trajPath = path.join(trajectoryArchiveDir(), `archive_${archiveMonth}.jsonl`);
          if (!fs.existsSync(trajPath)) {
            res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
            res.end(JSON.stringify({ ok: true, total: 0, page, pageSize, items: [], archive: archiveMonth, months }));
            return;
          }
        }
        const tail = readTailLines(trajPath, page * pageSize);
        const end = tail.length - (page - 1) * pageSize;
        const start = Math.max(0, end - pageSize);
        const items: Record<string, unknown>[] = [];
        for (const line of tail.slice(start, end)) {
          try {
            const e = JSON.parse(line);
            if (!e || typeof e !== "object") continue;
            if (filter && !JSON.stringify(e).toLowerCase().includes(filter)) continue;
            items.push(e);
          } catch { /* 坏行跳过 */ }
        }
        items.reverse();
        res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        res.end(JSON.stringify({ total: countJsonlLines(trajPath), page, pageSize, items, archive: archiveMonth, months }));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: (e as Error).message || String(e) }));
      }
      return;
    }

    // Backward 输入输出分页: ?page=1&pageSize=20&net=astro_stock_prediction (读 _sb_logs/semantic_backward.jsonl)
    if (urlPath === "/api/backward-logs") {
      try {
        const u = new URL(req.url || "/", "http://localhost");
        const page = Math.max(1, parseInt(u.searchParams.get("page") || "1", 10) || 1);
        const pageSize = Math.min(50, Math.max(5, parseInt(u.searchParams.get("pageSize") || "10", 10) || 10));
        const filter = String(u.searchParams.get("filter") || "").toLowerCase().trim();
        const allNets = listNetworks();
        const net = String(u.searchParams.get("net") || "").trim() || allNets[0] || "";
        const logPath = net ? path.join(TEXTRON_HOME, net, "_sb_logs", "semantic_backward.jsonl") : "";
        const tail = logPath ? readTailLines(logPath, page * pageSize) : [];
        const end = tail.length - (page - 1) * pageSize;
        const start = Math.max(0, end - pageSize);
        const items: Record<string, unknown>[] = [];
        for (const line of tail.slice(start, end)) {
          try {
            const e = JSON.parse(line);
            if (!e || typeof e !== "object") continue;
            if (filter && !JSON.stringify(e).toLowerCase().includes(filter)) continue;
            // 2026-08-20: 返回完整入参原文(不截断)，供手动触发/审查 backward 输入输出
            items.push({ ts: e.ts, taskFamily: e.taskFamily, mode: e.mode, model: e.model, systemPrompt: e.systemPrompt, userPrompt: e.userPrompt, nodeInput: e.nodeInput, parsed: e.parsed });
          } catch { /* 坏行跳过 */ }
        }
        items.reverse();
        res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        res.end(JSON.stringify({ total: logPath ? countJsonlLines(logPath) : 0, page, pageSize, net, nets: allNets, items }));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: (e as Error).message || String(e) }));
      }
      return;
    }

    // ── 网络管理 API(monitor 网络管理面板) ──
    // GET /api/networks: 列出全部网络(旧网络全保留)+当前配置
    if (urlPath === "/api/networks" && req.method === "GET") {
      try {
        const cfg = readNetConfig();
        const networks = listNetworks().map((name) => {
          const net = loadNetwork(name);
          const nodeCounts = (net?.hyperparams.layers || []).map((cap: number, l: number) => {
            let used = 0;
            for (let n = 0; n < cap; n++) {
              if (readNodeContent(path.join(net!.path, `layer_${l}`, `node_${n}.html`)).trim()) used++;
            }
            return { layer: l, slots: cap, cap: layerCapFor(net!.hyperparams, l), used };
          });
          return { name, layers: net?.hyperparams.layers || [], layerCaps: net?.hyperparams.layerCaps || null, threshold: net?.hyperparams.threshold, learningRate: net?.hyperparams.learningRate, goal: String(net?.hyperparams.goal || ""), nodeCounts, pinned: cfg.pinnedTaskFamily === name };
        });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, networks, config: { pinnedTaskFamily: cfg.pinnedTaskFamily, pinnedGoal: cfg.pinnedTaskFamily ? readNetworkGoal(cfg.pinnedTaskFamily) : "", topK: cfg.topK, topKByLayer: cfg.topKByLayer, topKEffective: forwardTopK() } }));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: (e as Error).message || String(e) }));
      }
      return;
    }

    // POST /api/networks/init: 强制新建空白网络(与工具 init 的扩容策略不同 — 用户显式要求新网时保留旧网)
    // body {taskFamily, layers: "4,6,8"|[4,6,8], threshold?, learningRate?}
    if (urlPath === "/api/networks/init" && req.method === "POST") {
      let body = "";
      req.on("data", (c: Buffer) => { body += c.toString("utf-8"); if (body.length > 100000) req.destroy(); });
      req.on("end", () => {
        try {
          const p = JSON.parse(body || "{}");
          const tfName = String(p.taskFamily || "").trim().replace(/[^a-zA-Z0-9\u4e00-\u9fff_-]/g, "_").slice(0, 64);
          if (!tfName) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: false, error: "taskFamily required" })); return; }
          if (networkExists(tfName)) { res.writeHead(409, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: false, error: `network "${tfName}" already exists` })); return; }
          const layers = (Array.isArray(p.layers) ? p.layers : String(p.layers || "4,6,8").split(","))
            .map((s: any) => parseInt(String(s).trim(), 10)).filter((n: number) => Number.isFinite(n) && n > 0 && n <= 64);
          if (layers.length < 2 || layers.length > 8) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: false, error: "need 2-8 layers, each 1-64 nodes" })); return; }
          const threshold = Number.isFinite(Number(p.threshold)) && Number(p.threshold) > 0 && Number(p.threshold) < 1 ? Number(p.threshold) : DEFAULT_HYPERPARAMS.threshold;
          const learningRate = Number.isFinite(Number(p.learningRate)) && Number(p.learningRate) > 0 && Number(p.learningRate) < 1 ? Number(p.learningRate) : DEFAULT_HYPERPARAMS.learningRate;
          const hp = initNetwork(tfName, layers, threshold, learningRate, log);
          // 可选：新建时直接宣目标（UI ④ 网络目标）；空则不写字段
          const initGoal = writeNetworkGoal(tfName, p.goal == null ? "" : String(p.goal));
          log(`Textron monitor: created network "${tfName}" layers=[${layers.join(",")}] threshold=${hp.threshold}${initGoal ? ` goal="${preview(initGoal, 80)}"` : ""}`);
          broadcast({ type: "update", taskFamily: tfName, action: "init" });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, taskFamily: tfName, layers, threshold: hp.threshold, learningRate: hp.learningRate, goal: initGoal }));
        } catch (e) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: (e as Error).message || String(e) }));
        }
      });
      return;
    }

    // POST /api/networks/caps: 设置每层容量上限 — body {taskFamily, layerCaps:[2,2,2]}; layerCaps:null 回落默认(40/层)
    if (urlPath === "/api/networks/caps" && req.method === "POST") {
      let body = "";
      req.on("data", (c: Buffer) => { body += c.toString("utf-8"); if (body.length > 100000) req.destroy(); });
      req.on("end", () => {
        try {
          const p = JSON.parse(body || "{}");
          const tfName = String(p.taskFamily || "").trim();
          if (!networkExists(tfName)) { res.writeHead(404, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: false, error: `network "${tfName}" not found` })); return; }
          const net = loadNetwork(tfName);
          if (!net) { res.writeHead(404, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: false, error: "load failed" })); return; }
          let layerCaps: number[] | null = null;
          if (p.layerCaps !== null && p.layerCaps !== undefined) {
            layerCaps = (Array.isArray(p.layerCaps) ? p.layerCaps : String(p.layerCaps).split(","))
              .map((s: any) => parseInt(String(s).trim(), 10)).filter((n: number) => Number.isFinite(n) && n >= 1 && n <= 64);
            if (layerCaps.length !== net.hyperparams.layers.length) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: false, error: `layerCaps length (${layerCaps.length}) must equal layer count (${net.hyperparams.layers.length})` })); return; }
          }
          if (layerCaps) { net.hyperparams.layerCaps = layerCaps; } else { delete net.hyperparams.layerCaps; }
          net.hyperparams.updatedAt = new Date().toISOString();
          writeJson(path.join(net.path, "hyperparams.json"), net.hyperparams);
          log(`Textron monitor: layerCaps of "${tfName}" set to ${layerCaps ? JSON.stringify(layerCaps) : "default(40/层)"}`);
          broadcast({ type: "update", taskFamily: tfName, action: "caps" });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, taskFamily: tfName, layerCaps: layerCaps || null, effective: net.hyperparams.layers.map((_: number, l: number) => layerCapFor(net.hyperparams, l)) }));
        } catch (e) {
          res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: false, error: (e as Error).message || String(e) }));
        }
      });
      return;
    }

    // POST /api/networks/goal: 网络目标 — body {taskFamily, goal}
    // 目标在反向传播时被读取，作为「是否属于本网络领域」的裁判：离域节点会被 node_updates 覆盖重写。
    // 空字符串/null = 清除目标约束（回到旧行为）。
    if (urlPath === "/api/networks/goal" && req.method === "POST") {
      let body = "";
      req.on("data", (c: Buffer) => { body += c.toString("utf-8"); if (body.length > 100000) req.destroy(); });
      req.on("end", () => {
        try {
          const p = JSON.parse(body || "{}");
          const tfName = String(p.taskFamily || "").trim();
          if (!networkExists(tfName)) { res.writeHead(404, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: false, error: `network "${tfName}" not found` })); return; }
          const goal = writeNetworkGoal(tfName, p.goal == null ? "" : String(p.goal));
          log(`Textron monitor: goal of "${tfName}" ${goal ? `set to "${preview(goal, 80)}"` : "cleared"} (max ${NETWORK_GOAL_MAX_CHARS}c)`);
          broadcast({ type: "update", taskFamily: tfName, action: "goal", goal });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, taskFamily: tfName, goal, maxChars: NETWORK_GOAL_MAX_CHARS }));
        } catch (e) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: (e as Error).message || String(e) }));
        }
      });
      return;
    }

    // POST /api/networks/pin: 切换路由网络 — body {taskFamily} 锁定; {taskFamily:null} 回自动路由
    if (urlPath === "/api/networks/pin" && req.method === "POST") {
      let body = "";
      req.on("data", (c: Buffer) => { body += c.toString("utf-8"); if (body.length > 100000) req.destroy(); });
      req.on("end", () => {
        try {
          const p = JSON.parse(body || "{}");
          const tfName = p.taskFamily ? String(p.taskFamily).trim() : null;
          if (tfName && !networkExists(tfName)) { res.writeHead(404, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: false, error: `network "${tfName}" not found` })); return; }
          const cfg = writeNetConfig({ pinnedTaskFamily: tfName });
          log(`Textron monitor: route ${tfName ? `pinned to "${tfName}"` : "reset to auto"}`);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, config: cfg }));
        } catch (e) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: (e as Error).message || String(e) }));
        }
      });
      return;
    }

    // POST /api/networks/topk: 每层激活数 — body {topK?: 1-8 全局, topKByLayer?: {"0":3,"1":2}|null}
    if (urlPath === "/api/networks/topk" && req.method === "POST") {
      let body = "";
      req.on("data", (c: Buffer) => { body += c.toString("utf-8"); if (body.length > 100000) req.destroy(); });
      req.on("end", () => {
        try {
          const p = JSON.parse(body || "{}");
          const patch: Record<string, unknown> = {};
          if (p.topK !== undefined) {
            const k = Number(p.topK);
            if (!Number.isFinite(k) || k < 1 || k > 8) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: false, error: "topK must be 1-8" })); return; }
            patch.topK = Math.floor(k);
          }
          if (p.topKByLayer !== undefined) {
            if (p.topKByLayer === null) { patch.topKByLayer = null; }
            else if (typeof p.topKByLayer === "object") {
              const m: Record<string, number> = {};
              for (const [k, v] of Object.entries(p.topKByLayer)) {
                const n = Number(v);
                if (/^\d+$/.test(k) && Number.isFinite(n) && n >= 1 && n <= 8) m[k] = Math.floor(n);
              }
              patch.topKByLayer = Object.keys(m).length ? m : null;
            }
          }
          if (!Object.keys(patch).length) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: false, error: "nothing to update (topK / topKByLayer)" })); return; }
          const cfg = writeNetConfig(patch as any);
          log(`Textron monitor: topK updated topK=${cfg.topK} byLayer=${JSON.stringify(cfg.topKByLayer)}`);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, config: cfg, topKEffective: forwardTopK() }));
        } catch (e) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: (e as Error).message || String(e) }));
        }
      });
      return;
    }

    // 手动触发 backward: POST body {taskFamily, previousTask, previousAssistantHighEntropy|answer, currentUserMessage, activatedIds, selectedEdgeIds}
    // 用途: 某条轨迹未自动触发反向传播时，手动补学。经串行队列执行防并发写网络文件。
    if (urlPath === "/api/manual-backward" && req.method === "POST") {
      let body = "";
      req.on("data", (c: Buffer) => { body += c.toString("utf-8"); if (body.length > 300000) req.destroy(); });
      req.on("end", () => {
        try {
          const p = JSON.parse(body || "{}");
          const tf = String(p.taskFamily || "");
          const prevTask = String(p.previousTask || "").slice(0, 3000);
          const he = String(p.previousAssistantHighEntropy || extractHighEntropy(String(p.answer || "")) || "");
          const feedback = String(p.currentUserMessage || "手动触发 backward（无显式反馈）").slice(0, 3000);
          const ids = Array.isArray(p.activatedIds) ? p.activatedIds.map(String).slice(0, 40) : [];
          const edges = Array.isArray(p.selectedEdgeIds) ? p.selectedEdgeIds.map(String).slice(0, 40) : [];
          if (!tf) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: false, error: "taskFamily required" })); return; }
          log(`Textron manual backward queued: ${tf} he=${he.length}c feedback=${feedback.length}c`);
          enqueueBackwardWithResult(async () => {
            const r = await forcedSemanticBackward(tf, prevTask, he, feedback, ids, edges, {}, {});
            log(`Textron manual backward done: ${tf} reward=${r?.reward} updated=${r?.nodesUpdated} added=${r?.nodesAdded} merged=${r?.nodesMerged}`);
            return r;
          }).then((result: any) => {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true, result: { reward: result?.reward, nodesUpdated: result?.nodesUpdated, nodesAdded: result?.nodesAdded, nodesMerged: result?.nodesMerged, nodesSkipped: result?.nodesSkipped, changedNodes: (result?.changedNodes || []).length } }));
          }).catch((e: any) => {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }));
          });
        } catch (e) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: (e as Error).message || String(e) }));
        }
      });
      return;
    }

    // Shared transparent brand asset for the monitor pages.
    if (urlPath === "/textron-logo.png") {
      try {
        const realDir = fs.realpathSync(__dirname);
        const logoPath = path.join(realDir, "textron-logo.png");
        const logo = fs.readFileSync(logoPath);
        res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "no-store" });
        res.end(logo);
      } catch {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Textron logo not found");
      }
      return;
    }

    // 独立轨迹页
    if (urlPath === "/trajectory") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(getTrajectoryHTML());
      return;
    }

    // 轨迹原文全量页 — 原封不动显示所有对话内容(不截断/不加工), 供事后人工筛选轨迹块
    if (urlPath === "/raw") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(getRawHTML());
      return;
    }

    // Serve live monitor HTML
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(getMonitorHTML());
  });

  // Auto-find available port: try PORT, then PORT+1..PORT+99
  const MAX_PORT_ATTEMPTS = 100;
  let actualPort = PORT;

  function tryListen(port: number, attempt: number) {
    function onError(err: NodeJS.ErrnoException) {
      if (err.code === "EADDRINUSE" && attempt < MAX_PORT_ATTEMPTS) {
        server.removeListener("error", onError);
        tryListen(port + 1, attempt + 1);
      } else {
        log(`Textron monitor failed: ${err.message}`);
        server.removeListener("error", onError);
      }
    }
    server.on("error", onError);
    server.listen(port, () => {
      server.removeListener("error", onError);
      actualPort = port;
      log(`Textron monitor: http://localhost:${port}`);
    });
  }
  tryListen(PORT, 0);

  dlog("INIT", "Textron extension loaded", { monitorPort: PORT });

  pi.on("session_shutdown", () => {
    server.close();
    // Clean up all SSE clients
    for (const res of SSE_CLIENTS) {
      try { res.end(); } catch {}
    }
    SSE_CLIENTS.clear();
  });

  function buildStateJSON() {
    const networks: Record<string, unknown> = {};
    for (const name of listNetworks()) {
      const net = loadNetwork(name);
      if (!net) continue;
      const nodes: { id: string; layer: number; name: string; content: string; context: string; outEdges: { toId: string; weight: number }[] }[] = [];
      for (let l = 0; l < net.hyperparams.layers.length; l++) {
        for (let n = 0; n < net.hyperparams.layers[l]; n++) {
          const nodePath = path.join(net.path, `layer_${l}`, `node_${n}.html`);
          const content = readNodeContent(nodePath);
          const outEdges = (net.weights.layer_connections[`${l}_to_${l + 1}`] || [])
            .filter((e) => e.from === `node_${n}`)
            .map((e) => ({ toId: e.to, weight: e.weight }));
          nodes.push({
            id: `node_${n}`,
            layer: l,
            name: readNodeName(nodePath),
            content,
            context: content,
            outEdges,
          });
        }
      }
      networks[name] = {
        layers: net.hyperparams.layers,
        threshold: net.hyperparams.threshold,
        learningRate: net.hyperparams.learningRate,
        updatedAt: net.hyperparams.updatedAt,
        weights: net.weights.layer_connections,
        nodes,
      };
    }
    const monitorEvents = readMonitorEvents(160);
    const latestBackwardFromLog = [...monitorEvents].reverse().find((e) => isBackwardStateEvent(e)) || null;
    const latestBackward = monitorEventTime(lastBackwardState) >= monitorEventTime(latestBackwardFromLog)
      ? lastBackwardState
      : latestBackwardFromLog;
    const backwardByTaskFamily: Record<string, unknown> = {};
    for (const e of monitorEvents) {
      if (!isBackwardStateEvent(e) || !e.taskFamily) continue;
      const key = String(e.taskFamily);
      const prev = backwardByTaskFamily[key] as Record<string, unknown> | undefined;
      if (!prev || monitorEventTime(e) >= monitorEventTime(prev)) backwardByTaskFamily[key] = e;
    }
    if (lastBackwardState?.taskFamily) {
      const key = String(lastBackwardState.taskFamily);
      const prev = backwardByTaskFamily[key] as Record<string, unknown> | undefined;
      if (!prev || monitorEventTime(lastBackwardState) >= monitorEventTime(prev)) backwardByTaskFamily[key] = lastBackwardState;
    }
    // Child Pi processes (for example nbeat UI jobs) run their own Textron extension instance.
    // Their SSE broadcast goes to their own monitor port, but they all append to _events.jsonl.
    // Reconstruct the latest forward path from the shared event log so the main monitor reacts
    // to spawned-agent work instead of only this process' in-memory state.
    const latestForward = [...monitorEvents].reverse().find((e) =>
      e.action === "propagate_done" || (e.hook === "agent_end" && Array.isArray((e as any).activatedIds))
    ) as Record<string, any> | undefined;
    let effectiveTaskFamily = currentTaskFamily;
    let effectiveActivatedIds = currentActivatedIds;
    let effectiveSelectedEdgeIds = currentSelectedEdgeIds;
    let effectiveScores = currentActivationScores;
    if (latestForward) {
      effectiveTaskFamily = latestForward.taskFamily || effectiveTaskFamily;
      effectiveActivatedIds = (latestForward.selectedIds || latestForward.activatedIds || effectiveActivatedIds) as string[];
      effectiveSelectedEdgeIds = (latestForward.selectedEdgeIds || effectiveSelectedEdgeIds) as string[];
      const scoreMap: Record<string, number> = {};
      for (const layerInfo of latestForward.topByLayer || []) {
        const layer = Number(layerInfo.layer);
        for (const n of layerInfo.top || []) scoreMap[`L${layer}::${n.id}`] = Number(n.score || 0);
      }
      if (Object.keys(scoreMap).length > 0) effectiveScores = { ...effectiveScores, ...scoreMap };
    }
    const effectiveNodeMutations = effectiveTaskFamily && latestBackward?.taskFamily === effectiveTaskFamily
      ? (latestBackward.nodeMutations || [])
      : [];
    return { currentTaskFamily: effectiveTaskFamily, currentActivatedIds: effectiveActivatedIds, currentActivationScores: effectiveScores, currentSelectedEdgeIds: effectiveSelectedEdgeIds, currentNodeMutations: effectiveNodeMutations, lastBackwardState: latestBackward, backwardByTaskFamily, backwardEvents: monitorEvents, networks };
  }

  function getMonitorHTML(): string {
    try {
      // Resolve real path (follows symlinks from ~/.pi/agent/extensions/)
      const realDir = fs.realpathSync(__dirname);
      const monitorPath = path.join(realDir, "monitor.html");
      return fs.readFileSync(monitorPath, "utf-8");
    } catch {
      return "<h1>Textron Monitor</h1><p>monitor.html not found</p>";
    }
  }

  function getTrajectoryHTML(): string {
    try {
      const realDir = fs.realpathSync(__dirname);
      const trajPath = path.join(realDir, "trajectory.html");
      return fs.readFileSync(trajPath, "utf-8");
    } catch {
      return "<h1>Textron Trajectory</h1><p>trajectory.html not found</p>";
    }
  }

  // 轨迹原文全量页(/raw): 复用 /api/trajectories 分页, 前端 textContent 原封不动渲染全部字段
  function getRawHTML(): string {
    try {
      const realDir = fs.realpathSync(__dirname);
      const rawPath = path.join(realDir, "raw.html");
      return fs.readFileSync(rawPath, "utf-8");
    } catch {
      return "<h1>Textron Raw</h1><p>raw.html not found</p>";
    }
  }

  // ══════════════════════════════════════════════════════════════════
  // Auto-routing: keyword overlap between prompt and node contents
  // ══════════════════════════════════════════════════════════════════

  function autoRouteNetworkDecision(prompt: string, networks: string[], explicitTaskFamily?: string) {
    // 2026-09-14: monitor 手动 pin 网络 — pinned 优先于内容路由(显式 explicitTaskFamily 仍最高)。
    // pinned 网络已被删除则落回自动路由，旧网络从不删除、随时可切回。
    const _cfg = readNetConfig();
    if (!explicitTaskFamily && _cfg.pinnedTaskFamily && networks.includes(_cfg.pinnedTaskFamily)) {
      recordMonitorEvent({ type: "trace", action: "route_policy_decision", promptPreview: preview(prompt, 180), explicitTaskFamily: "", taskFamily: _cfg.pinnedTaskFamily, reason: "pinned_manual", score: 1 });
      return { taskFamily: _cfg.pinnedTaskFamily, reason: "pinned_manual", score: 1 };
    }
    const candidates = networks.map((name) => {
      const net = loadNetwork(name);
      let content = "";
      if (net) {
        for (let l = 0; l < net.hyperparams.layers.length; l++) {
          for (let n = 0; n < net.hyperparams.layers[l]; n++) {
            const nodePath = path.join(net.path, `layer_${l}`, `node_${n}.html`);
            content += ` ${readNodeName(nodePath)} ${readNodeContent(nodePath)}`;
          }
        }
      }
      return { name, content };
    });
    const route = chooseTaskFamilyRoute({ prompt, candidates, explicitTaskFamily, allowBestEffort: true });
    recordMonitorEvent({ type: "trace", action: "route_policy_decision", promptPreview: preview(prompt, 180), explicitTaskFamily: explicitTaskFamily || "", taskFamily: route.taskFamily || "", reason: route.reason, score: Number(route.score.toFixed(4)) });
    return route;
  }

  function autoRouteNetwork(prompt: string, networks: string[], explicitTaskFamily?: string): string | null {
    return autoRouteNetworkDecision(prompt, networks, explicitTaskFamily).taskFamily;
  }

  function resolveConfigValue(raw: unknown): string {
    const value = String(raw || "");
    if (!value) return "";
    if (value.startsWith("$$")) return value.slice(1);
    if (value.startsWith("$!")) return value.slice(1);
    const exactEnv = value.match(/^\$\{?([A-Z0-9_]+)\}?$/i);
    if (exactEnv) return process.env[exactEnv[1]] || "";
    return value.replace(/\$\{([A-Z0-9_]+)\}|\$([A-Z0-9_]+)/gi, (_m, a, b) => process.env[a || b] || "");
  }

  async function resolveModelApiKey(ctx: any, model: any): Promise<{ apiKey: string; source: string }> {
    let apiKey = "";
    let source = "none";
    const provider = String(model?.provider || "");
    try {
      const reg = ctx?.modelRegistry;
      if (reg?.authStorage?.getApiKey && provider) {
        apiKey = (await reg.authStorage.getApiKey(provider)) || "";
        if (apiKey) return { apiKey, source: "authStorage" };
      }
    } catch {}

    apiKey = resolveConfigValue((model as any)?.apiKey || (model as any)?.provider?.apiKey);
    if (apiKey) return { apiKey, source: "model.apiKey" };

    // 2026-08-19: authStorage 在子进程(local-coms sender/worker)不可用时, 直接读 auth.json
    // (pi 主进程同款来源: ~/.pi/agent/auth.json = {provider: {type:'api_key', key}})
    // 否则 backward/pairing LLM 调用 401 (apiKey=none)。
    try {
      const authPath = path.join(process.env.HOME || process.env.USERPROFILE || "~", ".pi", "agent", "auth.json");
      const auth = readJson<any>(authPath, {});
      const authEntry = provider ? auth?.[provider] : undefined;
      if (authEntry) {
        apiKey = resolveConfigValue(authEntry.key || (typeof authEntry === "string" ? authEntry : ""));
        if (apiKey) return { apiKey, source: "auth.json" };
      }
    } catch {}

    try {
      const configPath = path.join(process.env.HOME || process.env.USERPROFILE || "~", ".pi", "agent", "models.json");
      const config = readJson<any>(configPath, {});
      const providerConfig = provider ? config?.providers?.[provider] : undefined;
      apiKey = resolveConfigValue(providerConfig?.apiKey);
      if (apiKey) return { apiKey, source: "models.json" };
    } catch {}
    const envCandidates = [
      process.env[`PI_${provider.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`],
      process.env.DEEPSEEK_API_KEY,
      process.env.OPENAI_API_KEY,
      process.env.ANTHROPIC_API_KEY,
      process.env.API_KEY,
    ];
    for (const c of envCandidates) {
      if (c) return { apiKey: c, source: "env" };
    }
    return { apiKey: "", source };
  }

  // 2026-09-03: model compat 解析（max_tokens vs max_completion_tokens / supportsReasoningEffort）。
  // 实测依据: qwen3.8-flash 对 max_completion_tokens=4096 把 reasoning+content 合并计数 → finish=length
  // 且 content 恒空（86.6s / 13716c 思维链）；换 max_tokens=4096 同预算 → 42.4s 正常出 content。
  // models-store 里 deepseek-v4-flash 本身就声明 maxTokensField="max_tokens"，所以自定义 fetch
  // 必须按 pi 同一张 compat 表分流，不能写死参数名。
  // 三级来源: model.compat → models.json providers[p].compat → models-store.json providers[p].models[id].compat。
  // 三级来源: model.compat（pi 已解析携带则优先）→ lib/llm_budget.readCompatFromDisk
  //（同一张表只留一个磁盘读取实现，单测直接跑真实 ~/.pi/agent 配置）。
  function resolveModelCompat(m: any): any {
    return (m && (m as any).compat) || readCompatFromDisk({ id: m?.id, provider: m?.provider, baseUrl: m?.baseUrl });
  }


  // ══════════════════════════════════════════════════════════════════
  // Blocking L0 scoring via LLM API (runs in before_agent_start, can't skip)
  // ══════════════════════════════════════════════════════════════════

  // Store model info captured from session_start (ctx.model may be undefined in before_agent_start)
  let _textronModel: any = null;
  pi.on("session_start", (_event, ctx) => {
    _textronModel = (ctx as any).model || null;
    recordMonitorEvent({
      type: "hook",
      hook: "session_start",
      modelId: _textronModel?.id || "MISSING",
      provider: _textronModel?.provider || "MISSING",
      hasBaseUrl: !!_textronModel?.baseUrl,
    });
  });

  // baseUrl may already end with a version segment (/v1, /v3, /v1beta...).
  // Never blind-append /v1 — volcengine ark uses /api/plan/v3 → /v3/v1/... = HTTP 404 empty body.
  function joinApiEndpoint(baseUrl: string, apiPath: string): string {
    const b = String(baseUrl).replace(/\/+$/, "");
    return /\/v\d+[a-z]*$/i.test(b) ? `${b}${apiPath}` : `${b}/v1${apiPath}`;
  }

  // 本回合 L0 打分诊断(scoreL0WithLLM 失败时设值; agent_end 写 turn 行时并入 forward_diag; 下回合开始前清空)
  let _lastL0Diag: { failed: boolean; errors: string[]; durationMs: number } | null = null;

  async function scoreL0WithLLM(
    l0Nodes,
    userPrompt,
    ctx,
    networkPath?: string,
  ) {
    const model = (ctx as any).model || _textronModel;
    const l0StartedMs = Date.now();
    log(`Textron L0: model check — ctx.model: ${!!((ctx as any).model)}, _textronModel: ${!!_textronModel}, id: ${model?.id || 'MISSING'}, baseUrl: ${model?.baseUrl || 'MISSING'}`);
    recordMonitorEvent({
      type: "trace",
      action: "l0_score_start",
      modelId: model?.id || "MISSING",
      provider: model?.provider || "MISSING",
      hasBaseUrl: !!model?.baseUrl,
      promptChars: String(userPrompt || "").length,
      promptPreview: preview(userPrompt, 180),
      nodeCount: l0Nodes.length,
      nodes: l0Nodes.map((n) => ({ id: `L0::${n.id}`, name: preview(n.name || compressNodeName(n.content), 80), hasContent: !!n.content })),
    });
    if (!model?.id || !model?.baseUrl) {
      const scores = {};
      for (const n of l0Nodes) scores[`L0::${n.id}`] = 0.0;
      log("Textron: L0 scoring unavailable (no model provider), no activation");
      recordMonitorEvent({ type: "trace", action: "l0_score_unavailable", reason: "no_model_or_baseUrl", durationMs: Date.now() - l0StartedMs, scores: topScores(scores as Record<string, number>) });
      return scores;
    }

    const baseUrl = String(model.baseUrl).replace(/\/+$/, "");
    const endpoint = joinApiEndpoint(baseUrl, "/chat/completions");

    const { apiKey, source: apiKeySource } = await resolveModelApiKey(ctx, model);
    log(`Textron L0: model=${model.id} baseUrl=${model.baseUrl} provider=${model.provider} apiKey=${apiKeySource}`);

    const statsPath = networkPath ? path.join(networkPath, "_node_stats.json") : "";
    const nodeStats = readJson<Record<string, { success: number; failure: number }>>(statsPath, {});
    const nodesList = l0Nodes
      .map((n) => {
        const key = `L0::${n.id}`;
        const s = nodeStats[key];
        const statLine = s && (s.success + s.failure) > 0
          ? ` [战绩: 激活${s.success + s.failure}·成${s.success}·败${s.failure}]`
          : "";
        return `${n.id}: ${(n.name || compressNodeName(n.content) || "(empty)").slice(0, 80)}${statLine}`;
      })
      .join("\n");

    function normalizeScores(parsed: Record<string, unknown>) {
      const normalized: Record<string, number> = {};
      for (const n of l0Nodes) normalized[`L0::${n.id}`] = 0.0;
      for (const [key, val] of Object.entries(parsed || {})) {
        const num = Number(val);
        if (Number.isNaN(num)) continue;
        const k = key.startsWith("L0::") ? key : `L0::${key}`;
        if (k in normalized) normalized[k] = clamp(num, 0, 1);
      }
      return normalized;
    }

    function extractJsonObject(rawParts: string[]) {
      return parseNodeScores(rawParts.filter(Boolean).join("\n"));
    }

    const messages = [
      { role: "system", content: 'Score each Layer-0 node 0.0-1.0 by semantic relevance to the user task. Prefer a compact JSON object. If JSON is unavailable, return one score per line as L0::node_X=0.80. No explanation. Nodes with [战绩] showing high failure count score lower; high success scores higher.' },
      { role: "user", content: `Task: ${userPrompt.slice(0, 800)}\n\nNodes:\n${nodesList}` },
    ];

    function textify(x: unknown): string {
      if (typeof x === "string") return x;
      if (Array.isArray(x)) return x.map((p: any) => p?.text || p?.content || p?.value || "").join("\n");
      if (x && typeof x === "object") return JSON.stringify(x);
      return "";
    }

    async function callScorer(attempt: { jsonMode: boolean; label: string; budget: Record<string, unknown> }) {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
      // 预算/思考开关统一由 lib/llm_budget 的 buildBudgetParams 单一出口生成。
      // 各家"关思考"开关名不同(qwen=enable_thinking:false / deepseek=thinking.type:disabled /
      // 其余退 reasoning_effort:low)；手写参数名/预算就是 L0 四连败的病灶。
      const requestBody: Record<string, unknown> = { model: model.id, messages, ...attempt.budget };
      if (attempt.jsonMode) requestBody.response_format = { type: "json_object" };

      const res = await fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(requestBody),
        signal: AbortSignal.timeout(25000),
      });
      const rawBody = await res.text();
      let data;
      try { data = JSON.parse(rawBody); }
      catch { throw new Error(`Response not valid JSON: ${rawBody.slice(0, 240)}`); }
      if (!res.ok && !data?.choices?.[0]?.message) throw new Error(`HTTP ${res.status}: ${rawBody.slice(0, 240)}`);
      const msg = data?.choices?.[0]?.message || {};
      const parsed = extractJsonObject([textify(msg.content), textify(msg.reasoning_content), textify(msg.reasoning), textify(msg.refusal)]);
      return normalizeScores(parsed);
    }

    async function callResponsesScorer() {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
      const responsesEndpoint = joinApiEndpoint(baseUrl, "/responses");
      const requestBody: Record<string, unknown> = {
        model: model.id,
        input: messages,
        max_output_tokens: 512,
        reasoning: { effort: "minimal" },
        text: { format: { type: "json_object" } },
      };
      const res = await fetch(responsesEndpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(requestBody),
        signal: AbortSignal.timeout(45000),
      });
      const rawBody = await res.text();
      let data;
      try { data = JSON.parse(rawBody); }
      catch { throw new Error(`Responses API not JSON: ${rawBody.slice(0, 240)}`); }
      if (!res.ok) throw new Error(`Responses HTTP ${res.status}: ${rawBody.slice(0, 240)}`);
      const parts: string[] = [textify((data as any).output_text)];
      const out = (data as any).output;
      if (Array.isArray(out)) {
        for (const item of out) {
          parts.push(textify(item?.content));
          if (Array.isArray(item?.content)) for (const c of item.content) parts.push(textify(c?.text || c?.content));
        }
      }
      const parsed = extractJsonObject(parts);
      return normalizeScores(parsed);
    }

    async function callToolScorer() {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
      const properties: Record<string, unknown> = {};
      for (const n of l0Nodes) properties[`L0::${n.id}`] = { type: "number", minimum: 0, maximum: 1 };
      const requestBody: Record<string, unknown> = {
        model: model.id,
        messages,
        max_completion_tokens: 512,
        reasoning_effort: "low",
        tools: [{
          type: "function",
          function: {
            name: "score_nodes",
            description: "Return relevance scores for Textron Layer-0 nodes.",
            parameters: { type: "object", properties, required: Object.keys(properties), additionalProperties: false },
          },
        }],
        tool_choice: { type: "function", function: { name: "score_nodes" } },
      };
      const res = await fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(requestBody),
        signal: AbortSignal.timeout(45000),
      });
      const rawBody = await res.text();
      let data;
      try { data = JSON.parse(rawBody); }
      catch { throw new Error(`Tool response not JSON: ${rawBody.slice(0, 240)}`); }
      if (!res.ok && !data?.choices?.[0]?.message) throw new Error(`Tool HTTP ${res.status}: ${rawBody.slice(0, 240)}`);
      const calls = data?.choices?.[0]?.message?.tool_calls || [];
      const args = calls?.[0]?.function?.arguments;
      if (!args) throw new Error("No tool call arguments");
      return normalizeScores(typeof args === "string" ? JSON.parse(args) : args);
    }

    function collectUsefulStrings(obj: any, out: string[]) {
      if (!obj) return;
      if (typeof obj === "string") return;
      if (Array.isArray(obj)) { for (const x of obj) collectUsefulStrings(x, out); return; }
      if (typeof obj !== "object") return;
      for (const key of ["content", "text", "delta", "arguments", "output_text", "reasoning_content"]) {
        const v = obj[key];
        if (typeof v === "string") out.push(v);
        else if (Array.isArray(v) || (v && typeof v === "object")) collectUsefulStrings(v, out);
      }
      if (obj.function?.arguments && typeof obj.function.arguments === "string") out.push(obj.function.arguments);
    }

    async function readSseStrings(res: Response) {
      if (!res.body) throw new Error("No streaming body");
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      const parts: string[] = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const events = buf.split("\n\n");
        buf = events.pop() || "";
        for (const ev of events) {
          const dataLines = ev.split("\n").filter((line) => line.startsWith("data:"));
          for (const line of dataLines) {
            const payload = line.slice(5).trim();
            if (!payload || payload === "[DONE]") continue;
            try {
              const obj = JSON.parse(payload);
              collectUsefulStrings(obj, parts);
            } catch {
              parts.push(payload);
            }
          }
        }
      }
      if (buf.trim()) {
        for (const line of buf.split("\n")) {
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === "[DONE]") continue;
          try { collectUsefulStrings(JSON.parse(payload), parts); }
          catch { parts.push(payload); }
        }
      }
      return parts;
    }

    async function callStreamingChatScorer() {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
      const requestBody: Record<string, unknown> = {
        model: model.id,
        messages,
        stream: true,
        max_completion_tokens: 512,
        reasoning_effort: "low",
      };
      const res = await fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(requestBody),
        signal: AbortSignal.timeout(60000),
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => "");
        throw new Error(`stream chat HTTP ${res.status}: ${txt.slice(0, 240)}`);
      }
      const parts = await readSseStrings(res as any);
      const parsed = extractJsonObject(parts);
      return normalizeScores(parsed);
    }

    async function callStreamingResponsesScorer() {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
      const responsesEndpoint = joinApiEndpoint(baseUrl, "/responses");
      const requestBody: Record<string, unknown> = {
        model: model.id,
        input: messages,
        stream: true,
        max_output_tokens: 512,
        reasoning: { effort: "minimal" },
        text: { format: { type: "json_object" } },
      };
      const res = await fetch(responsesEndpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(requestBody),
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => "");
        throw new Error(`stream responses HTTP ${res.status}: ${txt.slice(0, 240)}`);
      }
      const parts = await readSseStrings(res as any);
      const parsed = extractJsonObject(parts);
      return normalizeScores(parsed);
    }

    // L0 打分 attempts：预算/思考开关全部走 buildBudgetParams 单一出口。
    // ① 关思考优先 —— deepseek 关思考后实测 1.2s 出合法 JSON（最稳最快）；
    //    旧版仅 tokens:1024 + reasoning_effort:low → 思考吃光预算 → instruction-echo → 解析失败。
    // ② 保底抬预算到 4096（不关思考）。
    const l0Compat: any = resolveModelCompat(model) || {};
    const l0ModelRef = { id: model?.id, provider: model?.provider, baseUrl: model?.baseUrl };
    const attempts = [
      { jsonMode: true, label: "json_mode/nothinking4096",
        budget: { ...buildBudgetParams(l0ModelRef, l0Compat, 4096, { noThinking: true }), temperature: 0 } },
      { jsonMode: true, label: "json_mode/budget4096",
        budget: { ...buildBudgetParams(l0ModelRef, l0Compat, 4096, {}), temperature: 0 } },
    ];
    const errors: string[] = [];
    for (const attempt of attempts) {
      try {
        const normalized = await callScorer(attempt);
        log(`Textron: L0 scored via LLM (${Object.keys(normalized).length} nodes, provider=${model.provider}, mode=${attempt.label})`);
        recordMonitorEvent({ type: "trace", action: "l0_score_done", status: "ok", mode: attempt.label, provider: model.provider, durationMs: Date.now() - l0StartedMs, nonzeroCount: Object.values(normalized).filter((v) => Number(v) > 0).length, topScores: topScores(normalized), allZero: Object.values(normalized).every((v) => Number(v) <= 0) });
        return normalized;
      } catch (e) {
        const err = `${attempt.label}: ${(e as Error).message}`;
        errors.push(err);
        recordMonitorEvent({ type: "trace", action: "l0_score_attempt_failed", mode: attempt.label, error: preview(err, 260), durationMs: Date.now() - l0StartedMs });
      }
    }

    // One bounded remote attempt, then deterministic local relevance.
    // Slow provider fallbacks remain opt-in for diagnostics only.
    // NOTE: json_mode with low max_tokens often triggers instruction-echo from deepseek models.
    // If the first attempt failed with parse error, try tool_call as a second quick attempt before local fallback.
    if (process.env.TEXTRON_L0_SLOW_FALLBACK !== "1" && errors.length > 0) {
      try {
        const normalized = await callToolScorer();
        log(`Textron: L0 scored via tool_call fallback (${Object.keys(normalized).length} nodes)`);
        recordMonitorEvent({ type: "trace", action: "l0_score_done", status: "ok", mode: "tool_call_fallback", provider: model.provider, durationMs: Date.now() - l0StartedMs, nonzeroCount: Object.values(normalized).filter((v) => Number(v) > 0).length, topScores: topScores(normalized), allZero: Object.values(normalized).every((v) => Number(v) <= 0) });
        return normalized;
      } catch (e2) {
        errors.push(`tool_call_fallback: ${(e2 as Error).message}`);
      }
    }
    if (process.env.TEXTRON_L0_SLOW_FALLBACK !== "1") {
      const localScores = buildLocalScores(String(userPrompt || ""), l0Nodes);
      recordMonitorEvent({
        type: "trace",
        action: "l0_score_local_fallback",
        provider: model.provider,
        durationMs: Date.now() - l0StartedMs,
        remoteErrors: errors.map((e) => preview(e, 180)),
        nonzeroCount: Object.values(localScores).filter((v) => v > 0).length,
        topScores: topScores(localScores),
      });
      return localScores;
    }

    try {
      const normalized = await callToolScorer();
      log(`Textron: L0 scored via LLM (${Object.keys(normalized).length} nodes, provider=${model.provider}, mode=tool_call)`);
      recordMonitorEvent({ type: "trace", action: "l0_score_done", status: "ok", mode: "tool_call", provider: model.provider, durationMs: Date.now() - l0StartedMs, nonzeroCount: Object.values(normalized).filter((v) => Number(v) > 0).length, topScores: topScores(normalized), allZero: Object.values(normalized).every((v) => Number(v) <= 0) });
      return normalized;
    } catch (e) {
      const err = `tool_call: ${(e as Error).message}`;
      errors.push(err);
      recordMonitorEvent({ type: "trace", action: "l0_score_attempt_failed", mode: "tool_call", error: preview(err, 260), durationMs: Date.now() - l0StartedMs });
    }

    try {
      const normalized = await callStreamingChatScorer();
      log(`Textron: L0 scored via LLM (${Object.keys(normalized).length} nodes, provider=${model.provider}, mode=stream_chat)`);
      recordMonitorEvent({ type: "trace", action: "l0_score_done", status: "ok", mode: "stream_chat", provider: model.provider, durationMs: Date.now() - l0StartedMs, nonzeroCount: Object.values(normalized).filter((v) => Number(v) > 0).length, topScores: topScores(normalized), allZero: Object.values(normalized).every((v) => Number(v) <= 0) });
      return normalized;
    } catch (e) {
      const err = `stream_chat: ${(e as Error).message}`;
      errors.push(err);
      recordMonitorEvent({ type: "trace", action: "l0_score_attempt_failed", mode: "stream_chat", error: preview(err, 260), durationMs: Date.now() - l0StartedMs });
    }

    try {
      const normalized = await callStreamingResponsesScorer();
      log(`Textron: L0 scored via LLM (${Object.keys(normalized).length} nodes, provider=${model.provider}, mode=stream_responses)`);
      recordMonitorEvent({ type: "trace", action: "l0_score_done", status: "ok", mode: "stream_responses", provider: model.provider, durationMs: Date.now() - l0StartedMs, nonzeroCount: Object.values(normalized).filter((v) => Number(v) > 0).length, topScores: topScores(normalized), allZero: Object.values(normalized).every((v) => Number(v) <= 0) });
      return normalized;
    } catch (e) {
      const err = `stream_responses: ${(e as Error).message}`;
      errors.push(err);
      recordMonitorEvent({ type: "trace", action: "l0_score_attempt_failed", mode: "stream_responses", error: preview(err, 260), durationMs: Date.now() - l0StartedMs });
    }

    try {
      const normalized = await callResponsesScorer();
      log(`Textron: L0 scored via LLM (${Object.keys(normalized).length} nodes, provider=${model.provider}, mode=responses_api)`);
      recordMonitorEvent({ type: "trace", action: "l0_score_done", status: "ok", mode: "responses_api", provider: model.provider, durationMs: Date.now() - l0StartedMs, nonzeroCount: Object.values(normalized).filter((v) => Number(v) > 0).length, topScores: topScores(normalized), allZero: Object.values(normalized).every((v) => Number(v) <= 0) });
      return normalized;
    } catch (e) {
      const err = `responses_api: ${(e as Error).message}`;
      errors.push(err);
      recordMonitorEvent({ type: "trace", action: "l0_score_attempt_failed", mode: "responses_api", error: preview(err, 260), durationMs: Date.now() - l0StartedMs });
    }

    log(`Textron: L0 scoring failed (${errors.join(" | ")}), no activation`);
    _lastL0Diag = { failed: true, errors: errors.map((e) => preview(e, 400)), durationMs: Date.now() - l0StartedMs };
    const zeroScores: Record<string, number> = {};
    for (const n of l0Nodes) zeroScores[`L0::${n.id}`] = 0.0;
    recordMonitorEvent({ type: "trace", action: "l0_score_done", status: "failed", durationMs: Date.now() - l0StartedMs, errorCount: errors.length, errors: errors.map((e) => preview(e, 260)), topScores: topScores(zeroScores), allZero: true });
    return zeroScores;
  }


  async function semanticBackwardLLM(
    net: NonNullable<ReturnType<typeof loadNetwork>>,
    previousTask: string,
    previousAssistantHighEntropy: string,
    currentUserMessage: string,
    activatedIds: string[],
    ctx: any,
    turnId?: string,
    compressionMandate?: string,
  ): Promise<{ reward: number; rationale?: string; node_updates?: Record<string, string | { name?: string; content?: string; context?: string }>; add_nodes?: { layer: number; name?: string; content: string; context?: string }[]; node_actions?: { action: "merge" | "delete" | "keep"; source?: string; target?: string; node?: string; rationale?: string }[] }> {
    const model = (ctx as any).model || _textronModel;
    if (!model?.id || !model?.baseUrl) return { reward: 0, rationale: "no model" };

    // 2026-09-15 n8 第十一轮根因修复（十轮反传全败的真因）：本函数内嵌的 normalize() 复制自
    // applySemanticNodeUpdates()，沿用了后者的形参名 `onLog`；但本函数作用域里没有该绑定
    // （本作用域的真名是 `log`）。于是只要 LLM 按 FUSION 契约返回 `drop` 字段（提示词强制要求，
    // 几乎必返）或返回 delete action，normalize 就在 L1890/L1911 抛 ReferenceError；该异常被
    // 候选循环的 catch{} 静默吞掉，最终统一伪装成 "no JSON object in semantic backward
    // response"。九轮修复因此全部打偏到「语法层」（json 修复层/流式拼接/CJK bigram），而 raw 一直
    // 合法（selfParse=ok）。c6538c0 的 stage 化 diag 一次即定位：candErrs=normalize#1(1560c):onLog is not defined。
    const onLog = log;

    const baseUrl = String(model.baseUrl).replace(/\/+$/, "");
    const chatEndpoint = joinApiEndpoint(baseUrl, "/chat/completions");
    const responsesEndpoint = joinApiEndpoint(baseUrl, "/responses");

    const { apiKey } = await resolveModelApiKey(ctx, model);

    const pathNodes = activatedIds.map((id) => {
      const parsed = parseLayerNodeId(id);
      const nodePath = parsed ? path.join(net.path, `layer_${parsed.layer}`, `${parsed.nodeId}.html`) : "";
      let content = parsed ? readNodeContent(nodePath) : "";
      let name = parsed ? readNodeName(nodePath) : "";
      // Cold-start virtual node: content is in previousTask, not on disk yet
      const isVirtual = parsed && !content && (parsed.nodeId.startsWith("_seed_") || parsed.nodeId.startsWith("_cold_"));
      if (isVirtual) {
        content = applyContentLimit(previousTask);
        name = compressNodeName(content);
      }
      return { id, name, content, parsed, isVirtual };
    });

    // ── Discover related nodes (TF-IDF similarity) for merge/delete candidates ──
    // Collect same-layer candidates for every path node, then keep only the
    // best unique candidate globally (not one per layer/path node).
    const pathNodeKeySet = new Set(activatedIds);
    const relatedByNode = new Map<string, { pathNodeId: string; relatedNodeId: string; layer: number; name: string; content: string; similarity: number }>();
    for (const pn of pathNodes) {
      if (!pn.parsed) continue;
      const scores = tfidfSimilarity(net, pn.name, pn.content);
      for (const [key, score] of scores) {
        if (score < 0.05) continue; // bigram tokenizer: related pairs ~0.12-0.20, noise p50~0.037
        if (pathNodeKeySet.has(key)) continue; // skip nodes already on selected path
        const rp = parseLayerNodeId(key);
        // 2026-09-04: merge 抽象提升 → RELATED 候选放开到相邻抽象层 |Δlayer|≤1 (L1+L2 可归并)
        if (!rp || Math.abs(rp.layer - pn.parsed.layer) > 1) continue;
        const np = path.join(net.path, `layer_${rp.layer}`, `${rp.nodeId}.html`);
        const rc = readNodeContent(np);
        if (!rc) continue;
        const previous = relatedByNode.get(key);
        if (previous && previous.similarity >= Number(score.toFixed(3))) continue;
        const rn = readNodeName(np) || compressNodeName(rc);
        relatedByNode.set(key, {
          pathNodeId: pn.id,
          relatedNodeId: key,
          layer: rp.layer,
          name: rn,
          content: rc,
          similarity: Number(score.toFixed(3)),
        });
      }
    }
    const relatedNodes = [...relatedByNode.values()]
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, 1);

    const sbStartedMs = Date.now();
    recordMonitorEvent({
      type: "trace",
      action: "semantic_backward_llm_start",
      taskFamily: path.basename(net.path),
      modelId: model?.id || "MISSING",
      provider: model?.provider || "MISSING",
      hasHighEntropy: !!previousAssistantHighEntropy,
      previousTaskChars: previousTask.length,
      currentMessageChars: currentUserMessage.length,
      activatedIds,
    });

    const previousCrystal = parseHighEntropyCrystal(previousAssistantHighEntropy ? `<HighEntropy>${previousAssistantHighEntropy}</HighEntropy>` : "");
    // 2026-08-03: <Function> 块（functionSymbol/functionAbstract）随训练包透传——parseHighEntropyCrystal 只取
    // Name/Task/Technique，Function 块不进 prompt 则 functionSymbol 落盘核验（引用链 H1）结构性不可能通过。
    const functionBlock = extractFunctionBlock(previousAssistantHighEntropy);
    const schemaHint = '{"reward":0.0,"rationale":"≤80 chars","node_updates":{"L0::node_0":{"mode":"merge|replace","keep":"<旧内容中仍成立的要点，≤400 char>","drop":"<旧内容中被本轮证伪的要点+依据>","name":"<48 char","content":"<本轮新增/修正（增量，非全文）>"}},"add_nodes":[{"layer":0,"name":"<48 char","content":"<内容，无字数上限>"}],"node_actions":[{"action":"merge","source":"L1::node_3","target":"L1::node_6","rationale":"≤60 chars"}]}';
    // ── Build filtered existing nodes list (global top-1 by TF-IDF relevance) ──
    const existingNodesTfidf = tfidfSimilarity(net, previousTask.slice(0, 200), currentUserMessage.slice(0, 200));
    const allExistingNodes: { key: string; layer: number; name: string; content: string; sim: number }[] = [];
    for (let l = 0; l < net.hyperparams.layers.length; l++) {
      for (let n = 0; n < net.hyperparams.layers[l]; n++) {
        const np = path.join(net.path, `layer_${l}`, `node_${n}.html`);
        const c = readNodeContent(np);
        if (!c) continue;
        const key = `L${l}::node_${n}`;
        allExistingNodes.push({
          key,
          layer: l,
          name: readNodeName(np) || compressNodeName(c),
          content: c,
          sim: existingNodesTfidf.get(key) || 0,
        });
      }
    }
    // ── 每层节点统计+容量配置注入(2026-09-14): used=有内容节点数; cap=layerCaps(无配置默认40=旧MAX_PER_LAYER_SOFT语义);
    // 超容层(add被拒/必须先merge收缩)明确标出 —— LLM 依据网络配置决定 add/merge/update，而非无限增长。
    const layerStats = net.hyperparams.layers.map((slots, l) => {
      const used = allExistingNodes.filter(n => n.layer === l).length;
      const cap = layerCapFor(net.hyperparams, l);
      return { layer: l, slots, cap, used, over: used - cap };
    });
    const capsText = Array.isArray(net.hyperparams.layerCaps) && net.hyperparams.layerCaps.length
      ? `layerCaps=${JSON.stringify(net.hyperparams.layerCaps)}`
      : `layerCaps=未配置(默认每层上限=${DEFAULT_LAYER_CAP})`;
    const layerUsageText = layerStats.map(s => {
      const status = s.over > 0
        ? `OVER CAP +${s.over} (本层 add_nodes 会被系统拒绝, 必须先 merge/node_updates 收缩)`
        : `room=${s.cap - s.used}`;
      return `L${s.layer}: used=${s.used}/cap=${s.cap} ${status}`;
    }).join(" · ") + ` · ${capsText} · layers(槽位)=${JSON.stringify(net.hyperparams.layers)}`;
    const existingSimilarityFloor = 0.05;
    const shownExisting = allExistingNodes
      .filter((n) => n.sim >= existingSimilarityFloor)
      .sort((a, b) => b.sim - a.sim)
      .slice(0, 1);
    const promptExisting = shownExisting.length
      ? `Global top-${shownExisting.length} by task/feedback relevance (floor=${existingSimilarityFloor}; ${allExistingNodes.length} nodes scanned):\n${shownExisting.map(n => `  ${n.key} [sim=${n.sim.toFixed(2)}]: ${n.name}\n    content: ${String(n.content || "").replace(/\s+/g, " ").trim()}`).join("\n")}`
      : `(none; no EXISTING candidate reached similarity floor ${existingSimilarityFloor}; ${allExistingNodes.length} nodes scanned)`;

    const promptRelated = relatedNodes.length > 0
      ? relatedNodes.map(rn => `  ${rn.relatedNodeId} [sim=${rn.similarity} to ${rn.pathNodeId}]: ${rn.name}\n    content: ${String(rn.content || "").replace(/\s+/g, " ").trim()}`).join("\n")
      : "(none)";

    // ── 网络目标（GOAL）作为反传裁判 ──
    // 读取用户为该网络设定的目标（如 stock_alpha="沉淀交易经验"）。
    // 作用有二：① 给 LLM 一个“哪些知识属于本网络”的准入标准；
    // ② 把“与目标语义最不相关”的现有节点显式推到 prompt 里（否则 LLM 看不见就改不掉），
    //    并用 node_updates 覆盖重写 = 唯一的除域清洗通道（系统禁止 delete）。
    const OFF_GOAL_SHOW = 4;
    let goalCleanseFallback = "";
    const goalInfo = goalCleanseTargets(net, OFF_GOAL_SHOW);
    const netGoal = goalInfo.goal;
    const offGoalNodes = goalInfo.targets;
    if (netGoal) {
      recordMonitorEvent({
        type: "trace",
        action: "semantic_backward_goal_guard",
        taskFamily: path.basename(net.path),
        goal: netGoal,
        nodesScanned: goalInfo.scanned,
        offGoalCandidates: offGoalNodes.map(n => ({ id: n.key, goalSim: n.goalSim })),
      });
    }
    // ── 任务侧域闸（TASK-SIDE DOMAIN GATE）── 规则文本从 domain_gate 导入（单一事实来源）。
    // 真因：原 goal guard 是**单向**的 —— 只判「网络里已有节点是否离目标域」（rule 0 清道夫方向），
    // 从不判「本轮任务本身是否属目标域」。而 pinnedTaskFamily=stock_alpha 使 guard/sender 等
    // **工程会话**也被路由进交易网络（route_policy_decision.reason="pinned_manual"，实证 9 条
    // agent_end_task_pushed 中 4 条非交易域）⇒ 工程知识写进 L0/L1，淘汰后 content 仍悬空引用
    // （实测 L0::node_0 悬空 17 个 [fn:σ]）⇒ 节点趋向紊乱、路由锚点被稀释。
    const taskDomainGate = taskDomainGateRule(netGoal);
    const goalRule = netGoal ? `0. 🎯 NETWORK GOAL (HIGHEST PRIORITY — overrides rules 1-9 whenever they conflict). This network exists ONLY to accumulate knowledge for: "${netGoal}". Every node MUST serve this goal. Any node whose content belongs to a DIFFERENT domain (engineering / tooling / API / config / CLI / meta-workflow / session-log / audit report) is OFF-GOAL CONTAMINATION and MUST be cleansed:\n   (a) CLEANSING CHANNEL = node_updates: OVERWRITE the off-goal node's name AND content with goal-domain knowledge distilled from the packet below. This is the ONLY sanctioned way to remove off-goal knowledge (delete is forbidden by rule 1).\n   (a2) MANDATORY: if the MUST-CLEANSE candidate list below is NON-EMPTY, your node_updates MUST overwrite at least ONE of those listed nodes (with name AND content). Returning an empty node_updates while off-goal nodes exist is a FAILED response and will be treated as such (the system will fall back to a deterministic cleanse).\n   (b) NEVER merge off-goal content INTO a goal-domain node (nor into another off-goal node) — that produces keyword-soup nodes and corrupts Name-substring routing. merge is allowed ONLY when BOTH nodes serve the goal.\n   (c) Priority when capacity is tight: cleanse off-goal node (node_updates) > merge two goal-domain nodes > add_nodes.\n   (d) If this packet cannot supply enough goal-domain knowledge to fill an off-goal node, leave it as-is but list it in node_actions as {"action":"keep","rationale":"off_goal_deferred"}.\n   (e) Goal-domain knowledge has absolute admission priority: a goal node may overwrite an off-goal node even if similarity <15% (they are different domains, so low similarity is EXPECTED and is NOT a reason to skip the cleanse).\n   (f) Rule 6's "domain" judgement is ALWAYS the NETWORK GOAL below — if L0/L1 holds only off-goal (e.g. engineering) content, that counts as "no domain anchor" and must be cleansed/established per rules 0+6.\n` : "";
    const goalUserBlock = netGoal
      ? `\n\n🎯 NETWORK GOAL (admission & cleansing gate): ${netGoal}\nMUST-CLEANSE CANDIDATES — existing nodes ranked by LOWEST semantic relevance to the goal (lowest first; L0 prioritized; ${allExistingNodes.length} nodes scanned, showing ${offGoalNodes.length}). Per rule 0: if off-goal → node_updates overwrite with goal-domain knowledge; if already goal-domain but redundant → merge into its most relevant goal node; if it genuinely serves the goal → keep with rationale.\n${offGoalNodes.length ? offGoalNodes.map(n => `  ${n.key} [goal_sim=${n.goalSim}] ${n.name}\n    content: ${String(n.content || "").replace(/\s+/g, " ").trim().slice(0, 320)}`).join("\n") : "(network has no existing nodes yet — build goal-domain nodes via add_nodes)"}`
      : "";

    const messages = [
      { role: "system", content: `You are Textron semantic backward. Output ONLY raw JSON, no markdown. Format: ${schemaHint}.

RULES:
${taskDomainGate}${goalRule}1. Prefer node_updates over add_nodes. add_nodes ONLY for truly new concepts. NEVER propose delete — use merge(source→target) to deduplicate; the system auto-removes source after merging.
2. REWARD -1..1: Quantify the UPSTREAM FEEDBACK ITSELF — the user's explicit criticism/correction/approval, or objective assertion outcomes. The HighEntropy packet below is a POST-hoc summary (temporally AFTER the feedback): it is training material for node content ONLY and must NOT drive your reward judgment. Judge reward from the feedback's own polarity/strength and the previous task's completion status — NOT from how well the summary is written. Negative feedback (criticism/"错了"/"做错了"/unfulfilled promise) → reward≤0. Positive only when the feedback confirms a verifiable completed result. Off-topic → reward=-1, empty updates.
3. FAILURE→"avoid X→prefer Y". SUCCESS→encode WHY.
4. Content 无字数上限（写全，但禁止复制旧内容）. name MUST be a compressed symbolic anchor (like the integral sign ∫ or the term "Transformer"). Think: what ≤48c symbol captures the ESSENCE and can serve as a building block for future combinations? Use domain-specific concise nouns (e.g. "满月极性反转" not "2025-01-24 DOWN UP json_mode"). NEVER use file paths, variable names, or full sentences as names. No templates/session summaries.
5. Choose layer by content abstraction: L0=compact reusable principle, L1=causal mechanism, L2=concrete rule.
6. L0 CRITICAL: If ALL existing L0 nodes are non-domain (engineering/communication/tooling) but this task clearly belongs to the taskFamily domain, you MUST add 1-2 new L0 domain nodes (e.g. "K线三维共振·星象三天窗口·相位净计数" or "放量破位三周期共振·新月相位群覆盖基线") to establish domain routing anchors — BUT ONLY if L0 has spare capacity (Layer usage room>0); if L0 is at/over cap, you MUST merge the new domain knowledge into the most semantically-relevant existing L0 node via node_updates instead. This takes PRIORITY over L2 tactic updates — without L0 domain nodes, forward propagation cannot route to domain knowledge, breaking the entire network.
6b. L1 DOMAIN CHECK (soft, NOT mandatory): Consider whether the activated L1 nodes are semantically DISTANT from this task's domain (e.g. weapon/music/engineering content while the task is stock trading). If so, the causal layer may be MISSING a domain node — you MAY add 1 L1 domain node (causal mechanism: 若A则B因为C) when the mechanism is genuinely novel and reusable. This is a per-case judgment, not a rule: analyze concretely. A layer being at capacity is NOT by itself a reason to force-add (merging similar content is often the better choice); likewise an off-domain L1 is NOT always wrong — judge by actual semantic distance and reuse value.
7. MERGE DUTY: After producing node_updates, scan RELATED nodes for ≥15% semantic overlap (shared keywords, concepts, or domain). For each such pair, add a merge action (source=more-specific-node → target=more-general-node). Missing obvious merges → node bloat.
8. FUNCTION BLOCK (LLM决策·同类归并优先): The training packet may carry <Function> (functionSymbol + functionAbstract code). Decide by same-mechanism-merge-FIRST: (a) 同类归并 — if ANY forward-activated node or existing node covers the same function/mechanism (semantic overlap, or its content references the same functionSymbol), do NOT add a new node; merge the function incrementally into that node via node_updates (absorb the code body, keep that node's name). (b) 正交新增 — ONLY if the function is fully orthogonal to every existing node, add a new node via add_nodes: name = functionSymbol verbatim (以函数名为name), content = functionAbstract code (函数体为content). Prefer merge over add to prevent node bloat. The functionSymbol MUST appear verbatim as an exact substring in the absorbing/new node's content — never paraphrase, translate, or split it (citation routing matches it literally).\n9. CAPACITY-BOUNDED GROWTH (硬约束): 网络容量有限，不能无限增长。每层上限见 user prompt 的 Layer usage (cap=网络配置 layerCaps，无配置默认每层 40)。规则: (a) used>=cap 的层 add_nodes 会被系统拒绝(over_cap)——对满/超容层禁止 add_nodes，必须用 node_updates 更新已有节点或用 node_actions merge 去重腾出空间; (b) OVER CAP +N 的层是收缩优先级最高的层: 主动找出该层最冗余/最低质的节点对提出 merge(source→target)，merge 后源节点清空即可回收容量; (c) 仅在目标层 room>0 时才允许 add_nodes，且必须与所有现有节点正交(≥15% 重叠=update 不=add); (d) 不存在"新建层"逃生口: layer>=层数 的 add_nodes 一律拒绝。容量满了不代表停止学习——用 merge 压缩冗余、用 node_updates 提升已有节点信息密度，让同等容量承载更高熵知识。\n10. FUSION NOT OVERWRITE —— 三段式融合 (默认；覆盖必须举证): 节点更新 = **keep(旧内容中仍然成立、可复用的要点) + drop(旧内容中被本轮证据证伪的要点，附依据) + content(本轮新增/修正知识)**。内容素材三源并重：①旧 content（前向节点信息）②本轮 feedback（证伪/修正）③HighEntropy/Function（新增知识）。**禁止只写 content** —— 那等于覆盖，旧知识静默丢失（实测：高质量交易规则被整段顶替）。规则 8 的 keep that node's name 只保名字，**不代替保内容**。仅当旧内容被证伪或与 goal 无关(off-goal)时才 mode=replace 并在 rationale 给出证伪依据。` },
      { role: "user", content: `Layer usage: ${layerUsageText}${goalUserBlock}\n\nPrevious user task:\n${previousTask.slice(0, 4200)}\n\nPrevious assistant HighEntropy training packet:\n${previousCrystal?.ok ? `Name: ${previousCrystal?.name}\nTask: ${previousCrystal.task || "(legacy)"}\nTechnique: ${previousCrystal.technique}` : `(invalid/missing)`}${functionBlock ? `\nFunction:\n${functionBlock}` : ""}\n\nEXISTING nodes (DO NOT duplicate; global top-1 across all layers):\n${promptExisting}\n\nRELATED nodes (may need merge to deduplicate or LIFT abstraction; global top-1 across path nodes, same-or-adjacent layer |Δ|≤1):\n${promptRelated}\n\nFUSION TARGETS (旧内容=必须评估保留或显式证伪的融合素材，**不是**被替换对象；只写 content 即等于丢弃旧知识):\n${pathNodes.filter(n => !n.isVirtual).map(n => `${n.id}: ${n.name || "(empty)"}\n  content: ${String(n.content || "").replace(/\s+/g, " ").trim() || "(no content)"}`).join("\n") || "(none)"}${pathNodes.some(n => n.isVirtual) ? `\n\nSEED node (not in network — use add_nodes to materialize):\n${pathNodes.filter(n => n.isVirtual).map(n => `  ${n.id}: ${n.name}\n  content: ${String(n.content || "").replace(/\s+/g, " ").trim()}`).join("\n")}` : ""}\n\nCurrent feedback:\n${currentUserMessage.slice(0, FEEDBACK_PROMPT_MAX)}\n\nDistill reusable experience. ALWAYS prefer node_updates over add_nodes (>15% overlap=update). FAILED→"avoid X→prefer Y". SUCCEEDED→encode winning mechanism. Content 无字数上限（写全，禁复制旧文）, name=3-6 keywords≤48c.\n\n更新语义（三段式融合，强制）：keep=旧内容仍成立的要点 + drop=旧内容被本轮证伪的要点(附依据) + content=本轮新增。素材三源并重：旧 content(前向节点信息) / 本轮 feedback / HighEntropy·Function。只写 content = 覆盖 = 丢弃旧知识，视为不合格输出；整段替换须 mode=replace 并说明证伪依据。

MERGE SCAN (MANDATORY): Review RELATED nodes above. For EVERY pair with ≥15% semantic overlap (keywords/concepts/domain), output a merge action in node_actions. source and target MAY be in the SAME or ADJACENT abstract layer (|Δlayer|≤1; skip jumps like L0↔L2). MERGE LIFTS ABSTRACTION: system places result at the MORE ABSTRACT layer — L2+L2→L1, L1+L2→L1, L1+L1→L0, any L0 merge stays L0 (edges auto-rebuild from merged content via materialize). If no merges needed, output node_actions=[{"action":"keep","rationale":"no overlap ≥15%"}]. node_actions MUST NOT be empty — this is a required output field.${pathNodes.some(n => n.isVirtual) ? `\n\nCOLD START: A SEED node is provided above. It is NOT yet in the network. You MUST add at least one L0 domain node from the SEED content using add_nodes.` : ""}${compressionMandate ? `\n\n${compressionMandate}` : ""}` },
    ];

    // Log LLM input AFTER messages is fully constructed (was accidentally referenced before declaration — causing "Cannot access 'messages' before initialization")
    recordMonitorEvent({
      type: "trace",
      action: "semantic_backward_llm_input",
      taskFamily: path.basename(net.path),
      goal: netGoal || null,
      goalRuleChars: goalRule.length,
      goalCleanseFallback,
      offGoalShown: offGoalNodes.map(n => n.key),
      systemPromptChars: messages[0].content.length,
      userPromptChars: messages[1].content.length,
      compressionMandateChars: compressionMandate?.length || 0,
      modelId: model?.id,
      baseUrl: chatEndpoint,
    });

    function clampReward(v: unknown) { return clamp(Number(v) || 0, -1, 1); }
    function normalize(obj: any) {
      const out: { reward: number; rationale?: string; off_domain?: boolean; off_domain_reason?: string; node_updates?: Record<string, string | { name?: string; content?: string; context?: string }>; add_nodes?: { layer: number; name?: string; content: string; context?: string }[]; node_actions?: { action: "merge" | "delete" | "keep"; source?: string; target?: string; node?: string; rationale?: string }[] } = {
        reward: clampReward(obj?.reward),
      };
      if (obj?.rationale) out.rationale = String(obj.rationale).slice(0, 120);
      // ── 任务侧域闸（裁决点在 domain_gate.ts，与测试共用同一份逻辑）──
      // off_domain=true ⇒ 本轮任务不属网络目标域 ⇒ 内容面**全部丢弃**（node_updates/add_nodes/
      // merge 语义/Function 硬落盘），但 reward 保留 ⇒ autoBackward 仍更新边权（本轮前向确实用了
      // 本网络，边权是该事实的合法学习信号；被禁的是「把离域知识固化进节点容量」）。
      // 早退还顺带关掉 goalCleanseFallback —— 否则会用离域任务的 Technique 覆盖候选节点（同源污染的另一条通道）。
      const gate = evaluateTaskDomainGate(obj);
      if (gate.offDomain) {
        out.off_domain = true;
        out.off_domain_reason = gate.reason;
        recordMonitorEvent({
          type: "trace", action: "semantic_backward_off_domain",
          taskFamily: path.basename(net.path),
          reason: gate.reason,
          strippedUpdates: gate.strippedUpdates, strippedAdds: gate.strippedAdds,
          llmReward: Number(obj?.reward) || 0,
          goal: netGoal || null,
        });
        return out;
      }
      if (obj?.node_updates && typeof obj.node_updates === "object") {
        out.node_updates = {};
        for (const [k, v] of Object.entries(obj.node_updates)) {
          // Accept any valid layer-qualified node ID that exists in the network.
          // The LLM may choose different nodes than the activated path — trust its judgment.
          const parsed = parseLayerNodeId(k);
          if (!parsed) continue;
          const nodeExists = parsed.layer < net.hyperparams.layers.length &&
            parseInt(parsed.nodeId.replace('node_', ''), 10) < net.hyperparams.layers[parsed.layer];
          if (!nodeExists) continue;
          if (typeof v === "string" && v.trim()) {
            const content = completeContent(v.trim(), NODE_CONTENT_MAX_CHARS);
            const name = compressNodeName(content);
            if (content && name) out.node_updates[k] = { content, name };
          } else if (v && typeof v === "object") {
            const vv = v as any;
            // 融合语义(2026-09-14 FUSION NOT OVERWRITE): keep=旧内容必须保留的要点, content=本轮增量。
            // 默认 merge → 合成 keep ⏎ delta；仅 mode=replace 时才允许整段覆盖（需在 rationale 举证）。
            const rawMode = String(vv.mode || "merge").trim().toLowerCase();
            const keep = completeContent(String(vv.keep || "").trim(), 400);
            const delta = completeContent(String(vv.content || vv.context || "").trim(), NODE_CONTENT_MAX_CHARS);
            const content = rawMode === "replace" || !keep ? delta : `${keep} ⏎ ${delta}`;
            const name = completeContent(String(vv.name || compressNodeName(content)).trim(), 64);
            const drop = String(vv.drop || "").trim();
            if (drop) onLog(`Textron fusion: ${k} drop(证伪)=${drop.slice(0, 200)}`);
            if (content && name && !isNgramFragmentContent(content) && !isNgramFragmentName(name)) out.node_updates[k] = { name, content };
          }
        }
      }
      if (Array.isArray(obj?.add_nodes)) {
        out.add_nodes = [];
        for (const n of obj.add_nodes.slice(0, 2)) {  // allow limited growth; gates below decide final promotion
          const layer = Number(n?.layer);
          const content = completeContent(String(n?.content || n?.context || n?.name || "").trim(), NODE_CONTENT_MAX_CHARS);
          const name = completeContent(String(n?.name || compressNodeName(content)).trim(), 64);
          // 容量约束(2026-09-14): layer 必须是现有层；新建层逃生口已移除（rule 9 硬约束）
          if (Number.isInteger(layer) && layer >= 0 && layer < net.hyperparams.layers.length && content && name && !isNgramFragmentContent(content) && !isNgramFragmentName(name)) out.add_nodes.push({ layer, name, content });
        }
      }
      if (Array.isArray(obj?.node_actions)) {
        out.node_actions = [];
        for (const a of obj.node_actions.slice(0, 4)) {
          const action = String(a?.action || "").trim().toLowerCase();
          if (action !== "merge" && action !== "keep") {
            if (action === "delete") {
              onLog(`Textron semantic backward: IGNORED delete action from LLM (${a?.node || "?"}) — delete is system-managed, use merge instead`);
            }
            continue;
          }
          const entry: any = { action: action as "merge" | "keep" };
          if (a?.rationale) entry.rationale = String(a.rationale).slice(0, 80);
          if (action === "merge") {
            entry.source = String(a?.source || "").trim();
            entry.target = String(a?.target || "").trim();
            if (!entry.source || !entry.target) continue;
            // Validate both nodes exist in network.
            // 2026-09-04: 允许相邻抽象层跨层 merge (L1+L2→L1)。
            // 2026-09-14 (n8 第三轮 guard 实证): 原实现额外用 |Δlayer|>1 一刀切丢弃，
            // 使 LLM 提出的「向上提升」(L3→L0 / L2→L0) 被静默拒 → 每次反传
            // nodesMerged=0，且 L3 结论永不进前向注入(topKByLayer 只取 0/1/2)= 死知识，
            // 而 L0 在 cap=2 满容时 add_nodes 一律 over_cap 拒绝 → 抽象融合唯一的通路被切断。
            // 层向判定改用单一事实来源 mergeLayerAllowed(): 只拒「向下跳层」(把抽象知识
            // 塞进更具体层)，放行任意级向上提升 —— liftMergeNodes 的宿主定层/ledger 重锚/
            // 物化重建对任意层差成立，容量由 allocSlot 硬闸兜底(满则截断或 host_alloc_over_cap)。
            const sp = parseLayerNodeId(entry.source); const tp = parseLayerNodeId(entry.target);
            if (!sp || !tp || !mergeLayerAllowed(sp.layer, tp.layer)) {
              recordMonitorEvent({ type: "trace", action: "merge_action_dropped", source: entry.source, target: entry.target, reason: (!sp || !tp) ? "unparseable_id" : "layer_jump_downward" });
              continue; // merge within same/adjacent layer, or upward lift; only downward jumps are rejected
            }
            if (sp.layer - tp.layer > 1) {
              recordMonitorEvent({ type: "trace", action: "merge_action_lifted", source: entry.source, target: entry.target, delta: sp.layer - tp.layer });
            }
          }
          out.node_actions.push(entry);
        }
      }
      // ── 网络目标兜底清洗（确定性强保证）──
      // LLM 对「离域节点清洗」的执行不稳定：同一 prompt 可能返回空 node_updates（实测发生）。
      // 若本轮属于目标域、存在离域候选、而 LLM 未覆盖任何候选 ⇒ 程序侧用本轮 Technique
      // 覆盖最离域的候选节点（replace 语义由 applySemanticNodeUpdates 的 forceOverwrite 保证）。
      // 理由：goal 是用户显式声明的域不变式，不能依赖采样运气。
      if (netGoal && offGoalNodes.length) {
        const covered = offGoalNodes.some((n) => !!out.node_updates && !!out.node_updates![n.key]);
        // 2026-09-15 n8 第十轮：空指针防御。parseHighEntropyCrystal 在无 HighEntropy/解析失败时
        // 可返回 undefined；旧写法 `previousCrystal.technique` 会抛 TypeError，被下方 extract 的
        // catch{} 静默吞掉 → 伪装成「no JSON object」（语义层病灶被误诊为语法层）。
        const cleanseText = String(previousCrystal?.technique || "").trim();
        if (!covered && cleanseText) {
          const victim = offGoalNodes[0].key;
          out.node_updates = out.node_updates || {};
          out.node_updates[victim] = {
            name: (previousCrystal?.name || compressNodeName(cleanseText)).slice(0, 64),
            content: applyContentLimit(cleanseText),
          };
          goalCleanseFallback = victim;
          recordMonitorEvent({
            type: "trace",
            action: "semantic_backward_goal_cleanse_fallback",
            taskFamily: path.basename(net.path),
            goal: netGoal,
            victim,
            contentChars: cleanseText.length,
            reason: "llm_returned_empty_node_updates",
          });
        }
      }
      return out;
    }
    function extract(rawParts: string[]) {
      const raw = rawParts.filter(Boolean).join("\n").trim();
      if (!raw) throw new Error("empty semantic backward response");

      const candidates: string[] = [];
      function addCandidate(s: string | undefined) {
        const c = String(s || "").trim();
        if (c && !candidates.includes(c)) candidates.push(c);
      }
      addCandidate(raw);
      const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
      addCandidate(fence?.[1]);

      // 2026-09-01: 字符串感知的平衡括号扫描——跳过字符串内的 { } 与转义字符，
      // 避免 content/reasoning 字段内的花括号误切（与 /api/step 提取器同款逻辑）。
      const balanced: string[] = [];
      for (let i = 0; i < raw.length; i++) {
        if (raw[i] !== "{") continue;
        let d = 0;
        let inString = false;
        let escaped = false;
        for (let j = i; j < raw.length; j++) {
          const ch = raw[j];
          if (inString) {
            if (escaped) escaped = false;
            else if (ch === "\\") escaped = true;
            else if (ch === '"') inString = false;
            continue;
          }
          if (ch === '"') inString = true;
          else if (ch === "{") d++;
          else if (ch === "}" && --d === 0) { balanced.push(raw.slice(i, j + 1)); break; }
        }
      }
      for (const c of balanced.sort((a, b) => b.length - a.length)) addCandidate(c);

      // 2026-09-15 n8 第九轮：JSON 恢复层。实证：glm-5.3-flash 本轮 8 连败（4 模式×2 轮），
      // chat_json 非流式 head 合法 JSON 开头 + finish=stop + partsChars≤1783 非截断，但 balanced 扫描也救不起
      // → 字符串值内未转义双引号使扫描错位；流式则叠加 readSse delta join("\n") 假换行污染（head 逐字符空格铁证）。
      // 恢复策略：状态机重建——字符串内未转义引号转义、裸控制字符转义、尾逗号删除。合法 JSON 原样通过不受影响。
      function tryRepairJsonParse(s: string): any | undefined {
        const variants: string[] = [];
        try {
          let out = "";
          let inStr = false, esc = false;
          for (let i = 0; i < s.length; i++) {
            const ch = s[i];
            if (!inStr) { out += ch; if (ch === '"') inStr = true; continue; }
            if (esc) { out += ch; esc = false; continue; }
            if (ch === "\\") { out += ch; esc = true; continue; }
            if (ch === '"') {
              let k = i + 1;
              while (k < s.length && /\s/.test(s[k])) k++;
              const nk = s[k];
              if (nk === undefined || nk === "," || nk === "}" || nk === "]" || nk === ":") { inStr = false; out += ch; }
              else out += '\\"';
              continue;
            }
            if (ch === "\n") { out += "\\n"; continue; }
            if (ch === "\r") { out += "\\r"; continue; }
            if (ch === "\t") { out += "\\t"; continue; }
            out += ch;
          }
          variants.push(out);
        } catch { /* 忽略，走原样候选 */ }
        for (const v of [...variants]) variants.push(v.replace(/,(\s*[}\]])/g, "$1"));
        for (const v of variants) { try { return JSON.parse(v); } catch { /* 下一个变体 */ } }
        return undefined;
      }

      // 2026-09-01: 实质形状判定。截断残骸（如 {"reward":0} 碎片）只含 reward 键，
      // 不得视为有效 backward 响应——必须带 node_updates/add_nodes/node_actions 之一。
      // 否则截断会被静默“部分吞掉”，退化成 reward=0 空更新（P1 病灶）。
      function hasBackwardShape(parsed: any): boolean {
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
        const hasUpdates = !!parsed.node_updates && typeof parsed.node_updates === "object";
        const hasAdds = Array.isArray(parsed.add_nodes);
        const hasActions = Array.isArray(parsed.node_actions);
        return hasUpdates || hasAdds || hasActions;
      }

      let fallback: ReturnType<typeof normalize> | null = null;
      let repairedCandidateChars = 0;
      // 2026-09-15 n8 第十轮：失败归因闭环。旧实现 catch{} 静默吞掉 normalize 的异常，
      // 使「JSON 合法但提取仍失败」的语义级病灶被伪装成 "no JSON object"——九轮审计因此
      // 全部打偏到语法层（流式换行/CJK分词/repair）。此处把逐候选失败按 stage 累积，
      // 并在失败 diag 中暴露，使一次失败即可定位（parse / parse+repair / normalize）。
      const candidateErrors: { i: number; len: number; stage: string; msg: string }[] = [];
      let ci = 0;
      for (const candidate of candidates) {
        ci++;
        let parsed: any;
        try { parsed = JSON.parse(candidate); }
        catch (e0) {
          try { parsed = tryRepairJsonParse(candidate); } catch { parsed = undefined; }
          if (parsed !== undefined) repairedCandidateChars = candidate.length;
          else candidateErrors.push({ i: ci, len: candidate.length, stage: "parse+repair", msg: String((e0 as Error)?.message || e0).slice(0, 100) });
        }
        try {
          if (parsed === undefined) continue;
          const normalized = normalize(parsed);
          if (hasBackwardShape(parsed)) {
            if (repairedCandidateChars) {
              recordMonitorEvent({ type: "trace", action: "semantic_backward_json_repaired", taskFamily: path.basename(net.path), repairedChars: repairedCandidateChars, rawChars: raw.length });
              onLog(`Textron semantic backward: JSON recovered by repair layer (${repairedCandidateChars}c candidate)`);
            }
            return normalized;
          }
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed) &&
              Object.prototype.hasOwnProperty.call(parsed, "reward")) {
            // 仅含 reward 的候选：可能是截断残骸，也可能是有意空更新；先暂存，继续找更大的候选
            fallback ||= normalized;
          }
        } catch (e) {
          candidateErrors.push({ i: ci, len: candidate.length, stage: "normalize", msg: String((e as Error)?.message || e).slice(0, 160) });
        }
      }
      if (fallback) {
        // 只有 raw 整体可完整解析（非截断）时，reward-only 才视为“有意空更新”并接受；
        // 否则判定为截断/部分吞掉，显式失败而不是静默 reward=0。
        try {
          const full = JSON.parse(raw);
          if (full && typeof full === "object" && !Array.isArray(full) &&
              Object.prototype.hasOwnProperty.call(full, "reward")) {
            return fallback;
          }
        } catch {}
        const reason = "semantic backward response truncated/non-substantive: only reward-only fragment found";
        onLog(`Textron semantic backward: ${reason}`);
        recordMonitorEvent({ type: "error", action: "semantic_backward_truncated_fragment", taskFamily: path.basename(net.path), reason, rawContentChars: raw.length, rawPreview: raw.slice(0, 400) });
        try {
          const logDir = path.join(net.path, "_sb_logs");
          ensureDir(logDir);
          fs.appendFileSync(path.join(logDir, "_truncated_response.log"), `${new Date().toISOString()} ${reason}\n${raw.slice(0, 1000)}\n\n`, "utf-8");
        } catch {}
        throw new Error(reason);
      }
      // 2026-09-15 n8 第九轮：失败诊断升格——旧实现只落 1000c 头部（diag 内 head 160c），
      // 语法病灶永远不可见（raw_response 事件在 extract 抛异常后永不发出）。失败时落完整 raw。
      // 自解析探针：区分「raw 语法非法」与「raw 合法但 normalize 语义失败」——selfParse=ok
      // 且 candErrs 全为 normalize 时，病灶必在 normalize 而非解析层。
      let selfParse = "ok";
      try { const p = JSON.parse(raw); selfParse = `ok(keys=${Object.keys(p || {}).join(",")})`; }
      catch (e) { selfParse = `fail(${String((e as Error)?.message || e).slice(0, 80)})`; }
      const candErrs = candidateErrors.length ? candidateErrors.slice(0, 4).map((x) => `${x.stage}#${x.i}(${x.len}c):${x.msg}`).join(" | ") : "none";
      const diag = `no JSON object in semantic backward response (finish=${lastFinishReason || "?"}, partsChars=${raw.length}, candidates=${candidates.length}, selfParse=${selfParse}, candErrs=${candErrs}, head=${raw.slice(0, 160).replace(/\s+/g, " ")})`;
      try {
        recordMonitorEvent({ type: "error", action: "semantic_backward_extract_failed", taskFamily: path.basename(net.path), rawChars: raw.length, candidates: candidates.length, selfParse, candidateErrors: candidateErrors.slice(0, 8), rawHead: raw.slice(0, 800) });
      } catch { /* 忽略 */ }
      try {
        ensureDir(path.join(net.path, "_sb_logs"));
        rolloverLogBySize(path.join(net.path, "_sb_logs", "_nojson_response.log"), 2);
        fs.appendFileSync(path.join(net.path, "_sb_logs", "_nojson_response.log"), `${new Date().toISOString()} ${diag}\n[FULL_RAW]\n${raw}\n[/FULL_RAW]\n\n`, "utf-8");
      } catch { /* 忽略 */ }
      throw new Error(diag);
    }
    // 2026-08-03: 兼容各厂商 SSE 形态（OpenAI/deepseek/kimi choices[].delta、Gemini candidates[].content.parts[]、
    // Anthropic content_block）：递归遍历所有容器对象，仅白名单叶子键收串。
    // 旧实现只在当前层级查 content/delta 等键，choices 从未被进入 → 流式兜底对标准 SSE 恒返回空（2026-08-02 两连空实锤）。
    const SSE_LEAF_KEYS = new Set(["content", "text", "delta", "arguments", "output_text", "reasoning_content"]);
    function collect(obj: any, out: string[], key?: string) {
      if (obj == null) return;
      if (typeof obj === "string") { if (key && SSE_LEAF_KEYS.has(key)) out.push(obj); return; }
      if (Array.isArray(obj)) { for (const x of obj) collect(x, out, key); return; }
      if (typeof obj !== "object") return;
      for (const [k, v] of Object.entries(obj)) collect(v, out, k);
    }
    async function readSse(res: any) {
      const reader = res.body?.getReader();
      if (!reader) throw new Error("no stream body");
      const dec = new TextDecoder();
      let buf = "";
      const parts: string[] = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const events = buf.split("\n\n");
        buf = events.pop() || "";
        for (const ev of events) {
          for (const line of ev.split("\n")) {
            if (!line.startsWith("data:")) continue;
            const payload = line.slice(5).trim();
            if (!payload || payload === "[DONE]") continue;
            try { collect(JSON.parse(payload), parts); } catch { parts.push(payload); }
          }
        }
      }
      // 2026-09-15 n8 第九轮：SSE delta 无缝拼接。旧 join("\n") 在单字符 delta 粒度下向 JSON
      // 字符串值内灌入裸换行（glm-5.3-flash 实证，head 逐字符空格铁证）→ 全候选非法。delta 本是增量切片，无需分隔。
      return [parts.filter(Boolean).join("")];
    }
    // ── 2026-09-03 输出预算根因修复 ───────────────────────────────────────────
    // 病灶: reasoning 模型默认 thinking=high，4096 预算被 reasoning 吃光 → content="" +
    //   finish_reason=length → 三重兜底全部 "no JSON object"（2026-09-02 一晚 4 连败实锤）。
    // 同一失败 prompt 重放实测（qwen3.8-flash @ dashscope compatible-mode）:
    //   max_completion_tokens=4096                → 86.6s · content 0c / reasoning 13716c → 失败
    //   max_tokens=4096                           → 42.4s · content 432c 合法 JSON        → 成功
    //   max_tokens=4096 + reasoning_effort=low    → 11.6s · content 660c 合法 JSON        → 成功
    //   max_tokens=4096 + enable_thinking=false   →  4.4s · content 358c 合法 JSON        → 成功
    // 参数名按 compat.maxTokensField 分流，并统一压 thinking 预算（L0 打分器长期用 max_tokens +
    // reasoning_effort=low 一直稳定，backward 路径与它参数不一致就是病灶）。
    // 注意：reasoning_effort 只发给已声明 supportsReasoningEffort 的模型；deepseek 未声明→不发
    //（旧实测：deepseek 老模型传该参会引发 8K+ 思维链→超时），deepseek 只靠 4096→8192 抬预算修复。
    const sbCompat: any = resolveModelCompat(model) || {};
    const sbCanBound = canBoundThinking({ id: model?.id, provider: model?.provider, baseUrl }, sbCompat);
    // 预算参数由 lib/llm_budget 单一出口生成（写死参数名/预算就是本次 4 连败的病灶）。
    const sbBudget = (noThinking?: boolean) =>
      buildBudgetParams({ id: model?.id, provider: model?.provider, baseUrl }, sbCompat, 8192, { noThinking });
    // attempt 超时也要自适应：实测 deepseek-v4-flash（不可界思考）在 8192 预算下 >150s 不返回，
    // 固定 180s×4 attempt = 12 分钟空转；而它关思考后 1.2s 就出合法 JSON。
    const sbTimeout = (noThinking?: boolean) =>
      noThinking ? 60000 : (sbCanBound ? 150000 : 45000);
    recordMonitorEvent({ type: "debug", action: "semantic_backward_params_resolved", taskFamily: path.basename(net.path), model: model?.id, provider: model?.provider, compatKeys: Object.keys(sbCompat).join(",") || "none", canBoundThinking: sbCanBound, params: sbBudget(false), noThinkingParams: sbBudget(true) });
    let lastFinishReason = "";

    async function callChat(stream: boolean, opts?: { noThinking?: boolean }) {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
      // No response_format json_object on the primary attempt (deepseek 实测 HTTP 400，不支持).
      // Plain text + "ONLY JSON" 契约仍是首选，预算参数见上方分流。
      const body: Record<string, unknown> = { model: model.id, messages, stream, ...sbBudget(opts?.noThinking) };
      // 2026-07-21: 30s→90s；2026-08-03: 90s→180s（kimi thinking 长尾）；预算/思考开关已全部交由 sbBudget。
      const res = await fetch(chatEndpoint, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(sbTimeout(opts?.noThinking)) });
      if (stream) {
        if (!res.ok) throw new Error(`chat stream HTTP ${res.status}: ${(await res.text().catch(() => "")).slice(0, 160)}`);
        return extract(await readSse(res as any));
      }
      const txt = await res.text();
      const data = JSON.parse(txt);
      if (!res.ok && !data?.choices?.[0]?.message) throw new Error(`chat HTTP ${res.status}: ${txt.slice(0, 160)}`);
      lastFinishReason = String(data?.choices?.[0]?.finish_reason || "");
      const msg = data?.choices?.[0]?.message || {};
      let rawContent = String(msg.content || "");
      const rawReasoning = String(msg.reasoning_content || "");
      if (!rawContent) {
        // 2026-09 根因: reasoning 型模型(deepseek-v4-flash)把答案 JSON 放进 reasoning_content、content 留空。
        // 策略(采纳拼接思路但带护栏): content 为空时把 reasoning_content 全文【并入解析输入】——
        // 整体 JSON、散文内嵌的最长合法 JSON 都能被下方 extract() 的 balanced-brace 扫描救起；
        // 只有 extract 最终提取不到对象才判失败。content 非空时仍不拼 reasoning(防止 reasoning 内
        // 模板碎片/散文噪音干扰正常输出)。
        const trimmedR = rawReasoning.trim();
        if (trimmedR) {
          const diagInfo = `rawContent empty → reasoning merged. finish=${data?.choices?.[0]?.finish_reason || "none"} reasoningChars=${rawReasoning.length} reasoningHead=${trimmedR.slice(0, 140)}`;
          try { fs.appendFileSync(path.join(net.path, "_sb_logs", "_empty_response.log"), `${new Date().toISOString()} ${diagInfo}\n`, "utf-8"); } catch { /* 忽略 */ }
          rawContent = trimmedR;
          log(`Textron semantic backward: content empty → merged reasoning_content into parse input (${rawReasoning.length}c)`);
          recordMonitorEvent({ type: "debug", action: "semantic_backward_reasoning_merged", taskFamily: path.basename(net.path), reasoningChars: rawReasoning.length, mode: stream ? "chat_stream" : "chat_json" });
        } else {
          throw new Error(`empty semantic backward response (HTTP ${res.status}, finish=${data?.choices?.[0]?.finish_reason || "?"})`);
        }
      }
      // 解析策略说明: 常规情况下只解析 content(正文是正式输出); 仅当 content 为空时把 reasoning 并入输入,
      // 由 extract 的 balanced-brace 取【最长合法 JSON】——模板碎片({"reward":0} 等)通常更短, 不会被误选。
      // ── DIAGNOSTIC: compare direct JSON.parse vs extract() ──
      let directParseOk = false; let directReward = 0; let directKeys: string[] = []; let directParseErr = "";
      try {
        const dp = JSON.parse(rawContent);
        directParseOk = true; directReward = Number(dp.reward) || 0;
        directKeys = Object.keys(dp.node_updates || {});
      } catch(e) { directParseErr = (e as Error).message; }
      const result = extract([rawContent]);
      // DEBUG: log raw LLM response and parsed result for diagnosis
      recordMonitorEvent({
        type: "debug",
        action: "semantic_backward_llm_raw_response",
        taskFamily: path.basename(net.path),
        mode: stream ? "chat_stream" : "chat_json",
        rawContentChars: rawContent.length,
        rawContent: rawContent.slice(0, 2000),
        rawReasoningChars: rawReasoning.length,
        rawReasoning: rawReasoning.slice(0, 800),
        parsedReward: result.reward,
        parsedRationale: result.rationale || "",
        parsedNodeUpdateKeys: Object.keys(result.node_updates || {}),
        parsedAddNodeCount: (result.add_nodes || []).length,
        diagDirectParseOk: directParseOk,
        diagDirectReward: directReward,
        diagDirectKeys: directKeys,
        diagDirectParseErr: directParseErr,
        systemPromptPreview: preview(messages[0].content, 400),
        userPromptPreview: preview(messages[1].content, 600),
      });
      return result;
    }
    async function callChatJsonStream() {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
      // 最后兜底: 流式 + json_object + 彻底关思考（qwen/gpt 系支持；deepseek 会 400，属预期的末路尝试）
      const body: Record<string, unknown> = { model: model.id, messages, stream: true, ...sbBudget(true), response_format: { type: "json_object" } };
      const res = await fetch(chatEndpoint, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(60000) });
      if (!res.ok) throw new Error(`chat json stream HTTP ${res.status}: ${(await res.text().catch(() => "")).slice(0, 160)}`);
      const parts = await readSse(res as any);
      const result = extract(parts);
      recordMonitorEvent({
        type: "debug",
        action: "semantic_backward_llm_raw_response",
        taskFamily: path.basename(net.path),
        mode: "chat_json_stream",
        rawPartsCount: parts.length,
        rawContent: parts.join("").slice(0, 2000),
        parsedReward: result.reward,
        parsedRationale: result.rationale || "",
        parsedNodeUpdateKeys: Object.keys(result.node_updates || {}),
        parsedAddNodeCount: (result.add_nodes || []).length,
      });
      return result;
    }

    const errors: string[] = [];
    // 2026-07-21: 三重兜底 → 2026-09-03 扩为四重，并改为自适应排序。
    // 约束一：attempt 必须沿“实际失败轴”彼此不同——旧三重共享同一错误参数 = 同一个死法重复三次
    //   （假兜底，只放大失败不产生覆盖）。
    // 约束二：能否“有界思考”决定顺序。不可界思考的模型（deepseek-v4-flash 实测 8192 预算 >150s 不返回，
    //   关思考后 1.2s 出合法 JSON）先跑 chat_nothinking；可界模型（qwen/kimi）先跑带推理的 chat_json 保质量。
    // chat_json(非流式+预算修正) ↔ chat_nothinking(彻底关思考) → chat_stream(流式) → chat_json_stream(流式+json_object)。
    const sbOrdered: [string, () => Promise<any>][] = sbCanBound
      ? [["chat_json", () => callChat(false)], ["chat_nothinking", () => callChat(false, { noThinking: true })], ["chat_stream", () => callChat(true)], ["chat_json_stream", () => callChatJsonStream()]]
      : [["chat_nothinking", () => callChat(false, { noThinking: true })], ["chat_json", () => callChat(false)], ["chat_stream", () => callChat(true)], ["chat_json_stream", () => callChatJsonStream()]];
    const attempts: [string, () => Promise<any>][] = sbOrdered;
    for (const [label, fn] of attempts) {
      try {
        const result = await fn();
        log(`Textron semantic backward LLM ok (${label}, reward=${result.reward.toFixed(3)})`);
        // ── File log: full LLM input/output ──
        try {
          const logEntry = {
            ts: new Date().toISOString(),
            taskFamily: path.basename(net.path),
            mode: label,
            model: model?.id,
            systemPrompt: messages[0].content,
            userPrompt: messages[1].content,
            // Preserve provenance separately from the prompt so the trajectory UI does
            // not need to infer source/category from truncated natural-language text.
            nodeInput: {
              path: pathNodes.map((n) => ({ id: n.id, layer: n.parsed?.layer ?? null, name: n.name, content: String(n.content || ""), virtual: !!n.isVirtual })),
              existing: shownExisting.map((n) => ({ id: n.key, layer: n.layer, name: n.name, content: String(n.content || ""), similarity: Number(n.sim.toFixed(3)) })),
              related: relatedNodes.map((n) => ({ id: n.relatedNodeId, layer: n.layer, name: n.name, content: String(n.content || ""), similarity: n.similarity, relatedTo: n.pathNodeId })),
              scannedExisting: allExistingNodes.length,
              policy: `path + global top-1 EXISTING (sim>=${existingSimilarityFloor}) + global top-1 RELATED (sim>=0.05)`,
            },
            parsed: { reward: result.reward, rationale: result.rationale, nodeUpdateIds: Object.keys(result.node_updates || {}), addNodes: (result.add_nodes || []).map((n: any) => ({ layer: n.layer, name: n.name })), nodeActions: (result.node_actions || []).map((a: any) => ({ action: a.action, source: a.source, target: a.target, node: a.node, rationale: a.rationale })) },
            // 全量输出原文(含 node_updates/add_nodes 的完整 content)，供统一轨迹原文审查
            parsedFull: result,
          };
          const logDir = path.join(net.path, "_sb_logs");
          ensureDir(logDir);
          rolloverLogBySize(path.join(logDir, "semantic_backward.jsonl"), 4);
          fs.appendFileSync(path.join(logDir, "semantic_backward.jsonl"), JSON.stringify(logEntry) + "\n", "utf-8");
          // 统一轨迹: backward 输入输出与对话同写 _trajectories.jsonl(kind:"backward", turnId 关联对话行)
          appendTrajectoryLine({ kind: "backward", turnId: turnId || null, ...logEntry });
        } catch (e) {
          console.error(`[textron] semantic_backward.jsonl write failed: ${(e as Error).message}`);
        }
        recordMonitorEvent({
          type: "trace",
          action: "semantic_backward_llm_done",
          status: "ok",
          taskFamily: path.basename(net.path),
          mode: label,
          reward: result.reward,
          rationale: result.rationale || "",
          nodeUpdateIds: Object.keys(result.node_updates || {}),
          addNodeCount: (result.add_nodes || []).length,
          durationMs: Date.now() - sbStartedMs,
        });
        return result;
      } catch (e) {
        const err = `${label}: ${(e as Error).message}`;
        errors.push(err);
        recordMonitorEvent({ type: "trace", action: "semantic_backward_llm_attempt_failed", taskFamily: path.basename(net.path), mode: label, error: preview(err, 300), durationMs: Date.now() - sbStartedMs });
      }
    }
    log(`Textron semantic backward LLM failed (${errors.join(" | ")})`);
    recordMonitorEvent({ type: "trace", action: "semantic_backward_llm_done", status: "failed", taskFamily: path.basename(net.path), errors: errors.map((e) => preview(e, 300)), durationMs: Date.now() - sbStartedMs });
    // 轨迹原文完整性: 失败也落 kind:"backward" 行(输入原文+逐 attempt 错误+耗时), 供 8766 轨迹直接排查
    try {
      appendTrajectoryLine({
        kind: "backward", turnId: turnId || null, ts: new Date().toISOString(),
        taskFamily: path.basename(net.path), mode: "failed_all_attempts", status: "failed",
        model: model?.id,
        errors: errors.map((x) => String(x).slice(0, 500)),
        durationMs: Date.now() - sbStartedMs,
        systemPrompt: messages[0].content,
        userPrompt: messages[1].content,
        nodeInput: {
          path: pathNodes.map((n) => ({ id: n.id, layer: n.parsed?.layer ?? null, name: n.name, content: String(n.content || ""), virtual: !!n.isVirtual })),
          existing: shownExisting.map((n) => ({ id: n.key, layer: n.layer, name: n.name, content: String(n.content || "") })),
          related: relatedNodes.map((n) => ({ id: n.relatedNodeId, layer: n.layer, name: n.name, content: String(n.content || "") })),
          scannedExisting: allExistingNodes.length,
        },
        parsed: { reward: 0, rationale: "semantic backward failed", attemptsFailed: errors.length },
      });
    } catch { /* 忽略 */ }
    return { reward: 0, rationale: "semantic backward failed" };
  }

  function buildHighEntropyFallbackNodeUpdate(
    previousAssistantHighEntropy: string,
    activatedIds: string[],
  ): Record<string, { name: string; content: string }> | undefined {
    const crystal = parseHighEntropyCrystal(previousAssistantHighEntropy ? `<HighEntropy>${previousAssistantHighEntropy}</HighEntropy>` : "");
    const clean = (crystal.ok ? crystal.content : previousAssistantHighEntropy).replace(/\s+/g, " ").trim();
    if (!clean || isNgramFragmentContent(clean)) return undefined;

    const parsedPath = activatedIds
      .map((id) => ({ id, parsed: parseLayerNodeId(id) }))
      .filter((x) => x.parsed !== null) as { id: string; parsed: { layer: number; nodeId: string } }[];
    if (parsedPath.length === 0) return undefined;

    // Extract differentiated facets from HighEntropy instead of same-string truncation.
    // L0: compact entropy symbol / abstract domain signal
    // L1: causal/tradeoff relationship — why it matters
    // L2: concrete action/tactic — how to apply it
    function extractFacet(text: string, layer: number): string {
      const s = text.trim();
      // Helper: extract first N complete sentences (or all up to maxLen)
      function firstSentences(t: string, maxLen: number): string {
        if (t.length <= maxLen) return t;
        // Try cutting at first sentence boundary within maxLen
        const ends = [t.indexOf("。", 0), t.indexOf(". ", 0), t.indexOf("! ", 0), t.indexOf("? ", 0)]
          .filter(i => i > 0 && i < maxLen);
        if (ends.length > 0) {
          const cut = Math.max(...ends);
          return t.slice(0, cut + (t[cut] === "。" || t[cut] === "." || t[cut] === "!" || t[cut] === "?" ? 1 : 0)).trim();
        }
        return completeContent(t, maxLen);
      }
      if (layer === 0) {
        // L0: extract key domain words / trigger signal (≤48 chars, complete)
        const words = s.split(/[\s,，。！？、:：;；]+/).filter(w => w.length > 2 && !/^(the|and|for|with|from|that|this|when|then|also|just|very|each|some|\d+)$/i.test(w));
        const key = words.slice(0, 4).join(" ");
        return completeContent(key || s, 48);
      } else if (layer === 1) {
        // L1: extract causal/tradeoff signal (≤100 chars)
        const tradeoffMatch = s.match(/([^。.!?]{0,100}(?:→|->|=>|vs|权衡|取舍|因为|所以|avoid|prefer|should|must)[^。.!?]{0,60})/i);
        return tradeoffMatch
          ? completeContent(tradeoffMatch[1].trim(), 100)
          : firstSentences(s, 100);
      } else {
        // L2: extract concrete tactic/action (≤120 chars, complete sentence)
        const tacticMatch = s.match(/([^。.!?]{0,120}(?:use|set|apply|run|call|configure|replace|switch|check|add|fix|patch|使用|设置|调用|替换|修复|添加|检查|配置)[^。.!?]{0,80})/i);
        return tacticMatch
          ? completeContent(tacticMatch[1].trim(), NODE_CONTENT_MAX_CHARS)
          : firstSentences(s, 120);
      }
    }

    parsedPath.sort((a, b) => a.parsed.layer - b.parsed.layer);
    const updates: Record<string, { name: string; content: string }> = {};
    for (const p of parsedPath) {
      const facet = extractFacet(clean, p.parsed.layer);
      if (!facet || isNgramFragmentContent(facet)) continue;
      const name = p.parsed.layer === 0 && crystal.ok ? crystal.name : compressNodeName(facet);
      updates[p.id] = { name: completeContent(name, 64), content: facet };
    }
    return Object.keys(updates).length > 0 ? updates : undefined;
  }

  function buildHighEntropyAddCandidate(
    previousAssistantHighEntropy: string,
    activatedIds: string[],
  ): { layer: number; name: string; content: string } | undefined {
    const crystal = parseHighEntropyCrystal(previousAssistantHighEntropy ? `<HighEntropy>${previousAssistantHighEntropy}</HighEntropy>` : "");
    const content = (crystal.ok ? crystal.content : previousAssistantHighEntropy).replace(/\s+/g, " ").trim();
    if (!content || isNgramFragmentContent(content)) return undefined;
    const parsedLayers = activatedIds.map(parseLayerNodeId).filter(Boolean) as { layer: number; nodeId: string }[];
    const targetLayer = parsedLayers.length ? parsedLayers.reduce((m, p) => Math.max(m, p.layer), 0) : undefined;
    return {
      // Empty forward path means neutral novel-topic routing: create a new L0 anchor.
      layer: targetLayer ?? 0,
      name: crystal.ok ? crystal.name : compressNodeName(content),
      content,
    };
  }

  /**
   * HighEntropy <Function> 硬落盘（引用链不依赖 LLM 自觉）。
   * 背景：functionBlock 原先只在反传 prompt 输入侧被消费，LLM 实测只写自然语言 node_updates，
   * 导致 functionSymbol 无落盘通路、前向注入无从引用。此函数把本轮函数产物落进网络节点：
   * ① <function symbol=..> 块（readNodeFunction 可读，独立于 content 1000 上限）；
   * ② 节点 content 缺 functionSymbol 字面时追加 [fn:symbol] 兜底（保 substring 引用链）。
   * 目标节点 = 本轮实际更新的最浅层节点；无更新则不写（宁缺勿错）。
   */
  // 2026-09-14 (n8 验证轮 guard 实证): 原实现把 <Function> 提取写成 semanticBackwardLLM 内的
  // 局部 const，forcedSemanticBackward 又在 2952 行直接引用它 → ReferenceError: functionBlock
  // is not defined → 反传整轮 status=failed 且 Function 从未落盘。抽成同层单一事实来源，
  // 任何调用点都不得再跨函数引用该局部变量。
  function extractFunctionBlock(highEntropy: string | undefined): string {
    return String(highEntropy || "").match(/<Function>\s*([\s\S]*?)\s*<\/Function>/i)?.[1]?.trim().slice(0, 1500) || "";
  }

  function persistHighEntropyFunction(
    net: NonNullable<ReturnType<typeof loadNetwork>>,
    functionBlock: string | undefined,
    nodeUpdates: Record<string, string | { name?: string; content?: string; context?: string }> | undefined,
    taskFamily: string,
  ): { symbol: string; nodeId: string; contentAppended: boolean } | undefined {
    const raw = String(functionBlock || "").trim();
    if (!raw) return undefined;
    const symbol = (raw.match(/functionSymbol\s*[:：]\s*`?([A-Za-z_][A-Za-z0-9_]*)`?/) || [])[1] || "";
    // 2026-09-15（手动编码更正）：**删除词表域闸**。工程词汇黑名单是「规则」不是「机制」：
    // ①与领域无关——交易函数只要注释里出现「反传」「node_0」就被静默拒写（实测 8 例 2 例假阳性）；
    // ②不可训练不可收敛——网络无法从词表学到任何东西，行为只随人改词表而变；
    // ③合法判据已存在且由 LLM 承担：反传内部 goal guard + keep/drop/merge、写入前置比较与版本化；
    //   LLM 语义判据(FUSION keep/drop/merge 三段式 + node_actions)、写入前置比较与 _node_history 版本化。
    // 故此处只保留结构不变量（长度上限、symbol 合法性），不做任何词汇判定。
    const code = raw.slice(0, 8000).trim();   // 原 1200c 会把函数体截肢（节点里实测的断码来源）
    if (!code) return undefined;
    // symbol 解析失败宁可早退：写无 symbol 的 <function> 块会让前向 ⟨fn:σ⟩ 永不命中，
    // 形成「看似落盘、引用链仍断」的假达标（审计 A 项硬要求 symbol 非空）。
    if (!symbol) {
      recordMonitorEvent({ type: "trace", action: "highentropy_function_skipped", taskFamily, reason: "symbol_parse_failed", functionBlockChars: raw.length });
      return undefined;
    }
    const candidates = Object.keys(nodeUpdates || {})
      .map((key) => ({ key, parsed: parseLayerNodeId(key) }))
      .filter((x) => !!x.parsed)
      .sort((a, b) => (a.parsed!.layer - b.parsed!.layer));
    const target = candidates[0];
    if (!target) {
      recordMonitorEvent({ type: "trace", action: "highentropy_function_skipped", taskFamily, reason: "no_node_updates", symbol });
      return undefined;
    }
    const p = target.parsed!;
    const fp = path.join(net.path, `layer_${p.layer}`, `${p.nodeId}.html`);
    if (!fs.existsSync(fp)) return undefined;
    let contentAppended = false;
    const content = readNodeContent(fp);
    if (symbol && !content.includes(symbol)) {
      const suffix = ` [fn:${symbol}]`;
      const room = NODE_CONTENT_MAX_CHARS > 0 ? NODE_CONTENT_MAX_CHARS - suffix.length : Number.MAX_SAFE_INTEGER;
      if (room > 0) {
        const outEdges = (net.weights.layer_connections[`${p.layer}_to_${p.layer + 1}`] || [])
          .filter((e) => e.from === p.nodeId).map((e) => ({ toId: e.to, weight: e.weight }));
        writeNodeHtml(fp, p.layer, p.nodeId, content.slice(0, room) + suffix, outEdges, readNodeName(fp) || compressNodeName(content));
        contentAppended = true;
      }
    }
    // 2026-09-15 n8 第十四轮：块落盘若触发每节点上限淘汰（NODE_FN_BLOCK_MAX=2），**不再静默**——
    // 记 error 级 fn_block_evicted（含被淘汰 symbol、是否已在 content 里悬空引用）。
    // 实证：本轮 6 次 highentropy_function_persisted 仅 3 块存活，其余 3 块（guard_dispatch_constraint_passthrough /
    // resistance_reject_exposure_trim / relay_agent_message_with_idempotency）消失时监控侧无任何事件。
    writeNodeFunction(fp, symbol, code, {
      onEvicted: (evicted) => {
        try {
          const content = readNodeContent(fp) || "";
          recordMonitorEvent({
            type: "error", action: "fn_block_evicted",
            taskFamily, nodeId: target.key, symbol,
            evicted, evictedCount: evicted.length, maxBlocks: NODE_FN_BLOCK_MAX,
            codeChars: code.length,
            dangling: evicted.filter((s) => content.includes(`[fn:${s}]`)),
          });
        } catch { /* 观测失败不影响落盘 */ }
      },
    });
    recordMonitorEvent({ type: "trace", action: "highentropy_function_persisted", taskFamily, nodeId: target.key, symbol, contentAppended, codeChars: code.length });
    return { symbol, nodeId: target.key, contentAppended };
  }

  /**
   * 网络目标（goal）驱动的「离域清洗候选」计算 —— 单一事实来源，两处复用：
   * ① semanticBackwardLLM：把候选推进 prompt，让 LLM 看见并决定重写什么（看不见就改不掉）；
   * ② applySemanticNodeUpdates：把候选标为 forceOverwrite，让落盘走 replace 而非 merge 拼接。
   * 排序：goal 相关性升序（L0 优先）—— L0 是路由锚点，离域 L0 比离域 L2 伤害大得多。
   */
  function goalCleanseTargets(net: NonNullable<ReturnType<typeof loadNetwork>>, limit = 4) {
    const goal = readNetworkGoal(path.basename(net.path));
    const targets: { key: string; layer: number; name: string; content: string; goalSim: number }[] = [];
    let scanned = 0;
    if (!goal) return { goal, targets, scanned };
    let simMap = new Map<string, number>();
    try { simMap = tfidfSimilarity(net, goal, ""); } catch { simMap = new Map(); }
    // 2026-09-15：删除两个手写词表（ENGINEERING_RE / DOMAIN_RE）。词表是规则不是机制：
    // 不可训练、与领域无关、且两条判据互相打架（越像真领域知识越可能命中 DOMAIN_RE 被豁免，
    // 越是工程语料越可能因 goalSim 低被选中）。实测 TF-IDF goalSim 判别力本就弱（真交易节点
    // 0.0087 vs 工程节点 ~0.01）⇒ 词面相似度不足以承担「谁是好知识」的判断。
    // 现在分工：**LLM 是唯一语义判据**（同时看到 goal、节点内容、轨迹，按 keep/drop/merge 三段式
    // 给理由并落盘 node_actions）；程序侧只保留结构性不变量。本函数退化为「把网络内容按 goalSim
    // 升序摆给 LLM 看」，不再驱动任何强制覆写。
    for (let l = 0; l < net.hyperparams.layers.length; l++) {
      for (let n = 0; n < net.hyperparams.layers[l]; n++) {
        const np = path.join(net.path, `layer_${l}`, `node_${n}.html`);
        const c = readNodeContent(np);
        if (!String(c || "").trim()) continue;
        scanned++;
        // 工程域病态节点才入清理名单；含领域特征词（真交易/交易判据）一律豁免。
        const text = stripFunctionBlocks(String(c));
        // （原词表判定已删除：候选一律摆给 LLM，由 LLM 判 keep/drop/merge）
        const key = `L${l}::node_${n}`;
        targets.push({ key, layer: l, name: readNodeName(np) || compressNodeName(c), content: c, goalSim: Number((simMap.get(key) || 0).toFixed(4)) });
      }
    }
    targets.sort((a, b) => (a.goalSim - (a.layer === 0 ? 0.02 : 0)) - (b.goalSim - (b.layer === 0 ? 0.02 : 0)));
    return { goal, targets: targets.slice(0, limit), scanned };
  }

  function applySemanticNodeUpdates(net: NonNullable<ReturnType<typeof loadNetwork>>, updates: Record<string, string | { name?: string; content?: string; context?: string }> | undefined, onLog: (msg: string) => void, opts?: { forceOverwrite?: Set<string> }) {
    const forceOverwrite = opts?.forceOverwrite || new Set<string>();
    const result: {
      updated: number;
      skipped: number;
      skipReasons: string[];
      changedNodes: { id: string; layer: number; nodeId: string; oldName: string; newName: string; oldContent: string; newContent: string }[];
      nodeMutations: { type: "update" | "add" | "merge" | "delete"; id: string; source?: string; target?: string }[];
    } = { updated: 0, skipped: 0, skipReasons: [], changedNodes: [], nodeMutations: [] };
    let nodesAdded = 0;
    if (!updates) return result;

    for (const [id, update] of Object.entries(updates)) {
      const parsed = parseLayerNodeId(id);
      if (!parsed) {
        result.skipped++;
        result.skipReasons.push(`${id}:bad_node_id`);
        continue;
      }
      // ── Guard: refuse to write virtual cold-start nodes to disk ──
      if (parsed.nodeId.startsWith("_seed_") || parsed.nodeId.startsWith("_cold_")) {
        result.skipped++;
        result.skipReasons.push(`${id}:virtual_seed_not_writable`);
        onLog(`Textron semantic backward: skipped virtual node ${id} — SEED content must be materialized via add_nodes`);
        continue;
      }
      const nodePath = path.join(net.path, `layer_${parsed.layer}`, `${parsed.nodeId}.html`);
      const oldContent = readNodeContent(nodePath);
      const oldName = readNodeName(nodePath);
      const oldIsArtifact = isNgramFragmentContent(oldContent);
      const content = typeof update === "string"
        ? update
        : String(update.content || update.context || oldContent || "").trim();
      const validation = validateKnowledgeCrystal(content, parsed.layer);
      if (!validation.ok) {
        // Scale-rescue: rejection = wrong scale, not garbage (Wang–Zahl).
        const rescue = rescaleRejectedCrystal(net, content, validation.reason, parsed.layer, onLog, addPolicyNode, recordArtifactEvent);
        result.skipped++;
        result.skipReasons.push(`${id}:${validation.reason}${rescue ? `→rescale:${rescue.action}` : ""}`);
        onLog(`Textron semantic backward: skipped node update ${id} (${validation.reason})${rescue?.rescued ? ` [rescued:${rescue.action} → L${rescue.layer}::${rescue.nodeId}]` : ""}`);
        continue;
      }

      const isCleanse = forceOverwrite.has(id) || forceOverwrite.has(`L${parsed.layer}::${parsed.nodeId}`);
      const similar = oldIsArtifact || isCleanse   // 清洗写入绕过相似合并：否则会被并进另一个（离域）节点，清洗失效
        ? null
        : findSimilarKnowledgeNode(net, compressNodeName(validation.content), validation.content, 0.40, parsed.layer, parsed.nodeId);
      if (similar) {
        const similarId = `L${similar.layer}::${similar.nodeId}`;
        const similarPath = path.join(net.path, `layer_${similar.layer}`, `${similar.nodeId}.html`);
        const similarOldContent = readNodeContent(similarPath);
        const similarOldName = readNodeName(similarPath);
        updateExistingNodeByPolicy(net, similar.layer, similar.nodeId, compressNodeName(validation.content), validation.content, onLog);
        result.changedNodes.push({
          id: similarId,
          layer: similar.layer,
          nodeId: similar.nodeId,
          oldName: preview(similarOldName, 100),
          newName: preview(readNodeName(similarPath), 100),
          oldContent: preview(similarOldContent, 220),
          newContent: preview(readNodeContent(similarPath), 220),
        });
        result.nodeMutations.push({ type: "merge", id: similarId, source: id, target: similarId });
        result.updated++;
        onLog(`Textron semantic backward: merged duplicate update ${id} into ${similarId} (${(similar.score*100).toFixed(0)}%)`);
        continue;
      }

      const name = typeof update === "string"
        ? compressNodeName(update)
        : String(update.name || oldName || compressNodeName(validation.content)).trim();
      const edgeKey = `${parsed.layer}_to_${parsed.layer + 1}`;
      const outEdges = (net.weights.layer_connections[edgeKey] || [])
        .filter((e) => e.from === parsed.nodeId)
        .map((e) => ({ toId: e.to, weight: e.weight }));
      const newContent = applyContentLimit(validation.content);
      // ── 写入前置比较（2026-09-15）── 覆写不再无条件生效，也不再由名单决定：只做「新 vs 旧」
      // 的相对比较。判据 = 网络自身 goal 与**剥离 <function> 块后正文**的词面相关度(lexicalRelevance)：
      // 新明显更低 ⇒ 拒写（旧内容保留，_node_history 有副本可回滚）；略低 ⇒ 降级为融合（旧要点不丢）。
      // 此处不引入任何词表、不引入绝对阈值。
      let forcedReplace = isCleanse;
      if (newContent && oldContent.trim()) {
        const _g = readNetworkGoal(path.basename(net.path));
        const _sOld = lexicalRelevance(_g, stripFunctionBlocks(oldContent));
        const _sNew = lexicalRelevance(_g, stripFunctionBlocks(newContent));
        if (_sNew < _sOld * 0.85) {
          result.skipped++;
          result.skipReasons.push(`${id}:retention_new_worse`);
          recordMonitorEvent({ type: "trace", action: "node_write_refused_keep_better", id, scoreOld: Number(_sOld.toFixed(4)), scoreNew: Number(_sNew.toFixed(4)), oldChars: oldContent.length, newChars: newContent.length });
          onLog(`Textron backward: refused overwrite of ${id} — new less goal-relevant (${_sNew.toFixed(4)} < ${_sOld.toFixed(4)}); old kept (versioned)`);
          continue;
        }
        if (_sNew < _sOld) {
          forcedReplace = false;
          onLog(`Textron backward: downgraded overwrite of ${id} to merge — new not better (${_sNew.toFixed(4)} < ${_sOld.toFixed(4)})`);
        }
      }
      // isCleanse（网络目标驱动的离域清洗）：**真覆盖**，不与旧内容/旧名拼接。
      // 拼接会把两个域焊成关键词垃圾抽屉（实测："layerCaps存活数硬闸… | 成功经验（sz.301299…）"），
      // 且旧名残留会让 Name 子串路由继续把工程回合路由到交易节点。
      let mergedContent = forcedReplace
        ? newContent
        : (oldIsArtifact ? completeContent(newContent, NODE_CONTENT_MAX_CHARS) : mergeContent(oldContent, newContent));
      // 写入宽: NODE_CONTENT_MAX_CHARS=0（不限）时不再触发溢出拆分，融合内容完整留在本节点。
      // 仅在显式配置了正上限时才走溢出→新节点分流。
      const contentLimit = NODE_CONTENT_MAX_CHARS > 0 ? NODE_CONTENT_MAX_CHARS : Number.MAX_SAFE_INTEGER;
      if (!isCleanse && mergedContent.length > contentLimit) {
        const overflow = mergedContent.slice(contentLimit);
        mergedContent = mergedContent.slice(0, contentLimit);
        const overflowResult = addDynamicNode(net, parsed.layer, overflow, onLog, compressNodeName(overflow));
        if (overflowResult.added) {
          nodesAdded++;
          result.nodeMutations.push({ type: "add", id: `L${parsed.layer}::node_${overflowResult.nodeId}` });
          onLog(`Textron autoBackward: update overflow ${overflow.length}c → new node L${parsed.layer}::node_${overflowResult.nodeId}`);
        }
      }
      if (oldContent && mergedContent !== newContent) {
        onLog(`Textron semantic backward: merged node ${id} (old=${oldContent.length}c new=${newContent.length}c → ${mergedContent.length}c)`);
      } else if (isCleanse && oldContent) {
        onLog(`Textron semantic backward: CLEANSED node ${id} (goal-directed overwrite: ${oldContent.length}c → ${mergedContent.length}c, old name dropped)`);
      }
      // Merge name: distill old name keywords + new name keywords, not full replace
      // （清洗模式例外：旧名是离域名残留，必须丢弃）
      const llmProposedName = typeof update === "string" ? compressNodeName(update) : (update.name || "");
      const mergedNameRaw = isCleanse
        ? (llmProposedName || compressNodeName(mergedContent))
        : (llmProposedName && oldName
          ? distillNodeName(`${oldName} ${llmProposedName}`, 64)
          : (llmProposedName || compressNodeName(mergedContent)));
      const mergedName = mergedNameRaw.slice(0, 64);
      writeNodeHtml(nodePath, parsed.layer, parsed.nodeId, mergedContent, outEdges, mergedName);
      result.changedNodes.push({
        id,
        layer: parsed.layer,
        nodeId: parsed.nodeId,
        oldName: preview(oldName, 100),
        newName: preview(mergedName, 100),
        oldContent: preview(oldContent, 220),
        newContent: preview(mergedContent, 220),
      });
      result.nodeMutations.push({ type: oldContent ? "update" : "add", id });
      if (oldIsArtifact) {
        recordArtifactEvent({
          type: "update",
          action: "node_artifact_repaired_by_backward",
          taskFamily: path.basename(net.path),
          nodeId: id,
          oldContent: preview(oldContent, 180),
          newContent: preview(mergedContent, 180),
        });
      }
      result.updated++;
    }
    if (result.updated > 0) {
      onLog(`Textron semantic backward: ${result.updated} selected node content update(s)`);
      for (const ch of result.changedNodes.slice(0, 8)) {
        onLog(`Textron semantic backward node ${ch.id}: "${ch.oldContent}" -> "${ch.newContent}"`);
      }
    }
    return result;
  }

  // ─── Expanded Auto Backward: edges + node CRUD in one pass ───────────
  // Replaces old edge-only autoBackward(). Handles weight updates AND
  // node content create/update/merge based on the single LLM call's output.
  function autoBackward(
    net: NonNullable<ReturnType<typeof loadNetwork>>,
    activatedIds: string[],
    reward: number,
    onLog: (msg: string) => void,
    selectedEdgeIds: string[] = [],
    edgeRewards?: Map<string, number>,
    nodeUpdates?: Record<string, string | { name?: string; content?: string; context?: string }>,
    addNodes?: { layer: number; name?: string; content: string }[],
    nodeActions?: { action: "merge" | "delete" | "keep"; source?: string; target?: string; node?: string; rationale?: string }[],
  ): {
    changes: number; changedEdges: string[];
    nodesUpdated: number; nodesAdded: number; nodesMerged: number; nodesDeleted: number; nodesSkipped: number;
    nodeSkipReasons: string[];
    changedNodes: { id: string; layer: number; nodeId: string; oldName: string; newName: string; oldContent: string; newContent: string }[];
    nodeMutations: { type: "update" | "add" | "merge" | "delete"; id: string; source?: string; target?: string }[];
  } {
    // ── Update node stats (success/failure for battle records) ──
    (() => {
      const statsP = path.join(net.path, "_node_stats.json");
      const stats = readJson<Record<string, { success: number; failure: number; lastActivated: string }>>(statsP, {});
      for (const nid of activatedIds) {
        if (!stats[nid]) stats[nid] = { success: 0, failure: 0, lastActivated: "" };
        stats[nid].lastActivated = new Date().toISOString();
        if (reward > 0.1) stats[nid].success++;
        else if (reward < -0.3) stats[nid].failure++;
      }
      writeJson(statsP, stats);
    })();

    // ── Edge weight updates ──
    const lr = net.hyperparams.learningRate;
    const activeEdgeSet = new Set<string>();
    for (const edgeId of selectedEdgeIds) {
      const key = selectedEdgeIdToWeightKey(edgeId);
      if (key) activeEdgeSet.add(key);
    }
    if (activeEdgeSet.size === 0 && activatedIds.length > 1) {
      const parsedPath = activatedIds
        .map((id) => ({ raw: id, parsed: parseLayerNodeId(id) }))
        .filter((x) => x.parsed !== null) as { raw: string; parsed: { layer: number; nodeId: string } }[];
      parsedPath.sort((a, b) => a.parsed.layer - b.parsed.layer);
      for (let i = 0; i < parsedPath.length - 1; i++) {
        const a = parsedPath[i].parsed;
        const b = parsedPath[i + 1].parsed;
        if (b.layer === a.layer + 1) activeEdgeSet.add(`${a.layer}_to_${b.layer}:${a.nodeId}:${b.nodeId}`);
      }
    }

    let changes = 0;
    const changedEdges: string[] = [];
    if (activeEdgeSet.size > 0) {
      // 三层架构: 训练只写经验层 ledger 的 delta, 物化视图随后重建(每 pair 唯一,无重复边)
      for (const eid of activeEdgeSet) {
        const edgeR = edgeRewards?.get(eid) ?? reward;
        const r = trainPair(net, eid, edgeR, lr);
        if (r) {
          changes++;
          changedEdges.push(`${eid}:${r.old.toFixed(4)}->${r.next.toFixed(4)}(n=${r.n})`);
        }
      }
      if (changes > 0) {
        materialize(net);
        writeJson(path.join(net.path, "weights.json"), net.weights);
        // 2026-08-19 统一收口: 边权重变更后立即刷新受影响节点 HTML link (账货一致)
        try {
          const affected = new Set<string>();
          for (const ce of changedEdges) {
            const parts = ce.split(":");
            if (parts.length >= 3) {
              const [fromL, toL] = parts[0].split("_to_").map(Number);
              if (!Number.isNaN(fromL) && parts[1].startsWith("node_")) affected.add(`${fromL}:${parts[1]}`);
              if (!Number.isNaN(toL) && parts[2] && parts[2].startsWith("node_")) affected.add(`${toL}:${parts[2]}`);
            }
          }
          for (const af of affected) {
            const [l, nid] = af.split(":");
            commitNodeHtmlEdges(net, Number(l), nid);
          }
          if (affected.size > 0) onLog(`Textron backward: refreshed HTML edges for ${affected.size} affected node(s)`);
        } catch (e) {
          console.error(`[textron] refresh HTML edges after backward failed:`, e);
        }
        onLog(`Textron backward: ${changes} selected edge(s) updated (reward=${reward.toFixed(3)}) for "${path.basename(net.path)}"`);
      }
      // Negative reward: lightly penalize ALL edges connected to activated nodes
      if (reward < 0 && activatedIds.length > 0) {
        const activatedNodeKeys = new Set<string>();
        for (const id of activatedIds) {
          const parsed = parseLayerNodeId(id);
          if (parsed) activatedNodeKeys.add(parsed.nodeId);
        }
        let extraChanges = 0;
        for (const [sec, edges] of Object.entries(net.weights.layer_connections)) {
          for (const edge of edges) {
            if (!(activatedNodeKeys.has(edge.from) || activatedNodeKeys.has(edge.to))) continue;
            const eid = `${sec}:${edge.from}:${edge.to}`;
            if (activeEdgeSet.has(eid)) continue;
            const r = trainPair(net, eid, -Math.abs(reward) * 0.3, lr);
            if (r) {
              extraChanges++;
              changedEdges.push(`${eid}:${r.old.toFixed(4)}->${r.next.toFixed(4)} [noise_penalty]`);
            }
          }
        }
        if (extraChanges > 0) {
          materialize(net);
          writeJson(path.join(net.path, "weights.json"), net.weights);
          // 2026-08-19 统一收口: 负奖励惩罚边后同样刷新受影响节点 HTML link
          try {
            const affected = new Set<string>();
            for (const ce of changedEdges) {
              const parts = ce.split(":");
              if (parts.length >= 3) {
                const [fromL, toL] = parts[0].split("_to_").map(Number);
                if (!Number.isNaN(fromL) && parts[1].startsWith("node_")) affected.add(`${fromL}:${parts[1]}`);
                if (!Number.isNaN(toL) && parts[2] && parts[2].startsWith("node_")) affected.add(`${toL}:${parts[2]}`);
              }
            }
            for (const af of affected) {
              const [l, nid] = af.split(":");
              commitNodeHtmlEdges(net, Number(l), nid);
            }
          } catch { /* 忽略 */ }
          onLog(`Textron backward: ${extraChanges} extra connected-edge(s) penalized (noise suppression) for "${path.basename(net.path)}"`);
        }
      }
    }

    // ── Node content updates ──
    // 网络目标驱动的离域清洗：候选节点的写入必须走 replace（覆盖），而非 merge（拼接）。
    // 否则「把工程知识更新掉」会被引警退化为「工程+交易 拼接」，越洗越脏。
    const cleanseInfo = goalCleanseTargets(net, 8);
    // 2026-09-15：不再把候选名单当 forceOverwrite —— 「程序侧强制覆写」正是抹掉好知识的直接通道
    // （候选名单一旦错选，真领域知识必被硬替换）。清洗改由 LLM 显式决策，程序只做相对保留闸门。
    const cleanseTargets = new Set<string>();
    const nodeResult = applySemanticNodeUpdates(net, nodeUpdates, onLog, { forceOverwrite: cleanseTargets });
    const nodeMutations = [...nodeResult.nodeMutations];
    if (cleanseInfo.goal) {
      recordMonitorEvent({
        type: "trace",
        action: "semantic_backward_goal_cleanse",
        taskFamily: path.basename(net.path),
        goal: cleanseInfo.goal,
        cleanseTargets: [...cleanseTargets],
        cleansedNodes: nodeResult.nodeMutations
          .filter((m) => m.type === "update" && cleanseTargets.has(m.id))
          .map((m) => m.id),
        nodeUpdatesKeys: Object.keys(nodeUpdates || {}),
      });
    }

    // ── Node additions ──
    let nodesAdded = 0, nodesMerged = 0, nodesAddSkipped = 0;
    const addSkipReasons: string[] = [];
    for (const node of addNodes || []) {
      const validation = validateKnowledgeCrystal(node.content, node.layer);
      if (!validation.ok) {
        // Scale-rescue: rejection = wrong scale, not garbage (Wang–Zahl).
        const rescue = rescaleRejectedCrystal(net, node.content, validation.reason, node.layer, onLog, addPolicyNode, recordArtifactEvent);
        nodesAddSkipped++;
        addSkipReasons.push(`L${node.layer}:${validation.reason}${rescue ? `→rescale:${rescue.action}` : ""}`);
        onLog(`Textron autoBackward: skipped add_node L${node.layer} (${validation.reason})${rescue?.rescued ? ` [rescued:${rescue.action} → L${rescue.layer}::${rescue.nodeId}]` : ""}`);
        continue;
      }
      const targetLayer = chooseExpansionLayer(net, node.layer);
      const nodeName = node.name || compressNodeName(validation.content);
      const similar = findSimilarKnowledgeNode(net, nodeName, validation.content, 0.40, targetLayer);
      if (similar) {
        dlog("GATE", `autoBackward: merged similar add_node (${nodeName.slice(0, 30)}) → L${similar.layer}::${similar.nodeId} (${(similar.score*100).toFixed(0)}%)`);
        updateExistingNodeByPolicy(net, similar.layer, similar.nodeId, nodeName, validation.content, onLog);
        nodesMerged++;
        nodeMutations.push({ type: "merge", id: `L${similar.layer}::${similar.nodeId}`, target: `L${similar.layer}::${similar.nodeId}` });
        continue;
      }
      const created = addPolicyNode(net, node.layer, validation.content, onLog, node.name, undefined, { mergeSimilar: true, similarityThreshold: 0.40 });
      const createdId = `L${created.layer}::${created.nodeId}`;
      if (created.added || created.replaced) { nodesAdded++; nodeMutations.push({ type: "add", id: createdId }); }
      else if (created.merged) { nodesMerged++; nodeMutations.push({ type: "merge", id: createdId, target: createdId }); }
      else if (created.skipped) { nodesAddSkipped++; addSkipReasons.push(`L${node.layer}:${created.reason || "frozen_skip"}`); }
    }

    // ── Node actions: merge / delete ──
    // GATE: only allow merge/delete when reward is non-trivial (real feedback present).
    // When reward≈0, the LLM has no real signal and fabricates merge/delete justifications.
    const mergeDeleteGate = Math.abs(reward) >= 0.05;
    if (!mergeDeleteGate && (nodeActions || []).length > 0) {
      onLog(`Textron autoBackward: blocked ${(nodeActions || []).length} merge/delete action(s) — reward=${reward.toFixed(3)} below gate threshold 0.05`);
    }
    let nodesDeleted = 0;
    // Track which nodes were emptied by merge in THIS backward pass.
    // Only these should be compacted — NOT pre-existing empty slots waiting for knowledge.
    const emptiedByMerge: { layer: number; nodeId: string }[] = [];
    for (const action of nodeActions || []) {
      if (action.action === "merge" && action.source && action.target && mergeDeleteGate) {
        const sp = parseLayerNodeId(action.source);
        const tp = parseLayerNodeId(action.target);
        if (!sp || !tp) continue;
        // GATE: refuse merge if source content is already empty (prevents double-compaction)
        const srcContent = readNodeContent(path.join(net.path, `layer_${sp.layer}`, `${sp.nodeId}.html`));
        if (srcContent?.trim().length === 0) {
          onLog(`Textron autoBackward: skipped merge ${action.source}→${action.target} — source already empty`);
          continue;
        }
        // 2026-09-04 抽象提升 merge: 放开同层限制, 支持 L2+L2→L1 / L1+L2→L1 / L1+L1→L0 / 含L0→L0。
        // 宿主定层+物理搬移+ledger资产重锚+物化重建 prior 边全部由 liftMergeNodes 承担。
        const lift = liftMergeNodes(net, { layer: sp.layer, nodeId: sp.nodeId }, { layer: tp.layer, nodeId: tp.nodeId }, onLog);
        if (!lift.merged) {
          onLog(`Textron autoBackward: merge ${action.source}→${action.target} skipped (${lift.reason || "unknown"})`);
          continue;
        }
        for (const em of lift.emptied) emptiedByMerge.push(em);
        nodesMerged++;
        nodeMutations.push({ type: "merge", id: `L${lift.hostLayer}::${lift.hostId}`, source: action.source, target: action.target, host: `L${lift.hostLayer}::${lift.hostId}` });
        if (lift.overflowNodeId) {
          nodesAdded++;
          nodeMutations.push({ type: "add", id: `L${lift.hostLayer}::${lift.overflowNodeId}` });
        }
        // 宿主内容已变 → 物化(lift 内)已重建 layer_connections, 刷宿主 html link(账→货一致)
        try { commitNodeHtmlEdges(net, lift.hostLayer, lift.hostId); } catch { /* 忽略 */ }
        onLog(`Textron autoBackward: lift-merged ${action.source} into ${action.target} → host L${lift.hostLayer}::${lift.hostId} (grafted=${lift.grafted} ledger, dropped=${lift.dropped})`);
      } else if (action.action === "delete" && action.node) {
        // BLOCKED: standalone delete is prohibited. Nodes must only be removed via merge (A→B, empty A).
        onLog(`Textron autoBackward: blocked standalone delete of ${action.node} — deletes only allowed via merge (source emptied after merge into target)${action.rationale ? ` (LLM rationale: ${action.rationale})` : ""}`);
      }
    }

    // Compact emptied nodes (merge-emptied sources) in this pass.
    // Previously compactEmptyNodes deleted ALL empty nodes including unfilled slots,
    // causing random-looking node loss across the network.
    const nodesCompacted = emptiedByMerge.length > 0
      ? compactMergeEmptiedNodes(net, onLog)
      : 0;
    // 2026-09-04: compact 重排了被吸收层的 nodeId → 物化一次刷新拓扑视图
    // (liftMergeNodes 已在 merge 时物化过; 此处仅为 compact 后的层索引变化收口)
    if (nodesCompacted > 0) {
      materialize(net);
      writeJson(path.join(net.path, "weights.json"), net.weights);
    }

    if (nodeResult.updated > 0 || nodesAdded > 0 || nodesMerged > 0 || nodesDeleted > 0 || nodesCompacted > 0) {
      net.hyperparams.updatedAt = new Date().toISOString();
      writeJson(path.join(net.path, "hyperparams.json"), net.hyperparams);
    }

    return {
      changes, changedEdges,
      nodesUpdated: nodeResult.updated, nodesAdded, nodesMerged, nodesDeleted: nodesDeleted + nodesCompacted,
      nodesSkipped: nodeResult.skipped + nodesAddSkipped,
      nodeSkipReasons: [...nodeResult.skipReasons, ...addSkipReasons],
      changedNodes: nodeResult.changedNodes,
      nodeMutations,
    };
  }

  async function forcedSemanticBackward(
    taskFamily: string,
    previousTask: string,
    previousAssistantHighEntropy: string,
    currentUserMessage: string,
    activatedIds: string[],
    selectedEdgeIds: string[],
    ctx: any,
    novelty?: { routeUncertain?: boolean; moeMaxScore?: number },
    turnId?: string,
  ) {
    const startedMs = Date.now();
    const startedAt = new Date(startedMs).toISOString();
    let net: ReturnType<typeof loadNetwork> = null;
    try { net = loadNetwork(taskFamily); } catch (e) { recordMonitorEvent({ type: "trace", action: "debug_backward_loadNetwork_failed", taskFamily, error: (e as Error).stack || (e as Error).message }); throw e; }
    if (!net) return null;
    let result: Awaited<ReturnType<typeof semanticBackwardLLM>>;
    try { result = await semanticBackwardLLM(net, previousTask, previousAssistantHighEntropy, currentUserMessage, activatedIds, ctx, turnId); } catch (e) { recordMonitorEvent({ type: "trace", action: "debug_backward_llm_failed", taskFamily, error: (e as Error).stack || (e as Error).message }); throw e; }

    // The LLM now judges path relevance itself via reward — no separate pathAudit needed.
    // Negative reward = LLM determined path was wrong/irrelevant.
    // shouldPreferAddNode: when user explicitly wants new concepts (regex match).
    const noForwardPath = activatedIds.length === 0 && selectedEdgeIds.length === 0;
    const noveltyDecision = decideNoveltyExpansion({
      routeUncertain: !!novelty?.routeUncertain,
      moeMaxScore: novelty?.moeMaxScore,
      reward: result.reward,
      selectedEdgeIds,
      hasHighEntropy: !!previousAssistantHighEntropy,
    });
    // When backward is triggered, the pairing judge already confirmed this IS feedback.
    // Always preserve LLM's directed node_updates when backward is running with real signal.
    const feedbackHasOutcome = true;
    const shouldPreferAddNode = !feedbackHasOutcome && (noveltyDecision.synthesizeL0Anchor || noForwardPath || /新增|add[_ -]?nodes?|new node|wrong-topic|跑题|偏题|不触发|覆盖|容量|novel/i.test(currentUserMessage));
    if (shouldPreferAddNode) {
      const originalUpdateIds = Object.keys(result.node_updates || {});
      const repairOnlyUpdates: typeof result.node_updates = {};
      for (const [id, update] of Object.entries(result.node_updates || {})) {
        const parsed = parseLayerNodeId(id);
        const nodePath = parsed ? path.join(net.path, `layer_${parsed.layer}`, `${parsed.nodeId}.html`) : "";
        const oldContent = parsed ? readNodeContent(nodePath) : "";
        if (isNgramFragmentContent(oldContent)) repairOnlyUpdates[id] = update;
      }
      if (originalUpdateIds.length !== Object.keys(repairOnlyUpdates).length) {
        result = { ...result, node_updates: repairOnlyUpdates };
        recordMonitorEvent({ type: "trace", action: "semantic_node_updates_suppressed_for_add_candidate", taskFamily, reason: noveltyDecision.synthesizeL0Anchor ? noveltyDecision.reason : "user_requested_new_concept", suppressedIds: originalUpdateIds.filter((id) => !Object.prototype.hasOwnProperty.call(repairOnlyUpdates, id)), preservedArtifactRepairIds: Object.keys(repairOnlyUpdates) });
      }
    }
    if (shouldPreferAddNode && previousAssistantHighEntropy) {
      const existingAdd = result.add_nodes || [];
      if (existingAdd.length === 0) {
        const candidate = buildHighEntropyAddCandidate(previousAssistantHighEntropy, activatedIds);
        if (!candidate) {
          recordMonitorEvent({ type: "trace", action: "semantic_add_node_synthesize_skip", taskFamily, reason: "invalid_highentropy", highEntropyPreview: preview(previousAssistantHighEntropy, 180) });
        } else {
          result = { ...result, add_nodes: [candidate] };
          recordMonitorEvent({ type: "trace", action: "semantic_add_node_synthesized", taskFamily, reason: noveltyDecision.synthesizeL0Anchor ? noveltyDecision.reason : "user_requested_new_concept", targetLayer: candidate.layer, contentPreview: preview(candidate.content, 180) });
        }
      }
    }
    // Cold-start bootstrap: no forward path + no previous HighEntropy → seed L0 anchor from current message
    if (noForwardPath && !previousAssistantHighEntropy && (result.add_nodes || []).length === 0) {
      const seedContent = applyContentLimit(currentUserMessage);
      const validation = validateKnowledgeCrystal(seedContent, 0);
      if (validation.ok) {
        const seedName = compressNodeName(validation.content).slice(0, 48);
        const seedNode = { layer: 0, name: seedName, content: validation.content };
        result = { ...result, add_nodes: [seedNode] };
        recordMonitorEvent({ type: "trace", action: "semantic_add_node_synthesized", taskFamily, reason: "cold_start_bootstrap", targetLayer: 0, contentPreview: preview(validation.content, 180) });
        log(`Textron semantic backward: cold-start bootstrap — seeded L0 anchor "${seedName}" from current message (no prior HighEntropy available)`);
      } else {
        recordMonitorEvent({ type: "trace", action: "semantic_add_node_synthesize_skip", taskFamily, reason: "cold_start_content_invalid", reasonDetail: validation.reason });
      }
    }

    // Use LLM's reward directly — no external credit adjustment.
    // Default tiny positive only when real edge path exists and LLM gave neutral reward.
    const effectiveReward = Math.abs(result.reward) < 0.001 ? (selectedEdgeIds.length > 0 ? 0.02 : 0) : result.reward;

    // ── Outcome signal gate: strip merge/delete when feedback lacks real outcome ──
    // Without an outcome signal (e.g. "收到", "继续"), the backward LLM fabricates
    // merge/delete justifications. Block these to prevent node drain.
    let gatedNodeActions = result.node_actions;
    if (!feedbackHasOutcome && gatedNodeActions && gatedNodeActions.length > 0) {
      const stripped = gatedNodeActions.filter(a => a.action !== "merge" && a.action !== "delete");
      if (stripped.length < gatedNodeActions.length) {
        log(`Textron semantic backward: stripped ${gatedNodeActions.length - stripped.length} merge/delete action(s) — feedback lacks outcome signal`);
        recordMonitorEvent({ type: "trace", action: "semantic_backward_merge_delete_stripped", taskFamily, reason: "no_outcome_signal", strippedCount: gatedNodeActions.length - stripped.length });
        gatedNodeActions = stripped;
      }
    }

    // Single unified backward: edges + node updates + node additions
    let bwResult: ReturnType<typeof autoBackward>;
    try { bwResult = autoBackward(net, activatedIds, effectiveReward, log, selectedEdgeIds, undefined, result.node_updates, result.add_nodes, gatedNodeActions); } catch (e) { recordMonitorEvent({ type: "trace", action: "debug_backward_autobackward_failed", taskFamily, error: (e as Error).stack || (e as Error).message }); throw e; }
    recordMonitorEvent({ type: "trace", action: "semantic_backward_apply", taskFamily, reward: effectiveReward, llmReward: result.reward, edgesUpdated: bwResult.changes, nodesUpdated: bwResult.nodesUpdated, nodesAdded: bwResult.nodesAdded, nodesMerged: bwResult.nodesMerged, nodesSkipped: bwResult.nodesSkipped, skipReasons: bwResult.nodeSkipReasons.slice(0, 8), changedNodes: bwResult.changedNodes, nodeMutations: bwResult.nodeMutations });

    // HighEntropy fallback: if no node update happened, synthesize from previous assistant
    let highEntropyFallbackNode = "";
    // 域闸轮禁止 fallback：这条通道用本轮 HE 合成 add_node，是离域污染最肥的入口之一
    // （本轮窗口实测 highentropy_fallback_add_candidate 3 次，均发生在任务离域时）。
    if (!result.off_domain && bwResult.nodesUpdated === 0 && previousAssistantHighEntropy) {
      const candidate = buildHighEntropyAddCandidate(previousAssistantHighEntropy, activatedIds);
      if (candidate) {
        // Re-run autoBackward with just this fallback add_node
        const fallbackResult = autoBackward(net, activatedIds, effectiveReward, log, selectedEdgeIds, undefined, undefined, [candidate]);
        bwResult.nodesAdded += fallbackResult.nodesAdded;
        bwResult.nodesMerged += fallbackResult.nodesMerged;
        bwResult.nodesSkipped += fallbackResult.nodesSkipped;
        bwResult.nodeMutations.push(...fallbackResult.nodeMutations);
        highEntropyFallbackNode = `add_candidate:L${candidate.layer}`;
        recordMonitorEvent({ type: "trace", action: "highentropy_fallback_add_candidate", taskFamily, targetLayer: candidate.layer, highEntropyPreview: preview(candidate.content, 180) });
      } else {
        recordMonitorEvent({ type: "trace", action: "highentropy_fallback_skip", taskFamily, reason: "invalid_or_empty_highentropy", activatedIds, hasHighEntropy: !!previousAssistantHighEntropy });
      }
    }

    // ── 2026-09-14 <Function> 硬落盘（引用链不依赖 LLM 自觉） ─────────────
    // 问题(guard n8 实证): functionBlock 仅在反传 prompt 输入侧被消费; LLM 实测只产出
    // node_updates 自然语言, 节点文件无 functionSymbol 字面 -> 可执行产物(网络 goal 明确
    // 要求的「可复用策略函数」)全部留在 _trajectories.jsonl 而没进网络, 前向注入也拿不到。
    // 修法: 反传结束后由系统兜底——①写 <function symbol=..> 块到本轮更新节点(独立于
    // content 1000 上限); ②若该节点 content 缺 functionSymbol 字面, 追加 [fn:symbol]
    // 保证引用链 substring 可命中; ③记事件供审计。
    // 隔离原则：审计/落盘插桩失败不得击穿反传主链（否则整轮 status=failed，
    // agent_pending 还会重放同一轨迹反传，污染收益口径 —— n8 验证轮实证）。
    let fnPersist: ReturnType<typeof persistHighEntropyFunction>;
    try {
      // 域闸轮同样禁止 Function 硬落盘：<Function> 块是「可执行产物」，一旦落盘就占节点函数槽
      // 并触发 NODE_FN_BLOCK_MAX=2 淘汰（本轮 4 次 fn_block_evicted 全部淘汰了交易域块）。
      fnPersist = result.off_domain
        ? undefined
        : persistHighEntropyFunction(net, extractFunctionBlock(previousAssistantHighEntropy), result.node_updates, taskFamily);
    } catch (e) {
      recordMonitorEvent({ type: "trace", action: "highentropy_function_persist_failed", taskFamily, error: (e as Error).message });
    }
    if (fnPersist) Object.assign(bwResult, { functionPersisted: fnPersist });

    // ── 2026-09-14 容量强制压缩轮: skip 不许静默 ─────────────────────────
    // 需求: 每层 cap 是硬不变量(任何路径含 merge 派生不得超容); 且满层/超容拒绝新增时
    // 不得静默 skip —— 把超容事实回喂 semanticBackwardLLM, 强制其产出压缩策略
    // (node_updates 折叠进已有节点 / merge 去重收缩), used 递减才收敛。上限 2 轮, 无进展即停。
    const netRef = net;
    const layerAliveCount = (l: number) => {
      let c = 0;
      for (let n = 0; n < netRef.hyperparams.layers[l]; n++) {
        if (readNodeContent(path.join(netRef.path, `layer_${l}`, `node_${n}.html`))) c++;
      }
      return c;
    };
    const overCapLayers = () => netRef.hyperparams.layers.map((_, l) => ({ layer: l, used: layerAliveCount(l), cap: layerCapFor(netRef.hyperparams, l) })).filter(s => s.used > s.cap);
    const buildCompressionMandate = (ocs: { layer: number; used: number; cap: number }[]) => {
      const layersText = ocs.length ? ocs.map(s => {
        const inv: string[] = [];
        for (let n = 0; n < netRef.hyperparams.layers[s.layer]; n++) {
          const np = path.join(netRef.path, `layer_${s.layer}`, `node_${n}.html`);
          const c = readNodeContent(np);
          if (!c) continue;
          inv.push(`    L${s.layer}::node_${n} [${readNodeName(np) || compressNodeName(c)}]: ${String(c).replace(/\s+/g, " ").trim().slice(0, 120)}`);
        }
        return `  L${s.layer}: used=${s.used}/cap=${s.cap} OVER CAP +${s.used - s.cap}\n${inv.join("\n")}`;
      }).join("\n") : "  (all layers at cap, none over)";
      return `COMPRESSION MANDATE (硬约束·压缩专用轮): 上一轮输出被系统容量硬闸部分拒绝 — skip 不允许静默丢弃知识。规则:
1. FORBIDDEN: 对满层/超容层 add_nodes 一律无效(系统硬闸会拒绝, 勿再尝试)。
2. REQUIRED: 把上一轮被拒的新知识通过 node_updates 折叠进语义最相关的已有节点(保持该节点 name), 或对下方清单中冗余节点对输出 node_actions merge(source→target) 腾出容量后再折叠。
3. 超容层(used>cap)必须 merge 收缩到 used<=cap。输出全部 keep = 压缩失败(将被记录为 compression_unresolved)。
层容量实况(含节点清单):\n${layersText}`;
    };
    const capSkipped = bwResult.nodeSkipReasons.some(r => r.includes("over_cap") || r.includes("layer_full"));
    let ocLayers = overCapLayers();
    let compRounds = 0;
    let needRound = ocLayers.length > 0 || capSkipped;
    while (needRound && compRounds < 2) {
      const beforeSig = ocLayers.map(s => `${s.layer}:${s.used}/${s.cap}`).join(",") || "at-cap-skip";
      const trigger = ocLayers.length > 0 ? `over_cap[${beforeSig}]` : "add_skipped_at_cap";
      const mandate = buildCompressionMandate(ocLayers);
      recordMonitorEvent({ type: "trace", action: "semantic_backward_compression_round", taskFamily, round: compRounds + 1, trigger, beforeSig });
      let cRes: Awaited<ReturnType<typeof semanticBackwardLLM>>;
      try { cRes = await semanticBackwardLLM(net, previousTask, previousAssistantHighEntropy, currentUserMessage, activatedIds, ctx, turnId, mandate); } catch (e) { recordMonitorEvent({ type: "trace", action: "semantic_backward_compression_llm_failed", taskFamily, error: preview(String((e as Error).message), 200) }); break; }
      // 压缩轮与主轮同一 reward 门控(mergeDeleteGate 在 autoBackward 内由 effectiveReward 决定);
      // apply 后核对 used 是否递减, 无进展即停(留证据给审计, 不死循环)。
      const cBw = autoBackward(net, activatedIds, effectiveReward, log, selectedEdgeIds, undefined, cRes.node_updates, cRes.add_nodes, cRes.node_actions);
      bwResult.nodesUpdated += cBw.nodesUpdated;
      bwResult.nodesAdded += cBw.nodesAdded;
      bwResult.nodesMerged += cBw.nodesMerged;
      bwResult.nodesSkipped += cBw.nodesSkipped;
      bwResult.nodeSkipReasons.push(...cBw.nodeSkipReasons.slice(0, 4));
      bwResult.nodeMutations.push(...cBw.nodeMutations);
      compRounds++;
      const prevOcSig = beforeSig;
      ocLayers = overCapLayers();
      const afterSig = ocLayers.map(s => `${s.layer}:${s.used}/${s.cap}`).join(",") || "resolved";
      const progress = !prevOcSig.includes(":") || afterSig !== prevOcSig; // at-cap-skip 触发时无超容基线, 一轮即止
      recordMonitorEvent({ type: "trace", action: "semantic_backward_compression_done", taskFamily, round: compRounds, beforeSig: prevOcSig, afterSig, merged: cBw.nodesMerged, updated: cBw.nodesUpdated, resolved: ocLayers.length === 0, progress });
      needRound = ocLayers.length > 0 && progress;
    }
    if (ocLayers.length > 0) {
      recordMonitorEvent({ type: "error", action: "semantic_backward_compression_unresolved", taskFamily, remaining: ocLayers, rounds: compRounds });
    }

    // ── n-gram distillation ──
    // Update n-gram counts for all activated nodes from this turn's HighEntropy
    let distillCount = 0;
    const distillEvents: { nodeId: string; oldContent: string; newContent: string }[] = [];
    if (previousAssistantHighEntropy) {
      const allStates = loadAllNgramStates(net);
      for (const id of activatedIds) {
        const parsed = parseLayerNodeId(id);
        if (!parsed) continue;
        const nodePath = path.join(net.path, `layer_${parsed.layer}`, `${parsed.nodeId}.html`);
        if (!fs.existsSync(nodePath)) continue;

        const ngramState = readNgramState(nodePath);
        updateCounts(ngramState, previousAssistantHighEntropy, effectiveReward);
        writeNgramState(nodePath, ngramState);

        // Try distillation
        const oldContent = readNodeContent(nodePath);
        const distill = maybeDistill(ngramState, allStates, oldContent);
        if (distill.newContent) {
          if (!NGRAM_DISTILL_PROMOTE) {
            // shadow-only: 记录候选但不覆盖节点内容；回写 maybeDistill 已推进的 lastDistillAt，
            // 避免每轮重复触发（newSuccesses 永远 ≥3）。
            writeNgramState(nodePath, ngramState);
            recordMonitorEvent({
              type: "trace",
              action: "ngram_distill_shadow",
              taskFamily,
              nodeId: id,
              oldContent: preview(readNodeContent(nodePath), 120),
              proposedContent: preview(distill.newContent, 180),
              topNgrams: distill.topNgrams.slice(0, 5),
            });
            dlog("DISTILL", `shadow ${id}: ${preview(distill.newContent, 80)}`);
            continue;
          }
          const preparedDistill = prepareContextLine(distill.newContent);
          const validation = preparedDistill
            ? validateKnowledgeCrystal(preparedDistill, parsed.layer)
            : { ok: false, content: distill.newContent, reason: "distill_fragment" };
          const oldQuality = validateKnowledgeCrystal(oldContent, parsed.layer);
          const distillArtifact = !preparedDistill || isNgramFragmentContent(preparedDistill);
          const weakOverwrite = oldQuality.ok && !validation.ok;
          if (!validation.ok || distillArtifact || weakOverwrite) {
            const reason = distillArtifact ? "distill_fragment" : weakOverwrite ? "weak_overwrite" : validation.reason;
            recordMonitorEvent({
              type: "trace",
              action: "ngram_distill_skip",
              taskFamily,
              nodeId: id,
              reason,
              oldContent: preview(oldContent, 120),
              proposedContent: preview(distill.newContent, 180),
            });
            dlog("DISTILL", `skipped ${id}: ${reason}`);
            continue;
          }

          const oldName = readNodeName(nodePath);
          const outEdges = (net.weights.layer_connections[`${parsed.layer}_to_${parsed.layer + 1}`] || [])
            .filter((e) => e.from === parsed.nodeId)
            .map((e) => ({ toId: e.to, weight: e.weight }));
          writeNodeHtml(nodePath, parsed.layer, parsed.nodeId, validation.content, outEdges, compressNodeName(validation.content));
          distillCount++;
          distillEvents.push({
            nodeId: id,
            oldContent: preview(oldContent, 120),
            newContent: preview(validation.content, 120),
          });
          dlog("DISTILL", `distilled ${id}: "${preview(oldContent, 60)}" → "${preview(validation.content, 60)}"`);
          log(`Textron ngram distill: ${id} "${preview(oldContent, 60)}" → "${preview(validation.content, 60)}"`);
        }
      }
    }

    const durationMs = Date.now() - startedMs;
    const qualityScore = clamp(
      (Math.max(0, effectiveReward) * 0.35) +
      (bwResult.changes > 0 ? 0.20 : 0) +
      (bwResult.nodesUpdated > 0 ? 0.25 : 0) +
      ((bwResult.nodesAdded + bwResult.nodesMerged) > 0 ? 0.15 : 0) +
      (previousAssistantHighEntropy ? 0.05 : 0) -
      ((bwResult.nodesUpdated + bwResult.nodesAdded + bwResult.nodesMerged) === 0 ? 0.15 : 0),
      0,
      1,
    );
    const qualityLabel = qualityScore >= 0.7 ? "high" : qualityScore >= 0.35 ? "medium" : "low";
    lastBackwardState = {
      taskFamily,
      action: "semantic_backward",
      status: "done",
      reward: effectiveReward,
      llmReward: result.reward,
      rationale: result.rationale || "",
      qualityScore,
      qualityLabel,
      durationMs,
      hasHighEntropy: !!previousAssistantHighEntropy,
      highEntropyFallbackNode,
      nodesUpdated: bwResult.nodesUpdated,
      nodesAdded: bwResult.nodesAdded,
      nodesMerged: bwResult.nodesMerged,
      nodesDeleted: bwResult.nodesDeleted,
      nodesSkipped: bwResult.nodesSkipped,
      skipReasons: bwResult.nodeSkipReasons.slice(0, 8),
      edgesUpdated: bwResult.changes,
      changedEdges: bwResult.changedEdges,
      changedNodes: bwResult.changedNodes,
      nodeMutations: bwResult.nodeMutations,
      distillCount,
      distillEvents,
      activatedIds,
      selectedEdgeIds,
      startedAt,
      at: new Date().toISOString(),
    };
    dlog("BACKWARD", "forcedSemanticBackward DONE", lastBackwardState);
    log(`Textron semantic backward: status=done quality=${qualityLabel}(${qualityScore.toFixed(2)}), reward=${effectiveReward.toFixed(3)} (LLM=${result.reward.toFixed(3)}), edgesUpdated=${bwResult.changes}, nodesUpdated=${bwResult.nodesUpdated}, nodesAdded=${bwResult.nodesAdded}, nodesMerged=${bwResult.nodesMerged}, nodesDeleted=${bwResult.nodesDeleted}, nodesSkipped=${bwResult.nodesSkipped}, durationMs=${durationMs}${result.rationale ? ` — ${result.rationale}` : ""}`);
    recordMonitorEvent({ type: "update", taskFamily, action: "semantic_backward_done", ...lastBackwardState });
    broadcast({ type: "update", taskFamily, action: "semantic_backward_done", ...lastBackwardState });
    return lastBackwardState;
  }

  // ══════════════════════════════════════════════════════════════════
  // before_agent_start → auto-route → blocking LLM L0 score → propagate → inject
  // ══════════════════════════════════════════════════════════════════

  pi.on("before_agent_start", async (event, ctx) => {
    const tStart = Date.now();
    dlog("HOOK", "before_agent_start FIRED", { promptLen: event.prompt?.length || 0, promptPreview: (event.prompt || "").slice(0, 80) });
    recordMonitorEvent({ type: "hook", hook: "before_agent_start", promptChars: event.prompt?.length || 0, promptPreview: preview(event.prompt, 180), hasActiveTask: !!activeTask, stackDepth: taskStack.length });

    // ── Restore taskStack from disk if in-memory state was lost (e.g. after reload) ──
    const memBefore = { hasActive: !!activeTask, activeType: activeTask?.taskType || '', stackLen: taskStack.length, stackTypes: taskStack.map(t => t.taskType) };
    if (!activeTask && taskStack.length === 0) {
      dlog("STATE", "memory empty, attempting disk restore", { file: LAST_STATE_PATH });
      // 2026-09-15 第十三轮：恢复必须读回 rawUserPrompt —— 旧实现硬编码 "" ⇒ 重启后
      // buildBackwardTaskContext 退化为 [HighEntropy Task]（learningPromptSource=high_entropy），
      // 反传「任务侧」丢失真实提问（实测 5 条栈项全空、previousTaskChars 全为 HE+过程）。
      const saved = readJson<{activeTask?: any|null; taskStack?: any[]} | null>(
        LAST_STATE_PATH, null);
      dlog("STATE", "disk read result", { found: !!saved, hasActive: !!(saved as any)?.activeTask, stackLen: ((saved as any)?.taskStack || []).length, activeType: (saved as any)?.activeTask?.taskType || '', stackTypes: ((saved as any)?.taskStack || []).map((t:any) => t.taskType) });
      if (saved) {
        if (saved.activeTask) {
          const rp = restoreTaskPrompt(saved.activeTask);
          activeTask = {
            taskType: saved.activeTask.taskType || "",
            taskFamily: saved.activeTask.taskFamily || "",
            rawUserPrompt: rp.rawUserPrompt, effectivePrompt: "",
            highEntropy: saved.activeTask.highEntropy || "",
            activatedIds: saved.activeTask.activatedIds || [],
            selectedEdgeIds: [],
            routeUncertain: false, moeMaxScore: 0,
            ts: saved.activeTask.ts || "",
            processLog: Array.isArray(saved.activeTask.processLog) ? saved.activeTask.processLog : [],
          };
        }
        if (saved.taskStack) {
          taskStack = saved.taskStack.map((t:any) => {
            const rp = restoreTaskPrompt(t);
            return {
              taskType: t.taskType || "", taskFamily: t.taskFamily || "",
              rawUserPrompt: rp.rawUserPrompt, effectivePrompt: "",
              highEntropy: t.highEntropy || "",
              activatedIds: t.activatedIds || [],
              selectedEdgeIds: [],
              routeUncertain: false, moeMaxScore: 0,
              ts: t.ts || "",
              processLog: Array.isArray(t.processLog) ? t.processLog : [],
            };
          });
        }
        // 恢复后原文完整性可观测：rawPromptRestored=带原文的条目数 / rawPromptEmpty=旧档或无原文
        const _restoredTasks = [activeTask, ...taskStack].filter(Boolean) as TaskEntry[];
        const _rawRestored = _restoredTasks.filter((t) => (t.rawUserPrompt || "").length > 0).length;
        recordMonitorEvent({ type: "trace", action: "task_prompt_restored", restoredTasks: _restoredTasks.length, rawPromptRestored: _rawRestored, rawPromptEmpty: _restoredTasks.length - _rawRestored, rawPromptChars: _restoredTasks.reduce((a, t) => a + (t.rawUserPrompt || "").length, 0) });
        dlog("STATE", "restored taskStack from disk", { activeTask: !!activeTask, stackDepth: taskStack.length });
        recordMonitorEvent({ type: "trace", action: "task_stack_restored", activeTask: !!activeTask, stackDepth: taskStack.length, activeType: activeTask?.taskType || '', stackTypes: taskStack.map(t => t.taskType), memBefore });
      } else {
        dlog("STATE", "disk restore skipped — file empty or missing", { path: LAST_STATE_PATH });
        recordMonitorEvent({ type: "trace", action: "task_stack_restore_empty", memBefore });
      }
    } else {
      dlog("STATE", "memory has tasks, skipping disk restore", memBefore);
    }
    currentTaskFamily = null;
    currentActivatedIds = [];
    currentActivationScores = {};
    currentSelectedEdgeIds = [];
    currentRawUserPrompt = event.prompt || "";
    currentEffectivePrompt = currentRawUserPrompt;
    currentUserInjection = "";
    currentContextAuditLogged = false;
    currentProviderAuditLogged = false;
    currentAssistantBuffer = "";
    currentAssistantHighEntropy = "";
    currentTurnTools = [];
    currentTurnThinking = "";
    currentHighEntropyLogged = false;
    currentRouteUncertain = false;
    currentMoeMaxScore = 0;

    // ── Task Stack: LLM-based feedback pairing ──
    // Build candidate list from activeTask + taskStack, let LLM match feedback to task via TaskType.
    const allPendingTasks: TaskEntry[] = activeTask ? [activeTask, ...taskStack] : [...taskStack];
    dlog("STATE", "allPendingTasks built", { count: allPendingTasks.length, list: allPendingTasks.map(t => t.taskType) });
    recordMonitorEvent({ type: "trace", action: "pending_list_built", count: allPendingTasks.length, taskTypes: allPendingTasks.map(t => t.taskType), hasActive: !!activeTask, stackLen: taskStack.length });
    if (allPendingTasks.length > 0) {
      // Build a lightweight pairing prompt: show each task's TaskType + truncated content
      // 2026-09-04: 任务列表追加 processLog 尾部摘要(最近执行上下文)——配对 judge 能看到任务做过什么
      // (交易决策/tool 结果/复盘), 否则只有 TaskType 无过程可判 → no_pending_match。
      const taskListForLLM = allPendingTasks.map((t, i) => {
        const recent = (t.processLog || []).slice(-3).join(" ⏎ ").replace(/\s+/g, " ").slice(-280);
        return `[${i}] TaskType="${t.taskType}" taskFamily="${t.taskFamily}" ts=${t.ts.slice(0,16)} HighEntropy=${t.highEntropy.slice(0, 120)}${recent ? ` | recent=${recent}` : ""}`;
      }).join("\n");

      // Use a fast LLM call to judge which task (if any) this message is feedback for
      let bestMatchIdx = -1;
      let isFeedbackMatch = false;
      // before_agent_start receives the current TUI model. The session snapshot is
      // only a fallback for Pi versions that omit ctx.model in this lifecycle hook.
      const pairingModel = (ctx as any).model || _textronModel;
      // 同一病根的第二实例：pairing 固定 max_tokens:200 + 15s 超时，但 200 只约束 content，
      // 思维链照样跑满全程 → 15s 内回不来 → JSON.parse 抛错 → 静默退回启发式推断 →
      // 反馈配对到错任务（backward 拿错 reward 源）。实测同类小任务关思考后 0.5~0.9s 就出合法 JSON。
      const pairingBudget = buildBudgetParams(
        { id: pairingModel?.id, provider: pairingModel?.provider, baseUrl: pairingModel?.baseUrl },
        resolveModelCompat(pairingModel), 2048, { noThinking: true },
      );
      try {
        if (pairingModel?.id && pairingModel?.baseUrl) {
          const baseUrl = String(pairingModel.baseUrl).replace(/\/+$/, "");
          const chatEndpoint = joinApiEndpoint(baseUrl, "/chat/completions");
          const { apiKey } = await resolveModelApiKey(ctx, pairingModel);
          const pairingPrompt = `You are a task-feedback pairing judge. Given a list of pending tasks and a user message, determine which task (if any) the user message is feedback for.\n\nPENDING TASKS:\n${taskListForLLM}\n\nUSER MESSAGE: ${currentRawUserPrompt.slice(0, 500)}\n\nOutput ONLY raw JSON: {"matchIdx":-1,"isFeedback":false,"rationale":"≤60 chars"}.\n- matchIdx: index of matched task (0=${activeTask ? "active" : "first stack"}, -1=none)\n- isFeedback: true if this message evaluates/corrects/responds to the matched task; false if it's a new task or unrelated.\n- Key signals of feedback: error correction, result report, criticism, approval, "没改好"/"改好了"/"对了"/"错了"/"为什么没有", and EXECUTION RESULTS: trade_result, portfolio, decision JSON, 复盘/反思/打分 reviews (these respond to a prior decision task).\n- coms messages ("[local-coms from ...]") that carry decision/result/review/score content ARE feedback for the sender's pending task — NOT new tasks.\n- Key signals of NOT feedback: brand-new task instructions unrelated to any pending task, pure greetings, continuation words like "继续"/"好的" alone.\n- IMPORTANT: when in doubt with a pending task present, default isFeedback=true (conservative pairing beats losing the learning signal).`;
          const res = await fetch(chatEndpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
            body: JSON.stringify({
              // Pair with the model currently selected in the TUI. A hard-coded
              // DeepSeek model breaks GPT-only gateways and splits feedback semantics.
              model: pairingModel.id,
              messages: [{ role: "user", content: pairingPrompt }],
              ...pairingBudget,
              temperature: 0,
            }),
            signal: AbortSignal.timeout(25000),
          });
          if (res.ok) {
            const data = await res.json();
            const raw = data?.choices?.[0]?.message?.content || "";
            const parsed = JSON.parse(raw.replace(/```json\n?|```/g, "").trim());
            bestMatchIdx = typeof parsed.matchIdx === "number" ? parsed.matchIdx : -1;
            isFeedbackMatch = !!parsed.isFeedback;
            dlog("BACKWARD", "pairing judge", { matchIdx: bestMatchIdx, isFeedback: isFeedbackMatch, rationale: parsed.rationale });
            recordMonitorEvent({ type: "trace", action: "pairing_judge_done", matchIdx: bestMatchIdx, isFeedback: isFeedbackMatch, rationale: parsed.rationale || "", pendingCount: allPendingTasks.length, modelId: pairingModel.id, provider: pairingModel.provider || "" });
          } else {
            throw new Error(`pairing judge fetch failed: ${res.status}`);
          }
        } else {
          throw new Error("no model available for pairing judge");
        }
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        // A failed pairing request must remain visible. Only use a deterministic
        // fallback when one pending task exists and the message has feedback markers.
        const feedbackMarker = /(?:trade_result|portfolio|decision\s*JSON|复盘|反思|打分|评分|反馈|收益率|盈亏|没改好|改好了|为什么没有|对了|错了)/i;
        const canFallback = allPendingTasks.length === 1 && feedbackMarker.test(currentRawUserPrompt);
        dlog("BACKWARD", "pairing judge failed", { error, canFallback, pendingCount: allPendingTasks.length });
        recordMonitorEvent({
          type: "error",
          action: "pairing_judge_failed",
          error,
          fallbackApplied: canFallback,
          pendingCount: allPendingTasks.length,
          modelId: pairingModel?.id || "",
          msgPreview: currentRawUserPrompt.slice(0, 160),
        });
        if (canFallback) {
          bestMatchIdx = 0;
          isFeedbackMatch = true;
          recordMonitorEvent({
            type: "trace",
            action: "pairing_judge_fallback_matched",
            matchIdx: bestMatchIdx,
            pendingCount: allPendingTasks.length,
            reason: "single_pending_task_with_feedback_marker",
          });
        }
      }

      if (isFeedbackMatch && bestMatchIdx >= 0 && bestMatchIdx < allPendingTasks.length) {
        const matched = allPendingTasks[bestMatchIdx];
        dlog("BACKWARD", "pairing MATCHED — deferring backward to agent_end", { taskType: matched.taskType, idx: bestMatchIdx });

        // ── Defer backward to agent_end — fresh HighEntropy from assistant response ──
        // Backward runs AFTER the LLM generates its response (at agent_end),
        // so the assistant's HighEntropy (experience summary) is available as
        // an additional training signal injected into the backward LLM's prompt,
        // rather than the backward LLM having to fabricate learning from raw context.
        _backwardPendingMatch = matched;
        _backwardPendingCtx = ctx;
        dlog("BACKWARD", "deferred to agent_end", { taskType: matched.taskType, highEntropyLen: matched.highEntropy.length });
        recordMonitorEvent({ type: "trace", action: "backward_deferred_to_agent_end", taskFamily: matched.taskFamily, matchedTaskType: matched.taskType });
      } else {
        // Not feedback → preserve all tasks, log as intermediate
        recordMonitorEvent({ type: "trace", action: "semantic_backward_skipped_not_feedback", reason: "pairing_judge_no_match", pendingCount: allPendingTasks.length, matchIdx: bestMatchIdx, isFeedback: isFeedbackMatch, taskTypes: allPendingTasks.map(t => t.taskType), msgPreview: currentRawUserPrompt.slice(0, 100) });
        dlog("BACKWARD", "skipped — not feedback, all tasks preserved", { pendingCount: allPendingTasks.length, taskTypes: allPendingTasks.map(t => t.taskType) });
      }
    } else {
      dlog("BACKWARD", "skipped — pending list empty, no tasks to match", { hasActive: !!activeTask, stackLen: taskStack.length });
      recordMonitorEvent({ type: "trace", action: "pending_list_empty_skip", hasActive: !!activeTask, stackLen: taskStack.length, msgPreview: currentRawUserPrompt.slice(0, 100) });
    }

    const networks = listNetworks();

    if (networks.length === 0) {
      dlog("ROUTE", "no networks, skip");
      recordMonitorEvent({ type: "trace", action: "route_skip", reason: "no_networks", durationMs: Date.now() - tStart });
      return { systemPrompt: event.systemPrompt };
    }

    const route = autoRouteNetworkDecision(event.prompt, networks);
    const tf = route.taskFamily;
    if (!tf) {
      dlog("ROUTE", "no matching network, skip Textron injection");
      recordMonitorEvent({ type: "trace", action: "route_skip", reason: "no_task_family_match", networkCount: networks.length, networks, promptPreview: preview(event.prompt, 180), durationMs: Date.now() - tStart });
      return { systemPrompt: event.systemPrompt + HIGH_ENTROPY_INSTRUCTION };
    }
    const routeIsUncertain = route.reason === "best_effort" || route.reason === "content_match" || route.score < routeAbstainScore();
    currentRouteUncertain = routeIsUncertain;
    currentTaskFamily = tf;
    recordMonitorEvent({ type: "trace", action: "route_done", taskFamily: tf, reason: route.reason, score: Number(route.score.toFixed(4)), uncertain: routeIsUncertain, threshold: routeAbstainScore(), policy: "always_inject_and_let_backward_converge", networkCount: networks.length, networks, promptPreview: preview(event.prompt, 180) });
    const net = loadNetwork(tf);
    if (!net) {
      recordMonitorEvent({ type: "trace", action: "route_skip", reason: "selected_network_missing", taskFamily: tf, durationMs: Date.now() - tStart });
      return { systemPrompt: event.systemPrompt };
    }
    dlog("ROUTE", `auto-routed to network: ${tf}`, { layers: net.hyperparams.layers, threshold: net.hyperparams.threshold });

    // F1 (2026-09-15 目录驱动候选池): 原实现 `for (n < hyperparams.layers[0])` 只按声明槽位遍历，
    // 磁盘上存在但超出声明的节点成为「孤儿」永不参与 l0_score（实测 layers[0]=1 而 layer_0/node_1.html
    // 有 999c 交易规则 ⇒ l0_score_start.nodeCount=1，前向看不到该知识）。
    const l0Nodes: { id: string; name: string; content: string }[] = [];
    {
      const l0Dir = path.join(net.path, "layer_0");
      let files: string[] = [];
      try { files = fs.readdirSync(l0Dir); } catch { files = []; }
      const idxs = files
        .map((f) => /^node_(\d+)\.html$/.exec(f))
        .filter((m): m is RegExpExecArray => !!m)
        .map((m) => parseInt(m[1], 10))
        .sort((a, b) => a - b);
      const declared = net.hyperparams.layers[0] || 0;
      const maxFound = idxs.length ? idxs[idxs.length - 1] : -1;
      // 声明槽位内保留空槽占位语义；超出声明的仅纳入磁盘真实存在的节点（孤儿回收）
      const upper = Math.max(declared - 1, maxFound);
      for (let n = 0; n <= upper; n++) {
        const exists = idxs.includes(n);
        if (!exists && n >= declared) continue;
        const nodePath = path.join(l0Dir, `node_${n}.html`);
        l0Nodes.push({ id: `node_${n}`, name: readNodeName(nodePath), content: readNodeContent(nodePath) });
      }
      if (maxFound >= declared) {
        recordMonitorEvent({ type: "trace", action: "l0_pool_dir_driven", taskFamily: tf, declared, maxFound, pooled: l0Nodes.length });
      }
    }
    dlog("L0", `loaded ${l0Nodes.length} L0 nodes`, l0Nodes.map(n => ({ id: n.id, name: n.name || "(empty)", hasContent: !!n.content })));

    dlog("L0", "calling scoreL0WithLLM...");
    _lastL0Diag = null; // 每回合重置
    const tScoreStart = Date.now();
    const l0Scores = await scoreL0WithLLM(l0Nodes, event.prompt, ctx, net.path);
    dlog("L0", `scoring done in ${Date.now() - tScoreStart}ms`, l0Scores);

    // ── Relevance-gated PageRank + anti-lock-in exploration ──
    const localScores = buildLocalScores(String(event.prompt || ""), l0Nodes);
    const prScores = computePageRank(net);
    const PR_BLEND_WEIGHT = 0.15; // centrality supports relevance; it cannot create relevance
    for (const n of l0Nodes) {
      const key = `L0::${n.id}`;
      const llmScore = (l0Scores as Record<string, number>)[key] ?? 0;
      const localScore = localScores[key] ?? 0;
      const prScore = prScores[key] ?? 0;
      if (llmScore < 0.05 && localScore > 0 && prScore > 0.1) {
        (l0Scores as Record<string, number>)[key] = clamp(localScore * 0.7 + prScore * PR_BLEND_WEIGHT, 0, 1);
      } else if (llmScore > 0) {
        (l0Scores as Record<string, number>)[key] = clamp(llmScore * (1 - PR_BLEND_WEIGHT) + prScore * PR_BLEND_WEIGHT, 0, 1);
      }
    }
    const forwardStatsPath = path.join(net.path, "_node_stats.json");
    const forwardStats = readJson<Record<string, { activations?: number; success?: number; failure?: number; lastActivated?: string }>>(
      forwardStatsPath,
      {},
    );
    const adjustedL0 = applyExplorationPolicy(l0Scores as Record<string, number>, localScores, forwardStats);
    const moeRoute = routeL0ThroughMoe({
      prompt: String(event.prompt || ""),
      l0Nodes,
      scores: adjustedL0,
      stats: forwardStats,
      expertCount: moeExpertCount(),
      topK: moeTopK(),
    });
    for (const key of Object.keys(l0Scores as Record<string, number>)) {
      (l0Scores as Record<string, number>)[key] = moeRoute.gatedScores[key] ?? 0;
    }
    // 三层架构①: 同层横向扩散 — 种子按 lateral 边拉入相似邻居(Memora 借鉴,补 L0 漏召回)
    const lateralLift0 = lateralDiffuse(net, 0, l0Scores as Record<string, number>);
    if (lateralLift0 > 0) dlog("L0", `lateral diffusion lifted ${lateralLift0} neighbor node(s)`);
    recordMonitorEvent({
      type: "trace",
      action: "l0_exploration_applied",
      taskFamily: tf,
      pageRankWeight: PR_BLEND_WEIGHT,
      topAdjusted: topScores(adjustedL0),
      localNonzero: Object.values(localScores).filter((v) => v > 0).length,
    });
    currentMoeMaxScore = moeRoute.experts.reduce((max, expert) => Math.max(max, Number(expert.score) || 0), 0);
    recordMonitorEvent({
      type: "trace",
      action: "moe_route_done",
      taskFamily: tf,
      enabled: moeRoute.enabled,
      selectedExpertIds: moeRoute.selectedExpertIds,
      maxExpertScore: Number(currentMoeMaxScore.toFixed(4)),
      experts: moeRoute.experts.map((expert) => ({
        id: expert.id,
        name: preview(expert.name, 80),
        score: Number(expert.score.toFixed(4)),
        nodeIds: expert.nodeIds,
      })),
      topK: moeTopK(),
    });

    const { layers, threshold } = net.hyperparams;
    const promptText = String(event.prompt || "");
    const downstreamFloor = downstreamRelevanceFloor();
    const downstreamRelevance: Record<string, number> = {};
    for (let l = 1; l < layers.length; l++) {
      for (let n = 0; n < layers[l]; n++) {
        const nodeId = `node_${n}`;
        const nodePath = path.join(net.path, `layer_${l}`, `${nodeId}.html`);
        downstreamRelevance[`L${l}::${nodeId}`] = lexicalRelevance(promptText, `${readNodeName(nodePath)} ${readNodeContent(nodePath)}`);
      }
    }
    const relevanceFilteredNodes: { id: string; layer: number; score: number; relevance: number; name: string }[] = [];
    const scores: Record<string, number> = {};
    for (const [key, val] of Object.entries(l0Scores as Record<string, number>)) {
      const score = Number(val) || 0;
      scores[key] = score;
      // Also set flat key for edge lookup (edges use bare "node_X" not "L0::node_X")
      const flat = key.replace(/^L\d+::/, "");
      scores[flat] = score;
    }
    for (let l = 1; l < layers.length; l++) {
      for (let n = 0; n < layers[l]; n++) scores[`L${l}::node_${n}`] = 0;
    }

    const selectedPath: ActivatedNode[] = [];
    const contextActivated: ActivatedNode[] = [];
    let current = { ...scores };

    const layerActivations = [];
    const edgeContributions = [];

    for (let l = 0; l < layers.length; l++) {
      const lnodes = [];
      for (let n = 0; n < layers[l]; n++) {
        const nid = `node_${n}`;
        let score = current[`L${l}::${nid}`] ?? current[nid] ?? 0;
        if (l > 0 && score > 0) {
          const relevance = downstreamRelevance[`L${l}::${nid}`] || 0;
          if (relevance < downstreamFloor) {
            relevanceFilteredNodes.push({
              id: `L${l}::${nid}`,
              layer: l,
              score: Number(score.toFixed(4)),
              relevance: Number(relevance.toFixed(4)),
              name: preview(readNodeName(path.join(net.path, `layer_${l}`, `${nid}.html`)), 80),
            });
            score = 0;
          } else {
            score = clamp(score * Math.min(1, 0.4 + relevance * 4), 0, 1);
          }
          current[nid] = score;
          current[`L${l}::${nid}`] = score;
        }
        lnodes.push({ id: nid, score });
      }
      layerActivations.push({ layer: l, nodes: lnodes });

      if (l < layers.length - 1) {
        const next = {};
        const edges = net.weights.layer_connections[`${l}_to_${l + 1}`] || [];
        for (let t = 0; t < layers[l + 1]; t++) {
          const tid = `node_${t}`;
          let sum = 0;
          let denom = 0;
          for (const e of edges) {
            if (e.to !== tid) continue;
            const src = current[e.from] ?? current[`L${l}::${e.from}`] ?? 0;
            if (src <= 0) continue; // active-only denominator: inactive source edges must not dilute downstream scores
            const w = Math.max(0, e.weight);
            const contrib = src * w;
            sum += contrib;
            denom += w;
            edgeContributions.push({ fromL: l, toL: l + 1, from: e.from, to: e.to, contrib });
          }
          next[tid] = denom > 0 ? clamp(sum / denom, 0, 1) : 0;
        }
        current = next;
        // 三层架构①: 层间传播后同层扩散一次,让候选内相似节点也受益
        lateralDiffuse(net, l + 1, current);
      }
    }

    // Persist all scores for monitor labels. Select top-k nodes per layer for backward,
    // while keeping prompt injection threshold-gated to avoid flooding context.
    currentActivationScores = {};
    const netCfg = readNetConfig();
    const topK = forwardTopK();
    const selectedByLayer = new Map<number, string[]>();
    const thresholdFallbacks: string[] = [];
    for (const la of layerActivations) {
      for (const node of la.nodes) currentActivationScores[`L${la.layer}::${node.id}`] = node.score;
      const ranked = la.layer === 0
        ? [...la.nodes].filter((node) => node.score > 0).sort((a, b) => b.score - a.score)
        : rankLayerWithExploration(la.layer, la.nodes, forwardStats);
      // 2026-09-14: 每层激活数可配(topKByLayer 覆盖全局 topK) — 如 L0 3个/L1 2个
      const selected = ranked.slice(0, topKForLayer(la.layer, netCfg));
      if (selected.length > 0) selectedByLayer.set(la.layer, selected.map((n) => n.id));
      for (const node of selected) {
        selectedPath.push({
          id: node.id,
          layer: la.layer,
          content: readNodeContent(path.join(net.path, `layer_${la.layer}`, `${node.id}.html`)),
          activation: node.score,
        });
      }
      // F2 (2026-09-15 selected ⊆ context 不变式): 每层 top-1 保底注入。
      // 原实现只在 score>threshold 时注入；实测 topAdjusted 仅 1/7 越过 threshold=0.2
      // ⇒ selectedIds 非空而 contextIds 空（稳定退化态），网络对决策零影响。
      const above = selected.filter((n) => n.score > threshold);
      const inject = above.length > 0 ? above : (selected.length > 0 ? [selected[0]] : []);
      if (above.length === 0 && inject.length > 0) thresholdFallbacks.push(`L${la.layer}`);
      for (const node of inject) {
        contextActivated.push({
          id: node.id,
          layer: la.layer,
          content: readNodeContent(path.join(net.path, `layer_${la.layer}`, `${node.id}.html`)),
          activation: node.score,
        });
      }
    }

    // ── Cold-start virtual L0: if no nodes activated, seed one from current message ──
    if (selectedPath.length === 0 && String(event.prompt || "").trim().length > 20) {
      const seedContent = applyContentLimit(String(event.prompt || "").trim());
      const seedName = compressNodeName(seedContent).slice(0, 48);
      const virtualId = "_seed_0";
      selectedPath.push({ id: virtualId, layer: 0, content: seedContent, activation: 0.5 });
      contextActivated.push({ id: virtualId, layer: 0, content: seedContent, activation: 0.5 });
      if (!selectedByLayer.has(0)) selectedByLayer.set(0, []);
      selectedByLayer.get(0)!.push(virtualId);
      currentActivationScores[`L0::${virtualId}`] = 0.5;
      log(`Textron forward: cold-start — seeded virtual L0 node "${seedName}" (no existing nodes activated)`);
      recordMonitorEvent({ type: "trace", action: "cold_start_virtual_l0", taskFamily: tf, seedName, contentLen: seedContent.length });
    }

    currentSelectedEdgeIds = [];
    const selectedEdgeSet = new Set<string>();
    for (let l = 0; l < layers.length - 1; l++) {
      const fromSet = new Set(selectedByLayer.get(l) || []);
      const toSet = new Set(selectedByLayer.get(l + 1) || []);
      if (fromSet.size === 0 || toSet.size === 0) continue;
      const edges = net.weights.layer_connections[`${l}_to_${l + 1}`] || [];
      for (const e of edges) {
        if (!fromSet.has(e.from) || !toSet.has(e.to)) continue;
        const srcScore = currentActivationScores[`L${l}::${e.from}`] || 0;
        const dstScore = currentActivationScores[`L${l + 1}::${e.to}`] || 0;
        if (srcScore <= 0 || dstScore <= 0 || Math.max(0, e.weight) <= 0) continue;
        selectedEdgeSet.add(`L${l}::${e.from}->L${l + 1}::${e.to}`);
      }
    }
    currentSelectedEdgeIds = [...selectedEdgeSet];

    currentActivatedIds = selectedPath.map((n) => `L${n.layer}::${n.id}`);
    // Count every forward selection, including weak-reward turns. Backward success/failure
    // counters alone undercount frequency and cannot prevent path lock-in.
    for (const id of currentActivatedIds) {
      const stat = forwardStats[id] || { activations: 0, success: 0, failure: 0, lastActivated: "" };
      const historical = Number(stat.success || 0) + Number(stat.failure || 0);
      stat.activations = Number(stat.activations ?? historical) + 1;
      stat.lastActivated = new Date().toISOString();
      forwardStats[id] = stat;
    }
    writeJson(forwardStatsPath, forwardStats);
    const contextIds = contextActivated.map((n) => `L${n.layer}::${n.id}`);
    dlog("PROPAGATE", `selected ${selectedPath.length} path nodes, injecting ${contextActivated.length} context nodes (threshold=${threshold})`, { selectedPathIds: currentActivatedIds, contextIds, selectedEdges: currentSelectedEdgeIds });
    recordMonitorEvent({
      type: "trace",
      action: "propagate_done",
      taskFamily: tf,
      threshold,
      selectedIds: currentActivatedIds,
      contextIds,
      selectedEdgeIds: currentSelectedEdgeIds,
      topByLayer: layerActivations.map((la) => ({ layer: la.layer, top: topLayerNodes(la.nodes) })),
      edgeContributionCount: edgeContributions.length,
      topEdgeContributions: [...edgeContributions].sort((a: any, b: any) => b.contrib - a.contrib).slice(0, 8).map((e: any) => ({ ...e, contrib: Number(e.contrib.toFixed(4)) })),
      downstreamRelevanceFloor: downstreamFloor,
      downstreamRelevanceFiltered: relevanceFilteredNodes.slice(0, 12),
      downstreamRelevanceFilteredCount: relevanceFilteredNodes.length,
      allScoresZero: Object.values(currentActivationScores).every((v) => Number(v) <= 0),
      thresholdFallbackLayers: thresholdFallbacks,
      contextCount: contextActivated.length,
      durationMs: Date.now() - tStart,
    });
    broadcast({
      type: "propagate_live",
      taskFamily: tf,
      layerActivations,
      edgeContributions,
      selectedIds: currentActivatedIds,
      contextIds,
      selectedEdgeIds: currentSelectedEdgeIds,
      scores: currentActivationScores,
      threshold,
      totalLayers: layers.length,
    });

    const compiledCtx = compileContext(net, contextActivated);
    dlog("COMPILE", `compiled context: ${compiledCtx.length} chars`, compiledCtx.slice(0, 200));

    const totalMs = Date.now() - tStart;
    dlog("HOOK", `before_agent_start DONE in ${totalMs}ms`, { selectedPathCount: selectedPath.length, activatedCount: contextActivated.length, compiledLen: compiledCtx.length });
    recordMonitorEvent({ type: "hook", hook: "before_agent_start_done", taskFamily: tf, selectedPathCount: selectedPath.length, contextCount: contextActivated.length, compiledChars: compiledCtx.length, durationMs: totalMs, injectedHighEntropyInstruction: true });

    const injection = buildTextronPromptInjection({
      rawPrompt: currentRawUserPrompt,
      taskFamily: tf,
      contextActivatedCount: contextActivated.length,
      totalNodeCount: layers.reduce((a, b) => a + b, 0),
      selectedPathCount: selectedPath.length,
      compiledContext: compiledCtx,
    });
    currentEffectivePrompt = injection.effectivePrompt;
    recordMonitorEvent({
      type: "trace",
      action: "prompt_injection_prepared",
      taskFamily: tf,
      compiledContextFull: compiledCtx,
      activatedCount: contextActivated.length,
      totalNodeCount: layers.reduce((a, b) => a + b, 0),
      selectedPathCount: selectedPath.length,
      ...injection.audit,
    });
    currentUserInjection = injection.userInjection;
    log(`Textron: prepared ${compiledCtx.length}c compiled context for context.user_message injection in "${tf}"`);
    return {
      systemPrompt: event.systemPrompt + HIGH_ENTROPY_INSTRUCTION,
    };
  });

  pi.on("context", async (event: any, _ctx: any) => {
    if (!currentUserInjection || !currentRawUserPrompt) return;
    const messages = Array.isArray(event.messages) ? [...event.messages] : [];
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (!msg || msg.role !== "user") continue;
      const content = msg.content;
      if (typeof content === "string") {
        if (!content.includes("## 🧠 Textron")) {
          messages[i] = { ...msg, content: content + currentUserInjection };
          if (!currentContextAuditLogged) {
            currentContextAuditLogged = true;
            recordPromptAudit({
              type: "trace",
              action: "context_user_message_injected",
              taskFamily: currentTaskFamily || "",
              promptPreview: preview(currentRawUserPrompt, 260),
              rawPromptChars: currentRawUserPrompt.length,
              effectivePromptChars: currentEffectivePrompt.length,
              hasTextronMarker: true,
              injectedPromptPreview: preview((content + currentUserInjection).slice(-700), 700),
            });
          }
        }
        return { messages };
      }
      if (!Array.isArray(content)) continue;
      const textIndex = content.findIndex((part: any) => part?.type === "text" && typeof part.text === "string");
      if (textIndex < 0) continue;
      const text = content[textIndex].text;
      if (text.includes("## 🧠 Textron")) return { messages };
      const nextContent = [...content];
      nextContent[textIndex] = { ...nextContent[textIndex], text: text + currentUserInjection };
      messages[i] = { ...msg, content: nextContent };
      if (!currentContextAuditLogged) {
        currentContextAuditLogged = true;
        recordPromptAudit({
          type: "trace",
          action: "context_user_message_injected",
          taskFamily: currentTaskFamily || "",
          promptPreview: preview(currentRawUserPrompt, 260),
          rawPromptChars: currentRawUserPrompt.length,
          effectivePromptChars: currentEffectivePrompt.length,
          hasTextronMarker: true,
          injectedPromptPreview: preview((text + currentUserInjection).slice(-700), 700),
        });
      }
      return { messages };
    }
  });

  pi.on("before_provider_request", async (event: any, _ctx: any) => {
    if (!currentUserInjection || !currentRawUserPrompt) return;
    let payloadText = "";
    try { payloadText = JSON.stringify(event.payload || ""); }
    catch { payloadText = String(event.payload || ""); }
    const markerIndex = payloadText.indexOf("## 🧠 Textron");
    if (!currentProviderAuditLogged) {
      currentProviderAuditLogged = true;
      recordPromptAudit({
        type: "trace",
        action: "provider_payload_textron_audit",
        taskFamily: currentTaskFamily || "",
        hasTextronMarker: markerIndex >= 0,
        payloadChars: payloadText.length,
        markerIndex,
        preview: markerIndex >= 0 ? preview(payloadText.slice(Math.max(0, markerIndex - 120), markerIndex + 360), 480) : "",
      });
    }
  });

  // ══════════════════════════════════════════════════════════════════
  // message_update/message_end → capture assistant <HighEntropy> summary
  // ══════════════════════════════════════════════════════════════════

  pi.on("message_update", async (event: any, _ctx: any) => {
    const ev = event?.assistantMessageEvent;
    if (!ev) return;
    if (ev.type === "text_delta" && ev.delta) currentAssistantBuffer += String(ev.delta);
    if (ev.type === "text_end" && ev.content) {
      const ended = String(ev.content);
      if (!currentAssistantBuffer.endsWith(ended)) currentAssistantBuffer += ended;
    }
    const extracted = extractHighEntropy(currentAssistantBuffer);
    if (extracted) {
      currentAssistantHighEntropy = extracted;
      if (!currentHighEntropyLogged) {
        currentHighEntropyLogged = true;
        recordMonitorEvent({ type: "trace", action: "highentropy_captured", source: "message_update", taskFamily: currentTaskFamily || "", chars: extracted.length, preview: preview(extracted, 220), assistantBufferChars: currentAssistantBuffer.length });
      }
    }
  });

  pi.on("message_end", async (event: any, _ctx: any) => {
    if (event?.message?.role !== "assistant") return;
    const text = assistantMessageText(event.message);
    if (text && !currentAssistantBuffer.endsWith(text)) currentAssistantBuffer += "\n" + text;
    const extracted = extractHighEntropy(currentAssistantBuffer);
    if (extracted) {
      currentAssistantHighEntropy = extracted;
      if (!currentHighEntropyLogged) {
        currentHighEntropyLogged = true;
        recordMonitorEvent({ type: "trace", action: "highentropy_captured", source: "message_end", taskFamily: currentTaskFamily || "", chars: extracted.length, preview: preview(extracted, 220), assistantBufferChars: currentAssistantBuffer.length });
      }
    }
  });

  // 轨迹可视化数据源: 工具调用记录(Monitor 轨迹面板用)
  pi.on("tool_call", async (event: any) => {
    try {
      const inputPreview = JSON.stringify(event?.input || {}).replace(/\s+/g, " ").slice(0, 300);
      const toolName = String(event?.toolName || "?");
      // 2026-09-04: 工具调用入回合缓冲(与 tool_result 同为任务执行上下文, 不扫描过滤, 供 agent_end 拼接 processLog)
      try {
        currentTurnTools.push(`▶${toolName} in:${inputPreview.slice(0, 4000)}`);
        if (currentTurnTools.length > 40) currentTurnTools.shift();
      } catch { /* 缓冲失败不影响主流程 */ }
      recordMonitorEvent({
        type: "trace", action: "tool_call",
        taskFamily: currentTaskFamily || "",
        tool: toolName,
        inputPreview,
      });
    } catch { /* 忽略 */ }
  });

  // 轨迹可视化: 工具执行结果(Observation)——DeepSeek harness 链的"观察"
  pi.on("tool_result", async (event: any) => {
    try {
      // 2026-09-04: content 为 (TextContent|ImageContent)[] 结构化数组 → 递归提取文本, 修 String() 得 "[object Object]" 失真
      const rawContent = extractToolResultText(event?.content);
      const content = rawContent.replace(/\s+/g, " ").trim();
      const toolName = String(event?.toolName || "?");
      const flat = content;
      // 2026-09-04: 工具结果入回合缓冲——不扫描关键词、一律保留(≤700c/条), 修复 tool_result 只 recordMonitorEvent
      // 不进 processLog → 交易决策/结果/复盘对 backward/pairing 不可见的配对盲区。
      try {
        const prev = currentTurnTools.length ? currentTurnTools[currentTurnTools.length - 1] : "";
        if (prev.startsWith(`▶${toolName}`)) {
          currentTurnTools[currentTurnTools.length - 1] = `${prev} → out:${flat.slice(0, 20000)}`;
        } else {
          currentTurnTools.push(`◀${toolName} out:${flat.slice(0, 20000)}`);
        }
        if (currentTurnTools.length > 40) currentTurnTools.shift();
      } catch { /* 忽略 */ }
      recordMonitorEvent({
        type: "trace", action: "tool_result",
        taskFamily: currentTaskFamily || "",
        tool: toolName,
        resultPreview: preview(flat.slice(0, 300), 220),
        resultChars: content.length,
        isError: !!event?.isError,
      });
    } catch { /* 忽略 */ }
  });

  // ══════════════════════════════════════════════════════════════════
  // agent_end → preserve selected path for forced semantic backward on next turn
  // ══════════════════════════════════════════════════════════════════

  pi.on("agent_end", async (event: any, _ctx) => {
    console.error(`[textron] agent_end FIRED at ${new Date().toISOString()}`);
    try {
    // 本轮对话唯一标识: 轨迹对话行 ↔ 异步 backward 行/回填关联
    const turnId = genTurnId();
    // ── Extract HighEntropy crystal to get taskType and isTask ──
    const runMessages = Array.isArray(event?.messages) ? event.messages : [];
    const eventHighEntropy = extractLatestHighEntropyFromMessages(runMessages);
    // ── 2026-09-05 单数据源: agent_end.messages 含本轮全量 user/assistant/toolCall/toolResult,
    //    不再依赖跨 hook 增量缓冲(message_update/tool_call 等仅回退)。
    //    正确回合模型: 每条用户消息=一次完整 run(before_agent_start→agent_end), 中间多 turn/tool 都在这。
    //    提取逻辑见 lib/round_snapshot.ts(模块化, 不入 index.ts 主体)。
    const roundUserText = lastUserMessageText(runMessages);
    // 2026-09-15 n8 第十四轮：工具链改为「原文保真 + 显式截断标记」（input 180c/output 640c/24 条静默丢
    // 已消除；详见 lib/round_snapshot.ts 顶部约定）。stats 随轨迹行落盘，供审计「信息是否被 slice」。
    const roundToolsDetail = rebuildToolsFromMessagesDetailed(runMessages);
    const roundTools = roundToolsDetail.lines;
    const toolsFidelity: ToolsFidelityStats = roundToolsDetail.stats;
    let thinkingFidelity: ThinkingFidelityStats | null = null;
    // 主源优先: messages 提取为空时才用增量 hook 缓冲(兼容旧流式路径)
    const turnTools = roundTools.length ? roundTools : currentTurnTools;
    const roundUserPrompt = roundUserText || currentRawUserPrompt;
    let finalAssistantText = "";
    // Some Responses adapters append a zero-width placeholder assistant message;
    // select the last visible assistant message instead of stopping at that placeholder.
    for (let i = runMessages.length - 1; i >= 0; i--) {
      const candidate = assistantMessageText(runMessages[i]);
      if (candidate.replace(/[\u200B-\u200D\uFEFF]/g, "").trim()) {
        finalAssistantText = candidate;
        break;
      }
    }
    if (finalAssistantText && !currentAssistantBuffer.includes(finalAssistantText)) {
      currentAssistantBuffer += `\n${finalAssistantText}`;
    }
    // 轨迹可视化: 记录 AI 回答摘要(Monitor 轨迹面板)
    try {
      recordMonitorEvent({
        type: "trace", action: "agent_answer",
        taskFamily: currentTaskFamily || "",
        answerPreview: preview(finalAssistantText, 300),
        answerChars: finalAssistantText.length,
        hasHighEntropy: /<HighEntropy>/i.test(finalAssistantText),
      });
    } catch { /* 忽略 */ }
    // 轨迹持久化优先取最终消息；部分流式适配器会留下仅含零宽字符的最终消息，改用累计正文回退。
    try {
      const visibleText = (value: unknown) => String(value || "").replace(/[\u200B-\u200D\uFEFF]/g, "").trim();
      const trajectoryAnswer = visibleText(finalAssistantText) ? finalAssistantText : currentAssistantBuffer;
      if (visibleText(trajectoryAnswer) || roundUserPrompt) {
        // ── 2026-09-15：轨迹行改为「原文完整 + 显式配对 + 学到内容本体」──
        // 原实现：userPrompt 截 4000c / answer 截 8000c（静默）、HighEntropy 只存一个布尔
        // ⇒ 事后无法复核、无法手动重放、无法证明「学到了什么」。
        // 现约定：①原文不静默截断（超 RAW_CAP 才截且置 truncated 标记）②respondsTo 形成
        // 任务→行动→反馈 的配对链（按 ts/turnId 序 join 即可取三元组）③highEntropy 存**载荷本体**。
        const RAW_CAP = 60000;
        const clip = (v: unknown) => {
          const t = String(v || "");
          return t.length > RAW_CAP ? { text: t.slice(0, RAW_CAP), truncated: true, chars: t.length } : { text: t, truncated: false, chars: t.length };
        };
        const rawUser = clip(roundUserPrompt);
        const rawAnswer = clip(trajectoryAnswer);
        let hePayload: Record<string, unknown> | undefined;
        try {
          const crystal = parseHighEntropyCrystal(currentAssistantHighEntropy ? `<HighEntropy>${currentAssistantHighEntropy}</HighEntropy>` : "");
          const fnBlock = extractFunctionBlock(currentAssistantHighEntropy);
          if (crystal?.ok || fnBlock) {
            hePayload = {
              name: crystal?.ok ? crystal.name : "",
              taskType: crystal?.ok ? crystal.taskType : "",
              isTask: crystal?.ok ? crystal.isTask : null,
              task: crystal?.ok ? crystal.task : "",
              technique: crystal?.ok ? crystal.technique : "",
              functionBlock: fnBlock || "",
              rawChars: String(currentAssistantHighEntropy || "").length,
            };
          }
        } catch { /* 解析失败不影响落盘 */ }
        appendTrajectoryLine({
          kind: "turn",
          turnId,
          ts: new Date().toISOString(),
          respondsTo: _lastTurnId || null,           // 配对链：上一轮 turnId（任务→行动→反馈 按序 join）
          taskFamily: currentTaskFamily || "",
          userPrompt: rawUser.text,
          userPromptChars: rawUser.chars,
          userPromptTruncated: rawUser.truncated,
          answer: rawAnswer.text,
          answerChars: rawAnswer.chars,
          answerTruncated: rawAnswer.truncated,
          hasHighEntropy: !!hePayload,
          ...(hePayload ? { highEntropy: hePayload } : {}),
          // hook 把哪条 pending 任务配成了本轮的「任务」（配对可追溯，不再只有结果没有依据）
          matchedTaskTs: (_backwardPendingMatch as any)?.ts ?? null,
          matchedTaskType: (_backwardPendingMatch as any)?.taskType ?? "",
          matchedTaskFamily: (_backwardPendingMatch as any)?.taskFamily ?? "",
          matchedTaskHEChars: String((_backwardPendingMatch as any)?.highEntropy || "").length,
          activatedIds: (currentActivatedIds || []).slice(0, 30),
          backward: { ran: false },
          ...(_lastL0Diag ? { forward_diag: _lastL0Diag } : {}),
        });
        _lastTurnId = turnId;
      }
    } catch { /* 轨迹记录失败不影响主流程 */ }
    // 轨迹可视化: 提取思考链(thinking/reasoning)——DeepSeek harness 的"思考"步
    // 2026-09-05: 单数据源——thinking 直接从 runMessages 提取(见 lib/round_snapshot.ts), 不需增量拼装
    try {
      const thoughtsDetail = rebuildThinkingFromMessagesDetailed(runMessages, 40000);
      const thoughts = thoughtsDetail.text;
      thinkingFidelity = thoughtsDetail.stats;
      if (thoughts) {
        const thoughtList = thoughts.split(" ⏎ ");
        currentTurnThinking = thoughts.slice(-1400);
        recordMonitorEvent({
          type: "trace", action: "agent_thought",
          taskFamily: currentTaskFamily || "",
          thoughtCount: thoughtList.length,
          thoughtsPreview: preview(thoughtList.map((t) => t.replace(/\s+/g, " ")).join(" ⏎ ").slice(0, 400), 360),
        });
      }
    } catch { /* 忽略 */ }
    const finalCrystal = parseHighEntropyCrystal(currentAssistantBuffer);
    const highEntropy = eventHighEntropy || currentAssistantHighEntropy || (finalCrystal.ok ? `Name: ${finalCrystal.name}\n${finalCrystal.task ? `Task: ${finalCrystal.task}\n` : ""}Technique: ${finalCrystal.technique}` : "");
    const taskType = finalCrystal.taskType || "";
    // 2026-09-03: isTask 兜底——crystal 解析失败时若回答原文含 HighEntropy 契约声明则正则提取,
    // 保证"任务开始"登记不依赖 crystal 完整性(HE 剥离失败 ≠ 不是任务)。
    let isTask = finalCrystal.isTask;
    if (isTask === undefined) {
      const heSource = `${finalAssistantText}\n${currentAssistantBuffer}`;
      if (/<HighEntropy>/i.test(heSource)) {
        const m = heSource.match(/isTask\s*[:：]\s*(true|false)/i);
        if (m) isTask = m[1].toLowerCase() === "true";
      }
    }

    if (!highEntropy) {
      recordMonitorEvent({
        type: "trace",
        action: "highentropy_missing_at_agent_end",
        taskFamily: currentTaskFamily || "",
        hasTag: /<HighEntropy>/i.test(`${finalAssistantText}\n${currentAssistantBuffer}`),
        reason: finalCrystal.reason || "missing",
      });
    }

    recordMonitorEvent({
      type: "hook",
      hook: "agent_end",
      taskFamily: currentTaskFamily || "",
      activatedIds: currentActivatedIds,
      hasHighEntropy: !!highEntropy,
      isTask,
      taskType,
    });

    // ── Task Stack ──
    // 规则(2026-09-03 修订):
    //   A. 任务开始(isTask 自我声明, 允许无 HighEntropy) → 登记入栈; HE 不再是入栈凭证;
    //   B. 中间动作(非任务开始 且 本 turn 非配对反馈轮) → 本 turn 内容 append 到栈顶任务
    //      processLog(滑动保留 + 长度保护, 防反传上下文过长); 轨迹可见"任务开始→过程累积"全链;
    //   C. 反馈轮(配对确认, _backwardPendingMatch 已置位) → 不 append,
    //      backward 将以 processLog 作为任务执行上下文, 完成后即出栈(见下方 shouldConsume)。
    const isTaskStart = isTask === true;
    const feedbackTurn = !!_backwardPendingMatch;   // 本 turn 已被 pairing judge 判为某任务反馈
    // 2026-09-04: 回合执行上下文(思考+工具链)与 AI 回答同权进任务 processLog——taskStart 与中间轮都 append,
    // 使 backward/pairing LLM 可见 tool_result 通道的决策/结果/复盘(修复 no_pending_match/reward 丢失的配对盲区)。
    const execTag = new Date().toISOString().slice(11, 19);
    const turnExecContext = (() => {
      const parts: string[] = [];
      if (currentTurnThinking) parts.push(`💭${currentTurnThinking.slice(0, 640)}`);
      if (turnTools.length) parts.push(`🔧${turnTools.join(" ⏎ ").slice(-40000)}`);
      if (!parts.length) return "";
      const s = `[${execTag}][exec] ${parts.join(" ⏎ ")}`;
      // exec 条目遵循单条上限(与 HE 之外的蒸馏/tail 一致, 防挤占 4800c 总预算把 HE 滚出窗口)
      return s.length > MAX_PROCESS_ENTRY_CHARS + 500 ? s.slice(0, MAX_PROCESS_ENTRY_CHARS + 497) + "…" : s;
    })();
    if (isTaskStart) {
      const newTask: TaskEntry = {
        taskType: taskType || currentTaskFamily || "unknown",
        taskFamily: currentTaskFamily || "",
        rawUserPrompt: currentRawUserPrompt,
        effectivePrompt: currentEffectivePrompt,
        highEntropy: highEntropy || "",
        activatedIds: [...currentActivatedIds],
        selectedEdgeIds: [...currentSelectedEdgeIds],
        routeUncertain: currentRouteUncertain,
        moeMaxScore: currentMoeMaxScore,
        ts: new Date().toISOString(),
        processLog: turnExecContext ? [turnExecContext] : [],
      };
      // Push old activeTask to stack if exists, then set new active
      if (activeTask) {
        taskStack.push(activeTask);
        if (taskStack.length > MAX_TASK_STACK) taskStack.shift(); // FIFO evict oldest
      }
      activeTask = newTask;
      dlog("HOOK", "agent_end: task pushed (isTask, HE optional)", { taskType, hasHE: !!highEntropy, taskFamily: currentTaskFamily, stackDepth: activeTask ? taskStack.length + 1 : taskStack.length });
      recordMonitorEvent({ type: "trace", action: "agent_end_task_pushed", taskType, taskFamily: currentTaskFamily || "", hasHighEntropy: !!highEntropy, stackDepth: activeTask ? taskStack.length + 1 : taskStack.length });
    } else if (activeTask && !feedbackTurn) {
      // 中间动作 append 策略(2026-09-03):
      //   ① 有 HE(已尾部定位提取) → HE 整条入 processLog(非头部 slice, 由总控 4800c 滚动兜底);
      //   ② 无 HE 且蒸馏开 → 占位后异步 LLM 蒸馏(串行队列, 反传组装前同链已排空);
      //   ③ 蒸馏不可用/失败 → 正文尾保底(保留尾部信号, 非头部截断);
      //   AI 思考过程默认排除(INCLUDE_THINKING=true 可选开启)。
      const tsTag = new Date().toISOString().slice(11, 19);
      const targetTask = activeTask;
      const heText = String(highEntropy || "").trim();
      const inFull = String(currentRawUserPrompt || "").trim();
      const body = stripThinkingText(finalAssistantText || "");
      const hasSignal = !!(heText || inFull || body || turnExecContext);
      if (hasSignal) {
        // 2026-09-04: 回合执行上下文(思考+工具链)作为独立条目 append, 与 HE/蒸馏/tail 同权——
        // 即使本回合无正文/无 HE, 只要发生过工具调用(如交易 step 后仅 tool_result)也不丢过程。
        if (turnExecContext) {
          targetTask.processLog.push(turnExecContext);
        }
        let entryText: string;
        let pendingDistill = false;
        if (heText) {
          entryText = `[${tsTag}] HE:${heText}`;          // HE 整条(总控滚动兜底, 不单条切)
        } else if (DISTILL_INTERMEDIATE && (inFull || body)) {
          entryText = `[${tsTag}] ⏳[蒸馏中]`;            // 占位 → 异步蒸馏替换
          pendingDistill = true;
        } else if (body) {
          entryText = `[${tsTag}][noHE·tail] …${body.slice(-MAX_FALLBACK_TAIL)}`;
        } else {
          entryText = `[${tsTag}][only-in] ${inFull.slice(0, MAX_FALLBACK_TAIL)}`;
        }
        if (entryText.startsWith(`[${tsTag}] HE:`) === false && entryText.length > MAX_PROCESS_ENTRY_CHARS) {
          entryText = entryText.slice(0, MAX_PROCESS_ENTRY_CHARS - 3) + "…";  // 仅非 HE 条目套单条上限
        }
        const entryIdx = targetTask.processLog.length;
        targetTask.processLog.push(entryText);
        if (pendingDistill) {
          // 异步蒸馏入串行队列(与 backward 同链: 反馈轮反传组装前必已完成); 回调校验任务与占位仍有效
          enqueueBackward(async () => {
            try {
              const sum = await distillTurnEntry(inFull, body, _ctx);
              const repl = sum
                ? `[${tsTag}] ${sum}`
                : `[${tsTag}][noHE·tail] …${(body || inFull).slice(-MAX_FALLBACK_TAIL)}`;
              if (targetTask.processLog[entryIdx] && targetTask.processLog[entryIdx].includes("蒸馏中")) {
                targetTask.processLog[entryIdx] = repl;
                recordMonitorEvent({ type: "trace", action: "agent_end_process_distilled", taskType: targetTask.taskType, entryIdx, distilledChars: repl.length, distillOk: !!sum });
              }
            } catch (e) { /* 蒸馏失败→占位保留, 不阻断 */ }
          });
        }
        // 长度保护: 条数/总字符任一超限则滚动丢最旧(保持最近过程), 并记录丢弃量供审计
        let dropped = 0;
        let totalChars = targetTask.processLog.reduce((s, e) => s + e.length, 0);
        while (totalChars > MAX_TASK_PROCESS_TOTAL_CHARS || targetTask.processLog.length > MAX_TASK_PROCESS_ENTRIES) {
          targetTask.processLog.shift();
          dropped++;
          totalChars = targetTask.processLog.reduce((s, e) => s + e.length, 0);
        }
        targetTask.activatedIds = [...currentActivatedIds];
        targetTask.selectedEdgeIds = [...currentSelectedEdgeIds];
        dlog("HOOK", "agent_end: intermediate appended to active task", { taskType: targetTask.taskType, logLen: targetTask.processLog.length, totalChars, dropped, mode: heText ? "he" : (pendingDistill ? "distill_pending" : "tail") });
        recordMonitorEvent({ type: "trace", action: "agent_end_process_appended", taskType: targetTask.taskType, logLen: targetTask.processLog.length, totalChars, dropped, feedbackTurn: false, mode: heText ? "he" : (pendingDistill ? "distill_pending" : "tail") });
        try {
          updateTrajectoryTurnMeta(turnId, {
            appended_to_task: targetTask.taskType,
            process_log_len: targetTask.processLog.length,
            process_chars: totalChars,
            process_dropped: dropped,
            process_mode: heText ? "he" : (pendingDistill ? "distill_pending" : "tail"),
          });
        } catch { /* 忽略 */ }
      }
    } else if (feedbackTurn) {
      dlog("HOOK", "agent_end: feedback turn, no append", { matchedType: _backwardPendingMatch?.taskType });
      recordMonitorEvent({ type: "trace", action: "agent_end_feedback_turn_no_append", matchedTaskType: _backwardPendingMatch?.taskType || "" });
    } else {
      dlog("HOOK", "agent_end: no active task context", { isTask, hasHighEntropy: !!highEntropy });
      recordMonitorEvent({ type: "trace", action: "agent_end_no_task_context", hasHighEntropy: !!highEntropy, answerChars: finalAssistantText.length });
    }

    // 回填轨迹行任务元信息(he_is_task/he_task_type/in_stack), 供 8766 轨迹页展示
    try {
      updateTrajectoryTurnMeta(turnId, {
        he_is_task: isTaskStart,
        he_task_type: taskType || "",
        in_stack: isTaskStart,   // 入栈不再要求 HighEntropy(isTask 即登记)
        task_phase: isTaskStart ? "task_start" : (feedbackTurn ? "feedback" : (activeTask ? "intermediate_append" : "none")),
        // 2026-09-04: 轨迹行回填回合执行上下文(思考+工具链)——tool_result/AI 思考与回答同权可见
        // 2026-09-15 n8 第十一轮：落盘不再掐断——原 tools 上限 2400c 会把 9009B 的 /api/prompt
        // 响应砍剩 27%，这是「轨迹收集不完全」的直接原因。落盘以「完整采集」为准，
        // 长度控制交给条目数上限(currentTurnTools ≤ 40)。
        // 2026-09-15 n8 第十四轮：轨迹落盘不再掐断（第三处静默 slice 已消除）——
        //   ① tools 单条超 cap 显式标 `…[+Nc/Nc]`，条目溢出记 dropped_oldest 而非静默 shift；
        //   ② thinking 尾部保留 8000 且附全量字符数与截断标志（损失可观测）；
        //   ③ toolsFidelity/thinkingFidelity 统计一并落盘，构成「信息未被 slice」的可核对物证。
        thinking: (currentTurnThinking || "").slice(0, 8000),
        thinkingFullChars: thinkingFidelity?.chars ?? 0,
        thinkingTruncated: thinkingFidelity?.truncated ?? false,
        tools: turnTools.join(" ⏎ "),
        toolsChars: turnTools.join(" ⏎ ").length,
        toolsFidelity,
      });
    } catch { /* 忽略 */ }
    // 保真度可观测：任一静默损失（单条截断/条目溢出）均显式落事件，供下一轮验收直接断言
    try {
      recordMonitorEvent({
        type: "trace", action: "trajectory_tools_fidelity",
        taskFamily: currentTaskFamily || "",
        ...toolsFidelity,
        thinkingChars: thinkingFidelity?.chars ?? 0,
        thinkingTruncated: thinkingFidelity?.truncated ?? false,
      });
    } catch { /* 忽略 */ }

    // ── Persist taskStack to disk ──
    try {
      ensureDir(path.dirname(LAST_STATE_PATH));
      const allTasks = activeTask ? [activeTask, ...taskStack] : taskStack;
      // 落盘契约收敛到 serializeTaskForState（单一事实来源）：rawUserPrompt 一并持久化，
      // 否则重启后反传「任务侧」永久退化为 HE 摘要（见 lifecycle_context.ts 顶部说明）。
      const _persistOpts = { maxProcessEntries: MAX_TASK_PROCESS_ENTRIES, maxProcessEntryChars: MAX_PROCESS_ENTRY_CHARS, highEntropyCap: 2400 };
      const toPersist = {
        activeTask: activeTask ? serializeTaskForState(activeTask, _persistOpts) : null,
        taskStack: taskStack.map(t => serializeTaskForState(t, _persistOpts)),
        at: new Date().toISOString(),
      };
      dlog("STATE", "persisting to disk", { file: LAST_STATE_PATH, activeType: toPersist.activeTask?.taskType || 'null', stackTypes: toPersist.taskStack.map((t:any) => t.taskType), totalCount: allTasks.length });
      writeJson(LAST_STATE_PATH, toPersist);
      const _pAll = [toPersist.activeTask, ...toPersist.taskStack].filter(Boolean) as any[];
      recordMonitorEvent({ type: "trace", action: "task_stack_persisted", activeTask: !!activeTask, stackDepth: taskStack.length, activeType: activeTask?.taskType || '', stackTypes: taskStack.map(t => t.taskType), rawPromptCount: _pAll.filter((t) => (t.rawUserPrompt || "").length > 0).length, rawPromptChars: _pAll.reduce((a, t) => a + (t.rawUserPrompt || "").length, 0) });
    } catch (e) {
      recordMonitorEvent({ type: "trace", action: "task_stack_persist_failed", error: preview(e instanceof Error ? e.message : String(e), 220) });
    }

    // ── Deferred backward: run with fresh HighEntropy from assistant response ──
    console.error(`[textron] agent_end backward check: match=${!!_backwardPendingMatch}, HE=${currentAssistantHighEntropy.length}c, text=${finalAssistantText.length}c`);
    if (_backwardPendingMatch && (currentAssistantHighEntropy || finalAssistantText)) {
      const matched = _backwardPendingMatch;
      const backwardCtx = _backwardPendingCtx;
      _backwardPendingMatch = null;
      _backwardPendingCtx = null;
      // 2026-08-19 关键修复: Textron 不应阻塞 agent_end 事件分发。
      // 原同步 await forcedSemanticBackward(LLM 调用 840ms+) 拉长 isStreaming 窗口:
      // local-coms 回复先发→sender 以为空闲→下一条 followUp 排队→before_agent_start 不触发→配对失效。
      // 改为异步执行; 上下文立即捕获(异步时模块级变量会被下一条消息覆盖); 串行队列防并发写网络文件。
      const _capturedHE = currentAssistantHighEntropy;
      const _capturedText = finalAssistantText;
      const _capturedRaw = currentRawUserPrompt;
      setTimeout(() => {
        enqueueBackward(async () => {
      const backwardTaskContext = buildBackwardTaskContext({
        rawPrompt: matched.rawUserPrompt,
        effectivePrompt: matched.effectivePrompt,
        highEntropy: matched.highEntropy,
        processLog: matched.processLog || [],
      });
      // 过程上下文(中间动作累积, 受限)附加到任务上下文之后, 保证 backward LLM 能看到完整执行链
      const processCtx = backwardTaskContext.processContext;
      const capturedPrevTask = backwardTaskContext.previousTaskForBackward +
        (processCtx ? `\n\n[任务过程 · 中间动作累积 ${(matched.processLog || []).length} 条, 限长后 ${processCtx.length}c]\n${processCtx}` : "");
      const capturedHighEntropy = matched.highEntropy;
      const capturedTF = matched.taskFamily || "astro_stock_prediction";
      const capturedIDs = matched.activatedIds;
      const capturedEdges = matched.selectedEdgeIds;

      // 2026-09-15（用户指令）：**删除 no_domain_evidence 预闸门**。
      // 它本质是词表白名单（hasNewDomainEvidence：≥60 字 ∧ 结果|根因|修复|验证|总结|复盘…），
      // 词表偏工程语而**缺交易结果词**（盈利/亏损/收益/回撤/成交/未成交），且依赖未持久化的
      // rawPrompt ⇒ 重启后恒 false；与 HE 未捕获叠加即**静默跳过整轮反传**
      // （实测今日 stock_alpha 轨迹大量 {ran:false,status:'skipped',reason:'no_domain_evidence'}）。
      // 判官职责本就属于反传内部的 LLM（goal guard + keep/drop/merge + node_actions），
      // 外层再套硬编码预判只会丢学习信号。此处只保留可观测，不做判断。
      {
        // learningPromptSource 是「任务侧素材是否退化」的判定信号：raw_prompt=任务原文入反传；
        // high_entropy=原文缺失、退化为 HE 摘要（第十三轮修复前重启后必为 high_entropy）。
        recordMonitorEvent({ type: "trace", action: "semantic_backward_entered", taskFamily: capturedTF, hasHighEntropy: !!capturedHighEntropy, promptChars: backwardTaskContext.previousTaskForBackward.length, learningPromptSource: backwardTaskContext.learningPromptSource, rawPromptChars: backwardTaskContext.rawPromptChars, placeholderRetryPrompt: backwardTaskContext.placeholderRetryPrompt, matchedTaskTs: matched.ts, matchedPromptChars: (matched.rawUserPrompt || "").length });
        // Inject current assistant's HighEntropy (经验总结) into feedback context
        // 2026-09-03: 反馈轮 content 全量(不 slice); AI 思考默认排除(INCLUDE_THINKING=true 可选)
        const assistantAnalysis = _capturedHE || stripThinkingText(_capturedText || "");
        const enhancedFeedback = _capturedRaw + "\n\nAssistant's analysis (from HighEntropy):\n" + assistantAnalysis;

        const startedAt = new Date().toISOString();
        const semanticRunId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        lastBackwardState = {
          taskFamily: capturedTF, action: "semantic_backward", status: "running",
          runId: semanticRunId, activatedIds: capturedIDs, selectedEdgeIds: capturedEdges,
          hasHighEntropy: !!capturedHighEntropy, matchedTaskType: matched.taskType,
          previousTaskChars: capturedPrevTask.length, feedbackChars: enhancedFeedback.length,
          processChars: (processCtx || "").length, processEntries: (matched.processLog || []).length,
          mode: "agent_end_deferred",
          startedAt, at: startedAt,
        };
        recordMonitorEvent({ type: "update", taskFamily: capturedTF, action: "semantic_backward_start", ...lastBackwardState });
        broadcast({ type: "update", taskFamily: capturedTF, action: "semantic_backward_start", ...lastBackwardState });
        log(`Textron semantic backward (agent_end): status=running runId=${semanticRunId}, matchedTaskType=${matched.taskType}, path=${capturedIDs.join("->") || "(none)"}`);
        let bwResult: any = null;
        try {
          // 2026-08-03: 第三参由硬编码 "" → capturedHighEntropy。旧写法使预测轮 HighEntropy 永远到不了
          // backward（llm_start hasHighEntropy 恒 false、训练包恒 invalid/missing），Function 块无通路落盘。
          bwResult = await forcedSemanticBackward(capturedTF, capturedPrevTask, capturedHighEntropy, enhancedFeedback, capturedIDs, capturedEdges, backwardCtx, { routeUncertain: matched.routeUncertain, moeMaxScore: matched.moeMaxScore }, turnId);
        } catch (e) {
          const failedAt = new Date().toISOString();
          const errMsg = e instanceof Error ? e.message : String(e);
          const errStack = e instanceof Error ? e.stack : String(e);
          lastBackwardState = { ...lastBackwardState, status: "failed", error: errMsg, stack: preview(errStack, 500), at: failedAt };
          log(`Textron semantic backward (agent_end): status=failed runId=${semanticRunId}, error=${errMsg}`);
          console.error(`[textron] backward crash stack:`, errStack);
          recordMonitorEvent({ type: "update", taskFamily: capturedTF, action: "semantic_backward_failed", ...lastBackwardState });
        }

        // 回填对话行 backward 结果(UI 对话记录直接可见是否反传 + reward)
        updateTrajectoryTurnBackward(turnId, {
          ran: true,
          status: bwResult ? "done" : "failed",
          runId: semanticRunId,
          reward: bwResult ? Number(bwResult.reward) : null,
          llmReward: bwResult ? Number(bwResult.llmReward) : null,
          rationale: (bwResult && bwResult.rationale) || "",
          nodesUpdated: (bwResult && bwResult.nodesUpdated) || 0,
          nodesAdded: (bwResult && bwResult.nodesAdded) || 0,
          nodesMerged: (bwResult && bwResult.nodesMerged) || 0,
          mode: "agent_end_deferred",
          consumed: !!bwResult,   // 绑定即出栈: backward 成功执行后任务从栈移除
          processEntries: (matched.processLog || []).length,
          error: (!bwResult && lastBackwardState.status === "failed" && lastBackwardState.error) || undefined,
        });

        const hadLearning = bwResult && (bwResult.nodesUpdated > 0 || bwResult.nodesAdded > 0 || bwResult.nodesMerged > 0);
        const hadReward = bwResult && Math.abs(bwResult.reward || 0) >= 0.05;
        // 2026-09-03: 绑定即出栈——只要 backward 成功执行(配对确认), 任务立即关闭并移出栈,
        // 杜绝旧"no learning→preserve"逻辑造成的僵尸任务截胡后续所有配对。
        // hadLearning/hadReward 仅作审计诊断, 不再决定是否出栈。
        const shouldConsume = !!bwResult;

        if (shouldConsume) {
          recordMonitorEvent({ type: "trace", action: "agent_pending_state_cleared", taskFamily: capturedTF, reason: "backward_consumed_at_agent_end", runId: semanticRunId, matchedTaskType: matched.taskType, hadLearning: !!hadLearning, hadReward: !!hadReward, reward: bwResult?.reward });
          // Remove matched task from stack
          const allPend = activeTask ? [activeTask, ...taskStack] : [...taskStack];
          const bmIdx = allPend.findIndex(t => t === matched || t.highEntropy === matched.highEntropy || t.processLog === matched.processLog);
          if (bmIdx === 0 && activeTask) {
            activeTask = taskStack.length > 0 ? taskStack.shift()! : null;
          } else {
            const sIdx = activeTask ? bmIdx - 1 : bmIdx;
            if (sIdx >= 0 && sIdx < taskStack.length) taskStack.splice(sIdx, 1);
          }
          dlog("BACKWARD", "agent_end: task consumed from stack", { consumedIdx: bmIdx, remainingActive: activeTask?.taskType || 'null', remainingStack: taskStack.map(t => t.taskType) });
        } else {
          dlog("BACKWARD", "agent_end: backward failed, pending preserved for retry", { matchedType: matched.taskType });
          recordMonitorEvent({ type: "trace", action: "agent_pending_preserved_backward_failed", taskFamily: capturedTF, reason: "backward_failed_at_agent_end", matchedTaskType: matched.taskType });
        }
      }
        });
      }, 0);
    } else {
      console.error(`[textron] agent_end backward SKIPPED: match=${!!_backwardPendingMatch}, HE=${!!currentAssistantHighEntropy}, text=${!!finalAssistantText}`);
      recordMonitorEvent({ type: "trace", action: "agent_end_backward_skipped", reason: !_backwardPendingMatch ? "no_pending_match" : "no_assistant_content", hasMatch: !!_backwardPendingMatch, hasHighEntropy: !!currentAssistantHighEntropy, hasFinalText: !!finalAssistantText });
    }
    } catch (hookErr) {
      console.error(`[textron] agent_end hook crashed:`, hookErr);
    }
  });

  // ══════════════════════════════════════════════════════════════════
  // MANUAL MODE: Textron tool (for explicit control / inspection)
  // ══════════════════════════════════════════════════════════════════

  pi.registerTool({
    name: "Textron",
    label: "Textron",
    description: "Textron text neural network — auto context graph. L0 nodes injected each turn; LLM scores relevance → programmatic edge propagation → compiled context. Manual actions: status/list (inspect), init (new network), backward (train). Node Content Rule: information-dense reusable transferable knowledge (≤1000 chars), NOT raw logs or session summaries.",
    promptSnippet: "Textron: auto-injects L0 nodes each turn. Call activate with L0 attention scores → programmatic propagation compiles context. Use backward to train.",
    promptGuidelines: [
      "Textron forward+propagate runs automatically each turn — L0 nodes are scored by LLM internally, context is already injected. No manual activation needed.",
      "Learning is automatic: the lifecycle hook runs backward after a substantive result message; do not call Textron backward manually for normal tasks.",
      "Node content MUST be high-entropy: compressed, reusable insights, not raw output. Never store session summaries, tool listings, or file manifests.",
      "If no network matches, Textron init/backward expands the best existing network; new networks are only created when none exist.",
    ],
    parameters: Type.Object({
      action: StringEnum(["status", "list", "init", "backward"] as const),
      taskFamily: Type.Optional(Type.String({ description: "Task family name" })),
      layers: Type.Optional(Type.String({ description: "Comma-separated node counts per layer, preferably front-narrow/back-wide, e.g. '4,6,8' (for init)" })),
      threshold: Type.Optional(Type.Number({ description: "Activation threshold (for init)" })),
      learningRate: Type.Optional(Type.Number({ description: "Learning rate (for init)" })),
      feedback: Type.Optional(Type.String({ description: "Feedback: 'success', 'failure', or correction text (for backward)" })),
      activatedNodes: Type.Optional(Type.String({ description: "JSON array of activated node IDs from forward pass (for backward)" })),
      filledNodes: Type.Optional(Type.String({ description: "JSON: {'node_id': 'knowledge crystal', ...} — high-entropy reusable principles only (≤100 chars). NOT raw logs, session summaries, or tool listings (for backward)" })),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const taskFamilyParam = params.taskFamily || currentTaskFamily || "";
      let tf = taskFamilyParam;

      dlog("TOOL", `Textron tool called: action=${params.action}`, { taskFamily: tf, action: params.action });
      switch (params.action) {
        // ── STATUS ────────────────────────────────────────────────
        case "status": {
          const networks = listNetworks();
          let text = `## Textron Status\n\n`;

          if (currentTaskFamily) {
            text += `**Active network**: \`${currentTaskFamily}\`\n`;
            text += `**Activated nodes this turn**: ${currentActivatedIds.length > 0 ? currentActivatedIds.join(", ") : "(fresh network, no nodes active)"}\n\n`;
          } else {
            text += `No auto-activated network this session.\n\n`;
          }

          text += `### All Networks (${networks.length})\n\n`;
          if (networks.length === 0) {
            text += `None yet. Networks are auto-created when you work on tasks.\n`;
          } else {
            for (const name of networks) {
              const hp = readJson<Hyperparams>(path.join(TEXTRON_HOME, name, "hyperparams.json"), DEFAULT_HYPERPARAMS);
              const net = loadNetwork(name);
              const ng = net ? getNgramStats(net) : { stateFiles: 0, totalActivations: 0, successfulActivations: 0, distillReady: 0 };
              text += `- **${name}**: [${hp.layers.join(",")}] thr=${hp.threshold} lr=${hp.learningRate} growth=${TEXTRON_ALLOW_NODE_GROWTH ? "on" : "frozen"} ngram=${NGRAM_DISTILL_PROMOTE ? "promote" : "shadow"} states=${ng.stateFiles} act=${ng.totalActivations}/${ng.successfulActivations} ready=${ng.distillReady}\n`;
            }
          }

          return {
            content: [{ type: "text", text }],
            details: { action: "status", active: currentTaskFamily, activatedIds: currentActivatedIds, networks },
          };
        }

        // ── LIST ──────────────────────────────────────────────────
        case "list": {
          const networks = listNetworks();
          if (networks.length === 0) {
            return {
              content: [{ type: "text", text: "No Textron networks yet. Networks are auto-created when you work on tasks." }],
              details: { action: "list", networks: [] },
            };
          }
          let text = `## Textron Networks (${networks.length})\n\n`;
          for (const name of networks) {
            const hp = readJson<Hyperparams>(path.join(TEXTRON_HOME, name, "hyperparams.json"), DEFAULT_HYPERPARAMS);
            // Count non-empty nodes
            let filled = 0, total = 0;
            for (let l = 0; l < hp.layers.length; l++) {
              for (let n = 0; n < hp.layers[l]; n++) {
                total++;
                const c = readNodeContent(path.join(TEXTRON_HOME, name, `layer_${l}`, `node_${n}.html`));
                if (c) filled++;
              }
            }
            const net = loadNetwork(name);
            const ng = net ? getNgramStats(net) : { stateFiles: 0, totalActivations: 0, successfulActivations: 0, distillReady: 0 };
            text += `- **${name}**: [${hp.layers.join(",")}] ${filled}/${total} nodes filled, thr=${hp.threshold}, growth=${TEXTRON_ALLOW_NODE_GROWTH ? "on" : "frozen"}, ngram=${NGRAM_DISTILL_PROMOTE ? "promote" : "shadow"}, ngramStates=${ng.stateFiles}, ngramAct=${ng.totalActivations}/${ng.successfulActivations}, distillReady=${ng.distillReady}\n`;
          }
          return { content: [{ type: "text", text }], details: { action: "list", networks } };
        }

        // ── INIT ──────────────────────────────────────────────────
        // Expand best existing network instead of creating a new empty one.
        // Textron learns better by growing one network's L0/L1 node pool across tasks
        // than fragmenting into many empty networks.
        case "init": {
          if (!tf) return { content: [{ type: "text", text: "Error: taskFamily required" }], details: { error: "missing taskFamily" } };
          const allNets = listNetworks();
          if (allNets.length === 0) {
            // No networks at all — create the first one.
            const layers = params.layers
              ? params.layers.split(",").map((s) => parseInt(s.trim(), 10)).filter((n) => !isNaN(n) && n > 0)
              : DEFAULT_HYPERPARAMS.layers;
            if (layers.length < 2) return { content: [{ type: "text", text: "Error: need at least 2 layers" }], details: { error: "too few layers" } };
            const hp = initNetwork(tf, layers, params.threshold ?? DEFAULT_HYPERPARAMS.threshold, params.learningRate ?? DEFAULT_HYPERPARAMS.learningRate, log);
            broadcast({ type: "update", taskFamily: tf, action: "init" });
            return {
              content: [{ type: "text", text: `Created first Textron network "${tf}"\nLayers: [${layers.join(",")}] → ${layers.reduce((a,b)=>a+b,0)} nodes\nThreshold: ${hp.threshold}\nLearning Rate: ${hp.learningRate}` }],
              details: { action: "init", taskFamily: tf, layers },
            };
          }
          // Existing networks exist — expand the best match with L0 nodes for new domain.
          const best = autoRouteNetwork(tf, allNets) || allNets[0];
          const net = loadNetwork(best);
          if (!net) return { content: [{ type: "text", text: `Network "${best}" not found` }], details: { error: "not found" } };
          const layerCount = params.layers
            ? parseInt(params.layers.split(",")[0], 10) || 2
            : 2;
          for (let i = 0; i < Math.min(layerCount, 2); i++) {
            addPolicyNode(net, i, `Route: ${tf} — ${params.threshold ? 'thr=' + params.threshold : ''}`, log);
          }
          log(`Textron: expanded network "${best}" with ${Math.min(layerCount, 2)} L0/L1 nodes for "${tf}" instead of creating new network`);
          return {
            content: [{ type: "text", text: `Expanded network "${best}" with new nodes for "${tf}" (new networks only created when none exist).` }],
            details: { action: "init", taskFamily: tf, expandedNetwork: best },
          };
        }

        // ── BACKWARD ────────────────────────────────────────────────
        case "backward": {
          dlog("BACKWARD", "manual backward requested", { taskFamily: tf, feedback: params.feedback, hasFilledNodes: !!params.filledNodes });
          if (!tf || !params.feedback) return { content: [{ type: "text", text: "Error: taskFamily and feedback required" }], details: { error: "missing params" } };

          // Expand existing best-match network instead of creating a new empty one.
          // New empty networks fragment Textron's knowledge; adding L0/L1 nodes to the
          // closest network preserves cross-task transfer.
          if (!networkExists(tf)) {
            const routePrompt = params.feedback || tf;
            const allNets = listNetworks();
            const best = allNets.length > 0 ? autoRouteNetwork(routePrompt, allNets) : null;
            const targetNet = best && networkExists(best) ? best : (allNets[0] || tf);
            if (!networkExists(targetNet)) {
              // No networks at all — create first one.
              if (listNetworks().length >= 10) {
                return { content: [{ type: "text", text: `Cannot create "${tf}": 10-network cap reached.` }], details: { error: "cap reached" } };
              }
              initNetwork(targetNet, DEFAULT_HYPERPARAMS.layers, DEFAULT_HYPERPARAMS.threshold, DEFAULT_HYPERPARAMS.learningRate, log);
            } else {
              // Add L0 and L1 nodes to existing network to cover new task domain
              const net = loadNetwork(targetNet);
              if (net) {
                tf = targetNet; // Redirect to existing network
                const l0Content = `Route: ${params.feedback || tf}`;
                addPolicyNode(net, 0, l0Content, log);
                addPolicyNode(net, 1, `Rule for ${tf}: ${params.feedback || "expand task coverage"}`, log);
                log(`Textron: expanded network "${targetNet}" with new nodes for "${tf}" instead of creating new network`);
              }
            }
          }

          const net = loadNetwork(tf);
          if (!net) return { content: [{ type: "text", text: "Network not found" }], details: { error: "not found" } };

          let ids: string[] = [];
          if (params.activatedNodes) { try { ids = JSON.parse(params.activatedNodes); } catch {} }

          const fb = params.feedback.toLowerCase();
          const reward = fb.includes("success") || fb.includes("对") || fb.includes("好") ? 1.0
            : fb.includes("fail") || fb.includes("错") || fb.includes("wrong") ? -0.5 : 0.0;

          const activeIds = ids.length > 0 ? ids : currentActivatedIds;
          // Use reward directly — no external credit adjustment needed.
          const bwResult = autoBackward(net, activeIds, reward, log, currentSelectedEdgeIds, undefined, undefined, undefined, undefined);
          broadcast({ type: "update", taskFamily: tf, action: "backward", reward, changedEdges: bwResult.changedEdges });

          // Fill/update nodes — supports "L<N>::node_X" layer-qualified keys and legacy flat keys
          // Existing nodes get their content UPDATED (not just filled when empty)
          // New node IDs (beyond current layer size) are created dynamically
          let fillMsg = "";
          let manualChangedNodes: { id: string; oldContent: string; newContent: string; oldName: string; newName: string }[] = [];
          if (params.filledNodes) {
            try {
              const filled = JSON.parse(params.filledNodes) as Record<string, string>;
              let newCount = 0, updateCount = 0, skippedCount = 0;
              const skipReasons: string[] = [];
              const changedNodes: { id: string; oldContent: string; newContent: string; oldName: string; newName: string }[] = [];
              for (const [rawKey, rawContent] of Object.entries(filled)) {
                const parsed = parseLayerNodeId(rawKey);
                const validation = validateKnowledgeCrystal(rawContent, parsed?.layer);
                if (!validation.ok) {
                  // Scale-rescue: rejection = wrong scale, not garbage (Wang–Zahl).
                  const rescue = rescaleRejectedCrystal(net, rawContent, validation.reason, parsed?.layer ?? net.hyperparams.layers.length - 1, log, addPolicyNode, recordArtifactEvent);
                  skippedCount++;
                  skipReasons.push(`${rawKey}:${validation.reason}${rescue ? `→rescale:${rescue.action}` : ""}`);
                  log(`Textron: skipped low-entropy filledNode ${rawKey} (${validation.reason})${rescue?.rescued ? ` [rescued:${rescue.action}]` : ""}`);
                  continue;
                }
                const content = validation.content;
                if (parsed !== null) {
                  const similar = findSimilarKnowledgeNode(net, compressNodeName(content), content, 0.40, parsed.layer, parsed.nodeId);
                  if (similar) {
                    const similarKey = `L${similar.layer}::${similar.nodeId}`;
                    const oldPath = path.join(net.path, `layer_${similar.layer}`, `${similar.nodeId}.html`);
                    const old = readNodeContent(oldPath);
                    const oldName = readNodeName(oldPath);
                    updateExistingNodeByPolicy(net, similar.layer, similar.nodeId, compressNodeName(content), content, log);
                    const updated = readNodeContent(oldPath);
                    changedNodes.push({ id: similarKey, oldContent: preview(old, 220), newContent: preview(updated, 220), oldName: preview(oldName, 100), newName: preview(readNodeName(oldPath), 100) });
                    updateCount++;
                    log(`Textron: merged filledNode ${rawKey} into similar ${similarKey} (${(similar.score*100).toFixed(0)}%)`);
                    continue;
                  }
                  // Layer-qualified: L<N>::node_X — fill/update exact layer, after quality gate.
                  const np = path.join(net.path, `layer_${parsed.layer}`, `${parsed.nodeId}.html`);
                  if (fs.existsSync(np)) {
                    const old = readNodeContent(np);
                    const oldName = readNodeName(np);
                    const outEdges = (net.weights.layer_connections[`${parsed.layer}_to_${parsed.layer + 1}`] || []).filter(e => e.from === parsed.nodeId).map(e => ({ toId: e.to, weight: e.weight }));
                    const merged = mergeContent(old, content);
                    writeNodeHtml(np, parsed.layer, parsed.nodeId, merged, outEdges, compressNodeName(merged));
                    changedNodes.push({ id: rawKey, oldContent: preview(old, 220), newContent: preview(merged, 220), oldName: preview(oldName, 100), newName: preview(compressNodeName(merged), 100) });
                    if (old) updateCount++; else newCount++;
                  } else {
                    // Node doesn't exist — dynamically create it (must be next sequential, no gaps)
                    const nodeIndex = parseInt(parsed.nodeId.replace('node_', ''), 10);
                    if (!isNaN(nodeIndex) && nodeIndex >= 0 && nodeIndex === net.hyperparams.layers[parsed.layer]) {
                      const created = addPolicyNode(net, parsed.layer, content, log, compressNodeName(content), parsed.nodeId);
                      if (created.added || created.replaced) newCount++;
                      else if (created.merged) updateCount++;
                      else if (created.skipped) { skippedCount++; skipReasons.push(`${rawKey}:${created.reason || "frozen_skip"}`); }
                    }
                  }
                } else {
                  // Legacy flat key — fill/update the first matching node found across all layers
                  let handled = false;
                  for (let l = 0; l < net.hyperparams.layers.length; l++) {
                    const np = path.join(net.path, `layer_${l}`, `${rawKey}.html`);
                    if (fs.existsSync(np)) {
                      const layerValidation = validateKnowledgeCrystal(content, l);
                      if (!layerValidation.ok) {
                        // Scale-rescue: rejection = wrong scale, not garbage (Wang–Zahl).
                        const rescue = rescaleRejectedCrystal(net, content, layerValidation.reason, l, log, addPolicyNode, recordArtifactEvent);
                        skippedCount++;
                        skipReasons.push(`${rawKey}:L${l}:${layerValidation.reason}${rescue ? `→rescale:${rescue.action}` : ""}`);
                        log(`Textron: skipped low-entropy filledNode ${rawKey} for L${l} (${layerValidation.reason})${rescue?.rescued ? ` [rescued:${rescue.action}]` : ""}`);
                        handled = true;
                        break;
                      }
                      const old = readNodeContent(np);
                      const oldName = readNodeName(np);
                      const outEdges = (net.weights.layer_connections[`${l}_to_${l + 1}`] || []).filter(e => e.from === rawKey).map(e => ({ toId: e.to, weight: e.weight }));
                      const merged = mergeContent(old, content);
                      writeNodeHtml(np, l, rawKey, merged, outEdges, compressNodeName(merged));
                      changedNodes.push({ id: `L${l}::${rawKey}`, oldContent: preview(old, 220), newContent: preview(merged, 220), oldName: preview(oldName, 100), newName: preview(compressNodeName(merged), 100) });
                      if (old) updateCount++; else newCount++;
                      handled = true;
                      break;
                    }
                  }
                  // If no matching node found, try to create via layer policy after quality gate.
                  if (!handled) {
                    const nodeIndex = parseInt(rawKey.replace('node_', ''), 10);
                    if (!isNaN(nodeIndex) && nodeIndex >= 0) {
                      const created = addPolicyNode(net, undefined, content, log, compressNodeName(content), undefined, { mergeSimilar: true, similarityThreshold: 0.40 });
                      if (created.merged) updateCount++;
                      else if (created.added || created.replaced) newCount++;
                      else if (created.skipped) { skippedCount++; skipReasons.push(`${rawKey}:${created.reason || "frozen_skip"}`); }
                    }
                  }
                }
              }
              const parts: string[] = [];
              if (newCount > 0) parts.push(`${newCount} new`);
              if (updateCount > 0) parts.push(`${updateCount} updated`);
              if (skippedCount > 0) parts.push(`${skippedCount} skipped`);
              manualChangedNodes = changedNodes;
              if (changedNodes.length > 0) {
                for (const ch of changedNodes.slice(0, 8)) {
                  log(`Textron manual backward node ${ch.id}: "${ch.oldContent}" -> "${ch.newContent}"`);
                }
              }
              recordMonitorEvent({ type: "update", taskFamily: tf, action: "manual_backward_node_update", reward, changedEdges: bwResult.changedEdges, changedNodes, newCount, updateCount, skippedCount, skipReasons: skipReasons.slice(0, 8) });
              broadcast({ type: "update", taskFamily: tf, action: "manual_backward_node_update", reward, changedEdges: bwResult.changedEdges, changedNodes, newCount, updateCount, skippedCount, skipReasons: skipReasons.slice(0, 8) });
              if (parts.length > 0) fillMsg = `\nNodes: ${parts.join(", ")}.${skipReasons.length ? ` Skipped: ${skipReasons.slice(0, 3).join("; ")}` : ""}`;
            } catch {}
          }

          return {
            content: [{ type: "text", text: `Backward: "${tf}" reward=${reward.toFixed(1)}.${fillMsg}` }],
            details: { action: "backward", taskFamily: tf, reward, changedEdges: bwResult.changedEdges, changedNodes: manualChangedNodes },
          };
        }

        default:
          return { content: [{ type: "text", text: `Unknown action: ${(params as any).action}` }], details: { error: "unknown action" } };
      }
    },

    renderCall(args, theme, _context) {
      const a = (args as any).action || "";
      const icon = a === "status" ? "📊" : a === "list" ? "📋" : a === "init" ? "✨" : a === "backward" ? "🔄" : "";
      const label = a.charAt(0).toUpperCase() + a.slice(1);
      const tf = (args as any).taskFamily || "";
      return new Text(theme.fg("accent", `${icon} Textron ${label}`) + (tf ? theme.fg("muted", ` ${tf}`) : ""), 0, 0);
    },
  });
}
