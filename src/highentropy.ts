import { distillNodeName, sharesKeywordWithContent } from "./name_distill.ts";
import { HIGH_ENTROPY_TASK_MAX_CHARS, HIGH_ENTROPY_TECHNIQUE_MAX_CHARS } from "./content_limits.ts";

export interface HighEntropyCrystal {
  name: string;
  taskType: string;
  isTask: boolean;
  task: string;
  technique: string;
  /** Backward-compatible alias for technique. */
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
  if (content.length > HIGH_ENTROPY_TECHNIQUE_MAX_CHARS) return { ok: false, content, reason: "too_long_session_summary" };
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
  const empty = (reason: string): HighEntropyCrystal => ({ name: "", taskType: "", isTask: false, task: "", technique: "", content: "", raw, ok: false, reason });
  if (!raw) return empty("missing");
  if (rawBlock.includes("<TextronSkill") || rawBlock.includes("historical Textron network prior")) return empty("echoed_textron_prior");

  let name = "";
  let taskType = "";
  let isTask = false;
  let task = "";
  let technique = "";
  for (const candidate of [rawBlock, raw]) {
    try {
      const parsed = JSON.parse(candidate);
      name = String(parsed?.name || parsed?.Name || "").trim();
      task = String(parsed?.task || parsed?.Task || parsed?.任务 || "").trim();
      technique = String(parsed?.technique || parsed?.Technique || parsed?.技巧 || parsed?.content || parsed?.Content || parsed?.rule || parsed?.insight || "").trim();
      if (technique) break;
    } catch {}
  }

  const readField = (labels: string, nextLabels: string): string => {
    const field = new RegExp(`(?:^|[;；|\\n])\\s*(?:${labels})\\s*[:：]\\s*([\\s\\S]*?)(?=(?:[;；|\\n]\\s*(?:${nextLabels})\\s*[:：])|$)`, "i");
    return rawBlock.match(field)?.[1]?.replace(/\s+/g, " ").trim() || "";
  };
  if (!name) name = readField("name|名称|节点名", "taskType|任务类别|task|任务|technique|技巧|content|内容|规则");
  taskType = readField("taskType|任务类别", "isTask|task|任务|technique|技巧|content|内容|规则").slice(0, 15);
  const isTaskRaw = readField("isTask", "task|任务|technique|技巧|content|内容|规则").toLowerCase();
  isTask = isTaskRaw === "true" || isTaskRaw === "1" || isTaskRaw === "yes";
  if (!task) task = readField("task|任务", "technique|技巧|content|内容|规则");
  if (!technique) technique = readField("technique|技巧|content|内容|规则", "$");
  if (!technique) {
    const compactMatch = raw.match(/(?:^|[;；|]|\s)(?:technique|技巧|content|Content|内容|规则)\s*[:：]\s*([\s\S]{8,500})/i);
    if (compactMatch) technique = compactMatch[1].trim();
  }
  if (!technique) {
    technique = raw
      .replace(/(?:^|[;；|]\s*)(?:name|名称|节点名)\s*[:：][^;；|]*/i, "")
      .replace(/(?:^|[;；|]\s*)(?:task|任务)\s*[:：][^;；|]*/i, "")
      .trim();
  }

  task = completeContent(task.replace(/^(?:task|任务)\s*[:：]\s*/i, ""), HIGH_ENTROPY_TASK_MAX_CHARS);
  technique = completeContent(technique.replace(/^(?:technique|技巧|content|内容)\s*[:：]\s*/i, ""), HIGH_ENTROPY_TECHNIQUE_MAX_CHARS);
  const retrievalSource = `${task} ${technique}`.trim();
  name = completeContent(name || compressNodeName(retrievalSource), 64);

  const invalid = (reason: string): HighEntropyCrystal => ({ name, taskType, isTask, task, technique, content: technique, raw, ok: false, reason });
  if (isNgramFragmentContent(technique)) return invalid("ngram_fragment");
  if (isTemporalSummary(technique)) return invalid("temporal_summary");
  const validation = validateKnowledgeCrystal(technique);
  if (!validation.ok) return invalid(validation.reason || "invalid");
  // Names must carry distinctive terms from the task/technique packet.
  if (isNgramFragmentContent(name) || !sharesKeywordWithContent(name, retrievalSource)) {
    name = compressNodeName(retrievalSource);
  }
  return { name: completeContent(name, 64), taskType, isTask, task, technique: validation.content, content: validation.content, raw, ok: true };
}

export function extractHighEntropy(text: string): string {
  const crystal = parseHighEntropyCrystal(text);
  if (!crystal.ok) return "";
  const taskLine = crystal.task ? `\nTask: ${crystal.task}` : "";
  return `Name: ${crystal.name}${taskLine}\nTechnique: ${crystal.technique}`;
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
