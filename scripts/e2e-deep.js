'use strict';
// 深度模拟使用测试：真实 main.js + 真实渲染层 + 本地 mock 服务。
// 覆盖：连点/快速操作、异常输入、流异常（断流/垃圾行/CRLF/超大 delta/无用量）、
//       综合中停止/切会话、设置边界（删除当前服务商/空名/HTML 名/特殊模型 ID/全不选/空 ID）、
//       导入容错（畸形 JSON 系列）、流式中导入/清空、猴子随机点击、控制台零错误。
const { app, BrowserWindow, dialog, shell } = require('electron');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'mmc-deep-'));
app.setPath('userData', DATA);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const rows = [];
async function run(name, fn) {
  try {
    const detail = await fn();
    rows.push({ name, pass: true, detail: detail === undefined ? '' : String(detail) });
    console.log('PASS | ' + name + ' | ' + (detail === undefined ? '' : detail));
  } catch (e) {
    rows.push({ name, pass: false, detail: e && e.message });
    console.log('FAIL | ' + name + ' | ' + (e && e.message));
  }
}
function assert(c, m) { if (!c) throw new Error(m); }

const requests = [];
const counters = {};
let behavior = null; // { type: 'close' | 'garbage' | 'crlf' | 'huge' | 'nousage' }
const server = http.createServer(async (req, res) => {
  let raw = '';
  req.on('data', c => { raw += c; });
  req.on('end', async () => {
    if (req.url.indexOf('/models') >= 0) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'm1' }, { id: 'm2' }] }));
      return;
    }
    let body = {};
    try { body = JSON.parse(raw || '{}'); } catch (e) { /* ignore */ }
    requests.push({ url: req.url, body, headers: req.headers });
    const model = String(body.model || '');
    const n = counters[model] = (counters[model] || 0) + 1;
    if (model === 'err') {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'invalid key' } }));
      return;
    }
    if (model === 'json') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: '非流式完整回答' } }], usage: { prompt_tokens: 7, completion_tokens: 3 } }));
      return;
    }
    const slow = model === 'slow';
    const med = model === 'med';
    const text = slow ? '慢速输出'.repeat(80) : (med ? 'med流'.repeat(30) : ('回答-' + model + '-' + n));
    const delay = slow ? 60 : (med ? 30 : 5);
    const eol = behavior && behavior.type === 'crlf' ? '\r\n' : '\n';
    const send_ = obj => res.write('data: ' + JSON.stringify(obj) + eol + eol);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    if (behavior && behavior.type === 'garbage') {
      res.write('data: {oops' + eol + eol + 'data: [not json' + eol + eol);
    }
    if (behavior && behavior.type === 'huge') {
      send_({ choices: [{ delta: { content: '巨'.repeat(250000) } }] });
      res.end('data: [DONE]' + eol + eol);
      return;
    }
    let i = 0, sent = 0;
    const timer = setInterval(() => {
      if (res.destroyed) { clearInterval(timer); return; }
      if (behavior && behavior.type === 'close' && sent >= 3) { clearInterval(timer); res.destroy(); return; }
      if (i < text.length) { send_({ choices: [{ delta: { content: text[i++] } }] }); sent++; return; }
      clearInterval(timer);
      if (!(behavior && behavior.type === 'nousage')) send_({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } });
      res.end('data: [DONE]' + eol + eol);
    }, delay);
    res.on('close', () => clearInterval(timer));
  });
});

let nextOpen = '';
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [nextOpen] });
dialog.showSaveDialog = async () => ({ canceled: true, filePath: '' });
shell.openExternal = async () => {};

function baseConfig(port) {
  return {
    providers: [{
      id: 'p1', name: '本地', provider: 'custom', apiFormat: 'openai',
      baseUrl: 'http://127.0.0.1:' + port + '/v1', apiKey: 'k1', fullUrl: false, preset: false,
      models: [
        { modelId: 'm1', name: '模型一', enabled: true, contextTokens: 100000, maxTokens: 4096 },
        { modelId: 'm2', name: '模型二', enabled: true, contextTokens: 100000, maxTokens: 4096 },
        { modelId: 'slow', name: '慢速', enabled: true, contextTokens: 100000, maxTokens: 4096 },
        { modelId: 'med', name: '中速', enabled: true, contextTokens: 100000, maxTokens: 4096 },
        { modelId: 'fast', name: '快速', enabled: true, contextTokens: 100000, maxTokens: 4096 },
        { modelId: 'err', name: '错误', enabled: true, contextTokens: 100000, maxTokens: 4096 },
        { modelId: 'json', name: '非流式', enabled: true, contextTokens: 100000, maxTokens: 4096 }
      ]
    }],
    search: { provider: 'none' },
    synthesis: { synthSource: 'frontend', autoMerge: false },
    systemPrompt: ''
  };
}

server.listen(0, '127.0.0.1', () => {
  const port = server.address().port;
  fs.writeFileSync(path.join(DATA, 'store.json'), JSON.stringify({
    config: baseConfig(port),
    sessions: [{ id: 's0', title: '新会话', createdAt: 1, updatedAt: 1, pinned: false, messages: [] }]
  }, null, 1), 'utf8');
  require(path.join(ROOT, 'src', 'main', 'main.js'));

  app.whenReady().then(async () => {
    await sleep(1600);
    const w = BrowserWindow.getAllWindows()[0];
    if (!w) { console.log('FAIL | 窗口未创建'); app.exit(1); return; }
    const js = code => w.webContents.executeJavaScript(code, true);

    const consoleErrors = [];
    let procGone = null;
    w.webContents.on('console-message', d => {
      const msg = (d && d.message) || '';
      if ((d && (d.level === 'error' || d.level === 3)) || /Uncaught/i.test(msg)) consoleErrors.push(msg);
    });
    w.webContents.on('render-process-gone', (e, d) => { procGone = d; });

    async function waitFor(expr, timeout) {
      const t0 = Date.now();
      while (Date.now() - t0 < (timeout || 8000)) {
        if (await js(expr)) return true;
        await sleep(100);
      }
      return false;
    }
    async function newSession() { await js("document.querySelector('#btn-new-chat').click()"); await sleep(150); }
    async function setChips(ids) {
      await js(`(function(){ var want=${JSON.stringify(ids)};
        document.querySelectorAll('#model-chips .chip').forEach(function(c){ c.classList.toggle('on', want.indexOf(c.getAttribute('data-model-id'))>=0); }); })()`);
    }
    async function sendText(text) {
      await js(`(function(){ var i=document.querySelector('#input'); i.value=${JSON.stringify(text)};
        i.dispatchEvent(new Event('input',{bubbles:true}));
        document.querySelector('#btn-send').click(); })()`);
    }
    const doneExpr = "document.querySelectorAll('.answer-card').length > 0 && !document.querySelector('#btn-send').classList.contains('stop')";
    async function waitDone(t) { return waitFor(doneExpr, t || 10000); }
    async function clickTool(label) {
      return js(`(function(){ var b=[].slice.call(document.querySelectorAll('.round-tools button')).filter(function(x){return x.textContent.indexOf(${JSON.stringify(label)})>=0;})[0]; if(b) b.click(); return !!b; })()`);
    }
    async function setSynth(id) {
      await js(`(function(){
        MM.settings.open();
        document.querySelector('.settings-nav[data-pane="synth"]').click();
        var s=document.querySelector('#y-source');
        s.value=${JSON.stringify(id)};
        [].slice.call(document.querySelectorAll('#pane-synth button')).filter(function(b){return b.textContent==='保存';})[0].click();
        MM.settings.close();
      })()`);
      await sleep(300);
    }
    function lastReq(pred) {
      for (let i = requests.length - 1; i >= 0; i--) if (!pred || pred(requests[i])) return requests[i];
      return null;
    }
    async function noFatal() {
      return js("(!document.getElementById('fatal-error') && typeof MM === 'object' && !!MM.state)");
    }
    async function renameActiveDeep(title) {
      await js(`(function(){
        var it=document.querySelector('#session-list .session-item.active');
        if(!it) return;
        var b=[].slice.call(it.querySelectorAll('.s-actions button')).filter(function(x){return x.textContent==='改名';})[0];
        if(!b) return;
        b.click();
        var inp=document.querySelector('#session-list input');
        if(!inp) return;
        inp.value=${JSON.stringify(title)};
        inp.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));
      })()`);
      await sleep(250);
    }
    async function switchToDeep(title) {
      await js(`(function(){ var it=[].slice.call(document.querySelectorAll('#session-list .session-item')).filter(function(x){ var t=x.querySelector('.s-title'); return t && t.textContent===${JSON.stringify(title)}; })[0]; if(it) it.click(); })()`);
      await sleep(200);
    }

    // ================= A. 连点 / 快速操作 =================
    await run('双击发送 = 发送后立即停止（发送/停止切换语义）', async () => {
      await newSession();
      await setChips(['p1::m1']);
      requests.length = 0;
      await sendText('双击测试');
      await js("document.querySelector('#btn-send').click()"); // 第二击 = 停止
      assert(await waitFor("!document.querySelector('#btn-send').classList.contains('stop')", 6000), '停止未复位');
      assert(requests.length === 1, '请求数=' + requests.length);
      const st = await js("document.querySelector('.ac-status').textContent");
      assert(/已停止/.test(st), 'status=' + st);
      return JSON.stringify({ reqs: requests.length, status: st });
    });

    await run('双击重新生成只重试一次', async () => {
      await newSession();
      await setChips(['p1::m1']);
      await sendText('双击重试');
      assert(await waitDone(), '首轮未完成');
      requests.length = 0;
      await js(`(function(){ var b=[].slice.call(document.querySelectorAll('.round-tools button')).filter(function(x){return /重新生成/.test(x.textContent);})[0]; b.click(); b.click(); })()`);
      assert(await waitDone(), '重试未完成');
      assert(requests.length === 1, '请求数=' + requests.length);
      return 'reqs=1';
    });

    await run('双击综合回答只生成一份', async () => {
      await newSession();
      await setChips(['p1::m1']);
      await sendText('双击综合');
      assert(await waitDone(), '未完成');
      await js(`(function(){ var b=[].slice.call(document.querySelectorAll('.round-tools button')).filter(function(x){return x.textContent.indexOf('综合回答')>=0;})[0]; b.click(); b.click(); })()`);
      assert(await waitFor("document.querySelector('.merge-card') && /已合并/.test(document.querySelector('.merge-card .ac-status').textContent)", 6000), '综合未完成');
      const n = await js("document.querySelectorAll('.merge-card').length");
      assert(n === 1, '综合卡片=' + n);
      return 'cards=1';
    });

    await run('快速开关设置页 10 次', async () => {
      for (let i = 0; i < 10; i++) {
        await js("document.querySelector('#btn-settings').click()");
        await js("document.querySelector('#btn-settings-close').click()");
      }
      await sleep(300);
      assert(await js("!document.querySelector('#settings-overlay').classList.contains('hidden') === false"), '设置页未关闭');
      assert(await noFatal(), '出现错误遮罩');
      return 'ok';
    });

    await run('快速切换会话 20 次', async () => {
      await newSession(); await newSession();
      for (let i = 0; i < 20; i++) {
        await js(`(function(){ var it=[].slice.call(document.querySelectorAll('#session-list .session-item')); it[${i % 3}].click(); })()`);
      }
      await sleep(200);
      const t = await js(`({ cur: !!MM.sessions.current(), n: MM.state.sessions.length, fatal: !!document.getElementById('fatal-error') })`);
      assert(t.cur && t.n >= 3 && !t.fatal, JSON.stringify(t));
      return JSON.stringify(t);
    });

    await run('快速切换主题 10 次', async () => {
      for (let i = 0; i < 10; i++) await js("document.querySelector('#btn-theme').click()");
      const t = await js(`({ theme: document.documentElement.getAttribute('data-theme'), ls: localStorage.getItem('mmc-theme') })`);
      assert((t.theme === 'dark' || t.theme === 'light') && t.ls === t.theme, JSON.stringify(t));
      return JSON.stringify(t);
    });

    // ================= B. 异常输入 =================
    await run('空白输入不发送', async () => {
      await newSession();
      await setChips(['p1::m1']);
      requests.length = 0;
      await sendText('   ');
      await sleep(300);
      const t = await js("document.querySelectorAll('.user-msg').length");
      assert(t === 0 && requests.length === 0, 'users=' + t + ' reqs=' + requests.length);
      return 'ok';
    });

    await run('超长/表情/换行输入', async () => {
      await newSession();
      await setChips(['p1::m1']);
      const long = ('第一行😊\n第二行🏷️\n').repeat(1200);
      requests.length = 0;
      await sendText(long);
      assert(await waitDone(15000), '未完成');
      const t = await js(`({ users: document.querySelectorAll('.user-msg').length,
                            bubble: document.querySelector('.user-bubble > div').textContent.length })`);
      const req = lastReq();
      const expect = long.trim().length; // 发送时会 trim 首尾空白
      assert(t.users === 1 && req.body.messages.slice(-1)[0].content.length === expect, JSON.stringify(t));
      return JSON.stringify({ len: expect });
    });

    await run('数字输入框：科学计数法 1e6', async () => {
      await js(`(function(){ MM.settings.open(); document.querySelector('.settings-nav[data-pane="models"]').click(); })()`);
      await sleep(200);
      await js(`(function(){ var row=[].slice.call(document.querySelectorAll('#pane-models .model-row')).filter(function(r){return /本地/.test(r.textContent);})[0]; row.click(); })()`);
      await sleep(200);
      await js(`(function(){ var i=document.querySelectorAll('#model-entries .m-entry')[0].querySelectorAll('.m-row2 input'); i[0].value='1e6'; i[0].dispatchEvent(new Event('change',{bubbles:true})); })()`);
      await sleep(150);
      const v = await js("MM.state.config.providers.find(function(p){return p.id==='p1';}).models[0].contextTokens");
      assert(v === 1000000, 'contextTokens=' + v + '（parseInt 会把 1e6 解析成 1）');
      await js(`(function(){ var i=document.querySelectorAll('#model-entries .m-entry')[0].querySelectorAll('.m-row2 input'); i[0].value='100000'; i[0].dispatchEvent(new Event('change',{bubbles:true})); })()`);
      await js('MM.settings.close()');
      await sleep(250);
      return 'ctx=1000000';
    });

    await run('数字输入框：非法/负数/带逗号', async () => {
      await js(`(function(){ MM.settings.open(); document.querySelector('.settings-nav[data-pane="models"]').click(); })()`);
      await sleep(200);
      const set = async (val, idx) => js(`(function(){ var i=document.querySelectorAll('#model-entries .m-entry')[0].querySelectorAll('.m-row2 input'); i[${idx}].value=${JSON.stringify(val)}; i[${idx}].dispatchEvent(new Event('change',{bubbles:true})); })()`);
      await set('1,000', 0);
      let v = await js("MM.state.config.providers.find(function(p){return p.id==='p1';}).models[0].contextTokens");
      assert(v === undefined, '1,000 => ' + v);
      await set('-5', 0);
      v = await js("MM.state.config.providers.find(function(p){return p.id==='p1';}).models[0].contextTokens");
      assert(v === -5, '-5 => ' + v);
      await set('abc', 1);
      v = await js("MM.state.config.providers.find(function(p){return p.id==='p1';}).models[0].maxTokens");
      assert(v === undefined, 'abc => ' + v);
      await set('4096', 1);
      await set('100000', 0);
      await js('MM.settings.close()');
      await sleep(250);
      return 'ok';
    });

    // ================= C. 流异常 =================
    await run('流被服务端中途断开：显示失败而不是卡住', async () => {
      behavior = { type: 'close' };
      await newSession();
      await setChips(['p1::m1']);
      await sendText('断流测试');
      const ok = await waitFor("!!document.querySelector('.ac-error') && !document.querySelector('#btn-send').classList.contains('stop')", 8000);
      if (!ok) {
        const d = await js(`(function(){ var c=document.querySelector('.answer-card'); return { status:c.querySelector('.ac-status').textContent, body:c.querySelector('.ac-body').textContent.slice(0,60), err:!!document.querySelector('.ac-error') }; })()`);
        throw new Error('未显示错误，实际状态=' + JSON.stringify(d));
      }
      const t = await js(`({ err: document.querySelector('.ac-error').textContent, status: document.querySelector('.ac-status').textContent })`);
      assert(/失败/.test(t.status) && (/,/.test(t.err) || /中断/.test(t.err)), JSON.stringify(t));
      behavior = null;
      return JSON.stringify({ status: t.status });
    });

    await run('SSE 混入垃圾行：忽略并正常完成', async () => {
      behavior = { type: 'garbage' };
      await newSession();
      await setChips(['p1::m1']);
      await sendText('垃圾行测试');
      assert(await waitDone(), '未完成');
      const t = await js("document.querySelector('.ac-body').textContent");
      assert(/^回答-m1-/.test(t), 'content=' + t);
      behavior = null;
      return 'ok';
    });

    await run('SSE 使用 CRLF 行尾', async () => {
      behavior = { type: 'crlf' };
      await newSession();
      await setChips(['p1::m1']);
      await sendText('CRLF测试');
      assert(await waitDone(), '未完成');
      const t = await js("document.querySelector('.ac-body').textContent");
      assert(/^回答-m1-/.test(t), 'content=' + t);
      behavior = null;
      return 'ok';
    });

    await run('超大单条 delta（约 750KB）', async () => {
      behavior = { type: 'huge' };
      await newSession();
      await setChips(['p1::m1']);
      await sendText('超大测试');
      assert(await waitDone(20000), '未完成');
      const t = await js("document.querySelector('.ac-body').textContent.length");
      assert(t === 250000, 'len=' + t);
      behavior = null;
      return 'len=250000';
    });

    await run('服务端不回 usage：不显示 token 徽标', async () => {
      behavior = { type: 'nousage' };
      await newSession();
      await setChips(['p1::m1']);
      await sendText('无用量测试');
      assert(await waitDone(), '未完成');
      const t = await js("!!document.querySelector('.badge.tok')");
      assert(t === false, '出现了 token 徽标');
      behavior = null;
      return 'ok';
    });

    await run('综合回答中停止：回滚并可再次综合', async () => {
      await setSynth('p1::med');
      await newSession();
      await setChips(['p1::m1']);
      await sendText('综合停止测试');
      assert(await waitDone(), '未完成');
      assert(await clickTool('综合回答'), '没有综合按钮');
      assert(await waitFor("document.querySelector('.merge-card') && /生成中/.test(document.querySelector('.merge-card .ac-status').textContent)", 4000), '综合未开始');
      await js("document.querySelector('#btn-send').click()");
      assert(await waitFor("!document.querySelector('#btn-send').classList.contains('stop')", 6000), '停止未复位');
      const t = await js(`({ st: document.querySelector('.merge-card .ac-status').textContent,
                            again: [].slice.call(document.querySelectorAll('.round-tools button')).some(function(x){return x.textContent.indexOf('综合回答')>=0;}) })`);
      assert(/失败/.test(t.st) && t.again === true, JSON.stringify(t));
      await setSynth('frontend');
      return JSON.stringify(t);
    });

    await run('综合回答中切换会话：切回继续并完成', async () => {
      await setSynth('p1::med');
      await newSession(); await renameActiveDeep('合并A');
      await setChips(['p1::m1']);
      await sendText('综合切换测试');
      assert(await waitDone(), '未完成');
      await newSession(); await renameActiveDeep('合并B');
      await switchToDeep('合并A');
      assert(await clickTool('综合回答'), '没有综合按钮');
      await sleep(300);
      await switchToDeep('合并B');
      await switchToDeep('合并A');
      const s1 = await js(`(function(){ var c=document.querySelector('.merge-card'); return { len: c.querySelector('.ac-body').textContent.length, st: c.querySelector('.ac-status').textContent, stop: document.querySelector('#btn-send').classList.contains('stop') }; })()`);
      assert(s1.len > 0 && s1.stop === true, JSON.stringify(s1));
      await sleep(600);
      const s2 = await js("document.querySelector('.merge-card .ac-body').textContent.length");
      assert(s2 > s1.len, '切回后综合不再增长');
      assert(await waitFor(doneExpr, 10000), '综合未完成');
      const st = await js("document.querySelector('.merge-card .ac-status').textContent");
      assert(/完成/.test(st), 'st=' + st);
      await setSynth('frontend');
      return JSON.stringify({ before: s1.len, after: s2 });
    });

    // ================= D. 设置边界 =================
    await run('自定义服务商：空名/HTML 名/删除当前服务商', async () => {
      await js(`(function(){ window.confirm=function(){return true;}; MM.settings.open(); document.querySelector('.settings-nav[data-pane="models"]').click();
        [].slice.call(document.querySelectorAll('#pane-models button')).filter(function(b){return b.textContent.indexOf('添加自定义服务商')>=0;})[0].click(); })()`);
      await sleep(250);
      // 空名回退
      await js(`(function(){ var i=document.querySelector('#pane-models input[placeholder="服务商名称"]'); i.value=''; i.dispatchEvent(new Event('change',{bubbles:true})); })()`);
      let name = await js("MM.state.config.providers.find(function(p){return p.preset===false && p.id!=='p1';}).name");
      assert(name === '自定义服务商', 'name=' + name);
      // HTML 名
      await js(`(function(){ var i=document.querySelector('#pane-models input[placeholder="服务商名称"]'); i.value='<img src=x onerror=alert(1)>'; i.dispatchEvent(new Event('change',{bubbles:true})); })()`);
      await sleep(200);
      const imgs = await js("document.querySelectorAll('#pane-models img, #model-chips img').length");
      assert(imgs === 0, '服务商名 HTML 被执行');
      // 删除当前编辑的服务商
      await js("document.querySelector('.pm-head-ops .btn-danger').click()");
      await sleep(250);
      const t = await js(`({ fatal: !!document.getElementById('fatal-error'),
                           selected: (document.querySelector('#pane-models .pm-head-name')||{}).textContent || '',
                           n: document.querySelectorAll('#pane-models .model-row').length })`);
      assert(!t.fatal && t.selected.length > 0 && t.n >= 1, JSON.stringify(t));
      await js('MM.settings.close()');
      await sleep(250);
      return JSON.stringify(t);
    });

    await run('模型 ID 含引号/空格：芯片与请求正常', async () => {
      await newSession();
      await js(`(function(){ MM.settings.open(); document.querySelector('.settings-nav[data-pane="models"]').click(); })()`);
      await sleep(200);
      await js(`(function(){ var row=[].slice.call(document.querySelectorAll('#pane-models .model-row')).filter(function(r){return /本地/.test(r.textContent);})[0]; row.click(); })()`);
      await sleep(200);
      await js(`(function(){ var i=document.querySelectorAll('#model-entries .m-entry')[0].querySelector('input'); i.value='a"b c'; i.dispatchEvent(new Event('blur')); })()`);
      await sleep(150);
      await js(`[].slice.call(document.querySelectorAll('.pm-head-ops button')).filter(function(b){return b.textContent==='保存';})[0].click()`);
      await js('MM.settings.close()');
      await sleep(300);
      const chip = await js(`[].slice.call(document.querySelectorAll('#model-chips .chip')).some(function(c){return c.getAttribute('data-model-id')==='p1::a"b c';})`);
      assert(chip === true, '未找到特殊 ID 芯片');
      await setChips(['p1::a"b c']);
      requests.length = 0;
      await sendText('特殊ID测试');
      assert(await waitDone(), '未完成');
      const req = lastReq();
      assert(req.body.model === 'a"b c', 'model=' + req.body.model);
      const st = await js("document.querySelector('.ac-status').textContent");
      assert(/✓/.test(st), 'st=' + st);
      // 还原模型 ID
      await js(`(function(){ MM.settings.open(); document.querySelector('.settings-nav[data-pane="models"]').click(); })()`);
      await sleep(200);
      await js(`(function(){ var i=document.querySelectorAll('#model-entries .m-entry')[0].querySelector('input'); i.value='m1'; i.dispatchEvent(new Event('blur')); })()`);
      await js(`[].slice.call(document.querySelectorAll('.pm-head-ops button')).filter(function(b){return b.textContent==='保存';})[0].click()`);
      await js('MM.settings.close()');
      await sleep(250);
      return JSON.stringify({ model: req.body.model });
    });

    await run('全部模型取消勾选：提示而不发请求', async () => {
      await newSession();
      await js(`document.querySelectorAll('#model-chips .chip').forEach(function(c){ c.classList.remove('on'); })`);
      requests.length = 0;
      await sendText('全不选测试');
      await sleep(300);
      const toast = await js("document.querySelector('#toast').textContent");
      assert(/请先.*选择/.test(toast), 'toast=' + toast);
      assert(requests.length === 0, '发出了请求');
      await setChips(['p1::m1']);
      return 'ok';
    });

    await run('空模型 ID 不出现在芯片', async () => {
      const before = await js("document.querySelectorAll('#model-chips .chip').length");
      await js(`(function(){ MM.settings.open(); document.querySelector('.settings-nav[data-pane="models"]').click();
        [].slice.call(document.querySelectorAll('#pane-models button')).filter(function(b){return b.textContent.indexOf('添加模型')>=0;})[0].click(); })()`);
      await sleep(250);
      await js('MM.settings.close()');
      await sleep(300);
      const after = await js("document.querySelectorAll('#model-chips .chip').length");
      assert(after === before, 'before=' + before + ' after=' + after);
      await js(`(function(){ MM.settings.open(); document.querySelector('.settings-nav[data-pane="models"]').click(); })()`);
      await sleep(200);
      await js(`(function(){ var es=document.querySelectorAll('#model-entries .m-entry'); es[es.length-1].querySelector('.m-del').click(); })()`);
      await sleep(200);
      await js('MM.settings.close()');
      await sleep(250);
      return 'ok';
    });

    // ================= E. 导入容错 =================
    async function importJson(obj, file) {
      nextOpen = path.join(DATA, file);
      fs.writeFileSync(nextOpen, typeof obj === 'string' ? obj : JSON.stringify(obj), 'utf8');
      await js(`(function(){ MM.settings.open(); document.querySelector('.settings-nav[data-pane="data"]').click();
        [].slice.call(document.querySelectorAll('#pane-data button')).filter(function(b){return b.textContent.indexOf('导入数据')>=0;})[0].click(); })()`);
      await sleep(700);
    }
    await run('导入容错：空对象/字段缺失', async () => {
      const before = await js("({ n: MM.state.sessions.length, id: MM.state.currentId })");
      await importJson({}, 'bad1.json');
      const t = await js(`({ fatal: !!document.getElementById('fatal-error'), n: MM.state.sessions.length, id: MM.state.currentId,
                           toast: document.querySelector('#toast').textContent })`);
      assert(!t.fatal && t.n === before.n && t.id === before.id && /导入失败/.test(t.toast), JSON.stringify(t));
      await importJson({ config: 1, sessions: [] }, 'bad2.json');
      const t2 = await js("({ fatal: !!document.getElementById('fatal-error'), n: MM.state.sessions.length })");
      assert(!t2.fatal && t2.n === before.n, JSON.stringify(t2));
      await importJson({ config: {}, sessions: { a: 1 } }, 'bad3.json');
      const t3 = await js("({ fatal: !!document.getElementById('fatal-error'), n: MM.state.sessions.length })");
      assert(!t3.fatal && t3.n === before.n, JSON.stringify(t3));
      await js('MM.settings.close()');
      await sleep(250);
      return 'ok';
    });

    // 保存当前磁盘配置：后面几组畸形导入会把配置换掉，结束后用它恢复 p1
    const savedConfig = JSON.parse(fs.readFileSync(path.join(DATA, 'store.json'), 'utf8')).config;
    async function restoreConfig() {
      await importJson({ config: savedConfig, sessions: [{ id: 'back', title: '新会话', createdAt: 1, updatedAt: 1, pinned: false, messages: [] }] }, 'restore.json');
      await js('MM.settings.close()');
      await sleep(250);
    }
    await run('导入容错：sessions 混入非法条目', async () => {
      await importJson({ config: { providers: [] }, sessions: [1, 'x', { id: 1 }, { id: 'p', messages: 'oops' }] }, 'bad4.json');
      const t = await js(`({ fatal: !!document.getElementById('fatal-error'), n: MM.state.sessions.length,
                           msgs: MM.state.sessions.map(function(s){ return Array.isArray(s.messages); }) })`);
      assert(!t.fatal && t.n === 2 && t.msgs.every(Boolean), JSON.stringify(t));
      await js('MM.settings.close()');
      await sleep(250);
      return JSON.stringify(t);
    });

    await run('导入容错：providers 非数组/字段异常', async () => {
      await importJson({ config: { providers: { a: 1 } }, sessions: [] }, 'bad5.json');
      const t = await js(`({ fatal: !!document.getElementById('fatal-error'), arr: Array.isArray(MM.state.config.providers), n: MM.state.config.providers.length })`);
      assert(!t.fatal && t.arr && t.n > 0, JSON.stringify(t));
      await importJson({ config: { providers: [{ id: 'x', models: 'oops' }] }, sessions: [] }, 'bad6.json');
      const t2 = await js(`({ fatal: !!document.getElementById('fatal-error'), arr: Array.isArray(MM.state.config.providers.find(function(p){return p.id==='x';}).models) })`);
      assert(!t2.fatal && t2.arr, JSON.stringify(t2));
      await restoreConfig();
      const back = await js("!!MM.state.config.providers.find(function(p){return p.id==='p1';})");
      assert(back === true, '恢复配置后 p1 丢失');
      return 'ok';
    });

    await run('流式中导入：旧请求立即中止，可马上发送', async () => {
      await newSession();
      await setChips(['p1::slow']);
      await sendText('流式中导入');
      assert(await waitFor("(document.querySelector('.ac-body') && document.querySelector('.ac-body').textContent.length > 2)", 6000), '没有开始输出');
      const disk = JSON.parse(fs.readFileSync(path.join(DATA, 'store.json'), 'utf8'));
      await importJson({ config: disk.config, sessions: [{ id: 'imp', title: '导入流式中', createdAt: 9, updatedAt: 9, pinned: false, messages: [] }] }, 'imp-stream.json');
      const t = await js(`({ title: document.querySelector('#session-title').textContent,
                           stop: document.querySelector('#btn-send').classList.contains('stop'),
                           fatal: !!document.getElementById('fatal-error') })`);
      assert(t.title === '导入流式中' && t.stop === false && !t.fatal, JSON.stringify(t));
      await js('MM.settings.close()');
      await sleep(250);
      requests.length = 0;
      await setChips(['p1::m1']);
      await sendText('导入后发送');
      assert(await waitDone(), '导入后发送失败');
      return 'ok';
    });

    await run('流式中清空会话：旧请求立即中止', async () => {
      await newSession();
      await setChips(['p1::slow']);
      await sendText('流式中清空');
      assert(await waitFor("(document.querySelector('.ac-body') && document.querySelector('.ac-body').textContent.length > 2)", 6000), '没有开始输出');
      await js(`(function(){
        window.confirm=function(){return true;};
        MM.settings.open();
        document.querySelector('.settings-nav[data-pane="data"]').click();
        [].slice.call(document.querySelectorAll('#pane-data button')).filter(function(b){return b.textContent.indexOf('清空所有会话')>=0;})[0].click();
      })()`);
      await sleep(600);
      const t = await js(`({ title: document.querySelector('#session-title').textContent,
                           stop: document.querySelector('#btn-send').classList.contains('stop'),
                           n: MM.state.sessions.length, fatal: !!document.getElementById('fatal-error') })`);
      assert(t.n === 1 && t.stop === false && !t.fatal && t.title === '新会话', JSON.stringify(t));
      await js('MM.settings.close()');
      await sleep(250);
      return 'ok';
    });

    // ================= F. 猴子测试 =================
    await run('猴子测试：150 次随机点击无崩溃', async () => {
      let seed = 42;
      const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
      const actions = [
        "document.querySelector('#btn-theme').click()",
        "document.querySelector('#btn-new-chat').click()",
        "document.querySelector('#btn-settings').click()",
        "document.querySelector('#btn-settings-close').click()",
        "(function(){var n=[].slice.call(document.querySelectorAll('.settings-nav')); n[Math.floor(Math.random()*n.length)].click();})()",
        "(function(){var c=[].slice.call(document.querySelectorAll('#model-chips .chip')); if(c.length) c[Math.floor(Math.random()*c.length)].click();})()",
        "(function(){var it=[].slice.call(document.querySelectorAll('#session-list .session-item')); if(it.length) it[Math.floor(Math.random()*it.length)].click();})()",
        "(function(){var b=[].slice.call(document.querySelectorAll('.round-tools button')); if(b.length) b[Math.floor(Math.random()*b.length)].click();})()",
        "(function(){var h=[].slice.call(document.querySelectorAll('.copy-hint')); if(h.length) h[Math.floor(Math.random()*h.length)].click();})()",
        "document.querySelector('#btn-session-prompt').click()",
        "(function(){var b=document.querySelector('#btn-sp-close'); if(b) b.click();})()",
        "(function(){var b=document.querySelector('#btn-sp-clear'); if(b) b.click();})()",
        "document.querySelector('#tgl-search-wrap').click()",
        "document.querySelector('#tgl-auto-wrap').click()",
        "document.querySelector('#btn-scroll-bottom').click()"
      ];
      for (let i = 0; i < 150; i++) {
        const a = actions[Math.floor(rnd() * actions.length)];
        try { await js(a); } catch (e) { /* 点击目标可能已消失，忽略 */ }
        if (i % 25 === 24) assert(await noFatal(), '第 ' + (i + 1) + ' 步后出现错误遮罩');
        await sleep(25);
      }
      await js('if (MM.chat.stopAll) MM.chat.stopAll();');
      await waitFor("!document.querySelector('#btn-send').classList.contains('stop')", 4000);
      await sleep(400);
      const t = await js(`({ fatal: !!document.getElementById('fatal-error'), alive: typeof MM === 'object', n: MM.state.sessions.length })`);
      assert(t.fatal === false && t.alive === true && t.n >= 1, JSON.stringify(t));
      assert(consoleErrors.length === 0 && !procGone, 'console=' + JSON.stringify(consoleErrors) + ' gone=' + JSON.stringify(procGone));
      return JSON.stringify({ steps: 150, sessions: t.n, consoleErrors: consoleErrors.length });
    });

    // ================= G/H. 汇总检查 =================
    await run('全程无渲染层控制台错误、进程未崩溃', async () => {
      assert(consoleErrors.length === 0 && !procGone, JSON.stringify({ consoleErrors, procGone }));
      return 'errors=0';
    });

    await run('最终落盘：会话合法、密钥加密、无损坏备份', async () => {
      const disk = JSON.parse(fs.readFileSync(path.join(DATA, 'store.json'), 'utf8'));
      assert(Array.isArray(disk.sessions) && disk.sessions.every(s => s && typeof s === 'object' && Array.isArray(s.messages)), 'sessions 非法');
      const p1 = disk.config.providers.find(p => p.id === 'p1');
      assert(p1 && p1.apiKey && p1.apiKey.enc, '密钥未加密');
      const corrupts = fs.readdirSync(DATA).filter(f => f.indexOf('.corrupt-') >= 0);
      assert(corrupts.length === 0, JSON.stringify(corrupts));
      return JSON.stringify({ sessions: disk.sessions.length, enc: true });
    });

    const pass = rows.filter(r => r.pass).length;
    const fail = rows.filter(r => !r.pass).length;
    console.log('---SUMMARY---');
    console.log(JSON.stringify({ pass, fail, consoleErrors, procGone, rows }, null, 1));
    w.destroy();
    server.close();
    app.exit(fail ? 1 : 0);
  });
});
