'use strict';
// 附件的持久化与内容提取：
// - 图片存 userData/images/<id>.<ext>，消息里只存 {id, ext} 引用，store.json 不膨胀
// - Windows 系统 OCR（PowerShell 调 WinRT OcrEngine）提取图中文字，供纯文本模型使用
// - mmimg:// 协议把图片安全地喂给渲染层 <img>（id/ext 白名单校验，只能访问 images 目录）
// - extractDoc：文档全文提取，双通道按格式路由——PDF/Word 走进程内 JS 库
//   （pdfjs-dist / mammoth），Excel/PPT/RTF/EPUB/HTML 走 markitdown（内置 PyInstaller
//   转换器优先，回落本机命令）；JS 失败也回落 markitdown
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
// 双通道按扩展名路由，互为兜底：
// - JS 通道（进程内，快、无外部依赖风险）：pdf → pdfjs-dist，docx → mammoth
// - markitdown 通道：xlsx / pptx / rtf / epub / html 等；优先用随应用打包的
//   PyInstaller 内置转换器（build/markitdown，onedir、不用 UPX 以降低杀软误报），
//   找不到再回落本机安装的 markitdown 命令；JS 通道失败时也回落 markitdown
const DOC_EXTS = /^(pdf|docx|doc|xlsx|xls|pptx|ppt|rtf|html?|epub)$/i;
// 这两个老格式 JS 库与 markitdown 都不认：给可操作的提示，不笼统报错
const LEGACY_HINT = { doc: '.doc 建议先在 Word 里另存为 .docx 再拖入', xls: '.xls 建议先在 Excel 里另存为 .xlsx 再拖入' };

// 内置转换器 exe：打包后位于 resources/markitdown/；开发态用仓库 build/markitdown/
function bundledConverter() {
  const candidates = [];
  try {
    const { app } = require('electron');
    if (app && app.isPackaged && process.resourcesPath) {
      candidates.push(path.join(process.resourcesPath, 'markitdown', 'markitdown.exe'));
    }
  } catch (e) { /* 非 Electron 环境（测试直接 require）忽略 */ }
  candidates.push(path.join(__dirname, '..', '..', 'build', 'markitdown', 'markitdown.exe'));
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return p; } catch (e) { /* ignore */ }
  }
  return null;
}

function runCmd(cmd, args, timeoutMs, opts) {
  return new Promise((resolve, reject) => {
    const spawnOpts = Object.assign({ shell: true, windowsHide: true }, opts);
    let child;
    try {
      child = spawn(cmd, args, spawnOpts);
    } catch (e) { reject(e); return; }
    const out = [], err = [];
    let settled = false;
    const finish = (fn, v) => { if (!settled) { settled = true; clearTimeout(timer); fn(v); } };
    const timer = setTimeout(() => {
      try { child.kill(); } catch (e) { /* 已退出 */ }
      finish(reject, new Error('解析超时（文档过大或转换器卡住）'));
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

// JS 通道：PDF（pdfjs-dist 惰性加载，避免启动时刷 canvas 警告）
async function extractPdfJs(file) {
  const pdfjs = require('pdfjs-dist/legacy/build/pdf.js');
  const data = new Uint8Array(fs.readFileSync(file));
  const doc = await pdfjs.getDocument({ data: data, verbosity: 0 }).promise;
  try {
    const pages = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const tc = await page.getTextContent();
      let s = '';
      for (const it of tc.items) {
        if (typeof it.str === 'string') {
          s += it.str;
          if (it.hasEOL) s += '\n';
        }
      }
      pages.push(s.trim());
      if (page.cleanup) page.cleanup();
    }
    const text = pages.filter(Boolean).join('\n\n');
    if (!text.trim()) throw new Error('PDF 中没有可提取的文字');
    return text;
  } finally {
    try { if (doc.destroy) doc.destroy(); } catch (e) { /* ignore */ }
  }
}

// JS 通道：Word（mammoth）
async function extractDocxJs(file) {
  const mammoth = require('mammoth');
  const r = await mammoth.extractRawText({ buffer: fs.readFileSync(file) });
  const text = String((r && r.value) || '').trim();
  if (!text) throw new Error('docx 中没有可提取的文字');
  return text;
}

async function extractMarkitdown(file) {
  const bundled = bundledConverter();
  if (bundled) {
    // 绝对路径直启（shell:false，参数数组由 Node 负责转义，路径含空格也安全）
    try {
      return await runCmd(bundled, [file], 90000, { shell: false });
    } catch (e) {
      // 内置转换器对该文件失败：回落系统命令再试一次
    }
  }
  const quoted = '"' + file + '"';
  try {
    return await runCmd('markitdown', [quoted]);
  } catch (e1) {
    try {
      return await runCmd('python', ['-m', 'markitdown', quoted]);
    } catch (e2) {
      throw new Error('文档解析失败：' + (e1.message || e2.message).slice(0, 120) +
        '。也可安装 markitdown 增强（pip install "markitdown[all]"）');
    }
  }
}

async function extractDoc(payload) {
  const p = payload || {};
  const name = String(p.name || 'file');
  const b64 = String(p.base64 || '');
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (!DOC_EXTS.test(ext)) throw new Error('暂不支持该格式（PDF / Word / Excel / PPT / RTF / HTML）');
  if (LEGACY_HINT[ext]) throw new Error(LEGACY_HINT[ext]);
  if (b64.length > 28000000) throw new Error('文件过大（上限 20MB）');
  const tmp = path.join(os.tmpdir(), 'mmc-attach-' + crypto.randomBytes(6).toString('hex') + '.' + ext);
  fs.writeFileSync(tmp, Buffer.from(b64, 'base64'));
  try {
    let text;
    if (ext === 'pdf') {
      try {
        text = await extractPdfJs(tmp);
      } catch (e) {
        text = await extractMarkitdown(tmp); // JS 解不开（如扫描/加密）：回落 markitdown
      }
    } else if (ext === 'docx') {
      try {
        text = await extractDocxJs(tmp);
      } catch (e) {
        text = await extractMarkitdown(tmp);
      }
    } else {
      text = await extractMarkitdown(tmp);
    }
    return { text: text };
  } finally {
    try { fs.unlinkSync(tmp); } catch (e) { /* 清理失败不影响结果 */ }
  }
}

module.exports = { registerScheme, init, saveImage, loadBase64, registerProtocol, gc, extractDoc };
