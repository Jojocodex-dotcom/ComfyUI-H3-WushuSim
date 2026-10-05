(function(r,f){if(typeof module==='object'&&module.exports)module.exports=f();else r.H3_TERRAIN=f();})(globalThis,function(){'use strict';
const presets={bamboo:{zh:'竹林坡地',base:'field'},rooftop:{zh:'屋顶街巷',base:'field'},mountain:{zh:'山顶岩台',base:'field'},clouds:{zh:'云层之上',base:'aerial'},sea:{zh:'海上礁石',base:'water'}};
function height(key,x,y,arena){const w=arena.w,h=arena.h,u=x/w,v=y/h;
if(key==='bamboo')return 0.8+0.55*Math.sin(u*Math.PI*2)+0.35*Math.sin(v*Math.PI*3);
if(key==='mountain')return 0.5+3.8*Math.exp(-((u-.5)**2+(v-.5)**2)*8)+0.25*Math.sin(u*12)*Math.sin(v*10);
if(key==='rooftop'){const cross=Math.abs(v-.5)*h;return cross<=h*.3?3+Math.max(0,1.2-cross*.12):0;}
if(key==='sea')return Math.max(0,1.3*Math.exp(-((u-.35)**2+(v-.5)**2)*110)+1.1*Math.exp(-((u-.65)**2+(v-.5)**2)*110)-.15);
return 0;}
function move(f,key,arena,previous){const next=height(key,f.x,f.y,arena),old=f.groundZ||0,delta=next-old;
// Grounded footsteps follow continuous slopes; tall edges require an actual jump.
if(delta>.38&&f.z<delta){f.x=previous.x;f.y=previous.y;f.vx*=.2;f.vy*=.2;return;}
if(f.z>.05||delta<-.38)f.z=Math.max(0,f.z-delta);
f.groundZ=next;}
return {presets,height,move};});
