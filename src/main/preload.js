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
  // 数据
  exportData: (d) => ipcRenderer.invoke('data:export', d),
  importData: () => ipcRenderer.invoke('data:import'),
  // 事件流
  onEvent: (cb) => {
    const h = (e, d) => cb(d);
    ipcRenderer.on('chat:event', h);
    return () => ipcRenderer.removeListener('chat:event', h);
  }
});
