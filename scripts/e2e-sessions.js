'use strict';
// 端到端会话/设置/安全补充测试：真实 main.js + 真实渲染层 + 本地 mock 服务。
// 覆盖：会话改名/置顶/删除、跨会话流式、删除在途会话、主题、模型列表/下拉/测试连接、
//       清空会话、错误与标题 XSS、非法会话导入、原型污染、版本上限。
const { app, BrowserWindow, dialog, shell } = require('electron');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'mmc-e2e2-'));
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
const server = http.createServer(async (req, res) => {
  let raw = '';
  req.on('data', c => { raw += c; });
  req.on('end', async () => {
    if (req.url.indexOf('/models') >= 0) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [
        { id: 'm1', context_length: 100000, architecture: { input_modalities: ['text', 'image'] } },
        { id: 'm2', context_length: 50000 }
      ] }));
      return;
    }
    let body = {};
    try { body = JSON.parse(raw || '{}'); } catch (e) { /* ignore */ }
    requests.push({ url: req.url, body, headers: req.headers });
    const model = String(body.model || '');
    const n = counters[model] = (counters[model] || 0) + 1;
    if (body.stream === false) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: '测试连接成功' } }] }));
      return;
    }
    if (model === 'err') {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: '<img src=x onerror=alert(1)>' } }));
      return;
    }
    const slow = model === 'slow';
    const text = slow ? '慢速输出'.repeat(80) : ('回答-' + model + '-' + n);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    let i = 0;
    const timer = setInterval(() => {
      if (res.destroyed) { clearInterval(timer); return; }
      if (i < text.length) {
        res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: text[i++] } }] }) + '\n\n');
        return;
      }
      clearInterval(timer);
      res.write('data: ' + JSON.stringify({ choices: [], usage: { prompt_tokens: 4, completion_tokens: 2 } }) + '\n\n');
      res.end('data: [DONE]\n\n');
    }, slow ? 60 : 5);
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
        { modelId: 'err', name: '错误', enabled: true, contextTokens: 100000, maxTokens: 4096 },
        { modelId: 'fast', name: '快速', enabled: true, contextTokens: 100000, maxTokens: 4096 }
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
    async function waitFor(expr, timeout) {
      const t0 = Date.now();
      while (Date.now() - t0 < (timeout || 8000)) {
        if (await js(expr)) return true;
        await sleep(100);
      }
      return false;
    }
    const itemExpr = title => `[].slice.call(document.querySelectorAll('#session-list .session-item')).filter(function(x){ var t=x.querySelector('.s-title'); return t && t.textContent === ${JSON.stringify(title)}; })[0]`;
    async function renameActive(newTitle) {
      await js(`(function(){
        var it=document.querySelector('#session-list .session-item.active');
        if(!it) return false;
        var b=[].slice.call(it.querySelectorAll('.s-actions button')).filter(function(x){return x.textContent==='改名';})[0];
        if(!b) return false;
        b.click();
        var inp=document.querySelector('#session-list input');
        if(!inp) return false;
        inp.value=${JSON.stringify(newTitle)};
        inp.dispatchEvent(new KeyboardEvent('keydown', { key:'Enter', bubbles:true }));
        return true;
      })()`);
      await sleep(250);
    }
    async function newNamed(title) {
      await js("document.querySelector('#btn-new-chat').click()");
      await sleep(150);
      await renameActive(title);
    }
    async function switchTo(title) {
      await js(`(function(){ var it=${itemExpr(title)}; if(it) it.click(); })()`);
      await sleep(200);
    }
    async function setChips(ids) {
      await js(`(function(){
        var want=${JSON.stringify(ids)};
        document.querySelectorAll('#model-chips .chip').forEach(function(c){ c.classList.toggle('on', want.indexOf(c.getAttribute('data-model-id'))>=0); });
      })()`);
    }
    async function sendText(text) {
      await js(`(function(){
        var i=document.querySelector('#input');
        i.value=${JSON.stringify(text)};
        i.dispatchEvent(new Event('input', { bubbles:true }));
        document.querySelector('#btn-send').click();
      })()`);
    }
    const doneExpr = "document.querySelectorAll('.answer-card').length > 0 && !document.querySelector('#btn-send').classList.contains('stop')";

    // ---------- 1. 会话改名 / 置顶 ----------
    await run('会话：新建、改名、置顶', async () => {
      await newNamed('会话A');
      await newNamed('会话B');
      const t = await js(`[].slice.call(document.querySelectorAll('#session-list .s-title')).map(function(x){return x.textContent;})`);
      assert(t.indexOf('会话A') >= 0 && t.indexOf('会话B') >= 0, JSON.stringify(t));
      await js(`(function(){ var it=${itemExpr('会话A')}; [].slice.call(it.querySelectorAll('.s-actions button')).filter(function(x){return x.textContent==='置顶';})[0].click(); })()`);
      await sleep(250);
      const p = await js(`(function(){ var it=document.querySelector('#session-list .session-item'); return { first: it.querySelector('.s-title').textContent, pin: !!it.querySelector('.pin-dot') }; })()`);
      assert(p.first === '会话A' && p.pin === true, JSON.stringify(p));
      return JSON.stringify(p);
    });

    // ---------- 2. 跨会话流式 ----------
    await run('跨会话流式：切走再切回仍继续输出', async () => {
      await switchTo('会话A');
      await setChips(['p1::slow']);
      await sendText('跨会话流式测试');
      assert(await waitFor("(document.querySelector('.ac-body') && document.querySelector('.ac-body').textContent.length > 2)", 6000), '没有开始输出');
      await switchTo('会话B');
      const b = await js(`({ stop: document.querySelector('#btn-send').classList.contains('stop'), ro: document.querySelector('#input').readOnly })`);
      assert(b.stop === false && b.ro === false, JSON.stringify(b));
      await switchTo('会话A');
      const s1 = await js(`(function(){ var c=document.querySelector('.answer-card'); return { len:c.querySelector('.ac-body').textContent.length, status:c.querySelector('.ac-status').textContent, stop:document.querySelector('#btn-send').classList.contains('stop') }; })()`);
      assert(/生成中/.test(s1.status) && s1.stop === true, JSON.stringify(s1));
      await sleep(700);
      const s2 = await js("document.querySelector('.ac-body').textContent.length");
      assert(s2 > s1.len, '切回后内容不再增长: ' + s1.len + ' -> ' + s2);
      await js("document.querySelector('#btn-send').click()");
      assert(await waitFor("!document.querySelector('#btn-send').classList.contains('stop')", 6000), '停止未复位');
      return JSON.stringify({ before: s1.len, after: s2 });
    });

    // ---------- 3. 删除在途会话 ----------
    await run('删除正在生成的会话：中止请求且不崩溃', async () => {
      await newNamed('会话C');
      await setChips(['p1::slow']);
      await sendText('流式中删除');
      assert(await waitFor("(document.querySelector('.ac-body') && document.querySelector('.ac-body').textContent.length > 2)", 6000), '没有开始输出');
      await js(`(function(){
        var it=${itemExpr('会话C')};
        [].slice.call(it.querySelectorAll('.s-actions button')).filter(function(x){return x.textContent==='删除';})[0].click();
      })()`);
      await sleep(200);
      // 删除确认走应用内确认框（U.confirm），点确认
      await js("(function(){ var ov=document.getElementById('confirm-overlay'); var ok=ov&&ov.querySelector('.cf-ok'); if(ok&&ov.classList.contains('hidden')===false) ok.click(); })()");
      await sleep(500);
      const t = await js(`({ fatal: !!document.getElementById('fatal-error'),
                           exists: [].slice.call(document.querySelectorAll('#session-list .s-title')).some(function(x){return x.textContent==='会话C';}),
                           stop: document.querySelector('#btn-send').classList.contains('stop') })`);
      assert(!t.fatal && !t.exists && t.stop === false, JSON.stringify(t));
      return JSON.stringify(t);
    });

    // ---------- 4. 主题切换 ----------
    await run('主题切换与 localStorage', async () => {
      const before = await js("document.documentElement.getAttribute('data-theme')");
      await js("document.querySelector('#btn-theme').click()");
      await sleep(100);
      const dark = await js("document.documentElement.getAttribute('data-theme')");
      const ls = await js("localStorage.getItem('mmc-theme')");
      assert(dark === 'dark' && ls === 'dark', JSON.stringify({ dark: dark, ls: ls }));
      await js("document.querySelector('#btn-theme').click()");
      await sleep(100);
      const light = await js("document.documentElement.getAttribute('data-theme')");
      assert(light === 'light', 'light=' + light);
      return JSON.stringify({ before: before, dark: dark, light: light });
    });

    // ---------- 5. 模型列表 / 下拉 / 测试连接 ----------
    await run('设置：获取模型列表、下拉选择、测试连接', async () => {
      await js(`(function(){ MM.settings.open(); document.querySelector('.settings-nav[data-pane="models"]').click(); })()`);
      await sleep(200);
      await js(`(function(){ var row=[].slice.call(document.querySelectorAll('#pane-models .model-row')).filter(function(r){return /本地/.test(r.textContent);})[0]; row.click(); })()`);
      await sleep(200);
      await js(`[].slice.call(document.querySelectorAll('#pane-models .p-card button')).filter(function(b){return b.textContent.indexOf('获取模型列表')>=0;})[0].click()`);
      assert(await waitFor("/获取到 2 个模型/.test(document.querySelector('#toast').textContent)", 6000), '未获取到模型列表');
      // 输入过滤词 'm'（会打开下拉并匹配 m1/m2）；直接点 ▾ 会因当前值 m1 只显示 1 条
      await js(`(function(){ var inp=document.querySelectorAll('#model-entries .m-entry')[0].querySelector('input'); inp.value='m'; inp.dispatchEvent(new Event('input',{bubbles:true})); })()`);
      await sleep(150);
      const dd = await js(`({ n: document.querySelectorAll('#model-entries .dd-item').length, open: !document.querySelector('#model-entries .dropdown-panel').classList.contains('hidden') })`);
      assert(dd.n === 2 && dd.open === true, JSON.stringify(dd));
      await js(`document.querySelectorAll('#model-entries .dd-item')[1].click()`);
      await sleep(200);
      const mid = await js("document.querySelectorAll('#model-entries .m-entry')[0].querySelector('input').value");
      assert(mid === 'm2', 'mid=' + mid);
      requests.length = 0;
      await js(`[].slice.call(document.querySelectorAll('.pm-head-ops button')).filter(function(b){return b.textContent==='测试连接';})[0].click()`);
      assert(await waitFor("/连接成功/.test((document.querySelector('#pane-models .test-result')||{}).textContent||'')", 8000), '测试连接未成功');
      const testReq = requests.filter(r => r.body && r.body.stream === false)[0];
      assert(!!testReq && testReq.body.model === 'm2', JSON.stringify(testReq && testReq.body));
      await js('MM.settings.close()');
      await sleep(300);
      const dup = await js("[].slice.call(document.querySelectorAll('#model-chips .chip')).filter(function(c){return c.getAttribute('data-model-id')==='p1::m2';}).length");
      assert(dup === 1, '重复模型 ID 产生了 ' + dup + ' 个芯片');
      return JSON.stringify({ mid: mid, test: testReq.body.model, chipsForM2: dup });
    });

    // ---------- 6. 清空所有会话 ----------
    await run('清空所有会话：保留模型配置', async () => {
      await js(`(function(){ MM.settings.open(); document.querySelector('.settings-nav[data-pane="data"]').click(); })()`);
      await sleep(200);
      await js(`[].slice.call(document.querySelectorAll('#pane-data button')).filter(function(b){return b.textContent.indexOf('清空所有会话')>=0;})[0].click()`);
      await sleep(200);
      // 清空确认走应用内确认框（U.confirm），点确认
      await js("(function(){ var ov=document.getElementById('confirm-overlay'); var ok=ov&&ov.querySelector('.cf-ok'); if(ok&&ov.classList.contains('hidden')===false) ok.click(); })()");
      await sleep(400);
      const t = await js(`({ n: MM.state.sessions.length, title: document.querySelector('#session-title').textContent,
                           empty: !!document.querySelector('#messages .empty-state'),
                           p1: !!MM.state.config.providers.find(function(p){return p.id==='p1';}) })`);
      assert(t.n === 1 && t.empty && t.p1, JSON.stringify(t));
      await js('MM.settings.close()');
      await sleep(250);
      return JSON.stringify(t);
    });

    // ---------- 7. 错误信息 / 标题 XSS ----------
    await run('错误信息与标题不执行 HTML', async () => {
      await js("document.querySelector('#btn-new-chat').click()");
      await sleep(150);
      await setChips(['p1::err']);
      await sendText('错误XSS');
      assert(await waitFor("!!document.querySelector('.ac-error') && !document.querySelector('#btn-send').classList.contains('stop')", 6000), '未显示错误');
      const e = await js(`(function(){ var c=document.querySelector('.ac-error'); return { img:c.querySelectorAll('img').length, text:c.textContent }; })()`);
      assert(e.img === 0 && e.text.indexOf('<img') >= 0, JSON.stringify(e));
      await js("document.querySelector('#btn-new-chat').click()");
      await sleep(150);
      await setChips(['p1::fast']);
      await sendText('<img src=x onerror=alert(1)> 标题测试');
      assert(await waitFor(doneExpr, 8000), '未完成');
      const t = await js(`({ imgs: document.querySelectorAll('#messages img, #session-list img, #session-title img').length,
                           title: document.querySelector('#session-title').textContent })`);
      assert(t.imgs === 0 && t.title.indexOf('<img') >= 0, JSON.stringify(t));
      return JSON.stringify({ errImg: e.img, titleImgs: t.imgs });
    });

    // ---------- 8. 导入含非法会话条目 ----------
    await run('导入含 null 会话：主进程过滤，不崩溃', async () => {
      const disk = JSON.parse(fs.readFileSync(path.join(DATA, 'store.json'), 'utf8'));
      nextOpen = path.join(DATA, 'import-bad.json');
      fs.writeFileSync(nextOpen, JSON.stringify({
        config: disk.config,
        sessions: [null, { id: 'ok', title: '正常会话', createdAt: 5, updatedAt: 5, pinned: false, messages: [] }]
      }), 'utf8');
      await js(`(function(){ MM.settings.open(); document.querySelector('.settings-nav[data-pane="data"]').click(); })()`);
      await sleep(200);
      await js(`[].slice.call(document.querySelectorAll('#pane-data button')).filter(function(b){return b.textContent.indexOf('导入数据')>=0;})[0].click()`);
      await sleep(1000);
      const t = await js(`({ fatal: !!document.getElementById('fatal-error'), n: MM.state.sessions.length,
                           title: document.querySelector('#session-title').textContent })`);
      assert(!t.fatal && t.n === 1 && t.title === '正常会话', JSON.stringify(t));
      await js('MM.settings.close()');
      await sleep(250);
      return JSON.stringify(t);
    });

    // ---------- 9. 原型污染 ----------
    await run('导入配置不污染 Object.prototype', async () => {
      const t = await js(`(function(){
        MM.normalizeConfig(JSON.parse('{"__proto__":{"polluted":1},"providers":[]}'));
        MM.normalizeConfig(JSON.parse('{"providers":[],"__proto__":{"polluted":2}}'));
        return { a: ({}).polluted, b: Object.prototype.polluted };
      })()`);
      assert(t.a === undefined && t.b === undefined, JSON.stringify(t));
      return JSON.stringify(t);
    });

    // ---------- 10. 版本上限 10 ----------
    await run('版本上限：连续重试只保留最近 10 版', async () => {
      await js("document.querySelector('#btn-new-chat').click()");
      await sleep(150);
      await setChips(['p1::fast']);
      requests.length = 0;
      await sendText('版本上限测试');
      assert(await waitFor(doneExpr, 8000), '首轮未完成');
      for (let i = 0; i < 10; i++) {
        assert(await js(`(function(){
          var b=[].slice.call(document.querySelectorAll('.round-tools button')).filter(function(x){return /重新生成/.test(x.textContent);})[0];
          if(b) b.click();
          return !!b;
        })()`), '没有重新生成按钮');
        assert(await waitFor(doneExpr, 8000), '第 ' + (i + 1) + ' 次重试未完成');
      }
      const t = await js(`(function(){
        var s=MM.state.sessions.find(function(x){return x.id===MM.state.currentId;});
        var am=s.messages.find(function(m){return m.role==='assistant';});
        var v=document.querySelector('.ver-label');
        return { n: am.versions.length, ver: v?v.textContent:'' };
      })()`);
      assert(t.n === 10 && t.ver.indexOf('版本 10/10') >= 0, JSON.stringify(t));
      assert(requests.length === 11, '请求数=' + requests.length);
      return JSON.stringify({ versions: t.n, reqs: requests.length, ver: t.ver });
    });

    // ---------- 11. 最终落盘 ----------
    await run('最终落盘：无 null 会话、密钥加密', async () => {
      const disk = JSON.parse(fs.readFileSync(path.join(DATA, 'store.json'), 'utf8'));
      assert(Array.isArray(disk.sessions) && disk.sessions.every(s => s && typeof s === 'object'), 'sessions 含非法条目');
      const p1 = disk.config.providers.find(p => p.id === 'p1');
      assert(p1 && p1.apiKey && p1.apiKey.enc, '密钥未加密');
      const corrupts = fs.readdirSync(DATA).filter(f => f.indexOf('.corrupt-') >= 0);
      assert(corrupts.length === 0, JSON.stringify(corrupts));
      return JSON.stringify({ sessions: disk.sessions.length, enc: !!p1.apiKey.enc });
    });

    const pass = rows.filter(r => r.pass).length;
    const fail = rows.filter(r => !r.pass).length;
    console.log('---SUMMARY---');
    console.log(JSON.stringify({ pass, fail, rows }, null, 1));
    w.destroy();
    server.close();
    app.exit(fail ? 1 : 0);
  });
});
