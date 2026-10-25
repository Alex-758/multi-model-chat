'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const store = require('./store');
const providers = require('./providers');
const search = require('./search');
const images = require('./images');

// 自定义协议（mmimg://）必须在 app ready 之前注册
images.registerScheme();

if (!app.requestSingleInstanceLock()) {
  // 拿不到锁：直接退出，不再注册 IPC / 建窗，避免第二实例读写同一份数据文件
  app.quit();
  return; // CommonJS 模块顶层允许 return
}
app.on('second-instance', () => {
  const w = BrowserWindow.getAllWindows()[0];
  if (w) { if (w.isMinimized()) w.restore(); w.focus(); }
});

let win = null;
let db = { config: {}, sessions: [] };
let conflictNotified = false; // 多实例冲突提示每会话只弹一次
const activeRequests = new Map(); // requestId -> AbortController

function emit(payload) {
  if (win && !win.isDestroyed()) win.webContents.send('chat:event', payload);
}

// 高频 delta 合批：每个模型每 ~30ms 最多发一条 IPC。
// 渲染层本来就用 rAF 合帧，这里减少的是跨进程消息数量（4 模型并发时最明显）。
// start/done/error 之前必须先把缓冲的文本发出去，保证顺序与内容完整。
function makeEmitter(requestId, modelId) {
  let text = '', reasoning = '', timer = null;
  const flush = () => {
    if (timer) { clearTimeout(timer); timer = null; }
    if (text) { emit({ requestId, modelId, type: 'delta', text }); text = ''; }
    if (reasoning) { emit({ requestId, modelId, type: 'reasoning', text: reasoning }); reasoning = ''; }
  };
  const send = ev => {
    if (ev.type === 'delta') {
      text += ev.text;
      if (!timer) timer = setTimeout(flush, 30);
      return;
    }
    if (ev.type === 'reasoning') {
      reasoning += ev.text;
      if (!timer) timer = setTimeout(flush, 30);
      return;
    }
    flush();
    emit({ requestId, modelId, ...ev });
  };
  return { send, flush };
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
  win.webContents.on('console-message', (details) => {
    // Electron 44 推荐使用事件对象（旧的位置参数已弃用）
    const d = details || {};
    console.log('[renderer]', d.message, d.sourceId ? '(' + d.sourceId + ':' + d.lineNumber + ')' : '');
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  // 禁止页面内导航：一旦导航到远程页面，preload 暴露的 IPC 会被该页面拿到
  const wc = win.webContents;
  wc.on('will-navigate', (e, url) => {
    if (url === wc.getURL()) return; // 允许同页刷新
    e.preventDefault();
    if (/^https?:/i.test(url)) shell.openExternal(url);
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
function hasAnyKey(cfg) {
  const isKey = v => typeof v === 'string' && !!v.trim();
  const list = cfg && Array.isArray(cfg.providers) ? cfg.providers : [];
  if (list.some(p => p && isKey(p.apiKey))) return true;
  return !!(cfg && cfg.search && typeof cfg.search === 'object' && isKey(cfg.search.apiKey));
}
function sanitizeConfig(cfg) {
  const c = JSON.parse(JSON.stringify(cfg || {}));
  // 只接受字符串密钥：异常数据（对象等）按空处理，避免 .trim() 抛错导致整份配置读不出来
  const keyOf = v => (typeof v === 'string' ? v.trim() : '');
  for (const p of (Array.isArray(c.providers) ? c.providers : [])) {
    if (!p || typeof p !== 'object') continue;
    p.hasKey = !!keyOf(p.apiKey);
    delete p.apiKey;
  }
  if (c.search && typeof c.search === 'object') {
    c.search.hasKey = !!keyOf(c.search.apiKey);
    delete c.search.apiKey;
  }
  return c;
}

// 渲染层传入的模型对象不含密钥：按 providerId 从主进程数据中解析
function resolveModel(mLike) {
  const m = (mLike && typeof mLike === 'object') ? mLike : {};
  const pid = m.providerId || String(m.id || '').split('::')[0];
  const list = (db.config && Array.isArray(db.config.providers)) ? db.config.providers : [];
  const p = list.find(x => x && x.id === pid);
  const full = Object.assign({}, m, { apiKey: (p && p.apiKey) || '' });
  delete full.hasKey;
  return full;
}

// ---------- IPC：存储 ----------
ipcMain.handle('store:all', () => ({
  // 配置/会话字段可能是手改或旧版本留下的非法类型：归一成渲染层能处理的最小形状，
  // 避免整个 IPC 抛错（渲染层会把读取失败当成严重错误并停止启动）
  config: sanitizeConfig((db.config && typeof db.config === 'object') ? db.config : {}),
  sessions: Array.isArray(db.sessions) ? db.sessions : []
}));
ipcMain.handle('store:save', (e, data) => {
  // 渲染层送来的 config 不含密钥：合并回主进程保管的部分，避免丢失/清空
  const incoming = (data && data.config) || {};
  const merged = JSON.parse(JSON.stringify(incoming));
  const oldProviders = (db.config && Array.isArray(db.config.providers)) ? db.config.providers : [];
  for (const p of (Array.isArray(merged.providers) ? merged.providers : [])) {
    if (!p || typeof p !== 'object') continue;
    const old = oldProviders.find(x => x && x.id === p.id);
    if (old && old.apiKey) p.apiKey = old.apiKey;
    delete p.hasKey;
  }
  if (merged.search && typeof merged.search === 'object') {
    if (!merged.search.apiKey && db.config && db.config.search) merged.search.apiKey = db.config.search.apiKey || '';
    delete merged.search.hasKey;
  }
  // 渲染层只改配置时不会带 sessions：保留主进程内存里的会话，不能被空数组覆盖
  db = {
    config: merged,
    sessions: Array.isArray(data && data.sessions)
      ? data.sessions
      : (Array.isArray(db.sessions) ? db.sessions : [])
  };
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
    if (!db.config.search || typeof db.config.search !== 'object') db.config.search = { provider: 'none' };
    db.config.search.apiKey = k;
  } else {
    const list = Array.isArray(db.config.providers) ? db.config.providers : [];
    const p = list.find(x => x && x.id === id);
    if (!p) return false; // 服务商不存在：不要假装写入成功
    p.apiKey = k;
  }
  store.save(db);
  return true;
});
ipcMain.handle('secrets:clear', (e, { id }) => {
  if (id === 'search') {
    if (db.config.search && typeof db.config.search === 'object') db.config.search.apiKey = '';
  } else {
    const list = Array.isArray(db.config.providers) ? db.config.providers : [];
    const p = list.find(x => x && x.id === id);
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
    try {
      // 非法 payload 不能留下未处理的 Promise 拒绝；过滤掉缺 model 的条目
      const jobs = (Array.isArray(targets) ? targets : []).filter(t => t && t.model).map(async ({ model, messages }) => {
        const em = makeEmitter(requestId, model.id);
        const send = em.send;
        send({ type: 'start' });
        const t0 = Date.now();
        try {
          const { content, reasoning, usage } = await providers.streamChat(resolveModel(model), messages, {
            searchOn, signal: ac.signal, onEvent: send
          });
          send({ type: 'done', ms: Date.now() - t0, chars: content.length, usage });
        } catch (err) {
          // 已停止的回答也会带出已产生的 token 用量
          send({ type: 'error', message: (err && err.message) || String(err), usage: (err && err.usage) || null });
        }
      });
      await Promise.allSettled(jobs);
    } catch (err) {
      console.error('[chat:send] 请求处理失败：', err);
    } finally {
      // 无论成功/异常都要收尾，否则渲染层会一直停在"生成中"
      activeRequests.delete(requestId);
      emit({ requestId, modelId: null, type: 'all-done' });
    }
  })();
  return true;
});

// 模型二次综合：单独请求一个模型，事件中 modelId 固定为 __merge__
ipcMain.handle('chat:synthesize', (e, payload) => {
  const { requestId, model, messages } = payload || {};
  const ac = new AbortController();
  activeRequests.set(requestId, ac);
  (async () => {
    const em = makeEmitter(requestId, '__merge__');
    const send = em.send;
    send({ type: 'start' });
    const t0 = Date.now();
    try {
      const { content, usage } = await providers.streamChat(resolveModel(model), messages, {
        searchOn: false, signal: ac.signal, onEvent: send
      });
      send({ type: 'done', ms: Date.now() - t0, chars: content.length, usage });
    } catch (err) {
      send({ type: 'error', message: (err && err.message) || String(err), usage: (err && err.usage) || null });
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
  // 渲染层需要 byProvider 做服务商精确匹配（同名模型跨服务商时避免误判），故两者都返回
  const expose = c => (c && c.byId ? { byId: c.byId, byProvider: c.byProvider || {} } : null);
  let cached = null;
  try { cached = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (err) { /* ignore */ }
  const stale = !cached || !cached.byId || !cached.byProvider; // 旧版缓存无 byProvider，视为过期
  if (!force && !stale && Date.now() - (cached.fetchedAt || 0) < TTL) return expose(cached);
  let timeout = null;
  try {
    const ctrl = new AbortController();
    timeout = setTimeout(() => ctrl.abort(), 12000);
    const res = await fetch('https://models.dev/api.json', { signal: ctrl.signal });
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
    return expose(catalog);
  } catch (err) {
    return expose(cached); // 离线/失败时用旧缓存
  } finally {
    if (timeout) clearTimeout(timeout); // 失败路径也要清掉计时器
  }
});

// ---------- IPC：附件 ----------
// 渲染层贴图/拖图后把 base64 交给这里：落盘 + 系统 OCR 提取文字，返回引用 id
ipcMain.handle('images:save', (e, p) => images.saveImage(p));
// PDF/Word 等文档全文提取（本机 markitdown）
ipcMain.handle('attach:extractDoc', (e, p) => images.extractDoc(p));

// ---------- IPC：联网搜索 ----------
ipcMain.handle('search:query', (e, { query, count }) => {
  return search.webSearch((db.config && db.config.search) || {}, query, count);
});
// 测试搜索：密钥由主进程合并（渲染层只传服务商选择）
ipcMain.handle('search:test', (e, cfg) => {
  const base = (db.config && db.config.search && typeof db.config.search === 'object') ? db.config.search : {};
  const merged = Object.assign({}, base, (cfg && typeof cfg === 'object') ? cfg : {});
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
// 导出对话文本（单轮 / 整会话共用）：内容由渲染层拼好传过来，这里只负责保存对话框与写盘
ipcMain.handle('data:exportText', async (e, { content, filename, title }) => {
  const r = await dialog.showSaveDialog(win, {
    title: title || '导出本轮对话',
    defaultPath: filename || '对话导出.md',
    filters: [{ name: 'Markdown', extensions: ['md'] }, { name: '文本文件', extensions: ['txt'] }]
  });
  if (r.canceled || !r.filePath) return null;
  fs.writeFileSync(r.filePath, String(content || ''), 'utf8');
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
    if (!parsed || !parsed.config || typeof parsed.config !== 'object' || !Array.isArray(parsed.sessions)) {
      throw new Error('缺少 config/sessions 字段');
    }
    // 兼容导入本应用内部的 store.json（密钥为 safeStorage 密文）：先解密再落盘
    const imported = store.decryptData(parsed);
    // 会话条目必须过滤：null/字符串会让渲染层排序直接抛错，写回磁盘后下次启动即不可用
    const sessions = imported.sessions.filter(s => s && typeof s === 'object');
    for (const s of sessions) if (!Array.isArray(s.messages)) s.messages = [];
    db = { config: imported.config, sessions: sessions };
    store.save(db);
    // 1.0 平铺旧结构原样返回（含密钥）：渲染层迁移逻辑需要读密钥并经 store:save 合并回主进程；
    // 新结构返回剥离密钥后的数据
    const legacyFlat = Array.isArray(imported.config.models) && imported.config.models.length;
    return { config: legacyFlat ? imported.config : sanitizeConfig(imported.config), sessions: db.sessions };
  } catch (err) {
    throw new Error('文件解析失败：' + err.message);
  }
});

app.whenReady().then(() => {
  store.init(app.getPath('userData'));
  const loaded = store.load();
  if (loaded) db = { config: loaded.config || {}, sessions: loaded.sessions || [] };
  const bad = store.corruptInfo();
  if (bad) {
    dialog.showMessageBox({
      type: 'warning',
      title: '数据文件损坏',
      message: '本地数据文件（store.json）无法解析，本次将以空配置启动。\n\n' +
        (bad.backup ? '原文件已备份为：\n' + bad.backup : '原文件备份失败，请手动备份。') +
        '\n\n错误信息：' + bad.message
    });
  }
  const lostKeys = store.decryptInfo();
  if (lostKeys > 0) {
    dialog.showMessageBox({
      type: 'warning',
      title: '部分密钥无法解密',
      message: '检测到 ' + lostKeys + ' 个 API 密钥无法解密（通常是因为数据文件来自其它电脑或其它 Windows 用户）。\n\n' +
        '这些密钥已按空处理，请在「设置 → 模型配置」中重新填写。'
    });
  }
  // 系统不支持安全存储时密钥会明文落盘：只在实际存有密钥时提示一次，避免每次启动都打扰
  if (!store.encryptionAvailable() && hasAnyKey(db.config)) {
    dialog.showMessageBox({
      type: 'warning',
      title: '密钥未加密保存',
      message: '当前系统不支持 Electron 的安全存储（safeStorage），API 密钥将以明文形式保存在本机数据文件中。\n\n' +
        '请勿把数据文件复制到网盘、聊天工具或不可信位置。'
    });
  }
  // 图片附件目录 + mmimg:// 协议；顺带清理已无会话引用的孤儿图片
  images.init(store.dir());
  images.registerProtocol();
  images.gc(db.sessions);
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
