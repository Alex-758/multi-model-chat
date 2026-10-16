'use strict';
// 设置页：模型配置（服务商 + 多模型）/ 联网搜索 / 综合回答 / 数据管理
window.MM = window.MM || {};

(function () {
  const U = MM.util;
  let editingId = null; // 当前编辑的服务商 id
  let modelCountEl = null; // 模型卡片标题里的数量（增删模型后局部更新，不整页重建）

  let closeTimer = null; // 关闭动画定时器（防快速开/关互相打架）
  // 行内编辑防抖自动落盘：应用崩溃/强杀时最多丢失 600ms 内的编辑
  const saveSoon = U.debounce(() => { MM.save(); MM.chat.renderChips(); }, 600);

  // ---------- 打开 / 关闭 ----------
  function open() {
    if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
    const overlay = U.$('#settings-overlay');
    overlay.classList.remove('closing', 'hidden');
    renderModels();
    renderSearch();
    renderSynth();
    renderData();
    // 后台刷新 models.dev 模型目录（缓存 7 天）
    api.getCatalog().then(cat => {
      if (cat && cat !== MM.state.catalog) {
        MM.state.catalog = cat;
        renderModelEntries(); // 目录到达后刷新识别信息
      }
    }).catch(() => {});
  }
  function close() {
    const overlay = U.$('#settings-overlay');
    overlay.classList.add('closing'); // 播放淡出动画
    if (closeTimer) clearTimeout(closeTimer);
    closeTimer = setTimeout(() => {
      overlay.classList.add('hidden');
      overlay.classList.remove('closing');
      closeTimer = null;
    }, 150);
    // 行内编辑自动保存，并同步聊天页的模型选择器
    MM.save();
    if (MM.chat.renderChips) MM.chat.renderChips();
  }

  // ---------- 服务商 / 模型 ----------
  function providers() { return MM.state.config.providers; }
  function findProvider(id) { return providers().find(p => p.id === id); }

  function findMeta(p, id) {
    if (!MM.state.config.modelLists) return null;
    const list = MM.state.config.modelLists[p.id] || [];
    if (list.length && typeof list[0] === 'string') return null;
    const hit = list.find(x => x.id === id);
    if (hit && (hit.context || hit.multimodal != null)) {
      return { context: hit.context, multimodal: hit.multimodal };
    }
    return null;
  }

  // 服务商连接信息的扁平化模型对象（发请求 / 聊天芯片使用）
  // 注意：apiKey 只存在于主进程；这里只带 hasKey 标记
  function flatten(p, mo) {
    return {
      id: p.id + '::' + mo.modelId,
      providerId: p.id,
      providerName: p.name,
      provider: p.provider || p.id,
      apiFormat: p.apiFormat,
      baseUrl: p.baseUrl,
      hasKey: p.hasKey === true,
      fullUrl: p.fullUrl,
      modelId: mo.modelId,
      name: mo.name || mo.modelId,
      contextTokens: mo.contextTokens,
      maxTokens: mo.maxTokens,
      multimodal: mo.multimodal
    };
  }
  function allFlatModels() {
    const out = [];
    for (const p of providers()) {
      for (const mo of (p.models || [])) {
        if (mo.enabled !== false && mo.modelId) out.push(flatten(p, mo));
      }
    }
    return out;
  }

  function dotColor(key) {
    const colors = ['#6366f1', '#0ea5e9', '#f59e0b', '#10b981', '#ec4899', '#8b5cf6', '#ef4444', '#14b8a6'];
    let h = 0;
    for (const c of String(key || '')) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    return colors[h % colors.length];
  }

  // ---------- 模型配置 ----------
  function renderModels() {
    const pane = U.$('#pane-models');
    pane.innerHTML = '';
    modelCountEl = null;
    const cur = findProvider(editingId) || providers()[0];
    if (cur) editingId = cur.id;

    // 常驻标题行：服务商名 + 操作按钮（滚动模型条目时始终可见）
    const ops = U.el('div', { class: 'pm-head-ops' });
    pane.appendChild(U.el('div', { class: 'pm-head' },
      U.el('div', { class: 'pm-head-name' },
        U.el('span', { class: 'pm-name', title: cur ? (cur.name || cur.id) : '' }, cur ? (cur.name || cur.id) : '模型配置'),
        cur ? U.el('span', { class: 'tag' }, cur.preset ? '预置服务商' : '自定义服务商') : null),
      ops));

    const body = U.el('div', { class: 'pm-body' });
    pane.appendChild(body);

    const layout = U.el('div', { class: 'model-layout' });
    const list = U.el('div', { class: 'model-list' });
    for (const p of providers()) {
      const total = (p.models || []).length;
      const on = (p.models || []).filter(mo => mo.enabled !== false && mo.modelId).length;
      list.appendChild(U.el('div', {
        class: 'model-row' + (p.id === editingId ? ' active' : ''),
        onclick: () => { editingId = p.id; renderModels(); }
      },
        U.el('span', { class: 'ac-dot', style: 'background:' + dotColor(p.id) }),
        U.el('span', { class: 'p-name', title: p.name || p.id }, p.name || p.id),
        U.el('span', { class: 'tag', title: (p.preset ? '预置' : '自定义') + ' · ' + on + '/' + total + ' 启用' }, (p.preset ? '预置' : '自定义') + ' ' + on + '/' + total)
      ));
    }
    list.appendChild(U.el('div', { class: 'model-list-sep' }));
    list.appendChild(U.el('button', {
      class: 'btn-secondary', style: 'width:100%;margin-bottom:8px',
      onclick: () => {
        const p = { id: U.uid(), name: '自定义服务商', provider: 'custom', apiFormat: 'openai', baseUrl: '', apiKey: '', fullUrl: false, preset: false, models: [{ modelId: '', name: '', enabled: true }] };
        providers().push(p);
        editingId = p.id;
        MM.save();
        renderModels();
      }
    }, '添加自定义服务商'));
    list.appendChild(U.el('button', {
      class: 'btn-secondary', style: 'width:100%',
      onclick: () => {
        for (const def of MM.defaults.PRESET_PROVIDERS) {
          if (!findProvider(def.id)) providers().push(JSON.parse(JSON.stringify(def)));
        }
        MM.save(); renderModels(); MM.chat.renderChips();
        U.toast('已恢复预置服务商');
      }
    }, '恢复预置服务商'));

    const form = U.el('div', { class: 'model-form' });
    if (cur) {
      form.appendChild(providerForm(cur, ops));
    } else {
      form.appendChild(U.el('div', { class: 'pane-sub' }, '点击左侧服务商进行编辑，或添加自定义服务商。'));
    }

    layout.appendChild(list);
    layout.appendChild(form);
    body.appendChild(U.el('div', { class: 'pane-sub', style: 'margin-bottom:14px' },
      '每个服务商（共享地址与密钥）可配置多个模型；启用后出现在聊天输入框上方，可同时多选并发调用。'));
    body.appendChild(layout);
  }

  function getCache() {
    if (!MM.state.config.modelLists) MM.state.config.modelLists = {};
    const c = MM.state.config.modelLists;
    const list = c[editingId];
    if (list && list.length && typeof list[0] === 'string') {
      c[editingId] = list.map(x => ({ id: x }));
    }
    return c;
  }

  async function fetchList(p, btn) {
    // 不强制要求密钥：本地端点（Ollama / LM Studio / vLLM 等）通常无需密钥，
    // 由服务端返回 401/403 时再提示，避免这类端点永远拉不到模型列表
    if (!p.baseUrl) { U.toast('请先填写请求地址', true); return null; }
    if (btn) { btn.disabled = true; btn.textContent = '获取中…'; }
    try {
      const list = await api.listModels({ apiFormat: p.apiFormat, baseUrl: p.baseUrl, fullUrl: p.fullUrl, providerId: p.id, provider: p.provider || p.id });
      getCache()[p.id] = list;
      MM.save();
      return list;
    } catch (e) {
      U.toast('获取失败：' + e.message, true);
      return null;
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '获取模型列表'; }
    }
  }

  // 单个模型条目行（行内编辑，直接修改 provider.models 中的对象）
  function modelEntryRow(p, mo, listCache) {
    const midInput = U.el('input', { type: 'text', value: mo.modelId || '', placeholder: '模型 ID', autocomplete: 'off', style: 'width:100%;padding-right:28px' });
    const dropBtn = U.el('button', { type: 'button', class: 'mid-drop', title: '从模型列表选择', onmousedown: e => e.preventDefault() }, '▾');
    const dropPanel = U.el('div', { class: 'dropdown-panel hidden' });
    const idWrap = U.el('div', { class: 'mid-wrap' }, midInput, dropBtn, dropPanel);

    const nameInput = U.el('input', { type: 'text', value: mo.name || '', placeholder: '展示名（可选）', style: 'width:100%' });
    const ctxInput = U.el('input', { type: 'number', value: mo.contextTokens || '', placeholder: '自动', style: 'width:90px' });
    const outInput = U.el('input', { type: 'number', value: mo.maxTokens || '', placeholder: '自动', style: 'width:90px' });
    const enCheck = U.el('input', { type: 'checkbox', title: '启用', ...(mo.enabled !== false ? { checked: '' } : {}) });
    const delBtn = U.el('button', { class: 'm-del', title: '删除此模型' }, '✕');
    const infoHint = U.el('div', { class: 'hint' });

    function applyInfo(force) {
      const id = midInput.value.trim();
      if (!id) { infoHint.textContent = ''; return; }
      const meta = MM.modelInfo.guess(id, findMeta(p, id), MM.state.catalog, mo.multimodal, p.provider || p.id);
      if (force) {
        if (meta.contextTokens) ctxInput.value = meta.contextTokens;
        if (meta.maxOutputTokens) outInput.value = meta.maxOutputTokens;
      } else {
        if (!ctxInput.value && meta.contextTokens) ctxInput.value = meta.contextTokens;
        if (!outInput.value && meta.maxOutputTokens) outInput.value = meta.maxOutputTokens;
      }
      mo.modelId = id;
      mo.contextTokens = ctxInput.value ? parseInt(ctxInput.value, 10) : undefined;
      mo.maxTokens = outInput.value ? parseInt(outInput.value, 10) : undefined;
      mo.multimodal = meta.multimodal != null ? meta.multimodal : mo.multimodal;
      saveSoon(); // 落盘时同步聊天页选择器，避免逐条目重建
      const ctxVal = mo.contextTokens || meta.contextTokens;
      infoHint.textContent = '多模态：' + (mo.multimodal === true ? '支持' : mo.multimodal === false ? '不支持' : '未知') +
        ' · 上下文：' + (ctxVal ? MM.modelInfo.fmtTokens(ctxVal) : '未知') +
        ({ api: '（服务商）', catalog: '（模型库）', builtin: '（自动识别）', guess: '（推测）', none: '' }[meta.source] || '');
    }

    function renderPanel(kw) {
      dropPanel.innerHTML = '';
      const list = getCache()[p.id] || [];
      const k = (kw || '').toLowerCase();
      const filtered = k ? list.filter(x => x.id.toLowerCase().includes(k)) : list;
      if (!filtered.length) {
        dropPanel.appendChild(U.el('div', { class: 'dd-empty' }, list.length ? '无匹配项' : '列表为空，请先点上方「获取模型列表」'));
        return;
      }
      for (const it of filtered.slice(0, 300)) {
        // 元信息用数组拼，避免「有上下文但非多模态」时留下孤零零的分隔符
        const metaBits = [];
        if (it.context) metaBits.push(MM.modelInfo.fmtTokens(it.context));
        if (it.multimodal === true) metaBits.push('多模态');
        const meta = metaBits.length ? U.el('span', { class: 'dd-meta' }, metaBits.join(' · ')) : null;
        dropPanel.appendChild(U.el('div', {
          class: 'dd-item' + (it.id === mo.modelId ? ' cur' : ''),
          onmousedown: e => e.preventDefault(),
          onclick: () => {
            midInput.value = it.id;
            dropPanel.classList.add('hidden');
            applyInfo(true);
          }
        },
          U.el('span', { class: 'dd-id' }, it.id),
          meta
        ));
      }
    }

    dropBtn.addEventListener('click', e => {
      e.stopPropagation();
      if (!dropPanel.classList.contains('hidden')) { dropPanel.classList.add('hidden'); return; }
      renderPanel(midInput.value);
      dropPanel.classList.remove('hidden');
    });
    midInput.addEventListener('focus', () => { renderPanel(midInput.value); dropPanel.classList.remove('hidden'); });
    midInput.addEventListener('input', () => { renderPanel(midInput.value); dropPanel.classList.remove('hidden'); });
    midInput.addEventListener('blur', () => {
      setTimeout(() => dropPanel.classList.add('hidden'), 180);
      applyInfo(true);
    });
    nameInput.addEventListener('input', () => { mo.name = nameInput.value.trim(); saveSoon(); });
    ctxInput.addEventListener('change', () => { mo.contextTokens = ctxInput.value ? parseInt(ctxInput.value, 10) : undefined; saveSoon(); });
    outInput.addEventListener('change', () => { mo.maxTokens = outInput.value ? parseInt(outInput.value, 10) : undefined; saveSoon(); });
    enCheck.addEventListener('change', () => {
      mo.enabled = enCheck.checked;
      saveSoon();
      MM.chat.renderChips(); // 启用状态实时反映到聊天页模型选择器
    });
    delBtn.addEventListener('click', () => {
      p.models = p.models.filter(x => x !== mo);
      MM.save();
      renderModelEntries();
      MM.chat.renderChips();
    });

    const row = U.el('div', { class: 'm-entry' },
      U.el('div', { class: 'm-row' }, idWrap, nameInput,
        U.el('label', { class: 'inline-check', title: '启用' }, enCheck, '启用'), delBtn),
      U.el('div', { class: 'm-row m-row2' },
        U.el('span', { class: 'mini-label' }, '上下文'), ctxInput,
        U.el('span', { class: 'mini-label' }, '最大输出'), outInput,
        infoHint));
    // 挂载后回填识别信息（只补空字段）
    setTimeout(() => applyInfo(false), 0);
    return row;
  }

  // 渲染当前服务商的模型条目列表（目录刷新后局部重建）
  function renderModelEntries() {
    const box = U.$('#model-entries');
    if (!box) return;
    const p = findProvider(editingId);
    if (!p) return;
    if (modelCountEl) modelCountEl.textContent = '📦 模型（' + (p.models || []).length + '）';
    box.innerHTML = '';
    const listCache = getCache();
    for (const mo of (p.models || [])) box.appendChild(modelEntryRow(p, mo, listCache));
  }

  function providerForm(p, ops) {
    const wrap = U.el('div', {});

    // ---- 连接卡片：地址与密钥（该服务商下所有模型共用） ----
    const fmtSel = U.el('select', { id: 'p-format' },
      U.el('option', { value: 'openai', selected: p.apiFormat !== 'anthropic' }, 'OpenAI Chat Completions 格式'),
      U.el('option', { value: 'anthropic', selected: p.apiFormat === 'anthropic' }, 'Anthropic Messages 格式')
    );
    const urlInput = U.el('input', { type: 'text', id: 'p-url', placeholder: '例如 https://api.openai.com/v1', value: p.baseUrl || '' });
    const fullUrlCheck = U.el('input', { type: 'checkbox', id: 'p-fullurl', ...(p.fullUrl ? { checked: '' } : {}) });
    // 密钥只写入主进程保管：输入框不回显已存密钥；"清除"内联在同行
    const keyInput = U.el('input', {
      type: 'password', id: 'p-key', value: '',
      placeholder: p.hasKey ? '已保存密钥——输入新值可覆盖' : '请输入 API Key'
    });
    const clearKeyBtn = U.el('button', {
      class: 'btn-secondary', style: 'flex:none;padding:0 12px',
      ...(p.hasKey ? {} : { disabled: '' })
    }, '清除');
    clearKeyBtn.addEventListener('click', async () => {
      if (!p.hasKey) return;
      if (!window.confirm('确定清除已保存的 API 密钥？')) return;
      await api.clearSecret(p.id);
      p.hasKey = false;
      keyInput.placeholder = '请输入 API Key';
      clearKeyBtn.disabled = true;
      U.toast('密钥已清除');
      MM.chat.renderChips();
    });

    // 连接设置实时写回 + 防抖落盘
    fmtSel.addEventListener('change', () => { p.apiFormat = fmtSel.value; saveSoon(); });
    urlInput.addEventListener('change', () => { p.baseUrl = urlInput.value.trim(); saveSoon(); });
    fullUrlCheck.addEventListener('change', () => { p.fullUrl = fullUrlCheck.checked; saveSoon(); });
    keyInput.addEventListener('change', () => { commitKeyIfTyped(); });

    const result = U.el('div', { class: 'test-result' });
    wrap.appendChild(U.el('div', { class: 'p-card' },
      U.el('div', { class: 'p-card-h' },
        U.el('span', {}, '🔌 连接'),
        U.el('span', { class: 'p-card-note' }, '该服务商下所有模型共用')),
      U.el('div', { class: 'p-card-b' },
        hrow('API 格式', fmtSel),
        hrow('请求地址', urlInput, U.el('label', { class: 'inline-check', title: '勾选后不再自动补全路径' }, fullUrlCheck, '完整 URL')),
        U.el('div', { class: 'hint h-indent' }, '兼容 OpenAI API 的服务端点地址，不要以斜杠结尾；不勾选「完整 URL」时自动补全 /chat/completions 或 /v1/messages。'),
        hrow('API 密钥', keyInput, clearKeyBtn),
        U.el('div', { class: 'hint h-indent' }, p.hasKey ? '已保存密钥不在本界面显示；输入新值并保存可覆盖，点“清除”删除。密钥仅保存在本机。' : '密钥仅保存在本机。'),
        result)));

    async function commitKeyIfTyped() {
      const k = keyInput.value.trim();
      if (!k) return;
      await api.setSecret(p.id, k);
      p.hasKey = true;
      keyInput.value = '';
      keyInput.placeholder = '已保存密钥——输入新值可覆盖';
    }

    // ---- 模型卡片：该服务商下的模型列表 ----
    const getListBtn = U.el('button', {
      class: 'btn-secondary',
      onclick: async (e) => {
        p.baseUrl = U.$('#p-url').value.trim();
        await commitKeyIfTyped(); // 输入了新密钥先保存
        const list = await fetchList(p, e.currentTarget);
        if (list) { U.toast('获取到 ' + list.length + ' 个模型'); renderModelEntries(); }
      }
    }, '获取模型列表');
    const addModelBtn = U.el('button', {
      class: 'btn-secondary',
      onclick: () => {
        p.models = p.models || [];
        p.models.push({ modelId: '', name: '', enabled: true });
        renderModelEntries();
      }
    }, U.el('span', { class: 'ico' }, '＋'), '添加模型');

    modelCountEl = U.el('span', {}, '📦 模型（' + (p.models || []).length + '）');
    const modelCard = U.el('div', { class: 'p-card' },
      U.el('div', { class: 'p-card-h' }, modelCountEl, U.el('div', { class: 'ops' }, getListBtn, addModelBtn)));
    const entries = U.el('div', { id: 'model-entries' });
    const listCache = getCache();
    for (const mo of (p.models || [])) entries.appendChild(modelEntryRow(p, mo, listCache));
    modelCard.appendChild(U.el('div', { class: 'p-card-b' },
      entries,
      U.el('div', { class: 'hint' }, '模型 ID 可手动输入，或点 ▾ 从已获取的列表中选择；上下文/最大输出/多模态由模型 ID 自动识别，可手动修改。')));
    wrap.appendChild(modelCard);

    // ---- 常驻标题行按钮：删除（仅自定义）/ 测试连接 / 保存 ----
    const testBtn = U.el('button', { class: 'btn-secondary' }, '测试连接');
    testBtn.addEventListener('click', async () => {
      const mo = (p.models || []).find(x => x.modelId && x.enabled !== false) || (p.models || [])[0];
      if (!mo || !mo.modelId) { result.className = 'test-result err'; result.textContent = '✗ 请先在模型卡片中添加模型 ID'; return; }
      testBtn.disabled = true; testBtn.textContent = '测试中…';
      result.className = 'test-result';
      try {
        await commitKeyIfTyped(); // 输入了新密钥先保存
        const reply = await api.testModel({ apiFormat: p.apiFormat, baseUrl: p.baseUrl, fullUrl: p.fullUrl, modelId: mo.modelId, providerId: p.id, provider: p.provider || p.id });
        result.className = 'test-result ok';
        result.textContent = '✓ 连接成功（' + mo.modelId + '），回复：' + String(reply).slice(0, 100);
      } catch (e) {
        result.className = 'test-result err';
        result.textContent = '✗ ' + e.message;
      }
      testBtn.disabled = false; testBtn.textContent = '测试连接';
    });

    const saveBtn = U.el('button', { class: 'btn-primary' }, '保存');
    saveBtn.addEventListener('click', async () => {
      await commitKeyIfTyped(); // 输入了新密钥先写入主进程保管
      MM.save(); MM.chat.renderChips();
      U.toast('已保存「' + p.name + '」');
    });

    if (!p.preset) {
      const delBtn = U.el('button', { class: 'btn-danger' }, '删除');
      delBtn.addEventListener('click', () => {
        if (!window.confirm('确定删除服务商「' + p.name + '」及其全部模型？')) return;
        MM.state.config.providers = providers().filter(x => x.id !== p.id);
        editingId = null;
        MM.save(); renderModels(); MM.chat.renderChips();
      });
      ops.appendChild(delBtn);
    }
    ops.appendChild(testBtn);
    ops.appendChild(saveBtn);

    return wrap;
  }

  function field(label, input, ...hints) {
    // 字符串提示自动包成 .hint；已是元素的（如复选框行）原样插入，避免多包一层造成间距叠加
    return U.el('div', { class: 'field' },
      U.el('label', {}, label),
      input,
      ...hints.filter(Boolean).map(h => typeof h === 'string' ? U.el('div', { class: 'hint' }, h) : h));
  }

  // 水平字段行：标签固定宽度在左、控件在右（连接卡片用，比上下堆叠更紧凑）
  function hrow(label, ...controls) {
    return U.el('div', { class: 'hrow' },
      U.el('label', {}, label),
      U.el('div', { class: 'hctl' }, ...controls));
  }

  // ---------- 联网搜索 ----------
  function renderSearch() {
    const pane = U.$('#pane-search');
    pane.innerHTML = '';
    const cfg = MM.state.config.search;
    pane.appendChild(U.el('div', { class: 'pane-title' }, '联网搜索'));
    pane.appendChild(U.el('div', { class: 'pane-sub', style: 'margin-bottom:6px' }, '聊天页开启「联网搜索」开关后：'));
    const tips = U.el('ul', { class: 'tip-list' });
    for (const t of [
      'DeepSeek / 硅基流动 / 自定义端点：用下方选择的搜索引擎检索，结果注入对话上下文；',
      '阿里百炼：自动开启原生 enable_search；',
      '智谱 BigModel：自动开启原生 web_search 工具；',
      'OpenRouter：自动为模型 ID 追加 :online 后缀。'
    ]) tips.appendChild(U.el('li', {}, t));
    pane.appendChild(tips);

    const provSel = U.el('select', { id: 's-provider' },
      U.el('option', { value: 'bing', selected: (cfg.provider || 'bing') === 'bing' }, '必应搜索（免费，无需密钥）'),
      U.el('option', { value: 'tavily', selected: cfg.provider === 'tavily' }, 'Tavily（免费额度 1000 次/月）'),
      U.el('option', { value: 'bocha', selected: cfg.provider === 'bocha' }, '博查 Bocha（国内，付费）'),
      U.el('option', { value: 'none', selected: cfg.provider === 'none' }, '不使用搜索')
    );
    const keyRow = U.el('div', {});
    const keyInput = U.el('input', {
      type: 'password', id: 's-key', style: 'width:100%',
      placeholder: cfg.hasKey ? '已保存密钥——输入新值可覆盖' : '搜索 API Key'
    });
    const keyHint = U.el('div', { class: 'hint' });
    keyRow.appendChild(keyInput);
    keyRow.appendChild(keyHint);
    const result = U.el('div', { class: 'test-result' });
    // 整个字段一起显隐：密钥不适用时不留孤零零的「API 密钥」标签
    const keyField = field('API 密钥', keyRow);

    async function commitSearchKeyIfTyped() {
      const k = keyInput.value.trim();
      if (k) { await api.setSecret('search', k); cfg.hasKey = true; keyInput.value = ''; keyInput.placeholder = '已保存密钥——输入新值可覆盖'; }
    }

    function syncKeyVisible() {
      const pv = provSel.value;
      const needKey = pv === 'tavily' || pv === 'bocha';
      keyField.style.display = needKey ? '' : 'none';
      keyHint.textContent = pv === 'tavily' ? '注册获取：app.tavily.com（免费 1000 次/月）'
        : pv === 'bocha' ? '注册获取：open.bochaai.com'
        : '';
    }
    provSel.addEventListener('change', syncKeyVisible);
    syncKeyVisible();

    const saveBtn = U.el('button', { class: 'btn-primary' }, '保存');
    saveBtn.addEventListener('click', async () => {
      const pv = provSel.value;
      if ((pv === 'tavily' || pv === 'bocha') && !keyInput.value.trim() && !cfg.hasKey) {
        result.className = 'test-result err';
        result.textContent = '✗ 所选搜索服务商需要 API 密钥，请填写后再保存';
        return;
      }
      await commitSearchKeyIfTyped();
      cfg.provider = pv;
      MM.save(); U.toast('搜索设置已保存');
    });
    const testBtn = U.el('button', { class: 'btn-secondary' }, '测试搜索');
    testBtn.addEventListener('click', async () => {
      const pv = provSel.value;
      result.className = 'test-result';
      if (pv === 'none') { result.className = 'test-result err'; result.textContent = '当前为「不使用搜索」，请先选择搜索引擎'; return; }
      if ((pv === 'tavily' || pv === 'bocha') && !keyInput.value.trim() && !cfg.hasKey) { result.className = 'test-result err'; result.textContent = '✗ 请先填写 API 密钥'; return; }
      testBtn.disabled = true; testBtn.textContent = '搜索中…';
      try {
        await commitSearchKeyIfTyped();
        const rs = await api.testSearch({ provider: pv });
        if (!rs || !rs.length) { result.className = 'test-result err'; result.textContent = '✗ 未返回结果'; }
        else { result.className = 'test-result ok'; result.textContent = '✓ 返回 ' + rs.length + ' 条结果：' + rs[0].title; }
      } catch (e) {
        result.className = 'test-result err'; result.textContent = '✗ ' + e.message;
      }
      testBtn.disabled = false; testBtn.textContent = '测试搜索';
    });

    pane.appendChild(field('搜索服务商', provSel));
    pane.appendChild(keyField);
    pane.appendChild(U.el('div', { class: 'form-actions' }, saveBtn, testBtn));
    pane.appendChild(result);
  }

  // ---------- 综合回答 ----------
  function renderSynth() {
    const pane = U.$('#pane-synth');
    pane.innerHTML = '';
    const cfg = MM.state.config.synthesis;
    pane.appendChild(U.el('div', { class: 'pane-title' }, '综合回答'));
    pane.appendChild(U.el('div', { class: 'pane-sub' }, '选择每轮回答完成后，用什么方式把多个模型的回答合并为一份综合回答。'));

    // 单一“综合方式”选择：第一项前端合并，其余每项一个模型（避免“选了模型但模式没切”的错配）
    const sourceSel = U.el('select', { id: 'y-source', style: 'width:100%' });
    sourceSel.appendChild(U.el('option',
      { value: 'frontend', selected: (cfg.synthSource || 'frontend') === 'frontend' },
      '前端智能合并（本地重组，不消耗 token）'));
    const flats = MM.settings.allFlatModels();
    if (!flats.length) {
      sourceSel.appendChild(U.el('option', { value: 'frontend', disabled: '' }, '（暂无可用模型，添加后可选择模型综合）'));
    }
    for (const f of flats) {
      sourceSel.appendChild(U.el('option',
        { value: f.id, selected: cfg.synthSource === f.id },
        '模型综合：' + f.providerName + ' · ' + f.name));
    }

    const autoCheck = U.el('input', { type: 'checkbox', id: 'y-auto', ...(cfg.autoMerge ? { checked: '' } : {}) });

    const saveBtn = U.el('button', { class: 'btn-primary', style: 'margin-top:16px' }, '保存');
    saveBtn.addEventListener('click', () => {
      cfg.synthSource = sourceSel.value;
      cfg.autoMerge = autoCheck.checked;
      MM.save();
      U.$('#tgl-auto').checked = cfg.autoMerge;
      U.toast('综合设置已保存');
    });

    pane.appendChild(field('综合方式', sourceSel,
      '「模型综合」由所选模型把各回答重写为一份完整的最终回答，更连贯，但每轮多消耗一次请求。',
      '「前端智能合并」在本地重组，不消耗 token。'));
    pane.appendChild(U.el('div', { class: 'field' },
      U.el('label', { class: 'inline-check' }, autoCheck, '回答完成后自动执行综合（顶栏「自动综合」开关）')));
    pane.appendChild(saveBtn);
  }

  // ---------- 数据管理 ----------
  function renderData() {
    const pane = U.$('#pane-data');
    pane.innerHTML = '';
    pane.appendChild(U.el('div', { class: 'pane-title' }, '数据管理'));
    pane.appendChild(U.el('div', { class: 'pane-sub' }, '所有数据仅保存在本机（用户目录），不会上传到任何服务器。'));

    const box = U.el('div', { class: 'data-actions' });
    box.appendChild(U.el('button', {
      class: 'btn-secondary',
      onclick: async () => {
        const p = await api.exportData({ config: MM.state.config, sessions: MM.state.sessions });
        if (p) U.toast('已导出到 ' + p);
      }
    }, U.el('span', {}, '导出数据'), U.el('small', {}, '将模型配置与全部会话导出为 JSON 备份文件')));

    box.appendChild(U.el('button', {
      class: 'btn-secondary',
      onclick: async () => {
        const data = await api.importData();
        if (!data) return;
        const cfg = data.config || {};
        // 兼容 1.0 的平铺结构（config.models），交由 MM.normalizeConfig 统一迁移
        if (!Array.isArray(data.sessions) && !Array.isArray(cfg.providers) && !Array.isArray(cfg.models)) {
          U.toast('文件格式不正确', true); return;
        }
        MM.state.config = MM.normalizeConfig(cfg);
        MM.state.sessions = Array.isArray(data.sessions) ? data.sessions : [];
        MM.migrateSessions(MM.state.sessions);
        if (!MM.state.sessions.length) MM.sessions.createSilent();
        const top = MM.sessions.sorted()[0];
        MM.state.currentId = top ? top.id : null;
        U.$('#tgl-auto').checked = !!MM.state.config.synthesis.autoMerge;
        // 旧备份迁移后带明文密钥：先落盘交给主进程保管，再从渲染层状态剥离
        await MM.save();
        MM.stripSecrets(MM.state.config);
        renderModels(); renderSearch(); renderSynth();
        MM.chat.renderAll(); MM.sessions.render(); MM.chat.renderChips();
        U.toast('导入成功');
      }
    }, U.el('span', {}, '导入数据'), U.el('small', {}, '从备份文件恢复，将覆盖当前全部数据')));

    box.appendChild(U.el('button', {
      class: 'btn-secondary', style: 'color:var(--danger)',
      onclick: () => {
        if (!window.confirm('确定清空所有会话？模型配置将保留。')) return;
        MM.state.sessions = [];
        MM.state.currentId = null;
        MM.sessions.create();
        U.toast('已清空会话');
      }
    }, U.el('span', {}, '清空所有会话'), U.el('small', {}, '删除全部聊天记录，保留模型配置')));

    pane.appendChild(box);
  }

  // ---------- 事件绑定 ----------
  function bind() {
    U.$('#btn-settings').addEventListener('click', open);
    U.$('#btn-settings-close').addEventListener('click', close);
    U.$('#btn-settings-x').addEventListener('click', close);
    U.$('#settings-overlay').addEventListener('click', e => { if (e.target.id === 'settings-overlay') close(); });
    // Esc 关闭设置页
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && !U.$('#settings-overlay').classList.contains('hidden')) {
        close();
      }
    });
    for (const nav of U.$$('.settings-nav')) {
      nav.addEventListener('click', () => {
        for (const n of U.$$('.settings-nav')) n.classList.remove('active');
        nav.classList.add('active');
        for (const p of U.$$('.settings-pane')) p.classList.remove('active');
        U.$('#pane-' + nav.dataset.pane).classList.add('active');
      });
    }
  }

  MM.settings = { open, close, bind, renderModels, dotColor, allFlatModels };
})();
