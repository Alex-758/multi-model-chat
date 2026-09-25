'use strict';
// 入口：初始化全局状态、从主进程加载数据、启动渲染
window.MM = window.MM || {};

MM.defaults = {
  // 预置服务商：连接信息共享，每个服务商下可挂多个模型
  PRESET_PROVIDERS: [
    {
      id: 'deepseek', name: 'DeepSeek', provider: 'deepseek',
      apiFormat: 'openai', baseUrl: 'https://api.deepseek.com', apiKey: '', fullUrl: false, preset: true,
      models: [
        { modelId: 'deepseek-chat', name: 'DeepSeek V3', enabled: true, contextTokens: 131072, maxTokens: 8192, multimodal: false },
        { modelId: 'deepseek-reasoner', name: 'DeepSeek R1 推理', enabled: true, contextTokens: 131072, maxTokens: 65536, multimodal: false }
      ]
    },
    {
      id: 'siliconflow', name: '硅基流动', provider: 'siliconflow',
      apiFormat: 'openai', baseUrl: 'https://api.siliconflow.cn/v1', apiKey: '', fullUrl: false, preset: true,
      models: [
        { modelId: 'deepseek-ai/DeepSeek-V3', name: 'DeepSeek V3', enabled: true, contextTokens: 131072, maxTokens: 8192, multimodal: false },
        { modelId: 'Qwen/Qwen2.5-72B-Instruct', name: 'Qwen2.5 72B', enabled: true, contextTokens: 131072, maxTokens: 8192, multimodal: false }
      ]
    },
    {
      id: 'dashscope', name: '阿里百炼', provider: 'dashscope',
      apiFormat: 'openai', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', apiKey: '', fullUrl: false, preset: true,
      models: [
        { modelId: 'qwen-plus', name: 'Qwen Plus', enabled: true, contextTokens: 131072, maxTokens: 8192, multimodal: false },
        { modelId: 'qwen-max', name: 'Qwen Max', enabled: true, contextTokens: 32768, maxTokens: 8192, multimodal: false }
      ]
    },
    {
      id: 'zhipu', name: '智谱 BigModel', provider: 'zhipu',
      apiFormat: 'openai', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', apiKey: '', fullUrl: false, preset: true,
      models: [
        { modelId: 'glm-4.6', name: 'GLM-4.6', enabled: true, contextTokens: 204800, maxTokens: 131072, multimodal: false },
        { modelId: 'glm-4.5-air', name: 'GLM-4.5 Air', enabled: true, contextTokens: 131072, maxTokens: 16384, multimodal: false }
      ]
    },
    {
      id: 'openrouter', name: 'OpenRouter', provider: 'openrouter',
      apiFormat: 'openai', baseUrl: 'https://openrouter.ai/api/v1', apiKey: '', fullUrl: false, preset: true,
      models: [
        { modelId: 'openai/gpt-4.1-mini', name: 'GPT-4.1 Mini', enabled: true, contextTokens: 1048576, maxTokens: 32768, multimodal: true },
        { modelId: 'anthropic/claude-sonnet-4.5', name: 'Claude Sonnet 4.5', enabled: true, contextTokens: 1048576, maxTokens: 65536, multimodal: true }
      ]
    }
  ],

  DEFAULT_CONFIG: {
    providers: [],
    search: { provider: 'bing', apiKey: '' },
    synthesis: { mode: 'frontend', modelKey: '', autoMerge: true }
  }
};

(function () {
  // 把旧版平铺的 config.models（每条含完整连接信息）迁移为分层 config.providers
  function migrateFlatModels(flatModels) {
    const byId = new Map();
    for (const m of flatModels) {
      let p;
      if (m.preset && m.provider) {
        p = byId.get(m.provider);
      }
      if (!p) {
        p = byId.get(m.id);
      }
      if (!p) {
        const presetDef = m.preset ? MM.defaults.PRESET_PROVIDERS.find(x => x.id === (m.provider || m.id)) : null;
        p = {
          id: (m.preset && m.provider) ? m.provider : m.id,
          name: presetDef ? presetDef.name : (m.name || m.modelId || '自定义'),
          provider: m.provider || m.id,
          apiFormat: m.apiFormat || 'openai',
          baseUrl: m.baseUrl || '',
          apiKey: m.apiKey || '',
          fullUrl: !!m.fullUrl,
          preset: !!m.preset,
          models: []
        };
        byId.set(p.id, p);
      }
      // 保留每个服务商的 Key：同服务商多条旧配置取第一个非空 Key
      if (!p.apiKey && m.apiKey) p.apiKey = m.apiKey;
      if (!p.baseUrl && m.baseUrl) p.baseUrl = m.baseUrl;
      if (!m.modelId) continue; // 空模型条目丢弃
      if (p.models.some(x => x.modelId === m.modelId)) continue;
      p.models.push({
        modelId: m.modelId,
        name: (m.preset && m.provider) ? m.name : (m.name || m.modelId),
        enabled: m.enabled !== false,
        contextTokens: m.contextTokens,
        maxTokens: m.maxTokens,
        multimodal: m.multimodal
      });
    }
    return Array.from(byId.values());
  }

  function fillPresetDefaults(providers, seedEmpty) {
    // 预置服务商：补齐中文名、升级旧模型 ID；seedEmpty=true 时（仅首次迁移）补上默认模型
    const upgrades = { 'glm-4': 'glm-4.6', 'glm-4-plus': 'glm-4.6', 'openai/gpt-4o-mini': 'openai/gpt-4.1-mini' };
    for (const p of providers) {
      if (!p.preset) continue;
      const def = MM.defaults.PRESET_PROVIDERS.find(x => x.id === p.id);
      if (def && def.name) p.name = def.name;
      for (const mo of p.models) {
        if (upgrades[mo.modelId]) mo.modelId = upgrades[mo.modelId];
      }
      p.models = p.models.filter(mo => mo.modelId);
      // 只在此前从没配过该服务商时补默认模型，尊重用户主动清空
      if (seedEmpty && !p.models.length && def && !p.seeded) {
        p.models = JSON.parse(JSON.stringify(def.models));
        p.seeded = true;
      }
    }
  }

  async function init() {
    MM.state = {
      config: JSON.parse(JSON.stringify(MM.defaults.DEFAULT_CONFIG)),
      sessions: [],
      currentId: null,
      catalog: null
    };

    let saved = null;
    try { saved = await api.getAll(); } catch (e) { saved = null; }
    if (saved && saved.config && Array.isArray(saved.config.providers) && saved.config.providers.length) {
      // 新结构
      MM.state.config.providers = saved.config.providers;
      MM.state.config.search = Object.assign({ provider: 'bing', apiKey: '' }, saved.config.search || {});
      MM.state.config.synthesis = Object.assign({ mode: 'frontend', modelKey: '', autoMerge: true }, saved.config.synthesis || {});
      fillPresetDefaults(MM.state.config.providers, false);
      // 旧字段兼容：synthesis.modelId → modelKey
      if (!MM.state.config.synthesis.modelKey && saved.config.synthesis && saved.config.synthesis.modelId) {
        for (const p of MM.state.config.providers) {
          const hit = (p.models || []).find(mo => mo.modelId === saved.config.synthesis.modelId);
          if (hit) { MM.state.config.synthesis.modelKey = p.id + '::' + hit.modelId; break; }
        }
      }
    } else if (saved && saved.config && Array.isArray(saved.config.models) && saved.config.models.length) {
      // 旧结构迁移
      MM.state.config.providers = migrateFlatModels(saved.config.models);
      MM.state.config.search = Object.assign({ provider: 'bing', apiKey: '' }, saved.config.search || {});
      MM.state.config.synthesis = Object.assign({ mode: 'frontend', modelKey: '', autoMerge: true }, saved.config.synthesis || {});
      // 旧综合模型引用 modelId → modelKey
      if (saved.config.synthesis && saved.config.synthesis.modelId) {
        for (const p of MM.state.config.providers) {
          const hit = p.models.find(mo => mo.modelId === saved.config.synthesis.modelId);
          if (hit) { MM.state.config.synthesis.modelKey = p.id + '::' + hit.modelId; break; }
        }
      }
      fillPresetDefaults(MM.state.config.providers, true);
    } else {
      // 全新安装：预置服务商（Key 为空，等用户填写）
      MM.state.config.providers = JSON.parse(JSON.stringify(MM.defaults.PRESET_PROVIDERS));
    }
    if (!MM.state.sessions.length) MM.sessions.createSilent();
    MM.state.currentId = MM.state.sessions[0] ? MM.state.sessions[0].id : null;

    // 恢复主题
    try {
      const t = localStorage.getItem('mmc-theme');
      if (t) document.documentElement.setAttribute('data-theme', t);
    } catch (e) { /* ignore */ }
    U.$('#tgl-auto').checked = !!MM.state.config.synthesis.autoMerge;

    MM.chat.bind();
    MM.settings.bind();
    MM.sessions.render();
    MM.chat.renderChips();
    MM.chat.renderTitle();
    MM.chat.renderAll();
  }

  const U = MM.util;

  MM.save = function () {
    api.saveAll({ config: MM.state.config, sessions: MM.state.sessions }).catch(function () { });
  };

  document.addEventListener('DOMContentLoaded', function () {
    try {
      init();
      console.log('[mmc] init done');
    } catch (e) {
      console.error('[mmc] init error: ' + (e && e.stack || e));
    }
  });
})();
