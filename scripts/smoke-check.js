// 回归测试：修复专项 —— 单模型重试的节点缓存 + 会话搜索的输入法守卫
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
  const w = new BrowserWindow({ width: 1280, height: 900, show: true,
    webPreferences: { preload: path.join(ROOT, 'src', 'main', 'preload.js'), contextIsolation: true, sandbox: true } });
  const js = c => w.webContents.executeJavaScript(c);
  w.webContents.on('console-message', (e, ...a) => { const d = a[0]; const m = (d && d.message) || String(a[0]); if (/error|Error/.test(m)) console.log('  [console] ' + m.slice(0, 160)); });
  await w.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
  await sleep(1500);

  // ===== 修复 1：单模型重试必须把替换后的卡片节点写进事件缓存 =====
  let r = await js(`(function(){
    MM.state.config = MM.normalizeConfig({});
    var mid = 'deepseek::deepseek-flash';
    var s = MM.sessions.createSilent();
    s.messages = [
      {id:'u1', role:'user', content:'问', createdAt:Date.now()},
      {id:'a1', role:'assistant', roundId:'r1', createdAt:Date.now(), active:0, versions:[], results:[
        {modelId: mid, name:'DeepSeek V4.1 Flash', status:'error', error:'HTTP 429', content:''}
      ]}
    ];
    MM.sessions.render(); MM.chat.renderAll();
    // 不 await：retryOne 在 await api.send 之前是同步的，此刻 pending 已挂载（随后 api.send 无 handler 会被 catch 清理）
    MM.chat._retryOneForTest('r1', mid);
    var p = MM.chat._pendingForTest();
    var st = document.querySelector('.answer-card .ac-status');
    return JSON.stringify({
      ctx: p,
      statusStreaming: st ? st.textContent.indexOf('生成中') >= 0 : false
    });
  })()`);
  var o = JSON.parse(r);
  check('重试挂载了 singleRetry 请求上下文', o.ctx && o.ctx.singleRetry === true, r);
  check('事件缓存里注册了重试的模型', o.ctx && o.ctx.cardIds.indexOf('deepseek::deepseek-flash') >= 0, r);
  check('缓存的正文节点连接在活跃 DOM 上', o.ctx && o.ctx.bodyConnected === true, r);
  check('卡片已替换为流式状态', o.statusStreaming === true, r);

  // handleEvent 走缓存：模拟 delta 事件，正文必须更新到界面
  r = await js(`(function(){
    var mid = 'deepseek::deepseek-flash';
    // 重新触发一次重试拿到 pending（上一轮 api.send 拒绝后已被清理），随后手工发事件
    MM.state.config = MM.normalizeConfig({});
    var s = MM.sessions.current();
    s.messages = [
      {id:'u1', role:'user', content:'问', createdAt:Date.now()},
      {id:'a1', role:'assistant', roundId:'r2', createdAt:Date.now(), active:0, versions:[], results:[
        {modelId: mid, name:'DeepSeek V4.1 Flash', status:'error', error:'HTTP 429', content:''}
      ]}
    ];
    MM.chat.renderAll();
    MM.chat._retryOneForTest('r2', mid);
    var p = MM.chat._pendingForTest();
    if (!p || p.cardIds.indexOf(mid) < 0) return JSON.stringify({broken:true});
    // 用真实 requestId 发事件（handleEvent 按 requestId 查 ctx）
    // 注意：delta 的 DOM 绘制走 rAF，部分环境（隐藏/被遮挡窗口）不触发，所以断言数据层：
    // 修复前 handleEvent 找不到节点缓存会提前 return，res.content 不会变——这正是要防的回归
    MM.chat._handleEventForTest({requestId: p.requestId, modelId: mid, type:'delta', text:'重试流式内容'});
    var resNow = MM.sessions.current().messages[1].results[0];
    var afterDelta = resNow.content;
    MM.chat._handleEventForTest({requestId: p.requestId, modelId: mid, type:'done', ms:500, chars:7, usage:{input:100, output:20}});
    var st = document.querySelector('.answer-card .ac-status');
    return JSON.stringify({afterDelta: afterDelta, doneOk: st ? st.textContent.indexOf('✓') >= 0 && /tok/.test(st.textContent) : false});
  })()`);
  o = JSON.parse(r);
  check('delta 事件通过缓存更新到重试的卡片', o.afterDelta === '重试流式内容', r);
  check('done 后状态与 token 徽标正常', o.doneOk === true, r);

  // ===== 修复 2：会话搜索的输入法守卫 =====
  r = await js(`(function(){
    var input = document.getElementById('session-filter');
    MM.sessions.clearFilter(); MM.sessions.render();
    input.value = '重排';
    input.dispatchEvent(new Event('input'));
    // 组合开始后按 Esc：应只取消候选词，不清过滤词
    input.dispatchEvent(new Event('compositionstart'));
    input.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true}));
    var duringCompose = input.value;
    input.dispatchEvent(new Event('compositionend'));
    // 组合结束后按 Esc：清空
    input.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true}));
    var afterEnd = input.value;
    return JSON.stringify({duringCompose: duringCompose, afterEnd: afterEnd});
  })()`);
  o = JSON.parse(r);
  check('组合输入中按 Esc 不清空过滤词', o.duringCompose === '重排', r);
  check('组合结束后按 Esc 正常清空', o.afterEnd === '', r);

  console.log('\nRESULT pass=' + pass + ' fail=' + fail);
  w.destroy(); app.exit(fail ? 1 : 0);
});
