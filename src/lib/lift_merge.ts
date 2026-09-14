// ═══════════════════════════════════════════════════════════════════════
// 抽象提升 merge —— 机制化实现 (2026-09-04 v2 重构)
//
// 设计机制(理解而非枚举):
//   1. 层 = 抽象级别(L0 最抽象), 内容抽象度向高层收敛。merge 是"同语义内容的
//      抽象收敛": 结果层由参与节点层号决定 —— 同层合并上提一级, 异层归入更
//      抽象层, L0 封顶。此为对任意层深度(L1..L5...)统一的纯函数, 无层特判。
//   2. 边 = (ngram 内容派生的)物化视图, 非独立实体。因此宿主换层后无需逐边
//      迁移 —— 一次 materialize() 由合并后内容自动重建全部 prior 边(跨层
//      top-K + 入度兜底, 结构上不产生孤立节点)。merge 对边的全部职责 =
//      保证新内容落盘 + 触发物化, 其余交给物化函数。
//   3. 训练资产(ledger delta)是独立账本, 键含层号+nodeId, 换层后坐标失效 →
//      需重锚。重锚规则同样与具体层号无关: 被吸收节点的经验边, 若另一端
//      存活且与宿主层相邻/同层(物化可达), 则按"小层为from"重建键; 否则丢弃。
//   4. 源节点物理清空 → compact(含 ledger 键 reindex) —— 统一收口。
// ═══════════════════════════════════════════════════════════════════════
import * as fs from "node:fs";
import * as path from "node:path";
import { writeJson, completeContent, previewText } from "./utils";
import { readNodeContent, writeNodeHtml, compressNodeName } from "./node_io";
import { layerCapFor } from "./network";
import { mergeContent } from "./merge";
import { materialize, parsePairKey } from "./topology";
import { NODE_CONTENT_MAX_CHARS } from "../content_limits.ts";

export interface LiftMergeOutcome {
  merged: boolean;
  hostLayer: number;
  hostId: string;
  emptied: { layer: number; nodeId: string }[];
  grafted: number;
  dropped: number;
  overflowNodeId: string | null;
  reason?: string;
}

/**
 * 结果层 = 抽象收敛规则(对任意层统一):
 *   同层双节点 → 上提一级; 异层 → 归入更抽象层; L0 封顶(0 不再上提)。
 *   L2+L2→L1 · L3+L3→L2 · L4+L4→L3 · L2+L3→L2 · 含L0→L0
 */
/**
 * merge 层向闸（单一事实来源，index.ts 解析层调用）:
 *   允许 同层(tgt==src)、相邻层(|Δ|=1)、以及任意级「向上提升」(tgt<src)。
 *   仅拒绝「向下跳层」(tgt-src>1) —— 即把抽象层知识塞进更具体的层，方向与
 *   liftMergeResultLayer 的「取更抽象层」语义相反，是真正的语义错误。
 * 背景(2026-09-14 n8 第三轮 guard 实证): 原解析层用 |Δlayer|>1 一刀切丢弃，
 *   导致 LLM 提出的 L3→L0 / L2→L0 抽象提升被静默拒绝 → merge_action_dropped(layer_jump)
 *   每次反传 nodesMerged=0，下层结论困在从不前向注入的 L3(topoKByLayer 只取 0/1/2)= 死知识。
 *   而 liftMergeNodes 本身按宿主定层+ledger 重锚+物化重建实现，对任意层差成立
 *   (仅容量硬闸会截断/拒绝)，故限制应只针对方向，不应针对跨度。
 */
export function mergeLayerAllowed(srcLayer: number, tgtLayer: number): boolean {
  return tgtLayer - srcLayer <= 1;
}

export function liftMergeResultLayer(srcLayer: number, tgtLayer: number): number {
  if (srcLayer === tgtLayer && srcLayer > 0) return srcLayer - 1; // 同层提升
  return Math.min(srcLayer, tgtLayer);                            // 异层取抽象 + L0 封顶
}

function nodePath(netPath: string, layer: number, nodeId: string): string {
  return path.join(netPath, `layer_${layer}`, `${nodeId}.html`);
}

/** 删除节点的 ngram 影子(内容整体替换后旧向量作废, 回退到内容 tokenize 派生) */
function wipeNgram(np: string): void {
  try {
    const ng = np.replace(/\.html$/, ".ngram.json");
    if (fs.existsSync(ng)) fs.unlinkSync(ng);
  } catch { /* 忽略 */ }
}

/** 在某层分配一个可用槽位(nodeId)。优先复用空壳(避免计数增长); 扩容前过 layerCaps 硬闸 —
 *  存活数>=cap 返回 null(调用方必须降级: 宿主落位失败/溢出截断)。任何路径(含 merge 派生、
 *  溢出伴随)不得使存活节点超容, layers[] 不再被静默 ++ 扩容。(2026-09-14 N2/B7 修复) */
function allocSlot(net: { hyperparams: { layers: number[]; layerCaps?: number[] }; path: string }, layer: number): string | null {
  for (let n = 0; n < net.hyperparams.layers[layer]; n++) {
    if (!readNodeContent(nodePath(net.path, layer, `node_${n}`))) return `node_${n}`;
  }
  const cap = layerCapFor(net.hyperparams as { layers: number[]; layerCaps?: number[] }, layer);
  let aliveCount = 0;
  for (let n = 0; n < net.hyperparams.layers[layer]; n++) {
    if (readNodeContent(nodePath(net.path, layer, `node_${n}`))) aliveCount++;
  }
  if (aliveCount >= cap) return null;
  fs.mkdirSync(path.join(net.path, `layer_${layer}`), { recursive: true });
  const newIdx = net.hyperparams.layers[layer];
  net.hyperparams.layers[layer]++;
  writeJson(path.join(net.path, "hyperparams.json"), net.hyperparams);
  return `node_${newIdx}`;
}

/** 节点引用是否指向存活内容 */
function alive(net: { path: string }, layer: number, nodeId: string): boolean {
  return fs.existsSync(nodePath(net.path, layer, nodeId)) && !!readNodeContent(nodePath(net.path, layer, nodeId))?.trim();
}

/**
 * merge 主入口 —— 只描述机制, 不按场景枚举:
 *   1) 定结果层; 2) 合并内容(溢出落伴随节点); 3) 宿主 = 结果层中仍在场的源
 *      或新槽位(单点逻辑, 无 L2/L3/L4 特判); 4) 重锚 ledger 资产; 5) 清空源;
 *      6) 物化重建全部边。
 */
export function liftMergeNodes(
  net: { hyperparams: { layers: number[] }; path: string; weights: any },
  source: { layer: number; nodeId: string },
  target: { layer: number; nodeId: string },
  onLog?: (msg: string) => void,
): LiftMergeOutcome {
  const log = (m: string) => onLog?.(m);
  const srcContent = readNodeContent(nodePath(net.path, source.layer, source.nodeId));
  const tgtContent = readNodeContent(nodePath(net.path, target.layer, target.nodeId));
  if (!srcContent?.trim() || !tgtContent?.trim()) {
    return { merged: false, hostLayer: -1, hostId: "", emptied: [], grafted: 0, dropped: 0, overflowNodeId: null, reason: "empty_content" };
  }
  if (source.layer === target.layer && source.nodeId === target.nodeId) {
    return { merged: false, hostLayer: -1, hostId: "", emptied: [], grafted: 0, dropped: 0, overflowNodeId: null, reason: "self_merge" };
  }

  const hostLayer = liftMergeResultLayer(source.layer, target.layer);
  const mergedRaw = mergeContent(tgtContent, srcContent);
  const merged = completeContent(mergedRaw, NODE_CONTENT_MAX_CHARS);
  const hostName = compressNodeName(merged).slice(0, 64);

  // ── 宿主落位(单点机制): 结果层中仍在场的参与者优先复用, 否则新槽 ──
  const keepSrc = source.layer === hostLayer && alive(net, source.layer, source.nodeId);
  const keepTgt = target.layer === hostLayer && alive(net, target.layer, target.nodeId);
  let hostLayerActual = hostLayer, hostId: string;
  const emptied: { layer: number; nodeId: string }[] = [];
  if (keepTgt) { hostId = target.nodeId; emptied.push({ layer: source.layer, nodeId: source.nodeId }); }
  else if (keepSrc) { hostId = source.nodeId; emptied.push({ layer: target.layer, nodeId: target.nodeId }); }
  else {
    const slot = allocSlot(net, hostLayer);
    if (!slot) {
      // 容量硬闸: 结果层无空壳且存活已满 → merge 拒绝落盘, 原因交上层压缩轮回喂 LLM
      return { merged: false, hostLayer: -1, hostId: "", emptied: [], grafted: 0, dropped: 0, overflowNodeId: null, reason: `host_alloc_over_cap(L${hostLayer})` };
    }
    hostId = slot;
    emptied.push({ layer: source.layer, nodeId: source.nodeId });
    if (!(source.layer === target.layer && source.nodeId === target.nodeId)) emptied.push({ layer: target.layer, nodeId: target.nodeId });
  }
  // 若同时复用两参与者(理论不发生, 防御), 取 target 复用并吸收另一者 → 已在 keepTgt 分支覆盖

  // 溢出 >1000c: 落伴随节点(同结果层)。硬闸(2026-09-14): 槽位分配延后到源节点清空之后 —
  // merge 自身腾出的空壳优先复用; 仍无空壳且层满 → 溢出截断, 宁截断不超容。
  let overflowNodeId: string | null = null;
  const overflowRaw = mergedRaw.length > NODE_CONTENT_MAX_CHARS ? completeContent(mergedRaw.slice(NODE_CONTENT_MAX_CHARS), NODE_CONTENT_MAX_CHARS) : "";

  // ── 写宿主内容(边稍后由 materialize + commitNodeHtmlEdges 统一重建) ──
  const hostPath = nodePath(net.path, hostLayerActual, hostId);
  wipeNgram(hostPath);
  writeNodeHtml(hostPath, hostLayerActual, hostId, merged, [], hostName);

  // ── ledger 训练资产重锚(与层号无关的通用规则) ──
  const led = (net.weights.ledger ||= {}) as Record<string, { delta: number; n: number }>;
  const graftMap = new Map<string, { d: number; n: number; c: number }>();
  let dropped = 0;
  const isEmptied = (l: number, id: string) => emptied.some((e) => e.layer === l && e.nodeId === id);
  for (const em of emptied) {
    for (const [k, v] of Object.entries(led)) {
      const pk = parsePairKey(k);
      if (!pk) continue;
      const meIsFrom = pk.l === em.layer && pk.from === em.nodeId;
      const meIsTo = pk.m === em.layer && pk.to === em.nodeId;
      if (!meIsFrom && !meIsTo) continue;
      const oLayer = meIsFrom ? pk.m : pk.l;
      const oId = meIsFrom ? pk.to : pk.from;
      if (isEmptied(oLayer, oId)) { dropped++; continue; }              // 两源互边无宿主
      if (!alive(net, oLayer, oId)) { dropped++; continue; }            // 另一端已死
      if (oLayer !== hostLayerActual && Math.abs(oLayer - hostLayerActual) !== 1) { dropped++; continue; } // 物化不可达
      const same = oLayer === hostLayerActual;
      const lo = Math.min(oLayer, hostLayerActual);
      const hi = Math.max(oLayer, hostLayerActual);
      const fromId = same ? oId : oLayer < hostLayerActual ? oId : hostId;
      const toId = same ? hostId : oLayer < hostLayerActual ? hostId : oId;
      const newKey = `${lo}_to_${hi}:${fromId}:${toId}`;
      const d = Number(v.delta) || 0, n = Number(v.n) || 0;
      const acc = graftMap.get(newKey) || { d: 0, n: 0, c: 0 };
      acc.d += d * n; acc.n += n; acc.c++;
      graftMap.set(newKey, acc);
    }
  }
  let grafted = 0;
  for (const [newKey, acc] of graftMap) {
    const n = Math.max(1, Math.round(acc.n));
    const delta = acc.n > 0 ? acc.d / acc.n : 0;
    const ex = led[newKey];
    led[newKey] = ex
      ? { delta: (ex.delta * ex.n + delta * n) / (ex.n + n), n: ex.n + n }
      : { delta, n };
    grafted += acc.c;
  }
  // 清理指向已吸收节点的死键(防物化引用幽灵节点)
  for (const em of emptied) {
    for (const k of Object.keys(led)) {
      const pk = parsePairKey(k);
      if (pk && ((pk.l === em.layer && pk.from === em.nodeId) || (pk.m === em.layer && pk.to === em.nodeId))) delete led[k];
    }
  }

  // ── 清空被吸收源(留空壳, 统一由调用方 compact; compact 会重索引 ledger 键) ──
  for (const em of emptied) {
    const np = nodePath(net.path, em.layer, em.nodeId);
    wipeNgram(np);
    if (fs.existsSync(np)) writeNodeHtml(np, em.layer, em.nodeId, "", [], "");
  }

  // ── 溢出伴随节点(槽位分配在源清空后: 优先复用 merge 腾出的空壳; 硬闸下宁截断不超容) ──
  if (overflowRaw.trim()) {
    const slot = allocSlot(net, hostLayerActual);
    if (slot) {
      overflowNodeId = slot;
      writeNodeHtml(nodePath(net.path, hostLayerActual, overflowNodeId), hostLayerActual, overflowNodeId, overflowRaw, [], compressNodeName(overflowRaw).slice(0, 64));
    } else {
      log(`Textron lift-merge: overflow dropped (L${hostLayerActual} at cap, hard gate)`);
    }
  }

  // ── 物化: 从(已更新的)内容重建全部边 = merge 对边的唯一动作 ──
  net.hyperparams.updatedAt = new Date().toISOString();
  writeJson(path.join(net.path, "hyperparams.json"), net.hyperparams);
  materialize(net);
  writeJson(path.join(net.path, "weights.json"), net.weights);

  log(`Textron lift-merge: ${source.layer===target.layer?`L${source.layer}::${source.nodeId}+L${source.layer}::${target.nodeId}`:`L${source.layer}::${source.nodeId}+L${target.layer}::${target.nodeId}`} → L${hostLayerActual}::${hostId} (grafted=${grafted}, dropped=${dropped}, emptied=${emptied.length})`);
  return { merged: true, hostLayer: hostLayerActual, hostId, emptied, grafted, dropped, overflowNodeId };
}
