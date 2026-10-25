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
    const d = new Date(Number(ts));
    if (isNaN(d.getTime())) return ''; // 时间戳缺失或非法时不显示 NaN
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

  // toast：带淡出过渡；action = { label, fn } 时附带一个「撤销」类操作按钮
  toast(msg, isErr, action) {
    const t = MM.util.$('#toast');
    t.innerHTML = '';
    t.appendChild(document.createTextNode(msg));
    if (action && typeof action.fn === 'function') {
      t.appendChild(MM.util.el('button', {
        class: 'toast-act',
        onclick: function () {
          clearTimeout(MM.util._toastTimer);
          clearTimeout(MM.util._toastOutTimer);
          t.className = 'hidden';
          action.fn();
        }
      }, action.label || '撤销'));
    }
    t.className = isErr ? 'err' : '';
    clearTimeout(MM.util._toastTimer);
    clearTimeout(MM.util._toastOutTimer);
    // 带操作按钮的提示停留更久（用户需要时间看到「撤销」）
    const life = action ? 5200 : 2800;
    MM.util._toastTimer = setTimeout(() => {
      t.classList.add('toast-out');
      MM.util._toastOutTimer = setTimeout(() => {
        t.classList.remove('toast-out');
        t.classList.add('hidden');
      }, 150);
    }, life);
  },

  // 应用内确认对话框（替代原生 window.confirm）：返回 Promise<boolean>。
  // Esc / 点击遮罩 = 取消；Enter = 确认（焦点在取消上时 Enter = 取消）。
  confirm(opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      const ov = document.getElementById('confirm-overlay');
      if (!ov) { resolve(window.confirm(opts.message || '')); return; } // 兜底
      const title = ov.querySelector('.cf-title');
      const msg = ov.querySelector('.cf-msg');
      const ok = ov.querySelector('.cf-ok');
      const cancel = ov.querySelector('.cf-cancel');
      title.textContent = opts.title || '确认操作';
      msg.textContent = opts.message || '';
      ok.textContent = opts.okText || '确定';
      cancel.textContent = opts.cancelText || '取消';
      // 危险操作时换配色，但保留 cf-ok 钩子类：整体覆盖 className 会让
      // 「程序化点确认」的代码（自动化测试、未来的快捷键逻辑）找不到按钮
      ok.className = 'cf-ok ' + (opts.danger ? 'btn-danger' : 'btn-primary');
      ov.classList.remove('hidden');
      let settled = false;
      function done(v) {
        if (settled) return;
        settled = true;
        ov.classList.add('hidden');
        document.removeEventListener('keydown', onKey);
        resolve(v);
      }
      function onKey(e) {
        if (e.key === 'Escape') { e.preventDefault(); done(false); }
        else if (e.key === 'Enter') { e.preventDefault(); done(document.activeElement === cancel ? false : true); }
      }
      ok.addEventListener('click', function () { done(true); });
      cancel.addEventListener('click', function () { done(false); });
      ov.addEventListener('click', function (e) { if (e.target === ov) done(false); });
      document.addEventListener('keydown', onKey);
      (opts.danger ? cancel : ok).focus();
    });
  }
};
