// 临时性能验证：真实 main.js + 本地 SSE 服务，统计流式 IPC 消息数量与内容完整性。
const { app, BrowserWindow } = require('electron');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mmc-perf-'));
app.setPath('userData', tmp);

const rows = [];
function check(name, pass, detail) {
  rows.push({ name, pass, detail });
  console.log((pass ? 'PASS' : 'FAIL') + ' | ' + name + ' | ' + detail);
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

const DELTAS = 600;      // 正文 delta 数
const REASONING = 300;   // 思考链 delta 数
const TEXT = '答';
const THINK = '想';

const server = http.createServer(async (req, res) => {
  if (req.method !== 'POST') { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  // 每 5ms 一批、每批 10 条正文（+思考链），模拟高速流式输出
  for (let i = 0; i < DELTAS; i += 10) {
    for (let j = 0; j < 10 && i + j < DELTAS; j++) {
      res.write('data: {"choices":[{"delta":{"content":"' + TEXT + '"}}]}\n\n');
      if (i + j < REASONING) res.write('data: {"choices":[{"delta":{"reasoning_content":"' + THINK + '"}}]}\n\n');
    }
    await sleep(5);
  }
  res.write('data: {"choices":[],"usage":{"prompt_tokens":11,"completion_tokens":22}}\n\n');
  res.end('data: [DONE]\n\n');
});

server.listen(0, '127.0.0.1', () => {
  const port = server.address().port;
  const seed = {
    config: {
      providers: [{
        id: 'perf', name: 'Perf', provider: 'custom', apiFormat: 'openai',
        baseUrl: 'http://127.0.0.1:' + port + '/v1', apiKey: '', fullUrl: false, preset: false,
        models: [{ modelId: 'perf-model', name: 'Perf', enabled: true, contextTokens: 100000, maxTokens: 1000 }]
      }],
      search: { provider: 'none' },
      synthesis: { synthSource: 'frontend', autoMerge: false }
    },
    sessions: [{ id: 's1', title: 'perf', createdAt: 1, updatedAt: 1, pinned: false, messages: [] }]
  };
  fs.writeFileSync(path.join(tmp, 'store.json'), JSON.stringify(seed), 'utf8');
  require(path.join(ROOT, 'src', 'main', 'main.js'));

  app.whenReady().then(async () => {
    await sleep(1500);
    const w = BrowserWindow.getAllWindows()[0];
    if (!w) { console.log('FAIL | 窗口未创建'); app.exit(1); return; }
    const js = code => w.webContents.executeJavaScript(code, true);
    try {
      const model = {
        id: 'perf::perf-model', providerId: 'perf', name: 'Perf', provider: 'custom',
        apiFormat: 'openai', baseUrl: 'http://127.0.0.1:' + port + '/v1',
        modelId: 'perf-model', maxTokens: 1000
      };
      const st = await js(`new Promise(function(resolve){
        var s = { delta: 0, reasoning: 0, done: 0, error: 0, allDone: 0,
                  content: '', reasoningText: '', firstDelta: 0, doneAt: 0, usage: null };
        var t0 = performance.now();
        var off = api.onEvent(function(d){
          if (d.requestId !== 'perf1') return;
          if (d.type === 'delta') { s.delta++; s.content += d.text; if (!s.firstDelta) s.firstDelta = Math.round(performance.now() - t0); }
          else if (d.type === 'reasoning') { s.reasoning++; s.reasoningText += d.text; }
          else if (d.type === 'done') { s.done++; s.doneAt = Math.round(performance.now() - t0); s.usage = d.usage; }
          else if (d.type === 'error') { s.error++; }
          else if (d.type === 'all-done') { s.allDone++; off(); resolve(s); }
        });
        api.send({ requestId: 'perf1', searchOn: false, targets: [{ model: ${JSON.stringify(model)}, messages: [{ role: 'user', content: 'hi' }] }] });
        setTimeout(function(){ off(); resolve(s); }, 15000);
      })`);
      check('流式正文完整（无丢字/乱序）', st.content.length === DELTAS && st.content === TEXT.repeat(DELTAS),
        'contentLen=' + st.content.length + ' 期望=' + DELTAS);
      check('思考链完整', st.reasoningText.length === REASONING, 'reasoningLen=' + st.reasoningText.length + ' 期望=' + REASONING);
      const total = st.delta + st.reasoning;
      check('IPC 消息已合批（原 ' + (DELTAS + REASONING) + ' 条）', total < 120,
        'delta=' + st.delta + ' reasoning=' + st.reasoning + ' 合计=' + total);
      check('done/usage/all-done 正常', st.done === 1 && st.allDone === 1 && st.error === 0 && st.usage && st.usage.input === 11 && st.usage.output === 22,
        JSON.stringify({ done: st.done, allDone: st.allDone, error: st.error, usage: st.usage }));
      check('首条 delta 延迟可接受（< 200ms）', st.firstDelta < 200, 'firstDelta=' + st.firstDelta + 'ms doneAt=' + st.doneAt + 'ms');
      console.log('METRIC ' + JSON.stringify(st));
    } catch (e) {
      console.log('PERF_ERROR ' + (e && (e.stack || e.message)));
    }
    console.log('---SUMMARY---');
    console.log(JSON.stringify(rows, null, 1));
    w.destroy();
    server.close();
    app.exit(0);
  });
});
