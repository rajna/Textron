/**
 * function 块「多块搬运 + 上限淘汰可观测」回归（隔离网络 zz-fnmulti-test，跑完即删）
 * 2026-09-15 n8 第十四轮 guard 实证：
 *   ① 搬运只搬首块：`node_policy.compactMergeEmptiedNodes` 用 `readNodeFunction`(**单数**) ——
 *      多块源（本轮 L0::node_1 = verify_agent_state_isolation + resistance_reject_exposure_trim）
 *      移位后只有首块到达 DEST，其余块静默蒸发；
 *   ② 上限淘汰静默：`writeNodeFunction` 超 NODE_FN_BLOCK_MAX=2 时按 code 长度淘汰最短者，**无任何日志/事件**
 *      ⇒ 本轮 6 次 `highentropy_function_persisted` 仅 3 块存活
 *      （蒸发：guard_dispatch_constraint_passthrough / resistance_reject_exposure_trim /
 *        relay_agent_message_with_idempotency），而 content 仍挂 `[fn:σ]`= 悬空引用。
 *
 * 判据：
 *   T1 端到端：源槽 2 块 → compact 移位 → DEST 持 **2 块**（旧实现仅 1 块）
 *   T2 onEvicted 回调在超上限时触发且报出被淘汰 symbol；未超限不触发
 *   T3 同 symbol 覆盖不触发淘汰（版本内更新非淘汰）
 *   T4 源码静态断言：搬运走 readNodeFunctions（复数）；落盘处接 onEvicted；事件名 fn_block_evicted 存在
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { initNetwork, loadNetwork } from "./src/lib/network";
import { writeNodeHtml, readNodeContent, readNodeFunctions, writeNodeFunction } from "./src/lib/node_io";
import { compactMergeEmptiedNodes } from "./src/lib/node_policy";

const HOME = process.env.TEXTRON_HOME_FNMULTI || "/tmp/textron-fnmulti-test";
const logs: string[] = [];
const log = (m: string) => logs.push(m);
let pass = 0, fail = 0;
const assert = (cond: boolean, name: string, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}`, extra ?? ""); }
};
const np = (netPath: string, l: number, id: string) => path.join(netPath, `layer_${l}`, `${id}.html`);
const CONTENT = (tag: string) => `机制${tag}: 遇阻减仓与赔率分母(风险=r, b=(目标位−现价)/r)耦合推理链，含 Kelly 与风险预算反推。`.repeat(3);
const CODE = (sym: string, pad = 0) =>
  `def ${sym}(closes, vols, price, stop):\n    # ${sym}  ${"x".repeat(pad)}\n    return {"stop": stop, "edge": (price - stop)}\n`;

function seed(tf: string, layers: number[]) {
  fs.rmSync(path.join(HOME, tf), { recursive: true, force: true });
  initNetwork(tf, layers, 0.2, 0.1, log);
  return loadNetwork(tf)!;
}

// ── T1 端到端：多块源 compact 移位必须全部携带 ──
console.log("T1 端到端：源槽 2 块 → compact 移位 → DEST 持 2 块");
const net = seed("zz-fnmulti-shift", [2, 2]);
writeNodeHtml(np(net.path, 0, "node_0"), 0, "node_0", "", [], "");
writeNodeHtml(np(net.path, 0, "node_1"), 0, "node_1", CONTENT("shift"), [], "shift");
writeNodeFunction(np(net.path, 0, "node_1"), "verify_agent_state_isolation", CODE("verify_agent_state_isolation"));
writeNodeFunction(np(net.path, 0, "node_1"), "resistance_reject_exposure_trim", CODE("resistance_reject_exposure_trim", 40));
assert(readNodeFunctions(np(net.path, 0, "node_1")).length === 2, "源槽确有 2 块（前置条件）", readNodeFunctions(np(net.path, 0, "node_1")).map((b) => b.symbol));
const compacted = compactMergeEmptiedNodes(net, log);
assert(compacted >= 1, "确有移位发生", compacted);
const movedFns = readNodeFunctions(np(net.path, 0, "node_0")).map((b) => b.symbol).sort();
assert(movedFns.length === 2, "DEST 持有全部 2 块（旧实现仅 1 块）", movedFns);
assert(movedFns.includes("verify_agent_state_isolation") && movedFns.includes("resistance_reject_exposure_trim"), "两块 symbol 均到达 DEST", movedFns);

// ── T2 上限淘汰可观测 ──
console.log("T2 上限淘汰 onEvicted 回调");
const p2 = np(net.path, 0, "node_0");
const evicted: string[][] = [];
writeNodeFunction(p2, "third_block", CODE("third_block", 200), { onEvicted: (e) => evicted.push(e) });
assert(evicted.length === 1, "写第 3 块触发一次淘汰回调", evicted);
assert(evicted[0]?.length === 1, "淘汰 1 个 symbol（最短者）", evicted[0]);
assert(readNodeFunctions(p2).length === 2, "上限仍为 2 块", readNodeFunctions(p2).length);
const noEvict: string[][] = [];
writeNodeFunction(p2, "third_block", CODE("third_block_v2"), { onEvicted: (e) => noEvict.push(e) });
assert(noEvict.length === 0, "同 symbol 覆盖不触发淘汰（版本内更新）", noEvict);

// ── T3 极端：源 2 块 + DEST 已有 2 块 → 淘汰必须被回调报出（不得静默） ──
console.log("T3 搬运入满容 DEST 时淘汰必须可见");
const net3 = seed("zz-fnmulti-full", [2, 2]);
// DEST 为空壳（无 content）但已持满 2 块 —— 空壳仍会被 compact 视作"空"并接受移位，
// 正是「满容 DEST 接收多块源」的真实形态（本轮 L0::node_0 就是这个状态）。
writeNodeHtml(np(net3.path, 0, "node_0"), 0, "node_0", "", [], "dst");
writeNodeFunction(np(net3.path, 0, "node_0"), "host_a", CODE("host_a", 500));
writeNodeFunction(np(net3.path, 0, "node_0"), "host_b", CODE("host_b", 500));
writeNodeHtml(np(net3.path, 0, "node_1"), 0, "node_1", CONTENT("src"), [], "src");
writeNodeFunction(np(net3.path, 0, "node_1"), "src_x", CODE("src_x"));
writeNodeFunction(np(net3.path, 0, "node_1"), "src_y", CODE("src_y", 10));
assert(readNodeFunctions(np(net3.path, 0, "node_1")).length === 2, "源 2 块就绪（前置）", readNodeFunctions(np(net3.path, 0, "node_1")).map((b) => b.symbol));
const logs3: string[] = [];
const net3b = { ...net3, weights: net3.weights };
compactMergeEmptiedNodes({ ...net3b, hyperparams: { ...net3.hyperparams }, path: net3.path } as any, (m) => logs3.push(m));
const evLog = logs3.filter((m) => m.includes("fn block evicted on move"));
assert(evLog.length >= 1, "搬运时淘汰走 onLog 显式记录（非静默）", logs3.slice(-3));
assert(readNodeFunctions(np(net3.path, 0, "node_0")).length === 2, "DEST 仍守 2 块上限", readNodeFunctions(np(net3.path, 0, "node_0")).map((b) => b.symbol));

// ── T4 源码静态断言 ──
console.log("T4 源码静态断言");
const policySrc = fs.readFileSync(new URL("./src/lib/node_policy.ts", import.meta.url), "utf8");
const idxSrc = fs.readFileSync(new URL("./src/index.ts", import.meta.url), "utf8");
assert(policySrc.includes("const srcFns = readNodeFunctions(src);"), "搬运改用 readNodeFunctions（复数）", "");
assert(!/const srcFn = readNodeFunction\(src\);/.test(policySrc), "旧单块搬运已移除", "");
assert(/onEvicted:\s*\(ev\)\s*=>/.test(policySrc), "搬运处接 onEvicted 回调", "");
assert(idxSrc.includes('action: "fn_block_evicted"'), "落盘处记 fn_block_evicted 事件", "");
assert(idxSrc.includes("evicted.filter((s) => content.includes(`[fn:${s}]`))"), "淘汰时同时判定内容悬空引用", "");

console.log(`\n${fail === 0 ? "✅ ALL PASS" : "❌ FAILED"}  pass=${pass} fail=${fail}`);
fs.rmSync(path.join(HOME, "zz-fnmulti-shift"), { recursive: true, force: true });
fs.rmSync(path.join(HOME, "zz-fnmulti-full"), { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
