/* Shared, pure input/result contract. Browser and Node use the same rules. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.H3_CONTRACT=api;})(globalThis,function(){
 'use strict';
 function number(v,name,min,max){if(typeof v!=='number'||!Number.isFinite(v)||v<min||v>max)throw new RangeError(name+' 必须在 '+min+'～'+max+' 之间');return v;}
 function validate(o){
  if(!o||typeof o!=='object'||Array.isArray(o))throw new TypeError('战斗配置必须是对象');
  if(o.duration!=null)number(o.duration,'时长',1/60,120);
  if(o.seed!=null)number(o.seed,'随机种子',0,4294967295);
  const a=o.arena||{w:20,h:12};number(a.w,'场地宽度',2,10000);number(a.h,'场地纵深',2,10000);
  if(a.z!=null)number(a.z,'场地高度',0,10000);
  if(o.speed!=null)number(o.speed,'战斗速度',0.1,4);
  for(const side of ['A','B']){const f=o[side]||{};
   if(f.tier!=null)number(f.tier,side+' 武力等级',1,9);
   if(f.hp!=null)number(f.hp,side+' 血量',0.01,1000000);
   for(const k of ['x','y','face'])if(f[k]!=null)number(f[k],side+' '+k,-1000000,1000000);
  }
  return o;
 }
 function winner(A,B,over){if(over)return over;const a=A.hp/Math.max(1,A.hpMax),b=B.hp/Math.max(1,B.hpMax);return a>b+0.02?'A':b>a+0.02?'B':'draw';}
 function eventCounts(events){const counts=Object.create(null);for(const e of events)counts[e.type]=(counts[e.type]||0)+1;return counts;}
 return {validate,winner,eventCounts};
});
