import * as fs from "node:fs";
import * as path from "node:path";
import { writeJson, completeContent, previewText } from "./utils";
import { readNodeContent, readNodeName, writeNodeHtml, compressNodeName, validateKnowledgeCrystal, intraLayerOrthogonalityCheck } from "./node_io";
import { mergeNodeContent, mergeContent } from "./merge";
import { findSimilarKnowledgeNode, jaccard, nameTokens, tokenSimilarity } from "./similarity";
import { NODE_CONTENT_MAX_CHARS } from "../content_limits.ts";
import { distillNodeName } from "../name_distill.ts";
import { DEFAULT_WEIGHT, TEXTRON_ALLOW_NODE_GROWTH, NGRAM_DISTILL_PROMOTE } from "./network";
import { rescaleRejectedCrystal } from "./rescale";

// ── recordArtifactEvent stub (actual implementation in index.ts) ──
let _recordArtifactEvent: Function = () => {};
export function setRecordArtifactEvent(fn: Function) { _recordArtifactEvent = fn; }

export function chooseExpansionLayer(
  net: { hyperparams: { layers: number[] }; path: string },
  requestedLayer?: number,
): number {
  if (requestedLayer !== undefined && requestedLayer >= 0 && requestedLayer < net.hyperparams.layers.length) {
    return requestedLayer;
  }
  // Default: add to deepest layer (L2) for concrete rules
  return net.hyperparams.layers.length - 1;
}

export function updateExistingNodeByPolicy(
  net: { hyperparams: { layers: number[] }; path: string; weights: any },
  layer: number,
  nodeId: string,
  name: string,
  newContent: string,
  onLog: (msg: string) => void,
): { updated: boolean; nodeId: string; layer: number; oldContent: string; newContent: string } {
  const np = path.join(net.path, `layer_${layer}`, `${nodeId}.html`);
  const oldContent = readNodeContent(np);
  const oldName = readNodeName(np);

  const merged = mergeNodeContent(oldContent, newContent);
  const validation = validateKnowledgeCrystal(merged, layer);
  if (!validation.ok) {
    // Try rescale
    const rescale = rescaleRejectedCrystal(net, merged, validation.reason, layer, onLog, addPolicyNode, _recordArtifactEvent);
    if (rescale?.rescued) {
      onLog(`Textron: node update rejected (${validation.reason}), rescale→L${rescale.layer}::${rescale.nodeId}`);
      return { updated: false, nodeId, layer, oldContent, newContent: merged };
    }
    onLog(`Textron: node update rejected — ${validation.reason}`);
    return { updated: false, nodeId, layer, oldContent, newContent: merged };
  }

  const distilledName = distillNodeName((oldName + " " + name).slice(0, 200));
  const existing = net.weights?.layer_connections?.[`${layer}_to_${layer + 1}`] || [];
  const outEdges = existing
    .filter((e: any) => e.from === nodeId)
    .map((e: any) => ({ toId: e.to, weight: e.weight }));

  writeNodeHtml(np, layer, nodeId, validation.content, outEdges, distilledName);
  onLog(`Textron: updated L${layer}::${nodeId} "${previewText(oldName, 40)}" → "${previewText(distilledName, 40)}"`);
  return { updated: true, nodeId, layer, oldContent, newContent: validation.content };
}

export function addPolicyNode(
  net: { hyperparams: { layers: number[] }; path: string; weights: any },
  targetLayer: number,
  content: string,
  onLog: (msg: string) => void,
  name?: string,
  requestedLayer?: number,
  opts?: { mergeSimilar?: boolean; similarityThreshold?: number },
): { added: boolean; merged: boolean; replaced: boolean; nodeId: string; layer: number } {
  const layer = chooseExpansionLayer(net, requestedLayer ?? targetLayer);

  // Check orthogonality
  const ortho = intraLayerOrthogonalityCheck(net, layer, content);
  if (ortho.tooSimilar && opts?.mergeSimilar !== false) {
    // Merge into existing similar node
    const existingNodeId = ortho.similarTo!.split("::")[1];
    const result = updateExistingNodeByPolicy(net, layer, existingNodeId, name || "", content, onLog);
    return { added: false, merged: true, replaced: false, nodeId: existingNodeId, layer };
  }

  // Check similarity threshold for merge
  if (opts?.mergeSimilar && (opts.similarityThreshold || 0) > 0) {
    const similar = findSimilarKnowledgeNode(net, layer, content);
    if (similar && similar.similarity >= (opts.similarityThreshold || 0.40)) {
      const result = updateExistingNodeByPolicy(net, layer, similar.nodeId, name || "", content, onLog);
      return { added: false, merged: true, replaced: false, nodeId: similar.nodeId, layer };
    }
  }

  // Validate
  const validation = validateKnowledgeCrystal(content, layer);
  if (!validation.ok) {
    const rescale = rescaleRejectedCrystal(net, content, validation.reason, layer, onLog, addPolicyNode, _recordArtifactEvent);
    if (rescale?.rescued) {
      return { added: true, merged: false, replaced: false, nodeId: rescale.nodeId!, layer: rescale.layer! };
    }
    return { added: false, merged: false, replaced: false, nodeId: "", layer };
  }

  if (!TEXTRON_ALLOW_NODE_GROWTH) {
    return { added: false, merged: false, replaced: false, nodeId: "", layer };
  }

  // Find replacement slot (empty node) or append
  let slotIdx = -1;
  for (let n = 0; n < net.hyperparams.layers[layer]; n++) {
    if (!readNodeContent(path.join(net.path, `layer_${layer}`, `node_${n}.html`))) {
      slotIdx = n;
      break;
    }
  }

  if (slotIdx >= 0) {
    // Replace empty node
    const nodeId = `node_${slotIdx}`;
    const np = path.join(net.path, `layer_${layer}`, `${nodeId}.html`);
    const existing = net.weights?.layer_connections?.[`${layer}_to_${layer + 1}`] || [];
    const outEdges = existing
      .filter((e: any) => e.from === nodeId)
      .map((e: any) => ({ toId: e.to, weight: e.weight }));
    writeNodeHtml(np, layer, nodeId, validation.content, outEdges, name);
    onLog(`Textron: replaced empty L${layer}::${nodeId} "${previewText(name || validation.content, 40)}"`);
    return { added: true, merged: false, replaced: true, nodeId, layer };
  }

  // Need to expand layer
  const newIdx = net.hyperparams.layers[layer];
  net.hyperparams.layers[layer]++;
  const nodeId = `node_${newIdx}`;
  const np = path.join(net.path, `layer_${layer}`, `${nodeId}.html`);

  // Create edges from previous layer
  if (layer > 0) {
    const prevKey = `${layer - 1}_to_${layer}`;
    if (!net.weights.layer_connections) net.weights.layer_connections = {};
    if (!net.weights.layer_connections[prevKey]) net.weights.layer_connections[prevKey] = [];
    for (let p = 0; p < net.hyperparams.layers[layer - 1]; p++) {
      net.weights.layer_connections[prevKey].push({
        from: `node_${p}`, to: nodeId, weight: DEFAULT_WEIGHT,
      });
    }
  }

  // Create edges to next layer
  if (layer < net.hyperparams.layers.length - 1) {
    const nextKey = `${layer}_to_${layer + 1}`;
    if (!net.weights.layer_connections[nextKey]) net.weights.layer_connections[nextKey] = [];
    for (let n = 0; n < net.hyperparams.layers[layer + 1]; n++) {
      net.weights.layer_connections[nextKey].push({
        from: nodeId, to: `node_${n}`, weight: DEFAULT_WEIGHT,
      });
    }
  }

  const outEdges = (net.weights.layer_connections[`${layer}_to_${layer + 1}`] || [])
    .filter((e: any) => e.from === nodeId)
    .map((e: any) => ({ toId: e.to, weight: e.weight }));

  writeNodeHtml(np, layer, nodeId, validation.content, outEdges, name);
  writeJson(path.join(net.path, "hyperparams.json"), net.hyperparams);
  writeJson(path.join(net.path, "weights.json"), net.weights);
  onLog(`Textron: added L${layer}::${nodeId} "${previewText(name || validation.content, 40)}"`);
  return { added: true, merged: false, replaced: false, nodeId, layer };
}

export function compactMergeEmptiedNodes(
  net: { hyperparams: { layers: number[] }; path: string; weights: any },
  onLog: (msg: string) => void,
): number {
  let compacted = 0;
  for (let l = 0; l < net.hyperparams.layers.length; l++) {
    const layerDir = path.join(net.path, `layer_${l}`);
    for (let n = net.hyperparams.layers[l] - 1; n >= 0; n--) {
      const np = path.join(layerDir, `node_${n}.html`);
      if (!readNodeContent(np)) {
        // Empty node: shift all higher indices down
        for (let m = n; m < net.hyperparams.layers[l] - 1; m++) {
          const src = path.join(layerDir, `node_${m + 1}.html`);
          const dst = path.join(layerDir, `node_${m}.html`);
          if (fs.existsSync(src)) {
            const srcContent = readNodeContent(src);
            const srcName = readNodeName(src);
            const outEdges = (net.weights?.layer_connections?.[`${l}_to_${l + 1}`] || [])
              .filter((e: any) => e.from === `node_${m + 1}`)
              .map((e: any) => ({ toId: e.to, weight: e.weight }));
            writeNodeHtml(dst, l, `node_${m}`, srcContent, outEdges, srcName);
            fs.unlinkSync(src);
          }
        }
        // Update edge weights to reflect new indices
        for (const key of Object.keys(net.weights?.layer_connections || {})) {
          const edges = net.weights.layer_connections[key];
          for (const e of edges) {
            const fromNum = parseInt(String(e.from).replace("node_", ""), 10);
            const toNum = parseInt(String(e.to).replace("node_", ""), 10);
            if (String(e.from).startsWith("node_") && fromNum > n) e.from = `node_${fromNum - 1}`;
            if (String(e.to).startsWith("node_") && toNum > n) e.to = `node_${toNum - 1}`;
          }
        }
        net.hyperparams.layers[l]--;
        compacted++;
      }
    }
  }
  if (compacted > 0) {
    writeJson(path.join(net.path, "hyperparams.json"), net.hyperparams);
    writeJson(path.join(net.path, "weights.json"), net.weights);
    onLog(`Textron: compacted ${compacted} empty nodes`);
  }
  return compacted;
}

export function compactEmptyNodes(
  net: { hyperparams: { layers: number[] }; path: string; weights: any },
  onLog: (msg: string) => void,
): number {
  return compactMergeEmptiedNodes(net, onLog);
}

export function addDynamicNode(
  net: { hyperparams: { layers: number[] }; path: string; weights: any },
  layer: number,
  content: string,
  onLog: (msg: string) => void,
  name?: string,
): { added: boolean; merged: boolean; replaced: boolean; nodeId: string; layer: number } {
  return addPolicyNode(net, layer, content, onLog, name, layer, { mergeSimilar: true, similarityThreshold: 0.40 });
}
