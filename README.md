# Textron

> **Trainable Textual Neural Network for Agent Context Optimization**

Textron models task experience as a multi-layer graph of text nodes. Through forward propagation (attention-based context building) and backward propagation (weight/node updates from task outcomes), it learns to produce increasingly optimized prompts for recurring task families.

## Concept

```
Neural Network           Textron
─────────────           ───────
Neuron          →       Text node (HTML file, any content)
Weight          →       Edge weight in [-1, 1]
Layer           →       Layer of nodes
Forward pass    →       LLM scores nodes → propagate through edges → compile prompt
Backward pass   →       Task feedback → update weights → fill/update nodes
Convergence     →       Same task family produces shorter, more accurate prompts
```

Nodes have **no predefined types** — their role emerges from connections and training, just like biological neurons. Skill names are just one possible node content, not a separate concept.

## Installation

### As a pi package

```bash
pi install textron-agent
```

### From local path

```bash
pi install /path/to/textron-agent
# or link directly:
ln -s /path/to/textron-agent/src/index.ts ~/.pi/agent/extensions/textron/index.ts
```

### From git

```bash
pi install github.com/yourname/textron-agent
```

## Usage

Textron registers a single tool: **`Textron`** with 5 actions.

### `list` — See all trained networks

```
Textron action=list
```

### `init` — Create a network for a task family

```
Textron action=init taskFamily="react_bug_fixing" layers="4,6,6,4"
```

- `layers`: comma-separated node counts per layer (e.g. `"3,5,4"` = 3 layers with 3, 5, 4 nodes)
- `threshold`: activation threshold (default 0.3)
- `learningRate`: weight update rate (default 0.08)

### `forward` — Load network nodes

```
Textron action=forward taskFamily="react_bug_fixing"
```

Returns all nodes organized by layer. The LLM reads each node, assigns attention scores (0.0–1.0), then proceeds to propagate.

### `propagate` — Propagate attention & compile prompt

```
Textron action=propagate taskFamily="react_bug_fixing"
  layerScores='{"node_0":0.8,"node_1":0.3,"node_2":0.9,...}'
```

Runs layer-by-layer propagation: attention scores flow through weighted edges. Nodes exceeding threshold activate. Final activated nodes are compiled into a context prompt the LLM uses to execute the task.

### `backward` — Train from feedback

```
Textron action=backward taskFamily="react_bug_fixing"
  feedback="success: identified the state closure issue"
  activatedNodes='["node_0","node_2","node_5"]'
  filledNodes='{"node_3":"useEffect cleanup pattern","node_7":"React.memo optimization"}'
```

- **Success** → reinforces activated edge paths (weights increase)
- **Failure** → penalizes activated paths (weights decrease, may go negative)
- `filledNodes`: writes content into previously empty nodes

## Storage

```
~/.textron/
└── {task_family}/
    ├── hyperparams.json    # { layers, threshold, learningRate, timestamps }
    ├── weights.json        # All edge weights (centralized for efficient updates)
    ├── layer_0/
    │   ├── node_0.html     # HTML node with <content> and <link rel="out">
    │   └── ...
    └── layer_N/
```

### Node HTML format

```html
<meta name="layer" content="0">
<meta name="id" content="node_0">
<link rel="out" href="../layer_1/node_0.html" data-weight="0.54">
<link rel="out" href="../layer_1/node_2.html" data-weight="-0.3">
<content>
Check hooks.json symlink path
</content>
```

- `<meta>`: layer position and node ID
- `<link rel="out">`: outgoing edges to next layer nodes with weights
- `<content>`: the node's text (can be empty — "unactivated neuron")

## Design Philosophy

1. **No predefined types** — nodes and edges have no semantic labels; function emerges from training
2. **Sparse connections** — edges initialized randomly (~60% connectivity), like biological networks
3. **Growth over time** — AI can expand layers and add nodes as training progresses
4. **Signed weights** — `[-1, 1]`: positive = excitation, negative = inhibition
5. **Filesystem as database** — HTML nodes + JSON weights, inspectable and versionable
6. **Skill names = node content** — no separate skill concept; a node might just contain "nbeat"

## License

MIT
