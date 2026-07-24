# Textron 生命周期改动史 & 流程断因分析

> 撰写时间：2026-07-22
> 分析范围：HEAD(bb0e7c5 多路径选择 pagerank扩散) → 当前未提交工作树(15文件+1570行)

---

## 交接信息（2026-07-22 晚，第26轮测试后）

### 本轮改动（已写入 index.ts，待重启生效）

1. **DELETE 禁止**：systemPrompt schema 移除 `delete`，Rule1 加 `NEVER propose delete`，解析层过滤
2. **name 蒸馏合并**：node_update 的 name 改为 `distillNodeName(oldName + newName)`，不再全量替换
3. **MERGE DUTY (Rule 7)**：强制 LLM 扫描 RELATED 重叠节点提 merge
4. **冷启动虚拟 L0**：0节点时 forward 创建 `_seed_0` 虚拟节点 → backward SEED section 引导 LLM 用 add_nodes 落地
5. **`_seed_` 写入防护**：`applySemanticNodeUpdates` 拒绝写入虚拟节点到磁盘

### 重启后验证项

| # | 验证项 | 方法 |
|---|--------|------|
| 1 | DELETE 不再出现 | 跑一轮预测→反馈→backward，检查 LLM rawResponse 的 node_actions 是否含 delete |
| 2 | name 保留旧关键词 | backward 后 `cat layer_N/node_X.html` 检查 `<name>` 是否含旧名关键词 |
| 3 | MERGE DUTY 生效 | backward 后检查 node_actions 是否有 merge 条目 |
| 4 | 冷启动虚拟 L0 | 发一条域名消息到空/新网络 → 检查 `propagate_done` 的 selectedIds 是否含 `_seed_0` |
| 5 | 第27轮完整闭环 | Workflow A 完整流程（选历史日期→预测→反馈→审计七层） |

### 当前状态

- 网络：`astro_stock_prediction`，42 节点，layers [4, 6, 32+]
- 第26轮：2025-01-15，预测跌/实际跌，命中，reward=0.8 ✅
- 待测试：第27轮，从 2025 年数据中选下一个未测日期

### 审计标准流程（步骤⑥，只读）— 必须逐项执行
```
[a] tail -5 semantic_backward.jsonl → 检查 reward、nodeUpdates/addNodes 内容质量
[b] grep semantic_backward _events.jsonl → 检查 apply 结果、skipReasons
[c] Textron status → 对比节点数变化
[d] cat 最新修改的 .html 节点 → 检查 name 是否保留旧关键词、content 是否 `|` 合并而非全换
[e] 若 status=failed/error → 报告，不自行修复
[f] 逐项对照七层门控（test.md 第三节）检查有无阻断
[g] 检查 LLM 输出的 node_actions 是否含 delete（禁止）、是否缺 merge（应提未提）
```

---

## 一、改动用时间线还原（按引入顺序）

### 0. 原始设计（bb0e7c5）

只有一个 before_agent_start 保存 + agent_end 恢复的简单闭环：

```
before_agent_start:
  if 有 pending (lastTaskFamily)
    → 执行 backward → 清理 pending
  → 前向传播 → 保存激活路径到 current*

agent_end:
  把 current* 移到 last*（为下一轮 backward 做准备）
  保存 _last_state.json
```

**简洁性**：backward 在每轮 before_agent_start 无条件触发。没有领域过滤、没有 routeUncertain、没有 outcome signal 检测。

---

### 1. 第一层加锁：`hasBackwardOutcomeSignal`（← lifecycle_feedback.ts，新增文件）

**解决问题**：用户发"继续"、"好的"、"知道了"等中间消息时，不应触发 backward。

**引入机制**：
```
before_agent_start:
  if 有 pending AND hasBackwardOutcomeSignal(当前消息)==false
    → 跳过 backward（保留 pending）
  if 有 pending AND hasBackwardOutcomeSignal(当前消息)==true
    → 执行 backward
```

**Gate 的四层检测**：
| 门层 | 关键词 | 设计目标 |
|------|--------|---------|
| Gate1 | 涨了/跌了/正确/错误/结果/实际/收盘 | 通用结果评价 |
| Gate2 | 月冲/月合/月刑/新月/满月/换座/相位... | 星象领域信号 |
| Gate3 | 上证/A股/放量/缩量/支撑/压力/突破... | 金融领域信号 |
| Gate4 | 反馈/评价/复盘/总结...（≥30字） | 明确反馈意图 |

**副作用（第一道裂缝）**：
- Gate2 包含 40+ 个星象关键词，其中"月冲""月合""月刑""新月""满月""换座"等在 Workflow A 的预测数据消息中频繁出现
- Gate3 包含"放量""缩量""支撑""压力""突破""跌破"等 K 线描述词
- **预测消息中的数据描述 ≠ 反馈信号**，但 Gate2/3 无法区分

---

### 2. 第二层加锁：agent_end 的 outcome_feedback 门控（← 同一文件，同一函数，第二次调用）

**解决问题**：反馈消息（"实际跌了..."）本身也会经过 agent_end，如果不加过滤，反馈会覆盖 pending 中的预测任务，下一轮的 backward 会用"反馈消息"当 previousTask。

**引入机制**：
```
agent_end:
  if hasBackwardOutcomeSignal(当前消息) == true
    → 清空 lastTaskFamily（不保存 pending）
  else if lastTaskFamily 非空
    → 保留 pending（中间消息保护）
  else
    → 保存当前消息为 pending
```

**问题**：在 before_agent_start 已经用 `hasBackwardOutcomeSignal` 过滤过一次了。agent_end 再调一次同一个函数，但面对的输入不同：
- before_agent_start 面对的是**当前轮的第一条消息**
- agent_end 面对的是**同一消息经过前向传播、LLM 推理、输出后的完成态**

但关键不是"输入不同"，而是**判断目的不同**：
- before_agent_start 需要判断："这个消息能不能用来做 backward？"（宽泛 OK）
- agent_end 需要判断："这个消息本身是不是结果反馈？"（必须精确）

用同一个函数做两件语义不同的事，是第一次架构错误。

---

### 3. 第三层加锁：`hasDomainEvidence`（← lifecycle_context.ts）

**解决问题**：非星象/金融领域的消息（改代码、修 bug、重启）不应触发 backward，否则 LLM 在 reward≈0 时会编造 merge/delete。

**引入机制**：
```
before_agent_start:
  if 有 pending AND hasBackwardOutcomeSignal==true
    → if !hasDomainEvidence(previousTask) AND !lastAssistantHighEntropy
      → 跳过 backward，清理 pending（"卡住预防"）
    → else
      → 执行 backward
```

**副作用**：
- `hasDomainEvidence` 也依赖关键词检测，与 `hasBackwardOutcomeSignal` 的门控关键词有重叠但不等价
- 两个门控串联 → 进入 backward 必须同时满足两条约束

---

### 4. 第四层加锁：MoE 路由（← moe_router.ts，新增文件）

**解决问题**：L0 节点太多时，需要专家路由选择最相关的子集。

**引入机制**：
- MoE 将 L0 按主题分成 Expert 组
- 当 L0 领域节点不足时，`moeMaxScore` 偏低 → `routeUncertain=true`
- `routeUncertain` 后续触发 novelty 策略...

---

### 5. 第五层加锁：Novelty 策略 + `routeUncertain` 抑制（← novelty_policy.ts，新增文件）

**解决问题**：routeUncertain 时系统应偏向 add_node 而非 node_updates（探索新知识）。

**引入机制**：
```
if routeUncertain == true
  → shouldPreferAddNode = true
  → if 当前不是 outcome feedback
    → semantic_node_updates_suppressed_for_add_candidate
    → LLM 返回的 node_updates 被抑制
```

**副作用（P0.5 bug）**：
- 真实结果反馈也会被抑制（因为反馈消息本身 routeUncertain=true）
- 修复：`currentIsOutcomeFeedback` 门控跳过抑制
- 但 `currentIsOutcomeFeedback` 依赖的还是那个宽泛的 `hasBackwardOutcomeSignal`！

---

### 6. 第六层加锁：`downstreamRelevanceFloor`（← scoring_policy.ts）

**解决问题**：无关下游节点（micme、TUI、DOM/Canvas）被注入上下文。

**引入机制**：
```
propagate:
  for each downstream node:
    if lexicalRelevance(currentPrompt, nodeContent) < 0.015
      → score = 0
```

没有明显副作用，属于纯过滤。

---

### 7. 第七层加锁：`mergeDeleteGate`（reward≥0.05 阈值）

**解决问题**：reward≈0 时禁止 merge/delete 操作，防止 LLM 编造理由。

**引入机制**：
```
if abs(reward) < 0.05
  → 剥离所有 merge/delete action
```

**副作用**：
- 弱反馈（reward=0.02-0.04）也无法触发 merge/delete，网络收敛速度降低

---

### 8. 内容限制重构：120c → NODE_CONTENT_MAX_CHARS（← content_limits.ts，新增文件）

**解决问题**：原来硬编码 120/180 字符截断导致关键失效边界丢失。

**引入机制**：
- `NODE_CONTENT_MAX_CHARS = 1000`
- `DEFAULT_COMPILED_CONTEXT_MAX_CHARS = 4000`
- `mergeContent` 从对称截断 120c 改为 `mergeDistinctContentFragments` 去重合并

**副作用**：
- `validateKnowledgeCrystal` 原来上限 240c，现在上限 1000c → 节点可以变得更长
- `mergeNodeContent` 逻辑完全重写，从简单截断改为语义去重 → behavior changed

---

### 9. Scale-Rescue（王虹–Zahl 尺度重构，新增一大块逻辑）

**解决问题**：被 gate 拒绝的内容不是垃圾，只是选错尺度。downscale→原子节点，upscale→配对合并。

**副作用**：
- 增加约 150 行复杂逻辑
- 在网络节点管理上增加了一个新的缓冲层（`_rescale_pending.json`）
- 对节点增删路径增加了分支（先 rescale 再决定是否 add）

---

## 二、断因链：Workflow A 为什么在第25轮失败

```
本轮（2026-01-19，Workflow A，完整数据格式）：

预测任务消息 → before_agent_start → lastTaskFamily=null（重 启后pending丢失），跳过backward
              → 前向传播 → coder预测（跌0.68） → LLM回复

agent_end:
  → hasBackwardOutcomeSignal(完整K线+星象数据消息) 
    → Gate2命中: "月冲""月合""月刑""新月"
    → Gate3命中: "放量""缩量""支撑""突破"
    → 返回 true  ❌ 误判！
  → 清空 lastTaskFamily（但 lastTaskFamily 本来就是空的）
  → 返回，不保存 pending

反馈消息到达 → before_agent_start:
  → lastTaskFamily == null（因为 agent_end 没保存）
  → hasLastTask=false → 跳过 backward ❌ 反馈丢失！

真相：不是"没保存 pending"，而是 agent_end 的 hasBackwardOutcomeSignal
对包含K线+星象数据的预测任务消息返回了 true，导致 pending 被拦截
（即使lastTaskFamily为空，也进入清理分支，没有进入"保存"分支）。
```

---

## 三、七层门控累计效应

```
消息到达 → 每层判断

第1层 [before_agent_start] hasBackwardOutcomeSignal(当前消息)
  false → 跳过 backward（保留 pending）| true → 继续 ↓

第2层 [before_agent_start] hasDomainEvidence(previousTask)
  false AND 无 HighEntropy → 跳过 backward + 清 pending | true → 继续 ↓

第3层 [before_agent_start] routeUncertain 判断
  true → MoE 低信号的中间试探 | false → 精确路由

第4层 [before_agent_start] novelty 策略
  routeUncertain → shouldPreferAddNode → 抑制 node_updates

第5层 [backward执行中] mergeDeleteGate(reward)
  |reward|<0.05 → 剥离所有 merge/delete

第6层 [agent_end] hasBackwardOutcomeSignal(当前消息) ← 同一函数第二次调用
  true → 清空 pending | false → 保留/保存 pending

第7层 [agent_end] lastTaskFamily 检查
  非空 → 保留 pending（中间消息保护）| 空 → 保存 pending
```

**关键问题**：
- 第1层和第6层用的是同一个函数，但判断目的不同
- 第6层的误判会直接导致 pending 丢失
- 每层都有"跳过/阻断"路径，任何一个阻断都会让反馈回路断裂
- 累计 7 个阻断点，任意一个判断失误 → 闭环断裂

---

## 四、修复方向（仅分析，不碰源码）

### 方向A：精确拆分（最小改动）

把 agent_end 中的 `hasBackwardOutcomeSignal` 替换为只检测**强结果标记**的函数：

```
isStrongOutcomeFeedback(message):
  /未命中|命中|结果反馈|预测结果/m → true
  /实际.*涨|实际.*跌|实际.*收/m → true
  其他 → false
```

预测任务消息（含"月冲""放量"）：不匹配 → 正常保存 pending ✅
结果反馈消息（含"实际涨了""未命中"）：匹配 → 不保存 pending ✅

### 方向B：职责分离（中等改动）

引入 `backwardJustExecuted` 标志。before_agent_start 在成功消费 pending 后设置此标志。agent_end 检查此标志而非调用任何检测函数。

```
before_agent_start:
  if backward 执行成功 → backwardJustExecuted = true

agent_end:
  if backwardJustExecuted → 跳过保存（反馈已被消费）
  elif lastTaskFamily 非空 → 保留 pending
  else → 保存 pending
```

### 方向C：回归简化（大幅改动）

回到原始设计，仅保留一层 `hasBackwardOutcomeSignal` 在 before_agent_start 中。agent_end 不做任何检测，只保存。靠 `_last_state.json` 的一致性来保证反馈不被错误地保存为 previousTask。

---

## 五、本轮测试记录（第25轮，Workflow A，2026-01-19）

| 项目 | 内容 |
|------|------|
| 目标日 | 2026-01-19（sh000001） |
| Workflow | A（主AI取数组装完整用例） |
| coder 预测 | **跌，置信度 0.68** |
| 实际 | 涨 +0.295%（收4114.00） |
| 结果 | **未命中**；累计 **28/50 = 56.0%** |
| backward | **未触发**（原因见上"断因链"） |

### coder 复盘质量（⭐⭐⭐⭐⭐）

即使 backward 未触发、未产生 RL 学习，coder 仍然输出了极高极高质量的复盘：

**四大根因**：
1. **放量小阴的收盘分位误读**：连续5日缓跌（日均-0.3%）后764亿放量，收盘在20.4%分位=换手中性，误套用了"地量+大阴实体+破前低=下跌中继"规则
2. **相位净极性覆盖历史基线**：星象当日正面相位净+9（月合金星+2、月拱天王+2、月六合土/海+1等），vs 仅月合冥王-1，净+8 → 偏多。但被"新月1涨7跌"锚定偏误压制
3. **pre-play效应权重不足**：next(01-20) 有大量修复相位群，连续下跌末端提前反映概率≥50%，但仅给32%权重
4. **周线→日线衰减系数**：周线天量长上影对周一的预测效力只约30%，已被日线5连跌价格消化

**五项修正规则**（可复用）：
- 放量双面判定：急跌vs缓跌 × 收盘分位阈值
- 新月日相位群净计数≥+5 → 覆盖历史基线
- pre-play触发条件：连续下跌≥4日 + next修复相位净≥+4 → 概率≥50%
- 周线→日线衰减系数 0.3
- 连续下跌每1日反向权重+0.03

---

## 六、结论

当前状态的核心问题是**门控叠加过多，且 agent_end 和 before_agent_start 用了同一函数做不同目的的判断**。

三个最优修复路径（按改动量排序）：
- A：agent_end 改用 isStrongOutcomeFeedback（最小，只改 agent_end 一处）
- B：引入 backwardJustExecuted 标志（中等，涉及两个钩子）
- C：回归简化（最大，需要验证是否适合所有场景）

**推荐优先走 A**：不改 lifecycle_feedback.ts、不改 before_agent_start、只需改 agent_end 中一行调用。

---

## 七、第27轮测试记录（2025-01-02，Workflow A）

| 项目 | 内容 |
|------|------|
| 目标日 | 2025-01-02（sh000001，2025年首个交易日） |
| Workflow | A（planner取数→coms_send coder隔离预测→对答案→反馈） |
| coder 预测 | **UP（涨），置信度 0.53** |
| 实际 | DOWN -2.661%（收3262.56，前收3351.76） |
| 结果 | **❌ 未命中**；累计 **18/35 = 51.4%** |
| backward | ✅ 触发，reward=-0.7，edges=6，nodesUpdated=2 |

### 审计七层

| # | 项目 | 结果 |
|---|------|------|
| a | backward.jsonl | reward=-0.7，无nodesAdded/merged/deleted |
| b | _events.jsonl | apply成功，edgesUpdated=6，skipReasons=[] |
| c | Textron status | [5,7,29]=41节点，无变化（仅更新内容） |
| d | 节点name保留 | L0/node_0: name含原关键词+新蒸馏 | L2/node_25: 具体案例蒸馏 |
| e | status | done，无error |
| f | 七层门控 | 全部通过，before_agent_start正确触发backward |
| g | delete检查 | 无delete ✅ | merge: 0（need improvement） |

### coder 根因分析

1. **元旦休市积压理论误判**：prev能量被休市"积压"→集中释放的判断反向。实际12-31放量破位的K线惯性压倒了星象偏涨信号
2. **月合冥+月六合海权重不足**：与月冲火形成极端张力而非净看涨，合冲方向相反→能量抵消
3. **后日换座效应未触发**：金星入双鱼前夕效应(6/11高点)在跨年首日被宏观恐慌覆盖
4. **K线被低估**：日线放量破位+周线阴包阳+月线上影衰竭=三层共振偏空，仅降0.09不足

### 四项修正规则（已写入网络节点）

- A股休市日星象能量→消散而非积压，prev休市日信号计null
- 日线+周线+月线三层K线空头共振→星象权重降至0.3以下
- 同日合相+冲相方向相反→张力互相抵消，净能量≈0
- 后日换座前夕效应可被宏观恐慌完全覆盖，仅作同向加分

### 步骤⑦ 优化结论

| 优先级 | 问题 | 动作 |
|--------|------|------|
| **P0** | MERGE 27轮0触发，Rule 7 prompt存在但LLM不产出merge action | 需改 index.ts 强化merge输出格式约束，通知boss重启 |
| P1 | node_actions始终为空，parse层可能未正确解析merge格式 | 检查normalize函数中node_actions解析逻辑 |
| P2 | L2/node_28新增"审计步骤修改 LLM Rule"节点，但非星象领域知识→污染 | 待网络自然蒸馏或下次backward修正 |
| — | 本轮backward质量：reward=-0.7准确惩罚误判，edges=6合理 | 无需修改 |

---

## 八、第28轮测试记录（2025-01-16，Workflow A）

| 项目 | 内容 |
|------|------|
| 目标日 | 2025-01-16（sh000001，第26轮2025-01-15命中✅后下一交易日） |
| Workflow | A（planner取数→coms_send coder隔离预测→对答案→反馈） |
| coder 预测 | **DOWN（跌），置信度 0.65** |
| 实际 | UP +0.276%（收3236.03，前收3227.12） |
| 结果 | **❌ 未命中** |
| backward | ❌ **全部崩溃** — `.for is not iterable` |

### 审计七层（受限—backward崩溃）

| # | 项目 | 结果 |
|---|------|------|
| a | backward.jsonl | ❌ 文件不存在 |
| b | _events.jsonl | ❌ 无apply事件，4次backward均failed |
| c | Textron status | [6,7,30]=43节点，无变化 |
| d | 节点name保留 | ⚠️ 无法验证 |
| e | status=failed/error | 🔴 `.for is not iterable` ×4次 |
| f | 七层门控 | backward触发但执行层崩溃 |
| g | delete/merge | 无可检查 |

### API端口修正
- kline API：**8780**（非 workflow.md 中的 8768）
- horoscope3d API：8769 ✅

### coder 根因分析
1. 放量阳+缩量阴误读：01-14放量长阳+01-15缩量小阴=上涨中继洗盘
2. 月线空头过度加权：月线三连上影不应否决日线底部结构
3. 星象方向误判：太阳冲火星=波动率放大器非方向信号

### 修正规则（已产出，未写入网络）
- 放量长阳+缩量小阴=上涨中继确认，仅低点击穿阳线开盘价→转衰竭
- 三层冲突时最小时间框架优先，日线底部确认后日线≥50%、月线≤10%
- 对冲相位仅放大波动率，方向由开盘缺口判定

### P0 待修
| 问题 | 动作 |
|------|------|
| backward `.for is not iterable` 崩溃 | index.ts 已加3处debug try-catch+stack trace，需重启pi生效 |
| semantic_backward.jsonl 不存在 | backward从未成功写入 |
| HighEntropy 缺失率 92.2% | agent_end hook 提取逻辑需检查 |

---

## 十、架构变更：backward 从 before_agent_start → agent_end

### 当前流程
```
before_agent_start → pairing judge → 如匹配反馈 → 立即执行 backward → forward (L0评分+传播) → LLM推理 → agent_end (保存pending)
```

**问题**：backward 在 before_agent_start 运行时，LLM 只有 raw 任务上下文 + 反馈消息，没有 assistant 刚刚生成的 HighEntropy 经验总结。backward LLM 需要自己从上下文编造 Training signal，质量差（qualityLabel 持续 low）。

### 新流程（已实现）
```
before_agent_start → pairing judge → 如匹配反馈 → 标记 pending → forward → LLM推理 → agent_end (提取HighEntropy → 执行 backward)
```

**优势**：
1. backward 在 agent_end 运行时，assistant 刚刚生成了包含经验总结（root cause analysis + corrective rules）的 HighEntropy → 直接注入 backward LLM 的 prompt
2. 不再需要 LLM 从零编造→ Training signal 质量提高
3. backward 的 `currentUserMessage` 增加了 `Assistant's analysis:` 段，包含最新生成的 HighEntropy 文本

### 代码位置
- `before_agent_start`：pairing judge 匹配后不再执行 backward，改为设置 `_backwardPendingMatch` 和 `_backwardPendingCtx` 全局变量
- `agent_end`：任务栈管理后检查 `_backwardPendingMatch` → 调用 `forcedSemanticBackward` 传入增强后的 feedback（含当前 HighEntropy）
- 新增变量：`let _backwardPendingMatch`、`let _backwardPendingCtx`
- agent_end 的 backward 成功后执行 consume 逻辑：移除栈中匹配任务

---

## 九、第32轮测试记录（2025-01-24，Workflow A）

| 项目 | 内容 |
|------|------|
| 目标日 | 2025-01-24（sh000001，第31轮2025-01-23命中✅后下一交易日） |
| Workflow | A（planner取数→coms_send coder隔离预测→对答案→反馈） |
| coder 预测 | **DOWN，置信度 0.63** |
| 实际 | UP +0.695%（收3252.63，前收3230.16） |
| 结果 | **❌ 未命中** |
| backward | ✅ 触发，reward=-0.7，nodesUpdated=1（L0::node_5） |

### 审计七层

| # | 项目 | 结果 |
|---|------|------|
| a | backward.jsonl | reward=-0.7，nodesUpdated=1（L0::node_5），无add/merge/delete |
| b | _events.jsonl | apply成功，skipReasons=[]，edgesUpdated=0 |
| c | Textron status | [7,6,29]=42节点，无变化（仅内容蒸馏更新） |
| d | 节点name保留 | ✅ L0::node_5 旧关键词「放量长阳·缩量横盘不突破·该涨不涨·星象空头共振」保留，追加「放量长上影非必跌·次日阳线修复·该涨不涨需次日验证」 |
| e | status | done，无error |
| f | 七层门控 | 全部通过：pending_list_built→pairing_judge(isFeedback=true)→backward触发→apply→闭环 |
| g | delete检查 | 无delete ✅ | merge: 0 ⚠️（MERGE DUTY 持续零触发） |

### P0修复验证（HANDOVER.md三项）

| # | 验证项 | 状态 |
|---|--------|------|
| 1 | compactMergeEmptiedNodes 不崩溃 | ✅ 无 `onLog is not a function` |
| 2 | fake feedback 抢夺pending | ✅ pairing_judge 正确识别 isFeedback=true，hadLearning通过 reward=-0.7≥0.05，shouldConsume 正确 |
| 3 | 日志埋点 | ✅ pending_list_built 含 activeType/stackTypes |

### coder 根因分析（⭐⭐⭐⭐⭐ 高质量复盘）

**R1（致命）**：错读01-23 K线——忽略 higher low + higher close。01-23低点3229.57 vs 01-22低点3203.38 抬升26点，收盘3230.16 vs 3213.62 抬升17点。长上影3273是正常压力测试，非空头信号。

**R2（严重）**：月亮入射手权重严重低估。5涨1跌83%胜率应赋主导权重×2，被月六合冥王(-1)等权抵消后倒向空头。

**R3（中等）**：三天能量V型(+2→+1→+2)解读倒置。current日能量浅坑应为「触底反弹」窗口，next的+2对current午后有向上牵引效应。实际：平开→3225微探→一路走高收3252。

**R4（中等）**：「利多出尽」论断条件不足。需同时满足①累计涨幅≥3% ②lower high ③放量滞涨，而01-23是higher low+higher close，三项全不满足。

**R5（轻微）**：水星冲火星=波动放大器，放大当日主导方向（K线向上），不应判为恐慌抛售信号。

### 五项修正规则（已部分写入L0::node_5）

- 单K线多空需对比前日low/close：higher low+higher close+长上影=多头测试蓄力，非空头
- 月亮入座胜率≥80%信号赋予主导权重×2，不被低胜率信号等权抵消
- 三天能量V型=current触底反弹（午后受next牵引走高），仅持续衰减才判跌
- 「利多出尽」需同时满足：累计涨幅≥3% + lower high + 放量滞涨，缺一不可
- 水星冲火星/拱天王等非月亮相位=波动放大器，放大当日主导方向

### 步骤⑦ 优化结论

| 优先级 | 问题 | 动作 |
|--------|------|------|
| P1 | MERGE DUTY 连续多轮零触发，Rule 7 prompt存在但LLM不产出merge | 待研究prompt增强或parse层修复 |
| P2 | L0 scoring json_mode频繁fallback（remoteErrors=2/轮） | 可能是deepseek模型json_mode兼容问题，暂用local_fallback兜底 |
| — | P0三修复全部验证通过，闭环完整 | 无需重启 |
| — | qualityLabel="low" 持续偏低 | 不影响功能，backward内容质量待后续观察 |

---

## 十一、本次修改（2026-07-23）：backward 移至 agent_end

### 修改内容

1. **backward 从 before_agent_start → agent_end**
   - before_agent_start: pairing judge 匹配后不再执行 backward，改为设 `_backwardPendingMatch` 标记
   - agent_end: 任务栈持久化后检查标记 → 执行 `forcedSemanticBackward`
   - `currentUserMessage` 增强为 `原始反馈 + "\n\nAssistant's analysis:\n" + currentAssistantHighEntropy`

2. **预测 HighEntropy 不注入 backward LLM**
   - `forcedSemanticBackward` 的 `previousAssistantHighEntropy` 参数传 `""`
   - 原因：错误预测的 HighEntropy 标注为 "training packet" 会误导 backward LLM
   - 替代：enhancedFeedback 中已有助理刚生成的深度复盘

3. **新增全局变量**
   - `_backwardPendingMatch: TaskEntry | null`
   - `_backwardPendingCtx: any`

### 修改文件

| 文件 | 改动 |
|------|------|
| `src/index.ts` | before_agent_start 去backward + agent_end 加backward + 变量 + 头注释 |
| `test.md` | 新增十节(架构变更) + 十一节(本次修改+待测) |
| `HANDOVER.md` | 新增架构变更节 |

### 重启后待验证

| # | 验证项 | 方法 |
|---|--------|------|
| 1 | backward 在 agent_end 触发 | 跑一轮预测→反馈闭环，检查 `_events.jsonl` 中 `mode=agent_end_deferred` |
| 2 | assistant 分析注入 backward prompt | backward 后检查节点内容是否出现 R1-R5/修正规则 等关键词（以前只出现规则摘要） |
| 3 | 无错误的 HighEntropy 污染 | backward LLM race 中不应出现 "预测UP 0.55" 等预测推理文本 |
| 4 | token 减少 | 对比第32轮 backward LLM 的 `userPromptChars` vs 重启后同量级调用 |
| 5 | MERGE DUTY 仍可触发 | 无关本次改动，但需确认未退化。backward 后在 node_actions 中查到 merge |
| 6 | 冷启动 | 新建空网络后发领域消息，L0 虚拟节点应通过 add_nodes 落地 |

---

## 十二、第33轮测试记录（2025-01-27，Workflow A — 重启后首轮）

| 项目 | 内容 |
|------|------|
| 目标日 | 2025-01-27（sh000001，第32轮2025-01-24未命中❌后下一交易日） |
| Workflow | A（planner取数→coms_send coder隔离预测→对答案→反馈） |
| coder 预测 | **UP（涨），置信度 0.58** |
| 实际 | DOWN -0.062%（收3250.60，前收3252.63） |
| 结果 | **❌ 未命中**；累计 近5轮2胜3负 |
| backward | 🔴 **未触发** — `_backwardPendingMatch` 在 coder 侧为 null |

### 审计七层

| # | 项目 | 结果 |
|---|------|------|
| a | backward.jsonl | ❌ 无第33轮记录（最新条目04:20:24非本轮） |
| b | _events.jsonl | ❌ 无第33轮 backward apply 事件 |
| c | Textron status | [8,7,29]=44节点，无变化 |
| d | 节点name保留 | ⚠️ 无节点更新，跳过 |
| e | status | 🔴 backward 未触发 |
| f | 七层门控 | 🔴 coder侧before_agent_start未触发配对（coms通信路径问题） |
| g | delete/merge | 不可检查 |

### 🔴 P0 阻断性发现：coms通信中backward deferred机制断裂

**症状**：planner通过coms_send发送反馈给coder → coder接收消息、生成回复（含HighEntropy复盘）→ coder agent_end捕获HighEntropy → 但backward未执行。

**根因**：backward deferred机制依赖`_backwardPendingMatch`全局变量。该变量在`before_agent_start`的pairing_judge中设置（index.ts:2094），在`agent_end`中检查（index.ts:2619）。但coms通信中，coder接收消息时**before_agent_start钩子可能未被调用**，导致`_backwardPendingMatch`保持null，agent_end跳过backward。

**事件证据**：
- `_events.jsonl`中有planner的pairing_judge事件（04:23:33，处理boss消息），但无coder的pairing_judge事件
- 04:25:15有coder的`highentropy_captured`（确认agent_end触发），但无`semantic_backward_start`
- planner侧pending列表含"星象预测反馈闭环"（第32轮遗留），理论应匹配但配对从未在coder侧执行

**修复方向**：
1. 确认coms消息接收是否经过before_agent_start钩子；若不经过，需注入配对逻辑
2. 或在agent_end中实现独立的pending匹配（不依赖before_agent_start设置的_backwardPendingMatch）
3. 临时方案：回退到before_agent_start中直接执行backward（coms路径下仍有效）

### coder 根因分析（⭐⭐⭐⭐⭐）

**R1（致命）**：误判prev偏涨能量传递方式。prev（01-26周日）+2偏涨能量落在非交易日，假设周一开盘集中释放→冲高。实际：周末无法交易，周五（01-24）阳线收盘已提前吸收利多，周一变成"利多出尽"。

**R2（严重）**：忽略node_7「利多不涨」模式。node_7记录：prev高正分+冲高回落收阴+current低分+next高分=利多不涨判跌。本轮完全命中模式，但被当作"背景信息"未应用。

**R3（中等）**：「无月亮相位」误读为中性偏弱，实际是散户情绪空转→缺乏买入理由的默认抛压。

### 三项修正规则（未写入网络—backward未触发）

- **规则A**：prev落在非交易日且得分≥+2 → 利多能量视为已被前一交易日收盘吸收，不作为current冲高依据
- **规则B**：current无月亮相位+非月亮相位偏负 → 默认微偏跌(-0.5分)，不可当"中性"处理。仅K线处于明确放量突破趋势中可豁免
- **规则C**：next后日星换座+current利多不涨=双重空头确认，判跌置信度0.60+

### 待办

| 优先级 | 问题 | 动作 |
|--------|------|------|
| **P0** | coder复盘无HighEntropy + backward未触发 | ①workflow.md已增强步骤5反馈模板（含完整上下文+要求HighEntropy）；②需排查agent_end中_backwardPendingMatch是否为null |
| P1 | 修正规则A/B/C未写入网络 | 待P0修复后下一轮backward写入 |
| P1 | MERGE DUTY 持续零触发 | 已持续多轮，需研究prompt增强 |
| P2 | 预测准确率下降（近5轮2胜3负） | 网络未学习本轮教训，待backward恢复后观察 |

### 修复：workflow.md 步骤5 增强

**问题**：原步骤5反馈消息过于简略（仅"预测涨0.58，实际跌-0.062%。请复盘分析"），导致：
1. coder 复盘缺少完整K线/星象上下文 → 分析质量受限
2. coder 未生成 `<HighEntropy>` 块 → agent_end 无 assistant 分析可注入 backward LLM
3. backward LLM 只能从极简反馈文本编造训练信号 → 质量差

**修复**：workflow.md 步骤5 改为强模板：
- 必须包含原始K线+星象数据（作为复盘引用上下文）
- 明确要求输出 `<HighEntropy>` 块
- Technique 需包含根因+修正规则压缩版本
