/* 真机验收：直接驱动 Tauri 窗口里的 WebView2（WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS
   打开远程调试端口），跑与浏览器版同一套 DOM 断言，但数据来自 Rust 的 month_grid /
   list_rules 命令而不是 mock.js。 */
const { spawn } = require('node:child_process');
const { writeFileSync, mkdirSync } = require('node:fs');

const EXE = 'D:/work/Project/Took/pc/src-tauri/target/debug/took.exe';
const SHOTS = 'D:/work/Project/Took/pc/shots/';
const PORT = 9333;
const sleep = ms => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  PASS  ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  ' + extra : '')); }
};

(async () => {
  mkdirSync(SHOTS, { recursive: true });
  const app = spawn(EXE, [], {
    env: Object.assign({}, process.env, {
      // 两条路都设：TOOK_CDP_PORT 走 Rust 侧的 additional_browser_args（本机实测这条有效，
      // 因为 WebView2 对已存在的同数据目录浏览器进程会忽略环境变量那条路）
      TOOK_CDP_PORT: String(PORT),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=' + PORT,
    }),
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
  if (!target) {
    console.log('无法连接 WebView2 调试端口；应用 stdout：');
    console.log(out.trim());
    app.kill();
    process.exit(2);
  }
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
  await sleep(2500);

  try {
    console.log('\n[Tauri 窗口 / 真命令数据]');
    console.log('  应用 stdout：' + out.trim().split('\n')[0]);

    const s = await evalJs(`(function(){
      var g=document.getElementById('grid');
      var rows=[].slice.call(g.children);
      var cells=[].slice.call(document.querySelectorAll('#grid .cell'));
      var gt=g.getBoundingClientRect();
      var vis=cells.filter(function(c){var r=c.getBoundingClientRect();
        return r.bottom>gt.top+2 && r.top<gt.bottom-2;});
      function names(d){var c=document.querySelector('.cell[data-date="'+d+'"]');
        return c ? [].slice.call(c.querySelectorAll('.tag:not(.more) .nm')).map(function(n){return n.textContent;}) : null;}
      function done(d){var c=document.querySelector('.cell[data-date="'+d+'"]');
        return c ? [].slice.call(c.querySelectorAll('.tag.done .nm')).map(function(n){return n.textContent;}) : null;}
      return {
        weeks: rows.length,
        firstWeek: rows.length ? rows[0].dataset.week : null,
        n: cells.length,
        first: cells.length ? cells[0].dataset.date : null,
        last: cells.length ? cells[cells.length-1].dataset.date : null,
        overflowY: getComputedStyle(g).overflowY,
        scrollH: g.scrollHeight, clientH: g.clientHeight,
        visFirst: vis.length ? vis[0].dataset.date : null,
        acts: [].slice.call(document.querySelectorAll('#calActs button')).map(function(b){return b.id;}),
        title: document.getElementById('calTitle').textContent,
        sub: document.getElementById('calSub').textContent,
        source: document.getElementById('sourceTag').textContent,
        density: document.documentElement.dataset.density,
        mon: names('2026-10-05'),
        sun: names('2026-10-04'),
        rent: names('2026-10-20'),
        week: ['2026-10-19','2026-10-20','2026-10-21','2026-10-22','2026-10-23'].map(done),
        nextWeek: done('2026-10-26'),
        docW: Math.round(document.getElementById('calCard').getBoundingClientRect().width),
        hasTauri: !!(window.__TAURI__ && window.__TAURI__.core),
        full: (function(){
          var st=document.querySelector('.stage'), cal=document.getElementById('calCard');
          var cs=function(e){return getComputedStyle(e);};
          var acts=document.querySelectorAll('#calActs button').length;
          return {topbar: !!document.querySelector('.topbar'),
                  stagePad: cs(st).padding, stageBg: cs(st).backgroundColor,
                  calBg: cs(cal).backgroundColor, calRadius: cs(cal).borderRadius,
                  calShadow: cs(cal).boxShadow,
                  calW: Math.round(cal.getBoundingClientRect().width),
                  winW: window.innerWidth, winH: window.innerHeight,
                  acts: acts, legend: !!document.querySelector('.legend')};
        })()
      };})()`);

    ok('数据来自 Tauri 本地库（不是 mock）', s.source.indexOf('Tauri') >= 0, s.source);
    ok('window.__TAURI__ 注入成功', s.hasTauri === true);
    ok('连续周滚动容器（overflow-y:auto，内容高于视口）',
       s.overflowY === 'auto' && s.scrollH > s.clientH + 100, s.overflowY + ' ' + s.scrollH + '>' + s.clientH);
    ok('周数 ≈ 150（实测 ' + s.weeks + ' 周 × 7 = ' + s.n + ' 格）',
       s.weeks >= 100 && s.weeks <= 160 && s.n === s.weeks * 7, s.weeks + ' 周 / ' + s.n + ' 格');
    ok('首周 2025-09-29 / 末格 2027-10-31（日期连续无断层）',
       s.firstWeek === '2025-09-29' && s.last === '2027-10-31', s.firstWeek + ' → ' + s.last);
    ok('启动即定位到本月（可见首 = 2026-09-28）', s.visFirst === '2026-09-28', String(s.visFirst));
    // 2026-10-27 用户要求删掉「配置」——它和「新建与管理」都是打开同一个管理页，
    // 功能重复。断言仍是**完整且有序**的按钮列表（不是放宽为「≥N 个」）。
    // 2026-10-27 又加 #btnPin（固定方式快捷按钮，用户原话「在设置旁边添加一个固定按钮，
    // 不要进入设置才能固定这样麻烦了」）：它排在最左，设置仍在最右，共 5 个。
    ok('日历头部有功能按钮组（固定方式 / 新建与管理 / 统计分析 / 收起 / 设置）',
       JSON.stringify(s.acts) === JSON.stringify(['btnPin','btnNew','btnAnalysis','btnCollapse','btnSettings']),
       JSON.stringify(s.acts));
    ok('标题 = 2026 年 10 月', s.title === '2026 年 10 月', s.title);
    ok('副标题统计来自 list_rules（4 条规则 / 5 个任务）', s.sub.indexOf('4 条规则') >= 0 && s.sub.indexOf('5 个任务') >= 0, s.sub);
    ok('窗口 1280 宽 → loose（日历宽 ' + s.docW + 'px）', s.density === 'loose', s.density);

    // 铺满整个窗口：2026-10-27 按用户要求删掉 HTML 品牌条、日历去掉卡片外观。
    console.log('\n[Tauri 窗口 / 铺满整个屏幕]');
    const f = s.full;
    ok('HTML 品牌条 .topbar 已删除', f.topbar === false, 'topbar=' + f.topbar);
    ok('.stage padding = ' + f.stagePad + '（无外边距）', f.stagePad === '0px', f.stagePad);
    ok('.stage 底色是实色白（窗口整块都是日历底）', f.stageBg === 'rgb(255, 255, 255)', f.stageBg);
    ok('.cal border-radius = ' + f.calRadius, f.calRadius === '0px', f.calRadius);
    ok('.cal box-shadow = ' + f.calShadow, f.calShadow === 'none', f.calShadow);
    ok('.cal 自身无白底（透明，由 .stage 铺满）', f.calBg === 'rgba(0, 0, 0, 0)', f.calBg);
    ok('日历宽 = 窗口宽（' + f.calW + ' / ' + f.winW + 'px）', f.calW === f.winW, f.calW + '/' + f.winW);
    // 原来是 ≥5（配置/新建/统计/收起/设置）；删掉「配置」后为 4；
    // 2026-10-27 加 #btnPin（固定方式）后精确为 5。
    ok('功能按钮组仍在（#calActs 恰好 5 个按钮）', f.acts === 5, f.acts);
    ok('底部图例保留', f.legend === true, String(f.legend));
    ok('周日 10-04 只有背单词', JSON.stringify(s.sun) === JSON.stringify(['背单词']), JSON.stringify(s.sun));
    ok('周一 10-05 三条', JSON.stringify(s.mon) === JSON.stringify(['背单词','健身','早起']), JSON.stringify(s.mon));
    ok('10-20 命中交房租', (s.rent||[]).indexOf('交房租') >= 0, JSON.stringify(s.rent));
    ok('10-19 那周健身全已完成', s.week.every(d => (d||[]).indexOf('健身') >= 0), JSON.stringify(s.week));
    ok('最满的一格（10-20 有 4 条）没有被 fitTags 收掉', (s.rent||[]).length === 4, JSON.stringify(s.rent));
    ok('10-26 起未完成', (s.nextWeek||[]).indexOf('健身') < 0, JSON.stringify(s.nextWeek));

    // 日历头部（含功能按钮组）截图
    const shotHead = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(SHOTS + 'tauri-cal-head-buttons.png', Buffer.from(shotHead.data, 'base64'));

    // 真窗口里滚轮滚一格 ≈ 1 行（走 CDP Input.dispatchMouseEvent type=mouseWheel）
    console.log('\n[Tauri 窗口 / 滚轮平滑滚动]');
    const geom = async () => evalJs(`(function(){
      var g=document.getElementById('grid'); var gt=g.getBoundingClientRect();
      var vis=[].slice.call(document.querySelectorAll('#grid .cell')).filter(function(c){
        var r=c.getBoundingClientRect(); return r.bottom>gt.top+2 && r.top<gt.bottom-2;});
      return {top:Math.round(g.scrollTop),
              rowH:Math.round(g.children[0].getBoundingClientRect().height),
              gap:Math.round(g.children[1].getBoundingClientRect().top - g.children[0].getBoundingClientRect().bottom),
              first:vis[0].dataset.date, last:vis[vis.length-1].dataset.date,
              title:document.getElementById('calTitle').textContent,
              box:(function(){var r=g.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()};})()`);
    const t0 = await geom();
    const tstep = t0.rowH + t0.gap;
    const wheelAt = async (dy) => {
      await send('Input.dispatchMouseEvent', {
        type: 'mouseWheel', x: t0.box.x, y: t0.box.y, deltaX: 0, deltaY: dy,
        button: 'none', clickCount: 0,
      });
      await sleep(280);
    };
    await wheelAt(100);
    const t1 = await geom();
    const tRows = (t1.top - t0.top) / tstep;
    ok('真窗口滚一格 = ' + (t1.top - t0.top) + 'px ≈ ' + tRows.toFixed(2) + ' 行（要求 1~2 行）',
       tRows >= 0.9 && tRows <= 2.0, tRows.toFixed(2) + ' 行');
    ok('不是整月跳（位移 ' + (t1.top - t0.top) + 'px < 一屏 ' + Math.round(tstep * 6) + 'px）',
       (t1.top - t0.top) < tstep * 6, (t1.top - t0.top) + 'px');
    // 再滚一格：每格恒定 1 行，两格合计 2 行
    await wheelAt(100);
    const t1b = await geom();
    const tRows2 = (t1b.top - t0.top) / tstep;
    ok('连滚两格共 ' + (t1b.top - t0.top) + 'px ≈ ' + tRows2.toFixed(2) + ' 行（每格 1 行）',
       Math.abs(tRows2 - 2) < 0.05, tRows2.toFixed(2) + ' 行');
    ok('可见区间前进 1 行：' + t0.first + ' → ' + t1b.first, t1b.first > t0.first, t1b.first);
    // 复位到 10 月第一周，后面跨月断言从固定位置开始
    await evalJs(`(function(){
      var g=document.getElementById('grid'); var rows=[].slice.call(g.children);
      var step=Math.round(rows[0].getBoundingClientRect().height +
        (rows[1].getBoundingClientRect().top - rows[0].getBoundingClientRect().bottom));
      var i=rows.findIndex(function(r){return r.dataset.week==='2026-09-28';});
      g.scrollTo({top:i*step}); return true;})()`);
    await sleep(350);

    // 跨月：滚到 10/26 那一周，要能看到 10/26~11/01 连续 7 天
    await evalJs(`(function(){
      var g=document.getElementById('grid'); var rows=[].slice.call(g.children);
      var step=Math.round(rows[0].getBoundingClientRect().height +
        (rows[1].getBoundingClientRect().top - rows[0].getBoundingClientRect().bottom));
      var i=rows.findIndex(function(r){return r.dataset.week==='2026-10-26';});
      g.scrollTo({top:i*step}); return true;})()`);
    await sleep(400);
    const crossT = await evalJs(`(function(){
      var row=document.querySelector('#grid .week[data-week="2026-10-26"]');
      return {dates:row?[].slice.call(row.children).map(function(c){return c.dataset.date;}):null,
              nums:row?[].slice.call(row.querySelectorAll('.dnum')).map(function(n){return n.textContent;}):null,
              title:document.getElementById('calTitle').textContent};})()`);
    ok('跨月周 10/26~11/01 连续 7 天',
       JSON.stringify(crossT.dates) === JSON.stringify(
         ['2026-10-26','2026-10-27','2026-10-28','2026-10-29','2026-10-30','2026-10-31','2026-11-01']),
       JSON.stringify(crossT.dates));
    ok('跨月行日期数字 26,27,28,29,30,31,1',
       JSON.stringify(crossT.nums) === JSON.stringify(['26','27','28','29','30','31','1']),
       JSON.stringify(crossT.nums));
    const shotCross = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(SHOTS + 'tauri-cal-scroll-crossmonth.png', Buffer.from(shotCross.data, 'base64'));

    // 标题跟随：再往下滚一格 → 顶部跨进 11 月，标题必须跟着变
    await wheelAt(100);
    const t2 = await geom();
    const t2expect = t2.first.slice(0, 4) + ' 年 ' + Number(t2.first.slice(5, 7)) + ' 月';
    ok('继续滚后标题跟随顶部那一周（' + crossT.title + ' → ' + t2.title + '，顶部 ' + t2.first + '）',
       t2.title === t2expect && t2.title !== crossT.title, t2.title + ' / ' + t2expect);

    // 滚回 10 月第一周，后面的点击断言仍按 10 月来
    await evalJs(`(function(){
      var g=document.getElementById('grid'); var rows=[].slice.call(g.children);
      var step=Math.round(rows[0].getBoundingClientRect().height +
        (rows[1].getBoundingClientRect().top - rows[0].getBoundingClientRect().bottom));
      var i=rows.findIndex(function(r){return r.dataset.week==='2026-09-28';});
      g.scrollTo({top:i*step}); return true;})()`);
    await sleep(400);
    ok('滚回 10 月第一周后标题回到 2026 年 10 月',
       (await evalJs('document.getElementById("calTitle").textContent')) === '2026 年 10 月');

    // 真窗口里点日期数字 → 面板
    const box = await evalJs('(function(){var e=document.querySelector(\'.cell[data-date="2026-10-23"] .dnum\');' +
      'var r=e.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2};})()');
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
      await send('Input.dispatchMouseEvent', { type: type, x: box.x, y: box.y, button: type === 'mouseMoved' ? 'none' : 'left', clickCount: type === 'mouseMoved' ? 0 : 1 });
    }
    await sleep(400);
    const panel = await evalJs('(function(){var m=document.getElementById("mask");' +
      'return {open:!m.hidden, title:document.getElementById("sheetTitle").textContent,' +
      'rows:[].slice.call(document.querySelectorAll(".mtask-name")).map(function(n){return n.textContent;})};})()');
    ok('窗口内点日期数字 → 面板打开', panel.open === true, panel.title);
    ok('面板标题 10 月 23 日 · 周五', panel.title === '10 月 23 日 · 周五', panel.title);
    ok('面板 3 行任务', panel.rows.length === 3, JSON.stringify(panel.rows));

    const shot = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(SHOTS + 'tauri-window-panel.png', Buffer.from(shot.data, 'base64'));

    await evalJs('document.getElementById("mask").click()');
    const closed = await evalJs('document.getElementById("mask").hidden');
    ok('关掉面板后回到网格', closed === true);

    // 点任务名不响应
    const tagBox = await evalJs('(function(){var e=document.querySelector(\'.cell[data-date="2026-10-23"] .tag\');' +
      'var r=e.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2};})()');
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
      await send('Input.dispatchMouseEvent', { type: type, x: tagBox.x, y: tagBox.y, button: type === 'mouseMoved' ? 'none' : 'left', clickCount: type === 'mouseMoved' ? 0 : 1 });
    }
    await sleep(400);
    ok('窗口内点任务名 → 面板不打开',
       (await evalJs('document.getElementById("mask").hidden')) === true);

    const shot2 = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(SHOTS + 'tauri-window.png', Buffer.from(shot2.data, 'base64'));

    // ---- 打卡写路径：面板里点任务 → 写 (task_id, period_start) → 整周一起变 → 再点恢复 ----
    console.log('\n[Tauri 窗口 / 面板内打卡]');
    await evalJs('(function(){var e=document.querySelector(\'.cell[data-date="2026-10-23"] .dnum\');' +
      'var r=e.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2};})()');
    const openPanelOn = async date => {
      const box = await evalJs('(function(){var e=document.querySelector(\'.cell[data-date="' + date + '"] .dnum\');' +
        'var r=e.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2};})()');
      for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
        await send('Input.dispatchMouseEvent', { type: type, x: box.x, y: box.y, button: type === 'mouseMoved' ? 'none' : 'left', clickCount: type === 'mouseMoved' ? 0 : 1 });
      }
      await sleep(320);
    };
    const clickTaskRow = async () => {
      const box = await evalJs('(function(){var e=document.querySelector(\'.mtask[data-task="t_fit"]\');' +
        'if(!e) return null; var r=e.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2};})()');
      if (!box) throw new Error('面板里找不到健身那一行');
      for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
        await send('Input.dispatchMouseEvent', { type: type, x: box.x, y: box.y, button: type === 'mouseMoved' ? 'none' : 'left', clickCount: type === 'mouseMoved' ? 0 : 1 });
      }
      await sleep(500);
    };
    const weekState = () => evalJs('(function(){' +
      'var week={};["2026-10-19","2026-10-20","2026-10-21","2026-10-22","2026-10-23"].forEach(function(d){' +
      'var c=document.querySelector(\'.cell[data-date="\'+d+\'"]\');' +
      'week[d]= c ? [].slice.call(c.querySelectorAll(".tag.done .nm")).map(function(n){return n.textContent;}) : null;});' +
      'var row=document.querySelector(\'.mtask[data-task="t_fit"]\');' +
      'var next=document.querySelector(\'.cell[data-date="2026-10-26"]\');' +
      'return {week:week, pressed: row?row.getAttribute("aria-pressed"):null,' +
      'state: row?row.querySelector(".mtask-state").textContent:null,' +
      'period: row?row.dataset.period:null,' +
      'nextWeekDone: next?[].slice.call(next.querySelectorAll(".tag.done .nm")).map(function(n){return n.textContent;}):null};})()');

    await openPanelOn('2026-10-23');
    const seed = await weekState();
    ok('面板里健身那一行可点（button + aria-pressed）', seed.pressed === 'true', 'pressed=' + seed.pressed);
    ok('该行带着 period_start = 2026-10-19（契约 §3.3 打卡键）', seed.period === '2026-10-19', seed.period);
    ok('种子状态：本周健身已完成', seed.state === '已完成', seed.state);

    await clickTaskRow();
    const off = await weekState();
    ok('点一下 → 面板显示未完成', off.state === '未完成' && off.pressed === 'false', off.pressed + '/' + off.state);
    ok('同周期其他天一起变未完成（10-19~10-23 全部没有 done 健身）',
       Object.keys(off.week).every(d => (off.week[d] || []).indexOf('健身') < 0),
       JSON.stringify(off.week));
    ok('下一周（10-26）不受影响', (off.nextWeekDone || []).indexOf('健身') < 0, JSON.stringify(off.nextWeekDone));

    await clickTaskRow();
    const on = await weekState();
    ok('再点一次 → 恢复已完成', on.state === '已完成' && on.pressed === 'true', on.pressed + '/' + on.state);
    ok('整周 5 个工作日都回到已完成', Object.keys(on.week).every(d => (on.week[d] || []).indexOf('健身') >= 0),
       JSON.stringify(on.week));

    const shotPanel = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(SHOTS + 'tauri-window-toggle.png', Buffer.from(shotPanel.data, 'base64'));

    // 设置页：同步状态三件套（地址 / 上次同步 / 待推送 / 最近错误）
    await evalJs('document.getElementById("mask").click()');
    await evalJs('document.getElementById("btnSettings").click()');
    await sleep(500);
    const syncPanel = await evalJs('(function(){' +
      'var rows=[].slice.call(document.querySelectorAll("#setMain .row")).map(function(r){' +
      "return r.innerText.split(String.fromCharCode(10)).join(' ').trim();});" +
      'return {open: !document.getElementById("settingsScreen").hidden, rows: rows,' +
      'url: (document.getElementById("syncUrl")||{}).value || null,' +
      'hasRun: !!document.getElementById("syncRun"),' +
      'hasSave: !!document.getElementById("syncSave")};})()');
    ok('设置页打开且默认在「同步」面板', syncPanel.open === true && syncPanel.hasRun === true);
    ok('同步面板有地址输入框（默认 127.0.0.1:8420）', /^http:\/\/127\.0\.0\.1:8420$/.test(String(syncPanel.url)), String(syncPanel.url));
    ok('同步面板显示 上次同步 / 待推送 / 最近一次错误',
       syncPanel.rows.join('|').indexOf('上次同步') >= 0 &&
       syncPanel.rows.join('|').indexOf('待推送') >= 0 &&
       syncPanel.rows.join('|').indexOf('最近一次错误') >= 0,
       syncPanel.rows.length + ' rows');
    const dirtRow = syncPanel.rows.filter(r => r.indexOf('待推送') >= 0)[0] || '';
    ok('待推送条数存在（数字 + 条）', /\d+ 条/.test(dirtRow), dirtRow);
    const shotSettings = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(SHOTS + 'tauri-window-settings.png', Buffer.from(shotSettings.data, 'base64'));

    // 配置页：规则与任务（契约 §9 起可编辑，不再是只读列表）
    await evalJs('document.getElementById("setBack").click()');
    await evalJs('document.getElementById("btnNew").click()');
    await sleep(400);
    const cfg = await evalJs('(function(){' +
      'var rows=[].slice.call(document.querySelectorAll("#configMain .rule-row"));' +
      'var counts=rows.map(function(r){return parseInt((r.querySelector(".rule-count")||{}).textContent,10)||0;});' +
      'return {open: !document.getElementById("configScreen").hidden, rows: rows.length,' +
      'taskTotal: counts.reduce(function(a,b){return a+b;},0),' +
      'hasNew: !!document.getElementById("newRule"),' +
      'edits: rows.filter(function(r){return !!r.querySelector(\'[data-act="edit"]\');}).length,' +
      'dels: rows.filter(function(r){return !!r.querySelector(\'[data-act="del"]\');}).length};})()');
    ok('配置页列出 4 条规则', cfg.open === true && cfg.rows === 4, 'rows=' + cfg.rows);
    ok('配置页统计到 5 个任务', cfg.taskTotal === 5, 'tasks=' + cfg.taskTotal);
    ok('配置页可编辑：新建 + 每条都有编辑/删除',
       cfg.hasNew === true && cfg.edits === cfg.rows && cfg.dels === cfg.rows,
       JSON.stringify(cfg));
    const shotCfg = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(SHOTS + 'tauri-window-config.png', Buffer.from(shotCfg.data, 'base64'));
    await evalJs('document.getElementById("configDone").click()');

    ok('无 JS 运行时错误', errors.length === 0, errors.slice(0, 2).join(' | '));
  } finally {
    ws.close();
    app.kill();
  }

  console.log('\n结果：' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('验收脚本异常：', e); process.exit(2); });
