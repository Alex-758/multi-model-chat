'use strict';
// 附件的持久化与内容提取：
// - 图片存 userData/images/<id>.<ext>，消息里只存 {id, ext} 引用，store.json 不膨胀
// - Windows 系统 OCR（PowerShell 调 WinRT OcrEngine）提取图中文字，供纯文本模型使用
// - mmimg:// 协议把图片安全地喂给渲染层 <img>（id/ext 白名单校验，只能访问 images 目录）
// - extractDoc：PDF/Word/Excel/PPT 等文档全文提取（本机 markitdown 命令，装了就用，没装给明确提示）
// - gc：启动时按全部会话的引用清理孤儿图片（删消息/删会话留下的文件最迟下次启动回收）
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { protocol } = require('electron');

let imagesDir = null;

const MIME_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/bmp': 'bmp' };
const EXT_MIME = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', bmp: 'image/bmp' };
const FILE_RE = /^[a-f0-9]{6,32}\.(png|jpg|webp|bmp)$/i;

// 自定义协议必须在 app ready 之前注册（main.js 顶层调用）
function registerScheme() {
  protocol.registerSchemesAsPrivileged([{ scheme: 'mmimg', privileges: { standard: true } }]);
}

function init(dataDir) {
  imagesDir = path.join(dataDir, 'images');
  try { fs.mkdirSync(imagesDir, { recursive: true }); } catch (e) { /* 已存在或无权限：后续读写各自报错 */ }
}

// id 只认 hex、ext 只认白名单：校验通过才拼路径，杜绝 ../ 之类的路径穿越
function fileOf(id, ext) {
  if (!imagesDir) return null;
  if (!/^[a-f0-9]{6,32}$/.test(String(id || ''))) return null;
  const e = String(ext || '').toLowerCase();
  if (!EXT_MIME[e]) return null;
  return path.join(imagesDir, id + '.' + e);
}

// 保存图片并提取文字。OCR 失败不影响发图：多模态模型仍能看原图，只是纯文本模型拿不到文字
async function saveImage(payload) {
  const p = payload || {};
  const ext = MIME_EXT[String(p.mime || '').toLowerCase()];
  const b64 = String(p.base64 || '');
  if (!ext) throw new Error('不支持的图片格式（支持 PNG / JPG / WebP / BMP）');
  if (!b64) throw new Error('图片数据为空');
  if (b64.length > 7500000) throw new Error('图片过大（上限约 5MB）');
  let buf;
  try { buf = Buffer.from(b64, 'base64'); } catch (e) { throw new Error('图片数据无效'); }
  if (!buf || !buf.length) throw new Error('图片数据无效');
  const id = crypto.randomBytes(8).toString('hex');
  const file = path.join(imagesDir, id + '.' + ext);
  fs.writeFileSync(file, buf);
  let text = '';
  if (process.platform === 'win32') {
    try { text = await ocrFile(file); } catch (e) { text = ''; }
  }
  return { id, ext, text };
}

// 供 providers.js 组装多模态请求体：读不到（文件被清理/换机器）返回 null，调用方自行降级
function loadBase64(id, ext) {
  const file = fileOf(id, ext);
  if (!file) return null;
  try {
    return { base64: fs.readFileSync(file).toString('base64'), mime: EXT_MIME[String(ext).toLowerCase()] };
  } catch (e) { return null; }
}

// mmimg://<id>.<ext> → images 目录里的文件。只认白名单文件名，其余一律 404
function registerProtocol() {
  protocol.handle('mmimg', (request) => {
    let host = '';
    try { host = new URL(request.url).host; } catch (e) { host = ''; }
    if (!FILE_RE.test(host)) return new Response('bad request', { status: 400 });
    const dot = host.lastIndexOf('.');
    const file = fileOf(host.slice(0, dot), host.slice(dot + 1));
    if (!file) return new Response('bad request', { status: 400 });
    try {
      const data = fs.readFileSync(file);
      return new Response(new Uint8Array(data), {
        headers: { 'Content-Type': EXT_MIME[host.slice(dot + 1).toLowerCase()] }
      });
    } catch (e) {
      return new Response('not found', { status: 404 });
    }
  });
}

// 清理没有任何会话引用的图片文件。只动自己命名规则内的文件，目录里的其他东西不碰
function gc(sessions) {
  if (!imagesDir) return;
  const used = new Set();
  for (const s of (Array.isArray(sessions) ? sessions : [])) {
    for (const m of ((s && s.messages) || [])) {
      for (const im of ((m && m.images) || [])) {
        if (im && im.id && im.ext) used.add(im.id + '.' + im.ext);
      }
    }
  }
  let entries = [];
  try { entries = fs.readdirSync(imagesDir); } catch (e) { return; }
  for (const name of entries) {
    if (used.has(name) || !FILE_RE.test(name)) continue;
    try { fs.unlinkSync(path.join(imagesDir, name)); } catch (e) { /* 文件被占用等：留到下次 */ }
  }
}

// ---------- Windows 系统 OCR ----------
// PowerShell 调 WinRT Windows.Media.Ocr：免费、离线、中英文可识别。
// -EncodedCommand 传 UTF-16LE base64，避免中文路径/引号转义问题；
// 脚本内把控制台输出切到 UTF-8，Node 端按 UTF-8 解码，否则中文会变 GBK 乱码。
const OCR_PS = [
  "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8",
  "$ErrorActionPreference='Stop'",
  "try{",
  "Add-Type -AssemblyName System.Runtime.WindowsRuntime",
  "$null=[Windows.Media.Ocr.OcrEngine,Windows.Media.Ocr,ContentType=WindowsRuntime]",
  "$null=[Windows.Graphics.Imaging.BitmapDecoder,Windows.Graphics.Imaging,ContentType=WindowsRuntime]",
  "$null=[Windows.Storage.StorageFile,Windows.Storage,ContentType=WindowsRuntime]",
  "$null=[Windows.Globalization.Language,Windows.Globalization,ContentType=WindowsRuntime]",
  "$asTaskGeneric=([System.WindowsRuntimeSystemExtensions].GetMethods()|Where-Object{$_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'})[0]",
  "Function Await($WinRtTask,$ResultType){$asTask=$asTaskGeneric.MakeGenericMethod($ResultType);$netTask=$asTask.Invoke($null,@($WinRtTask));$netTask.Wait(-1)|Out-Null;$netTask.Result}",
  "$engine=$null",
  "foreach($tag in @('zh-Hans-CN','zh-CN','zh-Hant-TW','en-US')){",
  "  try{ $lang=[Windows.Globalization.Language]::new($tag); if($lang.IsWellFormed){ $e=[Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($lang); if($e){$engine=$e;break} } }catch{}",
  "}",
  "if(-not $engine){$engine=[Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()}",
  "if(-not $engine){Write-Output '__NO_ENGINE__';exit}",
  "$file=Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync('__FILE__')) ([Windows.Storage.StorageFile])",
  "$stream=Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])",
  "$decoder=Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])",
  "$bmp=Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])",
  "if($bmp.BitmapPixelFormat -ne [Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8){$bmp=[Windows.Graphics.Imaging.SoftwareBitmap]::Convert($bmp,[Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8)}",
  "$res=Await ($engine.RecognizeAsync($bmp)) ([Windows.Media.Ocr.OcrResult])",
  "if(-not $res -or -not $res.Text){Write-Output '__NO_TEXT__';exit}",
  "Write-Output $res.Text",
  "}catch{ Write-Output '__NO_TEXT__'; exit }"
].join('\n');

function ocrFile(file) {
  return new Promise((resolve) => {
    const script = OCR_PS.replace('__FILE__', String(file).replace(/'/g, "''"));
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    let child;
    try {
      child = spawn('powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
        { windowsHide: true });
    } catch (e) { resolve(''); return; }
    const chunks = [];
    let settled = false;
    const finish = v => { if (!settled) { settled = true; clearTimeout(timer); resolve(v); } };
    const timer = setTimeout(() => { try { child.kill(); } catch (e) { /* 已退出 */ } finish(''); }, 20000);
    child.stdout.on('data', d => chunks.push(d));
    child.stderr.on('data', () => { /* 引擎缺失等错误统一按无文字处理 */ });
    child.on('error', () => finish(''));
    child.on('close', () => {
      const t = Buffer.concat(chunks).toString('utf8').trim();
      if (t === '__NO_ENGINE__' || t === '__NO_TEXT__') return finish('');
      finish(t);
    });
  });
}

// ---------- 文档全文提取 ----------
// PDF / Word / Excel / PPT 等格式在 Node 侧没有零依赖的可靠解析方案，
// 借用本机已安装的 markitdown（pip 安装的命令行工具）。没装时给出可操作的提示。
const DOC_EXTS = /^(pdf|docx|doc|xlsx|xls|pptx|ppt|rtf|html?|epub)$/i;

function runCmd(cmd, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      // shell:true 让 Windows 按 PATH/PATHEXT 解析命令；文件路径是我们生成的临时 ASCII 名，加引号即可
      child = spawn(cmd, args, { shell: true, windowsHide: true });
    } catch (e) { reject(e); return; }
    const out = [], err = [];
    let settled = false;
    const finish = (fn, v) => { if (!settled) { settled = true; clearTimeout(timer); fn(v); } };
    const timer = setTimeout(() => {
      try { child.kill(); } catch (e) { /* 已退出 */ }
      finish(reject, new Error('解析超时（文档过大或 markitdown 卡住）'));
    }, timeoutMs || 90000);
    child.stdout.on('data', d => out.push(d));
    child.stderr.on('data', d => err.push(d));
    child.on('error', e => finish(reject, e));
    child.on('close', code => {
      if (code === 0) return finish(resolve, Buffer.concat(out).toString('utf8'));
      finish(reject, new Error(Buffer.concat(err).toString('utf8').trim().slice(0, 160) || ('exit ' + code)));
    });
  });
}

async function extractDoc(payload) {
  const p = payload || {};
  const name = String(p.name || 'file');
  const b64 = String(p.base64 || '');
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (!DOC_EXTS.test(ext)) throw new Error('暂不支持该格式（PDF / Word / Excel / PPT / RTF / HTML）');
  if (b64.length > 28000000) throw new Error('文件过大（上限 20MB）');
  const tmp = path.join(os.tmpdir(), 'mmc-attach-' + crypto.randomBytes(6).toString('hex') + '.' + ext);
  fs.writeFileSync(tmp, Buffer.from(b64, 'base64'));
  const quoted = '"' + tmp + '"';
  try {
    try {
      return { text: await runCmd('markitdown', [quoted]) };
    } catch (e1) {
      try {
        return { text: await runCmd('python', ['-m', 'markitdown', quoted]) };
      } catch (e2) {
        throw new Error('本机未找到 markitdown，无法解析 ' + ext.toUpperCase() +
          ' 文档。安装方法：pip install markitdown；或把内容另存为 txt/md 后再拖入');
      }
    }
  } finally {
    try { fs.unlinkSync(tmp); } catch (e) { /* 清理失败不影响结果 */ }
  }
}

module.exports = { registerScheme, init, saveImage, loadBase64, registerProtocol, gc, extractDoc };
