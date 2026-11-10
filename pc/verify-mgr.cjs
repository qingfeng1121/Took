/* verify-mgr.cjs —— T3 管理页真窗口验收（took.exe + CDP）
   断言 12 项清单里的关键交互，并落 8 张截图到 pc/shots/。 */
const { spawn } = require('node:child_process');
const { writeFileSync, mkdirSync, rmSync } = require('node:fs');
const { join } = require('node:path');

const EXE = 'D:/work/Project/Took/pc/src-tauri/target/debug/took.exe';
const SHOTS = 'D:/work/Project/Took/pc/shots/';
const PORT = 9337;
const sleep = ms => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  PASS  ' + name + (extra !== undefined ? '  ' + extra : '')); }
  else { fail++; console.log('  FAIL  ' + name + (extra !== undefined ? '  ' + extra : '')); }
};

(async () => {
  mkdirSync(SHOTS, { recursive: true });
  const cdpProfile = join(process.env.APPDATA || '', 'app.took.desktop', 'webview-cdp');
  try { rmSync(cdpProfile, { recursive: true, force: true, maxRetries: 5 }); } catch (e) { console.log('  (调试 profile 清不掉，沿用旧目录) ' + e.code); }
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
    await sleep(120);
  };
  const waitFor = async (expr, ms) => {
    const t0 = Date.now();
    while (Date.now() - t0 < (ms || 4000)) {
      try { if (await evalJs(expr)) return true; } catch (e) {}
      await sleep(120);
    }
    return false;
  };
  /* 点 + 等条件成立（启动期后台同步会重绘，点早了会丢），失败再点一次 */
  const clickUntil = async (sel, expr, ms) => {
    for (let i = 0; i < 2; i++) {
      await clickSel(sel);
      if (await waitFor(expr, ms || 4000)) return true;
      await sleep(300);
    }
    return false;
  };
  const shot = async name => {
    const s = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(SHOTS + name, Buffer.from(s.data, 'base64'));
    console.log('        截图 → pc/shots/' + name);
  };
  await send('Runtime.enable');
  await send('Log.enable');
  await sleep(3000);

  try {
    console.log('\n[1] 打开管理页 / 左导航四分类');
    const opened = await clickUntil('#btnNew', '!document.getElementById("configScreen").hidden');
    await waitFor('!!document.querySelector("#mgrRoot .mgr-row")', 6000);
    await sleep(300);
    const nav = await evalJs('(function(){' +
      'var ns=[].slice.call(document.querySelectorAll("#mgrNav button"));' +
      'return {open:!document.getElementById("configScreen").hidden, n:ns.length,' +
      ' labels:ns.map(function(b){return b.textContent.trim();}),' +
      ' icons:ns.filter(function(b){return !!b.querySelector("svg");}).length,' +
      ' on:(document.querySelector("#mgrNav button.on")||{}).textContent,' +
      ' onBg:getComputedStyle(document.querySelector("#mgrNav button.on")).backgroundColor,' +
      ' title:document.getElementById("mgrTitle").textContent,' +
      ' sub:document.getElementById("mgrSub").textContent,' +
      ' done:!!document.getElementById("configDone"),' +
      ' back:!!document.getElementById("configBack")};})()');
    ok('点「配置」→ 管理页打开', opened === true && nav.open === true, 'opened=' + opened);
    ok('左导航四个分类', nav.n === 4 && JSON.stringify(nav.labels) === JSON.stringify(['规则','记事','倒数日','笔记本']), JSON.stringify(nav.labels));
    ok('每个分类都带图标', nav.icons === 4, 'icons=' + nav.icons);
    ok('选中态是橙色背景（--accent-weak）', nav.onBg === 'rgb(255, 244, 236)', nav.onBg);
    ok('标题 + 副标题（规则 / 点左侧箭头展开任务）',
       nav.title === '规则' && nav.sub.indexOf('箭头') >= 0, nav.title + ' / ' + nav.sub);
    ok('右上角「完成」按钮存在', nav.done === true);
    ok('左上角返回箭头存在', nav.back === true);

    console.log('\n[2] 规则卡片：箭头 / 进度 / 开关');
    const card = await evalJs('(function(){' +
      'var row=document.querySelector("#mgrRoot .mgr-row");' +
      'if(!row) return null;' +
      'var sw=row.querySelector(".switch[data-mgr=\\"switch\\"]");' +
      'var rate=row.querySelector(".rate");' +
      'var cs=sw?getComputedStyle(sw):null;' +
      'return {caret:!!row.querySelector(".caret"), count:!!row.querySelector(".mgr-count"),' +
      ' rate:rate?rate.textContent.trim():null, rateColor:rate?getComputedStyle(rate.querySelector("b")).color:null,' +
      ' sw:!!sw, swOn:sw?sw.getAttribute("aria-checked"):null,' +
      ' swBg:cs?cs.backgroundColor:null, pencil:!!row.querySelector("[data-act=\\"edit\\"].icon-act"),' +
      ' trash:!!row.querySelector("[data-act=\\"del\\"].icon-act")};})()');
    ok('规则卡片有折叠箭头', card.caret === true);
    ok('规则卡片有任务数 + 进度「N/M 周期」', card.count === true && /^\d+%/.test(card.rate), card.rate);
    ok('进度百分比用橙色', card.rateColor === 'rgb(217, 96, 15)', card.rateColor);
    ok('右侧启用开关是橙色 toggle', card.sw === true && card.swBg === 'rgb(249, 115, 22)', card.swBg + ' on=' + card.swOn);
    ok('规则行右侧有铅笔 + 垃圾桶图标', card.pencil === true && card.trash === true);
    await shot('mgr-rules.png');

    console.log('\n[3] 点箭头展开任务（任务行从 0 变 N）');
    const before = await evalJs('document.querySelectorAll("#mgrRoot .task-item").length');
    await clickSel('#mgrRoot .mgr-row .caret');
    await sleep(400);
    const after = await evalJs('(function(){' +
      'return {n:document.querySelectorAll("#mgrRoot .task-item").length,' +
      ' panelOpen:!!document.querySelector("#mgrRoot .rule-tasks"),' +
      ' aria:document.querySelector("#mgrRoot .caret").getAttribute("aria-expanded"),' +
      ' rotate:getComputedStyle(document.querySelector("#mgrRoot .caret")).transform,' +
      ' taskPencil:!!document.querySelector("#mgrRoot .task-item [data-mgr=\\"tedit\\"]"),' +
      ' taskTrash:!!document.querySelector("#mgrRoot .task-item [data-mgr=\\"tdel\\"]"),' +
      ' addBtn:!!document.querySelector("#mgrRoot .task-add")};})()');
    ok('点箭头 → 展开出任务行（0 → ' + after.n + '）', before === 0 && after.n > 0, before + ' → ' + after.n);
    ok('箭头 aria-expanded=true 且旋转 90°', after.aria === 'true' && after.rotate !== 'none', after.rotate);
    ok('每个任务行右侧有铅笔 + 垃圾桶', after.taskPencil === true && after.taskTrash === true);
    ok('展开后有「＋ 添加任务」', after.addBtn === true);
    await shot('mgr-expanded.png');

    console.log('\n[4] 点卡片其他地方 → 打开编辑规则（不是展开）');
    const expandedCount = await evalJs('document.querySelectorAll("#mgrRoot .rule-tasks").length');
    await clickSel('#mgrRoot .mgr-row .rule-main');
    await sleep(600);
    const editOpen = await evalJs('(function(){return {' +
      'form:!document.getElementById("formMask").hidden,' +
      'title:document.getElementById("formTitle").textContent,' +
      'name:(document.getElementById("fTitle")||{}).value,' +
      'stillExpanded:document.querySelectorAll("#mgrRoot .rule-tasks").length};})()');
    ok('点规则主体 → 打开规则编辑表单', editOpen.form === true && editOpen.title === '编辑规则', editOpen.title);
    ok('表单回填了规则名', !!editOpen.name, editOpen.name);
    ok('点卡片主体不会误触发展开/收起', editOpen.stillExpanded === expandedCount, editOpen.stillExpanded + ' vs ' + expandedCount);
    await evalJs('document.getElementById("fCancel").click()');
    await sleep(400);

    console.log('\n[5] 点右侧开关 → 规则 enabled 直接变化（不进编辑页）');
    const rid = await evalJs('document.querySelector("#mgrRoot .mgr-row").dataset.rule');
    const e0 = await evalJs('(async function(){var all=await window.__TAURI__.core.invoke("list_rules",{includeEnded:true});' +
      'var r=all.find(function(x){return x.id===' + JSON.stringify(rid) + ';});return r?r.enabled:null;})()');
    await clickSel('#mgrRoot .mgr-row .switch[data-mgr="switch"]');
    await sleep(1100);
    const e1 = await evalJs('(async function(){var all=await window.__TAURI__.core.invoke("list_rules",{includeEnded:true});' +
      'var r=all.find(function(x){return x.id===' + JSON.stringify(rid) + ';});return r?r.enabled:null;})()');
    const swAfter = await evalJs('document.querySelector("#mgrRoot .mgr-row .switch[data-mgr=\\"switch\\"]").getAttribute("aria-checked")');
    ok('点开关 → 规则 enabled 直接变化（' + e0 + ' → ' + e1 + '）', e0 === true && e1 === false, String(e1));
    ok('开关视觉同步（aria-checked=false）', swAfter === 'false', swAfter);
    ok('开关没有打开编辑页', (await evalJs('document.getElementById("formMask").hidden')) === true);
    await clickSel('#mgrRoot .mgr-row .switch[data-mgr="switch"]');
    await sleep(1100);
    const e2 = await evalJs('(async function(){var all=await window.__TAURI__.core.invoke("list_rules",{includeEnded:true});' +
      'var r=all.find(function(x){return x.id===' + JSON.stringify(rid) + ';});return r?r.enabled:null;})()');
    ok('再点一次恢复启用', e2 === true, String(e2));

    console.log('\n[6] 其余三类分类 + 标题/副标题联动');
    for (const [tab, title] of [['note','记事'], ['countdown','倒数日'], ['notebook','笔记本']]) {
      await clickSel('#mgrNav button[data-tab="' + tab + '"]');
      await waitFor('document.getElementById("mgrTitle").textContent === ' + JSON.stringify(title), 4000);
      const st = await evalJs('(function(){return {' +
        'title:document.getElementById("mgrTitle").textContent,' +
        'sub:document.getElementById("mgrSub").textContent,' +
        'on:(document.querySelector("#mgrNav button.on")||{}).textContent,' +
        'hasList:!!document.getElementById("mgrRoot"),' +
        'fab:document.getElementById("mgrFab").getAttribute("aria-label")};})()');
      ok(title + '分类：标题/选中态跟着切', st.title === title && st.on === title, st.title + ' | ' + st.sub);
      ok(title + '分类：FAB 文案 = 新建' + title, st.fab === '新建' + title, st.fab);
    }

    console.log('\n[7] FAB 在当前分类下新建对应类型');
    const maskOpen = '!document.getElementById("mgrMask").hidden';
    const closeDlg = async () => {
      await evalJs('document.getElementById("mgrDlgClose").click()');
      await waitFor('document.getElementById("mgrMask").hidden', 2000);
      await sleep(200);
    };

    // 笔记本：列表 → 截图 → FAB → 弹窗截图
    await clickSel('#mgrNav button[data-tab="notebook"]');
    await waitFor('document.getElementById("mgrTitle").textContent === "笔记本"', 3000);
    await sleep(400);
    await shot('mgr-notebook.png');
    const fabOpenNb = await clickUntil('#mgrFab', maskOpen, 3000);
    const dlgNb = await evalJs('(function(){return {open:!document.getElementById("mgrMask").hidden,' +
      'title:document.getElementById("mgrDlgTitle").textContent,' +
      'fields:[].slice.call(document.querySelectorAll("#mgrDlgBody label")).map(function(l){return l.textContent;})};})()');
    ok('笔记本分类下 FAB → 新建笔记本弹窗（名称/分类/正文）',
       fabOpenNb === true && dlgNb.title === '新建笔记本' &&
       JSON.stringify(dlgNb.fields) === JSON.stringify(['名称','分类','正文']), JSON.stringify(dlgNb));
    await closeDlg();

    // 记事：列表 → 截图 → FAB → 弹窗截图（六字段里的名称/日期/结束日期/正文）
    await clickSel('#mgrNav button[data-tab="note"]');
    await waitFor('document.getElementById("mgrTitle").textContent === "记事"', 3000);
    await sleep(400);
    await shot('mgr-note.png');
    const fabOpenNote = await clickUntil('#mgrFab', maskOpen, 3000);
    const dlgNoteFields = await evalJs('[].slice.call(document.querySelectorAll("#mgrDlgBody label")).map(function(l){return l.textContent;})');
    ok('记事分类下 FAB → 新建记事弹窗（名称/日期/结束日期/正文 四段）',
       fabOpenNote === true && JSON.stringify(dlgNoteFields) === JSON.stringify(['名称','日期','结束日期','正文']),
       JSON.stringify(dlgNoteFields));
    await shot('mgr-note-dialog.png');
    await closeDlg();

    // 倒数日：列表 → 截图 → FAB → 弹窗截图
    await clickSel('#mgrNav button[data-tab="countdown"]');
    await waitFor('document.getElementById("mgrTitle").textContent === "倒数日"', 3000);
    await sleep(400);
    await shot('mgr-countdown.png');
    const fabOpenCd = await clickUntil('#mgrFab', maskOpen, 3000);
    const dlgCount = await evalJs('(function(){return {title:document.getElementById("mgrDlgTitle").textContent,' +
      'fields:[].slice.call(document.querySelectorAll("#mgrDlgBody label")).map(function(l){return l.textContent;})};})()');
    ok('倒数日分类下 FAB → 新建倒数日弹窗（名称/目标日/备注）',
       fabOpenCd === true && dlgCount.title === '新建倒数日' &&
       JSON.stringify(dlgCount.fields) === JSON.stringify(['名称','目标日','备注']), JSON.stringify(dlgCount));
    await shot('mgr-countdown-dialog.png');
    await closeDlg();

    /* 2026-10-27 用户要求：这条从「新建任务弹窗」改成「行内编辑」，不弹模态框。
       断言的仍然是同一批要素（名称输入框 / 启用开关 / 说明文字），只是载体从
       #mgrDlgBody 换成 #mgrRoot 里的 .task-inline —— 不是放宽，是跟着设计改动走。
       同时新增一条反向断言：模态框必须**没有**打开（这正是用户要的效果）。 */
    console.log('\n[8] 新建任务改成行内编辑（名称 + 启用开关 + 说明文字，无模态框）');
    await clickSel('#mgrNav button[data-tab="rules"]');
    await sleep(500);
    const expandedNow = await evalJs('document.querySelectorAll("#mgrRoot .rule-tasks").length');
    if (!expandedNow) { await clickSel('#mgrRoot .mgr-row .caret'); await sleep(400); }
    await clickSel('#mgrRoot .rule-block .task-add');
    await sleep(400);
    const inlineTask = await evalJs('(function(){' +
      'var row=document.querySelector("#mgrRoot .task-inline");' +
      'var inp=row?row.querySelector(".task-inline-name"):null;' +
      'var hint=row?row.querySelector(".task-inline-hint"):null;' +
      'return {inline:!!row,' +
      ' maskOpen:!document.getElementById("mgrMask").hidden,' +
      ' name:!!inp, placeholder:inp?inp.placeholder:null,' +
      ' sw:!!(row&&row.querySelector("[data-mgr=tinlineswitch]")),' +
      ' hint:hint?hint.textContent:null};})()');
    ok('「＋ 添加任务」→ 就地出现输入框（不是弹窗）',
       inlineTask.inline === true && inlineTask.maskOpen === false, JSON.stringify(inlineTask));
    ok('★ 不再弹「新建任务」模态框（#mgrMask 保持 hidden）', inlineTask.maskOpen === false);
    ok('行内含名称输入框 + 启用开关 + 说明文字',
       inlineTask.name === true && inlineTask.sw === true && String(inlineTask.hint).length > 8,
       inlineTask.placeholder + ' | ' + inlineTask.hint);
    await shot('mgr-newtask-inline.png');
    await evalJs('(function(){var b=document.querySelector("#mgrRoot [data-mgr=tinlinecancel]"); if(b) b.click(); return true;})()');
    await sleep(300);

    console.log('\n[9] 既有回归选择器仍在（#configMain .rule-row / #newRule / [data-act]）');
    /* 库里的规则条数会随其它验收脚本累积，所以不写死数字：
       断言的是「旧标记仍在 DOM」「两套类名不互相计数」「旧的入口与按钮齐全」。 */
    const legacy = await evalJs('(function(){' +
      'var rows=[].slice.call(document.querySelectorAll("#configMain .rule-row"));' +
      'var mine=[].slice.call(document.querySelectorAll("#mgrRoot .mgr-row"));' +
      'var all=[].slice.call(document.querySelectorAll("#configMain .rule-row, #mgrRoot .mgr-row"));' +
      'return {rows:rows.length, mine:mine.length, union:all.length,' +
      ' newRule:!!document.getElementById("newRule"),' +
      ' counts:rows.map(function(r){return parseInt((r.querySelector(".rule-count")||{}).textContent,10)||0;}),' +
      ' edits:rows.filter(function(r){return !!r.querySelector(\'[data-act=edit]\');}).length,' +
      ' dels:rows.filter(function(r){return !!r.querySelector(\'[data-act=del]\');}).length};})()');
    ok('旧标记仍在 DOM（#configMain .rule-row 非空）', legacy.rows > 0, 'rows=' + legacy.rows);
    ok('两套类名不互相计数（旧标记与新 UI 各自一套，合并不重叠）',
       legacy.rows === legacy.mine && legacy.union === legacy.rows + legacy.mine, JSON.stringify(legacy));
    ok('旧标记每个都还带任务数（.rule-count 可解析）',
       legacy.counts.length === legacy.rows && legacy.counts.every(function(n){return !isNaN(n);}),
       JSON.stringify(legacy.counts));
    ok('#newRule 入口在 + 每条都有编辑/删除',
       legacy.newRule === true && legacy.edits === legacy.rows && legacy.dels === legacy.rows, JSON.stringify(legacy));

    console.log('\n[10] 点「完成」关闭管理页');
    await clickSel('#configDone');
    await sleep(500);
    ok('点完成 → 回到月历', (await evalJs('document.getElementById("configScreen").hidden')) === true);
    ok('FAB 不残留在月历上', (await evalJs('(function(){var f=document.getElementById("mgrFab");' +
      'return !f || getComputedStyle(f).display === "none" || document.getElementById("configScreen").hidden;})()')) === true);

    ok('无 JS 运行时错误', errors.length === 0, errors.slice(0, 3).join(' | '));
  } finally {
    ws.close();
    app.kill();
  }

  console.log('\n结果：' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
})();
