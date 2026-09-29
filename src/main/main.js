'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const store = require('./store');
const providers = require('./providers');
const search = require('./search');

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const w = BrowserWindow.getAllWindows()[0];
    if (w) { if (w.isMinimized()) w.restore(); w.focus(); }
  });
}

let win = null;
let db = { config: {}, sessions: [] };
const activeRequests = new Map(); // requestId -> AbortController

function emit(payload) {
  if (win && !win.isDestroyed()) win.webContents.send('chat:event', payload);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 980,
    minHeight: 640,
    backgroundColor: '#f5f6fa',
    title: 'Multi-Model Chat',
    icon: path.join(__dirname, '../../build/icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true
    },
    show: false
  });
  win.once('ready-to-show', () => {
    win.show();
    win.focus();
    win.webContents.focus(); // 确保渲染进程获得键盘/输入法焦点
  });
  win.webContents.on('did-finish-load', () => {
    if (win && !win.isDestroyed()) { win.focus(); win.webContents.focus(); }
  });
  win.loadFile(path.join(__dirname, '../renderer/index.html'));
  // 渲染进程日志/错误转发到主进程 stdout，便于排查
  win.webContents.on('console-message', (e, level, message, line, sourceId) => {
    console.log('[renderer]', message, sourceId ? '(' + sourceId + ':' + line + ')' : '');
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  // F12 打开开发者工具，便于排查
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') {
      win.webContents.toggleDevTools();
      e.preventDefault();
    }
  });
}

// ---------- IPC：存储 ----------
ipcMain.handle('store:all', () => db);
ipcMain.handle('store:save', (e, data) => {
  db = { config: (data && data.config) || {}, sessions: (data && data.sessions) || [] };
  store.save(db);
  return true;
});

// ---------- IPC：多模型并发聊天 ----------
// payload: { requestId, targets: [{model, messages}], searchOn }
ipcMain.handle('chat:send', (e, payload) => {
  const { requestId, targets, searchOn } = payload || {};
  const ac = new AbortController();
  activeRequests.set(requestId, ac);
  (async () => {
    const jobs = (targets || []).map(async ({ model, messages }) => {
      const send = ev => emit({ requestId, modelId: model.id, ...ev });
      send({ type: 'start' });
      const t0 = Date.now();
      try {
        const { content, reasoning } = await providers.streamChat(model, messages, {
          searchOn, signal: ac.signal, onEvent: send
        });
        send({ type: 'done', ms: Date.now() - t0, chars: content.length });
      } catch (err) {
        send({ type: 'error', message: (err && err.message) || String(err) });
      }
    });
    await Promise.allSettled(jobs);
    activeRequests.delete(requestId);
    emit({ requestId, modelId: null, type: 'all-done' });
  })();
  return true;
});

// 模型二次综合：单独请求一个模型，事件中 modelId 固定为 __merge__
ipcMain.handle('chat:synthesize', (e, payload) => {
  const { requestId, model, messages } = payload || {};
  const ac = new AbortController();
  activeRequests.set(requestId, ac);
  (async () => {
    const send = ev => emit({ requestId, modelId: '__merge__', ...ev });
    send({ type: 'start' });
    const t0 = Date.now();
    try {
      const { content } = await providers.streamChat(model, messages, {
        searchOn: false, signal: ac.signal, onEvent: send
      });
      send({ type: 'done', ms: Date.now() - t0, chars: content.length });
    } catch (err) {
      send({ type: 'error', message: (err && err.message) || String(err) });
    }
    activeRequests.delete(requestId);
    emit({ requestId, modelId: null, type: 'all-done' });
  })();
  return true;
});

ipcMain.handle('chat:stop', (e, { requestId }) => {
  const ac = activeRequests.get(requestId);
  if (ac) ac.abort();
  return true;
});

// ---------- IPC：模型工具 ----------
ipcMain.handle('models:list', (e, { model }) => providers.listModels(model));
ipcMain.handle('models:test', (e, { model }) => providers.chatOnce(model));

// ---------- IPC：模型目录（models.dev，缓存 7 天） ----------
ipcMain.handle('catalog:get', async (e, force) => {
  const file = path.join(store.dir(), 'catalog.json');
  const TTL = 7 * 24 * 3600 * 1000;
  let cached = null;
  try { cached = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (err) { /* ignore */ }
  const stale = !cached || !cached.byId || !cached.byProvider; // 旧版缓存无 byProvider，视为过期
  if (!force && !stale && Date.now() - (cached.fetchedAt || 0) < TTL) return cached.byId;
  try {
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 12000);
    const res = await fetch('https://models.dev/api.json', { signal: ctrl.signal });
    clearTimeout(timeout);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const j = await res.json();
    const byId = {};
    const byProvider = {};
    for (const [pid, p] of Object.entries(j)) {
      const pl = pid.toLowerCase();
      const bucket = byProvider[pl] || (byProvider[pl] = {});
      for (const [mid, mod] of Object.entries(p.models || {})) {
        const info = {
          ctx: (mod.limit && mod.limit.context) || null,
          out: (mod.limit && mod.limit.output) || null,
          mm: !!(mod.modalities && mod.modalities.input && mod.modalities.input.indexOf('image') >= 0)
        };
        const key = mid.toLowerCase();
        byId[key] = info;
        if (key.indexOf('/') >= 0) byId[key.split('/').pop()] = info;
        bucket[key] = info;
        if (key.indexOf('/') >= 0) bucket[key.split('/').pop()] = info;
      }
    }
    const catalog = { byId, byProvider, fetchedAt: Date.now() };
    fs.writeFileSync(file, JSON.stringify(catalog), 'utf8');
    return byId;
  } catch (err) {
    return cached ? cached.byId : null; // 离线/失败时用旧缓存
  }
});

// ---------- IPC：联网搜索 ----------
ipcMain.handle('search:query', (e, { query, count }) => {
  return search.webSearch((db.config && db.config.search) || {}, query, count);
});
ipcMain.handle('search:test', (e, cfg) => search.webSearch(cfg, '今日科技新闻', 3));

// ---------- IPC：剪贴板（富文本 + 纯文本双写） ----------
ipcMain.handle('clipboard:writeRich', (e, { html, text }) => {
  const payload = {};
  if (text) payload.text = text;
  if (html) payload.html = html;
  clipboard.write(payload);
  return true;
});

// ---------- IPC：数据导入导出 ----------
ipcMain.handle('data:export', async (e, data) => {
  const r = await dialog.showSaveDialog(win, {
    title: '导出数据',
    defaultPath: 'multi-model-chat-backup.json',
    filters: [{ name: 'JSON', extensions: ['json'] }]
  });
  if (r.canceled || !r.filePath) return null;
  fs.writeFileSync(r.filePath, JSON.stringify(data, null, 1), 'utf8');
  return r.filePath;
});
ipcMain.handle('data:import', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: '导入数据',
    filters: [{ name: 'JSON', extensions: ['json'] }],
    properties: ['openFile']
  });
  if (r.canceled || !r.filePaths || !r.filePaths[0]) return null;
  try {
    return JSON.parse(fs.readFileSync(r.filePaths[0], 'utf8'));
  } catch (err) {
    throw new Error('文件解析失败：' + err.message);
  }
});

app.whenReady().then(() => {
  store.init(app.getPath('userData'));
  const loaded = store.load();
  if (loaded) db = { config: loaded.config || {}, sessions: loaded.sessions || [] };
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
