declare const process: { exit(code?: number): never };

import {
  assignEdgeCredit,
  chooseTaskFamilyRoute,
  decideMergeFirst,
  isNegativeFeedback,
  jaccardTokens,
  validateKnowledgeGranularity,
} from "./learning_policy.ts";

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

function testTaskFamilyHardGate() {
  console.log("\ntaskFamily hard gate");
  const route = chooseTaskFamilyRoute({
    prompt: "请实现 Textron backward 的负样本降权和 merge-first 学习策略",
    candidates: [
      {
        name: "stock_astrology",
        content: "A股 天象 月亮 星座 股票 预测 行情 策略",
      },
      {
        name: "textron_learning_policy",
        content: "Textron backward negative credit assignment merge-first taskFamily hard gate route policy",
      },
    ],
  });

  ok("routes to same-domain Textron network", route.taskFamily === "textron_learning_policy", JSON.stringify(route));
  ok("route reason is domain/content match", route.reason === "domain_match" || route.reason === "content_match", route.reason);

  const noMatch = chooseTaskFamilyRoute({
    prompt: "写一首深夜R&B歌词",
    candidates: [
      { name: "stock_astrology", content: "A股 天象 股票" },
      { name: "textron_learning_policy", content: "backward negative credit merge-first" },
    ],
  });
  ok("does not fallback to first unrelated network by default", noMatch.taskFamily === null, JSON.stringify(noMatch));

  const bestEffort = chooseTaskFamilyRoute({
    prompt: "写一首深夜R&B歌词",
    allowBestEffort: true,
    candidates: [
      { name: "stock_astrology", content: "A股 天象 股票" },
      { name: "textron_learning_policy", content: "backward negative credit merge-first" },
    ],
  });
  ok("best-effort mode selects a candidate for lifecycle probing", bestEffort.taskFamily !== null && bestEffort.reason === "best_effort", JSON.stringify(bestEffort));

  const explicit = chooseTaskFamilyRoute({
    prompt: "任何内容",
    explicitTaskFamily: "stock_astrology",
    candidates: [
      { name: "stock_astrology", content: "A股 天象 股票" },
      { name: "textron_learning_policy", content: "backward negative credit merge-first" },
    ],
  });
  ok("explicit taskFamily overrides gate when exact", explicit.taskFamily === "stock_astrology", JSON.stringify(explicit));
}

function testNegativeCreditAssignment() {
  console.log("\nnegative credit assignment");
  ok("detects Chinese negative feedback", isNegativeFeedback("LLM模式反向传播好像不太work，而且误召回无关prior"));

  const decision = assignEdgeCredit({
    selectedEdgeIds: ["L0::node_0->L1::node_2", "L1::node_2->L2::node_3"],
    baseReward: 0.8,
    feedbackText: "不太work，召回污染",
    pathAuditLabel: "low",
  });

  ok("wrong-topic path gets negative reward", decision.reward < 0, JSON.stringify({ reward: decision.reward, reason: decision.reason }));
  ok("wrong-topic path reason recorded", decision.reason === "wrong_topic_path", decision.reason);
  ok("each selected edge gets negative credit", [...decision.edgeRewards.values()].every((v) => v < 0));

  const success = assignEdgeCredit({
    selectedEdgeIds: ["L0::node_0->L1::node_2"],
    baseReward: 0.7,
    feedbackText: "效果正确，继续",
    pathAuditLabel: "high",
  });
  ok("positive feedback preserves positive reward", success.reward > 0 && [...success.edgeRewards.values()][0] > 0);
}

function testMergeFirstPolicy() {
  console.log("\nmerge-first policy");
  const existing = [
    {
      id: "L1::node_4",
      layer: 1,
      name: "textron_negative_credit",
      content: "backward需记录误召回节点并降权；仅success正反馈会导致历史prior泛化污染。",
    },
  ];

  const merge = decideMergeFirst({
    candidate: {
      layer: 1,
      name: "negative_credit_assignment",
      content: "backward必须对误召回路径做负信用分配，否则success-only训练会放大prior污染。",
    },
    existing,
  });
  ok("similar correction merges into existing node", merge.action === "merge", JSON.stringify(merge));
  ok("merge target is existing similar node", merge.action === "merge" && merge.targetId === "L1::node_4", JSON.stringify(merge));

  const add = decideMergeFirst({
    candidate: {
      layer: 1,
      name: "taskfamily_hard_gate",
      content: "forward必须先按taskFamily硬门控；跨域网络即使词面重叠也不能进入候选池。",
    },
    existing,
  });
  ok("novel high-signal candidate can add", add.action === "add", JSON.stringify(add));

  const low = validateKnowledgeGranularity("太短");
  ok("low-signal crystals rejected", !low.ok && low.reason === "low_signal", JSON.stringify(low));

  const multi = validateKnowledgeGranularity("taskFamily硬门控；负样本降权；merge-first；节点粒度；路由阈值；监控事件");
  ok("multi-topic crystals rejected", !multi.ok && multi.reason === "multi_topic", JSON.stringify(multi));
}

function testSimilarity() {
  console.log("\nsimilarity signal");
  const same = jaccardTokens("Textron backward negative credit", "negative credit for Textron backward paths");
  const cross = jaccardTokens("Textron backward negative credit", "A股 天象 月亮 股票");
  ok("same-domain similarity beats cross-domain", same > cross, `same=${same} cross=${cross}`);
}

testTaskFamilyHardGate();
testNegativeCreditAssignment();
testMergeFirstPolicy();
testSimilarity();

console.log(`\npassed=${passed} failed=${failed}`);
if (failed > 0) process.exit(1);
