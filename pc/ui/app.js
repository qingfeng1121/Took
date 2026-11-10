/* Took PC 端 · 月历 + 打卡 + 同步
   数据来源优先级：Tauri 命令 month_grid / list_rules / toggle_done / sync_* → 不存在时用 mock.js。

   交互约定（契约 §5.4，用户级硬约束）：
     - 只有日期数字与格子空白可点 → 打开当天面板；
     - 格子里的任务名 / 圆点是纯预览，点了不响应；
     - 打卡只能在面板里点任务行，写的是 (task_id, period_start)，
       所以同一周期内所有命中日会一起变（契约 §3.3）。 */
(function () {
  'use strict';

  /* ---------- 1. 密度档位（契约 §5.3：按卡片宽度切三档） ---------- */
  const DENSITY = {
    compact:  { name: '紧凑', tags: 1, dots: true,  row: 64  },
    standard: { name: '标准', tags: 2, dots: false, row: 80  },
    loose:    { name: '宽松', tags: 4, dots: false, row: 104 },
  };
  const ROW_GAP = 7;          // 周与周之间的间距（与 style.css 的 .grid gap 一致）
  const WEEKS_AROUND = 12;    // 当前月前后各建 12 个月的连续周
  const DENSITY_BREAKPOINTS = [
    { min: 1081, density: 'loose' },
    { min: 720,  density: 'standard' },
    { min: 0,    density: 'compact' },
  ];
  function densityForWidth(width) {
    const hit = DENSITY_BREAKPOINTS.find(function (b) { return width >= b.min; });
    return hit ? hit.density : 'compact';
  }

  /* ---------- 2. 日期工具（纯公历分量，不碰时间戳） ---------- */
  const pad2 = function (n) { return String(n).padStart(2, '0'); };
  const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const isLeapYear = function (y) { return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0; };
  const daysInMonth = function (y, m) { return m === 2 && isLeapYear(y) ? 29 : MONTH_DAYS[m - 1]; };
  const toKey = function (y, m, d) { return y + '-' + pad2(m) + '-' + pad2(d); };
  const parseKey = function (key) { return { y: +key.slice(0, 4), m: +key.slice(5, 7), d: +key.slice(8, 10) }; };

  function daySerial(key) {
    const p = parseKey(key);
    const a = Math.floor((14 - p.m) / 12);
    const yy = p.y + 4800 - a;
    const mm = p.m + 12 * a - 3;
    const jdn = p.d + Math.floor((153 * mm + 2) / 5) + 365 * yy +
      Math.floor(yy / 4) - Math.floor(yy / 100) + Math.floor(yy / 400) - 32045;
    return jdn - 2440588;
  }
  function keyFromSerial(n) {
    const jdn = n + 2440588;
    const a = jdn + 32044;
    const b = Math.floor((4 * a + 3) / 146097);
    const c = a - Math.floor(146097 * b / 4);
    const d = Math.floor((4 * c + 3) / 1461);
    const e = c - Math.floor(1461 * d / 4);
    const mp = Math.floor((5 * e + 2) / 153);
    const day = e - Math.floor((153 * mp + 2) / 5) + 1;
    const month = mp + 3 - 12 * Math.floor(mp / 10);
    const year = 100 * b + d - 4800 + Math.floor(mp / 10);
    return toKey(year, month, day);
  }
  const addDaysKey = function (key, n) { return keyFromSerial(daySerial(key) + n); };
  const weekdayIndex = function (key) { return (((daySerial(key) + 3) % 7) + 7) % 7; }; // 周一 = 0

  const WEEK_CN = ['一', '二', '三', '四', '五', '六', '日'];
  const WEEK_CN_FULL = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
  const cnDate = function (key) { const p = parseKey(key); return p.m + ' 月 ' + p.d + ' 日'; };
  const esc = function (s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };

  /* 今天：取本机本地年月日三个分量，不经过 toISOString（那会按 UTC 漂一格） */
  function todayKey() {
    const d = new Date();
    return toKey(d.getFullYear(), d.getMonth() + 1, d.getDate());
  }
  const TODAY = todayKey();

  /* ---------- 3. 数据源：Tauri 命令优先，浏览器兜底 ---------- */
  let SOURCE = 'mock';
  function tauriInvoker() {
    const g = window.__TAURI__;
    if (g && g.core && typeof g.core.invoke === 'function') {
      return function (cmd, args) { return g.core.invoke(cmd, args); };
    }
    const i = window.__TAURI_INTERNALS__;
    if (i && typeof i.invoke === 'function') {
      return function (cmd, args) { return i.invoke(cmd, args); };
    }
    return null;
  }
  const TAURI = tauriInvoker();
  async function invoke(cmd, args) {
    if (TAURI) { SOURCE = 'tauri'; return TAURI(cmd, args); }
    if (window.TookMock) { SOURCE = 'mock'; return window.TookMock.invoke(cmd, args); }
    throw new Error('没有可用的数据源（既不在 Tauri 里，也没有 mock.js）');
  }

  /* ---------- 4. 视图状态 ---------- */
  const todayParts = parseKey(TODAY);
  const STATE = {
    view: { y: todayParts.y, m: todayParts.m },   // 顶部标题显示的月份（跟滚动位置走）
    weeks: [],             // 连续周列表：每周的周一 'YYYY-MM-DD'，升序
    weekPos: new Map(),    // 周一起点 → 在 weeks 里的下标
    rowH: 80,              // 当前密度下的行高（px）
    density: 'standard',
    cache: new Map(),      // 'YYYY-MM-DD' → tasks[]（每条带 task_id / period_start / done）
    memoCache: new Map(),  // 'YYYY-MM-DD' → 记事[]（倒计时与笔记永不进月历）
    memos: { 0: [], 1: [], 2: [] }, // 三类 memo 的列表（契约 §10）
    configTab: 'rules',    // 配置页左导航：rules | note | countdown | notebook
    loaded: new Set(),     // 'y-m'
    rules: [],             // 进行中的规则（月历副标题用）
    rulesAll: [],          // 含已结束的历史规则（配置页用）
    panelDate: null,
    sync: null,
    reminder: null,        // 后端调度器的真实状态（reminder_status）
    upcoming: [],          // 接下来的几条提醒（reminder_upcoming）
    screen: null,
    // 默认仍停在「同步」：这是既有验收（verify-tauri.cjs）断言的入口，
    // 加「提醒」面不改默认入口，避免把已通过的回归撞坏。
    // 默认仍停在「同步」：verify-sync.cjs / verify-tauri.cjs 一打开设置页就断言同步那几行，
    // 把默认页签改成「桌面」会让既有回归误红。桌面页签排在导航第一位，点一下就到。
    settingsTab: 'sync',
    hint: '',
  };

  const loading = new Map();

  /* 任意 delta 的月份位移（±12 以上也要对：先摊到 0 基再折回去） */
  function shiftMonth(y, m, delta) {
    const total = y * 12 + (m - 1) + delta;
    const ny = Math.floor(total / 12);
    return { y: ny, m: total - ny * 12 + 1 };
  }

  /* ---------- 4.1 连续周：把「月」换成「周数组」 ----------
     滚动月历的最小单位是一周（周一到周日）。一次建出当前月前后各 12 个月的周，
     渲染成纵向滚动容器，滚到月底自然衔接下个月，不再有「翻页」这个动作。 */
  function monthFirstWeekMonday(y, m) {
    const first = toKey(y, m, 1);
    return addDaysKey(first, -weekdayIndex(first));
  }

  function buildWeeks(centerY, centerM) {
    const before = shiftMonth(centerY, centerM, -WEEKS_AROUND);
    const after = shiftMonth(centerY, centerM, WEEKS_AROUND);
    const from = monthFirstWeekMonday(before.y, before.m);
    const lastDay = toKey(after.y, after.m, daysInMonth(after.y, after.m));
    const to = addDaysKey(lastDay, 6 - weekdayIndex(lastDay));
    const out = [];
    let k = from;
    while (k <= to) { out.push(k); k = addDaysKey(k, 7); }
    return out;
  }

  function indexWeeks() {
    STATE.weekPos = new Map();
    STATE.weeks.forEach(function (k, i) { STATE.weekPos.set(k, i); });
  }

  /* 某周「属于哪个月」：看这 7 天里占多数的那个月（平票取靠前的月份）。
     标题与 ‹ › 都按这个口径，跨月周（10/26~11/01）归 10 月。 */
  function weekMonth(weekStart) {
    const counts = new Map();
    for (let i = 0; i < 7; i += 1) {
      const p = parseKey(addDaysKey(weekStart, i));
      const tag = p.y * 100 + p.m;
      counts.set(tag, (counts.get(tag) || 0) + 1);
    }
    let best = 0, bestN = -1;
    counts.forEach(function (n, tag) { if (n > bestN) { bestN = n; best = tag; } });
    return { y: Math.floor(best / 100), m: best % 100 };
  }

  /* 该月在周数组里的「第一周」：第一周属于该月的那一周 */
  function weekPosOfMonth(y, m) {
    for (let i = 0; i < STATE.weeks.length; i += 1) {
      const w = weekMonth(STATE.weeks[i]);
      if (w.y === y && w.m === m) return i;
    }
    return -1;
  }
  function weekPosOfDate(key) {
    const start = addDaysKey(key, -weekdayIndex(key));
    return STATE.weekPos.has(start) ? STATE.weekPos.get(start) : -1;
  }

  /* 整个周数组一次拉齐（后端 range_grid）：滚动时不再有「这一月还没加载」的空档 */
  async function loadRange() {
    if (!STATE.weeks.length) return;
    const from = STATE.weeks[0];
    const to = addDaysKey(STATE.weeks[STATE.weeks.length - 1], 6);
    const tag = from + '~' + to;
    if (STATE.loaded.has(tag)) return;
    if (loading.has(tag)) return loading.get(tag);
    const p = invoke('range_grid', { from: from, to: to })
      .then(function (days) {
        (days || []).forEach(function (d) {
          STATE.cache.set(d.date, d.tasks || []);
          STATE.memoCache.set(d.date, d.memos || []);
        });
        STATE.loaded.add(tag);
      })
      .finally(function () { loading.delete(tag); });
    loading.set(tag, p);
    return p;
  }

  /* ---------- 5. 渲染 ---------- */
  const ICON_CHECK =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" ' +
    'stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 12.5l5 5 10-11"/></svg>';

  const gridEl = document.getElementById('grid');
  const weekHeadEl = document.getElementById('weekHead');
  const titleEl = document.getElementById('calTitle');
  const subEl = document.getElementById('calSub');
  const sourceEl = document.getElementById('sourceTag');
  const calCardEl = document.getElementById('calCard');
  const maskEl = document.getElementById('mask');
  const sheetTitleEl = document.getElementById('sheetTitle');
  const sheetSubEl = document.getElementById('sheetSub');
  const sheetListEl = document.getElementById('sheetList');
  const configScreenEl = document.getElementById('configScreen');
  const settingsScreenEl = document.getElementById('settingsScreen');
  const analysisScreenEl = document.getElementById('analysisScreen');
  const analysisMainEl = document.getElementById('analysisMain');
  const configNavEl = document.getElementById('configNav');
  const configMainEl = document.getElementById('configMain');
  const setNavEl = document.getElementById('setNav');
  const setMainEl = document.getElementById('setMain');
  const stageEl = document.querySelector('.stage');

  const tasksOn = function (dateKey) { return STATE.cache.get(dateKey) || []; };
  /* 记事按时间段逐日渲染：区间内每一天都在格子出现（契约 §10.1、用例 M2） */
  const memosOn = function (dateKey) { return STATE.memoCache.get(dateKey) || []; };

  function renderWeekHead() {
    weekHeadEl.innerHTML = WEEK_CN.map(function (n) { return '<div>周' + n + '</div>'; }).join('');
  }

  /* 仅显示层排序：未完成在前，已完成在后（原型同款排序规则） */
  function sortForCell(items) {
    return items.slice().sort(function (a, b) { return Number(a.done) - Number(b.done); });
  }

  function dotsHtml(items) {
    const dots = items.map(function (it) { return '<i class="' + (it.done ? 'done' : '') + '"></i>'; }).join('');
    return '<div class="dots">' + dots + '</div>';
  }

  function tagRowsHtml(dateKey, maxTags) {
    const all = tasksOn(dateKey);
    const shown = sortForCell(all).slice(0, Math.max(0, maxTags));
    const rest = all.length - shown.length;
    const html = shown.map(function (it) {
      const cls = it.done ? 'tag done' : 'tag';
      return '<div class="' + cls + '">' + (it.done ? ICON_CHECK : '') +
        '<span class="nm">' + esc(it.title) + '</span></div>';
    }).join('');
    return html + (rest > 0 ? '<div class="tag more">+' + rest + '</div>' : '');
  }

  /* 记事标签：只读预览（格子里的文字一律不响应点击，契约 §5.4 的同一口径） */
  function memoTagsHtml(dateKey) {
    return memosOn(dateKey).map(function (m) {
      return '<div class="tag memo" data-memo="' + esc(m.id) + '">' +
        '<span class="nm">' + esc(m.title) + '</span></div>';
    }).join('');
  }

  function dayTags(dateKey, maxTags, withDots) {
    const items = tasksOn(dateKey);
    const memos = memoTagsHtml(dateKey);
    if (!items.length && !memos) return '';
    const rows = items.length ? tagRowsHtml(dateKey, maxTags) : '';
    const dots = withDots && items.length ? dotsHtml(items) : '';
    return '<div class="tags">' + memos + rows + '</div>' + dots;
  }

  /* 一周 7 格；灰化口径 = 不属于「顶部标题那个月」（与标题同源，滚动时一起变） */
  function weekHtml(weekStart, y, m) {
    const cfg = DENSITY[STATE.density];
    const cells = [];
    for (let i = 0; i < 7; i += 1) {
      const key = addDaysKey(weekStart, i);
      const p = parseKey(key);
      const mute = p.m !== m || p.y !== y;
      const isToday = key === TODAY;
      cells.push('<div class="cell' + (mute ? ' mute' : '') + '" data-date="' + key +
        '" role="button" tabindex="0" aria-label="' + p.m + ' 月 ' + p.d + ' 日' +
        (isToday ? '（今天）' : '') + '，' + tasksOn(key).length + ' 项">' +
        '<div class="dnum' + (isToday ? ' today' : '') + '">' + p.d + '</div>' +
        dayTags(key, cfg.tags, cfg.dots) + '</div>');
    }
    return '<div class="week" data-week="' + weekStart + '">' + cells.join('') + '</div>';
  }

  function renderGrid() {
    const y = STATE.view.y, m = STATE.view.m;
    document.documentElement.dataset.density = STATE.density;
    STATE.rowH = DENSITY[STATE.density].row;
    calCardEl.style.setProperty('--row-h', STATE.rowH + 'px');
    titleEl.textContent = y + ' 年 ' + m + ' 月';

    const todayCount = tasksOn(TODAY).filter(function (t) { return t.done; }).length;
    const liveRules = STATE.rules.filter(function (r) { return r.enabled; });
    const liveTasks = liveRules.reduce(function (n, r) {
      return n + (r.tasks || []).filter(function (t) { return t.enabled; }).length;
    }, 0);
    subEl.textContent = '共 ' + liveRules.length + ' 条规则 · ' + liveTasks + ' 个任务 · 今天已完成 ' +
      todayCount + ' / ' + tasksOn(TODAY).length;

    // 重绘后回到同一滚动位置（打卡 / 改密度都会重绘）
    const keepTop = gridEl.scrollTop;
    gridEl.innerHTML = STATE.weeks.map(function (k) { return weekHtml(k, y, m); }).join('');
    gridEl.scrollTop = keepTop;
  }

  /* 只换灰化（滚动时每帧都跑，不重建 DOM） */
  function syncMonthChrome() {
    const y = STATE.view.y, m = STATE.view.m;
    const rows = gridEl.children;
    for (let i = 0; i < rows.length && i < STATE.weeks.length; i += 1) {
      const w = STATE.weeks[i];
      const cells = rows[i].children;
      for (let j = 0; j < cells.length; j += 1) {
        const p = parseKey(addDaysKey(w, j));
        const mute = p.m !== m || p.y !== y;
        if (cells[j].classList.contains('mute') !== mute) cells[j].classList.toggle('mute', mute);
      }
    }
  }

  /* 视口顶部那一周属于哪个月 → 标题；变了才写 DOM */
  function monthAtScroll() {
    if (!STATE.weeks.length) return null;
    const step = STATE.rowH + ROW_GAP;
    let i = Math.round(gridEl.scrollTop / step);
    if (i < 0) i = 0;
    if (i >= STATE.weeks.length) i = STATE.weeks.length - 1;
    return weekMonth(STATE.weeks[i]);
  }

  function syncTitle() {
    const w = monthAtScroll();
    if (!w) return;
    if (w.y === STATE.view.y && w.m === STATE.view.m) return;
    STATE.view = { y: w.y, m: w.m };
    titleEl.textContent = w.y + ' 年 ' + w.m + ' 月';
    syncMonthChrome();
  }

  let scrollRaf = 0;
  function onGridScroll() {
    if (scrollRaf) return;
    scrollRaf = requestAnimationFrame(function () { scrollRaf = 0; syncTitle(); });
  }

  /* 密度档只是上限；格子变矮时按像素再收缩，宁可少显示任务名也不裁切 */
  function setCellBody(cell, html) {
    const dnum = cell.querySelector('.dnum');
    cell.innerHTML = '';
    if (dnum) cell.appendChild(dnum);
    cell.insertAdjacentHTML('beforeend', html);
  }

  /* 只测可见范围（视口上下各多一行）：150 周全量测量会把滚动拖卡 */
  function visibleCells() {
    const step = STATE.rowH + ROW_GAP;
    const first = Math.max(0, Math.floor(gridEl.scrollTop / step) - 1);
    const rows = Math.ceil(gridEl.clientHeight / step) + 3;
    const out = [];
    for (let i = first; i < first + rows && i < gridEl.children.length; i += 1) {
      const row = gridEl.children[i];
      for (let j = 0; j < row.children.length; j += 1) out.push(row.children[j]);
    }
    return out;
  }

  function fitTags() {
    const cfg = DENSITY[STATE.density];
    visibleCells().forEach(function (cell) {
      const key = cell.dataset.date;
      const total = tasksOn(key).length;
      if (!total && !memosOn(key).length) return;
      const fits = function () {
        if (cell.scrollHeight > cell.clientHeight + 1) return false;
        const tags = cell.querySelector('.tags');
        if (tags && tags.scrollHeight > tags.clientHeight + 1) return false;
        const dots = cell.querySelector('.dots');
        if (dots && dots.scrollHeight > dots.clientHeight + 1) return false;
        return true;
      };
      if (fits()) return;
      for (let max = Math.min(cfg.tags, total) - 1; max >= 1; max -= 1) {
        setCellBody(cell, dayTags(key, max, cfg.dots));
        if (fits()) return;
      }
      setCellBody(cell, dayTags(key, 0, false));
      if (fits()) return;
      setCellBody(cell, '');
    });
  }

  /* ---------- 6. 当天面板（打卡入口唯一在面板里） ---------- */
  function panelHtml(dateKey) {
    const tasks = tasksOn(dateKey);
    if (!tasks.length) return '<div class="mempty">这一天没有任务</div>';
    const groups = new Map();
    tasks.forEach(function (t) {
      if (!groups.has(t.rule_id)) groups.set(t.rule_id, { title: t.rule_title, items: [] });
      groups.get(t.rule_id).items.push(t);
    });
    return Array.from(groups.values()).map(function (g) {
      const done = g.items.filter(function (t) { return t.done; }).length;
      const rows = g.items.map(function (t) {
        return '<button type="button" class="mtask' + (t.done ? ' done' : '') +
          '" data-task="' + esc(t.task_id) + '" data-period="' + esc(t.period_start) +
          '" aria-pressed="' + (t.done ? 'true' : 'false') + '">' +
          '<span class="tick">' + ICON_CHECK + '</span>' +
          '<span class="mtask-name">' + esc(t.title) + '</span>' +
          '<span class="mtask-state">' + (t.done ? '已完成' : '未完成') + '</span></button>';
      }).join('');
      return '<div class="sgroup"><div class="sgroup-head"><b>' + esc(g.title) +
        '</b><span class="sgroup-sum">' + done + ' / ' + g.items.length + ' 已完成</span></div>' +
        rows + '</div>';
    }).join('');
  }

  function panelSubHtml(dateKey) {
    const tasks = tasksOn(dateKey);
    const done = tasks.filter(function (t) { return t.done; }).length;
    return tasks.length + ' 项 · 已完成 ' + done +
      (dateKey === TODAY ? ' · <span class="today-dot">今天</span>' : '');
  }

  function openPanel(dateKey) {
    STATE.panelDate = dateKey;
    sheetTitleEl.textContent = cnDate(dateKey) + ' · 周' + WEEK_CN[weekdayIndex(dateKey)];
    sheetSubEl.innerHTML = panelSubHtml(dateKey);
    sheetListEl.innerHTML = panelHtml(dateKey);
    maskEl.hidden = false;
    maskEl.dataset.date = dateKey;
  }
  function closePanel() {
    maskEl.hidden = true;
    STATE.panelDate = null;
    delete maskEl.dataset.date;
  }
  /* 打卡后只重绘面板与网格，不重新拉整月 */
  function refreshPanel() {
    if (!STATE.panelDate) return;
    sheetSubEl.innerHTML = panelSubHtml(STATE.panelDate);
    sheetListEl.innerHTML = panelHtml(STATE.panelDate);
  }

  /* 打卡后只重填格子内容（不重建 150 周的 DOM，也不动滚动位置）。
     同周期可能跨周（每 N 天 / 每月），所以所有行一起刷。 */
  function repaintCells() {
    const cfg = DENSITY[STATE.density];
    const rows = gridEl.children;
    for (let i = 0; i < rows.length && i < STATE.weeks.length; i += 1) {
      const w = STATE.weeks[i];
      const cells = rows[i].children;
      for (let j = 0; j < cells.length; j += 1) {
        const key = addDaysKey(w, j);
        const cell = cells[j];
        const dnum = cell.querySelector('.dnum');
        if (!dnum) continue;
        cell.innerHTML = '';
        cell.appendChild(dnum);
        cell.insertAdjacentHTML('beforeend', dayTags(key, cfg.tags, cfg.dots));
      }
    }
  }

  /* 同周期状态共享：内存里所有 (task_id, period_start) 相同的格子一起改 */
  function applyToggle(taskId, period, done) {
    STATE.cache.forEach(function (list) {
      list.forEach(function (t) {
        if (t.task_id === taskId && t.period_start === period) t.done = done;
      });
    });
  }

  async function toggleTask(row) {
    const taskId = row.dataset.task;
    const period = row.dataset.period;
    const next = row.getAttribute('aria-pressed') !== 'true';
    row.disabled = true;
    try {
      const res = await invoke('toggle_done', { taskId: taskId, periodStart: period, done: next });
      const done = res && typeof res.done === 'boolean' ? res.done : next;
      applyToggle(taskId, period, done);
      repaintCells();
      fitTags();
      refreshPanel();
      refreshSyncStatus().then(function () { renderScreen(); }).catch(function () {});
    } catch (err) {
      row.disabled = false;
      sheetSubEl.textContent = '打卡失败：' + (err && err.message ? err.message : String(err));
    }
  }

  /* ---------- 7. 月历交互 ---------- */
  gridEl.addEventListener('click', function (e) {
    // 任务名与圆点是纯预览：点了不响应（与原型 pc.html 的过滤条件一致）
    if (e.target.closest('.tag, .dots')) return;
    if (gridEl.dataset.suppressClick) { delete gridEl.dataset.suppressClick; return; }
    const cell = e.target.closest('.cell');
    if (!cell) return;
    openPanel(cell.dataset.date);
  });
  gridEl.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const cell = e.target.closest('.cell');
    if (!cell || e.target.closest('.tag, .dots')) return;
    e.preventDefault();
    openPanel(cell.dataset.date);
  });

  sheetListEl.addEventListener('click', function (e) {
    const row = e.target.closest('.mtask');
    if (!row || row.disabled) return;
    toggleTask(row);
  });

  document.getElementById('prevBtn').addEventListener('click', function () { go(-1); });
  document.getElementById('nextBtn').addEventListener('click', function () { go(1); });
  document.getElementById('todayBtn').addEventListener('click', function () { goToday(); });
  document.getElementById('sheetClose').addEventListener('click', closePanel);
  maskEl.addEventListener('click', function (e) { if (e.target === maskEl) closePanel(); });

  /* 滚动到某一周（有动画）。behavior 显式给，不依赖 CSS，WebView2 与 Chrome 都支持 */
  function scrollToWeek(pos, smooth) {
    if (pos < 0) return;
    gridEl.scrollTo({ top: pos * (STATE.rowH + ROW_GAP), behavior: smooth ? 'smooth' : 'auto' });
  }

  function setViewMonth(y, m) {
    STATE.view = { y: y, m: m };
    titleEl.textContent = y + ' 年 ' + m + ' 月';
    syncMonthChrome();
  }

  /* ‹ › = 平滑滚动到上/下个月的第一周，不是替换整屏 */
  function go(delta) {
    const t = shiftMonth(STATE.view.y, STATE.view.m, delta);
    const pos = weekPosOfMonth(t.y, t.m);
    if (pos < 0) return;
    setViewMonth(t.y, t.m);
    scrollToWeek(pos, true);
  }

  function goToday() {
    const pos = weekPosOfDate(TODAY);
    if (pos < 0) return;
    const p = parseKey(TODAY);
    setViewMonth(p.y, p.m);
    scrollToWeek(pos, true);
  }

  /* 滚轮：按「整行」走，一格滚轮 ≈ 1 行。
     纯像素滚会停在两行中间，顶部那行被切一半（体感很差）；
     这里把小 delta 累加，够半行才走一行，于是每一次停都对齐行边界。 */
  /* 滚轮按「整行」走：连续累加滚轮像素成一个目标位置，再吸附到最近的行边界。
     这样 ① 一次滚轮 ≈ 1 行（不是整月跳）② 每次停下都对齐行边界，
     顶部那行不会被切一半 ③ 触控板的小 delta 也能累积成整行。 */
  let wheelTarget = null;   // 连续滚动意图（px）
  let wheelApplied = -1;    // 上一次由滚轮写下去的位置，用于识别「位置被别人改过」
  gridEl.addEventListener('wheel', function (e) {
    if (e.ctrlKey) return;                 // Ctrl+滚轮留给缩放
    const dy = e.deltaY;
    if (!dy) return;
    e.preventDefault();
    const step = STATE.rowH + ROW_GAP;
    const maxTop = gridEl.scrollHeight - gridEl.clientHeight;
    // ‹ › 或「回到今天」刚平滑滚过：以真实位置为新起点，不要沿用旧的累加值。
    // 起点必须**先对齐到最近的行边界**：平滑滚动中途接手时真实位置是行中间的半行余量，
    // 直接拿它当起点，这点余量会把下一格滚轮整个吃掉（实测：连滚两格只走了 1 行）。
    if (wheelTarget === null || Math.abs(gridEl.scrollTop - wheelApplied) > 2) {
      wheelTarget = Math.round(gridEl.scrollTop / step) * step;
    }
    wheelTarget += dy;
    if (wheelTarget < 0) wheelTarget = 0;
    if (wheelTarget > maxTop) wheelTarget = maxTop;
    let next = Math.round(wheelTarget / step) * step;
    if (next < 0) next = 0;
    if (next > maxTop) next = maxTop;
    wheelApplied = next;
    gridEl.scrollTop = next;
  }, { passive: false });

  /* 拖动：按住格子拖动 = 滚动（鼠标用户不必依赖滚轮） */
  let drag = null;
  gridEl.addEventListener('pointerdown', function (e) {
    if (e.button !== 0) return;
    if (e.target.closest('.tag, .dots')) return;
    drag = { y: e.clientY, top: gridEl.scrollTop, moved: false, id: e.pointerId };
  });
  gridEl.addEventListener('pointermove', function (e) {
    if (!drag || drag.id !== e.pointerId) return;
    const dy = e.clientY - drag.y;
    if (!drag.moved && Math.abs(dy) > 4) {
      drag.moved = true;
      gridEl.classList.add('dragging');
      try { gridEl.setPointerCapture(e.pointerId); } catch (_) {}
    }
    if (drag.moved) gridEl.scrollTop = drag.top - dy;
  });
  function endDrag() {
    if (!drag) return;
    const wasMoved = drag.moved;
    try { gridEl.releasePointerCapture(drag.id); } catch (_) {}
    drag = null;
    gridEl.classList.remove('dragging');
    if (wasMoved) gridEl.dataset.suppressClick = '1';
  }
  gridEl.addEventListener('pointerup', endDrag);
  gridEl.addEventListener('pointercancel', endDrag);
  gridEl.addEventListener('scroll', onGridScroll, { passive: true });

  /* ---------- 8. 配置 / 设置 两个全屏覆盖层 ---------- */
  const CONFIG_NAV = [
    { id: 'rules', name: '规则与任务' },
    { id: 'note', name: '记事' },
    { id: 'countdown', name: '倒数日' },
    { id: 'notebook', name: '笔记本' }
  ];
  /* 设置页导航照 prototype/pc.html 的 SETTINGS_NAV：常规 / 外观 / 提醒 / 桌面固定 / 同步 / 数据 / 关于。
     默认仍停在「同步」—— 这是 verify-tauri.cjs / verify-sync.cjs 已经断言的入口，
     改默认页签会把既有回归撞红。点一下就到别的页签。 */
  const SET_NAV = [
    { id: 'general', name: '常规' },
    { id: 'appearance', name: '外观' },
    { id: 'reminder', name: '提醒' },
    { id: 'desktop', name: '桌面固定' },
    { id: 'sync', name: '同步' },
    { id: 'data', name: '数据' },
    { id: 'about', name: '关于' },
  ];

  function showScreen(name) {
    STATE.screen = name;
    configScreenEl.hidden = name !== 'config';
    settingsScreenEl.hidden = name !== 'settings';
    analysisScreenEl.hidden = name !== 'analysis';
    if (stageEl) stageEl.setAttribute('aria-hidden', 'true');
    if (name === 'analysis') { renderAnalysis(); return; }
    if (name === 'config') {
      renderNav(configNavEl, CONFIG_NAV, STATE.configTab);
      renderConfig();
    } else {
      renderNav(setNavEl, SET_NAV, STATE.settingsTab);
      renderSettings();
      refreshSyncStatus().then(function () { renderScreen(); }).catch(function () {});
      refreshReminderStatus().then(function () { renderScreen(); }).catch(function () {});
      refreshWallpaperStatus().then(function () { renderScreen(); }).catch(function () {});
    }
  }
  function closeScreen() {
    STATE.screen = null;
    configScreenEl.hidden = true;
    settingsScreenEl.hidden = true;
    analysisScreenEl.hidden = true;
    if (stageEl) stageEl.removeAttribute('aria-hidden');
    closeForm();
    closeMemoForm();
    closeBook();
    settleConfirm(false);
    closePanel();
  }
  /* 读后端调度器的真实状态（设置页每次进来 / 每次触发事件都刷一次） */
  async function refreshReminderStatus() {
    try {
      const res = await Promise.all([invoke('reminder_status', {}), invoke('reminder_upcoming', { limit: 5 })]);
      STATE.reminder = res[0] || {};
      STATE.upcoming = res[1] || [];
    } catch (err) {
      // 浏览器兜底（没有 Tauri）时如实标记为「未启动」，不伪造在跑
      STATE.reminder = {
        scheduled: 0,
        next_fire_at: 0,
        next_fire_text: '',
        next_fire_title: '',
        last_error: '不在 Tauri 里：' + (err && err.message ? err.message : String(err)),
        last_fired_at: 0,
        fired_count: 0,
        thread_alive: false,
        notify_ok: false,
        ringing: 0,
        tick_secs: 30,
        sound_playing: false,
      };
      STATE.upcoming = [];
    }
    return STATE.reminder;
  }

  function renderScreen() {
    if (STATE.screen === 'analysis') renderAnalysis();
    if (STATE.screen === 'config') renderConfig();
    if (STATE.screen === 'settings') {
      const focused = document.activeElement;
      if (focused && focused.id === 'syncUrl') return; // 正在输入地址时不打断
      renderSettings();
    }
  }
  function renderNav(el, items, active) {
    el.innerHTML = items.map(function (n) {
      return '<button type="button" data-tab="' + n.id + '"' +
        (n.id === active ? ' class="on" aria-current="true"' : '') + '>' + esc(n.name) + '</button>';
    }).join('');
  }

  /* 重复方式的只读文案（与契约 §3.1 枚举对齐） */
  function maskText(mask) {
    if (mask === 31) return '周一至周五';
    if (mask === 127) return '每天';
    if (mask === 96) return '周六、周日';
    const days = [];
    for (let i = 0; i < 7; i += 1) if (mask & (1 << i)) days.push(WEEK_CN_FULL[i]);
    return days.length ? days.join('、') : '未选任何工作日';
  }
  function modeName(mode) {
    return ['每周', '每 N 天', '每月', '每年', '不重复'][mode] || '未知';
  }
  function repeatText(r) {
    const mode = r.repeat_mode;
    if (mode === 0) return '每周 ' + maskText(r.weekdays_mask);
    if (mode === 1) return '每 ' + (r.repeat_every || 1) + ' 天（从 ' + r.start_date + ' 起）';
    if (mode === 2) return r.month_day === -1 ? '每月最后一天' : '每月 ' + r.month_day + ' 日';
    if (mode === 3) return '每年 ' + r.year_month + ' 月 ' + r.year_day + ' 日';
    if (mode === 4) return '只在 ' + r.start_date + ' 当天';
    return '未知重复方式';
  }
  function rangeText(r) {
    const upper = r.repeat_until || r.end_date;
    return '起始 ' + r.start_date + ' · ' + (upper ? '至 ' + upper : '不限');
  }

  /* ---------- 8.1 全局确认框（promise 化，禁止 window.confirm：WebView2 会阻塞） ---------- */
  const confirmMaskEl = document.getElementById('confirmMask');
  const confirmTitleEl = document.getElementById('confirmTitle');
  const confirmTextEl = document.getElementById('confirmText');
  let confirmResolve = null;

  function askConfirm(title, text) {
    confirmTitleEl.textContent = title;
    confirmTextEl.textContent = text;
    confirmMaskEl.hidden = false;
    return new Promise(function (resolve) { confirmResolve = resolve; });
  }
  function settleConfirm(value) {
    confirmMaskEl.hidden = true;
    const r = confirmResolve;
    confirmResolve = null;
    if (r) r(value);
  }
  document.getElementById('confirmOk').addEventListener('click', function () { settleConfirm(true); });
  document.getElementById('confirmCancel').addEventListener('click', function () { settleConfirm(false); });
  confirmMaskEl.addEventListener('click', function (e) { if (e.target === confirmMaskEl) settleConfirm(false); });

  /* 裂开前的确认文案：契约 §9.2 的原文口径，测试按这句断言 */
  const SPLIT_CONFIRM_TEXT = '修改重复设置会结束当前规则并新建一条，历史打卡保留。是否继续？';
  /* 契约 §9.2 的裂开字段：按当前 repeat_mode 取相关字段（与 db.rs 的 needs_split 一一对应）。
     mode 0 每周 → weekdays_mask；1 每 N 天 → repeat_every；2 每月 → month_day；
     3 每年 → year_month + year_day；4 不重复 → 无。repeat_mode 与 start_date 另算。 */
  const SPLIT_FIELDS_BY_MODE = {
    0: ['weekdays_mask'],
    1: ['repeat_every'],
    2: ['month_day'],
    3: ['year_month', 'year_day'],
    4: []
  };

  function splitFieldDiffers(a, b) {
    if (a.repeat_mode !== b.repeat_mode) return true;
    if (a.start_date !== b.start_date) return true;
    return (SPLIT_FIELDS_BY_MODE[b.repeat_mode] || []).some(function (k) { return a[k] !== b[k]; });
  }

  /* 提交前把与当前模式无关的字段归零：库里这些列本就该是 0，
     带着表单里的占位默认值上送会让「无关字段」看起来像改动（与 Android 同一口径）。 */
  function normalizeDraft(d) {
    const out = Object.assign({}, d);
    if (out.repeat_mode !== 0) out.weekdays_mask = 0;
    if (out.repeat_mode !== 1) out.repeat_every = 0;
    if (out.repeat_mode !== 2) out.month_day = 0;
    if (out.repeat_mode !== 3) { out.year_month = 0; out.year_day = 0; }
    return out;
  }
  function genClientId(prefix) {
    return prefix + '_' + Date.now().toString(16) + Math.random().toString(16).slice(2, 8);
  }
  function errText(err) {
    return (err && err.message) ? err.message : String(err);
  }

  /* ---------- 8.2 规则列表（可展开、可增删改） ---------- */
  const CFG = { expanded: new Set() };

  function ruleRowHtml(r) {
    const tasks = r.tasks || [];
    const open = CFG.expanded.has(r.id);
    const badges = [];
    if (r.ended) badges.push('<span class="badge ended">已结束</span>');
    if (!r.enabled) badges.push('<span class="badge">已停用</span>');
    const head =
      '<div class="rule-row' + (open ? ' open' : '') + '" data-rule="' + esc(r.id) + '" data-ended="' + (r.ended ? '1' : '0') + '">' +
        '<button class="rule-main" type="button" data-act="toggle">' +
          '<span class="rule-meta"><b>' + esc(r.title) + '</b>' + badges.join('') + '</span>' +
          '<i>' + esc(modeName(r.repeat_mode)) + ' · ' + esc(repeatText(r)) + ' · ' + esc(rangeText(r)) +
            (r.reminder_summary ? ' · ' + esc(r.reminder_summary) : '') + '</i>' +
        '</button>' +
        '<span class="rule-count">' + tasks.length + ' 个任务</span>' +
        '<span class="rule-acts">' +
          '<button class="btn sm" type="button" data-act="edit">编辑</button>' +
          '<button class="btn sm danger" type="button" data-act="del">删除</button>' +
        '</span>' +
      '</div>';
    if (!open) return '<div class="rule-block" data-rule-block="' + esc(r.id) + '">' + head + '</div>';
    const rows = tasks.map(function (t) {
      return '<div class="task-row" data-task="' + esc(t.id) + '">' +
        '<input class="inp task-name" data-act="rename" value="' + esc(t.title) + '" aria-label="任务名" />' +
        '<button class="btn sm" type="button" data-act="toggle-task" aria-pressed="' + (t.enabled ? 'true' : 'false') + '">' +
          (t.enabled ? '停用' : '启用') + '</button>' +
        '<button class="btn sm danger" type="button" data-act="del-task">删除</button>' +
      '</div>';
    }).join('');
    const add = r.ended ? '<i class="hint">已结束的规则不再新增任务</i>' :
      '<div class="task-add"><input class="inp" data-act="new-task-name" placeholder="新任务名" />' +
        '<button class="btn sm" type="button" data-act="add-task">添加任务</button></div>';
    return '<div class="rule-block" data-rule-block="' + esc(r.id) + '">' + head +
      '<div class="rule-tasks">' + (rows || '<div class="mempty">还没有任务</div>') + add + '</div></div>';
  }

  function renderConfig() {
    if (STATE.configTab !== 'rules') { renderMemoTab(); return; }
    renderRuleTab();
  }

  function renderRuleTab() {
    const all = STATE.rulesAll || [];
    const active = all.filter(function (r) { return !r.ended; });
    const ended = all.filter(function (r) { return r.ended; });
    const head = '<div class="cfg-head"><div>' +
        '<div class="panel-title">规则与任务</div>' +
        '<div class="panel-desc">共 ' + all.length + ' 条规则（进行中 ' + active.length + ' 条）。' +
          '点一行展开任务；改重复设置会结束旧规则并新建一条，历史打卡保留。</div>' +
      '</div>' +
      '<button class="btn primary" id="newRule" type="button">＋ 新建规则</button></div>';
    if (!all.length) {
      configMainEl.innerHTML = head + '<div class="card"><div class="row"><div class="k">' +
        '<b>还没有规则</b><i>点右上角「＋ 新建规则」开始</i></div></div></div>';
      return;
    }
    configMainEl.innerHTML = head +
      '<div class="card" id="ruleList">' + active.map(ruleRowHtml).join('') +
        (active.length ? '' : '<div class="row"><div class="k"><b>没有进行中的规则</b><i>历史规则在下面</i></div></div>') +
      '</div>' +
      (ended.length ? '<div class="panel-title sub">已结束（历史只读重复设置，仍可改名 / 启停 / 删任务）</div>' +
        '<div class="card" id="ruleListEnded">' + ended.map(ruleRowHtml).join('') + '</div>' : '');
  }

  function findRule(id) {
    return (STATE.rulesAll || []).find(function (r) { return r.id === id; });
  }

  /* 每次写操作之后：重拉规则 + 丢掉月历缓存重画（命中日可能整片变了） */
  async function afterRuleMutation() {
    await loadRules();
    STATE.cache.clear();
    STATE.loaded.clear();
    await render();
    if (STATE.screen === 'config') renderConfig();
    refreshSyncStatus().catch(function () {});
  }

  async function loadRules() {
    const pair = await Promise.all([
      invoke('list_rules', { includeEnded: false, today: TODAY }),
      invoke('list_rules', { includeEnded: true, today: TODAY })
    ]);
    STATE.rules = pair[0] || [];
    STATE.rulesAll = pair[1] || [];
  }

  async function deleteRuleFlow(rule) {
    const n = (rule.tasks || []).length;
    const ok = await askConfirm('删除规则',
      '将删除该规则及其 ' + n + ' 个任务（打卡历史保留）');
    if (!ok) return;
    try {
      await invoke('delete_rule', { id: rule.id });
    } catch (err) {
      STATE.hint = '删除失败：' + errText(err);
      return;
    }
    CFG.expanded.delete(rule.id);
    await afterRuleMutation();
  }

  /* 规则 id：行头在 .rule-row 上，展开的任务在 .rule-block 上，两处都要能定位 */
  function ruleIdOfEl(el) {
    const block = el.closest('[data-rule-block]');
    if (block) return block.dataset.ruleBlock;
    const row = el.closest('.rule-row');
    return row ? row.dataset.rule : null;
  }

  async function ruleAction(el) {
    const ruleId = ruleIdOfEl(el);
    if (!ruleId) return;
    const rule = findRule(ruleId);
    const act = el.dataset.act;
    if (act === 'toggle') {
      if (CFG.expanded.has(ruleId)) CFG.expanded.delete(ruleId); else CFG.expanded.add(ruleId);
      renderConfig();
      return;
    }
    if (!rule) return;
    if (act === 'edit') { openForm('edit', rule.id); return; }
    if (act === 'del') { await deleteRuleFlow(rule); return; }
    if (act === 'toggle-task' || act === 'del-task') {
      const tr = el.closest('.task-row');
      if (!tr) return;
      const taskId = tr.dataset.task;
      const task = (rule.tasks || []).find(function (t) { return t.id === taskId; });
      if (!task) return;
      if (act === 'toggle-task') {
        try { await invoke('set_task_enabled', { taskId: taskId, enabled: !task.enabled }); }
        catch (err) { STATE.hint = '改任务失败：' + errText(err); return; }
        await afterRuleMutation();
        return;
      }
      const ok = await askConfirm('删除任务', '确定删除任务「' + task.title + '」？打卡历史保留。');
      if (!ok) return;
      try { await invoke('delete_task', { taskId: taskId }); }
      catch (err) { STATE.hint = '删除任务失败：' + errText(err); return; }
      await afterRuleMutation();
    }
  }

  async function addTaskFromConfig(el) {
    const ruleId = ruleIdOfEl(el);
    if (!ruleId) return;
    const block = el.closest('[data-rule-block]');
    const input = block ? block.querySelector('[data-act="new-task-name"]') : null;
    const title = input ? input.value.trim() : '';
    if (!title) { if (input) input.focus(); return; }
    try { await invoke('add_task', { ruleId: ruleId, title: title }); }
    catch (err) { STATE.hint = '加任务失败：' + errText(err); return; }
    await afterRuleMutation();
  }

  async function renameTaskFromConfig(input) {
    const tr = input.closest('.task-row');
    const ruleId = ruleIdOfEl(input);
    if (!tr || !ruleId) return;
    const taskId = tr.dataset.task;
    const rule = findRule(ruleId);
    const task = rule && (rule.tasks || []).find(function (t) { return t.id === taskId; });
    const next = input.value.trim();
    if (!task || !next || next === task.title) { if (task) input.value = task.title; return; }
    try { await invoke('rename_task', { taskId: taskId, title: next }); }
    catch (err) { STATE.hint = '改名失败：' + errText(err); input.value = task.title; return; }
    await afterRuleMutation();
  }

  configMainEl.addEventListener('click', function (e) {
    if (e.target.closest('#newRule')) { openForm('create'); return; }
    const el = e.target.closest('[data-act]');
    if (!el) return;
    if (el.dataset.act === 'add-task') { addTaskFromConfig(el); return; }
    if (el.dataset.act === 'rename') return; // 输入框的点击不触发动作
    ruleAction(el);
  });
  configMainEl.addEventListener('change', function (e) {
    if (e.target.matches('.task-name[data-act="rename"]')) renameTaskFromConfig(e.target);
  });
  configMainEl.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter') return;
    if (e.target.matches('[data-act="new-task-name"]')) { e.preventDefault(); addTaskFromConfig(e.target); }
    if (e.target.matches('.task-name[data-act="rename"]')) { e.preventDefault(); e.target.blur(); }
  });

  /* ---------- 8.2b 记事 / 倒数日 / 笔记本（契约 §10） ----------
     记事与笔记本用「文档式全屏页」（照 prototype/pc.html 的 #bookScreen），
     倒数日沿用普通表单。三者都只写本地库：create_memo / update_memo / delete_memo。 */

  const MEMO_KIND = { note: 0, countdown: 1, notebook: 2 };
  const MEMO_CN = { 0: '记事', 1: '倒数日', 2: '笔记本' };
  const MEMO_CAT_NONE = '未分类';

  const bookScreenEl = document.getElementById('bookScreen');
  const bookTitleEl = document.getElementById('bookTitle');
  const bookBodyEl = document.getElementById('bookBody');
  const bookTimeEl = document.getElementById('bookTime');
  const bookWordsEl = document.getElementById('bookWords');
  const bookSavedEl = document.getElementById('bookSaved');
  const bookRangeEl = document.getElementById('bookRange');
  const bookStartEl = document.getElementById('bookStart');
  const bookEndEl = document.getElementById('bookEnd');
  const bookCatEl = document.getElementById('bookCat');
  const bookPickerMaskEl = document.getElementById('bookPickerMask');
  const bookPickerListEl = document.getElementById('bookPickerList');
  const bookNewCatEl = document.getElementById('bookNewCat');
  const memoMaskEl = document.getElementById('memoMask');
  const memoTitleEl = document.getElementById('memoTitle');
  const memoBodyEl = document.getElementById('memoBody');
  const memoFootEl = document.getElementById('memoFoot');

  const mdKey = function (key) {
    if (!key) return '';
    const p = parseKey(key);
    return p.m + '/' + p.d;
  };
  /* 记事元信息：未排期 / 单日 10/27 / 时间段 10/27 ~ 10/29（契约 §10.4） */
  function noteRangeLabel(m) {
    if (!m.start_date) return '未排期';
    if (!m.end_date || m.end_date === m.start_date) return mdKey(m.start_date);
    return mdKey(m.start_date) + ' ~ ' + mdKey(m.end_date);
  }
  function noteRangeFull(m) {
    if (!m.start_date) return '未排期';
    if (!m.end_date || m.end_date === m.start_date) return m.start_date;
    return m.start_date + ' ~ ' + m.end_date;
  }
  const wordsOf = function (s) { return String(s || '').replace(/\s/g, '').length; };
  /* 倒数日的天数差：负数 = 已经过去，0 = 今天，正数 = 还有多少天 */
  function countdownText(m) {
    if (!m.start_date) return '没有目标日';
    const delta = daySerial(m.start_date) - daySerial(TODAY);
    if (delta < 0) return '已经 ' + (-delta) + ' 天';
    if (delta === 0) return '就是今天';
    return '还有 ' + delta + ' 天';
  }
  function stampText(ms) {
    const d = ms ? new Date(ms) : new Date();
    const h = d.getHours();
    const ampm = h < 12 ? '上午' : '下午';
    const h12 = h % 12 === 0 ? 12 : h % 12;
    return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + ampm + h12 + ':' + pad2(d.getMinutes());
  }

  async function loadMemos() {
    const list = await Promise.all([
      invoke('list_memos', { kind: 0 }),
      invoke('list_memos', { kind: 1 }),
      invoke('list_memos', { kind: 2 })
    ]);
    STATE.memos = { 0: list[0] || [], 1: list[1] || [], 2: list[2] || [] };
  }

  /* 任何 memo 写操作之后：重拉三类列表 + 丢掉月历缓存重画（记事的命中日可能整片变了） */
  async function afterMemoMutation() {
    await loadMemos();
    STATE.cache.clear();
    STATE.memoCache.clear();
    STATE.loaded.clear();
    await render();
    if (STATE.screen === 'config') renderConfig();
    refreshSyncStatus().catch(function () {});
  }

  function findMemo(kind, id) {
    return (STATE.memos[kind] || []).find(function (m) { return m.id === id; }) || null;
  }

  function memoRowHtml(kind, m) {
    const title = String(m.title || '').trim() || (kind === 2 ? '无标题笔记' : '（无标题）');
    let sub = '';
    if (kind === 0) sub = noteRangeFull(m);
    else if (kind === 1) sub = '目标日 ' + m.start_date.replace(/-/g, '/') + ' · ' + countdownText(m);
    else sub = String(m.content || '').trim() || '还没有正文';
    const cat = kind === 2
      ? '<i class="memo-cat">' + esc(m.category || MEMO_CAT_NONE) + '</i>' : '';
    return '<div class="memo-row" data-memo="' + esc(m.id) + '">' +
        '<button class="memo-main" type="button" data-memo-act="edit">' +
          '<span class="rule-meta"><b>' + esc(title) + '</b>' + cat + '</span>' +
          '<i>' + esc(sub + (m.reminder_summary ? ' · ' + m.reminder_summary : '')) + '</i>' +
        '</button>' +
        '<span class="memo-acts">' +
          '<button class="btn sm" type="button" data-memo-act="edit">编辑</button>' +
          '<button class="btn sm danger" type="button" data-memo-act="del">删除</button>' +
        '</span>' +
      '</div>';
  }

  const MEMO_TAB_META = {
    note: { title: '记事', desc: '可选时间段。留空 = 不排期，只留在列表里；填了日期就按月历逐日显示。' },
    countdown: { title: '倒数日', desc: '只算与今天的天数差，不进入月历。' },
    notebook: { title: '笔记本', desc: '记录非时间性的事情，永远不进月历与打卡。' }
  };

  function renderMemoTab() {
    const tab = STATE.configTab;
    const kind = MEMO_KIND[tab];
    const meta = MEMO_TAB_META[tab];
    const list = (STATE.memos[kind] || []).slice();
    const head = '<div class="cfg-head"><div>' +
        '<div class="panel-title">' + meta.title + '</div>' +
        '<div class="panel-desc">共 ' + list.length + ' 条。' + meta.desc + '</div>' +
      '</div>' +
      '<button class="btn primary" id="newMemo" type="button">＋ 新建' + meta.title + '</button></div>';
    if (!list.length) {
      configMainEl.innerHTML = head + '<div class="card"><div class="row"><div class="k">' +
        '<b>还没有' + meta.title + '</b><i>点右上角「＋ 新建' + meta.title + '」开始</i></div></div></div>';
      return;
    }
    configMainEl.innerHTML = head + '<div class="card" id="memoList">' +
      list.map(function (m) { return memoRowHtml(kind, m); }).join('') + '</div>';
  }

  /* ---- 文档式全屏页：记事（kind 0）与笔记本（kind 2）共用 ---- */
  const BOOK = { kind: 0, id: '', timer: 0, busy: false, updatedAt: 0 };

  function bookCategory() {
    return String(bookCatEl.dataset.cat || '').trim();
  }

  function renderBookMeta() {
    const words = wordsOf(bookBodyEl.value);
    bookWordsEl.textContent = words + ' 字';
    if (BOOK.kind === 0) {
      bookTimeEl.textContent = noteRangeLabel({ start_date: bookStartEl.value, end_date: bookEndEl.value });
    } else {
      bookTimeEl.textContent = '更新于 ' + stampText(BOOK.updatedAt);
    }
  }

  function openBook(kind, memo) {
    BOOK.kind = kind;
    BOOK.id = memo ? memo.id : genClientId('m');
    BOOK.updatedAt = memo ? memo.updated_at : Date.now();
    bookScreenEl.hidden = false;
    bookRangeEl.hidden = kind !== 0;
    bookCatEl.hidden = kind !== 2;
    bookSavedEl.textContent = '';
    bookCatEl.dataset.cat = kind === 2 ? String((memo && memo.category) || '') || MEMO_CAT_NONE : '';
    bookCatEl.textContent = bookCatEl.dataset.cat || MEMO_CAT_NONE;
    bookTitleEl.textContent = memo ? memo.title || '' : '';
    bookBodyEl.value = memo ? memo.content || '' : '';
    bookStartEl.value = memo ? memo.start_date || '' : '';
    bookEndEl.value = memo ? memo.end_date || '' : '';
    renderBookMeta();
    if (!memo) { bookTitleEl.focus(); }
  }

  function closeBook() {
    if (BOOK.timer) { clearTimeout(BOOK.timer); BOOK.timer = 0; }
    bookScreenEl.hidden = true;
    bookPickerMaskEl.hidden = true;
    bookCatEl.setAttribute('aria-expanded', 'false');
    BOOK.id = '';
  }

  function bookPayload() {
    return {
      id: BOOK.id,
      kind: BOOK.kind,
      title: bookTitleEl.textContent.trim(),
      content: bookBodyEl.value,
      start_date: BOOK.kind === 0 ? bookStartEl.value : '',
      end_date: BOOK.kind === 0 ? bookEndEl.value : '',
      category: BOOK.kind === 2 ? bookCategory() : ''
    };
  }

  /* 600ms 静默自动保存：停顿后才写，输入期间不打断（契约 §10.4 的文档式页） */
  function queueBookSave() {
    renderBookMeta();
    if (BOOK.timer) clearTimeout(BOOK.timer);
    BOOK.timer = setTimeout(saveBook, 600);
  }

  async function saveBook() {
    BOOK.timer = 0;
    if (bookScreenEl.hidden) return;
    /* 上一次写还在飞：把这次改动排到后面，不能直接丢（否则最后几个字会掉） */
    if (BOOK.busy) { BOOK.timer = setTimeout(saveBook, 200); return; }
    const body = bookPayload();
    if (!body.title && !body.content.trim()) return; // 空页不落库（笔记本也要求至少有一处内容）
    if (!findMemo(BOOK.kind, BOOK.id) && (body.kind === 2 ? !body.content.trim() && !body.title : !body.title)) return;
    BOOK.busy = true;
    try {
      const exists = !!findMemo(BOOK.kind, BOOK.id);
      if (exists) await invoke('update_memo', { memoJson: JSON.stringify(body) });
      else await invoke('create_memo', { memoJson: JSON.stringify(body) });
      bookSavedEl.textContent = '已保存';
      await afterMemoMutation();
      const fresh = findMemo(BOOK.kind, BOOK.id);
      if (fresh) BOOK.updatedAt = fresh.updated_at;
      if (bookScreenEl.hidden === false) renderBookMeta();
    } catch (err) {
      bookSavedEl.textContent = '';
      STATE.hint = '保存失败：' + errText(err);
    } finally {
      BOOK.busy = false;
    }
  }

  async function deleteMemoFlow(memo) {
    const cn = MEMO_CN[memo.kind];
    const text = memo.kind === 2
      ? '将删除该笔记及其正文，删除后不可恢复。'
      : '将删除该' + cn + '，删除后不可恢复。';
    const ok = await askConfirm('删除' + cn, text);
    if (!ok) return false;
    try { await invoke('delete_memo', { id: memo.id }); }
    catch (err) { STATE.hint = '删除失败：' + errText(err); return false; }
    await afterMemoMutation();
    return true;
  }

  /* ---- 分类 chip 与分类选择层（笔记本专用；不单独建分类表，分类名就在 category 字段里） ---- */
  function categoryNames() {
    const used = (STATE.memos[2] || []).map(function (m) { return String(m.category || '').trim(); })
      .filter(function (c) { return c && c !== MEMO_CAT_NONE; });
    return [MEMO_CAT_NONE].concat(Array.from(new Set(used)));
  }

  function renderBookPicker() {
    const cur = bookCategory() || MEMO_CAT_NONE;
    bookPickerListEl.innerHTML = categoryNames().map(function (c) {
      return '<button class="book-cat' + (c === cur ? ' on' : '') + '" type="button" data-cat="' + esc(c) + '">' +
        '<span>' + esc(c) + '</span>' + (c === cur ? '<span class="bk-tick">✓</span>' : '') + '</button>';
    }).join('');
  }

  function openBookPicker() {
    renderBookPicker();
    bookPickerMaskEl.hidden = false;
    bookCatEl.setAttribute('aria-expanded', 'true');
  }
  function closeBookPicker() {
    bookPickerMaskEl.hidden = true;
    bookCatEl.setAttribute('aria-expanded', 'false');
  }

  /* ---- 倒数日：普通表单（标题 + 目标日 + 备注） ---- */
  const MEMO_FORM = { memo: null };

  function openMemoForm(memo) {
    MEMO_FORM.memo = memo || null;
    memoTitleEl.textContent = memo ? '编辑倒数日' : '新建倒数日';
    const m = memo || { title: '', start_date: '', content: '' };
    memoBodyEl.innerHTML =
      '<div class="mfield"><label for="mTitle">标题</label>' +
        '<input class="inp" id="mTitle" placeholder="例如：项目验收" value="' + esc(m.title || '') + '" /></div>' +
      '<div class="mfield"><label for="mDate">目标日</label>' +
        '<input class="inp" id="mDate" type="date" value="' + esc(m.start_date || '') + '" />' +
        '<span class="fhint">可以是未来或过去：未来显示「还有 N 天」，过去显示「已经 N 天」</span></div>' +
      '<div class="mfield"><label for="mNote">备注</label>' +
        '<textarea class="inp" id="mNote" placeholder="可选">' + esc(m.content || '') + '</textarea></div>' +
      '<div class="ferr" id="memoErr" hidden></div>';
    memoFootEl.innerHTML = '<div style="flex:1"></div>' +
      '<button class="btn" id="memoCancel" type="button">取消</button>' +
      '<button class="btn primary" id="memoSave" type="button">保存</button>';
    memoMaskEl.hidden = false;
    const t = document.getElementById('mTitle');
    if (t) t.focus();
  }

  function closeMemoForm() {
    memoMaskEl.hidden = true;
    MEMO_FORM.memo = null;
  }

  async function saveMemoForm() {
    const errEl = document.getElementById('memoErr');
    const body = {
      kind: 1,
      title: document.getElementById('mTitle').value.trim(),
      start_date: document.getElementById('mDate').value,
      content: document.getElementById('mNote').value
    };
    if (MEMO_FORM.memo) body.id = MEMO_FORM.memo.id;
    const btn = document.getElementById('memoSave');
    if (btn) btn.disabled = true;
    try {
      if (body.id) await invoke('update_memo', { memoJson: JSON.stringify(body) });
      else await invoke('create_memo', { memoJson: JSON.stringify(body) });
    } catch (err) {
      if (btn) btn.disabled = false;
      if (errEl) { errEl.textContent = errText(err); errEl.hidden = false; }
      return;
    }
    closeMemoForm();
    await afterMemoMutation();
  }

  configNavEl.addEventListener('click', function (e) {
    const btn = e.target.closest('button[data-tab]');
    if (!btn) return;
    STATE.configTab = btn.dataset.tab;
    renderNav(configNavEl, CONFIG_NAV, STATE.configTab);
    renderConfig();
  });

  configMainEl.addEventListener('click', async function (e) {
    if (!e.target.closest('#newMemo')) {
      const el = e.target.closest('[data-memo-act]');
      if (!el) return;
      const row = el.closest('[data-memo]');
      if (!row) return;
      const kind = MEMO_KIND[STATE.configTab];
      const memo = findMemo(kind, row.dataset.memo);
      if (!memo) return;
      if (el.dataset.memoAct === 'del') { await deleteMemoFlow(memo); return; }
      openMemoEditor(kind, memo);
      return;
    }
    if (STATE.configTab === 'countdown') { openMemoForm(null); return; }
    openBook(MEMO_KIND[STATE.configTab], null);
  });

  /* 记事 / 笔记本点行 → 文档式页；倒数日点行 → 普通表单 */
  function openMemoEditor(kind, memo) {
    if (kind === 1) { openMemoForm(memo); return; }
    openBook(kind, memo);
  }

  document.getElementById('bookBack').addEventListener('click', closeBook);
  document.getElementById('bookDel').addEventListener('click', async function () {
    const memo = findMemo(BOOK.kind, BOOK.id);
    if (!memo) { closeBook(); return; }
    const ok = await deleteMemoFlow(memo);
    if (ok) closeBook();
  });
  bookTitleEl.addEventListener('input', queueBookSave);
  bookTitleEl.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    bookBodyEl.focus();
  });
  bookBodyEl.addEventListener('input', queueBookSave);
  bookStartEl.addEventListener('change', queueBookSave);
  bookEndEl.addEventListener('change', queueBookSave);

  bookCatEl.addEventListener('click', function () {
    if (bookPickerMaskEl.hidden) openBookPicker(); else closeBookPicker();
  });
  bookPickerListEl.addEventListener('click', function (e) {
    const btn = e.target.closest('button[data-cat]');
    if (!btn) return;
    bookCatEl.dataset.cat = btn.dataset.cat;
    bookCatEl.textContent = btn.dataset.cat;
    closeBookPicker();
    queueBookSave();
  });
  document.getElementById('bookNewCatBtn').addEventListener('click', function () {
    const name = bookNewCatEl.value.trim();
    if (!name) { bookNewCatEl.focus(); return; }
    bookCatEl.dataset.cat = name;
    bookCatEl.textContent = name;
    bookNewCatEl.value = '';
    closeBookPicker();
    queueBookSave();
  });
  bookNewCatEl.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    document.getElementById('bookNewCatBtn').click();
  });
  bookPickerMaskEl.addEventListener('click', function (e) {
    if (e.target === bookPickerMaskEl) closeBookPicker();
  });

  memoMaskEl.addEventListener('click', function (e) { if (e.target === memoMaskEl) closeMemoForm(); });
  document.getElementById('memoClose').addEventListener('click', closeMemoForm);
  memoFootEl.addEventListener('click', function (e) {
    if (e.target.closest('#memoCancel')) { closeMemoForm(); return; }
    if (e.target.closest('#memoSave')) saveMemoForm();
  });

  /* ---------- 8.3 规则表单（照 prototype/pc.html 的编辑器） ---------- */
  const formMaskEl = document.getElementById('formMask');
  const formTitleEl = document.getElementById('formTitle');
  const formBodyEl = document.getElementById('formBody');
  const formFootEl = document.getElementById('formFoot');
  const MODE_NAMES = ['每周', '每 N 天', '每月', '每年', '不重复'];
  const EVERY_PRESETS = [2, 3, 7, 14, 30];

  const FORM = { mode: 'create', ruleId: null, ended: false, orig: null, draft: null, tasks: [], splitResult: null, reminder: null };

  /* ---------- 提醒（契约 §11）：通知 / 闹钟是两个独立开关 ----------
     存储口径：一行提醒带 notify_on / alarm_on 两个 0/1，共用一个 time_of_day（与 schema、
     Go 后端 SyncReminder、Android ReminderFormat 一致）。「不提醒」不是一个可存的状态 ——
     点它是把两个开关清零并退出，保存时走 clear_reminder 软删该行（§11.1 / R3）。 */
  const REMIND_TIME = '09:00';
  const REMIND_SNOOZE = 5;
  function emptyReminder() {
    return {
      id: '', notify_on: 0, alarm_on: 0, time_of_day: REMIND_TIME, notify_text: '',
      offset_days: 0, repeat_rule: 1, snooze_min: 0, touched: false
    };
  }
  function reminderOf(row) {
    return {
      id: row.id || '',
      notify_on: row.notify_on ? 1 : 0,
      alarm_on: row.alarm_on ? 1 : 0,
      time_of_day: row.time_of_day || REMIND_TIME,
      notify_text: row.notify_text || '',
      offset_days: row.offset_days || 0,
      repeat_rule: row.repeat_rule ? 1 : 0,
      snooze_min: row.snooze_min || 0,
      touched: false
    };
  }
  function remindOn() { return !!(FORM.reminder && (FORM.reminder.notify_on || FORM.reminder.alarm_on)); }

  /* 存储摘要 → 列表文案（契约 §11.3 的「通知 21:00 + 闹钟 21:00」）。与 Rust 侧 reminder_summary 同序。 */
  function reminderSummaryOf(row) {
    if (!row) return '';
    const time = String(row.time_of_day || '');
    const parts = [];
    if (row.notify_on) parts.push('通知 ' + time);
    if (row.alarm_on) parts.push('闹钟 ' + time);
    return parts.join(' + ');
  }

  /* 打开表单时把该规则的提醒读回来；读到之前先按「不提醒」渲染（本地库，几乎瞬时）。
     用户已经点过按钮（touched）就不再覆盖，免得回填把刚点的一下冲掉。 */
  function loadRuleReminder(ruleId) {
    invoke('get_reminder', { ownerKind: 0, ownerId: ruleId }).then(function (row) {
      if (FORM.ruleId !== ruleId || FORM.reminder.touched) return;
      FORM.reminder = row ? reminderOf(row) : emptyReminder();
      renderForm();
    }).catch(function () { /* 读提醒失败不挡表单：按不提醒处理 */ });
  }

  function remindSegHtml() {
    const r = FORM.reminder;
    const none = !r.notify_on && !r.alarm_on;
    const btn = function (v, label, on) {
      return '<button type="button" data-remind="' + v + '" aria-pressed="' + (on ? 'true' : 'false') + '"' +
        (on ? ' class="on"' : '') + '>' + label + '</button>';
    };
    return btn('none', '不提醒', none) + btn('notify', '通知', !!r.notify_on) + btn('alarm', '闹钟', !!r.alarm_on);
  }

  function remindFieldsHtml() {
    const r = FORM.reminder;
    if (!r.notify_on && !r.alarm_on) {
      return '<i class="hint">点「通知」或「闹钟」开启提醒；两者可以同时开，也可以单独开。规则下的任务继承这条提醒，不单独配。</i>';
    }
    let html = '<div class="fdetail-line"><span>提醒时间</span>' +
      '<input class="inp" type="time" id="fRemindTime" value="' + esc(r.time_of_day) + '" />' +
      '<i class="hint">通知与闹钟共用一个时刻</i></div>';
    if (r.notify_on) {
      html += '<div class="fdetail-line"><span>通知文案</span>' +
        '<input class="inp" id="fNotifyText" maxlength="60" value="' + esc(r.notify_text) + '" placeholder="该打卡了：' +
        esc(FORM.draft.title || '规则名') + '" /></div>' +
        '<i class="hint">留空则用「该打卡了：规则名」。</i>';
    }
    if (r.alarm_on) {
      html += '<div class="fdetail-line"><span>贪睡</span>' +
        '<label class="chk-inline"><input type="checkbox" id="fSnooze"' + (r.snooze_min > 0 ? ' checked' : '') +
        ' /> 闹钟响后可贪睡 ' + REMIND_SNOOZE + ' 分钟</label></div>';
    }
    html += '<i class="hint">首期只做存与显示，不真正弹通知 / 响铃（契约 §11.3）。</i>';
    return html;
  }

  function draftOf(rule) {
    return {
      title: rule.title,
      enabled: rule.enabled,
      repeat_mode: rule.repeat_mode,
      weekdays_mask: rule.weekdays_mask,
      repeat_every: rule.repeat_every,
      month_day: rule.month_day,
      year_month: rule.year_month,
      year_day: rule.year_day,
      start_date: rule.start_date,
      end_date: rule.end_date || ''
    };
  }

  function openForm(mode, ruleId) {
    const rule = mode === 'edit' ? findRule(ruleId) : null;
    if (mode === 'edit' && !rule) return;
    FORM.mode = mode;
    FORM.ruleId = ruleId || null;
    FORM.ended = !!(rule && rule.ended);
    FORM.splitResult = null;
    FORM.orig = rule ? draftOf(rule) : null;
    FORM.draft = rule ? draftOf(rule) : {
      title: '', enabled: true, repeat_mode: 0, weekdays_mask: 31, repeat_every: 2,
      month_day: 1, year_month: 1, year_day: 1, start_date: TODAY, end_date: ''
    };
    FORM.tasks = rule
      ? (rule.tasks || []).map(function (t) { return { id: t.id, title: t.title, enabled: t.enabled }; })
      : [{ id: null, title: '', enabled: true }];
    FORM.reminder = emptyReminder();
    if (rule) loadRuleReminder(rule.id);
    formTitleEl.textContent = mode === 'edit' ? '编辑规则' : '新建规则';
    renderForm();
    formMaskEl.hidden = false;
    const first = formBodyEl.querySelector('#fTitle');
    if (first) first.focus();
  }

  function closeForm() {
    formMaskEl.hidden = true;
    FORM.splitResult = null;
  }

  function formTasksHtml() {
    if (!FORM.tasks.length) return '<div class="mempty">至少需要一个任务</div>';
    return FORM.tasks.map(function (t, i) {
      return '<div class="task-row" data-idx="' + i + '">' +
        '<input class="inp task-name" data-tidx="' + i + '" value="' + esc(t.title) + '" placeholder="任务名" aria-label="任务名" />' +
        '<button class="btn sm danger" type="button" data-act="form-del-task" data-tidx="' + i + '">删除</button>' +
      '</div>';
    }).join('');
  }

  function detailHtml() {
    const d = FORM.draft;
    const dis = FORM.ended ? ' disabled' : '';
    if (d.repeat_mode === 0) {
      return '<div class="seg days" id="fDays">' + WEEK_CN.map(function (c, i) {
        const on = d.weekdays_mask & (1 << i);
        return '<button type="button" data-day="' + i + '"' + (on ? ' class="on"' : '') + dis + '>周' + c + '</button>';
      }).join('') + '</div>';
    }
    if (d.repeat_mode === 1) {
      return '<div class="fdetail-line"><span>每</span>' +
        '<input class="inp num" type="number" id="fEvery" min="1" max="3660" value="' + (d.repeat_every || 1) + '"' + dis + ' />' +
        '<span>天</span></div>' +
        '<div class="chips" id="fEveryChips">' + EVERY_PRESETS.map(function (n) {
          return '<button type="button" class="task-chip' + (d.repeat_every === n ? ' on' : '') +
            '" data-every="' + n + '"' + dis + '>' + n + ' 天</button>';
        }).join('') + '</div>';
    }
    if (d.repeat_mode === 2) {
      const last = d.month_day === -1;
      return '<div class="fdetail-line"><span>每月</span>' +
        '<input class="inp num" type="number" id="fMonthDay" min="1" max="31" value="' + (last ? 1 : d.month_day) + '"' +
          (last || FORM.ended ? ' disabled' : '') + ' /><span>日</span>' +
        '<label class="chk-inline"><input type="checkbox" id="fLastDay"' + (last ? ' checked' : '') + dis + ' /> 最后一天</label>' +
        '</div><i class="hint">填 31 时 2 月落 28/29，3 月仍回 31；「最后一天」随月份自动变</i>';
    }
    if (d.repeat_mode === 3) {
      return '<div class="fdetail-line"><span>每年</span>' +
        '<select class="inp num" id="fYearMonth"' + dis + '>' +
          Array.from({ length: 12 }, function (_, i) {
            return '<option value="' + (i + 1) + '"' + (d.year_month === i + 1 ? ' selected' : '') + '>' + (i + 1) + ' 月</option>';
          }).join('') + '</select>' +
        '<input class="inp num" type="number" id="fYearDay" min="1" max="31" value="' + d.year_day + '"' + dis + ' />' +
        '<span>日</span></div>' +
        '<i class="hint">2 月 29 日在平年落 2 月 28 日，不溢出到 3 月</i>';
    }
    return '<i class="hint">不重复：只在开始日期那一天命中一次。</i>';
  }

  function renderForm() {
    if (FORM.splitResult) { renderSplitResult(); return; }
    const d = FORM.draft;
    const dis = FORM.ended ? ' disabled' : '';
    formBodyEl.innerHTML =
      '<div class="frow"><label>名称</label><input class="inp" id="fTitle" value="' + esc(d.title) + '" placeholder="例如 工作日常规" /></div>' +
      (FORM.ended ? '<div class="fbanner">该规则已结束：重复设置不可再改（改了会重算历史命中日），只能改名称 / 启停 / 任务。</div>' : '') +
      '<div class="frow col"><label>重复方式</label><div class="seg" id="fMode">' +
        MODE_NAMES.map(function (n, i) {
          return '<button type="button" data-mode="' + i + '"' + (d.repeat_mode === i ? ' class="on"' : '') +
            (FORM.ended ? ' disabled' : '') + '>' + n + '</button>';
        }).join('') + '</div></div>' +
      '<div class="frow col"><label>重复设置</label>' + detailHtml() + '</div>' +
      '<div class="frow"><label>开始日期</label><input class="inp" type="date" id="fStart" value="' + esc(d.start_date) + '"' + dis + ' /></div>' +
      '<div class="frow"><label>结束日期</label><input class="inp" type="date" id="fEnd" value="' + esc(d.end_date || '') + '"' + dis + ' />' +
        '<i class="hint">可选，不填表示不限</i></div>' +
      '<div class="frow col"><label>提醒</label><div class="seg" id="fRemind">' + remindSegHtml() + '</div>' +
        remindFieldsHtml() + '</div>' +
      '<div class="frow col"><label>任务</label><div id="fTasks">' + formTasksHtml() + '</div>' +
        '<div class="task-add"><input class="inp" id="fNewTask" placeholder="新任务名" />' +
        '<button class="btn sm" type="button" id="fAddTask">添加任务</button></div></div>' +
      '<div class="frow"><label>启用</label><label class="chk-inline"><input type="checkbox" id="fEnabled"' +
        (d.enabled ? ' checked' : '') + ' /> 该规则参与月历命中</label></div>' +
      '<div class="ferr" id="fErr" hidden></div>';
    formFootEl.innerHTML = '<button class="btn" id="fCancel" type="button">取消</button>' +
      '<button class="btn primary" id="fSave" type="button">保存</button>';
  }

  /* 裂开后的结果页：底部「复制 N 个任务到新规则」，**默认勾选**（契约 §9.2）。
     默认勾的理由：不勾时用户只是改了个重复设置、新规则却空着，观感等于「任务全没了」；
     而复制产出的是新 id 的任务，旧规则的任务与打卡一条不动，历史归属不变，风险为零。
     取消勾选仍是合法路径（新规则先留空，稍后自己加），不拦。 */
  function renderSplitResult() {
    const res = FORM.splitResult;
    const oldRule = findRule(res.old_rule_id);
    const newRule = res.new_rule_id ? findRule(res.new_rule_id) : null;
    const oldTasks = (oldRule && oldRule.tasks) || [];
    formTitleEl.textContent = '已结束旧规则并新建一条';
    formBodyEl.innerHTML =
      '<div class="fbanner ok">已结束「' + esc(oldRule ? oldRule.title : res.old_rule_id) + '」（至 ' + esc(res.old_repeat_until) + '），' +
      '并新建「' + esc(newRule ? newRule.title : (res.new_rule_id || '')) + '」（起始 ' +
      esc(newRule ? newRule.start_date : TODAY) + '）。</div>' +
      '<div class="panel-desc">旧规则下的任务与打卡记录一条没动。默认把任务复制到新规则：' +
      '复制出来的是新任务（新 id），历史打卡仍挂在旧规则下面。</div>' +
      '<label class="chk-inline"><input type="checkbox" id="fCopy" checked /> 复制 ' + oldTasks.length +
      ' 个任务到新规则</label>' +
      '<i class="hint">取消勾选也合法：新规则先留空，之后在配置页自己添加任务。</i>';
    formFootEl.innerHTML = '<button class="btn primary" id="fCopyDone" type="button">完成</button>';
  }

  function showFormErr(msg) {
    const el = formBodyEl.querySelector('#fErr');
    if (!el) return;
    el.hidden = false;
    el.textContent = msg;
  }

  function syncFromDom() {
    const d = FORM.draft;
    const get = function (sel) { return formBodyEl.querySelector(sel); };
    const title = get('#fTitle');
    if (title) d.title = title.value.trim();
    const start = get('#fStart');
    if (start && !FORM.ended) d.start_date = start.value;
    const end = get('#fEnd');
    if (end) d.end_date = end.value || '';
    const enabled = get('#fEnabled');
    if (enabled) d.enabled = enabled.checked;
    const every = get('#fEvery');
    if (every) d.repeat_every = parseInt(every.value, 10) || 0;
    const mday = get('#fMonthDay');
    if (mday && !mday.disabled) d.month_day = parseInt(mday.value, 10) || 0;
    const lastDay = get('#fLastDay');
    if (lastDay) d.month_day = lastDay.checked ? -1 : (parseInt((mday || {}).value, 10) || 1);
    const ym = get('#fYearMonth');
    if (ym) d.year_month = parseInt(ym.value, 10) || 0;
    const yd = get('#fYearDay');
    if (yd) d.year_day = parseInt(yd.value, 10) || 0;
    const rtime = get('#fRemindTime');
    if (rtime && rtime.value) FORM.reminder.time_of_day = rtime.value;
    const ntext = get('#fNotifyText');
    if (ntext) FORM.reminder.notify_text = ntext.value.trim();
    const snooze = get('#fSnooze');
    if (snooze) FORM.reminder.snooze_min = snooze.checked ? REMIND_SNOOZE : 0;
    FORM.tasks.forEach(function (t, i) {
      const input = formBodyEl.querySelector('.task-name[data-tidx="' + i + '"]');
      if (input) t.title = input.value.trim();
    });
  }

  function validateDraft() {
    const d = FORM.draft;
    if (!d.title) return '规则名称不能为空';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d.start_date)) return '开始日期必须是 YYYY-MM-DD';
    if (d.end_date && !/^\d{4}-\d{2}-\d{2}$/.test(d.end_date)) return '结束日期必须是 YYYY-MM-DD';
    if (d.end_date && d.end_date < d.start_date) return '结束日期不能早于开始日期';
    if (d.repeat_mode === 0 && !(d.weekdays_mask > 0)) return '每周重复至少要选一天';
    if (d.repeat_mode === 1 && !(d.repeat_every >= 1 && d.repeat_every <= 3660)) return '每 N 天的 N 必须在 1..3660';
    if (d.repeat_mode === 2 && !(d.month_day === -1 || (d.month_day >= 1 && d.month_day <= 31))) return '每月某日必须是 1..31 或最后一天';
    if (d.repeat_mode === 3 && !(d.year_month >= 1 && d.year_month <= 12)) return '每年重复的月份必须在 1..12';
    if (d.repeat_mode === 3 && !(d.year_day >= 1 && d.year_day <= 31)) return '每年重复的日必须在 1..31';
    if (FORM.mode === 'create' && !FORM.tasks.filter(function (t) { return t.title; }).length) return '至少要有一个任务';
    return '';
  }

  /* 提醒的落库（§11.1 / §11.4）：停在「不提醒」→ 软删该行（R3）；否则把两个开关与其余字段整份写回（R1 / R2）。
     写入层还会再拦一次「两个都关」（R4），所以前端就算算错也不会存出非法状态。
     规则本身已经存好了才调用：提醒写失败只提示，不回滚规则。 */
  async function persistRuleReminder(ruleId) {
    if (!ruleId) return;
    const r = FORM.reminder;
    try {
      if (!r.notify_on && !r.alarm_on) {
        await invoke('clear_reminder', { ownerKind: 0, ownerId: ruleId });
        return;
      }
      await invoke('save_reminder', {
        reminderJson: JSON.stringify({
          id: r.id || '',
          owner_kind: 0,
          owner_id: ruleId,
          notify_on: r.notify_on ? 1 : 0,
          alarm_on: r.alarm_on ? 1 : 0,
          time_of_day: r.time_of_day || REMIND_TIME,
          notify_text: r.notify_on ? (r.notify_text || '') : '',
          offset_days: r.offset_days || 0,
          repeat_rule: r.repeat_rule ? 1 : 0,
          snooze_min: r.alarm_on ? (r.snooze_min || 0) : 0,
          enabled: 1
        })
      });
    } catch (err) {
      STATE.hint = '保存提醒失败：' + errText(err);
    }
  }

  async function saveForm() {
    syncFromDom();
    const bad = validateDraft();
    if (bad) { showFormErr(bad); return; }
    const d = FORM.draft;

    if (FORM.mode === 'create') {
      const titles = FORM.tasks.map(function (t) { return t.title; }).filter(function (t) { return !!t; });
      let newId;
      try {
        newId = await invoke('create_rule', { ruleJson: JSON.stringify(normalizeDraft(d)), tasks: titles });
      } catch (err) { showFormErr('保存失败：' + errText(err)); return; }
      await persistRuleReminder(newId);
      closeForm();
      await afterRuleMutation();
      return;
    }

    const willSplit = !!FORM.orig && splitFieldDiffers(FORM.orig, d);
    if (willSplit) {
      const ok = await askConfirm('修改重复设置', SPLIT_CONFIRM_TEXT);
      if (!ok) return;
    }
    const body = Object.assign(normalizeDraft(d), { id: FORM.ruleId });
    if (willSplit) body.new_id = genClientId('r');
    let res;
    try {
      res = await invoke('update_rule', { ruleJson: JSON.stringify(body), today: TODAY });
    } catch (err) { showFormErr('保存失败：' + errText(err)); return; }

    if (res && res.split) {
      // 裂开：旧规则的任务 / 打卡一条不动，表单里的任务改动不套到旧规则上。
      // 提醒跟着「往后用的那条」（新规则）走，旧规则上原有的提醒作为历史留在原处，不搬也不删。
      const shadow = Object.assign({}, d, { title: d.title });
      await persistRuleReminder(res.new_rule_id || FORM.ruleId);
      await afterRuleMutation();
      FORM.draft = shadow;
      FORM.splitResult = res;
      renderForm();
      return;
    }
    await applyFormTasks();
    await persistRuleReminder(FORM.ruleId);
    closeForm();
    await afterRuleMutation();
  }

  /* 原地改的任务差异：改名 / 启停 / 删除 / 新增，逐条走对应的写命令 */
  async function applyFormTasks() {
    const rule = findRule(FORM.ruleId);
    const before = rule ? (rule.tasks || []) : [];
    const kept = new Set();
    for (const t of FORM.tasks) {
      if (!t.title) continue;
      if (t.id) {
        kept.add(t.id);
        const old = before.find(function (x) { return x.id === t.id; });
        if (!old) continue;
        if (old.title !== t.title) await invoke('rename_task', { taskId: t.id, title: t.title });
        if (old.enabled !== t.enabled) await invoke('set_task_enabled', { taskId: t.id, enabled: t.enabled });
      } else {
        await invoke('add_task', { ruleId: FORM.ruleId, title: t.title });
      }
    }
    for (const old of before) {
      if (!kept.has(old.id)) await invoke('delete_task', { taskId: old.id });
    }
  }

  /* 裂开后勾了「复制任务到新规则」才搬：逐条 add_task，旧任务与旧打卡一律不动 */
  async function finishSplitWithCopy() {
    const res = FORM.splitResult;
    const copy = formBodyEl.querySelector('#fCopy');
    if (res && res.new_rule_id && copy && copy.checked) {
      const oldRule = findRule(res.old_rule_id);
      const titles = ((oldRule && oldRule.tasks) || []).map(function (t) { return t.title; });
      try {
        for (const title of titles) {
          await invoke('add_task', { ruleId: res.new_rule_id, title: title });
        }
      } catch (err) {
        STATE.hint = '复制任务失败：' + errText(err);
      }
    }
    closeForm();
    await afterRuleMutation();
  }

  /* 表单的按钮有一半在 #formFoot 里（保存 / 取消 / 完成），所以两个容器都挂同一个处理器 */
  function onFormClick(e) {
    const mode = e.target.closest('#fMode [data-mode]');
    if (mode && !mode.disabled) {
      syncFromDom();
      FORM.draft.repeat_mode = parseInt(mode.dataset.mode, 10);
      renderForm();
      return;
    }
    const day = e.target.closest('#fDays [data-day]');
    if (day && !day.disabled) {
      const bit = 1 << parseInt(day.dataset.day, 10);
      FORM.draft.weekdays_mask = FORM.draft.weekdays_mask ^ bit;
      day.classList.toggle('on', (FORM.draft.weekdays_mask & bit) !== 0);
      return;
    }
    const preset = e.target.closest('#fEveryChips [data-every]');
    if (preset && !preset.disabled) {
      const n = parseInt(preset.dataset.every, 10);
      FORM.draft.repeat_every = n;
      const input = formBodyEl.querySelector('#fEvery');
      if (input) input.value = String(n);
      formBodyEl.querySelectorAll('#fEveryChips [data-every]').forEach(function (b) {
        b.classList.toggle('on', parseInt(b.dataset.every, 10) === n);
      });
      return;
    }
    const rb = e.target.closest('#fRemind [data-remind]');
    if (rb) {
      syncFromDom();
      const r = FORM.reminder;
      const v = rb.dataset.remind;
      r.touched = true;
      if (v === 'none') {
        // 互斥重置项：一次关掉两个通道，并清掉通道专属字段，不留残值
        r.notify_on = 0;
        r.alarm_on = 0;
        r.notify_text = '';
        r.snooze_min = 0;
      } else if (v === 'notify') {
        r.notify_on = r.notify_on ? 0 : 1;
      } else {
        r.alarm_on = r.alarm_on ? 0 : 1;
        if (r.alarm_on && !r.snooze_min) r.snooze_min = REMIND_SNOOZE;
      }
      // 两个都关时「不提醒」自动点亮 —— 所以任何点击序列都不会出现三项全灭（§11.1）
      renderForm();
      return;
    }
    if (e.target.closest('#fAddTask')) {
      syncFromDom();
      const input = formBodyEl.querySelector('#fNewTask');
      const title = input ? input.value.trim() : '';
      if (!title) { if (input) input.focus(); return; }
      FORM.tasks.push({ id: null, title: title, enabled: true });
      renderForm();
      return;
    }
    const delTask = e.target.closest('[data-act="form-del-task"]');
    if (delTask) {
      syncFromDom();
      FORM.tasks.splice(parseInt(delTask.dataset.tidx, 10), 1);
      renderForm();
      return;
    }
    if (e.target.closest('#fCancel') || e.target.closest('#fCloseX')) { closeForm(); return; }
    if (e.target.closest('#fSave')) { saveForm(); return; }
    if (e.target.closest('#fCopyDone')) { finishSplitWithCopy(); return; }
  }

  formBodyEl.addEventListener('click', onFormClick);
  formFootEl.addEventListener('click', onFormClick);

  formBodyEl.addEventListener('change', function (e) {
    if (e.target.id === 'fLastDay') {
      syncFromDom();
      renderForm();
    }
  });
  formBodyEl.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter') return;
    if (!e.target.matches('#fNewTask')) return;
    e.preventDefault();
    const add = formBodyEl.querySelector('#fAddTask');
    if (add) add.click();
  });

  formMaskEl.addEventListener('click', function (e) { if (e.target === formMaskEl) closeForm(); });
  document.getElementById('formClose').addEventListener('click', closeForm);

  function fmtTime(ms) {
    if (!ms) return '从未同步';
    const d = new Date(ms);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' +
      pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
  }

  function syncPanelHtml() {
    const st = STATE.sync || {};
    const ok = !st.last_error;
    const hint = STATE.hint ? '<div class="panel-desc">' + esc(STATE.hint) + '</div>' : '';
    return '<div class="panel-title">同步</div>' +
      '<div class="panel-desc">局域网直连：先写本地再找机会推送（契约 §7）。启动时与每 5 分钟自动尝试一次，失败静默。</div>' +
      hint +
      '<div class="card">' +
        '<div class="row col">' +
          '<div class="k"><b>服务地址</b><i>例如 http://192.168.1.20:8420（只支持 http，后端跑在局域网里）</i></div>' +
          '<input class="inp" id="syncUrl" value="' + esc(st.url || '') + '" placeholder="http://127.0.0.1:8420" />' +
        '</div>' +
        '<div class="row">' +
          '<div class="k"><b>上次同步</b><i>最近一次 push + pull 全部成功的时间</i></div>' +
          '<div class="v"><span class="stat-line"><i class="' + (ok ? 'dot-ok' : 'dot-off') + '"></i>' +
            esc(fmtTime(st.last_sync_at)) + '</span></div>' +
        '</div>' +
        '<div class="row">' +
          '<div class="k"><b>待推送</b><i>本地 dirty=1 的记录数，push 成功后清零</i></div>' +
          '<div class="v"><span class="stat-line">' + (st.dirty || 0) + ' 条</span></div>' +
        '</div>' +
        '<div class="row">' +
          '<div class="k"><b>pull 游标</b><i>lastPulledRev，下次 pull 的 since</i></div>' +
          '<div class="v"><span class="stat-line">' + (st.last_pulled_rev || 0) + '</span></div>' +
        '</div>' +
        '<div class="row">' +
          '<div class="k"><b>最近一次错误</b><i>失败不回滚本地数据，只保留 dirty 下次重试</i></div>' +
          '<div class="v"><span class="stat-line' + (ok ? '' : ' err') + '" title="' + esc(st.last_error || '无') + '">' +
            esc(st.last_error || '无') + '</span></div>' +
        '</div>' +
        '<div class="row">' +
          '<div class="k"><b>手动同步</b><i>先 push dirty，再 pull since=游标，按 updated_at 仲裁</i></div>' +
          '<div class="v">' +
            '<button class="btn" id="syncSave" type="button">保存地址</button>' +
            '<button class="btn primary" id="syncRun" type="button">立即同步</button>' +
          '</div>' +
        '</div>' +
        '<div class="conflict">冲突仲裁：同一周期在两端各打卡一次时，按 updated_at 大者赢（相等比 rev）。' +
          '所以「取消打卡」也能同步过去，不会被另一端用旧状态顶回来。</div>' +
      '</div>';
  }

  function aboutPanelHtml() {
    const p = parseKey(TODAY);
    return '<div class="panel-title">关于</div>' +
      '<div class="panel-desc">Took 是一个「按周期打卡」的日历：一个任务在一个周期内只记一次完成状态。</div>' +
      '<div class="card">' +
        '<div class="about-line"><b>版本</b><span>Took 0.1.0（PC 端 · Tauri 2）</span></div>' +
        '<div class="about-line"><b>本机数据</b><span>SQLite（应用数据目录 took.db），离线可用；删库即回到初始种子</span></div>' +
        '<div class="about-line"><b>同步协议</b><span>POST /api/sync/push + GET /api/sync/pull?since=，updated_at 大者赢</span></div>' +
        '<div class="about-line"><b>交互约定</b><span>格子里任务名是纯预览；点日期开面板，在面板里点任务打卡，整个周期同步</span></div>' +
        '<div class="about-line"><b>数据源</b><span>' +
          (SOURCE === 'tauri' ? 'Tauri 本地库' : '内置种子（浏览器兜底）') + '</span></div>' +
        '<div class="about-line"><b>今天</b><span>' + p.y + '/' + pad2(p.m) + '/' + pad2(p.d) +
          ' · 周' + WEEK_CN[weekdayIndex(TODAY)] + '（本机日期）</span></div>' +
      '</div>';
  }

  /* ---------- 8.3 统计分析（开发中）----------
     不做「点了没反应的假按钮」：能算的数字全部从本地库现算（规则 / 任务 / 打卡行），
     还没实现的（区间筛选 / 图表 / 导出）写在「开发中」清单里，不放假按钮。 */
  function renderAnalysis() {
    if (!analysisMainEl) return;
    const all = STATE.rulesAll || [];
    const live = all.filter(function (r) { return r.enabled && !r.ended; });
    const tasks = all.reduce(function (n, r) {
      return n + (r.tasks || []).filter(function (t) { return t.enabled; }).length;
    }, 0);
    const liveTasks = live.reduce(function (n, r) {
      return n + (r.tasks || []).filter(function (t) { return t.enabled; }).length;
    }, 0);

    // 完成率口径：已加载进缓存的那些天（就是滚动区覆盖的区间），如实写在说明里
    let hitCells = 0, doneCells = 0, taskRows = 0, doneRows = 0;
    STATE.cache.forEach(function (list) {
      if (!list.length) return;
      hitCells += 1;
      let allDone = true;
      list.forEach(function (t) {
        taskRows += 1;
        if (t.done) doneRows += 1; else allDone = false;
      });
      if (allDone) doneCells += 1;
    });
    const pct = taskRows ? Math.round(doneRows / taskRows * 100) : 0;
    const dayPct = hitCells ? Math.round(doneCells / hitCells * 100) : 0;

    analysisMainEl.innerHTML =
      '<div class="panel-title">统计分析</div>' +
      '<div class="panel-desc">本轮先接入口：下面的数字全部来自本地库现算，不是写死的样例。' +
        '区间筛选、图表与导出在后续任务里补。</div>' +
      '<div class="card">' +
        '<div class="row"><div class="k"><b>规则 / 任务</b>' +
          '<i>进行中 ' + live.length + ' 条规则 · ' + liveTasks + ' 个任务（含历史共 ' +
          all.length + ' 条 / ' + tasks + ' 个任务）</i></div>' +
          '<div class="v"><span class="stat-line"><i class="dot-ok"></i>' + liveTasks + ' 个在跑</span></div></div>' +
        '<div class="row"><div class="k"><b>任务行完成率</b>' +
          '<i>口径：已加载的 ' + hitCells + ' 天里，' + doneRows + ' / ' + taskRows + ' 条任务行已完成</i></div>' +
          '<div class="v"><span class="stat-line">' + pct + '%</span></div></div>' +
        '<div class="row"><div class="k"><b>全清天数</b>' +
          '<i>当天所有任务都打卡完成的天数占比</i></div>' +
          '<div class="v"><span class="stat-line">' + doneCells + ' 天 · ' + dayPct + '%</span></div></div>' +
      '</div>' +
      '<div class="card">' +
        '<div class="row col"><div class="k"><b>开发中</b>' +
          '<i>以下尚未实现，本轮不放按钮占位：区间筛选（近 7 天 / 本月 / 自定义）· ' +
          '按规则与任务的下钻明细 · 折线 / 柱状图 · 导出 CSV 与分享图</i></div></div>' +
      '</div>';
  }

  /* ---------- 8.3b 窗口外观控制器 ----------
     三件事都落在**真窗口**上（后端 set_opacity / collapse_window / set_snap_edge），
     前端只负责发命令与把真实状态读回来显示。没有本地猜的状态。 */
  const CHROME = {
    opacity: 100,
    snap_edge: 'none',
    snap_auto_hide: false,
    collapsed: false,
    rect: [],
    snap_threshold: 20,
    alpha: -1,
  };
  const snapHandleEl = document.getElementById('snapHandle');
  const EDGE_CN = { none: '不吸附', left: '左', right: '右', top: '上', bottom: '下' };

  function applyChromeState(st) {
    if (!st) return;
    Object.keys(CHROME).forEach(function (k) { if (k in st) CHROME[k] = st[k]; });
    // 透明度：真窗口已经改过，这里同步页面底色标记（半透明时让 body 透出桌面）
    document.body.dataset.transparent = CHROME.opacity < 100 ? 'on' : 'off';
    // 小三角贴哪条边：照原型，未吸附时落右边
    const edge = CHROME.snap_edge === 'none' ? 'right' : CHROME.snap_edge;
    if (snapHandleEl) snapHandleEl.dataset.edge = edge;
    setCollapsedView(!!CHROME.collapsed);
  }

  /** 收起态只管「页面显示什么」：窗口尺寸已经由后端改了，这里不能再改窗口。 */
  function setCollapsedView(collapsed) {
    CHROME.collapsed = !!collapsed;
    document.body.dataset.collapsed = collapsed ? 'on' : 'off';
    if (snapHandleEl) snapHandleEl.hidden = !collapsed;
    if (collapsed && snapHandleEl) snapHandleEl.focus({ preventScroll: true });
  }

  async function refreshChrome() {
    try {
      applyChromeState(await invoke('window_chrome_status', {}));
    } catch (err) {
      // 浏览器兜底：没有 Win32，如实标成不支持，不伪造成功
      CHROME.error = err && err.message ? err.message : String(err);
      document.body.dataset.transparent = 'off';
    }
    return CHROME;
  }

  /* ---------- 8.3c 固定方式：贴壁纸 / 置顶 / 普通（三选一，互斥） ----------
     日历头部 #btnPin 上显示当前方式的两个字，点它就地弹出三项菜单直接切，
     不用进设置页（用户原话：「在设置旁边添加一个固定按钮，不要进入设置才能固定这样麻烦了」）。

     三种方式互斥这件事由**后端**保证（lib.rs 的 apply_pin_style 先撤后立），
     前端只做两件事：把按钮文字刷成后端读回来的真值、把菜单项打上勾。
     不在前端自己拼状态 —— 否则「按钮显示贴壁纸、设置页显示已关闭」这种不一致又会回来。 */
  const PIN = {
    mode: 'normal',   // wallpaper | top | normal
    label: '普通',
    always_on_top: false,  // 真窗口 WS_EX_TOPMOST 的读回值（后端给的，不是猜的）
  };
  const PIN_ITEMS = [
    { mode: 'wallpaper', name: '贴桌面壁纸' },
    { mode: 'top', name: '置顶窗口' },
    { mode: 'normal', name: '普通窗口' },
  ];
  const btnPinEl = document.getElementById('btnPin');
  const btnPinLblEl = document.getElementById('btnPinLbl');
  const pinMenuEl = document.getElementById('pinMenu');

  /** 把固定方式刷到按钮与菜单上。文字与勾选都取自后端，前端不自己推。 */
  function paintPin(pin) {
    if (!pin) return;
    PIN.mode = pin.mode || 'normal';
    PIN.label = pin.label || '普通';
    PIN.always_on_top = !!pin.always_on_top;
    if (btnPinLblEl) btnPinLblEl.textContent = PIN.label;
    if (btnPinEl) {
      btnPinEl.dataset.pin = PIN.mode;
      btnPinEl.title = '固定方式：' + PIN.label + ' · 点一下直接切（贴桌面壁纸 / 置顶窗口 / 普通窗口）';
    }
    if (pinMenuEl) {
      [].forEach.call(pinMenuEl.querySelectorAll('button[data-pin]'), function (b) {
        b.setAttribute('aria-checked', b.dataset.pin === PIN.mode ? 'true' : 'false');
      });
    }
    // 设置页开着「桌面固定」时，开关与「实际模式」也要跟着变（反之亦然）
    if (STATE.screen === 'settings' && STATE.settingsTab === 'desktop') renderSettings();
  }

  /** 读后端真值（按钮文字 / WS_EX_TOPMOST / 贴壁纸层实况）。 */
  async function refreshPin() {
    try {
      paintPin(await invoke('pin_mode_status', {}));
    } catch (err) {
      // 浏览器兜底：没有 Win32，三种方式都做不到 —— 如实停在「普通」，不伪造成功
      paintPin({ mode: 'normal', label: '普通', always_on_top: false });
      PIN.error = err && err.message ? err.message : String(err);
    }
    return PIN;
  }

  /** 切换固定方式。菜单项选中后立即生效，按钮文字随后端读回值更新。 */
  async function setPinMode(mode) {
    closePinMenu();
    if (btnPinEl) btnPinEl.disabled = true;
    try {
      const pin = await invoke('set_pin_mode', { mode: mode });
      paintPin(pin);
      STATE.hint = '固定方式已切到「' + (pin.label || '') + '」';
      if (STATE.wallpaper && pin.wallpaper) STATE.wallpaper = pin.wallpaper;
      setTimeout(function () { STATE.hint = ''; renderScreen(); }, 2600);
    } catch (err) {
      STATE.hint = '切换固定方式失败：' + (err && err.message ? err.message : String(err));
      renderScreen();
    } finally {
      if (btnPinEl) btnPinEl.disabled = false;
    }
  }

  /** 菜单锚在按钮下方就地弹出（position:fixed，坐标按按钮真实矩形算；不是模态框）。 */
  function openPinMenu() {
    if (!pinMenuEl || !btnPinEl) return;
    pinMenuEl.hidden = false;
    btnPinEl.setAttribute('aria-expanded', 'true');
    const r = btnPinEl.getBoundingClientRect();
    const mw = pinMenuEl.offsetWidth || 190;
    // 贴右边时向左收，别让菜单跑出窗口
    const left = Math.max(6, Math.min(r.left, (window.innerWidth || 0) - mw - 6));
    pinMenuEl.style.left = Math.round(left) + 'px';
    pinMenuEl.style.top = Math.round(r.bottom + 6) + 'px';
  }

  function closePinMenu() {
    if (!pinMenuEl || pinMenuEl.hidden) return;
    pinMenuEl.hidden = true;
    if (btnPinEl) btnPinEl.setAttribute('aria-expanded', 'false');
  }

  function togglePinMenu() {
    if (!pinMenuEl) return;
    if (pinMenuEl.hidden) openPinMenu(); else closePinMenu();
  }

  /** 后端吸附后自动收起时会 eval 这个钩子（见 lib.rs 的 wire_snap_listener）。
      ★2026-10-27 修 bug：这里原来只有 `setCollapsedView(true)` —— 它只切页面标记，
      **不动真窗口**，于是「自动收起」从来没把窗口缩成小三角，而 lib.rs 那边却已经
      打了「自动收起成小三角」的日志（用户截图里刷屏的就是那行）。
      现在它真的调 collapseWindow()：窗口没缩时由前端补一刀，已缩时后端幂等返回。 */
  window.__tookAutoCollapse = function () {
    setCollapsedView(true);
    collapseWindow();
  };

  /* 收起 / 展开：真窗口的过渡动画在后端分帧跑（约 200ms ease-out），
     前端只发命令 + 把真实状态读回来。过渡期间重复点击直接忽略，避免两段动画打架。 */
  let chromeBusy = false;
  async function collapseWindow() {
    if (chromeBusy) return;
    chromeBusy = true;
    try {
      applyChromeState(await invoke('collapse_window', {}));
      setCollapsedView(true);
    } catch (err) {
      STATE.hint = '收起失败：' + (err && err.message ? err.message : String(err));
      renderSettings();
    } finally {
      setTimeout(function () { chromeBusy = false; }, 260);
    }
  }

  async function expandWindow() {
    if (chromeBusy) return;
    chromeBusy = true;
    try {
      applyChromeState(await invoke('expand_window', {}));
      setCollapsedView(false);
    } catch (err) {
      setCollapsedView(false);
    } finally {
      setTimeout(function () { chromeBusy = false; }, 260);
    }
  }

  function syncOpacitySlider() {
    const range = document.getElementById('winOpacity');
    if (range) range.style.setProperty('--p', range.value + '%');
    const val = document.getElementById('winOpacityVal');
    if (val && range) val.textContent = range.value + '%';
  }

  /** 把「窗口实际不透明度」那一行刷成真读回来的值。
      面板 HTML 渲染时用的可能是上一次读到的 CHROME.alpha，会显示成过期的 255/255。 */
  function paintAlphaLine() {
    const el = document.getElementById('winAlphaVal');
    if (el) el.textContent = CHROME.alpha >= 0 ? CHROME.alpha + ' / 255' : '未读取';
  }

  /* 常规 / 外观 / 数据 三个页签：常规与数据本轮如实标「开发中」，
     外观页放真正生效的透明度滑块。 */
  function generalPanelHtml() {
    return '<div class="panel-title">常规</div>' +
      '<div class="panel-desc">启动、关闭与语言。本轮只接通了窗口外观相关的开关，其余如实标注。</div>' +
      '<div class="card">' +
        '<div class="row"><div class="k"><b>关闭按钮</b><i>点关闭时隐藏到托盘，进程与提醒调度继续运行（已生效）</i></div>' +
          '<div class="v"><span class="stat-line">隐藏到托盘</span></div></div>' +
        '<div class="row"><div class="k"><b>托盘常驻</b><i>托盘菜单可打开主窗口 / 立刻对表 / 切换贴壁纸 / 真正退出</i></div>' +
          '<div class="v"><span class="stat-line">已启用</span></div></div>' +
      '</div>' +
      '<div class="card">' +
        '<div class="todo-block"><b>开发中</b>' +
          '<ul><li>开机自启（launchOnStart / autoStart）</li>' +
          '<li>每周起始日（weekStart）</li>' +
          '<li>界面语言（lang）</li></ul>' +
          '以上尚未实现，本轮不放按钮占位。</div>' +
      '</div>';
  }

  function appearancePanelHtml() {
    const v = Number(CHROME.opacity) || 100;
    return '<div class="panel-title">外观</div>' +
      '<div class="panel-desc">整体透明度作用在**窗口本身**（Win32 分层窗口），不是页面的 CSS opacity：' +
        '拖到 40% 时整个窗口连同边框一起变淡，桌面 / 壁纸透上来。</div>' +
      (STATE.hint ? '<div class="panel-desc">' + esc(STATE.hint) + '</div>' : '') +
      '<div class="card">' +
        '<div class="row col">' +
          '<div class="k"><b>整体透明度</b><i>40~100%，拖动即时生效；' +
            '卡片保持实色底，透明度降低时文字对比度不会跟着掉</i></div>' +
          '<div class="opacity-row">' +
            '<input class="opacity-range" id="winOpacity" type="range" min="40" max="100" step="5" value="' + v + '" ' +
              'aria-label="整体透明度" />' +
            '<span class="opacity-val" id="winOpacityVal">' + v + '%</span>' +
          '</div>' +
        '</div>' +
        '<div class="row"><div class="k"><b>窗口实际不透明度</b><i>GetLayeredWindowAttributes 真读回来的值，不是页面上的数字</i></div>' +
          '<div class="v"><span class="stat-line" id="winAlphaVal">' +
            (CHROME.alpha >= 0 ? CHROME.alpha + ' / 255' : '未读取') + '</span></div></div>' +
      '</div>' +
      '<div class="card">' +
        '<div class="todo-block"><b>开发中</b>' +
          '<ul><li>主题（浅色 / 深色）</li>' +
          '<li>字号（小 / 标准 / 大）</li>' +
          '<li>内容密度（跟随窗口 / 紧凑 / 标准 / 宽松）</li></ul>' +
          '以上尚未实现，本轮不放按钮占位。</div>' +
      '</div>';
  }

  function dataPanelHtml() {
    return '<div class="panel-title">数据</div>' +
      '<div class="panel-desc">本地库与备份。本轮只展示真实路径，导出 / 导入尚未实现。</div>' +
      '<div class="card">' +
        '<div class="row"><div class="k"><b>本地库</b><i>SQLite，位于应用数据目录</i></div>' +
          '<div class="v"><span class="stat-line">took.db</span></div></div>' +
      '</div>' +
      '<div class="card">' +
        '<div class="todo-block"><b>开发中</b>' +
          '<ul><li>导出备份（CSV / JSON）</li>' +
          '<li>从备份导入</li>' +
          '<li>清空本地数据</li></ul>' +
          '以上尚未实现，本轮不放按钮占位。</div>' +
      '</div>';
  }

  function renderSettings() {
    if (STATE.settingsTab === 'about') setMainEl.innerHTML = aboutPanelHtml();
    else if (STATE.settingsTab === 'reminder') setMainEl.innerHTML = reminderPanelHtml();
    else if (STATE.settingsTab === 'desktop') setMainEl.innerHTML = desktopPanelHtml();
    else if (STATE.settingsTab === 'general') setMainEl.innerHTML = generalPanelHtml();
    else if (STATE.settingsTab === 'appearance') setMainEl.innerHTML = appearancePanelHtml();
    else if (STATE.settingsTab === 'data') setMainEl.innerHTML = dataPanelHtml();
    else setMainEl.innerHTML = syncPanelHtml();
    // 面板重绘后把滑块进度条填色补上（--p 是内联变量，innerHTML 重建会丢）
    syncOpacitySlider();
    paintAlphaLine();
    // 外观页每次进入都去读一次真窗口的 alpha，别让面板停在过期读数上
    if (STATE.settingsTab === 'appearance') {
      invoke('window_chrome_status', {}).then(function (st) {
        if (st) { CHROME.alpha = st.alpha; CHROME.opacity = st.opacity; paintAlphaLine(); }
      }).catch(function () {});
    }
  }

  /* ---------- 8.4 提醒调度面板（定稿 §6.3.4） ----------
     这里显示的全部是**后端调度器的真实状态**（reminder_status / reminder_upcoming），
     不是前端凭「应该能响」猜出来的。关键一条：「后台线程」这一行在窗口关掉后仍然是「在跑」，
     因为线程属于进程而不属于窗口 —— 这是 PC 端与浏览器/WebView 定时的本质差异。 */
  function fmtAgo(ms) {
    if (!ms) return '还没有';
    const diff = Math.floor((Date.now() - ms) / 1000);
    if (diff < 60) return diff + ' 秒前';
    if (diff < 3600) return Math.floor(diff / 60) + ' 分钟前';
    return Math.floor(diff / 3600) + ' 小时前';
  }

  function reminderPanelHtml() {
    const st = STATE.reminder || {};
    const up = STATE.upcoming || [];
    const ok = !st.last_error;
    const alive = !!st.thread_alive;
    const upcoming = up.length
      ? up.map(function (u) {
          return '<div class="row"><div class="k"><b>' + esc(u.title) + '</b>' +
            '<i>命中日 ' + esc(u.occur_date) + ' · 触发日 ' + esc(u.fire_date) + '</i></div>' +
            '<div class="v"><span class="stat-line">' + esc(u.text) + '</span></div></div>';
        }).join('')
      : '<div class="row col"><div class="k"><b>没有已排程的提醒</b>' +
        '<i>在「配置 → 规则与任务」里给某条规则打开「通知」或「闹钟」，它会立刻出现在这里</i></div></div>';

    return '<div class="panel-title">提醒</div>' +
      '<div class="panel-desc">调度是一个独立后台线程，每 ' + (st.tick_secs || 30) +
        ' 秒对表一次。它不依赖这个窗口：窗口关掉、最小化、WebView 被回收，它都继续跑，只有进程退出才停。' +
        '所以「通知」在窗口关掉后照样能弹。</div>' +
      (STATE.hint ? '<div class="panel-desc">' + esc(STATE.hint) + '</div>' : '') +
      '<div class="card">' +
        '<div class="row">' +
          '<div class="k"><b>后台调度线程</b><i>进程活着它就在；与窗口开关无关</i></div>' +
          '<div class="v"><span class="stat-line"><i class="' + (alive ? 'dot-ok' : 'dot-off') + '"></i>' +
            (alive ? '在跑（每 ' + (st.tick_secs || 30) + ' 秒对表）' : '未启动') + '</span></div>' +
        '</div>' +
        '<div class="row">' +
          '<div class="k"><b>已排程</b><i>算出了下一次触发点的提醒条数</i></div>' +
          '<div class="v"><span class="stat-line">' + (st.scheduled || 0) + ' 条</span></div>' +
        '</div>' +
        '<div class="row">' +
          '<div class="k"><b>下一次触发</b><i>' +
            (st.next_fire_title ? esc(st.next_fire_title) : '没有') + '</i></div>' +
          '<div class="v"><span class="stat-line">' +
            (st.next_fire_text ? esc(st.next_fire_text) : '—') + '</span></div>' +
        '</div>' +
        '<div class="row">' +
          '<div class="k"><b>最近一次触发</b><i>本次进程内累计 ' + (st.fired_count || 0) + ' 次</i></div>' +
          '<div class="v"><span class="stat-line">' +
            (st.last_fired_text ? esc(st.last_fired_title) + ' · ' + esc(st.last_fired_text) : fmtAgo(st.last_fired_at)) +
            '</span></div>' +
        '</div>' +
        '<div class="row">' +
          '<div class="k"><b>正在响铃</b><i>闹钟模式会循环响铃，最长 5 分钟后自动停</i></div>' +
          '<div class="v"><span class="stat-line">' +
            (st.sound_playing ? '响铃中' : (st.ringing > 0 ? (st.ringing + ' 个闹钟窗') : '无')) + '</span></div>' +
        '</div>' +
        '<div class="row">' +
          '<div class="k"><b>通知通道</b><i>tauri-plugin-notification，走 Windows 通知中心</i></div>' +
          '<div class="v"><span class="stat-line' + (st.notify_ok ? '' : ' err') + '">' +
            (st.notify_ok ? '可用' : '递交失败') + '</span></div>' +
        '</div>' +
        '<div class="row">' +
          '<div class="k"><b>最近一次错误</b><i>调度线程里的失败一律记在这里，不静默吞掉</i></div>' +
          '<div class="v"><span class="stat-line' + (ok ? '' : ' err') + '" title="' + esc(st.last_error || '无') + '">' +
            esc(st.last_error || '无') + '</span></div>' +
        '</div>' +
        '<div class="row">' +
          '<div class="k"><b>立刻对表</b><i>保存提醒后本来就会自动对表；这里是手动触发一次</i></div>' +
          '<div class="v"><button class="btn" id="remindPoke" type="button">重新排一次</button></div>' +
        '</div>' +
        '<div class="conflict">接下来要响的：</div>' +
        upcoming +
      '</div>';
  }

  /* ---------- 8.5 桌面面板：贴壁纸层（定稿 §5.5「固定桌面」） ----------
     这里显示的每一条都来自后端 wallpaper_status：实际落地的是哪种模式（WorkerW /
     ProgmanTopChild / FallbackAlwaysOnTop / Disabled）、宿主窗口类名、真实父窗口句柄。
     降级必须**说出来**，不能让用户以为贴上了。 */
  async function refreshWallpaperStatus() {
    try {
      STATE.wallpaper = await invoke('wallpaper_status', {});
    } catch (err) {
      STATE.wallpaper = {
        enabled: false, mode: 'Disabled',
        detail: '读不到贴壁纸状态：' + (err && err.message ? err.message : String(err)),
        host: 0, host_class: '', parent: 0, is_child: false,
      };
    }
    return STATE.wallpaper;
  }

  function hexHwnd(v) {
    const n = Number(v) || 0;
    return n ? '0x' + n.toString(16).toUpperCase() : '无';
  }

  function desktopPanelHtml() {
    const w = STATE.wallpaper || {};
    const on = !!w.enabled;
    const attached = w.mode === 'WorkerW' || w.mode === 'ProgmanTopChild';
    // 固定方式三选一：与日历头部 #btnPin 同一个真源（后端的 pin_mode），
    // 两边互相同步 —— 这里改了按钮文字跟着变，按钮改了这里也重绘。
    const pinModes = [['wallpaper', '贴桌面壁纸'], ['top', '置顶窗口'], ['normal', '普通窗口']];
    return '<div class="panel-title">桌面固定</div>' +
      '<div class="panel-desc">贴壁纸层：按 Win+D 显示桌面之后，Took 仍然留在壁纸上。' +
        '窗口是 420×560 的小部件尺寸 —— 这是**有意选择**：铺满全屏会让桌面图标点不到，' +
        '保持这个尺寸则不遮挡图标区，同时窗口本身可以正常点日期打卡。</div>' +
      (STATE.hint ? '<div class="panel-desc">' + esc(STATE.hint) + '</div>' : '') +
      '<div class="card">' +
        '<div class="row">' +
          '<div class="k"><b>固定方式</b><i>三选一，互斥；与日历头部那个「固定方式」按钮是同一个设置' +
            '（当前：' + esc(PIN.label) + '）</i></div>' +
          '<div class="v"><div class="seg" data-pinmode>' +
            pinModes.map(function (m) {
              return '<button type="button" data-v="' + m[0] + '" class="' +
                (PIN.mode === m[0] ? 'on' : '') + '">' + m[1] + '</button>';
            }).join('') +
          '</div></div>' +
        '</div>' +
        '<div class="row">' +
          '<div class="k"><b>固定到桌面（贴壁纸）</b><i>关掉会把窗口父级还原回桌面并恢复普通窗口样式' +
            '（等价于把上面的固定方式切到「普通窗口」）</i></div>' +
          '<div class="v"><button class="btn' + (on ? ' primary' : '') + '" id="wallToggle" type="button">' +
            (on ? '已开启 · 点击关闭' : '已关闭 · 点击开启') + '</button></div>' +
        '</div>' +
        '<div class="row">' +
          '<div class="k"><b>置顶窗口（WS_EX_TOPMOST）</b><i>后端从真窗口读回来的值，不是前端猜的</i></div>' +
          '<div class="v"><span class="stat-line' + (PIN.always_on_top ? '' : ' err') + '">' +
            (PIN.always_on_top ? '已置顶' : '未置顶') + '</span></div>' +
        '</div>' +
        '<div class="row">' +
          '<div class="k"><b>实际模式</b><i>后端探测出来的真实形态，不是猜的</i></div>' +
          '<div class="v"><span class="stat-line' + (attached ? '' : ' err') + '">' + esc(w.mode || 'Disabled') + '</span></div>' +
        '</div>' +
        '<div class="row col">' +
          '<div class="k"><b>说明</b><i>' + esc(w.detail || '') + '</i></div>' +
        '</div>' +
        '<div class="row">' +
          '<div class="k"><b>小部件预设尺寸</b><i>420×560 竖条（定稿 §5.5 建议）。' +
            '这是显式操作：贴壁纸本身不改窗口大小，宽度直接决定格子密度</i></div>' +
          '<div class="v"><button class="btn" id="wallPreset" type="button">切到 420×560</button></div>' +
        '</div>' +
        '<div class="row">' +
          '<div class="k"><b>宿主窗口</b><i>窗口被 SetParent 进去的那个父窗口</i></div>' +
          '<div class="v"><span class="stat-line">' + esc(w.host_class || '无') + ' · ' + hexHwnd(w.host) + '</span></div>' +
        '</div>' +
        '<div class="row">' +
          '<div class="k"><b>当前父窗口</b><i>GetParent 真读回来的值；WS_CHILD ' +
            (w.is_child ? '已置上' : '未置上') + '</i></div>' +
          '<div class="v"><span class="stat-line">' + hexHwnd(w.parent) + '</span></div>' +
        '</div>' +
        '<div class="conflict">已知边界：多显示器时只挂主显示屏的桌面层（每个显示器有各自的 WorkerW，' +
          '本版不按显示器匹配）；Explorer 重启后监视线程每 2 秒检查一次，宿主失效会自动重附着；' +
          'Wallpaper Engine 一类动态壁纸软件也抢 WorkerW，可能两者冲突。</div>' +
      '</div>' +
      snapCardHtml();
  }

  /** 吸附边缘 + 收起成小三角（照 prototype/pc.html 的 pin 页签） */
  function snapCardHtml() {
    const edge = CHROME.snap_edge || 'none';
    const edges = [['none', '不吸附'], ['left', '左'], ['right', '右'], ['top', '上'], ['bottom', '下']];
    return '<div class="card">' +
      '<div class="row">' +
        '<div class="k"><b>吸附边缘</b><i>拖动窗口靠近这条边 ' + (CHROME.snap_threshold || 20) +
          'px 以内会自动吸过去；贴边后可点日历头部「收起」只留一个小三角</i></div>' +
        '<div class="v"><div class="seg" data-snapedge>' +
          edges.map(function (e) {
            return '<button type="button" data-v="' + e[0] + '" class="' + (e[0] === edge ? 'on' : '') + '">' + e[1] + '</button>';
          }).join('') +
        '</div></div>' +
      '</div>' +
      '<div class="row">' +
        /* 2026-10-27：文案写清楚两个前置条件。之前「吸附后没变成小三角」除了代码 bug，
           还有一半原因是这个开关默认关着、且「吸附边缘 = 不吸附」时它永远不会触发。 */
        '<div class="k"><b>吸附后自动收起</b><i>需先把上面的「吸附边缘」设成左/右/上/下' +
          '（设成「不吸附」时本开关不起作用）；开启后窗口吸到边缘停留 1.5 秒，' +
          '自动缩成 26×48 小三角；点小三角展开。当前：' +
          (CHROME.snap_auto_hide ? '已开启' : '已关闭') + '</i></div>' +
        '<div class="v"><button type="button" class="switch" role="switch" id="snapAutoHide" ' +
          'aria-checked="' + (CHROME.snap_auto_hide ? 'true' : 'false') + '" aria-label="吸附后自动收起"></button></div>' +
      '</div>' +
      '<div class="row">' +
        '<div class="k"><b>当前窗口位置</b><i>GetWindowRect 真读回来的物理像素 [x, y, 宽, 高]</i></div>' +
        '<div class="v"><span class="stat-line">' +
          (CHROME.rect && CHROME.rect.length === 4 ? CHROME.rect.join(' · ') : '未读取') + '</span></div>' +
      '</div>' +
      '<div class="row">' +
        '<div class="k"><b>收起成小三角</b><i>窗口缩成贴边的 26×48 小条，提醒调度与托盘不受影响</i></div>' +
        '<div class="v">' +
          (CHROME.collapsed
            ? '<button class="btn primary" id="winExpand" type="button">展开</button>'
            : '<button class="btn" id="winCollapse" type="button">收起</button>') +
        '</div>' +
      '</div>' +
    '</div>';
  }

  /* ---------- 9. 同步：启动 + 每 5 分钟 + 手动 ---------- */
  /* 同一时刻只允许一趟同步：正在跑时再点「立即同步」就搭上同一趟。
     之前用 syncing 布尔直接 return，会连带把按钮永久禁用（点了没反应），
     属于真实点不到 —— 这里改成复用同一 promise。 */
  let syncInflight = null;

  async function refreshSyncStatus() {
    try {
      STATE.sync = await invoke('sync_status', {});
    } catch (err) {
      STATE.sync = {
        url: STATE.sync && STATE.sync.url ? STATE.sync.url : '',
        last_sync_at: 0,
        dirty: 0,
        last_error: err && err.message ? err.message : String(err),
        last_pulled_rev: 0,
      };
    }
    return STATE.sync;
  }

  function runSync() {
    if (syncInflight) return syncInflight;
    syncInflight = doSync().finally(function () { syncInflight = null; });
    return syncInflight;
  }

  async function doSync() {
    try {
      const res = await invoke('sync_now', {});
      if (res && res.pulled > 0) {
        // 远端有新东西：丢掉缓存重新拉当前月（不弹窗、不打断）
        STATE.cache.clear();
        STATE.loaded.clear();
        await render();
      }
      await refreshSyncStatus();
      renderScreen();
      return res;
    } catch (err) {
      // 静默：网络失败不是错误，只是稍后再试（契约 §7.4）
      return null;
    }
  }

  async function saveSyncUrl() {
    const input = document.getElementById('syncUrl');
    if (!input) return;
    try {
      STATE.sync = await invoke('set_sync_url', { url: input.value });
      STATE.hint = '地址已保存：' + STATE.sync.url;
    } catch (err) {
      STATE.hint = '地址未保存：' + (err && err.message ? err.message : String(err));
    }
    renderSettings();
    setTimeout(function () { STATE.hint = ''; renderScreen(); }, 2600);
  }

  setMainEl.addEventListener('click', function (e) {
    const poke = e.target.closest('#remindPoke');
    if (poke) {
      poke.disabled = true;
      // 后台线程被唤醒后要跑完一轮才更新状态，等一小会儿再读，读到的才是刚算出来的排程
      invoke('poke_scheduler', {})
        .then(function () { return new Promise(function (r) { setTimeout(r, 700); }); })
        .then(refreshReminderStatus)
        .then(renderSettings, renderSettings);
      return;
    }
    if (e.target.closest('#wallPreset')) {
      invoke('set_wallpaper_preset', {}).then(function (st) {
        STATE.wallpaper = st;
        STATE.hint = '已切到 420×560 小部件尺寸';
        renderSettings();
        setTimeout(function () { STATE.hint = ''; renderScreen(); }, 3200);
      }, function (err) {
        STATE.hint = '切换尺寸失败：' + (err && err.message ? err.message : String(err));
        renderSettings();
      });
      return;
    }
    // 设置页里的「固定方式」三选一：与日历头部 #btnPin 走同一条命令，改完两边一起刷
    const pinBtn = e.target.closest('[data-pinmode] button');
    if (pinBtn) {
      const mode = pinBtn.dataset.v;
      pinBtn.disabled = true;
      invoke('set_pin_mode', { mode: mode })
        .then(function (pin) {
          paintPin(pin);
          if (pin.wallpaper) STATE.wallpaper = pin.wallpaper;
          STATE.hint = '固定方式已切到「' + (pin.label || '') + '」';
          renderSettings();
          setTimeout(function () { STATE.hint = ''; renderScreen(); }, 3200);
        })
        .catch(function (err) {
          STATE.hint = '切换失败：' + (err && err.message ? err.message : String(err));
          renderSettings();
        });
      return;
    }
    const wall = e.target.closest('#wallToggle');
    if (wall) {
      // 按钮状态取自后端，前端不自己猜；关掉失败也要把真实状态再读回来
      const now = !!(STATE.wallpaper && STATE.wallpaper.enabled);
      wall.disabled = true;
      invoke('set_wallpaper_pin', { on: !now })
        .then(function (st) {
          STATE.wallpaper = st;
          STATE.hint = st.detail;
          // 开关本身就是固定方式的两个取值（开 = 贴壁纸，关 = 普通窗口），
          // 这里必须把 #btnPin 的文字一起刷 —— 否则会出现「按钮说贴壁纸、设置页说已关闭」
          return refreshPin().then(function () {
            renderSettings();
            setTimeout(function () { STATE.hint = ''; renderScreen(); }, 3200);
          });
        })
        .catch(function (err) {
          STATE.hint = '切换失败：' + (err && err.message ? err.message : String(err));
          renderSettings();
        });
      return;
    }
    // 吸附边缘四选一
    const edgeBtn = e.target.closest('[data-snapedge] button');
    if (edgeBtn) {
      const edge = edgeBtn.dataset.v;
      invoke('set_snap_edge', { edge: edge }).then(function (st) {
        applyChromeState(st);
        STATE.hint = edge === 'none' ? '已关闭吸附' : '吸附到' + EDGE_CN[edge] + '边缘';
        renderSettings();
        setTimeout(function () { STATE.hint = ''; renderScreen(); }, 2600);
      }, function (err) {
        STATE.hint = '设置吸附失败：' + (err && err.message ? err.message : String(err));
        renderSettings();
      });
      return;
    }
    if (e.target.closest('#snapAutoHide')) {
      const on = !CHROME.snap_auto_hide;
      invoke('set_snap_auto_hide', { on: on }).then(function (st) {
        applyChromeState(st);
        STATE.hint = on
          ? (CHROME.snap_edge === 'none'
              ? '已开启自动收起，但「吸附边缘」还是「不吸附」——先选一条边才会触发'
              : '吸附后 1.5 秒自动收起')
          : '已关闭自动收起';
        renderSettings();
        setTimeout(function () { STATE.hint = ''; renderScreen(); }, 2600);
      }, function (err) {
        STATE.hint = '设置失败：' + (err && err.message ? err.message : String(err));
        renderSettings();
      });
      return;
    }
    if (e.target.closest('#winCollapse')) { collapseWindow(); return; }
    if (e.target.closest('#winExpand')) { expandWindow(); return; }
    if (e.target.closest('#syncSave')) { saveSyncUrl(); return; }
    const run = e.target.closest('#syncRun');
    if (run) {
      // 无论成功失败都重绘面板：按钮重新可用，状态行也刷成最新
      run.disabled = true;
      runSync().then(renderSettings, renderSettings);
    }
  });
  setNavEl.addEventListener('click', function (e) {
    const btn = e.target.closest('button[data-tab]');
    if (!btn) return;
    STATE.settingsTab = btn.dataset.tab;
    renderNav(setNavEl, SET_NAV, STATE.settingsTab);
    renderSettings();
    if (STATE.settingsTab === 'reminder') {
      refreshReminderStatus().then(function () { renderScreen(); }).catch(function () {});
    }
    if (STATE.settingsTab === 'desktop') {
      // 三个一起读：贴壁纸层实况、窗口外观、固定方式（按钮文字与 WS_EX_TOPMOST 真值）
      Promise.all([refreshWallpaperStatus(), refreshChrome(), refreshPin()])
        .then(function () { renderScreen(); }).catch(function () {});
    }
    if (STATE.settingsTab === 'appearance' || STATE.settingsTab === 'general') {
      refreshChrome().then(function () { renderScreen(); }).catch(function () {});
    }
  });

  /* 透明度滑块：input 事件实时调用后端（真窗口立即变），
     拖动过程中不重绘面板（重绘会把滑块从手指下抽走）。 */
  setMainEl.addEventListener('input', function (e) {
    const range = e.target.closest('#winOpacity');
    if (!range) return;
    const v = Number(range.value);
    const val = document.getElementById('winOpacityVal');
    if (val) val.textContent = v + '%';
    range.style.setProperty('--p', v + '%');
    document.body.dataset.transparent = v < 100 ? 'on' : 'off';
    invoke('set_opacity', { value: v }).then(function (real) {
      CHROME.opacity = real;
      document.body.dataset.transparent = real < 100 ? 'on' : 'off';
      // 把真窗口的 alpha 读回来刷新那一行（不是自己算的百分比）
      return invoke('window_opacity', {}).then(function (pct) {
        CHROME.alpha = Math.round(pct * 255 / 100);
        paintAlphaLine();
      });
    }, function (err) {
      STATE.hint = '透明度未生效：' + (err && err.message ? err.message : String(err));
    });
  });

  // 「新建与管理」= 打开配置页并直接进「规则与任务」（新建规则入口就在那里）。
  // 2026-10-27 用户要求删掉重复的「配置」按钮（同一个去处），这里只剩这一个入口。
  document.getElementById('btnNew').addEventListener('click', function () {
    STATE.configTab = 'rules';
    showScreen('config');
  });
  /* 固定方式按钮：点一下就地弹菜单（不是模态框），选中项立即生效 */
  btnPinEl.addEventListener('click', function (e) {
    e.stopPropagation();
    togglePinMenu();
  });
  if (pinMenuEl) {
    pinMenuEl.addEventListener('click', function (e) {
      const item = e.target.closest('button[data-pin]');
      if (!item) return;
      e.stopPropagation();
      setPinMode(item.dataset.pin);
    });
  }
  // 点菜单外任意处关闭（capture 阶段判断，避免被子元素的 stopPropagation 挡掉）
  document.addEventListener('click', function (e) {
    if (!pinMenuEl || pinMenuEl.hidden) return;
    if (pinMenuEl.contains(e.target) || btnPinEl.contains(e.target)) return;
    closePinMenu();
  }, true);
  window.addEventListener('resize', closePinMenu);
  document.getElementById('btnCollapse').addEventListener('click', function () { collapseWindow(); });
  if (snapHandleEl) snapHandleEl.addEventListener('click', function () { expandWindow(); });
  document.getElementById('btnAnalysis').addEventListener('click', function () { showScreen('analysis'); });
  document.getElementById('btnSettings').addEventListener('click', function () { showScreen('settings'); });
  document.getElementById('analysisBack').addEventListener('click', closeScreen);
  document.getElementById('analysisDone').addEventListener('click', closeScreen);
  document.getElementById('configBack').addEventListener('click', closeScreen);
  document.getElementById('configDone').addEventListener('click', closeScreen);
  document.getElementById('setBack').addEventListener('click', closeScreen);
  document.getElementById('setDone').addEventListener('click', closeScreen);

  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    if (pinMenuEl && !pinMenuEl.hidden) { closePinMenu(); return; }
    if (!confirmMaskEl.hidden) { settleConfirm(false); return; }
    if (!formMaskEl.hidden) { closeForm(); return; }
    if (!bookPickerMaskEl.hidden) { closeBookPicker(); return; }
    if (!bookScreenEl.hidden) { closeBook(); return; }
    if (!memoMaskEl.hidden) { closeMemoForm(); return; }
    if (!maskEl.hidden) { closePanel(); return; }
    if (STATE.screen) closeScreen();
  });

  /* ---------- 10. 密度跟随宽度 ---------- */
  function measureWidth() {
    const w = calCardEl.getBoundingClientRect().width;
    return w > 0 ? w : (window.innerWidth || 0);
  }
  function applyDensity() {
    const next = densityForWidth(measureWidth());
    if (next === STATE.density) return;
    const keep = STATE.view;
    STATE.density = next;
    document.documentElement.dataset.density = next;
    renderGrid();
    const pos = weekPosOfMonth(keep.y, keep.m);
    if (pos >= 0) scrollToWeek(pos, false);
    fitTags();
  }
  let raf = 0;
  function queueDensity() {
    if (raf) return;
    raf = requestAnimationFrame(function () { raf = 0; applyDensity(); });
  }
  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(queueDensity).observe(calCardEl);
  }
  window.addEventListener('resize', queueDensity);

  /* ---------- 11. 启动 ---------- */
  /* 首次进入 / 数据变更后：重建周数组，一次拉齐全部日期，然后定位到当前月 */
  async function render() {
    const anchor = STATE.view;
    STATE.weeks = buildWeeks(anchor.y, anchor.m);
    indexWeeks();
    await loadRange();
    if (!STATE.rules.length) await loadRules();
    await loadMemos();
    sourceEl.textContent = '数据源：' + (SOURCE === 'tauri' ? 'Tauri 本地库' : '内置种子（浏览器兜底）');
    renderGrid();
    const pos = weekPosOfMonth(anchor.y, anchor.m);
    if (pos >= 0) scrollToWeek(pos, false);
    syncMonthChrome();
    fitTags();
  }

  function fail(err) {
    console.error('[took] 渲染失败', err);
    subEl.textContent = '加载失败：' + (err && err.message ? err.message : String(err));
  }

  STATE.density = densityForWidth(measureWidth());
  document.documentElement.dataset.density = STATE.density;
  renderWeekHead();
  // 启动即把真窗口状态读回来：重启后透明度要立刻是上次的值，
  // 收起态一律回到展开（后端根本不持久化收起态，见 lib.rs 的注释）。
  refreshChrome().then(function () {
    setCollapsedView(false);
    if (STATE.screen === 'settings') renderSettings();
  }).catch(function () {});
  // 启动即把固定方式读回来：上次设成「置顶」的话，按钮文字一开始就得是「置顶」，
  // 不能先显示「普通」再跳一下（后端 restore_window_chrome 已经把效果恢复过了）。
  refreshPin().catch(function () {});

  render()
    .then(function () { return refreshSyncStatus(); })
    .catch(fail);

  // 首次进入尝试一次，之后每 5 分钟一次；只在真 Tauri 里跑（浏览器兜底没有后端）
  if (TAURI) {
    setTimeout(function () { runSync(); }, 1200);
    setInterval(function () { runSync(); }, 5 * 60 * 1000);
  }

  /* =========================================================================
     对外接口：给按页面拆分的模块（mgr.js / analysis.js / settings.js / misc.js）用。
   只暴露读取与刷新能力，不暴露内部状态，避免模块之间互相踩。
   =========================================================================== */
window.Took = {
  /** 月历数据缓存（'YYYY-MM-DD' → tasks[]） */
  cache: () => STATE.cache,
  /** 记事缓存 */
  memoCache: () => STATE.memoCache,
  /** 三类 memo 列表 */
  memos: () => STATE.memos,
  /** 当前显示的月份 { y, m } */
  view: () => STATE.view,
  /** 重新拉一段时间的数据并重绘月历 */
  reload: (fromDate, toDate) => loadRange(fromDate, toDate).then(() => renderGrid()),
  /** 读规则列表（管理页用） */
  loadRules: () => loadRules(),
  /** 读 memo 列表 */
  loadMemos: () => loadMemos(),
  /** 显隐某个 screen */
  showScreen: (id, on) => { const el = document.getElementById(id); if (el) el.hidden = !on; },
  /** 底层 invoke（模块自己调后端命令用） */
  invoke: (cmd, args) => invoke(cmd, args),
  /** 重绘月历 */
  renderGrid: () => renderGrid(),
};

})();
