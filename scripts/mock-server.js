// 本地 mock 服务器：/v1/models 返回模型列表，用于测试下拉功能
const http = require('http');
const models = [
  { id: 'test-vision-pro', context_length: 1048576, architecture: { input_modalities: ['text', 'image'] } },
  { id: 'test-text-mini', context_length: 131072, architecture: { input_modalities: ['text'] } },
  { id: 'test-model-alpha' },
  { id: 'deepseek-v3-test', context_length: 131072 }
];
http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  if (req.url.includes('/models')) {
    res.end(JSON.stringify({ data: models }));
  } else if (req.url.includes('/chat/completions')) {
    res.end(JSON.stringify({ choices: [{ message: { content: 'mock ok' } }] }));
  } else {
    res.end('{}');
  }
}).listen(18925, () => console.log('mock server on 18925'));
