import * as path from "node:path";
import { readNodeContent, readNodeName, writeNodeHtml, writeJson } from "./storage";
import type { LoadedNetwork } from "./network";

// ─── Textron Orthogonality Helpers ────────────────────────────────────

export function nameTokens(name: string): Set<string> {
  const s = (name || "").toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, " ").trim();
  const parts = s.split(/\s+/).filter(Boolean);
  const out = new Set<string>(parts);
  // Character bigrams make short Chinese/compound names comparable too.
  const compact = s.replace(/\s+/g, "");
  for (let i = 0; i < compact.length - 1; i++) out.add(compact.slice(i, i + 2));
  return out;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

export function findSimilarNode(
  net: LoadedNetwork,
  name: string,
  minScore = 0.72,
): { layer: number; nodeId: string; score: number; name: string } | null {
  const target = nameTokens(name);
  let best: { layer: number; nodeId: string; score: number; name: string } | null = null;
  for (let l = 0; l < net.hyperparams.layers.length; l++) {
    for (let n = 0; n < net.hyperparams.layers[l]; n++) {
      const nodeId = `node_${n}`;
      const nodePath = path.join(net.path, `layer_${l}`, `${nodeId}.html`);
      const existingName = readNodeName(nodePath);
      if (!existingName) continue;
      const score = jaccard(target, nameTokens(existingName));
      if (score >= minScore && (!best || score > best.score)) best = { layer: l, nodeId, score, name: existingName };
    }
  }
  return best;
}

export function mergeNodeContent(oldContent: string, newContent: string): string {
  const oldS = (oldContent || "").trim();
  const newS = (newContent || "").trim();
  if (!oldS) return newS.slice(0, 120);
  if (!newS || oldS.includes(newS)) return oldS.slice(0, 120);
  if (newS.includes(oldS)) return newS.slice(0, 120);
  return `${oldS}; ${newS}`.slice(0, 120);
}

export function updateExistingNodeByPolicy(
  net: LoadedNetwork,
  layer: number,
  nodeId: string,
  name: string,
  content: string,
  onLog: (msg: string) => void,
): void {
  const nodePath = path.join(net.path, `layer_${layer}`, `${nodeId}.html`);
  const mergedContent = mergeNodeContent(readNodeContent(nodePath), content);
  const finalName = (name || readNodeName(nodePath) || compressNodeNameLocal(mergedContent)).slice(0, 64);
  const edgeKey = `${layer}_to_${layer + 1}`;
  const outEdges = (net.weights.layer_connections[edgeKey] || [])
    .filter((e) => e.from === nodeId)
    .map((e) => ({ toId: e.to, weight: e.weight }));
  writeNodeHtml(nodePath, layer, nodeId, mergedContent, outEdges, finalName);
  net.hyperparams.updatedAt = new Date().toISOString();
  writeJson(path.join(net.path, "hyperparams.json"), net.hyperparams);
  onLog(`Textron orthogonality: merged new knowledge into L${layer}::${nodeId} (${finalName})`);
}

function compressNodeNameLocal(content: string): string {
  const s = (content || "").replace(/\s+/g, " ").trim();
  if (!s) return "";
  return s.length > 48 ? s.slice(0, 45) + "..." : s;
}
