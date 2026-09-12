/**
 * test_llm_budget.ts — 输出预算参数单测（backward/L0/pairing 共用同一事实源）
 * 运行: node /usr/local/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/.bin/jiti test_llm_budget.ts
 *
 * 固定输入 = 三个真实 provider 的 compat 声明 + 真实模型对象形状；
 * 期望输出 = 参数名按 compat 分流、预算不低于 MIN_OUTPUT_BUDGET、思考开关互斥。
 */
import { buildBudgetParams, pickCompat, canBoundThinking, readCompatFromDisk, MIN_OUTPUT_BUDGET, MIN_NO_THINK_BUDGET } from "./src/lib/llm_budget";

let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name} ${detail}`); }
}

// 真实 compat（抄自 ~/.pi/agent/models.json 与 models-store.json）
const QWEN = { id: "qwen3.8-flash", provider: "dashscope", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1" };
const QWEN_COMPAT = { maxTokensField: "max_tokens", supportsReasoningEffort: true, thinkingFormat: "qwen" };
const DS = { id: "deepseek-v4-flash", provider: "deepseek", baseUrl: "https://api.deepseek.com" };
const DS_COMPAT = { maxTokensField: "max_tokens", supportsReasoningEffort: undefined, thinkingFormat: "deepseek" };
const GPT = { id: "gpt-5.2", provider: "gpt", baseUrl: "https://share-api.com/v1" };
const KIMI = { id: "kimi-k3", provider: "volcengine", baseUrl: "https://ark.cn-beijing.volces.com/api/v3" };

console.log("== 1) qwen/dashscope：必须用 max_tokens，且压 reasoning 预算 ==");
{
  const p = buildBudgetParams(QWEN, QWEN_COMPAT, 8192);
  check("max_tokens 而非 max_completion_tokens", p.max_tokens === 8192 && p.max_completion_tokens === undefined, JSON.stringify(p));
  check("reasoning_effort=low", p.reasoning_effort === "low");
  check("未声明关思考", p.enable_thinking === undefined);
}

console.log("== 2) 病灶回归：小预算被强制抬到 MIN_OUTPUT_BUDGET（4096 会被思维链吃光） ==");
{
  const p = buildBudgetParams(QWEN, QWEN_COMPAT, 4096);
  check(`4096 → ${MIN_OUTPUT_BUDGET}`, p.max_tokens === MIN_OUTPUT_BUDGET, JSON.stringify(p));
  const p2 = buildBudgetParams(GPT, {}, 2048);
  check("gpt 兜底也用 max_completion_tokens 且抬到下限", p2.max_completion_tokens === MIN_OUTPUT_BUDGET && p2.max_tokens === undefined, JSON.stringify(p2));
}

console.log("== 3) compat 缺失也按 qwen 家族名分流（网关模型常无 compat） ==");
{
  const p = buildBudgetParams({ id: "qwen3.8-max", provider: "dashscope", baseUrl: "x" }, {}, 8192);
  check("空 compat + qwen → max_tokens", p.max_tokens === 8192, JSON.stringify(p));
  const tp = buildBudgetParams({ id: "deepseek-v4-flash-0731", provider: "qwen-token-plan-individual", baseUrl: "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1" }, {}, 8192);
  check("token-plan 网关 → max_tokens + effort=low", tp.max_tokens === 8192 && tp.reasoning_effort === "low", JSON.stringify(tp));
}

console.log("== 4) noThinking 末路兜底：开关名必须按家分派，发错就是 400 ==");
{
  const q = buildBudgetParams(QWEN, QWEN_COMPAT, 8192, { noThinking: true });
  check("qwen → enable_thinking:false 且不再传 effort", q.enable_thinking === false && q.reasoning_effort === undefined, JSON.stringify(q));
  const d = buildBudgetParams(DS, DS_COMPAT, 8192, { noThinking: true });
  check("deepseek → thinking.type=disabled", JSON.stringify((d as any).thinking) === '{"type":"disabled"}', JSON.stringify(d));
  const k = buildBudgetParams(KIMI, { supportsReasoningEffort: true }, 8192, { noThinking: true });
  check("kimi 无关思考开关 → 退到 reasoning_effort:low", k.reasoning_effort === "low" && k.enable_thinking === undefined && (k as any).thinking === undefined, JSON.stringify(k));
}

console.log("== 5) deepseek 未声明 supportsReasoningEffort → 正常路径不发 effort（旧回归：8K+ 思维链超时） ==");
{
  const p = buildBudgetParams(DS, DS_COMPAT, 8192);
  check("不发 reasoning_effort", p.reasoning_effort === undefined, JSON.stringify(p));
  check("max_tokens 依 compat 声明", p.max_tokens === 8192);
}

console.log("== 6) 互斥不变量：任何输入都不得同时出现两个 max 字段 ==");
{
  const models = [QWEN, DS, GPT, KIMI];
  const compats: any[] = [{}, QWEN_COMPAT, DS_COMPAT, { maxTokensField: "max_completion_tokens" }];
  let both = 0;
  for (const m of models) for (const c of compats) for (const nt of [false, true]) {
    const p: any = buildBudgetParams(m, pickCompat(c), 4096, { noThinking: nt });
    if (p.max_tokens !== undefined && p.max_completion_tokens !== undefined) both++;
    if (p.max_tokens === undefined && p.max_completion_tokens === undefined) both++;
  }
  check("恰好一个 max 字段", both === 0, `violations=${both}`);
}

console.log("== 7) pickCompat 三级优先：显式 > models.json > models-store ==");
{
  check("优先取非空", pickCompat({ maxTokensField: "max_tokens" }, { maxTokensField: "max_completion_tokens" }).maxTokensField === "max_tokens");
  check("全空返回 {}", Object.keys(pickCompat(null, undefined, {})).length === 0);
}

console.log("== 8) 阶梯排序依据：能否有界思考（deepseek 不可界 → 先关思考） ==");
{
  check("qwen 可界（supportsReasoningEffort=true）", canBoundThinking(QWEN, QWEN_COMPAT) === true);
  check("kimi 可界（按家族名兼容旧配置）", canBoundThinking(KIMI, {}) === true);
  check("deepseek 不可界（无 effort 声明）", canBoundThinking(DS, DS_COMPAT) === false);
  check("gpt 保守归为不可界（无思考开关声明）", canBoundThinking(GPT, {}) === false);
}

console.log("== 9) 预算下限分轨：带思考 8192 / 关思考 1024（pairing 类小任务） ==");
{
  const a: any = buildBudgetParams(QWEN, QWEN_COMPAT, 512, { noThinking: false });
  const b: any = buildBudgetParams(QWEN, QWEN_COMPAT, 512, { noThinking: true });
  check("思考轨抬到 MIN_OUTPUT_BUDGET", a.max_tokens === MIN_OUTPUT_BUDGET, JSON.stringify(a));
  check("关思考轨抬到 MIN_NO_THINK_BUDGET 而不是 8192", b.max_tokens === MIN_NO_THINK_BUDGET, JSON.stringify(b));
}

console.log("== 10) readCompatFromDisk 跑真实 ~/.pi/agent 配置（参数表不得与 pi 分叉） ==");
{
  const qc = readCompatFromDisk({ id: "qwen3.8-flash", provider: "dashscope" });
  check("dashscope compat 取到 max_tokens", String(qc.maxTokensField) === "max_tokens", JSON.stringify(qc));
  check("dashscope compat 声明 supportsReasoningEffort", qc.supportsReasoningEffort === true);
  const dc = readCompatFromDisk({ id: "deepseek-v4-flash", provider: "deepseek" });
  check("deepseek 从 models-store 取到 max_tokens", String(dc.maxTokensField) === "max_tokens", JSON.stringify(dc));
  check("deepseek thinkingFormat=deepseek", String(dc.thinkingFormat) === "deepseek");
  // 端到端参数（真实配置驱动，不是手抄 compat）
  const realQ = buildBudgetParams(QWEN, readCompatFromDisk({ id: "qwen3.8-flash", provider: "dashscope" }), 4096);
  check("生产等价体: max_tokens=8192 + effort=low（4096 被抬到下限）",
    realQ.max_tokens === MIN_OUTPUT_BUDGET && realQ.reasoning_effort === "low", JSON.stringify(realQ));
  const realD = buildBudgetParams(DS, readCompatFromDisk({ id: "deepseek-v4-flash", provider: "deepseek" }), 8192);
  check("deepseek 正常路径不发 effort", realD.reasoning_effort === undefined && realD.max_tokens === 8192, JSON.stringify(realD));
}

console.log(`\n[buildBudgetParams] PASS=${pass} FAIL=${fail}`);
process.exit(fail ? 1 : 0);
