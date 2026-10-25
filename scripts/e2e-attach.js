'use strict';
// 端到端测试：图片/文档附件（真实 main.js + 本地 mock 模型服务）。
// 覆盖：图片落盘+mmimg 协议、粘贴后芯片状态、多模态路由（原图 vs OCR 文字）、
//       后续轮占位不重发原图、纯文本模型跳过、拖入 txt 进上下文、整会话导出结构。
const { app, BrowserWindow, dialog } = require('electron');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'mmc-attach-'));
const PORT = 19321; // 固定端口：store.json 必须在 require main.js 之前写好（协议注册要求 app ready 之前）
app.setPath('userData', DATA);

const sleep = ms => new Promise(r => setTimeout(r, ms));
const rows = [];
async function run(name, fn) {
  try {
    const detail = await fn();
    rows.push({ name, pass: true, detail: detail === undefined ? '' : String(detail) });
    console.log('PASS | ' + name + ' | ' + (detail === undefined ? '' : detail));
  } catch (e) {
    rows.push({ name, pass: false, detail: e && e.message });
    console.log('FAIL | ' + name + ' | ' + (e && e.message));
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

// ---------------- mock 模型服务 ----------------
const requests = [];
const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', c => { raw += c; });
  req.on('end', () => {
    let body = {};
    try { body = JSON.parse(raw || '{}'); } catch (e) { /* ignore */ }
    requests.push({ url: req.url, body });
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: '回答-' + String(body.model || '') } }] }) + '\n\n');
    res.write('data: ' + JSON.stringify({ choices: [{ delta: {} }], usage: { prompt_tokens: 12, completion_tokens: 5 } }) + '\n\n');
    res.write('data: [DONE]\n\n');
    res.end();
  });
});

// 1x1 透明 PNG（粘贴用）
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const TXT_BODY = '这是拖入文档的第一行\n这是第二行，包含关键词MMC-DOC-MARK';

function seedConfig() {
  return {
    providers: [
      {
        id: 'p1', name: '本地', provider: 'custom', apiFormat: 'openai',
        baseUrl: 'http://127.0.0.1:' + PORT + '/v1', apiKey: 'k1', fullUrl: false, preset: false,
        models: [
          { modelId: 'mv', name: '多模态模型', enabled: true, contextTokens: 100000, maxTokens: 4096, multimodal: true },
          { modelId: 'mt', name: '纯文本模型', enabled: true, contextTokens: 100000, maxTokens: 4096, multimodal: false }
        ]
      }
    ],
    search: { provider: 'none' },
    synthesis: { synthSource: 'frontend', autoMerge: false },
    presetVersion: 4 // 跳过预置服务商迁移，只测本配置里的两个模型
  };
}

async function main() {
  fs.writeFileSync(path.join(DATA, 'store.json'),
    JSON.stringify({ config: seedConfig(), sessions: [{ id: 's0', title: '新会话', createdAt: 1, updatedAt: 1, pinned: false, messages: [] }] }),
    'utf8');
  require(path.join(ROOT, 'src', 'main', 'main.js')); // 顶层同步 require：协议注册先于 app ready
  await new Promise(r => server.listen(PORT, '127.0.0.1', r));

  await app.whenReady();
  await sleep(1600);
  const w = BrowserWindow.getAllWindows()[0];
  if (!w) { console.log('FAIL | 窗口未创建'); app.exit(1); return; }
  const js = code => w.webContents.executeJavaScript(code, true);
  async function waitFor(expr, timeout) {
    const t0 = Date.now();
    while (Date.now() - t0 < (timeout || 15000)) {
      if (await js(expr)) return true;
      await sleep(120);
    }
    return false;
  }
  async function setChips(ids) {
    await js(`(function(){
      var want = ${JSON.stringify(ids)};
      document.querySelectorAll('#model-chips .chip').forEach(function(c){
        c.classList.toggle('on', want.indexOf(c.getAttribute('data-model-id')) >= 0);
      });
    })()`);
  }
  async function pastePNG() {
    await js(`(function(){
      var bin = atob(${JSON.stringify(PNG_B64)});
      var arr = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      var f = new File([arr], '截图.png', { type: 'image/png' });
      var dt = new DataTransfer(); dt.items.add(f);
      document.querySelector('#input').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    })()`);
    // 等附件处理完（OCR 完成后状态不再是「…」）
    return waitFor(`(function(){
      var chips = document.querySelectorAll('#attach-bar .att-chip');
      if (chips.length !== 1) return false;
      var st = chips[0].querySelector('.att-status');
      return st && st.textContent.indexOf('…') < 0;
    })()`, 40000);
  }
  async function sendText(text) {
    await js(`(function(){
      var i = document.querySelector('#input');
      i.value = ${JSON.stringify(text)};
      i.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#btn-send').click();
    })()`);
  }
  const doneExpr = "document.querySelectorAll('.answer-card').length > 0 && !document.querySelector('#btn-send').classList.contains('stop')";
  function reqsFor(modelId) { return requests.filter(r => r.body && r.body.model === modelId); }
  function wire(r) { return JSON.stringify(r ? r.body : {}); }

  // ---------- 1. 启动 ----------
  await run('启动：无错误遮罩，芯片两个', async () => {
    const t = await js(`({ fatal: !!document.getElementById('fatal-error'),
      chips: document.querySelectorAll('#model-chips .chip').length })`);
    assert(!t.fatal && t.chips === 2, JSON.stringify(t));
    return 'chips=2';
  });

  // ---------- 2. saveImage + mmimg 协议 ----------
  await run('saveImage 落盘且 mmimg 协议可读', async () => {
    const r = await js(`api.saveImage({ name: 't.png', mime: 'image/png', base64: ${JSON.stringify(PNG_B64)} })`);
    assert(r && /^[a-f0-9]+$/.test(r.id) && r.ext === 'png', JSON.stringify(r));
    const f = path.join(DATA, 'images', r.id + '.png');
    assert(fs.existsSync(f), '图片文件不存在');
    // 非法 id/ext 必须拒绝（路径穿越防护）
    const bad = await js(`(async function(){
      try { await api.saveImage({ name: 'x', mime: 'image/gif', base64: 'aGk=' }); return 'accepted'; }
      catch (e) { return 'rejected'; }
    })()`);
    assert(bad === 'rejected', 'gif 应被拒绝: ' + bad);
    const loaded = await js(`(function(){
      return new Promise(function(res){
        var img = new Image();
        img.onload = function(){ res({ ok: img.naturalWidth >= 0, w: img.naturalWidth }); };
        img.onerror = function(){ res({ ok: false }); };
        img.src = 'mmimg://${r.id}.png';
        setTimeout(function(){ res({ ok: img.naturalWidth >= 0 }); }, 3000);
      });
    })()`);
    assert(loaded && loaded.ok, JSON.stringify(loaded));
    return 'id=' + r.id.slice(0, 6) + '… img加载=' + loaded.ok;
  });

  // ---------- 3. 粘贴图片：芯片与无视觉提示 ----------
  await run('粘贴图片：缩略图芯片出现，纯文本芯片加 no-vision 提示', async () => {
    assert(await pastePNG(), '附件芯片未在 40s 内就绪');
    const t = await js(`({
      thumb: !!document.querySelector('#attach-bar .att-thumb'),
      src: (document.querySelector('#attach-bar .att-thumb') || {}).src || '',
      failed: !!document.querySelector('#attach-bar .att-chip.failed'),
      noVision: [].slice.call(document.querySelectorAll('#model-chips .chip')).filter(function(c){ return c.classList.contains('no-vision'); }).length
    })`);
    assert(t.thumb && !t.failed, JSON.stringify(t));
    assert(t.src.indexOf('mmimg://') === 0, '缩略图应走 mmimg 协议: ' + t.src);
    assert(t.noVision === 1, '应有 1 个纯文本芯片带提示: ' + JSON.stringify(t));
    return 'src=' + t.src.slice(0, 20);
  });

  // ---------- 4. 图+文发送：多模态收原图，纯文本收文字 ----------
  await run('发送：多模态模型请求含原图，纯文本模型不含', async () => {
    await setChips(['p1::mv', 'p1::mt']);
    await sendText('这张图里有什么？');
    assert(await waitFor(doneExpr, 15000), '未完成');
    const mv = reqsFor('mv'), mt = reqsFor('mt');
    assert(mv.length === 1 && mt.length === 1, '每个模型应各有一次请求');
    assert(wire(mv[0]).indexOf('data:image/png;base64,') >= 0, '多模态请求应含原图 base64');
    assert(wire(mv[0]).indexOf('这张图里有什么') >= 0, '多模态请求应含提问文字');
    assert(wire(mt[0]).indexOf('data:image') < 0, '纯文本请求不应含图片');
    assert(wire(mt[0]).indexOf('这张图里有什么') >= 0, '纯文本请求应含提问文字');
    const bubble = await js(`({
      thumbs: document.querySelectorAll('.user-msg .msg-thumb').length,
      src: (document.querySelector('.user-msg .msg-thumb') || {}).src || ''
    })`);
    assert(bubble.thumbs === 1 && bubble.src.indexOf('mmimg://') === 0, JSON.stringify(bubble));
    return '双路由 OK';
  });

  // ---------- 5. 追问：历史占位不重发原图 ----------
  await run('追问：历史中的图片变为文字占位，不重发原图', async () => {
    await sendText('再补充一点细节');
    assert(await waitFor("(document.querySelectorAll('.answer-card').length >= 4 && !document.querySelector('#btn-send').classList.contains('stop'))", 15000), '第二轮未完成');
    const mv2 = reqsFor('mv');
    assert(mv2.length === 2, '多模态应有第二轮请求');
    const w2 = wire(mv2[1]);
    assert(w2.indexOf('data:image') < 0, '第二轮不应再发原图');
    assert(w2.indexOf('[图片 截图.png]') >= 0, '第二轮历史应含图片占位');
    assert(w2.indexOf('再补充一点细节') >= 0, '第二轮应含新提问');
    return '占位 OK';
  });

  // ---------- 6. 图片预览浮层 ----------
  await run('图片预览浮层打开与 Esc 关闭', async () => {
    await js(`document.querySelector('.user-msg .msg-thumb').click()`);
    await sleep(150);
    let open = await js(`!document.querySelector('#attach-view').classList.contains('hidden') && !!document.querySelector('#attach-view .av-img')`);
    assert(open, '浮层未打开');
    await js(`document.querySelector('#av-close').click()`);
    await sleep(120);
    open = await js(`document.querySelector('#attach-view').classList.contains('hidden')`);
    assert(open, '浮层未关闭');
    return 'OK';
  });

  // ---------- 7. 纯图 + 纯文本模型：跳过 ----------
  await run('纯图无文字且模型不支持图片：卡片跳过', async () => {
    await js(`MM.chat.stopAll(); document.querySelector('#btn-new-chat').click()`);
    await sleep(200);
    await setChips(['p1::mt']);
    assert(await pastePNG(), '粘贴未就绪');
    const mtBefore = requests.filter(r => r.body && r.body.model === 'mt').length;
    await sendText('');
    assert(await waitFor(`document.querySelectorAll('.answer-card').length === 1 && !document.querySelector('#btn-send').classList.contains('stop')`, 10000), '未完成');
    const t = await js(`({
      status: MM.sessions.current().messages[1].results[0].status,
      skipped: !!document.querySelector('.answer-card .ac-skipped'),
      badge: document.querySelector('.answer-card .ac-status').textContent
    })`);
    assert(t.status === 'skipped' && t.skipped && t.badge.indexOf('已跳过') >= 0, JSON.stringify(t));
    const mtAfter = requests.filter(r => r.body && r.body.model === 'mt').length;
    assert(mtAfter === mtBefore, '不应发起模型请求');
    return '跳过 OK';
  });

  // ---------- 8. 拖入 txt：全文进上下文 ----------
  await run('拖入 txt：附件芯片出现，发送后全文进入两个模型上下文', async () => {
    await js(`MM.chat.stopAll(); document.querySelector('#btn-new-chat').click()`);
    await sleep(200);
    await setChips(['p1::mv', 'p1::mt']);
    await js(`(function(){
      var f = new File([${JSON.stringify(TXT_BODY)}], '笔记.txt', { type: 'text/plain' });
      var dt = new DataTransfer(); dt.items.add(f);
      document.querySelector('#main').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    })()`);
    assert(await waitFor(`(function(){
      var chips = document.querySelectorAll('#attach-bar .att-chip');
      if (chips.length !== 1) return false;
      var st = chips[0].querySelector('.att-status');
      return st && st.textContent.indexOf('…') < 0;
    })()`, 10000), '文档芯片未就绪');
    const chip = await js(`({ name: document.querySelector('#attach-bar .att-name').textContent,
      status: document.querySelector('#attach-bar .att-status').textContent })`);
    assert(chip.name === '笔记.txt' && chip.status.indexOf('字') >= 0, JSON.stringify(chip));
    await sendText('总结这份笔记');
    assert(await waitFor(doneExpr, 15000), '未完成');
    const before = reqsFor('mv').length;
    const mv = reqsFor('mv')[before - 1];
    assert(wire(mv).indexOf('MMC-DOC-MARK') >= 0, '多模态请求应含文档全文');
    const beforeT = reqsFor('mt').length;
    const mt = reqsFor('mt')[beforeT - 1];
    assert(wire(mt).indexOf('MMC-DOC-MARK') >= 0, '纯文本请求应含文档全文');
    const bubble = await js(`document.querySelectorAll('.user-msg .msg-file').length`);
    assert(bubble === 1, '气泡里应有文档芯片');
    return '全文路由 OK';
  });

  // ---------- 9. 整会话导出结构 ----------
  await run('整会话导出 Markdown：结构完整（提问/各模型/附件说明/附录）', async () => {
    const md = await js(`(function(){
      var s = MM.sessions.current();
      return MM.chat._sessionToMarkdownForTest(s);
    })()`);
    assert(md.indexOf('# 总结这份笔记') === 0, '应有会话标题: ' + md.slice(0, 40));
    assert(md.indexOf('## 提问 1：总结这份笔记') >= 0, '应含提问标题');
    assert(md.indexOf('### 多模态模型') >= 0 && md.indexOf('### 纯文本模型') >= 0, '应含各模型回答');
    assert(md.indexOf('*[文档 笔记.txt') >= 0, '应含文档说明');
    assert(md.indexOf('## 附录1：附件「笔记.txt」全文') >= 0 && md.indexOf('MMC-DOC-MARK') >= 0, '应含附录全文');
    // 图片会话：图片说明 + 轮次导出附件行
    const imgMd = await js(`(function(){
      var s = MM.state.sessions.filter(function(x){ return (x.messages || []).some(function(m){ return m.images && m.images.length; }); })[0];
      if (!s) return null;
      var am = s.messages.filter(function(m){ return m.role === 'assistant'; })[0];
      var round = MM.chat._roundToMarkdownForTest(am, s, s.messages[0]);
      return { session: MM.chat._sessionToMarkdownForTest(s), round: round };
    })()`);
    assert(imgMd, '未找到含图片的会话');
    assert(imgMd.session.indexOf('*[图片 截图.png') >= 0, '会话导出应含图片说明');
    assert(imgMd.round.indexOf('**提问附件**') >= 0 && imgMd.round.indexOf('图片 截图.png') >= 0, '轮次导出应含附件说明');
    return '导出结构 OK';
  });

  // ---------- 10. 导入导出兜底：无 images 字段的旧会话不报错 ----------
  await run('旧会话（无附件字段）渲染与检索不受影响', async () => {
    const t = await js(`(function(){
      var s = MM.sessions.current();
      s.messages.unshift({ id: 'old-u', role: 'user', content: '旧消息', createdAt: 1 },
        { id: 'old-a', role: 'assistant', roundId: 'old-r', createdAt: 1, active: 0, versions: [],
          results: [{ modelId: 'p1::mt', name: '纯文本模型', status: 'done', content: '旧回答' }] });
      MM.chat.renderAll();
      MM.sessions._setFilterForTest('旧回答');
      MM.sessions.render();
      var hit = document.querySelectorAll('#session-list .session-item').length;
      MM.sessions.clearFilter(); MM.sessions.render();
      return { cards: document.querySelectorAll('.answer-card').length, hit: hit };
    })()`);
    assert(t.cards >= 3 && t.hit >= 1, JSON.stringify(t));
    return '兼容 OK';
  });

  // ---------- 11. 「+」按钮：文件选择框加附件 ----------
  await run('「+」按钮：选中的文件进入附件链与上下文', async () => {
    const pickPath = path.join(DATA, 'picked-note.txt');
    fs.writeFileSync(pickPath, 'PICKED-BY-PLUS-BUTTON-CONTENT', 'utf8');
    const orig = dialog.showOpenDialog;
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [pickPath] });
    try {
      await js(`MM.chat.stopAll(); document.querySelector('#btn-new-chat').click()`);
      await sleep(200);
      await setChips(['p1::mv']);
      const clicked = await js(`(function(){ var b = document.querySelector('#btn-attach'); if (!b) return false; b.click(); return true; })()`);
      assert(clicked, '找不到 #btn-attach 按钮');
      assert(await waitFor(`(function(){
        var chips = document.querySelectorAll('#attach-bar .att-chip');
        if (chips.length !== 1) return false;
        var st = chips[0].querySelector('.att-status');
        return st && st.textContent.indexOf('…') < 0;
      })()`, 10000), '附件芯片未就绪');
      const chip = await js(`document.querySelector('#attach-bar .att-name').textContent`);
      assert(chip === 'picked-note.txt', '文件名不符: ' + chip);
      await sendText('看看这个文件');
      assert(await waitFor(doneExpr, 15000), '未完成');
      const mv = requests.filter(r => r.body && r.body.model === 'mv').pop();
      assert(wire(mv).indexOf('PICKED-BY-PLUS-BUTTON-CONTENT') >= 0, '文件内容应进上下文');
      // 取消选择框：不应出现附件
      dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
      await js(`document.querySelector('#btn-attach').click()`);
      await sleep(300);
      const n = await js(`document.querySelectorAll('#attach-bar .att-chip').length`);
      assert(n === 0, '取消后不应有附件: ' + n);
      return 'OK';
    } finally {
      dialog.showOpenDialog = orig;
    }
  });

  server.close();
  const fail = rows.filter(r => !r.pass).length;
  console.log('\n== 附件 e2e：' + (rows.length - fail) + '/' + rows.length + ' 通过 ==');
  app.exit(fail ? 1 : 0);
}

main().catch(e => { console.error('测试脚本异常：', e); app.exit(1); });
