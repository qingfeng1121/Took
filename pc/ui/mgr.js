/* mgr.js —— T3 管理页（规则 / 记事 / 倒数日 / 笔记本）
   ===========================================================================
   分工：app.js 继续往 #configNav / #configMain 写它自己的标记（既有回归脚本按
   #configMain .rule-row / .rule-count / #newRule / [data-act] 这些选择器定位），
   本文件把新管理页写进 #configMain 里的 #mgrRoot，旧标记由 style.css 末尾的
   #configScreen #configMain > :not(#mgrRoot){display:none} 隐掉。

   能复用 app.js 的一律复用：#newRule 打开规则表单、[data-act="edit"] / [data-act="del"]
   编辑与删除规则（走 app.js 自己的表单与二次确认）。其余（展开箭头 / 右侧橙色开关 /
   任务行铅笔与垃圾桶 / 三类 memo 弹窗 / 右下角 FAB）全在本文件实现。
   app.js 一个字都不改，数据一律经 window.Took 取。 */
(function () {
  'use strict';

  var T = window.Took;
  if (!T || typeof T.invoke !== 'function') return;

  var mainEl = document.getElementById('configMain');
  var navEl = document.getElementById('mgrNav');
  var legacyNavEl = document.getElementById('configNav');
  var screenEl = document.getElementById('configScreen');
  var titleEl = document.getElementById('mgrTitle');
  var subEl = document.getElementById('mgrSub');
  var fabEl = document.getElementById('mgrFab');
  var maskEl = document.getElementById('mgrMask');
  var dlgTitleEl = document.getElementById('mgrDlgTitle');
  var dlgBodyEl = document.getElementById('mgrDlgBody');
  var dlgFootEl = document.getElementById('mgrDlgFoot');
  var confirmEl = document.getElementById('mgrConfirmMask');
  var confirmTitleEl = document.getElementById('mgrConfirmTitle');
  var confirmTextEl = document.getElementById('mgrConfirmText');
  var confirmOkEl = document.getElementById('mgrConfirmOk');
  if (!mainEl || !navEl || !screenEl || !fabEl) return;

  /* ---------------------------------------------------------------- 图标 */
  var ICON = {
    caret: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 5l7 7-7 7"/></svg>',
    pencil: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20h4l10-10a2.8 2.8 0 1 0-4-4L4 16v4Z"/><path d="M13.5 6.5l4 4"/></svg>',
    trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16M9.5 7V5.2A1.2 1.2 0 0 1 10.7 4h2.6a1.2 1.2 0 0 1 1.2 1.2V7"/><path d="M6.5 7l.8 12.1A1.9 1.9 0 0 0 9.2 21h5.6a1.9 1.9 0 0 0 1.9-1.9L17.5 7"/><path d="M10.5 11v6M13.5 11v6"/></svg>'
  };

  /* ---------------------------------------------------------------- 分类 */
  var TABS = [
    { id: 'rules', name: '规则', sub: '点行编辑基础条件；点左侧箭头展开任务',
      icon: '<path d="M9 6h11M9 12h11M9 18h11"/><path d="M4 6l1.4 1.4L8 4.8"/><path d="M4 12l1.4 1.4L8 10.8"/><path d="M4 18l1.4 1.4L8 16.8"/>' },
    { id: 'note', name: '记事', sub: '可选日期或时间段，留空则不排期，只留在列表里',
      icon: '<path d="M6 3h9l5 5v13H6z"/><path d="M15 3v5h5"/><path d="M9 13h7M9 17h5"/>' },
    { id: 'countdown', name: '倒数日', sub: '只算与今天的天数差，不进入日历格子',
      icon: '<path d="M7 3h10M7 21h10"/><path d="M8 3v3.5c0 2 4 3.5 4 5.5s-4 3.5-4 5.5V21"/><path d="M16 3v3.5c0 2-4 3.5-4 5.5s4 3.5 4 5.5V21"/>' },
    { id: 'notebook', name: '笔记本', sub: '记录非时间性的事情，永远不进日历与打卡面板',
      icon: '<path d="M5 4.6A1.6 1.6 0 0 1 6.6 3H19v18H6.6A1.6 1.6 0 0 1 5 19.4z"/><path d="M9 3v18"/>' }
  ];
  var KIND = { note: 0, countdown: 1, notebook: 2 };
  var KIND_NAME = { 0: '记事', 1: '倒数日', 2: '笔记本' };
  var MEMO_META = {
    note: { title: '记事', desc: '可选时间段。留空 = 不排期，只留在列表里；填了日期就按月历逐日显示。' },
    countdown: { title: '倒数日', desc: '只算与今天的天数差，不进入月历。' },
    notebook: { title: '笔记本', desc: '记录非时间性的事情，永远不进月历与打卡面板。' }
  };

  var MG = {
    tab: 'rules',
    rules: [],
    memos: { 0: [], 1: [], 2: [] },
    expanded: Object.create(null),
    dlg: null,
    loaded: false,
    /* 行内编辑草稿：{ ruleId, taskId|null, value, enabled }。
       taskId 为空 = 新建（编辑器顶替「＋ 添加任务」按钮），否则 = 就地改这一行。 */
    inline: null,
    /* 编辑器是否应该持有焦点。用它而不是只靠 document.activeElement：
       后台重绘可能已经把焦点甩到 body，光看 activeElement 就再也接不回来了。 */
    inlineFocus: false
  };

  /* ---------------------------------------------------------------- 工具 */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function errText(e) { return (e && e.message) ? e.message : String(e); }
  function pad2(n) { return n < 10 ? '0' + n : '' + n; }
  function todayKey() {
    var d = new Date();
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }
  function ymd(y, m, d) {
    var total = y * 12 + (m - 1);
    var ny = Math.floor(total / 12);
    var nm = total - ny * 12 + 1;
    return ny + '-' + pad2(nm) + '-' + pad2(d);
  }
  function dim(y, m) {
    var total = y * 12 + (m - 1);
    var ny = Math.floor(total / 12);
    var nm = total - ny * 12 + 1;
    return new Date(ny, nm, 0).getDate();
  }
  function daySerial(key) {
    var y = +key.slice(0, 4), m = +key.slice(5, 7), d = +key.slice(8, 10);
    return Math.floor(Date.UTC(y, m - 1, d) / 86400000);
  }
  function ruleIdOf(el) {
    var b = el.closest('[data-rule-block]');
    return b ? b.dataset.ruleBlock : null;
  }
  function findRule(id) {
    return MG.rules.filter(function (r) { return r.id === id; })[0] || null;
  }
  function findMemo(kind, id) {
    return (MG.memos[kind] || []).filter(function (m) { return m.id === id; })[0] || null;
  }

  /* ---------------------------------------------------------------- 文案 */
  function maskText(mask) {
    if (mask === 127) return '每天';
    if (mask === 31) return '周一至周五';
    if (mask === 96) return '周六、周日';
    var cn = ['一', '二', '三', '四', '五', '六', '日'], out = [];
    for (var i = 0; i < 7; i += 1) if (mask & (1 << i)) out.push('周' + cn[i]);
    return out.length ? out.join('、') : '未选工作日';
  }
  function repeatText(r) {
    switch (r.repeat_mode) {
      case 0: return '每周 ' + maskText(r.weekdays_mask);
      case 1: return '每 ' + (r.repeat_every || 1) + ' 天';
      case 2: return r.month_day === -1 ? '每月最后一天' : '每月 ' + r.month_day + ' 日';
      case 3: return '每年 ' + r.year_month + ' 月 ' + r.year_day + ' 日';
      case 4: return '不重复';
      default: return '未知重复方式';
    }
  }
  function summaryOf(r) {
    var upper = r.repeat_until || r.end_date;
    var parts = [repeatText(r), r.start_date + ' ~ ' + (upper || '不限')];
    if (r.reminder_summary) parts.push(r.reminder_summary);
    return parts.join(' · ');
  }
  function noteRangeFull(m) {
    if (!m.start_date) return '未排期';
    if (!m.end_date || m.end_date === m.start_date) return m.start_date;
    return m.start_date + ' ~ ' + m.end_date;
  }
  function countdownText(m) {
    if (!m.start_date) return '没有目标日';
    var delta = daySerial(m.start_date) - daySerial(todayKey());
    if (delta < 0) return '已经 ' + (-delta) + ' 天';
    if (delta === 0) return '就是今天';
    return '还有 ' + delta + ' 天';
  }

  /* 规则进度：直接读月历缓存（后端 range_grid 的逐日展开，每条带 task_id /
     period_start / done），同一 (任务, 周期) 只计一次 —— 与打卡口径完全一致。 */
  function rateOf(r) {
    var seen = Object.create(null), done = 0, total = 0;
    T.cache().forEach(function (list) {
      for (var i = 0; i < list.length; i += 1) {
        var t = list[i];
        if (t.rule_id !== r.id) continue;
        var k = t.task_id + '|' + t.period_start;
        if (seen[k]) continue;
        seen[k] = 1;
        total += 1;
        if (t.done) done += 1;
      }
    });
    return { done: done, total: total, pct: total ? Math.round(done * 100 / total) : 0 };
  }

  /* ---------------------------------------------------------------- 渲染 */
  function rootEl() {
    var el = document.getElementById('mgrRoot');
    if (!el) {
      el = document.createElement('div');
      el.id = 'mgrRoot';
      el.className = 'mgr-root';
      mainEl.appendChild(el);
    }
    return el;
  }

  function renderNav() {
    navEl.innerHTML = TABS.map(function (t) {
      var on = t.id === MG.tab;
      return '<button type="button" data-tab="' + t.id + '"' +
        (on ? ' class="on" aria-current="page"' : '') + '>' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" ' +
        'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + t.icon + '</svg>' +
        '<span>' + t.name + '</span></button>';
    }).join('');
  }

  function tabMeta() {
    return TABS.filter(function (t) { return t.id === MG.tab; })[0] || TABS[0];
  }

  function renderChrome() {
    var meta = tabMeta();
    if (titleEl) titleEl.textContent = meta.name;
    if (subEl) subEl.textContent = meta.sub;
    var label = '新建' + meta.name;
    fabEl.setAttribute('aria-label', label);
    fabEl.setAttribute('title', label);
  }

  function taskItemHtml(t) {
    return '<div class="task-item' + (t.enabled ? '' : ' off') + '" data-task="' + esc(t.id) + '">' +
      '<span class="task-name">' + esc(t.title) + '</span>' +
      '<button class="switch sm" type="button" role="switch" data-mgr="tswitch"' +
        ' aria-checked="' + (t.enabled ? 'true' : 'false') + '"' +
        ' aria-label="启用任务 ' + esc(t.title) + '" title="启用 / 停用"></button>' +
      '<button class="icon-act" type="button" data-mgr="tedit" aria-label="编辑任务 ' + esc(t.title) + '" title="编辑任务">' +
        ICON.pencil + '</button>' +
      '<button class="icon-act danger" type="button" data-mgr="tdel" aria-label="删除任务 ' + esc(t.title) + '" title="删除任务">' +
        ICON.trash + '</button>' +
    '</div>';
  }

  /* 行内编辑行（2026-10-27 用户要求：「+ 添加任务」不再弹模态框）。
     位置就在原按钮处 / 原任务行处 —— 不弹层、不遮月历。 */
  function inlineRowHtml(ruleId, task, d) {
    var editing = !!task;
    return '<div class="task-inline" data-inline-rule="' + esc(ruleId) + '"' +
        (editing ? ' data-inline-task="' + esc(task.id) + '"' : '') + '>' +
      '<input class="inp task-inline-name" type="text" placeholder="例如：健身" ' +
        'aria-label="任务名称" value="' + esc(d.value) + '" />' +
      '<button class="switch sm" type="button" role="switch" data-mgr="tinlineswitch" ' +
        'aria-checked="' + (d.enabled ? 'true' : 'false') + '" ' +
        'aria-label="启用该任务" title="启用 / 停用"></button>' +
      '<button class="btn sm primary" type="button" data-mgr="tinlinesave">' +
        (editing ? '保存' : '添加') + '</button>' +
      '<button class="btn sm" type="button" data-mgr="tinlinecancel">取消</button>' +
      '<div class="task-inline-hint">回车保存 · Esc 取消 · 停用后不出现在月历与打卡面板，' +
        '已有打卡记录保留</div>' +
      '<div class="task-inline-err" hidden></div>' +
    '</div>';
  }

  /* 当前规则的行内草稿：draftFor(r.id) 命中才渲染输入框，否则渲染普通按钮/行。 */
  function draftFor(ruleId) {
    var d = MG.inline;
    return d && d.ruleId === ruleId ? d : null;
  }

  function ruleBlockHtml(r) {
    var tasks = r.tasks || [];
    var open = !!MG.expanded[r.id];
    var rate = rateOf(r);
    var badges = (r.ended ? '<span class="badge ended">已结束</span>' : '') +
      (r.enabled ? '' : '<span class="off-tag">已停用</span>');
    var draft = draftFor(r.id);
    var rows = tasks.length
      ? tasks.map(function (t) {
          return draft && draft.taskId === t.id ? inlineRowHtml(r.id, t, draft) : taskItemHtml(t);
        }).join('')
      : (draft && !draft.taskId ? '' : '<div class="task-empty">暂无任务，点下面的「＋ 添加任务」</div>');
    return '<div class="rule-block" data-rule-block="' + esc(r.id) + '">' +
      '<div class="mgr-row' + (open ? ' open' : '') + (r.enabled ? '' : ' off') + '"' +
        ' data-rule="' + esc(r.id) + '" data-ended="' + (r.ended ? '1' : '0') + '">' +
        '<button class="caret' + (open ? ' on' : '') + '" type="button" data-mgr="caret"' +
          ' aria-expanded="' + (open ? 'true' : 'false') + '"' +
          ' aria-label="' + (open ? '收起' : '展开') + '任务列表" title="展开 / 收起任务">' +
          ICON.caret + '</button>' +
        '<span class="rule-main" role="button" tabindex="0" data-act="edit"' +
          ' aria-label="编辑规则 ' + esc(r.title) + '">' +
          '<span class="rule-meta"><b>' + esc(r.title) + '</b>' + badges + '</span>' +
          '<i class="rule-sum">' + esc(summaryOf(r)) + '</i>' +
        '</span>' +
        '<span class="rule-side">' +
          '<span class="mgr-count">' + tasks.length + ' 个任务</span>' +
          '<span class="rate' + (rate.total ? '' : ' zero') + '"><b>' + rate.pct + '%</b>' +
            rate.done + '/' + rate.total + ' 周期</span>' +
          '<button class="switch" type="button" role="switch" data-mgr="switch"' +
            ' aria-checked="' + (r.enabled ? 'true' : 'false') + '"' +
            ' aria-label="启用规则 ' + esc(r.title) + '" title="启用 / 停用"></button>' +
          '<button class="icon-act" type="button" data-act="edit" aria-label="编辑规则 ' + esc(r.title) + '" title="编辑">' +
            ICON.pencil + '</button>' +
          '<button class="icon-act danger" type="button" data-act="del" aria-label="删除规则 ' + esc(r.title) + '" title="删除">' +
            ICON.trash + '</button>' +
        '</span>' +
      '</div>' +
      /* 任务行只在展开时进 DOM：折叠态任务行数为 0，展开后才是 N（原型同款） */
      (open
        ? '<div class="rule-tasks" data-mgr-panel="' + esc(r.id) + '">' + rows +
          (draft && !draft.taskId
            ? inlineRowHtml(r.id, null, draft)
            : '<button class="task-add" type="button" data-mgr="tadd" data-rule-id="' + esc(r.id) + '">' +
              '＋ 添加任务</button>') + '</div>'
        : '') +
    '</div>';
  }

  function rulesHtml() {
    var all = MG.rules;
    var active = all.filter(function (r) { return !r.ended; });
    var ended = all.filter(function (r) { return r.ended; });
    var taskTotal = all.reduce(function (n, r) { return n + (r.tasks || []).length; }, 0);
    var head = '<div class="mgr-head"><div class="mgr-head-text">' +
        '<div class="panel-title">规则</div>' +
        '<div class="panel-desc">共 ' + all.length + ' 条规则（进行中 ' + active.length + ' 条）· ' +
          taskTotal + ' 个任务 · 改动立即影响月历</div>' +
      '</div>' +
      /* 2026-10-27 用户要求：删掉标题旁的「＋ 新建规则」，只留右下角 FAB。 */
      '</div>';
    if (!all.length) {
      return head + '<div class="mgr-empty">还没有规则，点右下角的 + 开始</div>';
    }
    var body = active.length
      ? active.map(ruleBlockHtml).join('')
      : '<div class="mgr-empty">没有进行中的规则，历史规则在下面</div>';
    var tail = ended.length
      ? '<div class="panel-title sub">已结束（重复设置只读，仍可改名 / 启停 / 删任务）</div>' +
        ended.map(ruleBlockHtml).join('')
      : '';
    return head + '<div class="mgr-list">' + body + '</div>' + tail;
  }

  function memoRowHtml(kind, m) {
    var title = String(m.title || '').trim() || (kind === 2 ? '无标题笔记' : '（无标题）');
    var sub = kind === 0 ? noteRangeFull(m)
      : kind === 1 ? '目标日 ' + String(m.start_date || '').replace(/-/g, '/') + ' · ' + countdownText(m)
      : (String(m.content || '').trim() || '还没有正文');
    var cat = kind === 2 ? '<span class="memo-cat">' + esc(m.category || '未分类') + '</span>' : '';
    return '<div class="memo-row" data-memo="' + esc(m.id) + '">' +
      '<span class="memo-main" role="button" tabindex="0" data-mgr="medit">' +
        '<span class="rule-meta"><b>' + esc(title) + '</b>' + cat + '</span>' +
        '<i>' + esc(sub) + '</i>' +
      '</span>' +
      '<span class="memo-acts">' +
        '<button class="icon-act" type="button" data-mgr="medit" aria-label="编辑" title="编辑">' +
          ICON.pencil + '</button>' +
        '<button class="icon-act danger" type="button" data-mgr="mdel" aria-label="删除" title="删除">' +
          ICON.trash + '</button>' +
      '</span>' +
    '</div>';
  }

  function memosHtml() {
    var meta = MEMO_META[MG.tab] || MEMO_META.note;
    var kind = KIND[MG.tab];
    var list = (MG.memos[kind] || []).slice();
    var head = '<div class="mgr-head"><div class="mgr-head-text">' +
        '<div class="panel-title">' + meta.title + '</div>' +
        '<div class="panel-desc">共 ' + list.length + ' 条 · ' + meta.desc + '</div>' +
      '</div>' +
      '<button class="btn primary" id="mgrNewMemo" type="button" data-mgr="new" data-kind="' + kind + '">' +
        '＋ 新建' + meta.title + '</button></div>';
    if (!list.length) {
      return head + '<div class="mgr-empty">还没有' + meta.title +
        '，点右上角「＋ 新建' + meta.title + '」或右下角 + 开始</div>';
    }
    return head + '<div class="mgr-list">' + list.map(function (m) {
      return memoRowHtml(kind, m);
    }).join('') + '</div>';
  }

  function renderMgr() {
    var el = rootEl();
    /* 重绘会把行内输入框整个换掉。后台 refreshAll（每次写操作后 / 进页时）随时可能来一发，
       若正好赶上用户在行内输入框里打字，焦点和光标就会丢 —— 表现为「打了字按回车没反应」。
       所以重绘前记住「焦点在不在行内输入框、光标在哪」，重绘后再接回去。 */
    var active = document.activeElement;
    var wasEditing = !!(active && active.classList && active.classList.contains('task-inline-name'));
    var wantFocus = !!MG.inline && MG.inlineFocus;
    var caret = null;
    if (wasEditing) {
      try { caret = active.selectionStart; } catch (e) { caret = null; }
    }
    el.innerHTML = MG.loaded
      ? (MG.tab === 'rules' ? rulesHtml() : memosHtml())
      : '<div class="mgr-empty">加载中…</div>';
    renderNav();
    renderChrome();
    if (MG.inline && (wasEditing || wantFocus)) {
      var input = el.querySelector('.task-inline-name');
      if (input) {
        input.focus();
        var pos = caret == null ? input.value.length : Math.min(caret, input.value.length);
        try { input.setSelectionRange(pos, pos); } catch (e) { /* 类型不支持就只恢复焦点 */ }
      }
    }
  }

  /* ---------------------------------------------------------------- 取数 */
  var renderSeq = 0;

  async function refreshAll() {
    var seq = (renderSeq += 1);
    var rules;
    try {
      rules = await T.invoke('list_rules', { includeEnded: true, today: todayKey() });
    } catch (e) {
      renderMgr();
      return;
    }
    if (seq !== renderSeq) return;
    MG.rules = rules || [];
    try {
      var lists = await Promise.all([0, 1, 2].map(function (k) {
        return T.invoke('list_memos', { kind: k });
      }));
      if (seq !== renderSeq) return;
      MG.memos = { 0: lists[0] || [], 1: lists[1] || [], 2: lists[2] || [] };
    } catch (e) { /* memo 读不到就保留旧列表，规则仍可管理 */ }
    MG.loaded = true;
    renderMgr();
  }

  /* 改动之后让月历数据跟上：app.js 的 loadRange 有区间缓存，这里直接拉
     当前月前后各两个月写回它的缓存再重绘（window.Took 暴露了 cache/renderGrid）。 */
  async function syncCalendar() {
    try { await T.loadRules(); } catch (e) {}
    try { await T.loadMemos(); } catch (e) {}
    try {
      var v = T.view();
      var from = ymd(v.y, v.m - 2, 1);
      var to = ymd(v.y, v.m + 2, dim(v.y, v.m + 2));
      var days = await T.invoke('range_grid', { from: from, to: to });
      var cache = T.cache(), memoCache = T.memoCache();
      (days || []).forEach(function (d) {
        cache.set(d.date, d.tasks || []);
        memoCache.set(d.date, d.memos || []);
      });
      T.renderGrid();
    } catch (e) { /* 浏览器兜底（无 Tauri）时只刷新管理页 */ }
  }

  async function afterMutation() {
    await syncCalendar();
    await refreshAll();
  }

  /* ---------------------------------------------------------------- 弹窗壳 */
  function openDialog(title, bodyHtml, footHtml) {
    dlgTitleEl.textContent = title;
    dlgBodyEl.innerHTML = bodyHtml + '<div class="ferr" id="mgrDlgErr" hidden></div>';
    dlgFootEl.innerHTML = footHtml;
    maskEl.hidden = false;
    var first = dlgBodyEl.querySelector('input, textarea');
    if (first) first.focus();
  }
  function closeDialog() {
    maskEl.hidden = true;
    MG.dlg = null;
  }
  function showDlgErr(msg) {
    var el = document.getElementById('mgrDlgErr');
    if (!el) return;
    el.textContent = msg;
    el.hidden = false;
  }
  function field(label, inner) {
    return '<div class="mfield"><label>' + label + '</label>' + inner + '</div>';
  }

  /* 管理页自己的二次确认（app.js 的 #confirmMask 只服务它自己的流程） */
  var confirmResolve = null;
  function askConfirm(title, text, okText) {
    confirmTitleEl.textContent = title;
    confirmTextEl.textContent = text;
    if (confirmOkEl) confirmOkEl.textContent = okText || '确定';
    confirmEl.hidden = false;
    return new Promise(function (resolve) { confirmResolve = resolve; });
  }
  function settleConfirm(value) {
    confirmEl.hidden = true;
    var r = confirmResolve;
    confirmResolve = null;
    if (r) r(value);
  }
  if (confirmOkEl) confirmOkEl.addEventListener('click', function () { settleConfirm(true); });
  document.getElementById('mgrConfirmCancel').addEventListener('click', function () { settleConfirm(false); });
  confirmEl.addEventListener('click', function (e) { if (e.target === confirmEl) settleConfirm(false); });
  document.getElementById('mgrDlgClose').addEventListener('click', closeDialog);
  maskEl.addEventListener('click', function (e) { if (e.target === maskEl) closeDialog(); });

  /* ---------------------------------------------------------- 任务行内编辑 */
  /* 2026-10-27 用户要求：点「＋ 添加任务」不弹模态框，就地展开一行输入框
     （行内编辑 Inline Edit 的体感）。回车保存、Esc 取消；保存后新行原地出现。
     「编辑任务」（行右侧铅笔）走同一条路径 —— 那一行就地变成输入框。 */

  /** 打开行内编辑器。task 为空 = 新建（顶替「＋ 添加任务」按钮）。 */
  function openInlineEditor(rule, task) {
    if (!rule) return;
    MG.expanded[rule.id] = 1;              // 新建时那一行必须在展开的任务区里
    MG.inline = {
      ruleId: rule.id,
      taskId: task ? task.id : null,
      value: task ? task.title : '',
      enabled: task ? !!task.enabled : true
    };
    MG.inlineFocus = true;
    renderMgr();
    var row = mainEl.querySelector('[data-inline-rule="' + rule.id + '"]');
    var input = row ? row.querySelector('.task-inline-name') : null;
    if (input) { input.focus(); input.select(); }
  }

  function closeInlineEditor() {
    if (!MG.inline) return;
    MG.inline = null;
    MG.inlineFocus = false;
    renderMgr();
  }

  function inlineErr(msg) {
    var el = mainEl.querySelector('[data-inline-rule] .task-inline-err');
    if (!el) return;
    el.textContent = msg;
    el.hidden = false;
  }

  /** 把输入框里的现值写回草稿（重绘前调用，避免丢掉用户已打的字）。 */
  function captureInlineInput() {
    var d = MG.inline;
    if (!d) return;
    var input = mainEl.querySelector('[data-inline-rule] .task-inline-name');
    if (input) d.value = input.value;
  }

  async function saveInlineEditor() {
    var d = MG.inline;
    if (!d) return;
    captureInlineInput();
    var name = String(d.value || '').trim();
    if (!name) { inlineErr('任务名不能为空'); return; }
    var rule = findRule(d.ruleId);
    var task = d.taskId && rule
      ? (rule.tasks || []).filter(function (x) { return x.id === d.taskId; })[0]
      : null;
    try {
      if (task) {
        if (name !== task.title) await T.invoke('rename_task', { taskId: task.id, title: name });
        if (d.enabled !== !!task.enabled) {
          await T.invoke('set_task_enabled', { taskId: task.id, enabled: d.enabled });
        }
      } else {
        var created = await T.invoke('add_task', { ruleId: d.ruleId, title: name });
        if (!d.enabled && created && created.id) {
          await T.invoke('set_task_enabled', { taskId: created.id, enabled: false });
        }
      }
    } catch (e) { inlineErr(errText(e)); return; }
    MG.inline = null;                       // 先收起，再刷新（刷新会重绘整页）
    MG.inlineFocus = false;
    await afterMutation();
  }

  /* ---------------------------------------------------------------- memo 弹窗 */
  function openMemoDialog(kind, memo) {
    MG.dlg = { type: 'memo', kind: kind, memo: memo || null };
    var m = memo || { title: '', content: '', start_date: '', end_date: '', category: '' };
    var name = KIND_NAME[kind];
    var body;
    if (kind === 0) {
      body = field('名称', '<input class="inp" id="mgTitle" placeholder="例如：出差安排" value="' + esc(m.title) + '" />') +
        field('日期', '<input class="inp" id="mgStart" type="date" value="' + esc(m.start_date || '') + '" />') +
        field('结束日期', '<input class="inp" id="mgEnd" type="date" value="' + esc(m.end_date || '') + '" />' +
          '<span class="fhint">留空 = 只在开始日当天；两处都留空 = 不排期，只留在列表里。</span>') +
        field('正文', '<textarea class="inp mg-area" id="mgContent" placeholder="记事内容">' + esc(m.content) + '</textarea>');
    } else if (kind === 1) {
      body = field('名称', '<input class="inp" id="mgTitle" placeholder="例如：项目验收" value="' + esc(m.title) + '" />') +
        field('目标日', '<input class="inp" id="mgStart" type="date" value="' + esc(m.start_date || '') + '" />' +
          '<span class="fhint">未来显示「还有 N 天」，过去显示「已经 N 天」。</span>') +
        field('备注', '<textarea class="inp mg-area" id="mgContent" placeholder="可选">' + esc(m.content) + '</textarea>');
    } else {
      body = field('名称', '<input class="inp" id="mgTitle" placeholder="例如：路由器密码" value="' + esc(m.title) + '" />') +
        field('分类', '<input class="inp" id="mgCat" placeholder="未分类" value="' + esc(m.category || '') + '" />') +
        field('正文', '<textarea class="inp mg-area" id="mgContent" placeholder="笔记正文">' + esc(m.content) + '</textarea>');
    }
    var foot = (memo ? '<button class="btn danger" type="button" data-mgr-dlg="del">删除</button>' +
      '<div style="flex:1"></div>' : '') +
      '<button class="btn" type="button" data-mgr-dlg="cancel">取消</button>' +
      '<button class="btn primary" type="button" data-mgr-dlg="save">保存</button>';
    openDialog((memo ? '编辑' : '新建') + name, body, foot);
  }

  async function saveMemoDialog() {
    var d = MG.dlg;
    if (!d || d.type !== 'memo') return;
    var kind = d.kind;
    var val = function (id) { var e = document.getElementById(id); return e ? e.value : ''; };
    var payload = {
      kind: kind,
      title: val('mgTitle').trim(),
      content: val('mgContent'),
      start_date: kind === 2 ? '' : val('mgStart'),
      end_date: kind === 0 ? val('mgEnd') : '',
      category: kind === 2 ? val('mgCat').trim() : ''
    };
    if (d.memo) payload.id = d.memo.id;
    try {
      if (d.memo) await T.invoke('update_memo', { memoJson: JSON.stringify(payload) });
      else await T.invoke('create_memo', { memoJson: JSON.stringify(payload) });
    } catch (e) { showDlgErr(errText(e)); return; }
    closeDialog();
    await afterMutation();
  }

  async function deleteMemoFromDialog() {
    var d = MG.dlg;
    if (!d || d.type !== 'memo' || !d.memo) return;
    var memo = d.memo;
    var ok = await askConfirm('删除' + KIND_NAME[memo.kind],
      memo.kind === 2 ? '将删除该笔记及其正文，删除后不可恢复。'
        : '将删除该' + KIND_NAME[memo.kind] + '，删除后不可恢复。', '删除');
    if (!ok) return;
    try { await T.invoke('delete_memo', { id: memo.id }); }
    catch (e) { showDlgErr(errText(e)); return; }
    closeDialog();
    await afterMutation();
  }

  /* ---------------------------------------------------------------- 动作 */
  async function toggleRuleEnabled(rule, next) {
    /* 走既有 update_rule：重复设置原样回写 → needs_split=false → 原地只改 enabled */
    var payload = {
      id: rule.id, title: rule.title, enabled: next,
      repeat_mode: rule.repeat_mode, weekdays_mask: rule.weekdays_mask,
      repeat_every: rule.repeat_every, month_day: rule.month_day,
      year_month: rule.year_month, year_day: rule.year_day,
      start_date: rule.start_date, end_date: rule.end_date || ''
    };
    try {
      await T.invoke('update_rule', { ruleJson: JSON.stringify(payload), today: todayKey() });
    } catch (e) {
      console.warn('[mgr] 启停规则失败：' + errText(e));
      return;
    }
    await afterMutation();
  }

  async function toggleTaskEnabled(task) {
    try { await T.invoke('set_task_enabled', { taskId: task.id, enabled: !task.enabled }); }
    catch (e) { console.warn('[mgr] 启停任务失败：' + errText(e)); return; }
    await afterMutation();
  }

  async function deleteTaskFlow(task) {
    var ok = await askConfirm('删除任务', '确定删除任务「' + task.title + '」？打卡历史保留。', '删除');
    if (!ok) return;
    try { await T.invoke('delete_task', { taskId: task.id }); }
    catch (e) { console.warn('[mgr] 删除任务失败：' + errText(e)); return; }
    await afterMutation();
  }

  function taskOf(el) {
    var row = el.closest('.task-item');
    var rule = findRule(ruleIdOf(el) || '');
    if (!row || !rule) return null;
    var t = (rule.tasks || []).filter(function (x) { return x.id === row.dataset.task; })[0];
    return t ? { rule: rule, task: t } : null;
  }

  function memoOfRow(el) {
    var row = el.closest('[data-memo]');
    if (!row) return null;
    var kind = KIND[MG.tab];
    var m = findMemo(kind, row.dataset.memo);
    return m ? { kind: kind, memo: m } : null;
  }

  function onMainClick(e) {
    var target = e.target;
    if (!target || !target.closest) return;

    /* 规则的新建 / 编辑 / 删除交给 app.js 自己的处理器（#newRule 与 [data-act]） */
    if (target.closest('#newRule')) return;
    if (target.closest('[data-act="edit"]') || target.closest('[data-act="del"]')) return;

    var el = target.closest('[data-mgr]');
    if (!el) return;
    e.preventDefault();
    e.stopPropagation();

    var act = el.dataset.mgr;
    if (act === 'caret') {
      var id = ruleIdOf(el);
      if (!id) return;
      if (MG.expanded[id]) delete MG.expanded[id]; else MG.expanded[id] = 1;
      renderMgr();
      return;
    }
    if (act === 'switch') {
      var rule = findRule(ruleIdOf(el) || '');
      if (rule) toggleRuleEnabled(rule, !rule.enabled);
      return;
    }
    if (act === 'tswitch') {
      var pair = taskOf(el);
      if (pair) toggleTaskEnabled(pair.task);
      return;
    }
    if (act === 'tedit') {
      /* 编辑任务 = 该行就地变成输入框（同一个行内编辑器） */
      var p2 = taskOf(el);
      if (p2) openInlineEditor(p2.rule, p2.task);
      return;
    }
    if (act === 'tdel') {
      var p3 = taskOf(el);
      if (p3) deleteTaskFlow(p3.task);
      return;
    }
    if (act === 'tadd') {
      /* 「＋ 添加任务」= 在原按钮位置就地展开输入框，不弹模态框 */
      var r2 = findRule(el.dataset.ruleId || '');
      if (r2) openInlineEditor(r2, null);
      return;
    }
    if (act === 'tinlineswitch') {
      captureInlineInput();
      if (MG.inline) MG.inline.enabled = !MG.inline.enabled;
      el.setAttribute('aria-checked', MG.inline && MG.inline.enabled ? 'true' : 'false');
      return;
    }
    if (act === 'tinlinesave') { saveInlineEditor(); return; }
    if (act === 'tinlinecancel') { closeInlineEditor(); return; }
    if (act === 'medit') {
      var mm = memoOfRow(el);
      if (!mm) return;
      // 裁定（2026-10-27）：笔记（kind=2）走 #bookScreen 全屏文档编辑器——原型就是这形态，
      // 且 misc.js 的「⋯菜单 / 思维笔记」只挂在那条路径上，留在弹窗里会够不着。
      // 记事（0）/ 倒数日（1）字段少，留在本文件的轻量弹窗更合适。
      if (mm.kind === 2 && window.TookBook && typeof window.TookBook.open === 'function') {
        window.TookBook.open(mm.memo.id);
        return;
      }
      openMemoDialog(mm.kind, mm.memo);
      return;
    }
    if (act === 'mdel') {
      var mm2 = memoOfRow(el);
      if (mm2) deleteMemoFlow(mm2.kind, mm2.memo);
      return;
    }
    if (act === 'new') {
      openMemoDialog(KIND[MG.tab], null);
    }
  }

  async function deleteMemoFlow(kind, memo) {
    var ok = await askConfirm('删除' + KIND_NAME[kind],
      kind === 2 ? '将删除该笔记及其正文，删除后不可恢复。'
        : '将删除该' + KIND_NAME[kind] + '，删除后不可恢复。', '删除');
    if (!ok) return;
    try { await T.invoke('delete_memo', { id: memo.id }); }
    catch (e) { console.warn('[mgr] 删除失败：' + errText(e)); return; }
    await afterMutation();
  }

  function onMainKey(e) {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    var b = e.target.closest('[data-mgr],[data-act]');
    if (!b || b.tagName === 'INPUT' || b.tagName === 'TEXTAREA') return;
    e.preventDefault();
    b.click();
  }

  mainEl.addEventListener('click', onMainClick, true);
  mainEl.addEventListener('keydown', onMainKey, true);

  navEl.addEventListener('click', function (e) {
    var b = e.target.closest('button[data-tab]');
    if (!b) return;
    MG.tab = b.dataset.tab;
    renderMgr();
    keepFabVisible();
  });

  /* app.js 的旧导航（视觉隐藏，但仍是它 renderNav 的输出）：点它也要切到对应分类，
     这样既有脚本里的 window.__T.nav('note') 仍然有效。 */
  if (legacyNavEl) {
    legacyNavEl.addEventListener('click', function (e) {
      var b = e.target.closest('button[data-tab]');
      if (!b) return;
      var id = b.dataset.tab;
      if (!TABS.some(function (t) { return t.id === id; })) return;
      MG.tab = id;
      setTimeout(function () { renderMgr(); scheduleRefresh(); }, 0);
    });
  }

  /* FAB 的点击：管理页里归本文件（按当前分类新建对应类型）。
     misc.js 也给同一个元素绑了「打开管理页 → 新建规则」，那个只该在日历页生效，
     所以在捕获阶段把管理页里的这次点击截住，不让它传到元素自己的监听器上。 */
  document.addEventListener('click', function (e) {
    if (screenEl.hidden) return;
    if (!e.target.closest || !e.target.closest('#mgrFab')) return;
    e.stopPropagation();
    e.preventDefault();
    if (MG.tab === 'rules') {
      /* 规则的新建走 app.js 的 #newRule 表单（规则有重复/提醒等一整套字段，不是一行能表达的） */
      var b = document.getElementById('newRule');
      if (b) b.click();
      return;
    }
    openMemoDialog(KIND[MG.tab], null);
  }, true);

  /* 可见性：misc.js 的 syncFab 按「日历页可见」同时压 hidden 与 style.display
     （见 misc.js 的注释「管理页里交给 T3 自己那份 #mgrFab 负责」）。
     管理页里必须露出来，所以这里把两者都顶回去；日历页仍由 misc.js 决定。
     style.display 已经是 '' 时再赋值不会产生新的 mutation，不会自激。 */
  function keepFabVisible() {
    if (screenEl.hidden) return;
    if (fabEl.hidden) fabEl.hidden = false;
    if (fabEl.style.display === 'none') fabEl.style.display = '';
    if (fabEl.parentNode && fabEl.parentNode !== document.body) document.body.appendChild(fabEl);
  }
  new MutationObserver(keepFabVisible).observe(fabEl, {
    attributes: true, attributeFilter: ['hidden', 'style'],
  });

  dlgFootEl.addEventListener('click', function (e) {
    var b = e.target.closest('[data-mgr-dlg]');
    if (!b) return;
    var act = b.dataset.mgrDlg;
    if (act === 'cancel') { closeDialog(); return; }
    if (act === 'save') { saveMemoDialog(); return; }
    if (act === 'del') deleteMemoFromDialog();
  });
  /* 行内编辑器的键盘语义：回车保存、Esc 取消（照用户要求）。
     input 事件把已打的字写回草稿，重绘（例如别处触发 refreshAll）不会把输入吃掉。 */
  mainEl.addEventListener('input', function (e) {
    var input = e.target.closest('.task-inline-name');
    if (!input || !MG.inline) return;
    MG.inline.value = input.value;
  }, true);
  mainEl.addEventListener('keydown', function (e) {
    if (!e.target.closest('.task-inline-name')) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      saveInlineEditor();
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeInlineEditor();
    }
  }, true);

  /* Esc：先关行内编辑器，再关本页的弹窗，关完才轮到 app.js 关整页 */
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    if (MG.inline) { closeInlineEditor(); e.preventDefault(); e.stopPropagation(); return; }
    if (!maskEl.hidden) { closeDialog(); e.preventDefault(); e.stopPropagation(); return; }
    if (!confirmEl.hidden) { settleConfirm(false); e.preventDefault(); e.stopPropagation(); }
  }, true);

  /* ---------------------------------------------------------------- 与 app.js 的同步 */
  /* app.js 进页 / 每次写操作之后都会重写 #configMain 的 innerHTML（把 #mgrRoot 一起
     冲掉）：发现 #mgrRoot 不在了就重新挂上并重拉数据。 */
  var pendingRender = 0;
  function scheduleRefresh() {
    if (pendingRender) return;
    pendingRender = setTimeout(function () {
      pendingRender = 0;
      if (screenEl.hidden) return;
      refreshAll();
    }, 0);
  }

  /* app.js 写进来的旧标记一律留在 DOM 里（style.css 只把它视觉隐藏）：
     既有回归脚本按 #configMain .rule-row / .rule-count / #newRule / [data-act]
     这些选择器定位，app.js 自己的委托处理器也靠它们工作。
     本文件的 UI 用 .mgr-row / .mgr-count 这类不同的类名，两者不互相干扰。 */
  function mount() {
    if (!mainEl.querySelector('#mgrRoot')) renderMgr();
    keepFabVisible();
  }

  new MutationObserver(function () {
    if (screenEl.hidden) return;
    mount();
    scheduleRefresh();
  }).observe(mainEl, { childList: true });

  new MutationObserver(function () {
    if (screenEl.hidden) {
      closeDialog();
      if (!confirmEl.hidden) settleConfirm(false);
      return;
    }
    MG.tab = 'rules';
    renderMgr();
    scheduleRefresh();
  }).observe(screenEl, { attributes: true, attributeFilter: ['hidden'] });

  renderNav();
  renderChrome();
})();
