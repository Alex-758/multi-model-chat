// 临时性能验证：大会话切换时的渲染耗时（冷/热），验证 Markdown 缓存效果。
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'mmc-render-')));
const sleep = ms => new Promise(r => setTimeout(r, ms));

const ROUNDS = 30;
const MODELS = 4;
const BODY = ('这是一段用于性能测试的回答内容，包含中文、English words 和数字 12345。').repeat(12).slice(0, 1100) +
  '\n\n- 要点一\n- 要点二\n\n| 列A | 列B |\n|---|---|\n| 1 | 2 |';

function bigSession() {
  const messages = [];
  for (let i = 0; i < ROUNDS; i++) {
    messages.push({ id: 'u' + i, role: 'user', content: '第 ' + (i + 1) + ' 个问题', createdAt: i * 2 });
    messages.push({
      id: 'a' + i, role: 'assistant', roundId: 'r' + i, createdAt: i * 2 + 1,
      results: Array.from({ length: MODELS }, (_, j) => ({
        modelId: 'p::m' + j, name: '模型' + j, status: 'done', content: BODY, ms: 1000, chars: BODY.length
      }))
    });
  }
  return { id: 'big', title: '大会话', createdAt: 1, updatedAt: 1, pinned: false, messages: messages };
}
const config = {
  providers: [{
    id: 'p', name: 'P', provider: 'custom', apiFormat: 'openai', baseUrl: 'https://x', fullUrl: false, preset: false,
    hasKey: true, models: [{ modelId: 'm0', name: '模型0', enabled: true }, { modelId: 'm1', name: '模型1', enabled: true },
      { modelId: 'm2', name: '模型2', enabled: true }, { modelId: 'm3', name: '模型3', enabled: true }]
  }],
  search: { provider: 'none' }, synthesis: { synthSource: 'frontend', autoMerge: false }, systemPrompt: ''
};
const sessions = [bigSession(), { id: 'small', title: '小会话', createdAt: 9, updatedAt: 9, pinned: false, messages: [] }];

ipcMain.handle('store:all', () => ({ config: JSON.parse(JSON.stringify(config)), sessions: JSON.parse(JSON.stringify(sessions)) }));
ipcMain.handle('store:save', () => true);
ipcMain.handle('chat:send', () => true);
ipcMain.handle('chat:stop', () => true);
ipcMain.handle('chat:synthesize', () => true);
ipcMain.handle('search:query', () => null);
ipcMain.handle('search:test', () => []);
ipcMain.handle('models:list', () => []);
ipcMain.handle('models:test', () => 'ok');
ipcMain.handle('catalog:get', () => null);
ipcMain.handle('secrets:set', () => true);
ipcMain.handle('secrets:clear', () => true);
ipcMain.handle('data:export', () => null);
ipcMain.handle('data:import', () => null);

app.whenReady().then(async () => {
  const w = new BrowserWindow({
    width: 1200, height: 850, show: true,
    webPreferences: { preload: path.join(ROOT, 'src', 'main', 'preload.js'), contextIsolation: true, sandbox: true }
  });
  const js = code => w.webContents.executeJavaScript(code, true);
  await w.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
  await sleep(1500);
  try {
    // 启动时打开的是小会话；切到大会话是冷渲染，切走再切回是热渲染（Markdown 缓存命中）
    const r = await js(`(function(){
      function time(fn){ var t = performance.now(); fn(); return Math.round((performance.now() - t) * 10) / 10; }
      var cold = time(function(){ MM.sessions.switchTo('big'); });
      var back = time(function(){ MM.sessions.switchTo('small'); });
      var warm = time(function(){ MM.sessions.switchTo('big'); });
      var cards = document.querySelectorAll('.answer-card').length;
      var bodies = document.querySelectorAll('.ac-body').length;
      var warm2 = time(function(){ MM.sessions.switchTo('small'); });
      return { cold: cold, back: back, warm: warm, warm2: warm2, cards: cards, chars: bodies };
    })()`);
    console.log('METRIC ' + JSON.stringify(r));
    console.log((r.cold > 0 && r.warm <= r.cold ? 'PASS' : 'WARN') + ' | 热渲染不慢于冷渲染 | cold=' + r.cold + 'ms warm=' + r.warm + 'ms');
    console.log('PASS | 大会话完整渲染 | cards=' + r.cards + ' bodies=' + r.chars);
  } catch (e) {
    console.log('RENDER_ERROR ' + (e && (e.stack || e.message)));
  }
  w.destroy();
  app.exit(0);
});
