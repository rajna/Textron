// 2026-09-03: LLM 输出预算参数的单一事实源（single writer）。
//
// 病灶（实测，同一失败 prompt 重放 · qwen3.8-flash @ dashscope compatible-mode）:
//   max_completion_tokens=4096             → 86.6s · content 0c / reasoning 13716c · finish=length → 三重兜底全败
//   max_tokens=4096                        → 42.4s · content 432c 合法 JSON · finish=stop         → 成功
//   max_tokens=4096 + reasoning_effort=low → 11.6s · content 660c 合法 JSON · finish=stop         → 成功
//   max_tokens=4096 + enable_thinking=false→  4.4s · content 358c 合法 JSON · finish=stop         → 成功
// 即: 部分 provider 把 max_completion_tokens 当成 reasoning+content 的合并上限，reasoning 模型默认
// thinking=high 时思维链先吃光预算 → content 恒空 → 解析器拿不到 JSON。参数名写死 = 结构上允许该失败发生。
//
// 因此预算参数名/思考开关必须由 pi 的同一张 compat 表决定，而不是按模型名硬编码。

import * as fs from "node:fs";
import * as path from "node:path";

export interface CompatLike {
  maxTokensField?: string;
  supportsReasoningEffort?: boolean;
  thinkingFormat?: string;
}

export interface ModelLike {
  id?: string;
  provider?: string;
  baseUrl?: string;
  compat?: CompatLike;
}

/** reasoning/思考型且已声明支持 reasoning_effort 的家族（qwen/kimi/dashscope/aliyun 网关）。 */
function isQwenFamily(tag: string): boolean {
  return /qwen|dashscope|aliyuncs|token-plan/.test(tag);
}

/** budget 下限：必须大于 reasoning 模型单次思维链长度（实测 13.7k~16.2k 字符 ≈ 4~5k tokens），
 *  否则 content 恒空。低于此值的调用方会被强制抬到该值。 */
export const MIN_OUTPUT_BUDGET = 8192;
/** 关思考调用的下限：没思维链抢预算，只需兼顾 JSON 体自身长度（backward 实测 ≤1.4k token）。
 *  拿 8192 去抬 noThinking 只会把 pairing 这种几百 token 的小任务无谓地放宽上限。 */
export const MIN_NO_THINK_BUDGET = 1024;

/** 从磁盘解析模型 compat（与 pi 自身读同一批配置文件，保证参数表不分叉）。
 *  三级: models.json providers[p].compat → models-store.json providers[p].models[id].compat → {}。
 *  带进程内缓存，key = provider::modelId。 */
const _diskCompatCache: Record<string, CompatLike> = {};
export function readCompatFromDisk(m: ModelLike, homeDir?: string): CompatLike {
  const p = String(m?.provider || "");
  const id = String(m?.id || "");
  const ck = `${p}::${id}`;
  if (ck in _diskCompatCache) return _diskCompatCache[ck];
  let compat: CompatLike = {};
  if (p) {
    const root = homeDir || path.join(process.env.HOME || process.env.USERPROFILE || "~", ".pi", "agent");
    const readJson = (f: string): any => {
      try { return JSON.parse(fs.readFileSync(f, "utf-8")); } catch { return {}; }
    };
    const cfg = readJson(path.join(root, "models.json"));
    compat = (cfg?.providers?.[p]?.compat as CompatLike) || null as unknown as CompatLike;
    if (!compat || !(compat as any).maxTokensField) {
      const store = readJson(path.join(root, "models-store.json"));
      const entry = (store?.[p]?.models || []).find((x: any) => x?.id === id);
      compat = entry?.compat || {};
    }
  }
  _diskCompatCache[ck] = compat || {};
  return _diskCompatCache[ck];
}

/** 该模型能否“有界地思考”（即可以用参数把思维链压到可接受耗时）。
 * 不能的模型（实测 deepseek-v4-flash 在 8192 预算下 >150s 仍不返回，而关思考后 1.2s 出合法 JSON）
 * 一律把“关思考”作为首选 attempt，否则阶梯会把前两次 attempt 全花在超时上。
 */
export function canBoundThinking(model: ModelLike, compat: CompatLike = {}): boolean {
  const tag = `${model?.provider || ""} ${model?.id || ""} ${model?.baseUrl || ""}`.toLowerCase();
  if (compat?.supportsReasoningEffort === true || /kimi/.test(tag)) return true;
  if (isQwenFamily(tag)) return true; // qwen 系: effort=low 实测 12.6s / 42.4s 稳定有界
  return false;
}

/**
 * 构造一次 chat/completions 请求的“输出预算 + 思考控制”参数。
 * @param model 运行时模型对象（含 provider/id/baseUrl，compat 可选）
 * @param compat 由 compat 表解析出的声明（model.compat → models.json → models-store.json）
 * @param budget 期望的输出 token 预算（必须显著大于思维链长度，否则 content 恒空）
 * @param opts.noThinking 彻底关闭思考（末路兜底：牺牲推理质量换“一定有 content”）
 */
export function buildBudgetParams(
  model: ModelLike,
  compat: CompatLike = {},
  budget = 8192,
  opts: { noThinking?: boolean } = {},
): Record<string, unknown> {
  const tag = `${model?.provider || ""} ${model?.id || ""} ${model?.baseUrl || ""}`.toLowerCase();
  const qwen = isQwenFamily(tag);
  const maxField = String(compat?.maxTokensField || "").toLowerCase() === "max_tokens" || qwen
    ? "max_tokens"
    : "max_completion_tokens";
  const floor = opts.noThinking ? MIN_NO_THINK_BUDGET : MIN_OUTPUT_BUDGET;
  const params: Record<string, unknown> = { [maxField]: Math.max(floor, budget) };

  if (opts.noThinking) {
    // 各家“关思考”的开关名不同，发错会直接 400：qwen 兼容模式 = enable_thinking:false，
    // deepseek = thinking.type:"disabled"，其余(无法可靠关思考)退到 reasoning_effort:"low"。
    if (qwen) params.enable_thinking = false;
    else if (compat?.thinkingFormat === "deepseek" || /deepseek/.test(tag)) params.thinking = { type: "disabled" };
    else if (compat?.supportsReasoningEffort === true || /kimi/.test(tag)) params.reasoning_effort = "low";
  } else if (compat?.supportsReasoningEffort === true || /kimi/.test(tag) || qwen) {
    // 未声明支持的模型不发（deepseek 老模型曾因此触发 8K+ 思维链 → 超时）。
    params.reasoning_effort = "low";
  }
  return params;
}

/** 从三级来源解析 compat：model.compat → models.json[provider].compat → models-store.json[provider].models[id].compat */
export function pickCompat(...sources: (CompatLike | null | undefined)[]): CompatLike {
  for (const s of sources) if (s && typeof s === "object" && Object.keys(s).length > 0) return s;
  return {};
}
