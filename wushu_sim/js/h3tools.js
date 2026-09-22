/* ============================================================================
 * h3tools.js — H3 提示词工具箱（本地纯函数，不调用任何大模型 / 不花钱）
 * ----------------------------------------------------------------------------
 * 三件事，都是「提示词优化工具」里最常见的功能，但全部离线跑：
 *   ① 分镜表：把成片提示词里的 [Shot N] 拆成镜号/时间码/运镜/画面，导出 MD、CSV
 *   ② 版本对比：两次生成的提示词做行级 diff，看清这一版改了什么
 *   ③ 多模型改写：同一场武打，一键改写成 可灵 / 即梦 / Veo / Runway / Sora 的写法
 *
 * 同一份代码在浏览器（window.H3TOOLS）与 Node（module.exports）都能跑，方便写测试。
 * ========================================================================== */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.H3TOOLS = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const VERSION = "h3tools-0.1";

  /* ── ① 分镜解析 ─────────────────────────────────────────────────────── */

  // [Shot 1] / [SHOT 1] / 【镜头 1】 / （镜 2） 都能认
  const SHOT_RE = /[\[【（(]\s*(?:Shot|镜头|镜)\s*(\d+)\s*[\]】）)]/gi;
  const TC_RANGE = /(\d+(?:\.\d+)?)\s*(?:-|–|—|~|～|至)\s*(\d+(?:\.\d+)?)\s*(?:s|秒)/i;
  const TC_AT = /At\s+(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?/i;
  // 运镜词表：中英都要认，AI 润色后可能是「低角度跟拍」也可能是「low-angle tracking shot」
  const CAM_RE = /(广角|全景|中景|近景|特写|大特写|过肩|跟拍|跟随|推近|推轨|拉远|拉升|环绕|绕拍|摇镜|甩镜|手持|升降|俯拍|仰拍|低角度|高角度|贴地|第一人称|主观镜头|定机位|移轴|变焦|慢推|快推|wide|full shot|medium shot|close[- ]?up|extreme close|over[- ]?the[- ]?shoulder|over[- ]?shoulder|tracking|dolly|push[- ]?in|pull[- ]?out|crane|pan|tilt|zoom|orbit|arc|handheld|pov|low[- ]?angle|high[- ]?angle|static|whip pan)/i;

  const STRIP_TC_HEAD = /^[\s(（]*\d+(?:\.\d+)?\s*(?:-|–|—|~|～|至)\s*\d+(?:\.\d+)?\s*(?:s|秒)?[)）]?[.。:：,，]?\s*/i;
  const STRIP_AT_HEAD = /^[\s(（]*At\s+\d{1,2}:\d{2}(?:\.\d+)?[)）]?[.。:：,，]?\s*/i;

  // 取一段连续的运镜描述（「低角度跟拍」「low-angle tracking shot」都算一整段）
  function cameraOf(body) {
    const re = new RegExp(CAM_RE.source, "gi");
    let m, firstAt = -1, lastEnd = -1;
    while ((m = re.exec(body))) {
      if (firstAt < 0) { firstAt = m.index; lastEnd = m.index + m[0].length; continue; }
      if (m.index <= lastEnd + 1) { lastEnd = m.index + m[0].length; continue; }   // 紧挨着 → 同一段运镜
      break;
    }
    return firstAt < 0 ? "" : body.slice(firstAt, lastEnd).trim();
  }

  function parseShots(text) {
    const t = String(text == null ? "" : text);
    const marks = [];
    let m;
    SHOT_RE.lastIndex = 0;
    while ((m = SHOT_RE.exec(t))) marks.push({ n: +m[1], at: m.index, end: SHOT_RE.lastIndex });
    const rows = [];
    for (let i = 0; i < marks.length; i++) {
      const raw = t.slice(marks[i].end, i + 1 < marks.length ? marks[i + 1].at : t.length).trim();
      const range = raw.match(TC_RANGE);
      const at = raw.match(TC_AT);
      let start = range ? +range[1] : null;
      let end = range ? +range[2] : null;
      let timecode = null;
      if (at) timecode = (+at[1]) * 60 + (+at[2]) + (at[3] ? +("0." + at[3]) : 0);
      if (start == null && timecode != null) start = timecode;
      let body = raw.replace(STRIP_TC_HEAD, "").replace(STRIP_AT_HEAD, "").trim();
      // 去掉紧跟在镜号后的「本镜起止」中文写法：0.0-6.0 秒
      body = body.replace(STRIP_TC_HEAD, "").trim();
      const camHit = body ? cameraOf(body) : "";
      rows.push({
        n: marks[i].n,
        start: start,
        end: end,
        dur: (start != null && end != null) ? +(end - start).toFixed(3) : null,
        timecode: timecode,
        camera: camHit,
        action: body,
        raw: raw
      });
    }
    return rows;
  }

  // 分镜表：Markdown
  function shotTableMd(rows, meta) {
    meta = meta || {};
    const head = [
      "# 分镜表 · " + (meta.title || "武打场次"),
      "",
      "- 时长：" + (meta.duration != null ? meta.duration + "s" : "—") + "｜镜头数：" + rows.length +
        (meta.cast ? "｜对阵：" + meta.cast : ""),
      meta.scene ? "- 场景：" + meta.scene : null,
      meta.seed != null ? "- 随机种子 seed：" + meta.seed + "（同 seed 可复现同一场打斗）" : null,
      meta.outcome ? "- 结算：" + meta.outcome : null,
      "",
      "| 镜号 | 起(s) | 止(s) | 时长(s) | 运镜 | 画面内容 |",
      "| --- | --- | --- | --- | --- | --- |"
    ].filter(x => x !== null);
    const body = rows.map(r => "| " + [
      r.n,
      r.start != null ? r.start.toFixed(2) : "—",
      r.end != null ? r.end.toFixed(2) : "—",
      r.dur != null ? r.dur.toFixed(2) : "—",
      cell(r.camera || "—"),
      cell(r.action || "")
    ].join(" | ") + " |");
    return head.concat(body).join("\n") + "\n";
  }

  function cell(s) {
    return String(s == null ? "" : s).replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
  }

  // 分镜表：CSV（带 BOM，Excel 直接双击不乱码）
  function shotTableCsv(rows, meta) {
    meta = meta || {};
    const out = [];
    if (meta.title) out.push(["# 分镜表", meta.title].map(q).join(","));
    out.push(["镜号", "起(s)", "止(s)", "时长(s)", "运镜", "画面内容"].map(q).join(","));
    rows.forEach(r => out.push([
      r.n,
      r.start != null ? r.start.toFixed(2) : "",
      r.end != null ? r.end.toFixed(2) : "",
      r.dur != null ? r.dur.toFixed(2) : "",
      r.camera || "",
      r.action || ""
    ].map(q).join(",")));
    return "\ufeff" + out.join("\r\n") + "\r\n";
  }

  function q(v) {
    const s = String(v == null ? "" : v);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  // 分镜节奏体检：镜头数、时长是否均匀、运动量是否够（不做 AI 判断，只做量化）
  function shotStats(rows) {
    const durs = rows.map(r => r.dur).filter(d => d != null && d > 0);
    const n = rows.length;
    const total = durs.reduce((a, b) => a + b, 0);
    const avg = durs.length ? total / durs.length : 0;
    const max = durs.length ? Math.max.apply(null, durs) : 0;
    const min = durs.length ? Math.min.apply(null, durs) : 0;
    const flat = [];
    if (n > 0 && n < 4) flat.push("镜头数偏少（" + n + " 个），武打建议 4-6 个镜头");
    if (n > 9) flat.push("镜头数偏多（" + n + " 个），超过 9 个容易碎，建议合并过渡拍");
    if (avg && max / avg > 2.2) flat.push("最长镜 " + max.toFixed(1) + "s 是最短镜的 " + (max / (min || 1)).toFixed(1) + " 倍，节奏头重脚轻");
    const empty = rows.filter(r => (r.action || "").length < 8);
    if (empty.length) flat.push("有 " + empty.length + " 个镜头几乎没有动作描写（" + empty.map(r => "镜" + r.n).join("、") + "）");
    return { shots: n, total: +total.toFixed(2), avg: +avg.toFixed(2), max: max, min: min, notes: flat };
  }

  /* ── ② 版本对比（行级 diff）────────────────────────────────────────── */

  function diffLines(a, b) {
    const A = norm(a), B = norm(b);
    const out = [];
    if (A.length * B.length > 400000) {           // 超大文本退化成整段替换，避免卡死
      A.forEach(t => out.push({ type: "del", text: t }));
      B.forEach(t => out.push({ type: "add", text: t }));
      return out;
    }
    const n = A.length, m = B.length;
    const dp = new Array(n + 1);
    for (let i = 0; i <= n; i++) dp[i] = new Uint32Array(m + 1);
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--)
        dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (A[i] === B[j]) { out.push({ type: "same", text: A[i] }); i++; j++; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ type: "del", text: A[i] }); i++; }
      else { out.push({ type: "add", text: B[j] }); j++; }
    }
    while (i < n) out.push({ type: "del", text: A[i++] });
    while (j < m) out.push({ type: "add", text: B[j++] });
    return out;
  }

  function norm(t) {
    return String(t == null ? "" : t).replace(/\r\n?/g, "\n").split("\n").map(s => s.trim()).filter(Boolean);
  }

  // 差异摘要：新增/删除行数 + 前若干条差异（方便直接贴进对话）
  function diffReport(oldText, newText, opts) {
    opts = opts || {};
    const limit = opts.limit || 40;
    const rows = diffLines(oldText, newText);
    const add = rows.filter(r => r.type === "add"), del = rows.filter(r => r.type === "del");
    const head = "版本对比：" + (opts.oldLabel || "旧版") + " → " + (opts.newLabel || "新版") +
      "｜新增 " + add.length + " 行，删除 " + del.length + " 行，相同 " + rows.filter(r => r.type === "same").length + " 行";
    const body = rows.filter(r => r.type !== "same").slice(0, limit)
      .map(r => (r.type === "add" ? "+ " : "- ") + r.text);
    if (rows.filter(r => r.type !== "same").length > limit) body.push("…（共 " + rows.filter(r => r.type !== "same").length + " 处差异，只显示前 " + limit + " 处）");
    if (!body.length) body.push("两版完全一致（逐行相同）。");
    return head + "\n" + body.join("\n");
  }

  /* ── ③ 多模型改写 ───────────────────────────────────────────────────── */

  // neg: 该平台是否有「原生」负面提示词输入框（第三方转售层的参数不算）；lang: 习惯语言；limit: 常见字数上限
  const MODELS = [
    { id: "h3", name: "MiniMax H3（原样保留）", lang: "zh", neg: false, limit: 0,
      note: "H3 只认 integrated_multimodal_description / overall_soundscape / non_diegetic_music 三段壳（多参考模式为六段，主字段 detailed_description），不接受负面提示词字段，保持原样最稳。" },
    { id: "kling", name: "可灵 Kling 3.0", lang: "zh", neg: false, limit: 3072,
      note: "写法：主体＋主体运动＋场景＋镜头语言＋光影氛围；**规避项与正向写在同一个 prompt 里**（kling.ai 官方无 negative_prompt 字段，那是第三方转售层的包装）；提示词上限 3072 字符（官方建议 ≤2500）；多镜用分号串 `shot n, m, words;`（n=1~6、m=该镜秒数且 Σ 必须等于总时长、每条 ≤512 字符），且必须开启 Multi-Shot，否则只会出单镜；参考素材用 @ 名字引用（@image_1 / @Zhang）。" },
    { id: "jimeng", name: "即梦 / Seedance", lang: "zh", neg: false, limit: 2000,
      note: "写法：一句话总述＋镜头1/镜头2… 分镜，每镜写清运镜与动作落点；**没有负面词字段**，规避项要写成正文里的约束句；单镜只放一种运镜，多运镜叠加会让画面不稳。" },
    { id: "vidu", name: "Vidu / 通用中文视频模型", lang: "zh", neg: true, limit: 1500,
      note: "写法：中文自然语言长句，主体动作优先，运镜一句带过；是否支持负面词以平台文档为准。" },
    { id: "veo", name: "Google Veo 3", lang: "en", neg: true, limit: 3000,
      note: "写法：Subject / Action / Scene / Camera / Lighting / Mood / Audio 分条，英文，声音单独一段；单次时长只有 4/6/8 秒档（四家里最短），要更长必须用扩展（每次 +7 秒）；平台自带 enhance_prompt 重写开关，开了就不要再手写一遍扩写。" },
    { id: "runway", name: "Runway Gen-4 / Gen-4.5", lang: "en", neg: false, limit: 1000,
      note: "字段叫 promptText，**上限只有 1000 字符（UTF-16）**；时长整数 2–10 秒；**没有任何负面词字段**，规避项只能靠正向描述改写（如 a desolate landscape with no buildings 这种描述性写法）；视频模型**只接受首帧/尾帧图**（promptImage），没有参考图数组；多镜头走独立多镜头端点：auto 恰好 5 镜、custom 3–5 镜（每镜 ≤512 字符、各镜时长求和＝总时长，总时长 ∈ {5,10,15}）。" },
    { id: "ltx2", name: "LTX 2.5（单段散文 · 六要素 · 声音在段内）", lang: "en", neg: false, limit: 2400,
      note: "写法：把六要素（镜头／场景／动作／角色／摄影机／声音）写进**一整段现在时散文**，约 200 词，以动作开局；角色外观只写一次、与动作子句分开；摄影机运动自成一个子句；声音写进段落末尾（含 no music）；**时长／帧数／分辨率／画幅不要写进正文**（属请求参数）；一段只给一条主导动作弧（多镜要并成一条连续动作）；情绪写身体线索，不写情绪标签。" },
    { id: "sora", name: "OpenAI Sora 2", lang: "en", neg: false, limit: 0,
      note: "字段只有 prompt / input_reference / model / seconds / size：**没有负面词字段、也没有字数上限**，否定式要内联写进正文（avoid flicker / keep background）；官方推荐分节标注 prose + Cinematography:（Camera shot / Mood）+ Actions: 项目符号 + Dialogue:；**时长只能靠参数**（4/8/12/16/20，默认 4、上限 20 秒，官方明确说写进散文不会生效）；参考最多 2 个角色且必须在正文里逐字写出角色名。⚠️ 官方已公告 Sora API 于 2026-09-24 永久关停，长期适配前请先确认。" }
  ];
  const MODEL_MAP = MODELS.reduce((o, m) => (o[m.id] = m, o), {});

  // 视频专属负面词：图像负面词覆盖不到「时间维度崩坏」（变形/闪烁/身份漂移/文字漂移/时间错乱）
  const NEG_ZH = ["静止站桩", "两人对望不出手", "慢动作拖沓", "镜头晃动模糊",
    "人物变形", "画面闪烁抖动", "脸型与服装漂移", "多手多脚", "兵器穿模",
    "文字漂移", "画面扭曲", "时间错乱", "画面融化", "肢体畸形",
    "字幕", "水印", "logo", "低清", "卡通化", "塑料感皮肤"];
  const NEG_EN = ["static standoff", "staring contest", "slow motion", "shaky blurry camera",
    "morphing", "flickering", "identity drift", "extra limbs", "weapon clipping through body",
    "text drift", "warping", "temporal distortion", "melting", "deformed anatomy",
    "subtitles", "watermark", "logo", "low resolution", "cartoon", "plastic skin"];

  // 一致性锚点：跨镜不许换脸/换装/换兵器（每镜重述一次主体与兵器）
  const ANCHOR_ZH = "一致性锚点：全片锁死每个角色的脸型、发型、服装配色与兵器形制不变；每镜开头重述一次「谁＋持什么兵器」，跨镜不得换脸、换装、换武器长度。";
  const ANCHOR_EN = "Consistency anchors: keep every fighter's face, hair, costume colours and weapon shape identical across all shots; restate who is holding which weapon at the start of each shot; no identity, wardrobe or weapon-length drift between shots.";

  function negativeFor(id) {
    const m = MODEL_MAP[id];
    if (!m || !m.neg) return "";
    return m.lang === "en" ? NEG_EN.join(", ") : NEG_ZH.join("、");
  }

  // 没有原生负面词字段的平台（H3 / 可灵 / 即梦 / Runway）：把规避项写成正文里的正向约束句
  const CONSTRAINT_ZH = "画面约束：保持真实人体与兵器比例、同一张脸与同一套服装兵器贯穿全片，动作连贯可信；画面内不出现字幕、水印与文字。";
  const CONSTRAINT_EN = "Maintain consistent anatomy, face, costume and weapon throughout the take, with believable continuous action; keep the frame free of on-screen text, captions and watermarks.";
  function bodyConstraint(id) {
    const m = MODEL_MAP[id];
    if (!m || m.neg || m.id === "h3") return "";
    return m.lang === "en" ? CONSTRAINT_EN : CONSTRAINT_ZH;
  }

  // 可灵 3.0 多镜语法（官方）：`shot n, m, words;` —— n=镜号 1~6，m=该镜秒数（Σm 必须等于总时长），words ≤512 字符
  function klingMultiShot(shots, duration) {
    if (!Array.isArray(shots) || shots.length < 2 || shots.length > 6) return "";
    const total = Math.round(+duration > 0 ? +duration : (shots[shots.length - 1].end || 0));
    if (!total || total < shots.length) return "";
    const w = shots.map(s => {
      const dur = s.dur != null ? s.dur : (s.end != null && s.start != null ? s.end - s.start : 0);
      return dur > 0 ? dur : 1;
    });
    const sum = w.reduce((a, b) => a + b, 0);
    const secs = w.map(x => Math.max(1, Math.round(x / sum * total)));
    let diff = total - secs.reduce((a, b) => a + b, 0);
    for (let i = 0; diff !== 0 && i < 500; i++) {
      const k = i % secs.length;
      if (diff > 0) { secs[k]++; diff--; }
      else if (secs[k] > 1) { secs[k]--; diff++; }
    }
    if (secs.reduce((a, b) => a + b, 0) !== total) return "";
    const body = shots.map((s, i) => "shot " + (i + 1) + ", " + secs[i] + ", " +
      String(s.action || "……").replace(/[;\n\r]+/g, "，").replace(/\s+/g, " ").trim().slice(0, 512)).join("; ") + ";";
    return "【多镜语法（可灵 3.0；每镜秒数之和必须等于总时长 " + total + "s）】" + body;
  }

  // data: {cast, scene, duration, sound, shots:[{n,start,end,camera,action}], refs, style, outcome, aspect}
  // ── LTX 2.5：委托 ltx2/step2.js 的官方范式构造器（单镜头/多镜头）──────────
  function ltx2Api() {
    try {
      if (typeof module === "object" && module.exports) return require("./ltx2/step2.js");
      return (typeof window !== "undefined") ? window.LTX2 : null;
    } catch (e) { return null; }
  }
  function adaptLtx2(d) {
    d = d || {};
    const X = ltx2Api();
    const m = MODEL_MAP.ltx2;
    const shots = (d.shots || []).slice();
    const secs = d.duration != null ? +d.duration : (shots.length ? Math.max.apply(null, shots.map(x => +x.end || 0)) : 6);
    if (!X || !X.buildParagraph) {
      return { id: "ltx2", name: m.name, lang: "zh", negSupported: false, note: m.note, text: "", negative: "", length: 0,
        caveat: "缺少 ltx2/step2.js，无法按官方范式构造。", overLimit: false, limit: m.limit };
    }
    // 单镜头=官方最推荐（适合打斗）；源设计稿有 2 段以上动作时走多镜头（官方限 2~4 镜）
    const paradigm = shots.length >= 2 ? "multi" : "single";
    const r = X.buildParagraph({ shots: shots, cast: d.cast, scene: d.scene, sound: d.sound, dialogue: d.dialogue, duration: secs }, { paradigm: paradigm });
    const v = X.validate(r.text, { mode: r.paradigm });
    const reqNote = X.requestHead({ seconds: secs, size: "landscape", fps: 24, audio: true, refCount: (d.refs ? 1 : 0) });
    const verdict = "【LTX 2.5 体检】" + (v.ok ? "通过" : ("未通过 " + v.issues.filter(function (i) { return i.level === "error"; }).length + " 项"))
      + "｜约 " + v.stats.words + " 词｜段数 " + v.stats.paragraphs + "｜范式 " + (r.paradigm === "multi" ? ("多镜头（" + r.cuts + " 个切点）") : "单镜头")
      + (v.issues.length ? ("\n" + v.issues.map(function (i) { return "· " + i.code + "：" + i.msg; }).join("\n")) : "");
    return {
      id: "ltx2", name: m.name, lang: r.lang, negSupported: false,
      note: m.note + "　" + reqNote + "\n" + verdict,
      text: r.text, negative: "", length: r.text.length,
      caveat: "依据用户提供的《LTX-2.5 官方提示词完整模板规范》与公开规范实现：单镜头（4~8 句，官方最推荐，适合打斗）与多镜头（原生剪辑 2~4 镜，切点必须点名转场→重建镜头→身份一致→声明音频）；参数一律不进正文。",
      overLimit: r.text.length > m.limit, limit: m.limit
    };
  }

  function adapt(id, data) {
    if (id === "ltx2") return adaptLtx2(data);   // LTX 2.5：单段散文，独立分支
    const m = MODEL_MAP[id] || MODEL_MAP.h3;
    const d = data || {};
    const shots = (d.shots || []).slice();
    const zh = m.lang === "zh";
    const neg = negativeFor(m.id);
    const style = d.style || (zh ? "电影级硬核武打写实，实拍质感，稳定跟拍，无特效感" : "cinematic hard-hitting martial arts realism, practical fight choreography, stable tracking camera");
    const cast = d.cast || "";
    const scene = d.scene || "";
    const dur = d.duration != null ? d.duration + "s" : "";
    const anchor = zh ? ANCHOR_ZH : ANCHOR_EN;
    const refs = String(d.refs || "").trim();       // 参考图/参考锚（多参考模式才有）

    const shotZh = (s, i) => "镜头" + (s.n || i + 1) + "（" + tc(s.start) + "→" + tc(s.end) + "）：" +
      (s.camera ? "运镜 " + s.camera + "；" : "") + (s.action || "");
    const shotEn = (s, i) => "Shot " + (s.n || i + 1) + " (" + tc(s.start) + "-" + tc(s.end) + "): " +
      (s.camera ? s.camera + " camera. " : "") + (s.action || "");

    let text = "";
    if (m.id === "h3") {
      text = d.h3 || "";
      if (!text) text = zh ? "（没有原始 H3 提示词：请先生成一次成片提示词）" : "(no original H3 prompt yet)";
    } else if (m.id === "kling") {
      text = [
        "【主体】" + cast,
        "【场景】" + scene,
        "【主体运动】" + shots.map(shotZh).join("\n"),
        "【镜头语言】" + shots.map(s => "镜" + (s.n || 0) + " " + (s.camera || "跟拍")).join("；"),
        "【光影氛围】" + (d.light || "冷调侧逆光，粉尘与火星可见，地面湿润反光"),
        "【风格】" + style + (dur ? "，全程 " + dur : ""),
        "【一致性】" + anchor,
        refs ? "【参考锚】" + refs : null,
        d.sound ? "【声音】" + d.sound : null,
        klingMultiShot(shots, d.duration),
        neg ? "【负面提示词】" + neg : null
      ].filter(Boolean).join("\n");
    } else if (m.id === "jimeng") {
      text = [
        "总述：" + cast + "在" + (scene || "现场") + "展开一场" + (dur ? dur + "的" : "") + "硬派武打，" + style + "。",
        shots.map(shotZh).join("\n"),
        "运镜与节奏：整体稳定跟拍 + 命中瞬间急推，禁止随意切镜与镜头抖动。",
        "一致性：" + anchor,
        d.sound ? "声音：" + d.sound : null,
        neg ? "负面提示词：" + neg : null
      ].filter(Boolean).join("\n");
    } else if (m.id === "vidu") {
      text = cast + "在" + (scene || "现场") + "激烈交手，" + shots.map(s => (s.action || "")).filter(Boolean).join("；") +
        "。镜头以" + ((shots[0] && shots[0].camera) || "稳定跟拍") + "为主，画面" + style + "。" + anchor;
      if (neg) text += "\n负面：" + neg;
    } else if (m.id === "veo") {
      text = [
        "Subject: " + (cast || "two martial artists"),
        "Action: " + shots.map(shotEn).join(" "),
        "Scene: " + (scene || "a rain-slick courtyard at night") + (dur ? ". Duration " + dur + "." : ""),
        "Camera: " + shots.map(s => (s.camera || "tracking") + (s.start != null ? " at " + tc(s.start) : "")).join(", "),
        "Lighting: " + (d.lightEn || "cold rim light, wet ground reflections, dust and sparks in the air"),
        "Mood: tense, physical, percussive",
        "Style: " + style,
        "Continuity: " + anchor,
        d.sound ? "Audio: " + d.sound : null,
        neg ? "Negative prompt: " + neg : null
      ].filter(Boolean).join("\n");
    } else if (m.id === "runway") {
      text = "A cinematic " + ((shots[0] && shots[0].camera) || "tracking") + " shot of " + (cast || "two fighters") +
        " exchanging blows in " + (scene || "a night courtyard") + ". " +
        (shots[0] ? (shots[0].action || "") : "") + " " + style + ". " +
        "Practical choreography, one continuous move, steady camera.";
    } else if (m.id === "sora") {
      // 官方推荐分节：散文 + Cinematography: + Actions: 项目符号 + Dialogue:
      text = [
        (cast || "Two martial artists") + " fight in " + (scene || "a rain-soaked courtyard at night") + ". " + style + ".",
        shots.map(shotEn).join("\n"),
        "Cinematography:",
        "Camera shot: " + shots.map(s => s.camera || "tracking").join(", ") + ".",
        "Mood: tense, physical, percussive; cold rim light, wet ground reflections, dust and sparks in the air.",
        "Actions:",
        shots.map((s, i) => "- " + ((s.start != null ? tc(s.start) + "–" : "") + (s.action || ""))).join("\n"),
        "Dialogue: (none — the fight carries the scene)",
        "Continuity: " + anchor,
        [dur ? "Duration " + dur + " (set it with the seconds parameter, not in prose)" : null, d.aspect || "16:9"].filter(Boolean).join(" · "),
        neg ? "Avoid: " + neg : null
      ].filter(Boolean).join("\n");
    }

    // 没有原生负面词栏的平台：把规避项作为正文约束句追加进去（H3 原样输出，不动）
    const bc = bodyConstraint(m.id);
    if (bc) text = text.replace(/\s+$/, "") + "\n" + (zh ? "【画面约束】" : "") + bc;
    const len2 = text.length;
    return {
      id: m.id, name: m.name, lang: m.lang, negSupported: m.neg, note: m.note,
      text: text, negative: neg, length: len2,
      caveat: "各平台的字段名与字数上限按常见做法整理，未逐条对照官网；以平台当前文档为准。",
      overLimit: !!(m.limit && len2 > m.limit),
      limit: m.limit
    };
  }

  function tc(v) {
    if (v == null || isNaN(v)) return "?";
    const s = Math.max(0, +v);
    const mm = Math.floor(s / 60), ss = s - mm * 60;
    return (mm ? mm + ":" + (ss < 10 ? "0" : "") : "") + ss.toFixed(1) + "s";
  }

  /* ── ⑤ 交付前自检清单（附在分镜表后面，导出即带质检结论）──────────── */

  const DELIVERY_ITEMS = [
    "结构：三个核心字段齐全，[Shot N] 分镜在 4~6 个之间。",
    "时间：时间码逐镜递增，最后一镜结束正好等于片长。",
    "开场：0.3 秒内出第一个有效动作，没有对峙空镜。",
    "双人：每一镜都点名双方，谁出招、谁格挡/闪避/受击。",
    "受力：每个命中都有接触点＋材质变化＋位移结果，不用空泛强度词。",
    "物理：腾空/悬停有借力依据（蹬墙/踏檐/借栏/击飞），没有瞬移。",
    "声音：按材质写，徒手不出现金属声，慢动作不超过 1~2 处。",
    "一致性：跨镜不换脸、不换装、不换兵器；多参考模式带 retention_analysis 逐条锁保留项。",
    "安全与长度：无血腥直述，正文不出现否定式，长度不超过平台上限。"
  ];

  // ctx: {grade, score, dims:[{zh,level}], items:[{level,msg}], extra:[string]}
  function deliveryChecklist(ctx) {
    ctx = ctx || {};
    const dims = ctx.dims || [];
    const mark = { ok: "✓", info: "·", warn: "!", error: "✗" };
    const bad = dims.filter(d => d.level === "error" || d.level === "warn").map(d => d.zh);
    const head = "## 交付前自检（本地体检" +
      (ctx.grade ? " " + ctx.grade + " " + ctx.score + "/100" : "") + "）";
    const dimLine = dims.length
      ? "七维：" + dims.map(d => (mark[d.level] || "?") + d.zh).join("  ") +
        (bad.length ? "　→ 优先修改：" + bad.join("、") : "　→ 七维没有必改/建议项")
      : "";
    const problems = (ctx.items || []).filter(i => i.level === "error" || i.level === "warn")
      .slice(0, 8).map(i => "- " + (i.level === "error" ? "✗ " : "! ") + i.msg);
    return [head, "", dimLine, dimLine ? "" : null,
      "逐条核对：",
      DELIVERY_ITEMS.map(s => "- [ ] " + s).join("\n"),
      problems.length ? "\n体检发现待改项：" : null,
      problems.length ? problems.join("\n") : null,
      (ctx.extra || []).length ? "\n" + ctx.extra.join("\n") : null,
      ""
    ].filter(x => x !== null).join("\n");
  }

  // 把最终 H3 提示词直接拆成分镜数据（给 adapt 用）
  function shotsFromPoll(text) {
    return parseShots(text).map(r => ({ n: r.n, start: r.start, end: r.end, camera: r.camera, action: r.action }));
  }

  /* ── ④ SKILL 包：把两步提示词 + 硬规则打成一只能喂给别的 AI 的 .md ──── */

  const FLOOR_RULES = [
    "0.3 秒内起手，1.5 秒内首次接触，禁止开局站桩对望。",
    "每镜只承担一个任务，禁止一镜塞完整套连招。",
    "每次交锋必须改变位置或攻守关系；接触部位不许整段重复。",
    "受力分级：震退 < 踉跄 < 失衡 < 失战；不许所有命中都写成同一种「重重一拳」。",
    "声音按材质写：金属相击、闷响、衣料摩擦、脚步溅水；徒手不许出现金属声。",
    "平台安全：不写喷血、断肢、致命伤；用震退、化解、衣袂破损、重心崩溃替代。",
    "负面要求不写进正文；H3 / Runway 只用正面描述。"
  ];

  // p: {version, step1, t2v, ref2va, rules:"a\nb", app, when}
  function skillPack(p) {
    p = p || {};
    const rules = String(p.rules || "").replace(/\r\n?/g, "\n").split("\n").map(s => s.trim()).filter(Boolean)
      .map(s => "- " + s.replace(/^[-*·\d.、)\s]+/, ""));
    const now = p.when || new Date().toISOString().slice(0, 19).replace("T", " ");
    return [
      "# 武打视频提示词 SKILL" + (p.app ? "（" + p.app + " 导出）" : ""),
      "",
      "- 版本：" + (p.version || "未标注"),
      "- 导出时间：" + now,
      "- 适用：MINIMAX H3 文生视频（T2VA）/ 多参考图（Ref2VA）；第1步的设计方法同样适用于可灵、即梦、Veo、Runway、Sora。",
      "",
      "## 怎么用（三步）",
      "1. 先把「事实」准备好：谁打谁、兵器、场地、时长、结局。事实不清就先定事实，别让模型编故事。",
      "2. **第1步**：把第 1 节整段当系统提示词，把战斗事实交给模型，让它当动作导演写出电影级打斗设计稿（**不套 H3 格式**）。",
      "3. **第2步**：把第 2 节对应那套（T2VA 或 Ref2VA）当系统提示词，把第1步的设计稿丢进去，只做格式整理，不新增要求、不改内容。",
      "",
      "输出检查：用本程序的「提示词体检」，或对照第 3、4 节的硬规则逐条核对。",
      "",
      "## 1. 第1步系统提示词 · 电影级动作导演",
      "",
      "```text",
      String(p.step1 || "").trim(),
      "```",
      "",
      "## 2. 第2步系统提示词 · 格式整理（只留壳）",
      "",
      "### 2.1 文生视频 T2VA",
      "",
      "```text",
      String(p.t2v || "").trim(),
      "```",
      "",
      "### 2.2 多参考图 Ref2VA",
      "",
      "```text",
      String(p.ref2va || "").trim(),
      "```",
      "",
      "## 3. 润色硬规则（全部在第1步生效）",
      "",
      rules.length ? rules.join("\n") : "（未单独设置：硬规则已内置在第 1 节提示词里。）",
      "",
      "## 4. 落地红线（来自打斗词汇库）",
      "",
      FLOOR_RULES.map(s => "- " + s).join("\n"),
      ""
    ].join("\n");
  }

  /* ── ⑥ wushu_h3_v2 LoRA（动作本体）：词库 + 两种用法 + 检查器 ─────────
     依据《wushu_h3_v2 LoRA 使用指南》：训练集 1668 段全部是「无贴图男性人体模型
     三视图 + 纯黑虚空」的战斗动画，学的是纯动作与发力，不是画面质感。           */

  const LORA = {
    name: "wushu_h3_v2",
    snapshot: "wushu_h3_v2_000002000.safetensors",
    trigger: "wushu_action",
    baseFile: "minimax_h3_fl2va_int8_convrot.safetensors",
    baseNote: "必须是 fl2va 底模（训练模式就是 fl2va）；ref2va 底模不匹配",
    trainedMode: "fl2va",
    network: "dim 32 / alpha 32",
    steps: 5000,
    trainedRes: "960×360",
    trainedFps: 30,
    targetFrames: [39, 90],
    trainedSeconds: "1.3–3.0 秒（39~90 帧 @30fps）",
    singlePerson: true,
    params: { sampler: "euler", scheduler: "simple", steps: 25, cfg: 1.0, denoise: 1.0,
      width: 832, height: 480, frames: 124, fps: 24,
      framesRule: "帧数必须满足 17n+5（22/39/56/73/90/107/124/175…）",
      resRule: "宽高必须是 32 的倍数" },
    qualityNeg: "blurry, distorted, low quality, jittery motion, extra limbs, deformed hands, morphing bodies, inconsistent lighting, flickering, static pose, frozen motion",
    strength: { mannequin: "0.9–1.0", normal: "0.7", soften: "0.5–0.6", stronger: "1.0–1.1" }
  };

  // 训练集里真实出现过的招式词（n = 出现次数，来自 1668 条 caption 的实际统计）。
  // 用这些词的命中率远高于自造词；avoid=true 的是泛化占位词，建议换具体招式。
  const LORA_MOVES = [
    { zh: "连续连招", en: "chains a combo sequence", n: 239, cat: "组合" },
    { zh: "稳步前进", en: "steps forward steadily", n: 108, cat: "步法" },
    { zh: "疾步冲刺", en: "dashes forward", n: 79, cat: "步法" },
    { zh: "踉跄后退", en: "staggers backwards", n: 69, cat: "受击" },
    { zh: "腾空跃起", en: "leaps into the air", n: 67, cat: "空中" },
    { zh: "举盾格挡", en: "raises a shield to block", n: 54, cat: "防御" },
    { zh: "突刺贯穿", en: "thrusts forward", n: 50, cat: "长兵" },
    { zh: "呼吸站姿微动", en: "breathes in a ready stance", n: 41, cat: "节奏" },
    { zh: "蹬地打直拳", en: "drives a straight punch", n: 37, cat: "拳法" },
    { zh: "横斩劈砍", en: "slashes horizontally", n: 35, cat: "刀剑" },
    { zh: "高侧踢", en: "high side kick", n: 24, cat: "腿法" },
    { zh: "侧闪回避", en: "sidesteps to evade", n: 24, cat: "防御" },
    { zh: "双持交叉斩", en: "cross-slashes with two weapons", n: 10, cat: "刀剑" },
    { zh: "转棍扫击", en: "spins the staff in a sweep", n: 10, cat: "棍棒" },
    { zh: "提膝撞击", en: "drives a knee strike", n: 8, cat: "腿法" },
    { zh: "失衡踉跄", en: "loses balance and staggers", n: 7, cat: "受击" },
    { zh: "转身换向", en: "turns and shifts direction", n: 7, cat: "步法" },
    { zh: "过肩摔投", en: "shoulder throw", n: 7, cat: "摔投" },
    { zh: "横扫", en: "horizontal sweep", n: 7, cat: "刀剑" },
    { zh: "后手横拳", en: "rear-hand hook punch", n: 6, cat: "拳法" },
    { zh: "上勾拳", en: "uppercut", n: 5, cat: "拳法" },
    { zh: "抡臂横勾", en: "windmill hook", n: 4, cat: "拳法" },
    { zh: "下蹲低姿", en: "drops into a low crouch", n: 4, cat: "步法" },
    { zh: "反弓跌落", en: "falls backwards", n: 4, cat: "受击" },
    { zh: "团身翻滚", en: "tucks and rolls", n: 4, cat: "受击" },
    { zh: "侧身格挡反击", en: "blocks sideways then counters", n: 3, cat: "防御" },
    { zh: "锁颌下坠", en: "locks the jaw and drags down", n: 3, cat: "摔投" },
    { zh: "举弩瞄准", en: "aims the crossbow", n: 3, cat: "远程" },
    { zh: "脚踏上弦装填", en: "cranks and loads the crossbow", n: 3, cat: "远程" },
    { zh: "松手放箭", en: "releases the bolt", n: 3, cat: "远程" },
    { zh: "战斗动作", en: "combat action", n: 232, cat: "泛化", avoid: true }
  ];

  // 物理反馈词：训练模板的一部分，参与塑造动作质量，用 LoRA 时不要删
  const LORA_PHYS = {
    zh: ["实时爆发力", "全身发力传导", "无慢动作", "无停顿"],
    en: ["explosive real-time force", "force transmission through whole body", "no slow motion", "no pause"]
  };

  function loraMoveList(includeGeneric) {
    return LORA_MOVES.filter(m => includeGeneric || !m.avoid).map(m => ({ ...m }));
  }
  function loraMoveByZh(zh) { return LORA_MOVES.find(m => m.zh === zh) || null; }

  // 帧数网格：H3 只接受 17n+5
  function framesGrid(max) {
    const out = [];
    for (let k = 1; 17 * k + 5 <= (max || 200); k++) out.push(17 * k + 5);
    return out;
  }
  function nearestFrames(n) {
    const k = Math.max(1, Math.round(((+n || 0) - 5) / 17));
    return 17 * k + 5;
  }
  function framesOk(n) { return (((+n || 0) - 5) % 17 === 0) && (+n > 5); }

  // 用法 A：复现训练分布（三视图人体模型 + 纯黑虚空）——动作最准，画面就是 mannequin
  function loraMannequin(moves) {
    const zh = moves.map(m => m.zh).join("、"), en = moves.map(m => m.en).join(", ");
    return [
      LORA.trigger, "白色无贴图男性人体模型", "white untextured male mannequin",
      "同一角色三视图同步并排 (左+正+右)", "three orthographic views of the same character side by side",
      "纯黑虚空", "pure black void", "固定全身机位", "fixed full-body cameras",
      "动作完全同步", "identical synchronized motion", "不是三个战士", "not three fighters.",
      zh + ", " + en,
      LORA_PHYS.zh[0], LORA_PHYS.en[0], LORA_PHYS.zh[1], LORA_PHYS.en[1],
      LORA_PHYS.zh[2], LORA_PHYS.en[2], LORA_PHYS.zh[3], LORA_PHYS.en[3] + "."
    ].join(", ");
  }

  // 用法 B：借动作做正常画面——必须主动写主体与场景，否则模型按训练分布补成人体模型
  function loraScene(opts) {
    const o = opts || {};
    const moves = o.moves || [];
    const zh = moves.map(m => m.zh).join("、"), en = moves.map(m => m.en).join(", ");
    const parts = [LORA.trigger, o.subject || ""];
    if (zh) parts.push(zh);
    if (en) parts.push(en);
    parts.push(LORA_PHYS.zh[0], LORA_PHYS.en[0].replace("whole body", "body"), LORA_PHYS.zh[1], LORA_PHYS.en[1].replace("whole body", "body"));
    parts.push(LORA_PHYS.zh[2], LORA_PHYS.en[2], LORA_PHYS.zh[3], LORA_PHYS.en[3]);
    parts.push(o.scene || "", o.camera || "medium shot, stable camera");
    if (o.extra) parts.push(o.extra);
    return parts.filter(Boolean).join(", ");
  }

  // opts: {mode:'A'|'B', moves:[{zh,en}|"招式中文"], subject, scene, camera, extra}
  function loraPrompt(opts) {
    const o = opts || {};
    const raw = o.moves || [];
    const moves = raw.map(m => typeof m === "string" ? (loraMoveByZh(m) || { zh: m, en: "" }) : m)
      .filter(m => m && m.zh && !m.avoid);
    const mode = String(o.mode || "B").toUpperCase() === "A" ? "A" : "B";
    const text = mode === "A" ? loraMannequin(moves) : loraScene({ ...o, moves });
    return {
      mode, name: LORA.name, trigger: LORA.trigger, baseFile: LORA.baseFile,
      text,
      strength: mode === "A" ? LORA.strength.mannequin : (o.strength || LORA.strength.normal),
      negatives: LORA.qualityNeg,
      params: { ...LORA.params },
      note: mode === "A"
        ? "用法 A：复现训练分布，动作最准，画面必然是白色人体模型三视图 + 纯黑虚空（设计使然，不是 bug）。"
        : "用法 B：借动作做正常画面——主体与场景一定要自己写出来，并把强度降到 0.6~0.8；没写主体/场景时模型会按训练分布补成人体模型 + 黑底。",
      caveat: "用法 B 的实际出片效果未实测（训练机无 ComfyUI）；建议第一轮先测 0.6 / 0.8 / 1.0 三档。双人对打属外推（训练集全为单人）。"
    };
  }

  // LoRA 提示词体检（本地规则）
  function loraCheck(text, opts) {
    opts = opts || {};
    const t = String(text || "");
    const items = [];
    const add = (level, id, msg, hint) => items.push({ id, level, msg, hint: hint || "" });
    // 1. 触发词必须在最前面
    if (!t.trim().length) add("error", "lora-empty", "提示词是空的", "先选用法与招式再生成。");
    else if (!new RegExp("^\\s*" + LORA.trigger + "\\b", "i").test(t))
      add("error", "lora-trigger", "触发词 " + LORA.trigger + " 不在开头", "训练集 1668 条 caption 全部以它开头，必须放在最前面，写在结尾基本不生效。");
    // 2. 泛化占位词
    if (/战斗动作|combat action/.test(t))
      add("warn", "lora-generic", "用了泛化词「战斗动作 / combat action」", "这是训练集里的占位词（232 条），换成具体招式命中率更高，例如 「蹬地打直拳」「高侧踢」「突刺贯穿」。");
    // 3. 物理反馈词（参与塑造动作质量）
    const missPh = LORA_PHYS.zh.filter(w => !t.includes(w));
    if (missPh.length) add("warn", "lora-physical", "缺少物理反馈词：" + missPh.join("、"), "实时爆发力 / 全身发力传导 / 无慢动作 / 无停顿 是训练模板的一部分，删了动作容易软、容易出慢动作。");
    // 4. 用法 B 必须自己写主体与场景
    if (opts.mode !== "A") {
      if (!/人体模型|mannequin/i.test(t)) {
        const hasSubject = /robe|uniform|fighter|martial artist|warrior|人物|武者|侠|剑客|拳手|刀客/.test(t);
        const hasScene = /hall|dojo|courtyard|grove|street|temple|room|field|hall|室内|庭院|竹林|长街|祠堂|擂台|山|桥|雪|雨/.test(t);
        if (!hasSubject) add("warn", "lora-subject", "没写主体（人物是什么样）", "用法 B 必须主动写主体，否则模型按训练分布补成「无贴图人体模型」。");
        if (!hasScene) add("warn", "lora-scene", "没写场景", "补上环境与景别（如 indoor dojo with wooden floor, medium shot, stable camera）。");
      }
    }
    // 5. 别混用 v7 的分镜 caption 结构
    if (/\[Shot\s*\d+\]/i.test(t)) add("warn", "lora-v7-mix", "出现了 [Shot N] 分镜标记", "v2 训练集没见过 v7 的三段式分镜 caption，混用效果不可控；要分镜请用 v7 或本程序生成的 H3 壳。");
    // 6. 帧数与分辨率
    if (opts.frames != null && !framesOk(opts.frames)) add("warn", "lora-frames", "帧数 " + opts.frames + " 不在 17n+5 网格上", "改用 " + nearestFrames(opts.frames) + "（同一网格：22/39/56/73/90/107/124/175…）。");
    if (opts.width && (opts.width % 32 || opts.height % 32)) add("warn", "lora-res", "宽高不是 32 的倍数", "832×480 最稳；竖屏用 480×832。");
    // 7. 时长超出训练分布
    const sec = +opts.seconds || 0;
    if (sec > 3.2) add("info", "lora-length", "片长 " + sec.toFixed(1) + " 秒，超出训练分布（1.3~3.0 秒）", "长片建议分段生成再剪；单段越短越像训练分布。");
    // 8. 双人属外推
    if (/two fighters|两人|双人|双方/.test(t)) add("info", "lora-two", "写了双人对打", "本 LoRA 训练集全部是单人三视图，双人属外推；双人建议用 v7 或配多参 Ref2VA。");
    const w = { error: 15, warn: 5, info: 1 };
    let score = 100;
    items.forEach(it => { score -= (w[it.level] || 0); });
    score = Math.max(0, Math.min(100, score));
    return { version: VERSION, score, grade: score >= 90 ? "A" : score >= 75 ? "B" : score >= 60 ? "C" : "D", items };
  }
  function loraReport(res) {
    const lv = { error: "✗ 必改", warn: "! 建议", info: "· 提示" };
    const lines = ["LoRA 提示词体检 " + res.grade + "（" + res.score + "/100）"];
    res.items.forEach(it => lines.push((lv[it.level] || it.level) + "  " + it.msg + (it.hint ? "\n      → " + it.hint : "")));
    if (!res.items.length) lines.push("没有发现问题：触发词、招式词、物理反馈词、主体与场景都齐。");
    return lines.join("\n");
  }

  return {
    VERSION, MODELS, MODEL_MAP,
    LORA, LORA_MOVES, LORA_PHYS, loraMoveList, loraPrompt, loraCheck, loraReport,
    framesGrid, nearestFrames, framesOk,
    parseShots, shotTableMd, shotTableCsv, shotStats,
    diffLines, diffReport,
    adapt, negativeFor, bodyConstraint, klingMultiShot, shotsFromPoll, tc,
    skillPack, FLOOR_RULES, deliveryChecklist, DELIVERY_ITEMS,
    NEG_ZH, NEG_EN, ANCHOR_ZH, ANCHOR_EN
  };
});
