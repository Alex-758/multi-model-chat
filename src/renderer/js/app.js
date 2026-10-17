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
    synthesis: { synthSource: 'frontend', autoMerge: true }
  }
};

(function () {
  // 把旧版平铺的 config.models（每条含完整连接信息）迁移为分层 config.providers
  function migrateFlatModels(flatModels) {
    const byId = new Map();
    for (const m of (flatModels || [])) {
      if (!m || typeof m !== 'object') continue;
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
    for (const p of (providers || [])) {
      if (!p || typeof p !== 'object' || !p.preset) continue;
      const def = MM.defaults.PRESET_PROVIDERS.find(x => x.id === p.id);
      if (def && def.name) p.name = def.name;
      // 配置可能来自导入/手改：models 缺失或不是数组时补空数组，避免整段初始化中断
      p.models = (Array.isArray(p.models) ? p.models : []).filter(mo => mo && typeof mo === 'object');
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

  // 旧综合设置迁移：1.0/1.1 的 mode='model'+modelKey、更旧的 modelId → synthSource
  function normalizeSynth(rawSyn, providers) {
    const syn = Object.assign({ synthSource: 'frontend', autoMerge: true }, rawSyn || {});
    if (rawSyn && !rawSyn.synthSource) {
      if (rawSyn.mode === 'model' && rawSyn.modelKey) {
        syn.synthSource = rawSyn.modelKey;
      } else if (rawSyn.modelId) {
        // 更旧：只存了 modelId，按模型 ID 反查所属服务商
        for (const p of providers) {
          const hit = (p.models || []).find(mo => mo.modelId === rawSyn.modelId);
          if (hit) { syn.synthSource = p.id + '::' + hit.modelId; break; }
        }
      }
    }
    return syn;
  }

  // 把任意来源的配置（磁盘数据 / 导入备份 / 全新安装）统一为当前结构。
  // 启动加载与「导入数据」共用这一条迁移路径，避免两边行为不一致。
  // 注意：1.0 备份迁移后 providers 上仍带明文密钥，调用方落盘后需用 stripSecrets 剥离。
  MM.normalizeConfig = function (raw) {
    const cfg = JSON.parse(JSON.stringify(raw || {}));
    let providers;
    if (Array.isArray(cfg.providers) && cfg.providers.length) {
      providers = cfg.providers;
      fillPresetDefaults(providers, false);
    } else if (Array.isArray(cfg.models) && cfg.models.length) {
      // 1.0 平铺结构迁移
      providers = migrateFlatModels(cfg.models);
      fillPresetDefaults(providers, true);
    } else {
      // 全新安装：预置服务商（Key 为空，等用户填写）
      providers = JSON.parse(JSON.stringify(MM.defaults.PRESET_PROVIDERS));
    }
    delete cfg.models;
    // 丢弃非法条目，并保证每个服务商都有 models 数组（导入/手改数据可能缺字段）
    providers = providers.filter(p => p && typeof p === 'object');
    for (const p of providers) {
      if (!Array.isArray(p.models)) p.models = [];
      if (typeof p.hasKey !== 'boolean') p.hasKey = !!(p.apiKey || '').trim();
    }
    // 保留 modelLists 等其余字段（此前启动时被整体丢弃，导致模型列表缓存永远无法跨重启生效）
    return Object.assign({}, cfg, {
      providers,
      // 不注入 apiKey 占位：渲染层状态里不该出现密钥字段（hasKey 才是渲染层可见的标记）
      search: Object.assign({ provider: 'bing' }, cfg.search || {}),
      synthesis: normalizeSynth(cfg.synthesis, providers)
    });
  };

  // 渲染层不持有密钥：主进程接管保存后，把明文密钥从渲染层状态中剥离
  MM.stripSecrets = function (cfg) {
    for (const p of (cfg.providers || [])) {
      p.hasKey = !!(p.apiKey || '').trim();
      delete p.apiKey;
    }
    if (cfg.search) {
      cfg.search.hasKey = !!(cfg.search.apiKey || '').trim();
      delete cfg.search.apiKey;
    }
    return cfg;
  };

  // 旧数据迁移：
  // 1) 旧格式的独立 merge 消息折叠进其所属轮次的 assistant 消息（am.merge）
  // 2) 为没有版本历史的轮次生成首份快照，使版本切换/回滚可用
  MM.migrateSessions = function (sessions) {
    let changed = false;
    for (const s of (sessions || [])) {
      if (!s || typeof s !== 'object' || !Array.isArray(s.messages)) continue;
      const keep = [];
      for (const m of s.messages) {
        if (!m || typeof m !== 'object') continue;
        if (m.role === 'merge') {
          const am = keep.slice().reverse().find(x => x.role === 'assistant' && x.roundId === m.roundId);
          if (am) {
            am.merge = { content: m.content || '', mode: m.mode || 'frontend', createdAt: m.createdAt || Date.now() };
            changed = true;
            continue; // 独立 merge 消息不再保留
          }
        }
        keep.push(m);
      }
      s.messages = keep;
      // 版本快照种子
      for (const am of s.messages) {
        if (!am || typeof am !== 'object') continue;
        if (am.role !== 'assistant' || !Array.isArray(am.results) || !am.results.length) continue;
        if (!Array.isArray(am.versions) || !am.versions.length) {
          am.versions = [{
            results: JSON.parse(JSON.stringify(am.results)),
            merge: am.merge ? JSON.parse(JSON.stringify(am.merge)) : null,
            at: am.createdAt || Date.now()
          }];
          am.active = 0;
          changed = true;
        }
        if (typeof am.active !== 'number' || am.active < 0) {
          am.active = am.versions.length - 1;
        }
      }
    }
    return changed;
  };

  async function init() {
    MM.state = {
      config: JSON.parse(JSON.stringify(MM.defaults.DEFAULT_CONFIG)),
      sessions: [],
      currentId: null,
      catalog: null
    };

    let saved = null;
    try { saved = await api.getAll(); } catch (e) { saved = null; }
    if (saved && saved.config) MM.state.config = MM.normalizeConfig(saved.config);
    // 恢复历史会话：缺了这一步会以空会话覆盖磁盘上的全部记录
    if (saved && Array.isArray(saved.sessions)) MM.state.sessions = saved.sessions;
    if (!MM.state.sessions.length) MM.sessions.createSilent();
    // 旧格式会话迁移（merge 折叠 + 版本快照种子）
    if (MM.migrateSessions(MM.state.sessions)) MM.save();
    // 打开侧栏排在最前的那条会话（与列表展示顺序一致）
    const topSession = MM.sessions.sorted()[0];
    MM.state.currentId = topSession ? topSession.id : null;
    // 1.0 结构迁移后渲染层可能持有明文密钥：先交给主进程保管，再从状态中剥离
    if (MM.state.config.providers.some(p => p.apiKey)) {
      MM.save().then(function (ok) { if (ok) MM.stripSecrets(MM.state.config); });
    }

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

  let saveFailToastAt = 0;
  MM.save = function () {
    // 返回是否落盘成功：调用方据此判断能否安全丢弃本地明文密钥等临时状态
    return api.saveAll({ config: MM.state.config, sessions: MM.state.sessions })
      .then(function () { return true; })
      .catch(function (e) {
        // 写盘失败不能静默：5 秒内最多提示一次，避免防抖保存刷屏
        const now = Date.now();
        if (now - saveFailToastAt > 5000) {
          saveFailToastAt = now;
          U.toast('保存失败：' + ((e && e.message) || e) + '（数据可能未写入磁盘）', true);
        }
        return false;
      });
  };

  // 初始化失败时给出可见提示，而不是留下一个空白/半死的界面
  function showFatalError(err) {
    const detail = String((err && (err.stack || err.message)) || err || '未知错误');
    console.error('[mmc] init error: ' + detail);
    if (document.getElementById('fatal-error')) return;
    const box = document.createElement('div');
    box.id = 'fatal-error';
    box.setAttribute('style', 'position:fixed;inset:0;z-index:999;display:flex;align-items:center;justify-content:center;background:rgba(15,18,28,.55);padding:24px;');
    const panel = document.createElement('div');
    panel.setAttribute('style', 'max-width:640px;width:100%;background:#fff;color:#1f2329;border-radius:12px;padding:22px 24px;font-size:13px;line-height:1.7;box-shadow:0 18px 60px rgba(0,0,0,.35);');
    panel.innerHTML = '<h2 style="font-size:16px;margin:0 0 8px">应用初始化失败</h2>' +
      '<p style="margin:0 0 10px;color:#6b7280">数据文件可能已损坏或格式异常。请先备份 <code>%APPDATA%\\Multi-Model Chat\\store.json</code>，再重新加载；如需重置，可删除该文件后重启（会话记录会丢失）。</p>';
    const pre = document.createElement('pre');
    pre.setAttribute('style', 'max-height:180px;overflow:auto;background:#f2f3f5;border-radius:8px;padding:10px;font-size:11px;white-space:pre-wrap;word-break:break-all;');
    pre.textContent = detail;
    const btn = document.createElement('button');
    btn.textContent = '重新加载';
    btn.setAttribute('style', 'margin-top:14px;background:#4f5bef;color:#fff;border:none;border-radius:8px;padding:8px 16px;font-size:13px;cursor:pointer;');
    btn.addEventListener('click', function () { location.reload(); });
    panel.appendChild(pre);
    panel.appendChild(btn);
    box.appendChild(panel);
    document.body.appendChild(box);
  }

  document.addEventListener('DOMContentLoaded', function () {
    // init 是 async：必须用 .catch 接住异步抛错，try/catch 对 Promise 拒绝无效
    init().catch(showFatalError);
  });
})();
