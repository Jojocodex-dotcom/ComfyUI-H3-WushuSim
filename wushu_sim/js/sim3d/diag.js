/* 诊断：1) 全进攻对局是否出现对拼 2) 哪些配置会拖到 30 秒不 KO */
const E = require("./engine.js");

console.log("=== 全进攻（嗜血 vs 嗜血，都用刀）===");
for (const s of [1, 2, 3]) {
  const r = E.simulate({ seed: s, record: false, duration: 30,
    A: { tier: 5, style: "berserk", weapon: "dao" }, B: { tier: 5, style: "berserk", weapon: "dao" } });
  const kinds = {};
  r.events.forEach(e => kinds[e.type] = (kinds[e.type] || 0) + 1);
  console.log(`seed=${s} 时长=${r.duration}s 胜者=${r.winner} 事件=${JSON.stringify(kinds)}`);
}

console.log("\n=== 找拖到时间到的配置 ===");
const styles = Object.keys(E.STYLES);
const wpns = ["bang", "jian", "nodachi", "none", "qiang", "dao", "duangun", "pu", "duanren"];
let slow = [];
for (let s = 0; s < 48; s++) {
  const A = { tier: 3 + (s % 5), style: styles[s % styles.length], weapon: wpns[s % wpns.length] };
  const B = { tier: 3 + ((s * 3) % 6), style: styles[(s * 5) % styles.length], weapon: wpns[(s + 4) % wpns.length] };
  const r = E.simulate({ seed: 1000 + s, record: false, duration: 30, A, B });
  if (!r.summary.finish) slow.push({ s, A, B, dur: r.duration, hpA: r.A.hp + "/" + r.A.hpMax, hpB: r.B.hp + "/" + r.B.hpMax, hits: r.summary.hits, blocks: r.summary.blocks });
}
console.log(`未 KO 的场次：${slow.length}/48`);
slow.slice(0, 12).forEach(x => console.log(`  #${x.s} ${x.A.style}(${x.A.weapon},t${x.A.tier}) vs ${x.B.style}(${x.B.weapon},t${x.B.tier}) 血=${x.hpA} / ${x.hpB} 命中=${x.hits} 格挡=${x.blocks}`));
