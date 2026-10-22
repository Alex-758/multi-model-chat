// 临时审计脚本：真实渲染层 + 真实 preload + mock IPC，验证本轮扫描的可疑点。
// 不读写用户数据（store 相关 IPC 全部由本脚本接管）。
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'mmc-audit-')));

const sleep = ms => new Promise(r => setTimeout(r, ms));
const rows = [];
function check(name, pass, detail) {
  rows.push({ name, pass, detail });
  console.log((pass ? 'PASS' : 'FAIL') + ' | ' + name + ' | ' + detail);
}

const baseConfig = {
  providers: [{
    id: 'deepseek', name: 'DeepSeek', provider: 'deepseek', apiFormat: 'openai',
    baseUrl: 'https://api.deepseek.com', fullUrl: false, preset: true, hasKey: true,
    models: [{ modelId: 'deepseek-flash', name: 'DeepSeek V4.1 Flash', enabled: true, contextTokens: 1048576, maxTokens: 393216 }]
  }],
  search: { provider: 'bing', hasKey: false },
  synthesis: { synthSource: 'frontend', autoMerge: false },
  systemPrompt: ''
};

function mkSessions() {
  return [
    {
      id: 'sA', title: '会话A', createdAt: 1, updatedAt: 2, pinned: false, systemPrompt: 'AAA',
      messages: [
        { id: 'a1', role: 'user', content: 'A的问题', createdAt: 1 },
        { id: 'a2', role: 'assistant', roundId: 'rA', createdAt: 2,
          results: [{ modelId: 'deepseek::deepseek-flash', name: 'Flash', status: 'done', content: 'A的回答' }] }
      ]
    },
    {
      id: 'sB', title: '会话B', createdAt: 3, updatedAt: 4, pinned: false,
      messages: [
        { id: 'b1', role: 'user', content: '旧问题一', createdAt: 3 },
        { id: 'b2', role: 'assistant', createdAt: 4,
          results: [{ modelId: 'deepseek::deepseek-flash', name: 'Flash', status: 'done', content: '旧回答一' }] },
        { id: 'b3', role: 'user', content: '旧问题二', createdAt: 5 },
        { id: 'b4', role: 'assistant', createdAt: 6,
          results: [{ modelId: 'deepseek::deepseek-flash', name: 'Flash', status: 'done', content: '旧回答二' }] }
      ]
    }
  ];
}

let saves = [];
let sends = [];
let synths = [];
let loadFail = false;
let searchDelay = 0;
let importPayload = null;
let overrideLoad = null;

ipcMain.handle('store:all', () => {
  if (loadFail) throw new Error('模拟主进程读取失败');
  if (overrideLoad) return JSON.parse(JSON.stringify(overrideLoad));
  return { config: JSON.parse(JSON.stringify(baseConfig)), sessions: mkSessions() };
});
ipcMain.handle('store:save', (e, d) => { saves.push(JSON.parse(JSON.stringify(d))); return true; });
ipcMain.handle('chat:send', (e, p) => { sends.push(JSON.parse(JSON.stringify(p))); return true; });
ipcMain.handle('chat:stop', () => true);
ipcMain.handle('chat:synthesize', (e, p) => { synths.push(JSON.parse(JSON.stringify(p))); return true; });
ipcMain.handle('search:query', async () => {
  if (searchDelay) await sleep(searchDelay);
  return [{ title: 't', url: 'https://e.com', snippet: 's' }];
});
ipcMain.handle('search:test', () => []);
ipcMain.handle('models:list', () => []);
ipcMain.handle('models:test', () => 'ok');
ipcMain.handle('catalog:get', () => null);
ipcMain.handle('secrets:set', () => true);
ipcMain.handle('secrets:clear', () => true);
ipcMain.handle('data:export', () => null);
ipcMain.handle('data:import', () => importPayload || ({
  config: JSON.parse(JSON.stringify(baseConfig)),
  sessions: [{ id: 'sImp', title: '导入的会话', createdAt: 9, updatedAt: 9, pinned: false, messages: [] }]
}));

function mkWindow() {
  const w = new BrowserWindow({
    width: 1200, height: 850, show: true, backgroundColor: '#f5f6fa',
    webPreferences: {
      preload: path.join(ROOT, 'src', 'main', 'preload.js'),
      contextIsolation: true,
      sandbox: true
    }
  });
  w.webContents.on('console-message', d => {
    if (d && d.message) console.log('[renderer]', d.message);
  });
  return w;
}

app.whenReady().then(async () => {
  const w = mkWindow();
  const js = code => w.webContents.executeJavaScript(code, true);
  try {
    await w.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
    await sleep(1200);

    // ---------- T0: 回归检查：设置页密钥遮罩 ----------
    const t0 = await js(`(function(){
      MM.settings.open();
      document.querySelector('.settings-nav[data-pane="models"]').click();
      var inp = document.querySelector('#p-key');
      var masked = inp.value;
      inp.dispatchEvent(new Event('focus'));
      var focused = inp.value;
      inp.dispatchEvent(new Event('blur'));
      var blurred = inp.value;
      MM.settings.close();
      return { masked: masked, focused: focused, blurred: blurred };
    })()`);
    check('密钥遮罩：初始为遮罩、聚焦清空、失焦恢复',
      t0.masked === '••••••••' && t0.focused === '' && t0.blurred === '••••••••', JSON.stringify(t0));

    // ---------- T0b: 设置/全局提示词保存只传 config ----------
    saves = [];
    await js(`(function(){
      MM.settings.open();
      document.querySelector('.settings-nav[data-pane="prompt"]').click();
      var ta = document.querySelector('#sp-global');
      ta.value = '全局提示词测试';
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await sleep(1100);
    check('全局提示词保存只传 config（且打开设置页不触发额外保存）',
      saves.length === 1 && !!saves[0].config && !('sessions' in saves[0]),
      'saves=' + JSON.stringify(saves.map(s => Object.keys(s))));
    saves = [];
    await js('MM.save()');
    await sleep(200);
    check('普通保存仍包含 sessions', !!(saves[0] && Array.isArray(saves[0].sessions)),
      'keys=' + JSON.stringify(saves[0] && Object.keys(saves[0])));
    await js('MM.settings.close()');
    await sleep(300);

    // ---------- T1: 切换会话后，提示词面板内容是否跟着切换 ----------
    const t1 = await js(`(function(){
      MM.sessions.switchTo('sA');
      document.querySelector('#btn-session-prompt').click();
      var before = document.querySelector('#session-prompt').value;
      MM.sessions.switchTo('sB');
      var after = document.querySelector('#session-prompt').value;
      var ta = document.querySelector('#session-prompt');
      ta.value = after + 'B新增';
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      var b = MM.state.sessions.find(function(x){ return x.id === 'sB'; });
      return { before: before, after: after, bPrompt: b.systemPrompt,
               boxOpen: !document.querySelector('#session-prompt-box').classList.contains('hidden') };
    })()`);
    check('切换会话后提示词面板同步（应显示 B 的空提示词）', t1.after === '',
      'A的值=' + JSON.stringify(t1.before) + ' 切到B后=' + JSON.stringify(t1.after) + ' 面板仍展开=' + t1.boxOpen);
    check('切换会话后在面板里输入只写入当前会话', !t1.bPrompt || t1.bPrompt === 'B新增',
      'B.systemPrompt=' + JSON.stringify(t1.bPrompt));

    // 空会话会走 renderAll 的提前 return 分支，同样要同步提示词面板
    const t1b = await js(`(function(){
      MM.sessions.switchTo('sA');
      MM.state.sessions.push({ id: 'sEmpty', title: '空会话', createdAt: 99, updatedAt: 99, pinned: false, messages: [] });
      MM.sessions.switchTo('sEmpty');
      return { value: document.querySelector('#session-prompt').value,
               btnOn: document.querySelector('#btn-session-prompt').classList.contains('on') };
    })()`);
    check('切到空会话时提示词面板也同步', t1b.value === '' && t1b.btnOn === false, JSON.stringify(t1b));

    // ---------- T2: 连续点两条消息的「编辑」 ----------
    const t2 = await js(`(function(){
      MM.sessions.switchTo('sB');
      var hints = [].slice.call(document.querySelectorAll('.user-msg .copy-hint')).filter(function(x){return x.textContent === '编辑';});
      hints.forEach(function(h){ h.click(); });
      return { hints: hints.length, boxes: document.querySelectorAll('.edit-box').length };
    })()`);
    check('同一时刻只允许一个编辑框', t2.boxes <= 1, '消息数=' + t2.hints + ' 编辑框数=' + t2.boxes);

    // ---------- T3: 旧会话（assistant 无 roundId）重新生成命中的轮次 ----------
    sends = [];
    await js(`(function(){
      MM.sessions.switchTo('sA'); MM.sessions.switchTo('sB');
      var tools = [].slice.call(document.querySelectorAll('.round-tools'));
      var last = tools[tools.length - 1];
      var btn = [].slice.call(last.querySelectorAll('button')).filter(function(b){ return /重新生成/.test(b.textContent); })[0];
      btn.click();
      return tools.length;
    })()`);
    await sleep(400);
    const q3 = sends[0] && sends[0].targets && sends[0].targets[0].messages.slice(-1)[0].content;
    check('无 roundId 的旧会话：点第二轮「重新生成」应重发第二轮问题', q3 === '旧问题二',
      '实际重发=' + JSON.stringify(q3) + '（发送次数=' + sends.length + '）');
    if (sends[0]) w.webContents.send('chat:event', { requestId: sends[0].requestId, type: 'all-done' });
    await sleep(300);

    // ---------- T4: 搜索阶段点停止后，旧请求是否真的取消 ----------
    searchDelay = 400;
    sends = [];
    await js(`(function(){
      MM.sessions.switchTo('sA');
      var t = document.querySelector('#tgl-search');
      if (!t.checked) { t.checked = true; t.dispatchEvent(new Event('change', { bubbles: true })); }
      var inp = document.querySelector('#input');
      inp.value = '旧请求'; inp.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#btn-send').click();
    })()`);
    await sleep(120);
    await js(`document.querySelector('#btn-send').click()`); // 停止（此时仍在搜索阶段）
    await sleep(50);
    await js(`(function(){
      var inp = document.querySelector('#input');
      inp.value = '新请求'; inp.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#btn-send').click();
    })()`);
    await sleep(1300);
    const qs = sends.map(s => s.targets[0].messages.slice(-1)[0].content);
    const order = await js(`(function(){
      var s = MM.state.sessions.find(function(x){return x.id === 'sA';});
      return s.messages.map(function(m){ return m.role; }).join(',');
    })()`);
    check('停止后旧请求不再发出', qs.length === 1 && qs[0] === '新请求',
      '实际发出=' + JSON.stringify(qs) + ' 消息顺序=' + order);
    for (const s of sends) w.webContents.send('chat:event', { requestId: s.requestId, type: 'all-done' });
    await sleep(300);
    searchDelay = 0;

    // ---------- T5: 读取失败时是否会用空数据覆盖磁盘 ----------
    loadFail = true;
    saves = [];
    const w2 = mkWindow();
    await w2.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
    await sleep(1200);
    const fatal5 = await w2.webContents.executeJavaScript("!!document.getElementById('fatal-error')", true);
    check('读取失败时停止启动并提示，不落盘覆盖', saves.length === 0 && fatal5,
      '保存次数=' + saves.length + ' 错误遮罩=' + fatal5);
    w2.destroy();
    loadFail = false;

    // ---------- T6: 重新生成时复用上一轮的搜索来源 ----------
    sends = [];
    await js(`(function(){
      var s = { id: 'sC', title: '搜索复用', createdAt: 10, updatedAt: 10, pinned: false, messages: [
        { id: 'c1', role: 'user', content: '搜索问题', createdAt: 10,
          sources: [{ title: '旧来源', url: 'https://old.example', snippet: '旧快照' }] },
        { id: 'c2', role: 'assistant', roundId: 'rC', createdAt: 11,
          results: [{ modelId: 'deepseek::deepseek-flash', name: 'Flash', status: 'done', content: '回答' }] }
      ] };
      MM.state.sessions.push(s);
      MM.state.currentId = 'sC';
      MM.chat.renderAll();
      var t = document.querySelector('#tgl-search');
      if (t.checked) { t.checked = false; t.dispatchEvent(new Event('change', { bubbles: true })); }
      var tools = [].slice.call(document.querySelectorAll('.round-tools'));
      var btn = [].slice.call(tools[0].querySelectorAll('button')).filter(function(b){ return /重新生成/.test(b.textContent); })[0];
      btn.click();
    })()`);
    await sleep(400);
    const s6 = sends[0];
    const sys6 = s6 && s6.targets[0].messages.filter(m => m.role === 'system').map(m => m.content).join('\n');
    check('关闭联网搜索后重新生成不应沿用旧搜索来源',
      !!(s6 && s6.searchOn === false && !/旧来源/.test(sys6 || '')),
      'searchOn=' + (s6 && s6.searchOn) + ' 历史含旧来源=' + /旧来源/.test(sys6 || ''));
    for (const s of sends) w.webContents.send('chat:event', { requestId: s.requestId, type: 'all-done' });
    await sleep(300);

    // ---------- T6b: 综合回答带上系统提示词 ----------
    synths = [];
    await js(`(function(){
      var s = { id: 'sD', title: '综合测试', createdAt: 12, updatedAt: 12, pinned: false, systemPrompt: 'SYS',
        messages: [
          { id: 'd1', role: 'user', content: '问题D', createdAt: 12 },
          { id: 'd2', role: 'assistant', roundId: 'rD', createdAt: 13,
            results: [{ modelId: 'deepseek::deepseek-flash', name: 'Flash', status: 'done', content: '回答D' }] }
        ] };
      MM.state.sessions.push(s);
      MM.state.currentId = 'sD';
      MM.state.config.synthesis.synthSource = 'deepseek::deepseek-flash';
      MM.chat.renderAll();
      var tools = document.querySelector('.round-tools');
      var btn = [].slice.call(tools.querySelectorAll('button')).filter(function(b){ return b.textContent === '综合回答'; })[0];
      btn.click();
    })()`);
    await sleep(400);
    const sy = synths[0];
    check('综合回答请求带上系统提示词',
      !!sy && sy.messages[0] && sy.messages[0].role === 'system' && sy.messages[0].content === 'SYS',
      JSON.stringify(sy && sy.messages && sy.messages.map(m => m.role)));
    for (const s of synths) w.webContents.send('chat:event', { requestId: s.requestId, type: 'all-done' });
    await sleep(300);

    // ---------- T6c: 会话 token 累计包含历史版本 ----------
    const tok = await js(`MM.sessions._sessionTokensForTest({ messages: [
      { role: 'assistant', versions: [
        { results: [{ usage: { input: 10, output: 5 } }] },
        { results: [{ usage: { input: 20, output: 5 } }] }
      ], results: [{ usage: { input: 20, output: 5 } }] }
    ] })`);
    check('会话 token 累计包含历史版本', tok === 40, 'tok=' + tok);

    // ---------- T6d: 无回答的提问有「重新生成」入口 ----------
    sends = [];
    await js(`(function(){
      var s = { id: 'sE', title: '无回答', createdAt: 14, updatedAt: 14, pinned: false,
        messages: [{ id: 'e1', role: 'user', content: '没回答的问题', createdAt: 14 }] };
      MM.state.sessions.push(s);
      MM.state.currentId = 'sE';
      MM.chat.renderAll();
      var t = document.querySelector('.round-tools.retry-only');
      window.__hasRetry = !!t;
      if (t) [].slice.call(t.querySelectorAll('button')).filter(function(b){return /重新生成/.test(b.textContent);})[0].click();
    })()`);
    await sleep(400);
    const hasRetry = await js('window.__hasRetry');
    const q = sends[0] && sends[0].targets[0].messages.slice(-1)[0].content;
    check('搜索阶段被停止的提问有重新生成入口', hasRetry === true && q === '没回答的问题',
      '入口=' + hasRetry + ' 重发=' + JSON.stringify(q));
    for (const s of sends) w.webContents.send('chat:event', { requestId: s.requestId, type: 'all-done' });
    await sleep(300);

    // ---------- T6e: 手动改过 ID 的模型不被旧 ID 迁移规则改写 ----------
    const fp = await js(`(function(){
      MM.settings.open();
      document.querySelector('.settings-nav[data-pane="models"]').click();
      var p = MM.state.config.providers.find(function(x){ return x.id === 'deepseek'; });
      var mo = p.models[0];
      mo.fromPreset = true;
      var input = document.querySelector('#model-entries input');
      input.value = 'deepseek-chat';
      input.dispatchEvent(new Event('input'));
      input.dispatchEvent(new Event('blur'));
      var next = MM.normalizeConfig(MM.state.config);
      var np = next.providers.find(function(x){ return x.id === 'deepseek'; });
      return { id: np.models[0] && np.models[0].modelId, fromPreset: np.models[0] && np.models[0].fromPreset };
    })()`);
    check('手动改过 ID 的模型不再被旧 ID 迁移规则改写', fp.id === 'deepseek-chat', JSON.stringify(fp));

    // ---------- T6f: 流式事件渲染（卡片引用缓存路径） ----------
    sends = [];
    await js(`(function(){
      var s = { id: 'sF', title: '流式', createdAt: 15, updatedAt: 15, pinned: false, messages: [] };
      MM.state.sessions.push(s);
      MM.state.currentId = 'sF';
      MM.chat.renderAll();
      var inp = document.querySelector('#input');
      inp.value = '流式测试';
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#btn-send').click();
    })()`);
    await sleep(300);
    const rid = sends[0] && sends[0].requestId;
    const mid = sends[0] && sends[0].targets[0].model.id;
    if (rid && mid) {
      w.webContents.send('chat:event', { requestId: rid, modelId: mid, type: 'start' });
      w.webContents.send('chat:event', { requestId: rid, modelId: mid, type: 'delta', text: '你' });
      w.webContents.send('chat:event', { requestId: rid, modelId: mid, type: 'delta', text: '好' });
      w.webContents.send('chat:event', { requestId: rid, modelId: mid, type: 'reasoning', text: '思考中' });
      await sleep(120);
      w.webContents.send('chat:event', { requestId: rid, modelId: mid, type: 'done', ms: 12, chars: 2, usage: { input: 3, output: 2 } });
      w.webContents.send('chat:event', { requestId: rid, type: 'all-done' });
    }
    await sleep(400);
    const st6 = await js(`(function(){
      var card = document.querySelector('.answer-card');
      return { text: card && card.querySelector('.ac-body').textContent,
               status: card && card.querySelector('.ac-status').textContent,
               reasoning: !!(card && card.querySelector('details.reasoning')),
               tok: !!(card && card.querySelector('.badge.tok')),
               tools: !!document.querySelector('.round-tools') };
    })()`);
    check('流式 delta/思考/完成事件正确渲染',
      st6.text === '你好' && /✓/.test(st6.status) && st6.reasoning && st6.tok && st6.tools,
      JSON.stringify(st6));

    // ---------- T7: 导入新格式备份后，密钥标记是否保留 ----------
    importPayload = null;
    await js(`(function(){
      MM.settings.open();
      document.querySelector('.settings-nav[data-pane="data"]').click();
      var btn = [].slice.call(document.querySelectorAll('#pane-data button')).filter(function(b){return /导入数据/.test(b.textContent);})[0];
      btn.click();
    })()`);
    await sleep(800);
    const hasKey = await js(`MM.state.config.providers[0].hasKey`);
    const title = await js(`document.querySelector('#session-title').textContent`);
    check('导入新格式备份后 hasKey 仍为 true', hasKey === true, 'hasKey=' + hasKey);
    check('导入后顶栏标题同步', title === '导入的会话', '标题=' + JSON.stringify(title));

    // ---------- T8: 导入含非法会话条目的备份 ----------
    importPayload = { config: JSON.parse(JSON.stringify(baseConfig)), sessions: [null, { id: 'ok', title: '正常会话', messages: [] }] };
    await js(`(function(){
      MM.settings.open();
      document.querySelector('.settings-nav[data-pane="data"]').click();
      var btn = [].slice.call(document.querySelectorAll('#pane-data button')).filter(function(b){return /导入数据/.test(b.textContent);})[0];
      btn.click();
    })()`);
    await sleep(700);
    const t8 = await js(`(function(){
      return { len: MM.state.sessions.length, hasNull: MM.state.sessions.some(function(x){ return !x; }),
               toast: document.querySelector('#toast').textContent };
    })()`);
    check('导入含 null 的会话不会污染内存状态', !t8.hasNull, JSON.stringify(t8));
    saves = [];
    await js(`MM.save()`);
    await sleep(200);
    const saved8 = saves[0];
    check('非法会话条目不会被写回磁盘', !saved8 || !(saved8.sessions || []).some(x => !x),
      'sessions=' + JSON.stringify((saved8 && saved8.sessions || []).map(x => x && x.id)));

    // ---------- T9: 用被污染的数据重启，是否还能打开 ----------
    overrideLoad = { config: JSON.parse(JSON.stringify(baseConfig)), sessions: [null, { id: 'ok', title: '正常会话', messages: [] }] };
    const w3 = mkWindow();
    await w3.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
    await sleep(1200);
    const fatal = await w3.webContents.executeJavaScript("!!document.getElementById('fatal-error')", true);
    const fatalText = await w3.webContents.executeJavaScript(
      "document.getElementById('fatal-error') ? document.querySelector('#fatal-error pre').textContent.slice(0,120) : ''", true);
    check('含 null 会话的数据下次启动应能正常打开', !fatal, 'fatal=' + fatal + ' ' + fatalText);
    w3.destroy();
    overrideLoad = null;

    // ---------- T10: 主进程 store.load 对非法 providers 的处理 ----------
    const store = require('../src/main/store');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mmc-store-'));
    store.init(dir);
    fs.writeFileSync(path.join(dir, 'store.json'), JSON.stringify({ config: { providers: [null] }, sessions: [] }), 'utf8');
    const loaded = store.load();
    check('store.load 遇非法 providers 不崩溃', !!loaded && !!loaded.config && Array.isArray(loaded.config.providers),
      'loaded=' + JSON.stringify(loaded) + ' corrupt=' + JSON.stringify(store.corruptInfo()));
  } catch (e) {
    console.log('AUDIT_ERROR ' + (e && (e.stack || e.message)));
  }
  console.log('---SUMMARY---');
  console.log(JSON.stringify(rows, null, 1));
  w.destroy();
  app.exit(0);
});
