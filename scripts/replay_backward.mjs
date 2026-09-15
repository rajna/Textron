#!/usr/bin/env node
/**
 * replay_backward.mjs —— 从已落盘的轨迹原文**手动**重放一次反传（独立于 pi 扩展，不依赖 hook）
 *
 * 为什么需要它：轨迹原文与配对必须由系统保存好，而「何时/是否调用 LLM 反传」应当可以人工触发。
 * 本脚本只做三件事：①读原文 ②拼出「任务-行动-反馈」三元组 ③调用 LLM 并把 raw+parsed 写盘。
 *
 * 用法:
 *   node scripts/replay_backward.mjs --list 8                 # 列出最近轨迹（含配对情况）
 *   node scripts/replay_backward.mjs --last                   # 取最近一条完整配对的轨迹重放
 *   node scripts/replay_backward.mjs --turn-id <turnId>       # 指定轨迹
 *   node scripts/replay_backward.mjs --last --print-prompt    # 只打印 prompt（自己拿去喂任何 LLM）
 *   node scripts/replay_backward.mjs --last --dry-run         # 不调 LLM
 *   node scripts/replay_backward.mjs --last --apply           # 调 LLM 并把 node_updates 落盘到节点
 * 环境: --model / --provider 可覆盖；apiKey 依次取 --api-key / $DEEPSEEK_API_KEY / ~/.pi/agent/auth.json
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const HOME = os.homedir();
const TEXTRON = process.env.TEXTRON_HOME || path.join(HOME, ".textron");
const TRAJ = path.join(TEXTRON, "_trajectories.jsonl");

function arg(name, def = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0) return process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : true;
  return def;
}
const has = (n) => process.argv.includes(`--${n}`);

function readTraj() {
  if (!fs.existsSync(TRAJ)) return [];
  const out = [];
  for (const line of fs.readFileSync(TRAJ, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* 坏行跳过 */ }
  }
  return out;
}
const textOf = (v) => (typeof v === "string" ? v : v?.text || "");

function readNetwork(netName = "stock_alpha") {
  const dir = path.join(TEXTRON, netName);
  const goalPath = path.join(dir, "hyperparams.json");
  let goal = "";
  try { goal = String(JSON.parse(fs.readFileSync(goalPath, "utf-8")).goal || ""); } catch {}
  const nodes = [];
  if (fs.existsSync(dir)) {
    for (const layer of fs.readdirSync(dir).filter((d) => /^layer_\d+$/.test(d)).sort()) {
      const li = Number(layer.split("_")[1]);
      for (const f of fs.readdirSync(path.join(dir, layer)).filter((x) => /^node_\d+\.html$/.test(x)).sort()) {
        const html = fs.readFileSync(path.join(dir, layer, f), "utf-8");
        const content = (html.match(/<content>\s*([\s\S]*?)\s*<\/content>/) || [, ""])[1].trim();
        if (!content) continue;
        nodes.push({ id: `L${li}::${f.replace(".html", "")}`, content: content.replace(/\s+/g, " ").slice(0, 900) });
      }
    }
  }
  return { goal, nodes, dir };
}

function pickTurn(turns) {
  const id = arg("turn-id");
  if (id && id !== true) return turns.find((t) => t.turnId === id) || null;
  const idx = arg("index");
  if (idx && idx !== true) return turns[Number(idx)] || null;
  return turns[turns.length - 1] || null;   // --last 默认
}

/** 任务-行动-反馈 三元组：按 respondsTo 链 join，不用任何关键词启发式。 */
function pairTriple(turns, turn) {
  const pos = turns.findIndex((t) => t.turnId === turn.turnId);
  const next = pos >= 0 ? turns[pos + 1] : null;
  const explicit = arg("feedback-from");
  const feedbackTurn = explicit && explicit !== true ? turns.find((t) => t.turnId === explicit) : next;
  return {
    task: textOf(turn.userPrompt),
    action: textOf(turn.answer),
    thinking: String(turn.thinking || ""),
    tools: String(turn.tools || ""),
    feedback: feedbackTurn ? textOf(feedbackTurn.userPrompt) : "",
    feedbackTurnId: feedbackTurn?.turnId || null,
    highEntropy: turn.highEntropy || null,
    hasHighEntropy: !!turn.hasHighEntropy,
    backward: turn.backward || null,
  };
}

function buildPrompt({ goal, nodes, triple }) {
  const existing = nodes.map((n) => `${n.id}: ${n.content}`).join("\n") || "(none)";
  return `你是 Textron 网络的语义反传判官。基于「任务-行动-反馈」三元组，蒸馏可复用的领域经验并更新网络节点。

[网络 goal]
${goal}

[现有节点]
${existing}

[任务]
${String(triple.task).slice(0, 6000)}

[行动/结论]
${String(triple.action).slice(0, 6000)}

[反馈]
${String(triple.feedback).slice(0, 3000)}

规则：
- 对每个需要更新的节点给出 keep（保留旧要点）/ content（新增或改写要点，≤1000 字）/ drop（删除的旧要点或证伪依据）三段式，mode 取 replace 或 merge。
- 冗余（>15% 重叠）用 node_updates 更新而不是 add_nodes。
- 失败→"避免 X → 优先 Y"；成功→写入获胜机制。
- 若本轮无可沉淀内容，返回空 node_updates 并说明理由。

只输出一个 JSON 对象：
{"reasoning":"≤120字","node_updates":{"L0::node_0":{"mode":"merge|replace","keep":"…","content":"…","drop":"…"}},"add_nodes":[],"node_actions":[{"action":"keep|merge|drop","target":"L0::node_0","rationale":"…"}]}`;
}

async function callLLM(prompt) {
  const provider = arg("provider", "deepseek");
  const model = arg("model", "deepseek-flash");
  let key = arg("api-key");
  if (!key || key === true) key = process.env.DEEPSEEK_API_KEY || "";
  if (!key) {
    try { key = JSON.parse(fs.readFileSync(path.join(HOME, ".pi/agent/auth.json"), "utf-8"))[provider].key; } catch {}
  }
  if (!key) throw new Error("找不到 apiKey（--api-key / $DEEPSEEK_API_KEY / ~/.pi/agent/auth.json）");
  const base = provider === "deepseek" ? "https://api.deepseek.com" : String(arg("base-url", "https://api.deepseek.com"));
  const body = {
    model, messages: [{ role: "user", content: prompt }],
    response_format: { type: "json_object" }, temperature: 0.2,
    ...(has("no-thinking") ? { thinking: { type: "disabled" } } : {}),
  };
  const t0 = Date.now();
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify(body), signal: AbortSignal.timeout(180000),
  });
  const raw = await res.text();
  // OpenAI 兼容响应是信封：真正的 LLM 输出在 choices[0].message.content（此前误把信封当输出解析）
  let content = raw;
  try { const env = JSON.parse(raw); content = env?.choices?.[0]?.message?.content ?? env?.output_text ?? raw; } catch { /* 非 JSON 信封则原样 */ }
  return { status: res.status, ms: Date.now() - t0, raw, content: String(content || "") };
}

function applyNodeUpdates(dir, parsed) {
  const updates = parsed?.node_updates || {};
  const written = [];
  for (const [id, u] of Object.entries(updates)) {
    const m = String(id).match(/^L(\d+)::(node_\d+)$/);
    if (!m) continue;
    const f = path.join(dir, `layer_${m[1]}`, `${m[2]}.html`);
    if (!fs.existsSync(f)) continue;
    const html = fs.readFileSync(f, "utf-8");
    const old = (html.match(/<content>\s*([\s\S]*?)\s*<\/content>/) || [, ""])[1].trim();
    const add = textOf(u?.content || u?.context || u).trim();
    const keep = String(u?.keep || "").trim();
    const merged = (u?.mode === "replace" ? [add] : [keep || old, add]).filter(Boolean).join("\n");
    // 版本化：任何覆写前留档，保证可回滚
    const hist = path.join(dir, "_node_history");
    fs.mkdirSync(hist, { recursive: true });
    if (old) fs.writeFileSync(path.join(hist, `${m[2]}.${Date.now()}.html`), html, "utf-8");
    fs.writeFileSync(f, html.replace(/<content>[\s\S]*?<\/content>/, `<content>\n${merged}\n</content>`), "utf-8");
    written.push({ id, mode: u?.mode || "merge", chars: merged.length });
  }
  return written;
}

(async () => {
  const all = readTraj();
  const turns = all.filter((e) => e.kind === "turn");
  if (has("list") || arg("list")) {
    const n = Number(arg("list", 8)) || 8;
    for (const t of turns.slice(-n)) {
      const he = t.highEntropy ? `${t.highEntropy.name || "-"} / ${t.highEntropy.taskType || "-"}` : "-";
      console.log(`${t.turnId}  ${t.ts}  ${t.taskFamily || "-"}  answer=${t.answerChars ?? textOf(t.answer).length}c  HE=${t.hasHighEntropy ? "yes" : "no "} (${he})  backward=${JSON.stringify(t.backward || {})}`);
    }
    return;
  }
  const turn = pickTurn(turns);
  if (!turn) { console.error("没有可用轨迹（_trajectories.jsonl 里没有 kind:\"turn\" 行）"); process.exit(1); }
  const net = readNetwork(String(arg("network", "stock_alpha")));
  const triple = pairTriple(turns, turn);
  const prompt = buildPrompt({ goal: net.goal, nodes: net.nodes, triple });

  console.log(`[turn]   ${turn.turnId} @ ${turn.ts}  taskFamily=${turn.taskFamily}`);
  console.log(`[配对]   task=${triple.task.length}c  action=${triple.action.length}c  feedback=${triple.feedback.length}c (feedback turn=${triple.feedbackTurnId || "-"})`);
  console.log(`[轨迹]   HE=${triple.hasHighEntropy ? "有" : "无"}  matchedTaskTs=${turn.matchedTaskTs ?? "-"}  backward=${JSON.stringify(triple.backward || {})}`);
  console.log(`[网络]   goal=${net.goal.slice(0, 60)}…  节点=${net.nodes.length}`);

  if (has("print-prompt")) { console.log("\n──────── PROMPT ────────\n" + prompt); }
  if (has("dry-run")) { console.log("\n(--dry-run：未调用 LLM)"); return; }
  if (has("print-prompt") && !has("call")) { console.log("\n(仅打印 prompt；加 --call 才真正调用 LLM)"); return; }

  const r = await callLLM(prompt);
  const outDir = path.join(TEXTRON, "_sb_logs");
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15);
  const outFile = path.join(outDir, `manual_backward_${turn.turnId}_${stamp}.json`);
  let parsed = null, parseErr = null;
  try { parsed = JSON.parse(r.content.replace(/^```json\n?|```$/g, "").trim()); } catch (e) { parseErr = e.message; }
  const record = { kind: "manual_backward", turnId: turn.turnId, ts: new Date().toISOString(), http: r.status, ms: r.ms, promptChars: prompt.length, triple, llmContent: r.content, rawEnvelope: r.raw.length > 40000 ? r.raw.slice(0, 40000) : r.raw, parsed, parseError: parseErr };
  if (has("apply") && parsed) record.applied = applyNodeUpdates(net.dir, parsed);
  fs.writeFileSync(outFile, JSON.stringify(record, null, 2), "utf-8");

  console.log(`\n[http]   ${r.status}  ${r.ms}ms  raw=${r.raw.length}c  → ${outFile}`);
  if (parseErr) {
    console.log(`[解析]   失败: ${parseErr}`);
    console.log(`[out head] ${r.content.slice(0, 400).replace(/\n/g, " ")}`);
  } else {
    const keys = Object.keys(parsed?.node_updates || {});
    console.log(`[解析]   OK  node_updates=[${keys.join(", ")}]  add_nodes=${(parsed?.add_nodes || []).length}  reasoning=${String(parsed?.reasoning || "").slice(0, 100)}`);
    if (record.applied) console.log(`[落盘]   ${JSON.stringify(record.applied)}`);
  }
})().catch((e) => { console.error("FAIL:", e.message); process.exit(1); });
