//! 提醒的**真实调度**（定稿 §6.3.4）：后台线程每 30 秒对表一次，到点就触发。
//!
//! 为什么是独立线程 + 每 30 秒轮询，而不是前端 JS 定时器：
//!  1. **不依赖窗口**。前端定时器在窗口关掉、最小化到托盘、或 WebView 被回收后就不再跑 ——
//!     这正是 Android 端踩过的坑（进程被冻结后，AlarmManager 之外的定时全部失效）。
//!     这里的线程属于主进程，窗口关不关它都在；只有进程退出才停。
//!  2. **轮询而不是「一次性睡到触发点」**：睡到触发点要额外处理「提醒被改了要唤醒」和
//!     「系统休眠 / 改时间后睡醒时刻会漂」两件事。30 秒对一次表，最坏误差 30 秒，
//!     而且天然「每轮重新读库」——改完提醒下一轮就生效，不需要任何跨线程唤醒协议。
//!  3. 30 秒粒度对「精确到分钟」的提醒足够：判据是 fire_at <= now 就触发，不会漏。
//!
//! 触发分两档（定稿 §6.3.2）：
//!  - notify_on=1：系统通知（tauri-plugin-notification -> Windows toast）；
//!  - alarm_on=1：置顶唤起主窗口 + 循环响铃 + 独立置顶闹钟窗（必须手动关）。
//! 两者可以同时开（契约 §11.1）。
//!
//! 贪睡（定稿 §6.3.5）：snooze_min > 0 时闹钟窗给「稍后提醒 N 分钟」按钮，
//! 按下后到点重排一次，不改数据库（贪睡是运行时状态，不是用户配置）。

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_notification::NotificationExt;

use crate::db::{Db, MemoRow, ReminderRow, RuleRow, MEMO_COUNTDOWN, MEMO_NOTE};
use crate::engine;
use crate::reminder::{self, FirePoint, Target};

/// 对表间隔
pub const TICK: Duration = Duration::from_secs(30);
/// 对表容差：线程每 30 秒醒一次，触发点几乎总落在两次醒之间，所以要往回看这么久。
/// 取 60 秒 > TICK，兜住线程被系统临时挂起的情况；再久就不补响了（契约 §11：不能补响过去）。
pub const DUE_TOLERANCE_MS: i64 = 60_000;
/// 响铃最长 5 分钟后自动停（定稿 §6.3.5：不能无限响）
pub const ALARM_MAX_SECS: i64 = 300;

/// 调度器对外暴露的运行时状态（设置页照实显示，不假装正常）
#[derive(Clone, Debug, Default, Serialize)]
pub struct ScheduleStatus {
    pub scheduled: i64,
    pub next_fire_at: i64,
    pub next_fire_text: String,
    pub next_fire_title: String,
    pub last_error: String,
    pub last_fired_at: i64,
    pub last_fired_text: String,
    pub last_fired_title: String,
    pub fired_count: i64,
    pub thread_alive: bool,
    /// 通知通道是否健康：只在**真的递交失败**后才变 false。
    /// 不能用「有没有成功过」来推断 —— 只开闹钟、从没发过通知的提醒不能被报成「递交失败」。
    pub notify_ok: bool,
    pub ringing: i64,
    pub tick_secs: i64,
    /// 铃铛此刻是否真的在响（由 alarm 模块的真实状态回报，不是根据「应该响」推测）
    pub sound_playing: bool,
}

/// 一条待响的提醒
struct Fired {
    reminder_id: String,
    rule_id: String,
    title: String,
    body: String,
    notify: bool,
    alarm: bool,
    snooze_min: i64,
    fire_at: i64,
    period_start: String,
    occur_date: String,
}

/// 调度器的共享状态
pub struct ReminderScheduler {
    inner: Mutex<Inner>,
}

impl Default for ReminderScheduler {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Default)]
struct Inner {
    status: ScheduleStatus,
    /// 正在响的闹钟：reminder_id -> 闹钟窗信息
    ringing: HashMap<String, Ringing>,
    /// 贪睡队列：reminder_id -> 到点时间与内容
    snoozes: HashMap<String, Snooze>,
    /// 已触发过的 (reminder_id, fire_at)，防同一触发点重复响
    fired: Vec<(String, i64)>,
    /// 通知通路计数：试了几次、失败几次。状态只看失败次数，不看成功
    notify_tried: i64,
    notify_failed: i64,
}

#[derive(Clone)]
struct Ringing {
    label: String,
    stop_at: i64,
}

#[derive(Clone)]
struct Snooze {
    until: i64,
    title: String,
    body: String,
    notify: bool,
    alarm: bool,
    snooze_min: i64,
    rule_id: String,
    period_start: String,
    occur_date: String,
}

impl ReminderScheduler {
    pub fn new() -> Self {
        let inner = Inner {
            // 没试过之前报「可用」而不是「失败」：默认值必须与真实语义一致
            status: ScheduleStatus {
                notify_ok: true,
                ..Default::default()
            },
            ..Default::default()
        };
        ReminderScheduler {
            inner: Mutex::new(inner),
        }
    }

    pub fn status(&self) -> ScheduleStatus {
        match self.inner.lock() {
            Ok(g) => g.status.clone(),
            Err(_) => ScheduleStatus {
                last_error: "调度状态互斥锁已中毒".to_string(),
                ..Default::default()
            },
        }
    }

    fn with<R>(&self, f: impl FnOnce(&mut Inner) -> R) -> Option<R> {
        self.inner.lock().ok().map(|mut g| f(&mut g))
    }

    fn set_error(&self, msg: &str) {
        let mut trimmed: String = msg.chars().take(300).collect();
        if trimmed.trim().is_empty() {
            trimmed = "未知错误".to_string();
        }
        self.with(|g| g.status.last_error = trimmed);
    }

    /// 贪睡：把这条提醒推到 now + minutes 分钟后再响一次
    pub fn snooze(&self, reminder_id: &str, minutes: i64) {
        let due = match reminder::snooze_at(reminder::now_ms(), minutes) {
            Some(v) => v,
            None => return,
        };
        self.with(|g| {
            if let Some(e) = g.snoozes.get_mut(reminder_id) {
                e.until = due;
            }
        });
        self.stop_alarm(reminder_id);
    }

    /// 停止响铃（用户点「停止」）。幂等：没有在响的也必须安全返回。
    pub fn stop_alarm(&self, reminder_id: &str) {
        #[cfg(windows)]
        crate::alarm::stop();
        let removed = self.with(|g| g.ringing.remove(reminder_id)).flatten();
        if let Some(r) = removed {
            if let Some(app) = APP.get() {
                if let Some(w) = app.get_webview_window(&r.label) {
                    let _ = w.close();
                }
                if let Some(main) = app.get_webview_window("main") {
                    let _ = main.set_always_on_top(false);
                }
                let _ = app.emit("took://reminder-stopped", reminder_id.to_string());
            }
        }
        self.with(|g| g.status.ringing = g.ringing.len() as i64);
    }
}

/// 全局 AppHandle：让没有 AppHandle 参数的路径也能关闹钟窗
static APP: std::sync::OnceLock<AppHandle> = std::sync::OnceLock::new();
/// 后台线程是否活着（设置页要显示「窗口关掉后它还在跑」）
pub static ALIVE: AtomicBool = AtomicBool::new(false);
/// 请调度线程立刻对表一次（保存 / 清除提醒之后用，省得等 30 秒）
static WAKE: AtomicBool = AtomicBool::new(false);

/// 请调度线程立刻对表一次（不阻塞调用方）
pub fn poke() {
    WAKE.store(true, Ordering::SeqCst);
}

/// 启动后台调度线程。只启动一次；进程活着它就一直在跑，与窗口生命周期无关。
pub fn start(app: AppHandle) {
    let _ = APP.set(app.clone());
    if ALIVE.swap(true, Ordering::SeqCst) {
        return;
    }
    let spawned = std::thread::Builder::new()
        .name("took-reminder".into())
        .spawn(move || {
            println!("[took][提醒] 调度线程已启动（每 {} 秒对表一次）", TICK.as_secs());
            loop {
                let now = reminder::now_ms();
                tick(&app, now);
                // 30 秒一格，但被 poke 过就立刻进入下一轮（500ms 小睡便于及时醒来）
                let mut slept: u64 = 0;
                while slept < TICK.as_millis() as u64 {
                    if WAKE.swap(false, Ordering::SeqCst) {
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(500));
                    slept += 500;
                }
            }
        })
        .ok();
    if spawned.is_none() {
        ALIVE.store(false, Ordering::SeqCst);
        println!("[took][提醒] 调度线程启动失败");
    }
}

/// 一轮对表：算出该响的 -> 触发；顺带算好设置页要的状态。
fn tick(app: &AppHandle, now: i64) {
    let db = match app.try_state::<Db>() {
        Some(d) => d,
        None => return,
    };
    let sched = match app.try_state::<ReminderScheduler>() {
        Some(s) => s,
        None => return,
    };
    ALIVE.store(true, Ordering::SeqCst);

    let candidates = match build_candidates(&db) {
        Ok(v) => v,
        Err(e) => {
            sched.set_error(&format!("读提醒失败：{e}"));
            return;
        }
    };

    let mut scheduled = 0i64;
    let mut next: Option<(i64, String)> = None;
    let mut due: Vec<(usize, FirePoint)> = Vec::new();

    for (i, cand) in candidates.iter().enumerate() {
        let target = match target_of(cand.row.owner_kind, &cand.owner) {
            Some(t) => t,
            None => continue,
        };
        if let Some(p) = reminder::next_fire(&target, &cand.row, now) {
            scheduled += 1;
            if next.as_ref().map(|n| p.fire_at < n.0).unwrap_or(true) {
                next = Some((p.fire_at, cand.owner_title.clone()));
            }
        }
        if let Some(p) = due_point(&sched, &cand.row, &target, now) {
            due.push((i, p));
        }
    }

    // 贪睡到点的
    let snoozes: Vec<(String, Snooze)> = sched
        .with(|g| g.snoozes.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
        .unwrap_or_default();
    for (rid, e) in snoozes {
        if e.until > now {
            continue;
        }
        sched.with(|g| {
            g.snoozes.remove(&rid);
        });
        let f = Fired {
            reminder_id: rid,
            rule_id: e.rule_id,
            title: e.title,
            body: e.body,
            notify: e.notify,
            alarm: e.alarm,
            snooze_min: e.snooze_min,
            fire_at: e.until,
            period_start: e.period_start,
            occur_date: e.occur_date,
        };
        deliver(app, &sched, &f);
    }

    for (i, p) in due {
        let cand = &candidates[i];
        let f = Fired {
            reminder_id: cand.row.id.clone(),
            rule_id: cand.owner_id.clone(),
            title: cand.owner_title.clone(),
            body: reminder::body_of(&cand.row.notify_text, &cand.owner_title),
            notify: cand.row.notify_on == 1,
            alarm: cand.row.alarm_on == 1,
            snooze_min: cand.row.snooze_min,
            fire_at: p.fire_at,
            period_start: p.period_start,
            occur_date: p.occur_date,
        };
        deliver(app, &sched, &f);
    }

    // 响太久的闹钟自动停（定稿 §6.3.5）
    let expired: Vec<String> = sched
        .with(|g| {
            g.ringing
                .iter()
                .filter(|(_, r)| r.stop_at <= now)
                .map(|(k, _)| k.clone())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    for rid in expired {
        sched.stop_alarm(&rid);
        sched.set_error("有一条闹钟响满 5 分钟无人操作，已自动停止");
    }

    sched.with(|g| {
        g.status.scheduled = scheduled;
        g.status.thread_alive = ALIVE.load(Ordering::SeqCst);
        g.status.tick_secs = TICK.as_secs() as i64;
        match &next {
            Some((at, title)) => {
                g.status.next_fire_at = *at;
                g.status.next_fire_text = reminder::local_text_of(*at);
                g.status.next_fire_title = title.clone();
            }
            None => {
                g.status.next_fire_at = 0;
                g.status.next_fire_text = String::new();
                g.status.next_fire_title = String::new();
            }
        }
        g.status.ringing = g.ringing.len() as i64;
    });
}

/// 「这一次该不该响」：找落在 (now - 容差, now] 里的那个触发点。
///
/// 为什么不是 next_fire(...) == now：next_fire 只返回未来，过去一刻会被跳过；而线程每
/// 30 秒才醒一次，触发点几乎永远落在两次醒之间。所以把扫描起点往回拨一个容差窗口，
/// 命中后用 (reminder_id, fire_at) 去重，保证一个触发点只响一次。
fn due_point(
    sched: &ReminderScheduler,
    row: &ReminderRow,
    target: &Target,
    now: i64,
) -> Option<FirePoint> {
    let p = reminder::next_fire(target, row, now - DUE_TOLERANCE_MS)?;
    if p.fire_at > now {
        return None;
    }
    let already = sched
        .with(|g| g.fired.iter().any(|(id, at)| id == &row.id && *at == p.fire_at))
        .unwrap_or(true);
    if already {
        return None;
    }
    sched.with(|g| {
        g.fired.push((row.id.clone(), p.fire_at));
        if g.fired.len() > 256 {
            let drop = g.fired.len() - 256;
            g.fired.drain(0..drop);
        }
    });
    Some(p)
}

/// 递交：通知 + / 或 闹钟（两个通道彼此独立，契约 §11.1）
fn deliver(app: &AppHandle, sched: &ReminderScheduler, f: &Fired) {
    if f.alarm {
        ring(app, sched, f);
    }
    if f.notify {
        match app.notification().builder().title(&f.title).body(&f.body).show() {
            Ok(()) => {
                sched.with(|g| {
                    g.notify_tried += 1;
                    g.status.notify_ok = g.notify_failed == 0;
                });
                println!(
                    "[took][提醒] 通知已递交：{} / {}（到点 {}）",
                    f.title,
                    f.body,
                    reminder::local_text_of(f.fire_at)
                );
            }
            Err(e) => {
                sched.set_error(&format!("通知递交失败：{e}"));
                sched.with(|g| {
                    g.notify_tried += 1;
                    g.notify_failed += 1;
                    g.status.notify_ok = false;
                });
                println!("[took][提醒] 通知递交失败：{e}");
            }
        }
    }
    let _ = app.emit(
        "took://reminder-fired",
        serde_json::json!({
            "reminder_id": f.reminder_id,
            "rule_id": f.rule_id,
            "title": f.title,
            "body": f.body,
            "notify": f.notify,
            "alarm": f.alarm,
            "fire_at": f.fire_at,
            "occur_date": f.occur_date,
            "period_start": f.period_start,
        }),
    );
    sched.with(|g| {
        g.status.last_fired_at = reminder::now_ms();
        g.status.last_fired_text = reminder::local_text_of(g.status.last_fired_at);
        g.status.last_fired_title = f.title.clone();
        g.status.fired_count += 1;
    });
    if !f.alarm {
        println!("[took][提醒] 已触发（通知）：{}", f.title);
    }
}

/// 闹钟模式：置顶唤起 + 响铃 + 独立闹钟窗（定稿 §6.3.5）
fn ring(app: &AppHandle, sched: &ReminderScheduler, f: &Fired) {
    let label = format!("alarm-{}", sanitize(&f.reminder_id));
    let stop_at = reminder::now_ms() + ALARM_MAX_SECS * 1000;
    sched.with(|g| {
        g.ringing.insert(
            f.reminder_id.clone(),
            Ringing {
                label: label.clone(),
                stop_at,
            },
        );
        if let Some(e) = g.snoozes.get_mut(&f.reminder_id) {
            // 重新响时把贪睡项内容刷新为这一轮的内容
            e.title = f.title.clone();
            e.body = f.body.clone();
        } else if f.snooze_min > 0 {
            g.snoozes.insert(
                f.reminder_id.clone(),
                Snooze {
                    // until 先设成「远未来」，等用户真的按了贪睡才改成 now+N
                    until: i64::MAX,
                    title: f.title.clone(),
                    body: f.body.clone(),
                    notify: f.notify,
                    alarm: f.alarm,
                    snooze_min: f.snooze_min,
                    rule_id: f.rule_id.clone(),
                    period_start: f.period_start.clone(),
                    occur_date: f.occur_date.clone(),
                },
            );
        }
    });

    #[cfg(windows)]
    crate::alarm::start();

    if let Some(main) = app.get_webview_window("main") {
        let _ = main.unminimize();
        let _ = main.show();
        let _ = main.set_always_on_top(true);
        let _ = main.set_focus();
    }

    match WebviewWindowBuilder::new(app, &label, WebviewUrl::App(alarm_page_url(f).into()))
        .title("Tool · 提醒")
        .inner_size(520.0, 400.0)
        .resizable(false)
        .minimizable(false)
        .maximizable(false)
        .always_on_top(true)
        .center()
        .build()
    {
        Ok(w) => {
            let _ = w.set_focus();
            println!("[took][提醒] 闹钟窗口已弹出：{label}（{}）", f.title);
        }
        Err(e) => {
            sched.set_error(&format!("闹钟窗口创建失败：{e}"));
            println!("[took][提醒] 闹钟窗口创建失败：{e}");
        }
    }
    let _ = app.emit("took://reminder-alarm", f.reminder_id.clone());
    sched.with(|g| g.status.ringing = g.ringing.len() as i64);
}

fn alarm_page_url(f: &Fired) -> String {
    format!(
        "alarm.html?id={}&title={}&body={}&snooze={}",
        urlenc(&f.reminder_id),
        urlenc(&f.title),
        urlenc(&f.body),
        f.snooze_min
    )
}

fn urlenc(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 3);
    for b in s.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(*b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

fn sanitize(s: &str) -> String {
    s.chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .collect()
}

/// 一个待排的提醒：行 + 宿主（规则或 memo）
pub struct Candidate {
    pub row: ReminderRow,
    pub owner_id: String,
    pub owner_title: String,
    pub owner: Owner,
}

/// 宿主的数据形态：规则要整份 Rule，memo 只要日期
#[derive(Clone, Debug)]
pub enum Owner {
    Rule(Box<engine::Rule>),
    Memo {
        kind: i64,
        start_date: String,
        end_date: String,
    },
}

fn target_of(owner_kind: i64, owner: &Owner) -> Option<Target> {
    match (owner_kind, owner) {
        (crate::db::REMINDER_RULE, Owner::Rule(r)) => Some(Target::Rule(r.clone())),
        (
            _,
            Owner::Memo {
                kind,
                start_date,
                end_date,
            },
        ) => Some(Target::Memo {
            kind: *kind,
            start_date: start_date.clone(),
            end_date: end_date.clone(),
        }),
        _ => None,
    }
}

/// RuleRow -> engine::Rule（与 db 内部 to_engine 同一口径）
pub fn rule_of(row: &RuleRow) -> engine::Rule {
    engine::Rule {
        repeat_mode: row.repeat_mode as i32,
        weekdays_mask: row.weekdays_mask as i32,
        repeat_every: row.repeat_every as i32,
        month_day: row.month_day as i32,
        year_month: row.year_month as i32,
        year_day: row.year_day as i32,
        start_date: row.start_date.clone(),
        end_date: row.end_date.clone(),
        repeat_until: row.repeat_until.clone(),
    }
}

/// memo 的 kind 决定它是记事（0）还是倒数日（1）；笔记本（2）永不挂提醒
pub fn memo_owner(m: &MemoRow) -> Option<Owner> {
    match m.kind {
        MEMO_NOTE | MEMO_COUNTDOWN => Some(Owner::Memo {
            kind: m.kind,
            start_date: m.start_date.clone(),
            end_date: m.end_date.clone(),
        }),
        _ => None,
    }
}

/// 从库里攒出「所有还活着的提醒 + 它们的宿主」
pub fn build_candidates(db: &Db) -> Result<Vec<Candidate>, String> {
    let rules = db.all_rules()?;
    let memos = db.list_memos(None)?;
    let reminders = db.active_reminders()?;
    let mut out = Vec::new();
    for row in reminders {
        match row.owner_kind {
            crate::db::REMINDER_RULE => {
                if let Some(r) = rules.iter().find(|r| r.id == row.owner_id) {
                    out.push(Candidate {
                        owner_id: r.id.clone(),
                        owner_title: r.title.clone(),
                        owner: Owner::Rule(Box::new(rule_of(r))),
                        row,
                    });
                }
            }
            _ => {
                if let Some(m) = memos.iter().find(|m| m.id == row.owner_id) {
                    if let Some(owner) = memo_owner(m) {
                        out.push(Candidate {
                            owner_id: m.id.clone(),
                            owner_title: m.title.clone(),
                            owner,
                            row,
                        });
                    }
                }
            }
        }
    }
    Ok(out)
}

/// 供命令与测试复用：候选集合 -> 下一批触发点（升序）。设置页的「接下来的提醒」用它。
pub fn plan(candidates: &[Candidate], now: i64) -> Vec<(FirePoint, String)> {
    let mut out = Vec::new();
    for c in candidates {
        let Some(t) = target_of(c.row.owner_kind, &c.owner) else {
            continue;
        };
        if let Some(p) = reminder::next_fire(&t, &c.row, now) {
            out.push((p, c.owner_title.clone()));
        }
    }
    out.sort_by_key(|(p, _)| p.fire_at);
    out
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::REMINDER_RULE;
    use chrono::TimeZone;

    fn ms(y: i32, mo: u32, d: u32, h: u32, mi: u32) -> i64 {
        chrono::Local
            .with_ymd_and_hms(y, mo, d, h, mi, 0)
            .single()
            .unwrap()
            .timestamp_millis()
    }

    fn rule_row() -> RuleRow {
        RuleRow {
            id: "r1".into(),
            title: "健身".into(),
            enabled: true,
            repeat_mode: 0,
            weekdays_mask: 31,
            repeat_every: 0,
            month_day: 0,
            year_month: 0,
            year_day: 0,
            start_date: "2026-01-01".into(),
            end_date: String::new(),
            repeat_until: String::new(),
            ended: false,
            tasks: Vec::new(),
            reminder_summary: String::new(),
        }
    }

    fn reminder_row(id: &str, time: &str) -> ReminderRow {
        ReminderRow {
            id: id.into(),
            owner_kind: REMINDER_RULE,
            owner_id: "r1".into(),
            notify_on: 1,
            alarm_on: 0,
            time_of_day: time.into(),
            notify_text: String::new(),
            offset_days: 0,
            repeat_rule: 1,
            snooze_min: 0,
            enabled: 1,
            rev: 0,
            updated_at: 0,
            deleted: 0,
            dirty: 0,
        }
    }

    fn cand(id: &str, time: &str, rule: &RuleRow, enabled: i64) -> Candidate {
        let mut row = reminder_row(id, time);
        row.owner_id = rule.id.clone();
        row.enabled = enabled;
        Candidate {
            row,
            owner_id: rule.id.clone(),
            owner_title: rule.title.clone(),
            owner: Owner::Rule(Box::new(rule_of(rule))),
        }
    }

    #[test]
    fn plan_sorts_by_fire_time_and_skips_disabled() {
        let now = ms(2026, 10, 25, 12, 0);
        let mut r2 = rule_row();
        r2.id = "r2".into();
        r2.title = "背单词".into();
        let r1 = rule_row();
        let cands = vec![
            cand("late", "21:00", &r1, 1),
            cand("early", "18:00", &r2, 1),
            cand("off", "13:00", &r2, 0),
        ];
        let got = plan(&cands, now);
        assert_eq!(got.len(), 2, "enabled=0 的不进排程");
        assert_eq!(got[0].1, "背单词", "18:00 的排在前面");
        assert_eq!(got[1].1, "健身");
        assert!(got[0].0.fire_at < got[1].0.fire_at, "按触发时刻升序");
    }

    #[test]
    fn due_window_catches_points_between_ticks() {
        // 线程每 30 秒醒一次，触发点几乎总落在两次醒之间：容差窗口必须能兜住
        let sched = ReminderScheduler::new();
        let target = Target::Rule(Box::new(rule_of(&rule_row())));
        let row = reminder_row("rm", "09:00");

        // 09:00:00 触发，09:00:07 才醒（差 7 秒）→ 必须判定为「该响」
        let hit = due_point(&sched, &row, &target, ms(2026, 10, 26, 9, 0) + 7_000)
            .expect("到点必须能抓到（线程醒来晚几秒不算漏）");
        assert_eq!(hit.fire_at, ms(2026, 10, 26, 9, 0));
        // 抓到之后同一触发点不能再响（去重）
        assert!(
            due_point(&sched, &row, &target, ms(2026, 10, 26, 9, 0) + 20_000).is_none(),
            "一个触发点只响一次"
        );
        // 没到点：不响
        assert!(
            due_point(&sched, &row, &target, ms(2026, 10, 26, 8, 59)).is_none(),
            "没到点不响"
        );
        // 已经过去 5 分钟：超出 60 秒容差窗口，当作漏掉（不补响过去）
        let late = ReminderScheduler::new();
        assert!(
            due_point(&late, &row, &target, ms(2026, 10, 26, 9, 5)).is_none(),
            "超过容差不补响"
        );
    }

    #[test]
    fn snooze_pushes_the_alarm_out_and_stop_is_idempotent() {
        let sched = ReminderScheduler::new();
        sched.with(|g| {
            g.snoozes.insert(
                "rm".into(),
                Snooze {
                    until: i64::MAX,
                    title: "健身".into(),
                    body: "该打卡了：健身".into(),
                    notify: true,
                    alarm: true,
                    snooze_min: 5,
                    rule_id: "r1".into(),
                    period_start: "2026-10-26".into(),
                    occur_date: "2026-10-26".into(),
                },
            )
        });
        sched.snooze("rm", 5);
        let until = sched
            .with(|g| g.snoozes.get("rm").map(|e| e.until))
            .flatten()
            .unwrap();
        let now = reminder::now_ms();
        assert!(until > now && until <= now + 6 * 60_000, "贪睡把到点时间推到 5 分钟后");

        // snooze_min = 0 时不动（不贪睡）
        let s2 = ReminderScheduler::new();
        s2.with(|g| {
            g.snoozes.insert(
                "rm".into(),
                Snooze {
                    until: i64::MAX,
                    title: "x".into(),
                    body: "y".into(),
                    notify: true,
                    alarm: false,
                    snooze_min: 0,
                    rule_id: "r1".into(),
                    period_start: String::new(),
                    occur_date: String::new(),
                },
            )
        });
        s2.snooze("rm", 0);
        assert_eq!(
            s2.with(|g| g.snoozes.get("rm").map(|e| e.until)).flatten(),
            Some(i64::MAX),
            "0 不贪睡"
        );

        // 没有任何响铃时 stop_alarm 也必须安全（幂等，不 panic）
        sched.stop_alarm("rm");
        sched.stop_alarm("never-ringing");
        assert_eq!(sched.status().ringing, 0);
    }

    #[test]
    fn error_is_trimmed_and_never_empty() {
        let sched = ReminderScheduler::new();
        sched.set_error("   ");
        assert_eq!(sched.status().last_error, "未知错误");
        let long = "x".repeat(500);
        sched.set_error(&long);
        assert_eq!(sched.status().last_error.chars().count(), 300, "错误信息最多留 300 字符");
    }

    #[test]
    fn notify_ok_is_true_before_anything_is_sent_and_only_false_after_a_failure() {
        // 「没发过通知」不等于「通知通道坏」。只开闹钟的提醒从来不发通知，
        // 如果默认值取 false，设置页就会把好端端的通道报成「递交失败」——这是实测踩到的。
        let s = ReminderScheduler::new();
        assert!(s.status().notify_ok, "一次都没发过时应当报「可用」，不是「失败」");
    }

    #[test]
    fn tick_interval_is_thirty_seconds() {
        assert_eq!(TICK.as_secs(), 30, "定稿要求每 30 秒对表一次");
        assert!(DUE_TOLERANCE_MS > TICK.as_millis() as i64, "容差要大于对表间隔才不漏");
    }
}