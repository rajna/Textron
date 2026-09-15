#!/usr/bin/env node
/**
 * collect_trajectories.mjs —— 从 pi 会话日志（真相源）确定性抽取「任务-行动-反馈」轨迹
 *
 * 为什么要有它：扩展 hook 侧落盘曾丢字段（answer 空、HighEntropy 只剩布尔、任务与反馈不配对），
 * 而 pi 的 session jsonl 保存了**全部原文**（user text / assistant text / thinking / 全部
 * toolCall 与 toolResult / 时间戳）。本脚本只做「读取+切分+配对」，不做任何判据、不调 LLM，
 * 因此可随时重跑、结果可核对、幂等（按 session+turnIndex 去重）。
 *
 * 用法:
 *   node scripts/collect_trajectories.mjs --today                 # 处理今天有更新的会话
 *   node scripts/collect_trajectories.mjs --session <path.jsonl>  # 单个会话
 *   node scripts/collect_trajectories.mjs --dir <sessions子目录> --all
 *   node scripts/collect_trajectories.mjs --today --out ~/.textron/_trajectories_v2.jsonl
 * 输出: 每轮一行 JSON（与 _trajectories.jsonl 的 turn 行兼容，含 respondsTo/highEntropy 等字段）
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const HOME = os.homedir();
const SESS_ROOT = path.join(HOME, ".pi/agent/sessions");
const has = (n) => process.argv.includes(`--${n}`);
function arg(name, def = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return v && !v.startsWith("--") ? v : true;
}
const OUT = String(arg("out", path.join(HOME, ".textron/_trajectories_v2.jsonl")));
const RAW_CAP = Number(arg("raw-cap", 200000));

const blocksOf = (m) => (Array.isArray(m?.content) ? m.content : []);
const textOf = (m) => blocksOf(m).filter((b) => b?.type === "text").map((b) => b.text || "").join("\n");
const thinkingOf = (m) => blocksOf(m).filter((b) => b?.type === "thinking").map((b) => b.thinking || b.text || "").join("\n");

/** 一条会话 → 按 user 消息切分成轮次 */
function splitTurns(rows, sessionId, file) {
  const turns = [];
  let cur = null;
  for (const r of rows) {
    if (r.type === "message") {
      const m = r.message || {};
      const role = m.role;
      if (role === "user") {
        cur = { sessionId, file, turnIndex: turns.length, ts: r.timestamp, task: textOf(m), actions: [], toolCalls: [], toolResults: [], thinking: [] };
        turns.push(cur);
      } else if (cur && role === "assistant") {
        cur.actions.push({ ts: r.timestamp, text: textOf(m), error: m.errorMessage || null, stopReason: m.stopReason || null, model: m.model || null });
        const th = thinkingOf(m);
        if (th) cur.thinking.push(th);
        for (const b of blocksOf(m)) {
          if (b?.type === "toolCall") cur.toolCalls.push({ ts: r.timestamp, name: b.name, args: b.arguments });
        }
      } else if (cur && role === "toolResult") {
        cur.toolResults.push({ ts: r.timestamp, name: m.toolName, isError: !!m.isError, text: textOf(m) });
      }
    } else if (r.type === "custom" && cur && /textron|local-coms/.test(String(r.customType || ""))) {
      cur.textronEvents = cur.textronEvents || [];
      cur.textronEvents.push({ ts: r.timestamp, type: r.customType, action: (r.data || {}).action || null });
    }
  }
  return turns;
}

/** 轮次 → 轨迹行（任务=本轮 user；行动=本轮最终 assistant 正文+工具调用；反馈=下一轮 user） */
function toRecord(t, next, sessionId) {
  const lastText = [...t.actions].reverse().map((a) => a.text).find((x) => x && x.trim()) || "";
  const heMatch = lastText.match(/<HighEntropy>([\s\S]*?)<\/HighEntropy>/);
  const clip = (s) => {
    const t2 = String(s || "");
    return t2.length > RAW_CAP ? { text: t2.slice(0, RAW_CAP), chars: t2.length, truncated: true } : { text: t2, chars: t2.length, truncated: false };
  };
  const task = clip(t.task);
  const action = clip(lastText);
  const feedback = clip(next ? next.task : "");
  return {
    kind: "turn", v: 2,
    session: sessionId, turnId: `${sessionId.slice(0, 8)}-t${String(t.turnIndex).padStart(3, "0")}`,
    ts: t.ts, tsEnd: (t.actions[t.actions.length - 1] || {}).ts || t.ts,
    respondsTo: t.turnIndex > 0 ? `${sessionId.slice(0, 8)}-t${String(t.turnIndex - 1).padStart(3, "0")}` : null,
    // ── 三元组（原文，不静默截断）──
    userPrompt: task.text, userPromptChars: task.chars, userPromptTruncated: task.truncated,
    answer: action.text, answerChars: action.chars, answerTruncated: action.truncated,
    feedback: feedback.text, feedbackChars: feedback.chars,
    // ── 行动全量：工具链与思考（原文）──
    toolCalls: t.toolCalls.map((c) => ({ name: c.name, args: clip(JSON.stringify(c.args)).text })),
    toolResults: t.toolResults.map((c) => ({ name: c.name, isError: c.isError, chars: c.text.length, head: c.text.slice(0, 400) })),
    thinking: clip(t.thinking.join("\n")).text,
    thinkingChars: t.thinking.join("\n").length,
    // ── 学到的东西（本体内联，不再只存布尔）──
    hasHighEntropy: !!heMatch,
    ...(heMatch ? { highEntropy: { raw: clip(heMatch[1]).text, chars: heMatch[1].length } } : {}),
    counts: { assistantMsgs: t.actions.length, toolCalls: t.toolCalls.length, toolResults: t.toolResults.length, errors: t.actions.filter((a) => a.error).length },
    textronEvents: t.textronEvents || [],
  };
}

function sessionsToday() {
  const out = [];
  const cutoff = Date.now() - 24 * 3600 * 1000;
  for (const dir of fs.readdirSync(SESS_ROOT)) {
    const p = path.join(SESS_ROOT, dir);
    if (!fs.statSync(p).isDirectory()) continue;
    for (const f of fs.readdirSync(p)) {
      if (!f.endsWith(".jsonl")) continue;
      const fp = path.join(p, f);
      if (fs.statSync(fp).mtimeMs >= cutoff) out.push(fp);
    }
  }
  return out;
}
function sessionsIn(dir) {
  return fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")).map((f) => path.join(dir, f));
}

(function main() {
  const mode = has("session") || arg("session") ? "one" : has("dir") || arg("dir") ? "dir" : "today";
  let files =
    mode === "one" ? [String(arg("session")).replace(/^~/, HOME)]
    : mode === "dir" ? sessionsIn(String(arg("dir")).replace(/^~/, HOME))
    : sessionsToday();
  if (has("all") && mode === "today") files = files.slice(0, 1000);

  // 幂等：已收集的 (session,turnId) 跳过
  const seen = new Set();
  try {
    for (const line of fs.readFileSync(OUT, "utf-8").split("\n")) {
      if (!line.trim()) continue;
      try { const o = JSON.parse(line); seen.add(`${o.session}|${o.turnId}`); } catch {}
    }
  } catch {}
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const fh = fs.openSync(OUT, "a");

  let totals = { files: 0, turns: 0, fresh: 0, withAction: 0, withFeedback: 0, withToolCalls: 0, withHE: 0, emptyAction: 0 };
  for (const file of files) {
    let rows = [];
    for (const l of fs.readFileSync(file, "utf-8").split("\n")) {
      if (!l.trim()) continue;
      try { rows.push(JSON.parse(l)); } catch {}
    }
    const sessionId = path.basename(file).replace(/\.jsonl$/, "").split("_").pop();
    const turns = splitTurns(rows, sessionId, path.basename(file));
    totals.files++; totals.turns += turns.length;
    turns.forEach((t, i) => {
      const rec = toRecord(t, turns[i + 1], sessionId);
      if (rec.answerChars > 0) totals.withAction++; else totals.emptyAction++;
      if (rec.feedbackChars > 0) totals.withFeedback++;
      if (rec.counts.toolCalls > 0) totals.withToolCalls++;
      if (rec.hasHighEntropy) totals.withHE++;
      if (seen.has(`${rec.session}|${rec.turnId}`)) return;
      seen.add(`${rec.session}|${rec.turnId}`);
      fs.writeSync(fh, JSON.stringify(rec) + "\n");
      totals.fresh++;
    });
  }
  fs.closeSync(fh);
  console.log(`[收集] 会话文件 ${totals.files} 个 → 轮次 ${totals.turns}（新写入 ${totals.fresh}）`);
  console.log(`[完整度] 有正文 ${totals.withAction} / 空正文 ${totals.emptyAction} ｜ 有反馈配对 ${totals.withFeedback} ｜ 有工具调用 ${totals.withToolCalls} ｜ 含 HighEntropy ${totals.withHE}`);
  console.log(`[输出] ${OUT}`);
})();
