/**
 * Textron — Trainable Textual Neural Network for Agent Context Optimization
 *
 * HYBRID MODE (LLM + programmatic):
 *   1. before_agent_start auto-routes network + injects L0 nodes
 *   2. before_agent_start: blocking LLM call scores L0 nodes (0.0-1.0)
 *   3. Extension programmatically propagates L0 × edge weights → activated path
 *   4. Compiled path context injected as tool result
 *   5. LLM executes task with compiled context
 *   6. turn end: path evaluation → autoBackward (weight update + node fill)
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

function compileContext(net: NonNullable<ReturnType<typeof loadNetwork>>, activated: ActivatedNode[]): string {
  if (activated.length === 0) return "";

  const byLayer = new Map<number, ActivatedNode[]>();
  for (const n of activated) {
    const list = byLayer.get(n.layer) || [];
    list.push(n);
    byLayer.set(n.layer, list);
  }

  let ctx = `\n\n## Textron Network: ${path.basename(net.path)}\n`;
  ctx += `Trained context from previous tasks in this family.\n\n`;

  for (const [l, nodes] of [...byLayer.entries()].sort((a, b) => a[0] - b[0])) {
    for (const n of nodes) {
      ctx += `- ${n.content}\n`;
    }
  }

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
      if (reward > 0) edge.weight = clamp(old + lr * reward * (1 - old), -1, 1);
      else if (reward < 0) edge.weight = clamp(old + lr * reward * (1 + old), -1, 1);
      if (Math.abs(edge.weight - old) > 0.0005) {
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

function findSimilarNode(
  net: NonNullable<ReturnType<typeof loadNetwork>>,
  name: string,
  minScore = 0.72,
): { layer: number; nodeId: string; score: number; name: string } | null {
  const target = nameTokens(name);
  let best: { layer: number; nodeId: string; score: number; name: string } | null = null;
  for (let l = 0; l < net.hyperparams.layers.length; l++) {
    for (let n = 0; n < net.hyperparams.layers[l]; n++) {
      const nodeId = `node_${n}`;
      const nodePath = path.join(net.path, `layer_${l}`, `${nodeId}.html`);
      const existingName = readNodeName(nodePath);
      if (!existingName) continue;
      const score = jaccard(target, nameTokens(existingName));
      if (score >= minScore && (!best || score > best.score)) best = { layer: l, nodeId, score, name: existingName };
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
  return `${oldS}; ${newS}`.slice(0, 120);
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
): { layer: number; nodeId: string } {
  const nodeName = (name || compressNodeName(content)).slice(0, 64);
  const similar = findSimilarNode(net, nodeName);
  if (similar) {
    updateExistingNodeByPolicy(net, similar.layer, similar.nodeId, nodeName, content, onLog);
    return { layer: similar.layer, nodeId: similar.nodeId };
  }

  const targetLayer = chooseExpansionLayer(net, requestedLayer);
  const nodeId = `node_${net.hyperparams.layers[targetLayer]}`;
  if (requestedLayer !== undefined && targetLayer !== requestedLayer) {
    onLog(`Textron shape policy: redirected new node L${requestedLayer} → L${targetLayer} (front-narrow/back-wide)`);
  }
  addDynamicNode(net, targetLayer, nodeId, content, onLog, nodeName);
  return { layer: targetLayer, nodeId };
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

// ─── Utilities ───────────────────────────────────────────────────────

function clamp(v: number, min: number, max: number): number { return Math.max(min, Math.min(max, v)); }

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
  let currentUserPrompt = "";
  // Previous-turn state — used for forced semantic backward on the next user turn
  let lastTaskFamily: string | null = null;
  let lastActivatedIds: string[] = [];
  let lastSelectedEdgeIds: string[] = [];
  let lastUserPrompt = "";
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

  const server = http.createServer((req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");

    if (req.url === "/events") {
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

    if (req.url === "/api/state") {
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
    return { currentTaskFamily, currentActivatedIds, currentActivationScores, currentSelectedEdgeIds, lastBackwardState, networks };
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

  function autoRouteNetwork(prompt: string, networks: string[]): string | null {
    if (networks.length === 0) return null;
    if (networks.length === 1) return networks[0];
    // Score each network by keyword overlap between prompt and filled node contents
    const promptLower = prompt.toLowerCase();
    const promptWords = new Set(promptLower.split(/[\s,，。！？、:：;；]+/).filter(w => w.length > 1));
    let best: string | null = null;
    let bestScore = -1;
    for (const name of networks) {
      const net = loadNetwork(name);
      if (!net) continue;
      let allContent = "";
      for (let l = 0; l < net.hyperparams.layers.length; l++) {
        for (let n = 0; n < net.hyperparams.layers[l]; n++) {
          allContent += " " + readNodeContent(path.join(net.path, `layer_${l}`, `node_${n}.html`)).toLowerCase();
        }
      }
      let score = 0;
      for (const w of promptWords) {
        if (allContent.includes(w)) score++;
      }
      // Bonus for longer content overlap
      const contentWords = allContent.split(/[\s,，。！？、:：;；]+/).filter(w => w.length > 1);
      const intersection = contentWords.filter(w => promptWords.has(w)).length;
      score += intersection * 2;
      if (score > bestScore) { bestScore = score; best = name; }
    }
    return bestScore > 0 ? best : networks[0]; // fallback to first network
  }


  // ══════════════════════════════════════════════════════════════════
  // Blocking L0 scoring via LLM API (runs in before_agent_start, can't skip)
  // ══════════════════════════════════════════════════════════════════

  // Store model info captured from session_start (ctx.model may be undefined in before_agent_start)
  let _textronModel: any = null;
  pi.on("session_start", (_event, ctx) => {
    _textronModel = (ctx as any).model || null;
  });

  async function scoreL0WithLLM(
    l0Nodes,
    userPrompt,
    ctx,
  ) {
    const model = (ctx as any).model || _textronModel;
    if (!model?.id || !model?.baseUrl) {
      const scores = {};
      for (const n of l0Nodes) scores[`L0::${n.id}`] = 0.0;
      log("Textron: L0 scoring unavailable (no model provider), no activation");
      return scores;
    }

    const baseUrl = String(model.baseUrl).replace(/\/+$/, "");
    const endpoint = baseUrl.endsWith("/v1") ? `${baseUrl}/chat/completions` : `${baseUrl}/v1/chat/completions`;

    // Try authStorage first, then env vars, then model.apiKey
    let apiKey = "";
    try {
      const reg = (ctx as any).modelRegistry;
      const provider = String(model.provider || "");
      if (reg?.authStorage?.getApiKey) {
        apiKey = (await reg.authStorage.getApiKey(provider)) || "";
      }
    } catch {}
    if (!apiKey) {
      apiKey = String((model as any).apiKey || (model as any).provider?.apiKey || "");
    }
    if (!apiKey) {
      // Try env vars: DEEPSEEK_API_KEY, OPENAI_API_KEY, etc.
      const candidates = [
        process.env.DEEPSEEK_API_KEY,
        process.env.OPENAI_API_KEY,
        process.env.ANTHROPIC_API_KEY,
        process.env.API_KEY,
      ];
      for (const c of candidates) { if (c) { apiKey = c; break; } }
    }

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
      const parsed = extractJsonObject([textify(msg.content), textify(msg.reasoning_content), textify(msg.refusal)]);
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
        return normalized;
      } catch (e) {
        errors.push(`${attempt.label}: ${(e as Error).message}`);
      }
    }

    try {
      const normalized = await callToolScorer();
      log(`Textron: L0 scored via LLM (${Object.keys(normalized).length} nodes, provider=${model.provider}, mode=tool_call)`);
      return normalized;
    } catch (e) {
      errors.push(`tool_call: ${(e as Error).message}`);
    }

    try {
      const normalized = await callStreamingChatScorer();
      log(`Textron: L0 scored via LLM (${Object.keys(normalized).length} nodes, provider=${model.provider}, mode=stream_chat)`);
      return normalized;
    } catch (e) {
      errors.push(`stream_chat: ${(e as Error).message}`);
    }

    try {
      const normalized = await callStreamingResponsesScorer();
      log(`Textron: L0 scored via LLM (${Object.keys(normalized).length} nodes, provider=${model.provider}, mode=stream_responses)`);
      return normalized;
    } catch (e) {
      errors.push(`stream_responses: ${(e as Error).message}`);
    }

    try {
      const normalized = await callResponsesScorer();
      log(`Textron: L0 scored via LLM (${Object.keys(normalized).length} nodes, provider=${model.provider}, mode=responses_api)`);
      return normalized;
    } catch (e) {
      errors.push(`responses_api: ${(e as Error).message}`);
    }

    log(`Textron: L0 scoring failed (${errors.join(" | ")}), no activation`);
    const zeroScores: Record<string, number> = {};
    for (const n of l0Nodes) zeroScores[`L0::${n.id}`] = 0.0;
    return zeroScores;
  }


  async function semanticBackwardLLM(
    net: NonNullable<ReturnType<typeof loadNetwork>>,
    previousTask: string,
    currentUserMessage: string,
    activatedIds: string[],
    ctx: any,
  ): Promise<{ reward: number; rationale?: string; node_updates?: Record<string, string | { name?: string; content?: string; context?: string }>; add_nodes?: { layer: number; name?: string; content: string; context?: string }[] }> {
    const model = (ctx as any).model || _textronModel;
    if (!model?.id || !model?.baseUrl) return { reward: 0, rationale: "no model" };

    const baseUrl = String(model.baseUrl).replace(/\/+$/, "");
    const chatEndpoint = baseUrl.endsWith("/v1") ? `${baseUrl}/chat/completions` : `${baseUrl}/v1/chat/completions`;
    const responsesEndpoint = baseUrl.endsWith("/v1") ? `${baseUrl}/responses` : `${baseUrl}/v1/responses`;

    let apiKey = "";
    try {
      const reg = (ctx as any).modelRegistry;
      const provider = String(model.provider || "");
      if (reg?.authStorage?.getApiKey) apiKey = (await reg.authStorage.getApiKey(provider)) || "";
    } catch {}
    if (!apiKey) apiKey = String((model as any).apiKey || (model as any).provider?.apiKey || "");
    if (!apiKey) {
      for (const c of [process.env.DEEPSEEK_API_KEY, process.env.OPENAI_API_KEY, process.env.ANTHROPIC_API_KEY, process.env.API_KEY]) {
        if (c) { apiKey = c; break; }
      }
    }

    const pathNodes = activatedIds.map((id) => {
      const parsed = parseLayerNodeId(id);
      const nodePath = parsed ? path.join(net.path, `layer_${parsed.layer}`, `${parsed.nodeId}.html`) : "";
      const content = parsed ? readNodeContent(nodePath) : "";
      const name = parsed ? readNodeName(nodePath) : "";
      return { id, name, content };
    });

    const schemaHint = '{"reward":0.0,"rationale":"≤80 chars","node_updates":{"L0::node_0":{"name":"≤48 char orthogonal key","content":"≤120 char high entropy context"}},"add_nodes":[{"layer":0,"name":"abstract orthogonal key","content":"high entropy context"}]}';
    const messages = [
      { role: "system", content: `You are Textron semantic backward pass. Return ONLY JSON: ${schemaHint}. reward is continuous -1.0..1.0 for how useful the selected path was for the previous task, inferred from the current user message; use 0 when evidence is unclear. Node.name is the compressed attention key used for forward routing. Node.content/context is high-entropy knowledge injected into prompts. Keep node names short, mutually orthogonal, and layered: earlier layers are abstract/narrow routers, later layers are concrete/wide knowledge stores. node_updates may improve ONLY selected path nodes. add_nodes only for genuinely new reusable orthogonal knowledge not covered by the path; prefer later layers for concrete knowledge and use layer 0 only for abstract routing categories.` },
      { role: "user", content: `Previous user task:\n${previousTask.slice(0, 2000)}\n\nSelected path nodes:\n${pathNodes.map(n => `${n.id}: name=${n.name || "(empty)"}; context=${n.content || "(empty)"}`).join("\n")}\n\nCurrent user message / feedback:\n${currentUserMessage.slice(0, 3000)}` },
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
          if (!activatedIds.includes(k)) continue;
          if (typeof v === "string" && v.trim()) out.node_updates[k] = { content: v.trim().slice(0, 120), name: compressNodeName(v.trim()) };
          else if (v && typeof v === "object") {
            const vv = v as any;
            const content = String(vv.content || vv.context || "").trim().slice(0, 120);
            const name = String(vv.name || compressNodeName(content)).trim().slice(0, 64);
            if (content || name) out.node_updates[k] = { name, content };
          }
        }
      }
      if (Array.isArray(obj?.add_nodes)) {
        out.add_nodes = [];
        for (const n of obj.add_nodes.slice(0, 3)) {
          const layer = Number(n?.layer);
          const content = String(n?.content || n?.context || "").trim().slice(0, 120);
          const name = String(n?.name || compressNodeName(content)).trim().slice(0, 64);
          if (Number.isInteger(layer) && layer >= 0 && layer < net.hyperparams.layers.length && content) out.add_nodes.push({ layer, name, content });
        }
      }
      return out;
    }
    function extract(rawParts: string[]) {
      const raw = rawParts.filter(Boolean).join("\n").trim();
      if (!raw) throw new Error("empty semantic backward response");
      const candidates = [raw];
      const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
      if (fence?.[1]) candidates.push(fence[1]);
      for (let i = 0; i < raw.length; i++) {
        if (raw[i] !== "{") continue;
        let d = 0;
        for (let j = i; j < raw.length; j++) {
          if (raw[j] === "{") d++;
          else if (raw[j] === "}" && --d === 0) { candidates.push(raw.slice(i, j + 1)); break; }
        }
      }
      for (let i = candidates.length - 1; i >= 0; i--) {
        try { return normalize(JSON.parse(candidates[i])); } catch {}
      }
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
      const body: Record<string, unknown> = { model: model.id, messages, stream, max_completion_tokens: 4096, reasoning_effort: "low" };
      if (!stream) body.response_format = { type: "json_object" };
      const res = await fetch(chatEndpoint, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(60000) });
      if (stream) {
        if (!res.ok) throw new Error(`chat stream HTTP ${res.status}: ${(await res.text().catch(() => "")).slice(0, 160)}`);
        return extract(await readSse(res as any));
      }
      const txt = await res.text();
      const data = JSON.parse(txt);
      if (!res.ok && !data?.choices?.[0]?.message) throw new Error(`chat HTTP ${res.status}: ${txt.slice(0, 160)}`);
      const msg = data?.choices?.[0]?.message || {};
      return extract([String(msg.content || ""), String(msg.reasoning_content || "")]);
    }
    async function callResponsesStream() {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
      const body = { model: model.id, input: messages, stream: true, max_output_tokens: 4096, reasoning: { effort: "low" }, text: { format: { type: "json_object" } } };
      const res = await fetch(responsesEndpoint, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(60000) });
      if (!res.ok) throw new Error(`responses stream HTTP ${res.status}: ${(await res.text().catch(() => "")).slice(0, 160)}`);
      return extract(await readSse(res as any));
    }

    const errors: string[] = [];
    for (const [label, fn] of [["chat_json", () => callChat(false)], ["chat_stream", () => callChat(true)], ["responses_stream", callResponsesStream]] as const) {
      try {
        const result = await fn();
        log(`Textron semantic backward LLM ok (${label}, reward=${result.reward.toFixed(3)})`);
        return result;
      } catch (e) { errors.push(`${label}: ${(e as Error).message}`); }
    }
    log(`Textron semantic backward LLM failed (${errors.join(" | ")})`);
    return { reward: 0, rationale: "semantic backward failed" };
  }

  function applySemanticNodeUpdates(net: NonNullable<ReturnType<typeof loadNetwork>>, updates: Record<string, string | { name?: string; content?: string; context?: string }> | undefined, onLog: (msg: string) => void) {
    if (!updates) return 0;
    let count = 0;
    for (const [id, update] of Object.entries(updates)) {
      const parsed = parseLayerNodeId(id);
      if (!parsed) continue;
      const nodePath = path.join(net.path, `layer_${parsed.layer}`, `${parsed.nodeId}.html`);
      const oldContent = readNodeContent(nodePath);
      const oldName = readNodeName(nodePath);
      const content = typeof update === "string"
        ? update
        : String(update.content || update.context || oldContent || "").trim();
      const name = typeof update === "string"
        ? compressNodeName(update)
        : String(update.name || oldName || compressNodeName(content)).trim();
      const edgeKey = `${parsed.layer}_to_${parsed.layer + 1}`;
      const outEdges = (net.weights.layer_connections[edgeKey] || [])
        .filter((e) => e.from === parsed.nodeId)
        .map((e) => ({ toId: e.to, weight: e.weight }));
      writeNodeHtml(nodePath, parsed.layer, parsed.nodeId, content.slice(0, 120), outEdges, name.slice(0, 64));
      count++;
    }
    if (count > 0) onLog(`Textron semantic backward: ${count} selected node content update(s)`);
    return count;
  }

  async function forcedSemanticBackward(
    taskFamily: string,
    previousTask: string,
    currentUserMessage: string,
    activatedIds: string[],
    selectedEdgeIds: string[],
    ctx: any,
  ) {
    const net = loadNetwork(taskFamily);
    if (!net) return;
    const result = await semanticBackwardLLM(net, previousTask, currentUserMessage, activatedIds, ctx);
    const edgeUpdate = autoBackward(net, activatedIds, result.reward, log, selectedEdgeIds);
    const updated = applySemanticNodeUpdates(net, result.node_updates, log);
    let added = 0;
    for (const node of result.add_nodes || []) {
      addPolicyNode(net, node.layer, node.content, log, node.name);
      added++;
    }
    if (updated > 0 || added > 0) {
      net.hyperparams.updatedAt = new Date().toISOString();
      writeJson(path.join(net.path, "hyperparams.json"), net.hyperparams);
    }
    lastBackwardState = {
      taskFamily,
      reward: result.reward,
      rationale: result.rationale || "",
      nodesUpdated: updated,
      nodesAdded: added,
      edgesUpdated: edgeUpdate.changes,
      changedEdges: edgeUpdate.changedEdges,
      selectedEdgeIds,
      at: new Date().toISOString(),
    };
    log(`Textron semantic backward: reward=${result.reward.toFixed(3)}, edgesUpdated=${edgeUpdate.changes}, nodesUpdated=${updated}, nodesAdded=${added}${result.rationale ? ` — ${result.rationale}` : ""}`);
    broadcast({ type: "update", taskFamily, action: "semantic_backward", ...lastBackwardState });
  }

  // ══════════════════════════════════════════════════════════════════
  // before_agent_start → auto-route → blocking LLM L0 score → propagate → inject
  // ══════════════════════════════════════════════════════════════════

  pi.on("before_agent_start", async (event, ctx) => {
    const prevTF = lastTaskFamily;
    const prevIDs = lastActivatedIds;
    currentTaskFamily = null;
    currentActivatedIds = [];
    currentActivationScores = {};
    currentSelectedEdgeIds = [];
    currentUserPrompt = event.prompt;

    const networks = listNetworks();

    if (prevTF) {
      const capturedTF = prevTF;
      const capturedIDs = [...prevIDs];
      const capturedPrevTask = lastUserPrompt;
      const capturedCurrentMsg = event.prompt;
      const capturedEdges = [...lastSelectedEdgeIds];
      // Forced every-turn semantic backward for the previous selected path.
      forcedSemanticBackward(capturedTF, capturedPrevTask, capturedCurrentMsg, capturedIDs, capturedEdges, ctx)
        .catch((e) => log(`Textron semantic backward failed: ${e.message}`));
    }

    if (networks.length === 0) return { systemPrompt: event.systemPrompt };

    const tf = autoRouteNetwork(event.prompt, networks);
    currentTaskFamily = tf;
    const net = loadNetwork(tf);

    const l0Nodes = [];
    for (let n = 0; n < net.hyperparams.layers[0]; n++) {
      const nodePath = path.join(net.path, "layer_0", `node_${n}.html`);
      l0Nodes.push({
        id: `node_${n}`,
        name: readNodeName(nodePath),
        content: readNodeContent(nodePath),
      });
    }

    const l0Scores = await scoreL0WithLLM(l0Nodes, event.prompt, ctx);

    const { layers, threshold } = net.hyperparams;
    const scores: Record<string, number> = {};
    for (const [key, val] of Object.entries(l0Scores)) {
      scores[key] = val;
      // Also set flat key for edge lookup (edges use bare "node_X" not "L0::node_X")
      const flat = key.replace(/^L\d+::/, "");
      scores[flat] = val;
    }
    for (let l = 1; l < layers.length; l++) {
      for (let n = 0; n < layers[l]; n++) scores[`L${l}::node_${n}`] = 0;
    }

    const allActivated = [];
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
            if (e.to === tid) {
              const w = Math.max(0, e.weight);
              const contrib = (current[e.from] ?? 0) * w;
              sum += contrib;
              denom += w;
              edgeContributions.push({ fromL: l, toL: l + 1, from: e.from, to: e.to, contrib });
            }
          }
          // Attention score stays in 0..1; otherwise wide downstream layers win by fan-in count.
          next[tid] = denom > 0 ? clamp(sum / denom, 0, 1) : 0;
        }
        current = next;
      }
    }

    // Persist all scores for monitor labels, but only activate the single highest node per layer.
    currentActivationScores = {};
    const selectedByLayer = new Map<number, string>();
    for (const la of layerActivations) {
      for (const node of la.nodes) currentActivationScores[`L${la.layer}::${node.id}`] = node.score;
      const best = [...la.nodes]
        .filter((node) => node.score > threshold)
        .sort((a, b) => b.score - a.score)[0];
      if (best) {
        selectedByLayer.set(la.layer, best.id);
        allActivated.push({
          id: best.id,
          layer: la.layer,
          content: readNodeContent(path.join(net.path, `layer_${la.layer}`, `${best.id}.html`)),
          activation: best.score,
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

    currentActivatedIds = allActivated.map((n) => `L${n.layer}::${n.id}`);
    broadcast({
      type: "propagate_live",
      taskFamily: tf,
      layerActivations,
      edgeContributions,
      selectedIds: currentActivatedIds,
      selectedEdgeIds: currentSelectedEdgeIds,
      scores: currentActivationScores,
      threshold,
      totalLayers: layers.length,
    });

    const compiledCtx = compileContext(net, allActivated);

    if (allActivated.length === 0) {
      // All L0 scores 0.0 → new territory. Network stays active for backward expansion.
      log(`Textron: 0 nodes activated for "${tf}" — new knowledge territory, nodes will be created on backward`);
      return {
        systemPrompt: event.systemPrompt + `\n\n## Textron (${tf}, 0 activated — new ground, nodes created on backward)\n`,
      };
    }

    const statusHint = `\n\n## Textron Context (${tf}, ${allActivated.length}/${layers.reduce((a, b) => a + b, 0)} nodes activated)\n`;
    return {
      systemPrompt: event.systemPrompt + (compiledCtx ? statusHint + compiledCtx : ""),
    };
  });

  // ══════════════════════════════════════════════════════════════════
  // agent_end → preserve selected path for forced semantic backward on next turn
  // ══════════════════════════════════════════════════════════════════

  pi.on("agent_end", async (_event, _ctx) => {
    // Move current → last for feedback, but keep current* visible for the monitor
    // until the next before_agent_start propagation replaces it.
    lastTaskFamily = currentTaskFamily;
    lastActivatedIds = [...currentActivatedIds];
    lastSelectedEdgeIds = [...currentSelectedEdgeIds];
    lastUserPrompt = currentUserPrompt;
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
      "If no network matches and under the 10-network cap, call action='init' with a meaningful taskFamily name (e.g. 'react_hooks_debugging'). Then after the task, fill nodes via backward.",
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
      const tf = params.taskFamily || currentTaskFamily || "";

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
              text += `- **${name}**: [${hp.layers.join(",")}] thr=${hp.threshold} lr=${hp.learningRate}\n`;
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
            text += `- **${name}**: [${hp.layers.join(",")}] ${filled}/${total} nodes filled, thr=${hp.threshold}\n`;
          }
          return { content: [{ type: "text", text }], details: { action: "list", networks } };
        }

        // ── INIT ──────────────────────────────────────────────────
        case "init": {
          if (!tf) return { content: [{ type: "text", text: "Error: taskFamily required" }], details: { error: "missing taskFamily" } };
          const layers = params.layers
            ? params.layers.split(",").map((s) => parseInt(s.trim(), 10)).filter((n) => !isNaN(n) && n > 0)
            : DEFAULT_HYPERPARAMS.layers;
          if (layers.length < 2) return { content: [{ type: "text", text: "Error: need at least 2 layers" }], details: { error: "too few layers" } };
          const hp = initNetwork(tf, layers, params.threshold ?? DEFAULT_HYPERPARAMS.threshold, params.learningRate ?? DEFAULT_HYPERPARAMS.learningRate, log);
          broadcast({ type: "update", taskFamily: tf, action: "init" });
          return {
            content: [{ type: "text", text: `Created Textron network "${tf}"\nLayers: [${layers.join(",")}] → ${layers.reduce((a,b)=>a+b,0)} nodes\nThreshold: ${hp.threshold}\nLearning Rate: ${hp.learningRate}` }],
            details: { action: "init", taskFamily: tf, layers },
          };
        }

        // ── BACKWARD ────────────────────────────────────────────────
        case "backward": {
          if (!tf || !params.feedback) return { content: [{ type: "text", text: "Error: taskFamily and feedback required" }], details: { error: "missing params" } };

          // Auto-create network if it doesn't exist (max 10)
          if (!networkExists(tf)) {
            const networks = listNetworks();
            if (networks.length >= 10) {
              return { content: [{ type: "text", text: `Cannot create "${tf}": 10-network cap reached.` }], details: { error: "cap reached" } };
            }
            initNetwork(tf, DEFAULT_HYPERPARAMS.layers, DEFAULT_HYPERPARAMS.threshold, DEFAULT_HYPERPARAMS.learningRate, log);
          }

          const net = loadNetwork(tf);
          if (!net) return { content: [{ type: "text", text: "Network not found" }], details: { error: "not found" } };

          let ids: string[] = [];
          if (params.activatedNodes) { try { ids = JSON.parse(params.activatedNodes); } catch {} }

          const fb = params.feedback.toLowerCase();
          const reward = fb.includes("success") || fb.includes("对") || fb.includes("好") ? 1.0
            : fb.includes("fail") || fb.includes("错") || fb.includes("wrong") ? -0.5 : 0.0;

          autoBackward(net, ids.length > 0 ? ids : currentActivatedIds, reward, log, currentSelectedEdgeIds);
          broadcast({ type: "update", taskFamily: tf, action: "backward", reward });

          // Fill/update nodes — supports "L<N>::node_X" layer-qualified keys and legacy flat keys
          // Existing nodes get their content UPDATED (not just filled when empty)
          // New node IDs (beyond current layer size) are created dynamically
          let fillMsg = "";
          if (params.filledNodes) {
            try {
              const filled = JSON.parse(params.filledNodes) as Record<string, string>;
              let newCount = 0, updateCount = 0;
              for (const [rawKey, content] of Object.entries(filled)) {
                if (!content) continue;
                const parsed = parseLayerNodeId(rawKey);
                if (parsed !== null) {
                  // Layer-qualified: L<N>::node_X — fill/update exact layer
                  const np = path.join(net.path, `layer_${parsed.layer}`, `${parsed.nodeId}.html`);
                  if (fs.existsSync(np)) {
                    const old = readNodeContent(np);
                    // Always write — update if existing, fill if empty
                    const outEdges = (net.weights.layer_connections[`${parsed.layer}_to_${parsed.layer + 1}`] || []).filter(e => e.from === parsed.nodeId).map(e => ({ toId: e.to, weight: e.weight }));
                    writeNodeHtml(np, parsed.layer, parsed.nodeId, content, outEdges, compressNodeName(content));
                    if (old) updateCount++; else newCount++;
                  } else {
                    // Node doesn't exist — dynamically create it
                    const nodeIndex = parseInt(parsed.nodeId.replace('node_', ''), 10);
                    if (!isNaN(nodeIndex) && nodeIndex >= 0) {
                      addPolicyNode(net, parsed.layer, content, log, compressNodeName(content));
                      newCount++;
                    }
                  }
                } else {
                  // Legacy flat key — fill/update the first matching node found across all layers
                  let handled = false;
                  for (let l = 0; l < net.hyperparams.layers.length; l++) {
                    const np = path.join(net.path, `layer_${l}`, `${rawKey}.html`);
                    if (fs.existsSync(np)) {
                      const old = readNodeContent(np);
                      const outEdges = (net.weights.layer_connections[`${l}_to_${l + 1}`] || []).filter(e => e.from === rawKey).map(e => ({ toId: e.to, weight: e.weight }));
                      writeNodeHtml(np, l, rawKey, content, outEdges, compressNodeName(content));
                      if (old) updateCount++; else newCount++;
                      handled = true;
                      break;
                    }
                  }
                  // If no matching node found, try to create in the first layer
                  if (!handled) {
                    const nodeIndex = parseInt(rawKey.replace('node_', ''), 10);
                    if (!isNaN(nodeIndex) && nodeIndex >= 0) {
                      addPolicyNode(net, undefined, content, log, compressNodeName(content));
                      newCount++;
                    }
                  }
                }
              }
              const parts: string[] = [];
              if (newCount > 0) parts.push(`${newCount} new`);
              if (updateCount > 0) parts.push(`${updateCount} updated`);
              if (parts.length > 0) fillMsg = `\nNodes: ${parts.join(", ")}.`;
            } catch {}
          }

          return {
            content: [{ type: "text", text: `Backward: "${tf}" reward=${reward.toFixed(1)}.${fillMsg}` }],
            details: { action: "backward", taskFamily: tf, reward },
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
