// round_snapshot.ts —— agent_end 单数据源快照提取
//
// 2026-09-05: 正确回合模型 —— 每条用户消息 = 一次完整 run(before_agent_start→agent_end),
// 中间多 turn(assistant→toolCall→toolResult→assistant...)全部体现在 agent_end 的
// event.messages 全量数组中。textron 不需要 message_update/tool_call/tool_result 等
// 增量 hook 逐条拼接, 直接在回合收尾时从 messages 提取本轮完整快照:
//   { userPrompt, tools[], assistantText, hasTools }
// 这样:
//   - userPrompt 每次取自本轮末条 user 消息 → coms 续接轮不再残留上一轮 msg_id(修复错位)
//   - tools 链从 toolCall(assistant content) + toolResult 消息重建 → 与增量缓冲等价, 但无跨 hook 状态
//   - 无 before_agent_start 触发的续接轮也能取到真实输入 → 配对/反传不再漏 reward

/** 递归提取 toolResult/content 文本(与 tool_result hook 同构, 防 [object Object]) */
export function extractToolResultText(content: unknown, depth = 0): string {
  if (depth > 6) return "";
  if (content === null || content === undefined) return "";
  const t = typeof content;
  if (t === "string" || t === "number" || t === "boolean") return String(content);
  if (Array.isArray(content)) {
    return content.map((c) => extractToolResultText(c, depth + 1)).join("\n");
  }
  if (t === "object") {
    const obj = content as Record<string, unknown>;
    // 白名单键优先取叶子(TextContent 形如 {type:"text",text:...})
    for (const key of ["text", "content", "output_text", "outputText", "value"]) {
      if (key in obj) {
        const v = obj[key];
        if (typeof v === "string" && v.trim()) return v;
        if (v !== null && typeof v === "object") return extractToolResultText(v, depth + 1);
      }
    }
    if ((obj as any).type === "image" || (obj as any).type === "input_image") return "[image]";
    try { return JSON.stringify(obj); } catch { return ""; }
  }
  return "";
}

/** 从一条消息 content 提取可读文本(string 或 TextContent[] 的 text 字段) */
export function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (p && typeof p === "object" ? String((p as any).text ?? (p as any).thinking ?? (p as any).reasoning_content ?? "") : ""))
      .join("\n");
  }
  return "";
}

/** 从 agent_end event.messages 提取本轮真实 user prompt(末条 role=user) */
export function lastUserMessageText(messages: any[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || m.role !== "user") continue;
    const c = m.content;
    if (typeof c === "string") return c;
    if (Array.isArray(c)) {
      const t = c.map((p: any) => (p && typeof p === "object" ? String(p.text ?? "") : "")).join(" ").trim();
      if (t) return t;
    }
  }
  return "";
}

// ── 2026-09-15 n8 第十四轮：轨迹「工具侧原文保真」（消除三处静默 slice）──
// 原实现：input `.slice(0,180)` / output `.slice(0,640)` / `maxEntries=24` 超限 `shift()` 静默丢。
// 后果实证（本轮窗口 10 回合 40 条工具调用）：**22/40 条 input 恰为 180c** —— guard 下发 n6
// 第6/10条新要求的 coms_send、worker 的 edit trade.py、/api/step 的 body(session_id+决策 JSON)
// 全被砍成摘要 ⇒ 执行层证据（报价 vs 成交价、success:false、越界）事后不可复核，
// 「反传拿什么判 reward」「轨迹是否完整」失去唯一可核对的物证。
// 现约定（与 0405809 轨迹 userPrompt/answer 同构，单一事实来源）：
//   ① 单条不静默截断 —— 超 cap 才截，且尾部显式标注 `…[+Nc/Nc]`（被截量可读）；
//   ② 条目溢出不再静默 shift —— 记 droppedOldest 并在首行插入 `⛔dropped_oldest:N` 标记；
//   ③ 返回 stats（截断/丢弃计数、原始字符总量），随轨迹行落盘供审计与门禁。
export const TOOL_INPUT_CAP = 4000;
export const TOOL_OUTPUT_CAP = 8000;
export const TOOL_MAX_ENTRIES = 200;

export interface ToolsFidelityStats {
  /** 真实工具条目数（不含 dropped 标记行） */
  entries: number;
  inputTruncated: number;
  outputTruncated: number;
  droppedOldest: number;
  /** 截断前的原始 input/output 字符总量 */
  inputChars: number;
  outputChars: number;
}

/** 单条裁剪：超 cap 才截，且显式标注被截字符数（禁静默 slice） */
export function clipWithMark(s: string, cap: number): string {
  return s.length > cap ? `${s.slice(0, cap)}…[+${s.length - cap}c/${s.length}c]` : s;
}

/** 从 agent_end event.messages 重建工具链(▶tool in / ◀out 成对) + 保真统计（推荐入口） */
export function rebuildToolsFromMessagesDetailed(
  messages: any[],
  opts: { maxEntries?: number; inputCap?: number; outputCap?: number } = {},
): { lines: string[]; stats: ToolsFidelityStats } {
  const maxEntries = opts.maxEntries ?? TOOL_MAX_ENTRIES;
  const inputCap = opts.inputCap ?? TOOL_INPUT_CAP;
  const outputCap = opts.outputCap ?? TOOL_OUTPUT_CAP;
  const tools: string[] = [];
  const stats: ToolsFidelityStats = { entries: 0, inputTruncated: 0, outputTruncated: 0, droppedOldest: 0, inputChars: 0, outputChars: 0 };
  try {
    for (const m of messages) {
      if (!m || typeof m !== "object") continue;
      if (m.role === "assistant" && Array.isArray(m.content)) {
        for (const p of m.content) {
          if (p && typeof p === "object" && (p as any).type === "toolCall") {
            const nm = String((p as any).name || "?");
            let raw: string;
            try { raw = JSON.stringify((p as any).input ?? (p as any).arguments ?? {}); } catch { raw = String((p as any).input ?? ""); }
            raw = raw.replace(/\s+/g, " ");
            stats.inputChars += raw.length;
            if (raw.length > inputCap) stats.inputTruncated++;
            tools.push(`▶${nm} in:${clipWithMark(raw, inputCap)}`);
          }
        }
      } else if (m.role === "toolResult") {
        const flat = extractToolResultText(m.content).replace(/\s+/g, " ").trim();
        stats.outputChars += flat.length;
        if (flat.length > outputCap) stats.outputTruncated++;
        const out = clipWithMark(flat, outputCap);
        const last = tools.length ? tools[tools.length - 1] : "";
        if (last.startsWith("▶") && !last.includes("→ out:")) {
          tools[tools.length - 1] = `${last} → out:${out}`;
        } else {
          tools.push(`◀out:${out}`);
        }
      }
      if (tools.length > maxEntries) {
        tools.shift();
        stats.droppedOldest++;
      }
    }
  } catch { /* 提取失败返回空 */ }
  stats.entries = tools.length;
  if (stats.droppedOldest > 0) tools.unshift(`⛔dropped_oldest:${stats.droppedOldest}`);
  return { lines: tools, stats };
}

/** 从 agent_end event.messages 重建工具链(▶tool in / ◀out 成对), 等价于 tool_call+tool_result 增量缓冲 */
export function rebuildToolsFromMessages(messages: any[], maxEntries = TOOL_MAX_ENTRIES): string[] {
  return rebuildToolsFromMessagesDetailed(messages, { maxEntries }).lines;
}

export interface ThinkingFidelityStats { chars: number; truncated: boolean; }

/** 从 messages 提取 AI 思考链 + 保真统计（尾部保留 maxChars，但截断可观测） */
export function rebuildThinkingFromMessagesDetailed(
  messages: any[],
  maxChars = 1400,
): { text: string; stats: ThinkingFidelityStats } {
  const thoughts: string[] = [];
  for (const m of messages) {
    if (!m || m.role !== "assistant") continue;
    const c = m.content;
    if (typeof c === "string") {
      if (c.trim()) thoughts.push(c);
    } else if (Array.isArray(c)) {
      for (const p of c) {
        if (!p || typeof p !== "object") continue;
        const t = String((p as any).thinking ?? (p as any).reasoning_content ?? "").trim();
        if (t) thoughts.push(t);
      }
    }
  }
  const joined = thoughts.map((t) => t.replace(/\s+/g, " ")).join(" ⏎ ");
  const truncated = joined.length > maxChars;
  return { text: truncated ? joined.slice(-maxChars) : joined, stats: { chars: joined.length, truncated } };
}

/** 从 messages 提取 AI 思考链(thinking/reasoning_content), 单数据源替代 message_update 拼装 */
export function rebuildThinkingFromMessages(messages: any[], maxChars = 1400): string {
  return rebuildThinkingFromMessagesDetailed(messages, maxChars).text;
}

/** 整轮快照: 从 agent_end event.messages 一次提取全部轨迹/执行上下文要素 */
export function roundSnapshot(messages: any[]) {
  const arr = Array.isArray(messages) ? messages : [];
  return {
    userPrompt: lastUserMessageText(arr),
    tools: rebuildToolsFromMessages(arr),
    thinking: rebuildThinkingFromMessages(arr),
    toolResultText: extractToolResultText,
  };
}
