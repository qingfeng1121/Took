/* 提醒调度的真实触发验收（定稿 §6.3.4 / §6.3.5）—— 不看代码自证，看它真的响。
   步骤：
     1. 起 took.exe（开 CDP 端口），连上 WebView2；
     2. 用**应用自己的命令**建一条只命中今天的规则 + 一条 N 秒后到点的提醒（走 save_reminder 真写库）；
     3. 等它到点：抓进程 stdout 里的「通知已递交 / 闹钟窗口已弹出」、窗口列表里的闹钟窗、整屏截图；
     4. 再从截图与窗口列表取证。
   用法：node verify-reminder-fire.cjs [提前秒数，默认 120]  */
const { spawn, execFileSync } = require('node:child_process');
const { mkdirSync, writeFileSync } = require('node:fs');

const SHOTS = 'D:/work/Project/Took/pc/shots/';
const EXE = 'D:/work/Project/Took/pc/src-tauri/target/debug/took.exe';
const PORT = 9377;
const LEAD = Number(process.argv[2] || 120);
const sleep = ms => new Promise(r => setTimeout(r, ms));

function ps(cmd) {
  try {
    return execFileSync('powershell.exe', ['-NoProfile', '-Command', cmd], { encoding: 'utf8' }).trim();
  } catch (e) { return ''; }
}

function windowsMatching(needle) {
  const out = ps("Get-Process | Where-Object { $_.MainWindowTitle -ne '' } | ForEach-Object { $_.Id.ToString() + ' | ' + $_.ProcessName + ' | ' + $_.MainWindowTitle }");
  return out.split(/\r?\n/).filter(l => l.includes(needle));
}

function screenshot(path) {
  const script = "Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing;" +
    "$b=[System.Windows.Forms.SystemInformation]::VirtualScreen;" +
    "$bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height;" +
    "$g=[System.Drawing.Graphics]::FromImage($bmp);" +
    "$g.CopyFromScreen($b.Left,$b.Top,0,0,$bmp.Size);" +
    "$bmp.Save('" + path + "');" +
    "Write-Output ('captured ' + $b.Width + 'x' + $b.Height)";
  return ps(script);
}

const pad2 = n => (n < 10 ? '0' + n : String(n));
const now = new Date();
const fireAt = new Date(now.getTime() + LEAD * 1000);
const hhmm = pad2(fireAt.getHours()) + ':' + pad2(fireAt.getMinutes());
const todayKey = now.getFullYear() + '-' + pad2(now.getMonth() + 1) + '-' + pad2(now.getDate());

(async () => {
  mkdirSync(SHOTS, { recursive: true });
  console.log('计划触发时刻：' + hhmm + '（今天 ' + todayKey + '，提前 ' + LEAD + ' 秒）');

  const proc = spawn(EXE, [], {
    env: Object.assign({}, process.env, {
      TOOK_CDP_PORT: String(PORT),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=' + PORT,
      RUST_BACKTRACE: '1',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  proc.stdout.on('data', d => { log += d.toString(); });
  proc.stderr.on('data', d => { log += d.toString(); });

  let target = null;
  for (let i = 0; i < 120 && !target; i++) {
    try {
      const list = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json();
      const pages = list.filter(t => t.type === 'page' && t.webSocketDebuggerUrl);
      // 只认真正的应用页面：刚启动时只有一个 about:blank，那时连上去拿不到 __TAURI__
      target = pages.find(t => /index\.html|tauri\.localhost/.test(String(t.url || ''))) || null;
    } catch (e) {}
    if (!target) await sleep(250);
  }
  if (!target) { console.log('连不上 CDP。应用输出：'); console.log(log); proc.kill(); process.exit(2); }
  console.log('CDP 已连上：' + target.url);

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let seq = 0; const pend = new Map();
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.id && pend.has(m.id)) {
      const p = pend.get(m.id); pend.delete(m.id);
      m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
    }
  };
  const send = (method, params) => new Promise((resolve, reject) => {
    const id = ++seq; pend.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params: params || {} }));
  });
  const evalJs = async expr => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error((d.exception && d.exception.description) || d.text);
    }
    return r.result.value;
  };

  await send('Runtime.enable', {}).catch(() => {});
  // 每次运行前确认库里没有别的活动提醒，否则触发结果会混在一起，取证无效
  const pre = await evalJs("(async () => await window.__TAURI__.core.invoke('reminder_upcoming', { limit: 20 }))()");
  if (pre && pre.length) {
    console.log('库里已有活动提醒，先清理再跑：' + JSON.stringify(pre.map(u => u.title)));
    proc.kill(); process.exit(4);
  }
  console.log('运行前活动提醒数：0（干净起点）');
  // 等页面脚本就绪（__TAURI__ 是 inject 后才有的）
  let ready = false;
  for (let i = 0; i < 60 && !ready; i++) {
    ready = await evalJs('!!(window.__TAURI__ && window.__TAURI__.core)').catch(() => false);
    if (!ready) await sleep(300);
  }
  if (!ready) { console.log('页面里拿不到 __TAURI__'); proc.kill(); process.exit(2); }
  console.log('页面已就绪（__TAURI__ 可用）');

  const ruleId = await evalJs("(async () => { const rule = { title: '提醒调度自测', enabled: true, repeat_mode: 4, weekdays_mask: 0, repeat_every: 0, month_day: 0, year_month: 0, year_day: 0, start_date: '" + todayKey + "', end_date: '', repeat_until: '' }; return await window.__TAURI__.core.invoke('create_rule', { ruleJson: JSON.stringify(rule), tasks: ['自测任务'] }); })()");
  console.log('规则已建：' + ruleId);

  const reminderId = await evalJs("(async () => { return await window.__TAURI__.core.invoke('save_reminder', { reminderJson: JSON.stringify({ owner_kind: 0, owner_id: '" + ruleId + "', notify_on: 1, alarm_on: 1, time_of_day: '" + hhmm + "', notify_text: '该打卡了：提醒调度自测', offset_days: 0, repeat_rule: 1, snooze_min: 5, enabled: 1 }) }); })()");
  console.log('提醒已存：' + reminderId + '（通知 + 闹钟，贪睡 5 分钟）');

  await evalJs("window.__TAURI__.core.invoke('poke_scheduler', {})");
  await sleep(1500);
  const st0 = await evalJs("window.__TAURI__.core.invoke('reminder_status', {})");
  const up0 = await evalJs("window.__TAURI__.core.invoke('reminder_upcoming', { limit: 5 })");
  console.log('排程状态：' + JSON.stringify(st0));
  console.log('接下来的提醒：' + JSON.stringify(up0));

  const waitMs = Math.max(0, fireAt.getTime() - Date.now()) + 25000;
  console.log('等待触发（最多 ' + Math.round(waitMs / 1000) + ' 秒）…');
  let fired = false;
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    if (log.includes('通知已递交') || log.includes('闹钟窗口已弹出')) {
      fired = true;
      await sleep(2000);
      break;
    }
    await sleep(500);
  }

  const st1 = await evalJs("window.__TAURI__.core.invoke('reminder_status', {})");
  const titleLines = windowsMatching('Took');
  console.log('--- 触发后状态 ---');
  console.log(JSON.stringify(st1, null, 2));
  console.log('--- 日志里与提醒相关的行 ---');
  console.log(log.split(/\r?\n/).filter(l => l.includes('提醒')).join('\n'));
  console.log('--- 窗口列表（含 Took）---');
  console.log(titleLines.join('\n'));
  const shot = screenshot(SHOTS + 'reminder-fired.png');
  console.log('截图：' + shot);

  const out = {
    lead_seconds: LEAD,
    planned_time: hhmm,
    rule_id: ruleId,
    reminder_id: reminderId,
    status_before: st0,
    upcoming_before: up0,
    status_after: st1,
    fired_in_log: fired,
    notify_in_log: log.includes('通知已递交'),
    alarm_window_in_log: log.includes('闹钟窗口已弹出'),
    alarm_lines: log.split(/\r?\n/).filter(l => l.includes('提醒')),
    window_titles: titleLines,
    alarm_windows: windowsMatching('Took · 提醒'),
    screenshot: shot,
  };
  writeFileSync('D:/work/Project/Took/pc/shots/reminder-fired.json', JSON.stringify(out, null, 2), 'utf8');
  console.log('结果已写 shots/reminder-fired.json');

  try {
    await evalJs("window.__TAURI__.core.invoke('clear_reminder', { ownerKind: 0, ownerId: '" + ruleId + "' })");
    await evalJs("window.__TAURI__.core.invoke('delete_rule', { id: '" + ruleId + "' })");
    console.log('已清理自测数据');
  } catch (e) { console.log('清理失败：' + e.message); }

  try { ws.close(); } catch (e) {}
  proc.kill();
  await sleep(500);
  process.exit(fired ? 0 : 3);
})();
