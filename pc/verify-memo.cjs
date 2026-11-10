/* 记事 / 倒数日 / 笔记本的编辑入口验收（契约 §10.3 M1~M5 的界面侧）。
   两种模式：
     node verify-memo.cjs          浏览器 + mock.js（快速迭代，无真实库）
     node verify-memo.cjs --tauri  真窗口 + WebView2 CDP（写真实 SQLite）
   断言一律走真 DOM 与真命令；收尾把新建的三条软删干净，不给下轮留脏数据。 */
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
    const PORT = 9344;
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
    const port = 15500 + Math.floor(Math.random() * 1500);
    const profile = mkdtempSync(join(process.env.TEMP, 'tookmemo-'));
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
  await send('Runtime.enable');
  await sleep(TAURI ? 2400 : 1400);

  const STAMP = Date.now().toString().slice(-6);
  const NOTE = '出差安排 ' + STAMP;
  const COUNT = '项目验收 ' + STAMP;
  const BOOK = '晨间流程 ' + STAMP;
  const CAT = '习惯' + STAMP;
  const J = JSON.stringify;

  await evalJs("(function(){ window.__T = {" +
    " click: function(sel){ var el=document.querySelector(sel); if(!el) throw new Error('找不到 '+sel); el.click(); return true; }," +
    " rows: function(){ return [].slice.call(document.querySelectorAll('#memoList .memo-row')).map(function(r){ return (r.querySelector('b')||{}).textContent; }); }," +
    " rowByTitle: function(t){ var rows=[].slice.call(document.querySelectorAll('#memoList .memo-row')); return rows.filter(function(r){ return ((r.querySelector('b')||{}).textContent||'').indexOf(t)===0; })[0]||null; }," +
    " dayMemos: function(d){ var c=document.querySelector('.cell[data-date=\"'+d+'\"]'); return c?[].slice.call(c.querySelectorAll('.tag.memo .nm')).map(function(n){return n.textContent;}):null; }," +
    " memoDays: function(){ var out={}; [].slice.call(document.querySelectorAll('#grid .cell')).forEach(function(c){ var ms=[].slice.call(c.querySelectorAll('.tag.memo .nm')).map(function(n){return n.textContent;}); if(ms.length) out[c.dataset.date]=ms; }); return out; }," +
    " setTitle: function(v){ var el=document.getElementById('bookTitle'); el.textContent=v; el.dispatchEvent(new Event('input',{bubbles:true})); return el.textContent; }," +
    " setBody: function(v){ var el=document.getElementById('bookBody'); el.value=v; el.dispatchEvent(new Event('input',{bubbles:true})); return el.value; }," +
    " setStart: function(v){ var el=document.getElementById('bookStart'); el.value=v; el.dispatchEvent(new Event('change',{bubbles:true})); return el.value; }," +
    " setEnd: function(v){ var el=document.getElementById('bookEnd'); el.value=v; el.dispatchEvent(new Event('change',{bubbles:true})); return el.value; }," +
    " nav: function(tab){ var b=document.querySelector('#configNav button[data-tab=\"'+tab+'\"]'); if(!b) throw new Error('没有导航 '+tab); b.click(); return true; }," +
    " deleteRow: function(t){ var rows=[].slice.call(document.querySelectorAll('#memoList .memo-row')); var r=rows.filter(function(x){ return ((x.querySelector('b')||{}).textContent||'').indexOf(t)===0; })[0]; if(!r) return false; r.querySelector('button[data-memo-act=\"del\"]').click(); return true; }," +
    " openRow: function(t){ var rows=[].slice.call(document.querySelectorAll('#memoList .memo-row')); var r=rows.filter(function(x){ return ((x.querySelector('b')||{}).textContent||'').indexOf(t)===0; })[0]; if(!r) return false; r.querySelector('.memo-main').click(); return true; }" +
    " }; return true; })()");

  try {
    console.log('\n[0] 数据源');
    console.log('  ' + await evalJs("document.getElementById('sourceTag').textContent"));

    console.log('\n[M1] 新建记事（不排期）');
    await evalJs("window.__T.click('#btnNew')");
    await sleep(350);
    ok('配置页有「记事」分类', await evalJs("!!document.querySelector('#configNav button[data-tab=\"note\"]')"));
    await evalJs("window.__T.nav('note')");
    await sleep(300);
    ok('记事页有「＋ 新建记事」', await evalJs("!!document.getElementById('newMemo')"));
    await evalJs("window.__T.click('#newMemo')");
    await sleep(350);
    ok('点新建 → 打开文档式全屏页', await evalJs("document.getElementById('bookScreen').hidden === false"));
    ok('大号标题 28px + 无边框正文', await evalJs("(function(){ var t=document.getElementById('bookTitle'), b=document.getElementById('bookBody'); var cs=getComputedStyle(t), bs=getComputedStyle(b); return Math.round(parseFloat(cs.fontSize))===28 && bs.borderTopWidth==='0px' && bs.borderLeftWidth==='0px'; })()"));
    ok('记事顶栏显示日期区间两个输入', await evalJs("(function(){ return document.getElementById('bookRange').hidden===false && !!document.getElementById('bookStart') && !!document.getElementById('bookEnd'); })()"));
    await evalJs("window.__T.setTitle(" + J(NOTE) + ")");
    await sleep(1200);
    const savedM1 = await evalJs("document.getElementById('bookSaved').textContent");
    ok('600ms 静默自动保存生效', String(savedM1).indexOf('已保存') >= 0, savedM1);
    ok('元信息显示「未排期」', await evalJs("document.getElementById('bookTime').textContent === '未排期'"));
    const rowsM1 = await evalJs("window.__T.rows()");
    ok('列表能看到这条记事', rowsM1.some(t => t && t.indexOf(NOTE) === 0), rowsM1);
    const daysM1 = await evalJs("window.__T.memoDays()");
    ok('不排期的记事在月历任何一天都不出现', Object.keys(daysM1).length === 0, daysM1);
    await evalJs("window.__T.click('#bookBack')");
    await sleep(300);

    console.log('\n[M2] 改成时间段 2026-10-27 ~ 2026-10-29');
    ok('点行能重新进入编辑页', await evalJs("window.__T.openRow(" + J(NOTE) + ")"));
    await sleep(350);
    await evalJs("window.__T.setStart('2026-10-27')");
    await evalJs("window.__T.setEnd('2026-10-29')");
    await sleep(1200);
    const metaM2 = await evalJs("document.getElementById('bookTime').textContent");
    ok('元信息变成 10/27 ~ 10/29', metaM2 === '10/27 ~ 10/29', metaM2);
    await evalJs("window.__T.click('#bookBack')");
    await sleep(1400);
    const d27 = await evalJs("window.__T.dayMemos('2026-10-27')");
    const d28 = await evalJs("window.__T.dayMemos('2026-10-28')");
    const d29 = await evalJs("window.__T.dayMemos('2026-10-29')");
    const d26 = await evalJs("window.__T.dayMemos('2026-10-26')");
    const d30 = await evalJs("window.__T.dayMemos('2026-10-30')");
    ok('10/27 出现该记事', (d27 || []).some(t => t.indexOf(NOTE) === 0), d27);
    ok('10/28 出现该记事', (d28 || []).some(t => t.indexOf(NOTE) === 0), d28);
    ok('10/29 出现该记事', (d29 || []).some(t => t.indexOf(NOTE) === 0), d29);
    ok('10/26 不出现（区间外）', !(d26 || []).some(t => t.indexOf(NOTE) === 0), d26);
    ok('10/30 不出现（区间外）', !(d30 || []).some(t => t.indexOf(NOTE) === 0), d30);

    console.log('\n[M3] 新建倒数日（普通表单）');
    await evalJs("window.__T.click('#btnNew')");
    await sleep(300);
    await evalJs("window.__T.nav('countdown')");
    await sleep(300);
    await evalJs("window.__T.click('#newMemo')");
    await sleep(300);
    ok('倒数日走普通表单（不是文档式页）', await evalJs("(function(){ return document.getElementById('memoMask').hidden === false && document.getElementById('bookScreen').hidden === true; })()"));
    await evalJs("(function(){ document.getElementById('mTitle').value = " + J(COUNT) + "; document.getElementById('mDate').value = '2027-03-15'; document.getElementById('mNote').value = '提前一周准备材料'; document.getElementById('memoSave').click(); return true; })()");
    await sleep(700);
    const rowsM3 = await evalJs("window.__T.rows()");
    ok('列表能看到这条倒数日', rowsM3.some(t => t && t.indexOf(COUNT) === 0), rowsM3);
    const subM3 = await evalJs("(function(){ var r=window.__T.rowByTitle(" + J(COUNT) + "); return r?r.querySelector('i').textContent:null; })()");
    ok('列表显示目标日与天数差', !!subM3 && subM3.indexOf('2027/03/15') >= 0 && subM3.indexOf('还有') >= 0, subM3);
    const allDaysM3 = await evalJs("window.__T.memoDays()");
    const countLeak = Object.keys(allDaysM3).filter(d => allDaysM3[d].some(t => t.indexOf(COUNT) === 0));
    ok('倒数日不进月历', countLeak.length === 0, countLeak);

    console.log('\n[M4] 新建笔记本（分类「' + CAT + '」）');
    await evalJs("window.__T.nav('notebook')");
    await sleep(300);
    await evalJs("window.__T.click('#newMemo')");
    await sleep(350);
    ok('笔记本用文档式全屏页', await evalJs("document.getElementById('bookScreen').hidden === false"));
    ok('笔记本顶栏显示分类 chip、没有日期输入', await evalJs("(function(){ return document.getElementById('bookCat').hidden === false && document.getElementById('bookRange').hidden === true; })()"));
    await evalJs("window.__T.setTitle(" + J(BOOK) + ")");
    await evalJs("window.__T.setBody('喝水 / 拉伸 / 记账')");
    await sleep(1200);
    const words = await evalJs("document.getElementById('bookWords').textContent");
    ok('正文字数实时统计（空白不计，8 字）', words === '8 字', words);
    await evalJs("window.__T.click('#bookCat')");
    await sleep(250);
    ok('点分类 chip → 打开分类选择层', await evalJs("document.getElementById('bookPickerMask').hidden === false"));
    await evalJs("(function(){ document.getElementById('bookNewCat').value = " + J(CAT) + "; document.getElementById('bookNewCatBtn').click(); return true; })()");
    await sleep(1200);
    const chip = await evalJs("document.getElementById('bookCat').textContent");
    ok('新建分类后 chip 变成新分类', chip === CAT, chip);
    await evalJs("window.__T.click('#bookBack')");
    await sleep(500);
    const bookRow = await evalJs("(function(){ var r=window.__T.rowByTitle(" + J(BOOK) + "); if(!r) return null; var is=r.querySelectorAll('i'); return {title:(r.querySelector('b')||{}).textContent, cat:(r.querySelector('.memo-cat')||{}).textContent, sub:is[is.length-1].textContent}; })()");
    ok('列表能看到这条笔记本', !!bookRow, bookRow);
    ok('笔记本分类正确落库', !!bookRow && bookRow.cat === CAT, bookRow && bookRow.cat);

    console.log('\n[M5] 删除记事（二次确认）');
    await evalJs("window.__T.nav('note')");
    await sleep(300);
    ok('点删除 → 弹二次确认', await evalJs("window.__T.deleteRow(" + J(NOTE) + ")"));
    await sleep(300);
    const cText = await evalJs("document.getElementById('confirmText').textContent");
    ok('确认框不提「打卡历史保留」', await evalJs("document.getElementById('confirmMask').hidden === false && document.getElementById('confirmText').textContent.indexOf('历史') < 0"), cText);
    await evalJs("document.getElementById('confirmOk').click()");
    await sleep(1000);
    const afterDel = await evalJs("window.__T.rows()");
    ok('删除后列表不再显示它', !afterDel.some(t => t && t.indexOf(NOTE) === 0), afterDel);
    const daysAfter = await evalJs("window.__T.dayMemos('2026-10-27')");
    ok('删除后月历也不再出现', !(daysAfter || []).some(t => t.indexOf(NOTE) === 0), daysAfter);

    console.log('\n[清理] 删掉本轮新建的倒数日与笔记本');
    for (const [tab, title] of [['countdown', COUNT], ['notebook', BOOK]]) {
      await evalJs("window.__T.nav('" + tab + "')");
      await sleep(300);
      const found = await evalJs("window.__T.deleteRow(" + J(title) + ")");
      if (!found) { ok('清理 ' + tab, false, '找不到行'); continue; }
      await sleep(300);
      await evalJs("document.getElementById('confirmOk').click()");
      await sleep(800);
      const left = await evalJs("window.__T.rows()");
      ok('清理 ' + tab + '：列表已不含它', !left.some(t => t && t.indexOf(title) === 0), left);
    }

    console.log('\n[控制台]');
    ok('无 JS 运行时错误', errors.length === 0, errors.slice(0, 3));

    try {
      const shot = await send('Page.captureScreenshot', { format: 'png' });
      writeFileSync(SHOTS + (TAURI ? 'tauri-memo.png' : 'pc-memo.png'), Buffer.from(shot.data, 'base64'));
    } catch (e) { console.log('  截图失败：' + e.message); }
  } finally {
    console.log('\n结果：' + pass + ' passed, ' + fail + ' failed');
    try { proc.kill(); } catch (e) {}
    process.exit(fail ? 1 : 0);
  }
})();
