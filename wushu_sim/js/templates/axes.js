/* ============================================================================
 * templates/axes.js — 打斗模板库的"轴"（题材词包 × 结构骨架 × 强度/速度规则）
 * ----------------------------------------------------------------------------
 * 出处与授权（本地采集，见 _template_sources/）：
 *   · 结构骨架、通用动作设计表、时间密度、镜头句式与职责、三档强度、失败诊断：
 *     irenerachel/fight-prompt-director（MIT，见 _template_sources/fight-prompt-director/LICENSE）
 *     references/fight-design.md、camera-guide.md、diagnostics.md、SKILL.md
 *   · 题材词包（兵器/环境/声音/负面）：本地编写，参考本项目 h3-skill/wushu-fight-vocab 的
 *     训练集词表与真实成片提示词语料（BeatAPI/awesome-minimax-h3-prompts），
 *     凡引用语料处一律标注 corpus:<slug>。
 * 说明：本文件只放"轴"（可组合的知识），具体模板由 library.js 组装。
 * ========================================================================== */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.TPL_AXES = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const VERSION = "axes-0.1";

  // ── 结构骨架（源自 fight-design.md 的七类动作场景）────────────────────
  const STRUCTURES = [
    {
      key: "duel", zh: "双人攻防", en: "Two-hander",
      core: "主动权与距离的争夺",
      need: "为双方设定不同的优势距离；第一轮由一方逼对方离开舒适距离",
      skeleton: ["定双方各自优势距离与站位", "第一轮：一方迫使另一方离开舒适距离", "被压制者用地形/兵器/假动作改变局面", "第二轮：交换位置或朝向", "明确谁获得空间、时间或行动优势"],
      density: { high: [7, 9], mid: [6, 8], slow: [5, 7] },
      cameraStages: ["起动", "距离变化", "接触与格挡", "反制", "受击与结果", "收尾"]
    },
    {
      key: "one_vs_many", zh: "一人对多", en: "One vs many",
      core: "用对手的位移互相阻挡，人数要持续可读",
      need: "每名对手有位置与行为差异；离场/倒地状态全程保留",
      skeleton: ["全景交代主角与每名对手位置", "对手按不同方向与节奏发起", "主角利用一个对手的位移挡住另一个", "画面保留已退出战斗的人与物", "结尾明确剩余人数与主角去向"],
      density: { high: [8, 10], mid: [6, 8], slow: [4, 6] },
      cameraStages: ["建立空间", "追随位移", "看清接触", "揭示结果", "稳定收尾"]
    },
    {
      key: "ranged", zh: "远程能量对抗", en: "Ranged energy duel",
      core: "能量来源、传播路径、接触结果与后续资源",
      need: "双方释放条件不同；防守方要有折射/吸收/偏转/切断的明确手段",
      skeleton: ["展示双方不同的释放条件", "第一轮能量改变场景或迫使一方移动", "防守方折射/吸收/偏转/切断来源", "第二轮改变传播路径或释放位置", "结果落在可见目标或无人环境"],
      density: { high: [6, 8], mid: [5, 7], slow: [4, 5] },
      cameraStages: ["展示弹道", "反应", "看清接触", "反制", "稳定收尾"]
    },
    {
      key: "breakout", zh: "单人突围", en: "Solo breakout",
      core: "威胁逐步改变形态，主角始终朝明确出口推进",
      need: "路线、出口、三种逐渐升级的威胁",
      skeleton: ["建立路线、出口与主角当前状态", "第一种威胁迫使改变步法或高度", "第二种威胁封住原路线，主角开辟新通道", "最后障碍检验前面建立的能力", "主角抵达、脱离或停在清晰位置"],
      density: { high: [7, 9], mid: [5, 7], slow: [3, 5] },
      cameraStages: ["建立空间", "追随位移", "受击与结果", "稳定收尾"]
    },
    {
      key: "human_vs_beast", zh: "人兽对决", en: "Human vs beast",
      core: "体型与受力尺度差异：小的靠选位时机，大的靠范围与惯性",
      need: "体型比例与安全距离；巨兽的一次大范围动作改变地面或遮挡",
      skeleton: ["建立体型比例与安全距离", "巨兽一次大范围动作改变地面或遮挡", "主角从侧翼/高度/弱点取得短暂机会", "巨兽调整攻击方式形成反转", "结果由倒塌、退让、脱离或环境变化呈现"],
      density: { high: [6, 8], mid: [5, 7], slow: [3, 5] },
      cameraStages: ["建立空间", "看清接触", "表达失衡", "揭示结果", "稳定收尾"]
    },
    {
      key: "solo_form", zh: "单人演武", en: "Solo form",
      core: "无对手的能力展示，动作形成完整闭环",
      need: "横/纵/高度变化各至少一次；武器始终唯一；收势回到可读位置",
      skeleton: ["起势同时启动镜头与身体运动", "横向、纵向、高度变化各出现一次", "武器或道具始终唯一", "环境介质响应动作方向", "收势回到稳定可读位置"],
      density: { high: [7, 9], mid: [5, 7], slow: [3, 5] },
      cameraStages: ["起动", "追随位移", "看清接触", "稳定收尾"]
    },
    {
      key: "stylized", zh: "风格化材质动作", en: "Stylized material action",
      core: "动作必须遵守媒介能弯曲/折叠/断裂的方式",
      need: "先定义材质、关节与摄影机限制；全片同一媒介逻辑",
      skeleton: ["定义材质、关节与摄影机限制", "所有角色/武器/特效使用同一媒介逻辑", "每次接触产生符合材料的反馈", "镜头避免破坏平面或舞台规则", "收尾保留线头、折痕、碎屑或结构变化"],
      density: { high: [6, 8], mid: [5, 6], slow: [3, 4] },
      cameraStages: ["建立空间", "追随位移", "看清接触", "稳定收尾"]
    }
  ];
  const STRUCT_MAP = {}; STRUCTURES.forEach(s => STRUCT_MAP[s.key] = s);

  // ── 镜头职责（源自 camera-guide.md）──────────────────────────────────
  const CAM_DUTIES = [
    { key: "establish", zh: "建立空间", q: "人物、出口、障碍分别在哪里", ways: ["大全景", "俯拍", "侧向全身景"] },
    { key: "follow", zh: "追随位移", q: "谁朝哪里移动、速度怎样变化", ways: ["平行跟拍", "侧后跟拍", "贴地跟拍"] },
    { key: "contact", zh: "看清接触", q: "是否命中、接触点在哪里", ways: ["侧向中景", "短促特写", "动作匹配切"] },
    { key: "counter", zh: "表达反制", q: "主动权怎样发生变化", ways: ["反应近景", "轴线同侧切入", "回接双人景"] },
    { key: "offbalance", zh: "表达失衡", q: "受力方向与身体姿态怎样改变", ways: ["倾斜", "短幅翻滚", "沿受力方向追随"] },
    { key: "ballistic", zh: "展示弹道", q: "释放者、路径、目标怎样关联", ways: ["过肩景", "长焦压缩", "高位距离景"] },
    { key: "reveal", zh: "揭示结果", q: "谁获得位置优势、环境发生什么", ways: ["快速后拉", "升镜", "遮挡物移开"] },
    { key: "settle", zh: "稳定收尾", q: "结果清楚后保留哪些运动", ways: ["固定构图", "稳定跟随", "慢速轨道移动"] }
  ];

  // 三档强度 × 阶段 → 镜头搭配（源自 camera-guide.md 的强度表）
  const STRENGTH = {
    high: { zh: "高强度", start: "低机位快速跟随", move: "贴地或侧后跟拍", touch: "动作匹配切、短促推近", counter: "轴线同侧快速切入", ranged: "落点切回、短暂弹道追随", hit: "沿受力方向快速追随", end: "快速拉开后稳定" },
    mid: { zh: "中间型", start: "中景定向后切入", move: "平行跟拍", touch: "接触特写加双人回接", counter: "反应近景", ranged: "过肩景、高位距离景", hit: "中景承接位移", end: "中景转全景" },
    slow: { zh: "慢节奏", start: "长镜建立路线", move: "轨道移动", touch: "侧向全身景", counter: "长镜内部改变构图", ranged: "长焦保持路径关系", hit: "长镜看完整结果", end: "稳定轨道离开" }
  };

  // 时间密度（源自 fight-design.md，以 15 秒为基准）
  const DENSITY = {
    std: { zh: "标准版", firstMove: 0.3, pureRecovery: 0.7, actionCloseup: [0.8, 1.5], slowmo: "按需，最多一次 0.3~0.6 秒" },
    fast: { zh: "极速版", firstMove: 0.15, pureRecovery: 0.3, actionCloseup: [0.4, 0.8], slowmo: "默认不用；决定性命中最多一次 0.15~0.3 秒" }
  };

  // ── 题材词包（本地编写；引用语料处标 corpus:<slug>）──────────────────
  const GENRES = [
    {
      key: "live_hand", zh: "真人近身格斗", en: "Live-action hand-to-hand",
      weapons: ["拳掌肘膝", "短棍", "匕首", "无兵器"],
      places: ["地下停车场", "深夜便利店", "狭窄消防楼梯", "集装箱码头"],
      media: ["混凝土地面的鞋底摩擦", "金属卷帘门被撞出凹陷", "积水被脚步踏碎"],
      axis: "一方靠墙侧退，另一方控住中线推进",
      advantage: "A 擅长贴身缠斗与肘膝；B 擅长中距离直拳与低扫",
      sounds: { amb: "地下空间低频轰鸣、远处管道滴水", act: "拳套擦过空气、短促闷响、鞋底急停", human: "压住的呼吸、短促吐气、牙关咬紧的喉音" },
      negatives: ["演出感过强的套招", "武器凭空出现", "命中无受力反应", "布娃娃式飞天"],
      cameraPool: ["低机位中景", "肩后过肩景", "贴地侧跟", "手部特写", "侧向全身景"],
      source: "authored（近身格斗通用写法；题材词参考本项目训练集词汇）"
    },
    {
      key: "hk_action", zh: "港式武打", en: "Hong-Kong style action",
      weapons: ["折叠凳", "竹竿", "短棍", "酒瓶", "赤手"],
      places: ["茶餐厅后巷", "脚手架林立的工地", "菜市场摊位间", "货仓铁架"],
      media: ["塑料筐被踩碎", "铁皮卷帘被拽落", "晾衣绳被挂断"],
      axis: "主角借环境道具层层递进，从地面打到高处",
      advantage: "A 善用随手道具与跑位；B 善用长器械控制距离",
      sounds: { amb: "街市人声隔着巷子传来、空调外机嗡响", act: "塑胶筐碎裂、金属杆磕在铁架上的脆响、落地翻滚", human: "吃痛的短呼、换气时的粗喘、喊招的一声" },
      negatives: ["只打空气不接触道具", "道具位置前后不一致", "同一道具重复出现两次", "喜剧式定格"],
      cameraPool: ["横移跟拍", "低机位仰角", "高位俯拍路线", "道具特写", "侧向全身景"],
      source: "authored（港式动作片常用编排；道具纪律参考 fight-design 的「资源唯一」要求）"
    },
    {
      key: "wuxia", zh: "武侠", en: "Wuxia",
      weapons: ["长剑", "单刀", "长棍", "拂尘", "空手内功"],
      places: ["雨夜长街", "竹林", "客栈二楼", "山门石阶"],
      media: ["雨丝被刀风切成线", "竹叶成片落下", "灯笼在劲风里晃"],
      axis: "两人隔三步对峙，先抢中线者得势",
      advantage: "A 剑走轻灵，长于连击与卸力；B 刀势沉猛，长于破防与逼位",
      sounds: { amb: "雨打瓦檐、远处更鼓、竹叶摩擦", act: "兵刃相击的清越、破空声由近及远、衣袂翻卷", human: "沉住气的呼吸、闷哼、落地时的短促吐气" },
      negatives: ["现代物件入镜", "轻功写成瞬移", "剑气无来源", "招式名当字幕"],
      cameraPool: ["侧面中景", "低机位仰拍", "过肩反打", "兵刃接触特写", "环绕长镜"],
      source: "authored（武侠通用写法；词汇参考本项目 h3-skill/wushu-fight-vocab 训练集词表）"
    },
    {
      key: "xianxia", zh: "仙侠修真", en: "Xianxia / cultivation",
      weapons: ["飞剑", "法宝铜铃", "符箓", "指诀", "灵气掌"],
      places: ["云海石台", "崩塌的洞府", "悬空剑阵", "雷劫荒原"],
      media: ["灵气在脚下凝成光纹", "符箓自燃成灰", "雷云压低、碎石浮空"],
      axis: "一人御剑空中，一人结印立地，纵向高度差决定攻防",
      advantage: "A 长于飞剑远程与剑气切割；B 长于结阵困锁与护体罡气",
      sounds: { amb: "高空风声、雷云滚动、远处钟鸣", act: "剑鸣拖出长音、灵力碰撞的嗡震、符箓爆开的脆裂", human: "屏息、吐纳术的呼气、受创时的闷哼" },
      negatives: ["法术无来源凭空绽放", "飞剑数量前后不一致", "现代用语", "光污染堆砌"],
      cameraPool: ["仰拍御剑", "高位俯拍剑阵", "长焦压缩气浪", "快速拉远看规模", "过肩看路径"],
      source: "authored（修真斗法通用写法；灵气/法宝词汇参考训练集词汇与本项目 LoRA 词表）"
    },
    {
      key: "fantasy_qi", zh: "玄幻异能", en: "Eastern fantasy / qi powers",
      weapons: ["斗气重拳", "异火", "魂技", "血脉变身"],
      places: ["荒原石林", "妖兽峡谷", "家族演武场", "浮空擂台"],
      media: ["地面被气劲犁出沟壑", "异火贴着岩石爬", "空气被高温扭曲"],
      axis: "从地面近身打到腾空对撞，纵向高度反复易手",
      advantage: "A 长于气劲外放与贴身爆发；B 长于异火远程与范围压制",
      sounds: { amb: "荒原风声、碎石滚落", act: "气劲外放的爆音、火焰呼啸、岩石崩裂", human: "压低的怒吼、急促换气" },
      negatives: ["能量无触发动作", "威力与等级不符", "招式像游戏特效UI", "无环境反馈"],
      cameraPool: ["低机位仰拍对撞", "快速环绕", "撞击点急推", "高位俯瞰", "沿击飞轨迹跟随"],
      source: "authored（玄幻打斗通用写法；特效锚定规则参考 fight-design 与 base-en.txt 的「可听可见」要求）"
    },
    {
      key: "magic", zh: "魔法奇幻", en: "Magic fantasy",
      weapons: ["法杖", "咒印", "元素护盾", "召唤物"],
      places: ["石砌法师塔", "森林魔阵", "古堡大厅", "雨中废墟"],
      media: ["地面法阵逐格亮起", "碎石被无形之手托起", "雨滴在半空凝住"],
      axis: "施法者各自构筑阵地，一方靠位移切断对方的阵眼",
      advantage: "A 长于瞬发与元素连招；B 长于护盾与召唤物围困",
      sounds: { amb: "塔内回响、远处雷鸣、风穿过拱门的低鸣", act: "咒语音节、石块相碰、护盾被打出裂纹的脆响", human: "念咒时的呼吸、受伤时的抽气" },
      negatives: ["念咒无嘴型变化", "法阵图案前后不一致", "无来源的能量洪流", "现代科技物件"],
      cameraPool: ["过肩看施法", "俯拍法阵全貌", "长焦压缩光路", "反应近景", "缓慢推近咒印"],
      source: "authored（魔法对战通用写法）"
    },
    {
      key: "gunfight", zh: "枪战军事", en: "Gunfight / military",
      weapons: ["突击步枪", "手枪", "狙击枪", "手雷", "匕首"],
      places: ["废弃工厂", "雨夜仓库", "走廊掩体区", "屋顶"],
      media: ["墙面被弹孔连成一线", "灯泡爆裂", "铁皮被穿出透光小孔"],
      axis: "一方压制射击，另一方沿掩体折线逼近",
      advantage: "A 长于掩体间推进与换弹节奏；B 长于远距压制与封锁路线",
      sounds: { amb: "厂房回声、雨水打在铁皮上、远处警笛", act: "枪声在空间里的回响、弹壳落地、掩体被击碎的碎屑", human: "短促的命令、压住的呼吸、拉动枪机" },
      negatives: ["枪口无火光", "弹道关系错乱", "弹匣数量前后不一致", "命中无遮挡反馈"],
      cameraPool: ["贴胸过肩推进", "低机位看弹道", "高位俯瞰掩体", "快速甩镜", "长焦看目标"],
      source: "authored（枪战通用写法；corpus 参考 15-second-16-9-photoreal-cinematic-action-sequence-with-743096）"
    },
    {
      key: "scifi_mecha", zh: "科幻机甲", en: "Sci-fi / mecha",
      weapons: ["能量刃", "等离子炮", "机械臂", "无人机群"],
      places: ["霓虹街道", "轨道电梯平台", "废弃机库", "外星废墟"],
      media: ["地面积水被冲击波推成环形", "霓虹招牌炸成碎片", "装甲板被削开露出内部结构"],
      axis: "地面机体被空中机体压制，靠推进器折线换位反击",
      advantage: "A 长于近身能量刃与冲刺；B 长于中远程火力与无人机协同",
      sounds: { amb: "城市低频嗡鸣、机械液压声、远处爆炸余响", act: "伺服马达转动、能量刃充能的上升音、装甲被切开的金属撕裂", human: "驾驶员通过通讯的短促呼吸" },
      negatives: ["机甲比例前后不一致", "能量刃无充能过程", "穿模", "无重量的漂浮动作"],
      cameraPool: ["低机位仰拍机体", "沿冲刺方向跟随", "长焦压缩火力线", "俯瞰街区", "撞击急推"],
      source: "authored（机甲对战通用写法；corpus 参考 modern-warfare-fps-gameplay、ic3-gunslinger 一类）"
    },
    {
      key: "samurai", zh: "日式武士", en: "Samurai",
      weapons: ["打刀", "胁差", "长枪", "弓"],
      places: ["雪原", "町屋庭院", "石阶神社", "樱花道"],
      media: ["雪被刀锋带起一道弧", "纸门被劈开", "血落在雪上"],
      axis: "居合式一触即发，脚步与间距极小地变化",
      advantage: "A 长于拔刀瞬斩与残心；B 长于中段压制与突刺",
      sounds: { amb: "风穿过松枝、远处水声、木屐踩雪", act: "刀出鞘的清响、刀刃相交的短音、衣料摩擦", human: "极轻的呼吸、踏雪的脆响" },
      negatives: ["夸张慢动作堆砌", "刀光代替动作", "现代服装入镜", "无鞘无拔刀过程"],
      cameraPool: ["侧面全身景", "低机位看脚步", "拔刀瞬间特写", "远景留白", "缓慢推进"],
      source: "authored（剑戟片通用写法）"
    },
    {
      key: "anime_action", zh: "日式动画", en: "Anime action",
      weapons: ["太刀", "双刀", "拳斗", "能力具现"],
      places: ["屋顶水塔", "夜间校舍", "废墟广场", "浮空擂台"],
      media: ["速度线切开画面", "瓦片成片飞起", "水塔被撞出裂口"],
      axis: "高速交错后瞬间停顿，再以一次必杀收束",
      advantage: "A 长于连续突进；B 长于读招反击",
      sounds: { amb: "夜晚的风、远处电车", act: "衣料呼啸、刀锋破空、碎石四散", human: "喊招、咬牙、急促呼吸" },
      negatives: ["静止画充数", "特效掩盖动作", "背景与前镜不一致", "无重量感"],
      cameraPool: ["速度线推近", "快速横切", "仰角必杀", "撞击瞬间 0.35× 慢放", "拉开看余波"],
      source: "authored（动画打斗通用写法；corpus 参考 fast-paced-15-second-16-9-anime-opening 一类）"
    },
    {
      key: "ancient_war", zh: "古装战争", en: "Ancient warfare",
      weapons: ["长枪", "盾", "环首刀", "弓弩", "战旗"],
      places: ["泥泞战场", "城门缺口", "雪原阵前", "山谷隘口"],
      media: ["泥浆被踩翻", "盾面被劈裂", "箭雨钉在木盾上"],
      axis: "阵型与个人动作互相影响，位置决定生死",
      advantage: "A 长于枪阵推进；B 长于破阵近战",
      sounds: { amb: "军鼓、风卷战旗、远处号角", act: "枪杆抖动、盾牌相撞、泥水溅起", human: "下令的短喝、负伤的喘声" },
      negatives: ["现代装备", "无阵型逻辑", "人数前后不一致", "血污位置跳变"],
      cameraPool: ["高位俯瞰阵型", "贴地跟拍冲锋", "侧向看接触", "低机位仰拍压迫", "后拉揭示全景"],
      source: "authored（古代战场通用写法）"
    },
    {
      key: "beast", zh: "怪物巨兽", en: "Monster / giant beast",
      weapons: ["长矛", "钩索", "猎具", "火把"],
      places: ["盐湖", "矿洞深处", "峡谷栈道", "渔村滩涂"],
      media: ["地面被兽爪拍出扇形裂纹", "灰尘成墙推进", "岩壁被尾扫塌"],
      axis: "小体型靠选位与时机，大体型靠范围与地形改变",
      advantage: "A 长于侧翼接近与弱点打击；B（巨兽）长于范围压制与地形改变",
      sounds: { amb: "洞窟回响、风声穿过峡谷", act: "爪击地面的闷雷、岩块塌落、金属尖响", human: "急促呼吸、压低的号令" },
      negatives: ["巨兽比例跳变", "弱点位置前后不一致", "触地无尘石反馈", "人类角色飞天不合理"],
      cameraPool: ["低机位看巨兽全高", "人类肩后过肩", "高位俯拍走位", "撞击沿受力追随", "后拉看体量"],
      source: "authored（人兽对决通用写法；骨架来自 fight-design.md#5）"
    },
    {
      key: "superhero", zh: "超能都市", en: "Urban superpowers",
      weapons: ["能量拳", "念力", "护盾", "投掷物"],
      places: ["十字路口", "楼顶天台", "地铁站厅", "玻璃幕墙外墙"],
      media: ["柏油路被砸出放射裂纹", "玻璃成片脱落", "路牌被卷飞"],
      axis: "一方把战场推向垂直面，另一方贴地反击",
      advantage: "A 长于爆发与冲击；B 长于位移与预判",
      sounds: { amb: "城市交通噪底、警报声", act: "冲击波低频轰响、玻璃碎裂、金属变形", human: "短促的怒吼、落地时的吐气" },
      negatives: ["物理完全失效", "无后果的破坏", "现代品牌露出", "披风/服饰前后不一致"],
      cameraPool: ["低机位仰拍冲击", "沿击飞方向追随", "高位俯瞰街区", "快速环绕", "慢放收尾"],
      source: "authored（超能动作通用写法；corpus 参考 urban-street-superpowered-punch-action-sequence-712509）"
    },
    {
      key: "western", zh: "西部枪手", en: "Western gunslinger",
      weapons: ["左轮", "杠杆步枪", "匕首", "马"],
      places: ["小镇主街", "酒馆门口", "沙漠水源", "峡谷铁道"],
      media: ["风卷沙扑过路面", "招牌被子弹打穿", "马蹄掀起尘土"],
      axis: "正午对射，距离与拔枪时机决定胜负",
      advantage: "A 长于拔枪速度；B 长于掩体运用与步枪精度",
      sounds: { amb: "风穿过木板缝隙、远处鹰唳", act: "枪声在空旷街道的回响、马刺叮当、沙土落地", human: "极低的对话、吞咽声" },
      negatives: ["现代车物", "枪械规格错乱", "无火药烟", "命中无尘土反馈"],
      cameraPool: ["长焦压缩双人", "靴子特写", "低机位看枪线", "快速摇到落点", "远景收尾"],
      source: "authored（西部片通用写法）"
    },
    {
      key: "chase", zh: "追逐逃亡", en: "Chase / pursuit",
      weapons: ["随手道具", "绳索", "短刃", "车"],
      places: ["屋顶群", "窄巷", "立交桥下", "货场通道"],
      media: ["瓦片被踩落", "晾衣杆被撞断", "水洼被踏开"],
      axis: "追者缩短距离、逃者切割路线，障碍连续出现",
      advantage: "A 长于翻越与环境借力；B 长于预判堵截",
      sounds: { amb: "城市风声、远处车流", act: "脚步连续触地、铁皮被撞响、呼吸", human: "粗重的换气、短促催促" },
      negatives: ["越跑越近背景不变", "路线矛盾", "无体能消耗表现", "无空间参照"],
      cameraPool: ["贴地侧跟", "高位俯拍路线", "侧后跟拍", "道具特写", "拉开看距离"],
      source: "authored（追逐戏通用写法；骨架参考 fight-design.md#1 的推进逻辑）"
    },
    {
      key: "stylized_art", zh: "风格化媒介", en: "Stylized medium",
      weapons: ["线制短杖", "纸刃", "陶土拳", "像素装置"],
      places: ["绣框布面", "折纸桌面", "陶土工作台", "积木房间"],
      media: ["针脚随动作延伸", "折痕改变方向", "陶土碎屑留在台面"],
      axis: "沿媒介允许的方向滑移与折转，跨媒介移动被禁止",
      advantage: "A 长于短距离跃线；B 长于剪断与折压",
      sounds: { amb: "极安静的室内底噪", act: "线与布摩擦、纸张折叠、陶土轻碰", human: "（无对白，仅呼吸或省略）" },
      negatives: ["破坏媒介逻辑", "镜头穿透平面", "写实材质混入", "无痕迹遗留"],
      cameraPool: ["正对平面平移", "轻微推近", "保持平面规则的侧移", "固定构图收尾"],
      source: "authored（媒介动作通用写法；骨架来自 fight-design.md#7）"
    }
  ];
  const GENRE_MAP = {}; GENRES.forEach(g => GENRE_MAP[g.key] = g);

  // ── 英文声音包（让英文骨架整段不带中文）────────────────────────────
  const SOUND_EN = {
    live_hand: { amb: "low rumble of the underground space, water dripping from a pipe", act: "gloved fist cutting air, dull impacts, shoes skidding to a stop", human: "held breath, short exhales, a throat sound through clenched teeth" },
    hk_action: { amb: "street-market voices past the alley, air-conditioner hum", act: "crates cracking, a metal pole ringing against a rack, a rolling landing", human: "short pained calls, rough breath on the exchange, one shouted move" },
    wuxia: { amb: "rain on the roof tiles, a distant night watch drum, bamboo leaves", act: "clean ring of blades meeting, air-cut sweeping past, robes snapping", human: "steady controlled breathing, a muffled grunt, a short exhale on landing" },
    xianxia: { amb: "high-altitude wind, thunder rolling, a distant bell", act: "a sword hum drawn long, the buzz of colliding qi, talisman paper cracking", human: "suspended breath, the exhale of a breathing art, a grunt on impact" },
    fantasy_qi: { amb: "wasteland wind, loose stones rolling", act: "qi bursting outward, fire roaring, rock splitting", human: "a low roar, fast panting" },
    magic: { amb: "tower reverb, distant thunder, wind moaning through an arch", act: "syllables of an incantation, stones knocking, a shield cracking", human: "breath through the chant, a sharp intake on impact" },
    gunfight: { amb: "factory echo, rain on sheet metal, sirens far off", act: "gunshots rolling in the space, brass on concrete, cover shattering", human: "clipped orders, held breath, a bolt pulled back" },
    scifi_mecha: { amb: "city low-frequency hum, hydraulics, distant explosions", act: "servos turning, an energy blade charging up, armour tearing", human: "short comms breathing" },
    samurai: { amb: "wind in the pine, distant water, wooden sandals on snow", act: "the clean note of a draw, a brief ring as blades meet, cloth shifting", human: "very light breathing, snow crunching" },
    anime_action: { amb: "night wind, a distant tram", act: "cloth whipping, a blade cutting air, rubble scattering", human: "a called move, teeth grinding, fast breathing" },
    ancient_war: { amb: "war drums, wind through banners, a horn far off", act: "spear shafts shaking, shields colliding, mud splashing", human: "clipped orders, wounded panting" },
    beast: { amb: "cave echo, wind through the gorge", act: "claws hitting ground like muffled thunder, rockfall, a metal point whining", human: "fast breathing, low commands" },
    superhero: { amb: "city traffic bed, alarms", act: "low-frequency shockwave, glass shattering, metal deforming", human: "a short roar, an exhale on landing" },
    western: { amb: "wind through plank gaps, a hawk far off", act: "gunfire rolling down an empty street, spurs, sand settling", human: "very low speech, a swallow" },
    chase: { amb: "city wind, traffic below", act: "continuous footfalls, sheet metal banging, breathing", human: "heavy panting, a short urgent call" },
    stylized_art: { amb: "a very quiet room tone", act: "thread rubbing cloth, paper folding, clay clicking", human: "no dialogue, breath or omitted" }
  };
  GENRES.forEach(g => { g.soundEn = SOUND_EN[g.key] || { amb: "ambient room tone", act: "material impact", human: "breath" }; });

  // ── 兼容矩阵：哪些题材适合哪些结构（避免「绣花＋枪战」这种硬凑）────────
  const COMPAT = {
    duel: ["live_hand", "hk_action", "wuxia", "xianxia", "fantasy_qi", "magic", "samurai", "anime_action", "superhero", "western", "scifi_mecha", "beast", "stylized_art"],
    one_vs_many: ["live_hand", "hk_action", "wuxia", "fantasy_qi", "samurai", "anime_action", "ancient_war", "superhero", "gunfight", "scifi_mecha", "western", "chase"],
    ranged: ["xianxia", "magic", "fantasy_qi", "gunfight", "scifi_mecha", "superhero", "western"],
    breakout: ["live_hand", "hk_action", "wuxia", "xianxia", "gunfight", "scifi_mecha", "chase", "anime_action", "western"],
    human_vs_beast: ["beast", "xianxia", "fantasy_qi", "ancient_war", "scifi_mecha"],
    solo_form: ["wuxia", "xianxia", "fantasy_qi", "samurai", "anime_action", "hk_action", "live_hand", "western", "chase", "stylized_art"],
    stylized: ["stylized_art", "anime_action", "wuxia", "xianxia", "magic", "samurai"]
  };

  // ── 英文对照（让英文骨架能直接当 H3 提示词用，不带中文）──────────────
  const STRENGTH_EN = {
    high: { start: "fast low-angle follow", move: "ground-hugging or rear-side tracking", touch: "action match cut with a short push-in", counter: "same-side axis cut-in", ranged: "cut back to impact with a brief projectile follow", hit: "fast follow along the force line", end: "quick pull-back then settle" },
    mid: { start: "medium shot, cut in on the committed direction", move: "parallel tracking", touch: "contact close-up plus a two-shot return", counter: "reaction close-up", ranged: "over-the-shoulder and high wide distance shot", hit: "medium shot carrying the displacement", end: "medium shot widening to a full shot" },
    slow: { start: "long take establishing the route", move: "dolly move", touch: "side full shot", counter: "reframe inside the long take", ranged: "long lens holding the path relation", hit: "long take showing the full result", end: "steady dolly out" }
  };
  const CAMERA_POOL_EN = {
    live_hand: ["low-angle medium shot", "over-the-shoulder", "ground-level side tracking", "hand close-up", "side full shot"],
    hk_action: ["lateral tracking", "low-angle wide", "high-angle route shot", "prop close-up", "side full shot"],
    wuxia: ["side medium shot", "low-angle wide", "over-the-shoulder reverse", "blade-contact close-up", "orbiting long take"],
    xianxia: ["low-angle on the flying swordsman", "high-angle on the sword array", "long lens compressing the shockwave", "fast pull-back for scale", "over-the-shoulder on the flight path"],
    fantasy_qi: ["low-angle on the clash", "fast orbit", "punch-in at the impact point", "high wide shot", "follow along the knockback arc"],
    magic: ["over-the-shoulder on the caster", "high-angle on the sigil circle", "long lens along the energy path", "reaction close-up", "slow push-in on the rune"],
    gunfight: ["chest-level over-the-shoulder advance", "low-angle along the bullet line", "high-angle over the cover", "quick whip pan", "long lens on the target"],
    scifi_mecha: ["low-angle on the machine", "follow along the dash", "long lens compressing the fire line", "high wide shot of the district", "punch-in at the collision"],
    samurai: ["side full shot", "low-angle on the footwork", "close-up at the draw", "wide with negative space", "slow push-in"],
    anime_action: ["speed-line push-in", "fast lateral cut", "low-angle finisher", "impact freeze frame", "pull-back on the aftermath"],
    ancient_war: ["high-angle on the formation", "ground-level charge tracking", "side view of the contact", "low-angle for pressure", "pull-back revealing the field"],
    beast: ["low-angle on the full height of the beast", "over-the-shoulder from the human", "high-angle on the footwork", "follow along the force line", "pull-back for scale"],
    superhero: ["low-angle on the impact", "follow along the knockback", "high wide shot of the crossing", "fast orbit", "freeze frame to settle"],
    western: ["long lens two-shot", "boot close-up", "low-angle along the gun line", "quick pan to the impact", "wide shot to settle"],
    chase: ["ground-level side tracking", "high-angle route shot", "rear-side tracking", "prop close-up", "pull-back showing the gap"],
    stylized_art: ["flat-on lateral pan", "slight push-in", "side move that respects the plane", "static composition to settle"]
  };
  GENRES.forEach(g => { g.cameraPoolEn = CAMERA_POOL_EN[g.key] || g.cameraPool; });

  return { VERSION, STRUCTURES, STRUCT_MAP, CAM_DUTIES, STRENGTH, STRENGTH_EN, DENSITY, GENRES, GENRE_MAP, COMPAT, CAMERA_POOL_EN };
});
