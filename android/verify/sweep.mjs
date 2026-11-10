import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { decodePng, inkStats } from './png.mjs';

const ADB = 'D:/work/android-sdk/platform-tools/adb.exe';
const SER = '5bf0cda4';
const OUT = 'D:/work/Project/Took/android/verify';

const adb = (args) => (spawnSync(ADB, ['-s', SER, ...args], { encoding: 'utf8' }).stdout || '').trim();
const sleep = (ms) => spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},' + ms + ')']);
function tapXY(x, y) { adb(['shell', 'input', 'touchscreen', 'tap', String(Math.round(x)), String(Math.round(y))]); }
function swipe(x1, y1, x2, y2) { adb(['shell', 'input', 'swipe', String(x1), String(y1), String(x2), String(y2), '280']); }
function key(k) { adb(['shell', 'input', 'keyevent', k]); }

function nodes() {
  adb(['shell', 'rm', '-f', '/sdcard/ui.xml']);
  adb(['shell', 'uiautomator', 'dump', '/sdcard/ui.xml']);
  const local = path.join(OUT, '.ui-tmp.xml');
  adb(['pull', '/sdcard/ui.xml', local]);
  const s = fs.readFileSync(local, 'utf8');
  const out = [];
  const re = /<node\b([^>]*)>/g;
  let m;
  while ((m = re.exec(s))) {
    const a = m[1];
    const get = (k) => { const r = new RegExp(' ' + k + '="([^"]*)"').exec(a); return r ? r[1] : ''; };
    const b = /bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(a);
    if (!b) continue;
    const [x1, y1, x2, y2] = b.slice(1).map(Number);
    out.push({ text: get('text'), desc: get('content-desc'), x1, y1, x2, y2, clickable: get('clickable') === 'true' });
  }
  return { xml: s, nodes: out };
}
function tapLabel(pat, exact = false) {
  const { nodes: ns } = nodes();
  const hit = ns.filter(n => {
    const t = n.text || n.desc || '';
    return exact ? t === pat : t.includes(pat);
  });
  if (!hit.length) throw new Error('tapLabel not found: ' + pat);
  const n = hit[0];
  tapXY((n.x1 + n.x2) / 2, (n.y1 + n.y2) / 2);
  return n;
}

function shot(name) {
  adb(['shell', 'screencap', '-p', '/sdcard/s.png']);
  adb(['pull', '/sdcard/s.png', path.join(OUT, name + '.png')]);
}

function capture(prefix, screen, note) {
  const { xml, nodes: ns } = nodes();
  fs.writeFileSync(path.join(OUT, prefix + '-' + screen + '.xml'), xml);
  shot(prefix + '-' + screen);
  const png = path.join(OUT, prefix + '-' + screen + '.png');
  const img = decodePng(fs.readFileSync(png));
  const flags = [];
  for (const nd of ns) {
    const label = nd.text || (nd.desc ? '~' + nd.desc : '');
    if (!label) continue;
    const st = inkStats(img, nd.x1, nd.y1, nd.x2, nd.y2);
    if (!st) continue;
    const w = nd.x2 - nd.x1;
    if (!st.n) flags.push({ kind: 'INVISIBLE', label, box: [nd.x1, nd.y1, nd.x2, nd.y2] });
    if (w >= 200) {
      const dx = (st.cx - (nd.x1 + nd.x2) / 2) / w;
      if (Math.abs(dx) > 0.12) flags.push({ kind: 'OFFCENTER', label, box: [nd.x1, nd.y1, nd.x2, nd.y2], dx: +dx.toFixed(3), click: nd.clickable });
    }
    if (nd.y2 > img.h * 0.9 && nd.x2 < 260) flags.push({ kind: 'BOTTOM-LEFT', label, box: [nd.x1, nd.y1, nd.x2, nd.y2] });
  }
  return { screen, note, nodes: ns.length, flags };
}

const prefix = process.argv[2] || 'auto';
const report = [];

// 首页
adb(['shell', 'am', 'force-stop', 'app.took']);
adb(['shell', 'am', 'start', '-n', 'app.took/.MainActivity']);
sleep(2600);
report.push(capture(prefix, 'home', '首页月历 + 今日条 + 底部 tab'));

// 当天打卡面板（右侧抽屉）
tapLabel('当天安排');
sleep(1400);
report.push(capture(prefix, 'daypanel', '当天打卡面板（右侧抽屉，水平滑入）'));
tapLabel('关闭当天面板');
sleep(1000);

// 配置页
tapLabel('配置', true);
sleep(1200);
report.push(capture(prefix, 'config', '配置页规则列表'));

// 配置页下半（记事 / 倒数日 / 笔记本 空状态）
swipe(540, 1800, 540, 700);
sleep(1000);
report.push(capture(prefix, 'config-memo', '配置页 memo 分组（空状态居中）'));

// 倒数日表单
tapLabel('新建倒数日');
sleep(1500);
report.push(capture(prefix, 'countdown', '倒数日表单（右侧滑入）'));
tapLabel('取消', true);
sleep(1000);

// 记事文档页
tapLabel('新建记事');
sleep(1500);
report.push(capture(prefix, 'doc-note', '记事文档式页'));
tapLabel('返回', true);
sleep(1000);

// 笔记本文档页
tapLabel('新建笔记本');
sleep(1500);
report.push(capture(prefix, 'doc-book', '笔记本文档式页'));
tapLabel('返回', true);
sleep(1000);

// 规则编辑页（含提醒区）
swipe(540, 800, 540, 1900);
sleep(900);
tapLabel('年度体检', true);
sleep(1600);
report.push(capture(prefix, 'editor', '规则编辑页顶部'));
swipe(540, 1900, 540, 500);
sleep(900);
report.push(capture(prefix, 'editor-reminder', '规则编辑页提醒区三按钮'));
tapLabel('‹ 返回');
sleep(1000);

// 设置页
tapLabel('设置', true);
sleep(1400);
report.push(capture(prefix, 'settings', '设置页'));
swipe(540, 1800, 540, 700);
sleep(900);
report.push(capture(prefix, 'settings-2', '设置页下半'));

fs.writeFileSync(path.join(OUT, prefix + '-report.json'), JSON.stringify(report, null, 1));
for (const r of report) {
  console.log('### ' + r.screen + ' (' + r.note + ') nodes=' + r.nodes);
  for (const f of r.flags) console.log('   ' + f.kind + ' ' + JSON.stringify(f.label) + ' box[' + f.box + ']' + (f.dx !== undefined ? ' dx=' + f.dx + (f.click ? ' CLICK' : '') : ''));
  if (!r.flags.length) console.log('   (clean)');
}
