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
import { buildBackwardTaskContext } from "./lifecycle_context";
import { chooseTaskFamilyRoute } from "./learning_policy";
import { assistantMessageText, extractHighEntropy, extractLatestHighEntropyFromMessages, parseHighEntropyCrystal } from "./highentropy";
import { distillNodeName, buildAtomKey } from "./name_distill.ts";
import { applyExplorationPolicy, buildLocalScores, lexicalRelevance, parseNodeScores, rankLayerWithExploration } from "./scoring_policy";
import { routeL0ThroughMoe } from "./moe_router.ts";
import { decideNoveltyExpansion } from "./novelty_policy.ts";
import { DEFAULT_COMPILED_CONTEXT_MAX_CHARS, NODE_CONTENT_MAX_CHARS } from "./content_limits.ts";

// ─── Lib modules ────────────────────────────────────────────────
import { ensureDir, readJson, writeJson, ts, dlog, clamp, completeContent,
         parseLayerNodeId, seedRandom, formatNodesForLLM, previewText } from "./lib/utils";
import { shannonEntropy, wordEntropy, isTruncated, isTemporalSummary, isMetaInstruction } from "./lib/entropy";
import { readNodeContent, compressNodeName, readNodeName, writeNodeHtml,
         validateKnowledgeCrystal, intraLayerOrthogonalityCheck,
         isNgramFragmentContent, contextSimilarity, prepareContextLine } from "./lib/node_io";
import { normalizeMergeFragment, mergeDistinctContentFragments,
         mergeNodeContent, mergeContent } from "./lib/merge";
import { tfidfTokens, buildTfidfIndex, cosineSim, tfidfSimilarity,
         nameTokens, jaccard, tokenSimilarity, findSimilarNode, findSimilarKnowledgeNode } from "./lib/similarity";
import { TEXTRON_HOME, DEFAULT_HYPERPARAMS, DEFAULT_WEIGHT, NGRAM_DISTILL_PROMOTE,
         TEXTRON_ALLOW_NODE_GROWTH, getTaskFamilyPath, networkExists, listNetworks,
         initNetwork, loadNetwork } from "./lib/network";
import { compileContext, selectedEdgeIdToWeightKey } from "./lib/compile";
import { computePageRank } from "./lib/pagerank";
import { RESCALE_DOWN_REASONS, RESCALE_UP_REASONS, RESCALE_PENDING_LIMIT,
         RESCALE_PAIR_MIN_SIM, rescalePendingPath, readRescalePending,
         writeRescalePending, tryUpscalePair, rescaleRejectedCrystal,
         type RescalePendingItem } from "./lib/rescale";
import { setRecordArtifactEvent, chooseExpansionLayer, updateExistingNodeByPolicy,
         addPolicyNode, compactMergeEmptiedNodes, compactEmptyNodes, addDynamicNode } from "./lib/node_policy";

// ─── Types ──────────────────────────────────────────────────────────

interface Hyperparams {
  layers: number[];
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

const HIGH_ENTROPY_INSTRUCTION = `

## Textron HighEntropy Output Contract
At the very end of your final user-facing answer, append exactly one XML block. **NEVER skip this block** — even for short replies like "收到" or brief summaries. Textron backward consumes it as training data; missing HighEntropy = lost learning opportunity.
<HighEntropy>
Name: ≤48 chars. Join 3-6 highest-entropy ORIGINAL terms lifted from Task+Technique (identifiers, domain signals, key numbers). Routing sees only Name, so avoid generic summary sentences or prefix truncation.
TaskType: ≤15 chars. Task category label for feedback matching, e.g. "A股涨跌预测" "Textron协议修复" "代码审查". Write in the language of the task domain.
isTask: true|false. Whether this reply is part of a task that may receive follow-up feedback. true = save to taskStack for later backward matching; false = intermediate/transient reply, do not push.
Task: ≤100 chars. State the concrete problem being solved: object, goal, and decisive constraint. Do not narrate steps taken.
Technique: ≤500 chars. **CRITICAL for reflection/feedback replies**: pack root cause analysis AND corrective rules into this field. Preserve the highest-information "道或术" used to solve the task: reusable principle plus concrete method, causal mechanism, decision boundary, failure correction, and validation signal. Prefer the answer's most information-dense sentences and distinctive vocabulary; keep exact identifiers/numbers when they change future decisions. No raw logs, file lists, URLs, vague progress, or boilerplate.
<Function> OPTIONAL block — emitted IN ADDITION to the 5 fields above (they stay unchanged). Function = 从本轮解法蒸馏的可执行代码。
1. Functionability self-check (ALL 3 yes → emit; else omit the block entirely): ① Will this task family recur (loop / repeated executions)? ② Is the input parameterizable (structured data: quotes / horoscope / error codes / metrics)? ③ Is the output objectively verifiable (an actual result exists to check against)? One-off creative tasks (PPT, drawing, copywriting) → omit.
2. Emit exactly two fields:
functionSymbol: short snake_case symbol name mirroring Name's core terms — later node contents cite it verbatim (substring-matchable), enabling citation-chain routing.
functionAbstract: generalized executable code distilled from THIS round's solution path — concrete numbers → params, solution steps → function body. Distill the 术 (reusable computation), never narrate the session.
3. NO action/target/version/diff metadata, NO rule-number maintenance — create/modify/dedup/version evolution is backward+merge's system job. The LLM only distills code; same-symbol functions merge and evolve naturally in the network.
</Function>
</HighEntropy>`;

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
  }
  const MAX_TASK_STACK = 5;
  let activeTask: TaskEntry | null = null;
  let taskStack: TaskEntry[] = [];  // FIFO, max MAX_TASK_STACK
  let lastBackwardState: Record<string, unknown> | null = null;
  let _backwardPendingMatch: TaskEntry | null = null;  // backward deferred to agent_end
  let _backwardPendingCtx: any = null;

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
    const raw = Number(process.env.TEXTRON_FORWARD_TOP_K || "3");
    return Number.isFinite(raw) ? Math.max(1, Math.min(8, Math.floor(raw))) : 3;
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

  // ══════════════════════════════════════════════════════════════════
  // Auto-routing: keyword overlap between prompt and node contents
  // ══════════════════════════════════════════════════════════════════

  function autoRouteNetworkDecision(prompt: string, networks: string[], explicitTaskFamily?: string) {
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

    async function callScorer(attempt: { jsonMode: boolean; label: string; maxParam?: "max_tokens" | "max_completion_tokens"; tokens?: number; temperature?: boolean; reasoningEffort?: boolean }) {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
      const requestBody: Record<string, unknown> = { model: model.id, messages };
      if (attempt.maxParam) requestBody[attempt.maxParam] = attempt.tokens || 4096;
      if (attempt.temperature) requestBody.temperature = 0;
      if (attempt.reasoningEffort) requestBody.reasoning_effort = "low";
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

    const attempts = [
      { jsonMode: true, label: "json_mode/max_tokens/temp0", maxParam: "max_tokens" as const, tokens: 1024, temperature: true, reasoningEffort: true },
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
  ): Promise<{ reward: number; rationale?: string; node_updates?: Record<string, string | { name?: string; content?: string; context?: string }>; add_nodes?: { layer: number; name?: string; content: string; context?: string }[]; node_actions?: { action: "merge" | "delete" | "keep"; source?: string; target?: string; node?: string; rationale?: string }[] }> {
    const model = (ctx as any).model || _textronModel;
    if (!model?.id || !model?.baseUrl) return { reward: 0, rationale: "no model" };

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
        content = previousTask.slice(0, NODE_CONTENT_MAX_CHARS);
        name = compressNodeName(content);
      }
      return { id, name, content, parsed, isVirtual };
    });

    // ── Discover related nodes (TF-IDF similarity) for merge/delete candidates ──
    // For each selected path node, find top-3 similar nodes in the SAME layer
    // that are NOT on the selected path. LLM will decide: merge, delete, or keep.
    const pathNodeKeySet = new Set(activatedIds);
    const relatedNodes: { pathNodeId: string; relatedNodeId: string; layer: number; name: string; content: string; similarity: number }[] = [];
    for (const pn of pathNodes) {
      if (!pn.parsed) continue;
      const scores = tfidfSimilarity(net, pn.name, pn.content);
      const candidates: { key: string; score: number }[] = [];
      for (const [key, score] of scores) {
        if (score < 0.05) continue; // bigram tokenizer: related pairs ~0.12-0.20, noise p50~0.037
        if (pathNodeKeySet.has(key)) continue; // skip nodes already on selected path
        const rp = parseLayerNodeId(key);
        if (!rp || rp.layer !== pn.parsed.layer) continue; // same layer only for merge/delete
        candidates.push({ key, score });
      }
      candidates.sort((a, b) => b.score - a.score);
      for (const c of candidates.slice(0, 3)) {
        const rp = parseLayerNodeId(c.key)!;
        const np = path.join(net.path, `layer_${rp.layer}`, `${rp.nodeId}.html`);
        const rc = readNodeContent(np);
        if (!rc) continue;
        const rn = readNodeName(np) || compressNodeName(rc);
        relatedNodes.push({
          pathNodeId: pn.id,
          relatedNodeId: c.key,
          layer: rp.layer,
          name: rn,
          content: rc.slice(0, 80),
          similarity: Number(c.score.toFixed(3)),
        });
      }
    }

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
    const functionBlock = previousAssistantHighEntropy.match(/<Function>\s*([\s\S]*?)\s*<\/Function>/i)?.[1]?.trim().slice(0, 1500) || "";
    const schemaHint = '{"reward":0.0,"rationale":"≤80 chars","node_updates":{"L0::node_0":{"name":"<48 char","content":"<1000 char"}},"add_nodes":[{"layer":0,"name":"<48 char","content":"<1000 char"}],"node_actions":[{"action":"merge","source":"L1::node_3","target":"L1::node_6","rationale":"≤60 chars"}]}';
    // ── Build filtered existing nodes list (top-8 per layer by TF-IDF relevance) ──
    const existingNodesTfidf = tfidfSimilarity(net, previousTask.slice(0, 200), currentUserMessage.slice(0, 200));
    const promptExisting = [...Array(net.hyperparams.layers.length)].map((_, l) => {
      const nodes: { key: string; name: string; content: string; sim: number }[] = [];
      for (let n = 0; n < net.hyperparams.layers[l]; n++) {
        const np = path.join(net.path, `layer_${l}`, `node_${n}.html`);
        const c = readNodeContent(np);
        if (!c) continue;
        const key = `L${l}::node_${n}`;
        const name = readNodeName(np) || compressNodeName(c);
        const sim = existingNodesTfidf.get(key) || 0;
        nodes.push({ key, name, content: c, sim });
      }
      nodes.sort((a, b) => b.sim - a.sim);
      const shown = nodes.slice(0, 3);
      const hidden = nodes.length - shown.length;
      const lines = shown.map(n => `  ${n.key} [sim=${n.sim.toFixed(2)}]: ${n.name} — ${n.content.slice(0, 80)}`);
      if (hidden > 0) lines.push(`  ... (+${hidden} more in L${l})`);
      return lines.length ? `Layer ${l} (${nodes.length} nodes, top-${shown.length} by relevance):\n${lines.join("\n")}` : `Layer ${l}: (all empty)`;
    }).join("\n\n");

    const promptRelated = relatedNodes.length > 0
      ? relatedNodes.map(rn => `  ${rn.relatedNodeId} [sim=${rn.similarity} to ${rn.pathNodeId}]: ${rn.content}`).join("\n")
      : "(none)";

    const messages = [
      { role: "system", content: `You are Textron semantic backward. Output ONLY raw JSON, no markdown. Format: ${schemaHint}.

RULES:
1. Prefer node_updates over add_nodes. add_nodes ONLY for truly new concepts. NEVER propose delete — use merge(source→target) to deduplicate; the system auto-removes source after merging.
2. REWARD -1..1 from feedback. Negative=wrong, positive=correct. Off-topic→reward=-1,empty updates.
3. FAILURE→"avoid X→prefer Y". SUCCESS→encode WHY.
4. Content≤1000c. name MUST be a compressed symbolic anchor (like the integral sign ∫ or the term "Transformer"). Think: what ≤48c symbol captures the ESSENCE and can serve as a building block for future combinations? Use domain-specific concise nouns (e.g. "满月极性反转" not "2025-01-24 DOWN UP json_mode"). NEVER use file paths, variable names, or full sentences as names. No templates/session summaries.
5. Choose layer by content abstraction: L0=compact reusable principle, L1=causal mechanism, L2=concrete rule.
6. L0 CRITICAL: If ALL existing L0 nodes are non-domain (engineering/communication/tooling) but this task clearly belongs to the taskFamily domain, you MUST add 1-2 new L0 domain nodes (e.g. "K线三维共振·星象三天窗口·相位净计数" or "放量破位三周期共振·新月相位群覆盖基线") to establish domain routing anchors. This takes PRIORITY over L2 tactic updates — without L0 domain nodes, forward propagation cannot route to domain knowledge, breaking the entire network.
7. MERGE DUTY: After producing node_updates, scan RELATED nodes for ≥15% semantic overlap (shared keywords, concepts, or domain). For each such pair, add a merge action (source=more-specific-node → target=more-general-node). Missing obvious merges → node bloat.
8. FUNCTION SYMBOL: If the training packet contains a Function block, the functionSymbol (e.g. astro_kline_layer_score) MUST appear verbatim as an exact substring in the content of the node_update/add_node that absorbs it. Never paraphrase, translate, or split the symbol — downstream citation routing matches it literally.` },
      { role: "user", content: `Previous user task:\n${previousTask.slice(0, 1500)}\n\nPrevious assistant HighEntropy training packet:\n${previousCrystal.ok ? `Name: ${previousCrystal.name}\nTask: ${previousCrystal.task || "(legacy)"}\nTechnique: ${previousCrystal.technique}` : `(invalid/missing)`}${functionBlock ? `\nFunction:\n${functionBlock}` : ""}\n\nEXISTING nodes (DO NOT duplicate):\n${promptExisting}\n\nRELATED nodes (may need merge to deduplicate):\n${promptRelated}\n\nSelected path nodes to update:\n${pathNodes.filter(n => !n.isVirtual).map(n => `${n.id}: ${n.name || "(empty)"}`).join("\n") || "(none)"}${pathNodes.some(n => n.isVirtual) ? `\n\nSEED node (not in network — use add_nodes to materialize):\n${pathNodes.filter(n => n.isVirtual).map(n => `  ${n.id}: ${n.name}\n  content: ${n.content.slice(0, 300)}`).join("\n")}` : ""}\n\nCurrent feedback:\n${currentUserMessage.slice(0, 2000)}\n\nDistill reusable experience. ALWAYS prefer node_updates over add_nodes (>15% overlap=update). FAILED→"avoid X→prefer Y". SUCCEEDED→encode winning mechanism. Content≤1000c, name=3-6 keywords≤48c.

MERGE SCAN (MANDATORY): Review RELATED nodes above. For EVERY pair with ≥15% semantic overlap (keywords/concepts/domain), output a merge action in node_actions. source and target MUST be in the SAME layer (cross-layer merges are rejected). If no merges needed, output node_actions=[{"action":"keep","rationale":"no overlap ≥15%"}]. node_actions MUST NOT be empty — this is a required output field.${pathNodes.some(n => n.isVirtual) ? `\n\nCOLD START: A SEED node is provided above. It is NOT yet in the network. You MUST add at least one L0 domain node from the SEED content using add_nodes.` : ""}` },
    ];

    // Log LLM input AFTER messages is fully constructed (was accidentally referenced before declaration — causing "Cannot access 'messages' before initialization")
    recordMonitorEvent({
      type: "trace",
      action: "semantic_backward_llm_input",
      taskFamily: path.basename(net.path),
      systemPromptChars: messages[0].content.length,
      userPromptChars: messages[1].content.length,
      modelId: model?.id,
      baseUrl: chatEndpoint,
    });

    function clampReward(v: unknown) { return clamp(Number(v) || 0, -1, 1); }
    function normalize(obj: any) {
      const out: { reward: number; rationale?: string; node_updates?: Record<string, string | { name?: string; content?: string; context?: string }>; add_nodes?: { layer: number; name?: string; content: string; context?: string }[]; node_actions?: { action: "merge" | "delete" | "keep"; source?: string; target?: string; node?: string; rationale?: string }[] } = {
        reward: clampReward(obj?.reward),
      };
      if (obj?.rationale) out.rationale = String(obj.rationale).slice(0, 120);
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
            const content = completeContent(String(vv.content || vv.context || "").trim(), NODE_CONTENT_MAX_CHARS);
            const name = completeContent(String(vv.name || compressNodeName(content)).trim(), 64);
            if (content && name && !isNgramFragmentContent(content) && !isNgramFragmentContent(name)) out.node_updates[k] = { name, content };
          }
        }
      }
      if (Array.isArray(obj?.add_nodes)) {
        out.add_nodes = [];
        for (const n of obj.add_nodes.slice(0, 2)) {  // allow limited growth; gates below decide final promotion
          const layer = Number(n?.layer);
          const content = completeContent(String(n?.content || n?.context || n?.name || "").trim(), NODE_CONTENT_MAX_CHARS);
          const name = completeContent(String(n?.name || compressNodeName(content)).trim(), 64);
          if (Number.isInteger(layer) && layer >= 0 && layer < net.hyperparams.layers.length && content && name && !isNgramFragmentContent(content) && !isNgramFragmentContent(name)) out.add_nodes.push({ layer, name, content });
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
            // Validate both nodes exist in network
            const sp = parseLayerNodeId(entry.source); const tp = parseLayerNodeId(entry.target);
            if (!sp || !tp || sp.layer !== tp.layer) {
              // 2026-08-03: 跨层/不可解析 merge 不再静默吞——第49轮实证 LLM 提了2个merge被此处丢弃
              recordMonitorEvent({ type: "trace", action: "merge_action_dropped", source: entry.source, target: entry.target, reason: (!sp || !tp) ? "unparseable_id" : "cross_layer" });
              continue; // merge only within same layer
            }
          }
          out.node_actions.push(entry);
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

      const balanced: string[] = [];
      for (let i = 0; i < raw.length; i++) {
        if (raw[i] !== "{") continue;
        let d = 0;
        for (let j = i; j < raw.length; j++) {
          if (raw[j] === "{") d++;
          else if (raw[j] === "}" && --d === 0) { balanced.push(raw.slice(i, j + 1)); break; }
        }
      }
      for (const c of balanced.sort((a, b) => b.length - a.length)) addCandidate(c);

      let fallback: ReturnType<typeof normalize> | null = null;
      for (const candidate of candidates) {
        try {
          const parsed = JSON.parse(candidate);
          const normalized = normalize(parsed);
          const hasBackwardShape = Object.prototype.hasOwnProperty.call(parsed, "reward") ||
            Object.prototype.hasOwnProperty.call(parsed, "node_updates") ||
            Object.prototype.hasOwnProperty.call(parsed, "add_nodes");
          if (hasBackwardShape) return normalized;
          fallback ||= normalized;
        } catch {}
      }
      if (fallback) return fallback;
      throw new Error("no JSON object in semantic backward response");
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
      return parts;
    }
    async function callChat(stream: boolean) {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
      // No reason_effort (triggers 8K+ reasoning chars in deepseek → timeout).
      // No response_format json_object (deepseek non-standard behavior can break parsing).
      // Plain text + system prompt "ONLY JSON" is faster and more reliable.
      const body: Record<string, unknown> = { model: model.id, messages, stream, max_completion_tokens: 4096 };
      // 2026-08-03: kimi 系补 reasoning_effort=low——kimi-k3 默认 thinking=high，生成 4096-token JSON
      // p50≈66s/p95>90s（2026-08-02 chat_json 90s 精确超时实锤）；同端点 L0 评分已验证该参数对 kimi 可用。
      // deepseek 保持不传（会触发 8K+ reasoning chars → 超时，见上注释）——按模型分流，两者兼容。
      if (/kimi/i.test(String(model.id))) body.reasoning_effort = "low";
      // 2026-07-21: 30s→90s；2026-08-03: 90s→180s（kimi thinking 长尾，deepseek 不受影响）。
      const res = await fetch(chatEndpoint, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(180000) });
      if (stream) {
        if (!res.ok) throw new Error(`chat stream HTTP ${res.status}: ${(await res.text().catch(() => "")).slice(0, 160)}`);
        return extract(await readSse(res as any));
      }
      const txt = await res.text();
      const data = JSON.parse(txt);
      if (!res.ok && !data?.choices?.[0]?.message) throw new Error(`chat HTTP ${res.status}: ${txt.slice(0, 160)}`);
      const msg = data?.choices?.[0]?.message || {};
      const rawContent = String(msg.content || "");
      const rawReasoning = String(msg.reasoning_content || "");
      // 2026-07-22: 当 API 返回空内容时，记录完整响应体以便诊断
      if (!rawContent) {
        const diagInfo = `rawContent empty. res.ok=${res.ok} status=${res.status} finish_reason=${data?.choices?.[0]?.finish_reason || "none"} responseBody=${txt.slice(0, 500)}`;
        console.error(`[textron] semantic_backward empty content: ${diagInfo}`);
        fs.appendFileSync(path.join(net.path, "_sb_logs", "_empty_response.log"), `${new Date().toISOString()} ${diagInfo}\n`, "utf-8");
        throw new Error(`empty semantic backward response (HTTP ${res.status}, finish=${data?.choices?.[0]?.finish_reason || "?"})`);
      }
      // IMPORTANT: only parse rawContent, NOT reasoning. Reasoning may contain
      // template JSON fragments (e.g. {"reward":0}) that would be picked up by
      // the balanced-brace extractor instead of the actual response.
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
      const body: Record<string, unknown> = { model: model.id, messages, stream: true, max_completion_tokens: 2048, response_format: { type: "json_object" } };
      if (/kimi/i.test(String(model.id))) body.reasoning_effort = "low"; // 2026-08-03: 同 callChat 的 kimi/deepseek 分流
      const res = await fetch(chatEndpoint, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(180000) });
      if (!res.ok) throw new Error(`chat json stream HTTP ${res.status}: ${(await res.text().catch(() => "")).slice(0, 160)}`);
      const parts = await readSse(res as any);
      const result = extract(parts);
      recordMonitorEvent({
        type: "debug",
        action: "semantic_backward_llm_raw_response",
        taskFamily: path.basename(net.path),
        mode: "chat_json_stream",
        rawPartsCount: parts.length,
        rawContent: parts.join("\n").slice(0, 2000),
        parsedReward: result.reward,
        parsedRationale: result.rationale || "",
        parsedNodeUpdateKeys: Object.keys(result.node_updates || {}),
        parsedAddNodeCount: (result.add_nodes || []).length,
      });
      return result;
    }

    const errors: string[] = [];
    // 2026-07-21: chat_json → chat_stream → chat_json_stream 三重兜底。
    // chat_json(plain,非流式)→chat_stream(plain,流式)→chat_json_stream(流式+json_object,兼容GPT/Kimi/DeepSeek)
    for (const [label, fn] of [["chat_json", () => callChat(false)], ["chat_stream", () => callChat(true)], ["chat_json_stream", () => callChatJsonStream()]] as const) {
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
            parsed: { reward: result.reward, rationale: result.rationale, nodeUpdateIds: Object.keys(result.node_updates || {}), addNodes: (result.add_nodes || []).map((n: any) => ({ layer: n.layer, name: n.name })), nodeActions: (result.node_actions || []).map((a: any) => ({ action: a.action, source: a.source, target: a.target, node: a.node, rationale: a.rationale })) },
          };
          const logDir = path.join(net.path, "_sb_logs");
          ensureDir(logDir);
          fs.appendFileSync(path.join(logDir, "semantic_backward.jsonl"), JSON.stringify(logEntry) + "\n", "utf-8");
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

  function applySemanticNodeUpdates(net: NonNullable<ReturnType<typeof loadNetwork>>, updates: Record<string, string | { name?: string; content?: string; context?: string }> | undefined, onLog: (msg: string) => void) {
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

      const similar = oldIsArtifact
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
      const newContent = validation.content.slice(0, NODE_CONTENT_MAX_CHARS);
      let mergedContent = oldIsArtifact ? completeContent(newContent, NODE_CONTENT_MAX_CHARS) : mergeContent(oldContent, newContent);
      if (mergedContent.length > NODE_CONTENT_MAX_CHARS) {
        const overflow = mergedContent.slice(NODE_CONTENT_MAX_CHARS);
        mergedContent = mergedContent.slice(0, NODE_CONTENT_MAX_CHARS);
        const overflowResult = addDynamicNode(net, parsed.layer, overflow, onLog, compressNodeName(overflow));
        if (overflowResult.added) {
          nodesAdded++;
          result.nodeMutations.push({ type: "add", id: `L${parsed.layer}::node_${overflowResult.nodeId}` });
          onLog(`Textron autoBackward: update overflow ${overflow.length}c → new node L${parsed.layer}::node_${overflowResult.nodeId}`);
        }
      }
      if (oldContent && mergedContent !== newContent) {
        onLog(`Textron semantic backward: merged node ${id} (old=${oldContent.length}c new=${newContent.length}c → ${mergedContent.length}c)`);
      }
      // Merge name: distill old name keywords + new name keywords, not full replace
      const llmProposedName = typeof update === "string" ? compressNodeName(update) : (update.name || "");
      const mergedNameRaw = llmProposedName && oldName
        ? distillNodeName(`${oldName} ${llmProposedName}`, 64)
        : (llmProposedName || compressNodeName(mergedContent));
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
      for (const [key, edges] of Object.entries(net.weights.layer_connections)) {
        for (const edge of edges) {
          const eid = `${key}:${edge.from}:${edge.to}`;
          if (!activeEdgeSet.has(eid)) continue;
          const old = edge.weight;
          const edgeR = edgeRewards?.get(eid) ?? reward;
          if (edgeR > 0) edge.weight = clamp(old + lr * edgeR * (1 - old), -1, 1);
          else if (edgeR < 0) edge.weight = clamp(old + lr * edgeR * (1 + old), -1, 1);
          if (Math.abs(edge.weight - old) > 0.000001) {
            changes++;
            changedEdges.push(`${eid}:${old.toFixed(4)}->${edge.weight.toFixed(4)}`);
          }
        }
      }
      if (changes > 0) {
        writeJson(path.join(net.path, "weights.json"), net.weights);
        onLog(`Textron backward: ${changes} selected edge(s) updated (reward=${reward.toFixed(3)}) for "${path.basename(net.path)}"`);
      }
      // Negative reward: lightly penalize ALL edges connected to activated nodes
      if (reward < 0 && activatedIds.length > 0) {
        const activatedNodeKeys = new Set<string>();
        for (const id of activatedIds) {
          const parsed = parseLayerNodeId(id);
          if (parsed) activatedNodeKeys.add(parsed.nodeId);
        }
        const penaltyRate = lr * Math.abs(reward) * 0.3;
        let extraChanges = 0;
        for (const [key, edges] of Object.entries(net.weights.layer_connections)) {
          for (const edge of edges) {
            if (activatedNodeKeys.has(edge.from) || activatedNodeKeys.has(edge.to)) {
              const eid = `${key}:${edge.from}:${edge.to}`;
              if (activeEdgeSet.has(eid)) continue;
              const old = edge.weight;
              edge.weight = clamp(old - penaltyRate * (1 + old), -1, 1);
              if (Math.abs(edge.weight - old) > 0.000001) {
                extraChanges++;
                changedEdges.push(`${eid}:${old.toFixed(4)}->${edge.weight.toFixed(4)} [noise_penalty]`);
              }
            }
          }
        }
        if (extraChanges > 0) {
          writeJson(path.join(net.path, "weights.json"), net.weights);
          onLog(`Textron backward: ${extraChanges} extra connected-edge(s) penalized (noise suppression) for "${path.basename(net.path)}"`);
        }
      }
    }

    // ── Node content updates ──
    const nodeResult = applySemanticNodeUpdates(net, nodeUpdates, onLog);
    const nodeMutations = [...nodeResult.nodeMutations];

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
        if (!sp || !tp || sp.layer !== tp.layer) continue;
        const srcPath = path.join(net.path, `layer_${sp.layer}`, `${sp.nodeId}.html`);
        const tgtPath = path.join(net.path, `layer_${tp.layer}`, `${tp.nodeId}.html`);
        const srcContent = readNodeContent(srcPath);
        const tgtContent = readNodeContent(tgtPath);
        if (!srcContent || !tgtContent) continue;
        // GATE: refuse merge if source content is already empty (prevents double-compaction)
        if (srcContent.trim().length === 0) {
          onLog(`Textron autoBackward: skipped merge ${action.source}→${action.target} — source already empty`);
          continue;
        }
        let merged = mergeContent(tgtContent, srcContent);
        let overflowNodeId = "";
        if (merged.length > NODE_CONTENT_MAX_CHARS) {
          const overflow = merged.slice(NODE_CONTENT_MAX_CHARS);
          merged = merged.slice(0, NODE_CONTENT_MAX_CHARS);
          const overflowResult = addDynamicNode(net, tp.layer, overflow, onLog, compressNodeName(overflow));
          if (overflowResult.added) {
            overflowNodeId = `node_${String(overflowResult.nodeId)}`;
            nodesAdded++;
            nodeMutations.push({ type: "add", id: `L${tp.layer}::${overflowNodeId}` });
            onLog(`Textron autoBackward: merge overflow ${overflow.length}c → new node L${tp.layer}::${overflowNodeId}`);
          }
        }
        const outEdges = (net.weights.layer_connections[`${tp.layer}_to_${tp.layer + 1}`] || []).filter(e => e.from === tp.nodeId).map(e => ({ toId: e.to, weight: e.weight }));
        writeNodeHtml(tgtPath, tp.layer, tp.nodeId, merged, outEdges, compressNodeName(merged));
        // Empty source only transiently; compactMergeEmptiedNodes removes/reindexes only these specific nodes.
        const srcOutEdges = (net.weights.layer_connections[`${sp.layer}_to_${sp.layer + 1}`] || []).filter(e => e.from === sp.nodeId).map(e => ({ toId: e.to, weight: e.weight }));
        writeNodeHtml(srcPath, sp.layer, sp.nodeId, "", srcOutEdges);
        // Reset ngram state for emptied source
        try {
          const ngramPath = srcPath.replace(/\.html$/, ".ngram.json");
          if (fs.existsSync(ngramPath)) writeNgramState(srcPath, createNodeState());
        } catch {}
        emptiedByMerge.push({ layer: sp.layer, nodeId: sp.nodeId });
        nodesMerged++;
        nodeMutations.push({ type: "merge", id: action.target, source: action.source, target: action.target });
        onLog(`Textron autoBackward: merged ${action.source} into ${action.target} — "${preview(srcContent, 40)}" → "${preview(merged, 60)}" (source queued for compaction)${overflowNodeId ? ` + overflow→${overflowNodeId}` : ""}`);
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
  ) {
    const startedMs = Date.now();
    const startedAt = new Date(startedMs).toISOString();
    let net: ReturnType<typeof loadNetwork> = null;
    try { net = loadNetwork(taskFamily); } catch (e) { recordMonitorEvent({ type: "trace", action: "debug_backward_loadNetwork_failed", taskFamily, error: (e as Error).stack || (e as Error).message }); throw e; }
    if (!net) return null;
    let result: Awaited<ReturnType<typeof semanticBackwardLLM>>;
    try { result = await semanticBackwardLLM(net, previousTask, previousAssistantHighEntropy, currentUserMessage, activatedIds, ctx); } catch (e) { recordMonitorEvent({ type: "trace", action: "debug_backward_llm_failed", taskFamily, error: (e as Error).stack || (e as Error).message }); throw e; }

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
      const seedContent = currentUserMessage.slice(0, NODE_CONTENT_MAX_CHARS);
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
    if (bwResult.nodesUpdated === 0 && previousAssistantHighEntropy) {
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
      const saved = readJson<{activeTask?: {taskType:string;taskFamily:string;highEntropy:string;activatedIds:string[];ts:string}|null; taskStack?: {taskType:string;taskFamily:string;highEntropy:string;activatedIds:string[];ts:string}[]} | null>(
        LAST_STATE_PATH, null);
      dlog("STATE", "disk read result", { found: !!saved, hasActive: !!(saved as any)?.activeTask, stackLen: ((saved as any)?.taskStack || []).length, activeType: (saved as any)?.activeTask?.taskType || '', stackTypes: ((saved as any)?.taskStack || []).map((t:any) => t.taskType) });
      if (saved) {
        if (saved.activeTask) {
          activeTask = {
            taskType: saved.activeTask.taskType || "",
            taskFamily: saved.activeTask.taskFamily || "",
            rawUserPrompt: "", effectivePrompt: "",
            highEntropy: saved.activeTask.highEntropy || "",
            activatedIds: saved.activeTask.activatedIds || [],
            selectedEdgeIds: [],
            routeUncertain: false, moeMaxScore: 0,
            ts: saved.activeTask.ts || "",
          };
        }
        if (saved.taskStack) {
          taskStack = saved.taskStack.map((t:any) => ({
            taskType: t.taskType || "", taskFamily: t.taskFamily || "",
            rawUserPrompt: "", effectivePrompt: "",
            highEntropy: t.highEntropy || "",
            activatedIds: t.activatedIds || [],
            selectedEdgeIds: [],
            routeUncertain: false, moeMaxScore: 0,
            ts: t.ts || "",
          }));
        }
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
      const taskListForLLM = allPendingTasks.map((t, i) =>
        `[${i}] TaskType="${t.taskType}" taskFamily="${t.taskFamily}" ts=${t.ts.slice(0,16)} HighEntropy=${t.highEntropy.slice(0, 120)}`
      ).join("\n");

      // Use a fast LLM call to judge which task (if any) this message is feedback for
      let bestMatchIdx = -1;
      let isFeedbackMatch = false;
      try {
        const model = _textronModel;
        if (model?.id && model?.baseUrl) {
          const baseUrl = String(model.baseUrl).replace(/\/+$/, "");
          const chatEndpoint = joinApiEndpoint(baseUrl, "/chat/completions");
          const { apiKey } = await resolveModelApiKey(ctx, model);
          const pairingPrompt = `You are a task-feedback pairing judge. Given a list of pending tasks and a user message, determine which task (if any) the user message is feedback for.\n\nPENDING TASKS:\n${taskListForLLM}\n\nUSER MESSAGE: ${currentRawUserPrompt.slice(0, 500)}\n\nOutput ONLY raw JSON: {"matchIdx":-1,"isFeedback":false,"rationale":"≤60 chars"}.\n- matchIdx: index of matched task (0=${activeTask ? "active" : "first stack"}, -1=none)\n- isFeedback: true if this message evaluates/corrects/responds to the matched task; false if it's a new task or unrelated.\n- Key signals of feedback: error correction, result report, criticism, approval, "没改好"/"改好了"/"对了"/"错了"/"为什么没有" etc.\n- Key signals of NOT feedback: new task instructions, unrelated questions, continuation words.`;
          const res = await fetch(chatEndpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
            body: JSON.stringify({
              model: "deepseek-v4-flash",
              messages: [{ role: "user", content: pairingPrompt }],
              max_tokens: 200,
              temperature: 0,
            }),
            signal: AbortSignal.timeout(15000),
          });
          if (res.ok) {
            const data = await res.json();
            const raw = data?.choices?.[0]?.message?.content || "";
            const parsed = JSON.parse(raw.replace(/```json\n?|```/g, "").trim());
            bestMatchIdx = typeof parsed.matchIdx === "number" ? parsed.matchIdx : -1;
            isFeedbackMatch = !!parsed.isFeedback;
            dlog("BACKWARD", "pairing judge", { matchIdx: bestMatchIdx, isFeedback: isFeedbackMatch, rationale: parsed.rationale });
            recordMonitorEvent({ type: "trace", action: "pairing_judge_done", matchIdx: bestMatchIdx, isFeedback: isFeedbackMatch, rationale: parsed.rationale || "", pendingCount: allPendingTasks.length });
          } else {
            throw new Error(`pairing judge fetch failed: ${res.status}`);
          }
        } else {
          throw new Error("no model available for pairing judge");
        }
      } catch (e) {
        // Fallback: if pairing LLM fails, try simple heuristic — match by taskFamily
        dlog("BACKWARD", "pairing judge failed, fallback to first active", { error: (e as Error).message });
        bestMatchIdx = 0; // Default to activeTask
        isFeedbackMatch = true; // Conservative: assume it's feedback
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

    const l0Nodes = [];
    for (let n = 0; n < net.hyperparams.layers[0]; n++) {
      const nodePath = path.join(net.path, "layer_0", `node_${n}.html`);
      l0Nodes.push({
        id: `node_${n}`,
        name: readNodeName(nodePath),
        content: readNodeContent(nodePath),
      });
    }
    dlog("L0", `loaded ${l0Nodes.length} L0 nodes`, l0Nodes.map(n => ({ id: n.id, name: n.name || "(empty)", hasContent: !!n.content })));

    dlog("L0", "calling scoreL0WithLLM...");
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
      }
    }

    // Persist all scores for monitor labels. Select top-k nodes per layer for backward,
    // while keeping prompt injection threshold-gated to avoid flooding context.
    currentActivationScores = {};
    const topK = forwardTopK();
    const selectedByLayer = new Map<number, string[]>();
    for (const la of layerActivations) {
      for (const node of la.nodes) currentActivationScores[`L${la.layer}::${node.id}`] = node.score;
      const ranked = la.layer === 0
        ? [...la.nodes].filter((node) => node.score > 0).sort((a, b) => b.score - a.score)
        : rankLayerWithExploration(la.layer, la.nodes, forwardStats);
      const selected = ranked.slice(0, topK);
      if (selected.length > 0) selectedByLayer.set(la.layer, selected.map((n) => n.id));
      for (const node of selected) {
        selectedPath.push({
          id: node.id,
          layer: la.layer,
          content: readNodeContent(path.join(net.path, `layer_${la.layer}`, `${node.id}.html`)),
          activation: node.score,
        });
      }
      for (const node of selected.filter((n) => n.score > threshold)) {
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
      const seedContent = String(event.prompt || "").trim().slice(0, NODE_CONTENT_MAX_CHARS);
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

  // ══════════════════════════════════════════════════════════════════
  // agent_end → preserve selected path for forced semantic backward on next turn
  // ══════════════════════════════════════════════════════════════════

  pi.on("agent_end", async (event: any, _ctx) => {
    console.error(`[textron] agent_end FIRED at ${new Date().toISOString()}`);
    try {
    // ── Extract HighEntropy crystal to get taskType and isTask ──
    const runMessages = Array.isArray(event?.messages) ? event.messages : [];
    const eventHighEntropy = extractLatestHighEntropyFromMessages(runMessages);
    let finalAssistantText = "";
    for (let i = runMessages.length - 1; i >= 0; i--) {
      finalAssistantText = assistantMessageText(runMessages[i]);
      if (finalAssistantText) break;
    }
    if (finalAssistantText && !currentAssistantBuffer.endsWith(finalAssistantText)) {
      currentAssistantBuffer += `\n${finalAssistantText}`;
    }
    const finalCrystal = parseHighEntropyCrystal(currentAssistantBuffer);
    const highEntropy = eventHighEntropy || currentAssistantHighEntropy || (finalCrystal.ok ? `Name: ${finalCrystal.name}\n${finalCrystal.task ? `Task: ${finalCrystal.task}\n` : ""}Technique: ${finalCrystal.technique}` : "");
    const taskType = finalCrystal.taskType || "";
    const isTask = finalCrystal.isTask;

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

    // ── Task Stack: push if isTask, skip if intermediate ──
    if (isTask && highEntropy) {
      const newTask: TaskEntry = {
        taskType: taskType || currentTaskFamily || "unknown",
        taskFamily: currentTaskFamily || "",
        rawUserPrompt: currentRawUserPrompt,
        effectivePrompt: currentEffectivePrompt,
        highEntropy,
        activatedIds: [...currentActivatedIds],
        selectedEdgeIds: [...currentSelectedEdgeIds],
        routeUncertain: currentRouteUncertain,
        moeMaxScore: currentMoeMaxScore,
        ts: new Date().toISOString(),
      };
      // Push old activeTask to stack if exists, then set new active
      if (activeTask) {
        taskStack.push(activeTask);
        if (taskStack.length > MAX_TASK_STACK) taskStack.shift(); // FIFO evict oldest
      }
      activeTask = newTask;
      dlog("HOOK", "agent_end: task pushed to stack", { taskType, taskFamily: currentTaskFamily, stackDepth: activeTask ? taskStack.length + 1 : taskStack.length });
      recordMonitorEvent({ type: "trace", action: "agent_end_task_pushed", taskType, taskFamily: currentTaskFamily || "", stackDepth: activeTask ? taskStack.length + 1 : taskStack.length });
    } else if (activeTask && highEntropy) {
      // Intermediate turn on active task: update highEntropy (more recent context for backward)
      activeTask.highEntropy = highEntropy;
      activeTask.activatedIds = [...currentActivatedIds];
      activeTask.selectedEdgeIds = [...currentSelectedEdgeIds];
      dlog("HOOK", "agent_end: intermediate update to active task", { taskType: activeTask.taskType });
      recordMonitorEvent({ type: "trace", action: "agent_end_intermediate_updated", taskType: activeTask.taskType });
    } else {
      dlog("HOOK", "agent_end: no task to save", { isTask, hasHighEntropy: !!highEntropy });
    }

    // ── Persist taskStack to disk ──
    try {
      ensureDir(path.dirname(LAST_STATE_PATH));
      const allTasks = activeTask ? [activeTask, ...taskStack] : taskStack;
      const toPersist = {
        activeTask: activeTask ? { taskType: activeTask.taskType, taskFamily: activeTask.taskFamily, highEntropy: activeTask.highEntropy.slice(0, 2400), activatedIds: activeTask.activatedIds, ts: activeTask.ts } : null,
        taskStack: taskStack.map(t => ({ taskType: t.taskType, taskFamily: t.taskFamily, highEntropy: t.highEntropy.slice(0, 2400), activatedIds: t.activatedIds, ts: t.ts })),
        at: new Date().toISOString(),
      };
      dlog("STATE", "persisting to disk", { file: LAST_STATE_PATH, activeType: toPersist.activeTask?.taskType || 'null', stackTypes: toPersist.taskStack.map((t:any) => t.taskType), totalCount: allTasks.length });
      writeJson(LAST_STATE_PATH, toPersist);
      recordMonitorEvent({ type: "trace", action: "task_stack_persisted", activeTask: !!activeTask, stackDepth: taskStack.length, activeType: activeTask?.taskType || '', stackTypes: taskStack.map(t => t.taskType) });
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

      const backwardTaskContext = buildBackwardTaskContext({
        rawPrompt: matched.rawUserPrompt,
        effectivePrompt: matched.effectivePrompt,
        highEntropy: matched.highEntropy,
      });
      const capturedPrevTask = backwardTaskContext.previousTaskForBackward;
      const capturedHighEntropy = matched.highEntropy;
      const capturedTF = matched.taskFamily || "astro_stock_prediction";
      const capturedIDs = matched.activatedIds;
      const capturedEdges = matched.selectedEdgeIds;

      if (!backwardTaskContext.hasDomainEvidence && !capturedHighEntropy) {
        log(`Textron semantic backward (agent_end): skipped — no domain evidence`);
        recordMonitorEvent({ type: "trace", action: "semantic_backward_skipped_no_domain_evidence", taskFamily: capturedTF });
      } else {
        // Inject current assistant's HighEntropy (经验总结) into feedback context
        const assistantAnalysis = (currentAssistantHighEntropy || finalAssistantText || "").slice(0, 2000);
        const enhancedFeedback = currentRawUserPrompt + "\n\nAssistant's analysis (from HighEntropy):\n" + assistantAnalysis;

        const startedAt = new Date().toISOString();
        const semanticRunId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        lastBackwardState = {
          taskFamily: capturedTF, action: "semantic_backward", status: "running",
          runId: semanticRunId, activatedIds: capturedIDs, selectedEdgeIds: capturedEdges,
          hasHighEntropy: !!capturedHighEntropy, matchedTaskType: matched.taskType,
          previousTaskChars: capturedPrevTask.length, feedbackChars: enhancedFeedback.length,
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
          bwResult = await forcedSemanticBackward(capturedTF, capturedPrevTask, capturedHighEntropy, enhancedFeedback, capturedIDs, capturedEdges, backwardCtx, { routeUncertain: matched.routeUncertain, moeMaxScore: matched.moeMaxScore });
        } catch (e) {
          const failedAt = new Date().toISOString();
          const errMsg = e instanceof Error ? e.message : String(e);
          const errStack = e instanceof Error ? e.stack : String(e);
          lastBackwardState = { ...lastBackwardState, status: "failed", error: errMsg, stack: preview(errStack, 500), at: failedAt };
          log(`Textron semantic backward (agent_end): status=failed runId=${semanticRunId}, error=${errMsg}`);
          console.error(`[textron] backward crash stack:`, errStack);
          recordMonitorEvent({ type: "update", taskFamily: capturedTF, action: "semantic_backward_failed", ...lastBackwardState });
        }

        const hadLearning = bwResult && (bwResult.nodesUpdated > 0 || bwResult.nodesAdded > 0 || bwResult.nodesMerged > 0);
        const hadReward = bwResult && Math.abs(bwResult.reward || 0) >= 0.05;
        const shouldConsume = hadLearning || hadReward;

        if (shouldConsume) {
          recordMonitorEvent({ type: "trace", action: "agent_pending_state_cleared", taskFamily: capturedTF, reason: "backward_consumed_at_agent_end", runId: semanticRunId, matchedTaskType: matched.taskType });
          // Remove matched task from stack
          const allPend = activeTask ? [activeTask, ...taskStack] : [...taskStack];
          const bmIdx = allPend.findIndex(t => t === matched || t.highEntropy === matched.highEntropy);
          if (bmIdx === 0 && activeTask) {
            activeTask = taskStack.length > 0 ? taskStack.shift()! : null;
          } else {
            const sIdx = activeTask ? bmIdx - 1 : bmIdx;
            if (sIdx >= 0 && sIdx < taskStack.length) taskStack.splice(sIdx, 1);
          }
          dlog("BACKWARD", "agent_end: task consumed from stack", { consumedIdx: bmIdx, remainingActive: activeTask?.taskType || 'null', remainingStack: taskStack.map(t => t.taskType) });
        } else {
          dlog("BACKWARD", "agent_end: no learning, preserving pending", { matchedType: matched.taskType, reward: bwResult?.reward });
          recordMonitorEvent({ type: "trace", action: "agent_pending_preserved_no_learning", taskFamily: capturedTF, reason: "backward_noop_at_agent_end", matchedTaskType: matched.taskType, reward: bwResult?.reward });
        }
      }
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
