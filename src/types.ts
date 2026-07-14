// ─── Textron Types ────────────────────────────────────────────────────

export interface Hyperparams {
  layers: number[];
  threshold: number;
  learningRate: number;
  createdAt: string;
  updatedAt: string;
}

export interface Edge {
  from: string;
  to: string;
  weight: number;
}

export interface WeightsFile {
  layer_connections: Record<string, Edge[]>;
}

export interface ActivatedNode {
  id: string;
  layer: number;
  content: string;
  activation: number;
}
