'use strict';
// 打包前预构建 markitdown 内置转换器（PyInstaller onedir）。
// - build/markitdown/markitdown.exe 已存在：跳过
// - Python/依赖可用：pip 补装缺失依赖后跑 PyInstaller（目录模式，不用 onefile/UPX，降低杀软误报）
// - 任何一步失败：写 build/markitdown/_NOT_BUILT.txt 占位并正常退出
//   （electron-builder 的 extraResources 需要目录存在；缺内置转换器只影响
//   PPT/Excel 等格式回落系统 markitdown，JS 通道 PDF/Word 与纯文本不受影响）
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'build', 'markitdown');
const EXE = path.join(OUT_DIR, 'markitdown.exe');
const SPEC_DIR = path.join(ROOT, 'build', '_pyinstaller');
const WRAPPER = path.join(ROOT, 'scripts', 'py', 'markitdown_wrapper.py');

function note(msg) { console.log('[markitdown] ' + msg); }

// Node 的 shell:true 不做参数转义（原样拼接）：含空格/特殊字符的参数必须自己加引号，
// 否则 python -c 的代码串会被空格截断
function q(a) {
  return /[\s"^&|<>()!]/.test(a) ? '"' + a.replace(/"/g, '') + '"' : a;
}

function run(cmd, args, opts) {
  const line = [cmd].concat(args).map(q).join(' ');
  const r = spawnSync(line, Object.assign({ encoding: 'utf8', windowsHide: true, shell: true }, opts));
  return { ok: r.status === 0, out: (r.stdout || '') + (r.stderr || '') };
}

function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }

function placeholder(msg) {
  ensureDir(OUT_DIR);
  fs.writeFileSync(path.join(OUT_DIR, '_NOT_BUILT.txt'), msg + '\n', 'utf8');
}

// Python 依赖检查：转换器用到的格式库 + PyInstaller 本体
const PY_CHECK = "import importlib.util,sys;" +
  "mods=['markitdown','pptx','openpyxl','mammoth','striprtf','ebooklib'];" +
  "missing=[m for m in mods if importlib.util.find_spec(m) is None];" +
  "print(','.join(missing));sys.exit(0)";

// Windows 商店的 python 桩在非交互 shell 里会失败：逐个探测真实解释器
function findPython() {
  for (const cmd of ['python', 'python3', 'py -3']) {
    const r = run(cmd, ['-c', "print('ok')"]);
    if (r.ok && r.out.trim().endsWith('ok')) return cmd;
  }
  return null;
}

function main() {
  if (fs.existsSync(EXE)) { note('已存在，跳过（' + EXE + '）'); return 0; }
  ensureDir(SPEC_DIR);

  const pyCmd = findPython();
  if (!pyCmd) {
    placeholder('预构建失败：本机没有可用的 python（商店桩/PATH 问题）');
    note('WARN 找不到 python，本次不内置 markitdown（JS 通道不受影响）');
    return 0;
  }
  const py = run(pyCmd, ['-c', PY_CHECK]);
  if (!py.ok) {
    placeholder('预构建失败：python 无法执行依赖检查（' + py.out.trim() + '）');
    note('WARN python 运行异常，本次不内置 markitdown');
    return 0;
  }
  const missing = py.out.trim().split(',').filter(Boolean);
  const hasPyInstaller = run(pyCmd, ['-m', 'PyInstaller', '--version']).ok;
  if (missing.length || !hasPyInstaller) {
    note('安装缺失依赖：' + (missing.join(' ') || 'pyinstaller'));
    const pkgs = ['pyinstaller'].concat(missing.length ? ['markitdown[all]'] : []);
    const ins = run(pyCmd, ['-m', 'pip', 'install', '--quiet', '--disable-pip-version-check'].concat(pkgs), { timeout: 600000 });
    if (!ins.ok) {
      placeholder('预构建失败：pip 安装依赖未成功（' + ins.out.trim().slice(-200) + '）');
      note('WARN 依赖安装失败，本次不内置 markitdown');
      return 0;
    }
  }

  note('PyInstaller 打包中（onedir，约 1~3 分钟）…');
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  // 排除音频转写链（speech_recognition/pydub ≈45MB）：markitdown 对其缺失有
  // try/except 保护，只在真正转写音频时才报错——我们只转文档，用不到。
  // onnxruntime 不能排：magika（内容嗅探）在模块顶层硬导入它，排除会崩；
  // pandas/numpy 必须保留（xlsx 转换依赖）。
  const excludes = ['--exclude-module', 'speech_recognition', '--exclude-module', 'pydub',
    // magika 的 ONNX 模型是包内数据文件，PyInstaller 默认不收：不收会 MagikaError
    '--collect-all', 'magika'];
  const parts = pyCmd.split(' '); // 'py -3' → ['py', '-3']
  const build = run(parts[0], parts.slice(1).concat(['-m', 'PyInstaller', '--noconfirm', '--clean']
    .concat(excludes, [
      '--name', 'markitdown', '--distpath', path.join(ROOT, 'build'),
      '--workpath', SPEC_DIR, '--specpath', SPEC_DIR, WRAPPER])), { timeout: 600000 });
  if (!build.ok || !fs.existsSync(EXE)) {
    placeholder('预构建失败：PyInstaller 未产出 exe（' + build.out.trim().slice(-200) + '）');
    note('WARN 打包失败，本次不内置 markitdown');
    return 0;
  }
  note('完成：' + EXE);
  return 0;
}

process.exit(main());
