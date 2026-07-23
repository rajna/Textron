export interface NoveltyExpansionInput {
  routeUncertain?: boolean;
  moeMaxScore?: number;
  reward?: number;
  selectedEdgeIds?: string[];
  hasHighEntropy?: boolean;
  moeLowScoreThreshold?: number;
}

export interface NoveltyExpansionDecision {
  synthesizeL0Anchor: boolean;
  reason: "route_uncertain" | "moe_low_score" | "negative_reward" | "no_highentropy" | "not_novel";
}

export function decideNoveltyExpansion(input: NoveltyExpansionInput): NoveltyExpansionDecision {
  if (!input.hasHighEntropy) return { synthesizeL0Anchor: false, reason: "no_highentropy" };
  if (input.routeUncertain) return { synthesizeL0Anchor: true, reason: "route_uncertain" };

  const threshold = input.moeLowScoreThreshold ?? 0.08;
  const moeMax = Number(input.moeMaxScore ?? 0);
  if (Number.isFinite(moeMax) && moeMax > 0 && moeMax < threshold) {
    return { synthesizeL0Anchor: true, reason: "moe_low_score" };
  }

  const reward = Number(input.reward ?? 0);
  const hasPath = (input.selectedEdgeIds || []).length > 0;
  if (hasPath && reward < 0) return { synthesizeL0Anchor: true, reason: "negative_reward" };

  return { synthesizeL0Anchor: false, reason: "not_novel" };
}
