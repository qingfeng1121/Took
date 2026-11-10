import fs from 'fs';
import { decodePng, inkStats } from './png.mjs';

const [xmlFile, pngFile] = process.argv.slice(2);
const xml = fs.readFileSync(xmlFile, 'utf8');
const img = decodePng(fs.readFileSync(pngFile));
console.log('image ' + img.w + 'x' + img.h + ' ch=' + img.channels);

const nodes = [];
const re = /<node\b([^>]*)>/g;
let m;
while ((m = re.exec(xml))) {
  const a = m[1];
  const get = (k) => { const r = new RegExp(' ' + k + '="([^"]*)"').exec(a); return r ? r[1] : ''; };
  const b = /bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(a);
  if (!b) continue;
  const [x1, y1, x2, y2] = b.slice(1).map(Number);
  const text = get('text'), desc = get('content-desc');
  if (!text && !desc) continue;
  nodes.push({ label: text || ('~' + desc), x1, y1, x2, y2, clickable: get('clickable') === 'true' });
}

const rows = [];
for (const nd of nodes) {
  const st = inkStats(img, nd.x1, nd.y1, nd.x2, nd.y2);
  if (!st) continue;
  if (!st.n) { rows.push({ ...nd, ink: 0 }); continue; }
  const w = nd.x2 - nd.x1, h = nd.y2 - nd.y1;
  const dx = (st.cx - (nd.x1 + nd.x2) / 2) / Math.max(1, w);
  const dy = (st.cy - (nd.y1 + nd.y2) / 2) / Math.max(1, h);
  const overflow = st.bbox[0] < nd.x1 - 2 || st.bbox[1] < nd.y1 - 2 || st.bbox[2] > nd.x2 + 2 || st.bbox[3] > nd.y2 + 2;
  rows.push({ ...nd, ink: st.n, dx: +dx.toFixed(3), dy: +dy.toFixed(3), overflow, inkBox: st.bbox });
}

console.log('--- clickable 节点：墨迹重心相对盒子中心的偏移（dx/dy 归一化，|x|>0.12 视为偏心）---');
for (const r of rows.filter(r => r.clickable && r.dx !== undefined)) {
  const flag = Math.abs(r.dx) > 0.12 ? (r.dx < 0 ? '  << LEFT' : '  << RIGHT') : '';
  console.log([r.label, 'box[' + r.x1 + ',' + r.y1 + ',' + r.x2 + ',' + r.y2 + '] w=' + (r.x2 - r.x1) + ' h=' + (r.y2 - r.y1), 'ink=' + r.ink, 'dx=' + r.dx, 'dy=' + r.dy, r.overflow ? 'OVERFLOW' : ''].join(' | ') + flag);
}
console.log('--- 墨迹溢出自身盒子（文字跑出控件范围）---');
for (const r of rows.filter(r => r.overflow)) console.log(r.label + ' box[' + r.x1 + ',' + r.y1 + ',' + r.x2 + ',' + r.y2 + '] inkBox=' + JSON.stringify(r.inkBox));
console.log('--- 有语义节点但画面上无墨迹（不可见/空白控件）---');
for (const r of rows.filter(r => r.ink === 0)) console.log(r.label + ' box[' + r.x1 + ',' + r.y1 + ',' + r.x2 + ',' + r.y2 + ']');
