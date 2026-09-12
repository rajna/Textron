// 抽象提升 merge 机制化验证 —— 层深参数化 runner (2026-09-04 v2)
// 机制: buildTopology 按 l→l+1 词面建边 + 入度兜底, 与具体层号无关;
//       merge 结果层 = 同层上提/异层归min/L0封顶, 对任意层深同一代码路径。
// 因此测试 = 一个参数化函数跑多组层深, 而非按层枚举场景。
// 运行: npx esbuild test_lift_merge.ts --bundle --platform=node --format=cjs --outfile=/tmp/lt.cjs && node /tmp/lt.cjs
import * as fs from "node:fs";
import * as path from "node:path";
import { writeNodeHtml, readNodeContent } from "./src/lib/node_io";
import { liftMergeNodes, liftMergeResultLayer } from "./src/lib/lift_merge";
import { materialize } from "./src/lib/topology";
import { tokenize, createNodeState, updateCounts } from "./src/ngram_distill";
import { compactMergeEmptiedNodes } from "./src/lib/node_policy";

const ROOT = "/tmp/lt_param";
let pass = 0, fail = 0;
function assert(c: boolean, m: string) { if (c) { pass++; console.log("  ✅", m); } else { fail++; console.log("  ❌", m); } }

function putNode(layer: number, id: string, c: string) {
  writeNodeHtml(path.join(ROOT, `layer_${layer}`, `${id}.html`), layer, id, c, [], c.slice(0, 24));
  const st = createNodeState(); for (const t of tokenize(c)) updateCounts(st, t);
  fs.writeFileSync(path.join(ROOT, `layer_${layer}`, `${id}.ngram.json`), JSON.stringify(st));
}
/** 参数化网络: 每层 nodesPerLayer 节点(全层共享词 base + 各层特征词), 附 ngram 影子(生产同构) */
function buildNet(layerCount: number, nodesPerLayer: number, featureByLayer: string[]) {
  for (let l = 0; l < 6; l++) fs.mkdirSync(path.join(ROOT, `layer_${l}`), { recursive: true });
  for (let l = 0; l < 6; l++) for (const f of fs.readdirSync(path.join(ROOT, `layer_${l}`))) fs.unlinkSync(path.join(ROOT, `layer_${l}`, f));
  fs.writeFileSync(path.join(ROOT, "hyperparams.json"), JSON.stringify({ layers: Array(layerCount).fill(nodesPerLayer) }, null, 2));
  fs.writeFileSync(path.join(ROOT, "weights.json"), JSON.stringify({ layer_connections: {}, ledger: {} }, null, 2));
  for (let l = 0; l < layerCount; l++)
    for (let n = 0; n < nodesPerLayer; n++)
      putNode(l, `node_${n}`, `放量突破 ${featureByLayer[l] || ""} 变体${n}`.trim());
  return {
    path: ROOT,
    hyperparams: { layers: Array(layerCount).fill(nodesPerLayer) },
    weights: JSON.parse(fs.readFileSync(path.join(ROOT, "weights.json"), "utf-8")),
  };
}
function save(net: any) {
  fs.writeFileSync(path.join(ROOT, "hyperparams.json"), JSON.stringify({ layers: net.hyperparams.layers }, null, 2));
  fs.writeFileSync(path.join(ROOT, "weights.json"), JSON.stringify(net.weights, null, 2));
}
function w(): any { return JSON.parse(fs.readFileSync(path.join(ROOT, "weights.json"), "utf-8")); }
function nodeEdges(layer: number, id: string): any[] {
  const ww = w(); const out: any[] = [];
  for (const [sec, es] of Object.entries<any>(ww.layer_connections || {})) for (const e of es) if (e.from === id && sec.startsWith(`${layer}_to_`) || e.to === id) out.push(e);
  return out;
}

// ── A. 机制前置: 任意层深 l→l+1 词面建边(与层号无关) ──
console.log("== A. buildTopology 层深无关性 ==");
for (const depth of [3, 5, 6]) {
  const net = buildNet(depth, 2, Array.from({ length: depth }, () => ""));
  materialize(net);
  const segs = Object.keys(net.weights.layer_connections || {}).filter((k) => k.match(/^\d+_to_\d+$/) && !k.endsWith("_to_" + k.split("_to_")[0])).length;
  // 跨层段应为 depth-1 个(0_to_1...depth-2_to_depth-1)
  const cross = Object.keys(net.weights.layer_connections || {}).filter((k) => { const [a, b] = k.split("_to_"); return a !== b; }).length;
  assert(cross === depth - 1, `${depth}层 建 ${depth - 1} 个跨层段 (实际 ${cross})`);
}

// ── B. 结果层规则(纯函数, 任意层深) ──
console.log("== B. liftMergeResultLayer ==");
const ruleCases: [number, number, number][] = [
  [0, 0, 0], [0, 1, 0], [0, 5, 0], [1, 2, 1], [2, 1, 1], [2, 2, 1],
  [3, 3, 2], [4, 4, 3], [5, 5, 4], [3, 4, 3], [5, 2, 2],
];
for (const [s, t, exp] of ruleCases) {
  const got = liftMergeResultLayer(s, t);
  assert(got === exp, `L${s}+L${t} → L${exp} (实际 L${got})`);
}

// ── C. 层深参数化 merge runner ──
console.log("== C. 层深参数化 merge ==");
function assertMerge(label: string, srcL: number, srcId: string, tgtL: number, tgtId: string, expHostL: number, featureByLayer: string[]) {
  console.log(`  -- ${label} --`);
  const net = buildNet(6, 2, featureByLayer);
  net.weights.ledger = {};
  // 预置训练经验: 源节点的上游入边 + 宿主侧经验
  if (srcL > 0) net.weights.ledger[`${srcL - 1}_to_${srcL}:node_0:${srcId}`] = { delta: 0.7, n: 8 };
  if (tgtL > 0) net.weights.ledger[`${tgtL - 1}_to_${tgtL}:node_0:${tgtId}`] = { delta: 0.5, n: 4 };
  if (srcL === tgtL) net.weights.ledger[`${srcL}_to_${srcL}:node_0:node_1`] = { delta: 0.3, n: 3 };
  save(net);
  const out = liftMergeNodes(net, { layer: srcL, nodeId: srcId }, { layer: tgtL, nodeId: tgtId }, (m) => console.log("   ", m));
  save(net);
  assert(out.merged, "merge 成功");
  assert(out.hostLayer === expHostL, `宿主层=${expHostL} (实际 ${out.hostLayer})`);
  materialize(net); save(net);
  const e = nodeEdges(out.hostLayer, out.hostId);
  assert(e.length >= 1, `宿主 L${out.hostLayer}::${out.hostId} 物化后有边(${e.length})`);
  if (out.emptied.length > 0) {
    compactMergeEmptiedNodes(net, () => {}); save(net);
    const led = w().ledger || {};
    const ghost = Object.keys(led).some((k: string) => out.emptied.some((em) => k.startsWith(`${em.layer}_to_`) && (k.includes(`:${em.nodeId}:`) || k.endsWith(`:${em.nodeId}`))));
    assert(!ghost, "compact 后无指向被吸收节点的幽灵 ledger 键");
  }
}

const F = ["原理", "趋势", "规则", "细节", "微操", "参数"];
assertMerge("L2+L2→L1 同层提升", 2, "node_1", 2, "node_0", 1, F);
assertMerge("L3+L3→L2 同层提升", 3, "node_1", 3, "node_0", 2, F);
assertMerge("L4+L4→L3 同层提升", 4, "node_1", 4, "node_0", 3, F);
assertMerge("L2+L3→L2 异层归抽象", 3, "node_1", 2, "node_0", 2, F);
assertMerge("L3+L4→L3 异层归抽象", 4, "node_1", 3, "node_0", 3, F);
assertMerge("L5+L5→L4 深链同层", 5, "node_1", 5, "node_0", 4, F);
assertMerge("L0+L4→L0 含L0封顶", 4, "node_1", 0, "node_0", 0, F);

console.log(`\n结果: ${pass} passed / ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
