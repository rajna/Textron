# Textron HANDOVER（压缩版）

> 用途：跨会话交接。保留「未生效改动 + 硬性约束 + 待办 + 决策经验」，历史细节归档为一行摘要。
> 备份：`HANDOVER.bak.20260903_0904.md`（压缩前原文 505 行）。
> 生效规则：**index.ts / extension 改动一律需 `/reload`（或重启 pi）才生效**；monitor.html 8766 按请求读盘即时生效；7860/8770 服务各自重启。

---

# ✦ 最近更新（2026-09-16 03:05）：n8 **第十七轮** —— **`75847ed`（任务侧域闸）按登记判据回滚**：`semantic_backward_off_domain` 连续三轮恒 **0**，且窗口内 12 次 `semantic_backward_llm_raw_response` 中 `off_domain` 字段出现率 **0/12** ⇒ 该闸**结构性不可触发**（判据维度错位：问「本轮任务是否属域」，而任务标签恒在域内）。本轮**删闸 + 把判据面迁到「`<Function>` 块的机制域」**（只 gate 两条程序化写入通道：Function 硬落盘 + HE fallback add），并实施函数侧域闸 `evaluateFunctionDomainGate`/`functionDomainGateRule`。

> 触发：guard n8 第十七轮。三件套 02:49 重启 ⇒ **首次运行期加载 `a121d67`**（第十六轮补丁）。
> 窗口 = `_events.jsonl` **L97841–L98225**（384 事件 / 8 propagate / 6 `agent_end_task_pushed` / 6 反传 LLM / 5 `semantic_backward_entered` / 3 `highentropy_function_persisted` / 2 `fallback_add_candidate`）；基线 = 重启后首条 `before_agent_start` `18:48:13.177Z`。
> n6 结果：sender 完成 **2/2**（自计 `/api/step` 从 0 起算）；① `买入 200股 @54.93`（D+1 04-28；总资产 103,467→102,922，单步 **−0.53%**）② `持有 0股`（−0.005%）；`session_id=4cf529337f29`、`active_stock=sz.301299`、`step_index` 70→**72**、`current_date=2025-04-25`；worker 两轮迭代 `trade.py` 664→**885 行**（`7412286`，ABI/枚举未变）；本轮 0 超时 / 0 空包。
> 第十六轮一行摘要：实施 `a121d67`（`patchTaskRawPrompt` 取材回落 matched→active_task→current_round_prompt）；**本轮实测 `taskPromptPatch` 5/5 = `matched`、`taskPromptPatchedRawChars` 5/5 = 0** ⇒ 该分支**未被触发**（matched 自带原文）⇒ 症状消失但补丁路径仍未获运行期验证。
> 第十五轮一行摘要：实施 `75847ed`（反传写入侧整轮早退；语义边界＝**只禁内容面、不禁学习面**）+ 破例改共享层 `local-coms.ts`（空包修复，备份 `.bak-emptyreply-20260915-222627`，**默认保留**）。

## 一、第十六轮改动 + 登记判据的运行期验收（逐条字面）

| 上轮改动 / 登记判据 | 判据 | 本轮实测（字面） | 结论 |
|---|---|---|---|
| `a121d67` 任务侧原文补齐（E1'） | `taskPromptPatch ∈ {active_task, current_round_prompt}` 且这些轮 `learningPromptSource=="raw_prompt" ∧ rawPromptChars>0` | **`learningPromptSource=="raw_prompt"` 5/5、`rawPromptChars` 931/1062/1366/1799/1851 全 >0**（对照上轮 2 轮为 `high_entropy ∧ 0`）；但 **`taskPromptPatch` 5/5 = `matched` ∧ `taskPromptPatchedRawChars` 5/5 = 0** ⇒ 补齐分支**未被触发**（matched 自身带原文） | 症状 ✅ / 补丁路径 ⏳未验证 |
| `75847ed` 域闸触发（E2'） | 窗口出现 `semantic_backward_off_domain` | **0 次**；且 12 次 `semantic_backward_llm_raw_response` 中 `off_domain` 字段出现率 **0/12**（LLM 从未输出该字段）⇒ 非「触发后漏写」 | ❌ **登记判据命中 ⇒ 回滚** |
| `75847ed` 域闸有效（E2 / E3'） | 离域内容不新增工程域 symbol；交易域 symbol 仍可 persisted | 新增工程域块 `sender_step_loop_orchestrate` **硬落盘** `L0::node_0`（`fn_block_evicted` 顶掉交易域块 `pi_star_gate_delta_decision`）；闭合块 **7** 个中工程/编排域 **4**（`archive_receipt_insights_once`/`audit_decision_enum_semantics`/`minimize_workflow_handoff_fix`/`sender_step_loop_orchestrate`），交易域 3（`daily_settle_exposure_gate`/`momentum_veto_pi_gate_decision`/`veto_graded_partial_fill`）；交易域 `momentum_veto_pi_gate_decision` 正常 persisted 1 次 | ❌ |
| 悬空 `[fn:σ]`（E4'） | ≤ 27 | **33**（上轮 27；本轮新增 dangling `turn_based_step_driver`、`pi_star_gate_delta_decision`）⇒ 淘汰仍只记录不清理引用 | ❌ |
| `selected ⊆ context`（E5'） | 重启后每轮成立 | **8/8 成立**（含重启后首轮 `18:48:14.434Z`；`contextCount` 2–4） | ✅ |
| `b337ed3` 空包修复（沿用） | 无静默空包；n6 无超时 | 窗口 0 命中 `empty_assistant_text`；n6 全程无超时重发 | ✅ |
| `db33ba8` 轨迹工具侧保真（沿用） | `inputPreview` 不再恰 180c | 84 条 `tool_call` **恰 180c = 0**、max 300c；6 次 `trajectory_tools_fidelity`（`entries` 1–27、`droppedOldest` 全 0、`thinkingTruncated` 全 false） | ✅ |
| 反传链健康（沿用） | entered→llm_done 无掉链、有真融合 | 6/6 `semantic_backward_llm_done{status:ok}`；4 次 `semantic_backward_apply`；**真融合 1**（`nodesMerged=1`+`nodesUpdated=1`）；`merge_action_lifted` ×2（`L3::node_0→L0::node_0 delta=3`、`L3::node_0→L1::node_1 delta=2`）；`node_write_refused_keep_better` ×4 | ✅ |


## 二、本轮正向事实（当基线，勿再当缺陷修）

- **`a121d67` 目标症状已消失（但非“补丁生效”）**：`learningPromptSource=="raw_prompt"` **5/5**，`rawPromptChars` 931/1062/1366/1799/1851 全部 >0；`task_stack_persisted` 6 次均带 `rawPromptCount/rawPromptChars`（9882 / 3844 / 4171 / 4119 / 4319 / 16882），`task_prompt_restored` 3 次（sender 6 条中 `rawPromptEmpty` **1**）。⇒ 上轮 `rawPromptChars=0` 的真因是**pending 旧条目未落盘 `rawUserPrompt`**，由 `7b6862b` + 本轮重启恢复消除，**不是** `patchTaskRawPrompt` 把它补上的（该分支 5/5 未走）。
- **轨迹未 slice 稳态**：84 `tool_call` 恰 180c = 0 / max 300c；`trajectory_tools_fidelity` 逐轮可读（`inputTruncated` 0/1/0/0/0/0、`outputTruncated` 0/2/0/0/2/2、`droppedOldest` 全 0、`thinkingTruncated` 全 false）。
- **反传写入链健康**：6/6 `semantic_backward_llm_done{ok}`；**1 次真融合**（`nodesMerged=1` + `nodesUpdated=1`，`L2::node_1` name「收缩箱体上沿追多反例」→「…squeeze 禁扩张 admit 闸门·减仓不受限」）；`merge_action_lifted` ×2；`node_write_refused_keep_better` ×4（`L0::node_0 .0443 > .0284/.0082/.0196`、`L3::node_0 .0283 > .0133`）。
- **注入门禁**：8 次 `propagate_done` 均 `selected ⊆ context` 且 `contextCount` 2–4，无 0 注入。
- **规则内化能力（对下一轮有利）**：LLM 在 `rationale` 中主动引用域内/域外判定（如 18:54:39 `rationale="任务域内但无用户反馈极性…"`）⇒ 说明“函数/内容属域”这类问法对它不陌生，只是上轮问的是**任务**域。


## 三、本轮根因（R7，单变量）：域闸**判据维度错位** —— 任务域 ≠ 内容域

- **判据面**：`evaluateTaskDomainGate` 只读反传 LLM 输出的 `off_domain`，而规则 -1 的问法是「whether **THIS ROUND'S TASK** itself belongs to that goal domain」⇒ 问的是**任务标签的域**。
- **字面证据三角（互不矛盾，合起来证明“闸门结构性不可能触发”）**：
  1. **任务侧全在域内**：窗口 6 条 `agent_end_task_pushed.taskType` = `多agent交易游戏调度` / `A股限价撮合决策` / `A股交易准入闸门修复` / `A股持仓准入判定` / `A股闸门阈值标定复盘` / `多智能体交易游戏派发记账`，`taskFamily=stock_alpha` ⇒ LLM 判 in-domain 是**正确的**（并非偷懒）。
  2. **内容侧确实离域**：同轮 HE 的 `<Function>` 块 `sender_step_loop_orchestrate`（内容：计数口径必须与观测状态解耦 / `POST /api/step` / session 重建）**硬落盘** `L0::node_0`，把交易域块 `pi_star_gate_delta_decision` 顶出（`fn_block_evicted{dangling}`）。
  3. **LLM 输出零字段**：12/12 `semantic_backward_llm_raw_response` 无 `off_domain`；规则自己写的 "Default is IN-domain … do NOT set off_domain" 在“任务真在域内”时**永远**命中缺省分支。
- **后果**：闸门成为**死代码 + 复杂度**（每轮 system prompt 多注入 ~1.6KB ABSOLUTE 规则占用 LLM 注意力，12 次反传收益 0），且**不可能**拦住真正的污染 —— 污染走的是**程序化写入通道**（`persistHighEntropyFunction` / `buildHighEntropyAddCandidate`），这两条通道**没有自己的内容判据**，却去依靠一个永远为 false 的任务标签。
- **与 R5/R6 的关系**：R5 = 「谁在判」错（goal guard 单向 + `pinnedTaskFamily` 全局 pin）；R6 = 「拿什么判」错（任务侧取材）；**R7 = 「判的维度」错**（问任务域，实际要问内容/函数域）。若只修 R5/R6，闸门仍因维度错而恒不触发（实测：R6 的输入已经补齐为 `raw_prompt` 5/5，闸门仍 0/12）。
- **不变式（新增）**：**程序化写入通道（免 LLM 内容判据的落盘）必须自带「机制域」判据**；不得用「任务域」代表「内容域」。
- **反向教训（防止把假象当成功）**：判据“输入正常”（`rawPromptChars>0`）≠ 闸门“会工作”（`off_domain` 出现）；验收必须直接数**输出字段/事件**，不得用上游前提推断。
- **另一条（沿用）**：**任务原文属上游输入，不可由事后总结替代**（lifecycle_context 头注释）。


## 四、本轮实施的改进（git `518c99a`；**需 n9 重启三件套生效**）

**回滚 `75847ed` + 判据面迁移（FUNCTION-SIDE DOMAIN GATE）**——只改**一个变量：域闸的判据维度**（task → function），而非新增第二套机制：

- **① 回滚（登记判据字面命中）**：删 `index.ts` normalize 内的整轮早退块（含 `semantic_backward_off_domain` 事件与 `out.off_domain*` 字段）、删 `evaluateTaskDomainGate` / `taskDomainGateRule` 引用。回滚後 `node_updates/add_nodes/merge/reward` 不再受域闸影响。
- **② 迁移 —— `src/domain_gate.ts` 重写**：
  - `evaluateFunctionDomainGate(raw)`：读 LLM 输出的 `function_off_goal === true`（严格 boolean；缺失/false/`"true"` 一律视为在域内 ⇒ **不输出字段时行为 ≡ 回滚前**，改动只能改善不能改差）；`reason 取自 `function_off_goal_reason`（回退 `rationale`，上限 200c）。
  - `functionDomainGateRule(netGoal)`：问「**`<Function>` 块的机制**是否属目标域」，并**显式禁止用任务标签代替**（"never the round's task label — a round may legitimately be 'trade N times' while the function it produced is pure orchestration plumbing"）；列离域族（engineering / refactor / observability / workflow orchestration / agent relay & idempotency / API-session lifecycle / bookkeeping / UI / config / audit）；**对称给在域内示例**（price/level/position sizing、risk/exposure、entry & exit gating、volatility、volume、K-line pattern、market structure、reusable strategy function）。
- **③ 只 gate 两条程序化写入通道**（这是“内容面”之真正含义）：
  - `persistHighEntropyFunction`（`<Function>` 硬落盘；每节点 `NODE_FN_BLOCK_MAX=2` ⇒ 落一个即淘汰一个已有函数槽）；
  - `buildHighEntropyAddCandidate`（无 node_updates 时的 HE fallback add）。
  ⇒ **不再整轮早退** ⇒ 结构上不可能误杀真交易轮（E3' 保护面天然成立），也不吞内容面学习信号。
- **④ 可观测**：触发记 `semantic_backward_function_off_goal`；被拦时额外记 `highentropy_function_skipped{reason:"function_off_goal", functionBlockChars}`（**拦截不静默**）。
- **⑤ 验证**：`test_function_domain_gate.ts` **34/34**（T1 严格判据 10 例 / T2 reason 回退+200c / T3「旧早退已移除 ∧ 新闸不 `return out` ∧ 双通道守卫 ∧ 事件切换」/ T4 规则先于 rule 0 + 对称问法 + 缺省在域内）；回归 9 套件全过（`task_prompt_patch 17`、`fn_multiblock_move 16`、`fn_block_survival 9`、`lift_merge 42`、`lift_overflow_dup 15`、`lift_jump 18`、`task_persist_roundtrip 15`、`tools_fidelity`、`content_limit_zero`）；`LOAD_OK src/index.ts`；`domain_gate.ts` md5 `97b664ce4632a456399664f643030b8b` 已 `cp` 同步到 `~/.pi/agent/extensions/textron/`（**实体副本**，硬性约束 8；index/lifecycle/… 为符号链接自动同步）。删除 `test_off_domain_gate.ts`（其断言已由新套件的 T3 反向覆盖）。
- **边界**：本闸仍**由 LLM 判定**（程序侧零词表，不变式不破），不重蹈 `no_domain_evidence`（`7987145`）的覆辙（那是程序侧词表预判）。


## 五、下一轮验收断言（逐条可字面核对）

- **F1'（新闸触发）**：窗口出现 `semantic_backward_function_off_goal`，其 `reason` 指向**函数机制**（非任务标签）；且同轮出现 `highentropy_function_skipped{reason:"function_off_goal"}` ⇒ 硬落盘确实被拦（而非只记不拦）。
- **F2'（不误杀、不吞学习）**：交易域 Function（`gate`/`sizer`/`momentum`/`exposure`/`atr`/`position`/`kelly` 语义）仍能 `highentropy_function_persisted`；且 `semantic_backward_apply` 的 `nodesUpdated/nodesMerged` **不低于**本轮基线（1 真融合 + 4 次 `refused_keep_better`）⇒ 证明“不整轮早退”落地。
- **F3'（工程域块占比下降）**：磁盘闭合 `<function>` 块中工程/编排域 **≤ 3**（本轮 4/7），且 `L0::node_0` 的 2 个函数槽中**至少 1 槽为交易域**（防再出现 `sender_step_loop_orchestrate` 顶掉 `pi_star_gate_delta_decision`）。
- **F4'（悬空不增）**：悬空 `[fn:σ]` **≤ 33**（本轮基数 27→33）；理想情形下降（需 P0-2 一并实施）。
- **F5'（`selected ⊆ context` / 注入）**：延续 **8/8**；`contextCount ≥ 1`；轨迹工具侧仍无“恰 180c”。
- **反证判据（防“改完就宣称成功”）**：若窗口 `semantic_backward_llm_raw_response` 中 `function_off_goal` 字段出现率 **< 30%**，则判本迁移**未生效**（而非失败）—— 因为缺省=在域内，LLM 不答即行为等于回滚前，需转 R7 剩余面（程序侧硬判据缺位，如：只允许与已激活交易域节点共享 `functionSymbol` 的函数落盘）。
- 不变式（沿用）：`injectedCount ≥ 1` ∧ 拒写时 `scoreOld > scoreNew` ∧ 同层逐字同文计数 = 0 ∧ 零成交轮 `flat/unattributed`。


## 六、下一轮 P0 候选（按杠杆排序，**仍只挑一项**）

1. **配对源根治（R6 剩余面）**：查 `allPendingTasks` 的来源（本轮仍见跨进程/陈旧匹配：`matchedTaskTs` = `18:33:28Z` / `18:35:42Z` / `18:35:55Z`，而窗口基线为 `18:48:13Z`）——让候选集合只含「本会话 + 未消费」任务，或 `matched.rawUserPrompt` 为空时**改选** activeTask（`a121d67` 只治素材，未治「配对身份」）。判据：`semantic_backward_entered.matchedTaskTs` 不再早于窗口起点 10 分钟以上。
2. **悬空 `[fn:σ]` 清理（连续四轮未达标 4→17→27→33）**：`fn_block_evicted` 时同步从 content 剥离 `[fn:σ]`（现只记 `dangling`）；加每轮反传后回扫 `fn_ref_dangling`（**仅记事件，不自动改写节点**）。**硬性约束 2：存量悬空不得手工清理**。
3. **函数槽淘汰优先级（本轮新量化）**：`NODE_FN_BLOCK_MAX=2` 下工程域函数顶掉交易域函数已成**重复现象**（`turn_based_step_driver`←`classify_reply_failure`；`sender_step_loop_orchestrate`←`pi_star_gate_delta_decision`）⇒ 优先淘汰 LLM 判为离目标域的函数块（判据仍须由 LLM 给，不得写词表）；或把 `L0::node_0` 的函数槽按域隔离。
4. **域隔离的「配置/注入侧」**（R5 剩余面）：`pinnedTaskFamily` 全局 pin ⇒ 本轮仍 8 次把交易网络注入 guard/sender 会话（`context_user_message_injected`）；选项：pin 改 per-session / 每轮 `autoRouteNetworkDecision` 复核域一致性并记 `route_domain_mismatch`。
5. **`no_pending_match` 丢自产 HE ⇒ self-backward（本轮实测 2 次）**：窗口 `agent_end_backward_skipped{reason:"no_pending_match"}` ×2 与 `highentropy_missing_at_agent_end{reason:"raw_operational_trace"}` ×2；`semantic_backward_skipped_not_feedback{pairing_judge_no_match}` ×2（`pendingCount` 3/5，候选 taskType 全工程域）。落盘时 `reward=null/unattributed`，**不得让 HE 驱动 reward**。
6. **事件写入者归因**（沿用）：`pid` + `md5(src/index.ts)`（本轮 md5 `97b664ce…` 为函数侧域闸版本）。


## 七、n6 运行观察（第十七轮，工作流层）

- **硬性约束 10（禁全盘 find/grep）本轮生效**：guard 下发的指令内置可复制 curl 样例（`session_id`/body 形状齐全）+ 指向 `workflows/API.md`；sender/worker 全程无卡死（对比第十六轮两次 4m50s / 3m40s 阻塞）。⇒ 「**具体化指令 = 把探索成本从子 agent 收回控制方**」是有效治法。
- **超时/空包**：本轮 0 超时、0 空包（`b337ed3` 修复后第二个完整 n6 轮）⇒ 保留复现观察。
- **计数口径**：sender 自计 2/2 与存档 `step_index 70→72` 一致（差值恒 2）⇒ 「自计数 + 存档旁证」的对账式已连两轮成立，可作 n6 默认写法。
- **边界遵守**：worker 全程只与 sender 交互、未直连 guard；sender 唯一一次通知 guard（幂等）⇒ 越权未复现。
- **worker 迭代幅度**：`trade.py` 664→**885 行**（+221）；**注意**行数不能当等价性证据，无 ABI 断言时不得据此判「ABI 未变」；本轮仍无 ABI 断言 ⇒ 待补。
- **子 agent 互写碰撞（新观察）**：三件套共享 `_events.jsonl` 且同 `taskFamily` ⇒ sender/worker/guard 的 pending 池会**互配**（guard 首轮 `matchedTaskTs=18:33:28Z` 指向重启前旧任务）——与 P0-1 同源，不是孤立现象。


### 通用纪律（跨 agent 回执，与「事后判别」并列）
- **事前暴露 —— 关键结构化请求必带 `response_schema`**：空包在 `agent_end` 侧只输 `payload=rawAssistantText` 而不置 error；但若 inbound 带 `response_schema`，`JSON.parse("")` 必失败 ⇒ 立刻变显式 `error="response not valid JSON"`。即：**同一缺陷的暴露度取决于请求是否带 schema**（带 ⇒ 可观测失败；不带 ⇒ 静默 `response:""`，表现为对方「未回/超时」）。故跨 agent 要求 JSON 决策/字段的请求一律携带 schema。
- **适用边界（勿滥用）**：`response_schema` 只在**确实要求结构化输出**时携带；否则对方一句合理纯文本回复会被 `JSON.parse` 失败误判为 error。另：error 语义应区分「解析失败」与「无回复」，不可合为一种。
- **三向判别式（把「超时」消解）**：拿到 envelope 后按三类归因——①`error="empty_assistant_text"`（修复后）或旧版 `response===""` ∧ `error===null` ⇒ **空载荷**；②`error="response not valid JSON"` ⇒ **载荷非空但不合 schema**（模型问题，不是链路）；③**无 envelope** ⇒ 才考虑真超时/未发送。磁盘证据（mtime/行数）只能证明**存活**，证明不了**载荷非空**。
- **事后判别（前一条纪律）**：查 `local-coms-log` 的 `response_out.error` + 对端末条 assistant 的**块类型**（`thinking`/`toolCall`-only 轮无 `text` 是空包的必要条件）。

## 八、交易游戏 prompt 决策枚举语义修正（stock-trade 仓，非 textron 代码）

- **触发**：M1/M2 —— `不建仓更换股票` 曾被解读为「本轮须报出替代标的」；三个「不建仓*」缺前置条件。
- **修正点（单一事实来源）**：`skills/stock-trade/UI/app.py` 的 `_build_ai_prompt` 决策语义段：
  - **M1（跨轮两阶段）**：`不建仓更换股票` 写明「本轮只登记换股意图、不报出替代标的、`tradePrice/tradeQuantity` 必须为 0；**换标的动作发生在下一轮**」（本轮给出的价格不参与选股）。
  - **M2（前置条件）**：三个「不建仓*」均补 `【前置条件 position == null】`，并加注(A)：**三者本轮总资产变动完全相同**（均 0 价量、无成交），差异仅在**下一轮的搜索空间**——不表态 / 保留跟踪权（当前标的留观察名单）/ 放弃当前标的（下一轮起在新标的池中搜索）；附「不要为显得积极而写成买入」。
  - 加注(B)：持仓未清零时的**真实行为**——两个「不建仓」仍仅推进交易日（持仓不变、无成交），「不建仓更换股票」降级为等同「继续观察」且**不换股**，故持仓下无法用这三值换股，需先卖出清仓；注(C)：非交易决策价量一律填 0。
- **验收（改前/改后线上对照，非纸面）**：重启前 `GET /api/prompt` 输出旧文案（`- 不建仓更换股票: 寻找新的机会`）；`kill -9 32947` → `nohup python3 app.py` 重启后新文案全量输出，`/api/enter` 自动恢复存档 `session_sz.301299_20260915_230629.json`（active_stock=sz.301299、step_index=70、现金 ¥70,275 无损）。
- **git（stock-trade 仓）**：`c218488`；备份 `UI/app.py.bak-decisionsem-20260915-2305xx`。
- **其它副本的已知差异（本轮未改，供后续统一）**：①`scripts/llm_strategy_generator.py:64` 的枚举**缺「不建仓」**且无语义说明（仅被 test 脚本引用，非主链路）；②`UI/index.html:165` 下拉仅选项名无提示；③`scripts/stock_trading_game.py:436` 为实现层（三值均走 `no_position`）无需改。
- **附带发现（待下轮核对，勿当缺陷修）**：同一 (sz.301299, 2025-04-23) 在 `/api/prompt` 的总资产为 **¥103,485**（按 04-23 收盘 55.35×600 估值），而 sender 回执为 **¥102,783**（按成交价 54.18×600）= 相差 +¥702？⇒ 疑为「成交价 vs 当日收盘价」两套估值口径：`54.18` 是 04-22 收盘（决策 04-23 时的参考价），`55.35` 是 04-23 收盘。下轮对一下 `_equity_point` 与 `get_portfolio_value` 的取值基准，并同步 sender 报数口径。

## 九、选股模块抽取 + 枚举语义精简（stock-trade 仓）

- **背景**：选股策略是要反复迭代的对象，却与 Web 层（`app.py`，2000+ 行）耦合。
- **抽取（`UI/stock_picker.py`）**：`normalize_symbol` / `load_stock_pool` / `get_used_games` / `get_used_stocks` / `pick_new_stock`。
  - 契约四要素成文：①**池**（`A股股票列表.csv`，剔北交所 4/8/92 与 ST/退市）②**记录池**（键 `股票@date_start`，**同股不同起始日期可复用**，来源=存档扫描而非独立台账）③**回避规则三级回退**（显式 `exclude` → 同股同时段 → 仅 `exclude` → 全池）④**`rng` 可注入**（可复现）。
  - 另加 `save_dir` / `csv_path` / `pool` 注入点与 `STOCK_LIST_CSV`、`STOCK_TRADE_STATES_DIR` 环境变量覆盖；文件头列出「**可迭代点**」（池构成 / 回避语义 / 采样分布 / 路径）。
  - `app.py` 删除 **112 行**原实现，改为名字绑定导入（调用点零改动）。
- **等价性验收 39/39**（不得以 diff 代替）：legacy 原实现 vs 新模块，**固定种子 × 6 场景 × 300 次输出逐一相同**；`normalize` 13 例、池 **5013** 逐一同、记录池 **21** 逐一同；边界（空池/全池排除回退 2/全池同股同时段回退 1）全过；`app.pick_new_stock is stock_picker.pick_new_stock` ⇒ **绑定同源**。
- **枚举语义精简（职责分层）**：删除全部 `【前置条件 position==null】`、价量归零约束与注(A)(B)(C)，仅保留「**不建仓更换股票: 本轮不建仓; 下一轮系统会给出新的股票**」（唯一模型无法自行推知的跨轮信息）。
  - 理由：前置条件与价量归零由 `/api/step` 的 `_normalize_decision` **强制**，属执行层职责；写进 prompt 会**诱导模型去模拟护栏而非做决策**（且同一规则两处表述必然漂移）。
  - 量化：枚举语义段约 **1500c → 260c**。重启 7860 并 `/api/prompt` 线上实测（存档 step 70 / 现金 ¥70,275 无损）。
- **git（stock-trade 仓）**：`b4461bc`；备份 `app.py.bak-leansem-*`。**提交纪律**：用 pathspec 提交（`git commit <paths>`），避开仓库中他人已暂存的无关改动。

- **「可迭代 vs 必须不变」边界成文（第十五轮追加，`_selfcheck_contract()` 可守卫）**：用户追问后固化为模块内文档 + 可执行断言。
  - **可迭代**：池构成 / 回避语义 / 采样分布（现为 `rng.choice` 均匀）/ 回退层级 / 路径配置 / **追加带默认值的可选参数**。
  - **不得变（I1–I6）**：①公开函数名与参数名序冻结（app.py 名字绑定导入，只能追加可选参数）；②返回形态（`normalize_symbol` 非法→**空串而非 None**；池/记录池恒 `List[str]`；`pick_new_stock`→`str|None`）；③记录池键 `f'{sym}@{YYYY-MM-DD}'` 且数据源**必须是**存档 `session_*.json`（禁独立台账，否则与存档漂移）；④**回避硬保证**（只要池内有合格候选，绝不返回 `exclude` 项或同股同时段已参加项；三级回退仅当候选耗尽）；⑤失败模式（空池/缺文件/坏档 → `None` 或空列表，**不抛异常**，否则 Web 层当 500）；⑥纯逻辑（不引 Flask/网络/全局可变状态）。
  - **变更协议**：重跑固定种子等价验收 → 有意变更须显式记录影响面（哪些历史结论/阈值失效）→ 重启 7860 线上取证 → pathspec 提交。
  - 实测：`python3 UI/stock_picker.py` ⇒ **契约守卫通过**；加守卫后等价性复核仍 **39/39**（行为未变）。

---

## 十、交易成交机制核查（含**两处撤销**；第十六轮再修正）

- **⚠️ 第十六轮修正（2026-09-16，以此条为准）**：上条「成交价 ≡ 申报价原价」**再次作废** —— 现行代码为**限价单真实撮合**，`UI/app.py` `_patch_limit_order_validation()`（L325-345，包装 `buy_stock`/`sell_stock`）：
  - `trade_idx = min(saved+1, n-1)`（成交基准＝T+1）；`day_open = historical_data.iloc[trade_idx]['open']`；
  - **买入 `effective = min(申报价, T+1 开盘价)`；卖出 `effective = max(申报价, T+1 开盘价)`**（开盘价触及即按市价成交）⇒ **零滑点仅相对于「开盘价」而非相对于申报价**。
  - **实盘证据（本轮 n6）**：申报卖出 55.35 ⇒ `fill=55.71`（= T+1 开盘）⇒ 申报价**只作限价锚**、不是成交价。prompt 里「成交价默认参考最近收盘价」指的是**决策参考价**，非成交价。
  - ⇒ 「fill ≡ 申报价」的旧结论、以及网络 `L0::node_1` 节点正文中的「**成交价≡申报价、零摩擦、触及即全额**」均已**与代码不符**：这是**已固化进 L0 锚点的错误机制知识**，且每轮被注入给决策者（worker 本轮自行纠错 ①）。**不得手工改节点**（硬性约束 2），只能靠后续 reward/backward 自然覆盖，故在此登记。
- **结论（仍成立部分）**：唯一闸门是**成交日 D+1 那根日 K 的 `[low, high]` 闭区间**（`low ≤ price ≤ high`，端点含等号：报价 46.89 对 low 46.90 差 **1 分**即拒）。越界 ⇒ `success=false`，但**仍推进一个交易日**（白耗回合，通常还记 −2）。
- **真相源纪律（本轮方法论收获）**：判定「校验用哪一天」必须用**运行期报错文本里打印的区间**反查，**不得**用存档字段或代码顺序推断——**284 条 `success:false` 记录的报错区间全部等于 `next_date` 区间、无一条等于 `date` 区间**（如 step59 报 `[46.90,50.28]`＝04-08 区间，而 record `date`=04-07 的区间为 `[46.50,54.95]`）。
- **撤销上一版结论**：本轮中途曾据「`handle_trade` 先于 `next_trading_day`」＋存档 `step_record.date` 推断「校验用基准日(date)」，并据此提出「prompt 与校验不同源、需改 prompt」——**该结论作废**：prompt 的「下一交易日可成交区间」与代码实际校验**本就一致**；`date` 字段语义是「**决策依据日**」，不是校验日。⇒ 教训：字段名的直觉语义 ≠ 执行期语义。
- **机制性质**：这是**结果反验型护栏**（用**事后**可知的日内极值判定「限价当日是否被触及」），把过程中撮合（排队优先级 / 对手盘存在性 / 部分成交 / 更优价撮合）压缩成**布尔判定** ⇒ **系统性高估可成交性**。真实 A 股限价单需盘中触及**且**有对手盘，且成交价可能优于委托价。
- **待核对（勿当缺陷修）**：同一 `(sz.301299, 2025-04-23)` 在 `/api/prompt` 的总资产 **¥103,485**（按 04-23 收盘 55.35×600 估值）vs sender 回执 **¥102,783**（按成交价 54.18×600）＝差 **+¥702**，疑为「成交价 vs 当日收盘价」两套估值口径 ⇒ 下轮核对 `_equity_point` / `get_portfolio_value` 的取值基准，并统一 sender 报数口径（否则跨轮收益率不可比）。

# ✦ 前序轮次一行摘要（第十~十五轮 + 更早，细节见 git 历史与已沉淀节点）

- **第十五轮（09-15 22:35）**：n8 首次运行期验收 `db33ba8`/`c8b015d` ⇒ A1 轨迹工具侧保真 ✅（`inputPreview` 恰 180c 22→0）、A2 多块搬运 ✅（闭合真块 7）；A3 ✗（悬空 `[fn:σ]` 4→17）、A4 ✗（域隔离 4/9 非交易域）。根因 **R5 = goal guard 单向 + `pinnedTaskFamily` 全局 pin**（离域知识不是多占位置，而是**淘汰域内事实**）⇒ 实施 `75847ed` 任务侧域闸（`src/domain_gate.ts` 新 + `index.ts` 早退：`off_domain===true` ⇒ 内容零写入、reward 原样返回 ⇒ 只禁内容面不禁学习面）。**破例**改共享层 `local-coms.ts`（静默空包 ⇒ 「仅非空时覆盖」+ `empty_assistant_text`；备份 `.bak-emptyreply-20260915-222627`，默认保留）。
- **第十四轮（09-15 21:30）**：第十三轮改动运行期验收 ✅（`00dc022` merge 不再造双胞胎 / `7b6862b` 任务栈落盘 `rawUserPrompt`）。查出 **Function 块 50% 蒸发真因**＝R4a 单块搬运（`node_policy` 用 `readNodeFunction` 单数）＋R4b 淘汰静默 ⇒ 修 `c8b015d`（多块搬运 + error 级 `fn_block_evicted`）；轨迹工具侧三层静默 slice（input 180c / output 640c / `maxEntries=24`）⇒ 修 `db33ba8`（`clipWithMark` 尾标 `…[+Nc/Nc]`、`TOOL_INPUT_CAP=4000`/`TOOL_OUTPUT_CAP=8000`/`TOOL_MAX_ENTRIES=200`、事件 `trajectory_tools_fidelity`）。**遗留**：`pinnedTaskFamily` 全局 pin 致工程域知识灌入（→ 第十五轮 R5）。
- **第十三轮（09-15 19:40）**：**反传首次真正打通**（`nodesMerged=1`、Function 多槽共存、`node_write_refused_keep_better` 首次命中）。修 `00dc022`（merge 溢出判据在「写入不限制」下退化为「非空即溢出」⇒ 每次 merge 复制宿主副本）+ `7b6862b`（任务栈丢 `rawUserPrompt` ⇒ 反传「任务侧」永久退化为 HE 摘要）+ 补提交 `0405809`（轨迹全量 + `respondsTo` 配对链 + `/raw` 全量页）。
- **第十二轮（09-15 16:35）**：反传写入路径全断真因＝`completeContent(x, 0)` 把「不限制」当「截断到 0」（node_updates/add_nodes 共 6 处调用点 content 恒空）＋中文节点名被 `isNgramFragmentContent` 误杀 ⇒ 修 `2f8344e`；删 `no_domain_evidence` 预闸门（`7987145`）。**遗留**（后续已修）：`rawUserPrompt` 丢失、`no_domain_evidence` 静默跳过。
- **第十~十一轮（09-15 15:50~16:05）**：反传九连败真因＝`semanticBackwardLLM` 作用域内 `onLog` 未绑定（`ReferenceError`，一处绑定修复 `571205a`）；**三件套共享单态状态文件 ⇒ 配对错乱** ⇒ `TEXTRON_STATE_FILE` 按 cname 隔离（`_last_state.{guard,sender,worker}.json`；共享 `_last_state.json` 冻结）。
- **自进化三机制（09-15 16:4x，manual coding）**：删两处手写词表闸（域闸 / `ENGINEERING_RE`），收敛为「写入前置比较（相对判据）+ function 块多槽 + **LLM 为唯一语义判据**」。
- **第七轮（09-15 01:50）**：`goalSim` 恒 0 根因＝CJK 分词颗粒度；F1+F2 运行期验收 ✅。
- **F1/F2（09-15 01:30）**：孤儿候选池改**目录驱动**（事件 `l0_pool_dir_driven`）；确立 `selected ⊆ context` 保底注入（修阈值断层 R2）。
- **01:00 content 上限取消 + FUSION NOT OVERWRITE**：拆「抽象融合」两重天花板（`NODE_CONTENT_MAX_CHARS=0` 语义＝**写入不限制**；三段式 `keep/drop/delta`，只写 content 视为不合格）。
- **09-14 23:45 `HighEntropy <Function>` 硬落盘 + 前向 `⟨fn:σ⟩` 引用链**：可执行产物不再只留在轨迹里。
- **09-14 20:55 / 20:10 容量硬不变量 + layerCaps**：merge 派生 add 不再绕 cap；skip 不许静默（`over_cap` / 压缩强制回喂 `compressionMandate`，最多 2 轮）；每层 `layerCaps`（默认 40/层）。
- **09-14 05:58 Live Monitor 网络管理面板**：新建网络 / pin 切换 / 每层激活数。
- **09-05~09-04（四次）**：`agent_end` 单数据源重构（`lib/round_snapshot.ts`，回合快照从 `event.messages` 提取）；coms 投递改动态 idle（修多轮续接跳过 `before_agent_start` 致 reward 丢失）；`tool_result` 结构化提取（修 `String()` 得 `[object Object]` 内容全失真）；`tool_result`/AI 思考同权进任务上下文（修配对盲区＝`no_pending_match` 零反传根因）。
- **09-03（三轮）**：信息获取策略升级（中间轮 HE 优先/LLM 蒸馏、反馈轮全量、AI 思考默认排除）；任务栈生命周期改造（`isTask` 即入栈 / 中间动作 append / 绑定即出栈 / 轨迹全链可见）；semantic backward 三连败根因修复 + monitor 图回退。
- **09-14 第二~五轮（guard/default 验证轮）**：①Function 落盘调用链断裂已修（`functionBlock` 提升为同层单一事实来源，防 `ReferenceError` 击穿整轮反传）；②跨层「向上提升」merge 一刀切丢弃 ⇒ 解禁（`mergeLayerAllowed` 只拒**向下跳层**）；③function 块「稳态存活」缺陷族 P0 已修（块随内容移位从 **SOURCE** 搬运 + 污染块 sanitize `isValidFnSymbol`）；④第五轮根因（后已修）：**孤儿节点**（候选池由 `hyperparams.layers[0]` 驱动而非磁盘）＋**阈值断层**（`selected ⊄ context` ⇒ 0 注入，且**静默**跑了 7 回合无人报警）。
  **方法论固化（沿用）**：a) `injectedCount ≥ 1` 是派发交易验证轮的**前置门禁**；b) 零成交（或仅持仓存续）轮的 `total_value` 差额**全属市价**，记 `flat/unattributed`，**严禁**按 ±10 归因；c) 未成交必须把「**报价失真**」与「**判断错误**」分开（反对静默 clip `tradePrice`：那会删掉执行层的核心学习信号）；d) 四判据同验：`injectedCount≥1` ∧ `merge_action_lifted` ∧ `persisted ⊆ 磁盘闭合块` ∧ `dangling 不增`；e) **验证陷阱**：块集合判据必须用 `<function…>…</function>` **闭合对**，裸 grep `<function` 会因 LLM 把正则字面当散文写而假阳性；f) 验收必须记录 **writer pid 与 extension 源 hash**，多进程共享 `_events.jsonl` 时否则会把未重启旧进程的写入误判为本轮回归。

# 历史交接归档（一行摘要，详见备份或已沉淀节点）

| 日期 | 改动 | 状态 |
|---|---|---|
| 09-02 | **三层架构重构**（src/lib/topology.ts 新 + backward.ts/node_policy.ts 改 + test_topology.ts）：边机制从直接改 layer_connections → ledger 经验层+ngram 拓扑派生+物化视图；训练只写 ledger delta、materialize() 幂等重建（每 pair 唯一无重复边）；有效权重 w=(1-α)·prior(sim)+α·delta、α=0.95·(1-0.5^(n/10))、ALPHA_MAX≥0.95；账货一致=内容变→重物化+刷 HTML（源头收口，非扫描补丁）；monitor 支持同层 lateral 边（${l}_to_${l} 分桶防跨层碰撞）——已沉淀 L0 node_29 | ⚠️ 未 commit（git HEAD 在 09-01）；extension 需 /reload；test_topology ALL PASSED；monitor lateral 分桶/虚线已并入 09-03 回退版保留 |
| 09-02 | **轨迹页审计全链路**（trajectory.html +159 + index.ts 后端 + highentropy.ts）：每条轨迹行带状态徽章（⟲已反传/reward/runId · 失败 · 🧩入栈待配对 · Ⓣ任务/⚙非任务(TaskType) · 无HE）；💥失败原因逐 attempt 展示；HighEntropy 训练包/AI 回复原文/前向 L0 失败诊断独立分区；backward 失败也落 kind:"backward" 行（输入原文+逐 attempt 错误+耗时）；index.ts `updateTrajectoryTurnMeta` 回填 he_is_task/he_task_type/in_stack；轨迹真·永久=超 800 条最旧段按月转存 _trajectories_archive/archive_YYYY-MM.jsonl 不删除、semantic_backward.jsonl >4MB 按时间戳改名保留新建空卷；highentropy.ts assistantTextPart 递归抽取（兼容 Responses output_text/content parts）；prompt_injection 区分 "0 context nodes" 与 path retained | ⚠️ 未 commit（git HEAD 在 09-01）；index.ts 回填/归档需 /reload；trajectory.html 读盘即时生效 |
| 09-01 | stock-trade `/api/step` 决策归一化（app.py 输入归一化，**禁止改共享层 local-coms.ts**）；Textron extract 截断修复（字符串感知平衡扫描 + hasBackwardShape 收紧 + 截断显式失败） | ⏳ 7860 待重启 / extension 待重载（/reload 后一并生效） |
| 08-19 | backward 异步化（setTimeout(0)+串行队列，agent_end 不阻塞）✅ 已生效 4/4 ok；auth.json apiKey 兜底 ✅；backward prompt 规则2(reward 量化上游反馈)+规则6b(L1 软性 may) ；pairing judge 显式识别执行结果反馈；commitNodeHtmlEdges 账货一致源头收口 | 规则/收口后续随重启生效 |
| 08-03 | backward 三根因：rescale 参数漂移(4 调用点补参+防御默认) / HighEntropy 硬编码空串→capturedHighEntropy 真透传+RULE8 functionSymbol 原样落盘 / SSE collect 全容器递归+180s+kimi effort=low 分流 | 已随 08-19 重启生效 |
| 08-03 | Function 透传死代码：highentropy.ts Function 块独立剥离(Technique 不再吞代码)+crystal 尾随 ≤1200c；任务栈持久化 800→2400；merge 吞→`merge_action_dropped` 事件；MERGE SCAN 声明同层约束 | ✅ roundtrip 实测通过 |
| 08-02 | Function 协议两字段化：废除 action/target/version/diff，改 `functionSymbol + functionAbstract`；create/modify/去重/版本回归 backward+merge（同符号函数自然合并） | ✅ 现行协议 |
| 07-29 | Function 协议引入（五字段之后可选块）：三问自检(会重复/可参数化/可客观验证) | 已被 08-02 两字段化取代 |
| 07-25 | `reasoning_effort "minimal"→"low"`（API 有效值枚举，400 全拒→json_mode 0%→>80%） | ✅ 已生效 |
| 07-25 | `nodesAdded is not defined`（overflow 分支漏声明）+ merge>1000c→addDynamicNode 五步链路 | ✅ |

---

# 待办（按优先级合并）

| # | 任务 | 状态 |
|---|------|------|
| 0 | **`/reload` 重启 agent（sender/worker/guard）** 验证任务栈生命周期 + 信息获取策略：isTask 无 HE 也入栈、中间轮 append 三级模式（trace `agent_end_process_appended.mode`=he/distill_pending/tail + `agent_end_process_distilled`）、无 HE 轮出现 ⏳[蒸馏中]→蒸馏摘要回填、backward done 即 consumed 出栈、轨迹行 `task_phase`/`process_mode` 全链可见、反馈轮不再被 2000c 截断 | ⏳ src 已改未 reload |
| 1 | **`/reload` extension**，验证 backward 预算修复：`semantic_backward_params_resolved` 事件 + 四重阶梯成功 + reward≠0 | ⏳ 本会话未 reload |
| 2 | 重启 7860 stock-trade 服务使 /api/step 修复生效 | ⏳ |
| 3 | P0 栈溢出（08-19 ns45er/mc8t3r：`Maximum call stack size exceeded`；疑似 HighEntropy/Function 递归、previousTaskForBackward、边更新循环）——近期未见复现，保留排查方向 | ⏳ 未排查 |
| 4 | 转化率审计：轨迹→backward 转化率、pairing skip 原因须主动暴露 | ⏳ 观察项 |
| 5 | 账货不一致存量：假孤立节点由源头 commitNodeHtmlEdges 逐渐收口；**禁 sync 全量扫描补丁** | ⏳ |
| 6 | L1 信息稀疏+离域占槽（node_5 195c 碎片、node_1 离域）；账外残留 node_X.html 超 hyperparams 编号漂移需归并 | ⏳ 观察 |
| 7 | Function 落盘端到端验证（`run_stock_game_n6_flat_step` 可检索）；对含 `<Function>` 的 HE 禁破坏性 ngram distill | ⏳ |
| 8 | sender 输出结构化 `trade_feedback`（统一 -5..5 与 10/-10/-2 语义）+ 等复盘事件再触发 backward | ⏳ |
| 9 | **`/reload` 后验证 tool_result 通道修复**：跑一轮交易 → 断言任务 processLog 含 `[exec]` 条目(带 trade_result 摘要)、pairing judge 任务列表带 recent 上下文且 matchIdx≥0、backward reward≠0；轨迹页可见 💭思考/🔧工具链 section | ⏳ src 已改未 reload |
| 10 | **`/reload` 后验证 content 结构化提取修复**：任意 turn 的 tools 字段含真实工具输出文本(trade_result/portfolio JSON)而非 `[object Object]`；可用 grep 轨迹 tools 字段计数 `[object Object]` 归零断言 | ⏳ src 已改未 reload |
| 11 | **R1 运行期验收**（`00dc022`）：merge 后同层不得出现与宿主逐字相同的副本节点；`_node_history` 可见「clear→(无 overflow)」序列 | ⏳ 待 n9 重启 |
| 12 | **R2 运行期验收**（`7b6862b`）：`semantic_backward_entered.learningPromptSource=="raw_prompt"` 且 `rawPromptChars>0`、`task_prompt_restored.rawPromptRestored≥1` | ⏳ 待 n9 重启 |
| 13 | **`no_pending_match` 丢 HE**（第十七轮 2 次 `agent_end_backward_skipped{no_pending_match}` + 2 次 `highentropy_missing_at_agent_end{raw_operational_trace}`）：pending 无匹配时应入栈/补 self-backward（reward 须标 `unattributed`，禁由 HE 驱动 reward） | ⏳ 未修（最高杠杆） |
| 14 | ~~**轨迹工具侧仍 slice**~~（`rebuildToolsFromMessages` input 180c / output 640c / `maxEntries=24` shift）| ✅ 已修 `db33ba8`，第十六轮验收：129 `tool_call` 恰 180c = **0**、`entries` 达 39、`inputChars` 12,434 |
| 15 | **事件缺 writer pid / extension md5**：多进程共享 `_events.jsonl` 时无法区分未重启旧进程写入（第十轮口径污染） | ⏳ 未修 |
| 16 | **工程语料污染 stock_alpha**：`layer_0/node_0` 正文残留 guard 会话 HE（`571205a(~16:0x)…`）且 merge 拼接无句界保护（半句截断/首尾互吃） | ⏳ 未修 |
| 17 | **`<`/`>` 疑被吞**：node_0 正文 `all(b=gap_lower*0.97` / `broke_prior_low=price=…` 反复重复，待与 `_node_history` 原始 raw 对照判定 | ⏳ 待证 |
| 18 | **配对源根治（R6 剩余面）**：`allPendingTasks` 为何含陈旧/已出栈项（第十七轮仍见 `matchedTaskTs` = `18:33:28Z`/`18:35:42Z`/`18:35:55Z`，窗口基线 `18:48:13Z`）；`matched.rawUserPrompt` 为空时应**改选** activeTask。判据：`matchedTaskTs` 不再早于窗口起点 10min+ | ⏳ 未修 |
| 19 | **悬空 `[fn:σ]` 清理（连续四轮未达标 4→17→27→33）**：`fn_block_evicted` 时同步剥离 content 引用；每轮回扫 `fn_ref_dangling`（仅记事件不自动改写）。**存量悬空不得手工清理** | ⏳ 未修 |
| 20 | **层容量 `maxBlocks=2` 下的淘汰优先级（已重复现象）**：第十七轮 `sender_step_loop_orchestrate` 顶掉 `pi_star_gate_delta_decision`（上轮 `turn_based_step_driver` 顶掉 `classify_reply_failure`）；可评估「优先淘汰离目标域块」，判据须由 LLM 给 | ⏳ 观察 |
| 21 | **函数侧域闸运行期验收（本轮新实施，需 n9 重启）**：窗口出现 `semantic_backward_function_off_goal` ∧ `highentropy_function_skipped{function_off_goal}`；反证：`function_off_goal` 字段出现率 <30% ⇒ 判迁移未生效（判据见第五节 F1'/F2'/反证） | ⏳ 待 n9 |

---


**第十七轮新增（2026-09-16 03:05）**：
- **未生效改动（需 n9 重启三件套）**：`75847ed` **已回滚**（任务侧域闸整轮早退删除）+ **函数侧域闸** `evaluateFunctionDomainGate` / `functionDomainGateRule`（`src/domain_gate.ts` 重写；`index.ts` 消费点：只 gate `persistHighEntropyFunction` + `buildHighEntropyAddCandidate` 两条程序化通道）。事件：新增 `semantic_backward_function_off_goal`，删除 `semantic_backward_off_domain`。
- **回滚判据已结清**：`75847ed` 回滚已执行（字面命中，见第一节表格）；**不再有该闸的回滚悬念**（代码中已无 `off_domain` 残留，测试 T3 可执行校验）。
- **负面教训（本轮方法论）**：
  - **“前提正常”≠“机制工作”**：`a121d67` 后 `rawPromptChars` 5/5 >0，但 `taskPromptPatch` 5/5 = `matched` ⇒ 补丁分支未走；“症状消失”应归因到真正起作用的改动（`7b6862b` 持久化 + 重启恢复），不得拿“症状消失”当补丁运行的证据。
  - **连续三轮恒 0 = 判据维度错，不是实现 bug**：不要在错误维度上继续修实现（本轮直接换维度）。
- **成交机制结论（第十节，`ca9e95a` 仍为准）**：成交价＝限价单真实撮合（买 `min(申报,T+1开盘)` / 卖 `max(申报,T+1开盘)`）；本轮 n6 再次旁证（申报 `54.93` ⇒ 成交 `54.93`，D+1 开盘同价；上轮 `55.35`⇒`55.71` 反例仍在）。`L0::node_1` 固化的错误机制**只登记不改**（硬性约束 2）。
- **P0 候选**：见第六节（已按本轮量化重写，含项 3 函数槽淘汰优先级、项 5 `no_pending_match` 丢 HE）。
- **外部干预回灌（硬性约束 10）**：本轮**无** driver 侧 kill/干预（0 卡死）⇒ 无待回灌项；第十六轮的两次全盘 find 阻塞已入库。
- **第十六轮一行摘要**：实施 `a121d67`（任务侧原文补齐）；验收结果见第一节（症状 ✅ / 分支 ⏳）。

# 硬性约束（不可违反，否则撤销）

1. **禁止改共享通信层 `local-coms.ts`**（全局 agent 通信，波及所有会话）——修点落在 API 边界
2. **禁止手动清理/删除/篡改网络节点**——污染治理走 forward 选择、reward、backward 合并/降权
3. **禁止事后全量扫描补丁**（syncHtmlEdgesFromWeights）——账货一致只走源头 commitNodeHtmlEdges
4. **预算参数禁止在调用点写死**——一律 `buildBudgetParams()`（本次 P0 就是写死参数名）
5. 兜底阶梯 attempt 必须沿实际失败轴正交（假兜底 = 同一死法重复 N 次）
6. 新增规则/护栏前先量化现有覆盖度+实际发生频率；无证据的回退；单变量归因（改一处看一处）
7. Function 协议 version 维护已废除——version 幻觉/双写震荡，全部归 backward+merge
8. **新增/改名 `src/*.ts` 后必须同步到 `~/.pi/agent/extensions/textron/`**（多数为符号链接自动生效，但**新建文件是实体副本**，如 `domain_gate.ts`）——漏同步 ⇒ `index.ts` 的 `import './xxx'` 找不到模块 ⇒ 扩展加载失败、**三件套全部起不来**（第十六轮前实测）。
9. **禁止把 `*.test.ts` / 临时脚本放进 `~/.pi/agent/extensions/`**——pi 会把该目录下每个 `.ts` 当扩展加载并执行 ⇒ 测试脚本的输出会污染 `pi` 启动流程、进程启动即退出（第十六轮前实测：guard 新建的 `local-coms.empty-payload.test.ts` 导致三件套全部起不来）。测试放 `~/textron-agent/tests/` 或仓库根。
10. **禁止 agent 在 home 全盘 `find` / `grep -r` 探索；发给 worker/sender 的指令必须携带可复制的最小 curl 样例**（或指明 `workflows/API.md` 速查及其路径）。
    - **事实**：第十六轮 sender 两次全盘搜索（**4m50s / 3m40s**、CPU 72%/76%）**堵塞整轮**；driver `kill -9` 子进程后 step 70→71→72 恢复。pi 的 bash 工具是**同步等待**，单条命令即阻塞整轮。
    - **成因**：全新会话的 agent 无历史、只给「调 `/api/step`」这类抽象指令会触发探索 —— 即**指令不具体＝把探索成本转嫁给子 agent**。
    - **根治**：指令里直接给可复制的 `curl`（含 `session_id`/body 形状）；API 速查写入 `workflows/API.md` 并给路径。
    - **诊断**：`ps -eo pid,ppid,etime,%cpu,command` 按 `ppid == agent_pid` 过滤，命中「**%cpu 高 ∧ etime 长 ∧ 含 `find .`/`grep -r`**」即判卡；**处置=只杀子进程**（保 agent 上下文），**不杀 agent**。
    - **闭环纪律**：这类干预**不进** `_trajectories.jsonl` / `_events.jsonl` ⇒ guard 的 n8 **看不到**；**不显式回灌文档即下轮必重现**。
---

# 决策经验（已沉淀节点，供快速复习）

1. **reward = 上游反馈本身的量化，HighEntropy = 事后总结**（有先后性）：HighEntropy 只做节点内容素材，不得驱动 reward 判定
2. **方案 ≠ 执行**：落地必须过可执行断言（HTML link 数 == weights 边数）才给正分
3. **"能解析就成功"会把故障伪装成学习**：截断残骸必须显式失败；形状判定要"实质"（有更新/新增/动作）不要"存在"（有 reward 键）
4. 字符串感知括号扫描（inString/escaped）是 JSON 提取的通用正确形态（app.py 与 Textron 两处统一）
5. 该学没学要靠指标告警：backward failed、转化率低、任务栈只 push 不消费，显式记录+告警
6. reasoning 系模型：预算参数名要按 compat 分流、思维链要可界（effort=low / enable_thinking=false），否则 content 恒空

---
