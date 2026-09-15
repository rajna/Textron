/**
 * 任务侧域闸（TASK-SIDE DOMAIN GATE）—— 反传写入侧的**单一裁决点**
 * ------------------------------------------------------------------
 * 真因（2026-09-15 n8 第十五轮 guard 实证）：
 * `pinnedTaskFamily=stock_alpha` 是**全局**配置（`route_policy_decision.reason="pinned_manual"`
 * 对 guard/sender/worker 所有会话生效），而原 goal guard 是**单向**的 ——
 *   ① rule 0（清道夫方向）：判「网络里已有节点是否离目标域」，用本轮知识去覆盖离域节点；
 *   ② 缺 D 侧：从不判「**本轮任务本身**是否属目标域」。
 * 于是工程/调度域任务的 HighEntropy 被合法写进交易网络：窗口内 9 条 `agent_end_task_pushed`
 * 有 4 条非交易域（工作流规范优化 / 多agent指令透传 / A股交易推进编排 / A股交易链路幂等），
 * 落盘符号 `carry_all_fn_blocks_on_relocate`、`guard_dispatch_constraint_passthrough`、
 * `minimize_workflow_handoff_fix` 全是工程域；淘汰后 content 仍挂 `[fn:σ]`
 * （实测 `L0::node_0` 悬空引用 **17 个**）⇒ 节点趋向关键词汤、L0 路由锚点被稀释。
 *
 * 本模块把「离域任务 ⇒ 内容零写入」的裁决与统计收敛到一处，供：
 *   - index.ts 的 `normalize()` 在解析 node_updates/add_nodes **之前**调用（早退即天然关闭
 *     goalCleanseFallback 这条同源污染通道）；
 *   - 测试直接调用同一份逻辑（禁止复刻，防「测试与实现漂移」）。
 *
 * 语义边界（务必保持）：
 *   - **只禁内容面**：node_updates / add_nodes / merge 语义 / Function 硬落盘。
 *   - **不禁学习面**：`reward` 原样返回 ⇒ autoBackward 仍更新边权 —— 本轮前向确实注入了本网络，
 *     边权是该事实的合法学习信号；被禁的是「把离域知识固化进节点容量」。
 *   - 判据仍由 LLM 给出（项目不变式：LLM 是唯一语义判据，程序侧零词表）。
 *   - 严格判据：仅 `off_domain === true`（boolean）触发；缺失 / false / "true" 字符串一律视为在域内。
 */

export interface DomainGateVerdict {
  /** 本轮任务是否被判为离目标域 */
  offDomain: boolean;
  /** 触发原因（LLM 自述，仅审计用） */
  reason: string;
  /** 被丢弃的 node_updates 条数（用于「内容零写入」可观测性） */
  strippedUpdates: number;
  /** 被丢弃的 add_nodes 条数 */
  strippedAdds: number;
}

/** 从反传 LLM 的原始 JSON 对象判定任务侧域闸。纯函数，无副作用。 */
export function evaluateTaskDomainGate(raw: unknown): DomainGateVerdict {
  const obj = (raw || {}) as {
    off_domain?: unknown;
    off_domain_reason?: unknown;
    rationale?: unknown;
    node_updates?: unknown;
    add_nodes?: unknown;
  };
  const offDomain = obj.off_domain === true;
  if (!offDomain) return { offDomain: false, reason: "", strippedUpdates: 0, strippedAdds: 0 };
  const updates = obj.node_updates && typeof obj.node_updates === "object" ? Object.keys(obj.node_updates as object).length : 0;
  return {
    offDomain: true,
    reason: String(obj.off_domain_reason || obj.rationale || "").slice(0, 200),
    strippedUpdates: updates,
    strippedAdds: Array.isArray(obj.add_nodes) ? obj.add_nodes.length : 0,
  };
}

/**
 * 任务侧域闸规则文本（与 rule 0 对称的另一半）。
 * 单独导出以便：①index.ts 拼 prompt；②测试断言「闸门先于 rule 0 生效」。
 */
export function taskDomainGateRule(netGoal: string): string {
  if (!netGoal) return "";
  return `-1. 🚧 TASK-SIDE DOMAIN GATE (ABSOLUTE — evaluate BEFORE every other rule). Network goal: "${netGoal}". FIRST judge whether THIS ROUND'S TASK (the "Previous user task" section below) itself belongs to that goal domain. If this round's task is NOT goal-domain (e.g. software engineering / refactoring / observability / workflow orchestration / UI / audit / config / agent-coordination while the goal is trading), you MUST return EXACTLY this shape and nothing else:
   {"off_domain": true, "off_domain_reason": "<one line, why this task is off-domain>", "reward": <STILL judge upstream feedback polarity per rule 2>, "node_actions": [{"action":"keep","rationale":"off_domain"}]}
   and you MUST NOT emit node_updates, add_nodes, or any Function-derived node content. Off-domain knowledge written into a goal-domain network is IRREVERSIBLE pollution: it forms keyword-soup nodes, dilutes the L0 routing anchors, and displaces scarce domain capacity (capacity is capped per layer — every off-domain write evicts a domain fact).
   Why this gate exists: rule 0 cleanses off-goal content ALREADY IN the network; this gate stops off-goal content from ENTERING. They are the two symmetric halves of one domain invariant.
   Default is IN-domain: when the task plausibly serves the goal (trading / market / position / risk / reusable strategy functions), or when you are genuinely unsure, do NOT set off_domain — proceed with normal rules.
`;
}
