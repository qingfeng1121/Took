import fs from 'fs';
const f = process.argv[2];
const s = fs.readFileSync(f, 'utf8');
const out = [];
const re = /<node\b([^>]*)>/g;
let m;
while ((m = re.exec(s))) {
  const a = m[1];
  const get = (k) => { const r = new RegExp(k + '="([^"]*)"').exec(a); return r ? r[1] : ''; };
  const text = get('text'); const desc = get('content-desc');
  const b = /bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(a);
  const cls = get('class');
  if (!b) continue;
  const [x1,y1,x2,y2] = b.slice(1).map(Number);
  if (!text && !desc) continue;
  out.push({ t: text || ('~' + desc), cls: cls.replace('android.widget.','').replace('androidx.compose.ui.',''), x1,y1,x2,y2, click: get('clickable')==='true' });
}
const H = Number(process.argv[3] || 2400), W = 1080;
for (const o of out) {
  const flag = (o.y1 > H*0.85 && o.x1 < W*0.15) ? ' <<< BOTTOM-LEFT' : '';
  console.log([o.x1+'..'+o.x2, o.y1+'..'+o.y2, o.cls, JSON.stringify(o.t), o.click?'CLICK':''].join(' | ') + flag);
}
