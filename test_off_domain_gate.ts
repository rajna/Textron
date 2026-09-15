/**
 * 任务侧域闸（TASK-SIDE DOMAIN GATE）回归 —— n8 第十五轮 guard
 * 2026-09-15 实证：`pinnedTaskFamily=stock_alpha` 全局生效（9 条 agent_end_task_pushed 中 4 条非交易域），
 * 原 goal guard 单向（只清网内离域内容，不判本轮任务是否离域）⇒ 工程知识写进交易网络、
 * 淘汰后 L0::node_0 悬空 17 个 [fn:σ]。
 *
 * 判据（T1/T2 直调生产函数，禁复刻；T3/T4 为结构性静态断言，防「闸门被挪到解析之后」而静默失效）：
 *   T1 严格判据：仅 off_domain===true（boolean）触发；缺失 / false / "true" 字符串 / 1 一律不触发
 *   T2 触发时统计正确：strippedUpdates/strippedAdds 计数 + reason 取自 off_domain_reason（回退 rationale）
 *   T3 index.ts 消费点顺序：evaluateTaskDomainGate 调用与其 `return out` 必须早于 node_updates 解析
 *   T4 prompt 装配：taskDomainGateRule 非空且 `-1.` 出现在 `${taskDomainGate}${goalRule}` 中 rule 0 之前；
 *      fallback 与 persistHighEntropyFunction 两条内容通道均带 off_domain 守卫
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { evaluateTaskDomainGate, taskDomainGateRule } from "./src/domain_gate";

let pass = 0, fail = 0;
const assert = (cond: boolean, name: string, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}`, extra ?? ""); }
};

// ── T1 严格判据 ──
console.log("T1 严格判据（仅 boolean true 触发）");
assert(evaluateTaskDomainGate({ off_domain: true }).offDomain === true, 'off_domain:true → 触发');
for (const v of [undefined, null, false, "true", "false", 1, 0, {}, { off_domain: "yes" }]) {
  assert(evaluateTaskDomainGate(v).offDomain === false, `off_domain=${JSON.stringify(v ?? null)} → 不触发`, evaluateTaskDomainGate(v));
}

// ── T2 触发时统计 ──
console.log("T2 触发时统计与 reason 回退");
const g = evaluateTaskDomainGate({
  off_domain: true,
  off_domain_reason: "guard 会话做 Textron 代码修复，网络目标是交易",
  node_updates: { "L0::node_0": { content: "x" }, "L1::node_1": "y" },
  add_nodes: [{ layer: 0, content: "z" }],
});
assert(g.offDomain === true, "触发");
assert(g.strippedUpdates === 2, "strippedUpdates=2（内容零写入可观测）", g.strippedUpdates);
assert(g.strippedAdds === 1, "strippedAdds=1", g.strippedAdds);
assert(g.reason.includes("Textron"), "reason 取自 off_domain_reason", g.reason);
const g2 = evaluateTaskDomainGate({ off_domain: true, rationale: "fallback-rationale" });
assert(g2.reason === "fallback-rationale", "reason 回退到 rationale", g2.reason);
assert(evaluateTaskDomainGate({ off_domain: true, off_domain_reason: "r".repeat(500) }).reason.length === 200, "reason 上限 200c（防审计字段膨胀）");

// ── T3 消费点顺序（结构性：闸门必须在解析之前返回）──
console.log("T3 index.ts 消费点顺序（早退先于内容解析）");
const SRC = fs.readFileSync(path.join(__dirname, "src", "index.ts"), "utf-8");
const iGateCall = SRC.indexOf("evaluateTaskDomainGate(obj)");
const iGateReturn = SRC.indexOf("return out;", iGateCall);
const iUpdatesParse = SRC.indexOf("if (obj?.node_updates && typeof obj.node_updates === \"object\")");
const iAddsParse = SRC.indexOf("if (Array.isArray(obj?.add_nodes))");
assert(iGateCall > 0, "normalize 内确有 evaluateTaskDomainGate 调用点", iGateCall);
assert(iGateReturn > iGateCall, "闸门分支内含 return out", { iGateCall, iGateReturn });
assert(iUpdatesParse > iGateReturn, "早退在 node_updates 解析之前（否则无效）", { iGateReturn, iUpdatesParse });
assert(iAddsParse > iGateReturn, "早退在 add_nodes 解析之前", { iGateReturn, iAddsParse });
assert(SRC.includes('action: "semantic_backward_off_domain"'), "触发时记 semantic_backward_off_domain（可运行期验收）");
assert(SRC.includes("!result.off_domain && bwResult.nodesUpdated === 0"), "highEntropy fallback 通道带域闸守卫");
assert(/result\.off_domain\s*\n?\s*\? undefined\s*\n?\s*: persistHighEntropyFunction/.test(SRC), "Function 硬落盘通道带域闸守卫");

// ── T4 prompt 装配 ──
console.log("T4 prompt 装配（-1 先于 rule 0；goal 为空则无闸）");
const rule = taskDomainGateRule("沉淀交易经验");
assert(rule.startsWith("-1."), "规则标号 -1.（最高优先级）", rule.slice(0, 20));
assert(rule.includes('"off_domain": true'), "含要求 LLM 返回的字面 JSON 形状");
assert(rule.includes("沉淀交易经验"), "含网络 goal 字面（LLM 判据的唯一锚点）");
assert(taskDomainGateRule("") === "", "无 goal 时不注入（不制造无锚点的域判决）");
const iSys = SRC.indexOf("RULES:");
const iTaskGate = SRC.indexOf("${taskDomainGate}", iSys);
const iGoal = SRC.indexOf("${goalRule}", iSys);
assert(iTaskGate > iSys && iGoal > iTaskGate, "system prompt 中 ${taskDomainGate} 先于 ${goalRule}", { iSys, iTaskGate, iGoal });
assert(SRC.includes('import { evaluateTaskDomainGate, taskDomainGateRule } from "./domain_gate"'), "index.ts 引用模块（禁内联复刻）");
assert(!SRC.includes("🚧 TASK-SIDE DOMAIN GATE (ABSOLUTE"), "规则文本未在 index.ts 内联（单一事实来源）");

console.log(`\n${fail === 0 ? "✅ PASS" : "❌ FAIL"}  ${pass}/${pass + fail}`);
process.exit(fail === 0 ? 0 : 1);
