import fs from 'fs';
import { decodePng, inkStats } from './png.mjs';

const OUT = 'D:/work/Project/Took/android/verify';
function parse(xml) {
  const out = [];
  const re = /<node\b([^>]*)>/g;
  let m;
  while ((m = re.exec(xml))) {
    const a = m[1];
    const get = (k) => { const r = new RegExp(' ' + k + '="([^"]*)"').exec(a); return r ? r[1] : ''; };
    const b = /bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(a);
    if (!b) continue;
    const [x1, y1, x2, y2] = b.slice(1).map(Number);
    out.push({ label: get('text') || (get('content-desc') ? '~' + get('content-desc') : ''), x1, y1, x2, y2, clickable: get('clickable') === 'true' });
  }
  return out;
}
function load(base) {
  const x = base + '.xml', p = base + '.png';
  if (!fs.existsSync(x)) return null;
  const nodes = parse(fs.readFileSync(x, 'utf8'));
  const img = fs.existsSync(p) ? decodePng(fs.readFileSync(p)) : null;
  return { nodes, img };
}
const want = (process.argv[2] || '').split(',').filter(Boolean);
for (const base of process.argv.slice(3)) {
  const d = load(base);
  if (!d) { console.log(base + ': MISSING'); continue; }
  console.log('=== ' + base + ' ===');
  for (const n of d.nodes) {
    if (!n.label) continue;
    if (want.length && !want.some(w => n.label.includes(w))) continue;
    const h = n.y2 - n.y1, w = n.x2 - n.x1;
    let extra = '';
    if (d.img) {
      const st = inkStats(d.img, n.x1, n.y1, n.x2, n.y2);
      if (st && st.n) extra = ' inkDx=' + ((st.cx - (n.x1 + n.x2) / 2) / Math.max(1, w)).toFixed(3);
      else if (st) extra = ' ink=none';
    }
    console.log('  ' + JSON.stringify(n.label) + ' box[' + n.x1 + ',' + n.y1 + ',' + n.x2 + ',' + n.y2 + '] w=' + w + ' h=' + h + ' (' + (h / 2.75).toFixed(1) + 'dp)' + extra);
  }
}
