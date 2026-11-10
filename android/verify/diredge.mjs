import fs from 'fs';
import { decodePng } from './png.mjs';

const px = (img, x, y) => { const i = (y * img.w + x) * img.channels; return [img.data[i], img.data[i + 1], img.data[i + 2]]; };
const isWhite = (p) => p[0] > 246 && p[1] > 246 && p[2] > 246;
function leftEdge(img, y) {
  for (let x = 0; x < img.w; x++) if (isWhite(px(img, x, y))) {
    let ok = 0;
    for (let k = 0; k < 40 && x + k < img.w; k++) if (isWhite(px(img, x + k, y))) ok++;
    if (ok >= 40) return x;
  }
  return -1;
}
function topEdge(img, x) {
  for (let y = 0; y < img.h; y++) if (isWhite(px(img, x, y))) {
    let ok = 0;
    for (let k = 0; k < 40 && y + k < img.h; k++) if (isWhite(px(img, x, y + k))) ok++;
    if (ok >= 40) return y;
  }
  return -1;
}
const files = [];
for (let i = 0; i < 8; i++) files.push('anim-drawer-' + i);
files.push('anim-drawer-final');
console.log('frame | 抽屉左边界x(屏幕宽1080) | 抽屉上边界y | 说明');
for (const f of files) {
  const p = f + '.png';
  if (!fs.existsSync(p)) { console.log(f + ' MISSING'); continue; }
  const img = decodePng(fs.readFileSync(p));
  console.log(f.replace('anim-drawer-', '') + ' | x=' + leftEdge(img, 400) + ' | y=' + topEdge(img, 1060) + ' | w=' + img.w + ' h=' + img.h);
}
