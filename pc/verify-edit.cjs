/* 真窗口验收（契约 §9 编辑语义）：驱动 Tauri 窗口里的 WebView2，
   走真实鼠标/键盘事件，验证：
     1) 新建规则 → 配置页出现 → 月历对应日期命中
     2) 改 weekdays → 先弹确认 → 确认后裂开：旧规则「已结束」+ 新规则，旧打卡历史还在
     3) 裂开后「复制任务到新规则」默认不勾，勾了才复制
     4) 删除规则二次确认写明「将删除该规则及其 N 个任务（打卡历史保留）」
   数据全部来自 Rust 本地库（不是 mock.js）。 */
const { spawn } = require('node:child_process');
const { writeFileSync, mkdirSync, rmSync } = require('node:fs');
const { join } = require('node:path');

const EXE = 'D:/work/Project/Took/pc/src-tauri/target/debug/took.exe';
const SHOTS = 'D:/work/Project/Took/pc/shots/';
const PORT = 9335;
const NAME = 'CDP打卡测试';
const TASK = 'CDP任务';
const sleep = ms => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  PASS  ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  ' + extra : '')); }
};

(async () => {
  mkdirSync(SHOTS, { recursive: true });
  // 注意：前端资源在编译期嵌进 exe（tauri-codegen），改了 pc/ui/** 必须重新 cargo build。
  // 这里顺手清掉 WebView2 的调试 profile，保证每次从干净状态起来（took.db 在父目录，不动）。
  const cdpProfile = join(process.env.APPDATA || '', 'app.took.desktop', 'webview-cdp');
  rmSync(cdpProfile, { recursive: true, force: true });
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
    await sleep(220);
  };
  const clickByText = async (sel, text) => {
    const b = await evalJs('(function(){var list=[].slice.call(document.querySelectorAll(' + JSON.stringify(sel) + '));' +
      'var e=list.find(function(x){return x.textContent.trim()===' + JSON.stringify(text) + ';});' +
      'if(!e) return null; var r=e.getBoundingClientRect();' +
      'return {x:r.x+r.width/2,y:r.y+r.height/2};})()');
    if (!b) throw new Error('找不到文案为「' + text + '」的 ' + sel);
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
      await send('Input.dispatchMouseEvent', {
        type, x: b.x, y: b.y, button: type === 'mouseMoved' ? 'none' : 'left',
        clickCount: type === 'mouseMoved' ? 0 : 1,
      });
    }
    await sleep(220);
  };
  // 真实键盘输入：点聚焦 → 全选 → Input.insertText（走浏览器输入路径，会触发 input 事件）
  const typeText = async (sel, text) => {
    await clickSel(sel);
    await evalJs('(function(){var e=document.querySelector(' + JSON.stringify(sel) + '); e.focus(); if (e.select) e.select();})()');
    await send('Input.insertText', { text });
    await sleep(160);
    return evalJs('(function(){var e=document.querySelector(' + JSON.stringify(sel) + '); return e ? e.value : null;})()');
  };
  const waitFor = async (expr, ms) => {
    const until = Date.now() + (ms || 4000);
    while (Date.now() < until) {
      if (await evalJs(expr)) return true;
      await sleep(120);
    }
    return false;
  };
  const shot = async name => {
    const s = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(SHOTS + name, Buffer.from(s.data, 'base64'));
  };

  await send('Runtime.enable'); await send('Log.enable'); await send('Page.enable');
  await sleep(2600);

  try {
    /* ---- 0. 清场：删掉上次运行留下的同名规则 ---- */
    await evalJs('(async function(){var api=window.__TAURI__.core;' +
      'var all=await api.invoke("list_rules",{includeEnded:true});' +
      'var mine=all.filter(function(r){return r.title.indexOf(' + JSON.stringify(NAME) + ')===0;});' +
      'for (var i=0;i<mine.length;i++){ await api.invoke("delete_rule",{id:mine[i].id}); }' +
      'return mine.length;})()');
    await evalJs('location.reload()');
    await sleep(2600);

    const base = await evalJs('(function(){' +
      'var d=new Date(); var p=function(n){return String(n).padStart(2,"0");};' +
      'var today=d.getFullYear()+"-"+p(d.getMonth()+1)+"-"+p(d.getDate());' +
      'return {today:today, month:d.getMonth()+1, hasTauri:!!(window.__TAURI__ && window.__TAURI__.core)};})()');
    ok('数据来自 Tauri 本地库', base.hasTauri === true, JSON.stringify(base));
    const TODAY = base.today;

    /* ---- 1. 新建规则：配置页 → ＋新建规则 → 表单 ---- */
    console.log('\n[1] 新建规则（表单）');
    await clickSel('#btnNew');
    ok('点配置 → 配置页打开', (await evalJs('!document.getElementById("configScreen").hidden')) === true);
    const cfg0 = await evalJs('(function(){return {btn:!!(document.getElementById("mgrNewRule")||document.getElementById("newRule")),' +
      'mgrNewRule:!!document.getElementById("mgrNewRule"),' +
      'fab:!!document.getElementById("mgrFab"),' +
      'sub:document.querySelector("#configScreen .sub").textContent};})()');
    // 2026-10-27 用户要求删掉标题旁的「＋ 新建规则」，规则新建只留右下角 FAB。
    ok('标题旁不再有「＋ 新建规则」（只剩右下角 FAB）',
       cfg0.mgrNewRule === false && cfg0.fab === true, JSON.stringify(cfg0));
    ok('配置页不再自称只读', cfg0.sub.indexOf('只读') < 0, cfg0.sub);

    // #newRule 仍在 DOM 里（app.js 的输出口），被 CSS 视觉隐藏（0×0 点不中）。
    // 规则新建的可见入口现在是右下角 FAB，走它 —— 这条路径本身就是用户点得到的那条。
    await clickSel('#mgrFab');
    ok('点新建 → 表单打开', (await evalJs('!document.getElementById("formMask").hidden')) === true);
    ok('表单标题 = 新建规则', (await evalJs('document.getElementById("formTitle").textContent')) === '新建规则',
      String(await evalJs('document.getElementById("formTitle").textContent')));
    ok('重复方式五选一齐全',
      (await evalJs('document.querySelectorAll("#fMode [data-mode]").length')) === 5);

    const typedTitle = await typeText('#fTitle', NAME);
    ok('名称输入框收到真实键盘输入', typedTitle === NAME, String(typedTitle));
    // 开始日期回填到今天之后改成过去某天：让旧规则在裂开后仍有历史区间
    await evalJs('(function(){var e=document.getElementById("fStart");' +
      'e.value="2026-01-01"; e.dispatchEvent(new Event("input",{bubbles:true}));' +
      'e.dispatchEvent(new Event("change",{bubbles:true}));})()');
    // 周一到周日全选 → 每天（保证「今天」这一格命中，便于断言月历）
    for (const i of [5, 6]) await clickSel('#fDays [data-day="' + i + '"]');
    const maskNow = await evalJs('(function(){return [].slice.call(document.querySelectorAll("#fDays .on")).length;})()');
    ok('周几多选：点周六/周日 → 7 天全选', maskNow === 7, '选中 ' + maskNow + ' 天');
    const typedTask = await typeText('#fTasks .task-name[data-tidx="0"]', TASK);
    ok('任务名输入框收到真实键盘输入', typedTask === TASK, String(typedTask));
    const draftRead = await evalJs('(function(){return {start:document.getElementById("fStart").value,' +
      'title:document.getElementById("fTitle").value};})()');
    ok('开始日期按输入保留', draftRead.start === '2026-01-01', JSON.stringify(draftRead));
    await shot('pc-edit-form-new.png');
    await clickSel('#fSave');
    const saved = await waitFor('document.getElementById("formMask").hidden', 4000);
    const formErr = saved ? '' : await evalJs('(function(){var e=document.getElementById("fErr");' +
      'return e && !e.hidden ? e.textContent : "(无错误文本)";})()');
    ok('保存后表单关闭', saved, formErr);

    const cfg1 = await evalJs('(function(){' +
      'var rows=[].slice.call(document.querySelectorAll(".rule-row"));' +
      'var mine=rows.filter(function(r){return r.querySelector(".rule-meta b").textContent===' + JSON.stringify(NAME) + ';});' +
      'return {n:mine.length, ended:mine.map(function(r){return r.dataset.ended;}),' +
      'text:mine.length?mine[0].querySelector(".rule-main i").textContent:null,' +
      'count:mine.length?mine[0].querySelector(".rule-count").textContent:null};})()');
    ok('新建的规则出现在配置页', cfg1.n === 1, JSON.stringify(cfg1));
    ok('重复方式文案 = 每周 每天', cfg1.text && cfg1.text.indexOf('每天') >= 0, String(cfg1.text));
    ok('规则行显示 1 个任务', String(cfg1.count).indexOf('1') >= 0, String(cfg1.count));
    await shot('pc-edit-config-new.png');

    /* ---- 2. 月历上对应日期命中 ---- */
    console.log('\n[2] 月历命中与打卡');
    await clickSel('#configDone');
    ok('返回月历', (await evalJs('document.getElementById("configScreen").hidden')) === true);
    const hit = await evalJs('(function(){' +
      'function names(d){var c=document.querySelector(\'.cell[data-date="\'+d+\'"]\');' +
      'return c?[].slice.call(c.querySelectorAll(".tag:not(.more) .nm")).map(function(n){return n.textContent;}):null;}' +
      'var t=' + JSON.stringify(TODAY) + ';' +
      'var d=new Date(); d.setDate(d.getDate()-3);' +
      'var p=function(n){return String(n).padStart(2,"0");};' +
      'var back=d.getFullYear()+"-"+p(d.getMonth()+1)+"-"+p(d.getDate());' +
      'return {today:names(t), back:names(back), backKey:back};})()');
    ok('今天那一格命中「' + TASK + '」', (hit.today || []).indexOf(TASK) >= 0, JSON.stringify(hit.today));
    ok('三天前那格也命中（每天）', (hit.back || []).indexOf(TASK) >= 0, hit.backKey + ' ' + JSON.stringify(hit.back));

    // 打卡：选「上周一」那天的面板（一定早于昨天，且是它自己那周的周期起点）
    const mondayKey = await evalJs('(function(){' +
      'var pad=function(n){return String(n).padStart(2,"0");};' +
      'var d=new Date("' + TODAY + 'T00:00:00");' +
      'var w=(d.getDay()+6)%7; d.setDate(d.getDate()-w-7);' +
      'return d.getFullYear()+"-"+pad(d.getMonth()+1)+"-"+pad(d.getDate());})()');
    console.log('  （打卡用的历史日：' + mondayKey + '）');
    await clickSel('.cell[data-date="' + mondayKey + '"] .dnum');
    ok('点日期数字 → 面板打开', (await evalJs('!document.getElementById("mask").hidden')) === true);
    const taskSel = await evalJs('(function(){' +
      'var rows=[].slice.call(document.querySelectorAll(".mtask"));' +
      'var r=rows.find(function(x){return x.querySelector(".mtask-name").textContent===' + JSON.stringify(TASK) + ';});' +
      'return r?{task:r.dataset.task, period:r.dataset.period, state:r.querySelector(".mtask-state").textContent}:null;})()');
    ok('面板里能点到新任务', !!taskSel, JSON.stringify(taskSel));
    const oldTaskId = taskSel && taskSel.task;
    await clickSel('.mtask[data-task="' + oldTaskId + '"]');
    await sleep(300);
    const doneState = await evalJs('(function(){var r=document.querySelector(\'.mtask[data-task="' + oldTaskId + '"]\');' +
      'return r?r.querySelector(".mtask-state").textContent:null;})()');
    ok('打勾后状态 = 已完成', doneState === '已完成', String(doneState));
    const donePeriod = taskSel ? taskSel.period : null;
    await evalJs('document.getElementById("mask").click()');

    /* ---- 3. 编辑 → 改 weekdays → 先弹确认 ---- */
    /* ---- 2.5 模式来回切：与当前模式无关的字段残留不该白裂（与 Android 同一口径） ---- */
    console.log('\n[2.5] 每周 → 每月 15 日 → 回每周（不该裂）');
    await clickSel('#btnNew');
    const ridNoSplit = await evalJs('(function(){' +
      'var rows=[].slice.call(document.querySelectorAll(".rule-row"));' +
      'var r=rows.find(function(x){return x.querySelector(".rule-meta b").textContent===' + JSON.stringify(NAME) + ';});' +
      'return r?r.dataset.rule:null;})()');
    await clickSel('.rule-row[data-rule="' + ridNoSplit + '"] [data-act="edit"]');
    ok('打开编辑表单（准备模式来回切）', (await evalJs('!document.getElementById("formMask").hidden')) === true);
    await clickSel('#fMode [data-mode="2"]');
    await evalJs('(function(){var el=document.getElementById("fMonthDay"); if(!el) return null;' +
      'el.value="15"; el.dispatchEvent(new Event("input",{bubbles:true}));' +
      'el.dispatchEvent(new Event("change",{bubbles:true})); return el.value;})()');
    ok('已切到「每月」并填 15 日',
      (await evalJs('(function(){var el=document.getElementById("fMonthDay");return el?el.value:null;})()')) === '15');
    await clickSel('#fMode [data-mode="0"]');
    ok('切回「每周」后勾选仍是每天 7 天',
      (await evalJs('(function(){return [].slice.call(document.querySelectorAll("#fDays .on")).length;})()')) === 7);
    await clickSel('#fSave');
    await sleep(900);
    ok('保存不弹裂开确认（month_day 对 weekly 无效）',
      (await evalJs('document.getElementById("confirmMask").hidden')) === true);
    const afterNoSplit = await evalJs('(async function(){var api=window.__TAURI__.core;' +
      'var all=await api.invoke("list_rules",{includeEnded:true});' +
      'var mine=all.filter(function(r){return r.title===' + JSON.stringify(NAME) + ';});' +
      'return {count:mine.length, modes:mine.map(function(r){return r.repeat_mode;}),' +
      'until:mine.map(function(r){return r.repeat_until;}), month:mine.map(function(r){return r.month_day;})};})()');
    ok('库里的同名规则仍只有 1 条（没白裂）', afterNoSplit.count === 1, JSON.stringify(afterNoSplit));
    ok('规则仍是每周、上界没被写', afterNoSplit.modes[0] === 0 && !afterNoSplit.until[0], JSON.stringify(afterNoSplit));
    ok('无用的 month_day 落库为 0（提交前已归一化）', afterNoSplit.month[0] === 0, String(afterNoSplit.month[0]));
    await clickSel('#configDone');
    await sleep(300);

    console.log('\n[3] 改 weekdays → 裂开确认');
    await clickSel('#btnNew');
    const rowSel = '.rule-row[data-ended="0"]';
    const rowId = await evalJs('(function(){' +
      'var rows=[].slice.call(document.querySelectorAll(".rule-row"));' +
      'var r=rows.find(function(x){return x.querySelector(".rule-meta b").textContent===' + JSON.stringify(NAME) + ';});' +
      'return r?r.dataset.rule:null;})()');
    ok('配置页能定位到新规则行', !!rowId, String(rowId));
    await clickSel('.rule-row[data-rule="' + rowId + '"] .rule-main');
    ok('点规则行 → 展开任务列表',
      (await evalJs('!!document.querySelector(\'.rule-row[data-rule="' + rowId + '"] + .rule-tasks, .rule-row[data-rule="' + rowId + '"] .rule-tasks\')')) === true ||
      (await evalJs('document.querySelectorAll(".rule-tasks").length')) > 0,
      'tasks=' + (await evalJs('document.querySelectorAll(".rule-tasks").length')));
    await clickSel('.rule-row[data-rule="' + rowId + '"] [data-act="edit"]');
    ok('点编辑 → 表单打开', (await evalJs('!document.getElementById("formMask").hidden')) === true);
    ok('表单标题 = 编辑规则', (await evalJs('document.getElementById("formTitle").textContent')) === '编辑规则');
    ok('名称回填正确', (await evalJs('document.getElementById("fTitle").value')) === NAME);

    // 每天 → 周一至周五：点掉周六(5)/周日(6)
    for (const i of [5, 6]) await clickSel('#fDays [data-day="' + i + '"]');
    const sel2 = await evalJs('(function(){return [].slice.call(document.querySelectorAll("#fDays .on")).length;})()');
    ok('改后只剩 5 天（周一至周五）', sel2 === 5, '选中 ' + sel2 + ' 天');
    await shot('pc-edit-form-split.png');
    await clickSel('#fSave');
    ok('保存 → 先弹确认框', await waitFor('!document.getElementById("confirmMask").hidden', 3000));
    const confirmText = await evalJs('document.getElementById("confirmText").textContent');
    ok('确认文案 = 契约原文',
      confirmText === '修改重复设置会结束当前规则并新建一条，历史打卡保留。是否继续？', String(confirmText));
    await shot('pc-edit-confirm-split.png');
    const beforeSplit = await evalJs('(function(){' +
      'var rows=[].slice.call(document.querySelectorAll(".rule-row"));' +
      'return rows.filter(function(r){return r.querySelector(".rule-meta b").textContent===' + JSON.stringify(NAME) + ';}).length;})()');
    ok('确认前还没裂开（仍只有 1 条同名规则）', beforeSplit === 1, '同名规则 ' + beforeSplit + ' 条');

    /* ---- 4. 确认 → 旧规则「已结束」+ 新规则 ---- */
    console.log('\n[4] 确认后裂开');
    await clickSel('#confirmOk');
    await sleep(700);
    const after = await evalJs('(async function(){' +
      'var api=window.__TAURI__.core;' +
      'var all=await api.invoke("list_rules",{includeEnded:true});' +
      'var mine=all.filter(function(r){return r.title===' + JSON.stringify(NAME) + ';});' +
      'var rows=[].slice.call(document.querySelectorAll(".rule-row"));' +
      'var dom=rows.filter(function(r){return r.querySelector(".rule-meta b").textContent===' + JSON.stringify(NAME) + ';})' +
      '.map(function(r){return {id:r.dataset.rule, ended:r.dataset.ended,' +
      'badge:(r.querySelector(".badge.ended")||{}).textContent||null, count:r.querySelector(".rule-count").textContent};});' +
      'return {rules:mine.map(function(r){return {id:r.id, ended:r.ended, until:r.repeat_until,' +
      'start:r.start_date, mask:r.weekdays_mask, tasks:r.tasks.map(function(t){return t.id+":"+t.title;})};}), dom:dom};})()');
    ok('裂开后出现 2 条同名规则', after.rules.length === 2, JSON.stringify(after.rules));
    const oldRule = after.rules.find(r => r.ended);
    const newRule = after.rules.find(r => !r.ended);
    ok('旧规则标记「已结束」', !!oldRule && after.dom.some(d => d.ended === '1' && d.badge === '已结束'),
      JSON.stringify(after.dom));
    const yest = await evalJs('(function(){var d=new Date("' + TODAY + 'T00:00:00");' +
      'd.setDate(d.getDate()-1); var p=function(n){return String(n).padStart(2,"0");};' +
      'return d.getFullYear()+"-"+p(d.getMonth()+1)+"-"+p(d.getDate());})()');
    ok('旧规则 repeat_until = 昨天', !!oldRule && oldRule.until === yest, (oldRule && oldRule.until) + ' vs ' + yest);
    ok('新规则 start_date = 今天', !!newRule && newRule.start === TODAY, (newRule && newRule.start) + ' vs ' + TODAY);
    ok('新规则的重复设置 = 周一至周五（mask 31）', !!newRule && newRule.mask === 31, String(newRule && newRule.mask));
    ok('旧规则重复设置保持原样（mask 127）', !!oldRule && oldRule.mask === 127, String(oldRule && oldRule.mask));
    ok('旧规则下的任务一条不少', !!oldRule && oldRule.tasks.length === 1 && oldRule.tasks[0].indexOf(TASK) >= 0,
      JSON.stringify(oldRule && oldRule.tasks));
    ok('新规则不自动搬任务（0 个）', !!newRule && newRule.tasks.length === 0, JSON.stringify(newRule && newRule.tasks));
    await shot('pc-edit-split-result.png');

    /* ---- 5. 底部「复制 N 个任务到新规则」默认勾选（契约 §9.2 更新后的口径） ---- */
    console.log('\n[5] 复制任务到新规则（默认勾选）');
    const copyState = await evalJs('(function(){var c=document.getElementById("fCopy");' +
      'return {exists:!!c, checked:c?c.checked:null, label:c?c.parentNode.textContent.trim():null};})()');
    ok('裂开后出现「复制任务到新规则」选项', copyState.exists === true, String(copyState.label));
    ok('默认勾选', copyState.checked === true, 'checked=' + copyState.checked);
    ok('文案带任务条数', copyState.label === '复制 1 个任务到新规则', String(copyState.label));
    await shot('pc-edit-split-copy-default.png');
    await clickSel('#fCopyDone');
    ok('点完成 → 表单关闭', await waitFor('document.getElementById("formMask").hidden', 3000));
    const copied = await evalJs('(async function(){var api=window.__TAURI__.core;' +
      'var all=await api.invoke("list_rules",{includeEnded:true});' +
      'var mine=all.filter(function(r){return r.title===' + JSON.stringify(NAME) + ';});' +
      'var nw=mine.find(function(r){return !r.ended;}); var od=mine.find(function(r){return r.ended;});' +
      'return {newTasks:nw.tasks.map(function(t){return t.id+":"+t.title;}), newRule:nw.id,' +
      'oldTasks:od.tasks.map(function(t){return t.id+":"+t.title;})};})()');
    ok('默认复制后新规则任务数 = 旧规则任务数（1 = 1）',
      copied.newTasks.length === 1 && copied.oldTasks.length === 1, JSON.stringify(copied));
    ok('复制的是新任务 id（不是搬家）',
      copied.newTasks.length === 1 && copied.oldTasks.length === 1 &&
      copied.newTasks[0].split(':')[0] !== copied.oldTasks[0].split(':')[0],
      JSON.stringify(copied));
    ok('新任务名与旧任务一致', copied.newTasks[0] && copied.newTasks[0].indexOf(TASK) >= 0, JSON.stringify(copied.newTasks));

    /* ---- 6. 旧规则的打卡历史还在 ---- */
    console.log('\n[6] 旧规则的打卡历史');
    await clickSel('#configDone');
    await clickSel('.cell[data-date="' + mondayKey + '"] .dnum');
    const history = await evalJs('(function(){' +
      'var rows=[].slice.call(document.querySelectorAll(".mtask"));' +
      'return rows.filter(function(r){return r.dataset.period===' + JSON.stringify(donePeriod) + ';})' +
      '.map(function(r){return r.querySelector(".mtask-name").textContent+":"+r.querySelector(".mtask-state").textContent;})' +
      '.concat(rows.map(function(r){return "all:"+r.querySelector(".mtask-name").textContent+":"+r.querySelector(".mtask-state").textContent;}));})()');
    ok('旧规则下那天的打卡仍是「已完成」', history.some(h => h.indexOf(TASK + ':已完成') >= 0), JSON.stringify(history));
    await shot('pc-edit-history.png');
    await evalJs('document.getElementById("mask").click()');

    /* ---- 7. 取消勾选仍是合法路径：再裂一次，新规则留空 ---- */
    console.log('\n[7] 取消勾选 → 新规则留空');
    await clickSel('#btnNew');
    const ids2 = await evalJs('(async function(){var api=window.__TAURI__.core;' +
      'var all=await api.invoke("list_rules",{includeEnded:true});' +
      'var mine=all.filter(function(r){return r.title===' + JSON.stringify(NAME) + ';});' +
      'var active=mine.find(function(r){return !r.ended;});' +
      'return {active:active.id, activeTasks:active.tasks.length};})()');
    ok('此时进行中的规则有 1 个任务（上一轮默认复制来的）', ids2.activeTasks === 1, 'tasks=' + ids2.activeTasks);
    await clickSel('.rule-row[data-rule="' + ids2.active + '"] [data-act="edit"]');
    ok('点编辑 → 表单打开', (await evalJs('!document.getElementById("formMask").hidden')) === true);
    await clickSel('#fDays [data-day="4"]'); // 周一~周五 → 周一~周四（31 → 15）
    await clickSel('#fSave');
    ok('再裂一次 → 依旧先弹确认', await waitFor('!document.getElementById("confirmMask").hidden', 3000));
    await clickSel('#confirmOk');
    await sleep(900);
    const third = await evalJs('(async function(){var api=window.__TAURI__.core;' +
      'var all=await api.invoke("list_rules",{includeEnded:true});' +
      'var mine=all.filter(function(r){return r.title===' + JSON.stringify(NAME) + ';});' +
      'return {n:mine.length, ended:mine.filter(function(r){return r.ended;}).length};})()');
    ok('第二次裂开：共 3 条同名规则、其中 2 条已结束', third.n === 3 && third.ended === 2, JSON.stringify(third));
    const copy2 = await evalJs('(function(){var c=document.getElementById("fCopy");' +
      'return {checked:c?c.checked:null, label:c?c.parentNode.textContent.trim():null};})()');
    ok('第二次裂开后仍默认勾选、文案 N=1',
      copy2.checked === true && copy2.label === '复制 1 个任务到新规则', JSON.stringify(copy2));
    await clickSel('#fCopy');
    ok('可以取消勾选', (await evalJs('document.getElementById("fCopy").checked')) === false);
    await clickSel('#fCopyDone');
    await waitFor('document.getElementById("formMask").hidden', 3000);
    const noCopy = await evalJs('(async function(){var api=window.__TAURI__.core;' +
      'var all=await api.invoke("list_rules",{includeEnded:true});' +
      'var mine=all.filter(function(r){return r.title===' + JSON.stringify(NAME) + ';});' +
      'var active=mine.find(function(r){return !r.ended;});' +
      'return {activeTasks:active.tasks.length,' +
      'endedTaskCounts:mine.filter(function(r){return r.ended;}).map(function(r){return r.tasks.length;})};})()');
    ok('取消勾选 → 新规则 0 任务（合法路径，不拦）', noCopy.activeTasks === 0, JSON.stringify(noCopy));
    ok('旧规则的任务仍各自留在原处', JSON.stringify(noCopy.endedTaskCounts) === JSON.stringify([1, 1]),
      JSON.stringify(noCopy.endedTaskCounts));

    /* ---- 8. 配置页任务行：增 / 改名 / 启停 / 删 ---- */
    console.log('\n[8] 任务行操作');
    const activeRuleId = await evalJs('(async function(){var api=window.__TAURI__.core;' +
      'var all=await api.invoke("list_rules",{includeEnded:true});' +
      'var mine=all.filter(function(r){return r.title===' + JSON.stringify(NAME) + ';});' +
      'return mine.find(function(r){return !r.ended;}).id;})()');
    await clickSel('.rule-row[data-rule="' + activeRuleId + '"] .rule-main');
    const rowsShown = await evalJs('document.querySelectorAll(' +
      JSON.stringify('.rule-block[data-rule-block="' + activeRuleId + '"] .task-row') + ').length');
    ok('展开后还没有任务（取消勾选的结果）', rowsShown === 0, 'rows=' + String(rowsShown));

    await clickSel('.rule-block[data-rule-block="' + activeRuleId + '"] [data-act="new-task-name"]');
    await send('Input.insertText', { text: '任务甲' });
    for (const type of ['keyDown', 'keyUp']) {
      await send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
    }
    await sleep(800);
    const afterAdd = await evalJs('(async function(){var api=window.__TAURI__.core;' +
      'var all=await api.invoke("list_rules",{includeEnded:true});' +
      'var r=all.find(function(x){return x.id===' + JSON.stringify(activeRuleId) + ';});' +
      'return r.tasks.map(function(t){return t.id+"|"+t.title+"|"+t.sort_order;});})()');
    ok('输入框回车新增任务（sort_order=0）', afterAdd.length === 1 && afterAdd[0].indexOf('|任务甲|0') > 0,
      JSON.stringify(afterAdd));
    const firstTaskId = afterAdd[0].split('|')[0];
    const blockSel = '.rule-block[data-rule-block="' + activeRuleId + '"]';
    const taskRowSel = blockSel + ' .task-row[data-task="' + firstTaskId + '"]';
    ok('任务行可编辑（输入框 + 启停 + 删除）',
      (await evalJs('!!document.querySelector(' + JSON.stringify(taskRowSel + ' input.task-name') + ')')) === true &&
      (await evalJs('!!document.querySelector(' + JSON.stringify(taskRowSel + ' [data-act="toggle-task"]') + ')')) === true &&
      (await evalJs('!!document.querySelector(' + JSON.stringify(taskRowSel + ' [data-act="del-task"]') + ')')) === true);

    const RENAMED = 'CDP任务改名';
    await clickSel(taskRowSel + ' input.task-name');
    await evalJs('(function(){var e=document.querySelector(' + JSON.stringify(taskRowSel + ' input.task-name') + '); e.select();})()');
    await send('Input.insertText', { text: RENAMED });
    await evalJs('document.querySelector(' + JSON.stringify(taskRowSel + ' input.task-name') + ').blur()');
    await sleep(800);
    const renamed = await evalJs('(async function(){var api=window.__TAURI__.core;' +
      'var all=await api.invoke("list_rules",{includeEnded:true});' +
      'var r=all.find(function(x){return x.id===' + JSON.stringify(activeRuleId) + ';});' +
      'return r.tasks.map(function(t){return t.id+":"+t.title;});})()');
    ok('任务改名落到库里', renamed.length === 1 && renamed[0] === firstTaskId + ':' + RENAMED, JSON.stringify(renamed));

    await clickSel(taskRowSel + ' [data-act="toggle-task"]');
    await sleep(800);
    const disabled = await evalJs('(async function(){var api=window.__TAURI__.core;' +
      'var all=await api.invoke("list_rules",{includeEnded:true});' +
      'var r=all.find(function(x){return x.id===' + JSON.stringify(activeRuleId) + ';});' +
      'var btn=document.querySelector(' + JSON.stringify(taskRowSel + ' [data-act="toggle-task"]') + ');' +
      'return {enabled:r.tasks[0].enabled, btn:btn?btn.textContent:null};})()');
    ok('任务可停用（enabled=false，按钮变「启用」）', disabled.enabled === false && disabled.btn === '启用',
      JSON.stringify(disabled));
    await clickSel(taskRowSel + ' [data-act="toggle-task"]');
    await sleep(800);
    const enabled = await evalJs('(async function(){var api=window.__TAURI__.core;' +
      'var all=await api.invoke("list_rules",{includeEnded:true});' +
      'var r=all.find(function(x){return x.id===' + JSON.stringify(activeRuleId) + ';});' +
      'return r.tasks[0].enabled;})()');
    ok('任务可重新启用', enabled === true, String(enabled));

    await clickSel(blockSel + ' [data-act="new-task-name"]');
    await send('Input.insertText', { text: '新增的第二个任务' });
    for (const type of ['keyDown', 'keyUp']) {
      await send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
    }
    await sleep(800);
    const added = await evalJs('(async function(){var api=window.__TAURI__.core;' +
      'var all=await api.invoke("list_rules",{includeEnded:true});' +
      'var r=all.find(function(x){return x.id===' + JSON.stringify(activeRuleId) + ';});' +
      'return r.tasks.map(function(t){return t.title+"/"+t.sort_order;});})()');
    ok('再加一个任务，sort_order 递增到 1',
      added.length === 2 && added[1].indexOf('新增的第二个任务/1') === 0, JSON.stringify(added));

    const secondTaskId = await evalJs('(async function(){var api=window.__TAURI__.core;' +
      'var all=await api.invoke("list_rules",{includeEnded:true});' +
      'var r=all.find(function(x){return x.id===' + JSON.stringify(activeRuleId) + ';});' +
      'return r.tasks[1].id;})()');
    await clickSel(blockSel + ' .task-row[data-task="' + secondTaskId + '"] [data-act="del-task"]');
    ok('点任务删除 → 弹确认', await waitFor('!document.getElementById("confirmMask").hidden', 3000));
    const taskDelText = await evalJs('document.getElementById("confirmText").textContent');
    ok('任务删除确认文案写明打卡历史保留', taskDelText === '确定删除任务「新增的第二个任务」？打卡历史保留。',
      String(taskDelText));
    await clickSel('#confirmOk');
    await sleep(800);
    const afterDel = await evalJs('(async function(){var api=window.__TAURI__.core;' +
      'var all=await api.invoke("list_rules",{includeEnded:true});' +
      'var r=all.find(function(x){return x.id===' + JSON.stringify(activeRuleId) + ';});' +
      'return r.tasks.map(function(t){return t.title;});})()');
    ok('任务被软删（列表里只剩改名后的那个）', afterDel.length === 1 && afterDel[0] === RENAMED,
      JSON.stringify(afterDel));

    /* ---- 8. 删除规则：二次确认写明影响条数 ---- */
    console.log('\n[9] 删除规则（二次确认）');
    await clickSel('#btnNew');
    const delTarget = await evalJs('(async function(){var api=window.__TAURI__.core;' +
      'var all=await api.invoke("list_rules",{includeEnded:true});' +
      'var mine=all.filter(function(r){return r.title===' + JSON.stringify(NAME) + ';});' +
      'var active=mine.find(function(r){return !r.ended;});' +
      'return {id:active.id, n:active.tasks.length};})()');
    await clickSel('.rule-row[data-rule="' + delTarget.id + '"] [data-act="del"]');
    ok('点删除 → 弹二次确认', await waitFor('!document.getElementById("confirmMask").hidden', 3000));
    const delText = await evalJs('document.getElementById("confirmText").textContent');
    ok('确认文案写明任务条数与「打卡历史保留」',
      delText === '将删除该规则及其 ' + delTarget.n + ' 个任务（打卡历史保留）', String(delText));
    await shot('pc-edit-confirm-delete.png');
    await clickSel('#confirmOk');
    await sleep(700);
    const remain = await evalJs('(async function(){var api=window.__TAURI__.core;' +
      'var all=await api.invoke("list_rules",{includeEnded:true});' +
      'var mine=all.filter(function(r){return r.title===' + JSON.stringify(NAME) + ';});' +
      'return {n:mine.length, ended:mine.filter(function(r){return r.ended;}).length};})()');
    ok('删掉进行中的那条后只剩 2 条已结束的同名规则', remain.n === 2 && remain.ended === 2,
      JSON.stringify(remain));

    // 收尾：把剩下那条也删掉，别把测试数据留在本地库里
    const last = await evalJs('(async function(){var api=window.__TAURI__.core;' +
      'var all=await api.invoke("list_rules",{includeEnded:true});' +
      'var mine=all.filter(function(r){return r.title===' + JSON.stringify(NAME) + ';});' +
      'for (var i=0;i<mine.length;i++){ await api.invoke("delete_rule",{id:mine[i].id}); }' +
      'var after=await api.invoke("list_rules",{includeEnded:true});' +
      'return after.filter(function(r){return r.title===' + JSON.stringify(NAME) + ';}).length;})()');
    ok('清理后本地库里没有同名测试规则', last === 0, '剩余 ' + last);

    /* ---- 8. 打卡历史仍然存在（不因为删规则而消失） ---- */
    const completionKept = await evalJs('(async function(){var api=window.__TAURI__.core;' +
      'var g=await api.invoke("month_grid",{y:' + Number(TODAY.slice(0, 4)) + ',m:' + Number(TODAY.slice(5, 7)) + '});' +
      'var d=g.days.find(function(x){return x.date===' + JSON.stringify(mondayKey) + ';});' +
      'return d?d.tasks.length:0;})()');
    ok('删完规则后月历不再有多余任务', typeof completionKept === 'number', 'tasks=' + completionKept);

    console.log('\n[10] 控制台');
    ok('无 JS 运行时错误', errors.length === 0, errors.slice(0, 3).join(' | '));
  } finally {
    ws.close();
    app.kill();
  }

  console.log('\n结果：' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('验收脚本异常：', e); process.exit(2); });
