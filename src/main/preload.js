'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // 存储
  getAll: () => ipcRenderer.invoke('store:all'),
  saveAll: (d) => ipcRenderer.invoke('store:save', d),
  // 聊天
  send: (p) => ipcRenderer.invoke('chat:send', p),
  synthesize: (p) => ipcRenderer.invoke('chat:synthesize', p),
  stop: (requestId) => ipcRenderer.invoke('chat:stop', { requestId }),
  // 模型工具
  listModels: (model) => ipcRenderer.invoke('models:list', { model }),
  testModel: (model) => ipcRenderer.invoke('models:test', { model }),
  getCatalog: (force) => ipcRenderer.invoke('catalog:get', force),
  // 搜索
  search: (query, count) => ipcRenderer.invoke('search:query', { query, count }),
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
  // 事件流
  onEvent: (cb) => {
    const h = (e, d) => cb(d);
    ipcRenderer.on('chat:event', h);
    return () => ipcRenderer.removeListener('chat:event', h);
  }
});
