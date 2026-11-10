/* 贪睡真的会重排：到点响 → 贪睡 1 分钟 → 等 1 分钟 → 必须再响一次（fired_count 从 1 变 2）。
   这是定稿 §6.3.5「点贪睡 → 停止铃 → 到点再次拉起」的判据，不看代码看行为。 */
const { spawn, execFileSync } = require('node:child_process');
const { writeFileSync } = require('node:fs');
const EXE = 'D:/work/Project/Took/pc/src-tauri/target/debug/took.exe';
const SHOTS = 'D:/work/Project/Took/pc/shots/';
const PORT = 9402;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const pad2 = n => (n < 10 ? '0' + n : String(n));
const now0 = new Date();
const fireAt = new Date(now0.getTime() + 40000);
const hhmm = pad2(fireAt.getHours()) + ':' + pad2(fireAt.getMinutes());
const todayKey = now0.getFullYear() + '-' + pad2(now0.getMonth() + 1) + '-' + pad2(now0.getDate());

(async () => {
  const proc = spawn(EXE, [], { env: Object.assign({}, process.env, { TOOK_CDP_PORT: String(PORT), WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=' + PORT }), stdio: ['ignore','pipe','pipe'] });
  let log = ''; proc.stdout.on('data', d => log += d); proc.stderr.on('data', d => log += d);
  let t = null;
  for (let i = 0; i < 100 && !t; i++) { try { const l = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json(); t = l.find(x => x.type === 'page' && /tauri\.localhost/.test(x.url)) || null; } catch (e) {} if (!t) await sleep(300); }
  const ws = new WebSocket(t.webSocketDebuggerUrl); await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j;});
  let seq = 0; const pend = new Map();
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); } };
  const send = (method, params) => new Promise((res, rej) => { const id = ++seq; pend.set(id, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id, method, params: params || {} })); });
  const ev = async expr => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text); return r.result.value; };
  await sleep(1800);

  const ruleId = await ev("(async () => await window.__TAURI__.core.invoke('create_rule', { ruleJson: JSON.stringify({ title: '贪睡重排自测', enabled: true, repeat_mode: 4, weekdays_mask: 0, repeat_every: 0, month_day: 0, year_month: 0, year_day: 0, start_date: '" + todayKey + "', end_date: '', repeat_until: '' }), tasks: ['y'] }))()");
  const rid = await ev("(async () => await window.__TAURI__.core.invoke('save_reminder', { reminderJson: JSON.stringify({ owner_kind: 0, owner_id: '" + ruleId + "', notify_on: 0, alarm_on: 1, time_of_day: '" + hhmm + "', notify_text: '贪睡重排自测', offset_days: 0, repeat_rule: 1, snooze_min: 1, enabled: 1 }) }))()");
  console.log('闹钟提醒已存：' + rid + '，计划 ' + hhmm + '，贪睡 1 分钟');
  await ev("window.__TAURI__.core.invoke('poke_scheduler', {})");
  await sleep(1000);

  const before = await ev("window.__TAURI__.core.invoke('reminder_status', {})");
  console.log('响之前 fired_count=' + before.fired_count);
  const d1 = Date.now() + 75000;
  while (Date.now() < d1 && !log.includes('闹钟窗口已弹出')) await sleep(400);
  const firstRing = log.includes('闹钟窗口已弹出');
  console.log('第一次响：' + firstRing);
  const st1 = await ev("window.__TAURI__.core.invoke('reminder_status', {})");
  console.log('第一次响后：' + JSON.stringify({ fired: st1.fired_count, ringing: st1.ringing, sound: st1.sound_playing }));

  // 贪睡（闹钟窗里「稍后提醒 1 分钟」按钮调用同一个命令）
  await ev("window.__TAURI__.core.invoke('snooze_reminder', { reminderId: '" + rid + "' })");
  await sleep(1500);
  const st2 = await ev("window.__TAURI__.core.invoke('reminder_status', {})");
  console.log('贪睡后：' + JSON.stringify({ fired: st2.fired_count, ringing: st2.ringing, sound: st2.sound_playing }));
  const logLenAtSnooze = log.length;

  // 等贪睡到点（1 分钟）+ 对表容差
  console.log('等贪睡到点（约 75 秒）…');
  const d2 = Date.now() + 110000;
  let refired = false;
  while (Date.now() < d2) {
    if (log.slice(logLenAtSnooze).includes('闹钟窗口已弹出')) { refired = true; break; }
    await sleep(500);
  }
  await sleep(1500);
  const st3 = await ev("window.__TAURI__.core.invoke('reminder_status', {})");
  console.log('贪睡到点后：' + JSON.stringify({ fired: st3.fired_count, ringing: st3.ringing, sound: st3.sound_playing, refired }));

  // 停止
  await ev("window.__TAURI__.core.invoke('stop_reminder', { reminderId: '" + rid + "' })");
  await sleep(1500);
  const st4 = await ev("window.__TAURI__.core.invoke('reminder_status', {})");
  console.log('停止后：' + JSON.stringify({ ringing: st4.ringing, sound: st4.sound_playing }));

  const out = {
    planned_time: hhmm, reminder_id: rid,
    first_ring: firstRing, refired_after_snooze: refired,
    status_before: before, status_after_first_ring: st1,
    status_after_snooze: st2, status_after_refire: st3, status_after_stop: st4,
    log_lines: log.split(/\r?\n/).filter(l => l.includes('提醒')),
  };
  writeFileSync(SHOTS + 'reminder-snooze.json', JSON.stringify(out, null, 2), 'utf8');
  console.log('结论：贪睡后再次响起 = ' + refired);
  console.log('日志：'); console.log(out.log_lines.join('\n'));
  try {
    await ev("(async () => await window.__TAURI__.core.invoke('clear_reminder', { ownerKind: 0, ownerId: '" + ruleId + "' }))()");
    await ev("(async () => await window.__TAURI__.core.invoke('delete_rule', { id: '" + ruleId + "' }))()");
  } catch (e) {}
  proc.kill(); await sleep(400);
  process.exit(refired ? 0 : 3);
})();
