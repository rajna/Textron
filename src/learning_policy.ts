// ─── Textron Learning Policy ─────────────────────────────────────────

export type RouteCandidate = {
  name: string;
  content: string;
};

export type RouteDecision = {
  taskFamily: string | null;
  reason: "explicit_match" | "domain_match" | "content_match" | "no_safe_match";
  score: number;
};

export type CreditDecision = {
  reward: number;
  edgeRewards: Map<string, number>;
  reason: "normal" | "negative_feedback" | "wrong_topic_path" | "unclear";
};

export type KnowledgeCandidate = {
  layer: number;
  name: string;
  content: string;
};

export type ExistingKnowledgeNode = KnowledgeCandidate & {
  id: string;
};

export type MergeFirstDecision =
  | { action: "merge"; targetId: string; score: number; reason: "similar_existing" }
  | { action: "add"; score: number; reason: "novel_high_signal" }
  | { action: "reject"; score: number; reason: "low_signal" | "multi_topic" };

const STOPWORDS = new Set([
  "the", "and", "for", "with", "this", "that", "from", "into", "your", "you", "are", "was", "were",
  "一个", "这个", "那个", "进行", "使用", "需要", "如果", "因为", "所以", "但是", "可以", "应该",
]);

export function policyTokens(text: string): Set<string> {
  const raw = String(text || "").toLowerCase();
  const parts = raw
    .split(/[^a-z0-9\u4e00-\u9fff]+/)
    .map((x) => x.trim())
    .filter((x) => x.length > 1 && !STOPWORDS.has(x));
  const out = new Set(parts);
  const chineseRuns = raw.match(/[\u4e00-\u9fff]{2,}/g) || [];
  for (const run of chineseRuns) {
    for (let i = 0; i < run.length - 1; i++) out.add(run.slice(i, i + 2));
  }
  return out;
}

export function jaccardTokens(a: string, b: string): number {
  const aa = policyTokens(a);
  const bb = policyTokens(b);
  if (aa.size === 0 || bb.size === 0) return 0;
  let inter = 0;
  for (const x of aa) if (bb.has(x)) inter++;
  return inter / (aa.size + bb.size - inter);
}

export function chooseTaskFamilyRoute(input: {
  prompt: string;
  candidates: RouteCandidate[];
  explicitTaskFamily?: string;
  minContentScore?: number;
  minDomainScore?: number;
}): RouteDecision {
  const candidates = input.candidates || [];
  if (candidates.length === 0) return { taskFamily: null, reason: "no_safe_match", score: 0 };

  const explicit = String(input.explicitTaskFamily || "").trim();
  if (explicit) {
    const exact = candidates.find((c) => c.name === explicit);
    if (exact) return { taskFamily: exact.name, reason: "explicit_match", score: 1 };
  }

  const minContentScore = input.minContentScore ?? 0.08;
  const minDomainScore = input.minDomainScore ?? 0.18;
  const scored = candidates.map((c) => {
    const domainScore = jaccardTokens(input.prompt, c.name.replace(/[_-]+/g, " "));
    const contentScore = jaccardTokens(input.prompt, c.content);
    const score = Math.max(domainScore * 1.4, contentScore);
    return { ...c, domainScore, contentScore, score };
  }).sort((a, b) => b.score - a.score);

  const best = scored[0];
  if (!best) return { taskFamily: null, reason: "no_safe_match", score: 0 };
  if (best.domainScore >= minDomainScore) return { taskFamily: best.name, reason: "domain_match", score: best.score };
  if (best.contentScore >= minContentScore) return { taskFamily: best.name, reason: "content_match", score: best.score };
  return { taskFamily: null, reason: "no_safe_match", score: best.score };
}

export function isNegativeFeedback(text: string): boolean {
  return /不work|不太work|无关|污染|误召回|跑题|偏题|错误|失败|不对|wrong|irrelevant|pollut|bad route|wrong-topic/i.test(String(text || ""));
}

export function assignEdgeCredit(input: {
  selectedEdgeIds: string[];
  baseReward: number;
  feedbackText: string;
  pathAuditLabel?: "high" | "medium" | "low";
}): CreditDecision {
  const selected = input.selectedEdgeIds || [];
  const negative = isNegativeFeedback(input.feedbackText);
  const wrongTopic = input.pathAuditLabel === "low" && negative;
  const reason: CreditDecision["reason"] = wrongTopic ? "wrong_topic_path" : negative ? "negative_feedback" : "normal";
  const reward = wrongTopic ? -1 : negative ? Math.min(-0.4, -Math.abs(input.baseReward || 0.4)) : input.baseReward;
  const edgeRewards = new Map<string, number>();
  for (const edgeId of selected) edgeRewards.set(edgeId, reward);
  return { reward, edgeRewards, reason };
}

export function validateKnowledgeGranularity(content: string): { ok: boolean; reason?: "low_signal" | "multi_topic" } {
  const s = String(content || "").replace(/\s+/g, " ").trim();
  if (s.length < 24) return { ok: false, reason: "low_signal" };
  if (s.length > 180) return { ok: false, reason: "multi_topic" };
  const separators = (s.match(/[;；。.!?？]|\s\+\s|\s\/\s/g) || []).length;
  if (separators >= 4) return { ok: false, reason: "multi_topic" };
  return { ok: true };
}

export function decideMergeFirst(input: {
  candidate: KnowledgeCandidate;
  existing: ExistingKnowledgeNode[];
  mergeThreshold?: number;
  addThreshold?: number;
}): MergeFirstDecision {
  const quality = validateKnowledgeGranularity(input.candidate.content);
  if (!quality.ok) return { action: "reject", score: 0, reason: quality.reason || "low_signal" };

  const mergeThreshold = input.mergeThreshold ?? 0.24;
  const addThreshold = input.addThreshold ?? 0.08;
  let best: ExistingKnowledgeNode | null = null;
  let bestScore = 0;
  for (const node of input.existing || []) {
    const score = Math.max(
      jaccardTokens(input.candidate.name, node.name),
      jaccardTokens(input.candidate.content, node.content),
    );
    if (score > bestScore) { bestScore = score; best = node; }
  }
  if (best && bestScore >= mergeThreshold) return { action: "merge", targetId: best.id, score: bestScore, reason: "similar_existing" };
  if (bestScore < addThreshold) return { action: "add", score: bestScore, reason: "novel_high_signal" };
  return { action: "add", score: bestScore, reason: "novel_high_signal" };
}
