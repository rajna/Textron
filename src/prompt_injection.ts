export interface PromptInjectionInput {
  rawPrompt: string;
  taskFamily: string;
  contextActivatedCount: number;
  totalNodeCount: number;
  selectedPathCount: number;
  compiledContext: string;
}

export interface PromptInjectionResult {
  rawPrompt: string;
  effectivePrompt: string;
  userInjection: string;
  audit: {
    rawPromptChars: number;
    effectivePromptChars: number;
    compiledChars: number;
    injectedInto: "context.user_message";
    promptTailPreview: string;
  };
}

function preview(input: string, maxLen = 220): string {
  const normalized = String(input || "").replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLen) return normalized;
  return normalized.slice(0, maxLen - 1) + "…";
}

export function buildTextronPromptInjection(input: PromptInjectionInput): PromptInjectionResult {
  const rawPrompt = input.rawPrompt || "";
  const compiledContext = input.compiledContext || "";
  const trainingReminder = `\n\nTextron training note: historical prior above is context only. Do not quote/copy it into <HighEntropy>. Final <HighEntropy> must capture this turn's high-entropy experience atom for Textron learning. Name = 从 Content 提取 3-6 个最高熵关键术语拼接（技术标识符/领域信号词/数值，取原词、空格分隔）——节点评分/路由只看 name，禁止泛化总结句或 Content 首句截断。Content = reusable insight that would change future behavior/context selection in similar tasks: constraint, correction, causal mechanism, decision boundary, validation signal, or strategy pattern.`;
  const userInjection = input.contextActivatedCount === 0
    ? `\n\n## 🧠 Textron (${input.taskFamily}, 0 nodes activated — path preserved for backward)\n`
    : `\n\n## 🧠 Textron (${input.taskFamily}, ${input.contextActivatedCount}/${input.totalNodeCount} nodes, ${input.selectedPathCount} path)\n${compiledContext}${trainingReminder}`;
  const effectivePrompt = rawPrompt + userInjection;

  return {
    rawPrompt,
    effectivePrompt,
    userInjection,
    audit: {
      rawPromptChars: rawPrompt.length,
      effectivePromptChars: effectivePrompt.length,
      compiledChars: compiledContext.length,
      injectedInto: "context.user_message",
      promptTailPreview: preview(effectivePrompt.slice(-500)),
    },
  };
}
