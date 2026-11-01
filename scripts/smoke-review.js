'use strict';
// 交叉审查回归：手动审查（互审→仲裁）/ 互审全停不进仲裁 / 重试接力 / 不足两份拦截 / 开关自动审查
// 真实 main.js + 真实 IPC + 本地 mock 模型；store 写入临时 userData，不碰真实数据。
// 用法：npx electron scripts/smoke-review.js
const { app, BrowserWindow, dialog } = require('electron');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
function check(label, ok, detail) {
  if (ok) { pass++; console.log('  PASS ' + label); }
  else { fail++; console.log('  FAIL ' + label + (detail ? ' -> ' + detail : '')); }
}

// ---- mock 模型服务器：按提示词特征分类（回答/互审/仲裁），按 model 区分审查员 ----
const ANSWER_MARK = 'ANSWER-' , REVIEW_MARK = 'REVIEW-FINDING-', VERDICT_MARK = 'VERDICT-OK-';
const cnt = { answer: 0, review: 0, verdict: 0 };
const reviewSeen = []; // 收到的互审请求 body.model 顺序
// 每个模型的第一次互审请求延迟 2600ms：场景 A 里用户在它完成前点停止
const reviewReqCount = {};
const server = http.createServer((req, res) => {
  console.log('[mock ' + Date.now() % 100000 + '] ' + req.method + ' ' + req.url);
  if (req.url.indexOf('/models') >= 0) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'm1' }, { id: 'm2' }, { id: 'm3' }] }));
    return;
  }
  let raw = '';
  req.on('data', c => { raw += c; });
  req.on('end', () => {
    let body = {};
    try { body = JSON.parse(raw); } catch (e) { /* 忽略 */ }
    const prompt = (body.messages || []).map(m => m.content || '').join('\n');
    const model = String(body.model || '');
    let kind = 'answer', delay = 60, text = ANSWER_MARK + model;
    if (prompt.indexOf('你是严格的审稿人') >= 0) {
      kind = 'review'; text = REVIEW_MARK + model;
      const n = reviewReqCount[model] = (reviewReqCount[model] || 0) + 1;
      delay = n === 1 ? 2600 : 100; // 首次（场景 A）慢，重试/自动轮快
      cnt.review++; reviewSeen.push(model);
    } else if (prompt.indexOf('你是仲裁人') >= 0) {
      kind = 'verdict'; text = VERDICT_MARK + '最终结论在这里'; delay = 80;
      cnt.verdict++;
    } else {
      cnt.answer++;
    }
    const usage = { prompt_tokens: 100 + cnt[kind === 'verdict' ? 'verdict' : kind] , completion_tokens: 50 };
    setTimeout(() => {
      try {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: text } }] }) + '\n\n');
        res.write('data: ' + JSON.stringify({ choices: [], usage: usage }) + '\n\n');
        res.end('data: [DONE]\n\n');
      } catch (e) { /* 客户端已中止：写死管道是正常路径，吞掉 */ }
    }, delay);
  });
});

server.listen(0, '127.0.0.1', () => {
  const port = server.address().port;
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'mmc-rev-'));
  app.setPath('userData', DATA);
  dialog.showMessageBox = async () => ({ response: 0 });
  dialog.showMessageBoxSync = () => 0;
  dialog.showErrorBox = () => {};
  const now = Date.now();
  fs.writeFileSync(path.join(DATA, 'store.json'), JSON.stringify({
    config: {
      providers: [{
        id: 'p1', name: '演示服务商', provider: 'custom', apiFormat: 'openai',
        baseUrl: 'http://127.0.0.1:' + port + '/v1', apiKey: 'k1', fullUrl: false, preset: false,
        models: [
          { modelId: 'm1', name: '模型一', enabled: true, contextTokens: 100000, maxTokens: 4096 },
          { modelId: 'm2', name: '模型二', enabled: true, contextTokens: 100000, maxTokens: 4096 },
          { modelId: 'm3', name: '模型三', enabled: true, contextTokens: 100000, maxTokens: 4096 }
        ]
      }],
      search: { provider: 'none' },
      synthesis: { synthSource: 'frontend', autoMerge: false, crossReview: false },
      systemPrompt: ''
    },
    sessions: [
      { id: 's0', title: '种子会话', createdAt: now, updatedAt: now, pinned: false, messages: [] }
    ]
  }, null, 1), 'utf8');

  // main.js 必须在 app ready 之前加载：registerScheme() 要求 ready 前注册
  require(path.join(ROOT, 'src', 'main', 'main.js'));

  app.whenReady().then(async () => {
    const app0 = app;
    async function run() {
      await sleep(2200); // 等 store 初始化 + 窗口 + 渲染层 init
      const w = BrowserWindow.getAllWindows()[0];
      if (!w) throw new Error('窗口未创建');
      const js = c => w.webContents.executeJavaScript(c, true);
      const poll = async (expr, ms) => {
        const t0 = Date.now();
        for (;;) {
          const v = await js(expr);
          if (v) return v;
          if (Date.now() - t0 > (ms || 8000)) return null;
          await sleep(150);
        }
      };
      const clickBtn = async (expr) => { await js(expr); await sleep(120); };

      // 新会话：等芯片目录就绪 → 清空默认全选 → 只选 p1 的三个 mock 模型
      await js("document.querySelector('#btn-new-chat').click()");
      await sleep(250);
      await poll("document.querySelectorAll('#model-chips .chip').length >= 10", 8000);
      await js("[].forEach.call(document.querySelectorAll('#model-chips .chip.on'), function(c){ c.click(); })");
      await sleep(150);
      await js("[].forEach.call(document.querySelectorAll('#model-chips .chip'), function(c){ if (String(c.getAttribute('data-model-id')).indexOf('p1::') === 0) c.click(); })");
      await sleep(200);
      const onN = await js("document.querySelectorAll('#model-chips .chip.on').length");
      check('初始选中 3 个模型', onN === 3, 'on=' + onN);

      const send = async (text) => {
        await js("var i=document.querySelector('#input'); i.value=" + JSON.stringify(text) + "; i.dispatchEvent(new Event('input',{bubbles:true}));");
        await js("document.querySelector('#btn-send').click()");
      };

      // ===== 场景 A：互审进行中全部停止（无一份完成）→ 不进仲裁，卡片已停止，出重试 =====
      await send('第一轮：三模型回答');
      const okA = await poll("!document.querySelector('#btn-send').classList.contains('stop') && document.querySelectorAll('.answer-card').length >= 3", 12000);
      check('场景 A：三个回答完成', !!okA, '');
      const reviewBtn = async () => poll("(function(){var b=[].filter.call(document.querySelectorAll('.round-tools .tool-btn'),function(x){return x.textContent.indexOf('交叉审查')>=0;});return b.length?(b[b.length-1].click(),true):false;})()", 3000);
      check('场景 A：交叉审查入口可见', !!(await reviewBtn()), '');
      await poll("(function(){var c=document.querySelector('.review-card');return !!c;})()", 3000);
      await sleep(800); // 等互审请求真正派发到服务器（停止早于派发会测不到中止语义）；2600ms 延迟保证仍无一份完成
      await clickBtn("document.querySelector('#btn-send').click()"); // 互审刚开始就停止
      const stoppedA = await poll("document.querySelector('.review-card .ac-head .ac-status') && document.querySelector('.review-card .ac-head .ac-status').textContent.indexOf('已停止')>=0", 6000);
      check('场景 A：互审全停后卡片标已停止', !!stoppedA, '');
      await sleep(400); // 等可能迟到的仲裁（不应有）
      check('场景 A：未进入仲裁（0 次仲裁请求）', cnt.verdict === 0, 'verdict=' + cnt.verdict);
      check('场景 A：审查卡片有重试按钮', !!(await js("!!document.querySelector('.review-card .ac-retry')")), '');
      check('场景 A：无完成的审查条目（全部空内容）', cnt.review === 3, 'review=' + cnt.review);

      // ===== 场景 B：重试 → 互审全成 → 仲裁 → 完成（含用量）=====
      await js("document.querySelector('.review-card .ac-retry').click()");
      const doneB = await poll("(function(){var s=document.querySelector('.review-card .ac-head .ac-status');var b=document.querySelector('.rv-verdict-body');return !!(s&&s.textContent.indexOf('完成')>=0&&b&&b.textContent.indexOf('VERDICT-OK')>=0);})()", 15000);
      check('场景 B：重试走完互审+仲裁，卡片显示完成', !!doneB, '');
      check('场景 B：三个审查条目都渲染', (await js("document.querySelectorAll('.review-card .rv-item').length")) === 3, '');
      const names = await js("[].map.call(document.querySelectorAll('.review-card .rv-item-name'), function(e){return e.textContent;}).join(',')");
      check('场景 B：审查条目带模型名', names.indexOf('模型一') >= 0 && names.indexOf('模型二') >= 0 && names.indexOf('模型三') >= 0, names);
      const stTxt = (await js("(function(){var s=document.querySelector('.review-card .ac-head .ac-status');return s?s.textContent:'';})()")) || '';
      check('场景 B：卡片带 token 用量标记（徽标曾因 reviewUsage 返回数字而永不显示）', /tok/i.test(stTxt), 'head=[' + stTxt + ']');
      // Markdown 终态：条目与仲裁正文必须是渲染后的 HTML（曾因终态不落 Markdown / RAF 竞态覆盖而输出裸文本）
      const iHtml = (await js("(function(){var b=document.querySelector('.rv-item-body');return b?b.innerHTML:'';})()")) || '';
      const vHtml = (await js("(function(){var b=document.querySelector('.rv-verdict-body');return b?b.innerHTML:'';})()")) || '';
      check('场景 B：审查条目正文渲染为 Markdown（终态不落 md 曾必现裸 ## 文本）', iHtml.indexOf('<h2>') === 0 || /<(p|li|h\d)[ >]/.test(iHtml), 'html=[' + iHtml.slice(0, 60) + ']');
      check('场景 B：仲裁结论正文渲染为 Markdown（RAF 竞态曾覆盖回裸文本）', /<(p|li|h\d)[ >]/.test(vHtml), 'html=[' + vHtml.slice(0, 60) + ']');
      check('场景 B：互审 6 次（A 轮 3 次 + 本轮 3 次）、仲裁 1 次', cnt.review === 6 && cnt.verdict === 1, 'review=' + cnt.review + ' verdict=' + cnt.verdict);
      check('场景 B：仲裁提示词包含全部审查发现', reviewSeen.length === 6, 'seen=' + reviewSeen.join(','));

      // ===== 场景 C：只有一份成功回答 → 拦截并提示 =====
      await js("[].forEach.call(document.querySelectorAll('#model-chips .chip.on'), function(c){ c.click(); })");
      await sleep(150);
      await js("(function(){var c=[].filter.call(document.querySelectorAll('#model-chips .chip'),function(x){return x.getAttribute('data-model-id')==='p1::m1';})[0]; if(c) c.click();})()");
      await sleep(150);
      await send('第二轮：单模型回答');
      await poll("!document.querySelector('#btn-send').classList.contains('stop')", 10000);
      check('场景 C：入口可见（有回答的轮）', !!(await reviewBtn()), '');
      await sleep(300);
      const toastC = await js("(function(){var t=document.querySelector('#toast'); return t?t.textContent:'';})()");
      check('场景 C：不足两份回答被拦截提示', toastC.indexOf('至少需要两份成功回答') >= 0, toastC);
      check('场景 C：未发起审查请求', cnt.review === 6, 'review=' + cnt.review);

      // ===== 场景 D：开启交叉审查开关 → 回答完成后自动互审+仲裁 =====
      await js("[].forEach.call(document.querySelectorAll('#model-chips .chip.on'), function(c){ c.click(); })");
      await sleep(150);
      await js("[].forEach.call(document.querySelectorAll('#model-chips .chip'), function(c){ if (String(c.getAttribute('data-model-id')).indexOf('p1::') === 0) c.click(); })");
      await sleep(150);
      await js("document.querySelector('#tgl-review-wrap').click()");
      await sleep(150);
      const preD = await js("document.querySelectorAll('#model-chips .chip.on').length");
      if (preD !== 3) { throw new Error('场景 D 选中模型数异常：' + preD); }
      await send('第三轮：自动交叉审查');
      const doneD = await poll("(function(){var gs=document.querySelectorAll('.answers');if(!gs.length)return false;var rid=gs[gs.length-1].getAttribute('data-round');var cs=document.querySelectorAll('.review-card');var last=cs[cs.length-1];if(!last||last.getAttribute('data-round')!==rid)return false;var s=last.querySelector('.ac-head .ac-status');var b=last.querySelector('.rv-verdict-body');return !!(s&&s.textContent.indexOf('完成')>=0&&b&&b.textContent.indexOf('VERDICT-OK')>=0);})()", 20000);
      check('场景 D：回答完成后自动审查+仲裁完成', !!doneD, '');
      check('场景 D：自动流程互审 3 次、仲裁 1 次', cnt.review === 9 && cnt.verdict === 2, 'review=' + cnt.review + ' verdict=' + cnt.verdict);
      check('场景 D：回答请求共 7 次（3+1+3）', cnt.answer === 7, 'answer=' + cnt.answer);
      // 开关回显：设置状态与胶囊高亮
      const tgl = await js("({on: document.querySelector('#tgl-review').checked, cls: document.querySelector('#tgl-review-wrap').classList.contains('on')})");
      check('场景 D：开关状态与胶囊高亮一致', tgl.on === true && tgl.cls === true, JSON.stringify(tgl));
    }

    run().then(() => {
      console.log('\nRESULT pass=' + pass + ' fail=' + fail);
      server.close();
      app0.exit(fail ? 1 : 0);
    }).catch(e => {
      fail++;
      console.log('  FAIL 测试执行异常 -> ' + (e && e.message));
      console.log('\nRESULT pass=' + pass + ' fail=' + fail);
      server.close();
      app0.exit(1);
    });
  });
});
