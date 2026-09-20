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
from typing import Any, Dict, List, Literal, Optional, Sequence, TypedDict

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
    "p_gate": 0.50,           # 胜率闸门（**准入层**）：p < 此值时禁止加仓/建仓，见 _target_position 的 admit
    # ── p_gate 阈值标定记录（本轮只登记，**刻意不改阈值**）─────────────────────
    # (a) 近端样本实测（本局 sz.301299，逐日截断回放，次日收益 = next_close/close − 1）：
    #     口径① 仅日线：admit=True n=4 均值 −0.48%（−3.00%~+2.31%）
    #                vs admit=False n=3 均值 +1.03%（−1.98%~+2.91%）⇒ 差 −1.51pp；
    #     口径② 含周线：admit=True n=2 均值 −2.00% vs admit=False n=6 均值 +0.98% ⇒ 差 −2.98pp。
    #     两口径一致地为**负相关**（准入通过组的次日反而更差），但 n=2~4 且方向与假设相反
    #     ⇒ 既不足以标定阈值，也不足以否决准入层；故保留 p_gate=0.50，登记为待观察项。
    # (b) 硬截断 vs 软惩罚：实测 p 的取值是**离散档**（0.44/0.47/0.49/0.52/0.55/0.58），
    #     0.50 附近无样本 ⇒ 硬截断实际等价于「{0.44…0.49} 归零 / {0.52…} 全额」。
    #     倾向方案 = **准入层保持硬截断 + 配额层做连续缩放**，两条理由：
    #       ① 上轮 PASS 的核心可观测证据是「同数值：修补前买 200 / 修补后持有」的行为差分，
    #          把准入软化成 qty_scale 会让该差分消失，退化回「配额凌驾准入」的失败模式；
    #       ② 0.50 处无样本 ⇒ 软化的收益无法被数据支撑，属无证据参数拟合。
    #     下一步优先级 = 提高 p 的**分辨力**（mom_adj / vol_adj 现为 0/0.05、0/0.12 二值，
    #     量化步长与阈值间距同阶），而不是把闸门软化成连续权重。
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
    # ── 第 13 步纠错（本局第 2 轮实测）：锚价申报在跳空日的失效是**结构性缺陷**而非运气 ──
    #   实测：加仓 200 股 @ 申报价 55.21（=D 收盘锚）遇 D+1 向上跳空，[low,high] 不含 55.21
    #   ⇒ 整笔失效、仓位维持 26%、交易次数 69 未变 —— 方向判断正确而收益未落地。
    #   故新增**双向可成交性宽容带**（口径只含当日可知量：ATR 与收盘价，无任何未来信息）：
    #     band = max(gap_tol_atr·ATR, gap_tol_pct·close)；买申报 = close+band、卖申报 = close−band。
    #   安全性来自撮合式：买 effective = min(申报, 开盘) ⇒ 抬高申报价只扩触发窗、不抬成交价
    #   （最坏按开盘价成交）；卖 effective = max(申报, 开盘) ⇒ 降低申报价同理不砸成交价。
    "gap_tol_atr": 0.6,      # 宽容带 ATR 分量（≈覆盖一次典型隔夜跳空）
    "gap_tol_pct": 0.02,     # 宽容带下限 2%·close（低波动期 ATR 过小时仍保可成交性）
    #   ⚠ 错误修正方案的判定边界（本带的有效性依赖成交价语义）：
    #   ① 若实际成交价 = min(买申报, 开盘) / max(卖申报, 开盘)（本文件注释与实测失效现象
    #      所指的模型）→ 带只扩触发窗、不抬成交价，**永远不吃亏**；
    #   ② 若实际成交价 = 前收盘价而申报价仅作区间校验（prompt 原文「成交价默认参考最近收盘价」）
    #      → 带同样零成本；
    #   ③ 仅当执行层是「成交价 ≡ 申报价」的纯限价模型时，本带才变成真实滑点（买+2.2%/卖−2.2%）。
    #      该情形下的修正不是缩带（缩带＝退回失效模式），而是**申报失败重报**：由调用方在
    #      ctx["memory"]["last_fill_failed"] 回传失败标志，次日用同一方向、按新收盘重算的带重报。
    "momentum_veto": 1,       # 动量否决分级：Δπ 方向与日线动量冲突时降级/否决换手（硬止损/结构破位仍可越过）
    # ── 第 11 步（终局）纠错：否决权必须与「证据强度」与「缺口显著性」双向绑定 ─────
    "veto_sig_mult": 2.0,    # Δπ ≥ 该倍数×触发阈值 ⇒ 仓位缺口已属显著级，动量否决不得整条吞掉方向信号，
    #                           只能降级为折半执行（实测代价：单周期空头一票否决 kelly 0.281 ≫ π_cur 0.156
    #                           的方向信号，结算价高于决策日收盘 ⇒ 机会成本）
    "veto_half": 0.5,         # 折半执行系数：π_exec = π_cur + half·Δπ
    # ── 第 14 步纠错（本局第 2 轮实测，亏损 −405 元 / −0.39%）────────────────────
    #   失败模式：「无信号 ⇒ 持有」被当成零成本的中性选项。实盘：05-08 收 57.45，
    #   日线缩量小阳（168.7 万 < 221.8 万）收复前日收盘，我判为「弱信号、等确认」
    #   ⇒ 输出持有；次日回落至 56.10，300 股浮亏由 +978 降至 +573，持仓敞口全额计入账户。
    #   根因一（定价缺陷）：形态学上 05-07 已是「放量长上影阴线」——冲高回落比
    #     (high−close)/(high−low) = (59.84−56.61)/3.73 = 0.87、收阴、量 222.8 万 ≈ 1.5×
    #     前 4 日均量 148.8 万，即放量上攻被抛压打回；05-08 高点 57.78 < 59.84 ⇒ 反抽未能
    #     收复上影高点，上攻失败被第二次确认。原 p 公式对该组合**完全不敏**（vol_adj 的
    #     expand/shrink 二值均不命中 ⇒ 0），使 edge 停在 +0.006 ≈ 0 的「零期望区」。
    #   根因二（触发滞后）：存量减仓此前只有三条路径——破 sup_prev / −8% 硬止损 / Δπ ≤ −12%，
    #     即必须先积累 12% 超配漂移才轮到减仓；轻仓（π_cur≈5%）时 Δπ=−4.5% 永远够不着门槛
    #     ⇒ 退化为「超配未达带时持有」的惰性持有。
    #   修正：把上述两个确认纳入 p（exhaust_pen），使衰竭证据直接令 edge 转负，把退出由
    #     「仓位漂移触发」升级为「期望为负触发」——**无需任何 12% 超配前置条件**。
    #   判别力实测（同一 05-08 数据，仅持股数不同）：300 股时修补前后同为卖出（无差分）；
    #     100 股时修补前持有（Δπ=−4.5% > −12%）、修补后卖出（edge +0.006 → −0.146）⇒
    #     差分可观测，且正是本轮失败模式本身。禁用边界：若次日收复前一日最高价则不算衰竭
    #     （避免把「回踩后再创新高」误杀）；仅用 daily[-2]/daily[-1]，无未来函数。
    "exhaust_pen": 0.08,     # 冲高衰竭扣分：放量长上影阴线 + 次日未收复其高点 ⇒ p 下修
    "exhaust_fall_frac": 0.5,  # 冲高回落比门槛 (high−close)/(high−low)，高于此值视为上攻被打回
    "exhaust_vol_mult": 1.3,   # 上影日的量能门槛（×前 4 日均量），保证是「放量」而非缩量假阴
    # ── 第 15 步纠错（本局第 2 轮实测，本轮盈利 +249 元 / +0.24%）───────────────────
    #   实盘：05-09 光头阴线收 56.10（-2.35%，收于当日最低、量缩至 131.5 万），我输出
    #   卖出 300 股 @54.88；D+1 开盘 56.93 且盘中回落至 54.88 以下 ⇒ 申报落入区间、
    #   撮合价 = max(申报 54.88, 开盘 56.93) = 56.93 ⇒ 以高于前收盘 1.48% 的价格清仓。
    #   复盘发现 trade.py 在同一数据上仍输出「持有」（与上轮同一处回退），两个缺陷：
    #   ①**确认窗口只有 1 日**：exhaust 只查 daily[-2]，而 05-09 视角下上影阴线在 daily[-3]
    #     （05-07），导致 exhaust=False ⇒ 漏报。真实衰竭链是「放量长上影 → 反抽未收复 →
    #     第三日光头阴线」，跨度可达 2 日，必须用滑动窗口遍历而非只看前一根。
    #   ②**靶位取已失效的压力位**：res_prev=59.84 正是被 05-07 长上影否定、05-08 未收复的
    #     位置，把它当靶位得 b=3.07 ⇒ edge=+0.71，掩盖 p=0.42<p_gate 的准入否决 ⇒
    #     决策从卖出翻成持有。靶位折价到 close+1.0·ATR（58.13）后 b=1.67、edge 转负 -0.09。
    #   判别力实测：仅修 ①（窗口）不够（p 降但 edge 仍正）；仅修 ②（折价）也不够（exhaust
    #     未触发）；**两者必须同时**才能翻转决策 ⇒ 属「两处独立缺陷互相掩盖」型 bug。
    "exhaust_confirm_bars": 2, # 衰竭确认窗口：在最近 2 根阴线中找放量长上影，看其后是否收复
    "target_cap_atr": 1.0,    # 衰竭（exhaust）时靶位封顶 = close + 该值·ATR：已失效的压力位不配当赔率锚
    # ── 第 16 步纠错（本局第 3 轮实盘：买入 sz.301299 300 股 @58.07，D+1 收 56.69，
    #   浮亏 −414、总资产 104,415→104,001，trade_quality 59.5/100）─────────────
    #   事实链（D=05-14）：收 58.74、high 59.74 > res_prev 59.25（**日内穿刺前高**）但
    #     close 58.74 **未站上** 59.25；量 276.6 万 = 1.55×前 5 日均量 178.6 万（放量）。
    #     D+1=05-15：开 58.07、高 58.40、低 56.67、收 56.69（−3.49%）⇒「放量冲高、收盘被
    #     压回箱体内」是**供给证据**，不是突破确认。
    #   失败根因（策略层，非运气、非报价）：p 公式对「日内穿刺前高、收盘被压回」**完全不敏**
    #     ——pos_adj 只在 close > res_prev 时给 +0.06，穿刺失败既不加也不减；唯一防线只剩
    #     squeeze，而 squeeze 在决策时被人工以「high 已越上沿 = 正在突破」为由覆盖掉 ⇒ 建仓即亏。
    #   元教训：squeeze 是用历史实测标定的硬否决，**不得用单根 K 线的 high 穿刺去覆盖**；
    #     箱体上沿的日内穿刺在 A 股是典型假突破，突破须由**收盘价**确认（收盘价才是当日多空
    #     结算价，high 只是瞬时供给被吃掉又吐回的痕迹）。覆盖一项硬否决需第二个独立样本。
    #   修正（三条，互相独立、不可被 Δπ 覆盖）：
    #     ① 新增独立证据 failed_breakout = high>res_prev ∧ close<res_prev ∧ 量≥阈值；
    #     ② 进入 p（−fb_pen），使其即便在 squeeze 不成立时也压低期望 ⇒ 退出/拒入由「期望」而非
    #        「形态命名」驱动；
    #     ③ 空仓侧硬否决 + 契约守卫断言 buy_blocked_by_false_breakout ⇒ 即便覆盖 squeeze 也拦不住。
    #   与 exhaust 的分工（**禁止合并成一条扣分**，避免同一形态被重复计罚）：
    #     · failed_breakout：high>前高 ∧ close<前高 ∧ 放量（跨「前高」这一结构位的失败）；
    #     · exhaust：放量长上影**阴线**（(high−close)/(high−low)≥0.5）+ 后续未收复其高点
    #       （单根 K 线内部的冲高回落 + 次日确认）。
    #   边界：close ≥ res_prev（真突破成立，收盘确认）时不惩罚；量未达门槛（缩量上影）不算。
    "fb_pen": 0.06,          # 假突破（日内穿刺前高、收盘被压回）+放量 ⇒ p 下修
    "fb_vol_mult": 1.35,     # 假突破的放量门槛（×前 5 日均量），与 boom day/放量阳线口径一致
    # ── 第 17 步纠错（本轮第 2/2 次推进：持有 300 股未换手，05-16 收 56.08，浮亏 −414→−597）──
    #   事实：05-15 是**缩量光头阴线**——收 56.69 ≈ 当日低 56.67（close_pos =
    #   (56.69−56.67)/(58.40−56.67) = 0.01），即尾盘无承接、全天由卖方主导。
    #   盲点：原 p 的六个组成项（mtf_pen/pos_adj/mom_adj/vol_adj/noise_pen/exh/fb）中
    #   **没有任何一项度量「收盘质量」**——pos_adj 只看收盘相对 sup/res 的位置，不看它在
    #   **当日区间**内的位置 ⇒ 「收在最低的阴线」与「收在最高的阳线」可以拿到同样的 p
    #   （05-15 的 p=0.47 就是此盲点的产物）。
    #   抽象（本轮最重要的方法论转向）：形态命名（放量阳线/缩量回调/长上影）是**离散的、
    #   可被事后解释绕开的**；应改为连续度量 close_pos = (close−low)/(high−low) ∈ [0,1]，
    #   把「尾盘强弱」这一唯一真实的日内信息（收盘价=当日多空结算价）纳入定价。
    #   只罚不奖（asymmetric）的三条理由：
    #     ① 证据方向只在低端（两次实亏都发生在弱收盘侧），高端尚无第二独立样本
    #        （L0 原则：形态加分项须待第二独立样本再标定权重）；
    #     ② 对称修正会**翻转第 14 步回归样本**（05-08 close_pos=0.70 会拿到 +0.016 ⇒
    #        p 0.50→0.52 ⇒ edge 由 −0.17 转 +0.38 ⇒ 衰竭清仓失效）——风险项必须在回归
    #        夹具上无副作用；③ 只罚符合「不确定性打折」的保守原则：无证据不给奖励。
    #   互斥边界：exhaust 与 failed_breakout 已成立时不再叠加（同一根 K 线的弱势不得双扣）。
    "cl_pos_pen": 0.05,      # 收盘贴当日最低（close_pos ≤ 阈值）⇒ p 下修
    "cl_pos_thresh": 0.20,   # close_pos 触发阈值（收在区间下沿 20% 以内）
    # ── 迭代纪律（第 17 步确诊，写给未来的自己与 guard）─────────────────────────
    #   区分「策略缺陷」与「方差成本」的**唯一判据 = 用事前可得信息重算该决策的期望符号**：
    #     · 05-14 建仓是**缺陷**：放量穿刺前高而收盘被压回（fb 证据），事前就可算出该形态
    #       的 p 应下修 ⇒ 期望本应为负 ⇒ 修（第 16 步已修）；
    #     · 05-15 持有是**成本而非缺陷**：p=0.47 > (win+flat)/(win-loss)=0.4 ⇒ 事前期望
    #       E=20·0.47−10 = −0.6 > −2（卖出锁定 −2）⇒ 持有在打分框架下仍是正确动作，亏损属方差。
    #   禁令：**不得用单次结果回头改阈值、也不得把「持有」升级为硬性卖出规则**——那正是
    #     「单次结果≠规律」所禁止的过拟合，且会把策略推向高频换手（每次换手都需重新抓一次
    #     入场时点，风报比反而下降）。本步只补「事前确实缺失的信息维度」（收盘质量），
    #     不因盈亏方向调参数。
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


def _upper_shadow_exhaust(daily: Sequence[KLineBar]) -> bool:
    """冲高衰竭（顶部结构）判定：前一日「放量长上影阴线」+ 当日未收复其最高价。

    两条**独立**确认，缺一不可（单条皆为常见噪音，组合才是结构证据）：
      ① 供给证据（滑动窗口内的 prior  bar，k=1…exhaust_confirm_bars）：冲高回落比
         (high−close)/(high−low) ≥ exhaust_fall_frac，且收阴（close < open），
         且量 ≥ exhaust_vol_mult × 其前 4 日均量；
      ② 确认证据（prior 之后**到当日为止**的每一根）：最高价 < prior 最高价 ⇒ 反抽未收复上影高点。
    语义：①说明上攻被抛压打回，②说明后续买盘不足以推翻该结论 ⇒「弱信号」应按 p 下修处理，
    而非按「无信号」处理（无信号=中性=持有，是本文件第 14 步纠错的失败模式）。
    第 15 步将确认窗口由 1 日扩到 exhaust_confirm_bars 日：真实衰竭链
    「放量长上影 → 反抽未收复 → 第三日光头阴线」跨度可达 2 日，只看 daily[-2] 会漏报
    （05-09 视角下上影阴线位于 daily[-3]）。滑动窗口遍历 k，取首个成立者即为衰竭。
    仅用到决策日收盘前的历史 bar，无未来函数。
    """
    if len(daily) < 6:
        return False
    for k in range(1, int(_CFG["exhaust_confirm_bars"]) + 1):
        idx = len(daily) - 1 - k
        start = idx - 4
        if idx <= 0 or start < 0 or k >= len(daily):
            break
        prior = daily[idx]
        pr_high = float(prior.get("high") or 0.0)
        pr_low = float(prior.get("low") or 0.0)
        pr_open = float(prior.get("open") or 0.0)
        pr_close = float(prior.get("close") or 0.0)
        rng = pr_high - pr_low
        if rng <= 0 or pr_close >= pr_open:            # 非阴线 ⇒ 无「冲高回落」可言
            continue
        ref_vols = [float(b.get("volume") or 0.0) for b in daily[start:idx]]
        ref_vol = (sum(ref_vols) / len(ref_vols)) if ref_vols else 0.0
        pr_vol = float(prior.get("volume") or 0.0)
        if ref_vol <= 0 or pr_vol < _CFG["exhaust_vol_mult"] * ref_vol:
            continue
        if (pr_high - pr_close) / rng < _CFG["exhaust_fall_frac"]:
            continue
        confirm = daily[idx + 1:]                     # prior 之后到当日为止的全部 bar
        if confirm and all(float(b.get("high") or 0.0) < pr_high for b in confirm):
            return True
    return False


def _failed_breakout(daily: Sequence[KLineBar], res_prev: float,
                     vol_mult: Optional[float] = None) -> bool:
    """假突破（箱体上沿「日内穿刺、收盘被压回」+ 放量）= 供给证据。

    这是第 16 步实盘亏损的直接病灶：05-14 high 59.74 > res_prev 59.25、close 58.74 < 59.25、
    量 1.55×前 5 日均量，D+1 即 −3.49%。原 p 公式对此**完全不敏**（pos_adj 只奖励
    close > res_prev 的真突破，穿刺失败不给任何惩罚），唯一防线 squeeze 又允许被
    「high 已越上沿」单根证据覆盖 ⇒ 必须把它做成独立证据并独立否决。

    判定边界（三条全真才成立，缺一不可）：
      ① high > res_prev      —— 当日确实冲到/越过前 3 日高点（有需求方出现）；
      ② close < res_prev     —— 收盘价（当日多空结算价）未能站上，即供给把价格压回；
      ③ vol ≥ fb_vol_mult×前 5 日均量 —— 是「放量被打回」而非无量假阴/无事发生。
    反向边界：close ≥ res_prev（收盘确认的真突破）不惩罚；缩量上影归 exhaust 的辖区
    （见 _upper_shadow_exhaust），两条证据**不合并扣分**，避免同一形态被重复计罚。
    仅消费决策日收盘前的 bar，无未来函数。
    """
    mult = _CFG["fb_vol_mult"] if vol_mult is None else float(vol_mult)
    if len(daily) < 6 or res_prev <= 0:
        return False
    last = daily[-1]
    hi = float(last.get("high") or 0.0)
    cl = float(last.get("close") or 0.0)
    if hi <= res_prev or cl >= res_prev:
        return False
    ref = [float(b.get("volume") or 0.0) for b in daily[-6:-1]]
    ref_vol = (sum(ref) / len(ref)) if ref else 0.0
    vol = float(last.get("volume") or 0.0)
    return bool(ref_vol > 0 and vol >= mult * ref_vol)


def _target_position(close: float, sup_prev: float, res_prev: float,
                     gap_lower: Optional[float], gap_upper: Optional[float],
                     atr: float, mtf_down: bool, shrink: bool, expand: bool,
                     total_value: float, gap_age: Optional[int] = None,
                     mtf_n: Optional[int] = None, mom_up: bool = False,
                     exhaust: bool = False, failed_breakout: bool = False,
                     close_pos: Optional[float] = None) -> Dict[str, float]:
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
    res_break = close > res_prev                       # 真突破压力位（区别于「收复缺口下沿」）
    trail_ok = res_break or (gap_lower is not None and close >= gap_lower)
    if res_break:
        # 只有**真实突破** res_prev 才把止损 trail 到 res_prev 下方；仅「收复缺口下沿」不构成
        # 突破证据，原式共用 trail_ok 会把 stop 抬到 res_prev·0.995 ⇒ 出现 stop > close 的
        # 退化区间（风险距离变负，只能靠 vol_floor 兜底），feats 里的 stop 也会误导复盘。
        stop = max(stop, res_prev * _CFG["trail_ratio"])   # 突破确认 → 移动止损上移
    if gap_lower and close >= gap_lower:
        stop = max(stop, gap_lower * 0.99)                  # 收复缺口 → 止损再上移至缺口下沿
    vol_floor = max(_CFG["atr_stop_mult"] * atr, _CFG["min_stop_pct"] * close)
    risk = max(close - stop, vol_floor, 0.01 * close)
    if gap_upper and close < gap_upper:
        target = gap_upper                          # 缺口未回补 → 回补目标（赔率锚）
    else:
        target = max(res_prev, close + 1.5 * atr)
    # 衰竭靶位折价（第 15 步）：若 res_prev 已被「放量长上影 + 后续未收复」否定，它就不再是
    # 可达靶位。把它继续当赔率锚会系统性高估 b（05-09 实测 b=3.07 ⇒ edge=+0.71，恰好掩盖
    # p=0.42 < p_gate 的准入否决，使决策从「卖出」翻成「持有」）。折价口径取 close+1.0·ATR。
    if exhaust:
        target = min(target, close + _CFG["target_cap_atr"] * atr)
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
    # 冲高衰竭惩罚（第 14 步）：见 _CFG["exhaust_pen"] 旁的失败模式记录。要在**存量端**
    # 生效，唯一干净的入口就是把 p 压下去使 edge 转负 —— 退出路径从「Δπ ≤ −12% 超配漂移」
    # 变为「edge ≤ 0 负期望」，后者不含任何仓位前提，故轻仓同样能触发。
    exh_pen = -_CFG["exhaust_pen"] if exhaust else 0.0
    # 假突破惩罚（第 16 步）：见 _CFG["fb_pen"] 旁的实盘记录。它回答的是「前高被日内穿刺、
    # 收盘却被压回」这一类**结构位失败**，与 exhaust 的「单根 K 线长上影 + 未收复」互补。
    fb_pen = -_CFG["fb_pen"] if failed_breakout else 0.0
    # 收盘质量惩罚（第 17 步）：close_pos = (close−low)/(high−low)。
    # 与 exhaust / failed_breakout 互斥：同一根 K 线的弱势只计一次，避免双扣。
    cl_pen = 0.0
    if (close_pos is not None and not exhaust and not failed_breakout
            and close_pos <= _CFG["cl_pos_thresh"]):
        cl_pen = -_CFG["cl_pos_pen"]
    # 大级别惩罚按空头周期数分档；mtf_n=None 时回退旧语义，保证历史回放可复现
    if mtf_n is None:
        mtf_pen = -0.12 if mtf_down else 0.0
    else:
        mtf_pen = -0.12 if mtf_n >= 2 else (-_CFG["mtf_one_pen"] if mtf_n == 1 else 0.0)
    p = _clip(0.5 + mtf_pen + pos_adj + mom_adj + vol_adj + noise_pen + exh_pen + fb_pen
              + cl_pen - gap_decay, 0.30, 0.70)
    # 箱体收缩：站于箱体之内且箱体高度不足 range_squeeze·ATR ⇒ 方向未定，禁止加仓
    box = res_prev - sup_prev
    squeeze = bool(box > 0 and box < _CFG["range_squeeze"] * atr and sup_prev <= close <= res_prev)

    edge = p * b - (1.0 - p)                      # 单位风险期望收益（赔率单位）
    kelly = edge / b if edge > 0 else 0.0
    pi_risk_cap = ((total_value * _CFG["risk_budget_pct"] / 100.0) / risk) * close / total_value
    raw = min(kelly, pi_risk_cap, _CFG["pi_max"])          # 未被机会成本项抬升前的原始最优
    pi_star = _clip(raw, 0.0, _CFG["pi_max"])
    # ── 准入层 / 配额层解耦（关键顺序） ────────────────────────────────
    #   准入层（admit）只回答「**该不该放**」：三闸门 AND
    #       edge ≥ weak_edge(0.05) ∧ p ≥ p_gate(0.50) ∧ ¬squeeze；
    #   配额层（kelly / pi_risk_cap / pi_max）只回答「**该放多大**」，
    #       仅在准入通过后才被消费。两者短路即失败模式：
    #       kelly 侧 Δπ ≥ eff_buy_band 被当成放行条件 = 把配额当准入（买在收缩箱体上沿）。
    admit = bool(edge >= _CFG["weak_edge"] and p >= _CFG["p_gate"] and not squeeze)
    floor_on = admit   # 向后兼容别名：deploy_floor 抬升同样只在准入通过时生效
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
            "admit": admit, "fb_pen": fb_pen, "failed_breakout": bool(failed_breakout),
            "cl_pen": cl_pen, "close_pos": (round(close_pos, 3) if close_pos is not None else None),
            "mom_adj": mom_adj, "mtf_pen": mtf_pen}


def _decide_core(ctx: TradeContext) -> TradeDecision:
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
        申报（申报价 ≠ 成交价；第 16 步用实盘校准，**废弃旧的「[low, high] 闭区间闸门」说法**）：
                    D 收盘出决策 → D+1 成交，实测模型为
                      买入：成交条件 = 申报价 ≥ D+1 low；成交价 = min(申报价, D+1 开盘)
                      卖出：成交条件 = 申报价 ≤ D+1 high；成交价 = max(申报价, D+1 开盘)
                    证据：D=05-14 报买 60.14（高于 D+1 全部价位），D+1 成交价 58.07 = 当日开盘，
                    且当日 high 58.40 < 60.14 仍**未失效** ⇒ 闸门不含「申报≤high」；反例（第 13 步）
                    报买 55.21 遇向上跳空失效 ⇒ 闸门含「申报≥low」。
                    推论：抬价**不改变成交价**（开盘价压住），仅把成交窗口由 low≤close 扩到
                    low≤申报 ⇒ 唯一效果是覆盖「强势跳空日(low>close)」，属净收益；而低开下跌日
                    low≤close 恒真 ⇒ **无论报价高低都会成交**。结论：报价层无法提供下跌保护，
                    「跌日报价高就不成交」是伪安全（第 16 步的修正因此落在 p 与硬否决，不是带宽）。
                    仓位折算仍锚定最近收盘价；双向宽容带 band=max(0.6·ATR, 2%·close) 保留。
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
    exhaust = _upper_shadow_exhaust(daily)     # 第 14 步：放量长上影阴线 + 未收复其高点 ⇒ 衰减
    # 第 16 步：前高被日内穿刺、收盘却被压回 + 放量 = 假突破（供给证据）
    failed_breakout = _failed_breakout(daily, res_prev)
    # 第 17 步：收盘在当日区间中的位置（尾盘强弱）。high==low 时无信息 ⇒ None（不惩罚）
    hi_last = float(last.get("high") or 0.0)
    lo_last = float(last.get("low") or 0.0)
    close_pos = ((close - lo_last) / (hi_last - lo_last)) if hi_last > lo_last else None

    tp = _target_position(close, sup_prev, res_prev, gap_lower, gap_upper,
                          atr, mtf_down, shrink, expand, total_value, gap_age,
                          mtf_n=mtf_n, mom_up=mom_up, exhaust=exhaust,
                          failed_breakout=failed_breakout, close_pos=close_pos)

    def _order_px(side: int) -> float:
        """申报价：side +1 买入 / −1 卖出（**成交触发位，不是成交价**）。

        执行层撮合规则（第 16 步用实盘回执校准后的口径；旧的「申报价须落入 D+1 的
        [low, high] 闭区间」描述与实测矛盾，已废弃）：
            买入：成交条件 = 申报价 ≥ D+1 low；  成交价 = min(申报价, D+1 开盘)
            卖出：成交条件 = 申报价 ≤ D+1 high； 成交价 = max(申报价, D+1 开盘)
        校准证据（同一笔交易同时给出两个方向的信息）：
          · 报买 60.14 / 成交 58.07（= 当日开盘），而当日 high 58.40 < 60.14 却**未失效**
            ⇒ 闸门不可能含「申报 ≤ high」（否则整笔失效）；成交价 = min(申报, 开盘) 成立。
          · 反例（第 13 步）：报买 55.21 遇向上跳空（low > 55.21）失效 ⇒ 闸门含「申报 ≥ low」。
        由上面两条得出的报价学（本轮不再动带宽的根据）：
          · 抬价**不改变成交价**（成交价被开盘价压住），只把触发窗从 low≤close 扩到 low≤申报；
            两者差别仅在「low > close」的日子（强势跳空上涨日）——抬价能覆盖那些日子，属净收益。
          · 低开下跌日 low≤close 恒真 ⇒ **报价高低无法避免成交**。即「跌日报价高就不成交」
            是伪安全（本局第 3 轮实盘即如此：报 60.14、D+1 低开 58.07 立即成交、收 56.69）。
          · 因此下跌风险只能由**方向判据（p / 硬否决）**承担，不能寄望于报价层过滤。
        边界：band 只由当日可知的 ATR 与 close 决定（无未来信息）；整体受 ±9.5% 限幅约束。
        """
        band = max(_CFG["gap_tol_atr"] * atr, _CFG["gap_tol_pct"] * close)
        drift = _CFG["order_slip_atr"] * atr if ((side > 0 and mom_up) or (side < 0 and mtf_down and not mom_up)) else 0.0
        lim = 0.095 * close
        return round(_clip(close + side * (band + drift), close - lim, close + lim), 2)

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
             "floor_on": tp["floor_on"], "admit": tp["admit"], "risk": round(tp["risk"], 3),
             "b": round(tp["b"], 3), "p": round(tp["p"], 3), "edge": round(tp["edge"], 3),
             "kelly": round(tp["kelly"], 3), "pi_risk_cap": round(tp["pi_risk_cap"], 3),
             "pi_star": round(pi_star, 3), "pi_cur": round(pi_cur, 3), "delta_pi": round(delta, 3),
             "pi_gap": round(pi_cur - pi_star, 3), "under_target": bool(pi_cur > pi_star + 1e-12),
             "binding": tp["binding"], "stop": round(tp["stop"], 3), "trail_ok": tp["trail_ok"],
             "min_pi_step": round(min_pi_step, 4), "min_eff_delta": round(min_eff_delta, 4),
             "eff_buy_band": round(eff_buy_band, 4), "eff_sell_band": round(eff_sell_band, 4),
             "vol_shrink": shrink, "vol_expand": expand, "mtf_down": mtf_down,
             "mtf_n": mtf_n, "mom_up": mom_up, "mom_adj": round(tp["mom_adj"], 3),
             "exhaust": exhaust, "failed_breakout": failed_breakout,
             "close_pos": (round(close_pos, 3) if close_pos is not None else None),
             "cl_pen": round(tp["cl_pen"], 3),
             "cooldown_mult": cooldown_mult, "add_scale": round(add_scale, 2),
             "cash": cash, "total_value": total_value}

    def _lot(budget_value: float, price: Optional[float] = None) -> int:
        """按整百股取整的可买数量：受现金与给定金额预算双重约束。
        现金校验用**申报价**（申报价高于锚价时同样要付得出钱）。"""
        p_ = float(price or px)
        budget = min(budget_value, cash)
        if p_ <= 0 or budget < p_ * 100 or cash < p_ * 100:
            return 0
        # 浮点地板必须带 eps：budget = 200×55.21 时 11042.0 // 55.21 == 199.0（二进制表示误差）
        # ⇒ 少买整整一手（200→100 股），执行层收到的仓位低于策略意图且无任何报错信号。
        lots = int(math.floor(budget / p_ / 100.0 + 1e-9)) * 100
        if lots < 100 and budget >= p_ * 50 and cash >= p_ * 100:
            lots = 100
        return lots if lots * p_ <= cash else 0

    def _target_qty(pi: float, price: Optional[float] = None) -> int:
        """把目标仓位折算为整百股持股数（增量由目标持股数 − 当前持股数得出，
        避免用 Δπ·total_value 再除价取整造成的单侧截断损耗）。折算锚定最近收盘价。"""
        p_ = float(price or px)
        if p_ <= 0 or pi <= 0:
            return 0
        return int(math.floor(pi * total_value / p_ / 100.0 + 1e-9)) * 100   # 同上：地板带 eps

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
            # 准入层先于配额层（第 12 步纠错：kelly 答「该放多大」、不答「该不该放」）：
            # 三闸门未过 → 直接产出不动仓类枚举，**不得**被 kelly 侧 Δπ≥eff_buy_band 短路。
            # 对应形态学证据：p<p_gate = 低胜率高赔率赌注的长尾实现频率低而每日独立结算失分；
            # squeeze = 箱体上沿追多（方向未定）。减仓侧不受此闸门限制。
            if not tp["admit"]:
                return _dec(DECISION_HOLD, 0.0, 0, CONF_MID,
                            "配额层 Δπ=+%.1f%% ≥ %.1f%% 已达标，但准入三闸门未过（edge=%.2f｜p=%.2f vs %.2f｜squeeze=%s）"
                            "⇒ 仓位可放大≠应当放大，本次不动仓"
                            % (delta * 100, eff_buy_band * 100, tp["edge"], tp["p"],
                               _CFG["p_gate"], tp["squeeze"]), **feats)
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
            px_ord = _order_px(+1)
            # 预算与单价的**计价单位必须一致**（第 13 步）：旧式 `want_q·px(锚价)` 再除以
            # 申报价，一旦申报价带上宽容带（>锚价）就会凭空少买一手（want_q=200 ⇒ 实取 100）。
            # 正确口径：预算 = 期望股数 × **申报价**，再按申报价整除整手。
            q = _lot(want_q * px_ord, px_ord) if want_q >= 100 else 0
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
        if pi_cur > pi_star + 1e-12:
            # 「该减不减」边界（超配但未达减仓带）：单步 |Δπ| 小 ≠ 无漂移 —— 若 π* 逐日下移
            # 而每步差值都 < eff_sell_band，仓位会长期停在目标之上（该减不减的累积漂移）。
            # 可判定信号（本轮只登记、不改行为）：feats 的 under_target / pi_gap；下一轮建议
            # 在 ctx["memory"] 传入 last_pi_star，当 π* 连续下移且 pi_gap > 1.5×min_pi_step 时
            # 把 eff_sell_band 换成「按 π* 斜率缩放」的动态带——而非现在直接放宽固定 12% 带
            # （放宽固定带会同时削弱「风险敞口失控」的硬减仓信号，属拆东墙补西墙）。
            return _dec(DECISION_HOLD, 0.0, 0, CONF_MID,
                        "当前仓位 %.0f%% 高于目标 %.0f%%（超配 %.1f%%）但未达减仓带 %.0f%%："
                        "超配未达带时持有，漂移由 under_target/pi_gap 监控（见 _CFG[p_gate] 旁注）"
                        % (pi_cur * 100, pi_star * 100, (pi_cur - pi_star) * 100,
                           eff_sell_band * 100), **feats)
        return _dec(DECISION_HOLD, 0.0, 0, CONF_MID,
                    "当前仓位已在目标仓位带内（|Δπ|=%.1f%% < 阈值），持有是仓位已达标而非惰性"
                    % (abs(delta) * 100), **feats)

    # ── 空仓 ──────────────────────────────────────────────────────────────
    # 第 16 步硬否决（前置于一切建仓路径）：箱体上沿「日内穿刺、收盘被压回」+ 放量。
    # 为何必须是硬否决而非仅靠 p：①它是本局唯一产生**已实现亏损**的入场形态（05-14→05-15 −414）；
    # ②它独立于 squeeze（squeeze 描述箱体高度，本项描述当日供给），故覆盖 squeeze 也不能绕过。
    if failed_breakout:
        return _flat(True, CONF_MID,
                     "当日 high 越前高 %.2f 但收盘被压回箱体内（假突破/上影供给），且放量 ⇒ "
                     "不追高；等**收盘**站上 res_prev 再建仓（不拿 high 穿刺当突破确认）"
                     % res_prev, **feats)
    if close < sup_prev and mtf_down:
        return _flat(True, CONF_MID, "已跌破前3日低点且月/周线空头，破位下跌中不建仓，等站回结构位", **feats)
    # 空仓：开仓与加仓受同一套闸门约束（逐日结算下低胜率开仓同样放大负分天数）
    if tp["edge"] > 0 and tp["floor_on"] and not (_CFG["momentum_veto"] and mtf_down and not mom_up):
        px_ord = _order_px(+1)
        q = _lot(_target_qty(pi_star) * px_ord, px_ord)   # 同上：预算按申报价计
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


# ══════════════════════════════════════════════════════════════════════════════
# 决策契约守卫（价格语义 / fill 规则 / 零值·整手 三项硬断言）
# ----------------------------------------------------------------------------
# 为何必须**可执行**而非仅写在注释里：决策 JSON 直接喂给 /api/step，三项语义一旦漂移
# （把申报价当成交价调参、非交易枚举带价、买入手数非整百），报错发生在**执行层**，
# 表现为「整笔失效 success=false 却仍白耗一日」，与「判断错误」完全混同 ⇒ 事后无法归因。
# ══════════════════════════════════════════════════════════════════════════════

def _contract_violations(d: TradeDecision, ctx: TradeContext) -> List[str]:
    """三项契约断言 → 违规清单（空列表 = 合规）。

    ① **价格语义**：tradePrice = 申报价（限价锚），既不是成交价也不是价格区间；
       非交易枚举必须价量双零（0.0 / 0，不得为 None）。
    ② **fill 规则**：成交价由 D+1 限价撮合给出（买 min(申报, 次日开盘) / 卖 max(申报, 次日开盘)），
       本层无法也不知道 D+1 极值 ⇒ 只能断言「申报价落在以 D 收盘为锚的 ±9.5% 限幅窗内」；
       且明确禁止把 fill 与申报价的差额当滑点回灌（差额属撮合语义，不是缺陷信号）。
    ③ **零值·整手**：买入 qty%100==0 ∧ 申报价×qty ≤ 可用现金；卖出 qty%100==0 ∧ qty ≤ 持仓。
    """
    v: List[str] = []
    dec = str(d.get("decision") or "")
    price = float(d.get("tradePrice") or 0.0)
    qty = int(d.get("tradeQuantity") or 0)
    conf = str(d.get("confidence") or "")
    daily = list(((ctx.get("kline") or {}).get("daily") or []))
    close = float((daily[-1].get("close") if daily else 0.0) or 0.0)
    account = ctx.get("account") or {}
    cash = float(account.get("cash") or 0.0)
    qty_held = int((((account.get("position") or {}) or {}).get("quantity") or 0))

    if dec not in DECISIONS:
        v.append("decision_not_in_enum:%s" % dec)
    if conf not in CONFIDENCES:
        v.append("confidence_not_in_enum:%s" % conf)

    if dec in (DECISION_BUY, DECISION_SELL):
        # ① 价格语义
        if not (price > 0):
            v.append("trade_price_must_be_positive")
        elif round(price, 2) != price:
            v.append("trade_price_not_2dp")
        # ② fill 规则（申报价必须落在可成交放宽窗内）
        if close > 0 and not (0.905 * close - 1e-9 <= price <= 1.095 * close + 1e-9):
            v.append("order_px_outside_pct_limit")
        # ③ 零值·整手
        if qty <= 0 or qty % 100 != 0:
            v.append("qty_not_lot_100")
        if dec == DECISION_BUY and price * qty > cash + 1e-6:
            v.append("buy_exceeds_cash")
        if dec == DECISION_SELL and qty > qty_held:
            v.append("sell_exceeds_holdings")
    else:
        if price != 0.0 or qty != 0:
            v.append("flat_decision_must_zero_price_qty")

    # ④ **准入反例断言**（第 12 步）：准入层是买入/加仓的前置必要条件，
    #    故「p<p_gate」或「squeeze=True」下的任何买入产出都必须被判违规——
    #    即使 kelly 配额（Δπ ≥ eff_buy_band）已达标也不得放行。
    snap = d.get("featureSnapshot") or {}
    p_snap = snap.get("p")
    sq_snap = snap.get("squeeze")
    if dec == DECISION_BUY:
        if p_snap is not None and float(p_snap) < _CFG["p_gate"] - 1e-9:
            v.append("buy_blocked_by_p_gate:p=%.2f<%.2f" % (float(p_snap), _CFG["p_gate"]))
        if sq_snap is True:
            v.append("buy_blocked_by_squeeze")
    # ⑥ **假突破反例断言**（第 16 步）：日内穿刺前高、收盘未站上且放量的当日，任何买入产出都
    #    必须被判违规。理由：该形态是本局唯一产生已实现亏损（−414）的入场，而 p 公式对其原本
    #    完全不敏，唯一防线 squeeze 可被「high 已越上沿」这一单根证据覆盖 ⇒ 必须让守卫独立拦住，
    #    使「覆盖 squeeze」不再能绕过风控（R7：在输出层把元规则做成结构约束）。
    if dec == DECISION_BUY and snap.get("failed_breakout") is True:
        v.append("buy_blocked_by_false_breakout")
    # ⑤ **可成交性断言**（第 13 步）：申报价必须带宽容带，不得退回「贴锚价」
    #    失败模式：锚价申报在 D+1 跳空日整笔失效 ⇒ 仓位不变、白耗一日、方向对而收益不落地。
    #    本层无法知道 D+1 的 [low, high]，但 band 只依赖当日可知的 ATR/close ⇒ 可断言。
    if dec in (DECISION_BUY, DECISION_SELL) and len(daily) >= 2 and close > 0:
        band = max(_CFG["gap_tol_atr"] * _atr(daily, int(_CFG["atr_window"])),
                   _CFG["gap_tol_pct"] * close)
        if dec == DECISION_BUY and price < close + band - 0.01:
            v.append("order_px_stale_anchor_buy:<%.2f" % (close + band))
        if dec == DECISION_SELL and price > close - band + 0.01:
            v.append("order_px_stale_anchor_sell:>%.2f" % (close - band))
    return v


def decide(ctx: TradeContext) -> TradeDecision:
    """稳定 ABI 入口：_decide_core 产出 → 契约守卫 → （违规时）安全降级。

    守卫失败一律降级为「不动仓」，**不抛异常**：执行层对抛错无兜底，宁可吃一次
    零变动失分（外生、可归因），也不能让整轮拿不到可解析的决策 JSON。
    """
    d = _decide_core(ctx)
    viol = _contract_violations(d, ctx)
    if not viol:
        return d
    account = ctx.get("account") or {}
    qty_held = int((((account.get("position") or {}) or {}).get("quantity") or 0))
    snap = dict(d.get("featureSnapshot") or {})
    snap["contract_violations"] = viol
    snap["blocked_decision"] = d.get("decision")
    return {"decision": DECISION_HOLD if qty_held > 0 else DECISION_WATCH,
            "tradePrice": 0.0, "tradeQuantity": 0, "confidence": CONF_LOW,
            "reasoning": "契约守卫拦截(%s)，降级为不动仓" % ",".join(viol),
            "featureSnapshot": snap}


# ══════════════════════════════════════════════════════════════════════════════
# 自测入口：`python3 trade.py` ⇒ 契约守卫 + 冒烟（可作变更后的等价性前置门禁）
# ══════════════════════════════════════════════════════════════════════════════

def _selfcheck() -> bool:
    ok = True
    daily = [dict(open=51.90, high=53.77, low=51.75, close=52.55, volume=2376200),
             dict(open=52.55, high=53.63, low=51.80, close=52.90, volume=1702500),
             dict(open=53.97, high=54.80, low=53.60, close=54.08, volume=1487800),
             dict(open=53.60, high=54.99, low=53.17, close=53.43, volume=1419300),
             dict(open=53.81, high=54.16, low=51.66, close=52.92, volume=1651400),
             dict(open=52.64, high=54.17, low=52.37, close=53.30, volume=1370200),
             dict(open=53.78, high=54.19, low=52.95, close=53.18, volume=1207500),
             dict(open=52.95, high=54.87, low=52.33, close=54.73, volume=1578500),
             dict(open=54.70, high=55.48, low=54.12, close=54.18, volume=1591200),
             dict(open=54.73, high=55.60, low=54.11, close=55.35, volume=1729600),
             dict(open=55.71, high=55.71, low=53.37, close=53.69, volume=1443400),
             dict(open=54.42, high=55.78, low=53.77, close=54.93, volume=1659100)]
    weekly = [dict(open=61.25, high=61.89, low=58.48, close=58.80),
              dict(open=52.34, high=54.95, low=43.85, close=52.90),
              dict(open=53.97, high=54.99, low=51.66, close=53.18),
              dict(open=52.95, high=55.78, low=52.33, close=54.93)]
    held = dict(cash=86988.0, total_value=103467.0,
                position=dict(symbol="sz.301299", quantity=300, cost_price=53.70,
                              market_value=16479.0))
    empty = dict(cash=103467.0, total_value=103467.0, position=None)
    cases = [("带仓", dict(kline=dict(daily=daily, weekly=weekly, monthly=[]), account=held)),
             ("空仓", dict(kline=dict(daily=daily, weekly=weekly, monthly=[]), account=empty)),
             ("数据不足", dict(kline=dict(daily=daily[:3], weekly=[], monthly=[]), account=empty))]
    for label, ctx in cases:
        d = decide(ctx)
        viol = _contract_violations(d, ctx)
        ok = ok and not viol
        print("[%s] %s: %s px=%s qty=%s conf=%s viol=%s" %
              ("OK" if not viol else "FAIL", label, d["decision"], d["tradePrice"],
               d["tradeQuantity"], d["confidence"], viol))
        ok = ok and d["decision"] in DECISIONS and d["confidence"] in CONFIDENCES
    # 负例：故意构造违规决策，守卫必须能抓到
    bad = {"decision": DECISION_BUY, "tradePrice": 54.93, "tradeQuantity": 150,
           "confidence": CONF_MID}
    viol = _contract_violations(bad, cases[0][1])
    ok = ok and "qty_not_lot_100" in viol
    print("[%s] 负例(150股)命中 qty_not_lot_100" % ("OK" if "qty_not_lot_100" in viol else "FAIL"))
    bad2 = {"decision": DECISION_HOLD, "tradePrice": 54.93, "tradeQuantity": 0,
            "confidence": CONF_MID}
    viol2 = _contract_violations(bad2, cases[0][1])
    ok = ok and "flat_decision_must_zero_price_qty" in viol2
    print("[%s] 负例(持有带价)命中 flat_decision_must_zero_price_qty"
          % ("OK" if "flat_decision_must_zero_price_qty" in viol2 else "FAIL"))
    # 负例（第 12 步新增）：配额达标但**准入未过**的买入产出必须被拦
    bad3 = {"decision": DECISION_BUY, "tradePrice": 56.50, "tradeQuantity": 200,
            "confidence": CONF_MID, "featureSnapshot": {"p": 0.49, "squeeze": True}}
    viol3 = _contract_violations(bad3, cases[0][1])
    hit_gate = any(x.startswith("buy_blocked_by_p_gate") for x in viol3)
    hit_sq = "buy_blocked_by_squeeze" in viol3
    ok = ok and hit_gate and hit_sq
    print("[%s] 负例(p=0.49&squeeze 买入)命中 %s"
          % ("OK" if (hit_gate and hit_sq) else "FAIL", viol3))
    # 正例：同一组特征下 p≥p_gate 且非 squeeze 时，同一买入决策必须放行
    good = {"decision": DECISION_BUY, "tradePrice": 56.50, "tradeQuantity": 200,
            "confidence": CONF_MID, "featureSnapshot": {"p": 0.55, "squeeze": False}}
    ok = ok and not _contract_violations(good, cases[0][1])
    print("[%s] 正例(p=0.55 非收缩 买入)准入放行"
          % ("OK" if not _contract_violations(good, cases[0][1]) else "FAIL"))
    # 负例（第 13 步新增）：锚价申报（无宽容带）必须被判为 stale_anchor 并降级不动仓
    stale = {"decision": DECISION_BUY, "tradePrice": 54.93, "tradeQuantity": 200,
             "confidence": CONF_MID, "featureSnapshot": {"p": 0.55, "squeeze": False}}
    vs = _contract_violations(stale, cases[0][1])
    ok = ok and any(x.startswith("order_px_stale_anchor_buy") for x in vs)
    dd_stale = decide(dict(kline=dict(daily=daily, weekly=weekly, monthly=[]), account=held))
    print("[%s] 负例(锚价买入)命中 %s；decide 实际产出 %s px=%s"
          % ("OK" if any(x.startswith("order_px_stale_anchor_buy") for x in vs) else "FAIL",
             vs, dd_stale["decision"], dd_stale["tradePrice"]))
    # 边界用例（本轮新增）：「超配但未达减仓带」必须落为持有，且 under_target=True（漂移可统计）
    drift_ctx = dict(kline=dict(daily=daily, weekly=[], monthly=[]),
                     account=dict(cash=102922.0 - 700 * 53.84, total_value=102922.0,
                                  position=dict(symbol="sz.301299", quantity=700,
                                                cost_price=53.70, market_value=700 * 53.84)))
    dd = decide(drift_ctx)
    s_ = dd.get("featureSnapshot") or {}
    ok_drift = (dd["decision"] == DECISION_HOLD and s_.get("under_target") is True
                and dd["tradePrice"] == 0.0 and dd["tradeQuantity"] == 0)
    ok = ok and ok_drift
    print("[%s] 边界(超配未达减仓带): %s pi_gap=%s under_target=%s"
          % ("OK" if ok_drift else "FAIL", dd["decision"], s_.get("pi_gap"), s_.get("under_target")))
    # 第 14 步回归样本（真实 sz.301299 04-18…05-08 逐日回放，复现本轮实盘失败模式）：
    # 轻仓 + 冲高衰竭 ⇒ 不得停在「超配未达带」的惰性持有。对照差分（monthly=[] 时）：
    #   修补前：p=0.58（仅 pos_adj +0.08）⇒ edge=+0.10 ⇒ 不进 edge≤0 分支；Δπ≈−4%
    #           < eff_sell_band 12% ⇒ 持有（即把回撤全额留在账上）；
    #   修补后：exhaust=True ⇒ p=0.50 ⇒ edge=−0.05 ≤ 0 ⇒ 清仓（**无需任何仓位前提**）。
    # 该差分只在轻仓时可见（300 股时两条路径都指向卖出），故必须用 light 仓位数做样本。
    ex_daily = [dict(open=53.78, high=54.19, low=52.95, close=53.18, volume=1207500),
                dict(open=52.95, high=54.87, low=52.33, close=54.73, volume=1578500),
                dict(open=54.70, high=55.48, low=54.12, close=54.18, volume=1591200),
                dict(open=54.73, high=55.60, low=54.11, close=55.35, volume=1729600),
                dict(open=55.71, high=55.71, low=53.37, close=53.69, volume=1443400),
                dict(open=54.42, high=55.78, low=53.77, close=54.93, volume=1659100),
                dict(open=54.97, high=56.06, low=53.83, close=53.84, volume=1306800),
                dict(open=52.59, high=54.40, low=52.59, close=53.83, volume=1089400),
                dict(open=54.84, high=55.88, low=53.86, close=55.21, volume=1883000),
                dict(open=55.80, high=57.00, low=55.51, close=56.96, volume=1671900),
                dict(open=58.61, high=59.84, low=56.11, close=56.61, volume=2227500),
                dict(open=56.67, high=57.78, low=56.67, close=57.45, volume=1686800)]
    ex_weekly = [dict(open=53.97, high=54.99, low=51.66, close=53.18),
                 dict(open=52.95, high=55.78, low=52.33, close=54.93),
                 dict(open=54.97, high=56.06, low=52.59, close=55.21),
                 dict(open=55.80, high=59.84, low=55.51, close=57.45)]
    ex_ctx = dict(kline=dict(daily=ex_daily, weekly=ex_weekly, monthly=[]),
                  account=dict(cash=104571.0 - 100 * 54.19, total_value=104571.0,
                               position=dict(symbol="sz.301299", quantity=100,
                                             cost_price=54.19, market_value=100 * 54.19)))
    dx = decide(ex_ctx)
    sx = dx.get("featureSnapshot") or {}
    ok_exh = (sx.get("exhaust") is True and dx["decision"] == DECISION_SELL)
    ok = ok and ok_exh
    print("[%s] 第14步回归(轻仓+冲高衰竭): %s exhaust=%s p=%s edge=%s pi_cur=%s"
          % ("OK" if ok_exh else "FAIL", dx["decision"], sx.get("exhaust"),
             sx.get("p"), sx.get("edge"), sx.get("pi_cur")))
    # 第 15 步回归样本（真实 04-21…05-09 逐日回放；两处缺陷必须同修才能翻转决策）：
    #   只修确认窗口 ⇒ exhaust=True、p=0.34，但 b 仍 3.07 ⇒ edge=+0.33 仍不退出；
    #   只修靶位折价 ⇒ exhaust=False（上影线在 daily[-3]）⇒ 折价根本不生效；
    #   同修 ⇒ p=0.34、target=58.13、b=1.67、edge=−0.09 ≤ 0 ⇒ 清仓 300 股。
    # 注意 weekly 只有 2 根时 _mtf_down 返回 False，故 monthly 必须给满 3 根（mtf_n=1），
    # 否则 p 少扣 −0.05、edge 回升至 +0.04 又会被推到「准入未过 ⇒ 持有」。
    d509 = [dict(open=52.95, high=54.87, low=52.33, close=54.73, volume=1578500),
            dict(open=54.70, high=55.48, low=54.12, close=54.18, volume=1591200),
            dict(open=54.73, high=55.60, low=54.11, close=55.35, volume=1729600),
            dict(open=55.71, high=55.71, low=53.37, close=53.69, volume=1443400),
            dict(open=54.42, high=55.78, low=53.77, close=54.93, volume=1659100),
            dict(open=54.97, high=56.06, low=53.83, close=53.84, volume=1306800),
            dict(open=52.59, high=54.40, low=52.59, close=53.83, volume=1089400),
            dict(open=54.84, high=55.88, low=53.86, close=55.21, volume=1883000),
            dict(open=55.80, high=57.00, low=55.51, close=56.96, volume=1671900),
            dict(open=58.61, high=59.84, low=56.11, close=56.61, volume=2227500),
            dict(open=56.67, high=57.78, low=56.67, close=57.45, volume=1686800),
            dict(open=57.43, high=57.43, low=56.10, close=56.10, volume=1315200)]
    w509 = [dict(open=54.97, high=56.06, low=52.59, close=55.21),
            dict(open=55.80, high=59.84, low=55.51, close=56.10)]
    m509 = [dict(open=66.29, high=71.42, low=58.56, close=60.09),
            dict(open=60.15, high=60.97, low=43.85, close=55.21),
            dict(open=55.80, high=59.84, low=55.51, close=56.10)]
    ctx509 = dict(kline=dict(daily=d509, weekly=w509, monthly=m509),
                  account=dict(cash=87336.0, total_value=104166.0,
                               position=dict(symbol="sz.301299", quantity=300,
                                             cost_price=54.19, market_value=16830.0)))
    d9 = decide(ctx509)
    s9 = d9.get("featureSnapshot") or {}
    ok9 = (s9.get("exhaust") is True and d9["decision"] == DECISION_SELL
           and d9["tradeQuantity"] == 300)
    ok = ok and ok9
    print("[%s] 第15步回归(05-09 衰竭清仓): %s qty=%s exhaust=%s p=%s b=%s edge=%s"
          % ("OK" if ok9 else "FAIL", d9["decision"], d9["tradeQuantity"],
             s9.get("exhaust"), s9.get("p"), s9.get("b"), s9.get("edge")))
    # ── 第 16 步回归（真实 05-14 sz.301299 全量数据；本轮实盘亏损 −414 的入场样本）─────
    # 判别力：修补前 p 公式对「日内穿刺前高、收盘被压回」不敏 ⇒ 唯一防线是 squeeze，而
    #   squeeze 可被人工以「high 已越上沿」覆盖（本轮即如此 ⇒ 买入 @58.07 ⇒ D+1 −3.49%）；
    # 修补后：failed_breakout=True（high 59.74 > res_prev 59.25 ∧ close 58.74 < 59.25 ∧
    #   量 2766200 = 1.55×前5日均量 1785520）⇒ p −0.06、**空仓侧硬否决**、且守卫新增
    #   buy_blocked_by_false_breakout ⇒ 三重防线，覆盖 squeeze 也绕不过。
    fb_daily = [dict(open=53.97, high=54.80, low=53.60, close=54.08, volume=1487800),
                dict(open=53.60, high=54.99, low=53.17, close=53.43, volume=1419300),
                dict(open=53.81, high=54.16, low=51.66, close=52.92, volume=1651400),
                dict(open=52.64, high=54.17, low=52.37, close=53.30, volume=1370200),
                dict(open=53.78, high=54.19, low=52.95, close=53.18, volume=1207500),
                dict(open=52.95, high=54.87, low=52.33, close=54.73, volume=1578500),
                dict(open=54.70, high=55.48, low=54.12, close=54.18, volume=1591200),
                dict(open=54.73, high=55.60, low=54.11, close=55.35, volume=1729600),
                dict(open=55.71, high=55.71, low=53.37, close=53.69, volume=1443400),
                dict(open=54.42, high=55.78, low=53.77, close=54.93, volume=1659100),
                dict(open=54.97, high=56.06, low=53.83, close=53.84, volume=1306800),
                dict(open=52.59, high=54.40, low=52.59, close=53.83, volume=1089400),
                dict(open=54.84, high=55.88, low=53.86, close=55.21, volume=1883000),
                dict(open=55.80, high=57.00, low=55.51, close=56.96, volume=1671900),
                dict(open=58.61, high=59.84, low=56.11, close=56.61, volume=2227500),
                dict(open=56.67, high=57.78, low=56.67, close=57.45, volume=1686800),
                dict(open=57.43, high=57.43, low=56.10, close=56.10, volume=1315200),
                dict(open=56.93, high=59.25, low=56.67, close=58.09, volume=1976300),
                dict(open=59.05, high=59.05, low=57.22, close=57.40, volume=1721800),
                dict(open=57.31, high=59.74, low=56.20, close=58.74, volume=2766200)]
    fb_weekly = [dict(open=68.88, high=71.42, low=66.50, close=70.30),
                 dict(open=70.30, high=70.79, low=59.85, close=60.94),
                 dict(open=61.25, high=61.89, low=58.48, close=58.80),
                 dict(open=52.34, high=54.95, low=43.85, close=52.90),
                 dict(open=53.97, high=54.99, low=51.66, close=53.18),
                 dict(open=52.95, high=55.78, low=52.33, close=54.93),
                 dict(open=54.97, high=56.06, low=52.59, close=55.21),
                 dict(open=55.80, high=59.84, low=55.51, close=56.10),
                 dict(open=56.93, high=59.74, low=56.20, close=58.74)]
    fb_monthly = [dict(open=55.23, high=77.38, low=50.39, close=77.38),
                  dict(open=78.30, high=93.28, low=65.38, close=65.48),
                  dict(open=66.29, high=71.42, low=58.56, close=60.09),
                  dict(open=60.15, high=60.97, low=43.85, close=55.21),
                  dict(open=55.80, high=59.84, low=55.51, close=58.74)]
    fb_ctx = dict(kline=dict(daily=fb_daily, weekly=fb_weekly, monthly=fb_monthly),
                  account=dict(cash=104415.0, total_value=104415.0, position=None))
    dfb = decide(fb_ctx)
    sfb = dfb.get("featureSnapshot") or {}
    ok_fb = (sfb.get("failed_breakout") is True
             and dfb["decision"] in (DECISION_WATCH, DECISION_NO_POSITION))
    ok = ok and ok_fb
    print("[%s] 第16步回归(05-14 假突破且空仓): %s failed_breakout=%s p=%s edge=%s squeeze=%s"
          % ("OK" if ok_fb else "FAIL", dfb["decision"], sfb.get("failed_breakout"),
             sfb.get("p"), sfb.get("edge"), sfb.get("squeeze")))
    # 负例（第 16 步）：即便 squeeze 被覆盖（False），假突破当日的买入仍必须被守卫拦住
    bad4 = {"decision": DECISION_BUY, "tradePrice": 60.14, "tradeQuantity": 300,
            "confidence": CONF_MID,
            "featureSnapshot": {"p": 0.55, "squeeze": False, "failed_breakout": True}}
    v4 = _contract_violations(bad4, fb_ctx)
    ok = ok and "buy_blocked_by_false_breakout" in v4
    print("[%s] 负例(覆盖 squeeze 的假突破买入)命中 %s"
          % ("OK" if "buy_blocked_by_false_breakout" in v4 else "FAIL", v4))
    # ── 第 17 步回归（真实 05-15 sz.301299 日/周线；月线置空以隔离收盘质量项）────────
    # 判别力：05-15 是缩量光头阴（close 56.69 ≈ low 56.67，close_pos=0.012，尾盘无承接）；
    #   high 58.40 < res_prev 59.74 ⇒ 不构成 failed_breakout；箱体 59.74−56.20=3.54 >
    #   1.5·ATR(3.49) ⇒ 非 squeeze ⇒ 三项现有防线全部“失手”：
    #     修补前 p=0.52 ≥ p_gate ⇒ 空仓会建仓（floor_on）
    #     修补后 cl_pos_pen −0.05 ⇒ p=0.47 < p_gate ⇒ 不建仓（弃权）
    cl_daily = fb_daily[1:] + [dict(open=58.07, high=58.40, low=56.67, close=56.69, volume=1683500)]
    #            （= 04-15…05-14 的 19 根 + 05-15，共 20 根；决策日 = 05-15）
    cl_ctx = dict(kline=dict(daily=cl_daily, weekly=fb_weekly, monthly=[]),
                  account=dict(cash=104001.0, total_value=104001.0, position=None))
    dcl = decide(cl_ctx)
    scl = dcl.get("featureSnapshot") or {}
    ok_cl = (scl.get("close_pos") is not None and scl["close_pos"] <= 0.2
             and scl.get("p") < 0.50
             and dcl["decision"] in (DECISION_WATCH, DECISION_NO_POSITION))
    ok = ok and ok_cl
    print("[%s] 第17步回归(05-15 弱收盘): %s close_pos=%s p=%s edge=%s cl_pen=%s"
          % ("OK" if ok_cl else "FAIL", dcl["decision"], scl.get("close_pos"),
             scl.get("p"), scl.get("edge"), scl.get("cl_pen")))
    print("契约守卫 + 冒烟：%s" % ("全部通过" if ok else "存在失败项"))
    return ok


if __name__ == "__main__":
    import sys
    sys.exit(0 if _selfcheck() else 1)

