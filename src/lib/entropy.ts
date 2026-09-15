export function shannonEntropy(text: string): number {
  const s = String(text || "").replace(/\s+/g, "");
  if (!s) return 0;
  const freq: Record<string, number> = {};
  for (const ch of s) freq[ch] = (freq[ch] || 0) + 1;
  const n = s.length;
  let h = 0;
  for (const k of Object.keys(freq)) { const p = freq[k] / n; h -= p * Math.log2(p); }
  return h;
}

export function wordEntropy(text: string): number {
  const words = String(text || "").match(/[\u4e00-\u9fff]+|[a-zA-Z]+/g);
  if (!words || words.length < 2) return 0;
  const freq: Record<string, number> = {};
  for (const w of words) freq[w] = (freq[w] || 0) + 1;
  const n = words.length;
  let h = 0;
  for (const k of Object.keys(freq)) { const p = freq[k] / n; h -= p * Math.log2(p); }
  return h;
}

export function isTruncated(text: string): boolean {
  const s = String(text || "").trim();
  if (!s) return false;
  return /[。，、；！？\.\,\!\?\}\]\)][^。，、；！？\.\,\!\?\}\]\)]{0,2}$/.test(s) === false &&
    /(\.{2,}|…|未完|待续|more|etc\.?|等[。\s]|详见|如上|如前|上述).{0,10}$/i.test(s);
}

/**
 * 会话性时序摘要判据 —— **单一事实来源**（2026-09-15 手动编码）。
 * 背景：本文件与 src/highentropy.ts 各有一份同名实现且语义发散：捕获侧宽松（时间词+会话性谓语）、
 * 写入侧激进（时间词 ∧ 完成类动词，len≤300）。同一段交易 Technique 夹带「本轮…修复了…」即被判为
 * 时序摘要整包丢弃 ⇒ highEntropy 为空 ⇒ 反传无素材（实测 7 次 agent_end 仅 2 次捕获）。
 * 判据重定义为「时间词**后接会话性谓语**」，而非时间词/完成动词单独出现 —— 交易语料天然含
 * 「最近收盘价」「上次交易分数」「2次交易推进」「本轮修复了止损参数」。不引入实例级硬编码。
 */
export function isTemporalSummary(text: string): boolean {
  const s = String(text || "").trim();
  if (!s || s.length > 400) return false;   // 长文=知识正文，不判摘要
  if (/(?:最近|昨天|上周|今天|刚才|刚刚|上次|这次)\s*(?:我们|咱们|讨论|提到|说过|聊过|沟通|复盘过|开会|会话)/.test(s)) return true;
  if (/\b(?:ye?sterday|last\s+(?:week|month|night)|just\s+now|previous\s+session)\b[^.]{0,16}\b(?:we|we've|discussed|talked|mentioned|chat|session)\b/i.test(s)) return true;
  return false;
}

export function isMetaInstruction(text: string): boolean {
  const s = String(text || "").trim();
  if (s.length > 200) return false;
  return /^(你|请|不要|必须|禁止|应该|可以|需要|注意|记住|确保|检查|确认|使用|调用|执行|运行|启动|重启)/.test(s) &&
    s.length < 120;
}
