declare const process: { exit(code?: number): never };

import { decideNoveltyExpansion } from "./novelty_policy.ts";

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

function testRouteUncertainForcesL0Anchor() {
  const decision = decideNoveltyExpansion({ routeUncertain: true, moeMaxScore: 0.4, reward: 0.2, selectedEdgeIds: ["L0::node_1->L1::node_2"], hasHighEntropy: true });
  ok("uncertain route synthesizes new L0 anchor", decision.synthesizeL0Anchor && decision.reason === "route_uncertain", JSON.stringify(decision));
}

function testNegativeRewardForcesL0Anchor() {
  const decision = decideNoveltyExpansion({ routeUncertain: false, moeMaxScore: 0.3, reward: -0.6, selectedEdgeIds: ["L0::node_1->L1::node_2"], hasHighEntropy: true });
  ok("negative reward on selected path synthesizes L0 anchor", decision.synthesizeL0Anchor && decision.reason === "negative_reward", JSON.stringify(decision));
}

function testLowMoeScoreForcesL0Anchor() {
  const decision = decideNoveltyExpansion({ routeUncertain: false, moeMaxScore: 0.03, reward: 0.1, selectedEdgeIds: ["L0::node_1->L1::node_2"], hasHighEntropy: true });
  ok("weak MoE expert score synthesizes L0 anchor", decision.synthesizeL0Anchor && decision.reason === "moe_low_score", JSON.stringify(decision));
}

function testNoHighEntropyDoesNotSynthesize() {
  const decision = decideNoveltyExpansion({ routeUncertain: true, moeMaxScore: 0.01, reward: -1, selectedEdgeIds: ["L0::node_1->L1::node_2"], hasHighEntropy: false });
  ok("without HighEntropy there is no add-node material", !decision.synthesizeL0Anchor && decision.reason === "no_highentropy", JSON.stringify(decision));
}

console.log("novelty_policy tests\n");
testRouteUncertainForcesL0Anchor();
testNegativeRewardForcesL0Anchor();
testLowMoeScoreForcesL0Anchor();
testNoHighEntropyDoesNotSynthesize();

console.log(`\npassed=${passed} failed=${failed}`);
if (failed > 0) process.exit(1);
