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

  // ---------- 结构化分析（模型综合的本地脚手架，零 token） ----------
  // 把各模型回答拆要点、聚类，产出三分类（共识/独有）与数值冲突候选。
  // 共识清单进综合提示词防漏要点，冲突候选要求模型在「分歧」小节明说；
  // 聚类结果同时是渲染层"来源角标"的匹配依据。
  const NUM_RE = /(?<![第\d])(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)\s*(%|％|亿|万|千|倍|年|个月|月|天|日|小时|分钟|秒|元|美元|GB|MB|KB|TB|公里|千米|米)?/g;

  function numsOf(s) {
    const out = [];
    String(s).replace(NUM_RE, (m, num, unit) => {
      out.push({ v: num.replace(/,/g, ''), u: unit || '' });
      return m;
    });
    return out;
  }

  // 同单位数值完全错开才算疑似冲突（部分重叠不算：B 比 A 多说一个数不是矛盾）
  function numsConflict(a, b) {
    if (!a.length || !b.length) return false;
    const ga = {}, gb = {};
    for (const n of a) (ga[n.u] = ga[n.u] || new Set()).add(n.v);
    for (const n of b) (gb[n.u] = gb[n.u] || new Set()).add(n.v);
    for (const u of Object.keys(ga)) {
      if (!gb[u]) continue;
      const sa = ga[u], sb = gb[u];
      if (![...sa].some(v => sb.has(v))) return true;
    }
    return false;
  }

  function analyze(results) {
    const points = [];
    for (const r of (results || [])) {
      for (const p of splitPoints(r.content || '')) {
        if (p.startsWith('|')) continue;
        // 句子粒度：段落级要点会把整段答案压成一条，共识/独有/冲突三分类会退化
        const pieces = p.match(/[^。！？!?.;；]+[。！？!?.;；]?/g) || [p];
        for (const s of pieces) {
          const t = s.trim();
          if (t.length < 6) continue;
          points.push({ modelId: r.modelId, name: r.name, text: t, v: vecOf(t), nums: numsOf(t) });
        }
      }
    }
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
    const consensus = [], unique = [];
    for (const c of clusters) {
      const models = [];
      for (const m of c.members) {
        if (!models.some(x => x.modelId === m.modelId)) models.push({ modelId: m.modelId, name: m.name });
      }
      if (models.length === 1) {
        const rep = c.members.reduce((a, b) => a.text.length >= b.text.length ? a : b);
        unique.push({ text: rep.text, models: models });
        continue;
      }
      // 簇内跨模型数值冲突的不算共识（如 2048 vs 2030）：它们留给冲突清单，
      // 提示词里要求模型在「分歧」小节分辨，而不是当成两家都认可的共识
      const hasNumConflict = c.members.some((a, i) =>
        c.members.slice(i + 1).some(b => a.modelId !== b.modelId && numsConflict(a.nums, b.nums)));
      if (!hasNumConflict) {
        const rep = c.members.reduce((a, b) => a.text.length >= b.text.length ? a : b);
        consensus.push({ text: rep.text, models: models });
      }
    }
    // 排序：支持模型多的共识在前
    consensus.sort((a, b) => b.models.length - a.models.length);
    // 数值冲突候选：同簇内来自不同模型、数值错开的要点配对
    const conflicts = [];
    outer:
    for (const c of clusters) {
      for (let i = 0; i < c.members.length; i++) {
        for (let j = i + 1; j < c.members.length; j++) {
          const a = c.members[i], b = c.members[j];
          if (a.modelId === b.modelId || !numsConflict(a.nums, b.nums)) continue;
          conflicts.push({ texts: [a.text, b.text] });
          if (conflicts.length >= 6) break outer;
        }
      }
    }
    return { consensus: consensus, unique: unique, conflicts: conflicts, clusters: clusters };
  }

  // 按句子边界截断（替换旧的硬 slice，避免拦腰砍断）
  function cutSentences(text, maxLen) {
    if (text.length <= maxLen) return text;
    const sents = text.match(/[^。！？!?.;；\n]+[。！？!?.;；]*/g) || [text];
    let out = '';
    for (const s of sents) {
      if (out && (out + s).length > maxLen) break;
      out += s;
    }
    if (!out) out = sents[0] || '';
    return out.trimEnd() + '\n…（内容过长，已按句子截断）';
  }

  // 回答块预算：未超预算全量保留；超了按「独有信息量」加权分配（与其它回答重复的要点不计权重），
  // 每份保底，截断落在句子边界——解决"排在后面的回答被硬砍甚至整体丢失"
  function buildAnswersBlock(results, budget) {
    const total = Math.max(2000, Number(budget) || 48000);
    const raw = (results || []).map(r => String(r.content || ''));
    const sumRaw = raw.reduce((a, c) => a + c.length, 0);
    if (!raw.length) return '';
    if (sumRaw <= total) {
      return raw.map((c, i) => '【回答 ' + (i + 1) + '】\n' + c + '\n\n').join('');
    }
    const pts = raw.map(c => splitPoints(c).map(t => ({ t: t, v: vecOf(t) })));
    const uniqWeight = pts.map((list, i) => list.reduce((a, p) => {
      const dup = pts.some((other, j) => j !== i && other.some(q => cos(q.v, p.v) >= 0.5));
      return a + (dup ? 0 : Math.min(p.t.length, 400));
    }, 0));
    const wSum = uniqWeight.reduce((a, b) => a + b, 0) || 1;
    const floor = Math.min(800, Math.floor(total / raw.length));
    let quotas = uniqWeight.map(w => floor + Math.floor((total - floor * raw.length) * w / wSum));
    quotas = quotas.map((q, i) => Math.min(q, raw[i].length));
    let diff = total - quotas.reduce((a, b) => a + b, 0);
    for (let i = 0; diff > 0 && i < raw.length; i++) {
      const give = Math.min(raw[i].length - quotas[i], diff);
      quotas[i] += give; diff -= give;
    }
    return raw.map((c, i) => {
      const part = c.length > quotas[i] ? cutSentences(c, quotas[i]) : c;
      return '【回答 ' + (i + 1) + '】\n' + part + '\n\n';
    }).join('');
  }

  // ---------- 模型二次综合提示词（结构化报告） ----------
  function synthesisPrompt(question, results, maxChars) {
    const an = analyze(results);
    let p = '下面是多个 AI 模型对同一个问题的回答。请分析这些素材，输出一份结构化综合报告。\n' +
      '输出格式（Markdown，使用以下固定的小节标题；某一节没有实质内容时整节省略，不要输出空标题）：\n' +
      '## 结论\n（先直接回答问题，再展开理由，简明扼要）\n' +
      '## 共同点\n（多个模型一致认可的信息，逐条列出）\n' +
      '## 分歧\n（各模型说法不同的地方：分别陈述每种说法及其前提条件或适用范围，给出能帮助判断的事实依据；禁止把不同说法揉成一句话，没有实质分歧就省略本节）\n' +
      '## 关键证据\n（支撑结论的具体数据、代码示例、时间线等）\n' +
      '## 待验证问题\n（这些回答无法确认、需要进一步核实的问题；没有就省略）\n\n' +
      '写作要求：\n' +
      '- 语言自然连贯，像一篇独立撰写的分析报告；不要提及任何模型名称，不要写「某模型说」之类的句式\n' +
      '- 引用各回答中的原句时直接融入正文，不要加引号或任何引用标记\n' +
      '- 合并所有正确且有用的信息，去除重复；数字、日期等关键数据以多数一致的说法为准，存在分歧的放进「分歧」小节\n' +
      '- 不要寒暄，不要「欢迎继续提问」之类的收尾语\n\n' +
      '【原始问题】\n' + question + '\n\n';
    if (an.consensus.length) {
      p += '【本地预分析 · 多模型一致的要点（报告必须全部覆盖）】\n' +
        an.consensus.slice(0, 12).map(c => '- ' + c.text).join('\n') + '\n\n';
    }
    if (an.conflicts.length) {
      p += '【本地预分析 · 疑似数据分歧（请核实后写入「分歧」小节，分别陈述）】\n' +
        an.conflicts.map(c => '- 说法一：' + c.texts[0] + '\n  说法二：' + c.texts[1]).join('\n') + '\n\n';
    }
    p += buildAnswersBlock(results, maxChars);
    return p;
  }

  // ---------- 来源匹配（图2：观点可点击查看来自哪些模型） ----------
  // 把报告按展示块（段落/列表项）拆开，再按句子与各模型要点比相似度；
  // 命中的块记下来自哪些模型，渲染成可点击角标。模型改写幅度大的段落可能匹配不上——
  // 匹配不到就不显示角标（尽力而为，不依赖模型遵守输出格式）。
  function reportBlocks(content) {
    const blocks = [];
    for (const para of String(content || '').split(/\n{2,}/)) {
      let buf = [];
      const flush = () => { if (buf.length) { blocks.push(buf.join('\n').trim()); buf = []; } };
      for (const l of para.split('\n')) {
        if (!l.trim()) continue;
        if (/^\s*(?:[-*+•]|\d{1,3}[.、)])\s/.test(l) || /^#{1,6}\s/.test(l) || /^\s*\|/.test(l)) {
          flush();
          blocks.push(l.replace(/^\s*[-*+•]\s+/, '').replace(/^#{1,6}\s+/, '').trim());
        } else buf.push(l);
      }
      flush();
    }
    return blocks.filter(b => b.length >= 12);
  }

  function buildPool(results) {
    const pool = [];
    const seen = new Set();
    for (const r of (results || [])) {
      for (const t of splitPoints(r.content || '')) {
        if (t.startsWith('|')) continue;
        // 整段要点 + 段内句子都进池：报告里改写的短句要能对上段中某一句，
        // 否则短句对整段的相似度会被段落长度稀释而漏配
        const pieces = t.match(/[^。！？!?.;；]+[。！？!?.;；]?/g) || [];
        for (const s of [t].concat(pieces)) {
          const key = s.trim();
          if (seen.has(key)) continue;
          seen.add(key);
          const v = vecOf(s);
          if (v.size) pool.push({ modelId: r.modelId, name: r.name, text: s, v: v });
        }
      }
    }
    return pool;
  }

  // 一段报告文本来自哪些模型（句子级匹配后聚合，避免长段落稀释相似度）
  function blockModels(text, pool) {
    const sents = String(text).match(/[^。！？!?.;；]+[。！？!?.;；]?/g) || [text];
    const models = [];
    for (const s of sents) {
      const v = vecOf(s);
      if (!v.size) continue;
      for (const p of pool) {
        if (models.some(m => m.modelId === p.modelId)) continue;
        if (cos(v, p.v) >= 0.42) models.push({ modelId: p.modelId, name: p.name });
      }
    }
    return models;
  }

  function matchSources(content, results) {
    const pool = buildPool(results);
    if (!pool.length) return [];
    const out = [];
    for (const b of reportBlocks(content)) {
      const models = blockModels(b, pool);
      if (models.length) out.push({ text: b, models: models });
    }
    return out;
  }

  const api = { frontend, synthesisPrompt, analyze, matchSources, buildPool, blockModels };
  if (typeof window !== 'undefined') {
    window.MM = window.MM || {};
    window.MM.merge = api;
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
