//! 生成 PC 端真实 push 报文：结构体逐字取自 pc/src-tauri/src/db.rs（payload.rs），
//! 数据用 rusqlite + PC 自己的 schema.sql 建库后按 PC 的写路径插入，
//! 再由 serde 序列化 —— 报文的键名/数字类型/可选字段 null 与省略全部由 PC 的真实代码决定。
mod payload;

use payload::*;
use rusqlite::{params, Connection};

const PC_SCHEMA: &str = include_str!("../../pc_schema.sql");

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let conn = Connection::open_in_memory()?;
    conn.execute_batch(PC_SCHEMA)?;
    // PC 端的 now_ms()：毫秒
    let now: i64 = 1_760_000_000_123;

    // rule：end_date/repeat_until 为 None → serde 会输出 null（PC 本地是 NULL 列）
    conn.execute(
        "INSERT INTO rule (id,title,enabled,repeat_mode,weekdays_mask,repeat_every,month_day,year_month,year_day,start_date,end_date,repeat_until,rev,updated_at,deleted,dirty)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,1)",
        params!["r_pc_work", "PC工作日常规", 1i64, 0i64, 31i64, None::<i64>, None::<i64>, None::<i64>, None::<i64>,
                "2026-10-01", None::<String>, None::<String>, 0i64, now, 0i64],
    )?;
    // 第二条：带 end_date + repeat_until（非空字符串）
    conn.execute(
        "INSERT INTO rule (id,title,enabled,repeat_mode,weekdays_mask,repeat_every,month_day,year_month,year_day,start_date,end_date,repeat_until,rev,updated_at,deleted,dirty)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,1)",
        params!["r_pc_rent", "PC房租", 0i64, 2i64, 0i64, None::<i64>, 20i64, None::<i64>, None::<i64>,
                "2026-01-01", "2026-12-31", "2026-11-30", 0i64, now, 0i64],
    )?;

    conn.execute(
        "INSERT INTO task (id,rule_id,title,enabled,sort_order,rev,updated_at,deleted,dirty)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,1)",
        params!["t_pc_fit", "r_pc_work", "PC健身", 1i64, 0i64, 0i64, now, 0i64],
    )?;

    // memo：content/start_date/end_date/category 全 NULL → Option 全 None
    conn.execute(
        "INSERT INTO memo (id,kind,title,content,start_date,end_date,category,rev,updated_at,deleted,dirty)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,1)",
        params!["m_pc_note", 0i64, "PC记事", None::<String>, None::<String>, None::<String>, None::<String>,
                0i64, now, 0i64],
    )?;
    // memo：倒数日，三个可选字段都有值
    conn.execute(
        "INSERT INTO memo (id,kind,title,content,start_date,end_date,category,rev,updated_at,deleted,dirty)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,1)",
        params!["m_pc_countdown", 1i64, "PC倒数日", "一百天", "2026-10-01", "2026-12-31", "生活",
                0i64, now, 0i64],
    )?;

    // reminder：notify_text NULL；notify_on/alarm_on 是 0/1
    conn.execute(
        "INSERT INTO reminder (id,owner_kind,owner_id,notify_on,alarm_on,time_of_day,notify_text,offset_days,repeat_rule,snooze_min,enabled,rev,updated_at,deleted,dirty)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,1)",
        params!["rem_pc_1", 0i64, "r_pc_work", 1i64, 0i64, "21:00", None::<String>, 0i64, 0i64, 0i64, 1i64, 0i64, now, 0i64],
    )?;

    // completion：复合主键 (task_id, period_start)，PC 的序列化键名 task_id / period_start
    conn.execute(
        "INSERT INTO completion (task_id,period_start,status,rev,updated_at,deleted,dirty)
         VALUES (?1,?2,?3,?4,?5,?6,1)",
        params!["t_pc_fit", "2026-10-19", 1i64, 0i64, now, 0i64],
    )?;

    let body = collect_dirty(&conn)?;
    println!("{}", serde_json::to_string_pretty(&body)?);
    Ok(())
}

/// 逐字复刻 pc 的 Db::collect_dirty 的 SQL 与列序。
fn collect_dirty(conn: &Connection) -> Result<PushBody, Box<dyn std::error::Error>> {
    let rules = {
        let mut stmt = conn.prepare(
            "SELECT id,title,enabled,repeat_mode,weekdays_mask,repeat_every,month_day,\
             year_month,year_day,start_date,end_date,repeat_until,rev,updated_at,deleted \
             FROM rule WHERE dirty=1",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(RuleRec {
                id: r.get(0)?, title: r.get(1)?, enabled: r.get(2)?, repeat_mode: r.get(3)?,
                weekdays_mask: r.get(4)?, repeat_every: r.get(5)?, month_day: r.get(6)?,
                year_month: r.get(7)?, year_day: r.get(8)?, start_date: r.get(9)?,
                end_date: r.get(10)?, repeat_until: r.get(11)?, rev: r.get(12)?,
                updated_at: r.get(13)?, deleted: r.get(14)?,
            })
        })?.collect::<rusqlite::Result<Vec<_>>>()?;
        rows
    };
    let tasks = {
        let mut stmt = conn.prepare(
            "SELECT id,rule_id,title,enabled,sort_order,rev,updated_at,deleted FROM task WHERE dirty=1",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(TaskRec {
                id: r.get(0)?, rule_id: r.get(1)?, title: r.get(2)?, enabled: r.get(3)?,
                sort_order: r.get(4)?, rev: r.get(5)?, updated_at: r.get(6)?, deleted: r.get(7)?,
            })
        })?.collect::<rusqlite::Result<Vec<_>>>()?;
        rows
    };
    let memos = {
        let mut stmt = conn.prepare(
            "SELECT id,kind,title,content,start_date,end_date,category,rev,updated_at,deleted \
             FROM memo WHERE dirty=1",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(MemoRec {
                id: r.get(0)?, kind: r.get(1)?, title: r.get(2)?, content: r.get(3)?,
                start_date: r.get(4)?, end_date: r.get(5)?, category: r.get(6)?, rev: r.get(7)?,
                updated_at: r.get(8)?, deleted: r.get(9)?,
            })
        })?.collect::<rusqlite::Result<Vec<_>>>()?;
        rows
    };
    let reminders = {
        let mut stmt = conn.prepare(
            "SELECT id,owner_kind,owner_id,notify_on,alarm_on,time_of_day,notify_text,\
             offset_days,repeat_rule,snooze_min,enabled,rev,updated_at,deleted \
             FROM reminder WHERE dirty=1",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(ReminderRec {
                id: r.get(0)?, owner_kind: r.get(1)?, owner_id: r.get(2)?, notify_on: r.get(3)?,
                alarm_on: r.get(4)?, time_of_day: r.get(5)?, notify_text: r.get(6)?,
                offset_days: r.get(7)?, repeat_rule: r.get(8)?, snooze_min: r.get(9)?,
                enabled: r.get(10)?, rev: r.get(11)?, updated_at: r.get(12)?, deleted: r.get(13)?,
            })
        })?.collect::<rusqlite::Result<Vec<_>>>()?;
        rows
    };
    let completions = {
        let mut stmt = conn.prepare(
            "SELECT task_id,period_start,status,rev,updated_at,deleted FROM completion WHERE dirty=1",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(CompletionRec {
                task_id: r.get(0)?, period_start: r.get(1)?, status: r.get(2)?, rev: r.get(3)?,
                updated_at: r.get(4)?, deleted: r.get(5)?,
            })
        })?.collect::<rusqlite::Result<Vec<_>>>()?;
        rows
    };
    Ok(PushBody { rules, tasks, memos, reminders, completions })
}
