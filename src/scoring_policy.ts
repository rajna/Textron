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

/**
 * 保留判据的「在域证据」重写（n8 第十八轮 2026-09-16）—— 取代纯相对比较，修两类结构性缺陷：
 *
 * 【缺陷 1 · 累积偏差】`lexicalRelevance(goal, body)` 的分子只数 goal 侧命中数。旧文因多轮 keep
 * 反复保留 goal 字面词（交易/买点/卖点/量能/均线）⇒ 该分对旧文单调累加；新文是「专业符号化
 * 增量」（π* ／ ATR ／ gap_lower ／ 函数名），字面重合天然稀疏 ⇒ 结构性必输。
 * 实测（23:23 反传）：scoreOld 0.1143 vs scoreNew 0.0075（比值 15×，远超 0.85 阈值）⇒ LLM 每轮
 * 提炼被整轮丢弃。
 *
 * 【缺陷 2 · 空壳自锁（更致命）】同一实现在 L0::node_1 上反转：其正文已被函数块吞没（当前
 * stripFunctionBlocks 后为空，scoreOld=0）⇒ `scoreNew < scoreOld*0.85` 永假、且任何新文本与空
 * 旧文的重叠度必为 0 ⇒ 交易正文一旦丢失就再也长不回来（实测层 0 两个节点：一个 160KB 膨胀、
 * 一个 2.7KB 空壳，悬空 [fn:σ] 4→17→27→33→35 单调恶化同源）。
 *
 * 因此判据只回答一个新问题：**新文自身带不带有目标域证据？**（旧文仅作参考基准，不再单独定生死）
 *   证据① goal   —— 新文命中 goal 词面（字面域证据，无词表、不做语义预判）；
 *   证据② coherence —— 新文与旧文的词面重叠率 ≥ minOldCover（同节点应当同域）；
 *   空壳豁免 —— 旧文词面 < minOldTokens 时无法比对域一致性，不得因此拒写（防锁死）。
 * 仅当「新文体量足够 ∧ 无任何证据 ∧ 非空壳」才判离域 ⇒ 给出否决权；否则一律降级为融合。
 */
export interface RetentionVerdict {
  scoreOld: number;
  scoreNew: number;
  goalHits: number;
  oldCover: number;
  freshNode: boolean;
  evidence: string[];
  offDomain: boolean;
}

export function retentionVerdict(
  goal: string,
  oldText: string,
  newText: string,
  opts: { minNewTokens?: number; minOldCover?: number; minOldTokens?: number } = {},
): RetentionVerdict {
  const minNewTokens = opts.minNewTokens ?? 40;
  const minOldCover = opts.minOldCover ?? 0.15;
  const minOldTokens = opts.minOldTokens ?? 20;
  const a = terms(goal);
  const bOld = terms(oldText);
  const bNew = terms(newText);
  const scoreOld = lexicalRelevance(goal, oldText);
  const scoreNew = lexicalRelevance(goal, newText);
  let goalHits = 0;
  for (const t of a) if (bNew.has(t)) goalHits++;
  let overlap = 0;
  for (const t of bNew) if (bOld.has(t)) overlap++;
  const oldCover = bNew.size ? overlap / bNew.size : 0;
  const freshNode = bOld.size < minOldTokens;
  const evidence: string[] = [];
  if (goalHits > 0) evidence.push("goal");
  if (!freshNode && oldCover >= minOldCover) evidence.push("coherence");
  if (freshNode) evidence.push("fresh_node");
  const offDomain = !freshNode && bNew.size >= minNewTokens && evidence.length === 0;
  return { scoreOld, scoreNew, goalHits, oldCover, freshNode, evidence, offDomain };
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
