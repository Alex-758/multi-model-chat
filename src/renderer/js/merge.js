'use strict';
// 合并回答：
// 1) frontend()  —— 本地要点提取 + 相似度聚类，生成结构化综合回答（不耗 token）
// 2) synthesisPrompt() —— 模型二次综合的提示词

(function () {

  // ---------- 要点拆分 ----------
  // 只剥行首的标题/列表标记，保留正文里的 #、反引号和星号
  // （全局删除会把 C# 变成 C、把 URL 的 #锚点 删掉、把行内代码的反引号吃掉）
  const RE_HEADING = /^#{1,6}\s+/;
  const RE_BULLET = /^[-*+•]\s+/;
  // (?!\d)：避免把行首的 "1.5 倍" 当成有序列表前缀剥成 "5 倍"
  const RE_ORDERED = /^\d{1,3}[.、)](?!\d)\s*/;
  function stripListPrefix(s) {
    let t = String(s).trim();
    if (RE_HEADING.test(t)) t = t.replace(RE_HEADING, '').trim();
    while (RE_BULLET.test(t) || RE_ORDERED.test(t)) {
      t = (RE_BULLET.test(t) ? t.replace(RE_BULLET, '') : t.replace(RE_ORDERED, '')).trim();
    }
    return t;
  }

  // 补句号：中英文常见结尾标点（含引号/括号收尾）都视为已结束，避免出现 "！。"
  const END_PUNCT = /[。！？；：….!?]$/;
  function ensureSentenceEnd(text) {
    const t = String(text).trim();
    const tail = t.replace(/[”’」』）)\]]+$/, '');
    return END_PUNCT.test(tail) ? t : t + '。';
  }

  function splitPoints(text) {
    // 1. 表格块优先提取：连续以 | 开头的行整块保留，绝不逐行拆散
    const tables = [];
    text = String(text).replace(/(?:^[ \t]*\|[^\n]*\|[ \t]*\n?)+/gm, m => {
      const t = m.trim();
      if (t.split('\n').length >= 2) tables.push(t);
      return '\n';
    });

    // 2. 常规要点拆分
    const lines = text.split('\n').map(s => stripListPrefix(s));
    const bullets = lines.filter(l => l.length > 8);
    let pts;
    if (bullets.length >= 3) {
      pts = bullets;
    } else {
      pts = [];
      for (const para of text.split(/\n{2,}/)) {
        let p = para.trim().replace(/^#+\s*/, '').trim();
        if (!p) continue;
        p = stripListPrefix(p);
        if (p.length <= 130) { pts.push(p); continue; }
        const sents = p.match(/[^。！？!?.;；]+[。！？!?.;；]?/g) || [p];
        let cur = '';
        for (const s of sents) {
          if ((cur + s).length > 150 && cur) { pts.push(cur.trim()); cur = s; }
          else cur += s;
        }
        if (cur.trim()) pts.push(cur.trim());
      }
    }
    return pts
      .filter(p => p && p.length >= 6 && p.length <= 400)
      // 过滤寒暄开场白与收尾语
      .filter(p => !/^(好的|以下是|希望|总之|综上|首先我们|让我)/i.test(p))
      .filter(p => !/欢迎(继续)?(提问|咨询)|如有(其他|任何)|希望(这|对你|以上|能)|还能(帮|问我)|祝你/.test(p))
      // 过滤纯标题行（短、以冒号结尾，可带 emoji 前缀），它们不是要点
      .filter(p => !/^[📌💡⚡✨🔔ℹ️🌟📝\s]*[^。，！？\s]{1,14}[：:]$/.test(p.trim()))
      // 剥掉“补充：”“注：”等标签前缀
      .map(p => p.replace(/^(补充说明|补充|注|注意|另外|此外|说明)[：:]\s*/, ''))
      .filter(p => p.length >= 6)
      .slice(0, 14)
      // 表格块追加为独立要点（frontend 中单独输出，不参与编号）
      .concat(tables);
  }

  // ---------- 分词与相似度 ----------
  function tokenize(s) {
    const t = [];
    const cjk = s.match(/[一-鿿]{2,}/g) || [];
    for (const seg of cjk) for (let i = 0; i < seg.length - 1; i++) t.push(seg.slice(i, i + 2));
    const words = s.toLowerCase().match(/[a-z0-9_+#.\-]{2,}/g) || [];
    for (const w of words) t.push(w);
    return t;
  }
  function vecOf(s) {
    const m = new Map();
    for (const t of tokenize(s)) m.set(t, (m.get(t) || 0) + 1);
    return m;
  }
  function cos(a, b) {
    let dot = 0, na = 0, nb = 0;
    for (const [k, v] of a) { na += v * v; if (b.has(k)) dot += v * b.get(k); }
    for (const [, v] of b) nb += v * v;
    return na && nb ? dot / Math.sqrt(na * nb) : 0;
  }

  // ---------- 聚类重组：输出一份完整、连贯的回答 ----------
  function frontend(results) {
    // results: [{modelId, name, content}]
    const points = [];   // 文本要点（参与聚类）
    const tables = [];   // 表格块（不拆散、不聚类，去重后原文附后）
    for (const r of results) {
      for (const p of splitPoints(r.content)) {
        if (p.startsWith('|')) tables.push(p);
        else points.push({ model: r.name, modelId: r.modelId, text: p, v: vecOf(p) });
      }
    }
    if (!points.length && !tables.length) return '_（未能从各模型回答中提取到可合并的要点）_';

    // 表格去重（多模型的时间线表格往往高度雷同）
    const norm = s => String(s).replace(/\s+/g, '');
    const uniqTables = [];
    for (const t of tables) {
      if (!uniqTables.some(u => norm(u) === norm(t))) uniqTables.push(t);
    }

    // 相似要点聚类（同一信息多个模型都说了 → 合并为一条）
    const clusters = [];
    for (const pt of points) {
      let best = null, bestSim = 0;
      for (const c of clusters) {
        const s = cos(pt.v, c.centroid);
        if (s > bestSim) { bestSim = s; best = c; }
      }
      if (best && bestSim >= 0.34) {
        best.members.push(pt);
        for (const [k, v] of pt.v) best.centroid.set(k, (best.centroid.get(k) || 0) + v);
      } else {
        clusters.push({ members: [pt], centroid: new Map(pt.v) });
      }
    }

    // 排序：多数模型都提到的要点排前面（更可能是核心答案），独有补充靠后
    const rank = c => {
      const models = new Set(c.members.map(m => m.model)).size;
      const longest = Math.max(...c.members.map(m => m.text.length));
      return models * 1000 + longest;
    };
    clusters.sort((a, b) => rank(b) - rank(a));

    // 每个聚类取表述最完整的一条原句，重组为编号列表——
    // 不标注来源、不分“共识/补充”，输出即一份可直接阅读的回答
    // （单换行连接：保证 Markdown 渲染为同一个连续编号列表，而不是每条都从 1 开始）
    const lines = clusters.map(c => {
      const rep = c.members.reduce((a, b) => a.text.length >= b.text.length ? a : b);
      return ensureSentenceEnd(rep.text);
    });
    let out = lines.map((t, i) => (i + 1) + '. ' + t).join('\n');
    // 表格作为补充信息附在末尾（原文完整保留）
    for (const t of uniqTables) out += '\n\n' + t + '\n';
    return out.trim();
  }

  // ---------- 模型二次综合提示词 ----------
  function synthesisPrompt(question, results, maxChars) {
    let p = '下面是多个 AI 模型对同一个问题的回答。请把它们融合改写为一份完整的最终回答：\n' +
      '要求：\n' +
      '- 直接输出最终回答本身（使用 Markdown），不要提及任何模型名称，不要对比各回答，不要逐条罗列“某模型说了什么”\n' +
      '- 按逻辑组织内容（先直接回答，再展开详细说明与必要的补充），语言连贯自然，像一篇由你独立撰写的答案\n' +
      '- 合并所有正确且有用的信息，去除重复；各回答有冲突时，采用更可信的说法\n' +
      '- 保留重要的细节、数据、时间线和代码示例\n' +
      '- 不要寒暄，不要“欢迎继续提问”之类的收尾语\n\n' +
      '【原始问题】\n' + question + '\n\n';
    // 控制总长度，避免多个长回答把综合请求顶出模型上下文窗口
    const budget = Math.max(2000, Number(maxChars) || 48000);
    let used = 0;
    results.forEach((r, i) => {
      if (used >= budget) return;
      let content = String(r.content || '');
      const remain = budget - used;
      if (content.length > remain) content = content.slice(0, remain) + '\n…（内容过长，已截断）';
      used += content.length;
      p += '【回答 ' + (i + 1) + '】\n' + content + '\n\n';
    });
    return p;
  }

  const api = { frontend, synthesisPrompt };
  if (typeof window !== 'undefined') {
    window.MM = window.MM || {};
    window.MM.merge = api;
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
