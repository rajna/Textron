/**
 * function 块「稳态存活」回归（隔离网络 zz-fnsurv-test，跑完即删）
 * 2026-09-14 n8 第四轮 guard 实证三处缺陷，本测试覆盖其中可离线判定的两类：
 *   N8 块不随 content 移位: compactMergeEmptiedNodes 用 writeNodeHtml(dst,...) 只保留 DEST 自己的块，
 *      源文件随后 unlink ⇒ 一次 compact/merge 蒸发一批函数产物(实测 4 真块 → 只剩 1 个历史垃圾块)。
 *   N6 污染块永久保留: symbol="" 的 `([\s\S]*?)` 正则字面垃圾块 + LLM 写进 content 的
 *      `<function symbol="σ">` 审计字面 —— readNodeFunction 认作"有块"会被 writeNodeHtml 一路带下去，
 *      compile 还会注入 ⟨fn:σ⟩ 污染前向上下文。
 * 验证:
 *   T1 readNodeFunction 拒绝 symbol="" / symbol="σ" / 无 symbol 的块，接受合法 ASCII 标识符
 *   T2 writeNodeHtml 保留合法块（回归上轮修复，不得被 sanitize 误伤）
 *   T3 compactMergeEmptiedNodes 移位后 DEST 仍持有同一 symbol 的块（块随 content 走）
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { initNetwork, loadNetwork } from "./src/lib/network";
import { writeNodeHtml, readNodeContent, readNodeFunction, writeNodeFunction } from "./src/lib/node_io";
import { compactMergeEmptiedNodes } from "./src/lib/node_policy";

const HOME = process.env.TEXTRON_HOME_FNSURV || "/tmp/textron-fnsurv-test";
const logs: string[] = [];
const log = (m: string) => logs.push(m);
let pass = 0, fail = 0;
function assert(cond: boolean, name: string, extra?: any) {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}`, extra ?? ""); }
}
const np = (netPath: string, l: number, id: string) => path.join(netPath, `layer_${l}`, `${id}.html`);
const CONTENT = (tag: string) => `机制${tag}: K线三正交信号(box_geometry/ma_stack/vol_ratio)与风控预算耦合推理链。`.repeat(3);
const CODE = "def sell_reentry_pair(closes, vols, price, stop, reentry_vr=1.2):\n    return {'stop': stop, 'reentry': f'vr>{reentry_vr} and close>=MA5'}\n";

function seed(tf: string, layers: number[]) {
  fs.rmSync(path.join(HOME, tf), { recursive: true, force: true });
  initNetwork(tf, layers, 0.2, 0.1, log);
  return loadNetwork(tf)!;
}

// ── T1 污染块 sanitize ──
console.log("T1 readNodeFunction 只认合法 symbol 的块");
const TF1 = "zz-fnsurv-read";
const n1 = seed(TF1, [2, 2]);
const p1 = np(n1.path, 0, "node_0");
writeNodeHtml(p1, 0, "node_0", CONTENT("read"), [], "read");
const garbage = [
  "\n<function symbol=\"\">\n([\\s\\S]*?)\n</function>\n",
  "\n<function symbol=\"σ\">\nfunctionSymbol：σ\nfunctionAbstract：def f(x): return x\n</function>\n",
  "\n<function>\nno symbol body\n</function>\n",
];
for (const g of garbage) {
  fs.appendFileSync(p1, g, "utf-8");
  assert(readNodeFunction(p1) === null, `拒绝脏块 ${JSON.stringify(g.slice(0, 34))}`);
  fs.writeFileSync(p1, fs.readFileSync(p1, "utf-8").replace(g, ""), "utf-8");
}
writeNodeFunction(p1, "sell_reentry_pair", CODE);
const okFn = readNodeFunction(p1);
assert(okFn?.symbol === "sell_reentry_pair", "接受合法标识符块", okFn);

// ── T2 writeNodeHtml 保留合法块 ──
console.log("T2 writeNodeHtml 保留既有合法块");
writeNodeHtml(p1, 0, "node_0", CONTENT("rewrite"), [], "rewrite");
assert(readNodeFunction(p1)?.symbol === "sell_reentry_pair", "重写 content 后块仍在");

// ── T3 移位携带 function 块 ──
console.log("T3 空壳压缩移位携带 function 块");
const TF3 = "zz-fnsurv-shift";
const net = seed(TF3, [2, 2]);
// node_0 留空壳, node_1 放内容 + 合法块
writeNodeHtml(np(net.path, 0, "node_0"), 0, "node_0", "", [], "");
writeNodeHtml(np(net.path, 0, "node_1"), 0, "node_1", CONTENT("shift"), [], "shift");
writeNodeFunction(np(net.path, 0, "node_1"), "sell_reentry_pair", CODE);
const compacted = compactMergeEmptiedNodes(net, log);
assert(compacted >= 1, "确有移位发生", compacted);
assert(!!readNodeContent(np(net.path, 0, "node_0"))?.trim(), "内容已落到 node_0");
const moved = readNodeFunction(np(net.path, 0, "node_0"));
assert(moved?.symbol === "sell_reentry_pair", "块随内容一起落到 node_0", moved?.symbol);
assert(readNodeFunction(np(net.path, 0, "node_1")) === null, "源槽位未残留幽灵块");

console.log(`\n${fail === 0 ? "✅ ALL PASS" : "❌ FAILED"}  pass=${pass} fail=${fail}`);
fs.rmSync(path.join(HOME, TF1), { recursive: true, force: true });
fs.rmSync(path.join(HOME, TF3), { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
