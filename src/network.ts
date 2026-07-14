import * as fs from "node:fs";
import * as path from "node:path";
import { getTaskFamilyPath, ensureDir, readJson, writeJson, writeNodeHtml, readNodeContent, readNodeName, compressNodeName } from "./storage";
import { TEXTRON_HOME, DEFAULT_HYPERPARAMS, DEFAULT_WEIGHT } from "./constants";
import { seedRandom } from "./utils";
import type { Hyperparams, WeightsFile, Edge } from "./types";

// ─── Textron Network CRUD ─────────────────────────────────────────────

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
  const rng = seedRandom(taskFamily);
  let totalEdges = 0;

  for (let l = 0; l < layers.length - 1; l++) {
    const edges: Edge[] = [];
    for (let f = 0; f < layers[l]; f++) {
      for (let t = 0; t < layers[l + 1]; t++) {
        if (rng() < 0.6) {
          edges.push({ from: `node_${f}`, to: `node_${t}`, weight: DEFAULT_WEIGHT });
          totalEdges++;
        }
      }
    }
    weights.layer_connections[`${l}_to_${l + 1}`] = edges;
  }
  writeJson(path.join(tfPath, "weights.json"), weights);

  // All nodes start empty — LLM fills them via backward
  for (let l = 0; l < layers.length; l++) {
    const layerDir = path.join(tfPath, `layer_${l}`);
    ensureDir(layerDir);
    const outEdges = l < layers.length - 1 ? (weights.layer_connections[`${l}_to_${l + 1}`] || []) : [];
    for (let n = 0; n < layers[l]; n++) {
      const nid = `node_${n}`;
      const nodeEdges = outEdges.filter((e) => e.from === nid).map((e) => ({ toId: e.to, weight: e.weight }));
      writeNodeHtml(path.join(layerDir, `${nid}.html`), l, nid, "", nodeEdges);
    }
  }

  onLog(`Textron: created network "${taskFamily}" [${layers.join(",")}] ${layers.reduce((a,b)=>a+b,0)} nodes, ${totalEdges} edges`);
  return hp;
}

export interface LoadedNetwork {
  path: string;
  hyperparams: Hyperparams;
  weights: WeightsFile;
}

export function loadNetwork(taskFamily: string): LoadedNetwork | null {
  const tfPath = getTaskFamilyPath(taskFamily);
  if (!fs.existsSync(tfPath)) return null;
  return {
    path: tfPath,
    hyperparams: readJson<Hyperparams>(path.join(tfPath, "hyperparams.json"), DEFAULT_HYPERPARAMS),
    weights: readJson<WeightsFile>(path.join(tfPath, "weights.json"), { layer_connections: {} }),
  };
}
