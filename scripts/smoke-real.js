// 临时冒烟：用真实 main.js + 真实 store.js 启动，验证启动容错与写盘加密。
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mmc-real-'));
app.setPath('userData', tmp);

const rows = [];
function check(name, pass, detail) {
  rows.push({ name, pass, detail });
  console.log((pass ? 'PASS' : 'FAIL') + ' | ' + name + ' | ' + detail);
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 故意写入：null 服务商 + 明文密钥 + null 会话 + 无 roundId 的 assistant
const seed = {
  config: {
    providers: [
      null,
      {
        id: 'deepseek', name: 'DeepSeek', provider: 'deepseek', apiFormat: 'openai',
        baseUrl: 'https://api.deepseek.com', apiKey: 'test-key-not-real', fullUrl: false, preset: true,
        models: [{ modelId: 'deepseek-flash', name: 'Flash', enabled: true, contextTokens: 100000, maxTokens: 8000 }]
      }
    ],
    search: { provider: 'bing' },
    synthesis: { synthSource: 'frontend', autoMerge: false }
  },
  sessions: [
    null,
    {
      id: 's1', title: '旧会话', createdAt: 1, updatedAt: 2, pinned: false,
      messages: [
        { id: 'm1', role: 'user', content: '你好', createdAt: 1 },
        { id: 'm2', role: 'assistant', createdAt: 2,
          results: [{ modelId: 'deepseek::deepseek-flash', name: 'Flash', status: 'done', content: '你好' }] }
      ]
    }
  ]
};
fs.writeFileSync(path.join(tmp, 'store.json'), JSON.stringify(seed), 'utf8');

require(path.join(ROOT, 'src', 'main', 'main.js'));

app.whenReady().then(async () => {
  await sleep(1800);
  const w = BrowserWindow.getAllWindows()[0];
  if (!w) { console.log('FAIL | 窗口未创建'); app.exit(1); return; }
  const js = code => w.webContents.executeJavaScript(code, true);
  try {
    const fatal = await js("!!document.getElementById('fatal-error')");
    check('非法数据启动不进入错误遮罩', fatal === false, 'fatal=' + fatal);

    const st = await js(`({
      sessions: MM.state.sessions.length,
      title: MM.state.sessions[0] && MM.state.sessions[0].title,
      providers: MM.state.config.providers.length,
      allObjects: MM.state.config.providers.every(function(p){ return p && typeof p === 'object'; }),
      hasKey: MM.state.config.providers[0] && MM.state.config.providers[0].hasKey,
      hasPlainKey: !!(MM.state.config.providers[0] && MM.state.config.providers[0].apiKey),
      roundId: MM.state.sessions[0] && MM.state.sessions[0].messages[1] && MM.state.sessions[0].messages[1].roundId,
      sidebar: document.querySelectorAll('#session-list .session-item').length
    })`);
    check('null 服务商被过滤，密钥标记保留，渲染层无明文密钥',
      st.providers >= 1 && st.allObjects === true && st.hasKey === true && st.hasPlainKey === false,
      JSON.stringify(st));
    check('null 会话被过滤，旧会话保留并渲染', st.sessions === 1 && st.title === '旧会话' && st.sidebar === 1,
      JSON.stringify(st));
    check('旧 assistant 自动补 roundId', !!st.roundId, 'roundId=' + st.roundId);

    // 等待防抖/迁移落盘，再检查磁盘上的密钥是否已加密
    await sleep(600);
    const disk = JSON.parse(fs.readFileSync(path.join(tmp, 'store.json'), 'utf8'));
    const key = disk.config.providers[0] && disk.config.providers[0].apiKey;
    check('磁盘密钥已加密（safeStorage）', !!(key && typeof key === 'object' && key.enc),
      'diskKey=' + JSON.stringify(key).slice(0, 60));
    const raw = fs.readFileSync(path.join(tmp, 'store.json'), 'utf8');
    check('磁盘文件不含明文密钥', raw.indexOf('test-key-not-real') < 0, 'containsPlain=' + (raw.indexOf('test-key-not-real') >= 0));
    const corrupts = fs.readdirSync(tmp).filter(f => f.indexOf('.corrupt-') >= 0);
    check('未产生损坏备份', corrupts.length === 0, JSON.stringify(corrupts));

    // 非法 chat:send payload 不应让渲染层一直停在"生成中"
    const done = await js(`new Promise(function(resolve){
      var off = api.onEvent(function(d){
        if (d && d.type === 'all-done' && d.requestId === 'bad1') { off(); resolve(true); }
      });
      api.send({ requestId: 'bad1', targets: 'oops' });
      setTimeout(function(){ off(); resolve(false); }, 1500);
    })`);
    check('非法 chat:send payload 仍会收到 all-done', done === true, 'allDone=' + done);
  } catch (e) {
    console.log('SMOKE_ERROR ' + (e && (e.stack || e.message)));
  }
  console.log('---SUMMARY---');
  console.log(JSON.stringify(rows, null, 1));
  w.destroy();
  app.exit(0);
});
