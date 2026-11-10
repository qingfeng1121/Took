//! SQLite 存取：建表、种子、按月展开、打卡写入、同步落库。
//!
//! 契约对应关系：
//!  - §2 四张表 + §11 的 reminder 表：src/schema.sql（与 server 逐字一致）
//!  - §3.3 打卡键 (task_id, period_start)：done_set / toggle_done
//!  - §3.4 写入层严格校验：toggle_done 先 parse_date，非法日期直接报错
//!  - §7.2 冲突仲裁：apply_pull 里 LWW by updated_at（相等比 rev，再相等留本地）
//!  - §7.4 客户端状态：lastPulledRev / dirty 落在 local_state 表与本表的 dirty 列
//!
//! local_state 是 PC 端本地独有表（同步游标 + 设置），不属于契约 §2 的四张共享表，
//! 也不参与 push/pull；单独建在 LOCAL_SCHEMA 里就是为了让 schema.sql 与后端保持逐字一致。

use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

use crate::engine::{self, Rule as EngineRule};

const SCHEMA: &str = include_str!("schema.sql");

/// PC 本地独有的键值表（同步游标与设置）。不影响契约的四张表。
const LOCAL_SCHEMA: &str = "CREATE TABLE IF NOT EXISTS local_state (\
     key TEXT PRIMARY KEY, value TEXT NOT NULL);";

/// 同步地址（设置页可改），缺省指向本机后端
pub const DEFAULT_SYNC_URL: &str = "http://127.0.0.1:8420";

const K_SYNC_URL: &str = "sync_url";
const K_LAST_PULLED_REV: &str = "last_pulled_rev";
const K_LAST_SYNC_AT: &str = "last_sync_at";
const K_LAST_ERROR: &str = "last_error";
/// 同步令牌（契约 §7.1 的 Authorization: Bearer <token>）。空串 = 后端没开鉴权，请求里不带这个头。
const K_SYNC_TOKEN: &str = "sync_token";

/// 每条记录的同步四件套写盘时间（毫秒）。日期本身一律走 engine 的 'YYYY-MM-DD'。
///
/// 进程内严格单调递增：同一毫秒里连着两次写（比如快速点两下取消打卡）也必须拿到
/// 不同的 updated_at，否则 LWW 仲裁（§7.2）时间戳相等，取消动作会被旧值顶回来。
pub(crate) fn now_ms() -> i64 {
    use std::sync::atomic::{AtomicI64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};
    static LAST: AtomicI64 = AtomicI64::new(0);
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    let mut prev = LAST.load(Ordering::Relaxed);
    loop {
        let next = if now > prev { now } else { prev + 1 };
        match LAST.compare_exchange_weak(prev, next, Ordering::Relaxed, Ordering::Relaxed) {
            Ok(_) => return next,
            Err(actual) => prev = actual,
        }
    }
}

/// 任务（存储视图）
#[derive(Clone, Debug, Serialize)]
pub struct TaskRow {
    pub id: String,
    pub rule_id: String,
    pub title: String,
    pub enabled: bool,
    pub sort_order: i64,
}

/// 规则（存储视图，带其下任务）
#[derive(Clone, Debug, Serialize)]
pub struct RuleRow {
    pub id: String,
    pub title: String,
    pub enabled: bool,
    pub repeat_mode: i64,
    pub weekdays_mask: i64,
    pub repeat_every: i64,
    pub month_day: i64,
    pub year_month: i64,
    pub year_day: i64,
    pub start_date: String,
    pub end_date: String,
    pub repeat_until: String,
    /// 是否已结束（上界 < 今天）。已结束的规则仍可查看历史，但不可再改重复设置（契约 §9.2）
    pub ended: bool,
    pub tasks: Vec<TaskRow>,
    /// 提醒摘要（契约 §11.3）：「通知 21:00 + 闹钟 21:00」；没有提醒时为空串
    pub reminder_summary: String,
}

impl RuleRow {
    fn to_engine(&self) -> EngineRule {
        EngineRule {
            repeat_mode: self.repeat_mode as i32,
            weekdays_mask: self.weekdays_mask as i32,
            repeat_every: self.repeat_every as i32,
            month_day: self.month_day as i32,
            year_month: self.year_month as i32,
            year_day: self.year_day as i32,
            start_date: self.start_date.clone(),
            end_date: self.end_date.clone(),
            repeat_until: self.repeat_until.clone(),
        }
    }
}

/// 某天里的一个命中任务
#[derive(Clone, Debug, Serialize)]
pub struct DayTask {
    pub task_id: String,
    pub title: String,
    pub rule_id: String,
    pub rule_title: String,
    /// 该任务在这一天的周期起点（契约 §3.3）：打卡写的就是 (task_id, period_start)
    pub period_start: String,
    pub done: bool,
}

/// 月历里的一格
#[derive(Clone, Debug, Serialize)]
pub struct Day {
    pub date: String,
    pub tasks: Vec<DayTask>,
    /// 命中这一天的记事（kind=0）。倒数日与笔记本永不进月历（契约 §10.1）
    pub memos: Vec<DayMemo>,
}

/// 某天命中的记事（只读展示；编辑走 list_memos + update_memo）
#[derive(Clone, Debug, Serialize)]
pub struct DayMemo {
    pub id: String,
    pub title: String,
    pub start_date: String,
    pub end_date: String,
}

/// month_grid 的返回结构（与 Go 后端 /api/month 一致）
#[derive(Clone, Debug, Serialize)]
pub struct MonthGrid {
    pub year: i32,
    pub month: u32,
    pub days: Vec<Day>,
}

/// toggle_done 的返回：写入后的真相 + period_start 当天的展开数据。
/// 前端据 task_id + period_start 直接把缓存里所有同周期天的状态改掉，
/// 不必重新拉整月（契约 §3.3「同一周期内所有命中日共享一个完成状态」）。
#[derive(Clone, Debug, Serialize)]
pub struct ToggleResult {
    pub task_id: String,
    pub period_start: String,
    pub done: bool,
    pub rev: i64,
    pub updated_at: i64,
    pub dirty: bool,
    pub day: Day,
}

/* ---------- 同步载荷（契约 §7.1 的请求/响应结构） ---------- */

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RuleRec {
    pub id: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub enabled: i64,
    #[serde(default)]
    pub repeat_mode: i64,
    #[serde(default)]
    pub weekdays_mask: i64,
    #[serde(default)]
    pub repeat_every: Option<i64>,
    #[serde(default)]
    pub month_day: Option<i64>,
    #[serde(default)]
    pub year_month: Option<i64>,
    #[serde(default)]
    pub year_day: Option<i64>,
    #[serde(default)]
    pub start_date: String,
    #[serde(default)]
    pub end_date: Option<String>,
    #[serde(default)]
    pub repeat_until: Option<String>,
    #[serde(default)]
    pub rev: i64,
    #[serde(default)]
    pub updated_at: i64,
    #[serde(default)]
    pub deleted: i64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct TaskRec {
    pub id: String,
    #[serde(default)]
    pub rule_id: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub enabled: i64,
    #[serde(default)]
    pub sort_order: i64,
    #[serde(default)]
    pub rev: i64,
    #[serde(default)]
    pub updated_at: i64,
    #[serde(default)]
    pub deleted: i64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct MemoRec {
    pub id: String,
    #[serde(default)]
    pub kind: i64,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub content: Option<String>,
    #[serde(default)]
    pub start_date: Option<String>,
    #[serde(default)]
    pub end_date: Option<String>,
    #[serde(default)]
    pub category: Option<String>,
    #[serde(default)]
    pub rev: i64,
    #[serde(default)]
    pub updated_at: i64,
    #[serde(default)]
    pub deleted: i64,
}

/// 提醒的同步视图（契约 §11）：notify_on / alarm_on 用 0/1，与 Go 后端 SyncReminder 逐字一致
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ReminderRec {
    pub id: String,
    #[serde(default)]
    pub owner_kind: i64,
    #[serde(default)]
    pub owner_id: String,
    #[serde(default)]
    pub notify_on: i64,
    #[serde(default)]
    pub alarm_on: i64,
    #[serde(default)]
    pub time_of_day: String,
    #[serde(default)]
    pub notify_text: Option<String>,
    #[serde(default)]
    pub offset_days: i64,
    #[serde(default)]
    pub repeat_rule: i64,
    #[serde(default)]
    pub snooze_min: i64,
    #[serde(default)]
    pub enabled: i64,
    #[serde(default)]
    pub rev: i64,
    #[serde(default)]
    pub updated_at: i64,
    #[serde(default)]
    pub deleted: i64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CompletionRec {
    pub task_id: String,
    pub period_start: String,
    #[serde(default)]
    pub status: i64,
    #[serde(default)]
    pub rev: i64,
    #[serde(default)]
    pub updated_at: i64,
    #[serde(default)]
    pub deleted: i64,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct PushBody {
    #[serde(default)]
    pub rules: Vec<RuleRec>,
    #[serde(default)]
    pub tasks: Vec<TaskRec>,
    #[serde(default)]
    pub memos: Vec<MemoRec>,
    #[serde(default)]
    pub reminders: Vec<ReminderRec>,
    #[serde(default)]
    pub completions: Vec<CompletionRec>,
}

impl PushBody {
    pub fn len(&self) -> usize {
        self.rules.len() + self.tasks.len() + self.memos.len() + self.reminders.len()
            + self.completions.len()
    }
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

#[derive(Clone, Debug, Default, Deserialize)]
pub struct Accepted {
    #[serde(default)]
    pub rules: i64,
    #[serde(default)]
    pub tasks: i64,
    #[serde(default)]
    pub memos: i64,
    #[serde(default)]
    pub reminders: i64,
    #[serde(default)]
    pub completions: i64,
}

impl Accepted {
    pub fn total(&self) -> i64 {
        self.rules + self.tasks + self.memos + self.reminders + self.completions
    }
}

#[derive(Clone, Debug, Default, Deserialize)]
pub struct PushResp {
    #[serde(default)]
    pub accepted: Accepted,
    /// 协议字段（契约 §7.1）：push 后服务端的新 maxRev。客户端靠 pull 拿 rev，
    /// 所以这里只做字段完整性，不参与逻辑。
    #[allow(dead_code)]
    #[serde(default, rename = "maxRev")]
    pub max_rev: i64,
}

#[derive(Clone, Debug, Default, Deserialize)]
pub struct PullResp {
    #[serde(default)]
    pub rules: Vec<RuleRec>,
    #[serde(default)]
    pub tasks: Vec<TaskRec>,
    #[serde(default)]
    pub memos: Vec<MemoRec>,
    #[serde(default)]
    pub reminders: Vec<ReminderRec>,
    #[serde(default)]
    pub completions: Vec<CompletionRec>,
    #[serde(default, rename = "maxRev")]
    pub max_rev: i64,
    #[serde(default, rename = "hasMore")]
    pub has_more: bool,
}

/* ---------- 编辑载荷与判定（契约 §9） ---------- */

/// 规则编辑载荷：create / update 共用。
/// update 时 `id` 指向被改的规则，`new_id` 是裂开后新规则的 id（客户端生成，契约 §9.2）。
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct RuleInput {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub title: String,
    #[serde(default = "yes")]
    pub enabled: bool,
    #[serde(default)]
    pub repeat_mode: i64,
    #[serde(default)]
    pub weekdays_mask: i64,
    #[serde(default)]
    pub repeat_every: i64,
    #[serde(default)]
    pub month_day: i64,
    #[serde(default)]
    pub year_month: i64,
    #[serde(default)]
    pub year_day: i64,
    #[serde(default)]
    pub start_date: String,
    #[serde(default)]
    pub end_date: String,
    #[serde(default)]
    pub new_id: String,
}

fn yes() -> bool {
    true
}

/// 空字符串写成 SQL NULL（end_date / repeat_until 的空值语义是「不限」）
fn empty_to_null(s: &str) -> Option<&str> {
    let t = s.trim();
    if t.is_empty() {
        None
    } else {
        Some(t)
    }
}

/// 契约 §9.2 的裂开判定 —— **这就是唯一判定入口**。
///
/// 只比「与当前 repeat_mode 相关」的字段，外加 repeat_mode 本身与 start_date：
///   mode 0 每周     → weekdays_mask
///   mode 1 每 N 天  → repeat_every
///   mode 2 每月     → month_day
///   mode 3 每年     → year_month / year_day
///   mode 4 不重复   → （除 start_date 外没有字段）
///
/// 为什么必须按模式过滤：表单里与当前模式无关的字段常年带着占位默认值，
/// 「改成每月填 15 日 → 又改回每周」时 repeat_mode 回到 0（与库里一致），
/// 但草稿里的 month_day 还是 15，而 weekly 的 month_day 本就无效 ——
/// 拿它跟库里的 0 比会白白裂开一条规则（与 Android 端同一个口径）。
/// `title` / `enabled` / 提醒设置 / `end_date` 变化一律原地改，不裂开；
/// 同一份设置重放永远是 false，所以同一份设置不会被裂开两次。
pub fn needs_split(current: &RuleRow, incoming: &RuleInput) -> bool {
    if current.repeat_mode != incoming.repeat_mode || current.start_date != incoming.start_date {
        return true;
    }
    match current.repeat_mode {
        0 => current.weekdays_mask != incoming.weekdays_mask,
        1 => current.repeat_every != incoming.repeat_every,
        2 => current.month_day != incoming.month_day,
        3 => current.year_month != incoming.year_month || current.year_day != incoming.year_day,
        _ => false,
    }
}

/// 契约 §9.1 的写入层校验：写之前严格拒绝，绝不落库（§3.4 表第一层）。
pub fn validate_rule(input: &RuleInput) -> Result<(), String> {
    if input.title.trim().is_empty() {
        return Err("规则名称不能为空".to_string());
    }
    engine::parse_date(&input.start_date)
        .map_err(|_| format!("开始日期必须是 YYYY-MM-DD：{:?}", input.start_date))?;
    if !input.end_date.trim().is_empty() {
        let end = engine::parse_date(&input.end_date)
            .map_err(|_| format!("结束日期必须是 YYYY-MM-DD：{:?}", input.end_date))?;
        let start = engine::parse_date(&input.start_date)?;
        if end < start {
            return Err(format!("结束日期不能早于开始日期：{} < {}", input.end_date, input.start_date));
        }
    }
    match input.repeat_mode {
        0 => {
            if input.weekdays_mask <= 0 || input.weekdays_mask > 0b111_1111 {
                return Err("每周重复至少要选一天（weekdays_mask 1..127）".to_string());
            }
        }
        1 => {
            if !(1..=3660).contains(&input.repeat_every) {
                return Err(format!("每 N 天的 N 必须在 1..3660，实际 {}", input.repeat_every));
            }
        }
        2 => {
            if !(input.month_day == -1 || (1..=31).contains(&input.month_day)) {
                return Err(format!("每月某日必须是 1..31 或 -1（最后一天），实际 {}", input.month_day));
            }
        }
        3 => {
            if !(1..=12).contains(&input.year_month) {
                return Err(format!("每年重复的月份必须在 1..12，实际 {}", input.year_month));
            }
            if !(1..=31).contains(&input.year_day) {
                return Err(format!("每年重复的日必须在 1..31，实际 {}", input.year_day));
            }
        }
        4 => {}
        _ => return Err(format!("repeat_mode 必须是 0..4，实际 {}", input.repeat_mode)),
    }
    Ok(())
}

/* ---------- 记事 / 倒数日 / 笔记本（契约 §10） ---------- */

pub const MEMO_NOTE: i64 = 0;
pub const MEMO_COUNTDOWN: i64 = 1;
pub const MEMO_NOTEBOOK: i64 = 2;
/// 笔记本的缺省分类（契约 §10.1，分类名就存在 category 字段里，不建分类表）
pub const MEMO_CAT_NONE: &str = "未分类";

/// memo 的存储视图（列表与文档式编辑页都用它）
#[derive(Clone, Debug, Serialize)]
pub struct MemoRow {
    pub id: String,
    pub kind: i64,
    pub title: String,
    pub content: String,
    pub start_date: String,
    pub end_date: String,
    pub category: String,
    pub updated_at: i64,
    /// 提醒摘要（契约 §11.3）；记事 / 倒数日可能挂提醒，笔记本永不挂
    pub reminder_summary: String,
}

/// memo 的编辑载荷：create / update 共用（update 时 id 必填）
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct MemoInput {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub kind: i64,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub content: String,
    #[serde(default)]
    pub start_date: String,
    #[serde(default)]
    pub end_date: String,
    #[serde(default)]
    pub category: String,
}

fn memo_date(raw: &str, what: &str) -> Result<Option<engine::Date>, String> {
    let t = raw.trim();
    if t.is_empty() {
        return Ok(None);
    }
    engine::parse_date(t)
        .map(Some)
        .map_err(|_| format!("{what}必须是 YYYY-MM-DD：{raw:?}"))
}

/// 契约 §10.1 的写入层校验：写之前严格拒绝，绝不落库（§3.4 表第一层）。
pub fn validate_memo(input: &MemoInput) -> Result<(), String> {
    if !(MEMO_NOTE..=MEMO_NOTEBOOK).contains(&input.kind) {
        return Err(format!("memo.kind 必须是 0/1/2，实际 {}", input.kind));
    }
    let title = input.title.trim();
    match input.kind {
        MEMO_NOTE => {
            if title.is_empty() {
                return Err("记事标题不能为空".to_string());
            }
            let start = memo_date(&input.start_date, "记事的开始日期")?;
            let end = memo_date(&input.end_date, "记事的结束日期")?;
            if end.is_some() && start.is_none() {
                return Err("记事填了结束日期就必须同时填开始日期".to_string());
            }
            if let (Some(s), Some(e)) = (start, end) {
                if e < s {
                    return Err(format!(
                        "记事的结束日期不能早于开始日期：{} < {}",
                        input.end_date, input.start_date
                    ));
                }
            }
        }
        MEMO_COUNTDOWN => {
            if title.is_empty() {
                return Err("倒数日标题不能为空".to_string());
            }
            if memo_date(&input.start_date, "倒数日的目标日")?.is_none() {
                return Err("倒数日必须填目标日（start_date）".to_string());
            }
            if memo_date(&input.end_date, "倒数日的结束日期")?.is_some() {
                return Err("倒数日没有结束日期".to_string());
            }
        }
        _ => {
            if title.is_empty() && input.content.trim().is_empty() {
                return Err("笔记本标题与正文不能都为空".to_string());
            }
            if memo_date(&input.start_date, "笔记本的开始日期")?.is_some()
                || memo_date(&input.end_date, "笔记本的结束日期")?.is_some()
            {
                return Err("笔记本没有日期，不会进月历".to_string());
            }
        }
    }
    Ok(())
}

/// 记事是否命中某一天（契约 §10.1）：不排期 = 永不出现；只有 start = 单日；两者都有 = 区间内每天。
pub fn memo_active_on(m: &MemoRow, date: &str) -> bool {
    if m.kind != MEMO_NOTE || m.start_date.is_empty() || date < m.start_date.as_str() {
        return false;
    }
    if m.end_date.is_empty() || m.end_date == m.start_date {
        date == m.start_date.as_str()
    } else {
        date <= m.end_date.as_str()
    }
}

/* ---------- 提醒：通知 + 闹钟两个独立开关（契约 §11） ---------- */

/// reminder.owner_kind：0=规则 1=记事 2=倒数日（注意与 memo.kind 的 0/1/2 不是一套编号）
pub const REMINDER_RULE: i64 = 0;
pub const REMINDER_NOTE: i64 = 1;
pub const REMINDER_COUNTDOWN: i64 = 2;

/// 提醒的存储视图。字段名照 docs/schema/reminder.schema.json：notify_on / alarm_on 是 0/1，
/// 因为「两个都关」是非法状态，写入层要能把「没开」和「没传」区分开（都当 0 拒掉，不静默变合法）。
#[derive(Clone, Debug, Serialize)]
pub struct ReminderRow {
    pub id: String,
    pub owner_kind: i64,
    pub owner_id: String,
    pub notify_on: i64,
    pub alarm_on: i64,
    pub time_of_day: String,
    pub notify_text: String,
    pub offset_days: i64,
    pub repeat_rule: i64,
    pub snooze_min: i64,
    pub enabled: i64,
    pub rev: i64,
    pub updated_at: i64,
    pub deleted: i64,
    pub dirty: i64,
}

/// 提醒的编辑载荷（save_reminder 的 reminder_json）
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ReminderInput {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub owner_kind: i64,
    #[serde(default)]
    pub owner_id: String,
    #[serde(default)]
    pub notify_on: i64,
    #[serde(default)]
    pub alarm_on: i64,
    #[serde(default)]
    pub time_of_day: String,
    #[serde(default)]
    pub notify_text: String,
    #[serde(default)]
    pub offset_days: i64,
    #[serde(default)]
    pub repeat_rule: i64,
    #[serde(default)]
    pub snooze_min: i64,
    #[serde(default = "one")]
    pub enabled: i64,
    /// 1 = 这次写的是墓碑（软删记录）。墓碑豁免「至少开一个通道」的校验（契约 §11.1）：
    /// 客户端删提醒时常常先把两个开关清零再打删除标记，若墓碑也校验，删除就永远同步不过去。
    #[serde(default)]
    pub deleted: i64,
}

fn one() -> i64 {
    1
}

/// 手写 Default 而不是 derive：derive 会把 enabled 归 0，程序里构造一条提醒就成了「停用的提醒」，
/// 摘要与同步都会跟着错；这里与 schema 的 default（enabled=1）对齐。
impl Default for ReminderInput {
    fn default() -> Self {
        ReminderInput {
            id: String::new(),
            owner_kind: REMINDER_RULE,
            owner_id: String::new(),
            notify_on: 0,
            alarm_on: 0,
            time_of_day: String::new(),
            notify_text: String::new(),
            offset_days: 0,
            repeat_rule: 0,
            snooze_min: 0,
            enabled: 1,
            deleted: 0,
        }
    }
}

fn on_off(v: i64) -> bool {
    v == 0 || v == 1
}

/// HH:mm（00:00~23:59），与 reminder.schema.json 的 pattern 同一口径
pub fn hhmm_ok(raw: &str) -> bool {
    let b = raw.as_bytes();
    if b.len() != 5 || b[2] != b':' {
        return false;
    }
    if !b.iter().enumerate().all(|(i, c)| i == 2 || c.is_ascii_digit()) {
        return false;
    }
    let hh = (b[0] - b'0') * 10 + (b[1] - b'0');
    let mm = (b[3] - b'0') * 10 + (b[4] - b'0');
    hh <= 23 && mm <= 59
}

/// 契约 §11 的写入层校验（§3.4 第一层）。最要紧的一条：两个开关都为 0 直接拒绝 ——
/// 「不提醒」不是一个可存的状态（schema 的 anyOf 也拦这个），要停就去软删该行。
pub fn validate_reminder(input: &ReminderInput) -> Result<(), String> {
    if !(REMINDER_RULE..=REMINDER_COUNTDOWN).contains(&input.owner_kind) {
        return Err(format!("reminder.owner_kind 必须是 0/1/2，实际 {}", input.owner_kind));
    }
    if input.owner_id.trim().is_empty() {
        return Err("reminder.owner_id 不能为空".to_string());
    }
    if !on_off(input.notify_on) || !on_off(input.alarm_on) {
        return Err(format!(
            "reminder 的 notify_on / alarm_on 只能是 0 或 1，实际 {} / {}",
            input.notify_on, input.alarm_on
        ));
    }
    // 墓碑（deleted=1）豁免这条：删除时两个开关被清零是正常的删除前置动作，拦了删除就同步不出去
    if input.deleted != 1 && input.notify_on == 0 && input.alarm_on == 0 {
        return Err(
            "提醒至少要开一个通道（通知或闹钟）：两个开关都为 0 是非法状态，想不提醒请软删这一行或置 enabled=0"
                .to_string(),
        );
    }
    if !hhmm_ok(input.time_of_day.trim()) {
        return Err(format!("提醒时间必须是 HH:mm（00:00~23:59），实际 {:?}", input.time_of_day));
    }
    if input.notify_text.chars().count() > 60 {
        return Err("通知文案最多 60 字".to_string());
    }
    if !(-30..=30).contains(&input.offset_days) {
        return Err(format!("offset_days 必须在 -30..30，实际 {}", input.offset_days));
    }
    if !(0..=60).contains(&input.snooze_min) {
        return Err(format!("snooze_min 必须在 0..60，实际 {}", input.snooze_min));
    }
    if !on_off(input.repeat_rule) || !on_off(input.enabled) {
        return Err("reminder 的 repeat_rule / enabled 只能是 0 或 1".to_string());
    }
    Ok(())
}

/// 列表摘要（契约 §11.3）：「通知 21:00 + 闹钟 21:00」。
/// 未启用或已软删 → 空串（列表上不显示提醒，R3 的界面侧断言）。
/// 两个通道共用一个 time_of_day（schema 只有这一个时间字段，Go 后端 SyncReminder 与
/// Android 的 ReminderFormat 同一口径），所以同时开时两段显示同一时刻。
pub fn reminder_summary(row: &ReminderRow) -> String {
    let time = row.time_of_day.trim();
    if row.deleted == 1 || row.enabled != 1 || time.is_empty() {
        return String::new();
    }
    let mut parts: Vec<String> = Vec::new();
    if row.notify_on == 1 {
        parts.push(format!("通知 {time}"));
    }
    if row.alarm_on == 1 {
        parts.push(format!("闹钟 {time}"));
    }
    parts.join(" + ")
}

/// memo.kind（0=记事 1=倒数日 2=笔记本）→ reminder.owner_kind。笔记本永不挂提醒。
pub fn reminder_owner_kind_of_memo(kind: i64) -> Option<i64> {
    match kind {
        MEMO_NOTE => Some(REMINDER_NOTE),
        MEMO_COUNTDOWN => Some(REMINDER_COUNTDOWN),
        _ => None,
    }
}

fn reminder_from_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<ReminderRow> {
    Ok(ReminderRow {
        id: r.get(0)?,
        owner_kind: r.get(1)?,
        owner_id: r.get(2)?,
        notify_on: r.get(3)?,
        alarm_on: r.get(4)?,
        time_of_day: r.get(5)?,
        notify_text: r.get(6)?,
        offset_days: r.get(7)?,
        repeat_rule: r.get(8)?,
        snooze_min: r.get(9)?,
        enabled: r.get(10)?,
        rev: r.get(11)?,
        updated_at: r.get(12)?,
        deleted: r.get(13)?,
        dirty: r.get(14)?,
    })
}

const REMINDER_COLS: &str = "id,owner_kind,owner_id,notify_on,alarm_on,time_of_day,\
     COALESCE(notify_text,''),offset_days,repeat_rule,snooze_min,enabled,rev,updated_at,deleted,dirty";

/// update_rule 的返回：是否裂开、旧规则 id、新规则 id、旧规则最终的上界
#[derive(Clone, Debug, Serialize)]
pub struct UpdateResult {
    pub split: bool,
    pub old_rule_id: String,
    pub new_rule_id: Option<String>,
    pub old_repeat_until: String,
}

/// delete_rule 的返回
#[derive(Clone, Debug, Serialize)]
pub struct DeleteRuleResult {
    pub rule_id: String,
    pub tasks_deleted: usize,
}

pub struct Db {
    conn: Mutex<Connection>,
}

impl Db {
    pub fn open(path: &Path) -> Result<Db, String> {
        let conn = Connection::open(path).map_err(|e| format!("打开 SQLite 失败：{e}"))?;
        Self::init(conn)
    }

    /// 内存库（测试用）
    #[cfg(test)]
    pub fn open_in_memory() -> Result<Db, String> {
        let conn = Connection::open_in_memory().map_err(|e| format!("打开内存库失败：{e}"))?;
        Self::init(conn)
    }

    fn init(conn: Connection) -> Result<Db, String> {
        conn.execute_batch(SCHEMA).map_err(|e| format!("建表失败：{e}"))?;
        conn.execute_batch(LOCAL_SCHEMA)
            .map_err(|e| format!("建本地状态表失败：{e}"))?;
        let db = Db { conn: Mutex::new(conn) };
        db.seed_if_empty().map_err(|e| format!("写入种子失败：{e}"))?;
        Ok(db)
    }

    fn lock(&self) -> Result<std::sync::MutexGuard<'_, Connection>, String> {
        self.conn.lock().map_err(|_| "数据库互斥锁已中毒".to_string())
    }

    /// 只在 rule 表为空时写种子，避免每次启动重复插入。
    fn seed_if_empty(&self) -> rusqlite::Result<()> {
        let mut conn = self.conn.lock().expect("首次初始化不会中毒");
        let n: i64 = conn.query_row("SELECT COUNT(1) FROM rule", [], |r| r.get(0))?;
        if n > 0 {
            return Ok(());
        }
        let tx = conn.transaction()?;
        let ts = now_ms();
        // 与 Go 后端 ensureSeed 完全一致：4 条规则 / 5 个任务
        let seeds: Vec<(&str, &str, i64, i64, i64, i64, i64, i64, &str, Vec<(&str, &str)>)> = vec![
            ("r_work", "工作日常规", 0, 31, 0, 0, 0, 0, "2026-10-01", vec![("t_fit", "健身"), ("t_early", "早起")]),
            ("r_words", "单词打卡", 1, 0, 1, 0, 0, 0, "2026-10-01", vec![("t_words", "背单词")]),
            ("r_rent", "房租", 2, 0, 0, 20, 0, 0, "2026-01-01", vec![("t_rent", "交房租")]),
            ("r_med", "年度体检", 3, 0, 0, 0, 3, 15, "2026-01-01", vec![("t_med", "体检")]),
        ];
        for (id, title, mode, mask, every, mday, ymonth, yday, start, tasks) in seeds {
            tx.execute(
                "INSERT INTO rule (id,title,enabled,repeat_mode,weekdays_mask,repeat_every,month_day,year_month,year_day,\
                 start_date,end_date,repeat_until,rev,updated_at,deleted,dirty) \
                 VALUES (?1,?2,1,?3,?4,?5,?6,?7,?8,?9,NULL,NULL,0,?10,0,0)",
                params![id, title, mode, mask, every, mday, ymonth, yday, start, ts],
            )?;
            for (i, (tid, ttitle)) in tasks.iter().enumerate() {
                tx.execute(
                    "INSERT INTO task (id,rule_id,title,enabled,sort_order,rev,updated_at,deleted,dirty) \
                     VALUES (?1,?2,?3,1,?4,0,?5,0,0)",
                    params![tid, id, ttitle, i as i64, ts],
                )?;
            }
        }
        // 演示打卡：本周（2026-10-19 起）的「健身」已完成
        tx.execute(
            "INSERT INTO completion (task_id,period_start,status,rev,updated_at,deleted,dirty) \
             VALUES ('t_fit','2026-10-19',1,0,?1,0,0)",
            params![ts],
        )?;
        tx.commit()
    }

    /// 本地「今天」（'YYYY-MM-DD'）。不引时区依赖：所有写命令都由前端显式传 today，
    /// 这里的 UTC 兜底只在直接调用（测试 / 命令行）时用得上。
    pub(crate) fn today_or_utc(today: Option<&str>) -> String {
        match today.map(str::trim).filter(|s| !s.is_empty()) {
            Some(t) => t.to_string(),
            None => {
                let secs = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_secs() as i64)
                    .unwrap_or(0);
                engine::key(engine::from_serial(secs.div_euclid(86_400)))
            }
        }
    }

    /// 未删除的规则 + 其下未删除的任务（按 start_date, title 排序，同 Go），并标出 ended。
    /// 月历展开必须用全量版本：否则已结束规则的历史会从旧月份里凭空消失。
    fn rules_with_tasks(&self, today: &str) -> Result<Vec<RuleRow>, String> {
        let conn = self.lock()?;
        let mut stmt = conn
            .prepare(
                "SELECT id,title,enabled,repeat_mode,weekdays_mask,COALESCE(repeat_every,0),\
                 COALESCE(month_day,0),COALESCE(year_month,0),COALESCE(year_day,0),\
                 start_date,COALESCE(end_date,''),COALESCE(repeat_until,'') \
                 FROM rule WHERE deleted=0 ORDER BY start_date, title",
            )
            .map_err(|e| e.to_string())?;
        let mut rules: Vec<RuleRow> = stmt
            .query_map([], |r| {
                Ok(RuleRow {
                    id: r.get(0)?,
                    title: r.get(1)?,
                    enabled: r.get::<_, i64>(2)? == 1,
                    repeat_mode: r.get(3)?,
                    weekdays_mask: r.get(4)?,
                    repeat_every: r.get(5)?,
                    month_day: r.get(6)?,
                    year_month: r.get(7)?,
                    year_day: r.get(8)?,
                    start_date: r.get(9)?,
                    end_date: r.get(10)?,
                    repeat_until: r.get(11)?,
                    ended: false,
                    tasks: Vec::new(),
                    reminder_summary: String::new(),
                })
            })
            .map_err(|e| e.to_string())?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|e| e.to_string())?;

        let mut tstmt = conn
            .prepare(
                "SELECT id,rule_id,title,enabled,sort_order FROM task WHERE deleted=0 \
                 ORDER BY rule_id, sort_order",
            )
            .map_err(|e| e.to_string())?;
        let tasks: Vec<TaskRow> = tstmt
            .query_map([], |r| {
                Ok(TaskRow {
                    id: r.get(0)?,
                    rule_id: r.get(1)?,
                    title: r.get(2)?,
                    enabled: r.get::<_, i64>(3)? == 1,
                    sort_order: r.get(4)?,
                })
            })
            .map_err(|e| e.to_string())?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|e| e.to_string())?;

        let reminders = Db::reminder_summaries(&conn)?;
        for rule in &mut rules {
            rule.tasks = tasks.iter().filter(|t| t.rule_id == rule.id).cloned().collect();
            rule.reminder_summary = reminders
                .get(&(REMINDER_RULE, rule.id.clone()))
                .cloned()
                .unwrap_or_default();
            let ended = {
                let upper = if !rule.repeat_until.is_empty() { &rule.repeat_until } else { &rule.end_date };
                !upper.is_empty() && upper.as_str() < today
            };
            rule.ended = ended;
        }
        Ok(rules)
    }

    /// 全量规则（含已结束）：月历展开与打卡回填用，不能过滤
    pub fn all_rules(&self) -> Result<Vec<RuleRow>, String> {
        self.rules_with_tasks(&Db::today_or_utc(None))
    }

    /// UI 规则列表：默认只返回未结束的；include_ended=true 时连历史一起返回（契约 §9.2）
    pub fn list_rules(&self, include_ended: bool) -> Result<Vec<RuleRow>, String> {
        self.list_rules_at(include_ended, None)
    }

    pub fn list_rules_at(&self, include_ended: bool, today: Option<&str>) -> Result<Vec<RuleRow>, String> {
        let t = Db::today_or_utc(today);
        let mut rows = self.rules_with_tasks(&t)?;
        if !include_ended {
            rows.retain(|r| !r.ended);
        }
        Ok(rows)
    }

    /// (task_id + ':' + period_start) → 已完成
    fn done_set(&self) -> Result<HashMap<String, bool>, String> {
        let conn = self.lock()?;
        let mut stmt = conn
            .prepare("SELECT task_id,period_start FROM completion WHERE deleted=0 AND status=1")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            .map_err(|e| e.to_string())?;
        let mut m = HashMap::new();
        for row in rows {
            let (t, p) = row.map_err(|e| e.to_string())?;
            m.insert(format!("{t}:{p}"), true);
        }
        Ok(m)
    }

    /// 该月每天命中的任务（按日期升序）。打卡状态按 (task_id, period_start) 查，
    /// 所以同一周期内所有命中日共享同一状态（契约 §3.3）。
    pub fn month_grid(&self, y: i32, m: u32) -> Result<MonthGrid, String> {
        if !(1970..=9999).contains(&y) || !(1..=12).contains(&m) {
            return Err(format!("参数应为 y=1970..9999 & m=1..12，实际 y={y} m={m}"));
        }
        let rules = self.all_rules()?;
        let done = self.done_set()?;
        let memos = self.memo_rows()?;
        let total = engine::days_in_month(y, m);
        let mut days = Vec::with_capacity(total as usize);
        for d in 1..=total {
            days.push(expand_day(&rules, &done, &memos, engine::Date { y, m, d }));
        }
        Ok(MonthGrid { year: y, month: m, days })
    }

    /// 任意起止日期区间的逐日展开（含首尾）。滚动月历一次要覆盖前后各 12 个月的
    /// 连续周，按月拉会切出断层，所以按区间一次给齐；口径与 month_grid 完全一致。
    pub fn range_grid(&self, from: &str, to: &str) -> Result<Vec<Day>, String> {
        let start = engine::parse_date(from)?;
        let end = engine::parse_date(to)?;
        if end < start {
            return Err(format!("区间起止颠倒：from={from} to={to}"));
        }
        let span = engine::days_between(start, end);
        // 上限 4000 天（约 11 年）：再大的区间是调用方写错了，别把内存吃满
        if span > 4000 {
            return Err(format!("区间过大（{span} 天，上限 4000）：from={from} to={to}"));
        }
        let rules = self.all_rules()?;
        let done = self.done_set()?;
        let memos = self.memo_rows()?;
        let mut days = Vec::with_capacity((span + 1) as usize);
        for i in 0..=span {
            days.push(expand_day(&rules, &done, &memos, engine::add_days(start, i)));
        }
        Ok(days)
    }

    /// 某一天（'YYYY-MM-DD'）的展开数据。打卡后用它回填面板。
    pub fn day(&self, date_key: &str) -> Result<Day, String> {
        let date = engine::parse_date(date_key)?;
        let rules = self.all_rules()?;
        let done = self.done_set()?;
        let memos = self.memo_rows()?;
        Ok(expand_day(&rules, &done, &memos, date))
    }

    /// 打卡写路径：写 (task_id, period_start) 的 status，updated_at 取当前毫秒，dirty=1，rev 保持。
    /// 同一周期内所有命中日共享这一行，所以整周格子会一起变（契约 §3.3 / §3.5 #12）。
    pub fn toggle_done(&self, task_id: &str, period_start: &str, done: bool) -> Result<ToggleResult, String> {
        // 写入层严格校验（契约 §3.4）：非法日期必须在写之前拒绝，不能落库
        if engine::parse_date(period_start).is_err() {
            return Err(format!("period_start 必须是 YYYY-MM-DD：{period_start:?}"));
        }
        let (rev, updated_at) = {
            let conn = self.lock()?;
            let exists: i64 = conn
                .query_row(
                    "SELECT COUNT(1) FROM task WHERE id=?1 AND deleted=0",
                    params![task_id],
                    |r| r.get(0),
                )
                .map_err(|e| e.to_string())?;
            if exists == 0 {
                return Err(format!("任务不存在或已删除：{task_id}"));
            }
            let ts = now_ms();
            // rev 保持：冲突行只改 status / updated_at / dirty，绝不重置 rev
            conn.execute(
                "INSERT INTO completion (task_id,period_start,status,rev,updated_at,deleted,dirty) \
                 VALUES (?1,?2,?3,0,?4,0,1) \
                 ON CONFLICT(task_id,period_start) DO UPDATE SET \
                   status=excluded.status, updated_at=excluded.updated_at, deleted=0, dirty=1",
                params![task_id, period_start, if done { 1 } else { 0 }, ts],
            )
            .map_err(|e| e.to_string())?;
            conn.query_row(
                "SELECT rev,updated_at FROM completion WHERE task_id=?1 AND period_start=?2",
                params![task_id, period_start],
                |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?)),
            )
            .map_err(|e| e.to_string())?
        };
        let day = self.day(period_start)?;
        Ok(ToggleResult {
            task_id: task_id.to_string(),
            period_start: period_start.to_string(),
            done,
            rev,
            updated_at,
            dirty: true,
            day,
        })
    }

    /// 只给测试用：与 toggle_done 同一条写路径。
    #[cfg(test)]
    pub fn set_done(&self, task_id: &str, period_start: &str, done: bool) -> Result<(), String> {
        self.toggle_done(task_id, period_start, done).map(|_| ())
    }

    /* ---------- 写路径：规则与任务增删改（契约 §9） ---------- */

    /// 客户端 id（契约 §9.1「id 客户端生成」；缺省时后端补一个）
    fn gen_id(prefix: &str) -> String {
        use std::sync::atomic::{AtomicU64, Ordering};
        static SEQ: AtomicU64 = AtomicU64::new(0);
        let n = SEQ.fetch_add(1, Ordering::Relaxed);
        format!("{}_{:x}{:02x}", prefix, now_ms(), n & 0xff)
    }

    fn any_rule_id(conn: &Connection, id: &str) -> Result<bool, String> {
        let n: i64 = conn
            .query_row("SELECT COUNT(1) FROM rule WHERE id=?1", params![id], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        Ok(n > 0)
    }

    fn rule_by_id(conn: &Connection, id: &str) -> Result<Option<RuleRow>, String> {
        let mut stmt = conn
            .prepare(
                "SELECT id,title,enabled,repeat_mode,weekdays_mask,COALESCE(repeat_every,0),\
                 COALESCE(month_day,0),COALESCE(year_month,0),COALESCE(year_day,0),\
                 start_date,COALESCE(end_date,''),COALESCE(repeat_until,'') \
                 FROM rule WHERE id=?1 AND deleted=0",
            )
            .map_err(|e| e.to_string())?;
        let mut rows = stmt.query(params![id]).map_err(|e| e.to_string())?;
        match rows.next().map_err(|e| e.to_string())? {
            Some(r) => Ok(Some(RuleRow {
                id: r.get(0).map_err(|e| e.to_string())?,
                title: r.get(1).map_err(|e| e.to_string())?,
                enabled: r.get::<_, i64>(2).map_err(|e| e.to_string())? == 1,
                repeat_mode: r.get(3).map_err(|e| e.to_string())?,
                weekdays_mask: r.get(4).map_err(|e| e.to_string())?,
                repeat_every: r.get(5).map_err(|e| e.to_string())?,
                month_day: r.get(6).map_err(|e| e.to_string())?,
                year_month: r.get(7).map_err(|e| e.to_string())?,
                year_day: r.get(8).map_err(|e| e.to_string())?,
                start_date: r.get(9).map_err(|e| e.to_string())?,
                end_date: r.get(10).map_err(|e| e.to_string())?,
                repeat_until: r.get(11).map_err(|e| e.to_string())?,
                ended: false,
                tasks: Vec::new(),
                reminder_summary: String::new(),
            })),
            None => Ok(None),
        }
    }

    /// 新增规则（契约 §9.1）：校验 → 写规则 + 其下任务，全部 dirty=1。
    pub fn create_rule(&self, input: &RuleInput, task_titles: &[String], ts: i64) -> Result<String, String> {
        validate_rule(input)?;
        let titles: Vec<String> = task_titles
            .iter()
            .map(|t| t.trim().to_string())
            .filter(|t| !t.is_empty())
            .collect();
        if titles.is_empty() {
            return Err("一条规则至少要有一个任务（契约 §9.1）".to_string());
        }
        let id = if input.id.trim().is_empty() {
            Db::gen_id("r")
        } else {
            input.id.trim().to_string()
        };
        let mut conn = self.lock()?;
        if Db::any_rule_id(&conn, &id)? {
            return Err(format!("规则 id 已存在：{id}"));
        }
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        tx.execute(
            "INSERT INTO rule (id,title,enabled,repeat_mode,weekdays_mask,repeat_every,month_day,\
             year_month,year_day,start_date,end_date,repeat_until,rev,updated_at,deleted,dirty) \
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,NULL,0,?12,0,1)",
            params![
                id,
                input.title.trim(),
                if input.enabled { 1 } else { 0 },
                input.repeat_mode,
                input.weekdays_mask,
                input.repeat_every,
                input.month_day,
                input.year_month,
                input.year_day,
                input.start_date,
                empty_to_null(&input.end_date),
                ts
            ],
        )
        .map_err(|e| e.to_string())?;
        for (i, title) in titles.iter().enumerate() {
            tx.execute(
                "INSERT INTO task (id,rule_id,title,enabled,sort_order,rev,updated_at,deleted,dirty) \
                 VALUES (?1,?2,?3,1,?4,0,?5,0,1)",
                params![Db::gen_id("t"), id, title, i as i64, ts],
            )
            .map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())?;
        Ok(id)
    }

    /// 修改规则（契约 §9.2）：重复设置变了就裂开，否则原地改。
    ///
    /// 裂开的做法：旧规则 repeat_until = 昨天（原地改、刷 updated_at），
    /// 新规则 id 由客户端给、start_date = 今天、承载新设置；
    /// 旧规则下的任务与 completion 一条不动，新规则建出来时是空任务列表。
    pub fn update_rule(&self, input: &RuleInput, today: Option<&str>, ts: i64) -> Result<UpdateResult, String> {
        validate_rule(input)?;
        let today_key = Db::today_or_utc(today);
        let today_date = engine::parse_date(&today_key)?;
        let yesterday = engine::key(engine::add_days(today_date, -1));
        let id = input.id.trim().to_string();
        if id.is_empty() {
            return Err("update_rule 需要规则 id".to_string());
        }
        let mut conn = self.lock()?;
        let current = Db::rule_by_id(&conn, &id)?
            .ok_or_else(|| format!("规则不存在或已删除：{id}"))?;

        if !needs_split(&current, input) {
            // 原地改：只动 title / enabled / end_date，命中日不变，历史天然保留
            let tx = conn.transaction().map_err(|e| e.to_string())?;
            tx.execute(
                "UPDATE rule SET title=?1, enabled=?2, end_date=?3, updated_at=?4, dirty=1 WHERE id=?5",
                params![
                    input.title.trim(),
                    if input.enabled { 1 } else { 0 },
                    empty_to_null(&input.end_date),
                    ts,
                    id
                ],
            )
            .map_err(|e| e.to_string())?;
            tx.commit().map_err(|e| e.to_string())?;
            return Ok(UpdateResult {
                split: false,
                old_rule_id: id,
                new_rule_id: None,
                old_repeat_until: current.repeat_until,
            });
        }

        // ---- 裂开 ----
        // 防重复裂开之二：已结束的规则不允许再改重复设置，否则会再裂一次、把历史洗掉
        let upper = if !current.repeat_until.is_empty() {
            current.repeat_until.clone()
        } else {
            current.end_date.clone()
        };
        if !upper.is_empty() && upper.as_str() < today_key.as_str() {
            return Err(format!(
                "规则「{}」已于 {} 结束，重复设置不可再改（改了会重算历史命中日）；要换设置请新建一条规则",
                current.title, upper
            ));
        }
        let new_id = if input.new_id.trim().is_empty() {
            Db::gen_id("r")
        } else {
            input.new_id.trim().to_string()
        };
        if new_id == id {
            return Err("新规则 id 不能与旧规则相同".to_string());
        }
        // 防重复裂开之三：同一份请求重放时 id 已存在，直接拒绝而不是再插一条
        let dup: i64 = conn
            .query_row("SELECT COUNT(1) FROM rule WHERE id=?1", params![new_id], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        if dup > 0 {
            return Err(format!("新规则 id 已存在，已停止裂开以免重复：{new_id}"));
        }

        // 旧规则收尾：只在「现有上界为空或晚于昨天」时写 repeat_until = 昨天；
        // 已有更早的上界则不覆盖（否则等于把已结束的规则往后延长，契约 §9.2）
        let old_until = if upper.is_empty() || upper.as_str() >= yesterday.as_str() {
            yesterday.clone()
        } else {
            upper.clone()
        };

        let tx = conn.transaction().map_err(|e| e.to_string())?;
        if old_until == yesterday {
            tx.execute(
                "UPDATE rule SET repeat_until=?1, updated_at=?2, dirty=1 WHERE id=?3",
                params![old_until, ts, id],
            )
            .map_err(|e| e.to_string())?;
        } else {
            tx.execute(
                "UPDATE rule SET updated_at=?1, dirty=1 WHERE id=?2",
                params![ts, id],
            )
            .map_err(|e| e.to_string())?;
        }
        // 新规则：承载新设置，start_date = 今天（不是表单里的值），无任务、无上界
        tx.execute(
            "INSERT INTO rule (id,title,enabled,repeat_mode,weekdays_mask,repeat_every,month_day,\
             year_month,year_day,start_date,end_date,repeat_until,rev,updated_at,deleted,dirty) \
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,NULL,0,?12,0,1)",
            params![
                new_id,
                input.title.trim(),
                if input.enabled { 1 } else { 0 },
                input.repeat_mode,
                input.weekdays_mask,
                input.repeat_every,
                input.month_day,
                input.year_month,
                input.year_day,
                today_key,
                empty_to_null(&input.end_date),
                ts
            ],
        )
        .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(UpdateResult {
            split: true,
            old_rule_id: id,
            new_rule_id: Some(new_id),
            old_repeat_until: old_until,
        })
    }

    /// 删除规则（契约 §9.3）：规则 + 其下所有任务 + 该规则的提醒一并软删；completion 一条不删。
    /// 提醒必须跟着走：规则没了提醒就没意义，留下就是指向已删规则的孤儿行（还占同步流量，
    /// 将来若做「恢复规则」会把旧提醒意外带回来）。
    pub fn delete_rule(&self, id: &str, ts: i64) -> Result<DeleteRuleResult, String> {
        let mut conn = self.lock()?;
        if Db::rule_by_id(&conn, id)?.is_none() {
            return Err(format!("规则不存在或已删除：{id}"));
        }
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        tx.execute(
            "UPDATE rule SET deleted=1, updated_at=?1, dirty=1 WHERE id=?2 AND deleted=0",
            params![ts, id],
        )
        .map_err(|e| e.to_string())?;
        let tasks_deleted = tx
            .execute(
                "UPDATE task SET deleted=1, updated_at=?1, dirty=1 WHERE rule_id=?2 AND deleted=0",
                params![ts, id],
            )
            .map_err(|e| e.to_string())?;
        // 提醒随规则一起软删（§9.3），不是物理删：墓碑要能被 push 出去，另一端才跟着删
        tx.execute(
            "UPDATE reminder SET deleted=1, updated_at=?1, dirty=1 \
             WHERE owner_kind=?2 AND owner_id=?3 AND deleted=0",
            params![ts, REMINDER_RULE, id],
        )
        .map_err(|e| e.to_string())?;
        // 打卡记录是历史事实，不删（删了会被另一端同步回来「复活」）
        tx.commit().map_err(|e| e.to_string())?;
        Ok(DeleteRuleResult { rule_id: id.to_string(), tasks_deleted })
    }

    /// 新增任务（契约 §9.4）：sort_order 取当前最大值 +1
    pub fn add_task(&self, rule_id: &str, title: &str, ts: i64) -> Result<TaskRow, String> {
        let t = title.trim().to_string();
        if t.is_empty() {
            return Err("任务名不能为空".to_string());
        }
        let mut conn = self.lock()?;
        if Db::rule_by_id(&conn, rule_id)?.is_none() {
            return Err(format!("规则不存在或已删除：{rule_id}"));
        }
        let sort_order: i64 = conn
            .query_row(
                "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM task WHERE rule_id=?1",
                params![rule_id],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        let id = Db::gen_id("t");
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        tx.execute(
            "INSERT INTO task (id,rule_id,title,enabled,sort_order,rev,updated_at,deleted,dirty) \
             VALUES (?1,?2,?3,1,?4,0,?5,0,1)",
            params![id, rule_id, t, sort_order, ts],
        )
        .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(TaskRow { id, rule_id: rule_id.to_string(), title: t, enabled: true, sort_order })
    }

    pub fn rename_task(&self, task_id: &str, title: &str, ts: i64) -> Result<(), String> {
        let t = title.trim().to_string();
        if t.is_empty() {
            return Err("任务名不能为空".to_string());
        }
        let conn = self.lock()?;
        let n = conn
            .execute(
                "UPDATE task SET title=?1, updated_at=?2, dirty=1 WHERE id=?3 AND deleted=0",
                params![t, ts, task_id],
            )
            .map_err(|e| e.to_string())?;
        if n == 0 {
            return Err(format!("任务不存在或已删除：{task_id}"));
        }
        Ok(())
    }

    pub fn set_task_enabled(&self, task_id: &str, enabled: bool, ts: i64) -> Result<(), String> {
        let conn = self.lock()?;
        let n = conn
            .execute(
                "UPDATE task SET enabled=?1, updated_at=?2, dirty=1 WHERE id=?3 AND deleted=0",
                params![if enabled { 1 } else { 0 }, ts, task_id],
            )
            .map_err(|e| e.to_string())?;
        if n == 0 {
            return Err(format!("任务不存在或已删除：{task_id}"));
        }
        Ok(())
    }

    /// 删除任务（契约 §9.4）：软删任务，它名下的打卡记录同样不删
    pub fn delete_task(&self, task_id: &str, ts: i64) -> Result<(), String> {
        let conn = self.lock()?;
        let n = conn
            .execute(
                "UPDATE task SET deleted=1, updated_at=?1, dirty=1 WHERE id=?2 AND deleted=0",
                params![ts, task_id],
            )
            .map_err(|e| e.to_string())?;
        if n == 0 {
            return Err(format!("任务不存在或已删除：{task_id}"));
        }
        Ok(())
    }

    /* ---------- 写路径：记事 / 倒数日 / 笔记本（契约 §10） ---------- */

    /// 未删的全部 memo（按 kind, updated_at 倒序之外一律按 kind + updated_at 升序，列表稳定）
    fn memo_rows(&self) -> Result<Vec<MemoRow>, String> {
        let conn = self.lock()?;
        let reminders = Db::reminder_summaries(&conn)?;
        let mut stmt = conn
            .prepare(
                "SELECT id,kind,title,COALESCE(content,''),COALESCE(start_date,''),\
                 COALESCE(end_date,''),COALESCE(category,''),updated_at \
                 FROM memo WHERE deleted=0 ORDER BY kind, updated_at",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| {
                Ok(MemoRow {
                    id: r.get(0)?,
                    kind: r.get(1)?,
                    title: r.get(2)?,
                    content: r.get(3)?,
                    start_date: r.get(4)?,
                    end_date: r.get(5)?,
                    category: r.get(6)?,
                    updated_at: r.get(7)?,
                    reminder_summary: String::new(),
                })
            })
            .map_err(|e| e.to_string())?;
        let mut rows: Vec<MemoRow> =
            rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?;
        for m in &mut rows {
            m.reminder_summary = reminder_owner_kind_of_memo(m.kind)
                .and_then(|k| reminders.get(&(k, m.id.clone())).cloned())
                .unwrap_or_default();
        }
        Ok(rows)
    }

    /// list_memos(kind)：按 kind 过滤，返回未删的行（契约 §10.1 的三类）
    pub fn list_memos(&self, kind: Option<i64>) -> Result<Vec<MemoRow>, String> {
        if let Some(k) = kind {
            if !(MEMO_NOTE..=MEMO_NOTEBOOK).contains(&k) {
                return Err(format!("memo.kind 必须是 0/1/2，实际 {k}"));
            }
        }
        let mut rows = self.memo_rows()?;
        if let Some(k) = kind {
            rows.retain(|r| r.kind == k);
        }
        Ok(rows)
    }

    /// 笔记本的分类归一：空 → 未分类（契约 §10.1）
    fn memo_category(kind: i64, raw: &str) -> Option<String> {
        if kind != MEMO_NOTEBOOK {
            return None;
        }
        let t = raw.trim();
        Some(if t.is_empty() { MEMO_CAT_NONE.to_string() } else { t.to_string() })
    }

    /// 新增 memo（契约 §10）：校验 → 写一行，dirty=1
    pub fn create_memo(&self, input: &MemoInput, ts: i64) -> Result<String, String> {
        validate_memo(input)?;
        let id = if input.id.trim().is_empty() {
            Db::gen_id("m")
        } else {
            input.id.trim().to_string()
        };
        let content = input.content.trim();
        let conn = self.lock()?;
        let dup: i64 = conn
            .query_row("SELECT COUNT(1) FROM memo WHERE id=?1", params![id], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        if dup > 0 {
            return Err(format!("memo id 已存在：{id}"));
        }
        conn.execute(
            "INSERT INTO memo (id,kind,title,content,start_date,end_date,category,rev,updated_at,deleted,dirty) \
             VALUES (?1,?2,?3,?4,?5,?6,?7,0,?8,0,1)",
            params![
                id,
                input.kind,
                input.title.trim(),
                empty_to_null(content),
                empty_to_null(&input.start_date),
                empty_to_null(&input.end_date),
                Db::memo_category(input.kind, &input.category),
                ts
            ],
        )
        .map_err(|e| e.to_string())?;
        Ok(id)
    }

    /// 修改 memo（契约 §10.2）：任何字段都可原地改，rev 保持，dirty=1
    pub fn update_memo(&self, input: &MemoInput, ts: i64) -> Result<(), String> {
        validate_memo(input)?;
        let id = input.id.trim().to_string();
        if id.is_empty() {
            return Err("update_memo 需要 memo id".to_string());
        }
        let content = input.content.trim();
        let conn = self.lock()?;
        let n = conn
            .execute(
                "UPDATE memo SET kind=?1, title=?2, content=?3, start_date=?4, end_date=?5, category=?6, \
                 updated_at=?7, dirty=1 WHERE id=?8 AND deleted=0",
                params![
                    input.kind,
                    input.title.trim(),
                    empty_to_null(content),
                    empty_to_null(&input.start_date),
                    empty_to_null(&input.end_date),
                    Db::memo_category(input.kind, &input.category),
                    ts,
                    id
                ],
            )
            .map_err(|e| e.to_string())?;
        if n == 0 {
            return Err(format!("memo 不存在或已删除：{id}"));
        }
        Ok(())
    }

    /// 删除 memo（契约 §10.2）：一律软删
    pub fn delete_memo(&self, id: &str, ts: i64) -> Result<(), String> {
        let conn = self.lock()?;
        let n = conn
            .execute(
                "UPDATE memo SET deleted=1, updated_at=?1, dirty=1 WHERE id=?2 AND deleted=0",
                params![ts, id],
            )
            .map_err(|e| e.to_string())?;
        if n == 0 {
            return Err(format!("memo 不存在或已删除：{id}"));
        }
        Ok(())
    }

    /* ---------- 写路径：提醒（契约 §11） ---------- */

    /// 全部未删提醒 → (owner_kind, owner_id) → 摘要。列表显示用，一次读完，避免 N+1。
    /// 收 &Connection 而不是 &self：调用方（rules_with_tasks / memo_rows）已经握着锁，
    /// 这里再 lock() 会自己把自己锁死（Mutex 不可重入）。
    fn reminder_summaries(conn: &Connection) -> Result<HashMap<(i64, String), String>, String> {
        let mut stmt = conn
            .prepare(&format!("SELECT {REMINDER_COLS} FROM reminder WHERE deleted=0"))
            .map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], reminder_from_row).map_err(|e| e.to_string())?;
        let mut map: HashMap<(i64, String), String> = HashMap::new();
        for row in rows {
            let row = row.map_err(|e| e.to_string())?;
            let summary = reminder_summary(&row);
            if !summary.is_empty() {
                map.insert((row.owner_kind, row.owner_id.clone()), summary);
            }
        }
        Ok(map)
    }

    /// 某个 owner 的提醒（未删的那一行）。没有 → None。
    pub fn get_reminder(&self, owner_kind: i64, owner_id: &str) -> Result<Option<ReminderRow>, String> {
        if !(REMINDER_RULE..=REMINDER_COUNTDOWN).contains(&owner_kind) {
            return Err(format!("reminder.owner_kind 必须是 0/1/2，实际 {owner_kind}"));
        }
        let conn = self.lock()?;
        let mut stmt = conn
            .prepare(&format!(
                "SELECT {REMINDER_COLS} FROM reminder WHERE owner_kind=?1 AND owner_id=?2 AND deleted=0"
            ))
            .map_err(|e| e.to_string())?;
        let mut rows = stmt.query(params![owner_kind, owner_id.trim()]).map_err(|e| e.to_string())?;
        match rows.next().map_err(|e| e.to_string())? {
            Some(r) => Ok(Some(reminder_from_row(r).map_err(|e| e.to_string())?)),
            None => Ok(None),
        }
    }

    /// 按 id 取一条提醒（含已软删的；调度器与贪睡命令要用 id 反查 snooze_min）
    pub fn get_reminder_by_id(&self, id: &str) -> Result<Option<ReminderRow>, String> {
        let conn = self.lock()?;
        let mut stmt = conn
            .prepare(&format!("SELECT {REMINDER_COLS} FROM reminder WHERE id=?1"))
            .map_err(|e| e.to_string())?;
        let mut rows = stmt.query(params![id.trim()]).map_err(|e| e.to_string())?;
        match rows.next().map_err(|e| e.to_string())? {
            Some(r) => Ok(Some(reminder_from_row(r).map_err(|e| e.to_string())?)),
            None => Ok(None),
        }
    }

    /// 所有活着的提醒（deleted=0 且 enabled=1）。调度线程每一轮都全量读它 ——
    /// 与 get_reminder 不同，这里不按 owner 过滤：一轮要把所有提醒一起算完，才知道「下一次」是谁。
    pub fn active_reminders(&self) -> Result<Vec<ReminderRow>, String> {
        let conn = self.lock()?;
        let mut stmt = conn
            .prepare(&format!(
                "SELECT {REMINDER_COLS} FROM reminder WHERE deleted=0 AND enabled=1 \
                 ORDER BY owner_kind, owner_id, updated_at"
            ))
            .map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], reminder_from_row).map_err(|e| e.to_string())?;
        rows.map(|r| r.map_err(|e| e.to_string())).collect()
    }

    /// 存提醒（契约 §11.1 / R1 / R2）：一个 owner 只有一行。
    /// id 从 owner 派生（已有行则沿用它的 id）：两端各自新建会得到同一 id，
    /// 否则同一条规则在两台设备上各有一行提醒，pull 回来就重复了。
    /// rev 保持不变（与 rule / memo 的写路径一致），dirty=1 + updated_at=ts，软删过的行原样复活。
    pub fn save_reminder(&self, input: &ReminderInput, ts: i64) -> Result<String, String> {
        validate_reminder(input)?;
        let owner_id = input.owner_id.trim().to_string();
        let conn = self.lock()?;
        let existing: Option<String> = conn
            .query_row(
                "SELECT id FROM reminder WHERE owner_kind=?1 AND owner_id=?2",
                params![input.owner_kind, owner_id],
                |r| r.get(0),
            )
            .ok();
        let id = existing
            .or_else(|| Some(input.id.trim().to_string()).filter(|s| !s.is_empty()))
            .unwrap_or_else(|| format!("rm_{}_{}", input.owner_kind, owner_id));
        conn.execute(
            "INSERT INTO reminder (id,owner_kind,owner_id,notify_on,alarm_on,time_of_day,notify_text,\
             offset_days,repeat_rule,snooze_min,enabled,rev,updated_at,deleted,dirty) \
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,0,?12,0,1) \
             ON CONFLICT(id) DO UPDATE SET owner_kind=excluded.owner_kind,owner_id=excluded.owner_id,\
             notify_on=excluded.notify_on,alarm_on=excluded.alarm_on,time_of_day=excluded.time_of_day,\
             notify_text=excluded.notify_text,offset_days=excluded.offset_days,\
             repeat_rule=excluded.repeat_rule,snooze_min=excluded.snooze_min,enabled=excluded.enabled,\
             updated_at=excluded.updated_at,deleted=0,dirty=1",
            params![
                id,
                input.owner_kind,
                owner_id,
                input.notify_on,
                input.alarm_on,
                input.time_of_day.trim(),
                empty_to_null(&input.notify_text),
                input.offset_days,
                input.repeat_rule,
                input.snooze_min,
                input.enabled,
                ts
            ],
        )
        .map_err(|e| e.to_string())?;
        Ok(id)
    }

    /// 「不提醒」= 软删该行（契约 §11.1 / R3）：两个开关都清零那一态不许落库。
    /// 本来就没有提醒时幂等返回 Ok —— 表单里点「不提醒」不该报错。
    pub fn clear_reminder(&self, owner_kind: i64, owner_id: &str, ts: i64) -> Result<(), String> {
        if !(REMINDER_RULE..=REMINDER_COUNTDOWN).contains(&owner_kind) {
            return Err(format!("reminder.owner_kind 必须是 0/1/2，实际 {owner_kind}"));
        }
        let conn = self.lock()?;
        conn.execute(
            "UPDATE reminder SET deleted=1, updated_at=?1, dirty=1 \
             WHERE owner_kind=?2 AND owner_id=?3 AND deleted=0",
            params![ts, owner_kind, owner_id.trim()],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    /* ---------- 本地状态（同步游标 / 设置） ---------- */

    pub fn get_state(&self, key: &str) -> Result<Option<String>, String> {
        let conn = self.lock()?;
        let mut stmt = conn
            .prepare("SELECT value FROM local_state WHERE key=?1")
            .map_err(|e| e.to_string())?;
        let mut rows = stmt.query(params![key]).map_err(|e| e.to_string())?;
        match rows.next().map_err(|e| e.to_string())? {
            Some(row) => Ok(Some(row.get::<_, String>(0).map_err(|e| e.to_string())?)),
            None => Ok(None),
        }
    }

    pub fn set_state(&self, key: &str, value: &str) -> Result<(), String> {
        let conn = self.lock()?;
        conn.execute(
            "INSERT INTO local_state (key,value) VALUES (?1,?2) \
             ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            params![key, value],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    fn get_i64(&self, key: &str) -> i64 {
        self.get_state(key).ok().flatten().and_then(|v| v.parse::<i64>().ok()).unwrap_or(0)
    }

    pub fn sync_url(&self) -> String {
        self.get_state(K_SYNC_URL)
            .ok()
            .flatten()
            .filter(|v| !v.trim().is_empty())
            .unwrap_or_else(|| DEFAULT_SYNC_URL.to_string())
    }

    /// 设置同步地址；只接受 http(s):// 开头的字面地址
    pub fn set_sync_url(&self, url: &str) -> Result<String, String> {
        let u = url.trim().trim_end_matches('/');
        if u.is_empty() {
            return Err("同步地址不能为空".to_string());
        }
        if !(u.starts_with("http://") || u.starts_with("https://")) {
            return Err("同步地址必须以 http:// 或 https:// 开头".to_string());
        }
        self.set_state(K_SYNC_URL, u)?;
        Ok(u.to_string())
    }

    pub fn last_pulled_rev(&self) -> i64 {
        self.get_i64(K_LAST_PULLED_REV)
    }

    pub fn set_last_pulled_rev(&self, rev: i64) -> Result<(), String> {
        self.set_state(K_LAST_PULLED_REV, &rev.to_string())
    }

    pub fn last_sync_at(&self) -> i64 {
        self.get_i64(K_LAST_SYNC_AT)
    }

    pub fn record_sync_ok(&self, at_ms: i64) -> Result<(), String> {
        self.set_state(K_LAST_SYNC_AT, &at_ms.to_string())?;
        self.set_state(K_LAST_ERROR, "")
    }

    pub fn record_sync_err(&self, msg: &str) -> Result<(), String> {
        self.set_state(K_LAST_ERROR, msg)
    }

    pub fn last_error(&self) -> String {
        self.get_state(K_LAST_ERROR).ok().flatten().unwrap_or_default()
    }

    /// 同步令牌（Bearer）。空串表示后端没开鉴权，请求里就不带这个头。
    pub fn sync_token(&self) -> String {
        self.get_state(K_SYNC_TOKEN).ok().flatten().unwrap_or_default()
    }

    /// 写同步令牌；传空串即清除。只 trim 首尾空白 —— token 本身可能含大小写与符号。
    pub fn set_sync_token(&self, token: &str) -> Result<(), String> {
        self.set_state(K_SYNC_TOKEN, token.trim())
    }

    /// 待推送条数：五张共享表里 dirty=1 的行数
    pub fn dirty_count(&self) -> Result<i64, String> {
        let conn = self.lock()?;
        let n: i64 = conn
            .query_row(
                "SELECT (SELECT COUNT(1) FROM rule WHERE dirty=1) \
                      + (SELECT COUNT(1) FROM task WHERE dirty=1) \
                      + (SELECT COUNT(1) FROM memo WHERE dirty=1) \
                      + (SELECT COUNT(1) FROM reminder WHERE dirty=1) \
                      + (SELECT COUNT(1) FROM completion WHERE dirty=1)",
                [],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        Ok(n)
    }

    /* ---------- push：收集 dirty=1 ---------- */

    pub fn collect_dirty(&self) -> Result<PushBody, String> {
        let conn = self.lock()?;
        let rules = {
            let mut stmt = conn
                .prepare(
                    "SELECT id,title,enabled,repeat_mode,weekdays_mask,repeat_every,month_day,\
                     year_month,year_day,start_date,end_date,repeat_until,rev,updated_at,deleted \
                     FROM rule WHERE dirty=1",
                )
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map([], |r| {
                    Ok(RuleRec {
                        id: r.get(0)?,
                        title: r.get(1)?,
                        enabled: r.get(2)?,
                        repeat_mode: r.get(3)?,
                        weekdays_mask: r.get(4)?,
                        repeat_every: r.get(5)?,
                        month_day: r.get(6)?,
                        year_month: r.get(7)?,
                        year_day: r.get(8)?,
                        start_date: r.get(9)?,
                        end_date: r.get(10)?,
                        repeat_until: r.get(11)?,
                        rev: r.get(12)?,
                        updated_at: r.get(13)?,
                        deleted: r.get(14)?,
                    })
                })
                .map_err(|e| e.to_string())?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(|e| e.to_string())?;
            rows
        };
        let tasks = {
            let mut stmt = conn
                .prepare(
                    "SELECT id,rule_id,title,enabled,sort_order,rev,updated_at,deleted \
                     FROM task WHERE dirty=1",
                )
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map([], |r| {
                    Ok(TaskRec {
                        id: r.get(0)?,
                        rule_id: r.get(1)?,
                        title: r.get(2)?,
                        enabled: r.get(3)?,
                        sort_order: r.get(4)?,
                        rev: r.get(5)?,
                        updated_at: r.get(6)?,
                        deleted: r.get(7)?,
                    })
                })
                .map_err(|e| e.to_string())?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(|e| e.to_string())?;
            rows
        };
        let memos = {
            let mut stmt = conn
                .prepare(
                    "SELECT id,kind,title,content,start_date,end_date,category,rev,updated_at,deleted \
                     FROM memo WHERE dirty=1",
                )
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map([], |r| {
                    Ok(MemoRec {
                        id: r.get(0)?,
                        kind: r.get(1)?,
                        title: r.get(2)?,
                        content: r.get(3)?,
                        start_date: r.get(4)?,
                        end_date: r.get(5)?,
                        category: r.get(6)?,
                        rev: r.get(7)?,
                        updated_at: r.get(8)?,
                        deleted: r.get(9)?,
                    })
                })
                .map_err(|e| e.to_string())?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(|e| e.to_string())?;
            rows
        };
        let reminders = {
            let mut stmt = conn
                .prepare(
                    "SELECT id,owner_kind,owner_id,notify_on,alarm_on,time_of_day,notify_text,\
                     offset_days,repeat_rule,snooze_min,enabled,rev,updated_at,deleted \
                     FROM reminder WHERE dirty=1",
                )
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map([], |r| {
                    Ok(ReminderRec {
                        id: r.get(0)?,
                        owner_kind: r.get(1)?,
                        owner_id: r.get(2)?,
                        notify_on: r.get(3)?,
                        alarm_on: r.get(4)?,
                        time_of_day: r.get(5)?,
                        notify_text: r.get(6)?,
                        offset_days: r.get(7)?,
                        repeat_rule: r.get(8)?,
                        snooze_min: r.get(9)?,
                        enabled: r.get(10)?,
                        rev: r.get(11)?,
                        updated_at: r.get(12)?,
                        deleted: r.get(13)?,
                    })
                })
                .map_err(|e| e.to_string())?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(|e| e.to_string())?;
            rows
        };
        let completions = {
            let mut stmt = conn
                .prepare(
                    "SELECT task_id,period_start,status,rev,updated_at,deleted \
                     FROM completion WHERE dirty=1",
                )
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map([], |r| {
                    Ok(CompletionRec {
                        task_id: r.get(0)?,
                        period_start: r.get(1)?,
                        status: r.get(2)?,
                        rev: r.get(3)?,
                        updated_at: r.get(4)?,
                        deleted: r.get(5)?,
                    })
                })
                .map_err(|e| e.to_string())?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(|e| e.to_string())?;
            rows
        };
        Ok(PushBody { rules, tasks, memos, reminders, completions })
    }

    /// push 成功后清 dirty。带上 updated_at 做条件，避免把「读取之后又被本地改过」的
    /// 新版本也一并清掉（那样这次改动就永远推不出去了）。
    pub fn mark_pushed(&self, body: &PushBody) -> Result<(), String> {
        let mut conn = self.lock()?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        for r in &body.rules {
            tx.execute(
                "UPDATE rule SET dirty=0 WHERE id=?1 AND updated_at=?2",
                params![r.id, r.updated_at],
            )
            .map_err(|e| e.to_string())?;
        }
        for r in &body.tasks {
            tx.execute(
                "UPDATE task SET dirty=0 WHERE id=?1 AND updated_at=?2",
                params![r.id, r.updated_at],
            )
            .map_err(|e| e.to_string())?;
        }
        for r in &body.memos {
            tx.execute(
                "UPDATE memo SET dirty=0 WHERE id=?1 AND updated_at=?2",
                params![r.id, r.updated_at],
            )
            .map_err(|e| e.to_string())?;
        }
        for r in &body.reminders {
            tx.execute(
                "UPDATE reminder SET dirty=0 WHERE id=?1 AND updated_at=?2",
                params![r.id, r.updated_at],
            )
            .map_err(|e| e.to_string())?;
        }
        for r in &body.completions {
            tx.execute(
                "UPDATE completion SET dirty=0 WHERE task_id=?1 AND period_start=?2 AND updated_at=?3",
                params![r.task_id, r.period_start, r.updated_at],
            )
            .map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())
    }

    /* ---------- pull：按 §7.2 仲裁后落库 ---------- */

    /// 返回实际应用（本地被远端覆盖或新插入）的条数。
    /// 仲裁：updated_at 大者赢；相等比 rev，大者赢；再相等保留本地原值（幂等）。
    /// 远端赢了就顺手清 dirty —— 那行已经是远端的新值，再推回去只是回声。
    pub fn apply_pull(&self, resp: &PullResp) -> Result<usize, String> {
        let mut conn = self.lock()?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        let mut applied = 0usize;

        for r in &resp.rules {
            let local: Option<(i64, i64)> = tx
                .query_row("SELECT updated_at,rev FROM rule WHERE id=?1", params![r.id], |row| {
                    Ok((row.get(0)?, row.get(1)?))
                })
                .ok();
            if !remote_wins(r.updated_at, r.rev, local) {
                continue;
            }
            tx.execute(
                "INSERT INTO rule (id,title,enabled,repeat_mode,weekdays_mask,repeat_every,month_day,\
                 year_month,year_day,start_date,end_date,repeat_until,rev,updated_at,deleted,dirty) \
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,0) \
                 ON CONFLICT(id) DO UPDATE SET title=excluded.title,enabled=excluded.enabled,\
                 repeat_mode=excluded.repeat_mode,weekdays_mask=excluded.weekdays_mask,\
                 repeat_every=excluded.repeat_every,month_day=excluded.month_day,\
                 year_month=excluded.year_month,year_day=excluded.year_day,\
                 start_date=excluded.start_date,end_date=excluded.end_date,\
                 repeat_until=excluded.repeat_until,rev=excluded.rev,\
                 updated_at=excluded.updated_at,deleted=excluded.deleted,dirty=0",
                params![
                    r.id, r.title, r.enabled, r.repeat_mode, r.weekdays_mask, r.repeat_every,
                    r.month_day, r.year_month, r.year_day, r.start_date, r.end_date, r.repeat_until,
                    r.rev, r.updated_at, r.deleted
                ],
            )
            .map_err(|e| e.to_string())?;
            applied += 1;
        }

        for r in &resp.tasks {
            let local: Option<(i64, i64)> = tx
                .query_row("SELECT updated_at,rev FROM task WHERE id=?1", params![r.id], |row| {
                    Ok((row.get(0)?, row.get(1)?))
                })
                .ok();
            if !remote_wins(r.updated_at, r.rev, local) {
                continue;
            }
            tx.execute(
                "INSERT INTO task (id,rule_id,title,enabled,sort_order,rev,updated_at,deleted,dirty) \
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,0) \
                 ON CONFLICT(id) DO UPDATE SET rule_id=excluded.rule_id,title=excluded.title,\
                 enabled=excluded.enabled,sort_order=excluded.sort_order,rev=excluded.rev,\
                 updated_at=excluded.updated_at,deleted=excluded.deleted,dirty=0",
                params![r.id, r.rule_id, r.title, r.enabled, r.sort_order, r.rev, r.updated_at, r.deleted],
            )
            .map_err(|e| e.to_string())?;
            applied += 1;
        }

        for r in &resp.memos {
            let local: Option<(i64, i64)> = tx
                .query_row("SELECT updated_at,rev FROM memo WHERE id=?1", params![r.id], |row| {
                    Ok((row.get(0)?, row.get(1)?))
                })
                .ok();
            if !remote_wins(r.updated_at, r.rev, local) {
                continue;
            }
            tx.execute(
                "INSERT INTO memo (id,kind,title,content,start_date,end_date,category,rev,updated_at,deleted,dirty) \
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,0) \
                 ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,title=excluded.title,\
                 content=excluded.content,start_date=excluded.start_date,end_date=excluded.end_date,\
                 category=excluded.category,rev=excluded.rev,updated_at=excluded.updated_at,\
                 deleted=excluded.deleted,dirty=0",
                params![
                    r.id, r.kind, r.title, r.content, r.start_date, r.end_date, r.category,
                    r.rev, r.updated_at, r.deleted
                ],
            )
            .map_err(|e| e.to_string())?;
            applied += 1;
        }

        for r in &resp.reminders {
            let local: Option<(i64, i64)> = tx
                .query_row("SELECT updated_at,rev FROM reminder WHERE id=?1", params![r.id], |row| {
                    Ok((row.get(0)?, row.get(1)?))
                })
                .ok();
            if !remote_wins(r.updated_at, r.rev, local) {
                continue;
            }
            tx.execute(
                "INSERT INTO reminder (id,owner_kind,owner_id,notify_on,alarm_on,time_of_day,\
                 notify_text,offset_days,repeat_rule,snooze_min,enabled,rev,updated_at,deleted,dirty) \
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,0) \
                 ON CONFLICT(id) DO UPDATE SET owner_kind=excluded.owner_kind, \
                 owner_id=excluded.owner_id,notify_on=excluded.notify_on,alarm_on=excluded.alarm_on, \
                 time_of_day=excluded.time_of_day,notify_text=excluded.notify_text, \
                 offset_days=excluded.offset_days,repeat_rule=excluded.repeat_rule, \
                 snooze_min=excluded.snooze_min,enabled=excluded.enabled,rev=excluded.rev, \
                 updated_at=excluded.updated_at,deleted=excluded.deleted,dirty=0",
                params![
                    r.id, r.owner_kind, r.owner_id, r.notify_on, r.alarm_on, r.time_of_day,
                    r.notify_text, r.offset_days, r.repeat_rule, r.snooze_min, r.enabled,
                    r.rev, r.updated_at, r.deleted
                ],
            )
            .map_err(|e| e.to_string())?;
            applied += 1;
        }

        for r in &resp.completions {
            let local: Option<(i64, i64)> = tx
                .query_row(
                    "SELECT updated_at,rev FROM completion WHERE task_id=?1 AND period_start=?2",
                    params![r.task_id, r.period_start],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .ok();
            if !remote_wins(r.updated_at, r.rev, local) {
                continue;
            }
            tx.execute(
                "INSERT INTO completion (task_id,period_start,status,rev,updated_at,deleted,dirty) \
                 VALUES (?1,?2,?3,?4,?5,?6,0) \
                 ON CONFLICT(task_id,period_start) DO UPDATE SET status=excluded.status,\
                 rev=excluded.rev,updated_at=excluded.updated_at,deleted=excluded.deleted,dirty=0",
                params![r.task_id, r.period_start, r.status, r.rev, r.updated_at, r.deleted],
            )
            .map_err(|e| e.to_string())?;
            applied += 1;
        }

        tx.commit().map_err(|e| e.to_string())?;
        Ok(applied)
    }
}

/// 契约 §7.2：updated_at 大者赢；相等比 rev，大者赢；再相等保留本地（幂等）。
/// local 为 None 表示本地还没有这行，远端直接插入。
fn remote_wins(incoming_updated_at: i64, incoming_rev: i64, local: Option<(i64, i64)>) -> bool {
    match local {
        None => true,
        Some((lu, lr)) => {
            incoming_updated_at > lu || (incoming_updated_at == lu && incoming_rev > lr)
        }
    }
}

/// 一天的展开：任务来自命中规则，记事来自「区间内每天都显示」的 memo（契约 §10.1）。
fn expand_day(
    rules: &[RuleRow],
    done: &HashMap<String, bool>,
    memos: &[MemoRow],
    date: engine::Date,
) -> Day {
    let mut tasks = Vec::new();
    for rule in rules.iter().filter(|r| r.enabled) {
        let er = rule.to_engine();
        if !engine::occurs_on(&er, date) {
            continue;
        }
        let period = match engine::period_start_of(&er, date) {
            Ok(p) => p,
            Err(_) => continue,
        };
        for task in rule.tasks.iter().filter(|t| t.enabled) {
            let key = format!("{}:{}", task.id, period);
            tasks.push(DayTask {
                task_id: task.id.clone(),
                title: task.title.clone(),
                rule_id: rule.id.clone(),
                rule_title: rule.title.clone(),
                period_start: period.clone(),
                done: done.get(&key).copied().unwrap_or(false),
            });
        }
    }
    let key = engine::key(date);
    let day_memos = memos
        .iter()
        .filter(|m| memo_active_on(m, &key))
        .map(|m| DayMemo {
            id: m.id.clone(),
            title: m.title.clone(),
            start_date: m.start_date.clone(),
            end_date: m.end_date.clone(),
        })
        .collect();
    Day { date: key, tasks, memos: day_memos }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Db {
        Db::open_in_memory().expect("内存库")
    }

    #[test]
    fn seeds_four_rules_and_five_tasks() {
        let db = db();
        let rules = db.list_rules(true).unwrap();
        assert_eq!(rules.len(), 4, "种子应有 4 条规则");
        let total: usize = rules.iter().map(|r| r.tasks.len()).sum();
        assert_eq!(total, 5, "种子应有 5 个任务");
        let work = rules.iter().find(|r| r.id == "r_work").expect("r_work");
        assert_eq!(work.tasks.len(), 2, "工作日常规下应有 健身 / 早起");
    }

    #[test]
    fn range_grid_matches_month_grid_day_by_day() {
        let db = db();
        let month = db.month_grid(2026, 10).unwrap();
        let range = db.range_grid("2026-10-01", "2026-10-31").unwrap();
        assert_eq!(range.len(), 31, "10-01~10-31 应给 31 天");
        assert_eq!(
            range.iter().map(|d| d.date.clone()).collect::<Vec<_>>(),
            month.days.iter().map(|d| d.date.clone()).collect::<Vec<_>>(),
            "日期序列与 month_grid 一致"
        );
        for (a, b) in range.iter().zip(month.days.iter()) {
            assert_eq!(
                a.tasks.iter().map(|t| (t.task_id.clone(), t.period_start.clone(), t.done)).collect::<Vec<_>>(),
                b.tasks.iter().map(|t| (t.task_id.clone(), t.period_start.clone(), t.done)).collect::<Vec<_>>(),
                "{} 的任务与周期起点必须与 month_grid 逐条一致",
                a.date
            );
            assert_eq!(
                a.memos.iter().map(|m| m.id.clone()).collect::<Vec<_>>(),
                b.memos.iter().map(|m| m.id.clone()).collect::<Vec<_>>(),
                "{} 的记事必须一致",
                a.date
            );
        }
    }

    #[test]
    fn range_grid_spans_month_boundary_without_gaps() {
        let db = db();
        // 跨月周 2026-10-26 ~ 2026-11-01：日期必须连续，一天都不缺
        let days = db.range_grid("2026-10-26", "2026-11-01").unwrap();
        assert_eq!(days.len(), 7);
        let dates: Vec<&str> = days.iter().map(|d| d.date.as_str()).collect();
        assert_eq!(
            dates,
            vec!["2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30", "2026-10-31", "2026-11-01"]
        );
        // 单日区间也要正常
        let one = db.range_grid("2026-10-23", "2026-10-23").unwrap();
        assert_eq!(one.len(), 1);
        assert_eq!(one[0].date, "2026-10-23");
    }

    #[test]
    fn range_grid_rejects_bad_input() {
        let db = db();
        assert!(db.range_grid("2026-10-31", "2026-10-01").is_err(), "起止颠倒要报错");
        assert!(db.range_grid("2026-13-01", "2026-12-01").is_err(), "非法日期要报错");
        // 2026-01-01 ~ 2038-12-31 ≈ 4747 天 > 4000，必须拒绝（避免调用方一次要十几年）
        assert!(db.range_grid("2026-01-01", "2038-12-31").is_err(), "超过 4000 天要报错");
    }

    #[test]
    fn october_grid_semantics() {
        let db = db();
        let grid = db.month_grid(2026, 10).unwrap();
        assert_eq!(grid.days.len(), 31, "10 月应有 31 格");
        assert_eq!(grid.days[0].date, "2026-10-01");

        let find = |date: &str, task: &str| {
            grid.days
                .iter()
                .find(|d| d.date == date)
                .map(|d| d.tasks.iter().any(|t| t.task_id == task))
                .unwrap_or(false)
        };

        // 2026-10-04 是周日 → 工作日规则不命中
        assert!(!find("2026-10-04", "t_fit"), "周日不该出现工作日任务");
        assert!(find("2026-10-02", "t_fit"), "周五应出现工作日任务");
        // 房租只出现在 20 日
        assert!(find("2026-10-20", "t_rent"));
        assert!(!find("2026-10-21", "t_rent"));
        // 每年 3/15 的规则不出现在 10 月
        for d in &grid.days {
            assert!(!d.tasks.iter().any(|t| t.task_id == "t_med"), "{} 不该出现年度体检", d.date);
        }
        // 「每 1 天」的单词打卡每天都命中，周日只剩它一条
        let sunday: Vec<&str> = grid.days.iter()
            .find(|d| d.date == "2026-10-04")
            .map(|d| d.tasks.iter().map(|t| t.task_id.as_str()).collect())
            .unwrap_or_default();
        assert_eq!(sunday, vec!["t_words"], "周日应只有背单词：{:?}", sunday);
        // 工作日同时有 健身 / 早起 / 背单词
        let workday: Vec<&str> = grid.days.iter()
            .find(|d| d.date == "2026-10-05")
            .map(|d| d.tasks.iter().map(|t| t.task_id.as_str()).collect())
            .unwrap_or_default();
        // 规则按 start_date, title 排序（与 Go 一致）：「单词打卡」在「工作日常规」之前
        assert_eq!(workday, vec!["t_words", "t_fit", "t_early"], "周一三条：{:?}", workday);
    }

    /// 契约 §3.5 #12：打卡共享 —— 10-19 那周给「健身」打卡后，整周都显示已完成；
    /// 10-26 起回到未完成。
    #[test]
    fn period_done_shared_within_week() {
        let db = db();
        // 种子已把 t_fit 的 2026-10-19 周期置为已完成
        let grid = db.month_grid(2026, 10).unwrap();
        let mut seen_in_week = 0;
        for day in &grid.days {
            for t in day.tasks.iter().filter(|t| t.task_id == "t_fit") {
                let in_week = day.date.as_str() >= "2026-10-19" && day.date.as_str() <= "2026-10-25";
                if in_week {
                    seen_in_week += 1;
                    assert!(t.done, "{} 属于 10-19 那一周，应显示为已完成", day.date);
                } else if day.date.as_str() >= "2026-10-26" {
                    assert!(!t.done, "{} 属于下一周，不该显示为已完成", day.date);
                }
            }
        }
        assert_eq!(seen_in_week, 5, "10-19~10-25 之间有 5 个工作日出现健身");
        // 显式反向验证：清掉完成后同一周应全部变回未完成
        db.set_done("t_fit", "2026-10-19", false).unwrap();
        let grid2 = db.month_grid(2026, 10).unwrap();
        for day in &grid2.days {
            for t in day.tasks.iter().filter(|t| t.task_id == "t_fit") {
                assert!(!t.done, "{} 取消后应未完成", day.date);
            }
        }
    }

    #[test]
    fn seed_is_idempotent() {
        let path = std::env::temp_dir().join("took_seed_test.db");
        let _ = std::fs::remove_file(&path);
        {
            let db = Db::open(&path).unwrap();
            assert_eq!(db.list_rules(true).unwrap().len(), 4);
        }
        {
            let db = Db::open(&path).unwrap();
            assert_eq!(db.list_rules(true).unwrap().len(), 4, "重启不该重复写种子");
        }
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn rejects_bad_month_params() {
        let db = db();
        assert!(db.month_grid(2026, 0).is_err());
        assert!(db.month_grid(2026, 13).is_err());
        assert!(db.month_grid(1969, 10).is_err());
    }

    /* ---------- 打卡写路径 ---------- */

    /// 打卡后同周期其他命中日也变完成；写入带 updated_at + dirty=1 + rev 保持。
    #[test]
    fn toggle_done_shares_status_across_period() {
        let db = db();
        db.set_done("t_fit", "2026-10-19", false).unwrap();
        db.mark_pushed(&db.collect_dirty().unwrap()).unwrap();
        // 周五（10-23）在面板里打卡 → 写的是 (t_fit, 2026-10-19)
        let before = db.day("2026-10-23").unwrap();
        let period = before
            .tasks
            .iter()
            .find(|t| t.task_id == "t_fit")
            .map(|t| t.period_start.clone())
            .expect("10-23 应有健身");
        assert_eq!(period, "2026-10-19", "周五的周期起点应是当周周一");

        let res = db.toggle_done("t_fit", &period, true).unwrap();
        assert!(res.done);
        assert!(res.dirty, "写本地必须置 dirty=1 等推送");
        assert!(res.updated_at > 0, "updated_at 应是当前毫秒");
        assert_eq!(res.rev, 0, "冲突行的 rev 保持不变（种子 rev=0）");
        assert_eq!(db.dirty_count().unwrap(), 1, "打卡应产生 1 条待推送");

        let grid = db.month_grid(2026, 10).unwrap();
        let mut checked = 0;
        for day in &grid.days {
            for t in day.tasks.iter().filter(|t| t.task_id == "t_fit") {
                let in_week = day.date.as_str() >= "2026-10-19" && day.date.as_str() <= "2026-10-25";
                assert_eq!(t.done, in_week, "{} 的完成状态应与同周期一致", day.date);
                checked += 1;
            }
        }
        assert_eq!(checked, 22, "10 月共 22 个工作日命中健身");
        // 返回的「当天数据」也让该天同为已完成
        let day = db.day("2026-10-23").unwrap();
        assert!(day.tasks.iter().find(|t| t.task_id == "t_fit").unwrap().done);
    }

    /// 取消打卡：再点一次回到未完成，updated_at 必须变大（否则同步仲裁会丢这次操作）。
    #[test]
    fn untoggle_restores_and_bumps_updated_at() {
        let db = db();
        let first = db.toggle_done("t_fit", "2026-10-19", true).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(3));
        let second = db.toggle_done("t_fit", "2026-10-19", false).unwrap();
        assert!(!second.done);
        assert!(second.updated_at > first.updated_at, "取消打卡必须刷新 updated_at");
        let day = db.day("2026-10-21").unwrap();
        assert!(
            !day.tasks.iter().find(|t| t.task_id == "t_fit").unwrap().done,
            "取消后同周期其他天也回到未完成"
        );
    }

    /// 写入层严格校验（契约 §3.4）：非法日期与不存在的任务都必须被拒绝。
    #[test]
    fn toggle_done_rejects_bad_input() {
        let db = db();
        assert!(db.toggle_done("t_fit", "2026-1-5", true).is_err());
        assert!(db.toggle_done("t_fit", "2026/10/01", true).is_err());
        assert!(db.toggle_done("t_fit", "2026-02-30", true).is_err());
        assert!(db.toggle_done("t_nope", "2026-10-19", true).is_err());
        // 校验失败不能落库
        assert_eq!(db.dirty_count().unwrap(), 0, "拒绝的写入不该留下 dirty");
    }

    /* ---------- 同步仲裁（契约 §7.2） ---------- */

    fn completion_rec(task_id: &str, period: &str, status: i64, updated_at: i64, rev: i64) -> CompletionRec {
        CompletionRec {
            task_id: task_id.to_string(),
            period_start: period.to_string(),
            status,
            rev,
            updated_at,
            deleted: 0,
        }
    }

    /// updated_at 大的赢：远端更新 → 本地被覆盖；远端更旧 → 本地保留。
    #[test]
    fn pull_arbitrates_by_newer_updated_at() {
        let db = db();
        db.toggle_done("t_fit", "2026-10-19", false).unwrap();
        let local_ts = db.collect_dirty().unwrap().completions[0].updated_at;

        // 1) 远端 updated_at 更大且 status=1 → 远端赢
        let newer = PullResp {
            completions: vec![completion_rec("t_fit", "2026-10-19", 1, local_ts + 1000, 7)],
            max_rev: 7,
            ..Default::default()
        };
        assert_eq!(db.apply_pull(&newer).unwrap(), 1, "远端更新应被应用");
        let day = db.day("2026-10-22").unwrap();
        assert!(day.tasks.iter().find(|t| t.task_id == "t_fit").unwrap().done);
        assert_eq!(db.dirty_count().unwrap(), 0, "远端赢的那行不该再推回去");

        // 2) 远端 updated_at 更小且 status=0 → 本地保留
        let older = PullResp {
            completions: vec![completion_rec("t_fit", "2026-10-19", 0, local_ts - 1000, 9)],
            max_rev: 9,
            ..Default::default()
        };
        assert_eq!(db.apply_pull(&older).unwrap(), 0, "更旧的值不该覆盖本地");
        let day = db.day("2026-10-22").unwrap();
        assert!(day.tasks.iter().find(|t| t.task_id == "t_fit").unwrap().done);

        // 3) updated_at 相等时比 rev；再相等保留本地（幂等）
        let same_ts_higher_rev = PullResp {
            completions: vec![completion_rec("t_fit", "2026-10-19", 0, local_ts + 1000, 8)],
            max_rev: 8,
            ..Default::default()
        };
        assert_eq!(db.apply_pull(&same_ts_higher_rev).unwrap(), 1, "时间戳相等时 rev 大的赢");
        let same_again = PullResp {
            completions: vec![completion_rec("t_fit", "2026-10-19", 0, local_ts + 1000, 8)],
            max_rev: 8,
            ..Default::default()
        };
        assert_eq!(db.apply_pull(&same_again).unwrap(), 0, "完全相同应幂等，不重复写");
    }

    /// 被远端覆盖的行要清 dirty；本地未推送的更新（updated_at 更新）要保留 dirty。
    #[test]
    fn pull_keeps_local_dirty_when_local_wins() {
        let db = db();
        db.toggle_done("t_fit", "2026-10-19", true).unwrap();
        let local_ts = db.collect_dirty().unwrap().completions[0].updated_at;
        let older = PullResp {
            completions: vec![completion_rec("t_fit", "2026-10-19", 0, local_ts - 1, 3)],
            ..Default::default()
        };
        db.apply_pull(&older).unwrap();
        assert_eq!(db.dirty_count().unwrap(), 1, "本地更新更晚，必须保留 dirty 等下次 push");
    }

    #[test]
    fn mark_pushed_clears_dirty_but_keeps_newer_local_edit() {
        let db = db();
        db.toggle_done("t_fit", "2026-10-19", true).unwrap();
        let body = db.collect_dirty().unwrap();
        assert_eq!(body.len(), 1);
        db.mark_pushed(&body).unwrap();
        assert_eq!(db.dirty_count().unwrap(), 0, "push 成功后 dirty 清零");

        // 推送后本地又改了一次：旧载荷不能把新改动也清掉
        db.toggle_done("t_fit", "2026-10-19", false).unwrap();
        db.mark_pushed(&body).unwrap();
        assert_eq!(db.dirty_count().unwrap(), 1, "updated_at 变了，旧载荷不该清掉新 dirty");
    }

    #[test]
    fn local_state_defaults_and_update() {
        let db = db();
        assert_eq!(db.sync_url(), DEFAULT_SYNC_URL);
        assert_eq!(db.last_pulled_rev(), 0);
        assert_eq!(db.last_sync_at(), 0);
        assert_eq!(db.last_error(), "");

        assert!(db.set_sync_url("192.168.1.9:8420").is_err(), "缺协议头要拒绝");
        assert_eq!(db.set_sync_url("http://192.168.1.9:8420/").unwrap(), "http://192.168.1.9:8420");
        assert_eq!(db.sync_url(), "http://192.168.1.9:8420");

        db.set_last_pulled_rev(42).unwrap();
        assert_eq!(db.last_pulled_rev(), 42);
        db.record_sync_ok(1_700_000_000_000).unwrap();
        assert_eq!(db.last_sync_at(), 1_700_000_000_000);
        db.record_sync_err("连不上").unwrap();
        assert_eq!(db.last_error(), "连不上");
        db.record_sync_ok(1).unwrap();
        assert_eq!(db.last_error(), "", "成功后清掉上次错误");
    }

    /* ==================================================================
       契约 §9 编辑语义：§9.6 的 E1~E6，每条一个测试，名字带编号便于核对
       ================================================================== */

    const TODAY: &str = "2026-10-24"; // 周六
    const YESTERDAY: &str = "2026-10-23";

    fn scalar(db: &Db, sql: &str) -> i64 {
        let conn = db.conn.lock().unwrap();
        conn.query_row(sql, [], |r| r.get(0)).unwrap()
    }

    fn rule_col(db: &Db, id: &str, col: &str) -> String {
        let conn = db.conn.lock().unwrap();
        conn.query_row(
            &format!("SELECT {col} FROM rule WHERE id=?1"),
            params![id],
            |r| r.get::<_, Option<String>>(0),
        )
        .unwrap()
        .unwrap_or_default()
    }

    fn rule_int(db: &Db, id: &str, col: &str) -> i64 {
        scalar(db, &format!("SELECT {col} FROM rule WHERE id='{id}'"))
    }

    fn task_int(db: &Db, id: &str, col: &str) -> i64 {
        scalar(db, &format!("SELECT {col} FROM task WHERE id='{id}'"))
    }

    /// 等价于前端「打开编辑表单」：把库里现有的一行读成提交载荷
    fn input_of(db: &Db, id: &str) -> RuleInput {
        let r = {
            let conn = db.conn.lock().unwrap();
            Db::rule_by_id(&conn, id).unwrap().expect("规则应存在")
        };
        RuleInput {
            id: r.id,
            title: r.title,
            enabled: r.enabled,
            repeat_mode: r.repeat_mode,
            weekdays_mask: r.weekdays_mask,
            repeat_every: r.repeat_every,
            month_day: r.month_day,
            year_month: r.year_month,
            year_day: r.year_day,
            start_date: r.start_date,
            end_date: r.end_date,
            new_id: String::new(),
        }
    }

    fn completions(db: &Db) -> i64 {
        scalar(db, "SELECT COUNT(1) FROM completion")
    }

    /// 判定函数本身：只有 7 个重复字段会触发裂开
    #[test]
    fn split_predicate_only_watches_repeat_fields() {
        let db = db();
        let current = {
            let conn = db.conn.lock().unwrap();
            Db::rule_by_id(&conn, "r_work").unwrap().unwrap()
        };

        let mut same = input_of(&db, "r_work");
        same.title = "改个名".into();
        same.enabled = false;
        same.end_date = "2027-01-01".into();
        assert!(!needs_split(&current, &same), "标题/启停/结束日期都不该裂开");

        // r_work 是 weekly（mode 0）：只有 repeat_mode / weekdays_mask / start_date 该裂开
        for (name, mutate) in [
            ("repeat_mode", Box::new(|i: &mut RuleInput| i.repeat_mode = 1) as Box<dyn Fn(&mut RuleInput)>),
            ("weekdays_mask", Box::new(|i: &mut RuleInput| i.weekdays_mask = 42)),
            ("start_date", Box::new(|i: &mut RuleInput| i.start_date = "2026-09-01".into())),
        ] {
            let mut input = input_of(&db, "r_work");
            mutate(&mut input);
            assert!(needs_split(&current, &input), "{name} 变了必须裂开");
        }
        // 与 weekly 无关的字段带着占位默认值不算改动（与 Android 同一口径）
        for (name, mutate) in [
            ("repeat_every", Box::new(|i: &mut RuleInput| i.repeat_every = 3) as Box<dyn Fn(&mut RuleInput)>),
            ("month_day", Box::new(|i: &mut RuleInput| i.month_day = 15)),
            ("year_month", Box::new(|i: &mut RuleInput| i.year_month = 7)),
            ("year_day", Box::new(|i: &mut RuleInput| i.year_day = 9)),
        ] {
            let mut input = input_of(&db, "r_work");
            mutate(&mut input);
            assert!(!needs_split(&current, &input), "weekly 规则里 {name} 是无关字段，不该裂开");
        }
    }

    /// 回归：weekly 规则草稿塞进 month_day / repeat_every / year_month 的占位默认值 → 判定不裂开
    #[test]
    fn unchanged_weekly_rule_ignores_irrelevant_field_defaults() {
        let db = db();
        let current = {
            let conn = db.conn.lock().unwrap();
            Db::rule_by_id(&conn, "r_work").unwrap().unwrap()
        };
        assert_eq!(current.repeat_mode, 0, "r_work 应该是每周");
        assert_eq!(current.month_day, 0, "种子规则里 weekly 的 month_day 是 0");

        let mut draft = input_of(&db, "r_work");
        draft.month_day = 15;
        draft.repeat_every = 2;
        draft.year_month = 3;
        assert!(
            !needs_split(&current, &draft),
            "weekly 的 month_day/repeat_every/year_month 全是无关字段，带默认值也不能裂开"
        );
        // 真的保存一次也确认没裂：规则数不变、repeat_until 不被写
        let rules_before = scalar(&db, "SELECT COUNT(1) FROM rule");
        let res = db.update_rule(&draft, Some(TODAY), 1_700_000_000_100).unwrap();
        assert!(!res.split, "保存不该裂开");
        assert_eq!(scalar(&db, "SELECT COUNT(1) FROM rule"), rules_before, "没有新建规则");
        assert_eq!(rule_col(&db, "r_work", "repeat_until"), "", "旧规则的上界不该被写");
    }

    /// 回归：weekly → 每月（填 15 日）→ 再改回每周，month_day 仍残留 15 → 判定不裂开
    #[test]
    fn mode_switch_back_to_weekly_does_not_split() {
        let db = db();
        let current = {
            let conn = db.conn.lock().unwrap();
            Db::rule_by_id(&conn, "r_work").unwrap().unwrap()
        };

        // 第一步：草稿改成「每月 15 日」（这一步本来就该裂开，这里有 new_id）
        let mut monthly = input_of(&db, "r_work");
        monthly.repeat_mode = 2;
        monthly.month_day = 15;
        monthly.new_id = "r_work_monthly".into();
        assert!(needs_split(&current, &monthly), "换成每月是改重复设置，必须裂开");

        // 第二步：又改回「每周」，month_day 仍是 15 —— 与库里的 weekly 设置其实一致
        let mut back = monthly.clone();
        back.repeat_mode = 0;
        back.new_id = String::new();
        assert!(
            !needs_split(&current, &back),
            "改回每周时 month_day 的残留值对 weekly 无效，不能白裂一条规则"
        );
        let res = db.update_rule(&back, Some(TODAY), 1_700_000_000_101).unwrap();
        assert!(!res.split, "改回每周必须原地改");
        assert_eq!(res.old_rule_id, "r_work");
        assert!(res.new_rule_id.is_none());
        assert_eq!(rule_int(&db, "r_work", "repeat_mode"), 0);
        assert_eq!(rule_int(&db, "r_work", "weekdays_mask"), 31);
        assert_eq!(rule_col(&db, "r_work", "repeat_until"), "", "已结束标记不该被写");
    }

    /// E1：只改 title → 规则 id 不变、repeat_until 不变、历史打卡仍在，不新建规则
    #[test]
    fn e1_title_only_edit_stays_in_place() {
        let db = db();
        let before_completions = completions(&db);
        let mut input = input_of(&db, "r_work");
        input.title = "工作日常规（改名）".into();
        let res = db.update_rule(&input, Some(TODAY), 1_700_000_000_000).unwrap();

        assert!(!res.split, "只改标题不能裂开");
        assert_eq!(res.old_rule_id, "r_work", "规则 id 不变");
        assert!(res.new_rule_id.is_none(), "没有新规则");
        assert_eq!(rule_col(&db, "r_work", "title"), "工作日常规（改名）");
        assert_eq!(rule_col(&db, "r_work", "repeat_until"), "", "repeat_until 不能被写");
        assert_eq!(rule_int(&db, "r_work", "weekdays_mask"), 31, "重复设置不能动");
        assert_eq!(rule_int(&db, "r_work", "dirty"), 1, "改过的行必须 dirty=1");
        assert_eq!(db.list_rules(true).unwrap().len(), 4, "规则条数不变");
        assert_eq!(completions(&db), before_completions, "历史打卡仍在");
        let monday = db.day("2026-10-19").unwrap();
        assert!(monday.tasks.iter().any(|t| t.task_id == "t_fit" && t.done), "10-19 的健身仍显示已完成");
    }

    /// E2：weekdays_mask 31 → 42 → 裂开成两条
    #[test]
    fn e2_weekdays_mask_change_splits() {
        let db = db();
        let before_tasks = scalar(&db, "SELECT COUNT(1) FROM task WHERE rule_id='r_work' AND deleted=0");
        let before_completions = completions(&db);

        let mut input = input_of(&db, "r_work");
        input.weekdays_mask = 42; // 周一~周四 + 周六
        input.new_id = "r_work_new".into(); // 客户端生成新 id（契约 §9.2）
        let res = db.update_rule(&input, Some(TODAY), 1_700_000_000_001).unwrap();

        assert!(res.split, "重复设置变了必须裂开");
        assert_eq!(res.old_rule_id, "r_work");
        assert_eq!(res.new_rule_id.as_deref(), Some("r_work_new"));
        assert_eq!(res.old_repeat_until, YESTERDAY);
        assert_eq!(rule_col(&db, "r_work", "repeat_until"), YESTERDAY, "旧规则收尾到昨天");
        assert_eq!(rule_int(&db, "r_work", "weekdays_mask"), 31, "旧规则重复设置保持原样");
        assert_eq!(rule_col(&db, "r_work_new", "start_date"), TODAY, "新规则从今天起");
        assert_eq!(rule_int(&db, "r_work_new", "weekdays_mask"), 42);
        assert_eq!(rule_col(&db, "r_work_new", "repeat_until"), "", "新规则没有上界");
        assert_eq!(
            scalar(&db, "SELECT COUNT(1) FROM task WHERE rule_id='r_work' AND deleted=0"),
            before_tasks,
            "旧规则下的任务一条不少"
        );
        assert_eq!(
            scalar(&db, "SELECT COUNT(1) FROM task WHERE rule_id='r_work_new'"),
            0,
            "任务不自动搬到新规则"
        );
        assert_eq!(completions(&db), before_completions, "打卡记录一条不少");

        // 旧规则仍能让 10-19（周一，早于昨天）命中，且打卡状态还是已完成
        let monday = db.day("2026-10-19").unwrap();
        let fit = monday
            .tasks
            .iter()
            .find(|t| t.task_id == "t_fit")
            .expect("旧规则周一仍命中健身");
        assert!(fit.done, "旧规则下的打卡历史必须还在");

        // 已结束的旧规则不在默认列表里，include_ended 才看得到并标为已结束
        let live = db.list_rules(false).unwrap();
        assert!(live.iter().all(|r| r.id != "r_work"), "默认列表不含已结束规则");
        let all = db.list_rules(true).unwrap();
        let old = all.iter().find(|r| r.id == "r_work").expect("include_ended 里能看历史");
        assert!(old.ended, "旧规则应标记已结束");
        assert!(!all.iter().find(|r| r.id == "r_work_new").unwrap().ended);
    }

    /// 防重复裂开：已结束的规则再改重复设置必须被拒，且不会多出记录
    #[test]
    fn split_refuses_to_split_an_ended_rule_twice() {
        let db = db();
        let mut input = input_of(&db, "r_work");
        input.weekdays_mask = 42;
        input.new_id = "r_work_new".into();
        db.update_rule(&input, Some(TODAY), 1_700_000_000_001).unwrap();
        let after_first = db.list_rules(true).unwrap().len();

        // 同一份请求再提交一次：旧规则已于昨天结束 → 拒绝（不会裂第二次）
        let mut replay = input.clone();
        replay.new_id = "r_work_new".into();
        let err = db.update_rule(&replay, Some(TODAY), 1_700_000_000_002).unwrap_err();
        assert!(err.contains("结束"), "重放应被拒：{err}");

        // 换一个 id 也不行：已结束的规则不能再改重复设置
        let mut again = input.clone();
        again.new_id = "r_work_new2".into();
        let err = db.update_rule(&again, Some(TODAY), 1_700_000_000_003).unwrap_err();
        assert!(err.contains("结束"), "已结束规则不能再裂开：{err}");
        assert_eq!(db.list_rules(true).unwrap().len(), after_first, "被拒的请求不能留下新记录");

        // 另一道闸：新 id 撞上已有规则 → 拒绝（防同一请求被重放到未结束的规则上）
        let mut dup = input_of(&db, "r_med");
        dup.year_day = 16;
        dup.new_id = "r_work".into();
        let err = db.update_rule(&dup, Some(TODAY), 1_700_000_000_005).unwrap_err();
        assert!(err.contains("已存在"), "新 id 撞车应被拒：{err}");
        assert_eq!(db.list_rules(true).unwrap().len(), after_first, "撞车也不能留下新记录");

        // 但已结束的旧规则仍可原地改名 / 启停
        let mut rename = input_of(&db, "r_work");
        rename.title = "工作日常规（旧）".into();
        assert!(!db.update_rule(&rename, Some(TODAY), 1_700_000_000_004).unwrap().split);
        assert_eq!(rule_col(&db, "r_work", "title"), "工作日常规（旧）");
    }

    /// 裂开后**界面默认勾选**「复制 N 个任务到新规则」的效果：
    /// 新规则任务数 = 旧规则任务数、标题一一对应，**任务 id 全不相同**（复制不是搬家）
    #[test]
    fn split_copy_default_copies_tasks_with_new_ids() {
        let db = db();
        let before_completions = completions(&db);
        let mut input = input_of(&db, "r_work");
        input.weekdays_mask = 42;
        input.new_id = "r_work_new".into();
        let new_id = db
            .update_rule(&input, Some(TODAY), 1_700_000_000_030)
            .unwrap()
            .new_rule_id
            .expect("重复设置变了应裂开");

        // 界面的「复制任务到新规则」= 逐条 add_task（默认勾选态）
        let old_titles: Vec<String> = {
            let conn = db.conn.lock().unwrap();
            let mut stmt = conn
                .prepare("SELECT title FROM task WHERE rule_id='r_work' AND deleted=0 ORDER BY sort_order")
                .unwrap();
            stmt.query_map([], |r| r.get::<_, String>(0))
                .unwrap()
                .collect::<rusqlite::Result<Vec<_>>>()
                .unwrap()
        };
        assert_eq!(old_titles.len(), 2, "种子里 r_work 有 2 个任务");
        for t in &old_titles {
            db.add_task(&new_id, t, 1_700_000_000_031).unwrap();
        }

        let all = db.list_rules(true).unwrap();
        let old = all.iter().find(|r| r.id == "r_work").expect("旧规则");
        let new = all.iter().find(|r| r.id == new_id).expect("新规则");
        assert_eq!(new.tasks.len(), old.tasks.len(), "新规则任务数 = 旧规则任务数");
        assert_eq!(new.tasks.len(), 2);
        let new_titles: Vec<&str> = new.tasks.iter().map(|t| t.title.as_str()).collect();
        let old_titles_ref: Vec<&str> = old.tasks.iter().map(|t| t.title.as_str()).collect();
        assert_eq!(new_titles, old_titles_ref, "标题一一对应、顺序一致");
        assert!(
            new.tasks.iter().all(|n| old.tasks.iter().all(|o| o.id != n.id)),
            "复制出来的必须是新 id：旧 {:?} / 新 {:?}",
            old.tasks.iter().map(|t| t.id.clone()).collect::<Vec<_>>(),
            new.tasks.iter().map(|t| t.id.clone()).collect::<Vec<_>>()
        );
        assert!(old.tasks.iter().all(|t| t.rule_id == "r_work"), "旧任务仍挂旧规则");
        assert!(new.tasks.iter().all(|t| t.rule_id == new_id), "新任务挂新规则");
        assert_eq!(completions(&db), before_completions, "复制不动打卡历史");
    }

    /// 取消勾选也是合法路径：裂开后新规则 0 任务，旧规则的 2 个任务与打卡一条不动
    #[test]
    fn split_without_copy_leaves_new_rule_without_tasks() {
        let db = db();
        let before_completions = completions(&db);
        let mut input = input_of(&db, "r_work");
        input.weekdays_mask = 42;
        input.new_id = "r_work_new".into();
        let new_id = db
            .update_rule(&input, Some(TODAY), 1_700_000_000_040)
            .unwrap()
            .new_rule_id
            .expect("应裂开");

        let all = db.list_rules(true).unwrap();
        assert_eq!(
            all.iter().find(|r| r.id == new_id).unwrap().tasks.len(),
            0,
            "不勾就不搬任务"
        );
        assert_eq!(
            all.iter().find(|r| r.id == "r_work").unwrap().tasks.len(),
            2,
            "旧规则的任务一条不动"
        );
        assert_eq!(completions(&db), before_completions);
    }

    /// E3：删除规则（含 2 个任务）→ 规则与两个任务 deleted=1，completion 行数不变
    #[test]
    fn e3_delete_rule_soft_deletes_tasks_keeps_completions() {
        let db = db();
        let before = completions(&db);
        let res = db.delete_rule("r_work", 1_700_000_000_002).unwrap();

        assert_eq!(res.tasks_deleted, 2, "含 2 个任务");
        assert_eq!(rule_int(&db, "r_work", "deleted"), 1);
        assert_eq!(rule_int(&db, "r_work", "dirty"), 1);
        assert_eq!(scalar(&db, "SELECT COUNT(1) FROM task WHERE rule_id='r_work' AND deleted=1"), 2);
        assert_eq!(scalar(&db, "SELECT COUNT(1) FROM task WHERE rule_id='r_work' AND dirty=1"), 2);
        assert_eq!(completions(&db), before, "打卡历史一条不删");
        assert_eq!(db.list_rules(true).unwrap().len(), 3, "规则从列表里消失");
        let day = db.day("2026-10-19").unwrap();
        assert!(day.tasks.iter().all(|t| t.rule_id != "r_work"), "删掉的规则不再出现在月历");
        assert!(db.delete_rule("r_work", 1).is_err(), "重复删除要报错");
    }

    /// E4：给规则加一个任务 → rule_id 正确、sort_order 递增、dirty=1
    #[test]
    fn e4_add_task_appends_sort_order() {
        let db = db();
        let task = db.add_task("r_work", "冥想", 1_700_000_000_003).unwrap();

        assert_eq!(task.rule_id, "r_work");
        assert_eq!(task.title, "冥想");
        assert_eq!(task.sort_order, 2, "排在种子的 0 / 1 之后");
        assert_eq!(task_int(&db, &task.id, "dirty"), 1, "新增任务必须 dirty=1");
        assert_eq!(task_int(&db, &task.id, "deleted"), 0);
        let rules = db.list_rules(true).unwrap();
        let work = rules.iter().find(|r| r.id == "r_work").unwrap();
        assert_eq!(work.tasks.len(), 3);
        assert_eq!(work.tasks.last().unwrap().id, task.id);
        let day = db.day("2026-10-19").unwrap();
        assert!(day.tasks.iter().any(|t| t.task_id == task.id), "新任务立刻出现在命中日");
    }

    /// E5：删除任务 → 任务 deleted=1，其 completion 行数不变
    #[test]
    fn e5_delete_task_keeps_completions() {
        let db = db();
        let before = completions(&db);
        db.delete_task("t_fit", 1_700_000_000_004).unwrap();

        assert_eq!(task_int(&db, "t_fit", "deleted"), 1);
        assert_eq!(task_int(&db, "t_fit", "dirty"), 1);
        assert_eq!(completions(&db), before, "任务删了，打卡历史也不删");
        let day = db.day("2026-10-19").unwrap();
        assert!(day.tasks.iter().all(|t| t.task_id != "t_fit"), "删掉的任务不再出现在月历");
        assert!(db.delete_task("t_fit", 1).is_err(), "重复删除要报错");
    }

    /// E6：编辑后不带 dirty 的记录不存在
    #[test]
    fn e6_every_edited_row_is_dirty() {
        let db = db();
        let ts = 1_700_000_000_009_i64;
        let ts2 = ts + 1;

        let mut inplace = input_of(&db, "r_work");
        inplace.title = "工作日常规 v2".into();
        db.update_rule(&inplace, Some(TODAY), ts).unwrap();

        let mut split = input_of(&db, "r_med");
        split.year_day = 16;
        split.new_id = "r_med_new".into();
        db.update_rule(&split, Some(TODAY), ts2).unwrap();

        let t = db.add_task("r_work", "拉伸", ts).unwrap();
        db.rename_task(&t.id, "拉伸 10 分钟", ts).unwrap();
        db.set_task_enabled(&t.id, false, ts).unwrap();
        db.delete_task(&t.id, ts).unwrap();
        db.delete_rule("r_rent", ts).unwrap();
        db.toggle_done("t_words", "2026-10-19", true).unwrap();

        for table in ["rule", "task"] {
            let bad = scalar(
                &db,
                &format!("SELECT COUNT(1) FROM {table} WHERE (updated_at={ts} OR updated_at={ts2}) AND dirty=0"),
            );
            assert_eq!(bad, 0, "{table} 里存在被这次编辑改过却没置 dirty 的行");
        }
        for id in ["r_work", "r_med", "r_med_new", "r_rent"] {
            assert_eq!(rule_int(&db, id, "dirty"), 1, "规则 {id} 应 dirty=1");
        }
        assert_eq!(task_int(&db, &t.id, "dirty"), 1, "被改名/停用/删除的任务 dirty=1");
    }

    /// 新增规则（契约 §9.1）：写规则 + 其下任务，全部 dirty=1，校验失败不落库
    #[test]
    fn create_rule_writes_rule_and_tasks() {
        let db = db();
        let input = RuleInput {
            id: String::new(),
            title: "喝水".into(),
            enabled: true,
            repeat_mode: 1,
            repeat_every: 2,
            start_date: "2026-10-01".into(),
            ..Default::default()
        };
        let id = db
            .create_rule(&input, &["起床后".to_string(), "睡前".to_string()], 1_700_000_000_010)
            .unwrap();
        assert!(id.starts_with("r_"), "后端补的 id 应有前缀：{id}");
        assert_eq!(rule_col(&db, &id, "title"), "喝水");
        assert_eq!(rule_int(&db, &id, "dirty"), 1);
        let tasks: Vec<(String, i64, i64)> = {
            let conn = db.conn.lock().unwrap();
            let mut stmt = conn
                .prepare("SELECT title,sort_order,dirty FROM task WHERE rule_id=?1 ORDER BY sort_order")
                .unwrap();
            let rows = stmt
                .query_map(params![id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
                .unwrap()
                .collect::<rusqlite::Result<Vec<_>>>()
                .unwrap();
            rows
        };
        assert_eq!(tasks.len(), 2);
        assert_eq!(tasks[0], ("起床后".to_string(), 0, 1));
        assert_eq!(tasks[1], ("睡前".to_string(), 1, 1));
        // 10-01 / 10-03 命中，10-02 不命中
        assert!(db.day("2026-10-03").unwrap().tasks.iter().any(|t| t.rule_id == id));

        // 校验：没有任务 / 周重复没选天 / 日期非法 / 每 N 天越界，全部拒绝且不落库
        let before = scalar(&db, "SELECT COUNT(1) FROM rule");
        assert!(db.create_rule(&input, &[], 1).is_err(), "至少要一个任务");
        let mut weekly = input.clone();
        weekly.repeat_mode = 0;
        weekly.weekdays_mask = 0;
        assert!(db.create_rule(&weekly, &["x".to_string()], 1).is_err(), "周重复没选天要拒");
        let mut bad_date = input.clone();
        bad_date.start_date = "2026-1-5".into();
        assert!(db.create_rule(&bad_date, &["x".to_string()], 1).is_err(), "非法日期要拒");
        let mut bad_every = input.clone();
        bad_every.repeat_every = 0;
        assert!(db.create_rule(&bad_every, &["x".to_string()], 1).is_err(), "每 N 天要 1..3660");
        assert_eq!(scalar(&db, "SELECT COUNT(1) FROM rule"), before, "被拒的写入不能落库");
    }

    /// 改名 / 启停是原地改：不动重复设置，也不裂开
    #[test]
    fn rename_and_toggle_task_in_place() {
        let db = db();
        db.rename_task("t_fit", "撸铁", 1_700_000_000_020).unwrap();
        db.set_task_enabled("t_fit", false, 1_700_000_000_021).unwrap();
        let day = db.day("2026-10-19").unwrap();
        assert!(day.tasks.iter().all(|t| t.task_id != "t_fit"), "停用的任务不参与展开");
        db.set_task_enabled("t_fit", true, 1_700_000_000_022).unwrap();
        let day = db.day("2026-10-19").unwrap();
        let fit = day.tasks.iter().find(|t| t.task_id == "t_fit").expect("重新启用后又出现");
        assert_eq!(fit.title, "撸铁");
    }

    /* ---------- 契约 §10.3：M1~M6（记事 / 倒数日 / 笔记本） ---------- */

    const MTS: i64 = 1_700_000_000_100;

    fn memo_int(db: &Db, id: &str, col: &str) -> i64 {
        scalar(db, &format!("SELECT {col} FROM memo WHERE id='{id}'"))
    }

    fn note_input(title: &str, start: &str, end: &str) -> MemoInput {
        MemoInput {
            kind: MEMO_NOTE,
            title: title.into(),
            start_date: start.into(),
            end_date: end.into(),
            ..Default::default()
        }
    }

    /// 该月里出现某条记事的日期（升序）；月历只认记事，不认倒数日与笔记本
    fn memo_days(db: &Db, y: i32, m: u32, title: &str) -> Vec<String> {
        db.month_grid(y, m)
            .unwrap()
            .days
            .into_iter()
            .filter(|d| d.memos.iter().any(|x| x.title == title))
            .map(|d| d.date)
            .collect()
    }

    /// M1：新建记事（不排期，start/end 都空）→ 落库成功、月历上任何一天都不出现、列表能看到
    #[test]
    fn m1_create_unscheduled_note_absent_from_month() {
        let db = db();
        let id = db.create_memo(&note_input("周末采购清单", "", ""), MTS).unwrap();
        assert_eq!(memo_int(&db, &id, "dirty"), 1, "新建必须 dirty=1");
        assert_eq!(memo_int(&db, &id, "deleted"), 0);
        let listed = db.list_memos(Some(MEMO_NOTE)).unwrap();
        assert!(listed.iter().any(|m| m.id == id && m.title == "周末采购清单"), "列表里要看得到它");
        for (y, m) in [(2026, 10), (2026, 11)] {
            assert!(memo_days(&db, y, m, "周末采购清单").is_empty(), "不排期的记事不进月历");
        }
        // 列表按 kind 过滤：记事不会出现在倒数日 / 笔记本列表里
        assert!(db.list_memos(Some(MEMO_COUNTDOWN)).unwrap().iter().all(|m| m.id != id));
        assert!(db.list_memos(Some(MEMO_NOTEBOOK)).unwrap().iter().all(|m| m.id != id));
    }

    /// M2：把记事改成时间段 10/27~10/29 → 月历三天都出现，10/26 与 10/30 不出现
    #[test]
    fn m2_note_range_shows_every_day_in_span() {
        let db = db();
        let id = db.create_memo(&note_input("出差", "", ""), MTS).unwrap();
        let mut edit = MemoInput { id: id.clone(), ..note_input("出差", "2026-10-27", "2026-10-29") };
        edit.id = id.clone();
        db.update_memo(&edit, MTS + 1).unwrap();
        assert_eq!(
            memo_days(&db, 2026, 10, "出差"),
            vec!["2026-10-27", "2026-10-28", "2026-10-29"],
            "区间内每天都显示，前后一天都不显示"
        );
        // 单日：只有开始日期那天
        let mut single = MemoInput { id: id.clone(), ..note_input("单日事", "2026-11-05", "") };
        single.id = id.clone();
        db.update_memo(&single, MTS + 2).unwrap();
        assert_eq!(memo_days(&db, 2026, 11, "单日事"), vec!["2026-11-05"]);
        // 日期区间合法性与格式：结束早于开始 / 非法日期都必须拒
        let mut bad = note_input("倒着写", "2026-10-29", "2026-10-27");
        bad.id = id.clone();
        assert!(db.update_memo(&bad, MTS + 3).is_err(), "结束早于开始要拒");
        let mut malformed = note_input("格式错", "2026/10/27", "");
        malformed.id = id.clone();
        assert!(db.update_memo(&malformed, MTS + 4).is_err(), "日期必须是 YYYY-MM-DD");
    }

    /// M3：新建倒数日（目标日 2027-03-15）→ 落库成功、不进月历、列表显示目标日
    #[test]
    fn m3_countdown_never_enters_month() {
        let db = db();
        let input = MemoInput {
            kind: MEMO_COUNTDOWN,
            title: "项目验收".into(),
            start_date: "2027-03-15".into(),
            content: "提前一周准备材料".into(),
            ..Default::default()
        };
        let id = db.create_memo(&input, MTS).unwrap();
        let row = db.list_memos(Some(MEMO_COUNTDOWN)).unwrap().into_iter().find(|m| m.id == id).unwrap();
        assert_eq!(row.start_date, "2027-03-15", "列表要显示目标日");
        assert_eq!(row.content, "提前一周准备材料");
        assert!(memo_days(&db, 2027, 3, "项目验收").is_empty(), "倒数日不进月历");
        assert_eq!(memo_int(&db, &id, "dirty"), 1);
        // 目标日必填：留空要被拒
        let missing = MemoInput { kind: MEMO_COUNTDOWN, title: "没有目标日".into(), ..Default::default() };
        assert!(db.create_memo(&missing, MTS).is_err(), "倒数日必须有目标日");
    }

    /// M4：新建笔记本（分类「习惯」）→ 落库成功、不进月历、分类正确
    #[test]
    fn m4_notebook_keeps_category() {
        let db = db();
        let input = MemoInput {
            kind: MEMO_NOTEBOOK,
            title: "晨间流程".into(),
            content: "喝水 / 拉伸 / 记账".into(),
            category: "习惯".into(),
            ..Default::default()
        };
        let id = db.create_memo(&input, MTS).unwrap();
        let row = db.list_memos(Some(MEMO_NOTEBOOK)).unwrap().into_iter().find(|m| m.id == id).unwrap();
        assert_eq!(row.category, "习惯");
        assert!(memo_days(&db, 2026, 10, "晨间流程").is_empty(), "笔记本永不进月历");
        // 分类留空 → 未分类；标题可空，但标题与正文都空要拒
        let blank_cat = MemoInput {
            kind: MEMO_NOTEBOOK,
            title: "无标题笔记".into(),
            content: "有内容就行".into(),
            ..Default::default()
        };
        let id2 = db.create_memo(&blank_cat, MTS + 1).unwrap();
        let cat2 = db.list_memos(Some(MEMO_NOTEBOOK)).unwrap().into_iter().find(|m| m.id == id2).unwrap().category;
        assert_eq!(cat2, MEMO_CAT_NONE, "分类留空一律归未分类");
        let empty = MemoInput { kind: MEMO_NOTEBOOK, title: "  ".into(), content: "   ".into(), ..Default::default() };
        assert!(db.create_memo(&empty, MTS + 2).is_err(), "标题与正文都空要拒");
        // 笔记本没有日期：给日期要拒
        let dated = MemoInput { kind: MEMO_NOTEBOOK, title: "带日期".into(), start_date: "2026-10-27".into(), ..Default::default() };
        assert!(db.create_memo(&dated, MTS + 3).is_err(), "笔记本没有日期");
    }

    /// M5：删除记事 → deleted=1、updated_at 变大、dirty=1；列表不再显示它
    #[test]
    fn m5_delete_note_soft_deletes() {
        let db = db();
        let id = db.create_memo(&note_input("临时记录", "2026-10-27", "2026-10-28"), MTS).unwrap();
        assert_eq!(memo_days(&db, 2026, 10, "临时记录").len(), 2);
        db.delete_memo(&id, MTS + 10).unwrap();
        assert_eq!(memo_int(&db, &id, "deleted"), 1, "删除一律软删");
        assert_eq!(memo_int(&db, &id, "dirty"), 1);
        assert_eq!(memo_int(&db, &id, "updated_at"), MTS + 10);
        assert!(memo_int(&db, &id, "updated_at") > MTS, "updated_at 必须变大");
        assert!(db.list_memos(Some(MEMO_NOTE)).unwrap().iter().all(|m| m.id != id), "列表不再显示它");
        assert!(memo_days(&db, 2026, 10, "临时记录").is_empty(), "删掉后月历也不再出现");
        assert!(db.delete_memo(&id, MTS + 11).is_err(), "重复删除要报不存在");
    }

    /// M6：三类的新建 / 编辑 / 删除之后，所有被改过的行 dirty 都为 1（待同步）
    #[test]
    fn m6_every_memo_write_is_dirty() {
        let db = db();
        let ts = MTS;
        let ts2 = MTS + 1;
        let note = db.create_memo(&note_input("周记", "", ""), ts).unwrap();
        let countdown = db
            .create_memo(&MemoInput { kind: MEMO_COUNTDOWN, title: "生日".into(), start_date: "2027-03-15".into(), ..Default::default() }, ts)
            .unwrap();
        let book = db
            .create_memo(&MemoInput { kind: MEMO_NOTEBOOK, title: "排查笔记".into(), content: "初稿".into(), category: "参考".into(), ..Default::default() }, ts)
            .unwrap();
        let mut edit = note_input("周记", "2026-10-27", "2026-10-29");
        edit.id = note.clone();
        db.update_memo(&edit, ts2).unwrap();
        db.delete_memo(&countdown, ts2).unwrap();

        let bad = scalar(&db, &format!("SELECT COUNT(1) FROM memo WHERE (updated_at={ts} OR updated_at={ts2}) AND dirty=0"));
        assert_eq!(bad, 0, "memo 里存在被这次编辑改过却没置 dirty 的行");
        for id in [&note, &countdown, &book] {
            assert_eq!(memo_int(&db, id, "dirty"), 1, "memo {id} 应 dirty=1");
        }
        // 同步载荷里带上了这三条（dirty=1 的才推）
        let body = db.collect_dirty().unwrap();
        assert_eq!(body.memos.len(), 3, "三条 memo 都进 push 载荷");
        assert!(body.memos.iter().any(|m| m.deleted == 1), "软删也要推出去");
    }

    /* ---------- 提醒（契约 §11.4 的 R1~R4） ---------- */

    fn remind_input(notify: i64, alarm: i64, time: &str) -> ReminderInput {
        ReminderInput {
            owner_kind: REMINDER_RULE,
            owner_id: "r_work".into(),
            notify_on: notify,
            alarm_on: alarm,
            time_of_day: time.into(),
            ..Default::default()
        }
    }

    fn rule_summary(db: &Db, id: &str) -> String {
        db.list_rules(true)
            .unwrap()
            .into_iter()
            .find(|r| r.id == id)
            .map(|r| r.reminder_summary)
            .unwrap_or_default()
    }

    fn reminder_int(db: &Db, id: &str, col: &str) -> i64 {
        scalar(db, &format!("SELECT {col} FROM reminder WHERE id='{id}'"))
    }

    /// R1：规则配「通知 21:00」→ 落库 notify_on=1 / alarm_on=0，列表摘要「通知 21:00」，dirty=1
    #[test]
    fn r1_notify_only_lands_dirty_and_shows_summary() {
        let db = db();
        let id = db.save_reminder(&remind_input(1, 0, "21:00"), MTS).unwrap();
        let row = db.get_reminder(REMINDER_RULE, "r_work").unwrap().expect("应存下提醒");
        assert_eq!((row.notify_on, row.alarm_on), (1, 0), "R1：只开通知");
        assert_eq!(row.time_of_day, "21:00");
        assert_eq!(row.updated_at, MTS);
        assert_eq!(reminder_int(&db, &id, "dirty"), 1, "R1：新写的提醒待同步");
        assert_eq!(reminder_int(&db, &id, "deleted"), 0);
        assert_eq!(rule_summary(&db, "r_work"), "通知 21:00", "R1：列表摘要");
        assert_eq!(db.dirty_count().unwrap(), 1, "种子不 dirty，只有这条提醒待推");
        assert_eq!(db.collect_dirty().unwrap().reminders.len(), 1, "R1：提醒进 push 载荷");
    }

    /// R2：在通知之上再开闹钟 → notify_on=1 / alarm_on=1，摘要「通知 21:00 + 闹钟 21:00」；
    /// 两个按钮各自独立切换，关掉闹钟后只剩通知
    #[test]
    fn r2_alarm_toggles_on_top_of_notify() {
        let db = db();
        let first = db.save_reminder(&remind_input(1, 0, "21:00"), MTS).unwrap();
        let id = db.save_reminder(&remind_input(1, 1, "21:00"), MTS + 1).unwrap();
        assert_eq!(id, first, "R2：一个 owner 只有一行，再存沿用同一 id");
        let row = db.get_reminder(REMINDER_RULE, "r_work").unwrap().unwrap();
        assert_eq!((row.notify_on, row.alarm_on), (1, 1), "R2：两个通道都开");
        assert_eq!(row.updated_at, MTS + 1);
        assert_eq!(rule_summary(&db, "r_work"), "通知 21:00 + 闹钟 21:00", "R2：摘要两段都要有");
        // 再点一次「闹钟」= 只关闹钟，通知原样保留（§11.1 独立切换）
        db.save_reminder(&remind_input(1, 0, "21:00"), MTS + 2).unwrap();
        assert_eq!(rule_summary(&db, "r_work"), "通知 21:00");
        // 只开闹钟也要能存（两种单开都是合法态）
        db.save_reminder(&remind_input(0, 1, "09:00"), MTS + 3).unwrap();
        assert_eq!(rule_summary(&db, "r_work"), "闹钟 09:00");
        assert_eq!(scalar(&db, "SELECT COUNT(1) FROM reminder"), 1, "R2：始终只有一行提醒");
    }

    /// R3：点「不提醒」→ 该提醒行软删，列表摘要不再显示提醒；墓碑要能被推走
    #[test]
    fn r3_clear_soft_deletes_and_hides_summary() {
        let db = db();
        let id = db.save_reminder(&remind_input(1, 1, "09:00"), MTS).unwrap();
        db.clear_reminder(REMINDER_RULE, "r_work", MTS + 1).unwrap();
        assert!(db.get_reminder(REMINDER_RULE, "r_work").unwrap().is_none(), "R3：软删后读不到");
        assert_eq!(reminder_int(&db, &id, "deleted"), 1, "R3：墓碑不是物理删");
        assert_eq!(reminder_int(&db, &id, "dirty"), 1, "R3：墓碑要推给对端");
        assert_eq!(reminder_int(&db, &id, "updated_at"), MTS + 1);
        assert_eq!(scalar(&db, "SELECT COUNT(1) FROM reminder"), 1, "R3：行还在，只打删除标记");
        assert_eq!(rule_summary(&db, "r_work"), "", "R3：列表不再显示提醒");
        db.clear_reminder(REMINDER_RULE, "r_work", MTS + 2).unwrap(); // 幂等
        // 软删后再存会复活同一行，不会长出第二行
        db.save_reminder(&remind_input(0, 1, "09:00"), MTS + 3).unwrap();
        assert_eq!(scalar(&db, "SELECT COUNT(1) FROM reminder"), 1, "R3：复活的是原来那行");
        assert_eq!(rule_summary(&db, "r_work"), "闹钟 09:00");
    }

    /// R4：两个开关都关的提醒被写入层拒绝（schema anyOf 已拦），库里不留行；其余字段也照 schema 校验
    #[test]
    fn r4_rejects_reminder_with_both_channels_off() {
        let db = db();
        let err = db.save_reminder(&remind_input(0, 0, "09:00"), MTS).unwrap_err();
        assert!(err.contains("至少要开一个通道"), "R4：应明确拒绝：{err}");
        assert_eq!(scalar(&db, "SELECT COUNT(1) FROM reminder"), 0, "R4：拒绝后不落库");
        assert_eq!(rule_summary(&db, "r_work"), "");
        // HH:mm（schema 的 pattern）/ owner_kind（enum）/ snooze_min（0..60）
        assert!(db.save_reminder(&remind_input(1, 0, "9:00"), MTS).is_err(), "9:00 不是 HH:mm");
        assert!(db.save_reminder(&remind_input(1, 0, "24:00"), MTS).is_err(), "24:00 越界");
        let mut bad_kind = remind_input(1, 0, "09:00");
        bad_kind.owner_kind = 3;
        assert!(db.save_reminder(&bad_kind, MTS).unwrap_err().contains("owner_kind"));
        let mut bad_snooze = remind_input(1, 1, "09:00");
        bad_snooze.snooze_min = 61;
        assert!(db.save_reminder(&bad_snooze, MTS).is_err(), "snooze_min 越界要拒");
        // 墓碑豁免（契约 §11.1）：deleted=1 时两个开关都关是合法的删除记录，否则删除永远同步不出去
        let mut tomb = remind_input(0, 0, "09:00");
        tomb.deleted = 1;
        assert!(validate_reminder(&tomb).is_ok(), "墓碑不该被「至少开一个」拦住");
        assert_eq!(scalar(&db, "SELECT COUNT(1) FROM reminder"), 0, "校验失败的都没落库");
    }

    /// 契约 §9.3：删规则要级联软删它的提醒（否则留下指向已删规则的孤儿行）
    #[test]
    fn delete_rule_cascades_reminder_soft_delete() {
        let db = db();
        let id = db.save_reminder(&remind_input(1, 0, "21:00"), MTS).unwrap();
        db.delete_rule("r_work", MTS + 1).unwrap();
        assert!(db.get_reminder(REMINDER_RULE, "r_work").unwrap().is_none(), "规则没了提醒也读不到");
        assert_eq!(reminder_int(&db, &id, "deleted"), 1);
        assert_eq!(reminder_int(&db, &id, "dirty"), 1, "墓碑要推出去，对端才跟着删");
        assert_eq!(reminder_int(&db, &id, "updated_at"), MTS + 1);
    }
}