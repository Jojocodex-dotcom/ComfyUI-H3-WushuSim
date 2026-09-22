/* ============================================================================
 * ltx2/step2.js — LTX 2.5 提示词规范实现（第2步输出模板 / 改写方言 / 体检器）
 * ----------------------------------------------------------------------------
 * 依据用户提供的《LTX-2.5 官方提示词完整模板规范》（Lightricks LTX-2.5 Prompting Guide）
 * 以及公开规范（Runware《Prompting — LTX-2.5 Pro》、LTX 官方 prompting guide、
 * Omni-Rewriter 的 LTX-2.5 profile）。本地副本见 _template_sources/ltx/。
 *
 * 官方硬规则（本文件逐条落地）：
 *   ① 现在时、连贯散文段落；禁止标签堆砌、禁止列表格式
 *   ② 六要素必须覆盖：建立镜头／设定场景／描述动作／定义角色／镜头运动／描述音频
 *   ③ 动作时序化：每句有实义动词；用「起初／片刻之后／与此同时」推进时间线
 *   ④ 角色：年龄、发型、服装、识别特征；情绪只用身体线索，拒绝抽象词（凶狠/愤怒/恐惧）
 *   ⑤ 镜头运动要写「何时、如何运动」以及运动后主体呈现状态
 *   ⑥ 音频写进正文（环境音／打击声／配乐）；对话包在英文双引号内；没有 soundscape 独立字段
 *   ⑦ 禁止把时长、分辨率、LoRA 权重、采样步数写进提示词（放 ComfyUI 参数面板）
 *   ⑧ 两种范式：单镜头（4~8 句，官方最推荐，适合打斗）与多镜头（原生剪辑，2~4 镜）
 *   ⑨ 多镜头禁令：禁止 [Shot1]／编号列表／slugline（INT./EXT.）；自然语言点名转场
 *   ⑩ 每个切点必须完成 4 件事：点名转场 → 重建新镜头 → 身份一致 → 声明音频跨剪辑
 *   ⑪ 一个镜头只允许一套自洽光源逻辑
 *   ⑫ 不用堆字凑时长（LTX 有 Auto-Duration）
 * 注意：中文文本一律用「」，不出现 ASCII 双引号（转义踩坑）。
 * ========================================================================== */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.LTX2 = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  const VERSION = "ltx2-step2-0.2";

  const GUIDE = [
    "《LTX-2.5 官方提示词完整模板规范》（Lightricks LTX-2.5 Prompting Guide，用户提供）",
    "Runware《Prompting — LTX-2.5 Pro》",
    "LTX 官方 open-source prompting guide / Omni-Rewriter 的 LTX-2.5 profile"
  ];

  const SIX = [
    { key: "shot", zh: "建立镜头", need: "景别、机位、镜头类型（全景/中景/越肩/手持/俯视），电影摄影术语" },
    { key: "scene", zh: "设定场景", need: "光线、色调、材质、环境、氛围；一个镜头只允许一套自洽光源逻辑" },
    { key: "action", zh: "描述动作", need: "时序化连续动作，每句有实义动词（跑/挥/格挡/蹬地）；用「起初／片刻之后／与此同时」推进" },
    { key: "character", zh: "定义角色", need: "年龄、发型、服装、识别特征；情绪只用身体线索，拒绝抽象形容词" },
    { key: "camera", zh: "镜头运动", need: "写明何时、如何运动，以及运动完成后主体呈现状态（推近/拉远/横摇/环绕/跟拍）" },
    { key: "audio", zh: "描述音频", need: "环境音、打击声、配乐；对话包在英文双引号内；不写独立声音字段" }
  ];
  const TRANSITIONS = ["画面硬切至", "视点切至特写", "匹配剪辑衔接到", "画面叠化进"];
  const TRANSITIONS_EN = ["The picture hard-cuts to", "The viewpoint cuts to a close-up of", "A match cut lands on", "The image dissolves into"];
  const TIME_MARKERS = ["起初", "片刻之后", "与此同时"];
  const TIME_MARKERS_EN = ["At first", "A moment later", "At the same time"];
  const NO_MUSIC = "全程没有任何背景音乐，只有原生现场音效";
  const NO_MUSIC_EN = "there is no background music at all, only the native on-location sound effects";
  const CUT_AUDIO_KEEP = "打斗音效跨过剪辑继续播放";
  const CUT_AUDIO_KEEP_EN = "the fight audio carries across the cut without a break";
  const FORBIDDEN_NOTE = "时长／分辨率／LoRA 权重／采样步数一律放在 ComfyUI 参数面板，禁止写进提示词文本内部";

  function sysHead(paradigm) {
    const common = [
      "【输出格式】现在时、连贯散文段落；禁止标签堆砌、禁止列表格式、禁止分镜编号。",
      "【六要素必须覆盖】" + SIX.map(s => s.zh).join("／") + "。",
      "· 建立镜头：" + SIX[0].need,
      "· 设定场景：" + SIX[1].need,
      "· 描述动作：" + SIX[2].need,
      "· 定义角色：" + SIX[3].need,
      "· 镜头运动：" + SIX[4].need,
      "· 描述音频：" + SIX[5].need,
      "【禁用】" + FORBIDDEN_NOTE + "；不要写 overall_soundscape、non_diegetic_music 这类独立字段；不要写 [Shot 1] 与 slugline（INT./EXT.）；不要用多套互相冲突的光源；不要堆字凑时长（LTX 有 Auto-Duration）；不要指望模型生成画面文字 logo。",
      "【语言】正文语言跟随设计稿：设计稿是中文就写中文，是英文就写英文；只输出提示词本体，不要任何说明与标题。"
    ];
    if (paradigm === "multi") {
      return [
        "【LTX 2.5 · 多镜头范式（原生剪辑，2~4 个镜头）· 第2步：只做格式整理】",
        "你是 LTX 2.5 提示词的格式整理员。把定稿的动作设计稿整理成多镜头的 LTX 提示词。",
        ...common,
        "【多镜头写法】镜头切换用自然语言点名转场：" + TRANSITIONS.join("／") + "；每个切点必须完成 4 件事：①点名转场方式 ②重建新镜头（景别、机位、画面人物、光线是否改变）③身份一致性（复用角色视觉标识，如「那名穿深色短打的男子」）④声明音频跨剪辑延续（" + CUT_AUDIO_KEEP + "）或变化。镜头总数 2~4 个，不要更多。",
        "【收尾】最后一句汇总全片声音细节；没有配乐就写「" + NO_MUSIC + "」。"
      ].join("\n");
    }
    return [
      "【LTX 2.5 · 单镜头范式（官方最推荐，适合打斗）· 第2步：只做格式整理】",
      "你是 LTX 2.5 提示词的格式整理员。把定稿的动作设计稿整理成一镜到底的 LTX 提示词。",
      ...common,
      "【单镜头写法】4~8 个句子、一整段；时间线用「" + TIME_MARKERS.join("／") + "」推进；一条主导动作弧从起手贯穿到收势；镜头运动只在段中一次（跟拍／推近／横扫），并写清运动后主体的呈现状态。",
      "【收尾】最后一句写声音：环境音＋打击声＋衣料与呼吸；没有配乐就写「" + NO_MUSIC + "」。"
    ].join("\n");
  }

  const LTX_SYS_SINGLE_DEFAULT = sysHead("single");
  const LTX_SYS_MULTI_DEFAULT = sysHead("multi");
  const LTX_SYS_T2V_DEFAULT = LTX_SYS_SINGLE_DEFAULT;      // 兼容旧名：文生默认走单镜头
  const LTX_SYS_REF_DEFAULT = [
    LTX_SYS_SINGLE_DEFAULT,
    "",
    "【多参考图（Ref2VA）补充】参考图逐张作为 input image 传入，编号与文件名不要写进正文；正文用稳定视觉标识指代角色（如「那名手持木棍的男子」），全段一致；不要重复描述参考图已经决定的脸与服装细节，只写与动作相关的部分。"
  ].join("\n");

  const SCAFFOLD = [
    { key: "shot", zh: "建立镜头", ex: "胸口高度手持跟拍中景镜头" },
    { key: "scene", zh: "设定场景", ex: "雨夜破旧庙宇内，冷青色月光从屋顶破洞洒落，潮湿地面反射水光，空气中漂浮雨雾" },
    { key: "character", zh: "定义角色", ex: "一名短发健壮男子，深色短打劲装，手握短刃；对面高个消瘦男子，灰布粗布短褂，手持长木棍" },
    { key: "action", zh: "时序动作", ex: "起初短刃男子疾步冲刺，打出连续连招……片刻之后木棍男子抓住收招空档侧闪回避，打出后手横拳击中对方肋部……" },
    { key: "camera", zh: "镜头运动", ex: "镜头全程跟随打斗轨迹，受撞击瞬间轻微镜头震动，结尾缓慢拉远" },
    { key: "audio", zh: "音频", ex: "刀刃破空声、木棍格挡撞击闷响、衣料剧烈摩擦、雨水滴落、墙皮碎裂声，两人急促发力喘息声；" + NO_MUSIC }
  ];

  function shellTemplate(opt) {
    opt = opt || {};
    const multi = opt.paradigm === "multi";
    const zh = opt.zh !== false;
    if (!zh) {
      const head = "A chest-height handheld medium tracking shot, two men fighting inside a ruined temple on a rainy night, cold blue moonlight pouring through a hole in the roof, wet stone reflecting the light, rain mist drifting in the air. A stocky man with short hair in a dark short jacket holds a short blade; opposite him a tall lean man in a coarse grey jacket holds a long wooden staff. ";
      const mid1 = TIME_MARKERS_EN[0] + " the blade fighter rushes in and chains his cuts to press the staff man back, who blocks each one and staggers half a step, soles scraping the wet floor, eyes locked on his opponent; " + TIME_MARKERS_EN[1] + " the staff man slips outside on a recovery and lands a rear cross to the ribs; the blade fighter folds forward, slides back and hits the temple wall, plaster crumbling, one knee down to hold himself up while the staff man settles his breathing.";
      const midM = TIME_MARKERS_EN[0] + " the blade fighter rushes in with a chained combination. " + TRANSITIONS_EN[0] + " a side medium shot; the moonlight and the temple stay the same, " + CUT_AUDIO_KEEP_EN + "; the same two men keep fighting, identical faces and clothing, and the man with the staff slips outside on the recovery and lands a rear cross to the ribs, the blade leaving his hand into the mud. " + TRANSITIONS_EN[2] + " a close shot as he hits the temple wall, plaster crumbling, one knee down, the staff fighter breathing on guard.";
      const tail = " The camera follows the whole exchange, shakes briefly on the impact and pulls back slowly at the end, holding on the final posture. " + (multi ? "" : "") + "The audio is blade cutting air, the dull thud of the staff blocking, cloth scraping, rain dripping, plaster cracking, both men breathing hard; " + NO_MUSIC_EN + ".";
      return head + (multi ? midM : mid1) + tail;
    }
    if (multi) {
      return "胸口高度手持跟拍中景镜头，两名男子在雨夜破旧庙宇内搏斗，冷青色月光从屋顶破洞洒落，潮湿地面反射水光，空气中漂浮雨雾。一名短发健壮男子，深色短打劲装，手握短刃；对面高个消瘦男子，灰布粗布短褂，手持长木棍。起初短刃男子疾步冲刺，打出连续连招。画面硬切至侧面中景，重建镜头：景别与机位重新确立、画面人物不变，月光与庙宇环境保持不变，打斗音效跨过剪辑继续播放；那名手持木棍的男子继续动作，视觉标识保持一致，抓住对手收势的空档侧闪回避，打出后手横拳击中对方肋部，短刃脱手摔落在泥水地面。画面硬切至近景镜头，重建镜头：近景、机位压低、画面人物不变，打斗音效跨过剪辑继续播放；那名短发男子后背撞上庙墙，墙皮碎屑剥落，单膝触地撑住身体，木棍男子保持呼吸站姿微动，镜头缓慢拉远，画面停在最后一击之后的姿态上。" + NO_MUSIC + "，只有刀刃破空声、木棍格挡撞击闷响、衣料剧烈摩擦、雨水滴答、金属落地哐当声、墙皮碎裂声响，两人急促发力喘息声。";
    }
    return "胸口高度手持跟拍中景镜头，两人在雨夜破旧庙宇内搏斗，冷青色月光从屋顶破洞洒落，潮湿地面反射水光，空气中漂浮雨雾。一名短发健壮男子，深色短打劲装，手握短刃；对面高个消瘦男子，灰布粗布短褂，手持长木棍。起初短刃男子疾步冲刺，打出连续连招，横斩劈砍持续向对手施压，木棍男子举盾格挡，每受一击踉跄后退半步，鞋底在湿泥地面刮擦，目光始终锁定对手，片刻之后木棍男子抓住收招空档侧闪回避，打出后手横拳击中对方肋部，短刃男子弓背踉跄滑移，后背撞向庙墙，墙皮碎屑剥落，单膝触地撑住身体，木棍男子保持呼吸站姿微动。镜头全程跟随打斗轨迹，受撞击瞬间轻微镜头震动，结尾缓慢拉远，画面停在最后一击之后的姿态上。" + NO_MUSIC + "，只有刀刃破空声、木棍格挡撞击闷响、衣料剧烈摩擦、雨水滴落、墙皮碎裂声响，两人急促发力喘息声。";
  }

  function framesFor(sec) {
    const target = Math.round((+sec || 5) * 24);
    let k = Math.max(1, Math.round((target - 1) / 8));
    let f = 8 * k + 1;
    if (Math.abs(8 * (k + 1) + 1 - target) < Math.abs(f - target)) f = 8 * (k + 1) + 1;
    if (k > 1 && Math.abs(8 * (k - 1) + 1 - target) < Math.abs(f - target)) f = 8 * (k - 1) + 1;
    return f;
  }
  const SIZES = {
    landscape: { w: 1280, h: 704, note: "16:9 横屏（英雄/广播）" },
    landscape_fhd: { w: 1920, h: 1088, note: "16:9 高清" },
    portrait: { w: 1080, h: 1920, note: "9:16 竖屏（Pro API 官方示例）" },
    portrait32: { w: 1088, h: 1920, note: "9:16 竖屏（开源管线用；宽高需 32 的倍数）" }
  };
  function requestHead(opt) {
    opt = opt || {};
    const sec = +opt.seconds || 5;
    const size = SIZES[opt.size] || SIZES.landscape;
    const fps = (+opt.fps === 50) ? 50 : 24;
    const frames = framesFor(sec);
    return [
      "【LTX 2.5 参数面板 —— 这些一律放在 ComfyUI 参数面板，禁止写进提示词文本内部】",
      "模型：LTX-2.5（t2va / i2va / fl2va / ref2va 按输入选）",
      "时长 duration：" + sec + " s（LTX 有 Auto-Duration；6 s 一个干净动作，8~10 s 一小段发展）",
      "帧数 num_frames：" + frames + "（8k+1 网格：k=" + ((frames - 1) / 8) + "）",
      "分辨率：" + size.w + " × " + size.h + "（" + size.note + "）",
      "尺寸约束：开源管线要求宽高均为 32 的倍数（1280×704 / 1920×1088 / 1088×1920）",
      "帧率 fps：" + fps + "（24 电影感 / 50 顺滑运动）",
      "音频：" + (opt.audio === false ? "关闭" : "开启（原生音视频同生成；声音必须写在正文段落里）"),
      "LoRA：wushu_ltx25_v1 —— 权重写在参数面板（LoRA 强度），不要写进提示词" + (opt.loraTrigger ? "；若该 LoRA 需要触发词，把「" + opt.loraTrigger + "」放在正文最前面（官方示例未含触发词）" : ""),
      "采样步数 / CFG：写在参数面板，不要写进提示词",
      opt.refCount ? ("参考图：共 " + opt.refCount + " 张，逐张作为 input image 传入；正文里不要写参考图编号") : "参考图：无"
    ].join("\n");
  }

  function clean(t) {
    return String(t == null ? "" : t)
      .replace(/\[Shot\s*\d+\]/gi, " ")
      .replace(/At\s*\d\d:\d\d\.\d\d\d,?\s*(the camera cuts to)?/gi, " ")
      .replace(/\bthe camera cuts to\b/gi, " ")
      .replace(/\b(integrated_multimodal_description|overall_soundscape|non_diegetic_music|preservation_analysis|detailed_description|subject_definitions|summary)\s*[:：]/gi, " ")
      .replace(/\bwushu_action\b/gi, " ")
      .replace(/\bN\/A\b/gi, " ")
      .replace(/\b(INT|EXT)\.\s*/g, " ")
      .replace(/^\s*(push in|pull out|pan|pans|tilt|truck|pedestal|arc shot|tracking shot|static shot|handheld|dolly in|dolly out|crane up|crane down)[.。]?\s*/i, " ")
      .replace(/^\s*\d+[.、)]\s*/gm, " ")
      .replace(/[ \t]+/g, " ")
      .replace(/\s*[，,；;]\s*(?=[，,；;])/g, " ")
      .replace(/^[，,；;、\s]+|[，,；;、\s]+$/g, "")
      .trim();
  }
  const isZh = (s) => {
    const zhc = (String(s).match(/[\u4e00-\u9fff]/g) || []).length;
    const enc = (String(s).match(/[A-Za-z]/g) || []).length;
    return zhc >= enc / 2;
  };

  function groupActs(acts) {
    if (acts.length <= 4) return acts.map(a => [a]);
    const head = acts.slice(0, 3).map(a => [a]);
    head.push(acts.slice(3));
    return head;
  }
  const joinActs = (a) => (a || []).join("；").replace(/；+/g, "；");

  /** 构造 LTX 2.5 正文（官方范式） */
  function buildParagraph(data, opt) {
    data = data || {}; opt = opt || {};
    const shots = (data.shots || []).slice();
    const src = [data.cast, data.scene, shots.map(s => (s.camera || "") + " " + (s.action || "")).join(" "), data.sound].join(" ");
    const zh = opt.lang ? opt.lang === "zh" : isZh(src);
    const cameras = shots.map(s => clean(s.camera || "")).filter(Boolean);
    const acts = shots.map(s => clean(s.action || "")).filter(Boolean);
    const cast = clean(data.cast || "");
    const scene = clean(data.scene || "");
    const sound = clean(opt.sound != null ? opt.sound : data.sound);
    const dialogue = clean(opt.dialogue != null ? opt.dialogue : data.dialogue);
    const paradigm = opt.paradigm || (acts.length >= 2 ? "multi" : "single");
    const seg = groupActs(acts);
    const parts = [];
    if (zh) {
      parts.push((cameras[0] || "胸口高度手持跟拍中景镜头") + "。" + (scene ? scene + "。" : ""));
      if (cast) parts.push(cast + "。");
      if (paradigm === "multi" && seg.length > 1) {
        seg.forEach((g, i) => {
          if (i === 0) parts.push(TIME_MARKERS[0] + joinActs(g) + "。");
          else {
            const t = TRANSITIONS[(i - 1) % TRANSITIONS.length];
            parts.push(t + "重建镜头：" + (cameras[i] || cameras[0] || "中景") + "，景别与机位重新确立、画面人物不变，" + (scene ? "光线与整体环境保持不变，" : "") + CUT_AUDIO_KEEP + "；" + (cast ? ("那名" + shortIdent(cast) + "继续动作，视觉标识保持一致，") : "") + joinActs(g) + "。");
          }
        });
      } else {
        parts.push(TIME_MARKERS[0] + joinActs(acts) + "。");
      }
      if (dialogue) parts.push('对白：他说 "' + dialogue.replace(/^["「]|["」]$/g, "") + '"。');
      parts.push("镜头全程跟随打斗轨迹" + (cameras.slice(1).length ? "，随后" + cameras.slice(1).join("、") : "") + "，受撞击瞬间轻微镜头震动，结尾缓慢拉远，画面停在最后一击之后的姿态上。");
      const extraZh = sound ? "" : "刀刃破空声、格挡撞击闷响、衣料剧烈摩擦、脚下湿地的刮擦声、";
      parts.push("声音：" + (sound ? sound.replace(/[。.]$/, "") + "、" : "") + extraZh + "两人急促发力喘息声；" + NO_MUSIC + "。");
    } else {
      parts.push((cameras[0] || "A chest-height handheld medium tracking shot") + ". " + (scene ? scene + ". " : ""));
      if (cast) parts.push(cast + ".");
      if (paradigm === "multi" && seg.length > 1) {
        seg.forEach((g, i) => {
          if (i === 0) parts.push(TIME_MARKERS_EN[0] + " " + joinActs(g) + ".");
          else {
            const t = TRANSITIONS_EN[(i - 1) % TRANSITIONS_EN.length];
            parts.push(t + " " + ((cameras[i] || cameras[0] || "a medium shot").toLowerCase()) + " — a fresh frame with the same two men, identical faces and clothing, the light and the location unchanged — " + CUT_AUDIO_KEEP_EN + "; " + joinActs(g) + ".");
          }
        });
      } else {
        parts.push(TIME_MARKERS_EN[0] + " " + joinActs(acts) + ".");
      }
      if (dialogue) parts.push('He says, "' + dialogue.replace(/^["「]|["」]$/g, "") + '".');
      parts.push("The camera follows the whole exchange" + (cameras.slice(1).length ? ", then " + cameras.slice(1).map(c => c.toLowerCase()).join(" then ") : "") + ", shakes briefly on the impact and pulls back slowly at the end, holding on the final posture.");
      const extraEn = sound ? "" : "blade cutting air, the dull thud of a block, cloth scraping, soles on wet ground, ";
      parts.push("The audio is " + (sound ? sound.replace(/[.。]$/, "") + ", " : "") + extraEn + "both men breathing hard; " + NO_MUSIC_EN + ".");
    }
    const text = parts.join(" ").replace(/\s+/g, " ").trim();
    return { text: text, paradigm: paradigm, lang: zh ? "zh" : "en", cuts: (paradigm === "multi" && seg.length > 1) ? seg.length - 1 : 0, shots: shots.length };
  }
  function shortIdent(cast) {
    const m = String(cast).match(/一名([^，。；]{2,10})/);
    if (m) return m[1];
    const m2 = String(cast).match(/([^，。；]{2,8})男子/);
    return m2 ? m2[1] + "男子" : "最先出手的男子";
  }

  // ── 体检器（官方规则可执行化）───────────────────────────────────────
  const TECH_TOKENS = ["1920", "1080", "1280", "704", "1088", "16:9", "9:16", "24fps", "50fps", "fps", "帧数", "分辨率", "num_frames", "8k+1", "LTX", "wushu_action",
    "integrated_multimodal_description", "overall_soundscape", "non_diegetic_music", "preservation_analysis", "detailed_description",
    "lora", "LoRA", "采样步数", "权重"];
  const EMOTION_LABELS = ["他很愤怒", "她很悲伤", "显得很", "凶狠", "愤怒", "恐惧", "悲伤地", "愤怒地",
    "looks relieved", "looks angry", "looks sad", "looks furious", "angrily", "sadly", "furiously", "fearfully"];
  const SHOT_MARKERS = [/\[Shot\s*\d+\]/i, /\bShot\s*\d+\s*[:：]/, /【镜头\s*\d+】/, /At \d\d:\d\d\.\d\d\d/, /\b(INT|EXT)\.\s/, /(^|[。；;\s])\d+[.、)]\s/];
  const AUDIO_HINT = ["audio", "sound", "声音", "ambience", "ambient", "音效", "配乐"];
  const SOUND_FX = ["ring", "rings", "ringing", "thud", "clang", "scuff", "splash", "snap", "snapping", "rustle", "crack", "cracking", "clatter", "creak", "breath", "breathing", "gasp", "grunt", "footstep", "footsteps", "echo", "drip", "hiss", "whoosh", "rumble", "thump",
    "闷响", "短响", "清响", "脆响", "破空", "摩擦", "撕", "撕扯", "溅", "脚步", "呼吸", "回声", "碎裂", "咔", "喀", "嗡", "呼啸", "闷哼", "喘息", "刮擦", "滴落", "哐当", "滴答"];
  const MUSIC_HINT = ["no music", "without music", "不要音乐", "不要配乐", "没有配乐", "无配乐", "无音乐", "没有任何背景音乐", "只有原生现场音效", "music"];
  const CAMERA_CLAUSE_EN = /\b(the camera|camera)\b[^.!?]{0,90}?\b(push|pushes|pull|pulls|track|tracks|tracking along|pan|pans|tilt|tilts|dolly|dollies|crane|cranes|handheld|static|locked|follow|follows|orbit|orbits|settle|settles|hold|holds|drift|drifts|rise|rises|shake|shakes)\b/i;
  const CAMERA_CLAUSE_ZH = /(摄影机|镜头)[^。！？]{0,60}?(推|拉|跟|摇|移|升降|升|降|固定|环绕|稳定|贴地|侧移|跟随|平移|俯|仰|震动|拉远|推近)/;
  const TIME_HINT = ["起初", "片刻之后", "与此同时", "at first", "a moment later", "at the same time"];
  const LIGHTS = ["月光", "阳光", "灯光", "火光", "霓虹", "烛光", "闪电", "moonlight", "sunlight", "lamplight", "firelight", "neon"];

  function wordCount(t) {
    const zh = (String(t).match(/[\u4e00-\u9fff]/g) || []).length;
    const en = (String(t).match(/[A-Za-z][A-Za-z'-]*/g) || []).length;
    return Math.round(en + zh / 1.6);
  }

  function validate(text, opt) {
    opt = opt || {};
    const t = String(text || "").trim();
    const issues = [];
    const lines = t.split(/\n+/).map(s => s.trim()).filter(Boolean);
    const wc = wordCount(t);
    const has = (arr) => arr.some(w => t.toLowerCase().indexOf(String(w).toLowerCase()) >= 0);
    if (!t) { issues.push({ level: "error", code: "empty", msg: "没有内容" }); return { ok: false, issues: issues, stats: {} }; }

    if (lines.length > 1) issues.push({ level: "error", code: "not-single-paragraph", msg: "官方要求连贯散文段落，这里是 " + lines.length + " 段/行", hint: "合并成一段，删掉标题、分行与列表。" });
    SHOT_MARKERS.forEach(re => { if (re.test(t)) issues.push({ level: "error", code: "shot-marker", msg: "出现分镜编号／时间码／slugline／编号列表", hint: "官方禁止 [Shot1]、编号节拍与 INT./EXT.；多镜头要用自然语言点名转场。" }); });
    TECH_TOKENS.forEach(tok => { if (t.indexOf(tok) >= 0) issues.push({ level: "error", code: "tech-token", msg: "正文出现参数「" + tok + "」", hint: FORBIDDEN_NOTE + "（且 LTX 没有 overall_soundscape / non_diegetic_music 字段）。" }); });
    if (/\{\{|\}\}/.test(t)) issues.push({ level: "error", code: "field-residue", msg: "残留占位符", hint: "只输出提示词本体。" });

    const transHit = TRANSITIONS.filter(x => t.indexOf(x) >= 0).concat(TRANSITIONS_EN.filter(x => t.toLowerCase().indexOf(x.toLowerCase()) >= 0));
    const isMulti = transHit.length > 0;
    const mode = opt.mode || (isMulti ? "multi" : "single");
    if (transHit.length > 3) issues.push({ level: "error", code: "too-many-cuts", msg: "切点过多（" + transHit.length + " 处转场）", hint: "官方多镜头一次只允许 2~4 个镜头。" });
    if (isMulti) {
      const positions = [];
      TRANSITIONS.forEach(w => { let i = -1; while ((i = t.indexOf(w, i + 1)) >= 0) positions.push(i); });
      TRANSITIONS_EN.forEach(w => { let i = -1; while ((i = t.toLowerCase().indexOf(w.toLowerCase(), i + 1)) >= 0) positions.push(i); });
      positions.sort((a, b) => a - b).forEach((at, k) => {
        const stop = t.indexOf("。", at);
        const win = t.slice(at, stop > at ? Math.min(stop + 1, at + 200) : at + 200);
        const missing = [];
        if (!/景别|机位|中景|近景|特写|全景|重建镜头|medium|close-up|full shot|wide|angle/i.test(win)) missing.push("重建新镜头（景别/机位/人物/光线）");
        if (!/那名|那个|同一个人|标识|the same|identical|same man/i.test(win)) missing.push("身份一致性（复用视觉标识）");
        if (!/音效|声音|音频|跨过剪辑|继续播放|carries across|audio|continues/i.test(win)) missing.push("声明音频跨剪辑延续或变化");
        if (missing.length) issues.push({ level: "error", code: "cut-4items", msg: "第 " + (k + 1) + " 个切点缺：" + missing.join("、"), hint: "官方要求每个切点完成 4 件事：点名转场 → 重建镜头 → 身份一致 → 声明音频。" });
      });
    }

    if (!CAMERA_CLAUSE_EN.test(t) && !CAMERA_CLAUSE_ZH.test(t)) issues.push({ level: "error", code: "no-camera-clause", msg: "没有镜头运动（何时/如何运动、运动后主体状态）", hint: "例如：镜头全程跟随打斗轨迹，受撞击瞬间轻微镜头震动，结尾缓慢拉远。" });
    const soundCountOf = (s) => SOUND_FX.filter(w => s.toLowerCase().indexOf(w.toLowerCase()) >= 0).length;
    const sentences = t.split(/[。！？.!?]+/).map(s => s.trim()).filter(Boolean);
    const lastFx = sentences.length ? soundCountOf(sentences[sentences.length - 1]) : 0;
    const bestSentence = sentences.reduce((n, s) => Math.max(n, soundCountOf(s)), 0);
    if (!has(AUDIO_HINT) && lastFx < 2 && bestSentence < 3) issues.push({ level: "error", code: "no-audio-clause", msg: "没有音频描写（LTX 原生音视频同生成，声音必须写进正文）", hint: "最后一句写：环境音＋打击声＋衣料与呼吸；没有配乐就写「" + NO_MUSIC + "」。" });
    if (!has(MUSIC_HINT)) issues.push({ level: "warn", code: "music-unspecified", msg: "没有说明有没有配乐", hint: "没有配乐就写「" + NO_MUSIC + "」。" });
    const dlg = t.match(/(?:对白|台词|says|said)\s*[:：]?\s*([^。！？.!?]{1,40})/g) || [];
    if (dlg.length && dlg.filter(s => /[""]/.test(s)).length < dlg.length) issues.push({ level: "warn", code: "dialogue-quotes", msg: "有对白但没有包在英文双引号里", hint: "官方要求对话必须包在双引号内。" });
    const emoHit = EMOTION_LABELS.filter(w => t.indexOf(w) >= 0);
    if (emoHit.length) issues.push({ level: "error", code: "emotion-label", msg: "写了抽象情绪词（" + emoHit.slice(0, 3).join("、") + "）", hint: "官方要求情绪只用身体动作线索：弓背、踉跄、目光锁定、急促发力。" });
    if (!has(TIME_HINT)) issues.push({ level: "warn", code: "no-time-line", msg: "没有时间推进词", hint: "官方建议用「起初／片刻之后／与此同时」推进动作时间线。" });
    const lightCount = LIGHTS.filter(w => t.indexOf(w) >= 0).length;
    if (lightCount >= 3) issues.push({ level: "info", code: "light-sources", msg: "出现 " + lightCount + " 种光源", hint: "官方要求一个镜头只允许一套自洽的光源逻辑。" });
    const zhChars = (t.match(/[\u4e00-\u9fff]/g) || []).length;
    const enWords = (t.match(/[A-Za-z][A-Za-z'-]*/g) || []).length;
    const zhShare = zhChars / Math.max(1, zhChars + enWords * 1.6);
    const minWords = zhShare > 0.6 ? 70 : 120;
    if (wc < minWords) issues.push({ level: "warn", code: "too-short", msg: "约 " + wc + " 词（中文 " + zhChars + " 字 / 英文 " + enWords + " 词），偏短", hint: "把接触点、受力方向、位移、环境反馈与声音补足。" });
    if (wc > 320) issues.push({ level: "warn", code: "too-long", msg: "约 " + wc + " 词，偏长", hint: "LTX 有 Auto-Duration，堆字凑时长只会引入噪声（官方明确禁止）。" });

    return { ok: !issues.some(i => i.level === "error"), issues: issues, stats: { words: wc, minWords: minWords, paragraphs: lines.length, mode: mode, cuts: isMulti ? transHit.length : 0, lastFx: lastFx, lightSources: lightCount, chars: t.length } };
  }

  return {
    VERSION, GUIDE, SIX, TRANSITIONS, TRANSITIONS_EN, TIME_MARKERS, TIME_MARKERS_EN, NO_MUSIC, NO_MUSIC_EN, CUT_AUDIO_KEEP, CUT_AUDIO_KEEP_EN, FORBIDDEN_NOTE,
    LTX_SYS_SINGLE_DEFAULT, LTX_SYS_MULTI_DEFAULT, LTX_SYS_T2V_DEFAULT, LTX_SYS_REF_DEFAULT,
    SCAFFOLD, SIZES, requestHead, framesFor, shellTemplate, buildParagraph, clean, isZh, validate, wordCount,
    TECH_TOKENS, EMOTION_LABELS, CAMERA_CLAUSE_EN, CAMERA_CLAUSE_ZH, AUDIO_HINT, SOUND_FX, MUSIC_HINT, TIME_HINT, LIGHTS, SHOT_MARKERS
  };
});
