'use strict';
window.MM = window.MM || {};

MM.util = {
  $: s => document.querySelector(s),
  $$: s => Array.from(document.querySelectorAll(s)),

  el(tag, attrs, ...children) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === 'class') n.className = v;
      else if (k === 'html') n.innerHTML = v;
      else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
      else if (v !== null && v !== undefined && v !== false) n.setAttribute(k, v);
    }
    for (const c of children.flat()) {
      if (c === null || c === undefined || c === false) continue;
      n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return n;
  },

  esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  },

  uid() { return 'id' + Date.now().toString(36) + Math.random().toString(36).slice(2, 9); },

  fmtTime(ts) {
    const d = new Date(ts);
    const now = new Date();
    const hm = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    if (d.toDateString() === now.toDateString()) return hm;
    return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + hm;
  },

  fmtMs(ms) { return ms >= 1000 ? (ms / 1000).toFixed(1) + 's' : ms + 'ms'; },

  debounce(fn, ms) {
    let t = null;
    return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  },

  copyText(text) {
    return navigator.clipboard.writeText(text).catch(() => {
      const ta = document.createElement('textarea');
      ta.value = text; document.body.appendChild(ta); ta.select();
      document.execCommand('copy'); ta.remove();
    });
  },

  // 复制渲染后元素的纯文本（星号等 Markdown 标记在渲染时已被消除，任何地方粘贴都是干净文本）
  copyTextFrom(el) {
    const text = el ? (el.innerText || '') : '';
    return navigator.clipboard.writeText(text).catch(() => {
      const ta = document.createElement('textarea');
      ta.value = text; document.body.appendChild(ta); ta.select();
      document.execCommand('copy'); ta.remove();
    });
  },

  toast(msg, isErr) {
    const t = MM.util.$('#toast');
    t.textContent = msg;
    t.className = isErr ? 'err' : '';
    clearTimeout(MM.util._toastTimer);
    MM.util._toastTimer = setTimeout(() => { t.className = 'hidden'; }, 2800);
  }
};
