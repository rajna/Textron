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
