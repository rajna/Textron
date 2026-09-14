# 星象+A股 Textron RL 闭环测试流程

## 测试步骤

1. planner 采样 **4 个交易日（2022/2023/2024/2025 各 1 天）**，逐日调 `http://127.0.0.1:8780/kline/multi?symbol=sh000001&target={目标日}` 获取前30日K+18周K+10月K，调 `http://127.0.0.1:8769/horoscope3d?target={目标日}` 获取前日/当日/后一日星象。
2. 按 test.md 标准模板组装用例，**一条 coms_send 打包 4 个 case** 发 coder（每 case 含完整K线+三天星象）。coder 逐 case 输出方向+置信度+理由（≤500字）。coder 禁止搜索、行情和网络工具。
3. coder 全部预测完成后，planner 才逐 case 调 `/kline/actual?symbol=sh000001&target={目标日}` 对答案。预测前严禁查看或泄漏实际行情。
4. planner 把 4 个 case 的实际结果**一条反馈消息**发给 coder（含原始K线+星象上下文，供复盘引用）；pi hook 自动用本次反馈+预测轮 HighEntropy 做 autoBackward。coder 深度复盘并回复（必须输出 `<HighEntropy>` 块，Technique 压缩根因+修正规则）。
5. planner 执行**审计分析**：
   - **5验证项**：先#4冷启动→再#1 DELETE检查+#2 name保留检查+#3 MERGE DUTY检查→最后#5完整闭环
   - **审计七层 [a-g]**：[a] semantic_backward.jsonl 检查reward+nodeUpdates/addNodes内容质量 [b] _events.jsonl 检查apply结果+skipReasons [c] Textron status 对比节点数变化 [d] cat 最新修改的.html节点 检查name是否保留旧关键词+content是否`|`合并而非全换 [e] 若status=failed/error→报告不自行修复 [f] 逐项对照七层门控（test.md第三节）检查有无阻断 [g] 检查node_actions是否含delete（禁止）+是否缺merge（应提未提）
   - **运行统计（每轮必查）**：前向命中失败率>50%→L0评分故障；连续>5轮0激活→路由失效；预测轮0次backward→hook断裂；连续>10轮仅0-1更新→学习停滞；累计>20轮0 merge→MERGE失效；单轮>5新增→节点膨胀；HighEntropy缺失率>80%→提取bug；最近20条reward均值<-0.3→持续负反馈
   - **异常分析**：任一指标超阈值→立即定位根因→写修复方案到 test.md
6. **改进闭环（审计不是终点）**：审计必须产出三件套——①洞见（现象→根因→改进方案→预期指标变化）②执行（P0 planner 直接改代码；需重启写 test.md 通知 boss；实验性改动先基线后上线）③下轮验证断言。无改进产出的轮次在 test.md 标记"空转轮"并说明原因。将本轮预测、结果、判后准确率与审计结论写回 `test.md`。

## 系统修改与重启通知协议（boss→planner）

每次 boss 修改系统代码后，必须完成三步骤：
1. **交接文档**：HANDOVER.md 记录修改内容、影响范围、已知问题
2. **验证清单**：列出下次需测试的功能点，确保障碍已解除（写入 HANDOVER.md 重启验证表）
3. **通知必达**：`coms_send(target=planner)` 直连发送，通知必须包含：身份陈述（planner/coder 角色）、三文件路径（HANDOVER.md / test.md / workflow.md）、变更摘要、验证指令

**关键顺序原则**：收到新实验/改动方案时——先零改动重启 planner+coder，按交接文档跑 N 轮基线测试，观察实际行为后再列改进清单。方案到手即改代码 = AB 对照缺对照组，后续任何改动效果不可归因。**基线轮数据是一切实验改动的对照锚点，先跑基线再谈改进。**

## 关键约束

- 主AI/planner 不直接预测；必须由 coder 隔离预测。
- 禁止手动调用 Textron backward/init，禁止手改 ~/.textron 节点。
- feedback 到达 coder 时，hook 使用本次反馈和上一轮预测 HighEntropy 学习；不是使用反馈轮新 HighEntropy 训练本次轨迹。
- 滚动正确率不是学习目标：每轮既训练又测试，结构上必然先错后学。学习效果用冻结网络 holdout 回测或领先指标（规则复用率/同类错误复发率/判后准确率）衡量。
