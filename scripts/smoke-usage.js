'use strict';
// 用量统计面板回归：派生口径（版本快照/partial 去重/inherited 跳过/前端合并不计/审查记账）
// + 时间范围过滤 + CSV + 真实面板渲染 + 真实发一轮消息验证 providers 的 usage.cached 透传。
// 真实 main.js + 真实 IPC + 本地 mock 模型；store 写入临时 userData，不碰真实数据。
// 用法：npx electron scripts/smoke-usage.js
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
  else { fail++; console.log('  FAIL ' + label + (detail !== undefined ? ' -> ' + JSON.stringify(detail) : '')); }
}

// ---- mock 模型服务器：回答类请求回 usage（含 cached_tokens），供全链路透传验证 ----
let liveUsageSeq = 0;
const server = http.createServer((req, res) => {
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
    const model = String(body.model || '');
    const usage = {
      prompt_tokens: 111,
      completion_tokens: 22,
      prompt_tokens_details: { cached_tokens: 30 }
    };
    setTimeout(() => {
      try {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'ANSWER-' + model } }] }) + '\n\n');
        res.write('data: ' + JSON.stringify({ choices: [], usage: usage, id: 'u' + (++liveUsageSeq) }) + '\n\n');
        res.end('data: [DONE]\n\n');
      } catch (e) { /* 客户端已中止 */ }
    }, 60);
  });
});

server.listen(0, '127.0.0.1', () => {
  const port = server.address().port;
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'mmc-usage-'));
  app.setPath('userData', DATA);
  dialog.showMessageBox = async () => ({ response: 0 });
  dialog.showMessageBoxSync = () => 0;
  dialog.showErrorBox = () => {};
  const now = Date.now();
  const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
  // T1 取"今天 00:01 之后、当前时刻之前"的最近点：跨午夜运行测试也不会掉出"今天"范围
  const T1 = Math.max(midnight.getTime() + 60000, now - 2 * 3600000);
  const T2 = now - 3 * 86400000;     // 3 天前（7 天范围内）
  const T3 = now - 400 * 86400000;   // 400 天前（只在"全部"里）
  const rows = (modelId, name, status, usage, ms) => ({ modelId: modelId, name: name, status: status, usage: usage, ms: ms || 0 });
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
      {
        id: 's1', title: '核算会话', createdAt: T1, updatedAt: T1, pinned: false,
        messages: [
          { id: 'u1', role: 'user', content: 'q1', createdAt: T1 },
          {
            id: 'a1', role: 'assistant', roundId: 'r1', createdAt: T1,
            versions: [
              { results: [rows('p1::m1', '模型一', 'done', { input: 100, output: 50 }, 1000), rows('p1::m2', '模型二', 'error', null)], merge: null, at: T1 },
              {
                partial: true, partialModelId: 'p1::m1',
                results: [rows('p1::m1', '模型一', 'done', { input: 200, output: 80, cached: 60 }, 1200)],
                merge: { content: 'c', mode: 'model', createdAt: T1, modelId: 'p1::m2', modelName: '模型二', usage: { input: 300, output: 100 } },
                at: T1 + 1000
              }
            ],
            active: 1,
            review: {
              createdAt: T1,
              items: [rows('p1::m1', '模型一', 'done', { input: 400, output: 40 }, 800), rows('p1::m2', '模型二', 'stopped', { input: 10, output: 5 })],
              verdict: { content: 'v', usage: { input: 500, output: 60 }, ms: 900, stopped: false, modelId: 'p1::m3', modelName: '模型三' }
            }
          },
          { id: 'u2', role: 'user', content: 'q2', createdAt: T1 + 2000 },
          {
            id: 'a2', role: 'assistant', roundId: 'r2', createdAt: T1 + 2000,
            versions: [
              { results: [rows('p1::m2', '模型二', 'done', { input: 999, output: 1 }, 500)], merge: null, at: T1 + 2000 },
              { inherited: true, results: [rows('p1::m1', '模型一', 'done', { input: 888, output: 888 }, 0)], merge: { content: 'i', mode: 'model', createdAt: T1 + 2100, usage: { input: 7, output: 3 } }, at: T1 + 2100 }
            ],
            active: 1
          }
        ]
      },
      {
        id: 's2', title: '旧数据会话', createdAt: T2, updatedAt: T2, pinned: false,
        messages: [
          { id: 'u3', role: 'user', content: 'q3', createdAt: T2 },
          {
            id: 'a3', role: 'assistant', roundId: 'r3', createdAt: T2,
            results: [rows('p1::m3', '模型三', 'done', { input: 1000, output: 200 }, 2000)],
            merge: { content: 'm', mode: 'model', createdAt: T2, usage: { input: 100, output: 20 } },
            prunedTokens: 777
          }
        ]
      },
      {
        id: 's3', title: '历史会话', createdAt: T3, updatedAt: T3, pinned: false,
        messages: [
          { id: 'u4', role: 'user', content: 'q4', createdAt: T3 },
          {
            id: 'a4', role: 'assistant', roundId: 'r4', createdAt: T3,
            results: [rows('p1::m1', '模型一', 'done', { input: 5000, output: 1000 }, 3000)],
            merge: { content: 'f', mode: 'frontend', createdAt: T3 }
          }
        ]
      },
      { id: 's4', title: '空会话', createdAt: now, updatedAt: now, pinned: false, messages: [] }
    ]
  }, null, 1), 'utf8');

  require(path.join(ROOT, 'src', 'main', 'main.js'));

  app.whenReady().then(async () => {
    let w;
    async function run() {
      await sleep(2200);
      w = BrowserWindow.getAllWindows()[0];
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

      // ---------- 1. 派生口径（不依赖 UI） ----------
      const c = await js('MM.usage.testHooks.collect()');
      check('请求行总数 11（partial 的旧综合副本不计）', c.rows.length === 11, c.rows.length);
      const tok = c.rows.reduce((a, r) => a + r.input + r.output, 0);
      check('全部范围 token 总量 9775', tok === 9775, tok);
      check('prunedTokens 只进总量', c.pruned === 777, c.pruned);
      // partial 去重：m1 的对话行 = v1(150) + v2(280) + 审查(440) + S3(6000) = 6870
      const m1Chat = c.rows.filter(r => r.modelId === 'p1::m1' && r.kind === 'chat');
      check('partial 去重后 m1 对话 token 6870（不含审查/历史/旧综合）',
        m1Chat.reduce((a, r) => a + r.input + r.output, 0) === 100 + 50 + 200 + 80 + 5000 + 1000,
        m1Chat.map(r => r.input + '+' + r.output));
      const inh = c.rows.filter(r => r.session === '核算会话' && r.kind === 'merge');
      check('partial/inherited 的 merge 只计继承外那份（vInh merge 1 行，v2 旧综合副本不计）',
        inh.length === 1 && inh.reduce((a, r) => a + r.input + r.output, 0) === 10,
        inh.map(r => r.input + '+' + r.output));
      const s3 = c.rows.filter(r => r.session === '历史会话');
      check('前端合并不计（历史会话只有 1 行）', s3.length === 1, s3.length);
      check('综合未记录模型可归因提示', c.rows.some(r => r.name === '综合（未记录模型）' && (r.input + r.output) === 120));
      const verdict = c.rows.find(r => r.kind === 'review' && r.modelId === 'p1::m3');
      check('仲裁按记录的模型归因', !!verdict && verdict.name === '模型三' && verdict.input === 500,
        c.rows.filter(r => r.kind === 'review').map(r => r.modelId + '/' + r.name + '/' + r.input));
      const cachedRow = c.rows.find(r => r.cached === 60);
      check('usage.cached 进请求行', !!cachedRow && cachedRow.modelId === 'p1::m1');

      // ---------- 2. 聚合与范围过滤 ----------
      const hooks = 'MM.usage.testHooks';
      await js(hooks + '.setRange("all")');
      const allAgg = await js(hooks + '.aggregate()');
      const allTokens = allAgg.kpi.tokens;
      check('aggregate.kpi.tokens 含 pruned（9775+777）', allTokens === 9775 + 777, allTokens);
      check('聚合行数 11', allAgg.f.length === 11, allAgg.f.length);
      await js(hooks + '.setRange("7d")');
      const w7 = await js(hooks + '.aggregate()');
      check('7 天范围排除 400 天前的历史会话', w7.kpi.tokens === allTokens - 6000, w7.kpi.tokens);
      check('7 天范围行数 10', w7.f.length === 10, w7.f.length);
      await js(hooks + '.setRange("today")');
      const td = await js(hooks + '.aggregate()');
      check('今天范围 ⊆ 7 天（≤，midnight 安全）', td.kpi.tokens <= w7.kpi.tokens, { today: td.kpi.tokens, w7: w7.kpi.tokens });
      check('今天范围含今天的 8 行', td.f.length === 8, td.f.length);
      await js(hooks + '.setRange("all")');
      const csv = await js(hooks + '.csvOf(' + hooks + '.applyLogFilters(' + hooks + '.aggregate().f))');
      check('CSV 带表头 + 11 行数据 + BOM',
        csv.indexOf('\uFEFF') === 0 && csv.split('\r\n').length === 12 && csv.indexOf('时间,会话,模型,用途,状态,输入,输出,缓存命中,耗时(ms)') === 1,
        csv.slice(0, 80));
      check('CSV 逗号字段转义', csv.indexOf('"') >= 0 || csv.split('\r\n').every(l => (l.match(/,/g) || []).length === 8));

      // ---------- 3. 面板渲染 ----------
      await js("document.querySelector('#btn-settings').click()");
      await sleep(200);
      await js("document.querySelector('.settings-nav[data-pane=usage]').click()");
      const ui = await poll(`(function(){
        const pane = document.querySelector('#pane-usage');
        if (!pane || !pane.classList.contains('active')) return null;
        const kpis = pane.querySelectorAll('.uu-kpi').length;
        const barRects = pane.querySelectorAll('#uu-bars rect').length;
        const heatRects = pane.querySelectorAll('#uu-heat rect').length;
        const logRows = pane.querySelectorAll('#uu-log tbody tr').length;
        const sum = (pane.querySelector('.uu-sumline') || {}).textContent || '';
        return { kpis, barRects, heatRects, logRows, sum };
      })()`, 8000);
      check('KPI 卡 4 张（cached>0 时出现第 5 张缓存命中率）', ui && (ui.kpis === 4 || ui.kpis === 5), ui && ui.kpis);
      check('缓存命中率卡出现（数据含 cached）', ui && ui.kpis === 5, ui && ui.kpis);
      check('每日图有柱', ui && ui.barRects > 0, ui && ui.barRects);
      check('热力图有格子', ui && ui.heatRects > 0, ui && ui.heatRects);
      check('流水表 11 行', ui && ui.logRows === 11, ui && ui.logRows);
      check('汇总行含请求总数', ui && ui.sum.indexOf('11 个请求') >= 0, ui && ui.sum);

      // 拆分维度切换：按用途后排行 3 行
      const kindRanks = await js(`(function(){
        const segs = document.querySelectorAll('#pane-usage .uu-seg');
        let target = null;
        segs.forEach(s => { if (s.textContent.indexOf('按模型') >= 0) target = s; });
        const btns = target ? Array.from(target.querySelectorAll('button')) : [];
        const b = btns.find(x => x.textContent === '按用途');
        if (b) b.click();
        return btns.length;
      })()`);
      await sleep(250);
      const rankCount = await js(`document.querySelectorAll('#pane-usage .uu-rk').length`);
      check('拆分维度=按用途后排行 3 行（对话/综合/审查）', kindRanks >= 0 && rankCount === 3, { kindRanks, rankCount });
      // 切回按模型 + 请求纵轴，确认无异常且柱仍存在
      const back = await js(`(function(){
        const segs = document.querySelectorAll('#pane-usage .uu-seg');
        let okc = 0;
        segs.forEach(s => {
          Array.from(s.querySelectorAll('button')).forEach(b => {
            if (b.textContent === '按模型' || b.textContent === '请求') { b.click(); okc++; }
          });
        });
        return okc;
      })()`);
      await sleep(250);
      const rectsAfter = await js(`document.querySelectorAll('#uu-bars rect').length`);
      check('切回按模型/请求纵轴后柱仍在', back >= 2 && rectsAfter > 0, { back, rectsAfter });

      // 流水筛选：状态=失败 → 1 行
      await js(`(function(){
        const sel = document.querySelector('#pane-usage .uu-filters select:nth-of-type(3)');
        sel.value = 'error'; sel.dispatchEvent(new Event('change'));
      })()`);
      await sleep(200);
      const errRows = await js(`document.querySelectorAll('#uu-log tbody tr').length`);
      check('流水状态筛选=失败 → 1 行', errRows === 1, errRows);

      // ---------- 4. 真实发一轮消息：providers 的 usage.cached 全链路透传 ----------
      await js("document.querySelector('#btn-settings-close').click()");
      await sleep(200);
      await js("document.querySelector('#btn-new-chat').click()");
      await sleep(250);
      await poll("document.querySelectorAll('#model-chips .chip').length >= 10", 8000);
      await js("[].forEach.call(document.querySelectorAll('#model-chips .chip.on'), function(c){ c.click(); })");
      await sleep(150);
      await js("[].forEach.call(document.querySelectorAll('#model-chips .chip'), function(c){ if (String(c.getAttribute('data-model-id')).indexOf('p1::') === 0) c.click(); })");
      await sleep(150);
      await js("document.querySelector('#input').value = '统计验证';");
      await js("document.querySelector('#btn-send').click();");
      // 3 个模型各自完成（出现 3 个用量徽标）
      await poll("document.querySelectorAll('#messages .badge.tok').length >= 3", 15000);
      const liveRows = await js('MM.usage.testHooks.collect()');
      const liveAdded = liveRows.rows.length - 11;
      check('真实发送后新增 3 行请求', liveAdded === 3, liveAdded);
      const liveCached = liveRows.rows.filter(r => r.cached === 30);
      check('真实请求的 cached_tokens 透传进请求行', liveCached.length === 3, liveCached.length);
      const liveIn = liveRows.rows.filter(r => r.input === 111 && r.output === 22);
      check('真实请求的 input/output 透传', liveIn.length === 3, liveIn.length);

      // ---------- 5. 面板实时刷新（重开设置重算；先清掉上一步的流水筛选，
      //                 因为 usage 页签仍处激活态时 open() 会直接重渲染，nav 重复点击会早退） ----------
      await js("MM.usage.testHooks.resetFilters()");
      await js("document.querySelector('#btn-settings').click()");
      await sleep(300);
      const sumNow = await js(`(document.querySelector('.uu-sumline') || {}).textContent || ''`);
      check('面板显示 14 个请求', sumNow.indexOf('14 个请求') >= 0, sumNow);

      // ---------- 6. 边界回归（audit4）：临时替换会话数组做隔离验证，结束后原样恢复 ----------
      // a) 全部行缺时间戳：collect 的 ts 链兜底为 0，「全部」必须锚到今天（单桶），
      //    不能从 1970 铺 2 万个桶把设置页卡死
      const noTs = await js(`(function(){
        const saved = MM.state.sessions;
        MM.state.sessions = [{ id: 't0', messages: [
          { role: 'user' },
          { role: 'assistant', results: [{ modelId: 'p1::m1', name: '模型一', status: 'done', usage: { input: 10, output: 5 } }] }
        ] }];
        try {
          const agg = MM.usage.testHooks.aggregate();
          return { buckets: agg.buckets.length, total: agg.kpi.total, tokens: agg.kpi.tokens };
        } finally { MM.state.sessions = saved; }
      })()`);
      check('全部行缺时间戳：单桶 + KPI 可见', noTs.buckets === 1 && noTs.total === 1 && noTs.tokens === 15, JSON.stringify(noTs));
      // b) 坏时间戳（1970 年）：桶数封顶 400，不随时间跨度无界增长
      const oldTs = await js(`(function(){
        const saved = MM.state.sessions;
        MM.state.sessions = [{ id: 'old', createdAt: 86400000, messages: [
          { role: 'user', createdAt: 86400000 },
          { role: 'assistant', createdAt: 86400000, results: [{ modelId: 'p1::m1', name: '模型一', status: 'done', usage: { input: 10, output: 5 } }] }
        ] }];
        try {
          const agg = MM.usage.testHooks.aggregate();
          return { buckets: agg.buckets.length, total: agg.kpi.total };
        } finally { MM.state.sessions = saved; }
      })()`);
      check('坏时间戳桶数封顶 400', oldTs.buckets === 400 && oldTs.total === 1, JSON.stringify(oldTs));
      // c) 无 usage 但有正文的综合/仲裁：归为「完成」而不是终身「进行中」（成功率分母不再虚高）
      const noUsage = await js(`(function(){
        const saved = MM.state.sessions;
        MM.state.sessions = [{ id: 'nu', title: '无用量', createdAt: Date.now(), messages: [
          { role: 'user', createdAt: Date.now() },
          { role: 'assistant', createdAt: Date.now(), versions: [{ results: [
              { modelId: 'p1::m1', name: '模型一', status: 'done', usage: null }
            ], merge: { content: '报告正文', mode: 'model', createdAt: Date.now() }, at: Date.now() }], active: 0,
            review: { createdAt: Date.now(), items: [
              { modelId: 'p1::m2', name: '模型二', status: 'done', usage: null, content: '审查意见' }
            ], verdict: { content: '最终结论', stopped: false } } }
        ] }];
        try {
          const agg = MM.usage.testHooks.aggregate();
          const mergeRow = agg.f.find(function (r) { return r.kind === 'merge'; });
          const verdictRow = agg.f.find(function (r) { return r.kind === 'review' && r.name === '仲裁'; });
          return { merge: mergeRow && mergeRow.status, verdict: verdictRow && verdictRow.status, run: agg.kpi.run, rate: agg.kpi.rate };
        } finally { MM.state.sessions = saved; }
      })()`);
      check('无 usage 有正文的综合/仲裁=完成（run=0，成功率 100%）',
        noUsage.merge === 'ok' && noUsage.verdict === 'ok' && noUsage.run === 0 && noUsage.rate === 100, JSON.stringify(noUsage));
      // d) CSV：含 CR 的值引号包裹（不裸断行）；数字列负值不加前缀；文本列公式防护仍在
      const csvEdge = await js(hooks + '.csvOf([{ ts: 1750000000000, kind: "chat", modelId: "x", name: "a\\r b", status: "ok", err: "", input: -5, output: 0, cached: 0, ms: 0, session: "=CMD" }])');
      const edgeLines = csvEdge.split('\r\n');
      check('CSV 含 CR 的值被引号包裹', edgeLines.length === 2 && edgeLines[1].indexOf('"a\r b"') >= 0, JSON.stringify(edgeLines));
      check('CSV 数字列负值不加引号前缀', edgeLines.length === 2 && edgeLines[1].indexOf(',-5,') >= 0, JSON.stringify(edgeLines));
      check('CSV 文本列公式前缀防护仍在', edgeLines.length === 2 && edgeLines[1].indexOf("'=CMD") >= 0, JSON.stringify(edgeLines));
    }

    run().then(() => {
      console.log('RESULT pass=' + pass + ' fail=' + fail);
      app.exit(fail ? 1 : 0);
    }).catch(e => {
      console.error('SUITE-ERROR', e);
      console.log('RESULT pass=' + pass + ' fail=' + (fail + 1));
      app.exit(1);
    });
  });
});
