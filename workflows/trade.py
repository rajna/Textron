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

import math
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

# ══════════════════════════════════════════════════════════════════════════════
# 策略参数
# ----------------------------------------------------------------------------
# 迭代依据（评分语义 = 总资产逐日变动，零变动记 −2）：
#   旧参数 risk_budget_pct=1.5 与 pi_max=0.60 **不自洽**：要达到 π_max 需
#   risk_budget ≥ π_max·(r/close)·100。当 r 由结构性低点决定（≈5.6%·close）时
#   1.5%/5.6% = 26.8% ≪ 60% ⇒ pi_risk_cap 成为唯一 binding 约束，且恰好等于
#   当前仓位 ⇒ Δπ≈0 ⇒ 永久输出「持有」⇒ 结构性吃 −2。参数必须与 r 的典型
#   量级联立校准：2.5% 在 r∈[2.3%,3.2%]·close 时可达 π_max，在 r=5.6% 时
#   允许 44.6% 仓位，不再把策略锁死在原仓位。
# ══════════════════════════════════════════════════════════════════════════════

_CFG: Dict[str, float] = {
    "risk_budget_pct": 2.5,   # 单笔风险预算（占总资产 %）→ 结构性止损距离反推允许仓位
    "deploy_floor": 0.35,     # edge>0 时的最低目标仓位：机会成本定价下禁止"零增量持有"
    "pi_max": 0.60,           # 单标的最大仓位
    "buy_band": 0.02,         # 目标仓位 > 当前 +2% → 补仓（下限，实际阈值取 max(此值, 一手步长)）
    "sell_band": 0.12,        # 目标仓位 < 当前 -12% → 减仓
    "stop_loss_pct": -8.0,    # 成本价下方硬止损线（%）
    "atr_window": 8,
    "atr_stop_mult": 0.6,     # 止损距离物理下限 = max(0.6·ATR, min_stop_pct·close)
    "min_stop_pct": 0.02,     # 低于该比例必被当日噪音扫损 ⇒「止损越近≠越安全」
    "trail_ratio": 0.995,     # 突破 res_prev 后止损 trail 到 res_prev·该系数
    "weak_edge": 0.05,        # edge 弱阈值：低于此值不做无畏换手
    "p_gate": 0.50,           # 胜率闸门：p < 此值时禁止启用机会成本项（见 _target_position 注释）
    "range_squeeze": 1.5,     # 横盘收缩阈值：箱体 < 该值×ATR ⇒ 方向未定，禁止加仓，等突破确认
    "gap_decay_days": 3,      # 缺口未回补的时间衰减步长（交易日）
    "gap_decay_step": 0.01,   # 每衰减一步对 p 的扣减
    "gap_decay_cap": 0.05,    # 衰减总上限
    "score_cost_pct": 0.2,    # 一次「零变动」采样对应的固定失分（占总资产 %），用于最小有效换手判定
    # ── 第 10 步纠错新增（依据两条实测事实：① D 收盘出决策 → D+1 以 D+1 价格成交，
    #    tradePrice 只是申报价/锚价，只决定「申报是否落入 D+1 的 [low, high]」；
    #    ② 评分口径 = 逐日总资产变动，故「方向与仓位一致性」优先于「赔率大小」）─────
    "mtf_one_pen": 0.05,      # 仅单一大级别空头时的胜率惩罚。原式「月或周任一空头即 −0.12」会把
    #                           「月线含未完成当期 + 周线已转多」误杀为低胜率 ⇒ 停在半仓不表态区
    "mom_alpha": 0.05,        # 日线动量确认（近 3 收盘严格递增）的正向补偿：原式只惩罚空头、完全不计多头
    "sup_zone_atr": 2.0,      # 「贴支撑」判定改用 ATR 倍数。原用 1.2·risk，而 risk 已被 vol_floor 放大
    #                           ⇒ 止损 trail 上移反而丢掉 pos_adj（止损越近越不算贴支撑，逻辑倒置）
    "order_slip_atr": 0.30,   # 申报价方向偏移(×ATR)：抵消跳空造成的「申报价越出次日区间」整笔失效
    "momentum_veto": 1,       # 动量否决分级：Δπ 方向与日线动量冲突时降级/否决换手（硬止损/结构破位仍可越过）
    # ── 第 11 步（终局）纠错：否决权必须与「证据强度」与「缺口显著性」双向绑定 ─────
    "veto_sig_mult": 2.0,    # Δπ ≥ 该倍数×触发阈值 ⇒ 仓位缺口已属显著级，动量否决不得整条吞掉方向信号，
    #                           只能降级为折半执行（实测代价：单周期空头一票否决 kelly 0.281 ≫ π_cur 0.156
    #                           的方向信号，结算价高于决策日收盘 ⇒ 机会成本）
    "veto_half": 0.5,         # 折半执行系数：π_exec = π_cur + half·Δπ
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


def _last_gap(*pairs: tuple) -> tuple:
    """最近一个「未被完全回补」的向下跳空缺口 (下沿, 上沿, age)。
    pairs 形如 ((series, bars_per_unit), ...)，bars_per_unit 为该周期一根 bar 折算的交易日数
    （日 1 / 周 5 / 月 21）；age 统一以**交易日**计，使缺口时间衰减在不同周期下可比。

    跨周期冗余（本局实测到的健壮性缺陷）：滚动窗口会截断历史 bar，使「窗口首根
    自身即跳空 bar」的缺口在细粒度序列上无法比较前一根而漏检。同一价格结构在
    日线上消失、却完好在周线上（04-11周 high=54.95 < 04-04周 low=58.48），
    使同一持仓位置随窗口差异产出**方向相反**的决策（买入 ↔ 卖出）。
    故按 日 → 周 → 月 顺序回退，取首个有效缺口。

    失效判定：缺口形成后任一 bar 的 high ≥ 上沿 ⇒ 已完全回补，不再是赔率锚。
    """
    for series, unit in pairs:
        if not series or len(series) < 2:
            continue
        n = len(series)
        for i in range(n - 1, 0, -1):
            hi = float(series[i].get("high") or 0.0)
            prev_lo = float(series[i - 1].get("low") or 0.0)
            if 0.0 < hi < prev_lo:
                if any(float(b.get("high") or 0.0) >= prev_lo for b in series[i + 1:]):
                    continue                      # 已完全回补 → 失效，继续找下一个
                return hi, prev_lo, (n - 1 - i) * int(unit)
    return None, None, None


def _mtf_down(series: Sequence[KLineBar]) -> bool:
    """大级别（周/月）近 3 根收盘方向是否向下。"""
    cl = [float(b.get("close") or 0.0) for b in series[-3:]]
    return len(cl) >= 3 and cl[0] > cl[-1]


def _mtf_flags(monthly: Sequence[KLineBar], weekly: Sequence[KLineBar]) -> tuple:
    """大级别空头计数 → (月线空头, 周线空头)。

    原式取 or：只要月线（其最后一根是**未完成**的当期 bar）为空头就扣满 −0.12，
    会把「月线因当期尚未收官而显空、周线已连续转多」的反弹结构误判为低胜率，
    使 π* 被 kelly 压到 12% 而当前仓位 32% ⇒ 在上涨段被动输出「减仓」。
    改为按**空头周期数**分档：两周期一致 -0.12，单周期 -0.05。
    """
    return (_mtf_down(monthly), _mtf_down(weekly))


def _mom_up(daily: Sequence[KLineBar], n: int = 3) -> bool:
    """日线短期动量确认：近 n 根收盘严格递增。

    原 p 的构造里只有 mtf_down 的负分项，**没有任何日线正向项**：连续 12 个交易日
    从 48.41 抬到 55.35 的反弹在胜率上完全不计分 ⇒ p 被单向压低 ⇒ 加仓闸门恒不通过。
    """
    cl = [float(b.get("close") or 0.0) for b in daily[-n:]]
    return len(cl) >= n and all(cl[i] < cl[i + 1] for i in range(len(cl) - 1))


def _target_position(close: float, sup_prev: float, res_prev: float,
                     gap_lower: Optional[float], gap_upper: Optional[float],
                     atr: float, mtf_down: bool, shrink: bool, expand: bool,
                     total_value: float, gap_age: Optional[int] = None,
                     mtf_n: Optional[int] = None, mom_up: bool = False) -> Dict[str, float]:
    """目标仓位函数 π* = f(赔率 b, 胜率 p, 结构性止损距离 r, 风险预算, 机会成本)。

    返回 dict: risk(止损距离) / b(赔率) / p(胜率) / edge(单位风险期望) /
              kelly / pi_risk_cap / pi_star / binding(有效约束)

    本轮新增的两条因果机制（均由「零变动记 −2」的评分语义反推）：
      1) **移动止损是仓位扩容器，不只是保护器**：r 收缩 ⇒ pi_risk_cap 按 1/r 放大
         ⇒ Δπ 越过触发阈值。故突破前 3 日高点(res_prev) 或收复缺口下沿(gap_lower)
         时，止损必须 trail 上移，否则仓位容量被永久锁死。
      2) **r 有物理下限 max(0.6·ATR, 2%·close)**：这是「更近的止损」的硬边界——
         突破噪音带以内，止损越近只会提高被扫概率（p 下降）而不增加容量。
      3) **胜率闸门 + 收缩闸门（逐日结算惩罚）**：评分逐日采样，高赔率低胜率的赌注
         其收益实现频率低，而每一天都独立结算失分 ⇒ 低 p 下加仓会放大负分天数。
         故 deploy_floor 仅在 `edge≥weak_edge ∧ p≥p_gate(0.50) ∧ 非箱体收缩` 时启用。
         双通道释放加仓权：突破确认 → p 升（放量收复缺口 +0.12、破压力 +0.06）
         且止损 trail 上移 → 容量同步放大。
    """
    stop = sup_prev
    trail_ok = (close > res_prev) or (gap_lower is not None and close >= gap_lower)
    if trail_ok:
        stop = max(stop, res_prev * _CFG["trail_ratio"])   # 突破确认 → 移动止损上移
    if gap_lower and close >= gap_lower:
        stop = max(stop, gap_lower * 0.99)                  # 收复缺口 → 止损再上移至缺口下沿
    vol_floor = max(_CFG["atr_stop_mult"] * atr, _CFG["min_stop_pct"] * close)
    risk = max(close - stop, vol_floor, 0.01 * close)
    if gap_upper and close < gap_upper:
        target = gap_upper                          # 缺口未回补 → 回补目标（赔率锚）
    else:
        target = max(res_prev, close + 1.5 * atr)
    b = _clip((target - close) / risk, 0.5, 4.0)

    # 缺口回补动能的时间衰减：未回补的交易日越多，「必回补」的先验越弱
    gap_decay = 0.0
    if gap_age is not None and gap_age > 0:
        steps = gap_age // max(1, int(_CFG["gap_decay_days"]))
        gap_decay = min(_CFG["gap_decay_cap"], _CFG["gap_decay_step"] * steps)
    # 「贴支撑」判定必须与 risk 解耦：risk 被 vol_floor 放大后，用 1.2·risk 作阈值会出现
    # 「止损 trail 上移（风险变小）⇒ 反而不满足贴支撑 ⇒ 丢掉 +0.08」的倒置。改以 ATR 口径
    # 度量真实结构距离，使 trail 上移只增容、不减胜率。
    sup_zone = sup_prev + _CFG["sup_zone_atr"] * atr
    pos_adj = 0.08 if close <= sup_zone else (0.06 if close > res_prev else 0.0)
    mom_adj = _CFG["mom_alpha"] if mom_up else 0.0      # 日线动量正向补偿（原式缺失）
    vol_adj = 0.12 if (expand and gap_lower and close >= gap_lower) else (-0.05 if shrink else 0.0)
    # 噪音带惩罚：若结构距离（close−sup_prev）不足 1·ATR，止损实际被摆进当日噪音区，
    # 胜率必须打折——「止损被 floor 拉到更远处」意味着真实风险大于结构距离，不能当白赚
    noise_pen = -0.06 if (atr > 0 and (close - sup_prev) < 1.0 * atr) else 0.0
    # 大级别惩罚按空头周期数分档；mtf_n=None 时回退旧语义，保证历史回放可复现
    if mtf_n is None:
        mtf_pen = -0.12 if mtf_down else 0.0
    else:
        mtf_pen = -0.12 if mtf_n >= 2 else (-_CFG["mtf_one_pen"] if mtf_n == 1 else 0.0)
    p = _clip(0.5 + mtf_pen + pos_adj + mom_adj + vol_adj + noise_pen - gap_decay,
              0.30, 0.70)
    # 箱体收缩：站于箱体之内且箱体高度不足 range_squeeze·ATR ⇒ 方向未定，禁止加仓
    box = res_prev - sup_prev
    squeeze = bool(box > 0 and box < _CFG["range_squeeze"] * atr and sup_prev <= close <= res_prev)

    edge = p * b - (1.0 - p)                      # 单位风险期望收益（赔率单位）
    kelly = edge / b if edge > 0 else 0.0
    pi_risk_cap = ((total_value * _CFG["risk_budget_pct"] / 100.0) / risk) * close / total_value
    raw = min(kelly, pi_risk_cap, _CFG["pi_max"])          # 未被机会成本项抬升前的原始最优
    pi_star = _clip(raw, 0.0, _CFG["pi_max"])
    floor_on = (edge >= _CFG["weak_edge"] and p >= _CFG["p_gate"] and not squeeze)
    if floor_on:   # 机会成本项仅在「正期望 ∧ 方向占优 ∧ 非收缩」时生效
        pi_star = min(max(pi_star, _CFG["deploy_floor"]), _CFG["pi_max"], max(pi_risk_cap, 0.0))
    # binding 归因必须指向真正卡住 π* 的那一项（含被 deploy_floor 抬升的情形），
    # 否则复盘无法区分「风险预算满」与「凯利仓位本就低」这两种完全不同的修法
    if pi_risk_cap <= min(kelly, _CFG["pi_max"]):
        binding = "risk_cap"
    elif kelly <= _CFG["pi_max"] and pi_star > raw + 1e-12:
        binding = "deploy_floor"
    elif kelly <= _CFG["pi_max"]:
        binding = "kelly"
    else:
        binding = "pi_max"
    return {"risk": risk, "target_price": target, "b": b, "p": p, "edge": edge,
            "kelly": kelly, "pi_risk_cap": pi_risk_cap, "pi_star": pi_star,
            "binding": binding, "stop": stop, "trail_ok": trail_ok,
            "gap_decay": gap_decay, "squeeze": squeeze, "floor_on": floor_on,
            "mom_adj": mom_adj, "mtf_pen": mtf_pen}


def decide(ctx: TradeContext) -> TradeDecision:
    """由 K 线信息 + 账户状态产出交易决策（纯函数，只消费 ctx）。

    策略内核 = 目标仓位函数 π* 而非离散三选一：
        π* = clip(min(Kelly(p,b), 风险预算上限, π_max), 0, π_max)
        b   = (缺口上沿/前高 − close) / r， r = max(close − stop, 0.6·ATR, 2%·close) 为结构性止损距离
        stop = 前3日低点；突破 res_prev 或收复 gap_lower 时 trail 上移（移动止损 = 仓位扩容器）
        p   = 0.5 + 趋势修正(月/周空头 −0.12) + 位置修正(贴支撑 +0.08 / 破压力 +0.06)
                  + 量能修正(放量收复缺口 +0.12 / 缩量反抽遇阻 −0.05)
                  + 噪音带惩罚(结构距离 < 1·ATR −0.06)
        机会成本项（三闸门 AND）：edge ≥ weak_edge(0.05) ∧ p ≥ p_gate(0.50) ∧ 非箱体收缩
                    —— 评分逐日采样，低胜率高赔率赌注的收益实现频率低而每天都独立结算，
                    故低 p 下禁止加仓；收缩期方向未定，等突破确认（突破→p 升 + 止损 trail 双通道释放容量）
        决策 = sign(π* − π_now)：Δπ ≥ max(buy_band, 一手步长, 最小有效换手) 补仓；
                                  Δπ ≤ −max(sell_band, 最小有效换手) 减仓；|Δπ| 低于阈值才持有。
        方向一致性（第 10 步纠错）：逐日结算下失分来自「仓位与次日方向不一致」，故
                    (a) p 的日线动量项 mom_adj（近3收盘递增 +0.05）与 mtf_pen 按空头周期数分档，
                        修正「只惩罚空头、不计多头」的单向偏置；
                    (b) 「贴支撑」判定改用 sup_prev + 2.0·ATR（与 risk 解耦）；
                    (c) 动量否决分级（第 11 步终局修正）：否决权不再「单/双周期空头共用一票」，
                        而是与证据强度、缺口显著性双向绑定：mtf_n≥2 且 Δπ<2·带宽 → 全否决；
                        mtf_n==1 → 折半执行（保留 kelly 的方向权）；mtf_n≥2 但 Δπ≥2·带宽（显著级）
                        → 降级为折半。折半执行的股数同时受「最小有效换手下界（向上取整，
                        避免取整后跌破阈值使换手沦为负期望）」与「π* 对应持股上界」约束。
                    (d) 减仓量 = 当前持股 − π* 折算的目标持股（向上取整到整百），
                        不再用 Δπ·总值 折算（向下取整会停在半仓不表态区）。
        申报（申报价 ≠ 成交价）：D 收盘出决策 → D+1 以 D+1 价格成交，tradePrice 只决定
                    「申报是否落入 D+1 的 [low, high]」。故按动量方向偏移 0.3·ATR 并以 ±9.5% 限幅，
                    降低跳空导致的整笔失效概率；仓位折算仍锚定最近收盘价。
        最小有效换手 = (score_cost_pct/100) / (ATR/close)：覆盖一次「零变动」固定失分所需的最小仓位变动，
                    防止小额换手在逐日评分下成为负期望动作
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
    gap_lower, gap_upper, gap_age = _last_gap((daily, 1), (weekly, 5), (monthly, 21))
    vols = [float(b.get("volume") or 0.0) for b in daily[-3:]]
    shrink = vols[0] > vols[1] > vols[2] > 0
    expand = vols[2] > vols[1] * 1.2 > 0
    m_down, w_down = _mtf_flags(monthly, weekly)
    mtf_n = int(m_down) + int(w_down)
    mtf_down = bool(mtf_n)                     # 保留 or 语义，仅用于破位/硬止损分支
    mom_up = _mom_up(daily, 3)                 # 日线动量确认：原策略完全缺失的正向项

    tp = _target_position(close, sup_prev, res_prev, gap_lower, gap_upper,
                          atr, mtf_down, shrink, expand, total_value, gap_age,
                          mtf_n=mtf_n, mom_up=mom_up)

    def _order_px(side: int) -> float:
        """申报价：side +1 买入 / −1 卖出。

        成交价恒为 D+1 的价格，申报价只决定申报能否落入 D+1 的 [low, high]（越界即整笔失效）。
        有明确短期动量时沿动量方向偏移 0.3·ATR 以吸收跳空；反向交易不追价（贴锚价，避免边缘越界）。
        """
        drift = _CFG["order_slip_atr"] * atr if ((side > 0 and mom_up) or (side < 0 and mtf_down and not mom_up)) else 0.0
        lim = 0.095 * close
        return round(_clip(close + side * drift, close - lim, close + lim), 2)

    pi_star = tp["pi_star"]
    pi_cur = (mv / total_value) if qty_held > 0 else 0.0
    delta = pi_star - pi_cur
    # 触发阈值必须尊重 A 股整百股离散度：一手所占仓位步长
    min_pi_step = (100.0 * px / total_value) if (px > 0 and total_value > 0) else 0.0
    # 最小有效换手：评分逐日采样，一次「零变动」采样就是固定失分（约 score_cost_pct% 总资产）；
    # 仓位变动太小则「预期增量×日波幅」抵不过这笔固定支出 ⇒ 小额交易是负期望的。
    # 故换手量必须 ≥ 固定失分 / 日波幅（以 ATR/close 为日波幅代理）。
    min_eff_delta = ((_CFG["score_cost_pct"] / 100.0) / (atr / close)) if (atr > 0 and close > 0) else 0.0
    eff_buy_band = max(_CFG["buy_band"], min_pi_step, min_eff_delta)
    eff_sell_band = max(_CFG["sell_band"], min_eff_delta)
    # 换手冷却（仅当调用方通过 ctx["memory"] 传入状态时生效，缺省无副作用）：
    # 成交发生在 D+1、而价格锚取自 D 收盘 ⇒ 连续「卖→买」对倒会同时吃双向滑点与
    # 两次零变动固定失分。故刚减仓后若要回补，要求 Δπ 达到 1.5× 触发阈值。
    _mem = ctx.get("memory") or {}
    cooldown_mult = 1.5 if str(_mem.get("last_decision") or "") == DECISION_SELL else 1.0
    eff_buy_band *= cooldown_mult
    # 加仓侧动量否决**分级**（第 11 步）：否决权与「空头周期数」及「缺口显著性」双向绑定，
    # 解决上一版「单周期空头与双周期空头共用一票否决」导致 kelly 方向信号被整条吞掉的矛盾。
    add_scale = 1.0
    if _CFG["momentum_veto"] and mtf_n >= 1 and not mom_up:
        add_scale = _CFG["veto_half"] if (mtf_n == 1 or delta >= _CFG["veto_sig_mult"] * eff_buy_band) else 0.0
    feats = {"close": close, "atr": round(atr, 3), "sup_prev": sup_prev, "res_prev": res_prev,
             "gap_lower": gap_lower, "gap_upper": gap_upper, "gap_age": gap_age,
             "gap_decay": round(tp["gap_decay"], 3), "squeeze": tp["squeeze"],
             "floor_on": tp["floor_on"], "risk": round(tp["risk"], 3),
             "b": round(tp["b"], 3), "p": round(tp["p"], 3), "edge": round(tp["edge"], 3),
             "kelly": round(tp["kelly"], 3), "pi_risk_cap": round(tp["pi_risk_cap"], 3),
             "pi_star": round(pi_star, 3), "pi_cur": round(pi_cur, 3), "delta_pi": round(delta, 3),
             "binding": tp["binding"], "stop": round(tp["stop"], 3), "trail_ok": tp["trail_ok"],
             "min_pi_step": round(min_pi_step, 4), "min_eff_delta": round(min_eff_delta, 4),
             "eff_buy_band": round(eff_buy_band, 4), "eff_sell_band": round(eff_sell_band, 4),
             "vol_shrink": shrink, "vol_expand": expand, "mtf_down": mtf_down,
             "mtf_n": mtf_n, "mom_up": mom_up, "mom_adj": round(tp["mom_adj"], 3),
             "cooldown_mult": cooldown_mult, "add_scale": round(add_scale, 2),
             "cash": cash, "total_value": total_value}

    def _lot(budget_value: float, price: Optional[float] = None) -> int:
        """按整百股取整的可买数量：受现金与给定金额预算双重约束。
        现金校验用**申报价**（申报价高于锚价时同样要付得出钱）。"""
        p_ = float(price or px)
        budget = min(budget_value, cash)
        if p_ <= 0 or budget < p_ * 100 or cash < p_ * 100:
            return 0
        lots = int(budget // p_ // 100) * 100
        if lots < 100 and budget >= p_ * 50 and cash >= p_ * 100:
            lots = 100
        return lots if lots * p_ <= cash else 0

    def _target_qty(pi: float, price: Optional[float] = None) -> int:
        """把目标仓位折算为整百股持股数（增量由目标持股数 − 当前持股数得出，
        避免用 Δπ·total_value 再除价取整造成的单侧截断损耗）。折算锚定最近收盘价。"""
        p_ = float(price or px)
        if p_ <= 0 or pi <= 0:
            return 0
        return int(pi * total_value // p_ // 100) * 100

    # ── 带仓 ──────────────────────────────────────────────────────────────
    if qty_held > 0:
        if close < sup_prev:
            return _dec(DECISION_SELL, _order_px(-1), qty_held, CONF_HIGH,
                        "收盘跌破前3日结构性低点，止损离场", **feats)
        if cost > 0 and (close / cost - 1.0) * 100.0 <= _CFG["stop_loss_pct"] and mtf_down:
            return _dec(DECISION_SELL, _order_px(-1), qty_held, CONF_MID,
                        "浮亏触及硬止损线且月/周线空头，截断风险", **feats)
        if tp["edge"] <= 0:
            return _dec(DECISION_SELL, _order_px(-1), qty_held, CONF_MID,
                        "赔率×胜率期望为负，持有即负期望，退出", **feats)
        if delta >= eff_buy_band:
            # 加仓侧动量否决分级（第 11 步）：单周期空头不享有与双周期空头同等的一票否决权。
            #   · mtf_n ≥ 2 且 Δπ < 2×eff_buy_band → 全否决（月/周一致空头 = 趋势证据最强）；
            #   · mtf_n == 1（常见于「月线未收官 bar」）→ 只折半执行，保留 kelly 的方向权；
            #   · mtf_n ≥ 2 但 Δπ ≥ 2×eff_buy_band（缺口显著级）→ 降级为折半，不整条吞掉。
            if add_scale <= 0.0:
                return _dec(DECISION_HOLD, 0.0, 0, CONF_LOW,
                            "Δπ=+%.1f%% 触发补仓，但月/周线一致空头(mtf_n=%d)且日线动量未确认、"
                            "缺口未达显著级(%.1f%%)，动量否决本次换手"
                            % (delta * 100, mtf_n, _CFG["veto_sig_mult"] * eff_buy_band * 100), **feats)
            # 折半执行：执行目标 π_exec = π_cur + scale·Δπ，实际股数同时受
            # 「最小有效换手」下界（向上取整——向下取整会使实际 Δπ 跌破阈值，
            # 换手退化为负期望动作）与「π* 对应持股」上界约束。
            pi_exec = pi_cur + add_scale * delta
            cap_q = _target_qty(pi_star) - qty_held
            if add_scale < 1.0:
                need_q = int(math.ceil(eff_buy_band * total_value / px / 100.0)) * 100 if px > 0 else 0
                want_q = max(_target_qty(pi_exec) - qty_held, need_q)
            else:
                want_q = cap_q
            want_q = min(want_q, cap_q) if cap_q > 0 else 0
            q = _lot(want_q * px, _order_px(+1)) if want_q >= 100 else 0
            if q >= 100:
                return _dec(DECISION_BUY, _order_px(+1), q, CONF_MID,
                            "目标仓位 %.0f%% > 当前 %.0f%%（Δπ=%.1f%% ≥ 触发阈值 %.1f%%，否决强度 scale=%.1f），"
                            "binding=%s，按执行目标 %.0f%% 补仓；止损 %.2f，r=%.2f"
                            % (pi_star * 100, pi_cur * 100, delta * 100, eff_buy_band * 100, add_scale,
                               tp["binding"], pi_exec * 100, tp["stop"], tp["risk"]), **feats)
            return _dec(DECISION_HOLD, 0.0, 0, CONF_LOW,
                        "仓位缺口 %.2f%% 不足一手（一手步长 %.2f%%），受整百股约束本次无法执行"
                        % (delta * 100, min_pi_step * 100), **feats)
        if delta <= -eff_sell_band:
            if _CFG["momentum_veto"] and mom_up and abs(delta) < _CFG["veto_sig_mult"] * eff_sell_band:
                # 减仓侧对称分级：上涨段只有「|Δπ| 未达显著级」时才否决；
                # 若超配已达显著级（风险敞口失控），单日动量不足以支撑继续持有。
                return _dec(DECISION_HOLD, 0.0, 0, CONF_MID,
                            "Δπ=%.1f%% 触发减仓，但日线动量向上（近3收盘递增）且未达显著级(%.1f%%)，动量否决本次换手"
                            % (delta * 100, _CFG["veto_sig_mult"] * eff_sell_band * 100), **feats)
            # 减仓量 = 当前持股 − π* 折算的目标持股（向上取整到整百）：
            # 原式 (−Δπ·总值)//价//100*100 向下截断 ⇒ 减仓后仓位仍显著高于目标，
            # 停在「半仓不表态」区，方向与仓位一致性未解决。
            tgt_q = _target_qty(pi_star, px)
            q = qty_held - tgt_q
            q = min(qty_held, ((q + 99) // 100) * 100) if q > 0 else 0
            if q >= 100:
                return _dec(DECISION_SELL, _order_px(-1), q, CONF_MID,
                            "当前仓位 %.0f%% 高于目标 %.0f%%（Δπ=%.1f%% ≤ −%.1f%%），减至目标持股 %d 股"
                            % (pi_cur * 100, pi_star * 100, delta * 100, eff_sell_band * 100, tgt_q),
                            **feats)
        return _dec(DECISION_HOLD, 0.0, 0, CONF_MID,
                    "当前仓位已在目标仓位带内（|Δπ|=%.1f%% < 阈值），持有是仓位已达标而非惰性"
                    % (abs(delta) * 100), **feats)

    # ── 空仓 ──────────────────────────────────────────────────────────────
    if close < sup_prev and mtf_down:
        return _flat(True, CONF_MID, "已跌破前3日低点且月/周线空头，破位下跌中不建仓，等站回结构位", **feats)
    # 空仓：开仓与加仓受同一套闸门约束（逐日结算下低胜率开仓同样放大负分天数）
    if tp["edge"] > 0 and tp["floor_on"] and not (_CFG["momentum_veto"] and mtf_down and not mom_up):
        q = _lot(_target_qty(pi_star) * px, _order_px(+1))
        if q >= 100:
            return _dec(DECISION_BUY, _order_px(+1), q, CONF_MID,
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
