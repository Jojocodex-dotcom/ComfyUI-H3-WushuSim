/* ============================================================================
 * sim3d/cli.js — 内核 JSON 入口（供 ComfyUI 插件/Python 调用）
 * ----------------------------------------------------------------------------
 * 用法：
 *   node sim3d/cli.js '{"op":"simulate","seed":7,...}'      # 直接传 JSON
 *   node sim3d/cli.js --file cfg.json                       # 从文件读
 *   echo '{...}' | node sim3d/cli.js                        # 从 stdin 读
 * 输出：一行 JSON（stdout），错误写 stderr 并以非 0 退出。
 *
 * 支持的操作 op：
 *   simulate  编译 + 运行内核 → 返回 {promptZh, promptEn, evidence, timeline, timing, audit, shots, config}
 *   compile   只编译配置（不跑）→ 返回编译后的内核配置
 *   lint      对给定 text 做提示词体检（H3LINT + 打斗逻辑）
 *   ltx25     把证据整理成 LTX 2.5 单段散文提示词（六要素/切点四件事/声音在段内）
 *   templates 列出/取用模板（打斗 208 / 文戏 154）
 *   moves     招式库：list/get/add/stats（名称／准备／出招／华丽效果／时间范围／距离／扇角）
 *   selftest  自检：内核、体检、LTX、模板是否都在
 * ========================================================================== */
"use strict";
const fs = require("fs");
const path = require("path");
const E = require("./engine.js");
const P = require("./pipeline.js");
const F = require("./combat-logic.js");
let MOVES = null; try { MOVES = require("./moves.js"); } catch (e) { MOVES = null; }
let RIG = null; try { RIG = require("./rig.js"); } catch (e) { RIG = null; }
let LINT = null; try { LINT = require(path.join(__dirname, "..", "h3lint.js")); } catch (e) { LINT = null; }
let X25 = null; try { X25 = require(path.join(__dirname, "..", "ltx2", "step2.js")); } catch (e) { X25 = null; }
let TPL = null; try { TPL = require(path.join(__dirname, "..", "templates", "library.js")); } catch (e) { TPL = null; }
let DTPL = null; try { DTPL = require(path.join(__dirname, "..", "drama", "templates", "library.js")); } catch (e) { DTPL = null; }

// ── 输入解析 ────────────────────────────────────────────────────────────────
const stripBOM = (s) => String(s || "").replace(/^\uFEFF/, "");
function readInput(argv) {
  const args = argv.slice(2);
  const fileIdx = args.indexOf("--file");
  if (fileIdx >= 0 && args[fileIdx + 1]) return stripBOM(fs.readFileSync(args[fileIdx + 1], "utf8"));
  const inline = args.find(a => a.trim().startsWith("{"));
  if (inline) return stripBOM(inline);
  try { return stripBOM(fs.readFileSync(0, "utf8")); } catch (e) { return ""; }
}
function outPath(argv) {
  const args = argv.slice(2);
  const i = args.indexOf("--out");
  return (i >= 0 && args[i + 1]) ? args[i + 1] : null;
}

// ── 默认配置（与界面里的默认值一致）────────────────────────────────────────
function defaultSpec() {
  return {
    op: "simulate",
    seed: 20260921,
    duration: 15,
    nameA: "甲", nameB: "乙",
    descA: "男性，花甲年纪，短须乱发，粗布短打", descB: "男性，青年，黑衣披发",
    // 角色卡：武器|等级|风格|外貌|招式（招式可空）
    kitA: { tier: 6, style: "power", weapon: "bang" },
    kitB: { tier: 6, style: "guardian", weapon: "jian" },
    scenario: "field",
    scene: "雨夜长街，灯笼暖光，湿石板反光",
    startDist: 2, duelW: 10, duelH: 8, duelZ: 0,
    rules: [], speed: "norm", lens: "", shotPlan: "auto",
    targetEn: false, refMode: false, injectLogic: true
  };
}

/** 角色卡串（与 ComfyUI 插件同款）：`武器|等级|外貌|招式1,招式2` */
function parseFighterSpec(spec, side) {
  const parts = String(spec || "").split("|").map(x => x.trim());
  const WPN_ZH = { 太刀: "nodachi", 刀: "dao", 剑: "jian", 枪: "qiang", 棍: "duangun", 棒: "bang", 朴刀: "pu", 短刃: "duanren", 空手: "none" };
  let weapon = (parts[0] || "dao").toLowerCase();
  if (!E.WEAPONS[weapon]) weapon = WPN_ZH[parts[0]] || "dao";
  const tier = /^\d+$/.test(parts[1] || "") ? Math.max(1, Math.min(9, +parts[1])) : 3;
  const look = parts[2] || "";
  const techs = (parts[3] || "").replace(/，/g, ",").split(",").map(x => x.trim()).filter(Boolean);
  const basic = { name: techs[0] || "试招", dmg: 2, range: 2, cd: 0.8 };
  const attack = techs.slice(0, 4).map((n, i) => ({ name: n, dmg: 3, range: 3, cd: 2 + i * 0.2 }));
  return { tier, style: side === "A" ? "power" : "guardian", weapon, look, basic, attack: attack.length ? attack : undefined };
}

// ── 操作实现 ────────────────────────────────────────────────────────────────
function opCompile(spec) {
  const cfg = Object.assign(defaultSpec(), spec);
  const merged = {
    duration: cfg.duration, hpA: cfg.hpA || 8, hpB: cfg.hpB || 8,
    nameA: cfg.nameA, nameB: cfg.nameB, descA: cfg.descA, descB: cfg.descB,
    kitA: cfg.kitA, kitB: cfg.kitB,
    duelW: cfg.duelW, duelH: cfg.duelH, duelZ: cfg.duelZ, startDist: cfg.startDist,
    rules: cfg.rules || [], speed: cfg.speed || "norm", scenario: cfg.scenario || "field",
    lens: cfg.lens || "", shotPlan: cfg.shotPlan || "auto"
  };
  return P.compile(merged, cfg.seed);
}

function opSimulate(spec) {
  const cfg = Object.assign(defaultSpec(), spec);
  // 支持角色卡串（武器|等级|外貌|招式）
  if (spec.fighterA) { cfg.kitA = parseFighterSpec(spec.fighterA, "A"); if (cfg.kitA.look) cfg.descA = cfg.kitA.look; }
  if (spec.fighterB) { cfg.kitB = parseFighterSpec(spec.fighterB, "B"); if (cfg.kitB.look) cfg.descB = cfg.kitB.look; }
  const kcfg = opCompile(cfg);
  const r = E.simulate(Object.assign({ record: true }, kcfg));
  const ref = !!cfg.refMode;
  // 提示词（P.shots 是分镜文本；这里给出可直接喂给模型的整段）
  const shotText = P.shots(r, Object.assign({}, cfg, kcfg), !!cfg.targetEn);
  const evidence = P.evidenceText(r, kcfg);
  const promptZh = shotText;
  const audit = { purposes: F.auditPurposes ? F.auditPurposes(r.A, r.events) : null, timing: F.timelineAudit ? F.timelineAudit(r) : null };
  const lint = LINT && LINT.check ? LINT.check(promptZh, { mode: "final", duration: cfg.duration, names: [cfg.nameA, cfg.nameB] }) : null;
  return {
    ok: true, op: "simulate", seed: cfg.seed,
    duration: r.duration, winner: r.winner,
    prompt: promptZh,
    evidence,
    shots: shotText,
    timeline: (r.timeline || []).slice(0, 400),
    timing: r.timing || null,
    actionAudit: audit.timing,
    purposeAudit: audit.purposes,
    lint: lint ? { score: lint.stats && lint.stats.score, errors: lint.stats ? lint.stats.errors : null, grade: lint.grade, items: (lint.items || []).slice(0, 40) } : null,
    moveLib: r.moveLib || null,
    // 招式库/打斗密度用：出招数（事件都在 R.events 里，但 CLI 不整包回传，这里给计数）
    attacks: (r.summary && r.summary.attacks != null) ? r.summary.attacks
             : (r.events || []).filter(function (e) { return e.type === 'attack'; }).length,
    counts: r.summary ? {
      hits: r.summary.hits, blocks: r.summary.blocks, dodges: r.summary.dodges,
      spellCasts: r.summary.spellCasts, qiBursts: r.summary.qiBursts, takeoffs: r.summary.takeoffs
    } : null,
    config: { scenario: cfg.scenario, scene: cfg.scene, nameA: cfg.nameA, nameB: cfg.nameB, duration: cfg.duration, seed: cfg.seed }
  };
}

function opLint(spec) {
  if (!LINT || !LINT.check) return { ok: false, error: "h3lint.js 缺失" };
  const r = LINT.check(String(spec.text || ""), { mode: spec.mode || "final", duration: spec.duration || 15, names: spec.names || [] });
  const logic = F.checkPrompt ? F.checkPrompt(String(spec.text || ""), { mode: spec.mode === "design" ? "design" : "final" }) : null;
  return { ok: true, op: "lint", score: r.stats && r.stats.score, grade: r.grade, errors: r.stats ? r.stats.errors : null, items: (r.items || []).slice(0, 60), logic };
}

function opLtx25(spec) {
  if (!X25) return { ok: false, error: "ltx2/step2.js 缺失" };
  // 从模拟结果或直接给的 shots 构造
  let shots = spec.shots;
  if (!shots && spec.seed != null) {
    const r = opSimulate(Object.assign({}, spec, { refMode: !!spec.refMode }));
    shots = r.shots;
  }
  const data = {
    shots: (spec.shotList || []).length ? spec.shotList : [{ camera: spec.camera || "胸口高度手持跟拍中景镜头", action: String(shots || "").slice(0, 400) }],
    cast: spec.cast || (spec.nameA && spec.nameB ? (spec.descA || "") + "；" + (spec.descB || "") : ""),
    scene: spec.scene || "", sound: spec.sound || "", dialogue: spec.dialogue || "", duration: spec.duration || 8
  };
  const paradigm = spec.paradigm || (data.shots.length >= 2 ? "multi" : "single");
  const built = X25.buildParagraph(data, { paradigm });
  const v = X25.validate(built.text, { mode: built.paradigm });
  return { ok: true, op: "ltx25", paradigm: built.paradigm, cuts: built.cuts, prompt: built.text, request: X25.requestHead({ seconds: data.duration }), verdict: { ok: v.ok, issues: v.issues, stats: v.stats } };
}

// ── 招式库：列出/查询/新增/统计（供 ComfyUI 节点与界面调用）───────────────
function opMoves(spec) {
  if (!MOVES) return { ok: false, error: "sim3d/moves.js 缺失" };
  const act = spec.moveOp || spec.act || "list";
  if (act === "get") {
    const m = MOVES.get(spec.id || spec.name);
    return m ? { ok: true, op: "moves", move: m, params: MOVES.paramsOf(m.zh || m.key) }
             : { ok: false, op: "moves", error: "库里没有这个招式：" + (spec.id || spec.name) };
  }
  if (act === "add") {
    if (!spec.name && !spec.id) return { ok: false, error: "新增招式需要 name" };
    const m = MOVES.register({
      zh: spec.name || spec.id, key: spec.key, category: spec.category, weapons: spec.weapons,
      tiers: spec.tiers, prep: spec.prep, act: spec.act, effect: spec.effect, follow: spec.follow,
      timing: spec.timing, range: spec.range, arc: spec.arc, band: spec.band, tags: spec.tags,
      source: spec.source || "user"
    });
    const saved = MOVES.saveUser();
    return { ok: !!m, op: "moves", added: m ? 1 : 0, move: m, saved: saved, total: MOVES.count() };
  }
  if (act === "stats") return { ok: true, op: "moves", stats: MOVES.stats(), version: MOVES.VERSION };
  // list（默认）：可按兵器/等级/分类/高度带筛
  const list = MOVES.query({ weapon: spec.weapon, tier: spec.tier, category: spec.category, band: spec.band });
  const brief = (spec.brief === false) ? null : (m) => ({
    key: m.key, zh: m.zh, category: m.category, weapons: m.weapons, band: m.band, arc: m.arc,
    timing: m.timing, range: m.range, source: m.source,
    prep: spec.withText ? m.prep : undefined, act: spec.withText ? m.act : undefined,
    effect: spec.withText ? m.effect : undefined, follow: spec.withText ? m.follow : undefined
  });
  return { ok: true, op: "moves", stats: MOVES.stats(),
           moves: list.map(m => (brief ? brief(m) : m)) };
}

function opTemplates(spec) {
  const out = {};
  if (TPL) {
    const list = TPL.TEMPLATES || TPL.DERIVED || [];
    out.fight = { count: list.length, ids: list.slice(0, 400).map(t => t.id) };
    if (spec.id) { const t = (TPL.TEMPLATES_BY_ID || {})[spec.id]; if (t) out.template = { id: t.id, name: t.nameZh, skeleton: t.skeletonZh }; }
  }
  if (DTPL) {
    const list = DTPL.TEMPLATES || [];
    out.drama = { count: list.length, ids: list.slice(0, 400).map(t => t.id) };
    if (spec.id && DTPL.TEMPLATES_BY_ID && DTPL.TEMPLATES_BY_ID[spec.id]) {
      const t = DTPL.TEMPLATES_BY_ID[spec.id];
      out.template = { id: t.id, name: t.nameZh, skeleton: t.skeletonZh };
    }
  }
  return Object.assign({ ok: true, op: "templates" }, out);
}

function opSelftest() {
  const checks = {};
  checks.engine = E.VERSION;
  checks.pipeline = typeof P.evidenceText === "function";
  checks.combatLogic = F.VERSION + "/" + F.CORE_RULES.length + "条规则";
  checks.rig = RIG ? RIG.VERSION : "缺失";
  checks.lint = LINT ? "ok" : "缺失";
  checks.ltx25 = X25 ? X25.VERSION : "缺失";
  checks.templates = TPL ? (TPL.TEMPLATES || TPL.DERIVED || []).length : "缺失";
  checks.dramaLibrary = DTPL ? (DTPL.TEMPLATES || []).length : "缺失";
  // 跑一场最小对打
  let ok = false, note = "";
  try {
    const r = opSimulate({ seed: 1, duration: 5 });
    ok = !!r.prompt && r.duration > 0;
    note = "时长 " + r.duration + "s｜提示词 " + r.prompt.length + " 字符｜时间轴 " + (r.timeline || []).length + " 段";
  } catch (e) { note = "模拟失败：" + e.message; }
  return { ok, op: "selftest", checks, note };
}

// ── 主入口 ──────────────────────────────────────────────────────────────────
function main() {
  const raw = readInput(process.argv);
  let spec;
  try { spec = raw.trim() ? JSON.parse(raw) : defaultSpec(); }
  catch (e) { process.stderr.write("配置 JSON 解析失败：" + e.message + "\n"); process.exit(2); }
  spec = Object.assign(defaultSpec(), spec);
  let out;
  try {
    switch (spec.op) {
      case "compile": out = { ok: true, op: "compile", config: opCompile(spec) }; break;
      case "lint": out = opLint(spec); break;
      case "ltx25": out = opLtx25(spec); break;
      case "templates": out = opTemplates(spec); break;
      case "moves": out = opMoves(spec); break;
      case "selftest": out = opSelftest(); break;
      case "simulate":
      default: out = opSimulate(spec); break;
    }
  } catch (e) {
    process.stderr.write("执行失败：" + (e && e.stack || e) + "\n");
    process.exit(3);
  }
  const json = JSON.stringify(out);
  const op = outPath(process.argv);
  if (op) { fs.writeFileSync(op, json, "utf8"); process.stdout.write("已写入 " + op + "（" + json.length + " 字符）\n"); }
  else process.stdout.write(json);
}
if (require.main === module) main();
module.exports = { opSimulate, opCompile, opLint, opLtx25, opTemplates, opMoves, opSelftest, parseFighterSpec };
