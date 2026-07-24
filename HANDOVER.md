# 交接：pending 管理修复 + 重启验证

## 已修 Bug

### 1. `compactMergeEmptiedNodes` 传参错误（index.ts:1712）
- **根因**：调用 `compactMergeEmptiedNodes(net, emptiedByMerge, onLog)` 传了 3 个参数，函数签名只有 2 个 `(net, onLog)`
- **现象**：`onLog is not a function` → 整个 backward apply 阶段崩溃
- **修复**：改为 `compactMergeEmptiedNodes(net, onLog)`

### 2. fake feedback 抢先消费 pending
- **根因**：pairing_judge 将"等待/中间消息"误判为反馈 → backward 执行（LLM 返回 reward≈0/零更新）→ 代码无条件消费 pending
- **现象**：第 31 轮"请等待 planner 对答案"消息消费了"A股涨跌预测"pending，真正反馈到达时无 pending 可匹配
- **修复**：`forcedSemanticBackward` 返回后加守卫——
  ```
  hadLearning = nodesUpdated>0 || nodesAdded>0 || nodesMerged>0
  hadReward   = abs(reward) >= 0.05
  shouldConsume = hadLearning || hadReward
  ```
  无学习则保留 pending。

### 3. 日志埋点
- `before_agent_start`：内存状态/磁盘读取/pending 列表构建
- `agent_end`：写盘内容（activeType + stackTypes）
- 消费后：剩余栈状态

---

## 重启后验证

```bash
# 重启 planner + coder
curl -X POST http://localhost:8770/restart/planner
curl -X POST http://localhost:8770/restart/coder
```

### 验证项

| # | 验证 | 方法 |
|---|------|------|
| 1 | `compactMergeEmptiedNodes` 不崩溃 | 发反馈 → backward → 检查 events 无 `onLog is not a function` |
| 2 | fake feedback 不消费 | 预测后发"等待"消息 → 检查 `agent_pending_preserved_no_learning` 事件 |
| 3 | 新日志字段出现 | 检查 events 中 `pending_list_built`/`task_stack_restored` 含 `activeType`/`stackTypes` |

---

## 当前状态

- 网络：`astro_stock_prediction` [8,7,29]=44 节点
- 第 31 轮：2025-01-23，预测 UP 0.55 → 实际 UP +0.515%，命中 ✅
- 第 32 轮：2025-01-24，预测 DOWN 0.63 → 实际 UP +0.695%，未命中 ❌（backward✅ reward=-0.7）
- 第 33 轮：2025-01-27，预测 UP 0.58 → 实际 DOWN -0.062%，未命中 ❌（backward🔴未触发）
- 累计：近 5 轮 2 胜 3 负

### P0修复验证结果（2026-07-23 第32轮）

| # | 验证项 | 状态 |
|---|--------|------|
| 1 | compactMergeEmptiedNodes 不崩溃 | ✅ 通过 |
| 2 | fake feedback 不消费 pending | ✅ 通过（pairing_judge正确配对，hadLearning守卫生效） |
| 3 | 日志埋点 | ✅ 通过（activeType/stackTypes正常输出） |

**完整闭环已验证通过**，无需重启。

---

## 架构变更：backward 移至 agent_end

### 变更
- **Old**: before_agent_start 中配对后立即执行 backward → LLM 需从 raw 上下文编造 Training signal
- **New**: before_agent_start 配对后仅设 `_backwardPendingMatch` 标记 → agent_end 提取 assistant 的最新 HighEntropy → 注入 backward LLM 的 prompt 作为 "Assistant's analysis" → 执行 backward

### 优势
assistant 刚生成的 HighEntropy（root cause analysis + corrective rules）直接作为附加训练信号注入 backward LLM，不再需要 LLM 从零编造。

### 测试
重启后跑一轮预测→反馈闭环，检查 backward events 中 `mode=agent_end_deferred` 即确认新路径命中。

### 重要变更：预测 HighEntropy 不注入 backward LLM
`forcedSemanticBackward` 的 `previousAssistantHighEntropy` 参数传 `""`（空字符串），因为错误预测的 HighEntropy 标注为 "training packet" 会误导 backward LLM。替代：`enhancedFeedback` 中已有助理刚生成的深度复盘。

### 待测清单（重启后，第34轮）
1. `mode=agent_end_deferred` 出现 ← 确认 backward 在新路径触发
2. coder 复盘生成 HighEntropy 块（含根因+修正规则）← 确认 HIGH_ENTROPY_INSTRUCTION 生效
3. `agent_end_backward_skipped` 事件 → 若出现看 `reason` 定位断点
4. 节点内容出现 R/Rx/修正规则 等关键词
5. backward LLM prompt 中无 "预测UP 0.55" 等预测推理文本
6. MERGE DUTY 无退化
7. 冷启动正常

---

## 🔴 第33轮发现：backward 未触发 — 双重根因

**时间**：2026-07-23 第33轮测试（重启后首轮）

**症状**：planner通过coms_send发反馈→coder接收并回复（复盘无HighEntropy）→coder agent_end触发→**backward未执行**

**双重根因**：
1. **coder复盘无HighEntropy**：HIGH_ENTROPY_INSTRUCTION未强调复盘场景，coder以"收到"结尾，未生成HighEntropy块 → `currentAssistantHighEntropy`为空
2. **`_backwardPendingMatch` 可能为null**：before_agent_start的配对逻辑触发但可能未正确设置标记（待诊断日志确认）

**证据**：
- 04:25:15有highentropy_captured（planner预测消息的HE），04:26:18 coder agent_end无highentropy_captured
- agent_end只有task_stack_persisted，无semantic_backward_start
- pending列表含"星象预测反馈闭环"（应匹配）

**修复**（已完成，待重启生效）：
1. **HIGH_ENTROPY_INSTRUCTION增强**（index.ts:94）：`NEVER skip` + `lost learning opportunity` + 复盘`CRITICAL`
2. **agent_end诊断日志**（index.ts:2619+2691）：打印三个变量值 + else分支记录跳过原因

### 2026-07-23 HIGH_ENTROPY_INSTRUCTION 增强 + agent_end 诊断日志

**问题1**：原HIGH_ENTROPY_INSTRUCTION未强调复盘/反馈场景，coder在复盘回复时跳过HighEntropy（以"收到"结尾）→ agent_end无assistant分析可注入backward → backward LLM训练信号缺失。

**修复1**（index.ts:94 HIGH_ENTROPY_INSTRUCTION）：
1. 加强制性：`NEVER skip this block — even for short replies like "收到"`
2. 明后果：`missing HighEntropy = lost learning opportunity`
3. 复盘专项：Technique字段新增 `CRITICAL for reflection/feedback replies: pack root cause analysis AND corrective rules`

**问题2**：agent_end中backward未触发，无法判断是_backwardPendingMatch为null还是HighEntropy/finalAssistantText为空。

**修复2**（index.ts agent_end）：
1. 在2619行条件前加console.error诊断，打印三个变量的实际值
2. 在if块后加else分支，记录`agent_end_backward_skipped`事件并注明跳过原因（no_pending_match vs no_assistant_content）

---

## 2026-07-23 本轮回改（4项，待重启生效）

### 1. merge 内容溢出 → 自动泻出新节点（index.ts:1486+1691）

**问题**：mergeContent/mengeNodeContent 去重后若仍超 NODE_CONTENT_MAX_CHARS (1000c)，多余内容直接丢失。

**修复**：两处溢出防护——
- **node_update 路径**（line 1486）：mergedContent > 1000c → 截断至 1000c + addDynamicNode(net, layer, overflow, onLog)
- **merge action 路径**（line 1691）：merged > 1000c → tgtNode 保留前 1000c + overflow → addDynamicNode(net, tp.layer, overflow, onLog)

两者均 `nodesAdded++` + `nodeMutations.push({ type: "add", ... })`。日志标记 `update overflow` / `merge overflow`。

### 2. monitor.html 布局修复：每层独立间距 + 垂直居中

**问题**：全局 maxN * GYa 统一间距导致 L0(4节点)挤在顶部、L2(30节点)拉满全高 → 左短右长。

**修复**：
- `layerPitch[l] = max(52, min(96, 2600 / cnt))` 每层按节点数独立算间距
- `layerOffset[l] = (H - (cnt-1) * pitch) / 2 + pitch / 2` 垂直居中偏移
- 节点 cy = layerOffset[l] + i * pitch - pitch/2 + jitter

各层节点在相同画布高度内居中分布，视觉对齐。monitor.html 通过软链接不需要重启。

### 3. MERGE 语义重叠阈值 30%→15%（index.ts systemPrompt + userPrompt）

**问题**：MERGE DUTY 长期零触发 (0/64+轮)，LLM 持续返回 `"no overlap ≥30%"` → node_actions=[keep]。

**修复**：systemPrompt Rule 7 + userPrompt node_update 条件 + MERGE SCAN 段三处 ≥30% → ≥15%，并加"shared keywords, concepts, or domain"语义描述。依据：TF-IDF RELATED 发现阈值 0.05，related pairs 典型 0.12-0.20，15% 在区间下沿。

### 4. boss.md 路径修正

`/Users/rama/textron/test.md`（缺 -agent）→ `/Users/rama/textron-agent/test.md`
