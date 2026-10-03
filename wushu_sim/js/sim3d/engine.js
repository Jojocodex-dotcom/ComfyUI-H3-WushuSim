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

  const VERSION = "sim3d-2.1";
  const SKILLS = typeof module === "object" && module.exports ? require("./skill-catalog.js") : globalThis.H3_SKILL_CATALOG;
  const ACTIONS = typeof module === "object" && module.exports ? require("./action-system.js") : globalThis.H3_ACTIONS;
  const CONTRACT = typeof module === "object" && module.exports ? require("../core/combat-contract.js") : globalThis.H3_CONTRACT;
  const CHOREOGRAPHY = typeof module === "object" && module.exports ? require("./choreography.js") : globalThis.H3_CHOREOGRAPHY;
  const DT = 1 / 60;                 // 固定步长
  const CAP_R = 0.34;                // 角色胶囊半径（米）

  // ── 招式套路库（sim3d/routines.js）──────────────────────────────────────
  //   招式＝**一整套组合套路**（咏春问手/日字冲拳、洪拳虎爪、形意五行拳…），
  //   套路里每一步的动作/意图/手脚/打击部位/节奏都记录在案，出招时按步结算并逐条记账。
  //   Node 走 require，浏览器走 window.SIM3D_ROUTINES（与 moves.js 同一套双通道写法）。
  let _RL_LOADED = false, _RL = null;
  function routineLib() {
    if (_RL_LOADED) return _RL;
    _RL_LOADED = true;
    try { if (typeof require === "function") { _RL = require("./routines.js"); return _RL; } } catch (e) { /* 浏览器环境 */ }
    _RL = (typeof globalThis !== "undefined" && globalThis.SIM3D_ROUTINES) ? globalThis.SIM3D_ROUTINES : null;
    return _RL;
  }

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
    { min: 9, key: "flight", zh: "飞天遁地", jump: 6.4, hover: 6.5, hoverTime: 7.0, airAtk: 3, dash: 3, wall: true, flight: true, shock: 2.4, float: 0 },
    { min: 8, key: "flight", zh: "御空飞行", jump: 5.4, hover: 5.0, hoverTime: 6.0, airAtk: 3, dash: 3, wall: true, flight: true, shock: 2.0, float: 0 },
    { min: 7, key: "flight", zh: "凌空飞行", jump: 4.4, hover: 3.6, hoverTime: 5.0, airAtk: 2, dash: 2, wall: true, flight: true, shock: 1.7, float: 0 },
    // float＝"短暂滞空"秒数（3~6 级）：跃到最高点能提气停住一口气，在空中打一两下再落 ——
    //   用户要求："3-6 级别可以轻功，和短暂在空中停留打斗"。飞行档不需要它（他们有真悬停）。
    { min: 5, key: "wall",   zh: "踏墙借力", jump: 2.6, hover: 0,   hoverTime: 1.8, airAtk: 2, dash: 2, wall: true,  flight: false, shock: 0, float: 1.3 },
    { min: 3, key: "leap",   zh: "轻功腾跃", jump: 1.3, hover: 0,   hoverTime: 1.4, airAtk: 1, dash: 1, wall: false, flight: false, shock: 0, float: 0.9 },
    { min: 1, key: "none",   zh: "凡人步法", jump: 0,   hover: 0,   hoverTime: 0,   airAtk: 0, dash: 0, wall: false, flight: false, shock: 0, float: 0 }
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
  // 套路里"会打到人"的动作类型（其余是步法/护中，只影响节奏不影响判定）
  const ROUTINE_HIT_ACT = { probe: 0, trap: 1, strike: 1, kick: 1, grab: 1, throw: 1, finish: 1, move: 0, parry: 0 };
  const ROUTINE_HIT_ACTS = Object.keys(ROUTINE_HIT_ACT).filter(k => ROUTINE_HIT_ACT[k]);
  // 套路内单步伤害缩放：三连拳的总伤害 ≈ 1.8 倍单招（不是 3 倍），保持对局平衡
  const ROUTINE_TOTAL_DMG = 1.10;   // 一整套连招的总伤害倍数（相对单招）

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
    { key: "dive",       zh: "俯冲击",   arc: 92,  h: "high", dmg: 1.65, kb: 1.95, stam: 1.30, reach: 1.12, tag: "攻击", air: true, airOnly: true, dive: true },
    // ── 腿法与特技（2026-09-29，用户：「动作编排要好看一些，回旋踢、飞腿这些特殊动作都没有，打斗太单调」）──
    //   原来招式表只有"横斩/斜劈/突刺/撩挑/扫堂/重击/终结"七种通用变体，**一条腿法都没有**，
    //   拳脚角色与持刀角色打起来毫无区别。这一族补上港式动作片的招牌动作；
    //   kick:true 让挑招与 3D 姿态都能认出"这是腿法"（rig.js 会真的把腿抬起来摆姿势）。
    //   ⚠ 只许**追加在末尾**：上面的代码按下标取 VARIANTS[0..6] 与 AIR_VARIANTS[0..3]。
    { key: "kick_round", zh: "回旋踢",    arc: 168, h: "mid",  dmg: 1.35, kb: 1.65, stam: 1.25, reach: 1.18, tag: "攻击", slow: 1.15, kick: true },
    { key: "kick_side",  zh: "侧踹",      arc: 26,  h: "mid",  dmg: 1.25, kb: 2.30, stam: 1.15, reach: 1.40, tag: "攻击", kick: true },
    { key: "kick_heel",  zh: "转身后摆莲", arc: 150, h: "high", dmg: 1.55, kb: 1.90, stam: 1.35, reach: 1.22, tag: "攻击", slow: 1.25, kick: true },
    { key: "knee",       zh: "膝撞",      arc: 46,  h: "mid",  dmg: 1.20, kb: 0.85, stam: 0.90, reach: 0.74, tag: "攻击", kick: true, close: true },
    { key: "elbow",      zh: "肘击",      arc: 62,  h: "high", dmg: 1.30, kb: 0.95, stam: 0.95, reach: 0.70, tag: "攻击", close: true },
    { key: "fly_kick",   zh: "飞腿",      arc: 64,  h: "mid",  dmg: 1.40, kb: 1.75, stam: 1.15, reach: 1.28, tag: "攻击", air: true, kick: true },
    { key: "air_round",  zh: "腾空回旋踢", arc: 190, h: "mid", dmg: 1.65, kb: 1.95, stam: 1.30, reach: 1.12, tag: "攻击", air: true, airOnly: true, slow: 1.20, kick: true },
    { key: "air_axe",    zh: "劈腿",      arc: 84,  h: "high", dmg: 1.55, kb: 1.80, stam: 1.25, reach: 1.15, tag: "攻击", air: true, airOnly: true, dive: true, kick: true }
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
    // ── 专飞角色（2026-10-01 用户：「有些角色就是专门飞行打斗的」）────────────
    //   角色卡勾「专飞」＝不管武力等级几级，机动一律按**御空飞行档**（至少 7 级：真悬停 + 空中招数 + 滞空预算）。
    //   只改机动，不动速度/伤害/血量——飞得起来，但打得像几级还是几级。
    if (o.fly) prof.mob = mobility(Math.max(7, o.tier || 1));
    const sty = STYLES[o.style] || STYLES.calm;
    const wpn = WEAPONS[o.weapon] || WEAPONS.none;
    const hpMax = Number.isFinite(o.hp) && o.hp > 0 ? o.hp : Math.round(100 * prof.tough);
    // ── 动作导演：招牌动作（2026-09-29，用户：「动作编排要好看一些，回旋踢、飞腿这些特殊动作都没有」）──
    //   只把腿法写进 VARIANTS 是不够的：角色卡的招式池会**覆盖**挑出来的变体
    //   （startAttack 里的 chooseSkill 按 v.key 匹配卡里的招式，卡里没有腿法就轮不到腿法）。
    //   所以由"导演"给每个人补一组招牌腿法/特技：不占角色卡的招式表、冷却稍长，
    //   有滞空能力的档位再多给两个空中腿法。这样"拳师"和"刀客"都会起脚，动作才不单调。
    const _sig = VARIANTS.filter((v) => v.kick && !v.air);
    if (prof.mob.airAtk > 0) for (const v of VARIANTS) if (v.kick && v.air && !v.airOnly) _sig.push(v);
    //   ⚠ 必须**整份克隆变体**（Object.assign({}, v, …)）：startAttack 里 `v = picked` 是整体替换，
    //    只带名字/键的话 dmg/kb/stam 全是 undefined → 伤害算出 NaN（提示词会写"伤害NaN"）。实测踩过。
    const _skills = (o.skills || []).concat(_sig.map((v) => Object.assign({}, v, {
      zh: v.zh, key: v.key, skillId: "dir_" + v.key, cooldown: 1.5, basic: false, director: true
    })));
    return {
      skills: _skills, cooldowns: {}, rules: o.rules || {}, speed: o.speed || 1,
      basicSkillId: (o.skills && o.skills[0] && o.skills[0].skillId) || null,   // 角色卡里的「普通攻击」= 第一张（pipeline 保证顺序）
      recentTech: [],                       // 最近用过的招式名（选招时避开复读）
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
      fx: o.fx || null,                                            // 特效分级（等级×风格档）：配色/形状/体量/破坏/镜头
      lastAfterimage: -9, auraOn: false,                           // 残影与灵光外放的节流
      castT: 0, castSpell: null,
      tech: null, techT: 0, phase: "", hasHit: false,
      arcFrom: 0, arcTo: 0, swingDir: 1, atkStart: 0,
    chainDepth: 0, lastOutcome: null,   // 连招段数 / 上一次接触结果（hit|block|clash|linked）——GPT 9.13 的连招门禁要用
      hitstun: 0, blockHold: 0, intent: { kind: "spacing" },
    hitsTaken: 0, lastHitT: -9, iframes: 0, escapeUntil: 0, counterUntil: 0,   // 连段计数/最后挨打时刻/无敌帧/脱出窗口/反击窗口
      // ── 打斗智商（2026-10-01 用户：「别只会挨打，格挡、闪避、翻滚、反击呢？所有角色应该都要有打斗智商」）
      //   性格只决定"**怎么**防"（偏格挡/偏闪避/偏爱反击/偏爱翻滚），**不决定"防不防"**：
      //   每个角色都有下限（格挡 ≥0.34、闪避 ≥0.28、反击 ≥0.30、翻滚 ≥0.10），
      //   高等级读招更准（read 随等级上升）。旧版 berserk/power 的 block/dodge 只有 0.05~0.10 →
      //   整场几乎不防，被点着打（体检实测：9 级 嗜血/力压 组合 4 场只有 0~2 次防守）。
      iq: (function () {
        const b = clamp(0.34 + 0.50 * (sty.block || 0), 0.34, 0.92);
        const d = clamp(0.28 + 0.50 * (sty.dodge || 0), 0.28, 0.92);
        const c = clamp(0.30 + 0.55 * (sty.counter || 0), 0.30, 0.90);
        const r = clamp(0.10 + 0.26 * (1 - (sty.block || 0)) + ((prof.tier || 1) >= 7 ? 0.10 : 0), 0.10, 0.46);
        const read = clamp(0.40 + ((prof.tier || 1) - 1) * 0.065 + 0.18 * (sty.counter || 0), 0.40, 1);
        return { block: b, dodge: d, counter: c, roll: r, read: read };
      })(),
      decideT: 0, seen: null, combo: 0, comboT: -9,
      // ── 快节奏（2026-09-25 用户：「开始打架了，快动作的话都是奔跑的拼打和追击的，怎么做出来是两个人慢慢走着打」）──
      //   dashCd/dashUntil = 冲刺的冷却与持续；castDir/castMoveT = 施法期间"踏罡步斗"的方向与记账；
      //   footT = 待机时的活气脚步节流（站着不动是最不像打斗的东西）。
      dashCd: 0, dashUntil: 0, dashWhy: null, dashes: 0, dashDist: 0,
      castDir: 1, castMode: null, castMoveT: -9, castMoveN: 0, castMoveDist: 0,
      footT: -9,
      // ── 打斗风格 / 角色套路 / 神通（2026-09-25 新增）─────────────────────
      //   sp          = 本场打斗风格的引擎参数（pipeline 从 h3-styles.js 取，双方共用）
      //   primaryNames= 主战招式名（"杨过主要用大剑挥砍"就靠它优先出招）
      //   linkNames   = 衔接招式名（"大剑挥砍 → 黯然销魂掌"；命中连击后优先放）
      //   traitList   = 该角色的神通（分身术/七十二变/法相天地/筋斗云/三头六臂/天眼/风火轮）
      sp: o.sp || {}, primaryNames: o.primary || [], linkNames: o.link || [], traitList: o.traits || [],
      traitCd: {}, traitUsed: {}, multi: null, buff: null, transformUntil: 0, cloneLeft: 0,
      hitStreak: 0, lastHitAt: -9,
      stats:
        { attacks: 0, hits: 0, blocks: 0, dodges: 0, rolls: 0, clashes: 0, guardBreaks: 0, whiffs: 0, dmg: 0, maxCombo: 0,
          takeoffs: 0, lands: 0, airHits: 0, shocks: 0, maxZ: 0,
          wallRuns: 0, wallKicks: 0, hovers: 0, hoverT: 0, comboBreaks: 0, counterWindows: 0,
          spellCasts: 0, spellHits: 0, linkCasts: 0, qiBursts: 0,
          castsStarted: 0, castsDone: 0, chargeT: 0, wardHolds: 0,
          auras: 0, afterimages: 0, phenomena: 0, traits: 0,
          ringOuts: 0, obstacleHits: 0, slips: 0, splashes: 0 }
    };
  }

  function canBlock(attacker, defender) {
    // 沿用界面的战斗规则：兵器对兵器才格挡；空手不得用手接刃
    if (defender.rules.noBlock) return false;
    if (defender.wpnKey !== "none" ) return true;
    return attacker.wpnKey === "none";     // 双方空手 → 可以格挡
  }

    // 按 key 挑招 + 避开最近两拍用过的招式（2026-09-29：腿法族加入后，复读一眼就能看出来）
    function pickByKey(keys, f, rng) {
      const pool = keys.map((k) => VARIANTS.find((v) => v.key === k)).filter(Boolean);
      if (!pool.length) return VARIANTS[0];
      const r2 = (f.recentTech || []).slice(-2);
      const fresh = pool.filter((v) => r2.indexOf(v.zh) < 0);
      const use = fresh.length ? fresh : pool;
      return use[Math.floor(rng() * use.length) % use.length];
    }
  function pickVariant(f, opp, rng) {
    const s = f.style, dist = Math.hypot(opp.x - f.x, opp.y - f.y);
    const r = rng();
    if (f.esc > 2.4) return VARIANTS[6];                                                       // 末段决胜：招招求终结
    if (opp.hp <= f.hpMax * 0.22 && r < 0.55 * (0.6 + s.ruthless)) return VARIANTS[6];        // 终结
    if (opp.state === "block" && r < 0.35 + 0.45 * s.aggr) return VARIANTS[5];                // 崩防重击
    if (f.wpnKey === "qiang" && r < 0.55) return VARIANTS[2];                                  // 长枪多刺
    // ── 腿法与特技的挑招（2026-09-29）───────────────────────────────────────
    //   只把招式写进 VARIANTS 是不够的：不在这里按距离/姿态挑，它们永远不会出现在对局里。
    //   港式动作片的分配是"贴身用膝肘、中距起脚（回旋踢）、远一点用长腿（侧踹）"；
    //   持兵器的人也会起脚，只是频率低一些；且最近两拍用过的招不再重复。
    const _un = f.wpnKey === "none";
    if (dist <= f.reach * 0.72 && r < (_un ? 0.34 : 0.22)) return pickByKey(["knee", "elbow"], f, rng);
    if (dist > f.reach * 0.95 && r < (_un ? 0.30 : 0.14)) return pickByKey(["kick_side"], f, rng);
    if (opp.post !== "crouch" && r < (_un ? 0.36 : 0.18)) return pickByKey(["kick_round", "kick_heel"], f, rng);
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
    // 轻功/踏墙档的起跳配额原来只有 1~2 次：一场下来连"跳起来打一下"都做不到，
    //   于是 3~6 级永远只能在地面打（用户要求：3-6 级要能轻功＋短暂滞空对打）。
    if (k === "flight") return 8;
    if (k === "wall") return 4;
    if (k === "leap") return 3;
    return 0;
  }
  // 真飞行（升空到悬停高度）单独一套配额：不能和"低跳"混在一个计数里。
  //   旧版共用一个 f.leaps，开场一次轻功突进就把唯一的升空机会吃掉 —— 实测 30 秒最高只有 2.9 米，
  //   观众看到的自然就只是"两个人在原地蹦"，没有飞天遁地。
  function flightCap(f) {
    const k = f.mob ? f.mob.key : "none";
    if (k !== "flight") return 0;
    const t = f.mob.tier || 7;
    return t >= 9 ? 6 : (t >= 8 ? 5 : 4);
  }
  function airBudget(f) {                       // 每场累计滞空秒数上限
    const k = f.mob ? f.mob.key : "none";
    // 用户要求："7 级别以上的高手可以浮空战斗"。所以飞行档的滞空预算要足以让整场**大部分时间在天上**：
    //   9 级 22 秒 / 8 级 18 秒 / 7 级 13 秒（30 秒对局里就是 40~70% 的时间在空中）。
    if (k === "flight") { const t = f.mob.tier || 7; return t >= 9 ? 25 : (t >= 8 ? 20 : 15); }
    if (k === "wall") return 6.0;               // 踏墙借力（5~6 级）：借墙换位 + 空中提气打斗
    if (k === "leap") return 4.5;               // 轻功腾跃（3~4 级）：每次很短，但要能腾好几次
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
    // 翻滚（2026-10-01 打斗智商）：读招翻滚让开重招 / 预判翻滚 / 被连段时翻滚脱出
    "roll": { key: "roll", zh: "翻滚让开·换位" },
    "roll|readRoll": { key: "roll", zh: "读招翻滚让开重招" },
    "roll|preRoll": { key: "roll", zh: "预判翻滚让开" },
    // 出招中途读招收手（2026-10-01）：起手阶段看清来招 → 收手改成防守
    "dodge|abortGuard": { key: "evade", zh: "读招收手·让开" },
    "roll|abortGuard": { key: "roll", zh: "读招收手·翻滚让开" },
    "block|abortGuard": { key: "guard", zh: "读招收手·改成格挡" },
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
    "wallseek": { key: "reposition", zh: "借墙换位" },
    // 冲刺/追击（2026-09-25 快节奏）：三种冲刺各自有目的，审计要能认出来
    "dash": { key: "close", zh: "冲刺进射程" },
    "dash|open": { key: "close", zh: "开场冲刺抢身位" },
    "dash|close": { key: "close", zh: "冲刺拉近距离" },
    "dash|pursue": { key: "punish", zh: "追击补打（对手还在硬直/踉跄）" }
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
    const LEAP_WHY_ZH = { airStrike: "腾空突袭（空中提气打一两下）", evade: "为躲开来招而跃起", attack: "为跃起重击而升空", antiAir: "为拦截空中的对手而迎空",
    close: "为突进接近而跃起", chase: "为追击而跃起", reposition: "借墙换位（抢角度）", escape: "为脱离而跃起" };
  function leapWhyZh(w) { return LEAP_WHY_ZH[w] || "起跳"; }
  function canLeap(f, sim, cost, why) {
    if (!canAir(f, sim, cost)) return false;
    // 追逐战里"追"和"逃"本来就是靠身法完成的，给追击/脱离类起跳放宽（否则追击者追不上，30 秒打不完）
    const inChase = !!(sim.chase && sim.chase.chaser === f.id);
    const cap = leapCap(f) + (inChase && (why === "chase" || why === "escape" || why === "evade") ? 3 : 0);
    // 追逐战：飞着逃跑太强（实测有一场 30 秒打不完），所以逃跑方的滞空预算减半，追击方照旧；
    //   末段再由下面的"时间压上"强制落地收尾。
    const budget = airBudget(f) * (sim.chase && sim.chase.chaser !== f.id ? 0.5 : 1) + (inChase ? 2.5 : 0);
    const cd = (why === "chase" || why === "escape") ? 1.2 : (why === "flight" ? 1.4 : 2.2);
    if (why === "flight") {                                                     // 真升空：走飞行自己的配额
      if ((f.flights || 0) >= flightCap(f)) { f.leapDenied++; return false; }
      if (sim.t < (f.flightCd || -9)) { f.leapDenied++; return false; }
    } else if (f.leaps >= cap) { f.leapDenied++; return false; }                 // 每场配额
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
      case "flight":                                                            // 升空压迫／空战拦截：与距离无关
        if (!f.mob.flight) { f.leapDenied++; return false; }
        break;
      case "airStrike":                                                          // 轻功腾空突袭：只有能"提气滞空"的档位能用
        if (!(f.mob.float > 0)) { f.leapDenied++; return false; }
        break;
      case "attack":                                                            // 跃起重击：必须有出手机会
        if (!(dist <= f.reach * 2.2 && f.sta > 34)) { f.leapDenied++; return false; }
        break;
      case "close":
      case "chase": {
        // 只有"真的远"才值得跳过去（原来 2.2 米就跳 —— 一步就能走过去，看着就是无意义地蹦）
        // 飞得起来的（7 级以上真飞行）与在追人的（追逐战），位移类起跳放宽：那是他们的打法
        const flyer = !!(f.mob && f.mob.flight) || inChase;
        const want = Math.max(flyer ? 2.6 : 3.0, f.reach * ((f.rules && f.rules.close) ? 1.8 : (flyer ? 2.0 : 2.4)));
        if (!(dist > want)) { f.leapDenied++; return false; }
        // 纯位移类起跳单独配额：超了就老实走过去（每场 2 + 等级×0.35 次；飞行档与追逐不设限）
        const dCap = Math.round(2 + (f.prof.tier || 1) * 0.35);
        if (!flyer && (f.displaceLeaps || 0) >= dCap) { f.leapDenied++; return false; }
        break;
      }
      case "escape":                                                            // 脱离：必须有来招或在被追
        if (!(threat || inChase)) { f.leapDenied++; return false; }
        break;
      case "reposition":                                                        // 借墙换位：必须在墙边
        if (!f.mob.wall) { f.leapDenied++; return false; }
        // 而且对手不能已经贴脸：一步就能到的时候借墙跳＝无意义位移（审计口径：位移类起跳
        //   在 3 米内算"没必要的跳"）。2026-09-25 快节奏改动后冲刺更快，这条更要守住。
        if (!(dist > 3.0) && !inChase) { f.leapDenied++; return false; }
        break;
      default:
        f.leapDenied++; return false;                                           // 没写目的 → 一律不许跳
    }
    f.leapWhy = why;
    // 位移类起跳记账（配额用）
    if (why === "close" || why === "chase" || why === "reposition") f.displaceLeaps = (f.displaceLeaps || 0) + 1;
    // 起跳之后必须接上文：1.3 秒内够得着就出手（decide 里会优先走这一条）
    f.engageUntil = sim.t + 1.3;
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
      case "airStrike": return cl(maxJ * 0.8);        // 轻功腾空突袭：跳到自己档位高度的八成，在空中提气打一两下
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
    // 轻功档刚起跳（还低）时不俯冲：先升到能"提气"的高度（3~6 级的空中打法）
    if (!f.mob.flight && (f.z || 0) < 0.9) return AIR_VARIANTS.filter((x) => !x.dive)[0] || AIR_VARIANTS[0];
    const _ak = (k) => AIR_VARIANTS.find((x) => x.key === k);
      // 空中腿法（2026-09-29）：对空用「腾空回旋踢」（大扇角扫过整个上半身），对地用「飞腿」冲过去一脚、
      //   「劈腿」自上下劈。原来空中只有 4 种变体，一复读就很明显。
      let v = (opp.z > 0.5)
      ? (r < 0.34 ? (_ak("air_round") || AIR_VARIANTS[2]) : (r < 0.62 ? AIR_VARIANTS[2] : (r < 0.86 ? AIR_VARIANTS[3] : AIR_VARIANTS[1])))   // 空中对空：连击为主
      : (r < 0.30 ? (_ak("fly_kick") || AIR_VARIANTS[3]) : (r < 0.48 ? (_ak("air_axe") || AIR_VARIANTS[3]) : (r < 0.74 ? AIR_VARIANTS[3] : AIR_VARIANTS[0])));  // 空中对地：俯冲为主
    // 空中招也要去复读：空中只有 4 种变体，一复读就非常明显（实测空战变多后"俯冲击"连拍 37 次）。
    //   规则和地面一样：刚用过（最近两拍）的换掉。
    const rt = f.recentTech || [];
    const last = rt[rt.length - 1] || "", prev = rt[rt.length - 2] || "";
    if (v.zh === last) {
      const alt = AIR_VARIANTS.filter(x => x.zh !== last && x.zh !== prev);
      if (alt.length) v = alt[Math.floor(rng() * alt.length) % alt.length];
    }
    return v;
  }

  // ── 出手选招：治「只有平A」与「同一招连用」────────────────────────────
  //   原实现是"随变体抽一个可用招式"，于是 30 秒打完 76% 都是普通攻击、整场只有 2~6 种招。
  //   这里改成四层优先级：① 与本次决策意图同型且不是刚用过的 → ② 情境招（崩防/低血上重手、
  //   对手格挡上破防、远距离上突进、下蹲/离地上扫堂撩挑）→ ③ 最近 4 拍没用过的（去复读）
  //   → ④ 只要不是刚用过的那个。返回 null 表示整套招式都在冷却（调用方要补"有目的的间隙动作"）。
  function chooseSkill(sim, f, v, opp) {
    const now = sim.t;
    const avail = f.skills.filter(s => (f.cooldowns[s.skillId] || 0) <= now);
    if (!avail.length) return null;
    // ── 主战方式优先（2026-09-25）：角色卡/套路档案给了「主战招式」就用它们当主体，
    //   其余招式当变招。否则"杨过主要用大剑挥砍"这种设定在结算里体现不出来。
    if (f.primaryNames && f.primaryNames.length) {
      const prim = avail.filter(s => f.primaryNames.indexOf(s.zh) >= 0);
      if (prim.length) {
        const recentP = f.recentTech || [];
        const lastP = recentP[recentP.length - 1] || "";
        const pickP = prim.filter(s => s.zh !== lastP);
        const bag = pickP.length ? pickP : prim;
        // 八成按主战招式出，两成留给变招（否则同一招刷成流水线）
        if (sim.rng() < 0.8) return bag[Math.floor(sim.rng() * bag.length)];
      }
    }
    const recent = f.recentTech || (f.recentTech = []);
    const last = recent[recent.length - 1] || "";
    // 普攻可以是一**套**（用户：「普攻就别单单只是写一个直拳……要有一套招式」）：带 basic:true 的都算基础招
    const isBasic = s => s.basic === true || s.skillId === f.basicSkillId;
    const fit = avail.find(s => s.key === v.key);
    if (fit && fit.zh !== last) return fit;
    const dist = Math.hypot(opp.x - f.x, opp.y - f.y);
    const want = [];
    if (opp.guard <= 25 || opp.hp <= f.hpMax * 0.25) want.push("finish", "heavy");
    if (opp.state === "block") want.push("heavy", "sweep");
    if (dist > f.reach * 1.05) want.push("thrust");
    if (opp.post === "crouch" || (opp.z || 0) > 0.4) want.push("sweep", "rise");
    for (const k of want) { const s2 = avail.find(x => x.key === k && x.zh !== last); if (s2) return s2; }
    const fresh = avail.filter(s => !isBasic(s) && recent.indexOf(s.zh) < 0);
    const freshAll = avail.filter(s => recent.indexOf(s.zh) < 0);
    // 基础招当"试探拳"保留两成：全是牌招反而不像真人打架
    if (fresh.length && (freshAll.length === fresh.length || sim.rng() < 0.8)) return fresh[Math.floor(sim.rng() * fresh.length)];
    if (freshAll.length) return freshAll[Math.floor(sim.rng() * freshAll.length)];
    const notLast = avail.filter(s => s.zh !== last);
    // 落到基础招时**按顺序轮换**（直拳→上勾拳→摆拳→…），不要一直出同一招
    const basics2 = avail.filter(isBasic).filter(s => s.zh !== last);
    if (basics2.length > 1) {
      const seen = recent.filter(z => basics2.some(b => b.zh === z)).length;
      return basics2[seen % basics2.length];
    }
    const pool = notLast.length ? notLast : avail;
    return pool[Math.floor(sim.rng() * pool.length)];
  }

  /** 连击候选：命中后追的那一拍——只用快招、不用终结/重击，且换一种招（避免无限终结链）*/
  function pickComboVariant(sim, f, opp, rng) {
    const recent = f.recentTech || [];
    const last = recent[recent.length - 1] || "";
    const pool = VARIANTS.filter(v => !v.air && !v.finisher && v.key !== "heavy" && v.zh !== last);
    if (!pool.length) return null;
    if ((opp.z || 0) > 0.3 || opp.post === "crouch") {
      const s = pool.find(v => v.key === "sweep" || v.key === "rise");
      if (s) return s;
    }
    return pool[Math.floor(rng() * pool.length)];
  }

  // ── 神通 ────────────────────────────────────────────────────────────────────
  //   设计：每条神通 = 冷却 + 每场上限 + 体力代价 + 条件（见 pickTrait），放出来就是一次"招式"，
  //   有起手/持续/结束；分身与多段伤害用 f.multi 队列在后续帧兑现，增益用 f.buff 计时。
  function traitReady(sim, f, tr) {
    const cd = (f.traitCd && f.traitCd[tr.key]) || -9;
    const used = (f.traitUsed && f.traitUsed[tr.key]) || 0;
    if (sim.t - cd < (tr.engine.cd || 8)) return false;
    if (used >= (tr.engine.perFight || 2)) return false;
    if (f.sta < (tr.engine.cost || 20) + 12) return false;
    return true;
  }
  function pickTrait(sim, f, opp, dist) {
    // 每场神通总上限：不设的话"神通刷屏"会把武打变成技能秀（实测：不设上限时 8 场出了 43 次）
    const cap = (f.sp && f.sp.traitCap != null) ? f.sp.traitCap : 5;
    if ((f.stats.traits || 0) >= cap) return null;
    for (const tr of f.traitList) {
      if (!traitReady(sim, f, tr)) continue;
      const k = tr.key;
      // 法相天地：只在对峙/终结时机放（对手血量见底或自己掉血过半），否则浪费
      if (k === "dharma") { if (!(opp.hp <= opp.hpMax * 0.55 || f.hp <= f.hpMax * 0.5 || opp.state === "down")) continue; }
      // 分身术：近身才放（分身是"多打几下"）
      if (k === "clone") { if (dist > f.reach * 3.2) continue; }
      // 七十二变：被压住/被连击时最想用（脱身＋破防）
      if (k === "transform") { if (!(f.hp <= f.hpMax * 0.75 || opp.guard <= 40 || dist > f.reach * 1.4)) continue; }
      // 筋斗云：用来抢位/脱离（距离远，或被压制）
      if (k === "somersault") { if (dist < f.reach * 2.2 && f.hp > f.hpMax * 0.6) continue; }
      // 天眼：对手有变化/护体/分身时才有意义
      if (k === "eye") { if (!(opp.guard > 55 || (opp.cloneLeft || 0) > 0 || (opp.buff && opp.buff.dur > 0))) continue; }
      // 三头六臂/风火轮：节奏增益，随时可用（但不会连放，靠冷却）
      return tr;
    }
    return null;
  }
  function startTrait(sim, f, tr) {
    const opp = f === sim.A ? sim.B : sim.A;
    { const toOpp2 = Math.atan2(opp.y - f.y, opp.x - f.x); f.faceTarget = toOpp2;
      if (Math.abs(angDiff(toOpp2, f.face)) <= Math.PI * 0.7) f.face = toOpp2; }
    const E2 = tr.engine || {};
    const cost = E2.cost || 20;
    // ⚠ 必须在这里**再查一次**冷却/上限：steer 是每帧跑的，同一个意图窗口里会调 5~7 次，
    //   只在 decide() 里判会连放同一招（实测：一次分身术在同一帧窗口里放了 7 遍）。
    if (!traitReady(sim, f, tr)) return false;
    if (f.sta < cost) return false;
    f.sta = Math.max(0, f.sta - cost);
    f.traitCd[tr.key] = sim.t;
    f.traitUsed[tr.key] = (f.traitUsed[tr.key] || 0) + 1;
    f.stats.traits = (f.stats.traits || 0) + 1;
    f.stats["trait_" + tr.key] = (f.stats["trait_" + tr.key] || 0) + 1;
    // 放完就"收起意图"：不让同一决策窗口继续重复触发，同时给自己一点收势时间
    f.intent = { kind: "spacing" };
    f.decideT = Math.max(f.decideT || 0, 0.35);
    const at = (extra) => Object.assign({ t: +sim.t.toFixed(3), type: "trait", who: f.id, trait: tr.key, zh: tr.zh,
      x: +f.x.toFixed(3), y: +f.y.toFixed(3), z: +(f.z || 0).toFixed(3) }, extra || {});
    const dist = Math.hypot(opp.x - f.x, opp.y - f.y);
    if (tr.key === "clone") {
      const count = Math.max(2, Math.min(4, E2.count || 3));
      // 分身：本体先出一下，其余分身错开半拍各补一下（用 multi 队列兑现）
      f.multi = { left: count - 1, dmg: (f.wpn.dmg || 8) * (E2.dmgMul || 0.55), gap: 0.14, next: sim.t + 0.14 };
      sim.events.push(at({ count: count, stage: "spawn" }));
      f.lastOutcome = "trait";
      return true;
    }
    if (tr.key === "transform") {
      // 变化：先"遮"（烟雾）再突袭；接下来 2.5 秒内的攻击带破防
      f.transformUntil = sim.t + 2.5;
      sim.events.push(at({ stage: "shift", guardBreak: E2.guardBreak || 0.55 }));
      f.lastOutcome = "trait";
      return true;
    }
    if (tr.key === "dharma") {
      // 法相天地：范围一击（半径按倍率放大）+ 天地异象
      const R = Math.max(3.2, f.reach * (E2.radiusMul || 2.6) * 2.2);
      sim.events.push(at({ stage: "rise", radius: +R.toFixed(2) }));
      sim.events.push({ t: +sim.t.toFixed(3), type: "phenomenon", who: f.id, by: f.id,
        tech: tr.zh, dharma: true, x: +opp.x.toFixed(3), y: +opp.y.toFixed(3), z: +(opp.z || 0).toFixed(3),
        radius: +R.toFixed(2), from: tr.zh, finisher: false,
        pillar: true, cracks: true, palette: (f.fx && f.fx.palette) || "", fxLevel: (f.fx && f.fx.level) || 8 });
      if (dist <= R) {
        applyHit(sim, f, opp, { dmg: (f.wpn.dmg || 8) * (E2.dmgMul || 1.8) * 0.6, kb: 3.4,
          arc: 360, h: "mid", zh: tr.zh, key: "dharma", finisher: false }, true);
      }
      f.lastOutcome = "trait";
      return true;
    }
    if (tr.key === "somersault") {
      // 筋斗云：一次性位移＋补满空中出手次数
      const toward = dist > f.reach * 2.0;
      const L = Math.min(9, Math.max(3.2, dist * (toward ? 0.72 : -0.75)));
      const ang = Math.atan2(opp.y - f.y, opp.x - f.x) + (toward ? 0 : Math.PI) + (f.rng() - 0.5) * 0.3;
      const nx = Math.max(0.6, Math.min(sim.arena.w - 0.6, f.x + Math.cos(ang) * L));
      const ny = Math.max(0.6, Math.min(sim.arena.h - 0.6, f.y + Math.sin(ang) * L));
      const dz = Math.min(sim.arena.z * 0.7, Math.max(1.6, (f.mob && f.mob.hover) || 2.0));
      sim.events.push(Object.assign(at({ stage: "leap", from: [+f.x.toFixed(2), +f.y.toFixed(2)], to: [+nx.toFixed(2), +ny.toFixed(2)] }),
        { x: +nx.toFixed(3), y: +ny.toFixed(3), z: +dz.toFixed(3) }));
      f.x = nx; f.y = ny; f.z = Math.max(f.z || 0, dz * 0.55);
      f.vz = Math.max(f.vz || 0, 1.2);
      f.airAtkLeft = Math.max(f.airAtkLeft || 0, f.mob && f.mob.airAtk ? f.mob.airAtk : 1);
      f.lastOutcome = "trait";
      return true;
    }
    if (tr.key === "sixarm") {
      f.buff = { dur: E2.dur || 6.0, rateMul: E2.rateMul || 1.7, speedMul: 1, key: tr.key };
      sim.events.push(at({ stage: "grow", rateMul: E2.rateMul || 1.7 }));
      f.lastOutcome = "trait";
      return true;
    }
    if (tr.key === "windfire") {
      f.buff = { dur: E2.dur || 8.0, rateMul: 1, speedMul: E2.speedMul || 1.5, key: tr.key };
      sim.events.push(at({ stage: "ignite", speedMul: E2.speedMul || 1.5 }));
      f.lastOutcome = "trait";
      return true;
    }
    if (tr.key === "eye") {
      // 天眼：破掉对手的变化/护体/分身，并带一次神光压制
      opp.cloneLeft = 0;
      if (opp.buff) { opp.buff.dur = 0; opp.buff = null; }
      opp.guard = Math.min(opp.guard, opp.guardMax * 0.35);
      sim.events.push(at({ stage: "open", strip: true, target: opp.id }));
      if (dist <= 12) {
        applyHit(sim, f, opp, { dmg: (f.wpn.dmg || 8) * (E2.dmgMul || 1.2) * 0.5, kb: 1.2,
          arc: 360, h: "mid", zh: tr.zh, key: "eye", finisher: false }, true);
      }
      f.lastOutcome = "trait";
      return true;
    }
    return false;
  }

  function startAttack(sim, f, v, chained) {
    const target = f === sim.A ? sim.B : sim.A;
    // ── 面对面（2026-09-25）：出手瞬间把朝向对准对手 ────────────────────────
    //   原来朝向在攻击期间完全锁死，于是"侧着身、甚至背对着"也能把招打出去（实测出招帧只有 95% 朝向对手，
    //   看着就不像在跟人打）。现在：背对超过约 112° → 先转身，这一拍不出手；否则出手瞬间对准对手。
    {
      const toOpp0 = Math.atan2(target.y - f.y, target.x - f.x);
      if (Math.abs(angDiff(toOpp0, f.face)) > Math.PI * 0.62) return false;
      f.face = toOpp0; f.faceTarget = toOpp0;
    }
    // 倒地守则（取 GPT 9.13）：自己倒地不能出手，也不追打已经倒地的对手
    if (f.rules.blockOnly || f.state === "down" || target.state === "down") return false;
    // 空中招由"机动档"解锁，不吃角色卡招式表（身法是等级能力，不是卡里的招式）
    if (v && v.air) {
      const okv = f.mob.airAtk > 0 && f.airAtkLeft > 0 && (!v.airOnly || f.z > 0.4) && (!v.wall || f.mob.wall);
      if (!okv) v = VARIANTS[0]; else f.airAtkLeft -= 1;
    }
    if (f.skills.length && !v.air) {
      const opp = f === sim.A ? sim.B : sim.A;
      const picked = chooseSkill(sim, f, v, opp);
      if (!picked) return false;                    // 整套招式都在冷却 → 由 steer 补一个"有目的的间隙动作"
      v = picked;
    } else if (f.skills.length && v.air && f.primaryNames && f.primaryNames.length) {
      // ── 空中也要打"自己的招式"（2026-09-25）────────────────────────────────
      //   原来空中招一律走 AIR_VARIANTS（空中连击／俯冲击／跃斩），于是 7 级以上的角色
      //   一打起来满场都是通用招名 —— "孙悟空主要用棍法"在空中就断了。现在空中优先套主战招式：
      //   动作仍是空中招（air/dive/高度带照旧），但**名字与招式身份**用角色自己的招式，
      //   并且照样吃它的冷却（空中不许变成主战招式的无限刷新点）。
      const opp = f === sim.A ? sim.B : sim.A;
      const airBase = v;
      const picked = chooseSkill(sim, f, v, opp);
      if (picked) {
        v = Object.assign({}, picked, { air: true, airOnly: airBase.airOnly, wall: airBase.wall,
          dive: airBase.dive, h: airBase.h, key: airBase.key, az: airBase.az });
      }
    }
    if(f.rules.noLeg && v.key==='sweep') v=VARIANTS[0];
    if(f.rules.heavy) v=Object.assign({},v,{dmg:Math.max(v.dmg,1.7),kb:Math.max(v.kb,2.1),slow:1.35});
    const slow = (v.slow || 1) / f.prof.rate / f.speed / ((f.buff && f.buff.rateMul) ? f.buff.rateMul : 1);   // 三头六臂之类：出手更快
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
          if (libMove.range && libMove.range.length === 2 && !v.kick) {
            // 库里的距离是按"中位兵器"（约 1.45 米）写的 → 换算成**相对倍率**再套到当前兵器上。
            // 直接按绝对值换算会把长兵器（棒 1.92／枪 2.44）的射程削短 → 频繁落空、打不完（实测踩过）
            // ⚠ 腿法**不参与**这条换算（2026-09-29）：脚长不长在兵器上——拿枪的人踢腿，
            //   按兵器倍率套会变成"3.3 米的侧踹"。腿法用自己的 v.reach 倍率。
            const REF_REACH = 1.45;
            const want = (libMove.range[0] + libMove.range[1]) / 2;
            patch.reach = Math.max(0.7, Math.min(1.7, want / REF_REACH));
          }
        }
        v = Object.assign({}, v, patch);
        _libState.used++;
      }
    }
    // Validate the selected move after its library timing/range have been applied.
    // Generic weapon reach alone cannot predict a short elbow or a long thrust.
    if (!v.air && !v.dive && target && target.hp > 0 && f.z < 0.05 && target.z < 0.05) {
      const leadT = Math.min(0.35, w);
      const predicted = Math.hypot(target.x + target.vx*leadT - f.x - f.vx*leadT,
                                   target.y + target.vy*leadT - f.y - f.vy*leadT);
      if (predicted > f.reach * (v.reach || 1) + CAP_R * 0.75) return false;
    }
    const cost = (10 + 8 * v.stam) * (f.wpnKey === "nodachi" ? 1.2 : 1) * (v.air ? 1.45 : 1);
    if (f.sta < cost * 0.5 && !f.style.ruthless) return false;
    f.sta = Math.max(0, f.sta - cost);
    if (v.dive) f.vz = Math.min(f.vz, -3.2);            // 俯冲：主动下压
    if (v.air && f.z > 0.4) {                           // 空中招自带突进，否则空战只剩原地对拼
      const tgt = (f === sim.A ? sim.B : sim.A);
      const toT = Math.atan2(tgt.y - f.y, tgt.x - f.x);
      // 空中招自带突进：按档位放大（2026-09-25）——地面冲刺到 12 m/s 之后，原来这点突进
      //   已经追不上"在天上绕圈"的对手（实测空战落空 11 次/场、KO 只有 3/6）。
      const rush = 2.4 + f.mob.dash * 1.1 + (f.prof.tier || 3) * 0.28;
      f.vx += Math.cos(toT) * rush; f.vy += Math.sin(toT) * rush;
    }
    f.chainDepth = chained ? (f.chainDepth || 0) + 1 : 0;   // 连招段数：非连招出手一律归零
    f.lastOutcome = null;
    f.state = "attack"; f.tech = v; f.techT = 0; f.atkStart = sim.t; f.hasHit = false; f.lastAtkT = sim.t;
    f.phase = "windup"; f.dur = { w, a, r };
    // 决胜期压迫（2026-10-01）：最后 20% 片长出招更快、收招更短 —— 保证"打得出结果"，
    //   而不是像旧版那样靠"把防守概率压到 0"来逼出胜负（那正是"最后几秒只会挨打"的来源）。
    if (sim.t > (sim.maxT || 30) * 0.8) f.dur = { w: w * 0.90, a: a, r: r * 0.78 };
    // 反击窗口（受身脱出后 0.9 秒）：起手与收招提速 30% —— 让"挨了三下之后的反击"真的打得进去，
    //   而不是又一次被对方的起手抢在前面（这是"被连到还不了手"的最后一环）。
    if (f.counterUntil && sim.t < f.counterUntil) { f.dur = { w: w * 0.7, a: a, r: r * 0.7 }; f.stats.counterWindows = (f.stats.counterWindows || 0) + 1; }
    // ── 招式套路（2026-10-01 用户要求）────────────────────────────────────
    //   「每个角色的招式不只是一个名字，而是**一整套组合套路**，里面包含的动作都要记录完整。」
    //   这里给这一招挂上套路：角色卡招式名优先匹配 → 同兵器套路 → 兜底；
    //   有 ≥2 个"打人"动作时把判定帧拉长，让每个动作都真的有自己的窗口。
    f.routine = null; f.seq = null; f.seqHit = null; f.seqN = 0; f.seqIdx = -1;
    try {
      const R = routineLib();
      if (R) {
        //   优先级：显式指定 → 招式名匹配（角色卡里的"日字冲拳"这类）→ 按"招式种类×兵器"挑一条（轮换，避免复读）
        const _roll = (f.routineRoll = (f.routineRoll || 0) + 1) + Math.floor(sim.t * 7);
        const _rt = v.routine ? (R.byKey.get(v.routine) || null)
          : (R.matchByName(v.zh)
             || R.forVariant(v.key, f.wpnKey === 'none' ? null : f.wpnKey, _roll)
             || (R.forWeapon(f.wpnKey === 'none' ? null : f.wpnKey)[0] || null));
        if (_rt) {
          const _hits = _rt.steps.filter(s => ROUTINE_HIT_ACTS.indexOf(s.act) >= 0);
          f.routine = _rt;
          f.seq = _hits.length ? _hits : _rt.steps.slice(0, 1);
          f.seqHit = {};
          //   空中招**不连段**：空中招本来就是一击定胜负的动作，套路段数留在素材里描述，
          //   但判定只算一次 —— 否则高等级空战的空中占比被地面连招挤掉（实测 7 级从 40% 掉到 30%）。
          if (v.air || v.dive) f.seq = f.seq.slice(0, 1);
          f.seqN = f.seq.length;
          //   ⚠ 判定帧**不拉长**：多个动作分摊原来那一小段 active（否则出招整体变长，
          //     对局节奏被全局改掉 —— 实测会把平均时长推到 25.2s、判定够不到的出手涨到 15.9%）。
          //     每一步在自己的子窗口里判定，逐帧检测足够命中。
        }
      }
    } catch (e) { f.routine = null; f.seq = null; f.seqN = 0; }

    // 记最近用过的招式（选招时避开复读；连击那一拍也要换招）
    const rt = f.recentTech || (f.recentTech = []);
    if (v.zh) { rt.push(v.zh); if (rt.length > 4) rt.shift(); }
    const dir = f.swingDir = -f.swingDir;
    const half = (v.arc * Math.PI / 180) / 2;
    f.arcFrom = f.face - half * dir; f.arcTo = f.face + half * dir;
    f.bladeAng = f.arcFrom; f.lastBladeAng = f.arcFrom;   // 刀锋角：判定帧逐帧扫过，而不是整个扇形一直"热"
    if(v.skillId) f.cooldowns[v.skillId]=sim.t+v.cooldown;
    f.stats.attacks++;
    sim.events.push({ t: +sim.t.toFixed(3), type: "attack", who: f.id, tech: v.zh, key: v.key,
                      dur: {w,a,r}, height:v.h, reach:f.reach*v.reach, skillId:v.skillId||null,
                      chain: f.chainDepth || 0, reason: chained ? "confirmed_followup" : "opening",
                      heavy: v.key === "heavy" || !!v.finisher, finisher: !!v.finisher,
                      z: +f.z.toFixed(3), air: !!v.air, dive: !!v.dive,
                      move: v.libMove || null,        // 招式库条目（名称/准备/出招/华丽效果/时间/距离/范围）
                      // 套路元数据：这一招是"一整套组合"而不是单招（素材/提示词要照着把动作全写出来）
                      routine: f.routine ? f.routine.key : null,
                      routineZh: f.routine ? (f.routine.style ? f.routine.style + '·' + f.routine.zh : f.routine.zh) : null,
                      routineNote: f.routine ? f.routine.note : null,
                      steps: f.routine ? f.routine.steps.map(s => s.zh) : null,
                      stepNotes: f.routine ? f.routine.steps.map(s => s.note) : null });
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
    // 这一下的结局（调用方要据此决定"要不要记成命中"）：hit / block / guardbreak / clash / iframes / none
    sim._last = { mode: "none" };
    // 接触时钟（2026-09-29）：任何一次"交手"（命中/被架住/对拼/闪开）都把两人的时钟归零。
    //   决定里的 impatient 分支读它 —— 时钟一过就必须再进一拍，这是"不脱手"的港式节奏的落点。
    atk.lastContactT = sim.t; def.lastContactT = sim.t;
    // 无敌帧（受身脱出/连段衰减给的短暂保护）：这一下判成"闪开了"，人和招式都照常走完 ——
    //   没有这条，第 4 下的"受身"只是换个动画继续挨打。
    if ((def.iframes || 0) > 0 && !clashed && !def.rules.noDodge) {
      def.stats.dodges++;
      sim._last = { mode: "iframes", tech: v.zh, spell: !!v.spell };
      sim.events.push({ t: +sim.t.toFixed(3), type: "dodge", who: def.id, by: atk.id, x: +def.x.toFixed(3), y: +def.y.toFixed(3),
                        crouch: false, zh: "受身脱出中，这一下从身侧擦空" });
      // 闪开也是"接手的起点"（港式：闪身 → 立刻反打），窗口比格挡略短
      if (def.sta > 20) { def.counterUntil = sim.t + 0.45; def.comboUntil = sim.t + 0.5; def.lastOutcome = "block"; def.chainDepth = 0; }
      return;
    }
    const base = (v.damage == null ? atk.wpn.dmg * v.dmg * atk.prof.dmg : v.damage * (atk.rules.heavy ? 1.7 : 1)) * (def.esc || atk.esc || 1) * (atk.rules.lowDmg ? 0.3 : 1);
    const tough = def.prof.tough;
    const dirAng = Math.atan2(def.y - atk.y, def.x - atk.x);
    if (clashed) {
      const kb = 0.9 * v.kb * atk.prof.dmg / def.prof.push;
      atk.vx -= Math.cos(dirAng) * kb; atk.vy -= Math.sin(dirAng) * kb;
      def.vx += Math.cos(dirAng) * kb; def.vy += Math.sin(dirAng) * kb;
      atk.hitstun = def.hitstun = Math.max(atk.hitstun, 0.16); atk.state = def.state = "hitstun";
      atk.stats.clashes++; def.stats.clashes++;
      atk.lastOutcome = "clash"; def.lastOutcome = "clash";
      // 对拼之后是**抢招**，不是各自站直（快节奏：接触完 0.3~0.5 秒内就要有下一拍）
      if (atk.sta > 22) { atk.comboUntil = sim.t + 1.0; atk.chainDepth = 0; }
      if (def.sta > 22) { def.comboUntil = sim.t + 1.0; def.chainDepth = 0; }
      sim._last = { mode: "clash", tech: v.zh, spell: !!v.spell };
    sim.events.push({ t: +sim.t.toFixed(3), type: "clash", a: atk.id, b: def.id, x: (atk.x + def.x) / 2, y: (atk.y + def.y) / 2,
                        z: +((atk.z + def.z) / 2).toFixed(3), air: !!(atk.z > 0.4 || def.z > 0.4) });
      return;
    }
    if (blocked) {
      const push = 0.5 * v.kb * (atk.prof.power / def.prof.power) * 3;
      def.vx += Math.cos(dirAng) * push / def.prof.push; def.vy += Math.sin(dirAng) * push / def.prof.push;
      def.guard -= base * 0.85 * v.stam;
      if(!["hitstun","stagger","down"].includes(def.state) && !ACTIONS.locked(def))def.state = "block"; def.blockHold = Math.max(def.blockHold, 0.22);
      def.stats.blocks++;   // 只有"防守方"记格挡（进攻方不记）
      sim._last = { mode: "block", tech: v.zh, spell: !!v.spell, guard: def.guard };
      atk.lastOutcome = "block"; def.lastOutcome = "block";
      // 被架住之后接着压：攻方 0.5 秒内可以再进一拍（"打不动就换招再打"是武打的基本节奏）
      if (atk.sta > 22) { atk.comboUntil = sim.t + 0.5; atk.chainDepth = 0; }
      // 挡完立刻接手反打（2026-09-29 修）：原来只给**攻方**继续压的窗口，防守方挡完什么都没有，
      //   于是"挡一下就各自站直"——格挡在画面上等于一次停顿，港片里最典型的"挡→卸→反打"永远接不上。
      //   现在给防守方一个短反击窗口（counterUntil：起手/收招各快 30%）＋ 连招窗口（comboUntil：下一拍直接出手）。
      if (def.sta > 20) { def.counterUntil = sim.t + 0.5; def.comboUntil = sim.t + 0.55; def.chainDepth = 0; }
    sim.events.push({ t: +sim.t.toFixed(3), type: "block", who: def.id, by: atk.id, tech: v.zh, x:+def.x.toFixed(3), y:+def.y.toFixed(3), guard: Math.round(def.guard),
                        z: +def.z.toFixed(3), spell: !!v.spell, dist: geo ? +geo.dist.toFixed(3) : null, reach: geo ? +geo.reach.toFixed(3) : null });
      if (def.guard <= 0) {                       // 崩防：被打空防守值 → 大硬直
        def.guard = 100 * 0.45; def.state = "stagger"; def.hitstun = 0.85;
        def.stats.guardBreaks++;
        sim._last = { mode: "guardbreak", tech: v.zh, spell: !!v.spell };
        sim.events.push({ t: +sim.t.toFixed(3), type: "guardbreak", who: def.id, by: atk.id });
      }
      return;
    }
    // ── 施法护体（仙神斗法，2026-09-25）─────────────────────────────────────
    //   长蓄力（仙神档 1.9×、9 级约 3 秒）期间，**第一次**被打中不打断施法：
    //   只扣护体（伤害减半、被推开半步），法术照样放完，并记一条 ward_hold 事件。
    //   没有这一条，长蓄力在近身对拼里永远放不完 —— "给足施法时间"就成了空话。
    if (def.state === "cast" && def.castSpell && !def.castWardUsed
        && ((def.fx && def.fx.level) || 1) >= 5 && ((def.sp && def.sp.chargeMul) || 1) > 1.1) {
      def.castWardUsed = true;
      // 重招震碎护体：法术推进去（伤害 70%、硬直减半）；轻招被护体卸掉（有爆点、人不受伤）
      if (v.spellHeavy) {
        sim._last = { mode: "wardbreak", tech: v.zh, spell: !!v.spell, dmg: 0 };
        def.guard = Math.max(0, def.guard - base * 0.5);
        sim.events.push({ t: +sim.t.toFixed(3), type: "ward_broken", who: def.id, by: atk.id, tech: def.castSpell.zh,
          from: v.zh, x: +def.x.toFixed(3), y: +def.y.toFixed(3), z: +def.z.toFixed(3),
          fxLevel: ((def.fx && def.fx.level) || 1), palette: (def.fx && def.fx.palette) || "" });
        v = Object.assign({}, v, { damage: (v.damage || 0) * 0.7, stun: Math.max(0.12, (v.stun || 0.2) * 0.5), spell: true });
        // 继续走"真命中"（不 return）
      } else {
        sim._last = { mode: "ward", tech: v.zh, spell: !!v.spell, dmg: 0 };
        const wardDmg = Math.max(0, base / Math.sqrt(tough) * 0.5);
        def.hp = Math.max(0, def.hp - wardDmg);
        def.guard = Math.max(0, def.guard - base * 0.35);
        def.vx += Math.cos(dirAng) * 1.8; def.vy += Math.sin(dirAng) * 1.8;
        def.stats.wardHolds = (def.stats.wardHolds || 0) + 1;
        sim.events.push({ t: +sim.t.toFixed(3), type: "ward_hold", who: def.id, by: atk.id,
          tech: def.castSpell.zh, from: v.zh, x: +def.x.toFixed(3), y: +def.y.toFixed(3), z: +def.z.toFixed(3),
          dmg: +wardDmg.toFixed(1), chargeT: +(def.castDur || 0).toFixed(2), castT: +(def.castT || 0).toFixed(2),
          fxLevel: ((def.fx && def.fx.level) || 1), palette: (def.fx && def.fx.palette) || "",
          shape: (def.fx && def.fx.shape) || "", light: (def.fx && def.fx.light) || "" });
        return;
      }
    }
    // 真命中
    const dmg = Math.max(0, base / Math.sqrt(tough));
    def.hp = Math.max(0, def.hp - dmg);
    // 连击窗口：打中之后短时间内容许追一拍（终结技不接，免得变成无限终结链）
    //   窗口要**盖过这一招自己的收招**（决策在 lockCheck 期间是停的，招打完才轮到决策）——
    //   原来 0.45 秒常常还没等到决策就过期，于是"打中一下就各自站直"（连打比例只有 26%）。
    atk.comboUntil = sim.t + (v.finisher ? 0 : 1.0);
    atk.comboWho = def.id;
    atk.comboN = (atk.comboN || 0) + 1;
    const kb = (1.6 + 2.2 * v.kb) * (atk.prof.power / def.prof.power) * 0.55;
    def.vx += Math.cos(dirAng) * kb; def.vy += Math.sin(dirAng) * kb;
    // 内力外放：等级 3 起，命中瞬间带一圈气劲（半径随等级放大，额外把对手震开）
    // 这是"绝世高手不能只会平A"的内核侧保证——气劲不只是远程技能，肉搏命中也会外放。
    const _F = atk.fx || {};
    const _qiBurst = (v.spellBurst != null)
      ? Math.max(0, v.spellBurst)                                                     // 法术：按招式半径给（不依赖内力档）
      : ((atk.qi && atk.qi.burst > 0) ? atk.qi.burst * (1 + ((_F.level || 1) - 1) * 0.18) : 0);
    if (_qiBurst > 0) {                        // 肉搏与气功命中都会外放内力（气功命中更该有气劲）
      const qiKb = kb * ((atk.qi && atk.qi.kb) || 0.25);
      def.vx += Math.cos(dirAng) * qiKb; def.vy += Math.sin(dirAng) * qiKb;
      if (v.dmg >= 1.6 && atk.qi && atk.qi.burst >= 1.2) def.vz = Math.max(def.vz, 0.6);   // 罡气级以上把对手真的掀起来
      atk.stats.qiBursts = (atk.stats.qiBursts || 0) + 1;
      const F = atk.fx || {};
      sim.events.push({ t: +sim.t.toFixed(3), type: "qi_burst", who: atk.id, by: atk.id, tech: (atk.qi && atk.qi.label) || v.zh || "气劲",
                        x: +def.x.toFixed(3), y: +def.y.toFixed(3), z: +def.z.toFixed(3),
                        radius: +_qiBurst.toFixed(2), kb: +qiKb.toFixed(2), spell: !!v.spell,
                        from: v.zh, tierPower: atk.prof.power, fxLevel: F.level || 1, fxName: F.name || "",
                        palette: F.palette || "", shape: F.shape || "", light: F.light || "",
                        destruction: F.destruction || [] });
    }
    // 天地异象：特效档 5 起，重击/终结时炸出「光柱＋冲击波环＋地裂」（风格档会整体上调档位）
    // 这是"仙侠大片感"的内核侧来源——异象是真结算出来的事件，不是提示词凭空编的。
    const FLV = (atk.fx && atk.fx.level) || 1;
    if (FLV >= 5 && (v.dmg >= 1.6 || v.finisher) && !(sim.lastPhenomenon != null && sim.t - sim.lastPhenomenon < 0.45)) {
      sim.lastPhenomenon = sim.t;
      atk.stats.phenomena = (atk.stats.phenomena || 0) + 1;
      const r = Math.max(1.2, ((atk.fx && atk.fx.scaleM) || 1) * (v.finisher ? 1.5 : 1));
      sim.events.push({ t: +sim.t.toFixed(3), type: "phenomenon", who: atk.id, by: atk.id,
                        tech: (atk.fx && atk.fx.name) || "", from: v.zh, finisher: !!v.finisher,
                        x: +def.x.toFixed(3), y: +def.y.toFixed(3), z: +def.z.toFixed(3), radius: +r.toFixed(2),
                        fxLevel: FLV, palette: (atk.fx && atk.fx.palette) || "", shape: (atk.fx && atk.fx.shape) || "",
                        light: (atk.fx && atk.fx.light) || "", destruction: (atk.fx && atk.fx.destruction) || [],
                        camera: (atk.fx && atk.fx.camera) || "", pillar: FLV >= 6, cracks: FLV >= 6, sky: FLV >= 7 });
      def.vz = Math.max(def.vz, FLV >= 7 ? 1.4 : 0.8);
      def.hitstun += 0.1;
    }
    // 重击/终结把对手真的打得离地（"击飞"从此有高度，不再是水平滑出去）
    // 击飞（2026-09-29 重做）：原来只有 v.kb>=1.5（重击/终结）才真被抛飞，而实战里重击极少出手 →
    //   实测 24 秒一场「命中 15.2 次、击飞 0.0 次」，全是贴地滑（平均击退 1.12 米）。现在按**冲量**给梯度：
    //   冲量 = 招式击退 × 力量比 ÷ √体格，中招也离地一点、重招抛得高，并按等级封顶（凡人不会飞五米）。
    {
      const _pow = (atk.prof.power || 1) / (def.prof.power || 1);
      const _imp = (v.kb || 1) * _pow / Math.sqrt(Math.max(1, def.prof.tough || 1));
            // ⚠ 2026-09-29 修：**按"要抛多高"反解速度**，不要直接拍速度值。内核重力 G_Z=20 m/s²，
      //   原来给的 1.1~4.7 m/s 只对应滞空 0.11~0.47 秒、最高 0.03~0.55 米 —— 实测"击飞"就是
      //   原地抖 0.1 秒（明细里 13 次有 12 次是 0.10~0.15 秒），画面上根本看不出被抛飞。
      //   现在：中招抛起 0.45~0.9 米、重击/终结 1.4~2.6 米，滞空 0.42~1.0 秒；等级越高抛得越高。
      const _apexCap = ((atk.prof.tier || 1) <= 2 ? 0.55 : ((atk.prof.tier || 1) <= 4 ? 0.9 : ((atk.prof.tier || 1) <= 6 ? 2.0 : 2.6 + ((atk.prof.tier || 1) - 6) * 0.35)));              // 等级分档：1~2 级 ≤0.55m、3~4 ≤0.9m、5~6 ≤2.0m、7+ 递增（飞天是等级解锁的能力）
      let _apex = 0;
      if (_imp >= 1.55) _apex = 1.4 + (_imp - 1.55) * 1.5;             // 重击/终结：真被抛飞
      else if (_imp >= 1.05) _apex = 0.45 + (_imp - 1.05) * 1.4;       // 中招：脚离地半米上下
      if (_apex > 0 && def.state !== "down" && (def.z || 0) < 0.6) {   // 已在空中的人不套"抛起"（他们在空中自有飞行控制）
        _apex = Math.min(_apexCap, _apex) * (def.post === "crouch" ? 0.75 : 1);
        const _vz = Math.sqrt(2 * G_Z * _apex);                        // v = √(2gh)：按目标高度反解
        if (_vz > def.vz + 0.15) {
          def.vz = _vz;
          def.launched = true; def.launchedAt = sim.t;
          def.airStun = 0;                                             // 重新开始算"凌空受身"的计时
          sim.events.push({ t: +sim.t.toFixed(3), type: "launch", who: def.id, by: atk.id, tech: v.zh,
            x: +def.x.toFixed(3), y: +def.y.toFixed(3), z: +def.z.toFixed(3), vz: +_vz.toFixed(2),
            apex: +_apex.toFixed(2), airT: +(2 * _vz / G_Z).toFixed(2),
            impulse: +_imp.toFixed(2), power: _pow > 1.05 ? "strong" : (_pow < 0.95 ? "weak" : "even") });
        }
      }
    }
    // 硬直：法术可以自带 v.stun（按威力放大）；肉搏照旧按 v.dmg 分档
    def.hitstun = Math.max(def.hitstun || 0, (v.stun != null ? v.stun : (v.dmg >= 1.6 ? 0.40 : v.dmg >= 1.05 ? 0.26 : 0.18)) * (1 + (def.prof.tough - 1) * 0.15));
    // 击倒（2026-09-29）：重手打在**踉跄/崩防/刚落地的失衡状态**上 → 直接躺倒，不必先被抛飞。
    // 击倒（2026-09-29）：三条触发，全部只对**地面、非飞行档**的人生效：
    //   ① 破势：重手打在踉跄/崩防/下蹲失衡上（港片"抓空门一招放倒"）；
    //   ② 连招收尾：被连到第 3 下以上再吃一下不算轻的（"连环打到最后一脚把人放倒"）；
    //   ③ 追击：对方已经在硬直中、这一下又不轻（趁势补倒）。
    //   ⚠ 触发条件是"或"关系，不能挂在 (v.kb>=1.55) 这个外层门后面（第一版就是这么写的 → 击倒仍只有 0.3 次/场）。
    {
      const _kdOk = !blocked && !clashed && def.hp > 0 && def.state !== "down"
                    && !def.mob.flight && (def.z || 0) <= 0.05;
      const _kdHeavy = (v.kb >= 1.45 || v.finisher);
      const _kdBreak = _kdHeavy && (def.state === "stagger" || def.guard <= 18 || (def.post === "crouch" && v.kb >= 1.9));
      const _kdCombo = def.hitsTaken >= 3 && v.kb >= 0.95 && sim.rng() < 0.5;   // 必须是"三连以上"：两连就倒会把第 4 下的"受身脱出"整条机制挤掉（实测受身次数变 0）
      const _kdChase = def.state === "hitstun" && v.kb >= 1.15 && sim.rng() < 0.45;
      if (_kdOk && (_kdBreak || _kdCombo || _kdChase) && !def.launched) {
                // ⚠ 这里只登记"要倒地"：applyHit 后面（def.state = "hitstun" 那行）会把状态覆盖掉，
        //   所以真正的倒地状态放在 applyHit 末尾统一生效（见 wantDown）。
        def.wantDown = true; def.post = "stand"; def.vz = 0;   // ⚠ 不动 z：归零会把半空的人瞬移到地面（3D 单帧跳 0.2m，实测被 test-rig 抓到）
        // 躺多久：基础 1.5 秒 + 按冲量/落点冲击加长（上限 2.6 秒）。用独立字段 downT 记，
        //   ⚠ 不能直接写 hitstun：后面"连段衰减 ×0.6"会把它乘掉（实测 1.1 秒被乘成 0.67 秒）。
        def.downT = Math.min(2.6, Math.max(1.5, 1.5 + ((v.kb || 1) - 1.05) * 0.6));   // 用 v.kb（_imp 是上面那个块的局部变量）
        def.hitstun = Math.max(def.hitstun, 1.1);
        def.iframes = Math.max(def.iframes || 0, 0.2);
        def.stats.knockdowns = (def.stats.knockdowns || 0) + 1;
        sim.events.push({ t: +sim.t.toFixed(3), type: "knockdown", who: def.id, by: atk.id, tech: v.zh,
                          x: +def.x.toFixed(3), y: +def.y.toFixed(3), z: 0, impact: 0, hp: +def.hp.toFixed(1),
                          how: _kdBreak ? "破势" : (_kdCombo ? "连招收尾" : "追击") });
      }
    }
    //   用户反馈："角色 B 像个弱智一动不动等着挨打"。实测（tools/passive-audit.js，120 场）平均是对称的，
    //   但有 20% 的场次出现"被连到还不了手"，最差一场有 6.5 秒没出手、受击硬直占 42% ——
    //   原因就是**没有任何连段衰减**：受击硬直 0.18~0.40 秒，而对手下一拍的起手正好接上，形成帧陷阱，
    //   受害者只能一直挨到对方节奏自己断掉。现在按格斗游戏的常规做法补三件：
    //     ① 连段计数：1.4 秒内连续挨打算一段；
    //     ② 第 3 下起硬直衰减（×0.6）＋ 被打得更开（击退 +0.35）→ 脱离对方射程；
    //     ③ 第 4 下起**强制受身脱出**：翻出去 + 0.4 秒无敌帧 + "脱出后优先反应"窗口，并记 combo_break 事件。
    def.hitsTaken = (sim.t - (def.lastHitT == null ? -9 : def.lastHitT) < 1.4) ? (def.hitsTaken || 0) + 1 : 1;
    def.lastHitT = sim.t;
    if (def.hitsTaken >= 3) {
      def.hitstun *= 0.6;
      def.iframes = Math.max(def.iframes || 0, 0.22);
      def.vx += Math.cos(dirAng) * 0.35 * 8; def.vy += Math.sin(dirAng) * 0.35 * 8;   // 被打得更开
    }
    // 2026-10-01：被连到第 2 下就"想办法出去"（翻滚脱出）——旧版要等到第 4 下才受身，
    //   观众看到的就是"连挨四拳只会站着挨打"。读招越好（等级/老谋深算）越容易提前脱出。
    if (def.hitsTaken >= 2 && def.state !== "down" && !def.wantDown && !def.launched && (def.z || 0) < 0.12 && (def.sta || 0) > 18 &&
        !def.rules.noDodge && sim.rng() < 0.26 + 0.34 * ((def.iq && def.iq.read) || 0.5)) {
      def.state = "dodge"; def.roll = 0.5; def._escape = true;
      //   ⚠ 不削减"这一下本身的硬直"（否则法术命中的反馈会被量成 <0.22 秒，test 会红）：
      //     脱出靠位移＋无敌帧＋脱出窗口，不靠把硬直抹掉。
      def.hitstun = Math.max(def.hitstun, 0.30);
      def.iframes = Math.max(def.iframes || 0, 0.30);
      def.vx += Math.cos(dirAng) * 5.0; def.vy += Math.sin(dirAng) * 5.0;
      def.sta = Math.max(0, def.sta - 14);
      def.escapeUntil = Math.max(def.escapeUntil || 0, sim.t + 0.6);
      def.counterUntil = Math.max(def.counterUntil || 0, sim.t + 0.6);
      def.stats.rolls = (def.stats.rolls || 0) + 1;
      def.stats.comboBreaks = (def.stats.comboBreaks || 0) + 1;
      // 记 combo_break（受身语义）：素材里读作"受身翻滚脱出"，不是又挨一下
      sim.events.push({ t: +sim.t.toFixed(3), type: "combo_break", who: def.id, by: atk.id, roll: true,
        hits: def.hitsTaken, x: +def.x.toFixed(3), y: +def.y.toFixed(3),
        zh: "被连到第 " + def.hitsTaken + " 下时受身翻滚脱出，起身已换到对手侧后" });
      def.hitsTaken = 0;
    }
    if (def.hitsTaken >= 4 && def.state !== "down" && !def.wantDown && !def.launched && !def.rules.noDodge && (def.z || 0) < 0.12) {
      def.state = "dodge"; def.roll = 0.5; def._escape = true;
      def.hitstun = Math.max(def.hitstun, 0.42); def.iframes = 0.40;
      def.vx += Math.cos(dirAng) * 6.2; def.vy += Math.sin(dirAng) * 6.2;
      def.escapeUntil = sim.t + 0.9;
      def.counterUntil = sim.t + 0.9;      // 这 0.9 秒里它的起手会更快（反击真的打得进去）
      // 连攻方也要"收一拍"：受身那一下把它震开并给一点硬直 ——
      //   否则它下一拍的起手照样能接上，受害者还是出不来（实测有整场 0 命中的极端场次）。
      atk.hitstun = Math.max(atk.hitstun || 0, 0.14);
      atk.vx -= Math.cos(dirAng) * 2.6; atk.vy -= Math.sin(dirAng) * 2.6;
      def.stats.comboBreaks = (def.stats.comboBreaks || 0) + 1;
      sim.events.push({ t: +sim.t.toFixed(3), type: "combo_break", who: def.id, by: atk.id, hits: def.hitsTaken,
                        x: +def.x.toFixed(3), y: +def.y.toFixed(3), z: +def.z.toFixed(3),
                        zh: "被连到第 " + def.hitsTaken + " 下时受身翻出，重新拉开距离" });
      def.hitsTaken = 0;
    }
        // ⚠ 受身/翻滚那一拍不能又被写成 hitstun —— 否则画面上还是"挨了一下站着"，
        //   受身只在事件层存在（2026-10-01 修：escape 那一拍保留 dodge 状态，看得出是翻出去）。
    if(v.spell && !def._escape)def.hitstun=Math.max(def.hitstun,.24);
    if (!def._escape) def.state = "hitstun"; else { def._escape = false; ACTIONS.beginRoll(sim, def, {escape:true}); }
    def.phase = "";
    // 击倒生效点（2026-09-29）：上面那一行会把状态统一写成 hitstun，所以"要倒地"必须放在它后面才不会被覆盖
    //   （第一版把 def.state="down" 写在前面 → 下一帧又变回 hitstun/move，实测 getup 永远不触发）。
    if (def.wantDown) { def.wantDown = false; ACTIONS.beginDown(sim, def, def.downT); }   // 躺的时间在这里落地（已过连段衰减）；fallT 归零＝这一跤**从 0 开始倒**（旧版只在第一跤重置，第二跤起 ft 直接是 1 → 一帧躺平，实测单帧胸口 0.256 米）
    const fromAir = atk.z > 0.4;
    atk.lastOutcome = "hit"; def.lastOutcome = "hit";
    // 连击计数：衔接技（如"大剑挥砍→黯然销魂掌"）靠它判断"该接招了"
    atk.hitStreak = (atk.hitStreak || 0) + 1; atk.lastHitAt = sim.t;
    def.hitStreak = 0;
    atk.stats.hits++; atk.stats.dmg += dmg;
    if (fromAir) atk.stats.airHits++;
    // 追逐战：追击者打中逃者的这一刻＝"被逼住，回身一搏"（只记一次，且逃者还没倒）
    if (sim.chase && sim.chase.chaser === atk.id && !sim.chase.corneredOn && def.hp > 0) {
      sim.chase.corneredOn = true;
      sim.chase.cornered = (sim.chase.cornered || 0) + 1;
      sim.events.push({ t: +sim.t.toFixed(3), type: "cornered", who: def.id, by: atk.id,
        x: +def.x.toFixed(3), y: +def.y.toFixed(3), z: +(def.z || 0).toFixed(3),
        zh: "被追上逼住，回身一搏" });
    }
    atk.combo = (sim.t - atk.comboT < 1.2) ? atk.combo + 1 : 1; atk.comboT = sim.t;
    atk.stats.maxCombo = Math.max(atk.stats.maxCombo, atk.combo);
    sim._last = { mode: "hit", tech: v.zh, spell: !!v.spell, dmg: dmg, stun: def.hitstun, kb: +kb.toFixed(2), ko: false };
    sim.events.push({ t: +sim.t.toFixed(3), type: "hit", who: def.id, by: atk.id, tech: v.zh,
                      height:v.h, damageExact:dmg, dmg: +dmg.toFixed(1), hp: +def.hp.toFixed(1), x: +def.x.toFixed(3), y: +def.y.toFixed(3), finisher: !!v.finisher,
                      z: +def.z.toFixed(3), az: +atk.z.toFixed(3), air: fromAir, dive: !!v.dive, spell: !!v.spell,
                      dist: geo ? +geo.dist.toFixed(3) : null, reach: geo ? +geo.reach.toFixed(3) : null,
                      ang: geo ? +geo.ang.toFixed(3) : null, arc: v.arc,
                      ox: geo && geo.ox != null ? +geo.ox.toFixed(3) : null, oy: geo && geo.oy != null ? +geo.oy.toFixed(3) : null,
                      ba: geo && geo.ba != null ? +geo.ba.toFixed(4) : null, ba0: geo && geo.ba0 != null ? +geo.ba0.toFixed(4) : null });
    // ── 打碎周围（2026-09-25）：扎实的一击要在地面上砸出后果 ──────────────
    //   命中点（打在对手身上）为中心，按等级给的破坏半径碎一圈：2 级约 1 米（顺手砸碎脚边的酒坛），
    //   6 级 6 米（木箱炸裂、柱角崩缺），9 级 14 米（院墙整段塌、石塔崩碎、碎片悬浮）。
    //   只有"扎实命中"才炸：轻招（v.dmg < 0.9）按半威力算，落地/拂袖之类不会凭空拆房子。
    {
      const _pw = Math.max(0.5, Math.min(2.0, (v.dmg || 1) / 1.1)) * (v.finisher ? 1.35 : 1) * (fromAir ? 1.15 : 1);
      const _R = blastRadius(atk.prof.tier, _pw);
      blast(sim, atk, def.x, def.y, _R, _pw, v.zh, true);   // true＝"真的打在人身上"（空地上也要震一下）
    }
    // 决胜（28 秒后）：血量低于 35% 的人被打中即终结 —— 久战必须分胜负，也让"最后几秒"有戏。
    const finish = def.hp <= 0 || (v.finisher && def.hp <= def.hpMax * 0.28) || (sim.t > 28 && def.hp <= def.hpMax * 0.35);
    if (finish) {
      def.hp = 0; def.state = def.z > 0.05 ? "hitstun" : "down"; def.fallT = 0; def.post = "stand"; def.hitstun = 3;
      def.mustLand = true; def.launched = def.z > 0; def.motion = null; // KO preserves the physical fall; no teleport to ground
      sim.events.push({ t: +sim.t.toFixed(3), type: "ko", who: def.id, x:+def.x.toFixed(3), y:+def.y.toFixed(3), by: atk.id, tech: v.zh, air: fromAir });
      if (sim._last) sim._last.ko = true;
    }
    return finish;
  }

  // ── 环境破坏半径 blast()（2026-09-25）──────────────────────────────────
  //   "高手打架把周围建筑物、道具都打碎，越厉害越夸张" 的内核落点。
  //   以前只有"挡在兵器线路上"的那一件会碎；现在每一次扎实的命中/法术落点都会按**破坏半径**碎一圈：
  //   半径与威力随等级放大（2 级约 1 米，9 级约 14 米——一掌下去院墙整段塌、石塔崩成碎块）。
  //   会产出：obstacle_hit（命中某件）→ prop_broken（碎了）→ debris（碎块飞散）→ quake（震荡/尘浪）
  //   → ground_scar（地面留痕，跨镜保留）。证据、3D 与提示词都吃这些事件。
  function blastRadius(tier, power) {
    const t = Math.max(1, Math.min(9, tier || 1));
    const ladder = [0, 1.0, 1.4, 2.2, 3.2, 4.6, 6.4, 9.0, 11.5, 14.5][t];
    return +(ladder * Math.max(0.55, Math.min(1.6, power == null ? 1 : power))).toFixed(2);
  }
  /** 破坏传播：以 (x,y) 为中心，半径 R 内的东西按威力受创；超出 1.6R 的不管
   *  solid：这一次冲击来自**真的砸在对手身上的扎实命中**（不是落地/撞碎/余波）。
   *    命中点周围正好空着时也要有后果 —— 见下面 quake 那一段。 */
  function blast(sim, f, x, y, R, power, cause, solid) {
    if (!sim.props || !sim.props.length || !(R > 0)) return { hit: 0, broke: 0, built: 0, builtBroke: 0 };
    const who = f ? f.id : null;
    const tier = Math.max(1, Math.min(9, (f && f.prof && f.prof.tier) || 1));
    const pw = power == null ? 1 : power;
    const out = { hit: 0, broke: 0, built: 0, builtBroke: 0 };
    const budget = 4 + tier;                      // 单次冲击最多碎几件（9 级 13 件：一掌推平一片院墙）
    let debrisN = 0, firstBroke = false;
    for (const pr of sim.props) {
      if (pr.broken) continue;
      const dx0 = pr.x - x, dy0 = pr.y - y, lim = R + pr.r;
      if (dx0 > lim || dx0 < -lim || dy0 > lim || dy0 < -lim) continue;   // 粗筛（省掉大量开方）
      const d = Math.sqrt(dx0 * dx0 + dy0 * dy0);
      if (d > lim) continue;
      // 近距离＝直击力度，边缘＝余波（碎片飞溅但不一定碎）
      const falloff = Math.max(0.22, 1 - d / (R + pr.r));
      // 破坏力度阶梯（2026-09-25）：1~2 级几乎只有"顺手砸碎脚边的东西"，越高越夸张。
      //   小件（tough 1）在 6 级约一击就碎；建筑（tough 2~3）要 6 级起才整段垮；
      //   山门/石塔（tough 5）只有 8~9 级那种量级才崩得下来。
      const LADDER = [0, 0.35, 0.5, 0.8, 1.2, 1.7, 2.3, 3.2, 4.2, 5.4];
      const dmg = LADDER[tier] * pw * falloff;
      pr.hit += dmg;
      out.hit++;
      if (pr.building) { out.built++; }
      const broke = pr.hit >= pr.tough && out.broke < budget;
      if (broke) {
        pr.broken = true; out.broke++;
        if (pr.building) out.builtBroke++;
        firstBroke = true;
        pr.brokenBy = cause || "";
        sim.events.push({ t: +sim.t.toFixed(3), type: "obstacle_hit", who: who, by: who, prop: pr.id, propName: pr.zh,
          x: +pr.x.toFixed(3), y: +pr.y.toFixed(3), z: 0, tech: cause || "", broke: true,
          building: !!pr.building, mega: !!pr.mega, heavy: true, radius: +R.toFixed(2),
          dist: +d.toFixed(2), blast: true });
        sim.events.push({ t: +sim.t.toFixed(3), type: "prop_broken", who: who, prop: pr.id, propName: pr.zh,
          x: +pr.x.toFixed(3), y: +pr.y.toFixed(3), z: 0, building: !!pr.building, mega: !!pr.mega,
          tech: cause || "", radius: +R.toFixed(2), tier: tier });
        // 碎块飞散：件数与散布半径随等级放大（大片里的"碎石乱飞、瓦片剥落"）
        const pieces = Math.round(3 + tier * 1.6 + (pr.mega ? 6 : pr.building ? 3 : 0));
        debrisN += pieces;
        sim.events.push({ t: +sim.t.toFixed(3), type: "debris", who: who, prop: pr.id, propName: pr.zh,
          x: +pr.x.toFixed(3), y: +pr.y.toFixed(3), z: +Math.max(0.4, pr.r * 0.7).toFixed(3),
          pieces: pieces, spread: +(pr.r + R * 0.45).toFixed(2), zh: pr.mega ? "山石崩落、碎块悬浮" : (pr.building ? "砖石瓦片剥落飞散" : "木屑陶片四散"),
          building: !!pr.building, mega: !!pr.mega, tech: cause || "" });
      } else {
        sim.events.push({ t: +sim.t.toFixed(3), type: "obstacle_hit", who: who, by: who, prop: pr.id, propName: pr.zh,
          x: +pr.x.toFixed(3), y: +pr.y.toFixed(3), z: 0, tech: cause || "", broke: false,
          building: !!pr.building, radius: +R.toFixed(2), dist: +d.toFixed(2), blast: true });
      }
    }
    // 震荡（7 级起）：地面震动 + 尘浪，只有"真的有东西被砸到/碎掉"或半径够大才发，免得刷屏
    //   2026-10-01 修回归：门槛里的 R≥5 本来是"这一击够不够重"的代理，但套路改成**按式结算**后
    //   单式的 v.dmg 被"整招伤害归一"摊薄（0.75 / 0.68，而整招是 1.12）→ 6 级破坏半径从 6.5m
    //   塌到 4.0m，R≥5 失效；命中点周围又正好空着（out.hit===0）→ 既没有 obstacle_hit 也没有
    //   quake，于是"命中了却四周一点动静都没有"（实测 6 级 5 场 63 次命中有 3 次白打，占 4.8%）。
    //   判据改成：**空地上的一次真实命中（solid）也必震** —— 不额外动任何道具/半径，
    //   所以对局平衡（谁被什么挡住、碎了几件）一个字都不变。
    if (tier >= 6 && (out.broke > 0 || R >= 5 || (solid && out.hit === 0))) {
      sim.events.push({ t: +sim.t.toFixed(3), type: "quake", who: who, x: +x.toFixed(3), y: +y.toFixed(3),
        radius: +R.toFixed(2), pieces: debrisN, building: out.builtBroke > 0, mega: out.builtBroke > 0 && tier >= 8,
        tech: cause || "", zh: tier >= 8 ? "地裂墙塌、尘浪掀翻整片场地" : "地面震荡、尘土扬起" });
      if (f) f.stats.quakes = (f.stats.quakes || 0) + 1;
    }
    if (f) {
      f.stats.destroys = (f.stats.destroys || 0) + out.broke;
      f.stats.debris = (f.stats.debris || 0) + debrisN;
    }
    if (firstBroke) sim._brokeAny = true;
    return out;
  }

  // 最近的可用掩体（阵地战/追逐战"借掩体"用）
  function nearProp(sim, f, maxD) {    let best = null, bd = maxD == null ? 2.2 : maxD;
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
    if (sim.t < (f.castReadyAt || 0)) return false;
    const requestedForm=SKILLS?.get(sp?.formKey||sp?.zh);if(requestedForm?.requiresAir&&f.z<=.4)return false;
    const named = SKILLS?.select(sp?.formKey || sp?.zh, f.formCursor || 0, f.z > .4);
    if (named && (f.prof.tier < named.tiers[0] || named.requiresAir && f.z <= .4)) return false;
    const originalSpell = sp;
    if (named) sp = {...sp,zh:named.zh,formKey:named.key,reach:Math.min(sp.reach||18,named.targeting?.range||18)};
    if (!f.spells || !f.spells.length || !sp) return false;
    if ((f.spellCd[sp.id] || 0) > sim.t) return false;
    const cost = 14 + (sp.damage || 20) * 0.35;
    if (f.sta < cost) return false;
    // 施法需要空间：贴身（<2.2 米）不起手——否则高等级会变成"贴脸对轰法术"，近战与身法全废
    {
      const o0 = f === sim.A ? sim.B : sim.A;
      // 衔接招式（「黯然销魂掌」这类）本来就是贴身用的：是机会窗口放出来的，不受"起手要空间"限制
      if (!sp.linkOnly && Math.hypot(o0.x - f.x, o0.y - f.y) < 2.2) return false;
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
          // 命中文本只取「命中＋反馈」：起手/发力已经写在施法句里，重复就没意义了
          zh: lib.zh, prep: lib.prep, fire: lib.act,
          hit: (typeof MOVES.impactOf === "function" ? MOVES.impactOf(lib) : lib.effect),
          charge: lib.timing.charge, release: lib.timing.recover, radius: eff.radius
        });
      }
    }
    if(named){eff={...eff,zh:named.zh,prep:named.prep,fire:named.act,shape:named.fx?.shape||named.fx?.form,hit:SKILLS.fxDescription(named,'hit'),charge:named.timing.charge,release:named.timing.travel||named.timing.recover,form:named,particles:named.fx?.particles,light:named.fx?.light};f.formCursor=(f.formCursor||0)+1;}
    const cRange0 = scaledRange(eff.charge, f.prof.tier, f.qi);
    // ── 施法时间（2026-09-25 用户要求"给足法术施法时间"）────────────────────
    //   蓄力时长 = 招式档 × 风格档（仙神斗法 1.9） × 等级档（7 级起每级 +28%）。
    //   上限 4.2 秒：再长就成站着不动，武打节奏会断。
    const _SP0 = f.sp || {};
    const chargeMul = (_SP0.chargeMul == null ? 1 : _SP0.chargeMul) * (1 + Math.max(0, f.prof.tier - 6) * 0.28);
    const cRange1 = [Math.min(4.2, cRange0[0] * chargeMul), Math.min(4.6, cRange0[1] * chargeMul)];
    // 长蓄力（>1.8 秒）在贴身时压缩成速发版本 —— 但**7 级以上不压**：神仙斗法本来就该"长蓄力＋护体硬吃"，
    //   压掉了就没有施法时间可言（用户反馈的正是这一点）。
    const opp0 = f === sim.A ? sim.B : sim.A;
    const gap = Math.hypot(opp0.x - f.x, opp0.y - f.y);
    const cRange = (cRange1[1] > 1.8 && gap < 3.5 && f.prof.tier < 7) ? [Math.min(cRange1[0], 0.8), 1.2] : cRange1;
    f.castDur = pickInRange(sim, cRange);
    f.castQuick = cRange !== cRange1;
    f.castEff = eff; f.castRange = cRange;
    f.state = "cast"; f.castT = 0; f.castSpell = sp;f.castSourceId=originalSpell.id;
    // 施法要正对目标（用户：「法术释放不是攻击对手」）：起手即对准，蓄力期间还会跟着对手微调
    {
      const toOpp1 = Math.atan2(opp0.y - f.y, opp0.x - f.x);
      f.face = toOpp1; f.faceTarget = toOpp1;
    }
    f.castWardUsed = false;                                   // 施法护体：每次施法只挡一次打断
    f.stats.castsStarted = (f.stats.castsStarted || 0) + 1;
    f.stats.chargeT = (f.stats.chargeT || 0) + f.castDur;
    // 起手不再"刹停"（2026-09-25 快节奏）：只把速度收到 70%，接着由 castSteer 决定"踏罡步斗"往哪走。
    //   原来这里 *= 0.35 配合 cast 期间不跑 steer，等于站着念咒 2~4 秒（实测 9 级对局 71% 的帧在 cast）。
    f.vx *= 0.7; f.vy *= 0.7;
    f.castMode = null; f.castMoveT = -9; f.castCancelled = false;
    f.stats.spellCasts++;
    if (sp.linkOnly) { f.stats.linkCasts = (f.stats.linkCasts || 0) + 1; f.lastLinkT = sim.t; }
    const opp = f === sim.A ? sim.B : sim.A;
    sim.events.push({ t: +sim.t.toFixed(3), type: "spell_cast", who: f.id, tech: sp.zh, key: "spell", link: !!sp.linkOnly,
                      x: +f.x.toFixed(3), y: +f.y.toFixed(3), z: +f.z.toFixed(3),
                      dist: +Math.hypot(opp.x - f.x, opp.y - f.y).toFixed(2), reach: sp.reach,
                      formKey:named?.key||null, targeting:named?.targeting||null, vfx:named?.fx||null, chargeRange: cRange, chargeT: f.castDur, chargeMul: +chargeMul.toFixed(2), shape: eff.shape, track: !!eff.track,
                      prep: eff.prep, effect: eff.fire, radius: eff.radius,
                      move: { zh: eff.zh || sp.zh, prep: eff.prep, act: eff.fire, effect: eff.hit,
                              timing: { charge: cRange, active: [0.05, 0.10], recover: named?.timing.recover || eff.release || [0.2, 0.36] },
                              range: eff.range || null, arc: 26, band: "mid",
                              source: named ? "repertoire" : (MOVES && MOVES.get(sp.zh)) ? MOVES.get(sp.zh).source : "auto" } });
    // 灵光/罡气护体：特效档 5 起，起手蓄气时体表亮起一圈光膜（aura 事件，供 3D 预览与提示词用）
    const FA = f.fx || {};
    if (((FA.level || 1) >= 5) && !f.auraOn) {
      f.auraOn = true; f.auraT = sim.t;
      f.stats.auras = (f.stats.auras || 0) + 1;
      sim.events.push({ t: +sim.t.toFixed(3), type: "aura", who: f.id, by: f.id, tech: sp.zh,
                        x: +f.x.toFixed(3), y: +f.y.toFixed(3), z: +f.z.toFixed(3),
                        radius: +Math.max(0.5, (FA.scaleM || 1) * 0.6).toFixed(2), hold: +f.castDur.toFixed(2),
                        fxLevel: FA.level || 1, palette: FA.palette || "", shape: FA.shape || "",
                        light: FA.light || "", shapeKind: (FA.level || 1) >= 8 ? "法相虚影" : "护体光膜" });
    }
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
    f.face = a;                              // 脱手那一刻身体正对弹道方向（画面里才像"打向对手"）
    const id = "S" + (++sim.shotSeq);
    const track = !!eff.track;
    sim.shots.push({ id, owner: f.id, sp, dmg: sp.damage, spd, eff,
      x: f.x + Math.cos(a) * 0.45, y: f.y + Math.sin(a) * 0.45, z: f.z + 1.15,
      vx: Math.cos(a) * spd, vy: Math.sin(a) * spd,
      life: +(actualFly + 0.55).toFixed(2), flyT: flyT, actualFly: actualFly, track: track, turn: eff.turn || 0.8,
      // 垂直跟踪（2026-09-25）：空战里双方高度一直在变，弹道原来只走水平线 → 从脚底下穿过去、
      //   "法术漫天飞却打不着"（实测空战 6 场里有 3 场首 5 秒全是 spell_fade）。给弹道一个有限的上/下修正速度。
      vz: 0, vCap: 3.5 });
    sim.events.push({ t: +sim.t.toFixed(3), type: "spell_release", who: f.id, tech: sp.zh, shot: id,
                      x: +f.x.toFixed(3), y: +f.y.toFixed(3), z: +(f.z + 1.15).toFixed(3), spd: +spd.toFixed(1), dist: +d.toFixed(2),
                      formKey:sp.formKey||null, targeting:eff.form?.targeting||null, vfx:eff.form?.fx||null, recoverT:f.castRecovery||0, releaseRange: rRange0, releaseT: flyT, actualFly: actualFly, direction:+a.toFixed(4), shape: eff.shape, track: track, fire: eff.fire, radius: eff.radius });
    f.stats.castsDone = (f.stats.castsDone || 0) + 1;
    // ── 特效密度（仙神档）：脱手那一刻在身周炸开一圈气劲；7 级以上再抬一次"抬头能看见"的天象 ──
    //   目的：让"特效漫天飞"变成内核真的产生的事件流（证据里的 counts 与【特效清单】都靠它）。
    const _FD = (f.sp && f.sp.fxDensityMul) || 1;
    const _FL = (f.fx && f.fx.level) || 1;
    if (_FD > 1.2 && _FL >= 5) {
      f.stats.qiBursts = (f.stats.qiBursts || 0) + 1;
      sim.events.push({ t: +sim.t.toFixed(3), type: "qi_burst", who: f.id, by: f.id, tech: sp.zh,
        x: +f.x.toFixed(3), y: +f.y.toFixed(3), z: +(f.z + 1.0).toFixed(3),
        radius: +Math.max(0.6, ((f.fx && f.fx.scaleM) || 1) * 0.45).toFixed(2), kb: 0,
        from: sp.zh, tierPower: f.prof.power, fxLevel: _FL, fxName: (f.fx && f.fx.name) || "",
        palette: (f.fx && f.fx.palette) || "", shape: (f.fx && f.fx.shape) || "", light: (f.fx && f.fx.light) || "",
        destruction: [], release: true });
      if (_FL >= 7 && _FD > 1.4 && !(sim.lastSky != null && sim.t - sim.lastSky < 0.9)) {
        sim.lastSky = sim.t;
        f.stats.phenomena = (f.stats.phenomena || 0) + 1;
        sim.events.push({ t: +sim.t.toFixed(3), type: "phenomenon", who: f.id, by: f.id,
          tech: (f.fx && f.fx.name) || "", from: sp.zh, finisher: false,
          x: +f.x.toFixed(3), y: +f.y.toFixed(3), z: +(f.z + 1.2).toFixed(3),
          radius: +Math.max(2.4, ((f.fx && f.fx.scaleM) || 1) * 1.6).toFixed(2),
          fxLevel: _FL, palette: (f.fx && f.fx.palette) || "", shape: (f.fx && f.fx.shape) || "",
          light: (f.fx && f.fx.light) || "", destruction: [], camera: (f.fx && f.fx.camera) || "",
          pillar: true, cracks: false, sky: true, atRelease: true });
      }
    }
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
    const lead = Math.min(0.35, swingT * 1.0);
    const distLead = Math.hypot((opp.x + opp.vx * lead) - f.x, (opp.y + opp.vy * lead) - f.y);
    const oppFast = Math.hypot(opp.vx - f.vx, opp.vy - f.vy) > 6;        // 用"相对速度"：一起滑行（水战）不算逃得掉
    // 地面：对手越快越只打十拿九稳的；空战：空中招自带突进（俯冲/扑击会自己拉近），放宽
    const airy = f.z > 0.3 || opp.z > 0.3;
    const strikeNow = distLead <= f.reach * (airy ? 1.78 : (oppFast ? 0.95 : 1.05));
    // 防僵局（2026-09-25 实测）：预判提前量遇上"一直在闪"的对手时，distLead 永远大于射程 →
    //   人会一直"追着对手的闪避跑"、十秒不出手（自检的"站着被压"就是这么来的）。
    //   物理上已经贴进射程（≤reach×1.25）且自己 2.2 秒没出手 → 强制 commit（宁可打空，也不能站着不打）。
    const idleAtk = sim.t - (f.lastAtkT == null ? -9 : f.lastAtkT);
    const forceCommit = dist <= f.reach * 1.25 && idleAtk > 1.2 && f.sta > 24;
    const swing = (reason, variant) => (strikeNow || forceCommit)
      ? { kind: "attack", variant: variant || pickVariant(f, opp, rng), reason }
      : { kind: "approach", reason: String(reason) + "-close" };
    // 对手已倒地：不再追打，稳住架势看着对手（收势）
    if (opp.state === "down") {
      if (opp.hp <= 0) return { kind: "stand" };
      // A knockdown is a tactical reset, not the end: circle to a new angle
      // while the opponent rises, rather than standing still for two seconds.
      return f.sta < 30 ? {kind:"recover",reason:"knockdown_reset"} :
        {kind:"flank",dir:f.id === "A" ? 1 : -1,reason:"watch_recovery"};
    }
    if (f.sta < 22) return { kind: "recover", reason: "stamina" };
    // Match an airborne opponent before ground combo/stance choices consume the
    // decision. Existing flight budget, stamina and cooldown still apply.
    if (f.mob.flight && f.z < 0.3 && opp.z > 1.5 && f.sta > 34 &&
        f.airCd <= sim.t && sim.t >= (f.flightCd || -9) &&
        (f.flights || 0) < flightCap(f) && canLeap(f, sim, 26, "flight")) {
      return {kind:"takeoff",reason:"airDuel"};
    }
   // 体力见底先回气（取 GPT 9.13），而不是站着发呆
    // ⓪-2 连招窗口（取 GPT 9.13 的收紧版，2026-09-25 放宽节奏）：必须**有接触结果**
    //   （命中 / 被架住 / 对拼 —— 架住与对拼也要接着压，不然"一招被挡就各自站直"），最多四段、
    //   双方高度合理、不追打倒地者，而且够得着。
    if (f.comboUntil && sim.t < f.comboUntil && ["hit", "block", "clash"].indexOf(f.lastOutcome) >= 0 &&
        (f.chainDepth || 0) < 3 && opp.state !== "down" && f.z < 0.1 && opp.z < 0.5 && distLead <= f.reach * 1.14) {
      const cv = pickComboVariant(sim, f, opp, rng);
      if (cv) { f.lastOutcome = "linked"; return { kind: "attack", variant: cv, reason: "combo" }; }
    }
    // ⓪-3 神通（2026-09-25 新增）：分身术 / 七十二变 / 法相天地 / 筋斗云 / 三头六臂 / 天眼 / 风火轮。
    //   条件与"该不该现在放"都写在这里；真正的结算在 startTrait()。
    if (f.traitList && f.traitList.length && f.state !== "cast" && f.state !== "attack" && sim.t > 1.2) {
      const tr = pickTrait(sim, f, opp, dist);
      if (tr) return { kind: "trait", trait: tr, reason: "trait:" + tr.key };
    }
    // ── 起跳之后必须接上文（2026-09-25）：刚落地的 1.3 秒内只要够得着就立刻出手，
    //    不许"跳完站着"。这样每一次跳跃在画面上都有下文（跳过去 → 打），不再是无意义的蹦。
    if (f.engageUntil && sim.t < f.engageUntil && f.z < 0.6 && opp.state !== "down" && f.sta > 18) {
      if (distLead <= f.reach * 1.35) {
        const v0 = pickVariant(f, opp, rng);
        f.engageUntil = 0;
        return { kind: "attack", variant: v0, reason: "afterLeap" };
      }
      f.engageUntil = 0;
      return { kind: "approach", reason: "afterLeap-close" };
    }
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
      if (edge < 1.6 || dist < 1.5 || (dist < 3.2 && sim.t - (f.lastHitT || -9) < 1.2)) {
        // 被追上、或刚被打了一下（1.2 秒内 2.4 米内）也算被逼住：22×8 的长街里逃者很少真的顶到墙角
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
      // 打斗风格（近战对拼 / 法术为主 / 近战衔接法术…）在这里生效：施法概率、每场上限、出手间隔
      const SP = f.sp || {};
      const gap = Math.max(0.6, (2.6 - (f.tier || 1) * 0.12) * (SP.gapMul || 1));
      const maxCasts = Math.max(1, Math.round((2 + (f.tier || 1) * 0.6) * (SP.maxCastsMul == null ? 1 : SP.maxCastsMul)));
      const sinceCast = sim.t - (f.lastCastT == null ? -9 : f.lastCastT);
      // ── 衔接招式（「重剑挥砍 → 黯然销魂掌」）：判定排在最前面，并且**不吃普通施法的额度** ──
      //   理由：近战对拼风格（castChanceMul 0.30 / 每场法术上限 0.4×）本来就几乎不施法，
      //   如果衔接也共享法术额度，实战里就永远看不到衔接（实测 melee 风格 0 次衔接）。
      //   它有自己的机会判据与冷却/上限：机会 = 连招段数≥1／连中 linkAfterHits 下／
      //   对手正在硬直·崩防·倒地·收招／刚被自己打中 1.2 秒内。
      if (f.linkNames && f.linkNames.length && f.sta > 20 && dist > 0) {
        //   节奏按风格给定（h3-styles 的 linkGap/linkCap）：近战对拼＝衔接是"偶尔的变招"，
        //   近战衔接法术＝衔接是节奏的一半；没给就按出手间隔折算。
        const linkGap = SP.linkGap == null ? (1.5 + (SP.gapMul || 1) * 1.5) : SP.linkGap;
        const linkCap = SP.linkCap || 4;
        if (sim.t - (f.lastLinkT == null ? -9 : f.lastLinkT) >= linkGap && (f.stats.linkCasts || 0) < linkCap) {
          const lk = f.spells.filter(sp => (f.spellCd[sp.id] || 0) <= sim.t
            && f.linkNames.indexOf(sp.zh) >= 0 && dist <= sp.reach
            && dist >= Math.min(0.5, sp.reach * 0.30));
          const oppOpen = (opp.state === "hitstun" || opp.state === "stagger" || opp.state === "down"
            || (opp.state === "attack" && opp.phase === "recovery")
            || (sim.t - (f.lastHitAt == null ? -9 : f.lastHitAt)) < 1.2);
          const chainNow = (f.chainDepth || 0) >= 1 || (f.hitStreak || 0) >= (SP.linkAfterHits || 2) || oppOpen;
          const linkChance = (SP.linkChance == null ? 0.5 : SP.linkChance);
          if (lk.length && chainNow && rng() < linkChance) return { kind: "cast", spell: lk[0], reason: "link" };
        }
      }
      // 保持距离（法术/游走风格）：贴太近先撤——但对手倒地/自己被压住时不撤
      //   贴太近先撤——但对手倒地/被压住时不撤，而且**只有"撤开之后真的能施法"才撤**：
      //   否则两边贴身互退、谁都不出手，就成了死锁（实测 caster/skirmish 30 秒 0 命中）。
      if (SP.keepRange && dist < SP.keepRange * 0.62 && opp.state !== "down" && f.sta > 24) {
        const canCastSoon = f.spells.some(sp => !sp.linkOnly && (f.spellCd[sp.id] || 0) <= sim.t + 0.8);
        if (canCastSoon && f.stats.spellCasts < maxCasts) {
          return { kind: "retreat", dist: SP.keepRange, dir: rng() < 0.5 ? -1 : 1, reason: "keepRange" };
        }
      }
      // 近战风格：够得着就宁可靠近打，不站着对轰（只对"明显在兵器射程外"的情况例外）
      const wantCast = !(SP.approachCast && dist > f.reach * 1.6 === false && dist <= f.reach * 1.6);
      if (wantCast && f.stats.spellCasts < maxCasts && sinceCast >= gap) {
        const ready = f.spells.filter(sp => !sp.linkOnly && (f.spellCd[sp.id] || 0) <= sim.t && f.sta > 14 + (sp.damage || 20) * 0.35);
        // 高等级不再"必须够不着才隔空打"：罡气级以上贴身也能放，近身下限随等级下探
        const minR = (f.qi && f.qi.burst >= 1.0) ? 0.8 : 1.6;
        const inR = ready.filter(sp => dist <= sp.reach && dist >= Math.min(minR, sp.reach * 0.35));
        if (inR.length) {
          // 明显在兵刃射程外 → 一定隔空打；贴身时只有小概率放（贴身主要靠气劲外放，不靠弹道）
          const outOfReach = dist > f.reach * 1.6;
          const chance = (0.08 + (f.qi ? f.qi.castBonus : 0)) * (SP.castChanceMul == null ? 1 : SP.castChanceMul);
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
      const idleAir = sim.t - (f.lastAtkT || 0);
      // 双方都在空中＝**空战**（用户要求 7 级以上浮空战斗）：这时不往地上钻，
      //   而是"抢高度 → 压下去 → 再拉起来"，把空战打满；只有对手落地了才俯冲追下去。
      const airDuel = f.mob.flight && opp.z > 1.2;
      if (airDuel && f.sta > 20 && idleAir < 3.2 + s.patience * 1.8) {
        if (opp.z > 0.5 && f.z < opp.z + 0.7) return { kind: "hover", reason: "airClimb" };   // 抢高度
        return { kind: "hover", reason: "airDuel" };
      }
      // 悬空太久没出手（谁都不许靠滞空拖时间）→ 直接俯冲压下来打
      //   2026-09-29 修：原来这里写死 AIR_VARIANTS[3]（俯冲击），绕过了"避开复读"的逻辑，
      //   实测一场 24 秒里同一招「俯冲击」出现 8~10 次 —— 观众看到的就是"这人只会这一招"。
      //   现在：优先挑一个**最近两拍没用过**的俯冲类变体，实在没有才退回通用挑法。
      if (f.airAtkLeft > 0 && idleAir > (opp.z < 0.5 ? 0.6 : 2.2 + s.patience * 1.6)) {
        const _recent = (f.recentTech || []).slice(-2);
        const _dives = AIR_VARIANTS.filter((x) => x.dive);
        const dv = _dives.filter((x) => _recent.indexOf(x.zh) < 0)[0] || pickAirVariant(f, opp, rng);
        return { kind: "attack", variant: dv, reason: "airDive" };
      }
      return { kind: "hover", reason: "air" };
    }
    // ⓪-b 对手在空中：够得着就用地面招打下来，明显够不着才迎空拦截或让开等落地
    //    （门槛设 1.2 米：低空弹跳不该触发"对跳"，否则两名轻功档会互相跳满 30 秒）
    if (opp.z > 0.5) {
      const v = (rng() < 0.5 ? VARIANTS[1] : VARIANTS[3]);
      if (bandOverlap(atkBand(f, v), defSpan(opp)) && dist <= f.reach * 1.1) return { kind: "attack", variant: v, reason: "antiAir" };
      // 对手在高空（>2.2m）而自己是飞行档：直接升空接战 —— 这才是"飞天遁地"里的空中对拼；
      //   否则两颗棋子永远一个在天一个在地，各打各的，看起来还是地面战。
      if (opp.z > 2.2 && f.mob.flight && f.sta > 40 && f.airCd <= sim.t && (f.flights || 0) < flightCap(f) &&
          sim.t >= (f.flightCd || -9) && canLeap(f, sim, 26, "flight") && rng() < 0.75) return { kind: "takeoff", reason: "airDuel" };
      if (opp.z > 1.2 && canLeap(f, sim, 34, "antiAir") && rng() < 0.16 + (f.mob.airAtk >= 2 ? 0.12 : 0)) return { kind: "leap", dir: "up", reason: "antiAir" };      // 够不到就别在原地挥空：跑到"对手的落点"等落地（这才是高手打法，也不会像在表演）
      const tFall = Math.max(0.25, Math.sqrt(2 * Math.max(0.2, opp.z) / G_Z));
      return { kind: "intercept", x: opp.x + opp.vx * tFall, y: opp.y + opp.vy * tFall, reason: "antiAir" };
    }
    // ⚠ REACT_FIRST（2026-09-23 修）：**反应优先于计划** —— 防守/反击必须排在"破僵持/回气"之前。
    //   实测的"站着挨打"就是这样来的：一方进入 approach 或 recover 循环后，防守分支永远轮不到，
    //   整场 0 次格挡 0 次闪避、被对手点着打 12 秒。顺序调整为：逃生窗口 → **防守/反击** → 破僵持 → 回气 → …。
    // ② 对手在攻击：按反应延迟决定"挡/闪/对拼/反打"
    if (opp.state === "attack" && opp.phase !== "recovery") {
      // REFLEX（2026-09-23 修）：原来防守必须"看得见"——距对手起手 ≥ 反应时间。
      //   可是 swift 型招式的起手比 3 级的反应时间（0.25 秒）还短，于是永远"看不见"，
      //   只能一路返回 guardSpace：举着架不动、既不格挡也不闪避也不还手（实测整场 0 挡 0 闪）。
      //   现在两处放宽：① 越远的招越好看见（按距离折算）；② 看不清也按身手给一次本能反应概率。
      const _seeDist = Math.max(0.6, Math.min(1.15, 1.15 - dist * 0.05));
      const seenLong = (sim.t - opp.atkStart) >= f.prof.react * _seeDist;
      //   末段（20 秒后 / 24 秒后）闪架降档，但**不归零**（2026-10-01）：旧版最后 4 秒防守直接 0，
      //   画面上就是"最后几秒只会挨打"。现在留 0.45 下限，靠压迫与伤害分胜负。
      const _fin = sim.t > 26 ? 0.45 : (sim.t > 22 ? 0.70 : (sim.t > 18 ? 0.90 : 1));
      //   本能反应（看不清也要有一次读招）：按打斗智商 read 给，比旧版高一档（最低 0.22）。
      const reflex = !seenLong && rng() < _fin * Math.max(0.22, Math.min(0.62, 0.22 + ((f.iq && f.iq.read) || 0.5) * 0.28 + s.dodge * 0.10));
      if (seenLong || reflex) {
        // 阵地战/追逐战：身边有掩体就退到掩体后面（借掩体＝让对方的兵器线路被挡住）
        // 终局（20 秒后）不许再靠掩体拖时间：实测末段"躲掩体 + 砸掩体 + 回气"循环让三场 30 秒打不完。
        if (sim.t < 20 && sim.scen.cover && sim.props.length && rng() < 0.5) {
          const pr = nearProp(sim, f, 2.2);
          if (pr) return { kind: "cover", prop: pr.id, reason: "cover" };
        }
        const heavy = opp.tech && (opp.tech.key === "heavy" || opp.tech.finisher);
        const canB = canBlock(opp, f);
        // 末段脱力：30 秒对局到最后 6 秒，闪避与格挡都不再可靠（久战必分胜负，而不是靠互闪拖到时间到）。
        //   实测有一场追逐战 38 次出手只 10 次命中（19 次闪避 + 11 次对拼），血量还剩一半打不完。
        // 末段脱力三档（2026-10-01 改）：18 秒后 0.90、22 秒后 0.70、26 秒后 0.45 —— 降档但不归零
        const finale = sim.t > 26 ? 0.45 : (sim.t > 22 ? 0.70 : (sim.t > 18 ? 0.90 : 1));
        // 末段连格挡也一起塌（只剩一点点）：否则"最后 4 秒人人格挡"照样打不完（实测 27/30）。
        // ── 读招 → 挑手段（2026-10-01「所有角色都要有打斗智商」）──────────────────
        //   同一招用最合适的方式防：重招/扫堂腿→闪或翻滚（硬挡会被崩防）；快到看不清→格挡/拍击；
        //   高位劈砸→侧闪摇闪；法术来袭→拉开或抢拍。权重里有 iq 下限，所以谁都不会"站着挨打"。
        const _tk = (opp.tech || {});
        const _sig = String(_tk.zh || "") + " " + String(_tk.key || "");
        const _low = /sweep|low|扫堂|低位|铲|扫/i.test(_sig);
        const _high = /overhead|axe|劈|砸|dive|俯冲|腾空|air_axe/i.test(_sig);
        const _tooFast = (sim.t - opp.atkStart) < f.prof.react * 0.9;
        const _iq = f.iq || { block: s.block, dodge: s.dodge, counter: s.counter, roll: 0.15, read: 0.6 };
        let wB = _iq.block * (canB ? 1 : 0.18);
        let wD = _iq.dodge * (heavy ? 1.30 : 1.0);
        let wR = _iq.roll * (f.sta > 28 ? 1 : 0.35);
        let wC = _iq.counter * (s.aggr > 0.5 ? 1.1 : 0.7) * (dist <= pref * 1.15 ? 1 : 0.25);
        if (heavy) { wD *= 1.15; wR *= 1.55; wB *= 0.65; wC *= 0.6; }
        if (_low) { wD *= 1.35; wR *= 1.30; wB *= 0.55; }
        if (_high) { wD *= 1.20; wB *= 0.80; }
        if (_tooFast) { wB *= 1.55; wD *= 0.80; wR *= 0.40; }
        if (f.sta < 25) { wB *= 1.25; wD *= 0.65; wR *= 0.45; }
        if (f.rules.noDodge) { wD = 0; wR = 0; }
        if (f.rules.noBlock) { wB = 0; }
        const _finW = 0.45 + 0.55 * finale;
        wB *= fatigue * _finW; wD *= fatigue * _finW; wR *= fatigue * _finW; wC *= fatigue;
        const tot = Math.max(0.001, wB + wD + wR + wC), r = rng() * tot;
        if (r < wC) return { kind: "attack", variant: pickVariant(f, opp, rng), reason: "clash" };
        if (r < wC + wD) return { kind: "dodge", dir: rng() < 0.5 ? -1 : 1, crouch: rng() < 0.35 };
        if (r < wC + wD + wR) return { kind: "roll", dir: rng() < 0.5 ? -1 : 1, reason: "readRoll" };
        if (r < wC + wD + wR + wB) return { kind: "block" };
      }
      // 没看见、也没触发本能反应时**不再死守** guardSpace：
      //   继续往下走（该压上去就压上去、该回气就回气），否则就会"一直举架挨打"。
    }
    // ⓪-c 刚受身脱出（0.9 秒窗口）：先拉开再找反击，不许立刻回到"站桩挨打"
    if (f.escapeUntil && sim.t < f.escapeUntil) {
      if (dist < f.reach * 1.2 && f.sta > 26 && rng() < 0.45) return { kind: "dodge", dir: rng() < 0.5 ? -1 : 1, crouch: false, reason: "afterBreak" };
      if (dist > f.reach * 1.6 && f.sta > 30 && rng() < 0.5) return { kind: "attack", variant: pickVariant(f, opp, rng), reason: "afterBreak" };
      if (dist > f.reach * 1.6 && f.sta > 30) { const _a = Math.atan2(opp.y - f.y, opp.x - f.x); f.vx += Math.cos(_a) * 4.2; f.vy += Math.sin(_a) * 4.2; return { kind: "approach" }; }
      return { kind: "space", dir: rng() < 0.5 ? -1 : 1 };
    }
    // ⓪ 僵持破局：太久没出手（双方都在绕圈子）就主动压上去
    //    2026-09-29 收紧成"接触时钟"：原来 2.6+patience*2.2 秒（约 5~8 秒）才急，实测空拍占总片长 61%
    //    （砍空是静默事件，不算 story 事件，所以画面上就是"两人各自绕圈"）。港式打斗的节奏是
    //    **一拍接一拍**：上一次接触（含被架住/闪开）之后 1~2 秒内必须再有下一拍。
    //    决胜期（22 秒后）把耐心再砍掉四成，避免两名防守型角色磨到时间结束。
    const sinceContact = sim.t - Math.max(f.lastAtkT || 0, f.lastContactT || 0);
    const impatience = (1.05 + s.patience * 0.85) * (sim.t > 22 ? 0.6 : 1);
    // ⚠ IMPA_order（2026-09-23 修）：这一段原来排在"对手在攻击 → 挡/闪/对拼/反打"**之前**，
    //   于是只要进入"急着进攻"状态，选手就**永远不再防守**：实测 30 秒里 0 次格挡 0 次闪避，
    //   只在原地反复 approach（70 次决策都在走向对手），被对手点着打 —— 观众看到的就是"站着挨打"。
    //   修法：对手正在出招时，这一段让位给下面的防守/反击分支（防住之后下一次决策自然会压上去）。
    const _oppAttacking = opp.state === "attack" && opp.phase !== "recovery";
    if (sim.t - Math.max(f.lastAtkT || 0, f.lastContactT || 0) > impatience && !_oppAttacking) {
      if (dist <= f.reach * 1.25) return swing("impatient");
      return { kind: "approach" };
    }
    // ① 体力见底 → 拉开回气
    // 体力见底 → 拉开回气。但追逐战里追击方"在射程内也不许回气"：
    //   否则两个人一起回气，整场只剩跑位（实测一场 30 秒只有 10 次命中、血量还剩一半，打不完）。
    const chaseHold = !!((sim.chase && sim.chase.chaser === f.id && dist < f.reach * 1.5) || (sim.t > 22 && dist < f.reach * 1.8));
    if (f.sta < 22 && !s.ruthless && !chaseHold) return { kind: "recover" };
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
      const _iqT = f.iq || { block: s.block, dodge: s.dodge, roll: 0.15, counter: s.counter, read: 0.6 };
      const guardP = clamp(_iqT.block * (late ? 0.30 : 0.75) * fatigue + sa.def, 0, 1);          // 久战不再一味举架；水战/阵地战更常守
      // 防御门禁（取 GPT 9.13）：规则禁闪避、或体力 <12 时不再"累着乱闪"（闪不动还把闪避用掉）
      // ⚠ 2026-09-30 用户：「有时没被打角色也自己在乱滚」——根因就是这里的**预判式闪身**：只要站在对方
      //   射程里（threat）就按概率闪，对手根本没出招，画面上就是一个人对着空气翻滚。
      //   现在预判闪身必须**对手真的在出招/施法**（_oppAttacking 或有法术在飞），否则改成举械架势或走位；
      //   "站在威胁距离默认抬架"这条仍然保留（真人就是靠预判抬架，但抬架不会乱滚）。
      const _incoming = _oppAttacking || opp.state === "cast" || (sim.shots && sim.shots.length > 0);
      const readP = (!f.rules.noDodge && f.sta >= 12 && _incoming) ? clamp(_iqT.dodge * (late ? 0.12 : 0.30) * fatigue + sa.def * 0.6, 0, 1) : 0;       // 预判式闪身（疾风/游走型读招，不靠反应）
      // 翻滚让开（2026-10-01 新增）：读招好、体力够的角色会用翻滚躲开重招/扫腿
      const rollP = (!f.rules.noDodge && f.sta >= 22 && _incoming) ? clamp(_iqT.roll * (late ? 0.10 : 0.26), 0, 1) : 0;
      if (r < guardP) return { kind: "block" };
      if (r < guardP + readP) return { kind: "dodge", dir: rng() < 0.5 ? -1 : 1, crouch: rng() < 0.3 };
      if (r < guardP + readP + rollP) return { kind: "roll", dir: rng() < 0.5 ? -1 : 1, reason: "preRoll" };
      const closeIn = dist < f.reach * 0.95;                                    // 已经贴上了，就别再绕圈
      const spaceP = (late ? 0.08 : 0.20) * (closeIn ? 0.35 : 1) + sa.move * 0.25 * (closeIn ? 0.5 : 1);
      if (r < guardP + readP + rollP + spaceP) return { kind: "space", dir: rng() < 0.5 ? -1 : 1 };   // 追逐战/水战多走位
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
      // 只砸"对手身边的掩护物"：挡在连线中段的东西绕过去就行，
      //   否则满场可破坏物会让每一拍都变成"砸箱子"（实测 46 次/场掩体命中、KO 率被吃掉）。
      const pr = sim.props.find(p => !p.broken && G.ptSeg(p.x, p.y, f.x, f.y, opp.x, opp.y) <= p.r
        && Math.hypot(p.x - opp.x, p.y - opp.y) <= f.reach * 1.35 + p.r
        && (f.z || 0) < (p.h || 1.2) + 0.8);          // 人在半空时够不到地上的箱子（否则会对着地面砸一整场）
      if (pr) {
        const pd = Math.hypot(pr.x - f.x, pr.y - f.y);
        if (pd <= f.reach * 1.15) return { kind: "attack", variant: (pr.tough >= 2 ? VARIANTS[5] : pickVariant(f, opp, rng)), reason: "smashCover" };
        return { kind: "approach" };                       // 先贴到掩体边再砸
      }
    }
    // ⑦ 距离控制（还没进入威胁距离）
    if (dist > pref * 1.06) {
      // 阵地战/追逐战：主动靠掩体占位（"借掩体"要真的走到掩体后面，而不是只在被攻击时才想）
      if (sim.t < 20 && sim.scen.cover && sim.props.length && rng() < 0.35) {
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
      // 3~6 级轻功档：**腾空突袭** —— 跃到高处提气停一口气、在空中打一两下再落。
      //   用户要求："3-6 级别可以轻功，和短暂在空中停留打斗"。没有这条，轻功档只会用跳跃赶路，不会在空中打。
      if (f.mob.float > 0 && !f.mob.flight && dist > f.reach * 0.75 && dist <= f.reach * 2.0 &&
          f.sta > 40 && f.airCd <= sim.t && canLeap(f, sim, 22, "airStrike") && rng() < 0.16 + 0.025 * (f.prof.tier || 3)) {
        return { kind: "leap", dir: "up", reason: "airStrike" };
      }
      // 7 级以上真飞行（飞天遁地）：升空压迫 → 空中交手 → 俯冲压落。
      //   两层门槛都要过：①飞行自己的配额与冷却（不跟低跳共用）②体力。
      //   概率上"开场必升空一次"，之后按等级/性格给出后续升空，对手在天上时升空去截（空战）。
      if (sim.t < 26 && f.mob.flight && f.airCd <= sim.t && (f.flights || 0) < flightCap(f) &&
          f.sta > 55 && sim.t >= (f.flightCd || -9) && canLeap(f, sim, 40, "flight")) {
        const airDuel = opp.z > 2.2;                                  // 对手已经在天上 → 上去打空战
        const first = (f.flights || 0) === 0;
        const want = first ? (sim.t > 1.2 ? 1.0 : 0)
                           : (airDuel ? 0.60 : 0.14 + 0.05 * Math.max(0, f.prof.tier - 7) + (f.style.aggr > 0.7 ? 0.05 : 0))
                             * (dist > f.reach * 1.3 ? 1.0 : 0.55);   // 贴脸时升空意义小
        if (want > 0 && rng() < want) return { kind: "takeoff", reason: airDuel ? "airDuel" : "aerialPress" };
      }
      // ⓪-4 冲刺 / 追击（2026-09-25）：快动作片的"进入"从来不是慢慢走过去，而是**冲上去**。
      //   原来这里只有一种 approach（匀速走过去，实测自由移动均速仅 1~2.7 m/s），看到的就是"两个人慢慢走着打"。
      //   三种冲刺：开场冲刺（open）、拉远冲刺（close）、打退之后追打（pursue）；每次冲刺都进事件流，
      //   提示词里能写成"冲刺 xx 米/秒扑上去"。飞行档（7 级以上）在空中也能冲（御空冲刺/俯冲）。
      //   ⚠ 位置很关键：必须放在**所有专门分支之后**（起跳接招、格挡/闪避、升空、借墙、掩体之后），
      //     只在"本来要小跑过去"这一支上替换成冲刺——提前放会抢掉闪避/格挡/轻功腾空的决策
      //     （实测：提前放会让"铁壁性格"改闪避、"3~6 级轻功滞空"消失、追逐战里逃跑者不跑了）。
      if (f.sta > 26 && (!airy || f.mob.flight) && opp.state !== "down" && (f.dashCd || 0) <= sim.t) {
        const pursueWindow = (opp.state === "hitstun" || opp.state === "stagger" ||
          (opp.state === "land" && (opp.hitstun || 0) > 0));
        // 只有**法术为主**的角色才"在射程内不冲"（判据与施法走位一致：风格档 spell 高 / 仙神斗法档）；
        //   近战衔接法术的人照样冲上去贴身打——否则整场都在小跑（实测冲刺 1 次/场）。
        const _ranged2 = (f.sp && f.sp.key === "caster") || ((f.style && f.style.spell) > 0.55);
        const _spR2 = (f.spells && f.spells.length) ? Math.max.apply(null, f.spells.map((x) => x.reach || 0)) : 0;
        const inCastRange = _ranged2 && _spR2 > 0 && dist <= _spR2 * 0.92;
        if (sim.t < 0.8 && dist > f.reach * 2.2) return { kind: "dash", why: "open" };
        if (pursueWindow && dist > f.reach * 1.0 && dist < 14 && aggro > 0.4) return { kind: "dash", why: "pursue" };
        if (dist > f.reach * 2.4 && !(inCastRange && f.z < 0.3)) return { kind: "dash", why: "close" };
      }
      return { kind: "approach" };
    }
    // 贴太近先拉开——但**耐心耗尽时不许再拉开**：
    //   否则双方贴脸互相绕圈（实测一场追逐战贴到 1.4 米后十来秒谁都不出手，血量还剩一半就打完了）。
    //   把"拉开的条件"绑在耐心计时上，超时就让后面的"破僵持"分支接管。
    const patienceT = (2.6 + s.patience * 2.2) * (sim.t > 22 ? 0.55 : 1);
    if (dist < f.reach * 0.52 && (sim.t - (f.lastAtkT || 0)) < patienceT) return { kind: "space", dir: rng() < 0.5 ? -1 : 1 };
    // 逼近途中也要会防：已经进了对手的射程、对手又在出招 —— 先挡或闪这一下再压上去
    if (_oppAttacking && dist <= (opp.reach || 1.2) * 1.15 && f.sta > 14) {
      const canB2 = canBlock(opp, f);
      if (!f.rules.noDodge && f.sta >= 12 && (rng() < 0.45 * _fin || !canB2)) return { kind: "dodge", dir: rng() < 0.5 ? -1 : 1, crouch: rng() < 0.3, reason: "approachDefend" };
      if (canB2 && rng() < Math.max(0.25, _fin)) return { kind: "block", reason: "approachDefend" };
    }
    // 3~6 级轻功档：**腾空突袭**（中近距也能用）——跃起 → 空中提气停一口 → 打一两下 → 落地。
    //   用户要求："3-6 级别可以轻功，和短暂在空中停留打斗"；只靠远距突进是打不出来的。
    if (f.mob.float > 0 && !f.mob.flight && f.sta > 36 && f.airCd <= sim.t && dist <= f.reach * 1.9 &&
        canLeap(f, sim, 22, "airStrike") && rng() < 0.34 + 0.030 * (f.prof.tier || 3)) {
      return { kind: "leap", dir: "up", reason: "airStrike" };
    }
    // 已经在空中提气（轻功档）：对地面目标要真的打下去——不然"滞空"只是表演
    //   （实测 5 级提气滞空 1.6 次/场，空中命中却只有 0.4 次）
    //   ⚠ 必须"先上去再打"：至少离地 0.9 米、已经在空中待了 0.35 秒（也就是先提气停过一口），
    //     否则一跃起就俯冲，3~6 级的"短暂空中停留打斗"根本演不出来（实测 7 次突袭只 1 次滞空）。
    if (f.z > 0.9 && !f.mob.flight && (f.airAtkLeft || 0) > 0 && f.sta > 22 && opp.z < 0.6 &&
        (f.wasStall || f.vz <= 0.2) && dist <= f.reach * 2.4) {
      return { kind: "attack", variant: pickAirVariant(f, opp, rng), reason: "air" };
    }
    // ⑧ 在射程内 → 出手（性格越凶越急，耐心型会多等一拍；决胜期一律加压）
    const wantAttack = clamp(aggro * (0.55 + 0.45 * (1 - s.patience)) + (f.hp < f.hpMax * 0.3 ? 0.2 : 0) + (sim.t > 22 ? 0.30 : 0) + sa.atk * 1.6, 0, 1);
    if (rng() < wantAttack) return swing("inrange");
    return { kind: "space", dir: rng() < 0.5 ? -1 : 1 };
  }

  // ── 施法移位「踏罡步斗」（2026-09-25）──────────────────────────────────
  //   用户反馈的"两个人慢慢走着打"，量出来的真凶其实是**施法站桩**：9 级对局里 71% 的帧都在 cast，
  //   而 cast 期间 lockCheck 为真 → 完全不跑 steer → 站着不动 2~4 秒（占全部慢速帧的 76%）。
  //   真实仙侠/武侠片里，蓄力从来不是站着念咒：踏罡步斗、绕步护法、边退边结印。
  //   所以这里给施法加一套独立走位：法术为主的人保持距离绕步，近战衔接的人边念边压上。
  function castSteer(sim, f, opp, dt, rng) {
    const s = f.style || {};
    const dist = Math.hypot(opp.x - f.x, opp.y - f.y);
    const toOpp = Math.atan2(opp.y - f.y, opp.x - f.x);
    const tier = f.prof.tier || 1;
    // 远程型（法术射程远大于兵器射程）也算"法术为主"：他们蓄力时要拉开，不是往上贴
    const _spR = (f.spells && f.spells.length) ? Math.max.apply(null, f.spells.map((x) => x.reach || 0)) : 0;
    const _ranged = _spR > f.reach * 2.2;
    const mv = ((f.sp && f.sp.key === "caster") || (s.spell > 0.55) || _ranged) ? "keep" : "press";
    if (f.castMode !== mv) {
      f.castMode = mv; f.castDir = rng() < 0.5 ? -1 : 1;
      const whyZh = mv === "keep" ? "绕步护法、保持施法距离" : "边结印边压上";
      f.castWhyZh = whyZh;
    }
    const base = 2.6 + tier * 0.22;                       // 6 级 ~3.9 m/s、9 级 ~4.6 m/s（不是冲刺，但绝不是走路）
    const spd0 = base * ((f.buff && f.buff.speedMul) ? f.buff.speedMul : 1);
    const keep = (f.sp && f.sp.keepRange) || 3.2;
    let radial;                                            // 正 = 靠近，负 = 退开
    if (mv === "keep") radial = dist < keep * 0.85 ? -1.4 : (dist > keep * 1.3 ? 1.0 : 0);
    else {
      // 近战衔接型：边结印边压上，但**不要贴脸**——法术需要出手空间（<2.2 米起不了手），
      //   真实仙侠也是"踏罡步斗到两三米外，一掌/一剑递着法术打出去"。
      const want = Math.max(f.reach * 1.3, keep * 0.62, 2.0);
      radial = dist > want * 1.12 ? 1.0 : (dist < want * 0.78 ? -0.9 : 0);
    }
    // 绕步分量（垂直于连线）——这是"活"的来源：不绕步就是原地站着
    const side = toOpp + f.castDir * Math.PI / 2;
    const vx = Math.cos(side) * spd0 + Math.cos(toOpp) * spd0 * radial * 0.75;
    const vy = Math.sin(side) * spd0 + Math.sin(toOpp) * spd0 * radial * 0.75;
    const vl = Math.hypot(vx, vy) || 1;
    f.vx += (vx / vl) * spd0 * 8 * dt; f.vy += (vy / vl) * spd0 * 8 * dt;
    const cur = Math.hypot(f.vx, f.vy);
    if (cur > spd0) { f.vx *= spd0 / cur; f.vy *= spd0 / cur; }
    if (f.state === "idle" || f.state === "move") f.state = "move";
    // 记账：每 0.6 秒一条"施法时在移动"的样本（提示词要写成"边踏罡步斗边结印"，不是"站桩念咒"）
    if (sim.t - (f.castMoveT == null ? -9 : f.castMoveT) > 0.6) {
      f.castMoveT = sim.t; f.castMoveN = (f.castMoveN || 0) + 1;
      f.stats.castMoves = (f.stats.castMoves || 0) + 1;
      sim.events.push({ t: +sim.t.toFixed(3), type: "cast_move", who: f.id,
        x: +f.x.toFixed(3), y: +f.y.toFixed(3), z: +(f.z || 0).toFixed(3),
        speed: +Math.hypot(f.vx, f.vy).toFixed(1), dist: +dist.toFixed(2), tech: (f.castSpell && f.castSpell.zh) || "",
        mode: mv, zh: f.castWhyZh || "" });
    }
    // ── 蓄力被贴身：收功改掌击（快节奏的"见招拆招"）────────────────────────
    //   神仙斗法里 71% 的帧都耗在蓄力上，如果蓄力期间既不移动也不反应，画面就是"两个人站着对望"。
    //   真实的处理是：刚起手就被贴到脸上 → 来不及蓄 → 索性收功，一掌拍出去（然后再找机会放法术）。
    //   只在蓄力前半段这么做（`castT < castDur*0.45`）：快到手的法术不会被白白丢掉。
    const meleeLean = !(f.sp && f.sp.key === "caster") && !((f.style && f.style.spell) > 0.5);
    if (!f.castCancelled && meleeLean && opp.state === "attack" && f.castT > 0.25 && f.castT < (f.castDur || 3) * 0.5 &&
        dist < f.reach * 0.95 && f.sta > 30 && rng() < 0.4 && !f.rules.blockOnly) {
      const v0 = pickVariant(f, opp, rng);
      f.castCancelled = true;
      const spellName = (f.castSpell && f.castSpell.zh) || "";
      // 收功不等于白费：把这一招的冷却退回来（否则"被贴身一次"就等于整场放不出法术）
      if (f.castSpell && f.castSpell.id && f.spellCd) f.spellCd[f.castSpell.id] = Math.min(f.spellCd[f.castSpell.id] || 0, sim.t + 0.7);
      f.castSpell = null; f.castT = 0; f.state = "idle"; f.auraOn = false;
      const started = startAttack(sim, f, v0, "castInterrupt");
      if (started !== false) {
        f.stats.castCancels = (f.stats.castCancels || 0) + 1;
        sim.events.push({ t: +sim.t.toFixed(3), type: "cast_cancel", who: f.id, tech: spellName,
          toTech: (v0 && v0.zh) || "", x: +f.x.toFixed(3), y: +f.y.toFixed(3), dist: +dist.toFixed(2),
          zh: "刚起手就被贴到脸上：来不及蓄满「" + spellName + "」，索性收功改近身「" + ((v0 && v0.zh) || "掌击") + "」" });
      }
    }
  }

  function steer(sim, f, opp, dt, rng) {    const it = f.intent, s = f.style;
    // 动作目的记账：同一个决策只记一次（f.intent 换成新对象就记一条）
    if (it && it.kind && it._logged !== it) { recordPurpose(f, sim, it); it._logged = it; }
    const toOpp = Math.atan2(opp.y - f.y, opp.x - f.x);
    const dist = Math.hypot(opp.x - f.x, opp.y - f.y);
    const faceRate = f.prof.turn * dt;
    // 场地越大越要靠"赶路"：小场地不加速（保持原手感），大场地按尺寸放大步伐（含轻功突进）
    const dash = clamp(Math.min(sim.arena.w, sim.arena.h) / 12, 1, 1.7);
    // 蓄力与起手期间**允许继续转向**（对手绕到侧面时人也跟着转）；判定帧与收招仍然锁定朝向，
    //   所以"打空之后要重新转身"的代价保留。
    const turning = f.state === "cast" || (f.state === "attack" && f.phase === "windup");
    const lock = ACTIONS.locked(f) || !turning && (f.state === "attack" || f.state === "dodge" || f.state === "hitstun" || f.state === "stagger" || f.state === "down" || f.state === "land");
    if (!lock) {
      const want = turning ? (f.faceTarget != null ? f.faceTarget : toOpp) : toOpp;
      const d = norm(want - f.face);
      f.face += clamp(d, -faceRate * (turning ? 1.6 : 1), faceRate * (turning ? 1.6 : 1));
    }
    const spd = (3.2 * f.prof.speed * f.speed) * ((f.buff && f.buff.speedMul) ? f.buff.speedMul : 1);   // 风火轮之类：移动更快
    // 冲刺速度：按等级给（6 级约 11 m/s、9 级约 14 m/s，风火轮之类再翻倍）——"奔跑的拼打"靠这个数字
    const dashSpd = Math.min(14, 6.0 + (f.prof.tier || 1) * 0.75) * ((f.buff && f.buff.speedMul) ? f.buff.speedMul : 1) * Math.min(1.25, dash);
    const act = () => { if (f.state === "idle" || f.state === "move") f.state = "move"; };
    switch (it.kind) {
      case "dash": {
        // 冲刺/追击：一次冲 0.35~0.65 秒，冲进射程就收脚（不许冲过头）
        const why = it.why || "close";
        if (!f.dashWhy) {
          f.dashWhy = why; f.dashFrom = { x: f.x, y: f.y }; f.dashT0 = sim.t;
          f.dashUntil = sim.t + (why === "open" ? 0.65 : why === "pursue" ? 0.45 : 0.5);
          f.dashCd = sim.t + 1.6 + rng() * 0.8;
          f.dashes = (f.dashes || 0) + 1;
          f.stats.dashes = (f.stats.dashes || 0) + 1;
          sim.events.push({ t: +sim.t.toFixed(3), type: "dash", who: f.id, why: why,
            x: +f.x.toFixed(3), y: +f.y.toFixed(3), z: +(f.z || 0).toFixed(3),
            speed: +dashSpd.toFixed(1), dist: +dist.toFixed(2),
            zh: why === "open" ? "开局抢先进攻" : (why === "pursue" ? "追打还在硬直/踉跄的对手" : "拉近身位"),
            whyZh: why === "open" ? "开局抢先进攻" : (why === "pursue" ? "追击" : "拉近") });
        }
        // 收脚距离：追打贴到能补刀（reach×0.95）；开场冲刺收在"能打到的距离"（reach×1.55，至少 2.3 米）——
        //   开场就糊到脸上会让对面的法术再也起不来（实测"远距离就开打"就是被这条吃掉的）。
        const over = dist <= (why === "open" ? Math.max(f.reach * 1.55, 2.3) : f.reach * (why === "pursue" ? 0.95 : 0.9)) + 0.15;
        // 施法型角色冲刺到"能放法术的距离"就收脚（不是冲到脸上）：约 2.6~3.4 米
        const castStop = !!(f.spells && f.spells.length) && ((f.sp && f.sp.key === "caster") || (f.style && f.style.spell > 0.5));
        const over2 = castStop && dist <= Math.max(2.6, f.reach * 1.25);
        if (sim.t > f.dashUntil || over || over2 || f.sta < 20) {
          // 收脚：把这一冲的实际位移记账（证据里要写"冲了几米、多快"）
          if (f.dashFrom) {
            const d = Math.hypot(f.x - f.dashFrom.x, f.y - f.dashFrom.y);
            f.dashDist = (f.dashDist || 0) + d;
            f.stats.dashDist = (f.stats.dashDist || 0) + d;
            sim.events.push({ t: +sim.t.toFixed(3), type: "dash_end", who: f.id, why: why,
              x: +f.x.toFixed(3), y: +f.y.toFixed(3), dist: +d.toFixed(2),
              speed: +(d / Math.max(0.08, sim.t - (f.dashT0 == null ? sim.t : f.dashT0))).toFixed(1) });
          }
          f.dashWhy = null; f.dashFrom = null; f.sta = Math.max(0, f.sta - 4);
          f.intent = { kind: "approach", reason: "dash-done" };
          act(); break;
        }
        // 冲刺带一点弧线（直线冲刺看起来像滑行）
        const arc = (f.dashArc == null ? (f.dashArc = (rng() < 0.5 ? -1 : 1)) : f.dashArc) * (why === "open" ? 0.05 : 0.16);
        const a2 = toOpp + arc;
        f.vx += Math.cos(a2) * dashSpd * 12 * dt; f.vy += Math.sin(a2) * dashSpd * 12 * dt;
        const cur = Math.hypot(f.vx, f.vy);
        if (cur > dashSpd) { f.vx *= dashSpd / cur; f.vy *= dashSpd / cur; }
        act(); break;
      }
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
          f.vx += (bx / bl) * spd * 9 * dash * dt; f.vy += (by / bl) * spd * 9 * dash * dt; act(); break;
        }
        f.vx += Math.cos(toOpp) * spd * 9 * dash * dt; f.vy += Math.sin(toOpp) * spd * 9 * dash * dt; act(); break;
      }
      case "space": case "flank": {
        const side = (it.kind === "flank" ? it.dir : -it.dir);
        const a = toOpp + side * Math.PI / 2;
        f.vx += Math.cos(a) * spd * 7 * dt; f.vy += Math.sin(a) * spd * 7 * dt;
        if (dist > f.reach * 0.95) { f.vx += Math.cos(toOpp) * spd * 2 * dt; f.vy += Math.sin(toOpp) * spd * 2 * dt; }
        act(); break;
      }
      case "guardSpace": {
        // 保持防守距离：面向对手慢慢退
        const a = toOpp + Math.PI;
        f.vx += Math.cos(a) * spd * 2.8 * dt; f.vy += Math.sin(a) * spd * 2.8 * dt;
        f.state = f.state === "block" ? "block" : "move"; break;
      }
      case "recover": {
        const a = toOpp + Math.PI;
        f.vx += Math.cos(a) * spd * 4.6 * dt; f.vy += Math.sin(a) * spd * 4.6 * dt;
        f.state = "move"; break;
      }
      case "dodge": {
        if(f.rules.noDodge || f.sta < 12) { f.intent={kind:"approach"}; break; }
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
      case "roll": {
        // 翻滚让开（2026-10-01）：比侧闪位移更大、过程有无敌帧、起身换到对手侧后（起身即能反击）
        if (f.rules.noDodge || f.sta < 20) { f.intent = { kind: "block" }; break; }
        const a = toOpp + (it.dir || 1) * (Math.PI / 2) + (rng() < 0.35 ? Math.PI : 0);
        const v = 7.2 * f.prof.speed;
        f.vx = Math.cos(a) * v; f.vy = Math.sin(a) * v;
        ACTIONS.beginRoll(sim, f);
        f.post = "crouch";
        f.sta = Math.max(0, f.sta - 20);
        f.stats.dodges++; f.stats.rolls = (f.stats.rolls || 0) + 1;
        f.counterUntil = Math.max(f.counterUntil || 0, sim.t + 0.45);   // 起身接反击
        sim.events.push({ t: +sim.t.toFixed(3), type: "dodge", who: f.id, roll: true, crouch: true,
          x: +f.x.toFixed(3), y: +f.y.toFixed(3) });
        break;
      }
      case "block": {
        if(!canBlock(opp,f)) {
          // 挡不了（空手对刃之类）就**用脚步躲开**，不许原地站着（站着不动是最不像打斗的画面）
          const a = toOpp + (f.blockDir == null ? (f.blockDir = (rng() < 0.5 ? -1 : 1)) : f.blockDir) * Math.PI / 2;
          f.vx += Math.cos(a) * spd * 6 * dt; f.vy += Math.sin(a) * spd * 6 * dt;
          act(); break;
        }
        f.state = "block"; f.blockHold = 0.3; break;
      }
      case "cast": {
        // 施法起不来（招式在冷却／气力不够／贴太近）时，**不许站着念**：
        //   实测这就是"最长待机 0.53 秒"的来源（9 级自动补了内力技，冷却没到就以施法意图起手，
        //   失败后状态停在 idle）。这里改成垫步压上（有身法就走，没身法也要出招）。
        if (startCast(sim, f, it.spell) !== false) break;
        {
          const fail2 = rng();
          const k2 = fail2 < 0.5 ? "press" : (fail2 < 0.8 ? "flank" : "reset");
          if (k2 === "press") { f.vx += Math.cos(toOpp) * spd * 4.2 * dash * dt; f.vy += Math.sin(toOpp) * spd * 4.2 * dash * dt; }
          else if (k2 === "flank") { const a3 = toOpp + (fail2 < 0.65 ? 1 : -1) * Math.PI / 2; f.vx += Math.cos(a3) * spd * 3.6 * dash * dt; f.vy += Math.sin(a3) * spd * 3.6 * dash * dt; }
          else { const a3 = toOpp + Math.PI; f.vx += Math.cos(a3) * spd * 3.0 * dash * dt; f.vy += Math.sin(a3) * spd * 3.0 * dash * dt; }
          act();
          if (sim.t - (f.lastFillerT == null ? -9 : f.lastFillerT) > 0.25) {
            f.lastFillerT = sim.t;
            f.stats.fillers = (f.stats.fillers || 0) + 1;
            sim.events.push({ t: +sim.t.toFixed(3), type: "filler", who: f.id,
              kind: k2, zh: k2 === "press" ? "法术没起手就垫步压上" : (k2 === "flank" ? "法术没起手就绕步换角度" : "法术没起手先撤半步重整"),
              why: "施法没起手（冷却／气力／距离），用身法填空档", x: +f.x.toFixed(3), y: +f.y.toFixed(3) });
          }
        }
        break;
      }
      case "trait": {
        // 神通：放不出来（体力不够等）就退回"压进"，不留静止
        if (!startTrait(sim, f, it.trait)) {
          f.vx += Math.cos(toOpp) * spd * 3.0 * dash * dt; f.vy += Math.sin(toOpp) * spd * 3.0 * dash * dt; act();
        }
        break;
      }
      case "attack": {
        // 出不了手（招式全在冷却 / 气力不够）时，用垫步·绕步·撤半步填掉这段空档：
        // 原来这里什么都不做，内核就会留下 0.4 秒以上的静止（审计里 26% 的场次被抓到）。
        if (startAttack(sim, f, it.variant || VARIANTS[0], it.reason === "combo") === false && !f.rules.blockOnly) {
          const fr = rng();
          const kind = fr < 0.45 ? "press" : (fr < 0.75 ? "flank" : "reset");   // 垫步压进 / 绕步换位 / 撤半步重整
          if (kind === "press") {
            f.vx += Math.cos(toOpp) * spd * 3.2 * dash * dt; f.vy += Math.sin(toOpp) * spd * 3.2 * dash * dt;
          } else if (kind === "flank") {
            const a2 = toOpp + (fr < 0.6 ? 1 : -1) * Math.PI / 2;
            f.vx += Math.cos(a2) * spd * 3.0 * dash * dt; f.vy += Math.sin(a2) * spd * 3.0 * dash * dt;
          } else {
            const a2 = toOpp + Math.PI;
            f.vx += Math.cos(a2) * spd * 2.6 * dash * dt; f.vy += Math.sin(a2) * spd * 2.6 * dash * dt;
          }
          act();
          // 间隙动作也要进事件流（节流 0.25 秒一条）：① 提示词里能写成"垫步换位"而不是"站桩" ② 审计能数得到
          if (sim.t - (f.lastFillerT == null ? -9 : f.lastFillerT) > 0.25) {
            f.lastFillerT = sim.t;
            f.fillerN = (f.fillerN || 0) + 1;
            f.stats.fillers = (f.stats.fillers || 0) + 1;
            sim.events.push({ t: +sim.t.toFixed(3), type: "filler", who: f.id,
                              kind: kind, zh: kind === "press" ? "垫步压进" : (kind === "flank" ? "绕步换位" : "撤半步重整"),
                              why: "招式冷却／气力不足，用身法填空档",
                              x: +f.x.toFixed(3), y: +f.y.toFixed(3) });
          }
        }
        break;
      }
      case "leap": {
        // 起跳：斜向突进（toward）/ 原地上跃迎空（up）/ 后跃脱身（away）/ 腾空突袭（airStrike）
        // ⚠ 坑（2026-09-23 修）：门控这一调用原来把"目的"硬写成 antiAir/evade/close，
        //   于是 canLeap 内部写下的 f.leapWhy 被覆盖 —— 决策层要的"腾空突袭"被当成普通低平突进，
        //   跳起来只有 0.55 米、根本够不到滞空门槛（实测 3~4 级整场 0 次提气滞空）。
        const _gateWhy = (it.reason === "antiAir") ? "antiAir"
          : (it.reason === "airStrike") ? "airStrike"
          : (it.dir === "away" ? "evade" : (it.reason === "close" || it.reason === "chase" || it.reason === "escape" ? it.reason : "close"));
        if (f.z > 0.05 || !canLeap(f, sim, 24, _gateWhy)) break;
        const _why = f.leapWhy || _gateWhy;
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
        if (f.z > 0.05 || !f.mob.flight || !canLeap(f, sim, 26, "flight")) break;
        f.vz = jumpV(hoverAltFor(f, sim));
        f.airAtkLeft = f.mob.airAtk;
        f.airAtkTimer = 0.9;
        f.airHold = 0;
        f.airCd = sim.t + 0.9;
        // 对手在天上时冷却收短（1.6 秒）：空战被打下来能立刻再升空，才谈得上"浮空战斗"；
        //   从地面重新开局升空则给 2.4 秒，避免变成"反复起落空转"。
        f.flightCd = sim.t + ((opp.z > 1.2) ? 1.4 : 2.0);   // 冷却收一点：飞天遁地的人该多在天上（9 级空中占比门槛 40%）
        f.flights = (f.flights || 0) + 1;
        f.mustLand = false;
        f.stats.takeoffs++; f.lastLeapT = sim.t; f.airIdleT = 0;
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
        // 空战抢高度：比对手高半米以上，俯冲角度与判定带都更好（也才有"上下翻飞"的观感）
        if (it.reason === "airClimb" || (f.mob.flight && opp.z > 1.2 && f.z < opp.z + 0.8 && f.sta > 22 && !f.mustLand)) {
          f.vz = Math.max(f.vz, 1.5);
          if (it.reason === "airClimb" && !f.climbLogged) { f.climbLogged = true; f.stats.airClimbs++; }
        }
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
      case "retreat": {
        // 退到目标间距（法术为主／游走一击）：真的往对手反方向退，退到了就绕步保持 ready 步法。
        //   ⚠ 必须有这个分支：意图返回了却没有执行代码 = 站着不动（就是"弱智挨打"的一种）。
        const want = it.dist || 2.6;
        const away = Math.atan2(f.y - opp.y, f.x - opp.x);
        const dd = Math.hypot(opp.x - f.x, opp.y - f.y);
        if (dd < want - 0.15) {
          f.vx += Math.cos(away) * spd * 5.4 * dash * dt; f.vy += Math.sin(away) * spd * 5.4 * dash * dt;
          f.state = "move"; act();
        } else {
          const side = away + Math.PI / 2 * (it.dir || 1);
          f.vx += Math.cos(side) * spd * 2.3 * dash * dt; f.vy += Math.sin(side) * spd * 2.3 * dash * dt;
          if (f.state === "idle" || f.state === "move") f.state = "move";
        }
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
        // 已经站到落点下面：不能"站桩等落地"（观感与体检都会记成静止）。
        //   改成绕着落点小步走位（保持 ready 步法），落地那一刻再出手。
        else {
          const side = ta + Math.PI / 2;
          f.vx += Math.cos(side) * spd * 2.4 * dash * dt;
          f.vy += Math.sin(side) * spd * 2.4 * dash * dt;
          if (f.state === "idle" || f.state === "move") f.state = "move";
        }
        break;
      }
      case "flee": {
        // 逃跑者：背离对手沿长街跑；贴边时沿切线滑走（不撞墙、不自己送死角）。
        // 逃命也要气力：气足时能甩开追击者，跑久了脚下发软 → 被追上 → 回身一搏，如此往复。
        const sprint = f.sta > 30 ? 1 : 0.6;
        f.sta = Math.max(0, f.sta - 9 * dt);
        const a = toOpp + Math.PI;
        // 疾奔逃离（2026-09-25）：逃跑不是快走，是**全力跑**——追击方现在会冲刺（12~14 m/s），
        //   逃跑方按老速度（约 8 m/s）只会被瞬间追上，"一追一逃"就不成立了。
        const fleeSpd = Math.min(13, 7.0 + (f.prof.tier || 1) * 0.7) * sprint;
        f.vx += Math.cos(a) * fleeSpd * 6.0 * dt; f.vy += Math.sin(a) * fleeSpd * 6.0 * dt;
        {
          const cur = Math.hypot(f.vx, f.vy);
          if (cur > fleeSpd) { f.vx *= fleeSpd / cur; f.vy *= fleeSpd / cur; }
          if (sim.t - (f.fleeLogT == null ? -9 : f.fleeLogT) > 0.8) {
            f.fleeLogT = sim.t;
            sim.events.push({ t: +sim.t.toFixed(3), type: "dash", who: f.id, why: "flee",
              x: +f.x.toFixed(3), y: +f.y.toFixed(3), z: +(f.z || 0).toFixed(3),
              speed: +cur.toFixed(1), dist: +Math.hypot(opp.x - f.x, opp.y - f.y).toFixed(2),
              zh: "夺路疾奔（逃离追击）", whyZh: "逃跑" });
          }
        }
        const m = 1.3;
        if (f.x < m || f.x > sim.arena.w - m) f.vy += Math.sign(sim.arena.h * 0.5 - f.y) * spd * 5.5 * dt;
        act(); break;
      }
      case "stand": {
        // 收势：原地稳住、面向对手（不追打倒地者）
        // ⚠ 但对手还站着时"原地站"就成了"两个人干瞪眼"（实测 idle 帧占 8~12%）——
        //   这时改成**活步**：小幅绕步/前后点步（1.8~2.6 m/s），像真打之前那样踩着步点。
        if (opp.state !== "down" && sim.t - (f.lastAtkT || 0) > 0.22) {
          const a = toOpp + (f.footDir == null ? (f.footDir = (rng() < 0.5 ? -1 : 1)) : f.footDir) * Math.PI / 2;
          const fs2 = spd * 0.72;
          f.vx += Math.cos(a) * fs2 * 4.0 * dt + Math.cos(toOpp) * fs2 * 1.1 * dt;
          f.vy += Math.sin(a) * fs2 * 4.0 * dt + Math.sin(toOpp) * fs2 * 1.1 * dt;
          const c2 = Math.hypot(f.vx, f.vy);
          if (c2 > fs2) { f.vx *= fs2 / c2; f.vy *= fs2 / c2; }
          if (sim.t - (f.footT == null ? -9 : f.footT) > 0.7) {
            f.footT = sim.t;
            f.stats.footsteps = (f.stats.footsteps || 0) + 1;
            sim.events.push({ t: +sim.t.toFixed(3), type: "footwork", who: f.id,
              x: +f.x.toFixed(3), y: +f.y.toFixed(3), speed: +Math.hypot(f.vx, f.vy).toFixed(1),
              zh: rng() < 0.5 ? "小步绕圈换角度" : "垫步踩点、随时再进" });
          }
          if (f.state !== "block") f.state = "move";
          break;
        }
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
  function segLabel(f, opp) {
    if (f.state === "attack" && f.tech) {
      const ph = PHASE_LABEL[f.phase] || "";
      return (f.tech.zh || "出招") + (ph ? "·" + ph : "");
    }
    const base = (f.state === "idle" && opp && (opp.state === "down" || opp.rising)) ? "收势" : (SEG_LABEL[f.state] || f.state);   // 对手倒地/起身时自己的等待＝收势（不是待机，2026-09-29）
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
    f.seg = { key: key, t0: sim.t, label: segLabel(f, f === sim.A ? sim.B : sim.A), phase: f.state === "attack" ? (PHASE_LABEL[f.phase] || null) : null };
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
    f.wallT = 0; f.wasHover = false; f.wasStall = false;      // 落地＝离开滞空（不复位的话整场只会记一次 air_stall）
    // 落地不打断正在出的招（俯冲命中落地也算数），只给落地屈膝与硬直；否则会出现姿态硬切
    const busy = f.state === "recover" && sim.t < f.recoverUntil || f.state === "attack" || f.state === "dodge" || f.state === "cast" || f.state === "hitstun" || f.state === "stagger";
    if (f.state !== "down" && !busy) { f.state = hard ? "land" : f.state; f.landLock = hard ? 0.22 : 0.10; }
    else if (busy && hard) f.landLock = Math.max(f.landLock, 0.16);
    f.post = "stand";
    sim.events.push({ t: +sim.t.toFixed(3), type: "landing", who: f.id, x: +f.x.toFixed(3), y: +f.y.toFixed(3),
                      z: 0, impact: +impact.toFixed(2), from: +f.peakZ.toFixed(2), hard, water: sim.scen.water > 0 });
      // 击倒（2026-09-29）：被抛飞后**重重落地**就真的倒地，而不是只有 KO 才倒 ——
      //   原来非致命命中永远不会倒地（实测一场倒地 1.0 次＝就是 KO 那一下、起身 0 次）。
      //   倒地 0.7~1.6 秒（按落点冲击给），之后自己起身（见状态机里的 getup），起身带 0.25 秒无敌。
      if (f.launched && impact > 2.8 && f.hp > 0 && f.state !== "down") {
        f.launched = false; f.launchedAt = 0;
        f.state = "down"; f.post = "stand"; f.vz = 0; f.fallT = 0;   // fallT 归零＝这一跤从 0 开始倒（否则第二跤起 ft 直接是 1，一帧躺平）
        f.downT = Math.min(2.6, Math.max(1.5, 1.0 + impact * 0.22));   // 落地越重躺得越久（1.5~2.6 秒）
        ACTIONS.beginDown(sim, f, f.downT);
        f.iframes = Math.max(f.iframes || 0, 0.25);
        f.stats.knockdowns = (f.stats.knockdowns || 0) + 1;
        sim.events.push({ t: +sim.t.toFixed(3), type: "knockdown", who: f.id, x: +f.x.toFixed(3), y: +f.y.toFixed(3), z: 0,
                          impact: +impact.toFixed(2), from: +f.peakZ.toFixed(2), hp: +f.hp.toFixed(1) });
      } else if (f.launched) { f.launched = false; f.launchedAt = 0; }
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
        // 落地冲击波也要掀翻周围（7 级以上"砸下来就是一片废墟"）
        blast(sim, f, f.x, f.y, +Math.max(R, blastRadius(f.prof.tier, 1.1) * 0.6).toFixed(2), 1.1, "落地冲击");
      }
    }
    if(f.hp<=0){f.motion=null;ACTIONS.beginDown(sim,f,3);}
    f.peakZ = 0;
  }

  // ── 主循环 ───────────────────────────────────────────────────────────
  function simulate(opt) {
    const o = opt || {};
    if (CONTRACT) CONTRACT.validate(o);
    const seed = (o.seed == null ? 20260911 : o.seed) >>> 0;
    const rng = mulberry32(seed);
    const arena = o.arena || { w: 20, h: 12 };
    if(!Number.isFinite(arena.w)||!Number.isFinite(arena.h)||arena.w<2||arena.h<2) throw Error('Invalid arena');
    if(o.duration!=null&&(!Number.isFinite(o.duration)||o.duration<DT||o.duration>120)) throw Error('Duration must be between 1/60 and 120 seconds');
    const maxT = o.duration || 30;
    const commands = CHOREOGRAPHY.validate(o.choreography || [], maxT);let commandIndex=0;
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
    const sim = { t: 0, seed, A, B, events: [], frames: o.record === false ? null : [], rng, arena, over: null, overT: 0, maxT: maxT,
                  scen: SCEN.none, props: [], ring: null, chase: null, shots: [], shotSeq: 0,
                  timeline: [],                       // 动作时间账（每段：t0→t1、时长、标签）
                  timing: { actions: 0, actionTime: 0, longest: 0 } };
    // 场地天花板：真飞行档最高能到 6.5 米，场地要装得下（默认 14 米兜底）
    const ceilZ = Number.isFinite(arena.z) && arena.z > 2 ? Math.min(AIR_MAX, arena.z) : AIR_MAX;
    // ── 情景（v0.5）：把界面声明的情景规则真的接进结算 ────────────────────
    const scen = scenario(o.scenario);
    sim.scen = scen;
    if (scen.aerial) { A.mob = aerialFloor(A.mob); B.mob = aerialFloor(B.mob); }
    // ── 可破坏环境（2026-09-25 用户：「高手打架的招式或法术打倒周围建筑物、道具都是会打碎的。
    //    而不是一点动静都没。越是厉害的人越夸张。」）────────────────────────────────
    //   原来：每个情景固定 6 件小道具、擂台/空战 0 件、只有"挡在兵器线路上"才碎 ——
    //   实测 9 级的破坏反而比 2 级更少（0 件/场 vs 1.3 件/场），完全反了。
    //   现在：件数、体量、分布半径都随本场最高武力等级放大；5 级起出现**建筑类**（院墙/牌楼/廊柱/塔檐），
    //   8 级起是半塌院墙/石塔/山门这种大体量结构；而且命中会有**破坏半径**（见 blast()），不再只碎挡路那件。
    {
      const topTier = Math.max(1, Math.min(9, Math.max(A.prof.tier || 1, B.prof.tier || 1)));
      const base = scen.obstacles > 0 ? scen.obstacles : 5;                 // 擂台/空战/水战也要有环境
      // 2026-09-29：件数随**场地面积**放大（默认场地放大到面积 10 倍之后，仍是 22 件摊在 60 米半径里
      //   → 3D 里看着像空场，也失去"高手打架把周围打碎"的密度）。36 米≈旧默认场地的最小边。
      const areaF = Math.max(1, Math.min(arena.w, arena.h) / 36);
      const count = Math.min(140, Math.round((base * 0.7 + 3 + topTier * 2.1) * areaF));
      const SMALL = ["酒坛", "木箱", "条凳", "香炉", "杂物堆", "木桩"];
      const BUILD = ["院墙", "廊柱", "牌楼", "塔檐", "石狮"];
      const MEGA = ["半塌院墙", "石塔", "山门"];
      const props0 = [];
      const startPts = [{ x: arena.w * 0.5 - 1.6, y: arena.h * 0.5 }, { x: arena.w * 0.5 + 1.6, y: arena.h * 0.5 }];
      // 分布半径：等级越高场面越大，靠"一圈掩体"已经不够（大片里的建筑物是铺开的）
      const midR = Math.min(arena.w, arena.h) * (0.18 + topTier * 0.022);
      for (let i = 0; i < count; i++) {
        const isMega = topTier >= 8 && i % 7 === 3;
        const isBuild = !isMega && topTier >= 5 && i % 3 === 0;
        const kinds = isMega ? MEGA : (isBuild ? BUILD : SMALL);
        const kind = kinds[i % kinds.length];
        const ang = (i / count) * Math.PI * 2 + rng() * 0.9;
        // 中间留出空场：小件铺在 0.75~1.6 倍中环、大型结构更外（高等级的破坏半径本来就够得着它们）
        // 内圈留空：物件一律放在外圈（否则会把交手区塞满，甚至把人夹住）
        const inner = Math.max(3.0, Math.min(arena.w, arena.h) * 0.30);
        const rad = inner + (isMega ? midR * (0.35 + rng() * 0.6) : midR * (0 + rng() * 0.75));
        let px = arena.w * 0.5 + Math.cos(ang) * rad;
        let py = arena.h * 0.5 + Math.sin(ang) * Math.min(rad, Math.max(1.2, arena.h * 0.58 - 1.0));
        for (const sp of startPts) {
          const dx = px - sp.x, dy = py - sp.y, dd = Math.hypot(dx, dy);
          if (dd < 1.1 && dd > 1e-6) { px = sp.x + dx / dd * 1.1; py = sp.y + dy / dd * 1.1; }
        }
        px = Math.max(0.7, Math.min(arena.w - 0.7, px));
        py = Math.max(0.7, Math.min(arena.h - 0.7, py));
        // 半径封顶：比人大一圈就够了（半径过大时人会被"包在结构里"，每帧推出+消速 → 卡死）
        const rr = isMega ? 1.6 + rng() * 0.4 : (isBuild ? 0.8 + rng() * 0.4 : 0.38 + rng() * 0.26);
        const tough = isMega ? 5 : (isBuild ? (kind === "石狮" || kind === "廊柱" ? 3 : 2) : ((kind === "石柱" || kind === "断柱") ? 2 : 1));
        // h＝这件东西有多高（米）：法术飞得比它高就不该被它挡住（空战/浮空法术常年在 2 米以上）
        const hh = isMega ? 5.5 + rng() * 2.5 : (isBuild ? 2.6 + rng() * 1.6 : (kind === "酒坛" ? 0.8 : 1.0 + rng() * 0.4));
        props0.push({ id: "P" + (i + 1), zh: kind, x: +px.toFixed(3), y: +py.toFixed(3),
                      r: +rr.toFixed(2), tough: tough, hit: 0, broken: false, h: +hh.toFixed(2),
                      building: !!(isMega || isBuild), mega: !!isMega });
      }
      sim.props = props0;
    }
    // 擂台边界：越界即掉台（险境），三次掉台判负
    //   ⚠ 2026-09-29 修：半径原来是**固定 4.2 米**，而开局两人各在台心 4.375 米处（startDist 2.5 格 = 8.75 米）
    //     → 开局双方就在台外，t=0 立刻各判一次掉台（掉血＋0.6 秒硬直），并被拽回台心；
    //     更糟的是台边拉力线在 r−1.2 = 3 米，"擂台战"于是被关进一个 5~6 米的小圈里
    //     （实测活动半径 p99 只有 4.1 米、每场掉台 11.4 次 —— 场地 56×35 米完全没用上，连贯性全被复位打断）。
    //   现在：台子按「装得下开局站位 + 一次冲刺」算，并且开局站位再兜一次底（任何场地尺寸都不许"开局即台外"）。
    if (scen.ring > 0) {
      const half = Math.min(arena.w, arena.h) * 0.5;
      const openD = Math.hypot(B.x - A.x, B.y - A.y);
      const need = Math.max(openD * 1.35, 5.0 + Math.max(A.mob.dash, B.mob.dash) * 1.6);
      // 2026-09-29：台子要**随场地一起长大**（用户要求把默认场景放大）：只按 need 封顶的话，
      //   场地放大 10 倍后台子还是 11.8 米 —— 又变回"大场地里的小笼子"。所以取 half 的 0.75 与 need 的较大者，
      //   再用 half-0.6 封顶（场地越大，台子越大，险境机制仍在）。
      sim.ring = { cx: arena.w * 0.5, cy: arena.h * 0.5, r: Math.max(2.0, Math.min(half - 0.6, Math.max(need, half * 0.75))) };
      for (const f of [A, B]) {
        const dx = f.x - sim.ring.cx, dy = f.y - sim.ring.cy, d = Math.hypot(dx, dy);
        const lim = Math.max(0.5, sim.ring.r - 1.5);
        if (d > lim && d > 1e-6) { f.x = sim.ring.cx + dx / d * lim; f.y = sim.ring.cy + dy / d * lim; }
      }
    }
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
      // 2026-10-01 用户：「人物最开始放到场地中心」→ 追逐战也从街道**中段**开局：
      //   追者在中段偏后、逃者在中段偏前，两侧各留半条跑道（旧版贴左端 1.6/6.6，一开镜就在场地边上）。
      //   两人都在街道**中段**开局（不贴任何一端）：逃者放在街长 45% 处、前方留半条跑道，
      //   追者在其后一个身位区（≥5 米、≤9 米）。旧版贴左端 1.6/6.6，一开镜就在场地边上。
      const gap0 = Math.max(6.0, Math.min(10.0, arena.w * 0.34));
      F0.x = Math.min(arena.w - 1.6, Math.max(arena.w * 0.55, 2.0 + gap0)); F0.y = arena.h * 0.5; F0.face = 0;
      C0.x = Math.max(1.6, F0.x - gap0); C0.y = arena.h * 0.5; C0.face = 0;
    }
    const TAIL = o.tail == null ? 1.2 : o.tail;    // 终结后的余波（倒地过程 + 收势），供 3D 与提示词使用
    const fr = (v) => +v.toFixed(4);

    for (let step = 0; step < Math.round(maxT / DT); step++) {
      sim.t = step * DT;
      // Authored actions are optional; rehearsal uses the same physics and clocks.
      while(commandIndex<commands.length && commands[commandIndex].t<=sim.t+1e-7){
        const c=commands[commandIndex++], f=c.who==='A'?A:B, opp=f===A?B:A;
        let reason='';
        if(f.hp<=0)reason='角色已被击败';
        else if(lockCheck(f)||f.state==='recover'&&sim.t<f.recoverUntil)reason='前一动作尚未结束';
        else if(c.kind==='attack'&&c.variant&&!([...VARIANTS,...AIR_VARIANTS].some(v=>v.key===c.variant)||SKILLS?.get(c.variant)?.category==='拳脚'&&f.wpnKey==='none'))reason='未配置该近战招式';
        else if(c.kind==='cast'&&!f.spells.some(sp=>sp.id===c.variant||sp.zh===c.variant||SKILLS?.get(c.variant)&&String(sp.zh).includes(SKILLS.get(c.variant).family)))reason='未配置该招式或法术';
        else if(c.kind==='flight'&&!f.mob.flight)reason='等级未解锁飞行';
        else if(['roll','down'].includes(c.kind)&&f.z>.12)reason='动作需要先落地';
        else if(['roll','dodge'].includes(c.kind)&&f.rules.noDodge)reason='规则禁止闪避';
        if(reason){sim.events.push({t:+sim.t.toFixed(3),type:'command_rejected',who:f.id,kind:c.kind,reason});continue;}
        sim.events.push({t:+sim.t.toFixed(3),type:'command_start',who:f.id,kind:c.kind,scheduled:c.t});
        if(c.kind==='cast'){const form=SKILLS?.get(c.variant),sp=f.spells.find(x=>x.id===c.variant||x.zh===c.variant||form&&String(x.zh).includes(form.family));if(startCast(sim,f,form?{...sp,formKey:form.key}:sp)===false)sim.events.push({t:+sim.t.toFixed(3),type:'command_rejected',who:f.id,kind:c.kind,reason:'施法空间、体力、等级或冷却不满足'});}
        else if(c.kind==='land'){f.mustLand=true;f.launched=false;f.vz=Math.min(f.vz,-1);}
        else if(c.kind==='launch'){
          if(!o.rehearsal){sim.events.push({t:+sim.t.toFixed(3),type:'command_rejected',who:f.id,kind:c.kind,reason:'受击演练仅在排练模式可用'});continue;}
          f.launched=true;f.launchedAt=sim.t;f.vz=Math.sqrt(2*G_Z*1.4);f.state='hitstun';f.hitstun=.5;
          sim.events.push({t:+sim.t.toFixed(3),type:'launch',who:f.id,apex:1.4,airT:2*f.vz/G_Z,z:f.z,rehearsal:true});
        }else if(c.kind==='down'){
          if(!o.rehearsal){sim.events.push({t:+sim.t.toFixed(3),type:'command_rejected',who:f.id,kind:c.kind,reason:'倒地演练仅在排练模式可用'});continue;}
          ACTIONS.beginDown(sim,f,1.6);sim.events.push({t:+sim.t.toFixed(3),type:'knockdown',who:f.id,z:f.z,rehearsal:true});
        }else{f.intent={kind:c.kind==='flight'?'takeoff':c.kind,dir:c.kind==='leap'?'up':c.dir,reason:c.kind==='leap'?'airStrike':'choreography',variant:c.kind==='attack'?([...VARIANTS,...AIR_VARIANTS].find(v=>v.key===c.variant)||(SKILLS?.get(c.variant)?.category==='拳脚'&&f.wpnKey==='none'?{...VARIANTS.find(v=>v.key==='thrust')||VARIANTS[0],zh:SKILLS.get(c.variant).zh,routine:c.variant}:pickVariant(f,opp,f.rng))):undefined};steer(sim,f,opp,DT,f.rng);f.decideT=c.hold||.15;}
      }
      // 逐帧交替处理顺序：否则"后处理的一方"总是拿到对方的最新位置，
      // 会形成系统性优势（同级同风格对局会变成一边倒）
      const list = (step % 2 === 0) ? [A, B] : [B, A];
      for (const f of list) {
        const opp = f === A ? B : A;
        // 计时器
        if(f.state==='recover'&&sim.t>=f.recoverUntil){f.state='idle';sim.events.push({t:+sim.t.toFixed(3),type:'cast_recovery_end',who:f.id});}
        f.hitstun = Math.max(0, f.hitstun - DT);
        if (f.iframes > 0) f.iframes = Math.max(0, f.iframes - DT);
        if (f.lastHitT != null && sim.t - f.lastHitT > 1.4 && f.hitsTaken) f.hitsTaken = 0;
        f.blockHold = Math.max(0, f.blockHold - DT);
        f.roll = Math.max(0, (f.roll || 0) - DT);
        f.landLock = Math.max(0, f.landLock - DT);
        if (f.state === "land" && f.landLock <= 0) f.state = "idle";
        // 冲刺收尾保险（2026-09-25）：意图在冲刺结束前被换掉时，也要把这一冲的实际位移记账
        if (f.dashWhy && sim.t > (f.dashUntil || 0) + 0.02) {
          if (f.dashFrom) {
            const dd = Math.hypot(f.x - f.dashFrom.x, f.y - f.dashFrom.y);
            f.dashDist = (f.dashDist || 0) + dd;
            f.stats.dashDist = (f.stats.dashDist || 0) + dd;
            sim.events.push({ t: +sim.t.toFixed(3), type: "dash_end", who: f.id, why: f.dashWhy,
              x: +f.x.toFixed(3), y: +f.y.toFixed(3), dist: +dd.toFixed(2),
              speed: +(dd / Math.max(0.08, sim.t - (f.dashT0 == null ? sim.t : f.dashT0))).toFixed(1) });
          }
          f.dashWhy = null; f.dashFrom = null;
        }
        // 空中招数会随时间回充：滞空不是"用完三招就干等"，而是限速的连击
        if (f.z > 0.15) {
          f.airHold += DT;
          f.airT = (f.airT || 0) + DT;                  // 每场滞空预算
          f.airIdleT = (f.airIdleT || 0) + DT;
          f.airAtkTimer -= DT;
          if (f.airAtkTimer <= 0) { f.airAtkLeft = Math.min(f.mob.airAtk, f.airAtkLeft + 1); f.airAtkTimer = 0.9; }
          // 真气有限：一次滞空有上限。分档写清楚（用户要求）：
          //   · 飞行档（7 级以上）= 浮空战斗：一次能压在空中十几秒，双方在天上换招、抢高度、俯冲再拉起；
          //   · 轻功/踏墙档（3~6 级）= 短暂滞空：跃到最高点提气停住一口气（mob.float 秒），打一两下就落地。
          const holdCap = (f.mob && f.mob.flight)
            ? (f.mob.tier >= 9 ? 16 : (f.mob.tier >= 8 ? 12 : 9))
            : ((f.mob && f.mob.float > 0) ? (f.mob.float + 1.6) : 1.2 + 0.22 * (f.tier || 1));
          if (f.airHold > holdCap) f.mustLand = true;      // 单次滞空上限（等级越高越长，但都有顶）
          // 空中空转：既没有来招也在射程外 → 0.8 秒内落地（不许靠滞空表演）
          if (f.z > 0.4) {
            const _opp = (f === sim.A ? sim.B : sim.A);
            const _oppAtk = _opp.state === "attack" && (sim.t - (_opp.atkStart || 0)) < 0.45;
            const _dist = Math.hypot(_opp.x - f.x, _opp.y - f.y);
            if (_oppAtk || _dist <= f.reach * 1.45 || (_opp.z > 0.4 && _dist <= f.reach * 2.2)) f.airIdleT = 0;
            // 空中空转太久才落地：双方都能飞的时候给到 1.8 秒（空战本来就有拉开距离绕圈的阶段），
            //   对手在地上却够不着时只给 0.5 秒（不许在天上表演）。
            const bothFly = f.mob.flight && _opp.z > 1.2 && _opp.mob && _opp.mob.flight;
            // 2026-09-25：地面冲刺变快之后空中时间被挤掉一点，这里按档位给回一点余量——
            //   飞行档本来就是"飞天遁地"，在天上绕半圈再决定压下去是它该有的样子。
            // 爬升期（还没到档位高度）不算"天上空转"：否则飞到一半就被判空转落下来（实测 7 级只到 2.84m）
            const climbing = f.mob.flight && f.z < (f.mob.hover || 2) * 0.85;
            const idleCap = bothFly ? 2.8 : (climbing ? 2.0 : (f.mob.flight ? 1.6 : 0.5));
            if (f.airIdleT > idleCap) f.mustLand = true;
          }
        } else {
          f.airHold = 0; f.airAtkTimer = 0;
          if (f.sta < 22) f.mustLand = true;          // 气力见底 → 收功落地
          if (f.sta > 62) f.mustLand = false;         // 回到一定气力才能再起飞
        }
        if (f.z > 0.4 && f.sta < 12) f.mustLand = true;
        if (f.state === "hitstun" || f.state === "stagger") { if (f.hitstun <= 0 && f.state === "hitstun") f.state = "idle"; if (f.hitstun <= 0 && f.state === "stagger") f.state = "idle"; }
           // 起身（2026-09-29）：被打倒（knockdown，非 KO）躺满硬直后自己爬起来，并留一点无敌帧 ——
           //   原来 down 只出现在 KO 那一下（比赛随即结束），所以从来没有"起身"这一拍。
                      if (f.state === "down" && f.hp > 0 && !f.motion) {
             // 起身分两段（2026-09-29）：**先爬起 0.6 秒**（躺→撑地→站起，3D 与提示词都要有这段时间），
             //   再站定。原来 hitstun 一到就直接变 idle —— 素材里只有"躺"，没有"爬起"这一拍。
             const RISE = 0.6;
             if (f.hitstun <= RISE && !f.rising) {
               f.rising = true; f.riseT = RISE;   // riseT：3D 姿态层用它算"撑地爬起来"的进度（snap 的 rise）
               sim.events.push({ t: +sim.t.toFixed(3), type: "getup", who: f.id, x: +f.x.toFixed(3), y: +f.y.toFixed(3), z: 0,
                                 phase: "rise", riseT: RISE, downT: +(f.downT || 0).toFixed(2), hp: +f.hp.toFixed(1) });
             }
             if (f.hitstun <= 0) {
               f.state = "idle"; f.post = "stand"; f.rising = false;   // ⚠ 不重置 fallT：3D 的倒地混合系数靠它，归零会把"已躺平"弹回"正在倒"（实测单帧胸口跳 1.25m）
               f.iframes = Math.max(f.iframes || 0, 0.25);
               f.stats.getups = (f.stats.getups || 0) + 1;
             }
           }
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
        if (f.state === "dodge" && f.hitstun <= 0 && !f.motion) { f.state = "idle"; f.post = "stand"; }
        ACTIONS.tick(sim, f, DT);
        // 久战升级：14 秒后出手越来越重、20 秒后双方都不再举架磨时间
        // （久战必分胜负，而不是两只"乌龟"拖到时间到）
        // 飞行档（7 级以上）掉体力明显更慢：他们是"浮空战斗"的主力，不能打到二十秒就没气落地
        //   （用户要求：7 级以上高手要能浮空战斗，所以末期也要留得住滞空的本钱）。
        if (!o.rules?.lowDmg && sim.t > 12) {
          const decay = (f.mob && f.mob.flight) ? 0.012 : 0.03;
          f.staMax = Math.max(35, 100 * f.prof.stam * (1 - (sim.t - 12) * decay));
          f.sta = Math.min(f.sta, f.staMax);
        }
        if (!o.rules?.lowDmg && sim.t > 18) f.guard = Math.min(f.guard, f.guardMax * Math.max(0, 1 - (sim.t - 18) * 0.07)); // 架势会散
        f.esc = o.rules?.lowDmg ? 1 : 1 + Math.max(0, sim.t - 14) * 0.13 + Math.max(0, sim.t - 22) * 1.25 + Math.max(0, sim.t - 26) * 2.0;  // 伤害升级：末段进入"决胜"
        // 体力（腾空时几乎不回气：能不能一直飞由体力决定，而不是无限的；飞行档在空中回气更快一点）
        const regen = f.z > 0.4 ? ((f.mob && f.mob.flight) ? 4 : 2) : (f.state === "block" ? 9 : (f.state === "attack" || f.state === "dodge" ? 3 : 16));
        f.sta = Math.min(f.staMax, f.sta + regen * DT * f.prof.stam);
        // 施法推进：前摇走完就放出去；中途被打断/换状态则散功
        if (f.state !== "cast") { f.castSpell = null; f.castT = 0; f.auraOn = false; }
        if (f.state === "cast" && f.castSpell) {
          f.castT += DT;
          if (f.castT >= (f.castDur || SPELL_CAST)) {const form=f.castEff?.form;f.castRecovery=form?pickInRange(sim,form.timing.recover):.35;releaseSpell(sim, f, f.castSpell);f.castReadyAt=sim.t+f.castRecovery+(form?.timing.gap||.25);if(f.castSourceId)f.spellCd[f.castSourceId]=Math.max(f.spellCd[f.castSourceId]||0,f.castReadyAt+(form?.timing.cooldown||0));f.state="recover";f.recoverUntil=sim.t+f.castRecovery;f.castSpell=null;f.castT=0;f.castDur=0;f.auraOn=false;sim.events.push({t:+sim.t.toFixed(3),type:'cast_recovery',who:f.id,duration:f.castRecovery,readyAt:f.castReadyAt});}
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
        // ── 出招中途"读招收手"（2026-10-01 打斗智商）──────────────────────────
        //   双方同时起手时，读招好的一方**可以收手改成防守**；旧版一旦起手就必须打完，
        //   于是"两个人对着挥、其中一个硬吃"（体检实测：疾风型对嗜血型整场 0 格挡 0 闪避）。
        //   只有起手阶段（windup）能收手，收手要付体力与一点硬直，读招越好越容易收。
        if (f.state === "attack" && f.tech && f.phase === "windup") {
          const _oppA = (f === sim.A) ? sim.B : sim.A;
          const _incoming2 = (_oppA.state === "attack" && _oppA.phase !== "recovery") || _oppA.state === "cast" ||
                             (sim.shots && sim.shots.some(s => s.owner !== f.id));
          if (_incoming2 && f.sta > 22 && !f.rules.noDodge && !f.rules.noBlock) {
            const _read = (f.iq && f.iq.read) || 0.5;
            if (sim.rng() < 0.016 + 0.034 * _read) {
              const _iq = f.iq || { block: 0.5, dodge: 0.4, roll: 0.15, counter: 0.4 };
              f.state = "idle"; f.phase = ""; f.tech = null; f.bladeAng = null;
              f.hitstun = 0.06; f.sta = Math.max(0, f.sta - 6);
              f.stats.aborts = (f.stats.aborts || 0) + 1;
              const _canB2 = canBlock(_oppA, f);
              const _rr = sim.rng(), _dir = sim.rng() < 0.5 ? -1 : 1;
              if (_rr < 0.45 * _iq.dodge && f.sta > 14)
                f.intent = { kind: "dodge", dir: _dir, crouch: sim.rng() < 0.35, reason: "abortGuard" };
              else if (_rr < 0.45 * _iq.dodge + 0.22 * _iq.roll && f.sta > 26)
                f.intent = { kind: "roll", dir: _dir, reason: "abortGuard" };
              else if (_canB2) f.intent = { kind: "block", reason: "abortGuard" };
              else f.intent = { kind: "dodge", dir: _dir, reason: "abortGuard" };
              f.decideT = Math.max(f.decideT || 0, 0.10);      // 别让下一拍决策立刻把它冲掉
            }
          }
        }
        // 倒地：记录倒下过程的时间（0→0.55s 内完成躺倒，供 3D 平滑过渡）
        if (f.state === "down") f.fallT = (f.fallT || 0) + DT;
        // ── 神通余波（2026-09-25）─────────────────────────────────────────
        //   ① 分身多段：本体打完之后，分身错开半拍各补一下（用队列兑现，而不是瞬间结算）
        if (f.multi && f.multi.left > 0 && sim.t >= f.multi.next) {
          const opp2 = f === sim.A ? sim.B : sim.A;
          const d2 = Math.hypot(opp2.x - f.x, opp2.y - f.y);
          if (d2 <= f.reach * 3.4 + 0.6 && opp2.state !== "down") {
            const before = opp2.hp;
            applyHit(sim, f, opp2, { dmg: f.multi.dmg, kb: 0.7, arc: 360, h: "mid", zh: "分身术·群棍", key: "clone", clone: true }, true);
            sim.events.push({ t: +sim.t.toFixed(3), type: "clone_hit", who: opp2.id, by: f.id, tech: "分身术·群棍",
              x: +opp2.x.toFixed(3), y: +opp2.y.toFixed(3), z: +(opp2.z || 0).toFixed(3),
              left: f.multi.left - 1, damage: +Math.max(0, before - opp2.hp).toFixed(2) });
            f.cloneLeft = (f.cloneLeft || 0) + 1;
          } else {
            sim.events.push({ t: +sim.t.toFixed(3), type: "clone_miss", who: f.id, left: f.multi.left - 1 });
          }
          f.multi.left -= 1;
          f.multi.next = sim.t + f.multi.gap;
          if (f.multi.left <= 0) f.multi = null;
        }
        //   ② 增益（三头六臂/风火轮/变化）到时自动结束
        if (f.buff && f.buff.dur > 0) {
          f.buff.dur -= DT;
          if (f.buff.dur <= 0) {
            sim.events.push({ t: +sim.t.toFixed(3), type: "trait_end", who: f.id, trait: f.buff.key,
              x: +f.x.toFixed(3), y: +f.y.toFixed(3), z: +(f.z || 0).toFixed(3) });
            f.buff = null;
          }
        }
        if (f.transformUntil && sim.t > f.transformUntil) f.transformUntil = 0;
        //   ③ 命中连击计数（衔接技的触发依据）：超过 3 秒没命中就清零
        if (f.hitStreak > 0 && sim.t - (f.lastHitAt == null ? -9 : f.lastHitAt) > 3) f.hitStreak = 0;
        // 决策（12Hz）
        f.decideT -= DT;
        if (!o.rehearsal && !lockCheck(f) && f.decideT <= 0) {
          f.decideT = 1 / 12 + f.rng() * 0.03;
          f.intent = decide(sim, f, opp, f.rng);
        }
        if (!o.rehearsal && !lockCheck(f)) {
          if (f.state !== "block") f.state = "idle";
          steer(sim, f, opp, DT, f.rng);
        } else if (f.state === "attack" && f.phase === "windup") {
          // ── 起手追招：只允许转向、不许改意图 ──────────────────────────
          // 真实武打出手瞬间会跟着对手挪半步；判定帧起仍然锁死朝向，
          // 所以"砍空后要重新转身"的代价保留，但不再出现"朝着空气挥"。
          const want = Math.atan2(opp.y - f.y, opp.x - f.x);
          const rate = f.prof.turn * DT * 0.75;
          f.face += clamp(norm(want - f.face), -rate, rate);
        } else if (f.state === "cast") {
          // 施法期间**不站桩**：踏罡步斗（保持距离绕步 / 边结印边压上）。
          //   这里也需要跟一下朝向——走位会让目标偏离正面。
          castSteer(sim, f, opp, DT, f.rng);
          const want2 = Math.atan2(opp.y - f.y, opp.x - f.x);
          const rate2 = f.prof.turn * DT * 0.55;
          f.face += clamp(norm(want2 - f.face), -rate2, rate2);
        }
      }
      // 物理积分 + 垂直轴（重力 / 悬停 / 落地）+ 边界
      for (const f of list) {
        f.x += f.vx * DT; f.y += f.vy * DT;
        // 残影：特效档 6 起，高速位移（冲刺 / 凌空 / 踏墙）沿途留下残影（仙侠身法的核心观感）
        const FL = (f.fx && f.fx.level) || 1;
        if (FL >= 6 && f.state !== "down") {
          const spd = Math.hypot(f.vx, f.vy) + Math.abs(f.vz);
          const need = FL >= 8 ? 6 : 8, gapT = FL >= 8 ? 0.28 : 0.35;   // 档位越高越容易留残影（6~7 档 8 米/秒·0.35 秒；8 档起 6 米/秒·0.28 秒）
          if (spd > need && sim.t - (f.lastAfterimage || -9) > gapT) {
            f.lastAfterimage = sim.t;
            f.stats.afterimages = (f.stats.afterimages || 0) + 1;
            sim.events.push({ t: +sim.t.toFixed(3), type: "afterimage", who: f.id,
                              x: +f.x.toFixed(3), y: +f.y.toFixed(3), z: +f.z.toFixed(3),
                              speed: +spd.toFixed(1), fxLevel: FL,
                              palette: (f.fx && f.fx.palette) || "", air: f.z > 0.4 });
          }
        }
        // 水平阻尼：空中更小（轻功冲刺与击飞真的飞得远）；水战按 slick 数值连续变滑
        const drag = Math.pow(f.z > 0.2 ? 0.10 : (0.02 + scen.slick * 0.25), DT);
        f.vx *= drag; f.vy *= drag;
        if (f.z > 0 || f.vz !== 0) {
          const hovering = !f.launched && f.hp > 0 && !ACTIONS.locked(f) && f.mob.flight && f.z > 0.15 && !f.mustLand && f.sta > 12;
          // 轻功短滞空（3~6 级）：跃到最高点提气停住一口气，能停 mob.float 秒、在空中打一两下再落。
          //   "短暂在空中停留打斗"是用户明确要的档位能力，所以它不是飞行，而是"提气"。
          //   ⚠ 必须停在**接近最高点**：早停会在半米处就凝住，看起来像"跳不起来"（实测 3 级只到 0.5 米）。
          // ⚠ 不判 !mustLand：起跳本身要花气力，扣完就可能被置上 mustLand，
          //   于是"提气停一口气"这个动作永远做不出来（实测 7 次轻功突袭只换来 1 次滞空）。
          //   滞空是起跳换来的收益，只要还有一点气就允许停这一口；之后照样落地。
          const floatTop = !f.launched && f.hp > 0 && (f.mob.float || 0) > 0 && !f.mob.flight && f.z > 0.55 && f.vz <= 0.6 && f.vz > -2.9 &&
                           (f.airHold || 0) < f.mob.float && f.sta > 8;
          if (hovering && f.vz <= 0.5 && f.z <= f.mob.hover + 0.35) {
            f.vz = f.z > f.mob.hover ? -1.6 : 0;      // 悬停：停在档位高度，超了缓慢下沉
            // 悬停耗气按档位递减：9 级 6/秒、8 级 7/秒、7 级 8/秒 —— 高等级高手能长时间压在空中打，
            //   这正是"浮空战斗"的本钱（低等级或落档仍按 11/秒：飞两下就得落地）。
            const hd = (f.mob && f.mob.flight) ? (f.mob.tier >= 9 ? 6 : (f.mob.tier >= 8 ? 7 : 8)) : 11;
            f.sta = Math.max(0, f.sta - hd * DT);
            // ── 悬停不是"钉在空中"（2026-09-25 快节奏）─────────────────────
            //   飞行档原来悬停时水平速度被阻尼吃光（空中 drag=0.10^DT），画面就是"两个人飘着对望"。
            //   真实的御空是**绕圈／抢高度／侧移找角度**：给一个切向速度，让悬停也一直在动。
            {
              const _o = (f === sim.A ? sim.B : sim.A);
              const _to = Math.atan2(_o.y - f.y, _o.x - f.x);
              const _side = f.hoverDir == null ? (f.hoverDir = (f.rng() < 0.5 ? -1 : 1)) : f.hoverDir;
              const _a = _to + _side * Math.PI / 2;
              const _v = 3.0 + f.mob.tier * 0.18;        // 9 级约 4.6 m/s 的绕飞
              f.vx += Math.cos(_a) * _v * 3.2 * DT; f.vy += Math.sin(_a) * _v * 3.2 * DT;
              const _c = Math.hypot(f.vx, f.vy);
              if (_c > _v) { f.vx *= _v / _c; f.vy *= _v / _c; }
              if (f.state === "idle") f.state = "move";
              if (sim.t - (f.hoverMoveT == null ? -9 : f.hoverMoveT) > 0.8) {
                f.hoverMoveT = sim.t;
                f.stats.hoverMoves = (f.stats.hoverMoves || 0) + 1;
                sim.events.push({ t: +sim.t.toFixed(3), type: "hover_move", who: f.id,
                  x: +f.x.toFixed(3), y: +f.y.toFixed(3), z: +f.z.toFixed(3),
                  speed: +Math.hypot(f.vx, f.vy).toFixed(1),
                  zh: f.rng() < 0.5 ? "凌空绕飞找角度" : "御空侧移抢身位" });
              }
            }
          } else if (floatTop) {
            f.vz = 0;                                  // 提气滞空：这一瞬间不下坠
            f.sta = Math.max(0, f.sta - 22 * DT);      // 滞空比悬停更耗气（凡体硬撑）
            // 第一次进入滞空发一个事件：提示词里要写成"提气一停、在半空换招"，不是"跳起来落地"
            if (!f.wasStall) {
              f.wasStall = true; f.stats.stalls = (f.stats.stalls || 0) + 1;
              sim.events.push({ t: +sim.t.toFixed(3), type: "air_stall", who: f.id,
                                x: +f.x.toFixed(3), y: +f.y.toFixed(3), z: +f.z.toFixed(3), mob: f.mob.zh });
            }
          } else {
            if (f.wasStall) f.wasStall = false;
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
        // 追逐战末段（26 秒后）：谁都不许再靠滞空拖时间 —— 落地把这一场打完
        if (sim.chase && sim.t > 26 && f.z > 0.05) f.mustLand = true;
        f.x = clamp(f.x, CAP_R, arena.w - CAP_R); f.y = clamp(f.y, CAP_R, arena.h - CAP_R);
        // 掩体是实体：撞上石墙/木箱会被挡住（贴地时才算碰撞，人在高空不算）
        if (f.z < 1.1) for (const pr of sim.props) {
          if (pr.broken) continue;
          const px = f.x - pr.x, py = f.y - pr.y, rr = pr.r + CAP_R;
          // 粗筛（性能）：可破坏物变多之后这段是热点，先看两轴距离再开方
          if (px > rr || px < -rr || py > rr || py < -rr) continue;
          const d2 = px * px + py * py;
          if (d2 >= rr * rr) continue;
          const pd = Math.sqrt(d2);
          if (pd > 1e-6) {
            const runSp = Math.hypot(f.vx, f.vy);
            // ① 小件是布景，不是墙（2026-09-25）：跑过去就顺手撞碎，**不挡人**——
            //    否则"件数随等级放大"会把战场变成障碍跑道（实测追逐战逃跑帧掉到 0、KO 率下降）。
            if (!pr.building) {
              if (runSp > 2.5) blast(sim, f, pr.x, pr.y, +(pr.r + 0.45).toFixed(2), Math.min(2.2, 0.7 + runSp * 0.09), "撞碎" + pr.zh);
              continue;
            }
            // ② 建筑类才是真的墙：够猛（6 级起、冲得起来）就撞塌过去，否则被挡住
            if ((f.prof.tier || 1) >= 6 && runSp > 5.5) {
              blast(sim, f, pr.x, pr.y, +(pr.r + 0.8).toFixed(2), 1.6, "撞塌" + pr.zh);
              continue;
            }
            // ── 被击飞砸在结构上要受伤（2026-09-25）──────────────────────────
            //   "打碎周围"的另一半：人砸在院墙/石塔上会疼。按撞击速度折算伤害（轻碰不疼，被击飞才重伤）。
            if (sim.t >= (f.slamT || -9)) {
              const hitSp = Math.hypot(f.vx, f.vy);
              if (hitSp > 4.5 && (f.state === "hitstun" || f.state === "stagger" || f.state === "move")) {
                const dmg2 = Math.min(48, (hitSp - 4.0) * 4.5 * (1 + (pr.building ? 0.5 : 0)));
                if (dmg2 > 1) {
                  f.slamT = sim.t + 0.6;                 // 冷却：一次撞击只结算一次（否则每帧都扣）
                  f.hp = Math.max(0, f.hp - dmg2);
                  f.stats.slams = (f.stats.slams || 0) + 1;
                  sim.events.push({ t: +sim.t.toFixed(3), type: "slam", who: f.id, prop: pr.id, propName: pr.zh,
                    x: +f.x.toFixed(3), y: +f.y.toFixed(3), z: +(f.z || 0).toFixed(3),
                    speed: +hitSp.toFixed(1), damage: +dmg2.toFixed(1), hp: +f.hp.toFixed(1), building: !!pr.building });
                  if (f.hp <= 0 && f.state !== "down") {
                    f.state = "down"; f.hitstun = 3; f.fallT = 0; f.post = "stand"; f.z = 0; f.vz = 0;
                    sim.events.push({ t: +sim.t.toFixed(3), type: "ko", who: f.id, by: null,
                      x: +f.x.toFixed(3), y: +f.y.toFixed(3), tech: "撞在" + pr.zh + "上", smash: true });
                  }
                }
              }
            }
            f.x += (px / pd) * (rr - pd); f.y += (py / pd) * (rr - pd);
            // 沿墙滑（2026-09-25）：只吃掉"撞进墙里"的那个速度分量，保留切向——
            //   原来是直接 *= 0.6 刹车，实测逃跑者会卡死在院墙上（追逐战逃跑帧 93 → 58）。
            const nx = px / pd, ny = py / pd;
            const vn = f.vx * nx + f.vy * ny;
            if (vn < 0) { f.vx -= vn * nx * 1.05; f.vy -= vn * ny * 1.05; }
            f.vx *= 0.94; f.vy *= 0.94;
            f.bumpT = 0.35;                                  // 记一下"刚撞上掩体"，下面做侧向绕行
          }
        }
        // ── 掩体绕行（2026-09-23 修）：追人时如果掩体挡在"我→对手"的连线上，直着冲会**贴着掩体磨** ——
        //   实测一场追逐战 A 被木箱卡住十几秒、整场只 10 次命中、30 秒打不完。
        //   做法：把掩体在连线上的侧向偏移（叉积）判断出该往哪边绕，给一个切向速度分量。
        if (f.z < 1.0 && (f.state === "move" || f.state === "idle") && sim.props.length) {
          const op2 = (f === sim.A ? sim.B : sim.A);
          const tx = op2.x - f.x, ty = op2.y - f.y, tl = Math.hypot(tx, ty) || 1;
          for (const pr of sim.props) {
            if (pr.broken || pr.r > 2.6) continue;                     // 只有山门/石塔这种超大结构不绕（本来就要撞过去）
            const dx = f.x - pr.x, dy = f.y - pr.y, rr = pr.r + CAP_R + 0.75;
            if (dx > rr || dx < -rr || dy > rr || dy < -rr) continue;   // 粗筛
            const d2 = dx * dx + dy * dy;
            if (d2 >= rr * rr || d2 < 1e-8) continue;
            const d = Math.sqrt(d2);
            const cross = (tx * dy - ty * dx) / tl;                   // >0：掩体在连线左侧
            const sgn = cross >= 0 ? -1 : 1;                          // 往另一侧绕
            const push = (rr + 0.75 - d) * 5.5;
            f.vx += (-ty / tl) * sgn * push * DT;
            f.vy += (tx / tl) * sgn * push * DT;
          }
        }
        // ── 卡住脱困（2026-09-25）────────────────────────────────────────────
        //   场景里可破坏物变多之后，出现过"两个人被两件建筑夹住、速度恒为 0、站到时间结束"
        //   （实测 aerial seed5103：30 秒只有 1 次命中）。兜底：意图是移动却动不了 → 0.6 秒后蹬地换向自救。
        if (f.state !== "down" && (f.intent && ["approach", "dash", "space", "flee", "flank"].indexOf(f.intent.kind) >= 0)) {
          if (Math.hypot(f.vx, f.vy) < 0.3) {
            f.stuckT = (f.stuckT || 0) + DT;
            if (f.stuckT > 0.6) {
              f.stuckT = 0;
              const a2 = f.rng() * Math.PI * 2;
              f.vx += Math.cos(a2) * 5.0; f.vy += Math.sin(a2) * 5.0;
              f.stats.unsticks = (f.stats.unsticks || 0) + 1;
              sim.events.push({ t: +sim.t.toFixed(3), type: "unstick", who: f.id,
                x: +f.x.toFixed(3), y: +f.y.toFixed(3), z: +(f.z || 0).toFixed(3),
                zh: "被结构件卡住，蹬地换向脱身" });
            }
          } else f.stuckT = 0;
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
        const k = (sim.ring.r * 0.88) / od;   // 回到台边偏内（不是台心）：一次掉台不该把刚才那串走位全作废
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
          f.hp = 0; f.state = "down"; f.fallT = 0; f.post = "stand"; f.hitstun = 3;
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
        const px = s.x, py = s.y;               // 上一步位置（扫掠命中用）
        const pz = s.z;
        s.x += s.vx * DT; s.y += s.vy * DT;
        const owner = s.owner === "A" ? A : B, def = s.owner === "A" ? B : A;
        // 垂直跟踪：朝对手胸口高度做有限修正（不是制导导弹，只是"别从脚底下穿过去"）
        // 只在"目标真的在高处"时才修高度（贴地战不该有制导感），而且每秒最多修 3.5 米：
        //   这样爬升快的飞行目标仍然可以躲开弹道（"法术不是必中"是设计底线）。
        if (def.z > 0.6 || Math.abs((def.z + 0.95) - s.z) > 1.0) {
          const wantZ = def.z + 0.95;
          const cap = (s.vCap == null ? 3.5 : s.vCap) * DT;
          const step = clamp((wantZ - s.z) * Math.min(1, 5 * DT), -cap, cap);
          s.z += step; s.vz = step / DT;
        }
        let end = null;
        for (const pr of sim.props) {                       // 掩体先挡（法术也穿不过石墙木箱）
          if (pr.broken) continue;
          // 高度不够就挡不住（法术飞得比它高）：空战与浮空法术不该被地上的酒坛截住
          if (Math.hypot(s.x - pr.x, s.y - pr.y) <= pr.r && s.z <= (pr.h || 1.2) + 0.5) {
            // 大威力法术（6 级起 / 气功半径 ≥0.9 米）：把掩体震碎，法术继续飞向目标
            const bigSpell = (owner.prof.tier || 1) >= 6 || ((s.eff && s.eff.radius) || 0) >= 0.9;
            if (bigSpell && pr.tough <= Math.max(2, Math.floor((owner.prof.tier || 1) * 0.7))) {
              blast(sim, owner, pr.x, pr.y, +(pr.r + 1.1).toFixed(2), Math.max(1.0, (s.dmg || 20) / 25), s.sp.zh);
              continue;
            }
            end = { kind: "cover", pr }; break;
          }
        }
        if (!end && def.state !== "down") {
          const dz = Math.abs(s.z - (def.z + 0.95));
          // 命中体积：横截面 + 招式半径；**垂直容差也随体量放大**（大法术是有厚度的气团，
          //   原来固定 1.15 米：飞在高处的对手一跳一沉就"擦着过去"，空战法术全是 spell_fade）
          const hitR = CAP_R + 0.30 + ((s.eff && s.eff.radius) || 0) * 0.35;
          const dzTol = Math.min(2.2, 1.15 + ((s.eff && s.eff.radius) || 0) * 0.35 + (def.z > 1 ? 0.25 : 0));
          // 扫掠命中：高速弹一帧能走 0.67 米（40 m/s），只测"当前点"会直接穿过人；
          //   这里测"上一帧位置→这一帧位置"这条线段离目标最近的距离。
          const _sx = s.x - def.x, _sy = s.y - def.y;
          const _vx = s.x - px, _vy = s.y - py;
          const _len2 = _vx * _vx + _vy * _vy;
          let _near = Math.hypot(_sx, _sy);
          if (_len2 > 1e-9) {
            const _t = Math.max(0, Math.min(1, -((px - def.x) * _vx + (py - def.y) * _vy) / _len2));
            _near = Math.hypot((px + _vx * _t) - def.x, (py + _vy * _t) - def.y);
          }
          if (_near <= hitR && dz <= dzTol) {
            const facing = def.state === "block" && angDiff(Math.atan2(s.y - def.y, s.x - def.x), def.face) < Math.PI * 0.45;
            // 大威力招式（气功半径 ≥1.2 米）震开格挡：只减伤不挡下；小招式（指法/剑气）仍可被兵器架住
            const through = facing && s.eff && (s.eff.radius || 0) >= 0.9;   // 中大型法术震开格挡（只减伤）
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
        // ── 法术打碎周围（2026-09-25）：落点（命中/被架住/被卸掉/落空砸地）都要有后果 ──────
        //   半径 = max(招式自身的爆炸半径, 按等级给的破坏半径)——高等级的法术落空砸在地上也要掀一片。
        //   低等级（1~2 级）只按招式半径算，不会"挥一挥拆掉一条街"。
        {
          const _tier = owner.prof.tier || 1;
          const _pw = Math.max(0.6, Math.min(2.6, (s.dmg || 20) / 25));
          const _own = (s.eff && s.eff.radius) || 0;
          const _R = Math.max(_own, _tier >= 3 ? blastRadius(_tier, _pw * 0.85) : _own);
          blast(sim, owner, s.x, s.y, +_R.toFixed(2), _pw, s.sp.zh);
        }
        const geo = { dist: Math.hypot(s.x - owner.x, s.y - owner.y), reach: s.sp.reach, ang: 0 };
        if (end.kind === "hit" || end.kind === "guard") {
          // ── 法术命中反馈（2026-09-25 用户：「法术击中之后的反馈也不行」）────────────
          //   硬直与击退按威力放大（威力 = 招式伤害 / 25，夹在 0.6~2.6），命中必出气劲（半径取招式半径），
          //   重招再补一条余波与地面留痕；被无敌帧闪过的记成 spell_dodged，不再冒充命中。
          const power = Math.max(0.6, Math.min(2.6, (s.dmg || 20) / 25));
          const radius = (s.eff && s.eff.radius) || 0;
          const heavy = radius >= 1.0 || power >= 1.6;
          const v = { zh: s.sp.zh, key: "spell", h: "mid", dmg: 1.0, kb: 1.35 * power, arc: 0, reach: 1, spell: true,
                      damage: s.dmg * owner.prof.dmg, spellHeavy: heavy,
                      stun: Math.min(0.60, 0.16 + 0.16 * power + (heavy ? 0.10 : 0)),
                      spellBurst: Math.max(0.6, radius * 1.15) };
          const ko = applyHit(sim, owner, end.def, v, end.kind === "guard", false, geo);
          const info = sim._last || {};
          const F = owner.fx || {};
          if (end.kind === "hit" && (info.mode === "hit" || info.mode === "wardbreak")) {
            owner.stats.spellHits++;
            sim.events.push({ t: +sim.t.toFixed(3), type: "spell_hit", who: end.def.id, by: owner.id, tech: s.sp.zh, shot: s.id,
                              x: +s.x.toFixed(3), y: +s.y.toFixed(3), z: +s.z.toFixed(3), range: +Math.hypot(s.x - owner.x, s.y - owner.y).toFixed(2),
                              hp: +end.def.hp.toFixed(1), power: +power.toFixed(2), heavy: heavy,
                              stun: +(info.stun || v.stun).toFixed(2), kb: +v.kb.toFixed(2),
                              damage: +(v.damage || 0).toFixed(1) });
            // 余波：法术命中之后"还在发生什么"（灼烧/结霜/麻痹/气劲倒灌/水花/碎石）
            const kinds = [
              { k: "burn", re: /火|炎|焰|焚|丹|雷|电|霹雳/, zh: "灼痕与余烬顺着衣料往上爬，皮肤上留一道焦痕" },
              { k: "freeze", re: /冰|霜|寒|冻|雪/, zh: "霜层从命中点往四肢蔓延，动作慢了半拍，落地碎了满地霜屑" },
              { k: "shock", re: /雷|电|霹雳|雷劫/, zh: "雷弧沿身体走了一遍，四肢短暂发麻不听使唤" },
              { k: "wet", re: /水|浪|潮|江|海/, zh: "水压砸在身上又炸开，衣袍贴身、脚下打滑" },
              { k: "stone", re: /岩|石|山|土|沙|尘/, zh: "碎石与沙尘糊在身上，抖落一地" },
              { k: "qi", re: /气|罡|掌|拳|指|剑|刀|枪|棍|棒/, zh: "气劲倒灌进架势里，双臂发麻、兵器差点脱手" }
            ];
            const hit = kinds.filter((x) => x.re.test(String(s.sp.zh) + String(s.sp.effect || "")))[0] || kinds[5];
            end.def.stats = end.def.stats || {};
            end.def.aftermath = { kind: hit.k, until: sim.t + (heavy ? 1.6 : 1.0) };
            sim.events.push({ t: +sim.t.toFixed(3), type: "spell_after", who: end.def.id, by: owner.id, tech: s.sp.zh,
                              kind: hit.k, zh: hit.zh, x: +s.x.toFixed(3), y: +s.y.toFixed(3), z: +s.z.toFixed(3),
                              radius: +Math.max(0.4, radius).toFixed(2), stun: +(info.stun || v.stun).toFixed(2),
                              kb: +v.kb.toFixed(2), heavy: heavy,
                              palette: F.palette || "", shape: F.shape || "", fxLevel: F.level || 1 });
            if (heavy) {
              sim.events.push({ t: +sim.t.toFixed(3), type: "ground_scar", who: end.def.id, by: owner.id, tech: s.sp.zh,
                                x: +s.x.toFixed(3), y: +s.y.toFixed(3), z: 0,
                                radius: +Math.max(1.0, radius * 1.6).toFixed(2), kind: hit.k,
                                zh: hit.zh, palette: F.palette || "", fxLevel: F.level || 1 });
            }
          } else if (end.kind === "hit" && info.mode === "iframes") {
            sim.events.push({ t: +sim.t.toFixed(3), type: "spell_dodged", who: end.def.id, by: owner.id, tech: s.sp.zh, shot: s.id,
                              x: +s.x.toFixed(3), y: +s.y.toFixed(3), z: +s.z.toFixed(3),
                              range: +Math.hypot(s.x - owner.x, s.y - owner.y).toFixed(2) });
          } else if (end.kind === "hit") {
            // 护体硬吃（施法护体）或其它没有落到"真命中"的情形：**也必须有一条事件**
            //   —— 曾经这里什么都没有，于是弹道"打上去却悄无声息地消失"（用户说的"法术击中反馈不行"）。
            const F3 = owner.fx || {};
            const gr2 = Math.max(0.5, radius * 0.85);
            owner.stats.qiBursts = (owner.stats.qiBursts || 0) + 1;
            sim.events.push({ t: +sim.t.toFixed(3), type: "qi_burst", who: owner.id, by: owner.id, tech: s.sp.zh,
              x: +s.x.toFixed(3), y: +s.y.toFixed(3), z: +s.z.toFixed(3), radius: +gr2.toFixed(2), kb: 0,
              spell: true, absorbed: true, from: s.sp.zh, fxLevel: F3.level || 1,
              palette: F3.palette || "", shape: F3.shape || "", light: F3.light || "", destruction: [] });
            sim.events.push({ t: +sim.t.toFixed(3), type: "spell_absorbed", who: end.def.id, by: owner.id, tech: s.sp.zh, shot: s.id,
              mode: info.mode || "none", x: +s.x.toFixed(3), y: +s.y.toFixed(3), z: +s.z.toFixed(3),
              castTech: (end.def.castSpell && end.def.castSpell.zh) || "",
              range: +Math.hypot(s.x - owner.x, s.y - owner.y).toFixed(2),
              palette: F3.palette || "", shape: F3.shape || "", fxLevel: F3.level || 1 });
          }
          if (end.kind === "guard") {
            // 法术被架住 / 被护体挡住也要有交代：格挡点爆开一圈气劲、防守方被推开、护体值下降
            const F2 = owner.fx || {};
            const gr = Math.max(0.5, radius * 0.9);
            owner.stats.qiBursts = (owner.stats.qiBursts || 0) + 1;
            sim.events.push({ t: +sim.t.toFixed(3), type: "qi_burst", who: owner.id, by: owner.id, tech: s.sp.zh,
              x: +s.x.toFixed(3), y: +s.y.toFixed(3), z: +s.z.toFixed(3), radius: +gr.toFixed(2), kb: +(v.kb * 0.4).toFixed(2),
              spell: true, guarded: true, from: s.sp.zh, fxLevel: F2.level || 1,
              palette: F2.palette || "", shape: F2.shape || "", light: F2.light || "", destruction: [] });
            sim.events.push({ t: +sim.t.toFixed(3), type: "spell_guard", who: end.def.id, by: owner.id, tech: s.sp.zh, shot: s.id,
              x: +s.x.toFixed(3), y: +s.y.toFixed(3), z: +s.z.toFixed(3), through: !!end.through,
              guard: +((end.def.guard || 0)).toFixed(1), push: +(v.kb * 0.4).toFixed(2),
              dist: +Math.hypot(s.x - owner.x, s.y - owner.y).toFixed(2),
              palette: F2.palette || "", shape: F2.shape || "", fxLevel: F2.level || 1 });
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
        if (f.state !== "attack" || f.phase !== "active") continue;
        if (f.hasHit && !(f.seqN > 1)) continue;                 // 普通招：整招只结一次
        const opp = f === A ? B : A;
        let v = f.tech, reach = f.reach * v.reach;
        //   套路招：把"现在打到第几个动作"算出来；同一个动作只结算一次；
        //   每一步用**它自己的**打击层/距离/伤害系数（日字冲拳三拳各自独立命中）。
        if (f.seqN > 1 && f.seq && f.seq.length) {
          const _D = f.dur, _prog = Math.max(0, Math.min(0.999, (f.techT - _D.w) / Math.max(1e-6, _D.a)));
          let _idx = Math.min(f.seq.length - 1, Math.floor(_prog * f.seq.length));
          // 对手已经被打飞/离地（或倒地）时，连招**不再续段**：只算第一式的接触。
          //   否则每一式都刷新滞空硬直，凌空受身永远不触发（实测 3 场 0 次受身、289 帧空中硬直）。
          if ((opp.z || 0) > 0.25 || opp.state === 'down' || opp.rising) _idx = 0;
          if (f.seqHit[_idx]) continue;                          // 这一式已经打过了
          f.seqIdx = _idx;
          const _st = f.seq[_idx];
          const _band = _st.target === 'leg' ? 'low' : (_st.target === 'high' || _st.target === 'mid' || _st.target === 'low' ? _st.target : v.h);
          const _sumDmg = f.seq.reduce((x, s) => x + (s.dmg == null ? 0.6 : s.dmg), 0) || 1;
          v = Object.assign({}, f.tech, {
            //   伤害按整招总量归一：一整套连招打满 ≈ 单招的 1.10 倍（不是 N 倍）——
            //   这样三连拳记三下看得见，但不会把对局平衡（KO 率/时长/空中占比）整体带偏。
            dmg: (f.tech.dmg || 1) * ((_st.dmg == null ? 0.6 : _st.dmg) / _sumDmg) * ROUTINE_TOTAL_DMG,
            //   击退也按段数摊薄：三段连招总击退 ≈ 单招的 0.75 倍（否则一个组合把人推出两三米，
            //   下一招又从够不到的距离起手 —— 实测判定帧够不到会从 12% 涨到 18%）。
            h: _band, kb: (f.tech.kb || 1) * 0.75 / Math.max(1, f.seqN),
            stepZh: _st.zh, stepNote: _st.note, stepAct: _st.act
          });
          if (_st.range) reach = f.reach * (Math.max(0.6, Math.min(1.8, _st.range / 1.5)));
        }
        // 掩体：兵器线路被石墙/木箱挡住 → 这一刀落在掩体上（够不到掩体就是砍空，
        // 但绝不会"穿过掩体"打到后面的人）——阵地战/追逐战的"借掩体"就是这么生效的
        if (sim.props.length) {
          const blk = sim.props.find(pr => !pr.broken && (pr.h || 1.2) + 0.6 > Math.min(f.z || 0, opp.z || 0)
            && G.ptSeg(pr.x, pr.y, f.x, f.y, opp.x, opp.y) <= pr.r);
          // 等级够高（5 级起）：挡住线路的东西**被打碎**，这一招照样递到对手身上（不再白白消耗一拍）
          if (blk && (f.prof.tier || 1) >= 4 && blk.tough <= Math.max(2, Math.floor((f.prof.tier || 1) * 0.7))) {
            blast(sim, f, blk.x, blk.y, +(blk.r + 0.9).toFixed(2), Math.max(1.0, (v.dmg || 1) / 1.1), v.zh);
            if (blk.broken) { /* 碎了：继续判定对人 */ } 
          } else if (blk) {
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
        // 七十二变之后的突袭：这一下**挡不住**（"变化破防"的内核落点）——
        //   对应提示词里"变得让人认不出来的那一下，对手来不及架"
        const transformBreak = !!(f.transformUntil && sim.t < f.transformUntil);
        const blocked = !transformBreak && opp.state === "block" && canBlock(f, opp) &&
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
        // 套路里的这一式真的递出去了 → 记一条 routine_step（素材照着写"第几式在干什么"）
        if (p.f.seqN > 1 && p.f.seqIdx >= 0 && p.f.routine && p.f.seq && p.f.seq[p.f.seqIdx]) {
          const _s = p.f.seq[p.f.seqIdx];
          p.f.seqHit[p.f.seqIdx] = true;
          sim.events.push({ t: +sim.t.toFixed(3), type: "routine_step", who: p.f.id,
            routine: p.f.routine.key, routineZh: p.f.routine.style ? (p.f.routine.style + '·' + p.f.routine.zh) : p.f.routine.zh,
            step: p.f.seqIdx + 1, steps: p.f.seqN, stepZh: _s.zh, actZh: _s.actZh, limb: _s.limb,
            target: _s.target, note: _s.note, to: p.opp.id });
        }
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
      // ── 接触看门狗（2026-09-29）────────────────────────────────────────────
      //   谁都不许靠走位或滞空拖时间。实测 aerial 场景 30 场里有 1 场双方全程互相绕圈、
      //   12 次出手 0 命中、伤害只有 19%（走得过去的场次）。规则：距上一次"交手或出手"
      //   超过 4 秒 → 两人同时上"必须接近并出手"的窗口（复用起跳后接文的 engageUntil），
      //   并给一次朝对手的推力，别让他们在场地两头对着飘。
      if (sim.t > 2) {
        // 只看**真实接触**（命中/被架住/对拼/闪开），不看"出过手"：实测有一场双方各出 12 次手、
        //   一次都没接触上（互相绕圈挥空），按"出手"计时永远不触发。
        const _lastTouch = Math.max(A.lastContactT || 0, B.lastContactT || 0);
        if (sim.t - _lastTouch > 5.0 && sim.t - (sim._closingT || -9) > 2.0) {
          sim._closingT = sim.t;
          for (const f of [A, B]) {
            const opp = f === A ? B : A;
            // ⚠ 只对**在地面上**绕圈的人生效：空战（7 级以上）本来就该有四成时间在天上，
//      把空中的人拽下来会把"浮空战斗"打没（实测 7 级空中占比 27% < 要求的 40%）。
            if (f.state === "down" || f.hitstun > 0 || opp.state === "down") continue;
            // ⚠ 飞行档（7 级以上）完全不看这道看门狗：他们本来就该在天上打，
//      把人拽下来会把"浮空战斗"打没（实测 7 级空中占比掉到 30% < 要求的 40%）。
            if ((f.z || 0) > 0.9 || (opp.z || 0) > 0.9) continue;
            if (f.mob.flight || opp.mob.flight) continue;
            f.engageUntil = Math.max(f.engageUntil || 0, sim.t + 1.2);
            const a2 = Math.atan2(opp.y - f.y, opp.x - f.x);
            f.vx += Math.cos(a2) * 3.4; f.vy += Math.sin(a2) * 3.4;
          }
        }
      }      // 动作时间账：每帧跟踪 A/B 的状态段
      trackSegment(sim, A); trackSegment(sim, B);
      // 收帧
      if (sim.frames) {
        sim.frames.push({
          t: fr(sim.t),
          A: snap(A), B: snap(B)
        });
      }
      // ⚠ 结束条件＝**被终结**（气血归零），不是"倒地"（2026-09-29 修）：
      //   加了"非致命击倒（knockdown）"之后，再用 state==="down" 当结束条件会让"被打倒一次"直接判负 ——
      //   实测 9 级打 4 级 2.0 秒就 round_over、连起飞都没来得及（浮空战斗整个消失）。
      //   倒地后能起身继续打，才是动作片的常态；真正结束只有 KO（hp≤0）与掉台判负（也会把 hp 打到 0）。
      const finished = (f) => f.state === "down" && f.hp <= 0;
      if (finished(A) || finished(B)) {
        if (!sim.over) {
          sim.over = finished(A) && finished(B) ? "draw" : finished(A) ? "B" : "A";
          sim.events.push({ t: +sim.t.toFixed(3), type: "round_over", winner: sim.over });
        }
        sim.overT += DT;                       // 倒地余波：让画面能看到"倒下"的过程与胜者收势
        if (sim.overT >= TAIL) break;
      }
    }
    // 收尾：还在飞的弹道补一条消散（否则证据里会出现"脱手了但没有结局"的法术——实测确实有 40% 这样丢的）
    if (sim.shots && sim.shots.length) {
      sim.shots.forEach((s2) => {
        sim.events.push({ t: +sim.t.toFixed(3), type: "spell_fade", who: s2.owner, tech: s2.sp.zh, shot: s2.id,
                          x: +s2.x.toFixed(3), y: +s2.y.toFixed(3), z: +s2.z.toFixed(3), unresolved: true });
      });
      sim.stats_endShots = sim.shots.length;
      sim.shots.length = 0;
    }
    function lockCheck(f) { return ACTIONS.locked(f) || f.state === "recover" && sim.t < (f.recoverUntil||0) || f.state === "attack" || f.state === "dodge" || f.state === "cast" || f.state === "hitstun" || f.state === "stagger" || f.state === "down" || f.state === "land"; }
    // 真实阶段进度 phaseP（0=起手开始，1=收招结束）：GPT 9.13 的 rig 用它驱动姿态插值 ——
    //   比按 tp 猜阶段边界准，起手末/判定末的姿态会正好落在阶段切换上。
    function phasePOf(f) { return (f.state === "attack" && f.dur)
      ? fr(Math.max(0, Math.min(1, f.phase === "windup" ? f.techT / f.dur.w
          : f.phase === "active" ? (f.techT - f.dur.w) / f.dur.a
          : (f.techT - f.dur.w - f.dur.a) / f.dur.r)))
      : null; }
    function snap(f) {
      return { x: fr(f.x), y: fr(f.y), z: fr(f.z), face: fr(f.face), st: f.state, ph: f.phase,
               phaseP: phasePOf(f), swingDir: f.swingDir || 1, chain: f.chainDepth || 0,
               post: f.z > 0.05 ? "air" : f.post, air: f.z > 0.05, vz: fr(f.vz),
               techKey:f.tech?f.tech.key:"", tp:f.tech&&f.dur?fr(Math.min(1,f.techT/(f.dur.w+f.dur.a+f.dur.r))):0,
               attackReach:f.tech?fr(f.reach*f.tech.reach):f.reach, arcFrom:fr(f.arcFrom),
               tech: f.tech ? f.tech.zh : "", hp: fr(f.hp), gd: fr(f.guard), sa: fr(f.sta),
               roll: +(f.roll || 0).toFixed(2), ...ACTIONS.snapshot(f,sim.t),
               ba: f.bladeAng == null ? null : fr(f.bladeAng),
               ft: f.state === "down" ? +Math.min(1, (f.fallT || 0) / (f.motion?.fall || 0.55)).toFixed(3) : 0,
               // 起身进度 rise（0→1，撑地爬起那 0.6 秒）：3D 姿态层用它把身体**连续**转回来。
               //   没有它的话，倒地那 0.6 秒一直保持"躺平"，状态一变 idle 就一帧弹起（实测单帧胸口 0.267 米）。
               rise: (f.state === "down" && f.rising) ? +Math.max(0, Math.min(1, 1 - (f.hitstun || 0) / (f.riseT || 0.6))).toFixed(3) : 0 };
    }
    // A recoverable knockdown is never a loss. KO uses the recorded outcome;
    // a timeout compares remaining HP, regardless of either fighter's pose.
    const winner = CONTRACT ? CONTRACT.winner(A, B, sim.over) :
      (sim.over || (A.hp/A.hpMax > B.hp/B.hpMax + 0.02 ? "A" : B.hp/B.hpMax > A.hp/A.hpMax + 0.02 ? "B" : "draw"));
    const eventCounts = CONTRACT ? CONTRACT.eventCounts(sim.events) : sim.events.reduce((m,e)=>(m[e.type]=(m[e.type]||0)+1,m),{});
    const counts = (t) => eventCounts[t] || 0;
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
      props: sim.props.map(pr => ({ id: pr.id, zh: pr.zh, x: pr.x, y: pr.y, r: pr.r, h: pr.h || 1.2, tough: pr.tough, broken: pr.broken,
        building: !!pr.building, mega: !!pr.mega, hits: +pr.hit.toFixed(2) })),
      chase: sim.chase ? { chaser: sim.chase.chaser, cornered: sim.chase.cornered } : null,
      A: publicFighter(A), B: publicFighter(B),
      // 特效规格（等级×风格档）：结果里也留一份，证据/白膜/体检都从这里取，避免调用方另传配置时掉档
      fx: o.fx || (A && A.fx) || null,
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
        auras: counts("aura"), afterimages: counts("afterimage"), phenomena: counts("phenomenon"),
        traits: counts("trait"), clones: counts("clone_hit"), traitEnds: counts("trait_end"),
        spellAfter: counts("spell_after"), spellDodged: counts("spell_dodged"), groundScars: counts("ground_scar"),
        spellGuards: counts("spell_guard"), spellAbsorbed: counts("spell_absorbed"), wardBroken: counts("ward_broken"),
        airRecovers: counts("air_recover"), intercepts: counts("intercept"),
        spellCasts: A.stats.spellCasts + B.stats.spellCasts, spellHits: A.stats.spellHits + B.stats.spellHits,
        spellFades: counts("spell_fade"), linkCasts: A.stats.linkCasts + B.stats.linkCasts,
        castsStarted: (A.stats.castsStarted || 0) + (B.stats.castsStarted || 0),
        castsDone: (A.stats.castsDone || 0) + (B.stats.castsDone || 0),
        chargeSeconds: +((A.stats.chargeT || 0) + (B.stats.chargeT || 0)).toFixed(1),
        wardHolds: (A.stats.wardHolds || 0) + (B.stats.wardHolds || 0),
        obstacleHits: counts("obstacle_hit"), obstaclesBroken: sim.props.filter(pr => pr.broken).length,
      propsTotal: sim.props.length, buildings: sim.props.filter(pr => pr.building).length,
      buildingsBroken: sim.props.filter(pr => pr.building && pr.broken).length,
      propBrokenEvents: counts("prop_broken"), debris: counts("debris"), quakes: counts("quake"),
      debrisPieces: sim.events.filter(e => e.type === "debris").reduce((x, e) => x + (e.pieces || 0), 0),
        ringOuts: A.stats.ringOuts + B.stats.ringOuts, slips: A.stats.slips + B.stats.slips, splashes: A.stats.splashes + B.stats.splashes,
        // "终结"＝真的分出胜负（KO／掉台打空血量，即 round_over 事件），**不是**"有人躺在地上"
        //   ——2026-09-30 修：加了非致命击倒（knockdown）之后，state==="down" 也会在打满时限那一帧出现，
        //   于是"时间到判定"的场次会被写成 finish=true（界面显示成 KO/终结、素材也会照着收势）。
        finish: !!sim.over,
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
