'use strict';
// 入口：初始化全局状态、从主进程加载数据、启动渲染
window.MM = window.MM || {};

MM.defaults = {
  // 服务商展示顺序：国内 → 国际 → 自定义
  // 同组内按此固定次序；不在此表中的预置服务商排在国际之后，自定义服务商始终最后
  // 排序表按「国内 → 国际」排列；siliconflow 是历史遗留预置（已不预置新装），
  // 但仍可能留在老配置里，所以放在国内组末尾，避免它掉到国际组后面造成分组割裂。
  PROVIDER_ORDER: ['deepseek', 'moonshot', 'dashscope', 'zhipu', 'minimax', 'siliconflow', 'openai', 'anthropic', 'google', 'openrouter'],

  // 预置服务商：连接信息共享，每个服务商下可挂多个模型
  PRESET_PROVIDERS: [
    {
      id: 'deepseek', name: 'DeepSeek', provider: 'deepseek',
      apiFormat: 'openai', baseUrl: 'https://api.deepseek.com', apiKey: '', fullUrl: false, preset: true,
      models: [
        { modelId: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', enabled: true, contextTokens: 1048576, maxTokens: 393216, multimodal: false },
        { modelId: 'deepseek-flash', name: 'DeepSeek V4.1 Flash', enabled: true, contextTokens: 1048576, maxTokens: 393216, multimodal: true }
      ]
    },
    {
      id: 'moonshot', name: 'Kimi 月之暗面', provider: 'moonshot',
      apiFormat: 'openai', baseUrl: 'https://api.moonshot.cn/v1', apiKey: '', fullUrl: false, preset: true,
      models: [
        { modelId: 'kimi-k3', name: 'Kimi K3', enabled: true, contextTokens: 1048576, maxTokens: 1048576, multimodal: true },
        { modelId: 'kimi-k2.6', name: 'Kimi K2.6', enabled: true, contextTokens: 262144, maxTokens: 262144, multimodal: true }
      ]
    },
    {
      id: 'dashscope', name: '阿里百炼', provider: 'dashscope',
      apiFormat: 'openai', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', apiKey: '', fullUrl: false, preset: true,
      models: [
        { modelId: 'qwen3.8-max', name: 'Qwen3.8 Max', enabled: true, contextTokens: 1000000, maxTokens: 131072, multimodal: true },
        { modelId: 'qwen3.8-flash', name: 'Qwen3.8 Flash', enabled: true, contextTokens: 1000000, maxTokens: 131072, multimodal: true }
      ]
    },
    {
      id: 'zhipu', name: '智谱 BigModel', provider: 'zhipu',
      apiFormat: 'openai', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', apiKey: '', fullUrl: false, preset: true,
      models: [
        { modelId: 'glm-5.3', name: 'GLM-5.3', enabled: true, contextTokens: 1000000, maxTokens: 131072, multimodal: false },
        { modelId: 'glm-5.3-flash', name: 'GLM-5.3 Flash', enabled: true, contextTokens: 1000000, maxTokens: 131072, multimodal: true }
      ]
    },
    {
      // 走 Anthropic 兼容端点：该接口只支持 M3.1-Flash / M3 两个模型
      id: 'minimax', name: 'MiniMax', provider: 'minimax',
      apiFormat: 'anthropic', baseUrl: 'https://api.minimax.cn/anthropic', apiKey: '', fullUrl: false, preset: true,
      models: [
        { modelId: 'MiniMax-M3.1-Flash', name: 'MiniMax M3.1 Flash', enabled: true, contextTokens: 1000000, maxTokens: 524288, multimodal: true },
        { modelId: 'MiniMax-M3', name: 'MiniMax M3', enabled: true, contextTokens: 1000000, maxTokens: 524288, multimodal: true }
      ]
    },
    {
      id: 'openai', name: 'OpenAI', provider: 'openai',
      apiFormat: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: '', fullUrl: false, preset: true,
      models: [
        { modelId: 'gpt-6.1-sol', name: 'GPT-6.1 Sol', enabled: true, contextTokens: 1050000, maxTokens: 128000, multimodal: true },
        { modelId: 'gpt-5.6', name: 'GPT-5.6', enabled: true, contextTokens: 1050000, maxTokens: 128000, multimodal: true }
      ]
    },
    {
      // 官方 Messages API：与 OpenAI 格式不同，走 anthropic 分支（x-api-key + anthropic-version）
      id: 'anthropic', name: 'Anthropic', provider: 'anthropic',
      apiFormat: 'anthropic', baseUrl: 'https://api.anthropic.com', apiKey: '', fullUrl: false, preset: true,
      models: [
        { modelId: 'claude-opus-5-5', name: 'Claude Opus 5.5', enabled: true, contextTokens: 1000000, maxTokens: 128000, multimodal: true },
        { modelId: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', enabled: true, contextTokens: 1000000, maxTokens: 128000, multimodal: true }
      ]
    },
    {
      // Gemini 的 OpenAI 兼容端点：baseUrl 以 /v1beta/openai 结尾，chatEndpoint 会直接拼 /chat/completions
      id: 'google', name: 'Google Gemini', provider: 'google',
      apiFormat: 'openai', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', apiKey: '', fullUrl: false, preset: true,
      models: [
        { modelId: 'gemini-4-argon', name: 'Gemini 4 Argon', enabled: true, contextTokens: 1048576, maxTokens: 32768, multimodal: true },
        { modelId: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash', enabled: true, contextTokens: 1048576, maxTokens: 65536, multimodal: true }
      ]
    },
    {
      id: 'openrouter', name: 'OpenRouter', provider: 'openrouter',
      apiFormat: 'openai', baseUrl: 'https://openrouter.ai/api/v1', apiKey: '', fullUrl: false, preset: true,
      models: [
        { modelId: 'openai/gpt-6.1-sol', name: 'GPT-6.1 Sol', enabled: true, contextTokens: 1050000, maxTokens: 128000, multimodal: true },
        { modelId: 'anthropic/claude-sonnet-5.5', name: 'Claude Sonnet 5.5', enabled: true, contextTokens: 1000000, maxTokens: 128000, multimodal: true }
      ]
    }
  ],

  DEFAULT_CONFIG: {
    providers: [],
    search: { provider: 'bing', apiKey: '' },
    synthesis: { synthSource: 'frontend', autoMerge: true },
    // 全局系统提示词：对所有模型、所有会话生效（按会话覆盖见 session.systemPrompt）
    systemPrompt: ''
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

  // 复制预置定义并给每个模型打上 fromPreset，供后续迁移区分「预置自带」与「用户手填」
  function withPresetFlags(def) {
    const p = JSON.parse(JSON.stringify(def));
    delete p.apiKey; // 预置定义里的 apiKey:'' 是占位，不进入渲染层状态
    for (const mo of (p.models || [])) mo.fromPreset = true;
    return p;
  }

  // 旧模型 ID → 当前模型 ID。按服务商划分：同一个 ID 在不同服务商下是不同的模型，
  // 不能跨服务商改写（例如硅基流动自己也提供 deepseek-chat）。
  // names = 该 ID 在旧版预置里的展示名。只有「模型被标记为预置自带」或「展示名仍是旧预置名」
  // 才升级——用户自己填的 ID、或自己改过的展示名一律不动，避免误改用户配置。
  const LEGACY_PRESET_MODELS = {
    deepseek: {
      'deepseek-chat': { id: 'deepseek-flash', names: ['DeepSeek V3'] },
      'deepseek-reasoner': { id: 'deepseek-v4-pro', names: ['DeepSeek R1 推理'] }
    },
    zhipu: {
      'glm-4.6': { id: 'glm-5.3', names: ['GLM-4.6'] },
      // 更早版本的 ID 没有可靠的展示名特征：只升级明确标记为预置自带的条目
      'glm-4': { id: 'glm-5.3', names: [] },
      'glm-4-plus': { id: 'glm-5.3', names: [] }
    },
    dashscope: {
      'qwen-plus': { id: 'qwen3.8-flash', names: ['Qwen Plus'] },
      'qwen-max': { id: 'qwen3.8-max', names: ['Qwen Max'] }
    },
    openai: {
      'gpt-5.6': { id: 'gpt-6.1-sol', names: ['GPT-5.6'] },
      'gpt-5.5': { id: 'gpt-6.1-sol', names: ['GPT-5.5'] }
    },
    anthropic: {
      'claude-opus-5': { id: 'claude-opus-5-5', names: ['Claude Opus 5'] },
      'claude-sonnet-5': { id: 'claude-sonnet-5-5', names: ['Claude Sonnet 5'] }
    },
    google: {
      'gemini-3.1-pro-preview': { id: 'gemini-4-argon', names: ['Gemini 3.1 Pro'] }
    },
    openrouter: {
      'openai/gpt-4o-mini': { id: 'openai/gpt-6.1-sol', names: ['GPT-4.1 Mini'] },
      'anthropic/claude-sonnet-4.5': { id: 'anthropic/claude-sonnet-5.5', names: ['Claude Sonnet 4.5'] },
      'openai/gpt-5.5': { id: 'openai/gpt-6.1-sol', names: ['GPT-5.5'] },
      'openai/gpt-5.6': { id: 'openai/gpt-6.1-sol', names: ['GPT-5.6'] },
      'anthropic/claude-sonnet-5': { id: 'anthropic/claude-sonnet-5.5', names: ['Claude Sonnet 5'] },
      'anthropic/claude-opus-5': { id: 'anthropic/claude-opus-5.5', names: ['Claude Opus 5'] }
    }
  };

  function fillPresetDefaults(providers, seedEmpty) {
    // 预置服务商：补齐中文名、升级旧模型 ID；seedEmpty=true 时（仅首次迁移）补上默认模型
    for (const p of (providers || [])) {
      if (!p || typeof p !== 'object' || !p.preset) continue;
      const def = MM.defaults.PRESET_PROVIDERS.find(x => x.id === p.id);
      if (def && def.name) p.name = def.name;
      // 配置可能来自导入/手改：models 缺失或不是数组时补空数组，避免整段初始化中断
      p.models = (Array.isArray(p.models) ? p.models : []).filter(mo => mo && typeof mo === 'object');
      // 升级只针对本服务商的旧预置模型，且必须能确认该条目来自预置
      const legacy = LEGACY_PRESET_MODELS[p.id] || {};
      for (const mo of p.models) {
        const rule = legacy[mo.modelId];
        if (!rule) continue;
        const fromPreset = mo.fromPreset === true || (rule.names || []).indexOf(mo.name) >= 0;
        if (!fromPreset) continue; // 用户手工配置的 ID/名称：保持原样
        mo.modelId = rule.id;
        // 展示名同步到新模型，否则会出现「deepseek-flash 显示为 DeepSeek V3」的矛盾
        const target = def && (def.models || []).find(x => x.modelId === rule.id);
        if (target && target.name) mo.name = target.name;
        mo.fromPreset = true;
      }
      p.models = p.models.filter(mo => mo.modelId);
      // 升级后可能撞车（两个旧 ID 指向同一个新模型）：按 modelId 去重，保留先出现的条目
      const seenIds = new Set();
      p.models = p.models.filter(mo => {
        if (seenIds.has(mo.modelId)) return false;
        seenIds.add(mo.modelId);
        return true;
      });
      // 只在此前从没配过该服务商时补默认模型，尊重用户主动清空
      if (seedEmpty && !p.models.length && def && !p.seeded) {
        p.models = JSON.parse(JSON.stringify(def.models));
        for (const mo of p.models) mo.fromPreset = true;
        p.seeded = true;
      }
    }
  }

  // 官方模型数据刷新（一次性，presetVersion 4）：
  // 把预置服务商里「模型 ID 与当前预置一致」的条目，其上下文/最大输出/多模态同步为最新官方值。
  // 用户自己加的模型（ID 不在预置里）一律不动；改过 ID 的视为自定义，保持原样。
  function refreshPresetModelMeta(providers) {
    for (const p of (providers || [])) {
      if (!p || !p.preset) continue;
      const def = MM.defaults.PRESET_PROVIDERS.find(x => x.id === p.id);
      if (!def) continue;
      for (const mo of (p.models || [])) {
        if (!mo || !mo.modelId) continue;
        const target = (def.models || []).find(x => x.modelId === mo.modelId);
        if (!target) continue;
        mo.contextTokens = target.contextTokens;
        mo.maxTokens = target.maxTokens;
        mo.multimodal = target.multimodal;
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
    // 芯片勾选记忆（{on:[],off:[]}）：导入/旧数据里可能是任意形状，清洗成合法结构；
    // 缺失时保持 undefined（渲染层按"全部默认选中"处理，不误建空记录）
    if (cfg.chipSel != null) {
      if (typeof cfg.chipSel !== 'object' || !Array.isArray(cfg.chipSel.on) || !Array.isArray(cfg.chipSel.off)) {
        delete cfg.chipSel;
      } else {
        cfg.chipSel.on = cfg.chipSel.on.filter(x => typeof x === 'string');
        cfg.chipSel.off = cfg.chipSel.off.filter(x => typeof x === 'string');
      }
    }
    // 丢弃非法条目，并保证每个服务商都有 models 数组（导入/手改数据可能缺字段）
    providers = providers.filter(p => p && typeof p === 'object');
    for (const p of providers) {
      if (!Array.isArray(p.models)) p.models = [];
      if (typeof p.hasKey !== 'boolean') p.hasKey = !!(p.apiKey || '').trim();
      // 空密钥占位不留在渲染层（预置服务商定义里带 apiKey:''）；
      // 旧版迁移带来的真实明文密钥仍需保留到保存时，不能一起删掉。
      if (!p.apiKey) delete p.apiKey;
    }
    // 预置服务商更替（一次性，版本号 2）：硅基流动 → Kimi 月之暗面。
    // 只用版本号判断是否执行过，之后用户主动删掉 Kimi 不会再被加回（踩坑 7）。
    // 空硅基流动条目（无模型、无密钥）顺手移除；已配置过的保持原样，不影响用户数据。
    if (!(cfg.presetVersion >= 2)) {
      providers = providers.filter(p => !(p.id === 'siliconflow' && p.preset && !p.models.length && !p.hasKey));
      if (!providers.some(p => p.id === 'moonshot')) {
        const def = MM.defaults.PRESET_PROVIDERS.find(x => x.id === 'moonshot');
        if (def) providers.push(withPresetFlags(def));
      }
      cfg.presetVersion = 2;
    }
    // 预置服务商扩充（一次性，版本号 3）：补上 MiniMax / OpenAI / Anthropic / Google Gemini。
    // 老配置里没有这些条目，用户不点「恢复预置服务商」就永远看不到，所以升级时自动补一次。
    // 同样只用版本号判断，之后用户主动删掉不会再加回（踩坑 7）。
    if (!(cfg.presetVersion >= 3)) {
      for (const id of ['minimax', 'openai', 'anthropic', 'google']) {
        if (providers.some(p => p.id === id)) continue;
        const def = MM.defaults.PRESET_PROVIDERS.find(x => x.id === id);
        if (def) providers.push(withPresetFlags(def));
      }
      cfg.presetVersion = 3;
    }
    // 官方模型数据刷新（一次性，版本号 4）：预置模型的上下文/最大输出/多模态对齐最新官方值
    if (!(cfg.presetVersion >= 4)) {
      refreshPresetModelMeta(providers);
      cfg.presetVersion = 4;
    }
    // 统一排序：国内 → 国际（预置）→ 自定义。
    // 每次加载都重排，保证老配置里被追加到末尾的预置服务商（如迁移补进来的 Kimi）回到正确位置。
    // 自定义服务商之间保持用户添加的先后顺序（sort 稳定）。
    const order = MM.defaults.PROVIDER_ORDER;
    const rank = p => {
      if (!p.preset) return 1000;                       // 自定义始终最后
      const i = order.indexOf(p.id);
      return i < 0 ? 500 : i;                           // 未知预置排在国际之后、自定义之前
    };
    providers = providers.slice().sort((a, b) => rank(a) - rank(b));
    // 保留 modelLists 等其余字段（此前启动时被整体丢弃，导致模型列表缓存永远无法跨重启生效）
    const synthesis = normalizeSynth(cfg.synthesis, providers);
    // 综合来源指向的模型/服务商已被删除时回落前端合并：
    // 否则该配置会一直留在磁盘上，表现为「模型都删了但综合回答还挂着它」
    if (synthesis.synthSource && synthesis.synthSource !== 'frontend') {
      const stillThere = providers.some(p => (p.models || []).some(mo =>
        mo && mo.modelId && p.id + '::' + mo.modelId === synthesis.synthSource));
      if (!stillThere) synthesis.synthSource = 'frontend';
    }
    return Object.assign({}, cfg, {
      providers,
      // 不注入 apiKey 占位：渲染层状态里不该出现密钥字段（hasKey 才是渲染层可见的标记）
      search: Object.assign({ provider: 'bing' }, cfg.search || {}),
      synthesis,
      // 老配置没有此字段：显式归一成字符串，避免界面取到 undefined
      systemPrompt: (typeof cfg.systemPrompt === 'string' ? cfg.systemPrompt : '')
    });
  };

  // 渲染层不持有密钥：主进程接管保存后，把明文密钥从渲染层状态中剥离。
  // 注意 hasKey 不能只用 apiKey 重算：主进程返回的配置本来就没有 apiKey（只有 hasKey），
  // 重算会把"已保存密钥"全部误标成 false（导入备份后曾出现该问题）。
  MM.stripSecrets = function (cfg) {
    const hasPlain = v => typeof v === 'string' && !!v.trim();
    for (const p of (Array.isArray(cfg.providers) ? cfg.providers : [])) {
      if (!p || typeof p !== 'object') continue;
      p.hasKey = hasPlain(p.apiKey) || p.hasKey === true;
      delete p.apiKey;
    }
    if (cfg.search && typeof cfg.search === 'object') {
      cfg.search.hasKey = hasPlain(cfg.search.apiKey) || cfg.search.hasKey === true;
      delete cfg.search.apiKey;
    }
    return cfg;
  };

  // 会话条目校验：磁盘/导入文件里可能有 null、字符串等非法条目。
  // 不清理会在排序时读 s.pinned 抛错，导致启动即失败，且坏数据可能被写回磁盘。
  MM.normalizeSessions = function (list) {
    const out = [];
    for (const s of (Array.isArray(list) ? list : [])) {
      if (!s || typeof s !== 'object') continue;
      if (!Array.isArray(s.messages)) s.messages = [];
      out.push(s);
    }
    return out;
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
        // 旧数据可能没有 roundId：补一个唯一值。
        // 否则「重新生成 / 综合回答」按 roundId 查找时会命中第一条无 id 的回答（改错轮次）。
        if (am.role === 'assistant' && !am.roundId) {
          am.roundId = U.uid();
          changed = true;
        }
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
    try {
      saved = await api.getAll();
    } catch (e) {
      // 读取失败 ≠ 首次安装：继续往下会 createSilent() 并立刻落盘，
      // 用空配置覆盖磁盘上的全部会话与密钥。这里必须停下来交给可见的错误界面。
      throw new Error('读取本地数据失败，已停止启动以避免覆盖原有数据：' + ((e && e.message) || e));
    }
    if (!saved || typeof saved !== 'object' || !saved.config || typeof saved.config !== 'object' || !Array.isArray(saved.sessions)) {
      throw new Error('读取本地数据失败（主进程返回的数据格式异常），已停止启动以避免覆盖原有数据。');
    }
    MM.state.config = MM.normalizeConfig(saved.config);
    // 恢复历史会话：缺了这一步会以空会话覆盖磁盘上的全部记录
    MM.state.sessions = MM.normalizeSessions(saved.sessions);
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
  MM.save = function (opts) {
    // configOnly：只保存配置（设置页、全局提示词）。不传 sessions，
    // 避免把整份会话历史反复结构化克隆给主进程；主进程会保留它内存里的会话数据。
    const payload = (opts && opts.configOnly)
      ? { config: MM.state.config }
      : { config: MM.state.config, sessions: MM.state.sessions };
    // 返回是否落盘成功：调用方据此判断能否安全丢弃本地明文密钥等临时状态
    return api.saveAll(payload)
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
    btn.setAttribute('style', 'margin-top:14px;background:#18181b;color:#fff;border:none;border-radius:8px;padding:8px 16px;font-size:13px;cursor:pointer;');
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
