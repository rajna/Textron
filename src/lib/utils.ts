import * as fs from "node:fs";
import * as path from "node:path";

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

export function ts(): string { return new Date().toISOString().slice(11, 23); }

export function dlog(category: string, msg: string, data?: unknown) {
  const line = `[${ts()}] [${category}] ${msg}`;
  if (data !== undefined) console.error(line, typeof data === "object" ? JSON.stringify(data).slice(0, 400) : data);
  else console.error(line);
}

export function clamp(v: number, min: number, max: number): number { return Math.max(min, Math.min(max, v)); }

export function completeContent(text: string, maxLen: number): string {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  if (s.length <= maxLen) return s;
  const cut = s.lastIndexOf(" ", maxLen);
  return cut > maxLen * 0.6 ? s.slice(0, cut) : s.slice(0, maxLen);
}

export function parseLayerNodeId(raw: string): { layer: number; nodeId: string } | null {
  const m = String(raw || "").match(/^L(\d+)::(.+)$/);
  if (!m) return null;
  return { layer: parseInt(m[1], 10), nodeId: m[2] };
}

export function seedRandom(seed: string): () => number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) { h = Math.imul(31, h) + seed.charCodeAt(i) | 0; }
  return function () { h ^= h << 13; h ^= h >>> 17; h ^= h << 5; return (h >>> 0) / 4294967296; };
}

export function formatNodesForLLM(nodes: { id: string; layer: number; content: string; outgoingEdges: { toId: string; weight: number }[] }[]): string {
  return nodes.map(n => {
    const edges = n.outgoingEdges.map(e => `  → L${n.layer + 1}::${e.toId} w=${e.weight.toFixed(2)}`).join("\n");
    return `[L${n.layer}::${n.id}] (${n.content.slice(0, 120)})${edges ? "\n" + edges : ""}`;
  }).join("\n");
}

export function previewText(text: unknown, max = 160): string {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}
