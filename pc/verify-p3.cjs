/* verify-p3.cjs —— 2026-10-27 四项界面改动的真窗口验收（took.exe + CDP + GetWindowRect）
   ① 「＋ 添加任务」改行内编辑（无模态框，回车保存 / Esc 取消）
   ② 标题旁「＋ 新建规则」已删除，右下角 FAB 仍在
   ③ 吸附后自动收起真的把窗口缩成 26×48；收起有分帧过渡（采样到 >=3 个不同中间宽度）
   ④ #calActs 删掉 #btnConfig（当时剩 4 个；同日加 #btnPin 后为 5 个）
   用法：node verify-p3.cjs */
const { spawn, execFileSync } = require('node:child_process');
const { writeFileSync, mkdirSync, rmSync } = require('node:fs');
const { join } = require('node:path');

const EXE = 'D:/work/Project/Took/pc/src-tauri/target/debug/took.exe';
const SHOTS = 'D:/work/Project/Took/pc/shots/';
const PORT = 9341;
const sleep = ms => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  PASS  ' + name + (extra !== undefined ? '  ' + extra : '')); }
  else { fail++; console.log('  FAIL  ' + name + (extra !== undefined ? '  ' + extra : '')); }
};

/* 真窗口矩形：GetWindowRect（不是 DOM，不是日志） */
const PS_RECT = [
  'Add-Type @"',
  'using System;',
  'using System.Runtime.InteropServices;',
  'public struct RECT { public int Left, Top, Right, Bottom; }',
  'public class W9 {',
  '  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);',
  '}',
  '"@',
  '$p = Get-Process -Name took -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1',
  'if (-not $p) { Write-Output "NONE"; exit }',
  '$r = New-Object RECT',
  '[void][W9]::GetWindowRect($p.MainWindowHandle, [ref]$r)',
  'Write-Output ("{0},{1},{2},{3}" -f $r.Left, $r.Top, ($r.Right-$r.Left), ($r.Bottom-$r.Top))',
].join('\n');

/* 从**外部进程**用 SetWindowPos 挪窗 —— 等同用户拖动：
   WM_MOVE 由窗口过程收到，tao 映射成 WindowEvent::Moved，
   走的就是 wire_snap_listener 那条真实路径（不是绕过它）。 */
const PS_MOVE = [
  'Add-Type @"',
  'using System;',
  'using System.Runtime.InteropServices;',
  'public class W10 {',
  '  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr z, int x, int y, int w, int h2, uint f);',
  '  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);',
  '}',
  'public struct RECT { public int Left, Top, Right, Bottom; }',
  '"@',
  '$p = Get-Process -Name took -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1',
  'if (-not $p) { Write-Output "NONE"; exit }',
  '$r = New-Object RECT',
  '[void][W10]::GetWindowRect($p.MainWindowHandle, [ref]$r)',
  '$w = $r.Right - $r.Left; $h = $r.Bottom - $r.Top',
  '[void][W10]::SetWindowPos($p.MainWindowHandle, [IntPtr]::Zero, XPLACE, YPLACE, $w, $h, 0x0014)',
  'Start-Sleep -Milliseconds 60',
  'Write-Output ("moved to XPLACE,YPLACE from " + $r.Left + "," + $r.Top)',
].join('\n');

const moveWindow = (x, y) => {
  const script = PS_MOVE.replace(/XPLACE/g, String(x)).replace(/YPLACE/g, String(y));
  try {
    return execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script],
      { encoding: 'utf8', timeout: 20000 }).trim();
  } catch (e) { return 'ERR ' + String(e.message || e).slice(0, 140); }
};

/* 单个 PowerShell 进程里高频采样 GetWindowRect（比每次 spawn 一个进程快得多），
   作为「外部观察者」旁证窗口是一帧一帧缩的。 */
const PS_SAMPLE = [
  'Add-Type @"',
  'using System;',
  'using System.Runtime.InteropServices;',
  'public struct RECT { public int Left, Top, Right, Bottom; }',
  'public class W11 { [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r); }',
  '"@',
  '$p = Get-Process -Name took -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1',
  'if (-not $p) { Write-Output "NONE"; exit }',
  '$h = $p.MainWindowHandle',
  // 握手：先把类型加载好、句柄拿到，再写 READY 文件；Node 侧看到 READY 才去点「收起」。
  // 否则 PowerShell 自身的启动开销（约 0.6~1s）会让采样窗完全错过 200ms 的过渡。
  'Set-Content -Path READYFILE -Value "ready" -Encoding ASCII',
  'while (-not (Test-Path GO_FILE)) { Start-Sleep -Milliseconds 5 }',
  '$sw = [System.Diagnostics.Stopwatch]::StartNew()',
  '$out = @()',
  'while ($sw.ElapsedMilliseconds -lt SAMPLES) {',
  '  $r = New-Object RECT',
  '  [void][W11]::GetWindowRect($h, [ref]$r)',
  '  $out += ($r.Right - $r.Left)',
  '  Start-Sleep -Milliseconds 3',
  '}',
  'Write-Output ($out -join ",")',
].join('\n');

/* 必须用 spawn 异步起：execFileSync 会阻塞 Node 的事件循环，
   那样「点击」要等采样结束才发得出去，采到的全是静止值（踩过）。 */
const sampleWidths = (ms, readyFile, goFile) => new Promise(resolve => {
  const script = PS_SAMPLE.replace('SAMPLES', String(ms))
    .replace('READYFILE', JSON.stringify(readyFile))
    .replace('GO_FILE', JSON.stringify(goFile));
  let buf = '';
  let child;
  try {
    child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', script]);
  } catch (e) { resolve([]); return; }
  child.stdout.on('data', d => { buf += d.toString(); });
  child.stderr.on('data', () => {});
  child.on('error', () => resolve([]));
  child.on('close', () => {
    const t = buf.trim();
    if (!t || t === 'NONE') return resolve([]);
    resolve(t.split(',').map(Number).filter(n => !isNaN(n)));
  });
});

const winRect = () => {
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', PS_RECT],
      { encoding: 'utf8', timeout: 15000 }).trim();
    if (out === 'NONE' || !out) return { ok: false };
    const [x, y, w, h] = out.split(',').map(Number);
    return { ok: true, x, y, w, h };
  } catch (e) { return { ok: false, err: String(e.message || e).slice(0, 120) }; }
};

(async () => {
  mkdirSync(SHOTS, { recursive: true });
  const cdpProfile = join(process.env.APPDATA || '', 'app.took.desktop', 'webview-cdp');
  try { rmSync(cdpProfile, { recursive: true, force: true, maxRetries: 5 }); } catch (e) {}

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
  if (!target) { console.log('无法连接 WebView2；stdout：\n' + out.trim()); app.kill(); process.exit(2); }
  console.log('已连上 WebView2：' + target.url);

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let seq = 0; const pend = new Map(); const errors = [];
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      errors.push((d.exception && d.exception.description) || d.text);
    }
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') errors.push(m.params.entry.text);
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
  const boxOf = async sel => evalJs('(function(){var e=document.querySelector(' + JSON.stringify(sel) + ');' +
    'if(!e) return null; var r=e.getBoundingClientRect();' +
    'return {x:r.x+r.width/2,y:r.y+r.height/2,w:r.width,h:r.height};})()');
  const clickSel = async sel => {
    const b = await boxOf(sel);
    if (!b) throw new Error('找不到可点元素：' + sel);
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
      await send('Input.dispatchMouseEvent', {
        type, x: b.x, y: b.y, button: type === 'mouseMoved' ? 'none' : 'left',
        clickCount: type === 'mouseMoved' ? 0 : 1,
      });
    }
    await sleep(150);
  };
  const typeText = async (sel, text) => {
    await clickSel(sel);
    await evalJs('(function(){var e=document.querySelector(' + JSON.stringify(sel) + '); e.focus(); if (e.select) e.select();})()');
    await send('Input.insertText', { text });
    await sleep(180);
    return evalJs('(function(){var e=document.querySelector(' + JSON.stringify(sel) + '); return e ? e.value : null;})()');
  };
  const pressKey = async (key, code, vk) => {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
    await sleep(250);
  };
  const waitFor = async (expr, ms) => {
    const t0 = Date.now();
    while (Date.now() - t0 < (ms || 4000)) {
      try { if (await evalJs(expr)) return true; } catch (e) {}
      await sleep(100);
    }
    return false;
  };
  const shot = async name => {
    const s = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(SHOTS + name, Buffer.from(s.data, 'base64'));
    console.log('        截图 → pc/shots/' + name);
  };
  const invoke = (cmd, args) => evalJs('window.__TAURI_INTERNALS__.invoke(' + JSON.stringify(cmd) + ',' +
    JSON.stringify(args || {}) + ')');

  await send('Runtime.enable');
  await send('Log.enable');
  await sleep(3200);

  try {
    /* ================= ④ 按钮组：删掉「配置」，只剩 4 个 ================= */
    console.log('\n[4] 日历头部按钮组：删掉「配置」，保留 固定方式 / 新建 / 统计 / 收起 / 设置');
    const acts = await evalJs('(function(){' +
      'var bs=[].slice.call(document.querySelectorAll("#calActs button"));' +
      'return {ids:bs.map(function(b){return b.id;}), n:bs.length,' +
      ' hasConfig:!!document.getElementById("btnConfig"),' +
      ' hasNew:!!document.getElementById("btnNew"),' +
      ' newVisible:(function(){var e=document.getElementById("btnNew");if(!e)return false;' +
      '   var r=e.getBoundingClientRect(); return r.width>0&&r.height>0;})()};})()');
    // 2026-10-27 又加 #btnPin（固定方式快捷按钮），4 → 5，顺序固定、设置仍在最右。
    ok('#calActs 恰好 5 个按钮', acts.n === 5, JSON.stringify(acts.ids));
    ok('#btnConfig 已不存在', acts.hasConfig === false, 'hasConfig=' + acts.hasConfig);
    ok('#btnNew 仍在且可见', acts.hasNew === true && acts.newVisible === true, JSON.stringify(acts));
    ok('按钮组顺序 = 固定方式 / 新建与管理 / 统计分析 / 收起 / 设置',
       JSON.stringify(acts.ids) === JSON.stringify(['btnPin', 'btnNew', 'btnAnalysis', 'btnCollapse', 'btnSettings']),
       JSON.stringify(acts.ids));
    await shot('cal-acts-4.png');

    /* ================= ④' 「新建与管理」仍能打开管理页 ================= */
    console.log("\n[4'] #btnNew 是唯一入口，点它进管理页");
    await clickSel('#btnNew');
    const opened = await waitFor('!document.getElementById("configScreen").hidden', 5000);
    ok('点「新建与管理」→ 管理页打开', opened === true);
    await waitFor('!!document.querySelector("#mgrRoot .mgr-row")', 6000);
    await sleep(300);

    /* ================= ② 标题旁没有「＋ 新建规则」，FAB 仍在 ================= */
    console.log('\n[2] 标题旁「＋ 新建规则」已删除，右下角 FAB 保留');
    const ruleHead = await evalJs('(function(){' +
      'var e=document.getElementById("mgrNewRule");' +
      'var vis=function(x){if(!x)return false;var r=x.getBoundingClientRect();' +
      '  return r.width>0&&r.height>0&&getComputedStyle(x).visibility!=="hidden";};' +
      'var fab=document.getElementById("mgrFab");' +
      'var head=document.querySelector("#mgrRoot .mgr-head");' +
      'var btns=head?[].slice.call(head.querySelectorAll("button")).map(function(b){return b.textContent.trim();}):[];' +
      'return {exists:!!e, visible:vis(e), headButtons:btns,' +
      ' fabExists:!!fab, fabVisible:vis(fab),' +
      ' hasNewRuleInDom:!!document.getElementById("newRule")};})()');
    ok('#mgrNewRule 不存在', ruleHead.exists === false, 'exists=' + ruleHead.exists);
    ok('规则标题区没有任何按钮（只剩标题与说明）',
       ruleHead.headButtons.length === 0, JSON.stringify(ruleHead.headButtons));
    ok('右下角 FAB 仍在且可见', ruleHead.fabExists === true && ruleHead.fabVisible === true,
       JSON.stringify(ruleHead));
    await shot('mgr-no-newrule.png');

    /* ================= ① 行内编辑：新建任务 ================= */
    console.log('\n[1] 「＋ 添加任务」→ 就地展开输入框（无模态框）');
    const expandedNow = await evalJs('document.querySelectorAll("#mgrRoot .rule-tasks").length');
    if (!expandedNow) { await clickSel('#mgrRoot .mgr-row .caret'); await sleep(400); }
    const beforeCount = await evalJs('document.querySelectorAll("#mgrRoot .task-item").length');
    await clickSel('#mgrRoot .rule-block .task-add');
    await sleep(350);
    const inlineState = await evalJs('(function(){' +
      'var row=document.querySelector("#mgrRoot .task-inline");' +
      'var mask=document.getElementById("mgrMask");' +
      'var dlg=document.querySelector(".mgr-dialog, .fsheet[role=dialog]");' +
      'var inp=document.querySelector("#mgrRoot .task-inline .task-inline-name");' +
      'var addBtn=document.querySelector("#mgrRoot .rule-block .task-add");' +
      'return {inline:!!row, maskHidden:mask.hidden, dialogOpen:!mask.hidden,' +
      ' inputPlaceholder:inp?inp.placeholder:null,' +
      ' inputFocused:!!inp&&document.activeElement===inp,' +
      ' addBtnGone:!addBtn,' +
      ' switchInRow:!!document.querySelector("#mgrRoot .task-inline [data-mgr=tinlineswitch]"),' +
      ' saveBtn:!!document.querySelector("#mgrRoot .task-inline [data-mgr=tinlinesave]"),' +
      ' cancelBtn:!!document.querySelector("#mgrRoot .task-inline [data-mgr=tinlinecancel]")};})()');
    ok('点「＋ 添加任务」→ 就地出现输入框', inlineState.inline === true, JSON.stringify(inlineState));
    ok('★ 没有模态框（#mgrMask 仍 hidden）', inlineState.maskHidden === true && inlineState.dialogOpen === false,
       'maskHidden=' + inlineState.maskHidden);
    ok('输入框 placeholder = 「例如：健身」', inlineState.inputPlaceholder === '例如：健身',
       String(inlineState.inputPlaceholder));
    ok('输入框自动获得焦点', inlineState.inputFocused === true);
    ok('「＋ 添加任务」按钮被输入框顶替', inlineState.addBtnGone === true);
    ok('行内保留「启用」开关 + 添加/取消按钮',
       inlineState.switchInRow && inlineState.saveBtn && inlineState.cancelBtn, JSON.stringify(inlineState));
    await shot('task-inline-edit.png');

    console.log('\n[1b] 输入名字 + 回车 → 新任务行原地出现，输入框收起');
    const NAME = '内联任务A' + Date.now().toString().slice(-5);
    const typed = await typeText('#mgrRoot .task-inline .task-inline-name', NAME);
    ok('输入框收到真实键盘输入', typed === NAME, String(typed));
    await pressKey('Enter', 'Enter', 13);
    const created = await waitFor('(function(){var t=[].slice.call(document.querySelectorAll("#mgrRoot .task-name"))' +
      '.map(function(e){return e.textContent;}); return t.indexOf(' + JSON.stringify(NAME) + ')>=0;})()', 5000);
    const afterCreate = await evalJs('(function(){' +
      'var names=[].slice.call(document.querySelectorAll("#mgrRoot .task-name")).map(function(e){return e.textContent;});' +
      'return {names:names, n:names.length, inline:!!document.querySelector("#mgrRoot .task-inline"),' +
      ' maskHidden:document.getElementById("mgrMask").hidden,' +
      ' addBtnBack:!!document.querySelector("#mgrRoot .rule-block .task-add")};})()');
    ok('★ 回车 → 新任务行出现', created === true, JSON.stringify(afterCreate.names));
    ok('输入框收起，恢复成「＋ 添加任务」',
       afterCreate.inline === false && afterCreate.addBtnBack === true, JSON.stringify(afterCreate));
    ok('保存过程没有弹模态框', afterCreate.maskHidden === true);

    console.log('\n[1c] Esc → 输入框收起且任务未创建');
    const addBack = await waitFor('!!document.querySelector("#mgrRoot .rule-block .task-add")', 4000);
    ok('上一步保存后「＋ 添加任务」已回来', addBack === true);
    await clickSel('#mgrRoot .rule-block .task-add');
    await sleep(300);
    const NAME2 = '不该被创建' + Date.now().toString().slice(-4);
    await typeText('#mgrRoot .task-inline .task-inline-name', NAME2);
    await pressKey('Escape', 'Escape', 27);
    await sleep(300);
    const afterEsc = await evalJs('(function(){' +
      'var names=[].slice.call(document.querySelectorAll("#mgrRoot .task-name")).map(function(e){return e.textContent;});' +
      'return {inline:!!document.querySelector("#mgrRoot .task-inline"),' +
      ' created:names.indexOf(' + JSON.stringify(NAME2) + ')>=0, n:names.length};})()');
    ok('Esc → 输入框收起', afterEsc.inline === false, JSON.stringify(afterEsc));
    ok('★ Esc → 任务没有被创建', afterEsc.created === false, JSON.stringify(afterEsc));

    console.log('\n[1d] 编辑任务 = 该行就地变成输入框（不是弹窗）');
    // 只操作本轮刚建的那条，绝不碰库里的既有任务
    const pencilSel = await evalJs('(function(){' +
      'var rows=[].slice.call(document.querySelectorAll("#mgrRoot .task-item"));' +
      'var row=rows.filter(function(r){var n=r.querySelector(".task-name");' +
      '  return n&&n.textContent===' + JSON.stringify(NAME) + ';})[0];' +
      'if(!row) return null;' +
      'var b=row.querySelector("[data-mgr=tedit]"); if(!b) return null;' +
      'if(!b.id) b.id="__probePencil"; return "#__probePencil";})()');
    ok('本轮新建的任务行上有行内铅笔', pencilSel === '#__probePencil', String(pencilSel));
    await clickSel(pencilSel);
    await sleep(350);
    const editState = await evalJs('(function(){' +
      'var row=document.querySelector("#mgrRoot .task-inline[data-inline-task]");' +
      'var inp=row?row.querySelector(".task-inline-name"):null;' +
      'return {inline:!!row, value:inp?inp.value:null,' +
      ' maskHidden:document.getElementById("mgrMask").hidden,' +
      ' taskRowReplaced:document.querySelectorAll("#mgrRoot .task-item").length};})()');
    ok('点行内铅笔 → 该行变成输入框', editState.inline === true, JSON.stringify(editState));
    ok('输入框预填了原来的任务名', !!editState.value && editState.value.length > 0, String(editState.value));
    ok('编辑也没有弹模态框', editState.maskHidden === true);
    const RENAMED = String(editState.value) + '改';
    await typeText('#mgrRoot .task-inline .task-inline-name', RENAMED);
    await pressKey('Enter', 'Enter', 13);
    const renamed = await waitFor('(function(){var t=[].slice.call(document.querySelectorAll("#mgrRoot .task-name"))' +
      '.map(function(e){return e.textContent;}); return t.indexOf(' + JSON.stringify(RENAMED) + ')>=0;})()', 5000);
    ok('★ 回车 → 行内改名生效', renamed === true, RENAMED);

    /* 清场：只删本轮造出来的那一条（改名后叫 RENAMED），库里既有任务一条都不许碰 */
    console.log('\n[1e] 清场：删除本轮新建的那条任务');
    const delOne = async name => {
      const hit = await evalJs('(function(){var t=[].slice.call(document.querySelectorAll("#mgrRoot .task-item"));' +
        'var row=t.filter(function(r){var n=r.querySelector(".task-name");' +
        'return n&&n.textContent===' + JSON.stringify(name) + ';})[0];' +
        'if(!row) return false; var b=row.querySelector("[data-mgr=tdel]"); if(b) b.click(); return true;})()');
      await sleep(400);
      await evalJs('(function(){var b=document.getElementById("mgrConfirmOk"); if(b) b.click(); return true;})()');
      await sleep(800);
      return hit;
    };
    const hitA = await delOne(RENAMED);
    const cleaned = await evalJs('(function(){var t=[].slice.call(document.querySelectorAll("#mgrRoot .task-name"))' +
      '.map(function(e){return e.textContent;});' +
      'return {gone:' + JSON.stringify(RENAMED) + ' && t.indexOf(' + JSON.stringify(RENAMED) + ')<0, names:t};})()');
    ok('本轮临时任务已删除', hitA === true && cleaned.gone === true, JSON.stringify(cleaned.names));
    // 库里既有任务必须原封不动：以「同一条规则下的任务数回到操作前」为准。
    // （DOM 里只有展开的那条规则的任务行，所以不能拿全局名单去比。）
    const finalCount = await evalJs('document.querySelectorAll("#mgrRoot .task-item").length');
    ok('既有任务数回到操作前（验收脚本没有多删）',
       finalCount === beforeCount, 'before=' + beforeCount + ' after=' + finalCount);

    /* ================= ③ 吸附后自动收起（真窗口尺寸） ================= */
    console.log('\n[3] 吸附后自动收起：设置勾上 → 吸附 → 等 2 秒 → 窗口必须变成 26×48');
    await evalJs('document.getElementById("configDone").click()');
    await sleep(600);

    const setup = await evalJs('(async function(){' +
      'var inv=window.__TAURI_INTERNALS__.invoke;' +
      'await inv("set_snap_edge",{edge:"left"});' +
      'await inv("set_snap_auto_hide",{on:true});' +
      'var st=await inv("window_chrome_status",{});' +
      'return {edge:st.snap_edge, auto:st.snap_auto_hide, collapsed:st.collapsed, rect:st.rect};})()');
    ok('设置：吸附边缘 = left、自动收起 = 开', setup.edge === 'left' && setup.auto === true, JSON.stringify(setup));
    ok('起始状态是展开的（collapsed=false）', setup.collapsed === false, JSON.stringify(setup));

    // 从外部进程把窗口拖到距左边 8px（< 20px 阈值 = 触发吸附），等同用户拖动。
    const beforeAuto = winRect();
    console.log('  吸附前窗口：' + JSON.stringify(beforeAuto));
    console.log('  外部挪窗：' + moveWindow(8, 140));
    await sleep(400);

    let autoRect = null;
    const t0 = Date.now();
    while (Date.now() - t0 < 6000) {
      await sleep(200);
      const r = winRect();
      if (r.ok && r.w <= 60 && r.h <= 110) { autoRect = r; break; }
    }
    const autoStatus = await evalJs('window.__TAURI_INTERNALS__.invoke("window_chrome_status",{})');
    console.log('  自动收起后窗口：' + JSON.stringify(autoRect) + '  status.rect=' + JSON.stringify(autoStatus.rect) +
      '  collapsed=' + autoStatus.collapsed);
    ok('★ 自动收起后窗口真的变成 26×48（GetWindowRect 读，不是日志）',
       !!autoRect && autoRect.w >= 26 && autoRect.w <= 60 && autoRect.h >= 48 && autoRect.h <= 110,
       JSON.stringify(autoRect));
    ok('★ 后端 collapsed 状态 = true', autoStatus.collapsed === true, String(autoStatus.collapsed));
    const handleShown = await evalJs('(function(){var h=document.getElementById("snapHandle");' +
      'return {hidden:h.hidden, body:document.body.dataset.collapsed};})()');
    ok('页面切成小三角视图（snap-handle 可见 / body[data-collapsed=on]）',
       handleShown.hidden === false && handleShown.body === 'on', JSON.stringify(handleShown));
    await shot('snap-autocollapse.png');

    /* ================= ③' 过渡动画：采样中间宽度 ================= */
    console.log('\n[3b] 过渡动画：收起过程中采样窗口宽度（>=3 个不同中间值才算有动画）');
    // 先展开回正常大小
    await evalJs('document.getElementById("snapHandle").click()');
    await sleep(900);
    const expandedAgain = winRect();
    console.log('  展开后窗口：' + JSON.stringify(expandedAgain));
    ok('点小三角 → 窗口展开回正常尺寸',
       expandedAgain.ok && expandedAgain.w > 600 && expandedAgain.h > 400, JSON.stringify(expandedAgain));

    /* 两路采样：
       (a) Rust 侧 window_anim_trace() —— 每帧**真的** SetWindowPos 写入的矩形，
           这是「分帧而不是一步到位」的直接证据；
       (b) 外部 GetWindowRect 采样 —— PowerShell 单次约 80~120ms，200ms 的过渡里
           只能采到 2~3 个点，作为旁证。 */
    // 外部采样与点击并行：先起采样进程（它自身有 ~200ms 的 PowerShell 启动开销，
    // 所以边起边点），再读 Rust 侧的逐帧记录。
    const readyFile = join(require('node:os').tmpdir(), 'took-ps-ready.txt');
    const goFile = join(require('node:os').tmpdir(), 'took-ps-go.txt');
    try { rmSync(readyFile, { force: true }); rmSync(goFile, { force: true }); } catch (e) {}
    // 起点宽度用 Rust 读（物理像素）：PowerShell 进程不是 DPI-aware，
    // GetWindowRect 在它眼里是被系统虚拟化过的逻辑像素（实测 1942 → 1295），不能混用。
    const preStatus = await evalJs('window.__TAURI_INTERNALS__.invoke("window_chrome_status",{})');
    const rustStartW = preStatus.rect[2];
    console.log('  Rust 侧起点宽度（物理像素）：' + rustStartW);

    const sampler = sampleWidths(1600, readyFile, goFile);
    // 等 PowerShell 就绪再点，保证采样窗覆盖整段过渡
    for (let i = 0; i < 200; i++) {
      const { existsSync } = require('node:fs');
      if (existsSync(readyFile)) break;
      await sleep(25);
    }
    require('node:fs').writeFileSync(goFile, 'go');
    await sleep(20);
    await evalJs('document.getElementById("btnCollapse").click()');
    const samples = await sampler;
    const trace = await evalJs('window.__TAURI_INTERNALS__.invoke("window_anim_trace",{})');
    const animErr = await evalJs('window.__TAURI_INTERNALS__.invoke("window_anim_errors",{})');
    const frameWidths = (trace || []).map(f => f[2]);
    const uniqTrace = [...new Set(frameWidths)];
    const uniqExt = [...new Set(samples)];
    console.log('  Rust 逐帧宽度（' + frameWidths.length + ' 帧）：' + JSON.stringify(frameWidths));
    console.log('  过渡中被系统拒掉的帧数：' + animErr);
    console.log('  Rust 逐帧不同宽度（' + uniqTrace.length + ' 个）：' + JSON.stringify(uniqTrace));
    console.log('  GetWindowRect 外部采样：' + JSON.stringify(samples));
    console.log('  外部采样不同宽度（' + uniqExt.length + ' 个）：' + JSON.stringify(uniqExt));

    ok('★ 收起是分帧的：Rust 逐帧记录 >= 8 帧', frameWidths.length >= 8, frameWidths.length + ' 帧');
    ok('★ 收起过程中至少 3 个不同的中间宽度（一步到位只会有 1 个）',
       uniqTrace.length >= 3, JSON.stringify(uniqTrace));
    ok('外部 GetWindowRect 采样也看到 >=2 个不同宽度（旁证，DPI 虚拟化口径）',
       uniqExt.length >= 2, JSON.stringify(uniqExt) + ' / 样本 ' + samples.length);
    ok('Rust 逐帧里有比起点小、比终点大的中间值',
       uniqTrace.some(w => w > 60 && w < (expandedAgain.w - 20)), JSON.stringify(uniqTrace));
    ok('逐帧宽度单调收缩（不会先弹大再缩）',
       frameWidths.every((w, i) => i === 0 || w <= frameWidths[i - 1]), JSON.stringify(frameWidths));
    // ease-out 的签名：第一帧就已经走掉相当大一段（线性缓动首帧只走 1/n）。
    // 口径用 Rust 物理像素的起点，和逐帧记录同一套单位。
    const firstProgress = rustStartW > 26 ? (rustStartW - frameWidths[0]) / (rustStartW - 26) : 0;
    ok('过渡是 ease-out：首帧已走掉 >15%（线性缓动首帧只有 ~8%）',
       firstProgress > 0.15,
       '首帧 ' + frameWidths[0] + ' / 起点 ' + rustStartW + ' → 已走 ' +
       (firstProgress * 100).toFixed(1) + '%');
    const finalCollapsed = winRect();
    console.log('  过渡结束后的真窗口：' + JSON.stringify(finalCollapsed));
    ok('过渡结束落在 26×48', finalCollapsed.ok && finalCollapsed.w <= 60 && finalCollapsed.h <= 110,
       JSON.stringify(finalCollapsed));

    // 还原：展开 + 关掉自动收起 + 边缘回到 none，别影响其它回归脚本
    await evalJs('document.getElementById("snapHandle").click()');
    await sleep(900);
    await evalJs('(async function(){var inv=window.__TAURI_INTERNALS__.invoke;' +
      'await inv("set_snap_auto_hide",{on:false}); await inv("set_snap_edge",{edge:"none"});' +
      'return true;})()');
    await sleep(300);
    const restored = await evalJs('window.__TAURI_INTERNALS__.invoke("window_chrome_status",{})');
    ok('清场：收起态已还原、自动收起已关闭', restored.collapsed === false && restored.snap_auto_hide === false,
       JSON.stringify({ collapsed: restored.collapsed, auto: restored.snap_auto_hide }));

    console.log('\n[运行期异常] ' + (errors.length === 0 ? '无' : errors.slice(0, 3).join(' | ')));
    ok('运行期没有未捕获异常', errors.length === 0, errors.slice(0, 2).join(' | '));

  } catch (e) {
    fail++;
    console.log('  异常：' + (e && e.stack ? e.stack : e));
  }

  console.log('\n================ 结果：' + pass + ' PASS / ' + fail + ' FAIL ================');
  try { ws.close(); } catch (e) {}
  app.kill();
  await sleep(400);
  process.exit(fail ? 1 : 0);
})();
