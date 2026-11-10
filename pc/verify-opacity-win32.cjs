/* 透明度的**窗口层**证据。
 *
 * 为什么不用屏幕截图：本机是 RDP 会话，CopyFromScreen 抓回来的是近乎全黑
 * （实测 (0,6,9) / (0,6,12) / (2,10,18)，与窗口内容无关），拿它比对透明度
 * 只会得到 delta=0 的假阴性。verify-wallpaper.cjs 里已经记录过同一台机器的
 * BitBlt 不可用。**不拿抓不到的截图冒充证据。**
 *
 * 改为直接向 Windows 查询「这个窗口是不是分层窗口、它的 alpha 是多少」——
 * WS_EX_LAYERED + LWA_ALPHA 就是 Windows 合成半透明窗口的全部机制，
 * 读回这两个值等价于证明「窗口真的半透明了」，而不是只改了 DOM。
 *
 * 用法：node verify-opacity-win32.cjs */
const { spawn, execFileSync } = require('node:child_process');
const { mkdirSync, writeFileSync } = require('node:fs');

const EXE = 'D:/work/Project/Took/pc/src-tauri/target/debug/took.exe';
const SHOTS = 'D:/work/Project/Took/pc/shots/';
const PROBE = 'D:/work/Project/Took/pc/_layered.ps1';
const PORT = 9375;
const sleep = ms => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  PASS  ' + name + (extra !== undefined ? '  ' + JSON.stringify(extra) : '')); }
  else { fail++; console.log('  FAIL  ' + name + (extra !== undefined ? '  ' + JSON.stringify(extra) : '')); }
};

/* 直接问系统：GWL_EXSTYLE 里有没有 WS_EX_LAYERED，以及 LWA_ALPHA 的 alpha 值 */
const probe = () => {
  const raw = execFileSync('powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', PROBE],
    { encoding: 'utf8', timeout: 120000 }).trim();
  try { return JSON.parse(raw); } catch (e) { return { ok: false, why: raw.slice(0, 300) }; }
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

  let target = null;
  for (let i = 0; i < 120 && !target; i++) {
    try {
      const list = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json();
      target = list.filter(t => t.type === 'page' && t.webSocketDebuggerUrl)[0] || null;
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
  await sleep(3500);

  try {
    /* ---- 100%：分层窗口存在，alpha=255 ---- */
    console.log('\n[100%]');
    await evalJs('window.__TAURI_INTERNALS__.invoke("set_opacity", {value:100})');
    await sleep(1000);
    const full = probe();
    console.log('  Win32 读回：' + JSON.stringify(full));
    ok('读得到 GWL_EXSTYLE 与分层属性', full.ok === true, full.why || '');
    ok('窗口带 WS_EX_LAYERED（分层窗口，透明度机制已就位）', full.layered === true, full.layered);
    ok('100% 时 alpha = 255（完全不透明）', full.alpha === 255, full.alpha);

    /* ---- 40%：alpha 必须跟着变 ---- */
    console.log('\n[ 40%]');
    await evalJs('window.__TAURI_INTERNALS__.invoke("set_opacity", {value:40})');
    await sleep(1000);
    const dim = probe();
    console.log('  Win32 读回：' + JSON.stringify(dim));
    ok('40% 时 alpha ≈ 102（40% × 255，Windows 真按这个值合成）',
       Math.abs(dim.alpha - 102) <= 1, dim.alpha);
    ok('★分层窗口的 alpha 真的被改了（不是只改 DOM）',
       dim.alpha !== full.alpha, { at100: full.alpha, at40: dim.alpha });

    /* ---- 65%：中间值也要对 ---- */
    console.log('\n[ 65%]');
    await evalJs('window.__TAURI_INTERNALS__.invoke("set_opacity", {value:65})');
    await sleep(1000);
    const mid = probe();
    ok('65% 时 alpha ≈ 166', Math.abs(mid.alpha - 166) <= 1, mid.alpha);

    /* ---- 后端命令的读回与 Win32 一致 ---- */
    const viaCmd = await evalJs('window.__TAURI_INTERNALS__.invoke("window_opacity", {})');
    ok('window_opacity 命令读回 65%（与 Win32 一致）', Number(viaCmd) === 65, viaCmd);

    /* ---- 半透明时文字对比度：走**真实 UI 路径**拖滑块，卡片底色必须仍是实色 ----
       必须经 UI 才测得到 body[data-transparent="on"] 这条分支：
       直接 invoke 命令只会改窗口，不会跑前端的 applyChromeState。 */
    await evalJs('document.getElementById("btnSettings").click()');
    await sleep(400);
    await evalJs('document.querySelector(\'#setNav button[data-tab="appearance"]\').click()');
    await sleep(700);
    await evalJs('(function(){var r=document.getElementById("winOpacity"); r.value="40";' +
      'r.dispatchEvent(new Event("input",{bubbles:true})); return r.value;})()');
    await sleep(1000);
    const contrast = await evalJs('(function(){' +
      'var cal=getComputedStyle(document.querySelector(".cal"));' +
      'var stage=getComputedStyle(document.querySelector(".stage"));' +
      'return {calBg: cal.backgroundColor, stageBg: stage.backgroundColor,' +
      'bodyTransparent: document.body.dataset.transparent,' +
      'calOpacity: cal.opacity, textColor: getComputedStyle(document.querySelector(".cal-head h1")).color,' +
      'label: (document.getElementById("winOpacityVal")||{}).textContent};})()');
    console.log('  对比度检查（经真实滑块）：' + JSON.stringify(contrast));
    ok('滑块拖到 40% 后 body 标记为半透明', contrast.bodyTransparent === 'on', contrast.bodyTransparent);
    ok('百分比显示 40%', contrast.label === '40%', contrast.label);
    ok('★半透明时卡片底色仍是实色 rgb(255,255,255)（文字对比度不掉）',
       contrast.calBg === 'rgb(255, 255, 255)', contrast.calBg);
    ok('文字仍是深色 rgb(31, 35, 41)', contrast.textColor === 'rgb(31, 35, 41)', contrast.textColor);
    ok('卡片自身 opacity 仍是 1（半透明只作用在窗口层）',
       Number(contrast.calOpacity) === 1, contrast.calOpacity);
    // 经 UI 拖到 40% 后，Win32 的 alpha 也必须是 102
    const viaUi = probe();
    ok('经 UI 拖到 40% 后 Win32 alpha = 102', Math.abs(viaUi.alpha - 102) <= 1, viaUi.alpha);
    await evalJs('document.getElementById("setDone").click()');
    await sleep(300);

    /* ---- 越界必须报错 ---- */
    const bad = await evalJs('(async function(){try{await window.__TAURI_INTERNALS__.invoke("set_opacity",{value:39});return "NO_ERROR";}catch(e){return String(e);}})()');
    ok('39% 报错（不静默夹取到 40）', /越界/.test(String(bad)), String(bad).slice(0, 100));

    // 复原
    await evalJs('window.__TAURI_INTERNALS__.invoke("set_opacity", {value:100})');
    await sleep(400);

    writeFileSync(SHOTS + 'win-opacity-win32.json',
      JSON.stringify({ full, dim, mid, contrast, pass, fail }, null, 2));
    console.log('\nPASS ' + pass + '   FAIL ' + fail);
    console.log('报告：' + SHOTS + 'win-opacity-win32.json');
  } catch (err) {
    console.log('出错：' + (err && err.stack ? err.stack : err));
    fail++;
  } finally {
    try { proc.kill(); } catch (e) {}
    try { execFileSync('taskkill', ['/F', '/IM', 'took.exe'], { stdio: 'ignore' }); } catch (e) {}
  }
  process.exit(fail === 0 ? 0 : 1);
})();
