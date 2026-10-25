'use strict';
// 统一的模型客户端：兼容 OpenAI Chat Completions 与 Anthropic Messages 两种 API 格式
// 支持流式(SSE)输出、reasoning 思考链、原生联网搜索开关、模型列表、连通性测试

function normalizeBase(url) { return (url || '').trim().replace(/\/+$/, ''); }

// 支持 stream_options.include_usage 的预置服务商。
// 只对确认支持的服务商开启：自定义/自托管端点（Ollama、vLLM 等）传未知参数可能报错，
// Anthropic 格式自带 usage，不需要此参数。
const STREAM_USAGE_PROVIDERS = {
  deepseek: 1, moonshot: 1, dashscope: 1, zhipu: 1, openrouter: 1, openai: 1
};

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
    const body = { model: m.modelId, max_tokens: Math.floor(m.maxTokens || 8192), messages: msgs, stream };
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
  // 流式用量统计：OpenAI 格式默认不在流里回 usage，需显式开启。
  // 只对确认支持该参数的服务商开启——未知端点/自定义端点传未知参数可能直接 400，
  // Anthropic 格式自带 usage（message_start / message_delta），无需此参数。
  if (stream && m.apiFormat !== 'anthropic' && STREAM_USAGE_PROVIDERS[m.provider || m.id]) {
    body.stream_options = { include_usage: true };
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

// 把"完整 JSON 响应"归一成与流式一致的形状（兼容 OpenAI / Anthropic）。
// 部分兼容端点或代理会忽略 stream:true 直接返回完整 JSON，只按 SSE 解析会得到空白回答。
function textOf(v) {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map(x => (typeof x === 'string' ? x : (x && x.text) || '')).join('');
  return '';
}
function extractFull(j, format) {
  const out = { content: '', reasoning: '', input: null, output: null, error: '' };
  if (!j || typeof j !== 'object') return out;
  if (format === 'anthropic') {
    for (const b of (Array.isArray(j.content) ? j.content : [])) {
      if (!b) continue;
      if (b.type === 'text' && b.text) out.content += b.text;
      else if (b.type === 'thinking' && b.thinking) out.reasoning += b.thinking;
    }
    const u = j.usage || {};
    if (u.input_tokens != null) out.input = u.input_tokens;
    if (u.output_tokens != null) out.output = u.output_tokens;
  } else {
    const ch = (j.choices && j.choices[0]) || null;
    const msg = (ch && (ch.message || ch.delta)) || {};
    out.content = textOf(msg.content);
    out.reasoning = msg.reasoning_content || msg.reasoning || '';
    if (!out.content && ch && typeof ch.text === 'string') out.content = ch.text;
    const u = j.usage || {};
    if (u.prompt_tokens != null) out.input = u.prompt_tokens;
    if (u.completion_tokens != null) out.output = u.completion_tokens;
    if (out.input == null && u.input_tokens != null) out.input = u.input_tokens;
    if (out.output == null && u.output_tokens != null) out.output = u.output_tokens;
  }
  const e = j.error;
  if (e) out.error = String(typeof e === 'string' ? e : (e.message || e.msg || JSON.stringify(e))).slice(0, 200);
  else if (!out.content && !out.reasoning && typeof j.message === 'string') out.error = j.message.slice(0, 200);
  return out;
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
  // token 用量：各服务商字段名不同，统一归一成 {input, output}；无法取得时为 null，界面就不显示
  let usage = null;
  const noteUsage = (inp, out) => {
    if (inp == null && out == null) return;
    usage = {
      input: (usage && usage.input) || 0,
      output: (usage && usage.output) || 0
    };
    if (inp != null) usage.input = Math.max(usage.input, Math.floor(inp));
    if (out != null) usage.output = Math.max(usage.output, Math.floor(out));
  };
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

    const dec = new TextDecoder();
    let buf = '';
    let sawData = false; // 是否出现过 SSE 的 data: 行
    let rawText = '';    // 未知 Content-Type 时用于回退成"完整 JSON"解析
    // 单行 SSE 处理；抽成函数是为了流结束时能处理最后一行（可能没有换行结尾）
    const handleLine = (line) => {
      if (!line.startsWith('data:')) return;
      sawData = true;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') return;
      let j;
      try { j = JSON.parse(data); } catch (e) { return; }

      if (m.apiFormat === 'anthropic') {
        if (j.type === 'content_block_delta') {
          const d = j.delta || {};
          if (d.type === 'text_delta' && d.text) { content += d.text; onEvent({ type: 'delta', text: d.text }); }
          else if (d.type === 'thinking_delta' && d.thinking) { reasoning += d.thinking; onEvent({ type: 'reasoning', text: d.thinking }); }
        } else if (j.type === 'message_start') {
          // Anthropic 的 usage 分两次到：起点只有输入，终点才有输出，需要累加
          const u = j.message && j.message.usage;
          if (u) noteUsage(u.input_tokens, u.output_tokens);
        } else if (j.type === 'message_delta') {
          const u = j.usage;
          if (u) noteUsage(u.input_tokens, u.output_tokens);
        } else if (j.type === 'error') {
          throw new Error(j.error && j.error.message || '流式返回错误');
        }
      } else {
        // 用量可能出现在任意 chunk（多数服务商只在最后一块），覆盖而非累加
        if (j.usage) noteUsage(j.usage.prompt_tokens, j.usage.completion_tokens);
        const ch = j.choices && j.choices[0];
        if (!ch) return;
        const d = ch.delta || {};
        if (d.content) { content += d.content; onEvent({ type: 'delta', text: d.content }); }
        const r = d.reasoning_content != null ? d.reasoning_content : d.reasoning;
        if (r) { reasoning += r; onEvent({ type: 'reasoning', text: r }); }
      }
    };

    // 明确是 JSON：一次性读完按完整响应解析（有些端点会忽略 stream:true）
    const ctype = String(res.headers.get('content-type') || '').toLowerCase();
    if (ctype.indexOf('json') >= 0 && ctype.indexOf('event-stream') < 0) {
      const text = await res.text();
      let full = null;
      try { full = extractFull(JSON.parse(text), m.apiFormat); } catch (e) { full = null; }
      if (full) {
        if (!full.content && !full.reasoning) {
          throw new Error(full.error ? '服务端返回错误：' + full.error : '服务端未返回任何内容（响应格式无法识别）');
        }
        if (full.content) { content = full.content; onEvent({ type: 'delta', text: full.content }); }
        if (full.reasoning) { reasoning = full.reasoning; onEvent({ type: 'reasoning', text: full.reasoning }); }
        noteUsage(full.input, full.output);
        return { content, reasoning, usage };
      }
      // 不是 JSON：按 SSE 文本继续解析（有些端点 Content-Type 写错）
      for (const line of text.split('\n')) handleLine(line.trim());
      if (!content && !reasoning && !sawData) throw new Error('服务端未返回任何内容（响应格式无法识别）');
      return { content, reasoning, usage };
    }

    // 流式读取（Content-Type 是 event-stream，或未声明为 JSON）
    const reader = res.body.getReader();
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
      const text = dec.decode(value, { stream: true });
      buf += text;
      if (!sawData) rawText += text;
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        handleLine(line);
      }
    }
    if (buf.trim()) handleLine(buf.trim()); // 末尾无换行的最后一条数据
    // Content-Type 缺失/写错且整段没有 data: 行：可能是被当成流的完整 JSON
    if (!content && !reasoning && !sawData && rawText.trim()) {
      let full = null;
      try { full = extractFull(JSON.parse(rawText), m.apiFormat); } catch (e) { full = null; }
      if (full && (full.content || full.reasoning)) {
        if (full.content) { content = full.content; onEvent({ type: 'delta', text: full.content }); }
        if (full.reasoning) { reasoning = full.reasoning; onEvent({ type: 'reasoning', text: full.reasoning }); }
        noteUsage(full.input, full.output);
      } else if (full && full.error) {
        throw new Error('服务端返回错误：' + full.error);
      }
    }
    if (!content && !reasoning && !sawData) throw new Error('服务端未返回任何内容（响应格式无法识别）');
    return { content, reasoning, usage };
  } catch (e) {
    if (abortedByTimeout) throw new Error('连接超时：服务器超过 120 秒没有返回数据，已中断');
    if ((signal && signal.aborted) || /abort/i.test(String(e && e.name))) {
      // 已停止也要把已产生的 token 用量带出去，界面才能对半截回答显示统计
      const err = new Error('已停止'); err.stopped = true; err.usage = usage; throw err;
    }
    e.usage = usage;
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
