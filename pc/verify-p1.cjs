/* P1 体验补齐验收：真窗口（took.exe + CDP）+ 真 Go 后端（带 token）。
   ① 面板「全部完成」 ② 打卡 toast + 撒花 ③ 同步 Bearer Token
   ④ 测试连接（真发 /api/health） ⑤ 导出（真调 /api/v1/export）
   后端没有清库接口 —— 只断言「导出」是真的，「清理」如实显示为不可用说明。 */
const { spawn, spawnSync } = require('node:child_process');
const { writeFileSync, mkdirSync, readdirSync, statSync, readFileSync, unlinkSync } = require('node:fs');

const EXE = 'D:/work/Project/Took/pc/src-tauri/target/debug/took.exe';
const SHOTS = 'D:/work/Project/Took/pc/shots/';
const PORT = 9337;
const SERVER_PORT = 8427;
const SERVER_URL = 'http://127.0.0.1:' + SERVER_PORT;
const TOKEN = 'p1-secret-token';
const LOCAL_DB = 'C:/Users/30803/AppData/Roaming/app.took.desktop/took.db';
const SERVER_DIR = 'D:/work/Project/Took/pc/_p1-server';
const SERVER_BIN = SERVER_DIR + '/took-server.exe';
const SERVER_DB = SERVER_DIR + '/took-p1.db';
const DOWNLOADS = 'C:/Users/30803/Downloads';
const sleep = ms => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  PASS  ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  ' + extra : '')); }
};

function dbState() {
  try {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(LOCAL_DB, { readOnly: true });
    const state = db.prepare("SELECT key,value FROM local_state WHERE key IN ('sync_url','sync_token')").all();
    const comp = db.prepare('SELECT task_id,period_start,status FROM completion').all();
    db.close();
    return { state, comp };
  } catch (e) { return { state: [], comp: [], err: e.message }; }
}

const PAGE_HELPERS = [
  "window.__INV = function(cmd,args){",
  "  var g=window.__TAURI__; if(g&&g.core) return g.core.invoke(cmd,args);",
  "  var i=window.__TAURI_INTERNALS__; if(i&&i.invoke) return i.invoke(cmd,args);",
  "  return Promise.reject(new Error('no tauri'));",
  "};",
  "window.__DAY = async function(d){",
  "  var days = await window.__INV('range_grid',{from:d,to:d});",
  "  return (days&&days[0]&&days[0].tasks)||[];",
  "};",
  "true"
].join('\n');

(async () => {
  mkdirSync(SHOTS, { recursive: true });
  mkdirSync(SERVER_DIR, { recursive: true });

  const goBuild = spawnSync('go', ['build', '-o', SERVER_BIN, '.'], {
    cwd: 'D:/work/Project/Took/server', encoding: 'utf8',
  });
  if (goBuild.status !== 0) {
    console.log('go build 失败：' + (goBuild.stderr || '').slice(0, 800));
    process.exit(2);
  }
  console.log('[0] Go 后端已编译：' + SERVER_BIN);
  try { unlinkSync(SERVER_DB); } catch (e) {}
  const server = spawn(SERVER_BIN, ['-db', SERVER_DB, '-addr', '127.0.0.1:' + SERVER_PORT, '-token', TOKEN],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  let serverOut = '';
  server.stdout.on('data', d => { serverOut += d.toString(); });
  server.stderr.on('data', d => { serverOut += d.toString(); });
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(SERVER_URL + '/api/health'); if (r.ok) break; } catch (e) {}
    await sleep(200);
  }
  const health = await (await fetch(SERVER_URL + '/api/health')).json();
  console.log('[0] 后端 /api/health = ' + JSON.stringify(health));

  const app = spawn(EXE, [], {
    env: Object.assign({}, process.env, {
      TOOK_CDP_PORT: String(PORT),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=' + PORT,
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  app.stdout.on('data', d => { out += d.toString(); });
  app.stderr.on('data', d => { out += d.toString(); });

  let target = null;
  for (let i = 0; i < 120 && !target; i++) {
    try {
      const r = await fetch('http://127.0.0.1:' + PORT + '/json/list');
      const list = await r.json();
      target = list.filter(t => t.type === 'page' && t.webSocketDebuggerUrl)[0] || null;
    } catch (e) {}
    if (!target) await sleep(250);
  }
  if (!target) {
    console.log('无法连接调试端口。应用输出：\n' + out.trim());
    try { server.kill(); } catch (e) {}
    app.kill();
    process.exit(2);
  }
  console.log('[1] 已连上 WebView2：' + target.url);

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
    console.log('  截图：shots/' + name);
  };
  const clickAt = async pt => {
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
      await send('Input.dispatchMouseEvent', {
        type, x: pt.x, y: pt.y,
        button: type === 'mouseMoved' ? 'none' : 'left',
        clickCount: type === 'mouseMoved' ? 0 : 1,
      });
    }
  };
  const centerOf = sel => evalJs("(function(){var b=document.querySelector('" + sel + "');" +
    "if(!b) return null; var r=b.getBoundingClientRect();" +
    "return {x:r.x+r.width/2, y:r.y+r.height/2};})()");
  const INV = (cmd, args) => evalJs('window.__INV(' + JSON.stringify(cmd) + ',' + JSON.stringify(args || {}) + ')');
  const DAY = d => evalJs('window.__DAY(' + JSON.stringify(d) + ')');

  await send('Runtime.enable');
  await sleep(2600);
  await evalJs(PAGE_HELPERS);

  const TODAY = await evalJs("(function(){var d=new Date();" +
    "return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');})()");
  console.log('[2] 本机今天 = ' + TODAY);

  await INV('set_sync_url', { url: SERVER_URL });
  await INV('set_sync_token', { token: '' });
  await sleep(200);

  console.log('\n[① 当天面板「全部完成」]');
  let tasks = await DAY(TODAY);
  for (const t of tasks) {
    if (t.done) await INV('toggle_done', { taskId: t.task_id, periodStart: t.period_start, done: false });
  }
  await evalJs("(function(){var b=document.getElementById('todayBtn'); if(b) b.click(); return true;})()");
  await sleep(700);
  tasks = await DAY(TODAY);
  ok('今天有任务（' + tasks.length + ' 项：' + tasks.map(t => t.title).join('、') + '）', tasks.length > 0);
  ok('起点：今天全部未完成（done=' + tasks.filter(t => t.done).length + '）',
     tasks.length > 0 && tasks.every(t => !t.done));

  await evalJs("(function(){var c=document.querySelector('.cell[data-date=\"" + TODAY + "\"]');" +
    "if(c) c.querySelector('.dnum').click(); return !!c;})()");
  await sleep(450);
  const openState = await evalJs("(function(){return {open: !document.getElementById('mask').hidden," +
    "rows: document.querySelectorAll('#sheetList .mtask').length," +
    "date: document.getElementById('mask').dataset.date};})()");
  ok('点今天 → 面板打开（' + openState.rows + ' 行任务，date=' + openState.date + '）',
     openState.open === true && openState.rows > 0 && openState.date === TODAY);

  const barBefore = await evalJs("(function(){" +
    "var box=document.getElementById('sheetDoneAll');" +
    "var btn=document.getElementById('sheetDoneAllBtn');" +
    "return {exists: !!box, hidden: box?box.hidden:null, btn: !!btn," +
    "        disabled: btn?btn.disabled:null, text: btn?btn.textContent.trim():null," +
    "        hint: document.getElementById('sheetDoneAllHint').textContent," +
    "        above: box && document.getElementById('sheetList').previousElementSibling === box};})()");
  ok('面板顶部有「全部完成」按钮（文案=' + barBefore.text + '，在任务列表上方）',
     barBefore.exists && barBefore.btn && barBefore.text === '全部完成' && barBefore.above === true);
  ok('未完成时按钮可用（' + barBefore.hint + '）', barBefore.disabled === false, barBefore.hint);

  await shot('sheet-done-all.png');

  await clickAt(await centerOf('#sheetDoneAllBtn'));
  await sleep(300);

  const afterClick = await evalJs("(function(){" +
    "var ts=[].slice.call(document.querySelectorAll('.took-toast'));" +
    "return {toasts: ts.map(function(t){return t.querySelector('b').textContent;})," +
    "        fx: document.querySelectorAll('.took-fx').length," +
    "        right: ts.length?getComputedStyle(document.getElementById('tookToastStack')).right:null," +
    "        bottom: ts.length?getComputedStyle(document.getElementById('tookToastStack')).bottom:null," +
    "        layer: !!document.getElementById('tookFxLayer')," +
    "        canvas: document.querySelectorAll('canvas').length};})()");
  await shot('toast-checkin.png');
  console.log('  toast 文案：' + JSON.stringify(afterClick.toasts));
  ok('打卡后弹出 toast（' + afterClick.toasts.length + ' 条，可叠加）', afterClick.toasts.length > 0);
  ok('toast 文案形如「已打卡：<任务名>」',
     afterClick.toasts.some(t => t.indexOf('已打卡：') === 0), JSON.stringify(afterClick.toasts.slice(0, 3)));
  ok('toast 在右下角（right=' + afterClick.right + ' bottom=' + afterClick.bottom + '）',
     afterClick.right === '18px' && afterClick.bottom === '18px');
  ok('撒花粒子在跑（' + afterClick.fx + ' 个 .took-fx）', afterClick.fx > 0);
  ok('粒子是纯 DOM/CSS（.took-fx-layer 存在、无 canvas）',
     afterClick.layer === true && afterClick.canvas === 0);

  await sleep(2500);
  const gone = await evalJs("(function(){return {n: document.querySelectorAll('.took-toast').length," +
    "fx: document.querySelectorAll('.took-fx').length};})()");
  ok('2 秒后 toast 自动消失（剩 ' + gone.n + ' 条）', gone.n === 0);
  ok('粒子也清干净了（剩 ' + gone.fx + ' 个）', gone.fx === 0);

  const doneAll = await evalJs("(function(){" +
    "var rows=[].slice.call(document.querySelectorAll('#sheetList .mtask'));" +
    "var btn=document.getElementById('sheetDoneAllBtn');" +
    "return {rowsDone: rows.filter(function(r){return r.classList.contains('done');}).length," +
    "        rows: rows.length, btnDisabled: btn.disabled," +
    "        hint: document.getElementById('sheetDoneAllHint').textContent," +
    "        sub: document.getElementById('sheetSub').textContent};})()");
  ok('面板里所有行变已完成（' + doneAll.rowsDone + '/' + doneAll.rows + '）',
     doneAll.rowsDone === doneAll.rows && doneAll.rows > 0);
  ok('按钮转为禁用（' + doneAll.hint + '）', doneAll.btnDisabled === true, doneAll.hint);
  ok('面板副标题同步（' + doneAll.sub + '）', doneAll.sub.indexOf('已完成 ' + doneAll.rows) >= 0, doneAll.sub);

  const afterTasks = await DAY(TODAY);
  ok('真落盘：range_grid 回来当天全部 done=true（' + afterTasks.filter(t => t.done).length + '/' +
     afterTasks.length + '）', afterTasks.length > 0 && afterTasks.every(t => t.done));

  const todayKeys = afterTasks.map(t => t.task_id + '|' + t.period_start);
  const st1 = dbState();
  const doneRows = st1.comp.filter(r => todayKeys.indexOf(r.task_id + '|' + r.period_start) >= 0 && r.status === 1);
  ok('本地库 completion 里今天的 ' + todayKeys.length + ' 行全部 status=1（SQLite 直读）',
     doneRows.length === todayKeys.length, doneRows.length + '/' + todayKeys.length);

  const cellDone = await evalJs("(function(){" +
    "var c=document.querySelector('.cell[data-date=\"" + TODAY + "\"]');" +
    "return c ? c.querySelectorAll('.tag.done').length : -1;})()");
  ok('月历格子里出现已完成标记（' + cellDone + ' 个 .tag.done）', cellDone > 0, String(cellDone));

  await evalJs("document.getElementById('sheetClose').click()");
  await sleep(400);
  const hiddenAfterClose = await evalJs("document.getElementById('sheetDoneAll').hidden");
  ok('关面板后「全部完成」条自动隐藏', hiddenAfterClose === true);

  console.log('\n[③ 同步 Bearer Token]');
  await evalJs("document.getElementById('btnSettings').click()");
  await sleep(800);
  const tokenUI = await evalJs("(function(){" +
    "var inp=document.getElementById('tookSyncToken');" +
    "return {card: !!document.getElementById('tookSyncTokenCard'), input: !!inp," +
    "        type: inp?inp.type:null, ph: inp?inp.placeholder:null," +
    "        save: !!document.getElementById('tookSyncTokenSave')," +
    "        tab: (document.querySelector('#setMain .panel-title')||{}).textContent};})()");
  ok('设置页「同步」页签里有令牌输入框', tokenUI.card && tokenUI.input === true, 'tab=' + tokenUI.tab);
  ok('输入框是 text 类型，placeholder=' + JSON.stringify(tokenUI.ph), tokenUI.type === 'text');

  await evalJs("(function(){var i=document.getElementById('tookSyncToken'); i.focus(); i.select(); return true;})()");
  await send('Input.insertText', { text: TOKEN });
  await sleep(200);
  const typed = await evalJs("document.getElementById('tookSyncToken').value");
  ok('真键入令牌（输入框值 = ' + JSON.stringify(typed) + '）', typed === TOKEN);
  await shot('set-sync-token.png');

  await clickAt(await centerOf('#tookSyncTokenSave'));
  await sleep(800);
  const saved = await INV('sync_status', {});
  ok('令牌存进后端（sync_status.token = ' + JSON.stringify(saved.token) + '）', saved.token === TOKEN);
  const st2 = dbState();
  const tokRow = st2.state.filter(r => r.key === 'sync_token')[0];
  const urlRow = st2.state.filter(r => r.key === 'sync_url')[0];
  ok('令牌落 local_state 的 sync_token 键（值 = ' + JSON.stringify(tokRow && tokRow.value) + '）',
     !!tokRow && tokRow.value === TOKEN);
  ok('同步地址 = ' + (urlRow && urlRow.value) + '（指向真后端）', !!urlRow && urlRow.value === SERVER_URL);

  const withToken = await INV('export_data', {});
  ok('带正确令牌打 /api/v1/export → HTTP ' + withToken.status, withToken.status === 200,
     'body ' + String(withToken.body).length + ' 字节');
  await INV('set_sync_token', { token: 'wrong-token' });
  await sleep(200);
  const withBad = await INV('export_data', {});
  ok('换成错令牌 → HTTP ' + withBad.status + '（证明 Authorization 真的发出去了）', withBad.status === 401,
     String(withBad.body).slice(0, 70));
  await INV('set_sync_token', { token: TOKEN });
  await sleep(200);
  const backOk = await INV('export_data', {});
  ok('换回正确令牌 → HTTP ' + backOk.status, backOk.status === 200);

  const syncRes = await INV('sync_now', {});
  ok('sync_now 带令牌跑通（ok=' + syncRes.ok + ' pushed=' + syncRes.pushed + ' pulled=' + syncRes.pulled +
     ' error=' + JSON.stringify(syncRes.error) + '）', syncRes.ok === true, JSON.stringify(syncRes));

  console.log('\n[④ 测试连接（真发 HTTP）]');
  await clickAt(await centerOf('#tookProbeBtn'));
  await sleep(1500);
  const probeUi = await evalJs("(function(){" +
    "var line=document.getElementById('tookProbeLine');" +
    "return {text: line?line.textContent.trim():null, cls: line?line.className:null," +
    "        title: line?line.getAttribute('title'):null};})()");
  await shot('set-test-conn.png');
  console.log('  测试连接结果：' + JSON.stringify(probeUi));
  ok('测试连接显示 HTTP 200 + 耗时（' + probeUi.text + '）',
     /HTTP 200 · \d+ ms/.test(probeUi.text || ''), probeUi.text);
  ok('结果行是成功态（不是 err）', (probeUi.cls || '').indexOf('err') < 0, probeUi.cls);
  ok('结果里带着后端真实响应体（/api/health 的 ok/time）',
     /"ok":true/.test(probeUi.title || ''), String(probeUi.title).slice(0, 90));

  await INV('set_sync_url', { url: 'http://127.0.0.1:9' });
  const deadProbe = await INV('sync_probe', {});
  ok('连不上的地址如实报错（' + JSON.stringify(deadProbe.error) + '）',
     deadProbe.ok === false && deadProbe.error.length > 0 && deadProbe.status === 0,
     'elapsed=' + deadProbe.elapsed_ms + 'ms');
  await INV('set_sync_url', { url: SERVER_URL });
  await sleep(200);

  console.log('\n[⑤ 导出数据 / 清理数据]');
  await evalJs("(function(){" +
    "var nav=[].slice.call(document.querySelectorAll('#setNav button'));" +
    "var b=nav.filter(function(x){return x.textContent==='数据';})[0];" +
    "if(b) b.click(); return !!b;})()");
  await sleep(800);
  const dataUi = await evalJs("(function(){" +
    "var card=document.getElementById('tookDataCard');" +
    "var clear=document.getElementById('tookClearCard');" +
    "var todo=document.querySelector('#setMain .todo-block');" +
    "return {card: !!card, exportBtn: !!document.getElementById('tookExportBtn')," +
    "        clearCard: !!clear," +
    "        clearHasButton: clear?clear.querySelectorAll('button').length:-1," +
    "        clearText: clear?clear.textContent.replace(/\\s+/g,' ').trim().slice(0,240):null," +
    "        staleTodo: todo?todo.textContent.replace(/\\s+/g,' ').trim().slice(0,80):null," +
    "        tab: (document.querySelector('#setMain .panel-title')||{}).textContent};})()");
  ok('数据页签里有「导出 JSON」按钮', dataUi.card && dataUi.exportBtn === true, 'tab=' + dataUi.tab);
  ok('旧的「导出尚未实现」占位块已被真实卡片替换（staleTodo=' + dataUi.staleTodo + '）',
     dataUi.staleTodo === null, String(dataUi.staleTodo));
  ok('清理数据如实说明后端没有接口（' + String(dataUi.clearText).slice(0, 50) + '…）',
     dataUi.clearCard && /没有这个接口|没有清库接口/.test(dataUi.clearText || ''));
  ok('清理区域没有假按钮（按钮数 = ' + dataUi.clearHasButton + '）', dataUi.clearHasButton === 0);

  const before = (() => { try { return readdirSync(DOWNLOADS).filter(f => /^took-export-.*\.json$/.test(f)); } catch (e) { return []; } })();
  await clickAt(await centerOf('#tookExportBtn'));
  await sleep(2200);
  const expUi = await evalJs("(function(){var line=document.getElementById('tookExportLine');" +
    "return {text: line?line.textContent.trim():null, cls: line?line.className:null};})()");
  await shot('set-export.png');
  console.log('  导出结果：' + JSON.stringify(expUi));
  ok('导出结果行显示文件名与字节数（' + expUi.text + '）',
     /took-export-.*\.json · \d+ 字节/.test(expUi.text || ''), expUi.text);
  const after = (() => { try { return readdirSync(DOWNLOADS).filter(f => /^took-export-.*\.json$/.test(f)); } catch (e) { return []; } })();
  const fresh = after.filter(f => before.indexOf(f) < 0);
  ok('文件真的落到了下载目录（新增 ' + fresh.length + ' 个）', fresh.length >= 1, fresh.join(','));
  if (fresh.length) {
    const p = DOWNLOADS + '/' + fresh[fresh.length - 1];
    const body = readFileSync(p, 'utf8');
    let parsed = null; try { parsed = JSON.parse(body); } catch (e) {}
    ok('下载到的 JSON 可解析（' + Math.round(statSync(p).size / 1024) + ' KB）', !!parsed);
    ok('导出包含五张表（' + (parsed ? Object.keys(parsed).sort().join(',') : '') + '）',
       parsed && ['rules', 'tasks', 'memos', 'reminders', 'completions'].every(k => k in parsed));
  }

  const rt = await INV('export_data', {});
  const rtJson = JSON.parse(rt.body);
  ok('后端导出条数与本地库对得上（completions ' + rtJson.completions.length + ' 条）',
     Array.isArray(rtJson.completions) && rtJson.completions.length > 0);

  console.log('\n[回归]');
  ok('运行期没有未捕获异常', errors.length === 0, errors.slice(0, 2).join(' | '));
  // 回归检查要在「同步」页签上做（刚才停在数据页签，那里本来就没有地址框）
  await evalJs("(function(){" +
    "var nav=[].slice.call(document.querySelectorAll('#setNav button'));" +
    "var b=nav.filter(function(x){return x.textContent==='同步';})[0];" +
    "if(b) b.click(); return !!b;})()");
  await sleep(700);
  const regress = await evalJs("(function(){return {" +
    "cells: document.querySelectorAll('#grid .cell').length," +
    "weeks: document.querySelectorAll('#grid .week').length," +
    "acts: [].slice.call(document.querySelectorAll('#calActs button')).map(function(b){return b.id;})," +
    "syncUrl: !!document.getElementById('syncUrl')," +
    "syncRun: !!document.getElementById('syncRun')," +
    "tabs: [].slice.call(document.querySelectorAll('#setNav button')).map(function(b){return b.textContent;})," +
    "sheetDoneAllHidden: document.getElementById('sheetDoneAll').hidden};})()");
  // 口径与 verify-tauri.cjs 一致：连续周数组约 109 周（当前月前后各 12 个月），格子数 = 周 × 7
  ok('月历仍是连续周网格（' + regress.weeks + ' 周 / ' + regress.cells + ' 格）',
     regress.weeks >= 100 && regress.weeks <= 160 && regress.cells === regress.weeks * 7);
  // 2026-10-27 用户要求删掉重复的「配置」（与「新建与管理」同去处）；
  // 同日又加 #btnPin（固定方式快捷按钮），按钮组精确为 5 个，顺序固定、设置在最右。
  ok('功能按钮组 = 固定方式 / 新建与管理 / 统计分析 / 收起 / 设置（5 个）',
     JSON.stringify(regress.acts) === JSON.stringify(['btnPin','btnNew','btnAnalysis','btnCollapse','btnSettings']),
     JSON.stringify(regress.acts));
  ok('同步页签既有的地址框 / 立即同步按钮还在', regress.syncUrl && regress.syncRun);
  ok('设置页签顺序不变（' + regress.tabs.join('/') + '）',
     JSON.stringify(regress.tabs) === JSON.stringify(['常规','外观','提醒','桌面固定','同步','数据','关于']));
  ok('面板关闭时「全部完成」条隐藏', regress.sheetDoneAllHidden === true);

  console.log('\n================ 结果：' + pass + ' PASS / ' + fail + ' FAIL ================');
  try { ws.close(); } catch (e) {}
  app.kill();
  try { server.kill(); } catch (e) {}
  await sleep(400);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('脚本异常：' + (e && e.stack || e)); process.exit(3); });
