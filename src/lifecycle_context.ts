export interface BackwardTaskContextInput {
  rawPrompt: string;
  effectivePrompt: string;
  highEntropy?: string;
}

export interface BackwardTaskContextResult {
  previousTaskForBackward: string;
  usedEffectivePrompt: boolean;
  rawPromptChars: number;
  effectivePromptChars: number;
  learningPromptSource: string;
  placeholderRetryPrompt: boolean;
  hasDomainEvidence: boolean;
}

function normalizePrompt(value: string): string {
  return String(value || "").trim();
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

/** Detect whether the prompt contains domain-relevant evidence.
 *  Without domain evidence, backward merge/delete should be blocked
 *  to prevent LLM from fabricating operations on noise inputs.
 *
 *  检测三类领域证据:
 *  1. 星象/天象术语
 *  2. 金融/A股市场术语
 *  3. Textron系统本身的技术操作（改代码/修bug）不算领域证据
 */
function hasNewDomainEvidence(prompt: string, networkTaskFamily: string): boolean {
  const s = prompt.trim();
  if (s.length < 20) return false; // too short to contain evidence

  // Astro-stock domain signals
  const astroStockDomain = /(星象|相位|行星|宫位|星座|天象|上证|A股|深证|K线|均线|MACD|KDJ|RSI|月冲|月刑|月合|日冲|日刑|对冲|合相|六合|拱相|反弹|反转|支撑|压力|放量|缩量|涨跌|收盘|开盘|高开|低开|涨停|跌停|指数|[46]\d{3}\.?\d{0,2}|预测|准确率|胜率|回测|验证|horoscope|astrology|zodiac|planet|aspect)/;
  if (astroStockDomain.test(s)) return true;

  // NBeat music domain signals
  const nbeatDomain = /(beat|bpm|chord|melody|groove|rhythm|tempo|key|scale|mode|midi|wave|audio|sample|synth|drum|bass|vocal|mix|master|compressor|EQ|reverb|delay|MT_chord|MT_groove|MT_melody|OP_|COP_|MCT_)/i;
  if (nbeatDomain.test(s)) return true;

  // Meta-technique domain signals
  const metaTechDomain = /(元操作|二元算子|EML|归约|最小化|基元|meta.operation|元技巧|算子|元操作符|封闭性|完备性|递归应用|嵌套组合|技巧库|抽象层|正交维度|系统化|元结构|生成元|元逻辑|压缩比|L0.*元技巧|L1.*元技巧|第一性原理|核心规律|本质规律|底层逻辑)/;
  if (metaTechDomain.test(s)) return true;

  // Generic substantive feedback: ≥60 chars with explicit outcome markers
  if (s.length >= 60 && /(结果|实际|真实|验证|确认|发现|原因|根因|修复|解决|成功|失败|有效|无效|结论|总结|复盘|回顾)/.test(s)) return true;

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
  const domainEvidence = hasNewDomainEvidence(rawPrompt, "");
  const hasHighEntropy = !!(input.highEntropy && input.highEntropy.length > 30);

  // When it's a placeholder/retry and HighEntropy exists, use HighEntropy as the task
  // context so backward has something meaningful to learn from.
  const learningFromHighEntropy = isPlaceholder && hasHighEntropy;
  const taskForBackward = learningFromHighEntropy
    ? `[HighEntropy Task] ${input.highEntropy}`
    : (rawPrompt || effectivePrompt);

  return {
    previousTaskForBackward: taskForBackward,
    usedEffectivePrompt: false,
    rawPromptChars: rawPrompt.length,
    effectivePromptChars: effectivePrompt.length,
    learningPromptSource: learningFromHighEntropy ? "high_entropy" : "raw_prompt",
    placeholderRetryPrompt: isPlaceholder,
    hasDomainEvidence: domainEvidence,
  };
}
