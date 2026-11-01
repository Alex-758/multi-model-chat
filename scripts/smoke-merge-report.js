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

// 13. 分句保护：小数/版本号不被 ASCII 句点拦腰斩断（实测回归："Node.js 18"/"1.5 倍"）
const node = [
  { modelId: 'a', name: 'A', content: 'Node.js 18 已发布，启动速度提升 30%。内存占用是上一版的 1.5 倍。' },
  { modelId: 'b', name: 'B', content: 'Node.js 18 已发布，启动速度提升 40%。内存占用是上一版的 2 倍。' }
];
const an3 = M.analyze(node);
check('版本号句完整参与对比', an3.conflicts.some(c => c.texts[0].indexOf('Node.js 18') === 0), JSON.stringify(an3.conflicts));
check('小数不再斩断（1.5 倍冲突被检出）', an3.conflicts.some(c => c.texts[0].indexOf('1.5 倍') >= 0), JSON.stringify(an3.conflicts));
check('斩断残留不再出现', an3.conflicts.every(c => c.texts.every(t => t.indexOf('js 18') !== 0 && t.indexOf('倍。') !== 0)));

// 14. 预分析/来源池不受 14 条上限截断（长列表回答的第 15+ 条要点此前会被静默丢弃）
const bullets = Array.from({ length: 20 }, (_, i) => '\n- 普通要点' + i + '的内容足够长可以被保留下来。');
bullets[17] = '\n- 独家关键结论XYQ只有这里提到的内容足够长可以被保留下来。';
const bulletContent = bullets.join('');
const an4 = M.analyze([{ modelId: 'a', name: 'A', content: bulletContent }, { modelId: 'b', name: 'B', content: bulletContent }]);
check('第18条共识仍被预分析捕获', an4.consensus.some(c => c.text.indexOf('XYQ') >= 0));
check('来源池含第18条', M.buildPool([{ modelId: 'a', name: 'A', content: bulletContent }]).some(p => p.text.indexOf('XYQ') >= 0));

// 15. IDF 加权：只有功能词相近的句子不再误聚成共识，真共识不受影响
const fn = [
  { modelId: 'a', name: 'A', content: '我们可以进行各种功能的测试和验证工作。' },
  { modelId: 'b', name: 'B', content: '我们可以进行项目的日常管理和维护工作。' }
];
check('仅功能词相近不成共识', M.analyze(fn).consensus.length === 0);
check('真共识不受IDF影响', an.consensus.some(c => c.text.indexOf('量子计算使用量子比特') >= 0 && c.models.length === 2));

// 16. 冲突降噪：数字之外的主体不相似的数字对不报
const noise = [
  { modelId: 'a', name: 'A', content: '这个项目的版本 4 已经发布。' },
  { modelId: 'b', name: 'B', content: '这个项目共有 5 个核心模块。' }
];
check('主体不相似的数字对不报冲突', M.analyze(noise).conflicts.length === 0);

// 17. 数值溯源：中文数量级换算（1.5万 == 15000），缺值标记、已知值放行
const srcNums = M.sourceNums([
  { modelId: 'a', name: 'A', content: '用户量达到 1.5 万。' },
  { modelId: 'b', name: 'B', content: '成本占比 30%。' }
]);
check('同值不同写法可溯源（1.5万==15000）', M.numsAudit('总用户量约 15000 人。', srcNums).length === 0);
check('来源没有的数值被标记', M.numsAudit('预计明年达到 99999 人。', srcNums).join(',').indexOf('99999') >= 0);
check('已知数值不标记', M.numsAudit('成本占比 30%。', srcNums).length === 0);

// 18. 共识覆盖检查：报告已覆盖的共识不算缺失，没提的被标记
const cov = M.uncoveredConsensus(an.consensus,
  '## 结论\n\n量子计算使用量子比特进行运算，商用时间尚无定论。\n\n## 分歧\n\n一种说法是 2048 年实现商用。另一种说法是 2030 年。');
check('报告覆盖的共识不算缺失', cov.length === 0, JSON.stringify(cov));
check('报告缺失的共识被标记', M.uncoveredConsensus(an.consensus, '这段报告讲的是完全无关的话题内容没有重叠之处。').length === an.consensus.length);

// 19. 聚类归并机制：低于入簇阈值的拆散同类，在归并阈值下并回
const twoPts = [
  { text: 'x', v: new Map([['甲', 1], ['乙', 1]]) },
  { text: 'y', v: new Map([['甲', 1], ['丙', 1]]) }
];
const merged = M.clusterPoints(twoPts, 0.9, 0.3); // 相似 0.5 < 0.9 不入同簇；均值 0.5 ≥ 0.3 → 归并
check('归并能把拆散的同类并回', merged.length === 1 && merged[0].members.length === 2, JSON.stringify(merged.map(c => c.members.length)));
check('低于归并阈值不并', M.clusterPoints(twoPts, 0.9, 0.6).length === 2);

// 20. 交叉审查提示词：剔除审查者自身回答，全局编号不重排（审查与仲裁间【回答 N】指向一致）
const three = [
  { modelId: 'a', name: 'A', content: '甲模型的独到结论AAA在这里详细展开说明。' },
  { modelId: 'b', name: 'B', content: '乙模型的独到结论BBB在这里详细展开说明。' },
  { modelId: 'c', name: 'C', content: '丙模型的独到结论CCC在这里详细展开说明。' }
];
const rp = M.reviewPrompt('这是什么问题？', three, 1, 30000);
check('审查提示词含固定小节', rp.indexOf('## 问题清单') >= 0 && rp.indexOf('## 遗漏补充') >= 0);
check('审查者自己的回答被剔除', rp.indexOf('BBB') < 0);
check('其余回答保留', rp.indexOf('AAA') >= 0 && rp.indexOf('CCC') >= 0);
check('全局编号不被重排', rp.indexOf('【回答 1】') >= 0 && rp.indexOf('【回答 3】') >= 0 && rp.indexOf('【回答 2】') < 0);

// 21. 仲裁提示词：回答块在前（发现引用其编号）、发现带【审查 N】编号、预算受控
const vp = M.verdictPrompt('这是什么问题？', three,
  [{ content: '审查一发现：甲把年份写错了。' }, { content: '审查二发现：乙遗漏了成本条件。' }], 30000);
check('仲裁提示词含固定小节', ['## 最终结论', '## 审查发现裁定', '## 确认的错误清单', '## 仍存不确定性']
  .every(h => vp.indexOf(h) >= 0));
check('审查发现带编号进提示词', vp.indexOf('【审查 1】') >= 0 && vp.indexOf('【审查 2】') >= 0);
check('回答块在发现块之前', vp.indexOf('【回答 1】') < vp.indexOf('【审查 1】'));
check('仲裁提示词尊重预算', M.tokensOf(vp) <= 30500, 'actual=' + M.tokensOf(vp));

// 22. 预算与单份上限：超预算按句截断；单份回答超过省token上限也截断
const longR = { modelId: 'z', name: 'Z', content: Array.from({ length: 120 }, (_, i) => '这是第' + i + '句用来验证交叉审查预算截断的内容呀。').join('') };
check('审查回答超预算被截断', M.reviewPrompt('q?', [longR, { modelId: 'w', name: 'W', content: '短回答内容。' }], 1, 1500).indexOf('已按句子截断') >= 0);
check('单份回答超上限被截断', M.reviewPrompt('q?', [longR, { modelId: 'w', name: 'W', content: '短回答内容。' }], 1, 30000).indexOf('已按句子截断') >= 0);

console.log('\n== merge 报告单元：' + pass + '/' + (pass + fail) + ' 通过 ==');
process.exit(fail ? 1 : 0);
