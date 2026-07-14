import * as path from "node:path";
import { ensureDir, readNodeContent, readNodeName, writeNodeHtml, writeJson, compressNodeName } from "./storage";
import { findSimilarNode, updateExistingNodeByPolicy } from "./orthogonality";
import { seedRandom } from "./utils";
import type { LoadedNetwork } from "./network";

// ─── Textron Shape Policy & Dynamic Node Addition ─────────────────────

// Default is frozen topology: merge/update/fill existing slots; dynamic growth is opt-in only.
const TEXTRON_ALLOW_NODE_GROWTH = process.env.TEXTRON_ALLOW_NODE_GROWTH === "1";

/**
 * Choose where a new node may be added while preserving the intended topology:
 * early layers are abstract/narrow routers, later layers are wider concrete stores.
 * Auto-additions default to the deepest layer. Requested early-layer additions are
 * redirected deeper if they would make layer[k] wider than layer[k+1].
 */
export function chooseExpansionLayer(net: LoadedNetwork, requestedLayer?: number): number {
  const layers = net.hyperparams.layers;
  const last = layers.length - 1;
  let layer = Number.isInteger(requestedLayer as number) ? Math.max(0, Math.min(last, requestedLayer as number)) : last;

  // If adding here would violate front<=back width, push one layer deeper.
  while (layer < last && layers[layer] + 1 > layers[layer + 1]) layer++;
  return layer;
}

export function addPolicyNode(
  net: LoadedNetwork,
  requestedLayer: number | undefined,
  content: string,
  onLog: (msg: string) => void,
  name?: string,
): { layer: number; nodeId: string; added?: boolean; merged?: boolean; skipped?: boolean } {
  const nodeName = (name || compressNodeName(content)).slice(0, 64);
  const targetLayer = chooseExpansionLayer(net, requestedLayer);
  const similar = findSimilarNode(net, nodeName, 0.72);
  if (similar) {
    updateExistingNodeByPolicy(net, similar.layer, similar.nodeId, nodeName, content, onLog);
    return { layer: similar.layer, nodeId: similar.nodeId, merged: true };
  }

  if (!TEXTRON_ALLOW_NODE_GROWTH) {
    for (let n = 0; n < net.hyperparams.layers[targetLayer]; n++) {
      const nodeId = `node_${n}`;
      const np = path.join(net.path, `layer_${targetLayer}`, `${nodeId}.html`);
      if (!readNodeContent(np)) {
        const outEdges = (net.weights.layer_connections[`${targetLayer}_to_${targetLayer + 1}`] || [])
          .filter((e) => e.from === nodeId)
          .map((e) => ({ toId: e.to, weight: e.weight }));
        writeNodeHtml(np, targetLayer, nodeId, content, outEdges, nodeName);
        net.hyperparams.updatedAt = new Date().toISOString();
        writeJson(path.join(net.path, "hyperparams.json"), net.hyperparams);
        onLog(`Textron shape policy: filled empty frozen slot L${targetLayer}::${nodeId}`);
        return { layer: targetLayer, nodeId, added: true };
      }
    }
    onLog(`Textron shape policy: frozen full L${targetLayer}; skipped dynamic add (set TEXTRON_ALLOW_NODE_GROWTH=1 to expand)`);
    return { layer: targetLayer, nodeId: "node_0", skipped: true };
  }

  const nodeId = `node_${net.hyperparams.layers[targetLayer]}`;
  if (requestedLayer !== undefined && targetLayer !== requestedLayer) {
    onLog(`Textron shape policy: redirected new node L${requestedLayer} → L${targetLayer} (front-narrow/back-wide)`);
  }
  addDynamicNode(net, targetLayer, nodeId, content, onLog, nodeName);
  return { layer: targetLayer, nodeId, added: true };
}

/**
 * Add a new node to an existing layer. Updates hyperparams, weight files,
 * and creates the node HTML file with proper edge connections.
 */
export function addDynamicNode(
  net: LoadedNetwork,
  layer: number,
  nodeId: string,
  content: string,
  onLog: (msg: string) => void,
  name?: string,
) {
  if (layer < 0 || layer >= net.hyperparams.layers.length) {
    onLog(`Textron: cannot add node to layer ${layer} (out of bounds)`);
    return;
  }

  // Compute new node index and update layer count
  const existingCount = net.hyperparams.layers[layer];
  const nodeIndex = parseInt(nodeId.replace('node_', ''), 10);
  const newCount = Math.max(existingCount, nodeIndex + 1);

  // Create all missing node files up to newCount-1
  const rng = seedRandom(`${net.path}_add_${layer}_${nodeId}`);
  for (let ni = existingCount; ni < newCount; ni++) {
    const nid = `node_${ni}`;
    const layerDir = path.join(net.path, `layer_${layer}`);
    ensureDir(layerDir);

    // Outgoing edges to next layer (if exists)
    const outEdges: { toId: string; weight: number }[] = [];
    if (layer < net.hyperparams.layers.length - 1) {
      const nextLayerSize = net.hyperparams.layers[layer + 1];
      let edgeKey = `${layer}_to_${layer + 1}`;
      if (!net.weights.layer_connections[edgeKey]) net.weights.layer_connections[edgeKey] = [];
      for (let t = 0; t < nextLayerSize; t++) {
        if (rng() < 0.6) {
          const w = 0.3 + rng() * 0.4; // 0.3-0.7 random initial weight
          net.weights.layer_connections[edgeKey].push({ from: nid, to: `node_${t}`, weight: w });
          outEdges.push({ toId: `node_${t}`, weight: w });
        }
      }
    }

    // Incoming edges from previous layer (if exists)
    if (layer > 0) {
      const prevLayerSize = net.hyperparams.layers[layer - 1];
      let edgeKey = `${layer - 1}_to_${layer}`;
      if (!net.weights.layer_connections[edgeKey]) net.weights.layer_connections[edgeKey] = [];
      for (let f = 0; f < prevLayerSize; f++) {
        if (rng() < 0.5) {
          const w = 0.3 + rng() * 0.4;
          // Avoid duplicate edges
          const exists = net.weights.layer_connections[edgeKey].some(
            e => e.from === `node_${f}` && e.to === nid
          );
          if (!exists) {
            net.weights.layer_connections[edgeKey].push({ from: `node_${f}`, to: nid, weight: w });
          }
        }
      }
    }

    const np = path.join(layerDir, `${nid}.html`);
    // Only the requested node gets content; other gap-filler nodes stay empty
    const nodeContent = (nid === nodeId) ? content : "";
    writeNodeHtml(np, layer, nid, nodeContent, outEdges, nid === nodeId ? name : undefined);
  }

  // Update hyperparams with new layer size
  net.hyperparams.layers[layer] = newCount;
  net.hyperparams.updatedAt = new Date().toISOString();

  // Persist
  writeJson(path.join(net.path, "weights.json"), net.weights);
  writeJson(path.join(net.path, "hyperparams.json"), net.hyperparams);

  const created = newCount - existingCount;
  onLog(`Textron: added ${created} node(s) to layer ${layer} of "${path.basename(net.path)}" (now ${newCount} nodes)`);
}
