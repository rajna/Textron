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
  const trainingReminder = `\n\nTextron training note: historical prior above is context only; never copy it into <HighEntropy>. Final packet must be distilled from the current answer: Task (≤100 chars) states what problem was solved; Technique (≤500 chars) preserves the highest-information "道或术" used to solve it, favoring the answer's most distinctive sentences, identifiers, conditions, numbers, and decision boundaries over a session summary. Name joins 3-6 highest-entropy original terms lifted from Task+Technique; routing sees only Name.`;
  // 使用提示：注入的节点内容是历史经验，必须与最新环境/状态/信息对照后使用（防过时经验被当作当前事实）
  const historyHint = `\n\n⚠️ 以上是沉淀的精华的历史经验，还需结合最新的环境、最新的状态、最新的信息来利用。`;
  const userInjection = input.contextActivatedCount === 0
    ? `\n\n## 🧠 Textron (${input.taskFamily}, 0 context nodes injected; ${input.selectedPathCount} path nodes retained only for backward)\n${historyHint}\n`
    : `\n\n## 🧠 Textron (${input.taskFamily}, ${input.contextActivatedCount}/${input.totalNodeCount} nodes, ${input.selectedPathCount} path)\n${compiledContext}${historyHint}${trainingReminder}`;
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
