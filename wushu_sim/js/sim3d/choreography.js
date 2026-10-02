(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.H3_CHOREOGRAPHY=api;})(globalThis,function(){
'use strict';
const KINDS=['roll','leap','flight','land','launch','down','attack','approach','retreat','flank','block','dodge','recover'];
function validate(list,duration=120){if(!Array.isArray(list)||list.length>200)throw Error('动作编排须为不超过200项的数组');return list.map(c=>{if(!c||!['A','B'].includes(c.who)||!KINDS.includes(c.kind)||!Number.isFinite(c.t)||c.t<0||c.t>=duration)throw Error('动作时间、角色或类型无效');const out={t:c.t,who:c.who,kind:c.kind,dir:c.dir===-1?-1:1};if(c.hold!=null){if(!Number.isFinite(c.hold)||c.hold<.05||c.hold>3)throw Error('动作控制时长无效');out.hold=c.hold;}if(c.variant)out.variant=String(c.variant).slice(0,80);return out;}).sort((a,b)=>a.t-b.t);}
return {KINDS,validate};
});
