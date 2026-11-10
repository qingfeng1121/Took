// 只抓当天面板和连续打卡统计页。冷启 + 前台校验 + 每步重试。
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ADB = "D:/work/android-sdk/platform-tools/adb.exe";
const DEV = ["-s", "5bf0cda4"];
const OUT = "D:/work/Project/Took/android/verify";
const adb = (...a) => execFileSync(ADB, [...DEV, ...a], { encoding: "utf8" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const topActivity = () => {
  const s = adb("shell", "dumpsys activity activities");
  const m = /topResumedActivity=\S*\s+\S+\s+(\S+)/.exec(s);
  return m ? m[1] : "";
};
function nodes(name) {
  const xml = fs.readFileSync(path.join(OUT, name + ".xml"), "utf8");
  const out = [];
  for (const m of xml.matchAll(/<node[^>]*?>/g)) {
    const s = m[0];
    const b = /bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(s);
    if (!b) continue;
    out.push({ text: (/text="([^"]*)"/.exec(s))?.[1] ?? "", desc: (/content-desc="([^"]*)"/.exec(s))?.[1] ?? "", box: [+b[1], +b[2], +b[3], +b[4]] });
  }
  return out;
}
const center = (n) => [Math.round((n.box[0] + n.box[2]) / 2), Math.round((n.box[1] + n.box[3]) / 2)];
const texts = (l) => l.filter((n) => n.text.trim()).map((n) => n.text.trim());
async function dump(name) {
  for (let i = 0; i < 5; i++) {
    try {
      adb("shell", "uiautomator", "dump", "/sdcard/w.xml");
      adb("pull", "/sdcard/w.xml", path.join(OUT, name + ".xml"));
      return nodes(name);
    } catch (e) { if (i === 4) throw e; await sleep(900); }
  }
}
async function shot(name) {
  adb("shell", "screencap", "-p", "/sdcard/s.png");
  adb("pull", "/sdcard/s.png", path.join(OUT, name + ".png"));
}
const tapAt = (xy) => adb("shell", "input", "tap", String(xy[0]), String(xy[1]));
async function ontoMain() {
  for (let i = 0; i < 8; i++) {
    if (topActivity().endsWith("app.took/.MainActivity")) return true;
    adb("shell", "input", "keyevent", "KEYCODE_BACK");
    await sleep(700);
    if (i >= 3) {
      adb("shell", "am", "force-stop", "app.took");
      await sleep(600);
      adb("shell", "am", "start", "-W", "-n", "app.took/.MainActivity");
      await sleep(2400);
    }
  }
  return false;
}
async function relaunch() {
  adb("shell", "am", "force-stop", "app.took");
  await sleep(900);
  adb("shell", "am", "start", "-W", "-n", "app.took/.MainActivity");
  await sleep(2800);
  await ontoMain();
  return await dump("ui-font-boot");
}
async function record(name) {
  const l = nodes(name);
  await shot(name);
  const tr = l.filter((n) => n.text.includes("…"));
  console.log("  => verify/" + name + ".png/.xml  nodes=" + l.length +
    "  ellipsis=" + (tr.length ? tr.map((n) => n.text).join(" / ") : "none"));
  return l;
}

console.log("A) 当天面板");
let cur = await relaunch();
// 首页月历默认在最上；若被滚过，先滑回顶部
if (!cur.some((n) => n.desc.trim().startsWith("2026-10-01"))) {
  adb("shell", "input", "swipe", "540", "700", "540", "1900", "250");
  await sleep(1200);
  cur = await dump("ui-font-boot");
}
const cell = cur.find((n) => {
  const d = n.desc.trim();
  return d.includes("当天安排") && !d.includes("0 个任务") && (n.box[3] - n.box[1]) > 150;
});
console.log("  日历格：" + (cell ? cell.desc.trim() + " " + center(cell) : "NOT FOUND"));
// 格子中心偶尔落在月历的横向滚动/概览条上没反应，逐个纵向偏移重试
let ok = false;
for (const fy of [0.5, 0.78, 0.25]) {
  const px = Math.round((cell.box[0] + cell.box[2]) / 2);
  const py = Math.round(cell.box[1] + (cell.box[3] - cell.box[1]) * fy);
  console.log("  点 " + px + "," + py);
  await tapAt([px, py]);
  for (let i = 0; i < 5; i++) {
    await sleep(1000);
    cur = await dump("ui-font-daypanel");
    if (texts(cur).some((t) => t.includes("点任务即可打卡"))) { ok = true; break; }
  }
  if (ok) break;
}
console.log("  daypanel ok=" + ok);
if (ok) await record("ui-font-daypanel");
else console.log("  WARN 当天面板没打开；dump 文本：" + texts(cur).join(" | ").slice(0, 300));

console.log("B) 统计页 · 连续打卡");
cur = await relaunch();
await tapAt(center(cur.find((n) => n.desc.trim() === "统计分析")));
for (let i = 0; i < 6; i++) {
  await sleep(900);
  cur = await dump("ui-font-analysis");
  if (texts(cur).includes("统计分析")) break;
}
let chip = cur.find((n) => n.desc.trim().startsWith("统计类型："));
await tapAt(center(chip));
let opt = null;
for (let i = 0; i < 6 && !opt; i++) {
  await sleep(900);
  const p = await dump("ui-font-picker");
  opt = p.find((n) => n.text.trim() === "连续打卡");
}
console.log("  选中项 " + (opt ? center(opt) : "NOT FOUND"));
if (opt) {
  await tapAt(center(opt));
  let got = false;
  for (let i = 0; i < 8; i++) {
    await sleep(900);
    cur = await dump("ui-font-analysis-streak");
    if (cur.some((n) => n.desc.trim().startsWith("统计类型：连续打卡"))) { got = true; break; }
  }
  console.log("  streak ok=" + got);
  if (got) await record("ui-font-analysis-streak");
}
console.log("done");
