'use strict';
// 聊天流：用户消息、多模型并行流式渲染、重新生成、综合回答、联网搜索、图片/文件附件
window.MM = window.MM || {};

(function () {
  const U = MM.util;
  let seq = 0;
  // 正在生成的会话 id（null = 空闲）。全局同一时刻只跑一轮；
  // 存会话 id 是为了区分"当前会话在生成"和"别的会话在生成"。
  let streaming = null;
  // 轮次令牌：每次 dispatchRound 自增。停止或开始新一轮后，仍停留在搜索阶段的旧轮次
  // 醒来时令牌已过期，必须放弃——只看 streaming 是否为真值会把新轮次误当成"没被取消"。
  let runToken = 0;
  // 处于联网搜索阶段（尚未建立 pending）的轮次数。此时收到上一轮的 all-done 不能把
  // streaming 清空，否则刚开始的新一轮会被误判为"已取消"。
  let searchPhase = 0;
  const pending = new Map(); // requestId -> 请求上下文
  // 一次性抑制消息区淡入：版本切换走局部 ver-swap 过渡，不该整页重淡入
  let suppressFade = false;
  // 会话提示词是长文本，防抖要更长，避免边打字边写盘。
  // 注意会话级提示词存在 session 上（不是 config），必须整份保存。
  const saveSoonPrompt = U.debounce(() => { MM.save(); }, 800);

  // ---------- 附件（图片 / 文档） ----------
  // 粘贴或拖入的待发送附件。图片经主进程落盘 + 系统 OCR 提取文字（多模态模型看原图、
  // 纯文本模型吃提取的文字）；文档提取全文后拼进消息正文（所有模型都能读到）。
  // 发送时挂到用户消息上：msg.images（引用）/ msg.files（含全文），见 send()。
  let pendingAttach = [];
  const IMAGE_MIMES = { 'image/png': 1, 'image/jpeg': 1, 'image/webp': 1, 'image/bmp': 1 };
  const MAX_IMAGES = 3;
  const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
  const MAX_DOC_BYTES = 20 * 1024 * 1024;
  const MAX_DOC_CHARS = 30000;
  const TEXT_EXTS = ['txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'log', 'js', 'mjs', 'ts', 'jsx', 'tsx',
    'py', 'java', 'c', 'h', 'cpp', 'hpp', 'cs', 'go', 'rs', 'rb', 'php', 'sh', 'bat', 'ps1',
    'ini', 'cfg', 'conf', 'yml', 'yaml', 'toml', 'xml', 'sql', 'css', 'scss', 'vue', 'srt'];
  const DOC_EXTS = ['pdf', 'docx', 'doc', 'xlsx', 'xls', 'pptx', 'ppt', 'rtf', 'html', 'htm', 'epub'];

  function bufToBase64(buf) {
    let b64 = '';
    for (let i = 0; i < buf.length; i += 0x8000) {
      b64 += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
    }
    return btoa(b64);
  }

  // 大图等比压缩（长边 2048），控制 vision token 与请求体积；BMP/WebP 统一转 PNG。
  // 小于阈值的 PNG/JPG 原样发送，不重复编码。
  async function prepareImage(file, mime) {
    const bitmap = await createImageBitmap(file);
    const w = bitmap.width, h = bitmap.height;
    const keepMime = (mime === 'image/png' || mime === 'image/jpeg') ? mime : 'image/png';
    let blob = null;
    if (Math.max(w, h) > 2048 || keepMime !== mime) {
      const scale = Math.max(w, h) > 2048 ? 2048 / Math.max(w, h) : 1;
      const cw = Math.max(1, Math.round(w * scale)), ch = Math.max(1, Math.round(h * scale));
      const canvas = document.createElement('canvas');
      canvas.width = cw; canvas.height = ch;
      canvas.getContext('2d').drawImage(bitmap, 0, 0, cw, ch);
      blob = await new Promise(res => canvas.toBlob(res, keepMime, 0.92));
    } else {
      blob = file;
    }
    if (bitmap.close) bitmap.close();
    if (!blob || !blob.size) throw new Error('图片解码失败');
    if (blob.size > MAX_IMAGE_BYTES) throw new Error('图片过大（压缩后仍超过 5MB），请换小图');
    return { mime: keepMime, base64: bufToBase64(new Uint8Array(await blob.arrayBuffer())), w, h, size: blob.size };
  }

  async function addImageBlob(file) {
    if (!file) return;
    if (pendingAttach.filter(a => a.kind === 'image').length >= MAX_IMAGES) {
      U.toast('一次最多附加 ' + MAX_IMAGES + ' 张图片', true);
      return;
    }
    const mime = String(file.type || '').toLowerCase();
    if (!IMAGE_MIMES[mime]) { U.toast('不支持的图片格式（支持 PNG / JPG / WebP / BMP）', true); return; }
    const a = { kind: 'image', name: file.name || '图片', ocrState: 'pending', text: '' };
    pendingAttach.push(a);
    renderAttachBar();
    // ready：发送时若 OCR 仍在跑，send() 会等它完成，避免图片被静默丢掉
    a.ready = (async () => {
      try {
        const prep = await prepareImage(file, mime);
        a.w = prep.w; a.h = prep.h; a.size = prep.size;
        const r = await api.saveImage({ name: a.name, mime: prep.mime, base64: prep.base64 });
        a.id = r.id; a.ext = r.ext; a.text = r.text || '';
      } catch (e) {
        a.failed = true;
        U.toast('图片「' + a.name + '」处理失败：' + ((e && e.message) || e), true);
      }
      a.ocrState = 'done';
      renderAttachBar();
    })();
    await a.ready;
  }

  // 拖入的文件按类型分流：图片走 addImageBlob，文本类直接读，文档类交主进程提取
  async function addDroppedFile(file) {
    if (!file) return;
    const mime = String(file.type || '').toLowerCase();
    if (IMAGE_MIMES[mime] || /\.(png|jpe?g|webp|bmp)$/i.test(file.name || '')) {
      if (!IMAGE_MIMES[mime]) { U.toast('不支持的图片格式（支持 PNG / JPG / WebP / BMP）', true); return; }
      return addImageBlob(file);
    }
    const ext = ((file.name || '').split('.').pop() || '').toLowerCase();
    const isText = TEXT_EXTS.indexOf(ext) >= 0;
    if (!isText && DOC_EXTS.indexOf(ext) < 0) {
      U.toast('暂不支持「' + (file.name || '该文件') + '」：文本类/PDF/Office 文档可直接拖入', true);
      return;
    }
    if (file.size > MAX_DOC_BYTES) { U.toast('文件超过 20MB，无法作为附件', true); return; }
    const a = { kind: 'file', name: file.name || '文档', text: '' };
    pendingAttach.push(a);
    renderAttachBar();
    a.ready = (async () => {
      try {
        let text = '';
        if (isText) {
          text = await file.text();
          if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1); // 去 BOM
        } else {
          const r = await api.extractDoc({ name: a.name, base64: bufToBase64(new Uint8Array(await file.arrayBuffer())) });
          text = (r && r.text) || '';
          if (!text.trim()) throw new Error('未能从文档中提取到文字');
        }
        if (text.length > MAX_DOC_CHARS) text = text.slice(0, MAX_DOC_CHARS) + '\n……（内容过长，已截断）';
        a.text = text;
        a.chars = text.length;
      } catch (e) {
        a.failed = true;
        U.toast('附件「' + a.name + '」处理失败：' + ((e && e.message) || e), true);
      }
      renderAttachBar();
    })();
    await a.ready;
  }

  function attachChip(a) {
    const remove = U.el('button', {
      class: 'att-x', title: '移除',
      onclick: function (e) {
        e.stopPropagation();
        pendingAttach = pendingAttach.filter(x => x !== a);
        renderAttachBar();
      }
    }, '×');
    let status;
    if (a.failed) status = '处理失败';
    else if (a.kind === 'image') status = a.ocrState === 'done' ? (a.text ? '图中 ' + a.text.length + ' 字' : '图中无文字') : '识别文字中…';
    else status = a.text ? a.chars + ' 字' : '提取中…';
    const chip = U.el('div', { class: 'att-chip' + (a.kind === 'file' ? ' doc' : '') + (a.failed ? ' failed' : ''), title: a.name || '' },
      a.kind === 'image' && a.id
        ? U.el('img', { class: 'att-thumb', src: 'mmimg://' + a.id + '.' + a.ext, alt: '' })
        : U.el('span', { class: 'att-ico' }, '📄'),
      U.el('div', { class: 'att-meta' },
        U.el('div', { class: 'att-name' }, a.name || (a.kind === 'image' ? '图片' : '文档')),
        U.el('div', { class: 'att-status' }, status)),
      remove);
    chip.addEventListener('click', function (e) {
      if (remove === e.target || remove.contains(e.target)) return;
      if (a.kind === 'image' ? a.id : a.text) previewAttachment(a);
    });
    return chip;
  }

  function renderAttachBar() {
    const bar = U.$('#attach-bar');
    if (!bar) return;
    bar.innerHTML = '';
    if (!pendingAttach.length) {
      bar.classList.add('hidden');
    } else {
      bar.classList.remove('hidden');
      for (const a of pendingAttach) bar.appendChild(attachChip(a));
    }
    refreshChipVisionHints();
  }

  function previewAttachment(a) {
    const ov = U.$('#attach-view');
    const body = U.$('#av-body');
    if (!ov || !body) return;
    body.innerHTML = '';
    if (a.kind === 'image') {
      body.appendChild(U.el('img', { class: 'av-img', src: 'mmimg://' + a.id + '.' + a.ext, alt: a.name || '图片' }));
    } else {
      body.appendChild(U.el('pre', { class: 'av-pre' }, a.text || ''));
    }
    U.$('#av-title').textContent = a.name || (a.kind === 'image' ? '图片' : '附件文本');
    ov.classList.remove('hidden');
  }

  function closeAttachView() {
    const ov = U.$('#attach-view');
    if (ov) ov.classList.add('hidden');
  }

  // 贴了图之后，给不支持看图的模型芯片加「仅文字」提示：发送前就知道谁能看图、谁只能读字
  function refreshChipVisionHints() {
    const hasImg = pendingAttach.some(a => a.kind === 'image' && !a.failed);
    if (!hasImg) {
      for (const c of U.$$('#model-chips .chip.no-vision')) c.classList.remove('no-vision');
      return;
    }
    const flats = MM.settings.allFlatModels();
    for (const c of U.$$('#model-chips .chip')) {
      const m = flats.find(x => x.id === c.getAttribute('data-model-id'));
      c.classList.toggle('no-vision', !!(m && m.multimodal !== true));
    }
  }

  // 本轮该模型是否参与：模型不能看图、图里没提取到文字、也没有任何文字输入
  // （提问/附件文字都算）→ 没事可做，标记跳过，不浪费请求
  function modelSkippedForRound(m, userMsg) {
    if (m && m.multimodal === true) return false;
    const imgs = (userMsg && userMsg.images) || [];
    if (!imgs.length) return false;
    const hasText = !!(String(userMsg.content || '').trim() ||
      ((userMsg.files || []).some(f => f && f.text && String(f.text).trim())));
    const hasOcr = imgs.some(im => im && im.text && String(im.text).trim().length);
    return !hasText && !hasOcr;
  }

  // 历史消息里的用户内容：图片转文字占位（图片本体只发给它那一轮的多模态模型，
  // 后续轮次重发原图会重复计费，这里只带「发过什么图 + 图中文字」）；文档全文保留，
  // 追问时模型仍能引用内容，超出上下文时由裁剪逻辑淘汰。
  function historyUserContent(m) {
    const parts = [];
    if (m.content) parts.push(m.content);
    for (const f of (m.files || [])) {
      if (f && f.text) parts.push('【附件 ' + (f.name || '') + '】\n' + f.text);
    }
    for (const im of (m.images || [])) {
      if (!im) continue;
      let p = '[图片 ' + (im.name || '') + ']';
      if (im.text && String(im.text).trim()) p += '，图中文字：\n' + String(im.text).slice(0, 600);
      parts.push(p);
    }
    return parts.join('\n\n');
  }

  // 当前这轮发给模型的用户条目（按模型能力分流）
  function currentUserEntry(userMsg, mm) {
    const parts = [];
    if (userMsg.content) parts.push(userMsg.content);
    for (const f of (userMsg.files || [])) {
      if (f && f.text) parts.push('【附件 ' + (f.name || '') + '】\n' + f.text);
    }
    if (!mm) {
      // 纯文本：拼上图中提取的文字（调用方已保证不会「无文字且无输入」）
      for (const im of (userMsg.images || [])) {
        if (im && im.text && String(im.text).trim()) {
          parts.push('[图片 ' + (im.name || '') + ' 中的文字]\n' + im.text);
        }
      }
    }
    const entry = { role: 'user', content: parts.join('\n\n') };
    if (mm && (userMsg.images || []).length) {
      // 多模态：图片引用单独带上（主进程转成各家 API 的图片部件）
      entry.images = (userMsg.images || [])
        .map(im => im && ({ id: im.id, ext: im.ext, name: im.name, text: im.text || '' }))
        .filter(Boolean);
    }
    return entry;
  }

  function streamingHere() { return !!streaming && streaming === MM.state.currentId; }
  function streamingSessionName() {
    const s = MM.state.sessions.find(x => x.id === streaming);
    return (s && s.title) || '其它会话';
  }
  // 切会话/轮次结束时同步发送按钮：别的会话在生成时，当前会话仍应可输入、可发送
  function refreshSendBtn() { setSendBtn(streamingHere()); }

  function stripModel(m) {
    // 不携带 apiKey：密钥由主进程按 providerId 保管并在请求时解析
    return { id: m.id, providerId: m.providerId, name: m.name, provider: m.provider, apiFormat: m.apiFormat, baseUrl: m.baseUrl, modelId: m.modelId, fullUrl: m.fullUrl, maxTokens: m.maxTokens };
  }

  // 按 data-round 查找元素：roundId 可能来自导入数据，不能直接拼进 CSS 选择器
  function byRound(sel, roundId, root) {
    const box = root || U.$('#messages');
    if (!box) return null;
    const want = roundId == null ? '' : String(roundId);
    for (const el of Array.from(box.querySelectorAll(sel))) {
      if ((el.getAttribute('data-round') || '') === want) return el;
    }
    return null;
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
    else inp.placeholder = '输入消息…  Enter 发送，Shift+Enter 换行，可粘贴/拖入或点 + 加附件';
  }

  function selectedModels() {
    const ids = Array.from(U.$$('#model-chips .chip.on')).map(c => c.getAttribute('data-model-id'));
    return MM.settings.allFlatModels().filter(m => ids.includes(m.id));
  }

  // ---------- 模型芯片 ----------
  // 勾选状态跨重启记忆：config.chipSel = { on: [id...], off: [id...] }。
  // 两个集合都不在的 id（新添加的模型）默认选中——既保住用户特意关掉的，又不漏掉新模型。
  function chipSel() {
    const cs = MM.state.config.chipSel;
    return (cs && Array.isArray(cs.on) && Array.isArray(cs.off)) ? cs : null;
  }
  function persistChips() {
    const sel = { on: [], off: [] };
    for (const c of U.$$('#model-chips .chip')) {
      (c.classList.contains('on') ? sel.on : sel.off).push(c.getAttribute('data-model-id'));
    }
    MM.state.config.chipSel = sel;
    MM.save({ configOnly: true }); // 只动了配置，不必复制整份会话历史
  }

  function renderChips() {
    const box = U.$('#model-chips');
    // 重建前记录当前勾选状态：设置页关闭/配置变更会频繁触发本函数，不能重置用户的选择
    const prev = new Map();
    for (const c of box.querySelectorAll('.chip')) {
      prev.set(c.getAttribute('data-model-id'), c.classList.contains('on'));
    }
    box.innerHTML = '';
    const models = MM.settings.allFlatModels();
    if (!models.length) {
      box.appendChild(U.el('div', { style: 'color:var(--muted);font-size:12.5px;padding:6px' }, '暂无可用模型，请在「设置 → 模型配置」中添加'));
      return;
    }
    const saved = chipSel();
    const frag = document.createDocumentFragment();
    for (const m of models) {
      const bits = [m.providerName + ' · ' + m.modelId];
      if (m.contextTokens) bits.push(MM.modelInfo.fmtTokens(m.contextTokens) + ' 上下文');
      if (m.multimodal) bits.push('多模态');
      if (!m.hasKey) bits.push('API Key 未设置，请在设置中填写');
      // 优先级：本次运行内的状态 > 持久化记录 > 默认选中
      const on = prev.has(m.id) ? prev.get(m.id) : (saved ? !saved.off.includes(m.id) : true);
      frag.appendChild(U.el('div', {
        class: 'chip' + (on ? ' on' : ''),
        'data-model-id': m.id,
        title: bits.join(' · '),
        onclick: function () { this.classList.toggle('on'); persistChips(); }
      },
        U.el('span', {}, m.name || m.modelId)
      ));
    }
    box.appendChild(frag);
    refreshChipVisionHints();
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

  // 生效的系统提示词：会话级覆盖优先，取不到再用全局；两者都为空返回 ''（调用方自行判断是否注入）
  function effectiveSystemPrompt(s) {
    const local = s && typeof s.systemPrompt === 'string' ? s.systemPrompt.trim() : '';
    if (local) return local;
    const g = MM.state.config && MM.state.config.systemPrompt;
    return typeof g === 'string' ? g.trim() : '';
  }

  // model：本轮要发给的模型（决定图片路由——多模态收原图引用，纯文本收提取文字）。
  // 兼容旧调用（测试/旧路径）：不传时按纯文本处理。
  function buildHistory(s, userMsg, searchResults, ctxLimit, maxOut, model) {
    const mm = !!(model && model.multimodal === true);
    const msgs = [];
    for (const m of s.messages) {
      if (m === userMsg) break;
      if (m.role === 'user') {
        msgs.push({ role: 'user', content: historyUserContent(m) });
      } else if (m.role === 'assistant') {
        const best = pickAnswer(m);
        if (best) msgs.push({ role: 'assistant', content: best });
      } else if (m.role === 'merge') {
        if (m.content && msgs.length && msgs[msgs.length - 1].role === 'assistant') {
          msgs[msgs.length - 1].content = m.content; // 优先用综合回答作为上一轮上下文
        }
      }
    }
    // 注意：相邻 user 的合并必须放在"追加当前消息"之后（见函数末尾），
    // 否则最常见的相邻情况（历史最后一条 user + 当前消息）不会被合并
    if (searchResults && searchResults.length) {
      const src = searchResults.map(r => '- ' + r.title + '\n  ' + r.snippet + '\n  来源: ' + r.url).join('\n');
      msgs.push({ role: 'system', content: '以下是与用户问题相关的联网搜索结果，回答时可以参考：\n\n' + src });
    }
    // 按模型上下文窗口裁剪历史，避免超限报错
    // 系统提示词的 token 也要计入预算，否则长提示词 + 长历史仍会超限
    const sysPrompt = effectiveSystemPrompt(s);
    if (ctxLimit) {
      // 预算下限取 512：极小上下文窗口（如 3000）下不能仍塞 4096
      let budget = Math.max(ctxLimit - (maxOut || 4096) - 4096, 512) - estTokens(sysPrompt);
      // 本轮图片按每张约 1200 token 预留（各家计费口径不同，取保守值）
      if (mm && Array.isArray(userMsg.images) && userMsg.images.length) {
        budget -= userMsg.images.length * 1200;
        if (budget < 512) budget = 512;
      }
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
    // 提示词插在裁剪之后：从前面 shift 历史时不能把它一起丢掉，
    // 它是本轮对话的角色设定，任何时候都要保住
    if (sysPrompt) msgs.unshift({ role: 'system', content: sysPrompt });
    msgs.push(currentUserEntry(userMsg, mm));
    // 合并相邻的 user 消息：上一轮全部失败/被停止时，历史最后一条 user 会与当前消息相邻，
    // Anthropic 等格式对角色交替更敏感（必须在 push 当前消息之后执行）
    for (let i = msgs.length - 1; i > 0; i--) {
      if (msgs[i].role === 'user' && msgs[i - 1].role === 'user') {
        msgs[i - 1].content += '\n\n' + msgs[i].content;
        // 当前消息带图：并入上一条时保留图片引用，不能只合并文字
        if (msgs[i].images && msgs[i].images.length) {
          msgs[i - 1].images = (msgs[i - 1].images || []).concat(msgs[i].images);
        }
        msgs.splice(i, 1);
      }
    }
    return msgs;
  }

  // ---------- 渲染 ----------
  function renderTitle() {
    const s = MM.sessions.current();
    U.$('#session-title').textContent = s ? s.title : 'Multi-Model Chat';
  }

  function emptyState() {
    const box = U.el('div', { class: 'empty-state' },
      U.el('h1', {}, 'Multi-Model Chat'),
      U.el('p', {}, '在下方输入问题，同时获得多个模型的回答'));
    // 没有任何已配置密钥的模型时显示引导（配置过后不再出现）
    const hasUsableModel = MM.settings.allFlatModels().some(m => m.hasKey);
    if (!hasUsableModel) {
      box.appendChild(U.el('div', { class: 'empty-guide' },
        U.el('span', { class: 'eg-text' }, '首次使用：请先在左下角「设置 → 模型配置」中为服务商填写 API Key'),
        U.el('button', { class: 'btn-secondary eg-btn', onclick: function () { MM.settings.open(); } }, '打开设置')));
    } else {
      // 已配置：给两个示例提问，点击直接填入输入框
      const ex = U.el('div', { class: 'empty-examples' });
      for (const q of ['用三句话解释量子计算', '对比三种主流大模型的长文本能力']) {
        ex.appendChild(U.el('button', {
          class: 'eg-q', onclick: function () {
            U.$('#input').value = q;
            autoResize();
            U.$('#input').focus();
          }
        }, q));
      }
      box.appendChild(ex);
    }
    return box;
  }

  // Markdown 渲染缓存：切换会话/版本时会反复重画同一条回答，
  // 内容没变就直接复用上次的 HTML。WeakMap 以结果对象为键，删除会话后可被 GC。
  const mdCache = new WeakMap();
  function mdHtml(obj, content) {
    const src = content || '';
    const hit = mdCache.get(obj);
    if (hit && hit.src === src) return hit.html;
    const html = MM.md.render(src);
    mdCache.set(obj, { src: src, html: html });
    return html;
  }

  function answerCard(res, streamingNow, roundId) {
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
        res.sources.map(r => {
          const url = String(r.url || '');
          // 只允许 http(s)：搜索服务返回的 URL 不可信，javascript:/data: 一律按纯文本渲染
          return /^https?:\/\//i.test(url)
            ? U.el('a', { href: url, target: '_blank', rel: 'noopener' }, r.title || url)
            : U.el('span', { class: 'src-item' }, r.title || url);
        })));
    }
    const body = U.el('div', { class: 'ac-body' + (streamingNow ? ' streaming' : ' md') });
    if (streamingNow) body.textContent = res.content || '';
    else if (res.status === 'skipped') body.innerHTML = '<div class="ac-skipped">该模型不支持图片，且未从图中提取到文字，本轮已跳过</div>';
    else if (res.status === 'error' && res.error) body.innerHTML = '<div class="ac-error">✗ ' + U.esc(res.error) + '</div>';
    else body.innerHTML = mdHtml(res, res.content);
    card.appendChild(body);
    const foot = U.el('div', { class: 'card-foot' });
    // 失败/被停止的卡片给单模型重试入口：只重发这一个模型，不重跑整轮（省掉已成功模型的钱）
    if (roundId && (res.status === 'error' || res.status === 'stopped')) {
      foot.appendChild(U.el('button', {
        class: 'ac-copy', title: '只重新调用这一个模型',
        onclick: function () { retryOne(roundId, res.modelId); }
      }, '重试'));
    }
    foot.appendChild(U.el('button', {
      class: 'ac-copy', onclick: function () { U.copyTextFrom(body); U.toast('已复制'); }
    }, '复制'));
    card.appendChild(foot);
    MM.md.bindCopy(card);
    return card;
  }

  // 缓存一张回答卡片里高频访问的节点（状态、正文、思考过程）
  function cardRefs(card) {
    return {
      card: card,
      status: card.querySelector('.ac-status'),
      body: card.querySelector('.ac-body'),
      reasoning: card.querySelector('.reasoning .r-body')
    };
  }

  function statusHtml(res) {
    if (res.status === 'searching') return '<span class="spinner"></span><span class="badge muted">搜索中…</span>';
    if (res.status === 'streaming') return '<span class="spinner"></span><span class="badge muted">生成中…</span>';
    if (res.status === 'done') {
      let h = '<span class="badge ok">✓</span>';
      if (res.ms) h += '<span class="badge">' + U.fmtMs(res.ms) + '</span>';
      if (res.chars) h += '<span class="badge">' + res.chars + ' 字</span>';
      return h + usageBadge(res.usage);
    }
    if (res.status === 'error') return '<span class="badge err">✗ 失败</span>' + usageBadge(res.usage);
    if (res.status === 'stopped') return '<span class="badge muted">⏹ 已停止</span>' + usageBadge(res.usage);
    if (res.status === 'skipped') return '<span class="badge muted" title="' + U.esc(res.error || '') + '">⏭ 已跳过</span>';
    return '';
  }

  // token 用量徽标。悬停看输入/输出拆分——只显示总数会让「为什么这么贵」查不到原因。
  // 用量是服务端回传的，某些端点不返回时此处自然为空，不猜不估算。
  function usageBadge(u) {
    if (!u || !u.input && !u.output) return '';
    const total = (u.input || 0) + (u.output || 0);
    if (!total) return '';
    const tip = '输入 ' + U.esc(String(u.input || 0)) + ' + 输出 ' + U.esc(String(u.output || 0)) + ' tokens';
    return '<span class="badge tok" title="' + tip + '">' + MM.modelInfo.fmtTokens(total) + ' tok</span>';
  }

  // 本轮合计用量（供轮次工具栏显示）；没有任何模型回传时返回 null，界面不显示
  function roundUsage(am) {
    const list = (am.results || []).filter(r => r.usage && (r.usage.input || r.usage.output));
    if (!list.length) return null;
    return list.reduce((a, r) => a + (r.usage.input || 0) + (r.usage.output || 0), 0);
  }

  function answersGrid(am) {
    // 必须带 data-round：综合回答结束后要按它定位网格插回工具栏
    const grid = U.el('div', { class: 'answers', 'data-round': am.roundId });
    for (const r of am.results) grid.appendChild(answerCard(r, false, am.roundId));
    return grid;
  }

  function mergeCard(msg, live, roundId) {
    const card = U.el('div', { class: 'merge-card', 'data-role': 'merge', 'data-round': roundId || '' });
    const label = msg.mode === 'model' ? '综合回答 · 模型二次综合' : '综合回答';
    const mStatus = U.el('span', { class: 'ac-status' });
    // 非流式（历史快照）也要带上完成标记与用量，否则重开会话后综合卡片的头部是空的
    mStatus.innerHTML = live ? '<span class="spinner"></span>'
      : '✓ ' + (msg.mode === 'model' ? '完成' : '已合并') + usageBadge(msg.usage);
    card.appendChild(U.el('div', { class: 'ac-head' },
      U.el('span', { class: 'ac-name' }, label),
      mStatus
    ));
    const body = U.el('div', { class: 'ac-body' + (live ? ' streaming' : ' md') });
    if (live) body.textContent = msg.content || '';
    else body.innerHTML = mdHtml(msg, msg.content);
    card.appendChild(body);
    card.appendChild(U.el('div', { class: 'card-foot' },
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
  function hasUsefulResults(results) {
    return (results || []).some(r => (r.status === 'done' || r.status === 'stopped') && r.content);
  }
  function inheritVersionsOf(am) {
    // 仅继承含有效回答的版本；当前显示全失败时不入池
    const versions = (Array.isArray(am.versions) ? am.versions : [])
      .filter(v => hasUsefulResults(v.results))
      .map(v => JSON.parse(JSON.stringify(v)));
    if (hasUsefulResults(am.results)) {
      const cur = snapshotOf(am);
      const last = versions[versions.length - 1];
      // 当前显示若与最后一份快照不同（或池为空），把当前显示也存入版本池
      if (!last || JSON.stringify(last.results) !== JSON.stringify(cur.results) || JSON.stringify(last.merge || null) !== JSON.stringify(cur.merge || null)) {
        versions.push(cur);
      }
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
    // 版本切换只换这一轮的内容：整页 fade 属于"切会话"的语言，这里用局部 crossfade
    suppressFade = true;
    renderAll();
    for (const sel of ['.answers', '.merge-card']) {
      const el = byRound(sel, am.roundId);
      if (el) { el.classList.remove('ver-swap'); void el.offsetWidth; el.classList.add('ver-swap'); }
    }
  }

  function roundTools(am) {
    const hasMerge = !!(am.merge && am.merge.content);
    const tools = U.el('div', { class: 'round-tools', 'data-round': am.roundId });
    if (am.versions && am.versions.length > 1) {
      const idx = typeof am.active === 'number' ? am.active : am.versions.length - 1;
      const snap = am.versions[idx] || {};
      const timeStr = snap.at ? U.fmtTime(snap.at) : '';
      tools.appendChild(U.el('button', {
        class: 'tool-btn', title: '上一版本', onclick: function () { setVersion(am, idx - 1); },
        disabled: idx <= 0
      }, '‹'));
      tools.appendChild(U.el('span', {
        class: 'ver-label',
        title: snap.at ? '此版本生成于 ' + new Date(snap.at).toLocaleString('zh-CN') : ''
      },
        '版本 ' + (idx + 1) + '/' + am.versions.length +
        (timeStr ? ' · ' + timeStr : '') +
        (idx === am.versions.length - 1 ? '（最新）' : '')));
      tools.appendChild(U.el('button', {
        class: 'tool-btn', title: '下一版本', onclick: function () { setVersion(am, idx + 1); },
        disabled: idx >= am.versions.length - 1
      }, '›'));
    }
    tools.appendChild(U.el('button', { class: 'tool-btn', onclick: function () { retryRound(am.roundId); } },
      U.el('span', { class: 'ico' }, '↻'), '重新生成'));
    // 综合入口常驻：已有综合时变成「重新综合」（旧综合保留在版本历史中）
    tools.appendChild(U.el('button', {
      class: 'tool-btn',
      title: hasMerge ? '用当前设置重新生成综合回答（覆盖现有这份，旧综合保留在版本历史中）' : '把多个模型的回答合并为一份综合回答',
      onclick: function () { doMerge(am.roundId, { redo: hasMerge }); }
    }, hasMerge ? '重新综合' : '综合回答'));
    tools.appendChild(U.el('button', {
      class: 'tool-btn', title: '把这一轮的提问与全部回答导出为 Markdown 文件',
      onclick: function () { exportRound(am.roundId); }
    }, '导出本轮'));
    tools.appendChild(U.el('button', {
      class: 'tool-btn danger', title: '删除这一轮提问与全部回答',
      onclick: function () { deleteRound(am.roundId); }
    }, '删除本轮'));
    // 本轮合计 token：放在最后，不打乱既有按钮顺序
    const total = roundUsage(am);
    if (total) {
      const n = (am.results || []).filter(r => r.usage && (r.usage.input || r.usage.output)).length;
      tools.appendChild(U.el('span', {
        class: 'round-tok',
        title: '本轮 ' + n + ' 个模型的 token 用量合计（输入+输出）'
      }, 'Σ ' + MM.modelInfo.fmtTokens(total) + ' tok'));
    }
    return tools;
  }

  // 查找该轮正在进行中的流式请求上下文（用于切换会话后重建事件绑定）
  function liveCtxFor(am) {
    for (const ctx of pending.values()) {
      if (ctx.assistantMsg === am) return { type: 'round', ctx };
      if (ctx.am === am && ctx.mergeMsg) return { type: 'merge', ctx };
    }
    return null;
  }

  function renderAll() {
    const wrap = U.$('#messages');
    wrap.innerHTML = '';
    const s = MM.sessions.current();
    U.$('#composer').style.display = s ? '' : 'none';
    // 先同步按钮状态：空会话会提前 return，放在末尾会漏掉
    refreshSendBtn();
    // 顶栏提示词按钮与面板也要先同步：空会话提前 return 时同样不能显示上一个会话的状态
    refreshPromptBadge();
    syncPromptBox();
    if (!s || !s.messages.length) {
      wrap.appendChild(emptyState());
      return;
    }
    let i = 0;
    // 统一在文档片段中构建，最后一次挂载（整列表只触发一次重排）
    const frag = document.createDocumentFragment();
    let seenUser = false; // 除第一条提问外，每条用户消息上方加轮次分隔线
    while (i < s.messages.length) {
      const m = s.messages[i];
      if (m.role === 'user') {
        if (seenUser) frag.appendChild(U.el('div', { class: 'round-sep' }));
        seenUser = true;
        frag.appendChild(renderUser(m));
        i++;
        // 收集该轮的 assistant（兼容旧格式：独立 merge 消息在迁移时已折叠，此处兜底忽略）
        let am = null;
        while (i < s.messages.length && s.messages[i].role !== 'user') {
          if (s.messages[i].role === 'assistant') am = s.messages[i];
          i++;
        }
        if (am) {
          // 该轮若有进行中的流式请求：以流式样式重建卡片，并把事件绑定切到新 DOM
          const live = liveCtxFor(am);
          let grid;
          if (live && live.type === 'round') {
            grid = U.el('div', { class: 'answers', 'data-round': am.roundId });
            // 已完成的模型按渲染态显示，仍在生成的才显示流式样式
            const cards = new Map();
            for (const r of am.results) {
              const card = answerCard(r, r.status === 'streaming', am.roundId);
              grid.appendChild(card);
              cards.set(r.modelId, cardRefs(card));
            }
            live.ctx.grid = grid;
            live.ctx.cards = cards; // 重建后事件分发要用新的节点引用
          } else {
            grid = answersGrid(am);
          }
          frag.appendChild(grid);
          const liveMerge = live && live.type === 'merge';
          if (liveMerge || (am.merge && am.merge.content)) {
            const card = mergeCard(am.merge, !!liveMerge, am.roundId);
            frag.appendChild(card);
            if (liveMerge) {
              live.ctx.mergeBody = card.querySelector('.ac-body');
              live.ctx.mergeStatus = card.querySelector('.ac-status');
            }
          }
          frag.appendChild(roundTools(am));
        } else if (i >= s.messages.length) {
          // 这一轮没有回答（例如联网搜索阶段被停止）：补一个「重新生成」入口，
          // 否则这条提问只能删掉重发
          frag.appendChild(userRetryTools(m));
        }
      } else {
        i++;
      }
    }
    wrap.appendChild(frag);
    scrollBottom(true);
    // 会话切换/重建后整体淡入一次；版本切换已抑制（走局部 ver-swap）
    if (!suppressFade) {
      wrap.classList.remove('fade-in');
      void wrap.offsetWidth; // 强制重排，让连续两次 renderAll 也能重启动画
      wrap.classList.add('fade-in');
    }
    suppressFade = false;
  }

  // 用户气泡里的附件展示：图片缩略图（点击放大）/ 文档芯片（点击看提取全文）
  function attachRow(msg) {
    const row = U.el('div', { class: 'msg-attach' });
    let n = 0;
    for (const im of (msg.images || [])) {
      if (!im || !im.id) continue;
      n++;
      row.appendChild(U.el('img', {
        class: 'msg-thumb', src: 'mmimg://' + im.id + '.' + im.ext, alt: im.name || '图片',
        title: (im.name || '图片') + (im.text ? '（已提取 ' + im.text.length + ' 字）' : '（未提取到文字）') + '，点击放大',
        onclick: function () { previewAttachment({ kind: 'image', id: im.id, ext: im.ext, name: im.name }); }
      }));
    }
    for (const f of (msg.files || [])) {
      if (!f) continue;
      n++;
      row.appendChild(U.el('button', {
        class: 'msg-file', title: '点击查看提取的全文',
        onclick: function () { previewAttachment({ kind: 'file', name: f.name, text: f.text }); }
      }, '📄 ' + (f.name || '附件') + ' · ' + (f.chars || (f.text ? f.text.length : 0)) + ' 字'));
    }
    return n ? row : null;
  }

  function renderUser(msg) {
    // 编辑态下不显示编辑按钮（避免按钮被替换后绑不到事件）
    const editBtn = U.el('div', { class: 'copy-hint', onclick: function () { startEdit(msg); } }, '编辑');
    return U.el('div', { class: 'user-msg' },
      U.el('div', { class: 'user-bubble' },
        msg.content ? U.el('div', { style: 'white-space:pre-wrap' }, msg.content) : null,
        attachRow(msg),
        U.el('div', { class: 'copy-hints' },
          U.el('div', { class: 'copy-hint', onclick: function () { U.copyText(msg.content); } }, '复制'),
          editBtn)
      ));
  }

  // ---------- 编辑重发 ----------
  // 把这条用户消息就地改成编辑框；保存后删除它后面的所有轮次并重新发送。
  function startEdit(msg) {
    if (streaming) { U.toast('请等待当前任务完成', true); return; }
    const s = MM.sessions.current();
    if (!s) return;
    const bubble = findUserBubble(msg);
    if (!bubble) return;
    // 已存在的编辑框不再重复插入（连点两次会套两层）
    if (bubble.querySelector('.edit-box')) return;
    // 其它气泡先退出编辑态，避免同屏出现多个编辑框（要连原文一起还原）
    closeOtherEdits(bubble);

    const idx = s.messages.indexOf(msg);
    const hasTail = s.messages.some((m, i) => i > idx && m.role === 'assistant');
    const ta = U.el('textarea', { class: 'edit-input', rows: '3' });
    ta.value = msg.content;
    const box = U.el('div', { class: 'edit-box' }, ta,
      U.el('div', { class: 'edit-actions' },
        U.el('span', { class: 'edit-hint' }, hasTail ? '保存后会删除这条消息之后的全部对话（含后续提问）并重新发送' : '保存后重新发送'),
        U.el('button', { class: 'btn-ghost', onclick: function () { cancelEdit(msg); } }, '取消'),
        U.el('button', { class: 'btn-primary', onclick: function () { saveEdit(msg); } }, '保存并重发')));
    // 原文隐藏但保留（取消时能还原），不要直接清空
    const orig = bubble.querySelector('[style*="pre-wrap"]');
    if (orig) orig.classList.add('hidden');
    // 插到内容与按钮之间；参照节点不存在时退化为追加到末尾，不能让它静默丢失
    const hintRow = bubble.querySelector('.copy-hints');
    if (hintRow) bubble.insertBefore(box, hintRow); else bubble.appendChild(box);
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
    autoResizeTextarea(ta);
    // 中文输入法兼容
    let composing = false;
    ta.addEventListener('compositionstart', function () { composing = true; });
    ta.addEventListener('compositionend', function () { composing = false; });
    ta.addEventListener('input', function () { autoResizeTextarea(ta); });
    ta.addEventListener('keydown', function (e) {
      if (composing || e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); saveEdit(msg); }
      else if (e.key === 'Escape') { e.preventDefault(); cancelEdit(msg); }
    });
  }

  // 关闭除 keep 以外的所有编辑框，并还原被隐藏的原文
  function closeOtherEdits(keep) {
    for (const box of Array.from(document.querySelectorAll('.user-bubble .edit-box'))) {
      const bubble = box.closest('.user-bubble');
      if (bubble === keep) continue;
      box.remove();
      const orig = bubble && bubble.querySelector('[style*="pre-wrap"]');
      if (orig) orig.classList.remove('hidden');
    }
  }

  function autoResizeTextarea(ta) {
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight + 2, 320) + 'px';
  }

  function findUserBubble(msg) {
    // 返回 .user-bubble（气泡本身），不是外层 .user-msg：
    // 编辑框要插在气泡内部，原文和按钮都在这一层
    const nodes = Array.from(document.querySelectorAll('.user-msg'));
    const i = MM.state.sessions.find(x => x.id === MM.state.currentId);
    if (!i) return null;
    const real = i.messages.filter(m => m.role === 'user').indexOf(msg);
    if (real < 0) return null;
    const outer = nodes[real];
    return outer ? outer.querySelector('.user-bubble') : null;
  }

  function cancelEdit(msg) {
    const bubble = findUserBubble(msg);
    if (!bubble) return;
    const box = bubble.querySelector('.edit-box');
    if (box) box.remove();
    const orig = bubble.querySelector('[style*="pre-wrap"]');
    if (orig) orig.classList.remove('hidden');
  }

  function saveEdit(msg) {
    if (streaming) { U.toast('请等待当前任务完成', true); return; }
    const s = MM.sessions.current();
    if (!s) return;
    const bubble = findUserBubble(msg);
    const box = bubble && bubble.querySelector('.edit-box');
    const ta = box && box.querySelector('.edit-input');
    if (!ta) return;
    const text = ta.value.trim();
    if (!text) { U.toast('内容不能为空', true); return; }
    if (text === msg.content) { cancelEdit(msg); U.toast('内容未变化，已取消编辑'); return; }

    const models = selectedModels();
    if (!models.length) { U.toast('请先在输入框上方选择至少一个模型', true); return; }

    // 只保留这条消息及其之前的历史，后面的回答全部丢弃（用户明确要改这条提问）
    const idx = s.messages.indexOf(msg);
    if (idx < 0) return; // 消息已不在当前会话（例如刚导入/切换过），不能盲目 splice(-1+1) 清空全部
    s.messages.splice(idx + 1);
    msg.content = text;
    // 搜索结果是针对旧提问的，必须清掉，否则重新发送会带着过期来源
    delete msg.sources;
    if (s.title === '新会话' || s.messages.length === 1) s.title = text.slice(0, 30);
    s.updatedAt = Date.now();
    MM.save();
    renderAll();
    renderTitle();
    MM.sessions.render();

    streaming = s.id;
    setSendBtn(true);
    dispatchRound(s, msg, models, U.$('#tgl-search').checked, false)
      .catch(e => { streaming = null; setSendBtn(false); U.toast('请求失败：' + e.message, true); });
  }

  // ---------- 会话提示词 ----------
  // 顶栏「提示词」按钮展开面板；会话里设了提示词时按钮点亮，便于一眼看出本会话有覆盖。
  function refreshPromptBadge() {
    const s = MM.sessions.current();
    const btn = U.$('#btn-session-prompt');
    if (!btn) return;
    const has = !!(s && typeof s.systemPrompt === 'string' && s.systemPrompt.trim());
    btn.classList.toggle('on', has);
    btn.title = has ? '本会话已设置提示词（点击编辑/清除）' : '为当前会话单独设置系统提示词（留空则用全局提示词）';
    const hint = U.$('#sp-hint');
    if (hint) {
      const g = MM.state.config && typeof MM.state.config.systemPrompt === 'string' ? MM.state.config.systemPrompt.trim() : '';
      hint.textContent = has ? '本会话提示词已启用' : (g ? '本会话未设置，将使用全局提示词' : '未设置提示词（可去设置里写全局的）');
    }
  }

  function togglePromptBox(forceOpen) {
    const box = U.$('#session-prompt-box');
    if (!box) return;
    const open = forceOpen === undefined ? box.classList.contains('hidden') : !!forceOpen;
    box.classList.toggle('hidden', !open);
    if (!open) return;
    const s = MM.sessions.current();
    const ta = U.$('#session-prompt');
    if (ta) ta.value = (s && typeof s.systemPrompt === 'string') ? s.systemPrompt : '';
    refreshPromptBadge();
    if (ta) ta.focus();
  }

  // 面板展开时把内容同步成当前会话的提示词（只在会话切换/整体重绘时调用，
  // 不能放进 refreshPromptBadge：每次输入都重设 value 会把光标顶到末尾）
  function syncPromptBox() {
    const box = U.$('#session-prompt-box');
    if (!box || box.classList.contains('hidden')) return;
    const s = MM.sessions.current();
    const ta = U.$('#session-prompt');
    if (ta) ta.value = (s && typeof s.systemPrompt === 'string') ? s.systemPrompt : '';
  }

  // ---------- 发送 ----------
  async function send() {
    if (streamingHere()) { stopAll(); return; }
    if (streaming) {
      // 别的会话正在生成：不要静默停掉它，也不要把消息发错会话
      U.toast('「' + streamingSessionName() + '」正在生成中，请等待完成或切回该会话停止', true);
      return;
    }
    const input = U.$('#input');
    const text = input.value.trim();
    // 只贴了图/拖了文件、没打字也允许发送
    if (!text && !pendingAttach.length) return;
    const models = selectedModels();
    if (!models.length) { U.toast('请先在输入框上方选择至少一个模型', true); return; }
    // OCR/文档提取可能还在跑：等它们完成，否则图片会被静默丢掉
    await Promise.all(pendingAttach.map(a => a.ready).filter(Boolean));
    const atts = pendingAttach.filter(a => !a.failed && (a.kind !== 'image' || a.id));
    if (!text && !atts.length) { U.toast('附件处理失败，请移除后重试', true); return; }

    const s = MM.sessions.current() || MM.sessions.createSilent();
    const userMsg = { id: U.uid(), role: 'user', content: text, createdAt: Date.now() };
    const imgs = atts.filter(a => a.kind === 'image')
      .map(a => ({ id: a.id, ext: a.ext, name: a.name, w: a.w, h: a.h, size: a.size, text: a.text || '' }));
    if (imgs.length) userMsg.images = imgs;
    const files = atts.filter(a => a.kind === 'file' && a.text)
      .map(a => ({ name: a.name, chars: a.chars, text: a.text }));
    if (files.length) userMsg.files = files;
    s.messages.push(userMsg);
    if (s.title === '新会话') s.title = (text || (imgs.length ? '图片提问' : '附件提问')).slice(0, 30);
    s.updatedAt = Date.now();
    MM.save();
    MM.sessions.render();
    renderTitle();

    // 清空空状态
    const wrap = U.$('#messages');
    const es = wrap.querySelector('.empty-state');
    if (es) es.remove();
    // 上一条"无回答"提问留下的重新生成入口已经过期（后面有新消息了），先移除
    for (const t of Array.from(wrap.querySelectorAll('.round-tools.retry-only'))) t.remove();
    wrap.appendChild(renderUser(userMsg));
    scrollBottom(true);
    input.value = '';
    autoResize();
    pendingAttach = [];
    renderAttachBar();

    // 立即锁定状态：联网搜索 await 期间不允许再次发送/重试（防竞态）
    streaming = s.id;
    setSendBtn(true);
    dispatchRound(s, userMsg, models, U.$('#tgl-search').checked, true)
      .catch(e => { streaming = null; setSendBtn(false); U.toast('请求失败：' + e.message, true); });
  }

  // 发起一轮多模型请求并渲染占位卡片（inheritVersions：重试时继承的历史版本池）
  async function dispatchRound(s, userMsg, models, searchOn, appendUserDom, inheritVersions) {
    const myToken = ++runToken;
    const wrap = U.$('#messages');
    // 关闭联网搜索时不能沿用上一轮缓存的来源（旧结果可能已过时，还会把 searchOn 抬成 true）
    let searchResults = null;
    let preGrid = null; // 搜索期间的占位网格（避免"点了发送界面没反应"）
    if (searchOn) {
      searchResults = userMsg.sources || null;
      // 纯图片提问没有可搜的文字：跳过搜索阶段，避免拿空串去请求
      if (!searchResults && String(userMsg.content || '').trim()) {
        // 搜索要等 1~3 秒甚至更久：先挂一排「搜索中…」占位卡片，让用户立刻看到进展
        if (MM.sessions.current() === s) {
          preGrid = U.el('div', { class: 'answers' });
          for (const m of models) {
            preGrid.appendChild(answerCard(
              { modelId: m.id, name: m.name || m.modelId, status: 'searching', content: '' }, true, ''));
          }
          for (const t of Array.from(wrap.querySelectorAll('.round-tools.retry-only'))) t.remove();
          wrap.appendChild(preGrid);
          scrollBottom(true);
        }
        searchPhase++;
        try {
          searchResults = await api.search(userMsg.content, 6);
          if (!searchResults) U.toast('联网搜索未返回结果（可在设置中检查搜索引擎）');
        } catch (e) {
          U.toast('联网搜索失败：' + e.message, true);
          searchResults = null;
        } finally {
          searchPhase--;
        }
        if (searchResults && searchResults.length) userMsg.sources = searchResults;
      }
    }
    // 搜索期间用户点了停止（或已开始新一轮）：放弃本轮（此时助手消息尚未入列，干净退出）
    if (streaming !== s.id || runToken !== myToken) {
      if (preGrid && preGrid.isConnected) preGrid.remove();
      if (!streaming) {
        U.toast('已取消');
        // 该提问没有回答：重绘出「重新生成」入口（会话已切走时由切回时的 renderAll 负责）
        if (MM.sessions.current() === s) renderAll();
      }
      return;
    }

    const roundId = U.uid();
    const reqId = 'req' + (++seq);
    // 取所选模型中最小的上下文窗口做裁剪，确保所有模型都不超限
    const ctxLimits = models.map(x => x.contextTokens).filter(Boolean);
    const ctxLimit = ctxLimits.length ? Math.min.apply(null, ctxLimits) : 0;
    const maxOut = Math.max.apply(null, models.map(x => x.maxTokens || 4096));
    // 历史按模型各建一份：多模态模型的当前轮带原图引用，纯文本模型带提取的文字
    const skipped = m => modelSkippedForRound(m, userMsg);
    const targets = models.filter(m => !skipped(m))
      .map(m => ({ model: stripModel(m), messages: buildHistory(s, userMsg, searchResults, ctxLimit, maxOut, m) }));

    const assistantMsg = {
      id: U.uid(), role: 'assistant', roundId: roundId, createdAt: Date.now(),
      versions: Array.isArray(inheritVersions) ? inheritVersions : [],
      active: Array.isArray(inheritVersions) ? inheritVersions.length - 1 : -1,
      results: models.map(m => {
        const r = { modelId: m.id, name: m.name || m.modelId, status: 'streaming', content: '', reasoning: '' };
        if (skipped(m)) { r.status = 'skipped'; r.error = '该模型不支持图片，且图中未提取到文字'; }
        return r;
      })
    };
    // 把联网搜索来源挂到每个回答上：卡片里的「📎 搜索来源」从这里读取
    if (searchResults && searchResults.length) {
      for (const r of assistantMsg.results) r.sources = searchResults;
    }
    s.messages.push(assistantMsg);
    s.updatedAt = Date.now();
    // 这里不落盘：所有调用方（send/retryRound/saveEdit/retryUser）在进入本函数前
    // 已经把用户消息/裁剪结果保存过了。占位卡片没有内容，等 all-done 再连同结果一起写，
    // 可以少一次整份会话历史的 IPC 复制与磁盘写入。

    streaming = s.id;
    setSendBtn(true);
    MM.sessions.render(); // 会话列表立刻出现"生成中"呼吸点（切到别的会话也能看到后台在跑）

    const grid = U.el('div', { class: 'answers', 'data-round': roundId });
    // 缓存每张卡片的节点引用：流式期间每个 delta 都要更新状态/正文，
    // 逐个事件 querySelector 会在 4 模型并发时放大成大量 DOM 查询
    const cards = new Map();
    for (const r of assistantMsg.results) {
      // 跳过的模型（不支持图片）不是流式：必须按状态建卡，否则看不到跳过说明
      const card = answerCard(r, r.status === 'streaming', roundId);
      grid.appendChild(card);
      cards.set(r.modelId, cardRefs(card));
    }
    if (appendUserDom) { /* user DOM 已在 send() 中追加 */ }
    pending.set(reqId, { session: s, assistantMsg: assistantMsg, grid: grid, userMsg: userMsg, cards: cards });
    // 前面 await 过联网搜索：这期间用户可能已切到别的会话，
    // 此时不能把卡片挂到当前视图上（否则会串进别的会话界面）。
    // 数据照常更新，切回本会话时 renderAll 会把进行中的流式卡片重画出来。
    if (MM.sessions.current() === s) {
      // 搜索期间重绘可能留下"重新生成"临时工具栏：回答卡片要替换它，不能排在它后面
      for (const t of Array.from(wrap.querySelectorAll('.round-tools.retry-only'))) t.remove();
      // 搜索占位网格原位替换成真正的回答网格（避免 spinner 态闪一下）
      if (preGrid && preGrid.isConnected) preGrid.replaceWith(grid);
      else wrap.appendChild(grid);
      scrollBottom(true);
    }
    try {
      await api.send({ requestId: reqId, targets: targets, searchOn: !!searchOn });
    } catch (e) {
      pending.delete(reqId);
      streaming = null;
      setSendBtn(false);
      // 请求没能启动：把占位卡片标成失败并落盘，避免界面上永远转圈
      for (const r of assistantMsg.results) {
        if (r.status === 'streaming') { r.status = 'error'; r.error = '请求失败：' + e.message; }
      }
      MM.save();
      renderAll();
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
      // 还有其它请求在跑、或有新一轮正在搜索时，不能把 streaming 清掉
      if (!pending.size && !searchPhase) { streaming = null; refreshSendBtn(); }
      if (ctx.mergeMsg) {
        // 综合请求结束：同步到当前版本的快照
        const am = ctx.am;
        if (am && Array.isArray(am.versions) && am.versions.length) {
          am.versions[am.active >= 0 ? am.active : am.versions.length - 1].merge =
            am.merge ? JSON.parse(JSON.stringify(am.merge)) : null;
        }
        finalizeMergeCard(ctx, !!ctx.mergeFailed);
        MM.save();
        return;
      }
      // 回答轮结束：保存本版本快照（全部模型都失败时不入版本池；每轮最多保留 10 版）
      const am = ctx.assistantMsg;
      if (hasUsefulResults(am.results)) {
        am.versions = am.versions || [];
        const snap = snapshotOf(am);
        if (!am.versions.length || JSON.stringify(am.versions[am.versions.length - 1].results) !== JSON.stringify(snap.results)) {
          am.versions.push(snap);
        }
        if (am.versions.length > 10) am.versions.splice(0, am.versions.length - 10); // 只保留最近 10 版
        am.active = am.versions.length - 1;
      } else if (typeof am.active !== 'number' || am.active < 0) {
        am.active = Array.isArray(am.versions) ? am.versions.length - 1 : -1;
      }
      // 重建轮次工具栏（版本导航 / 重新生成 / 综合回答入口）
      const oldTools = byRound('.round-tools', am.roundId, wrap);
      if (oldTools) oldTools.remove();
      if (ctx.grid) ctx.grid.after(roundTools(am));
      MM.save();
      MM.sessions.render();
      // 整轮全失败时没有可合并的内容，不要弹「没有可合并的成功回答」；
      // 单模型重试不自动重跑综合：用户只是补一个失败的模型，重写全部综合既慢又费钱
      if (!ctx.singleRetry && U.$('#tgl-auto').checked && hasUsefulResults(am.results)) doMerge(am.roundId);
      return;
    }

    if (ctx.mergeMsg) {
      const body = ctx.mergeBody, status = ctx.mergeStatus;
      if (ev.type === 'start') { status.innerHTML = '<span class="spinner"></span> 生成中…'; }
      else if (ev.type === 'delta') {
        ctx.mergeMsg.content += ev.text;
        scheduleStreamPaint(body, function () { if (!ctx.mergeFailed) body.textContent = ctx.mergeMsg.content; });
      }
      else if (ev.type === 'done' && ev.usage) {
        // 综合也是真实请求，占用量要一并记下并显示，否则统计会漏掉这一项
        ctx.mergeMsg.usage = ev.usage;
        status.innerHTML = '✓ 完成' + usageBadge(ev.usage);
      }
      else if (ev.type === 'error') {
        // 综合失败：回滚 merge 状态，允许用户再次点击“综合回答”
        ctx.mergeFailed = true; // 标记失败，随后的 all-done 不能把状态改回“完成”
        ctx.mergeMsg.content += '\n\n（综合失败：' + ev.message + '）';
        status.innerHTML = '<span style="color:var(--danger)">✗</span>';
        if (ctx.am) {
          ctx.am.merge = null;
          syncMergeToVersion(ctx.am);
          const oldTools = byRound('.round-tools', ctx.roundId, wrap);
          if (oldTools) oldTools.replaceWith(roundTools(ctx.am));
        }
      }
      return;
    }

    if (!ev.modelId) return;
    const res = ctx.assistantMsg.results.find(r => r.modelId === ev.modelId);
    // 用建卡时缓存的节点引用，避免每个 delta 都遍历/查询 DOM
    const refs = ctx.cards && ctx.cards.get(ev.modelId);
    if (!res || !refs) return;
    const card = refs.card;
    const status = refs.status;
    const body = refs.body;

    if (ev.type === 'start') {
      status.innerHTML = '<span class="spinner"></span> 生成中…';
    } else if (ev.type === 'delta') {
      res.content += ev.text;
      // 绘制前检查状态：error/done 事件可能在同一帧内先到，
      // 不能让排队的旧绘制把错误信息/渲染结果覆盖回纯文本
      scheduleStreamPaint(body, function () { if (res.status === 'streaming') body.textContent = res.content; });
    } else if (ev.type === 'reasoning') {
      res.reasoning = (res.reasoning || '') + ev.text;
      if (!refs.reasoning) {
        let det = card.querySelector('details.reasoning');
        if (!det) {
          det = U.el('details', { class: 'reasoning' },
            U.el('summary', {}, '查看思考过程'),
            U.el('div', { class: 'r-body' }));
          card.insertBefore(det, body);
        }
        refs.reasoning = det.querySelector('.r-body');
      }
      // 与正文一样按帧合帧：长思考链下每个 delta 全量重写 textContent 是 O(n²)
      const rBody = refs.reasoning;
      if (rBody) scheduleStreamPaint(rBody, function () { if (res.status === 'streaming') rBody.textContent = res.reasoning; });
    } else if (ev.type === 'done') {
      res.status = 'done'; res.ms = ev.ms; res.chars = ev.chars;
      if (ev.usage) res.usage = ev.usage; // token 用量（服务端回传，无则不显示）
      status.innerHTML = statusHtml(res);
      body.classList.remove('streaming');
      body.classList.add('md');
      body.innerHTML = mdHtml(res, res.content);
    } else if (ev.type === 'error') {
      if (/已停止/.test(ev.message)) { res.status = 'stopped'; res.content = res.content || ''; }
      else { res.status = 'error'; res.error = ev.message; }
      // 已停止的回答也可能带出部分用量，一起存下来
      if (ev.usage) res.usage = ev.usage;
      body.classList.remove('streaming');
      if (res.status === 'error') {
        body.innerHTML = '<div class="ac-error">✗ ' + U.esc(ev.message) + '</div>';
      } else if (res.content) {
        body.classList.add('md');
        body.innerHTML = mdHtml(res, res.content);
      }
      status.innerHTML = statusHtml(res);
    }
  }

  function stopAll() {
    for (const id of Array.from(pending.keys())) {
      // 停止失败不应变成未处理的 Promise 拒绝
      Promise.resolve(api.stop(id)).catch(function () { });
    }
    // 搜索阶段尚无 pending 可中止：立即复位并让令牌失效，dispatchRound 在搜索返回后检测到即退出
    streaming = null;
    runToken++;
    setSendBtn(false);
    MM.sessions.render(); // 摘掉会话列表上的"生成中"呼吸点
  }

  // 停止指定会话的在途请求（删除会话时调用；含仍在搜索阶段的轮次）
  function stopSession(sessionId) {
    for (const [reqId, ctx] of Array.from(pending.entries())) {
      if (ctx.session && ctx.session.id === sessionId) {
        pending.delete(reqId);
        Promise.resolve(api.stop(reqId)).catch(function () { });
      }
    }
    if (streaming === sessionId) {
      streaming = null;
      runToken++;
      setSendBtn(false);
    }
  }

  // ---------- 重新生成 ----------
  // 没有回答的提问（搜索阶段被停止）用这个临时工具栏重发；回答开始后工具栏会被移除
  function userRetryTools(msg) {
    return U.el('div', { class: 'round-tools retry-only' },
      U.el('button', { class: 'tool-btn', onclick: function () { retryUser(msg); } },
        U.el('span', { class: 'ico' }, '↻'), '重新生成'));
  }

  async function retryUser(userMsg) {
    if (streaming) { U.toast('请等待当前任务完成', true); return; }
    const s = MM.sessions.current();
    if (!s) return;
    const idx = s.messages.indexOf(userMsg);
    if (idx < 0) return;
    // 只允许对"最后一条消息"重发：否则后面的新对话会被 splice 掉
    if (idx !== s.messages.length - 1) {
      U.toast('该提问后面已有新内容，请刷新后重试', true);
      renderAll();
      return;
    }
    const models = selectedModels();
    if (!models.length) { U.toast('请先选择模型', true); return; }
    // 正常情况下该提问就是最后一条；若后面还有残留消息，一并清掉避免重复
    s.messages.splice(idx + 1);
    for (const t of Array.from(document.querySelectorAll('.round-tools.retry-only'))) t.remove();
    s.updatedAt = Date.now();
    MM.save();
    streaming = s.id;
    setSendBtn(true);
    dispatchRound(s, userMsg, models, U.$('#tgl-search').checked, false)
      .catch(e => { streaming = null; setSendBtn(false); U.toast('请求失败：' + e.message, true); });
  }

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
    // 立即锁定状态（防搜索 await 期间重复触发）
    streaming = s.id;
    setSendBtn(true);
    dispatchRound(s, userMsg, models, U.$('#tgl-search').checked, false, versions)
      .catch(e => { streaming = null; setSendBtn(false); U.toast('请求失败：' + e.message, true); });
  }

  // ---------- 单模型重试 ----------
  // 只重发失败/被停止的那一个模型，结果原位更新：已成功的模型不用再花钱重跑。
  // 历史按当前会话状态重建（与 dispatchRound 同一来源），搜索结果沿用该轮已保存的来源。
  async function retryOne(roundId, modelId) {
    if (streaming) { U.toast('请等待当前任务完成', true); return; }
    const s = MM.sessions.current();
    if (!s) return;
    const idx = s.messages.findIndex(m => m.role === 'assistant' && m.roundId === roundId);
    if (idx < 0) return;
    const am = s.messages[idx];
    const userMsg = s.messages[idx - 1];
    if (!userMsg || userMsg.role !== 'user') return;
    const res = (am.results || []).find(r => r.modelId === modelId);
    if (!res) return;
    if (res.status === 'streaming') return;
    const flat = MM.settings.allFlatModels().find(m => m.id === modelId);
    if (!flat) { U.toast('该模型已被删除或停用，无法重试', true); return; }

    // 重置该条结果并原位替换为流式卡片（事件按 modelId 找卡片，ctx.grid 直接指向现有网格）
    res.status = 'streaming'; res.content = ''; res.reasoning = '';
    delete res.error; delete res.ms; delete res.chars; delete res.usage;
    MM.save();

    streaming = s.id;
    setSendBtn(true);
    MM.sessions.render(); // 呼吸点：单模型重试同样占用全局生成状态
    const reqId = 'rt' + (++seq);
    // roundId 可能来自导入数据（含引号等字符），不能拼进 CSS 选择器：用 byRound 逐个比对属性
    const gridEl = byRound('.answers', roundId);
    const old = gridEl && Array.from(gridEl.querySelectorAll('.answer-card'))
      .find(c => c.getAttribute('data-model-id') === modelId);
    // 替换卡片后必须同步重建事件用的节点缓存：handleEvent 按 ctx.cards.get(modelId)
    // 找节点（流式竞态修复后不再走 DOM 查询），漏了这一条重试的流式内容会被静默丢弃
    let fresh = null;
    if (old) {
      fresh = answerCard(res, true, roundId);
      old.replaceWith(fresh);
    }

    const ctxLimit = flat.contextTokens || 0;
    const history = buildHistory(s, userMsg, userMsg.sources || null, ctxLimit, flat.maxTokens || 4096, flat);
    pending.set(reqId, {
      session: s, assistantMsg: am, grid: gridEl, userMsg: userMsg, singleRetry: true,
      cards: new Map(fresh ? [[modelId, cardRefs(fresh)]] : [])
    });
    if (!fresh) renderAll(); // 网格不在 DOM（理论不可达）：走 live 重建路径重新绑定节点
    scrollBottom(true);
    try {
      await api.send({ requestId: reqId, targets: [{ model: stripModel(flat), messages: history }], searchOn: !!userMsg.sources });
    } catch (e) {
      pending.delete(reqId);
      streaming = null; setSendBtn(false);
      res.status = 'error'; res.error = e.message;
      MM.save(); renderAll();
      U.toast('重试失败：' + e.message, true);
    }
  }

  // ---------- 导出本轮 ----------
  // 生成 Markdown：结构用标记（这是文件产物，不是剪贴板纯文本），正文用模型原始输出。
  async function exportRound(roundId) {
    const s = MM.sessions.current();
    if (!s) return;
    const idx = s.messages.findIndex(m => m.role === 'assistant' && m.roundId === roundId);
    if (idx < 0) return;
    const am = s.messages[idx];
    const userMsg = s.messages[idx - 1];
    const md = roundToMarkdown(am, s, userMsg);
    const filename = (s.title || '对话导出').replace(/[\\/:*?"<>|]/g, '_').slice(0, 50) + '.md';
    try {
      const p = await api.exportText({ content: md, filename: filename });
      if (p) U.toast('已导出到 ' + p);
    } catch (e) {
      U.toast('导出失败：' + ((e && e.message) || e), true);
    }
  }

  function roundToMarkdown(am, s, userMsg) {
    const L = [];
    L.push('# ' + ((userMsg && userMsg.content) || '（图片提问）'));
    L.push('');
    L.push('> 会话「' + (s.title || '') + '」 · 导出于 ' + new Date().toLocaleString('zh-CN'));
    const attLines = attachmentLines(userMsg);
    if (attLines.length) {
      L.push('');
      L.push('**提问附件**：');
      for (const line of attLines) L.push('- ' + line);
    }
    for (const r of (am.results || [])) {
      L.push('');
      L.push('## ' + (r.name || r.modelId));
      const bits = [];
      if (r.status === 'done') bits.push('完成');
      else if (r.status === 'stopped') bits.push('已停止');
      else if (r.status === 'skipped') bits.push('已跳过（' + (r.error || '不支持图片') + '）');
      else if (r.status === 'error') bits.push('失败：' + (r.error || ''));
      if (r.ms) bits.push('用时 ' + U.fmtMs(r.ms));
      if (r.chars) bits.push(r.chars + ' 字');
      if (r.usage && (r.usage.input || r.usage.output)) {
        bits.push(MM.modelInfo.fmtTokens((r.usage.input || 0) + (r.usage.output || 0)) +
          ' tokens（输入 ' + (r.usage.input || 0) + ' / 输出 ' + (r.usage.output || 0) + '）');
      }
      if (bits.length) { L.push('*' + bits.join(' · ') + '*'); L.push(''); }
      L.push(r.content || '');
    }
    if (am.merge && am.merge.content) {
      L.push('');
      L.push('## 综合回答');
      const mu = am.merge.usage;
      if (mu && (mu.input || mu.output)) {
        L.push('*' + MM.modelInfo.fmtTokens((mu.input || 0) + (mu.output || 0)) + ' tokens（输入 ' + (mu.input || 0) + ' / 输出 ' + (mu.output || 0) + '）*');
        L.push('');
      }
      L.push(am.merge.content);
    }
    // 文档附件全文放附录，导出文件拿到别处也能读到附件内容
    for (const f of ((userMsg && userMsg.files) || [])) {
      if (!f || !f.text) continue;
      L.push('');
      L.push('## 附录：附件「' + (f.name || '') + '」全文');
      L.push('');
      L.push(f.text);
    }
    return L.join('\n');
  }

  // 提问附件的一句话说明（导出用）
  function attachmentLines(userMsg) {
    const lines = [];
    for (const im of ((userMsg && userMsg.images) || [])) {
      if (!im) continue;
      lines.push('图片 ' + (im.name || '') + (im.text ? '（图中文字：' + String(im.text).slice(0, 120).replace(/\s+/g, ' ') + '…）' : '（未提取到文字）'));
    }
    for (const f of ((userMsg && userMsg.files) || [])) {
      if (!f) continue;
      lines.push('文档 ' + (f.name || '') + '（' + (f.chars || (f.text ? f.text.length : 0)) + ' 字）');
    }
    return lines;
  }

  // ---------- 导出整个会话 ----------
  function sessionToMarkdown(s) {
    const msgs = (s && s.messages) || [];
    const L = [];
    L.push('# ' + (s.title || '会话导出'));
    L.push('');
    L.push('> 导出于 ' + new Date().toLocaleString('zh-CN') + ' · ' + msgs.filter(m => m && m.role === 'user').length + ' 轮对话');
    function statusLabel(r) {
      if (r.status === 'done') return '完成';
      if (r.status === 'stopped') return '已停止';
      if (r.status === 'skipped') return '已跳过';
      if (r.status === 'error') return '失败：' + (r.error || '');
      return '';
    }
    let i = 0, round = 0;
    while (i < msgs.length) {
      const m = msgs[i];
      if (!m || m.role !== 'user') { i++; continue; }
      round++;
      L.push('');
      L.push('---');
      L.push('');
      L.push('## 提问 ' + round + '：' + (String(m.content || '').trim() || '（图片提问）'));
      const attLines = attachmentLines(m);
      if (attLines.length) {
        L.push('');
        for (const line of attLines) L.push('*[' + line + ']*');
      }
      i++;
      let am = null;
      while (i < msgs.length && (!msgs[i] || msgs[i].role !== 'user')) {
        if (msgs[i] && msgs[i].role === 'assistant') am = msgs[i];
        i++;
      }
      if (am) {
        for (const r of (am.results || [])) {
          L.push('');
          L.push('### ' + (r.name || r.modelId) + (statusLabel(r) ? '（' + statusLabel(r) + '）' : ''));
          L.push('');
          L.push(r.content || '（无内容）');
        }
        if (am.merge && am.merge.content) {
          L.push('');
          L.push('### 综合回答');
          L.push('');
          L.push(am.merge.content);
        }
      } else {
        L.push('');
        L.push('*(本轮没有回答)*');
      }
    }
    // 全部文档附件全文集中在文末附录
    let appendix = 0;
    for (const m of msgs) {
      for (const f of ((m && m.files) || [])) {
        if (!f || !f.text) continue;
        appendix++;
        L.push('');
        L.push('## 附录' + appendix + '：附件「' + (f.name || '') + '」全文');
        L.push('');
        L.push(f.text);
      }
    }
    return L.join('\n');
  }

  async function exportSession() {
    const s = MM.sessions.current();
    if (!s || !s.messages.length) { U.toast('当前会话还没有内容', true); return; }
    const md = sessionToMarkdown(s);
    const filename = (s.title || '会话导出').replace(/[\\/:*?"<>|]/g, '_').slice(0, 50) + '.md';
    try {
      const p = await api.exportText({ content: md, filename: filename, title: '导出整个会话' });
      if (p) U.toast('已导出到 ' + p);
    } catch (e) {
      U.toast('导出失败：' + ((e && e.message) || e), true);
    }
  }

  // ---------- 删除本轮 ----------
  async function deleteRound(roundId) {
    if (streaming) { U.toast('请等待当前任务完成', true); return; }
    const s = MM.sessions.current();
    if (!s) return;
    const idx = s.messages.findIndex(m => m.role === 'assistant' && m.roundId === roundId);
    if (idx < 0) return;
    const ok = await U.confirm({
      title: '删除本轮对话',
      message: '将删除这一轮的提问与全部回答（含综合回答）。此操作不可恢复。',
      okText: '删除',
      danger: true
    });
    if (!ok) return;
    // 连同它前面的提问一起删；后面若挂着旧格式的独立消息也一并清掉（到下一条 user 为止）
    let start = idx;
    if (s.messages[idx - 1] && s.messages[idx - 1].role === 'user') start = idx - 1;
    let end = idx + 1;
    while (end < s.messages.length && s.messages[end].role !== 'user') end++;
    s.messages.splice(start, end - start);
    s.updatedAt = Date.now();
    MM.save();
    renderAll();
    MM.sessions.render();
    U.toast('已删除本轮对话');
  }

  // ---------- 综合回答 ----------
  async function doMerge(roundId, opts) {
    opts = opts || {};
    if (streaming) { U.toast('请等待当前任务完成', true); return; }
    // 轮次可能属于后台会话：自动综合在 all-done 时触发，此刻用户也许已切到别的会话。
    // 只查当前会话会让后台完成的轮次永远不综合——按 roundId 全局定位所属会话。
    let s = MM.sessions.current();
    let idx = s ? s.messages.findIndex(m => m.role === 'assistant' && m.roundId === roundId) : -1;
    if (idx < 0) {
      for (const cand of MM.state.sessions) {
        if (!cand || !Array.isArray(cand.messages) || cand === s) continue;
        const j = cand.messages.findIndex(m => m && m.role === 'assistant' && m.roundId === roundId);
        if (j >= 0) { s = cand; idx = j; break; }
      }
    }
    if (idx < 0 || !s) return;
    const am = s.messages[idx];
    const userMsg = s.messages[idx - 1];
    if (!userMsg) return;
    if (am.merge && am.merge.content) {
      if (!opts.redo) { U.toast('该轮已有综合回答，可点「重新综合」覆盖', true); return; }
      const okc = await U.confirm({
        title: '重新综合',
        message: '将用当前设置重新生成综合回答，覆盖现有的这一份。旧综合保留在版本历史中，可随时切回。',
        okText: '重新综合'
      });
      if (!okc) return;
      // 当前内容先存为新版本快照：重综合完成后写入最新快照，旧综合留在上一份里可回滚
      if (hasUsefulResults(am.results)) {
        am.versions = am.versions || [];
        am.versions.push(snapshotOf(am));
        if (am.versions.length > 10) am.versions.splice(0, am.versions.length - 10);
        am.active = am.versions.length - 1;
      }
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
    // 前端合并是同步完成的，直接等下面的最终保存即可；只有模型综合需要先落盘占位
    if (source !== 'frontend') MM.save();

    // 渲染实时卡片（先清掉该轮此前失败留下的综合卡片，避免重复堆叠）
    const wrap = U.$('#messages');
    const card = mergeCard(am.merge, true, roundId);
    // 卡片只在正查看该会话时挂进 DOM；后台会话时保持游离——流式内容照常写进
    // mergeMsg（数据），切回该会话时 renderAll 会经 live 上下文重建卡片与绑定
    if (MM.sessions.current() === s) {
      const staleCard = byRound('.merge-card', roundId, wrap);
      if (staleCard) staleCard.remove();
      const oldTools = byRound('.round-tools', roundId, wrap);
      if (oldTools) oldTools.replaceWith(roundTools(am));
      // 插到本轮回答网格之后（而不是消息列表末尾），旧轮次综合时不会跑到页面最下面
      const gridEl = byRound('.answers', roundId, wrap);
      if (gridEl) gridEl.after(card); else wrap.appendChild(card);
      scrollBottom(true);
    }

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
    streaming = s.id;
    if (MM.sessions.current() === s) setSendBtn(true); // 后台会话综合：不能锁当前视图的输入框
    MM.sessions.render(); // 呼吸点
    const t0 = Date.now();
    const reqId = 'syn' + (++seq);
    // 按综合模型的上下文给提示词设上限，避免多份长回答顶爆上下文
    const promptBudget = Math.max(4000, (model.contextTokens || 32768) - (model.maxTokens || 4096) - 2048);
    const prompt = MM.merge.synthesisPrompt(userMsg.content, okResults, promptBudget);
    // 综合也是一次真实提问：系统提示词同样要带上，否则综合结果会丢掉角色设定
    const synthMsgs = [];
    const sys = effectiveSystemPrompt(s);
    if (sys) synthMsgs.push({ role: 'system', content: sys });
    synthMsgs.push({ role: 'user', content: prompt });
    pending.set(reqId, {
      mergeMsg: am.merge,
      mergeBody: card.querySelector('.ac-body'),
      mergeStatus: card.querySelector('.ac-status'),
      session: s,
      am: am,
      roundId: roundId
    });
    try {
      await api.synthesize({ requestId: reqId, model: stripModel(model), messages: synthMsgs });
    } catch (e) {
      pending.delete(reqId);
      streaming = null;
      setSendBtn(false);
      U.toast('综合失败：' + e.message, true);
      // 回滚 merge 状态并恢复工具栏，允许再次综合
      if (am) {
        am.merge = null;
        syncMergeToVersion(am);
      }
      const oldTools = byRound('.round-tools', roundId, wrap);
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

  function finalizeMergeCard(ctx, failed) {
    const body = ctx.mergeBody, status = ctx.mergeStatus;
    body.classList.remove('streaming');
    body.classList.add('md');
    body.innerHTML = MM.md.render(ctx.mergeMsg.content || '（空）');
    // 失败/已停止时保留失败标记，不能被覆盖成完成状态；
    // 综合请求的 token 用量一并显示（用量存在 mergeMsg 上，会随版本快照一起保留）
    const mu = ctx.mergeMsg.usage;
    if (failed) status.innerHTML = '<span style="color:var(--danger)">✗ 失败</span>' + usageBadge(mu);
    else status.innerHTML = (ctx.mergeMsg.mode === 'model' ? '✓ 完成' : '✓ 已合并') + usageBadge(mu);
    // 恢复工具栏（综合回答入口随 am.merge 状态更新）
    const wrap = U.$('#messages');
    const grid = byRound('.answers', ctx.roundId, wrap);
    const mergeEl = byRound('.merge-card', ctx.roundId, wrap);
    const oldTools = byRound('.round-tools', ctx.roundId, wrap);
    if (oldTools) oldTools.remove();
    // 与 renderAll 的顺序保持一致：回答网格 → 综合卡片 → 工具栏
    const anchor = mergeEl || grid;
    if (anchor && ctx.am) anchor.after(roundTools(ctx.am));
  }

  // ---------- 滚动：贴底检测 + 智能跟随 ----------
  // stickBottom 由滚动事件维护：流式期间不再每帧读 scrollHeight（读布局会强制同步重排）
  let stickBottom = true;
  function scrollBottom(force) {
    const w = U.$('#messages');
    if (force) stickBottom = true;
    if (stickBottom) w.scrollTop = 1e9; // 超大值由浏览器夹紧到最大位置，避免读 scrollHeight
  }

  // 流式渲染按帧合帧：同一帧内所有卡片只写一次 DOM、只做一次滚动
  // （scrollHeight/scrollTop 读取会强制重排，4 模型并发时每秒可达数十次 delta）
  let paintQueue = [];
  let paintRaf = 0;
  function scheduleStreamPaint(el, paint) {
    el._paint = paint; // 同一元素一帧内只保留最后一次（最新的完整文本）
    if (el._paintQueued) return;
    el._paintQueued = true;
    paintQueue.push(el);
    if (paintRaf) return;
    paintRaf = requestAnimationFrame(function () {
      paintRaf = 0;
      const q = paintQueue;
      paintQueue = [];
      for (const node of q) {
        node._paintQueued = false;
        const fn = node._paint;
        node._paint = null;
        if (fn) fn();
      }
      scrollBottom(); // 整帧只滚动一次
    });
  }

  function autoResize() {
    const ta = U.$('#input');
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 200) + 'px';
    const btn = U.$('#btn-send');
    const wasReady = btn.classList.contains('ready');
    const ready = btn.classList.contains('stop') || ta.value.trim().length > 0 || pendingAttach.some(a => !a.failed);
    btn.classList.toggle('ready', ready);
    // 从"空"到"有内容"的瞬间脉冲一次提示可发送
    if (ready && !wasReady) {
      btn.classList.remove('pulse');
      void btn.offsetWidth;
      btn.classList.add('pulse');
    }
  }

  // ---------- 绑定 ----------
  function bind() {
    // 会话提示词面板：展开 / 收起 / 清除；内容随输入写入当前会话并防抖落盘
    const spBtn = U.$('#btn-session-prompt');
    const spBox = U.$('#session-prompt-box');
    const spTa = U.$('#session-prompt');
    if (spBtn && spBox && spTa) {
      spBtn.addEventListener('click', function () { togglePromptBox(); });
      U.$('#btn-sp-close').addEventListener('click', function () { togglePromptBox(false); });
      U.$('#btn-sp-clear').addEventListener('click', function () {
        const s = MM.sessions.current();
        if (s) { delete s.systemPrompt; MM.save(); }
        spTa.value = '';
        refreshPromptBadge();
        U.toast('已清除本会话提示词');
      });
      // 输入即写入会话对象：面板可能被直接关掉，不点保存也不会丢
      spTa.addEventListener('input', function () {
        const s = MM.sessions.current();
        if (!s) return;
        const v = spTa.value.trim();
        if (v) s.systemPrompt = spTa.value; else delete s.systemPrompt;
        saveSoonPrompt();
        refreshPromptBadge();
      });
    }

    U.$('#btn-new-chat').addEventListener('click', function () {
      if (streamingHere()) stopAll();
      MM.sessions.create();
      renderAll();
      renderTitle();
      U.$('#input').focus();
    });
    // 发送/停止共用一个按钮：再次点击 = 停止当前会话的生成
    U.$('#btn-send').addEventListener('click', function () {
      if (streamingHere()) stopAll(); else send();
    });
    U.$('#input').addEventListener('input', autoResize);
    // 「+」按钮：原生文件选择框加附件
    const attBtn = U.$('#btn-attach');
    if (attBtn) attBtn.addEventListener('click', pickAttachments);
    // 「+」按钮：主进程弹原生文件选择框并读回内容，这里转成 File 对象走同一条附件处理链
  // （图片压缩/OCR、文档提取、数量与大小上限全部复用）
  async function pickAttachments() {
    let r;
    try {
      r = await api.pickFiles();
    } catch (e) {
      U.toast('选择文件失败：' + ((e && e.message) || e), true);
      return;
    }
    if (!r) return; // 用户取消了选择框
    for (const name of (r.tooLarge || [])) U.toast('「' + name + '」超过大小上限，已跳过', true);
    for (const f of (r.files || [])) {
      const bin = atob(f.base64);
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      await addDroppedFile(new File([arr], f.name || '附件', { type: f.mime || '' }));
    }
    const inp = U.$('#input');
    if (inp) inp.focus();
  }

  // ---------- 附件：粘贴图片 ----------
    // 只拦截文件型剪贴板内容（截图工具、复制的图片文件）；纯文本粘贴走默认行为
    U.$('#input').addEventListener('paste', function (e) {
      const items = (e.clipboardData && e.clipboardData.items) || [];
      const files = [];
      for (const it of items) {
        if (it && it.kind === 'file') {
          const f = it.getAsFile();
          if (f) files.push(f);
        }
      }
      if (!files.length) return;
      e.preventDefault();
      for (const f of files) addImageBlob(f);
    });
    // ---------- 附件：拖拽到主区（消息区+输入区都算，防止拖偏触发浏览器打开文件） ----------
    const dropZone = U.$('#main');
    let dragDepth = 0;
    dropZone.addEventListener('dragenter', function (e) {
      e.preventDefault();
      dragDepth++;
      dropZone.classList.add('dragging');
    });
    dropZone.addEventListener('dragover', function (e) { e.preventDefault(); });
    dropZone.addEventListener('dragleave', function () {
      if (--dragDepth <= 0) { dragDepth = 0; dropZone.classList.remove('dragging'); }
    });
    dropZone.addEventListener('drop', function (e) {
      e.preventDefault();
      dragDepth = 0;
      dropZone.classList.remove('dragging');
      const files = (e.dataTransfer && e.dataTransfer.files) || [];
      for (const f of Array.from(files)) addDroppedFile(f);
    });
    // 附件预览浮层：按钮/遮罩关闭，Esc 兜底
    const avClose = U.$('#av-close');
    if (avClose) avClose.addEventListener('click', closeAttachView);
    const av = U.$('#attach-view');
    if (av) av.addEventListener('click', function (e) { if (e.target === av) closeAttachView(); });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && av && !av.classList.contains('hidden')) { e.stopPropagation(); closeAttachView(); }
    });
    // ---------- 导出整个会话 ----------
    const exBtn = U.$('#btn-export-session');
    if (exBtn) exBtn.addEventListener('click', exportSession);
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
      // 加临时类播放颜色过渡，结束后移除（避免常驻 transition 干扰元素自身的 hover 过渡）
      document.documentElement.classList.add('theme-anim');
      document.documentElement.setAttribute('data-theme', next);
      setTimeout(function () { document.documentElement.classList.remove('theme-anim'); }, 280);
      try { localStorage.setItem('mmc-theme', next); } catch (e) { }
    });
    U.$('#tgl-auto').addEventListener('change', function () {
      MM.state.config.synthesis.autoMerge = this.checked;
      MM.save({ configOnly: true }); // 只改了 config，不需要复制整份会话历史
    });
    // 顶栏开关胶囊的高亮态跟随复选框（开启时文字变 accent 色，一眼可辨）
    for (const id of ['#tgl-search', '#tgl-auto']) {
      const input = U.$(id);
      const sync = function () { input.closest('.toggle').classList.toggle('on', input.checked); };
      input.addEventListener('change', sync);
      sync();
    }
    // 回到底部悬浮按钮：离开底部较远时出现
    const wrap = U.$('#messages');
    const sb = U.$('#btn-scroll-bottom');
    wrap.addEventListener('scroll', function () {
      const gap = wrap.scrollHeight - wrap.scrollTop - wrap.clientHeight;
      sb.classList.toggle('show', gap > 240);
      stickBottom = gap < 140; // 用户滚回底部后恢复自动跟随
    }, { passive: true });
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

  MM.chat = {
    send, renderAll, renderChips, renderTitle, bind, stopSession, refreshPromptBadge, stopAll,
    // 会话列表用：该会话是否正在后台生成（呼吸点标记）
    isStreamingSession: function (id) { return !!streaming && streaming === id; },
    // 给 smoke 测试用的出口，不影响线上逻辑
    _buildHistoryForTest: buildHistory,
    _statusHtmlForTest: statusHtml,
    _roundToMarkdownForTest: roundToMarkdown,
    _sessionToMarkdownForTest: sessionToMarkdown,
    _modelSkippedForTest: modelSkippedForRound,
    _deleteRoundForTest: deleteRound,
    _retryOneForTest: retryOne,
    _handleEventForTest: handleEvent,
    // 最近一次挂载的请求上下文概要（验证重试后节点缓存是否指向活跃 DOM）
    _pendingForTest: function () {
      const entry = Array.from(pending.entries()).pop();
      if (!entry) return null;
      const last = entry[1];
      return {
        requestId: entry[0],
        singleRetry: !!last.singleRetry,
        hasGrid: !!last.grid,
        cardIds: last.cards ? Array.from(last.cards.keys()) : [],
        bodyConnected: !!(last.cards && Array.from(last.cards.values()).every(r => r.body && r.body.isConnected))
      };
    }
  };
})();
