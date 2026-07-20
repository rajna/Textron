# Textron 星象+A股预测 RL 闭环 — 交接文档

> 生成时间：2026-07-17  
> 交接人：planner agent  
> 接收人：后续接手者

---

## 一、当前正在进行的任务

### 主任务：验证 Textron RL 闭环能否提升 coder 股票预测准确率

**机制**：主AI 组装测试用例 → coms_send 发给 coder 隔离预测 → 对答案 → 反馈 coder → Textron autoBackward 自动消费 reward 更新网络。

**当前进度**：
- 累计测试 34 组，正确率 52.9% (18/34)
- 最新：第10轮单例 06-02，预测错误（DOWN→实际 UP），已完成反馈+backward 审计
- 网络：`astro_stock_prediction` [11,40,41] = 92节点
- 下批起点：06-11（需确保前5日不含已测日期的答案，间距≥7交易日）

**正确率趋势**：

| 批次 | 正确率 |
|------|--------|
| 第1-2轮 (03月) | 50% |
| 第5批 (05-07月) | 66.7% |
| 第8批 (06月上中旬) | 80% |
| 第9批 (06月下旬) | 60% |
| 第10轮 (单例06-02) | 0% |

---

## 二、已完成重点工作

### 2.1 架构搭建
- 数据服务部署：K线 `127.0.0.1:8768/kline` + 星象 `127.0.0.1:8769/horoscopeFeature`
- Agent 重启服务：`agent_restart_service.py` 端口 8770
- coder agent 通过 `coms_send` 隔离预测，禁止搜索/行情工具

### 2.2 Bug 修复（index.ts，需重启 pi 生效）

| 修复项 | 描述 | 状态 |
|--------|------|------|
| messages 变量声明前引用 | `Cannot access 'messages' before initialization` → backward 全跳过 | ✅ 已修 |
| edgeUpdate 未定义 | 3处 `edgeUpdate` → `bwResult` | ✅ 已修 |
| catch{} 空块 | 改为 console.error + 旁路日志 | ✅ 已修 |
| **agent_end 外层 try/catch** | 防止 hook 异常静默崩 | ✅ 已修，待重启 |
| **add_nodes content 空 fallback** | LLM 只返回 name 不返回 content → content=""→拒绝。改为 `n?.content \|\| n?.context \|\| n?.name` | ✅ 已修，待重启 |

### 2.3 Prompt 优化（index.ts，需重启 pi 生效）

| 优化项 | 描述 |
|--------|------|
| Rule 1: NODE_UPDATE FIRST | 强制先找已有节点更新，仅全新概念才 add |
| Rule 2: 重叠>30%→更新 | 原来>50%→新增，改为更新已有 |
| Rule 5: TASK_FAMILY GATE | 领域外任务→空输出，防噪声节点 |
| Rule 11: NODE INSPECTION | 去掉死板百分比阈值，AI 自主分析两类节点关系→merge/delete/distill |

### 2.4 第10轮 backward 审计

已验证完整闭环：coms_send反馈 → coder返回HighEntropy → backward消费 → L0::node_0/L1::node_4更新 + 2新节点。详见 test.md「第10轮 backward 质量分析」。

---

## 三、待处理事项（按优先级）

### 🔴 P0 — 紧急
1. **重启 pi** 使 index.ts 修改生效（agent_end try/catch、content fallback、prompt 优化）
2. **nodeAdd HTML 内容空 bug**：nodeAdd=2 但 node_38/node_39 的 `<content>` 为空。已修 content fallback，重启后验证

### 🟡 P1 — 重要
3. **merge/delete 从未触发 (0/54)**：LLM 看到 RELATED 节点但不产出 nodeActions。已修改 Rule11 为自主分析模式，重启后观察首次 merge/delete
4. **node_updates 太少 (5.6%)**：大量 add_nodes 导致节点膨胀。Rule1 已改为 NODE_UPDATE FIRST，重启后验证
5. **reward=0 占比 51.9%**：半数 backward 无信号。部分是因为无反馈的"继续"类消息触发 backward。需确保每轮测试都走完反馈闭环

### 🟢 P2 — 改善
6. **RELATED 节点查找覆盖率低 (24%)**：`findSimilarKnowledgeNode` 阈值 0.40，找到的相似节点偏少
7. **agent_end 可能停止触发**：上一次 04:10 后 agent_end 停止，需重启后监控 stderr 的 `[textron] agent_end FIRED`
8. **连续日期批量预测会泄露答案**：后续案例前5日含前面案例的次日K线。规范：单例或间距≥7交易日

---

## 四、关键决策和注意事项

### 铁律
- ❌ **禁止手动调用 `Textron(action='backward')`** — backward 是自动触发
- ❌ **禁止手动编辑 `~/.textron/` 下文件** — 网络由 backward 自动治理
- ❌ **禁止 coder 使用搜索/行情/网络工具** — 隔离预测

### backward 触发机制
```
coms_send 反馈给 coder → coder 返回 HighEntropy → 自动触发 backward
```
**不是**等下轮用户输入才触发。

### 审计标准流程（步骤⑥，只读）
```
[a] tail -5 semantic_backward.jsonl — 检查 reward 和 nodeUpdates/addNodes
[b] grep semantic_backward _events.jsonl — 检查 apply 结果
[c] Textron status — 对比节点数变化
[d] cat 最新修改的 .html 节点 — 检查内容是否误写空
[e] 若 status=failed/error → 报告，不自行修复
```

### 端口注意
- **必须用 `127.0.0.1` (IPv4)** 访问 8768/8769，`localhost` 走 IPv6 被 Textron Monitor 拦截
- 启动数据服务：
```bash
cd /Users/rama/Documents/agi_nanobot/nanobot
nohup python3 nanobot/skills/horoscope-fetcher/scripts/horoscope_service.py --port 8769 > /tmp/horoscope_service.log 2>&1 &
nohup python3 nanobot/skills/stock-trade/scripts/stock_service.py --port 8768 > /tmp/stock_service.log 2>&1 &
```

### 重启方式
```bash
curl -X POST http://localhost:8770/restart/planner
curl -X POST http://localhost:8770/restart/coder
```

重启后检查：
1. stderr 是否有 `[textron] agent_end FIRED`
2. `~/.textron/_last_state.json` 的 `at` 是否更新
3. `assistantHighEntropy` 是否非空

---

## 五、Agent 协作状态

| Agent | 状态 | 用途 |
|-------|------|------|
| **planner** (主AI) | PID 变化，需查 | 取数据、组装用例、对答案、发反馈、审计日志 |
| **coder** | 在线 (deepseek-v4-pro) | 隔离预测，接收 coms_send，返回 HighEntropy |
| **boss** | 在线 (deepseek-v4-pro) | 管理协调 |

### coder 协作规范
- 发预测请求：单例格式，含前5日K线+当日星象，不含当日行情
- 接收预测反馈：含对错结果+错误根因分析
- coder 的 HighEntropy 会被 Textron 捕获作为 reward 信号

---

## 六、关键文件路径

| 文件 | 路径 |
|------|------|
| 测试记录 | `/Users/rama/textron-agent/test.md` |
| Textron 核心 | `/Users/rama/textron-agent/src/index.ts` |
| 网络目录 | `~/.textron/astro_stock_prediction/` |
| backward 日志 | `~/.textron/astro_stock_prediction/_sb_logs/semantic_backward.jsonl` |
| 事件日志 | `~/.textron/_events.jsonl` |
| 状态持久化 | `~/.textron/_last_state.json` |
| 节点文件 | `~/.textron/astro_stock_prediction/layer_N/node_X.html` |
