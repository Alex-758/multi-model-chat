'use strict';
// 冒烟：store.json 损坏时空库启动，不得清理图片目录。
// gc 把"无会话引用"理解为"全部孤儿"——但引用随损坏的 store.json 一起丢了，
// 用户按提示恢复 .corrupt 备份后图片引用本可救回，先 gc 就把图片永久删掉了。
// 用法：npx electron scripts/smoke-corrupt.js
const { app, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mmc-corrupt-'));
app.setPath('userData', tmp);
let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? ' -> ' + detail : '')); }
}

// 损坏的数据文件 + 一张符合图片命名白名单的"被引用"图片（引用随 store.json 一起丢失）
fs.writeFileSync(path.join(tmp, 'store.json'), '{这不是JSON', 'utf8');
const imgDir = path.join(tmp, 'images');
fs.mkdirSync(imgDir);
const imgName = 'aabbccddeeff.png';
fs.writeFileSync(path.join(imgDir, imgName), 'PNG', 'utf8');

dialog.showMessageBox = async () => ({ response: 0 });
dialog.showMessageBoxSync = () => 0;
dialog.showErrorBox = () => {};

// main.js 必须在 app ready 之前加载：registerScheme() 要求 ready 前注册
require(path.join(ROOT, 'src', 'main', 'main.js'));

app.whenReady().then(async () => {
  await new Promise(r => setTimeout(r, 1800)); // 等 store.load + 启动流程走完
  check('损坏备份已生成（.corrupt-<时间戳>）', fs.readdirSync(tmp).some(f => f.indexOf('.corrupt-') >= 0), '');
  check('空库启动不清理图片（恢复备份后引用不悬空）',
    fs.existsSync(path.join(imgDir, imgName)),
    'images 目录现存: ' + fs.readdirSync(imgDir).join(','));
  console.log('\nRESULT pass=' + pass + ' fail=' + fail);
  app.exit(fail ? 1 : 0);
});
