'use strict';
// 改名迁移回归（Jury ← Multi-Model Chat）：对临时目录直接测 migrateLegacyData 纯函数。
// 覆盖：正常迁移（store/catalog/window-state + images 递归）、幂等（新目录已有数据不覆盖）、
//       旧目录无数据不动作、旧目录缺 catalog/window-state 也能迁、新目录不存在时自动创建
// 真实 main.js 在模块顶部自启（whenReady），require 它拿 _migrateForTest 出口
const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
function check(label, ok, detail) {
  if (ok) { pass++; console.log('  PASS ' + label); }
  else { fail++; console.log('  FAIL ' + label + (detail !== undefined ? ' -> ' + JSON.stringify(detail) : '')); }
}

// temp userData（防止 main.js 启动过程触碰真实数据目录）
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'mmc-migrate-'));
app.setPath('userData', DATA);
const main = require(path.join(ROOT, 'src', 'main', 'main.js'));

app.whenReady().then(async () => {
  await sleep(300);
  const mig = main && main._migrateForTest;
  check('main.js 导出 _migrateForTest', typeof mig === 'function', typeof mig);
  if (typeof mig !== 'function') { finish(); return; }

  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mmc-migfix-'));
  const legacy = path.join(base, 'Multi-Model Chat');
  const fresh = path.join(base, 'Jury');
  fs.mkdirSync(legacy);
  fs.writeFileSync(path.join(legacy, 'store.json'), JSON.stringify({ config: { marker: 'old-dir' }, sessions: [{ id: 's1' }] }));
  fs.writeFileSync(path.join(legacy, 'catalog.json'), 'CATALOG');
  fs.writeFileSync(path.join(legacy, 'window-state.json'), '{"x":5}');
  fs.mkdirSync(path.join(legacy, 'images', 'sub'), { recursive: true });
  fs.writeFileSync(path.join(legacy, 'images', 'a.png'), 'A');
  fs.writeFileSync(path.join(legacy, 'images', 'sub', 'b.png'), 'B');

  // 1) 正常迁移：新目录连 fresh 目录本身都不存在
  const r1 = mig(fresh, legacy);
  check('迁移标记 migrated=true', r1 && r1.migrated === true, r1);
  check('复制清单含 store.json/catalog.json/window-state.json/images/',
    r1 && ['store.json', 'catalog.json', 'window-state.json', 'images/'].every(f => r1.copied.indexOf(f) >= 0), r1 && r1.copied);
  const store = JSON.parse(fs.readFileSync(path.join(fresh, 'store.json'), 'utf8'));
  check('store.json 内容原样复制（含密钥标记）', store.config && store.config.marker === 'old-dir' && store.sessions.length === 1, store);
  check('catalog.json / window-state.json 落位', fs.readFileSync(path.join(fresh, 'catalog.json'), 'utf8') === 'CATALOG' &&
    fs.readFileSync(path.join(fresh, 'window-state.json'), 'utf8') === '{"x":5}', '');
  check('images/ 递归复制（含子目录）', fs.readFileSync(path.join(fresh, 'images', 'a.png'), 'utf8') === 'A' &&
    fs.readFileSync(path.join(fresh, 'images', 'sub', 'b.png'), 'utf8') === 'B', '');
  check('旧目录原样保留（回退保险）', fs.existsSync(path.join(legacy, 'store.json')) && fs.existsSync(path.join(legacy, 'images', 'sub', 'b.png')), '');

  // 2) 幂等：新目录已有 store.json 不再动作
  fs.writeFileSync(path.join(fresh, 'store.json'), JSON.stringify({ config: { marker: 'new-dir' }, sessions: [] }));
  const r2 = mig(fresh, legacy);
  check('新目录已有数据时 migrated=false', r2 && r2.migrated === false, r2);
  check('新数据未被旧数据覆盖', JSON.parse(fs.readFileSync(path.join(fresh, 'store.json'), 'utf8')).config.marker === 'new-dir', '');

  // 3) 旧目录无数据：不动作
  const emptyLegacy = path.join(base, 'Empty Legacy');
  const fresh2 = path.join(base, 'Jury2');
  fs.mkdirSync(emptyLegacy);
  const r3 = mig(fresh2, emptyLegacy);
  check('旧目录无 store.json 时不动作', r3 && r3.migrated === false && !fs.existsSync(fresh2), r3);

  // 4) 旧目录只有 store.json（缺 catalog/window-state/images）：也能迁
  const partial = path.join(base, 'Partial');
  const fresh3 = path.join(base, 'Jury3');
  fs.mkdirSync(partial);
  fs.writeFileSync(path.join(partial, 'store.json'), '{"config":{},"sessions":[]}');
  const r4 = mig(fresh3, partial);
  check('旧目录缺可选文件也能迁移', r4 && r4.migrated === true && fs.existsSync(path.join(fresh3, 'store.json')) &&
    !fs.existsSync(path.join(fresh3, 'catalog.json')), r4);

  finish();
}).catch(e => { fail++; console.log('  FAIL 执行异常 -> ' + (e && e.message)); finish(); });

function finish() {
  console.log('\nRESULT pass=' + pass + ' fail=' + fail);
  app.exit(fail ? 1 : 0);
}
