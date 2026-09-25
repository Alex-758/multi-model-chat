'use strict';
// 模型知识库：根据模型 ID 推断 上下文窗口 / 最大输出 / 多模态能力
// 数值为公开资料的常见配置，标注"约"；未识别时回退服务商默认值
(function () {
  const K = 1024;

  const RULES = [
    // OpenAI
    { re: /gpt-5/, ctx: 400 * K, out: 128 * K, mm: true },
    { re: /\bo[134](-mini|-preview|-pro)?\b/, ctx: 200 * K, out: 100 * K, mm: true },
    { re: /gpt-4\.1/, ctx: 1024 * K, out: 32 * K, mm: true },
    { re: /gpt-4o/, ctx: 128 * K, out: 16 * K, mm: true },
    { re: /gpt-4-turbo/, ctx: 128 * K, out: 4 * K, mm: true },
    { re: /chatgpt-4o/, ctx: 128 * K, out: 16 * K, mm: true },
    { re: /gpt-4/, ctx: 8 * K, out: 4 * K },
    { re: /gpt-3\.5/, ctx: 16 * K, out: 4 * K },
    // Anthropic
    { re: /claude-(opus|sonnet|haiku)-4|claude-4-/, ctx: 200 * K, out: 64 * K, mm: true },
    { re: /claude-3-7|claude-3-5|claude-3\.5/, ctx: 200 * K, out: 8 * K, mm: true },
    { re: /claude-3/, ctx: 200 * K, out: 4 * K, mm: true },
    // Google
    { re: /gemini-2\.5/, ctx: 1024 * K, out: 64 * K, mm: true },
    { re: /gemini-2\.0/, ctx: 1024 * K, out: 8 * K, mm: true },
    { re: /gemini/, ctx: 128 * K, out: 8 * K, mm: true },
    // 智谱 GLM
    { re: /glm-4\.6|glm-4\.7/, ctx: 200 * K, out: 128 * K },
    { re: /glm-4\.5$/, ctx: 128 * K, out: 96 * K },
    { re: /glm-4\.5v|glm-4\.1v|glm-4v|glm-4\.5-airx/, ctx: 64 * K, out: 4 * K, mm: true },
    { re: /glm-4-long/, ctx: 1024 * K, out: 4 * K },
    { re: /glm-4-air|glm-4-flash|glm-4-lite/, ctx: 128 * K, out: 4 * K },
    { re: /glm-4/, ctx: 128 * K, out: 4 * K },
    // DeepSeek
    { re: /deepseek-reasoner|deepseek-r\d/, ctx: 128 * K, out: 8 * K },
    { re: /deepseek-v3\.2|deepseek-v3/, ctx: 128 * K, out: 8 * K },
    { re: /deepseek-vl/, ctx: 32 * K, out: 4 * K, mm: true },
    { re: /deepseek/, ctx: 64 * K, out: 4 * K },
    // 阿里 Qwen
    { re: /qwen3-max|qwen3\.5/, ctx: 256 * K, out: 32 * K },
    { re: /qwen-max/, ctx: 32 * K, out: 8 * K },
    { re: /qwen-plus/, ctx: 131 * K, out: 16 * K },
    { re: /qwen-turbo|qwen-flash/, ctx: 131 * K, out: 8 * K },
    { re: /qwen-vl|qwen-omni|qvq|qwen2-vl|qwen2\.5-vl/, ctx: 32 * K, out: 8 * K, mm: true },
    { re: /qwen3/, ctx: 131 * K, out: 32 * K },
    { re: /qwen2\.5|qwen2/, ctx: 131 * K, out: 8 * K },
    { re: /qwen/, ctx: 32 * K, out: 8 * K },
    // 月之暗面
    { re: /kimi|moonshot/, ctx: 256 * K, out: 8 * K },
    // Meta
    { re: /llama-4/, ctx: 1024 * K, out: 8 * K, mm: true },
    { re: /llama-3/, ctx: 128 * K, out: 8 * K },
    // Mistral
    { re: /mistral|mixtral/, ctx: 128 * K, out: 8 * K },
    // 字节豆包
    { re: /doubao/, ctx: 256 * K, out: 16 * K },
    // MiniMax
    { re: /minimax|abab/, ctx: 245 * K, out: 8 * K },
    // 零一万物
    { re: /yi-/, ctx: 64 * K, out: 4 * K },
    // 百川
    { re: /baichuan/, ctx: 32 * K, out: 4 * K }
  ];

  function lookup(modelId) {
    const id = String(modelId || '').toLowerCase();
    if (!id) return null;
    for (const r of RULES) {
      if (r.re.test(id)) return { ctx: r.ctx, out: r.out, mm: !!r.mm };
    }
    return null;
  }

  function fmt(n) { return n >= K ? Math.round(n / K) + 'K' : String(n); }

  const api = { lookup, fmt };
  if (typeof window !== 'undefined') { window.MM = window.MM || {}; window.MM.modelMeta = api; }
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
