'use strict';
// 会话管理：新建 / 切换 / 重命名 / 置顶 / 删除
window.MM = window.MM || {};

(function () {
  const U = MM.util;

  function sorted() {
    return MM.state.sessions.slice().sort((a, b) => {
      if (!!b.pinned !== !!a.pinned) return b.pinned ? 1 : -1;
      return (b.updatedAt || 0) - (a.updatedAt || 0);
    });
  }

  function createSilent() {
    const s = { id: U.uid(), title: '新会话', createdAt: Date.now(), updatedAt: Date.now(), pinned: false, messages: [] };
    MM.state.sessions.unshift(s);
    MM.state.currentId = s.id;
    MM.save();
    return s;
  }

  function create() {
    createSilent();
    MM.chat.renderAll();
    MM.chat.renderTitle();
    MM.sessions.render();
  }

  function current() {
    return MM.state.sessions.find(s => s.id === MM.state.currentId) || null;
  }

  function switchTo(id) {
    if (id === MM.state.currentId) return;
    MM.state.currentId = id;
    MM.chat.renderAll();
    MM.chat.renderTitle();
    MM.sessions.render();
  }

  function renameInline(id) {
    const s = MM.state.sessions.find(x => x.id === id);
    if (!s) return;
    const item = U.$('#session-list .session-item[data-id="' + id + '"]');
    const titleEl = item ? item.querySelector('.s-title') : null;
    if (!titleEl) return;
    const input = U.el('input', { type: 'text', value: s.title, style: 'width:100%;font-size:13px;padding:2px 6px;border-radius:5px' });
    titleEl.replaceWith(input);
    input.focus();
    input.select();
    input.addEventListener('click', e => e.stopPropagation());
    let done = false;
    const commit = () => {
      if (done) return;
      done = true;
      const v = input.value.trim();
      if (v) s.title = v.slice(0, 60);
      MM.save();
      MM.sessions.render();
      if (id === MM.state.currentId) MM.chat.renderTitle();
    };
    input.addEventListener('keydown', e => {
      e.stopPropagation();
      if (e.isComposing || e.keyCode === 229) return; // 输入法组合中忽略
      if (e.key === 'Enter') commit();
      if (e.key === 'Escape') { done = true; MM.sessions.render(); }
    });
    input.addEventListener('blur', commit);
  }

  function togglePin(id) {
    const s = MM.state.sessions.find(x => x.id === id);
    if (!s) return;
    s.pinned = !s.pinned;
    MM.save();
    MM.sessions.render();
    if (id === MM.state.currentId) MM.chat.renderTitle();
  }

  function remove(id) {
    const s = MM.state.sessions.find(x => x.id === id);
    if (!s) return;
    if (!window.confirm('确定删除会话「' + s.title + '」？删除后不可恢复。')) return;
    // 该会话可能正在生成：先停掉在途请求，避免删掉后还在后台消耗 token
    if (MM.chat.stopSession) MM.chat.stopSession(id);
    MM.state.sessions = MM.state.sessions.filter(x => x.id !== id);
    if (MM.state.currentId === id) {
      const first = sorted()[0];
      if (first) {
        MM.state.currentId = first.id;
      } else {
        createSilent();
      }
    }
    MM.chat.renderAll();
    MM.chat.renderTitle();
    MM.sessions.render();
    MM.save();
  }

  function render() {
    const list = U.$('#session-list');
    list.innerHTML = '';
    const items = sorted();
    let prev = null;
    for (const s of items) {
      // 置顶会话与普通会话之间加细分隔线
      if (prev && prev.pinned && !s.pinned) {
        list.appendChild(U.el('div', { class: 'session-divider' }));
      }
      const roundCount = (s.messages || []).filter(m => m.role === 'user').length;
      const timeLabel = U.fmtTime(s.updatedAt || s.createdAt);
      const item = U.el('div', {
        class: 'session-item' + (s.id === MM.state.currentId ? ' active' : ''),
        'data-id': s.id,
        title: s.title, // 标题被操作按钮挤窄时会截断，悬停看全名
        onclick: () => switchTo(s.id)
      },
        U.el('div', { class: 's-info' },
          U.el('div', { class: 's-title' },
            s.pinned ? U.el('span', { class: 'pin-dot', title: '已置顶' }) : null,
            s.title),
          U.el('div', { class: 's-time' }, (timeLabel ? timeLabel + ' · ' : '') + roundCount + ' 轮')
        ),
        U.el('div', { class: 's-actions' },
          U.el('button', { title: s.pinned ? '取消置顶' : '置顶', onclick: e => { e.stopPropagation(); togglePin(s.id); } }, s.pinned ? '已顶' : '置顶'),
          U.el('button', { title: '重命名', onclick: e => { e.stopPropagation(); renameInline(s.id); } }, '改名'),
          U.el('button', { class: 'del', title: '删除', onclick: e => { e.stopPropagation(); remove(s.id); } }, '删除')
        )
      );
      list.appendChild(item);
      prev = s;
    }
  }

  MM.sessions = { create, createSilent, current, switchTo, renameInline, togglePin, remove, render, sorted };
})();
