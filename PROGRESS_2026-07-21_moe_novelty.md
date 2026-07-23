# Textron MoE Router + Novelty Expansion Progress（2026-07-21）

## 2026-07-21 追加：Content Limit 480c + Merge 防截断

**修复**：`mergeContent` 硬截断 120c → 480c，解决每次 merge 丢 50% 旧信息的问题。

改动点：
- `mergeContent` 所有 `completeContent(..., 120)` → `480`
- `validateKnowledgeCrystal` 上限 240c → 480c
- `applySemanticNodeUpdates` / `buildHighEntropyAddCandidate` / `rescaleRejectedCrystal` 同步改 480c
- semantic backward prompt `<120 char` → `≤480 chars`
- `oldHead`/`newHead` 截断 58c → 200c（与 480c 对齐）

**为什么 480c**：120c 中文约 60 字，对"条件→机制→边界"三段式因果链太紧。480c 约 240 字，能容纳复杂经验。480c 也低于 prompt 注入的 180c 截断线（`prepareContextLine`），不会导致 context 爆炸。

**风险**：更长 content 可能增加 prompt 注入体积。`prepareContextLine` 仍截到 180c，注入时不受影响。

---

> 目的：记录本轮“在 L0 前增加 MoE 专家路由层 / 新主题可测扩展”的代码改动、日志事件、测试命令和已知风险。后续测试按本文事件名审计运行效果。

## 1. 本次结论

- Textron **始终注入**已选网络的历史 prior，不因 `content_match` / `best_effort` / 低分而 abstain。
- 为避免“错注入后不可学”，新增可测 novelty 策略：
  - forward 记录 `routeUncertain` 与 `moeMaxScore`；
  - `agent_end` 持久化这些信号；
  - 下一轮 backward 若检测到 `routeUncertain`、`moeMaxScore < 0.08` 或负 reward，且有 HighEntropy，则强制合成 **L0 新主题锚点**。
- 当前 MoE 是运行时虚拟层：按 L0 节点聚类成 E0/E1/...，只保留 top-k expert 覆盖的 L0；新增 L0 后下一轮自动重聚类成新专家。

## 2. 代码改动

### 2.1 运行时 MoE Router

- 新增：`src/moe_router.ts`
  - `buildMoeExperts(l0Nodes, expertCount?)`
  - `routeL0ThroughMoe({ prompt, l0Nodes, scores, stats, expertCount, topK, minScore })`
- 接入：`src/index.ts`
  - 在 L0 LLM 分数、local relevance、PageRank、exploration 之后执行 MoE 门控。
  - 非入选专家覆盖的 L0 分数置 0，后续 L0→L1→L2 传播继续使用原结构。

### 2.2 Novelty expansion policy

- 新增：`src/novelty_policy.ts`
  - `decideNoveltyExpansion({ routeUncertain, moeMaxScore, reward, selectedEdgeIds, hasHighEntropy })`
- 触发 L0 anchor 的条件：
  - `routeUncertain=true`
  - `moeMaxScore < 0.08`
  - `selectedEdgeIds.length > 0 && reward < 0`
- 没有 HighEntropy 时不合成 add-node，记录为 `no_highentropy`。

### 2.3 状态持久化

- `_last_state.json` 新增：
  - `routeUncertain`
  - `moeMaxScore`
- `agent_end` 会把当前轮的两个信号传给下一轮 backward。

### 2.4 Extension runtime symlink 修复

运行时实际加载目录为：

```text
~/.pi/agent/extensions/textron/index.ts
```

该目录中的依赖是逐个 symlink 管理。新增模块必须同步 symlink：

```text
~/.pi/agent/extensions/textron/moe_router.ts     -> /Users/rama/textron-agent/src/moe_router.ts
~/.pi/agent/extensions/textron/novelty_policy.ts -> /Users/rama/textron-agent/src/novelty_policy.ts
```

否则会出现：

```text
Cannot find module './moe_router.ts'
```

## 3. 跟踪日志事件

后续测试在 `~/.textron/_events.jsonl` / monitor `/api/state` 里检查这些事件：

| 事件 | 含义 | 预期 |
|---|---|---|
| `route_policy_decision` | network 路由 decision（reason/score） | `content_match` 也可能被标记 uncertain |
| `route_done` | 选中网络并继续 forward | `policy="always_inject_and_let_backward_converge"`；低置信只打 `uncertain=true` 标签 |
| `l0_score_done` | L0 LLM 打分完成 | 看 provider、耗时、topScores |
| `l0_exploration_applied` | L0 分数经过 PageRank/local/exploration 修正 | 看 `topAdjusted` |
| `moe_route_done` | MoE 专家路由完成 | 看 `enabled`、`selectedExpertIds`、`maxExpertScore`、`experts[].score/nodeIds` |
| `propagate_done` | L0→L1→L2 传播完成 | 看 selectedIds、selectedEdgeIds、contextIds |
| `semantic_add_node_synthesized` | backward 合成 add_node | novelty 触发时应 `reason=route_uncertain/moe_low_score/negative_reward` 且 `targetLayer=0` |
| `semantic_backward_apply` | autoBackward 实际应用结果 | novelty 后应看到 `nodeMutations` 有 `{type:"add", id:"L0::..."}` 或 merge 到已有 L0 |
| `last_state_saved` | 状态已保存给下一轮 | 应含 routeUncertain/moeMaxScore（存储字段） |

### 3.1 快速审计命令

```bash
tail -200 ~/.textron/_events.jsonl \
  | rg 'route_policy_decision|route_done|moe_route_done|semantic_add_node_synthesized|semantic_backward_apply|last_state_saved'
```

检查 novelty 是否真正新增 L0：

```bash
tail -100 ~/.textron/_events.jsonl \
  | rg 'semantic_add_node_synthesized|semantic_backward_apply'
```

## 4. 回归测试命令

本次通过：

```bash
cd /Users/rama/textron-agent
node src/test_novelty_policy.ts   # passed=4 failed=0
node src/test_moe_router.ts       # passed=6 failed=0
node --check src/index.ts
node --check src/moe_router.ts
node --check src/novelty_policy.ts
```

依赖导入验证：

```bash
node --input-type=module -e "import('/Users/rama/.pi/agent/extensions/textron/moe_router.ts').then(()=>import('/Users/rama/.pi/agent/extensions/textron/novelty_policy.ts')).then(()=>console.log('extension deps ok'))"
```

## 5. 已知运行样本（2026-07-21）

用户提出“Textron agent 增加 L0 前 MoE 专家路由层”时，network 仍选中 `astro_stock_prediction`，注入 6/51 nodes、6 path。代表污染/未收敛中间态：

- `L0::node_3`：手动清理污染节点 / Textron backward 自动边降权
- `L0::node_1`：B/D version3 唯一值（无关）
- `L1::node_3`：禁止手动操作 Textron test.md
- `L2::node_13`：L0 25s / backward 27s 固定税
- `L2::node_32`：旧中间态写的“新主题低置信应 abstain 执行旧技能” —— 与当前最终策略“始终注入 + backward 收敛”不一致，后续要靠 backward merge/update 修正
- `L2::node_12`：monitor.html / http.Server（无关）

解释：`astro_stock_prediction` 已混入 Textron 治理知识，所以 Textron 主题会 `content_match` 到该网络。当前策略不再 abstain；靠 `routeUncertain + moeMaxScore` 在下轮 backward 合成 L0 新主题锚点，并对错误路径做负 reward/merge/delete 收敛。

## 6. 后续观察指标

- `route_done uncertain=true` 是否仍能注入，而不是提前 return。
- `moe_route_done.maxExpertScore` 是否偏低；低分时下一轮是否出现 L0 anchor。
- novelty L0 anchor 是否被下一轮 `moe_route_done` 聚成新 expert。
- `L2::node_32` 是否被后续 backward 更新为“始终注入 + 收敛治理”。
- 网络是否继续把非星象知识写入 `astro_stock_prediction`；若继续污染，考虑 taskFamily 路由加强或网络分裂策略。

## 7. 配置项

```text
TEXTRON_MOE_EXPERTS        # 专家数量；默认 sqrt(filled L0)
TEXTRON_MOE_TOP_K          # 每轮保留专家数；默认 2
TEXTRON_ROUTE_ABSTAIN_SCORE # 仅用于 routeUncertain 标记；默认 0.08
```
