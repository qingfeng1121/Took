import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";

const file = process.argv[2];
const y0 = Number(process.argv[3] || 0);
const y1 = Number(process.argv[4] || 100000);
const buf = readFileSync(file);
let p = 8, w = 0, h = 0, depth = 0, color = 0;
const idat = [];
while (p < buf.length) {
  const len = buf.readUInt32BE(p);
  const type = buf.toString("ascii", p + 4, p + 8);
  const data = buf.subarray(p + 8, p + 8 + len);
  if (type === "IHDR") { w = data.readUInt32BE(0); h = data.readUInt32BE(4); depth = data[8]; color = data[9]; }
  else if (type === "IDAT") idat.push(data);
  else if (type === "IEND") break;
  p += 12 + len;
}
const raw = inflateSync(Buffer.concat(idat));
const channels = color === 6 ? 4 : color === 2 ? 3 : 4;
const bpp = channels;
const stride = w * bpp;
const out = Buffer.alloc(h * stride);
let prev = Buffer.alloc(stride);
for (let y = 0; y < h; y++) {
  const f = raw[y * (stride + 1)];
  const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
  const cur = Buffer.alloc(stride);
  for (let x = 0; x < stride; x++) {
    const a = x >= bpp ? cur[x - bpp] : 0;
    const b = prev[x];
    const c = x >= bpp ? prev[x - bpp] : 0;
    let v = line[x];
    if (f === 1) v += a;
    else if (f === 2) v += b;
    else if (f === 3) v += (a + b) >> 1;
    else if (f === 4) {
      const pp = a + b - c;
      const pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
      v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
    }
    cur[x] = v & 0xff;
  }
  cur.copy(out, y * stride);
  prev = cur;
}
// 在 y0..y1 找橙色像素（accent #F97316）的 x 区间
const spans = new Map();
for (let y = Math.max(0, y0); y < Math.min(h, y1); y++) {
  let start = -1;
  for (let x = 0; x <= w; x++) {
    let orange = false;
    if (x < w) {
      const i = y * stride + x * bpp;
      const r = out[i], g = out[i + 1], b = out[i + 2];
      orange = r > 200 && g > 80 && g < 170 && b < 90;
    }
    if (orange && start < 0) start = x;
    if (!orange && start >= 0) {
      const key = start + ".." + (x - 1);
      spans.set(key, (spans.get(key) || 0) + 1);
      start = -1;
    }
  }
}
console.log("size " + w + "x" + h + " color=" + color + " depth=" + depth);
[...spans.entries()].filter(([, n]) => n >= 3).sort((a, b) => b[1] - a[1]).slice(0, 12)
  .forEach(([k, n]) => console.log("orange x=" + k + " rows=" + n));
