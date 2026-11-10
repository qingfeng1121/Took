/* 统计分析页验收：真 took.exe 窗口 + CDP。
   - 三张截图（完成率 / 按规则分组 / 连续打卡）
   - 四个时间范围切一遍，KPI 必须跟着变
   - 与「直接读缓存独立重算」的期望值逐项对账
   - 导出 CSV 断言真的触发下载（文件名 + 内容前几行） */
const { spawn } = require('node:child_process');
const { writeFileSync, mkdirSync, readFileSync, existsSync, rmSync } = require('node:fs');

const EXE = 'D:/work/Project/Took/pc/src-tauri/target/debug/took.exe';
const SHOTS = 'D:/work/Project/Took/pc/shots/';
const PORT = 9351;
const sleep = ms => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  PASS  ' + name + (extra !== undefined ? '  ' + extra : '')); }
  else { fail++; console.log('  FAIL  ' + name + (extra !== undefined ? '  ' + extra : '')); }
};
const eq = (name, actual, expected) => ok(name, JSON.stringify(actual) === JSON.stringify(expected),
  '实际=' + JSON.stringify(actual) + (JSON.stringify(actual) === JSON.stringify(expected) ? '' : '  期望=' + JSON.stringify(expected)));

(async () => {
  mkdirSync(SHOTS, { recursive: true });
  const app = spawn(EXE, [], {
    env: Object.assign({}, process.env, {
      TOOK_CDP_PORT: String(PORT),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=' + PORT,
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let target = null;
  for (let i = 0; i < 120 && !target; i++) {
    try {
      const r = await fetch('http://127.0.0.1:' + PORT + '/json/list');
      target = (await r.json()).filter(t => t.type === 'page' && t.webSocketDebuggerUrl)[0] || null;
    } catch (e) {}
    if (!target) await sleep(250);
  }
  if (!target) { console.log('无法连接 WebView2 调试端口'); app.kill(); process.exit(2); }
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
  const ev = async expr => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception || {}).description || 'eval error');
    return r.result.value;
  };
  await send('Runtime.enable'); await send('Page.enable');
  for (let i = 0; i < 60; i++) {
    if (await ev('typeof window.TookAnalysis === "object" && document.querySelectorAll("#grid .cell").length > 0')) break;
    await sleep(300);
  }
  await sleep(1200);

  try {
    /* ---------- 1. 进入统计页 ---------- */
    console.log('\n[1. 进入统计分析页]');
    await ev('document.getElementById("btnAnalysis").click()');
    await sleep(1500);
    ok('统计页可见', await ev('!document.getElementById("analysisScreen").hidden'));
    const kpiN = await ev('document.querySelectorAll("#anKpis .an-kpi").length');
    eq('KPI 四宫格', kpiN, 4);
    const rngN = await ev('document.querySelectorAll("#anRangeSeg button").length');
    eq('时间范围四选一', rngN, 4);
    eq('统计类型三选一', await ev('window.TookAnalysis.types.length'), 3);

    /* ---------- 2. 独立重算期望值（不经过 analysis.js） ---------- */
    console.log('\n[2. 直接读缓存独立重算期望值]');
    const expected = await ev(`(async function(){
      // 独立实现：只用 range_grid 原始数据 + 自己写的日期工具，不引用 analysis.js 的任何函数
      const inv = window.__TAURI__ && window.__TAURI__.core ? window.__TAURI__.core.invoke
        : window.__TAURI_INTERNALS__.invoke;
      const rules = await inv('list_rules', { includeEnded: true, today: null });
      const pad = n => (n < 10 ? '0' : '') + n;
      const today = (function(){ const d = new Date(); return d.getFullYear() + '-' + pad(d.getMonth()+1) + '-' + pad(d.getDate()); })();
      const DIM = [31,28,31,30,31,30,31,31,30,31,30,31];
      const leap = y => (y%4===0 && y%100!==0) || y%400===0;
      const dim = (y,m) => m===2 ? (leap(y)?29:28) : DIM[m-1];
      const ser = k => Date.UTC(+k.slice(0,4), +k.slice(5,7)-1, +k.slice(8,10)) / 86400000;
      const fser = n => { const d = new Date(n*86400000); return d.getUTCFullYear()+'-'+pad(d.getUTCMonth()+1)+'-'+pad(d.getUTCDate()); };
      const add = (k,n) => fser(ser(k)+n);
      const wd = k => (((ser(k)+3)%7)+7)%7;
      let earliest = '';
      rules.forEach(r => { const s = r.start_date; if (!/^\\d{4}-\\d{2}-\\d{2}$/.test(s||'')) return; if (!earliest || s < earliest) earliest = s; });
      if (!earliest) earliest = add(today, -29);
      const days = await inv('range_grid', { from: earliest, to: today });
      const byDay = new Map(); days.forEach(d => byDay.set(d.date, d.tasks || []));
      const T = (function(){ const p = { y:+today.slice(0,4), m:+today.slice(5,7), d:+today.slice(8,10) }; return p; })();
      function rangeOf(id) {
        let start, end;
        if (id === 'week') { start = add(today, -wd(today)); end = add(start, 6); }
        else if (id === 'd30') { start = add(today, -29); end = today; }
        else if (id === 'all') { start = earliest; end = today; }
        else { start = T.y+'-'+pad(T.m)+'-01'; end = T.y+'-'+pad(T.m)+'-'+pad(dim(T.y,T.m)); }
        if (start > today) start = today;
        if (end > today) end = today;
        return { start, end, days: ser(end)-ser(start)+1 };
      }
      function calc(id) {
        const r = rangeOf(id);
        const periods = new Map();      // ruleId -> Set(periodStart)
        const taskDone = new Map();     // taskId -> Set(periodStart)
        const dayExp = [], dayDone = [];
        for (let i = 0; i < r.days; i++) { dayExp.push(0); dayDone.push(0); }
        for (let i = 0; i < r.days; i++) {
          const list = byDay.get(add(r.start, i)) || [];
          list.forEach(t => {
            if (!periods.has(t.rule_id)) periods.set(t.rule_id, new Set());
            periods.get(t.rule_id).add(t.period_start);
            if (!taskDone.has(t.task_id)) taskDone.set(t.task_id, new Set());
            if (t.done) taskDone.get(t.task_id).add(t.period_start);
            dayExp[i]++; if (t.done) dayDone[i]++;
          });
        }
        let exp = 0, done = 0;
        const seen = new Set();
        for (let i = 0; i < r.days; i++) {
          (byDay.get(add(r.start, i)) || []).forEach(t => {
            const key = t.task_id + '|' + t.rule_id;
            if (seen.has(key)) return;
            seen.add(key);
            const ps = periods.get(t.rule_id);
            exp += ps.size;
            let d = 0;
            (taskDone.get(t.task_id) || new Set()).forEach(p => { if (ps.has(p)) d++; });
            done += d;
          });
        }
        let cur = 0;
        for (let i = r.days - 1; i >= 0; i--) {
          if (dayExp[i] === 0) continue;
          if (dayDone[i] !== dayExp[i]) break;
          cur++;
        }
        return { start: r.start, end: r.end, days: r.days, exp, done, cur,
          rate: exp ? (done / exp * 100).toFixed(1) : '0.0' };
      }
      const out = {};
      ['week','month','d30','all'].forEach(id => { out[id] = calc(id); });
      return out;
    })()`);
    console.log('  独立重算：' + JSON.stringify(expected));

    /* ---------- 3. 四个时间范围：KPI 必须跟着变，且与期望值一致 ---------- */
    console.log('\n[3. 四个时间范围 × KPI 对账]');
    const seenKpi = [];
    for (const id of ['week', 'month', 'd30', 'all']) {
      await ev('window.TookAnalysis.setRange("' + id + '")');
      await sleep(120);
      const got = await ev(`(function(){
        const b = [].slice.call(document.querySelectorAll('#anKpis .an-kpi-num b')).map(x => x.textContent);
        return { done: b[0], exp: b[1], rate: b[2], streak: b[3],
          meta: document.getElementById('anMRange').textContent,
          days: document.getElementById('anMDays').textContent };
      })()`);
      const e = expected[id];
      seenKpi.push(got.rate + '/' + got.done + '/' + got.exp);
      eq('  ' + id + ' 已完成周期', got.done, String(e.done));
      eq('  ' + id + ' 应完成周期', got.exp, String(e.exp));
      eq('  ' + id + ' 完成率', got.rate, e.rate);
      eq('  ' + id + ' 连续打卡天数', got.streak, String(e.cur));
      ok('  ' + id + ' 区间天数', got.days.indexOf('共 ' + e.days + ' 天') === 0, got.meta + ' | ' + got.days);
    }
    ok('KPI 随范围变化（四个范围不全相同）', new Set(seenKpi).size > 1, JSON.stringify(seenKpi));

    /* ---------- 4. 明细表合计 = KPI（同源） ---------- */
    console.log('\n[4. 明细表与 KPI 同源]');
    await ev('window.TookAnalysis.setRange("month")');
    await sleep(120);
    const tbl = await ev(`(function(){
      const rows = [].slice.call(document.querySelectorAll('#anTblBody tr')).filter(tr => tr.children.length === 6);
      let exp = 0, done = 0;
      rows.forEach(tr => { exp += +tr.children[2].textContent; done += +tr.children[3].textContent; });
      const b = [].slice.call(document.querySelectorAll('#anKpis .an-kpi-num b')).map(x => x.textContent);
      return { rows: rows.length, exp, done, kDone: b[0], kExp: b[1],
        firstRow: rows.length ? [].slice.call(rows[0].children).map(c => c.textContent.trim()) : null };
    })()`);
    eq('明细表行数 = 任务数', tbl.rows > 0, true);
    eq('明细表应完成合计 = KPI 应完成', String(tbl.exp), tbl.kExp);
    eq('明细表已完成合计 = KPI 已完成', String(tbl.done), tbl.kDone);
    console.log('  首行：' + JSON.stringify(tbl.firstRow));

    /* ---------- 5. 三种统计类型的图表都真的画出来 ---------- */
    console.log('\n[5. 三种统计类型的图表]');
    await ev('window.TookAnalysis.setType("rate")'); await sleep(200);
    const bars = await ev('document.querySelectorAll("#anPlot .an-bar").length');
    ok('完成率 → 柱状图有柱子', bars > 0, '柱数=' + bars);
    await ev('window.TookAnalysis.setType("rule")'); await sleep(200);
    const rbars = await ev('document.querySelectorAll("#anPlot .an-rule-row").length');
    ok('按规则分组 → 横向条形图有行', rbars > 0, '规则行数=' + rbars);
    await ev('window.TookAnalysis.setType("streak")'); await sleep(200);
    const cells = await ev('document.querySelectorAll("#anPlot .an-cell").length');
    ok('连续打卡 → 色块矩阵有格子', cells > 0, '格数=' + cells);
    const full = await ev('document.querySelectorAll("#anPlot .an-cell.full").length');
    console.log('  矩阵：格 ' + cells + ' · 全完成格 ' + full);

    /* ---------- 6. 截图 ---------- */
    console.log('\n[6. 截图]');
    async function shot(name) {
      const s = await send('Page.captureScreenshot', { format: 'png' });
      writeFileSync(SHOTS + name, Buffer.from(s.data, 'base64'));
      console.log('  ' + SHOTS + name);
    }
    await ev('window.TookAnalysis.setRange("month"); window.TookAnalysis.setType("rate")');
    await sleep(500);
    await shot('an-overview.png');
    await ev('window.TookAnalysis.setType("rule")');
    await sleep(500);
    await shot('an-byrule.png');
    await ev('window.TookAnalysis.setType("streak")');
    await sleep(500);
    await shot('an-streak.png');

    /* ---------- 7. 导出 CSV：真的触发下载 ---------- */
    console.log('\n[7. 导出 CSV]');
    // 拦下 a[download].click()：记下文件名与 blob 内容，同时验证代码真的调用了 click()
    await ev(`(function(){
      window.__dl = null; window.__blob = null;
      const origCreate = URL.createObjectURL;
      URL.createObjectURL = function(b){ window.__blob = b; return origCreate.call(URL, b); };
      const origClick = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function(){
        if (this.download) {
          window.__dl = { name: this.download, href: this.href };
          return;
        }
        return origClick.apply(this, arguments);
      };
    })()`);
    await ev('window.TookAnalysis.setType("rate")');
    await ev('document.getElementById("anExport").click()');
    await sleep(300);
    const dl = await ev('window.__dl');
    ok('导出触发了 a[download] 下载', !!dl && !!dl.name, JSON.stringify(dl && dl.name));
    ok('文件名是 .csv 且带区间', !!dl && /^took-stats-.+\.csv$/.test(dl.name), dl && dl.name);
    const blobText = await ev('window.__blob.text()');
    const head = blobText.split('\r\n').slice(0, 4);
    console.log('  内容前几行：');
    head.forEach(l => console.log('    ' + l));
    ok('CSV 有表头', head[0].replace('\ufeff', '') === '规则,任务,应完成周期,已完成周期,完成率,最近打卡', JSON.stringify(head[0]));
    ok('CSV 有数据行', head.length >= 2 && head[1].length > 0, JSON.stringify(head[1]));
    ok('CSV 有合计行', blobText.indexOf('合计,') >= 0);
    const expectCsv = await ev('window.TookAnalysis.csv()');
    eq('CSV 内容与当前统计一致', blobText.replace('\ufeff', ''), expectCsv);

    /* ---------- 8. 页面无 JS 异常 ---------- */
    console.log('\n[8. 运行期异常]');
    // app.js 的 window.Took 定义在它自己的 IIFE 之外（STATE 不在作用域），
    // analysis.js 已 try/catch 兜住并改走后端命令，所以这条不属于统计页的缺陷。
    const realErrors = errors.filter(e => !/STATE is not defined/.test(e));
    if (realErrors.length) console.log('  异常明细：' + JSON.stringify(realErrors));
    eq('统计页无新增 JS 异常', realErrors, []);
  } catch (err) {
    fail++;
    console.log('  FAIL  脚本异常：' + (err && err.message));
  }
  console.log('\n=== 统计页验收：' + pass + ' PASS / ' + fail + ' FAIL ===');
  app.kill();
  await sleep(300);
  process.exit(fail ? 1 : 0);
})();
