'use strict';
// 打包脚本：绕开 ZCode 工作区索引器的文件锁。
// 背景：ZCode 桌面端会抓住工作区内新建的 app.asar 句柄不释放，electron-builder
// 在工作区内写出 asar 后随即替换/删除时必报 EBUSY（dist/ 与 dist_build/ 均实测复现，
// Restart Manager 显示锁持有者为 ZCode 进程）。
// 做法：构建输出指到系统临时目录（工作区外），成功后把产物拷回 dist/——
// 产物位置与旧流程一致，使用方式不变：npm run dist
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(os.tmpdir(), 'mmc-dist-build');
const DIST = path.join(ROOT, 'dist');

function note(msg) { console.log('[dist-safe] ' + msg); }

// electron-builder 的 CLI 用 node 直连：绕开 .cmd shim 的 spawn 限制，参数数组不经 shell 转义
const cli = path.join(ROOT, 'node_modules', 'electron-builder', 'cli.js');
if (!fs.existsSync(cli)) {
  console.error('[dist-safe] 找不到 electron-builder（' + cli + '），请先 npm install');
  process.exit(1);
}

// 上一次构建的临时区强制清掉再建：防止陈旧产物混进拷回清单
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

note('构建输出（工作区外）：' + OUT);
const r = spawnSync(process.execPath, [cli, '--win', '-c.directories.output=' + OUT]
  .concat(process.argv.slice(2)), { stdio: 'inherit', cwd: ROOT });
if (r.status !== 0) {
  console.error('[dist-safe] electron-builder 失败（exit ' + r.status + '），产物未拷回');
  process.exit(r.status || 1);
}

// 拷回输出目录顶层的构建产物（exe / blockmap / latest.yml）；
// builder-debug.yml 是 electron-builder 的调试输出，不拷（dist 里不留构建调试垃圾）；
// win-unpacked 等目录留在临时区不拷
const SKIP = new Set(['builder-debug.yml', 'builder-effective-config.yaml']);
fs.mkdirSync(DIST, { recursive: true });
let copied = 0;
for (const name of fs.readdirSync(OUT)) {
  if (SKIP.has(name)) continue;
  const src = path.join(OUT, name);
  if (!fs.statSync(src).isFile()) continue;
  try {
    fs.copyFileSync(src, path.join(DIST, name));
    note('已拷回 ' + name);
    copied++;
  } catch (e) {
    console.error('[dist-safe] 拷回失败：' + name + '（' + e.message + '）。' +
      '目标文件可能被占用（如资源管理器预览），关掉占用后重跑 npm run dist 即可');
    process.exit(1);
  }
}
if (!copied) {
  console.error('[dist-safe] 构建输出为空，未发现可拷回的产物');
  process.exit(1);
}

// 清理临时区（约 400MB）。失败不碍事：产物已在 dist/，下次构建前还会强制清理
try { fs.rmSync(OUT, { recursive: true, force: true }); }
catch (e) { note('临时目录清理失败（不影响产物，下次构建前自动重清）：' + e.message); }
note('完成：产物在 ' + DIST);
