/* ============================================================================
 * templates/corpus.js — 把语料索引条目接进模板库
 * ----------------------------------------------------------------------------
 * 语料条目（kind:"corpus"）与本地推导条目（kind:"derived"）的区别：
 *   · corpus：**只提供出处与结构化要点**（作者、链接、时长、题材/结构判定、
 *             原文的分段/镜头/声音字段情况、出现的兵器词），**不含提示词原文**；
 *             一键出稿时用"同题材同结构"的本地模板生成正文，避免复刻他人原文。
 *   · derived：完整的可填槽骨架（题材 × 结构 × 强度）。
 * ========================================================================== */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("./corpus-data.js"));
  else root.TPL_CORPUS = factory(root.TPL_CORPUS_DATA);
})(typeof globalThis !== "undefined" ? globalThis : this, function (DATA) {
  "use strict";
  const VERSION = "corpus-0.1";
  const META = DATA.META, ROWS = DATA.ROWS;

  const secsOf = (d) => { const m = /(\d+(?:\.\d+)?)\s*s/i.exec(String(d || "")); return m ? Math.round(+m[1]) : 15; };

  function toTemplate(r) {
    const secs = secsOf(r.duration);
    const title = r.titleZh || r.titleEn || (r.slugLabel ? (r.slugLabel + "（标题为站点自动摘取，未收录）") : r.slug);
    const facts = [
      "原文时长 " + (r.duration || secs + "s") + "｜模式 " + (r.mode || "未知") + "｜画幅 " + (r.aspectRatio || "未知"),
      "原文长度 " + r.promptLength + " 字" + (r.hasPartBlocks ? "｜**按 PART 分段**的长时间动作序列" : "") + (r.hasShotMarkers ? "｜含 [Shot N] 镜头标记" : "｜未用镜头标记") + (r.hasSoundField ? "｜含声音字段" : "｜未写独立声音字段"),
      "原文出现的兵器/手段关键词：" + (r.weapons.length ? r.weapons.join("、") : "未识别"),
      "题材/结构判定：" + r.genre + " / " + r.structure + (r.structureGuessed ? "（结构证据不足，按默认双人攻防归类，仅供参考）" : "")
    ].join("\n");
    const skeletonZh = [
      "【本条目是**参考索引**，不是可填槽模板】",
      "【标题】" + title,
      "【作者/出处】" + (r.author || "未知") + "　" + (r.sourceUrl || "（无链接）"),
      "【结构化要点】",
      facts,
      "【怎么用】把上面这些" + "结构性事实" + "当参考（时长档、是否分段、有没有镜头与声音字段、用了哪些兵器词），正文请用本库 **同题材同结构** 的模板骨架来写，**不要复刻原作者的原文**。",
      "【许可】" + META.docLicense + "；" + META.thirdPartyNote
    ].join("\n");
    return {
      id: "corpus-" + r.slug,
      kind: "corpus",
      nameZh: title,
      nameEn: r.titleEn || r.slugLabel || title,
      genre: r.genre, genreZh: null, genreEn: null,
      structure: r.structure, structureZh: null, structureEn: null,
      strength: "mid", strengthZh: "（原文字段未标注）",
      speed: "std", speedZh: "（原文未标注）",
      duration: secs,
      scene: { place: "（见出处原文）", time: "", weather: "" },
      axis: "（见出处原文）",
      advantage: "（见出处原文）",
      resources: r.weapons.slice(0, 3),
      media: [],
      beats: [],
      camera: [],
      sound: { amb: "", act: "", human: "" },
      negatives: ["复刻他人原文", "把参考条目当模板直接填空", "忽略出处与署名"],
      redline: { firstMove: null, pureRecovery: null, actionCloseup: [null, null], slowmo: "", clashes: "" },
      core: "公开成片提示词的参考条目（只给结构与出处，不给原文）",
      need: "用它对齐时长档与结构套路，正文仍用本库模板生成",
      provenance: "corpus:" + r.slug,
      sourceNote: "BeatAPI Prompt Gallery 收录的公开成片提示词（作者：" + (r.author || "未知") + "）",
      license: META.docLicense + "；第三方提示词未再许可，程序内不含原文",
      source: { repo: META.sourceRepo, url: r.sourceUrl, author: r.author, kind: r.sourceKind, category: r.category, titleFromSlug: !!r.titleFromSlug },
      facts: {
        promptLength: r.promptLength, hasPartBlocks: r.hasPartBlocks, hasShotMarkers: r.hasShotMarkers,
        hasSoundField: r.hasSoundField, weapons: r.weapons, keywords: r.keywords, fightScore: r.fightScore,
        structureGuessed: !!r.structureGuessed
      },
      skeletonZh: skeletonZh,
      skeletonEn: "",
      hasFullTemplate: false
    };
  }

  const CORPUS_TEMPLATES = ROWS.map(toTemplate);

  // 给语料条目找"同题材同结构"的本地模板（没有就退化到同结构或同题材）
  function nearestDerived(row, derived) {
    const same = derived.filter(t => t.genre === row.genre && t.structure === row.structure);
    if (same.length) return { tpl: same[0], exact: true };
    const byStruct = derived.filter(t => t.structure === row.structure);
    if (byStruct.length) return { tpl: byStruct[0], exact: false };
    const byGenre = derived.filter(t => t.genre === row.genre);
    if (byGenre.length) return { tpl: byGenre[0], exact: false };
    return { tpl: derived[0], exact: false };
  }

  return { VERSION, META, ROWS, CORPUS_TEMPLATES, nearestDerived, toTemplate, secsOf };
});
