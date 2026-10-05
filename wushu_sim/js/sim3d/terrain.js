(function(r,f){if(typeof module==='object'&&module.exports)module.exports=f();else r.H3_TERRAIN=f();})(globalThis,function(){'use strict';
const presets={bamboo:{zh:'竹林坡地',base:'field'},rooftop:{zh:'屋顶街巷',base:'field'},mountain:{zh:'山顶岩台',base:'field'},clouds:{zh:'云层之上',base:'aerial'},sea:{zh:'海上礁石',base:'water'}};
// 每个场景一组固定的"山包/礁石"参数（u,v∈[0,1] 归一化坐标，h 米，r 高斯半径）。
// 写死而不是随机：同一场景每次进预演都是同一片山地，回放与走位可复现。
const PEAKS={
 mountain:[ // 山顶岩台：三座主峰 + 两座次峰 + 一条碎石小包链（主峰 3~3.6m，谷地 ~0.3m）
  {u:.32,v:.38,h:3.6,r:.16},{u:.68,v:.30,h:2.7,r:.14},{u:.55,v:.72,h:3.2,r:.18},
  {u:.18,v:.70,h:1.8,r:.12},{u:.85,v:.62,h:1.5,r:.10},{u:.44,v:.12,h:1.4,r:.10}],
 bamboo:[   // 竹林坡地：一条对角山脊 + 起伏缓丘（0~1.8m）
  {u:.25,v:.75,h:1.7,r:.26},{u:.62,v:.45,h:1.3,r:.22},{u:.85,v:.20,h:1.0,r:.18},{u:.10,v:.25,h:.8,r:.16}],
 sea:[      // 海上礁石：七组礁石群，其余是海面（礁石 1.1~2.4m，海面 ≈0）
  {u:.28,v:.40,h:2.1,r:.09},{u:.66,v:.30,h:1.6,r:.08},{u:.50,v:.66,h:2.4,r:.10},
  {u:.16,v:.72,h:1.2,r:.07},{u:.82,v:.70,h:1.8,r:.08},{u:.40,v:.14,h:1.4,r:.07},{u:.74,v:.12,h:1.1,r:.06}]
};
function gauss(u,v,u0,v0,r){const du=(u-u0)/r,dv=(v-v0)/r;return Math.exp(-(du*du+dv*dv)/2);}
function height(key,x,y,arena){const w=arena.w||12,h=arena.h||10,u=x/w,v=y/h;
 if(key==='mountain'){let z=.3;for(const b of PEAKS.mountain)z+=b.h*gauss(u,v,b.u,b.v,b.r);return z+.15*Math.sin(u*9.7+1.1)*Math.sin(v*8.3);}
 if(key==='bamboo'){let z=.15;for(const b of PEAKS.bamboo)z+=b.h*gauss(u,v,b.u,b.v,b.r);return Math.max(0,z+.22*Math.sin(u*6.3)*Math.sin(v*5.1+.7));}
 if(key==='sea'){let z=-.12;for(const b of PEAKS.sea)z+=b.h*gauss(u,v,b.u,b.v,b.r);z+=.06*Math.sin(u*14+v*11);return Math.max(-.15,z);}
 if(key==='rooftop'){ // 屋顶街巷：4×4 街区，楼顶高低错落（2.2~4.4m），街区之间是街道（0.25m）
   const cx=Math.min(3,Math.max(0,Math.floor(u*4))),cy=Math.min(3,Math.max(0,Math.floor(v*4)));
   const fx=u*4-cx-.5,fy=v*4-cy-.5,edge=Math.min(.5-Math.abs(fx),.5-Math.abs(fy));
   if(edge<.10)return .25;                                  // 街道
   const hh=2.2+((cx*7+cy*13)%5)*.55;                       // 每个街区固定楼高
   return .25+(hh-.25)*Math.min(1,(edge-.10)/.02);          // 沿口一小段坡肩，顶面平
 }
 return 0;}
function move(f,key,arena,previous){const next=height(key,f.x,f.y,arena),old=f.groundZ||0,delta=next-old;
// Grounded footsteps follow continuous slopes; tall edges require an actual jump.
if(delta>.38&&f.z<delta){f.x=previous.x;f.y=previous.y;f.vx*=.2;f.vy*=.2;return;}
if(f.z>.05||delta<-.38)f.z=Math.max(0,f.z-delta);
f.groundZ=next;}
return {presets,height,move};});
