'use strict';
// 设置页：模型配置（服务商 + 多模型）/ 联网搜索 / 综合回答 / 数据管理
window.MM = window.MM || {};

(function () {
  const U = MM.util;
  let editingId = null; // 当前编辑的服务商 id
  let modelCountEl = null; // 模型卡片标题里的数量（增删模型后局部更新，不整页重建）

  let closeTimer = null; // 关闭动画定时器（防快速开/关互相打架）
  // 行内编辑防抖自动落盘：应用崩溃/强杀时最多丢失 600ms 内的编辑
  const saveSoon = U.debounce(() => { MM.save({ configOnly: true }); syncModelConsumers(); }, 600);

  // ---------- 打开 / 关闭 ----------
  function open() {
    if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
    const overlay = U.$('#settings-overlay');
    overlay.classList.remove('closing', 'hidden');
    renderModels();
    renderSearch();
    renderSynth();
    renderPrompt();
    renderData();
    // 模型目录每次运行只取一次（主进程有 7 天缓存）：避免每次打开设置页都跨进程传 1MB+
    if (!MM.state.catalog) {
      api.getCatalog().then(cat => {
        if (cat && cat !== MM.state.catalog) {
          MM.state.catalog = cat;
          renderModelEntries(); // 目录到达后刷新识别信息
        }
      }).catch(() => {});
    }
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
    // 行内编辑自动保存，并同步聊天页选择器与综合回答下拉
    MM.save({ configOnly: true });
    syncModelConsumers();
  }

  // ---------- 服务商 / 模型 ----------
  function providers() {
    return (MM.state.config && Array.isArray(MM.state.config.providers)) ? MM.state.config.providers : [];
  }
  function findProvider(id) { return providers().find(p => p && p.id === id); }

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
    const seen = new Set();
    for (const p of providers()) {
      if (!p || typeof p !== 'object') continue;
      for (const mo of (p.models || [])) {
        if (!mo || typeof mo !== 'object') continue;
        if (mo.enabled === false || !mo.modelId) continue;
        const flat = flatten(p, mo);
        // 同一服务商下可能出现重复模型 ID（从列表里手选时容易造成）：
        // 重复的扁平 ID 会让聊天芯片/并发目标重复，事件只更新其中一张卡片。
        if (seen.has(flat.id)) continue;
        seen.add(flat.id);
        out.push(flat);
      }
    }
    return out;
  }

  // 模型/服务商变动后统一刷新所有依赖「可用模型集合」的地方。
  // 漏掉任何一处都会留下指向已删除模型的残留项（例如综合回答下拉里还挂着已删的模型）。
  function syncModelConsumers() {
    // 综合来源指向已不存在的模型时回落到前端合并，否则会一直用失效配置静默失败
    const cfg = MM.state.config.synthesis;
    if (cfg && cfg.synthSource && cfg.synthSource !== 'frontend') {
      if (!allFlatModels().some(m => m.id === cfg.synthSource)) cfg.synthSource = 'frontend';
    }
    if (MM.chat.renderChips) MM.chat.renderChips();
    renderSynth();
  }

  function dotColor(key) {
    const colors = ['#6366f1', '#0ea5e9', '#f59e0b', '#10b981', '#ec4899', '#8b5cf6', '#ef4444', '#14b8a6'];
    let h = 0;
    for (const c of String(key || '')) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    return colors[h % colors.length];
  }

  // ---------- 模型配置 ----------
  // force=true 用于数据被整体替换（如导入备份）必须重画的场景
  function renderModels(force) {
    const pane = U.$('#pane-models');
    // 正在模型表单里输入时不重建：整块 innerHTML 重建会丢掉未提交的编辑
    // （点左侧服务商行时输入框已先失焦，不会命中这个守卫）
    if (pane && !force) {
      const active = document.activeElement;
      if (active && pane.contains(active) && /^(INPUT|SELECT|TEXTAREA)$/.test(active.tagName)) return;
    }
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
    // 国内 → 国际 → 自定义。normalizeConfig 已排好序，这里只按区间插小节标题，
    // 让分组一眼可见，而不是把「排序规则」藏起来。
    // 国际：OpenRouter（聚合）与 OpenAI / Anthropic / Google 三家海外官方；其余预置算国内。
    const INTL = { openrouter: 1, openai: 1, anthropic: 1, google: 1 };
    const groupOf = p => (p.preset ? (INTL[p.provider || p.id] ? 'international' : 'domestic') : 'custom');
    const GROUP_LABEL = { domestic: '国内服务商', international: '国际服务商', custom: '自定义' };
    let lastGroup = null;
    for (const p of providers()) {
      const g = groupOf(p);
      if (g !== lastGroup) {
        list.appendChild(U.el('div', { class: 'model-list-group' }, GROUP_LABEL[g]));
        lastGroup = g;
      }
      const total = (p.models || []).length;
      const on = (p.models || []).filter(mo => mo.enabled !== false && mo.modelId).length;
      // 「未配置」按实际可用模型判定：模型条目里 ID 全空也算空壳
      // （新建自定义服务商默认带一条空模型，否则它会伪装成「已配置 1 个」）
      const empty = on === 0;
      const tagText = empty ? '未配置' : (p.preset ? '预置' : '自定义') + ' ' + on + '/' + total;
      const tagTitle = empty
        ? (total ? '模型 ID 为空，尚未配置任何可用模型' : '还没有添加任何模型')
        : (p.preset ? '预置' : '自定义') + ' · ' + on + '/' + total + ' 启用';
      list.appendChild(U.el('div', {
        class: 'model-row' + (p.id === editingId ? ' active' : '') + (empty ? ' is-empty' : ''),
        onclick: () => { editingId = p.id; renderModels(); }
      },
        U.el('span', { class: 'ac-dot', style: 'background:' + dotColor(p.id) }),
        U.el('span', { class: 'p-name', title: p.name || p.id }, p.name || p.id),
        U.el('span', { class: 'tag', title: tagTitle }, tagText)
      ));
    }
    list.appendChild(U.el('div', { class: 'model-list-sep' }));
    list.appendChild(U.el('button', {
      class: 'btn-secondary', style: 'width:100%;margin-bottom:8px',
      onclick: () => {
        const p = { id: U.uid(), name: '自定义服务商', provider: 'custom', apiFormat: 'openai', baseUrl: '', fullUrl: false, preset: false, models: [{ modelId: '', name: '', enabled: true }] };
        providers().push(p);
        editingId = p.id;
        MM.save({ configOnly: true });
        renderModels();
      }
    }, '添加自定义服务商'));
    list.appendChild(U.el('button', {
      class: 'btn-secondary', style: 'width:100%',
      onclick: () => {
        for (const def of MM.defaults.PRESET_PROVIDERS) {
          if (!findProvider(def.id)) {
            const copy = JSON.parse(JSON.stringify(def));
            delete copy.apiKey; // 预置定义里的 apiKey:'' 是占位
            for (const mo of (copy.models || [])) mo.fromPreset = true;
            providers().push(copy);
          }
        }
        MM.save({ configOnly: true }); renderModels(); syncModelConsumers();
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
    // 切换服务商时右侧表单区淡入（整页重建后的视觉缓冲）
    form.classList.add('pane-in');
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
      MM.save({ configOnly: true });
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
    // 上一次识别对应的模型 ID：只有 ID 变化时才回填，避免失焦时覆盖用户手填的上下文/最大输出
    let lastAutoId = mo.modelId || '';

    function applyInfo(persist) {
      const id = midInput.value.trim();
      if (!id) { infoHint.textContent = ''; return; }
      const meta = MM.modelInfo.guess(id, findMeta(p, id), MM.state.catalog, mo.multimodal, p.provider || p.id);
      const idChanged = id !== lastAutoId;
      // 用户手动改了模型 ID：不再算"预置自带"，否则下次启动会被旧 ID 迁移规则改写回去
      if (idChanged && id) delete mo.fromPreset;
      if ((idChanged || !ctxInput.value) && meta.contextTokens) ctxInput.value = meta.contextTokens;
      if ((idChanged || !outInput.value) && meta.maxOutputTokens) outInput.value = meta.maxOutputTokens;
      lastAutoId = id;
      mo.modelId = id;
      mo.contextTokens = ctxInput.value ? parseInt(ctxInput.value, 10) : undefined;
      mo.maxTokens = outInput.value ? parseInt(outInput.value, 10) : undefined;
      mo.multimodal = meta.multimodal != null ? meta.multimodal : mo.multimodal;
      // 挂载时的自动识别不落盘：打开设置页会为每个模型行触发一次，没必要写盘。
      // 用户真正编辑（失焦/选择下拉）时才保存；关闭设置页也会统一保存一次。
      if (persist !== false) saveSoon();
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
            applyInfo();
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
      applyInfo();
    });
    nameInput.addEventListener('input', () => { mo.name = nameInput.value.trim(); saveSoon(); });
    ctxInput.addEventListener('change', () => { mo.contextTokens = ctxInput.value ? parseInt(ctxInput.value, 10) : undefined; saveSoon(); });
    outInput.addEventListener('change', () => { mo.maxTokens = outInput.value ? parseInt(outInput.value, 10) : undefined; saveSoon(); });
    enCheck.addEventListener('change', () => {
      mo.enabled = enCheck.checked;
      saveSoon();
      syncModelConsumers(); // 启用状态实时反映到聊天页选择器与综合回答下拉
    });
    delBtn.addEventListener('click', () => {
      p.models = p.models.filter(x => x !== mo);
      MM.save({ configOnly: true });
      renderModelEntries();
      syncModelConsumers();
    });

    const row = U.el('div', { class: 'm-entry' },
      U.el('div', { class: 'm-row' }, idWrap, nameInput,
        U.el('label', { class: 'inline-check', title: '启用' }, enCheck, '启用'), delBtn),
      U.el('div', { class: 'm-row m-row2' },
        U.el('span', { class: 'mini-label' }, '上下文'), ctxInput,
        U.el('span', { class: 'mini-label' }, '最大输出'), outInput,
        infoHint));
    // 挂载后回填识别信息（只补空字段）
    setTimeout(() => applyInfo(false), 0); // 挂载时只回填识别信息，不触发保存
    return row;
  }

  // 渲染当前服务商的模型条目列表（目录刷新后局部重建）
  function renderModelEntries() {
    const box = U.$('#model-entries');
    if (!box) return;
    // 正在输入时不要重建：模型目录异步到达会调用本函数，会把未失焦的输入清回旧值
    const active = document.activeElement;
    if (active && active.tagName === 'INPUT' && box.contains(active)) return;
    const p = findProvider(editingId);
    if (!p) return;
    if (modelCountEl) modelCountEl.textContent = '模型（' + (p.models || []).length + '）';
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
    // 密钥只写入主进程保管：已保存时输入框显示遮罩（••••••••），聚焦时清空进入"输入新值"模式
    const KEY_MASK = '••••••••';
    const keyInput = U.el('input', {
      type: 'password', id: 'p-key', autocomplete: 'new-password',
      value: p.hasKey ? KEY_MASK : '',
      placeholder: '请输入 API Key'
    });
    // 遮罩态以「输入框当前内容」为准，而不是单独的布尔标记：
    // 密码管理器/输入法自动填充会直接写 value（不触发 focus），只看标记会把真实密钥当成遮罩丢掉。
    const isMasked = () => keyInput.value === KEY_MASK;
    keyInput.addEventListener('focus', () => {
      if (isMasked()) keyInput.value = ''; // 进入输入新值模式
    });
    keyInput.addEventListener('blur', () => {
      // 没输入新值就失焦：恢复遮罩（视觉上回到"已保存"）
      if (p.hasKey && !keyInput.value.trim()) keyInput.value = KEY_MASK;
    });
    const clearKeyBtn = U.el('button', {
      class: 'btn-secondary', style: 'flex:none;padding:0 12px',
      ...(p.hasKey ? {} : { disabled: '' })
    }, '清除');
    clearKeyBtn.addEventListener('click', async () => {
      if (!p.hasKey) return;
      if (!window.confirm('确定清除已保存的 API 密钥？')) return;
      try { await api.clearSecret(p.id); }
      catch (e) { U.toast('清除失败：' + ((e && e.message) || e), true); return; }
      p.hasKey = false;
      keyInput.value = '';
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
    // 自定义服务商允许改名（预置服务商的名字由预置定义维护，改名会在启动时被覆盖）
    let nameRow = null;
    if (!p.preset) {
      const nameInput = U.el('input', { type: 'text', value: p.name || '', placeholder: '服务商名称', maxlength: '40' });
      nameInput.addEventListener('change', () => {
        p.name = nameInput.value.trim() || '自定义服务商';
        MM.save({ configOnly: true });
        MM.chat.renderChips();
        renderModels(true); // 同步左侧列表与常驻标题行（改名输入框仍聚焦，需强制重画）
      });
      nameRow = hrow('名称', nameInput);
    }
    wrap.appendChild(U.el('div', { class: 'p-card' },
      U.el('div', { class: 'p-card-h' },
        U.el('span', {}, '连接'),
        U.el('span', { class: 'p-card-note' }, '该服务商下所有模型共用')),
      U.el('div', { class: 'p-card-b' },
        nameRow,
        hrow('API 格式', fmtSel),
        hrow('请求地址', urlInput, U.el('label', { class: 'inline-check', title: '勾选后不再自动补全路径' }, fullUrlCheck, '完整 URL')),
        U.el('div', { class: 'hint h-indent' }, '兼容 OpenAI API 的服务端点地址，不要以斜杠结尾；不勾选「完整 URL」时自动补全 /chat/completions 或 /v1/messages。'),
        hrow('API 密钥', keyInput, clearKeyBtn),
        U.el('div', { class: 'hint h-indent' }, p.hasKey ? '已保存密钥以 •••••••• 显示；点击输入框可输入新值覆盖，点"清除"删除。密钥仅保存在本机。' : '密钥仅保存在本机。'),
        result)));

    // 返回是否成功（没有输入新密钥时视为成功，不需要写入）
    async function commitKeyIfTyped() {
      if (isMasked()) return true; // 仍是遮罩：用户没有输入新密钥
      const k = keyInput.value.trim();
      if (!k) return true;
      let ok = false;
      try { ok = await api.setSecret(p.id, k); }
      catch (e) { U.toast('密钥保存失败：' + ((e && e.message) || e), true); return false; }
      if (!ok) { U.toast('密钥保存失败：服务商已不存在', true); return false; }
      p.hasKey = true;
      keyInput.value = KEY_MASK; // 保存后回到遮罩态
      return true;
    }

    // ---- 模型卡片：该服务商下的模型列表 ----
    const getListBtn = U.el('button', {
      class: 'btn-secondary',
      onclick: async (e) => {
        p.baseUrl = U.$('#p-url').value.trim();
        if (!(await commitKeyIfTyped())) return; // 输入了新密钥先保存
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

    modelCountEl = U.el('span', {}, '模型（' + (p.models || []).length + '）');
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
      if (!(await commitKeyIfTyped())) { // 输入了新密钥先保存
        testBtn.disabled = false; testBtn.textContent = '测试连接';
        return;
      }
      try {
        const reply = await api.testModel({ apiFormat: p.apiFormat, baseUrl: p.baseUrl, fullUrl: p.fullUrl, modelId: mo.modelId, providerId: p.id, provider: p.provider || p.id });
        result.className = 'test-result ok';
        result.textContent = '✓ 连接成功（' + mo.modelId + '），回复：' + String(reply).slice(0, 100);
        U.toast('连接成功：' + String(reply).slice(0, 40));
      } catch (e) {
        result.className = 'test-result err';
        result.textContent = '✗ ' + e.message;
        U.toast('连接失败：' + e.message, true);
      }
      // 按钮在常驻标题行，结果在连接卡片里：滚到可见位置，避免"点了没反应"
      if (result.scrollIntoView) result.scrollIntoView({ block: 'nearest' });
      testBtn.disabled = false; testBtn.textContent = '测试连接';
    });

    const saveBtn = U.el('button', { class: 'btn-primary' }, '保存');
    saveBtn.addEventListener('click', async () => {
      if (!(await commitKeyIfTyped())) return; // 输入了新密钥先写入主进程保管
      MM.save({ configOnly: true }); MM.chat.renderChips();
      U.toast('已保存「' + p.name + '」');
    });

    if (!p.preset) {
      const delBtn = U.el('button', { class: 'btn-danger' }, '删除');
      delBtn.addEventListener('click', () => {
        if (!window.confirm('确定删除服务商「' + p.name + '」及其全部模型？')) return;
        MM.state.config.providers = providers().filter(x => x.id !== p.id);
        editingId = null;
        MM.save({ configOnly: true }); renderModels(); syncModelConsumers();
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
      'DeepSeek / Kimi / 自定义端点：用下方选择的搜索引擎检索，结果注入对话上下文；',
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
    // 与模型配置页一致：已保存密钥显示遮罩态，聚焦时清空进入"输入新值"模式
    const SKEY_MASK = '••••••••';
    const keyInput = U.el('input', {
      type: 'password', id: 's-key', style: 'width:100%', autocomplete: 'off',
      value: cfg.hasKey ? SKEY_MASK : '',
      placeholder: '搜索 API Key'
    });
    const isSearchMasked = () => keyInput.value === SKEY_MASK;
    keyInput.addEventListener('focus', () => {
      if (isSearchMasked()) keyInput.value = '';
    });
    keyInput.addEventListener('blur', () => {
      if (cfg.hasKey && !keyInput.value.trim()) keyInput.value = SKEY_MASK;
    });
    const keyHint = U.el('div', { class: 'hint' });
    keyRow.appendChild(keyInput);
    keyRow.appendChild(keyHint);
    const result = U.el('div', { class: 'test-result' });
    // 整个字段一起显隐：密钥不适用时不留孤零零的「API 密钥」标签
    const keyField = field('API 密钥', keyRow);

    // 返回是否成功（没有输入新密钥时视为成功）
    async function commitSearchKeyIfTyped() {
      if (isSearchMasked()) return true; // 仍是遮罩：没有输入新密钥
      const k = keyInput.value.trim();
      if (!k) return true;
      try { await api.setSecret('search', k); }
      catch (e) { U.toast('密钥保存失败：' + ((e && e.message) || e), true); return false; }
      cfg.hasKey = true;
      keyInput.value = SKEY_MASK; // 保存后回到遮罩态
      return true;
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
      if ((pv === 'tavily' || pv === 'bocha') && !cfg.hasKey && (!keyInput.value.trim() || isSearchMasked())) {
        result.className = 'test-result err';
        result.textContent = '✗ 所选搜索服务商需要 API 密钥，请填写后再保存';
        return;
      }
      if (!(await commitSearchKeyIfTyped())) return;
      cfg.provider = pv;
      MM.save({ configOnly: true }); U.toast('搜索设置已保存');    });
    const testBtn = U.el('button', { class: 'btn-secondary' }, '测试搜索');
    testBtn.addEventListener('click', async () => {
      const pv = provSel.value;
      result.className = 'test-result';
      if (pv === 'none') { result.className = 'test-result err'; result.textContent = '当前为「不使用搜索」，请先选择搜索引擎'; return; }
      if ((pv === 'tavily' || pv === 'bocha') && !cfg.hasKey && (!keyInput.value.trim() || isSearchMasked())) { result.className = 'test-result err'; result.textContent = '✗ 请先填写 API 密钥'; return; }
      if (!(await commitSearchKeyIfTyped())) return;
      testBtn.disabled = true; testBtn.textContent = '搜索中…';
      try {
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
    if (!pane) return;
    // 正在该面板里操作时不重建：整块重建会丢掉用户未保存的选择
    const active = document.activeElement;
    if (active && pane.contains(active) && active.tagName === 'SELECT') return;
    pane.innerHTML = '';
    const cfg = MM.state.config.synthesis = MM.state.config.synthesis || { synthSource: 'frontend', autoMerge: true };
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
      MM.save({ configOnly: true });
      U.$('#tgl-auto').checked = cfg.autoMerge;
      U.$('#tgl-auto').closest('.toggle').classList.toggle('on', cfg.autoMerge);
      U.toast('综合设置已保存');
    });

    pane.appendChild(field('综合方式', sourceSel,
      '「模型综合」由所选模型把各回答重写为一份完整的最终回答，更连贯，但每轮多消耗一次请求。',
      '「前端智能合并」在本地重组，不消耗 token。'));
    pane.appendChild(U.el('div', { class: 'field' },
      U.el('label', { class: 'inline-check' }, autoCheck, '回答完成后自动执行综合（顶栏「自动综合」开关）')));
    pane.appendChild(saveBtn);
  }

  // ---------- 系统提示词 ----------
  // 全局提示词对所有模型、所有会话生效；聊天页可用「提示词」按钮给当前会话单独覆盖。
  // 这里只管全局那一条，会话级的编辑面板在 ui-chat.js。
  function renderPrompt() {
    const pane = U.$('#pane-prompt');
    if (!pane) return;
    // 正在该面板里输入时不重建：整块重建会清空未保存的草稿
    const active = document.activeElement;
    if (active && pane.contains(active) && active.tagName === 'TEXTAREA') return;
    pane.innerHTML = '';
    const cfg = MM.state.config;
    if (typeof cfg.systemPrompt !== 'string') cfg.systemPrompt = '';

    pane.appendChild(U.el('div', { class: 'pane-title' }, '系统提示词'));
    pane.appendChild(U.el('div', { class: 'pane-sub' },
      '设置模型的角色与回答风格，每次提问都会随请求一起发送给所选的全部模型。留空则不注入。'));

    const ta = U.el('textarea', {
      id: 'sp-global', rows: '7',
      placeholder: '例如：你是一位严谨的中文技术顾问。回答要先给结论再给理由，不确定的地方明确说明，不要编造。'
    });
    ta.value = cfg.systemPrompt;
    // 输入即写入内存并防抖落盘：设置页可能被直接关掉，不点保存也不会丢
    ta.addEventListener('input', () => { cfg.systemPrompt = ta.value; saveSoonPrompt(); });
    pane.appendChild(field('全局提示词', ta,
      '不消耗额外请求：它会作为 system 消息插入每一轮对话的历史最前面。',
      '按会话覆盖：聊天页右上角「提示词」按钮可为当前会话单独设置，会话里设了就以会话的为准。'));

    const hintBox = U.el('div', { class: 'prompt-tips' },
      U.el('div', { class: 'pt-title' }, '常用写法'),
      U.el('ul', {},
        U.el('li', {}, '角色：「你是一位……」限定身份，能显著影响回答口吻'),
        U.el('li', {}, '结构：「先给结论，再给理由」「用要点列表回答」'),
        U.el('li', {}, '边界：「不确定就说不确定」「不要编造数据」'),
        U.el('li', {}, '语言：「一律用简体中文回答」')));
    pane.appendChild(hintBox);
  }

  // 与 saveSoon 分开计时：提示词是长文本，防抖要更长，避免边打字边写盘
  const saveSoonPrompt = U.debounce(() => { MM.save({ configOnly: true }); if (MM.chat && MM.chat.refreshPromptBadge) MM.chat.refreshPromptBadge(); }, 800);

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
        // 导出文件包含明文 API 密钥，先明确告知风险再让用户确认
        const msg = [
          '导出的备份文件包含明文 API 密钥。',
          '',
          '请只保存在本机或可信位置，不要上传到网盘、聊天工具或代码仓库。',
          '',
          '确定继续导出？'
        ].join('\n');
        if (!window.confirm(msg)) return;
        try {
          const p = await api.exportData({ config: MM.state.config, sessions: MM.state.sessions });
          if (p) U.toast('已导出到 ' + p + '（含明文 API 密钥，请妥善保管）');
        } catch (e) {
          U.toast('导出失败：' + ((e && e.message) || e), true);
        }
      }
    }, U.el('span', {}, '导出数据'), U.el('small', {}, '将模型配置与全部会话导出为 JSON 备份文件（含明文 API 密钥）')));

    box.appendChild(U.el('button', {
      class: 'btn-secondary',
      onclick: async () => {
        try {
          const data = await api.importData();
          if (!data) return;
          const cfg = data.config || {};
          // 兼容 1.0 的平铺结构（config.models），交由 MM.normalizeConfig 统一迁移
          if (!Array.isArray(data.sessions) && !Array.isArray(cfg.providers) && !Array.isArray(cfg.models)) {
            U.toast('文件格式不正确', true); return;
          }
          // 先在本地的变量里完成迁移/校验，全部成功后再替换状态：
          // 中途失败（如配置格式异常）不会留下"配置已换、会话还是旧的"的半截状态
          const nextConfig = MM.normalizeConfig(cfg);
          const nextSessions = MM.normalizeSessions(data.sessions);
          MM.migrateSessions(nextSessions);
          MM.state.config = nextConfig;
          MM.state.sessions = nextSessions;
          if (!nextSessions.length) MM.sessions.createSilent();
          const top = MM.sessions.sorted()[0];
          MM.state.currentId = top ? top.id : null;
          U.$('#tgl-auto').checked = !!MM.state.config.synthesis.autoMerge;
          U.$('#tgl-auto').closest('.toggle').classList.toggle('on', !!MM.state.config.synthesis.autoMerge);
          // 旧备份迁移后带明文密钥：先落盘交给主进程保管，再从渲染层状态剥离。
          // 落盘失败时不要剥离：否则明文密钥只存在于内存里的旧值，用户又没收到任何提示。
          const savedOk = await MM.save();
          if (savedOk) MM.stripSecrets(MM.state.config);
          renderModels(true); renderSearch(); renderSynth(); renderPrompt();
          MM.chat.renderAll(); MM.chat.renderTitle(); MM.sessions.render(); MM.chat.renderChips();
          U.toast('导入成功');
        } catch (e) {
          // 主进程解析失败/文件不可读都会 reject：必须给用户明确反馈
          U.toast('导入失败：' + ((e && e.message) || e), true);
        }
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
        if (nav.classList.contains('active')) return; // 重复点击当前 tab 不重播动画
        for (const n of U.$$('.settings-nav')) n.classList.remove('active');
        nav.classList.add('active');
        for (const p of U.$$('.settings-pane')) p.classList.remove('active');
        const pane = U.$('#pane-' + nav.dataset.pane);
        pane.classList.add('active');
        // 切换页签时内容淡入微移（先移除再强制重排，连续切换也能重启动画）
        pane.classList.remove('pane-in');
        void pane.offsetWidth;
        pane.classList.add('pane-in');
      });
    }
  }

  MM.settings = { open, close, bind, renderModels, dotColor, allFlatModels, syncForTest: syncModelConsumers };
})();
