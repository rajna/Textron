import * as path from "node:path";
import { readJson, writeJson, previewText, completeContent } from "./utils";
import { validateKnowledgeCrystal } from "./node_io";
import { NODE_CONTENT_MAX_CHARS } from "../content_limits.ts";
import { nameTokens, tokenSimilarity } from "./similarity";
// addPolicyNode imported at call site to avoid circular dependency

export const RESCALE_DOWN_REASONS = new Set([
  "too_long_session_summary",
  "raw_operational_trace",
  "temporal_session_summary",
  "truncated_mid_thought",
  "meta_instruction_not_knowledge",
  "low_entropy",
  "low_word_entropy",
]);
export const RESCALE_UP_REASONS = new Set(["too_short", "not_transferable_experience"]);
export const RESCALE_PENDING_LIMIT = 20;
export const RESCALE_PAIR_MIN_SIM = 0.2;

export interface RescalePendingItem { content: string; layer: number; reason: string; ts: string; }

export function rescalePendingPath(netPath: string): string { return path.join(netPath, "_rescale_pending.json"); }

export function readRescalePending(netPath: string): RescalePendingItem[] {
  const items = readJson<RescalePendingItem[]>(rescalePendingPath(netPath), []);
  return Array.isArray(items) ? items : [];
}

export function writeRescalePending(netPath: string, items: RescalePendingItem[]): void {
  writeJson(rescalePendingPath(netPath), items.slice(-RESCALE_PENDING_LIMIT));
}

export function tryUpscalePair(
  net: { hyperparams: { layers: number[] }; path: string },
  item: RescalePendingItem,
  onLog: (msg: string) => void,
  addPolicyNode: Function,
): { rescued: boolean; nodeId?: string; layer?: number } {
  const pending = readRescalePending(net.path);
  const itemTokens = nameTokens(item.content);
  let bestIdx = -1;
  let bestSim = 0;
  for (let i = 0; i < pending.length; i++) {
    if (pending[i].layer !== item.layer) continue;
    const sim = tokenSimilarity(itemTokens, nameTokens(pending[i].content));
    if (sim > bestSim) { bestSim = sim; bestIdx = i; }
  }
  if (bestIdx >= 0 && bestSim >= RESCALE_PAIR_MIN_SIM) {
    const partner = pending.splice(bestIdx, 1)[0];
    const merged = completeContent(`${partner.content} | ${item.content}`, NODE_CONTENT_MAX_CHARS);
    const validation = validateKnowledgeCrystal(merged, item.layer);
    if (validation.ok) {
      const created = addPolicyNode(net, item.layer, validation.content, onLog, undefined, undefined, { mergeSimilar: true, similarityThreshold: 0.40 });
      if (created.added || created.merged || created.replaced) {
        writeRescalePending(net.path, pending);
        onLog(`Textron rescale(upscale): paired 2 fragments → L${created.layer}::${created.nodeId} (sim=${bestSim.toFixed(2)})`);
        return { rescued: true, nodeId: created.nodeId, layer: created.layer };
      }
    }
    pending.push(partner);
  }
  pending.push(item);
  writeRescalePending(net.path, pending);
  return { rescued: false };
}

export function rescaleRejectedCrystal(
  net: { hyperparams: { layers: number[] }; path: string },
  content: string,
  reason: string | undefined,
  targetLayer: number,
  onLog: (msg: string) => void,
  addPolicyNode: Function,
  recordArtifactEvent: Function,
): { rescued: boolean; action: string; nodeId?: string; layer?: number } | null {
  const baseReason = String(reason || "").replace(/\(.*\)$/, "");
  if (RESCALE_DOWN_REASONS.has(baseReason)) {
    const { buildAtomKey } = require("../name_distill.ts");
    const atom = buildAtomKey(content);
    if (!atom) return { rescued: false, action: "downscale_no_structure" };
    const created = addPolicyNode(net, targetLayer, atom, onLog, atom.slice(0, 64), undefined, { mergeSimilar: true, similarityThreshold: 0.40 });
    if (created.added || created.merged || created.replaced) {
      recordArtifactEvent({
        type: "rescale",
        action: created.merged ? "downscale_atom_merged" : "downscale_atom_node",
        taskFamily: path.basename(net.path),
        reason: baseReason,
        nodeId: `L${created.layer}::${created.nodeId}`,
        atomPreview: previewText(atom, 100),
        sourcePreview: previewText(content, 160),
      });
      onLog(`Textron rescale(downscale): ${baseReason} → atom L${created.layer}::${created.nodeId} "${previewText(atom, 60)}"`);
      return { rescued: true, action: created.merged ? "downscale_merged" : "downscale_atom", nodeId: created.nodeId, layer: created.layer };
    }
    return { rescued: false, action: "downscale_rejected" };
  }
  if (RESCALE_UP_REASONS.has(baseReason)) {
    const item: RescalePendingItem = { content: content.slice(0, NODE_CONTENT_MAX_CHARS), layer: targetLayer, reason: baseReason, ts: new Date().toISOString() };
    const up = tryUpscalePair(net, item, onLog, addPolicyNode);
    recordArtifactEvent({
      type: "rescale",
      action: up.rescued ? "upscale_pair_merged" : "upscale_buffered",
      taskFamily: path.basename(net.path),
      reason: baseReason,
      nodeId: up.rescued ? `L${up.layer}::${up.nodeId}` : undefined,
      contentPreview: previewText(content, 240),
    });
    return { rescued: up.rescued, action: up.rescued ? "upscale_pair" : "upscale_buffered", nodeId: up.nodeId, layer: up.layer };
  }
  return null;
}
