import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const ADB = 'D:/work/android-sdk/platform-tools/adb.exe';
const SER = '5bf0cda4';
const OUT = 'D:/work/Project/Took/android/verify';

function adb(args) {
  const r = spawnSync(ADB, ['-s', SER, ...args], { encoding: 'utf8' });
  return { out: (r.stdout || '').trim(), err: (r.stderr || '').trim(), code: r.status };
}

function dumpRaw() {
  adb(['shell', 'rm', '-f', '/sdcard/ui.xml']);
  adb(['shell', 'uiautomator', 'dump', '/sdcard/ui.xml']);
  const local = path.join(OUT, '.ui-tmp.xml');
  adb(['pull', '/sdcard/ui.xml', local]);
  const s = fs.readFileSync(local, 'utf8');
  const nodes = [];
  const re = /<node\b([^>]*)>/g;
  let m;
  while ((m = re.exec(s))) {
    const a = m[1];
    const get = (k) => { const r = new RegExp(' ' + k + '="([^"]*)"').exec(a); return r ? r[1] : ''; };
    const b = /bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(a);
    if (!b) continue;
    const [x1, y1, x2, y2] = b.slice(1).map(Number);
    nodes.push({
      text: get('text'), desc: get('content-desc'),
      cls: get('class').replace('android.widget.', '').replace('androidx.compose.ui.', ''),
      x1, y1, x2, y2,
      clickable: get('clickable') === 'true',
      scrollable: get('scrollable') === 'true',
    });
  }
  return { xml: s, nodes };
}

function report(nodes) {
  const lines = [];
  for (const n of nodes) {
    const label = n.text || (n.desc ? '~' + n.desc : '');
    if (!label) continue;
    lines.push([n.x1 + '..' + n.x2, n.y1 + '..' + n.y2, n.cls, JSON.stringify(label), n.clickable ? 'CLICK' : ''].join(' | '));
  }
  return lines.join('\n');
}

const cmd = process.argv[2];
if (cmd === 'dump') {
  const name = process.argv[3] || 'shot';
  const { xml, nodes } = dumpRaw();
  fs.writeFileSync(path.join(OUT, name + '.xml'), xml);
  console.log(report(nodes));
} else if (cmd === 'tap') {
  const pat = process.argv[3];
  const { nodes } = dumpRaw();
  const hit = nodes.filter(n => (n.text && n.text.includes(pat)) || (n.desc && n.desc.includes(pat)));
  if (!hit.length) { console.error('NOT FOUND: ' + pat); process.exit(2); }
  const n = hit[hit.length - 1];
  const cx = Math.round((n.x1 + n.x2) / 2), cy = Math.round((n.y1 + n.y2) / 2);
  console.log('tap ' + JSON.stringify(n.text || n.desc) + ' @ ' + cx + ',' + cy);
  console.log(adb(['shell', 'input', 'touchscreen', 'tap', String(cx), String(cy)]).out);
} else if (cmd === 'tapxy') {
  console.log(adb(['shell', 'input', 'touchscreen', 'tap', process.argv[3], process.argv[4]]).out);
} else if (cmd === 'shot') {
  const name = process.argv[3];
  adb(['shell', 'screencap', '-p', '/sdcard/s.png']);
  adb(['pull', '/sdcard/s.png', path.join(OUT, name)]);
  console.log('saved ' + name);
} else if (cmd === 'key') {
  console.log(adb(['shell', 'input', 'keyevent', process.argv[3]]).out);
}
