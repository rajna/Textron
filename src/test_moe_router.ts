declare const process: { exit(code?: number): never };

import { buildMoeExperts, routeL0ThroughMoe } from "./moe_router.ts";

let passed = 0;
let failed = 0;

function ok(name: string, condition: boolean, detail = "") {
  if (condition) {
    passed++;
    console.log(`  OK ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}${detail ? ` - ${detail}` : ""}`);
  }
}

const nodes = [
  { id: "node_0", name: "Textron backward edge reward", content: "backward credit assignment selectedEdgeIds node_updates" },
  { id: "node_1", name: "Textron MoE router L0", content: "expert routing sparse top-k gates L0 nodes before propagation" },
  { id: "node_2", name: "A股 星象 上证指数", content: "星象 相位 A股 预测 上证指数 K线" },
  { id: "node_3", name: "nbeat melody chord", content: "Suno beat melody groove chord progression" },
];

function testBuildExpertsUsesLayer0Nodes() {
  const experts = buildMoeExperts(nodes, 3);
  const allNodeIds = new Set(experts.flatMap((expert) => expert.nodeIds));
  ok("builds requested sparse expert layer", experts.length === 3, JSON.stringify(experts));
  ok("experts reference existing L0 node ids", allNodeIds.has("L0::node_1") && allNodeIds.has("L0::node_2"), JSON.stringify(experts));
}

function testMoeGatesIrrelevantLayer0Branch() {
  const routed = routeL0ThroughMoe({
    prompt: "给 Textron agent 在 L0 前增加 MoE 专家路由层",
    l0Nodes: nodes,
    scores: {
      "L0::node_0": 0.45,
      "L0::node_1": 0.90,
      "L0::node_2": 0.30,
      "L0::node_3": 0.25,
    },
    expertCount: 3,
    topK: 1,
  });

  ok("MoE routing enabled when multiple experts exist", routed.enabled, JSON.stringify(routed));
  ok("selects exactly one expert under topK=1", routed.selectedExpertIds.length === 1, JSON.stringify(routed.selectedExpertIds));
  ok("keeps relevant Textron L0 score", (routed.gatedScores["L0::node_1"] || 0) > 0, JSON.stringify(routed.gatedScores));
  ok("zeros unrelated astrology branch", (routed.gatedScores["L0::node_2"] || 0) === 0, JSON.stringify(routed.gatedScores));
}

console.log("moe_router tests\n");
testBuildExpertsUsesLayer0Nodes();
testMoeGatesIrrelevantLayer0Branch();

console.log(`\npassed=${passed} failed=${failed}`);
if (failed > 0) process.exit(1);
