#!/usr/bin/env node
// 滚动查找并点按：配置页是长列表，memo 三组在规则列表下方，直接 tap 会 NO MATCH。
// 用法：UI_SERIAL=emulator-5554 node verify/_find.mjs tap 新建记事 [最多滑动次数]
import { execFileSync } from "node:child_process";

const ADB = "D:\\work\\android-sdk\\platform-tools\\adb.exe";
const SERIAL = process.env.UI_SERIAL || "";
const here = "D:\\work\\Project\\Took\\android\\verify";
const [cmd, target, timesRaw] = process.argv.slice(2);
const times = Number(timesRaw || 8);

function adb(...args) {
  const full = SERIAL ? ["-s", SERIAL, ...args] : args;
  return execFileSync(ADB, full, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}
function nodes() {
  adb("shell", "uiautomator", "dump", "/sdcard/ui.xml");
  const xml = adb("shell", "cat", "/sdcard/ui.xml");
  const out = [];
  const re = /<node\b[^>]*>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const tag = m[0];
    const attr = (n) => new RegExp(n + '="([^"]*)"').exec(tag)?.[1] ?? "";
    const b = /\[(\d+),(\d+)\]\[(\d+),(\d+)\]/.exec(attr("bounds"));
    if (!b) continue;
    out.push({
      text: attr("text"), desc: attr("content-desc"),
      x1: +b[1], y1: +b[2], x2: +b[3], y2: +b[4],
      cx: Math.round((+b[1] + +b[3]) / 2), cy: Math.round((+b[2] + +b[4]) / 2),
    });
  }
  return out;
}
function match(ns) {
  return ns.filter((n) => n.text === target || n.desc === target || n.text.includes(target) || n.desc.includes(target));
}
let found = null;
for (let i = 0; i <= times; i++) {
  const hits = match(nodes());
  if (hits.length) { found = hits[0]; break; }
  // 内容往上滚：从下往上滑
  adb("shell", "input", "swipe", "540", "1900", "540", "700", "220");
  execFileSync(process.execPath, ["-e", "setTimeout(()=>{},400)"]);
}
if (!found) { console.log("NO MATCH after scroll: " + target); process.exit(3); }
if (cmd === "tap") {
  adb("shell", "input", "tap", String(found.cx), String(found.cy));
  console.log(`tapped "${target}" at (${found.cx},${found.cy}) text="${found.text}" desc="${found.desc}"`);
} else {
  console.log(JSON.stringify(found));
}
