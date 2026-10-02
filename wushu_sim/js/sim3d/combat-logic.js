/* ============================================================================
 * sim3d/combat-logic.js — 核心打斗逻辑（Node 可测）
 * ----------------------------------------------------------------------------
 * 解决的问题（有基线数据支撑）：
 *   · 内核本身打得很密（事件级动作 3.46 次/秒、真 idle 仅占 3%、攻击帧 989/1555），
 *     但**证据与模板把「动作之间的东西」丢掉了**：分镜文本 0/20 行有间隙动作描述，
 *     模板骨架 32/161 条出现「停／僵持／对峙」却不写原因。
 *   · 于是视频模型只能把空档脑补成「站着发呆」。
 * 本模块提供：核心规则 → 打斗反馈五要素 → 间隙动作库 → 连段与反击窗口 →
 *   间隙填充器（把稀疏节拍展开成连续微动作）→ 提示词块生成 → 双向判定器。
 * 出处：结构思路与武打模板库同源（irenerachel/fight-prompt-director，MIT）；
 *   间隙动作库、五要素、判定规则为本项目本地编写。
 * 注意：本文件中文文本一律使用「」，不出现 ASCII 双引号（避免转义踩坑）。
 * ========================================================================== */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.FIGHT_LOGIC = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  const VERSION = "fight-logic-0.2";

  // ── 一、动作四段（帧数据）────────────────────────────────────────────
  const PHASES = [
    { key: "windup", zh: "起手", note: "蓄力、换架、抬臂，≤0.3 秒（极速版 ≤0.15）" },
    { key: "active", zh: "有效", note: "兵器或拳脚真正走完轨迹，命中判定只在这一段" },
    { key: "recovery", zh: "收招", note: "收势回位，≤0.7 秒（极速版 ≤0.3）；收招可被连接或取消" },
    { key: "chain", zh: "连接", note: "收招后半段接下一招（连段窗口），或转为格挡与闪避" }
  ];

  // ── 二、打斗反馈五要素：每次接触都要写全 ────────────────────────────
  const FEEDBACK = [
    { key: "cause", zh: "前因", q: "这一下为什么会来（上一下的结果、被逼位、被格挡后露出的空档）" },
    { key: "act", zh: "动作", q: "谁、用什么招、走什么轨迹、从哪个高度出手" },
    { key: "contact", zh: "接触", q: "接触点在哪（兵器哪一段、身体哪一部位），是命中、格挡、擦过还是落空" },
    { key: "force", zh: "受力", q: "力往哪个方向、位移多少、重心怎么变、有没有闷响或火星" },
    { key: "after", zh: "余波与下一步", q: "谁失去或夺回主动权、环境发生什么、下一拍因此从哪里开始" }
  ];

  // ── 三、间隙动作库（治「发呆」的关键：把空档填满）────────────────────
  const FILLERS = {
    close: [
      "收肘顶住对方小臂，脚下碾半步保持粘住",
      "用肩胛顶开对方持械手，同时后脚跟抬起换重心",
      "头略微后让避开擦过的刃线，手仍扣在对方腕上",
      "被压住的瞬间沉腰降低重心，把对方的力卸进地面",
      "贴着对方旋半步，把两人轴线从正面改成侧向",
      "以小臂敲开对方手腕一次，重新夺回内侧位置",
      "呼吸顶在鼻腔里，脚下不停，脚尖反复调整三点支撑",
      "用兵器中段压住对方兵器中段，谁都不动但都在加力"
    ],
    mid: [
      "垫步两次逼近，每次把距离缩短半个身位",
      "绕半步改角度，刃线始终指着对方肩线",
      "抬手做一次短促的试探刺，逼对方先动",
      "换架（前后脚互换），把发力腿调到后面",
      "拖半步撤出射程，同时把兵器收到腰侧蓄势",
      "空手侧抬起护住面门，持械侧沉在腰线以下",
      "斜上一步切断对方的绕行路线，两人重新面对面",
      "呼吸一沉一浮，肩膀放松半寸再收紧"
    ],
    far: [
      "压着步子连续逼近，兵器前指不给对手起势时间",
      "横向绕行寻找掩体，视线不离开对方腰胯",
      "侧身小碎步调整站位，把太阳移到对方眼里",
      "把兵器举到肩上缩短出手路径，脚下不减速",
      "突然收步做一次假起手，看对方先反应",
      "沿掩体边缘折线靠近，每次拐角都改变攻击角度",
      "低身快步入射程，落地时起手已经完成"
    ]
  };
  const FILLERS_EN = {
    close: [
      "tucks the elbow against the opponent's forearm and grinds half a step to stay glued",
      "shrugs the shoulder to push the weapon hand off line while shifting weight off the rear heel",
      "lets the head slip back off the passing edge with the hand still on the wrist",
      "sinks the hips to dump the opponent's force into the floor",
      "pivots half a step along the opponent to turn the axis from square to side-on",
      "knocks once at the wrist with the forearm to reclaim the inside line",
      "keeps the breath high in the nose while the feet keep adjusting a three-point base",
      "presses mid-blade against mid-blade, nobody moving, both loading pressure"
    ],
    mid: [
      "pads in two short steps, each closing half a body width",
      "circles half a step to change the angle with the edge still on the shoulder line",
      "throws one short probing thrust to make the opponent commit first",
      "switches stance so front and rear foot trade places and the rear leg loads",
      "drags half a step out of range while cocking the weapon at the hip",
      "lifts the empty hand to guard the face and keeps the weapon hand below the belt line",
      "steps diagonally to cut off the opponent's circle so they face each other again",
      "lets one breath sink and one rise while the shoulders loosen a finger's width"
    ],
    far: [
      "walks the opponent down with the weapon pointed forward, giving no time to set",
      "circles laterally for cover without taking the eyes off the opponent's hips",
      "adjusts the stance in small steps to put the sun in the opponent's eyes",
      "raises the weapon to shoulder height to shorten the path while still closing",
      "stops short on a feint start to see what the opponent does first",
      "approaches in a folded line along the cover, changing the angle at every corner",
      "drops low and closes the distance with the windup already finished on landing"
    ]
  };

  // ── 四、连段与反击窗口（秒）─────────────────────────────────────────
  const WINDOWS = {
    chain: [0.25, 0.55],
    cancel: [0.10, 0.25],
    counterAfterBlock: [0.20, 0.80],
    counterAfterDodge: [0.15, 0.60],
    punishAfterWhiff: [0.15, 0.50],
    hitstunMin: 0.20,
    hitstunMax: 0.90,
    initiativeSwap: [1.5, 3.0]
  };

  // ── 五、核心规则（写进提示词的硬条款）───────────────────────────────
  const CORE_RULES = [
    "**无因停顿禁令**：全片不得出现没有原因的动作空档。任何超过 0.35 秒的静止画面，都必须由「受击硬直／闪避落位／被兵器压住／换架调整／绕步换角度／被掩体阻隔」之一明确解释，并且把解释本身写成画面里的动作，而不是旁白说明。",
    "**打斗反馈五要素**：每一次接触都要写全——前因、动作、接触点、受力方向与位移、余波与下一步的起因。缺任何一项，这一下就等于没打。",
    "**因果链闭合**：上一拍的结果必须是下一拍的起因。禁止出现「A 打完收招→B 若无其事站定→A 再打」这种断裂；正确写法是「A 的横扫被格挡→兵器相撞的反弹把 A 的肩推向后侧→B 借这个空档前垫半步压住中线」。",
    "**连续招式（连段）**：收招的后半段必须接下一招，写成「第一式未收尽，第二式已起」。常见三连：压制（劈／扫）→换位（绕步／转身）→终结（撞／摔／刺）。同一串连段里距离不得跳变。",
    "**闪避必须指向具体来招**：闪避不是随机位移，而是看清来招轨迹后让开那条线，并写明落位（退半步／侧移半身／下沉／贴地）；落位后必须出现反击或反压。",
    "**反击窗口**：格挡后 0.2~0.8 秒、闪避落位后 0.15~0.6 秒、对方落空后 0.15~0.5 秒内必须有反击或抢位；不反击的时候要写明原因（被打断／被地形限住／兵器还压着）。",
    "**主动权交换**：每 1.5~3 秒交换一次主动权（谁在压、谁在扛）。写成画面：谁后退、谁前进、谁的兵器线压在对方身上。",
    "**距离纪律**：两人的距离由招式的有效范围决定，不能凭空跳变。要缩短必须先写脚步（垫步／绕步／突进），要拉开必须先写撤步或被击退。",
    "**高度与姿态**：至少出现一次高度变化（下沉／起跳／踩台／被击退上台阶）与一次姿态变化（站→跪→翻滚起身），每次变化都要有受力或选择作为原因。",
    "**兵器与道具唯一性**：全片同一件兵器不得凭空出现第二个；被击落的兵器要留在画面里，谁捡、什么时候捡都要写。",
    "**间隙动作显性化**：把间隙动作库里的动作直接写进正文（垫步逼近、绕半步改角度、换架、拖步蓄势、抬手护面），让每一秒都有具体动作，不要留给模型自己填。",
    "**节奏红线**：首个有效动作 ≤0.3 秒（极速版 ≤0.15）；纯恢复动作 ≤0.7 秒（≤0.3）；动作特写 0.8~1.5 秒（0.4~0.8）；慢动作按需最多一次；15 秒内交锋 6~9 次。",
    "**声音跟着受力走**：材质与声音对应（徒手不写金属声）；命中写闷响加受力方的反应；兵器相交写短促清响；格挡写连续推挤的摩擦声。",
    "**结束画面兑现完成条件**：结尾必须让胜负或脱离被画面明确看见（谁站着、谁倒下、谁退到哪、什么东西留在原地），不能停在半途。",
    "**动作必须有目的（新）**：每一个动作都要交代它服务于什么——进攻／闪躲／脱离／抢位／护住／蓄势／格挡／反击。写不出目的的动作一律删掉。禁止「无来由的跳跃、无来由的翻滚、无来由的转身、无来由的后退」。",
    "**跳跃纪律（新）**：跃起只允许两种目的：① 为躲开某一条来招（写明哪一招、让开哪条线、落在哪里）② 为进攻（跃起重击／迎空拦截／俯冲压落）。**不许在没有来招、也没有出手机会时起跳、连跳、悬停**；一次交锋里的起跳次数不要超过一次；跳完必须落地并接上下一步（落地即反击或落地即撤）。",
    "**跳跃高度按动作适配（新）**：跳跃不是固定高度——躲低扫只需要离地半米左右的小跳（越过来招那条线就够）；躲中段招式中跃；跃起重击取中高（按对方是站着还是蹲着定）；迎空拦截必须够到对方所在高度；突进与追击一律压低成低平跃（跳高了反而贴不上人）；借墙换位按离墙远近取高中低。**同一个高度反复出现就是错的**——每一次起跳都要写清「跳到多高、为什么是这个高度」。",
    "**招式必须给出准备时间与释放时间（新）**：每个招式都要写两段时间，而且**用范围不要写死**——准备（起势／蓄力／结印）例如「扎马步、双掌后收、运气起势，准备 1~3 秒」；释放（脱手→飞行→命中／消散）例如「双掌前推，龙形气功脱手飞向对手并自动追踪，释放 2~4 秒」。轻功身法与兵器近身招同样要给：起手 0.1~0.3 秒、收招 0.2~0.7 秒。",
    "**招式效果要写准确（新）**：每个招式都要写清①形态（龙形气功／掌风／剑气／火球／冰锥／雷弧…）②飞行方式（直线／贴地／抛射／扇面）③是否自动追踪（追踪的要写「会顺着对手的移动修正方向」）④命中表现（炸开／掀翻／僵直／结霜／焦痕）⑤作用范围（多大、几人）。不要只写「打出一掌」这种没有效果描述的写法。",
    "**动作时间账（新）**：任何动作都不是瞬发即消失，都要写出「开始→过程→结束」与时长：起手多久（常规 ≤0.3 秒）、有效（真正走轨迹、能碰到人的那一段，0.05~0.12 秒）、收招多久（常规 ≤0.7 秒）。格挡要写它顶住了多久（约 0.2~0.3 秒）与之后的反击窗口；闪避要写让开与落位各占多久（约 0.34 秒）；受击硬直要写持续多久（轻 0.18~0.26／重 0.40／崩防 0.85／倒地 3 秒）；滞空要写从起跳到落地共几秒。**禁止「一出招就命中、命中后立刻恢复」这种没有过程的写法**。",
    "**延伸时间（新）**：每个动作都要写余波窗口——命中后对方僵住多久、兵器余震与火星持续多久、被打退的人滑行多久、下一个动作从第几秒接上。镜头长度要与动作时长匹配（一个动作特写 0.8~1.5 秒）。",
    "**一切移动都有去向（新）**：走位只能是为了进入射程、脱离射程、绕到对方侧面（抢角度）或退到掩体后；每一步都要写「为什么现在要动、动完双方距离变成多少」。",
    "**动作目的总表（新）**：①进攻（压制／终结／破防）②跃起重击 ③迎空拦截 ④格挡（护住／卸力）⑤闪避（让开具体刃线）⑥进射程 ⑦调整距离 ⑧抢侧身角度 ⑨脱离 ⑩借掩体 ⑪隔空压制 ⑫空中压迫 ⑬被逼应战 ⑭抓空档惩罚 ⑮受击后稳住。每个动作先落进这 15 类之一，再写它；落不进去就不写。",
    "**前因校核（新）**：防御类动作必须有来招（先写对方哪一招、走哪条线，再写格挡或闪开）；抓空档必须有前因（对方落空或正在收招）；进攻必须在射程内（不在射程内就只能先写脚步）。**禁止对着空气格挡、禁止没人追也逃、禁止隔空乱挥**。",
    "**目的不许重复（新）**：同一个动作连续出现不要超过两次；第三次起必须换手段——换角度、换招式高度、换距离或换成反击。让「每一次出手都和上一次不同」。"
  ];

  const CORE_RULES_EN = [
    "No unexplained pause: any stillness longer than 0.35s must be caused by hitstun, a landing after a dodge, the opponent's blade pinning you, a stance reset, a circling step or cover, and that cause must be shown as an action on screen.",
    "Every contact needs all five elements: cause, action, contact point, direction of force plus displacement, and an aftermath that becomes the cause of the next beat.",
    "Close the causal chain: the result of the previous beat is the reason for the next one; never let a fighter reset and start over.",
    "Chain the moves: the second half of the recovery flows into the next action, suppression to repositioning to finish, and the distance must not jump inside a chain.",
    "A dodge must point at a specific incoming line, name where the body lands, and be followed by a counter or a re-press.",
    "Counter windows: 0.2-0.8s after a block, 0.15-0.6s after a dodge landing, 0.15-0.5s after the opponent whiffs; if there is no counter, state why.",
    "Swap the initiative every 1.5-3s: show who pushes, who absorbs, who steps in and who gives ground.",
    "Keep the distance honest: closing needs visible footwork, opening needs a retreat step or a knockback.",
    "Include at least one change of height and one change of posture, each motivated by force or choice.",
    "Never duplicate a weapon or a prop; a dropped weapon stays in frame and is picked up on camera.",
    "Write the filler work explicitly so every second has concrete action instead of leaving it to the model.",
    "Rhythm: first committed move within 0.3s (0.15s fast-cut), pure recovery under 0.7s (0.3s), action close-ups 0.8-1.5s (0.4-0.8s), one slow-motion beat at most, 6-9 exchanges in 15s.",
    "Sound follows force: unarmed means no metal, impacts get a dull thud plus the receiver's reaction, blade contact gets a short clean ring, a block gets continuous grinding friction.",
    "The ending must make the outcome visible and pay off the completion condition; never stop mid-motion.",
    "Every action needs a purpose: attack, evade, disengage, reposition, guard, load up, block or counter. Delete any move whose purpose cannot be named, and never jump, roll, turn or back off out of nowhere.",
    "Jump discipline: a leap is only allowed to slip a named incoming line or to attack (leap strike, anti-air intercept, dive). No jumping without a threat or an opening, no repeated hopping, no hovering; one leap per exchange at most, and the landing must continue the chain.",
    "Jump height must fit the action: a hop of about half a metre clears a low sweep, a mid-height leap takes a mid line, a leap strike goes mid-to-high (depending on whether the opponent stands or crouches), an anti-air intercept must reach the opponent's altitude, and closing or chasing stays a low flat leap; wall-assisted repositioning scales with the distance to the wall. Repeating one fixed height is wrong — say how high and why.",
    "Every move needs a charge time and a release time, written as ranges rather than fixed numbers: charge (stance, load-up, hand seals) e.g. 'sinks into a horse stance, draws both palms back, gathers qi, charge 1-3s'; release (let go, fly, connect or fade) e.g. 'pushes both palms forward, a dragon-shaped qi bolt leaves his hands and homes on the opponent, release 2-4s'. Weapon and footwork moves also get one: windup 0.1-0.3s, recovery 0.2-0.7s.",
    "Describe each move's effect exactly: shape (dragon qi, palm shockwave, sword qi, fireball, ice shard, lightning arc), flight (straight, ground-hugging, arcing, fan of projectiles), whether it homes (say it corrects course after the opponent), what happens on impact (burst, knockback, freeze, scorch) and its area of effect. Never write a bare 'throws a palm strike'.",
    "Action timing ledger: no action is instantaneous. Give each one a start, a process and an end — windup (normally under 0.3s), active frames (0.05-0.12s, when the weapon really sweeps and can connect) and recovery (under 0.7s). Say how long a block held (about 0.2-0.3s) and the counter window after it, how long a dodge takes to slip and land (about 0.34s), how long hitstun lasts (0.18-0.26s light, 0.40s heavy, 0.85s guard break, 3s knockdown) and how many seconds the airborne arc takes. Never write a strike that lands the instant it starts and recovers immediately.",
    "Aftermath timing: say how long the opponent stays frozen, how long the vibration and sparks last, how far a knocked-back fighter slides, and at what second the next action begins; shot length must match action length (0.8-1.5s per action close-up).",
    "All movement has a destination: closing, disengaging, taking the side angle, or reaching cover, and each step states why and what the distance becomes.",
    "Name the purpose from this closed list for every action: attack (press/finish/break guard), leap strike, anti-air intercept, block (guard/absorb), evade a named line, close the distance, reset the range, take the side angle, disengage, use cover, ranged pressure, airborne pressure, forced turn-and-fight, punish a whiff, recover after a hit.",
    "Check the cause: defence needs an incoming attack (name the strike and the line first), a punish needs a whiff or a recovery, and an attack needs to be in range; never block thin air, flee with nobody chasing, or swing out of range.",
    "Do not repeat the same action more than twice in a row; from the third time change the means — new angle, new height, new distance or a counter."
  ];

  const CAUSE_WORDS = ["因此", "于是", "借这个", "趁", "因为", "被压", "失衡", "露出的空档", "抢到", "反过来", "顺势", "接着", "随即", "立刻", "紧接", "不等", "还没收完", "反弹", "回弹", "受力",
    // 英文（勾选英文输出时必须同样能检查）
    "so ", "therefore", "because", "as a result", "which lets", "off the rebound", "off-balance", "opens the gap", "takes the gap", "riding the", "following the"];
  const FILLER_WORDS = ["垫步", "绕", "换架", "撤步", "拖步", "碎步", "碾", "踏步", "重心", "护面", "抬手", "蓄势", "调整", "侧移", "绕行", "逼近", "站位", "脚步",
    "footwork", "steps in", "steps back", "pads", "circles", "sidestep", "switch stance", "stance", "shifts weight", "hand up", "cocks", "drags", "closes the distance", "retreats", "adjusts"];
  const IDLE_WORDS = ["静止", "站定", "不动", "僵持", "对峙", "发呆", "停顿", "停手", "凝立", "纹丝不动",
    "stands still", "standoff", "motionless", "frozen", "freezes", "pauses", "stares"];
  const INTENTS = [
    { key: "attack", zh: "进攻", words: ["进攻", "压制", "抢攻", "劈", "刺", "扫", "砸", "撞", "踢", "attack", "press", "strike"] },
    { key: "evade", zh: "闪躲", words: ["躲", "让开", "避开", "侧身", "后仰", "下潜", "闪", "evade", "slip", "avoid", "duck"] },
    { key: "escape", zh: "脱离", words: ["脱身", "拉开", "撤出", "退走", "脱离", "disengage", "break off", "retreat"] },
    { key: "reposition", zh: "抢位", words: ["绕", "抢位", "换位", "封住", "切角度", "circle", "reposition", "cut off"] },
    { key: "guard", zh: "护住", words: ["护住", "格挡", "架住", "挡住", "卸力", "guard", "block", "parry"] },
    { key: "setup", zh: "蓄势", words: ["蓄势", "试探", "假动作", "诱", "feint", "probe", "bait"] },
    { key: "counter", zh: "反击", words: ["反击", "反打", "回敬", "抢下", "counter", "riposte"] }
  ];
  const PURPOSE_WORDS = INTENTS.reduce((a, x) => a.concat(x.words), []);
  // 每一拍必须落一个明确目的（拍序 → 目的），保证提示词里"每个动作都有理由"
  const PURPOSES = [
    { zh: "进攻·压制", note: "抢中线、持续施压，逼对方先退" },
    { zh: "闪躲·卸力", note: "看清来招让开刃线，落位后立刻反压" },
    { zh: "抢位·切角度", note: "绕到对方侧面，切断他的绕行路线" },
    { zh: "进攻·终结", note: "抓住空档一次打穿" },
    { zh: "脱离·收势", note: "退出射程稳住架势，兑现胜负" }
  ];
  // ── 动作目的总表（15 类）：每个动作都必须落进这里 ──────────────────────
  //   purpose 必写；when 成立条件（不满足就是无意义动作）；after 余波（下一步的起因）
  const ACTION_PURPOSES = [
    { key: "attack", zh: "地面进攻", purpose: "压制／终结／破防", when: "对方在射程内（含预判位移后仍在射程内）", after: "收招后半段接下一式，或收招转格挡／闪避" },
    { key: "attack_air", zh: "跃起重击", purpose: "空中重击（跃斩／连击）", when: "距对方 ≤ 射程 2.2 倍且气力足", after: "落地立刻撤离或追击，不许空中悬停" },
    { key: "intercept", zh: "迎空拦截", purpose: "打落空中的对手", when: "对手离地 >1.2 米", after: "落地压制或截其落点" },
    { key: "guard", zh: "格挡", purpose: "护住／卸力", when: "确实有来招（不许对着空气格挡）", after: "格挡后 0.2~0.8 秒内反击或抢位" },
    { key: "evade", zh: "闪避", purpose: "让开具体某条刃线", when: "确实有来招（写明让开哪条线）", after: "落位后立刻反压，不许一直退" },
    { key: "close", zh: "进射程", purpose: "进入有效攻击范围", when: "当前在射程之外", after: "进入射程后立刻出手，不许空走" },
    { key: "reset", zh: "调整距离", purpose: "重置距离／找回节奏", when: "拉锯中或刚吃完一招", after: "重新发起一次交换" },
    { key: "angle", zh: "抢侧身角度", purpose: "绕到对方侧面／切断他的绕行", when: "对方正面防守强或正面打不动", after: "从侧向切入，改变轴线" },
    { key: "escape", zh: "脱离", purpose: "脱战换气或战术撤退", when: "体力低、被围攻或战术需要", after: "脱离后要么再进，要么终结收势" },
    { key: "cover", zh: "借掩体", purpose: "挡住来线／借掩体接近", when: "场地里有实体道具", after: "从掩体后出手，或推开掩体" },
    { key: "ranged", zh: "隔空压制", purpose: "逼位／破防", when: "够不着且气力足", after: "对方被逼出的位移必须被利用" },
    { key: "hover", zh: "空中压迫", purpose: "居高打击", when: "飞行档且有出手机会", after: "俯冲落地并接地面招式" },
    { key: "turnfight", zh: "被逼应战", purpose: "退无可退时反打", when: "被逼到墙角、被贴身或气力见底", after: "一搏定胜负，不许再逃" },
    { key: "punish", zh: "抓空档", purpose: "惩罚对方的落空或收招", when: "对方刚落空／正在收招", after: "打出连段或直接终结" },
    { key: "recover", zh: "受击后稳住", purpose: "恢复重心、脱离硬直", when: "刚被打中或被打飞", after: "重新组织下一次交换" }
  ];
  // 提示词层要检查的动作词（每类动作词出现时，±24 字内必须有目的词）
  const ACTION_WORDS = {
    attack: ["出拳", "挥", "劈", "砍", "刺", "扫", "砸", "撞", "踢", "膝", "肘", "strike", "swing", "thrust", "slash", "kick", "punch"],
    guard: ["格挡", "架住", "挡住", "挡", "架", "卸力", "举盾", "block", "parry", "guard"],
    evade: ["闪避", "侧闪", "闪", "让开", "避开", "躲", "后仰", "下潜", "缩身", "dodge", "slip", "duck", "weave"],
    move: ["逼近", "上前", "退", "后撤", "撤步", "绕", "横移", "垫步", "换位", "approach", "retreat", "circle", "sidestep"],
    jump: ["跃", "跳", "腾空", "腾起", "纵身", "翻身", "俯冲", "悬停", "滞空", "leap", "jump", "flip", "dive", "hover"],
    ranged: ["施法", "掌风", "隔空", "气劲", "掌力", "剑气", "spell", "projectile", "qi blast"],
    cover: ["掩体", "借墙", "贴墙", "躲到", "cover", "wall"]
  };
  // 跳跃类动作只允许两种目的
  const JUMP_PURPOSE = "（跳跃只允许两种目的：① 为躲开某一条来招 ② 为跃起重击或迎空拦截；不许无来由地跳、连跳、悬停）";
  // 显式目的标记：判断"这个动作写没写目的"只看这些（不能拿动作名当目的）
  const PURPOSE_MARKERS = ["本拍目的", "目的：", "为了", "为躲", "为让开", "为避开", "为护住", "为挡住", "为压制", "为抢", "为脱身",
    "为脱离", "为追击", "为拦截", "为进射程", "为拉开", "为逼近", "为蓄势", "为试探", "为诱", "趁他", "借这个", "借对方",
    "抢空档", "抓空档", "偷袭", "回敬", "保住", "换气", "拖住", "逼他", "逼对方",
    "借势", "借着", "顺势", "趁机", "为的是", "想逼", "想抢", "想脱", "想试", "引他", "诱他", "试探他", "拖时间", "护住面门", "守住中线",
    "in order to", "so that", "to slip", "to close", "to press", "to break off", "to intercept", "for cover", "to punish",
    "to absorb", "to reset", "to change", "to carry", "to force", "to break", "to bait", "to draw", "to set up", "to take the angle", "to punish the",
    "（进攻", "（闪躲", "（护住", "（抢位", "（蓄势", "（格挡", "（反击", "（脱离", "（进射程", "（调整距离", "（拦截", "（压制", "（追击"];
  const JUMP_WORDS = ["跃", "跳", "腾空", "腾起", "跃起", "纵身", "空翻", "翻身", "跃斩", "俯冲", "悬停", "滞空", "leap", "jump", "vault", "flip", "dive", "hover", "airborne", "in the air"];
  const COUNTER_WORDS = ["格挡", "架住", "挡开", "卸力", "闪", "侧身避", "后仰", "退半步", "反击", "反打", "回敬", "抢位", "压制", "反压",
    "blocks", "parries", "deflects", "slips", "dodges", "sidesteps", "counters", "answers with", "presses", "re-presses", "absorbs"];

  // ── 六、间隙填充器 ──────────────────────────────────────────────────
  function bandOf(dist) { return dist <= 1 ? "close" : (dist <= 2.5 ? "mid" : "far"); }
  function fillersFor(dist, seed) {
    const band = bandOf(dist);
    const i = Math.abs(seed || 0) % FILLERS[band].length;
    return { band: band, zh: FILLERS[band][i], en: FILLERS_EN[band][i] };
  }

  /** 把结构节拍展开成连续微动作：每拍 → 前因／动作／接触／受力／余波，动作段带间隙动作 */
  function expandBeats(beats, opt) {
    opt = opt || {};
    const names = opt.names || ["甲", "乙"];
    let dist = opt.startDist || 2;
    const media = opt.media || ["尘土", "水花", "衣摆"];
    const out = [];
    (beats || []).forEach((b, i) => {
      const f1 = fillersFor(dist, (opt.seed || 0) + i * 2);
      const f2 = fillersFor(dist + (i % 2 ? -0.4 : 0.4), (opt.seed || 0) + i * 2 + 1);
      const attacker = i % 2 === 0 ? names[0] : names[1];
      const defender = i % 2 === 0 ? names[1] : names[0];
      const nextDist = Math.max(0.6, Math.min(4.5, dist + (i % 2 ? 0.5 : -0.5)));
      out.push({ i: i + 1, phase: "前因", text: defender + " 上一拍的结果还压着他（失衡／兵器被压住／退到掩体边），" + attacker + " 因此抢到下一手的先机。", filler: f1 });
      const pp = PURPOSES[i % PURPOSES.length];
      out.push({ i: i + 1, phase: "动作", text: attacker + "：" + String(b).replace(/（.*?）$/, "") + "；**本拍目的：" + pp.zh + "**（" + pp.note + "）；出手前后各带一次脚步调整（" + f2.zh + "）。" + JUMP_PURPOSE, filler: f2 });
      out.push({ i: i + 1, phase: "接触", text: defender + " 的回应必须写清：格挡（兵器哪一段相碰）／闪避（让开哪条线、落在哪里）／硬吃（受击点与闷响）。", filler: null });
      out.push({ i: i + 1, phase: "受力", text: "接触后立刻承接：力朝哪个方向、谁退了几十厘米、谁的重心破了；环境给一次反馈（" + media[i % media.length] + "）。", filler: null });
      out.push({ i: i + 1, phase: "余波", text: "这一步的余波就是下一步的起因：" + defender + " 夺回或失去主动权，双方距离变成 " + nextDist.toFixed(1) + " 米。", filler: null });
      dist = nextDist;
    });
    return out;
  }

  // ── 七、提示词块 ────────────────────────────────────────────────────
  function logicBlock(opt) {
    opt = opt || {};
    if (opt.en) {
      return ["【CORE FIGHT LOGIC — obey every line】"].concat(CORE_RULES_EN.map((r, i) => (i + 1) + ". " + r)).join("\n");
    }
    const head = opt.head || "【核心打斗逻辑 · 必须逐条落实】";
    const filler = [
      "【间隙动作库（把空档填满，不要留给模型自己编）】",
      "· 贴身（≤1 米）：" + FILLERS.close.slice(0, 4).join("；"),
      "· 中距（1~2.5 米）：" + FILLERS.mid.slice(0, 4).join("；"),
      "· 远距（>2.5 米）：" + FILLERS.far.slice(0, 4).join("；")
    ].join("\n");
    const win = "【窗口（秒）】连段 " + WINDOWS.chain.join("~") + "｜收招取消 " + WINDOWS.cancel.join("~")
      + "｜格挡后反击 " + WINDOWS.counterAfterBlock.join("~") + "｜闪避后反击 " + WINDOWS.counterAfterDodge.join("~")
      + "｜落空惩罚 " + WINDOWS.punishAfterWhiff.join("~") + "｜主动权交换 " + WINDOWS.initiativeSwap.join("~");
    return [head].concat(CORE_RULES.map((r, i) => (i + 1) + ". " + r)).concat(["", filler, "", win]).join("\n");
  }

  // ── 八、提示词体检器 ────────────────────────────────────────────────
  function checkPrompt(text, opt) {
    opt = opt || {};
    const t = String(text || "");
    const issues = [];
    const hits = (arr) => arr.filter(w => t.indexOf(w) >= 0);
    const cause = hits(CAUSE_WORDS), filler = hits(FILLER_WORDS), idle = hits(IDLE_WORDS), counter = hits(COUNTER_WORDS);
    const shots = (t.match(/\[Shot\s*\d+\]/gi) || []).length;

    if (filler.length === 0) issues.push({ level: "error", code: "no-filler-motion", msg: "正文里没有任何间隙动作（垫步／绕步／换架／撤步…）", hint: "把空档写成具体动作，否则模型会把空档渲染成静止。" });
    if (cause.length < 2) issues.push({ level: "error", code: "no-causal-chain", msg: "因果连接词只有 " + cause.length + " 个，看不出上一拍的结果与下一拍的起因", hint: "用「借这个空档／因此／顺势」把拍与拍连起来。" });
    if (counter.length === 0) issues.push({ level: "error", code: "no-counter", msg: "全文没有任何格挡／闪避／反击的回应动作", hint: "每轮交锋都要有回应：格挡、闪避落位或硬吃，并给出受力结果。" });
    if (idle.length && cause.length === 0) issues.push({ level: "error", code: "idle-unexplained", msg: "出现「" + idle.slice(0, 3).join("、") + "」却没有写原因与动作", hint: "要么删掉静止，要么写明原因（受击硬直／被压住兵器／换架）并把它写成动作。" });
    // 无目的动作：**所有动作类**的动作词 ±24 字内必须有目的词
    //   ① 先剔除【负面】/【禁止】等清单块（里面的"比例跳变"不是动作）
    //   ② 再剔除"约束/禁令句"整句（规则句自身含动作词）
    const RULE_CONTEXT = /不许|不准|不得|禁止|只允许|只可以为|no jumping|never jump|not allowed/;
    const NON_ACTION_JUMP = /跳变|跳动|跳帧|心跳|跳轴|绕口令/;
    const NON_ACTION_HIT = /相撞|撞击|碰撞|撞上|一撞/;   // "兵器相撞"是名词，不是动作
    const NON_ACTION_NOUN = /the strike|strike comes|incoming strike|the kick|拳风|棍风|刀风/;   // 名词化写法
    const tJump = t
      .replace(/【(?:负面|禁止|禁令|negative|禁写)[^】]*】[\s\S]*?(?=【|$)/gi, "")
      .split(/[。；;\n]/).filter(x => !RULE_CONTEXT.test(x)).join("。");
    const strict = !(opt && (opt.mode === "template" || opt.mode === "design"));   // 骨架/设计稿走宽松档
    const purposeless = [];
    Object.keys(ACTION_WORDS).forEach(cls => {
      ACTION_WORDS[cls].forEach(w => {
        let i = -1;
        while ((i = tJump.indexOf(w, i + 1)) >= 0) {
          if (NON_ACTION_JUMP.test(tJump.slice(i, i + w.length + 2))) continue;
          if (NON_ACTION_HIT.test(tJump.slice(Math.max(0, i - 2), i + w.length + 2))) continue;
          if (NON_ACTION_NOUN.test(tJump.slice(Math.max(0, i - 6), i + w.length + 4))) continue;
          const win = tJump.slice(Math.max(0, i - 160), i + w.length + 160);
          if (!strict) continue;                                   // 宽松档不逐词查（骨架是动作菜单）
          if (!PURPOSE_MARKERS.some(pp => win.indexOf(pp) >= 0)) purposeless.push(cls + ":" + w);
        }
      });
    });
    if (!strict) {
      const marks = PURPOSE_MARKERS.filter(m => t.indexOf(m) >= 0).length;
      const need = shots >= 3 ? 2 : 1;
      if (marks < need) issues.push({ level: "error", code: "no-purpose-in-skeleton", msg: "整段只找到 " + marks + " 处目的标记（至少要有 " + need + " 处）", hint: "骨架也要写出每一拍的目的（进攻／闪躲／抢位／脱离…），成稿时每个动作才写得出目的。" });
    }
    if (purposeless.length) issues.push({ level: "error", code: "purposeless-action", msg: (strict ? "有 " + purposeless.length + " 处动作没写目的（" : "有 " + purposeless.length + " 处跳跃没写目的（") + Array.from(new Set(purposeless)).slice(0, 4).join("、") + "）", hint: "每个动作都要交代它服务于什么（进攻／闪躲／脱离／抢位／护住／蓄势／格挡／反击）；跳跃只能是「为躲开来招」或「为跃起重击／迎空拦截」。写不出目的就删掉这个动作。" });
    // 无来由的防御：格挡/闪避前 40 字内必须有"进攻动作"（比固定短语表稳）
    const guardWords = ["格挡", "架住", "挡住", "闪避", "侧闪", "让开", "避开", "block", "parry", "dodge"];
    const atkWords = ACTION_WORDS.attack.concat(["拳", "掌", "刃", "兵刃", "攻势", "棍", "刀", "剑", "incoming", "来招", "刃线", "掌风", "棍风", "刀风", "threat"]);
    let guardTotal = 0, guardBad = 0;
    guardWords.forEach(w => {
      let k = -1;
      while ((k = t.indexOf(w, k + 1)) >= 0) {
        guardTotal++;
        const back = t.slice(Math.max(0, k - 60), k);
        if (!atkWords.some(a => back.indexOf(a) >= 0)) guardBad++;
      }
    });
    if (strict && (guardBad >= 2 || (guardBad === 1 && guardTotal === 1))) {
      issues.push({ level: "error", code: "defense-without-threat", msg: "有 " + guardBad + "/" + guardTotal + " 处防御没有对应的来招", hint: "防御必须有前因：先写对方哪一招打来、走哪条线（劈来／扫来／刺向），再写格挡或闪开。禁止对着空气格挡。" });
    }
    // 目的重复：同一个动作类连续出现 3 次以上且没有变化词
    const changeWords = ["换", "改", "变", "转", "不同", "另", "接着", "反过", "change", "switch", "instead"];
    ["格挡", "后退", "撤步", "闪避", "block", "retreat", "dodge"].forEach(w => {
      const n = t.split(w).length - 1;
      if (n >= 3 && !changeWords.some(cw => t.indexOf(cw) >= 0)) {
        issues.push({ level: "warn", code: "repeat-without-change", msg: "「" + w + "」重复了 " + n + " 次且没有变化", hint: "同一个动作连续重复会让打斗变成回合制；第三次起要换手段（换角度、换招式、抢位）。" });
      }
    });
    // 动作时间账：动作多但几乎没有时间信息 → 说明写成了"瞬发即消失"
    const TIME_WORDS = ["秒", "半拍", "一拍", "瞬间", "随即", "立刻", "持续", "之久", "之后", "起手", "收招", "有效", "硬直", "窗口", "余震", "余波", "seconds", "second", "for a beat", "a beat", "instant", "immediately", "within", "lasts", "holds for", "later"];
    // 时间信息 = 明确的"数字+秒"表达式 + 时间词出现次数（中英都算）
    const numTime = (t.match(/(\d+(?:\.\d+)?)\s*(秒|s\b|seconds?)/gi) || []).length;
    const timeHits = numTime + TIME_WORDS.reduce((n, w) => n + (t.split(w).length - 1), 0);
    const actionWordCount = Object.keys(ACTION_WORDS).reduce((n, cls) => n + ACTION_WORDS[cls].filter(w => t.indexOf(w) >= 0).length, 0);
    if (actionWordCount >= 5 && timeHits < 3) {
      issues.push({ level: "error", code: "no-duration", msg: "动作有 " + actionWordCount + " 处，但时间信息只有 " + timeHits + " 处", hint: "每个动作都要有开始→过程→结束：写清起手／有效／收招各多久、硬直多久、反击窗口几秒。禁止出招即命中、命中即恢复。" });
    }
    // 招式时间：出现招式词（掌/气功/术/法/剑气…）时必须有"准备/蓄力/释放/施法"这类时间描述
    const MOVE_CAST_WORDS = ["掌", "气功", "气劲", "剑气", "掌风", "法术", "术法", "结印", "施法", "运气", "蓄力", "起势", "真气", "内力", "qi bolt", "spell", "cast"];
    const CAST_TIME_WORDS = ["准备", "蓄力", "起势", "结印", "运气", "施法时间", "释放时间", "脱手", "charge", "recovery time"];
    const moveHit = MOVE_CAST_WORDS.filter(w => t.indexOf(w) >= 0).length;
    const castTimeHit = CAST_TIME_WORDS.filter(w => t.indexOf(w) >= 0).length;
    if (moveHit >= 2 && castTimeHit === 0) {
      issues.push({ level: "error", code: "no-cast-timing", msg: "有招式描写（" + moveHit + " 处）但没有准备／释放时间", hint: "每个招式都要写「准备 x~y 秒」与「释放 a~b 秒」，并写清形态、飞行方式、是否追踪、命中表现与范围。" });
    }
    if (shots >= 3 && filler.length && filler.length < shots) issues.push({ level: "warn", code: "filler-sparse", msg: "间隙动作 " + filler.length + " 处、镜头 " + shots + " 个，平均每镜不到一处", hint: "每个切镜后的第一句都可以带上脚步或换架。" });
    return { ok: !issues.some(i => i.level === "error"), issues: issues, stats: { cause: cause.length, filler: filler.length, idle: idle.length, counter: counter.length, shots: shots } };
  }

  /** 内核审计：目的覆盖率 + 分布 + 无意义动作（无来由防御／超距出手／目的重复） */
  function auditPurposes(fighter, events) {
    const p = (fighter && fighter.purposes) || { total: 0, tagged: 0, unpurposed: 0, counts: {}, log: [] };
    const ev = events || [];
    const out = { total: p.total, tagged: p.tagged, unpurposed: p.unpurposed,
      coverage: p.total ? +(p.tagged / p.total).toFixed(3) : 0, counts: p.counts || {}, issues: [] };
    // ① 无来由防御：格挡/闪避决策发生时，对手在 0.5 秒内没有出招
    let dfn = 0, dfnBad = 0;
    (p.log || []).forEach(x => {
      if (x.purpose !== "guard" && x.purpose !== "evade") return;
      dfn++;
      const threat = ev.some(e => e.type === "attack" && e.t <= x.t && x.t - e.t <= 0.5 && e.who !== fighter.id);
      if (!threat) dfnBad++;
    });
    if (dfn >= 5 && dfnBad / dfn > 0.25) out.issues.push({ level: "warn", code: "defense-without-threat", msg: "有 " + dfnBad + "/" + dfn + " 次防御发生在对手没出招时", hint: "防御必须有来招：内核按「预判」出招，提示词里要写明对方那一招。" });
    // ② 超距出手：进攻决策时距离 > 射程 1.4 倍
    let atk = 0, atkFar = 0;
    (p.log || []).forEach(x => {
      if (x.purpose !== "attack" && x.purpose !== "attack_air") return;
      atk++;
      const a = ev.find(e => e.type === "attack" && e.who === fighter.id && Math.abs(e.t - x.t) < 0.25);
      if (a && a.dist != null && a.reach != null && a.dist > a.reach * 1.4) atkFar++;
    });
    if (atk >= 5 && atkFar / atk > 0.2) out.issues.push({ level: "warn", code: "attack-out-of-range", msg: "有 " + atkFar + "/" + atk + " 次出手发生在射程外", hint: "先写脚步进射程再出手。" });
    // ③ 目的重复：连续 4 次同一目的
    let run = 0, prev = null, worst = 0, worstKey = "";
    (p.log || []).forEach(x => {
      if (x.purpose && x.purpose === prev) { run++; if (run > worst) { worst = run; worstKey = x.purpose; } }
      else { run = 1; prev = x.purpose; }
    });
    if (worst >= 5) out.issues.push({ level: "info", code: "repeat-without-change", msg: "连续 " + worst + " 次都是「" + (counts_zh(p.counts, worstKey) || worstKey) + "」", hint: "同一目的连续重复会让打斗变回合制，第三次起要换手段。" });
    if (p.unpurposed) out.issues.push({ level: "error", code: "unpurposed-action", msg: "有 " + p.unpurposed + " 个决策没有落进目的表", hint: "内核每个决策都必须有目的——补 PURPOSE_MAP 映射或删掉这个决策。" });
    out.stats = { defenseCount: dfn, defenseWithoutThreat: dfnBad, attackCount: atk, attackOutOfRange: atkFar, longestSamePurpose: worst, samePurposeKey: worstKey };
    return out;
  }
  function counts_zh(counts, key) {
    const hit = ACTION_PURPOSES.find(a => a.key === key);
    return hit ? hit.zh : key;
  }

  /** 动作时间账审计：时长统计 + 相位分布 + 待机/滞空占比 + 延伸窗口兑现率 */
  function timelineAudit(result) {
    const tl = (result && result.timeline) || [];
    const dur = (result && result.duration) || 0;
    const out = { segments: tl.length, duration: dur, issues: [], stats: {} };
    if (!tl.length) { out.issues.push({ level: "warn", code: "no-timeline", msg: "没有动作时间账（内核未记录分段）" }); return out; }
    const sum = {}, phases = { windup: 0, active: 0, recovery: 0 };
    let idle = 0, air = 0, longest = 0, actN = 0, actDur = 0;
    const PH = { "起手": "windup", "有效": "active", "收招": "recovery" };
    tl.forEach(x => {
      const parts = String(x.label || "").split("·");
      const base = parts[0];
      sum[base] = (sum[base] || 0) + x.dur;
      if (base === "待机") idle += x.dur;
      if (x.airborne) air += x.dur;
      const ph = PH[parts[1]];
      if (ph) phases[ph] += x.dur;
      if (base && base !== "待机" && base !== "走位") { actN++; actDur += x.dur; }
      if (x.dur > longest) longest = x.dur;
    });
    const per = tl.reduce((o, x) => { o[x.who] = (o[x.who] || 0) + x.dur; return o; }, {});
    const denom = Math.max(0.001, dur * Math.max(1, Object.keys(per).length));
    out.stats = {
      totalActionTime: +Object.values(per).reduce((a, b) => a + b, 0).toFixed(2),
      perFighter: Object.fromEntries(Object.entries(per).map(([k, v]) => [k, +v.toFixed(2)])),
      idleShare: +(idle / denom).toFixed(3), airShare: +(air / denom).toFixed(3),
      avgAction: actN ? +(actDur / actN).toFixed(3) : 0, count: actN, longest: +longest.toFixed(2),
      phases: { windup: +phases.windup.toFixed(2), active: +phases.active.toFixed(2), recovery: +phases.recovery.toFixed(2) },
      byKind: Object.fromEntries(Object.entries(sum).map(([k, v]) => [k, +v.toFixed(2)]))
    };
    if (out.stats.phases.windup > 0 && out.stats.phases.active / out.stats.phases.windup > 0.6)
      out.issues.push({ level: "warn", code: "active-too-long", msg: "有效帧总时长是起手的 " + (out.stats.phases.active / out.stats.phases.windup).toFixed(2) + " 倍", hint: "有效段（能打到人的那几帧）应远短于起手。" });
    if (out.stats.idleShare > 0.18) out.issues.push({ level: "warn", code: "idle-share-timing", msg: "待机时间占 " + (out.stats.idleShare * 100).toFixed(0) + "%", hint: "空档要用有目的的动作填满。" });
    const ev = (result && result.events) || [];
    const blocks = ev.filter(e => e.type === "block");
    // 压制持续度：格挡后 0.8 秒内**对手**是否继续出手（防守方被压着的程度）
    const kept = blocks.filter(b => ev.some(x => x.type === "attack" && x.who !== b.who && x.t > b.t && x.t - b.t <= 0.8)).length;
    // 真正的反击：格挡后 0.8 秒内**防守方自己**出手
    const counterByDefender = blocks.filter(b => ev.some(x => x.type === "attack" && x.who === b.who && x.t > b.t && x.t - b.t <= 0.8)).length;
    out.stats.counterAfterBlock = blocks.length ? +(kept / blocks.length).toFixed(2) : null;
    out.stats.counterByDefender = blocks.length ? +(counterByDefender / blocks.length).toFixed(2) : null;
    if (blocks.length >= 3 && out.stats.counterByDefender < 0.35)
      out.issues.push({ level: "warn", code: "counter-window-missed", msg: "格挡后 0.8 秒内自己反击的比例只有 " + out.stats.counterByDefender, hint: "守下来要接反击（提示词里写明窗口秒数）。" });
    return out;
  }

  // ── 九、内核体检器（诊断用）─────────────────────────────────────────
  function checkEvents(result) {
    const fr = (result && (result.frames || result.record)) || [];
    const ev = (result && result.events) || [];
    const dt = 1 / 60;
    const out = { duration: (result && result.duration) || 0, frames: fr.length, issues: [], stats: {} };
    if (!fr.length) { out.issues.push({ level: "warn", code: "no-frames", msg: "没有逐帧数据，无法体检" }); return out; }
    const COMBAT = ["attack", "hit", "block", "dodge", "clash", "guardbreak", "spell_cast", "spell_release", "spell_hit", "whiff", "qi_burst", "takeoff", "landing"];
    let idleFrames = 0, maxIdleRun = 0, run = 0;
    fr.forEach(f => {
      const a = f.A || {}, b = f.B || {};
      if (a.st === "idle" && !(b && (b.st === "down" || b.st === "getup"))) idleFrames++;   // 2026-09-29：对手倒地/起身时自己的收势等待不算发呆
      if (b.st === "idle" && !(a && (a.st === "down" || a.st === "getup"))) idleFrames++;
      const either = (a.st === "idle" || b.st === "idle");
      if (either && !(a.st === "down" || b.st === "down")) { run += dt; if (run > maxIdleRun) maxIdleRun = +run.toFixed(2); } else run = 0;
    });
    const attacks = ev.filter(e => e.type === "attack").length;
    const actions = ev.filter(e => COMBAT.indexOf(e.type) >= 0).length;
    const defends = ev.filter(e => e.type === "block" || e.type === "dodge");
    // 反击率 = 防守方**自己**在 0.9 秒内出手（这才是"反击窗口兑现"）
    // 原实现数的是"防守后反被打中"，方向正好相反（会把"守得好"报成"反击率低"，实测 75% 场次误报）。
    const counters = defends.filter(d => ev.some(a => a.type === "attack" && a.who === d.who && a.t - d.t > 0 && a.t - d.t <= 0.9)).length;
    // 挨打率 = 防守后 0.9 秒内又被打中（守住了却没走开）
    const punished = defends.filter(d => ev.some(h => h.type === "hit" && h.who === d.who && h.t - d.t > 0 && h.t - d.t <= 0.9)).length;
    out.stats = {
      attackDensity: +(attacks / out.duration).toFixed(2),
      actionDensity: +(actions / out.duration).toFixed(2),
      idleFrames: idleFrames,
      idleShare: +(idleFrames / (fr.length * 2)).toFixed(3),
      maxIdleRun: maxIdleRun,
      blocks: defends.length, counters: counters, punished: punished,
      counterRate: defends.length ? +(counters / defends.length).toFixed(2) : 0,
      punishedRate: defends.length ? +(punished / defends.length).toFixed(2) : 0
    };
    if (maxIdleRun > 0.4) out.issues.push({ level: "warn", code: "idle-run", msg: "内核里存在 " + maxIdleRun + " 秒的连续静止", hint: "写提示词时必须给这段时间补上间隙动作。" });
    if (out.stats.idleShare > 0.08) out.issues.push({ level: "warn", code: "idle-share", msg: "静止帧占比 " + (out.stats.idleShare * 100).toFixed(1) + "%", hint: "偏高。" });
    if (defends.length >= 3 && out.stats.counterRate < 0.35) out.issues.push({ level: "warn", code: "low-counter", msg: "格挡／闪避后 0.9 秒内自己出手反击的比例只有 " + out.stats.counterRate, hint: "守住之后要接反击，不能只是挡。" });
    if (defends.length >= 3 && out.stats.punishedRate > 0.5) out.issues.push({ level: "warn", code: "punished-after-defense", msg: "守下来之后 0.9 秒内又被打中的比例 " + out.stats.punishedRate, hint: "防住就该走位／换架脱离，不是站着挨第二下。" });
    if (out.stats.actionDensity < 2.5) out.issues.push({ level: "error", code: "low-density", msg: "动作密度仅 " + out.stats.actionDensity + " 次/秒", hint: "过于稀疏。" });
    return out;
  }

  return { VERSION, PHASES, FEEDBACK, FILLERS, FILLERS_EN, WINDOWS, CORE_RULES, CORE_RULES_EN, CAUSE_WORDS, FILLER_WORDS, IDLE_WORDS, COUNTER_WORDS, INTENTS, PURPOSE_WORDS, JUMP_WORDS, PURPOSES, JUMP_PURPOSE, ACTION_PURPOSES, ACTION_WORDS, PURPOSE_MARKERS, auditPurposes, timelineAudit, bandOf, fillersFor, expandBeats, logicBlock, checkPrompt, checkEvents };
});
