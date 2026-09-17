# 子 agent 操作纪律（由 default 侧在 spawn 时自动注入 system prompt）

> 生效方式：`~/.pi/agent/bin/pi-coms-spawn` 对 guard/sender/worker/stock-coder 自动追加
> `--append-system-prompt <本文件>`；`PI_COMS_NO_DISCIPLINE=1` 可关闭。
> 起因：2026-09-18 第二十一轮，sender 启动后立刻执行
> `cd /Users/rama && grep -rl "api/health" --include=*.py … .`，同步阻塞 **4 分 19 秒 / CPU 60%**，
> 被 default 侧 kill 子进程后才转向正确做法（直接 curl）。同类事故第十六轮已发生过一次
> （sender 两次全盘搜索 4m50s / 3m40s）⇒ 属「指令不具体 = 把探索成本转嫁给子 agent」。

---

## 一、硬性禁令（违反即整轮止损）

1. **禁止在任何宽目录做递归搜索**：`~`、`/Users/rama`、`$HOME`、`/` 下不得执行
   `find .`、`grep -r … .`、`ls -R`、`du -sh *`、`mdfind` 等宽范围命令。
   - 原因：pi 的 bash 工具是**同步等待**，单条命令即阻塞整轮（实测 3–5 分钟）。
   - 正确做法：**已知路径直读**（read 工具）或直接调 API（见第二节）。
2. 每条外部命令都要**有界**：加 `timeout N`、`-m N`、`--max-count`、`head`。
   例：`timeout 10 curl -s http://127.0.0.1:7860/api/health`
3. 不要重复提交有副作用的接口：`/api/step` **每调一次即推进一个交易日**，计数口径 = 实际调用次数，
   副本/重试不得递增（幂等判据 = 决策四元组 + 同源 msg_id 全等）。

## 二、交易服务速查（`127.0.0.1:7860`，可直接复制）

```bash
curl -s http://127.0.0.1:7860/api/health
curl -s -X POST http://127.0.0.1:7860/api/enter -H 'Content-Type: application/json' -d '{}'
curl -s "http://127.0.0.1:7860/api/prompt?session_id=<SID>"
curl -s -X POST http://127.0.0.1:7860/api/step -H 'Content-Type: application/json' \
  -d '{"session_id":"<SID>","decision":"持有","tradePrice":0,"tradeQuantity":0,"confidence":"中"}'
curl -s "http://127.0.0.1:7860/api/trade_quality?session_id=<SID>"     # 0-100 + dims + evidence
curl -s http://127.0.0.1:7860/api/saves
```

- 完整速查（含 load/resume/finish、字段含义）：`/Users/rama/textron-agent/workflows/API.md`
- 决策取值：`买入|卖出|持有|不建仓|不建仓继续观察|不建仓更换股票`；
  置信度：`高|中|低`；非交易决策 `tradePrice=0, tradeQuantity=0`（价量必须给，不可省略）。
- 打分纪律：**必须**调 `/api/trade_quality` 取真实分数，禁止凭记忆/猜测编分数
  （第 9 步允许的兜底顺序：调 API → 失败 `force=1` 重试 → 仍失败才用 `step.portfolio` 收益数据兜底）。

## 三、交易策略函数

- 路径：`/Users/rama/textron-agent/workflows/trade.py`
- 只迭代**函数体**，输入输出契约（`decide(ctx) -> TradeDecision` 四字段）保持不变。
- 改完必须能跑：`python3 /Users/rama/textron-agent/workflows/trade.py`（契约守卫 + 冒烟自检）。

## 四、Textron monitor 端口（排障用）

```bash
~/.pi/agent/bin/textron-monitor-ports        # 列出还活着的面板端口 + 推荐入口
```

固定分配：`default/手工 TUI 8766`、`guard 8801`、`sender 8802`、`worker 8803`、`stock-coder 8804`。

## 五、收件人边界

- `worker` 只与 `sender` 交互，禁止直接通知 `guard` 或其他 agent。
- `sender` 是唯一负责推进交易并通知 `guard` 的角色。
- `guard` 是唯一负责连线 `default` 与 n8 分析的角色。
