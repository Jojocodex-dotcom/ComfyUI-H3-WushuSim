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
  function fighter(name,kit,hp,flags,warnings){
    kit=kit||{};
    const weapon=flags.unarmed?'none':(E.WEAPONS[kit.weapon]?kit.weapon:'none');
    const w=E.WEAPONS[weapon], basic=kit.basic||{name:'普通攻击',dmg:2,range:2,interval:0.7};
    const compile=(s,i)=>Object.assign({},shape(s),{
      zh:s.name||'普通攻击',skillId:'skill-'+i,
      damage:finite(s.dmg,2,0,10000)*5,
      // UI range is grid units; 1 cell = 0.5m, clipped to a physical weapon envelope.
      reach:finite(s.range,2,0.1,100)*0.5/w.reach,
      cooldown:finite(s.cd==null?s.interval:s.cd,0.7,0.1,120),effect:s.effect||''
    });
    const skills=[basic,...(kit.attack||[])].filter(s=>{
      if(/摔|擒|锁喉/.test((s.name||'')+(s.effect||''))){ warnings.push(name+'：擒拿/摔投未实现，跳过「'+s.name+'」'); return false; }
      if(flags.noLeg&&/扫|踢|腿/.test((s.name||'')+(s.effect||''))) return false;
      return true;
    }).map(compile);
    if(!skills.length) throw Error(name+'：没有可执行的近战招式，请添加普通攻击或攻击招式。');
    skills.forEach(s=>{const old=s.reach;s.reach=Math.max(0.5,Math.min(1.3,s.reach));if(old!==s.reach) warnings.push(name+'：「'+s.zh+'」射程按近战兵器范围限幅');});
    for(const g of ['move','defense']) if((kit[g]||[]).length) warnings.push(name+'：'+({move:'自定义身法',defense:'自定义防御'}[g])+'尚未执行；轻功/踏墙/飞行由武力等级自动解锁，卡片里的自定义身法招式不参与结算，保留原卡供查阅');
    // 「法术」组：编译成远程施法（不必贴脸）。射程按「格→米」换算，并在 compile() 里随双方较高等级放大。
    const tier=finite(kit.tier,1,1,9);
    const qi=qiProfile(tier);
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
    return {name,tier,style:kit.style||'calm',weapon,hp:finite(hp,5,0.1,10000)*20,skills,spells,
      // 内力外放档（命中瞬间的气劲半径与额外击退；1~2 级为 0＝纯肉身）
      qi:{label:qi.label,burst:qi.burst,kb:qi.kb,castBonus:qi.castBonus},
      // 机动档：等级解锁的"能不能飞"（供证据与提示词引用）
      mobility:E.mobility(tier)};
  }
  function compile(cfg,seed){
    if(!Number.isFinite(+cfg.duration)||+cfg.duration<=0) throw Error('成片时长必须大于0');
    if(!Number.isInteger(seed)||seed<0||seed>4294967295) throw Error('随机种子须为0至4294967295的整数');
    const parsed=rules(cfg.rules),warnings=parsed.report.filter(r=>r.status==='unmapped').map(r=>'未识别规则：'+r.text);
    if(cfg.forced&&cfg.forced!=='auto') warnings.push('3D模式按真实结算判定胜负，不执行指定赢家。');
    const scen=E.scenario(cfg.scenario);
    if(cfg.scenario&&!E.SCEN[cfg.scenario]) warnings.push('未识别的打斗情景「'+cfg.scenario+'」：内核按通用场地（无掩体/无边界/无湿滑）结算。');
    // A/B 先建（只依赖角色卡），场地尺寸依赖双方等级
    const A=fighter(cfg.nameA,cfg.kitA,cfg.hpA,parsed.flags,warnings),B=fighter(cfg.nameB,cfg.kitB,cfg.hpB,parsed.flags,warnings);
    // ── 场地：UI 的单位是「格」（1 格 = 0.5 米），并按双方较高等级放大 ──────────
    // 与指南的场地表一致：1 级 = 输入值，9 级 = 输入值×9。旧版 3D 直接把输入当米、
    // 且完全没放大，所以"场地没按规划来"、高度也装不下浮空。
    const CELL=0.5;
    const Lmax=Math.max(A.tier,B.tier);
    const casters=[A,B].filter(F=>F.spells.length);
    const planW=finite(cfg.duelW,12,3,100)*Lmax*CELL;
    const planH=finite(cfg.duelH,8,3,100)*Lmax*CELL;
    const zIn=finite(cfg.duelZ,0,0,40);
    const planZ=(zIn>0?zIn:2)*Lmax*CELL;
    const MINW=8,MINH=5;                                   // 内核可用下限：分离/掩体/擂台都要空间
    let w=Math.max(planW,MINW),h=Math.max(planH,MINH);
    if(planW<w) warnings.push('场地 X 按规划为 '+planW.toFixed(1)+' 米（'+finite(cfg.duelW,12,3,100)+'格×'+Lmax+'级），低于内核可用下限，已抬到 '+w+' 米。');
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
    return {source:JSON.parse(JSON.stringify(cfg)),seed:seed>>>0,duration:30,arena:{w,h,z:arenaZ},A,B,rules:parsed.flags,ruleReport:parsed.report,warnings,
      scenario:scen.key,scenarioZh:scen.zh,arenaPlan:{cells:{w:finite(cfg.duelW,12,3,100),h:finite(cfg.duelH,8,3,100),z:(zIn>0?zIn:2)},level:Lmax,metres:{w:+planW.toFixed(2),h:+planH.toFixed(2),z:+planZ.toFixed(2)},startDistM:+dist.toFixed(2)},
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
    return {schema:'combat-evidence/1',seed:result.seed,simulationSeconds:result.duration,
      targetSeconds:cfg.duration,timeMap:'filmTime = simulationTime / simulationSeconds * targetSeconds',
      winner:result.winner,finish:result.summary.finish,
      // 情景：内核真的算了什么（掩体/边界/追逃/湿滑），提示词要按这个写
      scenario:result.scenario?{key:result.scenario.key,zh:result.scenario.zh,aerial:result.scenario.aerial,water:result.scenario.water,
        slick:result.scenario.slick,startZ:result.scenario.startZ,ring:result.scenario.ring?{r:+result.scenario.ring.r.toFixed(2)}:null}:null,
      props:result.props||[], chase:result.chase||null,
      counts:{obstaclesBroken:result.summary.obstaclesBroken,obstacleHits:result.summary.obstacleHits,ringOuts:result.summary.ringOuts,
        slips:result.summary.slips,splashes:result.summary.splashes,takeoffs:result.summary.takeoffs,landings:result.summary.landings,
        airHits:result.summary.airHits,maxZ:result.summary.maxZ,
        wallRuns:result.summary.wallRuns,wallKicks:result.summary.wallKicks,hovers:result.summary.hovers,hoverSeconds:result.summary.hoverSeconds,
        spellCasts:result.summary.spellCasts,spellHits:result.summary.spellHits,spellFades:result.summary.spellFades,
        qiBursts:result.summary.qiBursts||0},
      characters:{A:result.A,B:result.B},
      scene:cfg.scene,appearance:{A:cfg.descA,B:cfg.descB},events,
      trajectory:frames.filter((f,i)=>i%60===0||i===frames.length-1),warnings:(result.warnings||[]).filter(w=>!w.startsWith('未识别规则：')),unmappedRuleCount:(result.ruleReport||[]).filter(r=>r.status==='unmapped').length,
      note:'Coordinates are metres: x/y ground, z height. z>0 means airborne; the mobility ladder is tier-gated (tier 1-2 ground, 3-4 leap, 5-6 wall-kick, 7-9 true flight with hover and landing shockwave). The scenario is simulated, not decorative: field/chase have solid breakable cover, arena has a ring boundary (going out = ring-out), aerial starts everyone airborne, water makes the ground slick (slip/splash). Contact height is a band, not an anatomical wound. Dodge events record attempts, not guaranteed success.'};
  }
  function evidenceText(result,cfg){
    const p=packet(result,cfg);
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
    return JSON.stringify(p);
  }
  function describe(e,r,english){
    const name=id=>r[id]?r[id].name:id;
    const a=name(e.by||e.a||e.who),b=name(e.who||e.b);
    const num=v=>Math.round((v||0)*100)/100;
    // 起跳原因（内核 canLeap 带出来的 why）：提示词要写清"为什么跳"，不许无逻辑弹跳
    const LEAP_WHY_ZH={evade:'为躲开来招',attack:'为跃起重击',antiAir:'为迎空拦截',close:'为突进接近',chase:'为追击',reposition:'借墙换位',escape:'为脱离'};
    const LEAP_WHY_EN={evade:'to slip the incoming line',attack:'to leap into a strike',antiAir:'to intercept in the air',close:'to close the distance',chase:'to run the opponent down',reposition:'to take a wall angle',escape:'to break off'};
    const SPECIAL={takeoff:1,landing:1,landing_shock:1,obstacle_hit:1,ring_out:1,slip:1,splash:1,cornered:1,
                   wall_run:1,wall_kick:1,hover:1,hover_end:1,spell_cast:1,spell_release:1,spell_hit:1,spell_fade:1,air_recover:1,qi_burst:1};
    if(SPECIAL[e.type]){
      const who=name(e.who),other=name(e.who2);
      if(english){
        if(e.type==='takeoff') return who+' leaps into the air'+(e.peak!=null?(' to about '+e.peak.toFixed(2)+' m'):'')+(LEAP_WHY_EN[e.why]?(' ('+LEAP_WHY_EN[e.why]+')'):'');
        if(e.type==='landing') return who+' lands'+(e.hard?' hard':'')+(e.from>1?' from '+e.from+' m':'')+(e.water?' into the water':'');
        if(e.type==='landing_shock') return who+' lands and shockwaves '+other;
        if(e.type==='obstacle_hit') return who+' strikes the '+e.propName+(e.broke?' and shatters it':' — the cover blocks the line')+(e.spell?' (spell)':'');
        if(e.type==='ring_out') return who+' is knocked off the platform (ring-out #'+e.times+')';
        if(e.type==='slip') return who+' slips on the wet ground';
        if(e.type==='splash') return who+' splashes through the water';
        if(e.type==='wall_run') return who+' runs along the wall (wall '+e.wall+') at '+num(e.z)+' m';
        if(e.type==='wall_kick') return who+' kicks off the wall (wall '+e.wall+')';
        if(e.type==='hover') return who+' hovers in mid-air at '+num(e.z)+' m ('+(e.mob||'flight')+')';
        if(e.type==='hover_end') return who+' stops hovering at '+num(e.z)+' m';
        if(e.type==='spell_cast') return who+' begins casting '+e.tech+' from '+num(e.dist)+' m';
        if(e.type==='spell_release') return who+' releases '+e.tech+' towards the target ('+num(e.dist)+' m, '+num(e.spd)+' m/s)';
        if(e.type==='spell_hit') return e.tech+' cast by '+name(e.by)+' hits '+who+' from '+num(e.range)+' m';
        if(e.type==='air_recover') return who+' recovers mid-air at '+num(e.z)+' m and lands on their feet';
        if(e.type==='qi_burst') return who+' releases an internal-energy shockwave on contact ('+e.tech+', radius '+num(e.radius)+' m) that hurls '+other+' back '+num(e.kb)+' m';
        return who+'’s '+e.tech+' dissipates without hitting';
      }
      if(e.type==='takeoff') return who+'腾空跃起'+(e.peakZh?('，'+e.peakZh):(LEAP_WHY_ZH[e.why]?('（'+LEAP_WHY_ZH[e.why]+'）'):''));
      if(e.type==='landing') return who+'落地'+(e.hard?'（重落）':'')+(e.from>1?'，自 '+e.from+' 米高处砸下':'')+(e.water?'，水花四溅':'');
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
      if(e.type==='air_recover') return who+'在'+num(e.z)+'米高处凌空受身，就地稳住落地';
      if(e.type==='qi_burst') return who+'的「'+e.tech+'」气劲在「'+e.from+'」命中时外放（半径 '+num(e.radius)+' 米，把'+(name(e.who2)||(e.who==='A'?name('B'):name('A')))+'再震开 '+num(e.kb)+' 米）';
      return who+'的「'+e.tech+'」飞出界外自行消散';
    }
    // 招式库：出招句写"准备动作→出招动作"（带时间范围），命中句写"华丽效果"
    const MV = (function () {
      let lib = null;
      try { lib = require("./moves.js"); } catch (e) { lib = (typeof globalThis !== "undefined" && (globalThis.SIM3D_MOVES || globalThis.MOVE_LIB)) || null; }
      return lib;
    })();
    const rng2 = (rg) => rg ? (num(rg[0]) + '~' + num(rg[1])) : '';
    const moveOf = (e2) => e2 && e2.move ? e2.move : (MV ? MV.get(e2 && e2.tech) : null);
    const zh={attack:()=>{
        const mv = moveOf(e);
        const base = name(e.who)+'使出「'+e.tech+'」';
        if (mv && mv.prep && mv.act) {
          return base + '：' + mv.prep + '（准备 ' + rng2(mv.timing && mv.timing.charge) + ' 秒）→ '
            + mv.act + '（有效 ' + rng2(mv.timing && mv.timing.active) + ' 秒）'
            + (e.dur ? '（起手 ' + num(e.dur.w) + ' 秒／有效 ' + num(e.dur.a) + ' 秒／收招 ' + num(e.dur.r) + ' 秒）' : '')
            + (mv.range ? '，距离 ' + rng2(mv.range) + ' 米' : '');
        }
        return base + (e.dur?('（起手 '+num(e.dur.w)+' 秒／有效 '+num(e.dur.a)+' 秒／收招 '+num(e.dur.r)+' 秒）'):'');
      },
      hit:()=>{
        const mv = moveOf(e);
        const eff = mv && mv.effect ? '——' + mv.effect + '。' : '';
        return e.spell? (name(e.by)+'的「'+e.tech+'」隔空命中'+b+'（'+num(e.z)+' 米高度），伤害'+e.dmg+eff)
                      : (a+(e.air?'自 '+num(e.az)+' 米高处':'')+'以「'+e.tech+'」命中'+b+(e.air?'（凌空）':'（受击高度 '+num(e.z)+' 米）')+'，伤害'+e.dmg+eff);
      },
      block:()=>e.spell? (b+'以兵器架住'+a+'的「'+e.tech+'」（隔空被挡）') : (b+'格挡'+a+'的「'+e.tech+'」'),dodge:()=>b+(e.crouch?'下沉闪避':'侧向闪避'),clash:()=>name(e.a)+'与'+name(e.b)+'兵器对拼',
      guardbreak:()=>b+'被'+a+'击破架势',
      ko:()=>e.ringOut? who4(e)+'四次掉台，判负' : a+'以「'+e.tech+'」'+(e.air?'凌空':'')+'使'+b+'失去战斗能力',
      round_over:()=> '本场结束，胜者'+name(e.winner),whiff:()=>b+'出招落空'+(e.cover?'（被掩体挡住）':'')};
    function who4(ev){ return r[ev.who]?r[ev.who].name:ev.who; }
    if(english) return `${e.type}: ${a}${b!==a?' -> '+b:''}${e.tech?' ('+e.tech+')':''}${e.dmg!=null?', damage '+e.dmg:''}`;
    return zh[e.type]?zh[e.type]():e.type;
  }
  // ── 分镜规划：默认少切镜（能一镜到底就一镜到底）─────────────────────
  //   用户反馈：切太频繁 + 切完位置不对/换人。所以：① 镜头数按片长收敛 ② 切镜那一下必须
  //   把「上一镜结束时的真实状态」写进新镜开头（左右、间距、朝向、姿态、兵器），并重申同一两人。
  function shotCount(sec, want){
    const w=String(want==null?'auto':want);
    if(/^[1-6]$/.test(w)) return +w;
    const s=+sec||0;
    if(s<=8) return 1;
    if(s<=14) return 2;
    if(s<=22) return 3;
    return 4;
  }
  const CAM_ONESHOT=['One continuous take, no cuts'];
  const CAM_LADDER=['Wide tracking shot','Side tracking shot','Over-the-shoulder shot','Low-angle tracking shot','Slow dolly in','High-angle crane shot'];
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
  function shots(r,cfg,english){
    const sec=+cfg.duration, n=shotCount(sec,cfg&&cfg.shotPlan), lines=[];
    const sceneHead=(i)=> i===0
      ? ((r.scenario&&r.scenario.key!=='none'?r.scenario.zh+'；':'')+(cfg.scene?cfg.scene+'; ':'')+r.A.name+' ('+(cfg.descA||'')+', '+r.A.weaponName+') / '+r.B.name+' ('+(cfg.descB||'')+', '+r.B.weaponName+'). ')
      : '';
    for(let i=0;i<n;i++){
      const a=i*sec/n,b=(i+1)*sec/n;
      const ev=r.events.filter(e=>Math.min(n-1,Math.floor(e.t/Math.max(r.duration,0.001)*n))===i);
      const text=ev.map(e=>`(${(e.t/Math.max(r.duration,0.001)*sec).toFixed(2)}s) `+describe(e,r,english)).join(english?'; ':'；');
      const cam=n===1
        ? CAM_ONESHOT[0]+(english?': the camera opens wide, tracks with the fighters, pushes in on each clash and arcs up when the fight goes airborne — move the camera, never cut':'：镜头从全景跟拍起，随双方走位横移，命中时推近，打上天时抬升成仰角——只运镜，不切镜')
        : CAM_LADDER[Math.min(i,CAM_LADDER.length-1)];
      const tail=n===1?'' : (i===0?'':continuity(r,cfg,a,english)+' ');
      lines.push(`[Shot ${i+1}] ${a.toFixed(1)}-${b.toFixed(1)}s. ${cam}.${i===0?' '+sceneHead(0):''} ${tail}${text||(english?'Maintain positions and continuity.':'双方保持连贯走位与架势。')}`);
    }
    return lines.join('\n');
  }
  return {rules,compile,packet,evidenceText,describe,shots,shotCount,timelineText,AFTER_WINDOW};
});
