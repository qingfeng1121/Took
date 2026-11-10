//! 重复规则引擎 —— 与 \`docs/本地优先契约.md\` §3 逐字一致的三端共享语义。
//!
//! 三条硬约束（契约 §3.4）：
//!  1. 日期一律 'YYYY-MM-DD' 字符串；本文件不出现任何 epoch 毫秒的日期换算。
//!  2. 打卡键 = task_id + ':' + period_start，同一周期内所有命中日共享一个完成状态。
//!  3. 月末钳制只决定「这一次落在哪天」，不改写用户填的值。
//!
//! 契约 §3.5 的 12 条验收用例全部落在本文件末尾的 #[cfg(test)]（第 12 条要落库，
//! 在 db.rs 的 test_period_done_is_shared_within_period 里）。

/// 重复方式，对应 rule.schema.json 的 repeat_mode
pub const WEEKLY: i32 = 0;
pub const EVERY: i32 = 1;
pub const MONTHLY: i32 = 2;
pub const YEARLY: i32 = 3;
pub const NONE: i32 = 4;

/// 「每月最后一天」，对应 schema 里 month_day = -1
pub const MONTH_DAY_LAST: i32 = -1;

/// 纯公历日期（无时区、无时间分量）
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct Date {
    pub y: i32,
    pub m: u32,
    pub d: u32,
}

fn is_leap(y: i32) -> bool {
    (y % 4 == 0 && y % 100 != 0) || y % 400 == 0
}

/// 该月天数（公历）
pub fn days_in_month(y: i32, m: u32) -> u32 {
    const DAYS: [u32; 12] = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if m == 2 && is_leap(y) {
        29
    } else {
        DAYS[(m - 1) as usize]
    }
}

fn read_num(b: &[u8], from: usize, to: usize) -> Option<u32> {
    let mut v: u32 = 0;
    for &c in &b[from..to] {
        if !c.is_ascii_digit() {
            return None;
        }
        v = v * 10 + (c - b'0') as u32;
    }
    Some(v)
}

/// 严格解析 'YYYY-MM-DD'。非法格式一律报错，不静默兜底（契约 §3.4）。
pub fn parse_date(s: &str) -> Result<Date, String> {
    let b = s.as_bytes();
    let bad = || format!("日期必须是 YYYY-MM-DD：{:?}", s);
    if b.len() != 10 || b[4] != b'-' || b[7] != b'-' {
        return Err(bad());
    }
    let y = read_num(b, 0, 4).ok_or_else(bad)? as i32;
    let m = read_num(b, 5, 7).ok_or_else(bad)?;
    let d = read_num(b, 8, 10).ok_or_else(bad)?;
    if y < 1 || y > 9999 || m < 1 || m > 12 || d < 1 || d > days_in_month(y, m) {
        return Err(bad());
    }
    Ok(Date { y, m, d })
}

/// 把日期格式化成 'YYYY-MM-DD'
pub fn key(d: Date) -> String {
    format!("{:04}-{:02}-{:02}", d.y, d.m, d.d)
}

/// 连续日序数（1970-01-01 记 0）：纯公历分量推算，不经过时间戳。
fn day_serial(d: Date) -> i64 {
    let (y, m, dd) = (d.y as i64, d.m as i64, d.d as i64);
    let a = (14 - m) / 12;
    let yy = y + 4800 - a;
    let mm = m + 12 * a - 3;
    let jdn = dd + (153 * mm + 2) / 5 + 365 * yy + yy / 4 - yy / 100 + yy / 400 - 32045;
    jdn - 2440588
}

pub(crate) fn from_serial(n: i64) -> Date {
    let jdn = n + 2440588;
    let a = jdn + 32044;
    let b = (4 * a + 3) / 146097;
    let c = a - (146097 * b) / 4;
    let d = (4 * c + 3) / 1461;
    let e = c - (1461 * d) / 4;
    let mp = (5 * e + 2) / 153;
    let day = e - (153 * mp + 2) / 5 + 1;
    let month = mp + 3 - 12 * (mp / 10);
    let year = 100 * b + d - 4800 + mp / 10;
    Date { y: year as i32, m: month as u32, d: day as u32 }
}

/// 加减天数（返回 'YYYY-MM-DD' 友好的 Date）
pub fn add_days(d: Date, n: i64) -> Date {
    from_serial(day_serial(d) + n)
}

/// 周一 = 0 … 周日 = 6（与 weekdays_mask 的 bit 位一一对应）
pub fn weekday_index(d: Date) -> u32 {
    (((day_serial(d) + 3) % 7 + 7) % 7) as u32
}

/// 两日期相差天数（b - a）
pub fn days_between(a: Date, b: Date) -> i64 {
    day_serial(b) - day_serial(a)
}

/// 该月实际命中的日号：month_day=-1 取当月最后一天；大于当月天数时钳制到月末。
pub fn month_target_day(month_day: i32, y: i32, m: u32) -> u32 {
    let last = days_in_month(y, m);
    if month_day == MONTH_DAY_LAST {
        return last;
    }
    let md = month_day as u32;
    if md > last {
        last
    } else {
        md
    }
}

/// 参与命中判定的规则字段子集（不含同步四件套）。
#[derive(Clone, Debug, Default)]
pub struct Rule {
    pub repeat_mode: i32,
    pub weekdays_mask: i32,
    pub repeat_every: i32,
    pub month_day: i32,
    pub year_month: i32,
    pub year_day: i32,
    pub start_date: String,
    /// 空 = 不限
    pub end_date: String,
    /// 空 = 不限；非空时优先于 end_date 作为上界
    pub repeat_until: String,
}

impl Rule {
    /// 上界：repeat_until 优先，空则取 end_date；两者都空 = 不限
    fn upper_bound(&self) -> &str {
        if !self.repeat_until.is_empty() {
            &self.repeat_until
        } else {
            &self.end_date
        }
    }
}

/// 契约 §3.2 命中判定。
///
/// 1. date < start_date → false
/// 2. 上界（repeat_until，空则 end_date，都空则不限）之后 → false
/// 3. 按 repeat_mode 分派
pub fn occurs_on(rule: &Rule, date: Date) -> bool {
    let start = match parse_date(&rule.start_date) {
        Ok(d) => d,
        Err(_) => return false,
    };
    if date < start {
        return false;
    }
    let upper = rule.upper_bound();
    if !upper.is_empty() {
        match parse_date(upper) {
            Ok(end) if date <= end => {}
            _ => return false,
        }
    }

    match rule.repeat_mode {
        NONE => date == start,
        WEEKLY => {
            let bit = weekday_index(date);
            rule.weekdays_mask & (1 << bit) != 0
        }
        EVERY => {
            if rule.repeat_every < 1 {
                return false;
            }
            let gap = days_between(start, date);
            gap >= 0 && gap % rule.repeat_every as i64 == 0
        }
        MONTHLY => date.d == month_target_day(rule.month_day, date.y, date.m),
        YEARLY => {
            if date.m as i32 != rule.year_month {
                return false;
            }
            // 2/29 在平年落到 2/28，且不溢出到 3/1（只比较「该月」内的日号）
            let last = days_in_month(date.y, date.m);
            let target = if rule.year_day as u32 > last { last } else { rule.year_day as u32 };
            date.d == target
        }
        _ => false,
    }
}

/// 契约 §3.3 周期归属：date 所在周期的起始日 'YYYY-MM-DD'。
pub fn period_start_of(rule: &Rule, date: Date) -> Result<String, String> {
    match rule.repeat_mode {
        WEEKLY => {
            // 周一为一周之始
            Ok(key(add_days(date, -(weekday_index(date) as i64))))
        }
        EVERY => {
            if rule.repeat_every < 1 {
                return Err(format!("repeat_every 必须 >= 1，实际 {}", rule.repeat_every));
            }
            let start = parse_date(&rule.start_date)?;
            let gap = days_between(start, date);
            if gap < 0 {
                return Err(format!("{} 早于规则起始日 {}", key(date), rule.start_date));
            }
            let step = rule.repeat_every as i64;
            Ok(key(add_days(start, (gap / step) * step)))
        }
        // monthly / yearly / none：一个周期就是一天
        _ => Ok(key(date)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn weekly(mask: i32) -> Rule {
        Rule { repeat_mode: WEEKLY, weekdays_mask: mask, start_date: "2026-10-01".into(), ..Default::default() }
    }
    fn monthly(month_day: i32) -> Rule {
        Rule { repeat_mode: MONTHLY, month_day, start_date: "2026-01-01".into(), ..Default::default() }
    }
    fn yearly(m: i32, d: i32) -> Rule {
        Rule {
            repeat_mode: YEARLY,
            year_month: m,
            year_day: d,
            start_date: "2026-01-01".into(),
            ..Default::default()
        }
    }
    fn d(s: &str) -> Date {
        parse_date(s).expect("测试日期必须合法")
    }
    fn ps(rule: &Rule, s: &str) -> String {
        period_start_of(rule, d(s)).expect("periodStart")
    }

    // 契约 §3.5 #1
    #[test]
    fn case01_weekly_mask_31() {
        let r = weekly(31);
        assert!(occurs_on(&r, d("2026-10-19")), "周一应命中");
        assert!(!occurs_on(&r, d("2026-10-24")), "周六不命中");
        assert!(!occurs_on(&r, d("2026-10-25")), "周日不命中");
        // 补齐一周五天的正向断言，防止 mask 写反
        for (day, on) in [("2026-10-20", true), ("2026-10-21", true), ("2026-10-22", true), ("2026-10-23", true)] {
            assert_eq!(occurs_on(&r, d(day)), on, "{}", day);
        }
    }

    // 契约 §3.5 #2
    #[test]
    fn case02_every_8_from_2026_10_01() {
        let r = Rule { repeat_mode: EVERY, repeat_every: 8, start_date: "2026-10-01".into(), ..Default::default() };
        assert!(occurs_on(&r, d("2026-10-01")));
        assert!(occurs_on(&r, d("2026-10-09")));
        assert!(!occurs_on(&r, d("2026-10-10")));
        assert!(!occurs_on(&r, d("2026-09-30")));
    }

    // 契约 §3.5 #3
    #[test]
    fn case03_monthly_20() {
        let r = monthly(20);
        assert!(occurs_on(&r, d("2026-10-20")));
        assert!(occurs_on(&r, d("2026-11-20")));
        assert!(!occurs_on(&r, d("2026-10-21")));
    }

    // 契约 §3.5 #4：小月钳制到月末，但不改写用户填的 31
    #[test]
    fn case04_monthly_31_clamped() {
        let r = monthly(31);
        assert!(occurs_on(&r, d("2026-10-31")));
        assert!(occurs_on(&r, d("2026-11-30")));
        assert!(!occurs_on(&r, d("2026-11-29")));
        assert!(occurs_on(&r, d("2027-02-28")));
        assert!(!occurs_on(&r, d("2027-02-27")));
        assert!(occurs_on(&r, d("2028-02-29")));
        // 钳制不改写原值：下个大月仍回 31
        assert!(occurs_on(&r, d("2027-03-31")));
        assert_eq!(r.month_day, 31);
    }

    // 契约 §3.5 #5：month_day=-1 取该月最后一天
    #[test]
    fn case05_monthly_last_day() {
        let r = monthly(MONTH_DAY_LAST);
        assert!(occurs_on(&r, d("2026-01-31")));
        assert!(occurs_on(&r, d("2026-04-30")));
        assert!(occurs_on(&r, d("2027-02-28")));
        assert!(occurs_on(&r, d("2028-02-29")));
        assert!(!occurs_on(&r, d("2027-02-27")));
    }

    // 契约 §3.5 #6
    #[test]
    fn case06_yearly_mar_15() {
        let r = yearly(3, 15);
        assert!(occurs_on(&r, d("2027-03-15")));
        assert!(!occurs_on(&r, d("2027-03-14")));
    }

    // 契约 §3.5 #7：2/29 平年落 2/28，且不溢出到 3/1
    #[test]
    fn case07_yearly_feb_29_no_overflow() {
        let r = yearly(2, 29);
        assert!(occurs_on(&r, d("2028-02-29")));
        assert!(occurs_on(&r, d("2027-02-28")));
        assert!(!occurs_on(&r, d("2027-03-01")));
        assert!(!occurs_on(&r, d("2027-02-27")));
    }

    // 契约 §3.5 #8：整周归属到周一
    #[test]
    fn case08_weekly_period_start() {
        let r = weekly(127);
        for day in [
            "2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23", "2026-10-24", "2026-10-25",
        ] {
            assert_eq!(ps(&r, day), "2026-10-19", "{} 应归 2026-10-19", day);
        }
        assert_eq!(ps(&r, "2026-10-26"), "2026-10-26");
    }

    // 契约 §3.5 #9：每 N 天按 start 对齐
    #[test]
    fn case09_every_period_start() {
        let r = Rule { repeat_mode: EVERY, repeat_every: 8, start_date: "2026-10-01".into(), ..Default::default() };
        assert_eq!(ps(&r, "2026-10-06"), "2026-10-01");
        assert_eq!(ps(&r, "2026-10-09"), "2026-10-09");
    }

    // 契约 §3.5 #10：起始日之前一律不命中
    #[test]
    fn case10_before_start_date() {
        // 起始日 2026-10-01 之前，即便日号吻合也不命中
        let r = Rule { repeat_mode: MONTHLY, month_day: 20, start_date: "2026-10-01".into(), ..Default::default() };
        assert!(!occurs_on(&r, d("2026-09-20")), "起始日之前不命中");
        assert!(!occurs_on(&r, d("2026-10-19")), "同月但日号不符不命中");
        assert!(occurs_on(&r, d("2026-10-20")));
        // 对照组：起始日更早时，2026-09-20 就是命中日，证明上面拦的是「起始日」而不是日号
        let early = monthly(20);
        assert!(occurs_on(&early, d("2026-09-20")));
    }

    // 契约 §3.5 #11：上界之后不命中
    #[test]
    fn case11_after_repeat_until() {
        let r = Rule {
            repeat_mode: MONTHLY,
            month_day: 20,
            start_date: "2026-01-01".into(),
            repeat_until: "2026-11-30".into(),
            ..Default::default()
        };
        assert!(!occurs_on(&r, d("2026-12-20")));
        assert!(occurs_on(&r, d("2026-11-20")));
        // repeat_until 为空时用 end_date 当上界
        let r2 = Rule {
            repeat_mode: MONTHLY,
            month_day: 20,
            start_date: "2026-01-01".into(),
            end_date: "2026-11-30".into(),
            ..Default::default()
        };
        assert!(!occurs_on(&r2, d("2026-12-20")));
        assert!(occurs_on(&r2, d("2026-11-20")));
    }

    // 契约 §3.5 #12 的引擎侧：同一周期内所有命中日算出同一个 period_start。
    // 落库后的共享断言在 db.rs::tests::period_done_shared_within_week。
    #[test]
    fn case12_period_key_is_shared() {
        let r = weekly(31);
        let week: Vec<String> = ["2026-10-19", "2026-10-20", "2026-10-24", "2026-10-25"]
            .iter()
            .map(|s| ps(&r, s))
            .collect();
        assert!(week.iter().all(|p| p == "2026-10-19"), "整周共享一个 period_start：{:?}", week);
        assert_eq!(ps(&r, "2026-10-26"), "2026-10-26", "10-26 起是新周期");
    }

    #[test]
    fn date_parsing_is_strict() {
        for bad in ["2026-1-5", "2026/10/01", "2026-13-01", "2026-02-30", "", "2026-10-0"] {
            assert!(parse_date(bad).is_err(), "{:?} 应报错", bad);
        }
        assert!(parse_date("2026-02-29").is_err(), "2026 不是闰年，2/29 应报错");
        assert_eq!(key(parse_date("2028-02-29").unwrap()), "2028-02-29", "闰年 2/29 合法");
    }

    #[test]
    fn weekday_monday_is_zero() {
        assert_eq!(weekday_index(d("2026-10-19")), 0, "周一 = 0");
        assert_eq!(weekday_index(d("2026-10-25")), 6, "周日 = 6");
    }
}
