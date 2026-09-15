// 回归门禁：merge 「溢出伴随节点」判据 —— 单变量真因（零依赖，jiti 直接跑）
// 背景（n8 第十三轮 guard 实证）：lift_merge 内联判据 `mergedRaw.length > NODE_CONTENT_MAX_CHARS`
// 在 NODE_CONTENT_MAX_CHARS=0（写入不限制语义）时退化为 `length > 0` ⇒ 「非空即溢出」
// ⇒ 每次 merge 都把宿主内容全量复制一份到伴随节点（实测 L0::node_0 与 L0::node_1 正文逐字相同，
// 同层 Jaccard=1.0、前向注入重复、L0 满容后 add 一律 over_cap）。
// 修复：判据收敛到 overflowContent()（无上限⇒无溢出；有上限⇒只返回超出部分）+ 同文防御不变式。
import * as fs from "node:fs";
import * as path from "node:path";
import { readNodeContent, writeNodeHtml } from "./src/lib/node_io";
import { liftMergeNodes, overflowContent } from "./src/lib/lift_merge";
import { materialize } from "./src/lib/topology";
import { tokenize, createNodeState, updateCounts } from "./src/ngram_distill";
import { NODE_CONTENT_MAX_CHARS } from "./src/content_limits.ts";

const ROOT = "/tmp/lt_overflow_dup";
let pass = 0, fail = 0;
function ok(name: string, cond: boolean, extra = "") { if (cond) { pass++; console.log("PASS", name); } else { fail++; console.log("FAIL", name, extra); } }

const A = "破位缩量反抽判定：反抽量能逐日递减且不收复缺口下沿(54.95)⇒ 弱修复非反转，只允许≤30%试错仓，止损锚反抽起点低点51.75。";
const B = "缺口下沿受阻降权重：同一阻力位连续冲高不过且量能单向递减 ⇒ 分档下调仓位（首触≤25%/两次≈15%/破起点清零）。";

function putNode(layer: number, id: string, c: string) {
  fs.mkdirSync(path.join(ROOT, `layer_${layer}`), { recursive: true });
  writeNodeHtml(path.join(ROOT, `layer_${layer}`, `${id}.html`), layer, id, c, [], c.slice(0, 24));
  const st = createNodeState(); for (const t of tokenize(c)) updateCounts(st, t);
  fs.writeFileSync(path.join(ROOT, `layer_${layer}`, `${id}.ngram.json`), JSON.stringify(st));
}
function buildNet(layers: number[]) {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(ROOT, { recursive: true });
  fs.writeFileSync(path.join(ROOT, "hyperparams.json"), JSON.stringify({ layers, layerCaps: layers }, null, 2));
  fs.writeFileSync(path.join(ROOT, "weights.json"), JSON.stringify({ layer_connections: {}, ledger: {} }, null, 2));
  putNode(0, "node_0", A);
  putNode(0, "node_1", B);
  return {
    path: ROOT,
    hyperparams: { layers: [...layers], layerCaps: [...layers] } as any,
    weights: JSON.parse(fs.readFileSync(path.join(ROOT, "weights.json"), "utf-8")),
  };
}

// ── A. 纯函数真值表：overflowContent 的两种模式（单一事实来源） ──
console.log("== A. overflowContent 判据真值表 ==");
const sample = "X".repeat(500);
ok("A1 limit=0（不限制）⇒ 无溢出", overflowContent(sample, 0) === "");
ok("A2 limit<0 ⇒ 无溢出", overflowContent(sample, -1) === "");
ok("A3 内容未超限 ⇒ 无溢出", overflowContent("abc", 100) === "");
ok("A4 内容超限 ⇒ 只返回超出部分", overflowContent(sample, 100).length > 0 && overflowContent(sample, 100).length <= 400);
// 对照：旧判据在 limit=0 时恒判定「溢出」——本断言记录 bug 存在性，防止未来回退
const legacyWouldOverflow = sample.length > 0;   // 旧表达式 `mergedRaw.length > NODE_CONTENT_MAX_CHARS` 在 limit=0 的求值
ok("A5 旧判据在 limit=0 下误判为溢出（对照，修复对象）", legacyWouldOverflow === true);
ok("A6 生产常量确为「不限制」语义", NODE_CONTENT_MAX_CHARS === 0, String(NODE_CONTENT_MAX_CHARS));

// ── B. 端到端：同层 merge 不得产生「宿主副本节点」 ──
console.log("== B. 同层 merge 端到端（NODE_CONTENT_MAX_CHARS=0）==");
const net = buildNet([2, 2]);
materialize(net as any);
const outcome = liftMergeNodes(net as any, { layer: 0, nodeId: "node_1" }, { layer: 0, nodeId: "node_0" }, () => {});
ok("B1 merge 成功", outcome.merged === true, JSON.stringify(outcome));
ok("B2 无溢出伴随节点（overflowNodeId=null）", outcome.overflowNodeId === null, String(outcome.overflowNodeId));
ok("B3 宿主 = L0::node_0 且吸收了源", outcome.hostLayer === 0 && outcome.hostId === "node_0", JSON.stringify({ h: outcome.hostId }));
const hostContent = readNodeContent(path.join(ROOT, "layer_0", "node_0.html"));
ok("B4 宿主内容含双方知识", hostContent.includes("弱修复非反转") && hostContent.includes("分档下调仓位"));
ok("B5 被吸收源已清空", readNodeContent(path.join(ROOT, "layer_0", "node_1.html")) === "");
const others = ["node_1"].map((id) => readNodeContent(path.join(ROOT, "layer_0", `${id}.html`))).filter((c) => c.trim());
ok("B6 同层不存在与宿主同文的副本（双胞胎断言）", others.every((c) => c.trim() !== hostContent.trim()), JSON.stringify(others.map((c) => c.length)));

// ── C. 静态断言：判据必须走单一事实来源，且不得回退为内联 length 比较 ──
console.log("== C. 源码静态断言 ==");
const src = fs.readFileSync(path.join(process.cwd(), "src/lib/lift_merge.ts"), "utf8");
// 仅看代码行（剔除以 // 或 * 开头的注释行）——注释里会引用旧判据作为「真因」说明
const codeLines = src.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
ok("C1 merge 内使用 overflowContent(mergedRaw)", src.includes("overflowContent(mergedRaw)"));
ok("C2 代码中不再存在 `mergedRaw.length > NODE_CONTENT_MAX_CHARS` 内联判据", !/mergedRaw\.length\s*>\s*NODE_CONTENT_MAX_CHARS/.test(codeLines));
ok("C3 同文防御不变式存在", src.includes("overflow suppressed (identical to host content"));

console.log(`\n${pass} PASS / ${fail} FAIL`);
if (fail) process.exit(1);
