import * as fs from "node:fs";
import * as path from "node:path";
import { TEXTRON_HOME } from "./constants";
import { distillNodeName } from "./name_distill.ts";

// ─── Textron Storage Helpers ──────────────────────────────────────────

export function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

export function readJson<T>(filePath: string, fallback: T): T {
  try { return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T; }
  catch { return fallback; }
}

export function writeJson(filePath: string, data: unknown) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
}

export function readNodeContent(filePath: string): string {
  try {
    const html = fs.readFileSync(filePath, "utf-8");
    const match = html.match(/<content>\s*([\s\S]*?)\s*<\/content>/);
    return match ? match[1].trim() : "";
  } catch { return ""; }
}

export function compressNodeName(content: string): string {
  // Keyword-distilled name (name_distill.ts) — node name = retrieval key seen by
  // L0 scoring/routing/dedup, so it must carry content's high-entropy terms.
  return distillNodeName(content);
}

export function readNodeName(filePath: string): string {
  try {
    const html = fs.readFileSync(filePath, "utf-8");
    const block = html.match(/<name>\s*([\s\S]*?)\s*<\/name>/);
    if (block?.[1]?.trim()) return block[1].trim();
    const meta = html.match(/<meta\s+name=["']name["']\s+content=["']([^"']*)["']/i);
    if (meta?.[1]?.trim()) return meta[1].trim();
  } catch {}
  return compressNodeName(readNodeContent(filePath));
}

export function writeNodeHtml(filePath: string, layer: number, nodeId: string, content: string, outEdges: { toId: string; weight: number }[], name?: string) {
  const nodeName = (name || compressNodeName(content)).slice(0, 64);
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

/** Get the filesystem path for a task family network directory. */
export function getTaskFamilyPath(taskFamily: string): string {
  const safe = taskFamily.replace(/[^a-zA-Z0-9\u4e00-\u9fff_-]/g, "_").slice(0, 64);
  return path.join(TEXTRON_HOME, safe);
}
