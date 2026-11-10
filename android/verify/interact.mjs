import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
const ADB = 'D:/work/android-sdk/platform-tools/adb.exe';
const SER = '5bf0cda4';
const OUT = 'D:/work/Project/Took/android/verify';
const adb = (a) => (spawnSync(ADB, ['-s', SER, ...a], { encoding: 'utf8' }).stdout || '').trim();
const sleep = (ms) => spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},' + ms + ')']);
const tap = (x, y) => adb(['shell', 'input', 'touchscreen', 'tap', String(Math.round(x)), String(Math.round(y))]);
const longPress = (x, y) => adb(['shell', 'input', 'swipe', String(Math.round(x)), String(Math.round(y)), String(Math.round(x)), String(Math.round(y)), '900']);
function nodes() {
  adb(['shell', 'rm', '-f', '/sdcard/i.xml']);
  adb(['shell', 'uiautomator', 'dump', '/sdcard/i.xml']);
  const local = path.join(OUT, '.i-tmp.xml');
  adb(['pull', '/sdcard/i.xml', local]);
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

const log = [];
adb(['shell', 'am', 'force-stop', 'app.took']);
adb(['shell', 'am', 'start', '-n', 'app.took/.MainActivity']);
sleep(2600);

// 1 打开当天面板 → 点任务行 → 状态应翻转
let ns = nodes();
const cell = find(ns, '2026-10-24 当天安排');
tap((cell.x1 + cell.x2) / 2, (cell.y1 + cell.y2) / 2);
sleep(1300);
ns = nodes();
const rowBefore = ns.filter(n => n.label.includes('打卡')).map(n => n.label);
const row = find(ns, '打卡');
tap((row.x1 + row.x2) / 2, (row.y1 + row.y2) / 2);
sleep(1400);
ns = nodes();
const rowAfter = ns.filter(n => n.label.includes('打卡')).map(n => n.label);
log.push({ step: '点任务行切换打卡', before: rowBefore, after: rowAfter });

// 还原（再点一次）
const row2 = find(ns, '打卡');
tap((row2.x1 + row2.x2) / 2, (row2.y1 + row2.y2) / 2);
sleep(1400);
log.push({ step: '再点一次还原', after: nodes().filter(n => n.label.includes('打卡')).map(n => n.label) });

// 2 关闭抽屉
const closeBtn = find(nodes(), '关闭当天面板');
tap((closeBtn.x1 + closeBtn.x2) / 2, (closeBtn.y1 + closeBtn.y2) / 2);
sleep(1200);
log.push({ step: '关闭抽屉后仍在首页', screen: nodes().some(n => n.label.includes('2026 年')) });

// 3 配置页：点规则卡 → 编辑页应在（而不是被下层的卡片同时打开）
const tab = find(nodes(), '配置');
tap((tab.x1 + tab.x2) / 2, (tab.y1 + tab.y2) / 2);
sleep(1200);
const rule = find(nodes(), '年度体检');
tap((rule.x1 + rule.x2) / 2, (rule.y1 + rule.y2) / 2);
sleep(1500);
ns = nodes();
log.push({ step: '点规则卡', editorOpen: !!find(ns, '编辑规则'), title: find(ns, '编辑规则') ? '编辑规则' : null });
adb(['shell', 'input', 'keyevent', 'KEYCODE_BACK']);
sleep(1200);

// 4 长按规则卡 → 应出菜单（编辑/删除）
ns = nodes();
const rule2 = find(ns, '年度体检');
longPress((rule2.x1 + rule2.x2) / 2, (rule2.y1 + rule2.y2) / 2);
sleep(900);
ns = nodes();
log.push({ step: '长按规则卡', menuEdit: !!find(ns, '~编辑') || !!find(ns, '编辑'), menuDelete: !!ns.find(n => n.label === '删除') });
adb(['shell', 'input', 'keyevent', 'KEYCODE_BACK']);
console.log(JSON.stringify(log, null, 1));
