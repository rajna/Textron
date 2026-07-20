# 节点命名高熵化改造 — 进度与下次测试观察清单（2026-07-20）

## 背景（两个痛点）

1. **写盘路径用 content 前 48 字符硬截断当 name**（`compressNodeName`）：名字只剩泛化开头、丢关键术语、截断带 `...`。而 name 是检索键——L0 LLM 评分、网络路由、Jaccard/TF-IDF 去重**只看 name**。
2. **HighEntropy 契约 prompt 本身没要求 name 含高熵词**：LLM 产出 `语法检查不等于可运行` 这类泛化总结句，与 Content 零关键词重叠，直接污染 L0 评分输入。

## 本次改动（textron-agent src/）

| 文件 | 改动 |
|---|---|
| `name_distill.ts` | **新建**。`distillNodeName()`：标识符(camel/snake/路径/缩写) 10+len/2 分、数字 8 分、CJK 碎片 3+len 分（通用词+虚字切分、边缘弱字剥离、保留否定词不/无/非）→ 贪心选取 ≤48 字符 → 位置重排 → CJK 间 `·` 连接（规避 ngram 碎片隔离正则）、latin 空格。`sharesKeywordWithContent()`：squash 比较、≥3 字符或含数字 token 才计入（防 2 字弱命中绕过） |
| `index.ts` | 本地 `compressNodeName` 委托 `distillNodeName`；`HIGH_ENTROPY_INSTRUCTION` 契约改写（Name=3-6 个最高熵术语拼接，附坏/好例）；semanticBackwardLLM 规则 9 + user instruction 同步改写 |
| `storage.ts` | `compressNodeName` 委托 → `backward.ts`/`network.ts` 经 import 自动升级（所有写盘路径：update/add/merge/fallback） |
| `highentropy.ts` | `compressNodeName` 委托；**新增守卫**：LLM name 与 content 零关键词重叠 → 自动替换为蒸馏名（静默，无日志） |
| `prompt_injection.ts` | trainingReminder 改写：明确"节点评分/路由只看 name，禁止泛化总结句" |
| `test_highentropy.ts` | 14/14 通过；新增 2 回归测试（泛化名被替换、关键词名保留）。用户原例 → `冒烟测试 drawMinimap 模拟真实流程帧循环 DOM/Canvas 低成本覆盖全代码路径` |
| `migrate_names.ts` | **新建一次性迁移**。`node src/migrate_names.ts` dry-run / `--apply` 写盘。**已执行 APPLY：95/95 节点重命名**，备份在 `~/.textron_backups/pre_name_distill_20260720_011130/` |

## 生效条件

- **prompt 契约（契约文本/training note/规则9）需 pi 重载扩展或新会话才生效**——当前运行中的会话仍是旧 prompt。
- 节点名迁移已生效，下次 forward 的 L0 评分 prompt 即为蒸馏名。

## ⚠️ 下次测试重大关注清单

### A. prompt 层（最先验证）
- [ ] 系统提示中的 `## Textron HighEntropy Output Contract` 是否为新文案（含 Bad/Good 例子、"retrieval key" 字样）
- [ ] 用户消息尾部 training note 是否为"Name = 从 Content 提取 3-6 个最高熵关键术语拼接…"
- [ ] 助手输出的 `<HighEntropy>` Name 是否含 Content 的高熵术语（标识符/领域词/数字），而非泛化句

### B. 守卫与写盘层
- [ ] **守卫静默触发**：若助手仍给泛化名，`parseHighEntropyCrystal` 应自动替换——验证方式：对比助手原始输出的 Name 行 vs 写入节点 html 的 `<name>`（`grep -A2 '<name>' ~/.textron/*/layer_*/*.html`）
- [ ] backward 写入/更新的节点名：无 `...` 截断、含标识符/数字、CJK 用 `·` 连接
- [ ] content 未被改动（迁移和蒸馏只动 name）——抽查 `<content>` 与备份对比

### C. 前向质量层（核心收益指标）
- [ ] **L0 评分相关性**：蒸馏名（含领域词/数字）应提升 LLM 评分区分度——看 monitor `l0_score_done` 事件的 nonzeroCount/topScores 分布是否更稀疏（强相关高分、弱相关零分），而非普遍中位分
- [ ] 路由命中率：`route_done` 事件 taskFamily 是否更贴合任务域
- [ ] 注入的 SkillNode `Name:` 行可读、无 `...`

### D. 回归风险点（新机制可能出错处）
- [ ] **关键词沙拉名**：名字是否过度堆砌术语失去可读性（尤其数字密集内容，如 `2% 25% 0.65 0.55` 开头）
- [ ] `·` 连接符在 monitor.html 图视图/tooltip 显示是否正常（未做 HTML 转义测试）
- [ ] `isNgramFragmentContent` 误判：蒸馏名含空格分隔 latin 序列不应触发碎片隔离（观察 `_events.jsonl` 的 `node_artifact_quarantined_from_context`）
- [ ] `sharesKeywordWithContent` 误杀：合理的抽象名（如 `超卖补偿原理`）若被替换，注意 squash 比较是否过严
- [ ] semanticBackwardLLM 输出 name 质量：规则 9 改写后 LLM 是否真给关键词名（monitor `semantic_backward_llm_input` 可见 prompt）

### E. 与本次无关的预存问题（勿误判为本次回归）
- `test_learning_policy` 2 个 FAIL：`learning_policy.ts` 有未提交 WIP（novel_high_signal 策略），依赖链与本次改动无关
- `test_ngram_distill` 裸 node 跑会 ERR_MODULE_NOT_FOUND：测试文件 import `./ngram_distill` 缺 `.ts` 扩展名（commit 8a5023 即存在），jiti 下正常

## 验证命令速查

```bash
cd /Users/rama/textron-agent
node src/test_highentropy.ts          # 14/14
node src/test_prompt_injection.ts     # 17/17
node src/migrate_names.ts             # dry-run 查看还能改多少（应≈0，已迁移）
grep -rl '\.\.\.' ~/.textron/*/layer_*/*.html | head   # 应只剩 content 里的 ...，name 标签内不应有
```
