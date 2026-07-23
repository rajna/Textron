import { buildLocalScores, type ActivationStat, type ScoreCandidate } from "./scoring_policy.ts";

export interface MoeExpert {
  id: string;
  name: string;
  nodeIds: string[];
  score: number;
}

export interface MoeRouteResult {
  enabled: boolean;
  experts: MoeExpert[];
  selectedExpertIds: string[];
  gatedScores: Record<string, number>;
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function normalizeLayer0Key(id: string): string {
  return id.startsWith("L0::") ? id : `L0::${id}`;
}

function terms(text: string): string[] {
  const raw = String(text || "").toLowerCase();
  const out = new Set<string>();
  for (const token of raw.split(/[^a-z0-9_\u4e00-\u9fff]+/).filter(Boolean)) {
    if (/^[a-z0-9_]+$/.test(token)) {
      if (token.length >= 2) out.add(token);
    } else if (token.length === 2) {
      out.add(token);
    } else {
      for (let i = 0; i < token.length - 1; i++) out.add(token.slice(i, i + 2));
    }
  }
  return [...out];
}

function jaccardTokens(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const aa = new Set(a);
  const bb = new Set(b);
  let hit = 0;
  for (const token of aa) if (bb.has(token)) hit++;
  return hit / (aa.size + bb.size - hit);
}

function topTerms(nodes: ScoreCandidate[], limit = 5): string[] {
  const counts = new Map<string, number>();
  for (const node of nodes) {
    for (const token of terms(`${node.name || ""} ${node.content || ""}`)) {
      counts.set(token, (counts.get(token) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .filter(([token]) => token.length > 1)
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
    .slice(0, limit)
    .map(([token]) => token);
}

function routeReliability(stats: Record<string, ActivationStat>, nodeIds: string[]): number {
  let seen = 0;
  let sum = 0;
  for (const nodeId of nodeIds) {
    const stat = stats[normalizeLayer0Key(nodeId)] || {};
    const activations = Math.max(0, Number(stat.activations ?? (Number(stat.success || 0) + Number(stat.failure || 0))));
    if (activations <= 0) continue;
    seen++;
    sum += clamp01((Number(stat.success || 0) + 1) / (activations + 2));
  }
  return seen > 0 ? sum / seen : 0.5;
}

export function buildMoeExperts(l0Nodes: ScoreCandidate[], requestedExpertCount?: number): MoeExpert[] {
  const filled = l0Nodes.filter((node) => `${node.name || ""} ${node.content || ""}`.trim());
  if (filled.length === 0) return [];
  const expertCount = Math.max(1, Math.min(requestedExpertCount || Math.ceil(Math.sqrt(filled.length)), filled.length));
  const clusters: Array<{ nodes: ScoreCandidate[]; centroid: string[] }> = [];

  for (const node of filled) {
    const nodeTerms = terms(`${node.name || ""} ${node.content || ""}`);
    let bestIdx = -1;
    let bestScore = 0;
    for (let i = 0; i < clusters.length; i++) {
      const score = jaccardTokens(nodeTerms, clusters[i].centroid);
      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }
    if (bestIdx >= 0 && bestScore >= 0.18) {
      clusters[bestIdx].nodes.push(node);
      clusters[bestIdx].centroid = topTerms(clusters[bestIdx].nodes, 10);
    } else if (clusters.length < expertCount) {
      clusters.push({ nodes: [node], centroid: nodeTerms.slice(0, 10) });
    } else {
      const smallestIdx = clusters.reduce((best, cluster, idx) => cluster.nodes.length < clusters[best].nodes.length ? idx : best, 0);
      clusters[smallestIdx].nodes.push(node);
      clusters[smallestIdx].centroid = topTerms(clusters[smallestIdx].nodes, 10);
    }
  }

  return clusters.map((cluster, idx) => {
    const nameTerms = topTerms(cluster.nodes, 4);
    return {
      id: `E${idx}`,
      name: nameTerms.join(" ") || `expert_${idx}`,
      nodeIds: cluster.nodes.map((node) => normalizeLayer0Key(node.id)),
      score: 0,
    };
  });
}

export function routeL0ThroughMoe(input: {
  prompt: string;
  l0Nodes: ScoreCandidate[];
  scores: Record<string, number>;
  stats?: Record<string, ActivationStat>;
  expertCount?: number;
  topK?: number;
  minScore?: number;
}): MoeRouteResult {
  const experts = buildMoeExperts(input.l0Nodes, input.expertCount);
  const scores = { ...(input.scores || {}) };
  if (experts.length <= 1) return { enabled: false, experts, selectedExpertIds: experts.map((e) => e.id), gatedScores: scores };

  const expertCandidates = experts.map((expert) => ({ id: expert.id, name: expert.name, content: expert.nodeIds.join(" ") }));
  const expertLocalScores = buildLocalScores(input.prompt, expertCandidates);
  const nodeScore = (id: string) => clamp01(Number(scores[normalizeLayer0Key(id)] ?? scores[id] ?? 0) || 0);

  const routed = experts.map((expert) => {
    const local = expertLocalScores[normalizeLayer0Key(expert.id)] || 0;
    const maxNode = expert.nodeIds.reduce((max, nodeId) => Math.max(max, nodeScore(nodeId)), 0);
    const reliability = routeReliability(input.stats || {}, expert.nodeIds);
    return { ...expert, score: clamp01((local * 0.55 + maxNode * 0.45) * (0.85 + reliability * 0.3)) };
  }).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));

  const topK = Math.max(1, Math.min(input.topK || 2, routed.length));
  const peak = routed[0]?.score || 0;
  const minScore = input.minScore ?? 0.05;
  const selected = routed.filter((expert, idx) => idx < topK && expert.score >= Math.max(minScore, peak * 0.2));
  const selectedExperts = selected.length > 0 ? selected : routed.slice(0, 1);
  const allowedNodes = new Set(selectedExperts.flatMap((expert) => expert.nodeIds));
  const gatedScores: Record<string, number> = { ...scores };

  for (const node of input.l0Nodes) {
    const key = normalizeLayer0Key(node.id);
    if (!allowedNodes.has(key)) gatedScores[key] = 0;
  }

  return {
    enabled: true,
    experts: routed,
    selectedExpertIds: selectedExperts.map((expert) => expert.id),
    gatedScores,
  };
}
