// 回归测试：会话搜索（标题/内容/大小写/空状态/清除/新建清空）
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

  // 造四个会话：标题命中 / 用户消息命中 / 回答命中 / 不命中
  let r = await js(`(function(){
    MM.state.config = MM.normalizeConfig({});
    function mk(id, title, msgs) { return {id:id, title:title, messages:msgs, createdAt:Date.now(), updatedAt:Date.now()}; }
    MM.state.sessions = [
      mk('s1', '重排与重绘的区别', []),
      mk('s2', '随便聊聊', [{id:'u1',role:'user',content:'帮我写一封请假邮件'}]),
      mk('s3', '第三个会话', [{id:'a1',role:'assistant',roundId:'r1',results:[{modelId:'m1',name:'A',status:'done',content:'Kimi K3 的上下文是 100 万 token'}]}]),
      mk('s4', '第四个会话', [{id:'a2',role:'assistant',roundId:'r2',merge:{content:'综合：使用 pytest 写单测'},results:[]}]),
      mk('s5', 'English Title', [])
    ];
    MM.state.currentId = 's1';
    MM.sessions.render();
    return document.querySelectorAll('#session-list .session-item').length;
  })()`);
  check('测试前提：5 个会话全部显示', r === 5, String(r));

  // 标题命中
  r = await js(`(function(){
    MM.sessions._setFilterForTest('重排');
    MM.sessions.render();
    return JSON.stringify([].map.call(document.querySelectorAll('#session-list .session-item'), function(x){return x.getAttribute('data-id');}));
  })()`);
  check('按标题过滤', r === '["s1"]', r);

  // 用户消息内容命中
  r = await js(`(function(){
    MM.sessions._setFilterForTest('请假邮件');
    MM.sessions.render();
    return JSON.stringify([].map.call(document.querySelectorAll('#session-list .session-item'), function(x){return x.getAttribute('data-id');}));
  })()`);
  check('按用户消息内容过滤', r === '["s2"]', r);

  // 回答内容命中（results[].content）
  r = await js(`(function(){
    MM.sessions._setFilterForTest('100 万 token');
    MM.sessions.render();
    return JSON.stringify([].map.call(document.querySelectorAll('#session-list .session-item'), function(x){return x.getAttribute('data-id');}));
  })()`);
  check('按模型回答内容过滤', r === '["s3"]', r);

  // 综合回答内容命中（merge.content）
  r = await js(`(function(){
    MM.sessions._setFilterForTest('pytest');
    MM.sessions.render();
    return JSON.stringify([].map.call(document.querySelectorAll('#session-list .session-item'), function(x){return x.getAttribute('data-id');}));
  })()`);
  check('按综合回答内容过滤', r === '["s4"]', r);

  // 大小写不敏感
  r = await js(`(function(){
    MM.sessions._setFilterForTest('english');
    MM.sessions.render();
    return JSON.stringify([].map.call(document.querySelectorAll('#session-list .session-item'), function(x){return x.getAttribute('data-id');}));
  })()`);
  check('英文大小写不敏感', r === '["s5"]', r);

  // 无结果 → 空状态 + 清除按钮
  r = await js(`(function(){
    MM.sessions._setFilterForTest('绝对不存在的关键词xyz');
    MM.sessions.render();
    var empty = document.querySelector('#session-list .session-empty');
    var btn = empty ? empty.querySelector('.btn-ghost') : null;
    return JSON.stringify({hasEmpty: !!empty, text: empty ? empty.textContent.indexOf('绝对不存在的关键词xyz') >= 0 : false, hasClear: !!btn});
  })()`);
  var o = JSON.parse(r);
  check('无匹配时显示空状态', o.hasEmpty && o.text, r);
  check('空状态带清除按钮', o.hasClear, r);

  // 清除后恢复全部
  r = await js(`(function(){
    MM.sessions.clearFilter();
    MM.sessions.render();
    return document.querySelectorAll('#session-list .session-item').length;
  })()`);
  check('清除过滤后恢复全部会话', r === 5, String(r));

  // 新建会话清空过滤（否则新会话会被过滤词藏起来）
  r = await js(`(function(){
    MM.sessions._setFilterForTest('重排');
    var input = document.getElementById('session-filter');
    input.value = '重排';
    MM.sessions.create();
    var visible = document.querySelectorAll('#session-list .session-item').length;
    return JSON.stringify({visible: visible, inputCleared: input.value === '', current: MM.sessions.current().title});
  })()`);
  o = JSON.parse(r);
  check('新建会话时自动清空过滤', o.inputCleared && o.current === '新会话', r);

  // 真实输入框路径：设值 + input 事件 → 防抖后列表被过滤
  r = await new Promise(async resolve => {
    await js(`(function(){
      MM.sessions.clearFilter(); MM.sessions.render();
      var input = document.getElementById('session-filter');
      input.value = 'Kimi';
      input.dispatchEvent(new Event('input'));
    })()`);
    setTimeout(async () => {
      const res = await js(`JSON.stringify({
        filtered: [].map.call(document.querySelectorAll('#session-list .session-item'), function(x){return x.getAttribute('data-id');}),
        clearBtnShown: !document.getElementById('btn-filter-clear').classList.contains('hidden')
      })`);
      resolve(res);
    }, 400);
  });
  o = JSON.parse(r);
  check('输入框真实路径触发过滤（防抖后）', JSON.stringify(o.filtered) === '["s3"]', r);
  check('有词时显示清除按钮', o.clearBtnShown === true, r);

  // Esc 清空（模拟 keydown）
  r = await js(`(function(){
    var input = document.getElementById('session-filter');
    input.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true}));
    MM.sessions.render();
    return JSON.stringify({cleared: input.value === '', count: document.querySelectorAll('#session-list .session-item').length});
  })()`);
  o = JSON.parse(r);
  check('Esc 清空搜索', o.cleared && o.count === 6, r);

  console.log('\nRESULT pass=' + pass + ' fail=' + fail);
  w.destroy(); app.exit(fail ? 1 : 0);
});
