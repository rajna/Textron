# 交接：index.ts 3处修复 + 日志驱动诊断

---

# 交接（追加）：2026-09-01 stock-trade /api/step 决策归一化 + Textron extract 截断修复

> 范围：`/Users/rama/Documents/agi_nanobot/nanobot/nanobot/skills/stock-trade/UI/app.py`（交易 API）、`/Users/rama/textron-agent/src/index.ts`（backward extract）
> 状态：**均未在运行环境生效**——app.py 需重启 7860 服务，index.ts 需重载 Textron extension
> 关键决策：修点必须落在交易 API 边界（app.py），**禁止再改共享通信层 local-coms.ts**（全局 agent 通信，会波及所有会话）——已撤销此前对 local-coms.ts 的越界修改，恢复原状

## 一、stock-trade `/api/step` 决策归一化（app.py，+110/-9）

**问题**：worker 输出 `JSON + <HighEntropy>` 混合格式时，sender 把嵌套决策对象 `{"decision": {"decision": "买入", ...}}` 或混合文本串直接 POST 给 `/api/step`：
- 嵌套对象触发 `unhashable type: dict` → 500（`_normalize_decision` 枚举检查把 dict 当值）
- 请求体为 list/字符串 → `'list' object has no attribute 'get'` → 500（session 查找先行崩溃）

**修复（4 处）**：
| # | 位置 | 改动 |
|---|------|------|
| 1 | `_json_body()`（app.py ~48） | 统一 6 个 POST 端点（init/finish/load/step/advance/rollback）的 body 解析；非 JSON 对象返回 {}，不再崩 |
| 2 | `_extract_first_json_object()` | 从混合文本提取首个完整合法 JSON 对象：括号深度 + inString/escaped 字符串状态，正确处理 content 内花括号/转义引号；非法返回 None |
| 3 | `_extract_decision_payload()` | 三种形态归一化：扁平 / 嵌套 decision 对象 / `decision` 字段为混合文本字符串；嵌套与混合形态下以决策对象内部字段覆盖顶层同名；payload 非法类型抛 ValueError |
| 4 | `_normalize_decision()` + `/api/step` | 决策值非字符串/非法 → 回退"不建仓"（不再抛异常）；`/api/step` 请求体非对象 → 结构化 `400 决策契约错误`；`_normalize_decision` 抛 ValueError 也捕获转 400 |

**验证（全部通过）**：
- 纯函数 9 项：混合文本提取、字符串内花括号、前置文本、非法 JSON None、扁平/嵌套/混合文本三种形态、非法 payload ValueError、深层嵌套
- Flask test_client 端到端：扁平/嵌套/混合文本三种 step 均 200 且决策正确；非法 body（list/str/int）→ 400 契约错误；决策字段为 list → 回退不建仓；未知 session_id 回退默认 session（既有 `_get_session` 容错，非 404）；advance/rollback/finish/load 非法 body 不再 500
- worker 原始混合响应（reasoning 内含花括号 + HighEntropy）完整解析

## 二、Textron extract() 截断修复（src/index.ts ~1407-1492）

**P1 病灶**：LLM backward 响应被截断 → rawContent 无法完整 JSON.parse → extractor 在残骸中捞到 `{"reward":0}` 碎片 → 旧 `hasBackwardShape`（只要含 reward 键即命中）把它当完整响应 → **静默退化成 reward=0 空更新，伪装成正常学习**；三重兜底（chat_json→chat_stream→chat_json_stream）会重复捡同一碎片。

**修复（3 处，同款"术"与 app.py 一致）**：
1. **字符串感知平衡扫描**：balanced 扫描加 inString/escaped 状态，跳过字符串内 `{`/`}` 与转义字符（旧实现会因 content 字段花括号误切）
2. **形状判定收紧**：`hasBackwardShape` 必须有 `node_updates`/`add_nodes`/`node_actions` 之一；`{"reward":0}` 碎片不再冒充
3. **截断显式失败**：仅 reward-only 碎片时，`JSON.parse(raw)` 完整成功才视为"有意空更新"接受；否则抛 `semantic backward response truncated/non-substantive` + 写 `_sb_logs/_truncated_response.log` + 监控事件 `semantic_backward_truncated_fragment`

**验证（全部通过）**：等价 JS 逻辑 7/7（完整响应 / 截断碎片→显式失败 / off-topic 空更新合法 / fence 包裹 / 花括号不误切 / 无 JSON 报错 / 闭合空 updates）；`node --experimental-strip-types --check src/index.ts` 语法通过（exit=0）

## 三、待办（按优先级）

| # | 任务 | 状态 |
|---|------|------|
| 1 | 重启 7860 服务（PID 78495 旧代码）使 /api/step 修复生效 | ⏳ 待重启 |
| 2 | 重载 Textron extension 使 extract 修复生效 | ⏳ 待重载 |
| 3 | Function 落盘端到端验证：backward 后节点内容可检索到 `run_stock_game_n6_flat_step`（verify_function_node_persistence） | ⏳ 未完成 |
| 4 | sender 输出结构化 `trade_feedback(session_id, step_index, score, dimensions, portfolio)`，统一 -5..5 与 10/-10/-2 评分语义 | ⏳ 未完成 |
| 5 | sender 等待 worker 独立复盘完成事件后再触发每轮 backward（4 次交易 ≥ 4 次可审计学习） | ⏳ 未完成 |
| 6 | 对含 `<Function>` 的 HighEntropy 禁用破坏性 ngram distill，保留完整 functionSymbol 与函数体 | ⏳ 未完成 |
| 7 | 为 /api/step 增加混合响应剥离测试与 sender 端决策 JSON 校验 | ⏳ 未完成 |

## 四、经验教训（已沉淀节点）
1. **修复边界以"数据流终点"为准**：worker 混合输出进 /api/step 的问题，修 app.py 的输入归一化即可，**不动全局通信层**——共享层的改动会静默改变所有 agent 会话的响应语义
2. **截断 vs 有意空更新**的判别边界：完整可解析 = 有意（合法），无法完整解析 = 残骸（必须显式失败）——"能解析就成功"会把故障伪装成学习
3. **形状判定要"实质"不要"存在"**：仅含 reward 键的对象不是 backward 响应，必须有更新/新增/动作之一；判定越宽，碎片越容易冒充完整
4. 字符串感知的括号扫描（inString/escaped）是 JSON 提取的通用正确形态，app.py 与 Textron extract 两处已统一
---

# 交接（追加）：HighEntropy Function 函数化协议（2026-07-29，待重启生效）

## 本次修改：`src/index.ts` HIGH_ENTROPY_INSTRUCTION（L103-113 新增，原五字段契约零改动）

在 Technique 规约之后、`</HighEntropy>` 之前插入 `<Function>` 可选块协议。目标：让股票类 loop 任务沉淀**函数式节点**（name/params/rules/expect），替代纯文本堆叠；PPT/画图等一次性任务自然豁免。

### 协议四规则

1. **三问自检**（全 yes 才产出 Function 块）：①任务家族会重复 loop？②输入可参数化（行情/星象/错误码）？③输出可客观验证（有 actual 对答案）？一次性创作任务省略整块。
2. **name 镜像 Name**：Function 的 name 与 HighEntropy Name 同源高熵术语拼接（相同或核心子集）——routing 只看 Name，命名对齐使前向检索直接命中函数节点；禁止另起 generic 名。
3. **reuse-before-generate**：先扫描 Textron 注入上下文中节点携带的 `<function>` 块——
   - 同域已有 → `action="modify" target="L{layer} {node_id}"` 只出 diff：【修改Rn】【新增Rn】【删除Rn】+trigger；target 必须取自真实注入节点 id，禁幻觉
   - 无匹配 → `action="create"`（name/params 类型化/rules R1..RN 编号即优先级/expect 可验证断言）
   - 禁止重复 create 已有函数
4. **废除规则 = diff 中直接省略**，禁写"已废除"字样（对症 node_3 四轮修正堆叠病灶）。

### 设计动机（对应已知病灶）

- node_3：v1"需次日确认"与 v3"无需确认即可偏空"矛盾共存 → 函数 body 单版本 + diff 废除真删除
- node_6：动能衰减梯度已是伪代码却被散文重解释 → rules 编号化，编号=优先级
- node_11/node_9 跨任务污染（武器/游戏节点混入）→ 函数签名 params 类型不匹配天然隔离
- expect 字段 = tests 种子：预测轮断言 → planner 对答案 → pass/fail 沉淀节点 <tests>（落地 L0 node_2 验证原则）

### 配套说明

- 未改 backward 执行逻辑：backward LLM 会把 Function 块当高质量结构化信号自然吸收；稳定 3-5 轮后再考虑 backward prompt 显式 diff 应用指令
- 模板字符串完整性已校验（无内嵌反引号，3503 chars）
- 网络已沉淀 node_12（函数化协议设计）——本轮改动即该节点的落地

## 重启验证（本次改动）

| # | 验证 | 方法 | 预期 |
|---|------|------|------|
| 1 | create 产出 | 首轮用已知 actual 的历史回测 case（如 2025-02-21 第46轮） | coder 回复携带 `<Function action="create">`，name=Name 高熵拼接 |
| 2 | 三问自检豁免 | 发一个非 loop 任务（如闲聊/画图请求） | 回复无 Function 块，五字段照常 |
| 3 | modify 而非重 create | 次轮同家族任务 | `<Function action="modify">` 带 diff，无重复 create |
| 4 | 函数节点沉淀 | `cat layer_*/node_*.html \| grep -l function` | backward 后出现含 <function> 的节点 content |
| 5 | expect 闭环 | planner 对答案后查 semantic_backward.jsonl | tests 追加 pass/fail |
| 6 | PPT 类误发 create | 若发生 → 收紧三问自检措辞（把反例豁免提到协议开头） | 观察指标 |

---

## 本次修改（2026-07-25，待重启生效）

### 🔴 修复 1：`reasoning_effort` 参数值错误（P0）

**问题**：第一次修复用了 `"minimal"`，但 deepseek API 有效值只有 `high | low | medium | max | xhigh`，`"minimal"` → HTTP 400 全拒。

**日志证据**：
```
reasoning_effort: unknown variant `minimal`,
expected one of `high`, `low`, `medium`, `max`, `xhigh`
```

**影响**：json_mode 和 tool_call **全部 0% 成功**（之前误判为 51%），L0 评分 100% 退化本地 TF-IDF。

**修复**（index.ts 3处）：
| 行 | 改前 | 改后 |
|----|------|------|
| 649 | `requestBody.reasoning_effort = "minimal"` | `= "low"` |
| 711 | `reasoning_effort: "minimal"` | `"low"` |
| 798 | `reasoning_effort: "minimal"` | `"low"` |

**预期**：json_mode 成功率 0% → >80%，L0 零激活 25.6% → <5%。

---

### 🟡 修复 2：已发现但未修复的 crash（待下次）

| 错误 | 次数 | 位置 |
|------|------|------|
| `Cannot access 'messages' before initialization` | 35/48 | backward 未知行 |
| `nodesAdded is not defined` | 2/48 | index.ts:1493 |
| `.for is not iterable` | 8/48 | jiti 缓存（已加 try-catch） |
| `onLog is not a function` | 2/48 | 旧 |

---

## 日志分析完整数据

### L0 评分（_events.jsonl 25MB）

| 指标 | 值 |
|------|------|
| 总调用 | 1350 |
| json_mode 成功 | **0** |
| tool_call 成功 | **0** |
| local_fallback | 275 (20%) |
| 静默失败（无 fallback）| ~800 |
| nonzeroCount=0 | 169次 (25.6%) |
| 平均 nonzeroCount | 3.7 |

### 反向传播

| 指标 | 值 |
|------|------|
| 总次数 | 2221 |
| 成功 | 1053 |
| 失败 | 48 |
| qualityLabel high | 45 (4.3%) |
| qualityLabel medium | 480 (45.6%) |
| qualityLabel low | 528 (50.1%) |

### 失败类型分布

| 错误 | 次数 |
|------|------|
| `Cannot access 'messages' before initialization` | 35 |
| `.for is not iterable` | 8 |
| `nodesAdded is not defined` | 2 |
| `onLog is not a function` | 2 |
| stale ctx | 1 |

---

## 根因链（修正后）

```
reasoning_effort="minimal" → API reject 100%
  → local_fallback 100% → TF-IDF 星象语义归零
  → 25.6% L0 零激活，平均仅 3.7/8 节点
  → 前向传播空转 → backward 噪声
  → 50% low quality + 48次崩溃
  → 四连中→六连失无法学习
```

---

## 第34-45轮测试日期对照

| 轮次 | 日期 | 结果 |
|------|------|------|
| 第34轮 | 2025-02-05 | 春节后首日 |
| 第35轮 | 2025-02-06 | ✅ |
| 第36轮 | 2025-02-07 | ✅ |
| 第37轮 | 2025-02-10 | ✅ |
| 第38轮 | 2025-02-11 | ✅ **四连中** |
| 第39轮 | 2025-02-12 | ❌ 满月转折 |
| 第40轮 | 2025-02-13 | ❌ |
| 第41轮 | 2025-02-14 | ❌ |
| 第42轮 | 2025-02-17 | ❌ |
| 第43轮 | 2025-02-18 | ❌ |
| 第44轮 | 2025-02-19 | ❌ **六连失** |
| 第45轮 | 2025-02-20 | ❌ 预测UP实际DOWN(-0.023%)，七连失 |
| 第46轮 | 2025-02-21 | 新一轮（待测试） |

---

## 第45轮测试复盘（2026-07-25）

### L0评分修复验证 ✅
- json_mode 成功（nonzeroCount=8/10，零激活降至0%）
- backward mode=agent_end_deferred 正常触发
- contextIds 聚焦4个领域节点

### 新P0：`nodesAdded is not defined` 再次崩溃
- 位置：index.ts:1493 applySemanticNodeUpdates
- LLM正确产出 reward=-1 + 3节点更新，但apply崩溃 → 修正规则未写入网络
- 这是已知bug第3次出现（HANDOVER.md已记录2次）

### 五条待写入修正规则（coder复盘产出）
1. 月亮入射手83%胜率需联合星象净分，净分≤-1时折半
2. 利多兑现增加修复完整性检查
3. 日月级转折消化从current日开盘启动
4. 动能衰减梯度上调：3-4%=-1.5,4-5%=-2.5
5. 月冲天王星分场景

---

## 当前状态

- 网络：`astro_stock_prediction`，[10,8,29]=47 节点
- 修复：index.ts 3处 `minimal`→`low` **已生效**（json_mode成功 ✅）
- **P0已修复**：`nodesAdded is not defined` (index.ts:1493) — 2处修改，待重启生效
- 下次测试：2025-02-21（第46轮）预测

---

## 重启验证

```bash
curl -X POST http://localhost:8770/restart/planner
curl -X POST http://localhost:8770/restart/coder
```

| # | 验证 | 方法 |
|---|------|------|
| 1 | json_mode 不再 HTTP 400 | `grep "unknown variant" _events.jsonl` 为空 |
| 2 | json_mode 成功 > 80% | `grep l0_score_done _events.jsonl \| grep json_mode` |
| 3 | nonzeroCount=0 大幅减少 | `grep '"nonzeroCount":0' _events.jsonl \| wc -l` |
| 4 | backward 不再出现 `nodesAdded is not defined` | `grep "nodesAdded is not defined" _events.jsonl` → 修复后应为空 |
| 5 | qualityLabel high 出现 | 检查 done 事件的 qualityLabel 字段 |
| 6 | 五条修正规则是否已写入node_6 | cat layer_0/node_6.html |
| 7 | overflow 新增节点是否成功 | 检查 layer_*/ 目录是否出现新 node_*.html 文件 |

---

## ⚙️ `nodesAdded is not defined` 修复详情

### 根因

**内容限制重构**（120c → NODE_CONTENT_MAX_CHARS=1000）引入 overflow 分支时，变量声明遗漏。

### 功能链路（5步，全部实现）

```
applySemanticNodeUpdates (index.ts:1487)
  │
  ├─① mergeContent(oldContent, newContent)  → lib/merge.ts ✅
  │   先 "old | new" 拼接，>1000c 则 mergeDistinctContentFragments 按 | 分段去重
  │
  ├─② if (mergedContent > 1000)            → index.ts:1489 ✅
  │
  ├─③ addDynamicNode(net, layer, overflow) → lib/node_policy.ts:222 ✅
  │   包装调用 addPolicyNode
  │
  ├─④ addPolicyNode                        → lib/node_policy.ts:63 ✅
  │   正交检查 → 相似合并 → validateKnowledgeCrystal →
  │   GROWTH开关 → 空槽位复用 → 层扩展 →
  │   writeNodeHtml写盘 + hyperparams更新 + 跨层边创建
  │
  └─⑤ nodesAdded++ / result.nodeMutations.push  🔴→✅ 已修复
```

**崩溃证据**：第44/45轮 backward 堆栈显示执行到了第⑤步（`addDynamicNode` 返回 `added:true`），仅在 `nodesAdded++` 行崩溃。`addPolicyNode` 已将新节点写入磁盘。

### 修复内容（index.ts，2处）

| # | 位置 | 改前 | 改后 |
|---|------|------|------|
| 1 | 函数开头（~1422行） | 无声明 | `let nodesAdded = 0;` |
| 2 | overflow 分支（~1496行） | `nodeMutations.push(...)` | `result.nodeMutations.push(...)` |

---

## 2026-07-25 零改动基线轮启动

**本次重启无任何代码改动**。目的：为"符号造句→引用链→概念繁衍"验证实验收集基线对照数据（见 discuss.md / todo.md）。

### 背景
- 上一轮改动已全部完成并验证：L0评分 reasoning_effort=low 修复、merge溢出→addDynamicNode、MERGE阈值15%、name符号化prompt（Rule 4 + name_distill.ts identLike降权）、agent_end延迟backward
- 新方案（Rule 8 SYMBOL EMBEDDING / 引用追踪 / 引用加权路由）**暂不实施**，先跑基线

### planner 任务
1. 按 workflow.md 七步流程跑 5+ 轮 A股预测→反馈→audit
2. 每轮记录：预测方向、实际方向、命中与否、L0激活节点数、nonzeroCount、backward 是否触发（mode=agent_end_deferred）、qualityLabel
3. 特别观察（基线指标，供后续H1对照）：
   - backward 新增/更新的 content 中**是否引用其他节点 name**（当前预期≈0，这就是基线）
   - 节点 name 质量：是否仍是"元数据拼接"风格（如 `4 DOWN UP json_mode...`）还是开始符号化
   - MERGE 动作是否出现（阈值降到15%后）
4. 异常立即记录到 test.md，不要手动编辑节点（L0::node_0 原则）

### 对照锚点
本轮数据 = discuss.md 验证实验的 baseline 组。后续 Rule 8 上线后的 treatment 组将与此对比（H1: 引用率>30%、H3: 准确率+5pp）。

---

## 交接（2026-08-02）：HighEntropy Function 协议两字段化（需重启生效）

### 本次修改：`src/index.ts` HIGH_ENTROPY_INSTRUCTION（L104-112 替换，五字段契约零改动）

`<Function>` 块从 action/target/version/【修改Rn】 diff 协议 → **functionSymbol + functionAbstract 两字段**：

```
functionSymbol: snake_case 短符号名，镜像 Name 核心词 —— 后续节点 content 原样引用（子串匹配），接通 Rule 8 引用链
functionAbstract: 从本轮解法蒸馏的通用可执行代码 —— 具体数值→params，解法路径→函数体，蒸馏"术"不复述会话
```

**废除**：action=create/modify、target 校验、version 字段、reuse-before-generate 扫描义务、规则编号维护——create/modify/去重/版本演进全部归还 backward+merge（同符号函数自然合并演化，L0::node_5 merge 原则）。LLM 每轮唯一职责：把这次解题的术蒸馏成代码。

**设计依据**（本轮讨论定稿）：
- 旧协议让 LLM 干版本管理 → R编号虚空（落盘散文化后无机器可定位的R1）、version幻觉（节点无版本字段）、双写震荡（与node_updates同层）
- functionSymbol 短无空格可子串匹配 = 符号造句→引用链的最理想符号载体
- 函数必须由网络经 Function 块→backward 自然学出；planner 手写版已封存 functions/SEALED.md（仅作涌现后收敛对照，永不进链路）
- 校验：node --check 通过，模板字符串反引号配对完整

### 重启验证

```bash
curl -X POST http://localhost:8770/restart/planner
curl -X POST http://localhost:8770/restart/coder
```

| # | 验证 | 方法 | 预期 |
|---|------|------|------|
| 1 | 两字段产出 | 重启后跑 1 轮 4-case 预测→反馈，查 coder 复盘 HighEntropy | 携带 `<Function>` 含 functionSymbol+functionAbstract，无 action/target/version |
| 2 | 三问自检豁免 | 同轮观察非 loop 消息 | 无 Function 块，五字段照常 |
| 3 | functionAbstract 质量 | 查块内代码 | 参数化通用函数，非会话复述；阈值来自本轮解法 |
| 4 | backward 落盘 | 查 semantic_backward.jsonl + 节点 content | 函数式节点 content 含代码（不再被散文化压平为规则①②③④） |
| 5 | 引用链观察 | 后续轮次 grep functionSymbol 在新 content 中出现 | 出现≥1次原样引用 = 符号造句生效首个信号 |

### 同期已完成（无需重启）

- workflow.md 收敛：4日采样（2022/23/24/25各1天）仅改步骤1，其余原样；审计七层保留；步骤6改进闭环保留
- test.md 第十四节：九连失归因（3/9轮|实际|<0.3%噪声日）+ 弃权档可执行规则（待 reward 层实现）
- todo.md 5.5：Function v2 终裁——backward 如何把 Function 块落成真函数节点 = 下一个系统侧问题

---

## 交接（2026-08-03）：backward 三根因修复——rescale 参数漂移 / HighEntropy 硬编码空串 / deepseek→kimi 兼容（需重启生效）

### 本次修改：`src/index.ts` 7 处 + `src/lib/rescale.ts` 1 处（五字段契约零改动，部署副本=符号链接已同步）

**根因1（P0 crash）：`recordArtifactEvent is not a function`**
- 实证：第48轮 reward=0.8 的 apply 崩溃丢失（堆栈 rescale.ts:101 ← index.ts:1456 ← autoBackward ← forcedSemanticBackward）
- 机制：`rescaleRejectedCrystal` 签名 7 参，index.ts 4 个调用点（1456/1661/2922/2972）只传 5 参 → addPolicyNode/recordArtifactEvent=undefined → 触发 RESCALE_UP 分支即 TypeError。同型参数漂移第 4 次（nodesAdded 之后）
- 修复：4 调用点补 `addPolicyNode, recordArtifactEvent`；rescale.ts 两参加防御性默认值（缺参降级 no-op 永不崩）

**根因2（P0 链路断）：预测轮 HighEntropy 永远到不了 backward**
- 实证：llm_start hasHighEntropy 恒 false（外层 running 事件却 true）、训练包恒 `(invalid/missing)`、第48轮 grep astro_kline_layer_score 网络零命中
- 机制：agent_end deferred backward 调用 `forcedSemanticBackward(capturedTF, capturedPrevTask, "", enhancedFeedback, ...)` 第三参**硬编码空串**；且 parseHighEntropyCrystal 只取 Name/Task/Technique，`<Function>` 块不进 packet → functionSymbol 落盘核验（③④/H1）**结构性不可能通过，与模型无关**
- 修复：第三参 `""` → `capturedHighEntropy`；packet 透传 `<Function>` 块原文（≤1500c）；backward system prompt 新增 RULE 8：functionSymbol 必须原样子串落入吸收它的节点 content，禁改写/翻译/拆词

**根因3（P1 兼容）：backward LLM 调用 deepseek/kimi 不兼容**
- 实证：第48轮 chat_json 90s 精确超时 + chat_stream/chat_json_stream 双双"empty semantic backward response"
- 机制 a：kimi-k3 默认 thinking=high，4096-token JSON 生成 p50≈66s/p95>90s（后续两次成功调用实测 62-66s）→ 90s AbortSignal 长尾击杀
- 机制 b（隐藏 bug，与模型无关）：`collect()` 只在当前层级查 content/delta 等键，标准 SSE 的 `choices` 数组从未被进入 → 流式兜底恒空；deepseek 时代被 chat_json 高成功率掩盖
- 修复：collect() 改全容器递归+白名单叶子键（SSE_LEAF_KEYS，兼容 OpenAI/Gemini/Anthropic 形态）；超时 90s→180s；kimi 系补 `reasoning_effort="low"`（同端点 L0 评分已验证可用），deepseek 保持不传（防 8K+ reasoning）——按模型分流，双兼容

### 验证记录

- jiti 实测：rescale 缺参调用不再崩（返回 null 而非 TypeError）✅
- index.ts 加载仅差 peer 依赖（运行环境内正常），语法转换通过 ✅
- 未手改任何节点；第48轮 4-case 结果+5项核验已追加 test.md 第48轮节

### 重启验证（修复生效后跑 1 轮 4-case）

```bash
curl -X POST http://localhost:8770/restart/planner
curl -X POST http://localhost:8770/restart/coder
```

| # | 验证 | 方法 | 预期 |
|---|------|------|------|
| 1 | 无 recordArtifactEvent 崩溃 | `grep "recordArtifactEvent" _events.jsonl` | 无新增（历史2条为第48轮遗留） |
| 2 | backward LLM 不再三连灭 | `grep semantic_backward_llm_done _events.jsonl` 尾部 | status=ok，chat_json 首选即成功，durationMs<180s |
| 3 | hasHighEntropy 真传递 | `grep semantic_backward_llm_start _events.jsonl` 尾部 | hasHighEntropy:true（不再恒 false） |
| 4 | functionSymbol 落盘 | `grep -r astro_kline_layer_score ~/.textron/astro_stock_prediction/` | ≥1 个节点 content 含原样子串（核验③复活） |
| 5 | 符号引用 H1 信号 | 后续轮 grep 新 content 引用 functionSymbol | 出现≥1次原样引用（观测项，非断言） |
| 6 | stream 兜底修复 | 若 chat_json 再超时，chat_stream 应产出真 JSON 而非空 | attempt_failed 不再出现 "empty semantic backward response" |

---

## 2026-08-03 Function透传死代码修复（第49轮核验④根因）

### 根因链（planner定位+boss代码级验证确认）
1. `highentropy.ts extractHighEntropy()` 只返回 Name+Task+Technique——capture 时 `<Function>` 块被剥光（3453c buffer → 470c crystal）
2. `index.ts:1027` 透传 regex 在被剥光的 crystal 上匹配 `<Function>` → **永空，构造性死代码**
3. 训练包止于 Technique → backward LLM 从未见过 functionSymbol → RULE 8 前提结构性不成立
4. **新发现的第三隐患**：若简单拼接 Function 块，`readField(technique→$)` 会把整块代码吞进 Technique 字段，污染 pairing/prompt

### 修复（highentropy.ts ×3 + index.ts ×3）
| # | 位置 | 改动 |
|---|------|------|
| 1 | highentropy.ts parseHighEntropyCrystal | Function 块先从 rawBlock 剥离（functionBlock 字段单独暴露），Technique 不再吞并代码 |
| 2 | highentropy.ts extractHighEntropy | crystal 尾部追加 ≤1200c Function 块——capture 层保留，透传 regex 复活 |
| 3 | highentropy.ts HighEntropyCrystal interface | +`functionBlock?: string` |
| 4 | index.ts:2649-2650 | 任务栈持久化 slice(0,800)→slice(0,2400)，Function 块存活跨重启恢复 |
| 5 | index.ts:1137 | 跨层/不可解析 merge 不再静默吞 → `merge_action_dropped` 事件（source/target/reason）——第49轮实证 LLM 提了2个merge被吞，"MERGE零触发"部分原因是"提了就吞" |
| 6 | index.ts:1068 MERGE SCAN prompt | 显式声明 "source and target MUST be in the SAME layer (cross-layer merges are rejected)" |

### roundtrip 实测（jiti）
真实 Function 块内容 → parse(ok:true, functionBlock=168c, technique无代码污染) → extract(含Function) → re-parse(ok, 无污染, fn存活) → 1027同款regex命中 ✅

### 重启后验证表（planner 执行）
① 复盘 HighEntropy 带 Function 块时，backward 训练包 userPrompt 含 functionSymbol 原文（sb_logs grep）
② grep functionSymbol 节点落盘 ≥1（核验④复活）
③ roundtrip 无污染：落盘 content 的 Technique 段不含 functionAbstract 代码
④ merge_action_dropped 事件出现=日志生效；LLM merge 提议改为同层（prompt 约束生效）
⑤ H1 观测：后续轮 functionSymbol 原样引用
⑥ 既有项回归：chat_json 首选成功、hasHighEntropy:true、无 recordArtifactEvent 崩溃

---

# 交接（追加）：2026-08-19 反向传播链路修复 + 栈溢出事故

> 时间：2026-08-19 00:00 CST（UTC 2026-08-18）
> 范围：`src/index.ts`、`src/lib/node_policy.ts`、`src/monitor.html`、`~/.pi/agent/extensions/local-coms.ts`（仅调试日志）
> 状态：**未全部重启生效**，存在未排查的栈溢出事故

## 一、本次修改（5 处代码）

### 1. backward 异步化（index.ts agent_end）— 已生效（22:xx 重启后验证 4/4 ok）
**问题**：Textron 在 agent_end 里同步 `await forcedSemanticBackward`（LLM 调用 840ms+）→ 阻塞 pi 的 emit() 串行分发 → `_isAgentRunActive` 保持 true → 后续 coms 消息 followUp 排队 → `before_agent_start` 不触发 → 配对永不发生 → **backward 永不触发**（3 次交易 0 次学习）。
**修复**：backward 改 `setTimeout(0)` + `enqueueBackward()` 串行队列异步执行；输入（matched/backwardCtx/HE/text/rawPrompt）在 agent_end 同步阶段全部捕获，异步执行完全独立。
**验证**：22:17-22:20 四轮 backward 全 `status=ok`（reward 0.9/0/0.8/1.0），学习链路首次打通。

### 2. resolveModelApiKey 增加 auth.json 兜底（index.ts ~560）— 已生效
**问题**：sender/worker 子进程 `apiKey=none` → backward/pairing LLM 调用 **401**（`Authentication Fails (governor)`）→ 配对成功也学不了。
**修复**：`~/.pi/agent/auth.json`（pi 主进程同款来源，`{provider:{type:'api_key',key}}`）作为兜底读取。
**验证**：`Textron L0: ... apiKey=auth.json`，401 消失。

### 3. backward prompt 规则 2 + 规则 6b 重写（index.ts:1110/1115）— 未重启生效
**规则 2（reward 解耦）**：`REWARD -1..1: Quantify the UPSTREAM FEEDBACK ITSELF`——量化反馈本身（用户显式批评/纠正/认可、客观断言结果），HighEntropy 是 POST-hoc 事后总结、仅供节点内容素材、**不得驱动 reward**；批评/未兑现承诺→reward≤0。不强调 user message 标识（coms 也是 user message）。
**规则 6b（L1 软性判断）**：`L1 DOMAIN CHECK (soft, NOT mandatory)`——考虑激活 L1 与任务领域语义距离，缺领域节点时 **MAY** 新增（机制新颖可复用才加）；层满≠必须扩容、离域≠必然错，逐案判断。

### 4. pairing judge prompt 修复（index.ts:2173）— 未重启生效
**问题**：决策1/复盘1 被 judge 判"非反馈"→ skip，轨迹→backward 转化率仅 50%（23:45-23:52：7 注入、3 配对、2 ok）。
**修复**：显式识别 EXECUTION RESULTS（trade_result/portfolio/decision JSON/复盘/打分）为反馈；coms 消息携带执行结果 = 对 sender pending task 的反馈；**有 pending 且存疑默认 isFeedback=true**（保守配对优于丢失学习信号）。

### 5. commitNodeHtmlEdges 统一收口（node_policy.ts + index.ts backward 边更新两处）— 未重启生效
**问题（账货不一致）**：backward 边权重更新（index.ts:1667-1709）只 `writeJson(weights)` 不刷 HTML link → HTML（货）与 weights（账）不同步 → Monitor 显示"假孤立"节点（node_13 激活 64 次、weights 10 条边、HTML 0 link）。
**修复**：node_policy.ts 新增 `commitNodeHtmlEdges(net, layer, nodeId)`——从 weights 账本读 outEdges 重写 HTML link；backward 边更新（正奖励/负惩罚两处）改为"writeJson + 解析 changedEdges 提取受影响节点逐个 commitNodeHtmlEdges"。**用户明确否决 syncHtmlEdgesFromWeights 事后扫描补丁**——改为源头收口。

### 附：monitor.html Harness 轨迹不显示动作/观察（08-19 早）— 已生效
删除 tool_call/tool_result 的 chain.push，轨迹只显示 💭思考 → ✦回答。

### 附：local-coms.ts 调试日志（临时）— 已生效
`pi.on("input")` 打印 source/streamingBehavior 到 /tmp/coms_debug.log；sendUserMessage 调用点日志。**验证后可删**。

## 二、问题与待办（按优先级）

### 🔴 P0：backward 栈溢出（未排查）
**现象**：`Textron semantic backward (agent_end): status=failed error=Maximum call stack size exceeded`（runId 1787097189374-ns45er 23:54、1787097325211-mc8t3r 23:56）。同时网络状态异常：`4/67 nodes, 9 path`、cold_start_virtual_l0 触发（L0 评分失败 local_fallback）。
**疑似**：①HighEntropy/Function 解析递归（parseHighEntropyCrystal/extractHighEntropy）；②buildBackwardTaskContext previousTaskForBackward 递归；③commitNodeHtmlEdges 或边更新路径循环；④backward LLM 返回超大/嵌套内容导致 JSON.parse/节点更新栈溢出。
**排查方向**：加日志定位栈溢出具体函数（node 栈无法打印，需在 backward 各阶段 try-catch + 阶段标记）；查 runId ns45er 的 backward 输入大小。

### 🟠 P1：轨迹→backward 转化率 50%（pairing judge 修复待验证）
23:45-23:52：7 注入、3 配对、2 ok。pairing judge 修复（#4）待重启后验证是否到 ≈100%。**审计纪律**：n8 分析须主动算转化率、暴露 skip 原因，勿等用户指出。

### 🟠 P1：账货不一致存量（commitNodeHtmlEdges 待重启生效）
存量"假孤立"节点（node_13/14/17 等 HTML 无 link）需在重启后由源头收口逐渐修复；不采用 sync 全量扫描补丁。

### 🟡 P2：L1 信息稀疏 + 离域占槽
L1 平均 content 431 字符（L0 607），node_5 仅 195 字符碎片（ngram 残留），node_1 是 AI 武器离域节点。merge 90 次压碎内容 + 离域占槽。规则 6b 软性判断已改，待观察。

### 🟡 P2：账外残留文件
每层 1 个超 hyperparams 的 node_X.html（L0 node_21、L1 node_9、L2 node_48，有内容有边）——expand 建节点与 hyperparams 落盘的编号漂移，需归并非删除。

### 🟢 P3：L0 评分 json_mode 偶发失败
`No parseable node scores`（deepseek 返回中文解释而非 JSON）→ local_fallback 兜底（10s 超时）。非 401，属降级非故障。

## 三、经验教训（已沉淀节点）
1. **reward 是反馈的量化，HighEntropy 是反馈的事后总结，有先后性**——reward 判定输入必须与 HighEntropy 解耦，HighEntropy 只做节点内容素材
2. **方案 ≠ 执行**：不要写"方案描述"当"已完成"，落地必须过 expect 断言（如 HTML link 数 == weights 边数）才给正分
3. **运行工作流 + 添加日志判断根因**，优于静态分析日志
4. **该学没学要靠指标告警**：backward failed、转化率低、任务栈只 push 不消费，都须显式记录+告警，不能静默

## 四、重启验证清单（重启 sender/worker 后）
| # | 验证 | 方法 | 预期 |
|---|------|------|------|
| 1 | pairing judge 修复 | 重跑 2 次交易 | 转化率 ≈100%（每条 coms 决策/复盘都 backward） |
| 2 | 栈溢出排查 | 复现 backward | 无 Maximum call stack |
| 3 | 账货一致 | 查 node_13 HTML link | HTML link 数 = weights 边数 |
| 4 | L1 领域新增 | 观察 backward addNodes | 离域 L1 出现领域补位（软性判断） |
| 5 | reward 极性 | 用户批评后看 reward | 批评 → reward≤0（非正分） |
