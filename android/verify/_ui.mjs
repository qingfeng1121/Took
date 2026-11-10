#!/usr/bin/env node
// 模拟器驱动小工具：uiautomator dump + 按文本/无障碍标签点按。
// 用法：
//   node verify/_ui.mjs dump <name>              导出并保存 verify/<name>.xml
//   node verify/_ui.mjs find <text>              打印匹配节点的 text/content-desc/bounds
//   node verify/_ui.mjs tap <text>               点第一个匹配节点中心
//   node verify/_ui.mjs tapNth <text> <n>        点第 n 个匹配（0 基）
//   node verify/_ui.mjs type <text>              往当前焦点输入 ASCII 文本
//   node verify/_ui.mjs key <keycode>            按键
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ADB = "D:\\work\\android-sdk\\platform-tools\\adb.exe";
// 有多台设备时必须指定：UI_SERIAL=emulator-5554 node verify/_ui.mjs tap 配置
const SERIAL = process.env.UI_SERIAL || "";
const here = dirname(fileURLToPath(import.meta.url));

function adb(...args) {
  const full = SERIAL ? ["-s", SERIAL, ...args] : args;
  return execFileSync(ADB, full, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

function dumpRaw() {
  adb("shell", "uiautomator", "dump", "/sdcard/ui.xml");
  return adb("shell", "cat", "/sdcard/ui.xml");
}

function nodes(xml) {
  const out = [];
  const re = /<node\b[^>]*>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const tag = m[0];
    const attr = (name) => {
      const r = new RegExp(name + '="([^"]*)"').exec(tag);
      return r ? r[1] : undefined;
    };
    const text = attr("text");
    const desc = attr("content-desc");
    const bounds = attr("bounds");
    if (!bounds) continue;
    const b = /\[(\d+),(\d+)\]\[(\d+),(\d+)\]/.exec(bounds);
    if (!b) continue;
    out.push({
      text: text ?? "",
      desc: desc ?? "",
      cls: attr("class") ?? "",
      clickable: attr("clickable") === "true",
      x1: +b[1], y1: +b[2], x2: +b[3], y2: +b[4],
      cx: Math.round((+b[1] + +b[3]) / 2),
      cy: Math.round((+b[2] + +b[4]) / 2),
    });
  }
  return out;
}

const [cmd, a1, a2] = process.argv.slice(2);
mkdirSync(here, { recursive: true });

if (cmd === "dump") {
  const xml = dumpRaw();
  const name = a1 || "ui";
  writeFileSync(join(here, name + ".xml"), xml);
  const nonEmpty = nodes(xml).filter((n) => n.text || n.desc);
  console.log("saved verify/" + name + ".xml  nodes=" + nonEmpty.length);
  for (const n of nonEmpty) {
    console.log(`  [${n.x1},${n.y1}][${n.x2},${n.y2}] class=${n.cls.split(".").pop()} text="${n.text}" desc="${n.desc}"`);
  }
} else if (cmd === "find") {
  const hits = nodes(dumpRaw()).filter((n) => n.text === a1 || n.desc === a1 || n.text.includes(a1) || n.desc.includes(a1));
  hits.forEach((n) => console.log(`${n.cls.split(".").pop()} text="${n.text}" desc="${n.desc}" clickable=${n.clickable} center=(${n.cx},${n.cy}) bounds=[${n.x1},${n.y1}][${n.x2},${n.y2}]`));
  if (!hits.length) { console.log("NO MATCH: " + a1); process.exitCode = 3; }
} else if (cmd === "tap" || cmd === "tapNth") {
  const idx = cmd === "tapNth" ? Number(a2 || 0) : 0;
  const hits = nodes(dumpRaw()).filter((n) => n.text === a1 || n.desc === a1 || n.text.includes(a1) || n.desc.includes(a1));
  if (!hits.length) { console.log("NO MATCH: " + a1); process.exit(3); }
  const n = hits[idx];
  if (!n) { console.log("NO INDEX " + idx + " for " + a1); process.exit(3); }
  adb("shell", "input", "tap", String(n.cx), String(n.cy));
  console.log(`tapped ${idx} "${a1}" at (${n.cx},${n.cy}) text="${n.text}" desc="${n.desc}"`);
} else if (cmd === "tapxy") {
  adb("shell", "input", "tap", String(a1), String(a2));
  console.log("tapped (" + a1 + "," + a2 + ")");
} else if (cmd === "edits") {
  const eds = nodes(dumpRaw()).filter((n) => n.cls.includes("EditText"));
  eds.forEach((n, i) => console.log(i + ": text=" + JSON.stringify(n.text) + " center=(" + n.cx + "," + n.cy + ")"));
  if (!eds.length) console.log("NO EditText");
} else if (cmd === "edit") {
  const eds = nodes(dumpRaw()).filter((n) => n.cls.includes("EditText"));
  const n = eds[Number(a1 || 0)];
  if (!n) { console.log("NO EditText #" + a1); process.exit(3); }
  adb("shell", "input", "tap", String(n.cx), String(n.cy));
  console.log("focused EditText #" + a1 + " at (" + n.cx + "," + n.cy + ") text=" + JSON.stringify(n.text));
} else if (cmd === "type") {
  adb("shell", "input", "text", a1.replace(/ /g, "%s"));
  console.log("typed " + a1);
} else if (cmd === "key") {
  adb("shell", "input", "keyevent", a1);
  console.log("key " + a1);
} else {
  console.log("unknown command");
  process.exit(2);
}
