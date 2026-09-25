'use strict';
// 通用联网搜索：必应（免费无需密钥）/ Tavily / 博查，结果注入对话上下文
const BING_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

async function bingSearch(query, count) {
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch('https://www.bing.com/search?q=' + encodeURIComponent(query) + '&setlang=zh-CN&count=' + Math.max(count + 4, 10), {
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
      let url = String(m[1] || '');
      if (url.startsWith('/')) url = 'https://www.bing.com' + url;
      const snippet = (m[3] || '').replace(/<[^>]+>/g, '').trim().slice(0, 300);
      if (!title || !/^https?:\/\//.test(url)) continue;
      out.push({ title, url, snippet });
    }
    if (!out.length) throw new Error('必应搜索未解析到结果（可能被临时限流），可稍后重试或配置 Tavily/博查');
    return out;
  } finally { clearTimeout(timeout); }
}

async function webSearch(cfg, query, count = 6) {
  const provider = cfg && cfg.provider;
  const key = (cfg && cfg.apiKey || '').trim();
  if (!provider || provider === 'none') return null;
  if (provider === 'bing') return bingSearch(query, count);

  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 15000);
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
  } finally { clearTimeout(timeout); }
}

module.exports = { webSearch };
