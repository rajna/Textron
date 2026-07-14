/**
 * ngram_distill — n-gram signal distillation for Textron node content
 *
 * Each node accumulates uni/bigram/trigram frequency counts from
 * HighEntropy summaries of successful/failed tasks. When a node
 * accumulates ≥3 successful activations since last distillation,
 * the top-k highest-signal n-grams replace the node content.
 *
 * Pure counting — zero embeddings, zero API calls.
 */

// ─── Types ──────────────────────────────────────────────────────────

export interface NgramCounts {
  /** Success-path n-gram frequencies */
  uni: Record<string, number>;
  bi: Record<string, number>;
  tri: Record<string, number>;

  /** Failure-path n-gram frequencies (for penalty) */
  penalty_uni: Record<string, number>;
  penalty_bi: Record<string, number>;
  penalty_tri: Record<string, number>;
}

export interface NodeNgramState extends NgramCounts {
  totalActivations: number;
  successfulActivations: number;
  lastDistillAt: number;
}

export interface DistillResult {
  /** New distilled content, or null if distillation not triggered */
  newContent: string | null;
  /** Top-k scored n-grams with their signal scores */
  topNgrams: { ngram: string; score: number }[];
  /** Reason if not triggered */
  reason?: string;
}

// ─── Constants ──────────────────────────────────────────────────────

const DISTILL_TRIGGER = 3;       // min successful activations since last distill
const TOP_K = 5;                  // n-grams to keep
const TRIGRAM_WEIGHT = 1.5;     // extra weight for trigrams (rarer → more informative)
const PENALTY_ALPHA = 0.5;      // failure penalty strength
const MIN_TOKEN_LEN = 2;         // skip tokens shorter than this

// ─── Tokenization ───────────────────────────────────────────────────

function isAllCJK(s: string): boolean {
  return /^[\u4e00-\u9fff]+$/.test(s);
}

function isCjkOverlapChain(ngram: string): boolean {
  const parts = String(ngram || "").split(/\s+/).filter(Boolean);
  if (parts.length < 2) return false;
  let chained = 0;
  for (let i = 0; i < parts.length - 1; i++) {
    const a = parts[i];
    const b = parts[i + 1];
    if (/^[\u4e00-\u9fff]{2}$/.test(a) && /^[\u4e00-\u9fff]{2}$/.test(b) && a[1] === b[0]) chained++;
  }
  return chained >= 1;
}

/**
 * Tokenize text into tokens suitable for n-gram extraction.
 *
 * Rules:
 *   - English/tech tokens kept intact: "HPF@100Hz", "44.1kHz", "bVII→bVI"
 *   - Chinese chunks are kept intact instead of char-bigrammed to avoid fragment chains
 *   - Punctuation/whitespace used as split boundaries then discarded
 */
export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  const chunks = String(text || "")
    .split(/[\s,，。！？、:：;；()\[\]{}|=\-—]+/)
    .filter(Boolean);

  for (const chunk of chunks) {
    const lower = chunk.toLowerCase();
    if (isAllCJK(lower)) {
      // Keep CJK phrases intact. Sliding char-bigrams created artifacts like
      // "但质 质量 量未" that are unusable as node knowledge.
      if (lower.length >= MIN_TOKEN_LEN && lower.length <= 24) tokens.push(lower);
    } else {
      // Keep tech tokens intact
      if (lower.length >= MIN_TOKEN_LEN) tokens.push(lower);
    }
  }

  return tokens;
}

// ─── n-gram Extraction ──────────────────────────────────────────────

export interface ExtractedNgrams {
  uni: Map<string, number>;
  bi: Map<string, number>;
  tri: Map<string, number>;
}

export function extractNgrams(tokens: string[]): ExtractedNgrams {
  const uni = new Map<string, number>();
  const bi = new Map<string, number>();
  const tri = new Map<string, number>();

  for (let i = 0; i < tokens.length; i++) {
    incMap(uni, tokens[i]);
    if (i < tokens.length - 1) {
      incMap(bi, `${tokens[i]} ${tokens[i + 1]}`);
    }
    if (i < tokens.length - 2) {
      incMap(tri, `${tokens[i]} ${tokens[i + 1]} ${tokens[i + 2]}`);
    }
  }

  return { uni, bi, tri };
}

function incMap(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) || 0) + 1);
}

// ─── State Management ────────────────────────────────────────────────

const EMPTY_COUNTS = { uni: {}, bi: {}, tri: {}, penalty_uni: {}, penalty_bi: {}, penalty_tri: {} };

export function createNodeState(): NodeNgramState {
  return {
    uni: {},
    bi: {},
    tri: {},
    penalty_uni: {},
    penalty_bi: {},
    penalty_tri: {},
    totalActivations: 0,
    successfulActivations: 0,
    lastDistillAt: 0,
  };
}

export function serializeState(state: NodeNgramState): string {
  return JSON.stringify(state);
}

export function deserializeState(json: string): NodeNgramState {
  try {
    const parsed = JSON.parse(json);
    return {
      uni: parsed.uni || {},
      bi: parsed.bi || {},
      tri: parsed.tri || {},
      penalty_uni: parsed.penalty_uni || {},
      penalty_bi: parsed.penalty_bi || {},
      penalty_tri: parsed.penalty_tri || {},
      totalActivations: parsed.totalActivations || 0,
      successfulActivations: parsed.successfulActivations || 0,
      lastDistillAt: parsed.lastDistillAt || 0,
    };
  } catch {
    return createNodeState();
  }
}

// ─── Update Counts ──────────────────────────────────────────────────

/**
 * Update a node's n-gram state from one turn's HighEntropy + reward.
 */
export function updateCounts(
  state: NodeNgramState,
  highEntropy: string,
  reward: number,
): void {
  if (!highEntropy) return;

  const tokens = tokenize(highEntropy);
  const ngrams = extractNgrams(tokens);

  state.totalActivations++;

  if (reward > 0) {
    state.successfulActivations++;
    mergeIntoRecord(state.uni, ngrams.uni);
    mergeIntoRecord(state.bi, ngrams.bi);
    mergeIntoRecord(state.tri, ngrams.tri);
  } else if (reward < 0) {
    mergeIntoRecord(state.penalty_uni, ngrams.uni);
    mergeIntoRecord(state.penalty_bi, ngrams.bi);
    mergeIntoRecord(state.penalty_tri, ngrams.tri);
  }
  // reward === 0 → neutral, don't count
}

function mergeIntoRecord(record: Record<string, number>, map: Map<string, number>): void {
  for (const [key, count] of map) {
    record[key] = (record[key] || 0) + count;
  }
}

// ─── Signal Scoring ──────────────────────────────────────────────────

interface ScoredNgram {
  ngram: string;
  score: number;
  freq: number;
  idf: number;
  maxOtherFreq: number;
  penalty: number;
}

/**
 * Compute signal scores for all n-grams in a node, relative to all peer nodes.
 */
export function calcSignalScores(
  state: NodeNgramState,
  allStates: NodeNgramState[],
): ScoredNgram[] {
  const totalNodes = allStates.length || 1;
  const merged = new Map<string, { freq: number; penalty: number }>();

  // Merge uni + bi + tri into single map, weighted
  mergeWeighted(merged, state.uni, state.penalty_uni, 1.0);
  mergeWeighted(merged, state.bi, state.penalty_bi, 1.0);
  mergeWeighted(merged, state.tri, state.penalty_tri, TRIGRAM_WEIGHT);

  const results: ScoredNgram[] = [];

  for (const [ngram, { freq, penalty }] of merged) {
    if (isCjkOverlapChain(ngram)) continue;
    // Compute document frequency across other nodes
    let docFreq = 0;
    let maxOtherFreq = 0;

    for (const other of allStates) {
      if (other === state) continue;
      const of =
        (other.uni[ngram] || 0) +
        (other.bi[ngram] || 0) +
        (other.tri[ngram] || 0);
      if (of > 0) docFreq++;
      maxOtherFreq = Math.max(maxOtherFreq, of);
    }

    const idf = totalNodes > 1
      ? Math.log(totalNodes / Math.max(1, docFreq))
      : 1.0;  // single-node: no IDF normalization, use raw frequency
    let signal = freq * idf / (1 + maxOtherFreq);
    signal -= PENALTY_ALPHA * penalty;
    signal = Math.max(0, signal);

    results.push({
      ngram,
      score: signal,
      freq,
      idf,
      maxOtherFreq,
      penalty,
    });
  }

  results.sort((a, b) => b.score - a.score);
  return results;
}

function mergeWeighted(
  target: Map<string, { freq: number; penalty: number }>,
  freqRecord: Record<string, number>,
  penaltyRecord: Record<string, number>,
  weight: number,
): void {
  for (const [ngram, f] of Object.entries(freqRecord)) {
    const existing = target.get(ngram);
    const p = (penaltyRecord[ngram] || 0) * weight;
    if (existing) {
      existing.freq += f * weight;
      existing.penalty += p;
    } else {
      target.set(ngram, { freq: f * weight, penalty: p });
    }
  }
}

// ─── Distillation ────────────────────────────────────────────────────

/**
 * Attempt to distill a node's content. Returns new content if triggered,
 * or null with reason if not.
 */
export function maybeDistill(
  state: NodeNgramState,
  allStates: NodeNgramState[],
  currentContent?: string,
): DistillResult {
  const newSuccesses = state.successfulActivations - state.lastDistillAt;

  if (newSuccesses < DISTILL_TRIGGER) {
    return {
      newContent: null,
      topNgrams: [],
      reason: `not enough new successes: ${newSuccesses}/${DISTILL_TRIGGER}`,
    };
  }

  const scores = calcSignalScores(state, allStates);
  const topK = scores.slice(0, TOP_K);

  if (topK.length === 0 || topK[0].score <= 0) {
    return {
      newContent: null,
      topNgrams: topK,
      reason: "no positive-signal n-grams (all penalized or zero)",
    };
  }

  // Preserve original content as fallback if distillation produces worse content
  const newContent = topK.map((s) => s.ngram).join("; ");

  // Only replace if the new content is different and has signal
  if (currentContent && newContent === currentContent) {
    return {
      newContent: null,
      topNgrams: topK,
      reason: "distilled content identical to current",
    };
  }

  state.lastDistillAt = state.successfulActivations;
  return { newContent, topNgrams: topK };
}

// ─── Quality Metrics (for testing) ──────────────────────────────────

export interface DistillMetrics {
  signalDensity: number;
  compressionRatio: number;
  coreRetentionRate: number;
  noiseRemovalRate: number;
  failureNgramSignalRatio: number;
}

/**
 * Compute quality metrics comparing old vs new content after distillation.
 *
 * @param oldContent - node content before distillation
 * @param newContent - node content after distillation
 * @param scores - scored n-grams from calcSignalScores
 * @param highFreqNgrams - set of n-grams that appeared ≥3 times (considered "core")
 */
export function computeMetrics(
  oldContent: string,
  newContent: string,
  scores: ScoredNgram[],
  highFreqNgrams: Set<string>,
): DistillMetrics {
  const oldTokens = new Set(tokenize(oldContent));
  const newTokens = new Set(tokenize(newContent));

  // Signal density: fraction of new tokens that come from top-scoring n-grams
  const topNgramSet = new Set(scores.slice(0, TOP_K).map((s) => s.ngram));
  let signalTokCount = 0;
  for (const tok of newTokens) {
    if (topNgramSet.has(tok)) signalTokCount++;
    // Also check if token appears as part of any top n-gram
    for (const ng of topNgramSet) {
      if (ng.split(" ").includes(tok)) {
        signalTokCount++;
        break;
      }
    }
  }
  const signalDensity = newTokens.size > 0
    ? Math.min(1, signalTokCount / newTokens.size)
    : 0;

  // Compression ratio
  const oldLen = oldContent.length || 1;
  const newLen = newContent.length;
  const compressionRatio = 1 - newLen / oldLen;

  // Core retention: fraction of high-frequency n-grams still present
  let retainedCore = 0;
  let totalCore = highFreqNgrams.size;
  for (const coreNg of highFreqNgrams) {
    if (newContent.includes(coreNg)) retainedCore++;
    else {
      // Also check if individual tokens of the core n-gram are present
      const coreTokens = coreNg.split(" ");
      if (coreTokens.every((t) => newTokens.has(t))) retainedCore++;
    }
  }
  const coreRetentionRate = totalCore > 0 ? retainedCore / totalCore : 1;

  // Noise removal: fraction of old tokens NOT in new content
  const removedTokens = [...oldTokens].filter((t) => !newTokens.has(t));
  const noiseRemovalRate = oldTokens.size > 0
    ? removedTokens.length / oldTokens.size
    : 0;

  // Failure n-gram signal ratio: signal from n-grams with penalty vs. without
  const failNgrams = scores.filter((s) => s.penalty > 0);
  const successNgrams = scores.filter((s) => s.penalty === 0);
  const failAvg =
    failNgrams.length > 0
      ? failNgrams.reduce((sum, s) => sum + s.score, 0) / failNgrams.length
      : 0;
  const successAvg =
    successNgrams.length > 0
      ? successNgrams.reduce((sum, s) => sum + s.score, 0) / successNgrams.length
      : 1;
  const failureNgramSignalRatio = successAvg > 0 ? failAvg / successAvg : 0;

  return {
    signalDensity,
    compressionRatio,
    coreRetentionRate,
    noiseRemovalRate,
    failureNgramSignalRatio,
  };
}
