import * as path from "node:path";
import type { Hyperparams } from "./types";

// ─── Textron Constants ────────────────────────────────────────────────

export const TEXTRON_HOME = path.join(
  process.env.HOME || process.env.USERPROFILE || "~",
  ".textron",
);

export const DEFAULT_HYPERPARAMS: Hyperparams = {
  // Front-narrow/back-wide: early layers are abstract routers, later layers hold concrete specifics.
  layers: [4, 6, 8],
  threshold: 0.15,
  learningRate: 0.08,
  createdAt: "",
  updatedAt: "",
};

export const DEFAULT_WEIGHT = 0.5;
