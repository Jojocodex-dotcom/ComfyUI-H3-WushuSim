(function(r,f){if(typeof module==='object'&&module.exports)module.exports=f();else r.H3_AI_REHEARSAL=f();})(globalThis,function(){
'use strict';
const ACTIONS=['approach','retreat','flank','attack','cast','block','dodge','roll','leap','flight','land','recover'];
const SYSTEM='你是3D战斗角色控制器，根据当前真实状态为双方各选一个下一步动作。不得编造命中、伤害、击倒结果。仅输出 JSON：{"A":{"action":"合法动作","variant":"可选招式key","reason":"战术理由"},"B":{"action":"合法动作","variant":"可选招式key","reason":"战术理由"}}。合法动作：'+ACTIONS.join(',')+'。体力低应恢复；攻击需考虑射程、对手动作；飞行须已解锁。cast 必须指定角色已经配置的法术或所属套路招式，只有合法空间和冷却才可释放。attack 可指定当前可用近战招式key。根据上一轮command_rejected改变策略，前一动作未完成时不要反复重发攻击。';
function parse(value){const raw=typeof value==='string'?value:String(value?.text||value?.content||'');const clean=raw.replace(/^```(?:json)?\s*/,'').replace(/\s*```$/,'');const obj=typeof value==='object'&&value.A?value:JSON.parse(clean);for(const id of ['A','B'])if(!obj[id]||!ACTIONS.includes(obj[id].action))throw Error('AI 必须为双方返回合法动作');return obj;}
function observe(result,t){const frames=result.frames||[];let f=frames[0];for(const x of frames){if(x.t>t+1e-6)break;f=x;}if(!f)throw Error('缺少逐帧战斗状态');return {t,arena:result.arena,A:f.A,B:f.B,distance:+Math.hypot(f.A.x-f.B.x,f.A.y-f.B.y).toFixed(3),recentEvents:(result.events||[]).filter(e=>e.t<=t&&e.t>=t-2).slice(-18)};}
function decisionInput(obs,result,options,cfg){
 const compact=f=>({id:f?.id,name:String(f?.name||'').slice(0,200),tier:f?.tier,weapon:f?.weapon,mobility:f?.mobility,spells:f?.spells});
 const input={state:obs,characters:{A:compact(result.A),B:compact(result.B)},techniques:(options.techniques||[]).slice(0,200).map(v=>({key:String(v.key||'').slice(0,80),name:String(v.name||v.zh||'').slice(0,80),family:String(v.family||'').slice(0,80),tiers:v.tiers,requiresAir:!!v.requiresAir,action:v.action})),brief:String(options.brief||cfg.scene||'').slice(0,4000)};
 // Shorten values before serialization. Cutting the serialized JSON could split a
 // command key or closing brace, making a valid state unreadable by the model.
 let text=JSON.stringify(input);
 if(text.length>16000){input.brief=input.brief.slice(0,1000);input.state={...obs,recentEvents:obs.recentEvents.slice(-8)};text=JSON.stringify(input);}
 while(text.length>16000&&input.techniques.length){input.techniques.pop();text=JSON.stringify(input);}
 if(text.length>16000)throw Error('AI 状态超出输入预算，请精简角色法术配置');
 return text;
}
function interrupted(signal){if(signal?.aborted)throw Error('AI 战斗预演已停止');}
function cancellable(task,signal){
 interrupted(signal);if(!signal)return task();
 return new Promise((resolve,reject)=>{const abort=()=>{cleanup();reject(Error('AI 战斗预演已停止'));},cleanup=()=>signal.removeEventListener('abort',abort);signal.addEventListener('abort',abort,{once:true});Promise.resolve().then(()=>{interrupted(signal);return task();}).then(v=>{cleanup();if(signal.aborted)reject(Error('AI 战斗预演已停止'));else resolve(v);},e=>{cleanup();reject(e);});});
}
async function run(cfg,deps,options={}){
 if(!deps?.simulate||!deps?.decide)throw Error('AI 预演缺少模型或内核接口');
 interrupted(options.signal);
 const duration=Math.max(1,Math.min(120,+cfg.duration||12)),interval=Math.max(.5,Math.min(3,+options.interval||1.5)),maxCalls=Math.floor(Math.max(1,Math.min(96,+options.maxCalls||Math.ceil(duration/interval))));
 const commands=[],ledger=[];const simulate=()=>cancellable(()=>deps.simulate({...cfg,duration,record:true,rehearsal:false,choreography:commands.slice()}),options.signal);
 let result=await simulate(),ended=false;
 for(let t=0,calls=0;t<duration-.04&&calls<maxCalls;t+=interval,calls++){
  interrupted(options.signal);const obs=observe(result,t);
  if(obs.A.hp<=0||obs.B.hp<=0){ended=true;break;}
  deps.progress?.({t,calls,observation:obs});
  const response=parse(await cancellable(()=>deps.decide({system:SYSTEM,user:decisionInput(obs,result,options,cfg),signal:options.signal}),options.signal));
  interrupted(options.signal);const issued=[];
  for(const who of ['A','B']){const a=response[who],command={t:+(t+.02).toFixed(3),who,kind:a.action,hold:Math.min(interval,3),dir:a.dir===-1?-1:1,variant:typeof a.variant==='string'?a.variant.slice(0,80):''};commands.push(command);issued.push({...command,reason:String(a.reason||'').slice(0,500)});}
  result=await simulate();ledger.push({t,observation:obs,issued,execution:result.events.filter(e=>e.t>=t&&e.t<t+interval&&['command_start','command_rejected'].includes(e.type))});
 }
 const coverage=Math.min(duration,ledger.length*interval);
 return {result,commands,ledger,coverage,duration,ended,limited:!ended&&coverage<duration};
}
return {ACTIONS,SYSTEM,parse,observe,decisionInput,run};});
