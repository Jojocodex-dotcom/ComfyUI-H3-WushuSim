/* ============================================================================
 * sim3d/engine.js — H3 武斗模拟器 · 实时 3D 战斗内核（Stage A · v0.6：垂直轴/情景/法术）
 * ----------------------------------------------------------------------------
 * 与旧版（回合制网格 + 掷骰）的根本区别：
 *   1. 连续时空：米制坐标 + 固定步长 60Hz，不是"格子 + 回合"。
 *   2. 帧数据化招式：起手(windup) / 判定(active) / 收招(recovery) 三段，
 *      命中不是掷骰，而是"兵器扫过的扇形与对方胶囊体真的相交"。
 *   3. 攻防是几何 + 时机：格挡要朝向对、闪避要真的离开刃线、
 *      对拼是两把兵器在同一帧相交、崩防是格挡值被打空。
 *   4. 确定性：所有随机走种子 PRNG，同一 seed 逐帧完全可复现
 *      （这是后面做 3D 回放 / 出片参考的前提）。
 *   5. AI：效用决策（约 12Hz）+ 逐帧转向，带"反应延迟"——
 *      等级越高反应越快、出手越快、伤害越重，而不是简单堆数值。
 * ========================================================================== */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.SIM3D = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const VERSION = "sim3d-0.6";
  const DT = 1 / 60;                 // 固定步长
  const CAP_R = 0.34;                // 角色胶囊半径（米）

  // ── 招式库（sim3d/moves.js）───────────────────────────────────────────────
  //   出招时**先查库**：查到就用库里的出招时间/距离/扇角/高度带与华丽效果；
  //   查不到（角色卡自带的招式名）就**自动入库**并持久化，下次同名招式直接调用。
  const MOVES = (function () {
    try { if (typeof require === "function") return require("./moves.js"); } catch (e) { /* 浏览器环境 */ }
    const g = (typeof globalThis !== "undefined") ? globalThis : {};
    return g.SIM3D_MOVES || g.MOVE_LIB || null;
  })();
  const _libState = { used: 0, added: 0, dirty: false };
  const _libReset = () => { _libState.used = 0; _libState.added = 0; _libState.dirty = false; };

  // ── 武力等级：与界面同一张表（力量倍率），另加"体感"缩放 ──────────────
  const TIER_POWER = { 1: 1, 2: 1.5, 3: 2, 4: 3, 5: 4, 6: 6, 7: 8, 8: 12, 9: 16 };
  const TIER_NAME = ["", "凡人", "好手", "高手", "宗师", "大宗师", "绝世", "超凡", "神魔", "灭世"];

  // ── 垂直轴（v0.4）：等级不只加数值，还**解锁机动能力** ──────────────────
  // 玄幻向阶梯：等级越高越"能飞"。凡人不上天，7 级以上真正飞行（飞天遁地）。
  // jump=起跳峰值（米）／hover=可持续悬停高度（米，0=不能悬停）／airAtk=一次滞空可出的空中招数
  // dash=空中冲刺档位／wall=可踏墙借力／shock=落地冲击波半径（米，0=无）
  const G_Z = 20;            // 垂直重力 m/s²（越大越"重"，滞空越短）
  const AIR_MAX = 14;        // 天花板兜底（米）
  const WALL_RUN_MAX = 1.1;  // 单次贴墙滑行上限（秒）：贴墙是借力换位，不是拿来漂着
  const WALL_RUN_FIGHT_MAX = 3.0; // 每场贴墙总时长上限（秒）
  const MOBILITY = [
    { min: 9, key: "flight", zh: "飞天遁地", jump: 6.4, hover: 6.5, hoverTime: 7.0, airAtk: 3, dash: 3, wall: true, flight: true, shock: 2.4 },
    { min: 8, key: "flight", zh: "御空飞行", jump: 5.4, hover: 5.0, hoverTime: 6.0, airAtk: 3, dash: 3, wall: true, flight: true, shock: 2.0 },
    { min: 7, key: "flight", zh: "凌空飞行", jump: 4.4, hover: 3.6, hoverTime: 5.0, airAtk: 2, dash: 2, wall: true, flight: true, shock: 1.7 },
    { min: 5, key: "wall",   zh: "踏墙借力", jump: 2.6, hover: 0,   hoverTime: 1.8, airAtk: 2, dash: 2, wall: true,  flight: false, shock: 0 },
    { min: 3, key: "leap",   zh: "轻功腾跃", jump: 1.3, hover: 0,   hoverTime: 1.4, airAtk: 1, dash: 1, wall: false, flight: false, shock: 0 },
    { min: 1, key: "none",   zh: "凡人步法", jump: 0,   hover: 0,   hoverTime: 0,   airAtk: 0, dash: 0, wall: false, flight: false, shock: 0 }
  ];
  function mobility(tier) {
    const t = Math.max(1, Math.min(9, Math.round(tier || 1)));
    for (const m of MOBILITY) if (t >= m.min) return Object.assign({ tier: t }, m);
    return Object.assign({ tier: t }, MOBILITY[MOBILITY.length - 1]);
  }

  // ── 打斗情景（v0.5）：情景不是美术描述，真的改变结算 ────────────────────
  // 与界面的 SCENARIOS[].rule 同源，这里把"规则"落成内核参数：
  //   obstacles/cover＝掩体（可挡攻击、可撞碎）；ring＝擂台边界（越界掉台）；
  //   chase＝一追一逃；aerial＝高空场地（全员借风踏空）；slick/water＝湿滑失衡与水花；
  //   ai＝该情景下的攻/守/走位权重偏移（对齐旧网格内核的 SCEN_AI）。
  const SCEN = {
    none:   { key:"none",   zh:"无情景", obstacles:0, cover:false, ring:0,   chase:false, aerial:false, slick:0,    water:0,    ai:{ move:0,     def:0,     atk:0 } },
    field:  { key:"field",  zh:"阵地战", obstacles:6, cover:true,  ring:0,   chase:false, aerial:false, slick:0,    water:0,    ai:{ move:0.10,  def:0.15,  atk:0 } },
    arena:  { key:"arena",  zh:"擂台战", obstacles:0, cover:false, ring:4.2, chase:false, aerial:false, slick:0,    water:0,    ai:{ move:-0.20, def:0,     atk:0.12 } },
    chase:  { key:"chase",  zh:"追逐战", obstacles:4, cover:true,  ring:0,   chase:true,  aerial:false, slick:0,    water:0,    ai:{ move:0.22,  def:0,     atk:0.05 } },
    aerial: { key:"aerial", zh:"空战",   obstacles:0, cover:false, ring:0,   chase:false, aerial:true,  slick:0,    water:0,    ai:{ move:0.16,  def:-0.18, atk:0.10 } },
    water:  { key:"water",  zh:"水战",   obstacles:0, cover:false, ring:0,   chase:false, aerial:false, slick:0.20, water:0.30, ai:{ move:0.06,  def:0.04,  atk:0.14 } }
  };
  function scenario(id) { return SCEN[id] || SCEN.none; }
  // 空战：场地本身就是高空，全员获得"借风踏空"的底子（低等级也能在空中打），
  // 但档位越高仍飞得越高（凡人级踏空 2.8 米 vs 灭世级御空 6.5 米）。
  function aerialFloor(m) {
    return Object.assign({}, m, {
      key: m.key === "none" ? "wall" : m.key,
      zh: m.key === "none" ? "踏空借风" : m.zh,
      jump: Math.max(m.jump, 2.6), hover: Math.max(m.hover, 2.8), hoverTime: Math.max(m.hoverTime, 2.4),
      airAtk: Math.max(m.airAtk, 2), dash: Math.max(m.dash, 2),
      wall: true, flight: true, shock: m.shock
    });
  }

  // ── 兵器：决定射程与手感（起手/判定/收招秒数、基础伤害）────────────────
  const WEAPONS = {
    none:    { zh: "空手",  reach: 0.86, w: 0.16, a: 0.09, r: 0.22, dmg: 7,  gb: 0.9, alias: ["拳", "掌", "肘", "膝"] },
    duanren: { zh: "短刃",  reach: 0.78, w: 0.14, a: 0.08, r: 0.20, dmg: 8,  gb: 0.9, alias: ["匕首", "短刃"] },
    duangun: { zh: "短棍",  reach: 1.05, w: 0.19, a: 0.09, r: 0.25, dmg: 9,  gb: 1.1, alias: ["短棍"] },
    dao:     { zh: "刀",    reach: 1.24, w: 0.22, a: 0.11, r: 0.30, dmg: 10, gb: 1.2, alias: ["刀"] },
    jian:    { zh: "剑",    reach: 1.34, w: 0.20, a: 0.10, r: 0.27, dmg: 9,  gb: 1.1, alias: ["剑"] },
    pu:      { zh: "朴刀",  reach: 1.50, w: 0.30, a: 0.12, r: 0.38, dmg: 13, gb: 1.4, alias: ["朴刀"] },
    nodachi: { zh: "太刀",  reach: 1.64, w: 0.34, a: 0.13, r: 0.43, dmg: 14, gb: 1.5, alias: ["太刀"] },
    gun:     { zh: "棍",    reach: 1.86, w: 0.28, a: 0.12, r: 0.36, dmg: 11, gb: 1.3, alias: ["棍"] },
    bang:    { zh: "棒",    reach: 1.92, w: 0.30, a: 0.12, r: 0.38, dmg: 12, gb: 1.4, alias: ["棒", "杆"] },
    qiang:   { zh: "枪",    reach: 2.44, w: 0.30, a: 0.10, r: 0.38, dmg: 12, gb: 1.2, alias: ["枪", "矛"] }
  };

  // ── 招式变体：扇形角度、攻击高度、伤害/击退/耗力倍率 ──────────────────
  const VARIANTS = [
    { key: "slash",  zh: "横斩", arc: 118, h: "mid",  dmg: 1.00, kb: 1.00, stam: 1.00, reach: 1.00, tag: "攻击" },
    { key: "diag",   zh: "斜劈", arc: 96,  h: "high", dmg: 1.10, kb: 1.15, stam: 1.10, reach: 1.00, tag: "攻击" },
    { key: "thrust", zh: "突刺", arc: 22,  h: "mid",  dmg: 1.05, kb: 0.70, stam: 0.85, reach: 1.22, tag: "攻击" },
    { key: "rise",   zh: "撩挑", arc: 74,  h: "low",  dmg: 0.95, kb: 1.05, stam: 0.95, reach: 1.02, tag: "攻击" },
    { key: "sweep",  zh: "扫堂", arc: 150, h: "low",  dmg: 0.90, kb: 1.30, stam: 1.20, reach: 1.06, tag: "移动" },
    { key: "heavy",  zh: "重击", arc: 138, h: "mid",  dmg: 1.70, kb: 2.10, stam: 1.75, reach: 1.05, tag: "攻击", slow: 1.35 },
    { key: "finish", zh: "终结", arc: 132, h: "mid",  dmg: 2.30, kb: 2.60, stam: 1.90, reach: 1.05, tag: "攻击", slow: 1.45, finisher: true },
    // ── v0.4 空中招式：只有机动档够的等级才用得上（见 mobility）──────────
    // air=空中招（判定高度带会向脚下延伸）／airOnly=只能在离地时出／dive=俯冲（向下延伸更大）
    { key: "leap_slash", zh: "跃斩",    arc: 104, h: "mid",  dmg: 1.15, kb: 1.25, stam: 1.05, reach: 1.05, tag: "攻击", air: true, leap: true },
    { key: "wall_flip",  zh: "踏墙翻身", arc: 128, h: "mid",  dmg: 1.05, kb: 1.10, stam: 0.95, reach: 1.00, tag: "移动", air: true, wall: true },
    { key: "air_combo",  zh: "空中连击", arc: 132, h: "mid",  dmg: 1.30, kb: 1.35, stam: 1.15, reach: 1.02, tag: "攻击", air: true, airOnly: true },
    { key: "dive",       zh: "俯冲击",   arc: 92,  h: "high", dmg: 1.65, kb: 1.95, stam: 1.30, reach: 1.12, tag: "攻击", air: true, airOnly: true, dive: true }
  ];
  const AIR_VARIANTS = VARIANTS.filter(v => v.air);

  // ── 性格：与界面 FIGHT_STYLES 同源权重（0~1）─────────────────────────
  const STYLES = {
    berserk:   { zh: "嗜血狂杀", aggr: 1.00, block: 0.05, dodge: 0.05, counter: 0.20, ruthless: 1.00, patience: 0.10 },
    calm:      { zh: "冷静稳健", aggr: 0.50, block: 0.60, dodge: 0.60, counter: 1.00, ruthless: 0.00, patience: 0.70 },
    guardian:  { zh: "铁壁如山", aggr: 0.35, block: 1.00, dodge: 0.20, counter: 0.60, ruthless: 0.00, patience: 0.85 },
    swift:     { zh: "疾风迅雷", aggr: 0.70, block: 0.10, dodge: 1.00, counter: 0.60, ruthless: 0.00, patience: 0.35 },
    power:     { zh: "力压千钧", aggr: 0.90, block: 0.10, dodge: 0.20, counter: 0.40, ruthless: 0.40, patience: 0.30 },
    tactician: { zh: "老谋深算", aggr: 0.50, block: 0.70, dodge: 0.50, counter: 1.00, ruthless: 0.00, patience: 0.90 },
    hunter:    { zh: "一击必杀", aggr: 0.65, block: 0.30, dodge: 0.60, counter: 0.90, ruthless: 0.20, patience: 0.95 },
    cool:      { zh: "冷面寒刀", aggr: 0.78, block: 0.30, dodge: 0.30, counter: 0.70, ruthless: 0.30, patience: 0.60 }
  };

  // ── 确定性随机（mulberry32）───────────────────────────────────────────
  function mulberry32(seed) {
    let a = (seed >>> 0) || 1;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ── 等级 → 体感参数（不是简单堆倍率：速度/反应/韧性一起变）────────────
  function tierProfile(tier) {
    const t = Math.max(1, Math.min(9, Math.round(tier || 1)));
    return {
      tier: t, name: TIER_NAME[t], power: TIER_POWER[t],
      speed: 1 + (t - 1) * 0.10,            // 移动速度倍率（9 级 1.8×）
      rate: 1 + (t - 1) * 0.08,             // 出手速度倍率（9 级 1.64×）
      dmg: 1 + (t - 1) * 0.55,              // 伤害倍率（9 级 5.4×）：与"韧性^1.5"的耐打成长配平，
                                            // 否则高等级镜像对局会互相砍不动、30 秒打不完
      tough: 1 + (t - 1) * 0.45,            // 气血/韧性（9 级 4.6×）
      react: Math.max(0.075, 0.30 - (t - 1) * 0.026), // 反应延迟（凡人 0.30s → 灭世 0.075s；重击起手够长所以闪得掉）
      turn: 5.0 + (t - 1) * 1.15,           // 转身速率 rad/s
      stam: 1 + (t - 1) * 0.18,             // 体力池
      push: 1 + (t - 1) * 0.22,             // 击退抗性
      mob: mobility(t)                      // 机动能力（轻功/飞行档）：等级解锁，不是倍率
    };
  }

  function geometry() {
    const ptSeg = (px, py, ax, ay, bx, by) => {
      const dx = bx - ax, dy = by - ay;
      const L2 = dx * dx + dy * dy;
      let t = L2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / L2 : 0;
      t = Math.max(0, Math.min(1, t));
      const cx = ax + dx * t, cy = ay + dy * t;
      return Math.hypot(px - cx, py - cy);
    };
    const inTri = (px, py, ax, ay, bx, by, cx, cy) => {
      const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by);
      const d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy);
      const d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay);
      const neg = (d1 < 0) || (d2 < 0) || (d3 < 0), pos = (d1 > 0) || (d2 > 0) || (d3 > 0);
      return !(neg && pos);
    };
    // 扇形扫掠（annulus sector）与圆是否相交：把扇形按角度切片成三角扇逐片测
    const sectorHitsCircle = (cx, cy, r, ox, oy, a0, a1, rMin, rMax) => {
      const span = Math.abs(a1 - a0);
      const steps = Math.max(2, Math.ceil(span / 0.12));
      for (let i = 0; i < steps; i++) {
        const s0 = a0 + (a1 - a0) * (i / steps), s1 = a0 + (a1 - a0) * ((i + 1) / steps);
        const x0 = ox + Math.cos(s0) * rMax, y0 = oy + Math.sin(s0) * rMax;
        const x1 = ox + Math.cos(s1) * rMax, y1 = oy + Math.sin(s1) * rMax;
        // ① 圆心到"刀尖扫过的弧段"距离
        const dArc = ptSeg(cx, cy, x0, y0, x1, y1);
        if (dArc <= r) return true;
        // ② 圆心落在该扇形切片内（近身/贴身时）
        const dist = Math.hypot(cx - ox, cy - oy);
        if (dist <= rMax && dist >= Math.max(0, rMin - r) &&
            (inTri(cx, cy, ox, oy, x0, y0, x1, y1) || ptSeg(cx, cy, ox, oy, x0, y0) <= r)) return true;
      }
      return false;
    };
    // 两段（兵器）是否相交：用于"对拼/格挡"判定。参数是两条线段 [[x,y],[x,y]]
    const segSeg = (s1, s2) => {
      const a = s1[0], b = s1[1], c = s2[0], d = s2[1];
      const s = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
      const d1 = s(c, d, a), d2 = s(c, d, b), d3 = s(a, b, c), d4 = s(a, b, d);
      if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
      return false;
    };
    return { sectorHitsCircle, segSeg, ptSeg };
  }
  const G = geometry();

  function norm(a) { while (a > Math.PI) a -= Math.PI * 2; while (a < -Math.PI) a += Math.PI * 2; return a; }
  function angDiff(a, b) { return Math.abs(norm(a - b)); }
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  // ── 角色 ─────────────────────────────────────────────────────────────
  function makeFighter(o, rng) {
    const prof = tierProfile(o.tier || 1);
    const sty = STYLES[o.style] || STYLES.calm;
    const wpn = WEAPONS[o.weapon] || WEAPONS.none;
    const hpMax = Number.isFinite(o.hp) && o.hp > 0 ? o.hp : Math.round(100 * prof.tough);
    return {
      skills: o.skills || [], cooldowns: {}, rules: o.rules || {}, speed: o.speed || 1,
      id: o.id, name: o.name || o.id, prof, style: sty, styleKey: o.style || "calm",
      mob: prof.mob,
      wpnKey: o.weapon || "none", wpn, reach: wpn.reach,
      x: o.x || 0, y: o.y || 0, z: 0, vx: 0, vy: 0, vz: 0, face: o.face || 0,
      hp: hpMax, hpMax, guard: 100, guardMax: 100,
      sta: 100 * prof.stam, staMax: 100 * prof.stam,
      state: "idle",            // idle|move|attack|block|dodge|hitstun|stagger|down
      post: "stand",            // stand|crouch|air
      // 垂直轴状态（v0.4）：起跳/滞空/落地
      airCd: 0, airAtkLeft: 0, airAtkTimer: 0, airHold: 0, mustLand: false, landLock: 0, peakZ: 0, wallReady: false,
      slipT: 0, splashT: 0,               // 水战：打滑/水花计时
      wallT: 0, wallCd: 0, wasHover: false,   // 飞檐走壁：贴墙滑行计时 / 悬停状态
      seekCd: 0, wallSeeks: 0,              // 借墙游走：冷却与每场上限（防止"贴墙代步"）
      // 起跳纪律（v0.5）：每一次起跳都要有目的 + 每场配额 + 滞空预算，杜绝无意义弹跳
      leaps: 0, lastLeapT: -9, airT: 0, airIdleT: 0, leapWhy: null, leapDenied: 0, leapWhyLog: [],
      purposeLog: [],                   // 每个决策的目的日志（审计用）
      spells: o.spells || [], spellCd: {},    // 远程法术（来自角色卡「法术」组，卡里没配时由 pipeline 按等级自动补内力技）
      qi: o.qi || { label: "无", burst: 0, kb: 0, castBonus: 0 },   // 内力外放档（1~2 级为 0＝纯肉身）
      castT: 0, castSpell: null,
      tech: null, techT: 0, phase: "", hasHit: false,
      arcFrom: 0, arcTo: 0, swingDir: 1, atkStart: 0,
      hitstun: 0, blockHold: 0, intent: { kind: "spacing" },
      decideT: 0, seen: null, combo: 0, comboT: -9, stats:
        { attacks: 0, hits: 0, blocks: 0, dodges: 0, clashes: 0, guardBreaks: 0, whiffs: 0, dmg: 0, maxCombo: 0,
          takeoffs: 0, lands: 0, airHits: 0, shocks: 0, maxZ: 0,
          wallRuns: 0, wallKicks: 0, hovers: 0, hoverT: 0,
          spellCasts: 0, spellHits: 0, qiBursts: 0,
          ringOuts: 0, obstacleHits: 0, slips: 0, splashes: 0 }
    };
  }

  function canBlock(attacker, defender) {
    // 沿用界面的战斗规则：兵器对兵器才格挡；空手不得用手接刃
    if (defender.rules.noBlock) return false;
    if (defender.wpnKey !== "none" ) return true;
    return attacker.wpnKey === "none";     // 双方空手 → 可以格挡
  }

  function pickVariant(f, opp, rng) {
    const s = f.style, dist = Math.hypot(opp.x - f.x, opp.y - f.y);
    const r = rng();
    if (f.esc > 2.4) return VARIANTS[6];                                                       // 末段决胜：招招求终结
    if (opp.hp <= f.hpMax * 0.22 && r < 0.55 * (0.6 + s.ruthless)) return VARIANTS[6];        // 终结
    if (opp.state === "block" && r < 0.35 + 0.45 * s.aggr) return VARIANTS[5];                // 崩防重击
    if (f.wpnKey === "qiang" && r < 0.55) return VARIANTS[2];                                  // 长枪多刺
    if (dist > f.reach * 0.9 && r < 0.4) return VARIANTS[2];                                   // 远距离突刺
    if (r < 0.18) return VARIANTS[3];                                                          // 撩挑
    if (r < 0.30) return VARIANTS[1];                                                          // 斜劈
    if (r < 0.42 && s.aggr > 0.4) return VARIANTS[5];                                          // 重击
    return VARIANTS[0];                                                                        // 横斩
  }

  // ── 高度带：一招只能打到"它覆盖的高度区间"里的躯干 ────────────────────
  // 这是"飞起来就打不着"的规则来源，也是"把对手打下来"的战术基础。
  function defSpan(f) {
    const top = f.post === "crouch" ? 1.05 : (f.state === "down" ? 0.55 : 1.75);
    return [f.z + 0.05, f.z + top];
  }
  function atkBand(f, v) {
    const base = f.z;
    const hi = v.h === "high" ? 1.95 : (v.h === "low" ? 0.85 : 1.50);
    const lo = v.air
      ? base - (v.dive ? 2.40 : 1.10)                       // 空中招向下延伸：俯冲能打到地面
      : base + (v.h === "low" ? 0 : (v.h === "high" ? 1.10 : 0.25));
    return [Math.max(-0.05, lo), base + hi];
  }
  const bandOverlap = (a, b) => a[1] >= b[0] && b[1] >= a[0];

  // 机动档够不够：等级解锁 + 体力 + 冷却（体力见底必须落地回气）
  function canAir(f, sim, cost) {
    if (!f.mob || f.mob.jump <= 0 || f.mob.airAtk <= 0) return false;
    if (f.airCd > sim.t) return false;
    return f.sta > (cost == null ? 26 : cost);
  }
  const jumpV = (peak) => Math.sqrt(2 * G_Z * Math.max(0.05, peak));

  // ── 起跳纪律（v0.5）──────────────────────────────────────────────────
  // 一次起跳只有在"有目的"时才允许，并受每场配额与滞空预算限制：
  //   why 取值：evade(躲来招) / attack(跃起重击) / antiAir(迎空拦截) / close(突进接近) /
  //             chase(追击) / reposition(借墙换位) / escape(脱离)
  // 目的门控：close/chase 必须真的离得远；attack 必须有出手机会（对方在射程 2.2 倍内）；
  //   reposition 必须在墙边；evade/antiAir/escape 天然成立（有明确来招或对手在空中）。
  function leapCap(f) {
    const k = f.mob ? f.mob.key : "none";
    if (k === "flight") return 3;
    if (k === "wall") return 2;
    if (k === "leap") return 1;
    return 0;
  }
  function airBudget(f) {                       // 每场累计滞空秒数上限
    const k = f.mob ? f.mob.key : "none";
    if (k === "flight") return 3.2;
    if (k === "wall") return 2.2;
    if (k === "leap") return 1.4;
    return 0;
  }
  function leaping(f) { return f.z > 0.05 || f.state === "takeoff" || f.state === "land"; }
  // ── 动作目的（v0.5）：内核里每个决策都必须落进这张表；落不进去的记为"无目的" ──
  //   键 = 决策 kind（可带 reason 限定），值 = { key, zh }
  const PURPOSE_MAP = {
    "attack": { key: "attack", zh: "进攻·压制" },
    "attack|air": { key: "attack_air", zh: "进攻·空中重击" },
    "attack|antiAir": { key: "intercept", zh: "迎空拦截" },
    "attack|punish": { key: "punish", zh: "抓空档惩罚" },
    "attack|cornered": { key: "turnfight", zh: "被逼转身应战" },
    "attack|chase": { key: "chase_hit", zh: "追上即打" },
    "attack|turnfight": { key: "turnfight", zh: "被逼转身应战" },
    "attack|air": { key: "attack_air", zh: "进攻·空中重击" },
    "block": { key: "guard", zh: "护住·卸力" },
    "dodge": { key: "evade", zh: "闪躲·让开刃线" },
    "approach": { key: "close", zh: "进射程" },
    "flank": { key: "angle", zh: "抢侧身角度" },
    "spacing": { key: "reset", zh: "调整距离" },
    "retreat": { key: "escape", zh: "脱离射程" },
    "flee": { key: "escape", zh: "脱离·逃跑" },
    "cover": { key: "cover", zh: "借掩体挡线" },
    "intercept": { key: "cutoff", zh: "截对方落点" },
    "hover": { key: "hover", zh: "空中压迫" },
    "cast": { key: "ranged", zh: "隔空压制" },
    "leap": { key: "leap", zh: "跃起（见 why）" },
    "takeoff": { key: "hover", zh: "升空压迫" },
    "turnfight": { key: "turnfight", zh: "被逼转身应战" },
    "stand": { key: "reset", zh: "收势观望" },
    // 以下四种来自全场景枚举（阵地/擂台/追逐/空战/水战 × 多等级）
    "guardSpace": { key: "spacing_guard", zh: "护住·保持距离" },   // 拉锯警戒：举着兵器控距，等对方先动
    "space": { key: "reset", zh: "调整距离" },
    "recover": { key: "recover", zh: "受击后稳住重心" },
    "wallseek": { key: "reposition", zh: "借墙换位" }
  };
  function purposeOf(it) {
    if (!it || !it.kind) return null;
    const spec = PURPOSE_MAP[it.kind + "|" + (it.reason || "")] || PURPOSE_MAP[it.kind];
    return spec || null;
  }
  function recordPurpose(f, sim, it) {
    f.stats.purposeTotal = (f.stats.purposeTotal || 0) + 1;
    const spec = purposeOf(it);
    if (spec) {
      f.stats.purposeTagged = (f.stats.purposeTagged || 0) + 1;
      f.stats.purposeCounts = f.stats.purposeCounts || {};
      f.stats.purposeCounts[spec.key] = (f.stats.purposeCounts[spec.key] || 0) + 1;
      f.purposeLog.push({ t: +sim.t.toFixed(2), kind: it.kind, reason: it.reason || "", purpose: spec.key, zh: spec.zh });
    } else {
      f.stats.unpurposed = (f.stats.unpurposed || 0) + 1;
      f.purposeLog.push({ t: +sim.t.toFixed(2), kind: it.kind, reason: it.reason || "", purpose: null, zh: "（未标注目的）" });
    }
  }
    const LEAP_WHY_ZH = { evade: "为躲开来招而跃起", attack: "为跃起重击而升空", antiAir: "为拦截空中的对手而迎空",
    close: "为突进接近而跃起", chase: "为追击而跃起", reposition: "借墙换位（抢角度）", escape: "为脱离而跃起" };
  function leapWhyZh(w) { return LEAP_WHY_ZH[w] || "起跳"; }
  function canLeap(f, sim, cost, why) {
    if (!canAir(f, sim, cost)) return false;
    // 追逐战里"追"和"逃"本来就是靠身法完成的，给追击/脱离类起跳放宽（否则追击者追不上，30 秒打不完）
    const inChase = !!(sim.chase && sim.chase.chaser === f.id);
    const cap = leapCap(f) + (inChase && (why === "chase" || why === "escape" || why === "evade") ? 3 : 0);
    const budget = airBudget(f) + (inChase ? 2.5 : 0);
    const cd = (why === "chase" || why === "escape") ? 1.2 : 2.2;
    if (f.leaps >= cap) { f.leapDenied++; return false; }                       // 每场配额
    if ((f.airT || 0) >= budget) { f.leapDenied++; return false; }              // 滞空预算
    if (sim.t - (f.lastLeapT || -9) < cd) { f.leapDenied++; return false; }     // 起跳冷却（防连跳）
    const opp = (f === sim.A ? sim.B : sim.A);
    const dist = Math.hypot(opp.x - f.x, opp.y - f.y);
    const threat = opp.state === "attack" && (sim.t - (opp.atkStart || 0)) < 0.45;
    switch (why) {
      case "evade":                                                             // 躲来招：必须真有来招
        if (!threat && !sim.recentThreat) { f.leapDenied++; return false; }
        break;
      case "antiAir":
        if (!(opp.z > 1.2)) { f.leapDenied++; return false; }
        break;
      case "attack":                                                            // 跃起重击：必须有出手机会
        if (!(dist <= f.reach * 2.2 && f.sta > 34)) { f.leapDenied++; return false; }
        break;
      case "close":
      case "chase":
        if (!(dist > 2.2)) { f.leapDenied++; return false; }                    // 只有真的远才值得跳过去
        break;
      case "escape":                                                            // 脱离：必须有来招或在被追
        if (!(threat || inChase)) { f.leapDenied++; return false; }
        break;
      case "reposition":                                                        // 借墙换位：必须在墙边
        if (!f.mob.wall) { f.leapDenied++; return false; }
        break;
      default:
        f.leapDenied++; return false;                                           // 没写目的 → 一律不许跳
    }
    f.leapWhy = why;
    return true;
  }

  // ── 跳跃高度自适应（v0.5）────────────────────────────────────────────
  //   高度不是固定倍率，而是在"该等级能跳的上限"内按动作与对手状态算出来：
  //   · 躲低招（扫堂/撩挑）：只要越过来招高度带顶 + 余量 → 低跃（最省力、最像武术）
  //   · 跃起重击：按对手姿态给中高跃（蹲着低一点、站着中高、空中够上去）
  //   · 迎空拦截：必须够到空中对手的高度（opp.z + 余量）
  //   · 突进/追击/脱离：低平跃（跳高了反而贴不上人）
  //   · 借墙换位：中等（借墙的力）
  function incomingVariant(opp, sim) {
    if (!opp || opp.state !== "attack" || !opp.tech) return null;
    if (sim.t - (opp.atkStart || 0) > 0.55) return null;
    return opp.tech;
  }
  function jumpPeakFor(f, sim, why, it) {
    const opp = (f === sim.A ? sim.B : sim.A);
    const maxJ = Math.max(0.35, f.mob.jump);
    const lo = maxJ * 0.22, hi = maxJ;
    const cl = (h) => Math.max(lo, Math.min(hi, h));
    const v = incomingVariant(opp, sim);
    switch (why) {
      case "evade": {
        const bandTop = v ? (opp.z + (v.h === "high" ? 1.95 : (v.h === "low" ? 0.85 : 1.50))) : (opp.z + 1.20);
        return cl(bandTop + 0.22);
      }
      case "antiAir": return cl(Math.max(opp.z + 0.45, lo * 1.6));
      case "attack": return cl(Math.max(opp.post === "crouch" ? 0.85 : 1.25, opp.z + 0.55));
      case "close": return cl(maxJ * 0.42);
      case "chase": return cl(maxJ * 0.34);
      case "escape": return cl(maxJ * 0.30);
      case "reposition": {
        // 借墙换位：离墙越远跳得越高（要够到墙面），贴墙时低一些
        const nw = (typeof nearestWall === "function") ? nearestWall(sim.arena, f) : null;
        const far = nw ? Math.min(1.5, nw.dist / 2.0) : 0.5;
        return cl(maxJ * (0.50 + 0.30 * far));
      }
      default: return cl(maxJ * 0.45);
    }
  }
  function jumpPeakZh(why, peak, opp, sim, f) {
    const v = incomingVariant(opp, sim);
    const maxJ = Math.max(0.35, (f && f.mob ? f.mob.jump : peak));
    const r = peak / maxJ;                                   // 相对本人档位：0~1
    const h = r < 0.5 ? "低跃" : (r < 0.78 ? "中跃" : "高跃");
    const m = peak.toFixed(1) + " 米";
    if (why === "evade") return h + " " + m + "（越过来招高度带，躲开" + (v ? "对方的" + v.zh : "来招") + "）";
    if (why === "antiAir") return h + " " + m + "（迎空拦截，够到对方高度）";
    if (why === "attack") return h + " " + m + "（跃起重击，按对方姿态取高）";
    if (why === "close") return h + " " + m + "（跃起突进，压低高度保速度）";
    if (why === "chase") return h + " " + m + "（追击起跳，压低高度追人）";
    if (why === "escape") return h + " " + m + "（低跃后撤脱离）";
    if (why === "reposition") return h + " " + m + "（借墙换位）";
    return h + " " + m;
  }
  function hoverAltFor(f, sim) {
    const opp = (f === sim.A ? sim.B : sim.A);
    // 目标高度 = 刚好压住对手射程之上（对手蹲着就低一点），但飞行档不得低于档位的 90%
    const reachTop = opp.z + (opp.post === "crouch" ? 1.05 : 1.75) + (opp.reach || 1.1) * 0.25;
    const tactical = reachTop + 0.55;
    const floor = f.mob.hover * 0.9;
    return Math.max(1.3, Math.min(f.mob.hover, Math.max(tactical, floor)));
  }

  function pickAirVariant(f, opp, rng) {
    const r = rng();
    if (opp.z > 0.5) return r < 0.62 ? AIR_VARIANTS[2] : (r < 0.86 ? AIR_VARIANTS[3] : AIR_VARIANTS[1]); // 空中对空：连击为主
    return r < 0.55 ? AIR_VARIANTS[3] : (r < 0.82 ? AIR_VARIANTS[0] : AIR_VARIANTS[2]);                 // 空中对地：俯冲为主
  }

  function startAttack(sim, f, v) {
    if (f.rules.blockOnly) return false;
    // 空中招由"机动档"解锁，不吃角色卡招式表（身法是等级能力，不是卡里的招式）
    if (v && v.air) {
      const okv = f.mob.airAtk > 0 && f.airAtkLeft > 0 && (!v.airOnly || f.z > 0.4) && (!v.wall || f.mob.wall);
      if (!okv) v = VARIANTS[0]; else f.airAtkLeft -= 1;
    }
    if (f.skills.length && !v.air) {
      const available=f.skills.filter(s=>(f.cooldowns[s.skillId]||0)<=sim.t);
      if(!available.length) return false;
      v=available.find(s=>s.key===v.key) || available[Math.floor(sim.rng()*available.length)];
    }
    if(f.rules.noLeg && v.key==='sweep') v=VARIANTS[0];
    if(f.rules.heavy) v=Object.assign({},v,{dmg:Math.max(v.dmg,1.7),kb:Math.max(v.kb,2.1),slow:1.35});
    const slow = (v.slow || 1) / f.prof.rate / f.speed;
    let w = f.wpn.w * slow, a = f.wpn.a * slow / Math.max(0.85, f.prof.rate * 0.9), r = f.wpn.r * slow;
    // ── 招式库：先查库（按名字优先，其次按基础变体 key）────────────────────
    let libMove = null;
    if (MOVES) {
      // 查库纪律：**先按招式名精确查**；只有在"名字就是基础变体名"时才回退到变体条目。
      // （否则角色卡里的自定义招式会被错误地套上同名变体的描述 —— 实测踩过这个坑）
      const byName = MOVES.get(v.zh);
      const byKey = MOVES.get(v.key);
      libMove = byName || ((byKey && byKey.zh === v.zh) ? byKey : null);
      if (!libMove && v.zh && v.skillId) {
        // 角色卡自带的招式：库里没有 → 自动入库（用本次内核实际参数补齐，下次直接用）
        libMove = MOVES.register({
          zh: v.zh, key: v.key, category: v.air ? "轻功" : "近战",
          weapons: [f.wpnKey], tiers: [f.prof.tier, f.prof.tier],
          arc: v.arc, band: v.h || "mid", tags: [v.tag || "攻击"],
          timing: { charge: [+(w * 0.85).toFixed(3), +(w * 1.35).toFixed(3)],
                    active: [+(a * 0.85).toFixed(3), +(a * 1.30).toFixed(3)],
                    recover: [+(r * 0.85).toFixed(3), +(r * 1.35).toFixed(3)] },
          range: [+(f.reach * (v.reach || 1) * 0.9).toFixed(2), +(f.reach * (v.reach || 1) * 1.15).toFixed(2)],
          effect: v.effect || "", source: "auto"
        });
        if (libMove && libMove.source === "auto") { _libState.added++; _libState.dirty = true; }
      }
      if (libMove) {
        // 只有**内置(seed)条目**才驱动出招时间/距离（它们是固定常量 → 保证同 seed 可复现）。
        // 自动入库的条目只提供"准备/出招/华丽效果"这些描述字段，不参与结算参数，
        // 否则"第一次运行入库、第二次运行读库"会得到不同参数 —— 确定性就没了（实测踩过）。
        const driveParams = (libMove.source === "seed");
        if (driveParams && libMove.timing) {
          const mid = (rg) => (rg[0] + rg[1]) / 2;
          // 夹持收窄到 0.75~1.30 倍：既让"库"决定招式的快慢个性（力劈华山比突刺慢），
          // 又不至于把整场节奏拖慢到打不完（实测 0.5~2.0 倍会让 48 场里有 1 场超时）
          const cl = (x, base) => Math.max(base * 0.75, Math.min(base * 1.30, x));
          w = cl(mid(libMove.timing.charge) * slow, w);
          a = cl(mid(libMove.timing.active) * slow, a);
          r = cl(mid(libMove.timing.recover) * slow, r);
        }
        // 距离与扇角：库是来源，但**必须克隆**（否则会改到共享的 VARIANTS 表）
        const patch = { libMove: { zh: libMove.zh, prep: libMove.prep, act: libMove.act, effect: libMove.effect,
                                   follow: libMove.follow, timing: libMove.timing, range: libMove.range,
                                   arc: libMove.arc, band: libMove.band, source: libMove.source } };
        if (driveParams) {
          if (libMove.arc) patch.arc = libMove.arc;
          if (libMove.band) patch.h = libMove.band;
          if (libMove.range && libMove.range.length === 2) {
            // 库里的距离是按"中位兵器"（约 1.45 米）写的 → 换算成**相对倍率**再套到当前兵器上。
            // 直接按绝对值换算会把长兵器（棒 1.92／枪 2.44）的射程削短 → 频繁落空、打不完（实测踩过）
            const REF_REACH = 1.45;
            const want = (libMove.range[0] + libMove.range[1]) / 2;
            patch.reach = Math.max(0.7, Math.min(1.7, want / REF_REACH));
          }
        }
        v = Object.assign({}, v, patch);
        _libState.used++;
      }
    }
    const cost = (10 + 8 * v.stam) * (f.wpnKey === "nodachi" ? 1.2 : 1) * (v.air ? 1.45 : 1);
    if (f.sta < cost * 0.5 && !f.style.ruthless) return false;
    f.sta = Math.max(0, f.sta - cost);
    if (v.dive) f.vz = Math.min(f.vz, -3.2);            // 俯冲：主动下压
    if (v.air && f.z > 0.4) {                           // 空中招自带突进，否则空战只剩原地对拼
      const tgt = (f === sim.A ? sim.B : sim.A);
      const toT = Math.atan2(tgt.y - f.y, tgt.x - f.x);
      const rush = 2.0 + f.mob.dash * 0.7;
      f.vx += Math.cos(toT) * rush; f.vy += Math.sin(toT) * rush;
    }
    f.state = "attack"; f.tech = v; f.techT = 0; f.atkStart = sim.t; f.hasHit = false; f.lastAtkT = sim.t;
    f.phase = "windup"; f.dur = { w, a, r };
    const dir = f.swingDir = -f.swingDir;
    const half = (v.arc * Math.PI / 180) / 2;
    f.arcFrom = f.face - half * dir; f.arcTo = f.face + half * dir;
    f.bladeAng = f.arcFrom; f.lastBladeAng = f.arcFrom;   // 刀锋角：判定帧逐帧扫过，而不是整个扇形一直"热"
    if(v.skillId) f.cooldowns[v.skillId]=sim.t+v.cooldown;
    f.stats.attacks++;
    sim.events.push({ t: +sim.t.toFixed(3), type: "attack", who: f.id, tech: v.zh, key: v.key,
                      dur: {w,a,r}, height:v.h, reach:f.reach*v.reach, skillId:v.skillId||null,
                      heavy: v.key === "heavy" || !!v.finisher, finisher: !!v.finisher,
                      z: +f.z.toFixed(3), air: !!v.air, dive: !!v.dive,
                      move: v.libMove || null });     // 招式库条目（名称/准备/出招/华丽效果/时间/距离/范围）
    return true;
  }

  function weaponSeg(f) {
    // 兵器近似为"从手到尖"的一条线段；攻击中取当前刀锋角（便于对拼判定）
    const ang = (f.state === "attack" && f.bladeAng != null) ? f.bladeAng : f.face;
    const hx = f.x + Math.cos(f.face) * 0.22, hy = f.y + Math.sin(f.face) * 0.22;
    const len = f.reach;
    return [[hx, hy], [hx + Math.cos(ang) * len, hy + Math.sin(ang) * len]];
  }

  function applyHit(sim, atk, def, v, blocked, clashed, geo) {
    const base = (v.damage == null ? atk.wpn.dmg * v.dmg * atk.prof.dmg : v.damage * (atk.rules.heavy ? 1.7 : 1)) * (def.esc || atk.esc || 1) * (atk.rules.lowDmg ? 0.3 : 1);
    const tough = def.prof.tough;
    const dirAng = Math.atan2(def.y - atk.y, def.x - atk.x);
    if (clashed) {
      const kb = 0.9 * v.kb * atk.prof.dmg / def.prof.push;
      atk.vx -= Math.cos(dirAng) * kb; atk.vy -= Math.sin(dirAng) * kb;
      def.vx += Math.cos(dirAng) * kb; def.vy += Math.sin(dirAng) * kb;
      atk.hitstun = def.hitstun = Math.max(atk.hitstun, 0.16); atk.state = def.state = "hitstun";
      atk.stats.clashes++; def.stats.clashes++;
      sim.events.push({ t: +sim.t.toFixed(3), type: "clash", a: atk.id, b: def.id, x: (atk.x + def.x) / 2, y: (atk.y + def.y) / 2,
                        z: +((atk.z + def.z) / 2).toFixed(3), air: !!(atk.z > 0.4 || def.z > 0.4) });
      return;
    }
    if (blocked) {
      const push = 0.5 * v.kb * (atk.prof.power / def.prof.power) * 3;
      def.vx += Math.cos(dirAng) * push / def.prof.push; def.vy += Math.sin(dirAng) * push / def.prof.push;
      def.guard -= base * 0.85 * v.stam;
      def.state = "block"; def.blockHold = Math.max(def.blockHold, 0.22);
      def.stats.blocks++;   // 只有"防守方"记格挡（进攻方不记）
      sim.events.push({ t: +sim.t.toFixed(3), type: "block", who: def.id, by: atk.id, tech: v.zh, x:+def.x.toFixed(3), y:+def.y.toFixed(3), guard: Math.round(def.guard),
                        z: +def.z.toFixed(3), spell: !!v.spell, dist: geo ? +geo.dist.toFixed(3) : null, reach: geo ? +geo.reach.toFixed(3) : null });
      if (def.guard <= 0) {                       // 崩防：被打空防守值 → 大硬直
        def.guard = 100 * 0.45; def.state = "stagger"; def.hitstun = 0.85;
        def.stats.guardBreaks++;
        sim.events.push({ t: +sim.t.toFixed(3), type: "guardbreak", who: def.id, by: atk.id });
      }
      return;
    }
    // 真命中
    const dmg = Math.max(0, base / Math.sqrt(tough));
    def.hp = Math.max(0, def.hp - dmg);
    const kb = (1.6 + 2.2 * v.kb) * (atk.prof.power / def.prof.power) * 0.55;
    def.vx += Math.cos(dirAng) * kb; def.vy += Math.sin(dirAng) * kb;
    // 内力外放：等级 3 起，命中瞬间带一圈气劲（半径随等级放大，额外把对手震开）
    // 这是"绝世高手不能只会平A"的内核侧保证——气劲不只是远程技能，肉搏命中也会外放。
    if (atk.qi && atk.qi.burst > 0) {          // 肉搏与气功命中都会外放内力（气功命中更该有气劲）
      const qiKb = kb * atk.qi.kb;
      def.vx += Math.cos(dirAng) * qiKb; def.vy += Math.sin(dirAng) * qiKb;
      if (v.dmg >= 1.6 && atk.qi.burst >= 1.2) def.vz = Math.max(def.vz, 0.6);   // 罡气级以上把对手真的掀起来
      atk.stats.qiBursts = (atk.stats.qiBursts || 0) + 1;
      sim.events.push({ t: +sim.t.toFixed(3), type: "qi_burst", who: atk.id, by: atk.id, tech: atk.qi.label,
                        x: +def.x.toFixed(3), y: +def.y.toFixed(3), z: +def.z.toFixed(3),
                        radius: +atk.qi.burst.toFixed(2), kb: +qiKb.toFixed(2), from: v.zh, tierPower: atk.prof.power });
    }
    // 重击/终结把对手真的打得离地（"击飞"从此有高度，不再是水平滑出去）
    if (v.kb >= 1.5) def.vz = Math.max(def.vz, Math.min(2.2, (v.kb - 1.2) * 1.3));   // 只有重击/终结才真被抛飞，且抛得更低
    def.hitstun = (v.dmg >= 1.6 ? 0.40 : v.dmg >= 1.05 ? 0.26 : 0.18) * (1 + (def.prof.tough - 1) * 0.15);
    def.state = "hitstun";
    def.phase = "";
    const fromAir = atk.z > 0.4;
    atk.stats.hits++; atk.stats.dmg += dmg;
    if (fromAir) atk.stats.airHits++;
    atk.combo = (sim.t - atk.comboT < 1.2) ? atk.combo + 1 : 1; atk.comboT = sim.t;
    atk.stats.maxCombo = Math.max(atk.stats.maxCombo, atk.combo);
    sim.events.push({ t: +sim.t.toFixed(3), type: "hit", who: def.id, by: atk.id, tech: v.zh,
                      height:v.h, damageExact:dmg, dmg: +dmg.toFixed(1), hp: +def.hp.toFixed(1), x: +def.x.toFixed(3), y: +def.y.toFixed(3), finisher: !!v.finisher,
                      z: +def.z.toFixed(3), az: +atk.z.toFixed(3), air: fromAir, dive: !!v.dive, spell: !!v.spell,
                      dist: geo ? +geo.dist.toFixed(3) : null, reach: geo ? +geo.reach.toFixed(3) : null,
                      ang: geo ? +geo.ang.toFixed(3) : null, arc: v.arc,
                      ox: geo && geo.ox != null ? +geo.ox.toFixed(3) : null, oy: geo && geo.oy != null ? +geo.oy.toFixed(3) : null,
                      ba: geo && geo.ba != null ? +geo.ba.toFixed(4) : null, ba0: geo && geo.ba0 != null ? +geo.ba0.toFixed(4) : null });
    const finish = def.hp <= 0 || (v.finisher && def.hp <= def.hpMax * 0.28);
    if (finish) {
      def.hp = 0; def.state = "down"; def.post = "stand"; def.hitstun = 3;
      def.z = 0; def.vz = 0;                            // 倒地就是落地，不会停在空中
      sim.events.push({ t: +sim.t.toFixed(3), type: "ko", who: def.id, x:+def.x.toFixed(3), y:+def.y.toFixed(3), by: atk.id, tech: v.zh, air: fromAir });
    }
    return finish;
  }

  // 最近的可用掩体（阵地战/追逐战"借掩体"用）
  function nearProp(sim, f, maxD) {
    let best = null, bd = maxD == null ? 2.2 : maxD;
    for (const pr of sim.props) {
      if (pr.broken) continue;
      const d = Math.hypot(pr.x - f.x, pr.y - f.y);
      if (d < bd) { bd = d; best = pr; }
    }
    return best;
  }

  // 最近的场地墙（飞檐走壁用）
  function nearestWall(arena, f) {
    const dL = f.x, dR = arena.w - f.x, dB = f.y, dT = arena.h - f.y;
    const m = Math.min(dL, dR, dB, dT);
    if (m === dL) return { axis: "L", dist: dL, dir: [-1, 0] };
    if (m === dR) return { axis: "R", dist: dR, dir: [1, 0] };
    if (m === dB) return { axis: "B", dist: dB, dir: [0, -1] };
    return { axis: "T", dist: dT, dir: [0, 1] };
  }

  // ── 招式效果与时间范围（v0.7）───────────────────────────────────────
  //   每个招式都要给出：准备时间（起势/蓄力，范围）→ 释放时间（脱手到命中/消散，范围），
  //   以及**准确的效果描述**（形态、飞行方式、是否自动追踪、命中表现）。
  const MOVE_EFFECTS = [
    { match: ["降龙十八掌", "亢龙有悔", "飞龙在天"], zh: "降龙十八掌", shape: "龙形气功",
      charge: [1.0, 3.0], release: [2.0, 4.0], track: true, turn: 2.2,
      prep: "扎马步、双掌后收于腰侧、运气起势（掌缘泛出淡金气劲）",
      fire: "双掌向前推出，一条龙形气功脱手飞向对手，飞行中会自动转向追踪",
      hit: "龙形气劲当胸炸开，人被推得离地后滑，衣袍与碎石被气浪掀开", radius: 1.4 },
    { match: ["六脉神剑", "一阳指", "商阳剑"], zh: "六脉神剑", shape: "无形剑气",
      charge: [0.6, 1.6], release: [0.4, 1.2], track: true, turn: 4.0,
      prep: "食中二指并拢、指尖微颤蓄气，身形立稳",
      fire: "指端射出无形剑气，笔直锁向对手，飞行极快且会随对手微调方向",
      hit: "剑气在接触点炸出细密血线/火星，对手被点得僵住半拍", radius: 0.6 },
    { match: ["劈空掌", "隔空掌", "空明拳"], zh: "劈空掌", shape: "掌风冲击",
      charge: [0.8, 2.2], release: [1.2, 2.6], track: true, turn: 1.2,
      prep: "沉肩坠肘、掌心向下压住气机，脚下前掌吃地",
      fire: "单掌劈出，一道掌形气浪贴地推进，会顺着对手的移动方向微调、轻微下压",
      hit: "气浪拍在对手身上像被门板撞中，人向侧后飞出、脚下拖出两道沟；若被兵器架住则震得双臂发麻、人也退半步", radius: 1.1 },
    { match: ["弹指神通", "弹指", "指风"], zh: "弹指神通", shape: "指风弹丸",
      charge: [0.3, 0.9], release: [0.3, 1.0], track: true, turn: 5.0,
      prep: "拇指扣中指、腕部内旋蓄劲",
      fire: "一指弹出，指风如弹丸打向对手面门，会追着对手的移动修正",
      hit: "命中处一声脆响，对手头向后仰、兵器脱手", radius: 0.4 },
    { match: ["龟派气功", "气功波", "冲击波"], zh: "气功波", shape: "球状气功",
      charge: [1.2, 3.5], release: [2.0, 4.5], track: true, turn: 1.6,
      prep: "双掌合于腰侧成碗状、腰马下沉，掌心气团由小涨大并发亮",
      fire: "双掌前送，球形气功脱手飞出，体积随飞行膨胀并自动追踪",
      hit: "球形气功在对手身前炸成光墙，人被冲击波掀翻、地面留焦痕", radius: 1.8 },
    { match: ["火", "火焰", "烈火"], zh: "火系术法", shape: "火柱/火球",
      charge: [0.7, 2.0], release: [1.0, 2.5], track: false, turn: 0.8,
      prep: "掐诀结印、袖口先冒烟",
      fire: "火球拖着尾焰飞出，沿途点燃地面",
      hit: "命中处爆开一团火焰并留燃点，对手被燎得后退", radius: 1.2 },
    { match: ["冰", "寒", "霜"], zh: "冰系术法", shape: "冰锥/冰雾",
      charge: [0.7, 2.0], release: [1.0, 2.4], track: true, turn: 2.6,
      prep: "掌心凝霜、指节泛白",
      fire: "数枚冰锥成扇面飞出，边缘结霜并追踪热源",
      hit: "冰锥命中后炸成霜雾，对手落点结一层薄冰", radius: 1.2 },
    { match: ["雷", "电", "霹雳"], zh: "雷系术法", shape: "雷弧",
      charge: [0.5, 1.5], release: [0.3, 0.9], track: true, turn: 6.0,
      prep: "抬手引雷、发梢立起",
      fire: "一道雷弧瞬间扑向对手，几乎不给人反应时间",
      hit: "命中处爆出白亮弧光，对手僵直并短暂耳鸣，兵器被电弧震开", radius: 1.2 }
  ];
  const DEFAULT_EFFECT = { zh: "隔空气劲", shape: "气团", charge: [0.6, 1.8], release: [1.0, 2.6], track: false, turn: 0.8,
    prep: "沉腰坐马、双掌蓄气", fire: "气团脱手飞向对手", hit: "气劲在接触点炸开把人推开", radius: 1.2 };
  function effectOf(sp) {
    const name = String((sp && (sp.zh || sp.id)) || "");
    const hit = MOVE_EFFECTS.find(m => m.match.some(k => name.indexOf(k) >= 0));
    return hit || DEFAULT_EFFECT;
  }
  // 按等级/气劲档缩放时间范围：低等级准备久、释放缓；高等级反而更快
  function scaledRange(range, tier, qi) {
    const k = Math.max(0.6, Math.min(1.4, 1.25 - (tier || 3) * 0.05 - (qi && qi.burst ? qi.burst * 0.05 : 0)));
    return [+(range[0] * k).toFixed(2), +(range[1] * k).toFixed(2)];
  }
  const pickInRange = (sim, r) => +(r[0] + (r[1] - r[0]) * sim.rng()).toFixed(2);

  // ── 远程法术（角色卡「法术」组）：隔空释放，不必贴脸 ────────────────────
  const SPELL_CAST = 0.34;                   // 施法前摇：可被打断（挨打就散功）
  function startCast(sim, f, sp) {
    if (!f.spells || !f.spells.length || !sp) return false;
    if ((f.spellCd[sp.id] || 0) > sim.t) return false;
    const cost = 14 + (sp.damage || 20) * 0.35;
    if (f.sta < cost) return false;
    // 施法需要空间：贴身（<2.2 米）不起手——否则高等级会变成"贴脸对轰法术"，近战与身法全废
    {
      const o0 = f === sim.A ? sim.B : sim.A;
      if (Math.hypot(o0.x - f.x, o0.y - f.y) < 2.2) return false;
    }
    f.sta -= cost;
    f.spellCd[sp.id] = sim.t + (sp.cd || 1.2);
    f.lastCastT = sim.t;                     // 出手间隔用（防止站着连续对轰）
    // 准备（蓄力）时间：按招式范围随机取，不是固定值
    // 招式库优先：库里有的招式（降龙十八掌/六脉神剑…）直接用库里的准备/释放时间与华丽效果；
    // 库里没有的（角色卡自定义法术）→ 自动入库（带华丽描述），下次同名直接调用。
    let eff = effectOf(sp);
    if (MOVES) {
      const lib = MOVES.get(sp.zh) || MOVES.register({
        zh: sp.zh, category: "法术", weapons: [], tiers: [f.prof.tier, f.prof.tier],
        arc: 26, band: "mid", tags: ["术法", "远程"],
        effect: (sp.effect || eff.hit || ""), source: "auto",
        timing: { charge: [0.6, 1.8], active: [0.05, 0.10], recover: [0.20, 0.36] },
        range: [2.5, Math.max(6, sp.reach || 8)]
      });
      if (lib && lib.source === "auto" && lib.zh === sp.zh) { _libState.added++; _libState.dirty = true; }
      if (lib) {
        eff = Object.assign({}, eff, {
          zh: lib.zh, prep: lib.prep, fire: lib.act, hit: lib.effect,
          charge: lib.timing.charge, release: lib.timing.recover, radius: eff.radius
        });
      }
    }
    const cRange0 = scaledRange(eff.charge, f.prof.tier, f.qi);
    // 长蓄力（>1.8 秒）只在自己有空间时用：贴身时压缩成速发版本，否则必然被打断
    const opp0 = f === sim.A ? sim.B : sim.A;
    const gap = Math.hypot(opp0.x - f.x, opp0.y - f.y);
    const cRange = (cRange0[1] > 1.8 && gap < 3.5) ? [Math.min(cRange0[0], 0.8), 1.2] : cRange0;
    f.castDur = pickInRange(sim, cRange);
    f.castQuick = cRange !== cRange0;
    f.castEff = eff; f.castRange = cRange;
    f.state = "cast"; f.castT = 0; f.castSpell = sp;
    f.vx *= 0.35; f.vy *= 0.35;              // 起手站定（给了对手抢近身的机会）
    f.stats.spellCasts++;
    const opp = f === sim.A ? sim.B : sim.A;
    sim.events.push({ t: +sim.t.toFixed(3), type: "spell_cast", who: f.id, tech: sp.zh, key: "spell",
                      x: +f.x.toFixed(3), y: +f.y.toFixed(3), z: +f.z.toFixed(3),
                      dist: +Math.hypot(opp.x - f.x, opp.y - f.y).toFixed(2), reach: sp.reach,
                      chargeRange: cRange, chargeT: f.castDur, shape: eff.shape, track: !!eff.track,
                      prep: eff.prep, effect: eff.fire, radius: eff.radius,
                      move: { zh: eff.zh || sp.zh, prep: eff.prep, act: eff.fire, effect: eff.hit,
                              timing: { charge: cRange, active: [0.05, 0.10], recover: eff.release || [0.2, 0.36] },
                              range: eff.range || null, arc: 26, band: "mid",
                              source: (MOVES && MOVES.get(sp.zh)) ? MOVES.get(sp.zh).source : "auto" } });
    return true;
  }
  function releaseSpell(sim, f, sp) {
    const opp = f === sim.A ? sim.B : sim.A;
    const eff = f.castEff || effectOf(sp);
    const rRange0 = scaledRange(eff.release, f.prof.tier, f.qi);
    const flyT = pickInRange(sim, rRange0);                 // 释放（脱手→命中/消散）时间
    const d0 = Math.hypot(opp.x - f.x, opp.y - f.y) || 1;
    // 由"释放时间"反推速度，但保底 12 m/s：慢速直线弹会飞空，快慢由招式本身决定
    const spd = Math.max(12, Math.min(40, d0 / Math.max(0.2, flyT)));
    const actualFly = +(d0 / spd).toFixed(2);           // 实际飞行时间（≤ 意图时间）
    const d = d0;
    const lead = Math.min(0.5, d / spd);                       // 少量预判提前量
    const a = Math.atan2((opp.y + opp.vy * lead) - f.y, (opp.x + opp.vx * lead) - f.x);
    const id = "S" + (++sim.shotSeq);
    const track = !!eff.track;
    sim.shots.push({ id, owner: f.id, sp, dmg: sp.damage, spd, eff,
      x: f.x + Math.cos(a) * 0.45, y: f.y + Math.sin(a) * 0.45, z: f.z + 1.15,
      vx: Math.cos(a) * spd, vy: Math.sin(a) * spd,
      life: +(actualFly + 0.55).toFixed(2), flyT: flyT, actualFly: actualFly, track: track, turn: eff.turn || 0.8 });
    sim.events.push({ t: +sim.t.toFixed(3), type: "spell_release", who: f.id, tech: sp.zh, shot: id,
                      x: +f.x.toFixed(3), y: +f.y.toFixed(3), z: +(f.z + 1.15).toFixed(3), spd: +spd.toFixed(1), dist: +d.toFixed(2),
                      releaseRange: rRange0, releaseT: flyT, actualFly: actualFly, shape: eff.shape, track: track, fire: eff.fire, radius: eff.radius });
  }

  // ── AI：效用决策（12Hz）+ 逐帧转向 ───────────────────────────────────
  function decide(sim, f, opp, rng) {
    const s = f.style, dist = Math.hypot(opp.x - f.x, opp.y - f.y);
    const pref = Math.min(f.reach * (f.rules.close ? 0.65 : f.rules.keepDist ? 1.05 : 0.92), f.reach * 1.05);          // 理想出手距离
    const aggro = s.aggr * (1 + (f.hpMax - f.hp) / f.hpMax * 0.35); // 越掉血越凶
    const late = sim.t > 20 ? 1 : 0;                                 // 久战：不再磨时间
    // 久战脱力：20 秒后双方的闪避与格挡效率一起下滑（武侠里的"力竭"），
    // 否则两名高防守风格的角色会互相闪到时间结束、谁都打不死谁。
    const fatigue = sim.t > 20 ? Math.max(0.45, 1 - (sim.t - 20) * 0.055) : 1;
    const sa = (sim.scen && sim.scen.ai) || { move: 0, def: 0, atk: 0 };   // 情景权重（对齐旧内核 SCEN_AI）
    // ── 出手预判（治"对着空气挥舞"）─────────────────────────────────────
    // 决策是 12Hz 的：从这个 tick 到判定帧还要经过起手(w)+判定(a)，高手在这段时间里能跑掉
    // 1~3 米。所以"现在够得着"不等于"打得到"——按对手当前速度预判到判定帧的位置再决定。
    const swingT = ((f.wpn.w + f.wpn.a) * (f.tech && f.tech.slow ? f.tech.slow : 1)) / Math.max(0.2, f.prof.rate * f.speed);
    const lead = Math.min(0.5, swingT * 1.0);
    const distLead = Math.hypot((opp.x + opp.vx * lead) - f.x, (opp.y + opp.vy * lead) - f.y);
    const oppFast = Math.hypot(opp.vx - f.vx, opp.vy - f.vy) > 6;        // 用"相对速度"：一起滑行（水战）不算逃得掉
    // 地面：对手越快越只打十拿九稳的；空战：空中招自带突进（俯冲/扑击会自己拉近），放宽
    const airy = f.z > 0.3 || opp.z > 0.3;
    const strikeNow = distLead <= f.reach * (airy ? 1.6 : (oppFast ? 0.95 : 1.05));
    const swing = (reason, variant) => strikeNow
      ? { kind: "attack", variant: variant || pickVariant(f, opp, rng), reason }
      : { kind: "approach", reason: String(reason) + "-close" };
    // 对手已倒地：不再追打，稳住架势看着对手（收势）
    if (opp.state === "down") return { kind: "stand" };
    if (f.rules.blockOnly) return {kind:canBlock(opp,f)?"block":"stand"};
    // ⓪-1 来袭飞行物（法术/暗器）：必须有反应——格挡(护住·卸力) 或 侧移让开(闪躲)，不许站着挨
    if (sim.shots && sim.shots.length && f.state !== "block" && f.state !== "attack" && f.state !== "hitstun" && f.state !== "down") {
      const inc = sim.shots.find(sh => sh.owner !== f.id && sh.def !== f.id &&
        Math.hypot(sh.x - f.x, sh.y - f.y) < 7 &&
        (sh.vx * (f.x - sh.x) + sh.vy * (f.y - sh.y)) > 0);
      if (inc) {
        const spd = Math.max(0.6, Math.hypot(inc.vx, inc.vy));
        const eta = Math.hypot(inc.x - f.x, inc.y - f.y) / spd;
        if (eta < 0.55) {
          if (f.sta > 22 && rng() < 0.62) return { kind: "block", reason: "spellGuard" };
          return { kind: "dodge", dir: rng() < 0.5 ? -1 : 1, crouch: false, reason: "spellEvade" };
        }
      }
    }
    // ⓪-0 追逐战：一追一逃——追击者逼近就出手，逃跑者被逼到墙角或贴身后才回身一搏
    if (sim.chase && opp.state !== "down") {
      const edge = Math.min(f.x, f.y, sim.arena.w - f.x, sim.arena.h - f.y);
      if (sim.chase.chaser === f.id) {
        if (dist <= f.reach * 1.05) return swing("chase");
        if (dist > 3.2 && canLeap(f, sim, 30, "chase") && rng() < 0.12) return { kind: "leap", dir: "toward", reason: "chase" };
        return { kind: "approach" };
      }
      if (edge < 1.0 || dist < 1.15) {
        // 被逼到墙角/贴身：回身一搏（只在"刚刚被逼住"时记一次，不是每帧都记）
        if (!sim.chase.corneredOn) {
          sim.chase.corneredOn = true; sim.chase.cornered++;
          sim.events.push({ t: +sim.t.toFixed(3), type: "cornered", who: f.id, x: +f.x.toFixed(3), y: +f.y.toFixed(3), z: +f.z.toFixed(3) });
        }
        const rr = rng();
        if (rr < 0.6) return swing("cornered");
        return rr < 0.8 ? { kind: "dodge", dir: rng() < 0.5 ? -1 : 1, crouch: rng() < 0.3 } : { kind: "block" };
      }
      sim.chase.corneredOn = false;
      // 逃跑不能无限（v0.5）：① 跑了 6 秒以上 ② 时间过 22 秒 ③ 气力见底 —— 三者任一就转身应战。
      // 身法是有目的的（脱离/换位），不是拿来拖时间的；否则会出现"追满 30 秒还在跑"的无效战斗。
      const fleeT = sim.t - (f.fleeStartT != null ? f.fleeStartT : (f.fleeStartT = sim.t));
      const mustFight = fleeT > 6 || sim.t > 22 || f.sta < 34;
      if (mustFight) {
        if (!sim.chase.turnOn) {
          sim.chase.turnOn = true;
          sim.events.push({ t: +sim.t.toFixed(3), type: "turn_and_fight", who: f.id, reason: fleeT > 6 ? "跑够了" : (sim.t > 22 ? "时间压上" : "气力见底") });
        }
        const rr = rng();
        if (rr < 0.62) return swing("turnfight");
        return rr < 0.82 ? { kind: "dodge", dir: rng() < 0.5 ? -1 : 1, crouch: rng() < 0.3 } : { kind: "block" };
      }
      return { kind: "flee" };
    }
    // ②-b 远程法术/内力外放：够得着就隔空放（角色卡「法术」组；卡里没配时由 pipeline 按等级自动补）
    //   节奏限制：有出手间隔与每场上限——否则高等级会变成"站着对轰"，武打就没了。
    if (f.spells && f.spells.length && f.state !== "cast") {
      const gap = Math.max(1.2, 2.6 - (f.tier || 1) * 0.12);
      const maxCasts = 2 + Math.round((f.tier || 1) * 0.6);
      const sinceCast = sim.t - (f.lastCastT == null ? -9 : f.lastCastT);
      if (f.stats.spellCasts < maxCasts && sinceCast >= gap) {
        const ready = f.spells.filter(sp => (f.spellCd[sp.id] || 0) <= sim.t && f.sta > 14 + (sp.damage || 20) * 0.35);
        // 高等级不再"必须够不着才隔空打"：罡气级以上贴身也能放，近身下限随等级下探
        const minR = (f.qi && f.qi.burst >= 1.0) ? 0.8 : 1.6;
        const inR = ready.filter(sp => dist <= sp.reach && dist >= Math.min(minR, sp.reach * 0.35));
        if (inR.length) {
          // 明显在兵刃射程外 → 一定隔空打；贴身时只有小概率放（贴身主要靠气劲外放，不靠弹道）
          const outOfReach = dist > f.reach * 1.6;
          const chance = 0.08 + (f.qi ? f.qi.castBonus : 0);
          if (outOfReach || rng() < chance) return { kind: "cast", spell: inR[0], reason: "spell" };
        }
      }
    }
    // ⓪-a 自己在空中：只出空中招（且必须真的够得着），否则维持高度/落点
    if (f.z > 0.4) {
      // 空战也要预判：两个飞行档交手时对手一帧能挪十几厘米，不预判就是对着空气扑
      const predAir = { z: Math.max(0, opp.z + (opp.vz || 0) * lead), post: opp.post, state: opp.state };
      if (f.airAtkLeft > 0 && distLead <= f.reach * 1.35 + 0.40) {
        const v = pickAirVariant(f, opp, rng);
        if (bandOverlap(atkBand(f, v), defSpan(predAir))) return { kind: "attack", variant: v, reason: "air" };
      }
      // 悬空太久没出手（谁都不许靠滞空拖时间）→ 直接俯冲压下来打
      const idleAir = sim.t - (f.lastAtkT || 0);
      if (f.airAtkLeft > 0 && idleAir > (opp.z < 0.5 ? 0.6 : 2.2 + s.patience * 1.6)) return { kind: "attack", variant: AIR_VARIANTS[3], reason: "airDive" };
      return { kind: "hover", reason: "air" };
    }
    // ⓪-b 对手在空中：够得着就用地面招打下来，明显够不着才迎空拦截或让开等落地
    //    （门槛设 1.2 米：低空弹跳不该触发"对跳"，否则两名轻功档会互相跳满 30 秒）
    if (opp.z > 0.5) {
      const v = (rng() < 0.5 ? VARIANTS[1] : VARIANTS[3]);
      if (bandOverlap(atkBand(f, v), defSpan(opp)) && dist <= f.reach * 1.1) return { kind: "attack", variant: v, reason: "antiAir" };
      if (opp.z > 1.2 && canLeap(f, sim, 34, "antiAir") && rng() < 0.16 + (f.mob.airAtk >= 2 ? 0.12 : 0)) return { kind: "leap", dir: "up", reason: "antiAir" };
      // 够不到就别在原地挥空：跑到"对手的落点"等落地（这才是高手打法，也不会像在表演）
      const tFall = Math.max(0.25, Math.sqrt(2 * Math.max(0.2, opp.z) / G_Z));
      return { kind: "intercept", x: opp.x + opp.vx * tFall, y: opp.y + opp.vy * tFall, reason: "antiAir" };
    }
    // ⓪ 僵持破局：太久没出手（双方都在绕圈子）就主动压上去
    //    决胜期（22 秒后）把"等一拍"的耐心砍掉一半，避免两名防守型角色磨到时间结束
    const impatience = (2.6 + s.patience * 2.2) * (sim.t > 22 ? 0.55 : 1);
    if (sim.t - (f.lastAtkT || 0) > impatience) {
      if (dist <= f.reach * 1.25) return swing("impatient");
      return { kind: "approach" };
    }
    // ① 体力见底 → 拉开回气
    if (f.sta < 22 && !s.ruthless) return { kind: "recover" };
    // ② 对手在攻击：按反应延迟决定"挡/闪/对拼/反打"
    if (opp.state === "attack" && opp.phase !== "recovery") {
      const seenLong = (sim.t - opp.atkStart) >= f.prof.react;
      if (seenLong) {
        // 阵地战/追逐战：身边有掩体就退到掩体后面（借掩体＝让对方的兵器线路被挡住）
        if (sim.scen.cover && sim.props.length && rng() < 0.5) {
          const pr = nearProp(sim, f, 2.2);
          if (pr) return { kind: "cover", prop: pr.id, reason: "cover" };
        }
        const heavy = opp.tech && (opp.tech.key === "heavy" || opp.tech.finisher);
        const canB = canBlock(opp, f);
        const rB = ((heavy ? s.block * 0.55 : s.block) + (canB ? 0 : -1.2)) * fatigue;
        const rD = (s.dodge * (heavy ? 1.35 : 1.0) + (canB ? 0 : 0.9)) * fatigue;
        const rC = (s.aggr > 0.6 && dist <= pref && f.sta > 30 && opp.tech && opp.tech.arc > 90) ? s.aggr * 0.45 : 0;
        const tot = Math.max(0.001, rB + rD + rC), r = rng() * tot;
        if (r < rC) return { kind: "attack", variant: pickVariant(f, opp, rng), reason: "clash" };
        if (r < rC + rD) return { kind: "dodge", dir: rng() < 0.5 ? -1 : 1, crouch: rng() < 0.35 };
        if (r < rC + rD + rB) return { kind: "block" };
      }
      return { kind: "guardSpace" };
    }
    // ③ 对手硬直中 → 抓机会
    if (opp.state === "hitstun" || opp.state === "stagger") {
      if (dist <= pref * 1.15) return swing("punish");
      return { kind: "approach" };
    }
    // ④ 对手收招空挡 → 反打（whiff punish）
    if (opp.state === "attack" && opp.phase === "recovery" && dist <= pref * 1.1) {
      if (rng() < 0.55 + 0.4 * s.counter) return swing("whiff");
    }
    // ⑤ 身处对方威胁距离：格斗常识是"默认举械架势"，而不是站着等反应
    //    （真人靠预判抬架，只有重击/大招才来得及看见反应；性格决定举架比例）
    const threat = dist <= opp.reach * 1.18 + 0.22;
    if (threat && opp.state !== "down") {
      const r = rng();
      const guardP = clamp(s.block * (late ? 0.28 : 0.72) * fatigue + sa.def, 0, 1);            // 久战不再一味举架；水战/阵地战更常守
      const readP = clamp(s.dodge * (late ? 0.10 : 0.26) * fatigue + sa.def * 0.6, 0, 1);       // 预判式闪身（疾风/游走型读招，不靠反应）
      if (r < guardP) return { kind: "block" };
      if (r < guardP + readP) return { kind: "dodge", dir: rng() < 0.5 ? -1 : 1, crouch: rng() < 0.3 };
      const closeIn = dist < f.reach * 0.95;                                    // 已经贴上了，就别再绕圈
      const spaceP = (late ? 0.08 : 0.20) * (closeIn ? 0.35 : 1) + sa.move * 0.25 * (closeIn ? 0.5 : 1);
      if (r < guardP + readP + spaceP) return { kind: "space", dir: rng() < 0.5 ? -1 : 1 };   // 追逐战/水战多走位
      return swing("open");
    }
    // ⑥ 对手格挡 → 崩防或绕侧
    if (opp.state === "block" && dist <= pref) {
      const r = rng();
      if (r < 0.45 + 0.35 * s.aggr) return swing("guardbreak", VARIANTS[5]);
      if (r < 0.8) return { kind: "flank", dir: rng() < 0.5 ? -1 : 1 };
      return { kind: "guardSpace" };
    }
    // ⑥-b 对手借掩体：把掩体砸碎（"撞碎道具"必须真的发生，而不是只写在提示词里）
    if (sim.scen.cover && sim.props.length) {
      const pr = sim.props.find(p => !p.broken && G.ptSeg(p.x, p.y, f.x, f.y, opp.x, opp.y) <= p.r);
      if (pr) {
        const pd = Math.hypot(pr.x - f.x, pr.y - f.y);
        if (pd <= f.reach * 1.15) return { kind: "attack", variant: (pr.tough >= 2 ? VARIANTS[5] : pickVariant(f, opp, rng)), reason: "smashCover" };
        return { kind: "approach" };                       // 先贴到掩体边再砸
      }
    }
    // ⑦ 距离控制（还没进入威胁距离）
    if (dist > pref * 1.06) {
      // 阵地战/追逐战：主动靠掩体占位（"借掩体"要真的走到掩体后面，而不是只在被攻击时才想）
      if (sim.scen.cover && sim.props.length && rng() < 0.35) {
        const pr = nearProp(sim, f, 4.0);
        if (pr) return { kind: "cover", prop: pr.id, reason: "coverAdvance" };
      }
      // 5 级以上：借墙游走——中距离的招牌花活（**有次数上限**，否则会变成"贴墙代步"、30 秒打不完）
      if (f.mob.wall && sim.t < 24 && f.wallCd <= sim.t && f.seekCd <= sim.t && f.wallSeeks < 4 && canLeap(f, sim, 26, "reposition") &&
          dist > Math.max(f.reach * 1.6, 2.2) && rng() < 0.16 + 0.02 * f.prof.tier) {
        const nw = nearestWall(sim.arena, f);
        if (nw.dist > 1.1 && nw.dist < 16.0) {
          f.route = { axis: nw.axis, until: sim.t + 3.0 }; f.wallSeeks++;     // 承诺：这段时间就是"贴墙游走"，别半路改主意
          return { kind: "wallseek", wall: nw.axis, reason: "wallrun" };
        }
      }
      // 轻功突进：拉开得够远时腾跃切入（等级越高越常跳，但没体力只能小跑）
      if (dist > pref * 1.7 && sim.t < 24 && canLeap(f, sim, 32, "close") && rng() < 0.03 + 0.012 * f.prof.tier) return { kind: "leap", dir: "toward", reason: "close" };
      // 7 级以上真飞行：主动升空，从上方压迫再俯冲（气力要够，避免反复起落空转）
      if (sim.t < 24 && f.mob.flight && f.sta > 70 && f.airCd <= sim.t && canLeap(f, sim, 40, "attack") && rng() < (f.leaps === 0 && sim.t > 0.5 ? 0.85 : 0.035 + 0.008 * (f.prof.tier - 7) + (f.style.aggr > 0.7 ? 0.02 : 0))) return { kind: "takeoff", reason: "aerialPress" };
      return { kind: "approach" };
    }
    if (dist < f.reach * 0.52) return { kind: "space", dir: rng() < 0.5 ? -1 : 1 };
    // ⑧ 在射程内 → 出手（性格越凶越急，耐心型会多等一拍；决胜期一律加压）
    const wantAttack = clamp(aggro * (0.55 + 0.45 * (1 - s.patience)) + (f.hp < f.hpMax * 0.3 ? 0.2 : 0) + (sim.t > 22 ? 0.30 : 0) + sa.atk * 1.6, 0, 1);
    if (rng() < wantAttack) return swing("inrange");
    return { kind: "space", dir: rng() < 0.5 ? -1 : 1 };
  }

  function steer(sim, f, opp, dt, rng) {
    const it = f.intent, s = f.style;
    // 动作目的记账：同一个决策只记一次（f.intent 换成新对象就记一条）
    if (it && it.kind && it._logged !== it) { recordPurpose(f, sim, it); it._logged = it; }
    const toOpp = Math.atan2(opp.y - f.y, opp.x - f.x);
    const dist = Math.hypot(opp.x - f.x, opp.y - f.y);
    const faceRate = f.prof.turn * dt;
    // 场地越大越要靠"赶路"：小场地不加速（保持原手感），大场地按尺寸放大步伐（含轻功突进）
    const dash = clamp(Math.min(sim.arena.w, sim.arena.h) / 12, 1, 1.7);
    const lock = f.state === "attack" || f.state === "dodge" || f.state === "hitstun" || f.state === "stagger" || f.state === "down" || f.state === "land";
    // 转身：非锁定状态朝对手（判定帧锁定朝向，所以"打空后要重新转身"的代价仍然保留）
    if (!lock) {
      const d = norm(toOpp - f.face);
      f.face += clamp(d, -faceRate, faceRate);
    }
    const spd = (3.2 * f.prof.speed * f.speed);
    const act = () => { if (f.state === "idle" || f.state === "move") f.state = "move"; };
    switch (it.kind) {
      case "approach": {
        // 借墙游走的承诺期：朝对手推进时保持一个朝墙的分量，走到墙边就贴墙起跳
        if (f.route && sim.t < f.route.until) {
          const nw = nearestWall(sim.arena, f);
          if (nw.dist <= 1.35) {
            const t2 = [-nw.dir[1], nw.dir[0]];
            const sgn = ((t2[0] * (opp.x - f.x) + t2[1] * (opp.y - f.y)) >= 0) ? 1 : -1;
            if (canLeap(f, sim, 26, "reposition")) {
              f.vz = jumpV(jumpPeakFor(f, sim, "reposition"));
              f.airAtkLeft = f.mob.airAtk; f.airAtkTimer = 0.9; f.airHold = 0;
              f.airCd = sim.t + 1.1; f.seekCd = sim.t + 3.0; f.mustLand = false;
              f.sta = Math.max(0, f.sta - 14); f.stats.takeoffs++; f.leaps++; f.lastLeapT = sim.t; f.airIdleT = 0;
              f.vx += t2[0] * sgn * 3.6 * dash + nw.dir[0] * 1.1;
              f.vy += t2[1] * sgn * 3.6 * dash + nw.dir[1] * 1.1;
              f.state = "move";
              sim.events.push({ t: +sim.t.toFixed(3), type: "takeoff", who: f.id, x: +f.x.toFixed(3), y: +f.y.toFixed(3),
                                z: 0, peak: +jumpPeakFor(f, sim, "reposition").toFixed(2), dir: "wall", why: "reposition", peakZh: jumpPeakZh("reposition", jumpPeakFor(f, sim, "reposition"), opp, sim, f), mob: f.mob.key });
              break;
            }
          }
          const bx = Math.cos(toOpp) * 0.55 + nw.dir[0] * 0.45, by = Math.sin(toOpp) * 0.55 + nw.dir[1] * 0.45;
          const bl = Math.hypot(bx, by) || 1;
          f.vx += (bx / bl) * spd * 6 * dash * dt; f.vy += (by / bl) * spd * 6 * dash * dt; act(); break;
        }
        f.vx += Math.cos(toOpp) * spd * 6 * dash * dt; f.vy += Math.sin(toOpp) * spd * 6 * dash * dt; act(); break;
      }
      case "space": case "flank": {
        const side = (it.kind === "flank" ? it.dir : -it.dir);
        const a = toOpp + side * Math.PI / 2;
        f.vx += Math.cos(a) * spd * 5.2 * dt; f.vy += Math.sin(a) * spd * 5.2 * dt;
        if (dist > f.reach * 0.95) { f.vx += Math.cos(toOpp) * spd * 2 * dt; f.vy += Math.sin(toOpp) * spd * 2 * dt; }
        act(); break;
      }
      case "guardSpace": {
        // 保持防守距离：面向对手慢慢退
        const a = toOpp + Math.PI;
        f.vx += Math.cos(a) * spd * 2.4 * dt; f.vy += Math.sin(a) * spd * 2.4 * dt;
        f.state = f.state === "block" ? "block" : "move"; break;
      }
      case "recover": {
        const a = toOpp + Math.PI;
        f.vx += Math.cos(a) * spd * 4.4 * dt; f.vy += Math.sin(a) * spd * 4.4 * dt;
        f.state = "move"; break;
      }
      case "dodge": {
        if(f.rules.noDodge) break;
        const a = toOpp + (it.dir || 1) * Math.PI / 2 + (rng() < 0.25 ? Math.PI : 0);
        const v = 6.4 * f.prof.speed;
        f.vx = Math.cos(a) * v; f.vy = Math.sin(a) * v;
        f.state = "dodge"; f.hitstun = Math.max(f.hitstun, 0.34);
        f.post = it.crouch ? "crouch" : "stand";
        f.sta = Math.max(0, f.sta - 12);
        f.stats.dodges++;
        sim.events.push({ t: +sim.t.toFixed(3), type: "dodge", who: f.id, x:+f.x.toFixed(3), y:+f.y.toFixed(3), crouch: !!it.crouch });
        break;
      }
      case "block": {
        if(!canBlock(opp,f)) break;
        f.state = "block"; f.blockHold = 0.3; break;
      }
      case "cast": {
        startCast(sim, f, it.spell); break;
      }
      case "attack": {
        startAttack(sim, f, it.variant || VARIANTS[0]); break;
      }
      case "leap": {
        // 起跳：斜向突进（toward）/ 原地上跃迎空（up）/ 后跃脱身（away）
        if (f.z > 0.05 || !canLeap(f, sim, 24, it.reason === "antiAir" ? "antiAir" : (it.dir === "away" ? "evade" : "close"))) break;
        const _why = f.leapWhy || (it.reason === "antiAir" ? "antiAir" : (it.dir === "away" ? "evade" : "close"));
        const peak = jumpPeakFor(f, sim, _why, it);
        f.vz = jumpV(peak);
        f.airAtkLeft = f.mob.airAtk;
        f.airAtkTimer = 0.9;
        f.airHold = 0;
        f.airCd = sim.t + 1.1;
        f.mustLand = false;
        f.sta = Math.max(0, f.sta - (10 + f.mob.jump * 2.2));
        f.stats.takeoffs++; f.leaps++; f.lastLeapT = sim.t; f.airIdleT = 0;
        f.state = "move";
        if (it.dir !== "up") {
          const a = it.dir === "away" ? toOpp + Math.PI : toOpp;
          const burst = (3.0 + f.mob.dash * 1.5) * dash;
          f.vx += Math.cos(a) * burst; f.vy += Math.sin(a) * burst;
        }
        sim.events.push({ t: +sim.t.toFixed(3), type: "takeoff", who: f.id, x: +f.x.toFixed(3), y: +f.y.toFixed(3),
                          z: 0, peak: +peak.toFixed(2), dir: it.dir || "toward", why: _why, peakZh: jumpPeakZh(_why, peak, opp, sim, f), mob: f.mob.key });
        break;
      }
      case "takeoff": {
        // 真飞行档：直接升到悬停高度，从上方压迫
        if (f.z > 0.05 || !f.mob.flight || !canLeap(f, sim, 40, "attack")) break;
        f.vz = jumpV(hoverAltFor(f, sim));
        f.airAtkLeft = f.mob.airAtk;
        f.airAtkTimer = 0.9;
        f.airHold = 0;
        f.airCd = sim.t + 0.9;
        f.mustLand = false;
        f.stats.takeoffs++; f.leaps++; f.lastLeapT = sim.t; f.airIdleT = 0;
        f.state = "move";
        sim.events.push({ t: +sim.t.toFixed(3), type: "takeoff", who: f.id, x: +f.x.toFixed(3), y: +f.y.toFixed(3),
                          z: 0, peak: +hoverAltFor(f, sim).toFixed(2), dir: "hover", why: "attack", peakZh: "升空至 " + hoverAltFor(f, sim).toFixed(1) + " 米（空中压迫）", mob: f.mob.key });
        break;
      }
      case "hover": {
        // 滞空：水平贴向对手（高度由积分里的悬停逻辑维持，掉高由体力与滞空上限决定）
        // 越近推得越轻，否则高速档会冲过头来回震荡
        const p = Math.min(f.mob.flight ? spd * 2.6 : spd * 1.4, Math.max(0, dist - 0.8) * 2.2);
        f.vx += Math.cos(toOpp) * p * dt; f.vy += Math.sin(toOpp) * p * dt;
        if (f.state === "idle" || f.state === "move") f.state = "move";
        break;
      }
      case "wallseek": {
        // 借墙突进：先跑到墙边，再沿墙切线起跳——随后由积分里的"飞檐走壁"接管（贴墙跑→蹬墙翻身）
        const nw = nearestWall(sim.arena, f);
        if (f.z > 0.05) { act(); break; }                       // 已经在空中，交给贴墙逻辑
        if (nw.dist > 1.25) {
          f.vx += nw.dir[0] * spd * 6.5 * dash * dt;
          f.vy += nw.dir[1] * spd * 6.5 * dash * dt;
          act();
        } else if (canLeap(f, sim, 28, "reposition")) {
          const t = [-nw.dir[1], nw.dir[0]];                    // 墙的切线方向
          const sgn = ((t[0] * (opp.x - f.x) + t[1] * (opp.y - f.y)) >= 0) ? 1 : -1;
          f.vz = jumpV(jumpPeakFor(f, sim, "reposition"));
          f.airAtkLeft = f.mob.airAtk; f.airAtkTimer = 0.9; f.airHold = 0;
          f.airCd = sim.t + 1.1; f.seekCd = sim.t + 2.2; f.mustLand = false;
          f.sta = Math.max(0, f.sta - 14);
          f.stats.takeoffs++; f.leaps++; f.lastLeapT = sim.t; f.airIdleT = 0;
          f.vx += t[0] * sgn * 3.6 * dash + nw.dir[0] * 1.1;
          f.vy += t[1] * sgn * 3.6 * dash + nw.dir[1] * 1.1;
          f.state = "move";
          sim.events.push({ t: +sim.t.toFixed(3), type: "takeoff", who: f.id, x: +f.x.toFixed(3), y: +f.y.toFixed(3),
                            z: 0, peak: +(f.mob.jump * 0.8).toFixed(2), dir: "wall", why: "reposition", why: "reposition", peakZh: jumpPeakZh("reposition", f.peakZ || 0, opp, sim, f), mob: f.mob.key });
        } else act();
        break;
      }
      case "cover": {
        // 退到掩体背对对手的一侧（掩体是实体，真的会挡掉对方的兵器线路）
        const pr = sim.props.find(p => p.id === it.prop && !p.broken) || nearProp(sim, f, 3.0);
        if (!pr) { f.vx += Math.cos(toOpp + Math.PI) * spd * 3 * dt; f.vy += Math.sin(toOpp + Math.PI) * spd * 3 * dt; act(); break; }
        const away = Math.atan2(pr.y - opp.y, pr.x - opp.x);
        const tx = pr.x + Math.cos(away) * (pr.r + CAP_R + 0.06);
        const ty = pr.y + Math.sin(away) * (pr.r + CAP_R + 0.06);
        const ta = Math.atan2(ty - f.y, tx - f.x);
        const dd = Math.hypot(tx - f.x, ty - f.y);
        if (dd > 0.15) {                                   // 还没到掩体后面就继续走，到了就守住位置
          f.vx += Math.cos(ta) * spd * 5.2 * dt; f.vy += Math.sin(ta) * spd * 5.2 * dt;
          act();
        } else if (f.state === "idle" || f.state === "move") f.state = "idle";
        break;
      }
      case "intercept": {
        // 跑到对手的预判落点下方等落地（落地瞬间再打），而不是对着空中挥空
        const tx = it.x == null ? opp.x : it.x, ty = it.y == null ? opp.y : it.y;
        const ta = Math.atan2(ty - f.y, tx - f.x);
        const td = Math.hypot(tx - f.x, ty - f.y);
        if (td > 0.35) { f.vx += Math.cos(ta) * spd * 6.2 * dash * dt; f.vy += Math.sin(ta) * spd * 6.2 * dash * dt; act(); }
        else if (f.state === "idle" || f.state === "move") f.state = "idle";
        break;
      }
      case "flee": {
        // 逃跑者：背离对手沿长街跑；贴边时沿切线滑走（不撞墙、不自己送死角）。
        // 逃命也要气力：气足时能甩开追击者，跑久了脚下发软 → 被追上 → 回身一搏，如此往复。
        const sprint = f.sta > 30 ? 1 : 0.6;
        f.sta = Math.max(0, f.sta - 9 * dt);
        const a = toOpp + Math.PI;
        f.vx += Math.cos(a) * spd * 9.0 * sprint * dt; f.vy += Math.sin(a) * spd * 9.0 * sprint * dt;
        const m = 1.3;
        if (f.x < m || f.x > sim.arena.w - m) f.vy += Math.sign(sim.arena.h * 0.5 - f.y) * spd * 5.5 * dt;
        act(); break;
      }
      case "stand": {
        // 收势：原地稳住、面向对手（不追打倒地者）
        f.vx *= 0.9; f.vy *= 0.9;
        if (f.state !== "block") f.state = "idle";
        break;
      }
      default: break;
    }
    // 不许贴着墙磨：非借墙状态下离墙太近就往里让开（否则观感像"自己撞墙"）
    if (!(f.wallT > 0) && !(f.route && sim.t < f.route.until)) {
      const nw = nearestWall(sim.arena, f);
      if (nw.dist < 1.5) {
        const push = spd * 6.5 * dt;
        f.vx -= nw.dir[0] * push; f.vy -= nw.dir[1] * push;
      }
    }
    // 擂台：靠近台边就往回拉（"退到边缘即为险境"必须双方都感觉得到）
    if (sim.ring) {
      const dx = f.x - sim.ring.cx, dy = f.y - sim.ring.cy, d = Math.hypot(dx, dy);
      if (d > sim.ring.r - 1.2 && d > 1e-6) {
        const pull = spd * 6.0 * dt;
        f.vx -= (dx / d) * pull; f.vy -= (dy / d) * pull;
      }
    }
  }

  // ── 落地：冲击反馈 + 落地硬直 + 高阶的落地冲击波 ──────────────────────
  // ── 动作时间账（v0.6）───────────────────────────────────────────────
  //   任何动作都不是瞬发即消失。这里用"状态分段"记账：
  //   每一帧看角色的 状态/阶段/是否离地，一旦变化就结算上一段（t0→t1、时长、标签），
  //   于是"格挡 0.30 秒""硬直 0.42 秒""滞空 1.8 秒""收招 0.22 秒"都是算出来的。
  const SEG_LABEL = { idle: "待机", move: "走位", attack: "出招", block: "格挡", dodge: "闪避",
    hitstun: "受击硬直", stagger: "踉跄", down: "倒地", cast: "施法", land: "落地" };
  const PHASE_LABEL = { windup: "起手", active: "有效", recovery: "收招" };
  function segKey(f) {
    const z = f.z > 0.25 ? "air" : "";
    if (f.state === "attack" && f.tech) return "attack:" + (f.tech.key || f.tech.zh) + ":" + (f.phase || "");
    return f.state + (z ? ":air" : "");
  }
  function segLabel(f) {
    if (f.state === "attack" && f.tech) {
      const ph = PHASE_LABEL[f.phase] || "";
      return (f.tech.zh || "出招") + (ph ? "·" + ph : "");
    }
    const base = SEG_LABEL[f.state] || f.state;
    return f.z > 0.25 ? base + "·空中" : base;
  }
  function trackSegment(sim, f) {
    if (!f.seg) f.seg = { key: null, t0: sim.t, label: "", phase: null };
    const key = segKey(f);
    if (key === f.seg.key) return;                       // 同段继续
    if (f.seg.key !== null) {                            // 结算上一段
      const dur = +(sim.t - f.seg.t0).toFixed(3);
      if (dur >= 0.016) {
        sim.timeline.push({ who: f.id, t0: +f.seg.t0.toFixed(3), t1: +sim.t.toFixed(3), dur: dur,
                            kind: f.seg.key, label: f.seg.label, phase: f.seg.phase,
                            airborne: /:air$/.test(f.seg.key) });
        sim.timing.actions++;
        sim.timing.actionTime += dur;
        if (dur > sim.timing.longest) sim.timing.longest = dur;
      }
    }
    f.seg = { key: key, t0: sim.t, label: segLabel(f), phase: f.state === "attack" ? (PHASE_LABEL[f.phase] || null) : null };
  }
  function closeSegments(sim) {
    [sim.A, sim.B].forEach(f => {
      if (f && f.seg && f.seg.key !== null) {
        const dur = +(sim.t - f.seg.t0).toFixed(3);
        if (dur >= 0.016) sim.timeline.push({ who: f.id, t0: +f.seg.t0.toFixed(3), t1: +sim.t.toFixed(3), dur: dur,
          kind: f.seg.key, label: f.seg.label, phase: f.seg.phase, airborne: /:air$/.test(f.seg.key) });
      }
    });
  }

  function land(sim, f, impact) {
    const hard = impact > 3.2;
    f.stats.lands++;
    f.airHold = 0; f.airAtkLeft = 0; f.airAtkTimer = 0;
    f.wallT = 0; f.wasHover = false;
    // 落地不打断正在出的招（俯冲命中落地也算数），只给落地屈膝与硬直；否则会出现姿态硬切
    const busy = f.state === "attack" || f.state === "dodge" || f.state === "cast";
    if (f.state !== "down" && !busy) { f.state = hard ? "land" : f.state; f.landLock = hard ? 0.22 : 0.10; }
    else if (busy && hard) f.landLock = Math.max(f.landLock, 0.16);
    f.post = "stand";
    sim.events.push({ t: +sim.t.toFixed(3), type: "landing", who: f.id, x: +f.x.toFixed(3), y: +f.y.toFixed(3),
                      z: 0, impact: +impact.toFixed(2), from: +f.peakZ.toFixed(2), hard, water: sim.scen.water > 0 });
    // 落地冲击波：7 级以上真飞行档，从高处砸下来会把对手震开
    // （带冷却：否则两飞行档会互相"砸—震—再砸"，30 秒打不出一击）
    if (f.mob.shock > 0 && impact > 4.0 && sim.t - (f.lastShock == null ? -9 : f.lastShock) > 1.6) {
      f.lastShock = sim.t;
      const opp = f === sim.A ? sim.B : sim.A;
      const d = Math.hypot(opp.x - f.x, opp.y - f.y);
      const R = f.mob.shock + Math.min(1.2, impact * 0.10);
      if (d <= R && opp.state !== "down") {
        const ux = (opp.x - f.x) / (d || 1), uy = (opp.y - f.y) / (d || 1);
        const push = (2.6 + impact * 0.35) * (f.prof.power / opp.prof.power) * 0.5;
        opp.vx += ux * push; opp.vy += uy * push;
        if (f.mob.shock >= 2.0) opp.vz = Math.max(opp.vz, 1.4);
        opp.hitstun = Math.max(opp.hitstun, 0.22); opp.state = "hitstun";
        f.stats.shocks++;
        sim.events.push({ t: +sim.t.toFixed(3), type: "landing_shock", who: f.id, who2: opp.id,
                          x: +f.x.toFixed(3), y: +f.y.toFixed(3), z: 0, r: +R.toFixed(2), impact: +impact.toFixed(2) });
      }
    }
    f.peakZ = 0;
  }

  // ── 主循环 ───────────────────────────────────────────────────────────
  function simulate(opt) {
    const o = opt || {};
    const seed = (o.seed == null ? 20260911 : o.seed) >>> 0;
    const rng = mulberry32(seed);
    const arena = o.arena || { w: 20, h: 12 };
    if(!Number.isFinite(arena.w)||!Number.isFinite(arena.h)||arena.w<2||arena.h<2) throw Error('Invalid arena');
    if(o.duration!=null&&(!Number.isFinite(o.duration)||o.duration<DT||o.duration>120)) throw Error('Duration must be between 1/60 and 120 seconds');
    const maxT = o.duration || 30;
    const A = makeFighter(Object.assign({ id: "A", rules:o.rules||{}, speed:o.speed||1, x: arena.w * 0.5 - 1.6, y: arena.h * 0.5, face: 0 }, o.A));
    const B = makeFighter(Object.assign({ id: "B", rules:o.rules||{}, speed:o.speed||1, x: arena.w * 0.5 + 1.6, y: arena.h * 0.5, face: Math.PI }, o.B));
    // 开局决策错峰：否则"先手方"永远先出手、永远被反击，同级对局会变成一边倒
    A.decideT = rng() * 0.08; B.decideT = rng() * 0.08;
    A.swingDir = rng() < 0.5 ? 1 : -1; B.swingDir = rng() < 0.5 ? 1 : -1;
    // 每名角色一条独立随机流：共用一条流会让"先抽的那一方"系统性占优
    // （同级同风格镜像对局会偏向一边）。两条流互不影响，行为才真正对称。
    A.rng = mulberry32((seed ^ 0x51ED2701) >>> 0);
    B.rng = mulberry32((seed ^ 0xB5297A4D) >>> 0);
    _libReset();                       // 招式库统计按场清零（否则跨场累计会破坏同 seed 可复现）
    const sim = { t: 0, seed, A, B, events: [], frames: o.record === false ? null : [], rng, arena, over: null, overT: 0,
                  scen: SCEN.none, props: [], ring: null, chase: null, shots: [], shotSeq: 0,
                  timeline: [],                       // 动作时间账（每段：t0→t1、时长、标签）
                  timing: { actions: 0, actionTime: 0, longest: 0 } };
    // 场地天花板：真飞行档最高能到 6.5 米，场地要装得下（默认 14 米兜底）
    const ceilZ = Number.isFinite(arena.z) && arena.z > 2 ? Math.min(AIR_MAX, arena.z) : AIR_MAX;
    // ── 情景（v0.5）：把界面声明的情景规则真的接进结算 ────────────────────
    const scen = scenario(o.scenario);
    sim.scen = scen;
    if (scen.aerial) { A.mob = aerialFloor(A.mob); B.mob = aerialFloor(B.mob); }
    // 掩体（阵地战/追逐战）：可挡兵器线路、可被撞碎
    // 布置成环绕交战区的一圈：打斗发生在场地中部，掩体必须在那里才有意义
    if (scen.obstacles > 0) {
      const kinds = ["石柱", "木箱", "断柱", "酒坛", "杂物堆"];
      const props0 = [];
      const startPts = [{ x: arena.w * 0.5 - 1.6, y: arena.h * 0.5 }, { x: arena.w * 0.5 + 1.6, y: arena.h * 0.5 }];
      for (let i = 0; i < scen.obstacles; i++) {
        const kind = kinds[i % kinds.length];
        const ang = (i / scen.obstacles) * Math.PI * 2 + rng() * 0.7;
        const rad = 2.0 + rng() * 1.3;         // 贴近交战区：太远就等于没有掩体
        let px = arena.w * 0.5 + Math.cos(ang) * rad;
        let py = arena.h * 0.5 + Math.sin(ang) * Math.min(rad, Math.max(1.2, arena.h * 0.5 - 1.0));
        // 别压在开局站位上（一开场就卡住）
        for (const sp of startPts) {
          const dx = px - sp.x, dy = py - sp.y, dd = Math.hypot(dx, dy);
          if (dd < 1.1 && dd > 1e-6) { px = sp.x + dx / dd * 1.1; py = sp.y + dy / dd * 1.1; }
        }
        px = Math.max(0.7, Math.min(arena.w - 0.7, px));
        py = Math.max(0.7, Math.min(arena.h - 0.7, py));
        props0.push({ id: "P" + (i + 1), zh: kind, x: +px.toFixed(3), y: +py.toFixed(3),
                      r: +(0.38 + rng() * 0.26).toFixed(2), tough: (kind === "石柱" || kind === "断柱") ? 2 : 1, hit: 0, broken: false });
      }
      sim.props = props0;
    }
    // 擂台边界：越界即掉台（险境），三次掉台判负
    if (scen.ring > 0) sim.ring = { cx: arena.w * 0.5, cy: arena.h * 0.5, r: Math.max(1.8, Math.min(scen.ring, Math.min(arena.w, arena.h) * 0.5 - 0.6)) };
    // 空战：双方从高空开局（沿用旧规则的 hoverZ）；各自停在自己的档位高度上（等级越高起得越高）
    if (scen.aerial) {
      const hz = Math.max(2.2, Math.min(ceilZ, ceilZ * 0.8));
      for (const f of [A, B]) {
        const z0 = Math.max(2.2, Math.min(hz, f.mob.hover));       // 凡人级踏空 2.8m、灭世级 6.4m
        f.z = z0; f.vz = 0; f.peakZ = z0; f.airAtkLeft = f.mob.airAtk; f.mustLand = false;
      }
    }
    // 追逐战：等级低的一方逃、等级高的一方追（同级按种子决定）
    // 开局就拉开到街道两端：22 米的街道上用 8~9m/s 跑，只有全长跑道才追得起来
    if (scen.chase) {
      const chaser = (A.tier !== B.tier ? (A.tier > B.tier ? "A" : "B") : (rng() < 0.5 ? "A" : "B"));
      sim.chase = { chaser, cornered: 0 };
      const C0 = chaser === "A" ? A : B, F0 = chaser === "A" ? B : A;
      C0.x = 1.6; C0.y = arena.h * 0.5; C0.face = 0;                    // 追者在一端，面朝长街
      F0.x = 6.6; F0.y = arena.h * 0.5; F0.face = 0;                    // 逃者在前方同向跑，前面留出整条跑道
    }
    const TAIL = o.tail == null ? 1.2 : o.tail;    // 终结后的余波（倒地过程 + 收势），供 3D 与提示词使用
    const fr = (v) => +v.toFixed(4);

    for (let step = 0; step < Math.round(maxT / DT); step++) {
      sim.t = step * DT;
      // 逐帧交替处理顺序：否则"后处理的一方"总是拿到对方的最新位置，
      // 会形成系统性优势（同级同风格对局会变成一边倒）
      const list = (step % 2 === 0) ? [A, B] : [B, A];
      for (const f of list) {
        const opp = f === A ? B : A;
        // 计时器
        f.hitstun = Math.max(0, f.hitstun - DT);
        f.blockHold = Math.max(0, f.blockHold - DT);
        f.landLock = Math.max(0, f.landLock - DT);
        if (f.state === "land" && f.landLock <= 0) f.state = "idle";
        // 空中招数会随时间回充：滞空不是"用完三招就干等"，而是限速的连击
        if (f.z > 0.15) {
          f.airHold += DT;
          f.airT = (f.airT || 0) + DT;                  // 每场滞空预算
          f.airIdleT = (f.airIdleT || 0) + DT;
          f.airAtkTimer -= DT;
          if (f.airAtkTimer <= 0) { f.airAtkLeft = Math.min(f.mob.airAtk, f.airAtkLeft + 1); f.airAtkTimer = 0.9; }
          // 真气有限：一次滞空有上限，到点必须落地换气（否则高等级会一直飘着拖时间）
          const holdCap = Math.min(f.mob.hoverTime > 0 ? f.mob.hoverTime : 9, 1.2 + 0.22 * (f.tier || 1));
          if (f.airHold > holdCap) f.mustLand = true;      // 单次滞空上限（等级越高越长，但都有顶）
          // 空中空转：既没有来招也在射程外 → 0.8 秒内落地（不许靠滞空表演）
          if (f.z > 0.4) {
            const _opp = (f === sim.A ? sim.B : sim.A);
            const _oppAtk = _opp.state === "attack" && (sim.t - (_opp.atkStart || 0)) < 0.45;
            const _dist = Math.hypot(_opp.x - f.x, _opp.y - f.y);
            if (_oppAtk || _dist <= f.reach * 1.45 || (_opp.z > 0.4 && _dist <= f.reach * 2.2)) f.airIdleT = 0;
            if (f.airIdleT > 0.5) f.mustLand = true;
          }
        } else {
          f.airHold = 0; f.airAtkTimer = 0;
          if (f.sta < 22) f.mustLand = true;          // 气力见底 → 收功落地
          if (f.sta > 62) f.mustLand = false;         // 回到一定气力才能再起飞
        }
        if (f.z > 0.4 && f.sta < 12) f.mustLand = true;
        if (f.state === "hitstun" || f.state === "stagger") { if (f.hitstun <= 0 && f.state === "hitstun") f.state = "idle"; if (f.hitstun <= 0 && f.state === "stagger") f.state = "idle"; }
        // ── 凌空受身：被打飞滞空时不许"悬着挨打" ──────────────────────────
        // 被抛飞后如果一直保持 hitstun，攻方在下面够不到、受击者又动不了，
        // 画面上就是"一个人在表演"。这里给受击者 0.35 秒后恢复控制权（武侠的"凌空受身"）。
        if (f.state === "hitstun" && f.z > 0.3) {
          f.airStun = (f.airStun || 0) + DT;
          if (f.airStun > 0.35) {
            f.hitstun = 0; f.state = "idle"; f.post = "air"; f.airStun = 0;
            f.stats.airRecovers = (f.stats.airRecovers || 0) + 1;
            sim.events.push({ t: +sim.t.toFixed(3), type: "air_recover", who: f.id, x: +f.x.toFixed(3), y: +f.y.toFixed(3), z: +f.z.toFixed(3) });
          }
        } else f.airStun = 0;
        if (f.state === "block" && f.blockHold <= 0) f.state = "idle";
        if (f.state === "dodge" && f.hitstun <= 0) { f.state = "idle"; f.post = "stand"; }
        // 久战升级：14 秒后出手越来越重、20 秒后双方都不再举架磨时间
        // （久战必分胜负，而不是两只"乌龟"拖到时间到）
        if (!o.rules?.lowDmg && sim.t > 12) { f.staMax = Math.max(35, 100 * f.prof.stam * (1 - (sim.t - 12) * 0.03)); f.sta = Math.min(f.sta, f.staMax); }
        if (!o.rules?.lowDmg && sim.t > 18) f.guard = Math.min(f.guard, f.guardMax * Math.max(0, 1 - (sim.t - 18) * 0.07)); // 架势会散
        f.esc = o.rules?.lowDmg ? 1 : 1 + Math.max(0, sim.t - 14) * 0.13 + Math.max(0, sim.t - 22) * 0.55;  // 伤害升级：末段进入"决胜"
        // 体力（腾空时几乎不回气：能不能一直飞由体力决定，而不是无限的）
        const regen = f.z > 0.4 ? 2 : (f.state === "block" ? 9 : (f.state === "attack" || f.state === "dodge" ? 3 : 16));
        f.sta = Math.min(f.staMax, f.sta + regen * DT * f.prof.stam);
        // 施法推进：前摇走完就放出去；中途被打断/换状态则散功
        if (f.state !== "cast") { f.castSpell = null; f.castT = 0; }
        if (f.state === "cast" && f.castSpell) {
          f.castT += DT;
          if (f.castT >= (f.castDur || SPELL_CAST)) { releaseSpell(sim, f, f.castSpell); f.state = "idle"; f.castSpell = null; f.castT = 0; f.castDur = 0; }
        }
        // 招式推进
        if (f.state === "attack" && f.tech) {
          f.techT += DT;
          const D = f.dur;
          if (f.techT < D.w) f.phase = "windup";
          else if (f.techT < D.w + D.a) {
            f.phase = "active";
            const p = (f.techT - D.w) / D.a;               // 判定帧内刀锋逐帧扫过
            f.lastBladeAng = f.bladeAng == null ? f.arcFrom : f.bladeAng;
            f.bladeAng = f.arcFrom + (f.arcTo - f.arcFrom) * Math.min(1, p);
          } else if (f.techT < D.w + D.a + D.r) f.phase = "recovery";
          else { if(!f.hasHit) { f.stats.whiffs++; sim.events.push({t:+sim.t.toFixed(3),type:'whiff',who:f.id,tech:f.tech.zh}); }
            f.state = "idle"; f.phase = ""; f.tech = null; f.bladeAng = null; }
        }
        // 倒地：记录倒下过程的时间（0→0.55s 内完成躺倒，供 3D 平滑过渡）
        if (f.state === "down") f.fallT = (f.fallT || 0) + DT;
        // 决策（12Hz）
        f.decideT -= DT;
        if (!lockCheck(f) && f.decideT <= 0) {
          f.decideT = 1 / 12 + f.rng() * 0.03;
          f.intent = decide(sim, f, opp, f.rng);
        }
        if (!lockCheck(f)) {
          if (f.state !== "block") f.state = "idle";
          steer(sim, f, opp, DT, f.rng);
        } else if (f.state === "attack" && f.phase === "windup") {
          // ── 起手追招：只允许转向、不许改意图 ──────────────────────────
          // 真实武打出手瞬间会跟着对手挪半步；判定帧起仍然锁死朝向，
          // 所以"砍空后要重新转身"的代价保留，但不再出现"朝着空气挥"。
          const want = Math.atan2(opp.y - f.y, opp.x - f.x);
          const rate = f.prof.turn * DT * 0.75;
          f.face += clamp(norm(want - f.face), -rate, rate);
        }
      }
      // 物理积分 + 垂直轴（重力 / 悬停 / 落地）+ 边界
      for (const f of list) {
        f.x += f.vx * DT; f.y += f.vy * DT;
        // 水平阻尼：空中更小（轻功冲刺与击飞真的飞得远）；水战按 slick 数值连续变滑
        const drag = Math.pow(f.z > 0.2 ? 0.10 : (0.02 + scen.slick * 0.25), DT);
        f.vx *= drag; f.vy *= drag;
        if (f.z > 0 || f.vz !== 0) {
          const hovering = f.mob.flight && f.z > 0.15 && !f.mustLand && f.sta > 12;
          if (hovering && f.vz <= 0.5 && f.z <= f.mob.hover + 0.35) {
            f.vz = f.z > f.mob.hover ? -1.6 : 0;      // 悬停：停在档位高度，超了缓慢下沉
            f.sta = Math.max(0, f.sta - 16 * DT);     // 悬停耗气 → 气尽自然落地
          } else {
            f.vz -= G_Z * DT;                         // 重力
          }
          // 悬停事件：让战绩/证据/画面都能明确写出"他浮在空中"（7 级以上才有）
          const nowHover = hovering && f.vz === 0 && f.z > 1;
          if (nowHover && !f.wasHover) {
            f.wasHover = true; f.stats.hovers++;
            sim.events.push({ t: +sim.t.toFixed(3), type: "hover", who: f.id, x: +f.x.toFixed(3), y: +f.y.toFixed(3), z: +f.z.toFixed(3), mob: f.mob.zh });
          } else if (!nowHover && f.wasHover) {
            f.wasHover = false;
            sim.events.push({ t: +sim.t.toFixed(3), type: "hover_end", who: f.id, z: +f.z.toFixed(3) });
          }
          if (nowHover) f.stats.hoverT += DT;
          // ── 飞檐走壁（5 级以上）：贴上场地墙壁 → 贴墙滑行 → 蹬墙翻身弹开 ──
          if (f.mob.wall && f.state !== "down" && f.z > 0.5) {
            const dL = f.x - CAP_R, dR = arena.w - CAP_R - f.x, dB = f.y - CAP_R, dT = arena.h - CAP_R - f.y;
            const m = Math.min(dL, dR, dB, dT);
            const axis = (m === dL) ? "L" : (m === dR) ? "R" : (m === dB) ? "B" : "T";
            if (f.wallT > 0) {
              f.wallT -= DT;
              f.vz = Math.max(f.vz - 1.4 * DT, -0.9);              // 贴墙几乎不坠（沿着墙"跑"）
              if (axis === "L" || axis === "R") f.vx = 0; else f.vy = 0;   // 压住"往墙里"的分量
              if (f.wallT <= 0) {                                   // 蹬墙翻身：离墙弹开 + 上冲
                const dir = (axis === "L") ? [1, 0] : (axis === "R") ? [-1, 0] : (axis === "B") ? [0, 1] : [0, -1];
                const kick = 3.2 + f.mob.dash * 1.1;
                f.vx += dir[0] * kick; f.vy += dir[1] * kick;
                f.vz = Math.max(f.vz, 4.0);
                f.stats.wallKicks++;
                sim.events.push({ t: +sim.t.toFixed(3), type: "wall_kick", who: f.id, wall: axis, x: +f.x.toFixed(3), y: +f.y.toFixed(3), z: +f.z.toFixed(3) });
              }
            } else {
              // 靠墙弧线：空中靠近墙时被"吸"一下，否则高速掠过根本贴不上墙、跑不起来
              if (m < 1.8) {
                const pull = 3.2 * DT;
                if (axis === "L") f.vx += pull; else if (axis === "R") f.vx -= pull;
                else if (axis === "B") f.vy += pull; else f.vy -= pull;
              }
              if (m < 1.15 && sim.t < 26 && f.airHold > 0.05 && f.sta > 18 && f.wallCd <= sim.t && f.stats.wallRuns < 5) {
                f.wallT = Math.min(0.8 + f.mob.hover * 0.10, WALL_RUN_MAX);   // 悬停档贴得更久，但封顶（贴墙是借力换位，不是漂着）
                f.wallCd = sim.t + 1.0;
                f.stats.wallRuns++;
                sim.events.push({ t: +sim.t.toFixed(3), type: "wall_run", who: f.id, wall: axis, x: +f.x.toFixed(3), y: +f.y.toFixed(3), z: +f.z.toFixed(3) });
              }
            }
          }
          f.z += f.vz * DT;
          if (f.peakZ < f.z) f.peakZ = f.z;
          if (f.stats.maxZ < f.z) f.stats.maxZ = +f.z.toFixed(2);
          if (f.z > ceilZ) { f.z = ceilZ; f.vz = Math.min(f.vz, 0); }
          if (f.z <= 0) { const impact = -f.vz; f.z = 0; f.vz = 0; land(sim, f, impact); }
        }
        f.x = clamp(f.x, CAP_R, arena.w - CAP_R); f.y = clamp(f.y, CAP_R, arena.h - CAP_R);
        // 掩体是实体：撞上石墙/木箱会被挡住（贴地时才算碰撞，人在高空不算）
        if (f.z < 1.1) for (const pr of sim.props) {
          if (pr.broken) continue;
          const px = f.x - pr.x, py = f.y - pr.y, pd = Math.hypot(px, py), rr = pr.r + CAP_R;
          if (pd < rr && pd > 1e-6) {
            f.x += (px / pd) * (rr - pd); f.y += (py / pd) * (rr - pd);
            f.vx *= 0.35; f.vy *= 0.35;
          }
        }
        // 水战：湿滑地面高速移动会打滑（重心失衡）、会溅水花
        if (scen.slick > 0 && f.z <= 0.05 && f.state !== "down") {
          const sp2 = Math.hypot(f.vx, f.vy);
          f.slipT = Math.max(0, f.slipT - DT);
          f.splashT = Math.max(0, f.splashT - DT);
          if (sp2 > 4.0 && f.slipT <= 0 && f.state !== "stagger" && f.rng() < scen.slick * 0.5) {
            f.slipT = 2.2; f.hitstun = Math.max(f.hitstun, 0.22); f.state = "stagger"; f.stats.slips++;
            sim.events.push({ t: +sim.t.toFixed(3), type: "slip", who: f.id, x: +f.x.toFixed(3), y: +f.y.toFixed(3), z: 0, speed: +sp2.toFixed(2) });
          } else if (sp2 > 3.4 && f.splashT <= 0) {
            f.splashT = 1.0; f.stats.splashes++;
            sim.events.push({ t: +sim.t.toFixed(3), type: "splash", who: f.id, x: +f.x.toFixed(3), y: +f.y.toFixed(3), z: 0, speed: +sp2.toFixed(2) });
          }
        }
      }
      let dx = B.x - A.x, dy = B.y - A.y, d = Math.hypot(dx, dy);
      // 水平分离恒定生效（不因高度差豁免）：保证任何一帧两人都不会在水平面上重叠
      if (d < CAP_R * 2 && d > 1e-6) {
        const push = (CAP_R * 2 - d) / 2, ux = dx / d, uy = dy / d;
        A.x -= ux * push; A.y -= uy * push; B.x += ux * push; B.y += uy * push;
      }
      // 擂台边界：越界＝掉台（受伤＋硬直，然后翻回台内）；四次掉台直接判负
      if (sim.ring) for (const f of [A, B]) {
        if (f.state === "down" || f.hitstun > 0.65) continue;
        const ox = f.x - sim.ring.cx, oy = f.y - sim.ring.cy, od = Math.hypot(ox, oy);
        if (od <= sim.ring.r || od < 1e-6) continue;
        const over = od - sim.ring.r;
        const onCd = sim.t < (f.ringCd || 0);
        // 无论是否计次，都要翻回台内（回到台中偏内，而不是贴着台边——否则会被连续撞下去）
        const k = (sim.ring.r * 0.45) / od;
        f.x = sim.ring.cx + ox * k; f.y = sim.ring.cy + oy * k;
        f.z = 0; f.vz = 0;
        if (onCd) continue;
        f.ringCd = sim.t + 0.8;
        f.stats.ringOuts++;
        // 掉台＝重伤＋硬直＋落地（不是独立的判负条件；胜负仍由气血/终结决定）
        f.hp = Math.max(0, f.hp - Math.min(f.hp * 0.4, f.hpMax * 0.05 + over * 5));
        f.hitstun = Math.max(f.hitstun, 0.6); f.state = "hitstun";
        sim.events.push({ t: +sim.t.toFixed(3), type: "ring_out", who: f.id, x: +f.x.toFixed(3), y: +f.y.toFixed(3),
                          z: 0, over: +over.toFixed(2), times: f.stats.ringOuts });
        if (f.hp <= 0) {
          f.hp = 0; f.state = "down"; f.post = "stand"; f.hitstun = 3;
          sim.events.push({ t: +sim.t.toFixed(3), type: "ko", who: f.id, x: +f.x.toFixed(3), y: +f.y.toFixed(3), by: null, tech: "掉台", ringOut: true, air: false });
        }
      }
      // ── 法术弹道：飞行 → 命中人物 / 被兵器格挡 / 被掩体挡下 / 出界消散 ──
      for (let i = sim.shots.length - 1; i >= 0; i--) {
        const s = sim.shots[i];
        s.life -= DT;
        // 自动追踪（龙形气功这类）：按转向速率把速度方向拧向对手
        if (s.track) {
          const tgt = s.owner === "A" ? B : A;
          const cur = Math.atan2(s.vy, s.vx);
          const want = Math.atan2((tgt.y + (tgt.vy || 0) * 0.15) - s.y, (tgt.x + (tgt.vx || 0) * 0.15) - s.x);
          const turn = Math.max(-1, Math.min(1, angDiff(want, cur))) * Math.min(1, (s.turn || 0.8) * DT);
          const na = cur + turn;
          s.vx = Math.cos(na) * s.spd; s.vy = Math.sin(na) * s.spd;
        }
        s.x += s.vx * DT; s.y += s.vy * DT;
        const owner = s.owner === "A" ? A : B, def = s.owner === "A" ? B : A;
        let end = null;
        for (const pr of sim.props) {                       // 掩体先挡（法术也穿不过石墙木箱）
          if (pr.broken) continue;
          if (Math.hypot(s.x - pr.x, s.y - pr.y) <= pr.r) { end = { kind: "cover", pr }; break; }
        }
        if (!end && def.state !== "down") {
          const dz = Math.abs(s.z - (def.z + 0.95));
          const hitR = CAP_R + 0.30 + ((s.eff && s.eff.radius) || 0) * 0.35;   // 命中体积随招式半径放大
          if (Math.hypot(s.x - def.x, s.y - def.y) <= hitR && dz <= 1.15) {
            const facing = def.state === "block" && angDiff(Math.atan2(s.y - def.y, s.x - def.x), def.face) < Math.PI * 0.45;
            // 大威力招式（气功半径 ≥1.2 米）震开格挡：只减伤不挡下；小招式（指法/剑气）仍可被兵器架住
            const through = facing && s.eff && (s.eff.radius || 0) >= 1.2;
            end = { kind: (facing && !through) ? "guard" : "hit", def, through: through };
            if (through && !s.pierceLogged) {
              s.pierceLogged = true;
              sim.events.push({ t: +sim.t.toFixed(3), type: "guardbreak", who: def.id, by: s.owner, tech: s.sp.zh, spell: true, through: true });
            }
          }
        }
        if (!end && (s.x < 0 || s.y < 0 || s.x > arena.w || s.y > arena.h)) end = { kind: "fade" };
        if (!end && s.life <= 0) end = { kind: "fade" };
        if (!end) continue;
        const geo = { dist: Math.hypot(s.x - owner.x, s.y - owner.y), reach: s.sp.reach, ang: 0 };
        if (end.kind === "hit" || end.kind === "guard") {
          const v = { zh: s.sp.zh, key: "spell", h: "mid", dmg: 1.0, kb: 1.35, arc: 0, reach: 1, spell: true,
                      damage: s.dmg * owner.prof.dmg };
          const ko = applyHit(sim, owner, end.def, v, end.kind === "guard", false, geo);
          if (end.kind === "hit") {
            owner.stats.spellHits++;
            sim.events.push({ t: +sim.t.toFixed(3), type: "spell_hit", who: end.def.id, by: owner.id, tech: s.sp.zh, shot: s.id,
                              x: +s.x.toFixed(3), y: +s.y.toFixed(3), z: +s.z.toFixed(3), range: +Math.hypot(s.x - owner.x, s.y - owner.y).toFixed(2),
                              hp: +end.def.hp.toFixed(1) });
          }
          if (ko) { /* applyHit 已写入 KO 事件 */ }
        } else if (end.kind === "cover") {
          end.pr.hit++;
          const broke = end.pr.hit >= end.pr.tough;
          if (broke) end.pr.broken = true;
          owner.stats.obstacleHits++;
          sim.events.push({ t: +sim.t.toFixed(3), type: "obstacle_hit", who: owner.id, prop: end.pr.id, propName: end.pr.zh,
                            x: +end.pr.x.toFixed(3), y: +end.pr.y.toFixed(3), z: 0, tech: s.sp.zh, spell: true, shot: s.id, broke, heavy: true });
        } else {
          sim.events.push({ t: +sim.t.toFixed(3), type: "spell_fade", who: owner.id, tech: s.sp.zh, shot: s.id,
                            x: +s.x.toFixed(3), y: +s.y.toFixed(3), z: +s.z.toFixed(3) });
        }
        sim.shots.splice(i, 1);
      }
      // 命中判定：只在 active 帧，且每次出手只结算一次。
      // 先收集"本帧双方各自的接触"，再统一结算 —— 双方同时打中就是"对拼"，
      // 而不是简单的你一刀我一刀（这也是格斗游戏的通用规则）。
      const pend = [];
      for (const f of list) {
        if (f.state !== "attack" || f.phase !== "active" || f.hasHit) continue;
        const opp = f === A ? B : A;
        const v = f.tech, reach = f.reach * v.reach;
        // 掩体：兵器线路被石墙/木箱挡住 → 这一刀落在掩体上（够不到掩体就是砍空，
        // 但绝不会"穿过掩体"打到后面的人）——阵地战/追逐战的"借掩体"就是这么生效的
        if (sim.props.length) {
          const blk = sim.props.find(pr => !pr.broken && G.ptSeg(pr.x, pr.y, f.x, f.y, opp.x, opp.y) <= pr.r);
          if (blk) {
            const pd = Math.hypot(blk.x - f.x, blk.y - f.y);
            f.hasHit = true;
            if (pd <= reach + blk.r) {
              f.stats.obstacleHits++;
              blk.hit++;
              const broke = blk.hit >= blk.tough;
              if (broke) blk.broken = true;
              sim.events.push({ t: +sim.t.toFixed(3), type: "obstacle_hit", who: f.id, prop: blk.id, propName: blk.zh,
                                x: +blk.x.toFixed(3), y: +blk.y.toFixed(3), z: 0, tech: v.zh, broke, heavy: v.dmg >= 1.3 });
            } else {
              f.stats.whiffs++;
              sim.events.push({ t: +sim.t.toFixed(3), type: "whiff", who: f.id, tech: v.zh, cover: blk.id });
            }
            continue;
          }
        }
        // 高度带：地面招够不到高空、空中不俯冲够不到地面（见 atkBand / defSpan）
        const hMiss = !bandOverlap(atkBand(f, v), defSpan(opp));
        const dist = Math.hypot(opp.x - f.x, opp.y - f.y);
        // 只看"这一帧刀锋扫过的那一小段弧"：闪避时机是有效的，砍空的刀不会再吃到人
        const a0 = (f.lastBladeAng == null ? f.arcFrom : f.lastBladeAng), a1 = f.bladeAng;
        if (hMiss || dist > reach + CAP_R) continue;
        if (!G.sectorHitsCircle(opp.x, opp.y, CAP_R, f.x, f.y, a0, a1, 0.0, reach)) continue;
        const blocked = opp.state === "block" && canBlock(f, opp) &&
                        angDiff(Math.atan2(f.y - opp.y, f.x - opp.x), opp.face) < Math.PI * 0.42;
        // 对手同时也在出招（判定帧内、或即将进判定）→ 兵刃相撞（对拼），而不是单方面挨打
        const oppAtk = opp.state === "attack" && opp.tech && !opp.hasHit;
        const oppNear = oppAtk && (opp.phase === "active" ||
                        (opp.phase === "windup" && (opp.dur.w - opp.techT) <= 0.10));
        const armedPair = f.wpnKey !== "none" && opp.wpnKey !== "none";
        pend.push({ f, opp, v, reach, dist, a0, a1, blocked, clashAttack: !!(!o.rules?.noClash && oppNear && armedPair && !blocked) });
      }
      const both = !o.rules?.noClash && A.wpnKey!=="none" && B.wpnKey!=="none" && pend.length === 2 && pend[0].f !== pend[1].f;
      for (const p of pend) {
        if(both && p!==pend[0]) continue; // One simultaneous clash, one event.
        p.f.hasHit = true;
        if (both || p.clashAttack) {
          // 兵刃相交：火花、各震半步，谁也别想白拿这一下
          p.opp.hasHit = true;
          applyHit(sim, p.f, p.opp, p.v, false, true,
            { dist: p.dist, reach: p.reach, ang: angDiff(Math.atan2(p.opp.y - p.f.y, p.opp.x - p.f.x), p.f.face) });
          continue;
        }
        applyHit(sim, p.f, p.opp, p.v, p.blocked, false,
          { dist: p.dist, reach: p.reach, ang: angDiff(Math.atan2(p.opp.y - p.f.y, p.opp.x - p.f.x), p.f.face),
            ox: p.f.x, oy: p.f.y, ba: p.a1, ba0: p.a0 });
      }
      // 兵器在半空相撞（双方都还没打中身体）也算对拼
      if (!o.rules?.noClash && !both && A.state === "attack" && B.state === "attack" && A.phase === "active" && B.phase === "active" &&
          A.wpnKey !== "none" && B.wpnKey !== "none" && !A.hasHit && !B.hasHit &&
          G.segSeg(weaponSeg(A), weaponSeg(B))) {
        A.hasHit = true; B.hasHit = true;
        applyHit(sim, A, B, A.tech, false, true, null);
      }
      // 动作时间账：每帧跟踪 A/B 的状态段
      trackSegment(sim, A); trackSegment(sim, B);
      // 收帧
      if (sim.frames) {
        sim.frames.push({
          t: fr(sim.t),
          A: snap(A), B: snap(B)
        });
      }
      if (A.state === "down" || B.state === "down") {
        if (!sim.over) {
          sim.over = A.state === "down" && B.state === "down" ? "draw" : A.state === "down" ? "B" : "A";
          sim.events.push({ t: +sim.t.toFixed(3), type: "round_over", winner: sim.over });
        }
        sim.overT += DT;                       // 倒地余波：让画面能看到"倒下"的过程与胜者收势
        if (sim.overT >= TAIL) break;
      }
    }
    function lockCheck(f) { return f.state === "attack" || f.state === "dodge" || f.state === "cast" || f.state === "hitstun" || f.state === "stagger" || f.state === "down" || f.state === "land"; }
    function snap(f) {
      return { x: fr(f.x), y: fr(f.y), z: fr(f.z), face: fr(f.face), st: f.state, ph: f.phase,
               post: f.z > 0.05 ? "air" : f.post, air: f.z > 0.05, vz: fr(f.vz),
               techKey:f.tech?f.tech.key:"", tp:f.tech&&f.dur?fr(Math.min(1,f.techT/(f.dur.w+f.dur.a+f.dur.r))):0,
               attackReach:f.tech?fr(f.reach*f.tech.reach):f.reach, arcFrom:fr(f.arcFrom),
               tech: f.tech ? f.tech.zh : "", hp: fr(f.hp), gd: fr(f.guard), sa: fr(f.sta),
               ba: f.bladeAng == null ? null : fr(f.bladeAng),
               ft: f.state === "down" ? +Math.min(1, (f.fallT || 0) / 0.55).toFixed(3) : 0 };
    }
    const winner = A.state === "down" && B.state === "down" ? "draw" : A.state === "down" ? B.id : (B.state === "down" ? A.id
      : (A.hp / A.hpMax > B.hp / B.hpMax + 0.02 ? A.id : (B.hp / B.hpMax > A.hp / A.hpMax + 0.02 ? B.id : "draw")));
    const counts = (t) => sim.events.filter(e => e.type === t).length;
    // 招式库：本场若自动收纳了新招式 → 落盘（下次同名招式直接调用，不必再生成）
    if (MOVES && _libState.dirty) { try { MOVES.saveUser(); } catch (e) { /* 浏览器端由界面层存 localStorage */ } }
    return {
      warnings:o.warnings||[], ruleReport:o.ruleReport||[], rules:o.rules||{},
      // 招式库统计：本场从库里调用了多少次、自动收纳了几个新招式
      moveLib: MOVES ? Object.assign({ used: _libState.used, added: _libState.added }, MOVES.stats()) : null,
      version: VERSION, seed, arena: Object.assign({}, arena, { z: ceilZ }), duration: +sim.t.toFixed(2), winner,
      // 情景：不只是描述——这些字段决定/记录了内核真的算了什么
      scenario: { key: scen.key, zh: scen.zh, aerial: scen.aerial, water: scen.water, slick: scen.slick,
                  chase: !!sim.chase, ring: sim.ring, startZ: scen.aerial ? +Math.max(2.2, Math.min(ceilZ, ceilZ * 0.8)).toFixed(2) : 0 },
      props: sim.props.map(pr => ({ id: pr.id, zh: pr.zh, x: pr.x, y: pr.y, r: pr.r, tough: pr.tough, broken: pr.broken })),
      chase: sim.chase ? { chaser: sim.chase.chaser, cornered: sim.chase.cornered } : null,
      A: publicFighter(A), B: publicFighter(B),
      events: sim.events, frames: sim.frames,
      // 动作时间账：每段的开始→结束→时长（含空中段）+ 汇总（供证据/提示词/审计）
      timeline: (function () { closeSegments(sim); return sim.timeline; })(),
      timing: Object.assign({}, sim.timing, {
        actionTime: +sim.timing.actionTime.toFixed(2),
        share: +Math.min(1, sim.timing.actionTime / Math.max(0.001, sim.A ? 2 : 1) / Math.max(0.001, sim.t)).toFixed(3)
      }),
      summary: {
        hits: counts("hit"), blocks: counts("block"), dodges: counts("dodge"),
        clashes: counts("clash"), guardBreaks: counts("guardbreak"), ko: counts("ko"),
        takeoffs: counts("takeoff"), landings: counts("landing"), landingShocks: counts("landing_shock"),
        airHits: A.stats.airHits + B.stats.airHits, maxZ: +Math.max(A.stats.maxZ, B.stats.maxZ).toFixed(2),
        wallRuns: counts("wall_run"), wallKicks: counts("wall_kick"),
        hovers: counts("hover"), qiBursts: counts("qi_burst"), hoverSeconds: +(A.stats.hoverT + B.stats.hoverT).toFixed(2),
        airRecovers: counts("air_recover"), intercepts: counts("intercept"),
        spellCasts: A.stats.spellCasts + B.stats.spellCasts, spellHits: A.stats.spellHits + B.stats.spellHits,
        spellFades: counts("spell_fade"),
        obstacleHits: counts("obstacle_hit"), obstaclesBroken: sim.props.filter(pr => pr.broken).length,
        ringOuts: A.stats.ringOuts + B.stats.ringOuts, slips: A.stats.slips + B.stats.slips, splashes: A.stats.splashes + B.stats.splashes,
        finish: A.state === "down" || B.state === "down"
      }
    };
  }

  function publicFighter(f) {
    return { id: f.id, name: f.name, tier: f.prof.tier, tierName: f.prof.name, style: f.styleKey,
             styleName: f.style.zh, weapon: f.wpnKey, weaponName: f.wpn.zh,
             // 机动档：等级解锁的"能不能飞"，供证据与提示词直接引用
             mobility: { key: f.mob.key, zh: f.mob.zh, jump: f.mob.jump, hover: f.mob.hover,
                         airAtk: f.mob.airAtk, wall: !!f.mob.wall, fly: !!f.mob.flight, shock: f.mob.shock },
             hp: +f.hp.toFixed(1), hpMax: f.hpMax, stats: f.stats,
             // 动作目的审计：每个决策的目的分布 + 明细（提示词与自检都要用）
             purposes: {
               total: f.stats.purposeTotal || 0,
               tagged: f.stats.purposeTagged || 0,
               unpurposed: f.stats.unpurposed || 0,
               counts: f.stats.purposeCounts || {},
               log: (f.purposeLog || []).slice(0, 400)
             } };
  }

  return { VERSION, DT, LEAP_WHY_ZH, leapWhyZh, CAP_R, WEAPONS, VARIANTS, AIR_VARIANTS, STYLES, TIER_POWER, TIER_NAME, MOBILITY, mobility,
           SCEN, scenario, aerialFloor, G_Z, AIR_MAX, tierProfile, mulberry32, simulate, atkBand, defSpan, bandOverlap, _G: G };
});
