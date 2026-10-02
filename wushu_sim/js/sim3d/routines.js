/* ============================================================================
 * sim3d/routines.js —— 招式套路库（每一条招式＝一整套组合套路，招式内部的动作逐条记录）
 * ----------------------------------------------------------------------------
 * 用户要求（2026-10-01）：
 *   「每个角色会的招式，不单单就是一个招式名字，每个招式都是一整个招式组合套路。
 *     这个组合套路你都要描述里面包含的动作。比如咏春的问手、日字冲拳等。你招式库一定做成
 *     招式套路库。每个招式套路的招式要记录完整。」
 *
 * 数据结构（一条套路）：
 *   key/zh/en        套路的名字（例：咏春·日字冲拳）
 *   style            门派/风格（咏春/洪拳/长拳/形意/八卦/太极/八极/通背/螳螂/醉拳/散打/拳击/摔拿/兵器…）
 *   weapons          适用兵器（[]＝空手；"dao"/"jian"/"gun"/"qiang"/"shuang"/"bian"…）
 *   tiers            适用武力等级区间
 *   range/band       常用距离（米）与主要打击层（high/mid/low/leg）
 *   steps[]          **套路里的动作**，逐条记录：代号/名称/意图/手脚/打击部位/节奏/说明
 *   chain[]          可接的下一手（连招）
 *   note             套路要点（怎么用、什么时候用）
 *
 * steps 里每一条 = 一个可拍可判定的动作，字段：
 *   zh        动作名（例：摊手、日字冲拳、转马）
 *   act       意图码：probe 试探｜trap 封拿｜strike 击打｜kick 踢击｜grab 抓拿｜throw 摔投｜
 *             move 步法｜parry 拍格｜finish 终结
 *   limb      出手部位（前手/后手/双手/前腿/后腿/肘/肩/头/全身）
 *   target    打击/作用部位：high 上段｜mid 中段｜low 下段｜leg 腿｜arm 手臂
 *   t         节奏 [起手, 有效, 收招]（秒）；不写则按 act 取默认
 *   dmg       该步的伤害系数（相对基础招式；1.0＝与普通一招相当）
 *   range     该步的距离（可选，缺省用套路 range）
 *   note      这一步具体在做什么（**必须写清楚**：手脚怎么动、打到哪、身体怎么配合）
 * ========================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SIM3D_ROUTINES = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const VERSION = 'routine-lib-2.0';

  /* 各意图的默认节奏（秒）与伤害系数：写套路时不用逐条重复 */
  const ACT = {
    probe: { zh: '试探', t: [0.07, 0.03, 0.06], dmg: 0.25 },
    trap: { zh: '封拿', t: [0.07, 0.04, 0.07], dmg: 0.35 },
    strike: { zh: '击打', t: [0.08, 0.05, 0.09], dmg: 1.00 },
    kick: { zh: '踢击', t: [0.11, 0.06, 0.13], dmg: 1.10 },
    grab: { zh: '抓拿', t: [0.09, 0.05, 0.09], dmg: 0.40 },
    throw: { zh: '摔投', t: [0.12, 0.08, 0.16], dmg: 1.45 },
    move: { zh: '步法', t: [0.05, 0.03, 0.05], dmg: 0.00 },
    parry: { zh: '拍格', t: [0.06, 0.03, 0.06], dmg: 0.20 },
    finish: { zh: '终结', t: [0.14, 0.07, 0.20], dmg: 1.60 }
  };

  const R = (key, zh, en, style, weapons, tiers, range, band, steps, chain, note) => ({
    key, zh, en, style, weapons: weapons || [], tiers: tiers || [1, 9],
    range: range || [0.9, 1.8], band: band || 'mid',
    steps: (steps || []).map((s, i) => {
      const a = ACT[s[1]] || ACT.strike;
      return {
        i: i + 1, zh: s[0], act: s[1] || 'strike', actZh: a.zh,
        limb: s[2] || '前手', target: s[3] || 'mid',
        t: s[4] || a.t.slice(), dmg: s[5] == null ? a.dmg : s[5],
        note: s[6] || '', range: s[7] || null
      };
    }),
    chain: chain || [], note: note || ''
  });

  /* ────────────────────────────────────────────────────────────────────────
   * 套路库：按门派/风格分组。每一条都尽量把「手脚怎么动、打到哪、身体怎么跟」写全。
   * ──────────────────────────────────────────────────────────────────────── */
  const SEED = [

    /* ══ 咏春 ══ 中线短打、连消带打、日字冲拳是一串而不是一拳 ══ */
    R('wc_wen', '问手', 'Wing Chun asking hand', '咏春', [], [1, 9], [0.9, 1.7], 'high', [
      ['起手问手', 'probe', '前手', 'high', null, 0.25, '前手五指并拢掌心向上向对手面前探出，指尖对准鼻梁，后手收在胸口中线，重心偏后脚'],
      ['摊手封中', 'trap', '前手', 'mid', null, 0.35, '前臂外旋把对手来拳向侧面摊开，肘尖下沉护住中线，身体不动脚不挪'],
      ['转马摊打', 'strike', '前手', 'high', null, 0.95, '后脚跟一碾转马，前手由摊变打，掌心向下沿中线推到对手面门'],
      ['后手护中', 'move', '后手', 'mid', null, 0.0, '打完后手立刻回到中线护住胸口，恢复问手架']
    ], ['wc_chain', 'wc_tan_da'], '咏春的"问"是先用前手把对手的反应问出来：他往哪动，你就往哪打。'),

    R('wc_chain', '日字冲拳', 'Wing Chun chain punch', '咏春', [], [1, 9], [0.7, 1.5], 'high', [
      ['摊手开门', 'trap', '前手', 'mid', null, 0.3, '前手摊开把对手的桥手压向一侧，给自己让出中线'],
      ['前手日字冲拳', 'strike', '前手', 'high', null, 0.85, '拳心向上、肘不出肋，直线沿中线打到对手面门，打到即收不贪'],
      ['后手日字冲拳', 'strike', '后手', 'high', null, 0.85, '前手收回的同时后手已经打出，两拳交替不停，第二拳追着第一拳的缝进'],
      ['第三拳压进', 'strike', '前手', 'high', null, 0.8, '脚下贴身半步，第三拳继续沿同一条线打，把对手顶在墙上'],
      ['转马追打', 'move', '全身', 'mid', null, 0.0, '若对手横移，马步随之转动，拳不停继续追中线']
    ], ['wc_wen', 'wc_tan_da'], '日字冲拳是一条**拳线**：一拳接一拳走同一条中线，中间不留空拍。'),

    R('wc_tan_da', '摊打', 'Wing Chun tan-da', '咏春', [], [2, 9], [0.8, 1.6], 'high', [
      ['摊手接桥', 'trap', '前手', 'arm', null, 0.3, '前臂外旋贴上对手来拳的外侧，掌心向上把来拳托偏'],
      ['同手即打', 'strike', '前手', 'high', null, 1.0, '摊开的同一只手不收不回，直接翻转拳心打向对手面门（连消带打）'],
      ['后手补位', 'strike', '后手', 'mid', null, 0.6, '后手补一记短拳打胸口，防止对手回桥']
    ], ['wc_chain'], '摊打的关键是"消"和"打"用同一只手同一个节拍完成，不做两次动作。'),

    R('wc_pak', '拍打', 'Wing Chun pak-da', '咏春', [], [2, 9], [0.8, 1.6], 'high', [
      ['拍手', 'parry', '前手', 'arm', null, 0.25, '掌心向前下方一拍，把对手前手拍开一条缝'],
      ['后手直冲', 'strike', '后手', 'high', null, 1.0, '缝一出来后手立刻从缝里打入，走中线打面门'],
      ['前手回防', 'move', '前手', 'mid', null, 0.0, '打完后前手回到中线，保持一问一护']
    ], ['wc_chain', 'wc_wen'], '拍打是"开一条缝、往缝里打"，拍的那一下不能停太久。'),

    R('wc_bong', '膀手', 'Wing Chun bong sao', '咏春', [], [3, 9], [0.8, 1.6], 'mid', [
      ['膀手承力', 'parry', '前手', 'arm', null, 0.25, '前臂斜架、肘尖向下沉，用前臂外侧承接对手的重拳，把力卸到地面'],
      ['转腕变打', 'strike', '前手', 'mid', null, 0.9, '承接的同时手腕一转，拳从对手手臂内侧钻进去打胸口'],
      ['拉手切入', 'grab', '后手', 'arm', null, 0.4, '后手抓住对手手臂往下拉，身体跟着切进半步']
    ], ['wc_chain'], '膀手是卸力不是硬扛：肘尖朝下，力走地面，承接和反击在同一个节拍。'),

    R('wc_gan', '耕手', 'Wing Chun gan sao', '咏春', [], [3, 9], [0.8, 1.6], 'low', [
      ['耕手压桥', 'trap', '前手', 'arm', null, 0.3, '前臂由上往下斜切，把对手的下位桥手耕开'],
      ['低位冲拳', 'strike', '后手', 'mid', null, 0.9, '顺势后手冲拳打对手腹部，拳走中线不停'],
      ['转马跟上', 'move', '全身', 'mid', null, 0.0, '马步微转把身体重量压进拳里']
    ], ['wc_chain', 'wc_tan_da'], '耕手专治对手的下位桥手，耕开之后中门就开了。'),

    R('wc_chi', '黐手转马', 'Wing Chun chi sao pivot', '咏春', [], [4, 9], [0.6, 1.3], 'mid', [
      ['黐手听劲', 'probe', '双手', 'arm', null, 0.2, '两手前臂搭住对手桥手，随对方力量微微转动，听他要往哪走'],
      ['转马卸力', 'move', '全身', 'mid', null, 0.0, '对方力大就转马让开正面，力量顺着手臂滑走'],
      ['贴身短打', 'strike', '双手', 'mid', null, 0.9, '一贴身就双手交替短打，肘不离肋，拳不出肩'],
      ['抽手回中', 'move', '双手', 'mid', null, 0.0, '打完立刻抽手回到中线，恢复黐手']
    ], ['wc_chain', 'wc_tan_da'], '黐手练的是"听"：手不离开对手，力来就转，缝开就打。'),

    /* ══ 洪拳 ══ 桥手沉劲、硬打硬进 ══ */
    R('hung_fu', '虎爪双推', 'Hung Gar tiger claw push', '洪拳', [], [2, 9], [0.9, 1.8], 'mid', [
      ['沉桥压手', 'trap', '双手', 'arm', null, 0.3, '两手前臂同时下沉把对手的手臂压到一边，沉肩坠肘'],
      ['虎爪抓肩', 'grab', '双手', 'arm', null, 0.4, '五指张开如虎爪扣住对手肩窝与上臂，往前一带'],
      ['双推撞胸', 'strike', '双手', 'mid', null, 1.15, '借对手前倾之势双掌根齐推胸口，力从后脚蹬地灌到掌根'],
      ['拉马收势', 'move', '全身', 'mid', null, 0.0, '推完拉马沉身，双手收回腰间']
    ], ['hung_kui', 'hung_tie'], '洪拳讲究"桥来桥上过"：先用桥手沉住对手，再借他的力把他推出去。'),

    R('hung_kui', '工字伏虎·冲拳', 'Hung Gar gung ji fist', '洪拳', [], [2, 9], [0.9, 1.9], 'mid', [
      ['工字马开步', 'move', '全身', 'mid', null, 0.0, '两脚开成工字马，重心落两腿之间，腰马合一'],
      ['桥手横压', 'trap', '前手', 'arm', null, 0.3, '前臂横着压住对手来拳，肘沉肩松'],
      ['日字冲拳', 'strike', '后手', 'mid', null, 1.0, '后手从腰侧直线冲出，拳面朝前，力从腰马传到拳'],
      ['连环再冲', 'strike', '前手', 'mid', null, 0.85, '前手接上再冲一拳，两拳都走同一条中线'],
      ['收拳坐马', 'move', '全身', 'mid', null, 0.0, '双拳收回腰间，马步坐稳']
    ], ['hung_fu', 'hung_tie'], '洪拳的拳要"腰马合一"：拳不是手臂打的，是马步和腰推出去的。'),

    R('hung_tie', '铁线拳·逼桥', 'Hung Gar iron wire bridge', '洪拳', [], [4, 9], [0.8, 1.7], 'mid', [
      ['逼桥进身', 'trap', '前手', 'arm', null, 0.3, '前臂像铁线一样绷住往前逼，把对手的桥手压向他自己胸口'],
      ['肘底撞', 'strike', '肘', 'mid', null, 1.2, '逼到贴身就抬肘下砸，肘尖冲对手胸腹，短距离发力'],
      ['双桥震开', 'strike', '双手', 'arm', null, 0.7, '两臂同时向外一撑，把对手双手震开'],
      ['中门重击', 'finish', '后手', 'mid', null, 1.5, '门一开就一记重拳砸进中门收尾']
    ], ['hung_fu'], '铁线拳练的是桥手的硬度：先逼开对手的手，再打他的中门。'),

    /* ══ 长拳 / 少林 ══ 大开大合、腿法与腾空 ══ */
    R('cl_arch', '弓步冲拳', 'Bow stance straight punch', '长拳', [], [1, 9], [1.0, 2.2], 'mid', [
      ['并步抱拳', 'move', '全身', 'mid', null, 0.0, '两脚并拢、双拳抱腰，身体正直'],
      ['上步弓步', 'move', '前腿', 'mid', null, 0.0, '前脚向前一大步成弓步，后腿蹬直，重心前压'],
      ['拧腰冲拳', 'strike', '后手', 'mid', null, 1.05, '后手拳从腰间直线冲出，肩随腰转，拳面朝前'],
      ['格挡收拳', 'parry', '前手', 'arm', null, 0.2, '前手横架护住面部，双拳收回腰间']
    ], ['cl_horse', 'cl_fly'], '长拳的门面动作：步到、腰到、拳到，三样要同一个节拍。'),

    R('cl_horse', '马步架打', 'Horse stance block and strike', '长拳', [], [1, 9], [0.9, 1.9], 'mid', [
      ['马步下沉', 'move', '全身', 'mid', null, 0.0, '两脚开立屈膝坐胯，重心下沉如骑马'],
      ['上架护头', 'parry', '前手', 'high', null, 0.22, '前臂上架过头，护住头顶，肘尖朝前'],
      ['侧向冲拳', 'strike', '后手', 'mid', null, 1.0, '后手拳向侧前方冲出打对手肋部，肩沉肘直'],
      ['回架收势', 'move', '全身', 'mid', null, 0.0, '收回马步，双拳护胸']
    ], ['cl_arch'], '架打是一手护头一手打肋，马步不许浮。'),

    R('cl_fly', '腾空飞脚', 'Jumping front kick', '长拳', [], [3, 9], [1.2, 2.4], 'high', [
      ['助跑垫步', 'move', '全身', 'mid', null, 0.0, '两步助跑，最后一步单脚蹬地'],
      ['腾空提膝', 'move', '前腿', 'mid', null, 0.0, '蹬地起跳，摆动腿屈膝上提，另一腿在空中蓄力'],
      ['空中弹踢', 'kick', '前腿', 'high', null, 1.3, '脚背绷直向前弹出，踢对手面门或持械手，落地前完成'],
      ['落地缓冲', 'move', '全身', 'low', null, 0.0, '屈膝落地卸力，身体前压准备下一手']
    ], ['cl_arch', 'cl_wind'], '飞脚要在空中完成击打：起跳、弹腿、落地三拍清楚。'),

    R('cl_wind', '旋风脚', 'Tornado kick', '长拳', [], [5, 9], [1.1, 2.2], 'high', [
      ['转身蓄力', 'move', '全身', 'mid', null, 0.0, '身体向后转，两臂随转体摆动蓄力'],
      ['腾空旋踢', 'kick', '后腿', 'high', null, 1.35, '起跳同时转体三百六十度，里合腿横扫对手头侧'],
      ['落地坐马', 'move', '全身', 'low', null, 0.0, '落地成马步，防止被反击'],
      ['顺势推掌', 'strike', '双手', 'mid', null, 0.9, '落地即双掌前推，把对手推出圈']
    ], ['cl_fly'], '旋风脚是转体加里合腿，落地必须坐稳，否则自己先乱。'),

    /* ══ 形意五行拳 ══ 一步一拳、硬打硬进 ══ */
    R('xy_pi', '劈拳', 'Xingyi splitting fist', '形意', [], [2, 9], [0.9, 1.8], 'mid', [
      ['起钻', 'probe', '前手', 'high', null, 0.25, '前手拳心向上由下往上钻起，护住自己的鼻梁'],
      ['落翻劈下', 'strike', '前手', 'mid', null, 1.05, '拳到顶点翻腕向下劈，拳面砸对手胸口，后手同时收到腹前'],
      ['半步跟进', 'move', '前腿', 'mid', null, 0.0, '前脚向前半步，后脚跟上成三体式'],
      ['后手再劈', 'strike', '后手', 'mid', null, 0.9, '后手接上再劈一记，两拳交替']
    ], ['xy_beng', 'xy_zuan'], '形意劈拳是"起钻落翻"：上下一条线，砸的是对手的中线。'),

    R('xy_beng', '崩拳', 'Xingyi crushing fist', '形意', [], [2, 9], [0.9, 1.9], 'mid', [
      ['三体式蓄力', 'move', '全身', 'mid', null, 0.0, '前手前伸后手护腹，重心略后'],
      ['趟步崩出', 'move', '前腿', 'mid', null, 0.0, '前脚贴着地面前趟半步，后脚紧跟'],
      ['后手直崩', 'strike', '后手', 'mid', null, 1.1, '后手拳沿中线直崩对手心窝，拳眼向上，力从后脚蹬地而来'],
      ['连崩二拳', 'strike', '前手', 'mid', null, 0.95, '不停顿接第二记崩拳，走同一条线']
    ], ['xy_pi', 'xy_pao'], '崩拳像枪扎出去：拳要直、脚要趟、力要整。'),

    R('xy_zuan', '钻拳', 'Xingyi drilling fist', '形意', [], [3, 9], [0.8, 1.7], 'high', [
      ['裹手', 'trap', '后手', 'arm', null, 0.3, '后手由下向上裹住对手前臂，把他手抬起'],
      ['上钻打颏', 'strike', '后手', 'high', null, 1.0, '拳心向内由下往上钻打对手下巴，肘贴肋'],
      ['换手再钻', 'strike', '前手', 'high', null, 0.9, '前手跟着再钻一记，把对手头颈顶直']
    ], ['xy_pi'], '钻拳走的是向上的弧线，专治对手护头的手。'),

    R('xy_pao', '炮拳', 'Xingyi cannon fist', '形意', [], [4, 9], [1.0, 2.0], 'mid', [
      ['上架护头', 'parry', '前手', 'high', null, 0.22, '前手架上对手来拳，护住自己头面'],
      ['侧身炮打', 'strike', '后手', 'mid', null, 1.2, '身体一拧，后手拳像炮弹出膛打对手肋部'],
      ['跟步再打', 'strike', '前手', 'mid', null, 1.0, '跟半步前手再补一拳，两拳交替不休']
    ], ['xy_beng', 'xy_heng'], '炮拳是"架一手、打一手"，发力最猛，要在对手旧力已过新力未生时打。'),

    R('xy_heng', '横拳', 'Xingyi crossing fist', '形意', [], [3, 9], [0.9, 1.8], 'mid', [
      ['裹压', 'trap', '前手', 'arm', null, 0.3, '前手向下向外裹压对手的来手'],
      ['横打出肋', 'strike', '后手', 'mid', null, 1.05, '后手拳横向钻出打对手肋下，拳心向上，走一条横线'],
      ['回身坐马', 'move', '全身', 'mid', null, 0.0, '拳出即回，恢复三体式']
    ], ['xy_pi'], '横拳是五行里的"横"，打断对手的直线进攻用的。'),

    /* ══ 八卦掌 ══ 绕圈走转、掌法为主 ══ */
    R('bg_dan', '单换掌', 'Bagua single palm change', '八卦', [], [4, 9], [0.9, 1.8], 'mid', [
      ['走圈穿掌', 'move', '全身', 'mid', null, 0.0, '沿圈走转，前掌穿出、后掌护肘，眼睛看向圆心'],
      ['扣步转身', 'move', '后腿', 'mid', null, 0.0, '后脚扣步，身体随之转到对手侧后'],
      ['顺势推掌', 'strike', '前手', 'mid', null, 1.05, '转到位就用掌根推对手腰肋，力从脚底顺身而发'],
      ['回圈护中', 'move', '全身', 'mid', null, 0.0, '推完继续走圈，不让对手抓到自己正面']
    ], ['bg_zhuan', 'bg_chuan'], '八卦的核心是走：永远走到对手的侧后方，再出掌。'),

    R('bg_zhuan', '双撞掌', 'Bagua double palm', '八卦', [], [4, 9], [0.9, 1.9], 'mid', [
      ['穿掌引手', 'probe', '双手', 'mid', null, 0.2, '双掌一前一后穿出，把对手视线和手都引到上方'],
      ['沉身进步', 'move', '全身', 'mid', null, 0.0, '身形一沉，前脚插进对手两脚之间'],
      ['双掌齐撞', 'strike', '双手', 'mid', null, 1.25, '双掌根同时撞向对手胸腹，力从后脚蹬地经腰到掌'],
      ['撤步回圈', 'move', '全身', 'mid', null, 0.0, '撞完立刻撤步，回到圈上']
    ], ['bg_dan'], '双撞掌是整劲：两手不是分开推，是同一个身子撞出去。'),

    R('bg_chuan', '绕步穿掌', 'Bagua threading palm', '八卦', [], [3, 9], [1.0, 2.0], 'high', [
      ['引手', 'probe', '前手', 'high', null, 0.22, '前掌向对手面上虚探，引他抬手'],
      ['绕步换位', 'move', '全身', 'mid', null, 0.0, '脚下绕半步转到对手外侧，身体不转正面'],
      ['穿掌打喉', 'strike', '后手', 'high', null, 1.1, '后掌从对手抬起的手臂下穿进去，指尖戳向咽喉'],
      ['回身护面', 'parry', '前手', 'high', null, 0.2, '穿完前手回来护住自己面门']
    ], ['bg_dan'], '穿掌专走对手抬手后露出的空档，指尖先行。'),

    /* ══ 太极拳 ══ 借力、听劲、以柔化刚 ══ */
    R('tj_lu', '揽雀尾', 'Taichi grasp sparrow tail', '太极', [], [3, 9], [0.8, 1.7], 'mid', [
      ['掤手上架', 'parry', '前手', 'high', null, 0.28, '前臂圆撑上掤，像抱住一个球，把对手的力接住'],
      ['捋手侧引', 'trap', '双手', 'arm', null, 0.35, '两手顺着对手来力向自己侧后引，身体随之转腰'],
      ['挤手贴身', 'strike', '前手', 'mid', null, 1.0, '借对手重心前倾，前臂横挤他的胸口'],
      ['按掌下压', 'strike', '双手', 'mid', null, 1.1, '双掌下按对手胯根，把他按坐下去']
    ], ['tj_yun', 'tj_ye'], '揽雀尾四手（掤捋挤按）是一口气：接住、引开、挤上、按下。'),

    R('tj_yun', '云手', 'Taichi cloud hands', '太极', [], [2, 9], [0.8, 1.6], 'mid', [
      ['左手外云', 'trap', '前手', 'arm', null, 0.3, '左手由内向外划圆，把对手来手带偏'],
      ['右手内云', 'trap', '后手', 'arm', null, 0.3, '右手接着由外向内划圆，两手交替不停'],
      ['侧步横移', 'move', '全身', 'mid', null, 0.0, '脚下同时横移一步，保持正面朝对手'],
      ['顺势按出', 'strike', '双手', 'mid', null, 0.95, '对手重心一歪，双掌顺势推出']
    ], ['tj_lu'], '云手是"化"字诀：手在划圆，力被带走，脚下不停。'),

    R('tj_ye', '野马分鬃', 'Taichi parting wild horse mane', '太极', [], [2, 9], [0.9, 1.8], 'mid', [
      ['抱球蓄势', 'move', '双手', 'mid', null, 0.0, '两手在胸前如抱球，重心落于后腿'],
      ['上步分手', 'move', '前腿', 'mid', null, 0.0, '前脚上步，两手一上一下分开'],
      ['分掌靠打', 'strike', '前手', 'mid', null, 1.05, '前掌向对手腋下分打，同时肩胯靠上去'],
      ['回身收势', 'move', '全身', 'mid', null, 0.0, '回身收掌，重心归中']
    ], ['tj_lu', 'tj_yun'], '分鬃打的是对手的腋下和重心，掌到、身到。'),

    /* ══ 八极拳 ══ 贴身短打、震脚发力 ══ */
    R('bj_cheng', '撑捶', 'Baji supporting fist', '八极', [], [4, 9], [0.8, 1.7], 'mid', [
      ['震脚开门', 'move', '全身', 'mid', null, 0.0, '一脚震地，沉肩坠肘把气势压过去'],
      ['撑捶直入', 'strike', '前手', 'mid', null, 1.15, '前手拳沿中线撑出，肘微屈、拳面朝前，力从脚跟贯到拳'],
      ['后手顶肘', 'strike', '肘', 'mid', null, 1.2, '前拳一收，后手肘尖顶对手胸口'],
      ['沉马收势', 'move', '全身', 'mid', null, 0.0, '两脚沉马，拳肘收回']
    ], ['bj_kao', 'bj_ding'], '八极讲"撑捶如枪"：一拳一肘都往中线上砸。'),

    R('bj_ding', '顶肘', 'Baji elbow strike', '八极', [], [4, 9], [0.5, 1.2], 'mid', [
      ['拉手开门', 'grab', '前手', 'arm', null, 0.4, '前手抓住对手前臂往自己方向拉，让他门户打开'],
      ['进步顶肘', 'strike', '肘', 'mid', null, 1.3, '后脚一蹬贴进去，肘尖冲对手胸口或太阳穴'],
      ['反手横打', 'strike', '后手', 'high', null, 1.0, '肘收拳出，反手横打对手头侧']
    ], ['bj_cheng', 'bj_kao'], '顶肘要在贴身距离用：先拉开门，再一肘进去。'),

    R('bj_kao', '贴山靠', 'Baji mountain lean', '八极', [], [5, 9], [0.5, 1.3], 'mid', [
      ['采手进步', 'grab', '前手', 'arm', null, 0.4, '前手采住对手手臂上抬，脚下抢进他的中门'],
      ['肩靠撞胸', 'throw', '肩', 'mid', null, 1.5, '肩膀像山一样撞进对手胸口，力从后脚蹬地经腰到肩'],
      ['绊腿放倒', 'throw', '前腿', 'leg', null, 1.4, '靠的同时前腿别住他的腿，整个人压上去把他放倒'],
      ['压肘锁住', 'grab', '双手', 'arm', null, 0.5, '倒地后压住他肘关节，限制他起身']
    ], ['bj_cheng'], '贴山靠是八极的看家：全身重量一次性撞进去，撞完就着地。'),

    /* ══ 通背 / 螳螂 / 醉拳 ══ */
    R('tb_shuai', '摔拍穿劈', 'Tongbei swing-slap-pierce', '通背', [], [3, 9], [1.1, 2.3], 'high', [
      ['摔臂引手', 'probe', '前手', 'high', null, 0.22, '前臂像鞭子一样自上而下摔出，引对手抬手'],
      ['拍掌压桥', 'parry', '前手', 'arm', null, 0.22, '掌根拍压对手抬起的桥手'],
      ['穿掌打面', 'strike', '后手', 'high', null, 1.0, '后掌从拍开的缝里穿出，指尖打向对方面门'],
      ['劈掌收尾', 'finish', '前手', 'mid', null, 1.5, '回手一记立掌劈向对手胸口，臂如刀']
    ], ['tb_bai'], '通背的劲像鞭子：放长击远，节节贯通。'),

    R('tb_bai', '白猿探背', 'Tongbei ape reach', '通背', [], [4, 9], [1.0, 2.1], 'mid', [
      ['缩身藏手', 'move', '全身', 'mid', null, 0.0, '身体一缩，手收回胸前，让对手判断不出距离'],
      ['探背伸打', 'strike', '后手', 'mid', null, 1.1, '后手借转身探背之力直线打出，臂完全展开'],
      ['回手撩阴', 'strike', '前手', 'low', null, 0.95, '前手由下往上撩打对手下腹']
    ], ['tb_shuai'], '探背是"缩着打远的"：先藏手，再靠背脊的力量把手送出去。'),

    R('tl_beng', '螳螂崩步', 'Mantis crashing step', '螳螂', [], [3, 9], [0.9, 1.8], 'mid', [
      ['螳螂勾手', 'probe', '双手', 'arm', null, 0.22, '两手勾成螳螂爪，前手探出、后手护胸'],
      ['勾搂采手', 'grab', '前手', 'arm', null, 0.4, '前爪勾住对手手腕往里搂，把他手臂带走'],
      ['崩步冲捶', 'strike', '后手', 'mid', null, 1.1, '脚下的崩步一蹬，后手拳直冲对手心窝'],
      ['连环勾打', 'strike', '前手', 'high', null, 0.95, '前爪变成拳继续勾打对手太阳穴']
    ], ['tl_gou'], '螳螂拳是"勾、搂、采、挂"：先用手把对手的手带走，再打空档。'),

    R('tl_gou', '勾搂采挂', 'Mantis hook-grapple', '螳螂', [], [4, 9], [0.8, 1.7], 'mid', [
      ['勾手引', 'probe', '前手', 'mid', null, 0.22, '前手勾着探出，试探对手的防线'],
      ['搂手带偏', 'trap', '前手', 'arm', null, 0.35, '手掌一翻把对手前臂搂向自己身侧'],
      ['采手压肘', 'grab', '后手', 'arm', null, 0.4, '后手采住他的肘往下压，破他重心'],
      ['挂腿摔', 'throw', '前腿', 'leg', null, 1.5, '前腿挂住他的支撑腿，借他前倾把他撂倒']
    ], ['tl_beng'], '勾搂采挂是一条链：手把他手带走，腿把他腿带走，人就倒了。'),

    R('zj_bu', '醉步跌扑', 'Drunken stumble fall', '醉拳', [], [3, 9], [0.8, 1.9], 'mid', [
      ['醉步晃身', 'move', '全身', 'mid', null, 0.0, '脚下踉跄画圈，上身东倒西歪，让对手抓不住重心'],
      ['假装失足', 'probe', '全身', 'low', null, 0.2, '身体向一侧倒去，像要摔倒，引对手上前'],
      ['就地扑打', 'strike', '双手', 'mid', null, 1.15, '倒地瞬间双手撑地弹起，拳掌齐出打对手膝与腹'],
      ['翻身再起', 'move', '全身', 'mid', null, 0.0, '一个翻身站起来，回到醉步']
    ], ['zj_da'], '醉拳的"醉"是假的：倒下去的方向就是打人的方向。'),

    R('zj_da', '醉打', 'Drunken strike', '醉拳', [], [4, 9], [0.8, 1.8], 'high', [
      ['仰身让招', 'move', '全身', 'mid', null, 0.0, '上身后仰让过来拳，脚下不退'],
      ['翻身砸拳', 'strike', '后手', 'high', null, 1.15, '借着后仰的反弹翻身，后手拳自上而下砸对手头面'],
      ['旋身肘击', 'strike', '肘', 'mid', null, 1.2, '身体继续旋转，肘尖横着扫对手肋部'],
      ['醉步拉开', 'move', '全身', 'mid', null, 0.0, '踉跄两步拉开距离，恢复醉态']
    ], ['zj_bu'], '醉打靠身体的旋转发力：仰、翻、旋，每一下都用上腰。'),

    /* ══ 现代搏击：散打 / 拳击 / 摔拿 ══ */
    R('sd_combo', '散打三连', 'Sanda three-punch combo', '散打', [], [1, 9], [0.9, 1.9], 'high', [
      ['前手刺拳', 'probe', '前手', 'high', null, 0.25, '前手直拳快速探出打对手面门，只为量距离和遮挡视线'],
      ['后手直拳', 'strike', '后手', 'high', null, 1.05, '后脚蹬地转胯，后手直拳重击，肩送出去'],
      ['前手勾拳', 'strike', '前手', 'mid', null, 1.0, '前手由下往上勾打对手下颌或肋部，肘角约九十度'],
      ['侧闪退出', 'move', '全身', 'mid', null, 0.0, '打完侧闪一步退出对手反击范围']
    ], ['sd_lowkick', 'sd_takedown'], '散打三连是"一轻两重"：刺拳量距离，后直和勾拳才是要分的。'),

    R('sd_lowkick', '低扫接直拳', 'Low kick into cross', '散打', [], [2, 9], [1.0, 2.1], 'leg', [
      ['前手虚晃', 'probe', '前手', 'high', null, 0.22, '前手在对手面前一晃，掩护下面的腿'],
      ['后低扫腿', 'kick', '后腿', 'leg', null, 1.2, '后腿鞭打对手前腿外侧或膝窝，脚背绷直，转胯带腿'],
      ['落步直拳', 'strike', '后手', 'high', null, 1.0, '踢完的腿一落地，后手直拳立刻跟上打面门'],
      ['贴身抱腿', 'grab', '双手', 'leg', null, 0.45, '若对手抬腿防，顺势抱他支撑腿']
    ], ['sd_combo', 'sd_takedown'], '低扫之后对手重心必乱，直拳要在他还站不稳的时候到。'),

    R('sd_takedown', '抱腿摔', 'Double-leg takedown', '摔拿', [], [2, 9], [0.7, 1.6], 'leg', [
      ['压头下潜', 'move', '全身', 'mid', null, 0.0, '一手压住对手后颈，身体下潜避开他的拳'],
      ['抱腿冲击', 'grab', '双手', 'leg', null, 0.45, '双手抱住对手两条大腿，肩膀顶住他胯部'],
      ['起身掀翻', 'throw', '全身', 'mid', null, 1.5, '后腿蹬地起身，肩膀往上一掀把他掀倒'],
      ['压住控位', 'grab', '全身', 'mid', null, 0.5, '倒地后压住他上身，不给他起身空间']
    ], ['sd_combo'], '抱腿摔的要点是"头贴住、肩顶住、腿蹬直"，三点同时发力。'),

    R('bx_one', '拳击一二连击', 'Boxing one-two', '拳击', [], [1, 9], [0.9, 1.8], 'high', [
      ['前手刺拳', 'probe', '前手', 'high', null, 0.22, '前手快速直拳探出，脚尖一碾把身体往前送半寸'],
      ['后手直拳', 'strike', '后手', 'high', null, 1.05, '后脚掌一拧转胯，后手直拳沿直线打对手下巴'],
      ['滑步侧移', 'move', '全身', 'mid', null, 0.0, '打完前脚先动，滑步侧移离开对手中线'],
      ['前手再刺', 'probe', '前手', 'high', null, 0.25, '移动中再出一记刺拳，压住对手不让他进']
    ], ['bx_hook'], '拳击一切从刺拳开始：量距离、遮挡视线、给后手开门。'),

    R('bx_hook', '前手勾拳接摆拳', 'Boxing hook and overhand', '拳击', [], [3, 9], [0.6, 1.4], 'high', [
      ['侧闪入位', 'move', '全身', 'mid', null, 0.0, '头部向对手外侧一闪，同时上步进入勾拳距离'],
      ['前手勾拳', 'strike', '前手', 'high', null, 1.1, '肘抬到与肩平，前手勾拳打对手下颌侧面，靠转脚发力'],
      ['后手摆拳', 'finish', '后手', 'high', null, 1.45, '重心一转，后手摆拳从外侧抡进，打他另一侧下颌'],
      ['防守回收', 'parry', '双手', 'high', null, 0.2, '两手立刻收回护住下颌，肘贴身']
    ], ['bx_one'], '勾拳打的是对手看不见的那一侧，所以侧闪入位比拳本身更重要。'),

    /* ══ 兵器套路（刀/剑/棍/枪/双持/鞭） ══ */
    R('wp_dao', '刀法三式', 'Saber three moves', '刀法', ['dao'], [1, 9], [1.2, 2.3], 'mid', [
      ['缠头护顶', 'parry', '双手', 'high', null, 0.25, '刀在头顶绕一圈缠头，护住自己头面并把对手兵器拨开'],
      ['斜劈落刀', 'strike', '双手', 'mid', null, 1.15, '刀走斜线自上而下劈，刀背贴身、刀尖朝对手肩颈'],
      ['撩刀上挑', 'strike', '双手', 'low', null, 1.0, '刀不到底就往上撩，刀锋贴着对手兵器刮上去'],
      ['裹脑收刀', 'move', '双手', 'mid', null, 0.0, '刀绕背裹脑回到起手，准备下一轮']
    ], ['wp_dao_liao', 'wp_gun'], '刀法讲"劈、撩、缠头裹脑"：劈完必撩，撩完必护头。'),

    R('wp_dao_liao', '撩刀接挂刀', 'Saber upward flick and parry', '刀法', ['dao'], [3, 9], [1.1, 2.2], 'low', [
      ['沉刀蓄力', 'move', '双手', 'mid', null, 0.0, '刀尖下沉到膝盖高度，身体微蹲'],
      ['撩刀破下盘', 'strike', '双手', 'low', null, 1.1, '刀由下往上撩对手手腕或小臂，力从腰腿往上'],
      ['挂刀卸力', 'parry', '双手', 'arm', null, 0.22, '对手兵器压下来时不硬顶，刀身斜挂把力引到身侧'],
      ['顺势推刀', 'strike', '双手', 'mid', null, 0.95, '挂开的空档里刀尖直推对手胸口']
    ], ['wp_dao'], '撩刀打的是手，挂刀是卸力：一撩一挂，对手的兵器就空了。'),

    R('wp_jian', '剑法三击', 'Sword three strikes', '剑法', ['jian'], [1, 9], [1.3, 2.4], 'mid', [
      ['点剑探路', 'probe', '前手', 'high', null, 0.22, '剑尖向前一点，手腕下压，试探对手的防守位置'],
      ['抹剑横削', 'strike', '前手', 'mid', null, 1.0, '剑身横着抹过对手手腕或肋侧，靠转腰带剑'],
      ['刺剑入喉', 'finish', '前手', 'high', null, 1.5, '剑尖沿中线直刺咽喉，臂送出、脚跟进'],
      ['抽剑回护', 'move', '前手', 'mid', null, 0.0, '刺完立刻抽剑回到中线，剑尖对着对手']
    ], ['wp_jian_tiao', 'wp_gun'], '剑是"轻灵之器"：点、抹、刺，剑尖永远指着对手。'),

    R('wp_jian_tiao', '挑剑接劈剑', 'Sword rising and cleave', '剑法', ['jian'], [2, 9], [1.2, 2.3], 'mid', [
      ['挑剑破腕', 'strike', '前手', 'low', null, 0.95, '剑由下往上挑对手持械手腕，力短而脆'],
      ['turn 腕翻剑', 'move', '前手', 'mid', null, 0.0, '手腕一翻把剑身立起来'],
      ['立剑下劈', 'strike', '前手', 'mid', null, 1.15, '剑沿对手头肩斜着劈下，剑身立着走'],
      ['退步守中', 'move', '全身', 'mid', null, 0.0, '退半步收剑，剑尖不离对手中线']
    ], ['wp_jian'], '挑腕是为了让对手握不住兵器，劈是收尾的那一下。'),

    R('wp_gun', '棍法三打', 'Staff three strikes', '棍法', ['gun'], [1, 9], [1.4, 2.8], 'mid', [
      ['劈棍压顶', 'strike', '双手', 'high', null, 1.1, '棍自头顶劈下打对手肩臂，前手滑把、后手压棍'],
      ['扫棍横扫', 'strike', '双手', 'mid', null, 1.15, '棍身横着扫对手腰肋，靠转腰带棍，棍走平圆'],
      ['戳棍直进', 'strike', '双手', 'mid', null, 1.05, '棍尖沿中线直戳对手胸口，后手送棍、前手控方向'],
      ['收棍护身', 'move', '双手', 'mid', null, 0.0, '棍收回斜架在身前，护住中线']
    ], ['wp_gun_sao', 'wp_dao'], '棍是"百兵之祖"：劈扫戳三下节奏要分明，棍走直线和圆线。'),

    R('wp_gun_sao', '扫棍接撩棍', 'Staff sweep and lift', '棍法', ['gun'], [3, 9], [1.3, 2.6], 'low', [
      ['下扫破腿', 'strike', '双手', 'leg', null, 1.2, '棍梢贴着地面横扫对手小腿，身体下蹲跟着走'],
      ['撩棍上打', 'strike', '双手', 'high', null, 1.1, '借下扫的回劲把棍从下往上撩，打对手下颌或持械手'],
      ['盖棍压制', 'strike', '双手', 'high', null, 1.15, '棍自上而下盖住对手兵器，压住不让他抬起来'],
      ['崩棍震开', 'parry', '双手', 'arm', null, 0.25, '手腕一抖把对手兵器崩开，趁隙退步']
    ], ['wp_gun'], '先扫下盘让他跳，再撩上盘打他落地那一瞬间。'),

    R('wp_qiang', '枪法拦拿扎', 'Spear block-grapple-thrust', '枪法', ['qiang'], [2, 9], [1.6, 3.2], 'mid', [
      ['拦枪', 'parry', '双手', 'arm', null, 0.22, '枪杆横着往上一拦，把对手兵器挡在外侧'],
      ['拿枪', 'trap', '双手', 'arm', null, 0.25, '枪杆往下一压一转，圈住对手兵器让他脱不开'],
      ['扎枪', 'finish', '双手', 'mid', null, 1.5, '后手送、前手定，枪尖沿中线直扎对手胸口，力从后脚蹬出'],
      ['抽枪再扎', 'strike', '双手', 'mid', null, 1.2, '一抽一送连扎第二枪，枪不离中线']
    ], ['wp_gun'], '枪的核心就三个字：拦、拿、扎。扎出去要"枪如游龙"。'),

    R('wp_shuang', '双持交叉斩', 'Dual wield cross slash', '双持', ['shuang'], [4, 9], [1.0, 2.0], 'mid', [
      ['左手虚引', 'probe', '前手', 'high', null, 0.22, '左手兵器在前虚晃，引对手注意力偏一侧'],
      ['右手斜劈', 'strike', '后手', 'mid', null, 1.1, '右手兵器自外侧斜劈对手肩颈，身体跟着转'],
      ['左手回斩', 'strike', '前手', 'mid', null, 1.05, '左手兵器从反方向回斩对手腰侧，形成交叉'],
      ['双兵护身', 'parry', '双手', 'mid', null, 0.2, '两件兵器交叉挡在身前，护住中线']
    ], ['wp_dao', 'wp_jian'], '双持打的是"交替"：一件引、一件打，中间不留空隙。'),

    R('wp_bian', '软鞭缠打', 'Whip entangle and strike', '软兵器', ['bian'], [5, 9], [1.8, 3.4], 'mid', [
      ['抖鞭蓄势', 'move', '前手', 'mid', null, 0.0, '手腕一抖把鞭身甩成一条直线，鞭梢先出'],
      ['缠鞭锁腕', 'trap', '前手', 'arm', null, 0.35, '鞭梢绕上对手手腕或兵器，一圈缠住往回拉'],
      ['抽鞭打面', 'strike', '前手', 'high', null, 1.1, '缠住的鞭一抽即松，鞭梢反手抽向对方面门'],
      ['收鞭回腰', 'move', '前手', 'mid', null, 0.0, '鞭身收回腰间盘好，防止被踩']
    ], ['wp_qiang'], '软兵器靠手腕：缠是为了控，抽是为了打，收鞭比出鞭更重要。')
  ];

  /* ── 索引与查询 ───────────────────────────────────────────────────────── */
  const C=typeof module==='object'&&module.exports?require('./skill-catalog'):globalThis.H3_SKILL_CATALOG;
  if(C)C.forms.forEach(f=>{if(SEED.some(r=>r.zh===f.zh))return;SEED.push(Object.assign({},f,{chain:(C.repertoire(f.family)?.forms||[]).filter(k=>k!==f.key).slice(0,3),steps:f.steps.map((st,i)=>Object.assign({i:i+1,actZh:(ACT[st.act]||ACT.strike).zh},st))}));});
  function schedule(r,rate=1){let at=0;const k=Math.max(.7,Math.min(1.7,rate));return (r?.steps||[]).map(st=>{const t=st.t.map(x=>Math.max(.05,x/k)),out={step:st,start:at,activeStart:at+t[0],activeEnd:at+t[0]+t[1],end:at+t[0]+t[1]+t[2]};at=out.end;return out;});}
  const byKey = new Map();
  SEED.forEach((r) => byKey.set(r.key, r));

  const stepCount = (r) => (r && r.steps ? r.steps.length : 0);
  const totalSec = (r) => (r && r.steps ? r.steps.reduce((a, s) => a + (s.t ? s.t.reduce((x, y) => x + y, 0) : 0), 0) : 0);

  /** 按风格取套路（引擎/素材/面板都用它） */
  function forStyle(style, weapon, tier) {
    const st = String(style || '');
    const wp = weapon && weapon !== 'none' ? weapon : null;
    return SEED.filter((r) => {
      if (st && r.style !== st) return false;
      if (wp && r.weapons.length && r.weapons.indexOf(wp) < 0) return false;
      if (!wp && r.weapons.length) return false;
      if (tier != null && (tier < r.tiers[0] || tier > r.tiers[1])) return false;
      return true;
    });
  }

  /** 按兵器取套路 */
  function forWeapon(weapon) {
    const wp = weapon && weapon !== 'none' ? weapon : null;
    return SEED.filter((r) => (wp ? r.weapons.indexOf(wp) >= 0 : r.weapons.length === 0));
  }

  /* 引擎招式种类 → 候选套路（横斩/斜劈/突刺/撩挑/扫堂/重击/膝撞/回旋踢/终结/空袭…）
     没有名字线索时按这个表挑，保证"每一招都落进一整套合适的套路里"，而不是全落进同一个。 */
  const VARIANT_MAP = {
    slash: ['wp_dao', 'cl_arch', 'xy_heng'],
    // —— 以下键与 sim3d/engine.js 的 VARIANTS 一一对应（招式种类 → 最贴的套路）——
    leap_slash: ['cl_fly', 'wp_dao'],
    wall_flip: ['cl_wind'],
    air_combo: ['cl_wind', 'bx_one'],
    dive: ['cl_fly', 'wp_dao'],
    kick_round: ['cl_wind', 'sd_lowkick'],
    kick_side: ['cl_fly', 'sd_lowkick'],
    kick_heel: ['cl_wind', 'cl_fly'],
    fly_kick: ['cl_fly', 'sd_lowkick'],
    air_round: ['cl_wind', 'cl_fly'],
    air_axe: ['cl_fly', 'xy_pi'],
    diag: ['wp_dao', 'xy_pi', 'cl_arch'],
    thrust: ['wc_chain', 'wp_jian', 'wp_qiang'],
    rise: ['tb_shuai', 'wp_dao_liao', 'cl_arch'],
    sweep: ['cl_wind', 'sd_lowkick'],
    heavy: ['bj_cheng', 'xy_pao', 'hung_fu'],
    knee: ['bj_ding'],
    roundhouse: ['cl_fly', 'sd_lowkick', 'cl_wind'],
    kick: ['sd_lowkick', 'cl_fly'],
    finish: ['bj_kao', 'xy_beng', 'hung_tie'],
    air_combo: ['cl_wind', 'cl_fly'],
    dive: ['cl_fly'],
    elbow: ['bj_ding'],
    throw: ['bj_kao', 'sd_takedown', 'tl_gou']
  };

  /** 按"引擎招式种类 + 兵器"挑一条套路；pick 用来轮换（同 seed 可复现） */
  function forVariant(key, weapon, pick) {
    const wp = weapon && weapon !== 'none' ? weapon : null;
    const pool = [];
    (VARIANT_MAP[key] || []).forEach((k) => {
      const r = byKey.get(k);
      if (r && (!wp || !r.weapons.length || r.weapons.indexOf(wp) >= 0)) pool.push(r);
    });
    //   映射表命中时**只在该类的候选里挑**（膝撞就落进八极顶肘，而不是随机掉进任意空手套路）；
    //   映射表为空时才退回按兵器取全部套路。
    if (!pool.length) forWeapon(wp).forEach((r) => { if (pool.indexOf(r) < 0) pool.push(r); });
    if (!pool.length) SEED.forEach((r) => { if (!r.weapons.length) pool.push(r); });
    if (!pool.length) pool.push(SEED[0]);
    const i = pick == null ? 0 : Math.abs(Math.floor(pick)) % pool.length;
    return pool[i];
  }

  /** 粗糙匹配：把手里的招式名对上套路名（角色卡里的"斜劈破势"这类也能对上相近套路） */
  function matchByName(name) {
    const n = String(name || '');
    if (!n) return null;
    let hit = SEED.find((r) => r.zh === n || r.en === n);
    if (hit) return hit;
    hit = SEED.find((r) => n.indexOf(r.zh) >= 0 || r.zh.indexOf(n) >= 0);
    if (hit) return hit;
    if(C?.repertoire(n)){const f=C.select(n);if(f)return byKey.get(f.key)||null;}
    const kw = [['冲拳', 'wc_chain'], ['日字', 'wc_chain'], ['问手', 'wc_wen'], ['摊', 'wc_tan_da'], ['拍', 'wc_pak'],
      ['掌', 'bg_dan'], ['拳', 'hung_kui'], ['桥', 'hung_tie'], ['棒', 'wp_gun'], ['棍', 'wp_gun'],
      ['枪', 'wp_qiang'], ['刀', 'wp_dao'], ['剑', 'wp_jian'], ['鞭', 'wp_bian'], ['腿', 'cl_fly'], ['脚', 'cl_fly'],
      ['摔', 'bj_kao'], ['靠', 'bj_kao'], ['拿', 'tl_gou'], ['抓', 'tl_gou'], ['连击', 'wc_chain'], ['连拳', 'wc_chain'],
      ['膀', 'wc_bong'], ['耕', 'wc_gan'], ['黐', 'wc_chi'], ['虎', 'hung_fu'], ['桥', 'hung_tie'],
      ['弓步', 'cl_arch'], ['马步', 'cl_horse'], ['飞脚', 'cl_fly'], ['旋风', 'cl_wind'],
      ['劈拳', 'xy_pi'], ['崩拳', 'xy_beng'], ['钻拳', 'xy_zuan'], ['炮拳', 'xy_pao'], ['横拳', 'xy_heng'],
      ['掌', 'bg_dan'], ['揽雀', 'tj_lu'], ['云手', 'tj_yun'], ['分鬃', 'tj_ye'],
      ['撑捶', 'bj_cheng'], ['顶肘', 'bj_ding'], ['靠', 'bj_kao'], ['勾', 'tl_gou'], ['螳螂', 'tl_beng'],
      ['醉', 'zj_bu'], ['刺拳', 'bx_one'], ['勾拳', 'bx_hook'], ['低扫', 'sd_lowkick'], ['抱腿', 'sd_takedown'],
      ['刀', 'wp_dao'], ['剑', 'wp_jian'], ['棍', 'wp_gun'], ['枪', 'wp_qiang'], ['鞭', 'wp_bian'], ['双', 'wp_shuang']];
    for (const [k, key] of kw) if (n.indexOf(k) >= 0) return byKey.get(key) || null;
    return null;
  }

  /** 把套路渲染成"逐动作"的中文描述（素材/提示词/面板直接可用） */
  function describe(r, opts) {
    if (!r) return '';
    const o = opts || {};
    const head = (r.style ? (r.style + '·') : '') + r.zh;
    const parts = r.steps.map((s) => {
      const tt = s.t ? ('（' + s.t[0].toFixed(2) + '/' + s.t[1].toFixed(2) + '/' + s.t[2].toFixed(2) + ' 秒') : '';
      const seg = '【' + s.i + '】' + s.zh + '：' + (s.note || '') + '〔' + s.actZh + '·' + s.limb + '·打到' +
        ({ high: '上段', mid: '中段', low: '下段', leg: '腿', arm: '手臂' }[s.target] || s.target) + tt + '〕';
      return seg;
    });
    const tail = (r.chain && r.chain.length) ? (' 可接：' + r.chain.map((k) => (byKey.get(k) || {}).zh).filter(Boolean).join('、')) : '';
    const note = (o.withNote !== false && r.note) ? ('｜要点：' + r.note) : '';
    return head + '＝' + parts.join(' → ') + tail + note;
  }

  /** 一句话摘要（列表/选择器用） */
  function brief(r) {
    if (!r) return '';
    return (r.style ? (r.style + '·') : '') + r.zh + '（' + r.steps.map((s) => s.zh).join('→') + '）';
  }

  const stats = () => ({
    routines: SEED.length,
    styles: Array.from(new Set(SEED.map((r) => r.style))),
    steps: SEED.reduce((a, r) => a + r.steps.length, 0),
    avgSteps: +(SEED.reduce((a, r) => a + r.steps.length, 0) / SEED.length).toFixed(2),
    weapons: Array.from(new Set([].concat.apply([], SEED.map((r) => r.weapons))))
  });

  return { VERSION, ACT, SEED, byKey, forStyle, forWeapon, forVariant, VARIANT_MAP, matchByName, describe, brief, stats, stepCount, totalSec, schedule, catalog:C };
});
