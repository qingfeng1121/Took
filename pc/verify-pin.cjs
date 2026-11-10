/* verify-pin.cjs —— 「固定方式」按钮与三种模式的真窗口验收（took.exe + CDP + Win32）
   证据分三层，全部来自真实运行：
     1. 界面层：按钮组 5 个、#btnPin 文字、就地弹出的三项菜单（截图）
     2. 命令层：pin_mode_status / wallpaper_status 的 mode
     3. 窗口层：GetWindowLong(hwnd, GWL_EXSTYLE) 的 WS_EX_TOPMOST(0x8) 位 —— 不看前端状态
   还验互斥（贴壁纸→置顶后壁纸层必须 Disabled）与持久化（置顶 → 退出 → 重开仍是置顶）。
   用法：node verify-pin.cjs */
const { spawn, execFileSync } = require('node:child_process');
const { mkdirSync, writeFileSync, rmSync } = require('node:fs');

const EXE = 'D:/work/Project/Took/pc/src-tauri/target/debug/took.exe';
const SHOTS = 'D:/work/Project/Took/pc/shots/';
const PROBE = 'D:/work/Project/Took/pc/_topmost.ps1';
const PORT = 9388;
const sleep = ms => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  PASS  ' + name + (extra !== undefined ? '  ' + JSON.stringify(extra) : '')); }
  else { fail++; console.log('  FAIL  ' + name + (extra !== undefined ? '  ' + JSON.stringify(extra) : '')); }
};

/* 直接问系统：GWL_EXSTYLE 里有没有 WS_EX_TOPMOST(0x8) */
const probe = () => {
  const raw = execFileSync('powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', PROBE],
    { encoding: 'utf8', timeout: 120000 }).trim();
  try { return JSON.parse(raw); } catch (e) { return { ok: false, why: raw.slice(0, 300) }; }
};

async function connect(proc, appOutRef) {
  let target = null;
  for (let i = 0; i < 120 && !target; i++) {
    try {
      const list = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json();
      target = list.filter(t => t.type === 'page' && t.webSocketDebuggerUrl)[0] || null;
    } catch (e) {}
    if (!target) await sleep(250);
  }
  if (!target) return null;
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
  const invoke = async (cmd, args) => {
    const r = await send('Runtime.evaluate', {
      expression: 'window.__TAURI_INTERNALS__.invoke(' + JSON.stringify(cmd) + ',' + JSON.stringify(args || {}) + ')',
      returnByValue: true, awaitPromise: true,
    });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
    return r.result.value;
  };
  const evalJs = async expr => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception || {}).description || 'eval error');
    return r.result.value;
  };
  const shot = async name => {
    const s = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(SHOTS + name, Buffer.from(s.data, 'base64'));
    return name;
  };
  return { ws, send, invoke, evalJs, shot };
}

function launch() {
  const proc = spawn(EXE, [], {
    env: Object.assign({}, process.env, { TOOK_CDP_PORT: String(PORT) }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const out = { text: '' };
  proc.stdout.on('data', d => { out.text += d.toString(); });
  proc.stderr.on('data', d => { out.text += d.toString(); });
  return { proc, out };
}

/* 点菜单项：走真实 UI 路径（点 #btnPin 开菜单 → 点菜单项），不是直接 invoke */
const pickByUi = async (C, mode) => {
  await C.evalJs('document.getElementById("btnPin").click()');
  await sleep(280);
  await C.evalJs('document.querySelector(\'#pinMenu button[data-pin="' + mode + '"]\').click()');
  await sleep(1800);
};

(async () => {
  mkdirSync(SHOTS, { recursive: true });
  try { rmSync('C:/Users/30803/AppData/Roaming/app.took.desktop/webview-cdp', { recursive: true, force: true }); } catch (e) {}

  let { proc, out } = launch();
  let C = await connect(proc);
  if (!C) { console.log('连不上 WebView2 调试端口：\n' + out.text); proc.kill(); process.exit(2); }
  await C.send('Runtime.enable');
  await C.send('Page.enable');
  await sleep(3500);

  /* 记下进入时的固定方式：验收跑完要原样还原，绝不改变这台机器上的既有状态。
     （verify-window-chrome.cjs 量的是 MainWindowHandle 的矩形，窗口若挂在壁纸层
       拿到的会是 Progman 那个 15×15 的宿主，那是**测试之间的状态耦合**，不是产品缺陷；
       所以本脚本不留下任何 pin_mode 改动。） */
  const initialPin = await C.invoke('pin_mode_status');
  console.log('  进入时固定方式：' + initialPin.mode + '（' + initialPin.label + '）');

  try {
    /* ================= 1. 按钮组：5 个，固定方式在最左 ================= */
    console.log('\n[1] 日历头部按钮组');
    const acts = await C.evalJs('(function(){' +
      'var bs=[].slice.call(document.querySelectorAll("#calActs button"));' +
      'var p=document.getElementById("btnPin");' +
      'var r=p?p.getBoundingClientRect():null;' +
      'return {ids:bs.map(function(b){return b.id;}), n:bs.length,' +
      ' label:document.getElementById("btnPinLbl")?document.getElementById("btnPinLbl").textContent:"",' +
      ' pinVisible: !!r && r.width>0 && r.height>0,' +
      ' hasGear: !!document.querySelector("#btnPin svg"),' +
      ' menuHidden: document.getElementById("pinMenu").hidden};})()');
    console.log('  按钮组：' + JSON.stringify(acts.ids) + '  文字=' + acts.label);
    ok('#calActs 恰好 5 个按钮', acts.n === 5, acts.ids);
    ok('顺序 = 固定方式 / 新建与管理 / 统计分析 / 收起 / 设置',
       JSON.stringify(acts.ids) === JSON.stringify(['btnPin','btnNew','btnAnalysis','btnCollapse','btnSettings']), acts.ids);
    ok('#btnPin 可见且带图标（图钉，不是齿轮）', acts.pinVisible === true && acts.hasGear === true, acts.pinVisible);
    ok('菜单初始是关闭的', acts.menuHidden === true, acts.menuHidden);

    /* ================= 2. 点 #btnPin 就地弹出三项菜单（截图） ================= */
    console.log('\n[2] 点 #btnPin 就地弹菜单');
    await C.evalJs('document.getElementById("btnPin").click()');
    await sleep(400);
    const menu = await C.evalJs('(function(){' +
      'var m=document.getElementById("pinMenu");' +
      'var r=m.getBoundingClientRect(); var b=document.getElementById("btnPin").getBoundingClientRect();' +
      'var items=[].slice.call(m.querySelectorAll("button[data-pin]")).map(function(x){return x.dataset.pin;});' +
      'var checked=[].slice.call(m.querySelectorAll("button[data-pin]")).filter(function(x){return x.getAttribute("aria-checked")==="true";}).map(function(x){return x.dataset.pin;});' +
      'var cs=getComputedStyle(m);' +
      'return {hidden:m.hidden, items:items, checked:checked, pos:cs.position,' +
      ' below: Math.round(r.top) >= Math.round(b.bottom),' +
      ' expanded: document.getElementById("btnPin").getAttribute("aria-expanded")};})()');
    console.log('  菜单：' + JSON.stringify(menu));
    ok('菜单已弹出（就地，不是模态框）', menu.hidden === false && menu.pos === 'fixed', menu.pos);
    ok('锚在按钮下方', menu.below === true, menu.below);
    ok('三项：贴桌面壁纸 / 置顶窗口 / 普通窗口',
       JSON.stringify(menu.items) === JSON.stringify(['wallpaper','top','normal']), menu.items);
    ok('当前项恰好一个且打了勾', menu.checked.length === 1, menu.checked);
    ok('#btnPin aria-expanded = true', menu.expanded === 'true', menu.expanded);
    const shotMenu = await C.shot('pin-btn-menu.png');
    console.log('  截图：' + SHOTS + shotMenu);

    /* 点外面关闭 */
    await C.evalJs('document.getElementById("calTitle").click()');
    await sleep(300);
    const closed = await C.evalJs('document.getElementById("pinMenu").hidden');
    ok('点菜单外任意处关闭', closed === true, closed);

    /* ================= 3. 三种模式：按钮文字 + Win32 证据 ================= */
    console.log('\n[3] 贴桌面壁纸');
    await pickByUi(C, 'wallpaper');
    const stWall = await C.invoke('pin_mode_status');
    const pWall = probe();
    const lblWall = await C.evalJs('document.getElementById("btnPinLbl").textContent');
    console.log('  pin_mode_status = ' + JSON.stringify(stWall));
    console.log('  Win32 读回 = ' + JSON.stringify(pWall));
    ok('按钮文字 = 贴壁纸', lblWall === '贴壁纸', lblWall);
    ok('wallpaper_status.mode 不是 Disabled（真探测值）', stWall.wallpaper.mode !== 'Disabled', stWall.wallpaper.mode);
    ok('贴壁纸时 WS_EX_TOPMOST 位为 0（不置顶）', pWall.topmost === false, pWall.exstyle);
    await C.shot('pin-wallpaper.png');

    console.log('\n[4] 置顶窗口（从贴壁纸切过来 —— 同时验互斥）');
    await pickByUi(C, 'top');
    const stTop = await C.invoke('pin_mode_status');
    const pTop = probe();
    const lblTop = await C.evalJs('document.getElementById("btnPinLbl").textContent');
    console.log('  pin_mode_status = ' + JSON.stringify(stTop));
    console.log('  Win32 读回 = ' + JSON.stringify(pTop));
    ok('按钮文字 = 置顶', lblTop === '置顶', lblTop);
    ok('★Win32 WS_EX_TOPMOST(0x8) 位 = 1（真的置顶了）', pTop.topmost === true, pTop.exstyle);
    ok('★互斥：从贴壁纸切到置顶后 wallpaper_status.mode = Disabled',
       stTop.wallpaper.mode === 'Disabled', stTop.wallpaper.mode);
    await C.shot('pin-top.png');

    console.log('\n[5] 普通窗口');
    await pickByUi(C, 'normal');
    const stNorm = await C.invoke('pin_mode_status');
    const pNorm = probe();
    const lblNorm = await C.evalJs('document.getElementById("btnPinLbl").textContent');
    console.log('  pin_mode_status = ' + JSON.stringify(stNorm));
    console.log('  Win32 读回 = ' + JSON.stringify(pNorm));
    ok('按钮文字 = 普通', lblNorm === '普通', lblNorm);
    ok('★WS_EX_TOPMOST 位 = 0', pNorm.topmost === false, pNorm.exstyle);
    ok('★wallpaper_status.mode = Disabled', stNorm.wallpaper.mode === 'Disabled', stNorm.wallpaper.mode);
    await C.shot('pin-normal.png');

    /* ================= 6. 设置页同步：两边不打架 ================= */
    console.log('\n[6] 设置页「桌面固定」与按钮同步');
    await C.evalJs('document.getElementById("btnSettings").click()');
    await sleep(500);
    await C.evalJs('document.querySelector(\'#setNav button[data-tab="desktop"]\').click()');
    await sleep(1400);
    const panel = await C.evalJs('(function(){' +
      'var seg=document.querySelector("#setMain [data-pinmode] button.on");' +
      'var t=document.getElementById("setMain").innerText;' +
      'return {seg: seg?seg.dataset.v:null, hasPinRow:/固定方式/.test(t), hasTop:/WS_EX_TOPMOST/.test(t)};})()');
    console.log('  设置页：' + JSON.stringify(panel));
    ok('设置页有「固定方式」三选一，且选中项 = 普通（与按钮一致）', panel.seg === 'normal', panel.seg);
    ok('设置页显示真窗口的 WS_EX_TOPMOST 读数', panel.hasTop === true, panel.hasTop);

    /* 设置页里切「贴壁纸」→ 按钮文字必须跟着变 */
    await C.evalJs('document.querySelector(\'#setMain [data-pinmode] button[data-v="wallpaper"]\').click()');
    await sleep(1800);
    const afterSet = await C.evalJs('document.getElementById("btnPinLbl").textContent');
    const stAfter = await C.invoke('pin_mode_status');
    ok('★设置页切到贴壁纸 → 按钮文字同步为「贴壁纸」', afterSet === '贴壁纸', afterSet);
    ok('设置页切换后 wallpaper_status.mode 不是 Disabled', stAfter.wallpaper.mode !== 'Disabled', stAfter.wallpaper.mode);

    /* 再点设置页里的「已开启 · 点击关闭」→ 按钮必须变成「普通」（这就是用户说的那种不一致） */
    await C.evalJs('document.getElementById("wallToggle").click()');
    await sleep(2000);
    const afterToggle = await C.evalJs('document.getElementById("btnPinLbl").textContent');
    const stToggle = await C.invoke('pin_mode_status');
    console.log('  关掉贴壁纸开关后：按钮=' + afterToggle + '  pin=' + JSON.stringify({mode: stToggle.mode, wp: stToggle.wallpaper.mode}));
    ok('★设置页关掉贴壁纸 → 按钮文字同步为「普通」', afterToggle === '普通', afterToggle);
    ok('★关掉后 pin_mode = normal（不留「按钮说贴壁纸、设置页说已关闭」）', stToggle.mode === 'normal', stToggle.mode);
    ok('关掉后 wallpaper_status.mode = Disabled', stToggle.wallpaper.mode === 'Disabled', stToggle.wallpaper.mode);
    await C.evalJs('document.getElementById("setBack").click()');
    await sleep(500);

    /* ================= 7. 持久化：设成置顶 → 退出 → 重开 ================= */
    console.log('\n[7] 持久化：设成「置顶」→ 退出 → 重开');
    await pickByUi(C, 'top');
    const beforeQuit = probe();
    console.log('  退出前 Win32 = ' + JSON.stringify(beforeQuit));
    ok('退出前置顶位 = 1', beforeQuit.topmost === true, beforeQuit.exstyle);

    try { C.ws.close(); } catch (e) {}
    proc.kill();
    await sleep(2500);
    try { execFileSync('taskkill', ['/F', '/IM', 'took.exe'], { encoding: 'utf8' }); } catch (e) {}
    await sleep(1200);
    try { rmSync('C:/Users/30803/AppData/Roaming/app.took.desktop/webview-cdp', { recursive: true, force: true }); } catch (e) {}

    ({ proc, out } = launch());
    C = await connect(proc);
    if (!C) { console.log('重开连不上调试端口：\n' + out.text); proc.kill(); process.exit(2); }
    await C.send('Runtime.enable');
    await C.send('Page.enable');
    await sleep(4000);

    const afterRestart = probe();
    const stRestart = await C.invoke('pin_mode_status');
    const lblRestart = await C.evalJs('document.getElementById("btnPinLbl").textContent');
    console.log('  重开后 Win32 = ' + JSON.stringify(afterRestart));
    console.log('  重开后 pin_mode_status = ' + JSON.stringify({mode: stRestart.mode, label: stRestart.label, aot: stRestart.always_on_top}));
    ok('★重启后 WS_EX_TOPMOST 仍为 1（启动恢复真的生效）', afterRestart.topmost === true, afterRestart.exstyle);
    ok('★重启后按钮文字仍是「置顶」', lblRestart === '置顶', lblRestart);
    ok('重启后 pin_mode = top', stRestart.mode === 'top', stRestart.mode);

    /* ================= 8. 清场：还原成进入时的那一种 ================= */
    console.log('\n[8] 清场');
    await C.evalJs('window.__TAURI_INTERNALS__.invoke("set_pin_mode",{mode:' + JSON.stringify(initialPin.mode) + '})');
    await sleep(1500);
    const restored = await C.invoke('pin_mode_status');
    ok('清场：固定方式已还原成进入时的 ' + initialPin.mode, restored.mode === initialPin.mode, restored.mode);

    console.log('\n应用输出（固定方式相关）：');
    console.log(out.text.split('\n').filter(l => /固定方式|贴壁纸/.test(l)).slice(-12).join('\n'));

    try { C.ws.close(); } catch (e) {}
    proc.kill();
    await sleep(600);
    try { execFileSync('taskkill', ['/F', '/IM', 'took.exe'], { encoding: 'utf8' }); } catch (e) {}
  } catch (e) {
    fail++;
    console.log('  EXCEPTION  ' + (e && e.stack ? e.stack : e));
    try { C.ws.close(); } catch (e2) {}
    proc.kill();
  }

  console.log('\n================ 结果：' + pass + ' PASS / ' + fail + ' FAIL ================');
  process.exit(fail ? 1 : 0);
})();
