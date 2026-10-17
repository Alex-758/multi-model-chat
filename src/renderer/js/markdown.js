'use strict';
// 轻量 Markdown 渲染器：标题/粗斜体/行内代码/围栏代码块/列表/引用/表格/链接/分隔线
window.MM = window.MM || {};

(function () {
  const esc = MM.util.esc;

  function renderInline(s) {
    // 行内代码先抽成占位符，避免代码里的 ** / * 被误当成粗体、斜体
    const codes = [];
    s = s.replace(/`([^`\n]+)`/g, (m, c) => {
      codes.push(c);
      return '\u0001C' + (codes.length - 1) + '\u0001';
    });
    // 粗体、斜体
    s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
    // 链接（仅 http/https）
    s = s.replace(/\[([^\]\n]+)\]\((https?:[^)\s]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener">$1</a>');
    // 还原行内代码
    s = s.replace(/\u0001C(\d+)\u0001/g, (m, i) => '<code>' + codes[+i] + '</code>');
    return s;
  }

  function render(src) {
    if (src == null) return '';
    // 先抽出围栏代码块，避免内部被解析
    const blocks = [];
    src = String(src).replace(/```([\w+-]*)[^\n]*\n?([\s\S]*?)(?:```|$)/g, (m, lang, code) => {
      blocks.push({ lang, code });
      return '\u0000B' + (blocks.length - 1) + '\u0000';
    });

    const lines = esc(src).split('\n');
    const out = [];
    let para = [], listType = null, inQuote = false, quote = [];

    function flushPara() {
      if (para.length) { out.push('<p>' + renderInline(para.join('<br>')) + '</p>'); para = []; }
    }
    function flushList() {
      if (listType) { out.push(listType === 'ul' ? '</ul>' : '</ol>'); listType = null; }
    }
    function flushQuote() {
      if (inQuote) { out.push('<blockquote>' + renderInline(quote.join('<br>')) + '</blockquote>'); inQuote = false; quote = []; }
    }
    function flushAll() { flushPara(); flushList(); flushQuote(); }

    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      const line = raw.trim();

      // 代码块占位行
      const bm = line.match(/^\u0000B(\d+)\u0000$/);
      if (bm) {
        flushAll();
        const b = blocks[+bm[1]];
        out.push('<div class="codeblock"><div class="code-head"><span>' + esc(b.lang || 'text') +
          '</span><button class="code-copy" data-code="' + esc(b.code) + '">复制</button></div>' +
          '<pre><code>' + esc(b.code.replace(/\n$/, '')) + '</code></pre></div>');
        continue;
      }
      if (!line) { flushAll(); continue; }

      // 标题
      let m = line.match(/^(#{1,4})\s+(.*)$/);
      if (m) { flushAll(); const l = m[1].length; out.push('<h' + l + '>' + renderInline(m[2]) + '</h' + l + '>'); continue; }

      // 分隔线
      if (/^(-{3,}|\*{3,}|_{3,})$/.test(line)) { flushAll(); out.push('<hr>'); continue; }

      // 引用
      m = line.match(/^&gt;\s?(.*)$/);
      if (m) { flushPara(); flushList(); inQuote = true; quote.push(renderInline(m[1])); continue; }
      if (inQuote) flushQuote();

      // 无序列表
      m = line.match(/^[-*+]\s+(.*)$/);
      if (m) {
        flushPara();
        if (listType !== 'ul') { flushList(); out.push('<ul>'); listType = 'ul'; }
        out.push('<li>' + renderInline(m[1]) + '</li>');
        continue;
      }
      // 有序列表
      m = line.match(/^\d+[.)]\s+(.*)$/);
      if (m) {
        flushPara();
        if (listType !== 'ol') { flushList(); out.push('<ol>'); listType = 'ol'; }
        out.push('<li>' + renderInline(m[1]) + '</li>');
        continue;
      }
      if (listType) flushList();

      // 表格：分隔行必须含 |，否则 "a | b" 后面跟一条 --- 会被误判成表格
      if (line.includes('|') && i + 1 < lines.length && lines[i + 1].includes('|') &&
          /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1]) && lines[i + 1].includes('-')) {
        flushPara();
        const cells = r => r.replace(/^\||\|$/g, '').split('|').map(c => c.trim());
        const head = cells(line);
        i += 2;
        let body = [];
        while (i < lines.length && lines[i].includes('|') && lines[i].trim()) { body.push(cells(lines[i].trim())); i++; }
        i--;
        let t = '<table><thead><tr>' + head.map(h => '<th>' + renderInline(h) + '</th>').join('') + '</tr></thead><tbody>';
        for (const row of body) t += '<tr>' + row.map(c => '<td>' + renderInline(c) + '</td>').join('') + '</tr>';
        t += '</tbody></table>';
        out.push(t);
        continue;
      }

      para.push(line);
    }
    flushAll();
    return out.join('\n');
  }

  MM.md = {
    render,
    bindCopy(root) {
      root.addEventListener('click', e => {
        const btn = e.target.closest('.code-copy');
        if (btn) {
          MM.util.copyText(btn.getAttribute('data-code'));
          btn.textContent = '已复制 ✓';
          setTimeout(() => { btn.textContent = '复制'; }, 1500);
        }
      });
    }
  };
})();
