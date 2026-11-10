/* P2 笔记页增强 + FAB 的真窗口验收（took.exe + WebView2 CDP）。
   断言全部走真 DOM 与真后端命令；截图落 pc/shots/。
   运行：node verify-misc.cjs  （需要先 build 过，前端资源是编译期嵌入 exe 的） */
const { spawn } = require('node:child_process');
const { mkdirSync, writeFileSync } = require('node:fs');

const EXE = 'D:/work/Project/Took/pc/src-tauri/target/debug/took.exe';
const SHOTS = 'D:/work/Project/Took/pc/shots/';
const PORT = 9355;
const sleep = ms => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  PASS  ' + name + (extra !== undefined ? '  ' + JSON.stringify(extra) : '')); }
  else { fail++; console.log('  FAIL  ' + name + (extra !== undefined ? '  ' + JSON.stringify(extra) : '')); }
};

(async () => {
  mkdirSync(SHOTS, { recursive: true });
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
      const list = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json();
      target = list.filter(t => t.type === 'page' && t.webSocketDebuggerUrl)[0] || null;
    } catch (e) {}
    if (!target) await sleep(250);
  }
  if (!target) { console.log('连不上 WebView2 调试端口；应用输出：\n' + out); app.kill(); process.exit(2); }

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
  /* 等 app.js 真的渲染完（月历格子出现 + 数据源确定），别在绑定还没完成时断言 */
  let ready = false;
  for (let i = 0; i < 60 && !ready; i++) {
    try {
      ready = await evalJs("document.querySelectorAll('#grid .cell').length > 100 &&" +
        " document.getElementById('sourceTag').textContent.indexOf('—') < 0");
    } catch (e) {}
    if (!ready) await sleep(300);
  }
  await sleep(600);

  const STAMP = Date.now().toString().slice(-6);
  const BOOK_A = '周会记录 ' + STAMP;
  const BOOK_B = '读书笔记 ' + STAMP;
  const CAT_A = '工作' + STAMP;
  const CAT_B = '读书' + STAMP;
  const J = JSON.stringify;

  const click = async sel => evalJs("(function(){ var el=document.querySelector(" + J(sel) + "); if(!el) throw new Error('找不到 '+ " + J(sel) + "); el.click(); return true; })()");
  const clickNav = async tab => {
    const sel = '#configNav button[data-tab="' + tab + '"]';
    return evalJs("(function(){ var b=document.querySelector(" + JSON.stringify(sel) + ");" +
      " if(!b) throw new Error('没有导航 ' + " + JSON.stringify(tab) + "); b.click(); return true; })()");
  };

  /* 用行标题找 .memo-row */
  const LIST = '#mgrRoot .memo-row';
  const openRow = async t => evalJs("(function(){ var rows=[].slice.call(document.querySelectorAll('#memoList .memo-row'));" +
    " var r=rows.filter(function(x){ return ((x.querySelector('b')||{}).textContent||'').indexOf(" + J(t) + ")===0; })[0];" +
    " if(!r) return false; r.querySelector('.memo-main').click(); return true; })()");

  try {
    console.log('\n[0] 数据源');
    console.log('  ' + await evalJs("document.getElementById('sourceTag').textContent"));

    /* ---------------- ⑤ FAB（先测：它只在日历页可见） ---------------- */
    console.log('\n[F] FAB 悬浮按钮');
    const fabCal = await evalJs("(function(){ var f=document.getElementById('mgrFab'); if(!f) return null;" +
      " var r=f.getBoundingClientRect(), cs=getComputedStyle(f);" +
      " return {hidden:f.hidden, count:document.querySelectorAll('.fab').length," +
      "   w:Math.round(r.width), h:Math.round(r.height), radius:cs.borderRadius," +
      "   bg:cs.backgroundColor, right:Math.round(window.innerWidth-r.right), bottom:Math.round(window.innerHeight-r.bottom)," +
      "   isCircle: Math.round(r.width)===Math.round(r.height) && parseFloat(cs.borderRadius)>=r.width/2-1," +
      "   parent: f.parentNode && f.parentNode.tagName}; })()");
    ok('日历页有且只有一个 FAB（与 T3 共用同一个 #mgrFab）', !!fabCal && fabCal.count === 1 && fabCal.parent === 'BODY', fabCal && { count: fabCal.count, parent: fabCal.parent });
    ok('FAB 在日历页可见', !!fabCal && fabCal.hidden === false);
    ok('FAB 是右下角橙色圆形（56×56，距右/下 ~34px）',
      !!fabCal && fabCal.isCircle && fabCal.w === 56 && fabCal.h === 56 &&
      fabCal.right >= 20 && fabCal.right <= 60 && fabCal.bottom >= 20 && fabCal.bottom <= 60,
      fabCal && { size: fabCal.w + 'x' + fabCal.h, right: fabCal.right, bottom: fabCal.bottom, bg: fabCal.bg });
    await shot('fab.png');

    /* 点 FAB → 打开管理页并定位到「新建」 */
    await click('.fab');
    await sleep(500);
    const afterFab = await evalJs("(function(){ return {" +
      " cfg: document.getElementById('configScreen').hidden === false," +
      " form: document.getElementById('formMask').hidden === false," +
      " formTitle: (document.getElementById('formTitle')||{}).textContent || ''," +
      " fabDisplay: getComputedStyle(document.getElementById('mgrFab')).display }; })()");
    ok('点 FAB → 打开管理页', afterFab.cfg === true, afterFab);
    ok('点 FAB → 定位到「新建」（规则表单已弹出）', afterFab.form === true && /新建/.test(afterFab.formTitle), afterFab.formTitle);
    ok('管理页里 FAB 仍可见（T3 用它当「新建<分类>」，同一个按钮）', afterFab.fabDisplay !== 'none', afterFab.fabDisplay);
    /* 管理页里再点一次：应由 mgr.js 接走（新建当前分类），不能把管理页重新打开一遍 */
    const beforeRefab = await evalJs("document.getElementById('formTitle').textContent");
    await evalJs("document.getElementById('formClose').click()");
    await sleep(400);
    await evalJs("document.getElementById('mgrFab').click()");
    await sleep(600);
    const refab = await evalJs("(function(){ return {form:document.getElementById('formMask').hidden===false," +
      " title:document.getElementById('formTitle').textContent," +
      " cfg:document.getElementById('configScreen').hidden===false}; })()");
    ok('管理页里点 FAB 由 T3 接走（新建当前分类，不重开管理页）',
      refab.cfg === true && refab.form === true && refab.title === beforeRefab, refab);
    /* 关掉表单与配置页 */
    await evalJs("(function(){ var c=document.getElementById('formClose'); if(c) c.click(); return true; })()");
    await sleep(300);
    await evalJs("(function(){ var b=document.getElementById('configDone'); if(b) b.click(); return true; })()");
    await sleep(400);

    /* ---------------- 建两条不同分类的笔记（供筛选用） ---------------- */
    console.log('\n[准备] 建两条不同分类的笔记本');
    const makeBook = async (title, cat, body) => {
      await click('#btnNew'); await sleep(350);
      await clickNav('notebook'); await sleep(300);
      await click('#newMemo'); await sleep(400);
      await evalJs("(function(){ var el=document.getElementById('bookTitle'); el.textContent=" + J(title) + ";" +
        " el.dispatchEvent(new Event('input',{bubbles:true})); return true; })()");
      await evalJs("(function(){ var el=document.getElementById('bookBody'); el.value=" + J(body) + ";" +
        " el.dispatchEvent(new Event('input',{bubbles:true})); return true; })()");
      await sleep(500);
      /* 新建分类（走 ④ 的输入框） */
      await click('#bookCat'); await sleep(300);
      await click('#bookNewCatOpen'); await sleep(200);
      await evalJs("(function(){ var i=document.getElementById('bookNewCatInput'); i.value=" + J(cat) + ";" +
        " i.dispatchEvent(new Event('input',{bubbles:true})); return i.value; })()");
      await click('#bookNewCatBtn'); await sleep(1400);
      await click('#bookBack'); await sleep(600);
    };
    await makeBook(BOOK_A, CAT_A, '本周进度\n  前端\n    笔记页\n  后端\n    同步');
    await makeBook(BOOK_B, CAT_B, '第一章\n  习惯\n  复盘');

    const rowsNow = await evalJs("(function(){ return [].slice.call(document.querySelectorAll('#mgrRoot .memo-row')).map(function(r){" +
      " return {t:(r.querySelector('b')||{}).textContent, c:(r.querySelector('.memo-cat')||{}).textContent}; }); })()");
    ok('两条笔记都已落库并带各自分类',
      rowsNow.some(r => r.t === BOOK_A && r.c === CAT_A) && rowsNow.some(r => r.t === BOOK_B && r.c === CAT_B), rowsNow);

    /* ---------------- ① 筛选条 ---------------- */
    console.log('\n[F1] 笔记本分类筛选条');
    await clickNav('notebook'); await sleep(400);
    const bar = await evalJs("(function(){ var b=document.getElementById('bookFilters'); if(!b) return null;" +
      " return { exists:true, hidden:b.hidden, chips:[].slice.call(b.querySelectorAll('.book-filter')).map(function(x){" +
      "   return {t:x.textContent, on:x.classList.contains('on'), v:x.dataset.bookfilter}; }) }; })()");
    ok('笔记本列表顶部出现筛选条', !!bar && bar.hidden === false, bar && bar.exists);
    ok('筛选条含「全部 / 未分类 / 各分类」', !!bar && bar.chips.length >= 4 &&
       bar.chips[0].t === '全部' && bar.chips[1].t === '未分类' &&
       bar.chips.some(c => c.t === CAT_A) && bar.chips.some(c => c.t === CAT_B),
       bar && bar.chips.map(c => c.t));
    await shot('book-filters.png');

    const visibleAll = await evalJs("window.TookBook.visibleRows()");
    ok('默认「全部」下两条都在', visibleAll.length === rowsNow.length, visibleAll);

    /* 真的过滤：选 CAT_A */
    await evalJs("window.TookBook.setFilter(" + J(CAT_A) + ")");
    await sleep(250);
    const visA = await evalJs("window.TookBook.visibleRows()");
    ok('选「' + CAT_A + '」后只剩该分类的笔记', visA.length === 1 && visA[0] === BOOK_A, visA);
    const hidB = await evalJs("(function(){ var rows=[].slice.call(document.querySelectorAll('#mgrRoot .memo-row'));" +
      " var r=rows.filter(function(x){ return ((x.querySelector('b')||{}).textContent||'').indexOf(" + J(BOOK_B) + ")===0; })[0];" +
      " return r ? {inline:r.style.display, computed:getComputedStyle(r).display} : 'MISSING'; })()");
    ok('被筛掉的行真的不可见（computed display:none）', !!hidB && hidB.computed === 'none', hidB);
    await shot('book-filters-on.png');

    await evalJs("window.TookBook.setFilter(" + J(CAT_B) + ")");
    await sleep(250);
    const visB = await evalJs("window.TookBook.visibleRows()");
    ok('切到「' + CAT_B + '」只剩另一条', visB.length === 1 && visB[0] === BOOK_B, visB);

    /* 点真按钮切回「全部」 */
    await evalJs("(function(){ var b=document.querySelector('#bookFilters .book-filter'); b.click(); return true; })()");
    await sleep(250);
    const visBack = await evalJs("window.TookBook.visibleRows()");
    ok('点「全部」筛选条恢复完整列表', visBack.length === rowsNow.length, visBack);

    /* ---------------- ② 更多菜单 + 重命名 ---------------- */
    console.log('\n[F2] 笔记更多菜单（重命名 / 删除）');
    ok('能打开笔记编辑页', await openRow(BOOK_A));
    await sleep(500);
    const menuClosed = await evalJs("document.getElementById('bookMenu').hidden");
    ok('更多菜单默认收起', menuClosed === true);
    await click('#bookMore'); await sleep(250);
    const menuOpen = await evalJs("(function(){ var m=document.getElementById('bookMenu');" +
      " return {hidden:m.hidden, items:[].slice.call(m.querySelectorAll('[data-bmenu]')).map(function(b){return b.textContent;})," +
      "   expanded:document.getElementById('bookMore').getAttribute('aria-expanded')}; })()");
    ok('点「⋯」→ 菜单展开', menuOpen.hidden === false, menuOpen);
    ok('菜单含「重命名」与「删除」', menuOpen.items.length === 2 &&
       menuOpen.items.some(t => t.indexOf('重命名') >= 0) && menuOpen.items.some(t => t.indexOf('删除') >= 0),
       menuOpen.items);
    ok('菜单 aria-expanded=true', menuOpen.expanded === 'true');
    await shot('book-more-menu.png');

    /* 重命名：真的改名并落库 */
    const NEW_TITLE = '周会记录改 ' + STAMP;
    await evalJs("(function(){ var b=document.querySelector('#bookMenu [data-bmenu=\"rename\"]'); b.click(); return true; })()");
    await sleep(250);
    const renameUi = await evalJs("(function(){ var r=document.getElementById('bookRenameRow'), i=document.getElementById('bookRenameInput');" +
      " return {rowHidden:r.hidden, value:i.value, focused:document.activeElement===i}; })()");
    ok('点「重命名」→ 出现输入框并预填当前标题', renameUi.rowHidden === false && renameUi.value === BOOK_A, renameUi);
    ok('重命名输入框自动聚焦', renameUi.focused === true);
    await shot('book-rename.png');

    await evalJs("(function(){ var i=document.getElementById('bookRenameInput'); i.value=" + J(NEW_TITLE) + ";" +
      " i.dispatchEvent(new Event('input',{bubbles:true})); document.getElementById('bookRenameOk').click(); return true; })()");
    await sleep(1600);
    const renamed = await evalJs("document.getElementById('bookTitle').textContent");
    ok('重命名真的改了标题', renamed === NEW_TITLE, renamed);
    await click('#bookBack'); await sleep(900);
    const rowsRenamed = await evalJs("(function(){ return [].slice.call(document.querySelectorAll('#mgrRoot .memo-row')).map(function(r){" +
      " return (r.querySelector('b')||{}).textContent; }); })()");
    ok('列表显示新标题', rowsRenamed.indexOf(NEW_TITLE) >= 0, rowsRenamed);
    ok('旧标题已不在列表', rowsRenamed.indexOf(BOOK_A) < 0);

    /* 删除菜单项 → 走 app.js 的二次确认 */
    ok('能重新打开笔记', await openRow(NEW_TITLE));
    await sleep(500);
    await click('#bookMore'); await sleep(200);
    await evalJs("(function(){ document.querySelector('#bookMenu [data-bmenu=\"del\"]').click(); return true; })()");
    await sleep(400);
    const delConfirm = await evalJs("(function(){ return {mask:document.getElementById('confirmMask').hidden===false," +
      " text:document.getElementById('confirmText').textContent}; })()");
    ok('菜单「删除」→ 弹二次确认', delConfirm.mask === true, delConfirm.text);
    await evalJs("document.getElementById('confirmOk').click()");
    await sleep(1400);
    const afterDel = await evalJs("(function(){ return [].slice.call(document.querySelectorAll('#mgrRoot .memo-row')).map(function(r){" +
      " return (r.querySelector('b')||{}).textContent; }); })()");
    ok('删除后列表不再有它', afterDel.indexOf(NEW_TITLE) < 0, afterDel);

    /* ---------------- ④ 新建分类输入框 ---------------- */
    console.log('\n[F4] 分类选择层里的「新建分类」输入框');
    await clickNav('notebook'); await sleep(300);
    ok('能打开笔记', await openRow(BOOK_B));
    await sleep(500);
    await click('#bookCat'); await sleep(350);
    const picker0 = await evalJs("(function(){ return {" +
      " mask:document.getElementById('bookPickerMask').hidden===false," +
      " openBtn:document.getElementById('bookNewCatOpen').hidden===false," +
      " form:document.getElementById('bookNewCatForm').hidden===true }; })()");
    ok('分类选择层已打开，默认只显示「＋ 新建分类」按钮', picker0.mask && picker0.openBtn && picker0.form, picker0);
    await click('#bookNewCatOpen'); await sleep(250);
    const picker1 = await evalJs("(function(){ var f=document.getElementById('bookNewCatForm'), i=document.getElementById('bookNewCatInput');" +
      " return {form:f.hidden===false, openBtnHidden:document.getElementById('bookNewCatOpen').hidden===true," +
      "   hasInput:!!i, focused:document.activeElement===i," +
      "   okBtn:!!document.getElementById('bookNewCatBtn'), cancelBtn:!!document.getElementById('bookNewCatCancel')}; })()");
    ok('点「＋ 新建分类」→ 展开输入框', picker1.form === true && picker1.openBtnHidden === true, picker1);
    ok('输入框自动聚焦，且有确定 / 取消', picker1.hasInput && picker1.focused && picker1.okBtn && picker1.cancelBtn, picker1);
    await shot('book-newcat.png');

    /* 空名 → 明确提示，不新建 */
    await evalJs("(function(){ var i=document.getElementById('bookNewCatInput'); i.value='   ';" +
      " i.dispatchEvent(new Event('input',{bubbles:true})); document.getElementById('bookNewCatBtn').click(); return true; })()");
    await sleep(300);
    const emptyHint = await evalJs("(function(){ var h=document.getElementById('bookNewCatHint');" +
      " return {hidden:h.hidden, text:h.textContent, chip:document.getElementById('bookCat').textContent," +
      "   maskStillOpen:document.getElementById('bookPickerMask').hidden===false," +
      "   formStillOpen:document.getElementById('bookNewCatForm').hidden===false}; })()");
    ok('空分类名 → 提示「不能为空」，不新建',
      emptyHint.hidden === false && /不能为空/.test(emptyHint.text) &&
      emptyHint.maskStillOpen === true && emptyHint.formStillOpen === true, emptyHint);

    /* 取消 → 收起表单 */
    await click('#bookNewCatCancel'); await sleep(200);
    const afterCancel = await evalJs("(function(){ return {form:document.getElementById('bookNewCatForm').hidden," +
      " openBtn:document.getElementById('bookNewCatOpen').hidden}; })()");
    ok('点「取消」→ 收起输入框、恢复按钮', afterCancel.form === true && afterCancel.openBtn === false, afterCancel);

    /* 真新建一个分类 → 必须出现在列表里 */
    const CAT_NEW = '灵感' + STAMP;
    await click('#bookNewCatOpen'); await sleep(200);
    await evalJs("(function(){ var i=document.getElementById('bookNewCatInput'); i.value=" + J(CAT_NEW) + ";" +
      " i.dispatchEvent(new Event('input',{bubbles:true})); document.getElementById('bookNewCatBtn').click(); return true; })()");
    await sleep(1600);
    const afterNewCat = await evalJs("(function(){ return {chip:document.getElementById('bookCat').textContent," +
      " maskHidden:document.getElementById('bookPickerMask').hidden}; })()");
    ok('新建分类后 chip 变成新分类', afterNewCat.chip === CAT_NEW, afterNewCat);
    ok('新建分类后分类层关闭', afterNewCat.maskHidden === true);

    await click('#bookBack'); await sleep(1200);
    const catsInList = await evalJs("(function(){ return [].slice.call(document.querySelectorAll('#mgrRoot .memo-cat')).map(function(c){return c.textContent;}); })()");
    ok('新分类真的出现在列表里', catsInList.indexOf(CAT_NEW) >= 0, catsInList);
    const chipsAfter = await evalJs("(function(){ var b=document.getElementById('bookFilters');" +
      " return b ? [].slice.call(b.querySelectorAll('.book-filter')).map(function(x){return x.textContent;}) : []; })()");
    ok('新分类也进了筛选条', chipsAfter.indexOf(CAT_NEW) >= 0, chipsAfter);

    /* ---------------- ③ 思维笔记 ---------------- */
    console.log('\n[F3] 思维笔记');
    ok('能打开笔记（正文非空）', await openRow(BOOK_B));
    await sleep(600);
    const think1 = await evalJs("(function(){ var b=document.getElementById('bookThink');" +
      " return {exists:!!b, disabled:b.disabled, text:b.textContent}; })()");
    ok('正文非空 → 思维笔记按钮可用', think1.exists && think1.disabled === false, think1);

    /* 清空正文 → 必须变禁用（原型语义） */
    await evalJs("(function(){ var el=document.getElementById('bookBody'); el.value='';" +
      " el.dispatchEvent(new Event('input',{bubbles:true})); return true; })()");
    await sleep(300);
    const thinkEmpty = await evalJs("(function(){ var b=document.getElementById('bookThink');" +
      " return {disabled:b.disabled, title:b.title}; })()");
    ok('正文为空 → 思维笔记按钮禁用（不做假按钮）', thinkEmpty.disabled === true, thinkEmpty);
    ok('禁用态有明确说明', /为空/.test(thinkEmpty.title), thinkEmpty.title);
    await shot('book-think-disabled.png');

    /* 恢复正文 → 点它真的出导图视图 */
    const OUTLINE = '第一章\n  习惯\n  复盘\n第二章\n  计划';
    await evalJs("(function(){ var el=document.getElementById('bookBody'); el.value=" + J(OUTLINE) + ";" +
      " el.dispatchEvent(new Event('input',{bubbles:true})); return true; })()");
    await sleep(400);
    await click('#bookThink'); await sleep(500);
    const thinkView = await evalJs("(function(){ var v=document.getElementById('bookThinkView'), c=document.getElementById('bookThinkCanvas');" +
      " return {open:v.hidden===false, docHidden:document.querySelector('.be-doc').hidden===true," +
      "   nodes:[].slice.call(c.querySelectorAll('.think-node')).map(function(n){return n.textContent;})," +
      "   root:(c.querySelector('.think-root')||{}).textContent, sub:document.getElementById('bookThinkSub').textContent}; })()");
    ok('点「创建思维笔记」→ 打开导图视图', thinkView.open === true && thinkView.docHidden === true, thinkView);
    ok('导图按正文层级生成节点（5 个，含缩进子节点）',
      thinkView.nodes.length === 5 && thinkView.nodes[0] === '第一章' &&
      thinkView.nodes.indexOf('习惯') >= 0 && thinkView.nodes.indexOf('计划') >= 0, thinkView.nodes);
    const nested = await evalJs("document.querySelectorAll('#bookThinkCanvas ul ul li').length");
    ok('缩进的行真的嵌套成子节点', nested >= 2, nested);
    ok('导图有根节点与节点数说明', !!thinkView.root && /\d+ 个节点/.test(thinkView.sub), thinkView.root + ' / ' + thinkView.sub);
    await shot('book-think.png');
    await click('#bookThinkBack'); await sleep(300);
    const thinkClosed = await evalJs("(function(){ return {view:document.getElementById('bookThinkView').hidden," +
      " doc:document.querySelector('.be-doc').hidden}; })()");
    ok('「返回正文」→ 回到正文视图', thinkClosed.view === true && thinkClosed.doc === false, thinkClosed);
    await click('#bookBack'); await sleep(500);

    /* ---------------- 清理 ---------------- */
    console.log('\n[清理] 删掉本轮新建的笔记');
    await clickNav('notebook'); await sleep(400);
    for (const t of [BOOK_B]) {
      const found = await evalJs("(function(){ var rows=[].slice.call(document.querySelectorAll('#memoList .memo-row'));" +
        " var r=rows.filter(function(x){ return ((x.querySelector('b')||{}).textContent||'').indexOf(" + J(t) + ")===0; })[0];" +
        " if(!r) return false; var b=r.querySelector('[data-memo-act=\"del\"]'); if(!b) return false; b.click(); return true; })()");
      if (!found) { ok('清理 ' + t, false, '找不到行'); continue; }
      await sleep(400);
      await evalJs("document.getElementById('confirmOk').click()");
      await sleep(900);
    }
    const left = await evalJs("(function(){ return [].slice.call(document.querySelectorAll('#mgrRoot .memo-row')).map(function(r){return (r.querySelector('b')||{}).textContent;}); })()");
    ok('清理：本轮笔记都不在了', left.indexOf(NEW_TITLE) < 0 && left.indexOf(BOOK_B) < 0, left);

    console.log('\n[控制台]');
    ok('无 JS 运行时错误', errors.length === 0, errors.slice(0, 3));

    /* 收尾回日历页并截 FAB */
    await evalJs("(function(){ var b=document.getElementById('configDone'); if(b) b.click(); return true; })()");
    await sleep(600);
    ok('回到日历页后 FAB 重新出现', await evalJs("document.getElementById('mgrFab').hidden === false"));
  } catch (e) {
    fail++;
    console.log('  ERROR  ' + (e && e.stack ? e.stack.split('\n').slice(0, 6).join('\n') : e));
  } finally {
    console.log('\n结果：' + pass + ' passed, ' + fail + ' failed');
    try { app.kill(); } catch (e) {}
    process.exitCode = fail ? 1 : 0;
  }
})();
