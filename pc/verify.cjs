/* Took PC 端前端验收：CDP 驱动 Chrome，对 pc/ui/index.html 做 DOM 断言 + 截图。
   浏览器里没有 Tauri，所以走 mock.js 内置种子（与 Rust 侧同一套种子与同一套语义）。 */
const { spawn } = require('node:child_process');
const { mkdtempSync, writeFileSync, mkdirSync } = require('node:fs');
const { join } = require('node:path');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const UI = 'D:/work/Project/Took/pc/ui/';
const SHOTS = 'D:/work/Project/Took/pc/shots/';
const sleep = ms => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  PASS  ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  ' + extra : '')); }
};

async function openPage(file, width, height) {
  const port = 15000 + Math.floor(Math.random() * 2000);
  const profile = mkdtempSync(join(process.env.TEMP, 'tookpc-'));
  const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=' + port,
    '--user-data-dir=' + profile, '--window-size=' + width + ',' + height, '--hide-scrollbars',
    '--force-device-scale-factor=1', '--no-first-run', '--no-default-browser-check',
    '--allow-file-access-from-files', 'file:///' + UI + file], { stdio: 'ignore' });

  let target = null;
  for (let i = 0; i < 80 && !target; i++) {
    try {
      const r = await fetch('http://127.0.0.1:' + port + '/json/list');
      const list = await r.json();
      const pages = list.filter(t => t.type === 'page' && t.webSocketDebuggerUrl);
      target = pages.find(t => String(t.url || '').indexOf(file) >= 0) || pages[0] || null;
    } catch (e) {}
    if (!target) await sleep(200);
  }
  if (!target) { chrome.kill(); throw new Error('no chrome target'); }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  let seq = 0;
  const pending = new Map();
  const errors = [];
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      errors.push((d.exception && d.exception.description) || d.text);
    }
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') errors.push(m.params.entry.text);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
      if (m.error) p.reject(new Error(JSON.stringify(m.error))); else p.resolve(m.result);
    }
  };
  const send = (method, params) => new Promise((resolve, reject) => {
    const id = ++seq; pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params: params || {} }));
  });
  const evalJs = async expr => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception || {}).description || 'eval error');
    return r.result.value;
  };
  const click = async (x, y) => {
    if (typeof x !== 'number' || typeof y !== 'number') throw new Error('点击坐标无效：' + x + ',' + y);
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x, y: y, button: 'none', clickCount: 0 });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x, y: y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x, y: y, button: 'left', clickCount: 1 });
    await sleep(240);
  };
  const shot = async name => {
    const s = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(SHOTS + name, Buffer.from(s.data, 'base64'));
  };
  /* 真滚轮事件：走 CDP Input.dispatchMouseEvent(type=wheel)，
     不是直接改 scrollTop —— 这样验的是「用户滚一格到底滚多远」 */
  const wheel = async (x, y, deltaY) => {
    await send('Input.dispatchMouseEvent', {
      type: 'mouseWheel', x: x, y: y, deltaX: 0, deltaY: deltaY, button: 'none', clickCount: 0,
    });
    await sleep(260);
  };
  const metrics = async (w, h) => {
    await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
    await sleep(560);
  };

  await send('Runtime.enable'); await send('Log.enable'); await send('Page.enable');
  await send('Page.navigate', { url: 'file:///' + UI + file }).catch(() => {});
  await sleep(1600);
  return { chrome, ws, send, evalJs, click, wheel, shot, metrics, errors, close() { ws.close(); chrome.kill(); } };
}

const boxJs = sel => '(function(){var e=document.querySelector(' + JSON.stringify(sel) + ');' +
  'if(!e) return null; var r=e.getBoundingClientRect();' +
  'return {x:r.x+r.width/2,y:r.y+r.height/2,w:r.width,h:r.height};})()';

(async () => {
  mkdirSync(SHOTS, { recursive: true });
  const p = await openPage('index.html', 1280, 1100);

  try {
    console.log('\n[1] 连续周滚动容器与日期数字');
    const grid = await p.evalJs(`(function(){
      var g=document.getElementById('grid');
      var rows=[].slice.call(g.children);
      var cells=[].slice.call(document.querySelectorAll('#grid .cell'));
      var head=[].slice.call(document.querySelectorAll('#weekHead div')).map(function(d){return d.textContent;});
      var oct1=document.querySelector('.cell[data-date="2026-10-01"]');
      var gt=g.getBoundingClientRect();
      var vis=cells.filter(function(c){var r=c.getBoundingClientRect();
        return r.bottom>gt.top+2 && r.top<gt.bottom-2;});
      return {
        weeks: rows.length,
        n: cells.length,
        firstWeek: rows[0].dataset.week,
        lastWeek: rows[rows.length-1].dataset.week,
        first: cells[0].dataset.date,
        last: cells[cells.length-1].dataset.date,
        firstNum: cells[0].querySelector('.dnum').textContent,
        lastNum: cells[cells.length-1].querySelector('.dnum').textContent,
        head: head,
        title: document.getElementById('calTitle').textContent,
        oct1: oct1 ? oct1.querySelector('.dnum').textContent : null,
        overflowY: getComputedStyle(g).overflowY,
        scrollH: g.scrollHeight, clientH: g.clientHeight, scrollTop: g.scrollTop,
        visFirst: vis[0].dataset.date, visLast: vis[vis.length-1].dataset.date,
        source: document.getElementById('sourceTag').textContent
      };})()`);
    ok('滚动容器 overflow-y:auto', grid.overflowY === 'auto', grid.overflowY);
    ok('内容高于视口（可滚动）', grid.scrollH > grid.clientH + 100, grid.scrollH + ' > ' + grid.clientH);
    ok('周数 ≈ 150（前后各 12 个月 = 25 个月，实测 ' + grid.weeks + ' 周）',
       grid.weeks >= 100 && grid.weeks <= 160, '实际 ' + grid.weeks);
    ok('格子数 = 周数 × 7', grid.n === grid.weeks * 7, grid.n + ' / ' + grid.weeks);
    ok('首周周一 = 2025-09-29（2025-10 的首周，往前 12 个月）', grid.firstWeek === '2025-09-29', grid.firstWeek);
    ok('末周周一 = 2027-10-25（2027-10 的末周，往后 12 个月）', grid.lastWeek === '2027-10-25', grid.lastWeek);
    ok('日期连续无断层（首格 2025-09-29 / 末格 2027-10-31）',
       grid.first === '2025-09-29' && grid.last === '2027-10-31', grid.first + ' → ' + grid.last);
    ok('末格日期数字 = 31', grid.lastNum === '31', grid.lastNum);
    ok('首格是周一（日期数字 29）', grid.firstNum === '29', grid.firstNum);
    ok('周一起始表头', JSON.stringify(grid.head) === JSON.stringify(['周一','周二','周三','周四','周五','周六','周日']),
       grid.head.join(' '));
    ok('启动即定位到本月：标题 = 2026 年 10 月', grid.title === '2026 年 10 月', grid.title);
    ok('启动即定位到本月：可见区间首 = 2026-09-28（10-01 所在周的周一）',
       grid.visFirst === '2026-09-28', grid.visFirst);
    ok('10-01 那格日期数字 = 1', grid.oct1 === '1', String(grid.oct1));
    ok('浏览器兜底数据源已标注', grid.source.indexOf('内置种子') >= 0, grid.source);

    console.log('\n[2] 当月内容：命中日、周期共享、已完成主色');
    const sem = await p.evalJs(`(function(){
      function names(date){var c=document.querySelector('.cell[data-date="'+date+'"]');
        return c ? [].slice.call(c.querySelectorAll('.tag:not(.more) .nm')).map(function(n){return n.textContent;}) : null;}
      function doneNames(date){var c=document.querySelector('.cell[data-date="'+date+'"]');
        return c ? [].slice.call(c.querySelectorAll('.tag.done .nm')).map(function(n){return n.textContent;}) : null;}
      var t=document.querySelector('.cell[data-date="2026-10-23"] .tag.done');
      var cs=t?getComputedStyle(t):null;
      return {
        sun: names('2026-10-04'),
        mon: names('2026-10-05'),
        rent: names('2026-10-20'),
        notRent: names('2026-10-21'),
        week: ['2026-10-19','2026-10-20','2026-10-21','2026-10-22','2026-10-23'].map(doneNames),
        nextWeek: doneNames('2026-10-26'),
        doneColor: cs?cs.color:null,
        doneBg: cs?cs.backgroundColor:null
      };})()`);
    ok('周日（10-04）只有背单词', JSON.stringify(sem.sun) === JSON.stringify(['背单词']), JSON.stringify(sem.sun));
    ok('周一（10-05）三条：背单词/健身/早起',
       JSON.stringify(sem.mon) === JSON.stringify(['背单词','健身','早起']), JSON.stringify(sem.mon));
    ok('10-20 命中交房租（4 条全显示）',
       JSON.stringify(sem.rent) === JSON.stringify(['交房租','背单词','早起','健身']), JSON.stringify(sem.rent));
    ok('10-21 不命中交房租', (sem.notRent||[]).indexOf('交房租') < 0, JSON.stringify(sem.notRent));
    ok('10-19 那周整周「健身」已完成', sem.week.every(function(d){return (d||[]).indexOf('健身')>=0;}),
       JSON.stringify(sem.week));
    ok('10-26 起回到未完成', (sem.nextWeek||[]).indexOf('健身') < 0, JSON.stringify(sem.nextWeek));
    ok('已完成任务用主色系 accent-text', sem.doneColor === 'rgb(217, 96, 15)', String(sem.doneColor));
    ok('已完成底色 accent-weak', sem.doneBg === 'rgb(255, 244, 236)', String(sem.doneBg));
    await p.shot('pc-month-1280-loose.png');

    console.log('\n[3] 三档密度（按卡片宽度切）');
    const dens = async (w, h, expect) => {
      await p.metrics(w, h);
      const r = await p.evalJs(`(function(){
        var card=document.getElementById('calCard').getBoundingClientRect();
        var cells=[].slice.call(document.querySelectorAll('#grid .cell'));
        var maxTags=0, dots=0;
        cells.forEach(function(c){
          var n=c.querySelectorAll('.tag:not(.more)').length;
          if(n>maxTags) maxTags=n;
          if(c.querySelector('.dots')) dots++;
        });
        return {density:document.documentElement.dataset.density, cardW:Math.round(card.width),
                maxTags:maxTags, dotsCells:dots, cells:cells.length,
                rowH:Math.round(document.querySelector('#grid .week').getBoundingClientRect().height)};})()`);
      ok('宽度 ' + w + ' → ' + expect.density, r.density === expect.density,
         'cardW=' + r.cardW + ' density=' + r.density);
      ok('  每格任务名 ≤ ' + expect.tags, r.maxTags <= expect.tags, 'maxTags=' + r.maxTags);
      if (expect.dots) ok('  紧凑档有圆点排', r.dotsCells > 0, 'dotsCells=' + r.dotsCells);
      else ok('  标准/宽松档无圆点排', r.dotsCells === 0, 'dotsCells=' + r.dotsCells);
      return r;
    };
    await dens(1280, 1100, { density: 'loose', tags: 4, dots: false });
    await dens(900, 900, { density: 'standard', tags: 2, dots: false });
    await p.shot('pc-month-900-standard.png');
    await dens(620, 900, { density: 'compact', tags: 1, dots: true });
    await p.shot('pc-month-620-compact.png');

    await p.metrics(1280, 1000);
    console.log('\n[4] 点日期数字开面板 / 点任务名无反应');
    const numBox = await p.evalJs(boxJs('.cell[data-date="2026-10-23"] .dnum'));
    await p.click(numBox.x, numBox.y);
    const st = await p.evalJs(`(function(){
      var m=document.getElementById('mask');
      return {open:!m.hidden, title:document.getElementById('sheetTitle').textContent,
              rows:[].slice.call(document.querySelectorAll('.mtask')).map(function(r){
                return r.querySelector('.mtask-name').textContent+':'+r.querySelector('.mtask-state').textContent;}),
              groups:[].slice.call(document.querySelectorAll('.sgroup-head b')).map(function(b){return b.textContent;}),
              date:m.dataset.date||null};})()`);
    ok('点日期数字 → 面板打开', st.open === true, 'date=' + st.date);
    ok('面板标题 = 10 月 23 日 · 周五', st.title === '10 月 23 日 · 周五', st.title);
    ok('面板列出 3 项、其中 1 项已完成',
       st.rows.length === 3 && st.rows.filter(function(r){return r.indexOf('已完成')>=0;}).length === 1,
       JSON.stringify(st.rows));
    ok('面板按规则分组', st.groups.length === 2, JSON.stringify(st.groups));
    await p.shot('pc-panel-1023.png');

    const closeBox = await p.evalJs(boxJs('#sheetClose'));
    await p.click(closeBox.x, closeBox.y);
    ok('点关闭 → 面板隐藏', (await p.evalJs('document.getElementById("mask").hidden')) === true);

    const tagBox = await p.evalJs(boxJs('.cell[data-date="2026-10-23"] .tag'));
    await p.click(tagBox.x, tagBox.y);
    const afterTag = await p.evalJs('(function(){var m=document.getElementById("mask");' +
      'return {open:!m.hidden, date:m.dataset.date||null};})()');
    ok('点任务名 → 面板不打开', afterTag.open === false, 'open=' + afterTag.open + ' date=' + afterTag.date);

    const blank = await p.evalJs('(function(){var c=document.querySelector(".cell[data-date=\\"2026-10-23\\"]");' +
      'var r=c.getBoundingClientRect(); return {x:r.right-6,y:r.bottom-4};})()');
    await p.click(blank.x, blank.y);
    ok('点格子空白 → 面板打开',
       (await p.evalJs('!document.getElementById("mask").hidden')) === true);
    await p.evalJs('document.getElementById("mask").click()');
    ok('点遮罩 → 面板关闭', (await p.evalJs('document.getElementById("mask").hidden')) === true);

    console.log('\n[4.1] 兜底数据源也能打卡（mock.js 与 Rust 同语义）');
    const panelNum = await p.evalJs(boxJs('.cell[data-date="2026-10-23"] .dnum'));
    await p.click(panelNum.x, panelNum.y);
    const rowBox = await p.evalJs(boxJs('.mtask[data-task="t_fit"]'));
    await p.click(rowBox.x, rowBox.y);
    await sleep(350);
    const weekState = async () => p.evalJs('(function(){' +
      'var out={};["2026-10-19","2026-10-20","2026-10-21","2026-10-22","2026-10-23"].forEach(function(d){' +
      'var c=document.querySelector(\'.cell[data-date="\'+d+\'"]\');' +
      'out[d]=c?[].slice.call(c.querySelectorAll(".tag.done .nm")).map(function(n){return n.textContent;}):null;});' +
      'var row=document.querySelector(\'.mtask[data-task="t_fit"]\');' +
      'return {week:out, state:row?row.querySelector(".mtask-state").textContent:null,' +
      'period:row?row.dataset.period:null};})()');
    const off = await weekState();
    ok('面板点任务 → 未完成（mock 写路径生效）', off.state === '未完成', off.state + ' period=' + off.period);
    ok('同周期其他天一起变',
       Object.keys(off.week).every(function (d) { return (off.week[d] || []).indexOf('健身') < 0; }),
       JSON.stringify(off.week));
    const rowBox2 = await p.evalJs(boxJs('.mtask[data-task="t_fit"]'));
    await p.click(rowBox2.x, rowBox2.y);
    await sleep(350);
    const on = await weekState();
    ok('再点一次 → 恢复已完成', on.state === '已完成', on.state);
    ok('整周 5 个工作日都回到已完成',
       Object.keys(on.week).every(function (d) { return (on.week[d] || []).indexOf('健身') >= 0; }),
       JSON.stringify(on.week));
    await p.evalJs('document.getElementById("mask").click()');

    console.log('\n[5] ‹ › 是平滑滚动到上/下月第一周（不是替换整屏）');
    const before = await p.evalJs(`(function(){
      var g=document.getElementById('grid');
      return {top:Math.round(g.scrollTop), title:document.getElementById('calTitle').textContent,
              rows:g.children.length};})()`);
    // 用 scroll 事件采样：动画会有多个不同的中间位置，瞬移只会有一个
    await p.evalJs('(function(){ window.__tops=[]; var g=document.getElementById("grid");' +
      ' g.addEventListener("scroll", function(){ window.__tops.push(Math.round(g.scrollTop)); });' +
      ' return true; })()');
    const prevBox = await p.evalJs(boxJs('#prevBtn'));
    await p.click(prevBox.x, prevBox.y);
    await sleep(800);
    const tops = await p.evalJs('window.__tops.slice()');
    const distinct = tops.filter((v, i) => i === 0 || v !== tops[i - 1]);
    const sep = await p.evalJs(`(function(){
      var g=document.getElementById('grid');
      var rows=[].slice.call(g.children);
      var gt=g.getBoundingClientRect();
      var vis=[].slice.call(document.querySelectorAll('#grid .cell')).filter(function(c){
        var r=c.getBoundingClientRect(); return r.bottom>gt.top+2 && r.top<gt.bottom-2;});
      return {title:document.getElementById('calTitle').textContent, top:Math.round(g.scrollTop),
              rows:rows.length, visFirst:vis[0].dataset.date, visLast:vis[vis.length-1].dataset.date,
              rent:[].slice.call(document.querySelectorAll('.cell[data-date="2026-09-20"] .nm')).map(function(n){return n.textContent;})};})()`);
    ok('上一月标题 = 2026 年 9 月', sep.title === '2026 年 9 月', sep.title);
    ok('周数不变（滚动而非替换，仍是 ' + before.rows + ' 周）', sep.rows === before.rows, String(sep.rows));
    ok('‹ 是平滑滚动：scroll 事件采到 ' + distinct.length + ' 个不同位置（瞬移只会是 1 个）',
       distinct.length >= 3, JSON.stringify(distinct.slice(0, 12)));
    ok('滚到 9 月第一周（可见首 = 2026-08-31）', sep.visFirst === '2026-08-31', sep.visFirst);
    ok('9 月 20 日命中交房租', sep.rent.indexOf('交房租') >= 0, JSON.stringify(sep.rent));
    await p.shot('pc-month-2026-09.png');

    console.log('\n[5.1] › 回到 10 月 + 回到今天');
    const nextBox = await p.evalJs(boxJs('#nextBtn'));
    await p.click(nextBox.x, nextBox.y);
    await sleep(700);
    const back = await p.evalJs(`(function(){
      var g=document.getElementById('grid'); var gt=g.getBoundingClientRect();
      var vis=[].slice.call(document.querySelectorAll('#grid .cell')).filter(function(c){
        var r=c.getBoundingClientRect(); return r.bottom>gt.top+2 && r.top<gt.bottom-2;});
      return {title:document.getElementById('calTitle').textContent, visFirst:vis[0].dataset.date};})()`);
    ok('› 平滑滚回 2026 年 10 月', back.title === '2026 年 10 月', back.title);
    ok('回到 10 月第一周（可见首 = 2026-09-28）', back.visFirst === '2026-09-28', back.visFirst);

    await p.evalJs('document.getElementById("grid").scrollTo({top:0})');
    await sleep(300);
    const todayBox = await p.evalJs(boxJs('#todayBtn'));
    await p.click(todayBox.x, todayBox.y);
    await sleep(800);
    const tod = await p.evalJs(`(function(){
      var g=document.getElementById('grid'); var gt=g.getBoundingClientRect();
      var vis=[].slice.call(document.querySelectorAll('#grid .cell')).filter(function(c){
        var r=c.getBoundingClientRect(); return r.bottom>gt.top+2 && r.top<gt.bottom-2;});
      var t=document.querySelector('#grid .dnum.today');
      return {title:document.getElementById('calTitle').textContent, visFirst:vis[0].dataset.date,
              todayVisible: !!t, todayText: t?t.textContent:null};})()`);
    ok('「回到今天」滚回今天所在月', tod.title === '2026 年 10 月', tod.title);
    ok('今天那格在视口内', tod.todayVisible === true, 'today=' + tod.todayText);
    await p.shot('pc-today-scroll.png');

    console.log('\n[6] 滚轮滚一格 ≈ 1 行（不是整月跳）');
    const geom = async () => p.evalJs(`(function(){
      var g=document.getElementById('grid'); var gt=g.getBoundingClientRect();
      var vis=[].slice.call(document.querySelectorAll('#grid .cell')).filter(function(c){
        var r=c.getBoundingClientRect(); return r.bottom>gt.top+2 && r.top<gt.bottom-2;});
      return {top:Math.round(g.scrollTop), rowH:Math.round(g.children[0].getBoundingClientRect().height),
              gap:Math.round(g.children[1].getBoundingClientRect().top - g.children[0].getBoundingClientRect().bottom),
              first:vis[0].dataset.date, last:vis[vis.length-1].dataset.date,
              title:document.getElementById('calTitle').textContent,
              box:(function(){var r=g.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()};})()`);
    const g0 = await geom();
    const step = g0.rowH + g0.gap;
    await p.wheel(g0.box.x, g0.box.y, 100);      // 一格滚轮 = 100px
    const g1 = await geom();
    const movedRows = (g1.top - g0.top) / step;
    ok('滚轮 deltaY=100 的位移 = ' + (g1.top - g0.top) + 'px ≈ ' + movedRows.toFixed(2) + ' 行（要求 1~2 行）',
       movedRows >= 0.9 && movedRows <= 2.0, movedRows.toFixed(2) + ' 行');
    ok('不是整月跳（位移 < 一屏 ' + Math.round(step * 6) + 'px）',
       (g1.top - g0.top) < step * 6, (g1.top - g0.top) + 'px');
    ok('可见日期区间只前进 1~2 行：' + g0.first + ' → ' + g1.first,
       g1.first > g0.first, g0.first + ' → ' + g1.first);
    await p.wheel(g0.box.x, g0.box.y, 100);
    const g2 = await geom();
    ok('再滚一格再前进 1~2 行：' + g1.first + ' → ' + g2.first, g2.first > g1.first, g2.first);
    // 标题必须跟着「视口顶部那一周」走，而不是停在旧月份
    const titleMonth = g2.title.replace(/\D/g, '');
    const topMonth = g2.first.slice(0, 7).replace('-', '').replace(/^0/, '');
    ok('滚两格后标题 = 顶部那一周所属月份（' + g2.title + ' vs 顶部 ' + g2.first + '）',
       g2.title === (g2.first.slice(0, 4) + ' 年 ' + Number(g2.first.slice(5, 7)) + ' 月'),
       g2.title + ' / ' + g2.first);
    await p.shot('cal-head-buttons.png');

    console.log('\n[6.1] 跨月无缝：滚到 10 月末继续滚');
    await p.evalJs(`(function(){
      var g=document.getElementById('grid');
      var rows=[].slice.call(g.children);
      var step=Math.round(rows[0].getBoundingClientRect().height +
        (rows[1].getBoundingClientRect().top - rows[0].getBoundingClientRect().bottom));
      var i=rows.findIndex(function(r){return r.dataset.week==='2026-10-26';});
      g.scrollTo({top:i*step}); return {i:i, step:step};})()`);
    await sleep(400);
    const cross = await p.evalJs(`(function(){
      var g=document.getElementById('grid'); var gt=g.getBoundingClientRect();
      var rows=[].slice.call(g.children).filter(function(r){
        var b=r.getBoundingClientRect(); return b.bottom>gt.top+2 && b.top<gt.bottom-2;});
      var row=rows.filter(function(r){return r.dataset.week==='2026-10-26';})[0];
      var dates=row?[].slice.call(row.children).map(function(c){return c.dataset.date;}):null;
      var nums=row?[].slice.call(row.querySelectorAll('.dnum')).map(function(n){return n.textContent;}):null;
      return {weeks:rows.map(function(r){return r.dataset.week;}),
              crossDates:dates, crossNums:nums,
              title:document.getElementById('calTitle').textContent};})()`);
    ok('能看到跨月周 10/26~11/01 这一行',
       JSON.stringify(cross.crossDates) === JSON.stringify(
         ['2026-10-26','2026-10-27','2026-10-28','2026-10-29','2026-10-30','2026-10-31','2026-11-01']),
       JSON.stringify(cross.crossDates));
    ok('跨月行日期数字连续 26,27,28,29,30,31,1',
       JSON.stringify(cross.crossNums) === JSON.stringify(['26','27','28','29','30','31','1']),
       JSON.stringify(cross.crossNums));
    ok('跨月周归 10 月（标题仍是 2026 年 10 月）', cross.title === '2026 年 10 月', cross.title);
    await p.shot('cal-scroll-crossmonth.png');

    // 继续往下滚 → 标题变 11 月（标题跟随滚动位置）
    const beforeTitle = cross.title;
    await p.wheel(g0.box.x, g0.box.y, 100);
    await sleep(300);
    const afterCross = await geom();
    const expectTitle = afterCross.first.slice(0, 4) + ' 年 ' + Number(afterCross.first.slice(5, 7)) + ' 月';
    ok('继续往下滚 → 标题跟随顶部那一周所属月份（' + beforeTitle + ' → ' + afterCross.title +
       '，顶部 ' + afterCross.first + '）',
       afterCross.title === expectTitle && afterCross.title !== beforeTitle,
       afterCross.title + ' / ' + expectTitle);
    ok('滚动位置确实前进了（' + g0.top + ' → ' + afterCross.top + '）',
       afterCross.top > g0.top, afterCross.top + 'px');
    ok('跨月后可见区间已进入 11 月（顶部 ' + afterCross.first + '）',
       afterCross.first > '2026-10-31', afterCross.first);

    console.log('\n[7] 控制台');
    ok('无 JS 运行时错误', p.errors.length === 0, p.errors.slice(0, 3).join(' | '));
  } finally {
    p.close();
  }

  console.log('\n结果：' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('验收脚本异常：', e); process.exit(2); });
