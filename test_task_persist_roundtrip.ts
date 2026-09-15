// 回归门禁：任务栈「原文持久化」往返 + 反传任务侧素材来源（零依赖，jiti 直接跑）
// 背景（n8 第十三轮 guard 实证）：toPersist 只写 highEntropy、恢复侧把 rawUserPrompt 硬编码为 ""
// ⇒ 重启后每条回溯任务的真实提问丢失，buildBackwardTaskContext 退化为 [HighEntropy Task]
// （learningPromptSource="high_entropy"），反传 LLM 只能对着 HE 摘要自说自话。
// 本脚本断言「序列化 → 反序列化 → 反传上下文」全链，任何一环回退即 FAIL。
import * as fs from "node:fs";
import * as path from "node:path";
import {
  serializeTaskForState,
  restoreTaskPrompt,
  buildBackwardTaskContext,
  TASK_RAW_PROMPT_PERSIST_CAP,
} from "./src/lifecycle_context.ts";

const root = path.dirname(new URL(import.meta.url).pathname);
let pass = 0, fail = 0;
function ok(name: string, cond: boolean, extra = "") { if (cond) { pass++; console.log("PASS", name); } else { fail++; console.log("FAIL", name, extra); } }

const task = {
  taskType: "A股持仓决策",
  taskFamily: "stock_alpha",
  highEntropy: "Name: 301299缩量反抽\nTechnique: 破位大阴后量能递减判弱修复",
  activatedIds: ["L0::node_1", "L1::node_0"],
  ts: "2026-09-15T11:34:37.633Z",
  processLog: ["[11:34:37][exec] 🔧▶bash in:{...}"],
  rawUserPrompt: "决策基准: 观察信息截止最近收盘日 2025-04-17，持仓 sz.301299 500股@53.60，请给出下一交易日决策 JSON。",
};

// T1 序列化保留任务原文
const p1 = serializeTaskForState(task);
ok("T1 序列化保留 rawUserPrompt", p1.rawUserPrompt === task.rawUserPrompt, JSON.stringify(p1.rawUserPrompt));
ok("T1b 记录原文长度与非截断标记", p1.rawUserPromptChars === task.rawUserPrompt.length && p1.rawUserPromptTruncated === false);

// T2 超 cap：显式截断 + 标记 + 原始长度保留（禁静默 slice）
const long = "X".repeat(TASK_RAW_PROMPT_PERSIST_CAP + 123);
const p2 = serializeTaskForState({ ...task, rawUserPrompt: long });
ok("T2 超 cap 截断到上限", p2.rawUserPrompt!.length === TASK_RAW_PROMPT_PERSIST_CAP);
ok("T2b truncated=true 且 chars 记录截断前长度", p2.rawUserPromptTruncated === true && p2.rawUserPromptChars === long.length);

// T3 往返一致
const rt = restoreTaskPrompt(p1);
ok("T3 往返原文一致", rt.rawUserPrompt === task.rawUserPrompt);
ok("T3b 往返标记一致", rt.rawUserPromptTruncated === false && rt.rawUserPromptChars === task.rawUserPrompt.length);

// T4 旧档兼容：无 rawUserPrompt 字段 → 空串且不抛
const legacy = restoreTaskPrompt({ taskType: "A股涨跌预测", highEntropy: "Name: x" });
ok("T4 旧档无字段 → 空串不抛", legacy.rawUserPrompt === "" && legacy.rawUserPromptChars === 0);

// T5 反传任务侧来源：有原文 → raw_prompt；无原文 → high_entropy（回归现状，证明修复必要性）
const withRaw = buildBackwardTaskContext({ rawPrompt: rt.rawUserPrompt, effectivePrompt: "", highEntropy: task.highEntropy, processLog: task.processLog });
ok("T5 有原文 → learningPromptSource=raw_prompt", withRaw.learningPromptSource === "raw_prompt", withRaw.learningPromptSource);
ok("T5b previousTask 含任务原文而非 [HighEntropy Task]", withRaw.previousTaskForBackward.includes("决策基准") && !withRaw.previousTaskForBackward.startsWith("[HighEntropy Task]"));
const withoutRaw = buildBackwardTaskContext({ rawPrompt: "", effectivePrompt: "", highEntropy: task.highEntropy, processLog: task.processLog });
ok("T5c 无原文 → 退化为 high_entropy（修复前重启后常态）", withoutRaw.learningPromptSource === "high_entropy" && withoutRaw.previousTaskForBackward.startsWith("[HighEntropy Task]"));
ok("T5d 有原文时任务侧显著更长", withRaw.previousTaskForBackward.length > withoutRaw.previousTaskForBackward.length);

// T6 静态断言：写入/恢复两处必须走单一事实来源（防未来回退到硬编码 ""）
const idx = fs.readFileSync(path.join(root, "src/index.ts"), "utf8");
const persistBlock = idx.slice(idx.indexOf("const toPersist = {"), idx.indexOf("const toPersist = {") + 600);
ok("T6 落盘走 serializeTaskForState", persistBlock.includes("serializeTaskForState(activeTask") && persistBlock.includes("serializeTaskForState(t"));
const restoreCalls = (idx.match(/restoreTaskPrompt\(/g) || []).length;  // 调用点：activeTask + taskStack 两条
ok("T6b 恢复走 restoreTaskPrompt（activeTask+taskStack 双路径）", restoreCalls >= 2, String(restoreCalls));
ok("T6c 恢复侧不再硬编码 rawUserPrompt: \"\"", !/rawUserPrompt: "", effectivePrompt: ""/.test(idx));
ok("T6d 反传入口事件带 learningPromptSource", idx.includes("learningPromptSource: backwardTaskContext.learningPromptSource"));

console.log(`\n${pass} PASS / ${fail} FAIL`);
if (fail) process.exit(1);
