import fs from 'fs';
import path from 'path';
import { decodePng, inkStats } from './png.mjs';
const OUT = 'D:/work/Project/Took/android/verify';
const bases = process.argv.slice(2);

function parse(xml) {
  const nodes = [];
  const re = /<node\b([^>]*)>/g;
  let m;
  while ((m = re.exec(xml))) {
    const a = m[1];
    const get = (k) => { const r = new RegExp(' ' + k + '="([^"]*)"').exec(a); return r ? r[1] : ''; };
    const b = /bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(a);
    if (!b) continue;
    const [x1, y1, x2, y2] = b.slice(1).map(Number);
    nodes.push({ text: get('text'), desc: get('content-desc'), x1, y1, x2, y2, clickable: get('clickable') === 'true' });
  }
  return nodes;
}

for (const base of bases) {
  const xmlPath = path.join(OUT, base + '.xml');
  const pngPath = path.join(OUT, base + '.png');
  if (!fs.existsSync(xmlPath) || !fs.existsSync(pngPath)) { console.log(base + ': MISSING'); continue; }
  const nodes = parse(fs.readFileSync(xmlPath, 'utf8'));
  const img = decodePng(fs.readFileSync(pngPath));
  const issues = [];
  for (const nd of nodes) {
    const label = nd.text || (nd.desc ? '~' + nd.desc : '');
    if (!label) continue;
    const st = inkStats(img, nd.x1, nd.y1, nd.x2, nd.y2);
    if (!st) continue;
    const w = nd.x2 - nd.x1, h = nd.y2 - nd.y1;
    if (!st.n) { issues.push('INVISIBLE ' + JSON.stringify(label) + ' [' + nd.x1 + ',' + nd.y1 + ',' + nd.x2 + ',' + nd.y2 + ']'); continue; }
    const dx = (st.cx - (nd.x1 + nd.x2) / 2) / Math.max(1, w);
    const dy = (st.cy - (nd.y1 + nd.y2) / 2) / Math.max(1, h);
    const overflow = st.bbox[0] < nd.x1 - 2 || st.bbox[1] < nd.y1 - 2 || st.bbox[2] > nd.x2 + 2 || st.bbox[3] > nd.y2 + 2;
    if (overflow) issues.push('OVERFLOW ' + JSON.stringify(label) + ' box[' + [nd.x1, nd.y1, nd.x2, nd.y2] + '] ink[' + st.bbox + ']');
    // 大盒子（>=200 宽）里的文字偏心：只有「看着像按钮/居中容器」的才报
    if (w >= 200 && Math.abs(dx) > 0.12) issues.push('OFFCENTER ' + JSON.stringify(label) + ' box[' + [nd.x1, nd.y1, nd.x2, nd.y2] + '] w=' + w + ' dx=' + dx.toFixed(3) + ' dy=' + dy.toFixed(3) + (nd.clickable ? ' CLICK' : ''));
    // 文字贴在屏幕左下角（x1<120 且 y2 > 屏高*0.9），排除底部 tab 栏
    const H = img.h;
    if (nd.y2 > H * 0.9 && nd.x2 < 260) issues.push('BOTTOM-LEFT ' + JSON.stringify(label) + ' box[' + [nd.x1, nd.y1, nd.x2, nd.y2] + ']');
  }
  console.log('=== ' + base + ' (' + nodes.length + ' nodes) ===');
  for (const i of issues) console.log('  ' + i);
  if (!issues.length) console.log('  (clean)');
}
