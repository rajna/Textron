# trade-loop


```mermaid
flowchart TD
    start([Start])
    s1[orchestrator.py prompt 取服务端...]
    s2[Sub-Agent: s2]
    s3[orchestrator.py step 执行B的决策...]
    s4[盈亏反馈给stock-coder复盘#40;复盘→根因→下轮...]
    end([End])

    start --> s1
    s1 --> s2
    s2 --> s3
    s3 --> s4
    s4 --> s1
    s4 --> end
```

## Workflow Execution Guide

Follow the Mermaid flowchart above to execute the workflow. Each node type has specific execution methods as described below.

### Execution Methods by Node Type

- **Rectangle nodes (Sub-Agent: ...)**: Execute Sub-Agents
- **Diamond nodes (AskUserQuestion:...)**: Use the AskUserQuestion tool to prompt the user and branch based on their response
- **Diamond nodes (Branch/Switch:...)**: Automatically branch based on the results of previous processing (see details section)
- **Rectangle nodes (Prompt nodes)**: Execute the prompts described in the details section below
- **Rectangle nodes (Branch-Session: ...)**: Human-in-the-loop checkpoints — pause the workflow and guide the user into a Claude Code branch session (see Branch Session Node Details)

## Sub-Agent Node Details

#### s2(Sub-Agent: s2)

**Description**: A股交易决策者

**Prompt**:

```
根据观察数据输出决策JSON
```

### Prompt Node Details

#### s1(orchestrator.py prompt 取服务端...)

```
orchestrator.py prompt 取服务端观察数据(截止最近收盘日,面向下一交易日)
```

#### s3(orchestrator.py step 执行B的决策...)

```
orchestrator.py step 执行B的决策JSON, 然后 pnl 算盈亏
```

#### s4(盈亏反馈给stock-coder复盘(复盘→根因→下轮...)

```
盈亏反馈给stock-coder复盘(复盘→根因→下轮要点→确认), 汇报boss
```

