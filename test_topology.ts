/**
 * test_topology.ts — 三层架构(拓扑派生 / ledger 经验 / 物化视图)单元测试
 * 运行: node <pi>/node_modules/.bin/jiti src/test_topology.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";
import {
  buildTopology, materialize, migrateLedger, effectiveWeight,
  lateralDiffuse, trainPair, pairKey, priorWeight, TOPO,
} from "./src/lib/topology";

const ROOT = "/tmp/textron-topo-test/net1";
fs.rmSync("/tmp/textron-topo-test", { recursive: true, force: true });
for (const l of [0, 1, 2]) fs.mkdirSync(path.join(ROOT, `layer_${l}`), { recursive: true });

function node(l: number, n: number, name: string, uni?: Record<string, number>) {
  fs.writeFileSync(path.join(ROOT, `layer_${l}`, `node_${n}.html`),
    `<!DOCTYPE html>\n<meta name="layer" content="${l}">\n<meta name="id" content="node_${n}">\n<meta name="name" content="${name}">\n<content>${name}</content>\n`);
  if (uni) {
    fs.writeFileSync(path.join(ROOT, `layer_${l}`, `node_${n}.ngram.json`),
      JSON.stringify({ uni, bi: {}, tri: {}, penalty_uni: {}, penalty_bi: {}, penalty_tri: {}, totalActivations: 5, successfulActivations: 3, lastDistillAt: 0 }));
  }
}

node(0, 0, "放量突破·缩量回踩·卖盘枯竭", { 放量突破: 3, 缩量回踩: 3, 卖盘枯竭: 2, 位置定性: 1 });
node(0, 1, "K线三维共振·位置均线形态", { 三维共振: 2, 位置均线形态: 2 });
node(0, 2, "吉他音色·808滑音", { "808滑音": 2 });                    // 跨域, 预期无跨层出边
node(1, 0, "因果机制·缩量回踩卖盘枯竭", { 缩量回踩: 2, 卖盘枯竭: 2, 中性信号: 1 });
node(1, 1, "罕见机制·位置均线形态", { 位置均线形态: 1 });              // 仅共享一个词 → 测入度兜底
node(2, 0, "技术晶体·缩量回踩洗盘判据", { 缩量回踩: 2, 洗盘判据: 2 });
node(2, 1, "技术晶体·缩量回踩洗盘判据2", { 缩量回踩: 2, 洗盘判据: 2 }); // 与 n0 全同 → 测 lateral

const net: any = {
  hyperparams: { layers: [3, 2, 2], threshold: 0.08, learningRate: 0.12 },
  path: ROOT,
  weights: { layer_connections: {
    "0_to_1": [
      { from: "node_0", to: "node_0", weight: 0.5 },    // 未动全连接 → 迁移时丢弃
      { from: "node_1", to: "node_1", weight: -0.87 },  // 训练过 → 保真迁移
      { from: "node_1", to: "node_1", weight: -0.87 },  // 重复边 → collapse
      { from: "node_2", to: "node_0", weight: 0.62 },
    ],
    "1_to_2": [
      { from: "node_0", to: "node_0", weight: 0.71 },
      { from: "node_0", to: "node_1", weight: 0.5 },    // 未动 → 丢弃
    ],
  } },
};

let fails = 0;
const ok = (c: boolean, m: string) => { console.log(c ? "✅" : "❌", m); if (!c) fails++; };

// ── 1. 迁移 ──
ok(migrateLedger(net) === true, "migrateLedger 首次触发");
ok(migrateLedger(net) === false, "二次调用幂等 no-op");
const ledKeys = Object.keys(net.weights.ledger);
ok(ledKeys.length === 3, `ledger 只收训练过的唯一 pair (${ledKeys.length}=3, 重复collapse, 0.5丢弃)`);
ok(ledKeys.includes(pairKey("0_to_1", "node_1", "node_1")), "trained -0.87 入 ledger");

// ── 2. 物化: 唯一性 + 入度兜底 + lateral ──
const st = materialize(net);
const lc = net.weights.layer_connections;
const uniqPairs = (arr: any[]) => new Set(arr.map(e => e.from + ">" + e.to)).size === arr.length;
ok(uniqPairs(lc["0_to_1"]), "0_to_1 每 pair 唯一");
const inL1 = new Set((lc["0_to_1"] || []).map(e => e.to));
ok(inL1.has("node_0") && inL1.has("node_1"), `L1 入度兜底 (top-K+兜底: ${[...inL1]})`);
const inL2 = new Set((lc["1_to_2"] || []).map(e => e.to));
ok(inL2.has("node_0") && inL2.has("node_1"), "L2 入度≥1(含 trained-only 边)");
ok((lc["2_to_2"] || []).length === 2, `lateral mutual-kNN 对称双存 (${(lc["2_to_2"] || []).length})`);
ok((lc["0_to_1"] || []).every(e => !(e.from === "node_2" && e.to === "node_1")), "跨域 L0n2 零相似目标不产生假先验边(node_2→node_0 是合法 trained 边)");

// ── 3. 迁移保真: -0.87 极端权重不跳变 ──
const w11 = (lc["0_to_1"] || []).find(e => e.from === "node_1" && e.to === "node_1");
ok(!!w11 && Math.abs(w11.weight - (-0.87)) < 0.03, `训练权重保真 ${w11?.weight} ≈ -0.87`);

// ── 4. 置信融合数学 ──
const sim07 = 0.5;
const wN0 = effectiveWeight(sim07, undefined);
const wN1 = effectiveWeight(sim07, { delta: 1, n: 1 });
const wN100 = effectiveWeight(sim07, { delta: 1, n: 100 });
ok(wN0 === priorWeight(sim07), "n=0 → 纯先验");
ok(wN1 > wN0 && wN1 < wN100 && wN100 <= 1, `α 随 n 单调: prior=${wN0} → n1=${wN1.toFixed(3)} → n100=${wN100.toFixed(3)}`);

// ── 5. trainPair: 单次训练先验主导(不被一次噪声打死) ──
const before = JSON.stringify(lc["0_to_1"]);
const tp = trainPair(net, pairKey("0_to_1", "node_0", "node_0"), 1, 0.12);
ok(!!tp && tp.n === 1 && Math.abs(tp.next - 0.12) < 1e-9, `trainPair delta=lr·r·(1-d) (${tp?.next})`);
materialize(net);
const w00 = (net.weights.layer_connections["0_to_1"] || []).find(e => e.from === "node_0" && e.to === "node_0");
ok(!!w00 && Math.abs(w00.weight - priorWeight(0.71 * 1.4 > 0.6 ? 0.6 / 1.4 : 0.71)) < 0.15, `单次训练仅微移先验 (${w00?.weight})`);
ok(JSON.stringify(net.weights.layer_connections["0_to_1"]) !== before, "物化视图随 ledger 更新");

// ── 6. lateralDiffuse: 种子拉邻居, max 规则不吞自身 ──
const scores: Record<string, number> = { "L0::node_0": 0.9 };
net.weights.layer_connections["0_to_0"] = [{ from: "node_0", to: "node_2", weight: 0.5 }];
const lifted = lateralDiffuse(net, 0, scores);
ok(lifted === 1 && Math.abs(scores["L0::node_2"] - 0.35 * 0.9 * 0.5) < 1e-9, `扩散 β·src·w (${scores["L0::node_2"]})`);
ok(scores["L0::node_0"] === 0.9, "max 规则不改变种子自身");

console.log(fails ? `\n${fails} FAILED` : "\nALL PASSED");
process.exit(fails ? 1 : 0);
