declare const process: { exit(code?: number): never };

import { readFileSync } from "node:fs";
import { lexicalRelevance, retentionVerdict } from "./scoring_policy.ts";
import { stripFunctionBlocks, scanDanglingFnRefs } from "./lib/similarity.ts";

let passed = 0;
let failed = 0;
function ok(name: string, condition: boolean, detail = "") {
  if (condition) { passed++; console.log(`  OK ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
}

// ── 真实网络 goal（stock_alpha，2026-09-16）──
const GOAL = "沉浸出交易经验 ，可复用交易策略函数，精细的量化程序等，这个程序可以根据k线信息分析量能 均线 波动率 黄金分割，波动率，风报比等 ，检测出优秀买点卖点，";

// 旧文 = 累积交易长文：每轮 keep 反复保留 goal 字面词（lexicalRelevance 对旧文单调占优的来源）
const OLD_TRADE = (
  "核心机制：成交价=前收盘 ⇒ 成交瞬间零盈亏。本节点沉淀交易经验与可复用交易策略函数，"
  + "覆盖 k线信息 的量能、均线、波动率、黄金分割、风报比，用于检测优秀买点卖点。"
  + "逐日评分下为负期望；胜率闸门下做最小有效换手；止损贴结构位只提高被扫概率。"
).repeat(3);

// 新文 = 本轮 LLM 增量（真实形态：专业符号化 + 少量领域词）
const NEW_TRADE = (
  "【本轮新增·放量收复缺口下沿=唯一双通道事件】expand∧close≥gap_lower 同时抬高 p(+0.12 量能项)"
  + "并上移止损(π_risk_cap∝1/r)；deploy_floor 三闸门 AND：edge≥0.05 ∧ p≥p_gate(0.50) ∧ ¬squeeze；"
  + "π*=clip(min(Kelly(p,b),π_risk_cap,π_max),0,π_max)；决策=sign(π*−π_now)；"
  + "输出契约 qty%100==0、买入额≤cash、非交易决策价量=0.0/0；缺口跨周期回退 _last_gap。"
);
// 无任何领域词的纯符号增量（离域极端样本）
const NEW_ENG = Array.from({ length: 12 }, (_, i) =>
  `sender_step_loop_orchestrate relay idempotency receipt_key session_${i} pending_queue ack retry backoff`
  + ` dispatch fanout namespace agent_settled empty_assistant_text slack_${i} quorum_shard_${i}`
  + ` lease_epoch_${i} drain_barrier_${i} dedupe_ledger_${i} replay_cursor_${i} watchdog_tick_${i}`
  + ` retry_budget_${i} fanout_barrier_${i} heartbeat_probe_${i} backpressure_valve_${i}`
).join(" ");

console.log("T1 旧判据的累积偏差被复现（改进的必要性证据）");
const sOld = lexicalRelevance(GOAL, OLD_TRADE);
const sNewTrade = lexicalRelevance(GOAL, NEW_TRADE);
ok("legacy metric favors accumulated old text (>= 0.85 gap)", sNewTrade < sOld * 0.85, `sOld=${sOld.toFixed(4)} sNew=${sNewTrade.toFixed(4)}`);

console.log("T2 新判据：交易增量放行、离域增量仍拒（保护不弱化）");
const vTrade = retentionVerdict(GOAL, OLD_TRADE, NEW_TRADE);
const vEng = retentionVerdict(GOAL, OLD_TRADE, NEW_ENG);
ok("trade increment has goal evidence", vTrade.goalHits > 0 && vTrade.evidence.includes("goal"), JSON.stringify(vTrade));
ok("trade increment NOT off-domain", vTrade.offDomain === false, JSON.stringify(vTrade));
ok("engineering increment has zero goal evidence", vEng.goalHits === 0 && !vEng.evidence.includes("goal"), JSON.stringify(vEng));
ok("engineering increment IS off-domain (protection kept)", vEng.offDomain === true, JSON.stringify(vEng));
ok("verdict still reports legacy scores for comparability", vEng.scoreOld > 0 && vEng.scoreNew === 0, `sOld=${vEng.scoreOld} sNew=${vEng.scoreNew}`);

console.log("T3 空壳豁免（本轮实测的致命自锁路径）：旧文正文被函数块吞没后，交易增量必须还能写回");
const vShell = retentionVerdict(GOAL, "", NEW_TRADE);
ok("empty old text never off-domain", vShell.offDomain === false, JSON.stringify(vShell));
ok("empty old text flagged freshNode", vShell.freshNode === true && vShell.evidence.includes("fresh_node"), JSON.stringify(vShell));
ok("shell + engineering also admitted (no lock-in)", retentionVerdict(GOAL, "", NEW_ENG).offDomain === false);
ok("shell exemption is not score-dependent", vShell.scoreOld === 0);

console.log("T4 域一致性证据：与同节点旧文重叠够高 ⇒ 放行（即便 goal 字面命中为 0）");
const ENG_FREE_OLD = Array.from({ length: 4 }, (_, i) => `pi_star_gate_trade candidate_edge_${i} risk_budget_pct deploy_floor p_gate target_position pi_max weak_edge buy_band sell_band atr_window atr_stop_mult gap_decay_days gap_decay_step gap_decay_cap range_squeeze sup_zone_atr trail_ratio stop_loss_pct score_cost_pct mom_alpha mtf_one_pen min_stop_pct lot_floor_${i}`).join(" ");
const ENG_FREE = ENG_FREE_OLD + " gap_decay_days sup_zone_atr trail_ratio stop_loss_pct score_cost_pct mom_alpha mtf_one_pen";
const vCo = retentionVerdict(GOAL, ENG_FREE_OLD, ENG_FREE);
ok("coherence evidence detected on same-domain symbol layer", vCo.evidence.includes("coherence"), JSON.stringify(vCo));
ok("coherence admits write", vCo.offDomain === false, JSON.stringify(vCo));
const vNoCo = retentionVerdict(GOAL, OLD_TRADE, NEW_ENG);
ok("absence of coherence + no goal hits => refused", vNoCo.offDomain === true);

console.log("T5 小增量不被误杀（防『短=离域』假阴性）");
ok("tiny token stream never off-domain", retentionVerdict(GOAL, OLD_TRADE, "zzz yyy xxx").offDomain === false);
ok("minNewTokens parameterizable", retentionVerdict(GOAL, OLD_TRADE, "zzz yyy xxx", { minNewTokens: 1 }).offDomain === true);
ok("minOldCover parameterizable", retentionVerdict(GOAL, OLD_TRADE, ENG_FREE, { minOldCover: 0.99 }).evidence.includes("goal") === false);

console.log("T6 悬空 [fn:σ] 回扫：口径固定、仅统计不改写");
const nodes = [
  { id: "L0::node_0", content: `foo [fn:pi_star_gate_trade] bar [fn:dead_symbol] <function symbol="pi_star_gate_trade">code</function>` },
  { id: "L1::node_0", content: `⟨fn:dead_symbol⟩ [fn:dead_symbol] [fn:other_alive] <function symbol="other_alive">x</function>` },
];
const scan = scanDanglingFnRefs(nodes);
ok("alive symbols counted", scan.symbolsAlive === 2, String(scan.symbolsAlive));
ok("dangling pairs = node x symbol", scan.danglingPairs === 2, JSON.stringify(scan.perNode));
ok("dangling refs count repeats", scan.danglingRefs === 3, String(scan.danglingRefs));
ok("dangling symbols deduped+sorted", JSON.stringify(scan.danglingSymbols) === JSON.stringify(["dead_symbol"]), JSON.stringify(scan.danglingSymbols));
ok("refs total counts all", scan.refsTotal === 5, String(scan.refsTotal));
ok("scan is pure (input untouched)", nodes[1].content.includes("[fn:dead_symbol]"));
ok("empty input safe", scanDanglingFnRefs([]).danglingPairs === 0);
ok("stripFunctionBlocks drops fn markers", !stripFunctionBlocks(`x [fn:pi_star_gate_trade] ⟨fn:foo⟩ <function symbol="bar">y</function>`).includes("pi_star_gate_trade"));

console.log("T7 源码守卫：判据已接入 + 硬性约束 2 未被违反");
const src = readFileSync("src/index.ts", "utf-8");
ok("uses retentionVerdict", src.includes("retentionVerdict(_g, stripFunctionBlocks(oldContent), stripFunctionBlocks(newContent))"));
ok("refusal requires off-domain verdict", src.includes("_sNew < _sOld * 0.85 && _v.offDomain"));
ok("downgrade-to-merge observable", src.includes("node_write_downgraded_to_merge"));
ok("dangling rescan event wired", src.includes('action: "fn_ref_dangling"') && src.includes("scanDanglingFnRefs("));
ok("no content-side dangling stripping (硬性约束 2)", !/\.replace\([^\n]*fn:/.test(src));
ok("scoring_policy exports retentionVerdict", readFileSync("src/scoring_policy.ts", "utf-8").includes("export function retentionVerdict"));
ok("similarity exports scanner", readFileSync("src/lib/similarity.ts", "utf-8").includes("export function scanDanglingFnRefs"));

console.log(`\npassed=${passed} failed=${failed}`);
if (failed > 0) process.exit(1);
