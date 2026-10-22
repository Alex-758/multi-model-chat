'use strict';
// 统一的模型客户端：兼容 OpenAI Chat Completions 与 Anthropic Messages 两种 API 格式
// 支持流式(SSE)输出、reasoning 思考链、原生联网搜索开关、模型列表、连通性测试

function normalizeBase(url) { return (url || '').trim().replace(/\/+$/, ''); }

function chatEndpoint(m) {
  const base = normalizeBase(m.baseUrl);
  if (m.fullUrl) return base; // 用户填的就是完整 URL
  if (m.apiFormat === 'anthropic') {
    return /\/v\d+$/.test(base) ? base + '/messages' : base + '/v1/messages';
  }
  if (/\/(chat\/completions|completions)$/.test(base)) return base;
  // Gemini 的 OpenAI 兼容端点形如 .../v1beta/openai，路径到此为止，直接接 /chat/completions
  if (/\/openai$/.test(base)) return base + '/chat/completions';
  return /\/v\d+$/.test(base) ? base + '/chat/completions' : base + '/v1/chat/completions';
}

function modelsEndpoint(m) {
  const base = normalizeBase(m.baseUrl);
  if (m.fullUrl) return base;
  if (/\/openai$/.test(base)) return base + '/models';
  return /\/v\d+$/.test(base) ? base + '/models' : base + '/v1/models';
}

function authHeaders(m) {
  const h = { 'Content-Type': 'application/json', 'User-Agent': 'Multi-Model-Chat/1.0' };
  const key = (m.apiKey || '').trim();
  if (m.apiFormat === 'anthropic') {
    h['x-api-key'] = key;
    h['anthropic-version'] = '2023-06-01';
  } else {
    h['Authorization'] = 'Bearer ' + key;
  }
  return h;
}

// OpenRouter 联网搜索通过模型 ID 加 :online 后缀实现
function requestModelId(m, searchOn) {
  if (searchOn && m.provider === 'openrouter' && !/:online$/.test(m.modelId)) {
    return m.modelId + ':online';
  }
  return m.modelId;
}

function buildBody(m, messages, opts) {
  const { stream, searchOn } = opts;
  if (m.apiFormat === 'anthropic') {
    const system = messages.filter(r => r.role === 'system').map(r => r.content).join('\n\n');
    const msgs = messages.filter(r => r.role !== 'system');
    const body = { model: m.modelId, max_tokens: m.maxTokens || 8192, messages: msgs, stream };
    if (system) body.system = system;
    return body;
  }
  const body = { model: requestModelId(m, searchOn), messages, stream };
  if (m.maxTokens) {
    // 新一代推理模型都已弃用 max_tokens，传了会 400：改用 max_completion_tokens。
    // Kimi 仅 K3 起、OpenAI 的 GPT-5 起为限；其余服务商（含 OpenRouter 中转）仍用 max_tokens。
    const needsCompletionTokens =
      (m.provider === 'moonshot' && /^kimi-k3/i.test(m.modelId || '')) ||
      (m.provider === 'openai' && /^(gpt-5|gpt-6|o\d)/i.test(m.modelId || ''));
    if (needsCompletionTokens) {
      body.max_completion_tokens = Math.floor(m.maxTokens);
    } else {
      body.max_tokens = Math.floor(m.maxTokens);
    }
  }
  if (searchOn) {
    if (m.provider === 'dashscope') body.enable_search = true;           // 阿里百炼原生搜索
    if (m.provider === 'zhipu') {                                        // 智谱原生搜索工具
      body.tools = [{ type: 'web_search', web_search: { enable: true, search_result: false } }];
    }
  }
  return body;
}

async function readError(res) {
  return friendlyHttpError(res.status, await readDetail(res));
}

// 流式对话。onEvent({type:'delta'|'reasoning', text})
async function streamChat(m, messages, opts) {
  const { searchOn, signal, onEvent } = opts;
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  if (signal) {
    if (signal.aborted) throw new Error('已停止');
    signal.addEventListener('abort', onAbort, { once: true });
  }
  // 空闲超时：连接建立后每收到数据就重置；连续 120 秒无任何数据则中断
  let idleTimer = null;
  let abortedByTimeout = false;
  const bumpIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { abortedByTimeout = true; ctrl.abort(); }, 120000);
  };
  bumpIdle();
  let content = '', reasoning = '';
  try {
    let res;
    try {
      res = await fetch(chatEndpoint(m), {
        method: 'POST',
        headers: authHeaders(m),
        body: JSON.stringify(buildBody(m, messages, { stream: true, searchOn })),
        signal: ctrl.signal
      });
    } catch (e) {
      if (abortedByTimeout) throw new Error('连接超时：服务器 120 秒未响应');
      if (signal && signal.aborted) throw new Error('已停止');
      throw new Error('网络请求失败：' + (e.cause && e.cause.message || e.message));
    }
    bumpIdle();
    if (!res.ok) throw new Error(await readError(res));
    if (!res.body) throw new Error('服务端返回了空响应（无响应体）');

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    // 单行 SSE 处理；抽成函数是为了流结束时能处理最后一行（可能没有换行结尾）
    const handleLine = (line) => {
      if (!line.startsWith('data:')) return;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') return;
      let j;
      try { j = JSON.parse(data); } catch (e) { return; }

      if (m.apiFormat === 'anthropic') {
        if (j.type === 'content_block_delta') {
          const d = j.delta || {};
          if (d.type === 'text_delta' && d.text) { content += d.text; onEvent({ type: 'delta', text: d.text }); }
          else if (d.type === 'thinking_delta' && d.thinking) { reasoning += d.thinking; onEvent({ type: 'reasoning', text: d.thinking }); }
        } else if (j.type === 'error') {
          throw new Error(j.error && j.error.message || '流式返回错误');
        }
      } else {
        const ch = j.choices && j.choices[0];
        if (!ch) return;
        const d = ch.delta || {};
        if (d.content) { content += d.content; onEvent({ type: 'delta', text: d.content }); }
        const r = d.reasoning_content != null ? d.reasoning_content : d.reasoning;
        if (r) { reasoning += r; onEvent({ type: 'reasoning', text: r }); }
      }
    };
    for (;;) {
      let chunk;
      try {
        chunk = await reader.read();
      } catch (e) {
        // 超时/用户停止交给外层统一处理；其余情况（连接被重置等）给中文提示
        if (abortedByTimeout || (signal && signal.aborted) || /abort/i.test(String(e && e.name))) throw e;
        throw new Error('流式传输中断：' + ((e && e.message) || e));
      }
      const { done, value } = chunk;
      if (done) break;
      bumpIdle(); // 收到数据，重置空闲计时
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        handleLine(line);
      }
    }
    if (buf.trim()) handleLine(buf.trim()); // 末尾无换行的最后一条数据
    return { content, reasoning };
  } catch (e) {
    if (abortedByTimeout) throw new Error('连接超时：服务器超过 120 秒没有返回数据，已中断');
    if ((signal && signal.aborted) || /abort/i.test(String(e && e.name))) {
      const err = new Error('已停止'); err.stopped = true; throw err;
    }
    throw e;
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

function friendlyHttpError(status, detail) {
  const map = {
    400: '请求格式被拒绝',
    401: 'API Key 无效或未填写',
    402: '账户余额不足',
    403: '无权限访问该模型',
    404: '接口地址或模型 ID 不存在',
    413: '输入内容超过模型上下文长度',
    422: '请求参数不合法',
    429: '触发限流，请稍后重试',
    500: '服务端内部错误',
    502: '服务端网关错误',
    503: '服务端繁忙/过载，请稍后重试',
    504: '服务端超时，请稍后重试'
  };
  const hint = map[status] || '请求失败';
  return hint + '（HTTP ' + status + '）' + (detail ? '：' + detail : '');
}

// 非流式单次对话（用于测试连接）；503/429 自动重试
async function chatOnce(m) {
  const maxAttempts = 3;
  let lastErr = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 45000);
    try {
      const body = buildBody(m, [{ role: 'user', content: '你好' }], { stream: false, searchOn: false });
      // 沿用 buildBody 选定的字段名（新一代推理模型只认 max_completion_tokens），只把值压小省钱
      if (m.apiFormat !== 'anthropic') {
        if ('max_completion_tokens' in body) body.max_completion_tokens = 100;
        else body.max_tokens = 100;
      }
      const res = await fetch(chatEndpoint(m), {
        method: 'POST', headers: authHeaders(m), body: JSON.stringify(body), signal: ctrl.signal
      });
      if (!res.ok) {
        const err = new Error(friendlyHttpError(res.status, (await readDetail(res))));
        err.status = res.status;
        throw err;
      }
      const j = await res.json();
      if (m.apiFormat === 'anthropic') {
        const text = (j.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
        if (text) return text;
        const think = (j.content || []).filter(b => b.type === 'thinking').map(b => b.thinking).join('');
        if (think) return '(模型只返回了思考过程，未输出正文，可正常使用)';
        return '(空回复)';
      }
      const msg = (j.choices && j.choices[0] && j.choices[0].message) || {};
      if (msg.content) return msg.content;
      if (msg.reasoning_content || msg.reasoning) {
        return '(模型只返回了思考过程，未输出正文，可正常使用)';
      }
      return '(空回复)';
    } catch (e) {
      // 超时被 abort 时给中文提示，不要把英文 AbortError 直接抛给界面
      const timedOut = e && (e.name === 'AbortError' || /abort/i.test(String(e.name)));
      const err = timedOut ? new Error('连接超时：服务器 45 秒未响应') : e;
      lastErr = err;
      // 仅对服务端繁忙/限流重试；参数/鉴权错误重试无意义
      const retryable = err.status === 503 || err.status === 429 || err.status === 502 || err.status === 504;
      if (!retryable || attempt === maxAttempts) throw err;
      await new Promise(r => setTimeout(r, 1500 * attempt));
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastErr;
}

async function readDetail(res) {
  try {
    const t = await res.text();
    try {
      const j = JSON.parse(t);
      return String((j.error && (j.error.message || j.error.msg)) || j.message || t).slice(0, 160);
    } catch (e2) { return t.slice(0, 160); }
  } catch (e) { return ''; }
}

// 拉取模型 ID 列表；OpenRouter 等接口附带元数据（上下文长度、多模态）时一并返回
async function listModels(m) {
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 20000);
  try {
    let res;
    try {
      res = await fetch(modelsEndpoint(m), { method: 'GET', headers: authHeaders(m), signal: ctrl.signal });
    } catch (e) {
      if (e && (e.name === 'AbortError' || /abort/i.test(String(e.name)))) throw new Error('连接超时：服务器 20 秒未响应');
      throw new Error('网络请求失败：' + ((e.cause && e.cause.message) || e.message));
    }
    if (!res.ok) throw new Error(await readError(res));
    const j = await res.json();
    const arr = Array.isArray(j.data) ? j.data : (Array.isArray(j.models) ? j.models : []);
    const seen = new Set();
    const out = [];
    for (const x of arr) {
      const id = x.id || x.name;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const item = { id };
      if (x.context_length) item.context = x.context_length;
      else if (x.max_context_length) item.context = x.max_context_length;
      else if (x.context_window) item.context = x.context_window;
      const mods = x.architecture && x.architecture.input_modalities;
      if (mods && mods.length) item.multimodal = mods.indexOf('image') >= 0;
      out.push(item);
    }
    out.sort((a, b) => (a.id < b.id ? -1 : 1));
    return out;
  } finally { clearTimeout(timeout); }
}

module.exports = { streamChat, chatOnce, listModels };
