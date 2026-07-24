import * as fs from "node:fs";
import * as path from "node:path";
import { ensureDir, readJson, writeJson } from "./utils";
import { NODE_CONTENT_MAX_CHARS } from "../content_limits.ts";

export const TEXTRON_HOME = path.join(
  process.env.HOME || process.env.USERPROFILE || "~",
  ".textron",
);

export const DEFAULT_HYPERPARAMS = {
  layers: [4, 6, 8] as number[],
  threshold: 0.2,
  learningRate: 0.08,
  createdAt: "",
  updatedAt: "",
};

export const DEFAULT_WEIGHT = 0.5;
export const NGRAM_DISTILL_PROMOTE = true;
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

  const weights: WeightsFile = { layer_connections: {} };
  for (let l = 0; l < layers.length - 1; l++) {
    const key = `${l}_to_${l + 1}`;
    weights.layer_connections[key] = [];
    for (let from = 0; from < layers[l]; from++) {
      for (let to = 0; to < layers[l + 1]; to++) {
        weights.layer_connections[key].push({ from: `node_${from}`, to: `node_${to}`, weight: DEFAULT_WEIGHT });
      }
    }
  }
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
  const weights = readJson<WeightsFile>(weightsPath, { layer_connections: {} });

  return {
    path: tfPath,
    hyperparams: hp,
    weights,
    taskFamily,
  };
}
