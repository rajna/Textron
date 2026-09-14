/**
 * 容量硬闸测试（隔离网络 zz-caphard-test / zz-caphard-test2，跑完即删）
 * 需求(2026-09-14): 每层 cap 是硬不变量 — 任何路径(含 merge 派生 add/溢出伴随/宿主落位)不得超容;
 * 且 skip 不许静默(宿主落位失败必须带 reason 交上层压缩轮回喂 LLM)。
 * 验证:
 *  T1 跨层 merge 宿主落位撞 cap → merged:false + reason=host_alloc_over_cap, L0 不增
 *  T2 同层大内容 merge → 宿主复用 + 溢出复用源清空后的空壳, layers 不扩容
 *  T3 cap>slots 时 append 放行(有真实容量), layers 允许增长到 cap 内
 *  T4 超容存量网(legacy 9/2): 同层 merge 仍可收缩(alive 递减), 跨层撞 L0 被拒
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { initNetwork, loadNetwork } from "./src/lib/network";
import { liftMergeNodes } from "./src/lib/lift_merge";
import { writeNodeHtml, readNodeContent } from "./src/lib/node_io";

const HOME = process.env.TEXTRON_HOME || "/tmp/textron-captest";
const logs: string[] = [];
const log = (m: string) => logs.push(m);
let pass = 0, fail = 0;
function assert(cond: boolean, name: string, extra?: any) {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}`, extra ?? ""); }
}
function netDir(tf: string) { return path.join(HOME, tf); }
function aliveCount(netPath: string, layer: number, layers: number[]) {
  let c = 0;
  for (let n = 0; n < layers[layer]; n++) if (readNodeContent(path.join(netPath, `layer_${layer}`, `node_${n}.html`))) c++;
  return c;
}
const big = (tag: string) => `机制${tag}: 因果链推理路径依赖记忆巩固测试样本。`.repeat(60); // >1000c

// ── Case 1/2: caps=[2,2,2]（initNetwork 落盘 layerCaps=[...layers]）──
const TF = "zz-caphard-test";
fs.rmSync(netDir(TF), { recursive: true, force: true });
initNetwork(TF, [2, 2, 2], 0.2, 0.1, log);
let net = loadNetwork(TF)!;

// 铺满 L0(2 alive) + L1(2 alive)
for (const [l, n] of [[0, 0], [0, 1], [1, 0], [1, 1]] as const) {
  writeNodeHtml(path.join(netDir(TF), `layer_${l}`, `node_${n}.html`), l, `node_${n}`, `L${l}节点${n}内容`, [], `L${l}n${n}`);
}
console.log("T1 跨层 merge 宿主落位撞 cap（L1+L1→L0, L0 已满 2/2）:");
const r1 = liftMergeNodes(net, { layer: 1, nodeId: "node_0" }, { layer: 1, nodeId: "node_1" }, log);
assert(r1.merged === false, "T1a merge 被拒绝(merged=false)", r1);
assert(String(r1.reason).startsWith("host_alloc_over_cap"), "T1b reason=host_alloc_over_cap(非静默 skip)", r1.reason);
assert(JSON.stringify(net.hyperparams.layers) === "[2,2,2]", "T1c layers 不扩容", net.hyperparams.layers);
assert(aliveCount(netDir(TF), 0, net.hyperparams.layers) === 2, "T1d L0 alive 恒=2(硬不变量)");

console.log("T2 同层大内容 merge（宿主复用+溢出复用空壳）:");
writeNodeHtml(path.join(netDir(TF), "layer_0", "node_0.html"), 0, "node_0", big("X"), [], "bigX");
writeNodeHtml(path.join(netDir(TF), "layer_0", "node_1.html"), 0, "node_1", big("Y"), [], "bigY");
const r2 = liftMergeNodes(net, { layer: 0, nodeId: "node_0" }, { layer: 0, nodeId: "node_1" }, log);
assert(r2.merged === true, "T2a 同层 merge 成功", r2);
assert(r2.overflowNodeId === "node_0", "T2b 溢出复用源清空后的空壳 node_0(内容不丢)", r2.overflowNodeId);
assert(JSON.stringify(net.hyperparams.layers) === "[2,2,2]", "T2c layers 恒不扩容", net.hyperparams.layers);
assert(aliveCount(netDir(TF), 0, net.hyperparams.layers) === 2, "T2d L0 alive=2(宿主+溢出, 不超容)");

// ── Case 3: caps=[4,4,4] 但 slots=[2,2,2] → append 放行 ──
const TF2 = "zz-caphard-test2";
fs.rmSync(netDir(TF2), { recursive: true, force: true });
initNetwork(TF2, [2, 2, 2], 0.2, 0.1, log);
net = loadNetwork(TF2)!;
(net.hyperparams as any).layerCaps = [4, 4, 4];
fs.writeFileSync(path.join(netDir(TF2), "hyperparams.json"), JSON.stringify(net.hyperparams, null, 2));
for (const [l, n] of [[0, 0], [0, 1], [1, 0], [1, 1]] as const) {
  writeNodeHtml(path.join(netDir(TF2), `layer_${l}`, `node_${n}.html`), l, `node_${n}`, `L${l}节点${n}内容`, [], `L${l}n${n}`);
}
console.log("T3 cap=4>slots=2: append 放行(有真实容量):");
const r3 = liftMergeNodes(net, { layer: 1, nodeId: "node_0" }, { layer: 1, nodeId: "node_1" }, log);
assert(r3.merged === true, "T3a merge 成功", r3);
assert(net.hyperparams.layers[0] === 3, "T3b L0 槽位 append 到 3(<cap=4)", net.hyperparams.layers);
assert(aliveCount(netDir(TF2), 0, net.hyperparams.layers) === 3, "T3c L0 alive=3 ≤ cap");

// ── Case 4: 超容存量网(legacy 9/2): 同层 merge 收缩放行, 跨层撞满 L0 拒绝 ──
const TF3 = "zz-caphard-test3";
fs.rmSync(netDir(TF3), { recursive: true, force: true });
initNetwork(TF3, [9, 2, 2], 0.2, 0.1, log);
net = loadNetwork(TF3)!;
(net.hyperparams as any).layerCaps = [2, 2, 2];
fs.writeFileSync(path.join(netDir(TF3), "hyperparams.json"), JSON.stringify(net.hyperparams, null, 2));
for (let n = 0; n < 9; n++) writeNodeHtml(path.join(netDir(TF3), "layer_0", `node_${n}.html`), 0, `node_${n}`, `legacy节点${n}`, [], `lg${n}`);
console.log("T4 legacy 超容网(L0=9/cap=2):");
const r4a = liftMergeNodes(net, { layer: 0, nodeId: "node_0" }, { layer: 0, nodeId: "node_1" }, log);
assert(r4a.merged === true, "T4a 同层 merge 收缩放行(keepTgt 不走 allocSlot)", r4a);
assert(aliveCount(netDir(TF3), 0, net.hyperparams.layers) === 8, "T4b alive 9→8(收缩方向)");
writeNodeHtml(path.join(netDir(TF3), "layer_1", "node_0.html"), 1, "node_0", "L1节点0内容", [], "L1n0");
writeNodeHtml(path.join(netDir(TF3), "layer_1", "node_1.html"), 1, "node_1", "L1节点1内容", [], "L1n1");
writeNodeHtml(path.join(netDir(TF3), "layer_2", "node_0.html"), 2, "node_0", "L2节点0内容", [], "L2n0");
writeNodeHtml(path.join(netDir(TF3), "layer_2", "node_1.html"), 2, "node_1", "L2节点1内容", [], "L2n1");
// L2+L2→L1: 源与目标都不在结果层 L1 → 走 allocSlot; L1 已满 2/2 → 硬闸拒绝
const r4b = liftMergeNodes(net, { layer: 2, nodeId: "node_0" }, { layer: 2, nodeId: "node_1" }, log);
assert(r4b.merged === false && String(r4b.reason).startsWith("host_alloc_over_cap"), "T4c 跨层宿主落位仍被硬闸拒绝(L2+L2→L1, L1满2/2)", r4b.reason);
assert(aliveCount(netDir(TF3), 1, net.hyperparams.layers) === 2, "T4d L1 alive 恒=2(硬不变量)");

// 清理
for (const tf of [TF, TF2, TF3]) fs.rmSync(netDir(tf), { recursive: true, force: true });
console.log(`\n结果: ${pass} pass / ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
