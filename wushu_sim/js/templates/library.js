/* ============================================================================
 * templates/library.js — 打斗模板库（数据驱动组装，Node 可测）
 * ----------------------------------------------------------------------------
 * 组合轴：题材(15) × 结构(7) × 强度(高/中/慢) —— 只取"合理组合"（含兼容矩阵），
 * 每条模板都带：场景、双方优势距离、空间轴线、资源、主动权变化、结束画面、
 * 逐拍骨架、镜头（六项句式＋职责）、三层声音、负面清单、可填槽提示词骨架、
 * 以及**出处**（derived:fight-design / corpus:<slug> / authored）。
 * 语料出处见 _template_sources/（含各仓库 LICENSE）。
 * ========================================================================== */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("./axes.js"), require("./corpus.js"), require("../sim3d/combat-logic.js"));
  else root.TPL_LIB = factory(root.TPL_AXES, root.TPL_CORPUS, root.FIGHT_LOGIC);
})(typeof globalThis !== "undefined" ? globalThis : this, function (A, CORPUS, FIGHT_LOGIC) {
  "use strict";
  const VERSION = "templates-0.2";

  const TIMES = ["黄昏", "夜里", "清晨", "正午", "雨后"];
  const WEATHER = ["阴云", "小雨", "大风", "起雾", "落雪"];
  const STRENGTH_KEYS = ["high", "mid", "slow"];
  const SPOTLIGHT = ["wuxia", "xianxia", "live_hand", "magic", "scifi_mecha", "samurai", "fantasy_qi", "anime_action"];

  const pick = (arr, i) => arr[((i % arr.length) + arr.length) % arr.length];

  // 结构阶段 → 镜头职责（每段至少一眼能看懂）
  const STAGE_DUTY = { "建立空间": "establish", "起动": "follow", "追随位移": "follow", "距离变化": "follow", "看清接触": "contact", "接触与格挡": "contact", "反制": "counter", "反应": "counter", "表达失衡": "offbalance", "表达反制": "counter", "展示弹道": "ballistic", "受击与结果": "offbalance", "揭示结果": "reveal", "稳定收尾": "settle", "收尾": "settle" };

  function cameraPlan(structure, genre, strengthKey, seedIx) {
    const st = A.STRENGTH[strengthKey];
    const out = [];
    structure.cameraStages.forEach((stage, i) => {
      const dutyKey = STAGE_DUTY[stage] || "follow";
      const duty = A.CAM_DUTIES.find(d => d.key === dutyKey) || A.CAM_DUTIES[1];
      const frame = pick(genre.cameraPool, seedIx + i);
      const way = pick(duty.ways, seedIx + i + 1);
      let move = "";
      if (dutyKey === "follow") move = st.move;
      else if (dutyKey === "contact") move = st.touch;
      else if (dutyKey === "counter") move = st.counter;
      else if (dutyKey === "ballistic") move = st.ranged;
      else if (dutyKey === "offbalance") move = st.hit;
      else if (dutyKey === "settle") move = st.end;
      else if (dutyKey === "establish") move = st.start;
      // 跟随/接触/反制/受击/弹道这几类，强度短语本身已说明机位怎么走，不再叠一句景别方式（否则出现"贴地跟拍、贴地或侧后跟拍"式重复）
      const motionOnly = ["follow", "contact", "counter", "offbalance", "ballistic"].indexOf(dutyKey) >= 0;
      const head = motionOnly ? (frame + "，" + move) : (frame + "，" + way + (move ? "，" + move : ""));
      out.push({
        n: i + 1, stage: stage, duty: duty.zh, dutyKey: dutyKey,
        frame: frame, way: way, move: move,
        sentence: head + "，让「" + duty.q + "」保持清楚。"
      });
    });
    return out;
  }

  function beatsOf(structure, genre, seedIx) {
    const media = genre.media;
    const last = structure.skeleton.length - 1;
    return structure.skeleton.map((b, i) => {
      if (i === 1) return b + "（环境反馈：" + pick(media, seedIx + i * 2) + "）";
      if (i === last) return b + "（结果画面要看见：" + pick(media, seedIx + i * 2 + 1) + "）";
      return b;
    });
  }

  function skeletonZh(t, fill) {
    const f = (k, label) => (fill && String(fill[k] == null ? "" : fill[k]).trim()) || ("「" + label + "」");
    return [
      `【题材】${t.genreZh}　【结构】${t.structureZh}　【强度】${t.strengthZh}　【速度】${t.speedZh}　【时长】${t.duration}s`,
      `【角色A】${f("A", "角色A")}：擅长 ${f("wA", "兵器A")}，优势距离 ${f("dA", "优势距离A")}`,
      `【角色B】${f("B", "角色B")}：擅长 ${f("wB", "兵器B")}，优势距离 ${f("dB", "优势距离B")}`,
      `【空间轴线】${f("axis", "空间轴线")}`,
      `【完成条件】${f("goal", "完成条件")}`,
      `【资源】${t.resources.join("、")}（全片数量唯一，位置必须连续可读）`,
      "",
      "【逐拍骨架】",
      ...t.beats.map((b, i) => `${i + 1}. ${b}`),
      "",
      "【连续动作展开（间隙动作＋因果链：每拍拆成前因→动作→接触→受力→余波，动作段必须带脚步）】",
      ...(FIGHT_LOGIC ? FIGHT_LOGIC.expandBeats(t.beats, { seed: 3, startDist: 2, media: t.media, names: ["角色A", "角色B"] })
        .map(e => `  ${e.phase}｜${e.text}${e.filler ? "（间隙动作：" + e.filler.zh + "）" : ""}`) : ["  （缺少核心打斗逻辑模块）"]),
      "",
      "【镜头】（六项句式：景别＋机位高度角度＋速度＋方向＋跟随对象＋本镜职责）",
      ...t.camera.map(c => `[Shot ${c.n}] ${c.stage}｜职责：${c.duty}｜${c.sentence}`),
      "",
      "【声音】",
      `环境声：${t.sound.amb}`,
      `动作声：${t.sound.act}`,
      `非语言人声：${t.sound.human}`,
      "",
      "【负面】" + t.negatives.join("；"),
      "",
      "【节奏红线】首个有效动作 ≤" + t.redline.firstMove + " 秒；纯恢复动作 ≤" + t.redline.pureRecovery + " 秒；动作特写 " + t.redline.actionCloseup[0] + "~" + t.redline.actionCloseup[1] + " 秒；慢动作 " + t.redline.slowmo + "；交锋 " + t.redline.clashes + " 次"
    ].join("\n");
  }

  // 英文骨架：镜头与强度短语全部走英文表，声音走英文声音包，确保整段不带中文
  function skeletonEn(t) {
    const en = A.STRENGTH_EN[t.strength] || A.STRENGTH_EN.mid;
    const pool = (A.GENRE_MAP[t.genre] || {}).cameraPoolEn || ["cinematic framing"];
    const sEn = t.soundEn || (A.GENRE_MAP[t.genre] || {}).soundEn || { amb: "room tone", act: "material impact", human: "breath" };
    const lines = t.camera.map((c, i) => {
      const mv = c.dutyKey === "follow" ? en.move
        : c.dutyKey === "contact" ? en.touch
        : c.dutyKey === "counter" ? en.counter
        : c.dutyKey === "ballistic" ? en.ranged
        : c.dutyKey === "offbalance" ? en.hit
        : c.dutyKey === "settle" ? en.end
        : en.start;
      const duty = c.dutyKey === "contact" ? "the contact point and the resulting shift of weight stay readable"
        : c.dutyKey === "counter" ? "the change of initiative stays readable"
        : c.dutyKey === "offbalance" ? "the direction of force and the loss of balance stay readable"
        : c.dutyKey === "ballistic" ? "releaser, path and target stay connected"
        : c.dutyKey === "reveal" ? "who gains the positional advantage stays clear"
        : c.dutyKey === "settle" ? "hold the result and keep only the residual motion"
        : c.dutyKey === "establish" ? "who is where, with the first committed move inside " + t.redline.firstMove + "s"
        : "keep screen direction and the left/right relation";
      return `[Shot ${i + 1}] ${pool[i % pool.length]} ${mv}, ${duty}.`;
    });
    const logic = FIGHT_LOGIC ? [
      "Keep the causal chain closed: the result of each exchange is the reason for the next one; the fighters never reset between beats.",
      "Fill every pause with visible footwork or a stance reset (padding step, half-step angle, dragged step, guard hand up); no unexplained stillness over 0.35s.",
      "Dodges must slip a named incoming line and land somewhere specific, then either counter or re-press within 0.6s.",
      "Chain the moves: the second half of the recovery flows into the next action of the same combo."
    ] : [];
    return [
      `wushu_action, ${t.duration}s, ${t.genreEn.toLowerCase()}, ${t.structureEn.toLowerCase()}, ${t.strength === "high" ? "high intensity" : t.strength === "slow" ? "slow burn" : "measured intensity"}, ${t.speed === "fast" ? "fast-cut density" : "standard density"}.`,
      ...logic,
      ...lines,
      `overall_soundscape: ${sEn.amb}; ${sEn.act}; ${sEn.human}.`,
      `non_diegetic_music: N/A`
    ].join("\n");
  }

  function build() {
    const list = [];
    let n = 0;
    A.STRUCTURES.forEach((structure) => {
      const genres = A.COMPAT[structure.key] || [];
      genres.forEach((gKey, gi) => {
        const g = A.GENRE_MAP[gKey];
        if (!g) return;
        // 每个组合给 2 档强度；重点题材再多一档慢节奏
        const strengths = SPOTLIGHT.indexOf(gKey) >= 0 ? ["high", "mid", "slow"] : ["high", "mid"];
        strengths.forEach((sk, si) => {
          n++;
          const seedIx = gi + si * 2 + structure.key.length;
          const speed = (sk === "high") ? "std" : (sk === "slow" ? "std" : "fast");
          const dens = A.DENSITY[speed];
          const range = structure.density[sk] || [5, 7];
          const clashes = range[0];
          const duration = sk === "slow" ? 15 : (speed === "fast" ? 12 : 15);
          const t = {
            id: `${gKey}-${structure.key}-${sk}`,
            nameZh: `${g.zh}·${structure.zh}·${A.STRENGTH[sk].zh}`,
            nameEn: `${g.en} · ${structure.en} · ${A.STRENGTH[sk].zh}`,
            genre: gKey, genreZh: g.zh, genreEn: g.en,
            structure: structure.key, structureZh: structure.zh, structureEn: structure.en,
            strength: sk, strengthZh: A.STRENGTH[sk].zh,
            speed: speed, speedZh: dens.zh,
            duration: duration,
            scene: { place: pick(g.places, gi + si), time: pick(TIMES, gi + si), weather: pick(WEATHER, gi + si * 3) },
            axis: g.axis,
            advantage: g.advantage,
            resources: g.weapons.slice(0, 3),
            media: g.media,
            beats: beatsOf(structure, g, seedIx),
            camera: cameraPlan(structure, g, sk, seedIx),
            sound: g.sounds,
            soundEn: g.soundEn,
            negatives: g.negatives,
            redline: { firstMove: speed === "fast" ? 0.15 : 0.3, pureRecovery: dens.pureRecovery, actionCloseup: dens.actionCloseup, slowmo: dens.slowmo, clashes: `${range[0]}~${range[1]}` },
            core: structure.core,
            need: structure.need,
            provenance: /authored/.test(g.source) ? "derived:fight-design+authored" : g.source,
            sourceNote: g.source,
            license: "结构骨架与量化红线源自 irenerachel/fight-prompt-director（MIT）；题材词包为本项目本地编写"
          };
          t.skeletonZh = skeletonZh(t);
          t.skeletonEn = skeletonEn(t);
          t.tokens = ["A", "wA", "dA", "B", "wB", "dB", "axis", "goal"];
          t.kind = "derived";
          t.hasFullTemplate = true;
          // 语料条目的题材/结构名（genres.md 里是中文，这里补齐，便于列表统一显示）
          t.genreZh = g.zh; t.structureZh = structure.zh; t.structureEn = structure.en;
          list.push(t);
        });
      });
    });
    return list;
  }

  const DERIVED = build();
  // 语料索引条目（kind:"corpus"）：只给出处与结构要点，正文用 nearestDerived 的同题材同结构模板
  const CORPUS_LIST = (CORPUS && CORPUS.CORPUS_TEMPLATES) ? CORPUS.CORPUS_TEMPLATES.map(t => {
    const g = A.GENRE_MAP[t.genre], s = A.STRUCT_MAP[t.structure];
    t.genreZh = g ? g.zh : t.genre;
    t.genreEn = g ? g.en : t.genre;
    t.structureZh = s ? s.zh : t.structure;
    t.structureEn = s ? s.en : t.structure;
    const near = CORPUS.nearestDerived(t, DERIVED);
    t.nearestId = near.tpl ? near.tpl.id : null;
    t.nearestExact = !!(near && near.exact);
    return t;
  }) : [];
  const TEMPLATES = DERIVED.concat(CORPUS_LIST);
  const BY_ID = {}; TEMPLATES.forEach(t => BY_ID[t.id] = t);

  // ── 查询 ────────────────────────────────────────────────────────────
  const GENRE_LIST = A.GENRES.map(g => ({ key: g.key, zh: g.zh, en: g.en, n: TEMPLATES.filter(t => t.genre === g.key).length }));
  const STRUCT_LIST = A.STRUCTURES.map(s => ({ key: s.key, zh: s.zh, en: s.en, n: TEMPLATES.filter(t => t.structure === s.key).length }));
  function search(q, opt) {
    opt = opt || {};
    const s = String(q || "").trim().toLowerCase();
    return TEMPLATES.filter(t => {
      if (opt.kind && t.kind !== opt.kind) return false;
      if (opt.genre && t.genre !== opt.genre) return false;
      if (opt.structure && t.structure !== opt.structure) return false;
      if (opt.strength && t.strength !== opt.strength) return false;
      if (!s) return true;
      const hay = [t.nameZh, t.nameEn, t.genreZh, t.structureZh, t.core, t.axis, t.advantage,
        (t.sound && t.sound.amb) || "", (t.scene && t.scene.place) || "", t.negatives.join(" "),
        t.provenance || "", (t.source && t.source.author) || "", (t.facts && t.facts.weapons || []).join(" ")].join(" ").toLowerCase();
      return hay.indexOf(s) >= 0;
    });
  }

  // 槽位替换：填了就用填的，没填就保留"占位提示"
  function render(t, fills) {
    let out = String(t.skeletonZh);
    const f = fills || {};
    const map = { A: "角色A", wA: "兵器A", dA: "优势距离A", B: "角色B", wB: "兵器B", dB: "优势距离B", axis: "空间轴线", goal: "完成条件" };
    Object.keys(map).forEach(k => {
      const v = (f[k] == null ? "" : String(f[k]).trim()) || ("「" + map[k] + "」");
      out = out.split("「" + map[k] + "」").join(v);
    });
    return out;
  }
  function surface(t, fill) { return skeletonZh(t, fill); }

  // 语料条目 → 用"同题材同结构"的本地模板出稿（并明确告知不是复刻原文）
  function draftForCorpus(t, fills) {
    const near = BY_ID[t.nearestId] || DERIVED[0];
    const body = render(near, fills || {});
    return {
      zh: [
        "【来自语料参考条目：" + t.nameZh + "　出处 " + ((t.source && t.source.url) || "（无链接）") + "】",
        t.skeletonZh,
        "",
        "—— 以下正文由本库同题材同结构的模板生成（" + near.nameZh + (t.nearestExact ? "，题材与结构完全对应" : "，题材或结构就近匹配") + "），**不是原作者的原文** ——",
        "",
        body
      ].join("\n"),
      en: near.skeletonEn,
      requirements: "（语料参考条目没有可填槽的量化骨架；要求块请用就近模板：" + near.nameZh + "）",
      name: t.nameZh, id: t.id, kind: "corpus", nearest: near.id, nearestExact: !!t.nearestExact
    };
  }

  function stats() {
    return {
      total: TEMPLATES.length,
      derived: DERIVED.length,
      corpus: CORPUS_LIST.length,
      genres: GENRE_LIST.length,
      structures: STRUCT_LIST.length,
      byGenre: GENRE_LIST.reduce((a, x) => (a[x.zh] = x.n, a), {}),
      byStructure: STRUCT_LIST.reduce((a, x) => (a[x.zh] = x.n, a), {}),
      byStrength: STRENGTH_KEYS.reduce((a, k) => (a[A.STRENGTH[k].zh] = DERIVED.filter(t => t.strength === k).length, a), {})
    };
  }

  return { VERSION, TEMPLATES, DERIVED, CORPUS_TEMPLATES: CORPUS_LIST, TEMPLATES_BY_ID: BY_ID, AXES: A, CORPUS, GENRE_LIST, STRUCT_LIST, search, render, surface, draftForCorpus, stats, skeletonZh, skeletonEn };
});
