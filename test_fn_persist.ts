// 验证 <Function> 硬落盘通路（readNodeFunction/writeNodeFunction/writeNodeHtml 保留/compile 注入）
import * as fs from "node:fs";
import * as path from "node:path";
import { writeNodeHtml, readNodeFunction, writeNodeFunction, readNodeContent } from "./src/lib/node_io.ts";
import { compileContext } from "./src/lib/compile.ts";

const root = "/tmp/textron-fn-test-" + Date.now();
const netPath = path.join(root, "layer_0");
fs.mkdirSync(netPath, { recursive: true });
const fp = path.join(netPath, "node_0.html");

let pass = 0, fail = 0;
function ok(name: string, cond: boolean, extra = "") { if (cond) { pass++; console.log("PASS", name); } else { fail++; console.log("FAIL", name, extra); } }

// T1: 写入 function 块并读回
writeNodeHtml(fp, 0, "node_0", "自然语言知识：趋势破位先减仓，保本位 price>=cost*0.995", [], "趋势破位减仓");
writeNodeFunction(fp, "trend_break_trim", "def trend_break_trim(price, cost, ret_from_peak):\n    return ret_from_peak <= -0.25 and price >= cost * 0.995");
const fn1 = readNodeFunction(fp);
ok("T1a symbol 读回", fn1?.symbol === "trend_break_trim", JSON.stringify(fn1));
ok("T1b code 读回", !!fn1?.code.includes("ret_from_peak <= -0.25"));

// T2: writeNodeHtml 重写 content 后 function 保留（不被清空）
writeNodeHtml(fp, 0, "node_0", "更新后的自然语言知识：减仓前必先定保留手数", [], "减仓保留手数");
ok("T2a content 已更新", readNodeContent(fp).includes("保留手数"));
ok("T2b function 未被覆盖丢失", readNodeFunction(fp)?.symbol === "trend_break_trim");

// T3: 重复写入不产生重复块
writeNodeFunction(fp, "trend_break_trim", "def trend_break_trim(price, cost, ret_from_peak):\n    return ret_from_peak <= -0.25");
const html = fs.readFileSync(fp, "utf-8");
ok("T3a 只有一个 function 块", (html.match(/<function/g) || []).length === 1, html.match(/<function/g)?.length + "");
ok("T3b code 已替换", !readNodeFunction(fp)!.code.includes("cost * 0.995"));

// T4: compileContext 前向注入带 fn symbol；content 追加 [fn:...] 引用链字面
writeNodeFunction(fp, "trend_break_trim", "def trend_break_trim(): pass");
const net = { hyperparams: { layers: [1] }, path: root, weights: { layer_connections: {} } };
const ctx = compileContext(net as any, [{ id: "L0::node_0", layer: 0, content: readNodeContent(fp), activation: 1 }] as any);
ok("T4a 注入含 fn symbol", ctx.includes("⟨fn:trend_break_trim⟩"), ctx.slice(0, 200));
ok("T4b 注入含节点原文", ctx.includes("保留手数"));

// T5: functionSymbol 字面兜底追加（模拟 persistHighEntropyFunction 的 content 追加路径）
const before = readNodeContent(fp);
const suffix = " [fn:trend_break_trim]";
writeNodeHtml(fp, 0, "node_0", before.slice(0, 1000 - suffix.length) + suffix, [], "减仓保留手数");
ok("T5a content 含 fn 字面", readNodeContent(fp).includes("[fn:trend_break_trim]"));
ok("T5b content ≤1000", readNodeContent(fp).length <= 1000);
ok("T5c function 仍保留", readNodeFunction(fp)?.symbol === "trend_break_trim");

console.log(`\n${pass}/${pass + fail} PASS`);
fs.rmSync(root, { recursive: true, force: true });
if (fail) process.exit(1);
