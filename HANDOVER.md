# Textron HANDOVER（压缩版）

> 用途：跨会话交接。保留「未生效改动 + 硬性约束 + 待办 + 决策经验」，历史细节归档为一行摘要。
> 备份：`HANDOVER.bak.20260903_0904.md`（压缩前原文 505 行）。
> 生效规则：**index.ts / extension 改动一律需 `/reload`（或重启 pi）才生效**；monitor.html 8766 按请求读盘即时生效；7860/8770 服务各自重启。

---

# ✦ default 侧改进 2（2026-09-18 04:50）：子 agent 操作纪律**自动注入**（治「全盘搜索阻塞整轮」）

> 触发：第二十一轮 sender 启动后立即 `cd /Users/rama && grep -rl "api/health" --include=*.py … .`
> ⇒ 同步阻塞 **4m19s / CPU 60%**；同类事故第十六轮已发生（sender 两次全盘搜索 4m50s/3m40s）——**属硬性约束 10 复发**。

## 干预记录（按约束 10 必须显式回灌，否则不进 `_trajectories`/`_events` ⇒ guard 的 n8 看不到）
- 04:33:36 sender(pid 11863) 子进程 `11962(bash)/11964(grep)` 全盘 grep → `kill -9` **只杀子进程**（保 agent 上下文）。
- 04:35:0x sender 随即又起同类 grep(12318) → `pkill -9 -P 11863` 清空其子进程。
- 04:35:34 恢复：sender 转向 `curl /api/health` → `/api/enter` → `/api/prompt` → `/api/step`，两次推进 78→79→80 正常完成（04:39:25）。
- 结论：**kill 子进程只是止损，不是根治**；根治必须让子 agent 启动时就知道「不该搜、去哪查」。

## 根治实施
- 新增 **`workflows/AGENT_DISCIPLINE.md`**：硬性禁令（宽目录禁 `find .`/`grep -r … .`/`ls -R`）、命令必须有界（`timeout`/`-m`/`head`）、可复制的 curl 速查、`trade.py` 只改函数体、**打分必须真调 `/api/trade_quality`（禁编分数）**、收件人边界、monitor 端口表。
- **`pi-coms-spawn`** 默认对每个 cname 追加 `--append-system-prompt <该文件>`（`PI_COMS_NO_DISCIPLINE=1` 关闭；dry-run 行打印 `discipline=on`）。
  - **关键区分**：`--purpose` 只是注册表**展示字段**，不进 prompt ⇒ 之前把要求写进 purpose 等于没写。
- 生效范围：下一轮 n9 重启三件套即自动带上（本轮三件套用旧启动方式，故本轮卡死仍发生）。

## 本轮交易侧摘要（guard 第二十一轮 n6/n8）
- 2 次推进 `step 78→79→80`（2025-05-09 → 2025-05-12），总资产 **104,571 → 104,166 → 104,415**（已清仓，+4.415%）。本轮 sender **真实调用了 `/api/trade_quality`**（04:30:36 / 04:39:10 / 04:39:37 均 200）——对比第二十轮完全未调、靠手工拼 portfolio。
- guard n8 根因 **R10（>95%）**：`semantic_backward_goal_cleanse.cleanseTargets` 结构性恒空（移除 forceOverwrite 后未同步事件语义）+ LLM `mode` 在 normalize 被丢弃 ⇒ 无法分辨 replace 真清洗与 merge 追加，而 `covered` 只看键存在 ⇒ 兜底不触发、离域内容以「已覆盖」假象永久追加。实施 **`e9076f0`**（mode 透传 + 真实 `candidates/candidateModes/fallbackApplied` + violation 告警，**不新增拦截**）；文档 `01863b7`/`26f8de3`。
- 未解决：决策轮 HE 仍被 `no_pending_match` ×2 丢弃（第五轮复现）；`nodesMerged 0-1`/`edgesUpdated=0` 融合质量偏低；空仓时 `/api/trade_quality` position 维度结构性 0 分（禁记台账，待办 #22/#23）。

---

# ✦ default 侧改进（2026-09-18 04:25）：monitor **端口漂移/掉线**治理 —— 端口注册表 + 固定分配 + 读侧工具

> 触发：用户报「textron live web 总是掉线或换端口」。归因链全部落代码取证，非猜测。

## 病灶（三层，均可复现）
1. **server 是每进程一份**：`src/index.ts` `PORT=8766`、`tryListen(PORT,0)`、`MAX_PORT_ATTEMPTS=100`（EADDRINUSE 即 `port+1` 静默递增）；`pi.on("session_shutdown")` 里 `server.close()` + SSE `res.end()` ⇒ **关 TUI 那一刻端口即失效**（pi 对 SIGHUP 不硬退，走 `shutdown({fromSignal:true})` → emit `session_shutdown`，见 `interactive-mode.js:3306-3318`）——**掉线 ≠ 进程死**，进程常常还在。
2. **端口与启动顺序强绑定**：多 TUI 并存时仅首个拿 8766，其余锁死 8767+，关掉 8766 那个后**其余进程不迁移** ⇒ 活着的面板反而没有入口。实测分配热力：**8766×606 / 8767×303 / 8768×104 / 8769×60 / 8770×46 … 至 8799**（1025 次分配）；**241/368** 个会话出现过多端口，极端一个会话出现 **15 个端口**（8766→8780，因同一会话被反复 resume 而旧进程未退）。
3. **无端口发现机制**：只有 `appendEntry` 日志（无文件可查）⇒ 浏览器无法判断哪个端口还活着，只能猜 ⇒ 体验即「掉线/换端口」。

## 两个新发现的硬事实（实测，可复算）
- **非 TTY 下 SIGTERM 不会触发 `process.on("exit")`**：无信号 handler 时内核默认终止，exit 回调不跑 ⇒ 注册表条目残留（实测：加 exit hook 后 SIGTERM 仍残留）。**必须显式监听 `SIGTERM/SIGHUP/SIGINT`** 才可靠（`SIGKILL` 不可捕获，只能靠下述 prune 兜底）。
- **prune 时机决定收敛**：条目残留由**下一个注册者**在写表时按 `process.kill(pid,0)` 清理（实测通过：`kill -9` 后新实例注册即抹掉死条目）。

## 实施（三处，需 `/reload` 或重启 pi 生效）
- **`src/index.ts`**：①`~/.textron/_monitor_ports.json` 注册表（`pid/port/cname/cwd/tty/startedAt/updatedAt`）+ `_monitor_latest.txt` 指向最近活跃入口；②`monitorCname()` **优先从 `process.argv` 解析 `--cname`**（与扩展加载顺序无关，实测 `pi --cname porttest` → `cname: "porttest"`；`pi.getFlag` 在 textron 早于 local-coms 加载时取不到）；③30s 心跳刷新 `updatedAt`（`unref` 不阻退出）；④摘除路径三保险 = `session_shutdown` + `process.on("exit")` + `SIGTERM/SIGHUP/SIGINT`；⑤注册时顺带 prune 死 pid。
- **`~/.pi/agent/bin/pi-coms-spawn`**（备份 `.bak-portfix-20260918-042123`）：按 cname **固定端口** `guard 8801 / sender 8802 / worker 8803 / stock-coder 8804 / 其他 8800`，显式 `TEXTRON_MONITOR_PORT` 优先；dry-run 行打印 `monitor_port=`（实测三件套 `--cname` 与端口一一对应）。
- **新增 `~/.pi/agent/bin/textron-monitor-ports`**（读侧工具）：以「pid 存活 ∧ 端口真在 LISTEN（lsof）」双重校验列活端口、自动清理死条目、打印推荐入口；`--json` / `--clean-only` / `--stale N`。

## 验证
- esbuild 转译 OK（0 处 `MONITOR_CNAME` 残留）；端到端 4 组：**注册**（registry 出现 `{11185:('porttest',8899)}`、latest 指向之）→ **SIGTERM 摘除**（registry `{}`、latest 清空、端口释放）→ **kill -9 残留** → **新实例注册 prune 收敛**（只剩 `{11138:prunetest@8899, 11185:prunetest2@8897}`）。
- 副作用：`pi --help` 这类一次性启动**也会**监听 monitor（实测 `--help` 即在 8767 留过条目）⇒ 固定端口后这些短命实例会与同 cname 的长驻实例抢同号；因单进程内 `tryListen` 只跑一次、且 EADDRINUSE 仍会 +1，行为安全但排障时需知悉。

## /reload 场景专属（实施后补测，两个 reload 特有陷阱）
- **监听器泄漏**：`/reload` 在同一进程内重载扩展 ⇒ 若每次加载都 `process.on(...)`，监听器累积（Node >11 即 `MaxListenersExceededWarning`），且旧实例闭包长期持有 `MONITOR_PID` 状态。修法：`globalThis.__textronMonitorHooks` 槽位保证进程级**只挂一组**（`exit` + `SIGTERM/SIGHUP/SIGINT` 共 4 个），新实例加载时**接管**槽位里的 `unregister` 引用（旧闭包被丢弃）。
- **reload 端口漂移**：`server.close()` 会等现有连接结束，SSE 长连接不断则**端口不释放** ⇒ 重载后同端口 `listen` 失败 ⇒ EADDRINUSE 静默 +1（这是 reload 场景的漂移源，与“关 TUI掉线”是两回事）。修法：`session_shutdown` 内**先** `res.end()` 清空 SSE **再** `server.close()`，并补 `closeAllConnections()/closeIdleConnections()` 强兜底。
- 测试：`src/test_monitor_hooks.ts` **11/11**（T1 三次安装只增 1 组监听器 / T2 新实例接管 / T3c `process.on("exit")` 仅 1 处 / T4a `res.end` 先于 `close`）。**工程教训**：源码守卫断言前必须**剥注释** —— 注释里同样含 `process.on("exit")`/`server.close()` 字样，直接 `indexOf` 会误报（首版实测 2 处 FAIL 全为注释干扰）。
- 生效后的端口预期：经 `pi-coms-spawn` 起的 agent = `guard 8801 / sender 8802 / worker 8803 / stock-coder 8804`；**手工起的 TUI（如 default 主会话）不带该环境变量 ⇒ 仍监听 8766**（单进程只 `tryListen` 一次，reload 会先释放再重占）。

---

# ✦ 最近更新（2026-09-18 04:50）：n8 **第二十一轮** —— **R10 = 离域清洗判据死指标**（`cleanseTargets` 恒空 + LLM `mode` 被丢弃）⇒ 实施 `e9076f0`（事件记真实候选/mode/兜底 + 新增违规告警 + 离线审计脚本）

> 触发：guard n8 第二十一轮（用户经 default→guard 下发「完成 2 次交易推进」）。窗口 = `_events.jsonl` UTC `20:30–20:45`（549 事件 / 9 `propagate_done` / 3 stock_alpha 反传 entered / 8 `trajectory_tools_fidelity` / 5 `agent_end_backward_skipped` / 2 `fn_ref_dangling`）。

## 一、本轮验收（n6 产物生效性 / 轨迹保真 / 是否需回滚）
- **trade.py（n6 两轮迭代，已 commit `01fb2e2`）：自检 12/12 全通过**，含两处新回归样本 —— 第14步「轻仓+冲高衰竭 ⇒ 卖出（`exhaust=True p=0.5 edge=-0.2 pi_cur=0.052`）」、第15步「05-09 衰竭清仓 300 股（`p=0.34 b=1.667 edge=-0.093`）」。**判别力自带差分**：300 股时修补前后同为卖出（无差分、修复不可证），只有轻仓样本才翻转 ⇒ 回归夹具必须选在判据边界（上一轮已固化）。第15步的两处缺陷（确认窗口只看 `daily[-2]` / 靶位取已被放量长上影否定的 `res_prev=59.84`）**必须同修才能翻转决策**（仅①⇒p 降但 b 仍 3.07、edge 仍正；仅②⇒exhaust 未触发）⇒ 属「两处独立缺陷互相掩盖」型。
- **生效取证**：备份 `.bak-exhaust-20260918-043643` / `.bak-step15-20260918-044025` 落盘 = 两次迭代真发生。**「是否更差」暂不可判**（清仓后无持仓、无后续实盘样本）；**回滚判据（登记）**：若出现 `exhaust=True` 清仓后 3 日内最高价 > 清仓价 + `1.5·ATR`，则回滚 `target_cap_atr`（⟨fn:rollback_gate_by_net_effect⟩）。
- **轨迹采集（无静默 slice）**：8 次 `trajectory_tools_fidelity`，`entries` 0–55、`inputChars` 最大 35,472、`outputChars` 最大 124,913、`droppedOldest` 全 0；`inputTruncated` 2 / `outputTruncated` 2 = `clipWithMark` 尾标式界内截断（cap 4000/8000），**非常数 slice 回潮**（对照第十四轮 180c/640c/24 条）。
- **反传触发/沉淀**：交易轮 3 次 entered（20:38:17 `reward=-0.7` /quality 0.3 low/ `nodesUpdated=1` `L1::node_1` + `highentropy_function_persisted pressure_weak_signal_gate` 1017c；20:40:48 第二轮素材 `raw_prompt 5543c`；20:42:39 guard 本轮自反传）。**但决策轮 HE 仍丢**：`agent_end_backward_skipped{no_pending_match}` ×2（20:35:33 / 20:39:24，`hasHighEntropy=true`）⇒ 待办 #13 第五轮复现（复盘轮部分补偿）。
- **抽象融合质量（欠佳，客观）**：stock_alpha 三次 `apply` 的 `nodesMerged=0–1`、`edgesUpdated=0`、`nodesAdded=0`；`L2/L3` 无更新 ⇒ 抽象层本轮未提升。
- **噪音/悬空**：`fn_ref_dangling` = **79 pairs / 103 refs / symbolsAlive 6 / fnBlocksOnDisk 7** ≙ 第十九轮基线（未恶化未改善）；`L0::node_0/node_1` 残留工程域引用（`emit_workflow_note`×4、`classify_reply_failure`、`turn_based_step_driver`、`check_write_gate_invariants`、`archive_receipt_insights_once`、`rollback_gate_by_net_effect`），`L1::node_1` 含 `sender_step_loop_orchestrate` / `sender_advance_with_gate_regression` ⇒ 待办 #16 原地。

## 二、R10 根因（>95% 置信度，字面取证）
1. **死指标**：`semantic_backward_goal_cleanse` 的 `cleanseTargets` **结构性恒为空** —— `src/index.ts` 中 `const cleanseTargets = new Set<string>()`（2026-09-15 有意移除 forceOverwrite「抹掉好知识的直接通道」后**未同步事件语义**）⇒ `cleansedNodes` 恒空，该字段对「离域是否被清洗」零判别力，且容易被误读为「清洗已执行」（硬性约束 11/12 的反面样本：指标存在但采集源注定为空）。
2. **mode 被丢弃 ⇒ 程序侧无法分辨真清洗**：LLM 的 `mode`（replace=整段覆盖 / merge=keep⏎delta）在 `normalize` 消费后不再透传；而 prompt 规则 0(a) 明写「离域候选清洗必须 OVERWRITE」。实测候选被 **merge** 更新 ⇒ 离域内容**继续追加留存**；同时 (a2) 的「非空候选必须至少覆盖一个」被 `covered = 键是否存在` 满足（**不看 mode**）⇒ 确定性兜底清洗不触发（`fallbackApplied=''`）⇒ 离域治理在「已覆盖」的假象下空转。
3. **离线重放（本轮真实样本）**：`tests/goal_cleanse_mode_audit.py` → 候选 4（`L1::node_1 goalSim=0.0164` / `L3::node_0 0.0186` / `L1::node_0` / `L0::node_1`），mode = `merge/merge/(no_update)/(no_update)` ⇒ **违规 2 例**，判据有判别力。副证：**全部候选 goalSim ≤0.019**（网络内容与 goal 词面近乎无交集）⇒ goalSim 排序会把真交易节点一并标为离域 ⇒ 「LLM 是唯一语义判据、程序侧禁止据 goalSim 强制覆写」的历史结论**继续成立**，本轮不动写入策略。

## 三、实施 `e9076f0`（需 `/reload`；纯观测 + 告警，无拦截）
- `mode` 透传（两处 `out.node_updates[k]`，不影响 content 合成）；`semantic_backward_goal_cleanse` 新增 `candidates` / `candidateModes` / `cleanseViolationCount` / `fallbackApplied`（真实值，取代恒空字段作判据）；新增事件 **`semantic_backward_goal_cleanse_violation{off_goal_candidate_updated_without_replace}`**。
- **不放宽也不新增拦截**：不重开 forceOverwrite、不改 `covered` 判据（改它会重新打开「程序强制覆写」这条被否决的通道）—— 违规只告警（硬性约束 2/7/10）。
- 语法自检 `node --experimental-strip-types --check src/index.ts` = 0；离线审计 exit 0（无样本时记 `no_offgoal_sample` 不判失败 = 硬性约束 12 的假阴性防护）。测试脚本放 `tests/`（硬性约束 9）。

## 四、下一轮判据（F-A/F-B/F-C）
- **F-A（生效）**：窗口出现 `semantic_backward_goal_cleanse` 且 `candidates` 非空 ∧ `candidateModes` 键集 == `candidates`；`cleanseViolationCount` == 离线脚本重算值（±0）。
- **F-B（假阴性防护）**：候选全 `mode=replace` 时 violation 必须 0；无候选 ⇒ 记 `no_offgoal_sample` 跳过而非失败。
- **F-C（对应待办 #13）**：`agent_end_backward_skipped{no_pending_match}` 仍 >0 ⇒ 交易决策 HE 仍丢，须走「pending 无匹配 ⇒ 入栈 + self-backward（reward 标 `unattributed`，禁由 HE 驱动 reward）」。

## 五、P0 排序变化
1. **#13 `no_pending_match` 丢 HE**（第五轮复现，交易轮学习直接损失）→ 最高杠杆。
2. **#16 跨域污染**（L0/L1 工程块残留）—— 本轮新增因果：被污染节点**必然**被判为离域候选，而判离域后又只能 merge ⇒ 与 R10 形成闭环（污染自我加固）。
3. **#20 函数槽淘汰优先级**：`L1::node_1` 现有 4 个 fn 引用（2 交易 + 2 编排）⇒ 容量 2 下交易函数仍有被编排函数顶掉的现实风险。

---

# ✦ 前一轮（2026-09-17 19:55 UTC / 本地 09-18 03:55）：n8 **第十九轮** —— 运行期验收 `14f5961`（证据制保留判据 + 悬空口径代码化）。**R9 = 口径函数的采集源缺陷**：`scanDanglingFnRefs` 只从 `readNodeContent`（`<content>…</content>`）收集存活符号，而 `<function symbol=…>` 块**写在 `</content>` 之外**（`writeNodeHtml` 在 `</content>` 后拼 `fnHtml`、`writeNodeFunction` 文件末尾 append）⇒ **`symbolsAlive` 恒 0**（stock_alpha / normal 两网旧口径一律 0）⇒ 全部引用被判悬空 ⇒ F4''「4-6 ≤ 35」是**假达标**，该指标对函数块存活毫无判别力。**实施 `741788a`**（可选 `fnSymbols` 采集源 + `fnBlocksOnDisk` 字段 + 调用点接 `readNodeFunctions`；不传时行为 ≡ 旧实现）；测试 **18/18**。

> 触发：guard n8 第十九轮。窗口 = `_events.jsonl` UTC `18:45:30–19:42:45`（830 事件 / 18 `propagate_done` / 8 `semantic_backward_entered` / 8 `semantic_backward_apply` / 4 `highentropy_function_persisted` / 15 `trajectory_tools_fidelity` / 8 `node_write_downgraded_to_merge` / 1 `node_write_refused_keep_better` / 1 `semantic_backward_function_off_goal`）。三件套**本轮已加载 `14f5961`**（`node_write_downgraded_to_merge` 8 次 + `fn_ref_dangling` 8 次首现即为证）。

## 一、本轮验收（逐条字面核对）
- **F1'' ✅**：`node_write_refused_keep_better` **1**（≤1 达标；该次 `offDomain:true` 合理）∧ `node_write_downgraded_to_merge` **8**（≥1）⇒ 证据制放行在域增量，非"拒写变静默跳过"。旁证：`L0::node_0` oldChars **7848→8582→8962→9611→9936** 单调增长、`L0::node_1` **3436→3761→6786**，写入真发生。
- **F2'' ✅**：`stock_alpha/layer_0/node_1.html` 正文 **86,633 字符**（第十八轮登记 ≈0 空壳）、`node_0` 83,531 ⇒ 不再自锁；normal 网 `L0::node_1` 6,786。**但两极分化转为"普遍膨胀"**：两网 L0 均 80KB+。
- **F3'' ⚠️ 部分达标**：`stock_alpha L0::node_0` 槽 = `sender_advance_with_gate_regression`（工程）+ **`pi_star_gate_trade`（交易域）⇒ ≥1 达标**；`L0::node_1` 槽 = `rollback_gate_by_net_effect` + `verify_prompt_hint_change`（**全工程域**）；全网 6 存活符号中工程/编排 5、交易 1 ⇒ P0-3 仍在。
- **F4'' ⚠️ 假达标（本轮根因）**：事件 `danglingPairs` **4-6**（≤35 表面达标），但 `symbolsAlive` **8/8 = 0** ⇒ 口径源缺陷（R9）。**修后离线真实基线（同口径）**：`stock_alpha` **79 / 103 / refsTotal 118 / symbolsAlive 6 / fnBlocksOnDisk 7**；`normal` **4 / 5 / 8 / 4 / 4**。⇒ 历史台账「4→17→27→33→35」与代码口径不可比，**以本次两网数值为新基线**。
- **F5'' ✗**：`semantic_backward_llm_raw_response` 仍是 `rawContent.slice(0, 2000)`（`src/index.ts` L2305/L2336），无 `rawContentTruncated`/`storedLen`（本轮 rawContentChars 754–3504）⇒ 离线复核面自伤未修。
- **F6'' ✅（首次拿到真实样本）**：1 次 `semantic_backward_function_off_goal{reason:"purge_cross_role_guard_steps是workflow编排/文本清洗管道，非日常经验域知识", llmReward:-0.5}` + 1 次 `highentropy_function_skipped{function_off_goal}` ⇒ 函数侧域闸**判据维度正确、拦截生效**（对照第十七轮任务侧闸 0/12）。
- 不变式：`injectedCount ≥ 1` 18/18 ✅（`topScores` 非全零）；同层逐字同文 0 ✅；**交易轮 HE 未触发反传**（见二.2）。

## 二、本轮数据（n8 第 1–7 项）
1. **轨迹采集（✅ 无 slice 稳态）**：15 次 `trajectory_tools_fidelity`，`entries` 0–31、`inputChars` 最大 48,112、`outputChars` 最大 42,853、`droppedOldest` 全 0、`thinkingTruncated` 全 false；`inputTruncated` 2 / `outputTruncated` 1（长输出触 8000c/条目上限，属预期非常数 slice）⇒ 第十四轮的 180c/640c/24 条截断未回潮。
2. **反传触发（工程轮 ✅ / 交易轮 ✗）**：8 次 entered → 8 `llm_done` → 8 `apply`（reward 0.5/-0.6/-0.5/0.1/0/0.35…）；但**交易决策/复盘轮的 HE 全被丢**：`agent_end_backward_skipped{no_pending_match}` **7 次**、`semantic_backward_skipped_not_feedback{pairing_judge_no_match}` **8 次**、`highentropy_missing_at_agent_end{raw_operational_trace}` 1 次。新机制证据：`task_stack_restore_empty{stackLen:0}` → `pending_list_built{count:0,hasActive:false}` → `pending_list_empty_skip`（19:40:21）⇒ coms 续接轮在任务栈已清空时**无 pending 可配** ⇒ 该轮 HE（301299 决策/复盘）无处归因。**后果（核心失败）**：`stock_alpha/layer_*` mtime 全部停在 **09-16 23:54 / 09-17 01:06** ⇒ 本轮交易知识**零写入 stock_alpha**；反倒 4 个交易函数（`decide_ashare_boxbreak_vol`/`attrib_hold_decision_dd`/`decide_upper_shadow_fade`/`evaluate_trade_quality_module`）落进了 **normal 网**。P0-2 第四轮原样复现。
3. **HE→Function 沉淀 ✅（但网错）**：`highentropy_captured` 14 次（359–1860c）→ `highentropy_function_persisted` **4 次**（codeChars 1186–1200，`contentAppended` 3 true / 1 false）。
4. **抽象融合 ✅**：8 次 `semantic_backward_apply`（nodesUpdated 1–2 / nodesMerged 0–1 / nodesAdded 0–1）；跨层向上提升 merge 实测 `L1::node_0 → L0::node_1`（`nodeMutations{type:"merge"}`）；name 层也在抽象（`L1::node_0` 名称新增"动作来源双交叉·兜底非人工决策须区分·趋势状态合法非未来数据"）。
5. **内容面写入（R8 修后）**：1 次拒写（离域，合理）+ 8 次降级 merge；**新风险**：降级判据的放行证据 **8/8 都是 `coherence`**（`scoreNew` 恒 0、`goalHits` 恒 0）⇒ 在 goal="日常经验" 这类宽泛目标下，`lexicalRelevance` 对任何非日常语料恒 0，实际**只剩"新旧词面重叠"一条证据**在定生死（域外知识若沿用旧文词面即可通过）。
6. **`semantic_backward_goal_cleanse_fallback` 8 次**（`llm_returned_empty_node_updates`，victim `L0::node_0`/`L1::node_0`）⇒ P0-4 原样复现（MUST-CLEANSE 与反传输出预算互斥）。
7. **新异常：L0 打分首试失败 7/18（39%）**：`l0_score_attempt_failed{error:"No parseable node scores: {\"answer\":\"L0::node_0=0.10\\nL0::node_1=0.05…"}` ⇒ LLM 输出**行式 `K=V`**，解析器只认 JSON 对象 ⇒ 回退 `json_mode/budget4096`（成功但 topScores 更稀疏）⇒ P0 候选⑥。

## 三、本轮根因 R9（单变量）：口径函数的**采集源**与真实存储位置不一致
- **判据面**：`lib/similarity.ts::scanDanglingFnRefs` 的 `alive` 只扫 `node.content`；`node_io.ts` 的 `writeNodeHtml`（`…<content>${storedContent}</content>${fnHtml}`）与 `writeNodeFunction`（文件末尾 append）都**把块写在 content 之外**，而 `readNodeContent` 只截 `<content>…</content>` ⇒ `alive` 恒空集。
- **字面证据三角**：①`fn_ref_dangling.symbolsAlive` **8/8 = 0**，同窗口 4 次 `highentropy_function_persisted` 成功；②磁盘 `stock_alpha` 实测 **7 个闭合块 / 6 去重符号**，`L0::node_0/node_1` 正文含 **56/58 条 `[fn:σ]` 引用**，事件只报 4-6；③源码模板与正则如上。
- **后果**：①F4''「悬空下降」是测量假象（口径换代码 ⇒ 数值 35→4 是**测量面缩小**）；②指标对"函数块被淘汰后引用悬空"零判别力（恒判悬空）；③P0-1 剥离策略失去依据。
- **不变式（新增，硬性约束 12）**：**口径代码化 ≠ 口径正确** —— 采集函数上线必须对**至少一个真实网络**做离线基线核对，断言「存活集合非空、数值与独立抽样一致」；`symbolsAlive=0` 这类**结构性零值**直接判口径源缺陷。

## 四、本轮实施的改进（git **`741788a`**；需 `/reload` 或重启三件套生效）
- **① 采集源补全**（`lib/similarity.ts`）：入参扩为 `{ id, content, fnSymbols? }[]`，`alive` = content 内联块 ∪ `fnSymbols`；新增 `fnBlocksOnDisk`。**不传 `fnSymbols` 时行为 ≡ 旧实现**（单侧风险）。
- **② 调用点接入**（`src/index.ts` 反传后回扫）：`fnSymbols: readNodeFunctions(fp).map(b => b.symbol)`；事件增 `fnBlocksOnDisk`。
- **③ 验证**：`src/test_fn_ref_scan_source.ts` **18/18**（T1 缺陷复现 / T2 修法生效 / T3 混合来源 / T4 端到端复刻真实磁盘形状「块在 `</content>` 之后 ∧ readNodeContent 不含 ∧ readNodeFunctions 能读到」/ T5 源码守卫+向后兼容）；回归 `retention_increment 31/31`、`function_domain_gate 34/34`、`fn_multiblock_move 16`、`fn_block_survival 9`、`LOAD_OK`（bundle 864,775B）。
- **④ 离线真实基线**（只读）：见 F4''。
- **运行器补记**：`--define:import.meta.url='<双引号包住的绝对 file:// 路径>'` 必须给内层引号（否则 esbuild `Invalid define value`）；**产物要输出到仓库内**（`--outfile=/tmp/…` 会让测试里 `src/…` 相对路径解析到 `/private/tmp` ⇒ 假失败，非回归）。

## 五、下一轮验收断言（G 组；F 组已被本轮口径替换）
- **G1**：`fn_ref_dangling.symbolsAlive` **> 0** ∧ `fnBlocksOnDisk ≥ 1`；`stock_alpha` 的 `danglingPairs` 与离线基线 **79** 同量级（±10）。
- **G2**：`node_write_refused_keep_better` ≤1 ∧ `node_write_downgraded_to_merge ≥1`（沿用 F1''）。
- **G3**：`stock_alpha` 目录 mtime **晚于**窗口起点 ∧ 窗口 `agent_end_backward_skipped{no_pending_match}` **= 0**（P0-2，第四轮未达标）。
- **G4**：`L0::node_1` 两槽中 ≥1 为交易域 ∧ `stock_alpha` 存活符号交易域占比 ≥ 1/2（P0-3）。
- **G5**：`semantic_backward_llm_raw_response` 带 `rawContentTruncated`（或 `storedLen == rawContentChars`）（F5''）。
- **G6**：`l0_score_attempt_failed` **≤2/18**（当前 7/18；需实施 P0⑥ 行式 `K=V` 兜底解析）。
- 不变式（沿用）：`injectedCount ≥ 1` ∧ 拒写时 `scoreOld > scoreNew` ∧ 同层逐字同文 = 0 ∧ 零成交轮 `flat/unattributed` ∧ **口径指标必须能打印非零存活集合**。

## ✦ 第十八轮存档（2026-09-16 23:35）：n8 第十八轮 —— 首次运行期验收 `fa15bc2`（函数侧域闸）⇒ F1'=`no_offgoal_sample`（前置样本不成立）/ F3'✗（node_0 两槽全工程域）/ F4'✗（悬空 33→35）；根因 **R8=保留判据度量错位（`lexicalRelevance` 对旧文单调累加 15×）+ 空壳自锁（`node_1` 正文被函数块吞没后永不长回）**；实施 `14f5961`（证据制判据 + `fn_ref_dangling` 口径代码化）。细节见 git `14f5961`、`42ff7ae` 与下方 3 段 `>` 存档。

> 触发：guard n8 第十八轮。三件套 **23:17 重启** ⇒ **首次运行期加载 `fa15bc2`**（第十七轮函数侧域闸）。
> 窗口 = `_events.jsonl` UTC `15:15:29–15:25:30`（293 事件 / 7 `propagate_done` / 4 `semantic_backward_entered` / 3 反传 LLM 成功 / 2 `highentropy_function_persisted` / 4 `trajectory_tools_fidelity`）；`project=default`、`deepseek-flash`、`default_session_id=4cf529337f29`、`active_stock=sz.301299`、`step_index=74`（存档口径，与本轮 2 次推进互不相干）。
> **以下第二~七节仍为第十七轮存档内容**（保留其断言编号 F1'–F5' 的字面形，便于对照历史）。

## 一、本轮验收（逐条字面核对）
- **F1' = `no_offgoal_sample`（跳过）**：窗口 2 次 `highentropy_function_persisted` 的 `symbol` **均为 `pi_star_gate_trade`**（交易域），**无** engineering/orchestration/relay-idempotency/API-session/bookkeeping/UI/config/audit 样本 ⇒ 前置断言不成立，记 `no_offgoal_sample`，**不计失败**；`semantic_backward_function_off_goal` 0 次、`highentropy_function_skipped{function_off_goal}` 0 次（与无样本自洽）。**反证判据同步跳过**（`function_off_goal` 字段出现率 1/4=25%，但前提不成立不得据此判「未生效」—— 照搬会得出错误结论，这正是第十七轮加前置断言的价值）。
- **F2'（不吞学习）✅（写入面在动）**：`semantic_backward_apply` 两次 `nodesMerged=1/3`、`nodesUpdated=3/1`、`nodesSkipped=0,2`；`highentropy_function_persisted` 2 次 ⇒ **但内容面被 R8 吞掉**（见下）。
- **F3' ✗**：磁盘闭合 `<function>` 块 **6 符号 / 9 槽**；工程域符号 **3**（`sender_step_loop_orchestrate`、`sender_advance_with_gate_regression`、`build_symbol_substitution`）⇒ 第一条 ≤3 **恰好达标**；但 **`L0::node_0` 的 2 个函数槽仍全为工程域**（两个 `sender_*`），**0 槽交易域** ⇒ 第二条件 **✗**（第十七轮登记的「工程域块顶掉交易决策块」再次命中；被顶掉的 `pi_star_gate_delta_decision` 现为**悬空引用**）。
- **F4' ✗（P0 连续五轮单调恶化）**：悬空 **35** 符号×节点对（27→33→**35**）、`danglingRefs=47`、去重符号 35、引用 57 次 / 44 对；口径 = content 中 `[fn:σ]`/`⟨fn:σ⟩` 而磁盘无对应 `<function symbol="σ">` 块。**本轮把口径代码化** ⇒ 下轮起不再人工 grep（4→17→27→33 之所以「无可比基线」，根因就是口径没有代码载体）。

## 二、本轮数据（对应 n8 第 1–7 项）
1. **轨迹采集（近 ✅，仍有截断）**：4 次 `trajectory_tools_fidelity` = `entries/inputTruncated/outputTruncated` → `4/0/1`、`8/1/1`、`7/0/0`（**`thinkingChars=51124` ⇒ `thinkingTruncated=true`**）、`1/0/0`。工具侧保真结论（`inputPreview` 恰 180c 已消失）仍成立，但**长思考会被截** ⇒ 反传素材上限即思考上限。
2. **反传触发（✅ 3 次落地，3 类丢失复现）**：`semantic_backward_entered` 4 次（3 次 `hasHighEntropy=true`、`learningPromptSource=raw_prompt`、`taskPromptPatch=matched`）⇒ LLM 反传确实跑；但 `agent_end_backward_skipped{no_pending_match}` ×1 + `highentropy_missing_at_agent_end{raw_operational_trace}` ×1 + `semantic_backward_skipped_not_feedback{pairing_judge_no_match}` ×2 ⇒ **P0-5（配对/归因）第三轮原样复现**（两条 skipped 的 `msgPreview` 正是本轮 n6 派发消息）。
3. **HE→Function 沉淀 ✅**：`highentropy_captured` ×3（1843/1772/1858c）→ `highentropy_function_persisted` ×2（`pi_star_gate_trade`，`codeChars=1200`，`contentAppended=true`）。
4. **抽象融合 ✅（在发生）**：`nodeMutations` 出现跨层 merge（`L1::node_1←L0::node_1`、`L2::node_0←L2::node_1`、`L3::node_0←L3::node_1`）；`semantic_backward_compression_round{trigger:add_skipped_at_cap}` → `compression_done{resolved:true, progress:true}` ⇒ 容量满时的压缩轮有效。
5. **内容面被拒（R8 入口）**：`node_write_refused_keep_better` ×2（`L0::node_1`：0.1143 vs 0.0075；0.1017 vs 0.0087）⇒ LLM 每轮增量提炼**整轮丢弃**。
6. **LLM 返回空（新观察）**：`semantic_backward_goal_cleanse_fallback{reason:"llm_returned_empty_node_updates", victim:"L2::node_1"}` ×2 ⇒ 清筛指令把 LLM 逼成空 `node_updates`（与「MUST-CLEANSE 指令污染反传输出」同族）。
7. **离线复核面自伤（新登记）**：`semantic_backward_llm_raw_response.rawContent` 落盘被截到 **2000c**（`rawContentChars=5181` ⇒ `storedLen=2000`）⇒ 4 条中 **2 条 `JSON.parse` 失败**（`Unterminated string`）。**不是模型问题**：离线无法复核反传原文。

## 三、本轮根因 R8（单变量）：保留判据 = 拿「绝对字面命中」比较「累积长文 vs 符号化增量」
- **判据面**：`index.ts` 写入前置比较 `_sNew < _sOld * 0.85 ⇒ 拒写`，而 `_sOld/_sNew = lexicalRelevance(goal, stripFunctionBlocks(body))`，其中 `lexicalRelevance = hit / sqrt(|a|·|b|)`（`hit` = goal 侧被命中的 token 数）。
- **缺陷 1（累积偏差）**：`hit` 只数 goal 侧命中，而旧文每轮 keep 都保留 goal 的字面词（交易/买点/卖点/量能/均线）⇒ 该分对旧文**单调累加**；新文是「专业符号化增量」（`π*` / `ATR` / `gap_lower` / 函数名 + 少量领域词）⇒ 字面命中天然稀疏 ⇒ **结构性必输**（实测 15×）。
- **缺陷 2（空壳自锁，更致命）**：同一实现换个节点就反转 —— `L0::node_1` 正文已被 2 个 `<function>` 块吞没（`stripFunctionBlocks` 后 ≈0 ⇒ `scoreOld=0`）⇒ ①`_sNew < _sOld*0.85` **永假**；②任何新文本与空旧文的重叠也恒为 0 ⇒ 正文**一旦丢失即永久锁死**（层 0 实测两极分化）。
- **后果链**：LLM 每轮投入（4 反传 / 3 HE / 2 Function / 51124c thinking）在**节点内容更新通道**被大面积丢弃 ⇒ 节点不再演化 ⇒ 只剩 `[fn:σ]` 引用累积 ⇒ **悬空 4→17→27→33→35 与节点两极分化同源**。
- **不变式（新增）**：**保留类判据不得把「绝对命中量」在两个长度/累积状态不同的文本间比较**；判据应「只看新文自身是否带在域证据」，且**旧文为空壳时不得拒写**（否则形成不可恢复的死锁）。

## 四、本轮实施的改进（git **`14f5961`**；**需 n9 重启三件套生效**）
- **① 判据改「证据制」**（`scoring_policy.ts` 新增 `retentionVerdict(goal, oldText, newText, opts)`）：拒写收窄为「**新分低 ∧ 无任何在域证据**」；证据 = ①新文命中 goal 词面（`goalHits>0`）∨ ②新文与旧文词面重叠 ≥ **0.15**（同节点应同域）；**空壳豁免**（旧文词面 <20 ⇒ `freshNode` ⇒ 永不判离域）；仅当「新文词面 ≥40 ∧ 无证据 ∧ 非空壳」才拒。**无词表、无 LLM 调用、纯函数可测**；`0.85` 相对条件保留（只作辅助，不再单独定生死）。
- **② 新增观测点** `node_write_downgraded_to_merge`（含 `scoreOld/scoreNew/goalHits/oldCover/freshNode/evidence/oldChars/newChars`）⇒ 下轮可直接验证「LLM 增量是否真落盘」，而不是只看 `refused` 计数；`node_write_refused_keep_better` 同步补同样字段。
- **③ 悬空口径代码化**（`lib/similarity.ts` 新增 `scanDanglingFnRefs(nodes)` + 每次反传后事件 `fn_ref_dangling`）：输出 `symbolsAlive / danglingPairs / danglingRefs / danglingSymbols / refsTotal / perNode`，**仅记事件、绝不改写节点**（硬性约束 2）。P0-1 的前半句（`fn_block_evicted` 时剥离 content 引用）**本轮暂缓**——它会改写节点正文，与「存量悬空不得手工清理」冲突；改为先量化、由 F4'' 决定剥离策略。
- **④ 验证**：新套件 `src/test_retention_increment.ts` **31/31**（T1 旧判据偏差复现 / T2 交易放行+离域仍拒 / T3 空壳豁免 / T4 域一致性证据 / T5 小增量不误杀 / T6 口径纯函数 / T7 源码守卫「无 content 侧剥离」）；回归 **10 套件全绿**（`task_prompt_patch 17`、`fn_multiblock_move 16`、`fn_block_survival 9`、`lift_merge 42`、`lift_overflow_dup 15`、`lift_jump 18`、`task_persist_roundtrip 15`、`tools_fidelity ALL PASS`、`content_limit_zero ALL PASS`、`function_domain_gate 34/34`）；`LOAD_OK src/index.ts`（esbuild bundle 354KB）。改动文件全为**符号链接**（`index.ts`/`scoring_policy.ts`/`lib`）⇒ 无需 `cp` 同步；新测试文件不挂载进 extension（硬性约束 9）。
- **运行器补记（避免下轮重复踩坑）**：根目录套件用 pi 自带 esbuild（`/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/.bin/esbuild`）+ `--bundle --format=cjs --define:import.meta.url="file:///…/<test>.ts"`；缺 `--define` 时 `new URL(import.meta.url)` 会 `TypeError: Invalid URL` 假失败（非回归）。

## 五、下一轮验收断言（逐条可字面核对；F1'–F5' 已随本轮收窄）
- **F1''**：窗口 `node_write_refused_keep_better` **≤1**（本轮 2）**且**同轮 `node_write_downgraded_to_merge ≥1` ⇒ 证明证据制放行了在域增量（防「拒写变静默跳过」）。
- **F2''（空壳复活判据）**：`L0::node_1` 的 `stripFunctionBlocks(content)` **字符数 > 200**（当前 ≈0）⇒ 交易正文能长回来；若仍空 ⇒ R8 未修完，下一步查 `mergeContent`/`goal_cleanse` 是否再次清空。
- **F3''**：`L0::node_0` 的 2 个函数槽**至少 1 槽为交易域**（`gate/sizer/position/atr/kelly/level` 语义）。
- **F4''**：`fn_ref_dangling.danglingPairs` **≤35**（本轮首次有代码口径基线），**优先要求下降**；若上升，只能从 F2'' 与「淘汰优先级」找因，**不得手工清理**（硬性约束 2）。
- **F5''**：`semantic_backward_llm_raw_response` 补 `rawContentTruncated` 标志或提高落盘上限（本轮 2/4 条离线 `JSON.parse` 失败）。
- **F6''（沿用 F1' 形）**：函数侧域闸仍按**前置样本条件**判 —— 有离域族 `<Function>` 样本才计拦截率，无样本记 `no_offgoal_sample`。
- 不变式（沿用）：`injectedCount ≥ 1` ∧ 拒写时 `scoreOld > scoreNew` ∧ 同层逐字同文计数 = 0 ∧ 零成交轮 `flat/unattributed`。

## 六、n6 交易侧旁证与风险登记对齐（第十八轮，guard 不管交易，只对齐机制前提）
- **计数对账（延续两轮成立）**：sender 自计 `/api/step` **2/2**（含 1 次成交失败但交易日已推进）↔ 存档 `step_index 74→76`（差恒 2）⇒ 「自计数 + 存档旁证」第三次成立。**成交失败不减少计数**（交易日不可跳过、回合已耗），但账面与仓位的指纹是「**交易次数与持仓量同时不变**」⇒ 必须归因为**执行映射缺陷**而非判断缺陷（否则污染后续参数标定）。
- **trade.py 落地核实**（885→**942** 行，ABI 四字段未变，`python3 workflows/trade.py` ⇒ 「契约守卫 + 冒烟：全部通过」）：`_CFG` 增 `gap_tol_atr=0.6`/`gap_tol_pct=0.02`；`_order_px()` 改为双向宽容带 `band=max(0.6·ATR, 2%·close)`（买 `close+band` / 卖 `close−band`）并**移除 `mom_up` 启用前提**；`_contract_violations()` 增断言⑤（申报价不带宽容带 ⇒ `order_px_stale_anchor_*` 降级不动仓）+ 负例「锚价买入被拦」；`_lot`/`_target_qty` 统一按申报价计价并保留 `1e-9` eps。
- **风险登记对齐（重要：worker 的前提不成立，勿重跑一遍）**：worker 登记「若执行层实为『成交价≡申报价』纯限价模型，则宽容带化为 ±2.2% 真实滑点，应改失败重报而非缩带」—— 该前提**已被第十节金定否定**：执行层为**限价单真实撑合**（买 `min(申报,T+1开盘)`、卖 `max(申报,T+1开盘)`，开盘价触及即按市价成交），**申报价只作区间校验**；本轮实证（申报 `55.21` 越出当日 `[low,high]` ⇒ `success=false` 且交易日照推）与该结论一致 ⇒ **宽容带零成本前提成立**，无需转「失败重报」。
- **反向待核（新，若出现即需第三次修正机制结论）**：若后续轮次出现「成交价恒 = 申报价（即便申报价≠开盘价）」⇒ 说明撑合取的是申报价而非 min/max；反之若出现「申报价远离开盘但仍按开盘价成交」⇒ 印证现行结论。判据必须以 `trade_result` 回读的 `fill_price` 与同时序号 T+1 开盘价对照，**不得**用存档字段或字段名直觉推断（第十节教训）。
- **节点知识残留（登记不改，硬性约束 2）**：`L0::node_1` 正文里固化的「成交价≡申报价、零摩擦、触及即全额」**与现行代码不符**，却每轮被前向注入给决策者；本轮 worker 的 `_order_px` 恰好**依赖真实机制**（宽容带零成本）⇒ 面临被反向误导的风险。这是 R8（正文空壳）+ 悬空之外**另一条节点知识质量线索**：「病旧知识未汰、新正确知识被拒写入」是同一根因的两个面。

## 七、P0 候选更新（本轮只实施一项：R8 保留判据）

1. **悬空 `[fn:σ]`** → 第十八轮**已实施后半句**（`fn_ref_dangling` 事件 + 代码口径），**前半句（剥离 content 引用）暂缓**（与硬性约束 2 冲突，待 F4'' 量化后再决）。当前基线 **35**（符号×节点对）。
2. **配对源根治（P0-5，第三轮复现）**：`no_pending_match` 丢自产 HE ⇒ 无匹配时应入栈 + 标 `reward=unattributed`（禁 HE 驱动 reward）并补 self-backward；判据 = 窗口 `agent_end_backward_skipped{no_pending_match}` **= 0**。
3. **函数槽淘汰优先级**（F3'' 同源）：`NODE_FN_BLOCK_MAX=2` 下工程域块顶掉交易域块**连续两轮命中** ⇒ 优先淘汰 LLM 判离域的函数块，或按域隔离槽位。
4. **`llm_returned_empty_node_updates`（新）**：清筛指令与反传输出互斥（2 次 victim 均为 `L2::node_1`）⇒ 建议清筛走**独立通道**，不占用同一 `node_updates` 预算。
5. **离线复核面（新）**：`rawContent` 2000c 落盘上限（见 F5''）。
6. **`pinnedTaskFamily` 全局 pin**（R5 剩余面，沿用）。
7. **事件写入者归因**（沿用）：`pid` + `md5(src/index.ts)` —— **本轮 writer hash = `6e87cc81`（index.ts）/ `2284199e`（scoring_policy.ts）/ `60e23df7`（lib/similarity.ts）**，三个文件在 `~/.pi/agent/extensions/textron/` 下已校验 **SAME**（符号链接，无需 `cp`）。

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


## 四、本轮实施的改进（git `fa15bc2`；**需 n9 重启三件套生效**）

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

- **F1'（新闸触发；含前置样本条件，防假阴性）**：**前置断言**——窗口内存在 `highentropy_function_persisted` **且**其 `symbol` 属离域族（engineering/orchestration/relay-idempotency/API-session/bookkeeping/UI/config/audit），否则该轮**无样本可拦**；有样本时再看：窗口出现 `semantic_backward_function_off_goal`，其 `reason` 指向**函数机制**（非任务标签），且同轮出现 `highentropy_function_skipped{reason:"function_off_goal"}` ⇒ 硬落盘确实被拦（而非只记不拦）。**无样本一律记 `no_offgoal_sample`（跳过而非失败）**，不得计作迁移未生效。
- **F2'（不误杀、不吞学习）**：交易域 Function（`gate`/`sizer`/`momentum`/`exposure`/`atr`/`position`/`kelly` 语义）仍能 `highentropy_function_persisted`；且 `semantic_backward_apply` 的 `nodesUpdated/nodesMerged` **不低于**本轮基线（1 真融合 + 4 次 `refused_keep_better`）⇒ 证明“不整轮早退”落地。
- **F3'（工程域块占比下降）**：磁盘闭合 `<function>` 块中工程/编排域 **≤ 3**（本轮 4/7），且 `L0::node_0` 的 2 个函数槽中**至少 1 槽为交易域**（防再出现 `sender_step_loop_orchestrate` 顶掉 `pi_star_gate_delta_decision`）。
- **F4'（悬空不增）**：悬空 `[fn:σ]` **≤ 33**（本轮基数 27→33）；理想情形下降（需 P0-2 一并实施）。
- **F5'（`selected ⊆ context` / 注入）**：延续 **8/8**；`contextCount ≥ 1`；轨迹工具侧仍无“恰 180c”。
- **反证判据（防“改完就宣称成功”；已加样本前置）**：仅在 F1' **前置断言成立**（窗口内确有离域族 `<Function>` 提交）时生效：若 `semantic_backward_llm_raw_response` 中 `function_off_goal` 字段出现率 **< 30%**，则判本迁移**未生效**（而非失败）—— 因为缺省=在域内，LLM 不答即行为等于回滚前，需转 R7 剩余面（程序侧硬判据缺位，如：只允许与已激活交易域节点共享 `functionSymbol` 的函数落盘）。**无离域样本时**：记 `no_offgoal_sample` 并**跳过本判据**（避假阴性）。
- 不变式（沿用）：`injectedCount ≥ 1` ∧ 拒写时 `scoreOld > scoreNew` ∧ 同层逐字同文计数 = 0 ∧ 零成交轮 `flat/unattributed`。


## 六、下一轮 P0 候选（按杠杆排序，**仍只挑一项**）

1. **悬空 `[fn:σ]` 清理（连续四轮单调恶化 4→17→27→33，唯一持续变差指标 ⇒ 摆首位）**：`fn_block_evicted` 时同步从 content 剥离 `[fn:σ]`（现只记 `dangling`）；加每轮反传后回扫 `fn_ref_dangling`（**仅记事件，不自动改写节点**）。**硬性约束 2：存量悬空不得手工清理**。
2. **配对源根治（R6 剩余面）**：查 `allPendingTasks` 的来源（本轮仍见跨进程/陈旧匹配：`matchedTaskTs` = `18:33:28Z` / `18:35:42Z` / `18:35:55Z`，而窗口基线为 `18:48:13Z`）——让候选集合只含「本会话 + 未消费」任务，或 `matched.rawUserPrompt` 为空时**改选** activeTask（`a121d67` 只治素材，未治「配对身份」）。判据：`semantic_backward_entered.matchedTaskTs` 不再早于窗口起点 10 分钟以上。
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

## 十一、stock-trade API 扩展：交易质量量化模块 + /api/prompt 轨迹块（2026-09-17，stock-trade 仓，非 textron 代码）

- **新模块 `UI/trade_quality.py`**（纯函数，无 Flask 依赖）：买卖配对（平均成本法）+ 8 维评分（account/trade/risk_control/benchmark/timing/holding/position/behavior，含 Sharpe/Sortino/Calmar/Ulcer/ProfitFactor/兑现率/MFE回吐/下跌不作为 inaction_ratio/处置效应 PGR-PLR/excess_vs_bh）。输入全 JSON 化 dict；`for_review` 区隔离未来数据（卖出后走势/基准超额/空仓机会成本）——**决策 prompt 只能消费 `render_for_llm(for_review=False)` 的文本，带未来数据的复盘区禁入 prompt**。
- **新 API**：`GET /api/trade_quality?session_id=&review=1&force=1`（返回 score/dims/trades/evidence/llm_text；review=1 才含 for_review 区）；`GET/POST /api/trade_quality/config`（权重/阈值增量合并落盘 `UI/trade_quality_config.json`，POST 后清缓存自动重算）。缓存按轨迹长度失效。UI 新增「交易质量评分」面板。
- **`/api/prompt`（`_build_ai_prompt`）新增「最近交易轨迹」块**（`_render_recent_trajectory`，最近 5 条：step/日期/动作/标的/@price）：标的还原用**倒序游标**——从 `current_stock` 向头走，遇换股记录按消息「从 X 切换至 Y」回退标的；**易错**：消息必须同时搜 `rec.message` 与 `trade_result.message`（后者是「换入 Y」格式不含旧标的，若优先会致游标不回退、换股前记录标的错置）。
- **生效条件**：7860 UI 服务需重启；workflow 消费点为 sender 的 `/api/prompt`（第4步）与 `/api/trade_quality`（第9步反馈）。
- **⚠️ 第十九轮 guard 运行期实测（2026-09-17 19:5x UTC）**：**未重启 ⇒ 改动未生效** —— `curl -s http://127.0.0.1:7860/api/health` ✅（`{"ok":true,"sessions":1,"default_session_id":"4cf529337f29"}`）但 `curl -s "http://127.0.0.1:7860/api/trade_quality?session_id=4cf529337f29"` 返回 **404 Not Found**（路由未注册）⇒ sender 第9步的 `force=1` 重试同样 404，只能落到 workflow 里写明的 `step.portfolio` 兜底打分。**判据**：`/api/trade_quality` 返回 200 且含 `data.score` 才算生效。**处置**（不在 guard n8 范围内，登记以免下轮误判为代码 bug）：重启 7860 UI 服务后再由 sender 跑一轮交易验证。

---

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
| 13 | **`no_pending_match` 丢 HE**（第十七/十九/二十一轮共 5 次复现；第二十一轮 ×2 = 20:35:33 决策轮 / 20:39:24 清仓轮，`hasHighEntropy=true`）：pending 无匹配时应入栈/补 self-backward（reward 须标 `unattributed`，禁由 HE 驱动 reward） | ⏳ 未修（最高杠杆，第五轮） |
| 14 | ~~**轨迹工具侧仍 slice**~~（`rebuildToolsFromMessages` input 180c / output 640c / `maxEntries=24` shift）| ✅ 已修 `db33ba8`，第十六轮验收：129 `tool_call` 恰 180c = **0**、`entries` 达 39、`inputChars` 12,434 |
| 15 | **事件缺 writer pid / extension md5**：多进程共享 `_events.jsonl` 时无法区分未重启旧进程写入（第十轮口径污染） | ⏳ 未修 |
| 16 | **工程语料污染 stock_alpha**：`layer_0/node_0` 正文残留 guard 会话 HE（`571205a(~16:0x)…`）且 merge 拼接无句界保护（半句截断/首尾互吃） | ⏳ 未修 |
| 17 | **`<`/`>` 疑被吞**：node_0 正文 `all(b=gap_lower*0.97` / `broke_prior_low=price=…` 反复重复，待与 `_node_history` 原始 raw 对照判定 | ⏳ 待证 |
| 18 | **配对源根治（R6 剩余面）**：`allPendingTasks` 为何含陈旧/已出栈项（第十七轮仍见 `matchedTaskTs` = `18:33:28Z`/`18:35:42Z`/`18:35:55Z`，窗口基线 `18:48:13Z`）；`matched.rawUserPrompt` 为空时应**改选** activeTask。判据：`matchedTaskTs` 不再早于窗口起点 10min+ | ⏳ 未修 |
| 19 | **悬空 `[fn:σ]`**：✅ 口径采集源已修（`741788a`：`symbolsAlive` 恒 0 的根因 = 函数块写在 `</content>` 之外）；**真基线 stock_alpha 79 pairs / 103 refs（symbolsAlive 6）**。剥离 content 引用的策略待 G1 基线稳固后再决；**存量悬空仍禁手工清理** | ⏳ 部分 |
| 20 | **层容量 `maxBlocks=2` 下的淘汰优先级（已重复现象）**：第十七轮 `sender_step_loop_orchestrate` 顶掉 `pi_star_gate_delta_decision`（上轮 `turn_based_step_driver` 顶掉 `classify_reply_failure`）；可评估「优先淘汰离目标域块」，判据须由 LLM 给 | ⏳ 观察 |
| 23 | **`/api/trade_quality` 空仓时 `position` 维度恒 0 分**（第二十一轮实测：清仓后 `open_trades=0` ⇒ `position=0`，而 `account/behavior/benchmark/holding/risk_control/timing/trade` 均正常）：属**结构性零值**（无持仓 → 无仓位可评），不得当作「仓位管理最差」记入质量台账（同硬性约束 12 推论）；判据：`open_trades==0` 时该维度必须返回 `null`/`no_position` 而非 0，且综合分权重重归一 | ⏳ 未修（7860 侧） |
| 22 | **R10 离域清洗判据运行期验收**（`e9076f0`，需 `/reload`）：`semantic_backward_goal_cleanse.candidates` 非空 ∧ `candidateModes` 键集==candidates ∧ `cleanseViolationCount`==离线脚本重算；反证：`candidates` 恒空或与 `nodeUpdatesKeys` 无关 ⇒ 判据未接线 | ⏳ 待 reload |
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
11. **跨轮比较的指标必须由代码持有口径**（第十八轮新增；触发：悬空 `[fn:σ]` 台账 4→17→27→33→**35** 连续五轮「单调恶化」，但每轮口径由人工 grep 临时决定 —— 含不含 `⟨fn:σ⟩`、按符号去重还是按「节点×符号」、是否计入函数块内引用、strip 与否 ⇒ **无可比基线**，根本无法判断是「真变差」还是「口径变严」）。
    - **规则**：任何要跨轮比较的指标（悬空引用 / 闭合 `<function>` 块数与域占比 / 写入拒绝率 / 注入数），必须在代码里有一个**单一事实来源的采集函数 + 事件**（如 `scanDanglingFnRefs` → `fn_ref_dangling`），断言直接读事件字段；**禁用每轮手工 grep 计数作为台账依据**。
    - **副产品**：口径入代码后，同一指标才能在多轮间形成时间序列，否则「恶化」与「测量方式变化」不可区分。
12. **口径代码化 ≠ 口径正确**（第十九轮新增；触发：`scanDanglingFnRefs` 上线后 F4''「悬空 4-6 ≤ 35」看起来达标，实则 `symbolsAlive` 8/8 恒 0 —— 函数块写在 `</content>` 之外而采集只读 content ⇒ 指标对函数块存活零判别力，真实基线 `stock_alpha` 79 pairs / 103 refs）。
    - **规则**：跨轮指标的采集函数（硬性约束 11）上线后，必须先对**至少一个真实网络**做一次**离线基线核对**（只读、不改盘），并断言「存活集合非空 ∧ 与独立人工抽样一致」；**结构性零值**（如 `symbolsAlive=0`、`refsTotal=0`、`injectedCount=0`）一律先判**采集源缺陷**，不得当作"改善"记入台账。
    - **推论**：口径改动后若无离线基线，指标数值的跨轮变化**不可解释为质量变化**（第三轮"降低"实为测量面缩小）。
13. **进程内可观测资源必须可自证身份**（第二十轮 default 侧新增；触发：monitor 端口每进程一份 + `EADDRINUSE` 静默 +1 + 无发现机制 ⇒ 多 TUI 并存时端口与启动顺序强绑定，用户只能靠猜端口 ⇒ 「掉线/换端口」）。
    - **规则**：任何「每进程一份」的对外资源（监听端口 / 临时文件 / 单例句柄）上线时必须带**名片**（`pid + 身份 + 资源号 + startedAt/updatedAt`）写入固定注册表，并提供**读侧校验工具**（以「pid 存活 ∧ 资源真在监听」为准，不得只信注册表）；身份字段要**从 `argv` 取值**而非依赖扩展加载顺序（`pi.getFlag('cname')` 在早加载的扩展里取不到）。
    - **退出路径必须三保险**：`session_shutdown`（优雅） + `process.on("exit")`（同步兜底） + **显式 `SIGTERM/SIGHUP/SIGINT` 监听**——实测非 TTY 下无信号 handler 时 SIGTERM **不触发** `exit` 事件，条目必残留；`SIGKILL` 不可捕获，只能靠「下一个注册者 prune + 读侧 `kill -0` 校验」收敛。
    - **推论**：跨进程资源的「存活」判定权在**读者**手里，不在写者；只写不验的注册表等于新噪音。

---

# 决策经验（已沉淀节点，供快速复习）

1. **reward = 上游反馈本身的量化，HighEntropy = 事后总结**（有先后性）：HighEntropy 只做节点内容素材，不得驱动 reward 判定
2. **方案 ≠ 执行**：落地必须过可执行断言（HTML link 数 == weights 边数）才给正分
3. **"能解析就成功"会把故障伪装成学习**：截断残骸必须显式失败；形状判定要"实质"（有更新/新增/动作）不要"存在"（有 reward 键）
4. 字符串感知括号扫描（inString/escaped）是 JSON 提取的通用正确形态（app.py 与 Textron 两处统一）
5. 该学没学要靠指标告警：backward failed、转化率低、任务栈只 push 不消费，显式记录+告警
6. reasoning 系模型：预算参数名要按 compat 分流、思维链要可界（effort=low / enable_thinking=false），否则 content 恒空
7. **保守迁移：闸门类改动只做单侧风险**（默认放行）——新增/迁移判据时优先选「不触发时行为 ≡ 改动前」的形状（如 `strict === true` 才拦、字段缺失/`"true"` 一律视作在域内），使改动**只能改善不能改差**。选择依据是**误杀/漏杀成本不对称**：层容量 `NODE_FN_BLOCK_MAX=2` 下误杀真域内函数（落一个即淘汰一个域内块）代价远高于漏放一个离域块。反之，任何「默认拦截」型判据在 LLM 不输出字段时会静默剔除合法内容，不可回滚式地对账。
8. **判据的适用前提必须显式化**（防假阴性）——“字段出现率 < 30% ⇒ 未生效”这类反证只能用于**窗口内确有目标样本**时；无样本时闸门本无需触发，直接套用会误报失败。修法：给判据加前置样本断言（本例：先看 `highentropy_function_persisted` 且符号属离域族），无样本记 `no_offgoal_sample` **跳过而非失败**。同理：闸门“输出事件为 0”必先分辨“判据维度不匹配（LLM 从未作答）”与“实现 bug（字段有但未拦）”——前者换维度，后者修消费点。

---
