// n8 第九轮：JSON 恢复层回归测试
// 覆盖：①字符串值内未转义双引号 ②裸换行/制表符 ③尾逗号 ④合法 JSON 不受影响 ⑤流式单字符 delta 无缝拼接
// 模拟 extract 的 balanced 扫描 + 修复层组合（与 index.ts extract/tryRepairJsonParse 同构逻辑快照验证）
import * as fs from "node:fs";

let pass = 0, fail = 0;
function ok(name: string, cond: boolean, extra = "") {
  if (cond) { pass++; console.log("PASS", name); }
  else { fail++; console.log("FAIL", name, extra); }
}

// —— 从 index.ts 提取的 tryRepairJsonParse 同构实现（快照式，防止行为漂移的对照基准）——
function tryRepairJsonParse(s: string): any | undefined {
  const variants: string[] = [];
  try {
    let out = "";
    let inStr = false, esc = false;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (!inStr) { out += ch; if (ch === '"') inStr = true; continue; }
      if (esc) { out += ch; esc = false; continue; }
      if (ch === "\\") { out += ch; esc = true; continue; }
      if (ch === '"') {
        let k = i + 1;
        while (k < s.length && /\s/.test(s[k])) k++;
        const nk = s[k];
        if (nk === undefined || nk === "," || nk === "}" || nk === "]" || nk === ":") { inStr = false; out += ch; }
        else out += '\\"';
        continue;
      }
      if (ch === "\n") { out += "\\n"; continue; }
      if (ch === "\r") { out += "\\r"; continue; }
      if (ch === "\t") { out += "\\t"; continue; }
      out += ch;
    }
    variants.push(out);
  } catch { /* 忽略 */ }
  for (const v of [...variants]) variants.push(v.replace(/,(\s*[}\]])/g, "$1"));
  for (const v of variants) { try { return JSON.parse(v); } catch { /* 下一个变体 */ } }
  return undefined;
}

function balancedScan(raw: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] !== "{") continue;
    let d = 0, inString = false, escaped = false;
    for (let j = i; j < raw.length; j++) {
      const ch = raw[j];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === "{") d++;
      else if (ch === "}" && --d === 0) { out.push(raw.slice(i, j + 1)); break; }
    }
  }
  return out.sort((a, b) => b.length - a.length);
}

// 模拟 extract：原样 → fence → balanced → repair
function extractLike(raw: string): any | undefined {
  const candidates: string[] = [raw.trim()];
  for (const c of balancedScan(raw)) if (!candidates.includes(c)) candidates.push(c);
  for (const c of candidates) {
    let parsed: any;
    try { parsed = JSON.parse(c); } catch { parsed = tryRepairJsonParse(c); }
    if (parsed !== undefined && parsed && typeof parsed === "object" &&
        (parsed.node_updates || Array.isArray(parsed.add_nodes) || Array.isArray(parsed.node_actions))) return parsed;
  }
  return undefined;
}

// T1: 字符串值内未转义双引号（本轮 chat_json 失败的强证据病灶）
const t1 = '{"reward":0.3,"rationale":"空仓两次正确回避续跌","node_updates":{"L0::node_0":{"mode":"replace","keep":"","content":"反馈点名"只有防守没有进攻预案的合法空转"，应建三态预案"}}}';
ok("T1 未转义引号直parse失败", (() => { try { JSON.parse(t1); return false; } catch { return true; } })());
const r1 = extractLike(t1);
ok("T1 repair 救起", r1?.reward === 0.3 && String(r1?.node_updates?.["L0::node_0"]?.content).includes("合法空转"), JSON.stringify(r1)?.slice(0, 200));

// T2: 字符串值内裸换行（流式 join 污染病灶）
const t2 = '{"reward":-0.2,"rationale":"x","node_updates":{"L0::node_1":{"mode":"merge","content":"第一行\n第二行\t含制表"}}}';
ok("T2 裸换行直parse失败", (() => { try { JSON.parse(t2); return false; } catch { return true; } })());
const r2 = extractLike(t2);
ok("T2 repair 救起", r2?.reward === -0.2 && String(r2?.node_updates?.["L0::node_1"]?.content).includes("第二行"), JSON.stringify(r2)?.slice(0, 200));

// T3: 尾逗号
const t3 = '{"reward":0.5,"rationale":"y","add_nodes":[{"layer":0,"name":"n","content":"c"},],"node_actions":[]}';
ok("T3 尾逗号直parse失败", (() => { try { JSON.parse(t3); return false; } catch { return true; } })());
ok("T3 repair 救起", extractLike(t3)?.reward === 0.5);

// T4: 合法 JSON 不受 repair 影响（假阳性防护）
const t4 = JSON.stringify({ reward: 0.8, rationale: "含\"引号\"与\n转义", node_updates: { "L0::node_0": { content: "合法内容" } } });
const r4 = extractLike(t4);
ok("T4 合法JSON原样通过", r4?.reward === 0.8 && String(r4?.node_updates?.["L0::node_0"]?.content) === "合法内容");

// T5: 流式单字符 delta join("") 后可解析（readSse 修复语义）
const obj = { reward: 0.1, rationale: "z", node_updates: { "L0::node_0": { content: "无缝拼接" } } };
const deltas = JSON.stringify(obj).split("").map((c) => [c]); // 单字符 delta
const joined = deltas.map((d: string[]) => d.join("")).join(""); // 旧 join("\n") 会污染
ok("T5 无缝拼接可parse", (() => { try { JSON.parse(joined); return true; } catch { return false; } })());
const oldJoin = deltas.map((d: string[]) => d.join("")).join("\n");
ok("T5a 旧join污染确证(对照)", (() => { try { JSON.parse(oldJoin); return false; } catch { return true; } })());
ok("T5b 结构级污染(key/数字被切)repair无法恢复语义→证明readSse join源头修复必要", (() => { const p = tryRepairJsonParse(oldJoin); return p?.reward !== 0.1; })());

// T6: balanced 扫描 + repair 组合（散文包裹 + 字符串内引号）
const t6 = '思考过程一些文字 {"reward":0.6,"rationale":"m","node_updates":{"L0::node_0":{"content":"引用"原文"内容"}}} 结尾';
ok("T6 散文包裹+坏引号救起", extractLike(t6)?.reward === 0.6);

// T7: 彻底损坏输入返回 undefined（不误吞）
ok("T7 垃圾输入undefined", extractLike("这不是json{{{") === undefined);

console.log(`\n${pass}/${pass + fail} PASS`);
fs.writeFileSync("/tmp/test_json_repair_result.txt", `${pass}/${pass + fail}`, "utf-8");
if (fail > 0) process.exit(1);
