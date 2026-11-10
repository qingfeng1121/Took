/* 非 Tauri 环境的兜底数据源（浏览器直接打开 index.html 时生效）。
   这里是 Rust engine.rs + db.rs 的逐条移植：同样的 4 条规则 / 5 个任务 /
   同一套种子打卡，同样的命中判定与周期归属，所以文件协议里看到的月历与
   Tauri 窗口里的一致。Tauri 环境下 app.js 优先走真命令，不会用到这里。 */
(function (global) {
  'use strict';

  const pad2 = n => String(n).padStart(2, '0');
  const toKey = (y, m, d) => `${y}-${pad2(m)}-${pad2(d)}`;
  function parseKey(key) {
    return { y: +key.slice(0, 4), m: +key.slice(5, 7), d: +key.slice(8, 10) };
  }
  const isLeapYear = y => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  function daysInMonth(y, m) { return m === 2 && isLeapYear(y) ? 29 : MONTH_DAYS[m - 1]; }

  /* 连续日序数：纯公历分量推算，不经过时间戳（契约 §3.4） */
  function daySerial(key) {
    const { y, m, d } = parseKey(key);
    const a = Math.floor((14 - m) / 12);
    const yy = y + 4800 - a;
    const mm = m + 12 * a - 3;
    const jdn = d + Math.floor((153 * mm + 2) / 5) + 365 * yy +
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
  const addDaysKey = (key, n) => keyFromSerial(daySerial(key) + n);
  const diffDays = (a, b) => daySerial(b) - daySerial(a);
  const weekdayIndex = key => (((daySerial(key) + 3) % 7) + 7) % 7; // 周一 = 0

  function monthTargetDay(monthDay, y, m) {
    const dim = daysInMonth(y, m);
    if (monthDay === -1) return dim;
    return Math.min(monthDay, dim);
  }

  /* 与 Go ensureSeed / Rust seed_if_empty 完全一致的种子 */
  const RULES = [
    { id: 'r_work', title: '工作日常规', enabled: true, repeat_mode: 0, weekdays_mask: 31,
      repeat_every: 0, month_day: 0, year_month: 0, year_day: 0, start_date: '2026-10-01',
      end_date: '', repeat_until: '',
      tasks: [{ id: 't_fit', rule_id: 'r_work', title: '健身', enabled: true, sort_order: 0 },
              { id: 't_early', rule_id: 'r_work', title: '早起', enabled: true, sort_order: 1 }] },
    { id: 'r_words', title: '单词打卡', enabled: true, repeat_mode: 1, weekdays_mask: 0,
      repeat_every: 1, month_day: 0, year_month: 0, year_day: 0, start_date: '2026-10-01',
      end_date: '', repeat_until: '',
      tasks: [{ id: 't_words', rule_id: 'r_words', title: '背单词', enabled: true, sort_order: 0 }] },
    { id: 'r_rent', title: '房租', enabled: true, repeat_mode: 2, weekdays_mask: 0,
      repeat_every: 0, month_day: 20, year_month: 0, year_day: 0, start_date: '2026-01-01',
      end_date: '', repeat_until: '',
      tasks: [{ id: 't_rent', rule_id: 'r_rent', title: '交房租', enabled: true, sort_order: 0 }] },
    { id: 'r_med', title: '年度体检', enabled: true, repeat_mode: 3, weekdays_mask: 0,
      repeat_every: 0, month_day: 0, year_month: 3, year_day: 15, start_date: '2026-01-01',
      end_date: '', repeat_until: '',
      tasks: [{ id: 't_med', rule_id: 'r_med', title: '体检', enabled: true, sort_order: 0 }] },
  ];

  /* 与 Rust 侧 ORDER BY start_date, title 同序，保证两端的任务排列一致 */
  const ORDERED = RULES.slice().sort((a, b) => {
    if (a.start_date !== b.start_date) return a.start_date < b.start_date ? -1 : 1;
    if (a.title !== b.title) return a.title < b.title ? -1 : 1;
    return 0;
  });

  /* 种子打卡：本周（2026-10-19 起）的「健身」已完成 */
  const DONE = new Set(['t_fit:2026-10-19']);

  /* 浏览器兜底没有后端：同步状态只做展示，dirty 数由本地打卡估算，
     last_error 明说不会真发请求（不假装有功能） */
  const SYNC = {
    url: 'http://127.0.0.1:8420',
    last_sync_at: 0,
    dirty: 0,
    last_error: '浏览器兜底模式：不会真的发同步请求',
    last_pulled_rev: 0,
  };

  /* 契约 §3.2 */
  function occursOn(rule, date) {
    if (date < rule.start_date) return false;
    const upper = rule.repeat_until || rule.end_date;
    if (upper && date > upper) return false;
    switch (rule.repeat_mode) {
      case 0: return (rule.weekdays_mask & (1 << weekdayIndex(date))) !== 0;
      case 1: {
        const step = rule.repeat_every;
        if (step < 1) return false;
        const gap = diffDays(rule.start_date, date);
        return gap >= 0 && gap % step === 0;
      }
      case 2: {
        const p = parseKey(date);
        return p.d === monthTargetDay(rule.month_day, p.y, p.m);
      }
      case 3: {
        const p = parseKey(date);
        if (p.m !== rule.year_month) return false;
        const last = daysInMonth(p.y, p.m);
        return p.d === Math.min(rule.year_day, last);
      }
      case 4: return date === rule.start_date;
      default: return false;
    }
  }

  /* 契约 §3.3 */
  function periodStartOf(rule, date) {
    if (rule.repeat_mode === 0) return addDaysKey(date, -weekdayIndex(date));
    if (rule.repeat_mode === 1) {
      if (rule.repeat_every < 1) throw new Error('repeat_every 必须 >= 1');
      const gap = diffDays(rule.start_date, date);
      if (gap < 0) throw new Error('日期早于规则起始日');
      const step = rule.repeat_every;
      return addDaysKey(rule.start_date, Math.floor(gap / step) * step);
    }
    return date;
  }

  /* ---------- 记事 / 倒数日 / 笔记本（契约 §10）：与 Rust db.rs 同语义 ---------- */
  const MEMO_NOTE = 0, MEMO_COUNTDOWN = 1, MEMO_NOTEBOOK = 2;
  const MEMO_CAT_NONE = '未分类';
  /* 浏览器兜底不带种子 memo：新库本来就该是空的，界面靠用户自己新建 */
  const MEMOS = [];

  /* ---------- 提醒（契约 §11）：与 Rust db.rs 同语义 ----------
     REMINDER_OWNER 与 memo.kind 不是一套编号：reminder.owner_kind 0=规则 1=记事 2=倒数日。 */
  const REMINDERS = [];
  const REMINDER_RULE = 0, REMINDER_NOTE = 1, REMINDER_COUNTDOWN = 2;
  const reminderOwnerOfMemo = function (kind) {
    if (kind === MEMO_NOTE) return REMINDER_NOTE;
    if (kind === MEMO_COUNTDOWN) return REMINDER_COUNTDOWN;
    return null;
  };
  const hhmmOk = function (s) {
    if (!/^\d{2}:\d{2}$/.test(s)) return false;
    return Number(s.slice(0, 2)) <= 23 && Number(s.slice(3, 5)) <= 59;
  };
  /* 列表摘要：与 Rust reminder_summary 同序（通知在前、闹钟在后，共用 time_of_day） */
  function reminderSummaryOf(row) {
    if (!row || row.deleted || !row.enabled || !row.time_of_day) return '';
    const parts = [];
    if (row.notify_on) parts.push('通知 ' + row.time_of_day);
    if (row.alarm_on) parts.push('闹钟 ' + row.time_of_day);
    return parts.join(' + ');
  }
  const reminderOfOwner = function (kind, id) {
    return REMINDERS.find(function (r) { return r.owner_kind === kind && r.owner_id === id && !r.deleted; }) || null;
  };
  function validateReminder(input) {
    const ownerKind = Number(input.owner_kind);
    if (![REMINDER_RULE, REMINDER_NOTE, REMINDER_COUNTDOWN].includes(ownerKind)) {
      throw new Error('reminder.owner_kind 必须是 0/1/2，实际 ' + input.owner_kind);
    }
    if (!String(input.owner_id || '').trim()) throw new Error('reminder.owner_id 不能为空');
    const notify = Number(input.notify_on) === 1 ? 1 : 0;
    const alarm = Number(input.alarm_on) === 1 ? 1 : 0;
    // 墓碑豁免「至少开一个」（契约 §11.1）：删除时先把开关清零再打删除标记是正常路径
    if (Number(input.deleted) !== 1 && !notify && !alarm) {
      throw new Error('提醒至少要开一个通道（通知或闹钟）：两个开关都为 0 是非法状态，想不提醒请软删这一行或置 enabled=0');
    }
    if (!hhmmOk(String(input.time_of_day || '').trim())) {
      throw new Error('提醒时间必须是 HH:mm（00:00~23:59），实际 "' + input.time_of_day + '"');
    }
    const text = String(input.notify_text || '').trim();
    if (Array.from(text).length > 60) throw new Error('通知文案最多 60 字');
    const offset = Number(input.offset_days || 0);
    if (offset < -30 || offset > 30) throw new Error('offset_days 必须在 -30..30，实际 ' + offset);
    const snooze = Number(input.snooze_min || 0);
    if (snooze < 0 || snooze > 60) throw new Error('snooze_min 必须在 0..60，实际 ' + snooze);
  }
  function getReminder(ownerKind, ownerId) {
    const row = reminderOfOwner(Number(ownerKind), String(ownerId || ''));
    return row ? Object.assign({}, row) : null;
  }
  function saveReminder(input) {
    validateReminder(input);
    const ownerKind = Number(input.owner_kind);
    const ownerId = String(input.owner_id || '').trim();
    const existing = reminderOfOwner(ownerKind, ownerId);
    const id = (existing && existing.id) || String(input.id || '').trim() || ('rm_' + ownerKind + '_' + ownerId);
    const rec = {
      id: id, owner_kind: ownerKind, owner_id: ownerId,
      notify_on: Number(input.notify_on) === 1 ? 1 : 0,
      alarm_on: Number(input.alarm_on) === 1 ? 1 : 0,
      time_of_day: String(input.time_of_day || '').trim(),
      notify_text: String(input.notify_text || '').trim(),
      offset_days: Number(input.offset_days || 0),
      repeat_rule: Number(input.repeat_rule) === 1 ? 1 : 0,
      snooze_min: Number(input.snooze_min || 0),
      enabled: Number(input.enabled) === 0 ? 0 : 1,
      rev: existing ? existing.rev : 0, updated_at: nowMs(), deleted: 0, dirty: 1,
    };
    if (existing) REMINDERS.splice(REMINDERS.indexOf(existing), 1, rec);
    else REMINDERS.push(rec);
    SYNC.dirty += 1;
    return id;
  }
  function clearReminder(ownerKind, ownerId) {
    const kind = Number(ownerKind);
    if (![REMINDER_RULE, REMINDER_NOTE, REMINDER_COUNTDOWN].includes(kind)) {
      throw new Error('reminder.owner_kind 必须是 0/1/2，实际 ' + ownerKind);
    }
    const row = reminderOfOwner(kind, String(ownerId || ''));
    if (row) { row.deleted = 1; row.updated_at = nowMs(); row.dirty = 1; SYNC.dirty += 1; }
    return null;
  }

  const memoCategory = function (kind, raw) {
    if (kind !== MEMO_NOTEBOOK) return '';
    const t = String(raw || '').trim();
    return t || MEMO_CAT_NONE;
  };

  /* 契约 §10.1：不排期 = 永不出现；只有 start = 单日；两者都有 = 区间内每天 */
  function memoActiveOn(m, date) {
    if (!m || m.kind !== MEMO_NOTE || m.deleted) return false;
    if (!m.start_date || date < m.start_date) return false;
    if (!m.end_date || m.end_date === m.start_date) return date === m.start_date;
    return date <= m.end_date;
  }

  function memoDateOk(s) {
    if (!s) return true;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    const p = parseKey(s);
    return p.m >= 1 && p.m <= 12 && p.d >= 1 && p.d <= daysInMonth(p.y, p.m);
  }

  function validateMemo(input) {
    const kind = Number(input.kind);
    if (![0, 1, 2].includes(kind)) throw new Error('memo.kind 必须是 0/1/2，实际 ' + input.kind);
    const title = String(input.title || '').trim();
    const start = String(input.start_date || '').trim();
    const end = String(input.end_date || '').trim();
    const content = String(input.content || '').trim();
    if (kind === MEMO_NOTE) {
      if (!title) throw new Error('记事标题不能为空');
      if (!memoDateOk(start)) throw new Error('记事的开始日期必须是 YYYY-MM-DD：' + start);
      if (!memoDateOk(end)) throw new Error('记事的结束日期必须是 YYYY-MM-DD：' + end);
      if (end && !start) throw new Error('记事填了结束日期就必须同时填开始日期');
      if (start && end && end < start) throw new Error('记事的结束日期不能早于开始日期：' + end + ' < ' + start);
      return;
    }
    if (kind === MEMO_COUNTDOWN) {
      if (!title) throw new Error('倒数日标题不能为空');
      if (!start) throw new Error('倒数日必须填目标日（start_date）');
      if (!memoDateOk(start)) throw new Error('倒数日的目标日必须是 YYYY-MM-DD：' + start);
      if (end) throw new Error('倒数日没有结束日期');
      return;
    }
    if (!title && !content) throw new Error('笔记本标题与正文不能都为空');
    if (start || end) throw new Error('笔记本没有日期，不会进月历');
  }

  function listMemos(kind) {
    const k = (kind === undefined || kind === null) ? null : Number(kind);
    return MEMOS.filter(function (m) { return !m.deleted && (k === null || m.kind === k); })
      .slice()
      .sort(function (a, b) { return (a.kind - b.kind) || (a.updated_at - b.updated_at); })
      .map(function (m) {
        const owner = reminderOwnerOfMemo(m.kind);
        return Object.assign({}, m, {
          reminder_summary: owner === null ? '' : reminderSummaryOf(reminderOfOwner(owner, m.id)),
        });
      });
  }

  function createMemo(input) {
    validateMemo(input);
    const id = String(input.id || '').trim() || genId('m');
    if (MEMOS.some(function (m) { return m.id === id; })) throw new Error('memo id 已存在：' + id);
    const rec = {
      id: id, kind: Number(input.kind), title: String(input.title || '').trim(),
      content: String(input.content || '').trim(),
      start_date: String(input.start_date || '').trim(),
      end_date: String(input.end_date || '').trim(),
      category: memoCategory(Number(input.kind), input.category),
      rev: 0, updated_at: nowMs(), deleted: 0, dirty: 1,
    };
    MEMOS.push(rec);
    SYNC.dirty += 1;
    return id;
  }

  function updateMemo(input) {
    validateMemo(input);
    const id = String(input.id || '').trim();
    if (!id) throw new Error('update_memo 需要 memo id');
    const m = MEMOS.find(function (x) { return x.id === id && !x.deleted; });
    if (!m) throw new Error('memo 不存在或已删除：' + id);
    m.kind = Number(input.kind);
    m.title = String(input.title || '').trim();
    m.content = String(input.content || '').trim();
    m.start_date = String(input.start_date || '').trim();
    m.end_date = String(input.end_date || '').trim();
    m.category = memoCategory(m.kind, input.category);
    m.updated_at = nowMs();
    m.dirty = 1;
    SYNC.dirty += 1;
  }

  function deleteMemo(id) {
    const m = MEMOS.find(function (x) { return x.id === id && !x.deleted; });
    if (!m) throw new Error('memo 不存在或已删除：' + id);
    m.deleted = 1;
    m.updated_at = nowMs();
    m.dirty = 1;
    SYNC.dirty += 1;
  }

  /* 某一天的展开（month_grid 与 toggle_done 共用，口径必须一致） */
  function dayOf(date) {
    const memos = MEMOS.filter(function (m) { return memoActiveOn(m, date); })
      .map(function (m) {
        return { id: m.id, title: m.title, start_date: m.start_date, end_date: m.end_date };
      });
    const tasks = [];
    ORDERED.forEach(rule => {
      if (rule.deleted || !rule.enabled || !occursOn(rule, date)) return;
      let period;
      try { period = periodStartOf(rule, date); } catch (_) { return; }
      rule.tasks.forEach(t => {
        if (t.deleted || !t.enabled) return;
        tasks.push({
          task_id: t.id, title: t.title, rule_id: rule.id, rule_title: rule.title,
          period_start: period,
          done: DONE.has(t.id + ':' + period),
        });
      });
    });
    return { date, tasks, memos };
  }

  /* 任意区间逐日展开（与 Rust range_grid 同口径）：滚动月历一次要连续多个月的周 */
  function rangeGrid(from, to) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
      throw new Error('日期必须是 YYYY-MM-DD：' + from + ' ~ ' + to);
    }
    if (to < from) throw new Error('区间起止颠倒：' + from + ' ~ ' + to);
    const days = [];
    let k = from;
    let guard = 0;
    while (k <= to) {
      days.push(dayOf(k));
      k = addDaysKey(k, 1);
      if (++guard > 4000) throw new Error('区间过大（上限 4000 天）：' + from + ' ~ ' + to);
    }
    return days;
  }

  function monthGrid(y, m) {
    const total = daysInMonth(y, m);
    const days = [];
    for (let d = 1; d <= total; d++) days.push(dayOf(toKey(y, m, d)));
    return { year: y, month: m, days };
  }

  function listRules(includeEnded, today) {
    const t = today || todayKey();
    return ORDERED.filter(function (r) { return !r.deleted; })
      .filter(function (r) { return includeEnded || !endedOf(r, t); })
      .map(function (r) {
        return Object.assign({}, r, {
          ended: endedOf(r, t),
          reminder_summary: reminderSummaryOf(reminderOfOwner(REMINDER_RULE, r.id)),
          tasks: (r.tasks || []).filter(function (x) { return !x.deleted; })
            .map(function (x) { return Object.assign({}, x); }),
        });
      });
  }

  /* 打卡写路径的浏览器版：与 Rust toggle_done 同样的语义
     （写 (task_id, period_start)、刷新 updated_at、dirty+1、rev 保持） */
  function toggleDone(taskId, periodStart, done) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(periodStart)) throw new Error('period_start 必须是 YYYY-MM-DD：' + periodStart);
    const task = findTask(taskId);
    if (!task || !task.enabled) throw new Error('任务不存在或已删除：' + taskId);
    const key = taskId + ':' + periodStart;
    if (done) DONE.add(key); else DONE.delete(key);
    if (!SYNC.dirty) SYNC.dirty = 0;
    SYNC.dirty += 1;
    return {
      task_id: taskId, period_start: periodStart, done: done,
      rev: 0, updated_at: Date.now(), dirty: true, day: dayOf(periodStart),
    };
  }

  /* ---------- 写路径（契约 §9）：与 Rust db.rs 逐条同语义，供浏览器兜底自测 ---------- */
  let SEQ = 0;
  const nowMs = function () { return Date.now(); };
  const genId = function (p) { return p + '_' + Date.now().toString(16) + (SEQ++).toString(16); };
  function todayKey() { const d = new Date(); return toKey(d.getFullYear(), d.getMonth() + 1, d.getDate()); }
  /* 与 db.rs 的 needs_split 同一口径：按当前 repeat_mode 只比相关字段，
     repeat_mode 与 start_date 另算（与 Android 端一致） */
  const SPLIT_FIELDS_BY_MODE = {
    0: ['weekdays_mask'],
    1: ['repeat_every'],
    2: ['month_day'],
    3: ['year_month', 'year_day'],
    4: []
  };
  function needsSplit(cur, next) {
    if (cur.repeat_mode !== next.repeat_mode) return true;
    if (cur.start_date !== next.start_date) return true;
    return (SPLIT_FIELDS_BY_MODE[Number(next.repeat_mode)] || []).some(function (k) { return cur[k] !== next[k]; });
  }

  function resort() {
    const sorted = RULES.slice().sort(function (a, b) {
      if (a.start_date !== b.start_date) return a.start_date < b.start_date ? -1 : 1;
      if (a.title !== b.title) return a.title < b.title ? -1 : 1;
      return 0;
    });
    ORDERED.length = 0;
    sorted.forEach(function (r) { ORDERED.push(r); });
  }
  function ruleById(id) {
    return RULES.find(function (r) { return r.id === id && !r.deleted; }) || null;
  }
  function findTask(taskId) {
    for (let i = 0; i < RULES.length; i += 1) {
      const r = RULES[i];
      if (r.deleted) continue;
      const t = (r.tasks || []).find(function (x) { return x.id === taskId && !x.deleted; });
      if (t) return t;
    }
    return null;
  }
  const upperOf = function (r) { return r.repeat_until || r.end_date || ''; };
  const endedOf = function (r, today) { const u = upperOf(r); return !!u && u < today; };

  function validateRule(rule) {
    if (!rule || !String(rule.title || '').trim()) throw new Error('规则名称不能为空');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(rule.start_date || ''))) {
      throw new Error('开始日期必须是 YYYY-MM-DD：' + rule.start_date);
    }
    if (rule.end_date && !/^\d{4}-\d{2}-\d{2}$/.test(rule.end_date)) throw new Error('结束日期必须是 YYYY-MM-DD：' + rule.end_date);
    if (rule.repeat_mode === 0 && !(rule.weekdays_mask > 0 && rule.weekdays_mask <= 127)) throw new Error('每周重复至少要选一天（weekdays_mask 1..127）');
    if (rule.repeat_mode === 1 && !(rule.repeat_every >= 1 && rule.repeat_every <= 3660)) throw new Error('每 N 天的 N 必须在 1..3660');
    if (rule.repeat_mode === 2 && !(rule.month_day === -1 || (rule.month_day >= 1 && rule.month_day <= 31))) throw new Error('每月某日必须是 1..31 或 -1');
    if (rule.repeat_mode === 3 && !(rule.year_month >= 1 && rule.year_month <= 12)) throw new Error('每年重复的月份必须在 1..12');
    if (rule.repeat_mode === 3 && !(rule.year_day >= 1 && rule.year_day <= 31)) throw new Error('每年重复的日必须在 1..31');
  }

  function createRule(rule, tasks) {
    validateRule(rule);
    const titles = (tasks || []).map(function (t) { return String(t).trim(); }).filter(Boolean);
    if (!titles.length) throw new Error('一条规则至少要有一个任务（契约 §9.1）');
    const id = rule.id ? String(rule.id).trim() : genId('r');
    if (RULES.some(function (r) { return r.id === id; })) throw new Error('规则 id 已存在：' + id);
    const rec = {
      id: id, title: rule.title, enabled: rule.enabled !== false,
      repeat_mode: rule.repeat_mode, weekdays_mask: rule.weekdays_mask || 0,
      repeat_every: rule.repeat_every || 0, month_day: rule.month_day || 0,
      year_month: rule.year_month || 0, year_day: rule.year_day || 0,
      start_date: rule.start_date, end_date: rule.end_date || '', repeat_until: '',
      tasks: titles.map(function (t, i) {
        return { id: genId('t'), rule_id: id, title: t, enabled: true, sort_order: i };
      }),
    };
    RULES.push(rec);
    resort();
    return id;
  }

  function updateRule(rule, today) {
    validateRule(rule);
    const cur = ruleById(rule.id);
    if (!cur) throw new Error('规则不存在或已删除：' + rule.id);
    const split = needsSplit(cur, rule);
    if (!split) {
      cur.title = rule.title;
      cur.enabled = !!rule.enabled;
      cur.end_date = rule.end_date || '';
      cur.updated_at = nowMs();
      resort();
      return { split: false, old_rule_id: cur.id, new_rule_id: null, old_repeat_until: cur.repeat_until || '' };
    }
    const todayK = today || todayKey();
    const upper = upperOf(cur);
    if (upper && upper < todayK) {
      throw new Error('规则「' + cur.title + '」已于 ' + upper + ' 结束，重复设置不可再改；要换设置请新建一条规则');
    }
    const yesterday = addDaysKey(todayK, -1);
    const newId = rule.new_id ? String(rule.new_id) : genId('r');
    if (newId === cur.id) throw new Error('新规则 id 不能与旧规则相同');
    if (RULES.some(function (r) { return r.id === newId; })) throw new Error('新规则 id 已存在，已停止裂开以免重复：' + newId);
    const oldUntil = (!upper || upper >= yesterday) ? yesterday : upper;
    if (oldUntil === yesterday) cur.repeat_until = yesterday;
    cur.updated_at = nowMs();
    RULES.push({
      id: newId, title: rule.title, enabled: rule.enabled !== false,
      repeat_mode: rule.repeat_mode, weekdays_mask: rule.weekdays_mask || 0,
      repeat_every: rule.repeat_every || 0, month_day: rule.month_day || 0,
      year_month: rule.year_month || 0, year_day: rule.year_day || 0,
      start_date: todayK, end_date: rule.end_date || '', repeat_until: '',
      tasks: [],
    });
    resort();
    return { split: true, old_rule_id: cur.id, new_rule_id: newId, old_repeat_until: oldUntil };
  }

  function deleteRule(id) {
    const r = ruleById(id);
    if (!r) throw new Error('规则不存在或已删除：' + id);
    r.deleted = 1;
    let n = 0;
    (r.tasks || []).forEach(function (t) { if (!t.deleted) { t.deleted = 1; n += 1; } });
    // 提醒随规则一起软删（契约 §9.3）：否则留下指向已删规则的孤儿行
    clearReminder(REMINDER_RULE, id);
    return { rule_id: id, tasks_deleted: n };
  }

  function addTask(ruleId, title) {
    const r = ruleById(ruleId);
    if (!r) throw new Error('规则不存在或已删除：' + ruleId);
    const s = String(title || '').trim();
    if (!s) throw new Error('任务名不能为空');
    const sort = (r.tasks || []).reduce(function (m, x) { return Math.max(m, x.sort_order); }, -1) + 1;
    const task = { id: genId('t'), rule_id: ruleId, title: s, enabled: true, sort_order: sort };
    if (!r.tasks) r.tasks = [];
    r.tasks.push(task);
    return Object.assign({}, task);
  }

  function renameTask(taskId, title) {
    const t = findTask(taskId);
    if (!t) throw new Error('任务不存在或已删除：' + taskId);
    const s = String(title || '').trim();
    if (!s) throw new Error('任务名不能为空');
    t.title = s;
  }

  function setTaskEnabled(taskId, enabled) {
    const t = findTask(taskId);
    if (!t) throw new Error('任务不存在或已删除：' + taskId);
    t.enabled = !!enabled;
  }

  function deleteTask(taskId) {
    const t = findTask(taskId);
    if (!t) throw new Error('任务不存在或已删除：' + taskId);
    t.deleted = 1;
  }

  /* 窗口外观的浏览器兜底状态：只在页面内保存，不会真的改窗口。
     存在的意义是让设置页在浏览器里也能渲染出真实控件（verify.cjs 走这条路），
     同时状态里带 error 说明「浏览器里不生效」，不伪造成功。 */
  const MOCK_CHROME = {
    opacity: 100,
    snap_edge: 'none',
    snap_auto_hide: false,
    collapsed: false,
  };
  /* 固定方式（贴壁纸 / 置顶 / 普通）。浏览器里没有 Win32，三种都做不到 ——
     状态本身仍然维护，是为了让按钮与设置页能在浏览器里渲染出真实控件（verify.cjs 走这条路），
     同时 always_on_top 恒为 false 且贴壁纸层恒为 Disabled，不伪造「已经置顶了」。 */
  const MOCK_PIN = { mode: 'normal' };
  const PIN_LABEL = { wallpaper: '贴壁纸', top: '置顶', normal: '普通' };
  const MOCK_WALLPAPER = {
    enabled: false, mode: 'Disabled',
    detail: '浏览器兜底没有 Win32，贴壁纸层是 Tauri 专有能力（此页只显示真实状态）',
    host: 0, host_class: '', parent: 0, is_child: false,
  };
  function mockPinStatus() {
    return {
      mode: MOCK_PIN.mode,
      label: PIN_LABEL[MOCK_PIN.mode] || '普通',
      always_on_top: false,
      wallpaper: Object.assign({}, MOCK_WALLPAPER),
    };
  }
  function mockChromeStatus() {
    return {
      opacity: MOCK_CHROME.opacity,
      alpha: -1,
      snap_edge: MOCK_CHROME.snap_edge,
      snap_auto_hide: MOCK_CHROME.snap_auto_hide,
      collapsed: MOCK_CHROME.collapsed,
      rect: [],
      snap_threshold: 20,
      error: '浏览器兜底没有 Win32：窗口透明度 / 吸附 / 收起只在 Tauri 里生效',
    };
  }

  global.TookMock = {
    monthGrid,
    listRules,
    toggleDone,
    createRule,
    updateRule,
    deleteRule,
    addTask,
    renameTask,
    setTaskEnabled,
    deleteTask,
    listMemos,
    getReminder,
    saveReminder,
    clearReminder,
    createMemo,
    updateMemo,
    deleteMemo,
    MEMO_NOTE,
    MEMO_COUNTDOWN,
    MEMO_NOTEBOOK,
    MEMO_CAT_NONE,
    // 便于自测的纯函数
    _internal: { occursOn, periodStartOf, addDaysKey, weekdayIndex, daysInMonth, toKey, dayOf, rangeGrid },
    // 与 Tauri invoke 对齐的异步形态（参数名走 Tauri 的 camelCase 约定）
    invoke: async (cmd, args) => {
      if (cmd === 'month_grid') return monthGrid(args.y, args.m);
      if (cmd === 'range_grid') return rangeGrid(args.from, args.to);
      if (cmd === 'list_rules') return listRules(!!args.includeEnded, args.today);
      if (cmd === 'create_rule') return createRule(JSON.parse(args.ruleJson), args.tasks);
      if (cmd === 'update_rule') return updateRule(JSON.parse(args.ruleJson), args.today);
      if (cmd === 'delete_rule') return deleteRule(args.id);
      if (cmd === 'add_task') return addTask(args.ruleId, args.title);
      if (cmd === 'rename_task') return renameTask(args.taskId, args.title);
      if (cmd === 'set_task_enabled') return setTaskEnabled(args.taskId, args.enabled);
      if (cmd === 'delete_task') return deleteTask(args.taskId);
      if (cmd === 'toggle_done') return toggleDone(args.taskId, args.periodStart, args.done);
      if (cmd === 'list_memos') return listMemos(args.kind);
      if (cmd === 'create_memo') return createMemo(JSON.parse(args.memoJson));
      if (cmd === 'update_memo') return updateMemo(JSON.parse(args.memoJson));
      if (cmd === 'delete_memo') return deleteMemo(args.id);
      if (cmd === 'get_reminder') return getReminder(args.ownerKind, args.ownerId);
      if (cmd === 'save_reminder') return saveReminder(JSON.parse(args.reminderJson));
      if (cmd === 'clear_reminder') return clearReminder(args.ownerKind, args.ownerId);
      // 浏览器兜底：调度是 Tauri 的后台线程，浏览器里没有。
      // 这里**如实**返回「未启动」，不伪造在跑 —— 否则前端的「后台线程在跑」就是假的。
      if (cmd === 'reminder_status') {
        return {
          scheduled: 0, next_fire_at: 0, next_fire_text: '', next_fire_title: '',
          last_error: '浏览器兜底没有后台调度线程（这是 Tauri 专有）',
          last_fired_at: 0, last_fired_text: '', last_fired_title: '', fired_count: 0,
          thread_alive: false, notify_ok: false, ringing: 0, tick_secs: 30, sound_playing: false,
        };
      }
      if (cmd === 'reminder_upcoming') return [];
      // 浏览器里没有 Win32，贴壁纸天然做不到 —— 如实返回 Disabled，不伪造成功
      if (cmd === 'wallpaper_status') {
        return {
          enabled: false, mode: 'Disabled',
          detail: '浏览器兜底没有 Win32，贴壁纸层是 Tauri 专有能力（此页只显示真实状态）',
          host: 0, host_class: '', parent: 0, is_child: false,
        };
      }
      if (cmd === 'set_wallpaper_preset') {
        return {
          enabled: false, mode: 'Disabled',
          detail: '浏览器兜底没有 Win32，贴壁纸层是 Tauri 专有能力',
          host: 0, host_class: '', parent: 0, is_child: false,
        };
      }
      if (cmd === 'set_wallpaper_pin') {
        // 开关就是固定方式的两个取值：开 = 贴壁纸，关 = 普通（与后端 apply_wallpaper_pin 一致）
        MOCK_PIN.mode = args.on ? 'wallpaper' : 'normal';
        return {
          enabled: false, mode: 'Disabled',
          detail: '浏览器兜底没有 Win32，贴壁纸层是 Tauri 专有能力',
          host: 0, host_class: '', parent: 0, is_child: false,
        };
      }
      // 窗口外观三件事都是 Win32 / Tauri 专有能力，浏览器里如实返回「未生效」，
      // 不伪造成功 —— 否则验收脚本会在浏览器里「通过」而真机是坏的。
      if (cmd === 'window_chrome_status') {
        return {
          opacity: MOCK_CHROME.opacity,
          alpha: -1,
          snap_edge: MOCK_CHROME.snap_edge,
          snap_auto_hide: MOCK_CHROME.snap_auto_hide,
          collapsed: MOCK_CHROME.collapsed,
          rect: [],
          snap_threshold: 20,
          error: '浏览器兜底没有 Win32：窗口透明度 / 吸附 / 收起只在 Tauri 里生效',
        };
      }
      if (cmd === 'set_opacity') {
        const v = Number(args.value);
        if (!(v >= 40 && v <= 100)) throw new Error('透明度 ' + v + '% 越界：只接受 40~100%');
        MOCK_CHROME.opacity = v;
        return v;
      }
      if (cmd === 'window_opacity') return MOCK_CHROME.opacity;
      if (cmd === 'set_snap_edge') {
        if (['none', 'left', 'right', 'top', 'bottom'].indexOf(args.edge) < 0) {
          throw new Error('吸附边缘只接受 none / left / right / top / bottom，收到：' + args.edge);
        }
        MOCK_CHROME.snap_edge = args.edge;
        return mockChromeStatus();
      }
      if (cmd === 'set_snap_auto_hide') {
        MOCK_CHROME.snap_auto_hide = !!args.on;
        return mockChromeStatus();
      }
      // 固定方式：状态照记（按钮/设置页要渲染），但三种效果都做不到，always_on_top 恒 false
      if (cmd === 'pin_mode_status') return mockPinStatus();
      if (cmd === 'set_pin_mode') {
        const m = String(args.mode || '');
        if (['wallpaper', 'top', 'normal'].indexOf(m) < 0) {
          throw new Error('固定方式只接受 wallpaper / top / normal，收到：' + m);
        }
        MOCK_PIN.mode = m;
        return mockPinStatus();
      }
      if (cmd === 'snap_now') return mockChromeStatus();
      if (cmd === 'collapse_window') { MOCK_CHROME.collapsed = true; return mockChromeStatus(); }
      if (cmd === 'expand_window') { MOCK_CHROME.collapsed = false; return mockChromeStatus(); }
      if (cmd === 'poke_scheduler') return;
      if (cmd === 'stop_reminder' || cmd === 'snooze_reminder') return;
      if (cmd === 'sync_status') return Object.assign({}, SYNC);
      if (cmd === 'sync_now') return { pushed: 0, pulled: 0, ok: false, error: SYNC.last_error };
      if (cmd === 'set_sync_url') {
        const u = String(args.url || '').trim().replace(/\/+$/, '');
        if (!/^https?:\/\//.test(u)) throw new Error('同步地址必须以 http:// 或 https:// 开头');
        SYNC.url = u;
        return Object.assign({}, SYNC);
      }
      throw new Error('未知命令：' + cmd);
    },
  };
})(window);