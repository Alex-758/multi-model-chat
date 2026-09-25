'use strict';
// 本地 JSON 存储：userData/store.json，原子写入（tmp + rename）
const fs = require('fs');
const path = require('path');

let dataDir = null;

function init(userDataDir) { dataDir = userDataDir; }
function file() { return path.join(dataDir, 'store.json'); }
function dir() { return dataDir; }

function load() {
  try {
    return JSON.parse(fs.readFileSync(file(), 'utf8'));
  } catch (e) {
    return null;
  }
}

function save(data) {
  const f = file();
  const tmp = f + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data), 'utf8');
  fs.renameSync(tmp, f);
}

module.exports = { init, load, save, dir };
