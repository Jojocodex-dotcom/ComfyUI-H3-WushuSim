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
    // 长度上限（2026-09-29 修）：原来写死 `opts.maxLen || 2500` —— 2500 是**可灵 Kling 的建议值**，
    //   于是 H3 的稿子（H3 本身没有字数上限，实测我们自己的 H3 成片两万字符）被报成
    //   「Kling 上限 2500」这种跟平台无关的错误。用户原话：「LAYA 评判管 Kling 什么事呢？
    //   我现在主要还是 MINIMAX H3 的格式为主；要 Kling 的时候按 Kling 的格式导出就行。」
    //   正确口径：① 显式 opts.maxLen 最优先；② 否则按 opts.platform / opts.model 查平台表；
    //   ③ 稿子本身是 H3 格式（带 subject_definitions / detailed_description 等字段）→ 按 H3 处理（不查长度）；
    //   ④ 什么都没给 → 也按主用平台 H3，**绝不再默认套 Kling 的 2500**。
    const PLATFORM_LIMIT = { h3: 0, sora: 0, kling: 2500, jimeng: 2000, vidu: 1500, veo: 3000, runway: 1000, ltx2: 2400 };
    const PLATFORM_ZH = { h3: "MiniMax H3", sora: "Sora 2", kling: "可灵 Kling", jimeng: "即梦", vidu: "Vidu",
                          veo: "Veo 3", runway: "Runway Gen-4", ltx2: "LTX 2.5" };
    const _isH3Text = /subject_definitions:|detailed_description:|integrated_multimodal_description:|overall_soundscape:|non_diegetic_music:/.test(String(text || ""));
    // 认平台：H3 稿带六个字段名；Kling 老语法是「shot 1, 5, words;」这种逗号串
    const _looksKling = /(^|\n)\s*shot\s*\d+\s*,\s*\d+\s*,/.test(String(text || ""));
    const _plat = String(opts.platform || opts.model || (_isH3Text ? "h3" : (_looksKling ? "kling" : "h3"))).toLowerCase();
    const _platZh = PLATFORM_ZH[_plat] || _plat;
    const maxLen = opts.maxLen != null ? +opts.maxLen : (PLATFORM_LIMIT[_plat] == null ? 0 : PLATFORM_LIMIT[_plat]);
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
          // 只看这一镜开头的一段（官方镜头表是**多行**结构：镜头行＋锚点行＋衔接行都在开头，
          //   所以窗口给到 420 字；旧口径只取 170 字，会把锚点行截掉误报"没交代接续位置"）。
          const head = seg.trim().slice(0, 420);
          const hasPlace = /在左|在右|左侧|右侧|左边|右边|距|身位|米处|米外|面向|朝向|背对|左前|右后|正前方|正后方|下位|上位|\b(?:left|right|facing|behind|in front|across from|distance of|metres?|meters?)\b/i.test(head);
          if (!hasPlace) add("warn", "cut-continuity", `第 ${i + 1} 镜开头没有交代接续位置`, "切镜的第一句要先复述双方此刻的位置、朝向与姿态（接上一镜），否则模型会自己编位置、出现换位或对不上。", `Shot ${i + 1}`);
          const anchor = /同一张脸|同一套|同一人|还是这两人|仍是这两人|原班|不变|same (?:two|face|fighters|costume|weapon|clothing)|unchanged|unaltered|identities locked/i.test(seg);
          if (!anchor) add("info", "cut-identity", `第 ${i + 1} 镜没有重申「还是这两人」`, "每个切镜镜头里补一句 same two fighters, same faces, costumes and weapons — 这是切镜后换人的主要来源。", `Shot ${i + 1}`);
        });
        // ── 空间定位与在场（用户反馈：人物在空间的定位有问题、角色会突然改变或缺失）──
        //   出片里"人换位／飘出画面／少一个人"大多不是模型不会拍，而是**提示词里根本没写位置与在场**，
        //   模型只能自己编。这里把"每一镜都要能读到空间读数与在场"变成可执行检查。
        const nA = names[0], nB = names[1];
        const PLACE = /左|右|前|后|侧|正面|背对|面前|背后|画面|镜头|前景|中景|远景|近景|贴着|背身|(?:left|right|foreground|midground|background|front|behind|facing|frame)/i;
        const GAP = /距\s*\d|\d+(?:\.\d+)?\s*(?:米|m\b|metres?|meters?)|贴身|丈|半步|一步|数米|近身|几米|arm'?s length|apart|away/i;
        const AIRW = /腾空|跃起|凌空|飞起|悬空|空中|俯冲|踏空|跃上|离地|(?:airborne|mid-?air|leaps?|diving|hover)/i;
        const HGT = /\d+(?:\.\d+)?\s*(?:米|m\b|metres?|meters?)|半米|一米|两米|丈许|数丈|几米|腰高|胸口高|头顶/i;
        const OFFS = /出画|画面外|画外|入画|画面边缘|边缘|背景里|远处|被击飞出|飞出画面|off-?screen|out of (?:the )?frame|edge of (?:the )?frame|in the background|re-?enters?/i;
        segs.forEach((seg, i) => {
          if (!seg.trim()) return;
          const at = `Shot ${i + 1}`;
          if (!PLACE.test(seg)) add("warn", "stage-position", `第 ${i + 1} 镜读不到任何位置信息`, "每一镜都要能读出「谁在画面哪一侧、谁在前谁在后」：写「A 在画面左侧、B 在画面右侧」这类句子，模型才守得住定位。", at);
          if (!GAP.test(seg)) add("warn", "stage-distance", `第 ${i + 1} 镜没有给两人间距`, "补一个距离读数（如「相距 2.4 米」「贴身半步」）：没有距离，模型会自己决定两人离多远，于是忽远忽近。", at);
          if (AIRW.test(seg) && !HGT.test(seg)) add("warn", "stage-height", `第 ${i + 1} 镜有人腾空但没写高度`, "腾空必须给高度（如「离地约 1.2 米」「跃起两米高」），否则高度成了自由参数，忽高忽低甚至飞出画面。", at);
          const onlyA = nA && seg.indexOf(nA) >= 0 && (!nB || seg.indexOf(nB) < 0);
          const onlyB = nB && seg.indexOf(nB) >= 0 && (!nA || seg.indexOf(nA) < 0);
          if ((onlyA || onlyB) && !OFFS.test(seg))
            add("warn", "who-onscreen", `第 ${i + 1} 镜只写了${onlyA ? nA : nB}，没有交代另一个人在哪`, "每个镜头都要能读到两人；确实只拍一人时，必须写明另一人的去向与回来的时机（被打飞出画／在画面边缘／在背景里／被掩体挡住）。", at);
        });
        // ── 被动方（用户反馈："角色 B 像个弱智一动不动等着挨打"）──────────────────
        //   内核已经修过（连段衰减 / 受身脱出 / 反应优先于计划），但**提示词里也必须写成双向能动**：
        //   一镜里如果只有一方在出手、另一方只被描写成挨打，模型就会把那一方渲染成沙包。
        const ACTV = /攻击|出招|挥|劈|刺|扫|踢|肘|膝|撞|掌|拳|抓|摔|格挡|招架|闪|避|撤|退|翻滚|受身|反击|抢|欺入|绕|跃|撑|扶|起身|压下|逼|追/g;
        segs.forEach((seg, i) => {
          if (!seg.trim()) return;
          const at = `Shot ${i + 1}`;
          const onlyOne = (nA && seg.indexOf(nA) >= 0 && (!nB || seg.indexOf(nB) < 0)) ||
                          (nB && seg.indexOf(nB) >= 0 && (!nA || seg.indexOf(nA) < 0));
          if (onlyOne) return;                                  // 只写一人：交给 who-onscreen 去报
          const cnt = (nm) => {
            if (!nm) return null;
            let c = 0, idx = -1;
            while ((idx = seg.indexOf(nm, idx + 1)) >= 0) {
              const win = seg.slice(Math.max(0, idx - 30), idx + 40);
              ACTV.lastIndex = 0;
              if (ACTV.test(win)) c++;
            }
            return c;
          };
          const ca = cnt(nA), cb = cnt(nB);
          if (ca != null && cb != null && Math.max(ca, cb) >= 3 && Math.min(ca, cb) <= 1)
            add("warn", "passive-fighter", `第 ${i + 1} 镜里 ${ca <= 1 ? nA : nB} 几乎没有动作（对方 ${Math.max(ca, cb)} 个动作）`, "每一镜两个人都是能动的：被压制的一方也要写清它的动作与反应（招架／闪避／受身翻滚／撤步／反击抢一拍），不许只写它挨打；连到第三下之后要给一次受身脱出，把连段打开。", at);
        });
        // ── 切镜接续（用户反馈：2 镜以上像各拍各的片段，第二镜"重新跑"）──────────
        //   一条连续时间线的分镜，从第 2 镜起必须"接住上一镜末帧"：位置、姿态、惯性，
        //   以及**上一镜没做完的那个动作**。缺了这条，视频模型就会把每一镜当成新片段重新起势。
        const CONT = /承接|续接|接住|紧接|接着|延续|继续|顺着|惯性|仍处|尚未|没收完|未完成|上一镜|上镜|前一镜|same take|continues?|picks? up|carry|momentum|unfinished|previous shot/i;
        const MIDACT = /正在「|正在收招|尚未收完|没收完|收招段|判定段|起手段|腾空|离地 ?[0-9]|凌空|惯性朝|尚未落地|滞空/;
        segs.forEach((seg, i) => {
          if (i === 0 || !seg.trim()) return;
          const head = seg.trim().slice(0, 420);
          const at = `Shot ${i + 1}`;
          if (!CONT.test(head))
            add("warn", "cut-handoff", `第 ${i + 1} 镜开头没有"接住上一镜"的续接句`, "连续时间线里每一镜的第一句都要接住上一镜末帧：位置＋姿态＋惯性（以及上一镜没做完的那个动作）。否则模型会把这一镜当成新片段、重新起势。", at);
          const prevTail = (segs[i - 1] || "").trim().slice(-220);
          if (MIDACT.test(prevTail) && !CONT.test(head))
            add("warn", "cut-midaction", `第 ${i} 镜结尾停在动作/腾空中途，第 ${i + 1} 镜没有接着做完`, "在招式或滞空途中切镜时，下一镜必须先接住这一招的余势（把没收完的动作做完、把落势接住），再进下一拍。", at);
          // "重新起势"要排除否定式：稿子里写"不许重新起势/禁止重新站位"是**正确**的写法，
          //   不能把禁令本身当成犯规（实测自检里本程序生成的稿被这条误报过一次）。
          const restartHit = (() => {
            const re = /(重新(?:起势|开打|站定|站好)|再起势|从头开始|\breset\b[^.]{0,20}\bstance\b|starts? (?:fresh|over))/gi;
            let m;
            while ((m = re.exec(head))) {
              const pre = head.slice(Math.max(0, m.index - 16), m.index);
              if (/不许|禁止|不要|不得|never|don'?t|without|no\s/i.test(pre)) continue;
              return m[0];
            }
            return null;
          })();
          if (restartHit)
            add("warn", "cut-restart", `第 ${i + 1} 镜看起来是"重新起势"（${restartHit}）`, "新镜不许重新站位／重新起势：它是同一条时间线上换机位，动作要连着上一镜继续。", at);
        });
        // 全片：身份漂移与瞬移（这两类是"角色突然改变"与"定位跳变"的直接来源）
        if (/换人|换脸|换装|变身|变成另一个人|像是另一个人|另一个人|第三个|多出一个人|换了(?:身|套)?(?:衣|装|服)|another (?:man|fighter|person)|third (?:man|fighter)|recast/i.test(t))
          add("warn", "identity-drift", "出现了「换人／换装／变身／第三个人」这类说法", "身份要锁死：同一张脸、同一发型发色、同一套服装、同一件兵器、同一体型；用正向声明（same two fighters, same faces, same costumes）而不是否定句。");
        if (/瞬间|眨眼间|转眼就|下一秒(?:就)?出现|突然出现在|忽然(?:出现)?在|凭空出现在|直接出现在|闪现在/i.test(t))
          add("warn", "teleport", "出现「瞬间／突然出现在」这类瞬移说法", "位置变化要写过程（垫步、绕步、后跃、被击飞、落地滑步），否则模型会让人物在两帧之间直接跳过去。");
      }
      // Ref2VA 一致性
      if (isRef) {
        const subs = new Set((t.match(/<Subject\s*\d+>/gi) || []).map(s => s.toUpperCase().replace(/\s+/g, "")));
        const pics = new Set((t.match(/<Picture\s*\d+>/gi) || []).map(s => s.toUpperCase().replace(/\s+/g, "")));
        if (!subs.size) add("warn", "ref-subject", "没有 <Subject N> 标签", "多参考模式要用 <Subject N> 锁定两位打斗者与场景。");
        if (subs.size && pics.size && subs.size !== pics.size) add("info", "ref-tags", `标签数量不一致：Subject ${subs.size} 个 / Picture ${pics.size} 个`, "确认每个 Subject 都指向了正确的来源图（一个 Subject 可来自多张图）。");
        if (/<(?:Subject|Picture|Video|Audio)\s*\d+>[^]*?(?:禁止|不许|不要)换/.test(t) === false && /换脸|换衣/.test(t))
          add("info", "ref-recast", "出现了「换脸/换衣」这类否定说法", "官方 Ref2VA 的做法是在 retention_analysis 里正向声明保留项（fully_preserved 等），而不是在正文写否定句。");
        // ── 导演台（MINIMAX H3 控制台）识别口径（2026-09-27 用户：「为什么软件没法正确识别和使用导演台的功能」）──
        //   官方 ref-en.txt：REF 稿 = 六段，**第一行就是 `subject_definitions:`**；而
        //   `wushu_action, 30.0s, 720 frames, 16:9, 24fps, 832x480.` 这类规格行是本地动作 LoRA 的触发词行，
        //   导演台不认（而且 832×480 不是 H3 档位：官方 16:9 是 1344×768）。规格行跑到第一行前面 = 结构识别失败。
        const firstLine = (t.split(/\r?\n/).find(x => x.trim().length) || "").trim();
        if (firstLine && !/^subject_definitions\s*:/i.test(firstLine))
          add("error", "ref-first-line", `REF 稿的第一行不是 subject_definitions:（现在是「${firstLine.slice(0, 24)}…」）`,
            "官方多参考稿第一行就是 `subject_definitions:`——前面不要有任何规格行、注释或标题；时长/画幅/帧率请在导演台控件里设。");
        if (/^wushu_action\b/i.test(firstLine))
          add("warn", "spec-line-legacy", "提示词以 `wushu_action, …s, …frames, 16:9, 24fps, 832x480.` 规格行开头",
            "那是本地动作 LoRA 的触发词行，MINIMAX H3 导演台不认（832×480 也不是 H3 档位：16:9 → 1344×768）。把时长/画幅/帧率放进控制台控件，提示词只留官方字段。");
        // summary 段的任务类型前缀：段名独占一行，前缀在**下一行**（旧口径只看同一行，会误报）
        const sm = /(?:^|\n)summary\s*:[ \t]*\r?\n?([\s\S]{0,160})/i.exec(t);
        const smFirst = sm ? ((sm[1].split(/\r?\n/).find(x => x.trim().length)) || "").trim() : "";
        if (sm && smFirst && !/^\[/.test(smFirst))
          add("warn", "ref-summary-prefix", "summary 段没有以方括号任务类型开头",
            "官方要求 summary 以任务类型开头：角色/场景定妆图写 `[reference generation]`，参考图兼作首帧时写 `[reference generation + keyframe completion]`。");
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

      // ⑦ 特效质感：不能只写「光一闪 / 气劲一震」，要写全「形·色·量·光·破·影」
      const style = String(opts.fxStyle || "high");
      const styleBonus = { realistic: -2, high: 0, xianxia: 1, epic: 2 }[style] || 0;
      const fxLv = +opts.fxLevel || (tier ? Math.max(1, Math.min(9, tier + styleBonus)) : 0);
      const FXW = /气劲|罡气|剑气|刀气|掌风|掌力|灵光|灵气|真元|雷劫|电弧|光柱|法相|星河|剑影|冲击波|气浪|光刃|符箓/;
      if (fxLv >= 4 && FXW.test(t)) {
        const SHAPE = /成环|如膜|涟漪|拖尾|光柱|刃|光幕|漩涡|旋涡|缠|裂痕|环|膜|芒|十字|arc|ring|pillar|spiral|blade|trail|wave/i;
        const COLOR = /金|青|白|紫|赤|红|蓝|银|墨|黑|灰|绿|星辉|霞|琉璃|琥珀|血|暖|冷|gold|cyan|white|purple|crimson|blue|silver|jade|violet|amber/i;
        const SCALE = /\d+(?:\.\d+)?\s*(?:米|丈|尺|步|人高)|半米|一米|丈许|数丈|数米|盈丈|米高|metres?|meters?|storeys?/;
        const LIGHT = /映亮|照亮|反光|投下|长影|勾出轮廓|逆光|光斑|辉光|明暗|天色|映|light|glow|illuminat|rim light|reflection/i;
        const BREAK = /碎石|裂纹|龟裂|开裂|塌陷|崩|碎屑|瓦片|尘土|火星|水花|冰屑|剥落|震开|推人|摇晃|crack|shatter|debris|dust|splinter/i;
        const CAMW = /镜头|机位|推近|拉远|横移|环绕|甩镜|升镜|仰拍|俯拍|跟拍|特写|一震|急推|camera|push|pull|track|orbit|whip|low-angle|close-up/i;
        const miss = [];
        if (!SHAPE.test(t)) miss.push("形状");
        if (!COLOR.test(t)) miss.push("颜色");
        if (!SCALE.test(t)) miss.push("体量");
        if (!LIGHT.test(t)) miss.push("光照后果");
        if (!BREAK.test(t)) miss.push("环境破坏");
        if (!CAMW.test(t)) miss.push("镜头反馈");
        if (miss.length >= 3) add("warn", "fx-flat", `特效只写了「有」，缺 ${miss.join("、")}`, "仙侠感来自细节：写清效果实体的形状（成环/如膜/拖尾/光柱）、颜色（金青/紫金/星辉）、体量（几米/丈许）、光照后果（映亮石板/勾出轮廓）、环境破坏（碎石/裂纹/瓦片剥落）、镜头反馈（一震/急推/环绕）。只写「光一闪」「气劲一震」等于没有特效。");
        else if (miss.length) add("info", "fx-detail", `特效还缺 ${miss.join("、")}`, "补上这几项，画面会更像仙侠大片。");
      }
      if (style === "epic" && fxLv >= 5 && !/天地|星辉|星河|法相|光柱|雷劫|万剑|万千剑影|土石浮空|山岳|江河|法则|天象|虚空裂|异象/.test(t))
        add("warn", "fx-spectacle", "选了「仙侠大片」档，但正文里没有天地异象级要素", "大片档至少要有一处：天地变色／星辉光柱／法相虚影／星河倒卷／万千剑影／土石浮空／山岳平移／雷劫降下；并且光效要有照明后果与环境破坏。");
      if (style === "xianxia" && fxLv >= 4 && !/灵气|灵光|符箓|真元|罡|剑芒|剑影|法相/.test(t))
        add("info", "fx-xianxia", "选了「仙侠」档，但没看到灵气/符箓/真元/剑芒这类仙侠词", "补上灵气流转、符箓光纹、真元外放或剑芒拖尾，气质才对得上。");
      if (style === "realistic" && /光柱|法相|星河|雷劫|符箓|灵光/.test(t))
        add("warn", "fx-over", "选了「写实武侠」档，却写了光柱/法相/星河这类仙侠特效", "写实档只保留肉身与兵器的真实反馈（尘土、衣料、骨节闷响、器物碎裂），不要出现光效。");
    }

    // ── 2b. 招式具名形态（用户要求：像「降龙十八掌＝金龙」那样，每一招都要有形有体）──────
    //   参照 B站「免费全能打斗Skill」那两期：观众认得出"这是哪一招"，靠的就是实体气劲的形。
    //   这里只做三件事：①有没有形态 ②形态是不是瞬现瞬灭 ③全场是不是只有一种形。
    {
      const FORM_WORDS = ["金龙", "龙形", "掌印", "掌影", "拳罡", "指劲", "指风", "腿风", "气刃", "月牙", "刀芒", "剑气", "剑影", "剑芒",
        "枪芒", "寒星", "棍罡", "气柱", "爪影", "气团", "气功波", "火柱", "火球", "冰锥", "霜雾", "雷弧", "电弧", "音爆云", "气浪锥", "法相",
        "虚空裂", "万千剑影", "护体光膜", "光膜", "残影", "气劲成形", "气形"];
      const KIND_WORDS = [["金龙", /金龙|龙形|龙首/], ["掌印", /掌印|掌影|巨掌|掌形/], ["拳罡", /拳罡|拳形|罡气拳/], ["指劲", /指劲|指风|一道细线|亮线/],
        ["腿风", /腿风|月牙|气刃/], ["刀芒", /刀芒|刀光成|半月/], ["剑气", /剑气|剑影|剑芒|游丝/], ["枪芒", /枪芒|寒星/], ["棍罡", /棍罡|气柱|棒影/],
        ["爪影", /爪影|五道/], ["气团", /气团|气功波|球形/], ["火柱", /火柱|火球|烈焰|火焰/], ["冰锥", /冰锥|霜雾|冰晶|霜/], ["雷弧", /雷弧|电弧|雷柱/],
        ["音爆云", /音爆云|气浪锥|音爆环/], ["法相", /法相|虚影拔地/], ["剑影", /万千剑影|万剑|剑雨/], ["护体", /护体光膜|光膜|护体罡气/]];
      const ATTACK_VERB = /斩|劈|刺|扫|砸|轰|拍出|推出|击出|打出|踢|鞭腿|肘击|膝撞|爪|一拳|一掌|一刀|一剑/gi;
      const verbHits = (t.match(ATTACK_VERB) || []).length;
      const formHits = FORM_WORDS.filter(w => t.indexOf(w) >= 0).length;
      const kinds = KIND_WORDS.filter(([, re]) => re.test(t)).length;
      const isReal = String(opts.style || opts.fxStyle || "") === "realistic";
      if (isReal && formHits >= 1)
        add("warn", "form-over", `写实武侠档却出现了 ${formHits} 种气劲形态`, "写实档不许有形：只写接触、受力、脚步、器物碎裂与衣料反应。要形态就把特效风格换成「高武」以上。");
      else if (formHits === 0 && verbHits >= 5)
        add("warn", "form-missing", `全篇 ${verbHits} 处出手，却看不到一件具名形态`, "每一招都要有一件看得见、认得出的实体气劲：降龙十八掌＝金龙、劈空掌＝巨大掌印、六脉神剑＝无形剑气、横斩＝半月刀芒、气功波＝球形气团。写法五拍：凝形（起手聚气）→ 成形（脱手/离刃那一刻写清形状·颜色·体量）→ 划空（拖尾/音爆/掠水痕）→ 命中炸开（形在接触点炸成什么）→ 消散（停住再散）。");
      else if (formHits >= 1 && verbHits >= 12 && formHits < 3)
        add("info", "form-few", `${verbHits} 处出手只写了 ${formHits} 种形态`, "把决定性的那几招（终结、隔空、异象爆发）写成完整的具名形态，其余复用可只写一句形态锚点。");
      if (formHits >= 1 && !/停留|停住|停半拍|停一瞬|停了一|悬停|未散|不散|慢慢散|缓缓散|散去|消散|剥落|化成|散成|淡去|褪去|崩散|炸散/.test(t))
        add("warn", "form-vanish", "气劲形态没有「停留→消散」的过程", "形态不许瞬现瞬灭：写出它停留多久（半秒到一秒多），再写怎么散——剥落成金尘、被雨打成白汽、从两端合拢，这样观众才看得清这是哪一招。");
      if (kinds >= 1 && formHits >= 4 && kinds < 3)
        add("info", "form-one-note", `出现了 ${formHits} 处形态词，但只有 ${kinds} 类形态`, "全场不许所有招都用同一种形：掌对掌、刀对刀、法术对法术都要能一眼分清（金龙／掌印／剑气／刀芒／火柱／雷弧各不相同）。");
      if (formHits >= 1 && !/金|银|青|紫|白|赤|橘|蓝|黑|辉|光/.test(t))
        add("info", "form-color", "形态没写颜色", "补一句配色（淡金／正金＋白汽／星辉金＋紫电／青白剑芒／紫金雷），颜色是形态辨识度的一半。");
    }

    // ── 2c. 架式与手法（2026-09-27 用户：「为什么格斗，这对打的角色总要把双拳放在胸口？能不能动作自然一点，
    //   偏散打和武术的风格？」；2026-10-01 用户：「除了打拳击擂台赛，其余的武术打斗情景是不会摆这个动作的」）
    //   ────────────────────────────────────────────────────────────────
    //   模型拿不到架式口径时，会退回最省事的拳击抱架：双拳叠在胸口、两人一个样、全程不变。
    //   2026-10-01 起口径**按兵器分家**：徒手·非擂台＝武术起手架（前手护中线、后手收肋前）；
    //   擂台徒手＝散打/拳击架（后手护颌）；短兵＝持械前指；长兵＝双手持械。抱脸硬扛也一并禁掉。
    {
      const CLICHE = /双拳(抱|叠|收|并)?(在|于)?(一起)?(护)?胸|双手(一起)?(抱|叠|护)(在)?胸|两手叠在胸|拳收胸前|抱拳不动|两拳并拢|双手抱在胸口/g;
      // 禁止句先剥掉（我们自己的素材里写着「不许两人都把双拳叠在胸口」「不许双拳抱在脸前硬扛」）
      const tNoBan = String(t).replace(/(不许|不要|禁止|不得|不是|别把|never|don't|do not|avoid)[^。；\n]{0,60}/gi, '');
      // ⚠ 我们自己的素材里就写着禁令——禁令本身不算犯规（踩过一次：自查时把自己写的禁令判成懒写法）。
      let m = null, mm;
      while ((mm = CLICHE.exec(tNoBan))) { m = mm; break; }
      if (m)
        add("warn", "stance-cliche", `出现「${m[0]}」这类懒写法（双拳叠在胸口）`,
          "换成按兵器分家的架式：徒手（非擂台）＝武术起手架——前手立掌护中线、后手虚握收肋前、两肘下垂护肋（不要摆拳击抱架）；擂台徒手才用散打/拳击架；短兵器＝前手持械前指、尖锋指着对手、后手护肋；长兵器＝双手持械、前手前握、后手握柄尾收腰侧、械尖指向对手眉心。两人手位必须不同，并且随出手变化。");
      // 抱脸硬扛（2026-10-01 用户：「防御动作就是双拳抱着脸硬扛」）
      const FACE_COVER = /(双拳|双手|两拳|两手)(一起)?(抱|护|挡|捂)(住|着)?(了)?(脸|面门|脑袋|头)|抱头(硬)?(扛|挡|挨)|抱脸|护住(了)?脸(不动|硬扛)?|举拳护脸/g;
      const fm = FACE_COVER.exec(tNoBan);
      if (fm)
        add("warn", "guard-face-cover", `出现「${fm[0]}」这种抱脸硬扛`,
          "防御要写手法：格挡写清用**哪个部位或兵器的哪一段**迎击（前臂外侧/前臂内侧/掌根拍击/兵器中段横架/格开/挂开/拨开/云开）以及力往哪卸、重心怎么坐；闪避写清类型（侧闪/后仰摇闪/下潜/绕步换角度/撤步拉开）与让开了哪条线。抱头硬扛不算打斗动作。");
      // 防御手法是否写清：有格挡/闪避字样，却全篇没有任何具体手法词
      const hasDef = /格挡|招架|架住|挡住|防御|闪避|闪开|躲开|让开|卸力/.test(t);
      const hasTech = /前臂|拍格|拍击|拍挡|掌根|横架|横挡|格开|挂开|拨开|挑开|云开|卸力|侧闪|后仰|摇闪|下潜|矮身|沉身|绕步|撤步|错步|跳换步|forearm|parry|slip|duck|weave|sidestep/i.test(t);
      if (hasDef && !hasTech)
        add("warn", "defense-vague", "写了格挡/闪避，但看不出用什么手法、往哪让",
          "补上手法与卸力：格挡＝前臂外侧拍格／前臂内侧格住／兵器中段横架／挂开／拨开，并写接触点与卸力方向；闪避＝侧闪／后仰摇闪／下潜／绕步／撤步，并写清让开了哪条线（刃线从哪一侧擦过）。");
      const hits = (t.match(/正架|反架|架式|侧身站架|前手|后手|护中线|护住中线|收在肋前|护肋|下颌高度|贴腮|沉肩坠肘|含胸拔背|持械|双手持械|弓步|马步|虚步|仆步|歇步|丁步|滑步|垫步|跳换步|转髋|拧腰切胯|前脚掌/g) || []);
      if (hits.length === 0 && /\[Shot\s*\d+\]/.test(t))
        add("info", "stance-missing", "通篇没有架式与手位的写法（只有出手/格挡这类动作词）",
          "补一句架式读数（按兵器分家）：徒手＝前手立掌护中线、后手收肋前；持械＝前手持械前指、后手护肋（长兵双手持械）；再写正架/反架（哪只脚在前）、肘的方向、重心（六成在后腿）、本镜距离带与步法（滑步／垫步／跳换步）。");
    }

    // ── 3. 节奏量化 ───────────────────────────────────────────────────
    const firstBlock = (t.match(/\[Shot\s*1\][\s\S]*?(?=\[Shot\s*2\]|$)/i) || [t])[0];
    const idle = IDLE_OPEN.find(w => firstBlock.includes(w));
    // ── 规模与留痕（用户反馈：仙侠大片的法术/攻击没有"毁天灭地"的感觉）──────────
    //   9 级/仙侠大片档必须写到天地级量级；破坏必须留痕，不能下一镜就复原。
    const tier = +(opts.tier || 0);
    const epicStyle = /大片|epic/i.test(String(opts.style || opts.fxStyle || ""));
    if (tier >= 9 || epicStyle) {
      const CATACLYSM = /法相|天象|天地变色|白昼转暗|星辉|星河倒卷|万千剑影|雷劫|陨|云层|漩涡|漩涡|山岳|削山|断崖|江河倒卷|水墙|地裂|裂谷|环形坑|土石浮空|城池|废墟|林海倒伏|山体/;
      const hits = (t.match(new RegExp(CATACLYSM.source, "g")) || []).length;
      if (hits < 2) add("warn", "fx-scale", `最高 ${tier} 级／仙侠大片档，但正文只看到 ${hits} 处天地级要素`, "按国漫仙侠的场面语法给量级：天象先行（天地变色／云层成漩涡）→ 法相或光柱拔地（仰拍）→ 冲击波改写地形（山体削角／地裂成谷／江河倒卷成水墙／环形坑）→ 碎片尘云穿前景 → 俯拍废墟与裂谷收尾。");
    }
    if (/坑|裂|塌|崩|废墟|断壁|倒伏|焦痕/.test(t) === false && /破坏|炸开|粉碎|震碎|掀飞/.test(t))
      add("warn", "fx-scar", "写了破坏但没写留痕", "破坏必须留痕并跨镜保留：地面留坑／放射状裂纹／成排断墙／倒伏林海／焦痕，不许下一镜复原（这是「毁天灭地」可信度的关键）。");
    if (/废墟|尘埃落定|尘土落下|雨落|余波|还在晃|缓缓散去|渐渐散去/.test(t) === false && (tier >= 8 || epicStyle))
      add("warn", "fx-aftermath", "大片档没有「尘埃落定」的余波画面", "战斗结束后给一个余波镜：尘埃落下、雨点打进坑里、湖面还在晃、只剩废墟与站着的人 —— 大片感一半来自余波。");
    // 出招慢放特写 ＆ 满屏光彩（2026-09-29 用户要求）：好莱坞大片口径——招式要有慢镜特写，大片档的光要铺满画幅
    {
      const hasHero = /慢放|慢镜|时间流速|降速到\s*0?\.\d|slow-?motion|time (ramps|dilat)|slow-?mo/i.test(t);
      if (shotsCount(t) && !hasHero) {
        add("warn", "hero-shot-missing", "全篇没有一处出招慢放特写",
          "用户要求「出招做一个慢放特写」：每一镜挑最重的那一拍写成慢镜特写——镜头 0.2 秒内急推到**全身招式特写**（整个人物头顶到脚＋招式＋技能特效同框，不是大头/局部特写）、时间流速 0.35×、持续约 0.8 秒、气劲与尘土一层层长出来，然后回速、甩镜头拉开；推近要写明「摄影机在动、人物位置不变」。慢放只吃这一小段，不改变本段时长。");
      }
      const bigTier = +((opts && opts.tier) || 0) || (/天地异象|法相|光柱|满屏/.test(t) ? 9 : 0);
      const hasFill = /满屏|充满画(幅|面)|铺满(整)?画(幅|面)|过曝|光溢出|耀斑|lens flare|fills the frame|full-?frame/i.test(t);
      if (bigTier >= 7 && !hasFill) {
        add("warn", "screen-fill-missing", bigTier + " 级大片档，但没有写「光铺满画幅」",
          "用户要求「特效的场面撑大一点、满屏光彩、气功特效」：写成光从接触点溢出来照亮整幅画面、命中处先过曝成白芯再回色、前景有大颗粒碎片与雨滴划过镜头、镜头一震、画面边缘一圈耀斑与色溢。");
      }
    }
    // ── H3 密度体检（2026-09-30 用户转来的评审口径）─────────────────────────────
    //   H3 不是剧本监督：拍太密 / 秒表当控制面 / 特效反复升档 / 空窗句，都会让它"看不动时间轴"。
    //   这几条按 **info** 级给（口径建议，不是必须修），但每条都给出可执行的改法。
    {
      const secs = +((opts && opts.duration) || (opts && opts.seconds) || 0) || 0;
      const beats = (t.match(/第\s*[0-9]+(\.[0-9]+)?\s*秒/g) || []).length;
      const shots = (t.match(/\[Shot\s*\d+\]/gi) || []).length;
      if (beats && secs) {
        const lo = Math.max(8, Math.round(secs * 0.7)), hi = Math.max(12, Math.round(secs * 1.05));
        if (beats > hi) {
          add("info", "h3-density", secs.toFixed(1) + " 秒里写了 " + beats + " 拍（建议 " + lo + "~" + hi + " 拍）",
            "拍太密 H3 会把中间招序合并/乱序：每镜最多留「两记完整招＋一次防守结果」，0.2 秒级的连点整段删掉。");
        }
      }
      if (shots) {
        const per = t.split(/\[Shot\s*\d+\]/i).slice(1).map((s) => (s.match(/第\s*[0-9]+(\.[0-9]+)?\s*秒/g) || []).length);
        const worst = per.length ? Math.max.apply(null, per) : 0;
        if (worst > 5) {
          add("info", "h3-density-shot", "有镜头塞了 " + worst + " 拍（建议 ≤5：两记完整招＋一次防守结果）",
            "单镜容量很小：把这一镜的次要拍合并或删掉，留给两记完整招与它们的接触反馈。");
        }
        if (shots >= 2) {
          const tail = t.split(/\[Shot\s*\d+\]/i).slice(2);
          const joinOk = tail.every((s) => /承接上一镜|carry|Continuing|接上镜/.test(s.slice(0, 160)));
          if (!joinOk) {
            add("info", "h3-handoff", "第 2 镜起没有写「承接上一镜末帧（同一秒表继续）」",
              "段间交接比秒数更重要：每段第一句抄上一段落幅（谁在画面左/右、离镜头远近、站/蹲/倒地、间距几米），并写明「先把上一镜的收势走完、不重新站桩」。");
          }
        }
      }
      const fancy = (t.match(/金紫|虚空黑|灵光|法相|光柱|剑芒|雷弧|满屏光彩/g) || []).length;
      if (fancy > 3) {
        add("info", "h3-fx-once", "升档光效词出现 " + fancy + " 次",
          "特效只升一档一次：留一记招牌（写清形色量），其余回归写实接触反馈——掌风、火星、碎石、衣破、踉跄。");
      }
      if (/持续走位|试探与交手|未逐条描写|本段另有|贴身缠斗/.test(t)) {
        add("info", "h3-filler-beat", "有「持续走位/试探与交手」这类空窗句",
          "空窗句等于把控制权交给模型乱编：要么写成具体的两记招＋一次防守结果，要么删掉这一拍。");
      }
    }
    // 特写口径 ＆ 推镜不许挪人（2026-10-01 用户：「大招特写是对整个人物释放招式的整体动作和技能特效特写，
    //   怎么变成的大头特写」「人物的位置会突然瞬移，应该是镜头描写的问题」）：
    //   根因是素材写成「急推到接触点大特写（占画幅一半以上）」——模型只会给一颗大头；而"推拉"没写清是摄影机在动，
    //   模型就用"挪人/放大人物"来实现推镜，看着就是瞬移。两条都做成机械判定。
    {
      // 先剥掉禁止句（「不许写成…大特写」「never a big-head close-up」），否则自己的禁令会被自己判违规
      const tNoBan = String(t).replace(/(不许|不要|禁止|不是|别把|never|avoid)[^。；\n]{0,50}/gi, '');
      const HEAD_ONLY = /大特写|脸部特写|面部特写|头部特写|只拍(头|脸)|fills half the frame|extreme close-?up|face fills the frame/i;
      const FULL_BODY = /全身|整个人|半身|头顶到脚|全身轮廓|full[- ]?body|whole (fighter|body)|head to feet/i;
      if (HEAD_ONLY.test(tNoBan) && !FULL_BODY.test(t)) {
        add("warn", "hero-head-only", "写了局部大特写（大头/脸部/手部/接触点）却没写全身招式特写",
          "特写口径＝整个人物的招式特写：人物（头顶到脚）＋招式动作＋技能特效同框，占画幅约三分之一到一半；把「大特写／fills half the frame」改成「全身招式特写」，并写明特效不许盖住人物轮廓。");
      }
      const CAM_MOVE = /急推|推近|推轨|拉远|甩镜|变焦|push[- ]?in|dolly[- ]?in|zoom|whip[- ]?pan/i;
      const CAM_SAFE = /人物(位置|不动|不移动)|位置不变|站位不变|摄影机在动|镜头在动|the camera (moves|pushes)|fighters (stay|hold)|do not move the fighters/i;
      if (CAM_MOVE.test(t) && !CAM_SAFE.test(t)) {
        add("warn", "cam-moves-actor", "写了推拉/变焦，但没写明「人物位置不变」",
          "推拉摇移是摄影机在动：写急推/拉近/拉远/甩镜时必须同时写「人物位置不变」——人的画面位置与大小只能来自他自己的步法/起跳/被击飞，否则看着就是瞬移。");
      }
    }
    if (idle) add("warn", "start-slow", `开场出现「${idle}」这类空转描写`, "0~0.5 秒就要给对手身份＋距离兵器＋光比，0.3 秒内出第一个有效动作，禁止空镜与对峙开场。");
    const sentences = splitSentences(t.replace(/\[Shot\s*\d+\][^\n]*/gi, ""));
    const avgBeat = shotsCount(t) ? sentences.length / Math.max(1, shotsCount(t)) : sentences.length;
    if (shotsCount(t) && (avgBeat < 1.5 || avgBeat > 7)) add("info", "beat-density", `平均每镜 ${avgBeat.toFixed(1)} 句（一拍一句）`, "每镜 2~4 个有效拍最稳；太少显得空，太多一镜装不下。");
    const slow = SLOWMO.filter(w => new RegExp(w, "i").test(t)).length;
    if (slow > 2) add("warn", "slowmo", `慢动作/定格类词出现 ${slow} 种`, "慢镜全片最多 1~2 处，其余实时速度；**不要定格/冻帧**，慢放要写清倍率（0.3~0.5×）与时长。");

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
    // ⚠ 只在**该平台真有上限**时才查；文案也必须写清是哪个平台的上限（原来一律写 Kling）
      if (maxLen > 0 && t.length > maxLen) {
        add("warn", "length", `长度 ${t.length} 字符，超过 ${_platZh} 上限 ${maxLen}`,
          `${_platZh} 的单条提示词上限约 ${maxLen} 字符；把过渡拍并句、删掉复读拍与解释性句子。要在别的平台用，请走「导出到 <平台>」的格式，长度按那个平台算。`);
      }

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

    // ── 11-c. 打戏铁律（2026-09-30）────────────────────────────────────────
    //   吸收公开武打/玄幻打斗 SKILL 里**可机械判定**的四条（素材里的【…】提示段会先剥掉再查，
    //   否则铁律块自己列着"禁止双手横架"，会被自己证明自己）：
    //     ① 长时状态动词（模型会把它画成 3 秒静止"架刀发呆互推"）
    //     ② 抽象特效比喻（无受力实体 → 会被画成朝天放烟花）
    //     ③ 工程标记混进正文（模式K/协议C/★/<音效:…>，模型看不懂还占注意力）
    //     ④ 结尾两人贴脸堆叠对推（最后一秒总把两人吸到画面中心架刀）
    {
      // ⚠ 只扫**正文**：优先取 H3 主字段（integrated_multimodal_description / detailed_description）里那一段；
      //   取不到（设计稿、纯分镜文本）才退回"整篇剥掉素材"。两条剥离都要做，因为素材形态有两种：
      //     · 分镜文本里的素材块：`【标题】` + 紧跟的 `·` 子行（真实换行）；
      //     · 证据 JSON 里的 note 字段：整篇是**一行** JSON，换行是转义的 `\n` —— 按物理行剥不掉，
      //       必须按"字段值"剥。实测：不剥就会拿铁律块里"禁止鱼群星河/模式K"当违规（三条误报）。
      const _stripNotes = (x) => String(x)
        .replace(/【[^】\n]{0,60}】[^\n]*(?:\n[·•\-][^\n]*)*/g, "")
        .replace(/"[A-Za-z]*(?:[Nn]ote|hitFeedback)(?:Zh|En)?"\s*:\s*"(?:[^"\\]|\\.)*"/g, "");
      const _fm = /(?:integrated_multimodal_description|detailed_description)\s*[:：]([\s\S]*?)(?=\n(?:overall_soundscape|non_diegetic_music|subject_definitions|summary|retention_analysis|preservation_analysis)\s*[:：]|$)/i.exec(t);
      // 主字段里若夹着素材块（页面把素材注进正文时会出现），也要剥
      const body = _stripNotes(_fm ? _fm[1] : t);
      const stateVerb = body.match(/双手[^。\n]{0,6}(横架|架刀|死死封|死封)|对撞定格|持续(相持|对撞)|相持(不下|被压|僵持)|推刀|架刀(对峙|对推)|死死(架住|顶住|封住)|(脸贴脸|贴脸)[^。\n]{0,4}(对视|对峙)/g);
      if (stateVerb) add("error", "state-verb", "出现了长时状态动词：" + [...new Set(stateVerb)].slice(0, 3).join("、") + "（模型会把它们画成 3 秒静止的架刀互推）", "改成瞬态动词：劈中即分／震退即变招／侧身滑步避开／借反弹力暴退／反手挑刺／中拳滑退。");
      const abstractFx = body.match(/鱼群|星河倒|星海|血月|满天(星|花)|龙卷风般的?(剑|刀|拳)/g);
      if (abstractFx) add("warn", "abstract-fx", "特效用了无受力实体的抽象比喻：" + [...new Set(abstractFx)].slice(0, 3).join("、"), "改成物理矢量：谁、从哪、往哪、多快、扎向对手哪个部位（例：无数柄寒光飞剑自天穹垂直俯冲突刺，迎头扎向刀客头顶）。");
      const tag = body.match(/模式\s*[A-K](?![a-zA-Z])|协议\s*[A-D](?![a-zA-Z])|★|<音效[:：]|【第[一二三四五六七八九十]+段】/g);
      if (tag) add("warn", "engine-tag", "正文里混进了工程标记：" + [...new Set(tag)].slice(0, 3).join("、"), "这些标记模型看不懂还占注意力，把人话写出来（协议、模式只写在素材里）。");
      const tail = body.slice(-160);
      const stack = tail.match(/(贴脸|架刀|对峙|僵持|互推|对推|谁也(没|未))/g);
      if (stack) add("warn", "face-off-ending", "结尾附近出现「" + [...new Set(stack)].slice(0, 3).join("、") + "」——容易收成两人贴脸堆叠对推", "按收尾协议收：A 遗物定场／B 抛飞隔离／C 光粒解构／D 反向错车背向出画硬切；终帧收在最燃那一瞬，**画面仍在运动**（不要静止摆拍、不要定格）。");
    }

    // ── 11-b. 打斗风格 / 角色套路 / 神通（2026-09-25）──────────────────────
    //   风格与套路是"写之前就定好的口径"：正文必须能读出①本场按哪种风格分笔墨
    //   ②每个人主要用什么打、机会来了接什么 ③神通有没有按实测次数出现（不多不少）。
    const STY = opts.styles || null;
    const fstyle = String(opts.fightStyle || "");
    const pats = (opts.patterns || []).filter(p => p && (p.primary || p.pattern));
    // ⚠ 只查**正文**：素材里的【打斗风格】【角色套路】【神通】提示段本身就写着这些名字，
    //   直接拿全文查会"自己证明自己"，永远发现不了"正文里根本没写"。整段（含 · 子行）一起剥掉。
    const tCore = t.replace(/【[^】\n]{0,60}】[^\n]*\n(?:[·•\-][^\n]*\n)*/g, "").replace(/【[^】\n]{0,60}】/g, "");
    if (STY && fstyle) {
      const st = STY.fightStyle(fstyle);
      const spellCount = tCore.match(/法术|气劲|气团|光柱|剑气|掌风|雷|火柱|冰|符|罡|弹道/g);
      const meleeWords = tCore.match(/贴身|贴身缠斗|刀|剑|棍|棒|掌|拳|肘|膝|腿|格挡|架开|相击|磕|撞|扭|缠/g);
      const nMelee = meleeWords ? meleeWords.length : 0, nSpell = spellCount ? spellCount.length : 0;
      const ratio = nSpell / Math.max(1, nMelee + nSpell);
      const want = (st && st.ratio) || {};
      if (fstyle === "melee" && ratio > 0.45) add("warn", "style-ratio", `选了「近战对拼为主」，但正文里法术/气劲类描写占了约 ${Math.round(ratio * 100)}%（要求：${want.spell || "法术 0~1 次"}）`, "把法术压到破局或收尾那一两下，其余拍子全部写贴身交手（兵器相击、格挡、贴身缠斗）。");
      if (fstyle === "caster" && ratio < 0.45) add("warn", "style-ratio", `选了「法术为主」，但正文里法术/气劲类描写只占约 ${Math.round(ratio * 100)}%（要求：${want.spell || "≥60% 的拍是施法" }）`, "把主体改成施法链：结印蓄力→气劲成形→脱手飞行→格挡/闪避→落地余波；近战只留被贴身时的招架。");
      if (fstyle === "aerial" && !/离地|空中|滞空|俯冲|抢高|高度|米高|凌空/.test(tCore)) add("warn", "style-aerial", "选了「空战腾挪为主」，但正文没有高度/滞空的读数", "空战必须给高度与参照物（离地几米、云/山/屋檐/飞散碎石），并按逐秒高度写抢高度→俯冲→拉起的顺序。");
      if (fstyle === "skirmish" && !/撤|脱离|再进|拉开|退开|后跃/.test(tCore)) add("warn", "style-skirmish", "选了「游走一击·打了就走」，但正文没有脱离/再进的节奏", "写成「突进一击→立刻脱离→远程/气劲续压→再突进」，距离在 1 米与 3~5 米之间反复切换。");
    }
    if (pats.length) {
      pats.forEach((p) => {
        const prim = (p.primary || []).slice(0, 4);
        const link = (p.linkNames || []).slice(0, 3);
        const nm = p.name || "角色";
        if (prim.length) {
          const hit = prim.filter(x => x && tCore.indexOf(x) >= 0).length;
          if (!hit) add("warn", "pattern-primary", `${nm} 的主战招式（${prim.join("、")}）在正文里一次都没出现`, "主战招式要占多数拍：先写这些招式，再谈衔接与法术；只写招名不写形制也不行。");
          else {
            // 主次不能反：衔接招式的出现次数不许超过主战招式
            const li = link.filter(x => x && tCore.indexOf(x) >= 0).length;
            if (link.length && li > hit) add("info", "pattern-order", `${nm} 的衔接招式出现 ${li} 处、主战招式只有 ${hit} 处（主次像是反了）`, "衔接招式只在机会出现时用（对手收招/被击退/架势被压开）；多数拍仍应是主战招式。");
          }
        }
        const tr = (p.traits || []).slice(0, 6);
        if (tr.length) {
          const shown = tr.filter(k => tCore.indexOf(k) >= 0).length;
          if (!shown) add("warn", "pattern-trait", `${nm} 有神通（${tr.join("、")}），但正文里没用出来`, "神通要有起手→过程→落点→代价（耗气/时限），用完回到主战招式；不用就把神通从角色卡里去掉。");
        }
      });
    }
    if (mode === "final" && /法相天地|分身术|七十二变|三头六臂|筋斗云|天眼|风火轮/.test(tCore)
        && !/凝|现|变|化|拔毛|掐诀|生|涨|放大|散|收|回到/.test(tCore)) {
      add("info", "trait-form", "神通只写了名称，没有写形制变化", "「法相天地」要写虚影如何拔地而起、多高、如何收；「分身术」要写几个分身、从哪冒出来、怎么消散。");
    }

    // ── 11-c. 特效清单（具名特效件数）与施法时间（2026-09-25 用户要求）──────
    //   用户原话：「这神仙打架怎么跟凡人差不多，高等级的人物打架要法术为主，特效漫天飞，
    //             要写入大量特效的提示词。而且要给足法术施法时间。」
    //   所以体检要能量化两件事：① 正文里到底写了几件"具名特效"；② 每次施法有没有蓄力过程与时长。
    {
      const tier = +(opts.tier || 0);
      const FX = opts.fxLib || null;
      const want = +opts.fxTarget || 0;                    // 本场目标件数（页面按等级×风格×片长算好传进来）
      // 具名特效的判定：正文里出现素材给的那几件的名字，或出现"具名形态"常见的收尾字
      const names = (opts.fxNames || []).filter(Boolean);
      const hits = names.filter((n) => tCore.indexOf(n) >= 0);
      const generic = (tCore.match(/金龙|掌印|拳罡|刀芒|剑气|枪芒|棍罡|气团|火柱|冰锥|雷弧|裂痕|法相|剑影|气浪|音爆|残影|罡气|爪影|光柱|符箓|剑阵|法印|锁链|灵兽|元婴|领域/g) || []);
      const distinct = new Set(generic);
      const fxCount = Math.max(hits.length, distinct.size);
      if (want >= 5 && fxCount < Math.max(3, Math.round(want * 0.6))) {
        add("warn", "fx-count", `本场要求写到 ${want} 件具名特效，正文里只认出约 ${fxCount} 件`,
          "把【特效清单】里挑好的形态写进正文：先写形状与颜色，再写体量（米），最后写它在地面/墙面/水面留下什么；同一招前后同形同色。");
      }
      // 蓄力：高等级（7 级起）每次施法都要有蓄力过程与时长
      if (tier >= 7 && mode === "final") {
        const castWords = (tCore.match(/蓄力|蓄势|结印|掐诀|捏诀|运功|运气|凝气|聚气|气机|灵光聚|蓄满|起手/g) || []).length;
        const castCalls = (tCore.match(/法术|气劲|剑气|术法|咒|法印|符|神通/g) || []).length;
        const seconds = (tCore.match(/\d+(?:\.\d+)?\s*秒|\d+\s*拍/g) || []).length;
        if (castWords < 2) add("warn", "fx-charge", `高等级（${tier} 级）对打里没有写出"蓄力过程"（只认出 ${castWords} 处）`,
          "每次施法按四步写：起手（结印/掐诀/扎马）→ 汇聚（气机往哪聚、衣袍与浮尘被带动）→ 蓄满（一声低鸣/光环收束）→ 脱手；长蓄力可以跨拍。");
        else if (seconds < 2 && castCalls >= 4) add("info", "fx-charge-time", "施法写了蓄力动作，但没有给出时长（秒/拍）", "给蓄力写秒数或拍数（例：「蓄力两拍、约 2 秒」），这是「给足施法时间」最直接的证据。");
      }
      // 法术为主：高等级不该再是满篇近战
      if (tier >= 8 && mode === "final") {
        const spellWords = (tCore.match(/法术|气劲|剑气|术法|咒|法印|符|神通|灵光|异象|光柱|雷|火|冰|风刃|领域/g) || []).length;
        const meleeWords2 = (tCore.match(/贴身|缠斗|拳|掌击|肘|膝|踢|格挡|架住|兵器相击|砍|劈|刺|扫/g) || []).length;
        if (spellWords < meleeWords2) {
          add("warn", "spell-share", `${tier} 级对打里近战描写（${meleeWords2} 处）多于法术描写（${spellWords} 处）`,
            "8 级以上默认「仙神斗法」：主体应是隔空斗法——结印蓄力、法术成形与对撞、法相与天地异象；近战只留被贴身时的招架与挣脱。");
        }
      }
    }

    // ── 11-d. 命中反馈 / 施法朝向 / 跳跃理由 / 切镜锚句（2026-09-25）────────
    //   用户原话：「无意义的跳跃，人物打斗没有面对面，法术释放不是攻击对手，画面切换人物就变人或者直接位置就变了，
    //             空间位置逻辑欠缺，法术击中之后的反馈也不行」。这四条就是它们的可查判据。
    {
      const cutField = (x) => String(x).split(/\n(?:overall_soundscape|non_diegetic_music|integrated_multimodal_description|detailed_description|subject_definitions|summary|retention_analysis|preservation_analysis)\s*:/i)[0];
      // ⚠ 这一组是**跨镜连续性与空间锚点**的检查：必须用**未剥规则段**的正文（t），
      //   因为世界锁定句与锚点行本身就写成【…】/加粗行，用剥过的 tCore 查会"自己看不见自己"。
      const shotsAll = t.split(/(?=\[Shot\s*\d+\])/).filter((x) => /^\[Shot\s*\d+\]/.test(x)).map(cutField);
      const segs = shotsAll.length ? shotsAll : [cutField(t)];
      const has = (seg, re) => re.test(seg);
      const RE_HIT = /打中|击中|命中|震开|拍中|劈中|撞上|砸中/;
      const RE_FORCE = /推出|击退|倒退|踉跄|飞出|退半步|被带得|滑出|掀翻|离地|直退|后仰|栽|翻倒/;
      const RE_SCAR = /裂纹|炸坑|焦|霜|冰壳|水花|碎石|尘|坑|划痕|痕|断壁|倒伏|涟漪|余烬/;
      // 方向交代："从某处发出 + 朝某目标去" 或 "方向动词 + 目标"。目标可以是名字、对手/对方/他。
      const RE_TELL = /(从|自).{0,10}(掌心|指尖|刃口|丹田|枪尖|棒端|剑尖|身侧|腰侧).{0,16}(飞|射|扑|直取|打向|锁向|压向|推|送|轰)|(飞向|直取|锁向|扑向|直奔|打向|拍向|压向|掠向|推向|打出|轰向|追击)[^。；\n]{0,10}(对手|对方|他|孙悟空|二郎神|[一-龥]{2,4})|朝[^。；\n]{0,8}(去|打|飞|拍|压|推)/;
      const RE_WHY = /为|躲|闪开|抢|追|借|避开|脱身|拦|绕到|跟着|落点|压下去|拉起来/;
      // 【场地尺寸】+【逐拍坐标】（2026-09-25 用户要求：「第一次和第二次的润色最好都还是要补充角色每一次运动
      //   XYZ 坐标，场景要描述空间场地大小」）。这两条只在**内核真的给了空间数据**时才查（opts.arena / opts.coord），
      //   否则老路线（没有 3D 结算）会被判"缺坐标"，那是拿不到的数据，属于误伤。
      const AR = opts.arena || null;
      if (AR && (+AR.w || +AR.h)) {
        const w = +AR.w || 0, h = +AR.h || 0, z = +AR.z || 0;
        const num = (v) => { const s = (+v).toFixed(1); return s.replace(/\.0$/, ''); };
        const CN = '[一二三四五六七八九十百两]+(?:点[一二三四五六七八九])?';
        // 数字的两种写法都要认：内核素材里写 "27.0 × 13.5"（一位小数），模型常誊成 "27 × 13"（整数）
        const nums = (v) => { const a = (+v).toFixed(1), b = String(Math.round(+v)); return (a === b ? [a] : [a, b]); };
        const W_NUM = '(' + nums(w).join('|') + '|' + CN + ')';
        const H_NUM = '(' + nums(h).join('|') + '|' + CN + ')';
        const Z_NUM = '(' + nums(z).join('|') + '|' + CN + ')';
        const RE_SIZE = new RegExp(W_NUM + '\\s*(米|m)[^。；\\n]{0,14}(见方|长|宽|×|x)|'
          + '(见方|长|宽|场地|空间|擂台|街道|谷|殿|台)[^。；\\n]{0,16}' + W_NUM + '\\s*(米|m)|'
          + W_NUM + '\\s*(×|x|\\*)\\s*' + H_NUM, 'i');
        const RE_HEIGHT = new RegExp('高[^。；\\n]{0,10}' + Z_NUM + '\\s*(米|m)|'
          + Z_NUM + '\\s*(米|m)[^。；\\n]{0,8}高|'
          + W_NUM + '\\s*(×|x|\\*)\\s*' + H_NUM + '\\s*(×|x|\\*)\\s*' + Z_NUM + '\\s*(米|m)', 'i');
        if (!RE_SIZE.test(tCore)) {
          add('warn', 'scene-size-missing', `全文没有交代场地大小（本场实测 ${num(w)} × ${num(h)} × ${num(z)} 米）`,
            `第一次写到场景时就把尺寸写出来（例：${num(w)} 米见方、${num(z)} 米高的场地），并交代边界在哪——贴墙、撞墙、掉台、出界都要按这个尺寸算距离，不许写出比场地更大的跑动。`);
        } else if (z > 0 && !RE_HEIGHT.test(tCore)) {
          add('info', 'scene-size-missing', `交代了场地长宽，但没有写高度（本场实测 ${num(z)} 米）`,
            '高度决定腾空与飞行能不能成立：写清离地几米、最高点几米、场地顶上有多少余量。');
        }
      }
      // 相对位置：本镜有位移类动作（走位/垫步/跃/退/扑/冲/滑步/绕）却没有任何方位＋距离读数 → 位置写丢了。
      //   ⚠ 2026-09-25 口径变更：**不再查 XYZ 坐标**（用户：「先取消用 XYZ 去控制角色方式吧……视频模型对这些
      //   位置坐标识别不太清楚」），改查相对位置——画面左右 / 离镜头远近 / 相距几米或几步 / 离地多高 /
      //   在对手哪一侧 / 撞在什么参照物上。老调用方仍传 opts.coord，这里当 relpos 用，不炸。
      const RE_LOCO = /垫步|绕步|后跃|后撤|后退|侧闪|翻滚|滑步|扑上|冲上|突进|纵身|跃起|起跳|落地|击退|推出|后退|位移|转身换位|抢位|拉开距离/;
      const RE_RELPOS = /画面(左|右|中)|更靠近镜头|离镜头|纵深|相距\s*\d|距\s*\d+(\.\d+)?\s*米|约\s*\d+\s*步|几步|离地\s*\d|腾空\s*\d|在(对手|他|她)的?(正面|左|右|背)|侧身|背后|边缘|墙角|撞(在|上)|\d+(\.\d+)?\s*米(外|内|远|近)?/;
      const relposOn = !!(opts.relpos || opts.coord || opts.arena);
      // ── 快节奏（2026-09-25 用户：「快动作的话都是奔跑的拼打和追击的，怎么做出来是两个人慢慢走着打」）──
      //   ① "慢慢走近/缓缓逼近"这类慢镜头词：一眼就能抓，任何模式都查
      //   ② 整篇没有冲刺/疾奔的进入写法、没有连打写法：只有在**内核真的给了节奏数据**时才查
      //      （老路线拿不到速度，不该被判"没写冲刺"）
      const RE_SLOWWALK = /慢慢(走|逼|靠|挪|踱|移)|缓缓(走|逼|靠|移动|上前|推进|退)|缓步|徐徐|踱步|慢步|一步步(走|逼近|挪)/;
      if (RE_SLOWWALK.test(tCore)) {
        add('warn', 'tempo-slow', '正文里出现"慢慢走近／缓缓逼近"这类慢镜头写法',
          '快动作片的进入一律是冲刺：写清"几米每秒、冲了几米、几步之内交手"（例：「一个箭步，8 米/秒冲过 4 米，两步就到身前」）；慢镜头词会把整段节奏拖成散步。');
      }
      const T = opts.tempo || null;
      // ── 环境破坏（2026-09-25 用户：「高手打架的招式或法术打倒周围建筑物、道具都是会打碎的。
      //    而不是一点动静都没。越是厉害的人越夸张。」）──
      //   只在**内核真的算出了可破坏物**时才查（opts.destruction），老路线不误伤。
      const DS = opts.destruction || null;
      if (DS && mode === 'final') {
        const RE_BREAK = /碎|裂|塌|崩|折断|断折|炸开|炸裂|掀翻|倒伏|剥落|尘土|尘浪|瓦砾|碎石|碎块|木屑|碎砖|豁口|缺口|坑/g;
        const breaks = (tCore.match(RE_BREAK) || []).length;
        const tier6 = +opts.tier || DS.tier || 1;
        // ① 打了半天一点破坏都没有（等级越高越不该）
        const need = tier6 >= 8 ? 6 : (tier6 >= 5 ? 4 : 2);
        if (breaks < need) {
          add(tier6 >= 7 ? 'warn' : 'info', 'env-destruction',
            `${tier6} 级对打里破坏描写只有 ${breaks} 处（要求 ≥${need}）`,
            '每一次扎实命中／法术落点都要有后果：写清碎了什么（木箱／酒坛／院墙／廊柱／牌楼／山门）、怎么碎、碎片去哪了；'
            + '高等级还要写"没直接碰到也塌"（掌风推平院墙、法术在街上犁出沟）。');
        }
        // ② 量级不配等级：9 级却只写"碎了几块瓦"
        if (tier6 >= 8) {
          const BIG = /塌|崩|折断|掀翻|成粉|碎块悬浮|尘浪|地裂|犁出|推平|整段|半面墙|山门|石塔|牌楼|院墙/g;
          const big = (tCore.match(BIG) || []).length;
          if (big < 2) {
            add('warn', 'env-scale', `${tier6} 级的破坏只写到"碎"这个量级（大结构词汇 ${big} 处，要求 ≥2）`,
              '按等级给量级：8~9 级是"院墙整段塌落、廊柱拦腰折断、山门崩成碎块、碎块悬浮／尘浪掀翻整片场地"；'
              + '只写"碎了几块瓦、扬起一点尘"跟凡人打架没区别。');
          }
        }
        // ③ 内核碎了东西，正文却一件都没点名
        if ((DS.broken || 0) > 0) {
          const kinds = Object.keys(DS.byKind || {});
          const named = kinds.filter((k) => tCore.indexOf(k) >= 0).length;
          if (kinds.length && named === 0) {
            add('info', 'env-destruction',
              `本场内核实测碎了 ${DS.broken} 件（${kinds.join('、')}），正文里一件都没点名`,
              '把内核碎掉的东西写进正文（"酒坛炸开、木箱崩成木屑、院墙塌了半面"），画面与素材才对得上。');
          }
        }
      }
      if (T && mode === 'final') {
        const RE_SPRINT = /冲刺|疾冲|箭步|狂奔|飞奔|疾奔|猛冲|冲上|扑上|突进|掠|抢身位|一蹬|蹬地|抢进|欺身/;
        const RE_CHAIN = /连打|连击|连绵|连环|接连|不停手|追着打|抢招|抢攻|不给他|不让他站稳|乘势再|又是一|跟着就是|紧接着又是一/;
        const RE_CHASE = /追|撵|扑上去|跟上|压上/;
        if (!RE_SPRINT.test(tCore)) {
          add('warn', 'tempo-dash', `全篇没有一次"冲刺/疾奔"的进入写法（内核实测本场冲刺 ${T.dashes || 0} 次、共 ${T.dashDist || 0} 米、峰值 ${T.maxMps || 0} 米/秒）`,
            '进场、拉近、追击都要用冲刺词并带上速度与米数（「8 米/秒冲过 4 米」「一个箭步欺身」）；只写"走近/上去"就是把快动作写成了散步。');
        }
        if ((T.combos || 0) > 0 && !RE_CHAIN.test(tCore)) {
          add('info', 'tempo-combo', `内核实测有 ${T.combos} 段连击（最长 ${T.maxCombo} 连），但正文里读不出"连打"`,
            '交手期写成连打：一拍接一拍（间隔 0.3~0.8 秒）、3~5 连成一段，段落之间才换气；写"又是/紧接着/不等他站稳"这类连接词。');
        }
        if ((T.dashes || 0) > 0 && !RE_CHASE.test(tCore)) {
          add('info', 'tempo-chase', `内核实测有追击冲刺，但正文里没有"追上补打"的写法`,
            '一方被击退/踉跄之后，另一方 0.3~0.8 秒内冲刺追到落点补打；被追的人一边退一边招架，不许被追着走一路。');
        }
      }
      segs.forEach((seg, si) => {
        // 只剥镜头号与时间码（原来连后面 24 个字符一起吃掉，正好把"谁在画面哪侧"啃掉）
        const head = seg
          .replace(/^\[Shot\s*\d+\]\s*/, '')
          .replace(/^(?:At\s+)?\d{1,2}:\d{2}(?:\.\d+)?\s*[,，]?\s*/, '')
          .replace(/^\d+(?:\.\d+)?\s*[-–~至]\s*\d+(?:\.\d+)?\s*s[.。]?\s*/, '')
          .slice(0, 900);      // 多行镜头块：镜头行＋锚点行＋衔接行合起来才算"开头"
        const n = si + 1;
        if (mode === 'final' && RE_HIT.test(seg) && !RE_FORCE.test(seg)) {
          add('warn', 'hit-feedback', `第 ${n} 镜写了命中，但没有受力与位移（人往哪边、退了几步、有没有离地）`,
            '命中那一拍必须写三件事：① 受力方向与位移 ② 对手的状态（收招被打断/踉跄/多久缓过来）③ 留痕（裂纹/焦痕/霜壳/水花/碎石）。');
        } else if (mode === 'final' && RE_HIT.test(seg) && !RE_SCAR.test(seg)) {
          add('info', 'hit-feedback-scar', `第 ${n} 镜命中后没有留下痕迹`, '接触点与地面留痕要写出来，并且跨镜保留：下一镜不许把坑、裂纹、焦痕复原。');
        }
        if (mode === 'final' && (+opts.tier || 0) >= 7 && /法术|气劲|剑气|法印|符|神通|光柱|雷|火|冰/.test(seg) && !RE_TELL.test(seg)) {
          add('warn', 'spell-aim', `第 ${n} 镜有法术但没有"朝向对手"的方向交代`,
            '写清从哪一侧/什么角度放出去、飞了多少米、打向对手哪个位置（例：右掌自腰侧翻出，贴地直取对手前踝）。法术必须是打向对手的。');
        }
        if (/跃起|腾空|纵身|翻身|点地|踏墙|凌空/.test(seg) && !RE_WHY.test(seg)) {
          add('info', 'jump-reason', `第 ${n} 镜的跳跃看不出理由与落点用途`,
            '每次起跳都要给理由（躲来招/抢高度/借墙换位/追落点）并写清落地之后要做什么——没有下文的跳跃就是"无意义的蹦"。');
        }
        // 相对位置：本镜有运动却没有"方位＋距离"读数（2026-09-25 用户：「先取消用 XYZ 去控制角色方式吧，
        //   但是要描述清楚相对位置，感觉视频模型对这些位置坐标识别不太清楚」）——
        //   所以这里不再查坐标，改查**相对位置**：画面左右 / 离镜头远近 / 相距几米或几步 / 离地多高 / 在对手哪一侧。
        if (relposOn && RE_LOCO.test(seg) && !RE_RELPOS.test(seg)) {
          add('warn', 'relpos-missing', `第 ${n} 镜有走位/位移，但没有写清相对位置`,
            '每一次运动都要写"从哪边到哪边、移动了多远、离对手近了多少"：用画面左侧/中间/右侧、更靠近镜头/更远、相距几米（约几步）、离地多高、在对手的正面/左手侧/右手侧/背后来说——**不要写坐标**，视频模型对 (x,y,z) 不敏感。');
        }
        if (mode === 'final' && n > 1) {
          const anchorOk = /画面(左|右|中)|距|相距/.test(head) && (names.some((x) => head.indexOf(x) >= 0) || /同一张脸|同一套|还是这(两)?人|两人/.test(head))
            && /朝|面向|正对|侧身/.test(head);
          if (!anchorOk) add('warn', 'cut-anchor', `第 ${n} 镜开头没有把"谁在哪、离多远、朝哪边、还是这个人"复述清楚`,
            '新镜第一句照抄走位表：谁在画面哪侧、距对方几米、离地多高、朝向哪边，并写明是同一张脸、同一套服装与兵器（否则会换人、会瞬移）。');
          // 跨镜世界锁定（2026-09-25 用户：「这切换镜头和打斗不连贯，一切镜什么都变了」）：
          //   视频模型没有跨镜记忆——新镜不把"同一场/同一套服装兵器/同一光线"再写一遍，它就会重画整个世界。
          const lockOk = /同一张脸|同一套|同一件|同一场|还是这(两)?人|仍是这(两)?人|同样的?(人|服装|兵器)|同一个地点|同一光线|同一场地/.test(seg);
          if (!lockOk) add('warn', 'cut-scene-lock', `第 ${n} 镜没有重申"还是同一场、同一人、同一套服装兵器、同一光线"`,
            '每一镜都要原样抄一遍世界锁定句（同一地点/同一光线/同样两人/同一张脸、同一套服装与兵器），并写明"切镜只换机位"——不重申，视频模型会换人换场地换天色。');
        }
      });
    }

    // ── 11-e. 官方镜头表自检门（MiniMax H3 Step 5.5 六项必检 + 官方硬限）────────────
    //   官方规范：六列标准镜头信息表 → **自检门**（任何一项不过必须改表重跑）→ 才能进分镜。
    //   六项必检里能机械判定的全部落地：①Hook 密度 ②单镜时长 ≤15s ③单镜角色数 ≤3
    //   ④空间锚点继承（地标与光位跨镜一致）⑤逐秒指令覆盖（0s→镜尾无空隙）⑥跨镜连续性（有衔接列）。
    //   另加三条官方硬限：单次生成 4–15 秒、单个 text ≤7000 字符、方括号运镜（[Pan left]）是老语法。
    if (mode === "final") {
      // 官方 §4.1：一个 text 项最多 7000 字符
      if (t.length > 7000)
        add("warn", "prompt-too-long", `提示词 ${t.length} 字符，超过官方单个 text 上限 7000`,
          "按官方口径拆成多次生成（每次一个 [Shot] 段），或把逐秒指令合并成区间、把重复读数只留一次。");
      // 官方 §4.3：方括号运镜是 Hailuo Director 老语法，H3 不认——运镜要写进句子里（运动类型＋幅度＋速度）
      const bracket = t.match(/\[(?:Pan|Tilt|Zoom\s*(?:In|Out)?|Push\s*(?:In|Out)?|Pull\s*(?:In|Out)?|Truck|Pedestal|Arc|Tracking|Static|Shake[^\]]*|POV|Roll[^\]]*|Dolly[^\]]*)\b[^\]]*\]/i);
      if (bracket)
        add("warn", "camera-bracket", `出现了方括号运镜指令 ${bracket[0]}`,
          "H3 不认方括号运镜（那是 Hailuo Director 的老语法）：把运镜写进句子里的自然动作，并给出运动类型＋幅度＋速度（例：The camera pushes in with small amplitude at fast speed）。");
      const HOOKS = ["setup", "visual-joke", "reversal", "reveal", "callback", "suspense", "tender", "chase", "expression-beat", "climax"];
      const STRONG = ["visual-joke", "reversal", "reveal", "suspense", "tender", "climax"];
      const cutField = (x) => String(x).split(/\n(?:overall_soundscape|non_diegetic_music|integrated_multimodal_description|detailed_description|subject_definitions|summary|retention_analysis|preservation_analysis)\s*:/i)[0];
      const segs2 = t.split(/(?=\[Shot\s*\d+\])/).filter((x) => /^\[Shot\s*\d+\]/.test(x)).map(cutField);
      // 只有"官方镜头表形态"的稿子才跑严格结构检查（有 Hook/镜头编号&时长 标记），否则老稿会被误伤
      const tableStyle = /Hook\s*[:：]/i.test(t) || /S\d{2}\s*\/\s*\d/.test(t);
      const hooks = [], marks = [];
      if (segs2.length) {
        segs2.forEach((seg, i) => {
          const n = i + 1, at = `Shot ${n}`;
          const hm = /Hook\s*[:：]\s*([A-Za-z][A-Za-z-]*)/i.exec(seg);
          const hook = hm ? hm[1].toLowerCase() : "";
          if (tableStyle) {
            if (!hook) add("warn", "hook-missing", `第 ${n} 镜没有 Hook 类型`, "官方六列表每一镜都必须有 Hook 类型（setup/visual-joke/reversal/reveal/callback/suspense/tender/chase/expression-beat/climax）——整片 hook 分布自检靠它。", at);
            else if (HOOKS.indexOf(hook) < 0) add("info", "hook-missing", `第 ${n} 镜的 Hook 类型「${hook}」不在官方受控词表里`, "用官方词表：setup / visual-joke / reversal / reveal / callback / suspense / tender / chase / expression-beat / climax。", at);
            if (hook) hooks.push({ n: n, hook: hook });
          }
          // 单镜时长（官方：任何镜头不超过 15 秒；单次生成下限 4 秒）
          const dm = /S\d{2}\s*\/\s*(\d+(?:\.\d+)?)\s*s/i.exec(seg) || /(\d+(?:\.\d+)?)\s*s\s*[》」]/i.exec(seg);
          if (dm) {
            const dur = +dm[1];
            marks.push({ n: n, dur: dur });
            if (dur > 15) add("error", "clip-too-long", `第 ${n} 镜 ${dur} 秒，超过官方单次生成上限 15 秒`, "按节拍安全点拆成两段（每段 4–15 秒）分别生成，切点仍落在动作中间并写好转场。", at);
            else if (dur < 4) add("warn", "clip-too-short", `第 ${n} 镜只有 ${dur} 秒，低于官方单次生成下限 4 秒`, "把这一镜并进相邻镜，或把这一段写长到 4 秒以上。", at);
          }
          if (tableStyle) {
            // 空间锚点卡：地标 / 人物位置（机位视角）/ 光位基线 —— 官方四个子字段里的三个（退场人物可空）
            const noLand = !/固定地标|Fixed landmarks/i.test(seg);
            const noPos = !/人物位置|Character positions/i.test(seg);
            const noLight = !/光位基线|Lighting baseline/i.test(seg);
            // 2026-10-01 口径（用户：「切 SHOT 的时候别把位置又描述一遍，导致镜头一切换人物会瞬移到其他地方」）：
            //   锚点卡**只在第一镜交代一次**；第二镜起改成"一切都从上一镜最后一帧直接续上——这一刀只是换机位"。
            //   重复写位置/地标反而会让模型重新摆位（观众看到的就是瞬移）。
            const laterShot = marks.length > 1;
            const contOK = /只是换机位|from the previous shot|same marks|CAMERA CHANGE ONLY|从上一镜最后一帧直接续上/i.test(seg);
            if (laterShot) {
              if (!contOK)
                add("warn", "anchor-missing", `第 ${n} 镜既没有锚点卡、也没有写"只是换机位"的接续句`,
                  "第二镜起不必重复锚点卡（重复写位置会让模型重新摆位），但必须写明「一切都从上一镜最后一帧直接续上——这一刀只是换机位，位置/朝向/架式/光位不变，不许换边、不许重新入场」。", at);
            } else if (noLand || noPos || noLight)
              add("warn", "anchor-missing", `第 ${n} 镜的空间锚点卡不全（缺 ${[noLand && "固定地标", noPos && "人物位置", noLight && "光位基线"].filter(Boolean).join("、")}）`,
                "官方参考锚点（空间＋身份）四个子字段必填：固定地标（命名地标＋相对画面位置）、人物位置（机位视角：左/中/右＋前/中/后景＋朝向＋姿态）、退场人物状态、光位基线（主光/补光/轮廓光＋本镜调整项）。", at);
            if (!/衔接|Continuity/i.test(seg))
              add("warn", "handoff-missing", `第 ${n} 镜没有「连续性衔接」`, "每一镜都要写清怎么承接上一镜的结束画面（道具位置/眼神/姿态/声桥）以及怎么给下一镜铺钩子——这是官方跨镜连续性主链。", at);
            // 逐秒指令覆盖：从 0s 到镜尾不许留空隙（官方六项必检第 5 条）
            const dirs = seg.split("\n").map((x) => /^\s*(\d+(?:\.\d+)?)\s*[–-]\s*(\d+(?:\.\d+)?)\s*s\b/.exec(x)).filter(Boolean)
              .map((m) => ({ a: +m[1], b: +m[2] }));
            if (!dirs.length) add("warn", "persec-missing", `第 ${n} 镜没有逐秒指令`, "官方强制 Per-Second Directives：按 0–1s／1–2s 拆开，每条覆盖「动作·镜头运动·空间位置·音频线索·交接」五要素，不留时间空隙（亚秒节拍写成 2.0–2.5s）。", at);
            else {
              let gap = null;
              if (dirs[0].a > 0.05) gap = "0–" + dirs[0].a + "s";
              for (let k = 1; k < dirs.length && !gap; k++) if (dirs[k].a - dirs[k - 1].b > 0.05) gap = dirs[k - 1].b + "–" + dirs[k].a + "s";
              const end = dirs[dirs.length - 1].b;
              const want = marks.length && marks[marks.length - 1].n === n ? marks[marks.length - 1].dur : 0;
              if (!gap && want && end < want - 0.15) gap = end + "–" + want + "s（镜尾）";
              if (gap) add("warn", "persec-gap", `第 ${n} 镜的逐秒指令有时间空隙：${gap}`, "官方六项必检第 5 条：从 0s 到镜尾每一秒都必须有指令条目（没事件的秒可以并成区间，但不能整段缺）。", at);
              const missEl = dirs.filter((d) => { const line = seg.split("\n").find((x) => new RegExp("^\\s*" + d.a + "\\s*[–-]").test(x)) || ""; return line && line.length < 12; });
              if (missEl.length) add("info", "persec-thin", `第 ${n} 镜有 ${missEl.length} 条逐秒指令几乎是空的`, "逐秒指令要具体到能直接画分镜面板：写清姿态/表情、镜头运动、空间位置（人物在哪、地标在画面哪里）、音频线索、交接状态。", at);
            }
            // 单镜角色数（官方必检第 3 条：不超过 3 个重要角色）
            if (names.length) {
              const inShot = names.filter((x) => x && seg.indexOf(x) >= 0);
              if (inShot.length > 3) add("warn", "cast-too-many", `第 ${n} 镜出现了 ${inShot.length} 个角色`, "官方自检：任何镜头不超过 3 个重要角色（有画面动作或对白的）。", at);
            }
          }
        });
        // Hook 密度（官方必检第 1 条）：每连续 3 镜至少 1 镜用 reveal/reversal/callback；开场与收尾各带强 hook
        if (hooks.length >= 2) {
          const big = ["reveal", "reversal", "callback", "climax"];
          let win = 0;
          for (let i = 0; i + 2 < hooks.length; i++) {
            if (!big.some((h) => [hooks[i].hook, hooks[i + 1].hook, hooks[i + 2].hook].indexOf(h) >= 0)) win++;
          }
          if (win) add("warn", "hook-density", `有 ${win} 处连续 3 镜里没有 reveal/reversal/callback 这类强 hook`, "官方自检第 1 条：每连续 3 镜至少 1 镜用强 hook（reveal / reversal / callback / climax），开场镜与收尾镜必须各带一个强 hook。");
          const first = hooks[0].hook, last = hooks[hooks.length - 1].hook;
          if (STRONG.indexOf(first) < 0 || STRONG.indexOf(last) < 0)
            add("info", "hook-density", `开场 hook=${first}、收尾 hook=${last}，不都是强 hook`, "官方建议开场镜与收尾镜各带强 hook（visual-joke / reversal / reveal / suspense / tender / climax）。");
        }
        // 空间锚点继承（官方必检第 4 条）：地标必须跨镜一致（或写出"某某从右 1/3 移到中央"这类明确说明）
        const landSets = segs2.map((seg) => {
          const m = /(?:固定地标|Fixed landmarks)[^\n]*/i.exec(seg);
          if (!m) return null;
          return (m[0].match(/[\u4e00-\u9fff]{2,6}＝|[\u4e00-\u9fff]{2,6}\s+-\s+/g) || []).map((s) => s.replace(/[＝\s-]/g, ""));
        }).filter(Boolean);
        if (landSets.length >= 2) {
          const first2 = landSets[0].join("|");
          const drift = landSets.slice(1).filter((s) => s.join("|") !== first2).length;
          if (drift) add("warn", "anchor-drift", `有 ${drift} 镜的固定地标与第 1 镜不一致`, "官方自检第 4 条（空间锚点继承）：同场景多镜时，下一镜的固定地标与光位基线必须与上一镜一致，或明确写出变化原因（如「门框随镜头左环绕由右侧 1/3 移到中央」）——不写清楚就是观众眼里的「空间锚点漂移」。");
        }
      }
    }

    // ── 12. H3 官方硬约束 H 系（2026-10-01 移植自开源 manju-laoli SKILL 包 h3-adapter.md，MIT）──
    //   只收可编程的子集：H2 时间戳 / H5 取材与引用 / H8 否定式 / H9 画外声闭口 / H12 首镜锚定与单主体。
    if (_isH3Text) {
      // H2：[Shot 1] 不带时间戳；后续时间码 MM:SS.mmm 严格递增
      const _shotSegs = t.split(/\[Shot\s*\d+\]/i).slice(1);
      const _first = t.split(/\[Shot\s*\d+\]/i)[1] || "";
      if (_shotSegs.length >= 1) {
        if (/第\s*\d+(\.\d+)?\s*秒|在\s*\d{2}:\d{2}\.\d{3}/.test(_first.split(/第|\d/)[0] + _first.slice(0, 60))) {
          add("warn", "h3-h2-first", "[Shot 1] 开头就带时间戳", "官方口径：首镜不带时间戳（它就是 0 秒），后续镜才用「在 00:04.000 处 / At 00:04.000,」标切点。");
        }
        const _codes = (t.match(/\d{2}:\d{2}\.\d{3}/g) || []).map((c) => { const p = c.split(":"), s = p[1].split("."); return (+p[0]) * 60 + (+s[0]) + (+s[1]) / 1000; });
        let _drift = 0;
        for (let _k = 1; _k < _codes.length; _k++) if (_codes[_k] <= _codes[_k - 1]) _drift++;
        if (_drift) add("warn", "h3-h2-order", "有 " + _drift + " 处时间码没有递增", "H3 切点必须严格递增且 ≤ 段时长；同秒切两刀就合并成一镜。");
      }
      // H5：定义了却没引用的 <Subject N>（白占 9 张参考额度 / 人物凭空消失）；定义 >9 张
      const _defs = (t.match(/<Subject\s*\d+>/gi) || []);
      const _uniqDef = Array.from(new Set(_defs.map((d) => d.toUpperCase())));
      if (_uniqDef.length > 9) add("warn", "h3-h5-limit", "定义了 " + _uniqDef.length + " 个 <Subject N>（参考图上限 9 张）", "Ref2VA 图像 ≤9 张：超限的降级成文字描述写进对应定义行，别占图额度。");
      const _unref = _uniqDef.filter((d) => (t.split(d)[1] || "").split(/<Subject\s*\d+>/i).length >= 1 && !new RegExp(d.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "[\\s\\S]{0,999999}?", "i").test(t.slice(t.toUpperCase().indexOf(d) + d.length)));
      // 简化口径：某定义标签全文只出现 1 次＝定义了但正文没引用
      const _unref2 = _uniqDef.filter((d) => (t.toUpperCase().split(d).length - 1) === 1);
      if (_unref2.length) add("warn", "h3-h5-unref", "定义了却一次没引用：" + _unref2.join("、"), "给了参考却在正文一次没提＝白占 9 张额度、人物凭空消失（H5 兜底）；删掉或在对应镜头里写它。");
      // H8：否定式指导（模型对否定不敏感，被禁词根照旧被渲染）
      const _neg = (t.match(/不要出现|不许出现|禁止出现|不得出现|不要让[^。，]{0,8}出现|画面里没有/g) || []).length;
      if (_neg) add("warn", "h3-h8-negation", "有 " + _neg + " 处否定式指导（不要/禁止出现…）", "H3 正文只写「有什么」：被禁概念的词根留在稿子里就会被渲染——改成正向表述（要什么、是什么样子）。");
      // H9：画外声必须紧跟闭口证据
      if (/画外音|画外声|VO[:：]|OS[:：]/.test(t) && !/闭|闭合|嘴唇|lips/i.test(t)) {
        add("warn", "h3-h9-vo", "有画外音/画外声，但全文没有闭口证据", "官方原生要求：画外声句子后紧跟「嘴唇始终完全闭合 / lips remain completely closed」这类可见证据，否则角色会被拍成在张嘴说话。");
      }
      // H12b/c：首镜并列主体「X 与 Y 同框」、悬空指示代词
      const _anchor = (_shotSegs.length ? _first : t).slice(0, 300);
      if (/与[^。，；]{1,10}\s*同框|同在画面|一同入画/.test(_anchor)) {
        add("warn", "h3-h12-pair", "首镜锚定句是「X 与 Y 同框」并列主体", "锚定句只由单一主体统摄：并列句式会把同一主体的手和脸渲染成两张脸——改成一个人的具名部位/全身。");
      }
      const _dangle = (_anchor.match(/(?<![她他它我的])这[只张条个]|(?<![她他它我的])那[只张条个]/g) || []).length;
      if (_dangle) add("info", "h3-h12-dangle", "首镜有 " + _dangle + " 处悬空指示代词（这只/那张…）", "悬空代词没有归属会被乱渲染：写成「她的那只手」「他的那把刀」——部位必须带主人。");
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
    { key: "content", zh: "内容与结构", ids: ["placeholder", "ruleblock", "engine-tag", "field-integrated_multimodal_description", "field-overall_soundscape", "field-non_diegetic_music", "field-subject_definitions", "field-summary", "field-retention_analysis", "field-detailed_description", "no-shot", "shot-many", "shot1-timecode", "timecode-order", "timecode-range", "cut-continuity", "cut-handoff", "cut-midaction", "cut-restart", "cut-anchor", "cut-scene-lock", "move-codebook", "move-label-leak", "move-first-use", "length",
      "prompt-too-long", "camera-bracket", "clip-too-long", "clip-too-short", "hook-missing", "hook-density", "cast-too-many",
      "h3-h2-first", "h3-h2-order", "h3-h5-limit", "h3-h5-unref", "h3-h8-negation", "h3-h9-vo", "h3-h12-pair", "h3-h12-dangle"] },
    { key: "motion", zh: "运动与节奏", ids: ["start-slow", "beat-density", "slowmo", "empty-word", "effect-unanchored", "tier-inner", "tier-inner-shape", "tier-cataclysm", "fx-flat", "fx-detail", "fx-spectacle", "fx-xianxia", "fx-over", "fx-scale", "fx-scar", "fx-aftermath", "passive-fighter",
      "hit-feedback", "hit-feedback-scar", "spell-aim", "jump-reason", "fx-count", "fx-charge", "fx-charge-time",
      "tempo-slow", "tempo-dash", "tempo-combo", "tempo-chase", "abstract-fx", "hero-head-only",
      "env-destruction", "env-scale",
      "h3-density", "h3-density-shot", "h3-fx-once", "h3-filler-beat",
      "form-missing", "form-few", "form-vanish", "form-one-note", "form-color", "form-over"] },
    { key: "audio", zh: "音频", ids: ["sound-metal"] },
    { key: "physics", zh: "物理逻辑", ids: ["air-unsupported", "teleport", "stage-position", "stage-distance", "stage-height", "scene-size-missing", "relpos-missing", "anchor-missing", "anchor-drift", "persec-missing", "persec-gap", "persec-thin", "stance-cliche", "stance-missing", "cam-moves-actor", "guard-face-cover", "defense-vague"] },
    { key: "character", zh: "人物真实感", ids: ["both-fighters", "name-mix", "no-subject", "cut-identity", "who-onscreen", "identity-drift"] },
    { key: "style", zh: "风格一致性", ids: ["ref-legacy-field", "ref-main-field", "ref-subject", "ref-tags", "ref-recast", "effect-subject", "scenario-hint",
      "ref-first-line", "ref-summary-prefix", "spec-line-legacy"] },
    { key: "dialogue", zh: "对白与说话人", ids: ["d-unclosed", "d-lang", "speaker-before-d", "speaker-first", "voiceover-lips", "scenetrans-pair", "cutoff-hint", "sound-dialogue-repeat"] },
    { key: "continuity", zh: "打斗连贯性", ids: ["handoff-missing", "fight-no-filler-motion", "fight-no-causal-chain", "fight-no-counter", "fight-idle-unexplained", "fight-filler-sparse", "fight-no-filler",
      "fight-purposeless-action", "fight-defense-without-threat", "fight-repeat-without-change", "fight-no-purpose-in-skeleton", "fight-no-duration",
      "state-verb", "face-off-ending", "h3-handoff"] }
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
