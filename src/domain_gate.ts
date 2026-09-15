/**
 * 函数侧域闸（FUNCTION-SIDE DOMAIN GATE）—— 反传「程序化写入通道」的唯一裁决点
 * ------------------------------------------------------------------
 * ⚠️ 本模块是 **75847ed（任务侧域闸）的判据面迁移版**。迁移依据（n8 第十七轮 guard 实证）：
 *
 * 一、任务侧判据**结构上不可能触发**（≠实现 bug，故不可修，只能改维度）
 *   - 窗口 18:45–18:55Z：12 次反传 LLM 原输出 **无一** 含 `off_domain` 字段（0/12），
 *     `semantic_backward_off_domain` 连续三轮恒 0。
 *   - 同窗口 6 条 `agent_end_task_pushed` 的 taskType 全是交易/编排（A股限价撮合决策 /
 *     A股交易准入闸门修复 / 多智能体交易游戏派发记账）⇒ LLM 判「任务在域内」是**正确的**。
 *   - 但同轮 HE 仍产出 `sender_step_loop_orchestrate`（纯编排：计数口径解耦 / POST /api/step /
 *     session 重建）并写入 `L0::node_0`，把交易域块 `pi_star_gate_delta_decision` 顶出
 *     （`fn_block_evicted{dangling:[pi_star_gate_delta_decision]}`）。
 *   ⇒ 「任务域 ≠ 内容域」在多 agent 编排类任务里是**系统性**分离（任务名=交易推进，知识含编排）。
 *     任务侧闸要想触发，只能误杀真交易任务（正是 E3' 要防的）⇒ 死代码 + 每轮 ~1.6KB 规则占用注意力。
 *
 * 二、真正的污染入口是**程序侧两条免 LLM 判据的写入通道**（任务侧闸原意要 gate 的正是它们）
 *   ① `persistHighEntropyFunction` —— `<Function>` 块**硬落盘**（`highentropy_function_persisted`），
 *      不经过任何 LLM 语义判据；每节点 `NODE_FN_BLOCK_MAX=2`，落一个就淘汰一个已有函数槽。
 *   ② `buildHighEntropyAddCandidate` —— 无 node_updates 时用 HE 合成 add_node
 *      （`highentropy_fallback_add_candidate`）。
 *   ⇒ 二者写入的是「函数体/HE 摘要」本身，因此**判据也必须问「这条函数体是不是目标域」**，
 *     而不是问「本轮任务是不是目标域」。
 *
 * 语义边界（务必保持）：
 *   - **只 gate 上述两条程序化通道**；node_updates / add_nodes / merge 一律不受本闸影响
 *     （内容面由 rule 0 goal guard + LLM 三段式融合负责）⇒ 不再有「整轮早退」，不会误杀。
 *   - 判据仍由 LLM 给出（项目不变式：LLM 是唯一语义判据，程序侧零词表）。
 *   - 严格判据：仅 `function_off_goal === true`（boolean）触发；缺失 / false / "true" 字符串
 *     一律视为在域内 ⇒ **不输出字段时行为 ≡ 现状**（改动无法把系统改差，只能改善）。
 */

export interface FunctionDomainVerdict {
  /** 本轮 HighEntropy <Function> 块的机制是否被判为离目标域 */
  offGoal: boolean;
  /** 触发原因（LLM 自述，仅审计用） */
  reason: string;
}

/** 从反传 LLM 的原始 JSON 对象判定函数侧域闸。纯函数，无副作用。 */
export function evaluateFunctionDomainGate(raw: unknown): FunctionDomainVerdict {
  const obj = (raw || {}) as {
    function_off_goal?: unknown;
    function_off_goal_reason?: unknown;
    rationale?: unknown;
  };
  const offGoal = obj.function_off_goal === true;
  if (!offGoal) return { offGoal: false, reason: "" };
  return {
    offGoal: true,
    reason: String(obj.function_off_goal_reason || obj.rationale || "").slice(0, 200),
  };
}

/**
 * 函数侧域闸规则文本（替代任务侧规则；与 rule 0 goal guard 互补：rule 0 = 网内已有内容的清洗方向，
 * 本闸 = 本轮程序化写入的准入方向）。
 * 单独导出以便：①index.ts 拼 prompt；②测试断言「字段问法与消费点一致」。
 */
export function functionDomainGateRule(netGoal: string): string {
  if (!netGoal) return "";
  return `-1. 🚧 FUNCTION-SIDE DOMAIN GATE (evaluate FIRST — it gates a PROGRAM-side write, not your node text). Network goal: "${netGoal}".
   The "Function:" section below (when present) is this round's HighEntropy <Function> block. The SYSTEM persists it verbatim as a reusable function slot in a node, and each node holds only 2 slots — so every admission EVICTS one existing function. One off-goal admission therefore permanently costs one goal-domain function. Likewise, when you produce no node_updates the system synthesizes an add_node from this round's HighEntropy packet — same channel, same risk.
   Judge ONLY THE FUNCTION'S OWN MECHANISM (never the round's task label — a round may legitimately be "trade N times" while the function it produced is pure orchestration plumbing). Answer with one field:
   - "function_off_goal": true — the mechanism belongs to a DIFFERENT domain than the goal. Typical off-goal families when the goal is trading: software engineering / refactor / observability & logging / workflow orchestration / agent-to-agent messaging, relay & idempotency / API protocol, retry & session lifecycle / counting & bookkeeping plumbing / UI / config / audit-report writing.
   - "function_off_goal": false — the mechanism computes goal-domain knowledge: price/level/position sizing, risk or exposure, entry & exit gating, volatility, volume, K-line pattern, market structure, or a reusable strategy function.
   When true, also give "function_off_goal_reason": "<one line, why the function is off-goal>". Nothing else changes: node_updates / add_nodes / merge / reward still follow rules 0-10 normally.
   Default is false (in-goal) when genuinely unsure — an omitted field is treated as in-goal.
`;
}
