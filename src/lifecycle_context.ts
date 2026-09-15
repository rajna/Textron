/**
 * 任务栈落盘契约（2026-09-15 第十三轮 n8 修复）
 * ------------------------------------------------------------------
 * 真因：`toPersist` 只写 taskType/taskFamily/highEntropy/activatedIds/ts/processLog，
 * 恢复侧又把 rawUserPrompt 硬编码为 "" ⇒ 重启后**每条回溯任务都丢失真实提问**，
 * `buildBackwardTaskContext` 因 rawPrompt 为空 + isPlaceholderRetryPrompt("")=true
 * 而退化到 `[HighEntropy Task] ${HE}`（learningPromptSource="high_entropy"）。
 * 后果：反传 LLM 的「任务侧」只剩 HE 摘要（实测 previousTaskChars=1141/5340 全为
 * HE+过程日志，任务原文 0c），无法判断「当初被要求做什么」⇒ 融合只能对着结果自说自话
 * （rationale 泛化、只能从错域任务编造）。这与「reward=上游反馈的量化、HE=事后总结」
 * 的不变式冲突：任务原文属**上游输入**，不可由事后总结替代。
 * 本模块是该持久化对的**单一事实来源**：序列化只此一处、反序列化只此一处。
 */
export const TASK_RAW_PROMPT_PERSIST_CAP = 4000;

export interface PersistedTask {
  taskType: string;
  taskFamily: string;
  highEntropy: string;
  activatedIds: string[];
  ts: string;
  processLog: string[];
  /** 任务原文（用户/上游 agent 实际发来的 prompt）。超 cap 显式截断并标记，禁静默 slice。 */
  rawUserPrompt?: string;
  /** 截断前的原始长度，供审计判断是否发生截断 */
  rawUserPromptChars?: number;
  rawUserPromptTruncated?: boolean;
}

export interface SerializeTaskOptions {
  /** processLog 保留条数（滚动丢最旧） */
  maxProcessEntries?: number;
  /** processLog 单条上限 */
  maxProcessEntryChars?: number;
  /** highEntropy 落盘上限 */
  highEntropyCap?: number;
  /** rawUserPrompt 落盘上限 */
  rawPromptCap?: number;
}

/** 任务 → 落盘结构（含任务原文）。所有上限显式传入，禁调用点写死。 */
export function serializeTaskForState(
  t: {
    taskType: string;
    taskFamily: string;
    highEntropy: string;
    activatedIds: string[];
    ts: string;
    processLog?: string[];
    rawUserPrompt?: string;
  },
  opts: SerializeTaskOptions = {},
): PersistedTask {
  const maxProcessEntries = opts.maxProcessEntries ?? 24;
  const maxProcessEntryChars = opts.maxProcessEntryChars ?? 20000;
  const heCap = opts.highEntropyCap ?? 2400;
  const rawCap = opts.rawPromptCap ?? TASK_RAW_PROMPT_PERSIST_CAP;
  const raw = String(t.rawUserPrompt || "");
  return {
    taskType: t.taskType || "",
    taskFamily: t.taskFamily || "",
    highEntropy: String(t.highEntropy || "").slice(0, heCap),
    activatedIds: [...(t.activatedIds || [])],
    ts: t.ts || "",
    processLog: (t.processLog || [])
      .slice(-maxProcessEntries)
      .map((e) => String(e || "").slice(0, maxProcessEntryChars)),
    rawUserPrompt: raw.length > rawCap ? raw.slice(0, rawCap) : raw,
    rawUserPromptChars: raw.length,
    rawUserPromptTruncated: raw.length > rawCap,
  };
}

/** 落盘结构 → 任务原文。旧档（无该字段）返回空串，退化为 HE 路径而非抛错。 */
export function restoreTaskPrompt(p: unknown): {
  rawUserPrompt: string;
  rawUserPromptChars: number;
  rawUserPromptTruncated: boolean;
} {
  const src = (p || {}) as { rawUserPrompt?: unknown; rawUserPromptChars?: unknown; rawUserPromptTruncated?: unknown };
  const raw = typeof src.rawUserPrompt === "string" ? src.rawUserPrompt : "";
  const chars = Number(src.rawUserPromptChars);
  return {
    rawUserPrompt: raw,
    rawUserPromptChars: Number.isFinite(chars) && chars > 0 ? chars : raw.length,
    rawUserPromptTruncated: !!src.rawUserPromptTruncated,
  };
}

export interface BackwardTaskContextInput {
  rawPrompt: string;
  effectivePrompt: string;
  highEntropy?: string;
  /** 任务开始→反馈之间累积的中间动作过程日志(由 agent_end 的 processLog 提供) */
  processLog?: string[];
}

export interface BackwardTaskContextResult {
  previousTaskForBackward: string;
  /** 受限后的过程上下文: 从 processLog 滚动保留最近条目, 总长 ≤ MAX_BACKWARD_PROCESS_CHARS */
  processContext: string;
  usedEffectivePrompt: boolean;
  rawPromptChars: number;
  effectivePromptChars: number;
  learningPromptSource: string;
  placeholderRetryPrompt: boolean;
}

/** 过程片段进入反传 LLM 的总长上限——中间动作可能很多, 防反传上下文膨胀 */
export const MAX_BACKWARD_PROCESS_CHARS = 2400;

function normalizePrompt(value: string): string {
  return String(value || "").trim();
}

/** 把中间动作过程日志压缩为受限文本: 保持时序, 从新到旧滚动截断, 总长 ≤ MAX_BACKWARD_PROCESS_CHARS。
 *  每条约 700c 上限已在写入侧控制; 这里兜底总预算, 确保反传上下文可预测。 */
function buildProcessContext(log: string[] | undefined): string {
  if (!log || log.length === 0) return "";
  const budget = MAX_BACKWARD_PROCESS_CHARS;
  const picked: string[] = [];
  let total = 0;
  for (let i = log.length - 1; i >= 0; i--) {
    const e = String(log[i] || "");
    const remain = budget - total;
    if (remain <= 0) break;
    if (e.length > remain) {
      picked.unshift(e.slice(0, remain - 3) + "…");
      total += remain;
      break;
    }
    picked.unshift(e);
    total += e.length;
  }
  return picked.join("\n");
}

/** Detect placeholder/retry prompts that contain no substantive task content. */
function isPlaceholderRetryPrompt(prompt: string): boolean {
  const s = prompt.trim();
  if (!s) return true;
  // Single-word or very short acknowledgments without task content
  if (/^(收到|OK|ok|好|知道了|继续|go|next|yes|no|done|start|开始|测试|test)\s*$/i.test(s)) return true;
  // Retry/debug noise
  if (/^(重试|retry|again|再试|再跑|重新|restart|reboot)\s*$/i.test(s)) return true;
  return false;
}

/**
 * Pi's before_agent_start hook can mutate event.prompt. Backward must learn from
 * the prompt the agent actually received, while keeping the original user text
 * available for audit and routing diagnostics.
 */
export function buildBackwardTaskContext(input: BackwardTaskContextInput): BackwardTaskContextResult {
  const rawPrompt = normalizePrompt(input.rawPrompt);
  const effectivePrompt = normalizePrompt(input.effectivePrompt);
  const usedEffectivePrompt = effectivePrompt.length > 0 && effectivePrompt !== rawPrompt;
  const isPlaceholder = isPlaceholderRetryPrompt(rawPrompt);
  const hasHighEntropy = !!(input.highEntropy && input.highEntropy.length > 30);

  // When it's a placeholder/retry and HighEntropy exists, use HighEntropy as the task
  // context so backward has something meaningful to learn from.
  const learningFromHighEntropy = isPlaceholder && hasHighEntropy;
  const taskForBackward = learningFromHighEntropy
    ? `[HighEntropy Task] ${input.highEntropy}`
    : (rawPrompt || effectivePrompt);

  return {
    previousTaskForBackward: taskForBackward,
    processContext: buildProcessContext(input.processLog),
    usedEffectivePrompt: false,
    rawPromptChars: rawPrompt.length,
    effectivePromptChars: effectivePrompt.length,
    learningPromptSource: learningFromHighEntropy ? "high_entropy" : "raw_prompt",
    placeholderRetryPrompt: isPlaceholder,
  };
}
