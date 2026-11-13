'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // 存储
  getAll: () => ipcRenderer.invoke('store:all'),
  saveAll: (d) => ipcRenderer.invoke('store:save', d),
  // 窗口控制（自绘三键）与最大化状态推送
  winControl: (a) => ipcRenderer.invoke('win:control', a),
  onWinState: (cb) => {
    const h = (e, d) => cb(d);
    ipcRenderer.on('win:state', h);
    return () => ipcRenderer.removeListener('win:state', h);
  },
  // 关窗前的落盘请求：渲染层保存完后自行 window.close() 放行
  onFlush: (cb) => {
    const h = () => cb();
    ipcRenderer.on('app:flush', h);
    return () => ipcRenderer.removeListener('app:flush', h);
  },
  // 保存失败弹闸门时通知主进程撤销强关定时器（闸门等用户决策，不能被兜底强关打断）
  flushHeld: () => ipcRenderer.send('app:flush-held'),
  // 主进程的一次性提示（如第二实例触发时聚焦当前窗口）
  onNotice: (cb) => {
    const h = (e, d) => cb(d);
    ipcRenderer.on('app:notice', h);
    return () => ipcRenderer.removeListener('app:notice', h);
  },
  // 聊天
  send: (p) => ipcRenderer.invoke('chat:send', p),
  synthesize: (p) => ipcRenderer.invoke('chat:synthesize', p),
  stop: (requestId) => ipcRenderer.invoke('chat:stop', { requestId }),
  // 模型工具
  listModels: (model) => ipcRenderer.invoke('models:list', { model }),
  testModel: (model) => ipcRenderer.invoke('models:test', { model }),
  getCatalog: (force) => ipcRenderer.invoke('catalog:get', force),
  // 版本与更新检查（设置页「关于与更新」卡片）
  appVersion: () => ipcRenderer.invoke('app:version'),
  checkUpdate: () => ipcRenderer.invoke('update:check'),
  // 搜索（requestId 用于 chat:stop 中止搜索阶段的网络请求）
  search: (query, count, requestId) => ipcRenderer.invoke('search:query', { query, count, requestId }),
  testSearch: (cfg) => ipcRenderer.invoke('search:test', cfg),
  // 密钥保管（渲染层不持有密钥，只写入/清除）
  setSecret: (id, key) => ipcRenderer.invoke('secrets:set', { id, key }),
  clearSecret: (id) => ipcRenderer.invoke('secrets:clear', { id }),
  // 数据
  exportData: (d) => ipcRenderer.invoke('data:export', d),
  exportText: (p) => ipcRenderer.invoke('data:exportText', p),
  importData: () => ipcRenderer.invoke('data:import'),
  // 附件：图片落盘+OCR，文档全文提取，「+」按钮文件选择
  saveImage: (p) => ipcRenderer.invoke('images:save', p),
  extractDoc: (p) => ipcRenderer.invoke('attach:extractDoc', p),
  pickFiles: () => ipcRenderer.invoke('files:pick'),
  // 「+」路径直读（仅限最近一次选择框返回的路径）：文本解码 / 文档提取
  readTextPath: (p) => ipcRenderer.invoke('files:readText', p),
  extractDocPath: (p) => ipcRenderer.invoke('attach:extractDocPath', p),
  // 事件流
  onEvent: (cb) => {
    const h = (e, d) => cb(d);
    ipcRenderer.on('chat:event', h);
    return () => ipcRenderer.removeListener('chat:event', h);
  }
});
