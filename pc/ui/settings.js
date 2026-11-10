/* settings.js —— P1 体验补齐（5 项）
   ① 当天面板「全部完成」  ② 打卡 toast + 撒花动效  ③ 同步 Bearer Token 输入
   ④ 测试连接（真发 GET /api/health）  ⑤ 导出数据（真调 GET /api/v1/export）

   与 app.js 的关系：**一个字都不改**，也不依赖 window.Took 的内部状态。
     · 打卡：点面板里 app.js 自己渲染的 .mtask 行，走它的 toggleTask —— 状态、月历重绘、
       同步刷新全由 app.js 完成，本模块只负责「点」与「看结果」。
     · 数据：本模块自己走 Tauri 的 invoke 通道（与 app.js 同一个），只读 range_grid 取当天任务。
     · 设置页：app.js 用 innerHTML 整体重绘 #setMain，所以卡片靠 MutationObserver 每次重挂。 */
(function () {
  'use strict';

  /* ---------- 0. 通道与工具 ---------- */
  function tauriInvoker() {
    var g = window.__TAURI__;
    if (g && g.core && typeof g.core.invoke === 'function') {
      return function (cmd, args) { return g.core.invoke(cmd, args); };
    }
    var i = window.__TAURI_INTERNALS__;
    if (i && typeof i.invoke === 'function') {
      return function (cmd, args) { return i.invoke(cmd, args); };
    }
    if (window.TookMock && typeof window.TookMock.invoke === 'function') {
      return function (cmd, args) { return window.TookMock.invoke(cmd, args); };
    }
    return null;
  }
  var INVOKE = tauriInvoker();
  function invoke(cmd, args) {
    if (!INVOKE) return Promise.reject(new Error('没有可用的数据源（既不在 Tauri 里，也没有 mock.js）'));
    return Promise.resolve(INVOKE(cmd, args));
  }

  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };
  var esc = function (s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };
  var msgOf = function (e) { return e && e.message ? e.message : String(e); };
  function pad2(n) { return String(n).padStart(2, '0'); }
  function todayKey() {
    var d = new Date();
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }
  function stamp() {
    var d = new Date();
    return '' + d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) + '-' +
      pad2(d.getHours()) + pad2(d.getMinutes()) + pad2(d.getSeconds());
  }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  var CHECK_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" ' +
    'stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 12.5l5 5 10-11"/></svg>';

  /* ==========================================================================
     ② 打卡 toast + 撒花：右下角可叠加多条，2 秒自动消失；粒子纯 CSS 动画
     ======================================================================= */
  var toastStack = null;
  function ensureToastStack() {
    if (toastStack && document.body.contains(toastStack)) return toastStack;
    toastStack = document.createElement('div');
    toastStack.className = 'took-toast-stack';
    toastStack.id = 'tookToastStack';
    toastStack.setAttribute('role', 'status');
    toastStack.setAttribute('aria-live', 'polite');
    document.body.appendChild(toastStack);
    return toastStack;
  }

  var fxLayer = null;
  function ensureFxLayer() {
    if (fxLayer && document.body.contains(fxLayer)) return fxLayer;
    fxLayer = document.createElement('div');
    fxLayer.className = 'took-fx-layer';
    fxLayer.id = 'tookFxLayer';
    fxLayer.setAttribute('aria-hidden', 'true');
    document.body.appendChild(fxLayer);
    return fxLayer;
  }

  /* 轻量粒子：一圈小圆点向四周飞散并淡出。不引第三方库，也不开 canvas。 */
  function burst(x, y, count) {
    var layer = ensureFxLayer();
    var n = count || 14;
    var palette = ['#f97316', '#fb923c', '#fdba74', '#ffffff'];
    for (var i = 0; i < n; i += 1) {
      (function (i) {
        var p = document.createElement('i');
        var ang = (Math.PI * 2 * i) / n + (Math.random() - 0.5) * 0.5;
        var dist = 26 + Math.random() * 48;
        var size = 3 + Math.random() * 4;
        p.className = 'took-fx';
        p.style.left = x + 'px';
        p.style.top = y + 'px';
        p.style.width = size.toFixed(1) + 'px';
        p.style.height = size.toFixed(1) + 'px';
        p.style.background = palette[i % palette.length];
        p.style.setProperty('--dx', (Math.cos(ang) * dist).toFixed(1) + 'px');
        p.style.setProperty('--dy', (Math.sin(ang) * dist + 20).toFixed(1) + 'px');
        p.style.animationDelay = Math.round(Math.random() * 60) + 'ms';
        layer.appendChild(p);
        setTimeout(function () { if (p.parentNode) p.parentNode.removeChild(p); }, 1100);
      }(i));
    }
  }

  function toast(title, sub) {
    var stack = ensureToastStack();
    var node = document.createElement('div');
    node.className = 'took-toast';
    node.innerHTML = '<span class="ok">' + CHECK_SVG + '</span>' +
      '<span class="tx"><b></b><span class="sb"></span></span>';
    node.querySelector('b').textContent = title;
    var sb = node.querySelector('.sb');
    if (sub) sb.textContent = sub; else sb.remove();
    stack.appendChild(node);
    requestAnimationFrame(function () { node.classList.add('show'); });
    setTimeout(function () {
      node.classList.remove('show');
      setTimeout(function () { if (node.parentNode) node.parentNode.removeChild(node); }, 240);
    }, 2000);
    return node;
  }

  function burstAt(elem) {
    if (!elem) { burst(window.innerWidth - 90, window.innerHeight - 70); return; }
    var r = elem.getBoundingClientRect();
    burst(r.left + r.width / 2, r.top + r.height / 2);
  }

  /* ==========================================================================
     ① 当天面板「全部完成」
     ======================================================================= */
  var maskEl = document.getElementById('mask');
  var sheetListEl = document.getElementById('sheetList');
  var doneAllBox = document.getElementById('sheetDoneAll');
  var doneAllBtn = document.getElementById('sheetDoneAllBtn');
  var doneAllHint = document.getElementById('sheetDoneAllHint');

  function panelDate() { return maskEl ? maskEl.dataset.date || '' : ''; }

  /* 面板上此刻的行：key = task_id|period_start */
  function snapshotRows() {
    var out = {};
    if (!sheetListEl) return out;
    $$('.mtask', sheetListEl).forEach(function (r) {
      var nm = r.querySelector('.mtask-name');
      out[r.dataset.task + '|' + r.dataset.period] = {
        done: r.classList.contains('done'),
        title: nm ? nm.textContent : ''
      };
    });
    return out;
  }

  function pendingCount() {
    var rows = $$('.mtask', sheetListEl);
    return rows.filter(function (r) { return !r.classList.contains('done'); }).length;
  }

  function syncDoneAll() {
    if (!doneAllBox) return;
    var rows = sheetListEl ? $$('.mtask', sheetListEl) : [];
    if (!maskEl || maskEl.hidden || !panelDate() || !rows.length) { doneAllBox.hidden = true; return; }
    doneAllBox.hidden = false;
    var left = pendingCount();
    if (doneAllBtn) doneAllBtn.disabled = left === 0;
    if (doneAllHint) doneAllHint.textContent = left === 0 ? '当天已全部完成' : ('还有 ' + left + ' 项未完成');
  }

  /* 点一行 app.js 渲染的任务行，等它变成目标状态（app.js 自己会重绘面板）。
     不直接改数据、不碰它的缓存：打卡的真实写盘由 app.js 的 toggleTask 完成。 */
  async function clickRow(key, wantDone, timeoutMs) {
    var parts = key.split('|');
    var sel = '#sheetList .mtask[data-task="' + parts[0].replace(/"/g, '\\"') +
      '"][data-period="' + parts[1].replace(/"/g, '\\"') + '"]';
    var deadline = Date.now() + (timeoutMs || 4000);
    var row = $(sel);
    if (!row) return false;
    var nowDone = row.classList.contains('done');
    if (nowDone === wantDone) return true;
    row.click();
    while (Date.now() < deadline) {
      await sleep(40);
      var cur = $(sel);
      if (cur && cur.classList.contains('done') === wantDone && !cur.disabled) return true;
    }
    return false;
  }

  async function doneAll() {
    if (!doneAllBtn || doneAllBtn.disabled) return;
    var date = panelDate();
    if (!date) return;
    doneAllBtn.disabled = true;
    var keys = $$('.mtask', sheetListEl)
      .filter(function (r) { return !r.classList.contains('done'); })
      .map(function (r) { return r.dataset.task + '|' + r.dataset.period; });
    if (!keys.length) { syncDoneAll(); return; }
    if (doneAllHint) doneAllHint.textContent = '正在打卡 0 / ' + keys.length + '…';

    var okN = 0;
    var failed = [];
    for (var i = 0; i < keys.length; i += 1) {
      var ok = await clickRow(keys[i], true, 5000);
      if (ok) okN += 1; else failed.push(keys[i]);
      if (doneAllHint) doneAllHint.textContent = '正在打卡 ' + (i + 1) + ' / ' + keys.length + '…';
    }
    burstAt(doneAllBtn);
    if (okN) toast('全部完成', '本日 ' + okN + ' 项一次性打卡');
    if (failed.length) toast('有 ' + failed.length + ' 项没打上', '请重试或看面板提示');
    if (doneAllHint) doneAllHint.textContent = failed.length
      ? ('有 ' + failed.length + ' 项没打上')
      : '当天已全部完成';
    syncDoneAll();
  }

  if (doneAllBtn) doneAllBtn.addEventListener('click', function () { doneAll(); });

  /* 面板重绘时对账：哪些行从「未完成」翻成「已完成」→ 弹 toast（可叠加） */
  var baseline = null;
  var baselineDate = '';
  function onPanelRender() {
    var date = panelDate();
    var next = snapshotRows();
    var open = !!(maskEl && !maskEl.hidden && date);
    if (!open) { baseline = next; baselineDate = date; syncDoneAll(); return; }
    if (baseline && baselineDate === date) {
      var flipped = [];
      Object.keys(next).forEach(function (k) {
        var was = baseline[k];
        if (!was) return;
        if (!was.done && next[k].done) flipped.push(next[k]);
        else if (was.done && !next[k].done) toast('已取消：' + next[k].title);
      });
      flipped.forEach(function (t, idx) {
        var node = toast('已打卡：' + t.title);
        // 一次补很多条时只在第一条上撒花，避免粒子把屏幕铺满
        if (idx === 0 && flipped.length <= 3) {
          requestAnimationFrame(function () { burstAt(node); });
        }
      });
    }
    baseline = next;
    baselineDate = date;
    syncDoneAll();
  }

  if (sheetListEl) {
    new MutationObserver(onPanelRender).observe(sheetListEl, { childList: true });
  }
  if (maskEl) {
    new MutationObserver(function () {
      // 关面板：清基线，下次打开不拿旧状态比
      if (maskEl.hidden) { baseline = null; baselineDate = ''; }
      syncDoneAll();
    }).observe(maskEl, { attributes: true, attributeFilter: ['hidden'] });
  }
  baseline = snapshotRows();
  syncDoneAll();

  /* ==========================================================================
     ③④ 设置页「同步」：Bearer Token + 测试连接
     ⑤ 设置页「数据」：导出
     ======================================================================= */
  var setMainEl = document.getElementById('setMain');
  var TOK = { loaded: false, value: '', probing: false, probe: null, exporting: false, exportInfo: null };

  function probeLineHtml() {
    var p = TOK.probe;
    if (!p) return '<span class="stat-line" id="tookProbeLine">未测试</span>';
    if (p.ok) {
      return '<span class="stat-line" id="tookProbeLine" title="' + esc(p.body) + '">' +
        '<i class="dot-ok"></i>HTTP ' + p.status + ' · ' + p.elapsed_ms + ' ms</span>';
    }
    return '<span class="stat-line err" id="tookProbeLine" title="' + esc(p.error || p.body) + '">' +
      '<i class="dot-off"></i>' + esc(p.error || ('HTTP ' + p.status)) + '</span>';
  }

  function exportLineHtml() {
    var e = TOK.exportInfo;
    if (!e) return '<span class="stat-line" id="tookExportLine">尚未导出</span>';
    if (e.ok) {
      return '<span class="stat-line" id="tookExportLine" title="' + esc(e.name) + '">' +
        '<i class="dot-ok"></i>' + esc(e.name) + ' · ' + e.bytes + ' 字节</span>';
    }
    return '<span class="stat-line err" id="tookExportLine" title="' + esc(e.error) + '">' +
      '<i class="dot-off"></i>' + esc(e.error) + '</span>';
  }

  function syncExtrasHtml() {
    return '<div class="card" id="tookSyncTokenCard">' +
      '<div class="row col">' +
        '<div class="k"><b>Bearer Token</b>' +
          '<i>后端用 -token 或环境变量 TOOK_TOKEN 开了鉴权时填这里；留空 = 后端不校验。' +
          '存在 local_state 的 sync_token，下一次 push / pull 的 Authorization 头就带上它。</i></div>' +
        '<div class="took-inline">' +
          '<input class="inp" id="tookSyncToken" type="text" autocomplete="off" spellcheck="false" ' +
            'placeholder="留空 = 不鉴权" aria-label="同步 Bearer Token" />' +
          '<button class="btn" id="tookSyncTokenSave" type="button">保存令牌</button>' +
          '<button class="btn" id="tookSyncTokenClear" type="button">清除</button>' +
        '</div>' +
      '</div>' +
      '<div class="row">' +
        '<div class="k"><b>测试连接</b>' +
          '<i>真发一条 GET /api/health（带上上面的地址与令牌），返回 HTTP 状态码与耗时；' +
          '连不上 / 401 都会如实报出来</i></div>' +
        '<div class="v">' + probeLineHtml() +
          '<button class="btn primary" id="tookProbeBtn" type="button">测试连接</button></div>' +
      '</div>' +
    '</div>';
  }

  function dataExtrasHtml() {
    return '<div class="card" id="tookDataCard">' +
      '<div class="row">' +
        '<div class="k"><b>导出数据</b>' +
          '<i>调后端 GET /api/v1/export，把全量 JSON（五张表含墓碑）下载成文件；' +
          '同一份 JSON 原样 POST 回 /api/sync/push 即可还原</i></div>' +
        '<div class="v"><button class="btn primary" id="tookExportBtn" type="button">导出 JSON</button></div>' +
      '</div>' +
      '<div class="row"><div class="k"><b>导出结果</b><i>文件名与字节数</i></div>' +
        '<div class="v">' + exportLineHtml() + '</div></div>' +
    '</div>' +
    '<div class="card" id="tookClearCard">' +
      '<div class="row col">' +
        '<div class="k"><b>清理数据 · 后端没有这个接口</b>' +
          '<i>后端 server/main.go 只注册了 /api/health、/api/rules、/api/month、' +
          '/api/sync/push、/api/sync/pull、/api/v1/export 六条路由，没有清库接口。' +
          '所以这里不放按钮 —— 放一个点了只会弹提示的假按钮等于骗人。</i></div>' +
        '<div class="took-note">要清库：在后端机器上停掉 took-server，删掉它的 took.db' +
          '（下次启动会重新写入种子）。本机库在 %APPDATA%\app.took.desktop\took.db，同理。</div>' +
      '</div>' +
    '</div>';
  }

  function currentTab() {
    var title = setMainEl ? $('.panel-title', setMainEl) : null;
    return title ? title.textContent.trim() : '';
  }

  function injectExtras() {
    if (!setMainEl) return;
    var tab = currentTab();
    if (tab === '同步') {
      if ($('#tookSyncTokenCard', setMainEl)) return;
      var firstCard = $('.card', setMainEl);
      var wrap = document.createElement('div');
      wrap.innerHTML = syncExtrasHtml();
      var card = wrap.firstChild;
      if (firstCard && firstCard.parentNode) firstCard.parentNode.insertBefore(card, firstCard.nextSibling);
      else setMainEl.appendChild(card);
      var input = $('#tookSyncToken', setMainEl);
      if (input) {
        input.value = TOK.value;
        input.addEventListener('input', function () { TOK.value = input.value; });
      }
      if (!TOK.loaded) loadStoredToken();
    } else if (tab === '数据') {
      if ($('#tookDataCard', setMainEl)) return;
      // app.js 的 dataPanelHtml 里「导出 / 清空」还写着「尚未实现」，导出已经能用了：
      // 把那一块换成本模块的真实卡片，避免同一屏里两种说法。
      var stale = $('.todo-block', setMainEl);
      if (stale) {
        var staleCard = stale.closest ? stale.closest('.card') : null;
        if (staleCard && staleCard.parentNode) staleCard.parentNode.removeChild(staleCard);
        else stale.remove();
      }
      var wrap2 = document.createElement('div');
      wrap2.innerHTML = dataExtrasHtml();
      while (wrap2.firstChild) setMainEl.appendChild(wrap2.firstChild);
    }
  }

  async function loadStoredToken() {
    try {
      var st = await invoke('sync_status', {});
      TOK.loaded = true;
      if (st && typeof st.token === 'string') {
        TOK.value = st.token;
        var input = $('#tookSyncToken', setMainEl);
        if (input && document.activeElement !== input) input.value = TOK.value;
      }
    } catch (e) {
      TOK.loaded = true;   // 读不到就别反复试；输入框仍可用
    }
  }

  async function saveToken() {
    var input = $('#tookSyncToken', setMainEl);
    if (input) TOK.value = input.value;
    try {
      var st = await invoke('set_sync_token', { token: TOK.value });
      if (st && typeof st.token === 'string') TOK.value = st.token;
      toast('令牌已保存', TOK.value ? '下次同步请求会带上 Authorization' : '已清空，请求不再带鉴权头');
      return true;
    } catch (e) {
      toast('令牌没存上', msgOf(e));
      return false;
    }
  }

  /* 测试连接：先把面板上没保存的地址 / 令牌落库，再真发一条 /api/health */
  async function probe() {
    if (TOK.probing) return;
    TOK.probing = true;
    var btn = $('#tookProbeBtn', setMainEl);
    if (btn) { btn.disabled = true; btn.textContent = '测试中…'; }
    var line = $('#tookProbeLine', setMainEl);
    if (line) { line.className = 'stat-line'; line.innerHTML = '<i class="dot-off"></i>请求中…'; }
    try {
      var urlInput = document.getElementById('syncUrl');
      var st = await invoke('sync_status', {});
      var wantUrl = urlInput ? urlInput.value.trim() : '';
      if (wantUrl && st && wantUrl.replace(/\/+$/, '') !== (st.url || '').replace(/\/+$/, '')) {
        await invoke('set_sync_url', { url: wantUrl });
        st = await invoke('sync_status', {});
      }
      var tokenInput = $('#tookSyncToken', setMainEl);
      if (tokenInput) TOK.value = tokenInput.value;
      if (!st || (st.token || '') !== TOK.value) {
        await invoke('set_sync_token', { token: TOK.value });
      }
      var res = await invoke('sync_probe', {});
      TOK.probe = res || { ok: false, status: 0, elapsed_ms: 0, body: '', error: '没有返回' };
    } catch (e) {
      TOK.probe = { ok: false, status: 0, elapsed_ms: 0, body: '', error: msgOf(e) };
    } finally {
      TOK.probing = false;
      var holder = $('#tookProbeLine', setMainEl);
      if (holder && holder.parentNode) {
        var tmp = document.createElement('div');
        tmp.innerHTML = probeLineHtml();
        holder.parentNode.replaceChild(tmp.firstChild, holder);
      }
      if (btn) { btn.disabled = false; btn.textContent = '测试连接'; }
    }
    var p = TOK.probe;
    if (p && p.ok) toast('连接正常', 'HTTP ' + p.status + ' · ' + p.elapsed_ms + ' ms');
    else toast('连接失败', (p && (p.error || ('HTTP ' + p.status))) || '未知错误');
  }

  /* 导出：真打后端，拿到 body 再落成文件 */
  async function doExport() {
    if (TOK.exporting) return;
    TOK.exporting = true;
    var btn = $('#tookExportBtn', setMainEl);
    if (btn) { btn.disabled = true; btn.textContent = '导出中…'; }
    try {
      var res = await invoke('export_data', {});
      var status = res && typeof res.status === 'number' ? res.status : 0;
      var body = res && typeof res.body === 'string' ? res.body : '';
      if (status >= 200 && status < 300 && body) {
        var name = 'took-export-' + stamp() + '.json';
        var blob = new Blob([body], { type: 'application/json;charset=utf-8' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = name;
        document.body.appendChild(a);
        a.click();
        setTimeout(function () {
          if (a.parentNode) a.parentNode.removeChild(a);
          URL.revokeObjectURL(url);
        }, 0);
        TOK.exportInfo = { ok: true, name: name, bytes: blob.size };
        toast('已导出', name + ' · ' + blob.size + ' 字节');
      } else {
        TOK.exportInfo = { ok: false, error: 'HTTP ' + status + '：' + body.slice(0, 160) };
        toast('导出失败', TOK.exportInfo.error);
      }
    } catch (e) {
      TOK.exportInfo = { ok: false, error: msgOf(e) };
      toast('导出失败', msgOf(e));
    } finally {
      TOK.exporting = false;
      var holder = $('#tookExportLine', setMainEl);
      if (holder && holder.parentNode) {
        var tmp = document.createElement('div');
        tmp.innerHTML = exportLineHtml();
        holder.parentNode.replaceChild(tmp.firstChild, holder);
      }
      if (btn) { btn.disabled = false; btn.textContent = '导出 JSON'; }
    }
  }

  if (setMainEl) {
    setMainEl.addEventListener('click', function (e) {
      var t = e.target;
      if (!t.closest) return;
      if (t.closest('#tookSyncTokenSave')) { saveToken(); return; }
      if (t.closest('#tookSyncTokenClear')) {
        TOK.value = '';
        var input = $('#tookSyncToken', setMainEl);
        if (input) input.value = '';
        saveToken();
        return;
      }
      if (t.closest('#tookProbeBtn')) { probe(); return; }
      if (t.closest('#tookExportBtn')) { doExport(); return; }
    });
    new MutationObserver(injectExtras).observe(setMainEl, { childList: true });
    injectExtras();
  }
}());
