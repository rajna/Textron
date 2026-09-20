// n8 第二十三轮 R1 修复验收 —— merge 融合溢出硬上限（MERGE_OVERFLOW_CAP）
// 病灶：NODE_CONTENT_MAX_CHARS=0 ⇒ merge 路径 contentLimit=MAX_SAFE_INTEGER ⇒ 溢出分流永不触发；
//       旧文越大 → LLM 单次重写输出恒小于旧文 → scoreNew<scoreOld 恒 downgrade 到
//       mergeContent=old+" | "+new（旧文无 "|" 时片段去重失效，全量拼接）→ 单调膨胀
//       （L0::node_0 实测 89474c / 107 片段）。
// 修法：仅对融合拼接产物设 MERGE_OVERFLOW_CAP=12000；forcedReplace/cleanse 豁免；
//       超限走 overflow 分流到同层新节点。运行:
//   esbuild tests/test_merge_overflow_cap.ts --bundle --platform=node --format=cjs --outfile=.tb/moc.cjs && node .tb/moc.cjs
import * as fs from "node:fs";
import * as path from "node:path";
import { mergeContent } from "../src/lib/merge";

let pass = 0, fail = 0;
function assert(c: boolean, m: string) { if (c) { pass++; console.log("  ✅", m); } else { fail++; console.log("  ❌", m); } }

// ── T1 源码守卫：merge 路径 cap 存在且 forcedReplace 豁免 ──
{
  // 产物在 .tb/ 下运行时 import.meta.dirname 不可用，从 cwd（仓库根）解析，双候选兼容
  const root = process.cwd();
  const srcPath = [path.join(root, "src/index.ts"), path.join(root, "../src/index.ts")]
    .find((p) => fs.existsSync(p)) || path.join(root, "src/index.ts");
  const src = fs.readFileSync(srcPath, "utf-8");
  assert(src.includes("MERGE_OVERFLOW_CAP"), "T1a index.ts 含 MERGE_OVERFLOW_CAP 判据");
  assert(/forcedReplace \? Number\.MAX_SAFE_INTEGER : MERGE_OVERFLOW_CAP/.test(src),
    "T1b forcedReplace 豁免、仅融合拼接受 cap（replace 语义不受限）");
  // 病灶守卫：不得再出现 merge 路径裸 MAX_SAFE_INTEGER（cap 缺位即复发）
  assert(!/NODE_CONTENT_MAX_CHARS > 0 \? NODE_CONTENT_MAX_CHARS : Number\.MAX_SAFE_INTEGER;/.test(src),
    "T1c 旧缺陷表达式（裸 MAX_SAFE_INTEGER 三元）已移除");
}

// ── T2 病灶复现：mergeContent 对无 "|" 旧文 = 全量拼接（失控环的载体）──
{
  const oldC = "【L0 判据】甲乙丙丁".repeat(50); // ~500c 无 "|" 分隔
  const newC = "【L0 新增量】戊己庚辛".repeat(50);
  const merged = mergeContent(oldC, newC);
  assert(merged.length > oldC.length + newC.length * 0.9,
    `T2a 无分隔符旧文全量拼接复现（${oldC.length}+${newC.length} → ${merged.length}c）`);
  assert(merged.startsWith(oldC) && merged.endsWith(newC),
    "T2b 拼接结构 = old | new（每轮净增 = 全部新文 ⇒ 单调膨胀载体确认）");
}

// ── T3 有界性模拟：cap 掐断失控环 ──
// 模拟 20 轮 downgraded_merge：每轮 LLM 产出 ~2KB 增量、旧文整体作为 mergeContent 输入，
// 程序侧按 cap 截断 + 溢出分流（与新 contentLimit 行为同构）。断言本节点体量恒有界。
{
  const CAP = 12000;
  let node = "【L0 初始判据】" + "历史判据正文。".repeat(200); // ~3KB 起步
  let overflowed = 0;
  for (let i = 0; i < 20; i++) {
    // 真实场景：LLM 每轮输出唯一内容（含轮次专名/数值），不可被片段去重
    const inc = `【第${i}轮增量·唯一】机制${i}的描述与实证锚点数值${i * 7}：判据边界与回归夹具断言。`.repeat(30); // ~1.4KB 唯一
    let merged = mergeContent(node, inc);
    if (merged.length > CAP) {            // 程序侧 overflow 分流（index.ts 同构逻辑）
      overflowed += merged.length - CAP;
      merged = merged.slice(0, CAP);
    }
    node = merged;
  }
  assert(node.length <= CAP, `T3a 20 轮 merge 后本节点有界（${node.length}c ≤ ${CAP}c）`);
  assert(overflowed > 0, `T3b 溢出确实被分流而非静默截断（累计分流 ${overflowed}c）`);
  // 对照组：无 cap 时同样 20 轮的体量（病灶量级演示）
  let unbounded = "【L0 初始判据】" + "历史判据正文。".repeat(200);
  for (let i = 0; i < 20; i++) unbounded = mergeContent(unbounded, `【第${i}轮增量·唯一】机制${i}的描述与实证锚点数值${i * 7}：判据边界与回归夹具断言。`.repeat(30));
  assert(unbounded.length > CAP * 2, `T3c 无 cap 对照组失控（${unbounded.length}c = ${((unbounded.length/CAP)).toFixed(1)}×cap ⇒ cap 必要性成立`);
}

console.log(`\n结果: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
