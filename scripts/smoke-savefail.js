'use strict';
// 冒烟：写盘失败路径（store.json 是目录 → rename 必失败）。
// 覆盖 D9：脏标记 + 可见提示 + 关窗时不许静默丢数据（强提示横门 → 明确放弃才关）
// 用法：npx electron scripts/smoke-savefail.js
const { app, BrowserWindow, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mmc-savefail-'));
app.setPath('userData', tmp);
let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? ' -> ' + detail : '')); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// store.json 是一个目录：load() 读失败按首次启动走，save() 的 rename 必失败
fs.mkdirSync(path.join(tmp, 'store.json'));

dialog.showMessageBox = async () => ({ response: 0 });
dialog.showMessageBoxSync = () => 0;
dialog.showErrorBox = () => {};

// main.js 必须在 app ready 之前加载：registerScheme() 要求 ready 前注册
require(path.join(ROOT, 'src', 'main', 'main.js'));

app.whenReady().then(async () => {
  try {
    await sleep(2200); // 等 store 初始化 + 窗口 + 渲染层 init + 首次保存失败
    const w = BrowserWindow.getAllWindows()[0];
    if (!w) throw new Error('窗口未创建');
    const js = c => w.webContents.executeJavaScript(c, true);

    const t = await js(`({
      dirty: MM._dirty === true,
      toast: (document.querySelector('#toast') || {}).textContent || ''
    })`);
    check('写盘失败置脏标记（MM._dirty）', t.dirty === true, JSON.stringify(t));
    check('写盘失败有可见提示', t.toast.indexOf('保存失败') >= 0, JSON.stringify(t.toast));

    // 退避重试已排程：脏标记下后台会再试（仍失败，脏标记保持）
    await sleep(3500);
    const dirtyStill = await js('MM._dirty === true');
    check('退避重试后仍失败则保持脏标记', dirtyStill === true, '');

    // 关窗：flush 保存仍失败 → 强提示横门，不静默关窗丢数据
    await js("document.querySelector('#btn-win-close').click()");
    let gated = false;
    for (let i = 0; i < 30 && !gated; i++) {
      await sleep(200);
      gated = await js("!!document.getElementById('save-fail-gate')");
    }
    check('关窗时保存失败弹出强提示横门', gated === true, '');
    // 闸门在等用户决策：主进程的 2.5s 兜底强关必须已被撤销（否则闸门活不过它要防护的场景）
    await sleep(3000);
    check('闸门弹出 3 秒后窗口仍在（强关定时器已撤销）', !w.isDestroyed(), '');
    // 明确放弃 → 窗口才真正关闭。window-all-closed 会触发 app.quit()，轮询的 sleep
    // 可能赶不上退出节奏：改由 closed 事件先落结果，再让 run() 主动 app.exit
    const closedP = new Promise(resolve => { try { w.once('closed', () => resolve(true)); } catch (e) { resolve(!w.isDestroyed() ? false : true); } });
    await js("(function(){ var b = [].slice.call(document.querySelectorAll('#save-fail-gate button')).filter(function(x){ return /放弃/.test(x.textContent); })[0]; if (b) b.click(); })()");
    const closed = await Promise.race([closedP, sleep(5000).then(() => false)]);
    check('明确放弃后窗口关闭', closed === true, '');
  } catch (e) {
    fail++;
    console.log('  FAIL 测试执行异常 -> ' + (e && (e.stack || e.message)));
  }
  console.log('\nRESULT pass=' + pass + ' fail=' + fail);
  app.exit(fail ? 1 : 0);
});
