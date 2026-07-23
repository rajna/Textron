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

import { chooseTaskFamilyRoute } from "./learning_policy";
import { assistantMessageText, extractHighEntropy, extractLatestHighEntropyFromMessages, parseHighEntropyCrystal } from "./highentropy";
import { distillNodeName, buildAtomKey } from "./name_distill.ts";
import { applyExplorationPolicy, buildLocalScores, lexicalRelevance, parseNodeScores, rankLayerWithExploration } from "./scoring_policy";
import { routeL0ThroughMoe } from "./moe_router.ts";
import { decideNoveltyExpansion } from "./novelty_policy.ts";
import { DEFAULT_COMPILED_CONTEXT_MAX_CHARS, NODE_CONTENT_MAX_CHARS } from "./content_limits.ts";

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
const NGRAM_DISTILL_PROMOTE = true;
// Growth enabled: new nodes created for novel patterns, preventing knowledge stagnation.
const TEXTRON_ALLOW_NODE_GROWTH = true;

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
  // Keyword-distilled name (name_distill.ts) — a retrieval key seen by L0
  // scoring/routing/dedup, NOT a crude first-48-chars truncation.
  return distillNodeName(content);
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

function validateKnowledgeCrystal(raw: string, targetLayer?: number): { ok: boolean; content: string; reason?: string } {
  const content = String(raw || "").replace(/\s+/g, " ").trim();
  if (!content) return { ok: false, content, reason: "empty" };
  const minLen = targetLayer === 0 ? 18 : 28;
  if (content.length < minLen) return { ok: false, content, reason: "too_short" };
  if (content.length > NODE_CONTENT_MAX_CHARS) return { ok: false, content, reason: "too_long_session_summary" };

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

// ─── Scale-Rescue (Wang–Zahl inspired) ─────────────────────────────
// 王虹–Zahl 3D Kakeya 证明的核心元操作:任意集合在【正确的尺度】下都有分形结构。
// 映射到知识蒸馏:gate 拒绝的文本不是垃圾,而是选错了分析尺度——蒸馏失败换尺度重试:
//   downscale(太杂: too_long/low_entropy/操作日志/时序摘要/截断/meta指令)
//     → 提取高熵关键词,写成原子锚点节点(atom key,检索价值高,无泛话)
//   upscale(太泛: too_short/not_transferable,信息量不足以独立成节点)
//     → 入 _rescale_pending.json 缓冲;同层相似片段配对合并成主题节点再过 gate
// 参考: arXiv:2502.17655 主定理(任意凸集并的体积估计)远超 Kakeya 猜想本身。

const RESCALE_DOWN_REASONS = new Set([
  "too_long_session_summary",
  "raw_operational_trace",
  "temporal_session_summary",
  "truncated_mid_thought",
  "meta_instruction_not_knowledge",
  "low_entropy",
  "low_word_entropy",
]);
const RESCALE_UP_REASONS = new Set(["too_short", "not_transferable_experience"]);
const RESCALE_PENDING_LIMIT = 20;
const RESCALE_PAIR_MIN_SIM = 0.2;

interface RescalePendingItem { content: string; layer: number; reason: string; ts: string; }

function rescalePendingPath(netPath: string): string { return path.join(netPath, "_rescale_pending.json"); }
function readRescalePending(netPath: string): RescalePendingItem[] {
  const items = readJson<RescalePendingItem[]>(rescalePendingPath(netPath), []);
  return Array.isArray(items) ? items : [];
}
function writeRescalePending(netPath: string, items: RescalePendingItem[]): void {
  writeJson(rescalePendingPath(netPath), items.slice(-RESCALE_PENDING_LIMIT));
}

/** Upscale: buffer a too-generic fragment; pair with a similar same-layer fragment → theme node. */
function tryUpscalePair(
  net: NonNullable<ReturnType<typeof loadNetwork>>,
  item: RescalePendingItem,
  onLog: (msg: string) => void,
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
    pending.push(partner); // pair failed validation — partner stays buffered
  }
  pending.push(item);
  writeRescalePending(net.path, pending);
  return { rescued: false };
}

/**
 * Scale-rescue entry. Called wherever validateKnowledgeCrystal rejects content.
 * Returns null when the rejection reason is not rescaleable (e.g. empty).
 */
function rescaleRejectedCrystal(
  net: NonNullable<ReturnType<typeof loadNetwork>>,
  content: string,
  reason: string | undefined,
  targetLayer: number,
  onLog: (msg: string) => void,
): { rescued: boolean; action: string; nodeId?: string; layer?: number } | null {
  const baseReason = String(reason || "").replace(/\(.*\)$/, ""); // low_entropy(2.1) → low_entropy
  if (RESCALE_DOWN_REASONS.has(baseReason)) {
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
    const up = tryUpscalePair(net, item, onLog);
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

const HIGH_ENTROPY_INSTRUCTION = `

## Textron HighEntropy Output Contract
At the very end of your final user-facing answer, append exactly one XML block. Textron backward consumes it as training data. Distill ONLY the current answer; never echo TextronSkill/history/tool logs or write a session summary.
<HighEntropy>
Name: ≤48 chars. Join 3-6 highest-entropy ORIGINAL terms lifted from Task+Technique (identifiers, domain signals, key numbers). Routing sees only Name, so avoid generic summary sentences or prefix truncation.
TaskType: ≤15 chars. Task category label for feedback matching, e.g. "A股涨跌预测" "Textron协议修复" "代码审查". Write in the language of the task domain.
isTask: true|false. Whether this reply is part of a task that may receive follow-up feedback. true = save to taskStack for later backward matching; false = intermediate/transient reply, do not push.
Task: ≤100 chars. State the concrete problem being solved: object, goal, and decisive constraint. Do not narrate steps taken.
Technique: ≤500 chars. Preserve the highest-information "道或术" used to solve the task: reusable principle plus concrete method, causal mechanism, decision boundary, failure correction, and validation signal. Prefer the answer's most information-dense sentences and distinctive vocabulary; keep exact identifiers/numbers when they change future decisions. No raw logs, file lists, URLs, vague progress, or boilerplate.
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

// ─── PageRank ─────────────────────────────────────────────────────

/** Compute PageRank scores for all nodes in the network.
 *  Treats each node as a web page, edges as links with weights.
 *  Blended with LLM scores to prevent activation cold-start. */
function computePageRank(
  net: NonNullable<ReturnType<typeof loadNetwork>>,
): Record<string, number> {
  const layers = net.hyperparams.layers;
  const totalNodes = layers.reduce((a, b) => a + b, 0);
  const nodeIds: string[] = [];
  const nodeIndex = new Map<string, number>();

  // Build flat node index
  for (let l = 0; l < layers.length; l++) {
    for (let n = 0; n < layers[l]; n++) {
      const key = `L${l}::node_${n}`;
      nodeIndex.set(key, nodeIds.length);
      nodeIds.push(key);
    }
  }

  // Build adjacency matrix (sparse representation: outLinks[from] = [{to, weight}])
  const outLinks: { to: number; weight: number }[][] = Array.from({ length: totalNodes }, () => []);
  for (const [edgeKey, edges] of Object.entries(net.weights.layer_connections)) {
    const [fromL, toL] = edgeKey.split('_to_').map(Number);
    for (const e of edges) {
      const fromKey = `L${fromL}::${e.from}`;
      const toKey = `L${toL}::${e.to}`;
      const fi = nodeIndex.get(fromKey);
      const ti = nodeIndex.get(toKey);
      if (fi !== undefined && ti !== undefined && e.weight > 0) {
        outLinks[fi].push({ to: ti, weight: e.weight });
      }
    }
  }

  // Power iteration
  const damping = 0.85;
  const epsilon = 1e-6;
  const maxIter = 100;
  let pr = new Array(totalNodes).fill(1 / totalNodes);

  for (let iter = 0; iter < maxIter; iter++) {
    const newPr = new Array(totalNodes).fill((1 - damping) / totalNodes);
    let maxDelta = 0;
    for (let i = 0; i < totalNodes; i++) {
      if (outLinks[i].length === 0) {
        // Dangling node: distribute PR to all nodes
        for (let j = 0; j < totalNodes; j++) newPr[j] += damping * pr[i] / totalNodes;
      } else {
        const totalWeight = outLinks[i].reduce((s, l) => s + l.weight, 0);
        if (totalWeight > 0) {
          for (const link of outLinks[i]) {
            newPr[link.to] += damping * pr[i] * (link.weight / totalWeight);
          }
        }
      }
    }
    for (let i = 0; i < totalNodes; i++) {
      maxDelta = Math.max(maxDelta, Math.abs(newPr[i] - pr[i]));
    }
    pr = newPr;
    if (maxDelta < epsilon) break;
  }

  // Normalize to 0-1 range
  const maxPr = Math.max(...pr, 1e-10);
  const result: Record<string, number> = {};
  for (let i = 0; i < totalNodes; i++) {
    result[nodeIds[i]] = pr[i] / maxPr;
  }
  return result;
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
  const s = completeContent(String(content || "").replace(/\s+/g, " ").trim(), NODE_CONTENT_MAX_CHARS);
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
  const contextBudget = Math.max(1000, Number(process.env.TEXTRON_COMPILED_CONTEXT_MAX_CHARS) || DEFAULT_COMPILED_CONTEXT_MAX_CHARS);
  for (const item of lines) {
    const prefix = `<SkillNode id="${item.id}" layer="${item.layer}">\nName: ${item.name}\nContent: `;
    const suffix = `\n</SkillNode>\n`;
    const remaining = contextBudget - ctx.length - prefix.length - suffix.length - `</TextronSkill>`.length;
    if (remaining < 80) break;
    ctx += prefix + completeContent(item.content, Math.min(NODE_CONTENT_MAX_CHARS, remaining)) + suffix;
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

// ─── Auto Backward Propagation (moved below after helpers) ────────────
// See expanded autoBackward() defined right before forcedSemanticBackward().
// It now handles edge weights + node content CRUD in a single pass.

// ─── Vector Similarity (TF-IDF cosine) ────────────────────────────

/** Shared TF-IDF tokenizer: alnum words kept whole; CJK runs become character
 *  bigrams (Chinese has no whitespace — whole-run tokens never match across
 *  docs, which made cosine≈0 and emptied the RELATED merge/delete candidates). */
function tfidfTokens(text: string): string[] {
  const s = (text || "").toLowerCase();
  const out: string[] = [];
  const runs = s.match(/[a-z0-9]+|[一-鿿]+/g) || [];
  for (const run of runs) {
    if (/^[a-z0-9]+$/.test(run)) {
      if (run.length > 1) out.push(run);
    } else if (run.length === 2) {
      out.push(run);
    } else {
      for (let i = 0; i < run.length - 1; i++) out.push(run.slice(i, i + 2));
    }
  }
  return out;
}

/** Build TF-IDF vectors for all node contents. Returns { vocab, idf, nodeVectors }. */
function buildTfidfIndex(net: NonNullable<ReturnType<typeof loadNetwork>>): {
  vocab: string[];
  idf: Float64Array;
  nodeVectors: Map<string, Float64Array>;
} {
  const layerCount = net.hyperparams.layers.length;
  const allDocs: { key: string; tokens: string[] }[] = [];

  for (let l = 0; l < layerCount; l++) {
    for (let n = 0; n < net.hyperparams.layers[l]; n++) {
      const np = path.join(net.path, `layer_${l}`, `node_${n}.html`);
      const content = readNodeContent(np);
      if (!content) continue;
      const name = readNodeName(np) || "";
      // Combine name + content for richer representation
      const text = `${name} ${content}`.toLowerCase();
      const tokens = tfidfTokens(text);
      if (tokens.length === 0) continue;
      allDocs.push({ key: `L${l}::node_${n}`, tokens });
    }
  }

  if (allDocs.length === 0) return { vocab: [], idf: new Float64Array(0), nodeVectors: new Map() };

  // Build vocabulary
  const termSet = new Set<string>();
  for (const doc of allDocs) for (const t of doc.tokens) termSet.add(t);
  const vocab = [...termSet];
  const termIndex = new Map<string, number>();
  vocab.forEach((t, i) => termIndex.set(t, i));

  const N = allDocs.length;
  // Compute DF (document frequency)
  const df = new Float64Array(vocab.length);
  for (const doc of allDocs) {
    const seen = new Set<string>();
    for (const t of doc.tokens) {
      if (!seen.has(t) && termIndex.has(t)) {
        df[termIndex.get(t)!]++;
        seen.add(t);
      }
    }
  }

  // Compute IDF
  const idf = new Float64Array(vocab.length);
  for (let i = 0; i < vocab.length; i++) {
    idf[i] = Math.log((N + 1) / (df[i] + 1)) + 1; // smooth IDF
  }

  // Build TF-IDF vectors
  const nodeVectors = new Map<string, Float64Array>();
  for (const doc of allDocs) {
    const tf = new Float64Array(vocab.length);
    for (const t of doc.tokens) {
      const idx = termIndex.get(t);
      if (idx !== undefined) tf[idx]++;
    }
    // Normalize TF then multiply by IDF
    const norm = Math.sqrt(tf.reduce((s, v) => s + v * v, 0)) || 1;
    const vec = new Float64Array(vocab.length);
    for (let i = 0; i < vocab.length; i++) {
      vec[i] = (tf[i] / norm) * idf[i];
    }
    nodeVectors.set(doc.key, vec);
  }

  return { vocab, idf, nodeVectors };
}

/** Compute cosine similarity between two TF-IDF vectors. */
function cosineSim(a: Float64Array, b: Float64Array): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom > 0 ? dot / denom : 0;
}

/** Compute TF-IDF cosine similarity between new content and existing nodes.
 *  Returns a map of node keys to similarity scores. */
function tfidfSimilarity(
  net: NonNullable<ReturnType<typeof loadNetwork>>,
  newName: string,
  newContent: string,
): Map<string, number> {
  const index = buildTfidfIndex(net);
  if (index.vocab.length === 0) return new Map();

  // Build vector for new content
  const text = `${newName} ${newContent}`.toLowerCase();
  const tokens = tfidfTokens(text);
  const termIndex = new Map<string, number>();
  index.vocab.forEach((t, i) => termIndex.set(t, i));

  const tf = new Float64Array(index.vocab.length);
  for (const t of tokens) {
    const idx = termIndex.get(t);
    if (idx !== undefined) tf[idx]++;
  }
  const norm = Math.sqrt(tf.reduce((s, v) => s + v * v, 0)) || 1;
  const newVec = new Float64Array(index.vocab.length);
  for (let i = 0; i < index.vocab.length; i++) {
    newVec[i] = (tf[i] / norm) * index.idf[i];
  }

  const scores = new Map<string, number>();
  for (const [key, vec] of index.nodeVectors) {
    scores.set(key, cosineSim(newVec, vec));
  }
  return scores;
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
  // Use TF-IDF cosine similarity for cross-layer semantic matching
  const scores = tfidfSimilarity(net, name, name); // name-only similarity for findSimilarNode
  let best: { layer: number; nodeId: string; score: number; name: string } | null = null;
  for (const [key, score] of scores) {
    if (score < minScore) continue;
    const parsed = parseLayerNodeId(key);
    if (!parsed) continue;
    const np = path.join(net.path, `layer_${parsed.layer}`, `${parsed.nodeId}.html`);
    const existingName = readNodeName(np);
    if (!existingName) continue;
    if (!best || score > best.score) best = { layer: parsed.layer, nodeId: parsed.nodeId, score, name: existingName };
  }
  return best;
}

function findSimilarKnowledgeNode(
  net: NonNullable<ReturnType<typeof loadNetwork>>,
  name: string,
  content: string,
  minScore = 0.40,
  targetLayer?: number,
  excludeNodeId?: string,
): { layer: number; nodeId: string; score: number; name: string; content: string } | null {
  // TF-IDF cosine similarity for semantic merge (replaces jaccard)
  const scores = tfidfSimilarity(net, name, content);
  let best: { layer: number; nodeId: string; score: number; name: string; content: string } | null = null;
  for (const [key, score] of scores) {
    if (score < minScore) continue;
    const parsed = parseLayerNodeId(key);
    if (!parsed) continue;
    if (parsed.nodeId === excludeNodeId) continue;
    const nodePath = path.join(net.path, `layer_${parsed.layer}`, `${parsed.nodeId}.html`);
    const existingContent = readNodeContent(nodePath);
    if (!existingContent) continue;
    const existingName = readNodeName(nodePath) || compressNodeName(existingContent);
    if (!best || score > best.score) {
      best = { layer: parsed.layer, nodeId: parsed.nodeId, score, name: existingName, content: existingContent };
    }
  }
  return best;
}

function normalizeMergeFragment(fragment: string): string {
  return String(fragment || "").replace(/\s+/g, "").replace(/[，。！？；、,.!?;：:]/g, "").toLowerCase();
}

function mergeDistinctContentFragments(oldContent: string, newContent: string): string {
  const oldParts = String(oldContent || "").split(/\s*[|；;]\s*/).map((p) => p.trim()).filter(Boolean);
  const newParts = String(newContent || "").split(/\s*[|；;]\s*/).map((p) => p.trim()).filter(Boolean);
  const seen = new Set<string>();
  const out: string[] = [];
  const pushPart = (part: string) => {
    const key = normalizeMergeFragment(part);
    if (!key || seen.has(key)) return;
    if (out.some((existing) => normalizeMergeFragment(existing).includes(key))) return;
    const shorterCovered = out.some((existing) => key.includes(normalizeMergeFragment(existing)) && key.length > normalizeMergeFragment(existing).length);
    if (shorterCovered) return;
    seen.add(key);
    out.push(part);
  };
  for (const part of oldParts) pushPart(part);
  for (const part of newParts) pushPart(part);
  return out.join(" | ");
}

function mergeNodeContent(oldContent: string, newContent: string): string {
  const oldS = (oldContent || "").trim();
  const newS = (newContent || "").trim();
  if (!oldS) return completeContent(newS, NODE_CONTENT_MAX_CHARS);
  if (!newS || oldS.includes(newS)) return completeContent(oldS, NODE_CONTENT_MAX_CHARS);
  if (newS.includes(oldS)) return completeContent(newS, NODE_CONTENT_MAX_CHARS);
  const deduped = mergeDistinctContentFragments(oldS, newS);
  if (deduped.length <= NODE_CONTENT_MAX_CHARS) return deduped;
  return mergeContent(deduped, newS);
}

/** Module-level mergeContent (same as above but uses completeContent + stale detection). */
function mergeContent(oldContent: string, newContent: string): string {
  if (!oldContent) return completeContent(newContent, NODE_CONTENT_MAX_CHARS);
  if (oldContent === newContent) return oldContent;
  // If old content is low-quality, prefer new
  const oldQuality = validateKnowledgeCrystal(oldContent);
  if (!oldQuality.ok) return completeContent(newContent, NODE_CONTENT_MAX_CHARS);
  const oldSet = new Set(oldContent.toLowerCase().split(/\s+/));
  const newSet = new Set(newContent.toLowerCase().split(/\s+/));
  let newTokens = 0;
  for (const w of newSet) if (!oldSet.has(w)) newTokens++;
  const overlap = 1 - newTokens / Math.max(1, newSet.size);
  if (overlap >= 0.6) {
    const fresh = [...newSet].filter(w => !oldSet.has(w)).join(" ");
    if (fresh && (oldContent + "; " + fresh).length <= NODE_CONTENT_MAX_CHARS) return completeContent(oldContent + "; " + fresh, NODE_CONTENT_MAX_CHARS);
    return completeContent(oldContent, NODE_CONTENT_MAX_CHARS);
  }
  const newQuality = validateKnowledgeCrystal(newContent);
  if (!newQuality.ok && oldQuality.ok) return completeContent(oldContent, NODE_CONTENT_MAX_CHARS);
  const combined = oldContent + " | " + newContent;
  if (combined.length <= NODE_CONTENT_MAX_CHARS) return combined;
  const sideBudget = Math.floor((NODE_CONTENT_MAX_CHARS - 3) / 2);
  const oldHead = completeContent(oldContent, sideBudget);
  const newHead = completeContent(newContent, sideBudget);
  return completeContent(`${oldHead} | ${newHead}`, NODE_CONTENT_MAX_CHARS);
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
  const oldContent = readNodeContent(nodePath);
  const oldName = readNodeName(nodePath);
  const mergedContent = mergeNodeContent(oldContent, content);
  // Merge names: distill old + new keywords, not blind replace
  const mergedNameRaw = name && oldName
    ? distillNodeName(`${oldName} ${name}`, 64)
    : (name || oldName || compressNodeName(mergedContent));
  const finalName = mergedNameRaw.slice(0, 64);
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
  // Default to deepest concrete store when no layer specified. LLM can request any layer,
  // including L0 for domain-defining signals (star patterns, trend structures, volume-quality).
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
  const similar = findSimilarKnowledgeNode(net, nodeName, content, options?.similarityThreshold ?? 0.40, targetLayer);
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
    if (oldQuality.ok && weakestScore >= 0.15) {
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
/**
 * Compact only specific nodes that were emptied by merge operations in the current
 * backward pass. Unlike compactEmptyNodes (which deletes ALL empty nodes including
 * unfilled slots), this only removes nodes explicitly listed in emptiedNodes.
 *
 * This prevents the "random deletion" bug where pre-existing empty slots
 * (nodes never filled with knowledge) were wiped out by every backward pass.
 */
function compactMergeEmptiedNodes(
  net: NonNullable<ReturnType<typeof loadNetwork>>,
  emptiedNodes: { layer: number; nodeId: string }[],
  onLog: (msg: string) => void,
): number {
  if (emptiedNodes.length === 0) return 0;

  // Group by layer
  const byLayer = new Map<number, Set<string>>();
  for (const { layer, nodeId } of emptiedNodes) {
    if (!byLayer.has(layer)) byLayer.set(layer, new Set());
    byLayer.get(layer)!.add(nodeId);
  }

  // Verify each candidate is actually empty (safety check)
  const confirmedEmpty: { layer: number; nodeId: string }[] = [];
  for (const [layer, nodeIds] of byLayer) {
    for (const nodeId of nodeIds) {
      const np = path.join(net.path, `layer_${layer}`, `${nodeId}.html`);
      const content = readNodeContent(np);
      if (!content || content.trim().length === 0) {
        confirmedEmpty.push({ layer, nodeId });
      } else {
        // Node was re-filled since merge — skip compaction
        onLog(`Textron compact: skipped ${nodeId} in L${layer} — content restored since merge`);
      }
    }
  }
  if (confirmedEmpty.length === 0) return 0;

  // For each layer, remove only the confirmed empty nodes and reindex
  let removedTotal = 0;
  const layerSnapshots = new Map<number, { oldId: string; name: string; content: string }[]>();

  for (let layer = 0; layer < net.hyperparams.layers.length; layer++) {
    const kept: { oldId: string; name: string; content: string }[] = [];
    const toRemove = new Set<string>();
    for (const e of confirmedEmpty) if (e.layer === layer) toRemove.add(e.nodeId);
    for (let n = 0; n < net.hyperparams.layers[layer]; n++) {
      const oldId = `node_${n}`;
      if (toRemove.has(oldId)) continue; // skip merge-emptied node
      const np = path.join(net.path, `layer_${layer}`, `${oldId}.html`);
      const content = readNodeContent(np);
      kept.push({ oldId, name: readNodeName(np) || "", content: content || "" });
    }
    layerSnapshots.set(layer, kept);
    removedTotal += Math.max(0, net.hyperparams.layers[layer] - kept.length);
    net.hyperparams.layers[layer] = kept.length;
  }

  if (removedTotal === 0) return 0;

  // Rebuild weights with reindexed nodes
  const remaps = new Map<number, Map<string, string>>();
  for (let layer = 0; layer < net.hyperparams.layers.length; layer++) {
    const kept = layerSnapshots.get(layer) || [];
    const remap = new Map<string, string>();
    kept.forEach((node, idx) => remap.set(node.oldId, `node_${idx}`));
    remaps.set(layer, remap);
  }

  const nextWeights: WeightsFile = { layer_connections: {} };
  for (const [key, edges] of Object.entries(net.weights.layer_connections)) {
    const m = key.match(/^(\d+)_to_(\d+)$/);
    if (!m) continue;
    const fromL = parseInt(m[1], 10);
    const toL = parseInt(m[2], 10);
    const fromMap = remaps.get(fromL) || new Map<string, string>();
    const toMap = remaps.get(toL) || new Map<string, string>();
    const dedup = new Map<string, Edge>();
    for (const edge of edges) {
      const from = fromMap.get(edge.from);
      const to = toMap.get(edge.to);
      if (!from || !to) continue;
      const eid = `${from}->${to}`;
      const prev = dedup.get(eid);
      if (!prev || Math.abs(edge.weight) > Math.abs(prev.weight)) dedup.set(eid, { from, to, weight: edge.weight });
    }
    nextWeights.layer_connections[key] = [...dedup.values()];
  }
  net.weights = nextWeights;

  // Rewrite layer directories — only the layers that had removals
  for (let layer = 0; layer < net.hyperparams.layers.length; layer++) {
    const toRemove = new Set<string>();
    for (const e of confirmedEmpty) if (e.layer === layer) toRemove.add(e.nodeId);
    if (toRemove.size === 0) continue;
    const layerDir = path.join(net.path, `layer_${layer}`);
    // Delete ALL node files (we'll rewrite the kept ones with reindexed IDs)
    for (const file of fs.readdirSync(layerDir)) {
      if (/^node_\d+\.(html|ngram\.json)$/.test(file)) fs.rmSync(path.join(layerDir, file), { force: true });
    }
    const kept = layerSnapshots.get(layer) || [];
    for (let n = 0; n < kept.length; n++) {
      const nodeId = `node_${n}`;
      const outEdges = (net.weights.layer_connections[`${layer}_to_${layer + 1}`] || [])
        .filter((e) => e.from === nodeId)
        .map((e) => ({ toId: e.to, weight: e.weight }));
      writeNodeHtml(path.join(layerDir, `${nodeId}.html`), layer, nodeId, kept[n].content, outEdges, kept[n].name || compressNodeName(kept[n].content));
    }
  }

  net.hyperparams.updatedAt = new Date().toISOString();
  writeJson(path.join(net.path, "weights.json"), net.weights);
  writeJson(path.join(net.path, "hyperparams.json"), net.hyperparams);
  onLog(`Textron compact: removed ${removedTotal} merge-emptied node(s) from "${path.basename(net.path)}"`);
  return removedTotal;
}

function compactEmptyNodes(
  net: NonNullable<ReturnType<typeof loadNetwork>>,
  onLog: (msg: string) => void,
): number {
  let removedTotal = 0;
  const layerSnapshots = new Map<number, { oldId: string; name: string; content: string }[]>();

  for (let layer = 0; layer < net.hyperparams.layers.length; layer++) {
    const kept: { oldId: string; name: string; content: string }[] = [];
    for (let n = 0; n < net.hyperparams.layers[layer]; n++) {
      const oldId = `node_${n}`;
      const np = path.join(net.path, `layer_${layer}`, `${oldId}.html`);
      const content = readNodeContent(np);
      if (content) kept.push({ oldId, name: readNodeName(np), content });
    }
    layerSnapshots.set(layer, kept);
  }

  const remaps = new Map<number, Map<string, string>>();
  for (let layer = 0; layer < net.hyperparams.layers.length; layer++) {
    const kept = layerSnapshots.get(layer) || [];
    const remap = new Map<string, string>();
    kept.forEach((node, idx) => remap.set(node.oldId, `node_${idx}`));
    remaps.set(layer, remap);
    removedTotal += Math.max(0, net.hyperparams.layers[layer] - kept.length);
    net.hyperparams.layers[layer] = kept.length;
  }

  if (removedTotal === 0) return 0;

  const nextWeights: WeightsFile = { layer_connections: {} };
  for (const [key, edges] of Object.entries(net.weights.layer_connections)) {
    const m = key.match(/^(\d+)_to_(\d+)$/);
    if (!m) continue;
    const fromL = parseInt(m[1], 10);
    const toL = parseInt(m[2], 10);
    const fromMap = remaps.get(fromL) || new Map<string, string>();
    const toMap = remaps.get(toL) || new Map<string, string>();
    const dedup = new Map<string, Edge>();
    for (const edge of edges) {
      const from = fromMap.get(edge.from);
      const to = toMap.get(edge.to);
      if (!from || !to) continue;
      const eid = `${from}->${to}`;
      const prev = dedup.get(eid);
      if (!prev || Math.abs(edge.weight) > Math.abs(prev.weight)) dedup.set(eid, { from, to, weight: edge.weight });
    }
    nextWeights.layer_connections[key] = [...dedup.values()];
  }
  net.weights = nextWeights;

  for (let layer = 0; layer < net.hyperparams.layers.length; layer++) {
    const layerDir = path.join(net.path, `layer_${layer}`);
    ensureDir(layerDir);
    for (const file of fs.readdirSync(layerDir)) {
      if (/^node_\d+\.(html|ngram\.json)$/.test(file)) fs.rmSync(path.join(layerDir, file), { force: true });
    }
    const kept = layerSnapshots.get(layer) || [];
    for (let n = 0; n < kept.length; n++) {
      const nodeId = `node_${n}`;
      const outEdges = (net.weights.layer_connections[`${layer}_to_${layer + 1}`] || [])
        .filter((e) => e.from === nodeId)
        .map((e) => ({ toId: e.to, weight: e.weight }));
      writeNodeHtml(path.join(layerDir, `${nodeId}.html`), layer, nodeId, kept[n].content, outEdges, kept[n].name || compressNodeName(kept[n].content));
    }
  }

  net.hyperparams.updatedAt = new Date().toISOString();
  writeJson(path.join(net.path, "weights.json"), net.weights);
  writeJson(path.join(net.path, "hyperparams.json"), net.hyperparams);
  onLog(`Textron compact: removed ${removedTotal} empty node(s) and reindexed layers in "${path.basename(net.path)}"`);
  return removedTotal;
}

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
  const raw = String(text || "").toLowerCase();
  const words = raw.split(/[\s,，。！？、:：;；()\[\]{}<>"'`/\\|+=_-]+/).filter(w => w.length > 1);
  // CJK crystals often contain no spaces; add character bigrams so valid Chinese
  // high-entropy rules are not rejected as one or two low-entropy "words".
  const cjkRuns = raw.match(/[\u4e00-\u9fff]{2,}/g) || [];
  for (const run of cjkRuns) {
    for (let i = 0; i < run.length - 1; i++) words.push(run.slice(i, i + 2));
  }
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
  // Only flag CJK when it ends with a continuation marker. Short Chinese
  // HighEntropy crystals commonly omit final punctuation but are still complete.
  const cjkCount = (s.match(/[\u4e00-\u9fff]/g) || []).length;
  if (cjkCount > 0 && cjkCount / s.length > 0.6 && /(?:因为|如果|需要|通过|以及|并且|或者|但|而|与|和|及|的|地|得|了)$/.test(s)) return true;
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
  let currentRouteUncertain = false;
  let currentMoeMaxScore = 0;
  // ── Task Stack: multi-task feedback pairing (replaces single-pending slot) ──
  interface TaskEntry {
    taskType: string;         // ≤15 chars, from HighEntropy, for LLM fast matching
    taskFamily: string;
    rawUserPrompt: string;
    effectivePrompt: string;
    highEntropy: string;
    activatedIds: string[];
    selectedEdgeIds: string[];
    routeUncertain: boolean;
    moeMaxScore: number;
    ts: string;
  }
  const MAX_TASK_STACK = 5;
  let activeTask: TaskEntry | null = null;
  let taskStack: TaskEntry[] = [];  // FIFO, max MAX_TASK_STACK
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
  let _monitorEventWriteFailed = false;
  function recordMonitorEvent(data: Record<string, unknown>) {
    try {
      ensureDir(TEXTRON_HOME);
      const line = JSON.stringify({ ...data, ts: new Date().toISOString() }) + "\n";
      fs.appendFileSync(EVENTS_PATH, line, "utf-8");
      // 旁路心跳文件：每次成功写入更新 mtime，用于诊断是否真的在写入
      if (!_monitorEventWriteFailed) {
        try { fs.writeFileSync(path.join(TEXTRON_HOME, "_events_heartbeat"), line.slice(0, 200), "utf-8"); } catch {}
      }
    } catch (e) {
      _monitorEventWriteFailed = true;
      const errMsg = (e as Error).message || String(e);
      console.error(`[textron] recordMonitorEvent failed: ${errMsg}`, { path: EVENTS_PATH, size: fs.existsSync(EVENTS_PATH) ? fs.statSync(EVENTS_PATH).size : -1 });
      // 旁路写入失败日志
      try { fs.appendFileSync(path.join(TEXTRON_HOME, "_events_error.log"), `${new Date().toISOString()} | ${errMsg}\n`, "utf-8"); } catch {}
    }
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
  function forwardTopK(): number {
    const raw = Number(process.env.TEXTRON_FORWARD_TOP_K || "3");
    return Number.isFinite(raw) ? Math.max(1, Math.min(8, Math.floor(raw))) : 3;
  }
  function routeAbstainScore(): number {
    const raw = Number(process.env.TEXTRON_ROUTE_ABSTAIN_SCORE || "0.08");
    return Number.isFinite(raw) ? Math.max(0, Math.min(1, raw)) : 0.08;
  }
  function moeExpertCount(): number | undefined {
    const raw = Number(process.env.TEXTRON_MOE_EXPERTS || "0");
    return Number.isFinite(raw) && raw > 0 ? Math.max(1, Math.min(16, Math.floor(raw))) : undefined;
  }
  function moeTopK(): number {
    const raw = Number(process.env.TEXTRON_MOE_TOP_K || "2");
    return Number.isFinite(raw) ? Math.max(1, Math.min(8, Math.floor(raw))) : 2;
  }
  function downstreamRelevanceFloor(): number {
    const raw = Number(process.env.TEXTRON_DOWNSTREAM_RELEVANCE_FLOOR || "0.015");
    return Number.isFinite(raw) ? Math.max(0, Math.min(0.2, raw)) : 0.015;
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
  function readMonitorEvents(limit = 60): Record<string, unknown>[] {
    try {
      if (!fs.existsSync(EVENTS_PATH)) return [];
      const lines = fs.readFileSync(EVENTS_PATH, "utf-8").trim().split("\n").filter(Boolean).slice(-limit);
      return lines.map((line) => JSON.parse(line)).filter((e) => e && typeof e === "object");
    } catch { return []; }
  }
  function monitorEventTime(e: Record<string, unknown> | null | undefined): number {
    if (!e) return 0;
    const raw = e.ts || e.at || e.startedAt;
    const ms = typeof raw === "string" ? Date.parse(raw) : 0;
    return Number.isFinite(ms) ? ms : 0;
  }
  function isBackwardStateEvent(e: Record<string, unknown> | null | undefined): boolean {
    if (!e) return false;
    const action = String(e.action || "");
    return action === "semantic_backward" || action === "semantic_backward_start" || action === "semantic_backward_done" || action === "semantic_backward_failed";
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
    const latestBackwardFromLog = [...monitorEvents].reverse().find((e) => isBackwardStateEvent(e)) || null;
    const latestBackward = monitorEventTime(lastBackwardState) >= monitorEventTime(latestBackwardFromLog)
      ? lastBackwardState
      : latestBackwardFromLog;
    const backwardByTaskFamily: Record<string, unknown> = {};
    for (const e of monitorEvents) {
      if (!isBackwardStateEvent(e) || !e.taskFamily) continue;
      const key = String(e.taskFamily);
      const prev = backwardByTaskFamily[key] as Record<string, unknown> | undefined;
      if (!prev || monitorEventTime(e) >= monitorEventTime(prev)) backwardByTaskFamily[key] = e;
    }
    if (lastBackwardState?.taskFamily) {
      const key = String(lastBackwardState.taskFamily);
      const prev = backwardByTaskFamily[key] as Record<string, unknown> | undefined;
      if (!prev || monitorEventTime(lastBackwardState) >= monitorEventTime(prev)) backwardByTaskFamily[key] = lastBackwardState;
    }
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
    const effectiveNodeMutations = effectiveTaskFamily && latestBackward?.taskFamily === effectiveTaskFamily
      ? (latestBackward.nodeMutations || [])
      : [];
    return { currentTaskFamily: effectiveTaskFamily, currentActivatedIds: effectiveActivatedIds, currentActivationScores: effectiveScores, currentSelectedEdgeIds: effectiveSelectedEdgeIds, currentNodeMutations: effectiveNodeMutations, lastBackwardState: latestBackward, backwardByTaskFamily, backwardEvents: monitorEvents, networks };
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

  function autoRouteNetworkDecision(prompt: string, networks: string[], explicitTaskFamily?: string) {
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
    const route = chooseTaskFamilyRoute({ prompt, candidates, explicitTaskFamily, allowBestEffort: true });
    recordMonitorEvent({ type: "trace", action: "route_policy_decision", promptPreview: preview(prompt, 180), explicitTaskFamily: explicitTaskFamily || "", taskFamily: route.taskFamily || "", reason: route.reason, score: Number(route.score.toFixed(4)) });
    return route;
  }

  function autoRouteNetwork(prompt: string, networks: string[], explicitTaskFamily?: string): string | null {
    return autoRouteNetworkDecision(prompt, networks, explicitTaskFamily).taskFamily;
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

  // baseUrl may already end with a version segment (/v1, /v3, /v1beta...).
  // Never blind-append /v1 — volcengine ark uses /api/plan/v3 → /v3/v1/... = HTTP 404 empty body.
  function joinApiEndpoint(baseUrl: string, apiPath: string): string {
    const b = String(baseUrl).replace(/\/+$/, "");
    return /\/v\d+[a-z]*$/i.test(b) ? `${b}${apiPath}` : `${b}/v1${apiPath}`;
  }

  async function scoreL0WithLLM(
    l0Nodes,
    userPrompt,
    ctx,
    networkPath?: string,
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
    const endpoint = joinApiEndpoint(baseUrl, "/chat/completions");

    const { apiKey, source: apiKeySource } = await resolveModelApiKey(ctx, model);
    log(`Textron L0: model=${model.id} baseUrl=${model.baseUrl} provider=${model.provider} apiKey=${apiKeySource}`);

    const statsPath = networkPath ? path.join(networkPath, "_node_stats.json") : "";
    const nodeStats = readJson<Record<string, { success: number; failure: number }>>(statsPath, {});
    const nodesList = l0Nodes
      .map((n) => {
        const key = `L0::${n.id}`;
        const s = nodeStats[key];
        const statLine = s && (s.success + s.failure) > 0
          ? ` [战绩: 激活${s.success + s.failure}·成${s.success}·败${s.failure}]`
          : "";
        return `${n.id}: ${(n.name || compressNodeName(n.content) || "(empty)").slice(0, 80)}${statLine}`;
      })
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
      return parseNodeScores(rawParts.filter(Boolean).join("\n"));
    }

    const messages = [
      { role: "system", content: 'Score each Layer-0 node 0.0-1.0 by semantic relevance to the user task. Prefer a compact JSON object. If JSON is unavailable, return one score per line as L0::node_X=0.80. No explanation. Nodes with [战绩] showing high failure count score lower; high success scores higher.' },
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
      if (attempt.reasoningEffort) requestBody.reasoning_effort = "minimal";
      if (attempt.jsonMode) requestBody.response_format = { type: "json_object" };

      const res = await fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(requestBody),
        signal: AbortSignal.timeout(25000),
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
      const responsesEndpoint = joinApiEndpoint(baseUrl, "/responses");
      const requestBody: Record<string, unknown> = {
        model: model.id,
        input: messages,
        max_output_tokens: 512,
        reasoning: { effort: "minimal" },
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
        max_completion_tokens: 512,
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
        max_completion_tokens: 512,
        reasoning_effort: "minimal",
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
      const responsesEndpoint = joinApiEndpoint(baseUrl, "/responses");
      const requestBody: Record<string, unknown> = {
        model: model.id,
        input: messages,
        stream: true,
        max_output_tokens: 512,
        reasoning: { effort: "minimal" },
        text: { format: { type: "json_object" } },
      };
      const res = await fetch(responsesEndpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(requestBody),
        signal: AbortSignal.timeout(30000),
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
      { jsonMode: true, label: "json_mode/max_tokens/temp0", maxParam: "max_tokens" as const, tokens: 1024, temperature: true },
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

    // One bounded remote attempt, then deterministic local relevance.
    // Slow provider fallbacks remain opt-in for diagnostics only.
    // NOTE: json_mode with low max_tokens often triggers instruction-echo from deepseek models.
    // If the first attempt failed with parse error, try tool_call as a second quick attempt before local fallback.
    if (process.env.TEXTRON_L0_SLOW_FALLBACK !== "1" && errors.length > 0) {
      try {
        const normalized = await callToolScorer();
        log(`Textron: L0 scored via tool_call fallback (${Object.keys(normalized).length} nodes)`);
        recordMonitorEvent({ type: "trace", action: "l0_score_done", status: "ok", mode: "tool_call_fallback", provider: model.provider, durationMs: Date.now() - l0StartedMs, nonzeroCount: Object.values(normalized).filter((v) => Number(v) > 0).length, topScores: topScores(normalized), allZero: Object.values(normalized).every((v) => Number(v) <= 0) });
        return normalized;
      } catch (e2) {
        errors.push(`tool_call_fallback: ${(e2 as Error).message}`);
      }
    }
    if (process.env.TEXTRON_L0_SLOW_FALLBACK !== "1") {
      const localScores = buildLocalScores(String(userPrompt || ""), l0Nodes);
      recordMonitorEvent({
        type: "trace",
        action: "l0_score_local_fallback",
        provider: model.provider,
        durationMs: Date.now() - l0StartedMs,
        remoteErrors: errors.map((e) => preview(e, 180)),
        nonzeroCount: Object.values(localScores).filter((v) => v > 0).length,
        topScores: topScores(localScores),
      });
      return localScores;
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
  ): Promise<{ reward: number; rationale?: string; node_updates?: Record<string, string | { name?: string; content?: string; context?: string }>; add_nodes?: { layer: number; name?: string; content: string; context?: string }[]; node_actions?: { action: "merge" | "delete" | "keep"; source?: string; target?: string; node?: string; rationale?: string }[] }> {
    const model = (ctx as any).model || _textronModel;
    if (!model?.id || !model?.baseUrl) return { reward: 0, rationale: "no model" };

    const baseUrl = String(model.baseUrl).replace(/\/+$/, "");
    const chatEndpoint = joinApiEndpoint(baseUrl, "/chat/completions");
    const responsesEndpoint = joinApiEndpoint(baseUrl, "/responses");

    const { apiKey } = await resolveModelApiKey(ctx, model);

    const pathNodes = activatedIds.map((id) => {
      const parsed = parseLayerNodeId(id);
      const nodePath = parsed ? path.join(net.path, `layer_${parsed.layer}`, `${parsed.nodeId}.html`) : "";
      let content = parsed ? readNodeContent(nodePath) : "";
      let name = parsed ? readNodeName(nodePath) : "";
      // Cold-start virtual node: content is in previousTask, not on disk yet
      const isVirtual = parsed && !content && (parsed.nodeId.startsWith("_seed_") || parsed.nodeId.startsWith("_cold_"));
      if (isVirtual) {
        content = previousTask.slice(0, NODE_CONTENT_MAX_CHARS);
        name = compressNodeName(content);
      }
      return { id, name, content, parsed, isVirtual };
    });

    // ── Discover related nodes (TF-IDF similarity) for merge/delete candidates ──
    // For each selected path node, find top-3 similar nodes in the SAME layer
    // that are NOT on the selected path. LLM will decide: merge, delete, or keep.
    const pathNodeKeySet = new Set(activatedIds);
    const relatedNodes: { pathNodeId: string; relatedNodeId: string; layer: number; name: string; content: string; similarity: number }[] = [];
    for (const pn of pathNodes) {
      if (!pn.parsed) continue;
      const scores = tfidfSimilarity(net, pn.name, pn.content);
      const candidates: { key: string; score: number }[] = [];
      for (const [key, score] of scores) {
        if (score < 0.05) continue; // bigram tokenizer: related pairs ~0.12-0.20, noise p50~0.037
        if (pathNodeKeySet.has(key)) continue; // skip nodes already on selected path
        const rp = parseLayerNodeId(key);
        if (!rp || rp.layer !== pn.parsed.layer) continue; // same layer only for merge/delete
        candidates.push({ key, score });
      }
      candidates.sort((a, b) => b.score - a.score);
      for (const c of candidates.slice(0, 3)) {
        const rp = parseLayerNodeId(c.key)!;
        const np = path.join(net.path, `layer_${rp.layer}`, `${rp.nodeId}.html`);
        const rc = readNodeContent(np);
        if (!rc) continue;
        const rn = readNodeName(np) || compressNodeName(rc);
        relatedNodes.push({
          pathNodeId: pn.id,
          relatedNodeId: c.key,
          layer: rp.layer,
          name: rn,
          content: rc.slice(0, 80),
          similarity: Number(c.score.toFixed(3)),
        });
      }
    }

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
    });

    const previousCrystal = parseHighEntropyCrystal(previousAssistantHighEntropy ? `<HighEntropy>${previousAssistantHighEntropy}</HighEntropy>` : "");
    const schemaHint = '{"reward":0.0,"rationale":"≤80 chars","node_updates":{"L0::node_0":{"name":"<48 char","content":"<1000 char"}},"add_nodes":[{"layer":0,"name":"<48 char","content":"<1000 char"}],"node_actions":[{"action":"merge","source":"L1::node_3","target":"L1::node_6","rationale":"≤60 chars"}]}';
    // ── Build filtered existing nodes list (top-8 per layer by TF-IDF relevance) ──
    const existingNodesTfidf = tfidfSimilarity(net, previousTask.slice(0, 200), currentUserMessage.slice(0, 200));
    const promptExisting = [...Array(net.hyperparams.layers.length)].map((_, l) => {
      const nodes: { key: string; name: string; content: string; sim: number }[] = [];
      for (let n = 0; n < net.hyperparams.layers[l]; n++) {
        const np = path.join(net.path, `layer_${l}`, `node_${n}.html`);
        const c = readNodeContent(np);
        if (!c) continue;
        const key = `L${l}::node_${n}`;
        const name = readNodeName(np) || compressNodeName(c);
        const sim = existingNodesTfidf.get(key) || 0;
        nodes.push({ key, name, content: c, sim });
      }
      nodes.sort((a, b) => b.sim - a.sim);
      const shown = nodes.slice(0, 3);
      const hidden = nodes.length - shown.length;
      const lines = shown.map(n => `  ${n.key} [sim=${n.sim.toFixed(2)}]: ${n.name} — ${n.content.slice(0, 80)}`);
      if (hidden > 0) lines.push(`  ... (+${hidden} more in L${l})`);
      return lines.length ? `Layer ${l} (${nodes.length} nodes, top-${shown.length} by relevance):\n${lines.join("\n")}` : `Layer ${l}: (all empty)`;
    }).join("\n\n");

    const promptRelated = relatedNodes.length > 0
      ? relatedNodes.map(rn => `  ${rn.relatedNodeId} [sim=${rn.similarity} to ${rn.pathNodeId}]: ${rn.content}`).join("\n")
      : "(none)";

    const messages = [
      { role: "system", content: `You are Textron semantic backward. Output ONLY raw JSON, no markdown. Format: ${schemaHint}.

RULES:
1. Prefer node_updates over add_nodes. add_nodes ONLY for truly new concepts. NEVER propose delete — use merge(source→target) to deduplicate; the system auto-removes source after merging.
2. REWARD -1..1 from feedback. Negative=wrong, positive=correct. Off-topic→reward=-1,empty updates.
3. FAILURE→"avoid X→prefer Y". SUCCESS→encode WHY.
4. Content≤1000c. name=3-6 keywords from content≤48c. No templates/session summaries.
5. Choose layer by content abstraction: L0=compact reusable principle, L1=causal mechanism, L2=concrete rule.
6. L0 CRITICAL: If ALL existing L0 nodes are non-domain (engineering/communication/tooling) but this task clearly belongs to the taskFamily domain, you MUST add 1-2 new L0 domain nodes (e.g. "K线三维共振·星象三天窗口·相位净计数" or "放量破位三周期共振·新月相位群覆盖基线") to establish domain routing anchors. This takes PRIORITY over L2 tactic updates — without L0 domain nodes, forward propagation cannot route to domain knowledge, breaking the entire network.
7. MERGE DUTY: After producing node_updates, scan RELATED nodes for ≥30% overlap with your updates. For each such pair, add a merge action (source=more-specific-node → target=more-general-node). Missing obvious merges → node bloat.` },
      { role: "user", content: `Previous user task:\n${previousTask.slice(0, 1500)}\n\nPrevious assistant HighEntropy training packet:\n${previousCrystal.ok ? `Name: ${previousCrystal.name}\nTask: ${previousCrystal.task || "(legacy)"}\nTechnique: ${previousCrystal.technique}` : `(invalid/missing)`}\n\nEXISTING nodes (DO NOT duplicate):\n${promptExisting}\n\nRELATED nodes (may need merge to deduplicate):\n${promptRelated}\n\nSelected path nodes to update:\n${pathNodes.filter(n => !n.isVirtual).map(n => `${n.id}: ${n.name || "(empty)"}`).join("\n") || "(none)"}${pathNodes.some(n => n.isVirtual) ? `\n\nSEED node (not in network — use add_nodes to materialize):\n${pathNodes.filter(n => n.isVirtual).map(n => `  ${n.id}: ${n.name}\n  content: ${n.content.slice(0, 300)}`).join("\n")}` : ""}\n\nCurrent feedback:\n${currentUserMessage.slice(0, 2000)}\n\nDistill reusable experience. ALWAYS prefer node_updates over add_nodes (>30% overlap=update). FAILED→"avoid X→prefer Y". SUCCEEDED→encode winning mechanism. Content≤1000c, name=3-6 keywords≤48c.

MERGE SCAN (MANDATORY): Review RELATED nodes above. For EVERY pair with ≥30% semantic overlap, output a merge action in node_actions. If no merges needed, output node_actions=[{"action":"keep","rationale":"no overlap ≥30%"}]. node_actions MUST NOT be empty — this is a required output field.${pathNodes.some(n => n.isVirtual) ? `\n\nCOLD START: A SEED node is provided above. It is NOT yet in the network. You MUST add at least one L0 domain node from the SEED content using add_nodes.` : ""}` },
    ];

    // Log LLM input AFTER messages is fully constructed (was accidentally referenced before declaration — causing "Cannot access 'messages' before initialization")
    recordMonitorEvent({
      type: "trace",
      action: "semantic_backward_llm_input",
      taskFamily: path.basename(net.path),
      systemPromptChars: messages[0].content.length,
      userPromptChars: messages[1].content.length,
      modelId: model?.id,
      baseUrl: chatEndpoint,
    });

    function clampReward(v: unknown) { return clamp(Number(v) || 0, -1, 1); }
    function normalize(obj: any) {
      const out: { reward: number; rationale?: string; node_updates?: Record<string, string | { name?: string; content?: string; context?: string }>; add_nodes?: { layer: number; name?: string; content: string; context?: string }[]; node_actions?: { action: "merge" | "delete" | "keep"; source?: string; target?: string; node?: string; rationale?: string }[] } = {
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
            const content = completeContent(v.trim(), NODE_CONTENT_MAX_CHARS);
            const name = compressNodeName(content);
            if (content && name) out.node_updates[k] = { content, name };
          } else if (v && typeof v === "object") {
            const vv = v as any;
            const content = completeContent(String(vv.content || vv.context || "").trim(), NODE_CONTENT_MAX_CHARS);
            const name = completeContent(String(vv.name || compressNodeName(content)).trim(), 64);
            if (content && name && !isNgramFragmentContent(content) && !isNgramFragmentContent(name)) out.node_updates[k] = { name, content };
          }
        }
      }
      if (Array.isArray(obj?.add_nodes)) {
        out.add_nodes = [];
        for (const n of obj.add_nodes.slice(0, 2)) {  // allow limited growth; gates below decide final promotion
          const layer = Number(n?.layer);
          const content = completeContent(String(n?.content || n?.context || n?.name || "").trim(), NODE_CONTENT_MAX_CHARS);
          const name = completeContent(String(n?.name || compressNodeName(content)).trim(), 64);
          if (Number.isInteger(layer) && layer >= 0 && layer < net.hyperparams.layers.length && content && name && !isNgramFragmentContent(content) && !isNgramFragmentContent(name)) out.add_nodes.push({ layer, name, content });
        }
      }
      if (Array.isArray(obj?.node_actions)) {
        out.node_actions = [];
        for (const a of obj.node_actions.slice(0, 4)) {
          const action = String(a?.action || "").trim().toLowerCase();
          if (action !== "merge" && action !== "keep") {
            if (action === "delete") {
              onLog(`Textron semantic backward: IGNORED delete action from LLM (${a?.node || "?"}) — delete is system-managed, use merge instead`);
            }
            continue;
          }
          const entry: any = { action: action as "merge" | "keep" };
          if (a?.rationale) entry.rationale = String(a.rationale).slice(0, 80);
          if (action === "merge") {
            entry.source = String(a?.source || "").trim();
            entry.target = String(a?.target || "").trim();
            if (!entry.source || !entry.target) continue;
            // Validate both nodes exist in network
            const sp = parseLayerNodeId(entry.source); const tp = parseLayerNodeId(entry.target);
            if (!sp || !tp || sp.layer !== tp.layer) continue; // merge only within same layer
          }
          out.node_actions.push(entry);
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
      const body: Record<string, unknown> = { model: model.id, messages, stream, max_completion_tokens: 4096 };
      // 2026-07-21: 30s→90s。kimi-k3 非流式生成 4096-token 大 JSON 稳定超过 30s
      // (events 两次 durationMs=30015/30019 精确超时 → 命中反馈只得 0.02 兜底 reward)。
      const res = await fetch(chatEndpoint, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(90000) });
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
      // 2026-07-22: 当 API 返回空内容时，记录完整响应体以便诊断
      if (!rawContent) {
        const diagInfo = `rawContent empty. res.ok=${res.ok} status=${res.status} finish_reason=${data?.choices?.[0]?.finish_reason || "none"} responseBody=${txt.slice(0, 500)}`;
        console.error(`[textron] semantic_backward empty content: ${diagInfo}`);
        fs.appendFileSync(path.join(net.path, "_sb_logs", "_empty_response.log"), `${new Date().toISOString()} ${diagInfo}\n`, "utf-8");
        throw new Error(`empty semantic backward response (HTTP ${res.status}, finish=${data?.choices?.[0]?.finish_reason || "?"})`);
      }
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
    async function callChatJsonStream() {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
      const body = { model: model.id, messages, stream: true, max_completion_tokens: 2048, response_format: { type: "json_object" } };
      const res = await fetch(chatEndpoint, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(90000) });
      if (!res.ok) throw new Error(`chat json stream HTTP ${res.status}: ${(await res.text().catch(() => "")).slice(0, 160)}`);
      const parts = await readSse(res as any);
      const result = extract(parts);
      recordMonitorEvent({
        type: "debug",
        action: "semantic_backward_llm_raw_response",
        taskFamily: path.basename(net.path),
        mode: "chat_json_stream",
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
    // 2026-07-21: chat_json → chat_stream → chat_json_stream 三重兜底。
    // chat_json(plain,非流式)→chat_stream(plain,流式)→chat_json_stream(流式+json_object,兼容GPT/Kimi/DeepSeek)
    for (const [label, fn] of [["chat_json", () => callChat(false)], ["chat_stream", () => callChat(true)], ["chat_json_stream", () => callChatJsonStream()]] as const) {
      try {
        const result = await fn();
        log(`Textron semantic backward LLM ok (${label}, reward=${result.reward.toFixed(3)})`);
        // ── File log: full LLM input/output ──
        try {
          const logEntry = {
            ts: new Date().toISOString(),
            taskFamily: path.basename(net.path),
            mode: label,
            model: model?.id,
            systemPrompt: messages[0].content,
            userPrompt: messages[1].content,
            parsed: { reward: result.reward, rationale: result.rationale, nodeUpdateIds: Object.keys(result.node_updates || {}), addNodes: (result.add_nodes || []).map((n: any) => ({ layer: n.layer, name: n.name })), nodeActions: (result.node_actions || []).map((a: any) => ({ action: a.action, source: a.source, target: a.target, node: a.node, rationale: a.rationale })) },
          };
          const logDir = path.join(net.path, "_sb_logs");
          ensureDir(logDir);
          fs.appendFileSync(path.join(logDir, "semantic_backward.jsonl"), JSON.stringify(logEntry) + "\n", "utf-8");
        } catch (e) {
          console.error(`[textron] semantic_backward.jsonl write failed: ${(e as Error).message}`);
        }
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
    recordMonitorEvent({ type: "trace", action: "semantic_backward_llm_done", status: "failed", taskFamily: path.basename(net.path), errors: errors.map((e) => preview(e, 300)), durationMs: Date.now() - sbStartedMs });
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
          ? completeContent(tacticMatch[1].trim(), NODE_CONTENT_MAX_CHARS)
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

  function buildHighEntropyAddCandidate(
    previousAssistantHighEntropy: string,
    activatedIds: string[],
  ): { layer: number; name: string; content: string } | undefined {
    const crystal = parseHighEntropyCrystal(previousAssistantHighEntropy ? `<HighEntropy>${previousAssistantHighEntropy}</HighEntropy>` : "");
    const content = (crystal.ok ? crystal.content : previousAssistantHighEntropy).replace(/\s+/g, " ").trim();
    if (!content || isNgramFragmentContent(content)) return undefined;
    const parsedLayers = activatedIds.map(parseLayerNodeId).filter(Boolean) as { layer: number; nodeId: string }[];
    const targetLayer = parsedLayers.length ? parsedLayers.reduce((m, p) => Math.max(m, p.layer), 0) : undefined;
    return {
      // Empty forward path means neutral novel-topic routing: create a new L0 anchor.
      layer: targetLayer ?? 0,
      name: crystal.ok ? crystal.name : compressNodeName(content),
      content,
    };
  }

  function applySemanticNodeUpdates(net: NonNullable<ReturnType<typeof loadNetwork>>, updates: Record<string, string | { name?: string; content?: string; context?: string }> | undefined, onLog: (msg: string) => void) {
    const result: {
      updated: number;
      skipped: number;
      skipReasons: string[];
      changedNodes: { id: string; layer: number; nodeId: string; oldName: string; newName: string; oldContent: string; newContent: string }[];
      nodeMutations: { type: "update" | "add" | "merge" | "delete"; id: string; source?: string; target?: string }[];
    } = { updated: 0, skipped: 0, skipReasons: [], changedNodes: [], nodeMutations: [] };
    if (!updates) return result;

    for (const [id, update] of Object.entries(updates)) {
      const parsed = parseLayerNodeId(id);
      if (!parsed) {
        result.skipped++;
        result.skipReasons.push(`${id}:bad_node_id`);
        continue;
      }
      // ── Guard: refuse to write virtual cold-start nodes to disk ──
      if (parsed.nodeId.startsWith("_seed_") || parsed.nodeId.startsWith("_cold_")) {
        result.skipped++;
        result.skipReasons.push(`${id}:virtual_seed_not_writable`);
        onLog(`Textron semantic backward: skipped virtual node ${id} — SEED content must be materialized via add_nodes`);
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
        // Scale-rescue: rejection = wrong scale, not garbage (Wang–Zahl).
        const rescue = rescaleRejectedCrystal(net, content, validation.reason, parsed.layer, onLog);
        result.skipped++;
        result.skipReasons.push(`${id}:${validation.reason}${rescue ? `→rescale:${rescue.action}` : ""}`);
        onLog(`Textron semantic backward: skipped node update ${id} (${validation.reason})${rescue?.rescued ? ` [rescued:${rescue.action} → L${rescue.layer}::${rescue.nodeId}]` : ""}`);
        continue;
      }

      const similar = oldIsArtifact
        ? null
        : findSimilarKnowledgeNode(net, compressNodeName(validation.content), validation.content, 0.40, parsed.layer, parsed.nodeId);
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
        result.nodeMutations.push({ type: "merge", id: similarId, source: id, target: similarId });
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
      const newContent = validation.content.slice(0, NODE_CONTENT_MAX_CHARS);
      const mergedContent = oldIsArtifact ? completeContent(newContent, NODE_CONTENT_MAX_CHARS) : mergeContent(oldContent, newContent);
      if (oldContent && mergedContent !== newContent) {
        onLog(`Textron semantic backward: merged node ${id} (old=${oldContent.length}c new=${newContent.length}c → ${mergedContent.length}c)`);
      }
      // Merge name: distill old name keywords + new name keywords, not full replace
      const llmProposedName = typeof update === "string" ? compressNodeName(update) : (update.name || "");
      const mergedNameRaw = llmProposedName && oldName
        ? distillNodeName(`${oldName} ${llmProposedName}`, 64)
        : (llmProposedName || compressNodeName(mergedContent));
      const mergedName = mergedNameRaw.slice(0, 64);
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
      result.nodeMutations.push({ type: oldContent ? "update" : "add", id });
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

  // ─── Expanded Auto Backward: edges + node CRUD in one pass ───────────
  // Replaces old edge-only autoBackward(). Handles weight updates AND
  // node content create/update/merge based on the single LLM call's output.
  function autoBackward(
    net: NonNullable<ReturnType<typeof loadNetwork>>,
    activatedIds: string[],
    reward: number,
    onLog: (msg: string) => void,
    selectedEdgeIds: string[] = [],
    edgeRewards?: Map<string, number>,
    nodeUpdates?: Record<string, string | { name?: string; content?: string; context?: string }>,
    addNodes?: { layer: number; name?: string; content: string }[],
    nodeActions?: { action: "merge" | "delete" | "keep"; source?: string; target?: string; node?: string; rationale?: string }[],
  ): {
    changes: number; changedEdges: string[];
    nodesUpdated: number; nodesAdded: number; nodesMerged: number; nodesDeleted: number; nodesSkipped: number;
    nodeSkipReasons: string[];
    changedNodes: { id: string; layer: number; nodeId: string; oldName: string; newName: string; oldContent: string; newContent: string }[];
    nodeMutations: { type: "update" | "add" | "merge" | "delete"; id: string; source?: string; target?: string }[];
  } {
    // ── Update node stats (success/failure for battle records) ──
    (() => {
      const statsP = path.join(net.path, "_node_stats.json");
      const stats = readJson<Record<string, { success: number; failure: number; lastActivated: string }>>(statsP, {});
      for (const nid of activatedIds) {
        if (!stats[nid]) stats[nid] = { success: 0, failure: 0, lastActivated: "" };
        stats[nid].lastActivated = new Date().toISOString();
        if (reward > 0.1) stats[nid].success++;
        else if (reward < -0.3) stats[nid].failure++;
      }
      writeJson(statsP, stats);
    })();

    // ── Edge weight updates ──
    const lr = net.hyperparams.learningRate;
    const activeEdgeSet = new Set<string>();
    for (const edgeId of selectedEdgeIds) {
      const key = selectedEdgeIdToWeightKey(edgeId);
      if (key) activeEdgeSet.add(key);
    }
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
          if (Math.abs(edge.weight - old) > 0.000001) {
            changes++;
            changedEdges.push(`${eid}:${old.toFixed(4)}->${edge.weight.toFixed(4)}`);
          }
        }
      }
      if (changes > 0) {
        writeJson(path.join(net.path, "weights.json"), net.weights);
        onLog(`Textron backward: ${changes} selected edge(s) updated (reward=${reward.toFixed(3)}) for "${path.basename(net.path)}"`);
      }
      // Negative reward: lightly penalize ALL edges connected to activated nodes
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
              if (Math.abs(edge.weight - old) > 0.000001) {
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
    const nodeResult = applySemanticNodeUpdates(net, nodeUpdates, onLog);
    const nodeMutations = [...nodeResult.nodeMutations];

    // ── Node additions ──
    let nodesAdded = 0, nodesMerged = 0, nodesAddSkipped = 0;
    const addSkipReasons: string[] = [];
    for (const node of addNodes || []) {
      const validation = validateKnowledgeCrystal(node.content, node.layer);
      if (!validation.ok) {
        // Scale-rescue: rejection = wrong scale, not garbage (Wang–Zahl).
        const rescue = rescaleRejectedCrystal(net, node.content, validation.reason, node.layer, onLog);
        nodesAddSkipped++;
        addSkipReasons.push(`L${node.layer}:${validation.reason}${rescue ? `→rescale:${rescue.action}` : ""}`);
        onLog(`Textron autoBackward: skipped add_node L${node.layer} (${validation.reason})${rescue?.rescued ? ` [rescued:${rescue.action} → L${rescue.layer}::${rescue.nodeId}]` : ""}`);
        continue;
      }
      const targetLayer = chooseExpansionLayer(net, node.layer);
      const nodeName = node.name || compressNodeName(validation.content);
      const similar = findSimilarKnowledgeNode(net, nodeName, validation.content, 0.40, targetLayer);
      if (similar) {
        dlog("GATE", `autoBackward: merged similar add_node (${nodeName.slice(0, 30)}) → L${similar.layer}::${similar.nodeId} (${(similar.score*100).toFixed(0)}%)`);
        updateExistingNodeByPolicy(net, similar.layer, similar.nodeId, nodeName, validation.content, onLog);
        nodesMerged++;
        nodeMutations.push({ type: "merge", id: `L${similar.layer}::${similar.nodeId}`, target: `L${similar.layer}::${similar.nodeId}` });
        continue;
      }
      const created = addPolicyNode(net, node.layer, validation.content, onLog, node.name, undefined, { mergeSimilar: true, similarityThreshold: 0.40 });
      const createdId = `L${created.layer}::${created.nodeId}`;
      if (created.added || created.replaced) { nodesAdded++; nodeMutations.push({ type: "add", id: createdId }); }
      else if (created.merged) { nodesMerged++; nodeMutations.push({ type: "merge", id: createdId, target: createdId }); }
      else if (created.skipped) { nodesAddSkipped++; addSkipReasons.push(`L${node.layer}:${created.reason || "frozen_skip"}`); }
    }

    // ── Node actions: merge / delete ──
    // GATE: only allow merge/delete when reward is non-trivial (real feedback present).
    // When reward≈0, the LLM has no real signal and fabricates merge/delete justifications.
    const mergeDeleteGate = Math.abs(reward) >= 0.05;
    if (!mergeDeleteGate && (nodeActions || []).length > 0) {
      onLog(`Textron autoBackward: blocked ${(nodeActions || []).length} merge/delete action(s) — reward=${reward.toFixed(3)} below gate threshold 0.05`);
    }
    let nodesDeleted = 0;
    // Track which nodes were emptied by merge in THIS backward pass.
    // Only these should be compacted — NOT pre-existing empty slots waiting for knowledge.
    const emptiedByMerge: { layer: number; nodeId: string }[] = [];
    for (const action of nodeActions || []) {
      if (action.action === "merge" && action.source && action.target && mergeDeleteGate) {
        const sp = parseLayerNodeId(action.source);
        const tp = parseLayerNodeId(action.target);
        if (!sp || !tp || sp.layer !== tp.layer) continue;
        const srcPath = path.join(net.path, `layer_${sp.layer}`, `${sp.nodeId}.html`);
        const tgtPath = path.join(net.path, `layer_${tp.layer}`, `${tp.nodeId}.html`);
        const srcContent = readNodeContent(srcPath);
        const tgtContent = readNodeContent(tgtPath);
        if (!srcContent || !tgtContent) continue;
        // GATE: refuse merge if source content is already empty (prevents double-compaction)
        if (srcContent.trim().length === 0) {
          onLog(`Textron autoBackward: skipped merge ${action.source}→${action.target} — source already empty`);
          continue;
        }
        const merged = mergeContent(tgtContent, srcContent);
        const outEdges = (net.weights.layer_connections[`${tp.layer}_to_${tp.layer + 1}`] || []).filter(e => e.from === tp.nodeId).map(e => ({ toId: e.to, weight: e.weight }));
        writeNodeHtml(tgtPath, tp.layer, tp.nodeId, merged, outEdges, compressNodeName(merged));
        // Empty source only transiently; compactMergeEmptiedNodes removes/reindexes only these specific nodes.
        const srcOutEdges = (net.weights.layer_connections[`${sp.layer}_to_${sp.layer + 1}`] || []).filter(e => e.from === sp.nodeId).map(e => ({ toId: e.to, weight: e.weight }));
        writeNodeHtml(srcPath, sp.layer, sp.nodeId, "", srcOutEdges);
        // Reset ngram state for emptied source
        try {
          const ngramPath = srcPath.replace(/\.html$/, ".ngram.json");
          if (fs.existsSync(ngramPath)) writeNgramState(srcPath, createNodeState());
        } catch {}
        emptiedByMerge.push({ layer: sp.layer, nodeId: sp.nodeId });
        nodesMerged++;
        nodeMutations.push({ type: "merge", id: action.target, source: action.source, target: action.target });
        onLog(`Textron autoBackward: merged ${action.source} into ${action.target} — "${preview(srcContent, 40)}" → "${preview(merged, 60)}" (source queued for compaction)`);
      } else if (action.action === "delete" && action.node) {
        // BLOCKED: standalone delete is prohibited. Nodes must only be removed via merge (A→B, empty A).
        onLog(`Textron autoBackward: blocked standalone delete of ${action.node} — deletes only allowed via merge (source emptied after merge into target)${action.rationale ? ` (LLM rationale: ${action.rationale})` : ""}`);
      }
    }

    // Compact ONLY nodes emptied by merge in this pass, not all empty nodes.
    // Previously compactEmptyNodes deleted ALL empty nodes including unfilled slots,
    // causing random-looking node loss across the network.
    const nodesCompacted = emptiedByMerge.length > 0
      ? compactMergeEmptiedNodes(net, emptiedByMerge, onLog)
      : 0;

    if (nodeResult.updated > 0 || nodesAdded > 0 || nodesMerged > 0 || nodesDeleted > 0 || nodesCompacted > 0) {
      net.hyperparams.updatedAt = new Date().toISOString();
      writeJson(path.join(net.path, "hyperparams.json"), net.hyperparams);
    }

    return {
      changes, changedEdges,
      nodesUpdated: nodeResult.updated, nodesAdded, nodesMerged, nodesDeleted: nodesDeleted + nodesCompacted,
      nodesSkipped: nodeResult.skipped + nodesAddSkipped,
      nodeSkipReasons: [...nodeResult.skipReasons, ...addSkipReasons],
      changedNodes: nodeResult.changedNodes,
      nodeMutations,
    };
  }

  async function forcedSemanticBackward(
    taskFamily: string,
    previousTask: string,
    previousAssistantHighEntropy: string,
    currentUserMessage: string,
    activatedIds: string[],
    selectedEdgeIds: string[],
    ctx: any,
    novelty?: { routeUncertain?: boolean; moeMaxScore?: number },
  ) {
    const startedMs = Date.now();
    const startedAt = new Date(startedMs).toISOString();
    const net = loadNetwork(taskFamily);
    if (!net) return null;
    let result = await semanticBackwardLLM(net, previousTask, previousAssistantHighEntropy, currentUserMessage, activatedIds, ctx);

    // The LLM now judges path relevance itself via reward — no separate pathAudit needed.
    // Negative reward = LLM determined path was wrong/irrelevant.
    // shouldPreferAddNode: when user explicitly wants new concepts (regex match).
    const noForwardPath = activatedIds.length === 0 && selectedEdgeIds.length === 0;
    const noveltyDecision = decideNoveltyExpansion({
      routeUncertain: !!novelty?.routeUncertain,
      moeMaxScore: novelty?.moeMaxScore,
      reward: result.reward,
      selectedEdgeIds,
      hasHighEntropy: !!previousAssistantHighEntropy,
    });
    // When backward is triggered, the pairing judge already confirmed this IS feedback.
    // Always preserve LLM's directed node_updates when backward is running with real signal.
    const feedbackHasOutcome = true;
    const shouldPreferAddNode = !feedbackHasOutcome && (noveltyDecision.synthesizeL0Anchor || noForwardPath || /新增|add[_ -]?nodes?|new node|wrong-topic|跑题|偏题|不触发|覆盖|容量|novel/i.test(currentUserMessage));
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
        recordMonitorEvent({ type: "trace", action: "semantic_node_updates_suppressed_for_add_candidate", taskFamily, reason: noveltyDecision.synthesizeL0Anchor ? noveltyDecision.reason : "user_requested_new_concept", suppressedIds: originalUpdateIds.filter((id) => !Object.prototype.hasOwnProperty.call(repairOnlyUpdates, id)), preservedArtifactRepairIds: Object.keys(repairOnlyUpdates) });
      }
    }
    if (shouldPreferAddNode && previousAssistantHighEntropy) {
      const existingAdd = result.add_nodes || [];
      if (existingAdd.length === 0) {
        const candidate = buildHighEntropyAddCandidate(previousAssistantHighEntropy, activatedIds);
        if (!candidate) {
          recordMonitorEvent({ type: "trace", action: "semantic_add_node_synthesize_skip", taskFamily, reason: "invalid_highentropy", highEntropyPreview: preview(previousAssistantHighEntropy, 180) });
        } else {
          result = { ...result, add_nodes: [candidate] };
          recordMonitorEvent({ type: "trace", action: "semantic_add_node_synthesized", taskFamily, reason: noveltyDecision.synthesizeL0Anchor ? noveltyDecision.reason : "user_requested_new_concept", targetLayer: candidate.layer, contentPreview: preview(candidate.content, 180) });
        }
      }
    }
    // Cold-start bootstrap: no forward path + no previous HighEntropy → seed L0 anchor from current message
    if (noForwardPath && !previousAssistantHighEntropy && (result.add_nodes || []).length === 0) {
      const seedContent = currentUserMessage.slice(0, NODE_CONTENT_MAX_CHARS);
      const validation = validateKnowledgeCrystal(seedContent, 0);
      if (validation.ok) {
        const seedName = compressNodeName(validation.content).slice(0, 48);
        const seedNode = { layer: 0, name: seedName, content: validation.content };
        result = { ...result, add_nodes: [seedNode] };
        recordMonitorEvent({ type: "trace", action: "semantic_add_node_synthesized", taskFamily, reason: "cold_start_bootstrap", targetLayer: 0, contentPreview: preview(validation.content, 180) });
        log(`Textron semantic backward: cold-start bootstrap — seeded L0 anchor "${seedName}" from current message (no prior HighEntropy available)`);
      } else {
        recordMonitorEvent({ type: "trace", action: "semantic_add_node_synthesize_skip", taskFamily, reason: "cold_start_content_invalid", reasonDetail: validation.reason });
      }
    }

    // Use LLM's reward directly — no external credit adjustment.
    // Default tiny positive only when real edge path exists and LLM gave neutral reward.
    const effectiveReward = Math.abs(result.reward) < 0.001 ? (selectedEdgeIds.length > 0 ? 0.02 : 0) : result.reward;

    // ── Outcome signal gate: strip merge/delete when feedback lacks real outcome ──
    // Without an outcome signal (e.g. "收到", "继续"), the backward LLM fabricates
    // merge/delete justifications. Block these to prevent node drain.
    let gatedNodeActions = result.node_actions;
    if (!feedbackHasOutcome && gatedNodeActions && gatedNodeActions.length > 0) {
      const stripped = gatedNodeActions.filter(a => a.action !== "merge" && a.action !== "delete");
      if (stripped.length < gatedNodeActions.length) {
        log(`Textron semantic backward: stripped ${gatedNodeActions.length - stripped.length} merge/delete action(s) — feedback lacks outcome signal`);
        recordMonitorEvent({ type: "trace", action: "semantic_backward_merge_delete_stripped", taskFamily, reason: "no_outcome_signal", strippedCount: gatedNodeActions.length - stripped.length });
        gatedNodeActions = stripped;
      }
    }

    // Single unified backward: edges + node updates + node additions
    const bwResult = autoBackward(net, activatedIds, effectiveReward, log, selectedEdgeIds, undefined, result.node_updates, result.add_nodes, gatedNodeActions);
    recordMonitorEvent({ type: "trace", action: "semantic_backward_apply", taskFamily, reward: effectiveReward, llmReward: result.reward, edgesUpdated: bwResult.changes, nodesUpdated: bwResult.nodesUpdated, nodesAdded: bwResult.nodesAdded, nodesMerged: bwResult.nodesMerged, nodesSkipped: bwResult.nodesSkipped, skipReasons: bwResult.nodeSkipReasons.slice(0, 8), changedNodes: bwResult.changedNodes, nodeMutations: bwResult.nodeMutations });

    // HighEntropy fallback: if no node update happened, synthesize from previous assistant
    let highEntropyFallbackNode = "";
    if (bwResult.nodesUpdated === 0 && previousAssistantHighEntropy) {
      const candidate = buildHighEntropyAddCandidate(previousAssistantHighEntropy, activatedIds);
      if (candidate) {
        // Re-run autoBackward with just this fallback add_node
        const fallbackResult = autoBackward(net, activatedIds, effectiveReward, log, selectedEdgeIds, undefined, undefined, [candidate]);
        bwResult.nodesAdded += fallbackResult.nodesAdded;
        bwResult.nodesMerged += fallbackResult.nodesMerged;
        bwResult.nodesSkipped += fallbackResult.nodesSkipped;
        bwResult.nodeMutations.push(...fallbackResult.nodeMutations);
        highEntropyFallbackNode = `add_candidate:L${candidate.layer}`;
        recordMonitorEvent({ type: "trace", action: "highentropy_fallback_add_candidate", taskFamily, targetLayer: candidate.layer, highEntropyPreview: preview(candidate.content, 180) });
      } else {
        recordMonitorEvent({ type: "trace", action: "highentropy_fallback_skip", taskFamily, reason: "invalid_or_empty_highentropy", activatedIds, hasHighEntropy: !!previousAssistantHighEntropy });
      }
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
      (bwResult.changes > 0 ? 0.20 : 0) +
      (bwResult.nodesUpdated > 0 ? 0.25 : 0) +
      ((bwResult.nodesAdded + bwResult.nodesMerged) > 0 ? 0.15 : 0) +
      (previousAssistantHighEntropy ? 0.05 : 0) -
      ((bwResult.nodesUpdated + bwResult.nodesAdded + bwResult.nodesMerged) === 0 ? 0.15 : 0),
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
      nodesUpdated: bwResult.nodesUpdated,
      nodesAdded: bwResult.nodesAdded,
      nodesMerged: bwResult.nodesMerged,
      nodesDeleted: bwResult.nodesDeleted,
      nodesSkipped: bwResult.nodesSkipped,
      skipReasons: bwResult.nodeSkipReasons.slice(0, 8),
      edgesUpdated: bwResult.changes,
      changedEdges: bwResult.changedEdges,
      changedNodes: bwResult.changedNodes,
      nodeMutations: bwResult.nodeMutations,
      distillCount,
      distillEvents,
      activatedIds,
      selectedEdgeIds,
      startedAt,
      at: new Date().toISOString(),
    };
    dlog("BACKWARD", "forcedSemanticBackward DONE", lastBackwardState);
    log(`Textron semantic backward: status=done quality=${qualityLabel}(${qualityScore.toFixed(2)}), reward=${effectiveReward.toFixed(3)} (LLM=${result.reward.toFixed(3)}), edgesUpdated=${bwResult.changes}, nodesUpdated=${bwResult.nodesUpdated}, nodesAdded=${bwResult.nodesAdded}, nodesMerged=${bwResult.nodesMerged}, nodesDeleted=${bwResult.nodesDeleted}, nodesSkipped=${bwResult.nodesSkipped}, durationMs=${durationMs}${result.rationale ? ` — ${result.rationale}` : ""}`);
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
    recordMonitorEvent({ type: "hook", hook: "before_agent_start", promptChars: event.prompt?.length || 0, promptPreview: preview(event.prompt, 180), hasActiveTask: !!activeTask, stackDepth: taskStack.length });

    // ── Restore taskStack from disk if in-memory state was lost (e.g. after reload) ──
    if (!activeTask && taskStack.length === 0) {
      const saved = readJson<{activeTask?: {taskType:string;taskFamily:string;highEntropy:string;activatedIds:string[];ts:string}|null; taskStack?: {taskType:string;taskFamily:string;highEntropy:string;activatedIds:string[];ts:string}[]} | null>(
        LAST_STATE_PATH, null);
      if (saved) {
        if (saved.activeTask) {
          activeTask = {
            taskType: saved.activeTask.taskType || "",
            taskFamily: saved.activeTask.taskFamily || "",
            rawUserPrompt: "", effectivePrompt: "",
            highEntropy: saved.activeTask.highEntropy || "",
            activatedIds: saved.activeTask.activatedIds || [],
            selectedEdgeIds: [],
            routeUncertain: false, moeMaxScore: 0,
            ts: saved.activeTask.ts || "",
          };
        }
        if (saved.taskStack) {
          taskStack = saved.taskStack.map((t:any) => ({
            taskType: t.taskType || "", taskFamily: t.taskFamily || "",
            rawUserPrompt: "", effectivePrompt: "",
            highEntropy: t.highEntropy || "",
            activatedIds: t.activatedIds || [],
            selectedEdgeIds: [],
            routeUncertain: false, moeMaxScore: 0,
            ts: t.ts || "",
          }));
        }
        dlog("STATE", "restored taskStack from disk", { activeTask: !!activeTask, stackDepth: taskStack.length });
        recordMonitorEvent({ type: "trace", action: "task_stack_restored", activeTask: !!activeTask, stackDepth: taskStack.length });
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
    currentRouteUncertain = false;
    currentMoeMaxScore = 0;

    // ── Task Stack: LLM-based feedback pairing ──
    // Build candidate list from activeTask + taskStack, let LLM match feedback to task via TaskType.
    const allPendingTasks: TaskEntry[] = activeTask ? [activeTask, ...taskStack] : [...taskStack];
    if (allPendingTasks.length > 0) {
      // Build a lightweight pairing prompt: show each task's TaskType + truncated content
      const taskListForLLM = allPendingTasks.map((t, i) =>
        `[${i}] TaskType="${t.taskType}" taskFamily="${t.taskFamily}" ts=${t.ts.slice(0,16)} HighEntropy=${t.highEntropy.slice(0, 120)}`
      ).join("\n");

      // Use a fast LLM call to judge which task (if any) this message is feedback for
      let bestMatchIdx = -1;
      let isFeedbackMatch = false;
      try {
        const model = _textronModel;
        if (model?.id && model?.baseUrl) {
          const baseUrl = String(model.baseUrl).replace(/\/+$/, "");
          const chatEndpoint = joinApiEndpoint(baseUrl, "/chat/completions");
          const { apiKey } = await resolveModelApiKey(ctx, model);
          const pairingPrompt = `You are a task-feedback pairing judge. Given a list of pending tasks and a user message, determine which task (if any) the user message is feedback for.\n\nPENDING TASKS:\n${taskListForLLM}\n\nUSER MESSAGE: ${currentRawUserPrompt.slice(0, 500)}\n\nOutput ONLY raw JSON: {"matchIdx":-1,"isFeedback":false,"rationale":"≤60 chars"}.\n- matchIdx: index of matched task (0=${activeTask ? "active" : "first stack"}, -1=none)\n- isFeedback: true if this message evaluates/corrects/responds to the matched task; false if it's a new task or unrelated.\n- Key signals of feedback: error correction, result report, criticism, approval, "没改好"/"改好了"/"对了"/"错了"/"为什么没有" etc.\n- Key signals of NOT feedback: new task instructions, unrelated questions, continuation words.`;
          const res = await fetch(chatEndpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
            body: JSON.stringify({
              model: "deepseek-v4-flash",
              messages: [{ role: "user", content: pairingPrompt }],
              max_tokens: 200,
              temperature: 0,
            }),
            signal: AbortSignal.timeout(15000),
          });
          if (res.ok) {
            const data = await res.json();
            const raw = data?.choices?.[0]?.message?.content || "";
            const parsed = JSON.parse(raw.replace(/```json\n?|```/g, "").trim());
            bestMatchIdx = typeof parsed.matchIdx === "number" ? parsed.matchIdx : -1;
            isFeedbackMatch = !!parsed.isFeedback;
            dlog("BACKWARD", "pairing judge", { matchIdx: bestMatchIdx, isFeedback: isFeedbackMatch, rationale: parsed.rationale });
            recordMonitorEvent({ type: "trace", action: "pairing_judge_done", matchIdx: bestMatchIdx, isFeedback: isFeedbackMatch, rationale: parsed.rationale || "", pendingCount: allPendingTasks.length });
          } else {
            throw new Error(`pairing judge fetch failed: ${res.status}`);
          }
        } else {
          throw new Error("no model available for pairing judge");
        }
      } catch (e) {
        // Fallback: if pairing LLM fails, try simple heuristic — match by taskFamily
        dlog("BACKWARD", "pairing judge failed, fallback to first active", { error: (e as Error).message });
        bestMatchIdx = 0; // Default to activeTask
        isFeedbackMatch = true; // Conservative: assume it's feedback
      }

      if (isFeedbackMatch && bestMatchIdx >= 0 && bestMatchIdx < allPendingTasks.length) {
        const matched = allPendingTasks[bestMatchIdx];
        dlog("BACKWARD", "pairing MATCHED — running backward", { taskType: matched.taskType, idx: bestMatchIdx });

        // Build backward context from matched task
        const backwardTaskContext = buildBackwardTaskContext({
          rawPrompt: matched.rawUserPrompt,
          effectivePrompt: matched.effectivePrompt,
          highEntropy: matched.highEntropy,
        });
        const capturedPrevTask = backwardTaskContext.previousTaskForBackward;
        const capturedHighEntropy = matched.highEntropy;
        const capturedTF = matched.taskFamily || "astro_stock_prediction";
        const capturedIDs = matched.activatedIds;
        const capturedEdges = matched.selectedEdgeIds;

        // ── Domain evidence gate ──
        if (!backwardTaskContext.hasDomainEvidence && !capturedHighEntropy) {
          log(`Textron semantic backward: skipped — no domain evidence`);
          recordMonitorEvent({ type: "trace", action: "semantic_backward_skipped_no_domain_evidence", taskFamily: capturedTF });
        } else {
          const startedAt = new Date().toISOString();
          const semanticRunId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          lastBackwardState = {
            taskFamily: capturedTF, action: "semantic_backward", status: "running",
            runId: semanticRunId, activatedIds: capturedIDs, selectedEdgeIds: capturedEdges,
            hasHighEntropy: !!capturedHighEntropy, matchedTaskType: matched.taskType,
            previousTaskChars: capturedPrevTask.length, feedbackChars: currentRawUserPrompt.length,
            startedAt, at: startedAt,
          };
          recordMonitorEvent({ type: "update", taskFamily: capturedTF, action: "semantic_backward_start", ...lastBackwardState });
          broadcast({ type: "update", taskFamily: capturedTF, action: "semantic_backward_start", ...lastBackwardState });
          log(`Textron semantic backward: status=running runId=${semanticRunId}, matchedTaskType=${matched.taskType}, path=${capturedIDs.join("->") || "(none)"}`);
          try {
            await forcedSemanticBackward(capturedTF, capturedPrevTask, capturedHighEntropy, currentRawUserPrompt, capturedIDs, capturedEdges, ctx, { routeUncertain: matched.routeUncertain, moeMaxScore: matched.moeMaxScore });
            recordMonitorEvent({ type: "trace", action: "agent_pending_state_cleared", taskFamily: capturedTF, reason: "backward_consumed", runId: semanticRunId, matchedTaskType: matched.taskType });
          } catch (e) {
            const failedAt = new Date().toISOString();
            lastBackwardState = { ...lastBackwardState, status: "failed", error: e instanceof Error ? e.message : String(e), at: failedAt };
            log(`Textron semantic backward: status=failed runId=${semanticRunId}, error=${e instanceof Error ? e.message : String(e)}`);
            recordMonitorEvent({ type: "update", taskFamily: capturedTF, action: "semantic_backward_failed", ...lastBackwardState });
          }
        }

        // ── Remove matched task from stack ──
        if (bestMatchIdx === 0 && activeTask) {
          // Matched activeTask → pop from stack or clear
          if (taskStack.length > 0) {
            activeTask = taskStack.shift()!;
          } else {
            activeTask = null;
          }
        } else {
          // Matched a stack task → remove it from stack
          const stackIdx = activeTask ? bestMatchIdx - 1 : bestMatchIdx;
          if (stackIdx >= 0 && stackIdx < taskStack.length) {
            taskStack.splice(stackIdx, 1);
          }
        }
        dlog("BACKWARD", "task consumed from stack", { consumedIdx: bestMatchIdx, remainingActive: !!activeTask, remainingStack: taskStack.length });
      } else {
        // Not feedback → preserve all tasks, log as intermediate
        recordMonitorEvent({ type: "trace", action: "semantic_backward_skipped_not_feedback", reason: "pairing_judge_no_match", pendingCount: allPendingTasks.length, matchIdx: bestMatchIdx, isFeedback: isFeedbackMatch });
        dlog("BACKWARD", "skipped — not feedback, all tasks preserved", { pendingCount: allPendingTasks.length });
      }
    }

    const networks = listNetworks();

    if (networks.length === 0) {
      dlog("ROUTE", "no networks, skip");
      recordMonitorEvent({ type: "trace", action: "route_skip", reason: "no_networks", durationMs: Date.now() - tStart });
      return { systemPrompt: event.systemPrompt };
    }

    const route = autoRouteNetworkDecision(event.prompt, networks);
    const tf = route.taskFamily;
    if (!tf) {
      dlog("ROUTE", "no matching network, skip Textron injection");
      recordMonitorEvent({ type: "trace", action: "route_skip", reason: "no_task_family_match", networkCount: networks.length, networks, promptPreview: preview(event.prompt, 180), durationMs: Date.now() - tStart });
      return { systemPrompt: event.systemPrompt + HIGH_ENTROPY_INSTRUCTION };
    }
    const routeIsUncertain = route.reason === "best_effort" || route.reason === "content_match" || route.score < routeAbstainScore();
    currentRouteUncertain = routeIsUncertain;
    currentTaskFamily = tf;
    recordMonitorEvent({ type: "trace", action: "route_done", taskFamily: tf, reason: route.reason, score: Number(route.score.toFixed(4)), uncertain: routeIsUncertain, threshold: routeAbstainScore(), policy: "always_inject_and_let_backward_converge", networkCount: networks.length, networks, promptPreview: preview(event.prompt, 180) });
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
    const l0Scores = await scoreL0WithLLM(l0Nodes, event.prompt, ctx, net.path);
    dlog("L0", `scoring done in ${Date.now() - tScoreStart}ms`, l0Scores);

    // ── Relevance-gated PageRank + anti-lock-in exploration ──
    const localScores = buildLocalScores(String(event.prompt || ""), l0Nodes);
    const prScores = computePageRank(net);
    const PR_BLEND_WEIGHT = 0.15; // centrality supports relevance; it cannot create relevance
    for (const n of l0Nodes) {
      const key = `L0::${n.id}`;
      const llmScore = (l0Scores as Record<string, number>)[key] ?? 0;
      const localScore = localScores[key] ?? 0;
      const prScore = prScores[key] ?? 0;
      if (llmScore < 0.05 && localScore > 0 && prScore > 0.1) {
        (l0Scores as Record<string, number>)[key] = clamp(localScore * 0.7 + prScore * PR_BLEND_WEIGHT, 0, 1);
      } else if (llmScore > 0) {
        (l0Scores as Record<string, number>)[key] = clamp(llmScore * (1 - PR_BLEND_WEIGHT) + prScore * PR_BLEND_WEIGHT, 0, 1);
      }
    }
    const forwardStatsPath = path.join(net.path, "_node_stats.json");
    const forwardStats = readJson<Record<string, { activations?: number; success?: number; failure?: number; lastActivated?: string }>>(
      forwardStatsPath,
      {},
    );
    const adjustedL0 = applyExplorationPolicy(l0Scores as Record<string, number>, localScores, forwardStats);
    const moeRoute = routeL0ThroughMoe({
      prompt: String(event.prompt || ""),
      l0Nodes,
      scores: adjustedL0,
      stats: forwardStats,
      expertCount: moeExpertCount(),
      topK: moeTopK(),
    });
    for (const key of Object.keys(l0Scores as Record<string, number>)) {
      (l0Scores as Record<string, number>)[key] = moeRoute.gatedScores[key] ?? 0;
    }
    recordMonitorEvent({
      type: "trace",
      action: "l0_exploration_applied",
      taskFamily: tf,
      pageRankWeight: PR_BLEND_WEIGHT,
      topAdjusted: topScores(adjustedL0),
      localNonzero: Object.values(localScores).filter((v) => v > 0).length,
    });
    currentMoeMaxScore = moeRoute.experts.reduce((max, expert) => Math.max(max, Number(expert.score) || 0), 0);
    recordMonitorEvent({
      type: "trace",
      action: "moe_route_done",
      taskFamily: tf,
      enabled: moeRoute.enabled,
      selectedExpertIds: moeRoute.selectedExpertIds,
      maxExpertScore: Number(currentMoeMaxScore.toFixed(4)),
      experts: moeRoute.experts.map((expert) => ({
        id: expert.id,
        name: preview(expert.name, 80),
        score: Number(expert.score.toFixed(4)),
        nodeIds: expert.nodeIds,
      })),
      topK: moeTopK(),
    });

    const { layers, threshold } = net.hyperparams;
    const promptText = String(event.prompt || "");
    const downstreamFloor = downstreamRelevanceFloor();
    const downstreamRelevance: Record<string, number> = {};
    for (let l = 1; l < layers.length; l++) {
      for (let n = 0; n < layers[l]; n++) {
        const nodeId = `node_${n}`;
        const nodePath = path.join(net.path, `layer_${l}`, `${nodeId}.html`);
        downstreamRelevance[`L${l}::${nodeId}`] = lexicalRelevance(promptText, `${readNodeName(nodePath)} ${readNodeContent(nodePath)}`);
      }
    }
    const relevanceFilteredNodes: { id: string; layer: number; score: number; relevance: number; name: string }[] = [];
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
        let score = current[`L${l}::${nid}`] ?? current[nid] ?? 0;
        if (l > 0 && score > 0) {
          const relevance = downstreamRelevance[`L${l}::${nid}`] || 0;
          if (relevance < downstreamFloor) {
            relevanceFilteredNodes.push({
              id: `L${l}::${nid}`,
              layer: l,
              score: Number(score.toFixed(4)),
              relevance: Number(relevance.toFixed(4)),
              name: preview(readNodeName(path.join(net.path, `layer_${l}`, `${nid}.html`)), 80),
            });
            score = 0;
          } else {
            score = clamp(score * Math.min(1, 0.4 + relevance * 4), 0, 1);
          }
          current[nid] = score;
          current[`L${l}::${nid}`] = score;
        }
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

    // Persist all scores for monitor labels. Select top-k nodes per layer for backward,
    // while keeping prompt injection threshold-gated to avoid flooding context.
    currentActivationScores = {};
    const topK = forwardTopK();
    const selectedByLayer = new Map<number, string[]>();
    for (const la of layerActivations) {
      for (const node of la.nodes) currentActivationScores[`L${la.layer}::${node.id}`] = node.score;
      const ranked = la.layer === 0
        ? [...la.nodes].filter((node) => node.score > 0).sort((a, b) => b.score - a.score)
        : rankLayerWithExploration(la.layer, la.nodes, forwardStats);
      const selected = ranked.slice(0, topK);
      if (selected.length > 0) selectedByLayer.set(la.layer, selected.map((n) => n.id));
      for (const node of selected) {
        selectedPath.push({
          id: node.id,
          layer: la.layer,
          content: readNodeContent(path.join(net.path, `layer_${la.layer}`, `${node.id}.html`)),
          activation: node.score,
        });
      }
      for (const node of selected.filter((n) => n.score > threshold)) {
        contextActivated.push({
          id: node.id,
          layer: la.layer,
          content: readNodeContent(path.join(net.path, `layer_${la.layer}`, `${node.id}.html`)),
          activation: node.score,
        });
      }
    }

    // ── Cold-start virtual L0: if no nodes activated, seed one from current message ──
    if (selectedPath.length === 0 && String(event.prompt || "").trim().length > 20) {
      const seedContent = String(event.prompt || "").trim().slice(0, NODE_CONTENT_MAX_CHARS);
      const seedName = compressNodeName(seedContent).slice(0, 48);
      const virtualId = "_seed_0";
      selectedPath.push({ id: virtualId, layer: 0, content: seedContent, activation: 0.5 });
      contextActivated.push({ id: virtualId, layer: 0, content: seedContent, activation: 0.5 });
      if (!selectedByLayer.has(0)) selectedByLayer.set(0, []);
      selectedByLayer.get(0)!.push(virtualId);
      currentActivationScores[`L0::${virtualId}`] = 0.5;
      log(`Textron forward: cold-start — seeded virtual L0 node "${seedName}" (no existing nodes activated)`);
      recordMonitorEvent({ type: "trace", action: "cold_start_virtual_l0", taskFamily: tf, seedName, contentLen: seedContent.length });
    }

    currentSelectedEdgeIds = [];
    const selectedEdgeSet = new Set<string>();
    for (let l = 0; l < layers.length - 1; l++) {
      const fromSet = new Set(selectedByLayer.get(l) || []);
      const toSet = new Set(selectedByLayer.get(l + 1) || []);
      if (fromSet.size === 0 || toSet.size === 0) continue;
      const edges = net.weights.layer_connections[`${l}_to_${l + 1}`] || [];
      for (const e of edges) {
        if (!fromSet.has(e.from) || !toSet.has(e.to)) continue;
        const srcScore = currentActivationScores[`L${l}::${e.from}`] || 0;
        const dstScore = currentActivationScores[`L${l + 1}::${e.to}`] || 0;
        if (srcScore <= 0 || dstScore <= 0 || Math.max(0, e.weight) <= 0) continue;
        selectedEdgeSet.add(`L${l}::${e.from}->L${l + 1}::${e.to}`);
      }
    }
    currentSelectedEdgeIds = [...selectedEdgeSet];

    currentActivatedIds = selectedPath.map((n) => `L${n.layer}::${n.id}`);
    // Count every forward selection, including weak-reward turns. Backward success/failure
    // counters alone undercount frequency and cannot prevent path lock-in.
    for (const id of currentActivatedIds) {
      const stat = forwardStats[id] || { activations: 0, success: 0, failure: 0, lastActivated: "" };
      const historical = Number(stat.success || 0) + Number(stat.failure || 0);
      stat.activations = Number(stat.activations ?? historical) + 1;
      stat.lastActivated = new Date().toISOString();
      forwardStats[id] = stat;
    }
    writeJson(forwardStatsPath, forwardStats);
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
      downstreamRelevanceFloor: downstreamFloor,
      downstreamRelevanceFiltered: relevanceFilteredNodes.slice(0, 12),
      downstreamRelevanceFilteredCount: relevanceFilteredNodes.length,
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
      compiledContextFull: compiledCtx,
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
    if (ev.type === "text_end" && ev.content) {
      const ended = String(ev.content);
      if (!currentAssistantBuffer.endsWith(ended)) currentAssistantBuffer += ended;
    }
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
    const text = assistantMessageText(event.message);
    if (text && !currentAssistantBuffer.endsWith(text)) currentAssistantBuffer += "\n" + text;
    const extracted = extractHighEntropy(currentAssistantBuffer);
    if (extracted) {
      currentAssistantHighEntropy = extracted;
      if (!currentHighEntropyLogged) {
        currentHighEntropyLogged = true;
        recordMonitorEvent({ type: "trace", action: "highentropy_captured", source: "message_end", taskFamily: currentTaskFamily || "", chars: extracted.length, preview: preview(extracted, 220), assistantBufferChars: currentAssistantBuffer.length });
      }
    }
  });

  // ══════════════════════════════════════════════════════════════════
  // agent_end → preserve selected path for forced semantic backward on next turn
  // ══════════════════════════════════════════════════════════════════

  pi.on("agent_end", async (event: any, _ctx) => {
    console.error(`[textron] agent_end FIRED at ${new Date().toISOString()}`);
    try {
    // ── Extract HighEntropy crystal to get taskType and isTask ──
    const runMessages = Array.isArray(event?.messages) ? event.messages : [];
    const eventHighEntropy = extractLatestHighEntropyFromMessages(runMessages);
    let finalAssistantText = "";
    for (let i = runMessages.length - 1; i >= 0; i--) {
      finalAssistantText = assistantMessageText(runMessages[i]);
      if (finalAssistantText) break;
    }
    if (finalAssistantText && !currentAssistantBuffer.endsWith(finalAssistantText)) {
      currentAssistantBuffer += `\n${finalAssistantText}`;
    }
    const finalCrystal = parseHighEntropyCrystal(currentAssistantBuffer);
    const highEntropy = eventHighEntropy || currentAssistantHighEntropy || (finalCrystal.ok ? `Name: ${finalCrystal.name}\n${finalCrystal.task ? `Task: ${finalCrystal.task}\n` : ""}Technique: ${finalCrystal.technique}` : "");
    const taskType = finalCrystal.taskType || "";
    const isTask = finalCrystal.isTask;

    if (!highEntropy) {
      recordMonitorEvent({
        type: "trace",
        action: "highentropy_missing_at_agent_end",
        taskFamily: currentTaskFamily || "",
        hasTag: /<HighEntropy>/i.test(`${finalAssistantText}\n${currentAssistantBuffer}`),
        reason: finalCrystal.reason || "missing",
      });
    }

    recordMonitorEvent({
      type: "hook",
      hook: "agent_end",
      taskFamily: currentTaskFamily || "",
      activatedIds: currentActivatedIds,
      hasHighEntropy: !!highEntropy,
      isTask,
      taskType,
    });

    // ── Task Stack: push if isTask, skip if intermediate ──
    if (isTask && highEntropy) {
      const newTask: TaskEntry = {
        taskType: taskType || currentTaskFamily || "unknown",
        taskFamily: currentTaskFamily || "",
        rawUserPrompt: currentRawUserPrompt,
        effectivePrompt: currentEffectivePrompt,
        highEntropy,
        activatedIds: [...currentActivatedIds],
        selectedEdgeIds: [...currentSelectedEdgeIds],
        routeUncertain: currentRouteUncertain,
        moeMaxScore: currentMoeMaxScore,
        ts: new Date().toISOString(),
      };
      // Push old activeTask to stack if exists, then set new active
      if (activeTask) {
        taskStack.push(activeTask);
        if (taskStack.length > MAX_TASK_STACK) taskStack.shift(); // FIFO evict oldest
      }
      activeTask = newTask;
      dlog("HOOK", "agent_end: task pushed to stack", { taskType, taskFamily: currentTaskFamily, stackDepth: activeTask ? taskStack.length + 1 : taskStack.length });
      recordMonitorEvent({ type: "trace", action: "agent_end_task_pushed", taskType, taskFamily: currentTaskFamily || "", stackDepth: activeTask ? taskStack.length + 1 : taskStack.length });
    } else if (activeTask && highEntropy) {
      // Intermediate turn on active task: update highEntropy (more recent context for backward)
      activeTask.highEntropy = highEntropy;
      activeTask.activatedIds = [...currentActivatedIds];
      activeTask.selectedEdgeIds = [...currentSelectedEdgeIds];
      dlog("HOOK", "agent_end: intermediate update to active task", { taskType: activeTask.taskType });
      recordMonitorEvent({ type: "trace", action: "agent_end_intermediate_updated", taskType: activeTask.taskType });
    } else {
      dlog("HOOK", "agent_end: no task to save", { isTask, hasHighEntropy: !!highEntropy });
    }

    // ── Persist taskStack to disk ──
    try {
      ensureDir(path.dirname(LAST_STATE_PATH));
      const allTasks = activeTask ? [activeTask, ...taskStack] : taskStack;
      writeJson(LAST_STATE_PATH, {
        activeTask: activeTask ? { taskType: activeTask.taskType, taskFamily: activeTask.taskFamily, highEntropy: activeTask.highEntropy.slice(0, 800), activatedIds: activeTask.activatedIds, ts: activeTask.ts } : null,
        taskStack: taskStack.map(t => ({ taskType: t.taskType, taskFamily: t.taskFamily, highEntropy: t.highEntropy.slice(0, 800), activatedIds: t.activatedIds, ts: t.ts })),
        at: new Date().toISOString(),
      });
      recordMonitorEvent({ type: "trace", action: "task_stack_persisted", activeTask: !!activeTask, stackDepth: taskStack.length });
    } catch (e) {
      recordMonitorEvent({ type: "trace", action: "task_stack_persist_failed", error: preview(e instanceof Error ? e.message : String(e), 220) });
    }
    } catch (hookErr) {
      console.error(`[textron] agent_end hook crashed:`, hookErr);
    }
  });

  // ══════════════════════════════════════════════════════════════════
  // MANUAL MODE: Textron tool (for explicit control / inspection)
  // ══════════════════════════════════════════════════════════════════

  pi.registerTool({
    name: "Textron",
    label: "Textron",
    description: "Textron text neural network — auto context graph. L0 nodes injected each turn; LLM scores relevance → programmatic edge propagation → compiled context. Manual actions: status/list (inspect), init (new network), backward (train). Node Content Rule: information-dense reusable transferable knowledge (≤1000 chars), NOT raw logs or session summaries.",
    promptSnippet: "Textron: auto-injects L0 nodes each turn. Call activate with L0 attention scores → programmatic propagation compiles context. Use backward to train.",
    promptGuidelines: [
      "Textron forward+propagate runs automatically each turn — L0 nodes are scored by LLM internally, context is already injected. No manual activation needed.",
      "Learning is automatic: the lifecycle hook runs backward after a substantive result message; do not call Textron backward manually for normal tasks.",
      "Node content MUST be high-entropy: compressed, reusable insights, not raw output. Never store session summaries, tool listings, or file manifests.",
      "If no network matches, Textron init/backward expands the best existing network; new networks are only created when none exist.",
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
          // Use reward directly — no external credit adjustment needed.
          const bwResult = autoBackward(net, activeIds, reward, log, currentSelectedEdgeIds, undefined, undefined, undefined, undefined);
          broadcast({ type: "update", taskFamily: tf, action: "backward", reward, changedEdges: bwResult.changedEdges });

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
                  // Scale-rescue: rejection = wrong scale, not garbage (Wang–Zahl).
                  const rescue = rescaleRejectedCrystal(net, rawContent, validation.reason, parsed?.layer ?? net.hyperparams.layers.length - 1, log);
                  skippedCount++;
                  skipReasons.push(`${rawKey}:${validation.reason}${rescue ? `→rescale:${rescue.action}` : ""}`);
                  log(`Textron: skipped low-entropy filledNode ${rawKey} (${validation.reason})${rescue?.rescued ? ` [rescued:${rescue.action}]` : ""}`);
                  continue;
                }
                const content = validation.content;
                if (parsed !== null) {
                  const similar = findSimilarKnowledgeNode(net, compressNodeName(content), content, 0.40, parsed.layer, parsed.nodeId);
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
                        // Scale-rescue: rejection = wrong scale, not garbage (Wang–Zahl).
                        const rescue = rescaleRejectedCrystal(net, content, layerValidation.reason, l, log);
                        skippedCount++;
                        skipReasons.push(`${rawKey}:L${l}:${layerValidation.reason}${rescue ? `→rescale:${rescue.action}` : ""}`);
                        log(`Textron: skipped low-entropy filledNode ${rawKey} for L${l} (${layerValidation.reason})${rescue?.rescued ? ` [rescued:${rescue.action}]` : ""}`);
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
                      const created = addPolicyNode(net, undefined, content, log, compressNodeName(content), undefined, { mergeSimilar: true, similarityThreshold: 0.40 });
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
              recordMonitorEvent({ type: "update", taskFamily: tf, action: "manual_backward_node_update", reward, changedEdges: bwResult.changedEdges, changedNodes, newCount, updateCount, skippedCount, skipReasons: skipReasons.slice(0, 8) });
              broadcast({ type: "update", taskFamily: tf, action: "manual_backward_node_update", reward, changedEdges: bwResult.changedEdges, changedNodes, newCount, updateCount, skippedCount, skipReasons: skipReasons.slice(0, 8) });
              if (parts.length > 0) fillMsg = `\nNodes: ${parts.join(", ")}.${skipReasons.length ? ` Skipped: ${skipReasons.slice(0, 3).join("; ")}` : ""}`;
            } catch {}
          }

          return {
            content: [{ type: "text", text: `Backward: "${tf}" reward=${reward.toFixed(1)}.${fillMsg}` }],
            details: { action: "backward", taskFamily: tf, reward, changedEdges: bwResult.changedEdges, changedNodes: manualChangedNodes },
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
