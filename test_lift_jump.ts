/**
 * 跨层「向上提升」merge 测试（隔离网络 zz-liftjump-test，跑完即删）
 * 需求(2026-09-14 n8 第三轮 guard 实证): 反传时 LLM 反复提出 L3→L0 / L2→L0 的抽象提升 merge，
 * 原解析层用 |Δlayer|>1 一刀切丢弃(merge_action_dropped:layer_jump) → nodesMerged 恒 0、
 * 下层结论困在从不前向注入的 L3 = 死知识。修复=层向闸 mergeLayerAllowed()：只拒「向下跳层」，
 * 放行任意级向上提升（机制由 liftMergeNodes 的宿主定层/ledger 重锚/物化重建承担）。
 * 验证:
 *  T1 层向真值表: (3,0)(2,0)(1,0)(0,0)(0,1) 放行; (0,2)(0,3)(1,3) 拒绝
 *  T2 端到端 3 级提升 merge: L3::node_0 → L0::node_0 → merged=true, hostLayer=0, 源被清空, L0 内容含双方知识
 *  T3 容量硬闸仍在: L0 满容(cap=2, alive=2)且宿主非参与者时 host_alloc_over_cap 拒绝, 不产生超容
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { initNetwork, loadNetwork } from "./src/lib/network";
import { liftMergeNodes, mergeLayerAllowed } from "./src/lib/lift_merge";
import { writeNodeHtml, readNodeContent } from "./src/lib/node_io";

const HOME = process.env.TEXTRON_HOME_JUMP || "/tmp/textron-liftjump-test";
const logs: string[] = [];
const log = (m: string) => logs.push(m);
let pass = 0, fail = 0;
function assert(cond: boolean, name: string, extra?: any) {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}`, extra ?? ""); }
}
const np = (netPath: string, l: number, id: string) => path.join(netPath, `layer_${l}`, `${id}.html`);
const content = (tag: string) => `机制${tag}: K线三正交信号(box_geometry/ma_stack/vol_ratio)与风控预算耦合推理链。`.repeat(4);

function seed(tf: string, layers: number[]) {
  const dir = path.join(HOME, tf);
  fs.rmSync(dir, { recursive: true, force: true });
  initNetwork(tf, layers, 0.2, 0.1, log);
  return loadNetwork(tf)!;
}

// ── T1 层向真值表 ──
console.log("T1 层向闸 mergeLayerAllowed");
for (const [s, t] of [[3, 0], [2, 0], [1, 0], [0, 0], [0, 1], [2, 1]] as const) assert(mergeLayerAllowed(s, t), `放行 ${s}→${t}`);
for (const [s, t] of [[0, 2], [0, 3], [1, 3]] as const) assert(!mergeLayerAllowed(s, t), `拒绝向下跳层 ${s}→${t}`);

// ── T2 端到端 3 级提升 ──
console.log("T2 L3→L0 三级提升 merge");
const TF2 = "zz-liftjump-test";
const net = seed(TF2, [2, 2, 2, 2]);
writeNodeHtml(np(net.path, 0, "node_0"), 0, "node_0", content("L0抽象锚点"), [], "L0抽象锚点");
writeNodeHtml(np(net.path, 3, "node_0"), 3, "node_0", content("L3具体经验"), [], "L3具体经验");
const r = liftMergeNodes(net, { layer: 3, nodeId: "node_0" }, { layer: 0, nodeId: "node_0" }, log);
assert(r.merged === true, "merged=true", r);
assert(r.hostLayer === 0, "宿主落在最抽象层 L0", r);
assert(!!readNodeContent(np(net.path, 0, "node_0"))?.trim(), "宿主 L0 内容非空");
assert(!readNodeContent(np(net.path, 3, "node_0"))?.trim(), "源 L3 被清空(知识已提升)");
const host = readNodeContent(np(net.path, 0, "node_0")) || "";
assert(host.includes("L3具体经验") || host.includes("具体经验"), "宿主内容已吸收源知识", host.slice(0, 80));
const alive = (l: number) => { let c = 0; for (let n = 0; n < net.hyperparams.layers[l]; n++) if (readNodeContent(np(net.path, l, `node_${n}`))) c++; return c; };
assert(alive(0) <= 2, "L0 未超容", alive(0));

// ── T3 容量硬闸 ──
console.log("T3 容量硬闸(宿主非参与者且 L0 满容)");
const TF3 = "zz-liftjump-cap";
const net3 = seed(TF3, [2, 2, 2, 2]);
for (const i of [0, 1]) writeNodeHtml(np(net3.path, 0, `node_${i}`), 0, `node_${i}`, content(`L0-${i}`), [], `L0-${i}`);
writeNodeHtml(np(net3.path, 1, "node_1"), 1, "node_1", content("L1源"), [], "L1源");
writeNodeHtml(np(net3.path, 3, "node_1"), 3, "node_1", content("L3源"), [], "L3源");
// 提升到不存在的 L0 槽位 node_1 的三级合并: 宿主层 L0 无空壳且存活 2/2 → 硬闸拒绝
const r3 = liftMergeNodes(net3, { layer: 3, nodeId: "node_1" }, { layer: 0, nodeId: "_" }, log);
assert(r3.merged === false, "满容 L0 不接受提升宿主落位", r3);
assert(String(r3.reason || "").length > 0, "拒绝必须带 reason(不静默)", r3.reason);
const alive0 = (() => { let c = 0; for (let n = 0; n < net3.hyperparams.layers[0]; n++) if (readNodeContent(np(net3.path, 0, `node_${n}`))) c++; return c; })();
assert(alive0 <= 2, "硬闸下 L0 不超容", alive0);

console.log(`\n${fail === 0 ? "✅ ALL PASS" : "❌ FAILED"}  pass=${pass} fail=${fail}`);
fs.rmSync(path.join(HOME, TF2), { recursive: true, force: true });
fs.rmSync(path.join(HOME, TF3), { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
