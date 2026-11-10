use serde::{Deserialize, Serialize};
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

