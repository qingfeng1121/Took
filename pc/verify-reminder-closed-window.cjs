/* 关键差异点验收：**主窗口关掉之后，后台调度是否还在跑、到点还响不响**。
   做法：起应用 → 建一条 N 秒后到点的提醒 → 用窗口自己的 close() 真关主窗口
          → 确认进程还在（tasklist）与窗口已不在 → 等到点 → 看日志/窗口/截图。
   这一步是 PC 端与「前端 JS 定时器」方案的判据：JS 定时器在窗口销毁后必然停。 */
const { spawn, execFileSync } = require('node:child_process');
const { writeFileSync } = require('node:fs');

const EXE = 'D:/work/Project/Took/pc/src-tauri/target/debug/took.exe';
const SHOTS = 'D:/work/Project/Took/pc/shots/';
const PORT = 9388;
const LEAD = Number(process.argv[2] || 70);
const sleep = ms => new Promise(r => setTimeout(r, ms));

function ps(cmd) { try { return execFileSync('powershell.exe', ['-NoProfile','-Command',cmd], { encoding: 'utf8' }).trim(); } catch (e) { return ''; } }
function procs() { return ps("Get-Process took -ErrorAction SilentlyContinue | ForEach-Object { $_.Id.ToString() + ':' + $_.MainWindowTitle }"); }
function visibleWindows() {
  try {
    return execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'D:/work/Project/Took/pc/_viswin.ps1'], { encoding: 'utf8' }).trim();
  } catch (e) { return 'ERR ' + e.message; }
}
function shot(path) {
  return ps("Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing;" +
    "$b=[System.Windows.Forms.SystemInformation]::VirtualScreen;" +
    "$bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height;" +
    "$g=[System.Drawing.Graphics]::FromImage($bmp);$g.CopyFromScreen($b.Left,$b.Top,0,0,$bmp.Size);" +
    "$bmp.Save('" + path + "');Write-Output ('captured ' + $b.Width + 'x' + $b.Height)");
}
const pad2 = n => (n < 10 ? '0' + n : String(n));
const now0 = new Date();
const fireAt = new Date(now0.getTime() + LEAD * 1000);
const hhmm = pad2(fireAt.getHours()) + ':' + pad2(fireAt.getMinutes());
const todayKey = now0.getFullYear() + '-' + pad2(now0.getMonth() + 1) + '-' + pad2(now0.getDate());

(async () => {
  const proc = spawn(EXE, [], { env: Object.assign({}, process.env, { TOOK_CDP_PORT: String(PORT), WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=' + PORT }), stdio: ['ignore','pipe','pipe'] });
  let log = ''; proc.stdout.on('data', d => log += d); proc.stderr.on('data', d => log += d);
  let target = null;
  for (let i = 0; i < 90 && !target; i++) {
    try { const list = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json();
      target = list.find(t => t.type === 'page' && /tauri\.localhost/.test(t.url)) || null; } catch (e) {}
    if (!target) await sleep(300);
  }
  if (!target) { console.log('连不上 CDP'); console.log(log); proc.kill(); process.exit(2); }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let seq = 0; const pend = new Map();
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); } };
  const send = (method, params) => new Promise((res, rej) => { const id = ++seq; pend.set(id, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id, method, params: params || {} })); });
  const ev = async expr => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text); return r.result.value; };
  await sleep(1500);

  const ruleId = await ev("(async () => await window.__TAURI__.core.invoke('create_rule', { ruleJson: JSON.stringify({ title: '关窗后仍调度', enabled: true, repeat_mode: 4, weekdays_mask: 0, repeat_every: 0, month_day: 0, year_month: 0, year_day: 0, start_date: '" + todayKey + "', end_date: '', repeat_until: '' }), tasks: ['后台任务'] }))()");
  const rid = await ev("(async () => await window.__TAURI__.core.invoke('save_reminder', { reminderJson: JSON.stringify({ owner_kind: 0, owner_id: '" + ruleId + "', notify_on: 1, alarm_on: 0, time_of_day: '" + hhmm + "', notify_text: '窗口已关闭，后台仍在调度', offset_days: 0, repeat_rule: 1, snooze_min: 0, enabled: 1 }) }))()");
  console.log('提醒已存：' + rid + '，计划 ' + hhmm);
  await ev("window.__TAURI__.core.invoke('poke_scheduler', {})");
  await sleep(1200);
  const before = await ev("window.__TAURI__.core.invoke('reminder_status', {})");
  console.log('关窗前排程：' + JSON.stringify(before));
  const pidBefore = procs();
  console.log('关窗前的进程：' + JSON.stringify(pidBefore));

  // ---- 真的关掉主窗口（走窗口自己的 close，会触发 CloseRequested 里的 prevent_close + hide）----
  // 走**用户点关闭**同一条路径：对主窗口句柄发 WM_CLOSE（0x0010）。
  // 不用 CDP 的 window.close()：那条路在隐藏后拿不回真实结果，不能当证据。
  const hwnd = (visibleWindows().split(/\r?\n/).find(l => l.startsWith('W: ')) || '').replace('W: ', '').split('|')[0];
  console.log('主窗口句柄：' + hwnd);
  const closeRes = execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'D:/work/Project/Took/pc/_closewin.ps1', hwnd], { encoding: 'utf8' }).trim();
  console.log('WM_CLOSE 结果：' + JSON.stringify(closeRes));
  await sleep(2500);
  const afterClose = procs();
  const visAfter = visibleWindows();
  console.log('关窗后的进程：' + JSON.stringify(afterClose));
  console.log('关窗后 took 的**可见窗口**：' + JSON.stringify(visAfter));

  // ---- 等到点，看日志有没有「通知已递交」----
  const waitMs = Math.max(0, fireAt.getTime() - Date.now()) + 25000;
  console.log('等待 ' + Math.round(waitMs/1000) + ' 秒，观察后台是否照常触发…');
  let fired = false; const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    if (log.includes('通知已递交')) { fired = true; await sleep(1500); break; }
    await sleep(400);
  }
  const afterLines = log.split(/\r?\n/).filter(l => l.includes('提醒'));
  const finalProcs = procs();
  const visAtFire = visibleWindows();
  const s = shot(SHOTS + 'reminder-fired-window-closed.png');
  console.log('--- 关窗后日志 ---'); console.log(afterLines.join('\n'));
  console.log('--- 关窗后进程 ---'); console.log(JSON.stringify(finalProcs));
  console.log('--- 到点时 took 的可见窗口 ---'); console.log(visAtFire);
  console.log('截图：' + s);

  const out = {
    lead_seconds: LEAD, planned_time: hhmm, rule_id: ruleId, reminder_id: rid,
    status_before_close: before,
    process_before_close: pidBefore,
    process_after_close: afterClose,
    process_at_fire: finalProcs,
    visible_windows_after_close: visAfter,
    visible_windows_at_fire: visAtFire,
    fired_after_window_closed: fired,
    log_lines: afterLines,
    screenshot: s,
  };
  writeFileSync(SHOTS + 'reminder-fired-window-closed.json', JSON.stringify(out, null, 2), 'utf8');
  console.log('结论：窗口关闭后仍触发 = ' + fired);
  try { proc.kill(); } catch (e) {}
  await sleep(500);
  process.exit(fired ? 0 : 3);
})();
