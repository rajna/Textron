import * as path from "node:path";
import { readNodeName, readNodeFunction } from "./node_io";
import { NGRAM_DISTILL_PROMOTE, DEFAULT_WEIGHT } from "./network";
import { NODE_INJECT_MAX_CHARS, applyContentLimit } from "../content_limits.ts";
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
    if (!line) continue;
    // 函数引用链：节点若持久化了 <function symbol=...>，注入时带上符号名，
    // 让后续决策/反传能按 functionSymbol 字面命中该节点（与反传规则 8 的引用链对齐）。
    const nodeFile = `${String(n.id).match(/node_\d+/)?.[0] || String(n.id)}.html`;
    const fn = readNodeFunction(path.join(net.path, `layer_${n.layer}`, nodeFile));
    // 写入宽 / 读取窄：节点 content 不再截断，注入侧按单节点预算限幅（防写入变宽后 prompt 膨胀）。
    lines.push(`[L${n.layer} ${n.id}] ${applyContentLimit(line, NODE_INJECT_MAX_CHARS)}${fn?.symbol ? ` ⟨fn:${fn.symbol}⟩` : ""}`);
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
