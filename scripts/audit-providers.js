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

  server.close();
  console.log('---SUMMARY---');
  console.log(JSON.stringify(rows, null, 1));
}

run().catch(e => { console.error('AUDIT_ERROR', e); server.close(); process.exit(1); });
