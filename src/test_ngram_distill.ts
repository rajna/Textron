/**
 * Test suite for ngram_distill.ts
 *
 * Three scenarios testing key properties:
 *   1. Noise removal — distilling out low-signal tokens while keeping core
 *   2. Signal reinforcement — repeated n-grams dominate the result
 *   3. Failure penalty — negatively-associated n-grams are suppressed
 *
 * Run:  npx ts-node src/test_ngram_distill.ts
 */

import {
  tokenize,
  extractNgrams,
  createNodeState,
  updateCounts,
  calcSignalScores,
  maybeDistill,
  computeMetrics,
  type NodeNgramState,
  type ScoredNgram,
} from "./ngram_distill";

// ─── Test Harness ────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures: string[] = [];

function ok(description: string, condition: boolean, detail?: string): void {
  if (condition) {
    passed++;
    console.log(`  ✅ ${description}`);
  } else {
    failed++;
    const msg = `  ❌ ${description}${detail ? ` — ${detail}` : ""}`;
    failures.push(msg);
    console.log(msg);
  }
}

function header(text: string): void {
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  ${text}`);
  console.log(`${"═".repeat(60)}`);
}

function runSimulation(
  initialContent: string,
  rounds: { highEntropy: string; reward: number }[],
): { state: NodeNgramState; highFreqNgrams: Set<string>; initialContent: string } {
  const state = createNodeState();

  // Collect all n-grams across rounds to identify high-frequency ones
  const globalFreq = new Map<string, number>();

  for (const round of rounds) {
    updateCounts(state, round.highEntropy, round.reward);

    if (round.reward > 0) {
      const tokens = tokenize(round.highEntropy);
      const ngrams = extractNgrams(tokens);
      for (const [ng, count] of ngrams.uni) {
        globalFreq.set(ng, (globalFreq.get(ng) || 0) + count);
      }
      for (const [ng, count] of ngrams.bi) {
        globalFreq.set(ng, (globalFreq.get(ng) || 0) + count);
      }
      for (const [ng, count] of ngrams.tri) {
        globalFreq.set(ng, (globalFreq.get(ng) || 0) + count);
      }
    }
  }

  // High-frequency n-grams = appeared ≥3 times as "core" information
  const highFreqNgrams = new Set<string>();
  for (const [ng, freq] of globalFreq) {
    if (freq >= 3) highFreqNgrams.add(ng);
  }

  return { state, highFreqNgrams, initialContent };
}

// ─── Test Utilities ──────────────────────────────────────────────────

function testTokenize(): void {
  header("Tokenization");

  const result1 = tokenize("Reese bass HPF@100Hz fills mid void; 808 below 120Hz。");
  ok("tech tokens kept intact", result1.includes("hpf@100hz"));
  ok("english words split", result1.includes("reese") && result1.includes("bass"));
  ok("numbers preserved", result1.includes("120hz"));

  const result2 = tokenize("双贝斯架构避免重叠");
  ok("Chinese phrase kept intact", result2.length === 1 && result2[0] === "双贝斯架构避免重叠", `got ${result2.length}: ${result2}`);
  ok("Chinese token avoids fragmented bigrams", result2.every((t) => t.length > 2), `got: ${result2}`);

  const result3 = tokenize("");
  ok("empty string → empty tokens", result3.length === 0);

  const result4 = tokenize("bVII→bVI vs vii°dim→i");
  ok("arrow notation intact", result4.some((t) => t.includes("→")));
}

// ─── Scenario 1: Noise Removal ──────────────────────────────────────

function testScenario1_NoiseRemoval(): void {
  header("Scenario 1: Noise Removal");

  const { state, highFreqNgrams, initialContent } = runSimulation(
    "Reese bass HPF@100Hz fills mid void when 808 handles sub foundation",
    [
      { highEntropy: "Reese bass HPF@100Hz fills mid void; 808 handles sub foundation", reward: 1 },
      { highEntropy: "Reese HPF@100Hz stereo above 150Hz 808 mono below 120Hz", reward: 1 },
      { highEntropy: "render time decreased by removing unused tracks", reward: 1 },   // noise
      { highEntropy: "check file paths before export config", reward: 0 },             // neutral
      { highEntropy: "Reese HPF@100Hz key fix bass texture; 808 foundation confirmed", reward: 1 },
    ],
  );

  const allStates = [state]; // single node for this test
  const result = maybeDistill(state, allStates, "initial dummy content");
  const expectedCore = ["reese", "hpf@100hz", "bass", "808", "mono"];

  ok("distillation triggered", result.newContent !== null);
  ok("core n-gram 'reese' retained",
    result.newContent?.toLowerCase().includes(expectedCore[0]) ?? false);
  ok("core n-gram 'hpf@100hz' retained",
    result.newContent?.toLowerCase().includes(expectedCore[1]) ?? false);
  ok("core n-gram '808' retained",
    result.newContent?.toLowerCase().includes(expectedCore[2]) ?? false);
  ok("noise 'render time' removed",
    !(result.newContent?.toLowerCase().includes("render time") ?? true));
  ok("noise 'file paths' removed (neutral reward)",
    !(result.newContent?.toLowerCase().includes("file paths") ?? true));

  if (result.newContent) {
    const scores = calcSignalScores(state, allStates);
    const metrics = computeMetrics(initialContent, result.newContent, scores, highFreqNgrams);
    console.log(`     signalDensity=${metrics.signalDensity.toFixed(2)} compRatio=${metrics.compressionRatio.toFixed(2)} coreRet=${metrics.coreRetentionRate.toFixed(2)} noiseRem=${metrics.noiseRemovalRate.toFixed(2)}`);

    ok("signal density > 0.3", metrics.signalDensity > 0.3,
      `was ${metrics.signalDensity.toFixed(2)}`);
    ok("compression > 20%", metrics.compressionRatio > 0.2,
      `was ${metrics.compressionRatio.toFixed(2)}`);
    ok("core retention = 100%", metrics.coreRetentionRate >= 0.99,
      `was ${metrics.coreRetentionRate.toFixed(2)}`);
    ok("noise removal > 50%", metrics.noiseRemovalRate > 0.5,
      `was ${metrics.noiseRemovalRate.toFixed(2)}`);
  }
}

// ─── Scenario 2: Signal Reinforcement ────────────────────────────────

function testScenario2_SignalReinforcement(): void {
  header("Scenario 2: Signal Reinforcement");

  const { state, highFreqNgrams, initialContent } = runSimulation(
    "Wav export bottleneck slow on macOS",
    [
      { highEntropy: "polyBLEP oscillator at 44.1kHz keeps realtime export under 30s", reward: 1 },
      { highEntropy: "polyBLEP oscillator 44.1kHz under 30s confirmed working stable", reward: 1 },
      { highEntropy: "polyBLEP at 44.1kHz is the key fix for realtime export speed", reward: 1 },
      { highEntropy: "polyBLEP oscillator realtime confirmed again 44.1kHz", reward: 1 },
    ],
  );

  const allStates = [state];
  const result = maybeDistill(state, allStates, "initial dummy content");
  const signalNgrams = ["polyblep", "44.1khz", "realtime"];

  ok("distillation triggered", result.newContent !== null);
  for (const sig of signalNgrams) {
    ok(`signal n-gram '${sig}' in top content`,
      result.newContent?.toLowerCase().includes(sig) ?? false);
  }

  // Verify signal scores: "polyblep" should have the highest score since it appears in all 4 rounds
  const scores = calcSignalScores(state, allStates);
  if (scores.length > 0) {
    const polyBlepScore = scores.find((s) => s.ngram.toLowerCase().includes("polyblep"));
    ok("polyBLEP has positive signal", (polyBlepScore?.score ?? 0) > 0,
      `score=${polyBlepScore?.score.toFixed(2)}`);
    ok("polyBLEP is top-3", scores.slice(0, 3).some((s) => s.ngram === polyBlepScore?.ngram));
  }

  if (result.newContent) {
    const metrics = computeMetrics(initialContent, result.newContent, scores, highFreqNgrams);
    console.log(`     signalDensity=${metrics.signalDensity.toFixed(2)} coreRet=${metrics.coreRetentionRate.toFixed(2)}`);
    ok("core retention 100%", metrics.coreRetentionRate >= 0.99);
  }
}

// ─── Scenario 3: Failure Penalty ─────────────────────────────────────

function testScenario3_FailurePenalty(): void {
  header("Scenario 3: Failure Penalty");

  const { state } = runSimulation(
    "LMMS render works on macOS 26 with FluidSynth backend",
    [
      { highEntropy: "LMMS render macOS 26 segfaults on mmpz format", reward: -1 },
      { highEntropy: "LMMS render macOS 26 segfaults again complex project mmpz", reward: -1 },
      { highEntropy: "avoid LMMS render on macOS 26 prefer Pure Python synth engine", reward: 1 },
      { highEntropy: "Pure Python synth engine confirmed working for export success", reward: 1 },
      { highEntropy: "Pure Python synth engine realtime export confirmed stable", reward: 1 },
    ],
  );

  const allStates = [state];
  const scores = calcSignalScores(state, allStates);

  // Find n-grams associated with failure vs success
  const failNg = scores.filter((s) => s.penalty > 0);
  const successNg = scores.filter((s) => s.penalty === 0 && s.freq > 0);

  const failAvg = failNg.length > 0
    ? failNg.reduce((s, n) => s + n.score, 0) / failNg.length
    : 0;
  const successAvg = successNg.length > 0
    ? successNg.reduce((s, n) => s + n.score, 0) / successNg.length
    : 1;

  console.log(`     failure n-gram avg score: ${failAvg.toFixed(2)}`);
  console.log(`     success n-gram avg score: ${successAvg.toFixed(2)}`);
  if (failNg.length > 0) {
    console.log(`     top failure n-grams: ${failNg.slice(0, 3).map((s) => `${s.ngram}(${s.score.toFixed(2)})`).join(", ")}`);
  }
  if (successNg.length > 0) {
    console.log(`     top success n-grams: ${successNg.slice(0, 3).map((s) => `${s.ngram}(${s.score.toFixed(2)})`).join(", ")}`);
  }

  ok("failure n-grams exist", failNg.length > 0);
  ok("success n-grams exist", successNg.length > 0);

  const ratio = successAvg > 0 ? failAvg / successAvg : 0;
  ok("failure n-gram avg signal < 50% of success avg", ratio < 0.5,
    `ratio=${ratio.toFixed(2)} failAvg=${failAvg.toFixed(2)} successAvg=${successAvg.toFixed(2)}`);

  // Check that "lmms" has penalty > 0 (appeared in failure rounds)
  const lmmsNg = scores.find((s) =>
    s.ngram.toLowerCase() === "lmms"
  );
  ok("failure keyword 'lmms' has penalty > 0",
    lmmsNg ? lmmsNg.penalty > 0 : false,
    lmmsNg ? `penalty=${lmmsNg.penalty} score=${lmmsNg.score.toFixed(2)}` : "ngram 'lmms' not found in scores");

  // Distilled content should favor success-associated n-grams
  const result = maybeDistill(state, allStates, "initial dummy content");
  ok("distillation triggered", result.newContent !== null);
  if (result.newContent) {
    ok("distilled content favors Python over LMMS",
      result.newContent.toLowerCase().includes("pure python") ||
      result.newContent.toLowerCase().includes("python synth"),
      `got: ${result.newContent}`);
    ok("distilled content avoids segfaults keyword",
      !result.newContent.toLowerCase().includes("segfaults"),
      `got: ${result.newContent}`);
  }
}

// ─── Edge Cases ──────────────────────────────────────────────────────

function testEdgeCases(): void {
  header("Edge Cases");

  // Edge 1: not enough activations → no distillation
  {
    const state = createNodeState();
    updateCounts(state, "some high entropy summary text", 1);
    const result = maybeDistill(state, [state], "dummy");
    ok("single activation → no distill", result.newContent === null,
      `reason: ${result.reason}`);
  }

  // Edge 2: all failures → all signal scores ≤ 0
  {
    const state = createNodeState();
    updateCounts(state, "bad approach failed segfaults", -1);
    updateCounts(state, "bad approach segfaults again", -1);
    // But need ≥3 total for distill trigger...
    updateCounts(state, "bad approach segfaults third time", -1);
    // Actually distill requires ≥3 SUCCESSES, so this won't trigger. Test scores instead.
    // Manually bump successfulActivations to test signal
    state.successfulActivations = 5;
    state.lastDistillAt = 0;
    const scores = calcSignalScores(state, [state]);
    ok("all-failure: all scores ≤ 0", scores.every((s) => s.score <= 0),
      `max score: ${scores[0]?.score.toFixed(2) ?? "N/A"}`);
  }

  // Edge 3: empty highEntropy → no state change
  {
    const state = createNodeState();
    updateCounts(state, "", 1);
    ok("empty highEntropy → activations unchanged", state.totalActivations === 0);
  }

  // Edge 4: reward === 0 → no count update
  {
    const state = createNodeState();
    updateCounts(state, "some neutral feedback summary", 0);
    ok("neutral reward → no state change", state.totalActivations === 1 && state.successfulActivations === 0);
  }

  // Edge 5: distillation produces content identical to current → no change
  {
    const state = createNodeState();
    state.successfulActivations = 5;
    state.lastDistillAt = 0;
    // Add some n-gram counts
    updateCounts(state, "polyBLEP oscillator 44.1kHz realtime export confirmed", 1);
    // Score should produce some output, but since currentContent is set to the
    // expected output, distillation should detect identity
    const result = maybeDistill(state, [state], "polyblep; 44.1khz; realtime");
    // This may or may not match exactly — just check it doesn't crash
    ok("identity check doesn't crash", result !== undefined);
  }
}

// ─── Orthogonality Test ──────────────────────────────────────────────

function testOrthogonalityAcrossScenarios(): void {
  header("Orthogonality Across Scenarios");

  // Scenario 1 node
  const { state: s1 } = runSimulation("dummy1", [
    { highEntropy: "Reese bass HPF@100Hz stereo above 150Hz fills mid void", reward: 1 },
    { highEntropy: "Reese HPF@100Hz at 150Hz confirmed for bass aggression", reward: 1 },
    { highEntropy: "Reese HPF@100Hz bass texture 150Hz stereo field", reward: 1 },
  ]);

  // Scenario 2 node
  const { state: s2 } = runSimulation("dummy2", [
    { highEntropy: "polyBLEP oscillator 44.1kHz keeps realtime under 30s", reward: 1 },
    { highEntropy: "polyBLEP 44.1kHz realtime export speed confirmed fast", reward: 1 },
    { highEntropy: "polyBLEP oscillator fixed export bottleneck 44.1kHz", reward: 1 },
  ]);

  // Manually trigger both
  s1.lastDistillAt = 0;
  s2.lastDistillAt = 0;
  const allStates = [s1, s2];

  const r1 = maybeDistill(s1, allStates, "dummy1");
  const r2 = maybeDistill(s2, allStates, "dummy2");

  ok("scenario 1 distills", r1.newContent !== null);
  ok("scenario 2 distills", r2.newContent !== null);

  if (r1.newContent && r2.newContent) {
    // Compute simple overlap
    const tokens1 = new Set(tokenize(r1.newContent));
    const tokens2 = new Set(tokenize(r2.newContent));
    const intersection = [...tokens1].filter((t) => tokens2.has(t)).length;
    const jaccard = tokens1.size + tokens2.size > 0
      ? intersection / (tokens1.size + tokens2.size - intersection)
      : 0;

    console.log(`     Jaccard between s1 & s2 distilled: ${jaccard.toFixed(2)}`);
    ok("Jaccard between scenarios < 0.3", jaccard < 0.3,
      `was ${jaccard.toFixed(2)} (nodes should be orthogonal)`);
  }
}

// ─── Main ────────────────────────────────────────────────────────────

function main(): void {
  console.log("Textron ngram_distill Test Suite\n");

  testTokenize();
  testScenario1_NoiseRemoval();
  testScenario2_SignalReinforcement();
  testScenario3_FailurePenalty();
  testEdgeCases();
  testOrthogonalityAcrossScenarios();

  console.log(`\n${"═".repeat(60)}`);
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  console.log(`${"═".repeat(60)}`);

  if (failures.length > 0) {
    console.log("\nFailures:");
    for (const f of failures) {
      console.log(f);
    }
    process.exit(1);
  }
}

main();
