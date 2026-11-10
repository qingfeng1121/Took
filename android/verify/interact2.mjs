import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
const ADB = 'D:/work/android-sdk/platform-tools/adb.exe';
const SER = '5bf0cda4';
const OUT = 'D:/work/Project/Took/android/verify';
const adb = (a) => (spawnSync(ADB, ['-s', SER, ...a], { encoding: 'utf8' }).stdout || '').trim();
const sleep = (ms) => spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},' + ms + ')']);
const tap = (x, y) => adb(['shell', 'input', 'touchscreen', 'tap', String(Math.round(x)), String(Math.round(y))]);
function nodes() {
  adb(['shell', 'rm', '-f', '/sdcard/i2.xml']);
  adb(['shell', 'uiautomator', 'dump', '/sdcard/i2.xml']);
  const local = path.join(OUT, '.i2-tmp.xml');
  adb(['pull', '/sdcard/i2.xml', local]);
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
    out.push({ label: get('text') || (get('content-desc') ? '~' + get('content-desc') : ''), x1, y1, x2, y2 });
  }
  return out;
}
const find = (ns, pat) => ns.find(n => n.label && n.label.includes(pat));
const states = () => nodes().filter(n => n.label.includes('打卡 ') || (n.label.includes('打卡') && n.label.startsWith('~'))).map(n => n.label);

adb(['shell', 'am', 'force-stop', 'app.took']);
adb(['shell', 'am', 'start', '-n', 'app.took/.MainActivity']);
sleep(2600);
let ns = nodes();
const cell = find(ns, '2026-10-24 当天安排');
tap((cell.x1 + cell.x2) / 2, (cell.y1 + cell.y2) / 2);
sleep(1300);
ns = nodes();
const row = ns.find(n => n.label.startsWith('~') && n.label.includes(' 打卡 '));
const out = { rowLabel: row.label, box: [row.x1, row.y1, row.x2, row.y2], seq: [] };
out.seq.push({ t: 'before', state: states() });
tap((row.x1 + row.x2) / 2, (row.y1 + row.y2) / 2);
sleep(1500);
out.seq.push({ t: 'after1', state: states() });
const row2 = nodes().find(n => n.label.startsWith('~') && n.label.includes(' 打卡 '));
tap((row2.x1 + row2.x2) / 2, (row2.y1 + row2.y2) / 2);
sleep(1500);
out.seq.push({ t: 'after2(还原)', state: states() });
adb(['shell', 'input', 'keyevent', 'KEYCODE_BACK']);
console.log(JSON.stringify(out, null, 1));
