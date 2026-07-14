import * as path from "node:path";
import { writeJson, readNodeContent, readNodeName, writeNodeHtml } from "./storage";
import { clamp, parseLayerNodeId } from "./utils";
import type { LoadedNetwork } from "./network";
import type { WeightsFile } from "./types";

// ─── Textron Auto Backward Propagation ────────────────────────────────

export function selectedEdgeIdToWeightKey(edgeId: string): string | null {
  const m = edgeId.match(/^L(\d+)::(.+?)->L(\d+)::(.+)$/);
  if (!m) return null;
  const fromL = parseInt(m[1], 10);
  const toL = parseInt(m[3], 10);
  if (toL !== fromL + 1) return null;
  return `${fromL}_to_${toL}:${m[2]}:${m[4]}`;
}

export function autoBackward(
  net: LoadedNetwork,
  activatedIds: string[],
  reward: number,
  onLog: (msg: string) => void,
  selectedEdgeIds: string[] = [],
  edgeRewards?: Map<string, number>,
): { changes: number; changedEdges: string[] } {
  const lr = net.hyperparams.learningRate;
  const activeEdgeSet = new Set<string>();

  // Preferred path: update exactly the selected forward edges. This prevents unrelated
  // edges between activated nodes from being reinforced or penalized.
  for (const edgeId of selectedEdgeIds) {
    const key = selectedEdgeIdToWeightKey(edgeId);
    if (key) activeEdgeSet.add(key);
  }

  // Legacy fallback: derive adjacent edges from activated path if selectedEdgeIds unavailable.
  if (activeEdgeSet.size === 0 && activatedIds.length > 1) {
    const parsedPath = activatedIds
      .map((id) => ({ raw: id, parsed: parseLayerNodeId(id) }))
      .filter((x) => x.parsed !== null) as { raw: string; parsed: { layer: number; nodeId: string } }[];
    parsedPath.sort((a, b) => a.parsed.layer - b.parsed.layer);
    for (let i = 0; i < parsedPath.length - 1; i++) {
      const a = parsedPath[i].parsed;
      const b = parsedPath[i + 1].parsed;
      if (b.layer === a.layer + 1) activeEdgeSet.add(`${a.layer}_to_${b.layer}:${a.nodeId}:${b.nodeId}`);
    }
  }

  if (activeEdgeSet.size === 0) return { changes: 0, changedEdges: [] };

  let changes = 0;
  const changedEdges: string[] = [];
  for (const [key, edges] of Object.entries(net.weights.layer_connections)) {
    for (const edge of edges) {
      const eid = `${key}:${edge.from}:${edge.to}`;
      if (!activeEdgeSet.has(eid)) continue;
      const old = edge.weight;
      // Use per-edge reward if available, otherwise global reward
      const edgeR = edgeRewards?.get(eid) ?? reward;
      if (edgeR > 0) edge.weight = clamp(old + lr * edgeR * (1 - old), -1, 1);
      else if (edgeR < 0) edge.weight = clamp(old + lr * edgeR * (1 + old), -1, 1);
      if (Math.abs(edge.weight - old) > 0.0005) {
        changes++;
        changedEdges.push(`${eid}:${old.toFixed(4)}->${edge.weight.toFixed(4)}`);
      }
    }
  }

  if (changes > 0) {
    writeJson(path.join(net.path, "weights.json"), net.weights);
    net.hyperparams.updatedAt = new Date().toISOString();
    writeJson(path.join(net.path, "hyperparams.json"), net.hyperparams);
    onLog(`Textron backward: ${changes} selected edge(s) updated (reward=${reward.toFixed(3)}) for "${path.basename(net.path)}"`);
  }
  return { changes, changedEdges };
}
