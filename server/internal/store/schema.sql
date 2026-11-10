-- 定稿 §3.5 的落地版。三条硬约束：日期一律 'YYYY-MM-DD'；删除一律软删（deleted=1），永不物理 DELETE；同步三件套 rev / updated_at / deleted / dirty。

CREATE TABLE IF NOT EXISTS rule (
  id            TEXT PRIMARY KEY,
  title         TEXT NOT NULL,
  enabled       INTEGER NOT NULL DEFAULT 1,
  repeat_mode   INTEGER NOT NULL,              -- 0=weekly 1=every 2=monthly 3=yearly 4=none
  weekdays_mask INTEGER NOT NULL DEFAULT 0,    -- bit0=周一 … bit6=周日
  repeat_every  INTEGER,                       -- 1..3660
  month_day     INTEGER,                       -- 1..31；-1 = 每月最后一天
  year_month    INTEGER,                       -- 1..12
  year_day      INTEGER,                       -- 1..31
  start_date    TEXT NOT NULL,
  end_date      TEXT,
  repeat_until  TEXT,
  rev           INTEGER NOT NULL DEFAULT 0,
  updated_at    INTEGER NOT NULL,
  deleted       INTEGER NOT NULL DEFAULT 0,
  dirty         INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS task (
  id          TEXT PRIMARY KEY,
  rule_id     TEXT NOT NULL REFERENCES rule(id),
  title       TEXT NOT NULL,
  enabled     INTEGER NOT NULL DEFAULT 1,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  rev         INTEGER NOT NULL DEFAULT 0,
  updated_at  INTEGER NOT NULL,
  deleted     INTEGER NOT NULL DEFAULT 0,
  dirty       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_task_rule ON task(rule_id);

-- 打卡：一个周期一行，作用于该周期内全部命中日
CREATE TABLE IF NOT EXISTS completion (
  task_id       TEXT NOT NULL REFERENCES task(id),
  period_start  TEXT NOT NULL,
  status        INTEGER NOT NULL DEFAULT 0,    -- 0=未完成 1=已完成
  rev           INTEGER NOT NULL DEFAULT 0,
  updated_at    INTEGER NOT NULL,
  deleted       INTEGER NOT NULL DEFAULT 0,
  dirty         INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (task_id, period_start)
);
CREATE INDEX IF NOT EXISTS idx_completion_period ON completion(period_start);

-- 全局单调递增的 rev 计数器（契约 §7.1：写入时 rev = 服务端当前 maxRev + 1）。
-- 单行表，比每次写入都 SELECT MAX(rev) 贵在省事：O(1)、且不受某张表被清空的影响。
CREATE TABLE IF NOT EXISTS sync_counter (
  id  INTEGER PRIMARY KEY CHECK (id = 1),
  rev INTEGER NOT NULL DEFAULT 0
);

-- 记事 / 倒数日 / 笔记本，不挂规则下
CREATE TABLE IF NOT EXISTS memo (
  id          TEXT PRIMARY KEY,
  kind        INTEGER NOT NULL,                -- 0=记事 1=倒数日 2=笔记本
  title       TEXT NOT NULL,
  content     TEXT,
  start_date  TEXT,
  end_date    TEXT,
  category    TEXT,
  rev         INTEGER NOT NULL DEFAULT 0,
  updated_at  INTEGER NOT NULL,
  deleted     INTEGER NOT NULL DEFAULT 0,
  dirty       INTEGER NOT NULL DEFAULT 0
);

-- 提醒：挂在规则（owner_kind=0）或记事/倒数日（1/2）上；规则下的任务继承所属规则的提醒，不单独配。
-- notify_on / alarm_on 是两个独立布尔，但「两个都为 0」是非法状态（契约 §11.1，schema 用 anyOf 拦死）：
-- 想不提醒就软删这行或 enabled=0，不要留一行两个开关全灭的提醒。写入层校验见 sync.go 的 validateReminder。
-- 不建外键：owner_id 按 owner_kind 指向 rule.id 或 memo.id，一列两表没法用 REFERENCES 表达。
CREATE TABLE IF NOT EXISTS reminder (
  id           TEXT PRIMARY KEY,
  owner_kind   INTEGER NOT NULL,                -- 0=规则 1=记事 2=倒数日
  owner_id     TEXT NOT NULL,                   -- rule.id / memo.id
  notify_on    INTEGER NOT NULL DEFAULT 0,      -- 1=发通知
  alarm_on     INTEGER NOT NULL DEFAULT 0,      -- 1=响闹钟
  time_of_day  TEXT NOT NULL,                   -- HH:mm
  notify_text  TEXT,                            -- 空则用「该打卡了：<规则名>」
  offset_days  INTEGER NOT NULL DEFAULT 0,      -- 负数=提前 N 天
  repeat_rule  INTEGER NOT NULL DEFAULT 0,      -- 0=周期首个命中日 1=每个命中日
  snooze_min   INTEGER NOT NULL DEFAULT 0,      -- 0=不贪睡
  enabled      INTEGER NOT NULL DEFAULT 1,
  rev          INTEGER NOT NULL DEFAULT 0,
  updated_at   INTEGER NOT NULL,
  deleted      INTEGER NOT NULL DEFAULT 0,
  dirty        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_reminder_owner ON reminder(owner_kind, owner_id);
