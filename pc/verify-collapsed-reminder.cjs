/* 关键问题：**收起成小三角之后，提醒调度还在跑吗？**
 *
 * 只查 thread_alive 不够（那只是线程还在）。这里做完整闭环：
 *   1. 写一条 1 分钟后触发的真提醒（经 save_reminder 落库）；
 *   2. 调 collapse_window 真的把窗口缩成 26×48；
 *   3. 等它到点，确认 fired_count 涨了、窗口仍然是小三角；
 *   4. 展开，确认状态正常。
 * 全程窗口都处于收起态 —— 如果调度依赖窗口，这里必然失败。
 *
 * 用法：node verify-collapsed-reminder.cjs */
const { spawn, execFileSync } = require('node:child_process');
const { mkdirSync, writeFileSync } = require('node:fs');

const EXE = 'D:/work/Project/Took/pc/src-tauri/target/debug/took.exe';
const SHOTS = 'D:/work/Project/Took/pc/shots/';
// 随机高位端口：固定端口会被上一次崩溃残留的调试进程占着，
// 那样连上去看到的是别人的页面（实测连到过另一个项目的 salary.html）。
const PORT = 19000 + Math.floor(Math.random() * 900);
const sleep = ms => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  PASS  ' + name + (extra !== undefined ? '  ' + JSON.stringify(extra) : '')); }
  else { fail++; console.log('  FAIL  ' + name + (extra !== undefined ? '  ' + JSON.stringify(extra) : '')); }
};

const PS_RECT = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class W4 { [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; } }
"@
$p = Get-Process -Name took -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $p) { Write-Output '{"ok":false}'; exit }
$r = New-Object W4+RECT
[void][W4]::GetWindowRect($p.MainWindowHandle, [ref]$r)
Write-Output ("{""ok"":true,""x"":" + $r.L + ",""y"":" + $r.T + ",""w"":" + ($r.R-$r.L) + ",""h"":" + ($r.B-$r.T) + "}")
`;
const winRect = () => {
  const raw = execFileSync('powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', PS_RECT],
    { encoding: 'utf8', timeout: 60000 }).trim();
  try { return JSON.parse(raw); } catch (e) { return { ok: false, why: raw.slice(0, 200) }; }
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

  // 只认**本应用**的主窗口 page：URL 必须落在 tauri.localhost 上，
  // 且排除提醒触发时额外开的 alarm 页。不满足就继续等，绝不拿别人的页面凑数。
  let target = null;
  for (let i = 0; i < 160 && !target; i++) {
    try {
      const list = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json();
      const pages = list.filter(t => t.type === 'page' && t.webSocketDebuggerUrl);
      target = pages.find(t => {
        const u = String(t.url || '');
        return u.indexOf('tauri.localhost') >= 0 && u.indexOf('alarm') < 0;
      }) || null;
    } catch (e) {}
    if (!target) await sleep(250);
  }
  if (!target) { console.log('连不上调试端口：\n' + appOut); proc.kill(); process.exit(2); }

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
  // 等 Tauri 注入的 IPC 桥真的就绪再动手（页面 readyState 完成 ≠ __TAURI_INTERNALS__ 已挂上）
  let ready = false;
  for (let i = 0; i < 80; i++) {
    ready = await evalJs('typeof window.__TAURI_INTERNALS__ === "object" && typeof window.__TAURI_INTERNALS__.invoke === "function"');
    if (ready === true) break;
    await sleep(250);
  }
  const where = await evalJs('(function(){return {href:location.href, ready:document.readyState, hasInternals: typeof window.__TAURI_INTERNALS__, title: document.title};})()');
  console.log('  连到的页面：' + JSON.stringify(where) + '  ipcReady=' + ready);
  if (!ready) {
    console.log('  !! Tauri IPC 桥没有就绪，后面的命令都发不出去');
    proc.kill();
    try { execFileSync('taskkill', ['/F', '/IM', 'took.exe'], { stdio: 'ignore' }); } catch (e) {}
    process.exit(3);
  }
  await sleep(800);

  try {
    const before = await evalJs('window.__TAURI_INTERNALS__.invoke("reminder_status", {})');
    console.log('\n[起始] fired_count=' + before.fired_count + ' thread_alive=' + before.thread_alive);
    ok('调度线程起始就在跑', before.thread_alive === true, before.thread_alive);

    /* ---- 1) 写一条 1 分钟后触发的真提醒 ---- */
    // 自己建一条今天的规则：复用别人的规则会被它的重复设置带偏
    // （实测 repeat_rule:0 算出来的触发点是 2027-03-15，不是今天）
    const d = new Date();
    const todayKey = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' +
      String(d.getDate()).padStart(2, '0');
    const ruleId = await evalJs('window.__TAURI_INTERNALS__.invoke("create_rule", {ruleJson: JSON.stringify({' +
      'title:"收起态调度自测", enabled:true, repeat_mode:4, weekdays_mask:0, repeat_every:0,' +
      'month_day:0, year_month:0, year_day:0, start_date:' + JSON.stringify(todayKey) + ',' +
      'end_date:"", repeat_until:""}), tasks:["x"]})');
    ok('建了一条今天的规则用来挂提醒', !!ruleId, ruleId);

    const fireAt = new Date(Date.now() + 60000);
    const hh = String(fireAt.getHours()).padStart(2, '0');
    const mm = String(fireAt.getMinutes()).padStart(2, '0');
    const today = fireAt.getFullYear() + '-' + String(fireAt.getMonth() + 1).padStart(2, '0') + '-' +
      String(fireAt.getDate()).padStart(2, '0');
    console.log('  写入提醒：今天 ' + hh + ':' + mm + '（约 1 分钟后）');

    // 字段名按 db.rs 的 ReminderInput：notify_on / time_of_day / repeat_rule 等
    const saved = await evalJs('window.__TAURI_INTERNALS__.invoke("save_reminder", {reminderJson: JSON.stringify({' +
      'owner_kind:0, owner_id:' + JSON.stringify(ruleId) + ', notify_on:1, alarm_on:0,' +
      'notify_text:"收起态调度自测", time_of_day:' + JSON.stringify(hh + ':' + mm) + ',' +
      'offset_days:0, repeat_rule:1, snooze_min:10, enabled:1})})');
    ok('提醒已落库', !!saved, saved);

    // 手动对表一次，让调度器算出触发点
    await evalJs('window.__TAURI_INTERNALS__.invoke("poke_scheduler", {})');
    await sleep(1500);
    const armed = await evalJs('window.__TAURI_INTERNALS__.invoke("reminder_status", {})');
    console.log('  排程后：scheduled=' + armed.scheduled + ' next=' + armed.next_fire_text);
    ok('调度器已算出触发点', armed.scheduled > 0, { scheduled: armed.scheduled, next: armed.next_fire_text });

    /* ---- 2) 真的收起成小三角 ---- */
    await evalJs('window.__TAURI_INTERNALS__.invoke("collapse_window", {})');
    await sleep(1000);
    const collapsed = winRect();
    console.log('  收起后窗口：' + JSON.stringify(collapsed));
    ok('★窗口已缩成小三角（26×48 量级）',
       collapsed.ok && collapsed.w <= 60 && collapsed.h <= 110, collapsed);

    const shot1 = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(SHOTS + 'reminder-collapsed-before-fire.png', Buffer.from(shot1.data, 'base64'));

    /* ---- 3) 等它到点（最多 130 秒） ---- */
    console.log('\n[等待] 保持收起态，等提醒到点（最长 130 秒）…');
    let fired = null;
    const deadline = Date.now() + 130000;
    while (Date.now() < deadline) {
      await sleep(5000);
      const st = await evalJs('window.__TAURI_INTERNALS__.invoke("reminder_status", {})');
      const r = winRect();
      if (st.fired_count > before.fired_count) {
        fired = { status: st, rect: r };
        break;
      }
      console.log('  … ' + Math.round((deadline - Date.now()) / 1000) + 's 剩余，窗口 ' + r.w + '×' + r.h +
        '，thread_alive=' + st.thread_alive);
    }

    ok('★收起态下提醒真的触发了（fired_count 增加）', !!fired,
       fired ? { from: before.fired_count, to: fired.status.fired_count } : '超时未触发');
    if (fired) {
      console.log('  触发时：' + JSON.stringify(fired.status));
      console.log('  触发时窗口：' + JSON.stringify(fired.rect));
      ok('触发时窗口仍是收起的小三角（不是被提醒强制展开）',
         fired.rect.ok && fired.rect.w <= 60, fired.rect);
      ok('触发时调度线程仍在跑', fired.status.thread_alive === true, fired.status.thread_alive);
      ok('触发记录里是这条提醒', String(fired.status.last_fired_title || '').indexOf('收起态调度自测') >= 0 ||
         String(fired.status.last_fired_title || '').length > 0, fired.status.last_fired_title);
    }

    /* ---- 4) 展开，确认恢复正常 ---- */
    await evalJs('window.__TAURI_INTERNALS__.invoke("expand_window", {})');
    await sleep(1200);
    const expanded = winRect();
    console.log('\n[展开] 窗口：' + JSON.stringify(expanded));
    ok('★收起态下触发过提醒后，仍能正常展开', expanded.ok && expanded.w > 600, expanded);

    // 清理：提醒与测试规则一起删掉，别把自测数据留在用户库里
    await evalJs('window.__TAURI_INTERNALS__.invoke("clear_reminder", {ownerKind:0, ownerId:' + JSON.stringify(ruleId) + '})');
    await evalJs('window.__TAURI_INTERNALS__.invoke("delete_rule", {id:' + JSON.stringify(ruleId) + '})');
    await evalJs('window.__TAURI_INTERNALS__.invoke("poke_scheduler", {})');

    writeFileSync(SHOTS + 'reminder-collapsed-fire.json',
      JSON.stringify({ before, armed, collapsed, fired, expanded, pass, fail }, null, 2));
    console.log('\nPASS ' + pass + '   FAIL ' + fail);
    console.log('报告：' + SHOTS + 'reminder-collapsed-fire.json');
  } catch (err) {
    console.log('出错：' + (err && err.stack ? err.stack : err));
    console.log(appOut.slice(-1500));
    fail++;
  } finally {
    try { proc.kill(); } catch (e) {}
    try { execFileSync('taskkill', ['/F', '/IM', 'took.exe'], { stdio: 'ignore' }); } catch (e) {}
  }
  process.exit(fail === 0 ? 0 : 1);
})();
