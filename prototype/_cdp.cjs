/* Took prototype verification harness: drives both pages over CDP. */
const { spawn } = require('node:child_process');
const { mkdtempSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const OUT = 'D:/work/Project/Took/prototype/';
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function openPage(file, width, height) {
  const port = 13000 + Math.floor(Math.random() * 2000);
  const profile = mkdtempSync(join(process.env.TEMP, 'tookv-'));
  const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=' + port,
    '--user-data-dir=' + profile, '--window-size=' + width + ',' + height, '--hide-scrollbars',
    '--force-device-scale-factor=1', '--no-first-run', '--no-default-browser-check',
    'file:///' + OUT + file], { stdio: 'ignore' });

  let target = null;
  for (let i = 0; i < 80 && !target; i++) {
    try {
      const r = await fetch('http://127.0.0.1:' + port + '/json/list');
      const list = await r.json();
      const pages = list.filter(t => t.type === 'page' && t.webSocketDebuggerUrl);
      // 优先挑已经加载了目标文件的标签页；Chrome 有时会先开一个 about:blank
      target = pages.find(t => String(t.url || '').indexOf(file) >= 0) || pages[0] || null;
    } catch (e) {}
    if (!target) await sleep(200);
  }
  if (!target) { chrome.kill(); throw new Error('no chrome target for ' + file); }

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
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', clickCount: 0 });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  };
  const shot = async name => {
    const s = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(OUT + name, Buffer.from(s.data, 'base64'));
  };
  const metrics = async (w, h) => {
    await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
    await sleep(450);
  };

  await send('Runtime.enable'); await send('Log.enable'); await send('Page.enable');
  // 兜底：无论 Chrome 先开了什么页，都显式导航到目标文件并等加载完成
  await send('Page.navigate', { url: 'file:///' + OUT + file }).catch(() => {});
  await sleep(1500);

  return { chrome, ws, send, evalJs, click, shot, metrics, errors, close() { ws.close(); chrome.kill(); } };
}

module.exports = { openPage, sleep };