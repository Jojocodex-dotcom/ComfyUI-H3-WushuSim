/* ============================================================================
 * drama/templates/library.js — 文戏情景模板库（数据驱动组装，Node 可测）
 * ----------------------------------------------------------------------------
 * 组合：情景(77) × 基调(12) × 强度(3) × 关系(24) × 导演风格(24)
 *   每个情景出 2 个变体（主基调/次基调 × 不同强度 × 匹配基调的导演），共 150+ 条。
 * 每条含：情景与冲突主题、潜台词模式、赌注、关系、基调、强度、**逐拍情绪曲线
 *          （情绪＋身体线索＋物件/环境＋潜台词）**、镜头方案（景别/角度/运镜/职责）、
 *          三层声音（环境/人声/沉默点）、负面清单（含陈旧桥段黑名单）、
 *          可填槽中文骨架、可直接进 H3 的英文骨架（带 (S1)/(S2) 与 <d>）、出处。
 * ========================================================================== */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("./axes.js"));
  else root.DRAMA_TPL_LIB = factory(root.DRAMA_TPL_AXES);
})(typeof globalThis !== "undefined" ? globalThis : this, function (A) {
  "use strict";
  const VERSION = "drama-tpl-0.1";

  // 相位表按拍数自适应：起 → 承… → 转 → 高潮 → 收（末拍永远是收）
  function phasesFor(n) {
    if (n <= 4) return ["起", "承", "转", "收"].slice(0, n);
    if (n === 5) return ["起", "承", "转", "高潮", "收"];
    if (n === 6) return ["起", "承", "承", "转", "高潮", "收"];
    return ["起", "承", "承", "转", "承", "高潮", "收"];
  }
  const EMOTION_LADDER = {
    warm: ["平和", "暖意", "松动", "触动", "哽咽", "释然", "落定"],
    bitter: ["平静", "别扭", "难堪", "刺痛", "翻涌", "疲惫", "空落"],
    suppressed: ["冷静", "绷紧", "挤压", "裂开", "压住", "麻木", "沉底"],
    fierce: ["克制", "发热", "顶撞", "炸开", "失控", "收手", "冷掉"],
    restrained: ["克制", "试探", "隐忍", "失衡", "按下", "退让", "释然"],
    relieved: ["绷着", "松半寸", "犹豫", "看开", "落下", "轻", "定"],
    absurd: ["一本正经", "跑偏", "加码", "穿帮", "乱套", "硬撑", "收场"],
    suspenseful: ["平静", "起疑", "试探", "逼近", "对上", "紧绷", "未解"],
    grieving: ["麻木", "压抑", "塌陷", "崩溃", "脱力", "抽空", "静"],
    sweet: ["心动", "靠近", "发烫", "失控", "依偎", "静默", "甜"],
    awkward: ["客套", "卡壳", "错位", "尬住", "硬圆", "松一口气", "逃"],
    blade: ["客气", "试探", "带锋", "对刺", "见血", "收势", "冷场"]
  };
  const CAM_TEXT = [
    { size: "过肩双人景", angle: "平视", move: "轻微手持跟随", duty: "交代两人间距与谁在退" },
    { size: "中近景正反打", angle: "略低于视线", move: "固定机位切", duty: "把话与反应对上" },
    { size: "手部特写", angle: "俯视", move: "固定", duty: "让动作替代台词" },
    { size: "近景（含肩）", angle: "平视", move: "缓慢推近", duty: "把情绪压到临界" },
    { size: "全景/环境空镜", angle: "中高机位", move: "横向平移", duty: "让环境参与叙事" },
    { size: "侧向双人全景", angle: "平视", move: "轨道移动", duty: "交代位置变化与主动权" },
    { size: "背影跟拍", angle: "后方略低", move: "跟移", duty: "让人物走向决定结尾" }
  ];
  // 英文镜头表（让英文骨架整段无中文）
  const CAM_TEXT_EN = [
    { size: "over-the-shoulder two-shot", angle: "eye level", move: "slight handheld follow" },
    { size: "medium close-up shot-reverse-shot", angle: "just below eyeline", move: "locked off" },
    { size: "close-up on the hands", angle: "high angle", move: "static" },
    { size: "close-up with shoulder in frame", angle: "eye level", move: "slow push-in" },
    { size: "wide establishing shot of the room", angle: "slightly elevated", move: "lateral pan" },
    { size: "side two-shot in full figure", angle: "eye level", move: "dolly move" },
    { size: "rear tracking shot", angle: "low behind the subject", move: "walking follow" }
  ];
  const SOUND_PACK = {
    warm: { amb: "屋里的水声、远处街声", voices: "低而慢的对话，中间有停顿", silence: "两句真话之间留一次完整沉默" },
    bitter: { amb: "风扇/暖气底噪、楼上的脚步", voices: "声音发干，句尾往下掉", silence: "被反驳后先不说话" },
    suppressed: { amb: "钟摆或空调的持续声", voices: "几乎听不出起伏", silence: "最重的一句前停半拍" },
    fierce: { amb: "门被撞响、外面有人说话", voices: "语速加快、音量突然抬高", silence: "爆发之后的一秒钟静" },
    restrained: { amb: "碗筷、茶水、织物摩擦", voices: "把话压着说", silence: "该说的那句始终没说" },
    relieved: { amb: "风穿过门缝、水开的声音", voices: "从紧到松，尾音散开", silence: "说完之后都松下来" },
    absurd: { amb: "音量过大的背景音乐、别人笑", voices: "一本正经地胡说", silence: "突然没人接话的尴尬" },
    suspenseful: { amb: "水滴、打印机的机械声", voices: "问题短、回答更短", silence: "等对方先说" },
    grieving: { amb: "呼吸机/雨声/教堂钟", voices: "含混但每个字都清楚", silence: "哭之前的静" },
    sweet: { amb: "雨打窗、糖水开锅", voices: "轻声，句尾带笑", silence: "靠近时谁都没说话" },
    awkward: { amb: "餐具碰响、手机震动", voices: "抢话、互相打断", silence: "冷场三秒" },
    blade: { amb: "瓷器轻碰、打火机", voices: "客气到发冷", silence: "谁先动谁输" }
  };

  const pick = (arr, i) => arr[((i % arr.length) + arr.length) % arr.length];
  const uniq = (arr) => arr.filter((x, i) => arr.indexOf(x) === i);

  function directorFor(toneKey, sitZh, seed) {
    const exact = A.DIRECTORS.filter(d => d.tone === toneKey && d.fit.indexOf(sitZh) >= 0);
    if (exact.length) return pick(exact, seed);
    const byTone = A.DIRECTORS.filter(d => d.tone === toneKey);
    if (byTone.length) return pick(byTone, seed);
    const byFit = A.DIRECTORS.filter(d => d.fit.indexOf(sitZh) >= 0);
    if (byFit.length) return pick(byFit, seed);
    return pick(A.DIRECTORS, seed);
  }

  // 每条基调的情绪阶梯里，"最重"的位置（高潮拍落在它上面，收尾再回到末尾）
  const PEAK_IDX = { warm: 4, bitter: 4, suppressed: 3, fierce: 4, restrained: 3, relieved: 3, absurd: 3, suspenseful: 4, grieving: 4, sweet: 3, awkward: 3, blade: 4 };
  function beatsOf(sit, tone, intensity, seed) {
    const n = A.INTENSITY[intensity].beats;
    const ladder = EMOTION_LADDER[tone.key] || EMOTION_LADDER.suppressed;
    const pk = Math.min(PEAK_IDX[tone.key] == null ? 3 : PEAK_IDX[tone.key], ladder.length - 1);
    const phases = phasesFor(n);
    const cues = A.BODY_CUES;
    const cueKeys = Object.keys(cues);
    const out = [];
    for (let i = 0; i < n; i++) {
      const phase = phases[i];
      const last = ladder.length - 1;
      const emo = (i >= n - 1) ? ladder[last]                                     // 最后一拍：收
        : ladder[Math.min(pk, Math.round(i * pk / Math.max(1, n - 2)))];      // 高潮拍落在 pk 上
      const cue = cues[pick(Object.keys(cues), seed + i)] || cues[cueKeys[0]];
      const envcue = pick(A.SENSE_SHOTS, seed + i * 2);
      const peak = (i === n - 2);
      out.push({
        i: i + 1, phase: phase, emotion: emo,
        body: pick(cue, i),
        env: envcue,
        subtext: i === 0 ? sit.subtext : (peak ? "把最要紧的一句说成最平常的一句" : "把话往回带半句"),
        line: peak ? "（台词槽：这里放最锋利/最心软的一句，不解释）" : "（台词槽：短句，别超过两次呼吸）",
        note: i === 0 ? "开场就有事发生，不要先站定" : (i === n - 1 ? "停在未解决的那件事上" : "")
      });
    }
    return out;
  }

  function curveOf(sit, tone, intensity, beats) {
    const peak = A.INTENSITY[intensity].peak;
    const n = beats.length;
    const pkIdx = Math.max(0, beats.findIndex(b => b.phase === "高潮"));
    const low = 0.28 * peak;                       // 起点
    return beats.map((b, i) => {
      let tension;
      if (i <= pkIdx) tension = low + (peak - low) * (pkIdx === 0 ? 1 : i / pkIdx);      // 升到高潮
      else tension = peak * (0.72 + 0.28 * (1 - (i - pkIdx) / Math.max(1, n - 1 - pkIdx))); // 收尾回落
      return {
        i: b.i, phase: b.phase,
        tension: +Math.min(peak, tension).toFixed(2),
        valence: tone.valence,
        arousal: +(tone.arousal * (0.55 + 0.65 * (i / Math.max(1, n - 1)))).toFixed(2)
      };
    });
  }

  function cameraOf(sit, tone, intensity, seed) {
    const n = Math.max(A.INTENSITY[intensity].shots[0], Math.min(A.INTENSITY[intensity].shots[1], 6));
    const out = [];
    for (let i = 0; i < n; i++) {
      const c = pick(CAM_TEXT, seed + i);
      const ce = CAM_TEXT_EN[(seed + i) % CAM_TEXT_EN.length];
      out.push({ n: i + 1, size: c.size, angle: c.angle, move: c.move, duty: c.duty,
        sizeEn: ce.size, angleEn: ce.angle, moveEn: ce.move,
        sentence: `${c.size}，${c.angle}，${c.move}，让「${c.duty}」保持清楚。` });
    }
    return out;
  }

  function negativesOf(sit, tone) {
    const base = [
      "解释性台词（把主题念出来）", "情绪写在脸上却不给身体动作", "所有人都站在原地说完整段话",
      "空泛形容词代替具体动作", "哭喊式表演、无留白", "台词里出现主题总结与说教"
    ];
    const extra = [];
    if (tone.key === "blade" || tone.key === "fierce") extra.push("互相打断却听不清谁在说什么", "把冲突写成互相辱骂");
    if (tone.key === "grieving") extra.push("长时间嚎哭", "把悲伤交给背景音乐");
    if (tone.key === "absurd") extra.push("靠夸张表情搞笑", "角色突然意识到自己在演喜剧");
    return uniq(base.concat(extra).concat(A.CLICHES.slice(0, 4).map(c => "陈旧桥段：" + c[0])));
  }

  function skeletonZh(t) {
    return [
      `【情景】${t.situationZh}（${t.familyZh}）　【关系】${t.relationZh}　【基调】${t.toneZh}　【强度】${t.intensityZh}　【导演风格参考】${t.director}　【时长】${t.duration}s`,
      `【冲突主题】${t.conflict}`,
      `【潜台词模式】${t.subtext}`,
      `【赌注 / 完成条件】${t.stake}`,
      `【角色A】「角色A」　【角色B】「角色B」（写下彼此认识多久、最不能提的那件事）`,
      "",
      "【逐拍情绪曲线】（情绪必须外化成身体动作，不许写情绪标签）",
      ...t.beats.map(b => `${b.i}. ${b.phase}｜情绪：${b.emotion}｜身体：${b.body}｜环境：${b.env}｜潜台词：${b.subtext}｜${b.line}${b.note ? "｜" + b.note : ""}`),
      "",
      `【镜头】（共 ${t.camera.length} 镜，每镜一个职责）`,
      ...t.camera.map(c => `[Shot ${c.n}] ${c.sentence}`),
      "",
      "【声音】",
      `环境声：${t.sound.amb}`,
      `人声：${t.sound.voices}`,
      `沉默点：${t.sound.silence}`,
      "",
      "【负面】" + t.negatives.join("；"),
      "",
      "【写作前必查的陈旧桥段】" + A.CLICHES.map(c => c[0]).join("、"),
      "",
      `【台词纪律】台词由第1步写成自然口语；<d> 内只放语言标签与原文、逐字不改；说话人用 (S1)/(S2)，不发声的角色不给编号`
    ].join("\n");
  }

  function skeletonEn(t) {
    const moods = t.beats.map(b => b.emotion).join(", ");
    return [
      `wushu_action, ${t.duration}s, dialogue-driven drama scene, ${t.toneEn} tone, ${A.INTENSITY[t.intensity].zh === "爆发" ? "high intensity" : (t.intensity === "low" ? "low intensity, held back" : "measured intensity")}.`,
      `[Shot 1] ${t.camera[0].sizeEn}, ${t.camera[0].angleEn}, ${t.camera[0].moveEn}; the scene is already in motion and the first line lands inside the first second.`,
      ...t.camera.slice(1).map(c => `[Shot ${c.n}] ${c.sizeEn}, ${c.angleEn}, ${c.moveEn}; keep screen direction, matching eyelines and the same two faces and costumes.`),
      `The man with a low, raspy voice (S1) says: <d>[Chinese] (line here)</d> while his hands stay busy with the object on the table.`,
      `The other man (S2) answers in an off-screen voiceover: <d>[Chinese] (line here)</d> while his lips remain completely closed.`,
      `overall_soundscape: ${SOUND_EN[t.tone] || SOUND_EN.suppressed}.`,
      `non_diegetic_music: N/A`
    ].join("\n");
  }
  const SOUND_EN = {
    warm: "room tone with running water and distant street sound, low slow dialogue, one full silence between the two honest lines",
    bitter: "fan hum and footsteps upstairs, dry voices that drop at the end of each sentence",
    suppressed: "the steady tick of a clock, voices with almost no rise and fall",
    fierce: "a door knocked shut and someone talking outside, voices speeding up then one second of silence after the outburst",
    restrained: "bowls and teacups, cloth shifting, words spoken under the breath",
    relieved: "wind through the door gap and water coming to a boil, voices loosening at the tail",
    absurd: "background music slightly too loud, someone else laughing, one beat of nobody answering",
    suspenseful: "water dripping and a printer cycling, short questions and shorter answers, waiting for the other one to speak",
    grieving: "rain on the window and a hospital monitor, words blurring but every syllable clear",
    sweet: "rain on the glass and sugar water boiling, quiet voices with a smile at the end",
    awkward: "cutlery knocking and a phone buzzing, people talking over each other, three seconds of dead air",
    blade: "porcelain touching and a lighter clicking, voices polite enough to feel cold"
  };

  function build() {
    const out = [];
    A.SITUATIONS.forEach((sit, si) => {
      const tones = (sit.tones && sit.tones.length ? sit.tones : ["suppressed"]).slice(0, 3);
      const variants = tones.length >= 2 ? [0, 1] : [0, 0];
      variants.forEach((vi, k) => {
        const toneLabel = tones[vi];
        const tone = A.TONE_MAP[toneLabel] || A.TONE_BY_ZH[toneLabel] || A.TONES[0];
        const intensity = tone.arousal >= 0.7 ? "high" : (tone.arousal <= 0.3 ? "low" : "mid");
        // 第二个变体在强度上错开一档（低→中、中→高、高→低），保证同一情景有张力差别
        const intensity2 = intensity === "low" ? "mid" : (intensity === "mid" ? "high" : "low");
        const useIntensity = k === 0 ? intensity : intensity2;
        const relLabel = (sit.relations && sit.relations.length) ? sit.relations[k % sit.relations.length] : "朋友";
        // 情景里给的是中文关系名（含"父子/母女""第三者"这类说法）→ 先查别名表，再查中文表，最后查键
        const rel = A.REL_BY_ZH[relLabel] || A.REL_MAP[A.REL_ALIAS[relLabel]] || A.REL_MAP[relLabel] || A.REL_MAP.friend;
        const seed = si * 3 + k * 7;
        const director = directorFor(tone.key, sit.zh, seed);
        const beats = beatsOf(sit, tone, useIntensity, seed);
        const t = {
          id: `d-${sit.id}-${tone.key}-${k + 1}`,
          kind: "drama",
          nameZh: `${sit.zh}·${tone.zh}·${A.INTENSITY[useIntensity].zh}`,
          nameEn: `${sit.id} · ${tone.key} · ${useIntensity}`,
          family: sit.family, familyZh: (A.FAMILIES.find(f => f.key === sit.family) || {}).zh || sit.family,
          familyEn: (A.FAMILIES.find(f => f.key === sit.family) || {}).en || sit.family,
          situationId: sit.id, situationZh: sit.zh,
          conflict: sit.conflict, subtext: sit.subtext, stake: sit.stake,
          relation: rel.key, relationZh: rel.zh, relationTension: rel.tension,
          tone: tone.key, toneZh: tone.zh, toneEn: tone.key, valence: tone.valence, arousal: tone.arousal,
          intensity: useIntensity, intensityZh: A.INTENSITY[useIntensity].zh,
          duration: useIntensity === "low" ? 12 : (useIntensity === "high" ? 20 : 16),   // 每镜正好 4s，满足 H3 单镜 4~15s
          director: director.zh, directorDesc: director.desc, directorSource: director.source,
          beats: beats, curve: curveOf(sit, tone, useIntensity, beats),
          camera: cameraOf(sit, tone, useIntensity, seed),
          sound: SOUND_PACK[tone.key] || SOUND_PACK.suppressed,
          negatives: negativesOf(sit, tone),
          bodyCues: uniq(beats.map(b => b.body)),
          senseShots: uniq(beats.map(b => b.env)),
          provenance: "derived:drama-craft+authored",
          sourceNote: "情景与规则为本项目本地编写；导演风格轴只引用姓名并自写描述，出处：" + A.DIRECTOR_SOURCE,
          license: "本项目本地编写；导演姓名引用自公开仓库（该仓库未附许可证，未收录其原文）"
        };
        t.skeletonZh = skeletonZh(t);
        t.skeletonEn = skeletonEn(t);
        t.tokens = ["A", "B", "relation", "goal"];
        out.push(t);
      });
    });
    return out;
  }

  const TEMPLATES = build();
  const BY_ID = {}; TEMPLATES.forEach(t => BY_ID[t.id] = t);

  const FAMILY_LIST = A.FAMILIES.map(f => ({ key: f.key, zh: f.zh, en: f.en, n: TEMPLATES.filter(t => t.family === f.key).length }));
  const SIT_LIST = A.SITUATIONS.map(s => ({ key: s.id, zh: s.zh, family: s.family, n: TEMPLATES.filter(t => t.situationId === s.id).length }));
  const TONE_LIST = A.TONES.map(t => ({ key: t.key, zh: t.zh, n: TEMPLATES.filter(x => x.tone === t.key).length }));
  const DIR_LIST = A.DIRECTORS.map(d => ({ key: d.zh, zh: d.zh, n: TEMPLATES.filter(x => x.director === d.zh).length }));

  function search(q, opt) {
    opt = opt || {};
    const s = String(q || "").trim().toLowerCase();
    return TEMPLATES.filter(t => {
      if (opt.family && t.family !== opt.family) return false;
      if (opt.situation && t.situationId !== opt.situation) return false;
      if (opt.tone && t.tone !== opt.tone) return false;
      if (opt.intensity && t.intensity !== opt.intensity) return false;
      if (!s) return true;
      const hay = [t.nameZh, t.nameEn, t.situationZh, t.familyZh, t.relationZh, t.toneZh, t.conflict, t.subtext, t.director, t.directorDesc, t.beats.map(b => b.body + b.env + b.emotion).join(" ")].join(" ").toLowerCase();
      return hay.indexOf(s) >= 0;
    });
  }

  function render(t, fills) {
    let out = String(t.skeletonZh);
    const map = { A: "角色A", B: "角色B", relation: "关系", goal: "完成条件" };
    const f = fills || {};
    Object.keys(map).forEach(k => {
      const v = (f[k] == null ? "" : String(f[k]).trim()) || ("「" + map[k] + "」");
      out = out.split("「" + map[k] + "」").join(v);
    });
    return out;
  }

  function stats() {
    return {
      total: TEMPLATES.length, families: FAMILY_LIST.length, situations: A.SITUATIONS.length,
      tones: TONE_LIST.length, directors: DIR_LIST.length,
      byFamily: FAMILY_LIST.reduce((a, x) => (a[x.zh] = x.n, a), {}),
      byTone: TONE_LIST.reduce((a, x) => (a[x.zh] = x.n, a), {}),
      byIntensity: Object.keys(A.INTENSITY).reduce((a, k) => (a[A.INTENSITY[k].zh] = TEMPLATES.filter(t => t.intensity === k).length, a), {})
    };
  }

  // 注入文戏内核：把模板转成 DRAMA.simulate 可用的配置草案
  function toDramaConfig(t, names) {
    const n = names || {};
    return {
      mode: "duel",
      duration: t.duration,
      topic: t.conflict,
      scene: { place: "ancestral_hall", weather: "night", time: "夜里", temp: 18, atmosphere: t.toneZh + "；" + t.directorDesc },
      cast: [
        { name: n.A || "角色A", style: "tactician", goal: t.stake, secret: t.subtext, tics: "", habit: t.bodyCues[0] || "" },
        { name: n.B || "角色B", style: "guardian", goal: t.conflict, secret: t.subtext, tics: "", habit: t.bodyCues[1] || t.bodyCues[0] || "" }
      ],
      note: "由文戏模板「" + t.nameZh + "」生成：冲突主题＝" + t.conflict + "；关系＝" + t.relationZh + "；基调＝" + t.toneZh
    };
  }

  return { VERSION, TEMPLATES, TEMPLATES_BY_ID: BY_ID, AXES: A, FAMILY_LIST, SIT_LIST, TONE_LIST, DIR_LIST, search, render, stats, toDramaConfig, skeletonZh, skeletonEn };
});
