import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const ADB = 'D:/work/android-sdk/platform-tools/adb.exe';
const SER = '5bf0cda4';
const OUT = 'D:/work/Project/Took/android/verify';
const adb = (a) => (spawnSync(ADB, ['-s', SER, ...a], { encoding: 'utf8' }).stdout || '').trim();
const sleep = (ms) => spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},' + ms + ')']);
function tapXY(x, y) { adb(['shell', 'input', 'touchscreen', 'tap', String(Math.round(x)), String(Math.round(y))]); }

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

function find(ns, pat) {
  return ns.find(n => (n.text && n.text.includes(pat)) || (n.desc && n.desc.includes(pat)));
}

function frames(label, pat, count) {
  const rows = [];
  for (let i = 0; i < count; i++) {
    const ns = nodes();
    const n = find(ns, pat);
    rows.push({ t: i, node: n ? [n.x1, n.y1, n.x2, n.y2] : null });
    if (n) adb(['shell', 'screencap', '-p', '/sdcard/f.png']), adb(['pull', '/sdcard/f.png', path.join(OUT, 'anim-' + label + '-' + i + '.png')]);
    sleep(500);
  }
  return rows;
}

const out = {};
adb(['shell', 'settings', 'put', 'global', 'animator_duration_scale', '10']);
adb(['shell', 'settings', 'put', 'global', 'transition_animation_scale', '10']);
sleep(400);

// 1) 当天打卡面板：从首页点日期
adb(['shell', 'am', 'force-stop', 'app.took']);
adb(['shell', 'am', 'start', '-n', 'app.took/.MainActivity']);
sleep(3000);
const home = nodes();
const cell = home.find(n => n.desc && n.desc.includes('2026-10-24 当天安排'));
tapXY((cell.x1 + cell.x2) / 2, (cell.y1 + cell.y2) / 2);
out.daypanel = frames('daypanel', '关闭当天面板', 5);
adb(['shell', 'input', 'keyevent', 'KEYCODE_BACK']);
sleep(2500);

// 2) 规则编辑 Dialog：配置页点规则标题
const cfg = nodes();
const tab = cfg.find(n => n.text === '配置');
tapXY((tab.x1 + tab.x2) / 2, (tab.y1 + tab.y2) / 2);
sleep(1200);
const list = nodes();
const rule = list.find(n => n.text === '年度体检');
tapXY((rule.x1 + rule.x2) / 2, (rule.y1 + rule.y2) / 2);
out.editor = frames('editor', '返回配置页', 5);

adb(['shell', 'settings', 'put', 'global', 'animator_duration_scale', '1']);
adb(['shell', 'settings', 'put', 'global', 'transition_animation_scale', '1']);
console.log(JSON.stringify(out, null, 1));
