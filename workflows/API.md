# stock-trade 7860 API 速查（可复制的 curl 样例）

> 用途：**禁止**用 `find .` / `grep -rn` 在全盘探索 API 用法（会堵塞整轮 —— pi 的 bash 工具是同步等待）。
> 需要调用接口时，直接复制下面任一行并替换 `<SID>` 等占位符。
> 硬性约束 10：发给 agent 的指令应携带可复制的 curl 样例或本文件路径。

服务地址：`http://127.0.0.1:7860`

---

## 1. 探活
```bash
curl -s http://127.0.0.1:7860/api/health
# → {"ok":true,"sessions":1,"default_session_id":"4cf529337f29"}
```

## 2. 进入游戏（空 body = 不指定股票，自动 continue / 载入 active 存档）
```bash
curl -s -X POST http://127.0.0.1:7860/api/enter \
  -H 'Content-Type: application/json' -d '{}'
```

## 3. 取决策提示词（含当前价/涨跌幅/持仓/日周月K线）
```bash
curl -s "http://127.0.0.1:7860/api/prompt?session_id=<SID>"
# → {"ok":true,"data":{"prompt":"..."}} ；session_id 取 /api/health 的 default_session_id
```

## 4. 推进一日（成交 + 结算）
```bash
curl -s -X POST http://127.0.0.1:7860/api/step \
  -H 'Content-Type: application/json' \
  -d '{"session_id":"<SID>","decision":"持有","tradePrice":0,"tradeQuantity":0,"confidence":"中"}'
# → {"step":{"trade_result":{...},"portfolio":{总资产/浮盈亏/收益率}}}
# decision ∈ 买入 | 卖出 | 持有 | 不建仓 | 不建仓继续观察 | 不建仓更换股票
# confidence ∈ 高 | 中 | 低
# 非交易决策：tradePrice=0, tradeQuantity=0（价量必须给，不可省略）
# 买入 quantity 必须为 100 的整数倍
```

## 5. 查存档状态
```bash
curl -s http://127.0.0.1:7860/api/saves
# → {"saves":[{"file":...,"status":"active|ended","step_index":72,"stock":"sz.301299",...}]}
```

## 6. 载入存档 / 复活 / 结束
```bash
curl -s -X POST http://127.0.0.1:7860/api/load   -H 'Content-Type: application/json' -d '{"file":"session_sz.301299_latest.json"}'
curl -s -X POST http://127.0.0.1:7860/api/resume -H 'Content-Type: application/json' -d '{"file":"session_sz.301299_latest.json"}'
curl -s -X POST http://127.0.0.1:7860/api/finish -H 'Content-Type: application/json' -d '{"session_id":"<SID>"}'
# load/resume 若已有进行中的异股存档且未带 "force":true → 409
```

## 7. 交易质量评分（第十九轮新增；**需重启 7860 才生效**）
```bash
curl -s "http://127.0.0.1:7860/api/trade_quality?session_id=<SID>"            # 决策侧（禁含未来数据）
curl -s "http://127.0.0.1:7860/api/trade_quality?session_id=<SID>&review=1"   # 复盘侧（含 for_review 未来数据，禁入 prompt）
curl -s -X POST http://127.0.0.1:7860/api/trade_quality/config -H 'Content-Type: application/json' -d '{}'   # 权重/阈值增量合并
# → {"ok":true,"data":{"score":0-100,"dims":{...},"trades":[...],"evidence":[...],"llm_text":"..."}}
# 第十九轮实测：未重启 ⇒ 404（路由未注册）；workflow 第9步须 force=1 重试后以 step.portfolio 兜底，禁止跳过 API 凭记忆编分数
```

---

---

## 口径提醒（易错）
- **推进计数**（workflow n6 的「N 次」）= `/api/step` 的**实际调用次数**，从 **0** 起算；
  与存档 `step_index`（历史累计，含换股前）是**两套口径**，禁止用后者判满。
- 决策产出工具：`/Users/rama/textron-agent/workflows/trade.py`（`decide(ctx) -> TradeDecision`）。
- 禁止以任何手段获取**后续/未来**行情（含联网、后续 K 线）；决策只可用截止当日的数据。
