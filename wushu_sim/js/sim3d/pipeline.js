/* Shared, DOM-free card/rule compiler and lossless combat evidence adapter. */
(function(root,factory){
  if(typeof module==='object'&&module.exports) module.exports=factory(require('./engine'));
  else root.SIM3D_PIPELINE=factory(root.SIM3D);
})(typeof globalThis!=='undefined'?globalThis:this,function(E){
  'use strict';
  const finite=(n,d,lo,hi)=>Number.isFinite(+n)?Math.max(lo,Math.min(hi,+n)):d;
  const patterns={
    noClash:/不许对拼|避免对拼|不准对拼|不许硬拼/,
    noLeg:/不许用腿|禁腿|不许踢|禁踢|不用腿|不许低扫|不许扫堂/,
    unarmed:/^(?:空手|赤手|徒手)$|双方(?:空手|徒手)|不许用兵器|禁用兵器|禁兵器/,
    noBlock:/不许格挡|禁止格挡/, noDodge:/不许闪|不许躲|禁止闪避/,
    lowDmg:/点到为止|不许下重手|不许重伤|不许致命|留手|切磋|不伤性命/,
    heavy:/招招重击|全力|势大力沉|一力降十会/,
    close:/贴身|近身|不许拉开|必须靠近|必须缠斗|短兵相接|近距离/,
    keepDist:/保持距离|放风筝|游击|游走牵制/,
    blockOnly:/只许格挡|只防不打/
  };
  function rules(lines){
    const flags={}, report=[];
    for(const text of lines||[]){
      const matches=Object.keys(patterns).filter(k=>patterns[k].test(text));
      matches.forEach(k=>flags[k]=true);
      const invariant=/空手.*(?:不得|不许|禁止).*接刃|禁止空手接刃/.test(text);
      report.push({text,status:matches.length?'mapped':invariant?'invariant':'unmapped',features:matches});
    }
    if(flags.close&&flags.keepDist) throw Error('战斗规则冲突：近身缠斗与保持距离，请保留一种。');
    if(flags.blockOnly&&flags.noBlock) throw Error('战斗规则冲突：只许格挡与禁止格挡。');
    return {flags,report};
  }
  function shape(s){
    const t=(s.name||'')+' '+(s.effect||'');
    const key=/刺|戳|点穴/.test(t)?'thrust':/扫|踢|腿/.test(t)?'sweep':/挑|撩|升/.test(t)?'rise':/劈|斩落/.test(t)?'diag':/砸|重|崩/.test(t)?'heavy':'slash';
    return E.VARIANTS.find(v=>v.key===key);
  }
  // ── 内力外放档案（按等级解锁）：高等级不能只会平A ────────────────────
  //   用户反馈「绝世高手没有内力/气功/剑气，就是两个人平A」。根因是：法术只来自角色卡的
  //   「法术」组，卡里没配就没有；而且内核只在「够不着」时才隔空放。这里按等级给出：
  //   ① qi：命中瞬间的气劲外放（半径/额外击退），等级越高越夸张，肉搏里也看得见；
  //   ② castBonus：隔空出手概率加成；③ 默认内力技（卡里没配或配得少时自动补）。
  const QI_BANDS = [
    { label: '无',        burst: 0,    kb: 0,    castBonus: 0,    spells: [] },                                                   // 1 级
    { label: '无',        burst: 0,    kb: 0,    castBonus: 0,    spells: [] },                                                   // 2 级
    { label: '贴身劲力',  burst: 0.55, kb: 0.25, castBonus: 0,    spells: [['透劲',4,2,3,'内力透体而入，贴身震开']] },                 // 3 级
    { label: '透劲',      burst: 0.70, kb: 0.35, castBonus: 0.04, spells: [['透劲',5,2,3,'内力透体而入'],['隔空掌',5,2,3,'掌风隔空压到']] }, // 4 级
    { label: '掌风/剑气', burst: 0.90, kb: 0.50, castBonus: 0.08, spells: [['隔空掌',6,2,3,'掌风隔空压到'],['剑气',6,2,3,'剑气离体划空而来']] }, // 5 级
    { label: '罡气',      burst: 1.00, kb: 0.60, castBonus: 0.10, spells: [['罡气外放',7,3,3.5,'罡气外放震开'],['剑气纵横',7,3,3.5,'剑气纵横交错']] }, // 6 级
    { label: '真罡',      burst: 1.20, kb: 0.75, castBonus: 0.12, spells: [['护体真罡',8,3,3.5,'护体真罡外放震开'],['剑气纵横',8,3,3.5,'剑气纵横交错'],['御气成刃',8,3,4,'气劲凝成丈许锋刃']] }, // 7 级
    { label: '真元',      burst: 1.35, kb: 0.90, castBonus: 0.15, spells: [['御气成刃',9,4,4,'气劲凝成锋刃飞出'],['劈山掌',9,4,4,'隔空一掌劈开山石']] }, // 8 级
    { label: '绝世·天地异象', burst: 1.60, kb: 1.15, castBonus: 0.18, spells: [['翻江倒海',10,5,4.5,'一挥手江河倒灌'],['万千法相',9,4,4,'化万千分身齐攻'],['乾坤一掷',10,5,4.5,'携山河之力掷下']] } // 9 级
  ];
  function qiProfile(tier){ return QI_BANDS[Math.max(1, Math.min(9, Math.round(tier||1))) - 1]; }

  // ── 特效分级规范（仙侠向）──────────────────────────────────────────
  //   用户反馈「特效太简单、没有仙侠大片感」。内核这一侧先把"该多夸张"定下来并写进证据：
  //   每档给出 名称／配色／形状／体量／光照后果／环境破坏／镜头反馈；风格档在其上整体上调或下调。
  // 九档特效规格（形·色·量·光·破·影）＋"留痕/余波/场面语法"。
  //   2026-09-23 升级：用户反馈"仙侠大片的法术或攻击效果没有毁天灭地的感觉"。
  //   所以 6 档以上不再是"米级火花"，而是按国漫仙侠的场面语法给**量级**：
  //     场地级（十米级：炸坑、裂地、房屋成片倒）→ 山岳级（百米级：削山、断崖、水墙）
  //     → 天地级（里级：天象改写、法相拔地、江河倒卷、云层撕成漩涡）。
  //   同时每档都要求"**留痕**"（坑/裂纹/断壁/倒伏/焦痕跨镜保留）与"**余波**"（打完那一镜要有收尾画面）。
  // 九档特效规格（形·色·量·光·破·影）＋"留痕/余波/场面语法"。
  //   2026-09-23 升级：用户反馈"仙侠大片的法术或攻击效果没有毁天灭地的感觉"。
  //   6 档以上不再是"米级火花"，而是按国漫仙侠的场面语法给**量级**：
  //     场地级（十米级：炸坑、放射裂纹、成排断墙）→ 山岳级（百米级：削山断崖、水墙、林海倒伏、云涡）
  //     → 天地级（里级：天象改写、法相拔地、江河倒卷、地裂成谷）。
  //   每档都要求"**留痕**"（坑/裂纹/断壁/倒伏/焦痕跨镜保留）与"**余波**"（打完那一镜的收尾画面）。
  const FX_TIERS = [
    { name:'凡人',     palette:'无光效',         shape:'—',                    scale:'0.05 米（贴身）',
      light:'—',                       destruction:['尘土轻扬','衣角微动'],            camera:'撞击微震',
      scar:'脚下的浮土被踩乱',              aftermath:'两人收势站定' },
    { name:'好手',     palette:'白气流',         shape:'一缕拳风拖尾',          scale:'0.3 米（贴身）',
      light:'—',                       destruction:['碎石微溅','衣摆翻飞'],            camera:'贴身横移',
      scar:'地面留一道浅擦痕',              aftermath:'踏起的碎石落地弹两下' },
    { name:'高手',     palette:'青白',           shape:'同心气劲涟漪',          scale:'0.6 米（半身）',
      light:'冷光映亮地面',            destruction:['青石板裂细纹','尘土扬起'],        camera:'命中急推半拍',
      scar:'石板上的细裂纹留着',            aftermath:'尘土慢慢落下，雨点把浮尘打湿' },
    { name:'宗师',     palette:'金白',           shape:'透体冲击波',            scale:'1.0 米（一人高）',
      light:'金光勾出人物轮廓',        destruction:['器物被震开','地面开裂'],          camera:'低角度跟拍＋一震',
      scar:'门槛崩掉一角',                aftermath:'被震开的器物滚出画面外' },
    { name:'大宗师',   palette:'金青',           shape:'罡气护膜＋气浪环',      scale:'1.6 米（两步外可感）',
      light:'金光映亮雨后石板',        destruction:['碎石飞溅','气浪推人','灯笼摇晃'],  camera:'环绕＋冲击波特写',
      scar:'墙皮成片剥落、灯笼碎在地上',   aftermath:'气浪过处，雨幕被吹成一片扇形水雾' },
    { name:'绝世',     palette:'青白剑芒＋电弧', shape:'剑气纵横拖尾',          scale:'2.2 米（三五步）',
      light:'电光短暂照亮面部',        destruction:['空气扭曲','瓦片剥落','浮空御风'],  camera:'甩镜跟剑气＋拉远',
      scar:'整排瓦片被掀掉，露出椽木',     aftermath:'碎瓦像雨一样落满一条街' },
    // ── 以下三档就是"毁天灭地"：十米 → 百米 → 里级 ────────────────────────────
    { name:'灭世',     palette:'紫金雷',         shape:'雷柱＋冲击波环＋地裂',  scale:'12 米（一院之地·场地级）',
      light:'雷光照出长影，天色转暗',  destruction:['地面炸出浅坑','碎石成环飞散','屋瓦成片剥落','雨幕被气浪吹成扇形','院墙整面塌落'],
      camera:'仰角升镜＋全屏震＋碎片穿前景',
      scar:'院子中央留一个冒烟的坑，四周砖石呈放射状铺开', aftermath:'雨落进坑里冒白汽，碎石还在往下掉' },
    { name:'虚空',     palette:'金紫＋虚空黑',   shape:'虚空裂痕＋法相虚影',    scale:'120 米（半座山·山岳级）',
      light:'裂隙泛紫黑辉光，把山体压成暗紫', destruction:['山体被削掉一角','断崖崩落','湖泊掀起环状水墙','林海成片倒伏','云层被搅成漩涡','地面凹陷成坑'],
      camera:'大远景（人成小点）＋法相仰拍＋俯瞰整片破坏＋俯冲跟拍碎片',
      scar:'山体缺了一角、坡面露出生土、倒伏的树呈环形、湖岸留下水线', aftermath:'湖面还在晃，浪一层层拍到岸上，尘土像墙一样推过来' },
    { name:'仙侠大片', palette:'星辉金紫',       shape:'万千剑影＋百丈法相＋星河倒卷', scale:'3000 米（1~3 里·天地级）',
      light:'天地变色：白昼转暗、星辉洒满全场、光柱穿透云层', destruction:['土石浮空成环','山岳平移','江河倒卷成水墙','地裂成谷','城池屋舍成片崩塌','云层撕开成巨大漩涡'],
      camera:'天象大远景 → 法相/光柱仰拍 → 冲击波把镜头推退 → 碎片尘云穿前景 → 俯拍坑与裂谷收尾',
      scar:'地面留下数里长的裂谷与环形坑、断山缺口、倒伏林海、半塌的城郭', aftermath:'天地异象缓缓散去，尘埃落定后画面里只剩废墟与两个还站着的人' }
  ];
  const FX_STYLES = {
    realistic: { zh:'写实武侠', bonus:-2, note:'只保留肉身与兵器的真实反馈，不出现光效' },
    high:      { zh:'高武',     bonus:0,  note:'默认：气劲可见但不夸张' },
    xianxia:   { zh:'仙侠',     bonus:1,  note:'灵气／灵光／符箓上桌，隔空与异象成为常态' },
    epic:      { zh:'仙侠大片', bonus:2,  note:'必须有天地异象、法相、光柱与星河级镜头' }
  };
  function fxProfile(tier, style){
    const st = FX_STYLES[style] || FX_STYLES.high;
    const base = Math.max(1, Math.min(9, Math.round(tier || 1)));
    let lv = Math.max(1, Math.min(9, base + st.bonus));
    if (st.bonus < 0) lv = Math.min(lv, 2);   // 写实武侠：档位封顶在「好手」（只有拳风/碎石，不出现光效），否则高等级会冒出雷柱与法相
    const t = FX_TIERS[lv - 1];
    const spectacles = [];
    if (lv >= 4) spectacles.push('气劲外放');
    if (lv >= 5) spectacles.push('罡气护体');
    if (lv >= 6) spectacles.push('剑气离体', '残影');
    if (lv >= 7) spectacles.push('雷劫光柱', '天地异象');
    if (lv >= 8) spectacles.push('法相虚影');
    if (lv >= 9) spectacles.push('星河倒卷', '法则轰鸣', '万千剑影');
    return { tier:base, level:lv, style:(style||'high'), styleZh:st.zh, name:t.name,
      palette:t.palette, shape:t.shape, scale:t.scale, light:t.light,
      scar:t.scar || "", aftermath:t.aftermath || "",
      destruction:t.destruction.slice(), camera:t.camera, spectacles,
      scaleM:parseFloat(t.scale)||0, styleNote:st.note,
      // 场面规模（给提示词用）：6 档起分三级，让模型知道"该拆多大一片地方"
      cataclysm: lv >= 9 ? "天地级（里级：天象改写、法相拔地、江河倒卷、地裂成谷）"
               : lv >= 8 ? "山岳级（百米级：削山断崖、水墙、林海倒伏、云层成漩涡）"
               : lv >= 7 ? "场地级（十米级：炸坑、放射状裂纹、成排断墙、水墙掀街）" : "局部级（米级：火花、崩角、剥落）" };
  }

  // 打斗风格/套路库（h3-styles.js）：浏览器里是全局，Node 里由测试/工具 require 后挂到 globalThis
  // 惰性解析（每次调用时取）：不依赖 h3-styles.js 与 pipeline.js 的加载顺序
  const STYof = () => (typeof globalThis!=='undefined' && globalThis.H3STYLES) ? globalThis.H3STYLES : null;
  function styleParams(styleKey, tier){
    const STY0 = STYof();
    if(!STY0) return {castChanceMul:1,maxCastsMul:1,gapMul:1,linkAfterHits:2,linkChance:0.5,traitCap:5};
    // 「自动」档按等级解析：8~9 级 → 仙神斗法（法术为主·特效漫天）、7 级 → 法术为主、其余 → 近战衔接法术。
    //   用户反馈"神仙打架跟凡人差不多"，根因就是高等级也走默认的近战档。
    const key = STY0.resolveStyle ? STY0.resolveStyle(styleKey, tier) : (styleKey||'hybrid');
    const st=STY0.fightStyle(key);
    return Object.assign({key:st.key,zh:st.zh,traitCap:5},st.engine||{});
  }
  function fighter(name,kit,hp,flags,warnings){
    kit=kit||{};
    const weapon=flags.unarmed?'none':(E.WEAPONS[kit.weapon]?kit.weapon:'none');
    const w=E.WEAPONS[weapon], basic=kit.basic||{name:'普通攻击',dmg:2,range:2,interval:0.7};
    // 普攻也可以是一**套**招式（用户：「普攻就别单单只是写一个直拳……要有一套招式」）：
    //   名字里用「、」分隔（例：直拳、上勾拳、摆拳），内核会把它拆成轮换的普攻套路，每条都标 basic:true。
    const basicNames = String((kit.basic && kit.basic.name) || '普通攻击')
      .split(/[、,，/|]+/).map(x => x.trim()).filter(Boolean);
    if (basicNames.length > 1 && kit.basic) {
      kit = Object.assign({}, kit, { basic: Object.assign({}, kit.basic, { name: basicNames[0] }),
        basics: basicNames.map((nm) => Object.assign({}, kit.basic, { name: nm })) });
    }
    const compile=(s,i)=>Object.assign({},shape(s),{
      zh:s.name||'普通攻击',skillId:'skill-'+i,
      damage:finite(s.dmg,2,0,10000)*5,
      // UI range is grid units; 1 cell = 0.5m, clipped to a physical weapon envelope.
      reach:finite(s.range,2,0.1,100)*0.5/w.reach,
      cooldown:finite(s.cd==null?s.interval:s.cd,0.7,0.1,120),effect:s.effect||''
    });
    const skills=[basic].concat((kit.basics&&kit.basics.length>1)?kit.basics.slice(1).map((bb,j)=>Object.assign({},compile(bb,100+j),{basic:true,skillId:'skill-basic-'+(j+1)})):[]).concat(kit.attack||[]).filter(s=>{
      if(/摔|擒|锁喉/.test((s.name||'')+(s.effect||''))){ warnings.push(name+'：擒拿/摔投未实现，跳过「'+s.name+'」'); return false; }
      if(flags.noLeg&&/扫|踢|腿/.test((s.name||'')+(s.effect||''))) return false;
      return true;
    }).map(compile);
    if(!skills.length) throw Error(name+'：没有可执行的近战招式，请添加普通攻击或攻击招式。');
    skills.forEach(s=>{const old=s.reach;s.reach=Math.max(0.5,Math.min(1.3,s.reach));if(old!==s.reach) warnings.push(name+'：「'+s.zh+'」射程按近战兵器范围限幅');});
    for(const g of ['move','defense']) if((kit[g]||[]).length) warnings.push(name+'：'+({move:'自定义身法',defense:'自定义防御'}[g])+'尚未执行；轻功/踏墙/飞行由武力等级自动解锁，卡片里的自定义身法招式不参与结算，保留原卡供查阅');
    // 「法术」组：编译成远程施法（不必贴脸）。射程按「格→米」换算，并在 compile() 里随双方较高等级放大。
    const tier=finite(kit.tier,1,1,9);
    // 专飞角色（2026-10-01）：卡片勾「专飞（御空打斗）」＝机动按御空飞行档（≥7 级）结算，证据与提示词同步写明
    const fly=!!kit.fly;
    const mobTier=fly?Math.max(7,tier):tier;
    const qi=qiProfile(tier);
    // ── 角色套路（2026-09-25）：主战方式（primary）+ 衔接招式（link）+ 神通（traits）──
    //   primary/link 决定"这个人主要怎么打、什么时候换招"；卡里没写就看套路档案（按角色名匹配）。
    //   必须放在法术前：衔接招式要并进施法池（linkOnly）才能真的被放出来。
    const _STY = STYof();
    const pat = _STY ? (kit.pattern ? _STY.pattern(kit.pattern) : _STY.patternOf(name)) : null;
    const _nm=(arr)=>((arr||[]).map(x=>(typeof x==='string'?x:(x&&(x.name||x.zh))||'')).filter(Boolean));
    const primary=(kit.primary&&kit.primary.length?_nm(kit.primary):(pat?pat.primary.map(m=>m.name):[])).slice();
    // 衔接招式要保留**定义**（射程/伤害/冷却），不能只留名字——下面要并进施法池才能真的放出来
    const linkDefs=(kit.link&&kit.link.length?kit.link:(pat?pat.link:[])).filter(Boolean);
    const linkNames=(linkDefs.length?_nm(linkDefs):[]).slice();
    const traits=_STY?_STY.traitsOf(kit.traits&&(kit.traits.length||kit.traits.traits)?kit.traits:(pat?pat.traits:[])):[];
    let spellSrc=(kit.spell||[]).slice();
    // 卡片没配（或配得太少）时，按等级自动补内力外放技——否则高等级只会平A
    if(qi.spells.length&&spellSrc.length<2){
      const need=2-spellSrc.length;
      spellSrc=spellSrc.concat(qi.spells.slice(0,need).map(s=>({name:s[0],range:s[1],dmg:s[2],cd:s[3],effect:s[4],auto:true})));
      warnings.push(name+'：卡片「法术」组只有 '+((kit.spell||[]).length)+' 条，已按 '+tier+' 级内力档自动补入：'+
        spellSrc.slice(-need).map(s=>s.name).join('、')+'（'+qi.label+'；可在角色卡里替换）');
    }
    const spells=spellSrc.map((s,i)=>({
      id:'spell-'+i, zh:s.name||('法术'+(i+1)),
      reachCells:finite(s.range,4,0.5,100),
      damage:finite(s.dmg,4,0,10000)*5,
      cd:finite(s.cd==null?s.interval:s.cd,1.4,0.2,120),
      effect:s.effect||'', auto:!!s.auto
    }));
    // 衔接招式并进施法池，但标 linkOnly：内核只在「机会窗口」（连招段数≥1 或连中 linkAfterHits 下）放它，
    //   普通施法池里排除——否则「重剑挥砍 → 黯然销魂掌」会变成"整片都在拍掌"，主次写反。
    //   名字已经在「法术」组里的（如洪七公的龙形气劲）不重复添加，仍按普通法术+机会窗口两条路走。
    linkDefs.filter(l=>(l.name||l.zh)&&!spells.some(s=>s.zh===(l.name||l.zh))).forEach((l,i)=>{
      spells.push({ id:'link-'+i, zh:l.name||l.zh,
        reachCells:finite(l.range,3,0.5,100),
        damage:finite(l.dmg,4,0,10000)*5,
        cd:finite(l.cd==null?l.interval:l.cd,3.0,0.4,120),
        effect:l.effect||'', auto:false, linkOnly:true });
    });
    // ── 角色套路收尾：套路档案命中时给一条可核对的提示 ──────────────────────
    if(pat&&warnings) warnings.push(name+'：套用角色套路档案「'+pat.zh+'」——主战 '+primary.join('、')
      +(linkNames.length?('；衔接 '+linkNames.join('、')):'')+(traits.length?('；神通 '+traits.map(t=>t.zh).join('、')):''));
    if(fly&&warnings) warnings.push(name+'：已勾「专飞（御空打斗）」——机动按御空飞行档（'+mobTier+' 级）结算：真悬停、空中招数、滞空预算按飞行档给，全程可在空中缠斗');
    return {name,tier,fly,style:kit.style||'calm',weapon,hp:finite(hp,5,0.1,10000)*20,skills,spells,
      // 主战/衔接/神通：内核照着结算，提示词照着写
      primary,link:linkNames,traits,pattern:pat?pat.key:null,patternZh:pat?pat.zh:null,
      sp: kit.sp || styleParams(kit.fightStyle, tier),
      // 内力外放档（命中瞬间的气劲半径与额外击退；1~2 级为 0＝纯肉身）
      qi:{label:qi.label,burst:qi.burst,kb:qi.kb,castBonus:qi.castBonus},
      // 机动档：等级解锁的"能不能飞"（供证据与提示词引用）；专飞角色按御空飞行档导出
      mobility:E.mobility(mobTier)};
  }
  function compile(cfg,seed){
    if(!Number.isFinite(+cfg.duration)||+cfg.duration<=0) throw Error('成片时长必须大于0');
    // ── 内核时钟＝用户填的「视频时长」（2026-09-30 修）─────────────────────────
    //   用户反馈：「这打斗我设置15秒，为什么素材提示词会跑到30秒？」
    //   根因：这里**无条件写 duration:30**，界面填 15 秒也照样开 30 秒的窗口跑满；
    //   而片长又按"内核实测"取（1:1 口径，见 filmLengthOf）→ 填 15 秒出 30 秒素材。
    //   现在：填多少秒＝内核结算多少秒（KO 了就按实测更早收尾；打不完就按时限判定，
    //   素材里会给出「时间到判定」的收尾口径，见 packet().timeoutNoteZh）。
    const simSec = Math.max(1/60, Math.min(120, +cfg.duration));
    if(!Number.isInteger(seed)||seed<0||seed>4294967295) throw Error('随机种子须为0至4294967295的整数');
    const parsed=rules(cfg.rules),warnings=parsed.report.filter(r=>r.status==='unmapped').map(r=>'未识别规则：'+r.text);
    if(cfg.forced&&cfg.forced!=='auto') warnings.push('3D模式按真实结算判定胜负，不执行指定赢家。');
    const scen=E.scenario(cfg.scenario);
    if(cfg.scenario&&!E.SCEN[cfg.scenario]) warnings.push('未识别的打斗情景「'+cfg.scenario+'」：内核按通用场地（无掩体/无边界/无湿滑）结算。');
    // A/B 先建（只依赖角色卡），场地尺寸依赖双方等级
    // 打斗风格（近战对拼/法术为主/近战衔接法术/空战/游走/仙神斗法）：'auto' 时按双方较高等级自动选
    const _tier0=Math.max(1,Math.min(9,Math.max(+((cfg.kitA||{}).tier)||1, +((cfg.kitB||{}).tier)||1)));
    const _sp=styleParams(cfg.fightStyle, _tier0);
    const _ka=Object.assign({},cfg.kitA,{fightStyle:cfg.fightStyle}),_kb=Object.assign({},cfg.kitB,{fightStyle:cfg.fightStyle});
    const A=fighter(cfg.nameA,_ka,cfg.hpA,parsed.flags,warnings),B=fighter(cfg.nameB,_kb,cfg.hpB,parsed.flags,warnings);
    // ── 场地：UI 的单位是「格」（1 格 = 0.5 米），并按双方较高等级放大 ──────────
    // 与指南的场地表一致：1 级 = 输入值，9 级 = 输入值×9。旧版 3D 直接把输入当米、
    // 且完全没放大，所以"场地没按规划来"、高度也装不下浮空。
    const CELL=0.5;
    const Lmax=Math.max(A.tier,B.tier);
    const casters=[A,B].filter(F=>F.spells.length);
    const planW=finite(cfg.duelW,26,3,400)*Lmax*CELL;
    const planH=finite(cfg.duelH,26,3,400)*Lmax*CELL;
    const zIn=finite(cfg.duelZ,0,0,40);
    const planZ=(zIn>0?zIn:2)*Lmax*CELL;
    const MINW=8,MINH=5;                                   // 内核可用下限：分离/掩体/擂台都要空间
    let w=Math.max(planW,MINW),h=Math.max(planH,MINH);
    if(planW<w) warnings.push('场地 X 按规划为 '+planW.toFixed(1)+' 米（'+finite(cfg.duelW,26,3,400)+'格×'+Lmax+'级），低于内核可用下限，已抬到 '+w+' 米。');
    if(planH<h) warnings.push('场地 Y 按规划为 '+planH.toFixed(1)+' 米，低于内核可用下限，已抬到 '+h+' 米。');
    if(cfg.scenario==='chase'&&w<16){ w=16; warnings.push('追逐战需要长街跑道，场地 X 已抬到 16 米。'); }
    // 开场间距也是「格」：1 格 = 0.5 米
    const dist=Math.min(Math.max(1.5,finite(cfg.startDist,2,1,5)*Lmax*CELL),Math.max(1.5,w-1.4));
    Object.assign(A,{x:w/2-dist/2,y:h/2});Object.assign(B,{x:w/2+dist/2,y:h/2});
    // 高度：按规划，但必须装得下本场最高机动档（否则高等级会撞到看不见的天花板）
    const topTier=Lmax;
    const needZ=(topTier>=7?E.mobility(topTier).hover+1.5:(topTier>=3?3.0:1.6));
    const arenaZ=Math.min(60,Math.max(planZ,needZ,cfg.scenario==='aerial'?7:0));
    // 法术/内力技射程定稿：格 → 米，随等级放大但有**上限**——不超过场地对角线的 62%，
    // 免得高等级站在场地一头隔空轰、武打变成纯对轰（用户反馈过这个）。
    const diag=Math.hypot(w,h);
    for(const F of [A,B]) F.spells=(F.spells||[]).map(s=>Object.assign({},s,{
      reach:+Math.min(s.reachCells*CELL*Math.min(3,1+(Lmax-1)*0.22),diag*0.62).toFixed(2)
    }));
    if(casters.length) warnings.push('本场有法术/内力外放（按角色卡「法术」组远程释放，射程随等级放大、上限为场地对角线的 62%）：'+casters.map(F=>F.name+' '+F.spells.map(s=>s.zh+' '+s.reach+'米').join('、')).join('；'));
    if(arenaZ>planZ+0.01) warnings.push('场地高度按规划为 '+planZ.toFixed(1)+' 米（'+((zIn>0?zIn:2))+'格×'+Lmax+'级），装不下本场机动档（需 '+needZ.toFixed(1)+' 米），已抬到 '+arenaZ.toFixed(1)+' 米。');
    // 特效分级（等级 × 风格档）：写进证据、供提示词照实写、也决定 3D 白膜怎么画
    const fx=fxProfile(Lmax,cfg.fxStyle);
    Object.assign(A,{fx:fx});Object.assign(B,{fx:fx});
    if(!cfg.fightStyle||String(cfg.fightStyle)==='auto') warnings.push('打斗风格＝自动：按本场最高武力 '+_tier0+' 级 → 「'+_sp.zh+'」'+
      (_tier0>=8?('（8 级以上默认仙神斗法：法术为主、蓄力×'+( _sp.chargeMul||1)+'、特效密度×'+(_sp.fxDensityMul||1)+'）'):'')+'；可在左侧「打斗风格」里换成其它档。');
    warnings.push('打斗风格「'+_sp.zh+'」：施法概率×'+_sp.castChanceMul+'、每场法术上限×'+_sp.maxCastsMul
      +'、衔接阈值 '+( _sp.linkAfterHits||2)+' 下、神通总上限 '+(_sp.traitCap||5)+' 次（可在左侧「打斗风格」里换）。');
    if(fx.style!=='high') warnings.push('特效风格「'+fx.styleZh+'」：本场按 '+fx.level+' 档特效呈现（最高武力 '+Lmax+' 级，风格档 '+(fx.bonus>0?'+':'')+fx.bonus+'）——'+fx.palette+'／'+fx.shape+'／'+fx.scale+'；'+fx.styleNote+'。');
    return {source:JSON.parse(JSON.stringify(cfg)),seed:seed>>>0,duration:simSec,arena:{w,h,z:arenaZ},A,B,rules:parsed.flags,ruleReport:parsed.report,warnings,fx:fx,fightStyle:_sp,
      scenario:scen.key,scenarioZh:scen.zh,arenaPlan:{cells:{w:finite(cfg.duelW,26,3,400),h:finite(cfg.duelH,26,3,400),z:(zIn>0?zIn:2)},level:Lmax,metres:{w:+planW.toFixed(2),h:+planH.toFixed(2),z:+planZ.toFixed(2)},startDistM:+dist.toFixed(2)},
      speed:cfg.speed==='fast'?1.25:cfg.speed==='slow'?0.8:1};
  }
  function packet(result,cfg){
    // All events retained. Full 60Hz frames stay in archive; event keyframes +
    // 1Hz trajectories are sent to AI, without inventing collision locations.
    const frames=result.frames||[];let at=0;
    const events=result.events.map((e,i)=>{
      while(at+1<frames.length&&frames[at+1].t<=e.t+0.001) at++;
      const f=frames[at];
      return {id:i,...e,pose:f?{A:f.A,B:f.B}:null};
    });
    const p = {schema:'combat-evidence/1',seed:result.seed,simulationSeconds:result.duration,
      targetSeconds:cfg.duration,timeMap:'filmTime = simulationTime / simulationSeconds * targetSeconds',
      winner:result.winner,finish:result.summary.finish,
      // 情景：内核真的算了什么（掩体/边界/追逃/湿滑），提示词要按这个写
      scenario:result.scenario?{key:result.scenario.key,zh:result.scenario.zh,aerial:result.scenario.aerial,water:result.scenario.water,
        slick:result.scenario.slick,startZ:result.scenario.startZ,ring:result.scenario.ring?{r:+result.scenario.ring.r.toFixed(2)}:null}:null,
      props:result.props||[], chase:result.chase||null,
      // 特效分级：等级 × 风格档 → 配色／形状／体量／光照后果／环境破坏／镜头反馈（提示词按这个写）
      fx:(result.fx||fxProfile(Math.max((result.A&&result.A.tier)||(cfg.kitA&&cfg.kitA.tier)||1,
                                        (result.B&&result.B.tier)||(cfg.kitB&&cfg.kitB.tier)||1), cfg.fxStyle)),
      counts:{hits:result.summary.hits,blocks:result.summary.blocks,dodges:result.summary.dodges,
        clashes:result.summary.clashes,guardBreaks:result.summary.guardBreaks,ko:result.summary.ko,
        obstaclesBroken:result.summary.obstaclesBroken,obstacleHits:result.summary.obstacleHits,ringOuts:result.summary.ringOuts,
        slips:result.summary.slips,splashes:result.summary.splashes,takeoffs:result.summary.takeoffs,landings:result.summary.landings,
        airHits:result.summary.airHits,maxZ:result.summary.maxZ,
        wallRuns:result.summary.wallRuns,wallKicks:result.summary.wallKicks,hovers:result.summary.hovers,hoverSeconds:result.summary.hoverSeconds,
        spellCasts:result.summary.spellCasts,spellHits:result.summary.spellHits,spellFades:result.summary.spellFades,
        castsStarted:result.summary.castsStarted||0,castsDone:result.summary.castsDone||0,
        chargeSeconds:result.summary.chargeSeconds||0,wardHolds:result.summary.wardHolds||0,
        fxEvents:(result.summary.auras||0)+(result.summary.qiBursts||0)+(result.summary.phenomena||0)+(result.summary.afterimages||0)+
                 (result.summary.spellCasts||0)+(result.summary.spellHits||0),
        qiBursts:result.summary.qiBursts||0,auras:result.summary.auras||0,
        linkCasts:result.summary.linkCasts||0,traits:result.summary.traits||0,clones:result.summary.clones||0,
        spellAfter:result.summary.spellAfter||0,spellAbsorbed:result.summary.spellAbsorbed||0,
        spellGuards:result.summary.spellGuards||0,wardBroken:result.summary.wardBroken||0,
        wardHolds:result.summary.wardHolds||0,groundScars:result.summary.groundScars||0,
        afterimages:result.summary.afterimages||0,phenomena:result.summary.phenomena||0},
      characters:{A:result.A,B:result.B},
      scene:cfg.scene,appearance:{A:cfg.descA,B:cfg.descB},events,
      trajectory:frames.filter((f,i)=>i%60===0||i===frames.length-1),warnings:(result.warnings||[]).filter(w=>!w.startsWith('未识别规则：')),unmappedRuleCount:(result.ruleReport||[]).filter(r=>r.status==='unmapped').length,
      note:'Coordinates are metres: x/y ground, z height. z>0 means airborne; the mobility ladder is tier-gated (tier 1-2 ground, 3-4 leap, 5-6 wall-kick, 7-9 true flight with hover and landing shockwave). The scenario is simulated, not decorative: field/chase have solid breakable cover, arena has a ring boundary (going out = ring-out), aerial starts everyone airborne, water makes the ground slick (slip/splash). Contact height is a band, not an anatomical wound. Dodge events record attempts, not guaranteed success.'};
    // 走位表（staging）：逐拍的空间读数（谁在画面哪一侧、隔多远、多高、朝哪）——随证据一起给模型，
    //   模型照抄就能守住定位；不给的话它会自己编位置，于是出现"人乱飘／换人／少一个人"。
    const _st = stagingRows(result, cfg);
    if (_st.length) {
      // 走位表也**不写坐标**（用户：「先取消用 XYZ 去控制角色方式吧」）：只留相对位置读数，
      //   内核坐标仍在（判定/画面/走位用它），但不进给模型的素材。
      const _BEAR = { front: '正', back: '后', left: '左', right: '右' };
      const _rel = (x) => ({ side: x.side, depth: x.depth, stance: x.stance, height: x.height,
        bearing: _BEAR[x.bearingToB] || _BEAR[x.bearingToA] || '正',
        facing: (x.faceToB === false) ? '侧/背对' : '正对', hp: x.hp });
      p.staging = _st.map((x) => ({ t: x.t, dist: x.dist, steps: steps(x.dist), A: _rel(x.A), B: _rel(x.B) }));
      p.stagingLegend = STAGE_LEGEND;
      p.stagingNoteZh = '【走位表 · 相对位置读数】下面是本场逐拍的空间读数（每 0.5 秒一行，另外每次命中／起跳／落地／切镜点都有一行）；'
        + '每行给出**画面左右、离镜头远近、姿态、离地高度、相对对手的方位与两人间距（米＋步）**——写动作时照着抄。'
        + '**不要写坐标**（视频模型对 (x,y,z) 不敏感，写了只是噪音）：位置一律用方位词＋距离词描述。'
        + '写每一拍时**照抄这一拍的位置**：谁在画面哪一侧、谁更靠近镜头、相距几米（约几步）、离地多高、在对手的哪一侧。'
        + '位置要变必须写出变化过程（垫步／绕步／后跃／被击飞／落地滑步）与移动了多远，**不许瞬移、不许在镜头里消失、不许换人、不许出现第三个人**；'
        + '每个镜头都必须能读到两人，若只拍一人必须交代另一人的去向（被打飞出画／在画面边缘／在背景）与回来的时机。约定：' + STAGE_LEGEND + '\n'
        + _st.slice(0, 90).map((x) => stageLine(x, result, false)).join('\n');
    }
    // 招式具名形态（2026-09-24）：本场两人的招式 → 该出什么形（金龙／掌印／剑气…），并按本场特效档给体量与停留。
    //   照 B站「免费全能打斗Skill·降龙十八掌」那两期的做法：让观众"认出这是哪一招"，靠的就是具名形态。
    //   库里没配 h3-forms.js 时静默跳过（旧壳仍能跑），配了就一定写进证据。
    // 打斗风格 + 角色套路 + 神通（2026-09-25）：证据里给"本场按什么风格打、每个人主战什么/衔接什么/有什么神通"
    const STY = STYof();          // 证据生成时再取一次（同样不依赖加载顺序）
    if (STY) {
      // 风格键的三种来路都认：① 内核结算结果里的已解析风格 ② 编译结果（cfg.fightStyle 是对象）
      //   ③ 原始配置（cfg.fightStyle 是字符串）/ 编译结果里的 source。少了任何一路都会"选了风格却没生效"。
      const _fq = (cfg && cfg.fightStyle) || (cfg && cfg.source && cfg.source.fightStyle) || 'hybrid';
      const key = (result.fightStyle && result.fightStyle.key)
        || (typeof _fq === 'string' ? _fq : (_fq.key || 'hybrid'));
      p.fightStyle = { key: key, zh: (STY.fightStyle(key) || {}).zh, ratio: (STY.fightStyle(key) || {}).ratio };
      p.styleNoteZh = STY.styleRule(key, true);
      // ⚠ result.A 只是结算摘要（没有 primary/link/traits）→ 优先取编译结果的已解析套路，
      //   再退回原始角色卡（调用方可能直接给角色卡，也可能给 compile() 结果，两种都认）。
      const _ksrc = (cfg && (cfg.kitA || cfg.kitB)) ? cfg : ((cfg && cfg.source) || {});
      const _nm2 = (arr) => ((arr || []).map(x => (typeof x === 'string' ? x : (x && (x.name || x.zh)) || '')).filter(Boolean));
      const _pats = [
        { name: _ksrc.nameA || (result.A && result.A.name) || 'A', c: (cfg && cfg.A) || null, kit: _ksrc.kitA || null, r: result.A || null },
        { name: _ksrc.nameB || (result.B && result.B.name) || 'B', c: (cfg && cfg.B) || null, kit: _ksrc.kitB || null, r: result.B || null }
      ].map(x => {
        const c = x.c || {}, k = x.kit || {}, r = x.r || {};
        const prim = _nm2(c.primary).length ? _nm2(c.primary) : _nm2(k.primary);
        const link = _nm2(c.link).length ? _nm2(c.link) : _nm2(k.link);
        const tr = (c.traits && c.traits.length) ? c.traits : (k.traits || []);
        const pk = c.pattern || k.pattern || r.pattern || (STY.patternOf ? ((STY.patternOf(x.name) || {}).key || null) : null);
        return { name: x.name, pattern: pk, patternZh: c.patternZh || k.patternZh || null, primary: prim, linkNames: link, traits: tr };
      });
      const _pr = STY.patternRule(_pats, true);
      if (_pr) { p.patterns = _pats; p.patternNoteZh = _pr; }
      const _tr = STY.traitRule(_pats, true);
      if (_tr) { p.mythicNoteZh = _tr; }
    }
    // ── 特效清单 + 施法时间（2026-09-25 用户要求）────────────────────────────
    //   用户原话：「这神仙打架怎么跟凡人差不多，高等级的人物打架要法术为主，特效漫天飞，要写入大量特效的提示词。
    //             而且要给足法术施法时间。」——所以这里把"本场要写到几件具名特效、每件怎么写、蓄力多久"做成素材。
    //   数据源：h3-fx-library.js（100+ 件具名特效，形·色·量·光·破·影 + 五拍 + 蓄力 + 声音）。
    const _FX = (typeof globalThis!=='undefined' && globalThis.H3FXLIB) ? globalThis.H3FXLIB : null;
    const _STYs = STYof();
    if (_FX) {
      const _tier = Math.max((result.A && result.A.tier) || 1, (result.B && result.B.tier) || 1);
      // 口径（2026-09-30 修）：编译结果的 duration 现在**就是**用户填的片长（内核窗口＝片长），
      //   原始配置仍优先取（调用方可能只传编译结果）。
      const _sec = +((cfg && cfg.source && cfg.source.duration) || (cfg && cfg.duration)) || 15;
      // 风格键在 packet 里要自己取一次（上面那段 if(STY) 里的 key 是块级作用域，这里拿不到）
      const _fq2 = (result.fightStyle && result.fightStyle.key) || (cfg && cfg.fightStyle) || 'hybrid';
      const _skey = (typeof _fq2 === 'string') ? _fq2 : (_fq2.key || 'hybrid');
      const _n = _STYs ? _STYs.fxTargetCount(_tier, _sec, _skey) : 10;
      const _spot = _STYs ? _STYs.fxSpotlightCount(_tier, _sec, _skey) : 3;
      const _picked = _FX.pick(_tier, _n, result.seed, {});
      const _sum = result.summary || {};
      const _stats = { castsStarted:_sum.castsStarted||0, castsDone:_sum.castsDone||0, chargeSeconds:_sum.chargeSeconds||0,
        qiBursts:_sum.qiBursts||0, auras:_sum.auras||0, phenomena:_sum.phenomena||0, wardHolds:_sum.wardHolds||0 };
      const _avg = (_sum.castsStarted||0) ? (_sum.chargeSeconds||0)/(_sum.castsStarted||1) : 0;
      const _mul = (result.fightStyle && result.fightStyle.chargeMul)
        || (cfg && cfg.fightStyle && cfg.fightStyle.chargeMul) || 1;
      p.fxList = _picked.map(e => ({ zh:e.zh, en:e.en, cat:e.cat, form:e.form, tiers:e.tiers,
        sizeM:e.sizeM[_tier-1], palette:e.palette, camera:e.camera, shape:e.shape,
        beats:e.beats, charge:e.charge, sound:e.sound, scar:e.scar, light:e.light, destruction:e.destruction }));
      p.fxTargetCount = _n; p.fxSpotlight = _spot; p.fxTier = _tier;
      p.fxNoteZh = _FX.rule(_picked, true, { tier:_tier, spotlight:_spot, fxStats:_stats, budget:3600 });
      p.fxNoteEn = _FX.rule(_picked, false, { tier:_tier, spotlight:_spot, budget:3600 });
      p.chargeNoteZh = _FX.chargeRule(true, { tier:_tier, avgCharge:_avg, chargeMul:_mul });
      p.chargeNoteEn = _FX.chargeRule(false, { tier:_tier, avgCharge:_avg, chargeMul:_mul });
      p.fxLegend = 'fxList = 本场该出现的具名特效（按武力等级与打斗风格从特效仓库挑好，' + _FX.stats().total
        + ' 件里挑 ' + _picked.length + ' 件）；fxNoteZh/chargeNoteZh 是照抄用的中文素材；'
        + 'counts.spellCasts/castsDone/chargeSeconds 是内核对"施法时间"的实测（蓄力几秒、放完几次）。';
    }
    // ── 场地尺寸与**相对位置**（2026-09-25）────────────────────────────────
    //   旧口径要"每一次运动都给 XYZ 坐标"（§92），实测下来视频模型对坐标不敏感：用户原话
    //   「先取消用 XYZ 去控制角色方式吧，但是要描述清楚相对位置，感觉视频模型对这些位置坐标识别不太清楚」。
    //   现在改成**相对位置**写法：画面左右 / 离镜头远近（米）/ 纵深前后 / 两人间距（米＋步）/
    //   离地高度 / 相对对手的方位（正面·左手侧·右手侧·背后）/ 参照物（院墙、场地边缘、倒下的东西）。
    //   坐标仍然在内核里算（走位、判定、3D 画面都用它），但不再进素材、也不再要求模型照抄。
    {
      const AR = result.arena || { w: 20, h: 12, z: 6 };
      // arenaPlan 在**编译结果**上（内核结算结果不带它）：调用方可能给结算结果＋编译配置（页面就是这种），
      //   也可能直接给编译结果，两路都认，否则"格数/等级/开场间距"会静默丢掉。
      const plan = result.arenaPlan || (cfg && cfg.arenaPlan) || null;
      p.arena = { w: +(+AR.w).toFixed(1), h: +(+AR.h).toFixed(1), z: +(+AR.z || 0).toFixed(1),
        cells: plan ? plan.cells : null, level: plan ? plan.level : null, startDistM: plan ? plan.startDistM : null };
      const cellsTxt = plan ? ("（约 " + plan.cells.w + " 格 × " + plan.cells.h + " 格" + (plan.cells.z ? (" × " + plan.cells.z + " 格高") : "") + "；按武力 " + plan.level + " 级放大，1 格 = 0.5 米）") : "";
      const startTxt = plan && plan.startDistM ? ("，开场两人相距约 " + plan.startDistM + " 米（约 " + steps(plan.startDistM) + " 步）") : "";
      p.arenaNoteZh = '【场地尺寸】本场空间是 **' + p.arena.w + ' × ' + p.arena.h + ' × ' + p.arena.z + ' 米**' + cellsTxt + startTxt + '。'
        + '正文第一次写到场景时就要把这个尺寸写出来（例：' + p.arena.w + ' 米见方、' + p.arena.z + ' 米高的' + (result.scenario && result.scenario.zh ? result.scenario.zh : '场地') + '），'
        + '并交代边界在哪：贴墙、撞墙、掉台、出界都要按这个尺寸算距离——不许写出比场地更大的跑动（例如 ' + p.arena.w + ' 米的场地里"跑出百丈"）。';
      p.relPosNoteZh = '【相对位置 · 不要坐标，要拍得出来的方位】素材里所有位置都用**相对位置**描述，'
        + '写台词与动作时照抄这一套口径（**不要写 (x=…, y=…, z=…) 坐标**——视频模型对坐标不敏感，写了反而被当成噪音）：\n'
        + '· 横向：在画面左侧／中间／右侧（观众视角）；谁更靠左、谁更靠右。\n'
        + '· 纵深：更靠近镜头／同一纵深／更远离镜头（必要时给"离镜头约几米"）。\n'
        + '· 距离：两人相距几米（并给"约几步"，一步≈0.8 米）；写清距离在变（压近／拉开／持平）。\n'
        + '· 高度：脚踏实地／半蹲／腾空约几米（"约一人高"这种可比说法更好用）。\n'
        + '· 朝向与方位：正对对手／侧身／背对；自己在对手的正面／左手侧／右手侧／背后。\n'
        + '· 参照物：把位移挂到看得见的东西上（撞在左侧院墙上、退到场地边缘、从倒下的木箱后绕出）。\n'
        + '· 每一次运动（垫步、绕步、后跃、起跳、落地、被击退、法术位移）都要写**从哪边到哪边、移动了多远、离对手近了多少**；'
        + '两段润色（第1步设计稿、第2步成片提示词）都要保留这些相对位置读数，不许简化成"两人靠近"。';
      // 英文路线同款两段（页面在 EN 输出时取 *En；缺了就会"中文规则混进英文提示词"）
      p.arenaNoteEn = '[ARENA SIZE] this fight happens in a **' + p.arena.w + ' x ' + p.arena.h + ' x ' + p.arena.z + ' metre** space'
        + (plan ? (' (about ' + plan.cells.w + ' x ' + plan.cells.h + ' grid cells at tier ' + plan.level + ', 1 cell = 0.5 m)') : '')
        + (plan && plan.startDistM ? (', the two fighters start about ' + plan.startDistM + ' m apart (about ' + steps(plan.startDistM) + ' steps)') : '') + '.'
        + ' State those dimensions the first time the scene is described, and say where the boundaries are: wall contact, wall impacts, falling off the platform and ring-outs are all measured against this size - never write movement larger than the arena.';
      p.relPosNoteEn = '[RELATIVE POSITION - directions, never coordinates] describe every position relatively (do **not** write (x=..., y=..., z=...) - video models read coordinates poorly and they end up as noise):\n'
        + '- Across the frame: screen-left / centre / screen-right (who is further left).\n'
        + '- Depth: closer to camera / same depth / farther (add metres from camera when useful).\n'
        + '- Distance: metres apart plus about how many steps (1 step ~ 0.8 m), and whether it closes or opens.\n'
        + '- Height: on the ground / crouched / airborne about N m.\n'
        + '- Facing and side: squared up / side-on / back turned; in front of / on the left of / on the right of / behind the opponent.\n'
        + '- Anchors: tie movement to something visible (the wall on the left, the edge of the arena, a fallen crate).\n'
        + '- Every movement states from where to where, how far, and how much closer; keep these readings in both polish steps.';
    }
    // ── 镜头时间线（2026-09-25 用户：「动作判定的时间和镜头不太对的上，最好用 TIMELINE 的方式去控制一下」）
    //   把同一份时间线写进素材：片长=实测（1:1 时钟）、每镜起止秒与节拍、**切出时还在飞、下一镜几秒落定**的动作。
    //   分镜文本里的【本镜时间线】就是这份数据的同一份（模型两边读到的秒数完全一致，不会再拿两套时钟对不上）。
    {
      const TL = shotTimeline(result, cfg);
      const segs = shotSegments(result, cfg);
      p.shotsTimeline = segs.map((s) => ({ n: s.n, sec: [s.f0, s.f1],
        beats: s.beats.filter((b) => /^(hit|clash|guardbreak|ko|ring_out|landing|spell_hit|slam|launch|knockdown|getup)$/.test(b.type)).length,
        carry: s.carry.map((c) => c.why), resolves: s.resolves.map((x) => ({ t: x.t, n: x.n, why: x.why })) }));
      p.shotsTimelineLegend = '每镜：sec=[起,止] 秒（与动作判定同一时钟，1:1）；beats=本镜故事级节拍数；carry=切出时还在飞的动作；resolves=它在第几镜几秒落定/撞上（下一镜必须接着写完）。';
      p.timeNoteZh = '【时间基准】片长 = 内核实测时长 **' + TL.clock.filmSeconds + ' 秒**（与动作判定同一个时钟，1:1，**不拉伸**）。'
        + (Math.abs(TL.clock.requestedSeconds - TL.clock.filmSeconds) > 0.6
          ? '（界面上填的是 ' + TL.clock.requestedSeconds + ' 秒，但内核在 ' + TL.clock.filmSeconds + ' 秒就分出了胜负：片长按实测走，所以不要按 ' + TL.clock.requestedSeconds + ' 秒去摊动作。）'
          : '')
        + '所有时间码（[Shot N] 的起止、本镜节拍、事件时点）都是这一条时间线；不许把动作拉长、也不许自己另排一套时间码。';
      p.timeNoteEn = '[TIME BASE] film length = the simulated fight length **' + TL.clock.filmSeconds + ' s** (one clock with the action log, 1:1, no stretching). '
        + 'Every timecode - shot start/end, per-shot beats, event times - comes from that single timeline; never stretch the action or invent your own clock.';
      // 时间到（没打出 KO）：本场是"用户填多长就打多长"，所以打满时限时素材必须按"时间到"收尾——
      //   2026-09-30 起内核窗口＝片长（见 compile），15 秒的场次很容易在时限内打不完，
      //   于是要明确禁止润色自己编 KO/倒地/胜者收势，并给出"想掉血掉干净该调什么"。
      p.timeOut = !(result.summary && result.summary.finish);
      if (p.timeOut) {
        const _hpPct = (F) => Math.round(100 * ((F && F.hp) || 0) / Math.max(1, (F && F.hpMax) || 1));
        // 收尾那一帧两人各自的真实状态：素材的最后一拍必须照着写（不许自己补一个"收势"）
        const _END_ZH = { idle: '站定收势', move: '正在走位', attack: '正在出招（这一招没做完）', dodge: '正在闪避',
          cast: '正在施法/蓄力', block: '正在招架', hitstun: '正吃着硬直', stagger: '正踉跄未稳',
          down: '正躺在地上（还没起身）', getup: '正撑地起身', takeoff: '刚起跳', land: '刚落地（余波中）' };
        const _fr = (result.frames && result.frames.length) ? result.frames[result.frames.length - 1] : null;
        const _endOf = (side, F) => {
          const st = _fr && _fr[side] ? _fr[side].st : null;
          const zh = st ? (_END_ZH[st] || st) : '';
          const tech = (_fr && _fr[side] && _fr[side].tech) ? ('：' + _fr[side].tech) : '';
          return ((F && F.name) || side) + ' ' + (zh || '交手中') + tech;
        };
        p.timeoutNoteZh = '【收尾口径 · 时间到判定】本场打满 ' + TL.clock.filmSeconds + ' 秒**还没人被打倒**（剩血 '
          + ((result.A && result.A.name) || 'A') + ' ' + _hpPct(result.A) + '%、' + ((result.B && result.B.name) || 'B') + ' ' + _hpPct(result.B) + '%）：'
          + '最后一拍就收在这一帧的真实状态上 —— ' + _endOf('A', result.A) + '；' + _endOf('B', result.B) + '。'
          + '**不许写 KO、不许写倒地不起（除非上面就写着躺在地上）、不许写胜者收势抱拳**；没做完的那一招就停在没收完的样子。'
          + '想让片子里真的打出 KO：把「血量」调低（同级对决通常要 18~28 秒才打倒），或把「视频时长」加长。';
      }
    }
    // ── 用户选的运镜 / 镜头艺术（2026-09-30）─────────────────────────────────
    //   用户：「我换了运镜方式，和镜头风格这些，怎么都完全展示不出来效果，这些运镜特别在最终提示词中要描述的。」
    //   素材里把"这一场用哪套运镜"写成硬要求，分镜抬头的那句运镜也已经换成他选的那套（见 shotBlocks 的 CAMP）。
    {
      const CAMP = cameraPlan(cfg);
      if (CAMP.active) {
        p.cameraPlan = { mode: CAMP.mode, camEn: CAMP.camEn, camZh: CAMP.camZh, lensZh: CAMP.lensZh,
          lensEn: CAMP.lensEn, lensDesc: CAMP.lensDesc, custom: CAMP.list, seqZh: CAMP.seqZh, seqEn: CAMP.seqEn };
        p.cameraNoteZh = CAMP.noteZh;
        p.cameraNoteEn = CAMP.noteEn;
      }
    }
    // ── 专属技能 / 大招清单（2026-09-30）──────────────────────────────────────
    //   用户：「一些技能释放和大招 SKILL，能不能学习一下这些 UP 的 SKILL」——页面用 h3-skills.js
    //   从角色卡推导出专属技能（含大招），这里原样带进素材：名字/属性/五拍/施法时间/镜头/音效/留痕都齐，
    //   并要求分镜把大招那一拍写满。没生成过就是空串（素材一字不变）。
    {
      const _src = (cfg && (cfg.skillNoteZh || cfg.skillNoteEn)) ? cfg : ((cfg && cfg.source) || cfg || {});
      const _zh = _src.skillNoteZh, _en = _src.skillNoteEn;
      if (_zh) p.skillNoteZh = String(_zh) + '\n**分镜要求**：本场大招必须**占满一整拍**——蓄力（写出秒数、有先兆）→ 释放（满屏光彩）→ 命中（KO 级破坏或极重受力）→ 收势（留痕跨镜）；招式名照抄，不许换成"一记重拳"。';
      if (_en) p.skillNoteEn = String(_en) + '\nThe ULTIMATE must own a full beat in the shot list (wind-up with seconds -> screen-filling release -> impact -> settle), using the given names verbatim.';
    }
    // ── 打戏铁律（2026-09-30）：吸收公开的武打/玄幻打斗 SKILL 里**可机械判定**的那几条 ──────────
    //   来源参考（开源）：xuanhuan-combat-director 的「核心铁律与实战防穿帮协议」——
    //   它的痛点描述与本程序实测到的问题完全一致（模型把"双手横架"画成 3 秒静止推刀、把抽象比喻画成朝天放烟花、
    //   大爆炸后在坑沿凭空刷一个跪地的对手、结尾两人贴脸堆叠）。这里把它落成本场的**硬要求**，
    //   并由 h3lint.js 做机械检查（state-verb / abstract-fx / engine-tag / face-off-ending）。
    {
      const LAW_ZH = [
        '【打戏铁律 · 本场必须逐条落实】（吸收公开武打 SKILL 的可判定条款；体检会按这些条抓稿子）',
        // ⚠ 每条以「·」开头：体检的素材剥离规则会把「【…】标题 + 紧跟的 · 子行」整块剥掉，
        //   否则铁律块自己列着"禁止双手横架／鱼群星河／模式K"，会被自己证明自己（实测误报三条）。
        '· **节拍颗粒度**：每 2~3 秒（最多 4 秒）为一个节拍，一个节拍只写 **[1 个机位景别] + [1 个瞬态核心招式] + [1 个即时受力回执]**——3 秒里塞十来个微操，模型会直接摆烂成"架刀发呆互推"。节拍是**时间上的分段**，仍然可以在同一个镜头内用运镜完成（切镜只在段与段之间）。',
        '· **瞬态动词，禁长时状态**：禁止"两手横着封死／对撞后定格／长时间相持／刀压刀角力／脸对脸"这类**长时状态**写法——模型会把它们画成 3 秒静止；改用「劈中即分／震退即变招／侧身滑步避开／借反弹力暴退／反手挑刺／中拳滑退」。',
        '· **特效强动宾化**：禁止无受力实体的抽象比喻（"无数把剑像鱼群一样铺开""三百米血月巨刃"会被画成朝天放烟花）；必须写清物理矢量：**谁、从哪、往哪、多快、扎向对手哪个部位**（例：「无数柄寒光飞剑自天穹垂直俯冲突刺，迎头扎向刀客头顶」）。',
        '· **双向受力（一轮互殴必须双方同时受创）**：贴身缠斗里写"A 一肘砸碎 B 的护甲"的同时，必须写 B 的反击打到 A 身上（如"B 一膝顶中 A 腹部，两人同时形变、同时震退"）；禁止一方永远只挨打。',
        '· **严禁假攻击**：对手的每一次出招都要有**受力回执**——护甲崩裂、骨骼震颤、滑退数米、撞裂石壁；不许写成"被轻松闪过／只划开一道白痕"。',
        '· **开局不试探**：第一拍就要双方**同框中近景**，并尽快出现一次两种对立招式的正面硬撞（快速抢身位、兵器先碰）；不许先来一段空镜或环境慢热。',
        '· **节奏呼吸**：同一种节奏不要连续超过 5 秒；高频密集攻击之后接一次极短的**微慢镜**（0.3~0.5×、约 0.2 秒，**不要定格/冻帧**）；同一运镜不要连续用超过 2 秒、同一景别不要超过 3 秒——**用运镜变化满足，不必切镜**。',
        '· **命中与击飞是同一拍**：被打飞的人**在被击中的那一瞬就离地**（这是这一下的直接延续），不是先站定/停顿再"起飞"；同样地，**命中不要定格**——特写也用慢放（0.3~0.4×、0.15~0.25 秒）把这一下拍完，画面要一直在动。',
        '· **情绪拐点**：片长后半程（约 55%~75% 处）必须有一次战局急转或破招反杀，让节奏弹起来。',
        '· **终帧原则**：**禁止平缓收尾**（慢慢收刀入鞘、微风吹发丝、气焰和平消散）；最后一帧要是最燃的那一瞬（绝杀命中／法相崩裂／冲击波横扫），**并且画面仍在运动**——不要收成静止摆拍。',
        '· **收尾四协议，任选其一，禁贴脸堆叠**：A 遗物定场（败者坠入坑底，前台只留一柄斜插的断裂残兵＋胜者背影）；B 物理抛飞隔离（败者被横向轰飞嵌进远景山壁，前后景拉开几十倍纵深）；C 光粒解构（贯穿瞬间败者化作属性光粒倒卷升空消散）；D 反向错车硬切（交错斩击后两人背向掠出画框左右两端，在极速动态中硬切）。**不要把两个人收在画面中心贴着脸角力**，也不要在爆炸后在坑边凭空"刷新"一个跪着的对手（按 A／B／C 锁死败者在哪）。',
        '· **架式按兵器分家（不是人人一套拳击抱架）**：徒手（非擂台）＝武术起手架——前手立掌护中线、后手虚握收肋前、两肘下垂护肋；擂台徒手才用散打/拳击架（后手护颌）；短兵器＝持械架——前手持械前指、尖锋指着对手；长兵器（枪棍）＝双手持械架——前手前握、后手握柄尾收腰侧、械尖指向对手眉心。**禁止把双拳并拢端在胸口／抱在脸前**（那是拳击抱架，器械场与武术场不摆这个）。',
        '· **防御要写手法与卸力，不是抱头硬扛**：格挡必须写清用**哪个部位或兵器的哪一段**去挡（前臂外侧／前臂内侧／掌根拍击／兵器中段横架／格／挂／拨／云），以及力往哪卸、重心怎么坐；闪避必须写清是哪一种（侧闪／后仰摇闪／下潜／绕步换角度／撤步拉开）与让开了哪条线。**禁止双拳抱住脸硬扛、抱着头挨打**；每一次防御都要在 0.2~0.8 秒内接反击或抢位。',
        '· **特写口径＝整个人物的招式特写**：凡写「特写」都是**整个人物（头顶到脚）＋招式动作＋技能特效同框**，人物占画幅约三分之一到一半；禁止大头／脸部／手部／兵器／接触点的局部大特写——写「大特写」「fills half the frame」模型只会交一颗大头。特效可以铺满画幅，但不许盖住人物的全身轮廓。',
        '· **推拉摇移是摄影机在动**：写急推／拉近／拉远／甩镜／变焦时，必须同时写明「人物位置不变」——人的画面位置、大小与朝向只能因为他自己的步法／起跳／被击飞而变；不许靠移动或缩放人物来「实现」镜头运动（那就是观众眼里的瞬移）。',
        '· **正文不许出现工程标记**：这些标记模型看不懂还会占注意力，一律写成人话（素材里可以写，正文里不要）。'
      ].join('\n');
      const LAW_EN = [
        '[FIGHT LAWS - apply every line; the linter checks these]',
        '· Beat granularity: 2-3 s per beat (4 s max); one beat = ONE shot size + ONE transient core technique + ONE immediate impact receipt. Ten micro-actions inside 3 s collapse into "two men leaning on their blades".',
        '· Transient verbs only: never prolonged holds (locked blades for seconds, freezing on contact, a long shoving match, face to face); use "breaks apart on the hit / retreats and switches technique / slides aside / borrows the rebound / reverse stab".',
        '· Effects need a physical verb: no abstract metaphors; state WHO, FROM WHERE, TO WHERE, HOW FAST, and WHICH BODY PART it lands on.',
        '· Mutual force: whenever A lands a blow, B must land one too in the same beat - never a one-sided punching bag.',
        '· No fake attacks: every attack must leave a receipt (armour cracks, bones shake, sliding back metres, wall shattered).',
        '· No probing opener: both fighters framed together in a medium shot immediately, first clash within the first second.',
        '· Breathing rhythm: never hold one tempo past 5 s; follow dense bursts with a short micro slow-motion (0.3-0.5x for about 0.2 s, never a freeze frame); no camera move past 2 s, no shot size past 3 s - satisfy this by moving the camera, not by cutting.',
        '· The hit and the launch are the same beat: whoever is struck leaves the ground on the very frame of the hit (it is the direct continuation of that blow), never after a pause. Never freeze on impact either - shoot close-ups with slow motion (0.3-0.4x for 0.15-0.25 s) so the action keeps moving.',
        '· Turn point: one reversal or counter-kill in the back half (55-75% of the film).',
        '· Final frame: never a soft landing (sheathing the sword, breeze in the hair) - the last frame must be the hottest instant (the kill, the shattering form, the sweeping shockwave) and the picture must still be moving, never a static pose.',
        '· Pick ONE ending protocol and lock it: A relic-and-crater (loser stays in the pit, only a broken weapon in the foreground), B blast-isolation (loser hurled into a far wall, foreground and background separated), C light-particle dissolution, D cross-past hard cut (both exit frame in opposite directions and the film hard-cuts). Never settle into a centre-frame blade-to-blade stalemate, and never spawn a kneeling loser back at the crater rim.',
        '· Stances are per weapon, not one boxing guard for everyone: unarmed outside a ring = martial ready stance (lead hand open on the centre line, off hand loose at the ribs, elbows down guarding the ribs); the sanda/boxing guard (rear hand at the jaw) only in ring bouts; short weapons = armed stance with the point tracking the opponent; long weapons (spear/staff) = two-handed stance, lead hand up the shaft, rear hand on the butt at the waist, point at the brow. Never park both fists at the chest or hug them in front of the face.',
        '· Defence is technique, not covering up: a block must say WHICH body part or WHICH section of the weapon takes the blow (outer/inner forearm, palm slap, mid-weapon horizontal block, deflect, hang, sweep) plus where the force is shed and how the weight sits; a dodge must name the type (side slip, lean-back slip, duck under, angle step, pull back) and the line it clears. Never hug both fists to the face and tank it. Every defence answers with a counter or a re-position within 0.2-0.8 s.',
        '· Close-up rule: a "close-up" always means a FULL-BODY technique close-up - the whole fighter (head to feet) plus the move plus the skill VFX in one frame, subject about a third to a half of the picture. Never a big-head / face / hand / weapon-only or contact-point close-up ("fills half the frame" gets you a giant head). VFX may fill the frame but must never hide the silhouette.',
        '· Pushes, pull-backs, whips and zooms are the CAMERA moving: always state that the fighters hold their screen position - their position, size and facing change only through their own footwork, jumps or being launched. Never realise a camera move by sliding or scaling the fighters (that reads as teleporting).',
        '· Keep engineering tags out of the prose (they live in the material, not in the prompt).'
      ].join('\n');
      p.lawNoteZh = LAW_ZH;
      p.lawNoteEn = LAW_EN;
    }
    // ── 节奏与速度（2026-09-25）────────────────────────────────────────────
    //   用户：「开始打架了，快动作的话都是奔跑的拼打和追击的，怎么做出来是两个人慢慢走着打。」
    //   这一段把内核实测的"快慢"数字交给润色，并要求正文按快动作写（不许出现"慢慢走近"）。
    {
      const T = tempoStats(result, cfg);
      p.tempo = T;
      p.tempoNoteZh = '【节奏与速度 · 本场内核实测】' + '自由移动平均 ' + T.avgMps + ' 米/秒（峰值 ' + T.maxMps + ' 米/秒，≥8 米/秒的冲刺帧占 ' + T.dashFramePct + '%，<1 米/秒的"走着打"帧占 ' + T.slowPct + '%）；'
        + '冲刺 ' + T.dashes + ' 次（共 ' + T.dashDist + ' 米，单次最长 ' + T.dashLongest + ' 米，平均 ' + T.dashAvgSpeed + ' 米/秒；用途分布 ' + JSON.stringify(T.dashWhy) + '）；'
        + '出手 ' + T.attacks + ' 拍（平均间隔 ' + T.medianGapS + ' 秒、≤0.8 秒的"连打"占 ' + T.burstPct + '%、最长空档 ' + T.longestGapS + ' 秒）；'
        + '连击段 ' + T.combos + ' 段（最长 ' + T.maxCombo + ' 连）；'
        + '开场到第一次交手 ' + (T.firstContactS == null ? '—' : T.firstContactS + ' 秒') + '；被打退后重新贴上平均 ' + T.pursuitAvgS + ' 秒（6 秒没贴上 ' + T.pursuitMiss + ' 次）；'
        + '施法中移位 ' + T.castMoves + ' 次·悬停绕飞 ' + T.hoverMoves + ' 次·待机活步 ' + T.footwork + ' 次·蓄力被贴身改成近身招 ' + T.castCancels + ' 次。\n'
        + '**这是"快动作"的硬要求（正文必须自证）：**\n'
        + '· ① 进入交手一律用**冲刺/疾奔**：写清"几米/秒、冲了几米、几步之内交手"（例：「甲一个箭步，8 米/秒冲过 4 米，两步就进到身前」）。'
        + '**禁止**写"慢慢走近／缓缓逼近／缓步上前／踱步靠近／一步步逼近"这类慢镜头词。\n'
        + '· ② 开场就要打起来：从第一帧起双方就在抢位，**1 秒内**必须接触（冲刺抢身位、兵器先碰），不许先站着对峙好几秒。\n'
        + '· ③ 交手期是**连打**：一拍接一拍（间隔 0.3~0.8 秒），至少 3~5 连击成一段，段落之间才允许一次换气（不超过 1 秒）；'
        + '每一镜至少 2~4 个有效拍，不许把一镜写成"互相看两眼、出一招"。\n'
        + '· ④ **打退就追**：一方被击退/踉跄，另一方必须在 0.3~0.8 秒内冲刺追上补打（追到落点，不许站在原地看他退）；'
        + '被追的人要一边退一边招架/侧闪，不许被追着走一路。\n'
        + '· ⑤ **移动中打**：走位不是"站定再打"——垫步、绕步、侧移、跳步都发生在出招之间与出招之中，'
        + '写完一招就立刻给下一步的步法（谁抢了哪条线、绕到哪一侧）。\n'
        + '· ⑥ **施法不许站桩**：蓄力时是"踏罡步斗"——绕步护法／边结印边压上／边退边引气（可写身周气机与浮尘被带动），'
        + '蓄满脱手；被贴身时写明"来不及蓄满，收功改近身一掌／一剑"。\n'
        + '· ⑦ **悬停不是钉在空中**：飞行档悬停要写凌空绕飞、侧移找角度、抢高度（"御空侧移半米抢到出手线"），不许写"凝立不动"。';
      p.tempoNoteEn = '[PACING AND SPEED - measured in this match] free-movement average ' + T.avgMps + ' m/s (peak ' + T.maxMps + ' m/s; '
        + T.dashFramePct + '% of free frames are at 8+ m/s, ' + T.slowPct + '% are under 1 m/s); ' + T.dashes + ' sprints covering ' + T.dashDist + ' m (longest ' + T.dashLongest + ' m, average ' + T.dashAvgSpeed + ' m/s); '
        + T.attacks + ' strikes (median gap ' + T.medianGapS + ' s, ' + T.burstPct + '% of gaps at 0.8 s or less, longest lull ' + T.longestGapS + ' s); ' + T.combos + ' combo strings (longest ' + T.maxCombo + ' hits).\n'
        + 'Write it like fast action: sprint into every engagement with an explicit speed and distance; first contact inside 1 second; strikes chained 0.3-0.8 s apart in 3-5 hit strings; sprint after anyone knocked back within 0.3-0.8 s; never write "slowly walks up / paces closer". While charging, keep moving (circle, close in or retreat) - never a rooted caster. A hovering flyer orbits and repositions, never hangs motionless.';
    }
    // ── 环境破坏（2026-09-25）──────────────────────────────────────────────
    //   用户：「高手打架的招式或法术打倒周围建筑物、道具都是会打碎的。而不是一点动静都没。
    //         越是厉害的人越夸张。」这一段把内核真实发生的破坏交给润色，并按等级给"夸张度"要求。
    {
      const D = destructionStats(result, cfg);
      p.destruction = D;
      const tier = D.tier;
      const scaleZh = tier >= 8
        ? '**天崩地裂级**：掌风或法术所过之处，院墙整段塌落、廊柱拦腰折断、山门崩成碎块、石塔剥落成粉，碎块与尘浪能掀翻整片场地'
        : (tier >= 7
          ? '**摧枯拉朽级**：一片院墙轰然倒下、石塔开裂剥落、树木连根拔起、地面砸出坑'
          : (tier >= 5
            ? '**破墙级**：木箱炸裂、酒坛粉碎、柱角崩缺、砖石瓦片成片剥落'
            : (tier >= 3
              ? '**碎物级**：脚边的酒坛木凳被气浪掀碎、墙面崩出坑、尘土扬起'
              : '**凡人力道**：只有真正砸在东西上（把人砸进酒坛堆、兵器劈中木箱）才会碎')));
      const kindLine = Object.keys(D.byKind).length ? ('碎掉的名单：' + Object.keys(D.byKind).map((k) => k + '×' + D.byKind[k]).join('、') + '。') : '';
      p.destructionNoteZh = '【环境破坏 · 越厉害越夸张】本场场地里有 **' + D.total + ' 件可破坏物**（建筑/大型结构 '
        + D.buildings + ' 件，含山门石塔类 ' + D.mega + ' 件）；内核实测被打碎 **' + D.broken + ' 件**（建筑 '
        + D.buildingsBroken + ' 件' + (D.megaBroken ? ('，其中 ' + D.megaBroken + ' 件山门石塔级直接崩毁') : '') + '）·'
        + '碎块飞散 ' + D.debris + ' 次约 ' + D.debrisPieces + ' 片·地面震荡 ' + D.quakes + ' 次·地面留痕 ' + D.scars + ' 处。'
        + kindLine
        + (D.silentPct > 0 ? ('注意：本场约 ' + D.silentPct + '% 的命中落在空地（没碰到东西）——那几拍写"尘土碎石、脚下开裂"就行，别硬编建筑。') : '')
        + '\n按本场武力 ' + tier + ' 级，破坏要写成 ' + scaleZh + '。**五条硬要求**：\n'
        + '· ① **打中就要有后果**：每一次扎实命中／法术落点，正文里至少给一件具体的东西碎掉或塌掉——写清**是什么**（木箱／酒坛／条凳／院墙／廊柱／牌楼／塔檐／山门）＋**怎么碎**（炸裂／拦腰折断／整段塌落／崩成碎块）＋**碎片去哪了**（滚出去几米、砸在谁脚边、腾起多高尘）。只写"打中了"或"余波震荡"不算。\n'
        + '· ② **越强越夸张**：等级越高，同一下的破坏范围越大——低等级是"撞上什么碎什么"，高等级是"没直接碰到也塌"（掌风扫过一排灯笼全倒、隔空一掌把院墙推平、法术在街上犁出一道沟）。\n'
        + '· ③ **破坏会累积、跨镜保留**：这一镜砸塌的墙，下一镜还是塌的（断砖、缺口、烟尘未散），不许"复原"；后几拍还要拿它当环境用（踩着碎砖滑步、从缺口穿过去、把断柱当兵器）。\n'
        + '· ④ **碎块是画面的一部分**：写碎块的**量与方向**（"半面墙的碎砖贴着地面扫过来"）；7 级以上还要写"碎块悬浮／尘浪掀翻一整条街"这种夸张景象。\n'
        + '· ⑤ **不要拆空气**：本场可破坏物只有 ' + D.total + ' 件，写的量级要跟这个数字对得上——不许"拆掉半座城"，但**也绝不许一句破坏都不写**。';
      p.destructionNoteEn = '[ENVIRONMENTAL DESTRUCTION] tier ' + tier + ' fight: ' + D.total + ' breakables on the field ('
        + D.buildings + ' buildings, ' + D.mega + ' gate/tower-class), ' + D.broken + ' smashed in this run ('
        + D.buildingsBroken + ' buildings), ' + D.debris + ' debris bursts (~' + D.debrisPieces + ' pieces), ' + D.quakes
        + ' ground shocks, ' + D.scars + ' scars. Every solid hit or spell impact must break something visible: name the thing, '
        + 'say how it breaks and where the pieces go; wreckage persists across cuts; the stronger the fighter the wider the wreckage '
        + '(tier 5-6 smash crates, jars and pillars; tier 7-8 drop whole walls and crack stone towers; tier 9 flatten gates and send debris floating).';
    }
    // ── 命中反馈（2026-09-25）：用户「法术击中之后的反馈也不行」 ────────────────
    //   内核现在真的产出这些事件：spell_hit（硬直/击退/威力）、spell_after（余波：灼痕/结霜/麻痹…）、
    //   ground_scar（地面留痕）、spell_guard（被兵器架住/震开）、spell_absorbed（被护体卸掉）、
    //   ward_broken（护体被震碎）。这段素材要求正文把"受力 → 状态 → 留痕"三件事写全。
    {
      const c2 = p.counts || {};
      const stunAvg = (c2.spellCasts ? (c2.chargeSeconds ? 0 : 0) : 0);
      p.hitFeedbackZh = '【命中反馈 · 每一次命中都要写完三件事】\n'
        + '本场内核实测：法术命中 ' + (c2.spellHits||0) + ' 次（被兵器架住 ' + (c2.spellGuards||0) + ' 次·被护体卸掉 ' + (c2.spellAbsorbed||0)
        + ' 次·震碎护体 ' + (c2.wardBroken||0) + ' 次）·余波 ' + (c2.spellAfter||0) + ' 次·地面留痕 ' + (c2.groundScars||0) + ' 处·气劲外放 ' + (c2.qiBursts||0) + ' 次。\n'
        + '写命中的那一拍，必须齐三件：① **受力**：打中了哪、往哪个方向带、人被推了几米（重招要把人打得离地或踉跄）；'
        + '② **状态**：这一下打断了他正在做的事（收招/蓄力/腾空），之后他多久才缓过来；'
        + '③ **留痕**：接触点与地面上留下什么（焦痕、霜壳、裂纹、水花、碎石、气劲余环）——留痕跨镜保留，下一镜不许复原。\n'
        + '被架住的那一下也要有交代：兵器相撞的火星与震手、人被推开半步、护体值被压下去；被护体卸掉的写成"气劲在光膜外炸开一圈、人没事"。'
        + '**不许只写"打中了"三个字**，也不许打完之后对手像没事一样立刻反击。';
      p.aimNoteZh = '【施法朝向 · 法术必须是打向对手的】施法前先把朝向对准对手（内核已经这么做了：起手与蓄力期间都在转身），'
        + '正文里要能读出"他从掌心/指尖/刃口放出的东西是**朝对手去**的"：写清从哪一侧、什么角度、飞了多少米、打到对手身上哪个位置；'
        + '法术在半空与对手的法术/兵器相遇时，写清谁把那一下撞开。低等级不应出现隔空斗法；高等级（7 级以上）近战只留被贴身时的招架与挣脱。';
    }
    // 证据说明（风格/套路/神通）：提醒 AI 这是素材而不是可选建议
    //   （精简模式在第1步上传时会把这段压成一句——那些被点名的说明段整段都不在素材里了，见 slimPacket）
    p.stylePatternLegend = 'fightStyle/patterns = 本场打斗风格与每个角色的主战方式、衔接招式、神通（都由内核按参数真的执行过）；'
      + 'styleNoteZh/patternNoteZh/mythicNoteZh 是照抄用的中文段落；counts.linkCasts 是每个角色真的衔接出招的次数，'
      + 'counts.traits 与事件里的 trait/clone_hit 是内核真的放出来的神通次数（不是建议，是已执行的事实）；'
      + 'fxList/fxNoteZh/chargeNoteZh 是本场要写到的具名特效清单与施法时间口径（见 p.fxLegend）；'
      + 'hitFeedbackZh / aimNoteZh 是命中反馈与施法朝向的写法要求（每一处命中都要有三件事：受力·状态·留痕）。';
    const _FM = (typeof globalThis!=='undefined' && globalThis.H3FORMS) ? globalThis.H3FORMS : null;
    if (_FM && _FM.rule) {
      const _lv = (p.fx && p.fx.level) || 1;
      // ⚠ result.A 只是结算摘要（没有 skills/spells 清单），招式要从**原始角色卡**取。
      //   调用方给的 cfg 可能是编译结果（compile() 只留 source），所以两种都认。
      const _src = (cfg && (cfg.kitA || cfg.kitB)) ? cfg : ((cfg && cfg.source) || {});
      const _casts = [
        { name: _src.nameA || (result.A && result.A.name) || 'A', tier: (_src.kitA && _src.kitA.tier) || (result.A && result.A.tier) || 1, kit: _src.kitA || null },
        { name: _src.nameB || (result.B && result.B.name) || 'B', tier: (_src.kitB && _src.kitB.tier) || (result.B && result.B.tier) || 1, kit: _src.kitB || null }
      ].filter(c => c.kit);
      const _rows = [];
      _casts.forEach((c) => { _FM.formsFor(c.kit, c.tier).forEach((r) => _rows.push({ who: c.name, move: r.move, form: r.form.zh, key: r.form.key,
        shape: r.form.shape, palette: r.form.pal, sizeM: r.form.size, holdS: r.form.life, fade: r.form.fade, impact: r.form.impact, live: r.form.live })); });
      if (_rows.length) {
        // 素材瘦身（2026-09-25 用户硬指标：一次上传 ≤2 万字符）：形态明细只留"认得出它"的部分——
        //   key/live 是内部字段直接丢；shape/impact/fade 截到第一两个短句（原文一句就 100+ 字，
        //   二十来条形态明细能占两千字，而"形是什么、多大、什么色、停多久"才是要照抄的）。
        const cut = (s, n) => { const x = String(s || ''); return x.length > n ? x.slice(0, n - 1) + '…' : x; };
        p.forms = _rows.map((r) => ({ who: r.who, move: r.move, form: r.form, shape: cut(r.shape, 34), palette: r.palette,
          sizeM: r.sizeM, holdS: r.holdS, impact: cut(r.impact, 38), fade: cut(r.fade, 20) }));
        p.formsLegend = 'who/move = 谁用哪一招；form = 该出的具名形态；shape/palette/sizeM/holdS/fade/impact = 形·色·量·停留·消散·命中。';
        p.formsNoteZh = '【招式具名形态】下面是本场两个人的招式各自该出的实体气劲形态（按本场特效第 ' + _lv + ' 档算好的体量与停留）：'
          + _rows.filter(r => r.live).slice(0, 10).map(r => r.who + '「' + r.move + '」→' + r.form + '（' + r.sizeM + ' 米 / 停 ' + r.holdS + ' 秒）').join('；')
          + '。每一招都要走五拍：凝形→成形（形状·颜色·体量）→划空（拖尾/音爆/掠水痕）→命中炸开→消散（停住再散，不许瞬现瞬灭）；'
          + '同一招前后同形同色，全场不许所有招都用同一种形态，1~2 级纯肉身不给形态。'
          + (_FM.VERSION ? ('（形态库 ' + _FM.VERSION + '，共 ' + _FM.stats().total + ' 条）') : '');
      }
    }
    return p;
  }
  // ── 节奏与速度（2026-09-25 用户：「开始打架了，快动作的话都是奔跑的拼打和追击的，
  //    怎么做出来是两个人慢慢走着打」）────────────────────────────────────
  //   量的都是能复算的东西：自由移动速度（idle/move 帧）、冲刺次数与米数、出手间隔与连打比例、
  //   连击段数、被打退后重新贴上的时间、各状态帧占比。写不出这些数字，"快动作"就只能靠嘴说。
  function tempoStats(result, cfg){
    const frames = result.frames || [], ev = result.events || [];
    let free = 0, slow = 0, dashFr = 0, sum = 0, max = 0;
    const stateAll = {};
    for (let i = 1; i < frames.length; i++) {
      const a = frames[i - 1], b = frames[i], dt = b.t - a.t;
      if (!(dt > 0)) continue;
      for (const id of ['A', 'B']) {
        const q = b[id]; if (!q) continue;
        const pp = a[id]; if (!pp) continue;
        const sp = Math.hypot(q.x - pp.x, q.y - pp.y) / dt;
        stateAll[q.st] = (stateAll[q.st] || 0) + 1;
        if (q.st === 'idle' || q.st === 'move') {
          free++; sum += sp;
          if (sp > max) max = sp;
          if (sp < 1) slow++;
          if (sp >= 8) dashFr++;
        }
      }
    }
    const cnt = (t) => ev.filter((e) => e.type === t).length;
    const dEnd = ev.filter((e) => e.type === 'dash_end');
    const dashDist = dEnd.reduce((x, e) => x + (e.dist || 0), 0);
    const dashSpd = dEnd.length ? dEnd.reduce((x, e) => x + (e.speed || 0), 0) / dEnd.length : 0;
    const longestDash = dEnd.reduce((x, e) => Math.max(x, e.dist || 0), 0);
    const dashWhy = {};
    ev.filter((e) => e.type === 'dash').forEach((e) => { dashWhy[e.why || '-'] = (dashWhy[e.why || '-'] || 0) + 1; });
    const atk = ev.filter((e) => e.type === 'attack' || e.type === 'spell_cast');
    const per = { A: [], B: [] };
    atk.forEach((e) => { if (per[e.who]) per[e.who].push(e.t); });
    const gaps = [];
    let runs = 0, maxRun = 0;
    for (const id of ['A', 'B']) {
      const ts = per[id].slice().sort((a, b) => a - b);
      for (let i = 1; i < ts.length; i++) gaps.push(ts[i] - ts[i - 1]);
      let cur = 1;
      for (let i = 1; i <= ts.length; i++) {
        if (i === ts.length || ts[i] - ts[i - 1] > 1.2) { if (cur >= 2) { runs++; if (cur > maxRun) maxRun = cur; } cur = 1; }
        else cur++;
      }
    }
    gaps.sort((a, b) => a - b);
    const ENG = ['hit', 'spell_hit', 'block', 'clash', 'guardbreak', 'spell_guard', 'spell_absorbed', 'ward_broken'];
    const first = ev.filter((e) => ENG.indexOf(e.type) >= 0)[0];
    // 追击力：每次被打中之后，多久重新贴回 2.4 米以内
    let reSum = 0, reN = 0, reMiss = 0;
    const fs2 = frames;
    const at = (t) => { let i = Math.min(fs2.length - 1, Math.max(0, Math.round(t * 60))); while (i > 0 && fs2[i].t > t) i--; while (i + 1 < fs2.length && fs2[i + 1].t <= t) i++; return fs2[i]; };
    ev.filter((e) => e.type === 'hit' || e.type === 'spell_hit').forEach((e) => {
      let back = -1;
      for (let t = e.t; t < Math.min(result.duration || 30, e.t + 6); t += 1 / 30) {
        const f = at(t); if (!f) continue;
        if (Math.hypot(f.A.x - f.B.x, f.A.y - f.B.y) <= 2.4) { back = t - e.t; break; }
      }
      if (back >= 0) { reSum += back; reN++; } else reMiss++;
    });
    const total = Object.keys(stateAll).reduce((x, k) => x + stateAll[k], 0) || 1;
    const pctOf = (k) => +(100 * (stateAll[k] || 0) / total).toFixed(1);
    return {
      avgMps: +(free ? sum / free : 0).toFixed(2), maxMps: +max.toFixed(1),
      slowPct: +(free ? 100 * slow / free : 0).toFixed(0), dashFramePct: +(free ? 100 * dashFr / free : 0).toFixed(0),
      dashes: cnt('dash'), dashDist: +dashDist.toFixed(1), dashAvgSpeed: +dashSpd.toFixed(1),
      dashLongest: +longestDash.toFixed(1), dashWhy: dashWhy,
      attacks: atk.length, attacksPerSec: +((atk.length) / Math.max(1, result.duration || 30)).toFixed(2),
      medianGapS: +(gaps.length ? gaps[Math.floor(gaps.length / 2)] : 0).toFixed(2),
      longestGapS: +(gaps.length ? gaps[gaps.length - 1] : 0).toFixed(2),
      burstPct: +(gaps.length ? 100 * gaps.filter((g) => g <= 0.8).length / gaps.length : 0).toFixed(0),
      combos: runs, maxCombo: maxRun,
      castMoves: cnt('cast_move'), hoverMoves: cnt('hover_move'), footwork: cnt('footwork'), castCancels: cnt('cast_cancel'),
      firstContactS: first ? +first.t.toFixed(2) : null,
      pursuitAvgS: +(reN ? reSum / reN : 0).toFixed(2), pursuitMiss: reMiss,
      statePct: { move: pctOf('move') + pctOf('idle'), cast: pctOf('cast'), attack: pctOf('attack'), stun: pctOf('hitstun') + pctOf('stagger'), down: pctOf('down'), air: 0 }
    };
  }

  // ── 环境破坏统计（2026-09-25 用户：「高手打架的招式或法术打倒周围建筑物、道具都是会打碎的。
  //    而不是一点动静都没。越是厉害的人越夸张。」）────────────────────────────
  function destructionStats(result, cfg){
    const ev = result.events || [], props = result.props || [];
    const byKind = {};
    props.filter((x) => x.broken).forEach((x) => { byKind[x.zh] = (byKind[x.zh] || 0) + 1; });
    const hits = ev.filter((e) => e.type === 'hit' || e.type === 'spell_hit');
    let silent = 0;
    hits.forEach((h) => {
      const near = ev.some((x) => (x.type === 'obstacle_hit' || x.type === 'ground_scar' || x.type === 'debris' || x.type === 'quake')
        && Math.abs(x.t - h.t) < 0.6);
      if (!near) silent++;
    });
    return {
      tier: Math.max(1, Math.min(9, (result.A && result.A.tier) || (cfg && cfg.kitA && cfg.kitA.tier) || 1)),
      total: props.length,
      buildings: props.filter((x) => x.building).length,
      broken: props.filter((x) => x.broken).length,
      buildingsBroken: props.filter((x) => x.building && x.broken).length,
      mega: props.filter((x) => x.mega).length,
      megaBroken: props.filter((x) => x.mega && x.broken).length,
      byKind: byKind,
      obstacleHits: ev.filter((e) => e.type === 'obstacle_hit').length,
      propBroken: ev.filter((e) => e.type === 'prop_broken').length,
      debris: ev.filter((e) => e.type === 'debris').length,
      debrisPieces: ev.reduce((x, e) => x + (e.type === 'debris' ? (e.pieces || 0) : 0), 0),
      quakes: ev.filter((e) => e.type === 'quake').length,
      scars: ev.filter((e) => e.type === 'ground_scar').length,
      hits: hits.length,
      silentPct: hits.length ? +(100 * silent / hits.length).toFixed(0) : 0
    };
  }

  // ── 素材瘦身（2026-09-25 用户：「这模拟的字数和第一次润色的字数太多了吧？能有优化一下吗？」）──
  //   实测改前：一场 24 秒对局的证据 JSON 15.6 万字符、分镜文本 1.6 万，加起来要上传 17 万字符上模型；
  //   12 秒的短场更夸张（证据 19.4 万）。其中 90% 是纯装饰事件（残影/踏罡步斗/悬停绕飞…每条都带全量姿态与配色）、
  //   每一条事件里又塞着整段招式定义（move）与姿态数组（pose），而说明段还把中英两份都带上。
  //   这里做**默认精简**：写提示词不需要的那些一概不进素材，只留计数；说明段只留当前语言。
  //   只逐条保留"故事骨架"：出招/命中/法术起手·脱手·命中/护体/建筑碎裂/神通/天地异象/蓄力改招/KO；
  //   其余（气劲、灵光、余波、地面留痕、掩体裂纹、落地、起跳、闪避、冲刺、分身落空、震荡、残影…）一律并进计数。
  const SLIM_KEEP = { attack:1, hit:1, block:1, clash:1, guardbreak:1, spell_cast:1, spell_release:1, spell_hit:1,
    spell_guard:1, spell_absorbed:1, ward_broken:1, prop_broken:1, trait:1, phenomenon:1, cast_cancel:1,
    ko:1, ring_out:1, cornered:1, slam:1 };
  // 装饰类 + 破坏类明细：都只留计数（碎块/震荡/裂纹一次次列出来，模型读起来全是重复数字）
  const SLIM_DROP = { afterimage:1, cast_move:1, hover_move:1, footwork:1, dash_end:1, filler:1, whiff:1, unstick:1, hover_end:1,
    contact:1, debris:1, quake:1 };
  const SLIM_FIELDS = ['move', 'pose', 'variant', 'peakZh', 'destruction', 'ox', 'oy', 'ba', 'ba0', 'palette', 'shape',
    'light', 'fxLevel', 'spawn', 'src', 'whyZh', 'prep', 'techEn', 'note', 'sim',
    'id', 'key', 'skillId', 'chain', 'by', 'dive', 'blast', 'spell', 'through', 'air', 'zh', 'whyZh', 'eventTag',
    'from', 'times', 'wall', 'prop', 'crouch', 'mob', 'pieces', 'atRelease'];
  const rnd = (v) => (typeof v === 'number' && isFinite(v) ? Math.round(v * 100) / 100 : v);
  function slimNum(o) {
    if (Array.isArray(o)) return o.map(slimNum);
    if (o && typeof o === 'object') { const out = {}; Object.keys(o).forEach((k) => { out[k] = slimNum(o[k]); }); return out; }
    return rnd(o);
  }
  function slimPacket(p, opts) {
    const lang = (opts && opts.lang) === 'en' ? 'en' : 'zh';
    const stat = { droppedEvents: {}, droppedFields: 0, notesDropped: [], before: 0, after: 0 };
    const before = JSON.stringify(p).length;
    // ① 事件：装饰类只留计数
    const kept = [];
    const counts = {};
    (p.events || []).forEach((e) => {
      const t = e.type;
      if (SLIM_DROP[t]) { counts[t] = (counts[t] || 0) + 1; return; }
      if (!SLIM_KEEP[t]) { counts[t] = (counts[t] || 0) + 1; return; }
      // 小件碎裂只计数（建筑/大型结构才逐条列，写作时要点名它们）
      if (t === 'prop_broken' && !e.building && !e.mega) { counts['小件碎裂'] = (counts['小件碎裂'] || 0) + 1; return; }
      if (t === 'obstacle_hit' && !e.broke) { counts['掩体被砸（未碎）'] = (counts['掩体被砸（未碎）'] || 0) + 1; return; }
      // 招式/法术类：只留「谁、什么招、什么时候、结果如何」（坐标只在建筑碎裂与 KO 上保留）
      if (t === 'attack' || t === 'hit' || t === 'spell_cast' || t === 'spell_release' || t === 'spell_hit') {
        const keep2 = ['t', 'who', 'tech', 'damage', 'dmg', 'hp', 'stun', 'kb', 'power', 'heavy', 'finisher',
          'chain', 'range', 'dist', 'spd', 'chargeT', 'radius', 'link', 'height', 'ko'];
        const o1 = { t: rnd(e.t), type: t };
        // 零值/假值字段直接省略（false 与 0 本来就是"没有"的意思：没硬直、没击退、在地面、没衔接…），
        //   只保留 damage/hp 的 0（那是有意义的读数：这一下没掉血）。
        keep2.forEach((k) => {
          const v = e[k];
          if (v === undefined || v === null || v === false) return;
          if (v === 0 && k !== 'damage' && k !== 'hp') return;
          o1[k] = rnd(v);
        });
        if (e.dur) o1.dur = +((e.dur.w || 0) + (e.dur.a || 0) + (e.dur.r || 0)).toFixed(2);
        kept.push(o1);
        stat.droppedFields++;
        return;
      }
      const o = {};
      Object.keys(e).forEach((k) => {
        if (SLIM_FIELDS.indexOf(k) >= 0) { stat.droppedFields++; return; }
        if (e[k] === undefined || e[k] === null || e[k] === false) { stat.droppedFields++; return; }   // 假值＝"没有"（如 mega:false）
        if (e[k] && typeof e[k] === 'object' && k !== 'pose') { o[k] = slimNum(e[k]); return; }
        o[k] = rnd(e[k]);
      });
      kept.push(o);
    });
    p.events = kept;
    // ①-b 事件上限（2026-09-25 用户硬指标：一次上传 ≤2 万字符）
    //   事件是素材里最肥的一块（仙神 30 秒那场 60+ 条就 7 千多字）。这里给事件总量一个字节上限，
    //   超了**按重要度**把最次要的转成计数（保留+计数仍等于事件总数，一条都不会凭空消失）：
    //   终结/出界 > 建筑类碎裂 > 神通·天地异象·护体被震碎·施法被打断 > 法术命中·砸地·被逼入角
    //   > 命中 > 蓄法·脱手 > 出手·崩防 > 格挡·对拼。
    const EVENT_BYTES = (opts && opts.eventBytes) || 3400;
    if (kept.length && JSON.stringify(kept).length > EVENT_BYTES) {
      const R1 = ['trait', 'phenomenon', 'ward_broken', 'cast_cancel', 'spell_guard', 'spell_absorbed'];
      const R2 = ['spell_hit', 'slam', 'cornered'];
      const R3 = ['spell_cast', 'spell_release'];
      const rank = (e) => (e.type === 'ko' || e.type === 'ring_out') ? 0
        : (e.type === 'prop_broken' && (e.building || e.mega)) ? 1
        : R1.indexOf(e.type) >= 0 ? 2
        : R2.indexOf(e.type) >= 0 ? 3
        : e.type === 'hit' ? 4
        : R3.indexOf(e.type) >= 0 ? 5
        : (e.type === 'attack' || e.type === 'guardbreak') ? 6 : 7;
      const order = kept.map((e, i) => ({ i: i, r: rank(e) })).sort((a, b) => (b.r - a.r) || (b.i - a.i));
      // 每类主拍给"保底条数"：命中/出手/施法这类拍就算超字数也要留够——
      //   全被压成计数的话，模型就只能看到"打了 30 下"而不知道"谁打到谁、怎么打的"。
      const QUOTA = { hit: 4, attack: 6, spell_cast: 3, spell_release: 2, spell_hit: 3, block: 2, clash: 2 };
      const kill = {};
      const leftOf = (t) => { let n = 0; for (let i = 0; i < kept.length; i++) if (!kill[i] && kept[i].type === t) n++; return n; };
      let len = JSON.stringify(kept).length;
      for (const o of order) {
        if (len <= EVENT_BYTES) break;
        if (o.r <= 2) continue;                                  // 第一梯队（终结/建筑碎裂/神通/异象/护体被震碎）一条都不许压
        const t = kept[o.i].type;
        const q = QUOTA[t] || 0;
        if (q && leftOf(t) <= q) continue;                       // 这一类的保底还没用完，跳过它去压别的
        kill[o.i] = 1;
        len -= JSON.stringify(kept[o.i]).length + 1;
      }
      const capped = {};
      const kept2 = kept.filter((e, i) => { if (kill[i]) { capped[e.type] = (capped[e.type] || 0) + 1; return false; } return true; });
      Object.keys(capped).forEach((k) => { counts[k] = (counts[k] || 0) + capped[k]; });
      kept.length = 0; kept2.forEach((e) => kept.push(e));
      stat.eventsCapped = capped;
    }
    stat.droppedEvents = counts;
    if (Object.keys(counts).length) {
      const zh = Object.keys(counts).map((k) => (EV_ZH[k] || ('小件碎裂' === k ? '小件碎裂（酒坛/木箱/条凳类）' : ('掩体被砸（未碎）' === k ? '掩体被砸出裂纹' : k))) + '×' + counts[k]).join('、');
      p.eventCountsNoteZh = '（装饰性事件只计数，不逐条列出：' + zh + '）'
        + (stat.eventsCapped ? ('（事件上限 ' + EVENT_BYTES + ' 字再精简：'
          + Object.keys(stat.eventsCapped).map((k) => (EV_ZH[k] || k) + '×' + stat.eventsCapped[k]).join('、')
          + '——只计数不逐条，命中/终结/建筑碎裂等关键拍已在上面逐条列出）') : '');
      p.eventCountsNoteEn = '(decorative events counted only: ' + Object.keys(counts).map((k) => k + 'x' + counts[k]).join(', ') + ')';
    }
    // ② 说明段：只留当前语言，且不再重复"分镜里已经有的"
    const NOTE_KEEP = { stagingNote: 1, aimNote: 1, chargeNote: 1, hitFeedback: 1, fxListNote: 1, formNote: 1, mythicNote: 1,
      styleNote: 1, patternNote: 1, arenaNote: 1, relPosNote: 1, tempoNote: 1, destructionNote: 1, timelineNote: 1, timingNote: 1,
      // 专属技能/大招清单（2026-09-30）：页面用 h3-skills.js 生成、必须原样带进素材
      skillNote: 1,
      // 打戏铁律（2026-09-30）：颗粒度/瞬态动词/双向受力/收尾四协议 等可判定条款
      lawNote: 1 };
    //   语言：只留当前语言；opts.notes===false 时再丢掉"分镜文本里已经写过一遍"的那些（第1步上传用这个）
    const OCTX = ['stagingNote', 'styleNote', 'patternNote', 'mythicNote', 'fxNote', 'chargeNote', 'arenaNote', 'relPosNote', 'tempoNote', 'destructionNote', 'aimNote', 'fxListNote', 'formNote', 'hitFeedback'];
    const skip = (opts && opts.notes === false) ? OCTX : [];
    Object.keys(p).forEach((k) => {
      const m = /^(.*?)(Zh|En)$/.exec(k);
      if (!m) return;
      const base = m[1];
      if (!/Note$/.test(base)) return;
      const want = lang === 'en' ? base + 'En' : base + 'Zh';
      if (k !== want || (skip.length && skip.indexOf(base) >= 0)) { delete p[k]; stat.notesDropped.push(k); }
    });
    //   ⚠ `note`（内核口径说明，整段英文）在精简模式下丢掉：它是"解释怎么读素材"，不是证据本身，
    //     而它不受语言过滤管（键名不带 Zh/En），留着就是几百字英文混在中文素材里。
    if (opts && opts.notes === false && p.note !== undefined) { delete p.note; stat.notesDropped.push('note'); }
    //   同理：键名解释段里点名的那些说明段（styleNoteZh/patternNoteZh/…）在被丢掉之后就成了"指向空处"，
    //   所以精简模式下把它压成一句（事实仍然在 counts 里）。
    if (opts && opts.notes === false && p.stylePatternLegend) {
      p.stylePatternLegend = 'fightStyle/patterns = 本场打斗风格与每个角色的主战方式、衔接招式、神通（内核实测次数见 counts）；'
        + 'fxList/forms = 具名特效与招式形态（形·色·量·光·破·影）；每一次命中都要写受力·状态·留痕。';
    }
    //   形态明细（forms，每条 80 字上下）：第1步上传时丢掉——提示词里的【招式具名形态】段
    //   （formsNoteZh：谁用哪招→出什么形、几米、停几秒）已经把要照抄的都给了，逐条 shape/impact/fade 是重复。
    if (opts && opts.notes === false && p.forms) { stat.droppedFields++; delete p.forms; }
    //   同理，第1步上传时这些块与提示词里已有的段落重复（都从同一份内核数据生成），
    //   上传里只留一份：证据给"原始读数与坐标"，提示词给"写法与读数"。
    //   丢掉的是：fx（特效规格＝提示词的【特效分级】）、tempo/destruction（＝【节奏与速度】【环境破坏】）、
    //   formsNoteZh（＝【招式具名形态】）、fxLegend、actionWindows/timingNote（＝【施法时间】【命中反馈】的写法）。
    //   **counts 留着**：那是内核真的算出来的次数（施法/衔接/神通/破坏），是"写了没发生"的唯一对照。
    if (opts && opts.notes === false) {
      ['fx', 'tempo', 'destruction', 'formsNoteZh', 'formsNoteEn', 'fxLegend', 'actionWindows', 'timingNote', 'poseLegend']
        .forEach((k) => { if (p[k] !== undefined) { delete p[k]; stat.notesDropped.push(k); } });
    }
    // ③ 走位表：行数按片长收敛（短片 12 行、长片 16 行），每行改成紧凑形式（同样信息，字少一半）
    if (Array.isArray(p.staging)) {
      const st0 = p.staging;
      const _sec = +(p.simulationSeconds || p.targetSeconds || 15);
      const keepN = (opts && opts.stagingRows) || (_sec <= 15 ? 12 : 14);
      let rows = st0;
      if (st0.length > keepN) {
        const step = Math.ceil(st0.length / keepN);
        rows = st0.filter((x, i) => i % step === 0 || i === st0.length - 1);
      }
      // 文本版的空间描述在分镜的「本镜空间」行里；素材里这张表只留**相对位置读数**（不用坐标）：
      //   A/B: [画面左右, 离镜头远近, 离地米, 相对对手方位] —— 视频模型读方位比读 (x,y,z) 准得多。
      const BEAR = { front: '正', back: '后', left: '左', right: '右' };
      const rel3 = (x) => (x ? [x.side, x.depth, rnd(x.height == null ? 0 : x.height), BEAR[x.bearingToB] || BEAR[x.bearingToA] || '正'] : null);
      p.staging = rows.map((x) => ({ t: rnd(x.t), d: rnd(x.dist), A: rel3(x.A), B: rel3(x.B) }));
      p.stagingLegend = 'staging 行 = {t 秒, d 间距米, A/B:[画面左右, 离镜头远近, 离地米, 相对对手方位(正/左/右/后)]}（相对位置，不用坐标；完整文字读数见分镜各镜的「本镜空间」行）';
    }
    if (p.stagingNoteZh && p.stagingNoteZh.indexOf('\nt=') > 0) p.stagingNoteZh = p.stagingNoteZh.split('\nt=')[0];
    if (p.stagingNoteEn && p.stagingNoteEn.indexOf('\nt=') > 0) p.stagingNoteEn = p.stagingNoteEn.split('\nt=')[0];
    // ④ 角色摘要瘦身
    ['A', 'B'].forEach((id) => {
      const ch = p.characters && p.characters[id];
      if (!ch) return;
      p.characters[id] = slimNum({
        name: ch.name, tier: ch.tier, weapon: ch.weaponName || ch.weapon,
        mobility: ch.mobility && { zh: ch.mobility.zh, hover: ch.mobility.hover },
        primary: ch.primary, link: ch.link, traits: ch.traits, spells: (ch.spells || []).map((sp) => sp.zh)
      });
    });
    // ⑤ 特效清单只留名字（详细写法在 fxNote 里）。
    //    ⚠ 一件一件带「形」的描述串在仙神场次要占两千字；上传时只留名字 + 一句"形·色·量·光·破·影
    //      按本场特效档统一执行"（档位规格在提示词的【特效分级】里），名字是"认得出哪一件"的最低成本。
    if (Array.isArray(p.fxList)) {
      p.fxListNote2 = p.fxList.map((x) => (typeof x === 'string' ? x : x.zh)).join('、')
        + '（共 ' + p.fxList.length + ' 件；形·色·量·光·破·影按本场特效档统一执行）';
      delete p.fxList;
    }
    // ⑤-b 套路档案：精简模式下整块丢掉（patternNote 与角色摘要里已经有「谁主战什么」）
    if (p.patterns) { stat.droppedFields++; delete p.patterns; }
    // ⑥ 道具只列"碎了/被打过"的
    if (Array.isArray(p.props)) {
      const brokenOrHit = p.props.filter((x) => x.broken || (x.hits || 0) > 0);
      p.propsBrokenList = brokenOrHit.map((x) => (x.broken ? '碎:' : '裂:') + x.zh + '@' + Math.round(x.x) + ',' + Math.round(x.y));
      p.props = { total: p.props.length, broken: p.props.filter((x) => x.broken).length, buildings: p.props.filter((x) => x.building).length };
    }
    // ⑦ 时间账封顶、轨迹降采样、warnings 封顶
    // 时间账：精简模式下整块丢掉（分镜文本 + timingNote 已经说清每个动作的时长口径）
    if (p.timeline) { stat.droppedFields++; delete p.timeline; delete p.timing; }
    // 轨迹：精简模式下整块丢掉（走位表的坐标 + 每镜的起幅/落幅坐标已经给了"每一步在哪"，
    //   轨迹只是同样坐标的 16 帧版本，长场次要占近千字）
    if (p.trajectory) { stat.droppedFields++; delete p.trajectory; }
    if (Array.isArray(p.trajectory) && p.trajectory.length > 16) {
      const step = Math.ceil(p.trajectory.length / 16);
      p.trajectory = p.trajectory.filter((x, i) => i % step === 0);
    }
    if (Array.isArray(p.warnings) && p.warnings.length > 6) p.warnings = p.warnings.slice(0, 6);
    if (Array.isArray(p.trajectory)) p.trajectory = slimNum(p.trajectory);
    if (Array.isArray(p.staging)) p.staging = slimNum(p.staging);
    // ④ 硬预算：超过预算就按优先级继续丢。
    //   预算是**上传字数**的硬指标，而 p.slim 自述块（mode/savedPct/chars/budget/droppedEvents）也要上传，
    //   所以比较时把它一起算进去（否则核算刚好压线、实际却超了几百字）。
    //   口径：证据 ≤1.17 万 + 分镜文本 ≤0.8 万 ＝ 上传硬指标 2 万以内（两半都压线时也不许超）。
    const BUDGET = (opts && opts.budget) || 11700;
    const RESERVE = 560;                       // p.slim 自述块 + 外层 JSON 包裹的开销
    const sizeOf = () => JSON.stringify(p).length + RESERVE;
    const budgetDrop = [];
    // ① 先丢"提示词里已经给过一遍"的说明段（它们是提示，不是证据）。
    //   ⚠ fxNoteZh（特效规格：形·色·量·光·破·影）是用户点名的硬素材（「要写入大量特效的提示词」），
    //     任何情况下都保留——它是证据自身唯一一句特效规格，丢了模型就只剩特效名字。
    const NOTE_DROP = ['patternNote', 'formNote', 'mythicNote', 'fxListNote', 'hitFeedback', 'aimNote', 'chargeNote'];
    for (const base of NOTE_DROP) {
      if (sizeOf() <= BUDGET) break;
      const k = base + (lang === 'en' ? 'En' : 'Zh');
      if (p[k] !== undefined) { delete p[k]; budgetDrop.push(k); }
    }
    // ② 再把"可有可无"的数据块丢掉：坐标表（staging）与角色摘要（characters）是硬需求，任何情况下都保留；
    //   全丢完仍超预算时如实记 overflow（调用方可以用 notes:false 再省一大截）
    //   ⚠ counts（内核实测次数）是"关键数据一条不少"里的硬数据——**永不许丢**（体检实测：超预算时
    //     旧版会先把它删掉，素材里就只剩事件、看不到聚合读数）。要省字就丢重复的防守拍（见下一档）。
    for (const step of ['warnings', 'propsBrokenList', 'fxListNote2', 'trajectory']) {
      if (sizeOf() <= BUDGET) break;
      if (p[step] === undefined) continue;
      delete p[step];
      budgetDrop.push(step);
    }
    // 还超预算就把"最重复的防守拍"逐条转成计数。
    //   ⚠ 故事骨架（命中 hit／招式 attack／施法 spell_cast·spell_release·spell_hit／神通 trait／天地异象 phenomenon／
    //     建筑碎裂 prop_broken）**一条都不许少**——它们是"谁打到谁、打成什么样"的事实，
    //     用户点名过「命中之后的反馈」「法术释放的对象」这类问题，少一条就等于素材在说谎。
    //     所以最后一档只动"连着格挡/反复对拼"这类重复拍；实在压不下去就如实记 overflow。
    //   2026-10-01：打斗智商上来之后"闪避/翻滚"拍变多（这是好事），超预算时它们按同一口径转为计数
    const REMOVE_ORDER = ['clash', 'block', 'dodge', 'guardbreak'];
    const thinned = {};
    for (const t of REMOVE_ORDER) {
      while (sizeOf() > BUDGET) {
        let idx = -1;
        for (let i = p.events.length - 1; i >= 0; i--) { if (p.events[i].type === t) { idx = i; break; } }
        if (idx < 0) break;
        p.events.splice(idx, 1);
        thinned[t] = (thinned[t] || 0) + 1;
      }
    }
    if (Object.keys(thinned).length) {
      Object.keys(thinned).forEach((k) => { counts[k] = (counts[k] || 0) + thinned[k]; });
      p.eventCountsNoteZh = (p.eventCountsNoteZh || '') + '（超预算再精简：' + Object.keys(thinned).map((k) => k + '×' + thinned[k]).join('、') + '）';
      budgetDrop.push('events:' + JSON.stringify(thinned));
    }
    const after = JSON.stringify(p).length;
    stat.budget = { limit: BUDGET, dropped: budgetDrop, overflow: Math.max(0, sizeOf() - BUDGET) };
    stat.before = before; stat.after = after;
    stat.savedPct = before ? Math.round(100 - 100 * after / before) : 0;
    // 自述块也占上传字数，所以只报"用得上"的：省了多少、还剩多长、预算与超出多少、丢了哪些装饰；
    //   zero 一句是给模型的读数约定（0/false 的字段被省略，缺省即"没有"）。
    p.slim = { mode: 'light', savedPct: stat.savedPct, chars: { before: before, after: after },
      budget: { limit: BUDGET, overflow: stat.budget.overflow },
      droppedEvents: stat.droppedEvents, droppedNoteCount: stat.notesDropped.length,
      zero: '0/false 字段已省略（缺省＝没有）；相对位置见 staging 与分镜各镜的「本镜空间」行（不用坐标）' };
    return p;
  }

  function evidenceText(result,cfg,opts){
    const p=packet(result,cfg);
    // 特效规格（等级×风格档）另附一段中文说明：JSON 键名是英文，模型照读容易漏掉"形·色·量·光·破·影"
    const _fx=p.fx; if(_fx){
      p.fxNoteZh=`本场最高武力 ${_fx.tier} 级；特效风格「${_fx.styleZh}」→ 按第 ${_fx.level} 档「${_fx.name}」呈现。`
        +`形＝${_fx.shape}；色＝${_fx.palette}；量＝${_fx.scale}（半径约 ${_fx.scaleM||"不足半"} 米）；光＝${_fx.light}；破＝${(_fx.destruction||[]).join("、")}；影＝${_fx.camera}。`
        +((_fx.spectacles||[]).length?`招牌特效：${_fx.spectacles.join("、")}。`:"")
        +`场面规模＝${_fx.cataclysm||"局部级"}（体量约 ${_fx.scaleM||0} 米）；`
        +`留痕＝${_fx.scar||"—"}（破坏必须跨镜保留：坑、裂纹、断壁、倒伏、焦痕不许下一镜复原）；`
        +`余波＝${_fx.aftermath||"—"}（打完那一镜要给"尘埃落定"的收尾画面）。`
        +`（counts.qiBursts/auras/afterimages/phenomena 是内核真的算出来的爆发次数，按次数分配"大片级特写"。）`;
    }
    // Keep every event, but avoid duplicating animation-only attributes.
    const pos=f=>f?[f.x,f.y,f.z,f.face,f.st,f.hp]:null;
    p.events=p.events.map(e=>({...e,pose:e.pose?{A:pos(e.pose.A),B:pos(e.pose.B)}:null}));
    p.trajectory=p.trajectory.map(f=>({t:f.t,A:pos(f.A),B:pos(f.B)}));
    p.poseLegend='[x,y,z,facingRadians,state,hp]';
    // 动作时间账：每个动作的 开始→结束→时长（含相位与空中段）+ 延伸窗口规则
    p.timeline=(result.timeline||[]).slice(0,400);
    p.timing=result.timing||null;
    p.actionWindows={block:'格挡后 0.2~0.8 秒内应反击或抢位',dodge:'闪避落位后 0.15~0.6 秒内应反击',
      hitstun:'受击硬直期间不得行动',stagger:'踉跄后 0.3~0.6 秒重心未稳',down:'倒地余波：胜者收势'};
    p.timingNote='每个动作都不是瞬发即消失：起手≤0.3s／有效0.05~0.12s／收招≤0.7s；格挡约0.2~0.3s；闪避约0.34s；硬直 轻0.18~0.26／重0.40／崩防0.85／倒地3s；滞空按起跳-落地计。';
    // ⚠ 瘦身必须在**装配完之后**做（原来放在开头，timeline/events/trajectory 还没填就已经瘦过一遍，等于没瘦）
    if (!(opts && opts.full)) slimPacket(p, opts || {});
    return JSON.stringify(p);
  }
  // ── 英文报告用词表 ─────────────────────────────────────────────────────
  //   英文报告里如果插着中文招式名/特效名（"flares an aura of 紫金雷"），读起来就是没翻完。
  //   招式名优先取招式库自带的 en（moves.js 每条都有）；特效词（配色/形状/破坏/掩体/机动）在这里映射。
  const EN_FX = {
    // 配色
    '银白':'silver-white','青白':'pale cyan','金白':'gold-white','金青':'gold-cyan','紫金雷':'violet-gold lightning',
    '金紫＋虚空黑':'gold-violet over void black','星辉金紫':'starlight gold-violet','青白剑芒＋电弧':'pale blade glare and arcs',
    // 形状
    '同心气劲涟漪':'concentric qi ripples','透体冲击波':'through-body shockwave','罡气护膜＋气浪环':'ward membrane and blast ring',
    '剑气纵横拖尾':'crossing blade trails','雷柱＋冲击波环＋地裂':'lightning pillar, blast ring and ground cracks',
    '虚空裂痕＋法相虚影':'void rifts and a dharma-form afterimage','万千剑影＋法相＋星河倒卷':'myriad blade shadows, dharma form and a reversed galaxy',
    '扇面':'fan arc','直线':'line','圆环':'ring',
    // 内力/护体/光影
    '罡气':'ward qi','气劲':'qi','内力':'internal energy','灵光':'aura','护体':'ward','残影':'afterimage',
    '气劲外放':'qi release','罡气护体':'ward qi','剑气离体':'blade qi','雷劫光柱':'lightning pillar','天地异象':'phenomenon',
    '法相虚影':'dharma form','星河倒卷':'reversed galaxy','法则轰鸣':'law thunder','万千剑影':'myriad blade shadows',
    // 环境破坏
    '碎石微溅':'grit sprays','衣摆翻飞':'hems snap','青石板裂细纹':'flagstones hairline-crack','尘土扬起':'dust rises',
    '器物被震开':'props are blown aside','地面开裂':'the ground cracks','碎石飞溅':'shards fly','气浪推人':'the blast shoves them',
    '灯笼摇晃':'lanterns sway','空气扭曲':'the air warps','瓦片剥落':'roof tiles peel off','浮空御风':'debris rides the wind',
    '山石崩裂':'rock splits','罡雷滚落':'ward-lightning rolls','地面塌陷':'the ground subsides','地裂山崩':'the ground splits and rockfalls',
    '碎块悬浮':'debris floats','雷暴盘绕':'thunder coils','土石浮空':'earth and stone float','山岳平移':'mountains shift',
    '江河倒卷':'rivers reverse','法则轰鸣':'law thunder rolls',
    // 掩体
    '石柱':'stone pillar','断柱':'broken pillar','酒坛':'wine jar','木箱':'wooden crate','木桩':'wooden post','墙':'wall','条凳':'bench','香炉':'incense burner',
    // 固定地标（官方空间锚点卡要点名地标）：内核真实生成的那几件＋常见场地物件
    '塔檐':'pagoda eaves','牌楼':'stone archway','石狮':'stone lion','院墙':'courtyard wall','廊柱':'colonnade pillar',
    '半塌院墙':'half-collapsed wall','石塔':'stone pagoda','山门':'temple gate','杂物堆':'junk pile','石灯笼':'stone lantern',
    '兵器架':'weapon rack','旗杆':'flagpole','水缸':'water vat','石桌':'stone table','井台':'well curb','石阶':'stone steps',
    // 光位基线（官方光位字段的英文）
    '冷光映亮地面':'cool light washes the ground','金光勾出人物轮廓':'gold rim light traces the fighters',
    '金光映亮雨后石板':'gold light on wet flagstones','电光短暂照亮面部':'electric light flashes across faces',
    '雷光照出长影，天色转暗':'thunder-light throws long shadows, the sky darkens',
    '裂隙泛紫黑辉光，把山体压成暗紫':'violet-black glow from the rifts','天地变色：白昼转暗、星辉洒满全场、光柱穿透云层':'the sky shifts: starlight and light pillars through the clouds',
    // 机动
    '凌空':'flight','飞行':'flight','踏空':'air-step','轻功':'qinggong','踏墙':'wall run','御风':'wind-ride'
  };

  function describe(e,r,english){
    const name=id=>r[id]?r[id].name:id;
    const a=name(e.by||e.a||e.who),b=name(e.who||e.b);
    const num=v=>Math.round((v||0)*100)/100;
    // 招式库（英文报告要用它自带的 en 名；中文分支也要用它写 prep/act/effect）
    const MV = (function () {
      let lib = null;
      try { lib = require("./moves.js"); } catch (e2) { lib = (typeof globalThis !== "undefined" && (globalThis.SIM3D_MOVES || globalThis.MOVE_LIB)) || null; }
      return lib;
    })();
    const moveOf = (e2) => e2 && e2.move ? e2.move : (MV ? MV.get(e2 && e2.tech) : null);
    /** 招式名的英文：招式库自带的 en → 页面词典（i18n-en.js 暴露的 H3_TECH_EN）→ 原字 */
    const techEn = (ev) => {
      if (!ev) return '';
      const mv = moveOf(ev);
      if (mv && mv.en) return mv.en;
      const alt = (typeof globalThis !== "undefined" && globalThis.H3_TECH_EN) || null;
      return (alt && ev.tech && alt[ev.tech]) || ev.techEn || ev.tech || '';
    };
    const fxEn = (s) => (s == null ? '' : (EN_FX[s] || s));
    // 击飞 / 击倒 / 起身（2026-09-29 加）：放在 describe() **最前面**，避免被后面的分支结构吃掉
    //   （第一版插在 landing 旁边没生效：实测 P.describe() 直接返回 "knockdown" 这种英文 token）。
    if (e.type === 'launch') return english
      ? (b + ' is knocked off the ground by ' + techEn(e) + ' (launch speed ' + num(e.vz) + ' m/s, apex about ' + num(e.apex) + ' m, ' + num(e.airT) + ' s airborne - helpless until landing; the launch starts on the very same frame as the hit, never after a pause)')
      : (a + '被「' + (e.tech || '这一下') + '」打得离地（抛起 ' + num(e.vz) + ' 米每秒、最高约 ' + num(e.apex) + ' 米、滞空 ' + num(e.airT) + ' 秒' + (e.power === 'strong' ? '，对手力量压过自己' : (e.power === 'weak' ? '，对手力量不及' : '，力量相当')) + '——**离地就发生在命中的同一拍里**，是这一下的直接延续，不是站定/停顿之后再起飞；这几秒他在空中是失控的，别写成站着挨打）');
    if (e.type === 'knockdown') return english
      ? (b + ' is knocked down' + (e.how === '破势' ? ' as the guard breaks' : (e.how === '连招收尾' ? ' at the end of the combo' : (e.impact ? ' by the landing impact' : ''))) + ' and stays on the ground for ' + num(e.downT || 1.6) + ' s, then needs 0.6 s to push back up')
      : (a + '被打倒' + (e.how ? '（' + e.how + '）' : (e.impact ? '（落点冲击 ' + num(e.impact) + '）' : '')) + '，就地躺倒（躺 ' + num(e.downT || 1.6) + ' 秒，之后还要 0.6 秒撑地爬起——这段时间不许切镜、不许让他立刻站直，胜者收势等待）');
    if (e.type === 'getup') return english
      ? (b + ' pushes back up to the feet (0.6 s rise, not an instant stand)')
      : (a + '撑地爬起（起身过程 ' + num(e.riseT || 0.6) + ' 秒，站起身才算这一拍结束）');
    const fxList = (arr) => (arr || []).map(fxEn).join(', ');
    // 起跳原因（内核 canLeap 带出来的 why）：提示词要写清"为什么跳"，不许无逻辑弹跳
    const LEAP_WHY_ZH={evade:'为躲开来招',attack:'为跃起重击',antiAir:'为迎空拦截',close:'为突进接近',chase:'为追击',reposition:'借墙换位',escape:'为脱离'};
    const LEAP_WHY_EN={evade:'to slip the incoming line',attack:'to leap into a strike',antiAir:'to intercept in the air',close:'to close the distance',chase:'to run the opponent down',reposition:'to take a wall angle',escape:'to break off'};
    const SPECIAL={takeoff:1,landing:1,landing_shock:1,obstacle_hit:1,ring_out:1,slip:1,splash:1,cornered:1,
                   wall_run:1,wall_kick:1,hover:1,hover_end:1,spell_cast:1,spell_release:1,spell_hit:1,spell_fade:1,air_recover:1,qi_burst:1,aura:1,afterimage:1,phenomenon:1,filler:1,
                   trait:1,clone_hit:1,clone_miss:1,trait_end:1,ward_hold:1,
                   spell_after:1,ground_scar:1,spell_absorbed:1,spell_guard:1,ward_broken:1,
                   // 快节奏事件（2026-09-25）：冲刺/追击、施法移位、悬停绕飞、待机活步、蓄力被贴身改招
                   dash:1,dash_end:1,cast_move:1,hover_move:1,footwork:1,cast_cancel:1,
                   prop_broken:1,debris:1,quake:1};
    if(SPECIAL[e.type]){
      const who=name(e.who),other=name(e.who2);
      if(english){
        if(e.type==='takeoff') return who+' leaps into the air'+(e.peak!=null?(' to about '+e.peak.toFixed(2)+' m'):'')+(LEAP_WHY_EN[e.why]?(' ('+LEAP_WHY_EN[e.why]+')'):'');
        if(e.type==='landing') return who+' lands'+(e.hard?' hard':'')+(e.from>1?' from '+e.from+' m':'')+(e.water?' into the water':'');
    if(e.type==='launch') return who+' is knocked off the ground by '+(e.tech||'the blow')+' (launch speed '+num(e.vz)+' m/s)';
    if(e.type==='knockdown') return who+' is knocked down'+(e.how==='破势'?' as the guard breaks':(e.how==='连招收尾'?' at the end of the combo':''))+' and hits the ground';
    if(e.type==='getup') return who+' rolls back to the feet and re-sets the stance';
        if(e.type==='landing_shock') return who+' lands and shockwaves '+other;
        if(e.type==='obstacle_hit') return who+' strikes the '+fxEn(e.propName)+((e.broke?' and shatters it':' — the cover blocks the line'))+(e.spell?' (spell)':'');
        if(e.type==='ring_out') return who+' is knocked off the platform (ring-out #'+e.times+')';
        if(e.type==='slip') return who+' slips on the wet ground';
        if(e.type==='splash') return who+' splashes through the water';
        if(e.type==='wall_run') return who+' runs along the wall (wall '+e.wall+') at '+num(e.z)+' m';
        if(e.type==='wall_kick') return who+' kicks off the wall (wall '+e.wall+')';
        if(e.type==='hover') return who+' hovers in mid-air at '+num(e.z)+' m ('+fxEn(e.mob||'flight')+')';
        if(e.type==='hover_end') return who+' stops hovering at '+num(e.z)+' m';
        if(e.type==='spell_cast') return who+' begins casting '+techEn(e)+' from '+num(e.dist)+' m';
        if(e.type==='spell_release') return who+' releases '+techEn(e)+' towards the target ('+num(e.dist)+' m, '+num(e.spd)+' m/s)';
        if(e.type==='spell_hit') return techEn(e)+' cast by '+name(e.by)+' hits '+who+' from '+num(e.range)+' m';
        if(e.type==='ward_hold') return who+'\'s ward absorbs '+name(e.by)+'\'s '+fxEn(e.from)+' without breaking the charge of '+fxEn(e.tech)+' ('+num(e.chargeT)+' s wind-up, '+num(e.castT)+' s in)';
        if(e.type==='spell_absorbed') return fxEn(e.tech)+' bursts against '+who+'\'s ward and is shed off ('+num(e.range)+' m in flight)';
        if(e.type==='ward_broken') return who+'\'s ward shatters under '+fxEn(e.from)+' - the spell drives through';
        if(e.type==='spell_guard') return who+' guards '+fxEn(e.tech)+' with the weapon ('+(e.through?'the force drives through, damage reduced':'fully held')+', guard left '+num(e.guard)+')';
        if(e.type==='spell_after') return who+' takes the aftermath of '+fxEn(e.tech)+': '+fxEn(e.zh||e.kind)+' (stun '+num(e.stun)+' s, pushed '+num(e.kb)+' m)';
        if(e.type==='ground_scar') return 'the ground under '+who+' is marked by '+fxEn(e.tech)+' (radius '+num(e.radius)+' m): '+fxEn(e.zh||e.kind);
        if(e.type==='air_recover') return who+' recovers mid-air at '+num(e.z)+' m and lands on their feet';
        if(e.type==='qi_burst') return who+' releases an internal-energy shockwave on contact ('+fxEn(e.tech)+', radius '+num(e.radius)+' m) that hurls '+other+' back '+num(e.kb)+' m';
        if(e.type==='aura') return who+' flares an aura of '+fxEn(e.palette||'qi')+' ('+fxEn(e.tech||'internal energy')+')';
        if(e.type==='afterimage') return who+' blurs into afterimages at '+num(e.speed)+' m/s'+(e.air?' in mid-air':'');
        if(e.type==='phenomenon') return (e.finisher?'finisher: ':'')+'the impact erupts into a '+fxEn(e.palette)+' phenomenon ('+fxEn(e.shape)+', radius '+num(e.radius)+' m): '+fxList(e.destruction)+(e.pillar?'; a light pillar rises':'');
        if(e.type==='prop_broken') return 'the '+fxEn(e.propName)+' is smashed apart'+(e.building?' (a structure, not a prop)':'')+(e.mega?' — it comes down in chunks':'');
        if(e.type==='debris') return 'debris flies from the '+fxEn(e.propName)+' ('+(e.pieces||0)+' pieces across '+(e.spread||0)+' m)';
        if(e.type==='quake') return 'the ground shakes over '+(e.radius||0)+' m'+(e.mega?'; dust rolls across the whole field':'');
        if(e.type==='dash') return who+' sprints in ('+(e.zh||e.whyZh||'closing')+'), '+(e.speed||0)+' m/s over '+(e.dist||0)+' m';
        if(e.type==='dash_end') return who+' checks the sprint after '+(e.dist||0)+' m at about '+(e.speed||0)+' m/s';
        if(e.type==='cast_move') return who+' keeps moving while charging '+fxEn(e.tech||'the spell')+' ('+(e.zh||'footwork')+', '+(e.speed||0)+' m/s, '+(e.dist||0)+' m apart)';
        if(e.type==='hover_move') return who+' orbits in mid-air to find the angle at '+(e.z||0)+' m ('+(e.zh||'repositioning')+')';
        if(e.type==='footwork') return who+' keeps the feet alive: '+(e.zh||'small circling steps')+' at '+(e.speed||0)+' m/s';
        if(e.type==='cast_cancel') return who+' is crowded mid-charge and drops '+fxEn(e.tech||'the spell')+' into a close-range '+fxEn(e.toTech||'strike')+' instead';
        if(e.type==='filler') return who+(e.kind==='press'?' has no move ready and steps in':(e.kind==='flank'?' has no move ready and circles for an angle':' has no move ready and resets a half-step back'));
        if(e.type==='trait'){
          const T={clone:'clone technique',transform:'transformation',dharma:'dharma form',somersault:'somersault cloud',sixarm:'three heads six arms',eye:'third eye',windfire:'wind-fire wheels'};
          const tn=T[e.trait]||e.trait;
          if(e.stage==='spawn') return who+' splits off '+(e.count||3)+' clones with a '+tn+' — they all strike half a beat apart';
          if(e.stage==='shift') return who+' vanishes in a puff of smoke and reappears transformed ('+tn+') — the next strike breaks straight through a guard';
          if(e.stage==='rise') return who+' grows into an enormous '+tn+' (radius '+num(e.radius)+' m) and brings it down, warping the ground';
          if(e.stage==='leap') return who+' rides the '+tn+' from ('+((e.from||[]).join(', '))+') to ('+((e.to||[]).join(', '))+')';
          if(e.stage==='grow') return who+' grows extra arms ('+tn+') and attacks noticeably faster';
          if(e.stage==='ignite') return who+' ignites the '+tn+' and moves noticeably faster';
          if(e.stage==='open') return who+' opens the '+tn+' and strips the opponent of every change and ward';
          return who+' uses '+tn;
        }
        if(e.type==='clone_hit') return 'a clone of '+name(e.by)+' lands another strike on '+who+' (clones left '+(e.left||0)+')';
        if(e.type==='clone_miss') return 'a clone of '+who+' swings through empty air';
        if(e.type==='trait_end') return who+'\'s '+(e.trait||'technique')+' fades out';
        return who+'’s '+techEn(e)+' dissipates without hitting';
      }
      if(e.type==='takeoff') return who+'腾空跃起'+(LEAP_WHY_ZH[e.why]?('（'+LEAP_WHY_ZH[e.why]+'）'):'')+(e.peakZh?('，'+e.peakZh):'');   // 起跳原因必须在正文里（不许无逻辑弹跳），有峰值描述时也要保留
      if(e.type==='landing') return who+'落地'+(e.hard?'（重落）':'')+(e.from>1?'，自 '+e.from+' 米高处砸下':'')+(e.water?'，水花四溅':'');
    if(e.type==='launch') return who+'被「'+(e.tech||'这一下')+'」打得离地（抛起 '+num(e.vz)+' 米每秒，'+(e.power==='strong'?'对手力量压过自己':(e.power==='weak'?'对手力量不及':'力量相当'))+'）';
    if(e.type==='knockdown') return who+'被打倒'+(e.how?('（'+e.how+'）'):(e.impact?('（落点冲击 '+num(e.impact)+'）'):''))+'，就地躺倒';
    if(e.type==='getup') return who+'翻身起身，重新摆出架势';
      if(e.type==='landing_shock') return who+'落地冲击震开'+other+'（半径 '+e.r+' 米）';
      if(e.type==='obstacle_hit') return who+'以「'+e.tech+'」砸在'+e.propName+'上'+(e.broke?'，'+e.propName+'碎裂':'（掩体挡住线路）')+(e.spell?'（隔空打碎掩体）':'');
      if(e.type==='ring_out') return who+'被震下擂台（第 '+e.times+' 次掉台，翻身跃回）';
      if(e.type==='slip') return who+'在湿滑地面上打滑失衡';
      if(e.type==='splash') return who+'踏水而过，水花溅起';
      if(e.type==='wall_run') return who+'踏墙上墙，沿墙面飞走（'+num(e.z)+' 米高处）';
      if(e.type==='wall_kick') return who+'蹬墙翻身弹开';
      if(e.type==='hover') return who+'凭空浮在 '+num(e.z)+' 米高处（'+(e.mob||'凌空')+'）';
      if(e.type==='hover_end') return who+'收功落地（'+num(e.z)+' 米处）';
      if(e.type==='spell_cast') return who+'在 '+num(e.dist)+' 米外起手「'+e.tech+'」：'+(e.prep?e.prep+'，':'')+'准备 '+(e.chargeRange?num(e.chargeRange[0])+'~'+num(e.chargeRange[1]):num(e.chargeT))+' 秒（实取 '+num(e.chargeT)+' 秒）'+(e.shape?('，形态 '+e.shape):'')+(e.track?'，会追踪':'')+(e.radius?('，作用范围约 '+num(e.radius)+' 米'):'');
      if(e.type==='spell_release') return who+'的「'+e.tech+'」脱手：'+(e.fire?e.fire+'；':'')+'释放时间 '+(e.releaseRange?num(e.releaseRange[0])+'~'+num(e.releaseRange[1]):num(e.releaseT))+' 秒（实飞 '+num(e.actualFly)+' 秒，'+num(e.spd)+' 米每秒）'+(e.track?'，飞行中自动修正方向追踪对手':'')+'，距对手 '+num(e.dist)+' 米';
      if(e.type==='spell_hit') return name(e.by)+'的「'+e.tech+'」隔空击中'+who+'（'+num(e.range)+' 米外）';
      if(e.type==='ward_hold') return who+'的护体光膜硬吃了'+name(e.by)+'的「'+e.from+'」（伤害减半、被推开半步），「'+e.tech+'」的蓄力没断（蓄力 '+num(e.chargeT)+' 秒，此时已蓄 '+num(e.castT)+' 秒）';
      if(e.type==='spell_absorbed') return '「'+e.tech+'」撞在'+who+'的护体光膜上被卸开（飞了 '+num(e.range)+' 米，气劲在膜外炸成一圈）';
      if(e.type==='ward_broken') return who+'的护体被'+name(e.by)+'的「'+e.from+'」震碎，法术顺势推进去';
      if(e.type==='spell_guard') return who+'用兵器架住「'+e.tech+'」（'+(e.through?'力大势沉、防御被压开（减伤通过）':'完整挡下')+'，护体剩 '+num(e.guard)+'，人被推开 '+num(e.push)+' 米）';
      if(e.type==='spell_after') return who+'吃了「'+e.tech+'」的后果：'+(e.zh||e.kind)+'（硬直 '+num(e.stun)+' 秒、被推开 '+num(e.kb)+' 米）';
      if(e.type==='ground_scar') return who+'脚下的地面被「'+e.tech+'」留下痕迹（半径约 '+num(e.radius)+' 米）：'+(e.zh||e.kind);
      if(e.type==='air_recover') return who+'在'+num(e.z)+'米高处凌空受身，就地稳住落地';
      // 连段脱出（受身）：被连到第三下之后翻出去 —— 提示词里必须写出来，
      //   否则「一方被压着打」的段落没有转折，观众看到的就是沙包。
      if(e.type==='combo_break') return who+'被连到第 '+(e.hits||3)+' 下时受身翻出，贴地一滚重新拉开距离（'+name(e.by)+'的连段到此打断）';
      // ── 神通（分身术/七十二变/法相天地/筋斗云/三头六臂/天眼/风火轮）──
      if(e.type==='trait'){
        const T={clone:'分身术',transform:'七十二变',dharma:'法相天地',somersault:'筋斗云',sixarm:'三头六臂',eye:'天眼',windfire:'风火轮'};
        const tn=e.zh||T[e.trait]||'神通';
        if(e.stage==='spawn') return who+'施「'+tn+'」：抖身分出 '+(e.count||3)+' 个分身，各持兵器错开半拍同时出手';
        if(e.stage==='shift') return who+'施「'+tn+'」：一团烟雾罩住身形，烟散时形态已变，紧接一击直破防守';
        if(e.stage==='rise') return who+'施「'+tn+'」：气机拔高、身形化作巨大法相（作用半径约 '+num(e.radius)+' 米），一击压落，地面被压得变形';
        if(e.stage==='leap') return who+'施「'+tn+'」：云气一托，从 ('+((e.from||[]).join('，'))+') 翻腾到 ('+((e.to||[]).join('，'))+')';
        if(e.stage==='grow') return who+'施「'+tn+'」：肩背长出额外手臂，出手明显变快';
        if(e.stage==='ignite') return who+'施「'+tn+'」：脚下生火，移动明显变快';
        if(e.stage==='open') return who+'施「'+tn+'」：额上天眼睁开，一道神光把对手的变化与护体一起破掉';
        return who+'施展「'+tn+'」';
      }
      if(e.type==='clone_hit') return name(e.by)+'的分身又补上一下，'+who+'被这一下打得身形一晃（还剩 '+(e.left||0)+' 个分身）';
      if(e.type==='clone_miss') return who+'的分身扑空，在半空散成一片光点';
      if(e.type==='trait_end') return who+'的神通收势，'+who+'重新回到招式上';
      if(e.type==='qi_burst') return who+'的「'+e.tech+'」气劲在「'+e.from+'」命中时外放（半径 '+num(e.radius)+' 米，把'+(name(e.who2)||(e.who==='A'?name('B'):name('A')))+'再震开 '+num(e.kb)+' 米）';
      if(e.type==='aura') return who+'沉腰蓄气，体表涨起一圈'+(e.palette||'气劲')+'灵光'+(e.shapeKind?('（'+e.shapeKind+'）'):'')+'，半径约 '+num(e.radius)+' 米、持续 '+num(e.hold)+' 秒'+(e.light?('，'+e.light):'')+'，随后「'+(e.tech||'内力')+'」脱手';
      if(e.type==='prop_broken') return '「'+(e.propName||'杂物')+'」'+(e.mega?'崩成碎块、整座塌下来':(e.building?'轰然倒塌、砖石四散':'炸裂粉碎'))+'（冲击半径 '+(e.radius||0)+' 米）';
      if(e.type==='debris') return '「'+(e.propName||'杂物')+'」的'+(e.zh||'碎块')+'——约 '+(e.pieces||0)+' 片，散开 '+(e.spread||0)+' 米';
      if(e.type==='quake') return '地面震荡 '+(e.radius||0)+' 米'+(e.mega?'：地裂墙塌，尘浪掀翻整片场地':'，尘土扬起、脚下发麻');
      if(e.type==='dash') return who+'**冲刺**'+(e.zh?('（'+e.zh+'）'):'')+'：约 '+num(e.speed)+' 米每秒、一个箭步 '+num(e.dist)+' 米扑上去';
      if(e.type==='dash_end') return who+'冲刺收脚（冲了 '+num(e.dist)+' 米，均速约 '+num(e.speed)+' 米每秒，收在对手身前半步）';
      if(e.type==='cast_move') return who+'**踏罡步斗**：'+(e.zh||'边结印边移位')+'（'+num(e.speed)+' 米每秒，与对手 '+num(e.dist)+' 米，手里还捏着「'+(e.tech||'法术')+'」）';
      if(e.type==='hover_move') return who+'凌空'+(e.zh||'绕飞找角度')+'（'+num(e.z)+' 米高处，横向 '+num(e.speed)+' 米每秒）';
      if(e.type==='footwork') return who+(e.zh||'小步踩点换角度')+'（'+num(e.speed)+' 米每秒，没停过脚）';
      if(e.type==='cast_cancel') return who+'刚起手就被贴到脸上：来不及蓄满「'+(e.tech||'法术')+'」，索性收功改近身「'+(e.toTech||'掌击')+'」';
      if(e.type==='afterimage') return who+'以 '+num(e.speed)+' 米每秒掠过，留下'+(e.palette||'')+'残影'+(e.air?'（凌空）':'');
      if(e.type==='phenomenon') return (e.finisher?'终结一击：':'')+'命中处炸开'+(e.palette||'')+'天地异象（'+(e.shape||'')+'，半径 '+num(e.radius)+' 米）：'+((e.destruction||[]).join('、'))+(e.pillar?'，光柱自天而降':'')+(e.cracks?'，地面裂开':'')+(e.light?'，'+e.light:'');
      // 兜底不再写「undefined」：法术名缺失时用"这记法术/内力技"，英文同理（实测出片稿里出现过「沈砚的「undefined」飞出界外」）
      return who+'的「'+(e.tech||e.label||'这记法术')+'」飞出界外自行消散';
    }
    // 招式库：出招句写"准备动作→出招动作"（带时间范围），命中句写"华丽效果"
    //   （MV / moveOf 已经在函数开头取好了，英文分支与中文分支共用同一份）
    const rng2 = (rg) => rg ? (num(rg[0]) + '~' + num(rg[1])) : '';
    // 招式套路（2026-10-01 用户要求）：一招＝一整套组合套路，素材必须把"里面包含的动作"全写出来
    const routineZhTxt = (ev) => {
      if (!ev || !ev.routineZh) return '';
      const list = (ev.steps || []).filter(Boolean);
      return '｜这一招是**一整套套路**「' + ev.routineZh + '」' + (list.length ? ('，里面依次是：' + list.join(' → ')) : '')
        + '（动作要连着做完，中间不许站直重新起势' + (ev.routineNote ? ('；要点：' + ev.routineNote) : '') + '）';
    };
    const zh={attack:()=>{
        const mv = moveOf(e);
        const base = name(e.who)+'使出「'+e.tech+'」';
        if (mv && mv.prep && mv.act) {
          return base + '：' + mv.prep + '（准备 ' + rng2(mv.timing && mv.timing.charge) + ' 秒）→ '
            + mv.act + '（有效 ' + rng2(mv.timing && mv.timing.active) + ' 秒）'
            + (e.dur ? '（起手 ' + num(e.dur.w) + ' 秒／有效 ' + num(e.dur.a) + ' 秒／收招 ' + num(e.dur.r) + ' 秒）' : '')
            + (mv.range ? '，距离 ' + rng2(mv.range) + ' 米' : '') + routineZhTxt(e);
        }
        return base + (e.dur?('（起手 '+num(e.dur.w)+' 秒／有效 '+num(e.dur.a)+' 秒／收招 '+num(e.dur.r)+' 秒）'):'') + routineZhTxt(e);
      },
      // 套路的每一式单独成句：谁、哪一套、第几式、这一式具体在做什么（手脚／打击部位／目的）
      routine_step:()=>{
        return name(e.who) + '的「' + (e.routineZh || '') + '」打到第 ' + e.step + '/' + e.steps + ' 式·' + e.stepZh
          + '（' + (e.actZh || '') + '·' + (e.limb || '') + '）——' + (e.note || '')
          + '，这一下递向' + name(e.to) + '；式子之间不许停，下一式半拍之内接上';
      },
      hit:()=>{
        const mv = moveOf(e);
        // 招式库效果是五段式（起手｜发力｜命中｜余势｜反馈）；出招句已经写过了起手/发力/距离，
        // 所以命中句只取「命中＋反馈」两段 —— 两句拼起来正好是完整五段，不重不漏。
        const effTxt = mv ? ((MV && typeof MV.impactOf === "function") ? MV.impactOf(mv) : mv.effect) : "";
        const eff = effTxt ? '——' + effTxt + '。' : '';
        // 连招命中要写清"连到第几下"（用户要求：招式的每一式都要记录完整）
        const stepBit = e.stepZh ? ('（连招第 ' + e.step + ' 式：' + e.stepZh + '）') : '';
        return e.spell? (name(e.by)+'的「'+e.tech+'」隔空命中'+b+'（'+num(e.z)+' 米高度），伤害'+e.dmg+eff+stepBit)
                      : (a+(e.air?'自 '+num(e.az)+' 米高处':'')+'以「'+e.tech+'」命中'+b+(e.air?'（凌空）':'（受击高度 '+num(e.z)+' 米）')+'，伤害'+e.dmg+eff+stepBit);
      },
      block:()=>{ const T=defTechnique(e,'block',r); return e.spell? (b+'以兵器中段横架'+a+'的「'+e.tech+'」（隔空被挡，接触点卸向一侧）') : (b+T.replace('{t}','「'+e.tech+'」')); },
      dodge:()=>e.roll
        ? (b+'贴地翻滚让开：矮身滚过这一招，碎屑与泥水被带起，起身已换到对手侧后')
        : (b+defTechnique(e,'dodge',r)),clash:()=>name(e.a)+'与'+name(e.b)+'兵器对拼',
      // 受身/翻滚脱出（2026-10-01 打斗智商）：被连段打开的那一拍，素材要读得懂是「脱出」而不是「又挨一下」
      combo_break:()=>b+(e.roll?'受身翻滚脱出（贴地一滚，起身已换到对手侧后）':'受身翻出，重新拉开距离')+'——'+name(e.by)+'的连段到此打断',
      guardbreak:()=>b+'被'+a+'击破架势',
      ko:()=>e.ringOut? who4(e)+'四次掉台，判负' : a+'以「'+e.tech+'」'+(e.air?'凌空':'')+'使'+b+'失去战斗能力',
      round_over:()=> '本场结束，胜者'+name(e.winner),whiff:()=>b+'出招落空'+(e.cover?'（被掩体挡住）':''),
      // 间隙动作：招式冷却／气力不足时用身法填空档（写提示词时这段该写成"垫步/绕步"，不是"站着不动"）
      filler:()=>who4(e)+(e.kind==='press'?'招式未冷却，垫步压进逼住距离':(e.kind==='flank'?'招式未冷却，绕步换位找角度':'招式未冷却，撤半步重整架势'))};
    function who4(ev){ return r[ev.who]?r[ev.who].name:ev.who; }
    if(english) return `${e.type}: ${a}${b!==a?' -> '+b:''}${e.tech?' ('+techEn(e)+')':''}${e.dmg!=null?', damage '+e.dmg:''}`;
    return zh[e.type]?zh[e.type]():e.type;
  }
  /** 防御手法词（2026-10-01 用户：「防御动作就是双拳抱着脸硬扛，要改成会用手去格挡，还有闪避」）：
   *  格挡必须写清"用什么部位／兵器哪一段去挡 + 卸力方向"；闪避必须写清类型与让开的线。
   *  词表按兵器分家，按事件秒数确定性挑选（同一 seed 复现）。 */
  function defTechnique(e, kind, r) {
    const F = (r && r[e.who]) || {};
    const w = weaponKindOf(F);
    const k = Math.abs(Math.round((+e.t || 0) * 10)) % 3;
    if (kind === 'block') {
      if (w === 'bare') return [
        '抬起前臂外侧拍格{t}（接触点受力、手臂一震），侧身把力卸向外侧',
        '前臂内侧格住{t}、后脚后坐卸力，重心压回后腿',
        '抬手拍偏{t}的来路，借对方劲道把刃线拨到身侧'][k];
      if (w === 'long') return [
        '横棍架住{t}的中段（棍身一震），顺势往下压住对方的兵器',
        '侧身以棍尾上架{t}，接触点卸向斜上方，重心后坐',
        '用棍身中段格开{t}，借力把对方兵器带向身侧空档'][k];
      return [
        '以兵器中段横架{t}，接触点一震、刃口贴着来招滑开（卸力）',
        '侧身用刀背（剑脊）格住{t}，把力卸向斜下',
        '垂手挂开{t}的来路，借他的劲把刃线拨到身侧'][k];
    }
    // 徒手场次不说"刃线/刃尖"（那是器械的词）
    const line = (w === 'bare') ? '来招' : '刃线';
    const tip = (w === 'bare') ? '拳锋' : '刃尖';
    return [
      '侧闪：错步侧身让开' + line + '（衣摆被带起），落位即稳',
      '后仰摇闪：上身后仰让' + line + '从头前擦过，脚跟没离地',
      '下潜避过：屈膝下潜到' + line + '之下，起身时已换到对手外侧',
      '绕步换角度：半步绕到对手侧面，让这一招走空',
      '撤步拉开：后脚先撤半步把距离拉回，' + tip + '只擦过衣襟'][
      Math.abs(Math.round((+e.t || 0) * 10)) % 5];
  }
  // ── 分镜规划：默认少切镜（能一镜到底就一镜到底）─────────────────────
  //   用户反馈：切太频繁 + 切完位置不对/换人。
  //   2026-09-25 又补一句：「这切换镜头和打斗不连贯，一切镜什么都变了」——视频模型**没有跨镜记忆**，
  //   切得越多，每一镜越会被当成"新场景"重画（换脸/换衣服/换场地/换光）。所以默认档改成"宁可少切"：
  //   一镜到底优先，长片长也最多 3 刀（原来 12 秒就 2 镜、30 秒 4 镜）。
  function shotCount(sec, want){
    const w=String(want==null?'auto':want);
    if(/^[1-6]$/.test(w)) return +w;
    const s=+sec||0;
    if(s<=15) return 1;
    if(s<=26) return 2;
    return 3;
  }
  const CAM_ONESHOT=['One continuous take, no cuts'];
  // ── 官方（MiniMax H3 提示词指南）对「切镜/运镜/时长」的硬口径（2026-09-25 查证后照抄）───────
  //   §4.2：「A cut should introduce new information about the subject, space, state, viewpoint, or time.
  //          If only the distance or a slight angle needs to change, prefer camera motion.」
  //         ⇒ 只是改景别/微调角度就别切，改用运镜；切镜必须带来新信息。
  //         [Shot 1] **不带时间码**；后续镜一律 `[Shot 2] At 00:03.500, the camera cuts to…`。
  //   §4.3：运镜＝运动类型＋幅度＋速度，写成句子里的自然动作；**方括号运镜（[Pan left]）是 Hailuo Director
  //         老语法，H3 不认**。
  //   官方限制：单次生成 4–15 秒整数、提示词 ≤7000 字符、24fps ⇒ 长架必须切成若干 ≤15 秒的段逐段生成。
  //   官方建议：FL2VA 倾向单镜；I2VA 要求身份/服装/颜色/关键物件/空间关系保持一致 ⇒ 跨段一致性靠
  //         `<Subject N>` 定义 + retention_analysis 枚举 + 首尾帧对齐句（放在提示词第一行）。
  const H3_LIMITS = { minSeconds: 4, maxSeconds: 15, maxPromptChars: 7000, fps: 24 };
  const CAM_LADDER = [
    'The camera tracks with small amplitude at slow speed, keeping both fighters framed',
    'The camera trucks right with small amplitude at fast speed, staying on the attacker',
    'The camera pushes in with small amplitude at fast speed on the impact, then pulls out at slow speed',
    'The camera arcs with large amplitude at slow speed around the clash',
    'The camera pedestals up with large amplitude at fast speed as the fight leaves the ground',
    'The camera holds a static shot, letting the fighters travel through frame'
  ];
  const CAM_ONESHOT_PROSE = 'The camera holds one continuous tracking shot with small amplitude at slow speed — no cuts';
  /** 官方时间码：`At 00:03.500,`（分:秒.毫秒） */
  function h3Stamp(t) {
    const v = Math.max(0, +t || 0);
    const m = Math.floor(v / 60), sec = v - m * 60;
    return 'At ' + String(m).padStart(2, '0') + ':' + (sec < 10 ? '0' : '') + sec.toFixed(3) + ',';
  }
  /** 在 [lo,hi] 里挑一个「最像一拍打完」的切点（起手/锁定窗口一律禁选） */
  function bestCutInside(r, cfg, lo, hi) {
    const tl = shotTimeline(r, cfg);
    let best = null;
    for (let t = lo; t <= hi; t += 0.1) {
      const tt = +t.toFixed(2);
      if (tl.inLock(tt)) continue;
      const sc = cutScore(r, tt, tl);
      if (sc >= 999) continue;
      if (!best || sc < best.sc) best = { t: tt, sc: sc };
    }
    return best ? best.t : null;
  }
  /**
   * 分段计划（官方：单次生成 4–15 秒）——整场按节拍安全点切成若干 ≤15 秒的段；
   *   每段＝一次生成、**段内一镜到底**（只用运镜，段内不再切镜；官方 §4.2「能运镜就别切」）。
   */
  function clipPlan(r, cfg) {
    const durSim = +r.duration || 0;
    if (!(durSim > 0.5)) return [{ n: 1, k0: 0, k1: +durSim.toFixed(2), sec: +durSim.toFixed(2), oneTake: true }];
    // 用户/页面手动指定镜数时优先照办（只要每段都落在官方 4–15 秒区间里）：
    //   `'1'` 强制一镜到底，`'3'` 强制三镜——切点仍取最近的"节拍安全点"。
    const want = parseInt(String((cfg && cfg.shotPlan) || 'auto'), 10);
    if (want >= 1 && want <= 8 && (want === 1 || durSim / want >= H3_LIMITS.minSeconds)) {
      const steps = [];
      for (let k = 1; k < want; k++) {
        const ideal = durSim * k / want;
        const lo = Math.max(0.2, ideal - Math.min(1.6, durSim / want / 3));
        const hi = Math.min(durSim - 0.2, ideal + Math.min(1.6, durSim / want / 3));
        let t = null;
        try { t = bestCutInside(r, cfg, lo, hi); } catch (e) { t = null; }
        steps.push(t == null ? +ideal.toFixed(2) : t);
      }
      const b2 = [0].concat(steps).concat([+durSim.toFixed(2)]);
      const okLen = b2.every((x, i) => i === 0 || (x - b2[i - 1]) <= H3_LIMITS.maxSeconds + 1e-6);
      if (okLen) {
        const o2 = [];
        for (let i = 0; i < b2.length - 1; i++) o2.push({ k0: +b2[i].toFixed(2), k1: +b2[i + 1].toFixed(2) });
        return o2.map((x, i) => ({ n: i + 1, k0: x.k0, k1: x.k1, sec: +(x.k1 - x.k0).toFixed(2), oneTake: true }));
      }
    }
    let bounds = [0].concat(cutPoints(r, cfg)).concat([+durSim.toFixed(2)]);
    const split = [];
    for (let i = 0; i < bounds.length - 1; i++) {
      let a = bounds[i]; const b = bounds[i + 1];
      while (b - a > H3_LIMITS.maxSeconds) {
        let t = bestCutInside(r, cfg, a + H3_LIMITS.minSeconds, a + H3_LIMITS.maxSeconds);
        //   官方 4–15 秒是**硬限**：这一段里找不到"节拍安全点"也必须切（切在 15 秒处），
        //   否则会出现 16 秒以上的段（实测：28.7 秒的场次切出 12.6 + 16.1）。
        if (!(t > a + 0.5)) t = Math.min(b - 0.2, a + H3_LIMITS.maxSeconds);
        if (!(t > a + 0.5)) break;
        split.push(+t.toFixed(2)); a = t;
      }
      split.push(b);
    }
    bounds = [0].concat(split);
    const out = [];
    for (let i = 0; i < bounds.length - 1; i++) {
      const k0 = bounds[i], k1 = bounds[i + 1];
      const last = out[out.length - 1];
      if (last && (k1 - k0) < H3_LIMITS.minSeconds) { last.k1 = k1; continue; }
      out.push({ k0: +k0.toFixed(2), k1: +k1.toFixed(2) });
    }
    // ── 收尾平衡（2026-10-01）─────────────────────────────────────────────
    //   官方 4–15 秒是**上下限**，而上面的"短尾巴并回上一段"会把上一段顶到 15 秒以上
    //   （实测 28.7 秒的场次切出 12.60 + 16.10）。这里统一再平衡：只要还有段落在 [4,15] 之外，
    //   就把它和**邻居合起来重新切**（优先取节拍安全点，取不到就对半）——合并再切，而不是"切了又并"。
    for (let guard = 0; guard < 16; guard++) {
      let changed = false;
      for (let i = 0; i < out.length; i++) {
        const secI = out[i].k1 - out[i].k0;
        const tooLong = secI > H3_LIMITS.maxSeconds + 1e-6;
        const tooShort = secI < H3_LIMITS.minSeconds - 1e-6;
        if (!tooLong && !tooShort) continue;
        // 短段优先并到前一段（开场那段并到后面）；长段优先并到后一段
        let j = tooShort ? (i > 0 ? i - 1 : (i + 1 < out.length ? i + 1 : -1))
                         : (i + 1 < out.length ? i + 1 : (i > 0 ? i - 1 : -1));
        if (j < 0) break;
        const k0 = Math.min(out[i].k0, out[j].k0), k1 = Math.max(out[i].k1, out[j].k1);
        const lo = Math.min(i, j);
        let tc = bestCutInside(r, cfg, k0 + H3_LIMITS.minSeconds, k1 - H3_LIMITS.minSeconds);
        //   ⚠ 安全点必须落在"切完两段都不超过 15 秒"的窗口里：否则会切回原来那个超长段
        //     （实测 28.7 秒：安全点 12.6 → 12.6 + 16.1 死循环）。窗口为空就取中点。
        const loMax = Math.max(k0 + H3_LIMITS.minSeconds, k1 - H3_LIMITS.maxSeconds);
        const hiMax = Math.min(k1 - H3_LIMITS.minSeconds, k0 + H3_LIMITS.maxSeconds);
        if (loMax > hiMax) tc = (k0 + k1) / 2;
        else if (!(tc >= loMax && tc <= hiMax)) tc = (loMax + hiMax) / 2;
        if (!(tc > k0 + 0.5) || !(tc < k1 - 0.5)) tc = (k0 + k1) / 2;
        tc = +tc.toFixed(2);
        out.splice(lo, 2, { k0: +k0.toFixed(2), k1: tc }, { k0: tc, k1: +k1.toFixed(2) });
        changed = true; break;
      }
      if (!changed) break;
    }
    return out.map((x, i) => ({ n: i + 1, k0: x.k0, k1: x.k1, sec: +(x.k1 - x.k0).toFixed(2), oneTake: true }));
  }
  // ── 官方「空间锚点卡 + 逐秒指令」（2026-09-25 查证 MiniMax H3 官方规范后照抄）──────────────────
  //   用户：「可以不用 XYZ 坐标去控制了，你再想想法子。看下网上有没好的解决方案，特别是官方的。」
  //   官方（六列标准镜头信息表 Step 5 ＋ 单文本分镜 Step 6）里"空间"**本来就不是坐标**，而是一张
  //   **空间锚点卡**（参考锚点·空间＋身份），四个子字段全部用"画面相对位置"：
  //     ① 固定地标：有名有姓的地标＋相对画面位置（官方例子：door-frame: 右侧 1/3）
  //     ② 人物位置（机位视角）：左/中/右 · 前/中/后景 · 朝向 · 初始姿态
  //     ③ 退场人物状态：上一镜在画面、本镜不在的人 → 离屏位置＋原因
  //     ④ 光位基线：主光/补光/轮廓光方向＋本镜调整项
  //   另有两条官方跨镜机制：**连续性衔接**（接上镜／交给下镜）与 **逐秒指令**（官方 Per-Second
  //   Directives：每秒都要覆盖「动作·镜头运动·空间位置·音频线索·交接」五要素，且不许留时间空隙）。
  //   官方还专门给这类毛病起了名字：「跨片段空间锚点漂移」（门框落到错边、人物从错边离屏、光位翻转）。
  //   ⚠ 地标与位置**一律取内核真实数据**（r.props 的真实站位＋碎裂状态、场地真实尺寸、r.fx 的真实光效档），
  //     绝不凭空编地标——"甲/乙……约两步"那类假读数正是上一轮自动修复掉分的根因。
  //   官方运镜写法（§4.3）：**运动类型＋幅度＋速度**写成句子里的自然动作；方括号运镜（[Pan left]）是
  //   Hailuo Director 老语法，H3 不认。中文阶梯与英文阶梯一一对应。
  const CAM_LADDER_ZH = [
    '镜头小幅横移、慢速跟随，把两人都留在画面里',
    '镜头小幅右移、快速跟拍，始终咬住出手的一方',
    '命中瞬间镜头小幅快推，随即慢速拉回',
    '镜头绕着交手点大幅慢速环绕',
    '两人离地时镜头大幅快速上摇升镜',
    '机位固定不动，让两人自己穿画进出画'
  ];
  const _third = (v) => (v < 1 / 3 ? 0 : (v < 2 / 3 ? 1 : 2));
  // 官方写法就是"右侧 1/3"这种量词，比"画面右三分之一"省字且更贴官方样例
  const SIDE3_ZH = ['左 1/3', '中央', '右 1/3'];
  const SIDE3_EN = ['left third', 'centre of frame', 'right third'];
  const DEP3_ZH = ['前景', '中景', '背景'];
  const DEP3_EN = ['foreground', 'midground', 'background'];
  // 逐秒行里的"镜头运动"要素用**短标签**（完整官方式运镜句写在本镜抬头，逐秒行只引用，省上千字）
  const CAM_TAG_ZH = ['跟移', '右移跟拍', '快推后拉回', '环绕', '升镜', '固定'];
  const CAM_TAG_EN = ['track', 'truck right', 'push-in', 'arc', 'pedestal up', 'static'];
  // ── 用户选的运镜 / 镜头艺术（2026-09-30）─────────────────────────────────────
  //   用户反馈：「我换了运镜方式，和镜头风格这些，怎么都完全展示不出来效果，这些运镜特别在最终提示词中要描述的。」
  //   查证：页面上「运镜」（#camMode / #camCustom）与「镜头艺术」（#lensSel）原来只喂给**白膜预览**与老路线，
  //   3D 路线（compile → shots/evidenceText）**一个字都没读**，所以最终提示词里的运镜永远是自动阶梯。
  //   现在：页面把选中的运镜/镜头组合解析成纯文本塞进 cfg（camEn/camZh/camList/camSeqEn/camSeqZh/camSeqFrac/lens*），
  //   这里落地成"每镜该写哪一句运镜"。都没选 → 退回原来的 CAM_LADDER（老行为不变）。
  const CAM_TAG_GUESS = [
    [/push|zoom in|急推|推近/i, '快推', 'push-in'],
    [/pull out|zoom out|拉远|拉开/i, '后拉', 'pull out'],
    [/truck|dolly|横移|平移/i, '横移', 'truck'],
    [/arc|orbit|环绕|绕/i, '环绕', 'arc'],
    [/pedestal|crane|rise|升降|升镜|摇臂/i, '升降', 'pedestal'],
    [/whip|pan|甩镜|摇镜/i, '甩镜', 'whip pan'],
    [/pov|主观/i, '主观', 'POV'],
    [/static|固定|静帧/i, '固定', 'static'],
    [/crash|shake|急|震|撞/i, '急推', 'crash zoom'],
    [/handheld|steadicam|手持|穿行/i, '手持跟', 'handheld follow'],
    [/track|follow|跟拍|跟移|跟踪|追/i, '跟移', 'track']
  ];
  function camTagOf(phrase, zh) {
    const s = String(phrase || '');
    for (const [re, z, e] of CAM_TAG_GUESS) if (re.test(s)) return zh ? z : e;
    return zh ? '跟移' : 'track';
  }
  /**
   * 把用户选的运镜解析成"第 i 镜该写哪一句"。返回 { active, zh(i,n), en(i,n), tagZh(i,n), tagEn(i,n), noteZh, noteEn }
   *   · 「运镜」锁定档：每一镜都用它；
   *   · 「自定义运镜」：逗号/换行分开的若干条，按镜轮流用；
   *   · 「镜头艺术」组合：一整套相位序列，按各相位占比分配到各镜（一镜到底时串成一句话）；
   *   · 没选：active=false，调用方继续用 CAM_LADDER。
   */
  function cameraPlan(cfg) {
    const src = (cfg && cfg.source) || cfg || {};
    const pick = (k) => (src[k] != null ? src[k] : (cfg ? cfg[k] : null));
    const mode = String(pick('camMode') || '').trim();
    const list = (pick('camList') || []).filter((x) => String(x || '').trim());
    const camEn = String(pick('camEn') || '').trim();
    const camZh = String(pick('camZh') || '').trim();
    const lensZh = String(pick('lensZh') || '').trim();
    const lensEn = String(pick('lensEn') || '').trim();
    const lensDesc = String(pick('lensDesc') || '').trim();
    const seqEn = (pick('camSeqEn') || []).map((x) => String(x || '').trim()).filter(Boolean);
    const seqZh = (pick('camSeqZh') || []).map((x) => String(x || '').trim()).filter(Boolean);
    const fracRaw = (pick('camSeqFrac') || []).filter((x) => +x > 0).map(Number);
    const frac = fracRaw.length === seqEn.length ? fracRaw : [];
    const custom = (mode === 'custom') || list.length > 0;
    // ⚠ 界面上「运镜」的**默认档**是 tp3（全程：动态第三人称跟踪）、第二档是 auto（自动轮换）：
    //   这两档都当"没指定"，继续用 CAM_LADDER —— 阶梯每镜不同（跟移/右移跟拍/快推/环绕/升镜/固定），
    //   比"每镜都一句第三人称跟踪"更适合分镜；用户真想要固定机位就选别的档（低机位/过肩/全景…）。
    const locked = !custom && !!camEn && !!mode && mode !== 'auto' && mode !== 'tp3';
    const active = custom || locked || seqEn.length > 0;
    const phaseIdx = (i, n) => {
      if (!seqEn.length) return -1;
      const total = frac.length ? frac.reduce((a, b) => a + b, 0) : seqEn.length;
      const at = ((i + 0.5) / Math.max(1, n)) * total;
      let acc = 0;
      for (let k = 0; k < seqEn.length; k++) { acc += (frac.length ? frac[k] : 1); if (at <= acc + 1e-9) return k; }
      return seqEn.length - 1;
    };
    const oneTake = (arr) => arr.join(' → ');
    let n1 = 1;
    // 多镜时把锁定短语里的"不切镜 / no cut"去掉——那一镜本身就是切进来的（切镜句与运镜句不能互相打脸）
    const stripNoCut = (s, zh) => {
      if (n1 <= 1) return s;
      const t = zh ? String(s).replace(/[，、]?不切镜/g, '').replace(/[，、]?一镜到底/g, '')
                   : String(s).replace(/[,，]?\s*(and\s+)?no\s+cuts?\.?/ig, '');
      return t.replace(/\s{2,}/g, ' ').replace(/[，、]\s*$/g, '').trim();
    };
    const plan = {
      active, mode, camEn, camZh, lensZh, lensEn, lensDesc, list, seqEn, seqZh, frac,
      zh: (i, n) => {
        n1 = n;
        if (n <= 1 && seqZh.length) return '一镜到底、不切镜：' + oneTake(seqZh);
        if (list.length) return (n <= 1 ? '一镜到底、不切镜：' : '') + stripNoCut(list[i % list.length], true);
        if (seqZh.length) return stripNoCut(seqZh[phaseIdx(i, n)], true);
        if (camZh) return (n <= 1 ? '一镜到底、不切镜：' : '') + stripNoCut(camZh, true);
        return CAM_LADDER_ZH[Math.min(i, CAM_LADDER_ZH.length - 1)];
      },
      en: (i, n) => {
        n1 = n;
        if (n <= 1 && seqEn.length) return 'One continuous take, no cuts — the camera carries the whole fight: ' + oneTake(seqEn);
        if (list.length) return stripNoCut(list[i % list.length], false);
        if (seqEn.length) return stripNoCut(seqEn[phaseIdx(i, n)], false);
        if (camEn) return stripNoCut(camEn, false);
        return (n <= 1) ? CAM_ONESHOT_PROSE : CAM_LADDER[Math.min(i, CAM_LADDER.length - 1)];
      }
    };
    plan.tagZh = (i, n) => camTagOf(plan.zh(i, n), true);
    plan.tagEn = (i, n) => camTagOf(plan.en(i, n), false);
    plan.noteZh = !active ? '' : ('【运镜与镜头语言 · 用户指定】' +
      (camZh || camEn ? ('本场「运镜」＝' + (camZh || camEn) + (camEn ? ('（英文运镜短语：' + camEn + '）') : '') + '；') : '') +
      (lensZh ? ('「镜头艺术」＝' + lensZh + (lensDesc ? ('：' + lensDesc) : '') + '；') : '') +
      (list.length ? ('「自定义运镜」共 ' + list.length + ' 条，按镜轮流用：' + list.join('；') + '；') : '') +
      (seqZh.length ? ('镜头按这套相位推进：' + oneTake(seqZh) + '；') : '') +
      '**每一镜抬头的运镜句必须照抄素材给的那一句**（不许换成别的机位、不许只写"镜头跟随"、不许把运镜塞进句尾当标签）；' +
      '写法按官方 §4.3：运动类型＋幅度＋速度写成一句话里的自然动作（例：The camera pushes in with small amplitude at fast speed on the impact）；' +
      '方括号运镜 [Pan left] 是 Hailuo Director 老语法，H3 不认，一句都不许出现。');
    plan.noteEn = !active ? '' : ('[CAMERA / LENS · user-selected] ' +
      (camEn ? ('Camera rig: ' + camEn + '. ') : '') +
      (lensEn ? ('Camera-art combo: ' + lensEn + (lensDesc ? (' — ' + lensDesc) : '') + '. ') : '') +
      (seqEn.length ? ('Phase sequence: ' + oneTake(seqEn) + '. ') : '') +
      'Keep the camera line given for each shot verbatim (type + amplitude + speed, official §4.3); never replace it with another rig, and never use bracketed camera tags such as [Pan left].');
    return plan;
  }

  // 情景名的英文（引擎只给中文 zh，按 key 一一对应，英文成片不能夹中文）
  const SCEN_EN = { none: 'duel', field: 'field battle with breakable cover', arena: 'ring platform (stepping out is a ring-out)',
    chase: 'running chase down a long street', aerial: 'mid-air duel', water: 'slick water-soaked ground' };
  /** 空间锚点卡的真数据源：内核里**真实存在**的物件 → 固定地标（名字＋画面相对位置，跨镜不变） */
  function landmarkCard(r) {
    const AR = (r && r.arena) || { w: 20, h: 12 };
    const w = +AR.w || 20, h = +AR.h || 12;
    const props = ((r && r.props) || []).slice();
    // 显眼程度：体量（半径×高）＋建筑加权——先在场里挑最容易被观众当成参照物的那几件
    props.sort((a, b) => ((b.r || 1) * (b.h || 1.2) + (b.building ? 8 : 0)) - ((a.r || 1) * (a.h || 1.2) + (a.building ? 8 : 0)));
    const list = [], used = {}, usedName = {};
    for (const pr of props) {
      if (list.length >= 4) break;
      if (!pr) continue;
      const nm = pr.zh || pr.id; if (!nm) continue;
      if (usedName[nm]) continue;                 // 同名地标只点名一次（塔檐在背景与中景各有一件）
      const bx = _third(Math.max(0, Math.min(1, (+pr.x || 0) / w)));
      const by = _third(Math.max(0, Math.min(1, (+pr.y || 0) / h)));
      const key = bx + '-' + by;
      if (used[key]) continue;                    // 同一画格只留最显眼的一件，地标不许挤在一处
      used[key] = 1; usedName[nm] = 1;
      list.push({ id: pr.id, name: nm, nameEn: (EN_FX[nm] || nm), building: !!pr.building, broken: !!pr.broken,
        x: +(+pr.x || 0).toFixed(2), y: +(+pr.y || 0).toFixed(2),
        sideZh: SIDE3_ZH[bx], sideEn: SIDE3_EN[bx], depZh: DEP3_ZH[by], depEn: DEP3_EN[by] });
    }
    return { w: +w.toFixed(1), h: +h.toFixed(1), list: list };
  }
  /** 固定地标行：地标名＋画面相对位置；到 tEnd 为止已碎的写「已碎·碎块留在原地」（破坏要留痕、跨镜不许复原） */
  function landmarkLine(r, card, tEnd, english) {
    const bits = card.list.map((L) => {
      const broke = ((r && r.events) || []).some((e) => e.type === 'prop_broken' && e.prop === L.id && e.t <= tEnd + 1e-6);
      const where = english ? (L.sideEn + ', ' + L.depEn) : (L.sideZh + '·' + L.depZh);
      //   官方必检：空间锚点卡**每一镜逐字相同**（锚点继承）。地标的"已碎"状态属于破坏留痕，
      //   挪到本镜的【本镜破坏】行（见 destructBit），不再改锚点卡本身（实测：跨镜地标行不一致会被体检判"锚点漂移"）。
      void broke;
      return (english ? L.nameEn : L.name) + (english ? ' - ' : '＝') + where;
    });
    const bound = english
      ? ('arena ' + card.w + ' x ' + card.h + ' m; every landmark above keeps the SAME screen position in every shot (no drift)')
      : ('场地 ' + card.w + '×' + card.h + ' 米；以上地标**每一镜都在同一画面位置**，不许漂移');
    return (english ? 'Fixed landmarks (screen-relative): ' : '固定地标（相对画面位置，跨镜不变）：')
      + (bits.length ? bits.join(english ? '; ' : '；') + (english ? '; ' : '；') : '') + bound + (english ? '.' : '。');
  }
  /** 离某镜最近的地标（推不出 4 米内就不写，别硬编） */
  function nearLandmark(r, card, s, e, english) {
    let best = null;
    const ts = [s, (s + e) / 2, Math.max(s, e - 0.05)];
    for (const L of card.list) {
      for (const t of ts) {
        const f = frameAt(r, t); if (!f) continue;
        for (const id of ['A', 'B']) {
          const p = f[id]; if (!p) continue;
          const d = Math.hypot((+p.x || 0) - L.x, (+p.y || 0) - L.y);
          if (!best || d < best.d) best = { L: L, d: d };
        }
      }
    }
    if (!best || best.d > 4.0) return '';
    return (english ? 'anchor ' : '锚·') + (english ? best.L.nameEn : best.L.name)
      + (english ? (' (' + best.L.sideEn + ')') : ('（' + best.L.sideZh.replace('画面', '') + '）'));
  }
  /** Hook 类型：官方受控词表；按本镜真实事件判定，不写空话（每镜必须有一个） */
  const HOOK_ZH = { setup: '起手', reversal: '反转', reveal: '揭示', suspense: '悬念', chase: '追击',
    callback: '呼应', climax: '高潮', 'expression-beat': '表情拍' };
  function hookOf(evs, i, seen) {
    const T = {};
    evs.forEach((e) => { T[e.type] = (T[e.type] || 0) + 1; });
    const pick = (h) => h;
    if (T.ko || T.ring_out) return pick('climax');
    if (T.guardbreak || T.ward_broken || T.spell_absorbed || T.wall_kick) return pick('reversal');
    if (T.phenomenon || T.trait || T.spell_hit || (T.prop_broken || 0) > 1 || T.slam) return pick('reveal');
    if ((T.dash || 0) >= 2 || T.ring_out) return pick('chase');
    if (T.clash || T.guard || T.whiff) return pick('suspense');
    // 「呼应」：本镜的主事件类型在前面某一镜出现过（官方 callback）
    const dom = Object.keys(T).sort((a, b) => T[b] - T[a])[0];
    if (dom && seen && seen[dom] && i > 0) return pick('callback');
    if (T.hit) return pick('expression-beat');
    return i === 0 ? pick('setup') : pick('suspense');
  }
  function hookText(h, english) { return english ? ('Hook: ' + h) : ('Hook：' + h + (HOOK_ZH[h] ? ('（' + HOOK_ZH[h] + '）') : '')); }
  /** 逐秒"音频线索"（官方 §4.6 音景：不含对白）——按本秒真实事件推，静默就写静默 */
  function secSound(evs, english) {
    const has = (arr) => evs.some((e) => arr.indexOf(e.type) >= 0);
    const zh = [], en = [];
    if (has(['hit', 'clash', 'guardbreak', 'slam', 'obstacle_hit', 'spell_guard', 'block'])) { zh.push('钝击与兵器交鸣'); en.push('blunt impact and steel ringing'); }
    if (has(['spell_cast', 'spell_hit', 'phenomenon', 'trait', 'qi_burst', 'aura', 'cast_move'])) { zh.push('气劲低频嗡鸣'); en.push('low hum of qi'); }
    if (has(['prop_broken', 'debris', 'quake', 'ground_scar', 'landing_shock'])) { zh.push('碎裂与碎石落地'); en.push('shattering and falling debris'); }
    if (has(['dash', 'footwork', 'takeoff', 'landing', 'dash_end'])) { zh.push('脚步、蹬地与衣袂'); en.push('footwork, take-off and cloth'); }
    if (!zh.length) { zh.push('静·只有呼吸与脚步'); en.push('near-silent: breathing and footsteps only'); }
    return english ? en.join(' + ') : zh.join('＋');
  }
  /** 位置速记：甲左中·乙右中·2.6米（官方"左/中/右＋前/中/后景"，空/蹲/倒另标） */
  function posShort(row, english) {
    if (!row || !row.A || !row.B) return english ? '-' : '—';
    const one = (x, nm) => {
      const st = x.stance === '站姿' ? '' : (x.stance === '腾空' ? (english ? ' air' : '·空')
        : (x.stance === '倒地' ? (english ? ' down' : '·倒') : (english ? ' crouch' : '·蹲')));
      const side = english ? ({ '左': 'L', '中': 'C', '右': 'R' }[x.side] || 'C') : x.side;
      const dep = english ? ({ '更近': 'fg', '同一纵深': 'mid', '更远': 'bg' }[x.depth] || 'mid')
                          : ({ '更近': '近', '同一纵深': '中', '更远': '远' }[x.depth] || '中');
      return nm + side + dep + st;
    };
    return one(row.A, english ? 'A ' : '甲') + (english ? ' / ' : '·') + one(row.B, english ? 'B ' : '乙')
      + (english ? ' / ' : '·') + row.dist.toFixed(1) + (english ? ' m' : '米');
  }
  /** 本段的**位移读数**（2026-10-01 用户：「切 SHOT 的时候别把位置又描述一遍，直接描述动作」）：
   *  只报"谁往哪挪了多少、有没有离地"，**不重复绝对站位**——绝对站位只在第一镜交代一次，
   *  后面再写一遍就等于让模型重新摆位（观众看到的就是瞬移）。 */
  function moveShort(r, t0, t1, english) {
    const f0 = frameAt(r, t0), f1 = frameAt(r, Math.max(t0, t1 - 1 / 60));
    if (!f0 || !f1 || !f0.A || !f0.B || !f1.A || !f1.B) return english ? 'no repositioning' : '原位不动';
    const bits = [];
    for (const id of ['A', 'B']) {
      const o = id === 'A' ? 'B' : 'A';
      const p0 = f0[id], p1 = f1[id], q0 = f0[o], q1 = f1[o];
      if (!p0 || !p1 || !q0 || !q1) continue;
      const mv = Math.hypot(p1.x - p0.x, p1.y - p0.y);
      const dz = (p1.z || 0) - (p0.z || 0);
      if (mv < 0.30 && Math.abs(dz) < 0.25) continue;
      const d0 = Math.hypot(p0.x - q0.x, p0.y - q0.y), d1 = Math.hypot(p1.x - q1.x, p1.y - q1.y);
      const name = (r && r[id] && r[id].name) || id;
      const dir = (d1 < d0 - 0.25) ? (english ? 'closes in' : '前压逼近')
        : (d1 > d0 + 0.25 ? (english ? 'backs off' : '后撤拉开') : (english ? 'slides sideways' : '侧向绕步'));
      bits.push(name + (english ? ' ' : '') + dir + ' ' + mv.toFixed(1) + (english ? ' m' : ' 米')
        + (dz > 0.35 ? (english ? ' (airborne)' : '（离地）') : ''));
    }
    return bits.length ? bits.join(english ? '; ' : '；') : (english ? 'no repositioning' : '原位不动');
  }
  /**
   * 官方「逐秒指令」（Per-Second Directives）：把本镜按整秒切开，每秒一条，五个要素齐；
   *   连续几个"没有事件"的秒合并成一个区间（区间同样不留时间空隙，官方允许 `2.0–2.5s` 这类标记）。
   *   时间码相对**本镜（本次生成）**从 0 起算——官方例子就是 `0–1s`／`1–2s`。
   */
  // ── 连击链（2026-09-29，用户：「REF 生成出来一板一眼，没有香港动作片那种连续、剧烈、连贯」）──
  //   逐秒指令是**官方硬要求**（Per-Second Directives，不能删），但它本身是个"节拍器"：
  //   一秒一条、每行五要素，模型照着写就成了清单体。这里在它前面把同一批事件按**链**再写一遍：
  //   甲出手 → 乙架住 → 甲顺势再打 → 乙卸开反打，并明写"同一条链连成一口气、招与招之间不留空拍"。
  //   信息不增加（还是那些事件），但读法从"逐拍罗列"变成"连打"，成片才连贯。
  const CHAIN_STORY_RE = /^(attack|hit|block|dodge|clash|guardbreak|ko|slam|spell_hit|spell_guard|spell_absorbed|ward_broken|phenomenon|trait|landing|ring_out|launch|knockdown|getup)$/;
  function exchangeChains(r, ev, english, t0) {
    const evs = (ev || []).filter((e) => CHAIN_STORY_RE.test(e.type)).sort((a, b) => a.t - b.t);
    if (evs.length < 2) return '';
    const chains = [];
    let cur = [evs[0]];
    for (let i = 1; i < evs.length; i++) {
      if (evs[i].t - cur[cur.length - 1].t <= 0.55) cur.push(evs[i]);   // 一拍接一拍 = 同一条链
      else { chains.push(cur); cur = [evs[i]]; }
    }
    chains.push(cur);
    const nmOf = (e) => (e.who === 'A' ? r.A.name : e.who === 'B' ? r.B.name
      : (e.a === 'A' ? r.A.name : e.a === 'B' ? r.B.name : ''));
    // 中英双份措辞（英文稿里不许混中文——实测踩过）
    const phrase = (e) => {
      const nm = nmOf(e);
      switch (e.type) {
        case 'attack': return english ? (nm + (e.air ? ' leaps in with ' : ' throws ') + (e.tech || 'a strike')) : (nm + (e.air ? '凌空' : '') + '出「' + (e.tech || '一招') + '」');
        case 'hit': return english ? (nm + ' takes the hit' + (e.dmg != null ? ' (' + (+e.dmg).toFixed(1) + ' dmg)' : '')) : (nm + '被打中' + (e.dmg != null ? '（伤害 ' + (+e.dmg).toFixed(1) + '）' : ''));
        case 'block': return english ? (nm + ' parries' + (e.tech ? ' ' + e.tech : ' it')) : (nm + '架住' + (e.tech ? '「' + e.tech + '」' : '这一下'));
        case 'dodge': return english ? (nm + ' slips aside') : (nm + '闪开');
        case 'clash': return english ? 'the blades collide' : '兵刃对拼';
        case 'guardbreak': return english ? (nm + "'s guard breaks") : (nm + '被打崩架势');
        case 'ko': return english ? (nm + ' goes down (finisher)') : (nm + '被打倒（终结）');
        case 'ring_out': return english ? (nm + ' is smashed off the platform') : (nm + '被震下擂台');
        case 'spell_hit': return english ? (nm + ' is hit by ' + (e.tech || 'a spell') + ' from range') : (nm + '被「' + (e.tech || '法术') + '」隔空命中');
        default: return english ? (nm + ' ' + e.type) : (nm + evZh(e.type, 1));
      }
    };
    const body = chains.slice(0, 8).map((c, i) => {
      const a = Math.max(0, c[0].t - t0), b = Math.max(a, c[c.length - 1].t - t0);
      return (i + 1) + ') ' + a.toFixed(1) + '–' + b.toFixed(1) + 's ' + c.map(phrase).join(' → ');
    }).join(english ? '; ' : '；');
    const head = english
      ? 'Chain of exchanges (play every line as ONE unbroken exchange - no freeze between techniques, never reset to a stance, the answer lands within 0.3 s; the per-second directives below are the same beats, not separate ones): '
      : '连击链（**每条链连成一口气拍完**：招与招之间不留空拍、不许各自站直重新起势，被架住/闪开之后 0.3 秒内必须接下一手；下面的逐秒指令是同一批拍子，不是另外的动作）：';
    return head + body;
  }

  function persecDirectives(o) {
    const r = o.r, english = !!o.english, t0 = o.t0, t1 = o.t1;
    const shown = o.shown || [], fmt = o.fmt;
    const N = Math.max(1, Math.ceil((t1 - t0) - 1e-6));
    const rows = [];
    for (let k = 0; k < N; k++) {
      const s = t0 + k, e = Math.min(t1, t0 + k + 1);
      if (e - s < 0.08 && k > 0) continue;
      const ev = shown.filter((x) => x.t >= s - 1e-6 && x.t < e - 1e-6);
      const last = rows[rows.length - 1];
      if (!ev.length && last && !last.ev.length) { last.e = e; continue; }
      rows.push({ s: s, e: e, ev: ev.slice() });
    }
    const tc = (s, e) => {
      const a = Math.max(0, s - t0), b = Math.max(a, e - t0);
      const f = (v) => (Math.abs(v - Math.round(v)) < 0.05 ? String(Math.round(v)) : v.toFixed(1));
      return f(a) + '–' + f(b) + 's';
    };
    const out = [];
    rows.forEach((row, idx) => {
      const r0 = stageRow(r, row.s);
      const r1 = stageRow(r, Math.max(row.s, row.e - 1 / 60));
      // ⚠ 真话优先：合并出来的区间里若还有**没被逐条描写**的事件（配额压掉的），必须在这一段后面挂计数，
      //   否则正文等于撒谎（写着"没有接触"实际有命中）。只挂"故事级"的，避免和「本镜另有」整行重复。
      const others = (o.all || []).filter((e) => e.t >= row.s - 1e-6 && e.t < row.e - 1e-6 && !(o.isShown && o.isShown(e)));
      const storyOther = others.filter((e) => o.isStory && o.isStory(e));
      let body = row.ev.length
        ? row.ev.map(fmt).join(english ? '; ' : '；')
        : (others.length
            ? (english ? 'both fighters keep moving, probing and trading' : '两人持续走位、试探与交手（本段未逐条描写）')
            : (english ? 'both fighters reposition and probe, no contact' : '两人自由走位试探、没有接触'));
      if (storyOther.length) {
        const cnt = {};
        storyOther.forEach((e) => { cnt[e.type] = (cnt[e.type] || 0) + 1; });
        const keys = Object.keys(cnt);
        const head = keys.slice(0, 3);
        body += english
          ? (' [also in this range: ' + head.map((k) => k + 'x' + cnt[k]).join(', ') + (keys.length > 3 ? (' +' + (keys.length - 3) + ' more') : '') + ']')
          : ('（本段另有：' + head.map((k) => evZh(k, cnt[k])).join('、') + (keys.length > 3 ? (' 等 ' + keys.length + ' 项') : '') + '）');
      }
      // 2026-10-01：第一镜交代绝对空间；后续镜只报位移（不重复站位，避免"切镜=重新摆位"）
      const absolute = o.absolute !== false;
      const anchor = absolute ? nearLandmark(r, o.card, row.s, row.e, english) : '';
      const beat = o.isStory && row.ev.some((e) => o.isStory(e)) ? ' [BEAT]' : '';
      const hand = (idx === rows.length - 1 && o.nextShotNo)
        ? (english ? (' [HANDOFF -> Shot ' + o.nextShotNo + ' opening]') : ('【交给下一镜 S' + String(o.nextShotNo).padStart(2, '0') + '】')) : '';
      out.push(tc(row.s, row.e)
        + (english ? ' | ' : '｜') + body
        + (english ? ' | camera ' : '｜机·') + (english ? o.camTagEn : o.camTagZh)
        + (absolute
            ? ((english ? ' | space ' : '｜空·') + posShort(r0, english)
               + (anchor ? ((english ? ' | ' : '｜') + anchor) : '')
               + (english ? ' | handoff ' : '｜接·') + posShort(r1, english))
            : ((english ? ' | move ' : '｜动·') + moveShort(r, row.s, row.e, english)))
        + (english ? ' | audio ' : '｜声·') + secSound(row.ev, english)
        + beat + hand);
    });
    return out;
  }
  // ── 跨镜/跨片段引用对齐（官方 I2VA / FL2VA 首帧对齐句 + 保留度枚举）──────────────────────
  //   官方对"多段生成怎么不失联"的答案：把上一段的**末帧**当下一段的**首帧参考图**，
  //   并在提示词第一行按官方格式写对齐句；参考图与主体定义用 `<Subject N>` / `<Picture N>`。
  function refKit(o) {
    const english = !!(o && o.english);
    const nmA = (o && o.nmA) || 'A', nmB = (o && o.nmB) || 'B';
    if (english) {
      return [
        '# Cross-clip consistency kit (official H3 I2VA / FL2VA wording)',
        '1) Feed the LAST frame of the previous generation as <Picture 1> of the next one (first-frame reference).',
        '2) Put this alignment line as the FIRST line of every prompt:',
        '   For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.',
        '   (two reference frames:) How the reference pictures align with the target video - Picture 1 (from Shot 1) aligns with the 0.00-second mark of the target video; Picture 2 (from Shot N) aligns with the S.SS-second mark of the target video.',
        '3) Subject definitions (reuse the exact same wording in every generation):',
        '   <Subject 1> = ' + nmA + ' (face, hairstyle, body proportions, costume, weapon) | <Subject 2> = ' + nmB,
        '4) retention_analysis: subject 1 = fully_preserved, subject 2 = fully_preserved, costume/weapon = fully_preserved, scene layout = partially_preserved (camera angle only).',
        '5) Compress history into the CURRENT state: keep describing only what is on screen now; earlier generations never re-enter as new content.'
      ].join('\n');
    }
    return [
      '# 跨片段一致性包（官方 H3 I2VA / FL2VA 写法）',
      '① 把上一段的**末帧**作为下一段的**首帧参考图**（<Picture 1>）一起喂给模型。',
      '② 每段提示词的**第一行**写官方对齐句：',
      '   For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.',
      '   （要两张参考图时：）How the reference pictures align with the target video - Picture 1 (from Shot 1) aligns with the 0.00-second mark of the target video; Picture 2 (from Shot N) aligns with the S.SS-second mark of the target video.',
      '③ 主体定义（每一段都用**同一句话**）：<Subject 1>＝' + nmA + '（脸型、发型、身材比例、服装、兵器）｜<Subject 2>＝' + nmB + '。',
      '④ retention_analysis：<Subject 1>＝fully_preserved｜<Subject 2>＝fully_preserved｜服装兵器＝fully_preserved｜场景布局＝partially_preserved（只换机位）。',
      '⑤ 历史压缩成"当前状态"：只描述这一刻画面里有什么，早先几段的东西不许当成新内容重新登场。'
    ].join('\n');
  }
  // ── 跨镜锁定（2026-09-25 用户：「这切换镜头和打斗不连贯，一切镜什么都变了」）─────────────
  //   根因：视频模型**没有跨镜记忆**。分镜是分别生成的，只要新镜没有把"同一场/同一人/同一套服装兵器/
  //   同一光线"再写一遍，模型就会把它当成新场景重画——于是换脸、换衣服、换场地、换天色、左右站位也翻过来。
  //   解法（业内标准做法）：① 每镜**原样重复同一段锁定句**（逐字相同，不是"意思一样"）；
  //   ② 切镜用**看得见的转场**（同向运动接续／甩镜／前景擦拭），而不是硬切；
  //   ③ 锁定**同一轴线**：甲恒在画面左、乙恒在画面右（要换位必须在正文里写出交叉过程）。
  const TRANS_LADDER = [
    { zh: '同向运动接续（match on action）：上一镜的动作方向、速度与惯性原样带过来，切点落在动作中间',
      en: 'match on action: carry the same motion direction and speed straight through the cut' },
    { zh: '甩镜转场（whip pan）：镜头快速甩向同一侧后稳稳停住，人和位置原地不动',
      en: 'whip pan to the same side, then settle — people and positions do not move' },
    { zh: '前景擦拭：让灯笼、雨幕或柱子在镜头前扫过再露出两人（机位换、人和场景不换）',
      en: 'foreground wipe: a lantern, rain sheet or pillar sweeps past the lens, then the same two are revealed' },
    { zh: '越肩切换：从另一人的肩后看过去，景别换、机位换，人和站位不换',
      en: 'over-the-shoulder switch: same people, same positions, only the framing changes' },
    { zh: '同轴硬切：切点保持在同一条轴线上，甲仍在画面左、乙仍在画面右，景别可以不同',
      en: 'hard cut on the same axis: A stays screen-left, B stays screen-right, only shot size changes' }
  ];
  /** 每镜都要原样抄一遍的"世界锁定句"（同一场/同一人/同一套服装兵器/同一光线/同一轴线） */
  function lockLine(r, cfg, english, sideA, sideB) {
    const src = (cfg && (cfg.descA || cfg.descB)) ? cfg : ((cfg && cfg.source) || cfg || {});
    const nmA = (r && r.A && r.A.name) || (src && src.nameA) || 'A';
    const nmB = (r && r.B && r.B.name) || (src && src.nameB) || 'B';
    const wA = (r && r.A && r.A.weaponName) || '', wB = (r && r.B && r.B.weaponName) || '';
    const dA = (src && src.descA) || '', dB = (src && src.descB) || '';
    const scene = (cfg && (cfg.scene || (cfg.source && cfg.source.scene))) || (r && r.scenario && r.scenario.zh) || '';
    // 轴线按**本镜真实的左右站位**写（内核里两人会绕步换边：写死"甲恒在左"会和素材打架，
    //   模型两头听——正文里就变成"换位/换人"）。同一镜内不许换边，换边必须在正文里写出交叉过程。
    const zhSide = (v) => (v === '左' ? '画面左侧' : (v === '右' ? '画面右侧' : '画面中间'));
    const aSide = zhSide(sideA || '左'), bSide = zhSide(sideB || '右');
    if (english) {
      return 'SAME WORLD (copy this line into every shot, word for word): one continuous fight, one location'
        + (scene ? (' (' + scene + ')') : '') + ', one lighting setup, the same two fighters — ' + nmA + (dA ? (' (' + dA + ')') : '') + ' with ' + (wA || 'his weapon')
        + ' and ' + nmB + (dB ? (' (' + dB + ')') : '') + ' with ' + (wB || 'his weapon') + '; same faces, same costumes, same weapons, same ground and same weather. '
        + 'A cut changes the CAMERA ONLY - never the location, the clothes, the light, the weather or the casting. '
        + 'On this axis ' + nmA + ' stays ' + aSide + ' and ' + nmB + ' stays ' + bSide + ' for the whole shot; a side swap happens only through a written crossing step.';
    }
    return '【同一场 · 每镜原样抄一遍】一条连续时间线、同一个地点' + (scene ? ('（' + scene + '）') : '') + '、同一套光线与天气、同样两人：'
      + nmA + (dA ? ('（' + dA + '）') : '') + ' 持' + (wA || '兵器') + '、' + nmB + (dB ? ('（' + dB + '）') : '') + ' 持' + (wB || '兵器')
      + '；**同一张脸、同一套服装、同一件兵器、同一地面与雨势**。切镜只换机位——不许换地点、不许换服装、不许换光线与天气、不许换人；'
      + '本镜轴线：' + nmA + ' 在' + aSide + '、' + nmB + ' 在' + bSide + '（同一镜内不许换边；要换边必须写出绕步/交叉这一步，下一镜才换轴线）。';
  }
  function frameAt(r,t){
    const f=(r&&r.frames)||[]; if(f.length<2) return f[0]||null;
    const dt=f[1].t-f[0].t; if(!(dt>0)) return f[0];
    const i=Math.max(0,Math.min(f.length-1,Math.round(t/dt)));
    return f[i];
  }
  // 接镜状态：左右 + 间距 + 高度 + 姿态 + 兵器（全部来自内核真实帧，不编）
  function continuity(r,cfg,t,english){
    const f=frameAt(r,t); if(!f||!f.A||!f.B) return '';
    const a=f.A,b=f.B,dist=Math.hypot(b.x-a.x,b.y-a.y);
    const leftOf=(p,q)=>p.x===q.x?null:(p.x<q.x?'left':'right');
    const stance=p=>p.st==='down'?(english?'on the ground, down':'已倒地'):(p.air||p.post==='air'?(english?'airborne':'腾空'):(p.post==='crouch'?(english?'crouched':'半蹲'):(english?'on foot, guard up':'站姿')));
    const wpn=id=>(r[id]||{}).weaponName||'';
    if(english){
      return `Pick up exactly where the previous shot ended: ${r.A.name} ${leftOf(a,b)||'centred'} ${dist.toFixed(1)} m from ${r.B.name}, ${stance(a)} with ${wpn('A')}, ${r.B.name} ${leftOf(b,a)||'centred'} and ${stance(b)} with ${wpn('B')}; same two fighters, same faces, same costumes, same weapons — never recast.`;
    }
    return `紧接上一镜结束时的状态：${r.A.name} 在${leftOf(a,b)==='left'?'左':'右'}侧、距 ${r.B.name} ${dist.toFixed(1)} 米、${stance(a)}、持${wpn('A')}；${r.B.name} 在${leftOf(b,a)==='left'?'左':'右'}侧、${stance(b)}、持${wpn('B')}。仍是同样两人、同一张脸、同一套服装兵器，不许换人。`;
  }
  // ── 走位表（staging）：逐拍写死"谁在画面哪一侧、隔多远、多高、朝哪"───────────
  //   用户反馈：出片里"人物在空间的定位还是有点问题""角色会突然改变或缺失"。
  //   根因不在 3D，而在提示词：素材只给了「谁打谁、什么结果」，**没有给每一拍的空间读数**，
  //   视频模型只能自己编位置 —— 于是同一镜里人换位、飘出画面、或者干脆少了一个人。
  //   这里把内核逐帧数据摊成可以直接照抄的走位行：关键事件一行动，其余每 0.5 秒一行，
  //   外加每个镜头的起幅/落幅（切镜点）各一行。
  const STAGE_KEY = /^(hit|ko|guardbreak|clash|takeoff|landing|landing_shock|ring_out|wall_kick|dodge|block|phenomenon)$/;
  function stageRow(r, t) {
    const f = frameAt(r, t); if (!f || !f.A || !f.B) return null;
    const a = f.A, b = f.B;
    const sideOf = (p, q) => (Math.abs(p.x - q.x) < 0.12 ? "中" : (p.x < q.x ? "左" : "右"));   // 观众视角：x 越小越靠左
    const depthOf = (p, q) => (Math.abs(p.y - q.y) < 0.35 ? "同一纵深" : (p.y > q.y ? "更远" : "更近"));
    const stanceOf = (p) => (p.st === "down" ? "倒地"
      : (((p.z || 0) > 0.35 || p.air || p.post === "air") ? "腾空" : (p.post === "crouch" ? "半蹲" : "站姿")));
    const one = (p, q) => ({
      side: sideOf(p, q), depth: depthOf(p, q), height: +((p.z || 0).toFixed(2)),
      stance: stanceOf(p), face: +((+p.face || 0).toFixed(2)), hp: p.hp,
      pos: [+p.x.toFixed(2), +p.y.toFixed(2), +((p.z || 0).toFixed(2))]
    });
    const A1 = one(a, b), B1 = one(b, a);
    // 朝向：谁朝着谁（面对面）—— 用户诟病的"没面对面/空间逻辑不清"，在素材里要能直接读到
    const toB = Math.atan2(b.y - a.y, b.x - a.x), toA = Math.atan2(a.y - b.y, a.x - b.x);
    const faced = (self, want) => Math.abs(((want - self + Math.PI * 3) % (Math.PI * 2)) - Math.PI) <= 1.05;
    A1.faceToB = faced(a.face, toB); B1.faceToA = faced(b.face, toA);
    // 相对方位（2026-09-25 用户：「先取消用 XYZ 去控制角色方式吧，但是要描述清楚相对位置，
    //   感觉视频模型对这些位置坐标识别不太清楚」）——坐标不进素材，改写成视频模型能用的**相对方位**：
    //   ① bearing：甲在乙的正面／左前／右前／左侧／右侧／侧后／正后（按朝向算，直接可拍）
    //   ② follow：谁在谁的前方（谁压着谁）
    const norm = (x) => Math.atan2(Math.sin(x), Math.cos(x));
    const bearing = (self, other, toOther) => {
      const rel = norm(self.face - toOther);                    // 0 = 正对，±π = 背对
      const d = rel * 180 / Math.PI;
      if (Math.abs(d) <= 35) return 'front';
      if (Math.abs(d) >= 145) return 'back';
      return d > 0 ? 'left' : 'right';                          // 观众视角：正角＝对方在自己左手边
    };
    A1.bearingToB = bearing(a, b, toB); B1.bearingToA = bearing(b, a, toA);
    return { t: +t.toFixed(2), dist: +Math.hypot(b.x - a.x, b.y - a.y).toFixed(2), A: A1, B: B1 };
  }
  const BEARING_ZH = { front: '正面', back: '背后', left: '左手侧', right: '右手侧' };
  const BEARING_EN = { front: 'facing him', back: 'behind him', left: 'on his left', right: 'on his right' };
  // 步数：一步按 0.8 米算（视频模型对"退了三步"比"退了 2.4 米"更有画面感）
  const steps = (m) => Math.max(1, Math.round(+m / 0.8));
  function stagingRows(r, cfg) {
    const fr = (r && r.frames) || []; if (!fr.length) return [];
    const dur = +((r.duration != null) ? r.duration : fr[fr.length - 1].t) || 0;
    const sec = +(cfg && cfg.duration) || dur;
    const n = shotCount(sec, cfg && cfg.shotPlan);
    const ts = new Set();
    for (let t = 0; t <= dur + 1e-6; t += 0.5) ts.add(+t.toFixed(2));
    for (const e of (r.events || [])) if (STAGE_KEY.test(e.type)) ts.add(+e.t.toFixed(2));
    for (let i = 0; i <= n; i++) ts.add(+(i * dur / Math.max(1, n)).toFixed(2));   // 每个镜头的起幅/落幅
    ts.add(+dur.toFixed(2));
    return [...ts].sort((x, y) => x - y).map((t) => stageRow(r, t)).filter(Boolean);
  }
  // 一行中文/英文（模型可以直接照抄；JSON 里是同一份数据）
  //   ⚠ 2026-09-25 起**不再输出 XYZ 坐标**（用户：「先取消用 XYZ 去控制角色方式吧……视频模型对这些位置坐标
  //   识别不太清楚」）：改成视频模型真的看得懂的相对位置——画面左右、离镜头远近（米）、纵深前后、
  //   两人间距（米＋步）、离地高度、朝向关系（面对/背对）、相对方位（正面/左前/右手侧…）。
  // ── 架式与手法（2026-09-27 用户：「为什么格斗，这对打的角色总要把双拳放在胸口？能不能动作自然一点，
  //   偏散打和武术的风格？」）────────────────────────────────────────────────────
  //   根因：内核只给"站姿/半蹲/腾空/倒地"，素材里**没有架式与手位口径**，模型就退回最省事的拳击抱架
  //   （双拳抱在胸口、两只手叠在一起）。这里按**内核真实状态**给出散打＋武术的架式读数，并且明确禁止那类懒写法：
  //     · 站架：散打侧身站架（左脚在前/反架右脚在前），前后手分开、前手抬起、后手贴腮，肘尖自然下垂；
  //     · 武术步型：弓步/马步/虚步/仆步/歇步/丁步（近身与落地时用），落地坐胯沉髋；
  //     · 距离带：远距离＝腿法与进退步为主，中距离＝拳腿结合，贴身＝顶膝/靠摔/缠抱；
  //     · 重心与朝向：六成压在后腿、下颌微收、肩放松、身体侧转约 30–45°（不是正面对着对手）。
  /** 距离带（散打的"远踢近打贴身摔"；带兵器时按"器械控距"给词） */
  function bandOf(d, english, armed) {
    const x = +d || 0;
    if (x >= 3.2) return english
      ? (armed ? { k: 'long range', v: 'control the line with the weapon\'s reach, in-out footwork, no wild swings' }
               : { k: 'long range', v: 'leg techniques and in-out footwork; hands feint only' })
      : (armed ? { k: '远距离', v: '以兵器长度控线、进退步压距离，不抡空招' }
               : { k: '远距离', v: '以腿法与进退步控制节奏，拳只做干扰' });
    if (x >= 1.6) return english
      ? (armed ? { k: 'mid range', v: 'half-staff work — thrust, parry, counter-cut; off hand guards the ribs' }
               : { k: 'mid range', v: 'punches and kicks combined; lead hand probes, rear hand commits' })
      : (armed ? { k: '中距离', v: '械走半程：刺、格、抹、反击，后手护肋' }
               : { k: '中距离', v: '拳腿结合：前手试探、后手发力' });
    return english
      ? (armed ? { k: 'clinch range', v: 'shorten the grip — hilt strikes, butt jabs, knees and trips; never hold the weapon up as decoration' }
               : { k: 'clinch range', v: 'knees, sweeps and clinch entries; short elbows and shoulder bumps' })
      : (armed ? { k: '贴身', v: '缩短握距：柄击、杵尾、顶膝与绊摔，别把兵器举成摆设' }
               : { k: '贴身', v: '顶膝、绊摔与缠抱，拳肘走短劲' });
  }
  /** 兵器档：bare＝徒手 / long＝双手长兵（枪棍朴刀棒）/ short＝刀剑短刃 */
  function weaponKindOf(F) {
    const k = String((F && (F.weapon || F.weaponKey)) || '').toLowerCase();
    const zh = String((F && (F.weaponName || F.weaponZh)) || '');
    const all = k + ' ' + zh;
    if (/\bnone\b/.test(k) || /徒手|空手|双拳|赤手/.test(zh)) return 'bare';
    if (/qiang|spear|bang|staff|gun|pu\b|nodachi|pole|halberd|矛|枪|棍|棒|朴刀|戟|禅杖/.test(all)) return 'long';
    if (/jian|dao|duanren|dagger|blade|sword|knife|刀|剑|匕首|短刃|刺/.test(all)) return 'short';
    return k ? 'short' : 'bare';
  }
  /** 本镜的架式与手法：每人一句短架式（两人刻意不同：A 正架 / B 反架）＋本镜共用的一句距离带与纪律
   *  ⚠ 2026-10-01 用户：「怎么人物又是老是摆个双拳放胸口的动作？除了打拳击擂台赛，其余的武术打斗情景
   *    是不会摆这个动作的，让角色自然一点摆出武术准备动作。」→ 架式**按兵器分家**：
   *    徒手·非擂台＝武术起手架（前手立掌护中线、后手收肋前）；徒手·擂台＝散打/拳击架（后手护颌）；
   *    短兵＝持械架（前手持械前指、尖锋指向对手）；长兵＝双手持械架（前手前握、后手握柄尾、尖端指敌）。 */
  function guardStance(row, r, english, id) {
    if (!row || !row.A || !row.B) return '';
    const me = id === 'B' ? row.B : row.A;
    const F = (r && r[id]) || {};
    const nm = F.name || (id === 'B' ? 'B' : 'A');
    const st = me.stance || '站姿';
    const kind = weaponKindOf(F);
    const south = (id === 'B');
    const arena = !!(r && r.scenario && r.scenario.key === 'arena');
    const leadZh = south ? '反架（右脚在前）' : '正架（左脚在前）';
    const leadEn = south ? 'southpaw (right foot leading)' : 'orthodox (left foot leading)';
    let zh2, en2;
    if (st === '腾空') {
      zh2 = '空中收腿护裆、落地错步沉胯'; en2 = 'airborne, knees tucked, landing staggered with hips sunk';
    } else if (st === '半蹲') {
      zh2 = '低架坐胯、前后脚四六开'; en2 = 'low stance, hips sunk, feet 40/60';
    } else if (st === '倒地') {
      zh2 = '倒地单肩着地、一手护头、一手撑地'; en2 = 'down on one shoulder, one hand guarding the head, the other propping the body up';
    } else if (kind === 'long') {
      zh2 = leadZh + '、双手持械架：前手前握、后手握柄尾收在腰侧，械尖（棍头）指向对手眉心，侧身含胸、重心压在后腿';
      en2 = leadEn + ', two-handed weapon stance: lead hand up the shaft, rear hand on the butt at the waist, the point (or staff head) aimed at the opponent\'s brow, body angled';
    } else if (kind === 'short') {
      zh2 = leadZh + '、持械架：前手持械前指、尖锋指着对手咽喉一线，后手虚握护在肋前（或搭在柄根），两肘下垂、侧身含胸';
      en2 = leadEn + ', armed stance: weapon hand forward with the point tracking the opponent\'s throat line, off hand loose at the ribs (or on the pommel), elbows down, body angled';
    } else if (arena) {
      zh2 = leadZh + '、散打/拳击架：前手抬起护住中线、后手护住下颌与腮侧、肘尖自然下垂';
      en2 = leadEn + ', sanda/boxing guard: lead hand up on the centre line, rear hand at the jaw and cheek, elbows down';
    } else {
      zh2 = leadZh + '、武术起手架：前手立掌护住中线（掌指朝前、肘微屈），后手虚握收在肋前，两肘下垂护肋、含胸拔背、沉肩坠肘';
      en2 = leadEn + ', martial ready stance: lead hand open on the centre line (fingers forward, elbow soft), rear hand loose at the ribs, elbows down guarding the ribs, chest tucked';
    }
    return english ? (nm + ' ' + en2) : (nm + ' ' + zh2);
  }
  /** 本镜的架式纪律（一句话，写在两人的架式之后；距离带按内核真实间距给）
   *  2026-10-01：补上"手位跟着兵器走"与"不许抱脸硬扛"——抱架只在擂台徒手出现。 */
  function stanceTail(row, english, armed) {
    if (!row) return '';
    const band = bandOf(row.dist, english, armed);
    return english
      ? ('Stance: weight 60% on the rear leg, body angled 30-45 degrees, chest tucked, chin slightly down. ' + band.k + ' (' + (+row.dist).toFixed(1) + ' m): ' + band.v
        + '. Footwork is slide / shuffle / switch-step on the balls of the feet; at close range and on landings use the wushu stances (bow / horse / empty / drop / rest / T-step) with hips sunk; power comes from a turned waist and cut hips, not from swinging the arms. The two fighters must NOT share the same hand position — the armed fighter\'s hands follow the weapon (lead hand controlling it, off hand at the ribs), the unarmed fighter keeps the lead hand on the centre line and the rear hand at the ribs (jaw only in a ring bout). Never park both fists together at the chest, and never hug both fists in front of the face — that is a boxing guard and it does not belong in weapon or wushu scenes; hands follow the attack.')
      : ('重心六成压在后腿、身体侧转约三十到四十五度、含胸拔背、下颌微收；本镜' + band.k + '（相距 ' + (+row.dist).toFixed(1) + ' 米）——' + band.v
        + '。步法用滑步/垫步/跳换步、前脚掌着地，近身与落地用武术步型（弓步/马步/虚步/仆步/歇步/丁步）与坐胯沉髋，发力走转髋、拧腰切胯，不是只抡胳膊。两人手位必须不同、随出手变化——持械的人手跟着兵器走（前手控械、后手护肋），徒手的人前手护中线、后手收肋前（只有擂台徒手才护到下颌腮侧）；**不许两人都把双拳叠在胸口**，**更不许双拳抱在脸前硬扛**（那是拳击抱架，器械场与武术场不摆这个）。');
  }
  /** 兼容旧名：单行版（人＋架式＋距离＋纪律） */
  function guardLine(row, r, english, id) {
    const g = guardStance(row, r, english, id);
    return g ? (g + (id === 'A' ? ('　' + stanceTail(row, english)) : '')) : '';
  }
  function stageLine(row, r, english) {
    if (!row) return "";
    const nm = (id) => (r[id] || {}).name || id;
    const SIDE_EN = { '左': 'left', '右': 'right', '中': 'centre' };
    const DEPTH_EN = { '更近': 'closer to camera', '同一纵深': 'same depth', '更远': 'farther from camera' };
    const ST_EN = { '站姿': 'standing', '半蹲': 'crouched', '腾空': 'airborne', '倒地': 'downed' };
    const en1 = (v, map) => map[v] || v;
    const hZh = (p) => (p.height > 0.3 ? ('腾空约 ' + p.height.toFixed(1) + ' 米') : '');
    const hEn = (p) => (p.height > 0.3 ? ((+p.height).toFixed(1) + ' m off the ground') : '');
    const zh = (p, id) => {
      const bits = ['画面' + p.side + (p.side === '中' ? '' : '侧'), p.depth, p.stance];
      if (hZh(p)) bits.push(hZh(p));
      bits.push(p.faceToB !== undefined && p.faceToB === false ? '背对/侧身' : '正对对手');
      if (p.bearingToB) bits.push('在对手' + (BEARING_ZH[p.bearingToB] || p.bearingToB));
      return nm(id) + '：' + bits.join('·');
    };
    const en = (p, id) => {
      const bits = [en1(p.side, SIDE_EN) + (p.depth === '同一纵深' ? '' : ' side of frame'), en1(p.depth, DEPTH_EN), en1(p.stance, ST_EN)];
      if (hEn(p)) bits.push(hEn(p));
      bits.push(p.bearingToB ? (BEARING_EN[p.bearingToB] || p.bearingToB) : '');
      return nm(id) + ': ' + bits.filter(Boolean).join(', ');
    };
    if (english) return `t=${row.t.toFixed(2)}s  ${en(row.A, 'A')};  ${en(row.B, 'B')};  ${row.dist} m apart (about ${steps(row.dist)} steps)`;
    return `t=${row.t.toFixed(2)}s　${zh(row.A, 'A')}｜${zh(row.B, 'B')}｜间距 ${row.dist} 米（约 ${steps(row.dist)} 步）`;
  }
  const STAGE_LEGEND = "side=画面左/右/中（观众视角，以两人连线为准）; depth=更近/同一纵深/更远（离镜头的远近）; stance=站姿/半蹲/腾空/倒地; height=离地米; bearing=相对方位（正面/左手侧/右手侧/背后）; dist=两人间距米（一步≈0.8 米）；"
    + "**不用坐标**：位置一律用「画面哪一侧 · 离镜头远近 · 两人相距几米/几步 · 离地多高 · 相对对手的方位」来描述。";

  // 动作时间轴（v0.6）：每个动作的 开始→结束→时长 + 相位 + 延伸窗口
  const AFTER_WINDOW = { block: "格挡后 0.2~0.8 秒内应反击或抢位", dodge: "闪避落位后 0.15~0.6 秒内应反击",
    hitstun: "受击硬直期间不得行动，硬直结束就是对方的窗口", stagger: "踉跄后 0.3~0.6 秒重心未稳",
    down: "倒地余波：胜者收势，画面留在原地" };
  function timelineText(r, cfg, english) {
    const tl = (r.timeline || []);
    if (!tl.length) return "";
    return tl.map(x => {
      const head = english
        ? x.t0.toFixed(2) + "→" + x.t1.toFixed(2) + "s (" + x.dur.toFixed(2) + "s) " + x.who + " " + x.label + (x.airborne ? " [airborne]" : "")
        : x.t0.toFixed(2) + "→" + x.t1.toFixed(2) + "s（" + x.dur.toFixed(2) + " 秒）" + x.who + " " + x.label + (x.airborne ? " [空中]" : "");
      const k = (x.kind || "").split(":")[0];
      const w = AFTER_WINDOW[k];
      return head + (w ? (english ? "  → after: " + w : "　→ 延伸：" + w) : "");
    }).join("\n");
  }
  // ── 切点选择：切在"节拍边界"上，不按时间等分 ────────────────────────────
  //   用户反馈："2 镜以上的都做片段，第一个镜头跑完，第二个镜头就是重新跑的"。
  //   根因之一：cut 原来按时长等分（6/12/18 秒），正好切在招式的判定/收招中途 ——
  //   下一镜开头是一记**全新的起手**，模型只能理解成"新片段重新跑"。
  //   现在：在标称切点 ±2 秒内找一个"最像一拍打完"的时刻（双方都不在起手/判定段、相对速度低、
  //   最好紧跟在命中/落地/对拼之后），并把"跨切点的那个招式"单独交给交接句去处理。
  // ── 镜头时间线（2026-09-25 用户：「动作判定的时间和镜头不太对的上，你最好用 TIMELINE 的方式去控制一下。
  //    有些被打了再切换第二个镜头之后才撞墙。还有的切换了镜头完全与上一个镜头衔接不上，要嘛重置了位置重新打过，
  //    要嘛突然变位。画面逻辑不行。」）────────────────────────────────────────────────
  //   一条时间线同时管三件事，全流程（切点选择 / 分镜文本 / 证据素材 / 体检 / 自检）都读这一份：
  //     ① **锁定窗口**（不许切）：被打飞→撞墙/落地这一整条因果链、起跳→落地、出招起手段；
  //        另外高速位移（>6 米/秒）也锁，2.5~6 米/秒重罚——原来只锁"起手段"，于是 38.5% 的切点落在
  //        飞出去的中途、16.7% 把"被打飞"和"撞墙"切成了两镜（实测量过，见 tools/shot-timeline-audit.js）。
  //     ② **每镜的切入/切出状态**：起幅/落幅的帧、速度、正在进行的动作（carry）。
  //     ③ **跨镜交接**：上一镜末帧还在飞的这一下，在下一镜的什么时刻、落在哪里解决。
  //   时间基数也在这里统一：内核秒（引擎 60Hz 的真实时间）与片长秒（H3 提示词用的时间码）双写，
  //   模型不会再拿两套时钟对不上（旧素材里证据用内核秒、分镜用片长秒，谁也没说换算关系）。
  const TL_CACHE = new WeakMap();
  /**
   * 片长（秒）＝**内核实测时长**（1:1，不做拉伸）。
   *   ⚠ 2026-09-25 用户：「动作判定的时间和镜头不太对的上」——根因是旧口径把实测时长线性铺到用户填的片长上
   *   （实测平均拉伸 2.11 倍、最坏 6.8 倍）：一场 10 秒 KO 的架被铺成 30 秒片子，招式全变慢动作，
   *   而且素材里证据用内核秒、分镜用片长秒，两套时钟谁也没说换算关系，模型只能瞎对。
   *   现在统一成一条时间线：片长 = 实测时长，分镜时间码 = 内核秒，全流程同一个时钟。
   */
  function filmLengthOf(r, cfg) {
    const d = +((r && r.duration) || 0);
    if (d > 0.5) return +d.toFixed(2);
    const req = +((cfg && cfg.source && cfg.source.duration) || (cfg && cfg.duration)) || 15;
    return +req.toFixed(2);
  }
  function shotTimeline(r, cfg) {
    const durSim = filmLengthOf(r, cfg);
    const req = +((cfg && cfg.source && cfg.source.duration) || (cfg && cfg.duration)) || durSim;
    const key = 'tl:' + durSim + ':' + req;
    const hit = TL_CACHE.get(r);
    if (hit && hit.key === key) return hit.tl;
    const factor = 1;                                  // 1:1：片长与动作判定同一个时钟
    const toFilm = (t) => +(t * factor).toFixed(2);
    const ev = (r.events || []).slice().sort((a, b) => a.t - b.t);
    const frames = r.frames || [];
    const fAt = (t) => frameAt(r, t);
    const spdAt = (t) => frameSpeed(r, t);
    const IMPACT = /^(slam|prop_broken|obstacle_hit|ground_scar|landing|quake)$/;
    const RESOLVE = /^(hit|clash|guardbreak|ko|ring_out|slam|prop_broken|obstacle_hit|landing|spell_hit|ward_broken)$/;
    const locks = [];
    const addLock = (t0, t1, kind, why, soft) => {
      if (!(t1 > t0)) return;
      locks.push({ t0: +t0.toFixed(2), t1: +t1.toFixed(2), kind: kind, why: why, soft: !!soft });
    };
    // ① 击飞链：命中之后"人还在飞、还没撞上/落地"这一段整段锁住
    //   （这就是用户说的"被打了再切换第二个镜头之后才撞墙"——旧口径只看事件里的 kb 字段，
    //     而普通 hit 根本不带 kb，于是这条因果链从来没被保护过。现在改成**看帧**：
    //     从命中起追到第一处"撞墙/落地/地裂"或双方速度落回 2.5 米/秒以下，最多 1.4 秒。）
    ev.forEach((e) => {
      if (!/^(hit|spell_hit|guardbreak|ko|slam)$/.test(e.type)) return;
      const cap = Math.min(e.t + 1.4, durSim);
      let end = null;
      for (let j = 0; j < ev.length; j++) {
        const e2 = ev[j];
        if (e2.t <= e.t + 1 / 60 || e2.t > cap) continue;
        if (IMPACT.test(e2.type)) { end = e2.t; break; }
      }
      if (end == null) {
        let t = e.t + 0.12;
        for (; t < cap; t += 1 / 30) { if (spdAt(t) < 2.5) break; }
        end = Math.min(t, cap);
      }
      if (end - e.t < 0.12) return;                    // 太快落定：没什么可保护的
      addLock(e.t, end, 'knockback', (e.who || '?') + ' 被' + (e.tech || '这一下') + '打中后还在受力（到 ' + end.toFixed(2) + ' 秒才落定）');
    });
    // ② 滞空：起跳→落地（空中可以切，但要交接；这里只锁"起跳瞬间"那 0.25 秒，避免切在半空中让人物凭空出现）
    ev.forEach((e, i) => {
      if (!/^(takeoff|leap)$/.test(e.type)) return;
      let end = null;
      for (let j = i + 1; j < ev.length; j++) { if (ev[j].type === 'landing' && ev[j].who === e.who) { end = ev[j].t; break; } }
      addLock(e.t, Math.min(e.t + 0.25, end == null ? e.t + 0.25 : end), 'takeoff', (e.who || '?') + ' 起跳离地');
      if (end != null) addLock(Math.max(e.t, end - 0.25), end, 'landing', (e.who || '?') + ' 落地那一下');
    });
    // ③ 出招起手段（原来就有，保留）
    ev.forEach((e) => {
      if (e.type !== 'attack' || !e.dur) return;
      const w = +(e.dur.w || 0);
      if (w > 0) addLock(e.t, e.t + w, 'windup', (e.who || '?') + '「' + (e.tech || '出招') + '」起手');
    });
    // ④ 高速段：>6 米/秒 记为**软锁**（重罚但仍可选——仙神局整场都在高速，硬锁会让切点全落在锁内）
    {
      let run = null;
      for (let t = 0; t <= durSim; t += 1 / 30) {
        const v = spdAt(t);
        if (v > 5) { if (run == null) run = t; }
        else if (run != null) { addLock(run, t, 'fast', '这一段位移太快（>5 米/秒），切开就是"突然变位"', true); run = null; }
      }
      if (run != null) addLock(run, durSim, 'fast', '尾段高速位移', true);
    }
    // 合并重叠锁窗（免得 999 一大片导致无候选）：硬的与硬的、软的和软的各自合并
    locks.sort((a, b) => a.t0 - b.t0);
    const merged = [];
    locks.forEach((L) => {
      const last = merged[merged.length - 1];
      if (last && !!last.soft === !!L.soft && L.t0 <= last.t1 + 0.02) {
        last.t1 = Math.max(last.t1, L.t1); last.kinds = (last.kinds || [last.kind]).concat([L.kind]);
      } else merged.push({ t0: L.t0, t1: L.t1, kind: L.kind, why: L.why, soft: L.soft, kinds: [L.kind] });
    });
    // 硬锁：不许切（被打飞中 / 起跳落地 / 出招起手）；软锁只重罚
    const inLock = (t) => merged.some((L) => !L.soft && t > L.t0 - 0.02 && t < L.t1 + 0.02);
    const inSoft = (t) => merged.some((L) => L.soft && t > L.t0 - 0.02 && t < L.t1 + 0.02);
    const beats = ev.filter((e) => RESOLVE.test(e.type)).map((e) => ({ t: +e.t.toFixed(2), type: e.type, who: e.who || null, tech: e.tech || null }));
    const tl = { clock: { kernelSeconds: +durSim.toFixed(2), filmSeconds: +durSim.toFixed(2), factor: factor,
        requestedSeconds: +req.toFixed(2), stretched: false, note: '片长 = 内核实测时长（1:1，同一时钟）' },
      toFilm: toFilm, locks: merged, inLock: inLock, beats: beats,
      // 每个时刻"正在飞、还没落定"的动作（切点选在这儿就要靠交接句接住）
      carryAt: (t) => merged.filter((L) => !L.soft && L.kinds.indexOf('knockback') >= 0 && t > L.t0 && t < L.t1)
        .concat(merged.filter((L) => !L.soft && L.kinds.indexOf('takeoff') >= 0 && t > L.t0 && t < L.t1)),
      softAt: inSoft };
    TL_CACHE.set(r, { key: key, tl: tl });
    return tl;
  }
  /** 每镜的时间线段（切点定下来之后才有意义）：起止（双时钟）·节拍·切入切出状态·跨镜携带的动作 */
  function shotSegments(r, cfg) {
    const tl = shotTimeline(r, cfg);
    const cuts = cutPoints(r, cfg);
    const durSim = tl.clock.kernelSeconds;
    const bounds = [0].concat(cuts).concat([durSim]);
    return bounds.slice(0, -1).map((k0, i) => {
      const k1 = bounds[i + 1];
      const f0 = frameAt(r, k0), f1 = frameAt(r, Math.max(k0, k1 - 1 / 60));
      const carry = tl.carryAt(Math.max(k0, k1 - 0.05));
      const nextEnd = i + 1 < bounds.length - 1 ? null : null;
      const inCarry = tl.carryAt(Math.min(k1 + 1 / 60, durSim));
      const resolves = [];
      tl.locks.forEach((L) => { if (L.kinds.indexOf('knockback') >= 0 && L.t1 > k1 - 0.02 && L.t1 <= k1 + 1.2) resolves.push({ t: L.t1, why: L.why, n: i + 2 }); });
      return { n: i + 1, k0: +k0.toFixed(2), k1: +k1.toFixed(2), f0: tl.toFilm(k0), f1: tl.toFilm(k1),
        beats: tl.beats.filter((b) => b.t >= k0 && b.t < k1),
        inFrame: f0, outFrame: f1, carry: carry, nextCarry: inCarry, resolves: resolves,
        speedMax: Math.max(...[k0, (k0 + k1) / 2, Math.max(k0, k1 - 0.05)].map((t) => frameSpeed(r, t))) };
    });
  }
  function frameSpeed(r, t) {
    const a = frameAt(r, Math.max(0, t - 1 / 60)), b = frameAt(r, Math.min(r.duration, t + 1 / 60));
    if (!a || !b || !a.A || !b.A) return 0;
    const d = (p, q) => Math.hypot((q.x - p.x), (q.y - p.y)) * 60;
    return Math.max(d(a.A, b.A), d(a.B, b.B));
  }
  function cutScore(r, t, tl) {
    const f = frameAt(r, t); if (!f || !f.A || !f.B) return 999;
    // ① 时间线锁定窗口（被打飞→撞墙/落地、起跳/落地、出招起手、高速位移）一律禁选
    if (tl && tl.inLock(t)) return 999;
    // 邻帧也算（±0.05 秒）：cutScore 取的帧与体检/测试查的帧可能差一帧，
    //   只查一帧会让"切点落在起手段"漏过去。
    for (const fr2 of (r.frames || [])) {
      if (Math.abs(fr2.t - t) > 0.05) continue;
      for (const id of ['A', 'B']) {
        const q2 = fr2[id];
        if (q2 && q2.st === 'attack' && q2.ph === 'windup') return 999;
      }
    }
    let sc = 0;
    for (const p of [f.A, f.B]) {
      // 起手段切走 = 观众看到"又重新起势" —— 2026-09-25 起改成**硬约束**（返回 999 ＝禁选）：
      //   原来只罚 2.2 分，快节奏改动后招式更密，仍然出现过"切点落在起手段"。
      //   判定/收招段切走是正常武打剪法（"切在命中那一瞬"），只给很小的罚分。
      if (p.st === 'attack' && p.ph === 'windup') return 999;
      if (p.st === 'attack') sc += (p.ph === 'active' ? 0.6 : 0.2);
      if ((p.z || 0) > 0.6) sc += 1.5;                                                    // 空中可以切，但要交接（重罚：切在半空最容易"看着像换位"）
      if (p.st === 'hitstun' || p.st === 'stagger') sc += 0.7;
    }
    const v = frameSpeed(r, t);
    sc += Math.min(2, v / 6);                                                              // 高速切＝看不清
    if (v > 3.5) sc += (v - 3.5) * 0.8;                                                    // 3.5 米/秒以上重罚
    if (tl && tl.softAt && tl.softAt(t)) sc += 5;                                          // 软锁（>5 米/秒那段）：重罚但仍可选
    // ② 时间线节拍：切点最好落在"一拍刚解决"的 0.35 秒内（命中/对拼/崩防/撞墙/落地之后）
    const beat = tl ? tl.beats.filter((b) => b.t <= t + 0.02 && b.t >= t - 0.35).pop() : null;
    if (beat) sc -= 1.4;
    const near = (r.events || []).some(e => Math.abs(e.t - t) < 0.3 && /^(hit|landing|clash|guardbreak)$/.test(e.type));
    if (near) sc -= 0.8;                                                                  // 刚打完一拍：最自然的切点
    return sc;
  }
  function cutPoints(r, cfg) {
    const tl0 = shotTimeline(r, cfg);
    const sec = tl0.clock.filmSeconds, n = shotCount(sec, cfg && cfg.shotPlan);
    if (n <= 1) return [];
    const dur = +r.duration || 0;
    if (!(dur > 1)) return [];
    const tl = tl0;                                        // ← 切点由时间线控制（锁定窗口内一律不切）
    const minGap = Math.max(1.5, dur / n * 0.45);          // 最短镜长：既防碎镜，也不至于把整场压死
    const step = 0.05, win = 1.5;                          // 在标称切点 ±1.5 秒内按 0.05 秒找候选
    const cost = (k, t) => cutScore(r, t, tl) + Math.abs(t - dur * (k + 1) / n) * 0.55;
    const cand = [];
    const collect = (k, lo, hi) => {
      const out = [];
      const push = (tt) => {
        if (!(tt > 0.25 && tt < dur - 0.25)) return;
        const t2 = +tt.toFixed(2);
        const locked = tl.inLock(t2) || cutScore(r, t2, tl) >= 999;
        out.push({ t: t2, locked: locked, c: (locked ? 50 : 0) + cost(k, t2) });
      };
      for (let t = Math.max(0.25, lo); t <= Math.min(dur - 0.25, hi); t += step) push(t);
      // 锁定窗口的**边界**也是候选：t1 正是"这一下终于落定"的时刻——武打片最自然的切点就在那儿。
      //   光靠 0.05 秒网格常常错过边界（窗口一密就没有空档可选，只能退回锁内）。
      tl.locks.forEach((L) => {
        if (L.t1 + 0.03 >= lo && L.t1 + 0.03 <= hi) push(L.t1 + 0.03);
        if (L.t0 - 0.03 >= lo && L.t0 - 0.03 <= hi) push(L.t0 - 0.03);
      });
      return out;
    };
    for (let k = 1; k < n; k++) {
      const nom = dur * k / n;
      let list = collect(k, nom - win, nom + win).filter((x) => !x.locked);
      if (!list.length) list = collect(k, nom - Math.max(win, dur / n * 0.45), nom + Math.max(win, dur / n * 0.45)).filter((x) => !x.locked);
      if (!list.length) list = collect(k, Math.max(0.25, nom - dur * 0.45), Math.min(dur - 0.25, nom + dur * 0.45));  // 全锁：挑最不坏
      if (!list.length) list = collect(k, 0.25, dur - 0.25);
      if (!list.length) list = [{ t: +nom.toFixed(2), locked: true, c: 999 }];
      cand.push(list);
    }
    // 动态规划：每切点选一个候选，要求相邻切点间隔 ≥ minGap、末镜也 ≥ minGap，总代价最低
    let states = cand[0].map(p => ({ t: p.t, c: p.c, path: [p.t] }));
    for (let k = 1; k < n - 1; k++) {
      const ns = [];
      for (const p of cand[k]) {
        let best = null;
        for (const st of states) {
          if (p.t - st.t < minGap) continue;
          const c = st.c + p.c;
          if (!best || c < best.c) best = { t: p.t, c: c, path: st.path.concat([p.t]) };
        }
        if (best) ns.push(best);
      }
      if (!ns.length) break;
      states = ns;
    }
    const viable = states.filter(st => (dur - st.t) >= minGap);
    if (viable.length) {
      let best = viable[0];
      for (const st of viable) if (st.c < best.c) best = st;
      return best.path;
    }
    // 约束太紧（比如片长短、镜头多）：退回等分，保证可用
    const out = [];
    for (let k = 1; k < n; k++) out.push(+(dur * k / n).toFixed(2));
    return out;
  }
  // 跨越切点的招式：上一镜"没做完"、下一镜必须"接着做完"的那个动作
  function straddlingAttack(r, tc) {
    let hit = null;
    for (const e of (r.events || [])) {
      if (e.type !== 'attack' || !e.dur) continue;
      const t0 = e.t, t1 = e.t + (e.dur.w || 0) + (e.dur.a || 0) + (e.dur.r || 0);
      if (t0 < tc && tc < t1) { if (!hit || t1 - t0 > hit.t1 - hit.t0) hit = { e: e, t0: t0, t1: t1, rest: +Math.max(0, t1 - tc).toFixed(2), done: +(tc - t0).toFixed(2) }; }
    }
    return hit;
  }
  // 时间线行：把"这一镜的时间账"直接写给 AI——起止秒（片长=内核，同一个时钟）、节拍（几点打中什么）、
  //   以及**切出时还在飞的那一下**（它在下一镜几秒处落定/撞上什么）。用户反馈的"被打完切镜才撞墙""切完像换位"
  //   都靠这一行让模型照抄：位置与动作是从上一镜带着走的，不是新起一段。
  function timelineLine(r, cfg, i, seg, english) {
    const TL = shotTimeline(r, cfg);
    const B = (typeof evZh === 'function') ? evZh : null;
    const zh = (e) => (EV_ZH[e.type] || e.type) + (e.who ? ('(' + e.who + ')') : '');
    // 节拍只挑"故事级"的拍（命中/对拼/崩防/击倒/落地/法术命中/砸地/建筑碎裂），
    //   同一瞬间的多个事件合成一拍（撞墙会同时产生 obstacle_hit + prop_broken + quake），最多 5 拍。
    const STORY = /^(hit|clash|guardbreak|ko|ring_out|landing|spell_hit|slam)$/;
    const rawBeats = (seg && seg.beats ? seg.beats : []).filter((b) => STORY.test(b.type));
    const seen = {};
    const beats = [];
    rawBeats.forEach((b) => {
      const k = b.t.toFixed(1) + '/' + b.type;
      if (seen[k] || beats.length >= 5) return;
      seen[k] = 1; beats.push(b);
    });
    const beatTxt = beats.map((b) => b.t.toFixed(2) + 's ' + (EV_ZH[b.type] || b.type) + (b.who ? ('·' + b.who) : '')).join('、');
    const carry = (seg && seg.carry) ? seg.carry : [];
    const res = (seg && seg.resolves) ? seg.resolves : [];
    const parts = [];
    if (english) {
      parts.push('Timeline ' + seg.f0.toFixed(1) + '-' + seg.f1.toFixed(1) + 's (same clock as the action log).');
      if (beatTxt) parts.push('beats: ' + beatTxt + '.');
      if (carry.length) parts.push('Still in flight at the cut: ' + carry.map((c) => c.why).join('; ') + '.');
      if (res.length) parts.push('It lands/impacts at ' + res.map((x) => x.t.toFixed(2) + 's (shot ' + x.n + ')').join(', ') + ' — write that continuation.');
      if (!parts.length) return '';
      return '  ' + parts.join(' ');
    }
    parts.push('【本镜时间线】' + seg.f0.toFixed(1) + '–' + seg.f1.toFixed(1) + ' 秒（与动作判定同一时钟，1:1）');
    if (beatTxt) parts.push('　本镜节拍：' + beatTxt);
    if (carry.length) {
      parts.push('　切出时还在飞：' + carry.map((c) => c.why).join('；')
        + (res.length ? ('　→ 它在 ' + res.map((x) => x.t.toFixed(2) + ' 秒（第 ' + x.n + ' 镜）').join('、') + ' 落定/撞上，下一镜开头要接着把这一下写完') : ''));
    } else if (res.length) {
      parts.push('　下一镜开头接着写完：' + res.map((x) => x.t.toFixed(2) + ' 秒 ' + x.why).join('；'));
    }
    if (seg.speedMax > 3) parts.push('　本镜最高速 ' + seg.speedMax.toFixed(1) + ' 米/秒（写动作时按这个速度，不许写成慢慢走近）');
    return '　' + parts.join('') + '　';
  }
  // 交接句：上一镜末帧"悬而未决"的状态（未完成动作 / 空中与惯性 / 硬直倒地），下一镜必须从这里长出来
  function handoff(r, t, english) {
    const f = frameAt(r, t); if (!f || !f.A || !f.B) return '';
    const prev = frameAt(r, Math.max(0, t - 1 / 60));
    const nm = id => (r[id] || {}).name || id;
    const EN = !!english;
    const dirOf = (now, was) => {
      if (!now || !was) return '';
      const dx = now.x - was.x, dy = now.y - was.y;
      if (Math.hypot(dx, dy) < 0.004) return '';
      const side = Math.abs(dx) < 0.01 ? '' : (dx < 0 ? (EN ? 'screen-left' : '画面左') : (EN ? 'screen-right' : '画面右'));
      const depth = Math.abs(dy) < 0.01 ? '' : (dy > 0 ? (EN ? ' and deeper' : '向纵深远') : (EN ? ' and closer' : '向近处'));
      return (side + depth) || '';
    };
    const one = (p, q, id) => {
      const bits = [];
      if (p.st === 'attack') bits.push(EN
        ? ('mid-' + (p.tech || 'strike') + ' (' + (p.ph === 'active' ? 'active' : (p.ph === 'windup' ? 'wind-up' : 'recovery')) + ', unfinished)')
        : ('正在「' + (p.tech || '出招') + '」的' + (p.ph === 'active' ? '判定' : (p.ph === 'windup' ? '起手' : '收招')) + '段（没收完）'));
      if ((p.z || 0) > 0.35) bits.push(EN
        ? (((p.vz || 0) < -0.2 ? 'falling' : ((p.vz || 0) > 0.2 ? 'rising' : 'hovering')) + ' at ' + (p.z || 0).toFixed(1) + ' m')
        : (((p.vz || 0) < -0.2 ? '正在下落' : ((p.vz || 0) > 0.2 ? '正在上升' : '滞空')) + '，离地 ' + (p.z || 0).toFixed(1) + ' 米'));
      if (p.st === 'hitstun') bits.push(EN ? 'still in hit-stun' : '还在受击硬直里');
      if (p.st === 'stagger') bits.push(EN ? 'off balance' : '重心未稳');
      if (p.st === 'down') bits.push(EN ? 'already down' : '已经倒地');
      const d = dirOf(p, prev && prev[id]);
      if (d) bits.push(EN ? ('momentum ' + d) : ('惯性朝' + d));
      const gap = Math.hypot(q.x - p.x, q.y - p.y).toFixed(2);
      return bits.length ? (nm(id) + (EN ? ': ' : '：') + bits.join(EN ? ', ' : '、')
        + (EN ? (' (gap ' + gap + ' m)') : ('（与对手相距 ' + gap + ' 米）'))) : '';
    };
    const a = one(f.A, f.B, 'A'), b = one(f.B, f.A, 'B');
    const parts = [a, b].filter(Boolean);
    if (!parts.length) return '';
    return EN
      ? 'Unfinished business from the last frame: ' + parts.join('; ') + '. Grow out of it — no fresh wind-up, no re-staging.'
      : '上一镜末帧留下的"没做完"状态：' + parts.join('；') + '。本镜必须从这里长出来——不许重新起势、不许重新站位。';
  }

  // 事件类型 → 中文短名（聚合计数用）：素材里写「同类动作(spell_release)×3」既长又难读，
  //   换成「法术脱手×3」——同样的信息，一条省十几个字，一镜二十来条就是几百字。
  const EV_ZH = { afterimage:'残影', cast_move:'踏罡步斗', hover_move:'凌空绕飞', footwork:'待位活步', dash_end:'冲刺收脚',
    filler:'垫步换位', whiff:'落空', unstick:'卡住脱困', hover_end:'收功落地', debris:'碎块飞散', quake:'地面震荡',
    attack:'出手', hit:'命中', block:'格挡', clash:'兵器相击', guardbreak:'崩防', dash:'冲刺', leap:'起跳', takeoff:'起跳',
    landing:'落地', slam:'砸地', cornered:'被逼入角', ring_out:'被打出场', ko:'击倒', spell_cast:'蓄法起手',
    spell_release:'法术脱手', spell_hit:'法术命中', spell_guard:'护体挡法', spell_absorbed:'法术被吸', spell_fade:'法术消散',
    spell_after:'法术余波', ward_broken:'护体被震碎', ward_hold:'护体硬吃', cast_cancel:'施法被打断', qi_burst:'气劲外放',
    aura:'灵光护体', phenomenon:'天地异象', ground_scar:'地面留痕', obstacle_hit:'掩体被砸', prop_broken:'器物碎裂',
    trait:'神通', hover:'悬空停留', air_stall:'滞空调整', flee:'脱离',
      launch:'被击飞离地', knockdown:'被击倒', getup:'翻身起身' };   // 2026-09-29：击飞/击倒/起身（内核已真的结算出来）
  const evZh = (t, count) => {
    const zh = EV_ZH[t] || EV_ZH[String(t).replace(/^同类动作\((.*)\)$/, '$1')] || String(t).replace(/^同类动作\((.*)\)$/, '$1');
    return zh + '×' + count;
  };
  /**
   * 官方「六列标准镜头信息表 / 单文本分镜」的**结构化**分镜块：每一镜返回
   *   { n, k0, k1, sec, hook, lines[], anchors{landmarks,pos,light,ids}, continuity{from,to},
   *     dirs[]（逐秒指令）, timeline, cam, camTag }
   *   ——测试与 EXE 自检直接读这些字段，不去正则抠文本；shots() 只是把它拼成文本。
   */
  // ── 出招慢放特写 ＆ 满屏光彩（2026-09-29 用户要求）────────────────────────────
  //   用户原话：「这出特效的招式都那么普通的吗？能不能出招做一个慢放特写，然后把特效的场面撑大的一点。
  //             特效要好比好莱坞大片那种。满屏光彩、气功特效。」
  //   两条口径都必须是**可拍指令**（镜头怎么动、时间流速多少、光铺到什么程度、前景有什么），
  //   不是"更炫一点"这种模型读不懂的话；并且必须与官方口径兼容：
  //     · 慢放只吃本段里的一小段（默认 0.8 秒），**不改变本段总时长**，1:1 时钟不变；
  //     · 时间一律写"第 X.X 秒"（本段内相对秒），不去抢官方的 At MM:SS.mmm 切镜时间码。
  const HERO_PRI = { ko:0, ring_out:1, phenomenon:2, trait:3, ward_broken:4, knockdown:5, guardbreak:6, slam:7, spell_hit:8, launch:9, hit:10, clash:11 };
  const HERO_FOCUS = { ko:'终结一击的接触点', ring_out:'把对手震出场地的那一下', phenomenon:'天地异象的爆心',
    trait:'神通成形的那一刻', ward_broken:'护体被打碎的位置', guardbreak:'崩防的接触点', slam:'把对手砸进地里的那一下',
    spell_hit:'法术命中的爆心', hit:'命中的接触点', clash:'兵器交击的那一点' };
  /** 本镜最值得慢放的一拍（按"故事重量"选，取内核真实事件与真实秒数；没有就退到最重的一招） */
  function heroBeat(r, ev){
    let best=null;
    for(const e of (ev||[])){
      const p=HERO_PRI[e.type]; if(p===undefined) continue;
      const heavy=(e.finisher?0:(e.heavy?0.5:1));
      const score=p+heavy;
      if(!best || score<best.score) best={ e:e, score:score, kind:'beat' };
    }
    if(best) return best;
    for(const e of (ev||[])){
      if(e.type!=='attack' && e.type!=='spell_cast') continue;
      const heavy=(e.finisher?0:(e.heavy?0.5:1));
      if(!best || heavy<best.score) best={ e:e, score:heavy, kind:'move' };
    }
    return best;
  }
  /** 出招慢放特写：镜头／时间流速／介质／回速四件事都写死，模型照着拍 */
  function heroLine(r, cfg, ev, english){
    const b=heroBeat(r,ev); if(!b) return '';
    const t=+b.e.t||0, t2=+(t+0.8).toFixed(2), slow=0.35, hold=0.8;
    // 推近是**摄影机在动**：把这一拍两人的画面站位写进特写句里，模型才不会靠"挪人/放大人物"来实现推镜
    //   （用户 2026-10-01：「人物的位置会突然瞬移，应该是镜头描写的问题」）。
    const _row = stageRow(r, t);
    const _SIDE_EN = { '左': 'screen-left', '中': 'centre-frame', '右': 'screen-right' };
    const _pos = (function(){
      if(!_row || !_row.A || !_row.B) return (english ? 'Camera moves, fighters do not. ' : '推近是摄影机在动，两人的站位不变。');
      if(english) return ('Both fighters hold their marks (the camera moves, they do not): ' + (r.A.name||'A') + ' ' + (_SIDE_EN[_row.A.side]||'screen-left')
        + ', ' + (r.B.name||'B') + ' ' + (_SIDE_EN[_row.B.side]||'screen-right') + ', ' + _row.dist.toFixed(1) + ' m apart. ');
      return ('推近是摄影机在动、两人的站位不变：' + (r.A.name||'A') + ' 在画面' + _row.A.side + '侧、' + (r.B.name||'B') + ' 在画面' + _row.B.side + '侧，相距 ' + _row.dist.toFixed(1) + ' 米。');
    })();
    if(b.kind==='move'){
      const mv=b.e.tech||b.e.move||b.e.name||(english?'the heaviest strike':'这一记最重的招');
      return english
        ? ('  HERO SHOT: ' + mv + ' plays as a slow-motion FULL-BODY technique close-up from wind-up to contact - the camera pushes in within 0.2 s to frame the WHOLE fighter (head to feet, about a third to a half of the picture) together with the full arc of the move and the skill VFX in one frame. '
           + 'Never a big-head / face / hand / weapon-only close-up (writing "the striking limb fills half the frame" just gets you a giant head); the VFX may fill the frame but must never hide the full silhouette. '
           + _pos
           + 'time ramps to ' + slow + 'x for about ' + hold + ' s (qi builds ring by ring, rain and dust hang still), then it snaps back to real speed and the camera whips out to a medium shot. '
           + 'The slow motion eats only ' + hold + ' s inside this shot; shot length and the 1:1 clock do not change.')
        : ('　【出招慢放特写】把这一镜最重的一招（' + mv + '）从起手到接触点拍成慢镜：镜头 0.2 秒内急推到「全身招式特写」——整个人物（头顶到脚，占画幅三分之一到一半）＋这一招的完整动作（起手→发力→接触→收势）＋技能特效，同在一个画面里；'
           + '不许写成大头／脸部／手部／兵器／接触点的局部大特写（写「急推到发力部位大特写」模型只会给一颗大头）；特效可以铺满画幅，但不许盖住人物的全身轮廓。'
           + _pos
           + '时间流速降到 ' + slow + '×、约 ' + hold + ' 秒——气劲一层层长出来，雨丝与碎屑几乎悬停；随后回速、镜头甩开成中景。慢放只吃本段 ' + hold + ' 秒，时长与 1:1 时钟不变。');
    }
    const focus=HERO_FOCUS[b.e.type]||'接触点';
    const tech=b.e.tech||b.e.move||'';
    return english
      ? ('  HERO SHOT: the ' + t.toFixed(1) + ' s beat - ' + focus + (tech?(' (' + tech + ')'):'') + ' - plays as a slow-motion FULL-BODY technique close-up: the camera pushes in within 0.2 s to frame the WHOLE fighter (head to feet, about a third to a half of the picture) together with the strike and the skill VFX in one frame, '
         + 'never a big-head / face / hand / weapon-only or contact-point close-up (writing "close-up on the contact point" just gets you a giant head); the VFX may fill the frame but must never hide the full silhouette. '
         + _pos + ' '
         + 'time ramps to ' + slow + 'x for about ' + hold + ' s (qi and light build ring by ring, dust hangs in the air), then at ' + t2.toFixed(1) + ' s it snaps back to real speed and the camera whips out to a medium shot. '
         + 'Only ' + hold + ' s of this shot is slowed; shot length and the 1:1 clock do not change.')
      : ('　【出招慢放特写】第 ' + t.toFixed(1) + ' 秒那一拍——' + focus + (tech?('（' + tech + '）'):'') + '——拍成慢镜：镜头 0.2 秒内急推到「全身招式特写」——整个人物（头顶到脚，占画幅三分之一到一半）＋这一招的完整动作（起手→发力→接触→收势）＋技能特效，同在一个画面里；'
         + '不许写成大头／脸部／手部／兵器／接触点的局部大特写（写「急推到接触点大特写」模型只会给一颗大头）；特效可以铺满画幅，但不许盖住人物的全身轮廓。'
         + _pos
         + '时间流速降到 ' + slow + '×、约 ' + hold + ' 秒——气劲与光一层层长出来，尘土雨滴悬在半空；第 ' + t2.toFixed(1) + ' 秒末回速、镜头甩开成中景，冲击波带碎屑甩出画面。'
         + '慢放只吃本段 ' + hold + ' 秒，时长与 1:1 时钟不变。');
  }
  /** 满屏光彩：按武力等级给"光铺到多大"，并要求气功过曝、前景大颗粒、镜头一震、边缘耀斑 */
  function screenLadder(tier, english){
    const T=+tier||6;
    if(T>=9) return english
      ? 'the frame blows out to a white core, then colour returns: sky phenomena fill the frame (light pillar / qi ring / cloud spiral), the qi body outgrows the arena'
      : '整幅先过曝成白芯再回色：天地异象占满画幅（光柱／气环／云层漩涡），气功实体比场地还大';
    if(T>=7) return english
      ? 'the glow overflows the subject: the qi ring opens wider than both fighters, the whole frame is lit'
      : '光溢出主体：气劲炸开成比两人还宽的环，整幅画面被照亮';
    if(T>=4) return english
      ? 'the glow overflows the contact point and lights over half the frame, a floor-wide dust sheet rises'
      : '光从接触点溢出、照亮大半画幅，尘幕铺满地面';
    return english
      ? 'the glow stays at the contact point (a quarter of the frame); sparks still spit toward the lens'
      : '光贴着接触点（约画幅四分之一），火星仍朝镜头溅出';
  }
  function screenLine(r, cfg, ev, english){
    const hasFx=(ev||[]).some(e=>/^(spell_hit|phenomenon|trait|qi_burst|aura|ward_broken|ground_scar|prop_broken|quake|hit|guardbreak)$/.test(e.type));
    if(!hasFx) return '';
    const tier=+((cfg&&(cfg.tier||(cfg.kitA&&cfg.kitA.tier)))||(r.fx&&r.fx.tier)||0)||6;
    return english
      ? ('  FULL-FRAME LIGHT: ' + screenLadder(tier, true) + '; blow out to white then let colour return, foreground debris/rain streaks past the lens, one short camera shake, lens flare at the frame edge; the light may fill the frame but both fighters\' full silhouettes must stay readable.')
      : ('　【满屏光彩】光要铺满画幅：' + screenLadder(tier, false) + '；命中处先过曝成白芯再回色，前景碎片／雨滴贴镜头划过，镜头一震、边缘一圈耀斑；光铺满画幅但人物的全身轮廓仍要看得清（不许用光把人糊没）。');
  }
  function shotBlocks(r,cfg,english,opts){
    // ⚠ 这个集合只管"哪些事件不必逐条描写"（纯装饰），不是标签表——别拿 EV_ZH 整个替进来
    const SLIM_COSMETIC = { afterimage:1, cast_move:1, hover_move:1, footwork:1, dash_end:1, filler:1, whiff:1, unstick:1, hover_end:1 };
    const slimShots = !(opts && opts.full);
    // tight（最后一道降级，页面在"上传字数还超"时才打开）：本镜只留"空间＋坐标"一行与节奏读数，
    //   不再单列一行坐标、也不再逐镜写破坏读数——英文成片天生比中文长两三成，这一档是给它的。
    const tight = !!(opts && opts.tight) && slimShots;
    // ⚠ 时间基数：片长 = 内核实测时长（1:1）——分镜时间码与动作判定用**同一个时钟**。
    //   旧口径把实测时长线性铺到用户填的片长上（平均拉伸 2.11 倍、最坏 6.8 倍），
    //   招式被拉成慢动作、素材里两套时钟对不上（用户：「动作判定的时间和镜头不太对的上」）。
    const sec=filmLengthOf(r,cfg), lines=[], blocks=[];
    const durSim=+Math.max(r.duration,0.001);
    const TL=shotTimeline(r,cfg);                      // 时间线：锁定窗口 / 节拍 / 跨镜携带的动作
    // 官方口径：单次生成 4–15 秒 ⇒ 整场切成若干「段」逐段生成，**段内一镜到底**（只用运镜）。
    //   于是"切镜"只发生在段与段之间，段内不再切镜——这正是官方 §4.2「能运镜就别切，切镜必须带来新信息」。
    //   clipPlan 的切点全部落在节拍安全点（锁定窗口内一律不切），并且段长强制落在 4–15 秒内。
    const CLIPS=clipPlan(r,cfg);
    const n=CLIPS.length;
    const CAMP=cameraPlan(cfg);                        // 用户选的运镜/镜头艺术（没选时 active=false，走自动阶梯）
    const bounds=CLIPS.map(x=>x.k0).concat([CLIPS[CLIPS.length-1].k1]);
    const cuts=bounds.slice(1,-1);
    const CARD=landmarkCard(r);                        // 固定地标卡（内核真实物件＋真实场地尺寸）
    const _seenTypes={};                               // 供 hook「呼应」判定：前面几镜出现过的主事件类型
    const _storyRe=/^(hit|clash|guardbreak|ko|ring_out|slam|spell_hit|spell_guard|spell_absorbed|ward_broken|prop_broken|trait|phenomenon|landing|takeoff|launch|knockdown|getup)$/;
    // 每镜的时间线段（起止·节拍·切出时还在飞的动作·速度峰值）：分镜文本与素材都读它
    const segOf=(i)=>{
      const k0=bounds[i], k1=bounds[i+1];
      const carry=TL.carryAt(Math.max(k0,k1-0.05));
      const resolves=TL.locks.filter(L=>!L.soft&&(L.kinds||[]).indexOf('knockback')>=0&&L.t1>k1-0.02&&L.t1<=k1+1.2)
        .map(L=>({t:+L.t1.toFixed(2),why:L.why,n:i+2}));
      return { n:i+1, k0:+k0.toFixed(2), k1:+k1.toFixed(2), f0:+k0.toFixed(2), f1:+k1.toFixed(2),
        beats:TL.beats.filter(b=>b.t>=k0&&b.t<k1), carry:carry, resolves:resolves,
        speedMax:Math.max(frameSpeed(r,k0),frameSpeed(r,(k0+k1)/2),frameSpeed(r,Math.max(k0,k1-0.05))) };
    };
    const toFilm=t=>+t.toFixed(2);                     // 1:1：内核秒 = 片长秒
    // 场地尺寸：第一镜的场景句里必须写出来（用户要求「场景要描述空间场地大小」）
    const AR = r.arena || { w: 20, h: 12, z: 6 };
    const sizeZh = '场地 ' + (+AR.w).toFixed(1) + ' × ' + (+AR.h).toFixed(1) + ' × ' + (+(AR.z || 0)).toFixed(1) + ' 米';
    const sizeEn = 'arena ' + (+AR.w).toFixed(1) + ' x ' + (+AR.h).toFixed(1) + ' x ' + (+(AR.z || 0)).toFixed(1) + ' m';
    // 角色外形锁定句：descA/descB 可能挂在**编译配置**上（页面给的就是结算结果＋编译结果），两路都取，
    //   否则场景句会写成「甲 (, 剑) / 乙 (, 剑)」——外形丢了，成片就换脸。
    const _src = (cfg && (cfg.descA || cfg.descB)) ? cfg : ((cfg && cfg.source) || cfg || {});
    // 开场站位读数（第一镜交代一次）：两人在**场地中心**、相距几米——用户：「人物最开始放到场地中心」
    const _openRow = stageRow(r, 0);
    const openBits = (english
      ? ('Opening marks: both fighters start on the CENTRE of the arena, ' + (_openRow ? _openRow.dist.toFixed(1) : '3.2') + ' m apart, facing each other. ')
      : ('开场站位：两人都站在**场地中心**、相距 ' + (_openRow ? _openRow.dist.toFixed(1) : '3.2') + ' 米、面对面。'));
    const sceneHead=(i)=> i===0
      ? ((r.scenario&&r.scenario.key!=='none' ? (english ? ((SCEN_EN[r.scenario.key]||r.scenario.key)+'; ') : (r.scenario.zh+'；')) : '')+(english?(sizeEn+'; '):(sizeZh+'；'))+openBits+(cfg.scene?cfg.scene+'; ':'')+r.A.name+' ('+(cfg.descA||_src.descA||'')+', '+r.A.weaponName+') / '+r.B.name+' ('+(cfg.descB||_src.descB||'')+', '+r.B.weaponName+'). ')
      : '';
    // 连续时间线总纲：切镜＝换机位，时间不停、动作不重启（写在最前面，模型第一眼就看到）
    //   ＋官方分段口径：单次生成 4–15 秒，所以整场分成 N 段逐段生成、段内一镜到底。
    const intro = (n>1) ? (english
      ? ('ONE CONTINUOUS FIGHT on a single timeline: the cuts below are camera-angle changes only — time never stops and no action ever restarts. The first frame of each shot is the very next moment after the previous shot\'s last frame; carry momentum, stance and any unfinished swing straight through the cut. '
        + 'Generated in ' + n + ' passes (' + CLIPS.map(function(c2){return c2.sec.toFixed(1);}).join('s + ') + 's), each pass within the official 4-15 second range and each an unbroken take. Feed the LAST frame of one pass as the first-frame reference of the next one (see [Shot 1] alignment line).')
      : ('这是一条连续时间线：下面的切镜只是换机位——时间不停、动作不重启。每一镜的第一帧就是上一镜最后一帧的下一秒；惯性、架势、没收完的那一招必须原样带过切点，不许在新镜重新起势或重新站位。'
        + '本场按官方口径分 ' + n + ' 段生成（' + CLIPS.map(function(c2){return c2.sec.toFixed(1);}).join(' 秒 + ') + ' 秒，每段都在单次生成 4–15 秒区间内），**段内一镜到底**；跨段时把上一段的末帧作为下一段的首帧参考图，并在每段第一行写官方对齐句（页面上有「跨片段接续包」可直接复制）。')) : '';
    for(let i=0;i<n;i++){
      const lineStart=lines.length;
      const t0=bounds[i], t1=bounds[i+1];
      const a=toFilm(t0), b=toFilm(t1);
      const ev=r.events.filter(e=>e.t>=t0-1e-6 && e.t<t1-1e-6);
      // 逐条描写／逐秒指令共用的压缩器：招式/法术的「准备/有效/收招时间范围」与距离区间整段去掉
      //   （时机与距离另有时机行给口径），再压掉多余空格——一镜二十来条就是几百字。
      const compact = (x) => String(x)
        .replace(/（准备 [^）]*）/g, '').replace(/（有效 [^）]*）/g, '')
        .replace(/（起手 ([0-9.]+) 秒／有效 ([0-9.]+) 秒／收招 ([0-9.]+) 秒）/g, '（起手/有效/收招 $1/$2/$3 秒）')
        .replace(/（起手 [^）]*收招 [^）]*）/g, '')
        .replace(/，距离 [0-9.]+~[0-9.]+ 米/g, '')
        .replace(/准备 [0-9.]+~[0-9.]+ 秒（实取 ([0-9.]+) 秒）/g, '蓄力 $1 秒')
        .replace(/释放时间 [0-9.]+~[0-9.]+ 秒（实飞 ([0-9.]+) 秒，([0-9.]+) 米每秒）/g, '实飞 $1 秒·$2 米每秒')
        .replace(/[ ]{2,}/g, ' ').trim();
      const lineMax = Math.max(60, +((opts && opts.lineMax) || 0) || 150);
      let text = '', shownLines = null, hiddenTail = '';
      if (slimShots) {
        // 逐镜句数自适应：整篇最多 ~14 条逐条描写（4 镜＝每镜 3 条），其余并进计数；
        //   单句超过 lineMax 字也截断（末尾的时间范围/距离区间信息量最低）
        //   （2026-09-25 用户硬指标：一次上传 ≤2 万字符——分镜文本原来占 5.7 千，现在压到 3 千上下）
        //   页面在"提示词+证据 > 2 万"时会用 opts.perShot/opts.lineMax 再压一档（英文成片天然更长）
        const perShot = Math.max(1, +((opts && opts.perShot) || 0) || Math.max(4, Math.floor(18 / Math.max(1, n))));
        // ⚠ 名额有限时**优先留"故事级"的拍**（命中/对拼/崩防/击倒/砸地/法术命中/落地/建筑碎裂/神通/异象），
        //   剩下的名额再给出招与其它。旧口径只按时间顺序截断，长连段会把"命中"挤出句子——
        //   于是分镜里只剩一串出手、看不到结果（也就没了"谁打到谁"）。
        const STORY_LINE = /^(hit|clash|guardbreak|ko|ring_out|slam|spell_hit|spell_guard|spell_absorbed|ward_broken|prop_broken|trait|phenomenon|landing|takeoff)$/;
        const shown = ev.filter(e => !SLIM_COSMETIC[e.type]);
        const hidden = {};
        if (shown.length <= perShot) shownLines = shown.slice();
        else {
          shownLines = shown.filter(e => STORY_LINE.test(e.type)).slice(0, perShot);
          if (shownLines.length < perShot) shownLines = shownLines.concat(shown.filter(e => !STORY_LINE.test(e.type)).slice(0, perShot - shownLines.length));
          // 每一镜至少留一条"出手"：只有结果没有过程，模型写不出招式（也要有相位时长可照抄）。
          //   ⚠ 2026-09-30 修：旧规则把 spell_cast 也算"出手"，于是法术场次里 18 个名额被法术/命中占满，
          //     **兵器与拳脚的出招句连同相位时长整镜消失**（用户要求"所有招式都要给施法时间与释放时间"）。
          //     现在分开保：先保攻击招（attack），本镜确实没有攻击招时才用施法顶。
          const _needAtk = shown.some(e => e.type === 'attack') && !shownLines.some(e => e.type === 'attack');
          const _needCast = !_needAtk && !shownLines.some(e => e.type === 'spell_cast');
          const _mv = _needAtk ? shown.find(e => e.type === 'attack') : (_needCast ? shown.find(e => e.type === 'spell_cast') : null);
          if (_mv) {
            let _vi = shownLines.length - 1;
            while (_vi > 0 && /^(ko|round_over|ring_out)$/.test(shownLines[_vi].type)) _vi--;   // 别把终结拍挤掉
            shownLines = shownLines.slice(0, _vi).concat([_mv]);
          }
          shownLines.sort((x, y) => x.t - y.t);
          const keepSet = new Set(shownLines);
          shown.forEach((e) => { if (!keepSet.has(e)) { const k2 = '同类动作(' + e.type + ')'; hidden[k2] = (hidden[k2] || 0) + 1; } });
        }
        ev.forEach(e => { if (SLIM_COSMETIC[e.type]) hidden[e.type] = (hidden[e.type] || 0) + 1; });
        // 「本镜另有」是**不丢事件**的合同行：它保证 kept+counted==total。条目太多时只列前 8 项＋其余项数
        //   （2026-09-25 一次上传 ≤2 万字符：一镜二十多项全列出来要 300 字，8 项＋项数只要 150 字）
        const hk = Object.keys(hidden);
        const hShow = hk.slice(0, 8), hRest = hk.length - hShow.length;
        hiddenTail = hk.length
          ? (english
              ? ('[also in this shot: ' + hShow.map(k => String(k).replace(/^同类动作\((.*)\)$/, '$1') + 'x' + hidden[k]).join(', ') + (hRest > 0 ? (', +' + hRest + ' more kinds') : '') + ']')
              : ('（本镜另有：' + hShow.map(k => evZh(k, hidden[k])).join('、') + (hRest > 0 ? (' 等 ' + hk.length + ' 项') : '') + '，走位要连贯）'))
          : '';
      } else {
        // 审计档（full）：保留逐条事件清单（带秒）
        text = ev.map(e=>`(${toFilm(e.t).toFixed(2)}s) `+describe(e,r,english)).join(english?'; ':'；');
      }
      // 官方运镜（§4.3：运动类型＋幅度＋速度，写成句子里的自然动作）——段内一镜到底，所以每段只给一条运镜。
      //   2026-09-30：用户在界面上选了「运镜」/「镜头艺术」时**优先用他选的那套**（CAMP），没选才用自动阶梯。
      const camEn=CAMP.active ? CAMP.en(i,n) : ((n===1) ? CAM_ONESHOT_PROSE
        : CAM_LADDER[Math.min(i,CAM_LADDER.length-1)]);
      const camZh=CAMP.active ? CAMP.zh(i,n) : ((n===1) ? ('一镜到底、不切镜：' + CAM_LADDER_ZH[0])
        : CAM_LADDER_ZH[Math.min(i,CAM_LADDER_ZH.length-1)]);
      const cam=(english?camEn:camZh);
      const camTagZh=CAMP.active ? CAMP.tagZh(i,n) : (n===1 ? CAM_TAG_ZH[0] : CAM_TAG_ZH[Math.min(i, CAM_TAG_ZH.length-1)]);
      const camTagEn=CAMP.active ? CAMP.tagEn(i,n) : (n===1 ? CAM_TAG_EN[0] : CAM_TAG_EN[Math.min(i, CAM_TAG_EN.length-1)]);
      // 官方「逐秒指令」（Per-Second Directives）：把本镜按整秒切开，每秒覆盖
      //   动作／镜头运动／空间位置／音频线索／交接 五要素，且不留时间空隙（没事件的秒合并成区间）。
      //   上传档用它**替代**逐条事件清单（同样的信息、更少的字）；审计档两条都留。
      const dirEv = shownLines || ev;
      const _shownSet = shownLines ? new Set(shownLines) : null;
      const dirs = persecDirectives({ r:r, english:english, t0:t0, t1:t1, shown:dirEv, all:ev, isShown:(e)=>(_shownSet ? _shownSet.has(e) : true), card:CARD,
        camTagZh:camTagZh, camTagEn:camTagEn, absolute:(i === 0),
        isStory:(e)=>(slimShots ? _storyRe.test(e.type) : false),
        nextShotNo:(i<n-1?i+2:0),
        fmt:(e)=>{ const d2=compact(describe(e,r,english)); return d2.length>lineMax?(d2.slice(0,lineMax-1)+'…'):d2; } });
      // 本镜的起幅/落幅**相对位置**读数（切镜前后各量一次）——官方「参考锚点·人物位置（机位视角）」
      //   与逐秒指令的「空间」要素都读它；不再单独写坐标行（用户：「先取消用 XYZ 去控制角色方式吧」）。
      const rowIn=stageRow(r,t0), rowOut=stageRow(r,Math.max(t0,t1-1/60));
      // 本镜双方有没有兵器（距离带用词按「有械／徒手」分家，2026-10-01）
      const _armedIn = [weaponKindOf(r.A), weaponKindOf(r.B)].some(k => k !== 'bare');
      // 本镜节奏：这一镜里出了几拍、冲了几次、平均多快、最长空档多久（写"快动作"时要照这个分配笔墨）
      const tempoBit = (function(){
        try{
          const at=[], dashes=[];
          ev.forEach(e=>{
            if(e.type==='attack'||e.type==='spell_cast') at.push(e.t);
            if(e.type==='dash') dashes.push(e);
          });
          let sp=0, n=0;
          for(let k=1;k<=(r.frames||[]).length;k++){
            const f0=(r.frames||[])[k-1], f1=(r.frames||[])[k];
            if(!f0||!f1) break;
            if(f1.t<t0||f1.t>=t1) continue;
            const dt=f1.t-f0.t; if(!(dt>0)) continue;
            for(const id of ['A','B']){ const q=f1[id], pp=f0[id]; if(!q||!pp) continue;
              if(q.st==='idle'||q.st==='move'){ n++; sp+=Math.hypot(q.x-pp.x,q.y-pp.y)/dt; } }
          }
          if(!n && !at.length) return '';
          const gap = at.length>1? (Math.max.apply(null,at)-Math.min.apply(null,at)) : 0;
          const avg = n? (sp/n) : 0;
          const dsum = dashes.reduce((x,e)=>x+(e.dist||0),0);
          return english
            ? ('  Pacing: '+at.length+' strike'+(at.length===1?'':'s')+', avg free-move '+avg.toFixed(1)+' m/s, '+dashes.length+' sprint'+(dashes.length===1?'':'s')+' ('+dsum.toFixed(1)+' m) — keep it moving, no slow walk-ups.')
            : ('　【本镜节奏】这一镜出手 '+at.length+' 拍、自由移动平均 '+avg.toFixed(1)+' 米/秒、冲刺 '+dashes.length+' 次（共 '+dsum.toFixed(1)+' 米'+(at.length>1?('，'+at.length+' 拍分布在 '+gap.toFixed(1)+' 秒内'):'')+'）——按这个速度写，不许写成慢慢走近。');
        }catch(e2){ return ''; }
      })();
      // 本镜破坏：这一镜碎了几件、飞了多少碎片（写"打碎周围"时照这个分配笔墨）
      const destructBit = tight ? '' : (function(){
        try{
          const inShot = (e)=> e.t>=t0-1e-6 && e.t<t1+1e-6;
          const broken = ev.filter(e=>e.type==='prop_broken'&&inShot(e));
          const debris = ev.filter(e=>e.type==='debris'&&inShot(e));
          const quakes = ev.filter(e=>e.type==='quake'&&inShot(e));
          if(!broken.length && !debris.length && !quakes.length) return '';
          const names = broken.map(e=>e.propName).filter(Boolean).slice(0,6).join('、');
          const pieces = debris.reduce((x,e)=>x+(e.pieces||0),0);
          return english
            ? ('  Destruction: '+broken.length+' smashed ('+(names||'-')+'), '+pieces+' debris pieces, '+quakes.length+' ground shocks — keep the wreckage in frame.')
            : ('　【本镜破坏】碎掉 '+broken.length+' 件（'+(names||'-')+'）、碎片约 '+pieces+' 片、震荡 '+quakes.length+' 次——碎块与烟尘要留在画面里，后面几镜不许复原。');
        }catch(e2){ return ''; }
      })();
      // 交接：本镜要接住上一镜"没做完"的动作（只用第 2 镜起的开头，属于"续接指令"）
      const hd = (i===0) ? '' : handoff(r,t0,english);
      // 跨切点的招式：上一镜要写明"切走时它还没完"，本镜要"接着把它做完"
      const strad = (i>0) ? straddlingAttack(r,t0) : null;
      const stradHead = strad
        ? (english
            ? `Take over the unfinished ${strad.e.tech||'attack'} from the previous shot (it was cut mid-swing with ~${strad.rest}s left): finish that motion first, then continue.`
            : `接着把上一镜没做完的「${strad.e.tech||'这一招'}」做完（切走时它还剩约 ${strad.rest} 秒），做完再进下一拍。`)
        : '';
      const stradTail = (() => {
        const nx = bounds[i+1];
        const st = (i<n-1) ? straddlingAttack(r,nx) : null;
        return st
          ? (english
              ? `\nThis shot is cut away mid-${st.e.tech||'attack'} — the swing is still in flight at the cut.`
              : `（本镜在「${st.e.tech||'这一招'}」中途切走——切点时这一招还没打完，动作留到下一镜继续。）`)
          : '';
      })();
      const flowBit = (i===0)
        ? (english?'Start framing: ':'起幅镜头：')
        : (english?'Continue framing: ':'续接镜头：');
      // 跨镜锁定：每镜都原样重复"同一场/同一人/同一套服装兵器/同一光线/同一轴线"——
      //   这是治"一切镜什么都变了"的关键（视频模型没有跨镜记忆，不重申就会重画整个世界）。
      const _rowStart = stageRow(r, t0);
      const lockBit = (i===0 && n===1) ? '' : ('　' + lockLine(r,cfg,english,
        (_rowStart && _rowStart.A && _rowStart.A.side) || '左', (_rowStart && _rowStart.B && _rowStart.B.side) || '右') + '　');
      // 转场方式：第 2 镜起给出"看得见的转场"，避免模型把硬切当成新场景
      const transBit = (i===0) ? '' : ('　【切镜方式】' + TRANS_LADDER[(i-1) % TRANS_LADDER.length].zh + '。　');
      // 轴线换了就要在本镜末尾写出"交叉换位"这一步（否则下一镜的左右是凭空变的——观众眼里的"换位/换人"）
      const crossTail = (function(){
        try{
          if (i>=n-1) return '';
          const nx = stageRow(r, bounds[i+1]);
          if (!nx || !rowOut) return '';
          const aOut = rowOut.A.side, bOut = rowOut.B.side, aIn = nx.A.side, bIn = nx.B.side;
          if (aOut === aIn && bOut === bIn) return '';
          const nmA = r.A.name || 'A', nmB = r.B.name || 'B';
          const zhS = (v) => (v === '左' ? '画面左侧' : (v === '右' ? '画面右侧' : '画面中间'));
          return english
            ? ('\nThe axis swaps across this cut: end this shot with ' + nmA + ' crossing to ' + zhS(aIn) + ' and ' + nmB + ' to ' + zhS(bIn) + ' (write the crossing step itself), then the next shot continues from there.')
            : ('（本镜末尾两人**交叉换位**：' + nmA + ' 绕到' + zhS(aIn) + '、' + nmB + ' 绕到' + zhS(bIn)
              + '——这一步必须写出来（绕步/交叉/被击退换位），下一镜才从这个站位继续。）');
        }catch(e2){ return ''; }
      })();
      // 时间线行（用户要求"用 TIMELINE 的方式去控制"）：本镜起止秒（1:1 时钟）＋节拍＋切出时还在飞的动作
      const seg=segOf(i);
      const tlBit=timelineLine(r,cfg,i,seg,english);
      // 官方镜语法（§4.2）：第 1 镜**不带时间码**；后续镜以严格递增的切点时间开头
      //   `[Shot N] At 00:03.500, the camera cuts to …`；切镜必须带来新信息（官方 §4.2）。
      //   中文稿件也保留官方那半句英文切换语（`At … , the camera cuts to …` 是 H3 认的字面语法），
      //   后面再补一句中文，保证中文作者一眼能读。
      const head = (i===0)
        ? '[Shot 1]'
        : ('[Shot ' + (i+1) + '] ' + h3Stamp(a) + ' the camera cuts to a new viewpoint'
           + (english ? '' : '（镜头切到新机位）'));
      const hook = hookOf(ev, i, _seenTypes);
      ev.forEach((e) => { _seenTypes[e.type] = (_seenTypes[e.type] || 0) + 1; });   // 供后面几镜判「呼应(callback)」
      const segHead = '《S' + String(i+1).padStart(2,'0') + ' / ' + (b-a).toFixed(1) + 's》' + hookText(hook, english);
      // 官方「参考锚点（空间＋身份）」：四个子字段全部用**画面相对位置**（不写坐标）
      const nmA2 = r.A.name || 'A', nmB2 = r.B.name || 'B';
      const sideTxt = (x, isA) => {
        if (!x) return english ? '-' : '—';
        const side = english ? ({ '左': 'screen-left', '中': 'centre', '右': 'screen-right' }[x.side] || 'centre')
                             : ('画面' + x.side + '侧');
        const dep = english ? ({ '更近': 'foreground', '同一纵深': 'midground', '更远': 'background' }[x.depth] || 'midground')
                            : x.depth;
        const face = (x.faceToB === false) ? (english ? ', turned away' : '、侧身/背对') : (english ? ', facing the opponent' : '、正对对手');
        const stance = english ? ({ '站姿': 'on foot', '半蹲': 'crouched', '腾空': 'airborne', '倒地': 'down' }[x.stance] || x.stance) : x.stance;
        let wpn = (isA ? r.A.weaponName : r.B.weaponName) || '';
        if (/^(空手|徒手|无|none)$/i.test(String(wpn).trim())) wpn = '';   // 徒手不写「持空手」

        return side + (english ? ' / ' : '·') + dep + face + (english ? ', ' : '·') + stance + (wpn ? ((english ? ' with ' : '持') + wpn) : '');
      };
      const posLine = (english ? 'Character positions (camera view): ' : '人物位置（机位视角）：')
        + nmA2 + ' ' + sideTxt(rowIn && rowIn.A, true) + (english ? ' | ' : '；') + nmB2 + ' ' + sideTxt(rowIn && rowIn.B, false)
        + (tight ? '' : ((english ? '. Exited-character status: none - both fighters stay in frame the whole time' : '。退场人物状态：无——两人全程都在画面内')));
      const _fx = r.fx || {};
      // 官方「光位基线」＝主光/补光/轮廓光方向＋本镜调整项。方向是**一致性指令**（写死一套、跨镜不许翻光位），
      //   而"本镜调整项"取内核真实的特效档光照后果（r.fx.light 来自特效分级表，不是编的）。
      const keyFill = english
        ? 'key: high overcast daylight; fill: ground bounce; rim: rain-glow behind the fighters'
        : '主光：阴天天光顶光；补光：地面反光；轮廓光：雨幕背后勾边';
      const lightBase = (_fx.light && _fx.light !== '—')
        ? (english ? (EN_FX[_fx.light] || _fx.light) : _fx.light)
        : (english ? 'flat overcast light, no extra glow' : '阴天平光、无额外光效');
      const lightMod = (function(){
        const sp = ev.filter(e => /^(spell_hit|phenomenon|trait|qi_burst|aura|ward_broken|ground_scar|prop_broken|quake)$/.test(e.type));
        if (!sp.length) return english ? 'no extra flash this shot' : '本镜无额外闪光';
        return english
          ? ('extra flash on ' + sp.length + ' beat(s): ' + (_fx.name ? (EN_FX[_fx.name] || _fx.name) + ' tier' : 'impact') + ' glow')
          : ('本镜附加闪光：' + (EV_ZH[sp[0].type] || sp[0].type) + (sp.length > 1 ? (' 等 ' + sp.length + ' 处') : '') + '（' + (_fx.name || '当前档') + '档光效）');
      })();
      const lightLine = (english ? 'Lighting baseline: ' : '光位基线：') + keyFill + (english ? '; ' : '；') + lightBase + (english ? ' (' : '（') + lightMod + (english ? ')' : '）');
      const sceneName = (cfg && (cfg.scene || (cfg.source && cfg.source.scene))) || (r.scenario && r.scenario.zh) || '';
      const idLine = (english ? 'Identity bindings: ' : '身份绑定：')
        + '[char:' + nmA2 + '] [char:' + nmB2 + ']' + (sceneName ? (' [scene:' + sceneName + ']') : '') + ' [hook:' + hook + ']';
      // 官方「连续性衔接」：接上镜（上一镜末帧没做完的状态）＋交给下镜（本镜末帧锁定的状态）
      const _trimEnd = (s) => String(s || '').replace(/[。.]+$/, '');
      const fromPrev = (i===0)
        ? (english ? 'this is the opening shot - no previous state' : '本镜是开场镜，没有上一镜状态')
        : (i > 0
            ? (english ? 'continue straight out of the previous shot\'s last frame - same marks, only the camera changed'
                       : '从上一镜最后一帧直接续上（站位、朝向、架式都不变，只是换了机位）')
            : _trimEnd(hd || (english ? 'grow out of the previous shot\'s last frame' : '从上一镜最后一帧长出来')));
      const toNext = (function(){
        if (i >= n-1) return english ? 'closing shot - settle on the final state, start nothing new' : '收尾镜——收在落定状态上，不再起新动作';
        const st = straddlingAttack(r, bounds[i+1]);
        const bits = [];
        if (st) bits.push(english ? ('the swing is still in flight at the cut (' + (st.e.tech||'attack') + ')') : ('切点时「' + (st.e.tech||'这一招') + '」还没打完'));
        // 后续镜不再复述站位：只把"这一招还没打完"这半句交给下一镜（换机位不改站位）
        if (rowOut && i === 0) bits.push(english ? ('carry this state over: ' + posShort(rowOut, true)) : ('位置带到下一镜：' + posShort(rowOut, false)));
        return bits.join(english ? '; ' : '；');
      })();
      const dirHead = (i === 0)
        ? (english
            ? 'Per-second directives (each second covers action / camera / space / audio / handoff, no time gaps):'
            : '逐秒指令（每秒覆盖 动作·镜头运动·空间位置·音频线索·交接，无时间空隙）：')
        : (english
            ? 'Per-second directives (each second covers action / camera / MOVEMENT / audio, no time gaps; positions carry over from the previous shot):'
            : '逐秒指令（每秒覆盖 动作·镜头运动·位移·音频线索，无时间空隙；站位沿用上一镜）：');
      lines.push(head + ' ' + segHead + (i===0 ? (english?' ':'　') + sceneHead(0) : '')
        + (english ? ' ' : '　') + flowBit + cam + (english ? '.' : '。') + lockBit + transBit);
      if (i === 0) {
        // 第一镜：一次性交代全套锚点（地标＋站位＋架式＋光位＋身份）——后面各镜**不再重复**
        lines.push((english ? 'Anchors - ' : '锚点｜') + landmarkLine(r, CARD, b, english)
          + (english ? ' | ' : '｜') + posLine
          + (english ? ' | Stance: ' : '｜架式：') + guardStance(rowIn, r, english, 'A') + (english ? '; ' : '；') + guardStance(rowIn, r, english, 'B')
          + (english ? '. ' : '。') + stanceTail(rowIn, english, _armedIn)
          + (tight ? '' : ((english ? ' | ' : '｜') + lightLine + (english ? ' | ' : '｜') + idLine)));
      } else {
        // 后续镜（2026-10-01 用户：「别把位置又描述一遍，导致镜头一切换人物会瞬移到其他地方」）：
        //   只写"这只是换机位"——位置/朝向/架式/光位沿用上一镜末帧，本镜只描述动作与运镜。
        lines.push(english
          ? ('Anchors - same two fighters, same arena, same marks as the LAST FRAME of the previous shot: this cut is a CAMERA CHANGE ONLY. '
             + 'Do not restate or re-stage their positions, do not swap sides, do not re-enter the scene - describe the ACTION and the camera move only.')
          : ('锚点｜接上镜：同一场地、同一站位、同一架式与光位，一切都从上一镜最后一帧直接续上——这一刀**只是换机位**。'
             + '**不要再交代位置、不许换边、不许重新入场**；本镜只写动作与运镜。'));
      }
      lines.push((english ? 'Continuity - from previous: ' : '衔接｜接上镜：') + fromPrev
        + (english ? '. To next: ' : '。交给下镜：') + toNext + crossTail + stradTail);
      // 出招慢放特写（用户：「能不能出招做一个慢放特写」）与满屏光彩（「满屏光彩、气功特效」）
      const hero = heroLine(r, cfg, ev, english);
      const screen = screenLine(r, cfg, ev, english);
      if (hero) lines.push(hero);
      if (screen) lines.push(screen);
      // 连击链：放在逐秒指令**前面**（模型先读到"连打"的读法，再读到逐拍表）
      const chains = exchangeChains(r, ev, english, t0);
      if (chains) lines.push((english ? '' : '　') + chains);
      lines.push(dirHead);
      dirs.forEach((x) => lines.push(x));
      if (hiddenTail) lines.push(hiddenTail);
      const tailLine = (tlBit + tempoBit + destructBit + stradHead + text).trim();
      if (tailLine) lines.push(tailLine);
      blocks.push({ n:i+1, k0:a, k1:b, sec:+(b-a).toFixed(2), hook:hook, cam:cam, hero:hero, screen:screen,
        camTag:(english?camTagEn:camTagZh), dirs:dirs, persecCount:dirs.length,
        // 元数据要与**真正印出来的**一致（第二镜起不再复述站位，只写"接上镜·只是换机位"）
        anchors: (i === 0)
          ? { landmarks:landmarkLine(r,CARD,b,english), pos:posLine, light:lightLine, ids:idLine }
          : (english
              ? { landmarks:'same landmarks as the previous shot (camera change only)', pos:'same marks as the last frame of the previous shot - not restated (camera change only)', light:'same lighting as the previous shot', ids:'same two fighters (identity unchanged)' }
              : { landmarks:'接上镜：同一场地、同一地标（只是换机位）', pos:'接上镜：站位沿用上一镜最后一帧，本镜不复述（只是换机位）', light:'光位沿用上一镜', ids:'同一对人物（身份不变）' }),
        continuity:{ from:fromPrev, to:toNext, cross:crossTail, carry:stradTail },
        timeline:tlBit, lines:lines.slice(lineStart) });
    }
    return { intro: intro, blocks: blocks };
  }
  /** 分镜文本（官方六列镜头表的文本形态）：开场总纲 + 每镜一段 */
  /** 专属技能 / 大招的一行提要（页面用 h3-skills.js 生成好传进来；没生成过就是空串） */
  function skillBrief(cfg, english) {
    const src = (cfg && (cfg.skillBriefZh || cfg.skillBriefEn)) ? cfg : ((cfg && cfg.source) || {});
    const v = english ? src.skillBriefEn : src.skillBriefZh;
    return v ? ('【本场专属技能 · 大招】' + String(v)) : '';
  }

  // ── H3 密度稿（2026-09-30，用户转来的一版评审口径）────────────────────────────
  //   H3 不是剧本监督：它优先吃的是**触发词、开场形象与场地、左右站位与间距、
  //   LoRA 见过的招名、接触反馈（格挡火星/踉跄/撞墙碎砖）**；秒表、场地米数、
  //   武力等级、特效精确米数几乎当气氛词扫过去。所以**最终提示词正文**要的是：
  //     ① 全片 12~16 拍（15 秒级），**单镜最多 3 拍** ＝ 两记完整招 ＋ 一次防守结果；
  //     ② 一条压制链：压制 3~5 招 → 半拍空档反打 → 转压制 → 一记沿作用线终结（撞墙只一次）；
  //     ③ **特效只升一档一次**，其余用写实词（掌风/火星/碎石/衣破）；
  //     ④ 每镜第一句「承接上一镜末帧（同一秒表继续）」并**抄上一镜落幅**（左右/远近/姿态/间距）；
  //     ⑤ 不写逐秒指令表、连击链、锚点卡、破坏统计、时间线记账——那些留在证据 JSON 与第 1 步素材里
  //        （正文里塞这些只占权重，还会把中间几拍挤掉）。
  const DENSE_KIND = { ko: 9, launch: 8, spell_hit: 8, hit: 7, guardbreak: 7, slam: 6, knockdown: 6,
    clash: 5, block: 5, skill: 5, spell_release: 4, spell_cast: 2, attack: 4, dodge: 3, landing: 2, prop: 2 };
  //   连续光效词：除"升档那一次"之外一律削掉（用户口径：气刃只留一次，或整段降回写实）
  const FX_REPEAT_RE = /(金紫[＋+]?虚空黑|金紫|虚空黑|星辉|灵光|法相|气形|光柱|剑芒|雷弧|电弧|过曝白芯|满屏光彩)/g;
  const REAL_FALLBACK = { zh: ['掌风压得雨丝斜飞', '火星在兵刃上炸开', '碎石与雨点被踩得四散', '衣摆与发丝被劲风带起'],
    en: ['palm wind bends the rain', 'sparks burst off the blades', 'grit and rain scatter underfoot', 'hems and hair snap in the draft'] };
  function denseBudget(sec) { return Math.max(10, Math.min(16, Math.round((+sec || 15) * 0.9))); }
  function denseClause(e, r, english, lim, up) {
    let raw = '';
    try { raw = String(describe(e, r, english) || ''); } catch (err) { raw = ''; }
    raw = raw.replace(/[（(][^）)]*[）)]/g, ' ')                    // 括号里的工程读数（秒数/半径/扇角）正文不要
             .replace(/伤害\s*[0-9.]+/g, '').replace(/[0-9.]+\s*米\s*\/\s*秒/g, '')
             .replace(/[0-9.]+\s*米每秒/g, '').replace(/\*\*/g, '');
    const nm = (id) => ((r && r[id] && r[id].name) || id);
    const who = e.who ? nm(e.who) : '';
    const tech = e.tech || (e.move && (e.move.zh || e.move.name)) || '';
    const isAtk = e.type === 'attack' || e.type === 'spell_release' || e.type === 'skill';
    const seg = raw.split('｜');                                   // ①主体 ②套路明细 ③反馈
    let body = seg[0] || raw;
    const fb = ((seg.find((s) => /^\s*反馈[：:]/.test(s)) || '').replace(/^\s*反馈[：:]/, '')).trim();
    let head = '';
    if (isAtk && tech) {
      head = english ? (who + ' uses "' + tech + '"') : (who + '使出「' + tech + '」');
      body = body.replace(/^[^：:]*[：:]/, '');
    }
    const dash = body.split('——');
    let main = dash[0] || body;
    const eff = (dash.slice(1).join('——') || '').replace(/^[^：:]*[：:]/, '').trim();
    const arrow = main.split('→');
    if (arrow.length > 1 && isAtk) main = arrow.slice(1).join('，');  // 出招只留箭头后的动作
    main = main.replace(/命中[^，。；：]{0,10}[，,]?\s*命中/g, '命中').replace(/^[：:\s]+/, '').trim();
    const first = (s) => (String(s || '').split(/[，,。；;]/).map((x) => x.trim()).filter(Boolean)[0] || '');
    const parts = main.split(/[，,。；;]/).map((x) => x.trim()).filter(Boolean);
    let out = head;
    for (const p of parts) {
      const cand = out ? (out + '，' + p) : p;
      if (cand.length > (lim || 46) && out) break;
      out = cand;
      if (out.length >= (lim || 46)) break;
    }
    // 接触反馈（用户口径：H3 优先吃"格挡火星/踉跄/撞墙碎砖"这类反馈）
    const tail = up ? (first(eff) || first(fb)) : (first(fb) || '');
    if (tail && out.length < (lim || 46) * 0.85 && tail !== out) out += '，' + tail;
    return out.replace(/[、，\s]+$/g, '');
  }
  /** 压制链：压制 3~5 招 → 半拍空档反打 → 转压制 → 一记终结（确定性，取不到就退化成按分数挑） */
  function denseChain(r, cfg) {
    const ev = (r.events || []).slice().sort((a, b) => a.t - b.t);
    const dur = +r.duration || 0;
    const offensive = (e) => e.type === 'attack' || e.type === 'spell_release' || e.type === 'skill';
    const first = ev.find((e) => offensive(e) && e.t <= dur * 0.35);
    const P1 = first ? first.who : 'A';
    const P2 = P1 === 'A' ? 'B' : 'A';
    const runOf = (who) => {                                        // 最长的一段连续压制（允许对手插防守）
      let best = null, cur = null;
      ev.forEach((e) => {
        if (e.t > dur * 0.85) return;
        if (offensive(e) && e.who === who) { cur = cur || { who, from: e.t, to: e.t, n: 0 }; cur.to = e.t; cur.n++; }
        else if (offensive(e) && e.who !== who) { if (cur && (!best || cur.n > best.n)) best = cur; cur = null; }
      });
      if (cur && (!best || cur.n > best.n)) best = cur;
      return best;
    };
    const r1 = runOf(P1), r2 = runOf(P2);
    const swap = (r2 && r1 && r2.n >= 2) ? r2 : null;               // 转压制：对手连出 2 招以上才算
    const fin = ev.filter((e) => (e.type === 'launch' || e.type === 'ko' || e.type === 'slam' || e.type === 'knockdown') && e.t > dur * 0.55).pop();
    const counter = swap ? ev.find((e) => e.who !== P1 && (e.type === 'hit' || e.type === 'guardbreak' || e.type === 'clash') && e.t <= swap.from) : null;
    return { P1, P2, run1: r1, swap, counter, fin };
  }
  function denseShots(r, cfg, english, opts) {
    const o = opts || {};
    const dur = +r.duration || 0;
    const budget = denseBudget(o.seconds || (cfg && cfg.duration) || dur);
    // 15 秒级要有 12~16 拍，而单镜只放 3~5 拍 → **至少三镜**（换机位、时间不断），
    //   用户口径原文：「15 秒拆成三镜换机位（时间不断），全片大约 14 拍」。
    const segs = (function () {
      try {
        const auto = String((cfg && cfg.shotPlan) || 'auto');
        if (auto === 'auto' && dur >= 12.5) {
          const three = clipPlan(r, Object.assign({}, cfg, { shotPlan: '3' }));
          if (three && three.length >= 3) return three;
          // 内核找不到三个"节拍安全点"时，按时间等分三段（每段 ≥4 秒＝官方下限），时间照样不断
          if (dur >= H3_LIMITS.minSeconds * 3) {
            const step = dur / 3, out = [];
            for (let i = 0; i < 3; i++) out.push({ n: i + 1, k0: +(step * i).toFixed(2), k1: +(i === 2 ? dur : step * (i + 1)).toFixed(2) });
            return out.map((x) => Object.assign(x, { sec: +(x.k1 - x.k0).toFixed(2), oneTake: true }));
          }
        }
        return clipPlan(r, cfg);
      } catch (e) { return clipPlan(r, cfg); }
    })();
    const CAMP = (() => { try { return cameraPlan(cfg); } catch (e) { return { active: false }; } })();
    const chain = denseChain(r, cfg);
    const lim = o.lineMax ? Math.min(o.lineMax, 60) : (english ? 96 : 46);
    const evAll = (r.events || []).slice().sort((a, b) => a.t - b.t);
    const kindScore = (e) => DENSE_KIND[e.type] || 0;
    const OFFENSIVE = (e) => e.type === 'attack' || e.type === 'spell_release' || e.type === 'skill';
    // 升档只给一次：整片分数最高的那一拍保留光效，其余削成写实词
    let upIdx = -1, upScore = -1;
    evAll.forEach((e, i) => { const s = kindScore(e) + (e.heavy ? 2 : 0) + (e.finisher ? 3 : 0); if (s > upScore) { upScore = s; upIdx = i; } });
    const picked = new Map();                                       // 事件 → 文本（削光效后再缓存）
    const tidy = (t) => t.replace(/，\s*——/g, '——').replace(/——\s*命中：/g, '命中：')
      .replace(/[、，]{2,}/g, '，').replace(/^[、，：\s]+|[、，：\s]+$/g, '');
    const textOf = (e) => {
      if (picked.has(e)) return picked.get(e);
      const idx = evAll.indexOf(e);
      let t = tidy(denseClause(e, r, english, lim, idx === upIdx));
      if (idx !== upIdx) {
        const fb = REAL_FALLBACK[english ? 'en' : 'zh'];
        if (FX_REPEAT_RE.test(t)) { FX_REPEAT_RE.lastIndex = 0; t = tidy(t.replace(FX_REPEAT_RE, '')); if (t.length < 8) t = fb[idx % fb.length]; }
      } else { FX_REPEAT_RE.lastIndex = 0; }
      picked.set(e, t);
      return t;
    };
    // 每镜的构成：≤2 记完整招（进攻拍）＋ ≤3 拍结果/反应（受击、格挡、倒地、落地）
    const capOff = Math.max(1, Math.min(2, +o.capOff || 2));
    const capReact = Math.max(1, Math.min(3, +o.capReact || 3));
    const shotsPicked = segs.map((seg) => {
      const k0 = +seg.k0, k1 = +seg.k1;
      const pool = evAll.filter((e) => e.t >= k0 && e.t < k1 && kindScore(e) >= 3);
      pool.sort((a, b) => (kindScore(b) - kindScore(a)) || (a.t - b.t));
      const off = [], react = [];
      for (const e of pool) {
        const bag = OFFENSIVE(e) ? off : react;
        if (bag.length >= (OFFENSIVE(e) ? capOff : capReact)) continue;
        if (off.concat(react).some((x) => Math.abs(x.t - e.t) < 0.25)) continue;
        const dup = off.concat(react).some((x) => (x.tech || x.move) && (x.tech || x.move) === (e.tech || e.move));
        if (dup) continue;                                          // 同招复读只留一次
        bag.push(e);
      }
      const chosen = off.concat(react).sort((a, b) => a.t - b.t);
      if (!chosen.length) { const any = pool[0] || evAll.find((e) => e.t >= k0 && e.t < k1); if (any) chosen.push(any); }
      return chosen;
    });
    // 全片总拍数收进预算：按分数淘汰（首镜第一拍与终结拍保底）
    const flat = shotsPicked.reduce((a, b) => a + b.length, 0);
    if (flat > budget) {
      let need = flat - budget;
      const ranked = [];
      shotsPicked.forEach((arr, si) => arr.forEach((e, bi) => ranked.push({ si, bi, e, s: kindScore(e) + (e.finisher ? 5 : 0) })));
      ranked.sort((a, b) => (a.s - b.s) || (a.e.t - b.e.t));
      const drop = new Set();
      for (const x of ranked) {
        if (need <= 0) break;
        if (shotsPicked[x.si].length <= 1) continue;               // 每镜至少留一拍
        if (x.si === 0 && x.bi === 0) continue;                    // 开场第一拍保底
        if (x.e.finisher) continue;                                // 终结拍保底
        drop.add(x.si + ':' + x.bi); need--;
      }
      if (need > 0) shotsPicked.forEach((arr, si) => { while (need > 0 && arr.length > 1) { arr.pop(); need--; } });
      shotsPicked.forEach((arr, si) => {
        shotsPicked[si] = arr.filter((e, bi) => !drop.has(si + ':' + bi));
        if (!shotsPicked[si].length) shotsPicked[si] = [arr[0]];
      });
    }
    // 终结拍必进（被淘汰或被规则漏掉时补回来）
    if (chain && chain.fin) {
      const fin = chain.fin;
      const inAny = shotsPicked.some((arr) => arr.some((e) => e === fin));
      if (!inAny) {
        let si = segs.findIndex((s) => fin.t >= +s.k0 && fin.t < +s.k1);
        if (si < 0) si = segs.length - 1;
        shotsPicked[si] = shotsPicked[si].concat([fin]).sort((a, b) => a.t - b.t);
      }
    }
    // 「撞墙/撞碎」全片只留一次（用户口径：15 秒里两次 Lv4 级撞墙，模型分不清谁在压）
    let wallSeen = false;
    for (let si = 0; si < shotsPicked.length; si++) {
      const kept = [];
      for (const e of shotsPicked[si]) {
        const isWall = /撞[^，。；]{0,6}(墙|壁)|把墙|墙体|撞碎|砸碎/.test(textOf(e));
        if (!isWall || !wallSeen || e.finisher) { if (isWall) wallSeen = true; kept.push(e); }
      }
      if (kept.length) shotsPicked[si] = kept;
    }
    const lines = [];
    segs.forEach((seg, i) => {
      const k0 = +seg.k0, k1 = +seg.k1;
      const chosen = shotsPicked[i];
      const row0 = (() => { try { return stageRow(r, k0); } catch (e) { return null; } })();
      const rowEnd = (() => { try { return stageRow(r, Math.max(k0, k1 - 1 / 60)); } catch (e) { return null; } })();
      const camZh = CAMP.active ? CAMP.zh(i, segs.length) : ((i === 0) ? ('一镜到底、不切镜：' + CAM_LADDER_ZH[0]) : CAM_LADDER_ZH[Math.min(i, CAM_LADDER_ZH.length - 1)]);
      const camEn = CAMP.active ? CAMP.en(i, segs.length) : ((i === 0) ? CAM_ONESHOT_PROSE : CAM_LADDER[Math.min(i, CAM_LADDER.length - 1)]);
      const beats = chosen.map((e) => (english ? ('At ' + e.t.toFixed(2) + 's ') : ('第' + e.t.toFixed(2) + '秒 ')) + textOf(e) + (english ? '.' : '。'));
      if (english) {
        const head = (i === 0)
          ? ('[Shot 1] ' + camEn + ' Opening frame: ' + posShort(row0, true) + '. ')
          : ('[Shot ' + (i + 1) + '] Continuing from the last frame of the previous shot (same clock, no restart), t=' + k0.toFixed(2) + 's: ' + posShort(row0, true) + '. ' + camEn + ' ');
        lines.push(head + beats.join(' ')
          + ' Closing frame: ' + posShort(rowEnd, true) + '. Same location, same light, same faces, same costumes and weapons on both fighters, throughout.');
      } else {
        const head = (i === 0)
          ? ('[Shot 1] ' + camZh + '　起幅：' + posShort(row0, false) + '。')
          : ('[Shot ' + (i + 1) + '] 承接上一镜末帧（同一秒表继续）：t=' + k0.toFixed(2) + 's　' + posShort(row0, false)
             + '。先把上一镜的收势走完，再进下一拍，不重新站桩。' + camZh + '　');
        lines.push(head + beats.join('')
          + '落幅：' + posShort(rowEnd, false) + '。同一场、同一光线、同一张脸、同一套服装兵器，全程不换人。');
      }
    });
    const beatsTotal = lines.join('').split(english ? /At /g : /第/g).length - 1;
    const lead = english
      ? ('Continuity: one unbroken clock — every cut is only a camera change (the action carries across the cut). '
         + 'Total ' + beatsTotal + ' beats in ' + segs.length + ' shots; at most three full exchanges per shot. '
         + (chain && chain.run1 ? ((r[chain.P1] || {}).name || chain.P1) + ' presses first, then the counter and the turn, and the last hit sends the loser along the strike line. ' : ''))
      : ('一条连续时间线：下面每次切镜只是换机位——时间不停、动作不重启，每一镜的第一帧就是上一镜最后一帧的下一秒。'
         + '全片共 ' + beatsTotal + ' 拍、' + segs.length + ' 镜，单镜最多两记完整招＋一次防守结果，中间不写连点。'
         + (chain && chain.run1 ? ((r[chain.P1] || {}).name || '先手') + '先压制数招，被反打后转入反压制，最后一击沿作用线把人打出去。'
         : '') + '特效只升一档一次，其余写实接触反馈（火星、碎石、衣破、踉跄）。');
    return (o.noLead ? [] : [lead]).concat(lines).join('\n');
  }
  function shots(r,cfg,english,opts){
    if (opts && opts.dense) return denseShots(r, cfg, english, opts);
    const B = shotBlocks(r,cfg,english,opts);
    const _sk = skillBrief(cfg, english);           // 写在最前面：这一场会放哪些技能、大招叫什么、蓄力多久
    const out = (_sk ? [_sk] : []).concat(B.intro ? [B.intro] : []);
    B.blocks.forEach((b) => b.lines.forEach((x) => out.push(x)));
    return out.join('\n');
  }

  return {rules,compile,packet,evidenceText,slimPacket,tempoStats,destructionStats,describe,shots,shotBlocks,shotCount,timelineText,AFTER_WINDOW,
    denseShots,denseBudget,denseChain,
    stagingRows,stageRow,stageLine,STAGE_LEGEND,cutPoints,cutScore,handoff,straddlingAttack,shotTimeline,shotSegments,
    clipPlan,landmarkCard,landmarkLine,persecDirectives,refKit,H3_LIMITS,CAM_LADDER,CAM_LADDER_ZH,CAM_TAG_ZH,h3Stamp,cameraPlan,camTagOf,
    fxProfile,FX_TIERS,FX_STYLES,qiProfile,QI_BANDS,heroBeat,heroLine,screenLine,screenLadder,HERO_FOCUS};
});
