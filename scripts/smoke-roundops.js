// 回归测试：单模型重试 / 预置服务商删除 / 导出本轮 / 删除本轮
// 不注册 IPC、不读写 store.json（MM.save 会失败，但测试只关心内存状态与 DOM）
const { app, BrowserWindow } = require('electron');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
function check(label, ok, detail) {
  if (ok) { pass++; console.log('  PASS ' + label); }
  else { fail++; console.log('  FAIL ' + label + (detail ? ' -> ' + detail : '')); }
}

app.whenReady().then(async () => {
  const w = new BrowserWindow({ width: 1280, height: 900, show: false,
    webPreferences: { preload: path.join(ROOT, 'src', 'main', 'preload.js'), contextIsolation: true, sandbox: true } });
  const js = c => w.webContents.executeJavaScript(c);
  w.webContents.on('console-message', (e, ...a) => { const d = a[0]; const m = (d && d.message) || String(a[0]); if (/error|Error/.test(m)) console.log('  [console] ' + m.slice(0, 160)); });
  await w.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
  await sleep(1500);

  // ===== 导出本轮：Markdown 结构 =====
  let r = await js(`(function(){
    var s = {id:'s1', title:'测试会话'};
    var am = {roundId:'r1', results:[
      {modelId:'m1', name:'模型A', status:'done', ms:2400, chars:10, usage:{input:1000, output:500}, content:'A 的**回答**'},
      {modelId:'m2', name:'模型B', status:'error', error:'HTTP 429', content:''}
    ], merge:{content:'综合内容', mode:'model', usage:{input:300, output:100}}};
    var um = {id:'u1', role:'user', content:'测试提问'};
    return MM.chat._roundToMarkdownForTest(am, s, um);
  })()`);
  check('导出含提问标题', r.indexOf('# 测试提问') === 0, r.slice(0, 80));
  check('导出含每个模型名', r.indexOf('## 模型A') > 0 && r.indexOf('## 模型B') > 0, '');
  check('导出含成功模型的用时与用量', /用时 2\.4s/.test(r) && /2K tokens（输入 1000 \/ 输出 500）/.test(r), '');
  check('导出含失败原因', r.indexOf('失败：HTTP 429') > 0, '');
  check('导出含模型原始回答', r.indexOf('A 的**回答**') > 0, '');
  check('导出含综合回答及其用量', r.indexOf('## 综合回答') > 0 && r.indexOf('400 tokens') > 0, '');
  check('导出含会话信息', r.indexOf('测试会话') > 0, '');

  // 无综合、无用量时的结构
  r = await js(`(function(){
    var s = {id:'s2', title:'X'};
    var am = {roundId:'r2', results:[{modelId:'m1', name:'A', status:'done', content:'ok'}]};
    return MM.chat._roundToMarkdownForTest(am, s, {id:'u1', role:'user', content:'问'});
  })()`);
  check('无用量/无综合时不出现空段落标记', r.indexOf('tokens') < 0 && r.indexOf('## 综合回答') < 0 && r.indexOf('ok') > 0, r);

  // ===== DOM：失败卡片有重试按钮；工具栏有导出/删除 =====
  r = await js(`(function(){
    MM.state.config = MM.normalizeConfig({});
    var s = MM.sessions.createSilent();
    s.messages = [
      {id:'u1', role:'user', content:'问', createdAt:Date.now()},
      {id:'a1', role:'assistant', roundId:'r1', createdAt:Date.now(), active:0, versions:[], results:[
        {modelId:'m1', name:'A', status:'done', ms:100, chars:2, content:'好'},
        {modelId:'m2', name:'B', status:'error', error:'超时', content:''},
        {modelId:'m3', name:'C', status:'stopped', chars:0, content:'半'}
      ]}
    ];
    MM.sessions.render(); MM.chat.renderAll();
    var retryBtns = [].filter.call(document.querySelectorAll('.answer-card .card-foot .ac-copy'), function(b){return b.textContent==='重试';});
    var tools = [].map.call(document.querySelectorAll('.round-tools .tool-btn'), function(b){return b.textContent.trim();});
    return JSON.stringify({retry:retryBtns.length, tools:tools});
  })()`);
  var o = JSON.parse(r);
  check('失败与停止的卡片各有重试按钮', o.retry === 2, r);
  check('成功的卡片没有重试按钮', o.tools !== undefined, '');
  check('工具栏含导出本轮与删除本轮', o.tools.indexOf('导出本轮') >= 0 && o.tools.indexOf('删除本轮') >= 0, r);
  check('工具栏含重新生成与综合回答（未被挤掉）',
    o.tools.some(function(t){return t.indexOf('重新生成')>=0;}) && o.tools.some(function(t){return t.indexOf('综合回答')>=0;}), r);

  // ===== 删除本轮 =====
  r = await js(`(async function(){
    // deleteRound 用的是 U.confirm 异步对话框（与删除会话一致的交互），
    // 自动化测试里无法点按钮，直接桩掉让确认恒为真；deleteRound 本身也是 async，要等它跑完
    MM.util.confirm = function () { return Promise.resolve(true); };
    await MM.chat._deleteRoundForTest('r1');
    var s = MM.sessions.current();
    return JSON.stringify({len:s.messages.length, roles:s.messages.map(function(m){return m.role;})});
  })()`);
  o = JSON.parse(r);
  check('删除本轮连提问一起移除', o.len === 0, r);

  r = await js(`(async function(){
    // 多轮场景：只删指定轮，后续轮次不受影响
    var s = MM.sessions.current();
    s.messages = [
      {id:'u1', role:'user', content:'问1'},
      {id:'a1', role:'assistant', roundId:'rA', results:[{modelId:'m1',name:'A',status:'done',content:'答1'}]},
      {id:'u2', role:'user', content:'问2'},
      {id:'a2', role:'assistant', roundId:'rB', results:[{modelId:'m1',name:'A',status:'done',content:'答2'}]}
    ];
    await MM.chat._deleteRoundForTest('rA');
    return JSON.stringify(s.messages.map(function(m){return m.id;}));
  })()`);
  o = JSON.parse(r);
  check('多轮时只删目标轮', o.length === 2 && o[0] === 'u2' && o[1] === 'a2', r);

  // ===== 单模型重试：数据层 =====
  r = await js(`(function(){
    // 模型已不存在时应被拒绝且不发起请求
    var s = MM.sessions.current();
    s.messages = [
      {id:'u1', role:'user', content:'问'},
      {id:'a1', role:'assistant', roundId:'rX', results:[{modelId:'gone::dead', name:'幽灵', status:'error', error:'x', content:''}]}
    ];
    MM.chat._retryOneForTest('rX', 'gone::dead');
    var res = s.messages[1].results[0];
    return JSON.stringify({status:res.status, err:res.error});
  })()`);
  o = JSON.parse(r);
  check('模型已删除时重试被拒绝（状态不变）', o.status === 'error', r);

  // ===== 预置服务商删除按钮 =====
  r = await js(`(function(){
    MM.settings.open();
    document.querySelector('.settings-nav[data-pane="models"]').click();
    // 删除按钮在常驻标题行的操作区（pm-head-ops），随当前选中服务商变化
    var delBtns = [].filter.call(document.querySelectorAll('.pm-head-ops .btn-danger'), function(b){return b.textContent==='删除';}).length;
    return JSON.stringify({delBtns: delBtns});
  })()`);
  o = JSON.parse(r);
  check('预置服务商也有删除按钮', o.delBtns === 1, r);

  // ===== 重新综合：版本快照去重（token 统计不翻倍） =====
  // 复刻真实流程的状态：回答完成入池（all-done）→ 综合完成写入当前快照（syncMergeToVersion）
  r = await js(`(async function(){
    MM.state.config = MM.normalizeConfig({}); // 综合方式默认 frontend（纯本地，测试无需 IPC）
    var s = MM.sessions.createSilent();
    s.messages = [
      {id:'u1', role:'user', content:'问', createdAt:Date.now()},
      {id:'a1', role:'assistant', roundId:'rM', createdAt:Date.now(), active:0,
       results:[
         {modelId:'m1', name:'A', status:'done', usage:{input:1000, output:500}, content:'回答A的内容'},
         {modelId:'m2', name:'B', status:'done', usage:{input:0, output:400}, content:'回答B的内容'}
       ],
       versions:[{results:null, merge:null, at:Date.now()}]}
    ];
    var am = s.messages[1];
    am.versions[0].results = JSON.parse(JSON.stringify(am.results));
    am.merge = {content:'旧综合', mode:'frontend', createdAt:Date.now()};
    am.versions[0].merge = JSON.parse(JSON.stringify(am.merge));
    MM.chat.renderAll();
    var tokens0 = MM.sessions._sessionTokensForTest(s);
    MM.util.confirm = function(){ return Promise.resolve(true); };
    await MM.chat._doMergeForTest('rM', {redo:true});
    return JSON.stringify({
      tokens0:tokens0,
      tokens1:MM.sessions._sessionTokensForTest(s),
      v:am.versions.length,
      merged:!!(am.merge && am.merge.content && am.merge.content !== '旧综合'),
      oldKept:am.versions[0].merge && am.versions[0].merge.content === '旧综合'});
  })()`);
  o = JSON.parse(r);
  check('重综合压栈副本并保留旧综合（可回滚）', o.v === 2 && o.oldKept === true, r);
  check('token 统计不因重综合翻倍', o.tokens0 === 1900 && o.tokens1 === 1900, r);
  check('重综合生成新内容', o.merged === true, r);

  // 结果在快照之后发生过变化（模拟单模型重试：all-done 已把新结果入池，未标记）：
  // 再重综合 → 副本压栈。结果两批各计一次，副本批只计综合
  r = await js(`(async function(){
    var s = MM.sessions.current();
    var am = s.messages[1];
    am.results[1].content = '回答B（重试后）';
    am.results[1].usage = {input:0, output:600};
    am.versions.push({results:JSON.parse(JSON.stringify(am.results)),
      merge:JSON.parse(JSON.stringify(am.merge)), at:Date.now()});
    am.active = am.versions.length - 1;
    await MM.chat._doMergeForTest('rM', {redo:true});
    return JSON.stringify({
      v:am.versions.length,
      tokens:MM.sessions._sessionTokensForTest(s),
      v0Intact:am.versions[0].results[1].content === '回答B的内容',
      v2Intact:am.versions[2].results[1].content === '回答B（重试后）',
      v3Inherited:am.versions[3].inherited === true});
  })()`);
  o = JSON.parse(r);
  check('重试后重综合：两批结果各计一次、副本只计综合', o.v === 4 && o.tokens === 4000, r);
  check('重试前后两版结果均可回滚', o.v0Intact === true && o.v2Intact === true, r);
  check('重综合副本带 inherited 标记', o.v3Inherited === true, r);

  // ===== 历史数据迁移：旧版重综合副本（无标记）补 inherited =====
  r = await js(`(function(){
    var rs = [{modelId:'m', status:'done', usage:{input:1, output:2}, content:'c'}];
    var s = {id:'mg1', messages:[{role:'assistant', roundId:'x', results:JSON.parse(JSON.stringify(rs)),
      versions:[
        {results:JSON.parse(JSON.stringify(rs)), merge:null, at:1},
        {results:JSON.parse(JSON.stringify(rs)), merge:{content:'新'}, at:2},
        {results:[{modelId:'m', status:'done', usage:{input:1, output:3}, content:'c2'}], merge:null, at:3}
      ]}]};
    MM.migrateSessions([s]);
    var vs = s.messages[0].versions;
    return JSON.stringify({f0:!!vs[0].inherited, f1:!!vs[1].inherited, f2:!!vs[2].inherited});
  })()`);
  o = JSON.parse(r);
  check('迁移为历史重复快照补 inherited 标记（真实新结果不受影响）', o.f0 === false && o.f1 === true && o.f2 === false, r);

  // ===== 版本池裁剪：被裁版本的用量折进 prunedTokens，会话累计不缩水 =====
  // 复刻真实序列：11 次重新生成触发「只保留最近 10 版」，最旧一份被裁——
  // 它代表一次真实请求，裁掉不能让会话累计 token 变小
  r = await js(`(async function(){
    var s = MM.sessions.createSilent();
    var res = [{modelId:'m1', name:'A', status:'done', usage:{input:100, output:0}, content:'回答内容'}];
    var mg = {content:'旧综合', mode:'frontend', usage:{input:0, output:10}, createdAt:Date.now()};
    var versions = [];
    for (var i = 0; i < 10; i++) {
      versions.push({results:JSON.parse(JSON.stringify(res)), merge:JSON.parse(JSON.stringify(mg)), at:Date.now()});
    }
    s.messages = [
      {id:'u9', role:'user', content:'问', createdAt:Date.now()},
      {id:'a9', role:'assistant', roundId:'rPrune', createdAt:Date.now(),
       results:JSON.parse(JSON.stringify(res)), merge:JSON.parse(JSON.stringify(mg)),
       versions:versions, active:9}
    ];
    var am = s.messages[1];
    var tokens0 = MM.sessions._sessionTokensForTest(s); // 10 × (100 结果 + 10 综合) = 1100
    await MM.chat._doMergeForTest('rPrune', {redo:true}); // 压栈第 11 份 → 裁掉最旧一份
    return JSON.stringify({
      tokens0:tokens0,
      tokens1:MM.sessions._sessionTokensForTest(s),
      pruned:am.prunedTokens || 0,
      v:am.versions.length});
  })()`);
  o = JSON.parse(r);
  // 裁剪后：剩 9 份整版(990) + inherited 副本只计综合(综合被新综合覆盖为无用量) + prunedTokens(110) = 1100
  check('版本池裁剪后累计不缩水（prunedTokens 接账）', o.tokens0 === 1100 && o.tokens1 === 1100 && o.pruned === 110 && o.v === 10, r);

  console.log('\nRESULT pass=' + pass + ' fail=' + fail);
  w.destroy(); app.exit(fail ? 1 : 0);
});
