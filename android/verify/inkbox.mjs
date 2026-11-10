import fs from 'fs';
import { decodePng, inkStats } from './png.mjs';
const base = process.argv[2];
const xml = fs.readFileSync(base + '.xml', 'utf8');
const img = decodePng(fs.readFileSync(base + '.png'));
const nodes = [];
const re = /<node\b([^>]*)>/g;
let m;
while ((m = re.exec(xml))) {
  const a = m[1];
  const get = (k) => { const r = new RegExp(' ' + k + '="([^"]*)"').exec(a); return r ? r[1] : ''; };
  const b = /bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(a);
  if (!b) continue;
  const [x1, y1, x2, y2] = b.slice(1).map(Number);
  const t = get('text') || get('content-desc');
  if (!t) continue;
  const st = inkStats(img, x1, y1, x2, y2);
  console.log(JSON.stringify(t) + ' node[' + x1 + ',' + y1 + ',' + x2 + ',' + y2 + '] h=' + (y2 - y1) + (st && st.bbox ? ' ink[' + st.bbox.join(',') + '] inkH=' + (st.bbox[3] - st.bbox[1]) : ' NO-INK'));
}
