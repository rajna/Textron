import { buildTextronPromptInjection } from "./prompt_injection.ts";
import { buildBackwardTaskContext } from "./lifecycle_context.ts";

let passed = 0;
let failed = 0;

function ok(name: string, condition: boolean, detail = "") {
  if (condition) {
    passed++;
    console.log(`  OK ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}${detail ? ` - ${detail}` : ""}`);
  }
}

function testContextInjectionKeepsRawPromptSeparate() {
  const rawPrompt = "make the nav active glassy";
  const result = buildTextronPromptInjection({
    rawPrompt,
    taskFamily: "nbeat_ui_css",
    contextActivatedCount: 3,
    totalNodeCount: 32,
    selectedPathCount: 3,
    compiledContext: "## Textron Network: nbeat_ui_css\n- update final override too",
  });

  ok("rawPrompt remains unchanged", result.rawPrompt === rawPrompt);
  ok("effectivePrompt starts with raw prompt", result.effectivePrompt.startsWith(rawPrompt));
  ok("effectivePrompt contains Textron marker", result.effectivePrompt.includes("## 🧠 Textron (nbeat_ui_css, 3/32 nodes, 3 path)"));
  ok("effectivePrompt contains compiled context", result.effectivePrompt.includes("update final override too"));
  ok("audit raw chars use original prompt", result.audit.rawPromptChars === rawPrompt.length);
  ok("audit effective chars include injection", result.audit.effectivePromptChars === result.effectivePrompt.length && result.audit.effectivePromptChars > rawPrompt.length);
  ok("audit injectedInto is context.user_message", result.audit.injectedInto === "context.user_message");
}

function testZeroContextStillMutatesPromptButNoCompiledChars() {
  const rawPrompt = "status?";
  const result = buildTextronPromptInjection({
    rawPrompt,
    taskFamily: "testing",
    contextActivatedCount: 0,
    totalNodeCount: 32,
    selectedPathCount: 3,
    compiledContext: "",
  });

  ok("zero-context rawPrompt remains unchanged", result.rawPrompt === rawPrompt);
  ok("zero-context effectivePrompt contains preserved path marker", result.effectivePrompt.includes("0 nodes activated"));
  ok("zero-context compiled chars are zero", result.audit.compiledChars === 0);
  ok("zero-context effective prompt is longer", result.effectivePrompt.length > rawPrompt.length);
}

function testContextHookAppendsUserInjectionAndBackwardUsesEffectivePrompt() {
  const rawPrompt = "make active nav glassy";
  const result = buildTextronPromptInjection({
    rawPrompt,
    taskFamily: "nbeat_ui_css",
    contextActivatedCount: 1,
    totalNodeCount: 32,
    selectedPathCount: 3,
    compiledContext: "Use inset shadow for recessed glass UI.",
  });

  const userMessageText = rawPrompt + result.userInjection;
  const backwardContext = buildBackwardTaskContext({
    rawPrompt,
    effectivePrompt: result.effectivePrompt,
  });

  ok("context hook appends Textron marker to user message", userMessageText.includes("## 🧠 Textron"));
  ok("raw prompt excludes Textron marker for audit", !rawPrompt.includes("## 🧠 Textron"));
  ok("backward learns from raw user task, not injected Textron priors", backwardContext.previousTaskForBackward === rawPrompt);
  ok("backward records effective prompt unused for learning", backwardContext.usedEffectivePrompt === false);
}

function testBackwardFallsBackToRawPromptWhenNoInjectionHappened() {
  const rawPrompt = "plain user task";
  const backwardContext = buildBackwardTaskContext({ rawPrompt, effectivePrompt: rawPrompt });

  ok("backward falls back to raw prompt", backwardContext.previousTaskForBackward === rawPrompt);
  ok("fallback marks effective prompt unused", backwardContext.usedEffectivePrompt === false);
}

console.log("prompt_injection tests\n");
testContextInjectionKeepsRawPromptSeparate();
testZeroContextStillMutatesPromptButNoCompiledChars();
testContextHookAppendsUserInjectionAndBackwardUsesEffectivePrompt();
testBackwardFallsBackToRawPromptWhenNoInjectionHappened();

console.log(`\npassed=${passed} failed=${failed}`);
if (failed > 0) process.exit(1);
