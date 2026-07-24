import type { loadNetwork } from "./network";
export function computePageRank(
  net: NonNullable<ReturnType<typeof loadNetwork>>,
): Record<string, number> {
  const layers = net.hyperparams.layers;
  const totalNodes = layers.reduce((a, b) => a + b, 0);
  const nodeIds: string[] = [];
  const nodeIndex = new Map<string, number>();

  // Build flat node index
  for (let l = 0; l < layers.length; l++) {
    for (let n = 0; n < layers[l]; n++) {
      const key = `L${l}::node_${n}`;
      nodeIndex.set(key, nodeIds.length);
      nodeIds.push(key);
    }
  }

  // Build adjacency matrix (sparse representation: outLinks[from] = [{to, weight}])
  const outLinks: { to: number; weight: number }[][] = Array.from({ length: totalNodes }, () => []);
  for (const [edgeKey, edges] of Object.entries(net.weights.layer_connections)) {
    const [fromL, toL] = edgeKey.split('_to_').map(Number);
    for (const e of edges) {
      const fromKey = `L${fromL}::${e.from}`;
      const toKey = `L${toL}::${e.to}`;
      const fi = nodeIndex.get(fromKey);
      const ti = nodeIndex.get(toKey);
      if (fi !== undefined && ti !== undefined && e.weight > 0) {
        outLinks[fi].push({ to: ti, weight: e.weight });
      }
    }
  }

  // Power iteration
  const damping = 0.85;
  const epsilon = 1e-6;
  const maxIter = 100;
  let pr = new Array(totalNodes).fill(1 / totalNodes);

  for (let iter = 0; iter < maxIter; iter++) {
    const newPr = new Array(totalNodes).fill((1 - damping) / totalNodes);
    let maxDelta = 0;
    for (let i = 0; i < totalNodes; i++) {
      if (outLinks[i].length === 0) {
        // Dangling node: distribute PR to all nodes
        for (let j = 0; j < totalNodes; j++) newPr[j] += damping * pr[i] / totalNodes;
      } else {
        const totalWeight = outLinks[i].reduce((s, l) => s + l.weight, 0);
        if (totalWeight > 0) {
          for (const link of outLinks[i]) {
            newPr[link.to] += damping * pr[i] * (link.weight / totalWeight);
          }
        }
      }
    }
    for (let i = 0; i < totalNodes; i++) {
      maxDelta = Math.max(maxDelta, Math.abs(newPr[i] - pr[i]));
    }
    pr = newPr;
    if (maxDelta < epsilon) break;
  }

  // Normalize to 0-1 range
  const maxPr = Math.max(...pr, 1e-10);
  const result: Record<string, number> = {};
  for (let i = 0; i < totalNodes; i++) {
    result[nodeIds[i]] = pr[i] / maxPr;
  }
  return result;
}

// ─── Manual Propagation (used by tool actions) ────────────────────

