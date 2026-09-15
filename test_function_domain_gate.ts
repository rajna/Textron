/**
 * 函数侧域闸（FUNCTION-SIDE DOMAIN GATE）回归 —— n8 第十七轮 guard
 *
 * 背景（实证链）：
 *   ① `75847ed`（任务侧域闸）连续三轮 `semantic_backward_off_domain` **恒 0**；窗口内 12 次反传
 *      LLM 原输出 0/12 含 `off_domain` 字段，而同窗口 6 条 `agent_end_task_pushed` 的 taskType
 *      全在域内（A股限价撮合决策 / 多智能体交易游戏派发记账）⇒ 判「任务在域内」是**正确的**，
 *      闸门**结构性不可触发**（任务域 ≠ 内容域）。
 *   ② 同轮 HE 仍产出纯编排函数 `sender_step_loop_orchestrate` 并**硬落盘**到 `L0::node_0`，
 *      顶掉交易域块 `pi_star_gate_delta_decision`（`fn_block_evicted.dangling`）。
 *   ⇒ 判据面迁移：从「本轮任务是否属域」迁到「本轮 <Function> 块的机制是否属域」，
 *      且只 gate 两条**程序化写入通道**（Function 硬落盘 + HE fallback add），不再整轮早退。
 *
 * 判据：
 *   T1 严格判据：仅 function_off_goal===true（boolean）触发；缺失/false/"true"/1 一律不触发
 *   T2 reason 回退（function_off_goal_reason → rationale）+ 200c 上限
 *   T3 index.ts 结构性：①本闸调用点存在 ②**任务侧整轮早退已移除**（回滚判据可执行化）
 *      ③两条程序化通道均带 result.function_off_goal 守卫 ④事件名切换
 *   T4 prompt 装配：规则先于 rule 0、含 goal 字面与字段名、无 goal 不注入、问的是「函数机制」而非「任务」
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { evaluateFunctionDomainGate, functionDomainGateRule } from "./src/domain_gate";

let pass = 0, fail = 0;
const assert = (cond: boolean, name: string, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}`, extra ?? ""); }
};

// ── T1 严格判据 ──
console.log("T1 严格判据（仅 boolean true 触发）");
assert(evaluateFunctionDomainGate({ function_off_goal: true }).offGoal === true, "function_off_goal:true → 触发");
for (const v of [undefined, null, false, "true", "false", 1, 0, {}, { function_off_goal: "yes" }]) {
  assert(evaluateFunctionDomainGate(v).offGoal === false, `function_off_goal=${JSON.stringify(v ?? null)} → 不触发`, evaluateFunctionDomainGate(v));
}

// ── T2 触发时 reason ──
console.log("T2 reason 回退与上限");
assert(evaluateFunctionDomainGate({ function_off_goal: true, function_off_goal_reason: "函数体是 agent 中继幂等，非交易" }).reason.includes("幂等"), "reason 取自 function_off_goal_reason");
assert(evaluateFunctionDomainGate({ function_off_goal: true, rationale: "fallback-rationale" }).reason === "fallback-rationale", "reason 回退到 rationale");
assert(evaluateFunctionDomainGate({ function_off_goal: true, function_off_goal_reason: "r".repeat(500) }).reason.length === 200, "reason 上限 200c");

// ── T3 index.ts 结构（回滚 + 迁移的双向可执行检查）──
console.log("T3 index.ts 消费点（迁移到位 · 旧早退已移除）");
const SRC = fs.readFileSync(path.join(__dirname, "src", "index.ts"), "utf-8");
assert(SRC.includes("evaluateFunctionDomainGate(obj)"), "存在 evaluateFunctionDomainGate 调用点");
assert(SRC.includes('action: "semantic_backward_function_off_goal"'), "触发时记 semantic_backward_function_off_goal（可运行期验收）");
assert(!SRC.includes("semantic_backward_off_domain"), "旧任务侧事件已移除（回滚判据：无残留）");
assert(!SRC.includes("evaluateTaskDomainGate"), "旧任务侧裁决函数已不再被引用");
assert(!/const gate = evaluateTaskDomainGate/.test(SRC), "旧早退语句已消失");
// 整轮早退必须不存在：本闸分支内不得出现 return out
const iGate = SRC.indexOf("const fnGate = evaluateFunctionDomainGate(obj)");
const iNextParse = SRC.indexOf('if (obj?.node_updates && typeof obj.node_updates === "object")', iGate);
assert(iGate > 0 && iNextParse > iGate, "本闸位于 node_updates 解析之前（只做标记、不早退）", { iGate, iNextParse });
assert(!SRC.slice(iGate, iNextParse).includes("return out"), "本闸分支内无 return out ⇒ 不整轮早退（node_updates 仍照常解析）");
// 两条程序化通道
assert(SRC.includes("if (!result.function_off_goal && bwResult.nodesUpdated === 0 && previousAssistantHighEntropy)"), "HE fallback 通道带函数侧域闸守卫");
assert(/if \(result\.function_off_goal\) \{[\s\S]{0,400}?fnPersist = undefined;/.test(SRC), "Function 硬落盘通道带函数侧域闸守卫（true ⇒ 不落盘）");
assert(SRC.includes('reason: "function_off_goal"'), "被拦时记 highentropy_function_skipped{function_off_goal}（否则拦截静默）");
assert(SRC.includes('import { evaluateFunctionDomainGate, functionDomainGateRule } from "./domain_gate"'), "index.ts 引用模块（禁内联复刻）");

// ── T4 prompt 装配 ──
console.log("T4 prompt 装配（问的是函数机制，不是任务标签）");
const rule = functionDomainGateRule("沉淀交易经验");
assert(rule.startsWith("-1."), "规则标号 -1.（最高优先级）", rule.slice(0, 20));
assert(rule.includes('"function_off_goal": true'), "含要求 LLM 返回的字段字面");
assert(rule.includes('"function_off_goal": false'), "含在域内分支（对称问法，防只给离域样例的偏置）");
assert(rule.includes("沉淀交易经验"), "含网络 goal 字面（LLM 判据的唯一锚点）");
assert(rule.includes("never the round's task label"), "显式禁止用任务标签代替函数机制判定（修复维度错位的核心）");
assert(rule.includes("node_updates / add_nodes / merge / reward still follow rules 0-10"), "显式声明只 gate 程序化通道（不误杀内容面）");
assert(rule.includes("omitted field is treated as in-goal"), "显式声明缺省=在域内（改动不可把系统改差）");
assert(functionDomainGateRule("") === "", "无 goal 时不注入（不制造无锚点的域判决）");
const iSys = SRC.indexOf("RULES:");
const iFnGate = SRC.indexOf("${fnDomainGate}", iSys);
const iGoal = SRC.indexOf("${goalRule}", iSys);
assert(iFnGate > iSys && iGoal > iFnGate, "system prompt 中 ${fnDomainGate} 先于 ${goalRule}", { iSys, iFnGate, iGoal });
assert(!SRC.includes("TASK-SIDE DOMAIN GATE"), "规则文本未在 index.ts 内联（单一事实来源）");

console.log(`\n${fail === 0 ? "✅ PASS" : "❌ FAIL"}  ${pass}/${pass + fail}`);
process.exit(fail === 0 ? 0 : 1);
