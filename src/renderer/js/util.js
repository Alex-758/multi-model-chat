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

  // 几何图标（内联 SVG，currentColor 着色）：替代 ×/➤/■/↓ 等图标字。
  // 字形在 em 框里的墨迹偏移随字号变化（× 在 18px 偏上 1.5px、20px 偏上 3px），
  // 静态 translate 修不准；SVG 以 viewBox 几何居中，任何尺寸/主题/DPI 都严格居中。
  svgIcon(name, size) {
    size = size || 12;
    var paths = {
      x: '<path d="M2.2 2.2l7.6 7.6M9.8 2.2l-7.6 7.6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" fill="none"/>',
      send: '<path d="M3 1.6v8.8l7.6-4.4z" fill="currentColor"/>',
      stop: '<rect x="2.2" y="2.2" width="7.6" height="7.6" rx="1.4" fill="currentColor"/>',
      down: '<path d="M6 2.2v7M2.9 6.1L6 9.2l3.1-3.1" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
      left: '<path d="M7.6 2.2L3.8 6l3.8 3.8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
      right: '<path d="M4.4 2.2L8.2 6l-3.8 3.8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
      plus: '<path d="M6 2.2v7.6M2.2 6h7.6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" fill="none"/>',
      caret: '<path d="M2.8 4.4h6.4L6 8.6z" fill="currentColor"/>',
      redo: '<path d="M10.3 6a4.3 4.3 0 1 1-4.3-4.3c1.2 0 2.3.44 3.1 1.2l1.2 1.1" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" fill="none"/><path d="M10.5 1.4v2.8H7.7" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" fill="none"/>'
    };
    return '<svg class="ico-svg" width="' + size + '" height="' + size + '" viewBox="0 0 12 12" aria-hidden="true">' + (paths[name] || '') + '</svg>';
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
      // 对话框元素是常驻 DOM：监听器必须在结束时移除，否则每次确认都累积一份闭包
      const onOk = function () { done(true); };
      const onCancel = function () { done(false); };
      const onOverlay = function (e) { if (e.target === ov) done(false); };
      function done(v) {
        if (settled) return;
        settled = true;
        ov.classList.add('hidden');
        document.removeEventListener('keydown', onKey);
        ok.removeEventListener('click', onOk);
        cancel.removeEventListener('click', onCancel);
        ov.removeEventListener('click', onOverlay);
        resolve(v);
      }
      function onKey(e) {
        if (e.key === 'Escape') { e.preventDefault(); done(false); }
        else if (e.key === 'Enter') { e.preventDefault(); done(document.activeElement === cancel ? false : true); }
      }
      ok.addEventListener('click', onOk);
      cancel.addEventListener('click', onCancel);
      ov.addEventListener('click', onOverlay);
      document.addEventListener('keydown', onKey);
      (opts.danger ? cancel : ok).focus();
    });
  }
};
