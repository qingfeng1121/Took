//! 提醒的「下一次触发时刻」纯计算（契约 §11.2 + 定稿 §6.3.4）。
//!
//! 这个模块**不碰 Tauri、不碰数据库、不碰通知**：它只回答一个问题 —— 给定一条 reminder
//! 行和它的宿主（规则 / 记事 / 倒数日），下一个真实触发点是哪一刻。之所以单独拆出来，是因为
//! 提醒真正会算错的只有这里（repeat_rule、offset_days、已过时刻、月末钳制、2-29 平年、
//! 每 N 天跨月、规则已结束），必须能在 cargo test 里逐条断言，而不是等 30 秒看有没有响。
//!
//! 时区：一律用**本机本地时间**（chrono::Local）。数据库里存的是 'YYYY-MM-DD' 的本地日历日，
//! time_of_day 是本机墙上时间；用 UTC 解释会让所有提醒整体偏移 8 小时。
//!
//! 与 Android 端 app/took/alarm/ReminderFireTime.kt 逐条对齐（那边已经跑通）：
//! 扫描窗口 400 天、repeat_rule=0 只取周期首个命中日、at <= now 一律跳过。

use chrono::{Datelike, Local, TimeZone};

use crate::db::{ReminderRow, MEMO_COUNTDOWN, MEMO_NOTE};
use crate::engine::{self, Date, Rule};

/// 往后最多找这么多天。规则可能整整一年才命中一次（yearly），横向给到 400 天覆盖闰年。
pub const HORIZON_DAYS: i64 = 400;

/// 一个真实触发点。occur_date 是周期命中日，fire_date 是它加上 offset_days 之后的
/// 实际触发日（倒数日「提前 N 天」就是这里为负数）。任务类提醒两者相同。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FirePoint {
    pub fire_at: i64,
    pub occur_date: String,
    pub fire_date: String,
    pub period_start: String,
}

/// 提醒的宿主。规则走 period 那套；memo 只有「哪一天算命中」。
#[derive(Clone, Debug)]
pub enum Target {
    Rule(Box<Rule>),
    /// kind：0=记事 1=倒数日（2=笔记本永不挂提醒，见契约 §11）
    Memo { kind: i64, start_date: String, end_date: String },
}

impl Target {
    /// 这一天是不是命中日
    pub fn occurs_on(&self, date: Date) -> bool {
        match self {
            Target::Rule(rule) => engine::occurs_on(rule, date),
            Target::Memo { kind, start_date, end_date } => {
                if *kind == MEMO_COUNTDOWN {
                    // 倒数日只有一个目标日，offset_days 负责提前
                    match engine::parse_date(start_date) {
                        Ok(d) => d == date,
                        Err(_) => false,
                    }
                } else if *kind == MEMO_NOTE {
                    // 记事：不排期永不提醒；单日就是那一天；区间内每天都算
                    let start = match engine::parse_date(start_date) {
                        Ok(d) => d,
                        Err(_) => return false,
                    };
                    if date < start {
                        return false;
                    }
                    let end = if end_date.trim().is_empty() || end_date == start_date {
                        start
                    } else {
                        match engine::parse_date(end_date) {
                            Ok(d) => d,
                            Err(_) => start,
                        }
                    };
                    date <= end
                } else {
                    false
                }
            }
        }
    }

    /// 该命中日所在周期的起始日 'YYYY-MM-DD'
    pub fn period_start_of(&self, date: Date) -> String {
        match self {
            Target::Rule(rule) => engine::period_start_of(rule, date)
                .unwrap_or_else(|_| engine::key(date)),
            // 一个 memo 一个周期就是一天
            Target::Memo { .. } => engine::key(date),
        }
    }

    /// 是不是它所在周期的**第一个**命中日（repeat_rule=0 只在这天响）。
    /// 做法老老实实从周期起始日往后走：周一起始的周规则里，周一命中就返回「周一才是第一个」。
    pub fn is_first_hit_of_period(&self, date: Date) -> bool {
        match self {
            Target::Memo { .. } => true,
            Target::Rule(rule) => {
                let start = match engine::parse_date(&self.period_start_of(date)) {
                    Ok(d) => d,
                    Err(_) => return true,
                };
                let mut day = start;
                while day <= date {
                    if engine::occurs_on(rule, day) {
                        return day == date;
                    }
                    day = engine::add_days(day, 1);
                }
                false
            }
        }
    }
}

/// 解析 HH:mm。返回 None = 这条提醒**不该响**（脏数据），调用方跳过而不是抛异常 ——
/// 调度线程里抛异常等于提醒静默失效，比不响更糟。
pub fn parse_hhmm(text: &str) -> Option<(u32, u32)> {
    let t = text.trim();
    if !crate::db::hhmm_ok(t) {
        return None;
    }
    let b = t.as_bytes();
    let hh = ((b[0] - b'0') * 10 + (b[1] - b'0')) as u32;
    let mm = ((b[3] - b'0') * 10 + (b[4] - b'0')) as u32;
    Some((hh, mm))
}

/// 本机本地时间戳（毫秒）。带时区，不用 UTC 兜底。
pub fn now_ms() -> i64 {
    Local::now().timestamp_millis()
}

/// 某个本地日历日的 HH:mm 对应的毫秒时间戳（本机时区）。
pub fn fire_at_ms(date: Date, hh: u32, mm: u32) -> Option<i64> {
    Local
        .with_ymd_and_hms(date.y, date.m, date.d, hh, mm, 0)
        .single()
        .map(|dt| dt.timestamp_millis())
}

/// 毫秒时间戳落在本机哪个日历日
pub fn local_date_of(ms: i64) -> Option<Date> {
    Local.timestamp_millis_opt(ms).single().map(|dt| Date {
        y: dt.year(),
        m: dt.month(),
        d: dt.day(),
    })
}

/// 毫秒时间戳的本地 'HH:mm'
pub fn local_hhmm_of(ms: i64) -> String {
    match Local.timestamp_millis_opt(ms).single() {
        Some(dt) => format!(
            "{:02}:{:02}",
            chrono::Timelike::hour(&dt),
            chrono::Timelike::minute(&dt)
        ),
        None => "—".to_string(),
    }
}

/// 毫秒时间戳的本地 'YYYY-MM-DD HH:mm'
pub fn local_text_of(ms: i64) -> String {
    match local_date_of(ms) {
        Some(d) => format!("{} {}", engine::key(d), local_hhmm_of(ms)),
        None => "—".to_string(),
    }
}

/// 从现在起往后的前 limit 个触发点（升序）。
///
/// 跳过条件全部在这里，缺一不可：
///  - 提醒行没生效（enabled=0，或两个通道都关）；
///  - time_of_day 脏；
///  - repeat_rule=0 且该命中日不是周期第一个命中日；
///  - 触发时刻已经过去（今天 21:00 的提醒在 21:30 才对表，不能立刻补响一次）；
///  - 规则根本没命中，或 400 天内都不会再命中（已结束的规则）。
pub fn next_fires(target: &Target, row: &ReminderRow, now: i64, limit: usize) -> Vec<FirePoint> {
    if row.deleted == 1 || row.enabled != 1 || (row.notify_on == 0 && row.alarm_on == 0) {
        return Vec::new();
    }
    let (hh, mm) = match parse_hhmm(&row.time_of_day) {
        Some(v) => v,
        None => return Vec::new(),
    };
    let today = match local_date_of(now) {
        Some(d) => d,
        None => return Vec::new(),
    };
    let mut out = Vec::with_capacity(limit.min(4));
    // offset_days 为负时触发日早于命中日，所以从「今天」起扫而不是从触发日起扫；
    // 已经过去的触发时刻由 at <= now 统一滤掉。
    for i in 0..=HORIZON_DAYS {
        let occur = engine::add_days(today, i);
        if !target.occurs_on(occur) {
            continue;
        }
        if row.repeat_rule == 0 && !target.is_first_hit_of_period(occur) {
            continue;
        }
        let fire_date = engine::add_days(occur, row.offset_days);
        let at = match fire_at_ms(fire_date, hh, mm) {
            Some(v) => v,
            None => continue,
        };
        if at <= now {
            continue;
        }
        out.push(FirePoint {
            fire_at: at,
            occur_date: engine::key(occur),
            fire_date: engine::key(fire_date),
            period_start: target.period_start_of(occur),
        });
        if out.len() >= limit {
            break;
        }
    }
    out
}

/// 最近的一个触发点；None = 不会再有（已结束 / 关闭 / 脏数据）
pub fn next_fire(target: &Target, row: &ReminderRow, now: i64) -> Option<FirePoint> {
    next_fires(target, row, now, 1).into_iter().next()
}

/// 贪睡：从 now 起 snooze_min 分钟。0（或不合法）= 不贪睡，返回 None。
/// 契约 §11.2：snooze_min = 0 就是「不贪睡」，不是「贪睡 0 分钟」。
pub fn snooze_at(now: i64, snooze_min: i64) -> Option<i64> {
    if snooze_min <= 0 {
        None
    } else {
        Some(now + snooze_min * 60_000)
    }
}

/// 通知正文：notify_text 优先，空则「该打卡了：<宿主名>」（契约 §11.2）。
pub fn body_of(notify_text: &str, owner_title: &str) -> String {
    let t = notify_text.trim();
    if t.is_empty() {
        format!("该打卡了：{owner_title}")
    } else {
        t.to_string()
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::REMINDER_RULE;
    use crate::engine::{EVERY, MONTHLY, WEEKLY, YEARLY};

    /// 本地时间 → 毫秒
    fn at(y: i32, m: u32, d: u32, hh: u32, mm: u32) -> i64 {
        Local.with_ymd_and_hms(y, m, d, hh, mm, 0).single().unwrap().timestamp_millis()
    }

    fn row(time: &str, repeat_rule: i64, offset_days: i64) -> ReminderRow {
        ReminderRow {
            id: "rm".into(),
            owner_kind: REMINDER_RULE,
            owner_id: "r1".into(),
            notify_on: 1,
            alarm_on: 0,
            time_of_day: time.into(),
            notify_text: String::new(),
            offset_days,
            repeat_rule,
            snooze_min: 0,
            enabled: 1,
            rev: 0,
            updated_at: 0,
            deleted: 0,
            dirty: 0,
        }
    }

    fn blank_rule(mode: i32) -> Rule {
        Rule {
            repeat_mode: mode,
            weekdays_mask: 0,
            repeat_every: 0,
            month_day: 0,
            year_month: 0,
            year_day: 0,
            start_date: "2026-01-01".into(),
            end_date: String::new(),
            repeat_until: String::new(),
        }
    }

    fn weekly() -> Target {
        let mut r = blank_rule(WEEKLY);
        r.weekdays_mask = 31; // 周一~周五
        Target::Rule(Box::new(r))
    }

    // ---- 1. repeat_rule = 0 只取周期第一个命中日 ----

    #[test]
    fn repeat_rule_0_only_fires_on_first_hit_of_period() {
        // 2026-10-25 是周日；下一个周一是 10-26，本周命中日 = 周一~周五
        let now = at(2026, 10, 25, 12, 0);
        let first = next_fire(&weekly(), &row("09:00", 0, 0), now).expect("应有一个触发点");
        assert_eq!(first.occur_date, "2026-10-26", "repeat_rule=0 只取周一（周期首个命中日）");
        assert_eq!(first.period_start, "2026-10-26");

        // 从周二开始看：本周已经响过（周一 09:00 已过），下一次必须是下周一
        let tue = at(2026, 10, 27, 12, 0);
        let next = next_fire(&weekly(), &row("09:00", 0, 0), tue).unwrap();
        assert_eq!(next.occur_date, "2026-11-02", "周一的提醒响过之后要跳到下个周期");
    }

    #[test]
    fn repeat_rule_1_fires_on_every_hit_day() {
        let now = at(2026, 10, 25, 12, 0);
        let list = next_fires(&weekly(), &row("09:00", 1, 0), now, 3);
        let days: Vec<&str> = list.iter().map(|p| p.occur_date.as_str()).collect();
        assert_eq!(days, vec!["2026-10-26", "2026-10-27", "2026-10-28"], "每个命中日都响");
    }

    // ---- 2. offset_days 提前 / 延后 ----

    #[test]
    fn offset_days_moves_fire_date_earlier_and_later() {
        let now = at(2026, 10, 25, 12, 0);
        // 提前 3 天：10-29 的命中日在 10-26 09:00 响
        let early = next_fire(&weekly(), &row("09:00", 1, -3), now).unwrap();
        assert_eq!(early.occur_date, "2026-10-29");
        assert_eq!(early.fire_date, "2026-10-26", "提前 3 天 = 触发日落在命中日前 3 天");

        // 延后 2 天
        let late = next_fire(&weekly(), &row("09:00", 1, 2), now).unwrap();
        assert_eq!(late.occur_date, "2026-10-26");
        assert_eq!(late.fire_date, "2026-10-28", "延后 2 天");

        // 倒数日：目标日 11-11，提前 7 天 → 11-04 09:00
        let countdown = Target::Memo {
            kind: MEMO_COUNTDOWN,
            start_date: "2026-11-11".into(),
            end_date: String::new(),
        };
        let p = next_fire(&countdown, &row("09:00", 1, -7), now).unwrap();
        assert_eq!(p.fire_date, "2026-11-04");
        assert_eq!(p.occur_date, "2026-11-11");
    }

    // ---- 3. 已过的时间要跳到下一个，不能返回过去 ----

    #[test]
    fn past_trigger_jumps_to_next_day_never_returns_the_past() {
        // 今天 21:00 的提醒，在 21:30 才看 → 不能补响今天，必须给明天
        let now = at(2026, 10, 26, 21, 30);
        let p = next_fire(&weekly(), &row("21:00", 1, 0), now).unwrap();
        assert_eq!(p.occur_date, "2026-10-27");
        assert!(p.fire_at > now, "触发时刻必须严格晚于现在");

        // 恰好在触发那一毫秒：也要跳过（不能重复响）
        let exact = at(2026, 10, 26, 21, 0);
        let q = next_fire(&weekly(), &row("21:00", 1, 0), exact).unwrap();
        assert_eq!(q.occur_date, "2026-10-27");
        assert!(q.fire_at > exact);

        // 早 1 分钟：就是今天
        let before = at(2026, 10, 26, 20, 59);
        let r = next_fire(&weekly(), &row("21:00", 1, 0), before).unwrap();
        assert_eq!(r.occur_date, "2026-10-26");
    }

    // ---- 4. 月末钳制 / 2-29 平年 / 每 N 天跨月 ----

    #[test]
    fn monthly_day_31_clamps_to_month_end() {
        // 每月 31 号：11 月只有 30 天 → 落在 11-30
        let mut rule = blank_rule(MONTHLY);
        rule.month_day = 31;
        let target = Target::Rule(Box::new(rule));
        let now = at(2026, 11, 1, 0, 0);
        let p = next_fire(&target, &row("09:00", 1, 0), now).unwrap();
        assert_eq!(p.occur_date, "2026-11-30", "11 月没有 31 号，钳制到月末");

        // 每月最后一天（month_day = -1）：2028-02 是闰年 → 02-29
        let mut last = blank_rule(MONTHLY);
        last.month_day = -1;
        let t2 = Target::Rule(Box::new(last));
        let p2 = next_fire(&t2, &row("09:00", 1, 0), at(2028, 2, 1, 0, 0)).unwrap();
        assert_eq!(p2.occur_date, "2028-02-29");
        let p3 = next_fire(&t2, &row("09:00", 1, 0), at(2026, 2, 1, 0, 0)).unwrap();
        assert_eq!(p3.occur_date, "2026-02-28", "平年 2 月是 28 天");
    }

    #[test]
    fn yearly_feb_29_falls_back_to_feb_28_in_common_year() {
        let mut r = blank_rule(YEARLY);
        r.year_month = 2;
        r.year_day = 29;
        let target = Target::Rule(Box::new(r));
        // 2026 是平年：2-29 不存在，必须落在 2-28，且不溢出到 3-1
        let p = next_fire(&target, &row("09:00", 1, 0), at(2026, 1, 1, 0, 0)).unwrap();
        assert_eq!(p.occur_date, "2026-02-28");
        // 2028 是闰年：真的 2-29
        let p2 = next_fire(&target, &row("09:00", 1, 0), at(2028, 1, 1, 0, 0)).unwrap();
        assert_eq!(p2.occur_date, "2028-02-29");
    }

    #[test]
    fn every_n_days_spans_months() {
        // 每 15 天，从 2026-10-01 起：10-31 / 11-15 / 11-30 ...
        let mut r = blank_rule(EVERY);
        r.repeat_every = 15;
        r.start_date = "2026-10-01".into();
        let target = Target::Rule(Box::new(r));
        let list = next_fires(&target, &row("09:00", 1, 0), at(2026, 10, 20, 12, 0), 3);
        let days: Vec<&str> = list.iter().map(|p| p.occur_date.as_str()).collect();
        assert_eq!(days, vec!["2026-10-31", "2026-11-15", "2026-11-30"], "每 N 天要能跨月");

        // repeat_rule=0：每 N 天的命中日就是周期起点，10-31 是这一周期的第一个命中日
        let first = next_fire(&target, &row("09:00", 0, 0), at(2026, 10, 20, 12, 0)).unwrap();
        assert_eq!(first.occur_date, "2026-10-31");
        assert_eq!(first.period_start, "2026-10-31");
    }

    // ---- 5. 其余边界 ----

    #[test]
    fn ended_rule_never_fires() {
        let mut r = blank_rule(WEEKLY);
        r.weekdays_mask = 31;
        r.repeat_until = "2026-02-01".into();
        let target = Target::Rule(Box::new(r));
        assert!(
            next_fire(&target, &row("09:00", 1, 0), at(2026, 10, 25, 12, 0)).is_none(),
            "已结束的规则不能再排，也不能返回过去"
        );
    }

    #[test]
    fn disabled_or_both_channels_off_or_dirty_time_never_fires() {
        let now = at(2026, 10, 25, 12, 0);
        let mut off = row("09:00", 1, 0);
        off.enabled = 0;
        assert!(next_fire(&weekly(), &off, now).is_none(), "enabled=0 不响");

        let mut both_off = row("09:00", 1, 0);
        both_off.notify_on = 0;
        both_off.alarm_on = 0;
        assert!(next_fire(&weekly(), &both_off, now).is_none(), "两个通道都关不响");

        let mut tomb = row("09:00", 1, 0);
        tomb.deleted = 1;
        assert!(next_fire(&weekly(), &tomb, now).is_none(), "墓碑不响");

        assert!(next_fire(&weekly(), &row("9:00", 1, 0), now).is_none(), "9:00 不是 HH:mm");
        assert!(next_fire(&weekly(), &row("24:00", 1, 0), now).is_none(), "24:00 越界");
    }

    #[test]
    fn snooze_and_body_helpers() {
        assert_eq!(snooze_at(1_000_000, 0), None, "snooze_min=0 是不贪睡");
        assert_eq!(snooze_at(1_000_000, -5), None);
        assert_eq!(snooze_at(1_000_000, 5), Some(1_000_000 + 300_000));

        assert_eq!(body_of("", "健身"), "该打卡了：健身", "文案空则用缺省");
        assert_eq!(body_of("  该动一动了  ", "健身"), "该动一动了");
    }

    #[test]
    fn countdown_and_note_reminders() {
        let now = at(2026, 10, 25, 12, 0);
        // 记事：10-25~10-27 的区间，repeat_rule=1 → 区间内每一天都算命中
        let note = Target::Memo {
            kind: MEMO_NOTE,
            start_date: "2026-10-25".into(),
            end_date: "2026-10-27".into(),
        };
        let list = next_fires(&note, &row("09:00", 1, 0), now, 3);
        let days: Vec<&str> = list.iter().map(|p| p.occur_date.as_str()).collect();
        assert_eq!(days, vec!["2026-10-26", "2026-10-27"], "区间内剩下的日子");

        // 记事不排期 → 永不提醒
        let unscheduled = Target::Memo {
            kind: MEMO_NOTE,
            start_date: String::new(),
            end_date: String::new(),
        };
        assert!(next_fire(&unscheduled, &row("09:00", 1, 0), now).is_none());

        // 笔记本不挂提醒
        let notebook = Target::Memo {
            kind: 2,
            start_date: "2026-10-25".into(),
            end_date: String::new(),
        };
        assert!(next_fire(&notebook, &row("09:00", 1, 0), now).is_none());
    }

    #[test]
    fn local_time_round_trip() {
        let ms = at(2026, 10, 25, 21, 7);
        assert_eq!(local_date_of(ms).map(engine::key).as_deref(), Some("2026-10-25"));
        assert_eq!(local_hhmm_of(ms), "21:07");
        assert_eq!(local_text_of(ms), "2026-10-25 21:07");
    }
}
