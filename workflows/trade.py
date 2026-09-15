#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
trade.py — 交易决策函数（契约注释 / 实现待填写）
================================================================================

本文件只定义**契约与注释**，不包含实现。函数体会在后续迭代中被反复
验证、抽象、更新——因此这里固定"接口形状"，把"怎么算"留给实现者。

--------------------------------------------------------------------------------
一、函数签名
--------------------------------------------------------------------------------
    decide(ctx: TradeContext) -> TradeDecision

    · 纯函数：同 ctx 应得同输出（便于回放验证与归因）
    · 只消费传入的 ctx：不改全局状态、不依赖外部 IO
    · 输出恒定 4 个契约字段（可附加解释字段，下游只消费那 4 个）

--------------------------------------------------------------------------------
二、输入 INPUT
--------------------------------------------------------------------------------
    ctx = {
        "kline":   {"daily": [...], "weekly": [...], "monthly": [...]},
        "account": {...},
        "feedback": str | None,     # 可选：上一轮反馈
        "memory":   dict | None,    # 可选：外部沉淀的经验 / 函数块引用
    }

    1) kline —— K 线信息，三个周期同构，各自是一串 bar：
         {
           "date":   str,    # 日K "2025-04-11" / 周K "2025-W15" / 月K "2025-04"
           "open":   float,
           "high":   float,
           "low":    float,
           "close":  float,
           "volume": float,  # 成交量（股）
           "amount": float,  # 成交额（元，可选）
         }
       · daily   : 日 K —— 粒度最细，用于量能、形态、买卖点
       · weekly  : 周 K —— 中期趋势与周线支撑/压力
       · monthly : 月 K —— 大级别位置与长期结构
       三周期可只提供其中任意子集；缺哪个周期、如何聚合，由实现决定。

    2) account —— 交易账户状态：
         {
           "total_value":   float,          # 总资产 = cash + 持仓市值
           "cash":          float,          # 可用现金
           "position":      dict | None,    # 空仓为 None，否则见下
           "base_cash":     float,          # 收益率基准（本局 / 会话级）
           "total_return":  float,          # 本局收益率 %
           "cum_return":    float,          # 累计收益率 %
           "step_index":    int,            # 当前步数
           "current_date":  str,            # 当前日期
           "current_stock": str,            # 当前标的代码
           "equity_curve":  list[dict],     # 收益率历史采样点（可选）
         }
       其中 position：
         {
           "quantity":      int,            # 持有股数
           "cost_price":    float,          # 成本价
           "market_price":  float,          # 最新价
           "market_value":  float,          # 持仓市值 = quantity * market_price
           "unrealized_pnl": float,         # 浮动盈亏
         }

--------------------------------------------------------------------------------
三、输出 OUTPUT
--------------------------------------------------------------------------------
    {
      "decision":      买入 | 卖出 | 持有 | 不建仓 | 不建仓继续观察 | 不建仓更换股票,
      "tradePrice":    float,   # 买入/卖出的精确价格（不是价格范围）；非交易决策填 0.0
      "tradeQuantity": int,     # 买入/卖出的精确数量（不是范围）；非交易决策填 0
      "confidence":    高 | 中 | 低,
    }

    说明：
      · 字段名与枚举取值是稳定 ABI，实现可整体替换而调用方不变。
      · 可附加 reasoning / featureSnapshot 等字段携带决策依据（供复盘与审计），
        但下游只消费上面 4 个契约字段。

--------------------------------------------------------------------------------
四、实现层可以放什么（本文件的迭代空间，无预设）
--------------------------------------------------------------------------------
    · LLM 调用        ：让模型基于 K 线与账户给出候选决策与理由
    · 量化分析        ：量价关系、动量、均值回复、结构位
    · 因子分析        ：多因子打分与加权
    · 波动率建模      ：ATR / 标准差 / 波动率目标仓位
    · 黄金分割 / 形态 ：斐波那契回撤、形态识别、pattern matching
    · 学习器          ：统计模型或神经网络，只要能吃输入吐输出
    以上都属实现自由；替换时只需保持 decide() 的签名与返回结构。

--------------------------------------------------------------------------------
五、填写实现时的建议性质
--------------------------------------------------------------------------------
    1. 可回放：只依赖传入的 ctx（同输入 → 同输出），便于离线复算与对比。
    2. 可解释：用附加字段记录本次决策依赖的关键量，便于事后归因。
    3. 结构合法：返回前保证决策值与置信度在枚举内、交易字段有值且为精确值
       （非交易决策的价量应为 0）。

================================================================================
"""

from __future__ import annotations

from typing import Any, Dict, Literal, Optional, Sequence, TypedDict

# ══════════════════════════════════════════════════════════════════════════════
# 契约常量：决策与置信度的合法取值
# ══════════════════════════════════════════════════════════════════════════════

DECISION_BUY = "买入"
DECISION_SELL = "卖出"
DECISION_HOLD = "持有"
DECISION_NO_POSITION = "不建仓"
DECISION_WATCH = "不建仓继续观察"
DECISION_SWITCH = "不建仓更换股票"

DECISIONS: tuple = (
    DECISION_BUY,
    DECISION_SELL,
    DECISION_HOLD,
    DECISION_NO_POSITION,
    DECISION_WATCH,
    DECISION_SWITCH,
)

CONF_HIGH = "高"
CONF_MID = "中"
CONF_LOW = "低"

CONFIDENCES: tuple = (CONF_HIGH, CONF_MID, CONF_LOW)


# ══════════════════════════════════════════════════════════════════════════════
# 契约类型（仅声明，供实现与调用方对齐字段名）
# ══════════════════════════════════════════════════════════════════════════════

class KLineBar(TypedDict, total=False):
    """单根 K 线。"""
    date: str
    open: float
    high: float
    low: float
    close: float
    volume: float
    amount: float


class KLineSeries(TypedDict, total=False):
    """K 线信息（日 / 周 / 月）。"""
    daily: Sequence[KLineBar]
    weekly: Sequence[KLineBar]
    monthly: Sequence[KLineBar]


class Position(TypedDict, total=False):
    """持仓（空仓时 account["position"] 为 None）。"""
    quantity: int
    cost_price: float
    market_price: float
    market_value: float
    unrealized_pnl: float


class AccountState(TypedDict, total=False):
    """交易账户状态信息。"""
    total_value: float
    cash: float
    position: Optional[Position]
    base_cash: float
    total_return: float
    cum_return: float
    step_index: int
    current_date: str
    current_stock: str
    equity_curve: Sequence[Dict[str, Any]]


class TradeContext(TypedDict, total=False):
    """decide() 的输入。"""
    kline: KLineSeries
    account: AccountState
    feedback: Optional[str]
    memory: Optional[Dict[str, Any]]


class TradeDecision(TypedDict, total=False):
    """decide() 的输出：4 个契约字段 + 可选附加字段。"""
    decision: Literal["买入", "卖出", "持有", "不建仓", "不建仓继续观察", "不建仓更换股票"]
    tradePrice: float
    tradeQuantity: int
    confidence: Literal["高", "中", "低"]
    reasoning: str                      # 可选：决策依据（下游不消费）
    featureSnapshot: Dict[str, Any]     # 可选：本次依赖的关键量（下游不消费）


# ══════════════════════════════════════════════════════════════════════════════
# 主函数（实现待填写）
# ══════════════════════════════════════════════════════════════════════════════

_CFG: Dict[str, float] = {
    "risk_budget_pct": 1.5,   # 单笔风险预算（占总资产 %）→ 结构性止损距离反推允许仓位
    "deploy_floor": 0.35,     # edge>0 时的最低目标仓位：机会成本定价下禁止"零增量持有"
    "pi_max": 0.60,           # 单标的最大仓位
    "buy_band": 0.02,         # 目标仓位 > 当前 +2% → 补仓
    "sell_band": 0.12,        # 目标仓位 < 当前 -12% → 减仓
    "stop_loss_pct": -8.0,    # 成本价下方硬止损线（%）
    "atr_window": 8,
}


def _clip(x: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, x))


def _atr(daily: Sequence[KLineBar], window: int = 8) -> float:
    """真实波幅均值（波动率代理，纯计算）。"""
    if len(daily) < 2:
        return 0.0
    trs = []
    for i in range(1, len(daily)):
        h = float(daily[i].get("high") or 0.0)
        lo_ = float(daily[i].get("low") or 0.0)
        pc = float(daily[i - 1].get("close") or 0.0)
        trs.append(max(h - lo_, abs(h - pc), abs(pc - lo_)))
    w = trs[-max(1, window):]
    return sum(w) / len(w) if w else 0.0


def _last_gap(daily: Sequence[KLineBar]) -> tuple:
    """最近一个向下跳空缺口 (下沿, 上沿)；下沿=压力，上沿=回补目标。"""
    for i in range(len(daily) - 1, 0, -1):
        hi = float(daily[i].get("high") or 0.0)
        prev_lo = float(daily[i - 1].get("low") or 0.0)
        if 0.0 < hi < prev_lo:
            return hi, prev_lo
    return None, None


def _mtf_down(series: Sequence[KLineBar]) -> bool:
    """大级别（周/月）近 3 根收盘方向是否向下。"""
    cl = [float(b.get("close") or 0.0) for b in series[-3:]]
    return len(cl) >= 3 and cl[0] > cl[-1]


def _target_position(close: float, sup_prev: float, res_prev: float,
                     gap_lower: Optional[float], gap_upper: Optional[float],
                     atr: float, mtf_down: bool, shrink: bool, expand: bool,
                     total_value: float) -> Dict[str, float]:
    """目标仓位函数 π* = f(赔率 b, 胜率 p, 结构性止损距离 r, 风险预算, 机会成本)。

    返回 dict: risk(止损距离) / b(赔率) / p(胜率) / edge(单位风险期望) /
              kelly / pi_risk_cap / pi_star
    """
    stop = sup_prev
    if gap_lower and close >= gap_lower:
        stop = max(stop, gap_lower * 0.99)          # 收复缺口后止损上移至缺口下沿（移动止损）
    risk = max(close - stop, 0.6 * atr, 0.01 * close)
    if gap_upper and close < gap_upper:
        target = gap_upper                          # 缺口未回补 → 回补目标（赔率锚）
    else:
        target = max(res_prev, close + 1.5 * atr)
    b = _clip((target - close) / risk, 0.5, 4.0)

    pos_adj = 0.08 if close <= sup_prev + 1.2 * risk else (0.06 if close > res_prev else 0.0)
    vol_adj = 0.12 if (expand and gap_lower and close >= gap_lower) else (-0.05 if shrink else 0.0)
    p = _clip(0.5 + (-0.12 if mtf_down else 0.0) + pos_adj + vol_adj, 0.30, 0.70)

    edge = p * b - (1.0 - p)                      # 单位风险期望收益（赔率单位）
    kelly = edge / b if edge > 0 else 0.0
    pi_risk_cap = ((total_value * _CFG["risk_budget_pct"] / 100.0) / risk) * close / total_value
    pi_star = _clip(min(kelly, pi_risk_cap, _CFG["pi_max"]), 0.0, _CFG["pi_max"])
    if edge > 0:   # 机会成本项：正期望时禁止停在零增量，至少 deploy_floor
        pi_star = min(max(pi_star, _CFG["deploy_floor"]), _CFG["pi_max"], max(pi_risk_cap, 0.0))
    return {"risk": risk, "target_price": target, "b": b, "p": p, "edge": edge,
            "kelly": kelly, "pi_risk_cap": pi_risk_cap, "pi_star": pi_star}


def decide(ctx: TradeContext) -> TradeDecision:
    """由 K 线信息 + 账户状态产出交易决策（纯函数，只消费 ctx）。

    策略内核 = 目标仓位函数 π* 而非离散三选一：
        π* = clip(min(Kelly(p,b), 风险预算上限, π_max), 0, π_max)，且 edge>0 时 π* ≥ deploy_floor
        b   = (缺口上沿/前高 − close) / r， r = max(close − 前3日低点, 0.6·ATR) 为结构性止损距离
        p   = 0.5 + 趋势修正(月/周空头 −0.12) + 位置修正(贴支撑 +0.08 / 破压力 +0.06)
                  + 量能修正(放量收复缺口 +0.12 / 缩量反抽遇阻 −0.05)
        决策 = sign(π* − π_now)：Δπ ≥ +2% 补仓；Δπ ≤ −12% 减仓；|Δπ| 小才持有。
        风控：close < 前3日低点 或 浮亏 ≤ −8% 且月/周空头 或 edge ≤ 0 → 清仓。
    """
    kline = ctx.get("kline") or {}
    daily: Sequence[KLineBar] = list(kline.get("daily") or [])
    weekly: Sequence[KLineBar] = list(kline.get("weekly") or [])
    monthly: Sequence[KLineBar] = list(kline.get("monthly") or [])
    account: AccountState = ctx.get("account") or {}
    position: Optional[Position] = account.get("position")
    cash = float(account.get("cash") or 0.0)
    qty_held = int((position or {}).get("quantity") or 0)
    cost = float((position or {}).get("cost_price") or 0.0)
    mv = float((position or {}).get("market_value") or 0.0)
    total_value = float(account.get("total_value") or 0.0) or (cash + mv)

    def _dec(decision: str, price: float, qty: int, conf: str,
             reason: str, **snap: Any) -> TradeDecision:
        return {"decision": decision, "tradePrice": price, "tradeQuantity": qty,
                "confidence": conf, "reasoning": reason, "featureSnapshot": snap}

    def _flat(watch: bool, conf: str, reason: str, **snap: Any) -> TradeDecision:
        return _dec(DECISION_WATCH if watch else DECISION_NO_POSITION, 0.0, 0, conf, reason, **snap)

    if len(daily) < 5 or total_value <= 0:
        snap = {"reason_code": "insufficient_data", "bars": len(daily)}
        if qty_held > 0:
            return _dec(DECISION_HOLD, 0.0, 0, CONF_LOW, "K线/账户不足，维持现状", **snap)
        return _flat(True, CONF_LOW, "K线/账户不足，继续观察", **snap)

    last = daily[-1]
    close = float(last.get("close") or 0.0)
    px = round(close, 2)                       # 贴近最近收盘价定价，确保落在次日可成交区间
    atr = _atr(daily, int(_CFG["atr_window"]))
    sup_prev = min(float(b.get("low") or close) for b in daily[-4:-1])
    res_prev = max(float(b.get("high") or close) for b in daily[-4:-1])
    gap_lower, gap_upper = _last_gap(daily)
    vols = [float(b.get("volume") or 0.0) for b in daily[-3:]]
    shrink = vols[0] > vols[1] > vols[2] > 0
    expand = vols[2] > vols[1] * 1.2 > 0
    mtf_down = _mtf_down(monthly) or _mtf_down(weekly)

    tp = _target_position(close, sup_prev, res_prev, gap_lower, gap_upper,
                          atr, mtf_down, shrink, expand, total_value)
    pi_star = tp["pi_star"]
    pi_cur = (mv / total_value) if qty_held > 0 else 0.0
    delta = pi_star - pi_cur
    feats = {"close": close, "atr": round(atr, 3), "sup_prev": sup_prev, "res_prev": res_prev,
             "gap_lower": gap_lower, "gap_upper": gap_upper, "risk": round(tp["risk"], 3),
             "b": round(tp["b"], 3), "p": round(tp["p"], 3), "edge": round(tp["edge"], 3),
             "kelly": round(tp["kelly"], 3), "pi_risk_cap": round(tp["pi_risk_cap"], 3),
             "pi_star": round(pi_star, 3), "pi_cur": round(pi_cur, 3), "delta_pi": round(delta, 3),
             "vol_shrink": shrink, "vol_expand": expand, "mtf_down": mtf_down,
             "cash": cash, "total_value": total_value}

    def _lot(budget_value: float) -> int:
        """按整百股取整的可买数量：受现金与给定金额预算双重约束。"""
        budget = min(budget_value, cash)
        if px <= 0 or budget < px * 100 or cash < px * 100:
            return 0
        lots = int(budget // px // 100) * 100
        if lots < 100 and budget >= px * 50:
            lots = 100
        return lots if lots * px <= cash else 0

    # ── 带仓 ──────────────────────────────────────────────────────────────
    if qty_held > 0:
        if close < sup_prev:
            return _dec(DECISION_SELL, px, qty_held, CONF_HIGH,
                        "收盘跌破前3日结构性低点，止损离场", **feats)
        if cost > 0 and (close / cost - 1.0) * 100.0 <= _CFG["stop_loss_pct"] and mtf_down:
            return _dec(DECISION_SELL, px, qty_held, CONF_MID,
                        "浮亏触及硬止损线且月/周线空头，截断风险", **feats)
        if tp["edge"] <= 0:
            return _dec(DECISION_SELL, px, qty_held, CONF_MID,
                        "赔率×胜率期望为负，持有即负期望，退出", **feats)
        if delta >= _CFG["buy_band"]:
            q = _lot(delta * total_value)
            if q >= 100:
                return _dec(DECISION_BUY, px, q, CONF_MID,
                            "目标仓位 %.0f%% > 当前 %.0f%%，正期望下必须把闲置现金转化为暴露，按结构性止损距离约束补仓"
                            % (pi_star * 100, pi_cur * 100), **feats)
            return _dec(DECISION_HOLD, 0.0, 0, CONF_LOW,
                        "仓位缺口不足一手，受整百股约束本次无法执行", **feats)
        if delta <= -_CFG["sell_band"]:
            q = int(((-delta) * total_value) // px // 100) * 100 if px > 0 else 0
            if q >= 100:
                return _dec(DECISION_SELL, px, min(q, qty_held), CONF_MID,
                            "当前仓位显著高于目标仓位，降暴露", **feats)
        return _dec(DECISION_HOLD, 0.0, 0, CONF_MID,
                    "当前仓位已在目标仓位带内（|Δπ|=%.1f%% < 阈值），持有是仓位已达标而非惰性"
                    % (abs(delta) * 100), **feats)

    # ── 空仓 ──────────────────────────────────────────────────────────────
    if close < sup_prev and mtf_down:
        return _flat(True, CONF_MID, "已跌破前3日低点且月/周线空头，破位下跌中不建仓，等站回结构位", **feats)
    if tp["edge"] > 0:
        q = _lot(pi_star * total_value)
        if q >= 100:
            return _dec(DECISION_BUY, px, q, CONF_MID,
                        "正期望(edge=%.2f)且目标仓位 %.0f%%，按风险预算建仓" % (tp["edge"], pi_star * 100),
                        **feats)
    if mtf_down and close < res_prev and shrink:
        return _flat(True, CONF_MID, "大级别空头+缩量未突破近期压力，继续跟踪", **feats)
    return _flat(True, CONF_LOW, "无正期望信号，继续观察等待放量突破", **feats)


# ══════════════════════════════════════════════════════════════════════════════
# 可选扩展挂点（仅签名与说明，实现按需补充）
# ══════════════════════════════════════════════════════════════════════════════

def _llm_view(kline: KLineSeries, account: AccountState) -> Optional[Dict[str, Any]]:
    """【可选】调用 LLM 形成观点 / 候选决策，供 decide() 参考或复算。"""
    pass


def _factor_scores(kline: KLineSeries) -> Dict[str, float]:
    """【可选】多因子打分（动量 / 量价 / 换手 / 振幅等）。"""
    pass


def _volatility(kline: KLineSeries) -> Dict[str, float]:
    """【可选】波动率度量（ATR / 标准差等），可用于仓位与价格取整。"""
    pass


def _pattern_match(kline: KLineSeries) -> Dict[str, Any]:
    """【可选】形态与结构位识别（前高前低 / 缺口 / 黄金分割等）。"""
    pass


def _to_decision(*args: Any, **kwargs: Any) -> TradeDecision:
    """【可选】把内部分析结果整形为契约要求的 4 字段输出。"""
    pass


if __name__ == "__main__":
    # 自测入口：实现完成后可在此调用 decide() 做冒烟验证
    pass
