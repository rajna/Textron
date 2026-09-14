// Centralized size limits keep node storage, merge, backward output, and prompt handling aligned.
// 2026-09-14: content 写入上限取消（0 = 不限制）。原 1000c 是「抽象融合」的物理天花板：
// 任何 merge/append 结果超过 1000c 即被截断（实测 content 恰好 999/1000c、name 拼接爆 48c、
// 融合产物开天窗），导致节点只能承载碎片而非累积抽象。
// 写入宽（不再截断）+ 读取窄（NODE_INJECT_MAX_CHARS 控注入预算），二者解耦。
export const NODE_CONTENT_MAX_CHARS = 0;
// 读取侧（前向编译注入）单节点上限：防写入变宽后 prompt 膨胀。
export const NODE_INJECT_MAX_CHARS = 900;
export const HIGH_ENTROPY_TASK_MAX_CHARS = 100;
export const HIGH_ENTROPY_TECHNIQUE_MAX_CHARS = 500;
export const DEFAULT_COMPILED_CONTEXT_MAX_CHARS = 12000;

/** 统一的内容写入限幅：limit<=0 表示不限制（写入宽）。 */
export function applyContentLimit(text: string, limit: number = NODE_CONTENT_MAX_CHARS): string {
  const s = String(text ?? "");
  if (!limit || limit <= 0) return s;
  return s.length > limit ? s.slice(0, limit) : s;
}
