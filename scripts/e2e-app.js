'use strict';
// 端到端应用测试：真实 main.js + 真实渲染层 + 本地 mock 模型服务。
// 覆盖：多模型流式、停止、重试/版本、前后端综合、会话提示词、编辑重发、
//       401/非 SSE/Anthropic/原生搜索、自动综合、设置保存、导入导出、迁移、安全边界。
const { app, BrowserWindow, dialog, shell } = require('electron');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'mmc-e2e-'));
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
function assert(cond, msg) { if (!cond) throw new Error(msg); }

// ---------------- mock 模型服务 ----------------
const requests = [];
const counters = {};
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
    requests.push({ url: req.url, body: body, headers: req.headers });
    const model = String(body.model || '');
    const n = counters[model] = (counters[model] || 0) + 1;

    if (req.url.indexOf('/anthropic/') >= 0) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":9,"output_tokens":1}}}\n\n');
      const text = '回答-anth-' + n;
      for (const ch of text) {
        if (res.destroyed) return;
        res.write('event: content_block_delta\ndata: ' + JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: ch } }) + '\n\n');
        await sleep(5);
      }
      res.write('event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":12}}\n\n');
      res.end();
      return;
    }
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
    const text = slow ? '慢速输出'.repeat(60) : ('回答-' + model + '-' + n);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    let i = 0;
    const timer = setInterval(() => {
      if (res.destroyed) { clearInterval(timer); return; }
      if (i < text.length) {
        res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: text[i++] } }] }) + '\n\n');
        return;
      }
      clearInterval(timer);
      res.write('data: ' + JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } }) + '\n\n');
      res.end('data: [DONE]\n\n');
    }, slow ? 60 : 5);
    res.on('close', () => clearInterval(timer));
  });
});

// ---------------- 对话框 / 外部打开 打桩 ----------------
let nextSave = '';
let nextOpen = '';
const opened = [];
dialog.showSaveDialog = async () => ({ canceled: false, filePath: nextSave });
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [nextOpen] });
shell.openExternal = async url => { opened.push(url); };

// 联网搜索打桩：只在本轮测试内返回固定来源
const searchMod = require(path.join(ROOT, 'src', 'main', 'search'));
const originalWebSearch = searchMod.webSearch;
let mockSearchResults = null;
searchMod.webSearch = async (cfg, query, count) =>
  (mockSearchResults && mockSearchResults.length ? mockSearchResults : originalWebSearch(cfg, query, count));

function baseConfig(port) {
  return {
    providers: [
      {
        id: 'p1', name: '本地OpenAI', provider: 'custom', apiFormat: 'openai',
        baseUrl: 'http://127.0.0.1:' + port + '/v1', apiKey: 'k1', fullUrl: false, preset: false,
        models: [
          { modelId: 'm1', name: '模型一', enabled: true, contextTokens: 100000, maxTokens: 4096 },
          { modelId: 'm2', name: '模型二', enabled: true, contextTokens: 100000, maxTokens: 4096 },
          { modelId: 'slow', name: '慢速', enabled: true, contextTokens: 100000, maxTokens: 4096 },
          { modelId: 'err', name: '错误', enabled: true, contextTokens: 100000, maxTokens: 4096 },
          { modelId: 'json', name: '非流式', enabled: true, contextTokens: 100000, maxTokens: 4096 }
        ]
      },
      {
        id: 'p2', name: '本地Anthropic', provider: 'custom', apiFormat: 'anthropic',
        baseUrl: 'http://127.0.0.1:' + port + '/anthropic', apiKey: 'k2', fullUrl: false, preset: false,
        models: [{ modelId: 'anth', name: 'Anthropic模型', enabled: true, contextTokens: 100000, maxTokens: 4096 }]
      },
      {
        id: 'p3', name: '智谱兼容', provider: 'zhipu', apiFormat: 'openai',
        baseUrl: 'http://127.0.0.1:' + port + '/v1', apiKey: 'k3', fullUrl: false, preset: false,
        models: [{ modelId: 'z1', name: '智谱模型', enabled: true, contextTokens: 100000, maxTokens: 4096 }]
      }
    ],
    search: { provider: 'none' },
    synthesis: { synthSource: 'frontend', autoMerge: false },
    systemPrompt: '全局提示词SYS'
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
    async function newSession() {
      await js("document.querySelector('#btn-new-chat').click()");
      await sleep(150);
      return js('MM.state.currentId');
    }
    async function setChips(ids) {
      await js(`(function(){
        var want = ${JSON.stringify(ids)};
        document.querySelectorAll('#model-chips .chip').forEach(function(c){
          c.classList.toggle('on', want.indexOf(c.getAttribute('data-model-id')) >= 0);
        });
      })()`);
    }
    async function sendText(text) {
      await js(`(function(){
        var i = document.querySelector('#input');
        i.value = ${JSON.stringify(text)};
        i.dispatchEvent(new Event('input', { bubbles: true }));
        document.querySelector('#btn-send').click();
      })()`);
    }
    const doneExpr = "document.querySelectorAll('.answer-card').length > 0 && !document.querySelector('#btn-send').classList.contains('stop')";
    async function waitDone(t) { return waitFor(doneExpr, t || 10000); }
    async function clickTool(label) {
      return js(`(function(){
        var b = [].slice.call(document.querySelectorAll('.round-tools button')).filter(function(x){ return x.textContent.indexOf(${JSON.stringify(label)}) >= 0; })[0];
        if (b) b.click();
        return !!b;
      })()`);
    }
    function lastReq(pred) {
      for (let i = requests.length - 1; i >= 0; i--) if (!pred || pred(requests[i])) return requests[i];
      return null;
    }

    // ---------- 1. 启动 ----------
    await run('启动：无错误遮罩、模型芯片齐全、渲染层无密钥', async () => {
      const t = await js(`({
        fatal: !!document.getElementById('fatal-error'),
        chipIds: [].slice.call(document.querySelectorAll('#model-chips .chip')).map(function(c){ return c.getAttribute('data-model-id'); }),
        keys: MM.state.config.providers.some(function(p){ return 'apiKey' in p; }),
        title: document.querySelector('#session-title').textContent
      })`);
      const need = ['p1::m1','p1::m2','p1::slow','p1::err','p1::json','p2::anth','p3::z1'];
      const missing = need.filter(id => t.chipIds.indexOf(id) < 0);
      assert(!t.fatal && t.chipIds.length >= 7 && missing.length === 0 && !t.keys && t.title === '新会话', JSON.stringify(t) + ' missing=' + missing.join(','));
      return JSON.stringify({ chips: t.chipIds.length, keys: t.keys });
    });

    // ---------- 2. 多模型流式 ----------
    await run('多模型流式：内容/状态/用量/请求体/标题', async () => {
      await newSession();
      await setChips(['p1::m1', 'p1::m2']);
      requests.length = 0;
      await sendText('多模型测试');
      assert(await waitDone(), '未完成');
      const t = await js(`(function(){
        var cards = [].slice.call(document.querySelectorAll('.answer-card'));
        return { texts: cards.map(function(c){ return c.querySelector('.ac-body').textContent; }),
                 status: cards.map(function(c){ return c.querySelector('.ac-status').textContent; }),
                 tok: cards.filter(function(c){ return !!c.querySelector('.badge.tok'); }).length,
                 title: document.querySelector('#session-title').textContent,
                 users: document.querySelectorAll('.user-msg').length };
      })()`);
      assert(t.texts.length === 2 && /回答-m1-/.test(t.texts[0]) && /回答-m2-/.test(t.texts[1]), JSON.stringify(t));
      assert(/✓/.test(t.status[0]) && /✓/.test(t.status[1]) && t.tok === 2, JSON.stringify(t));
      assert(t.title === '多模型测试' && t.users === 1, JSON.stringify(t));
      assert(requests.length === 2, '请求数=' + requests.length);
      const body = requests[0].body;
      assert(body.messages[0].role === 'system' && body.messages[0].content === '全局提示词SYS', JSON.stringify(body.messages[0]));
      assert(body.stream === true && body.max_tokens === 4096 && !('max_completion_tokens' in body), JSON.stringify(body));
      assert(!('stream_options' in body), '自定义端点不应带 stream_options');
      return JSON.stringify({ texts: t.texts, tok: t.tok });
    });

    // ---------- 3. 停止 ----------
    await run('停止生成：保留半截内容并复位按钮', async () => {
      await newSession();
      await setChips(['p1::slow']);
      requests.length = 0;
      await sendText('慢速停止测试');
      assert(await waitFor("(document.querySelector('.ac-body') && document.querySelector('.ac-body').textContent.length > 2)", 6000), '没有开始输出');
      await js("document.querySelector('#btn-send').click()");
      assert(await waitFor("!document.querySelector('#btn-send').classList.contains('stop')", 6000), '按钮未复位');
      const t = await js(`(function(){ var c=document.querySelector('.answer-card'); return { status:c.querySelector('.ac-status').textContent, text:c.querySelector('.ac-body').textContent }; })()`);
      assert(/已停止/.test(t.status) && t.text.length > 0, JSON.stringify(t));
      assert(requests.length === 1, '请求数=' + requests.length);
      return JSON.stringify({ status: t.status, len: t.text.length });
    });

    // ---------- 4. 重试 + 版本 ----------
    await run('重新生成/版本切换', async () => {
      await newSession();
      await setChips(['p1::m1']);
      requests.length = 0;
      await sendText('重试测试');
      assert(await waitDone(), '首轮未完成');
      const first = await js("document.querySelector('.ac-body').textContent");
      assert(await clickTool('重新生成'), '没有重新生成按钮');
      assert(await waitDone(), '重试未完成');
      const t = await js(`(function(){
        var c=document.querySelector('.answer-card');
        var v=document.querySelector('.ver-label');
        return { text:c.querySelector('.ac-body').textContent, ver:v?v.textContent:'' };
      })()`);
      assert(requests.length === 2, '请求数=' + requests.length);
      assert(t.ver.indexOf('版本 2/2') >= 0, '版本=' + t.ver);
      assert(t.text !== first, '两版内容相同');
      await js(`(function(){ var b=[].slice.call(document.querySelectorAll('.round-tools button')).filter(function(x){return x.title==='上一版本' && !x.disabled;})[0]; if(b) b.click(); })()`);
      const prev = await js("document.querySelector('.ac-body').textContent");
      assert(prev === first, '回到上一版内容不一致');
      await js(`(function(){ var b=[].slice.call(document.querySelectorAll('.round-tools button')).filter(function(x){return x.title==='下一版本' && !x.disabled;})[0]; if(b) b.click(); })()`);
      return JSON.stringify({ ver: t.ver, first: first, second: t.text });
    });

    // ---------- 5. 前端综合 ----------
    await run('前端综合回答', async () => {
      assert(await clickTool('综合回答'), '没有综合回答按钮');
      assert(await waitFor("document.querySelector('.merge-card') && /已合并/.test(document.querySelector('.merge-card .ac-status').textContent)", 6000), '综合卡片未完成');
      const t = await js(`(function(){
        var c=document.querySelector('.merge-card');
        return { text:c.querySelector('.ac-body').textContent,
                 li: !!c.querySelector('.ac-body ol li'),
                 hasBtn: [].slice.call(document.querySelectorAll('.round-tools button')).some(function(x){return x.textContent.indexOf('综合回答')>=0;}) };
      })()`);
      assert(t.li && /回答-m1-/.test(t.text) && !t.hasBtn, JSON.stringify(t));
      return JSON.stringify({ text: t.text.slice(0, 40), hasBtn: t.hasBtn });
    });

    // ---------- 6. 模型综合 + 系统提示词 ----------
    await run('模型综合：请求带系统提示词和原始问题', async () => {
      await js(`(function(){
        MM.settings.open();
        document.querySelector('.settings-nav[data-pane="synth"]').click();
        var s=document.querySelector('#y-source');
        s.value='p1::m1';
        [].slice.call(document.querySelectorAll('#pane-synth button')).filter(function(b){return b.textContent==='保存';})[0].click();
        MM.settings.close();
      })()`);
      await sleep(300);
      await newSession();
      await setChips(['p1::m1', 'p1::m2']);
      requests.length = 0;
      await sendText('综合模型测试');
      assert(await waitDone(), '回答未完成');
      assert(await clickTool('综合回答'), '没有综合回答按钮');
      assert(await waitFor("document.querySelector('.merge-card') && /完成/.test(document.querySelector('.merge-card .ac-status').textContent)", 8000), '模型综合未完成');
      const syn = lastReq(r => r.body && r.body.messages && r.body.messages[1] && String(r.body.messages[1].content).indexOf('【原始问题】') >= 0);
      assert(!!syn, '没有综合请求');
      assert(syn.body.model === 'm1', '综合模型=' + syn.body.model);
      assert(syn.body.messages[0].role === 'system' && syn.body.messages[0].content === '全局提示词SYS', JSON.stringify(syn.body.messages[0]));
      assert(String(syn.body.messages[1].content).indexOf('综合模型测试') >= 0, '综合提示词缺少原问题');
      const txt = await js("document.querySelector('.merge-card .ac-body').textContent");
      assert(/回答-m1-/.test(txt), '综合内容=' + txt);
      return JSON.stringify({ model: syn.body.model, len: txt.length });
    });

    // ---------- 7. 会话提示词 ----------
    await run('会话提示词覆盖/清除', async () => {
      await newSession();
      await setChips(['p1::m1']);
      await js(`(function(){
        document.querySelector('#btn-session-prompt').click();
        var ta=document.querySelector('#session-prompt');
        ta.value='只回答一个字';
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        document.querySelector('#btn-sp-close').click();
      })()`);
      await sleep(200);
      requests.length = 0;
      await sendText('会话提示词测试');
      assert(await waitDone(), '未完成');
      let req = lastReq(r => r.body && r.body.messages && String(r.body.messages[0].content) === '只回答一个字');
      assert(!!req, '请求未使用会话提示词');
      await js(`(function(){
        document.querySelector('#btn-session-prompt').click();
        document.querySelector('#btn-sp-clear').click();
        document.querySelector('#btn-sp-close').click();
      })()`);
      await sleep(200);
      requests.length = 0;
      await sendText('清除提示词测试');
      assert(await waitDone(), '未完成');
      req = lastReq(r => r.body && r.body.messages && String(r.body.messages[0].content) === '全局提示词SYS');
      assert(!!req, '清除后未回到全局提示词');
      return 'ok';
    });

    // ---------- 8. 编辑重发 ----------
    await run('编辑重发：替换提问并重建回答', async () => {
      await newSession();
      await setChips(['p1::m1']);
      await sendText('原始问题');
      assert(await waitDone(), '首轮未完成');
      const beforeCount = requests.length;
      await js(`(function(){
        var h=[].slice.call(document.querySelectorAll('.user-bubble .copy-hint')).filter(function(x){return x.textContent==='编辑';})[0];
        h.click();
        var ta=document.querySelector('.edit-input');
        ta.value='修改后的问题';
        [].slice.call(document.querySelectorAll('.edit-box button')).filter(function(b){return b.textContent==='保存并重发';})[0].click();
      })()`);
      assert(await waitDone(), '重发未完成');
      const t = await js(`({
        title: document.querySelector('#session-title').textContent,
        users: document.querySelectorAll('.user-msg').length,
        cards: document.querySelectorAll('.answer-card').length
      })`);
      assert(requests.length === beforeCount + 1, '请求数=' + requests.length);
      const req = lastReq();
      assert(req.body.messages[req.body.messages.length - 1].content === '修改后的问题', '重发内容=' + req.body.messages.slice(-1)[0].content);
      assert(t.title === '修改后的问题' && t.users === 1 && t.cards === 1, JSON.stringify(t));
      return JSON.stringify(t);
    });

    // ---------- 9. 401 错误 ----------
    await run('401 错误：卡片显示失败而不是空白', async () => {
      await newSession();
      await setChips(['p1::err']);
      await sendText('错误测试');
      assert(await waitFor("!!document.querySelector('.ac-error') && !document.querySelector('#btn-send').classList.contains('stop')", 6000), '未显示错误');
      const t = await js(`(function(){ var c=document.querySelector('.answer-card'); return { err:c.querySelector('.ac-error').textContent, status:c.querySelector('.ac-status').textContent }; })()`);
      assert(/401/.test(t.err) && /API Key 无效/.test(t.err) && /失败/.test(t.status), JSON.stringify(t));
      return JSON.stringify(t);
    });

    // ---------- 10. 非 SSE JSON ----------
    await run('非 SSE 的完整 JSON 响应', async () => {
      await newSession();
      await setChips(['p1::json']);
      await sendText('非流式测试');
      assert(await waitDone(), '未完成');
      const t = await js(`(function(){ var c=document.querySelector('.answer-card'); return { text:c.querySelector('.ac-body').textContent, tok:!!c.querySelector('.badge.tok') }; })()`);
      assert(t.text === '非流式完整回答' && t.tok === true, JSON.stringify(t));
      return JSON.stringify(t);
    });

    // ---------- 11. Anthropic 格式 ----------
    await run('Anthropic 格式：x-api-key/system/max_tokens', async () => {
      await newSession();
      await setChips(['p2::anth']);
      requests.length = 0;
      await sendText('Anthropic测试');
      assert(await waitDone(), '未完成');
      const req = lastReq(r => r.url.indexOf('/anthropic/') >= 0);
      assert(!!req, '没有 Anthropic 请求');
      assert(req.headers['x-api-key'] === 'k2' && req.headers['anthropic-version'], JSON.stringify(req.headers));
      assert(req.body.system === '全局提示词SYS', 'system=' + req.body.system);
      assert(req.body.messages.every(m => m.role !== 'system'), 'messages 里不应有 system');
      assert(req.body.max_tokens === 4096 && !('stream_options' in req.body), JSON.stringify(req.body));
      const t = await js(`(function(){ var c=document.querySelector('.answer-card'); return { text:c.querySelector('.ac-body').textContent, tok:!!c.querySelector('.badge.tok') }; })()`);
      assert(/回答-anth-/.test(t.text) && t.tok, JSON.stringify(t));
      return JSON.stringify({ text: t.text, system: req.body.system });
    });

    // ---------- 12. 原生搜索（智谱） ----------
    await run('智谱原生搜索：请求体带 web_search 工具', async () => {
      await newSession();
      await setChips(['p3::z1']);
      await js(`(function(){ var t=document.querySelector('#tgl-search'); if(!t.checked){ t.checked=true; t.dispatchEvent(new Event('change',{bubbles:true})); } })()`);
      requests.length = 0;
      await sendText('原生搜索测试');
      assert(await waitDone(), '未完成');
      const req = lastReq();
      assert(req.body.tools && req.body.tools[0].type === 'web_search', JSON.stringify(req.body.tools));
      assert(req.body.stream_options && req.body.stream_options.include_usage === true, JSON.stringify(req.body.stream_options));
      await js(`(function(){ var t=document.querySelector('#tgl-search'); if(t.checked){ t.checked=false; t.dispatchEvent(new Event('change',{bubbles:true})); } })()`);
      return JSON.stringify({ tools: req.body.tools[0].type });
    });

    // ---------- 12b. 联网搜索来源展示 ----------
    await run('联网搜索：来源挂到回答卡片并过滤非法协议', async () => {
      await newSession();
      await setChips(['p1::m1']);
      mockSearchResults = [
        { title: '坏来源', url: 'javascript:alert(1)', snippet: 'bad' },
        { title: '好来源', url: 'https://example.com/s', snippet: 'good' }
      ];
      await js(`(function(){ var t=document.querySelector('#tgl-search'); if(!t.checked){ t.checked=true; t.dispatchEvent(new Event('change',{bubbles:true})); } })()`);
      requests.length = 0;
      await sendText('搜索来源测试');
      assert(await waitDone(), '未完成');
      const t = await js(`(function(){
        var det=document.querySelector('.sources');
        var links=[].slice.call(document.querySelectorAll('.sources a')).map(function(a){return a.getAttribute('href');});
        var s=MM.state.sessions.find(function(x){return x.id===MM.state.currentId;});
        var am=s.messages.find(function(m){return m.role==='assistant';});
        return { has:!!det, summary:det?det.querySelector('summary').textContent:'', links:links,
                 resSources:(am && am.results[0].sources) ? am.results[0].sources.length : 0 };
      })()`);
      assert(t.has && t.summary.indexOf('搜索来源 (2)') >= 0 && t.links.length === 1 && t.links[0] === 'https://example.com/s' && t.resSources === 2, JSON.stringify(t));
      const req = lastReq();
      assert(req.body.messages.some(function(m){ return m.role === 'system' && /联网搜索结果/.test(m.content); }), '请求缺少搜索结果注入');
      await sleep(300);
      const disk = JSON.parse(fs.readFileSync(path.join(DATA, 'store.json'), 'utf8'));
      const ss = disk.sessions.find(function(x){ return x.title === '搜索来源测试'; });
      assert(ss && ss.messages.find(function(m){ return m.role === 'assistant'; }).results[0].sources.length === 2, '搜索来源未持久化');
      mockSearchResults = null;
      await js(`(function(){ var t=document.querySelector('#tgl-search'); if(t.checked){ t.checked=false; t.dispatchEvent(new Event('change',{bubbles:true})); } })()`);
      return JSON.stringify({ summary: t.summary, links: t.links });
    });

    // ---------- 13. 自动综合 ----------
    await run('自动综合：回答结束后自动生成综合卡片', async () => {
      await js(`(function(){ var t=document.querySelector('#tgl-auto'); if(!t.checked) t.click(); })()`);
      await newSession();
      await setChips(['p1::m1']);
      await sendText('自动综合测试');
      assert(await waitFor("document.querySelector('.merge-card') && /(已合并|完成)/.test(document.querySelector('.merge-card .ac-status').textContent)", 8000), '没有自动综合');
      await js(`(function(){ var t=document.querySelector('#tgl-auto'); if(t.checked) t.click(); })()`);
      return 'ok';
    });

    // ---------- 14. 设置保存 + 磁盘加密 ----------
    await run('设置保存：模型参数落盘、密钥加密', async () => {
      await js(`(function(){
        MM.settings.open();
        document.querySelector('.settings-nav[data-pane="models"]').click();
        var row=[].slice.call(document.querySelectorAll('#pane-models .model-row')).filter(function(r){return /本地OpenAI/.test(r.textContent);})[0];
        row.click();
        var inputs=document.querySelectorAll('#model-entries .m-entry')[0].querySelectorAll('.m-row2 input');
        inputs[0].value='55555';
        inputs[0].dispatchEvent(new Event('change', { bubbles:true }));
        document.querySelector('.pm-head-ops .btn-primary').click();
      })()`);
      await sleep(600);
      const disk = JSON.parse(fs.readFileSync(path.join(DATA, 'store.json'), 'utf8'));
      const p1 = disk.config.providers.find(p => p.id === 'p1');
      assert(p1 && p1.models[0].contextTokens === 55555, JSON.stringify(p1 && p1.models[0]));
      assert(p1.apiKey && typeof p1.apiKey === 'object' && p1.apiKey.enc, '磁盘密钥未加密: ' + JSON.stringify(p1.apiKey));
      const noKey = await js("MM.state.config.providers.every(function(p){ return !('apiKey' in p); })");
      assert(noKey, '渲染层出现了 apiKey');
      await js('MM.settings.close()');
      await sleep(250);
      return JSON.stringify({ ctx: p1.models[0].contextTokens, enc: !!p1.apiKey.enc });
    });

    // ---------- 15. 搜索设置校验 ----------
    await run('搜索设置：需要密钥的服务商不能空密钥保存', async () => {
      await js(`(function(){
        MM.settings.open();
        document.querySelector('.settings-nav[data-pane="search"]').click();
        var s=document.querySelector('#s-provider');
        s.value='tavily';
        s.dispatchEvent(new Event('change', { bubbles:true }));
        [].slice.call(document.querySelectorAll('#pane-search button')).filter(function(b){return b.textContent==='保存';})[0].click();
      })()`);
      await sleep(200);
      const err = await js("(document.querySelector('#pane-search .test-result') || {}).textContent");
      assert(/需要 API 密钥/.test(err || ''), '未提示密钥: ' + err);
      await js(`(function(){
        var s=document.querySelector('#s-provider');
        s.value='bing';
        s.dispatchEvent(new Event('change', { bubbles:true }));
        [].slice.call(document.querySelectorAll('#pane-search button')).filter(function(b){return b.textContent==='保存';})[0].click();
      })()`);
      await sleep(300);
      const toast = await js("document.querySelector('#toast').textContent");
      assert(/已保存/.test(toast), 'toast=' + toast);
      await js('MM.settings.close()');
      await sleep(250);
      return JSON.stringify({ err: err, toast: toast });
    });

    // ---------- 16. 自定义服务商增删 ----------
    await run('自定义服务商：添加后出现在列表并可删除', async () => {
      await js(`(function(){ window.confirm=function(){return true;}; MM.settings.open(); document.querySelector('.settings-nav[data-pane="models"]').click(); })()`);
      await sleep(200);
      const before = await js("document.querySelectorAll('#pane-models .model-row').length");
      await js("[].slice.call(document.querySelectorAll('#pane-models button')).filter(function(b){return b.textContent.indexOf('添加自定义服务商')>=0;})[0].click()");
      await sleep(250);
      const after = await js("document.querySelectorAll('#pane-models .model-row').length");
      assert(after === before + 1, 'before=' + before + ' after=' + after);
      await js("document.querySelector('.pm-head-ops .btn-danger').click()");
      await sleep(250);
      const back = await js("document.querySelectorAll('#pane-models .model-row').length");
      assert(back === before, '删除后=' + back);
      await js('MM.settings.close()');
      await sleep(250);
      return JSON.stringify({ before: before, after: after, back: back });
    });

    // ---------- 17. 导出 ----------
    await run('导出数据：确认提示 + 文件内容', async () => {
      nextSave = path.join(DATA, 'export.json');
      await js(`(function(){
        window.__confirmMsg='';
        window.confirm=function(m){ window.__confirmMsg=m; return true; };
        MM.settings.open();
        document.querySelector('.settings-nav[data-pane="data"]').click();
        [].slice.call(document.querySelectorAll('#pane-data button')).filter(function(b){return b.textContent.indexOf('导出数据')>=0;})[0].click();
      })()`);
      await sleep(800);
      assert(fs.existsSync(nextSave), '导出文件不存在');
      const j = JSON.parse(fs.readFileSync(nextSave, 'utf8'));
      assert(Array.isArray(j.sessions) && j.config && Array.isArray(j.config.providers), '导出结构不对');
      const p1 = j.config.providers.find(p => p.id === 'p1');
      assert(p1 && p1.apiKey === 'k1', '导出应包含明文密钥（用户确认的备份）');
      const msg = await js('window.__confirmMsg');
      assert(/明文 API 密钥/.test(msg || ''), '确认文案=' + msg);
      await js('MM.settings.close()');
      await sleep(250);
      return JSON.stringify({ sessions: j.sessions.length, providers: j.config.providers.length, hasPlain: p1.apiKey === 'k1' });
    });

    // ---------- 18. 导入新格式 ----------
    await run('导入新格式备份：会话/配置/hasKey 正确', async () => {
      const imp = {
        config: {
          providers: [{
            id: 'imp', name: '导入服务商', provider: 'custom', apiFormat: 'openai',
            baseUrl: 'https://example.invalid/v1', apiKey: 'imp-key', fullUrl: false, preset: false,
            models: [{ modelId: 'im', name: '导入模型', enabled: true, contextTokens: 5000, maxTokens: 500 }]
          }],
          search: { provider: 'none' }, synthesis: { synthSource: 'frontend', autoMerge: false }, systemPrompt: ''
        },
        sessions: [{
          id: 'imp-s', title: '导入会话', createdAt: 5, updatedAt: 5, pinned: false,
          messages: [
            { id: 'iu', role: 'user', content: '导入的问题', createdAt: 5 },
            { id: 'ia', role: 'assistant', roundId: 'ir', createdAt: 6,
              results: [{ modelId: 'imp::im', name: '导入模型', status: 'done', content: '导入的回答' }] }
          ]
        }]
      };
      nextOpen = path.join(DATA, 'import-new.json');
      fs.writeFileSync(nextOpen, JSON.stringify(imp), 'utf8');
      await js(`(function(){
        MM.settings.open();
        document.querySelector('.settings-nav[data-pane="data"]').click();
        [].slice.call(document.querySelectorAll('#pane-data button')).filter(function(b){return b.textContent.indexOf('导入数据')>=0;})[0].click();
      })()`);
      await sleep(1000);
      const t = await js(`({
        title: document.querySelector('#session-title').textContent,
        hasKey: (MM.state.config.providers.find(function(p){return p.id==='imp';})||{}).hasKey,
        apiKey: (MM.state.config.providers.find(function(p){return p.id==='imp';})||{}).apiKey,
        chip: [].slice.call(document.querySelectorAll('#model-chips .chip')).some(function(c){return c.getAttribute('data-model-id')==='imp::im';}),
        cards: document.querySelectorAll('.answer-card').length
      })`);
      assert(t.title === '导入会话', '标题=' + t.title);
      assert(t.hasKey === true && t.apiKey === undefined, JSON.stringify(t));
      assert(t.chip === true && t.cards === 1, JSON.stringify(t));
      await js('MM.settings.close()');
      await sleep(250);
      return JSON.stringify(t);
    });

    // ---------- 19. 导入 1.0 旧格式 ----------
    await run('导入 1.0 旧格式：迁移为分层服务商并加密', async () => {
      const legacy = {
        config: {
          models: [{
            id: 'legacy', provider: 'legacy', preset: false, modelId: 'm1', name: '旧模型',
            baseUrl: 'http://127.0.0.1:' + port + '/v1', apiKey: 'k9', apiFormat: 'openai',
            enabled: true, contextTokens: 1000, maxTokens: 100
          }],
          search: { provider: 'none' }, synthesis: { synthSource: 'frontend', autoMerge: false }
        },
        sessions: [{ id: 'leg-s', title: '旧会话', createdAt: 1, updatedAt: 1, messages: [] }]
      };
      nextOpen = path.join(DATA, 'import-legacy.json');
      fs.writeFileSync(nextOpen, JSON.stringify(legacy), 'utf8');
      await js(`(function(){
        MM.settings.open();
        document.querySelector('.settings-nav[data-pane="data"]').click();
        [].slice.call(document.querySelectorAll('#pane-data button')).filter(function(b){return b.textContent.indexOf('导入数据')>=0;})[0].click();
      })()`);
      await sleep(1000);
      const t = await js(`(function(){
        var p=MM.state.config.providers.find(function(x){return x.id==='legacy';});
        return { title: document.querySelector('#session-title').textContent,
                 hasKey: p && p.hasKey, apiKey: p && p.apiKey,
                 ctx: p && p.models[0] && p.models[0].contextTokens,
                 chip: [].slice.call(document.querySelectorAll('#model-chips .chip')).some(function(c){return c.getAttribute('data-model-id')==='legacy::m1';}) };
      })()`);
      assert(t.title === '旧会话', '标题=' + t.title);
      assert(t.hasKey === true && t.apiKey === undefined && t.ctx === 1000 && t.chip === true, JSON.stringify(t));
      const disk = JSON.parse(fs.readFileSync(path.join(DATA, 'store.json'), 'utf8'));
      const lp = disk.config.providers.find(p => p.id === 'legacy');
      assert(lp && lp.apiKey && typeof lp.apiKey === 'object' && lp.apiKey.enc, '磁盘密钥未加密');
      await js('MM.settings.close()');
      await sleep(250);
      return JSON.stringify({ title: t.title, ctx: t.ctx, enc: !!lp.apiKey.enc });
    });

    // ---------- 20. 安全边界 ----------
    await run('安全：沙箱/CSP/API 面/密钥隔离', async () => {
      const t = await js(`({
        require: typeof require, process: typeof process,
        api: Object.keys(window.api).sort(),
        csp: (document.querySelector('meta[http-equiv="Content-Security-Policy"]')||{}).content || '',
        keys: (function(){
          var out=[]; (MM.state.config.providers||[]).forEach(function(p){ if('apiKey' in p) out.push(p.id); });
          return out;
        })(),
        secret: false
      })`);
      assert(t.require === 'undefined' && t.process === 'undefined', JSON.stringify(t));
      // API 面只允许白名单内的方法（并行开发可能新增导出类方法，逐一核对）
      const allow = ['clearSecret','exportData','exportText','getAll','getCatalog','importData','listModels','onEvent','saveAll','search','send','setSecret','stop','synthesize','testModel','testSearch'];
      const unknown = t.api.filter(k => allow.indexOf(k) < 0);
      assert(unknown.length === 0 && t.api.indexOf('send') >= 0 && t.api.indexOf('setSecret') >= 0, JSON.stringify(t.api));
      assert(/default-src 'self'/.test(t.csp) && /object-src 'none'/.test(t.csp) && /base-uri 'none'/.test(t.csp), t.csp);
      assert(t.keys.length === 0, '渲染层有密钥: ' + JSON.stringify(t.keys));
      const bad = await js("api.setSecret('nonexistent-provider','x')");
      assert(bad === false, '不存在的服务商竟然写入成功');
      const all = await js("api.getAll().then(function(d){ return d.config.providers.some(function(p){ return 'apiKey' in p; }); })");
      assert(all === false, 'store:all 返回了 apiKey');
      return JSON.stringify({ api: t.api.length, unknown: unknown, csp: 'ok' });
    });

    await run('安全：Markdown XSS 与来源链接协议过滤', async () => {
      const t = await js(`(function(){
        var h = MM.md.render('<img src=x onerror=alert(1)> [x](javascript:alert(1)) <script>alert(1)</script> **b** \\u0060c\\u0060');
        return { img: h.indexOf('<img') >= 0, script: h.indexOf('<script') >= 0,
                 jsHref: h.indexOf('href="javascript:') >= 0, anchor: h.indexOf('<a ') >= 0,
                 strong: h.indexOf('<strong>b</strong>') >= 0, code: h.indexOf('<code>c</code>') >= 0 };
      })()`);
      assert(!t.img && !t.script && !t.jsHref && !t.anchor && t.strong && t.code, JSON.stringify(t));
      const src = await js(`(function(){
        var s={ id:'sec', title:'安全', createdAt:9, updatedAt:9, pinned:false, messages:[
          { id:'u', role:'user', content:'x', createdAt:9 },
          { id:'a', role:'assistant', roundId:'r', createdAt:9, results:[
            { modelId:'p1::m1', name:'m', status:'done', content:'[bad](javascript:alert(1)) <img src=x>',
              sources:[ { title:'bad', url:'javascript:alert(1)', snippet:'x' },
                        { title:'ok', url:'https://example.com/a', snippet:'y' } ] } ] }
        ]};
        MM.state.sessions.push(s); MM.state.currentId='sec'; MM.chat.renderAll();
        var card=document.querySelector('.answer-card');
        var links=[].slice.call(document.querySelectorAll('.sources a')).map(function(a){return a.getAttribute('href');});
        return { links: links, img: card.querySelectorAll('img').length, srcLinks: document.querySelectorAll('.sources a').length };
      })()`);
      assert(src.srcLinks === 1 && src.links[0] === 'https://example.com/a' && src.img === 0, JSON.stringify(src));
      return JSON.stringify(src);
    });

    await run('安全：window.open / 页面导航被拦截并转交系统浏览器', async () => {
      opened.length = 0;
      const before = BrowserWindow.getAllWindows().length;
      await js("window.open('https://example.com/open'); 1");
      await sleep(400);
      assert(opened.indexOf('https://example.com/open') >= 0, 'openExternal 未收到 window.open: ' + JSON.stringify(opened));
      assert(BrowserWindow.getAllWindows().length === before, '弹出了新窗口');
      await js("location.href='https://example.com/nav'; 1");
      await sleep(600);
      assert(opened.indexOf('https://example.com/nav') >= 0, '导航未被转交: ' + JSON.stringify(opened));
      assert(w.webContents.getURL().indexOf('file:') === 0, '页面被导航走了: ' + w.webContents.getURL());
      assert(await js("typeof MM !== 'undefined'"), '渲染层在导航测试后失效');
      return JSON.stringify({ opened: opened });
    });

    // ---------- 21. 最终磁盘状态 ----------
    await run('最终落盘：会话保留、密钥加密、无损坏备份', async () => {
      const disk = JSON.parse(fs.readFileSync(path.join(DATA, 'store.json'), 'utf8'));
      const lp = disk.config.providers.find(p => p.id === 'legacy');
      assert(Array.isArray(disk.sessions) && disk.sessions.length === 1, 'sessions=' + (disk.sessions || []).length);
      assert(disk.sessions[0].title === '旧会话', 'title=' + disk.sessions[0].title);
      assert(lp && lp.apiKey && lp.apiKey.enc, '密钥未加密');
      const corrupts = fs.readdirSync(DATA).filter(f => f.indexOf('.corrupt-') >= 0);
      assert(corrupts.length === 0, '出现损坏备份: ' + JSON.stringify(corrupts));
      return JSON.stringify({ sessions: disk.sessions.length, enc: !!lp.apiKey.enc });
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
