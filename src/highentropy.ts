import { distillNodeName, sharesKeywordWithContent } from "./name_distill.ts";

export interface HighEntropyCrystal {
  name: string;
  content: string;
  raw: string;
  ok: boolean;
  reason?: string;
}

function compressNodeName(content: string): string {
  // Keyword-distilled name (name_distill.ts) — a retrieval key, not a prefix cut.
  return distillNodeName(content);
}

function shannonEntropy(text: string): number {
  const s = String(text || "");
  if (s.length < 2) return 0;
  const freq = new Map<string, number>();
  for (let i = 0; i < s.length - 1; i++) {
    const bigram = s.slice(i, i + 2);
    freq.set(bigram, (freq.get(bigram) || 0) + 1);
  }
  const n = s.length - 1;
  let entropy = 0;
  for (const count of freq.values()) {
    const p = count / n;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

function wordEntropy(text: string): number {
  const raw = String(text || "").toLowerCase();
  const words = raw.split(/[\s,，。！？、:：;；()\[\]{}<>"'`/\\|+=_-]+/).filter(w => w.length > 1);
  const cjkRuns = raw.match(/[\u4e00-\u9fff]{2,}/g) || [];
  for (const run of cjkRuns) {
    for (let i = 0; i < run.length - 1; i++) words.push(run.slice(i, i + 2));
  }
  if (words.length < 3) return 0;
  const freq = new Map<string, number>();
  let total = 0;
  for (const w of words) { freq.set(w, (freq.get(w) || 0) + 1); total++; }
  let entropy = 0;
  for (const count of freq.values()) { const p = count / total; entropy -= p * Math.log2(p); }
  return entropy;
}

function isTruncated(text: string): boolean {
  const s = String(text || "").trim();
  if (!s) return false;
  if (/(?:[…—,_;:，、…]|\.{3})$/.test(s)) return true;
  const cjkCount = (s.match(/[\u4e00-\u9fff]/g) || []).length;
  if (cjkCount > 0 && cjkCount / s.length > 0.6 && /(?:因为|如果|需要|通过|以及|并且|或者|但|而|与|和|及|的|地|得|了)$/.test(s)) return true;
  if (/\b(a|an|the|in|on|at|to|for|of|and|or|but|via|per|by|from|with|not|is|are|was|were|has|had|when|if|as)\s*$/i.test(s)) return true;
  return false;
}

function isTemporalSummary(text: string): boolean {
  const s = String(text || "");
  if (/最近|昨天|上周|今天|刚才|刚刚|上次|这次|ye?sterday|last\s+(week|month|night)|today|just\s+now|this\s+(morning|time)|previous\s+session/i.test(s)) return true;
  if (/\d+次缺失|\d+次|373次|第\d+次/i.test(s)) return true;
  return false;
}

function isMetaInstruction(text: string): boolean {
  const s = String(text || "");
  if (/^(Trigger\+gain|Rule\/tradeoff):\s*(Prefer:\s*\.\.\.|avoid vague memory|keep reusable payoff|$)/i.test(s.trim())) return true;
  if (/^(Rule\/tradeoff|Principle|Guideline):\s*$/i.test(s.trim())) return true;
  return false;
}

function completeContent(text: string, maxLen: number): string {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  if (s.length <= maxLen) return s;
  const sentenceEnd = s.lastIndexOf("。", maxLen);
  if (sentenceEnd > maxLen * 0.6) return s.slice(0, sentenceEnd + 1);
  const period = s.lastIndexOf(". ", maxLen);
  if (period > maxLen * 0.6) return s.slice(0, period + 1);
  const space = s.lastIndexOf(" ", maxLen);
  if (space > maxLen * 0.6) return s.slice(0, space);
  const comma = Math.max(s.lastIndexOf("，", maxLen), s.lastIndexOf("、", maxLen));
  if (comma > maxLen * 0.6) return s.slice(0, comma + 1);
  return s.slice(0, maxLen);
}

function isNgramFragmentContent(content: string): boolean {
  const s = String(content || "").replace(/\s+/g, " ").trim();
  if (!s) return true;
  if (/(?:^|[\s;；|])(?:[\u4e00-\u9fff]{2}\s+){2,}[\u4e00-\u9fff]{2}(?:[\s;；|]|$)/.test(s)) return true;
  if (/(?:^|[\s;；|])([\u4e00-\u9fff]{2})\s+([\u4e00-\u9fff]{2})(?:[\s;；|]|$)/.test(s)) {
    const m = s.match(/(?:^|[\s;；|])([\u4e00-\u9fff]{2})\s+([\u4e00-\u9fff]{2})(?:[\s;；|]|$)/);
    if (m && m[1][1] === m[2][0]) return true;
  }
  const parts = s.split(/[;；|]/).map((p) => p.trim()).filter(Boolean);
  if (parts.length >= 3) {
    const shortParts = parts.filter((p) => p.length < 36).length;
    const tinyParts = parts.filter((p) => p.length < 12).length;
    const repeatedStarts = new Set(parts.map((p) => p.split(/\s+/).slice(0, 2).join(" "))).size;
    if (shortParts / parts.length > 0.75 && repeatedStarts <= Math.ceil(parts.length * 0.5)) return true;
    if (parts.length >= 4 && tinyParts >= 3) return true;

    let ladderPairs = 0;
    let duplicateTokenCount = 0;
    const allTokens: string[] = [];
    const tokenized = parts.map((p) => p.toLowerCase().split(/[\s,，。！？、:：()\[\]{}<>"'`/\\+=_-]+/).filter((w) => w.length > 1));
    for (const toks of tokenized) allTokens.push(...toks);
    for (let i = 0; i < tokenized.length - 1; i++) {
      const a = tokenized[i];
      const b = tokenized[i + 1];
      if (a.length < 2 || b.length < 2) continue;
      const bs = new Set(b);
      const overlap = a.filter((t) => bs.has(t)).length / Math.min(a.length, b.length);
      const aText = a.join(" ");
      const bText = b.join(" ");
      if (overlap >= 0.6 || aText.includes(bText) || bText.includes(aText)) ladderPairs++;
    }
    const counts = new Map<string, number>();
    for (const t of allTokens) counts.set(t, (counts.get(t) || 0) + 1);
    for (const n of counts.values()) if (n > 1) duplicateTokenCount += n - 1;
    if (ladderPairs >= 2) return true;
    if (allTokens.length >= 8 && duplicateTokenCount / allTokens.length >= 0.35 && parts.length >= 4) return true;
  }
  return false;
}

function validateKnowledgeCrystal(raw: string, targetLayer?: number): { ok: boolean; content: string; reason?: string } {
  const content = String(raw || "").replace(/\s+/g, " ").trim();
  if (!content) return { ok: false, content, reason: "empty" };
  const minLen = targetLayer === 0 ? 18 : 28;
  if (content.length < minLen) return { ok: false, content, reason: "too_short" };
  if (content.length > 240) return { ok: false, content, reason: "too_long_session_summary" };
  const rawOps = /(HTTP\s+20\d|localhost:\d+|PID\s*\d+|nohup|pkill|ps aux|curl\s|tail\s-|log tail|Serving UI|Templates at|Output at|bridge\s*已?重启|重启\s*nbeat\s*UI)/i;
  if (rawOps.test(content)) return { ok: false, content, reason: "raw_operational_trace" };
  if (isTemporalSummary(content)) return { ok: false, content, reason: "temporal_session_summary" };
  if (isTruncated(content)) return { ok: false, content, reason: "truncated_mid_thought" };
  if (isMetaInstruction(content)) return { ok: false, content, reason: "meta_instruction_not_knowledge" };
  const charEntropy = shannonEntropy(content);
  if (charEntropy < 3.5) return { ok: false, content, reason: `low_entropy(${charEntropy.toFixed(1)})` };
  const wEntropy = wordEntropy(content);
  if (wEntropy < 2.5) return { ok: false, content, reason: `low_word_entropy(${wEntropy.toFixed(1)})` };
  const transferable = /(→|->|=>|导致|因为|原因|修复|避免|优先|回退|兼容|依赖|版本|导出|缺少|模块|解析|规则|原则|模式|应该|必须|when|if|若|如果|avoid|prefer|should|must|rule|fallback|compat|dependency|version|export|module|resolve|import|routing|propagate|backward|forward|reward|edge|node|context|threshold|workflow|mismatch|relevance|overwrite|retarget|penalize|summary|summarize|timeline|blocker|entrypoint|evidence|progress|recall|risk|benefit|tradeoff|cost|quality|failure|success|gain|loss|趋利|避害|取舍|收益|风险|代价|高熵)/i;
  if (!transferable.test(content)) return { ok: false, content, reason: "not_transferable_experience" };
  return { ok: true, content };
}

export function parseHighEntropyCrystal(text: string): HighEntropyCrystal {
  const rawText = String(text || "");
  const match = rawText.match(/<HighEntropy>\s*([\s\S]*?)\s*<\/HighEntropy>/i);
  const rawBlock = match?.[1]?.trim() || "";
  const raw = rawBlock.replace(/\s+/g, " ").trim();
  if (!raw) return { name: "", content: "", raw, ok: false, reason: "missing" };
  if (rawBlock.includes("<TextronSkill") || rawBlock.includes("historical Textron network prior")) {
    return { name: "", content: "", raw, ok: false, reason: "echoed_textron_prior" };
  }

  let name = "";
  let content = "";
  for (const candidate of [rawBlock, raw]) {
    try {
      const parsed = JSON.parse(candidate);
      name = String(parsed?.name || parsed?.Name || "").trim();
      content = String(parsed?.content || parsed?.Content || parsed?.rule || parsed?.insight || "").trim();
      if (content) break;
    } catch {}
  }
  if (!content) {
    const nameMatch = rawBlock.match(/(?:^|[;；|\n])\s*(?:name|Name|名称|节点名)\s*[:：]\s*([\s\S]*?)(?=(?:[;；|\n]\s*(?:content|Content|内容|规则)\s*[:：])|$)/);
    const contentMatch = rawBlock.match(/(?:^|[;；|\n])\s*(?:content|Content|内容|规则)\s*[:：]\s*([\s\S]{8,220})/);
    if (nameMatch) name = nameMatch[1].replace(/\s+/g, " ").trim();
    if (contentMatch) content = contentMatch[1].trim();
  }
  if (!content) {
    const compactContentMatch = raw.match(/(?:^|[;；|]|\s)(?:content|Content|内容|规则)\s*[:：]\s*([\s\S]{8,220})/);
    if (compactContentMatch) content = compactContentMatch[1].trim();
  }
  if (!content) content = raw.replace(/^(?:name|Name|名称|节点名)\s*[:：][\s\S]*?(?=(?:content|Content|内容|规则)\s*[:：]|$)/i, "").trim();
  content = completeContent(content.replace(/^content\s*[:：]\s*/i, ""), 180);
  name = completeContent(name || compressNodeName(content), 64);

  if (isNgramFragmentContent(content)) return { name, content, raw, ok: false, reason: "ngram_fragment" };
  if (isTemporalSummary(content)) return { name, content, raw, ok: false, reason: "temporal_summary" };
  const validation = validateKnowledgeCrystal(content);
  if (!validation.ok) return { name, content, raw, ok: false, reason: validation.reason };
  // LLM names that share no keywords with content are generic summaries
  // (e.g. "语法检查不等于可运行") — replace with distilled content keywords.
  if (isNgramFragmentContent(name) || !sharesKeywordWithContent(name, validation.content)) {
    name = compressNodeName(validation.content);
  }
  return { name: completeContent(name, 64), content: validation.content, raw, ok: true };
}

export function extractHighEntropy(text: string): string {
  const crystal = parseHighEntropyCrystal(text);
  if (!crystal.ok) return "";
  return `Name: ${crystal.name}\nContent: ${crystal.content}`;
}

export function assistantMessageText(message: any): string {
  if (message?.role !== "assistant") return "";
  const parts = message.content;
  if (typeof parts === "string") return parts;
  if (Array.isArray(parts)) return parts.map((p: any) => p?.text || p?.content || p?.value || "").join("\n");
  return parts ? JSON.stringify(parts) : "";
}

/** Read the final crystal from agent_end.event.messages, newest assistant first. */
export function extractLatestHighEntropyFromMessages(messages: any[]): string {
  const list = Array.isArray(messages) ? messages : [];
  for (let i = list.length - 1; i >= 0; i--) {
    const extracted = extractHighEntropy(assistantMessageText(list[i]));
    if (extracted) return extracted;
  }
  return "";
}
