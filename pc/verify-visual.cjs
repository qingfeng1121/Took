/* 视觉一致性：把 prototype/pc.html（已验收原型）与 pc/ui/index.html 同时渲染，
   逐项比对计算样式。只比月历相关组件与设计令牌，不比管理页/设置页/统计页。 */
const { spawn } = require('node:child_process');
const { mkdtempSync } = require('node:fs');
const { join } = require('node:path');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const sleep = ms => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0;
const ok = (name, a, b) => {
  const same = JSON.stringify(a) === JSON.stringify(b);
  if (same) { pass++; console.log('  PASS  ' + name + '  = ' + JSON.stringify(a)); }
  else { fail++; console.log('  FAIL  ' + name + '  原型=' + JSON.stringify(a) + '  当前=' + JSON.stringify(b)); }
};
/* 单边断言：只对当前实现成立、原型侧不适用（铺满改造后新增的设计项），
   所以不能拿原型值当期望值，期望值直接写在调用处。 */
const okMine = (name, actual, expected) => {
  const same = JSON.stringify(actual) === JSON.stringify(expected);
  if (same) { pass++; console.log('  PASS  ' + name + '  = ' + JSON.stringify(actual)); }
  else { fail++; console.log('  FAIL  ' + name + '  期望=' + JSON.stringify(expected) + '  当前=' + JSON.stringify(actual)); }
};

async function harvest(url, width, height) {
  const port = 19000 + Math.floor(Math.random() * 2000);
  const profile = mkdtempSync(join(process.env.TEMP, 'tookvis-'));
  const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=' + port,
    '--user-data-dir=' + profile, '--window-size=' + width + ',' + height, '--hide-scrollbars',
    '--force-device-scale-factor=1', '--no-first-run', '--no-default-browser-check',
    '--allow-file-access-from-files', url], { stdio: 'ignore' });
  let target = null;
  for (let i = 0; i < 80 && !target; i++) {
    try {
      const r = await fetch('http://127.0.0.1:' + port + '/json/list');
      const list = await r.json();
      target = list.filter(t => t.type === 'page' && t.webSocketDebuggerUrl)[0] || null;
    } catch (e) {}
    if (!target) await sleep(200);
  }
  if (!target) { chrome.kill(); throw new Error('no target'); }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let seq = 0; const pend = new Map();
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); } };
  const send = (method, params) => new Promise((resolve, reject) => { const id = ++seq; pend.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params: params || {} })); });
  const evalJs = async expr => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception || {}).description || 'eval error');
    return r.result.value;
  };
  await send('Runtime.enable'); await send('Page.enable');
  await sleep(1800);
  const out = await evalJs(`(function(){
    var root=getComputedStyle(document.documentElement);
    var vars={};
    ['--bg','--surface','--surface-2','--line','--text','--text-2','--text-3','--border','--today',
     '--accent','--accent-weak','--accent-line','--accent-text','--radius','--fs-ui','--fs-tag','--fs-day']
      .forEach(function(k){ vars[k]=root.getPropertyValue(k).trim(); });
    function cs(sel, props){
      var e=document.querySelector(sel);
      if(!e) return 'MISSING:'+sel;
      var s=getComputedStyle(e), o={};
      props.forEach(function(p){ o[p]=s.getPropertyValue(p); });
      return o;
    }
    var stage = document.querySelector('.stage');
    var cal = document.querySelector('.cal');
    return {
      vars: vars,
      stagePad: stage ? getComputedStyle(stage).padding : 'MISSING:.stage',
      topbar: !!document.querySelector('.topbar'),
      calFull: !!cal && Math.round(cal.getBoundingClientRect().width) === window.innerWidth,
      cal: cs('.cal', ['background-color','border-radius','padding-top','padding-right','padding-bottom','padding-left','box-shadow','gap']),
      cell: cs('.cell', ['border-radius','padding-top','padding-left','border-top-width','border-top-color','background-color']),
      dnum: cs('.dnum', ['width','height','border-radius','font-size','font-weight']),
      tag: cs('.tag', ['height','border-radius','font-size','font-weight','padding-left','padding-right','background-color','color','line-height']),
      tagDone: cs('.tag.done', ['background-color','color','font-weight']),
      weekHead: cs('.week-head div', ['font-size','font-weight','color'])
    };
  })()`);
  ws.close(); chrome.kill();
  return out;
}

(async () => {
  const proto = await harvest('file:///D:/work/Project/Took/prototype/pc.html', 1280, 1000);
  const mine = await harvest('file:///D:/work/Project/Took/pc/ui/index.html', 1280, 1000);

  console.log('\n[设计令牌]');
  Object.keys(proto.vars).forEach(k => ok(k, proto.vars[k], mine.vars[k]));

  /* .cal 不再逐项等于原型：2026-10-27 起日历「铺满整个屏幕」，卡片外观（白底 / 圆角 /
     阴影）按用户要求去掉，内外边距也换成自己的排版值。这里不是放宽，而是把比对基准
     从「原型卡片」换成「铺满语义」——每个属性都仍逐条断言，只是期望值来自新设计。 */
  console.log('\n[月历容器 .cal（铺满：无卡片外观）]');
  const FULL = {
    'background-color': 'rgba(0, 0, 0, 0)',   // 白底移到 .stage（整窗实色）
    'border-radius': '0px',
    'box-shadow': 'none',
    'padding-top': '10px',
    'padding-right': '18px',
    'padding-bottom': '8px',
    'padding-left': '18px',
    'gap': '8px',
  };
  Object.keys(FULL).forEach(k => okMine(k, mine.cal[k], FULL[k]));
  okMine('.cal 占满窗口宽度（不再有 max-width 卡片框）', mine.calFull, true);

  console.log('\n[格子 .cell]');
  Object.keys(proto.cell).forEach(k => ok(k, proto.cell[k], mine.cell[k]));

  console.log('\n[日期数字 .dnum]');
  Object.keys(proto.dnum).forEach(k => ok(k, proto.dnum[k], mine.dnum[k]));

  console.log('\n[任务标签 .tag]');
  Object.keys(proto.tag).forEach(k => ok(k, proto.tag[k], mine.tag[k]));

  console.log('\n[已完成 .tag.done]');
  Object.keys(proto.tagDone).forEach(k => ok(k, proto.tagDone[k], mine.tagDone[k]));

  console.log('\n[表头 .week-head]');
  Object.keys(proto.weekHead).forEach(k => ok(k, proto.weekHead[k], mine.weekHead[k]));

  /* 铺满专项：原型是「窗口里的一张卡片」，本项目现在是「整窗即日历」，
     这几条是原型根本没有的断言（原型侧不适用，只断言当前实现）。 */
  console.log('\n[铺满 / 品牌条移除]');
  okMine('HTML 品牌条 .topbar 已删除', mine.topbar, false);
  okMine('.stage 无外边距（padding = 0px）', mine.stagePad, '0px');

  console.log('\n结果：' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('对比脚本异常：', e); process.exit(2); });
