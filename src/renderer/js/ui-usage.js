'use strict';
// 设置页「用量统计」面板：全部数据从会话记录派生（方案A），不新增任何存储。
// 记账口径与 ui-sessions.js 的 sessionTokens 完全一致：
//   - 有 versions 时只走版本快照（当前显示内容已包含在最后一份快照里，不重复计）
//   - inherited 快照（重综合压栈副本）跳过 results，只计其 merge
//   - partial 快照（单模型重试）只计 partialModelId 那一条结果
//   - 交叉审查（互审 items + 仲裁 verdict）不做版本化，只记一次
//   - 前端合并不是模型请求，不计入
//   - 只统计服务端真实回传的 usage，绝不估算；没有 usage 的请求仍计入请求数
window.MM = window.MM || {};

(function () {
  const U = MM.util;

  // ---------- 页签内交互状态（重开设置保留，重启应用重置） ----------
  let range = '7d';      // today | 7d | 30d | all
  let metric = 'token';  // token | req：每日图纵轴
  let split = 'model';   // model | kind：每日图拆分维度
  const logFilters = { model: '', kind: '', status: '', kw: '' };
  let curF = [];         // 当前时间范围过滤后的请求行（流水表/CSV 用）
  let curAgg = null;     // 当前聚合结果（窗口 resize 重绘图用，避免重扫会话）
  let roBound = false;

  const KIND_LABEL = { chat: '对话', merge: '综合', review: '审查' };
  const STATUS_LABEL = { ok: '成功', error: '失败', stopped: '已停止', run: '进行中', skipped: '已跳过' };

  // ---------- 派生：会话 → 请求行 ----------
  function statusOf(st, hasUsage, stopped) {
    if (stopped) return 'stopped';
    if (st === 'done' || st === 'ok') return 'ok';
    if (st === 'error') return 'error';
    if (st === 'stopped') return 'stopped';
    if (st === 'skipped') return 'skipped'; // 多模态跳过的模型：请求从未发出，不能算"进行中"
    if (st === 'pending' || st === 'streaming' || st === 'searching') return 'run';
    // 历史数据可能没有 status 字段：有真实用量或正文即视为完成
    return hasUsage ? 'ok' : 'run';
  }

  function pushRow(rows, ts, kind, session, r, fallbackName) {
    const u = (r.usage && typeof r.usage === 'object') ? r.usage : null;
    rows.push({
      ts: ts || 0,
      kind,
      modelId: r.modelId || '',
      // 结果/审查员用 name，仲裁 verdict 用 modelName（ui-chat 写入字段不同）
      name: r.name || r.modelName || r.modelId || fallbackName || '未知模型',
      // 完成信号 = 有真实用量 或 已有正文（仲裁/无 usage 回传的端点也能归为完成，
      // 否则永远显示「进行中」并抬高成功率分母）；stopped/error 仍按字段优先
      status: statusOf(r.status, !!u || !!r.content, !!r.stopped),
      err: r.error ? String(r.error) : '',
      input: u ? (Number(u.input) || 0) : 0,
      output: u ? (Number(u.output) || 0) : 0,
      cached: u && u.cached != null ? (Number(u.cached) || 0) : 0,
      ms: Number(r.ms) || 0,
      session: session || ''
    });
  }

  // 综合行：mode=frontend 是纯前端拼接，不是模型请求，不计入
  function pushMergeRow(rows, ts, session, mg) {
    if (!mg || mg.mode === 'frontend') return;
    const u = (mg.usage && typeof mg.usage === 'object') ? mg.usage : null;
    rows.push({
      ts: ts || 0,
      kind: 'merge',
      modelId: mg.modelId || '',
      name: mg.modelName || mg.modelId || '综合（未记录模型）',
      // merge 数据层没有 status：完成态以正文为准（与综合卡片的渲染语义一致），
      // 服务端没回 usage 的端点不再终身「进行中」
      status: mg.stopped ? 'stopped' : ((u || mg.content) ? 'ok' : 'run'),
      err: '',
      input: u ? (Number(u.input) || 0) : 0,
      output: u ? (Number(u.output) || 0) : 0,
      cached: u && u.cached != null ? (Number(u.cached) || 0) : 0,
      ms: 0,
      session: session || ''
    });
  }

  function collect() {
    const rows = [];
    let pruned = 0;
    const sessions = (MM.state && Array.isArray(MM.state.sessions)) ? MM.state.sessions : [];
    for (const s of sessions) {
      if (!s || !Array.isArray(s.messages)) continue;
      const title = s.title || '';
      for (const m of s.messages) {
        if (!m || m.role !== 'assistant') continue;
        const baseTs = m.createdAt || s.createdAt || 0;
        const versions = Array.isArray(m.versions) && m.versions.length ? m.versions : null;
        if (versions) {
          for (const v of versions) {
            if (!v) continue;
            const vts = v.at || baseTs;
            if (!v.inherited) {
              if (v.partial && v.partialModelId) {
                const r = (v.results || []).find(x => x && x.modelId === v.partialModelId);
                if (r) pushRow(rows, vts, 'chat', title, r);
              } else {
                for (const r of (v.results || [])) if (r) pushRow(rows, vts, 'chat', title, r);
              }
            }
            // partial 快照的 merge 是上一份的副本（重试不改综合）：再收一次就重复
            if (v.merge && !v.partial) pushMergeRow(rows, vts, title, v.merge);
          }
        } else {
          for (const r of (m.results || [])) if (r) pushRow(rows, baseTs, 'chat', title, r);
          if (m.merge) pushMergeRow(rows, m.merge.createdAt || baseTs, title, m.merge);
        }
        if (m.review) {
          const rts = m.review.createdAt || baseTs;
          for (const it of (m.review.items || [])) if (it) pushRow(rows, rts, 'review', title, it);
          // 仲裁请求也是真实请求；失败仲裁没有 usage 也没有 stopped，归为进行中（数据层无该状态）
          if (m.review.verdict) pushRow(rows, rts, 'review', title, m.review.verdict, '仲裁');
        }
        if (m.prunedTokens) pruned += Number(m.prunedTokens) || 0; // 版本池裁剪折算：只进总量，无法按天/模型拆
      }
    }
    return { rows: rows, pruned: pruned };
  }

  // ---------- 聚合 ----------
  function rangeStart() {
    const now = new Date();
    if (range === 'today') return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    if (range === '7d') return now.getTime() - 7 * 86400000;
    if (range === '30d') return now.getTime() - 30 * 86400000;
    return 0;
  }

  function bucketMode(f) {
    if (range === 'today') return 'hour';
    if (range === 'all' && f.length) {
      let min = Infinity;
      for (const r of f) if (r.ts > 0 && r.ts < min) min = r.ts;
      if (min !== Infinity && Date.now() - min > 90 * 86400000) return 'week';
    }
    return 'day';
  }

  function localMidnight(ts) {
    const d = new Date(ts);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  }
  function mondayOf(ts) {
    const d = new Date(ts);
    const dow = (d.getDay() + 6) % 7; // 周一=0
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() - dow).getTime();
  }

  function buildBuckets(f) {
    const mode = bucketMode(f);
    const list = [];
    if (mode === 'hour') {
      for (let h = 0; h < 24; h++) {
        list.push({ label: String(h).padStart(2, '0') + ':00', show: h % 3 === 0, value: 0, count: 0, series: {} });
      }
      for (const r of f) {
        const b = list[new Date(r.ts).getHours()];
        b.value += r.input + r.output; b.count++;
      }
      return { list: list, indexOf: ts => new Date(ts).getHours() };
    }
    const stepMs = mode === 'week' ? 7 * 86400000 : 86400000;
    const norm = mode === 'week' ? mondayOf : localMidnight;
    let start = norm(rangeStart());
    if (range === 'all') {
      // 「全部」的起点取最早一条数据（取整到天/周），不能从 0（1970）铺桶，
      // 否则按周分桶会有几千个空桶，柱子全挤在最右边一格。
      // 所有行都缺时间戳（导入/手改的旧数据两级 createdAt 都没有）时锚到今天：
      // 这些行进不了图（indexOf 跳过 ts<=0），但 KPI 与流水照常可见
      let min = Infinity;
      for (const r of f) if (r.ts > 0 && r.ts < min) min = r.ts;
      start = min !== Infinity ? norm(min) : norm(Date.now());
    }
    const end = norm(Date.now());
    let n = Math.max(1, Math.round((end - start) / stepMs) + 1);
    // 坏时间戳（如秒/毫秒混淆产生的极小值）仍可能铺出几千桶：桶数封顶 400
    //（周桶约 7.7 年），只保留最近 400 桶，更早的行不进图但 KPI/流水不受影响
    if (n > 400) {
      start = end - (400 - 1) * stepMs;
      n = 400;
    }
    for (let i = 0; i < n; i++) {
      const d = new Date(start + i * stepMs);
      list.push({ label: (d.getMonth() + 1) + '/' + d.getDate(), show: true, value: 0, count: 0, series: {} });
    }
    const lstep = Math.ceil(n / 14);
    for (let i = 0; i < n; i++) list[i].show = i % lstep === 0 || i === n - 1;
    const indexOf = ts => {
      const i = Math.round((norm(ts) - start) / stepMs);
      return i < 0 ? -1 : i >= n ? -1 : i;
    };
    for (const r of f) {
      if (r.ts <= 0) continue;
      const b = list[indexOf(r.ts)];
      if (!b) continue;
      b.value += r.input + r.output;
      b.count++;
    }
    return { list: list, indexOf: indexOf };
  }

  // 当前拆分维度下的系列（每日图与排行共用，颜色一一对应）
  function seriesList(f) {
    if (split === 'kind') {
      return [
        { key: 'chat', label: '对话', cls: 'uu-s0', tokens: sumKind(f, 'chat'), count: cntKind(f, 'chat') },
        { key: 'merge', label: '综合', cls: 'uu-s1', tokens: sumKind(f, 'merge'), count: cntKind(f, 'merge') },
        { key: 'review', label: '审查', cls: 'uu-s2', tokens: sumKind(f, 'review'), count: cntKind(f, 'review') }
      ];
    }
    const by = new Map();
    for (const r of f) {
      const k = r.modelId || 'name:' + r.name;
      let e = by.get(k);
      if (!e) { e = { key: k, label: r.name, cls: '', tokens: 0, count: 0 }; by.set(k, e); }
      e.tokens += r.input + r.output;
      e.count++;
    }
    const arr = [...by.values()].sort((a, b) => b.tokens - a.tokens);
    const CLS = ['uu-s0', 'uu-s1', 'uu-s2', 'uu-s3', 'uu-s4'];
    const top = arr.slice(0, 5);
    top.forEach((e, i) => { e.cls = CLS[i]; });
    const rest = arr.slice(5);
    if (rest.length) {
      const o = { key: '__other__', label: '其他（' + rest.length + ' 个模型）', cls: 'uu-s5', tokens: 0, count: 0 };
      for (const e of rest) { o.tokens += e.tokens; o.count += e.count; }
      top.push(o);
    }
    return top;
  }

  function sumKind(f, k) { let t = 0; for (const r of f) if (r.kind === k) t += r.input + r.output; return t; }
  function cntKind(f, k) { let c = 0; for (const r of f) if (r.kind === k) c++; return c; }

  function kpis(f, pruned) {
    let input = 0, output = 0, cached = 0, ok = 0, error = 0, stopped = 0, run = 0;
    let synth = 0, review = 0;
    const mss = [];
    for (const r of f) {
      input += r.input; output += r.output; cached += r.cached;
      if (r.status === 'ok') { ok++; if (r.ms > 0) mss.push(r.ms); }
      else if (r.status === 'error') error++;
      else if (r.status === 'stopped') stopped++;
      else run++;
      const t = r.input + r.output;
      if (r.kind === 'merge') synth += t;
      else if (r.kind === 'review') review += t;
    }
    const total = f.length;
    const decided = ok + error + stopped;
    mss.sort((a, b) => a - b);
    const pick = q => mss.length ? mss[Math.min(mss.length - 1, Math.max(0, Math.round(q * (mss.length - 1))))] : 0;
    return {
      input, output, cached, pruned,
      // KPI 总量含已裁剪历史（真实消耗过的 token）；sub 行注明，图表按天拆不出这部分所以对不上是预期
      tokens: input + output + pruned,
      total, ok, error, stopped, run,
      rate: decided ? Math.round(ok / decided * 100) : null,
      synth, review,
      avgMs: mss.length ? Math.round(mss.reduce((a, b) => a + b, 0) / mss.length) : 0,
      p50: pick(0.5), p95: pick(0.95)
    };
  }

  function aggregate() {
    const all = collect();
    const start = rangeStart();
    const f = all.rows.filter(r => r.ts >= start);
    const series = seriesList(f);
    const skey = r => split === 'kind' ? r.kind : (r.modelId || 'name:' + r.name);
    // 「其他」聚合系列：第 6 名起的模型都归 __other__，否则该系列永远画不出来
    const topKeys = new Set(series.filter(se => se.key !== '__other__').map(se => se.key));
    const keyOf = r => { const k0 = skey(r); return topKeys.has(k0) ? k0 : '__other__'; };
    const bk = buildBuckets(f);
    for (const r of f) {
      if (r.ts <= 0) continue;
      const i = bk.indexOf(r.ts);
      if (i < 0) continue;
      const b = bk.list[i];
      const k = keyOf(r);
      b.series[k] = (b.series[k] || 0) + (metric === 'req' ? 1 : r.input + r.output);
    }
    // 堆叠总高：纵轴刻度按它取（req 模式下与 token 总量无关）
    for (const b of bk.list) {
      b.stackTotal = 0;
      for (const k in b.series) b.stackTotal += b.series[k];
    }
    return {
      all: all.rows, pruned: all.pruned, f, series,
      buckets: bk.list, // 纯数据（含函数会让 executeJavaScript 的结构化克隆失败）
      kpi: kpis(f, all.pruned),
      heat: dailyTotals(all.rows)
    };
  }

  function dailyTotals(rows) {
    const map = new Map();
    for (const r of rows) {
      if (r.ts <= 0) continue;
      const day = localMidnight(r.ts);
      map.set(day, (map.get(day) || 0) + r.input + r.output);
    }
    return map;
  }

  // ---------- 图表（手绘 SVG；颜色走 CSS 类，暗色主题自动切换） ----------
  function svgBars(box, agg) {
    const W = Math.max(300, Math.floor(box.clientWidth));
    const H = 200, padL = 46, padB = 22, padT = 8;
    const plotH = H - padB - padT;
    const list = agg.buckets; // aggregate 返回的 buckets 就是桶数组
    const maxVal = list.reduce((m, b) => Math.max(m, b.stackTotal || 0), 0);
    const band = (W - padL) / Math.max(1, list.length);
    const barW = Math.min(24, Math.max(6, band - 6));
    // 抽稀步长按「标签实际宽度 vs 桶宽」算，固定数量抽稀会让宽标签互相重叠
    const labelW = /:/.test((list[0] && list[0].label) || '') ? 42 : 36; // 小时标签 HH:00 更宽
    const lstep = Math.max(1, Math.ceil(labelW / band));
    const y = v => padT + plotH * (1 - (maxVal ? v / maxVal : 0));
    let s = '<svg width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="每日用量图">';
    if (maxVal > 0) {
      const mag = Math.pow(10, Math.floor(Math.log10(maxVal)));
      const fr = maxVal / mag;
      const nice = (fr <= 1 ? 1 : fr <= 2 ? 2 : fr <= 5 ? 5 : 10) * mag;
      [nice, nice / 2].forEach(function (g) {
        s += '<line class="uu-grid" x1="' + padL + '" y1="' + y(g) + '" x2="' + W + '" y2="' + y(g) + '"/>';
        s += '<text class="uu-tick" x="' + (padL - 8) + '" y="' + (y(g) + 4) + '" text-anchor="end">' + MM.modelInfo.fmtTokens(g) + '</text>';
      });
    }
    s += '<line class="uu-axis" x1="' + padL + '" y1="' + y(0) + '" x2="' + W + '" y2="' + y(0) + '"/>';
    s += '<text class="uu-tick" x="' + (padL - 8) + '" y="' + (y(0) + 4) + '" text-anchor="end">0</text>';
    list.forEach(function (b, i) {
      const x = padL + i * band + (band - barW) / 2;
      let cum = 0;
      let tip = b.label + ' · ' + (metric === 'req' ? b.count + ' 次请求' : MM.modelInfo.fmtTokens(b.value) + ' tokens');
      let g = '<g><title>' + U.esc(tip) + '</title>';
      for (const se of agg.series) {
        const v = b.series[se.key] || 0;
        if (v <= 0) continue;
        const y1 = y(cum), y2 = y(cum + v);
        g += '<rect class="' + se.cls + '" x="' + x + '" y="' + y2 + '" width="' + barW + '" height="' + Math.max(0.5, y1 - y2 - 1) + '" rx="1"/>';
        cum += v;
      }
      g += '</g>';
      s += g;
      if (i % lstep === 0) s += '<text class="uu-tick" x="' + (padL + i * band + band / 2) + '" y="' + (H - 6) + '" text-anchor="middle">' + U.esc(b.label) + '</text>';
    });
    s += '</svg>';
    box.innerHTML = s;
  }

  function svgHeat(box, heat) {
    const cell = 11, step = 14, labW = 24, topH = 16;
    const avail = Math.max(220, Math.floor(box.clientWidth));
    const weeks = Math.min(53, Math.max(8, Math.floor((avail - labW - 34) / step)));
    const hw = labW + weeks * step + 34, hh = topH + 7 * step + 4;
    const anchor = mondayOf(Date.now());
    // 阈值取当日用量的分位数，随数据规模自适应
    const nz = [...heat.values()].filter(v => v > 0).sort((a, b) => a - b);
    const q = p => nz.length ? nz[Math.min(nz.length - 1, Math.floor(p * nz.length))] : 0;
    const t1 = q(0.33), t2 = q(0.66), t3 = q(0.9);
    const levelOf = v => v <= 0 ? 0 : v <= t1 ? 1 : v <= t2 ? 2 : v <= t3 ? 3 : 4;
    let s = '<svg width="' + hw + '" height="' + hh + '" viewBox="0 0 ' + hw + ' ' + hh + '" role="img" aria-label="每日用量热力图">';
    const wd = { 0: '一', 2: '三', 4: '五', 6: '日' };
    for (const k of Object.keys(wd)) s += '<text class="uu-tick" x="0" y="' + (topH + k * step + 9) + '">' + wd[k] + '</text>';
    let lastMon = null;
    for (let w = 0; w < weeks; w++) {
      const monday = anchor - (weeks - 1 - w) * 7 * 86400000;
      const d = new Date(monday);
      const mk = d.getFullYear() * 12 + d.getMonth();
      if (lastMon === null || mk !== lastMon) {
        s += '<text class="uu-tick" x="' + (labW + w * step) + '" y="11">' + (d.getMonth() + 1) + '月</text>';
        lastMon = mk;
      }
      for (let i = 0; i < 7; i++) {
        const day = monday + i * 86400000;
        if (day > Date.now()) break;
        const v = heat.get(localMidnight(day)) || 0;
        const dd = new Date(day);
        s += '<rect class="uu-h' + levelOf(v) + '" x="' + (labW + w * step) + '" y="' + (topH + i * step) +
          '" width="' + cell + '" height="' + cell + '" rx="2.5"><title>' +
          (dd.getMonth() + 1) + '/' + dd.getDate() + ' · ' + (v > 0 ? MM.modelInfo.fmtTokens(v) + ' tokens' : '无记录') + '</title></rect>';
      }
    }
    s += '</svg>';
    box.innerHTML = s;
    const hwEl = document.getElementById('uu-hw');
    if (hwEl) hwEl.textContent = '最近 ' + weeks + ' 周 · 每日 tokens';
  }

  // ---------- 流水表 ----------
  function applyLogFilters(f) {
    const kw = logFilters.kw.trim().toLowerCase();
    return f.filter(function (r) {
      if (logFilters.model && (r.modelId || 'name:' + r.name) !== logFilters.model) return false;
      if (logFilters.kind && r.kind !== logFilters.kind) return false;
      if (logFilters.status && r.status !== logFilters.status) return false;
      if (kw && (r.name + ' ' + r.session + ' ' + r.modelId).toLowerCase().indexOf(kw) < 0) return false;
      return true;
    });
  }

  function fmtLogTs(ts) {
    if (!ts) return '—';
    const d = new Date(ts);
    const hms = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0') + ':' + String(d.getSeconds()).padStart(2, '0');
    const now = new Date();
    if (d.toDateString() === now.toDateString()) return hms;
    return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + hms;
  }

  function renderLog() {
    const box = document.getElementById('uu-log');
    if (!box) return;
    const rows = applyLogFilters(curF).sort((a, b) => b.ts - a.ts);
    const k = kpis(rows, 0);
    const cachedStr = k.cached > 0 ? ' · 缓存读取 ' + MM.modelInfo.fmtTokens(k.cached) : '';
    const avgStr = k.avgMs ? U.fmtMs(k.avgMs) : '—';
    let html = '<div class="uu-sumline"><b>' + k.total.toLocaleString() + '</b> 个请求 · 输入 <b>' + MM.modelInfo.fmtTokens(k.input) +
      '</b> · 输出 <b>' + MM.modelInfo.fmtTokens(k.output) + '</b>' + cachedStr +
      (k.error ? ' · <span class="dn">' + k.error + ' 次失败</span>' : '') +
      (k.stopped ? ' · ' + k.stopped + ' 次停止' : '') + (k.run ? ' · ' + k.run + ' 个进行中' : '') +
      ' · 平均耗时 <b>' + avgStr + '</b></div>';
    html += '<div class="uu-tscroll"><table class="uu-tb"><thead><tr>' +
      '<th>时间</th><th>会话</th><th>模型</th><th>用途</th>' +
      '<th class="num">输入</th><th class="num">输出</th><th class="num">耗时</th><th class="num">状态</th>' +
      '</tr></thead><tbody>';
    const show = rows.slice(0, 200);
    if (!show.length) {
      html += '<tr><td colspan="8" style="text-align:center;color:var(--muted);padding:24px 0">当前筛选下没有请求</td></tr>';
    }
    for (const r of show) {
      html += '<tr>' +
        '<td class="num" style="text-align:left">' + fmtLogTs(r.ts) + '</td>' +
        '<td class="sess" title="' + U.esc(r.session) + '">' + U.esc(r.session || '—') + '</td>' +
        '<td title="' + U.esc(r.modelId || '') + '">' + U.esc(r.name) + '</td>' +
        '<td><span class="uu-badge ' + r.kind + '">' + KIND_LABEL[r.kind] + '</span></td>' +
        '<td class="num" title="' + (r.cached > 0 ? '含缓存读取 ' + MM.modelInfo.fmtTokens(r.cached) : '') + '">' + (r.input ? r.input.toLocaleString() : '—') + '</td>' +
        '<td class="num">' + (r.output ? r.output.toLocaleString() : '—') + '</td>' +
        '<td class="num">' + (r.ms > 0 ? U.fmtMs(r.ms) : '—') + '</td>' +
        '<td class="num"><span class="uu-st ' + r.status + '" title="' + U.esc(r.err) + '"><i></i>' + STATUS_LABEL[r.status] + '</span></td>' +
        '</tr>';
    }
    html += '</tbody></table></div>';
    if (rows.length > 200) {
      html += '<div class="uu-sub" style="margin-top:8px">仅显示最近 200 条，共 ' + rows.length.toLocaleString() + ' 条；导出 CSV 包含全部。</div>';
    }
    box.innerHTML = html;
  }

  function csvOf(rows) {
    // 公式注入防护：= + - @ 开头的文本单元格前置单引号（Excel/WPS 不再当公式求值），
    // 是 CSV 注入的标准缓解；数字列（输入/输出/缓存/耗时）跳过前缀，避免负值被变成文本。
    // 含 CR 的值也要引号包裹：否则裸 \r 会断行破坏 CSV 结构
    const escCell = (v, isNum) => {
      v = String(v == null ? '' : v);
      if (!isNum && /^[=+\-@\t\r]/.test(v)) v = "'" + v;
      return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
    };
    const lines = ['时间,会话,模型,用途,状态,输入,输出,缓存命中,耗时(ms)'];
    for (const r of rows) {
      lines.push([
        fmtLogTs(r.ts), r.session, r.name, KIND_LABEL[r.kind], STATUS_LABEL[r.status],
        r.input, r.output, r.cached, r.ms
      ].map((v, i) => escCell(v, i >= 5)).join(','));
    }
    return '\uFEFF' + lines.join('\r\n');
  }

  function exportCsv() {
    const rows = applyLogFilters(curF).sort((a, b) => b.ts - a.ts);
    if (!rows.length) { U.toast('当前筛选下没有可导出的请求', true); return; }
    const blob = new Blob([csvOf(rows)], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    const d = new Date();
    a.href = URL.createObjectURL(blob);
    a.download = 'mmc-用量-' + d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0') +
      '-' + String(d.getHours()).padStart(2, '0') + String(d.getMinutes()).padStart(2, '0') + String(d.getSeconds()).padStart(2, '0') + '.csv';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 3000);
  }

  // ---------- 渲染 ----------
  function mkSeg(options, cur, onPick) {
    const seg = U.el('div', { class: 'uu-seg', role: 'group' });
    for (const o of options) {
      const b = U.el('button', { type: 'button', class: o.value === cur ? 'on' : '' }, o.label);
      b.addEventListener('click', function () {
        if (o.value === cur) return;
        cur = o.value;
        for (const c of seg.children) c.classList.toggle('on', c === b);
        onPick(o.value);
      });
      seg.appendChild(b);
    }
    return seg;
  }

  function kpiCard(lb, vl, sbHtml) {
    return U.el('div', { class: 'uu-kpi' },
      U.el('div', { class: 'lb' }, lb),
      U.el('div', { class: 'vl' }, vl),
      sbHtml ? U.el('div', { class: 'sb', html: sbHtml }) : null);
  }

  function render() {
    const pane = U.$('#pane-usage');
    if (!pane) return;
    const agg = aggregate();
    curF = agg.f;
    curAgg = agg;
    const k = agg.kpi;
    pane.innerHTML = '';

    // 头部：标题 + 时间范围
    pane.appendChild(U.el('div', { class: 'uu-hd' },
      U.el('div', {},
        U.el('h2', {}, '用量统计'),
        U.el('div', { class: 'uu-sub' }, '口径：会话内每次模型调用的实际回传用量（含综合与交叉审查）；前端合并不计')),
      mkSeg([{ value: 'today', label: '今天' }, { value: '7d', label: '7 天' }, { value: '30d', label: '30 天' }, { value: 'all', label: '全部' }],
        range, function (v) { range = v; render(); })));

    if (!agg.all.length) {
      pane.appendChild(U.el('div', { class: 'uu-card uu-empty' },
        '暂无用量数据。只有服务端回传了 token 用量的请求会计入；发起新对话后这里会出现统计。'));
      return;
    }

    // KPI 卡
    const kpis2 = U.el('div', { class: 'uu-kpis' });
    kpis2.appendChild(kpiCard('Token', MM.modelInfo.fmtTokens(k.tokens),
      '输入 ' + MM.modelInfo.fmtTokens(k.input) + ' · 输出 ' + MM.modelInfo.fmtTokens(k.output) +
      (k.cached > 0 ? ' · 缓存读取 ' + MM.modelInfo.fmtTokens(k.cached) : '') +
      (k.pruned > 0 ? '<br>含已裁剪历史 ' + MM.modelInfo.fmtTokens(k.pruned) : '')));
    kpis2.appendChild(kpiCard('请求', k.total.toLocaleString(),
      (k.rate == null ? '' : '<span class="up">成功率 ' + k.rate + '%</span> · ') +
      '<span class="dn">失败 ' + k.error + '</span> · 停止 ' + k.stopped + (k.run ? ' · 进行中 ' + k.run : '')));
    const srTotal = (k.input + k.output) || 1; // 占比按可按天拆分的部分算，不含裁剪历史
    kpis2.appendChild(kpiCard('综合 + 交叉审查', MM.modelInfo.fmtTokens(k.synth + k.review),
      '综合 ' + MM.modelInfo.fmtTokens(k.synth) + ' · 审查 ' + MM.modelInfo.fmtTokens(k.review) +
      ' · 占 ' + Math.round((k.synth + k.review) / srTotal * 100) + '%'));
    kpis2.appendChild(kpiCard('平均耗时', k.avgMs ? U.fmtMs(k.avgMs) : '—',
      k.avgMs ? 'P50 ' + U.fmtMs(k.p50) + ' · P95 ' + U.fmtMs(k.p95) : '无可计时请求'));
    if (k.cached > 0 && k.input > 0) {
      kpis2.appendChild(kpiCard('缓存命中率', Math.round(k.cached / k.input * 100) + '%',
        '缓存读取 ' + MM.modelInfo.fmtTokens(k.cached) + ' / 输入 ' + MM.modelInfo.fmtTokens(k.input)));
    }
    pane.appendChild(kpis2);

    // 每日图 + 模型排行
    const barsBox = U.el('div', { class: 'uu-bars', id: 'uu-bars' });
    const rankBox = U.el('div', { class: 'uu-rank' });
    const totalTok = agg.series.reduce((a, b) => a + b.tokens, 0) || 1;
    for (const se of agg.series) {
      rankBox.appendChild(U.el('div', { class: 'uu-rk' },
        U.el('div', { class: 'r1' },
          // 色板定义在 SVG fill 上（随主题切换），所以图例色块也用内联 SVG 承载
          U.el('span', { class: 'uu-dot', html: '<svg width="8" height="8" viewBox="0 0 8 8"><rect class="' + se.cls + '" width="8" height="8" rx="3"/></svg>' }),
          U.el('span', { class: 'nm', title: se.label }, se.label),
          U.el('span', { class: 'v' }, MM.modelInfo.fmtTokens(se.tokens))),
        U.el('div', { class: 'r2' },
          U.el('span', {}, se.count + ' 请求'),
          U.el('span', { class: 'uu-bar' }, U.el('i', { style: 'width:' + Math.max(1, Math.round(se.tokens / totalTok * 100)) + '%' })),
          U.el('span', {}, Math.round(se.tokens / totalTok * 100) + '%'))));
    }
    if (!agg.series.length) rankBox.appendChild(U.el('div', { class: 'uu-sub' }, '该范围内没有可归因的请求'));
    pane.appendChild(U.el('div', { class: 'uu-card' },
      U.el('div', { class: 'uu-chead' },
        U.el('span', { class: 'ct' }, '每日' + (metric === 'req' ? '请求' : ' Token')),
        mkSeg([{ value: 'token', label: 'Token' }, { value: 'req', label: '请求' }], metric, function (v) { metric = v; render(); }),
        U.el('span', { class: 'right' },
          U.el('span', { class: 'dim' }, '拆分维度'),
          mkSeg([{ value: 'model', label: '按模型' }, { value: 'kind', label: '按用途' }], split, function (v) { split = v; render(); }))),
      U.el('div', { class: 'uu-chartwrap' }, barsBox, rankBox)));

    // 热力图
    pane.appendChild(U.el('div', { class: 'uu-card' },
      U.el('div', { class: 'uu-chead' },
        U.el('span', { class: 'ct' }, '用量热力图'),
        U.el('span', { class: 'dim', id: 'uu-hw' }, ''),
        U.el('span', { class: 'right uu-hleg', id: 'uu-hleg' })),
      U.el('div', { class: 'uu-heat', id: 'uu-heat' })));

    // 请求流水
    pane.appendChild(U.el('div', { class: 'uu-card' },
      U.el('div', { class: 'uu-chead' },
        U.el('span', { class: 'ct' }, '请求流水'),
        U.el('span', { class: 'right' },
          U.el('button', { class: 'uu-btn-ink', type: 'button', onclick: exportCsv }, '导出 CSV'))),
      U.el('div', { class: 'uu-filters' },
        mkSelect('model', '全部模型'),
        mkSelect('kind', '全部用途', [['chat', '对话'], ['merge', '综合'], ['review', '审查']]),
        mkSelect('status', '全部状态', [['ok', '成功'], ['error', '失败'], ['stopped', '已停止'], ['run', '进行中'], ['skipped', '已跳过']]),
        mkSearch()),
      U.el('div', { id: 'uu-log' })));

    drawCharts(agg);
    renderHeatLegend();
    renderLog();
    bindResize(pane);
  }

  function mkSelect(key, allLabel, options) {
    const sel = U.el('select', { 'aria-label': allLabel });
    sel.appendChild(U.el('option', { value: '' }, allLabel));
    if (!options) {
      // 模型下拉：按当前范围内出现过的模型生成
      const seen = new Map();
      for (const r of curF) {
        const k = r.modelId || 'name:' + r.name;
        if (!seen.has(k)) seen.set(k, r.name);
      }
      options = [...seen.entries()].sort((a, b) => a[1].localeCompare(b[1])).map(e => [e[0], e[1]]);
    }
    for (const o of options) sel.appendChild(U.el('option', { value: o[0] }, o[1]));
    sel.value = logFilters[key];
    if (sel.value !== logFilters[key]) { logFilters[key] = ''; sel.value = ''; } // 范围切换后原选项可能不存在
    sel.addEventListener('change', function () { logFilters[key] = sel.value; renderLog(); });
    return sel;
  }

  function mkSearch() {
    const inp = U.el('input', { type: 'text', placeholder: '搜索会话或模型', 'aria-label': '搜索会话或模型', value: logFilters.kw });
    inp.addEventListener('input', U.debounce(function () { logFilters.kw = inp.value; renderLog(); }, 250));
    return inp;
  }

  function drawCharts(agg) {
    const bars = document.getElementById('uu-bars');
    if (bars) svgBars(bars, agg);
    const heat = document.getElementById('uu-heat');
    if (heat) svgHeat(heat, agg.heat);
  }

  function renderHeatLegend() {
    const leg = document.getElementById('uu-hleg');
    if (!leg) return;
    leg.innerHTML = '<span>少</span>' +
      [0, 1, 2, 3, 4].map(function (i) {
        return '<svg width="10" height="10" viewBox="0 0 10 10"><rect class="uu-h' + i + '" width="10" height="10" rx="3"/></svg>';
      }).join('') +
      '<span>多</span>';
  }

  // 面板宽度变化时只重绘图表，不重扫会话
  function bindResize(pane) {
    if (roBound) return;
    roBound = true;
    let lastW = 0;
    const ro = new ResizeObserver(function () {
      const w = pane.clientWidth;
      if (!w || Math.abs(w - lastW) < 4) return;
      lastW = w;
      if (curAgg) drawCharts(curAgg);
    });
    ro.observe(pane);
  }

  // ---------- 测试钩子（smoke-usage 用；命名带 testHooks 以示内部） ----------
  MM.usage = {
    render: render,
    testHooks: {
      collect: collect,
      aggregate: aggregate,
      setRange: function (r) { range = r; },
      getRange: function () { return range; },
      resetFilters: function () { logFilters.model = ''; logFilters.kind = ''; logFilters.status = ''; logFilters.kw = ''; },
      csvOf: csvOf,
      applyLogFilters: applyLogFilters
    }
  };
})();
