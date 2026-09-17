declare const process: { exit(code?: number): never };

// n8 第十九轮 R9 回归套件：悬空 [fn:σ] 口径的**采集源**缺陷
// 缺陷：函数块落盘在 </content> 之外（node_io.writeNodeHtml / writeNodeFunction），
//       而 scanDanglingFnRefs 只从 content 收集 alive ⇒ symbolsAlive 恒 0 ⇒ 全部引用判悬空。
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanDanglingFnRefs } from "./lib/similarity.ts";
import { writeNodeHtml, writeNodeFunction, readNodeContent, readNodeFunctions } from "./lib/node_io.ts";

let passed = 0;
let failed = 0;
function ok(name: string, condition: boolean, detail = "") {
  if (condition) { passed++; console.log(`  OK ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
}

console.log("T1 旧口径缺陷复现：只喂 content ⇒ 存活符号恒 0（改进必要性的证据）");
const nodesContentOnly = [
  { id: "L0::node_0", content: "策略：破位止损 [fn:pi_star_gate_trade] 与 [fn:decide_upper_shadow_fade]" },
  { id: "L0::node_1", content: "量能过滤 [fn:pi_star_gate_trade]" },
];
const sOld = scanDanglingFnRefs(nodesContentOnly);
ok("symbolsAlive=0（即便块真实存在）", sOld.symbolsAlive === 0, String(sOld.symbolsAlive));
ok("全部引用被判悬空 pairs=3（节点×符号：node_0 两符号 + node_1 一符号）", sOld.danglingPairs === 3, String(sOld.danglingPairs));
ok("refs 计数 3", sOld.danglingRefs === 3 && sOld.refsTotal === 3, JSON.stringify(sOld));

console.log("T2 修法生效：补 fnSymbols 后存活符号被识别、悬空归零");
const nodesWithFns = nodesContentOnly.map((n) => ({ ...n, fnSymbols: ["pi_star_gate_trade"] }));
const sNew = scanDanglingFnRefs(nodesWithFns);
ok("symbolsAlive=1", sNew.symbolsAlive === 1, String(sNew.symbolsAlive));
ok("fnBlocksOnDisk=2", sNew.fnBlocksOnDisk === 2, String(sNew.fnBlocksOnDisk));
ok("只剩真悬空 1 对（decide_upper_shadow_fade）", sNew.danglingPairs === 1, JSON.stringify(sNew.perNode));
ok("danglingSymbols 精确", JSON.stringify(sNew.danglingSymbols) === JSON.stringify(["decide_upper_shadow_fade"]), JSON.stringify(sNew.danglingSymbols));

console.log("T3 混合来源：content 内联块 + 磁盘块都算存活（互不排斥）");
const sMix = scanDanglingFnRefs([
  { id: "L0::node_0", content: `<function symbol="inline_sym">x</function> ref [fn:inline_sym] [fn:disk_sym]`, fnSymbols: ["disk_sym"] },
]);
ok("symbolsAlive=2", sMix.symbolsAlive === 2, String(sMix.symbolsAlive));
ok("danglingPairs=0", sMix.danglingPairs === 0, JSON.stringify(sMix));

console.log("T4 端到端复刻真实磁盘形状：writeNodeHtml 把块写在 </content> 之外 ⇒ 必须靠 readNodeFunctions 补源");
const dir = mkdtempSync(join(tmpdir(), "fn-scan-"));
try {
  const fp = join(dir, "node_0.html");
  writeNodeHtml(fp, 0, "node_0", "正文引用 [fn:pi_star_gate_trade] 与 [fn:ghost_sym]", []);
  writeNodeFunction(fp, "pi_star_gate_trade", "def f():\n    return 1\n");
  const raw = readFileSync(fp, "utf-8");
  ok("函数块在 </content> 之后", raw.indexOf("</content>") < raw.indexOf("<function symbol="));
  ok("readNodeContent 不含函数块（缺陷根源）", !readNodeContent(fp).includes("<function"));
  ok("readNodeFunctions 能读到块", JSON.stringify(readNodeFunctions(fp).map((b) => b.symbol)) === JSON.stringify(["pi_star_gate_trade"]));
  const diskScan = scanDanglingFnRefs([{ id: "L0::node_0", content: readNodeContent(fp), fnSymbols: readNodeFunctions(fp).map((b) => b.symbol) }]);
  ok("端到端：alive=1 / pairs=1 / fnBlocksOnDisk=1", diskScan.symbolsAlive === 1 && diskScan.danglingPairs === 1 && diskScan.fnBlocksOnDisk === 1, JSON.stringify(diskScan));
} finally { rmSync(dir, { recursive: true, force: true }); }

console.log("T5 源码守卫：采集源已接入、事件字段可观测、向后兼容（不传 fnSymbols 不炸）");
const src = readFileSync("src/index.ts", "utf-8");
ok("调用点带 fnSymbols", src.includes("fnSymbols: readNodeFunctions(fp).map((b) => b.symbol)"));
ok("事件带 fnBlocksOnDisk", src.includes("fnBlocksOnDisk: _scan.fnBlocksOnDisk"));
ok("index 已导入 readNodeFunctions", src.includes("readNodeFunctions"));
ok("缺字段安全（undefined fnSymbols）", scanDanglingFnRefs([{ id: "a", content: "[fn:x]" } as any]).danglingPairs === 1);
ok("空输入安全", scanDanglingFnRefs([]).fnBlocksOnDisk === 0);

console.log(`\npassed=${passed} failed=${failed}`);
if (failed > 0) process.exit(1);
