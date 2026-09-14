import * as fs from "node:fs";
import * as path from "node:path";
import { writeJson, completeContent, previewText } from "./utils";
import { readNodeContent, readNodeName, writeNodeHtml, compressNodeName, validateKnowledgeCrystal, intraLayerOrthogonalityCheck, readNodeFunction, writeNodeFunction } from "./node_io";
import { mergeNodeContent, mergeContent } from "./merge";
import { findSimilarKnowledgeNode, jaccard, nameTokens, tokenSimilarity } from "./similarity";
import { NODE_CONTENT_MAX_CHARS } from "../content_limits.ts";
import { distillNodeName } from "../name_distill.ts";
import { DEFAULT_WEIGHT, TEXTRON_ALLOW_NODE_GROWTH, NGRAM_DISTILL_PROMOTE, layerCapFor } from "./network";
import { rescaleRejectedCrystal } from "./rescale";
import { materialize, parsePairKey } from "./topology";

// ── recordArtifactEvent stub (actual implementation in index.ts) ──
let _recordArtifactEvent: Function = () => {};
export function setRecordArtifactEvent(fn: Function) { _recordArtifactEvent = fn; }

// ── 2026-08-19 统一收口: 边变更后必刷 HTML link (唯一出口) ──
// 根因: backward 边权重更新(index.ts 1678/1703)只写 weights.json 不刷 HTML → 账货不一致 → "假孤立".
// 原则: 所有边增/改/删后必须调用本函数刷新受影响节点的 HTML <link>, 保证 weights(账) 与 HTML(货) 永远一致.
export function commitNodeHtmlEdges(
  net: { hyperparams: { layers: number[] }; path: string; weights: any },
  layer: number,
  nodeId: string,
): void {
  const np = path.join(net.path, `layer_${layer}`, `${nodeId}.html`);
  if (!fs.existsSync(np)) return;
  const content = readNodeContent(np);
  const name = readNodeName(np);
  const outEdges = (net.weights?.layer_connections?.[`${layer}_to_${layer + 1}`] || [])
    .filter((e: any) => e.from === nodeId)
    .map((e: any) => ({ toId: e.to, weight: e.weight }));
  writeNodeHtml(np, layer, nodeId, content, outEdges, name);
}

/**
 * 三层架构(2026-09): 边 = (ngram 拓扑 ∪ 经验 ledger) 的物化视图, 全局幂等重建。
 * 旧的"逐节点补全连接边"账本已作废 —— 孤立节点在结构上不可能出现(buildTopology 入度兜底)。
 */
export function ensureNodeEdges(
  net: { hyperparams: { layers: number[] }; path: string; weights: any },
  layer: number,
  nodeId: string,
  onLog?: (msg: string) => void,
): boolean {
  if (!net.weights) return false;
  const stats = materialize(net);
  onLog?.(`Textron: materialize L${layer}::${nodeId} → edges=${stats.edges} lateral=${stats.lateral} trained=${stats.trained}`);
  return true;
}

export function chooseExpansionLayer(
  net: { hyperparams: { layers: number[] }; path: string },
  requestedLayer?: number,
): number {
  if (requestedLayer !== undefined && requestedLayer >= 0 && requestedLayer <= net.hyperparams.layers.length) {
    return requestedLayer;  // requestedLayer == length: 新建一层(层平衡规则9: 各层满载时追加新层)
  }
  // Default: add to deepest layer for concrete rules
  return net.hyperparams.layers.length - 1;
}

export function updateExistingNodeByPolicy(
  net: { hyperparams: { layers: number[] }; path: string; weights: any },
  layer: number,
  nodeId: string,
  name: string,
  newContent: string,
  onLog: (msg: string) => void,
  /**
   * mode="merge"（默认，旧行为）：old|new 拼接合并——适合同域知识增量累积。
   * mode="replace"：**真覆盖**（name/content 都替换）。用于「网络目标」驱动的离域清洗：
   *   网络目标是交易经验，而节点装的是工程知识时，merge 会把两个域拼接成关键词垃圾抽屉，
   *   永远清洗不掉；此时必须 replace。跨域写入无权拼接（不同域无增量语义）。
   */
  opts?: { mode?: "merge" | "replace" },
): { updated: boolean; nodeId: string; layer: number; oldContent: string; newContent: string; mode: "merge" | "replace" } {
  const mode: "merge" | "replace" = opts?.mode === "replace" ? "replace" : "merge";
  const np = path.join(net.path, `layer_${layer}`, `${nodeId}.html`);
  const oldContent = readNodeContent(np);
  const oldName = readNodeName(np);

  // replace 模式下空内容 = 清空请求，属非法写入（系统禁止 delete），拒绝而非误清节点
  const incoming = String(newContent || "").trim();
  if (mode === "replace" && !incoming) {
    onLog(`Textron: cleanse write rejected for L${layer}::${nodeId} — empty content`);
    return { updated: false, nodeId, layer, oldContent, newContent: oldContent, mode };
  }

  const merged = mode === "replace" ? incoming : mergeNodeContent(oldContent, incoming);
  const validation = validateKnowledgeCrystal(merged, layer);
  if (!validation.ok) {
    // Try rescale
    const rescale = rescaleRejectedCrystal(net, merged, validation.reason, layer, onLog, addPolicyNode, _recordArtifactEvent);
    if (rescale?.rescued) {
      onLog(`Textron: node ${mode === "replace" ? "cleanse" : "update"} rejected (${validation.reason}), rescale→L${rescale.layer}::${rescale.nodeId}`);
      return { updated: false, nodeId, layer, oldContent, newContent: merged, mode };
    }
    onLog(`Textron: node ${mode === "replace" ? "cleanse" : "update"} rejected — ${validation.reason}`);
    return { updated: false, nodeId, layer, oldContent, newContent: merged, mode };
  }

  // merge 保留旧名以维持概念继承；replace 时旧名是离域名的残留，必须丢弃（否则 Name 子串路由继续错配）
  const distilledName = mode === "replace"
    ? distillNodeName(String(name || "").slice(0, 200))
    : distillNodeName((oldName + " " + name).slice(0, 200));
  const existing = net.weights?.layer_connections?.[`${layer}_to_${layer + 1}`] || [];
  const outEdges = existing
    .filter((e: any) => e.from === nodeId)
    .map((e: any) => ({ toId: e.to, weight: e.weight }));

  writeNodeHtml(np, layer, nodeId, validation.content, outEdges, distilledName);
  // 内容变 → 拓扑先验变: 重物化落盘 + 刷 HTML(账货一致)
  ensureNodeEdges(net, layer, nodeId, onLog);
  writeJson(path.join(net.path, "weights.json"), net.weights);
  commitNodeHtmlEdges(net, layer, nodeId);
  onLog(`Textron: ${mode === "replace" ? "cleansed" : "updated"} L${layer}::${nodeId} "${previewText(oldName, 40)}" → "${previewText(distilledName, 40)}"`);
  return { updated: true, nodeId, layer, oldContent, newContent: validation.content, mode };
}

export function addPolicyNode(
  net: { hyperparams: { layers: number[] }; path: string; weights: any },
  targetLayer: number,
  content: string,
  onLog: (msg: string) => void,
  name?: string,
  requestedLayer?: number,
  opts?: { mergeSimilar?: boolean; similarityThreshold?: number },
): { added: boolean; merged: boolean; replaced: boolean; nodeId: string; layer: number; skipped?: boolean; reason?: string } {
  const layer = chooseExpansionLayer(net, requestedLayer ?? targetLayer);
  // 层平衡规则9: 所有现有层满载且确需新增 → 请求 layer==length 新建一层(容量从0起, 下方 append 生成 node_0)
  if (layer === net.hyperparams.layers.length) {
    net.hyperparams.layers.push(0);
    // 新层目录可能不存在, 先建(后续 writeNodeHtml 依赖)
    fs.mkdirSync(path.join(net.path, `layer_${layer}`), { recursive: true });
  }

  // Check orthogonality
  const ortho = intraLayerOrthogonalityCheck(net, layer, content);
  if (ortho.tooSimilar && opts?.mergeSimilar !== false) {
    // Merge into existing similar node
    const existingNodeId = ortho.similarTo!.split("::")[1];
    const result = updateExistingNodeByPolicy(net, layer, existingNodeId, name || "", content, onLog);
    return { added: false, merged: true, replaced: false, nodeId: existingNodeId, layer };
  }

  // Check similarity threshold for merge
  if (opts?.mergeSimilar && (opts.similarityThreshold || 0) > 0) {
    const similar = findSimilarKnowledgeNode(net, layer, content);
    if (similar && similar.similarity >= (opts.similarityThreshold || 0.40)) {
      const result = updateExistingNodeByPolicy(net, layer, similar.nodeId, name || "", content, onLog);
      return { added: false, merged: true, replaced: false, nodeId: similar.nodeId, layer };
    }
  }

  // Validate
  const validation = validateKnowledgeCrystal(content, layer);
  if (!validation.ok) {
    const rescale = rescaleRejectedCrystal(net, content, validation.reason, layer, onLog, addPolicyNode, _recordArtifactEvent);
    if (rescale?.rescued) {
      return { added: true, merged: false, replaced: false, nodeId: rescale.nodeId!, layer: rescale.layer! };
    }
    return { added: false, merged: false, replaced: false, nodeId: "", layer };
  }

  if (!TEXTRON_ALLOW_NODE_GROWTH) {
    return { added: false, merged: false, replaced: false, nodeId: "", layer };
  }

  // 容量硬约束：used>=cap 的层禁止净新增（填空槽/扩容都算）。迫使上层走 merge/node_updates。
  let usedCount = 0;
  for (let n = 0; n < net.hyperparams.layers[layer]; n++) {
    if (readNodeContent(path.join(net.path, `layer_${layer}`, `node_${n}.html`))) usedCount++;
  }
  const cap = layerCapFor(net.hyperparams as { layers: number[]; layerCaps?: number[] }, layer);
  if (usedCount >= cap) {
    onLog(`Textron: add node skipped L${layer} (over cap ${usedCount}/${cap}) — merge or update existing nodes first`);
    return { added: false, merged: false, replaced: false, nodeId: "", layer, skipped: true, reason: `over_cap(${usedCount}/${cap})` };
  }

  // Find replacement slot (empty node) or append
  let slotIdx = -1;
  for (let n = 0; n < net.hyperparams.layers[layer]; n++) {
    if (!readNodeContent(path.join(net.path, `layer_${layer}`, `node_${n}.html`))) {
      slotIdx = n;
      break;
    }
  }

  if (slotIdx >= 0) {
    // Replace empty node
    const nodeId = `node_${slotIdx}`;
    const np = path.join(net.path, `layer_${layer}`, `${nodeId}.html`);
    // 三层架构: 先写内容(拓扑从 ngram/内容派生) → 再物化 → 新节点出生即有边, 冷启动自锁解除
    writeNodeHtml(np, layer, nodeId, validation.content, [], name);
    ensureNodeEdges(net, layer, nodeId, onLog);
    writeJson(path.join(net.path, "weights.json"), net.weights);
    commitNodeHtmlEdges(net, layer, nodeId);
    onLog(`Textron: replaced empty L${layer}::${nodeId} "${previewText(name || validation.content, 40)}"`);
    return { added: true, merged: false, replaced: true, nodeId, layer };
  }

  // Need to expand layer
  const newIdx = net.hyperparams.layers[layer];
  net.hyperparams.layers[layer]++;
  const nodeId = `node_${newIdx}`;
  const np = path.join(net.path, `layer_${layer}`, `${nodeId}.html`);

  // 三层架构: 不再手工 push 全连接边 —— 先写内容, 物化从内容派生拓扑(含入度兜底)
  writeNodeHtml(np, layer, nodeId, validation.content, [], name);
  writeJson(path.join(net.path, "hyperparams.json"), net.hyperparams);
  ensureNodeEdges(net, layer, nodeId, onLog);
  writeJson(path.join(net.path, "weights.json"), net.weights);
  // 物化后新旧节点账都变 → 统一刷 HTML link(账→货一致)
  commitNodeHtmlEdges(net, layer, nodeId);
  if (layer > 0 && net.hyperparams.layers.length > 1) {
    for (let p = 0; p < net.hyperparams.layers[layer - 1]; p++) {
      try { commitNodeHtmlEdges(net, layer - 1, `node_${p}`); } catch { /* 忽略 */ }
    }
  }
  onLog(`Textron: added L${layer}::${nodeId} "${previewText(name || validation.content, 40)}"`);
  return { added: true, merged: false, replaced: false, nodeId, layer };
}

/**
 * 2026-09-04 修复: 层内移除空节点(compact)后, ledger 键含 node_X 序号必须同步重索引,
 * 否则物化视图引用已移位/已删除的节点身份 → 账外残留(node_88 空壳、L1 孤儿 ngram 同源)。
 * 在单次移除 index n 后调用: 该层序号 > n 的全部端点 -1; 端点 == n 的键随节点删除丢弃。
 */
export function reindexLedgerAfterRemoval(
  net: { hyperparams: { layers: number[] }; path: string; weights: any },
  layer: number,
  removedIdx: number,
): number {
  const led = net.weights?.ledger;
  if (!led || typeof led !== "object") return 0;
  const out: Record<string, { delta: number; n: number }> = {};
  let killed = 0;
  for (const [k, v] of Object.entries<any>(led)) {
    const pk = parsePairKey(k);
    if (!pk) { out[k] = v; continue; }
    const fromIdx = parseInt(pk.from.replace("node_", ""), 10);
    const toIdx = parseInt(pk.to.replace("node_", ""), 10);
    let from2 = pk.from, to2 = pk.to;
    let kill = false;
    if (pk.l === layer) {
      if (fromIdx === removedIdx) kill = true;
      else if (fromIdx > removedIdx) from2 = `node_${fromIdx - 1}`;
    }
    if (pk.m === layer) {
      if (toIdx === removedIdx) kill = true;
      else if (toIdx > removedIdx) to2 = `node_${toIdx - 1}`;
    }
    if (kill) { killed++; continue; }
    out[`${pk.l}_to_${pk.m}:${from2}:${to2}`] = v;
  }
  net.weights.ledger = out;
  return killed;
}

export function compactMergeEmptiedNodes(
  net: { hyperparams: { layers: number[] }; path: string; weights: any },
  onLog: (msg: string) => void,
): number {
  let compacted = 0;
  for (let l = 0; l < net.hyperparams.layers.length; l++) {
    const layerDir = path.join(net.path, `layer_${l}`);
    for (let n = net.hyperparams.layers[l] - 1; n >= 0; n--) {
      const np = path.join(layerDir, `node_${n}.html`);
      if (!readNodeContent(np)) {
        // 2026-09-04: html 移动时同步移动 ngram 影子文件, 防孤儿 ngram 残留
        const moveSidecar = (fromBase: string, toBase: string) => {
          const ngFrom = fromBase.replace(/\.html$/, ".ngram.json");
          const ngTo = toBase.replace(/\.html$/, ".ngram.json");
          if (fs.existsSync(ngFrom)) { try { fs.renameSync(ngFrom, ngTo); } catch { fs.unlinkSync(ngFrom); } }
        };
        // Empty node: shift all higher indices down
        for (let m = n; m < net.hyperparams.layers[l] - 1; m++) {
          const src = path.join(layerDir, `node_${m + 1}.html`);
          const dst = path.join(layerDir, `node_${m}.html`);
          if (fs.existsSync(src)) {
            const srcContent = readNodeContent(src);
            const srcName = readNodeName(src);
            const outEdges = (net.weights?.layer_connections?.[`${l}_to_${l + 1}`] || [])
              .filter((e: any) => e.from === `node_${m + 1}`)
              .map((e: any) => ({ toId: e.to, weight: e.weight }));
            writeNodeHtml(dst, l, `node_${m}`, srcContent, outEdges, srcName);
            // 2026-09-14 (n8 第四轮 guard 实证): <function> 块不随 content 一起移位 —— writeNodeHtml 只
            // 保留 DEST 自己的块(空壳→无块)，源文件随后被 unlink ⇒ 一次 compact/merge 蒸发一批函数产物
            // (实测第三轮 4 个真块只剩 1 个历史垃圾块，而 content 仍挂 [fn:σ] = 引用链由部分断变全断)。
            // 修法: 从 SOURCE 读块并显式搬到 DEST，与 ngram 影子文件同批处理。
            const srcFn = readNodeFunction(src);
            if (srcFn) writeNodeFunction(dst, srcFn.symbol, srcFn.code);
            moveSidecar(src, dst);
            fs.unlinkSync(src);
          }
        }
        // Update edge weights to reflect new indices
        for (const key of Object.keys(net.weights?.layer_connections || {})) {
          const edges = net.weights.layer_connections[key];
          for (const e of edges) {
            const fromNum = parseInt(String(e.from).replace("node_", ""), 10);
            const toNum = parseInt(String(e.to).replace("node_", ""), 10);
            if (String(e.from).startsWith("node_") && fromNum > n) e.from = `node_${fromNum - 1}`;
            if (String(e.to).startsWith("node_") && toNum > n) e.to = `node_${toNum - 1}`;
          }
        }
        // 2026-09-04: ledger 键同步重索引(否则账本引用已移位节点)
        try { reindexLedgerAfterRemoval(net, l, n); } catch { /* 防御 */ }
        net.hyperparams.layers[l]--;
        compacted++;
      }
    }
  }
  if (compacted > 0) {
    writeJson(path.join(net.path, "hyperparams.json"), net.hyperparams);
    writeJson(path.join(net.path, "weights.json"), net.weights);
    onLog(`Textron: compacted ${compacted} empty nodes`);
  }
  return compacted;
}

export function compactEmptyNodes(
  net: { hyperparams: { layers: number[] }; path: string; weights: any },
  onLog: (msg: string) => void,
): number {
  return compactMergeEmptiedNodes(net, onLog);
}

export function addDynamicNode(
  net: { hyperparams: { layers: number[] }; path: string; weights: any },
  layer: number,
  content: string,
  onLog: (msg: string) => void,
  name?: string,
): { added: boolean; merged: boolean; replaced: boolean; nodeId: string; layer: number } {
  return addPolicyNode(net, layer, content, onLog, name, layer, { mergeSimilar: true, similarityThreshold: 0.40 });
}
