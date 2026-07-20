import * as fs from "node:fs";
import * as path from "node:path";
import { writeJson, readNodeContent, readNodeName, writeNodeHtml, compressNodeName } from "./storage";
import { clamp, parseLayerNodeId } from "./utils";
import type { LoadedNetwork } from "./network";
import type { WeightsFile } from "./types";
import { createNodeState } from "./ngram_distill";

// ─── Textron Auto Backward Propagation ────────────────────────────────
// Expanded: edge weights + node content CRUD (create/update/merge/delete) in one pass.

export function selectedEdgeIdToWeightKey(edgeId: string): string | null {
  const m = edgeId.match(/^L(\d+)::(.+?)->L(\d+)::(.+)$/);
  if (!m) return null;
  const fromL = parseInt(m[1], 10);
  const toL = parseInt(m[3], 10);
  if (toL !== fromL + 1) return null;
  return `${fromL}_to_${toL}:${m[2]}:${m[4]}`;
}

export interface NodeAction {
  action: "merge" | "delete" | "keep";
  source?: string;
  target?: string;
  node?: string;
  rationale?: string;
}

export interface BackwardResult {
  changes: number;
  changedEdges: string[];
  nodesUpdated: number;
  nodesAdded: number;
  nodesMerged: number;
  nodesDeleted: number;
  nodesSkipped: number;
  nodeSkipReasons: string[];
}

export function autoBackward(
  net: LoadedNetwork,
  activatedIds: string[],
  reward: number,
  onLog: (msg: string) => void,
  selectedEdgeIds: string[] = [],
  edgeRewards?: Map<string, number>,
  nodeUpdates?: Record<string, string | { name?: string; content?: string }>,
  addNodes?: { layer: number; name?: string; content: string }[],
  nodeActions?: NodeAction[],
): BackwardResult {
  // ── Edge weight updates ──
  const lr = net.hyperparams.learningRate;
  const activeEdgeSet = new Set<string>();

  // Preferred path: update exactly the selected forward edges.
  for (const edgeId of selectedEdgeIds) {
    const key = selectedEdgeIdToWeightKey(edgeId);
    if (key) activeEdgeSet.add(key);
  }

  // Legacy fallback: derive adjacent edges from activated path.
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

  let changes = 0;
  const changedEdges: string[] = [];
  if (activeEdgeSet.size > 0) {
    for (const [key, edges] of Object.entries(net.weights.layer_connections)) {
      for (const edge of edges) {
        const eid = `${key}:${edge.from}:${edge.to}`;
        if (!activeEdgeSet.has(eid)) continue;
        const old = edge.weight;
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
      onLog(`Textron backward: ${changes} selected edge(s) updated (reward=${reward.toFixed(3)}) for "${path.basename(net.path)}"`);
    }

    // Negative reward: lightly penalize ALL edges connected to activated nodes (noise suppression).
    if (reward < 0 && activatedIds.length > 0) {
      const activatedNodeKeys = new Set<string>();
      for (const id of activatedIds) {
        const parsed = parseLayerNodeId(id);
        if (parsed) activatedNodeKeys.add(parsed.nodeId);
      }
      const penaltyRate = lr * Math.abs(reward) * 0.3;
      let extraChanges = 0;
      for (const [key, edges] of Object.entries(net.weights.layer_connections)) {
        for (const edge of edges) {
          if (activatedNodeKeys.has(edge.from) || activatedNodeKeys.has(edge.to)) {
            const eid = `${key}:${edge.from}:${edge.to}`;
            if (activeEdgeSet.has(eid)) continue;
            const old = edge.weight;
            edge.weight = clamp(old - penaltyRate * (1 + old), -1, 1);
            if (Math.abs(edge.weight - old) > 0.0005) {
              extraChanges++;
              changedEdges.push(`${eid}:${old.toFixed(4)}->${edge.weight.toFixed(4)} [noise_penalty]`);
            }
          }
        }
      }
      if (extraChanges > 0) {
        writeJson(path.join(net.path, "weights.json"), net.weights);
        onLog(`Textron backward: ${extraChanges} extra connected-edge(s) penalized (noise suppression) for "${path.basename(net.path)}"`);
      }
    }
  }

  // ── Node content updates ──
  let nodesUpdated = 0, nodesUpdatedSkipped = 0;
  const nodeSkipReasons: string[] = [];
  if (nodeUpdates) {
    for (const [id, update] of Object.entries(nodeUpdates)) {
      const parsed = parseLayerNodeId(id);
      if (!parsed) { nodesUpdatedSkipped++; nodeSkipReasons.push(`${id}:bad_id`); continue; }
      const nodePath = path.join(net.path, `layer_${parsed.layer}`, `${parsed.nodeId}.html`);
      if (!fs.existsSync(nodePath)) { nodesUpdatedSkipped++; nodeSkipReasons.push(`${id}:not_found`); continue; }
      const content = typeof update === "string" ? update : String(update.content || readNodeContent(nodePath) || "").trim();
      if (!content) { nodesUpdatedSkipped++; nodeSkipReasons.push(`${id}:empty`); continue; }
      const outEdges = (net.weights.layer_connections[`${parsed.layer}_to_${parsed.layer + 1}`] || [])
        .filter(e => e.from === parsed.nodeId).map(e => ({ toId: e.to, weight: e.weight }));
      writeNodeHtml(nodePath, parsed.layer, parsed.nodeId, content.slice(0, 120), outEdges, compressNodeName(content));
      nodesUpdated++;
    }
  }

  // ── Node additions ──
  let nodesAdded = 0, nodesMerged = 0, nodesDeleted = 0;
  for (const node of addNodes || []) {
    if (!node.content) continue;
    const targetLayer = node.layer;
    if (targetLayer < 0 || targetLayer >= net.hyperparams.layers.length) continue;
    // Check if similar node already exists
    const existingNodes: { id: string; name: string; content: string }[] = [];
    for (let n = 0; n < net.hyperparams.layers[targetLayer]; n++) {
      const np = path.join(net.path, `layer_${targetLayer}`, `node_${n}.html`);
      const c = readNodeContent(np);
      if (c) existingNodes.push({ id: `node_${n}`, name: readNodeName(np) || compressNodeName(c), content: c });
    }
    // Simple overlap check — if >65% token overlap, skip (already covered)
    const nodeTokens = new Set((node.content || "").toLowerCase().split(/\s+/));
    const overlaps = existingNodes.map(en => {
      const et = new Set(en.content.toLowerCase().split(/\s+/));
      let hit = 0; for (const t of nodeTokens) if (et.has(t)) hit++;
      return { ...en, overlap: hit / Math.max(1, Math.min(nodeTokens.size, et.size)) };
    }).filter(e => e.overlap > 0.5);
    if (overlaps.length > 0) {
      nodesMerged++;
      onLog(`Textron backward: skipped add_node L${targetLayer} (similar to ${overlaps[0].id}, overlap=${overlaps[0].overlap.toFixed(2)})`);
      continue;
    }
    // Find empty slot or append
    let filled = false;
    for (let n = 0; n < net.hyperparams.layers[targetLayer]; n++) {
      const np = path.join(net.path, `layer_${targetLayer}`, `node_${n}.html`);
      if (!readNodeContent(np)) {
        const outEdges = (net.weights.layer_connections[`${targetLayer}_to_${targetLayer + 1}`] || [])
          .filter(e => e.from === `node_${n}`).map(e => ({ toId: e.to, weight: e.weight }));
        writeNodeHtml(np, targetLayer, `node_${n}`, node.content.slice(0, 120), outEdges, node.name || compressNodeName(node.content));
        nodesAdded++;
        filled = true;
        break;
      }
    }
    if (!filled) {
      onLog(`Textron backward: skipped add_node L${targetLayer} (layer full, ${net.hyperparams.layers[targetLayer]} nodes)`);
      nodesUpdatedSkipped++;
      nodeSkipReasons.push(`L${targetLayer}:layer_full`);
    }
  }

  // ── Node actions: merge / delete ──
  for (const action of nodeActions || []) {
    if (action.action === "merge" && action.source && action.target) {
      const sp = parseLayerNodeId(action.source);
      const tp = parseLayerNodeId(action.target);
      if (!sp || !tp || sp.layer !== tp.layer) continue;
      const srcPath = path.join(net.path, `layer_${sp.layer}`, `${sp.nodeId}.html`);
      const tgtPath = path.join(net.path, `layer_${tp.layer}`, `${tp.nodeId}.html`);
      const srcContent = readNodeContent(srcPath);
      const tgtContent = readNodeContent(tgtPath);
      if (!srcContent || !tgtContent) continue;
      // Merge: combine into target, empty source
      const merged = (tgtContent + "; " + srcContent).slice(0, 120);
      const tgtOutEdges = (net.weights.layer_connections[`${tp.layer}_to_${tp.layer + 1}`] || [])
        .filter(e => e.from === tp.nodeId).map(e => ({ toId: e.to, weight: e.weight }));
      writeNodeHtml(tgtPath, tp.layer, tp.nodeId, merged, tgtOutEdges, compressNodeName(merged));
      const srcOutEdges = (net.weights.layer_connections[`${sp.layer}_to_${sp.layer + 1}`] || [])
        .filter(e => e.from === sp.nodeId).map(e => ({ toId: e.to, weight: e.weight }));
      writeNodeHtml(srcPath, sp.layer, sp.nodeId, "", srcOutEdges);
      try {
        const ngramPath = srcPath.replace(/\.html$/, ".ngram.json");
        if (fs.existsSync(ngramPath)) fs.writeFileSync(ngramPath, JSON.stringify(createNodeState()), "utf-8");
      } catch {}
      nodesMerged++;
      onLog(`Textron backward: merged ${action.source} into ${action.target} (source emptied)`);
    } else if (action.action === "delete" && action.node) {
      const dp = parseLayerNodeId(action.node);
      if (!dp) continue;
      const nodePath = path.join(net.path, `layer_${dp.layer}`, `${dp.nodeId}.html`);
      const oldContent = readNodeContent(nodePath);
      if (!oldContent) continue;
      const outEdges = (net.weights.layer_connections[`${dp.layer}_to_${dp.layer + 1}`] || [])
        .filter(e => e.from === dp.nodeId).map(e => ({ toId: e.to, weight: e.weight }));
      writeNodeHtml(nodePath, dp.layer, dp.nodeId, "", outEdges);
      try {
        const ngramPath = nodePath.replace(/\.html$/, ".ngram.json");
        if (fs.existsSync(ngramPath)) fs.writeFileSync(ngramPath, JSON.stringify(createNodeState()), "utf-8");
      } catch {}
      nodesDeleted++;
      onLog(`Textron backward: deleted ${action.node}${action.rationale ? ` (${action.rationale})` : ""}`);
    }
  }

  // Persist if anything changed
  if (nodesUpdated > 0 || nodesAdded > 0 || nodesMerged > 0 || nodesDeleted > 0) {
    net.hyperparams.updatedAt = new Date().toISOString();
    writeJson(path.join(net.path, "hyperparams.json"), net.hyperparams);
  }

  return {
    changes, changedEdges,
    nodesUpdated, nodesAdded, nodesMerged, nodesDeleted,
    nodesSkipped: nodesUpdatedSkipped,
    nodeSkipReasons,
  };
}
