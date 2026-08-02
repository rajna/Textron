# 星象+A股 Textron RL 闭环测试流程

## 测试步骤

1. planner 调 `http://127.0.0.1:8780/kline/multi?symbol=sh000001&target={目标日}` 获取前30日K+18周K+10月K。
2. planner 调 `http://127.0.0.1:8769/horoscope3d?target={目标日}` 获取前日/当日/后一日星象。
3. 按 test.md 标准模板组装用例，用 coms_send 发 coder。明确三天星象用于判断能量变化方向；理由≤1000字。coder 禁止搜索、行情和网络工具。
4. coder 预测完成后，planner 才可调 `/kline/actual?symbol=sh000001&target={目标日}` 对答案。预测前严禁查看或泄漏实际行情。
5. planner 把实际结果反馈 coder；pi hook 自动用本次反馈+预测轮 HighEntropy 做 autoBackward。coder 深度复盘并回复（系统提示词强制要求 `<HighEntropy>` 块）。
6. planner 执行**审计分析**（步骤⑥）：
   - **5验证项**：先#4冷启动→再#1 DELETE检查+#2 name保留检查+#3 MERGE DUTY检查→最后#5完整闭环
   - **审计七层 [a-g]**：[a] semantic_backward.jsonl 检查reward+nodeUpdates/addNodes内容质量 [b] _events.jsonl 检查apply结果+skipReasons [c] Textron status 对比节点数变化 [d] cat 最新修改的.html节点 检查name是否保留旧关键词+content是否`|`合并而非全换 [e] 若status=failed/error→报告不自行修复 [f] 逐项对照七层门控（test.md第三节）检查有无阻断 [g] 检查LLM输出的node_actions是否含delete（禁止）+是否缺merge（应提未提）
   - **深度分析**：前向效率、反向更新、HighEntropy、reward、prompt质量、网络对任务的积极效应
   - **运行统计（每轮必查）**：从 `_events.jsonl` 统计本轮与前N轮对比——
     | 指标 | 查询方式 | 异常阈值 |
     |------|---------|---------|
     | 前向命中 | `grep -c 'l0_score_done.*status.*ok'` vs `l0_score_attempt_failed` | 失败率>50%→L0评分故障 |
     | 前向路径 | `grep propagate_done` 取 activatedIds 长度 | 连续>5轮0激活→路由失效 |
     | 反向触发 | `grep -c 'semantic_backward_apply'` 本轮增量 | 预测轮0触发→hook断裂 |
     | 节点更新 | apply事件中 nodesUpdated 累计 | 连续>10轮仅0-1更新→学习停滞 |
     | merge次数 | apply事件中 nodesMerged 累计 | 累计>20轮0 merge→MERGE DUTY失效 |
     | 新增节点 | apply事件中 nodesAdded 累计 | 单轮>5新增→节点膨胀 |
     | HighEntropy | `grep -c 'highentropy_captured'` vs `highentropy_missing` | 缺失率>80%→提取bug |
     | reward趋势 | `semantic_backward.jsonl` 最近20条reward均值 | 均值< -0.3→网络持续负反馈 |
     - **异常分析**：任一指标超阈值→立即定位根因（代码/prompt/模型行为）→写修复方案到 test.md 或直接改代码
7. **根据审计分析结果优化代码**：最高优先级优化立即改代码；需重启的写 `test.md` 通知 boss 重启；其余写 `todo.md`；将本轮预测、结果、正确率与审计结论写回 `test.md`。

## 关键约束

- 主AI/planner 不直接预测；必须由 coder 隔离预测。
- 禁止手动调用 Textron backward/init，禁止手改 ~/.textron 节点。
- feedback 到达 coder 时，hook 使用本次反馈和上一轮预测 HighEntropy 学习；不是使用反馈轮新 HighEntropy 训练本次轨迹。
