/* Deterministic action clocks. Physical flight and grounded recovery are separate. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.H3_ACTIONS=api;})(globalThis,function(){
'use strict';
const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
const catalog={roll:{startup:.08,active:.28,recovery:.24,cost:20},down:{fall:.38,hold:1.1,rise:.6},landing:{recovery:.22},airRecover:{delay:.35}};
function emit(sim,f,type,data={}){sim.events.push({t:+sim.t.toFixed(3),type,who:f.id,x:+f.x.toFixed(3),y:+f.y.toFixed(3),z:+f.z.toFixed(3),...data});}
function beginRoll(sim,f,opts={}){
 if(f.hp<=0||f.rules?.noDodge||f.z>.12||f.motion?.kind==='down')return false;
 const duration=opts.duration||.6;
 f.motion={kind:'roll',start:sim.t,duration,phase:'startup',direction:Math.atan2(f.vy,f.vx)};
 f.state='dodge';f.post='crouch';f.roll=duration;f.hitstun=0;
 // Protection begins when the shoulder meets the ground, not at intent selection.
 f.iframes=0;
 emit(sim,f,'roll_start',{duration,direction:f.motion.direction,escape:!!opts.escape});return true;
}
function beginDown(sim,f,hold){
 if(f.motion?.kind==='down')return;
 f.motion={kind:'down',start:sim.t,fall:catalog.down.fall,hold:Math.max(.6,(hold||1.6)-catalog.down.rise),rise:catalog.down.rise,phase:'fall'};
 f.state='down';f.post='stand';f.rising=false;f.fallT=0;
 f.hitstun=f.motion.fall+f.motion.hold+f.motion.rise;
 f.pendingDown=false;
}
function tick(sim,f,dt){
 const m=f.motion;if(!m)return;
 if(m.kind==='roll'){
  if(f.hp<=0||f.state==='down'||f.state==='hitstun'||f.state==='stagger'){emit(sim,f,'roll_end',{interrupted:true});f.motion=null;return;}
  const elapsed=sim.t-m.start,p=clamp(elapsed/m.duration,0,1);
  const phase=elapsed<.08?'startup':elapsed<.36?'active':'recovery';
  if(m.phase!==phase){m.phase=phase;emit(sim,f,'roll_phase',{phase});}
  f.roll=m.duration-elapsed;f.state='dodge';f.post='crouch';
  f.iframes=phase==='active'?Math.max(f.iframes||0,dt*1.1):0;
  if(p>=1){f.motion=null;f.roll=0;f.state='idle';f.post='stand';f.counterUntil=sim.t+.35;emit(sim,f,'roll_end',{interrupted:false});}
 }else if(m.kind==='down'){
  f.state='down';const elapsed=sim.t-m.start;
  f.fallT=Math.min(elapsed,m.fall);f.hitstun=Math.max(0,m.fall+m.hold+m.rise-elapsed);
  const phase=elapsed<m.fall?'fall':elapsed<m.fall+m.hold?'grounded':'rise';
  if(phase!==m.phase){m.phase=phase;emit(sim,f,phase==='rise'?'getup':'down_settled',{phase,riseT:m.rise,downT:m.hold});}
  f.rising=phase==='rise'&&f.hp>0;f.riseT=m.rise;
  if(f.hp>0&&elapsed>=m.fall+m.hold+m.rise){f.state='idle';f.post='stand';f.rising=false;f.hitstun=0;f.motion=null;f.iframes=Math.max(f.iframes||0,.25);f.stats.getups=(f.stats.getups||0)+1;emit(sim,f,'getup_end');}
 }
}
function snapshot(f,t){if(f.state==='cast')return {action:'cast',actionPhase:'charge',actionP:+clamp((f.castT||0)/(f.castDur||1),0,1).toFixed(4),rollP:0};if(f.state==='recover')return {action:'cast',actionPhase:'recovery',actionP:+clamp(1-((f.recoverUntil||t)-t)/(f.castRecovery||.35),0,1).toFixed(4),rollP:0};const m=f.motion;if(!m)return {action:f.z>.05?(f.launched?'launched':'flight'):'',actionPhase:f.z>.05?(f.vz>.4?'ascend':f.vz<-.4?'descend':'hover'):'',actionP:0,rollP:0};return {action:m.kind,actionPhase:m.phase,actionP:+clamp((t-m.start)/(m.duration||m.fall+m.hold+m.rise),0,1).toFixed(4),rollP:m.kind==='roll'?+clamp((t-m.start)/m.duration,0,1).toFixed(4):0,rollDir:m.direction||0};}
function locked(f){return !!f.motion||!!f.pendingDown||(f.launched&&f.hitstun>0);}
return {catalog,beginRoll,beginDown,tick,snapshot,locked};
});
