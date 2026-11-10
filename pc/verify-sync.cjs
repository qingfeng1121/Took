/* 同步验收：真 Go 后端（server/）+ 真 Tauri 窗口（CDP 驱动）走一遍 sync_now。
   后端接口 server/main.go 已实现 /api/sync/push 与 /api/sync/pull（契约 §7.1），
   所以这里不是 mock：请求/响应来自真后端，本地库变化来自 %APPDATA% 里的 took.db。 */
const { spawn } = require('node:child_process');
const { writeFileSync, mkdirSync } = require('node:fs');

const EXE = 'D:/work/Project/Took/pc/src-tauri/target/debug/took.exe';
const SHOTS = 'D:/work/Project/Took/pc/shots/';
const LOCAL_DB = 'C:/Users/30803/AppData/Roaming/app.took.desktop/took.db';
const SERVER = 'http://127.0.0.1:8420';
const SERVER_DB = 'C:/Users/30803/AppData/Local/Temp/took-sync-test.db';
const PORT = 9334;
const sleep = ms => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  PASS  ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  ' + extra : '')); }
};

function dumpLocal(label) {
  try {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(LOCAL_DB, { readOnly: true });
    const rows = db.prepare('SELECT task_id,period_start,status,rev,updated_at,dirty FROM completion ORDER BY task_id').all();
    const state = db.prepare("SELECT key,value FROM local_state WHERE key IN ('last_pulled_rev','last_sync_at','sync_url','last_error')").all();
    db.close();
    console.log('  [' + label + '] completion: ' + JSON.stringify(rows));
    console.log('  [' + label + '] local_state: ' + JSON.stringify(state));
    return { rows, state };
  } catch (e) {
    console.log('  [' + label + '] 本地库还不存在（首次启动会建表写种子）：' + e.message);
    return null;
  }
}

(async () => {
  mkdirSync(SHOTS, { recursive: true });
  console.log('[0] 同步前的本地库');
  const before = dumpLocal('before');

  const app = spawn(EXE, [], {
    env: Object.assign({}, process.env, { TOOK_CDP_PORT: String(PORT) }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  app.stdout.on('data', d => { out += d.toString(); });
  app.stderr.on('data', d => { out += d.toString(); });

  let target = null;
  for (let i = 0; i < 100 && !target; i++) {
    try {
      const r = await fetch('http://127.0.0.1:' + PORT + '/json/list');
      const list = await r.json();
      target = list.filter(t => t.type === 'page' && t.webSocketDebuggerUrl)[0] || null;
    } catch (e) {}
    if (!target) await sleep(250);
  }
  if (!target) { console.log('无法连接调试端口。应用输出：' + out); app.kill(); process.exit(2); }
  console.log('[1] 已连上 WebView2：' + target.url + '  （应用输出：' + out.trim().replace(/\n/g, ' | ') + '）');

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
  const click = async (sel) => {
    const box = await evalJs('(function(){var e=document.querySelector(' + JSON.stringify(sel) + ');' +
      'if(!e) return null; var r=e.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2};})()');
    if (!box) throw new Error('找不到元素：' + sel);
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
      await send('Input.dispatchMouseEvent', { type: type, x: box.x, y: box.y, button: type === 'mouseMoved' ? 'none' : 'left', clickCount: type === 'mouseMoved' ? 0 : 1 });
    }
    await sleep(320);
  };
  const syncRows = () => evalJs('(function(){return [].slice.call(document.querySelectorAll("#setMain .row"))' +
    '.map(function(r){return r.innerText.split(String.fromCharCode(10)).join(" ").trim();});})()');
  await send('Runtime.enable');
  await sleep(2600);

  try {
    ok('窗口里的数据源是真本地库', (await evalJs('document.getElementById("sourceTag").textContent')).indexOf('Tauri') >= 0);
    // 启动时（app.js 里 1.2s 的首次尝试）已经同步过一次，所以这里 last_sync_at 必须 > 0
    const st0 = await evalJs('window.__TAURI__.core.invoke("sync_status", {})');
    console.log('  [sync_status · 刚启动] ' + JSON.stringify(st0));
    ok('首次进入即自动同步过一次（last_sync_at>0）', st0.last_sync_at > 0, String(st0.last_sync_at));
    ok('启动时没有待推送（种子 dirty=0）', st0.dirty === 0, 'dirty=' + st0.dirty);

    // ---- 1) 面板里打卡，制造 dirty=1 ----
    await click('.cell[data-date="2026-10-23"] .dnum');
    ok('点日期开面板', (await evalJs('!document.getElementById("mask").hidden')) === true);
    await click('.mtask[data-task="t_early"]');
    const pressed = await evalJs('document.querySelector(\'.mtask[data-task="t_early"]\').getAttribute("aria-pressed")');
    ok('面板里点「早起」→ 已完成（写本地，等推送）', pressed === 'true', 'aria-pressed=' + pressed);

    const st1 = await evalJs('window.__TAURI__.core.invoke("sync_status", {})');
    console.log('  [sync_status] ' + JSON.stringify(st1));
    ok('打卡后待推送 dirty>0', st1.dirty > 0, 'dirty=' + st1.dirty);

    // ---- 2) 设置页点「立即同步」 ----
    await evalJs('document.getElementById("mask").click()');
    await evalJs('document.getElementById("btnSettings").click()');
    await sleep(400);
    console.log('  [设置页 · 同步前] ' + JSON.stringify(await syncRows()));
    await click('#syncRun');
    await sleep(1600);
    const rowsAfter = await syncRows();
    console.log('  [设置页 · 同步后] ' + JSON.stringify(rowsAfter));
    const st2 = await evalJs('window.__TAURI__.core.invoke("sync_status", {})');
    console.log('  [sync_status] ' + JSON.stringify(st2));
    ok('同步成功后 dirty 归零', st2.dirty === 0, 'dirty=' + st2.dirty);
    ok('上次同步时间已刷新', st2.last_sync_at > 0, String(st2.last_sync_at));
    ok('最近一次错误为空', st2.last_error === '', JSON.stringify(st2.last_error));
    ok('设置页显示「已同步」时间与 0 条待推送',
      rowsAfter.join('|').indexOf('待推送') >= 0 && /\b0 条/.test(rowsAfter.join('|')),
      rowsAfter.filter(r => r.indexOf('待推送') >= 0)[0] || '');

    const shot = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(SHOTS + 'tauri-window-sync.png', Buffer.from(shot.data, 'base64'));

    // ---- 3) 命令返回值形状（契约要求的 {pushed,pulled,ok,error}） ----
    const res = await evalJs('window.__TAURI__.core.invoke("sync_now", {})');
    console.log('  [sync_now 返回] ' + JSON.stringify(res));
    ok('sync_now 返回 {pushed,pulled,ok,error}',
      res && typeof res.pushed === 'number' && typeof res.pulled === 'number' &&
      typeof res.ok === 'boolean' && typeof res.error === 'string',
      Object.keys(res).join(','));
    ok('第二次同步是空转（pushed=0）', res.pushed === 0 && res.ok === true, JSON.stringify(res));

    // ---- 4) 后端侧：pull 出来的就是刚推上去的那条 ----
    const pull = await (await fetch(SERVER + '/api/sync/pull?since=0')).json();
    console.log('  [GET /api/sync/pull?since=0] ' + JSON.stringify(pull).slice(0, 600));
    const pushed = (pull.completions || []).filter(c => c.task_id === 't_early');
    ok('后端存下了 t_early 的打卡（status=1）', pushed.length >= 1 && pushed[0].status === 1, JSON.stringify(pushed[0] || null));
    ok('后端 rev 由服务端分配（>0）', (pushed[0] || {}).rev > 0, String((pushed[0] || {}).rev));

    // ---- 5) 失败路径：地址打不通只报错、不回滚、不弹窗 ----
    // 走真实 UI：把地址改成打不通的端口 → 点「保存地址」→ 点「立即同步」
    await evalJs('(function(){var i=document.getElementById("syncUrl");' +
      'var set=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,"value").set;' +
      'set.call(i,"http://127.0.0.1:1"); i.dispatchEvent(new Event("input",{bubbles:true}));})()');
    await click('#syncSave');
    await sleep(400);
    const saved = await evalJs('window.__TAURI__.core.invoke("sync_status", {})');
    ok('保存地址生效（落库）', saved.url === 'http://127.0.0.1:1', saved.url);
    const stBefore = await evalJs('window.__TAURI__.core.invoke("sync_status", {})');
    const linesBefore = (out.match(/sync_now /g) || []).length;
    await click('#syncRun');
    await sleep(1800);
    const linesAfter = (out.match(/sync_now /g) || []).length;
    const lastLine = out.split(String.fromCharCode(10))
      .filter(function (l) { return l.indexOf('sync_now ') >= 0; }).pop() || '';
    ok('点「立即同步」真的发出了一次同步（打到刚保存的地址、且被判失败）',
       linesAfter > linesBefore && lastLine.indexOf('127.0.0.1:1') >= 0 && lastLine.indexOf('ok=false') >= 0,
       linesBefore + ' → ' + linesAfter + ' ｜ ' + lastLine.trim());
    const failRows = await syncRows();
    console.log('  [UI 点击立即同步后 · 面板] ' + JSON.stringify(failRows));
    const st3 = await evalJs('window.__TAURI__.core.invoke("sync_status", {})');
    console.log('  [sync_status] ' + JSON.stringify(st3));
    ok('连不上时错误写进设置页', st3.last_error.length > 0, st3.last_error.slice(0, 80));
    ok('设置页的「最近一次错误」行显示这条错误',
       (failRows.filter(function (r) { return r.indexOf('最近一次错误') >= 0; })[0] || '').indexOf('连不上 127.0.0.1:1') >= 0,
       failRows.filter(function (r) { return r.indexOf('最近一次错误') >= 0; })[0] || '');
    ok('失败不刷新上次同步时间', st3.last_sync_at === stBefore.last_sync_at, st3.last_sync_at + ' vs ' + stBefore.last_sync_at);
    ok('失败不产生 dirty（本地数据不回滚也不脏推）', st3.dirty === 0, 'dirty=' + st3.dirty);
    ok('没有弹出任何对话框（面板 .mask 仍隐藏）',
      (await evalJs('document.querySelectorAll(".mask:not([hidden])").length')) === 0);
    const shot2 = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(SHOTS + 'tauri-window-sync-error.png', Buffer.from(shot2.data, 'base64'));

    // 复原地址，别把测试地址留在用户设置里
    await evalJs('window.__TAURI__.core.invoke("set_sync_url", { url: "http://127.0.0.1:8420" })');

    ok('无 JS 运行时错误', errors.length === 0, errors.slice(0, 2).join(' | '));
  } finally {
    ws.close();
    app.kill();
    await sleep(400);
    console.log('\n[6] 同步后的本地库');
    dumpLocal('after');
    console.log('\n[7] 后端库（server/ 的 SQLite）里的 completion 行');
    try {
      const { DatabaseSync } = require('node:sqlite');
      const sdb = new DatabaseSync(SERVER_DB, { readOnly: true });
      const rows = sdb.prepare('SELECT task_id,period_start,status,rev,updated_at,deleted FROM completion').all();
      const maxRev = sdb.prepare('SELECT MAX(rev) AS n FROM completion').get();
      sdb.close();
      console.log('  ' + JSON.stringify(rows) + '  maxRev=' + (maxRev ? maxRev.n : null));
    } catch (e) {
      console.log('  读取后端库失败：' + e.message);
    }
    console.log('\n[8] 应用自己的同步日志（Rust 侧每次 sync_now 打一行）');
    console.log(app.stdout ? '' : '');
    console.log(
      out.split(String.fromCharCode(10)).filter(function (l) { return l.indexOf('sync_now') >= 0; })
        .map(function (l) { return '  ' + l; }).join(String.fromCharCode(10))
    );
    console.log('\n本地库 ' + LOCAL_DB);
  }

  console.log('\n结果：' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('验收脚本异常：', e); process.exit(2); });
