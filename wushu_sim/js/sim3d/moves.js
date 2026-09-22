/* ============================================================================
 * sim3d/moves.js — 招式库（MOVE LIBRARY）
 * ----------------------------------------------------------------------------
 * 目标（用户要求）：
 *   · 已经出现过的招式、以及以后新出现的招式，**全部收进招式库**；
 *   · 每个招式都要有：名称、详细（华丽）效果、准备动作、出招动作、
 *     出招时间（准备/有效/收招，范围值）、攻击距离与范围（米）、高度带、连招衔接；
 *   · **再次使用同一招式时，直接从库里调用**（不再重新编）；
 *   · 库里没有的招式 → 自动入库（标记 source:"auto"），并持久化，下次直接用。
 *
 * 数据结构（每条招式）：
 *   key            内部键（与内核 VARIANTS / rig TECH_POSE 对齐，如 "slash"）
 *   zh / en        名称
 *   category       近战/长兵/拳脚/轻功/法术/终结
 *   weapons        适用兵器 key 数组（空数组=通用）
 *   tiers          [最低等级, 最高等级]
 *   prep           准备动作（起势，一句话，画面能落地）
 *   act            出招动作（兵器/身体怎么走，一句话）
 *   effect         命中效果（华丽，写清形态/光效/物理反应）
 *   follow         连招衔接（这一招收完怎么接下一招）
 *   timing         { charge:[min,max], active:[min,max], recover:[min,max] }（秒）
 *   range          [最近, 最远]（米）
 *   arc            覆盖扇角（度；0=直线点攻）
 *   band           命中高度带 low/mid/high
 *   tags           用途标签（压制/突进/破防/收尾/位移…）
 *   source         "seed"（内置）/"auto"（内核自动生成）/"user"（手动添加）
 * ========================================================================== */
"use strict";

const MOVE_LIB_VERSION = "move-lib-0.1";

// ── 内置招式库 ──────────────────────────────────────────────────────────────
const SEED = [
  // ═══ 通用近战（与内核 VARIANTS 对齐）═══
  {
    key: "slash", zh: "横斩", en: "horizontal slash", category: "近战", weapons: [], tiers: [1, 9],
    prep: "侧身而立，兵器横于胸前，刃口朝外，重心压在后腿，脚下暗含半步",
    act: "拧腰送肩，兵器自外向内横扫一线，肘随刃走、腰催肘、肘催腕，收在半身位",
    effect: "刃线划开一道银亮的弧光，空气被切成两半发出「嗡」的一声；命中处血线沿着切口崩开，衣料先一步裂开，火星与雨珠同时被扫成一片扇面飞散",
    follow: "刃势未收就沉肘转腕，顺势接一记反手回抹或上撩",
    timing: { charge: [0.10, 0.20], active: [0.04, 0.07], recover: [0.20, 0.32] },
    range: [1.4, 2.2], arc: 118, band: "mid", tags: ["压制", "横向覆盖"]
  },
  {
    key: "diag", zh: "斜劈", en: "diagonal cleave", category: "近战", weapons: [], tiers: [1, 9],
    prep: "兵器高举过肩，肩胛后张，刃口朝向对手肩颈，前脚虚点地面",
    act: "自肩后起势，沿斜线劈落，身体前压、后腿蹬直，刃尖最终停在膝前",
    effect: "自上而下的一道斜光，像把画面斜着剖开；命中时兵刃吃进护具、火星成串迸出，对手被这一压劈带得单膝一沉，脚下石板被踩出裂纹",
    follow: "劈势到底不收，直接借下压的惯性推出突刺或换低扫",
    timing: { charge: [0.12, 0.24], active: [0.05, 0.08], recover: [0.22, 0.38] },
    range: [1.2, 2.0], arc: 96, band: "high", tags: ["破防", "重压"]
  },
  {
    key: "thrust", zh: "突刺", en: "thrust", category: "近战", weapons: [], tiers: [1, 9],
    prep: "兵器收至腰间，前手虚托、后手扣把，身形半蹲、目光锁住对手中线",
    act: "后腿蹬地、胯部前送，兵器贴着自己中线笔直扎出，手臂与兵器成一条直线，肩不摇、头不偏",
    effect: "一线白光贴着身体中轴窜出，快得只剩一条残影；命中时「噗」的一声闷响，对手护具被顶出一个凹点，整个人被顶得后退半步，脚下的雨水被犁出两道浅沟",
    follow: "扎出即回，收枪的同时抬后手护住面门，准备接下一记横扫",
    timing: { charge: [0.08, 0.16], active: [0.03, 0.05], recover: [0.16, 0.28] },
    range: [1.8, 3.0], arc: 22, band: "mid", tags: ["突进", "点破"]
  },
  {
    key: "rise", zh: "撩挑", en: "upward flick", category: "近战", weapons: [], tiers: [1, 9],
    prep: "重心极低，兵器沉在膝下，刃尖朝地，后手贴胯蓄劲",
    act: "自下向上一记撩挑，腰胯先起、腕部最后发力，兵器走的是由低到高的斜挑线",
    effect: "刃光由地面斜着挑起，把地上的积水与碎石一并带上半空；命中时把对手的兵器或前臂向上磕开，形成一瞬间的空门，水线在光里被照成一串碎钻",
    follow: "挑开对手兵器后立刻转腕下压，趁空门劈向胸口",
    timing: { charge: [0.10, 0.20], active: [0.04, 0.07], recover: [0.20, 0.34] },
    range: [1.2, 2.1], arc: 74, band: "low", tags: ["破格挡", "由下而上"]
  },
  {
    key: "sweep", zh: "扫堂", en: "low sweep", category: "近战", weapons: [], tiers: [2, 9],
    prep: "骤然下沉成马步，兵器和腿同时收到最低处，上身压低贴近地面",
    act: "以支撑腿为轴，另一条腿贴地横扫，兵器同步在地面划出一道弧，整个人像被甩出去的磨盘",
    effect: "贴地扫出一圈水花与尘线，像平地起了一道低矮的浪；命中时直接铲在对手的支撑腿上，把他整个人从地面掀起来，落地的姿势都来不及收",
    follow: "扫完不停，借旋转的惯性起身接一记正面重击",
    timing: { charge: [0.16, 0.30], active: [0.06, 0.10], recover: [0.30, 0.50] },
    range: [1.0, 1.9], arc: 150, band: "low", tags: ["破下盘", "群扫"]
  },
  {
    key: "heavy", zh: "重击", en: "heavy blow", category: "近战", weapons: [], tiers: [3, 9],
    prep: "兵器绕身一周蓄势，肩背肌肉绷起，脚下的地面被踩出浅浅的坑",
    act: "全身之力从后脚跟一路传到兵器前端，砸下去的是一整条力线，不是一记挥砍",
    effect: "兵器落下时空气被压出一声闷响，落点炸开一圈环形气浪，把雨水、碎石、碎瓦一并掀飞；对手连人带兵器被砸得向侧后横移，护具上留下一道深凹",
    follow: "重击之后最忌恋战，收兵器回架同时后撤半步，重新找角度",
    timing: { charge: [0.20, 0.34], active: [0.05, 0.09], recover: [0.32, 0.52] },
    range: [1.2, 2.0], arc: 110, band: "mid", tags: ["破防", "震退"]
  },
  {
    key: "finish", zh: "终结", en: "finisher", category: "终结", weapons: [], tiers: [4, 9],
    prep: "弃守为攻，兵器拉到最满、身体像弓一样绷紧，眼里只剩对手的破绽",
    act: "一记毫无保留的全力斩落，起手到落点只有一条线，收招时人已越过对手半个身位",
    effect: "兵器划过的轨迹留下一道久久不散的光痕，命中的瞬间爆出一圈白亮的气浪，对手被这一击直接打得双脚离地向后抛飞，护具碎裂、兵器脱手，落地时砸出一片水雾",
    follow: "收势即定，背对对手站定，等着看谁先倒下",
    timing: { charge: [0.26, 0.42], active: [0.06, 0.10], recover: [0.40, 0.62] },
    range: [1.3, 2.2], arc: 120, band: "mid", tags: ["收尾", "决胜"]
  },

  // ═══ 空中招式 ═══
  {
    key: "leap_slash", zh: "跃斩", en: "leaping slash", category: "轻功", weapons: [], tiers: [4, 9],
    prep: "屈膝蓄力、兵器后引，起跳前的一瞬间肩背先动、脚下才开始蹬",
    act: "跃起后在空中收腿转体，借下落的势能自上而下劈斩，落点比起跳点更近对手一步",
    effect: "人从半空压下来，刃光像一道从天上劈下的白线，落地时双足砸出一圈水环，刃锋过处灯笼纸被割开、火苗一颤",
    follow: "落地瞬间屈膝卸力，顺势贴地扫腿或直接起身再劈",
    timing: { charge: [0.22, 0.36], active: [0.05, 0.09], recover: [0.34, 0.55] },
    range: [1.4, 2.6], arc: 110, band: "high", tags: ["空袭", "压制"]
  },
  {
    key: "dive", zh: "俯冲击", en: "diving strike", category: "轻功", weapons: [], tiers: [4, 9],
    prep: "在半空中折身俯冲，头下脚上、兵器前指，衣袍被风整个兜起来",
    act: "自高处直扑而下，兵器顺着俯冲的轴线刺落，收势时膝盖先着地",
    effect: "像一支从檐上射下来的箭，刃锋在湿石板上犁出一条半米长的火星线；命中时对手被自上而下钉住，双膝跪进水里",
    follow: "着地后立刻翻滚起身，用身体的旋转带出下一记横扫",
    timing: { charge: [0.18, 0.30], active: [0.05, 0.08], recover: [0.30, 0.48] },
    range: [1.2, 2.4], arc: 60, band: "high", tags: ["空袭", "点破"]
  },
  {
    key: "wall_flip", zh: "踏墙翻身", en: "wall flip", category: "轻功", weapons: [], tiers: [5, 9],
    prep: "蹬上墙面的一瞬间收腹缩肩，兵器夹在腋下，脚尖在砖缝里找落脚点",
    act: "在墙上借力翻身，身体从对手侧上方绕过去，翻过来时兵器已经拉满",
    effect: "墙面被蹬出一道碎砖与灰尘，人影在半空划出一个干净的反向弧线，翻身的瞬间衣袍展开像一面旗；落点恰在对手背后，刃光从死角切进来",
    follow: "落地即转身，趁对手还没回头先出一记突刺",
    timing: { charge: [0.20, 0.34], active: [0.05, 0.09], recover: [0.32, 0.52] },
    range: [1.3, 2.3], arc: 90, band: "mid", tags: ["绕后", "抢角度"]
  },
  {
    key: "air_combo", zh: "空中连击", en: "aerial combo", category: "轻功", weapons: [], tiers: [5, 9],
    prep: "滞空的一瞬把兵器换到另一只手，肩与胯反向拧紧，准备连打两下",
    act: "在空中连出两到三击，第一击压住对手的兵器，后两击顺着惯性连续斩落",
    effect: "空中连续绽开两三道交错的刃光，像在半空写了几个字；最后一击把对手从空中直接砸回地面，水花炸成一圈低矮的白幕",
    follow: "落地后立刻压低身形，接着补一记扫堂或直接起身追击",
    timing: { charge: [0.16, 0.28], active: [0.08, 0.13], recover: [0.30, 0.50] },
    range: [1.2, 2.2], arc: 130, band: "mid", tags: ["连击", "空战"]
  },

  // ═══ 刀法 ═══
  {
    key: "dao_lipi", zh: "力劈华山", en: "mountain cleave", category: "近战", weapons: ["dao", "pu", "nodachi"], tiers: [3, 9],
    prep: "刀举过头顶、左手托住刀背，脚下扎成半马步，刀尖朝天",
    act: "全身力量自头顶贯下，刀走一条笔直的中线劈到地面，收势时刀背贴着小腿",
    effect: "刀风未到、地面的水先被压出一圈涟漪；命中时像被门板正面拍中，对手的兵器被一起压到地上，刀口带起一道白亮的水线直冲半空",
    follow: "劈到底就着刀背反弹起手，翻腕撩向对手下颌",
    timing: { charge: [0.24, 0.40], active: [0.05, 0.09], recover: [0.36, 0.58] },
    range: [1.3, 2.1], arc: 90, band: "high", tags: ["破防", "重压"]
  },
  {
    key: "dao_heng", zh: "横扫千军", en: "army-sweeping slash", category: "近战", weapons: ["dao", "nodachi", "pu"], tiers: [4, 9],
    prep: "刀收在左腋下，身体像拧紧的发条，重心压得很低，眼睛盯着对手的腰",
    act: "以腰带刀横扫半圈，刀锋自左至右掠过腰线，收刀时刀尖朝后",
    effect: "一刀扫出，雨幕被整齐地割成上下两半，水线悬在半空一拍才落下；命中处整条腰线裂开，对手被横扫得横着滑出去，脚下拖出两道平行的泥痕",
    follow: "横扫收势顺着力走完半圈，转身用反向的撩挑接上",
    timing: { charge: [0.20, 0.34], active: [0.05, 0.08], recover: [0.30, 0.48] },
    range: [1.5, 2.4], arc: 170, band: "mid", tags: ["横向覆盖", "压制"]
  },
  {
    key: "dao_chantou", zh: "缠头裹脑", en: "wrapping blade", category: "近战", weapons: ["dao"], tiers: [3, 9],
    prep: "刀绕着头顶转半圈，肩背随之滚动，脚下不停，像戴上一顶刀做的帽子",
    act: "刀自头顶绕过脖颈，从意想不到的角度贴脸砍入，出手路线是绕的、不是直的",
    effect: "刃光绕着头颈画出一个半圆，对手的招架往往落空；刀锋擦着护颈过去，金属摩擦声刺耳，火星在脸侧炸开一小簇",
    follow: "绕完一圈刀已经在另一侧，直接反手回抹",
    timing: { charge: [0.16, 0.28], active: [0.04, 0.07], recover: [0.24, 0.40] },
    range: [0.9, 1.6], arc: 200, band: "high", tags: ["贴身", "绕击"]
  },

  // ═══ 剑法 ═══
  {
    key: "jian_baihong", zh: "白虹贯日", en: "white-rainbow thrust", category: "近战", weapons: ["jian"], tiers: [4, 9],
    prep: "剑指并拢按在剑脊上，剑尖微垂，整个人静得像一潭水",
    act: "一剑直取中线，去势极快、去而不返，剑身与手臂成一条笔直的白线",
    effect: "剑光像一道白虹从胸前射出，快到只留下一根细亮的线；命中时在护具上点出一个白点，随之而来的是一串细密的火星与一声清越的剑鸣",
    follow: "剑不回撤，借着前冲的势再进一步，用剑锷撞击对手",
    timing: { charge: [0.10, 0.20], active: [0.03, 0.05], recover: [0.18, 0.30] },
    range: [1.8, 2.8], arc: 20, band: "mid", tags: ["突进", "点破"]
  },
  {
    key: "jian_huifeng", zh: "回风拂柳", en: "willow sweep", category: "近战", weapons: ["jian"], tiers: [3, 9],
    prep: "剑走轻灵，手腕先转、身体后随，剑尖在空中画一个极小的小圈",
    act: "剑身如柳条一般柔而不断，贴着对手的兵器缠上去，忽然一变方向斜抹其腕",
    effect: "剑光细碎绵密，像一阵风拂过柳枝；对手的兵器被粘住、卸不开也发不出力，只能眼睁睁看着剑尖抹上手背，血珠沿着剑锋一颗颗滚落",
    follow: "抹中即走，剑尖上挑接着刺面门",
    timing: { charge: [0.12, 0.22], active: [0.05, 0.08], recover: [0.20, 0.34] },
    range: [1.1, 1.9], arc: 80, band: "mid", tags: ["缠斗", "卸力"]
  },
  {
    key: "jian_yunv", zh: "玉女穿梭", en: "maiden's shuttle", category: "近战", weapons: ["jian"], tiers: [4, 9],
    prep: "剑交右手、左掌前引，步法走成斜十字，身影飘忽不定",
    act: "身形左右穿插，剑从对手的视野死角连刺三下，退时剑尖仍在最前",
    effect: "人影在雨里一闪一闪，剑光从三个方向同时亮起，像有三个自己在出剑；对手格挡住第一下，却挡不住后两下，肩头与腰侧同时渗出血线",
    follow: "穿到最后一步时突然定住，回身一记反向的斜劈",
    timing: { charge: [0.14, 0.26], active: [0.07, 0.11], recover: [0.26, 0.42] },
    range: [1.2, 2.1], arc: 100, band: "mid", tags: ["连击", "走位"]
  },

  // ═══ 枪法 / 棍棒 ═══
  {
    key: "qiang_zhongping", zh: "中平枪", en: "level spear", category: "长兵", weapons: ["qiang"], tiers: [2, 9],
    prep: "枪尖对准对手心口，后把压在腰侧，前手虚握、肘尖朝下，身形如树桩",
    act: "不用花招，就是扎——后脚一蹬、枪身一送，枪尖沿着最短的一条线捅过去",
    effect: "枪尖抖出一个碗口大的枪花，随后的直线扎刺只留一道白痕；命中时枪身弯成一个弧又被弹直，对手整条中线被顶穿，向后蹬蹬退了两步才站住",
    follow: "一扎不中立刻涮枪，用枪尾反打对手膝盖",
    timing: { charge: [0.08, 0.16], active: [0.03, 0.05], recover: [0.16, 0.28] },
    range: [2.4, 3.8], arc: 16, band: "mid", tags: ["远程压制", "点破"]
  },
  {
    key: "qiang_huima", zh: "回马枪", en: "turnaround spear", category: "长兵", weapons: ["qiang"], tiers: [4, 9],
    prep: "佯装败退，枪拖在后、脚步凌乱，眼睛却始终盯着对手追来的路线",
    act: "在对手追近的一瞬骤然回身，身体拧过半圈，枪借旋转之势反手刺出",
    effect: "退势忽然掐断，人影一转，枪尖从完全想不到的角度回刺；对手追赶的力道全部撞在枪尖上，被顶得双脚离地向后飞出去",
    follow: "回刺之后枪还不收，顺势横扫对手下盘",
    timing: { charge: [0.18, 0.32], active: [0.04, 0.07], recover: [0.28, 0.46] },
    range: [2.2, 3.6], arc: 30, band: "mid", tags: ["诱敌", "反打"]
  },
  {
    key: "gun_pishan", zh: "劈山棍", en: "mountain-splitting staff", category: "长兵", weapons: ["gun", "bang"], tiers: [3, 9],
    prep: "棍举过头、两手分握两端，肩背拉成一张弓，站在原地下沉半寸",
    act: "棍自上而下劈落，落点砸在对手的兵器或护具上，棍身压弯后弹回",
    effect: "棍风压得雨丝一歪，落点炸开一圈白雾；命中时棍身弯成月牙又弹直，把对手连人带兵器砸得一顿，脚下的石板应声裂开一条细缝",
    follow: "棍弹出即用另一端反手戳向对手胸口",
    timing: { charge: [0.22, 0.36], active: [0.05, 0.09], recover: [0.32, 0.52] },
    range: [1.6, 2.8], arc: 80, band: "high", tags: ["破防", "震退"]
  },
  {
    key: "bang_taishan", zh: "泰山压顶", en: "peak crush", category: "长兵", weapons: ["bang"], tiers: [4, 9],
    prep: "棒尾抵地、双手倒握，整个人像一根压紧的弹簧，膝盖微屈",
    act: "棒自下向上兜过一圈，再狠狠砸下，落点正对头顶，收势时棒尾点地",
    effect: "一棒落下，空气里滚过一声闷雷；地面被砸出一圈蛛网状的裂纹，水花呈伞状炸开，对手被自上而下压得单膝跪地",
    follow: "趁对手半跪，抬棒横扫其肩颈",
    timing: { charge: [0.24, 0.40], active: [0.05, 0.09], recover: [0.34, 0.56] },
    range: [1.5, 2.6], arc: 100, band: "high", tags: ["压制", "破防"]
  },
  {
    key: "nodachi_jh", zh: "居合斩", en: "iai slash", category: "近战", weapons: ["nodachi"], tiers: [5, 9],
    prep: "手按刀鞘、身体前倾成预备式，呼吸放到最慢，脚下随时能蹬出去",
    act: "拔刀与斩击是同一个动作——刀出鞘的瞬间已经越过了对手的腰线，收刀时刀身还在嗡鸣",
    effect: "只看到一道横光闪过，人已经站到对手身后，刀缓缓归鞘；对手的腰带先落地，随后才是一串细密的血珠在空中拉成一条线，雨幕被切开的口子过了一拍才合上",
    follow: "收刀即定，若对手未倒则转身补一记上撩",
    timing: { charge: [0.16, 0.30], active: [0.03, 0.06], recover: [0.30, 0.50] },
    range: [1.4, 2.3], arc: 140, band: "mid", tags: ["突袭", "决胜"]
  },
  {
    key: "nodachi_yangaeshi", zh: "燕返", en: "swallow's return", category: "近战", weapons: ["nodachi"], tiers: [6, 9],
    prep: "第一刀挥空、顺势转身，左脚在湿地上轻轻一捻，肩胛已经转到另一侧",
    act: "第一斩被让开，刀不停、人转身，借着回旋的离心力自下而上再斩第二刀",
    effect: "两道光痕在雨里交叉成一个「V」，第一次落空的刀势反而变成第二刀的加速；第二斩把对手从侧面整个掀起来，护具的系带在半空里断开",
    follow: "二连斩之后刀已回到胸前，直接接突刺收尾",
    timing: { charge: [0.20, 0.34], active: [0.08, 0.13], recover: [0.32, 0.54] },
    range: [1.4, 2.4], arc: 180, band: "mid", tags: ["连击", "反打"]
  },

  // ═══ 短兵 / 拳脚 ═══
  {
    key: "duanren_fanshou", zh: "反手割", en: "backhand cut", category: "近战", weapons: ["duanren"], tiers: [2, 9],
    prep: "短刃反握藏在腕后，肩膀前送装作要撞人，另一只手在身前虚晃",
    act: "贴身的一瞬手腕一翻，短刃自下向上反挑对手的肘弯或腹侧，动作小得几乎看不见",
    effect: "几乎看不见刃影，只听到一声轻微的割裂声；对手的手筋一麻、兵器脱力，血珠沿着腕线渗出来，顺着雨水往下淌",
    follow: "割中即退半步，把短刃收回袖口重新藏好",
    timing: { charge: [0.08, 0.16], active: [0.03, 0.05], recover: [0.14, 0.24] },
    range: [0.6, 1.2], arc: 60, band: "low", tags: ["贴身", "暗手"]
  },
  {
    key: "quan_cun", zh: "寸拳", en: "one-inch punch", category: "拳脚", weapons: ["none"], tiers: [3, 9],
    prep: "拳面贴在对手胸口的护具上，肘微屈、肩沉下，脚跟已经离地三寸",
    act: "行程只有一寸：脚跟一碾、胯一弹、力从地起，一拳把整条力线打进对手体内",
    effect: "看不出挥拳，只看见护具忽然向内凹了一寸；对手的呼吸被这一下截断，整个人向后腾空滑出去，落地时护甲上还留着一个清晰的拳印",
    follow: "打完立刻收拳贴身，另一只手护住中线",
    timing: { charge: [0.06, 0.14], active: [0.02, 0.04], recover: [0.16, 0.28] },
    range: [0.4, 0.9], arc: 10, band: "mid", tags: ["贴身", "破防"]
  },
  {
    key: "quan_biaozhi", zh: "标指", en: "finger jab", category: "拳脚", weapons: ["none"], tiers: [4, 9],
    prep: "五指并拢成标，手臂放松、肘尖下垂，身体侧成一条线",
    act: "指尖像飞镖一样弹射出去，速度极快、路径极短，目标是眼睛与咽喉",
    effect: "一道极细的风声掠过，对手本能地闭眼后仰；指尖擦过之处留下一条红痕，眼泪与雨水混在一起，视线出现了半拍的空窗",
    follow: "指势一收就变拳，用同一只手正拳追打",
    timing: { charge: [0.06, 0.12], active: [0.02, 0.04], recover: [0.14, 0.24] },
    range: [0.5, 1.1], arc: 8, band: "high", tags: ["抢先", "扰敌"]
  },
  {
    key: "tui_bian", zh: "鞭腿", en: "whip kick", category: "拳脚", weapons: ["none"], tiers: [3, 9],
    prep: "支撑腿微屈、上身向反方向倾倒作配重，踢击腿像鞭子一样先松后紧",
    act: "胯部先转、大腿带小腿，脚背抽在对手的腰肋上，收腿时膝盖先回、脚背后收",
    effect: "腿影扫过留下一条弧，雨水被腿风抽得四散；命中时「啪」的一声脆响，对手的腰被抽得一弯，脚下横移半步才勉强站稳",
    follow: "收腿落地就蹬地起跳，接一记膝撞",
    timing: { charge: [0.12, 0.22], active: [0.04, 0.07], recover: [0.22, 0.36] },
    range: [1.0, 1.8], arc: 90, band: "mid", tags: ["重腿", "压制"]
  },
  {
    key: "quan_longzhua", zh: "龙爪手", en: "dragon claw", category: "拳脚", weapons: ["none"], tiers: [5, 9],
    prep: "五指弯曲成钩、掌心内陷，臂上青筋凸起，脚下踩成弓步",
    act: "探手直取对手的兵器或腕关节，一抓即锁，随后顺着关节能动的方向猛地一拧",
    effect: "指节像钢钩一样扣进护具缝隙，发出皮革绷紧的声音；随手腕一拧，对手整个人被带得侧身跪下，兵器被硬生生拧脱手，在空中翻了两圈才落地",
    follow: "锁住之后立刻换手劈掌，趁对手重心不稳追打",
    timing: { charge: [0.14, 0.26], active: [0.04, 0.08], recover: [0.24, 0.40] },
    range: [0.8, 1.5], arc: 40, band: "mid", tags: ["擒拿", "卸兵器"]
  },
  {
    key: "zhang_tiesha", zh: "铁砂掌", en: "iron palm", category: "拳脚", weapons: ["none"], tiers: [5, 9],
    prep: "掌心朝下缓缓抬起，臂上气劲鼓动，脚下碾地留出一个深深的脚印",
    act: "一掌拍下，掌风先到、掌肉后到，拍中的位置往往是对手的护具接缝",
    effect: "掌风压得雨水向外炸开一圈；命中时护具像被铁锤砸过一样从中间凹陷，对手向后倒滑半米，脚下的雨水被犁成两道笔直的水线",
    follow: "一掌拍完不收，另一掌贴着前掌推出去，形成连掌",
    timing: { charge: [0.18, 0.32], active: [0.04, 0.07], recover: [0.28, 0.46] },
    range: [0.9, 1.6], arc: 70, band: "mid", tags: ["破防", "震退"]
  },
  {
    key: "light_yanhui", zh: "燕回身", en: "swallow turn", category: "轻功", weapons: [], tiers: [3, 9],
    prep: "脚尖点地、上身先转，像被风吹了一下，重心已经移到身后",
    act: "整个人贴着地面转半圈，让开对手的直线攻击，转过来的同时兵器已经挥出",
    effect: "身形像燕子掠过水面一样轻，刃光擦着对手的攻击线划过去；对手打了个空、重心前倾，正好撞在这一记反手上，被带得原地打转",
    follow: "转身完成时刀已在另一侧，直接接斜劈",
    timing: { charge: [0.10, 0.20], active: [0.04, 0.07], recover: [0.20, 0.34] },
    range: [1.0, 1.8], arc: 180, band: "mid", tags: ["闪反", "走位"]
  },
  {
    key: "light_taxue", zh: "踏雪无痕", en: "trackless step", category: "轻功", weapons: [], tiers: [5, 9],
    prep: "提气轻身，落脚极轻，脚尖先着地，整个人像没有重量",
    act: "连续三次极快的斜向垫步，每次都从对手的攻击线外缘滑过去，闪的同时逼近",
    effect: "湿地上几乎看不到脚印，只有几道被水汽带起的浅痕；对手的三次攻击全部落在虚影上，第三刀挥空时人已经被贴到身前",
    follow: "贴上去之后不再闪，直接用寸拳或短刃解决",
    timing: { charge: [0.12, 0.22], active: [0.10, 0.16], recover: [0.18, 0.30] },
    range: [0.8, 2.4], arc: 360, band: "mid", tags: ["闪避", "贴身"]
  },
  {
    key: "light_tiyun", zh: "梯云纵", en: "cloud ladder leap", category: "轻功", weapons: [], tiers: [6, 9],
    prep: "脚踏虚空也要有个落点，膝盖提起、眼神向上找檐角，膝盖上顶的一瞬发力",
    act: "在半空中靠一记提膝借力再上一段，随后整个人直落下来，兵器随身而下",
    effect: "人像踩着一级看不见的台阶，硬生生在半空又多升了一截；下落时衣袍被风完全兜开，刃光自上而下劈成一条笔直的白线",
    follow: "落地前调整姿态，落点选在对手侧后，接绕后的突刺",
    timing: { charge: [0.20, 0.34], active: [0.06, 0.10], recover: [0.32, 0.52] },
    range: [1.2, 2.4], arc: 90, band: "high", tags: ["升空", "空袭"]
  },

  // ═══ 法术 / 气功（与内核 MOVE_EFFECTS 对齐）═══
  {
    key: "spell_xianglong", zh: "降龙十八掌", en: "Eighteen Dragon Palms", category: "法术", weapons: [], tiers: [5, 9],
    prep: "双足扎马、双掌后收于腰侧，掌缘泛出淡淡的金气，脚下湿石被气劲蒸出一圈白汽",
    act: "双掌自腰间向前推出，掌力脱手成形——一条金色的龙形气劲张爪摆尾、贴着地面扑向对手",
    effect: "龙形气劲在雨幕里划出一条翻腾的金色轨迹，所过之处雨水被灼成白汽、地面犁出一道浅沟；命中时龙首当胸炸开，金光与雨珠同时炸成一团，对手被推得双脚离地向后滑出数米，衣袍与碎石全被气浪掀开",
    follow: "收掌立定，气未尽时立刻再推第二掌，形成连击",
    timing: { charge: [1.0, 3.0], active: [0.10, 0.16], recover: [0.30, 0.55] },
    range: [4.0, 16.0], arc: 24, band: "mid", tags: ["气功", "自动追踪", "决胜"]
  },
  {
    key: "spell_liumai", zh: "六脉神剑", en: "Six Meridians Sword", category: "法术", weapons: [], tiers: [5, 9],
    prep: "食中二指并拢如剑，指尖泛起极淡的青光，身形立稳、呼吸沉到丹田",
    act: "指尖向前一点，一道无形剑气自指端激射而出，笔直锁向对手的关键穴位",
    effect: "看不见剑身，只看雨幕上突然出现一条笔直的空白（水汽被剑气灼开的痕迹）；命中处炸出一簇细密血珠与火星，对手被点得僵住半拍，护具上出现一个整齐的圆孔",
    follow: "指势不停，换另一只手连点三下，形成剑气连击",
    timing: { charge: [0.6, 1.6], active: [0.05, 0.09], recover: [0.22, 0.40] },
    range: [3.0, 14.0], arc: 8, band: "mid", tags: ["剑气", "自动追踪", "点破"]
  },
  {
    key: "spell_pikong", zh: "劈空掌", en: "air-splitting palm", category: "法术", weapons: [], tiers: [4, 9],
    prep: "沉肩坠肘、掌心向下压住气机，前脚掌吃地，肩背先蓄后放",
    act: "单掌自上向下劈出，一道掌形气浪贴地推出去，飞行中略微下沉",
    effect: "空气里出现一只半透明的巨大掌影，贴着湿地面推进，把地上的雨水压成两道向外翻的水墙；命中时像被门板撞中，对手横着飞出去，脚下拖出两道深沟",
    follow: "掌势未收就换另一只手起势，连劈两掌",
    timing: { charge: [0.8, 2.2], active: [0.06, 0.10], recover: [0.26, 0.45] },
    range: [2.5, 12.0], arc: 40, band: "low", tags: ["掌风", "震退"]
  },
  {
    key: "spell_tanzhi", zh: "弹指神通", en: "flicking finger", category: "法术", weapons: [], tiers: [4, 9],
    prep: "拇指扣住中指，腕部内旋蓄劲，指节绷得发白",
    act: "一指弹出，指风凝成一颗小小的弹丸，直取对手面门",
    effect: "一声极脆的「铮」，指风在半空留下一道极短的亮线；命中面门时对手头向后猛仰，兵器从手里飞出去插进地面，人后退两步才找回平衡",
    follow: "弹完立刻欺身而上，用掌追打",
    timing: { charge: [0.3, 0.9], active: [0.03, 0.06], recover: [0.18, 0.32] },
    range: [3.0, 10.0], arc: 6, band: "high", tags: ["指法", "自动追踪", "扰敌"]
  },
  {
    key: "spell_qigong", zh: "气功波", en: "qi wave", category: "法术", weapons: [], tiers: [6, 9],
    prep: "双掌合于腰侧成碗状，腰马下沉，掌心的一点亮光由小涨大，把周围雨丝都蒸成白雾",
    act: "双掌前送，球形气团脱手飞出，飞行途中不断膨胀，把沿途的雨滴全部卷入",
    effect: "一颗发亮的气团在雨幕中越飞越大，拖出一条明亮的尾迹，照得两侧灯笼都失了颜色；命中时炸开成一面半圆的光墙，对手被冲击波整个掀翻，地面留下焦黑的痕迹",
    follow: "气团出手后立刻后撤半步，重新聚气准备第二发",
    timing: { charge: [1.2, 3.5], active: [0.12, 0.20], recover: [0.40, 0.70] },
    range: [4.0, 18.0], arc: 30, band: "mid", tags: ["气功", "自动追踪", "范围"]
  },
  {
    key: "spell_fire", zh: "烈焰掌", en: "flame palm", category: "法术", weapons: [], tiers: [3, 9],
    prep: "掐诀结印、袖口先冒起一缕青烟，掌心的空气被烤得扭曲",
    act: "掌力送出，一团火球拖着尾焰飞向对手，沿途把雨水烧出一串白汽",
    effect: "火球在雨夜里格外刺眼，尾焰把地面照成橘红；命中时炸开一团火焰，对手护具被燎得焦黑卷边，火星四散落进水洼里滋滋作响",
    follow: "火起时人已经欺近，趁对手扑火的一瞬出拳",
    timing: { charge: [0.7, 2.0], active: [0.08, 0.14], recover: [0.30, 0.52] },
    range: [2.5, 10.0], arc: 26, band: "mid", tags: ["术法", "灼烧"]
  },
  {
    key: "spell_ice", zh: "寒冰锥", en: "frost shards", category: "法术", weapons: [], tiers: [3, 9],
    prep: "掌心凝出白霜，指节泛青，呼吸带出一缕白气",
    act: "挥掌洒出数枚冰锥，成扇面飞去，飞行途中不断吸附雨水加粗",
    effect: "冰锥在雨幕里拉出几道白线，碰到什么就把什么冻上一层薄冰；命中时炸成一片霜雾，对手的兵器与衣袖瞬间结霜变脆，站在原地打了个冷颤",
    follow: "趁对手动作变缓，直接贴上去用兵器解决",
    timing: { charge: [0.7, 2.0], active: [0.07, 0.12], recover: [0.28, 0.48] },
    range: [3.0, 12.0], arc: 45, band: "mid", tags: ["术法", "减速"]
  },
  {
    key: "spell_thunder", zh: "雷弧击", en: "lightning arc", category: "法术", weapons: [], tiers: [5, 9],
    prep: "抬手引雷，发梢倒立，空气中飘起一丝焦味，指尖噼啪作响",
    act: "一道雷弧自掌心窜出，几乎不走直线——它沿着最近的水汽扑向对手",
    effect: "惨白的弧光把整个街口照成一瞬的黑白画面；命中处爆出刺目的白亮与焦糊味，对手全身僵直、头发立起，兵器被电弧震得脱手飞出",
    follow: "雷弧之后对手短暂僵直，直接上前补终结一击",
    timing: { charge: [0.5, 1.5], active: [0.03, 0.06], recover: [0.24, 0.42] },
    range: [2.0, 9.0], arc: 12, band: "mid", tags: ["术法", "僵直"]
  }
];

// ── 索引与查询 ──────────────────────────────────────────────────────────────
const byKey = new Map();
const byName = new Map();
const AUTO = [];                       // 自动入库的新招式（本次会话 + 持久化载入）

function _norm(s) { return String(s || "").trim(); }

function _index(mv) {
  if (!mv) return mv;
  // 防御：没有 key 的条目（例如外部只传了名字）也补一个唯一 key，否则会**进不了索引**、
  // 导致 list 查得到而 get 查不到（实测踩过：CLI 传 key:undefined 覆盖了生成的 key）
  if (!mv.key) mv.key = "auto_" + (AUTO.length + 1) + "_" + Math.abs(_hash(mv.zh || "")).toString(36).slice(0, 5);
  if (!mv.source) mv.source = "seed";          // 内置条目也标来源，便于统计"库里调用率"
  // 自愈：老版本写盘的条目可能缺字段（missing timing 会让 paramsOf 直接炸 —— 实测踩过）
  if (!mv.timing || !mv.timing.charge || !mv.timing.active || !mv.timing.recover) {
    mv.timing = { charge: [0.12, 0.24], active: [0.04, 0.08], recover: [0.22, 0.38] };
  }
  if (!Array.isArray(mv.range) || mv.range.length !== 2) mv.range = [1.2, 2.2];
  if (mv.arc == null) mv.arc = 90;
  if (!mv.band) mv.band = "mid";
  if (!Array.isArray(mv.tags)) mv.tags = [];
  if (!Array.isArray(mv.weapons)) mv.weapons = [];
  if (!mv.category) mv.category = "近战";
  // key 冲突纪律：**内置（seed）优先**。自动入库的旧条目若占了基础变体的 key（如 "slash"），
  // 就给它换一个唯一 key，否则「横斩」会被从 key 索引里挤掉（实测踩过这个坑）。
  const prev = byKey.get(mv.key);
  if (prev && prev !== mv && prev.source === "seed" && mv.source !== "seed") {
    mv.key = "auto_" + Math.abs(_hash(mv.zh || mv.key)).toString(36).slice(0, 6) + "_" + mv.key;
  }
  byKey.set(mv.key, mv);
  if (mv.zh) byName.set(_norm(mv.zh), mv);
  if (mv.en) byName.set(_norm(mv.en).toLowerCase(), mv);
  return mv;
}

SEED.forEach(_index);

/** 全部招式（内置 + 自动入库） */
function all() { return SEED.concat(AUTO); }

/** 取招式：支持 key、中文名、英文名 */
function get(keyOrName) {
  const k = _norm(keyOrName);
  return byKey.get(k) || byName.get(k) || byName.get(k.toLowerCase()) || null;
}

/** 按兵器/等级筛出可用招式（库里查得到就用库里，查不到交给内核生成） */
function query(opt) {
  opt = opt || {};
  const wpn = opt.weapon, tier = opt.tier == null ? 5 : opt.tier;
  const cat = opt.category, band = opt.band;
  return all().filter(m => {
    if (cat && m.category !== cat) return false;
    if (band && m.band !== band) return false;
    if (m.tiers && (tier < m.tiers[0] || tier > m.tiers[1])) return false;
    if (wpn && m.weapons && m.weapons.length && m.weapons.indexOf(wpn) < 0) return false;
    return true;
  });
}

/** 同 key 的招式（用于对比不同兵器的同名招式） */
function variantsOf(key) { return all().filter(m => m.key === key); }

/**
 * 自动生成"华丽但准确"的招式描述（给入库的新招式用）。
 * 依据：兵器、扇角（横扫/直刺/上撩/下劈/回旋）、高度带、是否空中、卡牌自带的效果文本。
 * 目的：新招式入库后**描述也是满的**，不是一句"循最短路径出手"。
 */
const WPN_IMG = {
  dao: { light: "刀光如匹练", hit: "刀口犁开一道白亮的血线", sound: "刀风嗡鸣" },
  nodachi: { light: "太刀拖出一道长长的银弧", hit: "刀锋切开护具，火星成串迸出", sound: "刀身震鸣" },
  pu: { light: "朴刀劈出一道厚重的光墙", hit: "刀背砸得护具向内凹陷", sound: "一声闷雷般的刀风" },
  jian: { light: "剑光细如游丝", hit: "剑尖在护具上点出一个白点", sound: "清越的剑鸣" },
  qiang: { light: "枪尖抖出一个碗口大的枪花", hit: "枪尖顶穿一线，护具被戳出圆孔", sound: "枪身弹直的颤音" },
  gun: { light: "棍影压成一道直线", hit: "棍身砸得对手一顿，护具凹下一条杠", sound: "棍风低沉" },
  bang: { light: "棒影沉重，压得雨丝一歪", hit: "棒头砸出一圈涟漪般的震波", sound: "一声闷响" },
  duangun: { light: "短棍扫出一片残影", hit: "短棍敲在护具上发出脆响", sound: "短促的棍风" },
  duanren: { light: "刃影几乎看不见", hit: "刃锋留下一道极细的红痕", sound: "轻微的割裂声" },
  none: { light: "拳掌带起一片水雾", hit: "拳掌拍在护具上炸开一圈气浪", sound: "筋骨绷紧的爆响" }
};
const AIR_ACT = {
  low: ["自下向上一记撩挑", "贴着地面斜挑而起", "从膝下往上一路挑起"],
  mid: ["自外向内横扫一线", "中路直取，走的是最短那条线", "拧腰送肩，一条力线贯到底"],
  high: ["自肩后高举劈落", "自上而下压下来", "从头顶斜着剖下一线"]
};

function autoDescribe(opt) {
  opt = opt || {};
  const w = opt.weapon || "none";
  const img = WPN_IMG[w] || WPN_IMG.none;
  const band = opt.band || "mid";
  const arc = opt.arc == null ? 90 : opt.arc;
  const zh = opt.zh || "无名招式";
  const air = !!opt.air;
  const tierWord = (opt.tier || 5) >= 7 ? "气劲透体，连空气都被推出一圈涟漪，" : "";
  const card = (opt.effect || "").trim();
  const tags = opt.tags || [];
  const isSpell = opt.category === "法术" || tags.indexOf("术法") >= 0 || tags.indexOf("气功") >= 0
                  || tags.indexOf("剑气") >= 0 || tags.indexOf("掌风") >= 0 || tags.indexOf("指法") >= 0;

  // ── 法术/气功：起势聚气 → 脱手成形 → 途中自寻目标 → 炸开 ───────────────
  if (isSpell) {
    const prep = "沉腰坐马、双掌在身侧聚气，掌心那一点气团由小涨大、亮得照出半张脸的轮廓，衣袍被气劲顶得向后飘";
    const act = "双掌（指）前送，气劲脱手成形——化作一道明亮的气形直扑对手，飞行途中还顺着对手的移动微微修正方向";
    const effect = tierWord + "气形划破雨幕，把沿途的雨丝灼成一片白汽、照得两侧物件都失了颜色；"
      + "命中时当胸炸开，气浪呈半圆向外掀，对手双脚离地向后滑出数米，衣袍与碎石被一并卷起"
      + (card ? "；" + card.replace(/[。；]$/, "") : "");
    return { prep, act, effect, follow: "气劲出手后立刻收势回气，指尖余芒未散，准备续下一发" };
  }

  // ── 轻功/空中招：跃起 → 空中姿态 → 落地砸出水环 ───────────────────────
  if (air || opt.category === "轻功") {
    const prep = "屈膝蓄力、兵器后引，起跳前肩背先动、脚下才蹬地，落点已经在眼里";
    const act = "腾空后收腿转体，借下坠的势能把全身重量灌进这一击，落地时双足砸出一圈水环";
    const effect = "人影自半空压下来，刃光像一道自天而降的白线；落地砸出的水环向外炸开，刃锋过处雨幕被整齐切开"
      + (card ? "；" + card.replace(/[。；]$/, "") : "");
    return { prep, act, effect, follow: "落地屈膝卸力，顺势贴地扫腿或直接起身再劈" };
  }

  const shape = arc >= 150 ? "横扫" : arc >= 90 ? "斜斩" : arc >= 30 ? "压劈" : "直刺";
  const prep = band === "high" ? "兵器高举过顶、重心后坐，肩背像弓一样绷紧，脚下碾地留印"
    : band === "low" ? "身形骤然下沉，兵器收到膝下，刃尖指向地面"
      : "侧身而立、兵器横于身前，目锁对手中线，脚下暗含半步";
  const act = (AIR_ACT[band] || AIR_ACT.mid)[0] + "，" + (w === "none" ? "拳掌" : "兵器") + "走出一条干净的" + shape + "线";
  const effect = tierWord + img.light + "划破雨幕，" + img.sound + "压过雨声；"
    + "命中时" + img.hit + "，对手被这一" + shape + "带得脚步一乱、向侧后滑出半步，"
    + "水花与火星一起炸开" + (card ? "；" + card.replace(/[。；]$/, "") : "");
  const follow = "收势不急不躁，兵器回到身前中位，顺势转腕准备下一手";
  return { prep, act, effect, follow };
}

/**
 * 自动入库：库里没有的招式，用给定信息建一条完整条目并登记。
 * 下次再用同名招式就直接 get() 到它 —— 满足"再度使用同样招式就在招式库中调用"。
 */
function register(entry) {
  if (!entry || (!entry.zh && !entry.key)) return null;
  const exist = get(entry.zh || entry.key);
  if (exist) return exist;
  // 自动生成华丽描述（库里没有现成描述时用），保证入库条目"字段齐全、效果够华丽"
  const auto = autoDescribe({ zh: entry.zh, weapon: (entry.weapons || [])[0], band: entry.band,
                              arc: entry.arc, air: entry.air, tier: (entry.tiers || [])[0],
                              category: entry.category, tags: entry.tags, effect: entry.effect });
  // key 不能抢占基础变体（否则自动入库的「普通攻击」会把「横斩」从 key 索引里挤掉）
  let key = entry.key;
  if (!key || (byKey.has(key) && byKey.get(key).zh !== (entry.zh || ""))) {
    key = "auto_" + (AUTO.length + 1) + "_" + Math.abs(_hash(entry.zh || "")).toString(36).slice(0, 5);
  }
  // **剥掉显式 undefined**：调用方常写 `key: spec.key`（可能是 undefined），
  // Object.assign 会让它覆盖掉我们生成的默认值（实测：条目没 key → 名字索引失效 → get 查不到）
  const clean = {};
  Object.keys(entry).forEach(k => { if (entry[k] !== undefined) clean[k] = entry[k]; });
  const mv = Object.assign({
    key: key,
    zh: entry.zh || "无名招式", en: entry.en || "", category: entry.category || "近战",
    weapons: entry.weapons || [], tiers: entry.tiers || [1, 9],
    timing: entry.timing || { charge: [0.12, 0.24], active: [0.04, 0.08], recover: [0.22, 0.38] },
    range: entry.range || [1.2, 2.2], arc: entry.arc == null ? 90 : entry.arc,
    band: entry.band || "mid", tags: entry.tags || [], source: entry.source || "auto"
  }, clean);
  mv.source = mv.source || "auto";
  // 描述字段的优先级：**调用方给的够长才算"描述"**；短文本（如卡里的"一挥手江河倒灌"）
  // 只当标签，用自动生成的华丽描述（其中已经把这句话缀在结尾）。
  const rich = (x, n) => typeof x === "string" && x.trim().length >= n ? x : "";
  mv.prep = rich(entry.prep, 8) || auto.prep;
  mv.act = rich(entry.act, 8) || auto.act;
  mv.follow = rich(entry.follow, 6) || auto.follow;
  mv.effect = rich(entry.effect, 24) || auto.effect;
  AUTO.push(mv);
  _index(mv);
  return mv;
}

function _hash(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h * 16777619) >>> 0; } return h; }

/**
 * 招式的时间/距离参数（范围值）→ 供内核按档次缩放后使用。
 * 返回 { charge:[a,b], active:[a,b], recover:[a,b], range:[a,b], arc, band }
 */
function paramsOf(keyOrName) {
  const m = get(keyOrName);
  if (!m) return null;
  const t = m.timing || { charge: [0.12, 0.24], active: [0.04, 0.08], recover: [0.22, 0.38] };
  return { charge: t.charge.slice(), active: t.active.slice(),
           recover: t.recover.slice(), range: (m.range || [1.2, 2.2]).slice(),
           arc: m.arc == null ? 90 : m.arc, band: m.band || "mid" };
}

/** 统计：库里有多少招式、各分类多少、自动入库多少 */
function stats() {
  const byCat = {}, bySource = { seed: 0, auto: 0, user: 0 };
  all().forEach(m => { byCat[m.category] = (byCat[m.category] || 0) + 1; bySource[m.source] = (bySource[m.source] || 0) + 1; });
  return { total: all().length, seed: SEED.length, auto: AUTO.length, byCategory: byCat, bySource };
}

// ── 自动入库的持久化 ────────────────────────────────────────────────────────
//   Node（EXE 内置/命令行）：写 sim3d/moves-user.json
//   浏览器（单文件应用）：写 localStorage —— 关掉再开，新招式仍在库里（下次直接调用）
const LS_KEY = "h3_moves_user_v1";

function _ls() {
  try { return (typeof localStorage !== "undefined") ? localStorage : null; } catch (e) { return null; }
}

function userPath() {
  try {
    if (typeof require !== "function") return null;
    const g = (typeof globalThis !== "undefined") ? globalThis : {};
    if (g.__exeShell || typeof document !== "undefined") return null;   // 浏览器形态走 localStorage
    return require("path").join(__dirname, "moves-user.json");
  } catch (e) { return null; }
}

function saveUser() {
  const data = AUTO.map(m => Object.assign({}, m));
  const p = userPath();
  if (p) {
    try { require("fs").writeFileSync(p, JSON.stringify(data, null, 1), "utf8"); return true; }
    catch (e) { /* 落盘失败就退回 localStorage */ }
  }
  const ls = _ls();
  if (ls) {
    try { ls.setItem(LS_KEY, JSON.stringify(data)); return true; } catch (e) { return false; }
  }
  return false;
}

function loadUser() {
  let data = null;
  const p = userPath();
  if (p) {
    try { data = JSON.parse(require("fs").readFileSync(p, "utf8")); } catch (e) { data = null; }
  }
  if (!data) {
    const ls = _ls();
    if (ls) { try { data = JSON.parse(ls.getItem(LS_KEY) || "null"); } catch (e) { data = null; } }
  }
  if (!Array.isArray(data)) return 0;
  let n = 0;
  data.forEach(m => {
    if (get(m.zh || m.key)) return;
    // 质量闸：早期版本生成的自动条目描述太弱（甚至只有一句卡面文案）→ 用当前生成器重写
    if (m.source === "auto") {
      const auto = autoDescribe({ zh: m.zh, weapon: (m.weapons || [])[0], band: m.band, arc: m.arc,
                                  category: m.category, tags: m.tags, tier: (m.tiers || [])[0],
                                  effect: (m.effect && m.effect.length < 40) ? m.effect : "" });
      if (!m.prep || m.prep.length < 10) m.prep = auto.prep;
      if (!m.act || m.act.length < 10) m.act = auto.act;
      if (!m.follow || m.follow.length < 8) m.follow = auto.follow;
      if (!m.effect || m.effect.length < 30) m.effect = auto.effect;
    }
    AUTO.push(m); _index(m); n++;
  });
  return n;
}

loadUser();

const API = {
  VERSION: MOVE_LIB_VERSION,
  SEED, all, get, query, variantsOf, register, paramsOf, stats, autoDescribe,
  saveUser, loadUser, userPath,
  count: () => all().length
};

// Node（require）与浏览器（<script>）双形态：浏览器里挂到 SIM3D_MOVES / MOVE_LIB，
// engine.js 在工厂函数里会去 globalThis 上取它 —— 所以 moves.js 必须先于 engine.js 加载。
if (typeof module === "object" && module.exports) module.exports = API;
if (typeof globalThis !== "undefined") { globalThis.MOVE_LIB = API; globalThis.SIM3D_MOVES = API; }
