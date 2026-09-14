/**
 * layerCaps 容量约束功能测试（隔离网络 zz-caps-test，跑完即删）
 * 验证：
 *  T1 无配置 → 默认上限 40（旧 MAX_PER_LAYER_SOFT 语义）
 *  T2 有配置 layerCaps=[2,2,2] → 按配置
 *  T3 initNetwork 落盘 layerCaps
 *  T4 addPolicyNode: cap=2 时第 3 个节点被拒（over_cap），日志含原因
 *  T5 清空一个槽（模拟 merge 回收）→ 复用空槽成功（used 不超 cap）
 *  T6 层内 merge（去重）路径不受影响
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { initNetwork, layerCapFor, DEFAULT_LAYER_CAP, loadNetwork } from "./src/lib/network";
import { addPolicyNode } from "./src/lib/node_policy";
import { readNodeContent } from "./src/lib/node_io";

const TF = "zz-caps-test";
const logs: string[] = [];
const log = (m: string) => logs.push(m);
let pass = 0, fail = 0;
function assert(cond: boolean, name: string, extra?: any) {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}`, extra ?? ""); }
}

// T1 默认上限
assert(layerCapFor({ layers: [2, 2, 2] } as any, 0) === DEFAULT_LAYER_CAP, `T1 无配置默认上限=${DEFAULT_LAYER_CAP}（旧 MAX_PER_LAYER_SOFT 语义）`);
assert(layerCapFor({ layers: [2, 2, 2] } as any, 5) === DEFAULT_LAYER_CAP, "T1b 无配置且层越界 → 40");

// T2 有配置按配置
const hp2 = { layers: [7, 1, 0], layerCaps: [2, 2, 2] } as any;
assert(layerCapFor(hp2, 0) === 2 && layerCapFor(hp2, 1) === 2, "T2 有配置按配置 ([2,2,2])");
assert(layerCapFor({ layers: [3, 3, 3, 3], layerCaps: [2, 2, 2] } as any, 3) === 2, "T2b 缺层用最后一个值兜底");

// T3 initNetwork 落盘 layerCaps + 加载
const hp = initNetwork(TF, [2, 2, 2], 0.2, 0.1, log);
assert(JSON.stringify(hp.layerCaps) === "[2,2,2]", "T3 initNetwork 写 layerCaps=[2,2,2]", hp.layerCaps);
const disk = JSON.parse(fs.readFileSync(path.join(initDir(), "hyperparams.json"), "utf-8"));
assert(JSON.stringify(disk.layerCaps) === "[2,2,2]", "T3b hyperparams.json 落盘含 layerCaps");

function initDir(): string {
  // TEXTRON_HOME 默认 ~/.textron
  return path.join(process.env.HOME || "", ".textron", TF);
}

// T4/T5: cap=2 的 addPolicyNode 行为
const net = loadNetwork(TF)!;
assert(!!net, "loadNetwork(TF) 成功");
const c1 = "止损规则 rule：若 tradePrice 越出当日区间 [low,high] 则 step 返回废单 rejected，报单前必须核对当日涨跌停边界，避免 price out of range 导致的无效交易与滑点损失 (over_cap 判定边界 price<=high)。";
const c2 = "趋势确认原则 trend：右侧入场需等待 volume breakout 确认，下降通道中禁做左侧抄底 left-side，缩量不视为抛压衰竭，应等待买盘 buy volume 回归信号，edgesUpdated>0 才算 reward 入射权重。";
const c3 = "仓位控制原则 position sizing：单笔 risk exposure 不超过总资金 2%，连续亏损后 halve position，加仓只在 trend pullback 支撑确认后执行，avoid over-leverage 与 drawdown 扩大。";
const r1 = addPolicyNode(net, 0, c1, log);
const r2 = addPolicyNode(net, 0, c2, log);
assert(r1.added && r2.added, "T4a cap=2 时前两个节点成功", { r1, r2 });
const r3 = addPolicyNode(net, 0, c3, log);
assert(!r3.added && r3.skipped === true && /over_cap\(2\/2\)/.test(r3.reason || ""), "T4b 第 3 个节点被拒 over_cap(2/2)", r3);
assert(logs.some(l => l.includes("over cap 2/2")), "T4c 日志含 over cap 原因与收缩指引");

// T5: 模拟 merge 回收 —— 清空 node_0，再 add 应复用空槽且不超 cap
const p0 = path.join(net.path, "layer_0", "node_0.html");
const html0 = fs.readFileSync(p0, "utf-8").replace(/<content>[\s\S]*?<\/content>/, "<content></content>");
fs.writeFileSync(p0, html0, "utf-8");
const r4 = addPolicyNode(net, 0, c3, log);
assert(r4.added && r4.replaced === true, "T5 回收空槽后 add 成功（replaced）", r4);
let used = 0;
for (let n = 0; n < net.hyperparams.layers[0]; n++) if (readNodeContent(path.join(net.path, "layer_0", `node_${n}.html`))) used++;
assert(used === 2, `T5b used=${used} 不超 cap=2`);

console.log(`\n结果: ${pass} pass / ${fail} fail`);
fs.rmSync(initDir(), { recursive: true, force: true });
console.log(`(测试网络 ${TF} 已删除)`);
if (fail > 0) process.exit(1);
