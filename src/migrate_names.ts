// migrate_names.ts — one-off migration: rewrite existing node names with the
// high-entropy keyword distiller (name_distill.ts). Old prefix-truncated names
// ("...") are replaced in-place; content and edges untouched.
// Self-contained (no storage.ts/constants.ts imports) so it runs under raw node.
//
// Usage:
//   node src/migrate_names.ts           # dry-run: print old → new, write nothing
//   node src/migrate_names.ts --apply   # rewrite node html files

import * as fs from "node:fs";
import * as path from "node:path";
import { distillNodeName } from "./name_distill.ts";

declare const process: { argv: string[]; env: Record<string, string | undefined>; exit(code?: number): never };

const TEXTRON_HOME = path.join(process.env.HOME || "~", ".textron");
const apply = process.argv.includes("--apply");

interface Edge { from: string; to: string; weight: number }

function readJson<T>(filePath: string, fallback: T): T {
  try { return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T; } catch { return fallback; }
}

function readTag(filePath: string, tag: string): string {
  try {
    const html = fs.readFileSync(filePath, "utf-8");
    const m = html.match(new RegExp(`<${tag}>\\s*([\\s\\S]*?)\\s*<\\/${tag}>`));
    return m ? m[1].trim() : "";
  } catch { return ""; }
}

function writeNodeHtml(filePath: string, layer: number, nodeId: string, content: string, outEdges: { toId: string; weight: number }[], name: string) {
  const nodeName = name.slice(0, 64);
  const edgesHtml = outEdges
    .map((e) => `  <link rel="out" href="../layer_${layer + 1}/${e.toId}.html" data-weight="${e.weight.toFixed(4)}">`)
    .join("\n");
  fs.writeFileSync(filePath, `<!DOCTYPE html>
<meta name="layer" content="${layer}">
<meta name="id" content="${nodeId}">
<meta name="name" content="${nodeName.replace(/"/g, "&quot;")}">
${edgesHtml}
<name>
${nodeName}
</name>
<content>
${content}
</content>
`, "utf-8");
}

function main() {
  if (!fs.existsSync(TEXTRON_HOME)) {
    console.log(`TEXTRON_HOME not found: ${TEXTRON_HOME}`);
    return;
  }
  const networks = fs.readdirSync(TEXTRON_HOME).filter((d) => {
    const full = path.join(TEXTRON_HOME, d);
    return fs.statSync(full).isDirectory() && fs.existsSync(path.join(full, "hyperparams.json"));
  });

  let scanned = 0, changed = 0, skippedEmpty = 0;
  for (const net of networks) {
    const netPath = path.join(TEXTRON_HOME, net);
    const weights = readJson<{ layer_connections: Record<string, Edge[]> }>(path.join(netPath, "weights.json"), { layer_connections: {} });
    const hp = readJson<{ layers: number[] }>(path.join(netPath, "hyperparams.json"), { layers: [] });
    for (let l = 0; l < hp.layers.length; l++) {
      for (let n = 0; n < hp.layers[l]; n++) {
        const nodePath = path.join(netPath, `layer_${l}`, `node_${n}.html`);
        if (!fs.existsSync(nodePath)) continue;
        const content = readTag(nodePath, "content");
        if (!content) { skippedEmpty++; continue; }
        scanned++;
        const oldName = readTag(nodePath, "name");
        const newName = distillNodeName(content).slice(0, 64);
        if (!newName || newName === oldName) continue;
        changed++;
        console.log(`[${net}] L${l}::node_${n}`);
        console.log(`  OLD: ${oldName}`);
        console.log(`  NEW: ${newName}`);
        if (apply) {
          const outEdges = (weights.layer_connections[`${l}_to_${l + 1}`] || [])
            .filter((e) => e.from === `node_${n}`)
            .map((e) => ({ toId: e.to, weight: e.weight }));
          writeNodeHtml(nodePath, l, `node_${n}`, content, outEdges, newName);
        }
      }
    }
  }
  console.log(`\nnetworks=${networks.length} nodesWithContent=${scanned} renamed=${changed} emptySkipped=${skippedEmpty} mode=${apply ? "APPLY" : "DRY-RUN"}`);
}

main();
