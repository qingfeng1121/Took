/* 提醒的存 / 显示 / 同步入口验收（契约 §11.1、§11.3、§11.4 的界面侧 R1~R3）。
   两种模式：
     node verify-reminder.cjs          浏览器 + mock.js（快速迭代，无真实库）
     node verify-reminder.cjs --tauri  真窗口 + WebView2 CDP（写真实 SQLite）
   断言全部走真 DOM 与真命令；收尾把那条例子的提醒点回「不提醒」并保存，不留脏数据。 */
const { spawn } = require('node:child_process');
const { mkdtempSync, mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

const TAURI = process.argv.includes('--tauri');
const EXE = 'D:/work/Project/Took/pc/src-tauri/target/debug/took.exe';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const UI = 'D:/work/Project/Took/pc/ui/';
const SHOTS = 'D:/work/Project/Took/pc/shots/';
const sleep = ms => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  PASS  ' + name + (extra !== undefined ? '  ' + JSON.stringify(extra) : '')); }
  else { fail++; console.log('  FAIL  ' + name + (extra !== undefined ? '  ' + JSON.stringify(extra) : '')); }
};

(async () => {
  mkdirSync(SHOTS, { recursive: true });
  let proc, target = null;
  if (TAURI) {
    const PORT = 9351;
    proc = spawn(EXE, [], {
      env: Object.assign({}, process.env, {
        TOOK_CDP_PORT: String(PORT),
        WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=' + PORT,
      }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    proc.stdout.on('data', d => { out += d.toString(); });
    proc.stderr.on('data', d => { out += d.toString(); });
    for (let i = 0; i < 100 && !target; i++) {
      try {
        const list = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json();
        target = list.filter(t => t.type === 'page' && t.webSocketDebuggerUrl)[0] || null;
      } catch (e) {}
      if (!target) await sleep(250);
    }
    if (!target) { console.log('连不上 WebView2 调试端口；应用输出：\n' + out); proc.kill(); process.exit(2); }
  } else {
    const port = 15700 + Math.floor(Math.random() * 1500);
    const profile = mkdtempSync(join(process.env.TEMP, 'tookrem-'));
    proc = spawn(CHROME, ['--headless=new', '--remote-debugging-port=' + port,
      '--user-data-dir=' + profile, '--window-size=1280,900', '--hide-scrollbars',
      '--force-device-scale-factor=1', '--no-first-run', '--no-default-browser-check',
      '--allow-file-access-from-files', 'file:///' + UI + 'index.html'], { stdio: 'ignore' });
    for (let i = 0; i < 80 && !target; i++) {
      try {
        const list = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
        const pages = list.filter(t => t.type === 'page' && t.webSocketDebuggerUrl);
        target = pages.find(t => String(t.url || '').indexOf('index.html') >= 0) || pages[0] || null;
      } catch (e) {}
      if (!target) await sleep(200);
    }
    if (!target) { console.log('连不上 Chrome 调试端口'); proc.kill(); process.exit(2); }
  }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let seq = 0; const pend = new Map(); const errors = [];
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      errors.push((d.exception && d.exception.description) || d.text);
    }
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
  };
  await send('Runtime.enable');
  await sleep(TAURI ? 2400 : 1400);

  /* 被测规则用种子里的「单词打卡」（r_words）；收尾把提醒点回不提醒，库里不留活动提醒行 */
  const RULE = 'r_words';
  const J = JSON.stringify;

  await evalJs("(function(){ window.__R = {" +
    " click: function(sel){ var el=document.querySelector(sel); if(!el) throw new Error('找不到 '+sel); el.click(); return true; }," +
    " edit: function(id){ var b=document.querySelector('[data-rule-block=\"'+id+'\"] [data-act=\"edit\"]'); if(!b) throw new Error('没有编辑按钮 '+id); b.click(); return true; }," +
    " remind: function(v){ return window.__R.click('#fRemind [data-remind=\"'+v+'\"]'); }," +
    " lit: function(){ return [].slice.call(document.querySelectorAll('#fRemind [data-remind]')).filter(function(b){ return b.classList.contains('on'); }).map(function(b){ return b.dataset.remind; }); }," +
    " pressed: function(){ return [].slice.call(document.querySelectorAll('#fRemind [data-remind]')).filter(function(b){ return b.getAttribute('aria-pressed')==='true'; }).map(function(b){ return b.dataset.remind; }); }," +
    " has: function(id){ return !!document.getElementById(id); }," +
    " setTime: function(v){ var el=document.getElementById('fRemindTime'); if(!el) throw new Error('没有时间输入'); el.value=v; el.dispatchEvent(new Event('input',{bubbles:true})); return el.value; }," +
    " time: function(){ var el=document.getElementById('fRemindTime'); return el?el.value:null; }," +
    " text: function(){ var el=document.getElementById('fNotifyText'); return el?el.value:null; }," +
    " snoozed: function(){ var el=document.getElementById('fSnooze'); return el?el.checked:null; }," +
    " save: function(){ return window.__R.click('#fSave'); }," +
    " summary: function(id){ var b=document.querySelector('[data-rule-block=\"'+id+'\"]'); if(!b) return null; var i=b.querySelector('.rule-main i'); return i?i.textContent:null; }," +
    " ruleIds: function(){ return [].slice.call(document.querySelectorAll('[data-rule-block]')).map(function(b){ return b.dataset.ruleBlock; }); }" +
    " }; return true; })()");

  try {
    console.log('\n[0] 数据源');
    console.log('  ' + await evalJs("document.getElementById('sourceTag').textContent"));

    await evalJs("window.__R.click('#btnNew')");
    await sleep(400);
    ok('配置页能定位到被测规则「单词打卡」', (await evalJs("window.__R.ruleIds()")).indexOf(RULE) >= 0);

    console.log('\n[R0] 打开规则表单：提醒区默认「不提醒」');
    await evalJs("window.__R.edit(" + J(RULE) + ")");
    await sleep(600);
    const labels = await evalJs("[].slice.call(document.querySelectorAll('#fRemind [data-remind]')).map(function(b){ return b.textContent; })");
    ok('提醒区是「不提醒 / 通知 / 闹钟」三个按钮', J(labels) === J(['不提醒', '通知', '闹钟']), labels);
    ok('初始只有「不提醒」亮（种子规则本来没提醒）', J(await evalJs("window.__R.lit()")) === J(['none']), await evalJs("window.__R.lit()"));
    ok('未开提醒时不显示时间 / 文案 / 贪睡控件',
      !(await evalJs("window.__R.has('fRemindTime')")) && !(await evalJs("window.__R.has('fNotifyText')")) && !(await evalJs("window.__R.has('fSnooze')")));

    console.log('\n[R1] 点「通知」→ 只开通知，出现时间与通知文案');
    await evalJs("window.__R.remind('notify')");
    await sleep(200);
    ok('通知亮、不提醒灭', J(await evalJs("window.__R.lit()")) === J(['notify']), await evalJs("window.__R.lit()"));
    ok('aria-pressed 与视觉一致（通知 true、闹钟 false）',
      J(await evalJs("window.__R.pressed()")) === J(['notify']), await evalJs("window.__R.pressed()"));
    ok('出现提醒时间输入（通知也要能定 21:00）', await evalJs("window.__R.has('fRemindTime')"));
    ok('出现通知文案输入（闹钟字段还没出来）',
      (await evalJs("window.__R.has('fNotifyText')")) && !(await evalJs("window.__R.has('fSnooze')")));
    await evalJs("window.__R.setTime('21:00')");
    await shot('tauri-remind-notify.png');

    console.log('\n[R2] 再点「闹钟」→ 两项都亮（独立开关，不是三选一）');
    await evalJs("window.__R.remind('alarm')");
    await sleep(200);
    ok('通知 + 闹钟两项都亮', J(await evalJs("window.__R.lit()")) === J(['notify', 'alarm']), await evalJs("window.__R.lit()"));
    ok('出现贪睡开关，且默认勾上 5 分钟', await evalJs("window.__R.snoozed()") === true);
    await shot('tauri-remind-both.png');

    console.log('\n[保存] 落库后列表摘要');
    await evalJs("window.__R.save()");
    await sleep(900);
    const sum1 = await evalJs("window.__R.summary(" + J(RULE) + ")");
    ok('规则列表摘要显示「通知 21:00 + 闹钟 21:00」', String(sum1 || '').indexOf('通知 21:00 + 闹钟 21:00') >= 0, sum1);

    console.log('\n[重开] 表单回读这次的提醒');
    await evalJs("window.__R.edit(" + J(RULE) + ")");
    await sleep(700);
    ok('重开后仍是两项都亮', J(await evalJs("window.__R.lit()")) === J(['notify', 'alarm']), await evalJs("window.__R.lit()"));
    ok('时间回读为 21:00', (await evalJs("window.__R.time()")) === '21:00', await evalJs("window.__R.time()"));

    console.log('\n[R3] 点「不提醒」→ 都灭、不留残值');
    await evalJs("window.__R.remind('none')");
    await sleep(200);
    ok('通知与闹钟都灭、只剩「不提醒」亮（不会三项全灭）',
      J(await evalJs("window.__R.lit()")) === J(['none']), await evalJs("window.__R.lit()"));
    ok('时间 / 文案 / 贪睡控件全部收起',
      !(await evalJs("window.__R.has('fRemindTime')")) && !(await evalJs("window.__R.has('fNotifyText')")) && !(await evalJs("window.__R.has('fSnooze')")));
    await evalJs("window.__R.remind('notify')");
    await sleep(200);
    ok('再开通知时文案框是空的（没有残留上一次的文案）', (await evalJs("window.__R.text()")) === '', await evalJs("window.__R.text()"));
    await evalJs("window.__R.remind('none')");
    await sleep(150);
    await shot('tauri-remind-none.png');
    await evalJs("window.__R.save()");
    await sleep(900);
    const sum2 = await evalJs("window.__R.summary(" + J(RULE) + ")");
    ok('保存后列表摘要里不再有提醒', String(sum2 || '').indexOf('提醒') < 0 && String(sum2 || '').indexOf('通知') < 0, sum2);

    console.log('\n[复查] 再打开表单 → 回到「不提醒」（软删生效，不是靠界面记性）');
    await evalJs("window.__R.edit(" + J(RULE) + ")");
    await sleep(700);
    ok('重开后回到「不提醒」', J(await evalJs("window.__R.lit()")) === J(['none']), await evalJs("window.__R.lit()"));
    ok('没有时间输入（那行提醒已经软删）', !(await evalJs("window.__R.has('fRemindTime')")));
    await evalJs("window.__R.click('#fCancel')");
    await sleep(300);

    console.log('\n[9] 控制台');
    ok('无 JS 运行时错误', errors.length === 0, errors);
  } finally {
    console.log('\n结果：' + pass + ' passed, ' + fail + ' failed');
    try { ws.close(); } catch (e) {}
    try { proc.kill(); } catch (e) {}
    process.exit(fail ? 1 : 0);
  }
})();
