#!/usr/bin/env python3
"""n8 第二十一轮离线重放：离域候选「被更新但未 replace」违规告警的有效性验证。

新增判据（src/index.ts semantic_backward_goal_cleanse / _violation）：
  对 MUST-CLEANSE 候选名单中的每个节点，取本轮 node_updates 的 mode：
    replace       → 真清洗（规则 0(a) 要求的 OVERWRITE）
    merge/缺失    → 内容被继续追加（静默违反：候选判据与写入目标自相矛盾）
    (no_update)   → LLM 未动该节点
  违规计数 > 0 时应落 semantic_backward_goal_cleanse_violation 事件。

用法: python3 tests/goal_cleanse_mode_audit.py [--expect-violation N]
退出码 0 = 判据在本轮真实样本上按预期产出，1 = 判据无判别力（需换维度）。
"""
import json
import os
import sys

EVENTS = os.path.expanduser("~/.textron/_events.jsonl")
SB = os.path.expanduser("~/.textron/stock_alpha/_sb_logs/semantic_backward.jsonl")


def tail_jsonl(path, limit=6_000_000):
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


def audit():
    guard = latest_goal_guard(tail_jsonl(EVENTS))
    if not guard:
        print("SKIP: 窗口内无 semantic_backward_goal_guard 样本 → 记 no_offgoal_sample，不判失败")
        return 0
    cands = guard.get("offGoalCandidates") or []
    updates, ts = latest_updates(tail_jsonl(SB))
    violations, modes = [], {}
    for c in cands:
        key = c.get("id") or c.get("key")
        up = updates.get(key)
        mode = "(no_update)" if not up else str(up.get("mode") or "merge")
        modes[key] = mode
        if up and mode != "replace":
            violations.append({"nodeId": key, "mode": mode, "goalSim": c.get("goalSim")})
    print(f"sample_ts={guard.get('ts')} updates_ts={ts} candidates={len(cands)}")
    print("candidateModes:", json.dumps(modes, ensure_ascii=False))
    print("violations:", json.dumps(violations, ensure_ascii=False))
    if cands and not updates:
        print("FAIL: 有候选但取不到 node_updates（口径不可用，需换维度）")
        return 1
    expect = None
    for i, a in enumerate(sys.argv):
        if a == "--expect-violation":
            expect = int(sys.argv[i + 1])
    if expect is not None and len(violations) != expect:
        print(f"FAIL: 期望违规数 {expect}，实得 {len(violations)}")
        return 1
    print("OK: 判据可产出真实值（candidates 非空）" if cands else "OK: 候选为空，判据无需触发")
    return 0


if __name__ == "__main__":
    sys.exit(audit())
