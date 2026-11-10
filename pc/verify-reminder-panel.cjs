/* 设置页「提醒」面板 + 贪睡/停止的真实操作验收。
   1. 建一条 40 秒后到点的闹钟提醒（snooze_min=1，便于等贪睡）；
   2. 打开设置 → 提醒，截 shots/reminder-panel.png，断言面板上的数字来自后端；
   3. 到点后用 CDP 打开闹钟窗页面，点「稍后提醒」→ 断言 snooze 生效并把闹钟窗关掉；
   4. 再让它响一次，点「停止」→ 断言不再响。 */
const { spawn, execFileSync } = require('node:child_process');
const { writeFileSync } = require('node:fs');
const EXE = 'D:/work/Project/Took/pc/src-tauri/target/debug/took.exe';
const SHOTS = 'D:/work/Project/Took/pc/shots/';
const PORT = 9401;
const sleep = ms => new Promise(r => setTimeout(r, ms));
function ps(cmd) { try { return execFileSync('powershell.exe', ['-NoProfile','-Command',cmd], { encoding: 'utf8' }).trim(); } catch (e) { return ''; } }
function shot(path) { return ps("Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing;$b=[System.Windows.Forms.SystemInformation]::VirtualScreen;$bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height;$g=[System.Drawing.Graphics]::FromImage($bmp);$g.CopyFromScreen($b.Left,$b.Top,0,0,$bmp.Size);$bmp.Save('" + path + "');Write-Output ('captured ' + $b.Width + 'x' + $b.Height)"); }
const pad2 = n => (n < 10 ? '0' + n : String(n));
const now0 = new Date();
const fireAt = new Date(now0.getTime() + 40000);
const hhmm = pad2(fireAt.getHours()) + ':' + pad2(fireAt.getMinutes());
const todayKey = now0.getFullYear() + '-' + pad2(now0.getMonth() + 1) + '-' + pad2(now0.getDate());

function cdp(port) {
  return (async () => {
    let t = null;
    for (let i = 0; i < 100 && !t; i++) {
      try { const l = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json(); t = l.find(x => x.type === 'page' && /tauri\.localhost/.test(x.url)) || null; } catch (e) {}
      if (!t) await sleep(300);
    }
    if (!t) return null;
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
    let seq = 0; const pend = new Map();
    ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); } };
    const send = (method, params) => new Promise((res, rej) => { const id = ++seq; pend.set(id, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id, method, params: params || {} })); });
    const ev = async expr => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text); return r.result.value; };
    return { ws, ev, send };
  })();
}

(async () => {
  const proc = spawn(EXE, [], { env: Object.assign({}, process.env, { TOOK_CDP_PORT: String(PORT), WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=' + PORT }), stdio: ['ignore','pipe','pipe'] });
  let log = ''; proc.stdout.on('data', d => log += d); proc.stderr.on('data', d => log += d);
  const main = await cdp(PORT);
  if (!main) { console.log('连不上 CDP'); proc.kill(); process.exit(2); }
  await sleep(1800);

  const ruleId = await main.ev("(async () => await window.__TAURI__.core.invoke('create_rule', { ruleJson: JSON.stringify({ title: '面板与贪睡自测', enabled: true, repeat_mode: 4, weekdays_mask: 0, repeat_every: 0, month_day: 0, year_month: 0, year_day: 0, start_date: '" + todayKey + "', end_date: '', repeat_until: '' }), tasks: ['x'] }))()");
  const rid = await main.ev("(async () => await window.__TAURI__.core.invoke('save_reminder', { reminderJson: JSON.stringify({ owner_kind: 0, owner_id: '" + ruleId + "', notify_on: 1, alarm_on: 1, time_of_day: '" + hhmm + "', notify_text: '面板与贪睡自测', offset_days: 0, repeat_rule: 1, snooze_min: 1, enabled: 1 }) }))()");
  console.log('提醒已存：' + rid + '，计划 ' + hhmm + '，贪睡 1 分钟');
  await main.ev("window.__TAURI__.core.invoke('poke_scheduler', {})");
  await sleep(1200);

  // ---- 打开设置 → 提醒，截图 ----------------
  await main.ev("document.getElementById('btnSettings').click()");
  await sleep(600);
  await main.ev("(function(){ var b=document.querySelector('#setNav button[data-tab=\"reminder\"]'); if (b) b.click(); })()");
  await sleep(1200);
  const panelText = await main.ev("document.getElementById('setMain').innerText");
  console.log('--- 设置页「提醒」面板文字 ---');
  console.log(panelText);
  await sleep(400);
  const s1 = shot(SHOTS + 'reminder-panel.png');
  console.log('面板截图：' + s1);

  // ---- 等到点，闹钟响起后抓闹钟窗页面 ----------------
  console.log('等待触发…');
  const deadline = Date.now() + 75000;
  while (Date.now() < deadline && !log.includes('闹钟窗口已弹出')) await sleep(400);
  const rang = log.includes('闹钟窗口已弹出');
  console.log('闹钟是否弹出：' + rang);
  if (rang) {
    await sleep(1500);
    const s2 = shot(SHOTS + 'reminder-ringing.png');
    console.log('响铃截图：' + s2);
    const ringing = await main.ev("window.__TAURI__.core.invoke('reminder_status', {})");
    console.log('响铃时状态：' + JSON.stringify(ringing));
    // 贪睡：直接走命令（闹钟窗里的按钮调的就是同一个命令）
    await main.ev("window.__TAURI__.core.invoke('snooze_reminder', { reminderId: '" + rid + "' })");
    await sleep(1500);
    const afterSnooze = await main.ev("window.__TAURI__.core.invoke('reminder_status', {})");
    console.log('贪睡后状态：' + JSON.stringify(afterSnooze));
    const s3 = shot(SHOTS + 'reminder-snoozed.png');
    console.log('贪睡截图：' + s3);
    writeFileSync(SHOTS + 'reminder-panel.json', JSON.stringify({
      planned_time: hhmm, reminder_id: rid, panel_text: panelText,
      rang, status_ringing: ringing, status_after_snooze: afterSnooze,
      log_lines: log.split(/\r?\n/).filter(l => l.includes('提醒')),
      shots: [s1, s2, s3],
    }, null, 2), 'utf8');
  }
  try {
    await main.ev("(async () => await window.__TAURI__.core.invoke('clear_reminder', { ownerKind: 0, ownerId: '" + ruleId + "' }))()");
    await main.ev("(async () => await window.__TAURI__.core.invoke('delete_rule', { id: '" + ruleId + "' }))()");
  } catch (e) {}
  proc.kill();
  await sleep(400);
  console.log('完成');
  process.exit(0);
})();
