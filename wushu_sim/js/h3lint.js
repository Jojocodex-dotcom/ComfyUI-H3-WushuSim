/* ============================================================================
 * h3lint.js — H3 提示词体检（本地规则引擎，不调用任何大模型 / 不花钱）
 * ----------------------------------------------------------------------------
 * 把「第1步 v9 提示词规则」里的量化红线变成可执行检查：结构字段、镜头数与时间码、
 * 节奏量化、空泛词、主语与双人同框、声音与材质、平台安全、负面词位置，
 * 以及**对白与说话人**（官方 base-en.txt 4.4：说话人编号 / <d> 规范 / 画外音嘴唇 / 跨切与截断 / 声音段不复述台词）。
 * 同一份代码在浏览器（window.H3LINT）与 Node（module.exports）都能跑，方便写测试。
 *
 * 用法：
 *   H3LINT.check(text, { mode:"final"|"design", names:["洪七公","杨过"], weapons:["bang","none"], duration:15 })
 *   -> { score: 0..100, grade:"A".."D", stats:{...}, items:[{id,level,msg,hint,at}] }
 * level: "error" 必须改 | "warn" 建议改 | "info" 提示
 * ========================================================================== */
(function (root, factory) {
  let FL = null;
  try { FL = (typeof module === "object" && module.exports) ? require("./sim3d/combat-logic.js") : (root && root.FIGHT_LOGIC); } catch (e) { FL = null; }
  if (typeof module === "object" && module.exports) module.exports = factory(FL);
  else root.H3LINT = factory(root.FIGHT_LOGIC);
})(typeof globalThis !== "undefined" ? globalThis : this, function (FIGHT_LOGIC) {
  "use strict";

  const VERSION = "h3lint-0.3";

  // ── 官方两套壳的段名（依据随包 h3-skill/base-en.txt、ref-en.txt）──────
  const BASE_SECTIONS = ["integrated_multimodal_description", "overall_soundscape", "non_diegetic_music"];
  const REF_SECTIONS = ["subject_definitions", "summary", "retention_analysis", "detailed_description", "overall_soundscape", "non_diegetic_music"];
  // 旧稿常见错名 → 官方名（发现时报「建议改名」，不冒充官方字段）
  const LEGACY_FIELDS = [["preservation_analysis", "retention_analysis"]];

  // ── 词表（与第1步提示词规则同源）──────────────────────────────────────
  const EMPTY_WORDS = ["很重", "极快", "非常快", "激烈", "爆发", "震撼", "重重一拳", "打得很快", "速度很快", "威力巨大", "气势惊人"];
  const SLOWMO = ["慢动作", "慢镜", "冻帧", "定格", "子弹时间", "slow motion", "freeze frame"];
  const BLOOD = ["喷血", "溅血", "断肢", "开膛", "毙命", "致命伤", "血肉横飞", "锁喉", "勒颈", "插眼"];
  const METAL_SOUND = ["剑鸣", "刀啸", "金属相击", "金属碰撞", "兵器相击", "叮当"];
  const IDLE_OPEN = ["对峙", "凝视", "静静", "站着不动", "相互看着", "缓缓", "慢慢走近", "环顾"];
  // 腾空/悬停必须有借力依据（第1步 v9 规则）；位移不许瞬移
  const AIR_WORDS = ["腾空", "凌空", "悬停", "飞天", "滞空", "半空", "腾起"];
  const AIR_SUPPORT = ["蹬", "踏", "借力", "起跳", "跃", "撑", "墙", "檐", "栏杆", "柱", "梁", "绳索", "台边", "被击飞", "弹起"];
  const TELEPORT = ["瞬移", "闪现", "瞬间消失", "凭空出现", "凭空消失", "瞬身"];
  const NEG_WORDS = ["不要", "禁止", "不许", "不得", "no ", "don't", "avoid "];
  const PLACEHOLDER = [/\{\{[^}]+\}\}/, /【(?:情景|特效等级|身法速度|角色与场景锁定|人物性格|角色设定|电影级打斗|镜头组合|战斗规则)】/, /\bTODO\b/, /XXX/];

  const splitSentences = (t) => String(t || "")
    .split(/[。！？；!?;\n]+/)
    .map(s => s.trim())
    .filter(s => s.length > 0);

  const rxShots = (t) => String(t || "").match(/\[Shot\s*\d+\]/gi) || [];

  // 找到「真正的第 1 镜」正文片段：Ref2VA 的 retention_analysis 里会出现 `(appears in [Shot 1])` 这类引用，
  // 那不是镜头块，不能拿来判断第 1 镜有没有写时间码。
  function firstShot1Segment(t) {
    const re = /\[Shot\s*1\]/gi;
    let m;
    while ((m = re.exec(t))) {
      const before = t.slice(Math.max(0, m.index - 26), m.index);
      const after = t.slice(m.index + m[0].length, m.index + m[0].length + 60);
      if (/(?:appears\s+in|in|见|参见|位于)\s*$|[(（,，]\s*$/.test(before)) continue;   // 引用式出现
      if (/^\s*[)\）,，:：\]】]/.test(after)) continue;
      return after;
    }
    return "";
  }
  const rxTimecodes = (t) => String(t || "").match(/At\s+(\d{1,2}):(\d{2})\.(\d{2,3})/gi) || [];
  const tcToSec = (s) => {
    const m = /(\d{1,2}):(\d{2})\.(\d{2,3})/.exec(s);
    if (!m) return NaN;
    const frac = m[3].length === 2 ? +m[3] / 100 : +m[3] / 1000;
    return (+m[1]) * 60 + (+m[2]) + frac;
  };

  function check(text, opts) {
    opts = opts || {};
    const mode = opts.mode || "final";           // final=成片提示词 / design=第1步设计稿
    const names = (opts.names || []).filter(Boolean);
    const weapons = opts.weapons || [];
    const maxLen = opts.maxLen || 2500;
    const duration = +opts.duration || 0;
    const t = String(text || "");
    const items = [];
    const add = (level, id, msg, hint, at) => items.push({ id, level, msg, hint: hint || "", at: at == null ? "" : at });

    // ── 1. 残留占位符与规则段（成片提示词绝对不能有）────────────────────
    PLACEHOLDER.forEach((re) => {
      const m = re.exec(t);
      if (m) add("error", "placeholder", "残留占位符/规则段：" + m[0], "成片提示词里不能出现 {{变量}} 或【】规则段，请替换为实际内容。", m[0]);
    });
    if (mode === "final" && /【[^】]{2,12}】/.test(t)) add("warn", "ruleblock", "正文里出现了【…】规则段", "H3 不按条款执行；把规则写进动作与镜头里，规则段只作用于润色，不进正文。");

    // ── 2. 结构字段（成片模式）─────────────────────────────────────────
    //    官方两套壳（依据随包 h3-skill/base-en.txt、ref-en.txt）：
    //      基础 T2VA/I2VA/FL2VA/L2VA → integrated_multimodal_description / overall_soundscape / non_diegetic_music
    //      多参考 Ref2VA            → subject_definitions / summary / retention_analysis / detailed_description
    //                                 / overall_soundscape / non_diegetic_music
    const isRef = /subject_definitions\s*:/i.test(t);
    if (mode === "final") {
      if (isRef) {
        REF_SECTIONS.forEach((f) => {
          if (!new RegExp(f + "\\s*:", "i").test(t))
            add("error", "field-" + f, "Ref2VA 缺少段 " + f + ":", "多参考模式按官方六段顺序补齐；主字段是 detailed_description，一致性段是 retention_analysis。");
        });
        LEGACY_FIELDS.forEach(([bad, good]) => {
          if (new RegExp(bad + "\\s*:", "i").test(t))
            add("warn", "ref-legacy-field", `用了旧字段名 ${bad}:`, "官方 Ref2VA 已改名为 " + good + "：（见随包 h3-skill/ref-en.txt），请改名并保留原内容。");
        });
        if (/integrated_multimodal_description\s*:/i.test(t) && !/detailed_description\s*:/i.test(t))
          add("warn", "ref-main-field", "Ref2VA 里用了 integrated_multimodal_description:", "官方对照表：基础模式主字段是 integrated_multimodal_description，多参考模式主字段是 detailed_description。");
      } else {
        BASE_SECTIONS.forEach((f) => {
          if (!new RegExp(f + "\\s*:", "i").test(t)) add("error", "field-" + f, "缺少字段 " + f + ":", "按 MiniMax H3 官方壳补上（第2步应输出这三个核心字段）。");
        });
      }
      const shots = rxShots(t);
      if (!shots.length) add("error", "no-shot", "没有 [Shot N] 分镜", "成片提示词必须有分镜；用「生成/润色」重跑第2步。");
      else {
        // 切镜频率：武打默认少切镜（能一镜到底就一镜到底），4 镜以上基本是切太碎
        if (shots.length >= 6) add("error", "shot-many", `切了 ${shots.length} 镜，切得太碎`, "合并成 1~3 镜：同一场打斗连续拍，用镜头运动（推近/横移/环绕/抬升）代替切镜。");
        else if (shots.length >= 4) add("warn", "shot-many", `切了 ${shots.length} 镜，偏多`, "武打默认 1~3 镜：能一镜到底就一镜到底，景别或小角度变化改用运镜而不是切镜。");
        // 官方：第 1 镜不写时间码；后续镜头以严格递增的切镜时间开头，且必须落在片长以内
        const firstSeg = firstShot1Segment(t);
        if (/\d{1,2}:\d{2}\.\d{2,3}/.test(firstSeg) || /^\s*(?:At\s+)?\d+(?:\.\d+)?\s*[-–~至]\s*\d+/i.test(firstSeg))
          add("warn", "shot1-timecode", "[Shot 1] 带了时间码", "官方规定第一镜不加时间码（风格与开场构图写在 [Shot 1] 之后），时间码从 [Shot 2] 开始写切镜时间。");
        const tcs = rxTimecodes(t).map(tcToSec).filter(n => !isNaN(n));
        let bad = 0;
        for (let i = 1; i < tcs.length; i++) if (tcs[i] <= tcs[i - 1]) bad++;
        if (bad) add("error", "timecode-order", `时间码有 ${bad} 处不递增`, "At MM:SS.mmm 是逐镜的切镜时间，必须严格递增。");
        if (duration && tcs.length) {
          const last = tcs[tcs.length - 1];
          if (last >= duration) add("warn", "timecode-range", `最后一个切镜时间 ${last.toFixed(2)}s 不小于片长 ${duration}s`, "时间码是「切入该镜的时刻」，必须落在片长以内；不要把它写成片长或结束时间。");
          else if (duration >= 6 && last < duration * 0.35) add("info", "timecode-range", `最后一个切镜时间 ${last.toFixed(2)}s 只到片长 ${duration}s 的 ${Math.round(last / duration * 100)}%`, "后面还有很长一段没有切镜；确认是有意的长镜头，或补切镜。");
        }
        // 切镜接续：第 2 镜起，开头必须先交代双方位置/朝向/姿态，否则模型会自己编位置
        const segs = t.split(/\[Shot\s*\d+\]/i).slice(1);
        segs.forEach((seg, i) => {
          if (i === 0 || !seg.trim()) return;
          const head = seg.trim().slice(0, 170);   // 只看这一镜开头的 170 字（不要按句号切，会切碎小数时间码）
          const hasPlace = /在左|在右|左侧|右侧|左边|右边|距|身位|米处|米外|面向|朝向|背对|左前|右后|正前方|正后方|下位|上位|\b(?:left|right|facing|behind|in front|across from|distance of|metres?|meters?)\b/i.test(head);
          if (!hasPlace) add("warn", "cut-continuity", `第 ${i + 1} 镜开头没有交代接续位置`, "切镜的第一句要先复述双方此刻的位置、朝向与姿态（接上一镜），否则模型会自己编位置、出现换位或对不上。", `Shot ${i + 1}`);
          const anchor = /同一张脸|同一套|同一人|还是这两人|仍是这两人|原班|不变|same (?:two|face|fighters|costume|weapon|clothing)|unchanged|unaltered|identities locked/i.test(seg);
          if (!anchor) add("info", "cut-identity", `第 ${i + 1} 镜没有重申「还是这两人」`, "每个切镜镜头里补一句 same two fighters, same faces, costumes and weapons — 这是切镜后换人的主要来源。", `Shot ${i + 1}`);
        });
      }
      // Ref2VA 一致性
      if (isRef) {
        const subs = new Set((t.match(/<Subject\s*\d+>/gi) || []).map(s => s.toUpperCase().replace(/\s+/g, "")));
        const pics = new Set((t.match(/<Picture\s*\d+>/gi) || []).map(s => s.toUpperCase().replace(/\s+/g, "")));
        if (!subs.size) add("warn", "ref-subject", "没有 <Subject N> 标签", "多参考模式要用 <Subject N> 锁定两位打斗者与场景。");
        if (subs.size && pics.size && subs.size !== pics.size) add("info", "ref-tags", `标签数量不一致：Subject ${subs.size} 个 / Picture ${pics.size} 个`, "确认每个 Subject 都指向了正确的来源图（一个 Subject 可来自多张图）。");
        if (/<(?:Subject|Picture|Video|Audio)\s*\d+>[^]*?(?:禁止|不许|不要)换/.test(t) === false && /换脸|换衣/.test(t))
          add("info", "ref-recast", "出现了「换脸/换衣」这类否定说法", "官方 Ref2VA 的做法是在 retention_analysis 里正向声明保留项（fully_preserved 等），而不是在正文写否定句。");
      }
    }

    // ── 2b. 招式与特效的写法（首现写全 · 复用写短 · 不许写定义清单）────
    {
      // ① 定义清单式写法：招式A：…／技能1：…／Combo 2: … —— 模型不做符号引用，还会被当标签渲染成字幕
      const codex = t.match(/(?:^|\n)\s*(?:招式|技能|绝招|必杀|combo|skill|move)\s*[A-Za-z0-9一二三四五六七八九十]+\s*[:：]/gi) || [];
      if (codex.length) add("warn", "move-codebook", `正文里有 ${codex.length} 处「招式A：…」这种定义清单写法`, "不要写招式字典：视频模型不做符号引用（后面写「使用招式A」基本会退化成普通挥砍），而且这种标签极可能被渲染成画面字幕。改成「首现写全、复用写短」：第一次用这招时把名称与效果写进那句动作里，之后再写一句「同一…再起」即可。", codex[0].trim().slice(0, 18));
      // ② 纯编号标签泄漏（招式A/技能2 出现在动作句里）
      if (/(?:使用|施展|发动|打出|出)\s*(?:招式|技能|绝招|combo|skill)\s*[A-Za-z0-9一二三四五六七八九十]+\b/i.test(t))
        add("warn", "move-label-leak", "用编号指代招式（如「使用招式A」）", "改成把招式名与效果写出来；编号指代会让模型把它当成画面文字，或干脆出一记普通攻击。");
      // ③ 被反复引用的招式名（引号里的名字出现 ≥2 次）：首次出现附近必须有效果描写
      const quoted = {};
      (t.match(/[「『][^」』]{2,14}[」』]/g) || []).forEach(q => { quoted[q] = (quoted[q] || 0) + 1; });
      const reused = Object.keys(quoted).filter(q => quoted[q] >= 2);
      if (reused.length) {
        const EFFECT = /剑气|刀气|掌风|掌力|拳劲|气劲|劲风|罡气|火焰|火舌|冰霜|雷|电|光刃|残影|冲击波|气浪|震波|碎屑|火星|水花|尘土|blade|energy|flame|shockwave|aura|projectile|slash|gust/i;
        const miss = reused.filter(q => {
          const idx = t.indexOf(q);
          // 把招式名本身从窗口里去掉，否则「十字剑气」里的「剑气」会把自己判成"写了效果"
          const win = t.slice(Math.max(0, idx - 80), idx + 160).split(q).join("");
          return !EFFECT.test(win);
        });
        if (miss.length) add("warn", "move-first-use", `招式名 ${miss[0]} 被引用了多次，但第一次出现时没写效果`, "招式第一次出现要把效果写全：起手 → 轨迹 → 效果实体（形状/颜色/体积/速度）→ 落点结果 → 余波；之后复用只写「同一…再起」+ 一句效果锚点，不要重复整套描写。", miss[0]);
      }
      // ④ 特效无来源/无落点
      const fx = t.match(/剑气|刀气|掌风|掌力|气劲|火焰|火舌|冰霜|雷霆|光刃|冲击波|气浪/gi) || [];
      if (fx.length && !/从|自|由|飞向|直取|扑向|打向|落向|命中|擦过|劈在|砸在|没入|迸出|涌出|炸开|荡开|推出|扫出|toward|into|at the|hits|strikes|bursts|erupts/i.test(t))
        add("warn", "effect-unanchored", `出现 ${fx.length} 处特效词，但没有来源与落点`, "特效必须是一次连贯实体：谁发出、什么形态、怎么飞、落到哪里、结果如何；不许出现无源特效。", fx[0]);
      // ⑤ 多参考模式：反复出现的特效更适合定义成 <Subject N>（官方认的是标签引用，不是"招式A"）
      const fxCount = {};
      fx.forEach(w => { const k = w.toLowerCase(); fxCount[k] = (fxCount[k] || 0) + 1; });
      const repeated = Object.keys(fxCount).filter(w => fxCount[w] >= 2);
      if (isRef && repeated.length) {
        const defined = repeated.filter(w => new RegExp("<Subject\\s*\\d+>[^\\n]{0,80}" + w, "i").test(t));
        if (!defined.length)
          add("info", "effect-subject", `特效「${fx[fx.map(s => s.toLowerCase()).indexOf(repeated[0])]}」反复出现，但没有定义成 <Subject N>`, "官方 Ref2VA 的 <Subject N> 允许把「可复用的可见内容」——包括特效与风格——定义一次后在各镜引用；这才是模型认得的复用机制（自己发明的「招式A」它不认）。");
      }
      // ⑥ 按等级要求内力外放（高手不许写成平A）：等级来自角色卡，由调用方传进来
      const tier = +opts.tier || 0;
      const INNER = /内力|内劲|真气|真罡|罡气|气劲|掌风|掌力|剑气|刀气|拳劲|气刃|气浪|冲击波|法相|气机|qi\b|inner energy|aura|shockwave/i;
      if (tier >= 5 && !INNER.test(t))
        add("warn", "tier-inner", `本场最高等级 ${tier} 级，但正文里看不到任何内力/气劲/剑气外放`, "5 级起必须有离体手段（掌风/剑气/罡气），7 级起气劲要成实体化形；命中瞬间也要写气劲外放。只写兵器互击＝把高手写成平A。");
      if (tier >= 7 && !/气刃|气浪|成环|尘环|丈许|护体|真罡|冲击波|法相|裂纹|崩裂|碎石|残影|shockwave|aura|ring of/i.test(t))
        add("info", "tier-inner-shape", `本场最高等级 ${tier} 级，建议写出气劲的「形」`, "7 级以上气劲要有可看见的形状与体量（丈许气刃、护体真罡、气浪成环、地面裂纹），不要只写「内力一震」。");
      if (tier >= 9 && !/天|山|江|海|星河|法相|万象|天地|崩|裂|倒卷|异象/i.test(t))
        add("info", "tier-cataclysm", "9 级绝世档没有写出天地级异象", "9 级要有改变场地的一击：山石崩裂、气浪成环、江河倒卷、万千法相、身影残像；否则量级撑不住「绝世」。");
    }

    // ── 3. 节奏量化 ───────────────────────────────────────────────────
    const firstBlock = (t.match(/\[Shot\s*1\][\s\S]*?(?=\[Shot\s*2\]|$)/i) || [t])[0];
    const idle = IDLE_OPEN.find(w => firstBlock.includes(w));
    if (idle) add("warn", "start-slow", `开场出现「${idle}」这类空转描写`, "0~0.5 秒就要给对手身份＋距离兵器＋光比，0.3 秒内出第一个有效动作，禁止空镜与对峙开场。");
    const sentences = splitSentences(t.replace(/\[Shot\s*\d+\][^\n]*/gi, ""));
    const avgBeat = shotsCount(t) ? sentences.length / Math.max(1, shotsCount(t)) : sentences.length;
    if (shotsCount(t) && (avgBeat < 1.5 || avgBeat > 7)) add("info", "beat-density", `平均每镜 ${avgBeat.toFixed(1)} 句（一拍一句）`, "每镜 2~4 个有效拍最稳；太少显得空，太多一镜装不下。");
    const slow = SLOWMO.filter(w => new RegExp(w, "i").test(t)).length;
    if (slow > 2) add("warn", "slowmo", `慢动作/定格类词出现 ${slow} 种`, "慢镜与定格全片最多 1~2 处，其余实时速度。");

    // ── 4. 空泛词 ─────────────────────────────────────────────────────
    EMPTY_WORDS.forEach((w) => {
      if (t.includes(w)) add("warn", "empty-word", `空泛强度词「${w}」`, "换成可见的物理事实：接触点＋材质变化＋受力方向＋位移结果＋余波。");
    });

    // ── 5. 主语与双人同框 ─────────────────────────────────────────────
    if (names.length) {
      const shotsText = shotsCount(t) ? t.split(/\[Shot\s*\d+\]/i).slice(1) : [t];
      shotsText.forEach((seg, i) => {
        if (!seg.trim()) return;
        const has = names.filter(n => seg.includes(n)).length;
        if (has < Math.min(2, names.length)) add("warn", "both-fighters", `第 ${i + 1} 段只提到 ${has} 名角色`, "双人对打每一镜都要两人同框露面：谁出招、谁在同一时间格挡/闪避/受击/反打。", `Shot ${i + 1}`);
      });
      if (names.some(n => n) && /角色\s*[AB]/.test(t) && names.some(n => t.includes(n)))
        add("warn", "name-mix", "同时出现「角色A/角色B」与角色真名", "全篇只用一个固定称谓，避免模型把人认错。");
      const noSubject = splitSentences(t).filter(s => s.length > 10 && !names.some(n => s.includes(n)) && !/^(他|她|对方|其|双方|两人)/.test(s) && !/^[A-Za-z0-9<]/.test(s));
      if (noSubject.length) add("warn", "no-subject", `有 ${noSubject.length} 句看不出主语`, "每句都要点名是谁做的（谁出招、谁挨打、谁位移）。", noSubject[0].slice(0, 18) + "…");
    }

    // ── 6. 物理逻辑：腾空要有依据、位移不许瞬移 ────────────────────────
    const airWord = AIR_WORDS.find(w => t.includes(w));
    if (airWord && !AIR_SUPPORT.some(w => t.includes(w)))
      add("warn", "air-unsupported", `写了「${airWord}」但全篇看不到借力依据`, "腾空/悬停必须给依据：蹬墙、踏檐、借栏杆、起跳、被击飞；否则画面里人物会凭空漂在空中。", airWord);
    TELEPORT.forEach(w => {
      if (t.includes(w)) add("warn", "teleport", `出现「${w}」`, "位移要写出路径与耗时（几步、多快、踩到哪里），不许瞬移。");
    });

    // ── 7. 声音与材质 ─────────────────────────────────────────────────
    const unarmedOnly = weapons.length > 0 && weapons.every(w => w === "none");
    if (unarmedOnly) METAL_SOUND.forEach((w) => {
      if (t.includes(w)) add("error", "sound-metal", `双方徒手却出现「${w}」`, "没有金属兵器就不许出现剑鸣/金属声，改成闷响、衣料、呼吸、脚步。");
    });

    // ── 7. 平台安全 ───────────────────────────────────────────────────
    BLOOD.forEach((w) => {
      if (t.includes(w)) add("warn", "blood", `血腥/致命直述「${w}」`, "用动作戏标准词替代：震退、化解、火星溅起、衣袂破损、重心崩溃、失战。");
    });

    // ── 8. 负面词位置 & 长度 ──────────────────────────────────────────
    const neg = NEG_WORDS.filter(w => t.toLowerCase().includes(w));
    if (neg.length) add("info", "neg-in-body", `正文出现否定式措辞（${neg.slice(0, 3).join("、")}…）`, "负面要求放在负面词字段里；Runway Gen-4 只能写正面（写 no X 反而招来 X）。");
    if (t.length > maxLen) add("warn", "length", `长度 ${t.length} 字符，超过 ${maxLen}`, "Kling 上限 2500 字符；把过渡拍并句、删重复受力描写。");

    // ── 9. 场景与情景落实 ─────────────────────────────────────────────
    if (opts.scenarioZh && !t.includes(opts.scenarioZh)) add("info", "scenario-hint", `正文没有出现情景名「${opts.scenarioZh}」`, "情景不写进正文也行，但要确保场地与运动方式体现在动作里（例如追逐战不许改成原地对打）。");

    // ── 10. 对白与说话人（官方 base-en.txt 4.4 / 4.6）────────────────────
    const dBlocks = t.match(/<d>[\s\S]*?<\/d>/g) || [];
    const dOpens = (t.match(/<d>/g) || []).length;
    const dCloses = (t.match(/<\/d>/g) || []).length;
    if (dOpens !== dCloses) {
      add("error", "d-unclosed", `<d> 与 </d> 数量不等（${dOpens}/${dCloses}）`, "每句台词都要闭合：<d>[Chinese] 原句</d>；漏闭合会把后面的正文吃进台词里。");
    }
    if (dBlocks.length) {
      dBlocks.forEach((b, i) => {
        if (!/^\s*\[[A-Za-z\- ]+\]/.test(b.slice(3, -4))) {
          add("error", "d-lang", `第 ${i + 1} 句 <d> 内缺少语言标签`, "官方要求 <d> 内只放语言标签与台词原文（<d>[Chinese] 你来了。</d>），身份与动作写在 <d> 外面。");
        }
      });
      const segs = t.split(/<d>[\s\S]*?<\/d>/);
      let missSpeaker = 0;
      for (let i = 1; i < segs.length; i++) if (!/\(S\d+(?:\s*,\s*S\d+)*\)/.test(segs[i - 1].slice(-260))) missSpeaker++;
      if (missSpeaker) add("error", "speaker-before-d", `${missSpeaker} 句台词前面没有说话人编号 (S1)/(S2)`, "把身份与编号写在 <d> 外面：the grey-bearded man with a low, raspy voice (S1) says: <d>[Chinese] …</d>。");
      const speakers = [];
      (t.match(/\(S\d+(?:\s*,\s*S\d+)*\)/g) || []).forEach(m => m.replace(/[()]/g, "").split(",").forEach(x => { const v = x.trim(); if (speakers.indexOf(v) < 0) speakers.push(v); }));
      if (speakers.length && speakers[0] !== "S1") add("error", "speaker-first", `第一个出现的说话人是 (${speakers[0]})，应为 (S1)`, "编号从 (S1) 起、全片固定；从不发声的角色不给编号。");
      let vo = 0, voBad = 0;
      dBlocks.forEach((b, i) => {
        if (/off-screen voiceover|画外音/i.test((segs[i] || "").slice(-200))) {
          vo++;
          const after = (segs[i + 1] || "").slice(0, 220);
          if (!/lips?\s+(?:remain|stay|are)\s+(?:completely\s+)?closed|mouth\s+(?:remains|stays)\s+closed|lips?\s+do(?:es)?\s+not\s+move|嘴唇[^\n]{0,8}(?:不动|闭合)/i.test(after)) voBad++;
        }
      });
      if (voBad) add("error", "voiceover-lips", `${voBad} 处画外音没有紧跟"嘴唇保持不动"`, "官方写法：… says in an off-screen voiceover: <d>[Language] …</d> while his lips remain completely closed.");
      const stCount = (t.match(/<scenetrans>/gi) || []).length;
      if (stCount % 2) add("warn", "scenetrans-pair", `<scenetrans> 出现 ${stCount} 次（应为偶数）`, "台词跨切时要在切点两侧各写一次 <scenetrans>，并说明声音跨切连续。");
      const lastShot = t.slice(Math.max(0, t.lastIndexOf("[Shot")));
      const lastD = lastShot.match(/<d>([\s\S]*?)<\/d>/);
      if (lastD && !/[。！？.!?…]["'」』）)]?\s*$/.test(lastD[1].replace(/^\s*\[[A-Za-z\- ]+\]\s*/, "").trim())) {
        add("info", "cutoff-hint", "最后一句台词没有收尾标点，像是被片尾截断", "被片尾截断的台词用 <cutoff> 标出（官方 4.4）。");
      }
      const ssIdx = t.indexOf("overall_soundscape:");
      if (ssIdx >= 0) {
        const rest = t.slice(ssIdx + 18);
        const nx = rest.search(/\n(?:integrated_multimodal_description|non_diegetic_music|subject_definitions|summary|retention_analysis|detailed_description|preservation_analysis):/);
        const ss = nx >= 0 ? rest.slice(0, nx) : rest;
        const cjk = (x) => String(x).replace(/[^\u4e00-\u9fff]/g, "");
        const repeated = dBlocks.filter(b => { const line = cjk(b); return line.length >= 4 && cjk(ss).indexOf(line) >= 0; }).length;
        if (repeated) add("error", "sound-dialogue-repeat", `overall_soundscape 里重复了 ${repeated} 句台词`, "声音段只写环境声、动作声与非语言人声；台词只出现在正文的 <d> 里（官方 4.6）。");
      }
    }

    // ── 11. 打斗连贯性（核心打斗逻辑：不许发呆、要有因果链与反击）────────
    if (FIGHT_LOGIC && FIGHT_LOGIC.checkPrompt) {
      const fl = FIGHT_LOGIC.checkPrompt(t, { mode: mode === "design" ? "design" : "final" });
      fl.issues.forEach(it => add(it.level, "fight-" + it.code, it.msg, it.hint));
      if (mode === "final" && fl.stats.shots >= 2 && fl.stats.filler === 0) {
        add("error", "fight-no-filler", "② 打斗没有一次脚步或换架（间隙动作），空档会被渲染成静止", "把「垫步逼近／绕半步改角度／换架／拖步蓄势」写进每个空档。");
      }
    }

    // ── 计分 ─────────────────────────────────────────────────────────
    const w = { error: 15, warn: 5, info: 1 };
    let score = 100;
    items.forEach(it => { score -= (w[it.level] || 0); });
    score = Math.max(0, Math.min(100, score));
    const grade = score >= 90 ? "A" : score >= 75 ? "B" : score >= 60 ? "C" : "D";
    return {
      version: VERSION, mode, score, grade, items,
      stats: {
        length: t.length, shots: rxShots(t).length, sentences: sentences.length,
        timecodes: rxTimecodes(t).length,
        errors: items.filter(i => i.level === "error").length,
        warns: items.filter(i => i.level === "warn").length,
        infos: items.filter(i => i.level === "info").length
      }
    };
  }
  function shotsCount(t) { return rxShots(t).length; }

  // ── 七维诊断：把体检项归到「内容 / 运动 / 音频 / 物理逻辑 / 人物真实感 / 风格一致性 / 对白与说话人」──
  //   不满意时先看是哪一维出问题，只改那一维，不用整段重写。
  const DIMENSIONS = [
    { key: "content", zh: "内容与结构", ids: ["placeholder", "ruleblock", "field-integrated_multimodal_description", "field-overall_soundscape", "field-non_diegetic_music", "field-subject_definitions", "field-summary", "field-retention_analysis", "field-detailed_description", "no-shot", "shot-many", "shot1-timecode", "timecode-order", "timecode-range", "cut-continuity", "move-codebook", "move-label-leak", "move-first-use", "length"] },
    { key: "motion", zh: "运动与节奏", ids: ["start-slow", "beat-density", "slowmo", "empty-word", "effect-unanchored", "tier-inner", "tier-inner-shape", "tier-cataclysm"] },
    { key: "audio", zh: "音频", ids: ["sound-metal"] },
    { key: "physics", zh: "物理逻辑", ids: ["air-unsupported", "teleport"] },
    { key: "character", zh: "人物真实感", ids: ["both-fighters", "name-mix", "no-subject", "cut-identity"] },
    { key: "style", zh: "风格一致性", ids: ["ref-legacy-field", "ref-main-field", "ref-subject", "ref-tags", "ref-recast", "effect-subject", "scenario-hint"] },
    { key: "dialogue", zh: "对白与说话人", ids: ["d-unclosed", "d-lang", "speaker-before-d", "speaker-first", "voiceover-lips", "scenetrans-pair", "cutoff-hint", "sound-dialogue-repeat"] },
    { key: "continuity", zh: "打斗连贯性", ids: ["fight-no-filler-motion", "fight-no-causal-chain", "fight-no-counter", "fight-idle-unexplained", "fight-filler-sparse", "fight-no-filler",
      "fight-purposeless-action", "fight-defense-without-threat", "fight-repeat-without-change", "fight-no-purpose-in-skeleton", "fight-no-duration"] }
  ];
  const MARK = { error: "✗", warn: "!", info: "·", ok: "✓" };

  function diagnose(res) {
    const items = (res && res.items) || [];
    const groups = DIMENSIONS.map(d => {
      const hit = items.filter(i => d.ids.indexOf(i.id) >= 0);
      const level = hit.some(i => i.level === "error") ? "error"
        : hit.some(i => i.level === "warn") ? "warn"
        : hit.length ? "info" : "ok";
      return { key: d.key, zh: d.zh, level: level, count: hit.length, items: hit };
    });
    const bad = groups.filter(g => g.level === "error" || g.level === "warn").map(g => g.zh);
    return {
      groups: groups,
      worst: groups.some(g => g.level === "error") ? "error" : groups.some(g => g.level === "warn") ? "warn" : groups.some(g => g.level === "info") ? "info" : "ok",
      verdict: bad.length ? "需要修改：" + bad.join("、") : (groups.some(g => g.level === "info") ? "基本可用，只剩提示项" : "八维全过")
    };
  }

  // 七维诊断报告 → 纯文本
  function diagnoseReport(res) {
    const d = diagnose(res);
    const head = "八维诊断（" + d.verdict + "）：" + d.groups.map(g => MARK[g.level] + g.zh).join("  ");
    const body = d.groups.filter(g => g.level !== "ok").map(g =>
      MARK[g.level] + " " + g.zh + "：" + g.items.map(i => i.msg).slice(0, 4).join("；") +
      (g.items.length > 4 ? "…（共 " + g.items.length + " 项）" : ""));
    return [head].concat(body).join("\n");
  }

  // 体检报告 → 纯文本（方便贴进日志/日志面板）
  function report(res) {
    const lv = { error: "✗ 必改", warn: "! 建议", info: "· 提示" };
    const lines = [`提示词体检 ${res.grade}（${res.score}/100）｜长度 ${res.stats.length} 字，分镜 ${res.stats.shots} 个，时间码 ${res.stats.timecodes} 处`,
      `必改 ${res.stats.errors}｜建议 ${res.stats.warns}｜提示 ${res.stats.infos}`,
      "八维：" + diagnose(res).groups.map(g => MARK[g.level] + g.zh).join("  ")];
    res.items.forEach(it => lines.push(`${lv[it.level] || it.level}  ${it.msg}${it.at ? "（" + it.at + "）" : ""}${it.hint ? "\n      → " + it.hint : ""}`));
    if (!res.items.length) lines.push("没有发现问题：结构、节奏、措辞、声音、物理、一致性与安全各项都过关。");
    return lines.join("\n");
  }

  return { VERSION, check, report, diagnose, diagnoseReport, DIMENSIONS, BASE_SECTIONS, REF_SECTIONS, LEGACY_FIELDS,
    EMPTY_WORDS, SLOWMO, BLOOD, METAL_SOUND, IDLE_OPEN, AIR_WORDS, TELEPORT };
});
