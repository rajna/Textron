#!/usr/bin/env python3
"""n8 第二十一/二十二轮离线重放：离域候选「被更新但未 replace」告警的有效性 + 判据冲突分流。

第二十一轮判据（src/index.ts semantic_backward_goal_cleanse / _violation）：
  对 MUST-CLEANSE 候选名单中的每个节点，取本轮 node_updates 的 mode：
    replace       → 真清洗（规则 0(a) 要求的 OVERWRITE）
    merge/缺失    → 内容被继续追加（静默违反：候选判据与写入目标自相矛盾）
    (no_update)   → LLM 未动该节点
  违规计数 > 0 时应落 semantic_backward_goal_cleanse_violation 事件。

第二十二轮扩展 —— 判据冲突分流（口径代码化 + 离线基线核对，守硬性约束 11/12）：
  第二十一轮上线后首次拿到真实违规取证（2026-09-20T15:26 轮），发现该告警自身是**判据冲突**
  而非真违规：程序侧离域判据 goalSim（词面余弦）给出**最低分**（最"离域"）的节点 L1::node_1
  （goalSim=0.0236），恰是写入侧保留判据 retentionVerdict 给出 evidence 含 "goal"（域内证据，
  goalHits=5）的同一节点 ⇒ 两判据给出互斥结论；且该节点被写入的确实是**纯交易域**符号化增量
  （p_gate / box / squeez_mult / 1.5·ATR 闸门死区）⇒ 判定"离域污染"是误判。
  成因同 R8 家族（词面稀疏的符号化专业增量天然低分），此处是它在**候选枚举侧**的第二个出口。
  新口径：违规只计「写入侧无 goal 证据」的项；带 goal 证据的移入 judgmentConflicts，
  落 semantic_backward_judge_conflict 事件；cleanseViolationCount 只计真违规。

用法:
  python3 tests/goal_cleanse_mode_audit.py [--expect-violation N] [--expect-conflict N] [--replay]
  --replay  用**事件里的真值字段**重算分类，与 semantic_backward_goal_cleanse 落盘字段逐字对账
            （离线基线核对，只读不改盘）。
退出码 0 = 判据在本轮真实样本上按预期产出，1 = 判据无判别力（需换维度）。
"""
import json
import os
import sys

EVENTS = os.path.expanduser("~/.textron/_events.jsonl")
SB = os.path.expanduser("~/.textron/stock_alpha/_sb_logs/semantic_backward.jsonl")
INDEX_TS = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "src", "index.ts")

# 写入侧保留判据的结论事件（applySemanticNodeUpdates 落盘）——判据冲突分流的第二证据源。
WRITE_VERDICT_ACTIONS = (
    "node_write_downgraded_to_merge",
    "node_write_refused_keep_better",
)


def tail_jsonl(path, limit=48_000_000):
    if not os.path.exists(path):
        return []
    size = os.path.getsize(path)
    with open(path, "rb") as f:
        f.seek(max(0, size - limit))
        data = f.read().decode("utf-8", "ignore")
    out = []
    for ln in data.splitlines():
        ln = ln.strip()
        if not ln:
            continue
        try:
            out.append(json.loads(ln))
        except Exception:
            continue
    return out


def latest_goal_guard(events, task_family="stock_alpha"):
    for e in reversed(events):
        if e.get("action") == "semantic_backward_goal_guard" and e.get("taskFamily") == task_family:
            return e
    return None


def latest_updates(sb_lines):
    for o in reversed(sb_lines):
        u = (o.get("parsedFull") or {}).get("node_updates")
        if u:
            return u, o.get("ts")
    return {}, None


def latest_write_verdicts(events, task_family="stock_alpha", since=None):
    """写入侧保留判据的真值（第二十二轮分流所依赖的唯一事实来源）。
    since：只采纳不早于该时刻的事件——写入侧判据在 semantic_backward_goal_guard 之后才跑，
    而 _events.jsonl 是多进程交错写入（并非严格时序），故必须按时间窗而非文件顺序对齐。"""
    out = {}
    for e in events:
        if e.get("action") not in WRITE_VERDICT_ACTIONS:
            continue
        # 写入侧事件由 _logFields 展开落盘，**不带 taskFamily 字段**（不能硬要求相等，否则全量漏采）。
        if e.get("taskFamily") and e.get("taskFamily") != task_family:
            continue
        if since and (e.get("ts") or "") < since:
            continue
        out[e.get("id")] = {
                "evidence": e.get("evidence") or [],
                "goalHits": e.get("goalHits"),
                "oldCover": e.get("oldCover"),
                "scoreOld": e.get("scoreOld"),
                "scoreNew": e.get("scoreNew"),
                "offDomain": e.get("offDomain"),
                "decision": e.get("action"),
            }
    return out


def classify(cands, updates, verdicts):
    """与 index.ts 第二十二轮实现同构的分类：conflict（写入侧有 goal 证据）vs violation。"""
    violations, conflicts, modes, decisions = [], [], {}, {}
    for c in cands:
        key = c.get("id") or c.get("key")
        up = updates.get(key)
        mode = "(no_update)" if not up else str(up.get("mode") or "merge")
        modes[key] = mode
        v = verdicts.get(key)
        if not up or mode == "replace":
            decisions[key] = (v or {}).get("decision", "(untouched)")
            continue
        if v and "goal" in (v.get("evidence") or []):
            conflicts.append({"nodeId": key, "mode": mode, "goalSim": c.get("goalSim"),
                              "evidence": v.get("evidence"), "goalHits": v.get("goalHits")})
            decisions[key] = "conflict:" + str(v.get("decision"))
        else:
            violations.append({"nodeId": key, "mode": mode, "goalSim": c.get("goalSim")})
            decisions[key] = (v or {}).get("decision", "(no_verdict)")
    return violations, conflicts, modes, decisions


def replay_against_events(events, task_family="stock_alpha"):
    """拿最后一轮 semantic_backward_goal_cleanse 的落盘字段，与本地重算逐字对账。"""
    logged = None
    for e in reversed(events):
        if e.get("action") == "semantic_backward_goal_cleanse" and e.get("taskFamily") == task_family:
            logged = e
            break
    if not logged:
        print("SKIP: 窗口内无 semantic_backward_goal_cleanse 样本")
        return 0
    if "judgmentConflictCount" not in logged:
        print(f"FAIL: 事件无 judgmentConflictCount 字段（ts={logged.get('ts')}）⇒ 第二十二轮改动未生效/未 reload")
        return 1
    violations, conflicts, modes, decisions = classify(
        [{"id": k, "goalSim": None} for k in (logged.get("candidates") or [])],
        {k: {"mode": v} for k, v in (logged.get("candidateModes") or {}).items() if v not in ("(no_update)",)},
        latest_write_verdicts(events, task_family),
    )
    print(f"replay_ts={logged.get('ts')}")
    print(f"  logged : violation={logged.get('cleanseViolationCount')} conflict={logged.get('judgmentConflictCount')}")
    print(f"  replay : violation={len(violations)} conflict={len(conflicts)}")
    print(f"  modes  : {json.dumps(modes, ensure_ascii=False)}")
    if logged.get("candidateDecisions"):
        print(f"  decisions(logged) : {json.dumps(logged['candidateDecisions'], ensure_ascii=False)}")
    print(f"  decisions(replay) : {json.dumps(decisions, ensure_ascii=False)}")
    ok = (len(violations) == logged.get("cleanseViolationCount")
          and len(conflicts) == logged.get("judgmentConflictCount"))
    print("OK: 分流口径与落盘一致（离线基线核对通过）" if ok else "FAIL: 分流口径与落盘不一致 ⇒ 判据不可复算")
    return 0 if ok else 1


def audit():
    events = tail_jsonl(EVENTS)
    guard = latest_goal_guard(events)
    if not guard:
        print("SKIP: 窗口内无 semantic_backward_goal_guard 样本 → 记 no_offgoal_sample，不判失败")
        return 0
    cands = guard.get("offGoalCandidates") or []
    updates, ts = latest_updates(tail_jsonl(SB))
    verdicts = latest_write_verdicts(events, since=guard.get("ts"))
    violations, conflicts, modes, decisions = classify(cands, updates, verdicts)
    print(f"sample_ts={guard.get('ts')} updates_ts={ts} candidates={len(cands)}")
    print("candidateModes:", json.dumps(modes, ensure_ascii=False))
    print("write_verdicts:", json.dumps({k: v["evidence"] for k, v in verdicts.items()}, ensure_ascii=False))
    print("violations:", json.dumps(violations, ensure_ascii=False))
    print("judgment_conflicts:", json.dumps(conflicts, ensure_ascii=False))
    if cands and not updates:
        print("FAIL: 有候选但取不到 node_updates（口径不可用，需换维度）")
        return 1
    expect_v = expect_c = None
    for i, a in enumerate(sys.argv):
        if a == "--expect-violation":
            expect_v = int(sys.argv[i + 1])
        if a == "--expect-conflict":
            expect_c = int(sys.argv[i + 1])
    if expect_v is not None and len(violations) != expect_v:
        print(f"FAIL: 期望违规数 {expect_v}，实得 {len(violations)}")
        return 1
    if expect_c is not None and len(conflicts) != expect_c:
        print(f"FAIL: 期望冲突数 {expect_c}，实得 {len(conflicts)}")
        return 1
    print("OK: 判据可产出真实值（candidates 非空）" if cands else "OK: 候选为空，判据无需触发")
    if "--replay" in sys.argv:
        return replay_against_events(events)
    return 0


if __name__ == "__main__":
    sys.exit(audit())
