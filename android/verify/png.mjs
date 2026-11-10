import fs from 'fs';
import zlib from 'zlib';

export function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not png');
  let pos = 8, w = 0, h = 0, bitDepth = 0, colorType = 0, idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9];
      if (data[12] !== 0) throw new Error('interlaced unsupported');
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (bitDepth !== 8) throw new Error('bitDepth ' + bitDepth);
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 0 ? 1 : colorType === 4 ? 2 : 0;
  if (!channels) throw new Error('colorType ' + colorType);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * channels;
  const out = Buffer.alloc(h * stride);
  let rp = 0;
  for (let y = 0; y < h; y++) {
    const filter = raw[rp++];
    const line = raw.subarray(rp, rp + stride); rp += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? cur[x - channels] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= channels ? prev[x - channels] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      }
      cur[x] = v & 0xff;
    }
  }
  return { w, h, channels, data: out };
}

export function pixel(img, x, y) {
  if (x < 0 || y < 0 || x >= img.w || y >= img.h) return [255, 255, 255];
  const i = (y * img.w + x) * img.channels;
  return [img.data[i], img.data[i + 1] ?? img.data[i], img.data[i + 2] ?? img.data[i]];
}

// 统计一个矩形内的「墨迹」（与该矩形底色差异大的像素）分布
export function inkStats(img, x1, y1, x2, y2) {
  const X1 = Math.max(0, x1), Y1 = Math.max(0, y1);
  const X2 = Math.min(img.w, x2), Y2 = Math.min(img.h, y2);
  if (X2 <= X1 || Y2 <= Y1) return null;
  // 边缘 2px 采样作为底色
  const counts = new Map();
  const sample = (x, y) => {
    const p = pixel(img, x, y); const k = p.join(',');
    counts.set(k, (counts.get(k) || 0) + 1);
  };
  for (let x = X1; x < X2; x++) { sample(x, Y1); sample(x, Y1 + 1); sample(x, Y2 - 1); }
  for (let y = Y1; y < Y2; y++) { sample(X1, y); sample(X1 + 1, y); sample(X2 - 1, y); }
  let bgKey = null, bgN = 0;
  for (const [k, n] of counts) if (n > bgN) { bgN = n; bgKey = k; }
  const bg = bgKey.split(',').map(Number);
  const thr = 48;
  let n = 0, sx = 0, sy = 0, minX = 1e9, maxX = -1, minY = 1e9, maxY = -1;
  for (let y = Y1; y < Y2; y++) for (let x = X1; x < X2; x++) {
    const p = pixel(img, x, y);
    const d = Math.abs(p[0] - bg[0]) + Math.abs(p[1] - bg[1]) + Math.abs(p[2] - bg[2]);
    if (d > thr) { n++; sx += x; sy += y; if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
  }
  if (!n) return { n: 0, bg };
  return { n, bg, cx: sx / n, cy: sy / n, bbox: [minX, minY, maxX, maxY] };
}
