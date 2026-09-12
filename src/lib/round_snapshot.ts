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

/** 从 agent_end event.messages 重建工具链(▶tool in / ◀out 成对), 等价于 tool_call+tool_result 增量缓冲 */
export function rebuildToolsFromMessages(messages: any[], maxEntries = 24): string[] {
  const tools: string[] = [];
  try {
    for (const m of messages) {
      if (!m || typeof m !== "object") continue;
      if (m.role === "assistant" && Array.isArray(m.content)) {
        for (const p of m.content) {
          if (p && typeof p === "object" && (p as any).type === "toolCall") {
            const nm = String((p as any).name || "?");
            const inp = JSON.stringify((p as any).input ?? (p as any).arguments ?? {}).replace(/\s+/g, " ").slice(0, 180);
            tools.push(`▶${nm} in:${inp}`);
          }
        }
      } else if (m.role === "toolResult") {
        const flat = extractToolResultText(m.content).replace(/\s+/g, " ").trim();
        const last = tools.length ? tools[tools.length - 1] : "";
        if (last.startsWith("▶") && !last.includes("→ out:")) {
          tools[tools.length - 1] = `${last} → out:${flat.slice(0, 640)}`;
        } else {
          tools.push(`◀out:${flat.slice(0, 640)}`);
        }
      }
      if (tools.length > maxEntries) tools.shift();
    }
  } catch { /* 提取失败返回空 */ }
  return tools;
}

/** 从 messages 提取 AI 思考链(thinking/reasoning_content), 单数据源替代 message_update 拼装 */
export function rebuildThinkingFromMessages(messages: any[], maxChars = 1400): string {
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
  return thoughts.map((t) => t.replace(/\s+/g, " ")).join(" ⏎ ").slice(-maxChars);
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
