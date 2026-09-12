/**
 * test_monitor_edges.js — Live Monitor 图「连线可读性」可执行验收
 * 运行: node test_monitor_edges.js [http://localhost:8766]
 *
 * 做法: 把 monitor.html 的页面脚本原样跑在 Node（最小 DOM/Canvas 桩）+ 真实 /api/state，
 * 捕获 renderStatic 实际发出的绘制调用再断言。断言的是“能不能看清连线”的可执行代理指标：
 *   ① 一条边 = 一次 stroke（发丝化扇形=看不清的病根，strokes/curves 必须 1:1）
 *   ② 同层 lateral 边必须真被画出来且用虚线与跨层主边区分（不画=数据丢可视化）
 *   ③ 线/标签坐标必须有限（NaN 会让路径静默消失：画了却看不见）
 *   ④ 线宽/alpha 不得低于可读底线（黑底 <0.6px 或 alpha<0.10 等于没画）
 *   ⑤ 权重标签确有绘制
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const http = require("http");

const BASE = process.argv[2] || "http://localhost:8766";
const HTML = fs.readFileSync(process.env.MONITOR_HTML || path.join(__dirname, "src/monitor.html"), "utf-8");
const CANVASES = [];                       // 记录页面创建过的所有 canvas

function fetchJson(p) {
  return new Promise((res, rej) => {
    http.get(BASE + p, (r) => { let b = ""; r.on("data", (c) => (b += c)); r.on("end", () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } }); }).on("error", rej);
  });
}

function parseAlpha(style) {
  const m = /rgba?\([^,]+,[^,]+,[^,]+,\s*([\d.]+)\s*\)/.exec(String(style));
  return m ? parseFloat(m[1]) : null;
}

function newRec() {
  const rec = {
    strokes: 0, curves: 0, texts: 0, dashBatches: 0, dashedStrokes: 0,
    minAlpha: 9, minLineWidth: 9, maxLineWidth: 0, badCoords: 0, _dashOn: false,
    beginPath() { this._pending = null; }, closePath() {}, save() {}, restore() {}, translate() {}, scale() {},
    rotate() {}, setTransform() {}, clearRect() {}, drawImage() {}, fillRect() {}, strokeRect() {},
    clip() {}, rect() {}, arc() {}, moveTo(...a) { if (a.some((x) => !Number.isFinite(x))) this.badCoords++; this._p0 = [a[0], a[1]]; },
    lineTo(...a) { if (a.some((x) => !Number.isFinite(x))) this.badCoords++; },
    quadraticCurveTo(...a) {
      if (a.some((x) => !Number.isFinite(x))) this.badCoords++;
      this.curves++;
      // “同一条边的多根发丝”特征: 两端点落在同一 16px 网格。用端点粗网格做 chord key,
      // 单线渲染时 strokes/chord = 1, 发丝扇形时 = 2..6 —— 这就是“看不清连线”的量化形。
      const q = (v) => Math.round(v / 16);
      const p0 = this._p0 || [NaN, NaN];
      this._chord = q(p0[0]) + "," + q(p0[1]) + "," + q(a[2]) + "," + q(a[3]);
      this._chords = this._chords || {};
      this._chords[this._chord] = (this._chords[this._chord] || 0) + 1;
    },
    bezierCurveTo(...a) { if (a.some((x) => !Number.isFinite(x))) this.badCoords++; this.curves++; },
    stroke() {
      this.strokes++;
      if (this._dashOn) this.dashedStrokes++;
      const al = parseAlpha(this.strokeStyle);
      if (al != null) this.minAlpha = Math.min(this.minAlpha, al);
      if (Number.isFinite(this.lineWidth)) {
        this.minLineWidth = Math.min(this.minLineWidth, this.lineWidth);
        this.maxLineWidth = Math.max(this.maxLineWidth, this.lineWidth);
      }
    },
    fill() {},
    fillText(...a) { if (a.slice(1).some((x) => !Number.isFinite(x))) this.badCoords++; this.texts++; },
    setLineDash(a) { this.dashBatches++; this._dashOn = Array.isArray(a) && a.length > 0; },
  };
  return rec;
}

function makeCtx(rec) {
  const noop = () => {};
  return new Proxy(rec, {
    get(t, k) {
      if (k in t) return t[k];
      if (k === "measureText") return (s) => ({ width: String(s).length * 6 });
      if (k === "createRadialGradient" || k === "createLinearGradient" || k === "createPattern") return () => ({ addColorStop: noop });
      return noop;
    },
    set(t, k, v) { t[k] = v; return true; },
  });
}

function makeEl(tag) {
  const el = {
    tagName: String(tag || "div").toUpperCase(), children: [], style: {}, dataset: {},
    className: "", innerHTML: "", textContent: "", value: "", scrollTop: 0, scrollLeft: 0,
    hidden: false, open: false, id: "", width: 0, height: 0, _rec: null,
    appendChild(c) { this.children.push(c); return c; },
    removeChild() {}, setAttribute() {}, getAttribute() { return null; }, addEventListener() {},
    querySelector(sel) { return makeEl(sel.replace(/[^a-z]/gi, "") || "div"); },
    querySelectorAll() { return []; },
    getBoundingClientRect() { return { left: 0, top: 0, right: 1200, bottom: 800, width: 1200, height: 800 }; },
    classList: { add() {}, remove() {}, contains() { return false; }, toggle() {} },
    scrollIntoView() {}, focus() {},
    getContext(kind) { return String(kind) === "2d" ? makeCtx(newRec()) : null; },  // 非 canvas 元素也要能应答（webgl 查询返回 null → 走 2D 兜底）
  };
  if (el.tagName === "CANVAS") {
    el.getContext = (kind) => {
      if (String(kind) !== "2d") return null;               // webgl → 走 2D 兜底
      if (!el._rec) el._rec = newRec();
      return (el._ctxProxy = el._ctxProxy || makeCtx(el._rec));
    };
    CANVASES.push(el);
  }
  return el;
}

const byId = {};
const doc = {
  hidden: false, documentElement: makeEl("html"), body: makeEl("body"),
  getElementById(id) { return (byId[id] = byId[id] || makeEl("div")); },
  createElement: (t) => makeEl(t),
  querySelector() { return makeEl("div"); },
  querySelectorAll() { return []; },
  addEventListener() {},
};

const sandbox = {
  document: doc, console, Math, JSON, Date, Number, String, Array, Object, RegExp, Error,
  isNaN, parseFloat, parseInt, Uint8ClampedArray, Promise, Set, Map,
  performance: { now: () => Date.now() },
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms || 0, 5)), clearTimeout,
  setInterval: () => 0, clearInterval() {}, requestAnimationFrame: () => 0,
  EventSource: function () { return { addEventListener() {}, close() {} }; },
  fetch: () => Promise.resolve({ ok: true, text: () => Promise.resolve(""), json: () => Promise.resolve(STATE) }),
};
sandbox.window = sandbox;
sandbox.self = sandbox;
sandbox.globalThis = sandbox;
sandbox.devicePixelRatio = 1;
let STATE = null;

const script = /<script>([\s\S]*?)<\/script>\s*<\/body>/.exec(HTML);
if (!script) { console.error("❌ 找不到页面内联 <script>"); process.exit(1); }

fetchJson("/api/state").then((s) => {
  STATE = s;
  vm.createContext(sandbox);
  vm.runInContext(script[1], sandbox, { filename: "monitor-inline.js" });
  return new Promise((r) => setTimeout(r, 30));             // 等 poll() 的 async 渲染完成
}).then(() => {
  const nets = (STATE && STATE.networks) || {};
  const name = Object.keys(nets)[0];
  const net = nets[name] || {};
  const w = net.weights || {};
  const latSections = Object.keys(w).filter((k) => /^(\d+)_to_\1$/.test(k));
  const latCount = latSections.reduce((a, k) => a + (w[k] || []).length, 0);
  const crossCount = Object.keys(w).filter((k) => !/^(\d+)_to_\1$/.test(k)).reduce((a, k) => a + (w[k] || []).length, 0);

  const recs = CANVASES.map((c) => c._rec).filter(Boolean);
  if (!recs.length) { console.error("❌ 未捕获任何 canvas 绘制（渲染路径没跑到）"); process.exit(1); }
  // 静态底图 = 画边的层：取“曲线最多”的那个 rec
  const rec = recs.reduce((a, b) => (b.curves > a.curves ? b : a), recs[0]);

  let pass = 0, fail = 0;
  const check = (label, ok, detail) => { ok ? pass++ : fail++; console.log(`  ${ok ? "✅" : "❌"} ${label}${detail ? " :: " + detail : ""}`); };
  console.log(`网络=${name} · 数据侧 跨层边=${crossCount} 同层lateral=${latCount} · 画布侧 曲线=${rec.curves} stroke=${rec.strokes} 虚线stroke=${rec.dashedStrokes} 标签=${rec.texts}`);
  console.log(`  alpha下限=${rec.minAlpha === 9 ? "n/a" : rec.minAlpha.toFixed(3)} 线宽=[${rec.minLineWidth.toFixed(2)}..${rec.maxLineWidth.toFixed(2)}] 非有限坐标=${rec.badCoords} canvas数=${recs.length}`);
  check("① 一条边一次 stroke（无发丝化扇形）", rec.curves > 0 && rec.strokes === rec.curves, `strokes/curves=${(rec.strokes / Math.max(1, rec.curves)).toFixed(2)}`);
  check("② 同层 lateral 边真被画出且为虚线", latCount === 0 || rec.dashedStrokes > 0, `dashedStrokes=${rec.dashedStrokes} latCount=${latCount}`);
  check("③ 线/标签坐标全部有限", rec.badCoords === 0, `bad=${rec.badCoords}`);
  check("④ 最细线宽 ≥0.6px", rec.minLineWidth >= 0.6, `min=${rec.minLineWidth.toFixed(2)}`);
  check("⑤ 最低 alpha ≥0.10", rec.minAlpha >= 0.10, `min=${rec.minAlpha === 9 ? "n/a" : rec.minAlpha.toFixed(3)}`);
  check("⑥ 权重标签确有绘制", rec.texts > 0, `texts=${rec.texts}`);
  check("⑦ 画布边数与数据同阶（未静默丢边）", rec.curves >= Math.min(crossCount + latCount, 50), `curves=${rec.curves}`);
  const chords = Object.keys(rec._chords || {}).length || 1;
  const fan = rec.curves / chords;                                   // 每条边的线数: 1=单线, >1=发丝扇形
  const fanMax = Math.max.apply(null, Object.values(rec._chords || { x: 1 }));
  check("⑧ 无发丝化扇形（同一弦最多 2 根线）", fanMax <= 2, `fan=${fan.toFixed(2)} 最大=${fanMax}`);
  // ⑨ 最直接的扇形探针: 实绘曲线数 / 数据侧应画边数 ≈ 1。
  // silk 版实测 3136/822≈3.8（一条边拆成 1..6 根头发丝→看不清）；单线版≈0.95。
  let expect = 0;
  for (const k of Object.keys(w)) for (const e2 of w[k] || []) {
    if (e2.from === e2.to) continue;
    if (Math.abs(e2.weight) >= 0.02) expect++;
  }
  const perEdge = expect ? rec.curves / expect : 0;
  check("⑨ 每条数据边≈一条实绘线（0.8≤r≤1.25）", perEdge >= 0.8 && perEdge <= 1.25, `curves=${rec.curves}/期望=${expect} r=${perEdge.toFixed(2)}`);
  console.log(`\n[monitor 连线可读性] PASS=${pass} FAIL=${fail}`);
  process.exit(fail ? 1 : 0);
}).catch((e) => { console.error("💥", e && (e.stack || e.message)); process.exit(1); });
