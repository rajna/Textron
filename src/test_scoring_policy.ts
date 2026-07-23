declare const process: { exit(code?: number): never };

import { applyExplorationPolicy, buildLocalScores, lexicalRelevance, parseNodeScores, rankLayerWithExploration } from "./scoring_policy.ts";

let passed = 0;
let failed = 0;
function ok(name: string, condition: boolean, detail = "") {
  if (condition) { passed++; console.log(`  OK ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? ` - ${detail}` : ""}`); }
}

console.log("scoring policy tests\n");

const proseJson = parseNodeScores(`The user task is about monitoring. Final scores:\n\`\`\`json\n{"L0::node_0":0.82,"L0::node_1":0.05}\n\`\`\``);
ok("parses JSON surrounded by prose", proseJson["L0::node_0"] === 0.82, JSON.stringify(proseJson));

const lines = parseNodeScores(`L0::node_0=0.74\nnode_1: 0.12\nnode_2 0.00`);
ok("parses stable line protocol", lines["L0::node_0"] === 0.74 && lines.node_1 === 0.12, JSON.stringify(lines));

const local = buildLocalScores("分析 WebGL 页面卡顿和 Canvas 性能", [
  { id: "node_0", name: "Canvas 页面卡顿诊断", content: "WebGL shader 性能治理" },
  { id: "node_1", name: "股票反弹信号", content: "量价与星象" },
]);
ok("local relevance gates unrelated nodes", local["L0::node_0"] > 0 && local["L0::node_1"] === 0, JSON.stringify(local));

const astroPrompt = "预测上证指数 sh000001 2026-07-08 跌破4000 月亮合土星 日月刑 月刑水 缩量下影 K线 周K";
const astroDomain = lexicalRelevance(astroPrompt, "跌破4000+均线/周K压制+月合土星/日月刑/月刑水→破位惯性看跌有效；缩量下影=跌幅收敛非反转。");
const astroOffTopic = lexicalRelevance(astroPrompt, "用户输入.model时报告模型家族，修复provider认证错误，验证apiKey和JSON。");
ok("astro downstream relevance keeps domain node", astroDomain > 0.2, `${astroDomain}`);
ok("astro downstream relevance rejects off-topic engineering node", astroOffTopic === 0, `${astroOffTopic}`);

const adjusted = applyExplorationPolicy(
  { "L0::node_0": 0.8, "L0::node_1": 0.55, "L0::node_2": 0 },
  { "L0::node_0": 0.5, "L0::node_1": 0.5, "L0::node_2": 0 },
  {
    "L0::node_0": { success: 24, failure: 16 },
    "L0::node_1": { success: 0, failure: 0 },
  },
);
ok("frequent relevant node receives decay", adjusted["L0::node_0"] < 0.5, JSON.stringify(adjusted));
ok("new relevant node receives bounded exploration", adjusted["L0::node_1"] > adjusted["L0::node_0"], JSON.stringify(adjusted));
ok("irrelevant node never receives random bonus", adjusted["L0::node_2"] === 0, JSON.stringify(adjusted));

const ranked = rankLayerWithExploration(1, [
  { id: "node_0", score: 0.82 },
  { id: "node_1", score: 0.66 },
  { id: "node_2", score: 0.10 },
], {
  "L1::node_0": { success: 30, failure: 10 },
  "L1::node_1": { success: 0, failure: 0 },
});
ok("new relevant downstream node can outrank locked node", ranked[0]?.id === "node_1", JSON.stringify(ranked));
ok("low-relevance downstream node cannot enter exploration pool", !ranked.some((node) => node.id === "node_2"), JSON.stringify(ranked));

console.log(`\npassed=${passed} failed=${failed}`);
if (failed > 0) process.exit(1);
