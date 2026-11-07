'use strict';
// 预置模型目录与 presetVersion 6 迁移回归（零拉起）：新模型补发 / 删除尊重 / 手填保护 / 元数据对齐 / 幂等
// app.js 是渲染层脚本：Node 里用 window/document 桩加载，只测 MM.normalizeConfig 纯函数
const path = require('path');
let pass = 0, fail = 0;
function check(label, ok, detail) {
  if (ok) { pass++; console.log('  PASS ' + label); }
  else { fail++; console.log('  FAIL ' + label + (detail !== undefined ? ' -> ' + JSON.stringify(detail) : '')); }
}

// 浏览器里裸 MM 与 window.MM 同指一个全局；Node 桩也必须共享同一对象
global.MM = global.window = {};
global.document = { addEventListener: function () {} };
require(path.join(__dirname, '..', 'src', 'renderer', 'js', 'app.js'));
const MM = global.MM;

// 预置目录总量：18 个既有模型 + 11 个新模型（9 家直连 + 2 条 OpenRouter 镜像）
const EXPECT_FRESH = 29;

// v5 时代的老配置：moonshot 只有两个旧模型（k3 带过期元数据与手填价）；minimax 已被用户删除；zhipu 被清空
function oldConfig() {
  return {
    presetVersion: 5,
    providers: [
      {
        id: 'moonshot', name: 'Kimi 月之暗面', provider: 'moonshot', apiFormat: 'openai',
        baseUrl: 'https://api.moonshot.cn/v1', preset: true,
        models: [
          { modelId: 'kimi-k3', name: 'Kimi K3', enabled: true, contextTokens: 1, maxTokens: 1, multimodal: false, priceIn: 9.9, priceOut: 1, priceCache: 0.1 },
          { modelId: 'my-kimi', name: '我的 Kimi', enabled: true }
        ]
      },
      {
        id: 'zhipu', name: '智谱 BigModel', provider: 'zhipu', apiFormat: 'openai',
        baseUrl: 'https://open.bigmodel.cn/api/paas/v4', preset: true,
        models: []
      }
    ]
  };
}

// ---- 场景 1：v5 老配置升级 → 补新模型、带官方价、元数据对齐 ----
const up = MM.normalizeConfig(oldConfig());
const ms = up.providers.find(p => p.id === 'moonshot');
check('升级后 presetVersion=6', up.presetVersion === 6, up.presetVersion);
check('补入 kimi-k3.1-pro 且带官方单价', !!ms.models.find(m => m.modelId === 'kimi-k3.1-pro' && m.priceIn === 1.9437 && m.priceOut === 10.1671),
  ms.models.map(m => m.modelId));
check('补入条目标记 fromPreset', ms.models.find(m => m.modelId === 'kimi-k3.1-pro').fromPreset === true, '');
check('既有模型手填价不被改写（fill-missing）', ms.models.find(m => m.modelId === 'kimi-k3').priceIn === 9.9,
  ms.models.find(m => m.modelId === 'kimi-k3').priceIn);
check('既有模型元数据对齐官方值（ctx 1→1048576）', ms.models.find(m => m.modelId === 'kimi-k3').contextTokens === 1048576,
  ms.models.find(m => m.modelId === 'kimi-k3').contextTokens);
check('用户自加模型原样保留', !!ms.models.find(m => m.modelId === 'my-kimi') && !ms.models.find(m => m.modelId === 'my-kimi').priceIn, '');

// ---- 场景 2/3：删除尊重 ----
check('被删除的整个服务商不回加', !up.providers.some(p => p.id === 'minimax'), up.providers.map(p => p.id));
const zp = up.providers.find(p => p.id === 'zhipu');
check('模型被清空的服务商不被回填', !!zp && zp.models.length === 0, zp && zp.models.length);

// ---- 场景 4：全新安装拿到完整新目录，全部带单价 ----
const fresh = MM.normalizeConfig({});
const total = fresh.providers.reduce((n, p) => n + p.models.length, 0);
check('全新安装共 ' + EXPECT_FRESH + ' 个模型（18 既有 + 11 新增）', total === EXPECT_FRESH, total);
const noPrice = fresh.providers.flatMap(p => p.models).filter(m => m.priceIn == null || m.priceOut == null);
check('全部模型带官方单价', noPrice.length === 0, noPrice.map(m => m.modelId));
for (const id of ['kimi-k3.1-pro', 'qwen3.8-omni-flash', 'glm-5.3-flashx', 'glm-5v-turbo', 'gpt-6-astra', 'gpt-6.1-terra', 'gpt-6-luna', 'claude-fable-5-1', 'claude-haiku-5-5', 'openai/gpt-6.1-terra', 'anthropic/claude-fable-5.1']) {
  const hit = fresh.providers.some(p => (p.models || []).some(m => m.modelId === id));
  check('新模型在目录：' + id, hit, '');
}
check('全新安装不残留空 apiKey 占位', fresh.providers.every(p => !('apiKey' in p)), '');

// ---- 场景 5：幂等（升级跑两遍不重复补、不漂移） ----
const again = MM.normalizeConfig(JSON.parse(JSON.stringify({ presetVersion: 6, providers: up.providers })));
const ms2 = again.providers.find(p => p.id === 'moonshot');
check('二次归一不重复补模型', ms2.models.filter(m => m.modelId === 'kimi-k3.1-pro').length === 1, ms2.models.map(m => m.modelId));
check('二次归一模型总数不变', ms2.models.length === ms.models.length, ms2.models.length);

console.log('\nRESULT pass=' + pass + ' fail=' + fail);
process.exit(fail ? 1 : 0);
