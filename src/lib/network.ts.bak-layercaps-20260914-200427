import * as fs from "node:fs";
import * as path from "node:path";
import { ensureDir, readJson, writeJson } from "./utils";
import { NODE_CONTENT_MAX_CHARS } from "../content_limits.ts";
import { migrateLedger, materialize } from "./topology";

// 2026-09-03: 允许用 TEXTRON_HOME 改根目录（默认 ~/.textron 不变）。
// 目的是把“验证”与“生产网络”分开：端到端验证可整份复制网络到临时目录跑，
// 不会往真网络写测试节点（否则验证本身成为污染源）。
export const TEXTRON_HOME = path.join(
  process.env.TEXTRON_HOME || path.join(process.env.HOME || process.env.USERPROFILE || "~", ".textron"),
);

export const DEFAULT_HYPERPARAMS = {
  layers: [4, 6, 8] as number[],
  threshold: 0.2,
  learningRate: 0.08,
  createdAt: "",
  updatedAt: "",
};

export const DEFAULT_WEIGHT = 0.5;
// 2026-09: n-gram 蒸馏产物为 top-5 n-gram 的 "; " 机械拼接（如 "gpt; reasons.append; 'model"），
// 无句法/因果连贯，覆盖精心书写的知识节点后产生不可读内容。改为 shadow-only：
// 仍后台计数/记录蒸馏候选(monitor shadow 事件)，但不再覆盖节点 content。
export const NGRAM_DISTILL_PROMOTE = false;
export const TEXTRON_ALLOW_NODE_GROWTH = true;

export function getTaskFamilyPath(taskFamily: string): string {
  const safe = taskFamily.replace(/[^a-zA-Z0-9\u4e00-\u9fff_-]/g, "_").slice(0, 64);
  return path.join(TEXTRON_HOME, safe);
}

export function networkExists(taskFamily: string): boolean {
  return fs.existsSync(path.join(getTaskFamilyPath(taskFamily), "hyperparams.json"));
}

export function listNetworks(): string[] {
  if (!fs.existsSync(TEXTRON_HOME)) return [];
  return fs.readdirSync(TEXTRON_HOME).filter((d) => {
    const full = path.join(TEXTRON_HOME, d);
    return fs.statSync(full).isDirectory() && fs.existsSync(path.join(full, "hyperparams.json"));
  });
}

interface Hyperparams {
  layers: number[];
  threshold: number;
  learningRate: number;
  createdAt: string;
  updatedAt: string;
}

interface WeightsFile {
  layer_connections: Record<string, { from: string; to: string; weight: number }[]>;
  /** 经验层(三层架构): 只存 backward 真正训过的 pair → {delta,n}; 拓扑先验不存储, 物化时由 ngram 派生 */
  ledger?: Record<string, { delta: number; n: number }>;
}

export function initNetwork(
  taskFamily: string,
  layers: number[],
  threshold: number,
  learningRate: number,
  onLog: (msg: string) => void,
): Hyperparams {
  const tfPath = getTaskFamilyPath(taskFamily);
  ensureDir(tfPath);

  const now = new Date().toISOString();
  const hp: Hyperparams = { layers, threshold, learningRate, createdAt: now, updatedAt: now };
  writeJson(path.join(tfPath, "hyperparams.json"), hp);

  // 三层架构: 不再预写全连接假先验 —— 拓扑由 ngram 内容派生, 物化视图首次使用时生成
  const weights: WeightsFile = { layer_connections: {}, ledger: {} };
  writeJson(path.join(tfPath, "weights.json"), weights);

  for (let l = 0; l < layers.length; l++) {
    const layerDir = path.join(tfPath, `layer_${l}`);
    ensureDir(layerDir);
    for (let n = 0; n < layers[l]; n++) {
      const fp = path.join(layerDir, `node_${n}.html`);
      const outEdges = l < layers.length - 1
        ? layers[l + 1] > 0 ? [{ toId: `node_0`, weight: DEFAULT_WEIGHT }] : []
        : [];
      const fs = require("node:fs");
      const html = `<!DOCTYPE html>
<meta name="layer" content="${l}">
<meta name="id" content="node_${n}">
<name></name>
<content></content>
`;
      fs.writeFileSync(fp, html, "utf-8");
    }
  }

  onLog(`Textron: initialized network "${taskFamily}" with layers [${layers.join(",")}]`);
  return hp;
}

export function loadNetwork(taskFamily: string) {
  const tfPath = getTaskFamilyPath(taskFamily);
  const hpPath = path.join(tfPath, "hyperparams.json");
  if (!fs.existsSync(hpPath)) return null;
  const hp = readJson<Hyperparams>(hpPath, DEFAULT_HYPERPARAMS);
  const weightsPath = path.join(tfPath, "weights.json");
  const weights = readJson<WeightsFile>(weightsPath, { layer_connections: {}, ledger: undefined });

  const net = {
    path: tfPath,
    hyperparams: hp,
    weights,
    taskFamily,
  };
  // 旧格式(无 ledger) → 一次性迁移: 重复边 collapse, 训练过的边反解 delta 保真, 然后物化落盘
  if (!weights.ledger) {
    migrateLedger(net);
    materialize(net);
    writeJson(weightsPath, weights);
  }
  return net;
}
