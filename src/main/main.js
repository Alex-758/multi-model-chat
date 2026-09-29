'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
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
let conflictNotified = false; // 多实例冲突提示每会话只弹一次
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

// ---------- 密钥保管 ----------
// API Key 只存在于主进程内存与磁盘数据文件中，渲染层永远只拿到 hasKey 布尔标记
function sanitizeConfig(cfg) {
  const c = JSON.parse(JSON.stringify(cfg || {}));
  for (const p of (c.providers || [])) {
    p.hasKey = !!(p.apiKey || '').trim();
    delete p.apiKey;
  }
  if (c.search) {
    c.search.hasKey = !!(c.search.apiKey || '').trim();
    delete c.search.apiKey;
  }
  return c;
}

// 渲染层传入的模型对象不含密钥：按 providerId 从主进程数据中解析
function resolveModel(mLike) {
  const pid = mLike.providerId || String(mLike.id || '').split('::')[0];
  const p = (db.config.providers || []).find(x => x.id === pid);
  const full = Object.assign({}, mLike, { apiKey: (p && p.apiKey) || '' });
  delete full.hasKey;
  return full;
}

// ---------- IPC：存储 ----------
ipcMain.handle('store:all', () => ({ config: sanitizeConfig(db.config), sessions: db.sessions }));
ipcMain.handle('store:save', (e, data) => {
  // 渲染层送来的 config 不含密钥：合并回主进程保管的部分，避免丢失/清空
  const incoming = (data && data.config) || {};
  const merged = JSON.parse(JSON.stringify(incoming));
  const oldProviders = (db.config && db.config.providers) || [];
  for (const p of (merged.providers || [])) {
    const old = oldProviders.find(x => x.id === p.id);
    if (old && old.apiKey) p.apiKey = old.apiKey;
    delete p.hasKey;
  }
  if (merged.search) {
    if (!merged.search.apiKey && db.config && db.config.search) merged.search.apiKey = db.config.search.apiKey || '';
    delete merged.search.hasKey;
  }
  db = { config: merged, sessions: (data && data.sessions) || [] };
  const r = store.save(db);
  // 多实例冲突：旧数据已备份，弹窗提示一次
  if (r && r.conflict && !conflictNotified) {
    conflictNotified = true;
    dialog.showMessageBox({
      type: 'warning',
      title: '检测到多实例写入',
      message: '检测到另一个 Multi-Model Chat 实例修改了数据文件。\n\n旧数据已自动备份为 store.json.bak（位于 %APPDATA%\\Multi-Model Chat），本次保存可能覆盖另一实例的最新改动。请尽量避免同时运行多个实例。'
    });
  }
  return true;
});

// ---------- IPC：密钥写入 / 清除 ----------
ipcMain.handle('secrets:set', (e, { id, key }) => {
  if (!id) return false;
  const k = String(key || '').trim();
  if (id === 'search') {
    db.config.search = db.config.search || { provider: 'none' };
    db.config.search.apiKey = k;
  } else {
    const p = (db.config.providers || []).find(x => x.id === id);
    if (p) p.apiKey = k;
  }
  store.save(db);
  return true;
});
ipcMain.handle('secrets:clear', (e, { id }) => {
  if (id === 'search') {
    if (db.config.search) db.config.search.apiKey = '';
  } else {
    const p = (db.config.providers || []).find(x => x.id === id);
    if (p) p.apiKey = '';
  }
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
        const { content, reasoning } = await providers.streamChat(resolveModel(model), messages, {
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
      const { content } = await providers.streamChat(resolveModel(model), messages, {
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
ipcMain.handle('models:list', (e, { model }) => providers.listModels(resolveModel(model)));
ipcMain.handle('models:test', (e, { model }) => providers.chatOnce(resolveModel(model)));

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
// 测试搜索：密钥由主进程合并（渲染层只传服务商选择）
ipcMain.handle('search:test', (e, cfg) => {
  const merged = Object.assign({}, (db.config && db.config.search) || {}, cfg || {});
  return search.webSearch(merged, '今日科技新闻', 3);
});

// ---------- IPC：数据导入导出 ----------
// 导出直接读主进程数据（含密钥——这是用户自己的完整备份）
ipcMain.handle('data:export', async () => {
  const r = await dialog.showSaveDialog(win, {
    title: '导出数据',
    defaultPath: 'multi-model-chat-backup.json',
    filters: [{ name: 'JSON', extensions: ['json'] }]
  });
  if (r.canceled || !r.filePath) return null;
  fs.writeFileSync(r.filePath, JSON.stringify({ config: db.config, sessions: db.sessions }, null, 1), 'utf8');
  return r.filePath;
});
// 导入在主进程完成：校验后落盘，返回给渲染层的数据剥离密钥
ipcMain.handle('data:import', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: '导入数据',
    filters: [{ name: 'JSON', extensions: ['json'] }],
    properties: ['openFile']
  });
  if (r.canceled || !r.filePaths || !r.filePaths[0]) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(r.filePaths[0], 'utf8'));
    if (!parsed || !parsed.config || !Array.isArray(parsed.sessions)) throw new Error('缺少 config/sessions 字段');
    db = { config: parsed.config, sessions: parsed.sessions };
    store.save(db);
    // 1.0 平铺旧结构原样返回（含密钥）：渲染层迁移逻辑需要读密钥并经 store:save 合并回主进程；
    // 新结构返回剥离密钥后的数据
    const legacyFlat = Array.isArray(parsed.config.models) && parsed.config.models.length;
    return { config: legacyFlat ? parsed.config : sanitizeConfig(parsed.config), sessions: db.sessions };
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
