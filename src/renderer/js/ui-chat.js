'use strict';
// 聊天流：用户消息、多模型并行流式渲染、重新生成、综合回答、联网搜索
window.MM = window.MM || {};

(function () {
  const U = MM.util;
  let seq = 0;
  let streaming = false;
  const pending = new Map(); // requestId -> 请求上下文

  function stripModel(m) {
    return { id: m.id, name: m.name, provider: m.provider, apiFormat: m.apiFormat, baseUrl: m.baseUrl, modelId: m.modelId, apiKey: m.apiKey, fullUrl: m.fullUrl, maxTokens: m.maxTokens };
  }

  function setSendBtn(on) {
    const b = U.$('#btn-send');
    const inp = U.$('#input');
    inp.readOnly = on; // 生成中禁改（内容保留可复制）
    b.classList.toggle('stop', on);
    b.textContent = on ? '■' : '➤';
    b.title = on ? '停止生成' : '发送';
    b.classList.toggle('ready', on || inp.value.trim().length > 0);
    U.$('.input-row').classList.toggle('off', on);
    if (on) inp.placeholder = '生成中，请稍候…';
    else inp.placeholder = '输入消息…  Enter 发送，Shift+Enter 换行';
  }

  function selectedModels() {
    const ids = Array.from(U.$$('#model-chips .chip.on')).map(c => c.getAttribute('data-model-id'));
    return MM.settings.allFlatModels().filter(m => ids.includes(m.id));
  }

  // ---------- 模型芯片 ----------
  function renderChips() {
    const box = U.$('#model-chips');
    box.innerHTML = '';
    const models = MM.settings.allFlatModels();
    if (!models.length) {
      box.appendChild(U.el('div', { style: 'color:var(--muted);font-size:12.5px;padding:6px' }, '暂无可用模型，请在「设置 → 模型配置」中添加'));
      return;
    }
    for (const m of models) {
      const bits = [m.providerName + ' · ' + m.modelId];
      if (m.contextTokens) bits.push(MM.modelInfo.fmtTokens(m.contextTokens) + ' 上下文');
      if (m.multimodal) bits.push('多模态');
      if (!m.apiKey) bits.push('API Key 未设置，请在设置中填写');
      box.appendChild(U.el('div', {
        class: 'chip on',
        'data-model-id': m.id,
        title: bits.join(' · '),
        onclick: function () { this.classList.toggle('on'); }
      },
        U.el('span', {}, m.name || m.modelId)
      ));
    }
  }

  // ---------- 历史 ----------
  function pickAnswer(am) {
    if (!am || !am.results) return null;
    const done = am.results.filter(r => r.status === 'done' && r.content);
    if (!done.length) return null;
    // 多轮上下文优先取综合回答（若存在），其次取当前显示版本的回答
    if (am.merge && am.merge.content) return am.merge.content;
    return done[0].content;
  }

  // 粗略 token 估算：CJK 字符按 1 token，其他按 4 字符 1 token
  function estTokens(s) {
    if (!s) return 0;
    let cjk = 0;
    for (let i = 0; i < s.length; i++) {
      if (s.charCodeAt(i) > 0x2e80) cjk++;
    }
    return cjk + Math.ceil((s.length - cjk) / 4);
  }

  function buildHistory(s, userMsg, searchResults, ctxLimit, maxOut) {
    const msgs = [];
    for (const m of s.messages) {
      if (m === userMsg) break;
      if (m.role === 'user') {
        msgs.push({ role: 'user', content: m.content });
      } else if (m.role === 'assistant') {
        const best = pickAnswer(m);
        if (best) msgs.push({ role: 'assistant', content: best });
      } else if (m.role === 'merge') {
        if (m.content && msgs.length && msgs[msgs.length - 1].role === 'assistant') {
          msgs[msgs.length - 1].content = m.content; // 优先用综合回答作为上一轮上下文
        }
      }
    }
    if (searchResults && searchResults.length) {
      const src = searchResults.map(r => '- ' + r.title + '\n  ' + r.snippet + '\n  来源: ' + r.url).join('\n');
      msgs.push({ role: 'system', content: '以下是与用户问题相关的联网搜索结果，回答时可以参考：\n\n' + src });
    }
    // 按模型上下文窗口裁剪历史，避免超限报错
    if (ctxLimit) {
      const budget = Math.max(ctxLimit - (maxOut || 4096) - 4096, 4096);
      let total = msgs.reduce((a, x) => a + estTokens(x.content), 0);
      while (total > budget && msgs.length > 1) {
        total -= estTokens(msgs[0].content);
        msgs.shift();
        if (msgs.length && msgs[0].role === 'assistant') { // 保持 user/assistant 配对
          total -= estTokens(msgs[0].content);
          msgs.shift();
        }
      }
      // Anthropic 要求首条消息为 user
      while (msgs.length && msgs[0].role === 'assistant') msgs.shift();
    }
    msgs.push({ role: 'user', content: userMsg.content });
    return msgs;
  }

  // ---------- 渲染 ----------
  function renderTitle() {
    const s = MM.sessions.current();
    U.$('#session-title').textContent = s ? s.title : 'Multi-Model Chat';
  }

  function emptyState() {
    return U.el('div', { class: 'empty-state' },
      U.el('h1', {}, 'Multi-Model Chat'),
      U.el('p', {}, '在下方输入问题，同时获得多个模型的回答'),
      U.el('p', {}, '首次使用请在左下角「设置」中填写 API Key')
    );
  }

  function answerCard(res, streamingNow) {
    const card = U.el('div', { class: 'answer-card', 'data-model-id': res.modelId });
    const statusSpan = U.el('span', { class: 'ac-status' });
    statusSpan.innerHTML = statusHtml(res);
    card.appendChild(U.el('div', { class: 'ac-head' },
      U.el('span', { class: 'ac-dot', style: 'background:' + MM.settings.dotColor({ id: res.modelId }) }),
      U.el('span', { class: 'ac-name' }, res.name || res.modelId),
      statusSpan
    ));
    if (res.reasoning) {
      card.appendChild(U.el('details', { class: 'reasoning' },
        U.el('summary', {}, '查看思考过程'),
        U.el('div', { class: 'r-body' }, res.reasoning)));
    }
    if (res.sources && res.sources.length) {
      card.appendChild(U.el('details', { class: 'sources' },
        U.el('summary', {}, '📎 搜索来源 (' + res.sources.length + ')'),
        res.sources.map(r => U.el('a', { href: r.url, target: '_blank', rel: 'noopener' }, r.title || r.url))));
    }
    const body = U.el('div', { class: 'ac-body' + (streamingNow ? ' streaming' : ' md') });
    if (streamingNow) body.textContent = res.content || '';
    else if (res.status === 'error' && res.error) body.innerHTML = '<div class="ac-error">✗ ' + U.esc(res.error) + '</div>';
    else body.innerHTML = MM.md.render(res.content || '');
    card.appendChild(body);
    card.appendChild(U.el('div', { style: 'padding:6px 12px 8px;display:flex;gap:6px;justify-content:flex-end' },
      U.el('button', {
        class: 'ac-copy', onclick: function () { U.copyTextFrom(body); U.toast('已复制'); }
      }, '复制')));
    MM.md.bindCopy(card);
    return card;
  }

  function statusHtml(res) {
    if (res.status === 'streaming') return '<span class="spinner"></span> 生成中…';
    if (res.status === 'done') return '✓ ' + (res.ms ? U.fmtMs(res.ms) : '') + (res.chars ? ' · ' + res.chars + ' 字' : '');
    if (res.status === 'error') return '<span style="color:var(--danger)">✗ 失败</span>';
    if (res.status === 'stopped') return '<span style="color:var(--muted)">⏹ 已停止</span>';
    return '';
  }

  function answersGrid(am) {
    const grid = U.el('div', { class: 'answers' });
    for (const r of am.results) grid.appendChild(answerCard(r, false));
    return grid;
  }

  function mergeCard(msg, live) {
    const card = U.el('div', { class: 'merge-card', 'data-role': 'merge' });
    const label = msg.mode === 'model' ? '综合回答 · 模型二次综合' : '综合回答';
    const mStatus = U.el('span', { class: 'ac-status' });
    mStatus.innerHTML = live ? '<span class="spinner"></span>' : '';
    card.appendChild(U.el('div', { class: 'ac-head' },
      U.el('span', { class: 'ac-name' }, label),
      mStatus
    ));
    const body = U.el('div', { class: 'ac-body' + (live ? ' streaming' : ' md') });
    if (live) body.textContent = msg.content || '';
    else body.innerHTML = MM.md.render(msg.content || '');
    card.appendChild(body);
    card.appendChild(U.el('div', { style: 'padding:6px 12px 8px;display:flex;gap:6px;justify-content:flex-end' },
      U.el('button', { class: 'ac-copy', onclick: function () { U.copyTextFrom(body); U.toast('已复制'); } }, '复制')));
    MM.md.bindCopy(card);
    return card;
  }

  // ---------- 版本历史 ----------
  // 每轮回答的快照：{ results, merge, at }；am.active 指向当前显示的版本
  function snapshotOf(am) {
    return {
      results: JSON.parse(JSON.stringify(am.results || [])),
      merge: am.merge ? JSON.parse(JSON.stringify(am.merge)) : null,
      at: Date.now()
    };
  }
  function inheritVersionsOf(am) {
    const versions = Array.isArray(am.versions) ? am.versions.map(v => JSON.parse(JSON.stringify(v))) : [];
    const cur = snapshotOf(am);
    const last = versions[versions.length - 1];
    // 当前显示若与最后一份快照不同（或池为空），把当前显示也存入版本池
    if (!last || JSON.stringify(last.results) !== JSON.stringify(cur.results) || JSON.stringify(last.merge || null) !== JSON.stringify(cur.merge || null)) {
      versions.push(cur);
    }
    return versions;
  }
  function setVersion(am, i) {
    if (streaming) { U.toast('请等待当前任务完成', true); return; } // 综合生成中切换会错乱版本快照
    if (!am.versions || !am.versions.length) return;
    const idx = Math.max(0, Math.min(am.versions.length - 1, i));
    if (idx === am.active) return;
    am.active = idx;
    am.results = JSON.parse(JSON.stringify(am.versions[idx].results));
    am.merge = am.versions[idx].merge ? JSON.parse(JSON.stringify(am.versions[idx].merge)) : null;
    MM.save();
    renderAll();
  }

  function roundTools(am) {
    const hasMerge = !!(am.merge && am.merge.content);
    const tools = U.el('div', { class: 'round-tools', 'data-round': am.roundId });
    if (am.versions && am.versions.length > 1) {
      const idx = typeof am.active === 'number' ? am.active : am.versions.length - 1;
      tools.appendChild(U.el('button', {
        class: 'tool-btn', title: '上一版本', onclick: function () { setVersion(am, idx - 1); },
        disabled: idx <= 0
      }, '‹'));
      tools.appendChild(U.el('span', { class: 'ver-label' },
        '版本 ' + (idx + 1) + '/' + am.versions.length + (idx === am.versions.length - 1 ? '（最新）' : '')));
      tools.appendChild(U.el('button', {
        class: 'tool-btn', title: '下一版本', onclick: function () { setVersion(am, idx + 1); },
        disabled: idx >= am.versions.length - 1
      }, '›'));
    }
    tools.appendChild(U.el('button', { class: 'tool-btn', onclick: function () { retryRound(am.roundId); } }, '↻ 重新生成'));
    if (!hasMerge) {
      tools.appendChild(U.el('button', { class: 'tool-btn', onclick: function () { doMerge(am.roundId); } }, '综合回答'));
    }
    return tools;
  }

  function renderAll() {
    const wrap = U.$('#messages');
    wrap.innerHTML = '';
    const s = MM.sessions.current();
    U.$('#composer').style.display = s ? '' : 'none';
    if (!s || !s.messages.length) {
      wrap.appendChild(emptyState());
      return;
    }
    let i = 0;
    while (i < s.messages.length) {
      const m = s.messages[i];
      if (m.role === 'user') {
        wrap.appendChild(renderUser(m));
        i++;
        // 收集该轮的 assistant（兼容旧格式：独立 merge 消息在迁移时已折叠，此处兜底忽略）
        let am = null;
        while (i < s.messages.length && s.messages[i].role !== 'user') {
          if (s.messages[i].role === 'assistant') am = s.messages[i];
          i++;
        }
        if (am) {
          wrap.appendChild(answersGrid(am));
          if (am.merge && am.merge.content) wrap.appendChild(mergeCard(am.merge, false));
          wrap.appendChild(roundTools(am));
        }
      } else {
        i++;
      }
    }
    scrollBottom(true);
  }

  function renderUser(msg) {
    return U.el('div', { class: 'user-msg' },
      U.el('div', { class: 'user-bubble' },
        U.el('div', { style: 'white-space:pre-wrap' }, msg.content),
        U.el('div', { class: 'copy-hint', onclick: function () { U.copyText(msg.content); } }, '复制')
      ));
  }

  // ---------- 发送 ----------
  async function send() {
    if (streaming) { stopAll(); return; }
    const input = U.$('#input');
    const text = input.value.trim();
    if (!text) return;
    const models = selectedModels();
    if (!models.length) { U.toast('请先在输入框上方选择至少一个模型', true); return; }

    const s = MM.sessions.current() || MM.sessions.createSilent();
    const userMsg = { id: U.uid(), role: 'user', content: text, createdAt: Date.now() };
    s.messages.push(userMsg);
    if (s.title === '新会话') s.title = text.slice(0, 30);
    s.updatedAt = Date.now();
    MM.save();
    MM.sessions.render();
    renderTitle();

    // 清空空状态
    const wrap = U.$('#messages');
    const es = wrap.querySelector('.empty-state');
    if (es) es.remove();
    wrap.appendChild(renderUser(userMsg));
    scrollBottom(true);
    input.value = '';
    autoResize();

    dispatchRound(s, userMsg, models, U.$('#tgl-search').checked, true);
  }

  // 发起一轮多模型请求并渲染占位卡片（inheritVersions：重试时继承的历史版本池）
  async function dispatchRound(s, userMsg, models, searchOn, appendUserDom, inheritVersions) {
    let searchResults = userMsg.sources || null;
    if (searchOn && !searchResults) {
      try {
        searchResults = await api.search(userMsg.content, 6);
        if (!searchResults) U.toast('联网搜索未返回结果（可在设置中检查搜索引擎）');
      } catch (e) {
        U.toast('联网搜索失败：' + e.message, true);
        searchResults = null;
      }
      if (searchResults && searchResults.length) userMsg.sources = searchResults;
    }

    const roundId = U.uid();
    const reqId = 'req' + (++seq);
    // 取所选模型中最小的上下文窗口做裁剪，确保所有模型都不超限
    const ctxLimits = models.map(x => x.contextTokens).filter(Boolean);
    const ctxLimit = ctxLimits.length ? Math.min.apply(null, ctxLimits) : 0;
    const maxOut = Math.max.apply(null, models.map(x => x.maxTokens || 4096));
    const history = buildHistory(s, userMsg, searchResults, ctxLimit, maxOut);
    const targets = models.map(m => ({ model: stripModel(m), messages: history }));

    const assistantMsg = {
      id: U.uid(), role: 'assistant', roundId: roundId, createdAt: Date.now(),
      versions: Array.isArray(inheritVersions) ? inheritVersions : [],
      active: Array.isArray(inheritVersions) ? inheritVersions.length - 1 : -1,
      results: models.map(m => ({ modelId: m.id, name: m.name || m.modelId, status: 'streaming', content: '', reasoning: '' }))
    };
    s.messages.push(assistantMsg);
    s.updatedAt = Date.now();
    MM.save();

    streaming = true;
    setSendBtn(true);

    const wrap = U.$('#messages');
    const grid = U.el('div', { class: 'answers', 'data-round': roundId });
    for (const r of assistantMsg.results) grid.appendChild(answerCard(r, true));
    if (appendUserDom) { /* user DOM 已在 send() 中追加 */ }
    wrap.appendChild(grid);
    scrollBottom(true);

    pending.set(reqId, { session: s, assistantMsg: assistantMsg, grid: grid, userMsg: userMsg });
    try {
      await api.send({ requestId: reqId, targets: targets, searchOn: !!(searchResults || searchOn) });
    } catch (e) {
      pending.delete(reqId);
      streaming = false;
      setSendBtn(false);
      U.toast('请求失败：' + e.message, true);
    }
  }

  // ---------- 事件分发（全局只订阅一次） ----------
  function handleEvent(ev) {
    const ctx = pending.get(ev.requestId);
    if (!ctx) return;
    const wrap = U.$('#messages');

    if (ev.type === 'all-done') {
      pending.delete(ev.requestId);
      if (!pending.size) { streaming = false; setSendBtn(false); }
      if (ctx.mergeMsg) {
        // 综合请求结束：同步到当前版本的快照
        const am = ctx.am;
        if (am && Array.isArray(am.versions) && am.versions.length) {
          am.versions[am.active >= 0 ? am.active : am.versions.length - 1].merge =
            am.merge ? JSON.parse(JSON.stringify(am.merge)) : null;
        }
        finalizeMergeCard(ctx);
        MM.save();
        return;
      }
      // 回答轮结束：保存本版本快照
      const am = ctx.assistantMsg;
      am.versions = am.versions || [];
      const snap = snapshotOf(am);
      if (!am.versions.length || JSON.stringify(am.versions[am.versions.length - 1].results) !== JSON.stringify(snap.results)) {
        am.versions.push(snap);
      }
      am.active = am.versions.length - 1;
      // 重建轮次工具栏（版本导航 / 重新生成 / 综合回答入口）
      const oldTools = wrap.querySelector('.round-tools[data-round="' + am.roundId + '"]');
      if (oldTools) oldTools.remove();
      if (ctx.grid) ctx.grid.after(roundTools(am));
      MM.save();
      MM.sessions.render();
      if (U.$('#tgl-auto').checked) doMerge(am.roundId);
      return;
    }

    if (ctx.mergeMsg) {
      const body = ctx.mergeBody, status = ctx.mergeStatus;
      if (ev.type === 'start') { status.innerHTML = '<span class="spinner"></span> 生成中…'; }
      else if (ev.type === 'delta') {
        ctx.mergeMsg.content += ev.text;
        body.textContent = ctx.mergeMsg.content;
        scrollBottom();
      }
      else if (ev.type === 'error') {
        // 综合失败：回滚 merge 状态，允许用户再次点击“综合回答”
        ctx.mergeMsg.content += '\n\n（综合失败：' + ev.message + '）';
        status.innerHTML = '<span style="color:var(--danger)">✗</span>';
        if (ctx.am) {
          ctx.am.merge = null;
          syncMergeToVersion(ctx.am);
          const oldTools = wrap.querySelector('.round-tools[data-round="' + ctx.roundId + '"]');
          if (oldTools) oldTools.replaceWith(roundTools(ctx.am));
        }
      }
      return;
    }

    if (!ev.modelId) return;
    const res = ctx.assistantMsg.results.find(r => r.modelId === ev.modelId);
    const card = ctx.grid.querySelector('.answer-card[data-model-id="' + ev.modelId + '"]');
    if (!res || !card) return;
    const status = card.querySelector('.ac-status');
    const body = card.querySelector('.ac-body');

    if (ev.type === 'start') {
      status.innerHTML = '<span class="spinner"></span> 生成中…';
    } else if (ev.type === 'delta') {
      res.content += ev.text;
      body.textContent = res.content;
      scrollBottom();
    } else if (ev.type === 'reasoning') {
      res.reasoning = (res.reasoning || '') + ev.text;
      let det = card.querySelector('details.reasoning');
      if (!det) {
        det = U.el('details', { class: 'reasoning' },
          U.el('summary', {}, '查看思考过程'),
          U.el('div', { class: 'r-body' }));
        card.insertBefore(det, body);
      }
      det.querySelector('.r-body').textContent = res.reasoning;
    } else if (ev.type === 'done') {
      res.status = 'done'; res.ms = ev.ms; res.chars = ev.chars;
      status.textContent = '✓ ' + U.fmtMs(ev.ms) + ' · ' + ev.chars + ' 字';
      body.classList.remove('streaming');
      body.classList.add('md');
      body.innerHTML = MM.md.render(res.content);
    } else if (ev.type === 'error') {
      if (/已停止/.test(ev.message)) { res.status = 'stopped'; res.content = res.content || ''; }
      else { res.status = 'error'; res.error = ev.message; }
      body.classList.remove('streaming');
      if (res.status === 'error') {
        body.innerHTML = '<div class="ac-error">✗ ' + U.esc(ev.message) + '</div>';
      } else if (res.content) {
        body.classList.add('md');
        body.innerHTML = MM.md.render(res.content);
      }
      status.innerHTML = statusHtml(res);
    }
  }

  function stopAll() {
    for (const id of Array.from(pending.keys())) api.stop(id);
  }

  // ---------- 重新生成 ----------
  async function retryRound(roundId) {
    if (streaming) { U.toast('请等待当前任务完成', true); return; }
    const s = MM.sessions.current();
    if (!s) return;
    const idx = s.messages.findIndex(m => m.role === 'assistant' && m.roundId === roundId);
    if (idx < 0) return;
    const am = s.messages[idx];
    const userMsg = s.messages[idx - 1];
    if (!userMsg || userMsg.role !== 'user') return;
    const models = selectedModels();
    if (!models.length) { U.toast('请先选择模型', true); return; }
    // 当前显示版本存入历史版本池，由新一轮继承（不删除，可随时切换/回滚）
    const versions = inheritVersionsOf(am);
    // 仅移除该轮的助手回答及其后的综合消息（遇到下一条用户消息即停，不能波及更后面的轮次）
    let end = idx;
    while (end < s.messages.length && s.messages[end].role !== 'user') end++;
    s.messages.splice(idx, end - idx);
    s.updatedAt = Date.now();
    MM.save();
    renderAll();
    dispatchRound(s, userMsg, models, U.$('#tgl-search').checked, false, versions);
  }

  // ---------- 综合回答 ----------
  async function doMerge(roundId) {
    if (streaming) { U.toast('请等待当前任务完成', true); return; }
    const s = MM.sessions.current();
    if (!s) return;
    const idx = s.messages.findIndex(m => m.role === 'assistant' && m.roundId === roundId);
    if (idx < 0) return;
    const am = s.messages[idx];
    const userMsg = s.messages[idx - 1];
    if (!userMsg) return;
    if (am.merge && am.merge.content) {
      U.toast('该轮已有综合回答（重新生成会产生新版本）', true); return;
    }
    const okResults = am.results
      .filter(r => (r.status === 'done' || r.status === 'stopped') && r.content)
      .map(r => ({ modelId: r.modelId, name: r.name, content: r.content }));
    if (!okResults.length) { U.toast('没有可合并的成功回答', true); return; }

    const cfg = MM.state.config.synthesis || {};
    const source = cfg.synthSource || 'frontend';

    // 综合回答挂在轮次上（不再作为独立消息），并同步进当前版本快照
    am.merge = { content: '', mode: source === 'frontend' ? 'frontend' : 'model', createdAt: Date.now() };
    s.updatedAt = Date.now();
    MM.save();

    // 渲染实时卡片
    const wrap = U.$('#messages');
    const oldTools = wrap.querySelector('.round-tools[data-round="' + roundId + '"]');
    if (oldTools) oldTools.replaceWith(roundTools(am));
    const card = mergeCard(am.merge, true);
    wrap.appendChild(card);
    scrollBottom(true);

    if (source === 'frontend') {
      am.merge.content = MM.merge.frontend(okResults);
      syncMergeToVersion(am);
      finalizeMergeCard({ mergeMsg: am.merge, mergeBody: card.querySelector('.ac-body'), mergeStatus: card.querySelector('.ac-status'), am: am, roundId: roundId });
      MM.save();
      return;
    }

    // 模型二次综合
    const flats = MM.settings.allFlatModels();
    let model = flats.find(m => m.id === source);
    if (!model) model = flats[0];
    if (!model) {
      am.merge.content = '（未找到可用的综合模型，请在设置中配置）';
      syncMergeToVersion(am);
      finalizeMergeCard({ mergeMsg: am.merge, mergeBody: card.querySelector('.ac-body'), mergeStatus: card.querySelector('.ac-status'), am: am, roundId: roundId });
      MM.save();
      return;
    }
    streaming = true;
    setSendBtn(true);
    const t0 = Date.now();
    const reqId = 'syn' + (++seq);
    const prompt = MM.merge.synthesisPrompt(userMsg.content, okResults);
    pending.set(reqId, {
      mergeMsg: am.merge,
      mergeBody: card.querySelector('.ac-body'),
      mergeStatus: card.querySelector('.ac-status'),
      session: s,
      am: am,
      roundId: roundId
    });
    try {
      await api.synthesize({ requestId: reqId, model: stripModel(model), messages: [{ role: 'user', content: prompt }] });
    } catch (e) {
      pending.delete(reqId);
      streaming = false;
      setSendBtn(false);
      U.toast('综合失败：' + e.message, true);
      // 回滚 merge 状态并恢复工具栏，允许再次综合
      if (am) {
        am.merge = null;
        syncMergeToVersion(am);
      }
      const oldTools = wrap.querySelector('.round-tools[data-round="' + roundId + '"]');
      if (oldTools) oldTools.replaceWith(roundTools(am));
      const body = card && card.querySelector('.ac-body'), st = card && card.querySelector('.ac-status');
      if (body) { body.classList.remove('streaming'); body.innerHTML = '<div class="ac-error">✗ ' + U.esc(e.message) + '</div>'; }
      if (st) st.innerHTML = '<span style="color:var(--danger)">✗</span>';
    }
  }

  // 把综合回答同步进当前版本快照
  function syncMergeToVersion(am) {
    if (am && Array.isArray(am.versions) && am.versions.length) {
      const i = am.active >= 0 ? am.active : am.versions.length - 1;
      am.versions[i].merge = am.merge ? JSON.parse(JSON.stringify(am.merge)) : null;
    }
  }

  function finalizeMergeCard(ctx) {
    const body = ctx.mergeBody, status = ctx.mergeStatus;
    body.classList.remove('streaming');
    body.classList.add('md');
    body.innerHTML = MM.md.render(ctx.mergeMsg.content || '（空）');
    status.textContent = ctx.mergeMsg.mode === 'model' ? '✓ 完成' : '✓ 已合并';
    // 恢复工具栏（综合回答入口随 am.merge 状态更新）
    const wrap = U.$('#messages');
    const grid = wrap.querySelector('.answers[data-round="' + ctx.roundId + '"]');
    const oldTools = wrap.querySelector('.round-tools[data-round="' + ctx.roundId + '"]');
    if (oldTools) oldTools.remove();
    if (grid && ctx.am) grid.after(roundTools(ctx.am));
  }

  // ---------- 滚动：贴底检测 + 智能跟随 ----------
  function nearBottom() {
    const w = U.$('#messages');
    return w.scrollHeight - w.scrollTop - w.clientHeight < 140;
  }
  function scrollBottom(force) {
    const w = U.$('#messages');
    if (force || nearBottom()) w.scrollTop = w.scrollHeight;
  }

  function autoResize() {
    const ta = U.$('#input');
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 200) + 'px';
    U.$('#btn-send').classList.toggle('ready', !!U.$('#btn-send').classList.contains('stop') || ta.value.trim().length > 0);
  }

  // ---------- 绑定 ----------
  function bind() {
    U.$('#btn-new-chat').addEventListener('click', function () {
      if (streaming) stopAll();
      MM.sessions.create();
      renderAll();
      renderTitle();
      U.$('#input').focus();
    });
    U.$('#btn-send').addEventListener('click', function () {
      if (streaming) stopAll(); else send();
    });
    U.$('#input').addEventListener('input', autoResize);
    // 中文输入法兼容：组合输入（拼音候选）期间不能拦截按键，否则上屏会被打断
    let composing = false;
    U.$('#input').addEventListener('compositionstart', function () { composing = true; });
    U.$('#input').addEventListener('compositionend', function () { composing = false; });
    U.$('#input').addEventListener('keydown', function (e) {
      if (composing || e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
    });
    U.$('#btn-theme').addEventListener('click', function () {
      const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      try { localStorage.setItem('mmc-theme', next); } catch (e) { }
    });
    U.$('#tgl-auto').addEventListener('change', function () {
      MM.state.config.synthesis.autoMerge = this.checked;
      MM.save();
    });
    // 回到底部悬浮按钮：离开底部较远时出现
    const wrap = U.$('#messages');
    const sb = U.$('#btn-scroll-bottom');
    wrap.addEventListener('scroll', function () {
      const away = wrap.scrollHeight - wrap.scrollTop - wrap.clientHeight > 240;
      sb.classList.toggle('show', away);
    });
    sb.addEventListener('click', function () {
      wrap.scrollTo({ top: wrap.scrollHeight, behavior: 'smooth' });
    });
    U.$('#session-title').addEventListener('dblclick', function () {
      const s = MM.sessions.current();
      if (s) MM.sessions.renameInline(s.id);
    });
    api.onEvent(handleEvent);
    // 启动后聚焦输入框，便于直接打字
    setTimeout(() => {
      const inp = U.$('#input');
      if (inp && document.activeElement === document.body) inp.focus();
    }, 150);
  }

  MM.chat = { send, renderAll, renderChips, renderTitle, bind };
})();
