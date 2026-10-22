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

  server.close();
  console.log('---SUMMARY---');
  console.log(JSON.stringify(rows, null, 1));
}

run().catch(e => { console.error('AUDIT_ERROR', e); server.close(); process.exit(1); });
