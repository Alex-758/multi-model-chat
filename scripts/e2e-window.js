'use strict';
// 窗口三键行为测试：真实 main.js + 真实 IPC 往返（titleBarStyle hidden + 自绘 #win-controls）。
// 覆盖：菜单移除、最大化/还原按钮双路径（点击返回值 + win:state 推送）、最小化、未知动作契约、关闭。
// 用法：npx electron scripts/e2e-window.js
const { app, BrowserWindow, Menu, dialog } = require('electron');
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

// 独立临时 userData：不碰真实数据文件，也保证单实例锁必然拿到
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'mmc-win-'));
app.setPath('userData', DATA);
dialog.showMessageBox = async () => ({ response: 0 });
dialog.showMessageBoxSync = () => 0;
dialog.showErrorBox = () => {};

// main.js 必须在 app ready 之前加载：registerScheme() 要求 ready 前注册
require(path.join(ROOT, 'src', 'main', 'main.js'));

app.whenReady().then(async () => {
  try {
    await sleep(2200); // 等 store 初始化 + 窗口 + 渲染层 init
    const w = BrowserWindow.getAllWindows()[0];
    if (!w) throw new Error('窗口未创建');
    const js = c => w.webContents.executeJavaScript(c, true);
    const poll = async (expr, want, ms) => {
      const t0 = Date.now();
      for (;;) {
        const v = await js(expr);
        if (v === want) return true;
        if (Date.now() - t0 > ms) return false;
        await sleep(120);
      }
    };

    // 菜单已移除（一体化标题栏方案的前提：F12 走 before-input-event，不依赖菜单）
    check('应用菜单为 null（Menu.setApplicationMenu(null) 生效）', Menu.getApplicationMenu() === null);

    // 初始：未最大化，按钮无 is-max 类
    const init = await js(`({
      maxed: (function(){ return null; })(),
      cls: document.querySelector('#btn-win-max').classList.contains('is-max'),
      hasMin: !!document.querySelector('#btn-win-min'),
      hasClose: !!document.querySelector('#btn-win-close')
    })`);
    check('初始未最大化且三键齐全', w.isMaximized() === false && init.cls === false && init.hasMin && init.hasClose);

    // 点击最大化：IPC 往返 + win:state 推送 → 图标切到「还原」
    await js("document.querySelector('#btn-win-max').click()");
    const gotMax = await poll("document.querySelector('#btn-win-max').classList.contains('is-max')", true, 3000);
    check('点击最大化：窗口最大化 + is-max 类点亮（还原图标）', w.isMaximized() === true && gotMax === true);

    // 系统级还原（主进程直调，模拟 Win+Down）：验证 win:state 推送路径，不只是按钮回显
    w.unmaximize();
    const gotUn = await poll("document.querySelector('#btn-win-max').classList.contains('is-max')", false, 3000);
    check('主进程还原：win:state 推送把图标切回「最大化」', w.isMaximized() === false && gotUn === true);

    // 再点一次：还原状态下点最大化应再次最大化
    await js("document.querySelector('#btn-win-max').click()");
    const gotMax2 = await poll("document.querySelector('#btn-win-max').classList.contains('is-max')", true, 3000);
    check('再次点击最大化：状态往返一致', w.isMaximized() === true && gotMax2 === true);
    w.unmaximize();
    await sleep(400);

    // 最小化
    await js("document.querySelector('#btn-win-min').click()");
    const t0 = Date.now();
    while (!w.isMinimized() && Date.now() - t0 < 3000) await sleep(120);
    check('点击最小化：窗口最小化', w.isMinimized() === true);
    w.restore();
    await sleep(400);

    // 未知动作：不抛错，返回当前最大化布尔（契约：布尔返回值，渲染层 setMax 收布尔）
    const bogus = await js("window.api.winControl('__nope__')");
    check('未知动作返回布尔不抛错', bogus === w.isMaximized(), String(bogus));

    // 关闭（最后一项）：window-all-closed → app.quit。
    // 关闭前故意改标题但不保存：close 事件会先请求渲染层落盘（app:flush），
    // 窗口销毁后从磁盘验证这条未保存的改动确实写进去了（无此机制则整轮丢失）。
    // app.quit 的竞态会抢在轮询循环之后杀掉进程，断言必须挂在 'closed' 事件里——
    // 它在 window-all-closed 之前同步触发，时序有保证；断言后直接 app.exit 收尾（promise 不再 resolve）
    await js("(function(){ MM.state.sessions[0].title = 'flush-未保存标记'; })()");
    await new Promise(() => {
      const t1 = setTimeout(() => {
        check('点击关闭：窗口销毁', w.isDestroyed() === true, '6s 内未销毁');
        console.log('\nRESULT pass=' + pass + ' fail=' + fail);
        app.exit(fail ? 1 : 0);
      }, 6000);
      w.once('closed', () => {
        clearTimeout(t1);
        check('点击关闭：窗口销毁', true);
        try {
          const disk = JSON.parse(fs.readFileSync(path.join(DATA, 'store.json'), 'utf8'));
          check('关闭前自动落盘（app:flush 把未保存改动写入磁盘）',
            disk.sessions.some(s => s && s.title === 'flush-未保存标记'),
            JSON.stringify(disk.sessions.map(s => s && s.title)));
        } catch (e) {
          check('关闭前自动落盘（app:flush 把未保存改动写入磁盘）', false, String(e && e.message));
        }
        console.log('\nRESULT pass=' + pass + ' fail=' + fail);
        app.exit(fail ? 1 : 0);
      });
      js("document.querySelector('#btn-win-close').click()");
    });
  } catch (e) {
    fail++;
    console.log('  FAIL 测试执行异常 -> ' + (e && e.message));
    console.log('\nRESULT pass=' + pass + ' fail=' + fail);
    app.exit(1);
  }
  console.log('\nRESULT pass=' + pass + ' fail=' + fail);
  app.exit(fail ? 1 : 0);
});
