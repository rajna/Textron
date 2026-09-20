# Textron 元讨论：符号压缩 → 引用造句 → 概念繁衍

> 记录时间：2026-07-25
> 参与：planner（星象预测 agent）+ boss（代码架构）
> 主题：Textron 节点 name 如何成为像 ∫ / Transformer 那样的高熵压缩符号

---

## 一、当前问题：name 是"人名"不是"符号"

当前 L0 节点 name 现状：
- `Warframe AI CogView-3-Flash assets_raw/ assets/` — 工程路径拼接，非概念
- `z.type createLinearGradient createRadialGradient` — 变量名拼接，非概念
- `4 DOWN UP json_mode reasoning_effort HANDOVER.md` — 事件元数据，非概念

**这些 name 只用于区分节点（"人名"），没有被后续知识引用，不产生新概念。**

对比 ∫ 和 Transformer：

| 维度 | ∫ / Transformer | Textron 当前 name |
|------|----------------|-------------------|
| 压缩比 | 7个独立概念→1词 | 内容→前几个关键词 |
| 引用率 | 百万次/年 | 0次 |
| 繁衍力 | BERT/GPT/ViT | 无 |
| 位置 | LLM SFT 学到 | 每次注入需重新解释 |
| 验证 | 引用=信任 | 引用=路由得分 |

## 二、改造思路：backward 造句 → forward 引用链 → 符号固化

### 2.1 机制改造（当前 Textron 可落地）

**原理**：backward 写节点 content 时，不用"name:content"的孤立定义格式，而是要求 LLM 用其他节点的 name 造句，把 name 嵌入 content 上下文。forward 时 LLM 看到的不再是定义而是"用法"。

```
当前（定义导向）：
  L0::node_X: hhhh = 满月时K线反转概率+15%

改造后（引用导向）：
  L0::node_X: hhhh = 满月时K线反转概率+15%
  L1::node_Y: 月合冥王+hhhh触发→确认反转信号 | 连续下跌≥4日+hhhh→买入窗口
  L2::node_Z: hhhh失效场景=新月次日+Phase<0.3→改用相位净计数
```

forward 激活 `hhhh` 时，同时注入"hhhh 被用在哪些句子里"。LLM 从上下文学到"hhhh 怎么用"——这就是 SFT 中 ∫ 被学到的方式。

### 2.2 backward prompt 改造（Rule 8: SYMBOL EMBEDDING）

```
Rule 8. SYMBOL EMBEDDING: When writing node_updates content, USE existing node names from RELATED/EXISTING as building blocks in your sentences. Example: if nodes "满月反转" and "月合冥王" are related, write content like "月合冥王+满月反转触发→买入信号". This embeds the symbol into usage context, giving it a "vector position" through citation. Nodes that get repeatedly cited this way become stable high-entropy anchors — like ∫ in mathematics. Nodes that are never cited or only cited in wrong predictions will naturally decay through edge weights.
```

### 2.3 name 质量改造（已部分完成）

- ✅ name_distill.ts: identLike 评分 10+len/2 → 4-len/4（文件路径/变量名不再压制域名）
- ✅ backward Rule 4: name MUST be compressed symbolic anchor（like ∫ or Transformer）
- 待做：name 被引用后，引用统计影响 forward 路由权重

### 2.4 验证标准

一个合格的符号 = ∫ 标准：
1. **引用率 > 3**：被至少 3 个其他节点在 content 中造句引用
2. **存活率 > 5轮**：连续 5 轮 forward 被路由命中
3. **正 reward 占比 > 50%**：被引用的节点平均 reward > 0
4. **衍生 ≥ 1**：产生了新的高阶符号（类似 Transformer→BERT/GPT）

## 三、Transformer 架构 LLM 改造方案

### 3.1 当前 Transformer 的局限

```
输入: [tok_1, tok_2, ..., tok_n]
输出: 预测 tok_{n+1} ∈ vocabulary（固定词表，如 50K tokens）
```

- 词表固定，无法容纳新概念符号
- 信息存储在 attention/FFN 权重里，无法精确定位"某条规则"
- 学到的是"统计共现"，不是"符号引用"

### 3.2 改造方向：Concept Sequence Prediction

**将"预测下一个 token"改为"预测下一个 token + 预测下一个概念符号"：**

```
输入: [tok_1, tok_2, ..., tok_n, concept_1, concept_2, ..., concept_m]
输出: {
  next_token: 分布 over vocabulary（原有）
  next_concept: 分布 over dynamic concept space（新增）
}
```

**Dynamic Concept Space** 不是固定词表，而是一个可增长的符号集合：

```
concept space = {
  "满月反转": {def: "满月时K线反转概率+15%", cited: 23, reward_avg: +0.7},
  "月合冥王": {def: "情绪极端化概率上升", cited: 15, reward_avg: +0.4},
  "新符号X": {def: null, cited: 0, reward_avg: 0},  ← 由模型自己创造
}
```

### 3.3 训练流程改造

```
Phase 1: 基础语料预训练（同标准 LLM）
Phase 2: 概念蒸馏训练
  - 输入一段语料
  - 模型输出预测 token + 预测/创造概念符号
  - 后续语料中若出现该符号（引用），计算 citation reward
  - 引用越多，符号权重越高（类似 Hebbian learning）

Phase 3: 符号繁衍训练  
  - 高引用符号可被组合衍生新符号（"满月反转" + "月合冥王" → "满月冥王共振"）
  - 新符号经后续语料验证（被引用→存活，无引用→消亡）
  - 形成概念演化树
```

### 3.4 架构改动点

| 组件 | 改动 |
|------|------|
| Embedding Layer | 新增 Concept Embedding，维度与 token embedding 相同，但 vocab 动态增长 |
| Attention | 注意力头分两类：token-token 和 concept-concept，允许 cross-attention |
| Loss | 新增 concept_loss = α·citation_reward + β·offspring_count + γ·concept_compression_ratio |
| Output Head | 双输出：token_head（原有）+ concept_head（新，输出动态 concept space 分布） |
| Vocabulary | 固定词表 + 动态 concept 词表（运行时维护，类似 Textron 的 ~/.textron 网络） |

### 3.5 与 Textron 的关系

Textron 就是这个思想的工程原型：
- L0/L1/L2 节点 ≈ concept symbols
- forward propagation ≈ concept selection（哪些概念进入上下文）
- backward ≈ concept distillation（从经验中提取新概念）
- edge weights ≈ citation strength（引用次数影响路由权重）
- node_stats ≈ usage tracking（success/failure 计数）

区别在于：Textron 是外挂（外挂式 symbol injection），Transformer 改造是内置（模型自己学会 symbol embedding）。外挂的缺点是 LLM 每次都要重新 parse，内置的缺点是训练成本高。

### 3.6 可行性评估

| 维度 | Textron（外挂） | Transformer 改造（内置） |
|------|----------------|------------------------|
| 实时性 | ✅ 每次 turn 可用 | ❌ 需要 SFT |
| 成本 | 低（prompt injection） | 高（需要训练） |
| 精度 | 中（依赖 prompt 工程） | 高（原生表示） |
| 规模 | 小（100节点级） | 大（百万概念级） |
| 验证 | 即时（backward reward） | 离线（需要评估集） |

**结论**：先用 Textron 验证"符号造句 → 引用链 → 概念繁衍"的可行性，如果效果验证成功，再考虑将机制内置到 Transformer 架构中。Textron 是探路者，Transformer 改造是最终形态。

---

## 五、planner 代码改进提案（2026-08-02，源于九连失归因）

> 背景：当前 loop「测试就测试、审计就审计」，缺改进动作。以下为审计洞见→可执行改进，供 boss 排期。

### 5.1 【核心提案】多轨迹聚合 backward（mini-batch experience replay）——✅ 无需改代码，workflow 层实现

**病灶**：当前每条反馈即时 backward = batch size 1 的 SGD。非平稳数据上高方差更新 → 九连失规则震荡：单轮失败推翻刚写入的规则；根因以案例编号索引过拟合，无法迁移。

**workflow 层实现（planner 操作，零代码改动）**：
1. **跨 regime 4-case 打包**：每条发给 coder 的预测消息包含 4 个 case——2022/2023/2024/2025 各 1 个交易日，按行情 regime 采样（2022 熊市主跌、2023 震荡市、2024 恐慌底/修复、2025 V反强趋势）。coder 一次推理 4 个 case，规则被迫面对 regime 多样性，单 regime 过拟合在输入端被结构性抑制
2. planner 逐 case 对答案（预测前严禁看 actual），本地缓存 4 条轨迹，**不逐条反馈**
3. 攒齐 4 条后组装**一条聚合反馈消息**发 coder：含全部 4 case 的预测/实际/理由摘要，指令"提取跨 ≥2 个 regime 成立的不变模式；单案例特质标记 hypothesis 低置信，禁止写成规则"
4. coder 一次复盘产出跨 regime HighEntropy → hook 一次 backward → 规则出生即带多 regime 支撑
5. 准入门槛（prompt 层）：修正规则 content 必须引用 ≥2 个案例日期，或显式标"假设·待验证"

**代价与边界**：反馈延迟 4 轮（edge 学习滞后）；噪声日（|实际|<0.3%）轨迹不进聚合池，直接丢弃不学（配合弃权档）。API 已验证支持 2022-2025 全历史段（kline actual + horoscope3d 均正常返回）。

**预期效果**：规则出生质量提升（跨案例不变式 vs 单案例补丁）；与 boss P1 规则置信度 EMA 互补——EMA 治"推翻"，batch 治"出生"。九连失中第46轮"上弦月降级"第47轮即被打脸的震荡模式在结构上被消除。

### 5.2 噪声日学习隔离（配合 test.md 第十四节弃权档）

- 硬判方向且 |实际涨跌|<0.3% → reward=0 且**剥离 node_updates**（噪声日禁止写规则，只许更新 edge/统计）
- 实现位置：mergeDeleteGate 同层，加一个 noiseDayGate

### 5.3 审计洞见强制产出（流程层，已同步修 workflow.md）

- 每轮审计必须以「现象→根因假设→改进方案→预期指标变化→验证轮数」五列表格收尾；无改进提案的轮次标记"空转轮"并说明原因
- 改进执行分级：P0 planner 直接改代码；需重启写 test.md 通知 boss；实验性改动先基线后上线（AB 对照）

### 5.4 领先指标三件套（替代单一滚动正确率）

| 指标 | 定义 | 数据源 |
|------|------|--------|
| 同类错误复发率 | 相同根因标签的失败间隔轮数 | test.md 归因表 |
| 规则复用率 | 预测轮 HighEntropy/理由中引用既往节点规则的比例 | coder 回复文本 grep 节点 name |
| 判后准确率 | 剔除弃权日后的方向命中率 | 弃权档启用后统计 |

---

### 5.5 【P0 设计修正】Function v2 = 可执行代码，非散文规则

**错位根因**：v1 Function（name/params/prose rules + diff）与 backward node_updates 是同层语义知识，两通道写同一种东西 → diff落盘散文化/R编号虚空/规则震荡双写。

**v2 职责划分**：
- backward = 语义知识层（道：为什么错/根因/原则，散文）
- Function = 可执行计算层（术：输入K线+星象→确定性量化特质→方向提示/弃权判定，代码）
- 耦合点：**backward 只调 PARAMS（阈值/相位分值，EMA平滑），禁止改函数体**；函数体改动走 workflow 改进流程
- expect 闭环真激活：Function 可在 2022-2025 历史 case 回放跑分，判后准确率机器验证

**已落地**：`/Users/rama/textron-agent/functions/astro_quant.py` v1.0（planner 首版）
- PARAMS 表 = 网络47轮沉淀全部阈值（月层硬软差额/换向日计0/非交易日×0.5/趋势吸收-6/弃权档<2.5/火象宫加权）
- 02-24 案例断言通过：weighted3d=0.6 + moon_diff=-1 → ABSTAIN（与coder手动重算一致）
- 待 boss 决策：①PARAMS 是否纳入 backward node_updates 作用域（结构化diff天然可应用）②函数节点 content 存签名+参数表，代码体按 name 存 functions/ 目录 ③跨 regime 4-case 协议中 coder 先跑函数再推理（消除 +3.5 虚高类算术失误）

**接线状态（2026-08-02 终裁）**：⛔ **planner 手写版已封存**（functions/SEALED.md）——boss 裁定函数必须由网络通过 HighEntropy Function 块→backward 落盘自然学出，手写=教练替运动员上场、架空主线、污染 AB 归因。coder 两轮 Function modify 块证明涌现路径已发芽，死在落盘端（node_15：diff散文化=半截协议）。**主线工作**：boss 修 backward 落盘端（函数body单版本存储+diff真应用）→ planner 跑轮次审计函数节点是否自然涌现 → 涌现后取封存版对照收敛度。决策①②④全部作废重组为一个问题：backward 如何把 Function 块落成真函数节点。

---

## 四、TODO 清单

| # | 任务 | 状态 | 优先级 |
|---|------|------|--------|
| 1 | backward prompt 加 Rule 8 SYMBOL EMBEDDING | ⏳ 待改 | P0 |
| 2 | 引用追踪：backward 时记录 content 中引用了哪些节点 name | ⏳ 待实现 | P0 |
| 3 | 引用上下文注入：forward 时注入"被引用的句子"而非纯定义 | ⏳ 待实现 | P1 |
| 4 | 引用路由加权：citation count 影响 PageRank/路由得分 | ⏳ 待实现 | P1 |
| 5 | 符号质量评估：4项标准（引用率/存活率/正reward率/衍生数） | ⏳ 待定义 | P2 |
| 6 | Transformer 架构改造方案（第3节）| 💡 概念阶段 | P3 |

## 五、workflow_3/n8 第二十三轮遗留待办（2026-09-21 guard 登记，来源 HANDOVER 第十三节）

| # | 任务 | 状态 | 优先级 |
|---|------|------|--------|
| 7 | B1/B2 验证 MERGE_OVERFLOW_CAP 生效（**前置=三件套 /reload**）：下次反传后 `stock_alpha L0::node_0` ≤12000c、`" \| "` 片段数自 107 下行；勿在未 reload 时误判修复无效 | ⏳ 待验证 | P0 |
| 8 | R2 函数块淘汰剥离 content 内 `[fn:σ]` 引用：`persistHighEntropyFunction` 的 `onEvicted` 现只记事件；fn_ref_dangling 已达 danglingPairs=50/refs=64，突破 F4' 上限 33（P0-1 前半句暂缓期已到期） | ⏳ 已到期未做 | P0 |
| 9 | R3 lift/split 自然触发观察：解挂条件=下一次**实质性交易增量轮**（非回执/bookkeeping 轮）；回执轮 keep 属合理行为，guard 手动触发 lift 属捷径必拒 | ⏳ 待样本 | P1 |
| 10 | R4 JSON 截断守卫：LLM 输出达预算截断 + repair 放行残缺 content（实证 diagDirectParseErr position 2268）；候选=content 尾部半词检测拒写 keep_better | ⏳ 待实现 | P1 |
| 11 | 回执类轮（`function_off_goal=true`）过度写入 goal 域节点（本轮 L0 被重写 ≥3 次/2 次 `node_write_downgraded_to_merge`）；候选方案=该类轮只记事件禁写节点，**须先解与 rule0 MUST-CLEANSE 的互斥**（P0-5 病灶复现） | ⏳ 待设计 | P1 |
