'use strict';
// 模型信息识别：根据模型 ID 推断上下文窗口 / 最大输出 / 是否多模态
// 优先级：服务商 API 元数据 > models.dev 目录 > 内置规则库 > 启发式
window.MM = window.MM || {};

(function () {
  // 规则库：正则按顺序匹配，命中即返回。数据为各服务商公开文档值（tokens）
  // ctx = 上下文窗口, out = 最大输出, mm = 支持图像输入（null 表示不确定，交给启发式）
  const RULES = [
    // ---- 多模态优先（避免被同系列文本规则截住）----
    { p: /deepseek.*vl|deepseek-vl/i, ctx: 131072, out: 8192, mm: true },
    { p: /cogview|cogvideo/i, ctx: 131072, out: 8192, mm: true },
    { p: /qwen.*omni/i, ctx: 1000000, out: 131072, mm: true },
    { p: /qwen.*vl|qvq/i, ctx: 262144, out: 32768, mm: true },
    { p: /llama.*vision/i, ctx: 131072, out: 8192, mm: true },
    { p: /kimi.*vl|kimi-vl/i, ctx: 131072, out: 16384, mm: true },
    { p: /grok.*vision/i, ctx: 131072, out: 16384, mm: true },
    { p: /doubao.*vision/i, ctx: 256000, out: 256000, mm: true },

    // ---- DeepSeek ----
    { p: /deepseek-v4\.1-flash|deepseek-flash/i, ctx: 1048576, out: 393216, mm: true },
    { p: /deepseek-v4-flash|deepseek-v4\.1/i, ctx: 1048576, out: 393216, mm: true },
    { p: /deepseek-v4-pro|deepseek-v4/i, ctx: 1048576, out: 393216, mm: false },
    { p: /deepseek-reasoner|r\d(?![\d])/i, ctx: 131072, out: 65536, mm: false },
    { p: /deepseek-chat|deepseek-v[23]/i, ctx: 131072, out: 8192, mm: false },
    { p: /deepseek/i, ctx: 131072, out: 8192, mm: false },

    // ---- 智谱 GLM ----
    { p: /glm-5v/i, ctx: 200000, out: 131072, mm: true },
    { p: /glm-4\.[5-9]v|glm-4v/i, ctx: 128000, out: 32768, mm: true },
    { p: /glm-5\.[23].*flash/i, ctx: 1000000, out: 131072, mm: true },
    { p: /glm-5\.[23]/i, ctx: 1000000, out: 131072, mm: false },
    { p: /glm-5/i, ctx: 204800, out: 131072, mm: null },
    { p: /glm-4\.[5-9]/i, ctx: 204800, out: 131072, mm: false },
    { p: /glm-4-(plus|air|flash|long|0520|alltools)/i, ctx: 131072, out: 8192, mm: false },
    { p: /glm-4/i, ctx: 131072, out: 4096, mm: false },
    { p: /glm/i, ctx: 131072, out: 8192, mm: null },

    // ---- 阿里 Qwen（百炼）----
    { p: /qwen-long/i, ctx: 10000000, out: 8192, mm: false },
    { p: /qwen3\.[5-9]-(max|plus|flash)/i, ctx: 1000000, out: 131072, mm: true },
    { p: /qwen3\.8/i, ctx: 1000000, out: 131072, mm: true },
    { p: /qwen3-coder/i, ctx: 1048576, out: 65536, mm: false },
    { p: /qwen3\.[5-8]/i, ctx: 262144, out: 65536, mm: null },
    { p: /qwen3-max/i, ctx: 262144, out: 65536, mm: false },
    { p: /qwen3/i, ctx: 131072, out: 16384, mm: null },
    { p: /qwen-flash/i, ctx: 1000000, out: 32768, mm: false },
    { p: /qwen-turbo/i, ctx: 1000000, out: 16384, mm: false },
    { p: /qwen-plus/i, ctx: 1000000, out: 32768, mm: false },
    { p: /qwen-max/i, ctx: 32768, out: 8192, mm: false },
    { p: /qwen/i, ctx: 131072, out: 8192, mm: null },

    // ---- OpenAI ----
    { p: /gpt-6/i, ctx: 1050000, out: 128000, mm: true },
    { p: /gpt-5\.[5-9]|gpt-5-pro/i, ctx: 1050000, out: 128000, mm: true },
    { p: /gpt-5\.[1-4]/i, ctx: 400000, out: 128000, mm: true },
    { p: /gpt-5/i, ctx: 409600, out: 131072, mm: true },
    { p: /(^|\/)o[134](-mini|-pro|-high|-low|-medium)?($|[-.])/i, ctx: 204800, out: 102400, mm: true },
    { p: /gpt-4\.1/i, ctx: 1048576, out: 32768, mm: true },
    { p: /gpt-4o/i, ctx: 131072, out: 16384, mm: true },
    { p: /gpt-4-turbo/i, ctx: 131072, out: 4096, mm: true },
    { p: /gpt-4/i, ctx: 8192, out: 4096, mm: false },
    { p: /gpt-3\.5/i, ctx: 16385, out: 4096, mm: false },

    // ---- Anthropic Claude（全部支持图像输入）----
    { p: /claude-(opus|sonnet|haiku|fable)-5/i, ctx: 1000000, out: 128000, mm: true },
    { p: /claude-(opus-)?4[-.]5|claude-opus-4\.6/i, ctx: 1000000, out: 128000, mm: true },
    { p: /claude/i, ctx: 204800, out: 65536, mm: true },

    // ---- Google Gemini（全部支持图像/音视频输入）----
    { p: /gemini-4|gemini-4-argon/i, ctx: 1048576, out: 32768, mm: true },
    { p: /gemini/i, ctx: 1048576, out: 65536, mm: true },

    // ---- Meta（Muse 系列接替 Llama）----
    { p: /muse-(wonder|spark)/i, ctx: 1048576, out: 131072, mm: true },
    { p: /llama-?4/i, ctx: 1048576, out: 16384, mm: true },
    { p: /llama-?3\.?[23]?/i, ctx: 131072, out: 8192, mm: null },

    // ---- Mistral ----
    { p: /mistral-large-4/i, ctx: 1048576, out: 262144, mm: true },
    { p: /mistral-(medium|small)/i, ctx: 262144, out: 262144, mm: true },
    { p: /mistral|mixtral/i, ctx: 131072, out: 8192, mm: null },

    // ---- Moonshot Kimi ----
    { p: /kimi-k3/i, ctx: 1048576, out: 1048576, mm: true },
    { p: /kimi-k2\.[5-9]/i, ctx: 262144, out: 262144, mm: true },
    { p: /kimi|moonshot/i, ctx: 262144, out: 32768, mm: null },

    // ---- MiniMax ----
    { p: /minimax-m3/i, ctx: 1000000, out: 524288, mm: true },
    { p: /minimax-m2/i, ctx: 204800, out: 131072, mm: false },
    { p: /minimax|abab/i, ctx: 245760, out: 16384, mm: null },

    // ---- 字节 Doubao / Seed ----
    { p: /doubao-seed-2/i, ctx: 256000, out: 256000, mm: true },
    { p: /doubao|skylark/i, ctx: 262144, out: 16384, mm: null },

    // ---- 腾讯混元 ----
    { p: /hunyuan/i, ctx: 262144, out: 16384, mm: null },

    // ---- 百川 ----
    { p: /baichuan/i, ctx: 131072, out: 8192, mm: null },

    // ---- 讯飞星火 ----
    { p: /spark|xinghuo/i, ctx: 131072, out: 8192, mm: null },

    // ---- 阶跃星辰 ----
    { p: /step-[5-9]/i, ctx: 1000000, out: 65536, mm: true },
    { p: /step-3\.[5-9]/i, ctx: 256000, out: 256000, mm: true },
    { p: /step-/i, ctx: 131072, out: 8192, mm: null },

    // ---- xAI Grok ----
    { p: /grok-4\.(2|3)\d*/i, ctx: 1000000, out: 30000, mm: true },
    { p: /grok-4\.[4-9]/i, ctx: 500000, out: 500000, mm: true },
    { p: /grok/i, ctx: 262144, out: 16384, mm: null }
  ];

  // 启发式：规则库未命中时
  function heuristic(s) {
    const info = { ctx: null, out: null, mm: null };
    if (/vl|vision|omni|image|-4v|video|audio/.test(s)) info.mm = true;
    if (/max|pro|plus|large|72b|big/.test(s)) { info.ctx = info.ctx || 131072; info.out = info.out || 8192; }
    if (/mini|small|lite|air|flash|tiny|turbo/.test(s)) { info.ctx = info.ctx || 131072; info.out = info.out || 8192; }
    return info;
  }

  // 提取纯模型名（去掉 deepseek-ai/、openai/ 等 vendor 前缀）
  function bareName(id) {
    return String(id).split('/').pop();
  }

  function matchRules(key, s) {
    for (const r of RULES) {
      if (r.p.test(key)) {
        const h = heuristic(s);
        return {
          contextTokens: r.ctx || h.ctx || null,
          maxOutputTokens: r.out || h.out || null,
          multimodal: r.mm != null ? r.mm : h.mm,
          source: 'builtin'
        };
      }
    }
    return null;
  }

  // 我们的 provider 标识 → models.dev 的 provider 键
  const PROVIDER_ALIAS = { zhipu: 'zhipuai', dashscope: 'alibaba', deepseek: 'deepseek', moonshot: 'moonshotai-cn', siliconflow: 'siliconflow', openrouter: 'openrouter', openai: 'openai', anthropic: 'anthropic', google: 'google', minimax: 'minimax' };

  function lookupCatalog(catalog, provider, id) {
    if (!catalog) return null;
    // 主进程返回 { byId, byProvider }；兼容只拿到平表 byId 的旧缓存
    const byId = catalog.byId || catalog;
    const byProvider = catalog.byProvider || null;
    const full = String(id).toLowerCase();
    const bare = full.split('/').pop();
    // 1. 所属服务商的分桶（避免跨服务商同名模型互相覆盖）
    const pk = PROVIDER_ALIAS[provider] || provider;
    const bucket = byProvider && byProvider[String(pk || '').toLowerCase()];
    if (bucket) {
      const c = bucket[full] || bucket[bare];
      if (c) return c;
    }
    // 2. 全局查找
    return byId[full] || byId[bare] || null;
  }

  /**
   * 猜测模型信息
   * @param id 模型 ID
   * @param apiMeta 服务商 /models 接口的元数据 {context, multimodal}（如 OpenRouter）
   * @param catalog models.dev 目录 {byId, byProvider}
   * @param savedMm 此模型已保存的多模态标记
   * @param provider 我们的服务商标识（用于目录精确匹配）
   * @returns {contextTokens, maxOutputTokens, multimodal, source}
   */
  function guess(id, apiMeta, catalog, savedMm, provider) {
    const raw = String(id);
    const s = bareName(id);
    const lower = raw.toLowerCase();
    const lowerBare = s.toLowerCase();

    // 1. 服务商 API 元数据
    if (apiMeta && (apiMeta.context || apiMeta.multimodal != null)) {
      return {
        contextTokens: apiMeta.context || null,
        maxOutputTokens: null,
        multimodal: apiMeta.multimodal != null ? apiMeta.multimodal : null,
        source: 'api'
      };
    }
    // 2. models.dev 目录
    const c = lookupCatalog(catalog, provider, id);
    if (c && (c.ctx || c.mm)) {
      return { contextTokens: c.ctx || null, maxOutputTokens: c.out || null, multimodal: c.mm, source: 'catalog' };
    }
    // 3. 内置规则库（先试全名，再试裸名）
    const hit = matchRules(raw, s) || matchRules(s, s);
    if (hit) {
      if (hit.multimodal == null && savedMm != null) hit.multimodal = savedMm;
      return hit;
    }
    // 4. 启发式
    const h = heuristic(lower);
    if (h.ctx || h.mm != null) {
      return { contextTokens: h.ctx, maxOutputTokens: h.out, multimodal: h.mm, source: 'guess' };
    }
    // 5. 完全未知
    return { contextTokens: null, maxOutputTokens: null, multimodal: savedMm != null ? savedMm : null, source: 'none' };
  }

  function fmtTokens(n) {
    if (n == null) return '';
    if (n >= 1000000) return (n / 1000000).toFixed(n % 1000000 ? 1 : 0) + 'M';
    if (n >= 1000) return Math.round(n / 1000) + 'K';
    return String(n);
  }

  MM.modelInfo = { guess, fmtTokens };
})();
