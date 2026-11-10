import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { decodePng } from './png.mjs';

const ADB = 'D:/work/android-sdk/platform-tools/adb.exe';
const SER = '5bf0cda4';
const OUT = 'D:/work/Project/Took/android/verify';
const adb = (a) => (spawnSync(ADB, ['-s', SER, ...a], { encoding: 'utf8' }).stdout || '').trim();
const sleep = (ms) => spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},' + ms + ')']);
function tapXY(x, y) { adb(['shell', 'input', 'touchscreen', 'tap', String(Math.round(x)), String(Math.round(y))]); }
const T0 = Date.now();

function cap(name) {
  const buf = spawnSync(ADB, ['-s', SER, 'exec-out', 'screencap', '-p'], { maxBuffer: 40 * 1024 * 1024 }).stdout;
  const t = Date.now() - T0;
  const file = path.join(OUT, name + '.png');
  fs.writeFileSync(file, buf);
  return { img: decodePng(buf), t };
}

function px(img, x, y) {
  const i = (y * img.w + x) * img.channels;
  return [img.data[i], img.data[i + 1], img.data[i + 2]];
}
const isWhite = (p) => p[0] > 246 && p[1] > 246 && p[2] > 246;
const isOrange = (p) => p[0] > 230 && p[1] > 90 && p[1] < 160 && p[2] < 90;

function nodes() {
  adb(['shell', 'rm', '-f', '/sdcard/a.xml']);
  adb(['shell', 'uiautomator', 'dump', '/sdcard/a.xml']);
  const local = path.join(OUT, '.anim-tmp.xml');
  adb(['pull', '/sdcard/a.xml', local]);
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
    out.push({ text: get('text'), desc: get('content-desc'), x1, y1, x2, y2 });
  }
  return out;
}

// 抽屉左边缘：在 y=400 从左往右找第一段连续白色（抽屉底色）
function drawerLeftEdge(img, y) {
  for (let x = 0; x < img.w; x++) if (isWhite(px(img, x, y))) {
    let ok = 0;
    for (let k = 0; k < 40 && x + k < img.w; k++) if (isWhite(px(img, x + k, y))) ok++;
    if (ok >= 40) return x;
  }
  return -1;
}
// 抽屉顶边：在 x=1060 从上往下找第一段连续白色
function drawerTopEdge(img, x) {
  for (let y = 0; y < img.h; y++) if (isWhite(px(img, x, y))) {
    let ok = 0;
    for (let k = 0; k < 40 && y + k < img.h; k++) if (isWhite(px(img, x, y + k))) ok++;
    if (ok >= 40) return y;
  }
  return -1;
}
// 底部主按钮（橙色）的墨迹框
function orangeBox(img, y0, y1) {
  let minX = 1e9, maxX = -1, minY = 1e9, maxY = -1, n = 0;
  for (let y = y0; y < y1; y++) for (let x = 0; x < img.w; x += 2) {
    if (isOrange(px(img, x, y))) { n++; if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
  }
  return n ? { minX, maxX, minY, maxY, n } : null;
}

const outDir = {  };
adb(['shell', 'settings', 'put', 'global', 'animator_duration_scale', '10']);
sleep(300);

// 1) 当天打卡抽屉
adb(['shell', 'am', 'force-stop', 'app.took']);
adb(['shell', 'am', 'start', '-n', 'app.took/.MainActivity']);
sleep(3000);
const cell = nodes().find(n => n.desc && n.desc.includes('2026-10-24 当天安排'));
tapXY((cell.x1 + cell.x2) / 2, (cell.y1 + cell.y2) / 2);
const dial = [];
for (let i = 0; i < 8; i++) {
  const { img, t } = cap('anim-drawer-' + i);
  dial.push({ t_ms: t, left_edge_x: drawerLeftEdge(img, 400), top_edge_y: drawerTopEdge(img, 1060) });
  sleep(120);
}
sleep(2600);
{ const { img, t } = cap('anim-drawer-final'); dial.push({ t_ms: t, left_edge_x: drawerLeftEdge(img, 400), top_edge_y: drawerTopEdge(img, 1060) }); }
outDir.drawer = dial;
adb(['shell', 'input', 'keyevent', 'KEYCODE_BACK']);
sleep(3000);

// 2) 规则编辑 Dialog（底部橙色主按钮作为位移标尺）
const tab = nodes().find(n => n.text === '配置');
tapXY((tab.x1 + tab.x2) / 2, (tab.y1 + tab.y2) / 2);
sleep(1200);
const rule = nodes().find(n => n.text === '年度体检');
tapXY((rule.x1 + rule.x2) / 2, (rule.y1 + rule.y2) / 2);
const ed = [];
for (let i = 0; i < 8; i++) {
  const { img, t } = cap('anim-editor-' + i);
  ed.push({ t_ms: t, button: orangeBox(img, 2100, 2380) });
  sleep(120);
}
sleep(2600);
{ const { img, t } = cap('anim-editor-final'); ed.push({ t_ms: t, button: orangeBox(img, 2100, 2380) }); }
outDir.editor = ed;

adb(['shell', 'settings', 'put', 'global', 'animator_duration_scale', '1']);
console.log(JSON.stringify(outDir, null, 1));
