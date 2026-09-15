/**
 * 回归：轨迹「工具侧原文保真」—— 消除三处静默 slice（n8 第十四轮）
 *
 * 背景（guard 本轮实证）：`lib/round_snapshot.ts` 原实现
 *   input `.slice(0,180)` / output `.slice(0,640)` / `maxEntries=24` 超限 `shift()` 静默丢。
 * 实测窗口内 **22/40 条工具调用 input 恰为 180c**：guard 下发 n6 第6/10条新要求的 coms_send、
 * worker 的 edit trade.py、/api/step 的 body(session_id+决策 JSON) 全被砍成摘要 ⇒
 * 「报价 vs 成交价 / success:false / 越界」这类执行层证据不可复核，
 * 「反传拿什么判 reward」「轨迹是否完整」失去唯一可核对的物证。
 *
 * 判据（与 0405809 轨迹 userPrompt/answer 约定同构）：
 *   T1 旧上限(180c/640c)内的长内容必须完整保留；
 *   T2 超 cap 才截，且尾部显式标注 `…[+Nc/Nc]`（禁静默）；
 *   T3 条目溢出不再静默 shift —— droppedOldest 计数 + 首行 `⛔dropped_oldest:N` 标记；
 *   T4 stats 与真实内容一致（inputChars 为截断前总量）；
 *   T5 本轮真实样本（n6 指令）关键语义未被砍掉；
 *   T6 向后兼容：rebuildToolsFromMessages 仍返回 string[]；
 *   T7 thinking 截断可观测；T8 不可序列化 input 不抛异常。
 */
import {
  rebuildToolsFromMessages,
  rebuildToolsFromMessagesDetailed,
  rebuildThinkingFromMessagesDetailed,
  clipWithMark,
  TOOL_INPUT_CAP,
  TOOL_OUTPUT_CAP,
} from "./src/lib/round_snapshot";

let fail = 0;
const t = (name: string, cond: boolean, got?: unknown) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : `  got=${JSON.stringify(got)?.slice(0, 300)}`}`);
  if (!cond) fail++;
};

// 真实形状：n6 指令（guard→sender），远超旧 180c 上限
const N6_PROMPT =
  "【guard 指令】开始交易游戏：完成 1 次交易推进。\n\n不要指定股票和日期；选股交 A/B 裁决或 load/resume 决定。" +
  "⚠️ worker 做决策时**可用工具 /Users/rama/textron-agent/workflows/trade.py**，且不得用任何手段获取后续股票数据。" +
  "复盘时要把**反思内容与 trade.py 中的交易策略做元分析**，形成更抽象、更凝练、更成熟、风报比更高的策略，然后更新 trade.py 的函数体。";
const sendArgs = { target: "sender", prompt: N6_PROMPT };
const stepBody = { session_id: "76c1792839f2", decision: "持有", tradePrice: 0.0, tradeQuantity: 0, confidence: "中" };
const stepResult =
  '{"success":true,"message":"持有 sz.301299 仓位","portfolio":{"total_value":102283.0,"cash":75693.0,' +
  '"position":{"quantity":500,"cost_price":53.6,"market_price":53.18,"unrealized_pnl":-210.0}}}'.repeat(6);

const msgs = [
  { role: "user", content: "go" },
  { role: "assistant", content: [{ type: "toolCall", name: "coms_send", input: sendArgs }] },
  { role: "toolResult", content: [{ type: "text", text: "sent to sender\nmsg_id: cf496c1a-809f-414d-9202-2fabab21a0da\nhops: 1" }] },
  { role: "assistant", content: [{ type: "toolCall", name: "bash", input: { command: "curl -s -X POST http://127.0.0.1:7860/api/step -d '" + JSON.stringify(stepBody) + "'" } }] },
  { role: "toolResult", content: [{ type: "text", text: stepResult }] },
];

const { lines, stats } = rebuildToolsFromMessagesDetailed(msgs);
const joined = lines.join(" ⏎ ");

// T1/T5: 旧上限内的长内容完整保留（含关键语义标识）
t("T1 coms_send 的 n6 指令完整保留（不被砍到 180c）", joined.includes("trade.py") && joined.includes("元分析") && joined.includes("风报比更高"), joined.slice(0, 200));
t("T1b 指令字符数 = 原文（JSON 转义后）", joined.includes(JSON.stringify(N6_PROMPT).replace(/\s+/g, " ").slice(0, 300)), "");
t("T2 未触发截断时无标记", !joined.includes("…[+"), joined.slice(-120));
t("T3 output 超 640c 不被砍掉关键字段", joined.includes("unrealized_pnl") && joined.includes("102283"), "");
t("T4 stats.inputChars 为截断前总量且 > 180*2", stats.inputChars > 360, stats);
t("T4b 无截断时 truncated 计数为 0", stats.inputTruncated === 0 && stats.outputTruncated === 0, stats);
t("T4c entries = toolCall 条目数（out 配入同条）", stats.entries === lines.length && stats.entries === 2 && lines.every((l) => l.startsWith("▶") && l.includes("→ out:")), stats);

// T2': 真超 cap → 显式标记（而不是静默）
const huge = "A".repeat(TOOL_INPUT_CAP + 137);
const big = rebuildToolsFromMessagesDetailed([{ role: "assistant", content: [{ type: "toolCall", name: "bash", input: { command: huge } }] }]);
t("T2' 超 cap 显式标注被截量", big.lines[0].includes(`…[+137c/${huge.length + '{"command":""}'.length}c]`) || /…\[\+\d+c\/\d+c\]/.test(big.lines[0]), big.lines[0].slice(-60));
t("T2'b inputTruncated 计数为 1", big.stats.inputTruncated === 1, big.stats);
t("T2'c clipWithMark 直测", clipWithMark("x".repeat(10), 4) === "xxxx…[+6c/10c]", clipWithMark("x".repeat(10), 4));

// T3': 条目溢出 → 计数 + 显式标记，非静默
const many = Array.from({ length: 30 }, (_, i) => ({ role: "assistant", content: [{ type: "toolCall", name: `t${i}`, input: { i } }] }));
const ov = rebuildToolsFromMessagesDetailed(many, { maxEntries: 24 });
t("T3' 溢出记 droppedOldest=6", ov.stats.droppedOldest === 6, ov.stats);
t("T3'd 首行显式 dropped 标记", ov.lines[0] === "⛔dropped_oldest:6", ov.lines[0]);
t("T3'e entries 不含标记行", ov.stats.entries === 24 && ov.lines.length === 25, ov.stats);

// T6: 向后兼容
const compat = rebuildToolsFromMessages(msgs);
t("T6 向后兼容仍返回 string[]", Array.isArray(compat) && typeof compat[0] === "string" && compat.length === 2, compat.length);

// T7: thinking 截断可观测
const th = rebuildThinkingFromMessagesDetailed([{ role: "assistant", content: [{ type: "thinking", thinking: "X".repeat(5000) }] }], 1400);
t("T7 thinking 尾部保留 1400 且标记截断", th.text.length === 1400 && th.stats.truncated === true && th.stats.chars === 5000, th.stats);

// T8: 不可序列化 input 不抛异常
const cyc: any = { a: 1 }; cyc.self = cyc;
let threw = false;
try { rebuildToolsFromMessagesDetailed([{ role: "assistant", content: [{ type: "toolCall", name: "x", input: cyc }] }]); } catch { threw = true; }
t("T8 循环引用 input 不抛异常", !threw);

// T9: 源码静态断言 —— 旧三处静默 slice 不得复现
import * as fs from "fs";
const src = fs.readFileSync(new URL("./src/lib/round_snapshot.ts", import.meta.url), "utf8");
t("T9 源码无 .slice(0, 180) 残留", !src.includes(".slice(0, 180)"), "");
t("T9b 源码无 .slice(0, 640) 残留", !src.includes(".slice(0, 640)"), "");
t("T9c 源码默认条目上限已扩容", src.includes("TOOL_MAX_ENTRIES = 200"), "");

console.log(fail === 0 ? "\nALL PASS" : `\n${fail} FAIL`);
