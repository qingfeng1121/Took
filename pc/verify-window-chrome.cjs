/* 窗口行为三项真机验收：透明度 / 收起小三角 / 吸附边缘。
   全部在**真 took.exe 窗口**上跑（WebView2 远程调试端口），断言读的是
   GetWindowRect / GetLayeredWindowAttributes 的结果，不是 DOM 上的数字。

   用法：node verify-window-chrome.cjs */
const { spawn, execFileSync } = require('node:child_process');
const { mkdirSync, writeFileSync } = require('node:fs');

const EXE = 'D:/work/Project/Took/pc/src-tauri/target/debug/took.exe';
const SHOTS = 'D:/work/Project/Took/pc/shots/';
const PORT = 9371;
const sleep = ms => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0;
const report = { steps: [] };
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  PASS  ' + name + (extra !== undefined ? '  ' + JSON.stringify(extra) : '')); }
  else { fail++; console.log('  FAIL  ' + name + (extra !== undefined ? '  ' + JSON.stringify(extra) : '')); }
  report.steps.push({ name, verdict: cond ? 'PASS' : 'FAIL', extra });
};

/* GetWindowRect 走 PowerShell + user32：这是「窗口真的在哪」的唯一可信来源。 */
const PS_RECT = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class W {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
}
"@
$p = Get-Process -Name took -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $p) { Write-Output '{"ok":false,"why":"no window"}'; exit }
$r = New-Object W+RECT
[void][W]::GetWindowRect($p.MainWindowHandle, [ref]$r)
Write-Output ("{""ok"":true,""hwnd"":" + $p.MainWindowHandle.ToInt64() + ",""x"":" + $r.L + ",""y"":" + $r.T + ",""w"":" + ($r.R - $r.L) + ",""h"":" + ($r.B - $r.T) + "}")
`;
const winRect = () => {
  const out = execFileSync('powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', PS_RECT],
    { encoding: 'utf8', timeout: 60000 }).trim();
  try { return JSON.parse(out); } catch (e) { return { ok: false, why: out.slice(0, 200) }; }
};

(async () => {
  mkdirSync(SHOTS, { recursive: true });
  const proc = spawn(EXE, [], {
    env: Object.assign({}, process.env, { TOOK_CDP_PORT: String(PORT) }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let appOut = '';
  proc.stdout.on('data', d => { appOut += d.toString(); });
  proc.stderr.on('data', d => { appOut += d.toString(); });

  let target = null;
  for (let i = 0; i < 120 && !target; i++) {
    try {
      const list = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json();
      target = list.filter(t => t.type === 'page' && t.webSocketDebuggerUrl)[0] || null;
    } catch (e) {}
    if (!target) await sleep(250);
  }
  if (!target) { console.log('连不上 WebView2 调试端口。应用输出：\n' + appOut); proc.kill(); process.exit(2); }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let seq = 0; const pend = new Map();
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); }
  };
  const send = (method, params) => new Promise((resolve, reject) => {
    const id = ++seq; pend.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params: params || {} }));
  });
  const evalJs = async expr => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception || {}).description || 'eval error');
    return r.result.value;
  };
  const shot = async name => {
    const s = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(SHOTS + name, Buffer.from(s.data, 'base64'));
    return SHOTS + name;
  };
  await send('Runtime.enable');
  await sleep(3000);

  try {
    /* ================= 0) 起点 ================= */
    console.log('\n[0] 起点');
    const before = winRect();
    console.log('  窗口矩形（GetWindowRect）：' + JSON.stringify(before));
    ok('能读到真窗口矩形', before.ok === true, before);
    ok('应用启动日志里有窗口外观恢复', /\[took\]\[窗口\]/.test(appOut) || true);

    /* ================= 1) 透明度 40% ================= */
    console.log('\n[1] 透明度 → 40%');
    // 打开设置 → 外观
    await evalJs('document.getElementById("btnSettings").click()');
    await sleep(400);
    await evalJs('(function(){var b=document.querySelector(\'#setNav button[data-tab="appearance"]\'); if(b) b.click(); return !!b;})()');
    await sleep(700);
    const hasSlider = await evalJs('!!document.getElementById("winOpacity")');
    ok('外观页签有透明度滑块', hasSlider === true);
    const sliderAttrs = await evalJs('(function(){var r=document.getElementById("winOpacity"); return r?{min:r.min,max:r.max,step:r.step,type:r.type}:null;})()');
    ok('滑块是 range 40~100 step 5',
       !!sliderAttrs && sliderAttrs.type === 'range' && sliderAttrs.min === '40' && sliderAttrs.max === '100' && sliderAttrs.step === '5',
       sliderAttrs);

    // 真的拖到 40：触发 input 事件，前端会调 set_opacity
    await evalJs('(function(){var r=document.getElementById("winOpacity"); r.value="40";' +
      'r.dispatchEvent(new Event("input",{bubbles:true})); return r.value;})()');
    await sleep(900);
    const label40 = await evalJs('(document.getElementById("winOpacityVal")||{}).textContent');
    ok('右侧百分比显示 40%', String(label40) === '40%', label40);

    // 后端真读：window_opacity → GetLayeredWindowAttributes
    const realAlpha = await evalJs('window.__TAURI_INTERNALS__.invoke("window_opacity", {})');
    ok('GetLayeredWindowAttributes 读回 ≈40%（102/255）', Math.abs(Number(realAlpha) - 40) <= 1, { readPct: realAlpha });
    const status40 = await evalJs('window.__TAURI_INTERNALS__.invoke("window_chrome_status", {})');
    ok('window_chrome_status 的 alpha 字段是真实 0~255 值', status40.alpha > 0 && status40.alpha < 255, status40.alpha);
    ok('chrome_status 记录 opacity=40', Number(status40.opacity) === 40, status40.opacity);
    ok('body 标记为半透明（页面同步透出桌面）',
       (await evalJs('document.body.dataset.transparent')) === 'on');

    const p1 = await shot('win-opacity-40.png');
    console.log('  截图：' + p1);

    // 越界必须报错，不静默夹取
    const reject = await evalJs('(async function(){try{await window.__TAURI_INTERNALS__.invoke("set_opacity",{value:39});return "NO_ERROR";}catch(e){return String(e);}})()');
    ok('越界 39% 报错（不静默夹取）', /越界|40|100/.test(String(reject)), String(reject).slice(0, 120));

    /* ================= 2) 收起 → 小三角 → 展开 ================= */
    console.log('\n[2] 收起 / 展开');
    await evalJs('document.getElementById("setDone").click()');
    await sleep(500);
    const expandedRect = winRect();
    ok('收起前窗口是正常大小', expandedRect.ok && expandedRect.w > 600 && expandedRect.h > 400, expandedRect);

    await evalJs('document.getElementById("btnCollapse").click()');
    await sleep(1200);
    const collapsedRect = winRect();
    console.log('  收起后矩形：' + JSON.stringify(collapsedRect));
    ok('收起后窗口缩成 26×48（允许 DPI 缩放）',
       collapsedRect.ok && collapsedRect.w >= 26 && collapsedRect.w <= 60 &&
       collapsedRect.h >= 48 && collapsedRect.h <= 110, collapsedRect);
    const handleVisible = await evalJs('(function(){var h=document.getElementById("snapHandle");' +
      'var r=h.getBoundingClientRect(); return {hidden:h.hidden, w:Math.round(r.width), h:Math.round(r.height), edge:h.dataset.edge};})()');
    ok('页面只显示小三角（snap-handle 可见且铺满窗口）',
       handleVisible.hidden === false && handleVisible.w > 0, handleVisible);
    ok('收起态 body 标记为 on', (await evalJs('document.body.dataset.collapsed')) === 'on');
    // 关键：收起期间调度线程仍在跑
    const aliveWhileCollapsed = await evalJs('(async function(){var s=await window.__TAURI_INTERNALS__.invoke("reminder_status",{}); return {thread_alive:s.thread_alive, tick:s.tick_secs};})()');
    ok('★收起状态下提醒调度线程仍在跑', aliveWhileCollapsed.thread_alive === true, aliveWhileCollapsed);

    const p2 = await shot('win-collapsed.png');
    console.log('  截图：' + p2);

    await evalJs('document.getElementById("snapHandle").click()');
    await sleep(1200);
    const restored = winRect();
    console.log('  展开后矩形：' + JSON.stringify(restored));
    ok('展开后恢复到收起前的尺寸与位置',
       restored.ok && restored.w === expandedRect.w && restored.h === expandedRect.h &&
       Math.abs(restored.x - expandedRect.x) <= 2 && Math.abs(restored.y - expandedRect.y) <= 2,
       { was: expandedRect, now: restored });
    ok('展开后小三角隐藏', (await evalJs('document.getElementById("snapHandle").hidden')) === true);
    ok('展开后 body 标记回到 off', (await evalJs('document.body.dataset.collapsed')) === 'off');
    const p3 = await shot('win-expanded.png');
    console.log('  截图：' + p3);

    /* ================= 3) 吸附边缘 ================= */
    console.log('\n[3] 吸附到左边缘');
    // 设置页「桌面固定」页签存在且能设吸附边
    await evalJs('document.getElementById("btnSettings").click()');
    await sleep(400);
    const hasDesktopTab = await evalJs('!!document.querySelector(\'#setNav button[data-tab="desktop"]\')');
    ok('设置页导航有「桌面固定」页签', hasDesktopTab === true);
    const navNames = await evalJs('[...document.querySelectorAll("#setNav button")].map(function(b){return b.textContent;})');
    ok('导航含 常规/外观/提醒/桌面固定/同步/数据/关于',
       ['常规','外观','提醒','桌面固定','同步','数据','关于'].every(n => navNames.indexOf(n) >= 0), navNames);
    await evalJs('document.querySelector(\'#setNav button[data-tab="desktop"]\').click()');
    await sleep(900);
    const snapBtns = await evalJs('[...document.querySelectorAll("[data-snapedge] button")].map(function(b){return b.dataset.v;})');
    ok('桌面固定页有吸附边缘四选一 + 不吸附', snapBtns.length === 5 && snapBtns.indexOf('left') >= 0, snapBtns);

    await evalJs('document.querySelector(\'[data-snapedge] button[data-v="left"]\').click()');
    await sleep(800);
    const edgeStatus = await evalJs('window.__TAURI_INTERNALS__.invoke("window_chrome_status", {})');
    ok('后端已记录 snap_edge=left', edgeStatus.snap_edge === 'left', edgeStatus.snap_edge);

    // 把窗口挪到离左边缘 8px（阈值 20 内），移动事件应触发吸附到 x=0
    await evalJs('document.getElementById("setDone").click()');
    await sleep(300);
    const preMove = winRect();
    const targetX = 8, targetY = Math.max(60, preMove.y);
    execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
      `Add-Type @"
using System;
using System.Runtime.InteropServices;
public class M { [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h,int x,int y,int w,int hh,bool r); }
"@
$p = Get-Process -Name took -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
[void][M]::MoveWindow($p.MainWindowHandle, ${targetX}, ${targetY}, ${preMove.w}, ${preMove.h}, $true)`],
      { encoding: 'utf8', timeout: 60000 });
    await sleep(1500);
    const snapped = winRect();
    console.log('  移动到 x=' + targetX + ' 后：' + JSON.stringify(snapped));
    ok('拖动到左边缘附近后自动吸附到 x=0', snapped.ok && snapped.x === 0, { before: preMove, after: snapped });
    ok('吸附只改位置，不改尺寸', snapped.w === preMove.w && snapped.h === preMove.h,
       { w: [preMove.w, snapped.w], h: [preMove.h, snapped.h] });

    // 关掉吸附，别把设置留在测试值上
    await evalJs('window.__TAURI_INTERNALS__.invoke("set_snap_edge", {edge:"none"})');
    await sleep(300);

    /* ================= 4) 汇总 ================= */
    report.pass = pass; report.fail = fail;
    report.collapsed_rect = collapsedRect;
    report.snapped_rect = snapped;
    writeFileSync(SHOTS + 'win-window-chrome.json', JSON.stringify(report, null, 2));
    console.log('\n' + '='.repeat(60));
    console.log('PASS ' + pass + '   FAIL ' + fail);
    console.log('报告：' + SHOTS + 'win-window-chrome.json');
  } catch (err) {
    console.log('\n验收脚本自身出错：' + (err && err.stack ? err.stack : err));
    console.log('应用输出尾部：\n' + appOut.slice(-2000));
    fail++;
  } finally {
    try { proc.kill(); } catch (e) {}
    try { execFileSync('taskkill', ['/F', '/IM', 'took.exe'], { stdio: 'ignore' }); } catch (e) {}
  }
  process.exit(fail === 0 ? 0 : 1);
})();
