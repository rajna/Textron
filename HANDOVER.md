# Textron HANDOVER（压缩版）

> 用途：跨会话交接。保留「未生效改动 + 硬性约束 + 待办 + 决策经验」，历史细节归档为一行摘要。
> 备份：`HANDOVER.bak.20260903_0904.md`（压缩前原文 505 行）。
> 生效规则：**index.ts / extension 改动一律需 `/reload`（或重启 pi）才生效**；monitor.html 8766 按请求读盘即时生效；7860/8770 服务各自重启。

---

# ✦ 最近更新（2026-09-16 02:45）：n8 **第十六轮** —— `75847ed`（任务侧域闸）/ `b337ed3`（空包修复）首次运行期验收：**E4 ✅（`selected ⊆ context` 7/7，含重启后首轮 18:21:39Z）、轨迹侧保真 ✅（129 `tool_call` 恰 180c = 0）、反传链 ✅（5 entered→5 llm_done、跨层提升 1、真融合 1、拒写 5）**；但 **E1 ✗（窗口 0 次 `semantic_backward_off_domain`）、E2 ✗（工程域符号 `turn_based_step_driver` 写入 `L0::node_0` 并顶掉 `classify_reply_failure`）、E3 ✗（悬空 `[fn:σ]` 17→27）**。根因 **R6 = 反传「任务侧」取材错位**（配对命中 pending 池旧条目，其 `rawUserPrompt` 为空 ⇒ `high_entropy ∧ rawPromptChars=0`）；本轮实施 **任务侧原文补齐 `patchTaskRawPrompt`（`a121d67`）**。

> 触发：guard n8 第十六轮。三件套 02:21 重启 ⇒ 首次运行期加载 `75847ed` + `b337ed3`（`domain_gate.ts` 以实体文件 `cp` 到 `~/.pi/agent/extensions/textron/`；`index/lifecycle_context/highentropy/content_limits` 为符号链接，自动同步）。
> 窗口 = `_events.jsonl` **L97063–L97477**（420 事件 / 7 propagate / 7 pairing / 5 反传 / 5 `task_pushed`）；基线 = 重启后首条 `hook` `18:21:02.841Z`。
> n6 结果：sender 完成 **2/2**（自计 `/api/step` 从 0 起算），`session_id=4cf529337f29`、`active_stock=sz.301299`；① `卖出 300股 @55.35`（成交 55.71，总资产 103,485→103,593）② `持有 0股`（零成交；末值 ¥103,467 / +3.47%）；存档 `step_index` 70→**72**、`current_date=2025-04-25`；worker 两轮迭代 `trade.py` 540→636→664 行（`b215aa9`，ABI/枚举未变）。
> 第十五轮一行摘要：实施 `75847ed`（新增 `src/domain_gate.ts` + `index.ts` 反传写入侧早退；语义边界＝**只禁内容面、不禁学习面**）+ 破例改共享层 `~/.pi/agent/extensions/local-coms.ts`（末条 assistant 无 `text` 块 ⇒ 静默空包；改为「仅非空时覆盖」+ `empty_assistant_text` 显式报错；备份 `.bak-emptyreply-20260915-222627`，回滚即 `cp` 回，**默认保留**）。其余遗留项本轮已逐条复核（见下表）。

## 一、第十五轮两项改动的运行期验收（逐条字面）

| 上轮改动 | 判据 | 本轮实测（字面） | 结论 |
|---|---|---|---|
| `75847ed` 域闸触发（E1） | 窗口出现 `semantic_backward_off_domain`，同轮无 persisted/fallback_add | **0 次** off_domain 事件；同窗口 `highentropy_fallback_add_candidate` **4**、`highentropy_function_persisted` **5** ⇒ 域闸**从未触发**（非「触发后漏写」） | ❌ |
| `75847ed` 域闸有效（E2） | 非交易 `taskType` 回合后不新增工程域 symbol | `多agent交易工作流编排`(18:21:54Z) / `A股交易推进编排`(18:35:55Z) 两回合后 `turn_based_step_driver` 写入 `L0::node_0`（`fn_block_evicted` 顶掉 `classify_reply_failure`）；**磁盘闭合块 9 个中工程/编排域 6 个**（`archive_receipt_insights_once`/`assert_refactor_equivalence`/`audit_decision_enum_semantics`/`minimize_workflow_handoff_fix`/`turn_based_step_driver`/`guard_and_relay_trade_decision`），交易域仅 3（`daily_settle_exposure_gate`/`momentum_veto_pi_gate_decision`/`pi_star_gate_delta_decision`） | ❌ |
| `b337ed3` 空包修复 | 无静默空包；n6 无 10 分钟超时 | 窗口 0 命中 `empty_assistant_text`；n6 全程无超时重发 | ✅ |
| `db33ba8` 轨迹工具侧保真（沿用） | `inputPreview` 不再恰 180c | 129 条 `tool_call` **恰 180c = 0**、max 300c；6 次 `trajectory_tools_fidelity`（`entries` 最大 39、`inputChars` 12,434 / `outputChars` 55,524、`inputTruncated` 合计 2、`outputTruncated` 1、`droppedOldest` 0） | ✅ |
| 悬空 `[fn:σ]`（E3） | ≤ 17 | **27**（`[fn:σ]` 引用 33 个符号 / 磁盘闭合块 9）⇒ 淘汰只记录不清理引用，且工程域块顶掉域内块 | ❌ |
| 重启瞬态（E4） | 重启后首个 `propagate_done` 满足 `selected ⊆ context` | **7/7 成立**（含重启后首轮 18:21:39Z）⇒ 上轮「重启瞬态」解释未被证伪，本轮无违反 | ✅ |

## 二、本轮正向事实（当基线，勿再当缺陷修）

- **轨迹未 slice 稳态**：129 `tool_call` 恰 180c = 0 / max 300c；`trajectory_tools_fidelity` 逐轮可读（`inputTruncated` 0/0/1/0/1/0、`outputTruncated` 0/1/0/0/0/0、`droppedOldest` 全 0）。
- **反传写入链健康**：5/5 `semantic_backward_entered` → 5 `semantic_backward_llm_done`；`merge_action_lifted{L3::node_1→L1::node_1, delta=2}`；**1 次真融合**（`semantic_backward_apply{nodesMerged:1, nodesUpdated:1}`，`L1::node_1` name「301299缩量反抽51.66支点26%持仓」→「…否决分级·证据强度·缺口显著性」）；`node_write_refused_keep_better` **5** 次（`L0::node_0 scoreOld .0482 > scoreNew .0064–.0383`、`L1::node_1 .0345 > .0138`）。
- **任务原文在本会话 state 里齐全**：`_last_state.guard.json` activeTask `rawChars=1607`、`sender` `1366`、`worker` `1062`；`task_prompt_restored` 4 次 ⇒ 佐证 R6 是「取材错位」而非「没存/没恢复」。
- **注入门禁**：7 次 `propagate_done` 均 `contextCount=1`（`L0::node_0`/`node_1`），无 0 注入。
- **估值口径结清（关闭第十节待核对项）**：同一 `(session=4cf529337f29, 2025-04-25)` 下 `/api/prompt` 总资产 **¥103,467.00** ≡ sender 第 2 次报数；上轮记录的 +¥702 差异属**不同交易日/不同取样时刻**（04-23 收盘 vs 成交价），非口径缺陷。

## 三、本轮根因（R6，单变量）：反传「任务侧」取材错位 —— 判据输入侧

- **判据面**：反传任务侧取自 `_backwardPendingMatch`（pairing judge 命中的 pending 池条目），而**不是**「本轮任务」。池内旧条目 `rawUserPrompt` 为空（旧档/未持久化）时，`buildBackwardTaskContext` 因 `isPlaceholderRetryPrompt("")=true ∧ hasHighEntropy` 走 `[HighEntropy Task]` 分支 ⇒ `learningPromptSource=high_entropy ∧ rawPromptChars=0`。
- **字面证据（2/5 反传命中）**：guard 回合 `matchedTaskTs=11:34:37Z`、sender 回合 `matchedTaskTs=08:20:10Z`（**均早于本轮数小时**，其中 11:34:37Z 已不在本会话栈内），二者 `rawPromptChars=0 ∧ placeholderRetryPrompt=true ∧ matchedPromptChars=0`；而**同一会话** `_last_state.*.json` 的 activeTask 原文为 1607c / 1366c ⇒ **不是缺数据，是取错了 `matched`**。
- **后果链**：①**域闸（`75847ed`）的判据输入恰是「本轮任务是什么」**，该输入在这两个回合退化为 HE 摘要（含交易语汇）⇒ LLM 无从判离域 ⇒ 恒判在域内 ⇒ 唯一新增工程域符号 `turn_based_step_driver`（内容＝「服务重启后 session 重建 / 轮次计数以 `/api/step` 次数为准」= workflow orchestration）写入 `L0::node_0`；②融合对象错位（拿本轮知识对 8 小时前的任务自说自话）。
- **与 R5 的关系**：R5 = goal guard 单向 + 全局 pin（「谁在判」错）；R6 = 判据输入错位（「拿什么判」错）。只修 R5 时域闸被 R6 废掉 ⇒ **两半互补，缺一不可**。
- **不变式**（沿用 lifecycle_context 头注释）：**任务原文属上游输入，不可由事后总结替代**。

## 四、本轮实施的改进（git `a121d67`；**需 n9 重启三件套生效**）

**任务侧原文补齐（TASK-SIDE PROMPT PATCH）**：
- `src/lifecycle_context.ts`：新增 `patchTaskRawPrompt({matchedRawPrompt, activeTaskRawPrompt, currentRoundPrompt})` ⇒ 取材回落 **matched → active_task → current_round_prompt → none**；占位符（沿用既有 `isPlaceholderRetryPrompt` 词表：继续/收到/好/OK…）不取材；返回 `patchSource` 供审计。**不改配对身份、不做语义判断**（判官仍属反传 LLM / 域闸）。
- `src/index.ts`：在 `setTimeout` **之前**捕获并调用（异步期 `activeTask` 会被下一轮覆盖），`buildBackwardTaskContext({rawPrompt: _patch.rawPrompt})`；事件 `semantic_backward_entered` 增 `taskPromptPatch`（matched/active_task/current_round_prompt/none）与 `taskPromptPatchedRawChars`。
- **验证**：`jiti test_task_prompt_patch.ts` **17/17**（T1 取材优先级 / T2 占位符不取材 / T3 补齐后 `learningPromptSource=raw_prompt` 且旧行为对照可复现 / T4 消费点在 `setTimeout` 之前 + 事件字段 + 旧写法已消除）；回归 9 套件全过（`off_domain_gate 30/30`、`fn_multiblock_move 16`、`fn_block_survival 9`、`lift_overflow_dup 15`、`lift_merge 42`、`lift_jump 18`、`task_persist_roundtrip 15`、`content_limit_zero`、`tools_fidelity`）；`LOAD_OK src/index.ts`。
- **边界**：只补素材、不替代判据 —— 不违反「LLM 是唯一语义判据」，也不重蹈 `no_domain_evidence`（`7987145`）被删的覆辙（那是**程序侧词表预判**；本改动**不做判断**）。

## 五、下一轮验收断言（逐条可字面核对）

- **E1'（补齐生效）**：`semantic_backward_entered` 出现 `taskPromptPatch ∈ {active_task, current_round_prompt}`，且**这些轮** `learningPromptSource=="raw_prompt" ∧ rawPromptChars>0`（对照本轮：2 轮为 `high_entropy ∧ 0`）；若 `taskPromptPatch=="none"` 仍出现，说明该会话连 activeTask 原文都为空，改查 `task_stack_persisted.rawPromptCount`。
- **E2'（域闸开始动作）**：窗口出现 `semantic_backward_off_domain`，其 `strippedUpdates/strippedAdds` 与同轮 LLM 原输出量级一致；该轮**无** `highentropy_function_persisted` / `highentropy_fallback_add_candidate`。
- **E3'（域内不误杀）**：交易域符号（`pi_star_gate_delta_decision`、`momentum_veto_pi_gate_decision`、`daily_settle_exposure_gate`）仍能正常 persisted（防补齐后把交易轮判成离域）。
- **E4'（悬空不增）**：悬空 `[fn:σ]` **≤ 27**（本轮基数；若同时实施 P0-2 应下降）。
- **E5'（`selected ⊆ context`）**：延续 7/7。
- 不变式（沿用）：`injectedCount ≥ 1` ∧ 拒写时 `scoreOld > scoreNew` ∧ 同层逐字同文计数 = 0 ∧ 零成交轮 `flat/unattributed`。

## 六、下一轮 P0 候选（按杠杆排序，**仍只挑一项**）

1. **配对源根治（R6 剩余面）**：查 `allPendingTasks` 的来源与为何含已出栈的 11:34:37Z 项 —— 让候选集合只含「本会话 + 未消费」任务，或在 `matched.rawUserPrompt` 为空时**改选** activeTask（本轮补齐只治素材，未治「配对身份」）。判据：`semantic_backward_entered.matchedTaskTs` 不再早于窗口起点数小时。
2. **悬空 `[fn:σ]` 清理（E3 连续两轮未达标）**：`fn_block_evicted` 时同步从 content 剥离 `[fn:σ]`（现只记 `dangling`）；加每轮反传后回扫 `fn_ref_dangling`（**仅记事件，不自动改写节点**；连续两轮仍悬空才移除标记）。**硬性约束 2：存量悬空不得手工清理**。
3. **域隔离的「配置/注入侧」**（R5 剩余面）：`pinnedTaskFamily` 全局 pin ⇒ 本轮仍 7 次把交易网络注入 guard/sender 会话（`context_user_message_injected`）；选项：pin 改 per-session / 每轮 `autoRouteNetworkDecision` 复核域一致性并记 `route_domain_mismatch`。
4. **层容量（`maxBlocks=2`）与淘汰顺序**：`L0::node_0` 仅容 2 块，工程域块顶掉刚落的交易域块（`breakdown_shrink_rebound_sizer` 存活 2 分钟即被 `turn_based_step_driver` 挤出）⇒ 可评估「淘汰优先离目标域块」，但**判据仍须由 LLM 给**，不得写词表。
5. **事件写入者归因**（沿用）：`pid` + `md5(src/index.ts)`。

## 七、n6 运行观察（第十六轮，工作流层）

- **超时/空包**：本轮 0 次超时、0 次空包（`b337ed3` 修复后首个完整 n6 轮）⇒「超时」问题暂判关闭，保留复现观察。
- **计数口径**：sender 自计 2/2 与存档 `step_index 70→72` 一致（差值恒 2）⇒ 「自计数 + 存档旁证」的对账式可作后续 n6 默认写法。
- **边界遵守**：worker 全程只与 sender 交互、未直连 guard；sender 唯一一次通知 guard（幂等）⇒ 越权问题未复现。
- **worker 迭代幅度**：`trade.py` 540→636→664 行（两轮各 ≥24%）；**注意**行数不能当等价性证据，无 ABI 断言时不得据此判「ABI 未变」。

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
| 13 | **`no_pending_match` 丢 HE**（本轮 3 次，其中 HE≠空 2 次）：pending 无匹配时应入栈/补 self-backward（reward 须标 `unattributed`，禁由 HE 驱动 reward） | ⏳ 未修（最高杠杆） |
| 14 | ~~**轨迹工具侧仍 slice**~~（`rebuildToolsFromMessages` input 180c / output 640c / `maxEntries=24` shift）| ✅ 已修 `db33ba8`，第十六轮验收：129 `tool_call` 恰 180c = **0**、`entries` 达 39、`inputChars` 12,434 |
| 15 | **事件缺 writer pid / extension md5**：多进程共享 `_events.jsonl` 时无法区分未重启旧进程写入（第十轮口径污染） | ⏳ 未修 |
| 16 | **工程语料污染 stock_alpha**：`layer_0/node_0` 正文残留 guard 会话 HE（`571205a(~16:0x)…`）且 merge 拼接无句界保护（半句截断/首尾互吃） | ⏳ 未修 |
| 17 | **`<`/`>` 疑被吞**：node_0 正文 `all(b=gap_lower*0.97` / `broke_prior_low=price=…` 反复重复，待与 `_node_history` 原始 raw 对照判定 | ⏳ 待证 |
| 18 | **配对源根治（R6 剩余面）**：`allPendingTasks` 为何含已出栈的 `11:34:37Z` 项；`matched.rawUserPrompt` 为空时应**改选** activeTask（本轮 `a121d67` 只治素材、未治配对身份）。判据：`semantic_backward_entered.matchedTaskTs` 不再早于窗口起点数小时 | ⏳ 未修 |
| 19 | **悬空 `[fn:σ]` 清理（E3 连续两轮未达标 4→→27）**：`fn_block_evicted` 时同步剥离 content 引用；每轮回扫 `fn_ref_dangling`（仅记事件不自动改写；连续两轮才移除标记）。**存量悬空不得手工清理** | ⏳ 未修 |
| 20 | **层容量 `maxBlocks=2` 下的淘汰优先级**：实测工程域块 2 分钟即顶掉刚落盘的交易域块（`breakdown_shrink_rebound_sizer` 被 `turn_based_step_driver` 挤出）；可评估「优先淘汰离目标域块」，判据须由 LLM 给 | ⏳ 观察 |

---


**第十六轮新增（2026-09-16 02:45）**：
- **未生效改动（需 n9 重启三件套）**：`a121d67` 任务侧原文补齐 `patchTaskRawPrompt`（`lifecycle_context.ts` + `index.ts` 消费点；R6 判据输入侧修复）。
- **回滚判据（可判定，勿凭态度）**：下一窗口 `semantic_backward_off_domain` **≥1 ⇒ 保留 `75847ed`**；若恒为 **0**（即 `a121d67` 后仍不触发）⇒ 该域闸只是**死代码 + 复杂度**，**回滚 `75847ed`**。
- **已结清**：`b337ed3` 空包修复运行期 ✅（窗口 0 次 `empty_assistant_text`、n6 零超时）；**估值口径待核对项关闭**（同 `(session, 2026-04-25)` 下 `/api/prompt` ¥103,467 ≡ sender 报数）；`workflow_3` n6 超时重发条款**不必补**（本轮未发生）。
- **成交机制结论修正（第十节，`ca9e95a`）**：成交价＝限价单真实撮合（买 `min(申报, T+1开盘)` / 卖 `max(申报, T+1开盘)`），「成交价≡申报价」**作废**；`L0::node_1` 正文已固化的错误机制（「成交价≡申报价、零摩擦、触及即全额」）**只登记不改**（硬性约束 2），靠 reward/backward 自然覆盖。
- **P0 候选（按杠杆，仍只挑一项）**：①**配对源根治**（R6 剩余面：`allPendingTasks` 为何含已出栈的 11:34:37Z 项 / `matched.rawUserPrompt` 空时改选 activeTask —— 本轮只治素材未治配对身份）；②**悬空 `[fn:σ]` 清理**（连续两轮未达标，17→27）；③域隔离**配置/注入侧**（pin per-session 或每轮域一致性复核 + `route_domain_mismatch`）；④层容量 `maxBlocks=2` 下的**淘汰优先级**（可评估「优先淘汰离目标域块」，但判据须由 LLM 给）；⑤`no_pending_match` 丢自产 HE ⇒ self-backward（`reward=null/unattributed`，**不得让 HE 驱动 reward**）；⑥事件统一附 `pid` + `md5(src/index.ts)`。
- **外部干预回灌（硬性约束 10）**：driver 侧 kill 卡死子进程等干预**不入轨迹/事件** ⇒ guard n8 不可见；**任何此类干预必须显式写回本文档**，否则下轮重现（本轮已入库）。
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
