/**
 * 任务侧原文补齐（TASK-SIDE PROMPT PATCH）回归 —— n8 第十六轮 guard
 * 2026-09-16 实证（窗口 L97063–L97477）：反传任务侧取自 pending 池命中项，池内旧条目
 * `rawUserPrompt` 为空 ⇒ guard/sender 两回合 `learningPromptSource=high_entropy` ∧
 * `rawPromptChars=0`（matchedTaskTs 指向 11:34:37Z / 08:20:10Z 已出栈旧任务），
 * 而本会话 activeTask 原文非空（1607c / 1366c）⇒ 任务侧退化为 HE 摘要 ⇒
 * ①域闸失去「本轮任务是什么」的判据输入（恒判在域内）②融合对象错位。
 *
 * 判据：
 *   T1 取材优先级：matched → active_task → current_round_prompt → none
 *   T2 占位符不取材（「继续」/「收到」不是任务原文，继续向下回落）
 *   T3 不改变配对身份：patched=false 仅当 matched 原文可用（防止把补齐变成换任务）
 *   T4 index.ts 消费点：patchTaskRawPrompt 必须在 setTimeout 之前调用（异步期 activeTask 会被下一轮覆盖）
 *      + 事件 `semantic_backward_entered` 必须带 taskPromptPatch / taskPromptPatchedRawChars
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { patchTaskRawPrompt, buildBackwardTaskContext } from "./src/lifecycle_context";

let pass = 0, fail = 0;
const assert = (cond: boolean, name: string, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}`, extra ?? ""); }
};

// ── T1 取材优先级 ──
console.log("T1 取材优先级 matched → active_task → current_round_prompt → none");
{
  const r = patchTaskRawPrompt({
    matchedRawPrompt: "执行 n6 节点：下发交易推进指令（matched 原文）",
    activeTaskRawPrompt: "active 原文",
    currentRoundPrompt: "round 原文",
  });
  assert(r.patchSource === "matched" && !r.patched, "matched 可用 ⇒ 原样不补齐", r);
  assert(r.rawPrompt.includes("matched 原文"), "rawPrompt 取自 matched", r.rawPrompt.slice(0, 40));
}
{
  // 本轮实测形态：matched 空 + activeTask 非空（guard 1607c / sender 1366c）
  const r = patchTaskRawPrompt({
    matchedRawPrompt: "",
    activeTaskRawPrompt: "【指令来源：guard / 角色：sender 执行方】开始交易游戏：完成 2 次交易推进",
    currentRoundPrompt: "round 原文",
  });
  assert(r.patchSource === "active_task" && r.patched, "matched 空 ⇒ 回落 active_task", r);
}
{
  const r = patchTaskRawPrompt({
    matchedRawPrompt: "",
    activeTaskRawPrompt: "",
    currentRoundPrompt: "[local-coms from sender] 交易推进已完成",
  });
  assert(r.patchSource === "current_round_prompt" && r.patched, "active 也空 ⇒ 回落本轮 prompt", r);
}
{
  const r = patchTaskRawPrompt({ matchedRawPrompt: "", activeTaskRawPrompt: "", currentRoundPrompt: "" });
  assert(r.patchSource === "none" && r.rawPrompt === "" && !r.patched, "全空 ⇒ none（显式标注，不静默）", r);
}

// ── T2 占位符不取材 ──
console.log("T2 占位符（继续/收到/好）不视为任务原文（判据沿用 buildBackwardTaskContext 的既有词表 isPlaceholderRetryPrompt，不另起一套）");
{
  const r = patchTaskRawPrompt({ matchedRawPrompt: "继续", activeTaskRawPrompt: "收到", currentRoundPrompt: "完成了 n6 派发与两次推进，这是复盘" });
  assert(r.patchSource === "current_round_prompt", "matched/active 均为占位符 ⇒ 回落到实质内容", r);
}
{
  const r = patchTaskRawPrompt({ matchedRawPrompt: "继续", activeTaskRawPrompt: "好", currentRoundPrompt: "OK" });
  assert(r.patchSource === "none", "全为占位符 ⇒ none（不得把占位符当任务原文）", r);
}

// ── T3 补齐后的上下文不再退化为 HE ──
console.log("T3 补齐 ⇒ learningPromptSource=raw_prompt（域闸判据输入恢复）");
{
  const patched = patchTaskRawPrompt({
    matchedRawPrompt: "",
    activeTaskRawPrompt: "【指令来源：guard / 角色：sender 执行方】开始交易游戏：完成 2 次交易推进。不要指定股票与日期。",
    currentRoundPrompt: "",
  });
  const ctxRaw = buildBackwardTaskContext({ rawPrompt: patched.rawPrompt, effectivePrompt: "", highEntropy: "x".repeat(200) });
  assert(ctxRaw.learningPromptSource === "raw_prompt", "补齐后走 raw_prompt（非 high_entropy）", ctxRaw.learningPromptSource);
  assert(ctxRaw.rawPromptChars > 30, "rawPromptChars > 0", ctxRaw.rawPromptChars);
  // 对照：不补齐（旧行为）
  const ctxHe = buildBackwardTaskContext({ rawPrompt: "", effectivePrompt: "", highEntropy: "x".repeat(200) });
  assert(ctxHe.learningPromptSource === "high_entropy" && ctxHe.rawPromptChars === 0, "对照：未补齐 ⇒ 退化为 HE（缺陷可复现）", ctxHe.learningPromptSource);
}

// ── T4 结构性静态断言（消费点顺序 + 可观测）──
console.log("T4 index.ts 消费点顺序与事件字段");
{
  const src = fs.readFileSync(path.join(import.meta.dirname || __dirname, "src/index.ts"), "utf8");
  const patchIdx = src.indexOf("patchTaskRawPrompt({");
  const timeoutIdx = src.indexOf("setTimeout(() => {", patchIdx > -1 ? patchIdx - 4000 : 0);
  assert(patchIdx > 0, "index.ts 调用 patchTaskRawPrompt");
  assert(timeoutIdx > -1 && patchIdx < timeoutIdx, "在 setTimeout 之前调用（异步期 activeTask 会被下一轮覆盖）", { patchIdx, timeoutIdx });
  const enteredIdx = src.indexOf('action: "semantic_backward_entered"');
  assert(enteredIdx > patchIdx, "事件 semantic_backward_entered 在补齐之后记录", { enteredIdx, patchIdx });
  assert(/taskPromptPatch: _patch\.patchSource/.test(src), "事件带 taskPromptPatch（取材位置可审计）");
  assert(/taskPromptPatchedRawChars/.test(src), "事件带 taskPromptPatchedRawChars（补齐字符数可审计）");
  assert(/rawPrompt: _patch\.rawPrompt/.test(src), "buildBackwardTaskContext 使用补齐结果");
  assert(!/rawPrompt: matched\.rawUserPrompt/.test(src), "旧写法（直接用 matched.rawUserPrompt）已消除");
}

console.log(`\n${fail === 0 ? "ALL PASSED" : "FAILED"}  pass=${pass} fail=${fail}`);
if (fail > 0) process.exit(1);
