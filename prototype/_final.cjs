/* Took 双端原型总验收（2026-10-19 末版） */
const { openPage, sleep } = require('./_cdp.cjs');
const R = [];
const check = (scope, name, pass, detail) => R.push({ scope: scope, name: name, pass: !!pass, detail: String(detail === undefined ? '' : detail).slice(0, 130) });

const vis = sel => "(function(){ var el = document.querySelector(" + JSON.stringify(sel) + "); if (!el) return false;" +
  " return el.offsetParent !== null && getComputedStyle(el).display !== 'none' && getComputedStyle(el).visibility !== 'hidden'; })()";
const center = sel => "(function(){ var e = document.querySelector(" + JSON.stringify(sel) + "); if (!e) return null;" +
  " e.scrollIntoView({ block: 'center' }); var r = e.getBoundingClientRect();" +
  " return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width }; })()";
async function tap(page, sel) { const p = await page.evalJs(center(sel)); if (!p || p.w === 0) return false; await page.click(p.x, p.y); await sleep(450); return true; }
async function tapExpr(page, expr) {
  const p = await page.evalJs("(function(){ var e = " + expr + "; if (!e) return null;" +
    " e.scrollIntoView({ block: 'center' }); var r = e.getBoundingClientRect();" +
    " return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width }; })()");
  if (!p || p.w === 0) return false;
  await page.click(p.x, p.y);
  await sleep(450);
  return true;
}

(async () => {
  /* ═════ PC ═════ */
  const pc = await openPage('pc.html', 1400, 950);
  check('PC', '日历 42 格', await pc.evalJs("document.querySelectorAll('[data-date]').length") === 42, '');
  await tap(pc, '[data-date="2026-10-19"] .dnum');
  check('PC', '点日期开面板', await pc.evalJs(vis('[role="dialog"]')), '');
  const row = await pc.evalJs("(function(){ var d = Array.from(document.querySelectorAll('[role=\"dialog\"]')).filter(function(x){ return getComputedStyle(x).display !== 'none'; }).pop();" +
    " if (!d) return null; var b = Array.from(d.querySelectorAll('button')).find(function(x){ return x.textContent.indexOf('早起') >= 0; });" +
    " if (!b) return null; var r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()");
  if (row) { await pc.click(row.x, row.y); await sleep(280); }
  check('PC', '打卡放烟花', await pc.evalJs("document.querySelectorAll('canvas').length") >= 1, '');
  check('PC', '完成提示卡', await pc.evalJs("document.body.innerText.indexOf('已完成') >= 0"), '');
  await sleep(1100);
  await pc.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
  await pc.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
  await sleep(430);
  check('PC', 'Esc 关闭面板', !(await pc.evalJs(vis('[role="dialog"]'))), '');
  await tap(pc, '[data-date="2026-10-21"] .tag');
  check('PC', '任务名不可点', !(await pc.evalJs(vis('[role="dialog"]'))), '');
  await pc.evalJs("document.getElementById('btnSettings').click()");
  await sleep(620);
  const nav = await pc.evalJs("Array.from(document.querySelectorAll('#setNav button')).map(function(b){ return b.textContent.trim(); })");
  check('PC', '设置已移除任务规则项', nav.indexOf('任务规则') < 0 && nav[0] === '常规', nav.join('/'));
  const toolbar = await pc.evalJs("Array.from(document.querySelectorAll('.topbar button[id]')).map(function(b){ return b.id; })");
  check('PC', '工具条四图标：统计 / ＋ / 收起 / 齿轮', toolbar.join(',') === 'btnAnalysis,btnNew,btnCollapse,btnSettings', toolbar.join(','));
  await pc.evalJs("document.getElementById('setDone').click()");
  await sleep(500);
  await pc.evalJs("document.getElementById('btnNew').click()");
  await sleep(650);
  await pc.evalJs("document.querySelector('[data-select-toggle], #btnSelect').click()");
  await sleep(440);
  const selPc = await pc.evalJs("(function(){ var f = document.querySelector('.fab');" +
    " return { cls: f.className, aria: f.getAttribute('aria-label'), circles: document.querySelectorAll('.rule-row .circle').length }; })()");
  check('PC', '三缸→FAB 变删除', /del/.test(selPc.cls) && selPc.aria === '删除所选项', JSON.stringify(selPc));
  check('PC', '控制台零报错', pc.errors.length === 0, pc.errors[0] || '');
  await pc.close();

  /* ═════ Android ═════ */
  const an = await openPage('android.html', 900, 1000);
  check('Android', '今天红圈', /today/.test(String(await an.evalJs("document.querySelector('[data-date=\"2026-10-19\"] .dnum').className"))), '');
  // 不能写死某一天：该天可能两个任务都已打卡。改为扫描全部格子，
  // 断言不存在「已完成 tag 排在未完成 tag 之前」的情况。
  check('Android', '标准档未完成优先', await an.evalJs("(function(){ var bad=[];"
    + " document.querySelectorAll('[data-date]').forEach(function(c){ var ts=Array.from(c.querySelectorAll('.tag'));"
    + " var f=ts.map(function(t){ return t.classList.contains('done'); });"
    + " for (var i=1;i<f.length;i++){ if (f[i-1]===true && f[i]===false) bad.push(c.dataset.date); } });"
    + " return bad.length===0; })()"), '');
  await an.evalJs("document.getElementById('densityToggle').click()");
  await sleep(460);
  const cmp = await an.evalJs("(function(){ var c = document.querySelector('[data-date=\"2026-10-19\"]');" +
    " return { names: Array.from(c.querySelectorAll('.tag')).map(function(t){ return t.textContent; })," +
    " more: (c.querySelector('.more') || {}).textContent, dots: c.querySelectorAll('.dot').length }; })()");
  check('Android', '紧凑档 1名+N+圆点', cmp.names.length === 1 && cmp.dots >= 1, JSON.stringify(cmp));
  await an.evalJs("document.getElementById('densityToggle').click()");
  await sleep(380);
  await tap(an, '[data-date="2026-10-21"] .tag');
  check('Android', '任务名不可点', !(await an.evalJs(vis('[role="dialog"]'))), '');
  await tap(an, '[data-date="2026-10-19"] .dnum');
  check('Android', '点日期开面板', await an.evalJs(vis('[role="dialog"]')), '');
  await an.evalJs("(function(){ var b = Array.from(document.querySelectorAll('button')).find(function(x){ return x.getAttribute('aria-label') === '关闭'; }); if (b) b.click(); })()");
  await sleep(420);
  await an.evalJs("Array.from(document.querySelectorAll('[role=\"tab\"]')).find(function(b){ return b.getAttribute('data-tab') === 'config'; }).click()");
  await sleep(560);
  // 种子已扩充（记事加入了时间段与不排期样例），不再写死总行数，
  // 改为按类型分别核对，这样种子增删不会误报。
  const kindCount = await an.evalJs(`(function(){ var m={rule:0,note:0,countdown:0,notebook:0};
    document.querySelectorAll('.rule-row').forEach(function(r){
      var t=r.innerText;
      if (t.indexOf('记事')>=0) m.note++; else if (t.indexOf('倒数日')>=0) m.countdown++;
      else if (t.indexOf('笔记')>=0) m.notebook++; else m.rule++;
    }); return m; })()`);
  check('Android', '配置页按类型分行数正确', kindCount.rule >= 8 && kindCount.note >= 2 && kindCount.countdown >= 1, JSON.stringify(kindCount));
  const barBtns = await an.evalJs("Array.from(document.querySelectorAll('#configBar button')).map(function(b){ return b.textContent.trim(); })");
  check('Android', '应用栏无「选择」文字按钮', !barBtns.some(function(t){ return t === '选择'; }), JSON.stringify(barBtns));
  const t0 = await an.evalJs("(function(){ var n = document.querySelector('.tabbar'); return n ? getComputedStyle(n).transform : 'no-nav'; })()");
  await an.evalJs("document.getElementById('selectToggle').click()");
  await sleep(470);
  const selAn = await an.evalJs("(function(){ var f = document.querySelector('#fab');" +
    " return { circles: document.querySelectorAll('.sel-circle').length, cls: f.className, aria: f.getAttribute('aria-label') }; })()");
  check('Android', '三缸进入选择态', selAn.circles > 0 && /danger/.test(selAn.cls), JSON.stringify(selAn));
  const t1 = await an.evalJs("(function(){ var n = document.querySelector('.tabbar'); return n ? getComputedStyle(n).transform : 'no-nav'; })()");
  check('Android', '三缸不再隐藏导航', t0 === t1, t0 + ' vs ' + t1);
  await an.evalJs("document.getElementById('selectToggle').click()");
  await sleep(430);
  await tapExpr(an, "Array.from(document.querySelectorAll('[role=\"tab\"]')).find(function(b){ return b.getAttribute('data-tab') === 'settings'; })");
  await sleep(400);
  const inSet = await an.evalJs("(function(){ var s = document.getElementById('settingsPage'); return s ? !s.hidden : false; })()");
  const groups = await an.evalJs("Array.from(document.querySelectorAll('#settingsPage .group-title')).map(function(e){ return e.textContent.trim(); })");
  check('Android', '设置页六组', inSet && ['常规','外观','提醒','导航设置','数据','关于'].every(function(g){ return groups.join().indexOf(g) >= 0; }), groups.join('/'));
  check('Android', '控制台零报错', an.errors.length === 0, an.errors[0] || '');
  await an.close();

  const pass = R.filter(r => r.pass).length;
  console.log(JSON.stringify({ pass: pass, total: R.length, fails: R.filter(r => !r.pass), results: R }, null, 2));
})();