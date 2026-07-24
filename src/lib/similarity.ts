import { previewText } from "./utils";

// ── TF-IDF utilities ──

export function tfidfTokens(text: string): string[] {
  const s = (text || "").toLowerCase();
  const out: string[] = [];
  const runs = s.match(/[a-z0-9]+|[一-鿿]+/g) || [];
  for (const run of runs) {
    if (run.length >= 2) out.push(run);
    else if (/[a-z0-9]/.test(run) && run.length === 1 && out.length > 0) {
      out[out.length - 1] += run;
    }
  }
  return out;
}

export function buildTfidfIndex(net: { hyperparams: { layers: number[] }; path: string }): {
  docFreq: Map<string, number>;
  idf: Map<string, number>;
  nodeVectors: Map<string, Float64Array>;
  allTokens: string[];
} {
  const docFreq = new Map<string, number>();
  const nodeTokens: { id: string; tokens: string[] }[] = [];
  for (let l = 0; l < net.hyperparams.layers.length; l++) {
    for (let n = 0; n < net.hyperparams.layers[l]; n++) {
      const np = `${net.path}/layer_${l}/node_${n}.html`;
      let content = "";
      try {
        const fs = require("node:fs");
        const html = fs.readFileSync(np, "utf-8");
        const m = html.match(/<content>\s*([\s\S]*?)\s*<\/content>/);
        if (m) content = m[1].trim();
      } catch {}
      if (!content) continue;
      const tokens = tfidfTokens(content);
      if (!tokens.length) continue;
      const id = `L${l}::node_${n}`;
      nodeTokens.push({ id, tokens });
      const seen = new Set(tokens);
      for (const t of seen) docFreq.set(t, (docFreq.get(t) || 0) + 1);
    }
  }
  const N = nodeTokens.length || 1;
  const idf = new Map<string, number>();
  const allTokens: string[] = [];
  for (const [t, df] of docFreq) {
    idf.set(t, Math.log((N + 1) / (df + 1)) + 1);
    allTokens.push(t);
  }
  const nodeVectors = new Map<string, Float64Array>();
  for (const nt of nodeTokens) {
    const vec = new Float64Array(allTokens.length);
    for (const t of nt.tokens) {
      const idx = allTokens.indexOf(t);
      if (idx >= 0) vec[idx] = (idf.get(t) || 1);
    }
    nodeVectors.set(nt.id, vec);
  }
  return { docFreq, idf, nodeVectors, allTokens };
}

export function cosineSim(a: Float64Array, b: Float64Array): number {
  if (!a.length || !b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom < 1e-9 ? 0 : dot / denom;
}

export function tfidfSimilarity(
  net: { hyperparams: { layers: number[] }; path: string },
  name: string,
  content: string,
): Map<string, number> {
  const text = `${name} ${content}`.toLowerCase();
  const tokens = tfidfTokens(text);
  if (!tokens.length) return new Map();
  const idx = buildTfidfIndex(net);
  if (idx.allTokens.length === 0) return new Map();
  const qVec = new Float64Array(idx.allTokens.length);
  for (const t of tokens) {
    const i = idx.allTokens.indexOf(t);
    if (i >= 0) qVec[i] = (idx.idf.get(t) || 1);
  }
  const scores = new Map<string, number>();
  for (const [id, vec] of idx.nodeVectors) {
    scores.set(id, cosineSim(qVec, vec));
  }
  return scores;
}

export function nameTokens(name: string): Set<string> {
  const s = String(name || "").replace(/\s+/g, "").toLowerCase();
  const out = new Set<string>();
  const cjk = s.match(/[\u4e00-\u9fff]{1,3}/g) || [];
  for (const c of cjk) out.add(c);
  const eng = s.match(/[a-z0-9]{2,}/g) || [];
  for (const e of eng) out.add(e);
  return out;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let overlap = 0;
  for (const x of a) if (b.has(x)) overlap++;
  return overlap / (a.size + b.size - overlap);
}

export function tokenSimilarity(a: Set<string>, b: Set<string>): number {
  return jaccard(a, b);
}

export function findSimilarNode(
  net: { hyperparams: { layers: number[] }; path: string },
  layer: number,
  content: string,
  excludeId?: string,
): { nodeId: string; similarity: number; content: string } | null {
  let bestSim = 0;
  let bestNode = "";
  let bestContent = "";
  const tokens = nameTokens(content);
  if (!tokens.size) return null;
  for (let n = 0; n < net.hyperparams.layers[layer]; n++) {
    const nid = `node_${n}`;
    if (nid === excludeId) continue;
    const np = `${net.path}/layer_${layer}/${nid}.html`;
    let existing = "";
    try {
      const fs = require("node:fs");
      const html = fs.readFileSync(np, "utf-8");
      const m = html.match(/<content>\s*([\s\S]*?)\s*<\/content>/);
      if (m) existing = m[1].trim();
    } catch {}
    if (!existing) continue;
    const sim = jaccard(tokens, nameTokens(existing));
    if (sim > bestSim) { bestSim = sim; bestNode = nid; bestContent = existing; }
  }
  return bestNode ? { nodeId: bestNode, similarity: bestSim, content: bestContent } : null;
}

export function findSimilarKnowledgeNode(
  net: { hyperparams: { layers: number[] }; path: string },
  layer: number,
  content: string,
  excludeId?: string,
): { nodeId: string; similarity: number; content: string } | null {
  return findSimilarNode(net, layer, content, excludeId);
}
