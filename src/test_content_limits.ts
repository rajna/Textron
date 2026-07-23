declare const process: { exit(code?: number): never };

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { NODE_CONTENT_MAX_CHARS } from "./content_limits.ts";
import { mergeNodeContent } from "./orthogonality.ts";
import { readNodeContent, writeNodeHtml } from "./storage.ts";

let passed = 0;
let failed = 0;

function ok(name: string, condition: boolean, detail = "") {
  if (condition) {
    passed++;
    console.log(`  OK ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}${detail ? ` - ${detail}` : ""}`);
  }
}

const oldContent = "旧机制因为边界条件成立所以保留。".repeat(24);
const newContent = "新技巧通过验证信号修复失败路径。".repeat(24);
const merged = mergeNodeContent(oldContent, newContent);
ok("orthogonality merge exceeds legacy 480 cap", merged.length > 480, `length=${merged.length}`);
ok("orthogonality merge respects 1000 cap", merged.length <= NODE_CONTENT_MAX_CHARS, `length=${merged.length}`);
ok("orthogonality merge keeps old and new evidence", merged.includes("旧机制") && merged.includes("新技巧"));

const oldBoundary = "prev已显著下跌后，current缩量急跌且贴近支撑时，应视为压力释放后的回踩，而非破位延续。";
const duplicatedOld = `${oldBoundary} | ${oldBoundary}`;
const newBoundary = "next若同时出现月亮入新宫、月合木、月拱海等修复链，反抽概率上升。";
const dedupMerged = mergeNodeContent(duplicatedOld, `${oldBoundary} | ${newBoundary}`);
ok("orthogonality merge removes duplicated fragments", dedupMerged.split(oldBoundary).length - 1 === 1, dedupMerged);
ok("orthogonality merge preserves new reverse boundary", dedupMerged.includes("修复链"), dedupMerged);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "textron-content-limit-"));
const nodePath = path.join(dir, "node_0.html");
const oversized = "因果机制验证边界".repeat(160);
writeNodeHtml(nodePath, 0, "node_0", oversized, []);
const stored = readNodeContent(nodePath);
ok("storage hard cap is exactly 1000 chars", stored.length === NODE_CONTENT_MAX_CHARS, `length=${stored.length}`);
ok("storage preserves content prefix", oversized.startsWith(stored));
fs.rmSync(dir, { recursive: true, force: true });

console.log(`\npassed=${passed} failed=${failed}`);
if (failed > 0) process.exit(1);
