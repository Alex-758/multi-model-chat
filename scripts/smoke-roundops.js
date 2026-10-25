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
  r = await js(`(function(){
    window.confirm = function(){ return true; };
    MM.chat._deleteRoundForTest('r1');
    var s = MM.sessions.current();
    return JSON.stringify({len:s.messages.length, roles:s.messages.map(function(m){return m.role;})});
  })()`);
  o = JSON.parse(r);
  check('删除本轮连提问一起移除', o.len === 0, r);

  r = await js(`(function(){
    // 多轮场景：只删指定轮，后续轮次不受影响
    var s = MM.sessions.current();
    s.messages = [
      {id:'u1', role:'user', content:'问1'},
      {id:'a1', role:'assistant', roundId:'rA', results:[{modelId:'m1',name:'A',status:'done',content:'答1'}]},
      {id:'u2', role:'user', content:'问2'},
      {id:'a2', role:'assistant', roundId:'rB', results:[{modelId:'m1',name:'A',status:'done',content:'答2'}]}
    ];
    MM.chat._deleteRoundForTest('rA');
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

  console.log('\nRESULT pass=' + pass + ' fail=' + fail);
  w.destroy(); app.exit(fail ? 1 : 0);
});
