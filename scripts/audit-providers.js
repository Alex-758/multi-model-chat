// 临时审计脚本：直接测主进程 providers.js 的流式解析边界（不依赖 Electron）。
const http = require('http');
const providers = require('../src/main/providers');

const rows = [];
function check(name, pass, detail) {
  rows.push({ name, pass, detail });
  console.log((pass ? 'PASS' : 'FAIL') + ' | ' + name + ' | ' + detail);
}

let handler = null;
const server = http.createServer((req, res) => handler(req, res));

function model(base) {
  return { apiFormat: 'openai', baseUrl: base, provider: 'deepseek', modelId: 'deepseek-flash', maxTokens: 100 };
}

async function run() {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port + '/v1';

  // 1) 服务端忽略 stream:true，直接返回 JSON（非 SSE）
  handler = (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: '这是一段完整回答' } }] }));
  };
  let out = await providers.streamChat(model(base), [{ role: 'user', content: 'hi' }], { onEvent: () => {} });
  check('非 SSE 的 JSON 响应应被识别（否则界面空白 ✓）', out.content.length > 0,
    'content=' + JSON.stringify(out.content));

  // 2) 200 + JSON 错误体
  handler = (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: { message: 'invalid model' } }));
  };
  let err = null;
  try { await providers.streamChat(model(base), [{ role: 'user', content: 'hi' }], { onEvent: () => {} }); }
  catch (e) { err = e; }
  check('200 + 错误 JSON 应报错而不是空回答', !!err, err ? '报错=' + err.message : '未报错（返回空内容）');

  // 3) 正常 SSE + usage
  handler = (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.write('data: {"choices":[{"delta":{"content":"你"}}]}\n\n');
    res.write('data: {"choices":[{"delta":{"content":"好"}}]}\n\n');
    res.write('data: {"choices":[],"usage":{"prompt_tokens":11,"completion_tokens":7}}\n\n');
    res.end('data: [DONE]\n\n');
  };
  out = await providers.streamChat(model(base), [{ role: 'user', content: 'hi' }], { onEvent: () => {} });
  check('SSE 正文与 usage', out.content === '你好' && out.usage && out.usage.input === 11 && out.usage.output === 7,
    JSON.stringify({ content: out.content, usage: out.usage }));

  // 4) 末尾无换行的最后一条 data
  handler = (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.end('data: {"choices":[{"delta":{"content":"尾"}}]}');
  };
  out = await providers.streamChat(model(base), [{ role: 'user', content: 'hi' }], { onEvent: () => {} });
  check('末尾无换行的 SSE 行仍被解析', out.content === '尾', 'content=' + JSON.stringify(out.content));

  // 5) Anthropic 用量（message_start + message_delta）
  handler = (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.write('event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":20,"output_tokens":1}}}\n\n');
    res.write('event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"答"}}\n\n');
    res.write('event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":33}}\n\n');
    res.end();
  };
  const am = Object.assign(model(base), { apiFormat: 'anthropic' });
  out = await providers.streamChat(am, [{ role: 'user', content: 'hi' }], { onEvent: () => {} });
  check('Anthropic 用量累加', out.content === '答' && out.usage && out.usage.input === 20 && out.usage.output === 33,
    JSON.stringify({ content: out.content, usage: out.usage }));

  // 6) 只返回 reasoning 的 OpenAI 流
  handler = (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.end('data: {"choices":[{"delta":{"reasoning_content":"想一想"}}]}\n\n');
  };
  out = await providers.streamChat(model(base), [{ role: 'user', content: 'hi' }], { onEvent: () => {} });
  check('仅有思考链时 content 为空（界面是否会显示空白卡片）', out.content === '' && out.reasoning === '想一想',
    JSON.stringify({ content: out.content, reasoning: out.reasoning }));

  // 7) 请求体字段：Kimi K3 / GPT-5 用 max_completion_tokens
  let captured = null;
  handler = (req, res) => {
    let b = '';
    req.on('data', c => { b += c; });
    req.on('end', () => {
      captured = JSON.parse(b);
      res.setHeader('Content-Type', 'text/event-stream');
      res.write('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n');
      res.end('data: [DONE]\n\n');
    });
  };
  await providers.streamChat(Object.assign(model(base), { provider: 'moonshot', modelId: 'kimi-k3' }),
    [{ role: 'user', content: 'hi' }], { onEvent: () => {} });
  const kimiOk = captured && captured.max_completion_tokens === 100 && !('max_tokens' in captured);
  await providers.streamChat(Object.assign(model(base), { provider: 'openai', modelId: 'gpt-5.5' }),
    [{ role: 'user', content: 'hi' }], { onEvent: () => {} });
  const gptOk = captured && captured.max_completion_tokens === 100 && !('max_tokens' in captured);
  await providers.streamChat(Object.assign(model(base), { provider: 'deepseek', modelId: 'deepseek-flash' }),
    [{ role: 'user', content: 'hi' }], { onEvent: () => {} });
  const dsOk = captured && captured.max_tokens === 100 && !('max_completion_tokens' in captured);
  check('max_completion_tokens 选择正确', kimiOk && gptOk && dsOk, JSON.stringify({ kimiOk, gptOk, dsOk }));

  // 8) 自定义端点（provider=custom）不应带 stream_options
  captured = null;
  await providers.streamChat(Object.assign(model(base), { provider: 'custom', id: 'idcustom' }),
    [{ role: 'user', content: 'hi' }], { onEvent: () => {} });
  check('自定义端点不带 stream_options', captured && !('stream_options' in captured),
    JSON.stringify(captured));

  // 9) SSE 错误帧（one-api 类网关转发上游失败）：必须报错，不能返回"✓ 完成"的空回答
  handler = (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.write('data: {"error":{"message":"upstream failed"}}\n\n');
    res.end('data: [DONE]\n\n');
  };
  err = null;
  try { await providers.streamChat(model(base), [{ role: 'user', content: 'hi' }], { onEvent: () => {} }); }
  catch (e) { err = e; }
  check('SSE 错误帧应抛出而非空回答', !!err && /upstream failed/.test(err.message), err ? err.message : '未报错');

  // 10) 有 data: 帧但没有任何正文（空流被网关吞掉）：报错而不是空回答
  handler = (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.end('data: {"choices":[]}\n\ndata: [DONE]\n\n');
  };
  err = null;
  try { out = await providers.streamChat(model(base), [{ role: 'user', content: 'hi' }], { onEvent: () => {} }); }
  catch (e) { err = e; }
  check('有 data 帧但空正文应报错', !!err && /未返回任何内容/.test(err.message), err ? err.message : 'content=' + (out && out.content));

  // 11) 个别网关整段只发一个 message 形态的帧
  handler = (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.end('data: {"choices":[{"message":{"content":"整段回答"}}]}\n\n');
  };
  out = await providers.streamChat(model(base), [{ role: 'user', content: 'hi' }], { onEvent: () => {} });
  check('message 形态的 data 帧被解析', out.content === '整段回答', 'content=' + JSON.stringify(out.content));

  // 12) content 为部件数组（个别网关）：不能变成 [object Object]
  handler = (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.end('data: {"choices":[{"delta":{"content":[{"type":"text","text":"部"},{"type":"text","text":"件"}]}}]}\n\n');
  };
  out = await providers.streamChat(model(base), [{ role: 'user', content: 'hi' }], { onEvent: () => {} });
  check('content 部件数组拼接为文本', out.content === '部件', 'content=' + JSON.stringify(out.content));

  // 13) usage 用 input_tokens/output_tokens 命名（Bedrock 兼容层等）
  handler = (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.write('data: {"choices":[{"delta":{"content":"好"}}]}\n\n');
    res.end('data: {"choices":[],"usage":{"input_tokens":5,"output_tokens":3}}\n\n');
  };
  out = await providers.streamChat(model(base), [{ role: 'user', content: 'hi' }], { onEvent: () => {} });
  check('usage 的 input/output_tokens 命名回退', out.usage && out.usage.input === 5 && out.usage.output === 3,
    JSON.stringify(out.usage));

  // 14) Anthropic 缓存 token 计入输入（服务端自动缓存时 input_tokens 不含缓存段）
  handler = (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.write('data: {"type":"message_start","message":{"usage":{"input_tokens":10,"cache_read_input_tokens":150}}}\n\n');
    res.write('data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"答"}}\n\n');
    res.write('data: {"type":"message_delta","data":{"type":"message_delta"},"usage":{"output_tokens":33}}\n\n');
    res.end();
  };
  out = await providers.streamChat(Object.assign(model(base), { apiFormat: 'anthropic' }),
    [{ role: 'user', content: 'hi' }], { onEvent: () => {} });
  check('Anthropic 缓存 token 计入输入用量', out.usage && out.usage.input === 160 && out.usage.output === 33,
    JSON.stringify(out.usage));

  // 15) 测试连接：kimi-k3 / gpt-5* 无 maxTokens 时也必须用 max_completion_tokens（盲设 max_tokens 必 400）
  const noTok = base2 => Object.assign(model(base2), { maxTokens: undefined });
  handler = (req, res) => {
    let b = '';
    req.on('data', c => { b += c; });
    req.on('end', () => {
      captured = JSON.parse(b);
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { content: 'pong' } }] }));
    });
  };
  await providers.chatOnce(Object.assign(noTok(base), { provider: 'moonshot', modelId: 'kimi-k3' }));
  const tKimi = captured && captured.max_completion_tokens === 100 && !('max_tokens' in captured);
  await providers.chatOnce(Object.assign(noTok(base), { provider: 'openai', modelId: 'gpt-5.6' }));
  const tGpt = captured && captured.max_completion_tokens === 100 && !('max_tokens' in captured);
  await providers.chatOnce(Object.assign(noTok(base), { provider: 'deepseek', modelId: 'deepseek-flash' }));
  const tDs = captured && captured.max_tokens === 100 && !('max_completion_tokens' in captured);
  check('测试连接的 token 字段选择正确', tKimi && tGpt && tDs, JSON.stringify({ tKimi, tGpt, tDs }));

  // 16) 529（Anthropic 官方过载码）：文案友好且纳入重试
  let hits529 = 0;
  handler = (req, res) => {
    hits529++;
    if (hits529 === 1) { res.statusCode = 529; res.end('overloaded'); return; }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: '恢复' } }] }));
  };
  out = null; err = null;
  try { out = await providers.chatOnce(Object.assign(noTok(base), { provider: 'deepseek', modelId: 'deepseek-flash' })); }
  catch (e) { err = e; }
  check('529 过载自动重试且成功', out === '恢复' && hits529 === 2,
    out ? out : (err ? err.message : 'hits=' + hits529));

  // 17) 200 + 网关 HTML：报中文错误而不是英文 SyntaxError
  handler = (req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end('<html><body>502 Bad Gateway</body></html>');
  };
  err = null;
  try { await providers.chatOnce(Object.assign(noTok(base), { provider: 'deepseek', modelId: 'deepseek-flash' })); }
  catch (e) { err = e; }
  check('200 + 网关 HTML 报中文错误', !!err && /响应不是有效 JSON/.test(err.message), err ? err.message.slice(0, 80) : '未报错');

  // 18) Gemini 兼容层模型列表剥 models/ 前缀（stub 全局 fetch 指向假响应）
  const realFetch = global.fetch;
  try {
    global.fetch = async () => ({
      ok: true,
      json: async () => ({ data: [{ id: 'models/gemini-4-argon' }, { id: 'models/gemini-3.8-flash' }] })
    });
    const list = await providers.listModels({ apiFormat: 'openai', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', provider: 'google', modelId: 'x' });
    check('Gemini 模型列表剥 models/ 前缀', list.length === 2 && list[0].id === 'gemini-3.8-flash',
      JSON.stringify(list.map(x => x.id)));
  } finally { global.fetch = realFetch; }

  // 19) 未知 Content-Type 且无 data: 行、超过 10MB：报"响应过大"而不是"未返回任何内容"
  handler = (req, res) => {
    res.setHeader('Content-Type', 'text/plain');
    const pad = 'x'.repeat(1024 * 1024);
    res.write('{"j":"');
    for (let i = 0; i < 11; i++) res.write(pad);
    res.end('"}');
  };
  err = null;
  try { await providers.streamChat(model(base), [{ role: 'user', content: 'hi' }], { onEvent: () => {} }); }
  catch (e) { err = e; }
  check('超 10MB 响应报"响应过大"', !!err && /10MB/.test(err.message), err ? err.message : '未报错');

  // 20) finish_reason=length：返回 finish，界面据此出「已截断」徽标（C5）
  handler = (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.write('data: {"choices":[{"delta":{"content":"答"}}]}\n\n');
    res.write('data: {"choices":[{"delta":{},"finish_reason":"length"}],"usage":{"prompt_tokens":3,"completion_tokens":1}}\n\n');
    res.end('data: [DONE]\n\n');
  };
  out = await providers.streamChat(model(base), [{ role: 'user', content: 'hi' }], { onEvent: () => {} });
  check('finish_reason=length 透传', out.finish === 'length' && out.content === '答', JSON.stringify({ finish: out.finish, content: out.content }));

  // 21) content_filter 与 Anthropic stop_reason 归一（C5）
  handler = (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.end('data: {"choices":[{"delta":{"content":"x"},"finish_reason":"content_filter"}]}\n\n');
  };
  out = await providers.streamChat(model(base), [{ role: 'user', content: 'hi' }], { onEvent: () => {} });
  const cfOk = out.finish === 'content_filter';
  handler = (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.write('data: {"type":"message_start","message":{"usage":{"input_tokens":5}}}\n\n');
    res.write('data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"答"}}\n\n');
    res.write('data: {"type":"message_delta","usage":{"output_tokens":1},"delta":{"stop_reason":"max_tokens"}}\n\n');
    res.end();
  };
  out = await providers.streamChat(Object.assign(model(base), { apiFormat: 'anthropic' }),
    [{ role: 'user', content: 'hi' }], { onEvent: () => {} });
  check('content_filter / anthropic max_tokens 归一', cfOk && out.finish === 'length',
    JSON.stringify({ cf: cfOk, anth: out.finish }));

  // 22) annotations 引用注回 → sources 事件（http 白名单 + 去重）（C11）
  handler = (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.write('data: {"choices":[{"delta":{"content":"带引用"}}]}\n\n');
    res.write('data: {"choices":[{"delta":{"annotations":[{"type":"url_citation","url_citation":{"url":"https://e.com/a","title":"A"}}]}}]}\n\n');
    res.write('data: {"choices":[{"delta":{"annotations":[{"url":"https://e.com/a","title":"重复"},{"url":"ftp://x/y","title":"非http"}]}}]}\n\n');
    res.end('data: [DONE]\n\n');
  };
  const gotSources = [];
  await providers.streamChat(model(base), [{ role: 'user', content: 'hi' }], {
    onEvent: ev => { if (ev.type === 'sources') gotSources.push(...ev.sources); }
  });
  // provider 层按帧解析（帧内去重 + 非 http 过滤）；跨帧去重由渲染层按 url 合并
  // （e2e-app「annotations：模型自带引用并入来源区」覆盖 3 条注回 → 来源 2 条）
  check('annotations 转 sources 事件（非 http 过滤，帧内去重）',
    gotSources.length === 2 && gotSources[0].url === 'https://e.com/a' &&
      gotSources.every(s => /^https?:\/\//.test(s.url)),
    JSON.stringify(gotSources));

  // 23) google 预置发 stream_options（官方兼容层支持 include_usage）（C12）
  captured = null;
  handler = (req, res) => {
    let b = '';
    req.on('data', c => { b += c; });
    req.on('end', () => {
      captured = JSON.parse(b);
      res.setHeader('Content-Type', 'text/event-stream');
      res.write('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n');
      res.end('data: [DONE]\n\n');
    });
  };
  await providers.streamChat(Object.assign(model(base), { provider: 'google', modelId: 'gemini-4-argon' }),
    [{ role: 'user', content: 'hi' }], { onEvent: () => {} });
  check('google 端点带 stream_options.include_usage（官方文档支持）',
    captured && captured.stream_options && captured.stream_options.include_usage === true,
    JSON.stringify(captured && captured.stream_options));

  // 24) 搜索中止：外部 signal 已中止时立即抛"已停止"，不发网络（B8）
  const search = require('../src/main/search');
  const abortCtrl = new AbortController();
  abortCtrl.abort();
  err = null;
  try { await search.webSearch({ provider: 'bing' }, '测试', 3, { signal: abortCtrl.signal }); }
  catch (e) { err = e; }
  check('搜索外部中止立即抛"已停止"', !!err && /已停止/.test(err.message), err ? err.message : '未报错');

  // 25) 未知 Content-Type 的 JSON 回退：cached 也要透传（与 JSON 路径同口径）
  handler = (req, res) => {
    res.setHeader('Content-Type', 'text/plain');
    res.end(JSON.stringify({
      choices: [{ message: { content: '完整回答' } }],
      usage: { prompt_tokens: 100, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 80 } }
    }));
  };
  out = await providers.streamChat(model(base), [{ role: 'user', content: 'hi' }], { onEvent: () => {} });
  check('未知 CT 的 JSON 回退带 cached', out.usage && out.usage.input === 100 && out.usage.cached === 80,
    JSON.stringify(out.usage));

  // 26) Anthropic JSON 回退：input 要并上缓存段（与流式同口径，否则命中率 >100%）
  const anthro = { apiFormat: 'anthropic', baseUrl: base + '/anthropic', provider: 'anthropic', modelId: 'claude-x', maxTokens: 100 };
  handler = (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      content: [{ type: 'text', text: '完' }],
      usage: { input_tokens: 10, cache_read_input_tokens: 150, output_tokens: 5 },
      stop_reason: 'end_turn'
    }));
  };
  out = await providers.streamChat(anthro, [{ role: 'user', content: 'hi' }], { onEvent: () => {} });
  check('Anthropic JSON 回退 input 含缓存段', out.usage && out.usage.input === 160 && out.usage.cached === 150 && out.usage.output === 5,
    JSON.stringify(out.usage));

  // 27) Anthropic 流：message_start 缺 usage（网关剥离），缓存字段只在 message_delta 出现
  handler = (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.write('data: {"type":"message_delta","usage":{"output_tokens":7,"cache_read_input_tokens":99}}\n\n');
    res.end('data: [DONE]\n\n');
  };
  out = null; err = null;
  try { out = await providers.streamChat(anthro, [{ role: 'user', content: 'hi' }], { onEvent: () => {} }); }
  catch (e) { err = e; } // 无正文帧会按"空回答"抛错，usage 挂在 error 上带出
  const u27 = (out && out.usage) || (err && err.usage);
  check('message_delta 的缓存字段并进输入并保留 cached', u27 && u27.input === 99 && u27.cached === 99 && u27.output === 7,
    JSON.stringify(u27));

  // 28) SSE 错误帧抛出后客户端应 cancel 读端（连接尽快关闭，不滞留）
  const closed = new Promise(resolve => {
    handler = (req, res) => {
      res.setHeader('Content-Type', 'text/event-stream');
      res.write('data: {"error":{"message":"upstream boom"}}\n\n');
      res.on('close', resolve); // 故意不 end：只有客户端 cancel 才会立刻触发
    };
  });
  err = null;
  try { await providers.streamChat(model(base), [{ role: 'user', content: 'hi' }], { onEvent: () => {} }); }
  catch (e) { err = e; }
  const cancelled = await Promise.race([
    closed.then(() => true),
    new Promise(r => setTimeout(() => r(false), 1500))
  ]);
  check('错误帧报错', !!err && /upstream boom/.test(err.message), err ? err.message : '未报错');
  check('错误帧抛出后连接被 cancel（服务端 close 及时触发）', cancelled === true, 'cancelled=' + cancelled);

  server.close();
  console.log('---SUMMARY---');
  console.log(JSON.stringify(rows, null, 1));
}

run().catch(e => { console.error('AUDIT_ERROR', e); server.close(); process.exit(1); });
