// 回归门禁：<Function> 落盘「调用链」静态断言（零依赖，node 直接跑）
// 背景（n8 验证轮 guard 实证）：ab13780 的 persistHighEntropyFunction 被 forcedSemanticBackward
// 直接以局部变量 functionBlock 调用 → ReferenceError: functionBlock is not defined → 反传整轮
// status=failed、Function 从未落盘。test_fn_persist.ts 只复刻逻辑、不覆盖调用链 → 11/11 假绿。
// 本脚本断言真实源码文本里的调用链形状，任何一项破裂即 FAIL。
import * as fs from "node:fs";
import * as path from "node:path";

const root = path.dirname(new URL(import.meta.url).pathname);
const idx = fs.readFileSync(path.join(root, "src/index.ts"), "utf8");
const compile = fs.readFileSync(path.join(root, "src/lib/compile.ts"), "utf8");

let pass = 0, fail = 0;
function ok(name: string, cond: boolean, extra = "") { if (cond) { pass++; console.log("PASS", name); } else { fail++; console.log("FAIL", name, extra); } }

/** 抓取顶层 `  function name(` 到下一个同级 `  }` 的函数体（缩进 2 的声明） */
function bodyOf(name: string): string {
  const start = idx.indexOf(`\n  function ${name}(`);
  const alt = idx.indexOf(`\n  async function ${name}(`);
  const s = start >= 0 ? start : alt;
  if (s < 0) return "";
  const end = idx.indexOf("\n  }\n", s);
  return end < 0 ? idx.slice(s) : idx.slice(s, end);
}

const forced = bodyOf("forcedSemanticBackward");
const extract = bodyOf("extractFunctionBlock");
const persist = bodyOf("persistHighEntropyFunction");

ok("C1 extractFunctionBlock 存在且为同层函数", extract.includes("<Function>") && extract.includes("slice(0, 1500)"));
ok("C2 forcedSemanticBackward 内无裸 functionBlock 引用", !/\bfunctionBlock\b/.test(forced.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "")));
ok("C3 persist 调用点使用 extractFunctionBlock(previousAssistantHighEntropy)", /persistHighEntropyFunction\(\s*net,\s*extractFunctionBlock\(\s*previousAssistantHighEntropy\s*\)/.test(forced));
ok("C4 persist 调用点被 try/catch 隔离（插桩不得击穿反传主链）", /try\s*\{[\s\S]{0,200}persistHighEntropyFunction[\s\S]{0,200}\}\s*catch/.test(forced));
ok("C5 symbol 解析失败早退（禁写无 symbol 块）", /if\s*\(!symbol\)\s*\{[\s\S]{0,220}symbol_parse_failed[\s\S]{0,80}return undefined;/.test(persist));
ok("C6 content 追加 [fn:σ] 兜底存在", persist.includes("[fn:${symbol}]"));
ok("C7 writeNodeFunction 独立落盘（不受 content 上限挤压）", persist.includes("writeNodeFunction(fp, symbol, code)"));
ok("C8 compile 注入行含 ⟨fn:symbol⟩", /⟨fn:\$\{fn\.symbol\}⟩/.test(compile));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
