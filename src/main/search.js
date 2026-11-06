'use strict';
// 通用联网搜索：必应（免费无需密钥）/ Tavily / 博查，结果注入对话上下文。
// opts.signal：外部中止（chat:stop 经 activeRequests 传入）——用户点停止时
// 搜索请求立即中断，不再在主进程空跑到 15s 超时
const BING_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// 把外部 signal 接到本次请求的 controller 上；已中止则直接抛"已停止"
function wireExternal(signal, ctrl) {
  if (!signal) return;
  if (signal.aborted) throw new Error('已停止');
  signal.addEventListener('abort', () => ctrl.abort(), { once: true });
}

async function bingSearch(query, count, opts) {
  // 双端点兜底：www 失败或解析不到结果时换 cn 端点再试一次（已中止则不再重试）
  const endpoints = [
    'https://www.bing.com/search?q=' + encodeURIComponent(query) + '&setlang=zh-CN&count=' + Math.max(count + 4, 10),
    'https://cn.bing.com/search?q=' + encodeURIComponent(query) + '&setlang=zh-CN&count=' + Math.max(count + 4, 10)
  ];
  let lastErr = null;
  for (const url of endpoints) {
    if (opts && opts.signal && opts.signal.aborted) throw new Error('已停止');
    try {
      const out = await bingAttempt(url, count, opts);
      if (out.length) return out;
      lastErr = new Error('必应搜索未解析到结果（可能被临时限流），可稍后重试或配置 Tavily/博查');
    } catch (e) {
      if (opts && opts.signal && opts.signal.aborted) throw new Error('已停止');
      // 15s 超时的 AbortError 转中文（用户主动停止已在上面的 signal 检查里拦截）
      lastErr = (e && e.name === 'AbortError') ? new Error('搜索超时：15 秒未响应') : e;
    }
  }
  throw lastErr || new Error('必应搜索失败');
}

async function bingAttempt(url, count, opts) {
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 15000);
  wireExternal(opts && opts.signal, ctrl);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': BING_UA, 'Accept-Language': 'zh-CN,zh;q=0.9' },
      signal: ctrl.signal
    });
    if (!res.ok) throw new Error('必应搜索 HTTP ' + res.status);
    const t = await res.text();
    const re = /<li class="b_algo"[\s\S]*?<h2[^>]*><a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a><\/h2>[\s\S]*?(?:<p[^>]*>([\s\S]*?)<\/p>)?/g;
    const out = [];
    let m;
    while ((m = re.exec(t)) && out.length < count) {
      const title = (m[2] || '').replace(/<[^>]+>/g, '').trim();
      let u = String(m[1] || '');
      if (u.startsWith('/')) u = 'https://www.bing.com' + u;
      const snippet = (m[3] || '').replace(/<[^>]+>/g, '').trim().slice(0, 300);
      if (!title || !/^https?:\/\//.test(u)) continue;
      out.push({ title, url: u, snippet });
    }
    return out;
  } finally { clearTimeout(timeout); }
}

async function webSearch(cfg, query, count = 6, opts) {
  const provider = cfg && cfg.provider;
  const key = (cfg && cfg.apiKey || '').trim();
  if (!provider || provider === 'none') return null;
  if (provider === 'bing') return bingSearch(query, count, opts);

  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 15000);
  wireExternal(opts && opts.signal, ctrl);
  try {
    if (!key) throw new Error('搜索服务商已选但 API 密钥为空，请在设置中填写');
    if (provider === 'tavily') {
      const res = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, api_key: key, max_results: count }),
        signal: ctrl.signal
      });
      if (!res.ok) throw new Error('Tavily ' + res.status + ': ' + (await res.text()).slice(0, 200));
      const j = await res.json();
      return (j.results || []).map(r => ({ title: r.title || '', url: r.url || '', snippet: (r.content || '').slice(0, 300) }));
    }
    if (provider === 'bocha') {
      const res = await fetch('https://api.bochaai.com/v1/web-search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
        body: JSON.stringify({ query, count, summary: true }),
        signal: ctrl.signal
      });
      if (!res.ok) throw new Error('博查 ' + res.status + ': ' + (await res.text()).slice(0, 200));
      const j = await res.json();
      const items = (j.data && j.data.webPages && j.data.webPages.value) || [];
      return items.map(r => ({ title: r.name || '', url: r.url || '', snippet: (r.summary || r.snippet || '').slice(0, 300) }));
    }
    return null;
  } catch (e) {
    if (opts && opts.signal && opts.signal.aborted) throw new Error('已停止');
    if (e && e.name === 'AbortError') throw new Error('搜索超时：15 秒未响应');
    throw e;
  } finally { clearTimeout(timeout); }
}

module.exports = { webSearch };
