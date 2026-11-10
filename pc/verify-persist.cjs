/* 重启持久化验收：透明度、吸附边缘、自动收起开关三项都必须跨进程保持；
   收起态则**必须不保持**（重启回到展开，否则用户会以为程序坏了）。

   流程：起进程 A → 改三项 → 杀掉 → 起进程 B → 读回验证。

   用法：node verify-persist.cjs */
const { spawn, execFileSync } = require('node:child_process');
const { mkdirSync, writeFileSync } = require('node:fs');

const EXE = 'D:/work/Project/Took/pc/src-tauri/target/debug/took.exe';
const SHOTS = 'D:/work/Project/Took/pc/shots/';
const PORT = 9377;
const sleep = ms => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  PASS  ' + name + (extra !== undefined ? '  ' + JSON.stringify(extra) : '')); }
  else { fail++; console.log('  FAIL  ' + name + (extra !== undefined ? '  ' + JSON.stringify(extra) : '')); }
};

/* 起一个进程、连上 CDP、返回 { evalJs, kill } */
async function boot(tag) {
  const proc = spawn(EXE, [], {
    env: Object.assign({}, process.env, { TOOK_CDP_PORT: String(PORT) }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  proc.stdout.on('data', d => { out += d.toString(); });
  proc.stderr.on('data', d => { out += d.toString(); });
  let target = null;
  for (let i = 0; i < 120 && !target; i++) {
    try {
      const list = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json();
      target = list.filter(t => t.type === 'page' && t.webSocketDebuggerUrl)[0] || null;
    } catch (e) {}
    if (!target) await sleep(250);
  }
  if (!target) throw new Error('[' + tag + '] 连不上调试端口：\n' + out);
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
  await send('Runtime.enable');
  await sleep(3000);
  return {
    evalJs,
    stdout: () => out,
    kill: () => {
      try { ws.close(); } catch (e) {}
      try { proc.kill(); } catch (e) {}
      try { execFileSync('taskkill', ['/F', '/IM', 'took.exe'], { stdio: 'ignore' }); } catch (e) {}
    },
  };
}

(async () => {
  mkdirSync(SHOTS, { recursive: true });
  const evidence = {};
  try {
    /* ============ 进程 A：改三项 + 收起 ============ */
    console.log('\n[A] 第一次启动：把三项改成非默认值，然后收起');
    const a = await boot('A');
    const before = await a.evalJs('window.__TAURI_INTERNALS__.invoke("window_chrome_status", {})');
    console.log('  启动时：' + JSON.stringify(before));

    await a.evalJs('window.__TAURI_INTERNALS__.invoke("set_opacity", {value:55})');
    await a.evalJs('window.__TAURI_INTERNALS__.invoke("set_snap_edge", {edge:"left"})');
    await a.evalJs('window.__TAURI_INTERNALS__.invoke("set_snap_auto_hide", {on:true})');
    await sleep(800);
    await a.evalJs('window.__TAURI_INTERNALS__.invoke("collapse_window", {})');
    await sleep(900);

    const changed = await a.evalJs('window.__TAURI_INTERNALS__.invoke("window_chrome_status", {})');
    console.log('  改完后：' + JSON.stringify(changed));
    ok('A: 透明度已设为 55', Number(changed.opacity) === 55, changed.opacity);
    ok('A: 吸附边缘已设为 left', changed.snap_edge === 'left', changed.snap_edge);
    ok('A: 自动收起已打开', changed.snap_auto_hide === true, changed.snap_auto_hide);
    ok('A: 当前处于收起态', changed.collapsed === true, changed.collapsed);
    evidence.processA = changed;

    a.kill();
    await sleep(2500);

    /* ============ 进程 B：重启后读回 ============ */
    console.log('\n[B] 重启（全新进程）：读回三项 + 确认已展开');
    const b = await boot('B');
    const after = await b.evalJs('window.__TAURI_INTERNALS__.invoke("window_chrome_status", {})');
    console.log('  重启后：' + JSON.stringify(after));
    evidence.processB = after;
    evidence.stdoutB = b.stdout().split('\n').filter(l => l.indexOf('[took][窗口]') >= 0);

    ok('★B: 透明度跨重启保持 55', Number(after.opacity) === 55, after.opacity);
    ok('★B: 吸附边缘跨重启保持 left', after.snap_edge === 'left', after.snap_edge);
    ok('★B: 自动收起开关跨重启保持 true', after.snap_auto_hide === true, after.snap_auto_hide);
    ok('★B: 收起态**没有**被恢复（重启回到展开）', after.collapsed === false, after.collapsed);

    // Win32 层也要对：重启后 alpha 必须已经是 55% 对应的值
    const rawAlpha = await b.evalJs('window.__TAURI_INTERNALS__.invoke("window_opacity", {})');
    ok('★B: 重启后 Win32 层的 alpha 也是 55%（启动时就恢复了，不只是库里存着）',
       Math.abs(Number(rawAlpha) - 55) <= 1, rawAlpha);

    // 页面 UI 也要显示 55，不是默认 100
    await b.evalJs('document.getElementById("btnSettings").click()');
    await sleep(400);
    await b.evalJs('document.querySelector(\'#setNav button[data-tab="appearance"]\').click()');
    await sleep(900);
    const ui = await b.evalJs('(function(){var r=document.getElementById("winOpacity");' +
      'return {value:r?r.value:null, label:(document.getElementById("winOpacityVal")||{}).textContent};})()');
    ok('B: 外观页滑块显示重启前保存的 55%', ui.value === '55' && ui.label === '55%', ui);

    // 窗口真的是正常大小（不是小三角）
    const PS_RECT = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class W3 { [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; } }
"@
$p = Get-Process -Name took -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $p) { Write-Output '{"ok":false}'; exit }
$r = New-Object W3+RECT
[void][W3]::GetWindowRect($p.MainWindowHandle, [ref]$r)
Write-Output ("{""ok"":true,""w"":" + ($r.R-$r.L) + ",""h"":" + ($r.B-$r.T) + "}")
`;
    const rect = JSON.parse(execFileSync('powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', PS_RECT],
      { encoding: 'utf8', timeout: 60000 }).trim());
    console.log('  重启后窗口矩形：' + JSON.stringify(rect));
    ok('★B: 重启后窗口是正常大小（不是一个 26×48 的小三角）',
       rect.ok && rect.w > 600 && rect.h > 400, rect);
    evidence.rectB = rect;

    // 复原成默认，别把测试值留在用户设置里
    await b.evalJs('window.__TAURI_INTERNALS__.invoke("set_opacity", {value:100})');
    await b.evalJs('window.__TAURI_INTERNALS__.invoke("set_snap_edge", {edge:"none"})');
    await b.evalJs('window.__TAURI_INTERNALS__.invoke("set_snap_auto_hide", {on:false})');
    await sleep(600);
    b.kill();

    writeFileSync(SHOTS + 'win-persist.json', JSON.stringify(evidence, null, 2));
    console.log('\nPASS ' + pass + '   FAIL ' + fail);
    console.log('报告：' + SHOTS + 'win-persist.json');
  } catch (err) {
    console.log('出错：' + (err && err.stack ? err.stack : err));
    fail++;
    try { execFileSync('taskkill', ['/F', '/IM', 'took.exe'], { stdio: 'ignore' }); } catch (e) {}
  }
  process.exit(fail === 0 ? 0 : 1);
})();
