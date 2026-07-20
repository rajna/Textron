#!/usr/bin/env python3
"""
Agent Restart Service - 管理 COMS 中 planner 和 coder 的重启流程

协议:
  1. planner 通过 COMS 通知本服务的管理 agent 需要重启
  2. 管理 agent 触发本脚本，要求 planner 先写交接信息到 textron/test.md
  3. planner 确认写入完成后，执行重启
  4. 重启 planner 和 coder 两个 COMS agent

使用方式:
  python agent_restart_service.py restart          # 执行完整重启流程
  python agent_restart_service.py check-handover   # 检查交接文件
  python agent_restart_service.py status           # 查看状态
"""

import json
import os
import sys
import time
import subprocess
import signal
from datetime import datetime
from pathlib import Path

# ============================================================
# 配置
# ============================================================
BASE_DIR = Path(__file__).resolve().parent.parent  # /Users/rama
TEXTRON_DIR = BASE_DIR / "textron"
HANDOVER_FILE = TEXTRON_DIR / "test.md"
SIGNAL_FILE = Path(__file__).resolve().parent / "restart_signal.json"
LOG_FILE = Path(__file__).resolve().parent / "restart_service.log"

# COMS agents to manage (需要通过 pi CLI 或进程管理来重启)
COMS_AGENTS = ["planner", "coder"]


def log(msg: str):
    """写日志"""
    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    entry = f"[{timestamp}] {msg}"
    print(entry)
    try:
        with open(LOG_FILE, "a") as f:
            f.write(entry + "\n")
    except Exception:
        pass


def ensure_dirs():
    """确保目录存在"""
    TEXTRON_DIR.mkdir(parents=True, exist_ok=True)
    LOG_FILE.parent.mkdir(parents=True, exist_ok=True)


def check_handover() -> dict:
    """检查交接文件是否存在且非空"""
    exists = HANDOVER_FILE.exists()
    content = ""
    if exists:
        try:
            content = HANDOVER_FILE.read_text(encoding="utf-8").strip()
        except Exception:
            content = ""
    return {
        "exists": exists,
        "has_content": bool(content),
        "file": str(HANDOVER_FILE),
        "size": len(content) if content else 0,
    }


def read_handover() -> str:
    """读取交接文件内容"""
    if HANDOVER_FILE.exists():
        return HANDOVER_FILE.read_text(encoding="utf-8")
    return ""


def write_restart_signal(action: str = "request_restart", extra: dict = None):
    """写入重启信号文件（供 planner 使用）"""
    signal_data = {
        "action": action,
        "timestamp": datetime.now().isoformat(),
        "requested_by": "planner",
    }
    if extra:
        signal_data.update(extra)
    SIGNAL_FILE.write_text(json.dumps(signal_data, ensure_ascii=False, indent=2))
    log(f"信号已写入: {action}")


def read_restart_signal() -> dict:
    """读取重启信号"""
    if SIGNAL_FILE.exists():
        try:
            return json.loads(SIGNAL_FILE.read_text(encoding="utf-8"))
        except Exception:
            pass
    return {}


def clear_restart_signal():
    """清除重启信号"""
    if SIGNAL_FILE.exists():
        SIGNAL_FILE.unlink()
        log("信号文件已清除")


def _find_agent_screen(name: str):
    """查找 agent 对应的 screen 会话 ID"""
    try:
        result = subprocess.run(
            ["screen", "-ls", name],
            capture_output=True, text=True, timeout=5
        )
        for line in result.stdout.split("\n"):
            if f".{name}" in line:
                sid = line.strip().split(".")[0].strip()
                if sid.isdigit():
                    return sid
    except Exception as e:
        log(f"  查找 screen 会话失败: {e}")
    return None


def _kill_agent_process(name: str) -> bool:
    """杀掉 agent 的所有旧进程（通过 coms 注册文件找 PID）"""
    killed = False

    # 1) 从 coms 注册文件读 PID
    coms_file = Path.home() / ".pi" / "coms" / "projects" / "demo" / "agents" / f"{name}.json"
    if coms_file.exists():
        try:
            data = json.loads(coms_file.read_text())
            pid = data.get("pid")
            if pid:
                # 确认不是当前 boss 进程
                boss_file = coms_file.parent / "boss.json"
                boss_pid = None
                if boss_file.exists():
                    try:
                        boss_pid = json.loads(boss_file.read_text()).get("pid")
                    except Exception:
                        pass
                if pid != boss_pid and pid != os.getpid():
                    try:
                        os.kill(int(pid), 9)
                        log(f"  已终止 {name} 进程: {pid}")
                        killed = True
                    except ProcessLookupError:
                        log(f"  进程 {pid} 已不存在")
                    except Exception as e:
                        log(f"  终止进程 {pid} 失败: {e}")
        except Exception as e:
            log(f"  读取 coms 注册文件失败: {e}")

    # 2) screen 会话（兜底）
    sid = _find_agent_screen(name)
    if sid:
        try:
            subprocess.run(["screen", "-S", sid, "-X", "quit"],
                           capture_output=True, timeout=5)
            log(f"  已终止 screen 会话: {sid}.{name}")
            killed = True
        except Exception as e:
            log(f"  终止 screen 会话失败: {e}")

    if not killed:
        log(f"  未找到 {name} 的旧进程，跳过 kill")
    return True


def restart_agent(agent_name: str) -> bool:
    """
    重启 COM agentS

    流程:
    1. 查找并杀掉旧的 screen 会话
    2. 用 osascript 打开新 Terminal 窗口运行 pi（用户可看到 TUI）
    """
    log(f"正在重启 agent: {agent_name}")

    # Step 1: kill 旧进程
    _kill_agent_process(agent_name)

    # Step 2: 确定 purpose
    purposes = {
        "planner": "规划任务",
        "coder": "程序员",
        "boss": "管理协调",
    }
    purpose = purposes.get(agent_name, agent_name)

    # Step 3: 用 osascript 打开新 Terminal 窗口（用户可见 TUI）
    ext_path = os.path.expanduser("~/.pi/agent/extensions/local-coms.ts")
    apple_script = (
        'tell app "Terminal" to do script '
        '"pi -e ' + ext_path + ' --cname ' + agent_name +
        ' --project demo --purpose \\"' + purpose + '\\""'
    )
    cmd = ["osascript", "-e", apple_script]

    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=10)
        if result.returncode == 0:
            log(f"  ✅ {agent_name} Terminal 窗口已打开")
            return True
        else:
            log(f"  ❌ 启动失败: {result.stderr.strip()}")
            return False
    except Exception as e:
        log(f"  ❌ 启动异常: {e}")
        return False


def do_restart():
    """执行重启流程（交接文件有内容就读，没有也直接重启）"""
    log("=" * 50)
    log("重启流程开始")

    # Step 1: 检查交接文件（有就读，没有跳过）
    handover = check_handover()
    if handover["has_content"]:
        content = read_handover()
        log(f"交接内容 ({len(content)} 字符):")
        log(f"---\n{content[:500]}\n---")
    else:
        log("交接文件为空，跳过交接信息")

    # Step 3: 执行重启
    log("开始重启 COMS agents...")
    results = {}
    for agent in COMS_AGENTS:
        success = restart_agent(agent)
        results[agent] = "restarted" if success else "failed"
        log(f"  {agent}: {results[agent]}")

    # Step 4: 归档交接文件
    archive_file = TEXTRON_DIR / f"test_{datetime.now().strftime('%Y%m%d_%H%M%S')}.md"
    if HANDOVER_FILE.exists():
        HANDOVER_FILE.rename(archive_file)
        log(f"交接文件已归档: {archive_file}")
        # 恢复空文件供下次使用
        HANDOVER_FILE.write_text("# 交接信息\n\n（等待 planner 写入...）\n")

    clear_restart_signal()
    log("重启流程完成")
    log("=" * 50)

    return {
        "status": "completed",
        "results": results,
        "archive": str(archive_file),
    }


def status():
    """查看当前状态"""
    print("=" * 50)
    print("Agent Restart Service - 状态报告")
    print(f"时间: {datetime.now().isoformat()}")
    print(f"日志: {LOG_FILE}")
    print()

    handover = check_handover()
    print("📝 交接文件状态:")
    print(f"   路径: {handover['file']}")
    print(f"   存在: {handover['exists']}")
    print(f"   有内容: {handover['has_content']} ({handover['size']} 字节)")

    if handover["has_content"]:
        print("   内容预览:")
        content = read_handover()
        for line in content.split("\n")[:5]:
            print(f"   > {line}")

    signal_data = read_restart_signal()
    print()
    print("🔔 重启信号:", "有" if signal_data else "无")
    if signal_data:
        print(f"   动作: {signal_data.get('action')}")
        print(f"   时间: {signal_data.get('timestamp')}")

    print()
    print("🤖 管理中的 COMS Agents:", COMS_AGENTS)
    print("=" * 50)


# ============================================================
# CLI
# ============================================================
if __name__ == "__main__":
    ensure_dirs()

    if len(sys.argv) < 2:
        print("用法: python agent_restart_service.py [restart|check-handover|status|signal]")
        sys.exit(1)

    cmd = sys.argv[1]

    if cmd == "restart":
        result = do_restart()
        print(json.dumps(result, ensure_ascii=False, indent=2))

    elif cmd == "check-handover":
        handover = check_handover()
        print(json.dumps(handover, ensure_ascii=False, indent=2))

    elif cmd == "status":
        status()

    elif cmd == "signal":
        # 写入重启信号（模拟 planner 请求）
        write_restart_signal()
        print("重启信号已写入")

    else:
        print(f"未知命令: {cmd}")
        sys.exit(1)
