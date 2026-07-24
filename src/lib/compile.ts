import * as path from "node:path";
import { readNodeName } from "./node_io";
import { NGRAM_DISTILL_PROMOTE, DEFAULT_WEIGHT } from "./network";
import { NODE_CONTENT_MAX_CHARS } from "../content_limits.ts";
import { isNgramFragmentContent, prepareContextLine } from "./node_io";

interface ActivatedNode {
  id: string;
  layer: number;
  content: string;
  activation: number;
}

export function compileContext(
  net: { hyperparams: { layers: number[] }; path: string; weights: any },
  activated: ActivatedNode[],
): string {
  if (!activated.length) return "";
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const n of activated) {
    if (seen.has(n.id)) continue;
    seen.add(n.id);
    const line = prepareContextLine(n.content);
    if (line) lines.push(`[L${n.layer} ${n.id}] ${line}`);
  }
  return lines.join("\n");
}

export function selectedEdgeIdToWeightKey(edgeId: string): string | null {
  const m = String(edgeId || "").match(/^L(\d+)::(node_\d+)->L(\d+)::(node_\d+)$/);
  if (!m) return null;
  const fromLayer = parseInt(m[1], 10);
  const toLayer = parseInt(m[3], 10);
  if (toLayer !== fromLayer + 1) return null;
  return `${fromLayer}_to_${toLayer}`;
}
