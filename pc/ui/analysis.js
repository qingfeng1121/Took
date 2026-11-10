/* analysis.js —— 统计分析页（T2 完整实现）
   ===========================================================================
   数据全部现算，不写死任何数字。

   取数优先级：
     1. window.Took.cache() —— 月历已经拉过 [规则最早起始日, 今天] 这一段时直接复用，不重复拉；
     2. window.Took.invoke('range_grid' / 'list_rules') —— 缓存不够时按同一套命令补拉；
     3. 直接调 Tauri 全局的 invoke，再不行走 mock.js —— 仅在 window.Took 不可用时兜底。
   三条路拿到的都是同一条后端命令的同一份数据，口径不会分叉。

   周期口径与 Android StatsEngine.kt 逐条一致：
     · 应完成周期 = 区间内该规则命中日归属到的 period_start 去重后的个数；
     · 已完成周期 = 这些 period_start 里打卡表为 true 的个数；
     · 同一周期内多个命中日只计一次（周一做完，本周就永远是完成态）；
     · 区间结束日压到今天：未来还没到的日子不计入应完成；
     · 连续 = 从今天往前，当天所有命中任务都完成才算一天，没有命中任务的日子跳过。
   period_start 由后端 engine::period_start_of 给出（与 Android Engine.periodStartOf
   同一份契约 §3.3），前端只做去重与计数，不重新推导周期。
   =========================================================================== */
(function () {
  'use strict';

  var T = window.Took;

  /* ---------------------------------------------------------------- 日期工具 */
  var DAY_MS = 86400000;
  var DIM = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function parseKey(k) { return { y: +k.slice(0, 4), m: +k.slice(5, 7), d: +k.slice(8, 10) }; }
  function toKey(y, m, d) { return y + '-' + pad2(m) + '-' + pad2(d); }
  function serial(k) { var p = parseKey(k); return Date.UTC(p.y, p.m - 1, p.d) / DAY_MS; }
  function fromSerial(n) {
    var dt = new Date(n * DAY_MS);
    return toKey(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
  }
  function addDays(k, n) { return fromSerial(serial(k) + n); }
  function weekdayIdx(k) { return (((serial(k) + 3) % 7) + 7) % 7; } // 周一 = 0
  function isLeap(y) { return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0; }
  function daysInMonth(y, m) { return m === 2 ? (isLeap(y) ? 29 : 28) : DIM[m - 1]; }
  function todayKey() {
    var d = new Date();
    return toKey(d.getFullYear(), d.getMonth() + 1, d.getDate());
  }
  function cnDate(k) { var p = parseKey(k); return p.m + ' 月 ' + p.d + ' 日'; }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function pct(v) { return (v * 100).toFixed(1); }

  /* ---------------------------------------------------------------- 取数 */
  var LOCAL = { cache: new Map(), span: null, rules: [], rulesLoaded: false };
  var TOOK_OK = null;   // null = 还没探测过；true / false = window.Took 能不能用

  function tauriInvoker() {
    var g = window.__TAURI__;
    if (g && g.core && typeof g.core.invoke === 'function') {
      return function (cmd, args) { return g.core.invoke(cmd, args); };
    }
    var i = window.__TAURI_INTERNALS__;
    if (i && typeof i.invoke === 'function') {
      return function (cmd, args) { return i.invoke(cmd, args); };
    }
    return null;
  }

  /** app.js 的月历缓存（已覆盖月历 ±12 个月）；拿不到就返回 null。 */
  function tookCache() {
    if (TOOK_OK === false) return null;
    try {
      var c = T && typeof T.cache === 'function' ? T.cache() : null;
      if (c && typeof c.forEach === 'function') { TOOK_OK = true; return c; }
    } catch (e) { /* 落到下面的兜底 */ }
    TOOK_OK = false;
    return null;
  }

  /** 命令调用：window.Took.invoke 优先，拿不到时走 Tauri 全局，再不行走 mock。 */
  function rawInvoke(cmd, args) {
    if (TOOK_OK !== false && T && typeof T.invoke === 'function') {
      try {
        var p = T.invoke(cmd, args);
        if (p && typeof p.then === 'function') { TOOK_OK = true; return p; }
      } catch (e) { TOOK_OK = false; }
    }
    var f = tauriInvoker();
    if (f) return f(cmd, args);
    if (window.TookMock) return Promise.resolve(window.TookMock.invoke(cmd, args));
    return Promise.reject(new Error('没有可用的数据源'));
  }

  /** 统计用的缓存：app.js 的缓存优先（不重复拉数据），不够用时退回本模块自己拉的。 */
  function cacheOf() {
    var shared = tookCache();
    if (shared && shared.size) return shared;
    return LOCAL.cache;
  }

  /** 共享缓存是否已经覆盖 [from, today] 这一段（覆盖就不用再拉）。 */
  function covers(cache, from, today) {
    var min = '';
    var max = '';
    cache.forEach(function (v, k) {
      if (!min || k < min) min = k;
      if (!max || k > max) max = k;
    });
    return !!min && min <= from && max >= today;
  }

  /** 规则的最早起始日：「全部」的区间起点（与 StatsEngine.range(RANGE_ALL) 同口径）。 */
  function earliestRuleStart() {
    var min = '';
    LOCAL.rules.forEach(function (r) {
      var s = r && r.start_date;
      if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return;
      if (!min || s < min) min = s;
    });
    return min;
  }

  /** 拉齐数据：规则列表 + [最早起始日, 今天] 的逐日展开。 */
  async function ensureData(force) {
    var today = todayKey();
    if (!LOCAL.rulesLoaded || force) {
      try {
        LOCAL.rules = (await rawInvoke('list_rules', { includeEnded: true, today: today })) || [];
        LOCAL.rulesLoaded = true;
      } catch (e) { LOCAL.rules = []; LOCAL.rulesLoaded = true; }
    }
    var from = earliestRuleStart() || addDays(today, -29);
    if (serial(today) - serial(from) > 3990) from = addDays(today, -3990); // range_grid 上限 4000 天

    // app.js 的缓存已经够用：直接复用，不再重复拉一遍
    var shared = tookCache();
    if (shared && shared.size && covers(shared, from, today)) return shared;

    var span = LOCAL.span;
    if (!force && span && span.from <= from && span.to >= today) return LOCAL.cache;
    try {
      var days = (await rawInvoke('range_grid', { from: from, to: today })) || [];
      LOCAL.cache = new Map();
      days.forEach(function (d) { LOCAL.cache.set(d.date, d.tasks || []); });
      LOCAL.span = { from: from, to: today };
    } catch (e) { LOCAL.span = null; }
    return LOCAL.cache;
  }

  /* ---------------------------------------------------------------- 常量 */
  var RANGES = [
    { id: 'week', label: '本周' },
    { id: 'month', label: '本月' },
    { id: 'd30', label: '近 30 天' },
    { id: 'all', label: '全部' }
  ];
  var TYPES = [
    { id: 'rate', label: '完成率', sub: '按周期统计：已完成周期 ÷ 应完成周期，同一周期内重复打卡只计一次' },
    { id: 'rule', label: '按规则分组', sub: '按规则汇总其下全部任务的应完成 / 已完成周期，横向对比每条规则的完成率' },
    { id: 'streak', label: '连续打卡', sub: '当天所有命中任务都完成才算一天；没有任何命中任务的日子跳过，不算断签' }
  ];
  var COLS = { rule: '规则', task: '任务', exp: '应完成周期', done: '已完成', rate: '完成率', last: '最近打卡' };

  var state = { range: 'month', type: 'rate', sort: { key: 'rate', dir: 'desc' } };
  var lastExport = null;

  function typeMeta(id) {
    for (var i = 0; i < TYPES.length; i += 1) if (TYPES[i].id === id) return TYPES[i];
    return TYPES[0];
  }

  /* ---------------------------------------------------------------- 区间 */
  /** 时间范围 → { start, end }。结束日一律压到今天：未来还没到的日子不计入应完成。 */
  function rangeOf(id) {
    var today = todayKey();
    var start;
    var naturalEnd;
    var label = '本月';
    if (id === 'week') {
      start = addDays(today, -weekdayIdx(today));   // 周一起始（与月历 weekStart=mon 一致）
      naturalEnd = addDays(start, 6);
      label = '本周';
    } else if (id === 'd30') {
      start = addDays(today, -29);
      naturalEnd = today;
      label = '近 30 天';
    } else if (id === 'all') {
      start = earliestRuleStart() || today;
      naturalEnd = today;
      label = '全部';
    } else {
      var p = parseKey(today);
      start = toKey(p.y, p.m, 1);
      naturalEnd = toKey(p.y, p.m, daysInMonth(p.y, p.m));
      label = '本月';
    }
    if (start > today) start = today;
    var end = naturalEnd > today ? today : naturalEnd;
    return { id: id, label: label, start: start, end: end, days: serial(end) - serial(start) + 1 };
  }

  /* ---------------------------------------------------------------- 主计算 */
  function bucketSize(days) {
    if (days <= 31) return 1;
    if (days <= 100) return 3;
    return 7;
  }
  function bucketName(size) { return size === 1 ? '每日' : (size === 3 ? '每 3 天' : '每周'); }

  /**
   * 现算一份统计（与 Android StatsEngine.compute 同一口径）：
   * 逐日在缓存里取命中任务 → 按 rule 收 period_start 集合（去重即「同一周期只计一次」）
   * → 每个任务 expected = 该规则周期数、done = 其中已打卡的周期数。
   */
  function compute(rangeId, cacheArg) {
    var cache = cacheArg || cacheOf();
    var r = rangeOf(rangeId);
    var dates = [];
    var i;
    for (i = 0; i < r.days; i += 1) dates.push(addDays(r.start, i));

    var ruleMap = new Map();          // rule_id → { id, title, periods:Set, tasks:Map }
    var dayExpected = [];
    var dayDone = [];
    for (i = 0; i < r.days; i += 1) { dayExpected.push(0); dayDone.push(0); }

    dates.forEach(function (key, idx) {
      var list = cache.get(key) || [];
      list.forEach(function (t) {
        var rid = String(t.rule_id);
        var tid = String(t.task_id);
        var ps = String(t.period_start);
        var rule = ruleMap.get(rid);
        if (!rule) {
          rule = { id: rid, title: t.rule_title || rid, periods: new Set(), tasks: new Map() };
          ruleMap.set(rid, rule);
        }
        var task = rule.tasks.get(tid);
        if (!task) {
          task = { id: tid, title: t.title || tid, donePeriods: new Set() };
          rule.tasks.set(tid, task);
        }
        rule.periods.add(ps);
        if (t.done) task.donePeriods.add(ps);
        dayExpected[idx] += 1;
        if (t.done) dayDone[idx] += 1;
      });
    });

    var rows = [];
    var rules = [];
    ruleMap.forEach(function (rule) {
      var expected = rule.periods.size;
      var stats = [];
      rule.tasks.forEach(function (task) {
        var done = 0;
        var last = '';
        task.donePeriods.forEach(function (ps) {
          if (!rule.periods.has(ps)) return;
          done += 1;
          if (!last || ps > last) last = ps;
        });
        stats.push({
          ruleId: rule.id, rule: rule.title, taskId: task.id, task: task.title,
          exp: expected, done: done, last: last
        });
      });
      var rExp = 0;
      var rDone = 0;
      stats.forEach(function (s) { rExp += s.exp; rDone += s.done; });
      rows = rows.concat(stats);
      rules.push({
        ruleId: rule.id, rule: rule.title, exp: rExp, done: rDone,
        rate: rExp ? rDone / rExp : 0, tasks: stats.length
      });
    });

    rows.sort(function (a, b) {
      if (a.rule !== b.rule) return a.rule < b.rule ? -1 : 1;
      if (a.task !== b.task) return a.task < b.task ? -1 : 1;
      return a.taskId < b.taskId ? -1 : 1;
    });
    rules.sort(function (a, b) { return b.rate - a.rate || (a.rule < b.rule ? -1 : 1); });

    var days = dates.map(function (k, idx) {
      return { date: k, expected: dayExpected[idx], done: dayDone[idx] };
    });

    // 连续：从区间末尾（今天）往前，命中任务全部完成才算一天；没有命中任务的日子跳过
    var current = 0;
    var cursor = days.length - 1;
    while (cursor >= 0) {
      if (days[cursor].expected === 0) { cursor -= 1; continue; }
      if (days[cursor].done !== days[cursor].expected) break;
      current += 1;
      cursor -= 1;
    }
    // 最长：区间内连续「完成日」的最长一段；没有命中任务的日子会中断这一段
    var best = 0;
    var run = 0;
    days.forEach(function (d) {
      run = (d.expected > 0 && d.done === d.expected) ? run + 1 : 0;
      if (run > best) best = run;
    });

    var totalExpected = 0;
    var totalDone = 0;
    rows.forEach(function (x) { totalExpected += x.exp; totalDone += x.done; });

    var size = bucketSize(days.length);
    var buckets = [];
    for (i = 0; i < days.length; i += size) {
      var chunk = days.slice(i, i + size);
      var be = 0;
      var bd = 0;
      chunk.forEach(function (d) { be += d.expected; bd += d.done; });
      buckets.push({ date: chunk[0].date, expected: be, done: bd });
    }

    return {
      range: r,
      days: days,
      buckets: buckets,
      bucketSize: size,
      bucketName: bucketName(size),
      rows: rows,
      rules: rules,
      totalExpected: totalExpected,
      totalDone: totalDone,
      rate: totalExpected ? totalDone / totalExpected : 0,
      currentStreak: current,
      bestStreak: best,
      activeDays: days.filter(function (d) { return d.done > 0; }).length,
      completeDays: days.filter(function (d) { return d.expected > 0 && d.done === d.expected; }).length
    };
  }

  /* ---------------------------------------------------------------- DOM */
  function $(id) { return document.getElementById(id); }
  var elScreen = $('analysisScreen');
  var elRangeSeg = $('anRangeSeg');
  var elTypeDd = $('anTypeDd');
  var elTypeBtn = $('anTypeBtn');
  var elTypePanel = $('anTypePanel');
  var elTypeLabel = $('anTypeLabel');
  var elExport = $('anExport');
  var elSub = $('anSub');
  var elMRange = $('anMRange');
  var elMDays = $('anMDays');
  var elMLast = $('anMLast');
  var elKpis = $('anKpis');
  var elBarTitle = $('anBarTitle');
  var elBarSub = $('anBarSub');
  var elBarLegend = $('anBarLegend');
  var elPlotArea = $('anPlotArea');
  var elPlot = $('anPlot');
  var elXlabels = $('anXlabels');
  var elPlotEmpty = $('anPlotEmpty');
  var elTopTitle = $('anTopTitle');
  var elTopSub = $('anTopSub');
  var elTopBody = $('anTopBody');
  var elTblSub = $('anTblSub');
  var elTblCount = $('anTblCount');
  var elTblBody = $('anTblBody');

  function emptyHtml(tip) {
    return '<div class="an-empty">' +
      '<span class="ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"' +
      ' stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="5.5" width="17" height="15" rx="3"/>' +
      '<path d="M8 3.2v4M16 3.2v4M3.5 10.5h17"/><path d="M9 15h6"/></svg></span>' +
      '<b>这段时间没有打卡记录</b>' +
      '<span>' + esc(tip || '换一个时间范围，或完成一次打卡后再来看') + '</span></div>';
  }

  /* ---------------------------------------------------------------- KPI 四宫格 */
  function renderKpis(res) {
    if (!elKpis) return;
    var tiles = [
      { label: '已完成周期', value: res.totalDone, unit: '个', sub: '同一周期只计一次' },
      { label: '应完成周期', value: res.totalExpected, unit: '个',
        sub: res.rows.length + ' 个任务 · 共 ' + res.range.days + ' 天' },
      { label: '完成率', value: pct(res.rate), unit: '%', sub: res.totalDone + ' / ' + res.totalExpected },
      { label: '连续打卡', value: res.currentStreak, unit: '天',
        sub: '最长 ' + res.bestStreak + ' 天 · 全清 ' + res.completeDays + ' 天' }
    ];
    elKpis.innerHTML = tiles.map(function (k) {
      return '<div class="an-kpi">' +
        '<p class="an-kpi-label">' + esc(k.label) + '</p>' +
        '<p class="an-kpi-num"><b>' + k.value + '</b><span>' + esc(k.unit) + '</span></p>' +
        '<p class="an-kpi-sub">' + esc(k.sub) + '</p></div>';
    }).join('');
  }

  /* ---------------------------------------------------------------- 柱状图（完成率） */
  function renderBars(res) {
    var maxExp = 1;
    res.buckets.forEach(function (b) { if (b.expected > maxExp) maxExp = b.expected; });
    elPlot.className = 'an-plot';
    elPlot.innerHTML = res.buckets.map(function (b) {
      var tip = cnDate(b.date) + '：完成 ' + b.done + ' / 应完成 ' + b.expected;
      if (!b.expected) return '<div class="an-bar" title="' + esc(tip) + '"><div class="stub"></div></div>';
      var miss = Math.max(0, b.expected - b.done);
      var hDone = b.done / maxExp * 100;
      var hMiss = miss / maxExp * 100;
      return '<div class="an-bar" title="' + esc(tip) + '"><div class="stk">' +
        (hMiss > 0 ? '<div class="sgm miss" style="height:' + hMiss.toFixed(2) + '%"></div>' : '') +
        (hDone > 0 ? '<div class="sgm done" style="height:' + hDone.toFixed(2) + '%"></div>' : '') +
        '</div></div>';
    }).join('');

    var n = res.buckets.length;
    var step = n <= 8 ? 1 : (n <= 16 ? 2 : Math.ceil(n / 11));
    elXlabels.innerHTML = res.buckets.map(function (b, i) {
      if (i % step !== 0 && i !== n - 1) return '<span></span>';
      var p = parseKey(b.date);
      return '<span>' + (res.bucketSize === 1 ? p.d : p.m + '/' + p.d) + '</span>';
    }).join('');
  }

  /* ---------------------------------------------------------------- 横向条形图（按规则分组） */
  function hbList(items) {
    if (!items.length) return emptyHtml('区间内没有任何命中任务');
    return '<div class="an-hb-list">' + items.map(function (it, i) {
      var w = Math.max(it.ratio > 0 ? 3 : 0, it.ratio * 100);
      return '<div class="an-hb' + (i === 0 ? ' top' : '') + '">' +
        '<span class="an-hb-name" title="' + esc(it.name) + '">' + esc(it.name) + '</span>' +
        '<span class="an-hb-track"><i style="width:' + w.toFixed(1) + '%"></i></span>' +
        '<span class="an-hb-val">' + esc(it.label) + '</span></div>';
    }).join('') + '</div>';
  }

  function renderRuleBars(res) {
    elPlot.className = 'an-plot matrix';
    elPlot.innerHTML = '';
    elXlabels.innerHTML = '';
    if (!res.rules.length) {
      elPlot.innerHTML = emptyHtml('区间内没有任何命中任务');
      return;
    }
    elPlot.innerHTML = '<div class="an-rules">' + res.rules.map(function (r) {
      var w = Math.max(r.rate > 0 ? 2 : 0, r.rate * 100);
      return '<div class="an-rule-row">' +
        '<span class="an-rule-nm" title="' + esc(r.rule) + '">' + esc(r.rule) + '</span>' +
        '<span class="an-rule-track"><i style="width:' + w.toFixed(1) + '%"></i></span>' +
        '<span class="an-rule-val">' + pct(r.rate) + '%</span>' +
        '<span class="an-rule-sub">' + r.done + '/' + r.exp + ' 周期 · ' + r.tasks + ' 任务</span>' +
        '</div>';
    }).join('') + '</div>';
  }

  /* ---------------------------------------------------------------- 色块矩阵（连续打卡） */
  function renderMatrix(res) {
    var CAP = 56;
    var shown = res.days.slice(Math.max(0, res.days.length - CAP));
    var cols = [];
    var cur = null;
    shown.forEach(function (d) {
      var wk = addDays(d.date, -weekdayIdx(d.date));
      if (!cur || cur.week !== wk) { cur = { week: wk, cells: [] }; cols.push(cur); }
      cur.cells.push(d);
    });
    elPlot.className = 'an-plot matrix';
    elXlabels.innerHTML = '';
    var html = '<div class="an-matrix">';
    cols.forEach(function (c) {
      html += '<div class="an-mcol">';
      for (var i = 0; i < 7; i += 1) {
        var day = null;
        for (var j = 0; j < c.cells.length; j += 1) if (weekdayIdx(c.cells[j].date) === i) day = c.cells[j];
        if (!day) { html += '<i class="an-cell void" title="—"></i>'; continue; }
        var cls = 'none';
        if (day.expected === 0) cls = 'neutral';
        else if (day.done === day.expected) cls = 'full';
        else if (day.done > 0) cls = 'part';
        var tip = cnDate(day.date) + '：完成 ' + day.done + ' / 应完成 ' + day.expected;
        html += '<i class="an-cell ' + cls + '" title="' + esc(tip) + '"></i>';
      }
      html += '</div>';
    });
    html += '</div>';
    elPlot.innerHTML = html;
  }

  /* ---------------------------------------------------------------- 图表总调度 */
  function renderChart(res) {
    var t = state.type;
    var empty = res.totalExpected === 0;
    elPlotArea.hidden = false;
    elPlotEmpty.hidden = true;
    elPlotEmpty.innerHTML = '';

    if (t === 'rate') {
      elBarTitle.textContent = res.bucketName + '完成情况';
      elBarSub.textContent = '柱高 = 该段时间内应完成的周期数，橙色为已完成部分';
      elBarLegend.innerHTML = '<span><i style="background:var(--accent)"></i>已完成</span>' +
        '<span><i style="background:var(--text-3)"></i>未完成</span>';
      if (empty) { elPlotArea.hidden = true; elPlotEmpty.hidden = false; elPlotEmpty.innerHTML = emptyHtml(); return; }
      renderBars(res);
    } else if (t === 'rule') {
      elBarTitle.textContent = '各规则完成率';
      elBarSub.textContent = '按规则汇总其下全部任务的周期：已完成 ÷ 应完成';
      elBarLegend.innerHTML = '<span><i style="background:var(--accent-line)"></i>完成率</span>';
      if (empty) { elPlotArea.hidden = true; elPlotEmpty.hidden = false; elPlotEmpty.innerHTML = emptyHtml(); return; }
      renderRuleBars(res);
    } else {
      var n = Math.min(56, res.days.length);
      elBarTitle.textContent = '最近 ' + n + ' 天色块矩阵';
      elBarSub.textContent = '一格一天：当天所有命中任务都完成才是实心；没有命中任务的日子是空心';
      elBarLegend.innerHTML = '<span><i style="background:var(--accent)"></i>全完成</span>' +
        '<span><i style="background:var(--accent-line)"></i>部分</span>' +
        '<span><i style="background:var(--text-3)"></i>未完成</span>' +
        '<span><i style="background:var(--line)"></i>无任务</span>';
      if (empty) { elPlotArea.hidden = true; elPlotEmpty.hidden = false; elPlotEmpty.innerHTML = emptyHtml(); return; }
      renderMatrix(res);
    }
  }

  /* ---------------------------------------------------------------- 排行 */
  function renderTop(res) {
    if (state.type === 'rule') {
      elTopTitle.textContent = '各任务完成率 Top 5';
      elTopSub.textContent = '已完成 ÷ 应完成周期';
      if (!res.rows.length) { elTopBody.innerHTML = emptyHtml('区间内没有任何命中任务'); return; }
      var items = res.rows.slice().sort(function (a, b) {
        var ra = a.exp ? a.done / a.exp : 0;
        var rb = b.exp ? b.done / b.exp : 0;
        return rb - ra || b.done - a.done;
      }).slice(0, 5).map(function (r) {
        return { name: r.task, ratio: r.exp ? r.done / r.exp : 0, label: pct(r.exp ? r.done / r.exp : 0) + '%' };
      });
      elTopBody.innerHTML = hbList(items) +
        '<p class="an-card-foot">口径：一个周期只计一次，同一周内重复点击不会重复计数</p>';
      return;
    }
    if (state.type === 'streak') {
      elTopTitle.textContent = '各任务最近打卡 Top 5';
      elTopSub.textContent = '按最近一次打卡日期排序';
      if (!res.rows.length) { elTopBody.innerHTML = emptyHtml('区间内没有任何命中任务'); return; }
      var maxRaw = 1;
      res.rows.forEach(function (r) { if (r.done > maxRaw) maxRaw = r.done; });
      var its = res.rows.slice().sort(function (a, b) {
        if (a.last !== b.last) return b.last > a.last ? 1 : -1;
        return b.done - a.done;
      }).slice(0, 5).map(function (r) {
        return { name: r.task, ratio: r.done / maxRaw, label: r.last ? cnDate(r.last) : '—' };
      });
      elTopBody.innerHTML = hbList(its) +
        '<p class="an-card-foot">连续天数从今天往前回看：当天命中任务全部完成才算一天</p>';
      return;
    }
    elTopTitle.textContent = '各规则完成率 Top 5';
    elTopSub.textContent = '按规则汇总其下全部任务的周期';
    if (!res.rules.length) { elTopBody.innerHTML = emptyHtml('区间内没有任何命中任务'); return; }
    var top = res.rules.slice().sort(function (a, b) {
      return b.rate - a.rate || b.done - a.done;
    }).slice(0, 5).map(function (r) {
      return { name: r.rule, ratio: r.rate, label: pct(r.rate) + '%' };
    });
    elTopBody.innerHTML = hbList(top) +
      '<p class="an-card-foot">口径：一个周期只计一次，同一周内重复点击不会重复计数</p>';
  }

  /* ---------------------------------------------------------------- 明细表 */
  function sortRows(rows) {
    var key = state.sort.key;
    var dir = state.sort.dir === 'asc' ? 1 : -1;
    return rows.slice().sort(function (a, b) {
      if (key === 'rule' || key === 'task') {
        var r = String(a[key]).localeCompare(String(b[key]), 'zh-Hans-CN');
        return (r || (b.done - a.done)) * dir;
      }
      var va;
      var vb;
      if (key === 'exp') { va = a.exp; vb = b.exp; }
      else if (key === 'done') { va = a.done; vb = b.done; }
      else if (key === 'rate') { va = a.exp ? a.done / a.exp : 0; vb = b.exp ? b.done / b.exp : 0; }
      else { va = a.last || ''; vb = b.last || ''; }
      if (va === vb) return (b.done - a.done) * dir;
      return (va < vb ? -1 : 1) * dir;
    });
  }

  function renderTable(res) {
    var ths = document.querySelectorAll('#analysisScreen .an-tbl thead th');
    for (var i = 0; i < ths.length; i += 1) {
      var th = ths[i];
      var k = th.dataset.akey;
      th.classList.remove('asc', 'desc', 'active');
      if (k === state.sort.key) { th.classList.add(state.sort.dir); th.classList.add('active'); }
      th.setAttribute('aria-sort', k === state.sort.key
        ? (state.sort.dir === 'asc' ? 'ascending' : 'descending') : 'none');
    }
    elTblSub.textContent = '点表头可切换排序 · 当前按「' + COLS[state.sort.key] + '」' +
      (state.sort.dir === 'asc' ? '升序' : '降序');
    elTblCount.textContent = res.totalExpected === 0 ? '暂无数据'
      : '共 ' + res.rows.length + ' 条任务 · 已完成 ' + res.totalDone + ' 个周期';

    if (res.totalExpected === 0) {
      elTblBody.innerHTML = '<tr><td colspan="6" class="an-nopad">' + emptyHtml() + '</td></tr>';
      return;
    }
    elTblBody.innerHTML = sortRows(res.rows).map(function (r) {
      var rate = r.exp ? r.done / r.exp : 0;
      var barCls = rate >= 0.8 ? '' : (rate >= 0.5 ? 'low' : 'zero');
      var barW = rate > 0 ? Math.max(3, rate * 100) : 0;
      var pill = r.done === 0 ? '<span class="an-pill plain">未打卡</span>' : '';
      return '<tr>' +
        '<td><span class="an-rule-cell"><i></i><span>' + esc(r.rule) + '</span></span></td>' +
        '<td><span class="an-task-cell"><em>' + esc(r.task) + '</em>' + (pill ? ' ' + pill : '') + '</span></td>' +
        '<td>' + r.exp + '</td>' +
        '<td>' + r.done + '</td>' +
        '<td><span class="an-rate"><span class="an-rate-track"><i class="' + barCls +
        '" style="width:' + barW.toFixed(1) + '%"></i></span><b>' + pct(rate) + '%</b></span></td>' +
        '<td' + (r.last ? '' : ' class="an-mut"') + '>' + (r.last ? esc(cnDate(r.last)) : '—') + '</td>' +
        '</tr>';
    }).join('');
  }

  /* ---------------------------------------------------------------- 导出 CSV */
  function csvOf(res) {
    var head = ['规则', '任务', '应完成周期', '已完成周期', '完成率', '最近打卡'];
    var lines = [head.join(',')];
    sortRows(res.rows).forEach(function (r) {
      var rate = r.exp ? r.done / r.exp : 0;
      lines.push([r.rule, r.task, r.exp, r.done, pct(rate) + '%', r.last || ''].map(function (v) {
        var s = String(v);
        return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
      }).join(','));
    });
    lines.push('');
    lines.push(['合计', '', res.totalExpected, res.totalDone, pct(res.rate) + '%', ''].join(','));
    return lines.join('\r\n');
  }

  function exportCsv() {
    var res = compute(state.range);
    var text = '\ufeff' + csvOf(res);
    var name = 'took-stats-' + res.range.label.replace(/\s+/g, '') + '-' + todayKey() + '.csv';
    lastExport = { filename: name, text: text, rows: res.rows.length };
    var blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      if (a.parentNode) a.parentNode.removeChild(a);
      URL.revokeObjectURL(url);
    }, 0);
    return lastExport;
  }

  /* ---------------------------------------------------------------- 总渲染 */
  function paint() {
    if (!elKpis) return null;
    var res = compute(state.range);
    var meta = typeMeta(state.type);
    if (elSub) elSub.textContent = meta.sub;
    if (elTypeLabel) elTypeLabel.textContent = meta.label;
    if (elMRange) elMRange.textContent = cnDate(res.range.start) + ' – ' + cnDate(res.range.end);
    if (elMDays) elMDays.textContent = '共 ' + res.range.days + ' 天 · ' + res.bucketName + '分桶';
    if (elMLast) {
      var lastDone = '';
      res.rows.forEach(function (r) { if (r.last && r.last > lastDone) lastDone = r.last; });
      elMLast.textContent = lastDone ? '最近打卡 ' + cnDate(lastDone) : '本区间暂无打卡';
    }
    renderKpis(res);
    renderChart(res);
    renderTop(res);
    renderTable(res);
    return res;
  }

  /** 先拉数据再画；拉不到就用现有缓存画（不把页面卡成空白）。 */
  async function render(force) {
    try { await ensureData(!!force); } catch (e) { /* 数据源不可用：用已有缓存画 */ }
    return paint();
  }

  /* ---------------------------------------------------------------- 交互 */
  function bindRange() {
    if (!elRangeSeg) return;
    elRangeSeg.innerHTML = RANGES.map(function (r) {
      return '<button type="button" data-arange="' + r.id + '"' +
        (r.id === state.range ? ' class="on"' : '') + '>' + r.label + '</button>';
    }).join('');
    elRangeSeg.addEventListener('click', function (e) {
      var btn = e.target.closest('button[data-arange]');
      if (!btn) return;
      state.range = btn.dataset.arange;
      var all = elRangeSeg.querySelectorAll('button');
      for (var i = 0; i < all.length; i += 1) all[i].classList.toggle('on', all[i] === btn);
      paint();
    });
  }

  function bindType() {
    if (!elTypeBtn || !elTypePanel) return;
    var alpha = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6"' +
      ' stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7"/></svg>';
    function paintPanel() {
      elTypePanel.innerHTML = TYPES.map(function (t) {
        return '<button type="button" class="an-dd-item' + (t.id === state.type ? ' on' : '') + '"' +
          ' role="option" aria-selected="' + (t.id === state.type) + '" data-atype="' + t.id + '">' +
          '<span>' + t.label + '</span>' + alpha + '</button>';
      }).join('');
    }
    paintPanel();
    function setOpen(open) {
      elTypePanel.hidden = !open;
      elTypeDd.classList.toggle('open', open);
      elTypeBtn.setAttribute('aria-expanded', String(open));
    }
    elTypeBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      setOpen(elTypePanel.hidden);
    });
    elTypePanel.addEventListener('click', function (e) {
      var item = e.target.closest('[data-atype]');
      if (!item) return;
      e.stopPropagation();
      state.type = item.dataset.atype;
      paintPanel();
      setOpen(false);
      paint();
    });
    document.addEventListener('click', function (e) {
      if (elTypeDd && !elTypeDd.contains(e.target)) setOpen(false);
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') setOpen(false);
    });
  }

  function bindTable() {
    var ths = document.querySelectorAll('#analysisScreen .an-tbl thead th.sortable');
    for (var i = 0; i < ths.length; i += 1) {
      ths[i].addEventListener('click', function () {
        var k = this.dataset.akey;
        if (state.sort.key === k) state.sort.dir = state.sort.dir === 'asc' ? 'desc' : 'asc';
        else { state.sort.key = k; state.sort.dir = (k === 'rule' || k === 'task') ? 'asc' : 'desc'; }
        paint();
      });
    }
  }

  function bindExport() {
    if (!elExport) return;
    elExport.addEventListener('click', function () { exportCsv(); });
  }

  /* 进入统计页时重新现算：app.js 的 showScreen('analysis') 会调 renderAnalysis()，
     那个函数只往 #analysisMain 里写占位内容 —— 本页没有 #analysisMain，
     所以它直接 return，不覆盖这里的 DOM。这里靠按钮点击 + hidden 变化兜住所有入口，
     并在每次进入时强制重拉一次数据（刚打过卡时统计要立刻反映出来）。 */
  function bindScreenEntry() {
    var btn = document.getElementById('btnAnalysis');
    if (btn) btn.addEventListener('click', function () { setTimeout(function () { render(true); }, 0); });
    if (elScreen && window.MutationObserver) {
      new MutationObserver(function () {
        if (!elScreen.hidden) render(true);
      }).observe(elScreen, { attributes: true, attributeFilter: ['hidden'] });
    }
  }

  /* ---------------------------------------------------------------- 启动 */
  function boot() {
    bindRange();
    bindType();
    bindTable();
    bindExport();
    bindScreenEntry();
    render(false);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  /* 供验收脚本断言用：纯只读，不改变页面状态 */
  window.TookAnalysis = {
    ranges: RANGES,
    types: TYPES,
    state: function () { return { range: state.range, type: state.type, sort: { key: state.sort.key, dir: state.sort.dir } }; },
    setRange: function (id) { state.range = id; return paint(); },
    setType: function (id) { state.type = id; return paint(); },
    rangeOf: rangeOf,
    compute: compute,
    cache: cacheOf,
    refresh: function () { return render(true); },
    render: function () { return paint(); },
    csv: function () { return csvOf(compute(state.range)); },
    exportCsv: exportCsv,
    lastExport: function () { return lastExport; }
  };
})();
