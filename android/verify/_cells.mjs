#!/usr/bin/env node
// 把 uiautomator dump 解析成「月历每格 → 预览文案」表，用来断言记事是否命中某天。
// 用法：node verify/_cells.mjs verify/z11-home-range.xml [只打印含某关键词的行]
import { readFileSync } from "node:fs";

const file = process.argv[2];
const only = process.argv[3] || "";
const xml = readFileSync(file, "utf8");
const nodes = [];
const re = /<node\b[^>]*>/g;
let m;
while ((m = re.exec(xml)) !== null) {
  const tag = m[0];
  const attr = (n) => new RegExp(n + '="([^"]*)"').exec(tag)?.[1] ?? "";
  const b = /\[(\d+),(\d+)\]\[(\d+),(\d+)\]/.exec(attr("bounds"));
  if (!b) continue;
  nodes.push({
    text: attr("text"), desc: attr("content-desc"),
    x1: +b[1], y1: +b[2], x2: +b[3], y2: +b[4],
    cx: Math.round((+b[1] + +b[3]) / 2), cy: Math.round((+b[2] + +b[4]) / 2),
  });
}
const dates = nodes.filter((n) => /^\d{4}-\d{2}-\d{2} 当天安排$/.test(n.desc));
const previews = nodes.filter((n) => n.desc && !/^\d{4}-\d{2}-\d{2} 当天安排$/.test(n.desc) && (n.desc.includes("未完成") || n.desc.includes("已完成") || n.desc.includes("记事")));
for (const d of dates) {
  const cell = previews.find((p) => Math.abs(p.cx - d.cx) < 70 && p.y1 > d.y1 && p.y1 < d.y1 + 150);
  const desc = cell ? cell.desc : "";
  if (only && !desc.includes(only)) continue;
  console.log(d.desc.replace(" 当天安排", "") + "\t" + (desc || "-"));
}
