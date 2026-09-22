/* ============================================================================
 * drama/engine.js — 文戏内核（确定性 · Node 可测）
 * ----------------------------------------------------------------------------
 * 与武打内核同构：把"情感、氛围、台词交锋"变成可模拟、可复算、可复现的量。
 *
 *   武打内核                      文戏内核
 *   ─────────────────────────    ─────────────────────────────────────────
 *   位置/朝向/速度                情绪十条（怒惧悲喜惊羞愧疚怜蔑爱）＋关系四轴
 *   招式帧数据（起手/判定/收招）   戏剧动作帧数据（试探/追问/回避/揭露/爆发…）
 *   几何接触判定                  阈值判定（压力 vs 耐受 → 戳中/被挡/反噬/崩防）
 *   体力/硬直                     情绪耐受度 ＋ 社交体力
 *   终结 KO                       结局（和解/决裂/僵持/妥协/揭露/第三方介入）
 *   12 种性格权重                 沟通风格（复用同一套性格 key）
 *
 * 输出：拍级"素材"（意图＋潜台词＋情绪＋身体线索＋环境互动＋结局），
 *       并按 H3 单镜 4~15s 切成 3~6 镜（每镜给机位职责与声音方案）。
 *       台词文本不在这里写 —— 交给第1步 AI（用户既定分工）。
 * ========================================================================== */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.DRAMA = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const VERSION = "drama-0.1";

  // ── 情绪十条 ─────────────────────────────────────────────────────────
  const EMOTIONS = ["anger", "fear", "sadness", "joy", "surprise", "shame", "guilt", "pity", "contempt", "love"];
  const EMO_ZH = { anger: "怒", fear: "惧", sadness: "悲", joy: "喜", surprise: "惊", shame: "羞", guilt: "愧", pity: "怜", contempt: "蔑", love: "爱" };

  // ── 沟通风格（与界面 8 种性格 key 完全一致，同一张角色卡两用）──────────
  const STYLES = {
    berserk:   { zh: "咄咄逼人", press: 0.90, evade: 0.05, reveal: 0.25, concede: 0.05, tolerate: 0.35, burst: 0.95, blunt: 0.90 },
    calm:      { zh: "冷静克制", press: 0.45, evade: 0.30, reveal: 0.30, concede: 0.30, tolerate: 0.80, burst: 0.25, blunt: 0.40 },
    guardian:  { zh: "守口如瓶", press: 0.25, evade: 0.85, reveal: 0.10, concede: 0.25, tolerate: 0.90, burst: 0.20, blunt: 0.30 },
    swift:     { zh: "话锋跳跃", press: 0.50, evade: 0.70, reveal: 0.30, concede: 0.30, tolerate: 0.50, burst: 0.55, blunt: 0.50 },
    power:     { zh: "强势压制", press: 0.95, evade: 0.15, reveal: 0.30, concede: 0.05, tolerate: 0.60, burst: 0.80, blunt: 0.80 },
    tactician: { zh: "话里有话", press: 0.60, evade: 0.50, reveal: 0.65, concede: 0.35, tolerate: 0.85, burst: 0.30, blunt: 0.20 },
    hunter:    { zh: "寡言伺机", press: 0.50, evade: 0.60, reveal: 0.50, concede: 0.20, tolerate: 0.70, burst: 0.90, blunt: 0.60 },
    cool:      { zh: "冷硬简短", press: 0.70, evade: 0.40, reveal: 0.35, concede: 0.10, tolerate: 0.75, burst: 0.60, blunt: 0.95 }
  };

  // ── 戏剧动作库：每个动作有"压力/张力/时长/身体线索/潜台词形态" ─────────
  const ACTS = [
    { key: "probe",   zh: "试探", family: "probe",   press: 0.30, tension: +0.06, dur: [1.6, 3.4], sense: 0.45,
      intent: "用一句看似无关的话，试对方的底", body: ["指尖在桌面上无意识地画了一小段", "眼睛没看对方，看的是对方手边的东西", "把身子稍微侧过来一点，像随口一问"],
      subtext: ["我其实已经知道一半了", "我只是想看你第一反应", "这个问题我问得越随便，越说明我在意"] },
    { key: "press",   zh: "追问", family: "press",   press: 0.55, tension: +0.11, dur: [1.4, 3.0], sense: 0.6,
      intent: "抓住刚才那句不放，逼出下一句", body: ["身子前倾了半寸", "把手里的东西放下，腾出两只手", "声音压低，但一个字都没少"],
      subtext: ["你别想用别的话糊过去", "我今天就要这一句", "我不是在问，我是在等"] },
    { key: "evade",   zh: "回避", family: "evade",   press: 0.10, tension: -0.03, dur: [1.8, 3.6], sense: 0.3,
      intent: "绕开这个话题，不接这个球", body: ["低头去碰了碰茶盏，让它转了小半圈", "看向门外，像在听什么声音", "答了一句完全不相干的话"],
      subtext: ["我听见了，但我不接", "再往下说我就得撒谎了", "给我一点时间想怎么答"] },
    { key: "deflect", zh: "转移", family: "evade",   press: 0.15, tension: +0.01, dur: [1.6, 3.2], sense: 0.35,
      intent: "把矛头转回对方身上", body: ["抬眼看对方，反问回去", "笑了一下，那笑没到眼睛", "把手往回一收，换了坐姿"],
      subtext: ["你问我的，你自己呢", "换个战场对我更有利", "别看我，看你自己"] },
    { key: "deny",    zh: "否认", family: "evade",   press: 0.20, tension: +0.05, dur: [1.2, 2.6], sense: 0.5,
      intent: "把话堵死，不给余地", body: ["话说得比平时快", "摇头的幅度大了一点，像是在说服自己", "手里的小动作停了"],
      subtext: ["我否认得这么快，是因为真的怕", "别问了", "再说下去我会露出破绽"] },
    { key: "reveal",  zh: "揭露", family: "reveal",  press: 0.85, tension: +0.22, dur: [1.8, 4.0], sense: 0.95,
      intent: "把攥在手里的东西摊到桌上", body: ["从怀里/袖中取出那件东西，放在两人中间", "不看对方的眼睛，看那件东西", "声音很平，一个字都没抖"],
      subtext: ["我留到今天才拿出来，是因为还顾着旧情", "你自己看看", "这一下，你我都不好过了"] },
    { key: "concede", zh: "示弱", family: "concede", press: 0.05, tension: -0.07, dur: [1.6, 3.4], sense: 0.55,
      intent: "把姿态放低，换对方的松动", body: ["肩膀塌了半分", "第一次把视线移开，落到地上", "手撑了一下桌沿"],
      subtext: ["我撑不住了", "你要的不是真相，是我的低头", "我先认输，你别再逼"] },
    { key: "yield",   zh: "让步", family: "concede", press: 0.0, tension: -0.15, dur: [2.0, 4.0], sense: 0.7,
      intent: "把争执的东西交出去，换一个收场", body: ["把东西推过去", "站起来一半又坐下", "长长吐了一口气，胸口的起伏落了"],
      subtext: ["这事到这儿吧", "我认了，但我记着", "我让的不是这件事，是你"] },
    { key: "threat",  zh: "威胁", family: "press",   press: 0.80, tension: +0.18, dur: [1.6, 3.4], sense: 0.85,
      intent: "把后果明明白白摆出来", body: ["站起身，影子压到对方身上", "手指点在桌面上，一下，两下", "说到最后半句时反而笑了"],
      subtext: ["我有能力让这句话成真", "这是最后一次好好说", "你还有一步可以退"] },
    { key: "silence", zh: "沉默", family: "evade",   press: 0.05, tension: +0.04, dur: [2.6, 6.0], sense: 0.4,
      intent: "不说话，让对方自己往下说", body: ["端起茶盏，慢慢地喝了一口", "看着窗外，睫毛都没动", "把火盆里的炭拨了一下"],
      subtext: ["我先不说话，看你急不急", "我在等你先撑不住", "沉默也是回答"] },
    { key: "touch",   zh: "触碰", family: "ritual",  press: 0.0, tension: -0.05, dur: [1.4, 3.0], sense: 0.8,
      intent: "用一个动作代替一句话", body: ["伸手替对方掸掉肩上的灰", "把对方的袖子从水里捞出来", "按住对方要去拿刀的手"],
      subtext: ["别说了", "我还在", "这一下比什么都清楚"] },
    { key: "burst",   zh: "爆发", family: "burst",   press: 0.95, tension: +0.28, dur: [1.6, 3.6], sense: 1.0,
      intent: "忍不住了，把攒着的全砸出来", body: ["一掌拍在桌上，茶盏跳了一下", "抓住对方的衣领", "声音破了，后半句几乎是喊的"],
      subtext: ["我忍了很久了", "你逼我的", "反正已经这样了"] },
    // 日常铺陈专用
    { key: "hand",    zh: "递物", family: "ritual",  press: 0.0, tension: 0.0, dur: [1.6, 3.4], sense: 0.5, daily: true,
      intent: "把东西递过去，顺便递一句话", body: ["把碗往对方那边推了推", "把伞往对方头上偏了半寸", "把缰绳递过去时手停了一下"],
      subtext: ["我做的，你吃", "别淋着", "路还长"] },
    { key: "stand",   zh: "并肩", family: "ritual",  press: 0.0, tension: 0.0, dur: [2.2, 4.6], sense: 0.6, daily: true,
      intent: "不说什么，站到同一边", body: ["并排站着，中间留出一拳的距离", "两个人一起看远处", "影子在墙上叠成一块"],
      subtext: ["不用说话", "我在这一边", "就这样也挺好"] },
    { key: "tidy",    zh: "收拾", family: "ritual",  press: 0.0, tension: -0.01, dur: [2.0, 4.2], sense: 0.45, daily: true,
      intent: "用手上的活掩住心里的话", body: ["把碗一只只叠好，动作比平时慢", "把散落的东西归拢成一小堆", "把熄了的灯重新点上"],
      subtext: ["我在拖时间", "把这些弄好，就当什么都没发生", "总要有人收场"] },
    { key: "look",    zh: "回望", family: "probe",   press: 0.08, tension: +0.02, dur: [1.4, 3.0], sense: 0.7,
      intent: "回头看一眼，什么也没说", body: ["走到门口又回过头", "隔着雨看了一眼，很快收回", "把手抬起来又放下"],
      subtext: ["其实我想留下", "这一眼之后就没有了", "别送了"] }
  ];
  const ACT_ZH = {}; ACTS.forEach(a => ACT_ZH[a.key] = a.zh);
  const BY_FAMILY = {}; ACTS.forEach(a => (BY_FAMILY[a.family] = BY_FAMILY[a.family] || []).push(a));

  // ── 场景/环境：氛围由"天气+时间+光源+声音+气味+道具"推出来 ────────────
  const WEATHER = {
    rain:      { zh: "中雨", sounds: ["雨点打在瓦上连成一片", "檐水一线一线砸进积水", "雨声偶尔盖住半句话"], temp: 16, light: "灯笼暖光被雨丝切成细线" },
    drizzle:   { zh: "细雨", sounds: ["雨丝落在衣服上几乎没有声", "水珠从檐角一颗一颗落"], temp: 18, light: "湿石板反着微光" },
    storm:     { zh: "暴雨", sounds: ["雷声从远处滚过来", "风把门板拍得直响"], temp: 14, light: "闪电一瞬间照亮整间屋子" },
    snow:      { zh: "落雪", sounds: ["雪压断了院里的枯枝", "踩雪的声音又脆又远"], temp: -3, light: "雪光把夜照得发白" },
    fog:       { zh: "浓雾", sounds: ["远处更鼓闷闷的", "脚步在雾里传得很近"], temp: 8, light: "灯只剩一团糊光" },
    night:     { zh: "夜", sounds: ["更漏声", "虫鸣"], temp: 19, light: "烛火一跳一跳" },
    dusk:      { zh: "黄昏", sounds: ["归鸟", "远处收摊的吆喝"], temp: 22, light: "夕照把窗纸照成蜜色" },
    dawn:      { zh: "破晓", sounds: ["第一声鸡叫", "井边打水声"], temp: 13, light: "天光刚亮，灯还没灭" },
    day:       { zh: "白天", sounds: ["院子里的说话声", "鸟叫"], temp: 24, light: "日光从窗棂切进来" }
  };
  const PLACES = {
    ancestral_hall: { zh: "祠堂", props: ["供桌上的牌位", "长明灯", "门槛积水", "香灰", "蒲团"], smell: "香灰混着潮气的味道" },
    teahouse:       { zh: "茶馆", props: ["八仙桌", "茶盏", "瓜子壳", "跑堂的抹布", "窗纸"], smell: "茶气混着煤烟" },
    inn_room:       { zh: "客栈房间", props: ["油灯", "旧被褥", "桌上的信", "窗栓", "铜盆"], smell: "陈年木头的味道" },
    temple:         { zh: "破庙", props: ["塌了半边的佛像", "散落的经文", "火堆", "佛前的木鱼"], smell: "香灰混着雨腥" },
    street_rain:    { zh: "雨夜长街", props: ["路障", "木箱", "酒坛", "灯笼", "墙根的水痕"], smell: "湿泥和灯油的味" },
    bridge:         { zh: "江桥", props: ["湿滑的桥板", "缆绳", "船灯", "水面"], smell: "江水腥气" },
    cliff:          { zh: "山道崖边", props: ["松枝", "碎石", "断绳", "远处的城灯"], smell: "松针和土的味道" },
    hall_mansion:   { zh: "大宅正厅", props: ["太师椅", "屏风", "瓷瓶", "地砖缝隙", "廊下的风铃"], smell: "漆味和檀香" },
    kitchen:        { zh: "灶房", props: ["灶膛的火", "案板", "粥锅", "风箱", "挂在梁上的腊肉"], smell: "柴火和米汤的味" }
  };

  // ── 文戏机位库（服务情绪，不是服务动作）──────────────────────────────
  const SHOTS = [
    { key: "two_static", zh: "静帧双人同框", use: "势均力敌、话还没说破", note: "不动，让观众自己找线索" },
    { key: "slow_push",  zh: "缓慢推近",     use: "某一方开始占据上风", note: "推的时候不给对方反应" },
    { key: "ots",        zh: "过肩反打",     use: "对话进入攻防", note: "谁的肩膀在前，谁就暂时占先" },
    { key: "insert",     zh: "物件特写",     use: "情绪要落下来、台词要停一拍", note: "手、茶盏、灯花、门槛的水" },
    { key: "empty",      zh: "空镜留白",     use: "转折之后给呼吸", note: "雨、灯、门缝，声音补情绪" },
    { key: "back_profile", zh: "背身隔景",   use: "不想让对方看见表情", note: "前景挡一半，脸只看侧影" },
    { key: "low",        zh: "低位仰角",     use: "势能翻转，压迫一方", note: "注意别过火，仰一点就够" },
    { key: "high",       zh: "高位俯角",     use: "被压住、被揭穿", note: "给头顶和肩线，不给眼" },
    { key: "lens_long",  zh: "长焦压缩",     use: "两人明明很近却很远", note: "背景糊掉，只留两个人" },
    { key: "track_side", zh: "侧面跟移",     use: "并肩走、边走边说", note: "脚步与台词同步" }
  ];

  function mulberry32(seed) {
    let a = (seed >>> 0) || 1;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const pick = (rng, arr) => arr[Math.floor(rng() * arr.length) % arr.length];

  // 情绪基线：性格决定"底子里是什么情绪"（两人不该是一张脸）
  const STYLE_EMO = {
    berserk:   { anger: 0.28, contempt: 0.12, fear: 0.04, joy: 0.05 },
    calm:      { anger: 0.06, fear: 0.06, contempt: 0.08, sadness: 0.06, joy: 0.06 },
    guardian:  { fear: 0.14, sadness: 0.12, love: 0.12, anger: 0.05 },
    swift:     { surprise: 0.22, joy: 0.12, fear: 0.08, anger: 0.08 },
    power:     { anger: 0.22, contempt: 0.22, joy: 0.05, fear: 0.04 },
    tactician: { contempt: 0.14, joy: 0.08, fear: 0.08, surprise: 0.06 },
    hunter:    { fear: 0.05, anger: 0.12, sadness: 0.10, contempt: 0.08 },
    cool:      { contempt: 0.26, sadness: 0.06, anger: 0.06, fear: 0.04 }
  };

  // 音色/语速/口音：官方 4.4 要求说话人首次出现时要给足身份信息
  const VOICE_TONE = ["低沉沙哑", "清亮偏冷", "沙哑带痰音", "温软发闷", "干硬发脆", "微哑带笑", "平稳无起伏", "轻而快"];
  const VOICE_RATE = ["慢而稳", "不快不慢，句尾略沉", "快且碎", "前半句快后半句慢", "一字一字地放"];
  const VOICE_ACCENT = ["北方官话", "带南边口音", "官话里夹着乡音", "咬字很正", "齿音偏重"];

  // ── 人物 ─────────────────────────────────────────────────────────────
  function makePerson(o, rng) {
    const st = STYLES[o.style] || STYLES.calm;
    const emo = {}; EMOTIONS.forEach(e => emo[e] = 0.03);
    Object.assign(emo, STYLE_EMO[o.style] || STYLE_EMO.calm);
    // 攥着秘密的人：底子里多一点惧与愧（但不能把别的情绪全压死）
    if (o.secret) { emo.fear = Math.max(emo.fear, 0.16); emo.guilt = Math.max(emo.guilt, 0.18); }
    Object.assign(emo, o.emotion || {});
    // 声线：可由角色卡指定，否则按性格与年龄推（官方要求"音色/语速/口音"这类可听身份要素）
    const v = o.voice || {};
    return {
      id: o.id, name: o.name || o.id, style: o.style || "calm", styleZh: st.zh, S: st,
      weapon: o.weapon || "none", tier: o.tier || 1, look: o.look || "",
      goal: o.goal || "把这件事弄清楚", secret: o.secret || "", stake: o.stake || "",
      speech: Object.assign({ register: "江湖", tics: [], taboo: [] }, o.speech || {}),
      voice: {
        tone: v.tone || pick(rng, VOICE_TONE),
        rate: v.rate || pick(rng, VOICE_RATE),
        accent: v.accent || pick(rng, VOICE_ACCENT),
        age: v.age || (o.tier >= 7 ? "中年偏老" : "青年"),
        gender: v.gender || "男",
        onScreen: v.onScreen !== false
      },
      speakerId: null,
      habit: (o.habit && o.habit.length) ? o.habit.slice() : ["摩挲手边的物件"],
      emo, emoBase: Object.assign({}, emo),
      tolerance: clamp((o.tolerance == null ? st.tolerate : o.tolerance) * (0.85 + rng() * 0.3), 0.15, 1),
      stamina: 1, power: 0, broke: false, spoken: 0, acts: [], lastAct: null, sameRun: 0,
      facade: clamp(1 - st.blunt * 0.7, 0.1, 1)      // 掩饰能力（冷硬型不掩饰，绕弯型掩饰强）
    };
  }
  function relKey(a, b) { return a.id + ">" + b.id; }
  function setRel(state, a, b, r) {
    state.rel[relKey(a, b)] = Object.assign({ trust: 0.35, intimacy: 0.30, hostility: 0.25, power: 0.0 }, r || {});
  }
  function getRel(state, a, b) {
    const k = relKey(a, b);
    if (!state.rel[k]) setRel(state, a, b, null);
    return state.rel[k];
  }

  // ── 情绪派生 ─────────────────────────────────────────────────────────
  function valence(e) {
    return clamp((e.joy + e.love + e.pity * 0.5) - (e.anger * 0.7 + e.fear + e.sadness + e.shame + e.guilt + e.contempt * 0.5), -1, 1);
  }
  function arousal(e) { return clamp(e.anger * 0.9 + e.fear * 0.9 + e.surprise * 0.7 + e.joy * 0.6 + e.shame * 0.4, 0, 1); }
  function dominant(e) {
    let best = "calm", v = -1;
    for (const k of EMOTIONS) if (e[k] > v) { v = e[k]; best = k; }
    return v < 0.22 ? { key: "平静", zh: "平静", v } : { key: best, zh: EMO_ZH[best], v };
  }

  // ── 转折骨架：起/承/转/高潮/收（保证 ≥3 个转折和一条张力曲线）─────────
  const PHASES = [
    { key: "起", families: ["probe", "ritual", "evade"], target: [0.18, 0.34], beats: [2, 3], goal: "把人摆进场景，亮出不对付的那一点" },
    { key: "承", families: ["press", "evade", "probe", "deflect"], target: [0.34, 0.56], beats: [2, 4], goal: "加压与回避来回，把旧账翻出来" },
    { key: "转", families: ["reveal", "press", "deflect", "concede"], target: [0.56, 0.74], beats: [2, 3], goal: "必须有一次翻转（揭露或势能易手）", force: "turn" },
    { key: "高潮", families: ["threat", "burst", "silence", "concede", "yield"], target: [0.72, 0.96], beats: [2, 3], goal: "把攒的全摊开，情绪破一次" },
    { key: "收", families: ["yield", "concede", "silence", "touch", "ritual"], target: [0.25, 0.55], beats: [1, 2], goal: "给一个明确结局，留余味不收干净" }
  ];
  const DAILY_PHASES = [
    { key: "起", families: ["ritual", "hand", "tidy", "stand"], target: [0.08, 0.20], beats: [2, 3], goal: "把事情做起来，给出真实的手上活" },
    { key: "承", families: ["ritual", "probe", "look", "hand"], target: [0.15, 0.32], beats: [2, 3], goal: "一句旧事被提起，气氛轻轻变一下" },
    { key: "转", families: ["evade", "silence", "look", "touch"], target: [0.30, 0.52], beats: [2, 3], goal: "有人想接话，有人把它盖过去（唯一的转）", force: "turn" },
    { key: "收", families: ["ritual", "stand", "hand", "silence"], target: [0.12, 0.30], beats: [1, 3], goal: "事情做完，各走各的，留一个动作" }
  ];

  // ── 结局判定 ─────────────────────────────────────────────────────────
  function decideEnding(state, mode, rng) {
    // 独白：没有"关系"，只有理智与情感谁占上风
    if (mode === "monologue") {
      const inner = state.inner || [];
      const me = state.cast[0];
      const diff = inner.length === 2 ? (inner[0].power - inner[1].power) : 0;
      if (me.broke) return { kind: "情绪压不住", desc: "本来在心里过得好好的话，最后是情绪先开了口——说出来的却是另一件事" };
      if (diff > 0.12) return { kind: "理智压回去", desc: "把话在心里过了一遍又一遍，最后什么都没说出口，只留下一个多余的动作" };
      if (diff < -0.12) return { kind: "情绪占了上风", desc: "到底还是去做了那件不该做的事，手比脑子快" };
      return { kind: "悬着", desc: "两边都没赢，这一夜就这么耗过去了，天快亮的时候才睡着" };
    }
    const [a, b] = state.cast;
    if (!a || !b) return { kind: "僵持", desc: "话停在半句上" };
    const rAB = getRel(state, a, b), rBA = getRel(state, b, a);
    const host = (rAB.hostility + rBA.hostility) / 2;
    const trust = (rAB.trust + rBA.trust) / 2;
    const peak = state.peakTension;
    const anyBurst = state.cast.some(c => c.broke) || (state.burstCount || 0) > 0;
    const revealed = state.revealLanded || state.beats.some(x => x.act === "reveal" && x.outcome === "land");
    const yielded = state.beats.some(x => x.act === "yield");
    const flips = state.powerFlips || 0;
    if (mode === "daily") {
      return trust > 0.45
        ? { kind: "安静的暖意", desc: "谁也没把话说透，但该做的都做了；最后留一个动作就够" }
        : { kind: "各自的沉默", desc: "事情照旧做完，两个人中间那句没出口的话留在原地" };
    }
    if (anyBurst && (host >= 0.5 || peak >= 0.85)) return { kind: "决裂", desc: "话说到了不能收回的地方，接下来不是谈，是打" };
    if (revealed && !yielded && host >= 0.4) return { kind: "真相摊开·僵持", desc: "东西摆出来了，谁都不肯先退，事情停在最难受的平衡上" };
    if (yielded && host < 0.5) return { kind: "妥协", desc: "有人先让了半步，事情勉强收住，代价记在心里" };
    if (trust >= 0.58 && host <= 0.32) return { kind: "和解", desc: "不是不疼了，是决定先把它放下" };
    if (flips >= 2) return { kind: "势能反转后停手", desc: "谁也没能压住谁，最后各自把手里的东西收了回去" };
    return { kind: "僵持", desc: "没有赢家，谁都没走，话停在半句上" };
  }

  // ── 群戏：联盟与注意力 ───────────────────────────────────────────────
  function groupAlliances(state, rng) {
    const cs = state.cast;
    state.alliance = {};
    for (let i = 0; i < cs.length; i++) for (let j = i + 1; j < cs.length; j++) {
      const t = (getRel(state, cs[i], cs[j]).trust + getRel(state, cs[j], cs[i]).trust) / 2;
      state.alliance[cs[i].id + "|" + cs[j].id] = t > 0.5 ? 1 : (t < 0.3 ? -1 : 0);
    }
    state.mute = cs[cs.length - 1];   // 沉默的第三人（最后一位）
  }

  // ── 行动解析：压力 vs 耐受 → 戳中 / 被挡 / 反噬 / 崩防 ────────────────
  function resolve(state, actor, target, act, rng, phaseKey) {
    const st = actor.S, rel = getRel(state, actor, target);
    const pressure = act.press * (0.55 + st.press * 0.75) * (0.75 + (actor.power + 0.5) * 0.5);
    // 防御：耐受 + 掩饰 + 关系里的信任（信任越高越不设防）
    const defense = target.tolerance * 0.55 + target.facade * 0.35 * (1 - rel.trust * 0.4) + (target.emo.fear * 0.2);
    const jitter = (rng() - 0.5) * 0.22;
    let outcome = "deflect";
    // 非语言动作（沉默/回望/触碰）不改"压力"，看的是对方接不接
    if (act.key === "silence" || act.key === "look" || act.key === "touch") {
      return rng() < 0.7 ? "land" : "deflect";
    }
    if (act.family === "concede" || act.family === "ritual") outcome = "land";
    else if (pressure + jitter > defense) outcome = "land";
    else if (pressure + jitter > defense - 0.18) outcome = "graze";
    // 揭露：没有底牌就是自曝其短 → 反噬
    if (act.key === "reveal") {
      const hasCard = !!actor.secret || rng() < 0.55 + st.reveal * 0.35;
      if (!hasCard) outcome = "backfire";
    }
    // 威胁：对方势能更高时会被顶回去
    if (act.key === "threat" && rel.power < -0.15) outcome = "backfire";
    // 群戏：有人帮腔会让压力变大
    if (state.mode === "group" && state.alliance) {
      for (const o of state.cast) {
        if (o === actor || o === target) continue;
        const k1 = [o.id, actor.id].sort().join("|");
        if (state.alliance[k1] === 1) outcome = outcome === "deflect" ? "land" : outcome;   // 同盟帮腔
      }
    }
    return outcome;
  }

  function applyConsequences(state, actor, target, act, outcome, rng) {
    const eA = actor.emo, eT = target.emo, rel = getRel(state, actor, target), back = getRel(state, target, actor);
    const why = [];
    if (outcome === "land") {
      // 被戳中：情绪由动作性质决定，振幅要够大（否则永远压在基线上看不出情绪）
      const gain = 0.30 + act.press * 0.26;
      if (act.family === "reveal") { eT.shame = clamp(eT.shame + gain, 0, 1); eT.anger = clamp(eT.anger + gain * 0.8, 0, 1); why.push("被当场摊牌"); }
      else if (act.family === "press") { eT.anger = clamp(eT.anger + gain * 0.9, 0, 1); eT.fear = clamp(eT.fear + gain * 0.45, 0, 1); why.push("被抓住话头追问"); }
      else if (act.family === "probe") { eT.surprise = clamp(eT.surprise + gain * 0.9, 0, 1); eT.fear = clamp(eT.fear + gain * 0.4, 0, 1); why.push("被试探到底细"); }
      else if (act.family === "concede") { why.push("自己先低了头"); eA.sadness = clamp(eA.sadness + 0.22, 0, 1); eT.pity = clamp(eT.pity + 0.18, 0, 1); }
      else if (act.family === "ritual") { eT.joy = clamp(eT.joy + 0.16, 0, 1); eT.love = clamp(eT.love + 0.12, 0, 1); why.push("对方接过来了这个不说的动作"); }
      else if (act.family === "burst") { eT.fear = clamp(eT.fear + gain, 0, 1); eT.sadness = clamp(eT.sadness + gain * 0.6, 0, 1); why.push("被当面爆发压住"); }
      target.tolerance = clamp(target.tolerance - (0.16 + act.press * 0.28), 0, 1);
      // 势能：压人的动作加分，低头让步的动作减分（不能"让步还涨势"）
      const powerDelta = (act.family === "press" || act.family === "reveal" || act.family === "burst") ? (0.12 + act.press * 0.10)
        : (act.family === "concede" || act.family === "ritual") ? -(0.10 + (1 - act.press) * 0.06)
          : 0.04;
      rel.power = clamp(rel.power + powerDelta, -1, 1);
      back.power = clamp(back.power - powerDelta * 0.35, -1, 1);   // 零和耦合但幅度更小，保证"渐变"
      if (act.family === "press" || act.family === "reveal" || act.family === "burst") {
        rel.trust = clamp(rel.trust - 0.08, 0, 1); rel.hostility = clamp(rel.hostility + 0.10, 0, 1);
        back.hostility = clamp(back.hostility + 0.12, 0, 1);
      }
      if (act.family === "concede" || act.family === "ritual") {
        rel.trust = clamp(rel.trust + 0.10, 0, 1); back.hostility = clamp(back.hostility - 0.08, 0, 1);
      }
      actor.emo.contempt = clamp(actor.emo.contempt + 0.06 * (1 - actor.S.blunt * 0.3), 0, 1);
    } else if (outcome === "graze") {
      why.push("话擦到了边上");
      eT.tensionHit = 0.5;
      eT.anger = clamp(eT.anger + 0.08, 0, 1);
      target.tolerance = clamp(target.tolerance - 0.08, 0, 1);
      rel.power = clamp(rel.power + 0.05, -1, 1);
    } else if (outcome === "backfire") {
      why.push("想压人反而被顶了回来");
      actor.emo.shame = clamp(actor.emo.shame + 0.2, 0, 1);
      actor.emo.anger = clamp(actor.emo.anger + 0.12, 0, 1);
      back.power = clamp(back.power + 0.14, -1, 1);
      rel.power = clamp(rel.power - 0.14, -1, 1);
      back.hostility = clamp(back.hostility + 0.08, 0, 1);
    } else { // deflect
      why.push("话被绕了过去");
      actor.emo.surprise = clamp(actor.emo.surprise + 0.06, 0, 1);
      target.stamina = clamp(target.stamina - 0.06, 0, 1);
      actor.stamina = clamp(actor.stamina - 0.04, 0, 1);
      rel.power = clamp(rel.power + 0.03, -1, 1);
      back.power = clamp(back.power - 0.02, -1, 1);
    }
    // 耐受见底 → 崩防（爆发）或认输
    let broke = false;
    if (target.tolerance <= 0.02 && !target.broke) {
      target.broke = true; broke = true;
      if (target.S.burst > 0.5) {
        target.emo.anger = clamp(target.emo.anger + 0.35, 0, 1);
        target.emo.sadness = clamp(target.emo.sadness + 0.2, 0, 1);
        why.push("忍到极限，破了");
      } else {
        target.emo.sadness = clamp(target.emo.sadness + 0.25, 0, 1);
        target.emo.shame = clamp(target.emo.shame + 0.2, 0, 1);
        target.emo.love = clamp(target.emo.love + 0.1, 0, 1);
        why.push("撑不住了，先塌下去");
      }
    }
    return { why, broke };
  }

  // ── 主流程 ───────────────────────────────────────────────────────────
  function simulate(opt) {
    const o = opt || {};
    const rng = mulberry32(o.seed == null ? 20260918 : o.seed);
    const mode = o.mode || "duel";                     // duel | group | monologue | daily | hybrid
    const duration = o.duration || 48;
    const castIn = (o.cast && o.cast.length) ? o.cast : [{ id: "A", name: "甲" }, { id: "B", name: "乙" }];
    const cast = castIn.map((c, i) => makePerson(Object.assign({ id: c.id || String.fromCharCode(65 + i) }, c), rng));
    const sc = o.scene || {};
    const wKey = sc.weather || (mode === "daily" ? "dawn" : "rain");
    const W = WEATHER[wKey] || WEATHER.rain;
    const P = PLACES[sc.place] || PLACES.ancestral_hall;
    const scene = {
      place: sc.placeZh || P.zh, time: sc.time || (wKey === "dawn" ? "破晓" : wKey === "dusk" ? "黄昏" : "夜里"),
      weather: W.zh, temp: sc.temp != null ? sc.temp : W.temp, light: sc.light || W.light,
      sounds: (sc.sounds && sc.sounds.length ? sc.sounds : W.sounds).slice(),
      smell: sc.smell || P.smell, props: (sc.props && sc.props.length ? sc.props : P.props).slice(),
      atmosphere: sc.atmosphere || "", topic: sc.topic || "一件摆在两人中间、谁都不肯先提的事"
    };
    const state = { mode, seed: o.seed == null ? 20260918 : o.seed, cast, rel: {}, beats: [], turns: [], curve: [], peakTension: 0, scene, rng };

    // 关系：支持显式给，否则按目标/秘密推
    cast.forEach(a => cast.forEach(b => {
      if (a === b) return;
      const given = (o.relations || {})[a.name + "->" + b.name] || ({}[a.id + ">" + b.id] || null);
      setRel(state, a, b, given || {
        trust: 0.4, intimacy: 0.35, hostility: 0.22, power: 0
      });
    }));
    if (mode === "group") groupAlliances(state, rng);

    // monologue：内在两股声音
    if (mode === "monologue") {
      state.inner = [
        { id: "A:reason", name: "（心里·理智）", S: STYLES.calm, blunt: 0.4, facade: 0.3, emo: Object.assign({}, cast[0].emo), tolerance: 0.9, stamina: 1, power: 0.1, habit: ["把话在心里过一遍"], speech: { register: "自语", tics: [], taboo: [] }, styleZh: "理智", acts: [], sameRun: 0 },
        { id: "A:feeling", name: "（心里·情感）", S: STYLES.swift, blunt: 0.8, facade: 0.2, emo: Object.assign({}, cast[0].emo), tolerance: 0.6, stamina: 1, power: -0.1, habit: ["喉咙发紧"], speech: { register: "自语", tics: [], taboo: [] }, styleZh: "情感", acts: [], sameRun: 0 }
      ];
    }

    const plan = (mode === "daily") ? DAILY_PHASES : PHASES;
    const totalBeats = clamp(Math.round(duration / 4.2), 6, 20);
    // 按阶段权重分配拍数
    const budget = plan.map(ph => {
      const mid = (ph.beats[0] + ph.beats[1]) / 2;
      return Math.max(1, Math.round(mid * (totalBeats / plan.reduce((s, p) => s + (p.beats[0] + p.beats[1]) / 2, 0))));
    });

    let t = 0, tension = plan[0].target[0];
    for (let pi = 0; pi < plan.length; pi++) {
      const ph = plan[pi];
      // 段落必须够到自己的张力下限，否则高潮会"软"掉（电影里的段落推进）
      tension = clamp(Math.max(tension, ph.target[0] * 0.92), 0.02, 1);
      const n = clamp(budget[pi], 1, 6);
      for (let k = 0; k < n; k++) {
        // 选说话人：拥有主动权/带着目标/刚被压的一方要回应
        let actor, target;
        if (mode === "monologue") {
          const inner = state.inner[cast[0].spoken % 2 === 0 ? 0 : 1];
          actor = inner; target = inner === state.inner[0] ? state.inner[1] : state.inner[0];
          cast[0].spoken++;
        } else {
          const pool = state.beats.length === 0 ? cast : cast.slice();
          // 上一拍的被动方更可能接话；否则按势能与目标挑
          const last = state.beats[state.beats.length - 1];
          if (last && rng() < 0.72) {
            actor = cast.find(c => c.id === last.targetId) || cast[0];
            target = cast.find(c => c.id === last.actorId) || cast[1];
          } else {
            actor = pool[Math.floor(rng() * pool.length)];
            const others = cast.filter(c => c !== actor);
            // 群戏：有 30% 把话直接抛给"第三方"，避免两个人互相接话把别人锁死
            let tgtPool = others;
            if (mode === "group" && others.length >= 2 && rng() < 0.3) {
              const prev = state.beats.length ? state.beats[state.beats.length - 1].actorId : null;
              const others2 = others.filter(c => c.id !== prev);
              if (others2.length) tgtPool = others2;
            }
            target = tgtPool[Math.floor(rng() * tgtPool.length)];
          }
        }
        // 选动作：阶段允许的族 × 风格权重，且不许连拍三次同一动作
        const cands = ACTS.filter(a => ph.families.includes(a.family) && (mode === "daily" || !a.daily));
        let scored = cands.map(a => {
          let w = 1;
          if (a.family === "press") w += actor.S.press * 1.6;
          if (a.family === "evade") w += actor.S.evade * 1.6;
          if (a.family === "reveal") w += actor.S.reveal * 1.2;
          if (a.family === "concede") w += actor.S.concede * 1.4 * (0.7 + (1 - actor.tolerance) * 0.9);
          if (a.family === "burst") w += actor.S.burst * 1.2 * (1 - actor.tolerance);
          if (a.key === "yield") w *= 0.45 + (actor.broke ? 1.6 : 0) + (actor.tolerance < 0.25 ? 0.7 : 0);   // 让步要有代价，不能人人都让
          if (a.family === "ritual") w += (mode === "daily" ? 1.6 : 0.5);
          // 对峙/群戏的开场不该出现"触碰"这类亲密动作（留到转与收才有力）
          if (a.key === "touch" && mode !== "daily" && (ph.key === "起" || ph.key === "承")) w *= 0.15;
          // 对峙开场必须有一句试探或追问，不能两人都在绕
          if ((ph.key === "起") && mode !== "daily" && state.beats.length === 0 && a.family === "ritual") w *= 0.3;
          // 第一拍：先立话题（试探优先），不许两人一起沉默开场
          if (state.beats.length === 0) {
            if (a.key === "probe" || a.key === "look") w *= 3.2;
            if (a.key === "silence" || a.family === "evade") w *= 0.12;
          }
          if (a.key === actor.lastAct) w *= 0.25;                         // 不重复自己刚做过的
          if (actor.sameRun >= 2 && a.key === actor.lastAct) w = 0;        // 也不许连三拍同一动作
          if (a.key === "burst" && actor.tolerance > 0.35) w *= 0.25;      // 还没到极限就别爆
          if (a.key === "reveal" && state.beats.some(x => x.act === "reveal" && x.actorId === actor.id)) w *= 0.3;
          if (actor.stamina < 0.35 && a.family !== "concede" && a.family !== "ritual") w *= 0.5;
          return { a, w: Math.max(0.0001, w) };
        });
        const total = scored.reduce((s, x) => s + x.w, 0);
        let r = rng() * total, act = scored[0].a;
        for (const x of scored) { r -= x.w; if (r <= 0) { act = x.a; break; } }

        const relBefore = Object.assign({}, getRel(state, actor, target));
        const backBefore = Object.assign({}, getRel(state, target, actor));
        const outcome = resolve(state, actor, target, act, rng, ph.key);
        const cons = applyConsequences(state, actor, target, act, outcome, rng);
        // 统计：爆发次数、揭露是否落地、势能翻转次数（结局判定要用）
        if (act.key === "burst" || cons.broke) state.burstCount = (state.burstCount || 0) + 1;
        if (act.key === "reveal" && outcome === "land") state.revealLanded = true;
        const pw = getRel(state, actor, target).power;
        if (state.lastPowerSign != null && Math.sign(pw) !== 0 && Math.sign(pw) !== state.lastPowerSign) state.powerFlips = (state.powerFlips || 0) + 1;
        if (Math.sign(pw) !== 0) state.lastPowerSign = Math.sign(pw);
        const dt = act.dur[0] + rng() * (act.dur[1] - act.dur[0]);
        const t0 = t, t1 = t + dt;
        const tensionTarget = (ph.target[0] + ph.target[1]) / 2;
        const dT = (act.tension + (outcome === "land" ? 0.06 : outcome === "backfire" ? 0.05 : 0)) * (1 + (1 - tension) * 0.4);
        const prevT = tension;
        tension = clamp(tension + dT + (tensionTarget - tension) * 0.38, 0.02, 1);
        // 高潮段必须真的起峰：每场戏都要有一个"顶到那儿"的时刻（电影结构硬要求）
        if (ph.key === "高潮" && k > 0) tension = Math.max(tension, 0.78);
        state.peakTension = Math.max(state.peakTension, tension);

        // 身体线索 / 环境互动 / 潜台词：从库里取，且短时间内不重复（两人不会说同一句潜台词）
        const body = pick(rng, act.body);
        const habit = pick(rng, actor.habit);
        const envCue = pick(rng, scene.sounds.concat(scene.props.map(p => p)));
        state.usedSub = state.usedSub || [];
        let subPool = act.subtext.filter(x => state.usedSub.indexOf(x) < 0);
        if (!subPool.length) subPool = act.subtext;
        const subtext = pick(rng, subPool);
        state.usedSub.push(subtext);
        if (state.usedSub.length > Math.max(4, act.subtext.length)) state.usedSub.shift();
        const actIntent = act.intent;
        // 说话人 ID（官方 4.4：首次发声时按顺序分配，全程固定；不发声的人不给 ID）
        if (!actor.speakerId) {
          state.speakerSeq = (state.speakerSeq || 0) + 1;
          actor.speakerId = "S" + state.speakerSeq;
        }
        // 出声方式：独白戏的心声＝画外音（嘴唇不动）；偶尔真的说出口
        let delivery = "aloud";
        if (mode === "monologue") {
          const isFeeling = actor.id === "A:feeling";
          delivery = (cons.broke || (isFeeling && rng() < 0.45)) ? "aloud" : "voiceover";
        }
        const beat = {
          i: state.beats.length, t0: +t0.toFixed(2), t1: +t1.toFixed(2), dur: +dt.toFixed(2),
          phase: ph.key, who: actor.id, whoName: actor.name, to: target.id, toName: target.name,
          speakerId: actor.speakerId, delivery: delivery,
          mouthOpen: delivery === "aloud",
          crossesCut: false, truncated: false,
          voice: actor.voice,
          act: act.key, actZh: act.zh, family: act.family,
          intent: act.intent, subtext: subtext,
          body: body, habit: habit, envCue: envCue,
          outcome: outcome, why: cons.why.join("；"), broke: cons.broke,
          emoActor: { key: dominant(actor.emo).zh, v: +dominant(actor.emo).v.toFixed(2) },
          emoTarget: { key: dominant(target.emo).zh, v: +dominant(target.emo).v.toFixed(2) },
          tension: +tension.toFixed(3),
          rel: { trust: +getRel(state, actor, target).trust.toFixed(2), hostility: +getRel(state, actor, target).hostility.toFixed(2), power: +getRel(state, actor, target).power.toFixed(2) },
          relBefore: { power: +relBefore.power.toFixed(3), trust: +relBefore.trust.toFixed(3), hostility: +relBefore.hostility.toFixed(3) },
          backBefore: { power: +backBefore.power.toFixed(3) },
          backAfter: { power: +getRel(state, target, actor).power.toFixed(3) },
          relAfter: { power: +getRel(state, actor, target).power.toFixed(3) },
          targetId: target.id, actorId: actor.id, targetName: target.name
        };
        state.beats.push(beat);
        state.curve.push({ t: +((t0 + t1) / 2).toFixed(2), tension: +tension.toFixed(3), power: +getRel(state, actor, target).power.toFixed(2) });
        // 转折点
        const turn = (act.family === "reveal" && outcome === "land") ? "揭露落地"
          : (cons.broke ? "情绪崩防" : null)
          || (Math.abs(getRel(state, actor, target).power) > 0.25 ? "势能易手" : null)
          || (Math.abs(tension - prevT) > 0.16 ? "张力陡变" : null)
          || (pi > 0 && k === 0 ? "进入新段落" : null);
        if (turn && state.turns.length < 8 && !(state.turns.length && state.turns[state.turns.length - 1].kind === turn && t0 - state.turns[state.turns.length - 1].t < 3)) {
          state.turns.push({ t: +t0.toFixed(2), kind: turn, by: actor.name, desc: `${actor.name}「${act.zh}」→${outcome === "land" ? "戳中" : outcome === "backfire" ? "反噬" : outcome === "graze" ? "擦边" : "被挡"}：${beat.why || act.intent}` });
        }
        actor.lastAct = act.key; actor.sameRun++;
        actor.acts.push(act.key); actor.spoken++;
        // 情绪回落：被激起的情绪会往本人的基线退（否则一场戏永远停在同一种情绪上）
        for (const p of [actor, target]) {
          if (!p.emoBase) continue;
          for (const k of EMOTIONS) {
            const base = p.emoBase[k] || 0.03;
            p.emo[k] = clamp(p.emo[k] + (base - p.emo[k]) * (p.emo[k] > base ? 0.10 : 0.04), 0, 1);
          }
        }
        // 群戏：一直没开口的第三人第一次说话，本身就是转折（局面被重新定义）
        if (mode === "group" && state.mute && actor === state.mute &&
            !state.turns.some(x => x.kind === "第三人介入")) {
          state.turns.push({ t: +t0.toFixed(2), kind: "第三人介入", by: actor.name,
            desc: `一直没说话的${actor.name}开了口，两个对峙的人被迫重新站位` });
        }
        t = t1;
        // 时长到就收
        if (t >= duration - 2) break;
      }
      if (t >= duration - 2) break;
    }
    // 群戏硬保证：每一个人都必须开口（谁一直没说话，就给他补一拍，并记为转折）
    if (mode === "group") {
      for (const c of cast) {
        if (state.beats.some(b => b.who === c.id)) continue;
        const last = state.beats[state.beats.length - 1];
        const mAct = pick(rng, BY_FAMILY.probe.concat(BY_FAMILY.evade, BY_FAMILY.press));
        const t0 = last ? last.t1 : 0, t1 = t0 + 2.2;
        state.beats.push({
          i: state.beats.length, t0: +t0.toFixed(2), t1: +t1.toFixed(2), dur: 2.2,
          phase: "群戏介入", who: c.id, whoName: c.name, to: last ? last.actorId : state.cast[0].id,
          toName: last ? last.whoName : state.cast[0].name,
          act: mAct.key, actZh: mAct.zh, family: mAct.family,
          intent: "一直没开口的那个人，终于说了一句", subtext: pick(rng, mAct.subtext),
          body: pick(rng, mAct.body), habit: pick(rng, c.habit), envCue: pick(rng, scene.sounds),
          outcome: "land", why: "旁观者开口，局面被重新定义", broke: false,
          emoActor: { key: dominant(c.emo).zh, v: +dominant(c.emo).v.toFixed(2) },
          emoTarget: { key: dominant(state.cast[0].emo).zh, v: +dominant(state.cast[0].emo).v.toFixed(2) },
          tension: +clamp(tension + 0.05, 0, 1).toFixed(3),
          rel: { trust: 0.4, hostility: 0.2, power: 0 },
          relBefore: { power: 0, trust: 0.4, hostility: 0.2 }, relAfter: { power: 0 }, backBefore: { power: 0 }, backAfter: { power: 0 },
          actorId: c.id, targetId: last ? last.actorId : state.cast[0].id, targetName: last ? last.whoName : state.cast[0].name
        });
        state.turns.push({ t: +t0.toFixed(2), kind: "第三人介入", by: c.name,
          desc: `一直没说话的${c.name}开了口，原本两个人之间的对峙被迫重新站位` });
        tension = clamp(tension + 0.05, 0, 1);
      }
    }

    const ending = decideEnding(state, mode, rng);
    // 文武混合：决裂/崩防 → 交给武打内核
    let handoff = null;
    if (mode === "hybrid" || (o.fightOnBreak && (ending.kind === "决裂"))) {
      const A = cast[0], B = cast[1] || cast[0];
      const brokeEnding = (ending.kind === "决裂" || ending.kind === "真相摊开·僵持");
      const lastTurn = state.turns.length ? state.turns[state.turns.length - 1].desc : "话已经说不下去";
      handoff = {
        to: "fight",
        reason: brokeEnding ? `文戏到「${ending.kind}」：${lastTurn}`
                            : `文戏没谈成（${ending.kind}）：话堵在这儿，动手比说话快`,
        A: { name: A.name, weapon: A.weapon, tier: A.tier, style: A.style },
        B: { name: B.name, weapon: B.weapon, tier: B.tier, style: B.style }
      };
    }

    // 收尾：镜头与可拍清单
    const totalT = Math.max(...state.beats.map(b => b.t1), 4);
    const shots = packShots(state, totalT);
    // 跨切对白与截断：官方 4.4 要求跨切用 <scenetrans>、被片尾截断用 <cutoff>
    for (const b of state.beats) {
      const boundary = shots.find(s => s.t0 > b.t0 + 0.01 && s.t0 < b.t1 - 0.01);
      if (boundary) b.crossesCut = true;
      if (b.t1 >= totalT - 0.15 && b.i === state.beats.length - 1) b.truncated = true;
    }
    for (const s of shots) {
      const inShot = state.beats.filter(b => (b.t0 + b.t1) / 2 >= s.t0 && (b.t0 + b.t1) / 2 < s.t1 + 0.001);
      s.lines = inShot.map(b => ({
        speakerId: b.speakerId, who: b.whoName, t: b.t0, dur: b.dur,
        delivery: b.delivery, mouthOpen: b.mouthOpen, crossesCut: b.crossesCut,
        intent: b.intent, tone: b.delivery === "voiceover" ? "画外音，克制" : (b.emoActor.key === "平静" ? "压着说" : `${b.emoActor.key}着说`)
      }));
      s.audioTrack = s.lines.length
        ? s.lines.map(l => `(${l.speakerId}) ${l.who} ${l.delivery === "voiceover" ? "画外音·嘴不动" : "面对白·嘴张开"}｜语气：${l.tone}｜[${l.t.toFixed(1)}-${(l.t + l.dur).toFixed(1)}s]${l.crossesCut ? "｜跨切（需 <scenetrans>）" : ""}`).join("；")
        : "本镜无对白（只有环境声与动作声）";
    }
    // 说话人清单（官方：不发声的角色不给 ID）
    state.speakerList = state.cast.filter(c => c.speakerId).map(c => ({ id: c.speakerId, name: c.name, voice: c.voice }));
    const filmables = buildFilmables(state, rng);

    return {
      version: VERSION, mode, seed: state.seed, duration: +totalT.toFixed(2),
      scene, cast: cast.map(publicPerson), beats: state.beats, turns: state.turns, curve: state.curve,
      ending, handoff, shots, filmables, speakers: state.speakerList || [],
      peakTension: +state.peakTension.toFixed(3),
      summary: {
        beats: state.beats.length, turns: state.turns.length,
        peakTension: +state.peakTension.toFixed(3), ending: ending.kind,
        broke: state.cast.filter(c => c.broke).map(c => c.name)
      }
    };
  }

  function publicPerson(p) {
    return {
      id: p.id, name: p.name, style: p.style, styleZh: p.styleZh, weapon: p.weapon, tier: p.tier, look: p.look,
      voice: p.voice, speakerId: p.speakerId || null,
      goal: p.goal, secret: p.secret ? "（有隐情）" : "", stake: p.stake,
      speech: p.speech, habit: p.habit,
      emotion: { dominant: dominant(p.emo).zh, valence: +valence(p.emo).toFixed(2), arousal: +arousal(p.emo).toFixed(2), raw: Object.fromEntries(EMOTIONS.map(e => [EMO_ZH[e], +p.emo[e].toFixed(2)])) },
      tolerance: +p.tolerance.toFixed(2), broke: p.broke
    };
  }

  // ── 把拍切成 3~6 镜（每镜 4~15s，H3 单镜上限 15s）─────────────────────
  function packShots(state, totalT) {
    const beats = state.beats;
    if (!beats.length) return [];
    const want = clamp(Math.round(totalT / 9), 3, 6);
    const per = totalT / want;
    const shots = [];
    for (let i = 0; i < want; i++) {
      const t0 = i * per, t1 = Math.min(totalT, (i + 1) * per);
      const inShot = beats.filter(b => (b.t0 + b.t1) / 2 >= t0 && (b.t0 + b.t1) / 2 < t1 + 0.001);
      const acts = inShot.map(b => b.actZh).join("→") || "延续";
      const whoSpeaks = [...new Set(inShot.map(b => b.whoName))];
      const maxTension = Math.max(...(inShot.length ? inShot.map(b => b.tension) : [0]));
      const powerShift = inShot.some(b => Math.abs(b.rel.power) > 0.25);
      const broke = inShot.some(b => b.broke);
      let cam = SHOTS[0];
      if (broke) cam = SHOTS.find(s => s.key === "ots");
      else if (powerShift) cam = SHOTS.find(s => s.key === (maxTension > 0.7 ? "low" : "slow_push"));
      else if (maxTension > 0.75) cam = SHOTS.find(s => s.key === "high");
      else if (i === 0) cam = SHOTS.find(s => s.key === "two_static");
      else if (inShot.some(b => b.family === "ritual")) cam = SHOTS.find(s => s.key === "insert");
      else if (inShot.some(b => b.act === "silence")) cam = SHOTS.find(s => s.key === "empty");
      else if (i === want - 1) cam = SHOTS.find(s => s.key === "back_profile");
      else cam = SHOTS.find(s => s.key === "slow_push");
      shots.push({
        i: i + 1, t0: +t0.toFixed(2), t1: +t1.toFixed(2), dur: +(t1 - t0).toFixed(2),
        camera: cam.zh, cameraKey: cam.key, cameraNote: cam.note,
        acts: acts, speakers: whoSpeaks,
        headline: inShot.length ? `${inShot[0].actZh}→${inShot[inShot.length - 1].actZh}` : "延续上一镜",
        peakTension: +maxTension.toFixed(2),
        sound: `环境声：${state.scene.sounds[0] || "环境声"}；动作声：${inShot.map(b => b.act === "silence" ? "呼吸与器物的轻响" : b.actZh + "的手上声").slice(0, 2).join("、")}；对白同步声（台词由第1步写）`,
        value: broke ? "这一镜要给到情绪破口" : powerShift ? "这一镜要让观众看见谁占了上风" : maxTension > 0.75 ? "这一镜压着不给反应" : "这一镜交代关系与空间"
      });
    }
    // 简单校正：保证每镜都在 4~15s，超出就合并
    const fixed = [];
    for (const s of shots) {
      const prev = fixed[fixed.length - 1];
      if (prev && (s.dur < 4 || prev.dur < 4) && (prev.dur + s.dur) <= 15) {
        prev.t1 = s.t1; prev.dur = +(prev.t1 - prev.t0).toFixed(2);
        prev.acts = prev.acts + "→" + s.acts; prev.headline = prev.headline + "→" + s.headline;
        prev.speakers = [...new Set(prev.speakers.concat(s.speakers))];
        prev.peakTension = Math.max(prev.peakTension, s.peakTension);
      } else fixed.push(s);
    }
    fixed.forEach((s, i) => s.i = i + 1);
    return fixed;
  }

  function buildFilmables(state, rng) {
    const out = [];
    out.push(`开场环境：${state.scene.place}·${state.scene.time}·${state.scene.weather}（${state.scene.temp}℃）｜${state.scene.light}`);
    out.push(`气味：${state.scene.smell}`);
    out.push(`场地可用物件：${state.scene.props.join("、")}`);
    state.scene.sounds.forEach(s => out.push(`声音：${s}`));
    for (const b of state.beats) out.push(`拍${b.i + 1}｜${b.whoName}「${b.actZh}」：${b.body}；${b.habit}；环境：${b.envCue}；结果：${b.outcome === "land" ? "戳中" : b.outcome === "backfire" ? "反噬" : b.outcome === "graze" ? "擦边" : "被挡"}（${b.why}）`);
    out.push(`收尾动作（余味）：${state.beats.length ? state.beats[state.beats.length - 1].body : "留一个不解释的动作"}`);
    return out;
  }

  // ── 给第1步 AI 的"文戏素材"文本（不是最终提示词）─────────────────────
  function toDossier(r) {
    const L = [];
    L.push(`【本场文戏】${r.mode === "daily" ? "日常铺陈戏" : r.mode === "group" ? "群戏（三人以上）" : r.mode === "monologue" ? "独白·内心戏" : r.mode === "hybrid" ? "文武混合（先谈后打）" : "双人对峙戏"}｜总时长约 ${r.duration}s｜拆 ${r.shots.length} 镜`);
    L.push(`【场景】${r.scene.place}·${r.scene.time}·${r.scene.weather}（${r.scene.temp}℃）｜${r.scene.light}｜气味：${r.scene.smell}`);
    L.push(`【场地物件】${r.scene.props.join("、")}`);
    L.push(`【环境声】${r.scene.sounds.join("；")}`);
    L.push(`【冲突主题】${r.scene.topic}`);
    L.push(`【在场人物】`);
    r.cast.forEach(c => {
      const sp = (r.speakers || []).find(s => s.name === c.name);
      L.push(`· ${c.name}（${c.styleZh}｜情绪：${c.emotion.dominant} 效价${c.emotion.valence}/唤醒${c.emotion.arousal}｜耐受${c.tolerance}${c.broke ? "·已崩防" : ""}）说：${c.speech.register}味${c.speech.tics && c.speech.tics.length ? "，口癖「" + c.speech.tics.join("／") + "」" : ""}${c.speech.taboo && c.speech.taboo.length ? "，禁忌话题：" + c.speech.taboo.join("、") : ""}｜目标：${c.goal}${c.stake ? "｜赌注：" + c.stake : ""}${c.secret ? "｜有隐情（不可直说）" : ""}`);
      L.push(`  声线（官方要求：说话人首次出现要给足可听身份）：${sp ? sp.id : "（本场不发声 → 不给说话人编号）"}｜${c.voice.gender}·${c.voice.age}｜音色${c.voice.tone}｜语速${c.voice.rate}｜${c.voice.accent}｜${c.voice.onScreen ? "在画内" : "在画外"}`);
      L.push(`  习惯小动作：${c.habit.join("、")}`);
    });
    L.push(`【逐拍素材（台词请你在设计稿里写成自然口语，不要复述这些说明）】`);
    r.beats.forEach(b => {
      L.push(`拍${b.i + 1} [${b.t0}-${b.t1}s｜${b.dur}s｜${b.phase}] ${b.whoName} → ${b.toName}：动作「${b.actZh}」`);
      L.push(`   意图：${b.intent}｜潜台词（不许说出口）：${b.subtext}`);
    L.push(`   说话人：(${b.speakerId}) ${b.whoName}｜${b.delivery === "voiceover" ? "画外音（嘴唇必须不动）" : "面对白（嘴唇张开）"}${b.crossesCut ? "｜这句跨切，交接处要 <scenetrans> 并说明声音继续" : ""}${b.truncated ? "｜这句被片尾截断，要 <cutoff>" : ""}`);
      L.push(`   身体线索：${b.body}；${b.habit}｜环境介入：${b.envCue}`);
      L.push(`   结果：${b.outcome === "land" ? "戳中" : b.outcome === "backfire" ? "反噬" : b.outcome === "graze" ? "擦边" : "被挡"}${b.why ? "（" + b.why + "）" : ""}｜情绪：${b.whoName} ${b.emoActor.key} ${b.emoActor.v} / ${b.toName} ${b.emoTarget.key} ${b.emoTarget.v}｜张力 ${b.tension}`);
    });
    L.push(`【转折点】`);
    r.turns.forEach(t => L.push(`· ${t.t}s ${t.kind}（${t.by}）：${t.desc}`));
    L.push(`【结局】${r.ending.kind}：${r.ending.desc}`);
    if (r.handoff) L.push(`【文武交接】${r.handoff.reason} → 交给武打内核：${r.handoff.A.name}（${r.handoff.A.weapon}/tier${r.handoff.A.tier}）vs ${r.handoff.B.name}（${r.handoff.B.weapon}/tier${r.handoff.B.tier}）`);
    L.push(`【分镜建议（每镜 4~15s）】`);
    r.shots.forEach(s => L.push(`镜${s.i} [${s.t0}-${s.t1}s｜${s.dur}s] ${s.camera}（${s.cameraNote}）｜节拍：${s.acts}｜在镜人：${s.speakers.join("、")}｜张力峰值 ${s.peakTension}｜职责：${s.value}`));
    L.push(`【每镜音频与对白轨（官方 4.4：说话人编号 / 语气 / 时间范围 / 嘴部开合）】`);
    r.shots.forEach(s => L.push(`镜${s.i}：${s.audioTrack}`));
    L.push(`【可拍清单】`);
    r.filmables.slice(0, 24).forEach(f => L.push(`· ${f}`));
    return L.join("\n");
  }

  return { VERSION, EMOTIONS, EMO_ZH, STYLES, ACTS, ACT_ZH, WEATHER, PLACES, SHOTS, PHASES, DAILY_PHASES, mulberry32, simulate, toDossier, packShots, valence, arousal, dominant };
});
