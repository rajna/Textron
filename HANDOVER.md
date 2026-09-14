# Textron HANDOVER（压缩版）

> 用途：跨会话交接。保留「未生效改动 + 硬性约束 + 待办 + 决策经验」，历史细节归档为一行摘要。
> 备份：`HANDOVER.bak.20260903_0904.md`（压缩前原文 505 行）。
> 生效规则：**index.ts / extension 改动一律需 `/reload`（或重启 pi）才生效**；monitor.html 8766 按请求读盘即时生效；7860/8770 服务各自重启。

---

# ✦ 最近更新（2026-09-15 02:10）：n8 第九轮 —— JSON 恢复层 + SSE 无缝拼接 + 失败完整raw落盘（8 连败根因）

> 触发：guard n8 本轮交易验证（2 次推进均空仓记平-2，苛刻评分+1）。两次反传 4 模式×2 轮 **8 连败** 全部 "no JSON object"。
> 状态：✅ 已改 `7b17f2d`（src/index.ts + test_json_repair.ts）。**需 /reload 生效**。

## 一、d165351（CJK bigram）验证结论：已生效 ✅
- 本轮 `semantic_backward_goal_guard`：L1::node_0（策略）goalSim=**0.4441**（与上轮验收值 0.444 一致）；L0::node_0/node_1（工程语料存量）goalSim≈**0.01** → 判别力恢复，真正离域者才进 cleanse 名单。无需进一步验证。

## 二、本轮 8 连败根因（证据链闭合）
1. **流式假换行（确证）**：`readSse` 收集 SSE delta 后 `extract` 用 `join("\n")` 拼接——glm-5.3-flash 流式 delta 单字符粒度 → JSON 字符串值/数字/key 内灌入裸 `\n` → 全候选非法。铁证：失败 head `L 0 full ( cap = 2 )` 逐字符空格（diag 的 `\s→space` 压缩后特征）。
2. **非流式内容级瑕疵（强证据）**：chat_json head 合法 JSON 开头 + finish=stop + partsChars≤1783 非截断，但 balanced 字符串感知扫描也救不起 → 字符串值内未转义双引号使扫描 inString 错位。重放 6/6+诱导 5/5 均合法 → 低频、内容相关（无法离线稳定复现）。
3. **可观测性本末倒置（结构性缺陷）**：`semantic_backward_llm_raw_response` 事件在 `extract()` **之后**发出 → extract 抛异常时永不发出；_nojson_response.log 只落 1000c head → 失败轮完整 raw 哪里都没有，语法病灶永不可见。

## 三、修复内容（单主题：JSON 恢复层，两道正交防线）
- **防线①源头（readSse）**：delta `join("\n")`→`join("")` 无缝拼接（delta 本是增量切片无需分隔）——结构级污染只能在此修复（repair 层救不了 key/数字语义破坏，T5b 实证）。
- **防线②内容（extract）**：新增 `tryRepairJsonParse`——状态机修复字符串值内未转义引号（后瞻非结构字符→转义）、裸 \n\r\t→转义、尾逗号删除；repair 成功发 `semantic_backward_json_repaired` 事件。合法 JSON 原样通过（T4 假阳性防护）。
- **诊断（extract 失败路径）**：_nojson_response.log 改落 **完整 raw**（[FULL_RAW] 块）+ rollover 2MB；下轮若再败可直接看语法病灶。
- 测试：test_json_repair.ts **12/12**（未转义引号/裸换行/尾逗号/假阳性防护/流式拼接/散文包裹/垃圾输入/结构级污染边界）；回归 fn_persist 11/11、fn_persist_chain 8/8、fn_block_survival 9/9；esbuild bundle ✅。
- 注意：`test_fn_persist*.ts` 用 `node --experimental-strip-types` 直跑会 ERR_MODULE_NOT_FOUND（entropy 子路径解析），须 esbuild bundle 后跑（fn_persist_chain 例外可直跑）。

## 四、验收断言（/reload 后下轮反传）
- 流式不再出现逐字符空格 head；`semantic_backward_json_repaired` 事件出现则 repair 层命中；8 连败场景 → 至少一个 attempt 成功、backward status=ok、nodesUpdated>0、`highentropy_function_persisted` 恢复。
- 若仍全败：读 `_sb_logs/_nojson_response.log` 的 [FULL_RAW] 块直接定位病灶。

## 五、遗留（未修，按优先级）
- 根因 B② cleanse 指令措辞强制覆写（goalSim 低≠离域；L0 两个工程语料存量节点本轮又被 LLM 判 MUST-CLEANSE 但覆写未落地）→ L0 工程语料出清依赖下轮 repair 救起的覆写或 merge 收缩。
- 根因 B③ N1 奖励错位（决策轮吃上轮 feedback）+ N2 空转轮反传（本轮 2 次反传 inputChars 615/1849 均为流程轮）。
- 存量失败：test_lift_jump 2 fail（宿主 L0 内容吸收）+ test_cap_hard ENOENT（测试自身 /tmp 依赖）。
- 收益趋势：本轮 2 次均空仓（-2/-2），账户 ¥102,493（+2.49% 存档基数）；网络对收益的贡献仍不可归因，需累计更多回合。

---

# ✦ 最近更新（2026-09-15 01:50）：n8 第七轮 —— goalSim 恒 0 根因（CJK 分词颗粒度）+ F1+F2 运行期验收 ✅

> 触发：guard n8 本轮交易验证（2 次推进：61.17 止损清仓 -2 / 空仓观察 -2，总评 2 分）。
> 状态：✅ 已改 `d165351`（`src/lib/similarity.ts` tfidfTokens）。**需 /reload 生效**。

## 一、F1+F2 运行期验收（上轮改动，本轮实证生效）
- `l0_score_start.nodeCount=2`（≥2 ✅ 目录驱动候选池）；`propagate_done.contextIds=["L0::node_1"]`（≥1 ✅ 阈值保底）；`context_user_message_injected.injectedPromptPreview` 非空；「0 context nodes injected」消失。前向注入链路修复完成。

## 二、本轮反传链路失败实证（决定性新根因）
- 事件链：`semantic_backward_goal_guard` 三节点 goalSim **全 0** → 全部判 off-goal → prompt 注入 MUST-CLEANSE 指令 → 4 模式全部 "no JSON object"（chat_json head 明明以 `{` 开头，JSON 语法非法；chat_stream 直接输出纯文本计划）→ `goal_cleanse_fallback`×5 + `highentropy_function_skipped(no_node_updates, symbol=sameDayBreakStopLoss)` → nodesUpdated=0，本轮交易知识未沉淀。
- **根因 A（本轮已修）**：`tfidfTokens` 把 CJK 连续串整段成 token（「沉浸出交易经验」7 字一 token），goal 与节点断句稍异即零交集 → 余弦恒 0。实证：L1::node_0 明写「k线序列/均线斜率/黄金分割位/风报比」与 goal 完全对齐，goalSim=0。
- **修法**：CJK run = 整段短语（精确命中加权）+ run 内去重相邻二字组合（抗断句交集基底）。一处修改，下游 goalCleanseTargets / l0_score / novelty / findSimilarNode 全部受益。
- 验证：策略节点 goalSim 0.444、交易语料 0.363、纯工程语料 **0**（判别力恢复，真正离域者才进 cleanse 名单）；回归 test_fn_persist_chain 8/8、test_fn_persist 11/11、test_fn_block_survival 9/9。
- **根因 B（未修，下一批）**：① backward JSON 解析健壮化——balanced 提取后应对候选做容错修复（未转义引号/裸换行/尾逗号），且 `_nojson_response.log` 只落 1000c 头部，无法诊断语法病灶，应落完整 raw；② cleanse 指令措辞不应强制覆写（goalSim 低≠离域，修复 A 后影响已减但仍在）；③ N1 奖励错位（决策轮吃上轮 feedback）与 N2 空转轮反传仍在。
- **存量失败（与本次无关，stash 对照确认）**：test_lift_jump 2 fail（宿主 L0 内容吸收）+ test_cap_hard ENOENT（测试自身 /tmp 目录依赖）。

# ✦ 最近更新（2026-09-15 01:30）：前向复活 F1+F2 —— 孤儿候选池（目录驱动）+ selected ⊆ context 保底注入

> 触发：用户质询「前向不复活为什么还不改」。
> 状态：✅ 已改（本书）。**需 /reload 或重启三件套生效**。

## 一、F1 孤儿候选池（机械主因）
- 原实现 `for (n < net.hyperparams.layers[0])` 只按**声明槽位数**遍历 ⇒ 磁盘上存在但超出声明的节点**永不参与 `l0_score`**。
- 实证：`layers[0]=1` 而 `layer_0/node_1.html` 有 999c 交易规则 ⇒ `l0_score_start.nodeCount=1`（知识落在引擎从不读取的地址上）。
- 修法：候选池**目录驱动**（`readdirSync(layer_0)` + 正则 + index 排序），声明槽位内空槽保留占位、超出声明的按磁盘真实存在纳入；观测事件 `l0_pool_dir_driven{declared,maxFound,pooled}`。

## 二、F2 selected ⊆ context（阈值断层）
- 原实现只在 `score > threshold` 时进 `contextActivated`；实测 `topAdjusted` 7 次仅 1/7 越过 `threshold=0.2` ⇒ `selectedIds` 非空而 `contextIds` 空 = **稳定退化态**（有路径无上下文）。
- 修法：**每层 top-1 保底注入**（该层有 selected 但全不过阈值时取 top-1）；观测事件 `propagate_done{thresholdFallbackLayers, contextCount}`。

## 三、验证
- 单测复刻：F1 池 `[0]` → `[0,1]`；F2 注入 `0` → `1`；esbuild bundle 通过。
- 运行期验收（重启三件套后）：`l0_score_start.nodeCount ≥ 2`、`propagate_done.contextCount ≥ 1`、`context_user_message_injected.injectedPromptPreview` 非空，且 `0 context nodes injected` 消失。

---

# ✦ 最近更新（2026-09-15 01:00）：content 上限取消 + FUSION NOT OVERWRITE —— 拆掉「抽象融合」的两重天花板

> 触发：用户质询「反传时 LLM 输入了前向节点信息，为何更新时提供的是覆盖而非融合？」「n8 要求审抽象融合效率，为什么没发现？」
> 状态：✅ 已改（`4d9de9b` 上限 + 本轮契约）。**需 /reload 生效**。

## 一、两重天花板（定位）
1. **物理天花板**：`NODE_CONTENT_MAX_CHARS=1000` —— 任何 merge/append 结果超 1000c 即被截断，融合无法累积（实测 content 恰好 999/1000c、name 拼接爆 48c）。
2. **语义天花板（主因）**：`node_updates[k].content` 契约是「节点新内容全文」，**没有表达「保留旧要点 + 追加增量」的语法** ⇒ 即便 user prompt 已给出 `Selected path nodes to update … content: …`（旧内容可见），LLM 也只能整段重写。实证：`L0::node_0` oldContent="知识入网⇏收益改变的三必要条件…" → newContent="高质量交易知识被轻易抹除的四因…"（本轮对话原文），整段替换。
3. **放大器**：`isCleanse` 走真覆盖；非 cleanse 的 `mergeContent` 受 (1) 截断，外部表现同样像覆盖；`0 context nodes injected` 使变动无外部后果可见 ⇒ 长期未被发现。

## 二、改动
- `content_limits.ts`：`NODE_CONTENT_MAX_CHARS` 1000→0（0=不限）；新增 `NODE_INJECT_MAX_CHARS=900` + `applyContentLimit(text,limit)`（limit<=0 不截断）；全库 9 处 `slice(0, NODE_CONTENT_MAX_CHARS)` 改 `applyContentLimit`。
- `index.ts` 契约层：schemaHint 增 `mode(merge|replace)` + `keep(旧要点≤400c)`；解析层默认 merge → 合成 `keep ⏎ content`，仅 `mode=replace` 才真覆盖；system prompt 新增规则 10 FUSION NOT OVERWRITE；规则 4「Content≤1000c」→「无上限」；user prompt 增融合语义说明。
- `lib/compile.ts`：注入侧按 `NODE_INJECT_MAX_CHARS` 限幅（**写入宽 / 读取窄**解耦）。
- 验证：`/tmp/t_content.ts` 7/7 PASS；esbuild bundle 通过。

## 三、验收（reload 后）
- `semantic_backward_llm_raw_response` 的 node_updates 现 `keep` 字段且 content 为增量。
- `apply.changedNodes`：newContent ⊇ oldContent 关键要点（信息并集覆盖率），而非整段替换；content 可超 1000c 且不截断，注入侧仍 ≤900c/节点。
- **仍未解决（下一批）**：F1 孤儿候选池（`layers[0]` 驱动，磁盘节点不被扫描）+ F2 `selected ⊆ context` ⇒ `injectedCount≥1` 前交易验证轮为空转实验。

---

# ✦ 最近更新（2026-09-14 23:45）：HighEntropy <Function> 硬落盘 + 前向 fn 引用链 —— 可执行产物不再只留在轨迹里

> 触发：guard n8 轨迹审计实证——网络 goal 明确要求「可复用交易策略函数/量化程序」，但 `functionBlock` 只在 `semanticBackwardLLM` 的 **prompt 输入侧**被消费（index.ts:1752 截 1500c 送进 user prompt），落盘侧零通路：LLM 实测只产出自然语言 `node_updates`，`layer_*/node_*.html` 无任何 functionSymbol 字面，前向注入也无从引用 → 函数产物全部滞留在 `_trajectories.jsonl`，跨轮 LLM 杠杆无法累积（每轮从零重新推理）。
> 状态：✅ 3 文件已改（`lib/node_io.ts` · `index.ts` · `lib/compile.ts`）+ esbuild bundle 通过 + `test_fn_persist.ts` 11/11 PASS。git：基线 `7d436ca`（改前状态）→ 修复 `ab13780`。**需 /reload 生效**。

## 一、改动
- **lib/node_io.ts**: 新增 `readNodeFunction/writeNodeFunction` —— 节点级 `<function symbol="..">代码</function>` 块，**独立于 content 的 1000 字上限**（函数体不再与自然语言抢额度）。`writeNodeHtml` 重写 content 时**保留既有 function 块**（否则每次 node_updates 都会静默抹掉代码）。
- **index.ts**: 新增 `persistHighEntropyFunction(net, functionBlock, nodeUpdates, taskFamily)`，在 `autoBackward` 落盘后（fallback 之后）执行：①解析 `functionSymbol[:：]\s*([A-Za-z_][A-Za-z0-9_]*)`；②目标节点 = 本轮 `node_updates` 中**最浅层**节点（L0 优先路由锚点），无更新则不写（宁缺勿错）；③写 function 块 + 若 content 缺 symbol 字面则追加 ` [fn:symbol]`（保 substring 引用链）；④事件 `highentropy_function_persisted` / `highentropy_function_skipped(no_node_updates)`；返回值并入 `bwResult.functionPersisted`。
- **lib/compile.ts**: `compileContext` 对激活节点读 function 块，注入行尾附加 `⟨fn:symbol⟩` → 后续决策/反传能按 functionSymbol 字面命中该节点（与反传规则 8 的引用链对齐）。

## 二、验收断言（下轮交易或任意 backward 轮）
- `_events.jsonl` 出现 `highentropy_function_persisted`（symbol 非空），且 `layer_*/node_*.html` 内含 `<function symbol=` 块。
- 被更新节点 content 含 `[fn:symbol]` 字面；prompt 注入行含 `⟨fn:symbol⟩`。
- 反传 LLM 若仍只写自然语言（不遵规则 8），系统兜底仍保住函数体 —— 即引用链不再依赖 LLM 自觉。

## 三、本轮 n8 审计其余结论（未修，按优先级）
- **N1 奖励错位（P0）**: worker 决策轮的反传吃的是**上一轮** feedback（第2次决策 turn reward=-0.6 对应上轮 -10），本决策的 +10 落到下一 turn 才反传 → 决策动作与其后果错配（credit assignment 滞后一轮）。修法方向：按 msg_id/round 配对 feedback 与决策 turn，或决策轮不反传、只由反馈轮反传。
- **N2 无实质轮也反传（P1）**: guard 握手回执 turn 也跑了一次 LLM 反传（reward=0，rationale=「guard仅发握手回执,无实质验收反馈」）；session_start/纯流程轮同理，稀释反传预算。修法：`reward==0 && 无新事实` 时跳过 semantic backward。
- **N3 覆写式沉淀 ≠ 融合（P1）**: `L0::node_0` activations=41，name 三连演化（抛压衰竭→地量≠止跌→趋势开关优先），但 `nodesMerged=0`、L1→L0 lift 从未发生；L0 cap=2 且 `L0::node_1` 被 off-goal 的「工程容量配置」占坑 → 交易语义只剩 1 个 L0 槽位，异质知识被折叠进同一 content（name 已达 48c 上限）。修法：goal-domain 的 L0 槽位保护 + 强制 lift 候选（把 L1 幂等回执类节点升/降级）。
- **N4 轨迹 slice（P2）**: turn.thinking 恒 1400c、tools 恒 2400c 截断（实证 `mu1euzgk` tools len=2400 恰好卡界），tool_result 只存 resultPreview（632c）→ 反传 LLM 看到的是残缺证据链。
- 正收益信号弱：本局 2 次交易 -165/+162 净 ≈ -3 元（噪声级）；账户 +5.80% 来自历史存档（step 39 起），**不可归因于网络**，需累计更多回合才谈「收益趋势」。

---

# ✦ 最近更新（2026-09-14 20:55）：容量硬不变量 + 压缩强制回喂 —— merge 派生 add 不再绕 cap，skip 不许静默

> 触发：用户需求——「规定了2个 无论如何都是不能超的 无论是否 merge导致」+「不应该 skip，应该强制 llm 在反向传播时作出压缩策略」。n8 审计实证 N2（merge 派生 add 绕闸：LLM parsedAddNodeCount=0 但 nodesAdded=2/nodesSkipped=0）与 B7（merge 后同名自补位，净不减）。
> 状态：✅ 2 文件已改 + esbuild bundle 过 + 隔离测试 15/15 PASS（test_cap_hard.ts）+ 回归 12/12 PASS（test_layercaps.ts）。**需 /reload 生效**。

## 一、改动
- **lib/lift_merge.ts**: ①`allocSlot` 加 cap 硬闸——append 前按存活节点数对 `layerCapFor` 校验（含默认40），alive>=cap 返回 `null`，`layers[]` 不再被静默 ++ 扩容（N2 机制根源）；②宿主落位 allocSlot=null → `merged:false, reason:host_alloc_over_cap(L{x})`（不落盘，原因交上层压缩轮）；③溢出伴随节点槽位分配**延后到源清空之后**（优先复用 merge 腾出的空壳，内容不丢），仍无空壳→溢出截断（宁截断不超容）。
- **index.ts**: ①`semanticBackwardLLM` 新增第8参 `compressionMandate?: string`（追加进 user prompt + `semantic_backward_llm_input` 记 mandateChars）；②`forcedSemanticBackward` HE-fallback 后新增**强制压缩轮**（上限2轮，无进展即停）：触发条件=「存在超容层(used>cap)」或「本轮 skipReasons 含 over_cap/layer_full」；`buildCompressionMandate` 列超容层 used/cap+全部节点清单，强制 LLM 输出 node_updates 折叠/merge 收缩（禁 add）；压缩结果并入 bwResult（nodesUpdated/Merged/Skipped/nodeMutations）；事件 `semantic_backward_compression_round/done`，未收敛记 `semantic_backward_compression_unresolved`(error 级)；进度判据=afterSig≠beforeSig（used 递减）。
- **语义**: cap 现在是硬不变量——addPolicyNode(原有闸)+backward addNodes(原有闸)+liftMergeNodes allocSlot(新闸) 三入口全覆盖；同层 merge（keepTgt/keepSrc 复用参与者）不走 allocSlot，天然净减；超容存量网同层 merge 仍可收缩（T4）。

## 二、验证（test_cap_hard.ts，TEXTRON_HOME 隔离）
- T1 跨层 merge 撞满层→merged:false+reason、layers 不扩容、alive 恒=cap；T2 同层大内容→宿主复用+溢出复用空壳（不丢内容不扩容）；T3 cap>slots→append 放行到 cap 内；T4 legacy 超容网（9/2）同层收缩放行+跨层拒绝。回归：test_layercaps 12/12。
- 行为侧断言（下轮反传）：events 出现 `semantic_backward_compression_round`（trigger=over_cap/add_skipped_at_cap）→ `compression_done`（resolved=true 或 progress=false）；满层被拒时 LLM 产出 merge/node_updates 而非重复 add。

## 三、关联
- 修复 N2（清单#5 后半）/B7 的绕闸面；B1/B2（孤岛/0出边）未动；「skip→强制压缩」对应清单#8 的精神但落在容量轴。清单#3（跨网回写）仍未修。

# ✦ 最近更新（2026-09-14 20:10）：layerCaps 每层容量上限 —— 反传注入网络配置 + add 硬约束，禁无限增长

> 触发：用户需求——「l0节点配置上限是2个 现在超过多个，反向传播时应该告诉 llm 网络配置信息，不是能无限增长的，理想情况是 llm 会根据配置信息来更新网络」；「没有配置的使用默认，有配置的按配置」（默认=旧 MAX_PER_LAYER_SOFT=40 语义）。
> 状态：✅ 4 文件已改 + esbuild 语法全过 + 隔离测试 12/12 PASS（test_layercaps.ts）+ textron-lab 已迁移 layerCaps=[2,2,2]。**需 /reload 生效**。

## 一、改动
- **lib/network.ts**: `Hyperparams.layerCaps?: number[]`；`DEFAULT_LAYER_CAP=40`（旧 MAX_PER_LAYER_SOFT 语义权威化）；`layerCapFor(hp,l)` 唯一权威解析（有配置按配置，缺层用末值兑底，无配置默认 40）；`initNetwork` 落盘 `layerCaps:[...layers]`。
- **lib/node_policy.ts**: `addPolicyNode` 在 grow 前算 used，`used>=cap` → 拒绝并返回 `{skipped:true, reason:"over_cap(u/c)"}`（填空槽也算净新增，一并拦截）；日志带收缩指引。返回类型扩展 skipped/reason（index.ts autoBackward 的 `created.skipped` 分支从此真正生效）。
- **backward.ts**: applySemanticBackward 的 addNodes 循环加同样 cap 检查（skip 记 `L{x}:over_cap(u/c)` 入 nodeSkipReasons）。
- **index.ts**: ① semantic backward system prompt 规则 9 重写为 CAPACITY-BOUNDED GROWTH（used>=cap 禁 add、OVER CAP 层必须主动 merge 收缩、无新建层逃生口）+ 规则 6 的 L0 强制加域节点加「room>0 才行，否则 merge 进现有域节点」条件；② user prompt 的 Layer usage 改为 `L0: used=7/cap=2 OVER CAP +5 (add 会被拒, 必须先 merge 收缩) · ... · layerCaps=[2,2,2] · layers(槽位)=[7,1,0]`；③ add_nodes 解析层收紧 `layer < layers.length`（禁止新建层）；④ `GET /api/networks` 返回 layerCaps + nodeCounts 带 cap；⑤ 新增 `POST /api/networks/caps` `{taskFamily, layerCaps:[2,2,2]}`（layerCaps=null 回落默认）。
- **数据迁移**: `~/.textron/textron-lab/hyperparams.json` 写入 `"layerCaps":[2,2,2]`（备份 .bak-layercaps-*）。当前 L0 used=7 超容 5 → 重载后 L0 一切 add 被拒，prompt 要求 LLM 主动 merge 收缩。
- **测试**: `test_layercaps.ts`（esbuild bundle + node 运行，12 断言全过，测试网 zz-caps-test 自动清理）。旧代码在 add 时写回 hyperparams.json 不会抹掉 layerCaps（readJson 整对象保留）。

## 二、验证/验收断言（下轮交易或任意 backward 轮）
- prompt 侧：_events.jsonl `semantic_backward_llm_input` 的 user content 含 `OVER CAP +5` 与 `layerCaps=[2,2,2]`。
- 行为侧：L0 add → 日志/`_events.jsonl` 出现 `over_cap(7/2)` skip 且 nodesAdded 不增；LLM 应改产出 node_actions merge（收敛后 L0 used 递减）。
- 默认侧：无 layerCaps 网络（如新建网络）行为不变（40/层）。

## 三、关联已知 bug（guard n8 审计清单，未修）
B1 activeEdgeSet 空则边永不训练（P0）· B2 新节点 0 出边自锁（P0）· B3 反传 JSON 截断 fallback 跨网写节点（P0）· B4 跨域污染（P1）· B5 轨迹 2400 截断（P1）· B6 反馈轮 HE 被丢（P2）· B7 负奖励期 merge 门控+self-merge（P2）。layerCaps 属新需求非 B 清单项；与 B3 叠加注意：cap 拒绝后 LLM 若重试 add 无效，需靠 merge 产出。

---

# ✦ 最近更新（2026-09-14 05:58）：Live Monitor 网络管理面板——新建网络 / pin 切换 / 每层激活数

> 触发：用户需求——monitor 可初始化新网络(命名+每层节点上限)、激活数可配(每层几个, 原全局 topK=3)、旧网络保留可随时切换。
> 状态：✅ index.ts + monitor.html 已改，**需重启 pi 生效**(HTML 部分按请求读盘即时生效)；隔离 TEXTRON_HOME 验证 16/16 API 测试 + E2E(prompt 路由 reason=pinned_manual, topKByLayer={0:1,1:1}→selectedIds=["L0::node_0"]) 全部通过。

## 一、改动
- **index.ts**: ①新增 `readNetConfig/writeNetConfig/topKForLayer`(`~/.textron/_network_config.json`: `{pinnedTaskFamily, topK, topKByLayer}`)；②`autoRouteNetworkDecision` 开头 pin 分支(reason=`pinned_manual`, 显式 explicitTaskFamily 仍最高, pin 网络被删则落回 auto)；③传播循环每层 `ranked.slice(0, topKForLayer(layer, cfg))`(topKByLayer 覆盖全局 topK, 范围均 1-8)；④新增 4 个 HTTP API：`GET /api/networks`(列表+nodeCounts+config)、`POST /api/networks/init`(强制新建, 重名 409, 层数 2-8/每层 1-64)、`POST /api/networks/pin`(taskFamily=null 回自动)、`POST /api/networks/topk`(topK/topKByLayer, 越界 400)。
- **monitor.html**: hero 下方折叠面板「⚙️ 网络管理」——网络列表点击切换 pin/AUTO、新建表单(名称+各层上限+阈值)、全局/按层激活数输入。不在 poll 重渲染内(输入不丢), 10s 静默刷新。
- 注：工具 Textron init 的“扩容优先不建新网”策略不变 — monitor 面板才是显式新建入口。

## 二、验证
- 隔离 env `TEXTRON_HOME=/tmp/textron-verify TEXTRON_MONITOR_PORT=8799` + SDK `createAgentSession` headless 验证：init/pin/topk/409/400/404/持久化/生产无污染 16/16 PASS；真 prompt E2E 确认 pin 路由与按层激活生效。
- 加载判据：进程启动时间晚于 index.ts mtime。

---

# ✦ 最近更新（2026-09-05 凌晨④）：agent_end 单数据源重构——回合快照从 event.messages 提取, 模块化入 lib/round_snapshot.ts

> 触发：接凌晨③的认知——正确回合模型=每条用户消息一次完整 run(before_agent_start→agent_end), 中间多 turn(assistant→toolCall→toolResult)全在 agent_end.messages 全量数组里；textron 原用 message_update/tool_call/tool_result 增量 hook 跨轮拼 buffer 是"不理解需求就瞎改"(错误理解中间过程), 且增量缓冲依赖 before_agent_start 重置 → coms 续接轮不触发即残留错位。
> 状态：✅ src 已改(index.ts + 新增 lib/round_snapshot.ts), 需 /reload 生效；隔离环境实测通过(R5→R6: pairing match=0→backward done reward=0.8→task consumed)。

## 一、改动
- **新增 `src/lib/round_snapshot.ts`**(模块化, 不入 index.ts 主体): `lastUserMessageText(messages)` 取末条 role=user(修复续接轮 userPrompt 残留旧 msg_id 错位); `rebuildToolsFromMessages` 从 assistant content[].toolCall + role=toolResult 重建工具链 ▶in/◀out(等价 tool_call+tool_result 增量缓冲, 无跨 hook 状态); `rebuildThinkingFromMessages` 提取思考链; `extractToolResultText` 递归白名单提取防 [object Object]。
- **index.ts agent_end**(3359-3361/3408): 用 `lastUserMessageText(runMessages)` 取代 `currentRawUserPrompt`, `rebuildToolsFromMessages(runMessages)` 取代 `currentTurnTools`, thinking 改模块提取 → messages 是唯一权威, 增量 hook 降级为回退(暂未删, 兼容旧流式路径)。

## 二、验证
- 隔离 TEXTRON_HOME + -ne 显式 -e index.ts 加载, 编译通过无错；R3/R5 任务入栈(task_start)、R4/R6 反馈配对(isFeedback=true matchIdx=0)→ backward done reward=0.8/-0.6 → task consumed 出栈闭环完整；轨迹 userPrompt 每轮 msg_id 逐轮更新(错位修复)。
- 环境注意：验证反传须先 Textron init 建网络, 否则 loadNetwork 返回 null → backward_failed_at_agent_end(非代码错)。

---

# ✦ 最近更新（2026-09-05 凌晨③）：coms 消息投递改动态 idle——修复多轮续接跳过 before_agent_start 致 reward 丢失

> 触发：n8 审计(sh.688317 交易 2 轮)发现两次复盘反馈(-2/-10)均 no_pending_match、唯一反传(-0.6)却是决策请求误配对；**hook 探针实测**(screen+探针扩展, 三轮 coms)证 root cause=local-coms.ts handlePrompt 固定 `{deliverAs:"followUp"}` → 后续消息被 pi 当"同 run 续接",**每轮仍发 agent_start/agent_end 但跳过 before_agent_start**；而 textron 配对/currentRawUserPrompt 全挂 before_agent_start → 续接轮配对空转、userPrompt 残留首条 msg_id(轨迹错位)、reward 丢失。agent_settled 只在整批消息结束后触发一次(非逐轮)。
> 状态：✅ **local-coms.ts 已改**(不需 reload——扩展目录 .ts 每次 pi 启动热读？实测已生效)；textron 零改动。

## 一、修复(local-coms.ts handlePrompt, 一行语义)
- 原：`pi.sendUserMessage(msg, { deliverAs: "followUp" })` 固定续接。
- 改：`const idle = ctxRef?.isIdle(); const opts = idle ? {} : { deliverAs: "followUp" };` → **空闲时默认投递=每消息独立完整 run**(before_agent_start+agent_settled 逐轮触发, 与正常用户交互同型); 忙时(背靠背)才 followUp 排队兜底防抛错。
- 实测验证：vf-worker 两轮(任务+复盘反馈)均触发 before_agent_start ✅ + agent_settled ✅(对照 followUp 版 M2/M3 缺失)。

## 二、兼容性/边界
- 正常聊天不变(本就每轮 before_agent_start)。
- coms await/response 模式无影响(每条本就等回复)。
- 极端背靠背(agent 忙时消息到达)→ 走 followUp 兜底, 不抛错。
- 备份：/tmp/local-coms.ts.bak.*。

---

# ✦ 最近更新（2026-09-04 深夜②）：tool_result content 结构化提取——修复 String() 得 "[object Object]" 内容全失真

> 触发：n8 审计(交易游戏 301171 会话)发现 tool_result 通道修复(见下方 09-04 深夜①块)虽已生效——15:49 起轨迹 turn 全带 tools/thinking 字段、配对 100% matchIdx=0、反传 reward +0.3/+0.7 成功——但 **tools 记录中 out 全部为 `[object Object]`**(近300事件 57/57 条含、单条2400c中15次、resultChars=15=`"[object Object]".length` 铁证)。根因：pi 的 `tool_result` 事件 `content` 类型是 `(TextContent|ImageContent)[]` 结构化数组(元素形如 `{type:"text",text:...}`)，修复代码用 `String(event.content)` 直接转 → 每个对象变 "[object Object]"。input 侧 JSON.stringify 正常，仅 out 侧失真 → [exec] 条目对 backward 的信息增量打折(方向对了、内容提取层没对)。
> 状态：**src 已改，index.ts 需 `/reload`（重启各 agent）才生效**；trajectory.html 读盘即时生效

## 一、修复
- **新增 `extractToolResultText(content, depth)`**(index.ts 工具函数区, 与 highentropy.ts `assistantTextPart` 同构的递归白名单提取)：depth≤6；string/number/bool 直返；**数组逐项递归 join"\n"**；对象按白名单键 `text/content/output_text/outputText/value` 优先取叶子，`type=image/input_image` 返 `[image]` 标记防噪音，其余才 `JSON.stringify` 兜底(不序列化 TextContent 整对象)。
- **tool_result handler 改用提取器**：`extractToolResultText(event.content)` 后再压平空白；缓冲 out ≤640c 不变；`resultChars` 用提取后文本长。
- 单元验证：数组含 text+image+空串 → 提取 `{"decision":"买入"...} 总资产... [image]`，无 `[object Object]`；纯对象兜底 JSON；字符串直通。

## 二、验证
- esbuild ✅(107ms)；test_topology ✅；test_lift_merge 42/42 ✅。
- **待 `/reload` 后断言**：任意 turn 的 tools 字段含真实工具输出文本(如 trade_result/portfolio JSON 内容)而非 `[object Object]`。

---

# ✦ 最近更新（2026-09-04 深夜①）：tool_result/AI 思考同权进任务上下文——修复配对盲区（no_pending_match 零反传根因）

> 触发：交易游戏(sz.301299 两轮持有 +20 分)完成后 sender 5 回合全 `agent_end_backward_skipped reason=no_pending_match`、零次语义反传。审计发现根因=**tool_result 通道数据丢失**：决策 JSON/trade_result/portfolio/复盘打分全在 tool_result 里，但 handler 只 recordMonitorEvent 不消费 → processLog 无交易过程 → 配对 judge 与 backward LLM 无上下文。
> 状态：**src 已改，index.ts 需 `/reload`（重启各 agent）才生效**；trajectory.html 读盘即时生效

## 一、根因链（排除法锁定，非猜测）
- 配对/backward 执行链路本身 OK：15:24/15:28 两次 backward 均配对成功（reward=-0.8/-0.8，matchedTaskType=Textron反传链路审计）→ 排除配对代码故障。
- 唯一缺的是**交易过程数据源**：`pi.on("tool_result")`(index.ts:3267) 仅 recordMonitorEvent，全库 grep 无第二消费方 → 决策/结果/复盘从不进 processLog。
- 历史病灶：08-19 删 tool_call/tool_result 的 chain.push(UI 简洁)后 handler 成残留半成品；09-03"中间动作 append"只覆盖 assistant turn(HE/蒸馏/tail)，不覆盖工具结果 = **文档宣称已覆盖、代码实际未覆盖**（L0::node_24 早已沉淀此教训却未落地为代码 = 教训空转）。

## 二、修复（4 处 src/index.ts + 1 处 trajectory.html）
1. **tool_call/tool_result handler**：不扫描、全量写入回合缓冲 `currentTurnTools`（≤24 条滚动；in ≤180c/out ≤640c；配对 ▶tool in / ◀tool out 成对）。
2. **agent_end 思考提取**：AI thinking 写入 `currentTurnThinking`（thoughts.join 尾部 ≤1400c）——与回答同权保留，不再只发 agent_thought monitor 事件。
3. **agent_end 拼接 `[ts][exec] 💭思考+🔧工具链` 条目**：taskStart 分支 `newTask.processLog=[exec]`；中间轮分支 append activeTask（与 HE/蒸馏/tail 并列；单条 ≤MAX_PROCESS_ENTRY_CHARS+500≈1200c，遵守 12条/4800c 滚动防 HE 被挤滚）。
4. **配对 judge taskList**：每个 pending 任务附 `recent=` processLog 尾部（slice(-3) join 后 ≤280c）——judge LLM 现在能看到任务执行过什么（trade_result/复盘），不再仅凭 TaskType 猜。
5. **trajectory.html**：详情页新增 💭AI 思考过程 / 🔧工具链两个 section；turn 行经 `updateTrajectoryTurnMeta` 回填 thinking/tools 字段（轨迹行先写、思考后提取，故用回填而非直写）。

## 三、生效链路（闭环验证）
```
tool_result/thinking → currentTurnTools/Thinking 缓冲
  → [exec] 条目 append 进任务 processLog
    → ① backward：processCtx=processLog.join → LLM 见完整执行链（现有机制自动受益，未改）
    → ② pairing judge：任务列表含 recent processLog → 反馈能配对到具体任务
    → ③ 轨迹：thinking/tools 字段落 _trajectories + 面板可见
```

## 四、验证
- esbuild 编译 ✅（133ms）；test_topology/lift_merge 回归 ALL PASSED ✅。
- **待 `/reload` 后跑一轮交易断言**：任务 processLog 含 `[exec]` 条目、配对 judge `matchIdx≥0`、backward reward≠0。

---

> 触发：审计发现 merge 硬编码同层(sp.layer!==tp.layer 即跳过)+节点升层无通道 → L1 永久冻结、无跨层提炼。用户定策 merge 抽象收敛语义，并追问 L3/L4/L5 深层是否兼容。
> 状态：**src 已改，index.ts / extension 需 `/reload`（重启各 agent）才生效**

## 〇、机制认知（v2 重构核心，先于代码）
- **buildTopology 不认识具体层号**：仅 `for l in 0..layers.length-1` 对 l→l+1 按**词面 cos** 建边 + 入度兜底 → 任意层深(L3/L5/L10 同)统一覆盖，**L3/L4 从不特殊**。
- 孤立根因仅两类：①**词面断层**(内容与邻居无共享词 cos=0，内容问题非层问题)；②**层容量空洞**(hyperparams.layers[i]=0 但物理 node_X.html 存在 → 上游空数组无源可连，此前 L4 孤立的真因)。
- 隔离实证：5 层 [1,1,1,1,1]，各层无共享词→edges=0；共享“放量突破”→edges=4(0_to_1..3_to_4 全自动)。铁证层号与建边无关。
- **merge 兼容性 = 机制公式对任意层统一，不是逐层适配**；测试须参数化 runner 而非按层复制场景（旧测试按 L2/L3/L4 各写一遍 = 坏验证，掩盖机制）。

## 一、新增 `src/lib/lift_merge.ts`（v2 机制化，零依赖回环）
- `liftMergeResultLayer(srcL,tgtL)` 纯函数：`srcL===tgtL && srcL>0 ? srcL-1 : min(srcL,tgtL)` → L2+L2→L1 · L3+L3→L2 · L5+L5→L4 · L2+L3→L2 · 含L0→0(封顶)。任意层深同一公式。
- `liftMergeNodes(net, src, tgt, onLog)` 机制链：定结果层 → mergeContent 合并(>1000c 溢出落伴随节点) → **宿主落位单点逻辑** keepTgt→keepSrc→allocSlot(无层特判分支) → 写宿主内容(ngram 删影，物化回退内容 tokenize 仍可达共享词) → **ledger 资产重锚**：被吸收节点训练边，另一端存活且 |Δlayer|∈{0,1} → 新键按“小层为from”重建，多键同目标按 n 加权 δ=Σδn/Σn（实例：(0.8,n10)+(-0.6,n6)→δ0.275,n16）；死键删除；不可达丢计数 → 清空源(留壳) → **materialize() = merge 对边的唯一动作**(物化重建全部 prior 边含入度兜底)。

## 二、index.ts 接线
- autoBackward merge 分支：去同层硬限 → 调 liftMergeNodes；emptied 入队 compact；compact>0 后补 materialize；宿主刷 commitNodeHtmlEdges(账→货)
- RELATED 候选：同层 → |Δlayer|≤1（仍禁跳层 L0↔L2）；prompt MERGE SCAN/RELATED 文案“MERGE LIFTS ABSTRACTION”；normalize 跨层校验改 layer_jump(层差>1 才拒)

## 三、配套缺陷修复（compact 账货一致）
- node_policy.ts 新增 `reindexLedgerAfterRemoval`：层内移除空节点后 ledger 键 node_X 序号同步重索引(>n 减1、==n 删)，物化不引用死节点
- compactMergeEmptiedNodes：html 移动同步 rename ngram 影子（防孤儿 ngram，L1 node_6~18 残留类）

## 四、验证（v2 参数化，42/42 PASS）
- `test_lift_merge.ts` 重写为参数化 runner：①A 段证层深无关(3/5/6 层建 depth-1 跨层段)；②B 段规则纯函数 11 组(L0..L5×L0..L5 含封顶)；③C 段 `assertMerge(label,srcL,srcId,tgtL,tgtId,expHostL,features)` 单函数跑 L2+L2/L3+L3/L4+L4/L2+L3/L3+L4/L5+L5/L0+L4 八组合——断言宿主层、物化后宿主有边、compact 后无幽灵 ledger 键；④D compact reindex。
- 生产同构：节点附 ngram 影子(tokenize 保持整段 CJK 为单 token，故共享词须为整段短语)。
- esbuild src/index.ts ✅；test_topology ✅；test_llm_budget 27/27 ✅

**待验证**：/reload 后跑一轮交易看 semantic_backward 是否出现跨层(Δ=1) merge 且 hyperparams.layers[1] 增长。遗留：backward.ts 未同步(无引用方死代码)；重锚对“另一端同批被吸收”场景 drop 计数可能重复(幂等无害)。

---

# ✦ 最近更新（2026-09-03 深夜）：信息获取策略升级——中间轮 HE 优先/LLM 蒸馏、反馈轮全量、AI 思考默认排除

> 触发：审计发现头部截断 slice(0,200/400/2000) 会切掉回复**尾部**的 HighEntropy 与复盘结论，过程信息靠机械截断丢语义。用户定策：中间轮无 HE 用**蒸馏**不用 slice；反馈轮 content **全量**；思考过程默认不放（参数可选）。
> 状态：**src 已改，index.ts 需 `/reload`（重启各 agent）才生效**；trajectory.html 读盘即时生效

## 一、中间轮 append 三级策略（agent_end 中间动作分支）
- ① 有 HE（尾部定位提取成功）→ HE **整条**入 processLog，不单条截断（总控 4800c 滚动兜底）；
- ② 无 HE 且 `TEXTRON_DISTILL_INTERMEDIATE!=0`（默认开）→ 占位 `⏳[蒸馏中]` + 异步 **LLM 蒸馏**（`distillTurnEntry`：nothinking/1024 token/25s，输入本轮原文 ≤6000c，输出 ≤520c 结构化摘要，保留决策/数值/方向/原因/约束）；蒸馏入 `enqueueBackward` 串行链 → 反馈轮反传组装前同链已排空；
- ③ 蒸馏不可用/失败 → 正文**尾** 640c 保底 `[noHE·tail]`（尾部优先，非头部截断）。
- 常量：`MAX_DISTILL_OUTPUT=520` / `MAX_FALLBACK_TAIL=640` / `FEEDBACK_PROMPT_MAX=30000`；环境变量：`TEXTRON_DISTILL_INTERMEDIATE`（默认开）、`TEXTRON_INCLUDE_THINKING`（默认关）。

## 二、反馈轮 content 全量（不 slice）
- `assistantAnalysis` 去掉 `slice(0,2000)`（HE 优先，否则剥思考后正文全量）；反传 prompt `Current feedback` 截断 2000 → `FEEDBACK_PROMPT_MAX=30000` 防御护栏。

## 三、AI 思考默认排除（参数可选）
- `stripThinkingText` 剥离 `<thinking>/<reasoning>` 与思维链标记；`TEXTRON_INCLUDE_THINKING=1` 才纳入；正文提取 `assistantTextPart` 本就只取 content（不含 thinking/reasoning_content），双保险。

## 四、可观测性
- append trace 增 `mode`(he/distill_pending/tail)；蒸馏完成发 `agent_end_process_distilled`（entryIdx/distillOk）；轨迹 turn 行 meta 增 `process_mode`。

## 五、遗留注意
- 异步蒸馏回填不影响反传（同链天然有序）；蒸馏失败保留占位不阻断；HE 条目推高总字符 → 滚动丢最旧消化，`process_chars` 持续观察，HE 轮频繁被挤出则调高 4800。

**验证**：esbuild 语法 OK；TS5 改动区零类型错误；回归 process 限长 6/6、lifecycle_feedback 6/1（存量失败未变）。

---

# ✦ 最近更新（2026-09-03 夜）：任务栈生命周期改造——isTask 即入栈 / 中间动作 append / 绑定即出栈 / 轨迹全链可见

> 触发：n8 审计发现 13:47 backward reward=-0.8 错配——sender 执行任务(isTask=T,HE=F)未入栈、12:53 审计任务成"僵尸 activeTask"截胡后续配对
> 状态：**src 已改，index.ts 需 `/reload`（重启各 agent）才生效**；trajectory.html 读盘即时生效

## 一、入栈条件解耦 HE（断点 A）— `src/index.ts` agent_end
- `isTask && highEntropy` → `isTask === true`：HE 是辅助凭证**非入栈凭证**，isTask=true 即定义任务开始
- isTask 兜底：crystal 解析失败时从回答原文正则 `/isTask[:：](true|false)/i` 提取（HE 剥离失败 ≠ 不是任务）
- trace `agent_end_task_pushed` 增 `hasHighEntropy` 字段区分

## 二、中间动作 append 到 activeTask.processLog（含长度保护）
- 非 taskStart 且非反馈轮(feedbackTurn)的 turn → 本 turn 内容 append 到栈顶任务 `processLog`（不再"什么都不做"）
- 结构：单条 ≤700c / 每任务 ≤12 条 / 总 ≤4800c（`MAX_TASK_PROCESS_*`）；超限滚动丢最旧并记 `dropped`；反馈轮不 append（避免污染）
- TaskEntry 增 `processLog: string[]`，随 `_last_state.json` 持久化、磁盘恢复可还原

## 三、绑定即出栈（断点 B / 僵尸修复）— `shouldConsume`
- `hadLearning||hadReward` → `!!bwResult`：backward 成功执行（配对确认）任务立即出栈关闭；hadLearning/hadReward 降级纯诊断；backward 失败仍保留 pending 供重试

## 四、反传上下文长度评估与控制
- `lifecycle_context.ts`：新增 `buildProcessContext`——从新到旧滚动保留最近条目，硬上限 `MAX_BACKWARD_PROCESS_CHARS=2400`；`BackwardTaskContextResult` 增 `processContext`
- backward LLM prompt `Previous user task` slice 1500→4200（`index.ts` semanticBackwardLLM）
- `lastBackwardState`/trace 增 `processChars/processEntries/previousTaskChars` 监控实际上下文长度，超预算可调参

## 五、轨迹原文全链可见（📜 任务开始→过程→反馈→反传）
- turn 行回填 `task_phase`(task_start/intermediate_append/feedback/none)、`in_stack`(不再要求 HE)、`appended_to_task/process_log_len/process_chars/process_dropped`
- backward 回填 `consumed`(绑定出栈✓)/`processEntries`
- trajectory.html 三阶段徽章：`①任务开始·已入栈 → ②中间动作·已累积到任务(N条/Nc) → ③反馈到达·配对反传 → ⟲已反传 r=x.xx + 绑定任务已出栈✓`

**验证**：esbuild 语法 OK ×2；TS5 类型检查改动区零错误；processContext 限长单测 6/6（空log/12×800c截断≤2400/保留最近丢最旧/previousTask 不变）

---

# ✦ 最近更新（2026-09-03 早）：semantic backward 三连败根因修复 + monitor 图回退

> 触发：面板持续 `semantic backward failed · attemptsFailed:3 · no JSON object`（2026-09-02 一晚 4 连败，reward=0 零学习）
> 状态：**src 已改，index.ts 需 `/reload` 才生效**；monitor.html 已生效（8766 读盘）

## 一、backward 输出预算参数根因修复（P0）

**根因（单变量重放锁定，同一失败 prompt 7020c）**：
| 参数体 | 实测 |
|---|---|
| 旧 `max_completion_tokens=4096`（生产原样） | 💥 86.6s · content **0c** / reasoning 13716c · `finish=length` |
| `max_tokens=4096` | ✅ 42.4s content 432c 合法 JSON |
| `max_tokens=8192 + reasoning_effort=low` | ✅ 12.6s content 684c |
| `max_tokens + enable_thinking=false` | ✅ 4.2–5.5s |

即 **qwen/dashscope 把 `max_completion_tokens` 当 reasoning+content 合并上限**，thinking 思维链(13.7k–16.2k 字符)吃光预算 → content 恒空 → 解析无 JSON；且**旧三重兜底共享同一错误参数 = 假兜底**（同一死法重复三次，只放大失败不产生覆盖）。

**修复**：
1. 新增 **`src/lib/llm_budget.ts`** 作为预算参数单一出口：
   - `readCompatFromDisk()`：三级读 compat（model.compat → models.json[provider] → models-store.json[provider].models[id]），与 pi 自身参数表同源不分叉
   - `buildBudgetParams()`：参数名按 compat 分流；预算下限分轨——思考轨 `MIN_OUTPUT_BUDGET=8192` / 关思考轨 `MIN_NO_THINK_BUDGET=1024`
   - `canBoundThinking()`：能否有界思考（qwen/kimi ✅，deepseek ❌）
2. **`src/index.ts`**：
   - backward 兜底阶梯 3→**4 重且自适应排序**：不可界思考模型（deepseek：8192 开思考 >150s 不返回、关思考 1.2s 出 JSON）先跑 `chat_nothinking`；per-attempt 超时自适应 45/60/150s（禁旧 180s×N 空转）
   - 失败诊断增强：错误串带 `finish / partsChars / head`，落 `_sb_logs/_nojson_response.log`
   - **同根第二处**：pairing judge 旧 `max_tokens:200 + 15s` → 思维链照跑满 → 15s 回不来 → 静默退化启发式 → 反馈配错任务（reward 源错位）。改为 `buildBudgetParams(noThinking=true, 2048)` + 25s，实测 qwen 0.9s / deepseek 0.5s 出合法 JSON
   - 启动时发 monitor 事件 `semantic_backward_params_resolved`（含实际 params/noThinkingParams）供面板直接排查
3. **`src/lib/network.ts`**：`TEXTRON_HOME` 支持 env 覆盖（默认不变）→ 验证/生产网络可隔离
4. 注释修正：旧注释「deepseek 不传 reasoning_effort 基于老模型已过期」有误——deepseek 仍不发（未声明 supportsReasoningEffort，避免 8K+ 思维链超时）；由 llm_budget 统一判定

**已回退的无证据改动**：曾疑「模型破协议回散文」加 ROLE HARDENING / OUTPUT CONTRACT 两段提示词——复查确认该"散文"负例来自 6 字符 `(历史补录)` 占位 prompt 的**测试伪影**，真实失败频率 0 → 全部回退，只保留有证据的参数修复（纪律：无频率证据不加护栏）。

**验证**：`test_llm_budget.ts` 27/27（含读真实 ~/.pi/agent 配置断言 6 项）、`test_topology.ts` 全绿、语法检查通过。
**待生效**：`/reload` 后验证——面板出现 `semantic_backward_params_resolved`；下次 backward 四重阶梯成功且 reward≠0；失败时 `_sb_logs/_nojson_response.log` 有 head 可查。

## 二、Live Monitor 图 UI 回退 + 连线可读性（已生效）

**病根**：此前 uncommitted 改动把每条边渲染成 1–6 根发丝（silk bundle）+ 节点缩成 1.7px 微点 + 标签只画选中节点 →「看不清连线」（用户明确要求回退）。silk 版完整备份：`src/monitor_副本.html`。

**处理**：`git checkout HEAD -- src/monitor.html` 回退视觉层，**保留功能性增量**：
- 同层 `${l}_to_${l}` 边分桶收集（latRaw）——否则 258 条 lateral 边被跨层桶键碰撞**静默吞掉**
- footer 显示 `lateral: N · ledger trained: N`
- 连线可读性：实线=跨层主边 / **虚线=同层扩散边**；权重标签阈值 0.35→**0.20**；alpha/线宽设底线（≥0.10 / ≥0.6px），弱边不画噪声（aw<0.02 skip）

**可执行验收**：新增 **`test_monitor_edges.js`**（真实页面脚本跑 Node + 真实 /api/state，断言实际 draw call）——本版 9/9 ✅；silk 版负向对照 4/9 ❌（r=实绘曲线/数据边：1.01 vs 4.07、虚线 0、min alpha 0.021）。已用被回退版本证明测试有区分力。

---

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

---

# 硬性约束（不可违反，否则撤销）

1. **禁止改共享通信层 `local-coms.ts`**（全局 agent 通信，波及所有会话）——修点落在 API 边界
2. **禁止手动清理/删除/篡改网络节点**——污染治理走 forward 选择、reward、backward 合并/降权
3. **禁止事后全量扫描补丁**（syncHtmlEdgesFromWeights）——账货一致只走源头 commitNodeHtmlEdges
4. **预算参数禁止在调用点写死**——一律 `buildBudgetParams()`（本次 P0 就是写死参数名）
5. 兜底阶梯 attempt 必须沿实际失败轴正交（假兜底 = 同一死法重复 N 次）
6. 新增规则/护栏前先量化现有覆盖度+实际发生频率；无证据的回退；单变量归因（改一处看一处）
7. Function 协议 version 维护已废除——version 幻觉/双写震荡，全部归 backward+merge

---

# 决策经验（已沉淀节点，供快速复习）

1. **reward = 上游反馈本身的量化，HighEntropy = 事后总结**（有先后性）：HighEntropy 只做节点内容素材，不得驱动 reward 判定
2. **方案 ≠ 执行**：落地必须过可执行断言（HTML link 数 == weights 边数）才给正分
3. **"能解析就成功"会把故障伪装成学习**：截断残骸必须显式失败；形状判定要"实质"（有更新/新增/动作）不要"存在"（有 reward 键）
4. 字符串感知括号扫描（inString/escaped）是 JSON 提取的通用正确形态（app.py 与 Textron 两处统一）
5. 该学没学要靠指标告警：backward failed、转化率低、任务栈只 push 不消费，显式记录+告警
6. reasoning 系模型：预算参数名要按 compat 分流、思维链要可界（effort=low / enable_thinking=false），否则 content 恒空

---

# 2026-09-14 n8 验证轮（第二轮，guard 实证）：Function 落盘调用链断裂 → 已修复

## 现象（四项断言全否，证据均为产物字面）
| 断言 | 结果 | 证据 |
|---|---|---|
| A `highentropy_function_persisted` 事件 | ❌ 0 条 | 按 events JSON `type` 字段精确解析（85237 条）；裸 `grep -c` 得 4 全是 trace 命令/tool_result 回显（假阳性样本，务必按 type 判定） |
| B 节点 `<function symbol="...">` 块 | ❌ 0 | 6 个节点文件 `</function>` 命中 0（`grep 'function symbol'` 会命中 content 文本提及 `<function symbol="σ">`，必须找闭合标签或 readNodeFunction） |
| C content `[fn:σ]` | ❌ | 出现的 `[fn:σ]`/`[fn:audit_fn_persist_chain]` 是 LLM 复述 Technique 文本形成的**伪引用链**，非 persist 写入 |
| D 前向注入 `⟨fn:σ⟩` | ❌ | compile.ts:30 已实现，但依赖 readNodeFunction 读到块 → 块数 0 时永不产生 |

## 根因（单变量）
`src/index.ts:2952` 在 `forcedSemanticBackward`（:2830 起）内直接引用 `semanticBackwardLLM`（:1669 起）的**局部 const `functionBlock`**（:1752）→ 三次反传全部 `ReferenceError: functionBlock is not defined`（runId `...-ren8bh`/`...-prfcm5`/`...-8nibks`，另 15:50:00 再次复现），并存 `agent_pending_preserved_backward_failed`。
抛错点在 `semantic_backward_apply` **之后** → nodesUpdated=4/nodesMerged=1 已落盘，而 `persistHighEntropyFunction` 从未执行 → Function 通路整条断，同时把正常反传标记为 failed。
**栈与加载状态**：runtime `~/.pi/agent/extensions/textron/index.ts` 是 `src/index.ts` 软链（md5 一致）→ 代码已加载，非"未生效"；反传 prompt 侧 `<Function>`（含 functionSymbol）透传正常；worker 报文确带 symbol（box_break_riskbudget_hold / trend_broken_override / trend_broken_min_lot_clear / broken_exit_reentry_plan）→ symbol 解析非瓶颈。

## 假绿成因（必须记住）
`test_fn_persist.ts` 从未调用 `persistHighEntropyFunction`/`forcedSemanticBackward`（T5 仅注释"模拟"复刻逻辑）→ 11/11 PASS 无覆盖；esbuild bundle 不做类型检查，tsc 的 `TS2304 Cannot find name 'functionBlock'` 零门禁逃逸。

## 修复（commit d511192，最小 diff）
1. `extractFunctionBlock(highEntropy)` 抽为**同层单一事实来源**，`semanticBackwardLLM` 与 `forcedSemanticBackward` 共用 —— 禁跨函数引用局部变量。
2. persist 调用点 **try/catch 隔离**（`highentropy_function_persist_failed`）：审计/落盘插桩不得击穿反传主链。
3. `symbol==""` 早退并记 `highentropy_function_skipped(reason=symbol_parse_failed)`：禁写无 symbol 块（否则 `⟨fn:σ⟩` 永不命中的假达标）。

## 验证（可复现命令）
```bash
cd ~/textron-agent
# 类型门禁：必须零新增错误，且 TS2304 functionBlock 消失（对照 HEAD）
npx --yes -p typescript@5.9.2 tsc --noEmit --target es2022 --module esnext \
  --moduleResolution bundler --allowImportingTsExtensions --skipLibCheck --lib es2023,dom src/index.ts
# 调用链回归（零依赖）
node --experimental-strip-types test_fn_persist_chain.ts   # 8/8 PASS
# 打包（模拟 pi 加载）
/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/.bin/esbuild \
  src/index.ts --bundle --platform=node --format=esm --external:node:* --external:@earendil-works/* --outfile=/tmp/bundle_check.mjs
```
对照实测：HEAD 24 条错误含 `TS2304 functionBlock`；修复后 24→23（仅消除该条），**零新增**。

## 下一步（下一轮验证，勿省）
1. **重启三件套 / reload extension** 使修复生效（esbuild 加载期快照）。
2. 重跑 n6 2 次交易推进 → 断言 A/B/C/D 四项（含 `</function>` 闭合标签、`⟨fn:σ⟩` 注入行）。
3. 若 symbol 仍空：查 `highentropy_function_skipped.reason`（应为 `symbol_parse_failed`，说明 HE 报文未带 `<Function>` 或 `functionSymbol：` 格式不符）。
4. 观察 `agent_pending` 是否被自然消费，避免修复前后 pending 重放导致同轨迹重复反传（收益口径污染）。

---

# 2026-09-14 n8 第三轮（guard）：跨层「向上提升」merge 被一刀切丢弃 → 抽象融合断路（commit 见下）

## 轮次事实（先确认上一轮修复已生效）
d511192 在重启后**已验证生效**：`highentropy_function_persisted` 3 次（`box_tol_entry_gate`@L0::node_1 / `side_effect_post_guarded`@L0::node_0 / `gate_threshold_adapt`@L0::node_1），其中 `side_effect_post_guarded` 的 `contentAppended=true` → 上轮标记为「未覆盖」的 append 兜底分支本轮**已真实命中并落盘**；`⟨fn:box_tol_entry_gate⟩` / `⟨fn:side_effect_post_guarded⟩` 均出现在 `prompt_injection_prepared.compiledContextFull` 与 `context_user_message_injected.injectedPromptPreview`；窗口内 `semantic_backward` status 全部 `done`，无 `failed`。

## 本轮根因（单变量，n8 第 4 项：抽象融合效率）
**`nodesMerged` 结构性恒为 0 ——「向上提升」merge 在解析层被一刀切丢弃。**

证据链（`~/.textron/_events.jsonl` 基线 85421 之后）：
1. `merge_action_dropped {source:"L3::node_0", target:"L0::node_1", reason:"layer_jump"}`（L85565）、`{source:"L2::node_0", target:"L0::node_0", reason:"layer_jump"}`（L85649）——LLM 主动提出的两次抽象提升，全部被丢弃。
2. 三次 `semantic_backward_apply` 的 `nodesMerged` 均为 0（`nodesUpdated=1/2/2`，`nodesAdded=1/0/0`）→ 网络只在同一批节点上原地改写，从不整合抽象结构。
3. 结构后果：`topKByLayer={0:1,1:1,2:1}` → **L3 永不参与前向注入**，`L3::node_0` 的宝贵结论（清仓回补成对 / 1手不可分割 / 触发降级为确认）成为死知识；L1 两个槽位是空壳（`name`/`content` 全空），L2::node_0 亦为空壳；`hyperparams.layers=[2,0,1,1]` + `layerCaps=[2,2,2]` → **L0 满容**，`add_nodes(L0)` 一律被 rule 9 拒（over_cap）。
4. ⇒ 当 L0 满容时，把下层知识提升进 L0 是唯一能让知识「可注入 + 可循环」的通路，而该通路被 `Math.abs(sp.layer - tp.layer) > 1` 静默切断；层差限制本身没有技术依据 —— `liftMergeNodes` 用 `liftMergeResultLayer()` 取更抽象层、`allocSlot()` 硬闸兜底容量、ledger 资产按规则重锚、`materialize()` 重建全部边，**对任意层差成立**。

## 修复（最小 diff，2 文件）
1. `src/lib/lift_merge.ts` 新增 `mergeLayerAllowed(srcLayer, tgtLayer): boolean`——**同层/相邻层/任意级向上提升放行，仅拒绝「向下跳层」(tgt-src>1)**。层向判定收敛为单一事实来源。
2. `src/index.ts` 解析层 `Math.abs(...)>1` 改为 `!mergeLayerAllowed(...)`，丢弃原因区分 `unparseable_id` / `layer_jump_downward`；被放行的向上提升额外记 `merge_action_lifted {source,target,delta}` 便于运行期验收。
3. 未改：容量硬闸（`allocSlot` 满则截断或 `host_alloc_over_cap`）、`mergeDeleteGate(|reward|≥0.05)`、`delete` 禁止 —— 语义边界保持不动。

## 验证（可复现命令）
```bash
cd ~/textron-agent
# 类型门禁：与 HEAD 对照必须零新增（实测 24 → 24，且改动行无 error）
npx --yes -p typescript@5.9.2 tsc --noEmit --target es2022 --module esnext \
  --moduleResolution bundler --allowImportingTsExtensions --skipLibCheck --lib es2023,dom src/index.ts
# 机制回归（隔离网络，跑完自删）：18/18 PASS
/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/.bin/jiti test_lift_jump.ts
# 运行期验收（重启三件套后，跑一轮真实反传）
python3 -c "
import json,collections
ev=[json.loads(l) for i,l in enumerate(open('/Users/rama/.textron/_events.jsonl',encoding='utf-8',errors='ignore'),1) if i>BASELINE]
print('lifted:',[ (e['source'],e['target']) for e in ev if e.get('action')=='merge_action_lifted'])
print('dropped:',[ e.get('reason') for e in ev if e.get('action')=='merge_action_dropped'])
print('merged:',[ (e.get('nodesMerged'),e.get('nodesAdded')) for e in ev if e.get('action')=='semantic_backward_apply'])
print('L3 是否还在:', open('/Users/rama/.textron/stock_alpha/layer_3/node_0.html').read().strip()[:40])
"
# 通过判据: 出现 merge_action_lifted 且某次 semantic_backward_apply.nodesMerged>=1，且 L3::node_0 被清空(知识已提升进 L0)
```
T1 层向真值表 9/9；T2 三级提升端到端（`L3::node_0`→`L0::node_0`：hostLayer=0、源清空、宿主吸收双方内容、L0 不超容）；T3 满容硬闸仍拒绝且带 reason。

## 下一步候选改进（按杠杆排序，勿并行改）
1. **`agent_end_backward_skipped:no_pending_match` 漏学**：窗口内 7 次 `highentropy_captured` 仅 3 次真正反传，`no_pending_match` 3 次（`hasHighEntropy=true,hasFinalText=true`）说明「本轮自产的高熵包」因 pending 匹配失败被丢弃 → 每轮约 40% 的 LLM 杠杆空转。方向：agent_end 时若 pending 无匹配，用「该轮自身 task/answer」作为目标补一次 self-backward，而非直接丢弃。
2. **轨迹工具信息被 slice**：`src/index.ts:4076` `tools: turnTools.join(" ⏎ ").slice(0, 2400)` —— 一轮全部工具调用压成单串并硬截断 2400 字符，n8「信息不要被 slice」的诉求正落在此处；且 task stack 里 `highEntropy` 也被 `slice(0,2400)`。
3. L1/L2 空壳占位：`hyperparams.layers` 与实际存活数不一致（`[2,0,1,1]` 却有 `layer_1/node_0|node_1` 空文件），建议一次性 compact 或让 `allocSlot` 优先复用空壳（`allocSlot` 已实现，缺的是触发）。

---

# 2026-09-14 n8 第四轮（guard）：function 块「稳态存活」缺陷族 —— 优先级排序 + 前置修复（commit 见下）

agent-022388 独立复验第三轮 A/B/C/D 全过，同时报出 N5/N6/N7。guard 复核磁盘实况**确认全部成立，且比报告更严重**，并新增 N8。以下为按修复顺序的优先级（P0 必须先于 P1 的 lift-jump 验收，否则新功能会放大旧缺陷）。

## 磁盘实况（`~/.textron/stock_alpha/`，2026-09-14 之后）
真实 function 块（必须 `<function symbol="X">…</function>` 闭合对）：**全网仅剩 1 个**，且是历史垃圾块 `layer_2/node_0.html` 的 `symbol=""` + 体为 `([\s\S]*?)`。
第三轮落盘的 4 个真块（`box_tol_entry_gate` / `side_effect_post_guarded` / `gate_threshold_adapt` / `assert_fn_persist_callchain`）**全部蒸发**；同一时刻 content 仍挂着 `[fn:box_tol_entry_gate]` `[fn:gate_threshold_adapt]` `[fn:adaptive_box_probe_ladder]` `[fn:side_effect_post_guarded]` → 引用链由「部分断」变「全断」。
**验证陷阱（必须用集合判据）**：LLM 会把审计正则字面 `<function symbol="σ">` 当散文写进 content（本项目实测 `layer_0/node_0`、`layer_1/node_0`、`layer_2/node_1` 各 2 处未闭合），裸 grep `<function` 或单点正则都会假阳性 —— 必须 `<function…>…</function>` **闭合对匹配**，并按 `content 的 [fn:σ] ⊆ 磁盘 <function symbol="σ"> 块集合` 做**集合差**判定。

## P0 已修（本轮第二处改动，commit 见下）：块随内容移位 + 污染块 sanitize
- **N8 块不随 content 移位（蒸发主因）**：`src/lib/node_policy.ts` 空壳压缩 `writeNodeHtml(dst, …, srcContent, …)` 只保留 **DEST 自己**的块（`readNodeFunction(dst)`，空壳→无块），源文件随后 `fs.unlinkSync(src)` ⇒ 一次 compact/merge 蒸发一批函数。修法：从 **SOURCE** 读块显式搬到 DEST（与 ngram 影子文件同批）。
- **N6 污染块永久保留**：`readNodeFunction` 新增 `isValidFnSymbol(symbol)`（ASCII 标识符）单一不变式，`symbol=""` / `σ` / 无 symbol 一律视为**无块**；`writeNodeFunction` 加同向防御（非法 symbol 不落块）。效果：历史脏块不再被 `writeNodeHtml` 一路带下去、`compile` 不再注入 `⟨fn:σ⟩`。
- 回归：`test_fn_block_survival.ts` **9/9 PASS**（T1 拒 3 类脏块/收合法块、T2 writeNodeHtml 保块、T3 移位携带块且源槽无幽灵块）；`test_lift_jump.ts` 18/18 不回归；tsc 与 HEAD 对照 **24→24 零新增**。

## P1 已修（上一 commit ca826eb）：跨层「向上提升」merge 解禁
`mergeLayerAllowed()` 只拒向下跳层；**但其验收必须与 P0 同批** —— lift-merge 会显著提高 merge/compact 频率，若块携带未修，抽象融合每成功一次就丢一批函数产物。

## P2 待修：N5 function 块同节点单槽覆盖
`writeNodeFunction` = `<function…>` 全量替换后追加一块 ⇒ **最后写入者胜**（`box_tol_entry_gate` 15:56:37 落 L0::node_1，`gate_threshold_adapt` 15:57:45 写同节点 → 前者静默消失，而 content 仍留 `[fn:box_tol_entry_gate]`）。
设计：改为按 symbol **upsert 多块**（`readNodeFunctions()` 复数读 + 按 symbol 合并写）；`compile.ts` 的注入位由「单 symbol」改为「该节点全部块 symbol 依次 ` ⟨fn:σ⟩`」。风险点：注入膨胀 —— 需同时给**每节点注入上限**（建议 ≤2）并在 content 超 1000c 时按 token 预算裁剪。

## P3 待修：N7 引用悬空
`content 的 [fn:σ] ⊄ 磁盘 <function symbol="σ"> 块集合`（现网 4 个悬空）。设计：每轮反传落盘后回扫 content 的 `[fn:σ]` 与磁盘块做集合差，缺失项记 **error 级** `fn_ref_dangling{nodeId,symbol}`；连续两轮仍悬空 = 从 content 移除该标记（防止引用链长期虚挂误导路由）。

## P4 冗余清理
落盘 code 保留 `functionSymbol：x` / `functionAbstract：y` 标签头 ⇒ 块内 symbol 重复。可在 `persistHighEntropyFunction` 落盘前剥离标签行（仅保留 `functionAbstract` 之后的代码体）。

---

# 2026-09-14 n8 第五轮（default 复验）：前向注入停摆的确定性根因 —— 「知识已入网却零收益」

## 轮次事实（先看这条，它决定了整轮实验是否可归因）
n6 交易轮（存档 `sz.301299`，会话 `a0dbe632a067`）第 2 笔「卖出 300股 @ ¥68.40」**委托越出当日区间 → `success:false` 未成交**，账户由 ¥106,108 → ¥102,493（-¥3,615，持仓未变，属市价波动）；两轮合计 **-¥4,565**。
而同一时刻 `layer_0/node_1.html` 的 content 已明文写着该规则：「`tradePrice` 是报价非成交价——fill 落在当日 [最低,最高] 内，越界 `success:false`，故报价须先裁剪进当日 K 线区间」。**同一错误在 8 分钟内重演。**

## 根因 R1：孤儿节点 —— L0 候选池由 `hyperparams.layers[0]` 驱动，而非磁盘目录
`src/index.ts:3378`
```ts
const l0Nodes = [];
for (let n = 0; n < net.hyperparams.layers[0]; n++) { ... }   // ← 只扫到 layers[0] 个槽位
```
三行实证（2026-09-14T16:27:35Z）：
- `l0_score_start` → `nodeCount: 1, nodes: [{id: "L0::node_0", hasContent: true}]` —— **L0::node_1 从未进入评分候选**
- `layer_0/node_1.html` 实际存在，`contentChars = 999`（交易游戏操作手册：/api/step 计数口径、session_id 位置、tradePrice 语义、打分口径）
- `hyperparams.json` 的 `layers` 实测两次采样为 `[1,2,1,0]` 与 `[1,0,2,1]`，**与磁盘 node 文件数（L0=2, L1=2, L2=2, L3=1）系统性不一致** ⇒ `layer_0/node_1`、`layer_1/node_0/1` 等均为**孤儿**（存在、有内容、不可达）

**结论：知识确实"入网"了，但它落在引擎从不扫描的地址上。** 这不是网络学习失效，是索引与磁盘脱节；把改善寄托在「空洞回收 / L0 只容域内 / meta_to_domain_ratio」之前，必须先修这条 —— 否则任何域内知识只要落在 index ≥ `layers[i]` 的槽位就永久沉默。

## 根因 R2：阈值断层 —— 已 `selected` 的节点被 `score < threshold` 挡在 `context` 之外
`propagate_done` 实测：`selectedIds: ["L0::node_0"]` 而 `contextIds: []` ⇒ **0 注入**。
`l0_exploration_applied.topAdjusted` 连续 7 次采样 vs `threshold = 0.2`：
`0.2138` ✅ / `0.1212` / `0.1602` / `0.0431` / `0.1001` / `0.1385` / `0.0995` —— **仅 1/7 越过阈值**。
分数链（`index.ts:3407`）：`llmScore*(1-0.15) + prScore*0.15` → 再被 `moe_route` 的 `gatedScores` 覆盖（`moe_route_done.enabled=false, maxExpertScore=0`）→ 再经 `applyExplorationPolicy`。
⇒ `selectedIds ≠ ∅` 但 `contextIds = ∅` 是**稳定的退化态**，不是偶发。判据上应确立不变式：**selected ⊆ context（选中即注入）**，或每层 top-1 保底注入；"选中判据"与"注入判据"不该用两个不同阈值各判一次。

## 决策经验（本轮要固化到交接的核心）
1. **「知识入网 ⇏ 收益改变」有三个必要条件，缺一即收益恒不变**：①知识落在引擎实际扫描的槽位（R1）②该节点分数越过注入阈值（R2）③注入文本在决策时被采纳。三者任一断裂，外部现象与「网络没学到」**完全同形**，本轮 -¥3,615 即此 —— 因此**不能以"收益没变"反推"训练无效"**，必须先证 `injectedCount ≥ 1`。
2. **派发纪律**：`injectedCount ≥ 1` 是派发交易验证轮的**前置门禁**。`0 context nodes injected` 的轮次是空转实验，改进效果不可归因，跑再多轮也只增加噪声。
3. **归因纪律**：未成交（或仅持仓存续）时 `portfolio.total_value` 的差额**全部是市价波动，不可归因于决策**；此类轮次记 `flat` 并标注 `unattributed`，严禁按盈利 +10 / 亏损 -10 打分 —— 本轮第 2 笔的 -¥3,615 本质是「执行失败 + 市价」，不是「判断错误」。
4. **验收纪律**：四判据须同时成立才判过 —— `injectedCount ≥ 1` ∧ `merge_action_lifted` ∧ `persisted symbols ⊆ 磁盘闭合块` ∧ `dangling 不增`。

## P0-0 修正意见（对「决策侧强制 clip tradePrice」的反对与替代）
直接对 `tradePrice` 静默 clip 会**把「限价可能打空」这一真实约束消掉**，等于删掉执行层的核心学习信号，并使「挂单价格质量」永远无法被训练。
替代（保留信号 + 可归因）：
- clip 后**必须同时回传** `requested_price` 与 `clipped: true`，让轨迹能把「报价失真」与「判断错误」分开；
- 或改为**服务端返回当日可成交区间提示**（`[low, high]` 在 `prompt` 中给出，不剧透走势方向），把「裁剪进区间」留给决策侧显式执行 —— 这样 clip 是可学行为，而非被系统偷偷代劳。
- 未成交分支统一置 `unattributed: true`，打分侧按经验 3 记 flat。

## 最小修复（按收益排序，均单点可测）
- **F1（最高，孤儿根因）**：L0/L1/...候选池改为**目录驱动**（`glob(layer_i/node_*.html)` 且 `readNodeContent 非空`），或启动/载入时**校正不变式** `layers[i] = max(声明值, 该层有内容的最大 index+1)`。验收：`l0_score_start.nodeCount ≥ 2` 且 `L0::node_1` 出现在 `nodes`。
- **F2（阈值断层）**：确立 `selected ⊆ context`；或对每层 top-1 保底注入。验收：`propagate_done.contextIds.length ≥ 1`。
- **F3**：`injectedCount` 写入每轮 trace，并在 `contextIds.length === 0` 时记 **error 级** `forward_injection_stalled`（本轮正是静默 0 注入跑了 7 个回合无人报警）。

## 附：本轮 P0/P1 验收结论（供下一轮对照）
- P0（块稳态存活）**FAIL**：本轮 2 个 persisted symbol（`volBreakoutHoldScore` 16:20:10、`engulfFalsifyTrim` 16:21:43，均落 L2::node_0）终态全网真块 = ∅。**蒸发机制非 merge**（nodesMerged 全 0），是 `writeNodeFunction` 的**单槽替换**（`html.replace(FUNCTION_BLOCK_RE,"")` + 末位追加，RE 无 `g` flag）。tsx 复现：persist(symA) ✓ → `writeNodeHtml`(content 重写) **保留 symA ✓（f69f38d 此项生效）** → persist(symB) ⇒ symA 消失、blocks=1。对照上文 P2「待修」，本轮独立确证。
- P1（跨层提升）**FAIL**：`merge_action_lifted` 本轮 0 次；`nodesMerged` 本轮全 0。另发现**零事件静默吞没**：16:20:47 三件套侧提出合法 merge（`L2::node_0 → L1::node_1`, Δ=1），结果 `nodesMerged=0 / nodesSkipped=0 / skipReasons=[]` —— 根因 `liftMergeNodes` 前置 `!tgtContent?.trim() → empty_content`（L1 两槽 content 皆空 ⇒ 提升到空槽位永远失败），且失败**只走 `onLog` 不写 monitor event**。→ 建议补 `merge_action_rejected{reason}` 事件，禁止只 log。
- **口径污染告警（方法论）**：`agent-022388`（pid 918，启动 23:18:17）**早于** ca826eb(00:01:09)/f69f38d(00:03:31) 且未重启，其 16:23:36 / 16:24:08 两轮旧代码 backward 写入了 `reason:"layer_jump"`（该字面仅存在于 `src/index.ts.bak-*`）并把工程域元知识灌进 `stock_alpha`。⇒ **验收必须记录 writer pid 与 extension 源 hash**，多进程共享 `_events.jsonl` + 网络目录时，否则会把未重启旧进程的写入误判为本轮回归。
