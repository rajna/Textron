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

export function isTemporalSummary(text: string): boolean {
  const s = String(text || "").trim();
  if (s.length > 300) return false;
  const temporalMarkers = /(上次|上次对话|上一轮|之前|刚才|刚刚|今天|昨天|本周|本轮|当前|目前进展|目前为止)/;
  const summaryOps = /(测试了|完成了|修复了|修改了|更新了|新增了|删除了|重启了|启动了|执行了|运行了)/;
  return temporalMarkers.test(s) && summaryOps.test(s);
}

export function isMetaInstruction(text: string): boolean {
  const s = String(text || "").trim();
  if (s.length > 200) return false;
  return /^(你|请|不要|必须|禁止|应该|可以|需要|注意|记住|确保|检查|确认|使用|调用|执行|运行|启动|重启)/.test(s) &&
    s.length < 120;
}
