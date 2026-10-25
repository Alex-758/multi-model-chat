'use strict';
// 会话管理：新建 / 切换 / 重命名 / 置顶 / 删除
window.MM = window.MM || {};

(function () {
  const U = MM.util;

  function sorted() {
    // 防御非法条目：导入/手改的数据里可能有 null，直接读 pinned 会抛错
    return MM.state.sessions.filter(s => s && typeof s === 'object').slice().sort((a, b) => {
      if (!!b.pinned !== !!a.pinned) return b.pinned ? 1 : -1;
      return (b.updatedAt || 0) - (a.updatedAt || 0);
    });
  }

  // 整个会话累计的 token 消耗（含各模型回答 + 综合回答 + 历史版本）。
  // 只统计服务端真实回传的用量，历史数据没有该字段时返回 0，界面就不显示，绝不估算。
  // 按版本快照累加：重新生成后旧版本消耗仍计入（版本池里的每份快照都代表一次真实请求），
  // 当前显示内容已包含在最后一份快照里，不能再额外加一遍。
  function sessionTokens(s) {
    let total = 0;
    const add = u => { if (u) total += (u.input || 0) + (u.output || 0); };
    for (const m of (s && s.messages) || []) {
      if (!m || m.role !== 'assistant') continue;
      const versions = Array.isArray(m.versions) && m.versions.length ? m.versions : null;
      if (versions) {
        for (const v of versions) {
          for (const r of (v && v.results) || []) if (r) add(r.usage);
          if (v && v.merge) add(v.merge.usage);
        }
      } else {
        for (const r of (m.results) || []) if (r) add(r.usage);
        if (m.merge) add(m.merge.usage);
      }
    }
    return total;
  }

  function createSilent() {
    const s = { id: U.uid(), title: '新会话', createdAt: Date.now(), updatedAt: Date.now(), pinned: false, messages: [] };
    MM.state.sessions.unshift(s);
    MM.state.currentId = s.id;
    clearFilter(); // 新会话很可能不匹配过滤词，不清空会显得「点了新建没反应」
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
    // 不用属性选择器拼 id：导入的数据里 id 可能含引号，会抛 DOMException
    const item = U.$$('#session-list .session-item').find(x => x.getAttribute('data-id') === id) || null;
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

  async function remove(id) {
    const s = MM.state.sessions.find(x => x.id === id);
    if (!s) return;
    const ok = await U.confirm({
      title: '删除会话',
      message: '确定删除会话「' + s.title + '」？删除后不可恢复。',
      okText: '删除',
      danger: true
    });
    if (!ok) return;
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

  // ---------- 会话搜索 ----------
  // 按标题或消息内容过滤侧栏列表。纯前端内存过滤：会话量级（几十个）下每次全量扫描
  // 只有几毫秒，不值得建索引；输入走 160ms 防抖，长会话也不会打字卡顿。
  let filterText = '';

  function matchesFilter(s, q) {
    if (!q) return true;
    const title = String(s.title || '').toLowerCase();
    if (title.indexOf(q) >= 0) return true;
    for (const m of (s.messages || [])) {
      if (!m) continue;
      if (typeof m.content === 'string' && m.content.toLowerCase().indexOf(q) >= 0) return true;
      // 助手消息的正文在 results[].content 与 merge.content 里，别只搜 m.content 漏掉回答
      if (m.role === 'assistant') {
        for (const r of (m.results || [])) {
          if (r && typeof r.content === 'string' && r.content.toLowerCase().indexOf(q) >= 0) return true;
        }
        if (m.merge && typeof m.merge.content === 'string' && m.merge.content.toLowerCase().indexOf(q) >= 0) return true;
      }
    }
    return false;
  }

  function clearFilter() {
    filterText = '';
    const input = U.$('#session-filter');
    const btn = U.$('#btn-filter-clear');
    if (input) input.value = '';
    if (btn) btn.classList.add('hidden');
  }

  function render() {
    const list = U.$('#session-list');
    if (!list) return;
    list.innerHTML = '';
    const q = filterText.toLowerCase();
    const all = sorted();
    const items = q ? all.filter(s => matchesFilter(s, q)) : all;
    // 搜索无结果时给明确反馈，并留一键清除的出口；不过滤时保持原样
    if (q && !items.length) {
      list.appendChild(U.el('div', { class: 'session-empty' },
        U.el('div', {}, '没有匹配「' + filterText + '」的会话'),
        U.el('div', { class: 'se-total' }, '共 ' + all.length + ' 个会话'),
        U.el('button', { class: 'btn-ghost', onclick: function () { clearFilter(); render(); } }, '清除搜索')));
      return;
    }
    let prev = null;
    for (const s of items) {
      // 置顶会话与普通会话之间加细分隔线
      if (prev && prev.pinned && !s.pinned) {
        list.appendChild(U.el('div', { class: 'session-divider' }));
      }
      const roundCount = (s.messages || []).filter(m => m.role === 'user').length;
      const timeLabel = U.fmtTime(s.updatedAt || s.createdAt);
      const tok = sessionTokens(s);
      // 后台正在生成的会话加呼吸点标记（切到别的会话也能看到它还在跑）
      const live = !!(MM.chat.isStreamingSession && MM.chat.isStreamingSession(s.id));
      const item = U.el('div', {
        class: 'session-item' + (s.id === MM.state.currentId ? ' active' : '') + (live ? ' streaming' : ''),
        'data-id': s.id,
        title: s.title, // 标题被操作按钮挤窄时会截断，悬停看全名
        onclick: () => switchTo(s.id)
      },
        U.el('div', { class: 's-info' },
          U.el('div', { class: 's-title' },
            s.pinned ? U.el('span', { class: 'pin-dot', title: '已置顶' }) : null,
            s.title),
          U.el('div', { class: 's-time' },
            (timeLabel ? timeLabel + ' · ' : '') + roundCount + ' 轮' +
            (tok ? ' · ' + MM.modelInfo.fmtTokens(tok) + ' tok' : ''))
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

  // 搜索框事件：DOM 在脚本加载时已就绪（script 在 body 末尾），直接绑定
  (function bindSessionSearch() {
    const input = U.$('#session-filter');
    const btn = U.$('#btn-filter-clear');
    if (!input || !btn) return;
    const apply = U.debounce(function () { render(); }, 160);
    input.addEventListener('input', function () {
      filterText = input.value.trim();
      btn.classList.toggle('hidden', !filterText);
      apply();
    });
    // Esc：有词先清词；输入时焦点在侧栏，设置页必然是关着的，不存在抢 Esc 的问题。
    // 中文输入法守卫（协作约定 7）：组合中按 Esc 是取消候选词，不能连过滤词一起清掉
    let composing = false;
    input.addEventListener('compositionstart', function () { composing = true; });
    input.addEventListener('compositionend', function () { composing = false; });
    input.addEventListener('keydown', function (e) {
      if (composing || e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Escape' && input.value) {
        e.stopPropagation();
        clearFilter();
        render();
      }
    });
    btn.addEventListener('click', function () {
      clearFilter();
      render();
      input.focus();
    });
  })();

  MM.sessions = {
    create, createSilent, current, switchTo, renameInline, togglePin, remove, render, sorted,
    clearFilter,
    // 给 smoke 测试用的出口，不影响线上逻辑
    _sessionTokensForTest: sessionTokens,
    _setFilterForTest: function (text) { filterText = String(text || ''); },
    _matchesFilterForTest: matchesFilter
  };
})();
