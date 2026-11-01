'use strict';
// 分层测试入口：默认零拉起（fast），需要真实环境时显式 --full 或 --only。
// 背景：12 套 Electron 测试每次都要拉起应用（隐藏窗口，个别真窗口），全量一遍 2~4 分钟；
// 但纯逻辑与静态检查不依赖环境。日常验证走 fast，改动落到共享面（preload/main/ui-chat 等）
// 时再用 --only 按映射表定向拉起，或 --full 全量。
//
// 用法：
//   node scripts/test.js              # fast：语法门 + CSS 变量门 + 2 套 Node 套件，零拉起
//   node scripts/test.js --full       # fast + 全部 12 套 Electron 套件
//   node scripts/test.js --only smoke-roundops,e2e-app   # 只跑指定套件（fast 门始终先跑）
//   node scripts/test.js --list       # 列出套件与覆盖面映射
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');

// tier: node=纯 Node 零拉起；electron=需要拉起应用（隐藏窗口，e2e-window/真实 main.js 会短暂闪窗）
// surfaces: 改了什么就该跑哪些——定向拉起用，避免全量
const SUITES = [
  { name: 'smoke-merge-report', tier: 'node',     timeout:  60, surfaces: 'merge.js 分句/聚类/溯源角标' },
  { name: 'audit-providers',    tier: 'node',     timeout:  60, surfaces: 'providers.js 请求契约/错误处理' },
  { name: 'smoke-check',        tier: 'electron', timeout: 180, surfaces: '设置页/导出/启动 DOM' },
  { name: 'smoke-sessions',     tier: 'electron', timeout: 180, surfaces: 'ui-sessions.js 会话 CRUD/渲染' },
  { name: 'smoke-roundops',     tier: 'electron', timeout: 180, surfaces: 'ui-chat.js 轮次/版本记账/重综合' },
  { name: 'smoke-review',       tier: 'electron', timeout: 180, surfaces: 'ui-chat.js 交叉审查/仲裁/停止/自动审查开关' },
  { name: 'smoke-real',         tier: 'electron', timeout: 180, surfaces: 'store.js 异常路径/错误遮罩' },
  { name: 'smoke-corrupt',      tier: 'electron', timeout: 120, surfaces: 'store.js 损坏启动/图片 gc 保护' },
  { name: 'e2e-app',            tier: 'electron', timeout: 180, surfaces: 'preload/main.js 安全面/CSP/密钥隔离/XSS' },
  { name: 'e2e-attach',         tier: 'electron', timeout: 180, surfaces: 'images.js 附件/图片/文档提取' },
  { name: 'e2e-deep',           tier: 'electron', timeout: 300, surfaces: 'store.js 导入导出/猴子测试' },
  { name: 'e2e-sessions',       tier: 'electron', timeout: 180, surfaces: 'ui-sessions.js 持久化/token 记账' },
  { name: 'e2e-window',         tier: 'electron', timeout: 120, surfaces: 'main.js/preload.js 窗口三键/最大化' },
  { name: 'perf-render',        tier: 'electron', timeout: 180, surfaces: 'app.css 大会话渲染性能' },
  { name: 'perf-stream',        tier: 'electron', timeout: 180, surfaces: 'providers.js 流式时延' },
  { name: 'audit-scan',         tier: 'electron', timeout: 180, surfaces: 'store.js 读失败防护' },
];

const argv = process.argv.slice(2);
const wantList = argv.includes('--list');
const wantFull = argv.includes('--full');
const onlyIdx = argv.indexOf('--only');
const only = onlyIdx >= 0 ? (argv[onlyIdx + 1] || '').split(',').map(s => s.trim()).filter(Boolean) : null;

function listSuites() {
  console.log('套件              环境       覆盖面');
  for (const s of SUITES) {
    console.log(s.name.padEnd(18) + s.tier.padEnd(11) + s.surfaces);
  }
}

// ---------- fast 门 1：全部 JS 语法检查（零副作用，能抓住括号/引号/保留字低级错误） ----------
function walkJs(dir, out) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) walkJs(p, out);
    else if (name.endsWith('.js')) out.push(p);
  }
  return out;
}

function checkSyntax() {
  const files = walkJs(path.join(ROOT, 'src'), [])
    .concat(walkJs(path.join(ROOT, 'scripts'), []));
  const bad = [];
  for (const f of files) {
    const r = spawnSync(process.execPath, ['--check', f], { timeout: 30000 });
    if (r.status !== 0) bad.push({ file: path.relative(ROOT, f), err: (r.stderr || '').toString().slice(0, 400) });
  }
  console.log('[语法] 检查 ' + files.length + ' 个 JS 文件：' + (bad.length ? bad.length + ' 个失败' : '全部通过'));
  for (const b of bad) console.log('  FAIL ' + b.file + '\n' + b.err);
  return bad.length === 0;
}

// ---------- fast 门 2：CSS 自定义属性闭合（引用了未定义的变量 = 整条声明静默失效） ----------
function checkCssVars() {
  const cssPath = path.join(ROOT, 'src', 'renderer', 'css', 'app.css');
  const css = fs.readFileSync(cssPath, 'utf8');
  const defined = new Set();
  for (const m of css.matchAll(/(--[a-zA-Z0-9-]+)\s*:/g)) defined.add(m[1]);
  const unresolved = new Set();
  for (const m of css.matchAll(/var\(\s*(--[a-zA-Z0-9-]+)/g)) {
    if (!defined.has(m[1])) unresolved.add(m[1]);
  }
  if (unresolved.size) {
    console.log('[CSS] FAIL 引用了未定义的变量: ' + [...unresolved].join(', '));
    return false;
  }
  console.log('[CSS] 变量引用闭合（' + defined.size + ' 个定义，无悬空引用）');
  return true;
}

// ---------- 套件执行：捕获输出、聚合真实退出码，失败时倒出尾部日志 ----------
function runSuite(s) {
  const t0 = Date.now();
  const isElectron = s.tier === 'electron';
  const bin = isElectron ? ELECTRON : process.execPath;
  const r = spawnSync(bin, [path.join(ROOT, 'scripts', s.name + '.js')], {
    timeout: s.timeout * 1000,
    maxBuffer: 32 * 1024 * 1024,
  });
  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  const out = ((r.stdout || '').toString() + (r.stderr || '').toString());
  const timedOut = r.error && r.error.code === 'ETIMEDOUT';
  if (r.status === 0 && !timedOut) {
    const mResult = out.match(/RESULT pass=(\d+) fail=(\d+)/);
    const mFrac = out.match(/(\d+)\/(\d+)\s*通过/);
    const tally = mResult ? `（pass=${mResult[1]} fail=${mResult[2]}）`
      : mFrac ? `（${mFrac[1]}/${mFrac[2]}）` : '';
    console.log(`  PASS ${s.name} ${dt}s ${tally}`);
    return true;
  }
  console.log(`  FAIL ${s.name} ${dt}s ${timedOut ? '（超时 ' + s.timeout + 's）' : '（exit=' + r.status + '）'}`);
  const lines = out.trimEnd().split('\n');
  console.log(lines.slice(-25).map(l => '    | ' + l).join('\n'));
  return false;
}

function main() {
  if (wantList) { listSuites(); return; }

  // 套件选择：--only 精确指定（任意层级）；--full 全量；默认 fast（只跑 node 层）
  if (onlyIdx >= 0 && (!only || !only.length)) {
    console.log('--only 缺少套件名，用法：--only smoke-roundops,e2e-app');
    process.exit(2);
  }
  const unknown = (only || []).filter(n => !SUITES.some(s => s.name === n));
  if (unknown.length) { console.log('未知套件: ' + unknown.join(', ') + '（--list 查看清单）'); process.exit(2); }

  const selected = only ? SUITES.filter(s => only.includes(s.name))
    : wantFull ? SUITES.slice()
    : SUITES.filter(s => s.tier === 'node');
  const nodeRuns = selected.filter(s => s.tier === 'node');
  const electronRuns = selected.filter(s => s.tier === 'electron');

  const t0 = Date.now();
  console.log('== fast 门（零拉起） ==');
  let failed = 0;
  if (!checkSyntax()) failed++;
  if (!checkCssVars()) failed++;

  if (nodeRuns.length) {
    console.log('== Node 套件（零拉起，' + nodeRuns.length + ' 套） ==');
    for (const s of nodeRuns) if (!runSuite(s)) failed++;
  }

  if (electronRuns.length) {
    if (!fs.existsSync(ELECTRON)) {
      console.log('== Electron 套件 ==\n  FAIL 找不到 electron 可执行文件（' + ELECTRON + '），请先 npm install');
      failed++;
    } else {
      console.log('== Electron 套件（拉起应用，' + electronRuns.length + ' 套） ==');
      for (const s of electronRuns) if (!runSuite(s)) failed++;
    }
  } else {
    console.log('== Electron 套件：本次未拉起 ==');
    const skipped = SUITES.filter(s => s.tier === 'electron' && !selected.includes(s));
    if (skipped.length) console.log('   改动若涉及这些面，请定向补跑（--only 或 --full）：');
    for (const s of skipped) console.log('   - ' + s.name.padEnd(16) + s.surfaces);
  }

  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\nRESULT ${failed ? failed + ' 项失败' : '全部通过'}（${dt}s）`);
  process.exit(failed ? 1 : 0);
}

main();
