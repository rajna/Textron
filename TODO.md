# Textron TODO

## Critical: implement strict forward/backward learning loop

Target loop:

1. User sends current input `U_n`.
2. Before AI answers, Textron runs forward propagation based on `U_n`:
   - score L0 nodes using the current user input
   - propagate through weighted graph
   - select path nodes
   - compile selected node context
   - inject compiled context into the prompt/system prompt before the AI answer
3. AI answers and must include a compact high-entropy summary at the end:

```xml
<HighEntropy>
≤200 chars: reusable high-entropy summary of the answer's decisions, fixes, reasoning, and transferable implementation insight. No raw logs, file listings, or session summaries.
</HighEntropy>
```

4. On the next user turn `U_{n+1}`, before answering, Textron must run backward for the previous turn using:
   - current user input / feedback `U_{n+1}`
   - previous selected path `P_n`
   - previous AI answer high-entropy summary `H_n` extracted from `<HighEntropy>...</HighEntropy>`
5. Backward must produce reward + node/edge update instructions, then update the graph.
6. Backward must complete before the new forward pass for `U_{n+1}` starts.
7. After backward finishes, run the normal forward process for `U_{n+1}` and answer.

## Missing / broken pieces to implement

- [x] Inject a mandatory `<HighEntropy>...</HighEntropy>` instruction into the assistant prompt for every turn.
- [x] Capture assistant final output or stream deltas and extract `<HighEntropy>`.
- [x] Persist `lastAssistantHighEntropy` alongside `lastUserPrompt`, `lastActivatedIds`, and `lastSelectedEdgeIds`.
- [x] Add `lastAssistantHighEntropy` to `semanticBackwardLLM` input.
- [ ] Change next-turn backward from fire-and-forget to awaited execution before current-turn forward. *(Deferred by design: current requirement is "backward need not await; ensure reverse updates happen".)*
- [x] Stop zero-activation raw user prompt seeding into L0. Never create L0 nodes from raw user text.
- [ ] Add a quarantine/quality filter so low-entropy existing nodes do not participate in scoring/propagation.
- [x] Avoid manual network edits as a normal workflow. Project TODOs belong in repo files, not Textron nodes.

## Design principle

Textron is an external small brain for agent use, not a memory log. Network nodes should store transferable decision patterns, routing keys, and high-entropy reusable principles. Raw commands, HTTP checks, process IDs, UI restart messages, user prompt copies, and session summaries must never become graph nodes.

## Implemented (2026-07-04 ~ 07-05)

- [x] HighEntropy fallback updates all selected path layers (L0/L1/L2), not only deepest.
- [x] Fallback layers get progressively longer content (≤48/≤100/≤120 chars), not identical copies.
- [x] No hardcoded layer roles (L0≠trigger, L1≠tradeoff, L2≠tactic). Network learns orthogonal roles via edge-weight training.
- [x] Node update merged with old content instead of blind replacement. High overlap → append new tokens; low overlap → `|` separator; ≤120 char cap.
- [x] Compiled Textron context injected into user prompt (not system prompt), wrapped in `<TextronSkill>` XML tags.
- [x] New network auto-creation replaced with node expansion on best-match existing network. `init` and `backward` auto-create both redirected.
- [x] nbeat bridge uses generic `NBEAT_PI_EXTRA_ENV_JSON` + `NBEAT_JOB_STATE_FILES` instead of Textron-specific env vars.
- [x] nbeat child Pi scoped `textron_state.json` via `TEXTRON_STATE_FILE` env for create→refine backward continuity.
- [x] nbeat UI backend selector (LMMS / PCM) with same style as Deliverables chips.
- [x] Modular synthesis backend architecture: `scripts/backends/{pcm,lmms}.py` + dispatcher `generate_beat.py`.

## Convergence: making Textron learn like a real neural network

Research summary from NLP classics, graph algorithms, entropy theory, and 2024 GNN convergence papers.

### Current bottleneck

- Edge weights update per-sample with no convergence target.
- No loss function; qualityScore oscillates without downward trend.
- No regularization; nodes can duplicate or overfit.
- Forward propagation runs once; no guarantee of stable activation distribution.

### P0: PageRank-style iterative propagation to steady state

**Source**: Brin & Page (1998), Markov chain convergence theory.

Forward should iterate until node activations stabilize: ∥aₜ₊₁ − aₜ∥ < ε.
Connected non-bipartite graph guarantees unique stationary distribution πP = π.
Maps to Textron: edge matrix as stochastic matrix; steady-state activations = truly learned path.

### P0: Entropy-driven node quality

**Source**: Shannon entropy, Maximum Entropy Principle (Jaynes, 1957).

Replace regex-based validateKnowledgeCrystal with: node_score = H(content) × relevance(task).
High-entropy nodes = dense information per token → preferred in scoring.
Low-entropy nodes (template, repetition, operational traces) → penalized.

### P1: Spreading Activation with depth decay

**Source**: Collins & Loftus (1975), Anderson (1983) ACT-R.

Activation should decay with layer depth: a[l+1] = a[l] × W × γ^l, γ ∈ (0.85, 0.95).
Creates natural "highway" paths (frequently reinforced) vs "trail" paths (low-frequency).
Long paths require stronger edge weights to survive.

### P1: Curriculum learning / difficulty schedule

**Source**: Bengio et al. (2009).

Backward learning rate modulated by task difficulty:
- reward > 0.5 → lr × 1.5 (easy, learn fast)
- 0.1 < reward < 0.5 → lr normal
- reward < 0.1 → lr × 0.3 (hard, conservative)
Warm-up period: first 10 tasks only use high-reward samples.

### P2: Intra-layer orthogonality penalty (contrastive)

**Source**: InfoNCE (Oord et al., 2018), SimCLR (Chen et al., 2020).

Nodes within same layer should be mutually orthogonal.
If Jaccard(sim) > 0.6 between two L0 nodes → weaken their outgoing edges by ×0.95.
Forces the network to learn differentiated routing rather than redundant copies.

### P2: TF-IDF weighted node scoring

**Source**: Salton (1970s), Deerwester (1990) LSA.

Words appearing across many nodes have low discrimination power.
L0 score *= (1 − log(df)/log(N)). Pushes nodes toward unique content.

### P2: Over-smoothing prevention (GNN theory)

**Source**: 2024 NeurIPS/ICML GNN convergence papers.

GNNs collapse to uniform node representations without residual connections + normalization.
Textron faces the same risk: nodes converging to similar content.
Apply: mergeContent already provides residual (old + Δ); add explicit normalization step.

### Convergence metrics to track

- ∥W[t] − W[t−1]∥ → 0 (weight stability)
- Steady-state activation entropy → stable
- Median qualityScore trend → increasing
- Intra-layer mean cosine similarity → decreasing
- Node content H mean/median → stable

### Not applicable (with reasons)

- Gradient descent / backprop: Textron has no differentiable loss; reward is discrete.
- Batch training: Textron is online (one sample per turn). Could simulate via moving average of gradients.
- Dropout: No parameter matrix to randomly zero; entropy regularization serves similar purpose.
- Adam/W optimizer: Edge updates are per-path, not per-parameter; momentum could be added but low priority.
