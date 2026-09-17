/**
 * test_monitor_hooks.ts —— /reload 场景的监听器泄漏 + 端口漂移防护（第二十轮 default 侧）
 *
 * 背景：
 *  · /reload 在**同一进程内**重载扩展。若扩展加载时每次 `process.on(...)`，监听器会累积
 *    （Node 超 11 个即 MaxListenersExceededWarning），且旧实例闭包长期持有 MONITOR_PID 状态。
 *  · `server.close()` 会等现有连接结束；若 SSE 长连接不断开，端口不释放 ⇒ 重载后同端口
 *    listen 失败 ⇒ EADDRINUSE 静默 +1 ⇒ **reload 场景的端口漂移源**。
 *
 * 运行： node <转译产物>   （见文件末 main）
 */

import * as fs from "node:fs";
import * as path from "node:path";

let pass = 0;
let fail = 0;
function check(cond: boolean, label: string) {
  if (cond) { pass++; console.log(`[OK]   ${label}`); }
  else { fail++; console.log(`[FAIL] ${label}`); }
}

// ── T1/T2：复刻 globalThis 槽位模式，验证「多次加载只挂一组监听器 + 新实例接管」 ──
const KEY = "__textronMonitorHooksTest";

function installHookLike(unregister: () => void) {
  const g = globalThis as any;
  if (g[KEY]) { g[KEY].unregister = unregister; return; }
  const box = { unregister };
  g[KEY] = box;
  const run = () => { try { box.unregister(); } catch {} };
  process.on("exit", run);
  for (const sig of ["SIGTERM", "SIGHUP", "SIGINT"] as const) {
    try { process.on(sig, run); } catch {}
  }
}

function testHooks() {
  const before = {
    exit: process.listenerCount("exit"),
    term: process.listenerCount("SIGTERM"),
    hup: process.listenerCount("SIGHUP"),
  };

  const calls: string[] = [];
  installHookLike(() => { calls.push("v1"); });
  installHookLike(() => { calls.push("v2"); });
  installHookLike(() => { calls.push("v3"); });

  const after = {
    exit: process.listenerCount("exit"),
    term: process.listenerCount("SIGTERM"),
    hup: process.listenerCount("SIGHUP"),
  };

  check(after.exit - before.exit === 1, `T1a exit 监听器只增 1（实际 +${after.exit - before.exit}）`);
  check(after.term - before.term === 1, `T1b SIGTERM 监听器只增 1（实际 +${after.term - before.term}）`);
  check(after.hup - before.hup === 1, `T1c SIGHUP 监听器只增 1（实际 +${after.hup - before.hup}）`);

  // 触发一次 handler：应只调用「最新实例」的 unregister（v3），不得调用 v1/v2
  const handlers = process.listeners("SIGTERM") as Array<() => void>;
  handlers[handlers.length - 1]();
  check(calls.length === 1 && calls[0] === "v3",
        `T2 新实例接管：handler 只调用最新 unregister（calls=${JSON.stringify(calls)}）`);

  // 清理测试用监听器，避免污染后续断言
  const g = globalThis as any;
  delete g[KEY];
}

// ── T3/T4：源码守卫（防止实现回退到「每次加载都 process.on」与「先 close 后断 SSE」） ──
function srcGuard() {
  // 转译产物可能落在仓库根（_test_hooks.mjs）或 src/ 内，两处都探测
  const here = path.dirname(new URL(import.meta.url).pathname);
  const candidates = [path.join(here, "index.ts"), path.join(here, "src", "index.ts")];
  const srcPath = candidates.find((p) => fs.existsSync(p));
  check(!!srcPath, `T0 找到源码 index.ts（${srcPath || candidates.join(" | ")}）`);
  if (!srcPath) return;
  const raw = fs.readFileSync(srcPath, "utf-8");
  // 【必需】去注释后再断言：注释里也会出现 `process.on("exit")`、`server.close()` 等字样，
  // 直接 indexOf 会被注释干扰（首版实测：T3c 误报 2 次、T4a 把注释里的 close 当作真调用）。
  const src = raw
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !/^\s*\/\//.test(l))
    .join("\n");

  check(src.includes("installMonitorHooks"),
        "T3a 存在 installMonitorHooks（globalThis 槽位防泄漏）");
  check(src.includes("__textronMonitorHooks"),
        "T3b 槽位键 __textronMonitorHooks 存在");
  const exitRegs = (src.match(/process\.on\(\s*"exit"/g) || []).length;
  check(exitRegs === 1,
        `T3c process.on("exit") 只出现 1 次（实际 ${exitRegs}）—— 不得散落在加载路径上`);

  // session_shutdown 内顺序：SSE res.end() 必须早于 server.close()，且含 closeAllConnections
  const i = src.indexOf('pi.on("session_shutdown"');
  const blk = i >= 0 ? src.slice(i, i + 900) : "";
  const pEnd = blk.indexOf("res.end()");
  const pClose = blk.indexOf("server.close()");
  check(i >= 0 && pEnd >= 0 && pClose >= 0 && pEnd < pClose,
        "T4a session_shutdown 中 SSE res.end() 先于 server.close()（否则端口不释放）");
  check(blk.includes("closeAllConnections"),
        "T4b 含 closeAllConnections 强兜底");
  check(src.includes("monitorCname") && src.includes("--cname"),
        "T4c cname 从 argv 解析（不依赖扩展加载顺序）");
}

testHooks();
srcGuard();
console.log(`\nmonitor hooks / 端口漂移防护：${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
