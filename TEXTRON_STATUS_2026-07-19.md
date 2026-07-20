# Textron 最新状态

> 快照时间：2026-07-19 00:33–00:36 +0800  
> 项目：`/Users/rama/textron-agent`  
> 网络：`astro_stock_prediction`  
> 说明：本文区分“源代码已实现”“进程已加载”“已有新运行样本验证”三个层级，避免把历史日志或单元测试误当成当前线上事实。

## 1. 当前结论

1. **路由 gate 保持原样**：`index.ts` 仍使用 `allowBestEffort: true`，本轮没有修改 taskFamily 路由策略。
2. **HighEntropy 源码修复已完成**：最终捕获改为在 `agent_end` 从 `event.messages` 倒序读取最后一个有效 assistant 晶体，流式 buffer 仅作为兜底；不再在每个 `message_end` 统计 missing。
3. **L0 打分稳定性修复已完成**：支持 JSON、自然语言包围 JSON、逐行评分协议；默认仅进行一次 25 秒远端尝试，失败后立即使用本地相关度，旧慢速 fallback 仅在显式环境变量下启用。
4. **路径防锁定算法已完成**：L0/L1/L2 均加入任务相关性门控、真实激活频率衰减和有界探索；完全无关节点不会因探索奖励进入候选路径。
5. **后台 boss/planner/coder 已重启并在线**，但当前交互式 Pi 主进程仍是修改前启动的旧进程，因此本会话日志仍可能出现旧 action。新逻辑尚需在已加载新 extension 的进程中产生至少一轮 forward/agent_end 样本后完成运行时验收。
6. **禁止手动清理、删除或直接篡改网络节点**；污染治理继续通过 forward 选择策略、reward、backward 合并/降权自动完成。

## 2. 网络快照

来源：`~/.textron/astro_stock_prediction/hyperparams.json`

| 项目 | 当前值 |
|---|---:|
| 创建时间 | `2026-07-15T22:28:37.310Z` |
| 最近网络更新时间 | `2026-07-18T16:33:09.203Z` |
| L0 节点 | 10 |
| L1 节点 | 28 |
| L2 节点 | 53 |
| 节点总数 | **91** |
| threshold | `0.08` |
| learningRate | `0.12` |

当前结构为 `10 / 28 / 53`。与此前阶段的 `10 / 30 / 56` 相比，L1/L2 已出现压缩，说明 backward 的 merge/delete 治理仍在工作。

### 2.1 现存网络风险

`astro_stock_prediction` 中仍混有以下类别：

- A 股价格、K 线和星象预测知识；
- Textron 诊断与运行约束；
- agent 重启和 planner/coder 协作经验；
- nbeat/元技巧文件处理经验；
- 其他历史任务残留。

这说明网络尚未实现严格领域纯化。由于用户要求路由 gate 保持原样，当前 `allowBestEffort: true` 仍可能把非股票任务送入唯一网络；本轮仅治理网络内部选择与学习，不改变该路由行为。

## 3. HighEntropy 状态

### 3.1 已确认根因

旧统计被两层问题放大：

1. Pi 的一个 agent run 内可能有多个 `message_end`，工具调用中间 assistant 回合通常没有最终 `<HighEntropy>`；旧实现把这些中间回合全部记为 missing。
2. `agent_end` 官方事件已提供完整 `event.messages`，旧实现却忽略 `_event`，只读取可能尚未收齐最终文本的流式 buffer，导致 session 中明明存在 XML，仍被记为 missing。

历史数据按真正的 agent 终态重算后约为：

- captured：179
- missing：228
- 实际捕获率：约 44%

这比旧事件口径估出的约 6% 高很多，但仍说明模型有相当比例的最终回答没有生成有效晶体。

### 3.2 当前实现

相关文件：

- `src/index.ts`
- `src/highentropy.ts`
- `src/test_highentropy.ts`

最终提取优先级：

1. `agent_end.event.messages` 中倒序找到的最后一个有效 assistant HighEntropy；
2. `message_update` 流式捕获结果；
3. 合并最终 assistant 文本后的 buffer 解析结果。

只有三者都失败时，才记录一次：

```text
highentropy_missing_at_agent_end
```

诊断字段包括：

- `hasTag`
- `reason`
- `eventMessageCount`
- `finalAssistantChars`
- `assistantBufferChars`
- `tailPreview`

### 3.3 测试结果

`src/test_highentropy.ts`：**9/9 通过**。

覆盖：

- 标准多行 XML；
- 多行 Content；
- JSON 形式晶体；
- 无空格中文内容；
- `agent_end.event.messages` 最终 assistant 兜底；
- 忽略中间 assistant 和 tool result。

### 3.4 当前运行时边界

最新事件流仍出现：

```text
highentropy_missing_at_message_end
```

但当前源代码已不存在该字符串。定位结果：

- 当前交互式 Pi 进程 PID `53630` 启动于 `2026-07-18 19:58:44 +0800`；
- `src/index.ts` 最近修改于 `2026-07-19 00:25:57 +0800`；
- 因而当前会话仍在使用修改前加载的 extension 内存实例。

所以目前可以确认的是“源码和后台新进程已部署”，不能把当前旧会话产生的事件当成新实现失败。需要当前交互进程 reload/restart 后，再按 `agent_end` 新口径验收。

## 4. L0 打分状态

### 4.1 旧问题

旧 L0 评分要求模型返回纯 JSON；模型经常先输出自然语言，例如：

```text
The user task ...
```

随后触发 JSON 解析失败，并串行尝试多个 provider 参数组合，最差可造成约 100 秒以上的首 token 阻塞。

### 4.2 当前实现

相关文件：

- `src/scoring_policy.ts`
- `src/index.ts`
- `src/test_scoring_policy.ts`

解析器支持：

```json
{"L0::node_0": 0.8}
```

```text
Here are scores:
{"L0::node_0": 0.8}
```

```text
L0::node_0=0.80
node_1: 0.25
node_2 0.00
```

默认调用策略：

- 一次远端评分尝试；
- timeout：25 秒；
- tokens：384；
- temperature：0；
- 失败后立即使用本地中英混合词项相关度；
- 只有 `TEXTRON_L0_SLOW_FALLBACK=1` 才启用旧慢速 fallback。

新增事件：

- `l0_score_local_fallback`
- `l0_exploration_applied`

### 4.3 测试和观测

`src/test_scoring_policy.ts`：**8/8 通过**。

最近旧/混合运行日志中的几次 L0 start→done 约为 6–11 秒，但由于当前交互式进程仍是旧实例，这些数据不能作为新容错路径的最终验收结果。后台新进程尚未产生足够 forward 样本。

## 5. 路径反复锁定状态

### 5.1 已实现算法

#### L0

`applyExplorationPolicy()` 综合：

- LLM 分值；
- 本地任务相关度；
- 节点 reliability；
- 激活频率衰减；
- 仅对“新且相关”的节点给予最大 `0.12` 的 bounded bonus。

无本地或 LLM 相关证据的节点保持 0，不会因为低频或随机探索被抬高。

#### L1/L2

`rankLayerWithExploration()` 只允许达到该层峰值 **20% 以上**的候选参与探索排序，然后加入：

- 高频衰减；
- reliability；
- 新相关节点的有限 bonus。

低相关节点不能靠探索奖励越级进入 top-k。

#### PageRank

PageRank 权重已降低为辅助项，且 cold-start rescue 必须有词项相关证据，避免中心性凭空制造任务相关性。

### 5.2 激活频率统计

`_node_stats.json` 新 schema 支持：

```json
{
  "activations": 12,
  "success": 7,
  "failure": 3
}
```

每次 forward 选中节点即执行 `activations++`，包括没有强 reward 的轮次。旧数据没有 `activations` 时，运行时回退为：

```text
success + failure
```

当前磁盘统计：

- 记录节点：50
- 已有显式 `activations` 的记录：0
- 显式 activation 总数：0

这意味着新字段写入代码已经部署，但尚未由加载新代码的 forward 样本真正落盘。现在使用的是旧数据兼容值，而不是声称已经拥有完整历史激活频率。

按 `success + failure` 代理值，当前部分高频节点为：

| 节点 | 历史代理次数 |
|---|---:|
| `L0::node_5` | 41 |
| `L1::node_50` | 34 |
| `L2::node_0` | 33 |
| `L0::node_4` | 20 |
| `L1::node_6` | 19 |
| `L0::node_8` | 17 |
| `L0::node_6` | 15 |
| `L1::node_12` | 15 |

注意：该代理只覆盖强成功/失败信号，不等价于真实历史选中次数。

## 6. 运行进程和部署状态

外部重启服务：`http://127.0.0.1:8770`

| Agent | 状态 | PID | Session ID |
|---|---|---:|---|
| boss | running | 71191 | `472401ed7a18b46c4a29054ecc6710ec` |
| planner | running | 71156 | `49f0db565371b8bd78cc264d50a3b004` |
| coder | running | 71131 | `f6bca46458e08e95fd12b183158c0a19` |

Extension 链接：

```text
~/.pi/agent/extensions/textron/index.ts
  -> /Users/rama/textron-agent/src/index.ts
~/.pi/agent/extensions/textron/highentropy.ts
  -> /Users/rama/textron-agent/src/highentropy.ts
~/.pi/agent/extensions/textron/scoring_policy.ts
  -> /Users/rama/textron-agent/src/scoring_policy.ts
~/.pi/agent/extensions/textron/monitor.html
  -> /Users/rama/textron-agent/src/monitor.html
```

Monitor/API 探测：

- `8766/api/state`：HTTP 200
- `8767/api/state`：HTTP 200
- `8768/api/state`：HTTP 404

因此当前可确认有两个 Textron Monitor API 实例正常响应；不能把 8768 写成已提供同一 API。

## 7. 测试总览

| 测试 | 结果 |
|---|---:|
| `test_scoring_policy.ts` | 8/8 通过 |
| `test_highentropy.ts` | 9/9 通过 |
| `index.ts` 语法检查 | 通过 |
| `git diff --check` | 通过 |
| `test_learning_policy.ts` | 14/16 通过，2 项已知旧失败 |

两项已知失败：

- `similar correction merges into existing node`
- `merge target is existing similar node`

实际策略在 similarity `0.50` 时返回 add，而默认 merge threshold 是 `0.55`。该问题属于既有 merge-first 阈值行为，不是本次 HighEntropy/L0/路径探索修改引入。

## 8. Git 工作区状态

当前分支：`main`

相关未提交文件：

```text
 M src/index.ts
 M src/learning_policy.ts
 M src/monitor.html
 M src/test_learning_policy.ts
?? src/highentropy.ts
?? src/scoring_policy.ts
?? src/test_highentropy.ts
?? src/test_scoring_policy.ts
```

仓库中还有其他既有改动。后续操作不得回滚、覆盖或清理无关工作区内容。

## 9. 下一步运行时验收

以下项目尚需新进程真实样本确认：

1. reload/restart 当前交互式 Pi，使其加载修改后的 extension；
2. 执行一个明确相关的股票任务，确认：
   - L0 远端失败时 25 秒内进入 `l0_score_local_fallback`；
   - 出现 `l0_exploration_applied`；
   - `_node_stats.json` 开始写入显式 `activations`；
3. 完成一个带 `<HighEntropy>` 的最终回答，确认：
   - `agent_end` 的 `hasHighEntropy=true`；
   - 不再产生新的 `highentropy_missing_at_message_end`；
4. 连续采样多类任务，比较修复前后：
   - 高频节点占比；
   - 路径去重后的多样性；
   - 被选节点与任务的词项/语义相关性；
   - 下游边是否仍集中到固定 L1/L2 节点；
5. 继续让 backward 自动合并、降权污染节点，禁止人工删除节点或重建网络。

## 10. 本状态文件的数据源

- `/Users/rama/textron-agent/src/index.ts`
- `/Users/rama/textron-agent/src/highentropy.ts`
- `/Users/rama/textron-agent/src/scoring_policy.ts`
- `/Users/rama/textron-agent/src/test_highentropy.ts`
- `/Users/rama/textron-agent/src/test_scoring_policy.ts`
- `/Users/rama/textron-agent/src/test_learning_policy.ts`
- `~/.textron/_events.jsonl`
- `~/.textron/astro_stock_prediction/hyperparams.json`
- `~/.textron/astro_stock_prediction/_node_stats.json`
- `~/.textron/astro_stock_prediction/_sb_logs/semantic_backward.jsonl`
- 外部重启服务 `/status`
- Textron Monitor `/api/state`
