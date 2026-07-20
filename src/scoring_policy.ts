export interface ActivationStat {
  activations?: number;
  success?: number;
  failure?: number;
  lastActivated?: string;
}

export interface ScoreCandidate {
  id: string;
  name?: string;
  content?: string;
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

/** Parse JSON, fenced JSON, or line protocol such as `L0::node_2 = 0.73`. */
export function parseNodeScores(raw: string): Record<string, number> {
  const text = String(raw || "").trim();
  if (!text) throw new Error("Empty score response");

  const candidates: string[] = [text];
  const fence = text.match(/```(?:json|scores?)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) candidates.push(fence[1].trim());
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "{") continue;
    let depth = 0;
    for (let j = i; j < text.length; j++) {
      if (text[j] === "{") depth++;
      else if (text[j] === "}" && --depth === 0) {
        candidates.push(text.slice(i, j + 1));
        break;
      }
    }
  }
  for (let i = candidates.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(candidates[i]);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const out: Record<string, number> = {};
        for (const [key, value] of Object.entries(parsed)) {
          const n = Number(value);
          if (Number.isFinite(n)) out[key] = clamp01(n);
        }
        if (Object.keys(out).length) return out;
      }
    } catch {}
  }

  const out: Record<string, number> = {};
  const lineRe = /(?:^|[\n,;])\s*((?:L0::)?node_\d+)\s*(?:=|:|\t|\s)\s*(0(?:\.\d+)?|1(?:\.0+)?)\b/gi;
  let match: RegExpExecArray | null;
  while ((match = lineRe.exec(text))) out[match[1]] = clamp01(Number(match[2]));
  if (Object.keys(out).length) return out;
  throw new Error(`No parseable node scores: ${text.slice(0, 120)}`);
}

function terms(text: string): Set<string> {
  const raw = String(text || "").toLowerCase();
  const out = new Set<string>();
  for (const word of raw.split(/[^a-z0-9_\u4e00-\u9fff]+/).filter(Boolean)) {
    if (/^[a-z0-9_]+$/.test(word)) {
      if (word.length >= 2) out.add(word);
    } else {
      for (let i = 0; i < word.length - 1; i++) out.add(word.slice(i, i + 2));
    }
  }
  return out;
}

/** Local lexical relevance used as a fast fallback and an anti-lock-in relevance gate. */
export function lexicalRelevance(prompt: string, nodeText: string): number {
  const a = terms(prompt);
  const b = terms(nodeText);
  if (!a.size || !b.size) return 0;
  let hit = 0;
  for (const token of a) if (b.has(token)) hit++;
  if (!hit) return 0;
  return clamp01(hit / Math.sqrt(a.size * b.size));
}

export function buildLocalScores(prompt: string, nodes: ScoreCandidate[]): Record<string, number> {
  const out: Record<string, number> = {};
  let max = 0;
  for (const node of nodes) {
    const key = node.id.startsWith("L0::") ? node.id : `L0::${node.id}`;
    const score = lexicalRelevance(prompt, `${node.name || ""} ${node.content || ""}`);
    out[key] = score;
    if (score > max) max = score;
  }
  // Absolute cosine values are small for long knowledge nodes. Normalize only
  // nonzero semantic matches inside this candidate set; unrelated nodes stay 0.
  if (max > 0) {
    for (const key of Object.keys(out)) out[key] = out[key] > 0 ? clamp01((out[key] / max) * 0.8) : 0;
  }
  return out;
}

/**
 * Relevance-gated exploration:
 * - frequent nodes are softly decayed;
 * - untried but relevant nodes receive a bounded bonus;
 * - nodes with no semantic evidence remain zero (no random pollution).
 */
export function applyExplorationPolicy(
  llmScores: Record<string, number>,
  localScores: Record<string, number>,
  stats: Record<string, ActivationStat>,
): Record<string, number> {
  const out: Record<string, number> = {};
  const keys = new Set([...Object.keys(llmScores), ...Object.keys(localScores)]);
  for (const key of keys) {
    const llm = clamp01(Number(llmScores[key]) || 0);
    const local = clamp01(Number(localScores[key]) || 0);
    const relevance = Math.max(llm, local);
    if (relevance <= 0) {
      out[key] = 0;
      continue;
    }
    const stat = stats[key] || {};
    const activations = Math.max(0, Number(stat.activations ?? (Number(stat.success || 0) + Number(stat.failure || 0))));
    const reliability = activations > 0
      ? clamp01((Number(stat.success || 0) + 1) / (activations + 2))
      : 0.5;
    const frequencyDecay = 1 / Math.sqrt(1 + activations / 8);
    const explorationBonus = local > 0 && activations < 4
      ? Math.min(0.12, local * 0.3) * (1 - activations / 4)
      : 0;
    const evidence = llm > 0 ? llm * 0.82 + local * 0.18 : local * 0.72;
    out[key] = clamp01(evidence * frequencyDecay * (0.85 + reliability * 0.3) + explorationBonus);
  }
  return out;
}

export function rankLayerWithExploration<T extends { id: string; score: number }>(
  layer: number,
  nodes: T[],
  stats: Record<string, ActivationStat>,
): Array<T & { selectionScore: number }> {
  const positive = nodes.filter((node) => Number(node.score) > 0);
  const peak = positive.reduce((m, node) => Math.max(m, Number(node.score) || 0), 0);
  if (peak <= 0) return [];
  const relevanceFloor = peak * 0.2;
  return positive
    .filter((node) => node.score >= relevanceFloor)
    .map((node) => {
      const key = `L${layer}::${node.id}`;
      const stat = stats[key] || {};
      const activations = Math.max(0, Number(stat.activations ?? (Number(stat.success || 0) + Number(stat.failure || 0))));
      const reliability = activations > 0
        ? clamp01((Number(stat.success || 0) + 1) / (activations + 2))
        : 0.5;
      const decay = 1 / Math.sqrt(1 + activations / 12);
      const bonus = activations < 4 ? peak * 0.08 * (1 - activations / 4) : 0;
      const selectionScore = node.score * decay * (0.9 + reliability * 0.2) + bonus;
      return { ...node, selectionScore };
    })
    .sort((a, b) => b.selectionScore - a.selectionScore || b.score - a.score);
}
