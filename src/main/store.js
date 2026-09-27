'use strict';
// 本地 JSON 存储：userData/store.json
// - 原子写（tmp + rename）
// - 并发保护：写入前比对文件 mtime，若被其他实例修改过，先把旧文件备份为 store.json.bak 再覆盖
const fs = require('fs');
const path = require('path');

let dataDir = null;
let lastMtime = 0; // 本进程最后已知的 store.json 修改时间

function init(userDataDir) { dataDir = userDataDir; }
function file() { return path.join(dataDir, 'store.json'); }
function dir() { return dataDir; }

function currentMtime() {
  try { return fs.statSync(file()).mtimeMs; } catch (e) { return 0; }
}

function load() {
  try {
    const data = JSON.parse(fs.readFileSync(file(), 'utf8'));
    lastMtime = currentMtime();
    return data;
  } catch (e) {
    lastMtime = 0;
    return null;
  }
}

function save(data) {
  // 并发检测：磁盘上的 mtime 与本进程记录不一致 => 被其他实例/进程改过
  const cur = currentMtime();
  if (lastMtime && cur && cur !== lastMtime) {
    try {
      fs.copyFileSync(file(), file() + '.bak');
      console.warn('[store] 检测到 store.json 被其他实例修改，旧数据已备份为 store.json.bak');
    } catch (e) { /* 备份失败不阻断写入 */ }
  }
  const f = file();
  const tmp = f + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data), 'utf8');
  fs.renameSync(tmp, f);
  lastMtime = currentMtime();
}

module.exports = { init, load, save, dir };
