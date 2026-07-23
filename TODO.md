# Textron TODO

## Backward 质量修复 + 冷启动（2026-07-22 晚）

### 已修（待重启验证）
- [x] **DELETE 禁止**：systemPrompt schema 移除 `delete` 示例，Rule 1 新增 `NEVER propose delete`，解析层过滤 LLM 输出的 delete action
- [x] **name 蒸馏合并**：`applySemanticNodeUpdates` 和 `updateExistingNodeByPolicy` 的 name 改为 `distillNodeName(oldName + newName)` 而非全量替换
- [x] **MERGE DUTY**：新增 Rule 7，强制 LLM 扫描 RELATED 节点 ≥30% 重叠时提 merge
- [x] **冷启动虚拟 L0**：forward 0节点时从当前消息创建 `_seed_0` 虚拟节点，backward prompt 单独展示 SEED 节点引导 LLM 用 add_nodes 落地
- [x] **_seed_ 写入防护**：`applySemanticNodeUpdates` 检测 `_seed_`/`_cold_` 前缀跳过写盘

### ⚠️ 已知遗留
- [ ] **agent_end 冷启动缺口**：`agent_end` 依赖 `isTask && highEntropy` 才推栈。冷启动时若 LLM 不输出 isTask=true，即使 forward 有了虚拟 L0，agent_end 也不推栈 → 下轮无 backward → 虚拟节点永远不落地。**风险等级：低**（HighEntropy 指令始终注入 systemPrompt，LLM 通常会输出；只有极端冷启动第一轮且 LLM 遗漏 HighEntropy 时才触发）。建议观察几轮后决定是否修，修复方向：`agent_end` 检测到 0 nodes + network matched 时，即使没有 HighEntropy 也构造最小任务入栈。
- [ ] **MERGE DUTY 27轮0触发（第27轮审计发现）**：Rule 7 prompt存在但LLM在node_actions中从不产出merge。需强化输出格式：在schemaHint中显式列出merge action示例，或在user prompt中逐对展示RELATED节点重叠度并强制LLM逐对回答merge/keep。改index.ts需重启→通知boss。

## Content Limit 1000c + Merge 防截断（2026-07-22）

- [x] 新增 `content_limits.ts`，网络节点 Content 统一上限 **1000字符**；HighEntropy `Task≤100`、`Technique≤500` 独立控制
- [x] `index.ts` validator、update/add、merge、rescale、semantic backward schema/prompt 全部对齐1000
- [x] `storage.ts` 与 `index.ts` 最终写入层增加1000硬上限，防止新调用者绕过
- [x] `backward.ts`、`orthogonality.ts` 清除残留120字符硬截断
- [x] 前向节点单条最多1000字符，并增加 compiled context 总预算，避免多节点无界放大prompt
- [x] 新增 `test_content_limits.ts` 验证merge超过旧480上限、1000硬上限和磁盘round-trip
- [ ] 重启后运行时验收：观察 backward 的 `nodeUpdates` 可保留>480且≤1000字符，compiled context不超过预算

## MoE Router + Novelty Expansion（2026-07-21）

- [x] 新增运行时 MoE Router：`moe_router.ts`，L0 评分后经 E0/E1/... 虚拟专家 top-k 门控再传播。
- [x] 新增 novelty policy：`novelty_policy.ts`，`routeUncertain`、`moeMaxScore<0.08`、负 reward + HighEntropy 触发 L0 新主题锚点。
- [x] 保持“始终注入”策略：`content_match`/`best_effort` 只标 `uncertain=true`，不再 abstain historical prior。
- [x] `_last_state.json` 保存 `routeUncertain/moeMaxScore`，下一轮 backward 可消费。
- [x] 修复 extension runtime symlink：`~/.pi/agent/extensions/textron/{moe_router,novelty_policy}.ts`。
- [x] 文档：最新进展写入 `PROGRESS_2026-07-21_moe_novelty.md`。
- [ ] 运行时验收：检查 `route_done(policy=always_inject_and_let_backward_converge)`、`moe_route_done(maxExpertScore)`、`semantic_add_node_synthesized(targetLayer=0)`、`semantic_backward_apply(nodeMutations)`。
- [ ] 污染修正观察：`L2::node_32` 仍保存旧中间态“低置信 abstain”；后续 backward 应更新为“始终注入+收敛治理”。

## 步骤⑥ 深度分析结论（2026-07-20，176轮 backward + _events.jsonl）

- 前向：L0 LLM 打分失败 **213+ 次**（几乎全是 Empty response content，多模式重试均败）→ local fallback 兜底
- 反向：reward 正27/负66/零83；近20次 apply 中 15 次 +0.02 兜底；HighEntropy 缺失 **489 次**；reward 日均值 -0.12→-0.19→-0.53 恶化
- 内容：节点高熵性 ✅；但 astro_stock_prediction 混入开发类知识（污染）
- 趋势：正确率 45.5%→52.9%→50.0% 波动无上升

优化清单：

- [ ] ~~P0: 去掉 +0.02 假正 reward 兜底~~（2026-07-20 用户决定**不改**，保留原逻辑；证据留档：_events apply 日志 + L2::node_52“兜底弱正会稀释真信号”）
- [ ] P1: L0 打分 213+ 次空响应——调查 provider 空响应根因（疑 max_tokens 截断/拒答），加重试降级链落点记录
- [ ] P1: HighEntropy 缺失 489 次——提取失败时用 assistant 正文经 buildAtomKey/distillNodeName 自动蒸馏兜底
- [ ] P1: 审计负 reward 的 `noise_penalty` 范围——第16轮激活边仅11条，但日志显示大量非激活边同时降权；确认是否会造成全图权重塌缩，并将惩罚限制到选中路径或可证明相关的邻边
- [ ] P2: 网络污染隔离——非星象任务禁入 astro_stock_prediction（路由策略或 taskFamily 强制）
- [ ] P2: ngram_distill_skip 82 次——分析跳过原因分布
- [ ] P3: 实现 L2::node_52 提出的“权重均值收敛”监控指标

## Lifecycle feedback 边界（2026-07-21）

- [x] 控制性确认/继续/等待消息不触发 semantic backward，并保留前一真实任务状态
- [x] 长重启交接（>420字符）按明确 lifecycle intent 识别，不再因长度绕过分类
- [x] 控制轮在 `agent_end` 不覆盖或创建待反馈状态，即使旧状态/HighEntropy 为空
- [x] `_last_state.json` 恢复时丢弃已持久化的控制任务，避免旧版本污染跨重启延续
- [x] 修复 `_last_state.json` 仅保存前500字符导致长控制消息恢复误判；`rawUserPrompt` 改完整保存，`effectivePrompt` 保留4000字符
- [x] 真实结果反馈只触发上一轮 backward，`agent_end` 立刻清空待反馈状态并删除 `_last_state.json`，避免下一轮预测任务被用来评价反馈复盘
- [ ] 重启后运行时验收新增保护：`semantic_backward_skipped`、`agent_end_state_preserved`、`state_restore_skipped`/`agent_end_state_cleared`；真实结果反馈仍须触发负/正 reward

## Scale-Rescue 启发 1（2026-07-20 已实现，Wang–Zahl inspired）

## Scale-Rescue 启发 1（2026-07-20 已实现，Wang–Zahl inspired）

理论来源：王虹–Zahl 3D Kakeya 证明（arXiv:2502.17655）元操作——任意集合在【正确尺度】下都有分形结构；蒸馏失败 = 尺度错误，不是垃圾。主定理（任意凸集并的体积估计）远超 Kakeya 本身，是为“意外收获”。

已实现：

- [x] `name_distill.ts` 新增 `buildAtomKey()`：从被拒内容提取 top 高熵关键词，阅读序 `·` 连接（避免 ngram-fragment 隔离 regex），<2 个区分词才返回 null（真无结构才放弃）。已单测。
- [x] `index.ts` 新增 `rescaleRejectedCrystal()`：按拒绝原因分两路
  - downscale（too_long/low_entropy/raw_ops/temporal/truncated/meta）→ 原子锚点节点，经 addPolicyNode mergeSimilar 去重
  - upscale（too_short/not_transferable）→ `_rescale_pending.json` 缓冲（上限 20，FIFO），同层 tokenSimilarity≥0.2 片段配对合并成主题节点再过 gate
- [x] 四处拒绝分支已接入：`applySemanticNodeUpdates`、`autoBackward` add_nodes、手动 filledNodes ×2。skipReasons 带 `→rescale:<action>` 后缀。
- [x] rescale 事件记录到 `_events.jsonl`（type=rescale）。

后续待办：

- [ ] ngram distill 拒绝路径（`ngram_distill_skip`，~2790 行）尚未接 rescale——旧内容仍在节点上不算丢失，优先级低；若要接，走 downscale-only。
- [ ] 观察指标（跑一周后回顾 `_events.jsonl`）：downscale/upscale 触发频率、atom 节点占比、pending 缓冲配对成功率、atom 节点是否被 L0 打分命中。
- [ ] 若 atom 节点泛滥：提高 `buildAtomKey` 的 minTokens 或加 atom 专用容量上限。
- [ ] `prepareContextLine` 读路径隔离不接 rescale（设计如此：读路径只过滤展示，不学习）。

## Scale-Rescue 启发 2-5（待实现）

- [ ] 启发 2：节点显式尺度标签（`<meta name="scale">`，词熵/长度估算粒度）；forward 时先估计 query 尺度谱，scale-matched routing 而非一律 L0 打分；合并/去重改多尺度 TF-IDF（bigram/word/phrase 三尺度加权）——“在正确尺度上比较两个集合”。
- [ ] 启发 3：clumpy/regular 二分 → 正交性判据完备化。新知识与已有节点关系必居三类（重叠 merge / 同域异面共存对照 / 全新 add），引入同层横向边保存“同域异面”对照关系，避免 merge 丢失差异信息。
- [ ] 启发 4：induction on scales → L0 自相似一致性巡检。L0 节点 name 应 ≈ 下游节点 name 集合的再蒸馏（name of names 分形塔）；用现成 `sharesKeywordWithContent()` 巡检，失配触发 L0 重蒸馏。
- [ ] 启发 5：distill 管线 API 化（`textron distill <text> --scale=N`），供代码库知识图谱/对话记忆/skill 库复用——textron 的“体积估计定理”。

## Critical: implement strict forward/backward learning loop

Target loop:

1. User sends current input `U_n`.
2. Before AI answers, Textron runs forward propagation based on `U_n`:
   - score L0 nodes using the current user input
   - propagate through weighted graph
   - select path nodes
   - compile selected node context
   - inject compiled context into the prompt/system prompt before the AI answer
3. AI answers and must include a compact high-entropy summary at the end:

```xml
<HighEntropy>
≤200 chars: reusable high-entropy summary of the answer's decisions, fixes, reasoning, and transferable implementation insight. No raw logs, file listings, or session summaries.
</HighEntropy>
```

4. On the next user turn `U_{n+1}`, before answering, Textron must run backward for the previous turn using:
   - current user input / feedback `U_{n+1}`
   - previous selected path `P_n`
   - previous AI answer high-entropy summary `H_n` extracted from `<HighEntropy>...</HighEntropy>`
5. Backward must produce reward + node/edge update instructions, then update the graph.
6. Backward must complete before the new forward pass for `U_{n+1}` starts.
7. After backward finishes, run the normal forward process for `U_{n+1}` and answer.

## Missing / broken pieces to implement

- [x] Inject a mandatory `<HighEntropy>...</HighEntropy>` instruction into the assistant prompt for every turn.
- [x] Capture assistant final output or stream deltas and extract `<HighEntropy>`.
- [x] Persist `lastAssistantHighEntropy` alongside `lastUserPrompt`, `lastActivatedIds`, and `lastSelectedEdgeIds`.
- [x] Add `lastAssistantHighEntropy` to `semanticBackwardLLM` input.
- [ ] Change next-turn backward from fire-and-forget to awaited execution before current-turn forward. *(Deferred by design: current requirement is "backward need not await; ensure reverse updates happen".)*
- [x] Stop zero-activation raw user prompt seeding into L0. Never create L0 nodes from raw user text.
- [ ] Add a quarantine/quality filter so low-entropy existing nodes do not participate in scoring/propagation.
- [x] Avoid manual network edits as a normal workflow. Project TODOs belong in repo files, not Textron nodes.

## Design principle

Textron is an external small brain for agent use, not a memory log. Network nodes should store transferable decision patterns, routing keys, and high-entropy reusable principles. Raw commands, HTTP checks, process IDs, UI restart messages, user prompt copies, and session summaries must never become graph nodes.

## Implemented (2026-07-04 ~ 07-05)

- [x] HighEntropy fallback updates all selected path layers (L0/L1/L2), not only deepest.
- [x] Fallback layers get progressively longer content (≤48/≤100/≤120 chars), not identical copies.
- [x] No hardcoded layer roles (L0≠trigger, L1≠tradeoff, L2≠tactic). Network learns orthogonal roles via edge-weight training.
- [x] Node update merged with old content instead of blind replacement. High overlap → append new tokens; low overlap → `|` separator; ≤120 char cap.
- [x] Compiled Textron context injected into user prompt (not system prompt), wrapped in `<TextronSkill>` XML tags.
- [x] New network auto-creation replaced with node expansion on best-match existing network. `init` and `backward` auto-create both redirected.
- [x] nbeat bridge uses generic `NBEAT_PI_EXTRA_ENV_JSON` + `NBEAT_JOB_STATE_FILES` instead of Textron-specific env vars.
- [x] nbeat child Pi scoped `textron_state.json` via `TEXTRON_STATE_FILE` env for create→refine backward continuity.
- [x] nbeat UI backend selector (LMMS / PCM) with same style as Deliverables chips.
- [x] Modular synthesis backend architecture: `scripts/backends/{pcm,lmms}.py` + dispatcher `generate_beat.py`.

## Convergence: making Textron learn like a real neural network

Research summary from NLP classics, graph algorithms, entropy theory, and 2024 GNN convergence papers.

### Current bottleneck

- Edge weights update per-sample with no convergence target.
- No loss function; qualityScore oscillates without downward trend.
- No regularization; nodes can duplicate or overfit.
- Forward propagation runs once; no guarantee of stable activation distribution.

### P0: PageRank-style iterative propagation to steady state

**Source**: Brin & Page (1998), Markov chain convergence theory.

Forward should iterate until node activations stabilize: ∥aₜ₊₁ − aₜ∥ < ε.
Connected non-bipartite graph guarantees unique stationary distribution πP = π.
Maps to Textron: edge matrix as stochastic matrix; steady-state activations = truly learned path.

### P0: Entropy-driven node quality

**Source**: Shannon entropy, Maximum Entropy Principle (Jaynes, 1957).

Replace regex-based validateKnowledgeCrystal with: node_score = H(content) × relevance(task).
High-entropy nodes = dense information per token → preferred in scoring.
Low-entropy nodes (template, repetition, operational traces) → penalized.

### P1: Spreading Activation with depth decay

**Source**: Collins & Loftus (1975), Anderson (1983) ACT-R.

Activation should decay with layer depth: a[l+1] = a[l] × W × γ^l, γ ∈ (0.85, 0.95).
Creates natural "highway" paths (frequently reinforced) vs "trail" paths (low-frequency).
Long paths require stronger edge weights to survive.

### P1: Curriculum learning / difficulty schedule

**Source**: Bengio et al. (2009).

Backward learning rate modulated by task difficulty:
- reward > 0.5 → lr × 1.5 (easy, learn fast)
- 0.1 < reward < 0.5 → lr normal
- reward < 0.1 → lr × 0.3 (hard, conservative)
Warm-up period: first 10 tasks only use high-reward samples.

### P2: Intra-layer orthogonality penalty (contrastive)

**Source**: InfoNCE (Oord et al., 2018), SimCLR (Chen et al., 2020).

Nodes within same layer should be mutually orthogonal.
If Jaccard(sim) > 0.6 between two L0 nodes → weaken their outgoing edges by ×0.95.
Forces the network to learn differentiated routing rather than redundant copies.

### P2: TF-IDF weighted node scoring

**Source**: Salton (1970s), Deerwester (1990) LSA.

Words appearing across many nodes have low discrimination power.
L0 score *= (1 − log(df)/log(N)). Pushes nodes toward unique content.

### P2: Over-smoothing prevention (GNN theory)

**Source**: 2024 NeurIPS/ICML GNN convergence papers.

GNNs collapse to uniform node representations without residual connections + normalization.
Textron faces the same risk: nodes converging to similar content.
Apply: mergeContent already provides residual (old + Δ); add explicit normalization step.

### Convergence metrics to track

- ∥W[t] − W[t−1]∥ → 0 (weight stability)
- Steady-state activation entropy → stable
- Median qualityScore trend → increasing
- Intra-layer mean cosine similarity → decreasing
- Node content H mean/median → stable

### Not applicable (with reasons)

- Gradient descent / backprop: Textron has no differentiable loss; reward is discrete.
- Batch training: Textron is online (one sample per turn). Could simulate via moving average of gradients.
- Dropout: No parameter matrix to randomly zero; entropy regularization serves similar purpose.
- Adam/W optimizer: Edge updates are per-path, not per-parameter; momentum could be added but low priority.
