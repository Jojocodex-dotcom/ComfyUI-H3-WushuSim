/* ============================================================================
 * drama/one-line.js — 文戏「一句话设定 → 生成情景与角色」（Node 可测）
 * ----------------------------------------------------------------------------
 * 用法：用户写一句话（例：沈砚与柳明砚在祠堂对峙，为一件谁都不肯先提的旧事），
 *   交给 AI 拆成「情景 + 关系 + 角色A/B」；本模块负责规范提示词、容错解析、
 *   字段校验与中文标签→内部 key 的映射，并把结果整理成可直接写进表单的计划。
 * 约束（与项目既有约定一致）：
 *   · 只出设定（地点/天气/温度/冲突主题/氛围/关系四轴/角色卡字段），不写台词、不写分镜；
 *   · 不给内部 key 之外的选项；数值一律夹到合法区间；
 *   · AI 不可用时用本地兜底（从句子拆名字 + 默认情景），并明确标注是兜底。
 * ========================================================================== */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.DRAMA_ONE_LINE = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  const VERSION = "drama-one-line-0.1";

  // 选项表（key → 中文标签）；与 drama/ui.js 的 OPT 保持一致
  const MODE = { duel: "双人对峙", group: "群戏（三人以上）", monologue: "独白·内心戏", daily: "日常铺陈", hybrid: "文武混合（先谈后打）" };
  const PLACE = { ancestral_hall: "祠堂", teahouse: "茶馆", inn_room: "客栈房间", temple: "破庙", street_rain: "雨夜长街", bridge: "江桥", cliff: "山道崖边", hall_mansion: "大宅正厅", kitchen: "灶房" };
  const WEATHER = { rain: "中雨", drizzle: "细雨", storm: "暴雨", snow: "落雪", fog: "浓雾", night: "夜", dusk: "黄昏", dawn: "破晓", day: "白天" };
  const STYLE = { berserk: "嗜血狂杀", calm: "冷静稳健", guardian: "铁壁如山", swift: "疾风迅雷", power: "力压千钧", tactician: "老谋深算", hunter: "一击必杀", cool: "冷面寒刀" };
  const WEAPON = { none: "空手", jian: "剑", dao: "刀", nodachi: "太刀", duanren: "短刃", gun: "棍", bang: "棒", qiang: "枪", pu: "朴刀", duangun: "短棍" };

  const FIELDS = {
    A: ["name", "style", "weapon", "tier", "tone", "accent", "goal", "secret", "stake", "tics", "taboo", "habit"],
    B: ["name", "style", "weapon", "tier", "tone", "accent", "goal", "secret", "stake", "tics", "taboo", "habit"]
  };

  function SYS() {
    return [
      "【任务】把用户的一句话设定拆成一场「文戏」的**情景**与**角色**，只输出设定，不要写台词、不要写分镜、不要写动作设计。",
      "",
      "【只输出 JSON，不要任何解释与 markdown 代码块】",
      "{",
      '  "mode": "duel|group|monologue|daily|hybrid",',
      '  "duration": 20-120 的整数（默认 48）,',
      '  "place": "ancestral_hall|teahouse|inn_room|temple|street_rain|bridge|cliff|hall_mansion|kitchen",',
      '  "weather": "rain|drizzle|storm|snow|fog|night|dusk|dawn|day",',
      '  "temp": 数字（摄氏，默认 16）,',
      '  "topic": "这一场争的是什么（一句话，具体，不抽象）",',
      '  "atmosphere": "额外氛围要求（一句，可空）",',
      '  "rel": { "trust": 0~1, "hostility": 0~1, "power": -1~1 },',
      '  "A": { "name": "姓名", "style": "berserk|calm|guardian|swift|power|tactician|hunter|cool", "weapon": "none|jian|dao|nodachi|duanren|gun|bang|qiang|pu|duangun", "tier": 1-9, "tone": "音色（可空）", "accent": "口音或语速（可空）", "goal": "他要什么", "secret": "不可直说的隐情（可空）", "stake": "输不起什么（可空）", "tics": "口癖，顿号分隔（可空）", "taboo": "禁忌话题，顿号分隔（可空）", "habit": "习惯小动作，顿号分隔（可空）" },',
      '  "B": { 同上 },',
      '  "C": { 仅在 mode=group 时给第三个人，否则省略 }',
      "}",
      "",
      "【硬要求】",
      "1. mode/place/weather/style/weapon **只能填上面列出的英文 key**，不要填中文。",
      "2. 名字与目标要贴合句子里的身份与地点；没写名字时给一个符合语境的姓名。",
      "3. 隐情、赌注必须与 topic 咬合（他是为了什么才不肯说）。",
      "4. 冲突主题要具体到「一件什么事」，不要写「感情纠葛」这种空话。",
      "5. 关系数值按句子语气给：还留情面 trust 高；表面客气 hostility 中高；一方明显压着另一方 power 给正负。",
      "6. 只输出 JSON 本体。"
    ].join("\n");
  }

  /** 容错解析：剥掉 ```json 围栏、取第一个完整 JSON 对象 */
  function parse(text) {
    let t = String(text == null ? "" : text).trim();
    t = t.replace(/^```[a-zA-Z]*\s*/, "").replace(/```\s*$/, "").trim();
    const i = t.indexOf("{"), j = t.lastIndexOf("}");
    if (i >= 0 && j > i) t = t.slice(i, j + 1);
    try { return JSON.parse(t); } catch (e) { return null; }
  }

  const clamp = (v, lo, hi, dflt) => {
    const n = Number(v);
    if (!isFinite(n)) return dflt;
    return Math.max(lo, Math.min(hi, n));
  };
  const pickKey = (map, v, dflt) => {
    const s = String(v == null ? "" : v).trim();
    if (!s) return dflt;
    if (map[s]) return s;                                     // 已是 key
    const hit = Object.keys(map).find(k => map[k] === s);      // 中文标签
    return hit || dflt;
  };
  const clean = (v, max) => String(v == null ? "" : v).replace(/\s+/g, " ").trim().slice(0, max || 60);

  /** 规范化：夹区间、映射 key、剔除未知字段；返回 {plan, wrote} */
  function normalize(obj) {
    const o = (obj && typeof obj === "object") ? obj : {};
    const plan = {};
    const wrote = [];
    const put = (label) => wrote.push(label);

    if (o.mode != null) { plan.mode = pickKey(MODE, o.mode, "duel"); put("模式"); }
    if (o.duration != null) { plan.duration = Math.round(clamp(o.duration, 20, 120, 48)); put("时长"); }
    if (o.place != null) { plan.place = pickKey(PLACE, o.place, "ancestral_hall"); put("地点"); }
    if (o.weather != null) { plan.weather = pickKey(WEATHER, o.weather, "rain"); put("天气"); }
    if (o.temp != null) { plan.temp = Math.round(clamp(o.temp, -20, 45, 16)); put("温度"); }
    if (o.topic != null && clean(o.topic)) { plan.topic = clean(o.topic, 80); put("冲突主题"); }
    if (o.atmosphere != null && clean(o.atmosphere)) { plan.atmosphere = clean(o.atmosphere, 80); put("氛围"); }
    if (o.rel && typeof o.rel === "object") {
      plan.rel = {
        trust: +clamp(o.rel.trust, 0, 1, 0.4).toFixed(2),
        hostility: +clamp(o.rel.hostility, 0, 1, 0.3).toFixed(2),
        power: +clamp(o.rel.power, -1, 1, 0).toFixed(2)
      };
      put("关系四轴");
    }
    ["A", "B", "C"].forEach(who => {
      const src = o[who];
      if (!src || typeof src !== "object") return;
      if (who === "C" && pickKey(MODE, o.mode || "duel", "duel") !== "group") return;   // 第三个人只在群戏
      const c = {};
      if (clean(src.name)) c.name = clean(src.name, 24);
      if (src.style != null) c.style = pickKey(STYLE, src.style, "calm");
      if (src.weapon != null) c.weapon = pickKey(WEAPON, src.weapon, "none");
      if (src.tier != null) c.tier = Math.round(clamp(src.tier, 1, 9, 3));
      if (clean(src.tone)) c.tone = clean(src.tone, 24);
      if (clean(src.accent)) c.accent = clean(src.accent, 24);
      if (clean(src.goal)) c.goal = clean(src.goal, 80);
      if (clean(src.secret)) c.secret = clean(src.secret, 80);
      if (clean(src.stake)) c.stake = clean(src.stake, 80);
      if (clean(src.tics)) c.tics = clean(src.tics, 60);
      if (clean(src.taboo)) c.taboo = clean(src.taboo, 60);
      if (clean(src.habit)) c.habit = clean(src.habit, 60);
      plan[who] = c;
      put("角色" + who);
    });
    return { plan: plan, wrote: wrote, ok: wrote.length > 0 };
  }

  /** 本地兜底：从一句话里拆名字与主题（AI 不可用时用） */
  function fallback(sentence) {
    const s = String(sentence || "").trim();
    const names = [];
    // 「甲与乙」「甲和乙」「甲 vs 乙」「甲、乙」在…的语境里取前两个名字
    const GROUP_WORDS = /们|众|大家|长老|族老|群|一屋子|族人|几位|若干/;
    const sep = s.split(/与|和|、|VS|vs|对上|对峙|面对|之间/).map(x => x.trim()).filter(Boolean);
    const grab = (seg) => {
      const m = seg.match(/^([\u4e00-\u9fff]{2,4})(?=[，,。；;\s在是说要]|$)/);
      if (!m) return "";
      const nm = m[1];
      // 群体词/称谓不是姓名
      if (GROUP_WORDS.test(nm) || /^(父亲|母亲|师父|师叔|叔父|兄长|姐姐|弟弟|掌柜|老板|老爷|夫人|大人|官人|村人|族人|族老|长老)$/.test(nm)) return "";
      return nm;
    };
    sep.forEach(seg => { const n = grab(seg); if (n && names.indexOf(n) < 0 && names.length < 2) names.push(n); });
    const placeHit = Object.keys(PLACE).find(k => s.indexOf(PLACE[k]) >= 0);
    const weatherHit = Object.keys(WEATHER).find(k => s.indexOf(WEATHER[k]) >= 0);
    const obj = {
      mode: GROUP_WORDS.test(s) || /三人|一屋子|一桌人|众人/.test(s) ? "group" : (s.indexOf("独白") >= 0 ? "monologue" : "duel"),
      place: placeHit || "ancestral_hall",
      weather: weatherHit || "rain",
      topic: s ? s.slice(0, 60) : "一件谁都不肯先提的旧事",
      A: { name: names[0] || "沈砚" }, B: { name: names[1] || "柳明砚" }
    };
    const r = normalize(obj);
    r.fallback = true;
    return r;
  }

  /** 把计划写成「人话摘要」，用于状态栏 */
  function summarize(res) {
    if (!res || !res.plan) return "没有可写入的内容";
    const p = res.plan;
    const bits = [];
    if (p.place) bits.push("地点 " + (PLACE[p.place] || p.place));
    if (p.weather) bits.push("天气 " + (WEATHER[p.weather] || p.weather));
    if (p.topic) bits.push("主题「" + p.topic + "」");
    const names = ["A", "B", "C"].map(w => (p[w] && p[w].name) || "").filter(Boolean);
    if (names.length) bits.push("角色 " + names.join(" / "));
    if (p.rel) bits.push("关系 信任" + p.rel.trust + "／敌意" + p.rel.hostility + "／势能" + p.rel.power);
    return (res.fallback ? "（本地兜底）" : "") + bits.join("，");
  }

  return { VERSION, MODE, PLACE, WEATHER, STYLE, WEAPON, FIELDS, SYS, parse, normalize, fallback, summarize, pickKey, clamp };
});
