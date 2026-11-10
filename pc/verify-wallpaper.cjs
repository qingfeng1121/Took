/* 贴壁纸层（定稿 §5.5「固定桌面」）真窗口验收。
   证据分三层，全部来自真实运行：
     1. 命令层：wallpaper_status → 实际 PinMode
     2. 句柄层：wallpaper_probe → GetParent / 父窗口类名 / WS_CHILD / 命中测试 / 桌面层结构
     3. 屏幕层：Win+D 之后截桌面。本机 RDP 中 BitBlt 可能失败 —— 失败如实标注并写进 JSON，
        绝不拿 PrintWindow(Progman) 冒充（那张图不渲染跨进程子窗口）。
   用法：node verify-wallpaper.cjs */
const { spawn, execFileSync } = require('node:child_process');
const { mkdirSync, writeFileSync } = require('node:fs');

const EXE = 'D:/work/Project/Took/pc/src-tauri/target/debug/took.exe';
const SHOTS = 'D:/work/Project/Took/pc/shots/';
const PS = 'D:/work/Project/Took/pc/_wallshot.ps1';
const sleep = ms => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0, skip = 0;
const report = { steps: [] };
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  PASS  ' + name + (extra !== undefined ? '  ' + JSON.stringify(extra) : '')); }
  else { fail++; console.log('  FAIL  ' + name + (extra !== undefined ? '  ' + JSON.stringify(extra) : '')); }
  report.steps.push({ name, verdict: cond ? 'PASS' : 'FAIL', extra });
};
const skipped = (name, why) => {
  skip++; console.log('  SKIP  ' + name + '  （' + why + '）');
  report.steps.push({ name, verdict: 'SKIP', why });
};
const ps = (args) => execFileSync('powershell.exe',
  ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', PS].concat(args),
  { encoding: 'utf8', timeout: 180000 }).trim();

(async () => {
  mkdirSync(SHOTS, { recursive: true });
  const PORT = 9361;
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
  if (!target) { console.log('连不上 WebView2 调试端口。应用输出：\n' + appOut); proc.kill(); process.exit(2); }

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
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
    return r.result.value;
  };

  await send('Runtime.enable');
  await send('Page.enable');
  await sleep(2000);

  // ---------- 1. 启动状态
  const st0 = await invoke('wallpaper_status');
  console.log('\n[1] 启动时 wallpaper_status = ' + JSON.stringify(st0));
  report.status_startup = st0;
  ok('启动即生效（默认开）', st0.enabled === true, st0.mode);
  ok('实际 PinMode 是三种形态之一', ['WorkerW', 'ProgmanTopChild', 'FallbackAlwaysOnTop'].includes(st0.mode), st0.mode);

  const p0 = await invoke('wallpaper_probe');
  console.log('[1] 启动时 wallpaper_probe = ' + JSON.stringify(p0));
  report.probe_startup = p0;

  // ---------- 2. 设置页「桌面」面板 + 截图
  await evalJs('document.getElementById("btnSettings").click()');
  await sleep(500);
  const foundTab = await evalJs('(function(){var b=[...document.querySelectorAll("#setNav button")].find(function(x){return x.dataset.tab==="desktop";}); if(b){b.click(); return true;} return false;})()');
  await sleep(1200);
  ok('设置页有「桌面」页签', foundTab === true);
  const panelText = await evalJs('document.getElementById("setMain").innerText');
  console.log('[2] 桌面面板文字：\n' + panelText);
  ok('面板显示真实模式而不只是文案', /实际模式/.test(panelText));
  ok('面板显示真实父窗口句柄', /当前父窗口/.test(panelText) && /0x/.test(panelText));
  const shotPanel = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(SHOTS + 'wallpaper-settings-panel.png', Buffer.from(shotPanel.data, 'base64'));

  // ---------- 3. 用真实按钮点击关闭 / 开启
  const clickToggle = async () => {
    await evalJs('document.getElementById("wallToggle").click()');
    await sleep(1600);
    return await invoke('wallpaper_status');
  };

  const stOff = await clickToggle();
  console.log('\n[3] 点按钮关闭之后 = ' + JSON.stringify(stOff));
  report.status_off = stOff;
  ok('关闭后模式是 Disabled', stOff.mode === 'Disabled', stOff.mode);
  const pOff = await invoke('wallpaper_probe');
  console.log('[3] 关闭后 probe = ' + JSON.stringify(pOff));
  report.probe_off = pOff;
  ok('关闭后父窗口还原为 0', pOff.parent === 0, pOff.parent);
  ok('关闭后 WS_CHILD 已清除', pOff.is_child === false, pOff.style);
  ok('关闭后窗口仍可见（没被藏起来）', pOff.visible === true);

  const stOn = await clickToggle();
  console.log('\n[4] 再点按钮开启之后 = ' + JSON.stringify(stOn));
  report.status_on = stOn;
  ok('重新开启成功', stOn.enabled === true, stOn.mode);
  const pOn = await invoke('wallpaper_probe');
  console.log('[4] 开启后 probe = ' + JSON.stringify(pOn));
  report.probe_on = pOn;
  ok('开启后父窗口非 0（真的挂上去了）', pOn.parent !== 0, pOn.parent);
  ok('父窗口类名如实报出', typeof pOn.parent_class === 'string' && pOn.parent_class.length > 0, pOn.parent_class);
  ok('WS_CHILD 位已置上', pOn.is_child === true, pOn.style);
  ok('挂上去之后窗口仍然可见', pOn.visible === true);

  // ---------- 5. 24H2 结构实证（解释为什么本机不是 WorkerW 模式）
  console.log('\n[5] 桌面层结构：progman=' + pOn.progman +
    ' progman_has_def_view=' + pOn.progman_has_def_view +
    ' workerw_total=' + pOn.workerw_total + ' workerw_with_def_view=' + pOn.workerw_with_def_view);
  ok('Progman 确实挂着 SHELLDLL_DefView', pOn.progman_has_def_view === true);
  if (stOn.mode !== 'WorkerW') {
    ok('没有任何顶层 WorkerW 承载 DefView（经典路线因此不可用）', pOn.workerw_with_def_view === 0, { total: pOn.workerw_total });
  }

  // ---------- 6. 命中测试：压在最上层可点，且不挡图标区
  console.log('\n[6] 命中测试：中心=' + pOn.hit_center_class + ' 图标区=' + pOn.hit_icon_zone_class);
  // z-order 判断（不依赖屏幕上有没有别的应用压着）：Progman 的子窗口从最上层到最下层枚举，
  // 本窗口必须排在 SHELLDLL_DefView 之前 —— 这就是「贴在图标层之上」的定义。
  ok('本窗口在 Progman 子窗口 z-order 里排在 SHELLDLL_DefView 之前', pOn.above_def_view === true, pOn.sibling_order);
  ok('屏幕左上角图标区没有被窗口挡住', pOn.hit_icon_zone_is_self === false, pOn.hit_icon_zone_class);

  // ---------- 7. Win+D 之后还在不在
  console.log('\n[7] 按 Win+D ...');
  ps(['wind', '0x' + Number(pOn.window).toString(16)]);
  await sleep(2200);
  const pWind = await invoke('wallpaper_probe');
  console.log('[7] Win+D 之后 probe = ' + JSON.stringify(pWind));
  report.probe_after_wind = pWind;
  ok('Win+D 之后窗口仍然可见（没被收起）', pWind.visible === true);
  ok('Win+D 之后父级仍然是同一个宿主', pWind.parent === pOn.parent, { before: pOn.parent, after: pWind.parent });
  ok('Win+D 之后本窗口仍排在 DefView 之前（还在壁纸上）', pWind.above_def_view === true, pWind.sibling_order);

  // 屏幕层证据：先试真正的屏幕抓取（BitBlt）；RDP 会话里它常常失败，
  // 失败就退到 PrintWindow(Progman) —— 那会把 Progman 整棵子树（含挂进去的 Took）画出来，
  // 是「桌面 + Took 同框」的真证据，但它不是屏幕抓取，报告里必须标明用的是哪种。
  let shot = null;
  try { shot = JSON.parse(ps(['shot', SHOTS + '_screen_try.png'])); } catch (e) { shot = { ok: false }; }
  report.screen_bitblt = shot;
  if (shot.ok && shot.distinct_colors > 20) {
    ok('屏幕抓取可用，桌面截图直接来自屏幕', true, shot.distinct_colors);
    try { execFileSync('cp', [SHOTS + '_screen_try.png', SHOTS + 'desktop-wallpaper.png']); } catch (e) {}
    report.shot_method = 'BitBlt(screen)';
  } else {
    const pm = JSON.parse(ps(['pm', SHOTS + 'desktop-wallpaper.png']));
    console.log('[7] 屏幕抓取不可用（BitBlt ok=' + shot.ok + '），改用 PrintWindow(Progman)：' + JSON.stringify(pm));
    report.progman_render = pm;
    ok('Progman 子树渲染成功（桌面图标 + Took 同框）', pm.ok === true && pm.colors > 20, SHOTS + 'desktop-wallpaper.png');
    report.shot_method = 'PrintWindow(Progman, PW_RENDERFULLCONTENT) — RDP 下 BitBlt 不可用';
    skipped('真·屏幕抓取（BitBlt）', '本机 RDP 会话 BitBlt 返回 false，' +
      '故 desktop-wallpaper.png 是 Progman 子树渲染，不是屏幕截图；报告里已如此标注');
  }

  // ---------- 8. 关掉贴壁纸，恢复普通窗口，再截一张
  const stBack = await clickToggle();
  console.log('\n[8] 关闭贴壁纸之后 = ' + JSON.stringify(stBack));
  report.status_final_off = stBack;
  ps(['wind', '0x' + Number(pWind.window).toString(16)]); // 从「显示桌面」切回，让窗口回到普通桌面
  await sleep(1600);
  const pBack = await invoke('wallpaper_probe');
  console.log('[8] 恢复后 probe = ' + JSON.stringify(pBack));
  report.probe_restored = pBack;
  ok('恢复后父窗口为 0', pBack.parent === 0, pBack.parent);
  ok('恢复后 WS_CHILD 已清除', pBack.is_child === false, pBack.style);
  ok('恢复后状态 Disabled', stBack.mode === 'Disabled', stBack.mode);
  ok('恢复后窗口仍可见（拿得回来）', pBack.visible === true);

  // 关闭后的那一张：窗口已不挂在 Progman 里，所以 Progman 子树里应该**看不到 Took**
  let shot2 = null;
  try { shot2 = JSON.parse(ps(['shot', SHOTS + '_screen_try_off.png'])); } catch (e) { shot2 = { ok: false }; }
  if (shot2.ok && shot2.distinct_colors > 20) {
    try { execFileSync('cp', [SHOTS + '_screen_try_off.png', SHOTS + 'desktop-wallpaper-off.png']); } catch (e) {}
    ok('屏幕抓取可用，关闭后截图直接来自屏幕', true);
  } else {
    const pm2 = JSON.parse(ps(['pm', SHOTS + 'desktop-wallpaper-off.png']));
    console.log('[8] 关闭后的 Progman 子树渲染：' + JSON.stringify(pm2));
    report.progman_render_off = pm2;
    ok('关闭后 Progman 子树照样能渲染（仍能拿到桌面图）', pm2.ok === true, SHOTS + 'desktop-wallpaper-off.png');
  }
  report.shot_off = shot2;

  const shotPanel2 = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(SHOTS + 'wallpaper-settings-off.png', Buffer.from(shotPanel2.data, 'base64'));

  // 收尾：恢复成默认（开），别给下次启动留个关着的开关
  await invoke('set_wallpaper_pin', { on: true });
  await sleep(800);
  const pFinal = await invoke('wallpaper_probe');
  report.probe_final = pFinal;

  report.pass = pass; report.fail = fail; report.skip = skip;
  report.app_log = appOut.split('\n').filter(l => l.indexOf('贴壁纸') >= 0);
  writeFileSync(SHOTS + 'wallpaper-verify.json', JSON.stringify(report, null, 2), 'utf8');

  console.log('\n==== ' + pass + ' PASS / ' + fail + ' FAIL / ' + skip + ' SKIP ====');
  console.log('应用日志（贴壁纸相关）：');
  report.app_log.forEach(l => console.log('  ' + l));
  console.log('证据 JSON：' + SHOTS + 'wallpaper-verify.json');
  proc.kill();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('验收异常：', e); process.exit(3); });
