'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, Menu, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const store = require('./store');
const providers = require('./providers');
const search = require('./search');
const images = require('./images');

// 自定义协议（mmimg://）必须在 app ready 之前注册
images.registerScheme();

// 去掉默认应用菜单（File/Edit/View…）：一体化标题栏下它是突兀的黑条；
// F12 开发者工具由 createWindow 里的 before-input-event 单独挂接，不依赖菜单
Menu.setApplicationMenu(null);

if (!app.requestSingleInstanceLock()) {
  // 拿不到锁：直接退出，不再注册 IPC / 建窗，避免第二实例读写同一份数据文件
  app.quit();
  return; // CommonJS 模块顶层允许 return
}
app.on('second-instance', () => {
  const w = BrowserWindow.getAllWindows()[0];
  if (w) { if (w.isMinimized()) w.restore(); w.focus(); }
  // 用户再点一次图标时给可见反馈：聚焦已有窗口 + 窗口内提示（否则会像"点了没反应"）
  if (w && !w.isDestroyed()) w.webContents.send('app:notice', '应用已在运行，已切换到当前窗口');
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

// ---------- 窗口状态记忆 ----------
// 位置/尺寸存 userData/window-state.json，与 store.json 分开：导出备份不该带走本机窗口参数。
// screen 模块只能在 app ready 之后调用，而这里全部在 whenReady → createWindow 路径里执行
function loadWindowState() {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(store.dir(), 'window-state.json'), 'utf8'));
    return (s && typeof s === 'object') ? s : null;
  } catch (e) { return null; } // 无文件/损坏：用默认窗口
}
function saveWindowState(w) {
  try {
    // getNormalBounds：最大化时拿到的是"还原后"的边界，恢复时不会以巨尺寸开窗
    const b = w.getNormalBounds();
    fs.writeFileSync(path.join(store.dir(), 'window-state.json'),
      JSON.stringify({ x: b.x, y: b.y, width: b.width, height: b.height, max: w.isMaximized() }));
  } catch (e) { /* 记录失败不影响关闭，下次用默认窗口 */ }
}
// 保存的位置必须落在某块屏幕的工作区内才采用：拔掉显示器/改分辨率后
// 原地开窗会跑到屏幕外（窗口看得见标题栏也点不着）
function boundsOnScreen(b) {
  if (!b || typeof b.x !== 'number' || typeof b.y !== 'number') return false;
  return screen.getAllDisplays().some(d =>
    b.x >= d.workArea.x - 10 && b.x < d.workArea.x + d.workArea.width &&
    b.y >= d.workArea.y - 10 && b.y < d.workArea.y + d.workArea.height);
}

function createWindow() {
  const saved = loadWindowState();
  const MIN_W = 980, MIN_H = 640;
  const winOpts = {
    width: saved && saved.width >= MIN_W ? saved.width : 1440,
    height: saved && saved.height >= MIN_H ? saved.height : 920,
    minWidth: 980,
    minHeight: 640,
    backgroundColor: '#faf9f5',
    title: 'Multi-Model Chat',
    icon: path.join(__dirname, '../../build/icon.ico'),
    // 一体化标题栏：隐藏系统标题条；右上角三键由渲染层自绘（#win-controls，
    // 经 win:control IPC 调 minimize/maximize/close）。原生 WCO 的按钮区是系统
    // 绘制的，弹窗遮罩压不暗、主题切换也不同步，弹窗一开就突兀，故弃用
    titleBarStyle: 'hidden',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true
    },
    show: false
  };
  if (boundsOnScreen(saved)) { winOpts.x = saved.x; winOpts.y = saved.y; }
  win = new BrowserWindow(winOpts);
  // show 之前最大化：避免先闪一下默认尺寸再跳到最大化
  if (saved && saved.max) win.maximize();
  win.once('ready-to-show', () => {
    win.show();
    win.focus();
    win.webContents.focus(); // 确保渲染进程获得键盘/输入法焦点
  });
  win.webContents.on('did-finish-load', () => {
    if (win && !win.isDestroyed()) { win.focus(); win.webContents.focus(); }
  });
  // 最大化状态变化推给渲染层：自绘的 最大化/还原 图标随之切换
  ['maximize', 'unmaximize'].forEach(ev => win.on(ev, () => {
    if (win && !win.isDestroyed()) win.webContents.send('win:state', win.isMaximized());
  }));
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
  // F12 打开开发者工具便于排查（仅开发态；打包后不暴露，防止误触与 API 面暴露）
  if (!app.isPackaged) {
    win.webContents.on('before-input-event', (e, input) => {
      if (input.type === 'keyDown' && input.key === 'F12') {
        win.webContents.toggleDevTools();
        e.preventDefault();
      }
    });
  }
  // 权限请求一律拒绝：本应用不需要摄像头/麦克风/通知等任何设备权限，
  // 显式全拒走 fail-closed，而不是依赖 Chromium 的默认放行
  win.webContents.session.setPermissionRequestHandler((wc, permission, callback) => {
    callback(false);
  });
  // 关闭前先让渲染层把内存里的在途数据落盘（流式半成品、未保存的记账）：
  // 渲染层收到 app:flush 后保存并再次 close 放行；渲染层已死时由超时兜底强关。
  // 渲染层保存失败弹「保存失败闸门」时会发 app:flush-held 撤销强关定时器——
  // 闸门在等用户决策，2.5s 兜底恰恰不能在它唯一要生效的场景里把窗口杀掉
  let flushing = false;
  win.on('close', (e) => {
    try { saveWindowState(win); } catch (err) { /* 状态记录失败不影响关闭 */ }
    if (flushing) return; // 第二次 close：flush 已做过，放行
    flushing = true;
    e.preventDefault();
    const winRef = win; // 闭包抓当时的窗口实例：macOS activate 重建窗口后不能误杀新窗
    try { winRef.webContents.send('app:flush'); } catch (err) { /* 渲染层可能已崩溃 */ }
    flushKillTimer = setTimeout(() => {
      flushKillTimer = null;
      try { if (winRef && !winRef.isDestroyed()) winRef.destroy(); } catch (err) { /* 已销毁 */ }
    }, 2500);
  });
}

// ---------- 窗口控制（自绘三键 #win-controls） ----------
// 关窗兜底强关定时器（createWindow 的 close 处理器设置）；渲染层闸门可撤销
let flushKillTimer = null;
ipcMain.on('app:flush-held', () => {
  if (flushKillTimer) { clearTimeout(flushKillTimer); flushKillTimer = null; }
});
ipcMain.handle('win:control', (e, action) => {
  if (!win || win.isDestroyed()) return false;
  if (action === 'min') win.minimize();
  else if (action === 'max') { if (win.isMaximized()) win.unmaximize(); else win.maximize(); }
  else if (action === 'close') win.close();
  return win.isMaximized();
});

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

// 渲染层传入的模型对象不含密钥：按 providerId 从主进程数据中解析。
// 连接参数（baseUrl/apiFormat/fullUrl/provider）一律以主进程存量为准：
// 渲染层传值不可信——照单全收的话，渲染层一旦被注入就能把真实密钥
// 以 Authorization 头引流到任意 URL（e2e-app 有回归用例）
function resolveModel(mLike) {
  const m = (mLike && typeof mLike === 'object') ? mLike : {};
  const pid = m.providerId || String(m.id || '').split('::')[0];
  const list = (db.config && Array.isArray(db.config.providers)) ? db.config.providers : [];
  const p = list.find(x => x && x.id === pid);
  const full = Object.assign({}, m, { apiKey: (p && p.apiKey) || '' });
  if (p) {
    // baseUrl 无条件覆盖（不能因为存量为空就放行渲染层传值）：带 Key 的服务商 + 空 baseUrl
    // 是设置界面的可达状态，放行即等于把真实密钥引流到任意 URL
    full.baseUrl = p.baseUrl || '';
    if (p.apiFormat) full.apiFormat = p.apiFormat;
    if (p.provider) full.provider = p.provider;
    full.fullUrl = !!p.fullUrl;
  }
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
  // 多实例冲突：旧数据已带时间戳备份，弹窗提示一次
  if (r && r.conflict && !conflictNotified) {
    conflictNotified = true;
    dialog.showMessageBox({
      type: 'warning',
      title: '检测到多实例写入',
      message: '检测到另一个 Multi-Model Chat 实例修改了数据文件。\n\n旧数据已自动备份为 store.json.bak-<时间戳>（位于 %APPDATA%\\Multi-Model Chat，保留最近 5 份），本次保存可能覆盖另一实例的最新改动。请尽量避免同时运行多个实例。'
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
          const { content, reasoning, usage, finish } = await providers.streamChat(resolveModel(model), messages, {
            searchOn, signal: ac.signal, onEvent: send
          });
          send({ type: 'done', ms: Date.now() - t0, chars: content.length, usage, finish: finish || undefined });
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
      const { content, usage, finish } = await providers.streamChat(resolveModel(model), messages, {
        searchOn: false, signal: ac.signal, onEvent: send
      });
      send({ type: 'done', ms: Date.now() - t0, chars: content.length, usage, finish: finish || undefined });
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
  // 渲染层需要 byProvider 做服务商精确匹配（同名模型跨服务商时避免误判），故两者都返回；
  // fetchedAt 供设置页显示目录新鲜度与「立即更新」按钮
  const expose = c => (c && c.byId ? { byId: c.byId, byProvider: c.byProvider || {}, fetchedAt: c.fetchedAt || 0 } : null);
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
          mm: !!(mod.modalities && mod.modalities.input && mod.modalities.input.indexOf('image') >= 0),
          // 官方单价（美元 / 百万 tokens）：花费估算用；0/0 视为订阅制或未定价，解析层按无价处理
          cost: mod.cost ? {
            in: mod.cost.input || 0,
            out: mod.cost.output || 0,
            cache: mod.cost.cache_read != null ? mod.cost.cache_read : null
          } : null
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

// ---------- IPC：版本与更新检查（GitHub Releases API，设置页手动触发，不后台轮询） ----------
const RELEASES_URL = 'https://github.com/Alex-758/multi-model-chat/releases';
ipcMain.handle('app:version', () => app.getVersion());
// 版本比较：按点分段取数字比大小（1.4.10 > 1.4.9；段数不足补 0；非数字段按 0）
function isNewerVersion(a, b) {
  const pa = String(a).split('.'), pb = String(b).split('.');
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = parseInt(pa[i], 10) || 0, y = parseInt(pb[i], 10) || 0;
    if (x !== y) return x > y;
  }
  return false;
}
ipcMain.handle('update:check', async () => {
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 12000);
  try {
    const res = await fetch('https://api.github.com/repos/Alex-758/multi-model-chat/releases/latest', {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'Multi-Model-Chat/' + app.getVersion(), 'Accept': 'application/vnd.github+json' }
    });
    if (res.status === 404) throw new Error('仓库还没有发布任何版本');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const j = await res.json();
    const latest = String(j.tag_name || '').replace(/^v/i, '').trim();
    if (!latest) throw new Error('返回数据缺少版本号');
    const current = app.getVersion();
    return { current, latest, isNewer: isNewerVersion(latest, current), url: j.html_url || RELEASES_URL };
  } catch (e) {
    if (e && (e.name === 'AbortError' || /abort/i.test(String(e.name)))) throw new Error('检查超时：网络无响应');
    throw e;
  } finally {
    if (timeout) clearTimeout(timeout); // 失败路径也要清掉计时器
  }
});

// ---------- IPC：附件 ----------
// 渲染层贴图/拖图后把 base64 交给这里：落盘 + 系统 OCR 提取文字，返回引用 id
ipcMain.handle('images:save', (e, p) => images.saveImage(p));
// PDF/Word 等文档全文提取（本机 markitdown）
ipcMain.handle('attach:extractDoc', (e, p) => images.extractDoc(p));

// 「+」按钮选中的文件路径白名单（10 分钟有效）：路径版的提取/解码只接受
// 最近一次选择框真正返回的文件，渲染层被注入也无法借道读任意本地文件
const pickedPaths = new Map(); // path -> expiresAt
function consumePickedPath(p) {
  const exp = pickedPaths.get(p);
  if (!exp) return false;
  pickedPaths.delete(p); // 过期与有效都取走：没人消费的条目不能永久留在 Map 里
  if (exp < Date.now()) return false;
  return true;
}
// 「+」按钮：原生文件选择框。沙箱渲染层读不了任意路径——
// 图片回传 base64（渲染层要压缩），文本/文档只回传元数据，
// 内容走 files:readText / attach:extractDocPath 按白名单路径直读（E5：base64 不再两跳过 IPC）
ipcMain.handle('files:pick', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: '选择图片或文档附件',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp'] },
      { name: '文档', extensions: ['txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'log', 'js', 'mjs', 'ts', 'jsx', 'tsx', 'py', 'java', 'c', 'h', 'cpp', 'hpp', 'cs', 'go', 'rs', 'rb', 'php', 'sh', 'bat', 'ps1', 'ini', 'cfg', 'conf', 'yml', 'yaml', 'toml', 'xml', 'sql', 'html', 'htm', 'rtf', 'pdf', 'docx', 'doc', 'xlsx', 'xls', 'pptx', 'ppt', 'epub'] },
      { name: '所有文件', extensions: ['*'] }
    ]
  });
  if (r.canceled || !r.filePaths || !r.filePaths.length) return null;
  const IMG_MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', bmp: 'image/bmp' };
  const files = [];
  const tooLarge = [];
  for (const p of r.filePaths.slice(0, 6)) { // 一次最多带回 6 个，避免误选整目录拖垮 IPC
    let st;
    try { st = fs.statSync(p); } catch (err) { continue; }
    if (!st.isFile()) continue;
    if (st.size > 25 * 1024 * 1024) { tooLarge.push(path.basename(p)); continue; }
    const name = path.basename(p);
    const ext = (name.split('.').pop() || '').toLowerCase();
    const mime = IMG_MIME[ext] || '';
    // 只有图片需要把字节交给渲染层（压缩要用 canvas）；其余只给句柄，内容按需直读
    try {
      files.push({
        name, mime, path: p, size: st.size,
        base64: mime ? fs.readFileSync(p).toString('base64') : undefined
      });
      pickedPaths.set(p, Date.now() + 10 * 60 * 1000);
    } catch (err) { /* 单个文件读不了就跳过，不阻断其他文件 */ }
  }
  return { files, tooLarge };
});
// 白名单路径的文本附件解码（GBK/UTF-16 在主进程处理，几 MB 文本不再绕渲染层一圈）
ipcMain.handle('files:readText', (e, p) => {
  const file = p && String(p.path || '');
  if (!file || !consumePickedPath(file)) throw new Error('路径未被授权读取（请重新通过「+」选择）');
  return images.readTextFile(file);
});
// 白名单路径的文档提取（大文档不再 base64 两跳、不再写临时文件）
ipcMain.handle('attach:extractDocPath', (e, p) => {
  const file = p && String(p.path || '');
  if (!file || !consumePickedPath(file)) throw new Error('路径未被授权读取（请重新通过「+」选择）');
  return images.extractDocPath({ path: file, name: p.name });
});

// ---------- IPC：联网搜索 ----------
// requestId：与 chat:send 同一张 activeRequests 表，chat:stop 即可中止搜索阶段的
// 网络请求（此前停止只覆盖 chat，搜索会在主进程跑满 15s 超时）
ipcMain.handle('search:query', (e, { query, count, requestId }) => {
  let ac = null;
  if (requestId) { ac = new AbortController(); activeRequests.set(requestId, ac); }
  return search.webSearch((db.config && db.config.search) || {}, query, count, { signal: ac && ac.signal })
    .finally(() => { if (ac) activeRequests.delete(requestId); });
});
// 测试搜索：密钥由主进程合并（渲染层只传服务商选择）
ipcMain.handle('search:test', (e, cfg) => {
  const base = (db.config && db.config.search && typeof db.config.search === 'object') ? db.config.search : {};
  const merged = Object.assign({}, base, (cfg && typeof cfg === 'object') ? cfg : {});
  return search.webSearch(merged, '今日科技新闻', 3);
});

// ---------- IPC：数据导入导出 ----------
// 导出直接读主进程数据（含密钥——这是用户自己的完整备份）；
// 图片附件以内联 base64 一并打包（images.exportAttach），跨机恢复不再悬空
ipcMain.handle('data:export', async () => {
  const r = await dialog.showSaveDialog(win, {
    title: '导出数据',
    defaultPath: 'multi-model-chat-backup.json',
    filters: [{ name: 'JSON', extensions: ['json'] }]
  });
  if (r.canceled || !r.filePath) return null;
  fs.writeFileSync(r.filePath, JSON.stringify({
    config: db.config,
    sessions: images.exportAttach(db.sessions)
  }, null, 1), 'utf8');
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
  // 大小上限：误选超大文件（日志导出、npm lockfile 等）会长时间阻塞主进程并吃穿内存；
  // 本应用导出的备份（含内联图片）远达不到该量级
  let parsed;
  try {
    const st = fs.statSync(r.filePaths[0]);
    if (st.size > 256 * 1024 * 1024) throw new Error('文件超过 256MB，不是有效的备份数据');
    parsed = JSON.parse(fs.readFileSync(r.filePaths[0], 'utf8'));
  } catch (err) {
    throw new Error('文件解析失败：' + err.message);
  }
  if (!parsed || !parsed.config || typeof parsed.config !== 'object' || !Array.isArray(parsed.sessions)) {
    throw new Error('文件解析失败：缺少 config/sessions 字段');
  }
  // 兼容导入本应用内部的 store.json（密钥为 safeStorage 密文）：先解密再落盘
  const imported = store.decryptData(parsed);
  // 会话条目必须过滤：null/字符串会让渲染层排序直接抛错，写回磁盘后下次启动即不可用
  const sessions = imported.sessions.filter(s => s && typeof s === 'object');
  for (const s of sessions) if (!Array.isArray(s.messages)) s.messages = [];
  // 备份里内联的图片附件物化回 images/ 目录并改写引用（旧格式备份无 dataB64，原样通过）
  await images.importAttach(sessions);
  // 覆盖前给当前数据留一份副本：导入是覆盖性操作，选错文件要能退回来
  const backupPath = store.snapshot('pre-import');
  // 先落盘成功再换内存 db：写盘失败（磁盘满/无权限）时内存与磁盘保持一致，
  // 渲染层拿到的是失败拒绝，内存里的旧数据继续可用
  const newDb = { config: imported.config, sessions: sessions };
  store.save(newDb);
  db = newDb;
  // 1.0 平铺旧结构原样返回（含密钥）：渲染层迁移逻辑需要读密钥并经 store:save 合并回主进程；
  // 新结构返回剥离密钥后的数据
  const legacyFlat = Array.isArray(imported.config.models) && imported.config.models.length;
  return { config: legacyFlat ? imported.config : sanitizeConfig(imported.config), sessions: db.sessions, backup: backupPath };
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
  // 图片附件目录 + mmimg:// 协议；顺带清理已无会话引用的孤儿图片。
  // 数据文件损坏时本次以空库启动：gc 会把"无引用"理解为"全部孤儿"，把可恢复数据
  // 引用的图片一并删掉——跳过本次清理，用户恢复 .corrupt 备份后引用才不会悬空
  images.init(store.dir());
  images.registerProtocol();
  if (!bad) images.gc(db.sessions);
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
