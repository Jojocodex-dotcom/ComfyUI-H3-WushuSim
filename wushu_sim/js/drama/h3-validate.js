/* ============================================================================
 * drama/h3-validate.js — H3 提示词合规检查（按官方 SKILL 逐条机检）
 * ----------------------------------------------------------------------------
 * 用途：第2步产出后自动体检，把"看起来像"变成"逐条能查"。检查项全部来自官方：
 *   base-en.txt 4.4 说话人/对白/演唱、4.6 overall_soundscape、4.7 non_diegetic_music、
 *   时长 4~15s、[Shot 1] 不带时间戳、后续 At MM:SS.mmm 递进、字段顺序，
 *   以及 3d-animation-short-generator 的"面对白嘴开、离屏旁白嘴闭"。
 * ========================================================================== */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.H3_VALIDATE = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const RE = {
    shot: /\[Shot\s+(\d+)\]/g,
    atCut: /At\s+(\d{2}):(\d{2})\.(\d{2,3})\s*,\s*the\s+camera\s+cuts?\s+to/gi,
    dTag: /<d>([\s\S]*?)<\/d>/g,
    dOpen: /<d>/g,
    langTag: /<d>\[\s*([A-Za-z\- ]+)\s*\]/g,
    speaker: /\((S\d+(?:\s*,\s*S\d+)*)\)/g,
    voiceover: /off-screen voiceover/gi,
    lipsClosed: /lips?\s+(?:remain|stay|are)\s+(?:completely\s+)?closed|mouth\s+(?:remains|stays)\s+closed|lips\s+do\s+not\s+move/gi,
    scenetrans: /<scenetrans>/gi,
    cutoff: /<cutoff>/gi,
    duration: /([\d.]+)\s*s(?:ec(?:onds)?)?\b/i,
    fields: ["integrated_multimodal_description", "overall_soundscape", "non_diegetic_music"]
  };

  function parseShots(text) {
    const out = [];
    const idx = [];
    let m;
    RE.shot.lastIndex = 0;
    while ((m = RE.shot.exec(text))) idx.push({ n: +m[1], at: m.index });
    idx.forEach((s, i) => out.push({
      n: s.n,
      body: text.slice(s.at, i + 1 < idx.length ? idx[i + 1].at : text.length),
      head: text.slice(s.at, s.at + 200)
    }));
    return out;
  }

  function section(text, name) {
    const i = text.indexOf(name + ":");
    if (i < 0) return "";
    const rest = text.slice(i + name.length + 1);
    const next = rest.search(/\n(integrated_multimodal_description|overall_soundscape|non_diegetic_music|subject_definitions|summary|preservation_analysis|retention_analysis|detailed_description):/);
    return (next >= 0 ? rest.slice(0, next) : rest).trim();
  }

  function validate(text, opts) {
    opts = opts || {};
    const mode = opts.mode || (/(^|\n)参考图/.test(text) ? "ref" : "t2v");
    const dur = opts.duration || null;
    const issues = [], passes = [];
    const add = (ok, code, msg) => (ok ? passes : issues).push({ code, msg });

    // ── 结构 ──────────────────────────────────────────────────────────
    const order = mode === "ref"
      ? ["subject_definitions", "summary", "integrated_multimodal_description", "overall_soundscape", "non_diegetic_music", "preservation_analysis"]
      : ["integrated_multimodal_description", "overall_soundscape", "non_diegetic_music"];
    const pos = order.map(f => text.indexOf(f + ":"));
    add(pos.every(p => p >= 0), "field-missing", "缺少字段：" + order.filter((f, i) => pos[i] < 0).join("、"));
    add(pos.every((p, i) => i === 0 || p > pos[i - 1]), "field-order", "字段顺序与官方规范不一致");
    if (mode === "t2v") add(!/<Subject\s+\d>|<Picture\s+\d>|IMAGE\d/i.test(text), "t2v-labels", "T2VA 不应出现参考标签/IMAGE 编号");
    if (mode === "ref") {
      add(/\[reference generation\]/.test(text), "ref-summary", "summary 缺少 [reference generation] 任务类型前缀");
      add(!/<Video\s+\d>|<Audio\s+\d>/i.test(text), "ref-media", "没有视频/音频素材时不应写 <Video N>/<Audio N>");
    }

    // ── 镜头与时间轴 ──────────────────────────────────────────────────
    const shots = parseShots(text);
    add(shots.length >= 1, "shot-count", "没有任何 [Shot N]");
    add(shots.length ? shots[0].n === 1 : false, "shot-first", "第一镜必须是 [Shot 1]");
    add(shots.every((s, i) => s.n === i + 1), "shot-seq", "镜头编号必须连续");
    add(!/\[Shot\s+1\][^\n]{0,40}\bAt\s+\d{2}:\d{2}/.test(text), "shot1-time", "[Shot 1] 不应带时间戳");
    const cuts = [];
    RE.atCut.lastIndex = 0;
    let cm;
    while ((cm = RE.atCut.exec(text))) cuts.push(+cm[1] * 60 + +cm[2] + (+cm[3]) / (cm[3].length === 2 ? 100 : 1000));
    add(cuts.length === Math.max(0, shots.length - 1), "cut-count", `切点数量应等于镜头数-1（${cuts.length}/${Math.max(0, shots.length - 1)}）`);
    add(cuts.every((c, i) => i === 0 || c > cuts[i - 1]), "cut-order", "切点时间必须严格递增");
    if (dur) {
      const last = text.match(/At\s+(\d{2}):(\d{2})\.(\d{2,3})/g);
      const tail = last ? last[last.length - 1] : null;
      if (tail) {
        const mm = tail.match(/(\d{2}):(\d{2})\.(\d{2,3})/);
        const t = +mm[1] * 60 + +mm[2] + (+mm[3]) / (mm[3].length === 2 ? 100 : 1000);
        add(t < dur + 0.001, "cut-in-duration", `切点 ${t}s 超出片长 ${dur}s`);
      }
      add(dur >= 4 && dur <= 15, "duration-range", `片长 ${dur}s 应在 4~15 秒（官方限制）`);
    }

    // ── 对白 / 说话人（官方 4.4）──────────────────────────────────────
    const dOpen = (text.match(RE.dOpen) || []).length;
    const dClose = (text.match(/<\/d>/g) || []).length;
    add(dOpen === dClose, "d-unclosed", `<d> 与 </d> 数量不等（${dOpen}/${dClose}）`);
    const ds = [...text.matchAll(RE.dTag)].map(m => m[1]);
    add(ds.every(s => /^\[\s*[A-Za-z\- ]+\s*\]/.test(s)), "d-lang", "每个 <d> 内都应以 [Language] 开头");
    const speakers = new Set();
    [...text.matchAll(RE.speaker)].forEach(m => m[1].split(",").forEach(s => speakers.add(s.trim())));
    if (ds.length) add(speakers.has("S1"), "speaker-first", "有台词时第一个说话人编号必须是 (S1)");
    if (ds.length) {
      add(speakers.size >= 1, "speaker-present", "有台词但没有说话人编号 (S1)/(S2)");
      // 台词必须在 (Sx) 之后出现（编号在 <d> 外）
      let bad = 0;
      for (const s of shots) {
        const parts = s.body.split(/<d>/);
        for (let i = 1; i < parts.length; i++) {
          if (!/\(S\d+(?:\s*,\s*S\d+)*\)/.test(parts[i - 1].slice(-260))) bad++;
        }
      }
      add(bad === 0, "speaker-before-d", "每句 <d> 之前都必须先给出说话人编号 (S1)/(S2)");
    }
    // 画外音必须紧跟"嘴唇不动"
    let vo = 0, voBad = 0;
    for (const s of shots) {
      const segs = s.body.split(/<d>[\s\S]*?<\/d>/);
      const bodies = [...s.body.matchAll(/<d>[\s\S]*?<\/d>/g)].map(m => m[0]);
      bodies.forEach((b, i) => {
        const before = segs[i] || "";
        if (/off-screen voiceover/i.test(before.slice(-200))) {
          vo++;
          const after = (segs[i + 1] || "").slice(0, 220);
          if (!/lips?\s+(?:remain|stay|are)\s+(?:completely\s+)?closed|mouth\s+(?:remains|stays)\s+closed|lips?\s+do(?:es)?\s+not\s+move/i.test(after)) voBad++;
        }
      });
    }
    add(voBad === 0, "voiceover-lips", `画外音没有紧跟"嘴唇不动"说明（${voBad}/${vo}）`);
    // 声音段不得复述对白
    const ss = section(text, "overall_soundscape");
    let repeated = 0;
    const cjk = (str) => str.replace(/[^\u4e00-\u9fff]/g, "");
    for (const d of ds) {
      const line = cjk(d);
      if (line.length >= 4 && cjk(ss).indexOf(line) >= 0) repeated++;
    }
    add(ds.length === 0 || repeated === 0, "sound-no-dialogue", `overall_soundscape 不得重复对白（重复 ${repeated} 处）`);
    add(ss.length > 0 && /N\/A/i.test(ss) === false || /完全静音|complete silence/i.test(text), "soundscape-na", "overall_soundscape 不该用 N/A（除非明确要求全片静音）");
    add(/non_diegetic_music:/.test(text) && section(text, "non_diegetic_music").length > 0, "ndm-present", "non_diegetic_music 必须给出内容或 N/A");

    return { ok: issues.length === 0, issues, passes, mode, shots: shots.length, dialogueLines: ds.length, speakers: [...speakers], cuts };
  }

  return { validate, parseShots, section };
});
