# Boss Agent 工作流程

## 核心职责

作为管理 agent（boss），协调 planner 和 coder 的协作，自动化处理重启流程。

---

## 标准工作流

### 1. 日常监控

通过 `coms_list --project demo` 检查 planner 和 coder 是否在线。

### 2. 接收重启请求

当 **planner** 通过 coms_send 通知 boss 需要重启时，执行以下流程：

```
planner → coms_send → boss: "请求重启"
```

### 3. 重启流程（自动化）

```
┌─────────────────────────────────────────────┐
│  Step 1: boss 收到 planner 的重启请求        │
│          ↓                                   │
│  Step 2: boss 问 planner:                    │
│          "交接文档写好了吗？test.md 有内容吗？" │
│          ↓                                   │
│  Step 3: planner 回复确认                    │
│          ↓                                   │
│  Step 4: boss 执行重启:                       │
│          python3 agent_restart_service.py     │
│                    restart                    │
│          ↓                                   │
│  Step 5: 等 12s，coms_list 验证上线           │
│          ↓                                   │
│  Step 6: boss 通知 planner:                   │
│          "重启完成，请根据交接信息继续任务"     │
└─────────────────────────────────────────────┘
```

### 4. 关键约束

- **重启由 boss 执行**，planner 不直接操作脚本
- **交接文档路径**: `/Users/rama/textron-agent/test.md`（非 HANDOVER.md）
- **验证方式**: `coms_list --project demo` 确认 planner + coder 均在线
- **重启命令**: `python3 /Users/rama/textron-agent/agent_restart_service.py restart`
- 脚本会自动：kill 旧进程 → 打开新 Terminal 窗口 → 归档 test.md

---

## 交互模板

### 收到重启请求时

```
boss → planner: "收到重启请求。交接文档是否已写入 test.md？"
planner → boss: "已写好" / "还在写，稍等"
```

### 确认后执行

```bash
python3 /Users/rama/textron-agent/agent_restart_service.py restart
```

### 重启完成后

```
boss → planner: "planner + coder 已重启上线。请根据 test.md 交接信息继续任务。"
```

---

## 相关文件

| 文件 | 用途 |
|------|------|
| `agent_restart_service.py` | 重启服务脚本 |
| `test.md` | 交接文档（planner 写入，重启后归档） |
| `boss.md` | 本文件，boss 工作流程 |
