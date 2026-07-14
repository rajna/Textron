// ─── Textron Utilities ────────────────────────────────────────────────

export function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

/** Parse "L<N>::node_X" format. Returns {layer:number, nodeId:string} or null. */
export function parseLayerNodeId(raw: string): { layer: number; nodeId: string } | null {
  const m = raw.match(/^L(\d+)::(.+)$/);
  return m ? { layer: parseInt(m[1], 10), nodeId: m[2] } : null;
}

export function seedRandom(seed: string): () => number {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = ((hash << 5) - hash + seed.charCodeAt(i)) | 0;
  return () => { hash = (hash * 1103515245 + 12345) | 0; return (hash >>> 0) / 0xffffffff; };
}

export function formatNodesForLLM(nodes: { id: string; layer: number; content: string; outgoingEdges: { toId: string; weight: number }[] }[]): string {
  const byLayer = new Map<number, typeof nodes>();
  for (const n of nodes) { const list = byLayer.get(n.layer) || []; list.push(n); byLayer.set(n.layer, list); }
  let out = "";
  for (let l = 0; l < Math.max(...byLayer.keys()) + 1; l++) {
    const ln = byLayer.get(l) || [];
    out += `\n=== Layer ${l} (${ln.length} nodes) ===\n`;
    for (const n of ln) {
      const ei = n.outgoingEdges.length > 0 ? ` [→ ${n.outgoingEdges.map(e => `${e.toId}(w:${e.weight.toFixed(2)})`).join(", ")}]` : " [output]";
      out += `${n.id}${ei}\n  content: ${n.content || "(empty)"}\n`;
    }
  }
  return out;
}
