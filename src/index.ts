/**
 * Textron — Trainable Textual Neural Network for Agent Context Optimization
 *
 * HYBRID MODE (LLM + programmatic):
 *   1. before_agent_start auto-routes network + injects L0 nodes
 *   2. before_agent_start: blocking LLM call scores L0 nodes (0.0-1.0)
 *   3. Extension programmatically propagates L0 × edge weights → activated path
 *   4. Compiled path context injected as tool result
 *   5. LLM executes task with compiled context
 *   6. next before_agent_start awaits previous-turn backward before current forward
 *
 * Storage: ~/.textron/{task_family}/
 *   hyperparams.json / weights.json / layer_N/node_X.html
 *
 * Live Monitor: http://localhost:8766
 *   weights.json      - all edge weights
 *   layer_N/          - HTML node files
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import {
  createNodeState,
  updateCounts,
  maybeDistill,
  serializeState,
  deserializeState,
  calcSignalScores,
  type NodeNgramState,
} from "./ngram_distill";
import { buildTextronPromptInjection } from "./prompt_injection";
import { buildBackwardTaskContext } from "./lifecycle_context";
import { assignEdgeCredit, chooseTaskFamilyRoute } from "./learning_policy";

// ─── Types ──────────────────────────────────────────────────────────

interface Hyperparams {
  layers: number[];
  threshold: number;
  learningRate: number;
  createdAt: string;
  updatedAt: string;
}

interface Edge {
  from: string;
  to: string;
  weight: number;
}

interface WeightsFile {
  layer_connections: Record<string, Edge[]>;
}

interface ActivatedNode {
  id: string;
  layer: number;
  content: string;
  activation: number;
}

// ─── Constants ──────────────────────────────────────────────────────

const TEXTRON_HOME = path.join(
  process.env.HOME || process.env.USERPROFILE || "~",
  ".textron",
);

const DEFAULT_HYPERPARAMS: Hyperparams = {
  // Front-narrow/back-wide: early layers are abstract routers, later layers hold concrete specifics.
  layers: [4, 6, 8],
  threshold: 0.2,
  learningRate: 0.08,
  createdAt: "",
  updatedAt: "",
};

const DEFAULT_WEIGHT = 0.5;
const NGRAM_DISTILL_PROMOTE = process.env.TEXTRON_NGRAM_DISTILL_PROMOTE === "1";
// Freeze topology by default: learning must merge/update/replace existing slots, not grow forever.
const TEXTRON_ALLOW_NODE_GROWTH = process.env.TEXTRON_ALLOW_NODE_GROWTH === "1";

// ─── Storage Helpers ─────────────────────────────────────────────────

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readJson<T>(filePath: string, fallback: T): T {
  try { return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T; }
  catch { return fallback; }
}

function writeJson(filePath: string, data: unknown) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
}

// ── n-gram distillation state (.ngram.json per node) ──

function readonlyNgramPath(nodePath: string): string {
  return nodePath.replace(/\.html$/, ".ngram.json");
}

function readNgramState(nodePath: string): NodeNgramState {
  try {
    const raw = fs.readFileSync(readonlyNgramPath(nodePath), "utf-8");
    return deserializeState(raw);
  } catch {
    return createNodeState();
  }
}

function writeNgramState(nodePath: string, state: NodeNgramState): void {
  fs.writeFileSync(readonlyNgramPath(nodePath), serializeState(state), "utf-8");
}

/** Load all ngram states for all nodes in a network. */
function loadAllNgramStates(net: NonNullable<ReturnType<typeof loadNetwork>>): NodeNgramState[] {
  const states: NodeNgramState[] = [];
  for (let l = 0; l < net.hyperparams.layers.length; l++) {
    for (let n = 0; n < net.hyperparams.layers[l]; n++) {
      const np = path.join(net.path, `layer_${l}`, `node_${n}.html`);
      states.push(readNgramState(np));
    }
  }
  return states;
}

function getNgramStats(net: NonNullable<ReturnType<typeof loadNetwork>>): { stateFiles: number; totalActivations: number; successfulActivations: number; distillReady: number } {
  let stateFiles = 0;
  let totalActivations = 0;
  let successfulActivations = 0;
  let distillReady = 0;
  for (let l = 0; l < net.hyperparams.layers.length; l++) {
    for (let n = 0; n < net.hyperparams.layers[l]; n++) {
      const np = path.join(net.path, `layer_${l}`, `node_${n}.html`);
      const sp = readonlyNgramPath(np);
      if (!fs.existsSync(sp)) continue;
      stateFiles++;
      const st = readNgramState(np);
      totalActivations += st.totalActivations || 0;
      successfulActivations += st.successfulActivations || 0;
      if ((st.successfulActivations || 0) - (st.lastDistillAt || 0) >= 3) distillReady++;
    }
  }
  return { stateFiles, totalActivations, successfulActivations, distillReady };
}

function readNodeContent(filePath: string): string {
  try {
    const html = fs.readFileSync(filePath, "utf-8");
    const match = html.match(/<content>\s*([\s\S]*?)\s*<\/content>/);
    return match ? match[1].trim() : "";
  } catch { return ""; }
}

function compressNodeName(content: string): string {
  const s = (content || "").replace(/\s+/g, " ").trim();
  if (!s) return "";
  return s.length > 48 ? s.slice(0, 45) + "..." : s;
}

function readNodeName(filePath: string): string {
  try {
    const html = fs.readFileSync(filePath, "utf-8");
    const block = html.match(/<name>\s*([\s\S]*?)\s*<\/name>/);
    if (block?.[1]?.trim()) return block[1].trim();
    const meta = html.match(/<meta\s+name=["']name["']\s+content=["']([^"']*)["']/i);
    if (meta?.[1]?.trim()) return meta[1].trim();
  } catch {}
  return compressNodeName(readNodeContent(filePath));
}

function writeNodeHtml(filePath: string, layer: number, nodeId: string, content: string, outEdges: { toId: string; weight: number }[], name?: string) {
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

function validateKnowledgeCrystal(raw: string, targetLayer?: number): { ok: boolean; content: string; reason?: string } {
  const content = String(raw || "").replace(/\s+/g, " ").trim();
  if (!content) return { ok: false, content, reason: "empty" };
  const minLen = targetLayer === 0 ? 18 : 28;
  if (content.length < minLen) return { ok: false, content, reason: "too_short" };
  if (content.length > 240) return { ok: false, content, reason: "too_long_session_summary" };

  // ── Gate 1: reject raw operational traces ──
  const rawOps = /(HTTP\s+20\d|localhost:\d+|PID\s*\d+|nohup|pkill|ps aux|curl\s|tail\s-|log tail|Serving UI|Templates at|Output at|bridge\s*已?重启|重启\s*nbeat\s*UI)/i;
  if (rawOps.test(content)) return { ok: false, content, reason: "raw_operational_trace" };

  // ── Gate 2: reject temporal session summaries (must come before truncation check) ──
  if (isTemporalSummary(content)) return { ok: false, content, reason: "temporal_session_summary" };

  // ── Gate 3: reject truncated mid-thought content ──
  if (isTruncated(content)) return { ok: false, content, reason: "truncated_mid_thought" };

  // ── Gate 4: reject meta-instructions (not domain knowledge) ──
  if (isMetaInstruction(content)) return { ok: false, content, reason: "meta_instruction_not_knowledge" };

  // ── Gate 5: Shannon entropy check — low entropy = boilerplate/template ──
  const charEntropy = shannonEntropy(content);
  if (charEntropy < 3.5) return { ok: false, content, reason: `low_entropy(${charEntropy.toFixed(1)})` };
  const wEntropy = wordEntropy(content);
  if (wEntropy < 2.5) return { ok: false, content, reason: `low_word_entropy(${wEntropy.toFixed(1)})` };

  // ── Gate 6: require transferable signal (causal/tradeoff/actionable) ──
  const transferable = /(→|->|=>|导致|因为|原因|修复|避免|优先|回退|兼容|依赖|版本|导出|缺少|模块|解析|规则|原则|模式|应该|必须|when|if|若|如果|avoid|prefer|should|must|rule|fallback|compat|dependency|version|export|module|resolve|import|routing|propagate|backward|forward|reward|edge|node|context|threshold|workflow|mismatch|relevance|overwrite|retarget|penalize|summary|summarize|timeline|blocker|entrypoint|evidence|progress|recall|risk|benefit|tradeoff|cost|quality|failure|success|gain|loss|趋利|避害|取舍|收益|风险|代价|高熵)/i;
  if (!transferable.test(content)) return { ok: false, content, reason: "not_transferable_experience" };

  return { ok: true, content };
}

/** Check if new content is too similar to any existing node in the same layer (orthogonality gate). */
function intraLayerOrthogonalityCheck(
  net: NonNullable<ReturnType<typeof loadNetwork>>,
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

function parseHighEntropyCrystal(text: string): { name: string; content: string; raw: string; ok: boolean; reason?: string } {
  const rawText = String(text || "");
  const match = rawText.match(/<HighEntropy>\s*([\s\S]*?)\s*<\/HighEntropy>/i);
  const raw = match?.[1]?.replace(/\s+/g, " ").trim() || "";
  if (!raw) return { name: "", content: "", raw, ok: false, reason: "missing" };
  if (raw.includes("<TextronSkill") || raw.includes("historical Textron network prior")) {
    return { name: "", content: "", raw, ok: false, reason: "echoed_textron_prior" };
  }

  let name = "";
  let content = "";
  try {
    const parsed = JSON.parse(raw);
    name = String(parsed?.name || parsed?.Name || "").trim();
    content = String(parsed?.content || parsed?.Content || parsed?.rule || parsed?.insight || "").trim();
  } catch {}
  if (!content) {
    const nameMatch = raw.match(/(?:^|[;；|\n])\s*(?:name|Name|名称|节点名)\s*[:：]\s*([^;；|\n]{2,80})/);
    const contentMatch = raw.match(/(?:^|[;；|\n])\s*(?:content|Content|内容|规则)\s*[:：]\s*([\s\S]{8,220})/);
    if (nameMatch) name = nameMatch[1].trim();
    if (contentMatch) content = contentMatch[1].trim();
  }
  if (!content) content = raw.replace(/^(?:name|Name|名称|节点名)\s*[:：][^;；|\n]+[;；|\n]?\s*/i, "").trim();
  content = completeContent(content.replace(/^content\s*[:：]\s*/i, ""), 180);
  name = completeContent(name || compressNodeName(content), 64);

  if (isNgramFragmentContent(content)) return { name, content, raw, ok: false, reason: "ngram_fragment" };
  if (isTemporalSummary(content)) return { name, content, raw, ok: false, reason: "temporal_summary" };
  const validation = validateKnowledgeCrystal(content);
  if (!validation.ok) return { name, content, raw, ok: false, reason: validation.reason };
  if (isNgramFragmentContent(name)) name = compressNodeName(validation.content);
  return { name: completeContent(name, 64), content: validation.content, raw, ok: true };
}

function extractHighEntropy(text: string): string {
  const crystal = parseHighEntropyCrystal(text);
  if (!crystal.ok) return "";
  return `Name: ${crystal.name}\nContent: ${crystal.content}`;
}

const HIGH_ENTROPY_INSTRUCTION = `

## Textron HighEntropy Output Contract
At the very end of your final user-facing answer, append exactly one XML block. Textron backward consumes this as training data, so do NOT echo TextronSkill/history/tool logs.
<HighEntropy>
Name: ≤48 chars entropy crystal: the shortest distinctive symbolic compression of Content; preserve the transferable pattern, not surface words. Content: ≤160 chars high-entropy experience atom from this turn for Textron learning: a reusable insight that would change future behavior or context selection in similar tasks. Capture durable constraints, failure corrections, causal mechanisms, decision boundaries, validation signals, or strategy patterns when present. No raw logs, file lists, counts, URLs, session summaries, or vague progress.
</HighEntropy>`;

// ─── Task Classification ────────────────────────────────────────────

// ─── Network CRUD ────────────────────────────────────────────────────

function getTaskFamilyPath(taskFamily: string): string {
  const safe = taskFamily.replace(/[^a-zA-Z0-9\u4e00-\u9fff_-]/g, "_").slice(0, 64);
  return path.join(TEXTRON_HOME, safe);
}

function networkExists(taskFamily: string): boolean {
  return fs.existsSync(path.join(getTaskFamilyPath(taskFamily), "hyperparams.json"));
}

function listNetworks(): string[] {
  if (!fs.existsSync(TEXTRON_HOME)) return [];
  return fs.readdirSync(TEXTRON_HOME).filter((d) => {
    const full = path.join(TEXTRON_HOME, d);
    return fs.statSync(full).isDirectory() && fs.existsSync(path.join(full, "hyperparams.json"));
  });
}

function initNetwork(
  taskFamily: string,
  layers: number[],
  threshold: number,
  learningRate: number,
  onLog: (msg: string) => void,
): Hyperparams {
  const tfPath = getTaskFamilyPath(taskFamily);
  ensureDir(tfPath);

  const now = new Date().toISOString();
  const hp: Hyperparams = { layers, threshold, learningRate, createdAt: now, updatedAt: now };
  writeJson(path.join(tfPath, "hyperparams.json"), hp);

  const weights: WeightsFile = { layer_connections: {} };
  const rng = seedRandom(taskFamily);
  let totalEdges = 0;

  for (let l = 0; l < layers.length - 1; l++) {
    const edges: Edge[] = [];
    for (let f = 0; f < layers[l]; f++) {
      for (let t = 0; t < layers[l + 1]; t++) {
        if (rng() < 0.6) {
          edges.push({ from: `node_${f}`, to: `node_${t}`, weight: DEFAULT_WEIGHT });
          totalEdges++;
        }
      }
    }
    weights.layer_connections[`${l}_to_${l + 1}`] = edges;
  }
  writeJson(path.join(tfPath, "weights.json"), weights);

  // All nodes start empty — LLM fills them via backward
  for (let l = 0; l < layers.length; l++) {
    const layerDir = path.join(tfPath, `layer_${l}`);
    ensureDir(layerDir);
    const outEdges = l < layers.length - 1 ? (weights.layer_connections[`${l}_to_${l + 1}`] || []) : [];
    for (let n = 0; n < layers[l]; n++) {
      const nid = `node_${n}`;
      const nodeEdges = outEdges.filter((e) => e.from === nid).map((e) => ({ toId: e.to, weight: e.weight }));
      writeNodeHtml(path.join(layerDir, `${nid}.html`), l, nid, "", nodeEdges);
    }
  }

  onLog(`Textron: created network "${taskFamily}" [${layers.join(",")}] ${layers.reduce((a,b)=>a+b,0)} nodes, ${totalEdges} edges`);
  return hp;
}

function loadNetwork(taskFamily: string) {
  const tfPath = getTaskFamilyPath(taskFamily);
  if (!fs.existsSync(tfPath)) return null;
  return {
    path: tfPath,
    hyperparams: readJson<Hyperparams>(path.join(tfPath, "hyperparams.json"), DEFAULT_HYPERPARAMS),
    weights: readJson<WeightsFile>(path.join(tfPath, "weights.json"), { layer_connections: {} }),
  };
}

// ─── Manual Propagation (used by tool actions) ────────────────────

function isNgramFragmentContent(content: string): boolean {
  const s = String(content || "").replace(/\s+/g, " ").trim();
  if (!s) return true;
  // CJK bigram chains like "但质 质量 量未 未达" are distillation artifacts, not usable lessons.
  if (/(?:^|[\s;；|])(?:[\u4e00-\u9fff]{2}\s+){2,}[\u4e00-\u9fff]{2}(?:[\s;；|]|$)/.test(s)) return true;
  // Short overlapping CJK pairs such as "路由 由优" are also n-gram fragments.
  if (/(?:^|[\s;；|])([\u4e00-\u9fff]{2})\s+([\u4e00-\u9fff]{2})(?:[\s;；|]|$)/.test(s)) {
    const m = s.match(/(?:^|[\s;；|])([\u4e00-\u9fff]{2})\s+([\u4e00-\u9fff]{2})(?:[\s;；|]|$)/);
    if (m && m[1][1] === m[2][0]) return true;
  }
  const parts = s.split(/[;；|]/).map((p) => p.trim()).filter(Boolean);
  if (parts.length >= 3) {
    const shortParts = parts.filter((p) => p.length < 36).length;
    const tinyParts = parts.filter((p) => p.length < 12).length;
    const repeatedStarts = new Set(parts.map((p) => p.split(/\s+/).slice(0, 2).join(" "))).size;
    if (shortParts / parts.length > 0.75 && repeatedStarts <= Math.ceil(parts.length * 0.5)) return true;
    if (parts.length >= 4 && tinyParts >= 3) return true;

    // Detect n-gram ladders where each semicolon part shifts/extends the previous
    // one: "A B; B C; C D" or "A B C; B C D; C D E".
    let ladderPairs = 0;
    let duplicateTokenCount = 0;
    const allTokens: string[] = [];
    const tokenized = parts.map((p) => p.toLowerCase().split(/[\s,，。！？、:：()\[\]{}<>"'`/\\+=_-]+/).filter((w) => w.length > 1));
    for (const toks of tokenized) allTokens.push(...toks);
    for (let i = 0; i < tokenized.length - 1; i++) {
      const a = tokenized[i];
      const b = tokenized[i + 1];
      if (a.length < 2 || b.length < 2) continue;
      const bs = new Set(b);
      const overlap = a.filter((t) => bs.has(t)).length / Math.min(a.length, b.length);
      const aText = a.join(" ");
      const bText = b.join(" ");
      if (overlap >= 0.6 || aText.includes(bText) || bText.includes(aText)) ladderPairs++;
    }
    const counts = new Map<string, number>();
    for (const t of allTokens) counts.set(t, (counts.get(t) || 0) + 1);
    for (const n of counts.values()) if (n > 1) duplicateTokenCount += n - 1;
    if (ladderPairs >= 2) return true;
    if (allTokens.length >= 8 && duplicateTokenCount / allTokens.length >= 0.35 && parts.length >= 4) return true;
  }
  return false;
}

function contextSimilarity(a: string, b: string): number {
  const aa = new Set(String(a || "").toLowerCase().split(/[\s,，。！？、:：;；()\[\]{}<>"'`/\\|+=_-]+/).filter((w) => w.length > 2));
  const bb = new Set(String(b || "").toLowerCase().split(/[\s,，。！？、:：;；()\[\]{}<>"'`/\\|+=_-]+/).filter((w) => w.length > 2));
  if (!aa.size || !bb.size) return 0;
  let hit = 0;
  for (const w of aa) if (bb.has(w)) hit++;
  return hit / Math.min(aa.size, bb.size);
}

function previewText(text: unknown, max = 160): string {
  return String(text || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function recordArtifactEvent(data: Record<string, unknown>) {
  try {
    ensureDir(TEXTRON_HOME);
    const eventsPath = path.join(TEXTRON_HOME, "_events.jsonl");
    fs.appendFileSync(eventsPath, JSON.stringify({ ...data, ts: new Date().toISOString() }) + "\n", "utf-8");
  } catch {}
}

function prepareContextLine(content: string): string | null {
  const s = completeContent(String(content || "").replace(/\s+/g, " ").trim(), 180);
  if (!s) return null;
  if (isNgramFragmentContent(s)) return null;
  const quality = validateKnowledgeCrystal(s);
  if (!quality.ok && !/(验证|audit|provider|payload|context|hook|prompt|注入|去重|过滤|quality|guard|dedupe|distill)/i.test(s)) return null;
  return quality.ok ? quality.content : s;
}

function compileContext(net: NonNullable<ReturnType<typeof loadNetwork>>, activated: ActivatedNode[]): string {
  if (activated.length === 0) return "";

  const lines: { id: string; layer: number; name: string; content: string }[] = [];
  for (const n of [...activated].sort((a, b) => a.layer - b.layer || b.activation - a.activation)) {
    const nodeId = `L${n.layer}::${n.id}`;
    const nodePath = path.join(net.path, `layer_${n.layer}`, `${n.id}.html`);
    const rawName = readNodeName(nodePath);
    const prepared = prepareContextLine(n.content);
    const preparedName = prepareContextLine(rawName) || compressNodeName(prepared || rawName || n.content);
    if (!prepared) {
      recordArtifactEvent({
        type: "trace",
        action: "node_artifact_quarantined_from_context",
        taskFamily: path.basename(net.path),
        nodeId,
        reason: "prepare_context_rejected",
        namePreview: previewText(rawName, 100),
        contentPreview: previewText(n.content, 180),
      });
      continue;
    }
    if (lines.some((existing) => contextSimilarity(existing.content, prepared) >= 0.72)) continue;
    lines.push({ id: nodeId, layer: n.layer, name: completeContent(preparedName, 64), content: prepared });
  }

  if (lines.length === 0) return "";

  let ctx = `<TextronSkill network="${path.basename(net.path)}" kind="historical_prior">\n`;
  ctx += `Note: historical prior, not authoritative current fact. Use as agent skill hints; verify against latest user input/files/tool output.\n`;
  for (const item of lines) {
    ctx += `<SkillNode id="${item.id}" layer="${item.layer}">\n`;
    ctx += `Name: ${item.name}\n`;
    ctx += `Content: ${item.content}\n`;
    ctx += `</SkillNode>\n`;
  }
  ctx += `</TextronSkill>`;

  return ctx;
}

// ─── Auto Backward Propagation ──────────────────────────────────────

function selectedEdgeIdToWeightKey(edgeId: string): string | null {
  const m = edgeId.match(/^L(\d+)::(.+?)->L(\d+)::(.+)$/);
  if (!m) return null;
  const fromL = parseInt(m[1], 10);
  const toL = parseInt(m[3], 10);
  if (toL !== fromL + 1) return null;
  return `${fromL}_to_${toL}:${m[2]}:${m[4]}`;
}

function autoBackward(
  net: NonNullable<ReturnType<typeof loadNetwork>>,
  activatedIds: string[],
  reward: number,
  onLog: (msg: string) => void,
  selectedEdgeIds: string[] = [],
  edgeRewards?: Map<string, number>,
): { changes: number; changedEdges: string[] } {
  const lr = net.hyperparams.learningRate;
  const activeEdgeSet = new Set<string>();

  // Preferred path: update exactly the selected forward edges. This prevents unrelated
  // edges between activated nodes from being reinforced or penalized.
  for (const edgeId of selectedEdgeIds) {
    const key = selectedEdgeIdToWeightKey(edgeId);
    if (key) activeEdgeSet.add(key);
  }

  // Legacy fallback: derive adjacent edges from activated path if selectedEdgeIds unavailable.
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

  if (activeEdgeSet.size === 0) return { changes: 0, changedEdges: [] };

  let changes = 0;
  const changedEdges: string[] = [];
  for (const [key, edges] of Object.entries(net.weights.layer_connections)) {
    for (const edge of edges) {
      const eid = `${key}:${edge.from}:${edge.to}`;
      if (!activeEdgeSet.has(eid)) continue;
      const old = edge.weight;
      const edgeReward = edgeRewards?.get(eid) ?? reward;
      if (edgeReward > 0) edge.weight = clamp(old + lr * edgeReward * (1 - old), -1, 1);
      else if (edgeReward < 0) edge.weight = clamp(old + lr * edgeReward * (1 + old), -1, 1);
      if (Math.abs(edge.weight - old) > 0.000001) {
        changes++;
        changedEdges.push(`${eid}:${old.toFixed(4)}->${edge.weight.toFixed(4)}`);
      }
    }
  }

  if (changes > 0) {
    writeJson(path.join(net.path, "weights.json"), net.weights);
    net.hyperparams.updatedAt = new Date().toISOString();
    writeJson(path.join(net.path, "hyperparams.json"), net.hyperparams);
    onLog(`Textron backward: ${changes} selected edge(s) updated (reward=${reward.toFixed(3)}) for "${path.basename(net.path)}"`);
  }
  return { changes, changedEdges };
}

// ─── Feedback Detection ───────────────────────────────────────────────

async function evaluateUserFeedback(userMessage: string, ctx?: { apiKey?: string; baseUrl?: string; model?: string }): Promise<{ sentiment: 'success' | 'failure' | 'neutral'; insight?: string }> {
  const endpoint = ctx?.baseUrl || process.env.TEXTRON_EVAL_ENDPOINT || 'http://localhost:11434/v1/chat/completions';
  const model = ctx?.model || process.env.TEXTRON_EVAL_MODEL || await detectSmallestModel() || '';
  if (!model) return { sentiment: keywordFallback(userMessage) };
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{
          role: 'system',
          content: '分析用户消息。1) 判断是对助手上一轮回答的正面/负面/中性回应。2) 如有改进建议或纠正，提炼≤80字关键要点。返回JSON: {"sentiment":"success|failure|neutral","insight":"要点或null"}'
        }, {
          role: 'user',
          content: `用户消息: "${userMessage.slice(0, 3000)}"`
        }],
        max_tokens: 150,
        temperature: 0,
      }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json() as any;
    const raw: string = data?.choices?.[0]?.message?.content || '';
    try {
      const parsed = JSON.parse(raw);
      return {
        sentiment: parsed.sentiment || 'neutral',
        insight: parsed.insight && parsed.insight !== 'null' ? parsed.insight : undefined,
      };
    } catch {
      const lower = raw.toLowerCase();
      if (lower.includes('failure') || lower.includes('负面')) return { sentiment: 'failure' };
      if (lower.includes('success') || lower.includes('正面')) return { sentiment: 'success' };
      return { sentiment: 'neutral' };
    }
  } catch {
    return { sentiment: keywordFallback(userMessage) };
  }
}

async function detectSmallestModel(): Promise<string | null> {
  try {
    const res = await fetch('http://localhost:11434/api/tags', { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return null;
    const data = await res.json() as any;
    const models: { name: string; size: number }[] = data?.models || [];
    if (models.length === 0) return null;
    models.sort((a, b) => a.size - b.size);
    return models[0].name;
  } catch { return null; }
}

function keywordFallback(userMessage: string): 'success' | 'failure' | 'neutral' {
  const msg = userMessage.toLowerCase();
  // Negation pattern: 不 + positive word = negative. Must check BEFORE success.
  if (/不[好行对像样够理想]|太差|太烂|太糟|[没無]有?做好|[没無]用|fail|wrong|incorrect|don't|shouldn't|cannot|can't|badly|poorly/.test(msg)) return 'failure';
  // More aggressive failure: explicit negative words
  if (/不对|不是|错了|修正|不应该|错误|不行|不像|不好|不完?整|不连贯|混乱|糟糕|失败|垃圾|难听|不自然|不流畅|僵硬|生硬/.test(msg)) return 'failure';
  // Success: positive feedback (only match standalone positive words, not negated ones)
  if (/(?:^|[\s，。！？、\-—\(\)])好(?:[\s，。！？、\-—\(\)]|$)|很好|太棒|不错|厉害|完美|great|awesome|excellent|amazing|perfect/.test(msg)) return 'success';
  if (/对|继续|是的|good|thanks|correct|exactly|love it|well done/.test(msg)) return 'success';
  return 'neutral';
}

function storeFailureKnowledge(
  net: NonNullable<ReturnType<typeof loadNetwork>>,
  activatedIds: string[],
  userMessage: string,
  onLog: (msg: string) => void,
) {
  // Compress user's correction to ~100 chars as high-entropy insight
  const insight = userMessage.length > 100 ? userMessage.slice(0, 97) + '...' : userMessage;
  // Try to fill an empty node in a non-output layer first
  for (let l = 0; l < net.hyperparams.layers.length - 1; l++) {
    for (let n = 0; n < net.hyperparams.layers[l]; n++) {
      const np = path.join(net.path, `layer_${l}`, `node_${n}.html`);
      if (!readNodeContent(np)) {
        const outEdges = (net.weights.layer_connections[`${l}_to_${l + 1}`] || [])
          .filter(e => e.from === `node_${n}`).map(e => ({ toId: e.to, weight: e.weight }));
        writeNodeHtml(np, l, `node_${n}`, insight, outEdges, compressNodeName(insight));
        onLog(`Textron: stored failure insight in L${l}::node_${n}`);
        return;
      }
    }
  }
  // All non-output nodes filled — add dynamic node to layer 0
  addPolicyNode(net, undefined, insight, onLog, compressNodeName(insight));
}

// ─── Orthogonality Helpers ─────────────────────────────────────────────

function nameTokens(name: string): Set<string> {
  const s = (name || "").toLowerCase().replace(/[^a-z0-9一-鿿]+/g, " ").trim();
  const parts = s.split(/\s+/).filter(Boolean);
  const out = new Set<string>(parts);
  // Character bigrams make short Chinese/compound names comparable too.
  const compact = s.replace(/\s+/g, "");
  for (let i = 0; i < compact.length - 1; i++) out.add(compact.slice(i, i + 2));
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

function tokenSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const jac = inter / (a.size + b.size - inter);
  const overlap = inter / Math.min(a.size, b.size);
  return Math.max(jac, overlap * 0.72);
}

function findSimilarNode(
  net: NonNullable<ReturnType<typeof loadNetwork>>,
  name: string,
  minScore = 0.72,
  targetLayer?: number,
): { layer: number; nodeId: string; score: number; name: string } | null {
  const target = nameTokens(name);
  let best: { layer: number; nodeId: string; score: number; name: string } | null = null;
  const startLayer = Number.isInteger(targetLayer as number) ? targetLayer as number : 0;
  const endLayer = Number.isInteger(targetLayer as number) ? targetLayer as number : net.hyperparams.layers.length - 1;
  for (let l = startLayer; l <= endLayer; l++) {
    for (let n = 0; n < net.hyperparams.layers[l]; n++) {
      const nodeId = `node_${n}`;
      const nodePath = path.join(net.path, `layer_${l}`, `${nodeId}.html`);
      const existingName = readNodeName(nodePath);
      if (!existingName) continue;
      const score = tokenSimilarity(target, nameTokens(existingName));
      if (score >= minScore && (!best || score > best.score)) best = { layer: l, nodeId, score, name: existingName };
    }
  }
  return best;
}

function findSimilarKnowledgeNode(
  net: NonNullable<ReturnType<typeof loadNetwork>>,
  name: string,
  content: string,
  minScore = 0.24,
  targetLayer?: number,
  excludeNodeId?: string,
): { layer: number; nodeId: string; score: number; name: string; content: string } | null {
  const targetName = nameTokens(name || compressNodeName(content));
  const targetContent = nameTokens(content);
  let best: { layer: number; nodeId: string; score: number; name: string; content: string } | null = null;
  const startLayer = Number.isInteger(targetLayer as number) ? targetLayer as number : 0;
  const endLayer = Number.isInteger(targetLayer as number) ? targetLayer as number : net.hyperparams.layers.length - 1;
  for (let l = startLayer; l <= endLayer; l++) {
    for (let n = 0; n < net.hyperparams.layers[l]; n++) {
      const nodeId = `node_${n}`;
      if (nodeId === excludeNodeId) continue;
      const nodePath = path.join(net.path, `layer_${l}`, `${nodeId}.html`);
      const existingContent = readNodeContent(nodePath);
      if (!existingContent) continue;
      const existingName = readNodeName(nodePath) || compressNodeName(existingContent);
      const nameScore = tokenSimilarity(targetName, nameTokens(existingName));
      const contentScore = tokenSimilarity(targetContent, nameTokens(existingContent));
      const score = Math.max(nameScore, contentScore, (nameScore + contentScore) / 2);
      if (score >= minScore && (!best || score > best.score)) best = { layer: l, nodeId, score, name: existingName, content: existingContent };
    }
  }
  return best;
}

function mergeNodeContent(oldContent: string, newContent: string): string {
  const oldS = (oldContent || "").trim();
  const newS = (newContent || "").trim();
  if (!oldS) return newS.slice(0, 120);
  if (!newS || oldS.includes(newS)) return oldS.slice(0, 120);
  if (newS.includes(oldS)) return newS.slice(0, 120);
  return mergeContent(oldS, newS);
}

/** Module-level mergeContent (same as above but uses completeContent + stale detection). */
function mergeContent(oldContent: string, newContent: string): string {
  if (!oldContent) return completeContent(newContent, 120);
  if (oldContent === newContent) return oldContent;
  // If old content is low-quality, prefer new
  const oldQuality = validateKnowledgeCrystal(oldContent);
  if (!oldQuality.ok) return completeContent(newContent, 120);
  const oldSet = new Set(oldContent.toLowerCase().split(/\s+/));
  const newSet = new Set(newContent.toLowerCase().split(/\s+/));
  let newTokens = 0;
  for (const w of newSet) if (!oldSet.has(w)) newTokens++;
  const overlap = 1 - newTokens / Math.max(1, newSet.size);
  if (overlap >= 0.6) {
    const fresh = [...newSet].filter(w => !oldSet.has(w)).join(" ");
    if (fresh && (oldContent + "; " + fresh).length <= 120) return completeContent(oldContent + "; " + fresh, 120);
    return completeContent(oldContent, 120);
  }
  const newQuality = validateKnowledgeCrystal(newContent);
  if (!newQuality.ok && oldQuality.ok) return completeContent(oldContent, 120);
  const combined = oldContent + " | " + newContent;
  if (combined.length <= 120) return combined;
  const oldHead = oldContent.slice(0, 58).replace(/[;；|,，。.!?、]\s*[^;；|,，。.!?、]*$/, "").trim() || oldContent.slice(0, 58).trim();
  const newHead = newContent.slice(0, 58).replace(/[;；|,，。.!?、]\s*[^;；|,，。.!?、]*$/, "").trim() || newContent.slice(0, 58).trim();
  return completeContent(`${oldHead} | ${newHead}`, 120);
}

function updateExistingNodeByPolicy(
  net: NonNullable<ReturnType<typeof loadNetwork>>,
  layer: number,
  nodeId: string,
  name: string,
  content: string,
  onLog: (msg: string) => void,
): void {
  const nodePath = path.join(net.path, `layer_${layer}`, `${nodeId}.html`);
  const mergedContent = mergeNodeContent(readNodeContent(nodePath), content);
  const finalName = (name || readNodeName(nodePath) || compressNodeName(mergedContent)).slice(0, 64);
  const edgeKey = `${layer}_to_${layer + 1}`;
  const outEdges = (net.weights.layer_connections[edgeKey] || [])
    .filter((e) => e.from === nodeId)
    .map((e) => ({ toId: e.to, weight: e.weight }));
  writeNodeHtml(nodePath, layer, nodeId, mergedContent, outEdges, finalName);
  net.hyperparams.updatedAt = new Date().toISOString();
  writeJson(path.join(net.path, "hyperparams.json"), net.hyperparams);
  onLog(`Textron orthogonality: merged new knowledge into L${layer}::${nodeId} (${finalName})`);
}

// ─── Shape Policy: front-narrow / back-wide ────────────────────────────

/**
 * Choose where a new node may be added while preserving the intended topology:
 * early layers are abstract/narrow routers, later layers are wider concrete stores.
 * Auto-additions default to the deepest layer. Requested early-layer additions are
 * redirected deeper if they would make layer[k] wider than layer[k+1].
 */
function chooseExpansionLayer(net: NonNullable<ReturnType<typeof loadNetwork>>, requestedLayer?: number): number {
  const layers = net.hyperparams.layers;
  const last = layers.length - 1;
  // Default to deepest concrete store. L0 stays narrow for abstract entropy-symbol nodes.
  let layer = Number.isInteger(requestedLayer as number) ? Math.max(0, Math.min(last, requestedLayer as number)) : last;

  // If adding here would violate front<=back width, push one layer deeper.
  while (layer < last && layers[layer] + 1 > layers[layer + 1]) layer++;
  return layer;
}

function addPolicyNode(
  net: NonNullable<ReturnType<typeof loadNetwork>>,
  requestedLayer: number | undefined,
  content: string,
  onLog: (msg: string) => void,
  name?: string,
  specificNodeId?: string,
  options?: { mergeSimilar?: boolean; similarityThreshold?: number },
): { layer: number; nodeId: string; added: boolean; merged: boolean; replaced?: boolean; skipped?: boolean; reason?: string } {
  const nodeName = (name || compressNodeName(content)).slice(0, 64);
  const targetLayer = chooseExpansionLayer(net, requestedLayer);
  const mergeSimilar = options?.mergeSimilar !== false;

  // Merge-first across the target layer, before considering any new slot.
  const similar = findSimilarKnowledgeNode(net, nodeName, content, options?.similarityThreshold ?? 0.24, targetLayer);
  if (similar && mergeSimilar) {
    updateExistingNodeByPolicy(net, similar.layer, similar.nodeId, nodeName, content, onLog);
    return { layer: similar.layer, nodeId: similar.nodeId, added: false, merged: true };
  }

  // Frozen topology: fill an existing empty slot if one exists; otherwise replace weakest same-layer node.
  if (!TEXTRON_ALLOW_NODE_GROWTH) {
    for (let n = 0; n < net.hyperparams.layers[targetLayer]; n++) {
      const nodeId = `node_${n}`;
      const np = path.join(net.path, `layer_${targetLayer}`, `${nodeId}.html`);
      if (!readNodeContent(np)) {
        const outEdges = (net.weights.layer_connections[`${targetLayer}_to_${targetLayer + 1}`] || [])
          .filter((e) => e.from === nodeId)
          .map((e) => ({ toId: e.to, weight: e.weight }));
        writeNodeHtml(np, targetLayer, nodeId, content, outEdges, nodeName);
        net.hyperparams.updatedAt = new Date().toISOString();
        writeJson(path.join(net.path, "hyperparams.json"), net.hyperparams);
        onLog(`Textron shape policy: filled empty frozen slot L${targetLayer}::${nodeId}`);
        return { layer: targetLayer, nodeId, added: true, merged: false };
      }
    }

    let weakestNode = `node_0`;
    let weakestScore = Number.POSITIVE_INFINITY;
    for (let n = 0; n < net.hyperparams.layers[targetLayer]; n++) {
      const nodeId = `node_${n}`;
      const outgoing = (net.weights.layer_connections[`${targetLayer}_to_${targetLayer + 1}`] || []).filter((e) => e.from === nodeId);
      const incoming = (net.weights.layer_connections[`${targetLayer - 1}_to_${targetLayer}`] || []).filter((e) => e.to === nodeId);
      const score = [...outgoing, ...incoming].reduce((sum, e) => sum + Math.abs(e.weight), 0) / Math.max(1, outgoing.length + incoming.length);
      if (score < weakestScore) { weakestScore = score; weakestNode = nodeId; }
    }
    const np = path.join(net.path, `layer_${targetLayer}`, `${weakestNode}.html`);
    const oldContent = readNodeContent(np);
    const oldQuality = validateKnowledgeCrystal(oldContent, targetLayer);
    if (oldQuality.ok && weakestScore >= 0.28) {
      onLog(`Textron shape policy: frozen full L${targetLayer}; skipped add_node (no weak slot, weakest=${weakestNode}/${weakestScore.toFixed(2)})`);
      return { layer: targetLayer, nodeId: weakestNode, added: false, merged: false, skipped: true, reason: "frozen_full_no_weak_slot" };
    }
    const outEdges = (net.weights.layer_connections[`${targetLayer}_to_${targetLayer + 1}`] || [])
      .filter((e) => e.from === weakestNode)
      .map((e) => ({ toId: e.to, weight: e.weight }));
    writeNodeHtml(np, targetLayer, weakestNode, content, outEdges, nodeName);
    writeNgramState(np, createNodeState());
    net.hyperparams.updatedAt = new Date().toISOString();
    writeJson(path.join(net.path, "hyperparams.json"), net.hyperparams);
    onLog(`Textron shape policy: replaced weak frozen slot L${targetLayer}::${weakestNode} (${weakestScore.toFixed(2)})`);
    return { layer: targetLayer, nodeId: weakestNode, added: false, merged: false, replaced: true };
  }

  // Legacy growth mode: opt-in only via TEXTRON_ALLOW_NODE_GROWTH=1.
  let nodeId: string;
  if (specificNodeId) {
    const idx = parseInt(specificNodeId.replace("node_", ""), 10);
    if (!isNaN(idx) && idx === net.hyperparams.layers[targetLayer]) nodeId = specificNodeId;
    else {
      onLog(`Textron: rejected non-sequential nodeId ${specificNodeId} (gap prevention), using sequential`);
      nodeId = `node_${net.hyperparams.layers[targetLayer]}`;
    }
  } else nodeId = `node_${net.hyperparams.layers[targetLayer]}`;
  if (requestedLayer !== undefined && targetLayer !== requestedLayer) {
    onLog(`Textron shape policy: redirected new node L${requestedLayer} → L${targetLayer} (front-narrow/back-wide)`);
  }
  addDynamicNode(net, targetLayer, nodeId, content, onLog, nodeName);
  return { layer: targetLayer, nodeId, added: true, merged: false };
}

// ─── Dynamic Node Addition ─────────────────────────────────────────────

/**
 * Add a new node to an existing layer. Updates hyperparams, weight files,
 * and creates the node HTML file with proper edge connections.
 */
function addDynamicNode(
  net: NonNullable<ReturnType<typeof loadNetwork>>,
  layer: number,
  nodeId: string,
  content: string,
  onLog: (msg: string) => void,
  name?: string,
) {
  if (layer < 0 || layer >= net.hyperparams.layers.length) {
    onLog(`Textron: cannot add node to layer ${layer} (out of bounds)`);
    return;
  }

  // Compute new node index and update layer count
  const existingCount = net.hyperparams.layers[layer];
  const nodeIndex = parseInt(nodeId.replace('node_', ''), 10);
  const newCount = Math.max(existingCount, nodeIndex + 1);

  // Create all missing node files up to newCount-1
  const rng = seedRandom(`${net.path}_add_${layer}_${nodeId}`);
  for (let ni = existingCount; ni < newCount; ni++) {
    const nid = `node_${ni}`;
    const layerDir = path.join(net.path, `layer_${layer}`);
    ensureDir(layerDir);

    // Outgoing edges to next layer (if exists)
    const outEdges: { toId: string; weight: number }[] = [];
    if (layer < net.hyperparams.layers.length - 1) {
      const nextLayerSize = net.hyperparams.layers[layer + 1];
      let edgeKey = `${layer}_to_${layer + 1}`;
      if (!net.weights.layer_connections[edgeKey]) net.weights.layer_connections[edgeKey] = [];
      for (let t = 0; t < nextLayerSize; t++) {
        if (rng() < 0.6) {
          const w = 0.3 + rng() * 0.4; // 0.3-0.7 random initial weight
          net.weights.layer_connections[edgeKey].push({ from: nid, to: `node_${t}`, weight: w });
          outEdges.push({ toId: `node_${t}`, weight: w });
        }
      }
    }

    // Incoming edges from previous layer (if exists)
    if (layer > 0) {
      const prevLayerSize = net.hyperparams.layers[layer - 1];
      let edgeKey = `${layer - 1}_to_${layer}`;
      if (!net.weights.layer_connections[edgeKey]) net.weights.layer_connections[edgeKey] = [];
      for (let f = 0; f < prevLayerSize; f++) {
        if (rng() < 0.5) {
          const w = 0.3 + rng() * 0.4;
          // Avoid duplicate edges
          const exists = net.weights.layer_connections[edgeKey].some(
            e => e.from === `node_${f}` && e.to === nid
          );
          if (!exists) {
            net.weights.layer_connections[edgeKey].push({ from: `node_${f}`, to: nid, weight: w });
          }
        }
      }
    }

    const np = path.join(layerDir, `${nid}.html`);
    // Only the requested node gets content; other gap-filler nodes stay empty
    const nodeContent = (nid === nodeId) ? content : "";
    writeNodeHtml(np, layer, nid, nodeContent, outEdges, nid === nodeId ? name : undefined);
  }

  // Update hyperparams with new layer size
  net.hyperparams.layers[layer] = newCount;
  net.hyperparams.updatedAt = new Date().toISOString();

  // Persist
  writeJson(path.join(net.path, "weights.json"), net.weights);
  writeJson(path.join(net.path, "hyperparams.json"), net.hyperparams);

  const created = newCount - existingCount;
  onLog(`Textron: added ${created} node(s) to layer ${layer} of "${path.basename(net.path)}" (now ${newCount} nodes)`);
}

// ─── Debug Logging ──────────────────────────────────────────────────

const DEBUG = true; // process.env.TEXTRON_DEBUG === "1" — FORCED ON FOR TESTING
function ts(): string { return new Date().toISOString().slice(11, 23); }
function dlog(category: string, msg: string, data?: unknown) {
  if (!DEBUG) return;
  const prefix = `[TEXTRON ${ts()} ${category}]`;
  if (data !== undefined) console.error(prefix, msg, typeof data === "object" ? JSON.stringify(data).slice(0, 500) : String(data).slice(0, 500));
  else console.error(prefix, msg);
}

// ─── Utilities ───────────────────────────────────────────────────────

function clamp(v: number, min: number, max: number): number { return Math.max(min, Math.min(max, v)); }

/** Shannon entropy of character bigram distribution. Range ~0-8, higher = more information density. */
function shannonEntropy(text: string): number {
  const s = String(text || "");
  if (s.length < 6) return 0;
  const freq = new Map<string, number>();
  for (let i = 0; i < s.length - 1; i++) {
    const bigram = s.slice(i, i + 2);
    freq.set(bigram, (freq.get(bigram) || 0) + 1);
  }
  const n = s.length - 1;
  let entropy = 0;
  for (const count of freq.values()) {
    const p = count / n;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

/** Word-level Shannon entropy. More discriminative for CJK+EN mixed content. */
function wordEntropy(text: string): number {
  const words = String(text || "").toLowerCase().split(/[\s,，。！？、:：;；()\[\]{}<>"'`/\\|+=_-]+/).filter(w => w.length > 1);
  if (words.length < 3) return 0;
  const freq = new Map<string, number>();
  let total = 0;
  for (const w of words) { freq.set(w, (freq.get(w) || 0) + 1); total++; }
  let entropy = 0;
  for (const count of freq.values()) { const p = count / total; entropy -= p * Math.log2(p); }
  return entropy;
}

/** True if text appears truncated mid-thought (trailing ellipsis, incomplete clause, etc.). */
function isTruncated(text: string): boolean {
  const s = String(text || "").trim();
  if (!s) return false;
  // Trailing truncation indicators: ellipsis, three dots, trailing dash/comma/colon without period
  if (/(?:[…—,_;:，、…]|\.{3})$/.test(s)) return true;
  // Only flag CJK if the text is PREDOMINANTLY CJK (>60%) and doesn't end with sentence-ending punctuation.
  // Mixed CJK+EN (common in tech summaries) shouldn't be falsely flagged.
  const cjkCount = (s.match(/[\u4e00-\u9fff]/g) || []).length;
  if (cjkCount > 0 && cjkCount / s.length > 0.6 && !/[。！？\.!?]$/.test(s)) return true;
  // Trailing preposition/conjunction at a word break (likely mid-thought cut)
  if (/\b(a|an|the|in|on|at|to|for|of|and|or|but|via|per|by|from|with|not|is|are|was|were|has|had|when|if|as)\s*$/i.test(s)) return true;
  return false;
}

/** True if content is a session summary with temporal reference, not a reusable principle. */
function isTemporalSummary(text: string): boolean {
  const s = String(text || "");
  if (/最近|昨天|上周|今天|刚才|刚刚|上次|这次|ye?sterday|last\s+(week|month|night)|today|just\s+now|this\s+(morning|time)|previous\s+session/i.test(s)) return true;
  if (/\d+次缺失|\d+次|373次|第\d+次/i.test(s)) return true;
  return false;
}

/** True if content is a meta-instruction (telling LLM how to write), not actual domain knowledge. */
function isMetaInstruction(text: string): boolean {
  const s = String(text || "");
  // "Trigger+gain:" or "Rule/tradeoff:" followed only by template/placeholder (not actual domain content)
  if (/^(Trigger\+gain|Rule\/tradeoff):\s*(Prefer:\s*\.\.\.|avoid vague memory|keep reusable payoff|$)/i.test(s.trim())) return true;
  if (/^(Rule\/tradeoff|Principle|Guideline):\s*$/i.test(s.trim())) return true;
  return false;
}

/** Complete content to a word/sentence boundary within maxLen. No mid-word or mid-sentence cuts. */
function completeContent(text: string, maxLen: number): string {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  if (s.length <= maxLen) return s;
  // Try sentence boundary first
  const sentenceEnd = s.lastIndexOf("。", maxLen);
  if (sentenceEnd > maxLen * 0.6) return s.slice(0, sentenceEnd + 1);
  const period = s.lastIndexOf(". ", maxLen);
  if (period > maxLen * 0.6) return s.slice(0, period + 1);
  // Try word boundary
  const space = s.lastIndexOf(" ", maxLen);
  if (space > maxLen * 0.6) return s.slice(0, space);
  // Try Chinese phrase boundary
  const comma = Math.max(s.lastIndexOf("，", maxLen), s.lastIndexOf("、", maxLen));
  if (comma > maxLen * 0.6) return s.slice(0, comma + 1);
  return s.slice(0, maxLen);
}

/** Parse "L<N>::node_X" format. Returns {layer:number, nodeId:string} or null. */
function parseLayerNodeId(raw: string): { layer: number; nodeId: string } | null {
  const m = raw.match(/^L(\d+)::(.+)$/);
  return m ? { layer: parseInt(m[1], 10), nodeId: m[2] } : null;
}

function seedRandom(seed: string): () => number {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = ((hash << 5) - hash + seed.charCodeAt(i)) | 0;
  return () => { hash = (hash * 1103515245 + 12345) | 0; return (hash >>> 0) / 0xffffffff; };
}

function formatNodesForLLM(nodes: { id: string; layer: number; content: string; outgoingEdges: { toId: string; weight: number }[] }[]): string {
  const byLayer = new Map<number, typeof nodes>();
  for (const n of nodes) { const list = byLayer.get(n.layer) || []; list.push(n); byLayer.set(n.layer, list); }
  let out = "";
  for (let l = 0; l < Math.max(...byLayer.keys()) + 1; l++) {
    const ln = byLayer.get(l) || [];
    out += `\n=== Layer ${l} (${ln.length} nodes) ===\n`;
    for (const n of ln) {
      const ei = n.outgoingEdges.length > 0 ? ` [→ ${n.outgoingEdges.map(e => `${e.toId}(w:${e.weight.toFixed(2)})`).join(", ")}]` : " [output]";
      out += `${n.id}${ei}\n  content: ${n.content || "(empty)"}\n`;
    }
  }
  return out;
}

// ─── Extension Entry ─────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // Session-level state
  let currentTaskFamily: string | null = null;
  let currentActivatedIds: string[] = [];
  let currentActivationScores: Record<string, number> = {};
  let currentSelectedEdgeIds: string[] = [];
  let currentRawUserPrompt = "";
  let currentEffectivePrompt = "";
  let currentUserInjection = "";
  let currentContextAuditLogged = false;
  let currentProviderAuditLogged = false;
  let currentAssistantBuffer = "";
  let currentAssistantHighEntropy = "";
  let currentHighEntropyLogged = false;
  // Previous-turn state — used for forced semantic backward on the next user turn
  let lastTaskFamily: string | null = null;
  let lastActivatedIds: string[] = [];
  let lastSelectedEdgeIds: string[] = [];
  let lastRawUserPrompt = "";
  let lastEffectivePrompt = "";
  let lastAssistantHighEntropy = "";
  let lastBackwardState: Record<string, unknown> | null = null;

  const log = (msg: string) => {
    try { pi.appendEntry("textron-log", { msg, ts: new Date().toISOString() }); } catch {}
    broadcast({ type: "log", msg, ts: Date.now() });
  };

  // ── HTTP Server for live monitoring ────────────────────────────
  const SSE_CLIENTS = new Set<http.ServerResponse>();
  const PORT = parseInt(process.env.TEXTRON_MONITOR_PORT || "8766", 10);

  function broadcast(data: Record<string, unknown>) {
    const eventType = data.type || "message";
    const msg = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of SSE_CLIENTS) {
      try { res.write(msg); } catch { SSE_CLIENTS.delete(res); }
    }
  }

  const EVENTS_PATH = path.join(TEXTRON_HOME, "_events.jsonl");
  // Default is global for normal pi sessions; spawned workflows can set TEXTRON_STATE_FILE
  // to keep backward state scoped to a job/beat chain instead of racing other Pi sessions.
  const LAST_STATE_PATH = process.env.TEXTRON_STATE_FILE || path.join(TEXTRON_HOME, "_last_state.json");
  function recordMonitorEvent(data: Record<string, unknown>) {
    try {
      ensureDir(TEXTRON_HOME);
      fs.appendFileSync(EVENTS_PATH, JSON.stringify({ ...data, ts: new Date().toISOString() }) + "\n", "utf-8");
    } catch {}
  }
  function appendArtifactAudit(data: Record<string, unknown>) {
    const entry = { ...data, ts: new Date().toISOString() };
    recordMonitorEvent(entry);
    try { pi.appendEntry("textron-artifact-quarantine", entry); } catch {}
  }
  function recordPromptAudit(data: Record<string, unknown>) {
    const entry = { ...data, ts: new Date().toISOString() };
    recordMonitorEvent(entry);
    try { pi.appendEntry("textron-effective-prompt-audit", entry); } catch {}
  }
  function preview(text: unknown, max = 160): string {
    return String(text || "").replace(/\s+/g, " ").trim().slice(0, max);
  }
  function topScores(scores: Record<string, number>, limit = 5) {
    return Object.entries(scores)
      .filter(([k]) => k.startsWith("L"))
      .sort((a, b) => Number(b[1]) - Number(a[1]))
      .slice(0, limit)
      .map(([id, score]) => ({ id, score: Number(Number(score).toFixed(4)) }));
  }
  function topLayerNodes(nodes: { id: string; score: number }[], limit = 3) {
    return [...nodes]
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((n) => ({ id: n.id, score: Number(n.score.toFixed(4)) }));
  }
  function tokenSet(text: string): Set<string> {
    return new Set(String(text || "").toLowerCase().split(/[\s,，。！？、:：;；()\[\]{}<>"'`/\\|+=_-]+/).filter((w) => w.length > 2));
  }
  function overlapScore(a: string, b: string): number {
    const aa = tokenSet(a);
    const bb = tokenSet(b);
    if (!aa.size || !bb.size) return 0;
    let hit = 0;
    for (const w of aa) if (bb.has(w)) hit++;
    return Number((hit / Math.min(aa.size, bb.size)).toFixed(4));
  }
  function buildPathAudit(net: NonNullable<ReturnType<typeof loadNetwork>>, taskText: string, highEntropy: string, activatedIds: string[]) {
    const targetText = `${taskText || ""}\n${highEntropy || ""}`;
    const nodes = activatedIds.map((id) => {
      const parsed = parseLayerNodeId(id);
      const nodePath = parsed ? path.join(net.path, `layer_${parsed.layer}`, `${parsed.nodeId}.html`) : "";
      const name = parsed ? readNodeName(nodePath) : "";
      const content = parsed ? readNodeContent(nodePath) : "";
      return { id, name: preview(name, 80), contentPreview: preview(content, 120), overlap: overlapScore(targetText, `${name} ${content}`) };
    });
    const maxOverlap = nodes.reduce((m, n) => Math.max(m, n.overlap), 0);
    const label = maxOverlap >= 0.18 ? "high" : maxOverlap >= 0.07 ? "medium" : "low";
    return { label, maxOverlap, nodes };
  }
  function readMonitorEvents(limit = 60): Record<string, unknown>[] {
    try {
      if (!fs.existsSync(EVENTS_PATH)) return [];
      const lines = fs.readFileSync(EVENTS_PATH, "utf-8").trim().split("\n").filter(Boolean).slice(-limit);
      return lines.map((line) => JSON.parse(line)).filter((e) => e && typeof e === "object");
    } catch { return []; }
  }

  const server = http.createServer((req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    const urlPath = (req.url || "/").split("?")[0];

    if (urlPath === "/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      });
      res.write("data: {\"type\":\"connected\"}\n\n");
      SSE_CLIENTS.add(res);
      req.on("close", () => SSE_CLIENTS.delete(res));
      return;
    }

    if (urlPath === "/api/state") {
      const state = buildStateJSON();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(state));
      return;
    }

    // Serve live monitor HTML
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(getMonitorHTML());
  });

  // Auto-find available port: try PORT, then PORT+1..PORT+99
  const MAX_PORT_ATTEMPTS = 100;
  let actualPort = PORT;

  function tryListen(port: number, attempt: number) {
    function onError(err: NodeJS.ErrnoException) {
      if (err.code === "EADDRINUSE" && attempt < MAX_PORT_ATTEMPTS) {
        server.removeListener("error", onError);
        tryListen(port + 1, attempt + 1);
      } else {
        log(`Textron monitor failed: ${err.message}`);
        server.removeListener("error", onError);
      }
    }
    server.on("error", onError);
    server.listen(port, () => {
      server.removeListener("error", onError);
      actualPort = port;
      log(`Textron monitor: http://localhost:${port}`);
    });
  }
  tryListen(PORT, 0);

  dlog("INIT", "Textron extension loaded", { monitorPort: PORT });

  pi.on("session_shutdown", () => {
    server.close();
    // Clean up all SSE clients
    for (const res of SSE_CLIENTS) {
      try { res.end(); } catch {}
    }
    SSE_CLIENTS.clear();
  });

  function buildStateJSON() {
    const networks: Record<string, unknown> = {};
    for (const name of listNetworks()) {
      const net = loadNetwork(name);
      if (!net) continue;
      const nodes: { id: string; layer: number; name: string; content: string; context: string; outEdges: { toId: string; weight: number }[] }[] = [];
      for (let l = 0; l < net.hyperparams.layers.length; l++) {
        for (let n = 0; n < net.hyperparams.layers[l]; n++) {
          const nodePath = path.join(net.path, `layer_${l}`, `node_${n}.html`);
          const content = readNodeContent(nodePath);
          const outEdges = (net.weights.layer_connections[`${l}_to_${l + 1}`] || [])
            .filter((e) => e.from === `node_${n}`)
            .map((e) => ({ toId: e.to, weight: e.weight }));
          nodes.push({
            id: `node_${n}`,
            layer: l,
            name: readNodeName(nodePath),
            content,
            context: content,
            outEdges,
          });
        }
      }
      networks[name] = {
        layers: net.hyperparams.layers,
        threshold: net.hyperparams.threshold,
        learningRate: net.hyperparams.learningRate,
        updatedAt: net.hyperparams.updatedAt,
        weights: net.weights.layer_connections,
        nodes,
      };
    }
    const monitorEvents = readMonitorEvents(160);
    const latestBackward = lastBackwardState || [...monitorEvents].reverse().find((e) => String(e.action || "").startsWith("semantic_backward")) || null;
    // Child Pi processes (for example nbeat UI jobs) run their own Textron extension instance.
    // Their SSE broadcast goes to their own monitor port, but they all append to _events.jsonl.
    // Reconstruct the latest forward path from the shared event log so the main monitor reacts
    // to spawned-agent work instead of only this process' in-memory state.
    const latestForward = [...monitorEvents].reverse().find((e) =>
      e.action === "propagate_done" || (e.hook === "agent_end" && Array.isArray((e as any).activatedIds))
    ) as Record<string, any> | undefined;
    let effectiveTaskFamily = currentTaskFamily;
    let effectiveActivatedIds = currentActivatedIds;
    let effectiveSelectedEdgeIds = currentSelectedEdgeIds;
    let effectiveScores = currentActivationScores;
    if (latestForward) {
      effectiveTaskFamily = latestForward.taskFamily || effectiveTaskFamily;
      effectiveActivatedIds = (latestForward.selectedIds || latestForward.activatedIds || effectiveActivatedIds) as string[];
      effectiveSelectedEdgeIds = (latestForward.selectedEdgeIds || effectiveSelectedEdgeIds) as string[];
      const scoreMap: Record<string, number> = {};
      for (const layerInfo of latestForward.topByLayer || []) {
        const layer = Number(layerInfo.layer);
        for (const n of layerInfo.top || []) scoreMap[`L${layer}::${n.id}`] = Number(n.score || 0);
      }
      if (Object.keys(scoreMap).length > 0) effectiveScores = { ...effectiveScores, ...scoreMap };
    }
    return { currentTaskFamily: effectiveTaskFamily, currentActivatedIds: effectiveActivatedIds, currentActivationScores: effectiveScores, currentSelectedEdgeIds: effectiveSelectedEdgeIds, lastBackwardState: latestBackward, backwardEvents: monitorEvents, networks };
  }

  function getMonitorHTML(): string {
    try {
      // Resolve real path (follows symlinks from ~/.pi/agent/extensions/)
      const realDir = fs.realpathSync(__dirname);
      const monitorPath = path.join(realDir, "monitor.html");
      return fs.readFileSync(monitorPath, "utf-8");
    } catch {
      return "<h1>Textron Monitor</h1><p>monitor.html not found</p>";
    }
  }

  // ══════════════════════════════════════════════════════════════════
  // Auto-routing: keyword overlap between prompt and node contents
  // ══════════════════════════════════════════════════════════════════

  function autoRouteNetwork(prompt: string, networks: string[], explicitTaskFamily?: string): string | null {
    const candidates = networks.map((name) => {
      const net = loadNetwork(name);
      let content = "";
      if (net) {
        for (let l = 0; l < net.hyperparams.layers.length; l++) {
          for (let n = 0; n < net.hyperparams.layers[l]; n++) {
            const nodePath = path.join(net.path, `layer_${l}`, `node_${n}.html`);
            content += ` ${readNodeName(nodePath)} ${readNodeContent(nodePath)}`;
          }
        }
      }
      return { name, content };
    });
    const route = chooseTaskFamilyRoute({ prompt, candidates, explicitTaskFamily });
    recordMonitorEvent({ type: "trace", action: "route_policy_decision", promptPreview: preview(prompt, 180), explicitTaskFamily: explicitTaskFamily || "", taskFamily: route.taskFamily || "", reason: route.reason, score: Number(route.score.toFixed(4)) });
    return route.taskFamily;
  }

  function resolveConfigValue(raw: unknown): string {
    const value = String(raw || "");
    if (!value) return "";
    if (value.startsWith("$$")) return value.slice(1);
    if (value.startsWith("$!")) return value.slice(1);
    const exactEnv = value.match(/^\$\{?([A-Z0-9_]+)\}?$/i);
    if (exactEnv) return process.env[exactEnv[1]] || "";
    return value.replace(/\$\{([A-Z0-9_]+)\}|\$([A-Z0-9_]+)/gi, (_m, a, b) => process.env[a || b] || "");
  }

  async function resolveModelApiKey(ctx: any, model: any): Promise<{ apiKey: string; source: string }> {
    let apiKey = "";
    let source = "none";
    const provider = String(model?.provider || "");
    try {
      const reg = ctx?.modelRegistry;
      if (reg?.authStorage?.getApiKey && provider) {
        apiKey = (await reg.authStorage.getApiKey(provider)) || "";
        if (apiKey) return { apiKey, source: "authStorage" };
      }
    } catch {}

    apiKey = resolveConfigValue((model as any)?.apiKey || (model as any)?.provider?.apiKey);
    if (apiKey) return { apiKey, source: "model.apiKey" };

    try {
      const configPath = path.join(process.env.HOME || process.env.USERPROFILE || "~", ".pi", "agent", "models.json");
      const config = readJson<any>(configPath, {});
      const providerConfig = provider ? config?.providers?.[provider] : undefined;
      apiKey = resolveConfigValue(providerConfig?.apiKey);
      if (apiKey) return { apiKey, source: "models.json" };
    } catch {}

    const envCandidates = [
      process.env[`PI_${provider.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`],
      process.env.DEEPSEEK_API_KEY,
      process.env.OPENAI_API_KEY,
      process.env.ANTHROPIC_API_KEY,
      process.env.API_KEY,
    ];
    for (const c of envCandidates) {
      if (c) return { apiKey: c, source: "env" };
    }
    return { apiKey: "", source };
  }


  // ══════════════════════════════════════════════════════════════════
  // Blocking L0 scoring via LLM API (runs in before_agent_start, can't skip)
  // ══════════════════════════════════════════════════════════════════

  // Store model info captured from session_start (ctx.model may be undefined in before_agent_start)
  let _textronModel: any = null;
  pi.on("session_start", (_event, ctx) => {
    _textronModel = (ctx as any).model || null;
    recordMonitorEvent({
      type: "hook",
      hook: "session_start",
      modelId: _textronModel?.id || "MISSING",
      provider: _textronModel?.provider || "MISSING",
      hasBaseUrl: !!_textronModel?.baseUrl,
    });
  });

  async function scoreL0WithLLM(
    l0Nodes,
    userPrompt,
    ctx,
  ) {
    const model = (ctx as any).model || _textronModel;
    const l0StartedMs = Date.now();
    log(`Textron L0: model check — ctx.model: ${!!((ctx as any).model)}, _textronModel: ${!!_textronModel}, id: ${model?.id || 'MISSING'}, baseUrl: ${model?.baseUrl || 'MISSING'}`);
    recordMonitorEvent({
      type: "trace",
      action: "l0_score_start",
      modelId: model?.id || "MISSING",
      provider: model?.provider || "MISSING",
      hasBaseUrl: !!model?.baseUrl,
      promptChars: String(userPrompt || "").length,
      promptPreview: preview(userPrompt, 180),
      nodeCount: l0Nodes.length,
      nodes: l0Nodes.map((n) => ({ id: `L0::${n.id}`, name: preview(n.name || compressNodeName(n.content), 80), hasContent: !!n.content })),
    });
    if (!model?.id || !model?.baseUrl) {
      const scores = {};
      for (const n of l0Nodes) scores[`L0::${n.id}`] = 0.0;
      log("Textron: L0 scoring unavailable (no model provider), no activation");
      recordMonitorEvent({ type: "trace", action: "l0_score_unavailable", reason: "no_model_or_baseUrl", durationMs: Date.now() - l0StartedMs, scores: topScores(scores as Record<string, number>) });
      return scores;
    }

    const baseUrl = String(model.baseUrl).replace(/\/+$/, "");
    const endpoint = baseUrl.endsWith("/v1") ? `${baseUrl}/chat/completions` : `${baseUrl}/v1/chat/completions`;

    const { apiKey, source: apiKeySource } = await resolveModelApiKey(ctx, model);
    log(`Textron L0: model=${model.id} baseUrl=${model.baseUrl} provider=${model.provider} apiKey=${apiKeySource}`);

    const nodesList = l0Nodes
      .map((n) => `${n.id}: ${(n.name || compressNodeName(n.content) || "(empty)").slice(0, 80)}`)
      .join("\n");

    function normalizeScores(parsed: Record<string, unknown>) {
      const normalized: Record<string, number> = {};
      for (const n of l0Nodes) normalized[`L0::${n.id}`] = 0.0;
      for (const [key, val] of Object.entries(parsed || {})) {
        const num = Number(val);
        if (Number.isNaN(num)) continue;
        const k = key.startsWith("L0::") ? key : `L0::${key}`;
        if (k in normalized) normalized[k] = clamp(num, 0, 1);
      }
      return normalized;
    }

    function extractJsonObject(rawParts: string[]) {
      const raw = rawParts.filter(Boolean).join("\n").trim();
      if (!raw) throw new Error("Empty response content");
      const candidates: string[] = [];
      candidates.push(raw);
      const marker = raw.lastIndexOf("---JSON---");
      if (marker >= 0) candidates.push(raw.slice(marker + "---JSON---".length).trim());
      const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
      if (fence?.[1]) candidates.push(fence[1].trim());

      // Balanced brace extraction; robust when reasoning text surrounds JSON.
      for (let i = 0; i < raw.length; i++) {
        if (raw[i] !== "{") continue;
        let depth = 0;
        for (let j = i; j < raw.length; j++) {
          const ch = raw[j];
          if (ch === "{") depth++;
          else if (ch === "}") {
            depth--;
            if (depth === 0) {
              candidates.push(raw.slice(i, j + 1));
              break;
            }
          }
        }
      }
      // Prefer later/longer candidates; final answer usually appears last.
      candidates.sort((a, b) => a.length - b.length);
      let lastErr: unknown = null;
      for (let i = candidates.length - 1; i >= 0; i--) {
        try { return JSON.parse(candidates[i]); }
        catch (e) { lastErr = e; }
      }
      throw lastErr || new Error("No JSON object found");
    }

    const messages = [
      { role: "system", content: 'Return ONLY a valid JSON object. Score each Layer-0 node from 0.0 to 1.0 based ONLY on its compressed name relevance to the user task. Do not use long context. Keys must be L0::node_X. Example: {"L0::node_0":0.8,"L0::node_1":0.0}' },
      { role: "user", content: `Task: ${userPrompt.slice(0, 800)}\n\nNodes:\n${nodesList}` },
    ];

    function textify(x: unknown): string {
      if (typeof x === "string") return x;
      if (Array.isArray(x)) return x.map((p: any) => p?.text || p?.content || p?.value || "").join("\n");
      if (x && typeof x === "object") return JSON.stringify(x);
      return "";
    }

    async function callScorer(attempt: { jsonMode: boolean; label: string; maxParam?: "max_tokens" | "max_completion_tokens"; tokens?: number; temperature?: boolean; reasoningEffort?: boolean }) {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
      const requestBody: Record<string, unknown> = { model: model.id, messages };
      if (attempt.maxParam) requestBody[attempt.maxParam] = attempt.tokens || 4096;
      if (attempt.temperature) requestBody.temperature = 0;
      if (attempt.reasoningEffort) requestBody.reasoning_effort = "low";
      if (attempt.jsonMode) requestBody.response_format = { type: "json_object" };

      const res = await fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(requestBody),
        signal: AbortSignal.timeout(45000),
      });
      const rawBody = await res.text();
      let data;
      try { data = JSON.parse(rawBody); }
      catch { throw new Error(`Response not valid JSON: ${rawBody.slice(0, 240)}`); }
      if (!res.ok && !data?.choices?.[0]?.message) throw new Error(`HTTP ${res.status}: ${rawBody.slice(0, 240)}`);
      const msg = data?.choices?.[0]?.message || {};
      const parsed = extractJsonObject([textify(msg.content), textify(msg.reasoning_content), textify(msg.reasoning), textify(msg.refusal)]);
      return normalizeScores(parsed);
    }

    async function callResponsesScorer() {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
      const responsesEndpoint = baseUrl.endsWith("/v1") ? `${baseUrl}/responses` : `${baseUrl}/v1/responses`;
      const requestBody: Record<string, unknown> = {
        model: model.id,
        input: messages,
        max_output_tokens: 4096,
        reasoning: { effort: "low" },
        text: { format: { type: "json_object" } },
      };
      const res = await fetch(responsesEndpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(requestBody),
        signal: AbortSignal.timeout(45000),
      });
      const rawBody = await res.text();
      let data;
      try { data = JSON.parse(rawBody); }
      catch { throw new Error(`Responses API not JSON: ${rawBody.slice(0, 240)}`); }
      if (!res.ok) throw new Error(`Responses HTTP ${res.status}: ${rawBody.slice(0, 240)}`);
      const parts: string[] = [textify((data as any).output_text)];
      const out = (data as any).output;
      if (Array.isArray(out)) {
        for (const item of out) {
          parts.push(textify(item?.content));
          if (Array.isArray(item?.content)) for (const c of item.content) parts.push(textify(c?.text || c?.content));
        }
      }
      const parsed = extractJsonObject(parts);
      return normalizeScores(parsed);
    }

    async function callToolScorer() {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
      const properties: Record<string, unknown> = {};
      for (const n of l0Nodes) properties[`L0::${n.id}`] = { type: "number", minimum: 0, maximum: 1 };
      const requestBody: Record<string, unknown> = {
        model: model.id,
        messages,
        max_completion_tokens: 4096,
        tools: [{
          type: "function",
          function: {
            name: "score_nodes",
            description: "Return relevance scores for Textron Layer-0 nodes.",
            parameters: { type: "object", properties, required: Object.keys(properties), additionalProperties: false },
          },
        }],
        tool_choice: { type: "function", function: { name: "score_nodes" } },
      };
      const res = await fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(requestBody),
        signal: AbortSignal.timeout(45000),
      });
      const rawBody = await res.text();
      let data;
      try { data = JSON.parse(rawBody); }
      catch { throw new Error(`Tool response not JSON: ${rawBody.slice(0, 240)}`); }
      if (!res.ok && !data?.choices?.[0]?.message) throw new Error(`Tool HTTP ${res.status}: ${rawBody.slice(0, 240)}`);
      const calls = data?.choices?.[0]?.message?.tool_calls || [];
      const args = calls?.[0]?.function?.arguments;
      if (!args) throw new Error("No tool call arguments");
      return normalizeScores(typeof args === "string" ? JSON.parse(args) : args);
    }

    function collectUsefulStrings(obj: any, out: string[]) {
      if (!obj) return;
      if (typeof obj === "string") return;
      if (Array.isArray(obj)) { for (const x of obj) collectUsefulStrings(x, out); return; }
      if (typeof obj !== "object") return;
      for (const key of ["content", "text", "delta", "arguments", "output_text", "reasoning_content"]) {
        const v = obj[key];
        if (typeof v === "string") out.push(v);
        else if (Array.isArray(v) || (v && typeof v === "object")) collectUsefulStrings(v, out);
      }
      if (obj.function?.arguments && typeof obj.function.arguments === "string") out.push(obj.function.arguments);
    }

    async function readSseStrings(res: Response) {
      if (!res.body) throw new Error("No streaming body");
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      const parts: string[] = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const events = buf.split("\n\n");
        buf = events.pop() || "";
        for (const ev of events) {
          const dataLines = ev.split("\n").filter((line) => line.startsWith("data:"));
          for (const line of dataLines) {
            const payload = line.slice(5).trim();
            if (!payload || payload === "[DONE]") continue;
            try {
              const obj = JSON.parse(payload);
              collectUsefulStrings(obj, parts);
            } catch {
              parts.push(payload);
            }
          }
        }
      }
      if (buf.trim()) {
        for (const line of buf.split("\n")) {
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === "[DONE]") continue;
          try { collectUsefulStrings(JSON.parse(payload), parts); }
          catch { parts.push(payload); }
        }
      }
      return parts;
    }

    async function callStreamingChatScorer() {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
      const requestBody: Record<string, unknown> = {
        model: model.id,
        messages,
        stream: true,
        max_completion_tokens: 8192,
        reasoning_effort: "low",
      };
      const res = await fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(requestBody),
        signal: AbortSignal.timeout(60000),
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => "");
        throw new Error(`stream chat HTTP ${res.status}: ${txt.slice(0, 240)}`);
      }
      const parts = await readSseStrings(res as any);
      const parsed = extractJsonObject(parts);
      return normalizeScores(parsed);
    }

    async function callStreamingResponsesScorer() {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
      const responsesEndpoint = baseUrl.endsWith("/v1") ? `${baseUrl}/responses` : `${baseUrl}/v1/responses`;
      const requestBody: Record<string, unknown> = {
        model: model.id,
        input: messages,
        stream: true,
        max_output_tokens: 8192,
        reasoning: { effort: "low" },
        text: { format: { type: "json_object" } },
      };
      const res = await fetch(responsesEndpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(requestBody),
        signal: AbortSignal.timeout(60000),
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => "");
        throw new Error(`stream responses HTTP ${res.status}: ${txt.slice(0, 240)}`);
      }
      const parts = await readSseStrings(res as any);
      const parsed = extractJsonObject(parts);
      return normalizeScores(parsed);
    }

    const attempts = [
      { jsonMode: true, label: "json_mode/max_tokens/temp0", maxParam: "max_tokens" as const, tokens: 4096, temperature: true },
      { jsonMode: false, label: "plain/max_tokens/temp0", maxParam: "max_tokens" as const, tokens: 4096, temperature: true },
      { jsonMode: false, label: "plain/max_completion_tokens/reasoning_min", maxParam: "max_completion_tokens" as const, tokens: 8192, reasoningEffort: true },
      { jsonMode: false, label: "plain/max_completion_tokens", maxParam: "max_completion_tokens" as const, tokens: 8192 },
      { jsonMode: false, label: "plain/minimal" },
    ];
    const errors: string[] = [];
    for (const attempt of attempts) {
      try {
        const normalized = await callScorer(attempt);
        log(`Textron: L0 scored via LLM (${Object.keys(normalized).length} nodes, provider=${model.provider}, mode=${attempt.label})`);
        recordMonitorEvent({ type: "trace", action: "l0_score_done", status: "ok", mode: attempt.label, provider: model.provider, durationMs: Date.now() - l0StartedMs, nonzeroCount: Object.values(normalized).filter((v) => Number(v) > 0).length, topScores: topScores(normalized), allZero: Object.values(normalized).every((v) => Number(v) <= 0) });
        return normalized;
      } catch (e) {
        const err = `${attempt.label}: ${(e as Error).message}`;
        errors.push(err);
        recordMonitorEvent({ type: "trace", action: "l0_score_attempt_failed", mode: attempt.label, error: preview(err, 260), durationMs: Date.now() - l0StartedMs });
      }
    }

    try {
      const normalized = await callToolScorer();
      log(`Textron: L0 scored via LLM (${Object.keys(normalized).length} nodes, provider=${model.provider}, mode=tool_call)`);
      recordMonitorEvent({ type: "trace", action: "l0_score_done", status: "ok", mode: "tool_call", provider: model.provider, durationMs: Date.now() - l0StartedMs, nonzeroCount: Object.values(normalized).filter((v) => Number(v) > 0).length, topScores: topScores(normalized), allZero: Object.values(normalized).every((v) => Number(v) <= 0) });
      return normalized;
    } catch (e) {
      const err = `tool_call: ${(e as Error).message}`;
      errors.push(err);
      recordMonitorEvent({ type: "trace", action: "l0_score_attempt_failed", mode: "tool_call", error: preview(err, 260), durationMs: Date.now() - l0StartedMs });
    }

    try {
      const normalized = await callStreamingChatScorer();
      log(`Textron: L0 scored via LLM (${Object.keys(normalized).length} nodes, provider=${model.provider}, mode=stream_chat)`);
      recordMonitorEvent({ type: "trace", action: "l0_score_done", status: "ok", mode: "stream_chat", provider: model.provider, durationMs: Date.now() - l0StartedMs, nonzeroCount: Object.values(normalized).filter((v) => Number(v) > 0).length, topScores: topScores(normalized), allZero: Object.values(normalized).every((v) => Number(v) <= 0) });
      return normalized;
    } catch (e) {
      const err = `stream_chat: ${(e as Error).message}`;
      errors.push(err);
      recordMonitorEvent({ type: "trace", action: "l0_score_attempt_failed", mode: "stream_chat", error: preview(err, 260), durationMs: Date.now() - l0StartedMs });
    }

    try {
      const normalized = await callStreamingResponsesScorer();
      log(`Textron: L0 scored via LLM (${Object.keys(normalized).length} nodes, provider=${model.provider}, mode=stream_responses)`);
      recordMonitorEvent({ type: "trace", action: "l0_score_done", status: "ok", mode: "stream_responses", provider: model.provider, durationMs: Date.now() - l0StartedMs, nonzeroCount: Object.values(normalized).filter((v) => Number(v) > 0).length, topScores: topScores(normalized), allZero: Object.values(normalized).every((v) => Number(v) <= 0) });
      return normalized;
    } catch (e) {
      const err = `stream_responses: ${(e as Error).message}`;
      errors.push(err);
      recordMonitorEvent({ type: "trace", action: "l0_score_attempt_failed", mode: "stream_responses", error: preview(err, 260), durationMs: Date.now() - l0StartedMs });
    }

    try {
      const normalized = await callResponsesScorer();
      log(`Textron: L0 scored via LLM (${Object.keys(normalized).length} nodes, provider=${model.provider}, mode=responses_api)`);
      recordMonitorEvent({ type: "trace", action: "l0_score_done", status: "ok", mode: "responses_api", provider: model.provider, durationMs: Date.now() - l0StartedMs, nonzeroCount: Object.values(normalized).filter((v) => Number(v) > 0).length, topScores: topScores(normalized), allZero: Object.values(normalized).every((v) => Number(v) <= 0) });
      return normalized;
    } catch (e) {
      const err = `responses_api: ${(e as Error).message}`;
      errors.push(err);
      recordMonitorEvent({ type: "trace", action: "l0_score_attempt_failed", mode: "responses_api", error: preview(err, 260), durationMs: Date.now() - l0StartedMs });
    }

    log(`Textron: L0 scoring failed (${errors.join(" | ")}), no activation`);
    const zeroScores: Record<string, number> = {};
    for (const n of l0Nodes) zeroScores[`L0::${n.id}`] = 0.0;
    recordMonitorEvent({ type: "trace", action: "l0_score_done", status: "failed", durationMs: Date.now() - l0StartedMs, errorCount: errors.length, errors: errors.map((e) => preview(e, 260)), topScores: topScores(zeroScores), allZero: true });
    return zeroScores;
  }


  async function semanticBackwardLLM(
    net: NonNullable<ReturnType<typeof loadNetwork>>,
    previousTask: string,
    previousAssistantHighEntropy: string,
    currentUserMessage: string,
    activatedIds: string[],
    ctx: any,
  ): Promise<{ reward: number; rationale?: string; node_updates?: Record<string, string | { name?: string; content?: string; context?: string }>; add_nodes?: { layer: number; name?: string; content: string; context?: string }[] }> {
    const model = (ctx as any).model || _textronModel;
    if (!model?.id || !model?.baseUrl) return { reward: 0, rationale: "no model" };

    const baseUrl = String(model.baseUrl).replace(/\/+$/, "");
    const chatEndpoint = baseUrl.endsWith("/v1") ? `${baseUrl}/chat/completions` : `${baseUrl}/v1/chat/completions`;
    const responsesEndpoint = baseUrl.endsWith("/v1") ? `${baseUrl}/responses` : `${baseUrl}/v1/responses`;

    const { apiKey } = await resolveModelApiKey(ctx, model);

    const pathNodes = activatedIds.map((id) => {
      const parsed = parseLayerNodeId(id);
      const nodePath = parsed ? path.join(net.path, `layer_${parsed.layer}`, `${parsed.nodeId}.html`) : "";
      const content = parsed ? readNodeContent(nodePath) : "";
      const name = parsed ? readNodeName(nodePath) : "";
      return { id, name, content };
    });
    const pathAudit = buildPathAudit(net, previousTask, previousAssistantHighEntropy, activatedIds);
    const sbStartedMs = Date.now();
    recordMonitorEvent({
      type: "trace",
      action: "semantic_backward_llm_start",
      taskFamily: path.basename(net.path),
      modelId: model?.id || "MISSING",
      provider: model?.provider || "MISSING",
      hasHighEntropy: !!previousAssistantHighEntropy,
      previousTaskChars: previousTask.length,
      currentMessageChars: currentUserMessage.length,
      activatedIds,
      pathAudit,
    });

    const previousCrystal = parseHighEntropyCrystal(previousAssistantHighEntropy ? `<HighEntropy>${previousAssistantHighEntropy}</HighEntropy>` : "");
    const schemaHint = '{"reward":0.0,"rationale":"≤80 chars","node_updates":{"L0::node_0":{"name":"<48 char entropy crystal","content":"<120 char high-entropy signal"}},"add_nodes":[{"layer":1,"name":"<48 char entropy crystal","content":"<120 char high-entropy signal"}]}';
    const messages = [
      { role: "system", content: `You are Textron semantic backward pass. NO reasoning, NO markdown fences, NO surrounding text — output ONLY the raw JSON object on a single line. Format: ${schemaHint}. reward is continuous -1.0..1.0 for how useful the selected path was for the previous task, inferred from the current user message; use 0 when evidence is unclear.

CRITICAL RULES:
1. ORTHOGONALITY: each node_update must be CONCEPTUALLY DISTINCT from existing same-layer nodes (shown below). Never produce content that overlaps >50% with an existing node. If all good slots are filled, use add_nodes to create a truly new concept.
2. FAILURE CRYSTALLIZATION: if current user message indicates failure/wrong, distill the CORRECTION as a reusable "avoid X, do Y instead" principle. This is THE most valuable node type.
3. SUCCESS CRYSTALLIZATION: if task succeeded, distill WHY — the specific decision/pattern/insight that worked. Not "task completed OK", but the reusable mechanism.
4. NO TEMPLATE NODES: never output "Rule/tradeoff: Prefer: ..." or "Trigger+gain: ..." — these are meta-instructions, not knowledge.
5. NO SESSION SUMMARIES: drop temporal references (最近/yesterday/last time), specific counts, timestamps. Extract the timeless principle.
6. LAYER DIFFERENTIATION: L0=compact domain signal, L1=causal mechanism/tradeoff, L2=concrete tactic/implementation. Content must genuinely differ between layers, not just be the same text at different lengths.
7. Ensure content is COMPLETE — no mid-sentence truncation.
8. If selected path nodes are wrong-topic or already hold good unrelated knowledge, DO NOT overwrite them; emit add_nodes for the new concept instead.
9. Prefer add_nodes when novelty is high: different domain/mechanism from all selected nodes, or update would merely append unrelated content to a good node.
10. Every candidate MUST have both name and content. Follow skill-node style: name = shortest distinctive symbolic compression of content; content = high-entropy experience atom from the turn — reusable insight that would change future behavior/context selection in similar tasks, such as constraints, failure corrections, causal mechanisms, decision boundaries, validation signals, or strategy patterns. Never copy TextronSkill prior text into learned content.` },
      { role: "user", content: `Previous user task:\n${previousTask.slice(0, 2000)}\n\nPrevious assistant HighEntropy training packet:\n${previousCrystal.ok ? `Name: ${previousCrystal.name}\nContent: ${previousCrystal.content}` : `(invalid/missing: ${previousCrystal.reason || "none"})`}\n\nEXISTING nodes in same layers (DO NOT duplicate — produce ORTHOGONAL content):\n${[...Array(net.hyperparams.layers.length)].map((_, l) => {
        const existing: string[] = [];
        for (let n = 0; n < net.hyperparams.layers[l]; n++) {
          const np = path.join(net.path, `layer_${l}`, `node_${n}.html`);
          const c = readNodeContent(np);
          if (c) existing.push(`  L${l}::node_${n}: ${readNodeName(np) || compressNodeName(c)} — ${c.slice(0, 80)}`);
        }
        return existing.length ? `Layer ${l} existing nodes:\n${existing.join("\n")}` : `Layer ${l}: (all empty)`;
      }).join("\n\n")}\n\nSelected path nodes to update:\n${pathNodes.map(n => `${n.id}: name=${n.name || "(empty)"}; context=${n.content || "(empty)"}`).join("\n")}\n\nCurrent user message / feedback:\n${currentUserMessage.slice(0, 3000)}\n\nInstruction: distill reusable experience into skill-node objects. Each returned node must include name and content. Name is the compressed/symbolized entropy crystal of content; content is the high-entropy lesson/pattern/prohibition/method from the dialogue. Return node_updates for selected path nodes only when they are relevant or artifact-repair targets; otherwise use add_nodes. If previous task FAILED, encode the correction as "avoid X; prefer Y". If SUCCEEDED, encode the winning mechanism. Keep content ≤120 chars and COMPLETE.` },
    ];

    function clampReward(v: unknown) { return clamp(Number(v) || 0, -1, 1); }
    function normalize(obj: any) {
      const out: { reward: number; rationale?: string; node_updates?: Record<string, string | { name?: string; content?: string; context?: string }>; add_nodes?: { layer: number; name?: string; content: string; context?: string }[] } = {
        reward: clampReward(obj?.reward),
      };
      if (obj?.rationale) out.rationale = String(obj.rationale).slice(0, 120);
      if (obj?.node_updates && typeof obj.node_updates === "object") {
        out.node_updates = {};
        for (const [k, v] of Object.entries(obj.node_updates)) {
          // Accept any valid layer-qualified node ID that exists in the network.
          // The LLM may choose different nodes than the activated path — trust its judgment.
          const parsed = parseLayerNodeId(k);
          if (!parsed) continue;
          const nodeExists = parsed.layer < net.hyperparams.layers.length &&
            parseInt(parsed.nodeId.replace('node_', ''), 10) < net.hyperparams.layers[parsed.layer];
          if (!nodeExists) continue;
          if (typeof v === "string" && v.trim()) {
            const content = completeContent(v.trim(), 120);
            const name = compressNodeName(content);
            if (content && name) out.node_updates[k] = { content, name };
          } else if (v && typeof v === "object") {
            const vv = v as any;
            const content = completeContent(String(vv.content || vv.context || "").trim(), 120);
            const name = completeContent(String(vv.name || compressNodeName(content)).trim(), 64);
            if (content && name && !isNgramFragmentContent(content) && !isNgramFragmentContent(name)) out.node_updates[k] = { name, content };
          }
        }
      }
      if (Array.isArray(obj?.add_nodes)) {
        out.add_nodes = [];
        for (const n of obj.add_nodes.slice(0, 2)) {  // allow limited growth; gates below decide final promotion
          const layer = Number(n?.layer);
          const content = completeContent(String(n?.content || n?.context || "").trim(), 120);
          const name = completeContent(String(n?.name || compressNodeName(content)).trim(), 64);
          if (Number.isInteger(layer) && layer >= 0 && layer < net.hyperparams.layers.length && content && name && !isNgramFragmentContent(content) && !isNgramFragmentContent(name)) out.add_nodes.push({ layer, name, content });
        }
      }
      return out;
    }
    function extract(rawParts: string[]) {
      const raw = rawParts.filter(Boolean).join("\n").trim();
      if (!raw) throw new Error("empty semantic backward response");

      const candidates: string[] = [];
      function addCandidate(s: string | undefined) {
        const c = String(s || "").trim();
        if (c && !candidates.includes(c)) candidates.push(c);
      }
      addCandidate(raw);
      const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
      addCandidate(fence?.[1]);

      const balanced: string[] = [];
      for (let i = 0; i < raw.length; i++) {
        if (raw[i] !== "{") continue;
        let d = 0;
        for (let j = i; j < raw.length; j++) {
          if (raw[j] === "{") d++;
          else if (raw[j] === "}" && --d === 0) { balanced.push(raw.slice(i, j + 1)); break; }
        }
      }
      for (const c of balanced.sort((a, b) => b.length - a.length)) addCandidate(c);

      let fallback: ReturnType<typeof normalize> | null = null;
      for (const candidate of candidates) {
        try {
          const parsed = JSON.parse(candidate);
          const normalized = normalize(parsed);
          const hasBackwardShape = Object.prototype.hasOwnProperty.call(parsed, "reward") ||
            Object.prototype.hasOwnProperty.call(parsed, "node_updates") ||
            Object.prototype.hasOwnProperty.call(parsed, "add_nodes");
          if (hasBackwardShape) return normalized;
          fallback ||= normalized;
        } catch {}
      }
      if (fallback) return fallback;
      throw new Error("no JSON object in semantic backward response");
    }
    function collect(obj: any, out: string[]) {
      if (!obj) return;
      if (typeof obj === "string") { out.push(obj); return; }
      if (Array.isArray(obj)) { for (const x of obj) collect(x, out); return; }
      if (typeof obj !== "object") return;
      for (const key of ["content", "text", "delta", "arguments", "output_text", "reasoning_content"]) collect(obj[key], out);
      if (obj.function?.arguments) collect(obj.function.arguments, out);
    }
    async function readSse(res: any) {
      const reader = res.body?.getReader();
      if (!reader) throw new Error("no stream body");
      const dec = new TextDecoder();
      let buf = "";
      const parts: string[] = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const events = buf.split("\n\n");
        buf = events.pop() || "";
        for (const ev of events) {
          for (const line of ev.split("\n")) {
            if (!line.startsWith("data:")) continue;
            const payload = line.slice(5).trim();
            if (!payload || payload === "[DONE]") continue;
            try { collect(JSON.parse(payload), parts); } catch { parts.push(payload); }
          }
        }
      }
      return parts;
    }
    async function callChat(stream: boolean) {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
      // No reason_effort (triggers 8K+ reasoning chars in deepseek → timeout).
      // No response_format json_object (deepseek non-standard behavior can break parsing).
      // Plain text + system prompt "ONLY JSON" is faster and more reliable.
      const body: Record<string, unknown> = { model: model.id, messages, stream, max_completion_tokens: 1024 };
      const res = await fetch(chatEndpoint, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(60000) });
      if (stream) {
        if (!res.ok) throw new Error(`chat stream HTTP ${res.status}: ${(await res.text().catch(() => "")).slice(0, 160)}`);
        return extract(await readSse(res as any));
      }
      const txt = await res.text();
      const data = JSON.parse(txt);
      if (!res.ok && !data?.choices?.[0]?.message) throw new Error(`chat HTTP ${res.status}: ${txt.slice(0, 160)}`);
      const msg = data?.choices?.[0]?.message || {};
      const rawContent = String(msg.content || "");
      const rawReasoning = String(msg.reasoning_content || "");
      // IMPORTANT: only parse rawContent, NOT reasoning. Reasoning may contain
      // template JSON fragments (e.g. {"reward":0}) that would be picked up by
      // the balanced-brace extractor instead of the actual response.
      // ── DIAGNOSTIC: compare direct JSON.parse vs extract() ──
      let directParseOk = false; let directReward = 0; let directKeys: string[] = []; let directParseErr = "";
      try {
        const dp = JSON.parse(rawContent);
        directParseOk = true; directReward = Number(dp.reward) || 0;
        directKeys = Object.keys(dp.node_updates || {});
      } catch(e) { directParseErr = (e as Error).message; }
      const result = extract([rawContent]);
      // DEBUG: log raw LLM response and parsed result for diagnosis
      recordMonitorEvent({
        type: "debug",
        action: "semantic_backward_llm_raw_response",
        taskFamily: path.basename(net.path),
        mode: stream ? "chat_stream" : "chat_json",
        rawContentChars: rawContent.length,
        rawContent: rawContent.slice(0, 2000),
        rawReasoningChars: rawReasoning.length,
        rawReasoning: rawReasoning.slice(0, 800),
        parsedReward: result.reward,
        parsedRationale: result.rationale || "",
        parsedNodeUpdateKeys: Object.keys(result.node_updates || {}),
        parsedAddNodeCount: (result.add_nodes || []).length,
        diagDirectParseOk: directParseOk,
        diagDirectReward: directReward,
        diagDirectKeys: directKeys,
        diagDirectParseErr: directParseErr,
        systemPromptPreview: preview(messages[0].content, 400),
        userPromptPreview: preview(messages[1].content, 600),
      });
      return result;
    }
    async function callResponsesStream() {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
      const body = { model: model.id, input: messages, stream: true, max_output_tokens: 4096, reasoning: { effort: "low" }, text: { format: { type: "json_object" } } };
      const res = await fetch(responsesEndpoint, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(60000) });
      if (!res.ok) throw new Error(`responses stream HTTP ${res.status}: ${(await res.text().catch(() => "")).slice(0, 160)}`);
      const parts = await readSse(res as any);
      const result = extract(parts);
      recordMonitorEvent({
        type: "debug",
        action: "semantic_backward_llm_raw_response",
        taskFamily: path.basename(net.path),
        mode: "responses_stream",
        rawPartsCount: parts.length,
        rawContent: parts.join("\n").slice(0, 2000),
        parsedReward: result.reward,
        parsedRationale: result.rationale || "",
        parsedNodeUpdateKeys: Object.keys(result.node_updates || {}),
        parsedAddNodeCount: (result.add_nodes || []).length,
      });
      return result;
    }

    const errors: string[] = [];
    for (const [label, fn] of [["chat_json", () => callChat(false)], ["chat_stream", () => callChat(true)], ["responses_stream", callResponsesStream]] as const) {
      try {
        const result = await fn();
        log(`Textron semantic backward LLM ok (${label}, reward=${result.reward.toFixed(3)})`);
        recordMonitorEvent({
          type: "trace",
          action: "semantic_backward_llm_done",
          status: "ok",
          taskFamily: path.basename(net.path),
          mode: label,
          reward: result.reward,
          rationale: result.rationale || "",
          nodeUpdateIds: Object.keys(result.node_updates || {}),
          addNodeCount: (result.add_nodes || []).length,
          pathAudit,
          durationMs: Date.now() - sbStartedMs,
        });
        return result;
      } catch (e) {
        const err = `${label}: ${(e as Error).message}`;
        errors.push(err);
        recordMonitorEvent({ type: "trace", action: "semantic_backward_llm_attempt_failed", taskFamily: path.basename(net.path), mode: label, error: preview(err, 300), durationMs: Date.now() - sbStartedMs });
      }
    }
    log(`Textron semantic backward LLM failed (${errors.join(" | ")})`);
    recordMonitorEvent({ type: "trace", action: "semantic_backward_llm_done", status: "failed", taskFamily: path.basename(net.path), errors: errors.map((e) => preview(e, 300)), pathAudit, durationMs: Date.now() - sbStartedMs });
    return { reward: 0, rationale: "semantic backward failed" };
  }

  function buildHighEntropyFallbackNodeUpdate(
    previousAssistantHighEntropy: string,
    activatedIds: string[],
  ): Record<string, { name: string; content: string }> | undefined {
    const crystal = parseHighEntropyCrystal(previousAssistantHighEntropy ? `<HighEntropy>${previousAssistantHighEntropy}</HighEntropy>` : "");
    const clean = (crystal.ok ? crystal.content : previousAssistantHighEntropy).replace(/\s+/g, " ").trim();
    if (!clean || isNgramFragmentContent(clean)) return undefined;

    const parsedPath = activatedIds
      .map((id) => ({ id, parsed: parseLayerNodeId(id) }))
      .filter((x) => x.parsed !== null) as { id: string; parsed: { layer: number; nodeId: string } }[];
    if (parsedPath.length === 0) return undefined;

    // Extract differentiated facets from HighEntropy instead of same-string truncation.
    // L0: compact entropy symbol / abstract domain signal
    // L1: causal/tradeoff relationship — why it matters
    // L2: concrete action/tactic — how to apply it
    function extractFacet(text: string, layer: number): string {
      const s = text.trim();
      // Helper: extract first N complete sentences (or all up to maxLen)
      function firstSentences(t: string, maxLen: number): string {
        if (t.length <= maxLen) return t;
        // Try cutting at first sentence boundary within maxLen
        const ends = [t.indexOf("。", 0), t.indexOf(". ", 0), t.indexOf("! ", 0), t.indexOf("? ", 0)]
          .filter(i => i > 0 && i < maxLen);
        if (ends.length > 0) {
          const cut = Math.max(...ends);
          return t.slice(0, cut + (t[cut] === "。" || t[cut] === "." || t[cut] === "!" || t[cut] === "?" ? 1 : 0)).trim();
        }
        return completeContent(t, maxLen);
      }
      if (layer === 0) {
        // L0: extract key domain words / trigger signal (≤48 chars, complete)
        const words = s.split(/[\s,，。！？、:：;；]+/).filter(w => w.length > 2 && !/^(the|and|for|with|from|that|this|when|then|also|just|very|each|some|\d+)$/i.test(w));
        const key = words.slice(0, 4).join(" ");
        return completeContent(key || s, 48);
      } else if (layer === 1) {
        // L1: extract causal/tradeoff signal (≤100 chars)
        const tradeoffMatch = s.match(/([^。.!?]{0,100}(?:→|->|=>|vs|权衡|取舍|因为|所以|avoid|prefer|should|must)[^。.!?]{0,60})/i);
        return tradeoffMatch
          ? completeContent(tradeoffMatch[1].trim(), 100)
          : firstSentences(s, 100);
      } else {
        // L2: extract concrete tactic/action (≤120 chars, complete sentence)
        const tacticMatch = s.match(/([^。.!?]{0,120}(?:use|set|apply|run|call|configure|replace|switch|check|add|fix|patch|使用|设置|调用|替换|修复|添加|检查|配置)[^。.!?]{0,80})/i);
        return tacticMatch
          ? completeContent(tacticMatch[1].trim(), 120)
          : firstSentences(s, 120);
      }
    }

    parsedPath.sort((a, b) => a.parsed.layer - b.parsed.layer);
    const updates: Record<string, { name: string; content: string }> = {};
    for (const p of parsedPath) {
      const facet = extractFacet(clean, p.parsed.layer);
      if (!facet || isNgramFragmentContent(facet)) continue;
      const name = p.parsed.layer === 0 && crystal.ok ? crystal.name : compressNodeName(facet);
      updates[p.id] = { name: completeContent(name, 64), content: facet };
    }
    return Object.keys(updates).length > 0 ? updates : undefined;
  }

  function applySemanticNodeUpdates(net: NonNullable<ReturnType<typeof loadNetwork>>, updates: Record<string, string | { name?: string; content?: string; context?: string }> | undefined, onLog: (msg: string) => void) {
    const result: {
      updated: number;
      skipped: number;
      skipReasons: string[];
      changedNodes: { id: string; layer: number; nodeId: string; oldName: string; newName: string; oldContent: string; newContent: string }[];
    } = { updated: 0, skipped: 0, skipReasons: [], changedNodes: [] };
    if (!updates) return result;

    for (const [id, update] of Object.entries(updates)) {
      const parsed = parseLayerNodeId(id);
      if (!parsed) {
        result.skipped++;
        result.skipReasons.push(`${id}:bad_node_id`);
        continue;
      }
      const nodePath = path.join(net.path, `layer_${parsed.layer}`, `${parsed.nodeId}.html`);
      const oldContent = readNodeContent(nodePath);
      const oldName = readNodeName(nodePath);
      const oldIsArtifact = isNgramFragmentContent(oldContent);
      const content = typeof update === "string"
        ? update
        : String(update.content || update.context || oldContent || "").trim();
      const validation = validateKnowledgeCrystal(content, parsed.layer);
      if (!validation.ok) {
        result.skipped++;
        result.skipReasons.push(`${id}:${validation.reason}`);
        onLog(`Textron semantic backward: skipped node update ${id} (${validation.reason})`);
        continue;
      }

      const similar = oldIsArtifact
        ? null
        : findSimilarKnowledgeNode(net, compressNodeName(validation.content), validation.content, 0.24, parsed.layer, parsed.nodeId);
      if (similar) {
        const similarId = `L${similar.layer}::${similar.nodeId}`;
        const similarPath = path.join(net.path, `layer_${similar.layer}`, `${similar.nodeId}.html`);
        const similarOldContent = readNodeContent(similarPath);
        const similarOldName = readNodeName(similarPath);
        updateExistingNodeByPolicy(net, similar.layer, similar.nodeId, compressNodeName(validation.content), validation.content, onLog);
        result.changedNodes.push({
          id: similarId,
          layer: similar.layer,
          nodeId: similar.nodeId,
          oldName: preview(similarOldName, 100),
          newName: preview(readNodeName(similarPath), 100),
          oldContent: preview(similarOldContent, 220),
          newContent: preview(readNodeContent(similarPath), 220),
        });
        result.updated++;
        onLog(`Textron semantic backward: merged duplicate update ${id} into ${similarId} (${(similar.score*100).toFixed(0)}%)`);
        continue;
      }

      const name = typeof update === "string"
        ? compressNodeName(update)
        : String(update.name || oldName || compressNodeName(validation.content)).trim();
      const edgeKey = `${parsed.layer}_to_${parsed.layer + 1}`;
      const outEdges = (net.weights.layer_connections[edgeKey] || [])
        .filter((e) => e.from === parsed.nodeId)
        .map((e) => ({ toId: e.to, weight: e.weight }));
      const newContent = validation.content.slice(0, 120);
      const mergedContent = oldIsArtifact ? completeContent(newContent, 120) : mergeContent(oldContent, newContent);
      if (oldContent && mergedContent !== newContent) {
        onLog(`Textron semantic backward: merged node ${id} (old=${oldContent.length}c new=${newContent.length}c → ${mergedContent.length}c)`);
      }
      const mergedName = compressNodeName(mergedContent).slice(0, 64);
      writeNodeHtml(nodePath, parsed.layer, parsed.nodeId, mergedContent, outEdges, mergedName);
      result.changedNodes.push({
        id,
        layer: parsed.layer,
        nodeId: parsed.nodeId,
        oldName: preview(oldName, 100),
        newName: preview(mergedName, 100),
        oldContent: preview(oldContent, 220),
        newContent: preview(mergedContent, 220),
      });
      if (oldIsArtifact) {
        recordArtifactEvent({
          type: "update",
          action: "node_artifact_repaired_by_backward",
          taskFamily: path.basename(net.path),
          nodeId: id,
          oldContent: preview(oldContent, 180),
          newContent: preview(mergedContent, 180),
        });
      }
      result.updated++;
    }
    if (result.updated > 0) {
      onLog(`Textron semantic backward: ${result.updated} selected node content update(s)`);
      for (const ch of result.changedNodes.slice(0, 8)) {
        onLog(`Textron semantic backward node ${ch.id}: "${ch.oldContent}" -> "${ch.newContent}"`);
      }
    }
    return result;
  }

  async function forcedSemanticBackward(
    taskFamily: string,
    previousTask: string,
    previousAssistantHighEntropy: string,
    currentUserMessage: string,
    activatedIds: string[],
    selectedEdgeIds: string[],
    ctx: any,
  ) {
    const startedMs = Date.now();
    const startedAt = new Date(startedMs).toISOString();
    const net = loadNetwork(taskFamily);
    if (!net) return null;
    const pathAudit = buildPathAudit(net, previousTask, previousAssistantHighEntropy, activatedIds);
    let result = await semanticBackwardLLM(net, previousTask, previousAssistantHighEntropy, currentUserMessage, activatedIds, ctx);
    // If all selected nodes are wrong-topic, avoid overwriting unrelated useful memory.
    // Do NOT force capacity growth; add_nodes now means merge/fill/replace under frozen-shape gates.
    const shouldPreferAddNode = pathAudit.label === "low" || /新增|add[_ -]?nodes?|new node|wrong-topic|跑题|偏题|不触发|覆盖|容量|novel/i.test(currentUserMessage);
    if (shouldPreferAddNode) {
      const originalUpdateIds = Object.keys(result.node_updates || {});
      const repairOnlyUpdates: typeof result.node_updates = {};
      for (const [id, update] of Object.entries(result.node_updates || {})) {
        const parsed = parseLayerNodeId(id);
        const nodePath = parsed ? path.join(net.path, `layer_${parsed.layer}`, `${parsed.nodeId}.html`) : "";
        const oldContent = parsed ? readNodeContent(nodePath) : "";
        if (isNgramFragmentContent(oldContent)) repairOnlyUpdates[id] = update;
      }
      if (originalUpdateIds.length !== Object.keys(repairOnlyUpdates).length) {
        result = { ...result, node_updates: repairOnlyUpdates };
        recordMonitorEvent({ type: "trace", action: "semantic_node_updates_suppressed_for_add_candidate", taskFamily, reason: pathAudit.label === "low" ? "low_path_overlap" : "user_requested_new_concept", suppressedIds: originalUpdateIds.filter((id) => !Object.prototype.hasOwnProperty.call(repairOnlyUpdates, id)), preservedArtifactRepairIds: Object.keys(repairOnlyUpdates) });
      }
    }
    if (shouldPreferAddNode && previousAssistantHighEntropy) {
      const existingAdd = result.add_nodes || [];
      if (existingAdd.length === 0) {
        const targetLayer = activatedIds.map(parseLayerNodeId).filter(Boolean).reduce((m, p) => Math.max(m, (p as { layer: number; nodeId: string }).layer), 0);
        const crystal = parseHighEntropyCrystal(previousAssistantHighEntropy ? `<HighEntropy>${previousAssistantHighEntropy}</HighEntropy>` : "");
        const synthesizedContent = crystal.ok ? crystal.content : completeContent(previousAssistantHighEntropy, 120);
        const synthesizedName = crystal.ok ? crystal.name : compressNodeName(synthesizedContent);
        if (!synthesizedContent || isNgramFragmentContent(synthesizedContent)) {
          recordMonitorEvent({ type: "trace", action: "semantic_add_node_synthesize_skip", taskFamily, reason: crystal.reason || "invalid_highentropy", targetLayer, highEntropyPreview: preview(previousAssistantHighEntropy, 180) });
        } else result = {
          ...result,
          add_nodes: [{
            layer: targetLayer,
            name: synthesizedName,
            content: synthesizedContent,
          }],
        };
        recordMonitorEvent({ type: "trace", action: "semantic_add_node_synthesized", taskFamily, reason: pathAudit.label === "low" ? "low_path_overlap" : "user_requested_new_concept", targetLayer, contentPreview: preview(previousAssistantHighEntropy, 180) });
      }
    }
    // Default tiny positive reward only when a real selected edge path exists.
    // No-edge turns must not reinforce incomplete/bad L0-only paths. Negative
    // feedback or wrong-topic paths get explicit negative credit assignment.
    const baseReward = Math.abs(result.reward) < 0.001 ? (selectedEdgeIds.length > 0 ? 0.02 : 0) : result.reward;
    const credit = assignEdgeCredit({
      selectedEdgeIds,
      baseReward,
      feedbackText: currentUserMessage,
      pathAuditLabel: pathAudit.label as "high" | "medium" | "low",
    });
    const effectiveReward = credit.reward;
    if (credit.reason !== "normal") {
      recordMonitorEvent({ type: "trace", action: "semantic_negative_credit", taskFamily, reason: credit.reason, baseReward, effectiveReward, selectedEdgeIds });
    }
    const edgeUpdate = autoBackward(net, activatedIds, effectiveReward, log, selectedEdgeIds, credit.edgeRewards);
    let nodeUpdate = applySemanticNodeUpdates(net, result.node_updates, log);
    recordMonitorEvent({ type: "trace", action: "semantic_node_update_apply", taskFamily, requestedIds: Object.keys(result.node_updates || {}), updated: nodeUpdate.updated, skipped: nodeUpdate.skipped, skipReasons: nodeUpdate.skipReasons.slice(0, 8), changedNodes: nodeUpdate.changedNodes });
    let highEntropyFallbackNode = "";
    if (nodeUpdate.updated === 0 && previousAssistantHighEntropy) {
      const fallbackUpdates = buildHighEntropyFallbackNodeUpdate(previousAssistantHighEntropy, activatedIds);
      if (fallbackUpdates) {
        const fallbackNode = Object.keys(fallbackUpdates)[0] || "";
        const fallbackUpdate = applySemanticNodeUpdates(net, fallbackUpdates, log);
        nodeUpdate.updated += fallbackUpdate.updated;
        nodeUpdate.skipped += fallbackUpdate.skipped;
        nodeUpdate.skipReasons.push(...fallbackUpdate.skipReasons.map((r) => `fallback:${r}`));
        nodeUpdate.changedNodes.push(...fallbackUpdate.changedNodes.map((ch) => ({ ...ch, id: `fallback:${ch.id}` })) );
        recordMonitorEvent({ type: "trace", action: "highentropy_fallback_apply", taskFamily, targetNode: fallbackNode, updated: fallbackUpdate.updated, skipped: fallbackUpdate.skipped, skipReasons: fallbackUpdate.skipReasons.slice(0, 8), changedNodes: fallbackUpdate.changedNodes, highEntropyPreview: preview(previousAssistantHighEntropy, 180) });
        if (fallbackUpdate.updated > 0) {
          highEntropyFallbackNode = fallbackNode;
          log(`Textron semantic backward: HighEntropy fallback updated ${fallbackNode}`);
        }
      } else {
        recordMonitorEvent({ type: "trace", action: "highentropy_fallback_skip", taskFamily, reason: "no_activated_path_or_empty_highentropy", activatedIds, hasHighEntropy: !!previousAssistantHighEntropy });
      }
    }
    let added = 0;
    let merged = 0;
    let addSkipped = 0;
    const addSkipReasons: string[] = [];
    for (const node of result.add_nodes || []) {
      const validation = validateKnowledgeCrystal(node.content, node.layer);
      if (!validation.ok) {
        addSkipped++;
        addSkipReasons.push(`L${node.layer}:${validation.reason}`);
        log(`Textron semantic backward: skipped add_node L${node.layer} (${validation.reason})`);
        continue;
      }
      const targetLayer = chooseExpansionLayer(net, node.layer);
      const nodeName = node.name || compressNodeName(validation.content);
      const similar = findSimilarKnowledgeNode(net, nodeName, validation.content, 0.24, targetLayer);
      if (similar) {
        dlog("GATE", `semantic backward: merged similar add_node (${nodeName.slice(0, 30)}) → L${similar.layer}::${similar.nodeId} (${(similar.score*100).toFixed(0)}%)`);
        updateExistingNodeByPolicy(net, similar.layer, similar.nodeId, nodeName, validation.content, log);
        merged++;
        continue;
      }
      const created = addPolicyNode(net, node.layer, validation.content, log, node.name, undefined, { mergeSimilar: true, similarityThreshold: 0.24 });
      if (created.added || created.replaced) added++;
      else if (created.merged) merged++;
      else if (created.skipped) { addSkipped++; addSkipReasons.push(`L${node.layer}:${created.reason || "frozen_skip"}`); }
    }
    if (nodeUpdate.updated > 0 || added > 0 || merged > 0) {
      net.hyperparams.updatedAt = new Date().toISOString();
      writeJson(path.join(net.path, "hyperparams.json"), net.hyperparams);
    }

    // ── n-gram distillation ──
    // Update n-gram counts for all activated nodes from this turn's HighEntropy
    let distillCount = 0;
    const distillEvents: { nodeId: string; oldContent: string; newContent: string }[] = [];
    if (previousAssistantHighEntropy) {
      const allStates = loadAllNgramStates(net);
      for (const id of activatedIds) {
        const parsed = parseLayerNodeId(id);
        if (!parsed) continue;
        const nodePath = path.join(net.path, `layer_${parsed.layer}`, `${parsed.nodeId}.html`);
        if (!fs.existsSync(nodePath)) continue;

        const ngramState = readNgramState(nodePath);
        updateCounts(ngramState, previousAssistantHighEntropy, effectiveReward);
        writeNgramState(nodePath, ngramState);

        // Try distillation
        const oldContent = readNodeContent(nodePath);
        const distill = maybeDistill(ngramState, allStates, oldContent);
        if (distill.newContent) {
          if (!NGRAM_DISTILL_PROMOTE) {
            recordMonitorEvent({
              type: "trace",
              action: "ngram_distill_shadow",
              taskFamily,
              nodeId: id,
              oldContent: preview(readNodeContent(nodePath), 120),
              proposedContent: preview(distill.newContent, 180),
              topNgrams: distill.topNgrams.slice(0, 5),
            });
            dlog("DISTILL", `shadow ${id}: ${preview(distill.newContent, 80)}`);
            continue;
          }
          const preparedDistill = prepareContextLine(distill.newContent);
          const validation = preparedDistill
            ? validateKnowledgeCrystal(preparedDistill, parsed.layer)
            : { ok: false, content: distill.newContent, reason: "distill_fragment" };
          const oldQuality = validateKnowledgeCrystal(oldContent, parsed.layer);
          const distillArtifact = !preparedDistill || isNgramFragmentContent(preparedDistill);
          const weakOverwrite = oldQuality.ok && !validation.ok;
          if (!validation.ok || distillArtifact || weakOverwrite) {
            const reason = distillArtifact ? "distill_fragment" : weakOverwrite ? "weak_overwrite" : validation.reason;
            recordMonitorEvent({
              type: "trace",
              action: "ngram_distill_skip",
              taskFamily,
              nodeId: id,
              reason,
              oldContent: preview(oldContent, 120),
              proposedContent: preview(distill.newContent, 180),
            });
            dlog("DISTILL", `skipped ${id}: ${reason}`);
            continue;
          }

          const oldName = readNodeName(nodePath);
          const outEdges = (net.weights.layer_connections[`${parsed.layer}_to_${parsed.layer + 1}`] || [])
            .filter((e) => e.from === parsed.nodeId)
            .map((e) => ({ toId: e.to, weight: e.weight }));
          writeNodeHtml(nodePath, parsed.layer, parsed.nodeId, validation.content, outEdges, compressNodeName(validation.content));
          distillCount++;
          distillEvents.push({
            nodeId: id,
            oldContent: preview(oldContent, 120),
            newContent: preview(validation.content, 120),
          });
          dlog("DISTILL", `distilled ${id}: "${preview(oldContent, 60)}" → "${preview(validation.content, 60)}"`);
          log(`Textron ngram distill: ${id} "${preview(oldContent, 60)}" → "${preview(validation.content, 60)}"`);
        }
      }
    }

    const durationMs = Date.now() - startedMs;
    const qualityScore = clamp(
      (Math.max(0, effectiveReward) * 0.35) +
      (edgeUpdate.changes > 0 ? 0.20 : 0) +
      (nodeUpdate.updated > 0 ? 0.25 : 0) +
      ((added + merged) > 0 ? 0.15 : 0) +
      (previousAssistantHighEntropy ? 0.05 : 0) -
      ((nodeUpdate.updated + added + merged) === 0 ? 0.15 : 0),
      0,
      1,
    );
    const qualityLabel = qualityScore >= 0.7 ? "high" : qualityScore >= 0.35 ? "medium" : "low";
    lastBackwardState = {
      taskFamily,
      action: "semantic_backward",
      status: "done",
      reward: effectiveReward,
      llmReward: result.reward,
      rationale: result.rationale || "",
      qualityScore,
      qualityLabel,
      durationMs,
      hasHighEntropy: !!previousAssistantHighEntropy,
      highEntropyFallbackNode,
      nodesUpdated: nodeUpdate.updated,
      nodesAdded: added,
      nodesMerged: merged,
      nodesSkipped: nodeUpdate.skipped + addSkipped,
      skipReasons: [...nodeUpdate.skipReasons, ...addSkipReasons].slice(0, 8),
      edgesUpdated: edgeUpdate.changes,
      changedEdges: edgeUpdate.changedEdges,
      changedNodes: nodeUpdate.changedNodes,
      distillCount,
      distillEvents,
      activatedIds,
      selectedEdgeIds,
      pathAudit,
      startedAt,
      at: new Date().toISOString(),
    };
    dlog("BACKWARD", "forcedSemanticBackward DONE", lastBackwardState);
    log(`Textron semantic backward: status=done quality=${qualityLabel}(${qualityScore.toFixed(2)}), reward=${effectiveReward.toFixed(3)} (LLM=${result.reward.toFixed(3)}), edgesUpdated=${edgeUpdate.changes}, nodesUpdated=${nodeUpdate.updated}, nodesAdded=${added}, nodesMerged=${merged}, nodesSkipped=${nodeUpdate.skipped + addSkipped}, durationMs=${durationMs}${result.rationale ? ` — ${result.rationale}` : ""}`);
    recordMonitorEvent({ type: "update", taskFamily, action: "semantic_backward_done", ...lastBackwardState });
    broadcast({ type: "update", taskFamily, action: "semantic_backward_done", ...lastBackwardState });
    return lastBackwardState;
  }

  // ══════════════════════════════════════════════════════════════════
  // before_agent_start → auto-route → blocking LLM L0 score → propagate → inject
  // ══════════════════════════════════════════════════════════════════

  pi.on("before_agent_start", async (event, ctx) => {
    const tStart = Date.now();
    dlog("HOOK", "before_agent_start FIRED", { promptLen: event.prompt?.length || 0, promptPreview: (event.prompt || "").slice(0, 80) });
    recordMonitorEvent({ type: "hook", hook: "before_agent_start", promptChars: event.prompt?.length || 0, promptPreview: preview(event.prompt, 180), hasLastTask: !!lastTaskFamily, lastTaskFamily: lastTaskFamily || "" });
    let prevTF = lastTaskFamily;
    let prevIDs = lastActivatedIds;
    // Restore from disk if in-memory state was lost (e.g. after reload)
    if (!prevTF) {
      const saved = readJson<{taskFamily?: string; activatedIds?: string[]; selectedEdgeIds?: string[]; userPrompt?: string; rawUserPrompt?: string; effectivePrompt?: string; assistantHighEntropy?: string} | null>(
        LAST_STATE_PATH, null);
      if (saved?.taskFamily) {
        prevTF = saved.taskFamily;
        prevIDs = saved.activatedIds || [];
        lastSelectedEdgeIds = saved.selectedEdgeIds || [];
        lastRawUserPrompt = saved.rawUserPrompt || saved.userPrompt || "";
        lastEffectivePrompt = saved.effectivePrompt || saved.userPrompt || lastRawUserPrompt;
        lastAssistantHighEntropy = saved.assistantHighEntropy || "";
        dlog("STATE", "restored last state from disk", { taskFamily: prevTF, activatedIds: prevIDs, hasHighEntropy: !!lastAssistantHighEntropy });
        recordMonitorEvent({ type: "trace", action: "state_restored", taskFamily: prevTF, activatedIds: prevIDs, selectedEdgeIds: lastSelectedEdgeIds, hasHighEntropy: !!lastAssistantHighEntropy, rawUserPromptChars: lastRawUserPrompt.length, effectivePromptChars: lastEffectivePrompt.length });
      }
    }
    currentTaskFamily = null;
    currentActivatedIds = [];
    currentActivationScores = {};
    currentSelectedEdgeIds = [];
    currentRawUserPrompt = event.prompt || "";
    currentEffectivePrompt = currentRawUserPrompt;
    currentUserInjection = "";
    currentContextAuditLogged = false;
    currentProviderAuditLogged = false;
    currentAssistantBuffer = "";
    currentAssistantHighEntropy = "";
    currentHighEntropyLogged = false;

    if (prevTF) {
      dlog("BACKWARD", "forcedSemanticBackward START", { taskFamily: prevTF, prevIds: prevIDs });
      const capturedTF = prevTF;
      const capturedIDs = [...prevIDs];
      const backwardTaskContext = buildBackwardTaskContext({
        rawPrompt: lastRawUserPrompt,
        effectivePrompt: lastEffectivePrompt,
      });
      const capturedPrevTask = backwardTaskContext.previousTaskForBackward;
      const capturedCurrentMsg = currentRawUserPrompt;
      const capturedEdges = [...lastSelectedEdgeIds];
      const capturedHighEntropy = lastAssistantHighEntropy;
      const capturedNet = loadNetwork(capturedTF);
      const capturedPathAudit = capturedNet ? buildPathAudit(capturedNet, capturedPrevTask, capturedHighEntropy, capturedIDs) : null;
      const startedAt = new Date().toISOString();
      const semanticRunId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      lastBackwardState = {
        taskFamily: capturedTF,
        action: "semantic_backward",
        status: "running",
        runId: semanticRunId,
        activatedIds: capturedIDs,
        selectedEdgeIds: capturedEdges,
        pathAudit: capturedPathAudit,
        hasHighEntropy: !!capturedHighEntropy,
        previousTaskChars: capturedPrevTask.length,
        previousRawPromptChars: backwardTaskContext.rawPromptChars,
        previousEffectivePromptChars: backwardTaskContext.effectivePromptChars,
        usedEffectivePromptForBackward: backwardTaskContext.usedEffectivePrompt,
        feedbackChars: capturedCurrentMsg.length,
        startedAt,
        at: startedAt,
      };
      dlog("BACKWARD", "forcedSemanticBackward RUNNING", lastBackwardState);
      recordMonitorEvent({ type: "update", taskFamily: capturedTF, action: "semantic_backward_start", ...lastBackwardState });
      broadcast({ type: "update", taskFamily: capturedTF, action: "semantic_backward_start", ...lastBackwardState });
      log(`Textron semantic backward: status=running runId=${semanticRunId}, path=${capturedIDs.join("->") || "(none)"}, hasHighEntropy=${!!capturedHighEntropy}`);
      // Pi lifecycle guarantee: finish previous-turn learning before current-turn forward
      // reads node contents and edge weights for prompt injection.
      try {
        await forcedSemanticBackward(capturedTF, capturedPrevTask, capturedHighEntropy, capturedCurrentMsg, capturedIDs, capturedEdges, ctx);
      } catch (e) {
        const failedAt = new Date().toISOString();
        lastBackwardState = {
          taskFamily: capturedTF,
          action: "semantic_backward",
          status: "failed",
          runId: semanticRunId,
          error: e instanceof Error ? e.message : String(e),
          activatedIds: capturedIDs,
          selectedEdgeIds: capturedEdges,
          pathAudit: capturedPathAudit,
          hasHighEntropy: !!capturedHighEntropy,
          startedAt,
          at: failedAt,
        };
        dlog("BACKWARD", "forcedSemanticBackward FAILED", lastBackwardState);
        log(`Textron semantic backward: status=failed runId=${semanticRunId}, error=${e instanceof Error ? e.message : String(e)}`);
        recordMonitorEvent({ type: "update", taskFamily: capturedTF, action: "semantic_backward_failed", ...lastBackwardState });
        broadcast({ type: "update", taskFamily: capturedTF, action: "semantic_backward_failed", ...lastBackwardState });
      }
    }

    const networks = listNetworks();

    if (networks.length === 0) {
      dlog("ROUTE", "no networks, skip");
      recordMonitorEvent({ type: "trace", action: "route_skip", reason: "no_networks", durationMs: Date.now() - tStart });
      return { systemPrompt: event.systemPrompt };
    }

    const tf = autoRouteNetwork(event.prompt, networks);
    if (!tf) {
      dlog("ROUTE", "no safe matching network, skip Textron injection");
      recordMonitorEvent({ type: "trace", action: "route_skip", reason: "no_safe_task_family_match", networkCount: networks.length, networks, promptPreview: preview(event.prompt, 180), durationMs: Date.now() - tStart });
      return { systemPrompt: event.systemPrompt };
    }
    currentTaskFamily = tf;
    recordMonitorEvent({ type: "trace", action: "route_done", taskFamily: tf, networkCount: networks.length, networks, promptPreview: preview(event.prompt, 180) });
    const net = loadNetwork(tf);
    if (!net) {
      recordMonitorEvent({ type: "trace", action: "route_skip", reason: "selected_network_missing", taskFamily: tf, durationMs: Date.now() - tStart });
      return { systemPrompt: event.systemPrompt };
    }
    dlog("ROUTE", `auto-routed to network: ${tf}`, { layers: net.hyperparams.layers, threshold: net.hyperparams.threshold });

    const l0Nodes = [];
    for (let n = 0; n < net.hyperparams.layers[0]; n++) {
      const nodePath = path.join(net.path, "layer_0", `node_${n}.html`);
      l0Nodes.push({
        id: `node_${n}`,
        name: readNodeName(nodePath),
        content: readNodeContent(nodePath),
      });
    }
    dlog("L0", `loaded ${l0Nodes.length} L0 nodes`, l0Nodes.map(n => ({ id: n.id, name: n.name || "(empty)", hasContent: !!n.content })));

    dlog("L0", "calling scoreL0WithLLM...");
    const tScoreStart = Date.now();
    const l0Scores = await scoreL0WithLLM(l0Nodes, event.prompt, ctx);
    dlog("L0", `scoring done in ${Date.now() - tScoreStart}ms`, l0Scores);

    const { layers, threshold } = net.hyperparams;
    const scores: Record<string, number> = {};
    for (const [key, val] of Object.entries(l0Scores as Record<string, number>)) {
      const score = Number(val) || 0;
      scores[key] = score;
      // Also set flat key for edge lookup (edges use bare "node_X" not "L0::node_X")
      const flat = key.replace(/^L\d+::/, "");
      scores[flat] = score;
    }
    for (let l = 1; l < layers.length; l++) {
      for (let n = 0; n < layers[l]; n++) scores[`L${l}::node_${n}`] = 0;
    }

    const selectedPath: ActivatedNode[] = [];
    const contextActivated: ActivatedNode[] = [];
    let current = { ...scores };

    const layerActivations = [];
    const edgeContributions = [];

    for (let l = 0; l < layers.length; l++) {
      const lnodes = [];
      for (let n = 0; n < layers[l]; n++) {
        const nid = `node_${n}`;
        const score = current[`L${l}::${nid}`] ?? current[nid] ?? 0;
        lnodes.push({ id: nid, score });
      }
      layerActivations.push({ layer: l, nodes: lnodes });

      if (l < layers.length - 1) {
        const next = {};
        const edges = net.weights.layer_connections[`${l}_to_${l + 1}`] || [];
        for (let t = 0; t < layers[l + 1]; t++) {
          const tid = `node_${t}`;
          let sum = 0;
          let denom = 0;
          for (const e of edges) {
            if (e.to !== tid) continue;
            const src = current[e.from] ?? current[`L${l}::${e.from}`] ?? 0;
            if (src <= 0) continue; // active-only denominator: inactive source edges must not dilute downstream scores
            const w = Math.max(0, e.weight);
            const contrib = src * w;
            sum += contrib;
            denom += w;
            edgeContributions.push({ fromL: l, toL: l + 1, from: e.from, to: e.to, contrib });
          }
          next[tid] = denom > 0 ? clamp(sum / denom, 0, 1) : 0;
        }
        current = next;
      }
    }

    // Persist all scores for monitor labels. Select a best path for backward independently
    // from the threshold-gated nodes used for prompt injection.
    currentActivationScores = {};
    const selectedByLayer = new Map<number, string>();
    for (const la of layerActivations) {
      for (const node of la.nodes) currentActivationScores[`L${la.layer}::${node.id}`] = node.score;
      const bestAny = [...la.nodes].filter((node) => node.score > 0).sort((a, b) => b.score - a.score)[0];
      if (bestAny) {
        selectedByLayer.set(la.layer, bestAny.id);
        selectedPath.push({
          id: bestAny.id,
          layer: la.layer,
          content: readNodeContent(path.join(net.path, `layer_${la.layer}`, `${bestAny.id}.html`)),
          activation: bestAny.score,
        });
      }
      if (bestAny && bestAny.score > threshold) {
        contextActivated.push({
          id: bestAny.id,
          layer: la.layer,
          content: readNodeContent(path.join(net.path, `layer_${la.layer}`, `${bestAny.id}.html`)),
          activation: bestAny.score,
        });
      }
    }

    currentSelectedEdgeIds = [];
    for (let l = 0; l < layers.length - 1; l++) {
      const from = selectedByLayer.get(l);
      const to = selectedByLayer.get(l + 1);
      if (!from || !to) continue;
      currentSelectedEdgeIds.push(`L${l}::${from}->L${l + 1}::${to}`);
    }

    currentActivatedIds = selectedPath.map((n) => `L${n.layer}::${n.id}`);
    const contextIds = contextActivated.map((n) => `L${n.layer}::${n.id}`);
    dlog("PROPAGATE", `selected ${selectedPath.length} path nodes, injecting ${contextActivated.length} context nodes (threshold=${threshold})`, { selectedPathIds: currentActivatedIds, contextIds, selectedEdges: currentSelectedEdgeIds });
    recordMonitorEvent({
      type: "trace",
      action: "propagate_done",
      taskFamily: tf,
      threshold,
      selectedIds: currentActivatedIds,
      contextIds,
      selectedEdgeIds: currentSelectedEdgeIds,
      topByLayer: layerActivations.map((la) => ({ layer: la.layer, top: topLayerNodes(la.nodes) })),
      edgeContributionCount: edgeContributions.length,
      topEdgeContributions: [...edgeContributions].sort((a: any, b: any) => b.contrib - a.contrib).slice(0, 8).map((e: any) => ({ ...e, contrib: Number(e.contrib.toFixed(4)) })),
      allScoresZero: Object.values(currentActivationScores).every((v) => Number(v) <= 0),
      durationMs: Date.now() - tStart,
    });
    broadcast({
      type: "propagate_live",
      taskFamily: tf,
      layerActivations,
      edgeContributions,
      selectedIds: currentActivatedIds,
      contextIds,
      selectedEdgeIds: currentSelectedEdgeIds,
      scores: currentActivationScores,
      threshold,
      totalLayers: layers.length,
    });

    const compiledCtx = compileContext(net, contextActivated);
    dlog("COMPILE", `compiled context: ${compiledCtx.length} chars`, compiledCtx.slice(0, 200));

    const totalMs = Date.now() - tStart;
    dlog("HOOK", `before_agent_start DONE in ${totalMs}ms`, { selectedPathCount: selectedPath.length, activatedCount: contextActivated.length, compiledLen: compiledCtx.length });
    recordMonitorEvent({ type: "hook", hook: "before_agent_start_done", taskFamily: tf, selectedPathCount: selectedPath.length, contextCount: contextActivated.length, compiledChars: compiledCtx.length, durationMs: totalMs, injectedHighEntropyInstruction: true });

    const injection = buildTextronPromptInjection({
      rawPrompt: currentRawUserPrompt,
      taskFamily: tf,
      contextActivatedCount: contextActivated.length,
      totalNodeCount: layers.reduce((a, b) => a + b, 0),
      selectedPathCount: selectedPath.length,
      compiledContext: compiledCtx,
    });
    currentEffectivePrompt = injection.effectivePrompt;
    recordMonitorEvent({
      type: "trace",
      action: "prompt_injection_prepared",
      taskFamily: tf,
      ...injection.audit,
    });
    currentUserInjection = injection.userInjection;
    log(`Textron: prepared ${compiledCtx.length}c compiled context for context.user_message injection in "${tf}"`);
    return {
      systemPrompt: event.systemPrompt + HIGH_ENTROPY_INSTRUCTION,
    };
  });

  pi.on("context", async (event: any, _ctx: any) => {
    if (!currentUserInjection || !currentRawUserPrompt) return;
    const messages = Array.isArray(event.messages) ? [...event.messages] : [];
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (!msg || msg.role !== "user") continue;
      const content = msg.content;
      if (typeof content === "string") {
        if (!content.includes("## 🧠 Textron")) {
          messages[i] = { ...msg, content: content + currentUserInjection };
          if (!currentContextAuditLogged) {
            currentContextAuditLogged = true;
            recordPromptAudit({
              type: "trace",
              action: "context_user_message_injected",
              taskFamily: currentTaskFamily || "",
              rawPromptChars: currentRawUserPrompt.length,
              effectivePromptChars: currentEffectivePrompt.length,
              hasTextronMarker: true,
              injectedPromptPreview: preview((content + currentUserInjection).slice(-700), 700),
            });
          }
        }
        return { messages };
      }
      if (!Array.isArray(content)) continue;
      const textIndex = content.findIndex((part: any) => part?.type === "text" && typeof part.text === "string");
      if (textIndex < 0) continue;
      const text = content[textIndex].text;
      if (text.includes("## 🧠 Textron")) return { messages };
      const nextContent = [...content];
      nextContent[textIndex] = { ...nextContent[textIndex], text: text + currentUserInjection };
      messages[i] = { ...msg, content: nextContent };
      if (!currentContextAuditLogged) {
        currentContextAuditLogged = true;
        recordPromptAudit({
          type: "trace",
          action: "context_user_message_injected",
          taskFamily: currentTaskFamily || "",
          rawPromptChars: currentRawUserPrompt.length,
          effectivePromptChars: currentEffectivePrompt.length,
          hasTextronMarker: true,
          injectedPromptPreview: preview((text + currentUserInjection).slice(-700), 700),
        });
      }
      return { messages };
    }
  });

  pi.on("before_provider_request", async (event: any, _ctx: any) => {
    if (!currentUserInjection || !currentRawUserPrompt) return;
    let payloadText = "";
    try { payloadText = JSON.stringify(event.payload || ""); }
    catch { payloadText = String(event.payload || ""); }
    const markerIndex = payloadText.indexOf("## 🧠 Textron");
    if (!currentProviderAuditLogged) {
      currentProviderAuditLogged = true;
      recordPromptAudit({
        type: "trace",
        action: "provider_payload_textron_audit",
        taskFamily: currentTaskFamily || "",
        hasTextronMarker: markerIndex >= 0,
        payloadChars: payloadText.length,
        markerIndex,
        preview: markerIndex >= 0 ? preview(payloadText.slice(Math.max(0, markerIndex - 120), markerIndex + 360), 480) : "",
      });
    }
  });

  // ══════════════════════════════════════════════════════════════════
  // message_update/message_end → capture assistant <HighEntropy> summary
  // ══════════════════════════════════════════════════════════════════

  pi.on("message_update", async (event: any, _ctx: any) => {
    const ev = event?.assistantMessageEvent;
    if (!ev) return;
    if (ev.type === "text_delta" && ev.delta) currentAssistantBuffer += String(ev.delta);
    if (ev.type === "text_end" && ev.content) currentAssistantBuffer += String(ev.content);
    const extracted = extractHighEntropy(currentAssistantBuffer);
    if (extracted) {
      currentAssistantHighEntropy = extracted;
      if (!currentHighEntropyLogged) {
        currentHighEntropyLogged = true;
        recordMonitorEvent({ type: "trace", action: "highentropy_captured", source: "message_update", taskFamily: currentTaskFamily || "", chars: extracted.length, preview: preview(extracted, 220), assistantBufferChars: currentAssistantBuffer.length });
      }
    }
  });

  pi.on("message_end", async (event: any, _ctx: any) => {
    if (event?.message?.role !== "assistant") return;
    const parts = event.message.content;
    let text = "";
    if (typeof parts === "string") text = parts;
    else if (Array.isArray(parts)) text = parts.map((p: any) => p?.text || p?.content || p?.value || "").join("\n");
    else if (parts) text = JSON.stringify(parts);
    if (text) currentAssistantBuffer += "\n" + text;
    const extracted = extractHighEntropy(currentAssistantBuffer);
    if (extracted) {
      currentAssistantHighEntropy = extracted;
      if (!currentHighEntropyLogged) {
        currentHighEntropyLogged = true;
        recordMonitorEvent({ type: "trace", action: "highentropy_captured", source: "message_end", taskFamily: currentTaskFamily || "", chars: extracted.length, preview: preview(extracted, 220), assistantBufferChars: currentAssistantBuffer.length });
      }
    } else {
      recordMonitorEvent({ type: "trace", action: "highentropy_missing_at_message_end", taskFamily: currentTaskFamily || "", assistantBufferChars: currentAssistantBuffer.length, tailPreview: preview(currentAssistantBuffer.slice(-500), 220) });
    }
  });

  // ══════════════════════════════════════════════════════════════════
  // agent_end → preserve selected path for forced semantic backward on next turn
  // ══════════════════════════════════════════════════════════════════

  pi.on("agent_end", async (_event, _ctx) => {
    // Move current → last for feedback, but keep current* visible for the monitor
    // until the next before_agent_start propagation replaces it.
    dlog("HOOK", "agent_end FIRED — preserving state for next backward", { taskFamily: currentTaskFamily, activatedIds: currentActivatedIds });
    lastTaskFamily = currentTaskFamily;
    lastActivatedIds = [...currentActivatedIds];
    lastSelectedEdgeIds = [...currentSelectedEdgeIds];
    lastRawUserPrompt = currentRawUserPrompt;
    lastEffectivePrompt = currentEffectivePrompt;
    lastAssistantHighEntropy = currentAssistantHighEntropy || extractHighEntropy(currentAssistantBuffer);
    recordMonitorEvent({
      type: "hook",
      hook: "agent_end",
      taskFamily: currentTaskFamily || "",
      activatedIds: currentActivatedIds,
      selectedEdgeIds: currentSelectedEdgeIds,
      hasHighEntropy: !!lastAssistantHighEntropy,
      highEntropyChars: lastAssistantHighEntropy.length,
      highEntropyPreview: preview(lastAssistantHighEntropy, 220),
      assistantBufferChars: currentAssistantBuffer.length,
      rawUserPromptChars: currentRawUserPrompt.length,
      effectivePromptChars: currentEffectivePrompt.length,
      userPromptChars: currentRawUserPrompt.length,
    });
    // Persist to disk so state survives reloads
    try {
      ensureDir(path.dirname(LAST_STATE_PATH));
      writeJson(LAST_STATE_PATH, {
        taskFamily: currentTaskFamily,
        activatedIds: currentActivatedIds,
        selectedEdgeIds: currentSelectedEdgeIds,
        userPrompt: currentRawUserPrompt.slice(0, 500),
        rawUserPrompt: currentRawUserPrompt.slice(0, 500),
        effectivePrompt: currentEffectivePrompt.slice(0, 1000),
        assistantHighEntropy: lastAssistantHighEntropy.slice(0, 500),
        at: new Date().toISOString(),
      });
      recordMonitorEvent({ type: "trace", action: "last_state_saved", taskFamily: currentTaskFamily || "", activatedIds: currentActivatedIds, selectedEdgeIds: currentSelectedEdgeIds, hasHighEntropy: !!lastAssistantHighEntropy, stateFile: LAST_STATE_PATH });
    } catch (e) {
      recordMonitorEvent({ type: "trace", action: "last_state_save_failed", taskFamily: currentTaskFamily || "", error: preview(e instanceof Error ? e.message : String(e), 220) });
    }
  });

  // ══════════════════════════════════════════════════════════════════
  // MANUAL MODE: Textron tool (for explicit control / inspection)
  // ══════════════════════════════════════════════════════════════════

  pi.registerTool({
    name: "Textron",
    label: "Textron",
    description: "Textron text neural network — auto context graph. L0 nodes injected each turn; LLM scores relevance → programmatic edge propagation → compiled context. Manual actions: status/list (inspect), init (new network), backward (train). Node Content Rule: compressed reusable transferable insights (~100 chars max), NOT raw logs or session summaries.",
    promptSnippet: "Textron: auto-injects L0 nodes each turn. Call activate with L0 attention scores → programmatic propagation compiles context. Use backward to train.",
    promptGuidelines: [
      "Textron forward+propagate runs automatically each turn — L0 nodes are scored by LLM internally, context is already injected. No manual activation needed.",
"After completing the task, ALWAYS call Textron action='backward' with feedback ('success'/'failure') AND filledNodes (JSON like {'L0::node_0':'insight','L1::node_2':'detail',...}). Use layer-qualified keys 'L<N>::node_X' to target specific layers.",
"After completing the task, ALWAYS call Textron action='backward' with feedback ('success'/'failure') AND filledNodes (JSON like {'L0::node_0':'insight','L1::node_2':'detail',...}). Use layer-qualified keys 'L<N>::node_X' to target specific layers.",
"After completing the task, ALWAYS call Textron action='backward' with feedback ('success'/'failure') AND filledNodes (JSON like {'L0::node_0':'insight','L1::node_2':'detail',...}). Use layer-qualified keys 'L<N>::node_X' to target specific layers.",
      "Node content MUST be high-entropy: compressed, reusable insights, not raw output. ❌ Never store session summaries, tool listings, or file manifests. ✅ Only store transferable principles applicable to future tasks in the same family.",
      "If no network matches and under the 10-network cap, call action='init' with a meaningful taskFamily name (e.g. 'react_hooks_debugging'). Then after the task, fill nodes via backward. Note: init now expands the best existing network instead of creating a new one; new networks only created when none exist.",
    ],
    parameters: Type.Object({
      action: StringEnum(["status", "list", "init", "backward"] as const),
      taskFamily: Type.Optional(Type.String({ description: "Task family name" })),
      layers: Type.Optional(Type.String({ description: "Comma-separated node counts per layer, preferably front-narrow/back-wide, e.g. '4,6,8' (for init)" })),
      threshold: Type.Optional(Type.Number({ description: "Activation threshold (for init)" })),
      learningRate: Type.Optional(Type.Number({ description: "Learning rate (for init)" })),
      feedback: Type.Optional(Type.String({ description: "Feedback: 'success', 'failure', or correction text (for backward)" })),
      activatedNodes: Type.Optional(Type.String({ description: "JSON array of activated node IDs from forward pass (for backward)" })),
      filledNodes: Type.Optional(Type.String({ description: "JSON: {'node_id': 'knowledge crystal', ...} — high-entropy reusable principles only (≤100 chars). NOT raw logs, session summaries, or tool listings (for backward)" })),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const taskFamilyParam = params.taskFamily || currentTaskFamily || "";
      let tf = taskFamilyParam;

      dlog("TOOL", `Textron tool called: action=${params.action}`, { taskFamily: tf, action: params.action });
      switch (params.action) {
        // ── STATUS ────────────────────────────────────────────────
        case "status": {
          const networks = listNetworks();
          let text = `## Textron Status\n\n`;

          if (currentTaskFamily) {
            text += `**Active network**: \`${currentTaskFamily}\`\n`;
            text += `**Activated nodes this turn**: ${currentActivatedIds.length > 0 ? currentActivatedIds.join(", ") : "(fresh network, no nodes active)"}\n\n`;
          } else {
            text += `No auto-activated network this session.\n\n`;
          }

          text += `### All Networks (${networks.length})\n\n`;
          if (networks.length === 0) {
            text += `None yet. Networks are auto-created when you work on tasks.\n`;
          } else {
            for (const name of networks) {
              const hp = readJson<Hyperparams>(path.join(TEXTRON_HOME, name, "hyperparams.json"), DEFAULT_HYPERPARAMS);
              const net = loadNetwork(name);
              const ng = net ? getNgramStats(net) : { stateFiles: 0, totalActivations: 0, successfulActivations: 0, distillReady: 0 };
              text += `- **${name}**: [${hp.layers.join(",")}] thr=${hp.threshold} lr=${hp.learningRate} growth=${TEXTRON_ALLOW_NODE_GROWTH ? "on" : "frozen"} ngram=${NGRAM_DISTILL_PROMOTE ? "promote" : "shadow"} states=${ng.stateFiles} act=${ng.totalActivations}/${ng.successfulActivations} ready=${ng.distillReady}\n`;
            }
          }

          return {
            content: [{ type: "text", text }],
            details: { action: "status", active: currentTaskFamily, activatedIds: currentActivatedIds, networks },
          };
        }

        // ── LIST ──────────────────────────────────────────────────
        case "list": {
          const networks = listNetworks();
          if (networks.length === 0) {
            return {
              content: [{ type: "text", text: "No Textron networks yet. Networks are auto-created when you work on tasks." }],
              details: { action: "list", networks: [] },
            };
          }
          let text = `## Textron Networks (${networks.length})\n\n`;
          for (const name of networks) {
            const hp = readJson<Hyperparams>(path.join(TEXTRON_HOME, name, "hyperparams.json"), DEFAULT_HYPERPARAMS);
            // Count non-empty nodes
            let filled = 0, total = 0;
            for (let l = 0; l < hp.layers.length; l++) {
              for (let n = 0; n < hp.layers[l]; n++) {
                total++;
                const c = readNodeContent(path.join(TEXTRON_HOME, name, `layer_${l}`, `node_${n}.html`));
                if (c) filled++;
              }
            }
            const net = loadNetwork(name);
            const ng = net ? getNgramStats(net) : { stateFiles: 0, totalActivations: 0, successfulActivations: 0, distillReady: 0 };
            text += `- **${name}**: [${hp.layers.join(",")}] ${filled}/${total} nodes filled, thr=${hp.threshold}, growth=${TEXTRON_ALLOW_NODE_GROWTH ? "on" : "frozen"}, ngram=${NGRAM_DISTILL_PROMOTE ? "promote" : "shadow"}, ngramStates=${ng.stateFiles}, ngramAct=${ng.totalActivations}/${ng.successfulActivations}, distillReady=${ng.distillReady}\n`;
          }
          return { content: [{ type: "text", text }], details: { action: "list", networks } };
        }

        // ── INIT ──────────────────────────────────────────────────
        // Expand best existing network instead of creating a new empty one.
        // Textron learns better by growing one network's L0/L1 node pool across tasks
        // than fragmenting into many empty networks.
        case "init": {
          if (!tf) return { content: [{ type: "text", text: "Error: taskFamily required" }], details: { error: "missing taskFamily" } };
          const allNets = listNetworks();
          if (allNets.length === 0) {
            // No networks at all — create the first one.
            const layers = params.layers
              ? params.layers.split(",").map((s) => parseInt(s.trim(), 10)).filter((n) => !isNaN(n) && n > 0)
              : DEFAULT_HYPERPARAMS.layers;
            if (layers.length < 2) return { content: [{ type: "text", text: "Error: need at least 2 layers" }], details: { error: "too few layers" } };
            const hp = initNetwork(tf, layers, params.threshold ?? DEFAULT_HYPERPARAMS.threshold, params.learningRate ?? DEFAULT_HYPERPARAMS.learningRate, log);
            broadcast({ type: "update", taskFamily: tf, action: "init" });
            return {
              content: [{ type: "text", text: `Created first Textron network "${tf}"\nLayers: [${layers.join(",")}] → ${layers.reduce((a,b)=>a+b,0)} nodes\nThreshold: ${hp.threshold}\nLearning Rate: ${hp.learningRate}` }],
              details: { action: "init", taskFamily: tf, layers },
            };
          }
          // Existing networks exist — expand the best match with L0 nodes for new domain.
          const best = autoRouteNetwork(tf, allNets) || allNets[0];
          const net = loadNetwork(best);
          if (!net) return { content: [{ type: "text", text: `Network "${best}" not found` }], details: { error: "not found" } };
          const layerCount = params.layers
            ? parseInt(params.layers.split(",")[0], 10) || 2
            : 2;
          for (let i = 0; i < Math.min(layerCount, 2); i++) {
            addPolicyNode(net, i, `Route: ${tf} — ${params.threshold ? 'thr=' + params.threshold : ''}`, log);
          }
          log(`Textron: expanded network "${best}" with ${Math.min(layerCount, 2)} L0/L1 nodes for "${tf}" instead of creating new network`);
          return {
            content: [{ type: "text", text: `Expanded network "${best}" with new nodes for "${tf}" (new networks only created when none exist).` }],
            details: { action: "init", taskFamily: tf, expandedNetwork: best },
          };
        }

        // ── BACKWARD ────────────────────────────────────────────────
        case "backward": {
          dlog("BACKWARD", "manual backward requested", { taskFamily: tf, feedback: params.feedback, hasFilledNodes: !!params.filledNodes });
          if (!tf || !params.feedback) return { content: [{ type: "text", text: "Error: taskFamily and feedback required" }], details: { error: "missing params" } };

          // Expand existing best-match network instead of creating a new empty one.
          // New empty networks fragment Textron's knowledge; adding L0/L1 nodes to the
          // closest network preserves cross-task transfer.
          if (!networkExists(tf)) {
            const routePrompt = params.feedback || tf;
            const allNets = listNetworks();
            const best = allNets.length > 0 ? autoRouteNetwork(routePrompt, allNets) : null;
            const targetNet = best && networkExists(best) ? best : (allNets[0] || tf);
            if (!networkExists(targetNet)) {
              // No networks at all — create first one.
              if (listNetworks().length >= 10) {
                return { content: [{ type: "text", text: `Cannot create "${tf}": 10-network cap reached.` }], details: { error: "cap reached" } };
              }
              initNetwork(targetNet, DEFAULT_HYPERPARAMS.layers, DEFAULT_HYPERPARAMS.threshold, DEFAULT_HYPERPARAMS.learningRate, log);
            } else {
              // Add L0 and L1 nodes to existing network to cover new task domain
              const net = loadNetwork(targetNet);
              if (net) {
                tf = targetNet; // Redirect to existing network
                const l0Content = `Route: ${params.feedback || tf}`;
                addPolicyNode(net, 0, l0Content, log);
                addPolicyNode(net, 1, `Rule for ${tf}: ${params.feedback || "expand task coverage"}`, log);
                log(`Textron: expanded network "${targetNet}" with new nodes for "${tf}" instead of creating new network`);
              }
            }
          }

          const net = loadNetwork(tf);
          if (!net) return { content: [{ type: "text", text: "Network not found" }], details: { error: "not found" } };

          let ids: string[] = [];
          if (params.activatedNodes) { try { ids = JSON.parse(params.activatedNodes); } catch {} }

          const fb = params.feedback.toLowerCase();
          const reward = fb.includes("success") || fb.includes("对") || fb.includes("好") ? 1.0
            : fb.includes("fail") || fb.includes("错") || fb.includes("wrong") ? -0.5 : 0.0;

          const activeIds = ids.length > 0 ? ids : currentActivatedIds;
          const credit = assignEdgeCredit({
            selectedEdgeIds: currentSelectedEdgeIds,
            baseReward: reward,
            feedbackText: params.feedback,
            pathAuditLabel: reward < 0 ? "low" : "high",
          });
          const edgeUpdate = autoBackward(net, activeIds, credit.reward, log, currentSelectedEdgeIds, credit.edgeRewards);
          if (credit.reason !== "normal") recordMonitorEvent({ type: "trace", action: "manual_negative_credit", taskFamily: tf, reason: credit.reason, baseReward: reward, effectiveReward: credit.reward, selectedEdgeIds: currentSelectedEdgeIds });
          broadcast({ type: "update", taskFamily: tf, action: "backward", reward: credit.reward, changedEdges: edgeUpdate.changedEdges });

          // Fill/update nodes — supports "L<N>::node_X" layer-qualified keys and legacy flat keys
          // Existing nodes get their content UPDATED (not just filled when empty)
          // New node IDs (beyond current layer size) are created dynamically
          let fillMsg = "";
          let manualChangedNodes: { id: string; oldContent: string; newContent: string; oldName: string; newName: string }[] = [];
          if (params.filledNodes) {
            try {
              const filled = JSON.parse(params.filledNodes) as Record<string, string>;
              let newCount = 0, updateCount = 0, skippedCount = 0;
              const skipReasons: string[] = [];
              const changedNodes: { id: string; oldContent: string; newContent: string; oldName: string; newName: string }[] = [];
              for (const [rawKey, rawContent] of Object.entries(filled)) {
                const parsed = parseLayerNodeId(rawKey);
                const validation = validateKnowledgeCrystal(rawContent, parsed?.layer);
                if (!validation.ok) {
                  skippedCount++;
                  skipReasons.push(`${rawKey}:${validation.reason}`);
                  log(`Textron: skipped low-entropy filledNode ${rawKey} (${validation.reason})`);
                  continue;
                }
                const content = validation.content;
                if (parsed !== null) {
                  const similar = findSimilarKnowledgeNode(net, compressNodeName(content), content, 0.24, parsed.layer, parsed.nodeId);
                  if (similar) {
                    const similarKey = `L${similar.layer}::${similar.nodeId}`;
                    const oldPath = path.join(net.path, `layer_${similar.layer}`, `${similar.nodeId}.html`);
                    const old = readNodeContent(oldPath);
                    const oldName = readNodeName(oldPath);
                    updateExistingNodeByPolicy(net, similar.layer, similar.nodeId, compressNodeName(content), content, log);
                    const updated = readNodeContent(oldPath);
                    changedNodes.push({ id: similarKey, oldContent: preview(old, 220), newContent: preview(updated, 220), oldName: preview(oldName, 100), newName: preview(readNodeName(oldPath), 100) });
                    updateCount++;
                    log(`Textron: merged filledNode ${rawKey} into similar ${similarKey} (${(similar.score*100).toFixed(0)}%)`);
                    continue;
                  }
                  // Layer-qualified: L<N>::node_X — fill/update exact layer, after quality gate.
                  const np = path.join(net.path, `layer_${parsed.layer}`, `${parsed.nodeId}.html`);
                  if (fs.existsSync(np)) {
                    const old = readNodeContent(np);
                    const oldName = readNodeName(np);
                    const outEdges = (net.weights.layer_connections[`${parsed.layer}_to_${parsed.layer + 1}`] || []).filter(e => e.from === parsed.nodeId).map(e => ({ toId: e.to, weight: e.weight }));
                    const merged = mergeContent(old, content);
                    writeNodeHtml(np, parsed.layer, parsed.nodeId, merged, outEdges, compressNodeName(merged));
                    changedNodes.push({ id: rawKey, oldContent: preview(old, 220), newContent: preview(merged, 220), oldName: preview(oldName, 100), newName: preview(compressNodeName(merged), 100) });
                    if (old) updateCount++; else newCount++;
                  } else {
                    // Node doesn't exist — dynamically create it (must be next sequential, no gaps)
                    const nodeIndex = parseInt(parsed.nodeId.replace('node_', ''), 10);
                    if (!isNaN(nodeIndex) && nodeIndex >= 0 && nodeIndex === net.hyperparams.layers[parsed.layer]) {
                      const created = addPolicyNode(net, parsed.layer, content, log, compressNodeName(content), parsed.nodeId);
                      if (created.added || created.replaced) newCount++;
                      else if (created.merged) updateCount++;
                      else if (created.skipped) { skippedCount++; skipReasons.push(`${rawKey}:${created.reason || "frozen_skip"}`); }
                    }
                  }
                } else {
                  // Legacy flat key — fill/update the first matching node found across all layers
                  let handled = false;
                  for (let l = 0; l < net.hyperparams.layers.length; l++) {
                    const np = path.join(net.path, `layer_${l}`, `${rawKey}.html`);
                    if (fs.existsSync(np)) {
                      const layerValidation = validateKnowledgeCrystal(content, l);
                      if (!layerValidation.ok) {
                        skippedCount++;
                        skipReasons.push(`${rawKey}:L${l}:${layerValidation.reason}`);
                        log(`Textron: skipped low-entropy filledNode ${rawKey} for L${l} (${layerValidation.reason})`);
                        handled = true;
                        break;
                      }
                      const old = readNodeContent(np);
                      const oldName = readNodeName(np);
                      const outEdges = (net.weights.layer_connections[`${l}_to_${l + 1}`] || []).filter(e => e.from === rawKey).map(e => ({ toId: e.to, weight: e.weight }));
                      const merged = mergeContent(old, content);
                      writeNodeHtml(np, l, rawKey, merged, outEdges, compressNodeName(merged));
                      changedNodes.push({ id: `L${l}::${rawKey}`, oldContent: preview(old, 220), newContent: preview(merged, 220), oldName: preview(oldName, 100), newName: preview(compressNodeName(merged), 100) });
                      if (old) updateCount++; else newCount++;
                      handled = true;
                      break;
                    }
                  }
                  // If no matching node found, try to create via layer policy after quality gate.
                  if (!handled) {
                    const nodeIndex = parseInt(rawKey.replace('node_', ''), 10);
                    if (!isNaN(nodeIndex) && nodeIndex >= 0) {
                      const created = addPolicyNode(net, undefined, content, log, compressNodeName(content), undefined, { mergeSimilar: true, similarityThreshold: 0.24 });
                      if (created.merged) updateCount++;
                      else if (created.added || created.replaced) newCount++;
                      else if (created.skipped) { skippedCount++; skipReasons.push(`${rawKey}:${created.reason || "frozen_skip"}`); }
                    }
                  }
                }
              }
              const parts: string[] = [];
              if (newCount > 0) parts.push(`${newCount} new`);
              if (updateCount > 0) parts.push(`${updateCount} updated`);
              if (skippedCount > 0) parts.push(`${skippedCount} skipped`);
              manualChangedNodes = changedNodes;
              if (changedNodes.length > 0) {
                for (const ch of changedNodes.slice(0, 8)) {
                  log(`Textron manual backward node ${ch.id}: "${ch.oldContent}" -> "${ch.newContent}"`);
                }
              }
              recordMonitorEvent({ type: "update", taskFamily: tf, action: "manual_backward_node_update", reward, changedEdges: edgeUpdate.changedEdges, changedNodes, newCount, updateCount, skippedCount, skipReasons: skipReasons.slice(0, 8) });
              broadcast({ type: "update", taskFamily: tf, action: "manual_backward_node_update", reward, changedEdges: edgeUpdate.changedEdges, changedNodes, newCount, updateCount, skippedCount, skipReasons: skipReasons.slice(0, 8) });
              if (parts.length > 0) fillMsg = `\nNodes: ${parts.join(", ")}.${skipReasons.length ? ` Skipped: ${skipReasons.slice(0, 3).join("; ")}` : ""}`;
            } catch {}
          }

          return {
            content: [{ type: "text", text: `Backward: "${tf}" reward=${reward.toFixed(1)}.${fillMsg}` }],
            details: { action: "backward", taskFamily: tf, reward, changedEdges: edgeUpdate.changedEdges, changedNodes: manualChangedNodes },
          };
        }

        default:
          return { content: [{ type: "text", text: `Unknown action: ${(params as any).action}` }], details: { error: "unknown action" } };
      }
    },

    renderCall(args, theme, _context) {
      const a = (args as any).action || "";
      const icon = a === "status" ? "📊" : a === "list" ? "📋" : a === "init" ? "✨" : a === "backward" ? "🔄" : "";
      const label = a.charAt(0).toUpperCase() + a.slice(1);
      const tf = (args as any).taskFamily || "";
      return new Text(theme.fg("accent", `${icon} Textron ${label}`) + (tf ? theme.fg("muted", ` ${tf}`) : ""), 0, 0);
    },
  });
}
