import * as fs from "node:fs";
import * as path from "node:path";
import { distillNodeName } from "../name_distill.ts";
import { NODE_CONTENT_MAX_CHARS } from "../content_limits.ts";
import { shannonEntropy, wordEntropy, isTruncated, isTemporalSummary, isMetaInstruction } from "./entropy";
import { jaccard, nameTokens } from "./similarity";

export function readNodeContent(filePath: string): string {
  try {
    const html = fs.readFileSync(filePath, "utf-8");
    const match = html.match(/<content>\s*([\s\S]*?)\s*<\/content>/);
    return match ? match[1].trim() : "";
  } catch { return ""; }
}

export function compressNodeName(content: string): string {
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
  const storedContent = String(content || "").slice(0, NODE_CONTENT_MAX_CHARS);
  const nodeName = (name || compressNodeName(storedContent)).slice(0, 64);
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
${storedContent}
</content>
`, "utf-8");
}

export function validateKnowledgeCrystal(raw: string, targetLayer?: number): { ok: boolean; content: string; reason?: string } {
  const content = String(raw || "").replace(/\s+/g, " ").trim();
  if (!content) return { ok: false, content, reason: "empty" };
  const minLen = targetLayer === 0 ? 18 : 28;
  if (content.length < minLen) return { ok: false, content, reason: "too_short" };
  if (content.length > NODE_CONTENT_MAX_CHARS) return { ok: false, content, reason: "too_long_session_summary" };

  const rawOps = /(HTTP\s+20\d|localhost:\d+|PID\s*\d+|nohup|pkill|ps aux|curl\s|tail\s-|log tail|Serving UI|Templates at|Output at|bridge\s*已?重启|重启\s*nbeat\s*UI)/i;
  if (rawOps.test(content)) return { ok: false, content, reason: "raw_operational_trace" };

  if (isTemporalSummary(content)) return { ok: false, content, reason: "temporal_session_summary" };
  if (isTruncated(content)) return { ok: false, content, reason: "truncated_mid_thought" };
  if (isMetaInstruction(content)) return { ok: false, content, reason: "meta_instruction_not_knowledge" };

  const charEntropy = shannonEntropy(content);
  if (charEntropy < 3.5) return { ok: false, content, reason: `low_entropy(${charEntropy.toFixed(1)})` };
  const wEntropy = wordEntropy(content);
  if (wEntropy < 2.5) return { ok: false, content, reason: `low_word_entropy(${wEntropy.toFixed(1)})` };

  const transferable = /(→|->|=>|导致|因为|原因|修复|避免|优先|回退|兼容|依赖|版本|导出|缺少|模块|解析|规则|原则|模式|应该|必须|when|if|若|如果|avoid|prefer|should|must|rule|fallback|compat|dependency|version|export|module|resolve|import|routing|propagate|backward|forward|reward|edge|node|context|threshold|workflow|mismatch|relevance|overwrite|retarget|penalize|summary|summarize|timeline|blocker|entrypoint|evidence|progress|recall|risk|benefit|tradeoff|cost|quality|failure|success|gain|loss|趋利|避害|取舍|收益|风险|代价|高熵)/i;
  if (!transferable.test(content)) return { ok: false, content, reason: "not_transferable_experience" };

  return { ok: true, content };
}

export function intraLayerOrthogonalityCheck(
  net: { hyperparams: { layers: number[] }; path: string },
  layer: number,
  newContent: string,
  excludeNodeId?: string,
): { tooSimilar: boolean; similarTo?: string; similarity: number } {
  const newTokens = nameTokens(compressNodeName(newContent));
  if (newTokens.size === 0) return { tooSimilar: false, similarity: 0 };
  let bestScore = 0;
  let bestNode = "";
  for (let n = 0; n < net.hyperparams.layers[layer]; n++) {
    const nid = `node_${n}`;
    if (nid === excludeNodeId) continue;
    const np = path.join(net.path, `layer_${layer}`, `${nid}.html`);
    const existingName = readNodeName(np);
    if (!existingName) continue;
    const score = jaccard(newTokens, nameTokens(existingName));
    if (score > bestScore) { bestScore = score; bestNode = `L${layer}::${nid}`; }
  }
  return { tooSimilar: bestScore >= 0.65, similarTo: bestScore >= 0.65 ? bestNode : undefined, similarity: bestScore };
}

export function isNgramFragmentContent(content: string): boolean {
  const s = String(content || "").replace(/\s+/g, " ").trim();
  if (!s) return false;
  if (s.length < 18) return true;
  if (/^[a-zA-Z0-9_\-\s\|\.\,\;\:\!\?\+\-\*\/\=\(\)\[\]\{\}\<\>\@\#\$\%\^\&]{4,80}$/.test(s) && s.length < 45) return true;
  return false;
}

export function contextSimilarity(a: string, b: string): number {
  const ta = new Set(String(a || "").toLowerCase().split(/\s+/).filter(w => w.length > 1));
  const tb = new Set(String(b || "").toLowerCase().split(/\s+/).filter(w => w.length > 1));
  if (!ta.size || !tb.size) return 0;
  let overlap = 0;
  for (const w of ta) if (tb.has(w)) overlap++;
  return overlap / Math.max(ta.size, tb.size);
}

export function prepareContextLine(content: string): string | null {
  const s = String(content || "").replace(/\s+/g, " ").trim();
  if (!s || s.length < 8) return null;
  return s;
}
