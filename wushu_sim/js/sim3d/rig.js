/* ============================================================================
 * sim3d/rig.js — 程序化人形骨架（纯函数，不依赖 Three.js，Node 可测）
 * ----------------------------------------------------------------------------
 * 输入：实时内核的逐帧数据（位置/朝向/状态/招式/刀锋角 ba）
 * 输出：一副可渲染的骨架（关节点世界坐标 + 兵器线段 + 姿态参数）
 *
 * 三条设计原则（也是测试在守的东西）：
 *   ① 攻击时兵器方向**完全等于判定用的刀锋角** —— 画面上刀走的线，就是判定扫过的那条弧。
 *   ② 姿态用**参数插值**而不是状态硬切：起手→判定→收招之间连续过渡，
 *      144Hz 渲染也不会在相位切换那一帧抖一下。
 *   ③ 脚踩地、髋在脚上方、步态由"累计行进距离"驱动：不滑步、不飘。
 *
 * 坐标系（与内核一致）：x,y = 地面平面（米）；z = 高度（米，向上）；
 * face / ba 是地面平面内的弧度。view3d.js 负责映射到 Three.js 的 Y-up：(x, z, y)。
 * ========================================================================== */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.SIM3D_RIG = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const VERSION = "rig-0.8.0";

  // 人体尺寸（米）
  const D = {
    hipZ: 0.94, crouchHipZ: 0.70, deepHipZ: 0.54, downHipZ: 0.24,
    chest: 0.44, neck: 0.28, head: 0.15,     // 髋→胸、胸→颈、颈→头顶
    shoulderW: 0.42, hipW: 0.26,
    armReach: 0.34,                          // 双手离身体中心的基础距离
    stride: 0.62, stanceW: 0.30,
    kneeMin: 0.24,
    tuckFoot: 0.42,                          // 腾空收腿时脚能抬起的最大高度
    airRef: 1.6                              // 离地多高算"完全腾空姿势"
  };

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  function norm(a) { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; }
  function lerpAngle(a, b, t) { return a + norm(b - a) * t; }

  // ── 帧插值（渲染帧率 ≠ 60Hz，必须插值）──────────────────────────────
  function interp(f0, f1, t) {
    if (!f0) return f1;
    if (!f1) return f0;
    const n = (k) => lerp(f0[k] || 0, f1[k] || 0, t);
    const ba0 = f0.ba == null ? f0.face : f0.ba, ba1 = f1.ba == null ? f1.face : f1.ba;
    const chosen=t<0.5?f0:f1;
    const foot=(key)=> f0[key]&&f1[key] ? {x:lerp(f0[key].x,f1[key].x,t),y:lerp(f0[key].y,f1[key].y,t),z:lerp(f0[key].z,f1[key].z,t)} : chosen[key];
    return {
      phaseP: f0.ph===f1.ph ? n("phaseP") : chosen.phaseP, swingDir:chosen.swingDir, techKey:chosen.techKey,
      plantedL:foot("plantedL"),plantedR:foot("plantedR"),
      x: n("x"), y: n("y"), z: n("z"), face: lerpAngle(f0.face, f1.face, t),
      ba: lerpAngle(ba0, ba1, t),
      rise:n("rise"), roll:n("roll"), rollP:f0.action===f1.action ? n("rollP") : chosen.rollP||0, rollDir:chosen.rollDir||0, action:chosen.action, actionPhase:chosen.actionPhase,
      ft:n("ft"), hp: n("hp"), gd: n("gd"), sa: n("sa"), t: n("t"), tp: n("tp"), gait: lerpAngle(f0.gait || 0, f1.gait || 0, t),
      st: (t < 0.5 ? f0.st : f1.st), ph: (t < 0.5 ? f0.ph : f1.ph),
      tech: (t < 0.5 ? f0.tech : f1.tech) || f0.tech || "", post: (t < 0.5 ? f0.post : f1.post)
    };
  }

  // ── 预标注：步态相位 + 招式进度 ──────────────────────────────────────
  function annotate(result) {
    const frames = result.frames || [];
    for (const side of ["A", "B"]) {
      let travel = 0, px = null, py = null, body=null, feet=null, swing=null, nextFoot="L";
      for (const fr of frames) {
        const f = fr[side];
        if (px != null) travel += Math.hypot(f.x - px, f.y - py);
        px = f.x; py = f.y;
        f.travel = travel;
        f.gait = (travel / D.stride) * Math.PI;   // 每走一个步幅 = 半个步态周期
        if(f.tp==null) f.tp = 0;
        const target=poseParams({...f,visualBody:null},{});
        if(!body) body={crouch:target.crouch,lean:target.lean};
        else for(const k of ['crouch','lean']) body[k]+=(target[k]-body[k])*0.25;
        f.visualBody={...body};
        const ground=(f.z||0)<0.025 && f.st!=="down";
        if(!ground){feet=null;swing=null;continue;}
        const targetFoot=(side)=>({x:f.x+Math.cos(f.face)*0.06-Math.sin(f.face)*side*0.20,y:f.y+Math.sin(f.face)*0.06+Math.cos(f.face)*side*0.20,z:0});
        if(!feet) feet={L:targetFoot(1),R:targetFoot(-1)};
        if(swing){
          const k=clamp((fr.t-swing.t)/0.20,0,1), e=k*k*(3-2*k);
          feet[swing.side]={x:lerp(swing.from.x,swing.to.x,e),y:lerp(swing.from.y,swing.to.y,e),z:Math.sin(k*Math.PI)*0.09};
          if(k>=1) swing=null;
        }
        if(!swing){
          const dl=Math.hypot(feet.L.x-f.x,feet.L.y-f.y),dr=Math.hypot(feet.R.x-f.x,feet.R.y-f.y);
          if(Math.max(dl,dr)>0.42){
            const side=Math.abs(dl-dr)>0.12?(dl>dr?"L":"R"):nextFoot;
            swing={side,t:fr.t,from:{...feet[side]},to:targetFoot(side==="L"?1:-1)};nextFoot=side==="L"?"R":"L";
          }
        }
        // A knockback must not stretch a planted leg indefinitely.
        for(const k of ["L","R"]){const d=Math.hypot(feet[k].x-f.x,feet[k].y-f.y);if(d>0.85){feet[k]=targetFoot(k==="L"?1:-1);swing=null;}}
        f.plantedL={...feet.L};f.plantedR={...feet.R};
      }
    }
    // 招式进度：从 attack 事件起算，起手 0~0.45 / 判定 0.45~0.62 / 收招 0.62~1
    for (const e of (result.events || [])) {
      if (e.type !== "attack") continue;
      if(e.dur) continue; // New engine records true normalized move time per frame.
      const who = e.who, TOTAL = 0.62;
      for (const fr of frames) {
        const dt = fr.t - e.t;
        if (dt < -0.02 || dt > TOTAL) continue;
        const p = clamp(dt / TOTAL, 0, 1);
        if (p > (fr[who].tp || 0)) fr[who].tp = +p.toFixed(4);
      }
    }
    return result;
  }

  // ── 状态 → 姿态参数（全部是连续量，可以插值）────────────────────────
  // ── 招式姿态档案（v0.8）──────────────────────────────────────────────
  //   同样一个"攻击"状态，不同招式必须有明显不同的身体语言：
  //   突刺=直臂前探低身、扫堂=极低蹲+横扫、重击=大绕身深收招、撩挑=由下向上、
  //   斜劈=高位下压、跃斩=空中收腿劈下、俯冲=头下脚上、施法=双手前送蓄气。
  const TECH_POSE = {
    slash:      { w: { twist: -0.78, lean: -0.12, crouch: 0.24, weight: -0.24, bladePitch: 0.12, armExtend: 0.26, stepW: 0.10 },
                  a: { twist:  0.86, lean:  0.20, crouch: 0.30, weight:  0.26, bladePitch: 0.00, armExtend: 0.68, stepW: 0.22 },
                  r: { twist:  0.34, lean:  0.08, crouch: 0.26, weight:  0.08, bladePitch: -0.18, armExtend: 0.44, stepW: 0.20 } },
    diag:       { w: { twist: -0.62, lean: -0.18, crouch: 0.20, weight: -0.26, bladePitch: 0.74, armExtend: 0.24, stepW: 0.12 },
                  a: { twist:  0.70, lean:  0.34, crouch: 0.40, weight:  0.34, bladePitch: -0.52, armExtend: 0.66, stepW: 0.26 },
                  r: { twist:  0.28, lean:  0.14, crouch: 0.32, weight:  0.10, bladePitch: -0.34, armExtend: 0.40, stepW: 0.22 } },
    thrust:     { w: { twist: -0.28, lean:  0.16, crouch: 0.26, weight: -0.10, bladePitch: -0.06, armExtend: 0.22, stepW: 0.06 },
                  a: { twist:  0.12, lean:  0.42, crouch: 0.36, weight:  0.46, bladePitch: -0.04, armExtend: 0.92, stepW: 0.62 },
                  r: { twist:  0.06, lean:  0.20, crouch: 0.30, weight:  0.18, bladePitch: -0.12, armExtend: 0.52, stepW: 0.40 } },
    rise:       { w: { twist: -0.40, lean:  0.26, crouch: 0.62, weight: -0.10, bladePitch: -0.66, armExtend: 0.24, stepW: 0.18 },
                  a: { twist:  0.34, lean: -0.22, crouch: 0.18, weight:  0.18, bladePitch:  0.56, armExtend: 0.72, stepW: 0.34 },
                  r: { twist:  0.18, lean: -0.06, crouch: 0.26, weight:  0.06, bladePitch:  0.28, armExtend: 0.46, stepW: 0.24 } },
    sweep:      { w: { twist: -0.52, lean:  0.34, crouch: 0.86, weight: -0.14, bladePitch: -0.30, armExtend: 0.30, stepW: 0.30 },
                  a: { twist:  0.92, lean:  0.18, crouch: 0.92, weight:  0.20, bladePitch: -0.42, armExtend: 0.74, stepW: 0.76 },
                  r: { twist:  0.40, lean:  0.10, crouch: 0.62, weight:  0.06, bladePitch: -0.44, armExtend: 0.42, stepW: 0.44 } },
    heavy:      { w: { twist: -0.96, lean: -0.26, crouch: 0.30, weight: -0.36, bladePitch: 0.86, armExtend: 0.20, stepW: 0.16 },
                  a: { twist:  0.94, lean:  0.40, crouch: 0.44, weight:  0.48, bladePitch: -0.10, armExtend: 0.80, stepW: 0.34 },
                  r: { twist:  0.44, lean:  0.22, crouch: 0.40, weight:  0.16, bladePitch: -0.36, armExtend: 0.50, stepW: 0.30 } },
    finish:     { w: { twist: -1.05, lean: -0.34, crouch: 0.34, weight: -0.42, bladePitch: 1.00, armExtend: 0.18, stepW: 0.18 },
                  a: { twist:  1.05, lean:  0.50, crouch: 0.50, weight:  0.56, bladePitch: -0.14, armExtend: 0.88, stepW: 0.40 },
                  r: { twist:  0.52, lean:  0.30, crouch: 0.46, weight:  0.24, bladePitch: -0.40, armExtend: 0.56, stepW: 0.34 } },
    leap_slash: { w: { twist: -0.70, lean: -0.20, crouch: 0.30, weight: -0.20, bladePitch: 0.66, armExtend: 0.22, stepW: 0.08, tuck: 0.55 },
                  a: { twist:  0.82, lean:  0.30, crouch: 0.36, weight:  0.30, bladePitch: -0.44, armExtend: 0.78, stepW: 0.20, tuck: 0.30 },
                  r: { twist:  0.36, lean:  0.16, crouch: 0.40, weight:  0.10, bladePitch: -0.24, armExtend: 0.50, stepW: 0.26, tuck: 0.55 } },
    dive:       { w: { twist: -0.30, lean:  0.66, crouch: 0.44, weight:  0.20, bladePitch: -0.90, armExtend: 0.30, stepW: 0.10, tuck: 0.30 },
                  a: { twist:  0.24, lean:  0.86, crouch: 0.52, weight:  0.52, bladePitch: -1.10, armExtend: 0.86, stepW: 0.16, tuck: 0.10 },
                  r: { twist:  0.12, lean:  0.50, crouch: 0.62, weight:  0.20, bladePitch: -0.70, armExtend: 0.48, stepW: 0.30, tuck: 0.40 } },
    wall_flip:  { w: { twist: -0.66, lean: -0.24, crouch: 0.30, weight: -0.24, bladePitch: 0.50, armExtend: 0.26, stepW: 0.12, tuck: 0.50 },
                  a: { twist:  1.10, lean:  0.16, crouch: 0.34, weight:  0.24, bladePitch: -0.30, armExtend: 0.70, stepW: 0.28, tuck: 0.60 },
                  r: { twist:  0.48, lean:  0.08, crouch: 0.34, weight:  0.08, bladePitch: -0.18, armExtend: 0.44, stepW: 0.30, tuck: 0.42 } },
    air_combo:  { w: { twist: -0.44, lean: -0.10, crouch: 0.34, weight: -0.16, bladePitch: 0.34, armExtend: 0.30, stepW: 0.14, tuck: 0.60 },
                  a: { twist:  0.62, lean:  0.22, crouch: 0.38, weight:  0.28, bladePitch: -0.16, armExtend: 0.74, stepW: 0.24, tuck: 0.45 },
                  r: { twist:  0.30, lean:  0.10, crouch: 0.40, weight:  0.08, bladePitch: -0.22, armExtend: 0.46, stepW: 0.28, tuck: 0.55 } },
    basic:      { w: { twist: -0.48, lean: -0.08, crouch: 0.22, weight: -0.16, bladePitch: 0.38, armExtend: 0.28, stepW: 0.10 },
                  a: { twist:  0.50, lean:  0.16, crouch: 0.32, weight:  0.20, bladePitch: 0.00, armExtend: 0.60, stepW: 0.20 },
                  r: { twist:  0.20, lean:  0.04, crouch: 0.26, weight:  0.06, bladePitch: -0.20, armExtend: 0.40, stepW: 0.18 } }
  };
  const poseFor = (key) => TECH_POSE[key] || TECH_POSE.basic;

  function poseParams(f, cfg) {
    cfg = cfg || {};
    const st = f.st || "idle", ph = f.ph || "";
    const two = !!cfg.twoHand;
    const P = {
      crouch: 0, lean: 0, twist: 0, weight: 0, guard: 0, recoil: 0, down: 0, headTilt: 0,
      bladePitch: -0.18, armExtend: D.armReach, stepW: D.stanceW, gaitAmp: 0, twoHand: two ? 1 : 0,
      bladeAngOff: 0.35, air: clamp((f.z || 0) / D.airRef, 0, 1), tuck: 0
    };
    // 兵器朝向偏移（相对朝向 face）；判定帧由 ba 决定 → 与判定完全一致
    // 起手/收招要"摆到位/收回来"：直接切到 ba 会让相邻帧差出 1 弧度以上，插值后就是手抖/瞬移
    const baOK = (f.ba != null);
    const restAng = (st === "block" ? 0.55 : (st === "dodge" ? 0.50 : 0.35));
    if (st === "attack" && baOK) {
      const target = norm(f.ba - (f.face || 0));
      if (ph === "active") P.bladeAngOff = target;                       // 判定帧：看到的就是算到的
      else if (ph === "recovery") {                                     // 收招：从落点带回常态架势
        const k = f.phaseP == null ? clamp(((f.tp || 0) - 0.5) / 0.5, 0, 1) : f.phaseP;
        P.bladeAngOff = lerpAngle(target, restAng, k);
      } else {                                                          // 起手：从架势摆到起始角
        const k = f.phaseP == null ? clamp((f.tp || 0) / 0.33, 0, 1) : f.phaseP;
        P.bladeAngOff = lerpAngle(restAng, target, k);
      }
    } else {
      P.bladeAngOff = restAng;
    }
    switch (st) {
      case "attack": {
        const active = ph === "active";
        const rec = ph === "recovery";
        // 招式档案：不同招式给出完全不同的身体语言（这是"看得出在出什么招"的关键）
        // ── 连续插值链：常态 → 起手 → 有效 → 收招 → 常态 ─────────────────
        const key = f.techKey || cfg.techKey || "";
        const W = poseFor(key).w, AC = poseFor(key).a, RC = poseFor(key).r;
        const baseP = { crouch: 0.10, lean: 0.02, twist: 0, weight: 0, bladePitch: -0.18, armExtend: D.armReach, stepW: 0, tuck: 0 };
        const mix = (x, y, t) => { const o = {}; Object.keys(baseP).forEach(kk => { const a1 = (x[kk] == null ? baseP[kk] : x[kk]), b1 = (y[kk] == null ? baseP[kk] : y[kk]); o[kk] = a1 + (b1 - a1) * t; }); return o; };
        const tp = f.tp || 0;
        const pp = clamp(f.phaseP == null ? (ph==="windup"?tp/0.36:ph==="active"?(tp-0.36)/0.18:(tp-0.54)/0.46) : f.phaseP,0,1);
        const ease=x=>x*x*(3-2*x);
        const prof = ph === "windup" ? mix(baseP,W,ease(pp))
                   : ph === "active" ? mix(W,AC,ease(pp))
                   : pp<0.45 ? mix(AC,RC,ease(pp/0.45)) : mix(RC,baseP,ease((pp-0.45)/0.55));
        // 写回姿态（招式档案 → 身体语言；不同招式在这里分道扬镳）
        P.crouch = prof.crouch; P.lean = prof.lean;
        P.twist = prof.twist * ((f.swingDir || cfg.swingDir) === -1 ? -1 : 1);
        P.weight = prof.weight; P.bladePitch = prof.bladePitch; P.armExtend = prof.armExtend;
        P.stepW = D.stanceW + prof.stepW + 0.16 * clamp(tp / 0.62, 0, 1) * (active ? 1 : 0.4);
        P.tuck = prof.tuck || 0; P.gaitAmp = 0.35;
        // 出招时另一只手要保持架式（不许缩回胸口）：架式强度按"站立"档给
        P.guard = 0.5;
        // 连招衔接：上一招的收招惯性带进来（不回中立），看得出是连着打而不是一招一顿
        if (!active && rec && f.comboT != null && f.comboN > 1) {
          const ch = clamp(1 - (f.comboT + 0.35) / 0.35, 0, 1) * 0.45;
          P.twist += (f.lastTwist || 0) * ch;
          P.weight += (f.lastWeight || 0) * ch * 0.8;
        }
        break;
      }
      case "block":
        // 格挡（2026-10-01 用户：「防御动作就是双拳抱着脸硬扛，要改成会用手去格挡」）：
        //   器械＝**横架**（兵器几乎水平地把它架住，不是竖着挡在脸前）；徒手＝前臂立起、肘尖下垂去格挡。
        //   两者都保留"重心下沉吃劲、受击回弹"的读数，看得出是"顶住了"而不是抱头挨打。
        P.crouch = 0.34; P.lean = -0.10 + (f.recoil || 0) * 0.25; P.guard = 1;
        P.bladePitch = (cfg && cfg.bare) ? 0.58 : 0.16;
        P.armExtend = (cfg && cfg.bare) ? 0.30 : 0.38;
        P.stepW = D.stanceW + 0.14; P.weight = -0.22 - (f.recoil || 0) * 0.2;
        P.twist = -0.18; P.recoil = f.recoil || 0; break;
      case "dodge":
        // 闪避：明显侧倾压低、一步跨开、兵器护在外侧（一眼能看出"让开了"）
        P.crouch = (f.post === "crouch") ? 0.95 : 0.58;
        P.lean = (f.post === "crouch") ? 0.42 : 0.26;
        P.twist = 0.46; P.stepW = D.stanceW + 0.46; P.bladePitch = -0.36; P.gaitAmp = 0.75;
        P.weight = 0.20; P.guard = 0.6; break;
      case "hitstun":
        P.crouch = 0.24; P.lean = -0.26; P.twist = -0.35; P.recoil = 1;
        P.headTilt = -0.22; P.bladePitch = -0.34; P.armExtend = 0.24; break;
      case "stagger":
        P.crouch = 0.42; P.lean = 0.34; P.twist = 0.20; P.recoil = 0.6;
        P.headTilt = 0.28; P.bladePitch = -0.45; P.armExtend = 0.20; P.stepW = D.stanceW + 0.22; break;
      case "land":
        // 落地屈膝缓冲（从高处砸下来的那一两帧）
        P.crouch = 0.72; P.lean = 0.18; P.weight = 0.22; P.guard = 0.4;
        P.bladePitch = -0.08; P.armExtend = 0.30; P.stepW = D.stanceW + 0.26; break;
      case "down": {
        const k = clamp(f.ft == null ? 1 : f.ft, 0, 1);   // 倒下过程 0→1（引擎给 ft），不是一帧躺平
        // 起身（rig-0.8）：引擎在躺满硬直前 0.6 秒先置 rising 并给 rise（0→1），
        //   这段必须把身体**连续**转回来、手臂一边撑地一边收回架式 ——
        //   旧写法这段一直保持"躺平"，状态一变 idle 就一帧站起（实测单帧胸口 0.267 米，test-rig 一直红）。
        const rs = clamp(f.rise || 0, 0, 1);
        P.down = k * (1 - rs);
        P.crouch = lerp(lerp(0.30, 1, k), 0.16, rs);
        P.lean = lerp(lerp(-0.10, 0.10, k), 0.02, rs);
        P.bladePitch = lerp(lerp(-0.30, -0.95, k), -0.22, rs);
        P.armExtend = lerp(lerp(0.28, 0.16, k), D.armReach, rs);
        P.headTilt = lerp(lerp(-0.10, 0.25, k), 0.0, rs);
        P.guard = 0.45 * rs;                              // 撑地起身时手一边收回来护住自己
        P.stepW = lerp(D.stanceW * 0.7, D.stanceW, rs);
        P.gaitAmp = 0;
        break;
      }
      default: // idle / move
        P.crouch = st === "move" ? 0.18 : 0.10;
        P.lean = st === "move" ? 0.12 : 0.02;
        P.guard = 0.5; P.bladePitch = -0.22; P.armExtend = D.armReach;
        P.stepW = D.stanceW + (st === "move" ? 0.08 : 0);
        P.gaitAmp = st === "move" ? 1 : 0;
        // 侧身站架（2026-09-30 用户：「一点都打斗不自然」）：站立/走位时躯干侧转、前肩朝对手，
        //   不再是两个人正面面对面的"木头人"。方向与提示词里的「A 正架（左脚在前）／
        //   B 反架（右脚在前）」同一口径，由 cfg.leadSide 传进来。
        P.twist = -0.20 * ((cfg && cfg.leadSide === -1) ? -1 : 1);
        break;
    }
    if(f.visualBody) {P.crouch=f.visualBody.crouch;P.lean=f.visualBody.lean;}
    // 腾空姿态：收腿、张臂、衣摆展开；俯冲时改为前倾（必须在 visualBody 之后，空中姿势优先）
    const air = P.air;
    if (air > 0.05) {
      // 俯冲权重必须是连续量：用布尔量会让相邻帧的参数突跳，插值时表现为"手抖一下"
      const diveK = clamp((-((f.vz) || 0) - 0.8) / 2.4, 0, 1);
      P.tuck = clamp(0.22 + air * 0.58 + diveK * 0.32, 0, 1);
      P.crouch = Math.max(P.crouch, 0.28 + air * 0.26);
      P.lean = P.lean * (1 - air) + (-0.12 + diveK * 0.56) * air;
      P.stepW += air * 0.22;
      P.armExtend = Math.max(P.armExtend, D.armReach * (0.90 + air * 0.18));
      P.gaitAmp = P.gaitAmp * (1 - air);       // 空中不再迈步
      P.bladePitch = P.bladePitch * (1 - air * 0.5) + (0.10 - diveK * 0.65) * air * 0.5;
    }
    return P;
  }

  const ANGLE_KEYS = { bladeAngOff: 1, twist: 1, lean: 1, bladePitch: 1, headTilt: 1, weight: 1 };
  function lerpParams(a, b, t) {
    const o = {};
    for (const k in a) {
      if (typeof a[k] !== "number") { o[k] = a[k]; continue; }
      const bv = (b[k] == null ? a[k] : b[k]);
      o[k] = ANGLE_KEYS[k] ? lerpAngle(a[k], bv, t) : lerp(a[k], bv, t);  // 角度走最短路径，避免收招回架势时甩一大圈
    }
    return o;
  }

  // ── 参数 → 骨架（世界坐标，z 向上）──────────────────────────────────
  function poseFromParams(f, P, cfg) {
    cfg = cfg || {};
    const face = f.face || 0;
    const crouch = clamp(P.crouch, 0, 1);
    // 髋高：站立 0.94 → 屈膝 → 深蹲；倒地时贴地
    let hipZ = lerp(D.hipZ, D.crouchHipZ, crouch);
    hipZ = lerp(hipZ, D.deepHipZ, Math.max(0, crouch - 0.6) / 0.4 * 0.55);
    if (P.down > 0) hipZ = lerp(hipZ, D.downHipZ, P.down);   // 倒地过程连续下降
    const baseZ = f.z || 0;                                  // 内核给的高度（0=站在地面）
    const root = { x: f.x, y: f.y, z: baseZ + hipZ };
    const cos = Math.cos(face), sin = Math.sin(face);
    // local(+x 前, +y 左, +z 上相对髋) → 世界
    const world = (lx, ly, lz) => ({ x: root.x + lx * cos - ly * sin, y: root.y + lx * sin + ly * cos, z: root.z + lz });
    const worldAbs = (lx, ly, wz) => ({ x: root.x + lx * cos - ly * sin, y: root.y + lx * sin + ly * cos, z: wz });

    const chest = world(P.lean * 0.30, 0, D.chest);
    const tw = P.twist, ct = Math.cos(tw), stw = Math.sin(tw);
    const shoulder = (side) => world(P.lean * 0.34 - stw * side * D.shoulderW / 2 * 0.5, ct * side * D.shoulderW / 2, D.chest + 0.10);
    const hipJ = (side) => world(0, side * D.hipW / 2, 0);
    const neck = world(P.lean * 0.42, 0, D.chest + D.neck);
    const head = world(P.lean * 0.50 + P.headTilt * 0.35, 0, D.chest + D.neck + D.head);

    // 兵器方向：朝向 + 偏移（攻击时偏移 = ba - face，于是方向恰好等于 ba）
    const bladeAng = face + P.bladeAngOff;
    const rel = P.bladeAngOff;
    // ── 架式（v0.8）：前手伸出护中线、后手抬到下颌 —— 两手不再叠在胸口 ──────────
    //   用户（2026-09-30）：「角色老是双手放在胸口这个动作非常难看，一点都打斗不自然。」
    //   旧版把两只手都放在**同一条射线**上（内核刀锋角方向）、只差 0.08 米、同一个高度 →
    //   徒手与单兵器角色看上去就是"双手抱在胸前"。现在按散打/武术架式分前后手：
    //     · 前手：向前伸出 0.30~0.40 米、高度在胸与下颌之间、贴住中线；
    //     · 后手：收回 0.10~0.14 米、抬到下颌／腮侧，肘尖下垂。
    //   与提示词同一口径：A 正架（左手在前）／B 反架（右手在前），由 cfg.leadSide 传进来。
    //   ⚠ 兵器手仍然从"内核刀锋角"那条射线出发（tip = 手 + 方向×长度），所以
    //     「判定帧方向 = 内核 ba」这条不变量不变（sim3d/test-rig.js 在守）。
    const leadSide = (cfg && cfg.leadSide === -1) ? -1 : 1;     // +1＝正架（左手在前）
    const g = clamp(P.guard == null ? 0.5 : P.guard, 0, 1);     // 架式强度：站立/格挡高，受击/倒地低
    const rLead = (leadSide === -1);                            // 右手是不是前手（反架）
    const bare = !!(cfg && cfg.bare);                           // 徒手：两只手都按架式摆
    // 2026-10-01：散打/拳击抱架（后手护颌）**只在擂台徒手**出现；其余场次用武术架/持械架。
    const boxing = !!(cfg && cfg.boxing);
    const striking = (f.st === "attack" || f.st === "cast" || f.st === "block");
    // 侧转后的横向偏移要跟着肩线走（否则手会与肩膀脱开）
    const ct2 = Math.cos(P.twist), st2 = Math.sin(P.twist);
    const atBody = (lx, ly, lz) => world(lx - st2 * ly * 0.5, ct2 * ly, lz);
    const dLead = 0.30 + 0.10 * g, dRear = 0.08 + 0.06 * g;                          // 前手前伸／后手收回
    const hzLead = D.chest + 0.04 + 0.06 * g, hzRear = D.chest + 0.16 + 0.08 * g;    // 前手在胸-颌之间／后手在颌侧
    const hzRib = D.chest - 0.10 + 0.05 * g;                                          // 护肋手：收在肋前（武术架／持械的副手）
    const hzW = D.chest - 0.06 + P.bladePitch * 0.16;                                // 兵器手高度（跟刀锋俯仰）
    const hzGrip = D.chest - 0.02 + P.bladePitch * 0.10;
    let handR, handL, tuckL = false, tuckR = false;
    if (P.twoHand > 0.5) {
      // 双手长兵：两手握在同一根兵器轴上（前手在前、后手在后 0.17 米）—— 这才是"握着枪棒"
      handR = atBody(Math.cos(rel) * P.armExtend, Math.sin(rel) * P.armExtend - 0.04, hzW);
      handL = atBody(Math.cos(rel) * (P.armExtend - 0.17), Math.sin(rel) * (P.armExtend - 0.17) + 0.05, hzGrip);
    } else if (bare && !striking) {
      // 徒手站立/走位：前手伸出护中线，另一只手按场次摆——
      //   擂台（boxing）＝散打/拳击架：后手护到下颌腮侧；其余（武术场）＝武术起手架：后手虚握收在肋前。
      const hzBack = boxing ? hzRear : hzRib;
      if (rLead) { handR = atBody(dLead, -0.02, hzLead); handL = atBody(dRear, 0.12, hzBack); tuckL = true; }
      else { handR = atBody(dRear, -0.12, hzBack); handL = atBody(dLead, 0.02, hzLead); tuckR = true; }
    } else {
      // 持械（或徒手出招）：兵器手/击打手沿内核刀锋角那条射线走。
      //   2026-10-01 用户：「除了打拳击擂台赛，其余的武术打斗情景是不会摆这个动作的」——
      //   持械时**兵器手朝前**（刀尖/剑尖/棍头指向对手），另一只手收在肋前护住自己；
      //   旧版把兵器手缩回腰侧、反而把空手伸到前面，看着就是"空手摆拳击架、兵器成了摆设"。
      const dW = striking ? P.armExtend : (0.34 + 0.10 * g);
      handR = atBody(Math.cos(rel) * dW, Math.sin(rel) * dW + (striking ? -0.10 : -0.14), hzW);
      handL = atBody(dRear, 0.10, hzRib); tuckL = true;                   // 副手护肋（不再贴腮、也不叠胸口）
    }
    // 肘：肩→手的 1/3 处（前臂比上臂短），并且**不许把肘抬到肩膀以上**：
    //   · 贴腮那只手（tuck）：肘尖下垂到肩下 0.14 米，收在肋前；
    //   · 其余：肘略高于手（腰侧握兵/出拳都是这个形），高位劈砍时允许随手臂抬起。
    //   旧版一律"胸与手的中点 +0.10 米"→ 肘比肩膀还高，看着像端着两把枪（用户说的"不自然"）。
    const elbowOf = (hand, sh, tuck) => {
      const mx = (sh.x + hand.x * 2) / 3, my = (sh.y + hand.y * 2) / 3;
      const mz = (sh.z + hand.z * 2) / 3;
      const z = tuck ? Math.min(mz, sh.z - 0.14) : Math.min(mz, hand.z + 0.04);
      return { x: mx, y: my, z: Math.max(baseZ + 0.20, z) };
    };
    const weaponLen = cfg.weaponLen || 1.0;
    const pitch = P.bladePitch;
    let tip = {
      x: handR.x + Math.cos(bladeAng) * weaponLen * Math.cos(pitch),
      y: handR.y + Math.sin(bladeAng) * weaponLen * Math.cos(pitch),
      z: Math.max(0.06, handR.z + Math.sin(pitch) * weaponLen)
    };
    // ── 兵器避让（画面层）：刀锋停在对手身体表面，而不是穿过去 ────────────
    // 只收"刀长"，**方向保持不变** —— 所以"判定帧兵器方向 = 内核刀锋角"这条
    // 不变量依然成立（测试在守），判定与画面也不会互相矛盾。
    if (cfg.opp) tip = clipBladeToBody(handR, tip, cfg.opp);

    // 双腿：站在地面时脚踩地（世界 z = 0）；腾空时整条腿随身体离地，收腿（tuck）时脚再抬高
    const stance = P.stepW / 2;
    const step = Math.sin(f.gait || 0) * D.stride * 0.42 * clamp(P.gaitAmp, 0, 1);
    const footZ = baseZ > 0.02 ? baseZ + clamp(P.tuck || 0, 0, 1) * D.tuckFoot : 0;
    const footL = f.plantedL && baseZ<0.025 && !P.down ? {...f.plantedL} : worldAbs(0.10 + step, stance, footZ);
    const footR = f.plantedR && baseZ<0.025 && !P.down ? {...f.plantedR} : worldAbs(-0.06 - step, -stance, footZ);
    const kneeOf = (foot, back) => ({
      x: (root.x + foot.x) / 2 + cos * (back ? -0.06 : 0.10),
      y: (root.y + foot.y) / 2 + sin * (back ? -0.06 : 0.10),
      z: Math.max(D.kneeMin, (root.z + foot.z) / 2 + 0.10 - crouch * 0.08)
    });

    const shoulderL = shoulder(1), shoulderR = shoulder(-1);
    const output = {
      root, chest, neck, head, hipL: hipJ(1), hipR: hipJ(-1),
      shoulderL, shoulderR,
      elbowL: elbowOf(handL, shoulderL, tuckL), elbowR: elbowOf(handR, shoulderR, tuckR), handL, handR,
      kneeL: kneeOf(footL, false), kneeR: kneeOf(footR, true), footL, footR,
      blade: { a: handR, b: tip }, weaponLen, params: P,
      baseZ, air: baseZ > 0.05,
      gait: f.gait || 0, state: f.st, phase: f.ph, tech: f.tech || "", tp: f.tp || 0
    };
    if(P.down>0){
      const ang=-P.down*Math.PI*0.5, c=Math.cos(ang),sn=Math.sin(ang);
      const rotate=p=>{const dx=p.x-root.x,dy=p.y-root.y,h=p.z-root.z,forward=dx*cos+dy*sin,side=-dx*sin+dy*cos;
        return {x:root.x+(forward*c+h*sn)*cos-side*sin,y:root.y+(forward*c+h*sn)*sin+side*cos,z:Math.max(baseZ+0.04,root.z-forward*sn+h*c)};};
      for(const k of ["chest","neck","head","hipL","hipR","shoulderL","shoulderR","elbowL","elbowR","handL","handR","kneeL","kneeR","footL","footR"])output[k]=rotate(output[k]);
      output.blade={a:output.handR,b:rotate(tip)};
    }
    if(f.action === 'roll' && f.rollP > 0 && f.rollP < 1){
      const p=clamp(f.rollP,0,1), blend=Math.sin(Math.PI*p), ang=2*Math.PI*p;
      const dir=f.rollDir==null?f.face:f.rollDir, c=Math.cos(ang), sn=Math.sin(ang), dc=Math.cos(dir), ds=Math.sin(dir);
      const pivot={x:root.x,y:root.y,z:baseZ+lerp(root.z-baseZ,.48,blend)};
      const rotate=q=>{const x=q.x-root.x,y=q.y-root.y,z=(q.z-root.z)*(1-.58*blend),forward=(x*dc+y*ds)*(1-.3*blend),side=-x*ds+y*dc;
        return {x:pivot.x+(forward*c+z*sn)*dc-side*ds,y:pivot.y+(forward*c+z*sn)*ds+side*dc,z:Math.max(baseZ+.04,pivot.z-forward*sn+z*c)};};
      for(const k of ['root','chest','neck','head','hipL','hipR','shoulderL','shoulderR','elbowL','elbowR','handL','handR','kneeL','kneeR','footL','footR'])output[k]=rotate(output[k]);
      output.blade={a:output.handR,b:rotate(tip)};
    }
    return output;
  }

  // ── 兵器避让：把刀尖收回到对手身体表面（方向不变，只改长度）────────────
  // opp = {x, y, z, r, top}：对手的竖直胶囊（半径 r、从 z 到 z+top）
  function clipBladeToBody(a, b, opp) {
    if (!opp) return b;
    const r = opp.r || 0.34;
    const lo = (opp.z || 0) + 0.05, hi = (opp.z || 0) + (opp.top || 1.75);
    const dx = b.x - a.x, dy = b.y - a.y;
    const dz = b.z - a.z;
    const A = dx * dx + dy * dy;
    if (A < 1e-9) return b;                                  // 垂直下劈：不做水平求解
    const fx = a.x - opp.x, fy = a.y - opp.y;
    const B = 2 * (fx * dx + fy * dy);
    const C = fx * fx + fy * fy - r * r;
    const disc = B * B - 4 * A * C;
    if (disc < 0) return b;                                  // 与身体圆柱不相交
    const sq = Math.sqrt(disc);
    let t = (-B - sq) / (2 * A);                             // 进入身体的第一个交点
    if (t < 0 || t > 1) { if (C < 0) t = 0; else return b; } // 起点已在体内 → 取起点
    const zAt = a.z + dz * t;
    if (zAt < lo || zAt > hi) return b;                      // 交点不在身体高度范围内
    const k = Math.max(0, t - 0.035 / Math.max(0.2, Math.hypot(dx, dy)));   // 再往回退 3.5cm，看着像"抵住"
    return { x: a.x + dx * k, y: a.y + dy * k, z: a.z + dz * k };
  }

  function pose(f, cfg) { return poseFromParams(f, poseParams(f, cfg), cfg); }

  // 两个 60Hz 帧之间的任意时刻：位置/角度插值 + 姿态参数插值（相位切换也平滑）
  function poseInterp(f0, f1, t, cfg) {
    if (!f0) return pose(f1, cfg);
    if (!f1) return pose(f0, cfg);
    const vf = interp(f0, f1, t);
    const P = lerpParams(poseParams(f0, cfg), poseParams(f1, cfg), t);
    return poseFromParams(vf, P, cfg);
  }

  return { VERSION, D, interp, annotate, pose, poseInterp, poseParams, lerpParams, lerpAngle, norm, clipBladeToBody };
});
