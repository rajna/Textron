export interface BackwardTaskContextInput {
  rawPrompt: string;
  effectivePrompt: string;
}

export interface BackwardTaskContextResult {
  previousTaskForBackward: string;
  usedEffectivePrompt: boolean;
  rawPromptChars: number;
  effectivePromptChars: number;
}

function normalizePrompt(value: string): string {
  return String(value || "").trim();
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
  // Backward should learn from the user's task, not from injected TextronSkill priors.
  // HighEntropy supplies the assistant's reusable lesson separately.
  return {
    previousTaskForBackward: rawPrompt || effectivePrompt,
    usedEffectivePrompt: false,
    rawPromptChars: rawPrompt.length,
    effectivePromptChars: effectivePrompt.length,
  };
}
