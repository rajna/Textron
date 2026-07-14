import * as path from "node:path";
import { readNodeContent, readNodeName, compressNodeName } from "./storage";
import type { ActivatedNode } from "./types";

// ─── Textron Propagation: compile activated path into context ─────────

export function compileContext(
  netPath: string,
  activated: ActivatedNode[],
): string {
  if (activated.length === 0) return "";

  const byLayer = new Map<number, ActivatedNode[]>();
  for (const n of activated) {
    const list = byLayer.get(n.layer) || [];
    list.push(n);
    byLayer.set(n.layer, list);
  }

  let ctx = `\n\n## Textron Network: ${path.basename(netPath)}\n`;
  ctx += `Trained context from previous tasks in this family.\n\n`;

  for (const [l, nodes] of [...byLayer.entries()].sort((a, b) => a[0] - b[0])) {
    for (const n of nodes) {
      ctx += `- ${n.content}\n`;
    }
  }

  return ctx;
}
