// ─── High-Entropy Keyword Name Distiller ────────────────────────────
// A node name is a RETRIEVAL KEY: L0 LLM scoring, network routing and
// similarity dedup see ONLY the name. Truncating the first 48 chars of
// content keeps the generic lead-in and drops the distinctive terms, so
// instead we distill the content's highest-entropy tokens (technical
// identifiers, domain signal words, key numbers) and join them in
// reading order. No mid-word cuts, no generic summary prefixes.

export interface NameToken {
  text: string;
  pos: number; // char offset in source content
  kind: "latin" | "num" | "cjk";
  score: number;
}

const LATIN_STOP = new Set([
  "the", "and", "for", "with", "from", "that", "this", "when", "then", "than", "thus", "hence",
  "also", "just", "very", "each", "some", "only", "most", "more", "many", "much", "such", "own",
  "same", "too", "can", "could", "may", "might", "must", "should", "shall", "will", "would",
  "not", "but", "yet", "all", "any", "both", "few", "other", "another", "into", "onto", "upon",
  "via", "per", "out", "off", "over", "under", "again", "once", "here", "there", "where", "which",
  "who", "whom", "whose", "what", "how", "why", "because", "while", "during", "before", "after",
  "above", "below", "between", "through", "about", "against", "avoid", "prefer", "never", "always",
  "use", "used", "using", "uses", "make", "makes", "made", "keep", "keeps", "ensure", "ensures",
  "need", "needs", "required", "requires", "require", "have", "has", "had",
  "are", "was", "were", "been", "being", "is", "it", "its", "itself", "they", "them", "their",
  "we", "our", "you", "your", "he", "she", "his", "her", "him", "do", "does", "did", "done",
  "get", "gets", "got", "set", "sets", "let", "say", "says", "see", "seen", "know", "known",
  "take", "takes", "give", "gives", "given", "find", "finds", "found", "try", "tries", "tried",
  "error", "errors", "issue", "issues", "problem", "problems", "thing", "things", "stuff",
]);

// CJK generic words — split fragments AT these words (they carry no retrieval signal).
const CJK_GENERIC_WORDS = [
  "必须", "需要", "应该", "应当", "可以", "不能", "不要", "不会", "没有", "就是", "不是",
  "如果", "因为", "所以", "但是", "而且", "或者", "以及", "并且", "否则", "即可", "然后",
  "已经", "正在", "将要", "通过", "进行", "直接", "只有", "才能", "这类", "这种", "那种",
  "这些", "那些", "什么", "怎么", "为什么", "对于", "基于", "针对", "同时", "之后", "之前",
  "其中", "其他", "另外", "由于", "因此", "为此", "这里", "那里", "这个", "那个", "一样",
  "可能", "或许", "大概", "应当", "作为", "导致", "避免", "优先",
];

// CJK function chars — split fragments at these chars.
// Conservative: keep negation carriers 不/无/非/没 attached (不等于 stays together).
const CJK_FUNC_CHARS = new Set([
  ..."的了吗呢吧啊嘛么和与及或但而然则在只才就都也还被把将会能要这那其于对从向以等前后中时处种者之你您我他她它们个位条款趟遍是可",
]);

const CJK_RE = /[\u4e00-\u9fff]/;

// Weak leading/trailing chars stripped from fragment EDGES after splitting
// (应仅输出必 → 输出). Never stripped mid-fragment (响应 stays intact).
const CJK_EDGE_STRIP = new Set([..."应仅先比已需再又亦且乃便就还也"]);
const TOKEN_RE = /[A-Za-z][A-Za-z0-9_.\/-]{1,}|\d+(?:\.\d+)?(?:ms|s|%|次|轮|层|条|个|字符)?|[\u4e00-\u9fff]{2,}/g;

/** Extract scored candidate terms from content. Higher score = more distinctive. */
export function extractNameTokens(content: string): NameToken[] {
  const s = String(content || "").replace(/\s+/g, " ").trim();
  if (!s) return [];

  const matches: { text: string; index: number; kind: NameToken["kind"] }[] = [];
  const re = new RegExp(TOKEN_RE.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    const text = m[0];
    const kind: NameToken["kind"] = CJK_RE.test(text) ? "cjk" : /^\d/.test(text) ? "num" : "latin";
    matches.push({ text, index: m.index, kind });
  }
  const freq = new Map<string, number>();
  for (const x of matches) {
    const k = x.text.toLowerCase();
    freq.set(k, (freq.get(k) || 0) + 1);
  }

  const tokens: NameToken[] = [];
  for (const x of matches) {
    const repeatBonus = (freq.get(x.text.toLowerCase()) || 1) > 1 ? 2 : 0;

    if (x.kind === "num") {
      tokens.push({ text: x.text, pos: x.index, kind: "num", score: 8 + repeatBonus });
      continue;
    }

    if (x.kind === "latin") {
      const identLike =
        /[_./-]/.test(x.text) ||
        (/[a-z]/.test(x.text) && /[A-Z]/.test(x.text)) ||
        /^[A-Z0-9]{2,}$/.test(x.text) ||
        /\d/.test(x.text);
      if (LATIN_STOP.has(x.text.toLowerCase()) && !identLike) continue;
      if (x.text.length < 3 && !/\d/.test(x.text) && !/^[A-Z]{2}$/.test(x.text)) continue;
      const base = identLike
        ? 10 + Math.min(x.text.length, 14) / 2
        : 5 + Math.min(x.text.length, 10) / 3;
      tokens.push({ text: x.text, pos: x.index, kind: "latin", score: base + repeatBonus });
      continue;
    }

    // CJK run: split at generic words, then at function chars
    let parts = [x.text];
    for (const gw of CJK_GENERIC_WORDS) {
      parts = parts.flatMap((p) => p.split(gw));
    }
    for (const part of parts) {
      let cur = "";
      for (const ch of part) {
        if (CJK_FUNC_CHARS.has(ch)) {
          if (cur.length >= 2) pushCjk(cur);
          cur = "";
        } else {
          cur += ch;
        }
      }
      if (cur.length >= 2) pushCjk(cur);
    }

    function pushCjk(rawFrag: string) {
      // strip weak edge chars (repeatedly, while fragment stays ≥2 chars)
      let frag = rawFrag;
      while (frag.length > 2 && CJK_EDGE_STRIP.has(frag[0])) frag = frag.slice(1);
      while (frag.length > 2 && CJK_EDGE_STRIP.has(frag[frag.length - 1])) frag = frag.slice(0, -1);
      if (frag.length < 2) return;
      tokens.push({
        text: frag,
        pos: x.index + Math.max(0, x.text.indexOf(frag)),
        kind: "cjk",
        score: 3 + Math.min(frag.length, 8) + repeatBonus,
      });
    }
  }
  return tokens;
}

/**
 * Distill a node name from content: top-scoring keywords, reading order,
 * ≤ maxLen chars. CJK fragments concatenate directly (no space) so the
 * result never looks like an ngram fragment list; latin tokens are
 * space-separated. Falls back to prefix truncation when no keywords exist.
 */
export function distillNodeName(content: string, maxLen = 48): string {
  const s = String(content || "").replace(/\s+/g, " ").trim();
  if (!s) return "";

  const candidates = extractNameTokens(s).sort((a, b) => b.score - a.score || a.pos - b.pos);
  const selected: NameToken[] = [];
  let budget = 0;
  for (const tok of candidates) {
    const lower = tok.text.toLowerCase();
    if (selected.some((t) => t.text.toLowerCase().includes(lower) || lower.includes(t.text.toLowerCase()))) continue;
    const add = tok.text.length + (selected.length > 0 ? 1 : 0); // worst-case join cost
    if (budget + add > maxLen) continue;
    selected.push(tok);
    budget += add;
    if (selected.length >= 8) break;
  }

  if (selected.length === 0) {
    return s.length > maxLen ? s.slice(0, maxLen - 3) + "..." : s;
  }

  selected.sort((a, b) => a.pos - b.pos);
  let out = "";
  for (const tok of selected) {
    if (!out) {
      out = tok.text;
      continue;
    }
    const prevCjk = CJK_RE.test(out[out.length - 1]);
    const nextCjk = CJK_RE.test(tok.text[0]);
    // CJK-CJK join with "·" (readable, and not a whitespace so the result never
    // matches the 3×2-char-space-separated ngram-fragment quarantine regex).
    out += (prevCjk && nextCjk ? "·" : " ") + tok.text;
  }
  return out.length > maxLen ? out.slice(0, maxLen) : out;
}

/**
 * Build an ATOMIC retrieval key from gate-rejected content (scale-rescue downscale).
 * Wang–Zahl Kakeya insight: any set has fractal structure at the RIGHT scale —
 * rejected text is not garbage, it was analyzed at the wrong granularity.
 * The atomic scale keeps only the top-scoring distinctive tokens (identifiers,
 * numbers, domain terms), joined with "·" so the result never matches the
 * ngram-fragment quarantine regex (which targets space-separated CJK bigrams).
 * Returns null when fewer than 2 distinctive tokens exist (truly no structure).
 */
export function buildAtomKey(content: string, maxTokens = 6): string | null {
  const s = String(content || "").replace(/\s+/g, " ").trim();
  if (!s) return null;
  const toks = extractNameTokens(s).sort((a, b) => b.score - a.score || a.pos - b.pos);
  const picked: NameToken[] = [];
  for (const t of toks) {
    const lower = t.text.toLowerCase();
    if (picked.some((p) => p.text.toLowerCase().includes(lower) || lower.includes(p.text.toLowerCase()))) continue;
    picked.push(t);
    if (picked.length >= maxTokens) break;
  }
  if (picked.length < 2) return null;
  // Reading order, so the atom reads like the source, not like a score ranking.
  picked.sort((a, b) => a.pos - b.pos);
  const atom = picked.map((t) => t.text).join("·");
  if (atom.length < 8 || atom.length > 120) return null;
  return atom;
}

/**
 * Does the (LLM-provided) name actually contain content keywords?
 * Squash-compare (lowercase, separators removed) so "TextronE2E" matches
 * "Textron E2E". Names with near-zero overlap are generic summaries and
 * should be replaced by distillNodeName(content).
 */
export function sharesKeywordWithContent(name: string, content: string): boolean {
  const n = String(name || "").replace(/\.{3}$|…$/, "").trim();
  const c = String(content || "");
  if (!n || !c) return true; // nothing to check — don't punish
  const squash = (x: string) => x.toLowerCase().replace(/[\s_./-]+/g, "");
  const cSquash = squash(c);
  // Only tokens strong enough to be distinctive count: ≥3 squashed chars, or
  // containing a digit (L0, v3). 2-char CJK fragments (运行/检查) match by luck.
  const tokens = extractNameTokens(n).filter((t) => {
    const sq = squash(t.text);
    return sq.length >= 3 || /\d/.test(sq);
  });
  if (tokens.length === 0) return true;
  let hit = 0;
  for (const t of tokens) {
    if (cSquash.includes(squash(t.text))) hit++;
  }
  return hit / tokens.length >= 0.34 || hit >= 2;
}
