/**
 * 回归：content 写入上限语义 —— maxLen<=0 = 「不限制」（不是「截断到 0」）
 *
 * 背景（n8 第十二轮 guard 实证的「反传写入路径全断」真因）：
 *   4d9de9b 起 NODE_CONTENT_MAX_CHARS=0 表示「取消写入上限」，但 lib/utils.completeContent
 *   仍按 `s.slice(0, maxLen)` 处理 ⇒ 0 被当成截断上限 ⇒ 所有非空内容返回 ""。
 *   normalize() 里 node_updates/add_nodes 的 content 全走 completeContent(_, NODE_CONTENT_MAX_CHARS)
 *   ⇒ 6 处调用点全返回 "" ⇒ `if (content && name)` 恒假 ⇒ node_updates 被静默丢弃。
 *   实证：4d9de9b(2026-09-15 00:40) 之后 semantic_backward_llm_raw_response 中
 *   diagDirectKeys>0 但 parsedNodeUpdateKeys==0 的比例 = 2/2（之前 800/954 被接受）。
 *
 * 判据：T1 maxLen=0 → 原样返回（不得为空）；T2 maxLen<0 → 原样返回；T3 maxLen>0 → 仍截断；
 *       T4 与 applyContentLimit 语义一致；T5 复刻 normalize() 对象分支：本轮真实 LLM 输出必须被接受。
 */
import { isNgramFragmentContent, isNgramFragmentName } from "./src/lib/node_io";
import { completeContent, parseLayerNodeId } from "./src/lib/utils";
import { NODE_CONTENT_MAX_CHARS, applyContentLimit } from "./src/content_limits";

const LONG = "评分语义=机会成本定价：空仓且价格变动不产生盈亏时记-2（不亏不赚也扣分），即保守中性在评分体系里等于负分";
let fail = 0;
const t = (name: string, cond: boolean, got?: string) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : `  got=${JSON.stringify(got)}`}`);
  if (!cond) fail++;
};

console.log(`NODE_CONTENT_MAX_CHARS = ${NODE_CONTENT_MAX_CHARS}`);
t("T1 completeContent(x, 0) 不被清空（=不限制）", completeContent(LONG, NODE_CONTENT_MAX_CHARS) === LONG, completeContent(LONG, NODE_CONTENT_MAX_CHARS));
t("T2 completeContent(x, -1) 不被清空", completeContent(LONG, -1) === LONG, completeContent(LONG, -1));
t("T3 completeContent(x, 10) 仍截断到 ≤10", completeContent(LONG, 10).length <= 10 && completeContent(LONG, 10).length > 0, completeContent(LONG, 10));
t("T4 与 applyContentLimit(limit=0) 语义一致", applyContentLimit(LONG, 0) === completeContent(LONG, 0));
t("T5 空串仍为空", completeContent("", 0) === "");

// T6: 复刻 normalize() 的 node_updates 对象分支（真实 R12 输出）
function normalizeLike(v: any, key: string) {
  const parsed = parseLayerNodeId(key);
  const nodeExists = !!parsed && parsed.layer < 4 && parseInt(parsed.nodeId.replace("node_", ""), 10) < 2;
  if (!parsed || !nodeExists) return false;
  const rawMode = String(v.mode || "merge").trim().toLowerCase();
  const keep = completeContent(String(v.keep || "").trim(), 400);
  const delta = completeContent(String(v.content || v.context || "").trim(), NODE_CONTENT_MAX_CHARS);
  const content = rawMode === "replace" || !keep ? delta : `${keep} ⏎ ${delta}`;
  const name = completeContent(String(v.name || ""), 64);
  return !!(content && name && !isNgramFragmentContent(content) && !isNgramFragmentName(name));
}
t("T6a R12#1 (merge/keep=旧名) node_updates 被接受",
  normalizeLike({ mode: "merge", keep: "本轮内容全量替换节点 2 0 依次注入该节点全部·验收门禁固定为集合差单调不减·收盘跌破关键结构", drop: "", name: "破位反抽终点·长上影放量滞涨判据", content: LONG }, "L0::node_0"));
t("T6b R12#2 (replace/keep=空) node_updates 被接受",
  normalizeLike({ mode: "replace", keep: "", drop: "工程域内容", name: "零暴露机会成本定价·最小可执行仓位", content: LONG }, "L0::node_0"));

console.log(fail === 0 ? "\nALL PASS" : `\n${fail} FAIL`);
process.exit(fail === 0 ? 0 : 1);
