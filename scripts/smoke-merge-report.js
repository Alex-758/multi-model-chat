'use strict';
// 单元测试：模型综合的结构化报告支持层（merge.js，纯 node 直跑，无需 Electron）
// 覆盖：三分类（共识/独有）、数值冲突检测、提示词（固定小节/预分析/无引号要求/多轮上下文）、
//       token 口径的预算分配与句界截断、来源匹配（matchSources / buildPool / blockModels）
const path = require('path');
const M = require(path.join(__dirname, '..', 'src', 'renderer', 'js', 'merge.js'));

let pass = 0, fail = 0;
function check(label, ok, detail) {
  if (ok) { pass++; console.log('  PASS ' + label); }
  else { fail++; console.log('  FAIL ' + label + (detail ? ' -> ' + detail : '')); }
}

const rs = [
  { modelId: 'a::x', name: '模型A', content: '量子计算使用量子比特进行运算。它可以在 2048 年实现商用。量子纠错的成本目前高达 30%。此外量子纠缠是核心物理资源。' },
  { modelId: 'b::y', name: '模型B', content: '量子计算使用量子比特进行运算。它可以在 2030 年实现商用。量子纠错的成本目前高达 50%。' }
];

// 1. 三分类
const an = M.analyze(rs);
check('共识点识别（两家共同的句子）', an.consensus.length >= 1 &&
  an.consensus.some(c => c.text.indexOf('量子计算使用量子比特') >= 0 && c.models.length === 2),
  JSON.stringify(an.consensus.map(c => c.text.slice(0, 12))));
check('独有点不丢失', an.unique.length >= 1, JSON.stringify(an.unique.map(c => c.text.slice(0, 12))));
check('共识按支持数排序', an.consensus.every((c, i) => i === 0 || an.consensus[i - 1].models.length >= c.models.length));

// 2. 数值冲突（2048 vs 2030、30% vs 50%）
check('数值冲突候选被检出', an.conflicts.length >= 2,
  JSON.stringify(an.conflicts.map(c => c.texts.map(t => t.slice(0, 14)))));
check('冲突对来自不同模型', an.conflicts.every(c => c.texts.length === 2));

// 3. 提示词
const p = M.synthesisPrompt('量子计算何时商用？', rs, 48000);
check('固定小节标题齐全', ['## 结论', '## 共同点', '## 分歧', '## 关键证据', '## 待验证问题']
  .every(h => p.indexOf(h) >= 0));
check('自适应省略指令存在', p.indexOf('没有实质内容时整节省略') >= 0);
check('无引号引用要求存在', p.indexOf('不要加引号') >= 0 && p.indexOf('不要提及任何模型名称') >= 0);
check('分歧禁揉合指令存在', p.indexOf('禁止把不同说法揉成一句话') >= 0);
check('预分析共识清单进提示词', p.indexOf('【本地预分析 · 多模型一致的要点') >= 0 &&
  p.indexOf('量子计算使用量子比特') >= 0);
check('预分析冲突清单进提示词', p.indexOf('疑似数据分歧') >= 0 && p.indexOf('2048') >= 0 && p.indexOf('2030') >= 0);
check('原始问题进提示词', p.indexOf('【原始问题】') >= 0 && p.indexOf('量子计算何时商用？') >= 0);

// 4. 句界截断：超预算时不得拦腰砍断
const long = { modelId: 'c::z', name: '模型C', content: Array.from({ length: 200 }, (_, i) => '这是第' + i + '句测试内容，用来验证句子边界截断是否生效呀。').join('') };
const p2 = M.synthesisPrompt('q', [long], 2000);
check('超预算触发截断', p2.indexOf('已按句子截断') >= 0);
const cutPart = p2.slice(p2.indexOf('【回答 1】'), p2.indexOf('已按句子截断'));
check('截断点保留完整句子', cutPart.indexOf('生效呀。') >= 0, cutPart.slice(-40));

// 5. 预算分配：未超预算全量保留
const p3 = M.synthesisPrompt('q', rs, 48000);
check('未超预算不截断', p3.indexOf('已按句子截断') < 0 && p3.indexOf('50%') >= 0 && p3.indexOf('量子纠缠') >= 0);

// 6. 来源匹配
const report = '## 结论\n\n量子计算使用量子比特进行运算，商用时间尚无定论。\n\n## 分歧\n\n一种说法是 2048 年实现商用。另一种说法是 2030 年。';
const ms = M.matchSources(report, rs);
check('报告块匹配到模型', ms.length >= 2, JSON.stringify(ms.map(s => s.text.slice(0, 12))));
check('共同点块来自两家', ms.some(s => s.text.indexOf('量子比特') >= 0 && s.models.length === 2));
check('分歧块能对上原句', ms.some(s => s.text.indexOf('2048') >= 0));

// 7. buildPool / blockModels
const pool = M.buildPool(rs);
check('要点池含整段与句子', pool.length >= 4);
const bm = M.blockModels('它可以在 2048 年实现商用。', pool);
check('单句匹配到模型A', bm.length >= 1 && bm[0].name === '模型A', JSON.stringify(bm));
check('无关文本不匹配', M.blockModels('今天天气不错适合出去走走看看风景放松心情。', pool).length === 0);

// 8. 边界：空输入
check('空结果不抛错', M.analyze([]).consensus.length === 0 && M.matchSources('', []).length === 0);

// 9. token 粗估（预算口径的基础：CJK≈1/字，其余≈4字符/token）
check('tokensOf 中文按字计', M.tokensOf('四字测试') === 4);
check('tokensOf 英文按4字符计', M.tokensOf('abcdefgh') === 2);
check('tokensOf 混合文本', M.tokensOf('中文abc') === 3, String(M.tokensOf('中文abc')));

// 10. 多轮上下文进提示词
const hist = { question: '上一轮问了哪些优化点？', synthesis: '上一轮的综合结论内容，用于理解追问背景。' };
const ph = M.synthesisPrompt('那第二个方案呢？', rs, 48000, hist);
check('上下文节进提示词', ph.indexOf('【对话上下文') >= 0 && ph.indexOf('上一轮问了哪些优化点') >= 0);
check('上下文标注不参与综合', ph.indexOf('不要综合其内容') >= 0);
check('无上下文不出该节', M.synthesisPrompt('q', rs, 48000).indexOf('【对话上下文') < 0);
check('上下文过长被节选', M.synthesisPrompt('q', rs, 48000,
  { question: 'q', synthesis: Array.from({ length: 2000 }, () => '长').join('') }).indexOf('…\n') >= 0);

// 11. 预算按 token 口径：英文长文不再被按字符过度截断
//（约 19200 字符 ≈ 4800 token，预算 8000 token 应全量保留；旧字符口径会在 8000 字符处砍断）
const en = { modelId: 'e::1', name: 'EN', content: Array.from({ length: 300 }, (_, i) => 'This is sentence number ' + i + ' of the English test answer content. ').join('') };
const pe = M.synthesisPrompt('q', [en], 8000);
check('英文按 token 口径不截断', pe.indexOf('已按句子截断') < 0 && pe.indexOf('sentence number 299') >= 0);

// 12. 提示词总量尊重 token 预算：脚手架+回答块合计不超（防中文长回答顶爆上下文）
const pBudget = M.synthesisPrompt('q', [long], 3000);
check('提示词总量不超预算（含脚手架）', M.tokensOf(pBudget) <= 3200, 'actual=' + M.tokensOf(pBudget));

console.log('\n== merge 报告单元：' + pass + '/' + (pass + fail) + ' 通过 ==');
process.exit(fail ? 1 : 0);
