'use strict';
// 本地 JSON 存储：userData/store.json
// - 原子写（tmp + rename）
// - 并发保护：写入前比对文件 mtime，若被其他实例修改过，先把旧文件备份为 store.json.bak 再覆盖
// - 密钥加密：磁盘上的 apiKey 用 Electron safeStorage（Windows 下为 DPAPI）加密；
//   旧版明文密钥仍可读取，下次保存时自动转为密文
// - 损坏保护：store.json 无法解析时备份为 store.json.corrupt-<时间戳>，避免被后续保存覆盖
const fs = require('fs');
const path = require('path');
const { safeStorage } = require('electron');

let dataDir = null;
let lastMtime = 0; // 本进程最后已知的 store.json 修改时间
let corrupt = null; // 最近一次加载失败的信息 { backup, message }
let decryptFailures = 0; // 本次加载中无法解密的密钥数量（用于界面提示）

function init(userDataDir) { dataDir = userDataDir; }
function file() { return path.join(dataDir, 'store.json'); }
function dir() { return dataDir; }

function currentMtime() {
  try { return fs.statSync(file()).mtimeMs; } catch (e) { return 0; }
}

// ---------- 密钥加解密 ----------
function canEncrypt() {
  try { return !!(safeStorage && safeStorage.isEncryptionAvailable()); } catch (e) { return false; }
}
function encryptValue(v) {
  if (v == null || v === '') return v;
  if (typeof v === 'object') return v; // 已是 { enc }
  try { return { enc: safeStorage.encryptString(String(v)).toString('base64') }; }
  catch (e) { return v; } // 加密失败退回明文，保证功能可用
}
function decryptValue(v) {
  if (v == null) return v;
  if (typeof v === 'object') {
    if (!v.enc) { decryptFailures++; return ''; } // 未知格式（手改/异版本数据）：当作空密钥，避免后续 .trim() 崩溃
    try { return safeStorage.decryptString(Buffer.from(v.enc, 'base64')); }
    catch (e) {
      decryptFailures++;
      console.warn('[store] 密钥解密失败（可能来自其它机器/用户），已清空该密钥');
      return '';
    }
  }
  return v; // 旧版明文：原样使用
}

// 只克隆 config（很小），不复制 sessions，避免大历史时每次保存都整份深拷贝
function encryptSecrets(data) {
  if (!data || !data.config || !canEncrypt()) return data;
  const cfg = JSON.parse(JSON.stringify(data.config));
  for (const p of (Array.isArray(cfg.providers) ? cfg.providers : [])) {
    if (p && typeof p === 'object') p.apiKey = encryptValue(p.apiKey);
  }
  if (cfg.search && typeof cfg.search === 'object') cfg.search.apiKey = encryptValue(cfg.search.apiKey);
  return Object.assign({}, data, { config: cfg });
}

// 把 { config, sessions } 里的密钥解密（导入内部 store.json 时也走这里）
function decryptData(data) {
  if (!data || typeof data !== 'object' || !data.config || typeof data.config !== 'object') return data;
  const cfg = data.config;
  for (const p of (Array.isArray(cfg.providers) ? cfg.providers : [])) {
    if (p && typeof p === 'object') p.apiKey = decryptValue(p.apiKey);
  }
  if (cfg.search && typeof cfg.search === 'object') cfg.search.apiKey = decryptValue(cfg.search.apiKey);
  return data;
}

// ---------- 读写 ----------
function load() {
  let raw;
  try {
    raw = fs.readFileSync(file(), 'utf8');
  } catch (e) {
    lastMtime = 0;
    corrupt = null; // 文件不存在：属于首次启动
    return null;
  }
  try {
    const data = JSON.parse(raw);
    lastMtime = currentMtime();
    corrupt = null;
    decryptFailures = 0;
    return decryptData(data);
  } catch (e) {
    // 文件存在但解析失败：保留现场，避免下一次保存把它覆盖掉
    const backup = file() + '.corrupt-' + Date.now();
    try { fs.copyFileSync(file(), backup); corrupt = { backup, message: e.message }; }
    catch (e2) { corrupt = { backup: '', message: e.message }; }
    console.warn('[store] store.json 解析失败，已备份为 ' + (corrupt.backup || '（备份失败）') + '：' + e.message);
    lastMtime = 0;
    return null;
  }
}

function corruptInfo() { return corrupt; }
function decryptInfo() { return decryptFailures; }
// 当前系统是否支持加密（Windows 下为 DPAPI）。不可用时密钥会以明文落盘，界面需要提示。
function encryptionAvailable() { return canEncrypt(); }

function save(data) {
  // 并发检测：磁盘上的 mtime 与本进程记录不一致 => 被其他实例/进程改过
  let conflict = false;
  const cur = currentMtime();
  if (lastMtime && cur && cur !== lastMtime) {
    conflict = true;
    try {
      fs.copyFileSync(file(), file() + '.bak');
      console.warn('[store] 检测到 store.json 被其他实例修改，旧数据已备份为 store.json.bak');
    } catch (e) { /* 备份失败不阻断写入 */ }
  }
  const f = file();
  const tmp = f + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(encryptSecrets(data)), 'utf8');
  fs.renameSync(tmp, f);
  lastMtime = currentMtime();
  return { conflict };
}

module.exports = { init, load, save, dir, corruptInfo, decryptInfo, decryptData, encryptionAvailable };
