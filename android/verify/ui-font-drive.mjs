// 全应用字号放大的真机验收驱动：导航 + 截图 + uiautomator dump，全部按语义找元素，每步都断言页面真的换了。
// 用法：node verify/ui-font-drive.mjs   （需先持有 .device-lock.md 第 4 节的设备锁）
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ADB = "D:/work/android-sdk/platform-tools/adb.exe";
const DEV = ["-s", "5bf0cda4"];
const ROOT = "D:/work/Project/Took/android";
const OUT = path.join(ROOT, "verify");

const adb = (...args) => execFileSync(ADB, [...DEV, ...args], { encoding: "utf8" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function nodes(name) {
  const xml = fs.readFileSync(path.join(OUT, name + ".xml"), "utf8");
  const out = [];
  for (const m of xml.matchAll(/<node[^>]*?>/g)) {
    const s = m[0];
    const b = /bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(s);
    if (!b) continue;
    out.push({
      text: (/text="([^"]*)"/.exec(s))?.[1] ?? "",
      desc: (/content-desc="([^"]*)"/.exec(s))?.[1] ?? "",
      box: [+b[1], +b[2], +b[3], +b[4]],
    });
  }
  return out;
}
const center = (n) => [Math.round((n.box[0] + n.box[2]) / 2), Math.round((n.box[1] + n.box[3]) / 2)];
const texts = (list) => list.filter((n) => n.text.trim()).map((n) => n.text.trim());
const descs = (list) => list.filter((n) => n.desc.trim()).map((n) => n.desc.trim());

async function dump(name) {
  // uiautomator 在界面动画期间会报 "hierarchy is busy"，重试即可
  for (let i = 0; i < 5; i++) {
    try {
      adb("shell", "uiautomator", "dump", "/sdcard/w.xml");
      adb("pull", "/sdcard/w.xml", path.join(OUT, name + ".xml"));
      return nodes(name);
    } catch (e) {
      if (i === 4) throw e;
      await sleep(900);
    }
  }
}
async function shot(name) {
  adb("shell", "screencap", "-p", "/sdcard/s.png");
  adb("pull", "/sdcard/s.png", path.join(OUT, name + ".png"));
}
async function tap(xy, label) {
  console.log("  tap " + label + " @ " + xy.join(","));
  adb("shell", "input", "tap", String(xy[0]), String(xy[1]));
  await sleep(1800);
}
/** 判定「文字被截断」：Compose 的 TextOverflow.Ellipsis 会以 … 收尾。 */
const truncated = (list) => list.filter((n) => n.text.includes("…") || n.text.includes("..."));

async function capture(name) {
  const list = await dump(name);
  await shot(name);
  const tr = truncated(list);
  console.log("  => verify/" + name + ".png/.xml  nodes=" + list.length +
    "  ellipsis=" + (tr.length ? tr.map((n) => n.text).join(" / ") : "none"));
  return list;
}
async function back(label) {
  console.log("  back (" + label + ")");
  adb("shell", "input", "keyevent", "KEYCODE_BACK");
  await sleep(1500);
}
function homeTab(list) {
  return list.find((n) => ["首页", "配置", "设置"].includes(n.desc.trim()) && n.box[1] > 2000);
}

async function main() {
  adb("install", "-r", path.join(ROOT, "app/build/outputs/apk/debug/app-debug.apk"));

  /* 小组件会把自己的 Pin 引导页顶到前台；而且返回键会一路退出到桌面。
     所以每一节都从冷启重来，不依赖上一节的界面状态。 */
  async function launchApp() {
    for (let i = 0; i < 4; i++) {
      adb("shell", "am", "force-stop", "app.took");
      await sleep(800);
      adb("shell", "am", "start", "-W", "-n", "app.took/.MainActivity");
      await sleep(2500);
      const probe = await dump("ui-font-launch");
      if (probe.some((n) => n.desc.trim() === "统计分析")) return probe;
      console.log("  重试冷启（第 " + (i + 2) + " 次）：前台不是主页");
    }
    console.log("  FATAL 冷启失败，应用没进主页");
    process.exit(1);
  }

  function homeTabOf(list, label) {
    return list.find((n) => n.desc.trim() === label && n.box[1] > 2000);
  }

  /** 断言当前界面属于某页；不等就重试，全程记录截断项。 */
  async function expectPage(name, mustHave, tries = 6) {
    let list = [];
    for (let i = 0; i < tries; i++) {
      await sleep(900);
      list = await dump(name);
      if (mustHave.every((m) => texts(list).some((t) => t.includes(m)))) break;
      if (i === tries - 1) console.log("  WARN " + name + " 没等到预期文字 " + JSON.stringify(mustHave));
    }
    await shot(name);
    const tr = truncated(list);
    console.log("  => verify/" + name + ".png/.xml  nodes=" + list.length +
      "  ellipsis=" + (tr.length ? tr.map((n) => n.text).join(" / ") : "none"));
    return list;
  }

  /* ---------- 1. 统计页（17 处小字都在这里，三种类型三套排版） ---------- */
  console.log("1) 统计页 ui-font-analysis");
  let cur = await launchApp();
  await tap(center(cur.find((n) => n.desc.trim() === "统计分析")), "统计分析");
  cur = await expectPage("ui-font-analysis", ["统计分析", "区间"]);
  if (!texts(cur).includes("统计分析")) { console.log("  FATAL 没进统计页"); process.exit(1); }

  for (const label of ["按规则分组", "连续打卡"]) {
    const slug = label === "按规则分组" ? "rule" : "streak";
    const chip = nodes("ui-font-" + (slug === "rule" ? "analysis" : "analysis-rule"))
      .find((n) => n.desc.trim().startsWith("统计类型："));
    if (!chip) { console.log("  WARN 当前页找不到类型下拉（" + label + "）"); break; }
    await tap(center(chip), chip.desc.trim());
    let opt = null;
    for (let i = 0; i < 4 && !opt; i++) {
      await sleep(700);
      const picker = await dump("ui-font-picker");
      opt = picker.find((n) => n.text.trim() === label);
    }
    if (!opt) { console.log("  WARN 打不开类型下拉选中 " + label); break; }
    await tap(center(opt), label);
    await expectPage("ui-font-analysis-" + slug, [label]);
  }

  /* ---------- 2. 设置页 ---------- */
  console.log("2) 设置页 ui-font-settings");
  cur = await launchApp();
  await tap(center(homeTabOf(cur, "设置")), "设置 tab");
  cur = await expectPage("ui-font-settings", ["设置", "同步"]);
  for (const i of [2, 3]) {
    adb("shell", "input", "swipe", "540", "1900", "540", "700", "300");
    await sleep(1300);
    await expectPage("ui-font-settings-scroll" + i, ["设置"]);
  }

  /* ---------- 3. 规则编辑页 ---------- */
  console.log("3) 规则编辑页 ui-font-editor");
  cur = await launchApp();
  await tap(center(homeTabOf(cur, "配置")), "配置 tab");
  cur = await expectPage("ui-font-config", ["配置", "规则"]);
  const rule = cur.find((n) => {
    const t = n.text.trim();
    return t.length >= 2 && !t.startsWith("＋") && !t.includes("个任务") &&
      n.box[1] > 350 && (n.box[3] - n.box[1]) >= 40 && (n.box[2] - n.box[0]) > 100;
  });
  console.log("  规则卡标题：" + (rule ? rule.text.trim() : "未找到"));
  if (rule) {
    await tap(center(rule), "规则 " + rule.text.trim());
    cur = await expectPage("ui-font-editor", ["编辑规则", "名称"]);
  }

  /* ---------- 4. 当天面板 ---------- */
  console.log("4) 当天面板 ui-font-daypanel");
  cur = await launchApp();
  const cell = cur.find((n) => {
    const d = n.desc.trim();
    return d.includes("当天安排") && !d.includes("0 个任务") && (n.box[3] - n.box[1]) > 150;
  });
  console.log("  日历格：" + (cell ? cell.desc.trim() : "未找到有任务的格子"));
  if (cell) {
    await tap(center(cell), "当日格子");
    cur = await expectPage("ui-font-daypanel", ["点任务即可打卡", "条任务"]);
  }
  console.log("done");
}

main().catch((e) => { console.error(String((e && e.stack) || e)); process.exit(1); });
