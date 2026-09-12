/**
 * 三层架构(2026-09-02 讨论落地):
 *   拓扑层   = ngram-cos 派生, 不持久化, 按需重算
 *              (跨层 top-K + 入度兜底 → 消灭孤立节点/冷启动自锁;
 *               同层 mutual-kNN → Memora 式扩散召回 + hub 防御)
 *   经验层   = weights.json.ledger { "0_to_1:node_a:node_b": {delta,n} }
 *              只存 backward 真正训过的边(稀疏 delta), 不再维护全连接账本
 *   物化视图 = weights.json.layer_connections (含 `${l}_to_${l}` 同层边)
 *              供 forward / computePageRank / monitor 消费, 每 pair 唯一
 *
 * 有效权重  w = (1-α)·prior(sim) + α·delta,  α = ALPHA_MAX·(1-0.5^(n/HALF_LIFE))
 *   - prior 永远保留 (1-ALPHA_MAX) 份额 → 结构正则, 单条边不会被一次噪声打死
 *   - 经验越多 α 越接近上限 → 反馈逐步接管
 *
 * 负权重语义: delta<0 = 失败/抑制记忆(相似度无法表达的部分, Textron 的学习护城河)
 */
import * as path from "node:path";
import { tokenize } from "../ngram_distill";
import { readNodeName, readNodeContent } from "./node_io";
import { readJson, writeJson } from "./utils";

export const TOPO = {
  CROSS_K: 6,        // 跨层: 每个源节点 top-K 目标
  CROSS_THR: 0.10,   // 跨层相似度阈值
  LAT_K: 4,          // 同层 mutual-kNN 候选数
  LAT_THR: 0.30,     // 同层阈值: 蒸馏晶体共享术语≈共享机制, 高阈值防 hub
  PRIOR_GAIN: 1.4,   // sim → prior 权重增益
  PRIOR_MIN: 0.08,
  PRIOR_MAX: 0.60,
  ALPHA_MAX: 0.95,   // 经验份额上限: 保留 5% 先验正则; 且能表示旧账本 ±0.87 极端权重(迁移保真)
  HALF_LIFE: 10,     // n 每翻一倍, α 向 ALPHA_MAX 逼近一半
  LAT_BETA: 0.35,    // 前向同层扩散强度(max 规则, 不吞自身分)
  MIGRATED_N: 100,   // 迁移条目按高置信处理, 保真旧训练权重
};

export interface LedgerEntry { delta: number; n: number }
interface TopoNet { hyperparams: { layers: number[] }; path: string; weights: any }

export function pairKey(sec: string, from: string, to: string): string { return `${sec}:${from}:${to}`; }
export function parsePairKey(k: string): { l: number; m: number; from: string; to: string } | null {
  const m = k.match(/^(\d+)_to_(\d+):(.+):(.+)$/);
  if (!m) return null;
  return { l: +m[1], m: +m[2], from: m[3], to: m[4] };
}

function clamp(v: number, lo: number, hi: number) { return Math.max(lo, Math.min(hi, v)); }

/** ngram 键按 · 归一化: tokenize 保留整短语且不切 ·, 蒸馏 name 的 · 分段是主要共享粒度 */
function expandKey(into: Record<string, number>, key: string, w: number) {
  for (const part of key.split("·")) {
    const p = part.trim();
    if (p.length >= 2) into[p] = (into[p] || 0) + w;
  }
}

/** 节点稀疏向量: 优先 ngram 影子(字段加权), 新节点回退 name+content 词面 */
function uniVector(net: TopoNet, layer: number, nodeId: string): Record<string, number> {
  const np = path.join(net.path, `layer_${layer}`, `${nodeId}.html`);
  try {
    const st = readJson<any>(np.replace(/\.html$/, ".ngram.json"), null);
    if (st && st.uni && Object.keys(st.uni).length) {
      const v: Record<string, number> = {};
      for (const k in st.uni) expandKey(v, k, st.uni[k]);
      return v;
    }
  } catch { /* 无影子 */ }
  try {
    const v: Record<string, number> = {};
    const text = `${String(readNodeName(np) || "").replace(/·/g, " ")} ${readNodeContent(np)}`;
    for (const t of tokenize(text)) v[t] = (v[t] || 0) + 1;
    return v;
  } catch { return {}; }
}

function cosine(a: Record<string, number>, b: Record<string, number>): number {
  let dot = 0, na = 0, nb = 0;
  for (const k in a) { na += a[k] * a[k]; const bv = b[k]; if (bv) dot += a[k] * bv; }
  for (const k in b) nb += b[k] * b[k];
  return na > 0 && nb > 0 ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

/** 拓扑派生: 返回 pairKey → sim。跨层 top-K + 入度兜底; 同层 mutual-kNN(对称双存) */
export function buildTopology(net: TopoNet): Map<string, number> {
  const layers = net.hyperparams.layers;
  const sims = new Map<string, number>();
  const V = layers.map((cnt: number, l: number) =>
    Array.from({ length: cnt }, (_, n) => uniVector(net, l, `node_${n}`)));

  for (let l = 0; l < layers.length - 1; l++) {
    const A = V[l], B = V[l + 1];
    const S: number[][] = A.map(a => B.map(b => cosine(a, b)));
    const hasIn = new Array(B.length).fill(false);
    for (let f = 0; f < A.length; f++) {
      const ranked = B.map((_, t) => [t, S[f][t]] as const)
        .filter(x => x[1] >= TOPO.CROSS_THR).sort((x, y) => y[1] - x[1]).slice(0, TOPO.CROSS_K);
      for (const [t, s] of ranked) { sims.set(pairKey(`${l}_to_${l + 1}`, `node_${f}`, `node_${t}`), s); hasIn[t] = true; }
    }
    // 入度兜底: 零入边目标连最强源(哪怕低于阈值) → 结构上不再有孤立节点
    for (let t = 0; t < B.length; t++) {
      if (hasIn[t]) continue;
      let best = -1, bs = 0;
      for (let f = 0; f < A.length; f++) if (S[f][t] > bs) { bs = S[f][t]; best = f; }
      if (best >= 0 && bs > 0) sims.set(pairKey(`${l}_to_${l + 1}`, `node_${best}`, `node_${t}`), bs);
    }
  }

  for (let l = 0; l < layers.length; l++) {
    const A = V[l];
    const S: number[][] = A.map(a => A.map(b => cosine(a, b)));
    const top = A.map((_, i) => new Set(
      S[i].map((s, j) => [j, i === j ? -1 : s] as const)
        .filter(x => x[1] >= TOPO.LAT_THR).sort((x, y) => y[1] - x[1]).slice(0, TOPO.LAT_K).map(x => x[0])
    ));
    for (let i = 0; i < A.length; i++) for (const j of top[i]) if (i < j && top[j].has(i)) {
      sims.set(pairKey(`${l}_to_${l}`, `node_${i}`, `node_${j}`), S[i][j]);
      sims.set(pairKey(`${l}_to_${l}`, `node_${j}`, `node_${i}`), S[i][j]);
    }
  }
  return sims;
}

export function priorWeight(sim: number): number {
  return sim > 0 ? clamp(sim * TOPO.PRIOR_GAIN, TOPO.PRIOR_MIN, TOPO.PRIOR_MAX) : 0;
}

/** 置信融合: 训练次数 n 决定经验对先验的替换度 */
export function effectiveWeight(sim: number, e?: LedgerEntry): number {
  const p = priorWeight(sim);
  if (!e || e.n <= 0) return p;
  const a = TOPO.ALPHA_MAX * (1 - Math.pow(0.5, e.n / TOPO.HALF_LIFE));
  return clamp((1 - a) * p + a * e.delta, -1, 1);
}

/** 物化: layer_connections = (拓扑 ∪ 账本) 的每-pair-唯一视图; 同层边在 `${l}_to_${l}` */
export function materialize(net: TopoNet): { edges: number; lateral: number; trained: number } {
  const sims = buildTopology(net);
  const led: Record<string, LedgerEntry> = net.weights.ledger || {};
  const out: Record<string, { from: string; to: string; weight: number }[]> = {};
  let edges = 0, lateral = 0, trained = 0;
  for (const k of new Set([...sims.keys(), ...Object.keys(led)])) {
    const pk = parsePairKey(k); if (!pk) continue;
    const e = led[k]; if (e) trained++;
    const w = effectiveWeight(sims.get(k) || 0, e);
    if (Math.abs(w) <= 0.001) continue;   // 保负权: |w|阈值而非 w阈值, 抑制边(失败记忆)必须留在视图里
    const sec = `${pk.l}_to_${pk.m}`;
    (out[sec] ||= []).push({ from: pk.from, to: pk.to, weight: Math.round(w * 10000) / 10000 });
    edges++; if (pk.l === pk.m) lateral++;
  }
  for (const arr of Object.values(out))
    arr.sort((a, b) => a.from < b.from ? -1 : a.from > b.from ? 1 : a.to < b.to ? -1 : a.to > b.to ? 1 : 0);
  net.weights.layer_connections = out;
  return { edges, lateral, trained };
}

/**
 * 旧格式迁移: 重复边 collapse(last-wins); 未动过的 DEFAULT_WEIGHT(0.5) 全连接条目丢弃
 * (那是假先验, 交给内容 sim 派生); 训练过的条目反解 delta 使物化输出保真旧权重, 零行为跳变。
 */
export function migrateLedger(net: TopoNet, defaultWeight = 0.5): boolean {
  if (net.weights.ledger) return false;
  const sims = buildTopology(net);
  const led: Record<string, LedgerEntry> = {};
  const a = TOPO.ALPHA_MAX * (1 - Math.pow(0.5, TOPO.MIGRATED_N / TOPO.HALF_LIFE));
  for (const [sec, edges] of Object.entries<any>(net.weights.layer_connections || {})) {
    const m = sec.match(/^(\d+)_to_(\d+)$/); if (!m) continue;
    const seen = new Map<string, number>();
    for (const e of edges) seen.set(pairKey(sec, e.from, e.to), e.weight);
    for (const [k, w] of seen) {
      if (Math.abs(w - defaultWeight) < 1e-9) continue;
      const p = priorWeight(sims.get(k) || 0);
      led[k] = { delta: clamp((w - (1 - a) * p) / a, -1, 1), n: TOPO.MIGRATED_N };
    }
  }
  net.weights.ledger = led;
  return true;
}

/** 前向同层扩散: 种子按 lateral 边拉入相似邻居(1跳, max 规则), 补 DAG 漏召回 */
export function lateralDiffuse(net: TopoNet, layer: number, scores: Record<string, number>): number {
  const edges = net.weights?.layer_connections?.[`${layer}_to_${layer}`] || [];
  if (!edges.length) return 0;
  const get = (id: string) => scores[`L${layer}::${id}`] ?? scores[id] ?? 0;
  const best: Record<string, number> = {};
  for (const e of edges) {
    const v = get(e.from) * Math.max(0, e.weight);
    if (v > (best[e.to] || 0)) best[e.to] = v;
  }
  let lifted = 0;
  for (const [tid, v] of Object.entries(best)) {
    const cand = TOPO.LAT_BETA * v;
    if (cand > get(tid)) { scores[`L${layer}::${tid}`] = cand; scores[tid] = cand; lifted++; }
  }
  return lifted;
}

/** backward 训练入口: 对 pair 的 delta 施加原 clamp 学习规则并计次 */
export function trainPair(net: TopoNet, key: string, reward: number, lr: number): { old: number; next: number; n: number } | null {
  if (!parsePairKey(key)) return null;
  const led: Record<string, LedgerEntry> = (net.weights.ledger ||= {});
  const rec = (led[key] ||= { delta: 0, n: 0 });
  const old = rec.delta;
  if (reward > 0) rec.delta = clamp(old + lr * reward * (1 - old), -1, 1);
  else if (reward < 0) rec.delta = clamp(old + lr * reward * (1 + old), -1, 1);
  else return null;
  rec.n++;
  return { old, next: rec.delta, n: rec.n };
}

export function saveWeights(net: TopoNet) { writeJson(path.join(net.path, "weights.json"), net.weights); }
