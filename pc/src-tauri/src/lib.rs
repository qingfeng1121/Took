//! Took PC 端（Tauri 2）：月历 + 打卡写路径 + 同步客户端。
//!
//! 命令一览：
//!  - month_grid(y, m) / list_rules(includeEnded, today)  只读：42 格展开与规则列表（契约 §5）
//!  - toggle_done(taskId, periodStart, done)     打卡 / 取消打卡（契约 §3.3，写 (task_id, period_start)）
//!  - create_rule / update_rule / delete_rule    规则增删改（契约 §9.1~§9.3，改重复设置会裂开）
//!  - add_task / rename_task / set_task_enabled / delete_task  任务增删改（契约 §9.4）
//!  - create_memo / update_memo / delete_memo / list_memos  记事 / 倒数日 / 笔记本（契约 §10）
//!  - get_reminder / save_reminder / clear_reminder          提醒的存取（契约 §11）
//!  - reminder_status() / snooze_reminder(id) / stop_reminder(id) / poke_scheduler()
//!                                                        提醒的真实调度（定稿 §6.3.4~§6.3.5）
//!  - sync_now() / sync_status() / set_sync_url(url)  同步（契约 §7）
//!
//! 提醒的调度是一个**独立后台线程**（scheduler.rs），每 30 秒对表一次，不依赖前端 JS 定时器：
//! 窗口关掉、最小化到托盘、WebView 被回收，它都还在跑；只有进程退出才停。
//!
//! 写路径统一：更新 dirty=1 + updated_at=now，rev 保持不变；删除一律软删。
//! 「今天/昨天」由前端显式传入（本机本地日期），后端不猜时区。
//!
//! 交互约定（契约 §5.4）由前端保证：格子里任务名纯预览，只有面板里才能打卡。

mod alarm;
mod db;
mod engine;
mod reminder;
mod scheduler;
mod sync;
mod wallpaper;
mod window_chrome;

use tauri::Manager;

/// 某月每天命中的任务与打卡状态（结构同 Go 后端 /api/month）
#[tauri::command]
fn month_grid(state: tauri::State<'_, db::Db>, y: i32, m: u32) -> Result<db::MonthGrid, String> {
    state.month_grid(y, m)
}

/// 任意区间（含首尾）的逐日展开。滚动月历要的是连续周而不是整月，
/// 一次拉齐当前月前后各 12 个月，滚动时不再有「这一月还没加载」的空档。
/// 口径与 month_grid 完全一致（同一 expand_day）。
#[tauri::command]
fn range_grid(state: tauri::State<'_, db::Db>, from: String, to: String) -> Result<Vec<db::Day>, String> {
    state.range_grid(&from, &to)
}

/// 规则列表，含其下任务。默认只返回未结束的规则；include_ended=true 连历史一起返回（契约 §9.2）
#[tauri::command]
fn list_rules(
    state: tauri::State<'_, db::Db>,
    include_ended: Option<bool>,
    today: Option<String>,
) -> Result<Vec<db::RuleRow>, String> {
    let include = include_ended.unwrap_or(false);
    match today.as_deref() {
        Some(t) if !t.trim().is_empty() => state.list_rules_at(include, Some(t)),
        _ => state.list_rules(include),
    }
}

/// 打卡 / 取消打卡：写 (task_id, period_start) 的 status，返回写入后的真相 + 该周期当天的数据。
/// 同一周期内所有命中日共享这一行（契约 §3.3），所以前端拿到结果后整周格子一起重绘。
#[tauri::command]
fn toggle_done(
    state: tauri::State<'_, db::Db>,
    task_id: String,
    period_start: String,
    done: bool,
) -> Result<db::ToggleResult, String> {
    state.toggle_done(&task_id, &period_start, done)
}

/* ---------- 规则与任务的写路径（契约 §9） ---------- */

/// 新增规则（§9.1）：rule_json 是规则字段的 JSON，tasks 是任务名列表，返回新规则 id
#[tauri::command]
fn create_rule(
    state: tauri::State<'_, db::Db>,
    rule_json: String,
    tasks: Vec<String>,
) -> Result<String, String> {
    let input: db::RuleInput =
        serde_json::from_str(&rule_json).map_err(|e| format!("rule_json 解析失败：{e}"))?;
    state.create_rule(&input, &tasks, db::now_ms())
}

/// 修改规则（§9.2）：重复设置变了就裂开（旧规则 repeat_until=昨天 + 新建一条），否则原地改。
/// 返回 { split, old_rule_id, new_rule_id?, old_repeat_until }，前端据此弹「是否复制任务到新规则」。
#[tauri::command]
fn update_rule(
    state: tauri::State<'_, db::Db>,
    rule_json: String,
    today: Option<String>,
) -> Result<db::UpdateResult, String> {
    let input: db::RuleInput =
        serde_json::from_str(&rule_json).map_err(|e| format!("rule_json 解析失败：{e}"))?;
    state.update_rule(&input, today.as_deref(), db::now_ms())
}

/// 删除规则（§9.3）：规则与其下所有任务软删，打卡历史保留
#[tauri::command]
fn delete_rule(state: tauri::State<'_, db::Db>, id: String) -> Result<db::DeleteRuleResult, String> {
    state.delete_rule(&id, db::now_ms())
}

/// 新增任务（§9.4），sort_order 递增
#[tauri::command]
fn add_task(state: tauri::State<'_, db::Db>, rule_id: String, title: String) -> Result<db::TaskRow, String> {
    state.add_task(&rule_id, &title, db::now_ms())
}

#[tauri::command]
fn rename_task(state: tauri::State<'_, db::Db>, task_id: String, title: String) -> Result<(), String> {
    state.rename_task(&task_id, &title, db::now_ms())
}

#[tauri::command]
fn set_task_enabled(state: tauri::State<'_, db::Db>, task_id: String, enabled: bool) -> Result<(), String> {
    state.set_task_enabled(&task_id, enabled, db::now_ms())
}

/// 删除任务（§9.4）：软删任务，打卡历史保留
#[tauri::command]
fn delete_task(state: tauri::State<'_, db::Db>, task_id: String) -> Result<(), String> {
    state.delete_task(&task_id, db::now_ms())
}

/* ---------- 记事 / 倒数日 / 笔记本（契约 §10） ---------- */

/// 新增 memo：memo_json 是 §10.1 的字段（id 可空，空则后端补），返回新 id
#[tauri::command]
fn create_memo(state: tauri::State<'_, db::Db>, memo_json: String) -> Result<String, String> {
    let input: db::MemoInput =
        serde_json::from_str(&memo_json).map_err(|e| format!("memo_json 解析失败：{e}"))?;
    state.create_memo(&input, db::now_ms())
}

/// 修改 memo（§10.2）：任何字段都可原地改，rev 保持、dirty=1
#[tauri::command]
fn update_memo(state: tauri::State<'_, db::Db>, memo_json: String) -> Result<(), String> {
    let input: db::MemoInput =
        serde_json::from_str(&memo_json).map_err(|e| format!("memo_json 解析失败：{e}"))?;
    state.update_memo(&input, db::now_ms())
}

/// 删除 memo（§10.2）：软删
#[tauri::command]
fn delete_memo(state: tauri::State<'_, db::Db>, id: String) -> Result<(), String> {
    state.delete_memo(&id, db::now_ms())
}

/// 某类的 memo 列表（kind 0=记事 1=倒数日 2=笔记本；不传 = 全部），只返回未删的
#[tauri::command]
fn list_memos(state: tauri::State<'_, db::Db>, kind: Option<i64>) -> Result<Vec<db::MemoRow>, String> {
    state.list_memos(kind)
}

/* ---------- 提醒（契约 §11，首期只存与显示，不注册调度） ---------- */

/// 某个 owner（0=规则 1=记事 2=倒数日）的提醒；没有 → null
#[tauri::command]
fn get_reminder(
    state: tauri::State<'_, db::Db>,
    owner_kind: i64,
    owner_id: String,
) -> Result<Option<db::ReminderRow>, String> {
    state.get_reminder(owner_kind, &owner_id)
}

/// 存提醒（reminder_json 照 docs/schema/reminder.schema.json）：两个开关都关直接拒绝，
/// 想不提醒走 clear_reminder（软删）。返回提醒 id。
#[tauri::command]
fn save_reminder(state: tauri::State<'_, db::Db>, reminder_json: String) -> Result<String, String> {
    let input: db::ReminderInput =
        serde_json::from_str(&reminder_json).map_err(|e| format!("reminder_json 解析失败：{e}"))?;
    let id = state.save_reminder(&input, db::now_ms())?;
    // 存完立刻让调度线程对一次表：不然改完提醒要等满 30 秒才进排程，用户会以为没生效
    scheduler::poke();
    Ok(id)
}

/// 「不提醒」：软删该 owner 的提醒行（幂等）
#[tauri::command]
fn clear_reminder(
    state: tauri::State<'_, db::Db>,
    owner_kind: i64,
    owner_id: String,
) -> Result<(), String> {
    state.clear_reminder(owner_kind, &owner_id, db::now_ms())?;
    scheduler::poke();
    Ok(())
}

/* ---------- 提醒的真实调度（定稿 §6.3.4 ~ §6.3.5） ---------- */

/// 调度状态：已排程条数 / 下次触发时刻 / 最近一次错误 / 后台线程是否还活着。
/// 设置页照实显示这些数字，而不是笼统说「提醒功能可用」。
#[tauri::command]
fn reminder_status(state: tauri::State<'_, scheduler::ReminderScheduler>) -> scheduler::ScheduleStatus {
    let mut st = state.status();
    // 线程活着的真相由调度器自己维护；这里再兜一层，进程在、标记却丢了就是异常，如实报出来
    st.thread_alive = st.thread_alive && scheduler::ALIVE.load(std::sync::atomic::Ordering::SeqCst);
    st.sound_playing = alarm::is_playing();
    st
}

/// 接下来的 N 条提醒（设置页用）。和 reminder_status 的区别：状态只说「最近的一条」，
/// 这里给出完整队列，用户能看见全貌。
#[derive(Clone, Debug, serde::Serialize)]
struct UpcomingItem {
    title: String,
    at: i64,
    text: String,
    occur_date: String,
    fire_date: String,
}

#[tauri::command]
fn reminder_upcoming(
    db: tauri::State<'_, db::Db>,
    limit: Option<usize>,
) -> Result<Vec<UpcomingItem>, String> {
    let cands = scheduler::build_candidates(&db)?;
    let now = reminder::now_ms();
    let n = limit.unwrap_or(5).clamp(1, 20);
    Ok(scheduler::plan(&cands, now)
        .into_iter()
        .take(n)
        .map(|(p, title)| UpcomingItem {
            title,
            at: p.fire_at,
            text: reminder::local_text_of(p.fire_at),
            occur_date: p.occur_date,
            fire_date: p.fire_date,
        })
        .collect())
}

/// 贪睡：把这条提醒推后它自己的 snooze_min 分钟再响一次（0 = 不贪睡，直接停）
#[tauri::command]
fn snooze_reminder(
    db: tauri::State<'_, db::Db>,
    sched: tauri::State<'_, scheduler::ReminderScheduler>,
    reminder_id: String,
) -> Result<(), String> {
    let minutes = db.get_reminder_by_id(&reminder_id)?.map(|r| r.snooze_min).unwrap_or(0);
    sched.snooze(&reminder_id, minutes);
    Ok(())
}

/// 停止响铃（「停止」按钮）。幂等：没有在响也返回成功。
#[tauri::command]
fn stop_reminder(
    state: tauri::State<'_, scheduler::ReminderScheduler>,
    reminder_id: String,
) -> Result<(), String> {
    state.stop_alarm(&reminder_id);
    Ok(())
}

/// 请调度线程立刻对一次表：保存 / 清除提醒之后调它，省得等满 30 秒。
#[tauri::command]
fn poke_scheduler() {
    scheduler::poke();
}

/// 立即同步一次：先 push dirty=1，再 pull since=lastPulledRev。失败不抛错、只回报 ok=false。
/// 声明成 async：命令体里有最长 6s 的网络等待，不能占住主线程（失败要静默，前端不等也能继续画）。
#[tauri::command]
async fn sync_now(state: tauri::State<'_, db::Db>) -> Result<sync::SyncResult, String> {
    Ok(sync::sync_now(&state))
}

/// 同步状态：地址 / 上次同步时间 / 待推送条数 / 最近一次错误 / pull 游标
#[tauri::command]
fn sync_status(state: tauri::State<'_, db::Db>) -> Result<sync::SyncStatus, String> {
    Ok(sync::status(&state))
}

/// 改同步地址（设置页），返回改完后的状态
#[tauri::command]
fn set_sync_url(state: tauri::State<'_, db::Db>, url: String) -> Result<sync::SyncStatus, String> {
    sync::set_url(&state, &url)
}

/// 存同步令牌（Bearer）。空串 = 清除。存的键是 local_state 的 sync_token，
/// 下一次 push / pull 的请求头里就会带上它（sync.rs 的 http_json_auth）。
#[tauri::command]
fn set_sync_token(state: tauri::State<'_, db::Db>, token: String) -> Result<sync::SyncStatus, String> {
    sync::set_token(&state, &token)
}

/// 测试连接：真发一条 GET /api/health，返回状态码、耗时与响应体摘要。
/// 不是「点了变个绿点」的假按钮 —— 连不上 / 401 / 非 JSON 都会如实回报。
#[tauri::command]
fn sync_probe(state: tauri::State<'_, db::Db>) -> Result<sync::HealthProbe, String> {
    Ok(sync::health_probe(&state))
}

/// 导出：真打后端 GET /api/v1/export，把 JSON 原样交给前端落文件。
/// 返回 (HTTP 状态码, body)；前端据状态码决定是下载还是显示错误。
#[tauri::command]
fn export_data(state: tauri::State<'_, db::Db>) -> Result<sync::ExportPayload, String> {
    sync::export_json(&state).map(|(status, body)| sync::ExportPayload { status, body })
}


/* ---------- 贴壁纸层（定稿 §5.5「固定桌面」） ---------- */

/// local_state 里存开关的键。默认开（定稿 §5.5 第 450 行：默认「贴桌面壁纸」）
const WALLPAPER_KEY: &str = "wallpaper_pin";
/// 桌面小部件预设尺寸：定稿 §5.5 第 529 行建议的竖条（420×560）。
///
/// **这是有意选择，不是做不到全屏。** 全屏铺满技术上可行（SetParent + 铺满宿主 rect），
/// 但会让用户点不到自己的桌面图标，等于把桌面搞坏；WebView2 又做不了逐像素点击穿透
/// （WS_EX_TRANSPARENT 只对 layered 窗口生效，给 WebView2 加 layered 会破坏合成）。
/// 所以取这个尺寸：不遮挡图标区，窗口本身保持可交互，用户能直接在壁纸上点日期打卡。
const WALLPAPER_PRESET: (i32, i32) = (420, 560);

/// 贴壁纸开关的**真实状态**（设置页、固定方式按钮、验收脚本都读它）。
fn wallpaper_status_rt<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    state: &db::Db,
) -> wallpaper::WallpaperStatus {
    // 默认开：local_state 里没存过就当作 "1"
    let enabled = state.get_state(WALLPAPER_KEY).ok().flatten().as_deref() != Some("0");
    let hwnd = app
        .get_webview_window("main")
        .and_then(|w| w.hwnd().ok())
        .map(|h| h.0 as isize)
        .unwrap_or(0);
    let (parent, host_class, is_child) = wallpaper::probe_of(hwnd);
    let mode = if enabled { wallpaper::current_mode() } else { wallpaper::PinMode::Disabled };
    wallpaper::status_snapshot(mode, parent, host_class, is_child)
}

/// 贴壁纸层的真实状态（设置页与托盘都读它；验收也靠它把 PinMode 打出来）
#[tauri::command]
fn wallpaper_status(
    app: tauri::AppHandle,
    state: tauri::State<'_, db::Db>,
) -> Result<wallpaper::WallpaperStatus, String> {
    Ok(wallpaper_status_rt(&app, &state))
}

/* ---------- 固定方式：贴壁纸 / 置顶 / 普通（三选一，互斥） ----------
   用户的诉求是「在设置旁边点一下就切，不用进设置页」。三种方式互斥，
   落库在 local_state 的 pin_mode；「先撤后立」在 apply_pin_style 一处保证，
   命令、托盘、启动恢复都走这一条，不留第二套语义。 */

/// 固定方式的完整状态：按钮文字 + 真窗口证据 + 贴壁纸层实况。
#[derive(serde::Serialize)]
struct PinModeStatus {
    /// 当前固定方式：wallpaper / top / normal
    mode: String,
    /// 按钮上显示的两个字（贴壁纸 / 置顶 / 普通）
    label: String,
    /// **真窗口**读回的 WS_EX_TOPMOST 位（不是前端猜的状态）
    always_on_top: bool,
    /// 贴壁纸层的真实探测结果（mode 可能是 FallbackAlwaysOnTop 降级）
    wallpaper: wallpaper::WallpaperStatus,
}

fn pin_status_rt<R: tauri::Runtime>(app: &tauri::AppHandle<R>, db: &db::Db) -> PinModeStatus {
    let wallpaper = wallpaper_status_rt(app, db);
    let wallpaper_enabled = db.get_state(WALLPAPER_KEY).ok().flatten().as_deref() != Some("0");
    let style = window_chrome::stored_pin_style(db, wallpaper_enabled);
    let always_on_top = main_hwnd(app)
        .and_then(|h| window_chrome::read_always_on_top(h).ok())
        .unwrap_or(false);
    PinModeStatus {
        mode: style.as_str().to_string(),
        label: style.label_cn().to_string(),
        always_on_top,
        wallpaper,
    }
}

/// 把某种固定方式真的作用到窗口上并落库。**三种方式互斥**：先撤掉上一种的效果，再立新的。
///
/// 顺序是有意的（从「贴壁纸」切到「置顶」时，必须先 set_wallpaper_pin(false) 把父级
/// 还原回桌面，否则窗口会既挂在壁纸层又带着 WS_EX_TOPMOST，状态谁都说不清）。
fn apply_pin_style<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    db: &db::Db,
    style: window_chrome::PinStyle,
) -> Result<window_chrome::PinStyle, String> {
    let plan = window_chrome::plan_for(style);
    let win = app.get_webview_window("main").ok_or("主窗口不存在")?;
    let hwnd = main_hwnd(app);
    // 1. 先撤置顶（幂等：本来没置顶时 HWND_NOTOPMOST 是空操作）
    if let Some(h) = hwnd {
        window_chrome::apply_always_on_top(h, false)?;
    }
    // 2. 贴壁纸层按 plan 落地：false 时 detach 会把父级还原回桌面并恢复普通窗口样式
    //    走 Win32，不用 Tauri 的 set_size / set_position：SetParent 之后坐标系变成相对父窗口
    //    size=None：贴壁纸**不改窗口尺寸**，保留用户当前拖好的大小（尺寸由预设命令负责）
    let mode = wallpaper::apply_on_main(app, &win, plan.wallpaper, None);
    db.set_state(WALLPAPER_KEY, if plan.wallpaper { "1" } else { "0" })?;
    // 3. 再立置顶
    if plan.always_on_top {
        if let Some(h) = hwnd {
            window_chrome::apply_always_on_top(h, true)?;
        }
    }
    window_chrome::save_pin_style(db, style)?;
    println!(
        "[took][固定方式] → {}（{}）：贴壁纸={} 置顶={}，壁纸层实际模式 {}",
        style.label_cn(),
        style.as_str(),
        plan.wallpaper,
        plan.always_on_top,
        mode.as_str()
    );
    Ok(style)
}

/// 贴壁纸开关（设置页的「固定到桌面」开关 / 托盘菜单都走这一条）。
///
/// 它就是固定方式的两个取值：开 → wallpaper，关 → normal。走 apply_pin_style，
/// 所以设置页改了开关之后 pin_mode 一定跟着变，不会出现「按钮说贴壁纸、设置页说已关闭」。
fn apply_wallpaper_pin<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    db: &db::Db,
    on: bool,
) -> Result<wallpaper::PinMode, String> {
    let style = if on {
        window_chrome::PinStyle::Wallpaper
    } else {
        window_chrome::PinStyle::Normal
    };
    apply_pin_style(app, db, style)?;
    Ok(wallpaper::current_mode())
}



/// 切到桌面小部件预设尺寸（定稿 §5.5 第 529 行建议的 420×560 竖条）。
///
/// 这一条是**用户显式点的**，不是贴壁纸的副作用：贴壁纸本身不改窗口大小
/// （否则用户拖好的窗口会在开启时莫名跳档，宽度又直接决定内容密度）。
#[tauri::command]
fn set_wallpaper_preset(app: tauri::AppHandle) -> Result<wallpaper::WallpaperStatus, String> {
    let win = app.get_webview_window("main").ok_or("主窗口不存在")?;
    let (w, h) = WALLPAPER_PRESET;
    let _ = win.set_size(tauri::PhysicalSize::new(w as u32, h as u32));
    // 尺寸变完再按当前开关重挂一次，保证 z-order 与位置跟着新尺寸走
    let on = wallpaper::current_mode() != wallpaper::PinMode::Disabled;
    if on {
        wallpaper::apply_on_main(&app, &win, true, Some((w, h)));
    }
    println!("[took][贴壁纸] 已切到小部件预设尺寸 {w}×{h}");
    wallpaper_status(app.clone(), app.state::<db::Db>())
}

/// 桌面层实况（验收证据）：把 GetParent、父窗口类名、命中测试一次打出来
#[tauri::command]
fn wallpaper_probe(app: tauri::AppHandle) -> Result<wallpaper::LayerProbe, String> {
    let hwnd = app
        .get_webview_window("main")
        .and_then(|w| w.hwnd().ok())
        .map(|h| h.0 as isize)
        .unwrap_or(0);
    Ok(wallpaper::probe_layers(hwnd))
}

/// 开关贴壁纸（设置页勾选框 / 托盘菜单都走这一条）
#[tauri::command]
fn set_wallpaper_pin(
    app: tauri::AppHandle,
    state: tauri::State<'_, db::Db>,
    on: bool,
) -> Result<wallpaper::WallpaperStatus, String> {
    apply_wallpaper_pin(&app, &state, on)?;
    wallpaper_status(app, state)
}

/// 固定方式：读当前状态（按钮文字与真窗口的 WS_EX_TOPMOST 都从这里来）
#[tauri::command]
fn pin_mode_status(
    app: tauri::AppHandle,
    state: tauri::State<'_, db::Db>,
) -> Result<PinModeStatus, String> {
    Ok(pin_status_rt(&app, &state))
}

/// 固定方式：三选一切换（日历头部 #btnPin 的菜单走这一条）。
///
/// 严格校验枚举：前端传了别的值要报错，不能静默当成普通窗口。
#[tauri::command]
fn set_pin_mode(
    app: tauri::AppHandle,
    state: tauri::State<'_, db::Db>,
    mode: String,
) -> Result<PinModeStatus, String> {
    let style = window_chrome::PinStyle::parse_strict(&mode)?;
    apply_pin_style(&app, &state, style)?;
    Ok(pin_status_rt(&app, &state))
}


/* ---------- 窗口外观：透明度 / 收起 / 吸附（window_chrome.rs） ---------- */

/// 三个持久化键。都存在 local_state 里，与贴壁纸开关同一张表（没有第二套配置系统）。
const OPACITY_KEY: &str = "window_opacity";
const SNAP_EDGE_KEY: &str = "snap_edge";
const SNAP_AUTO_HIDE_KEY: &str = "snap_auto_hide";
/// 收起态**不持久化**：任务书明确要求「重启后恢复成展开」。
/// 真存了就会一启动只有一个小三角，用户以为程序坏了。

/// 收起状态机。全局只有一份 —— 命令与 Moved 监听读写的是同一个状态。
static COLLAPSE: std::sync::Mutex<Option<window_chrome::CollapseState>> =
    std::sync::Mutex::new(None);

/// 过渡动画进行中。动画每帧都会 SetWindowPos，会反过来触发 Moved 事件；
/// 不挡住的话吸附逻辑会在半途把窗口拽回边缘，和动画打架。
static ANIMATING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

fn is_animating() -> bool {
    ANIMATING.load(std::sync::atomic::Ordering::SeqCst)
}

fn with_collapse<R>(f: impl FnOnce(&mut window_chrome::CollapseState) -> R) -> R {
    let mut g = COLLAPSE.lock().unwrap_or_else(|e| e.into_inner());
    if g.is_none() {
        *g = Some(window_chrome::CollapseState::new());
    }
    f(g.as_mut().unwrap())
}

/// 当前是否处于收起态（前端要按它决定渲染整页还是只渲染小三角）。
fn is_collapsed() -> bool {
    with_collapse(|s| s.collapsed)
}

/// 读库里的透明度；没存过或脏数据一律回 100（=不透明），不让启动失败。
fn stored_opacity(db: &db::Db) -> u8 {
    db.get_state(OPACITY_KEY)
        .ok()
        .flatten()
        .and_then(|v| v.trim().parse::<i32>().ok())
        .and_then(|v| window_chrome::clamp_opacity(v).ok())
        .unwrap_or(window_chrome::OPACITY_MAX)
}

fn stored_edge(db: &db::Db) -> window_chrome::Edge {
    window_chrome::Edge::parse(&db.get_state(SNAP_EDGE_KEY).ok().flatten().unwrap_or_default())
}

fn stored_auto_hide(db: &db::Db) -> bool {
    db.get_state(SNAP_AUTO_HIDE_KEY).ok().flatten().as_deref() == Some("1")
}

fn main_hwnd<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Option<isize> {
    app.get_webview_window("main")
        .and_then(|w| w.hwnd().ok())
        .map(|h| h.0 as isize)
}

/// 把透明度作用到真窗口并落库。命令、启动恢复、托盘都走这一条（不留第二套语义）。
fn apply_opacity_now<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    db: &db::Db,
    pct: u8,
) -> Result<u8, String> {
    let hwnd = main_hwnd(app).ok_or("主窗口不存在，透明度没有应用")?;
    window_chrome::apply_opacity(hwnd, pct)?;
    db.set_state(OPACITY_KEY, &pct.to_string())?;
    println!("[took][窗口] 透明度 → {pct}%（已作用到 hwnd 并落库）");
    Ok(pct)
}

/// 设置整体透明度（40~100%）。
///
/// 越界**报错不静默**：前端滑块被绕过、或脚本传了 39，用户要看到原因，
/// 而不是以为「设了但没效果」。
#[tauri::command]
fn set_opacity(
    app: tauri::AppHandle,
    state: tauri::State<'_, db::Db>,
    value: u8,
) -> Result<u8, String> {
    let pct = window_chrome::clamp_opacity(value as i32)?;
    apply_opacity_now(&app, &state, pct)
}

/// 读回真窗口的不透明度，换算成百分比。
///
/// 验收用：CDP 里调它拿到的是 GetLayeredWindowAttributes 的结果，
/// 不是 DOM 上的 opacity，所以能证明「窗口真的半透明了」。
#[tauri::command]
fn window_opacity(app: tauri::AppHandle) -> Result<u8, String> {
    let hwnd = main_hwnd(&app).ok_or("主窗口不存在")?;
    let alpha = window_chrome::read_opacity(hwnd)?;
    Ok(((alpha as u32 * 100 + 127) / 255) as u8)
}

/// 窗口外观的完整状态（设置页与验收脚本都读它）。
#[derive(serde::Serialize)]
struct WindowChromeStatus {
    /// 当前透明度（%）
    opacity: u8,
    /// 真窗口读回的不透明度（0~255）；读不到时为 -1
    alpha: i32,
    /// 吸附边缘：none / left / right / top / bottom
    snap_edge: String,
    /// 吸附后是否自动收起
    snap_auto_hide: bool,
    /// 当前是否收起成小三角
    collapsed: bool,
    /// 当前窗口物理矩形 [x, y, w, h]；读不到时为空
    rect: Vec<i32>,
    /// 距吸附阈值多少像素（前端提示文案用）
    snap_threshold: i32,
}

fn chrome_status<R: tauri::Runtime>(app: &tauri::AppHandle<R>, db: &db::Db) -> WindowChromeStatus {
    let hwnd = main_hwnd(app).unwrap_or(0);
    let alpha = window_chrome::read_opacity(hwnd).map(|a| a as i32).unwrap_or(-1);
    let rect = window_chrome::window_rect(hwnd)
        .map(|r| vec![r.x, r.y, r.w, r.h])
        .unwrap_or_default();
    WindowChromeStatus {
        opacity: stored_opacity(db),
        alpha,
        snap_edge: stored_edge(db).as_str().to_string(),
        snap_auto_hide: stored_auto_hide(db),
        collapsed: is_collapsed(),
        rect,
        snap_threshold: window_chrome::SNAP_THRESHOLD,
    }
}

#[tauri::command]
fn window_chrome_status(
    app: tauri::AppHandle,
    state: tauri::State<'_, db::Db>,
) -> Result<WindowChromeStatus, String> {
    Ok(chrome_status(&app, &state))
}

/// 设吸附边缘。严格校验枚举，脏值报错不静默。
#[tauri::command]
fn set_snap_edge(
    app: tauri::AppHandle,
    state: tauri::State<'_, db::Db>,
    edge: String,
) -> Result<WindowChromeStatus, String> {
    let e = window_chrome::Edge::parse_strict(&edge)?;
    state.set_state(SNAP_EDGE_KEY, e.as_str())?;
    println!("[took][窗口] 吸附边缘 → {}", e.as_str());
    Ok(chrome_status(&app, &state))
}

/// 吸附后自动收起的开关。
#[tauri::command]
fn set_snap_auto_hide(
    app: tauri::AppHandle,
    state: tauri::State<'_, db::Db>,
    on: bool,
) -> Result<WindowChromeStatus, String> {
    state.set_state(SNAP_AUTO_HIDE_KEY, if on { "1" } else { "0" })?;
    println!("[took][窗口] 吸附后自动收起 → {on}");
    Ok(chrome_status(&app, &state))
}

/// 最近一次收起 / 展开过渡的逐帧矩形（验收用：证明窗口是真的一帧一帧缩的）。
#[tauri::command]
fn window_anim_trace() -> Vec<Vec<i32>> {
    window_chrome::last_anim_frames()
        .into_iter()
        .map(|r| vec![r.x, r.y, r.w, r.h])
        .collect()
}

/// 最近一次过渡里被系统拒掉的帧数（0 = 每帧都成功）。
#[tauri::command]
fn window_anim_errors() -> usize {
    window_chrome::last_anim_error_count()
}

/// 立即按当前设置做一次吸附判定（前端「吸附到现在的位置」用）。
#[tauri::command]
fn snap_now(
    app: tauri::AppHandle,
    state: tauri::State<'_, db::Db>,
) -> Result<WindowChromeStatus, String> {
    if is_collapsed() {
        return Ok(chrome_status(&app, &state));
    }
    let edge = stored_edge(&state);
    if let Some(hwnd) = main_hwnd(&app) {
        try_snap(hwnd, edge);
    }
    Ok(chrome_status(&app, &state))
}

/// 真正把窗口收成小三角（含分帧过渡动画）。返回「这一次是否真的收了」：
/// 已经处于收起态时返回 `Ok(false)`，不动窗口。
///
/// **手动「收起」命令与吸附后自动收起共用这一条**，不留第二套语义 ——
/// 之前的 bug 就出在两套：自动收起那条只 eval 了一个「打印日志」的前端钩子。
///
/// 选的是「缩窗口」而不是「隐藏主窗 + 另开一个小窗」：贴壁纸把主窗 SetParent 到
/// WorkerW 之后，宿主一销毁窗口会被系统连带销毁（lib.rs 已有整套重建逻辑）；
/// 再挂一个小窗，每个生命周期分支都要复制一遍重建与重附着，漏一处就是
/// 「收起后再也展不开」。单窗口方案里收起只改尺寸，没有新生命周期。
fn collapse_now<R: tauri::Runtime>(app: &tauri::AppHandle<R>, db: &db::Db) -> Result<bool, String> {
    let hwnd = main_hwnd(app).ok_or("主窗口不存在，无法收起")?;
    let current = window_chrome::window_rect(hwnd)?;
    let screen = window_chrome::monitor_work_area(hwnd);
    let edge = stored_edge(db);
    let scale = app
        .get_webview_window("main")
        .map(|w| w.scale_factor().unwrap_or(1.0))
        .unwrap_or(1.0);
    let target = with_collapse(|st| st.collapse(current, edge, screen, scale));
    let Some(r) = target else { return Ok(false) };
    if let Some(w) = app.get_webview_window("main") {
        // 两条都必须在缩尺寸**之前**做，否则 26×48 里几乎全是标题栏和边框，
        // 页面只剩十几像素（实测 18×17），小三角根本显示不出来：
        //   1. 去掉窗口装饰 —— 标题栏、边框、阴影都占位置；
        //   2. 放开最小尺寸 —— 建窗时设的 min_inner_size(640,560) 会把 WebView2 钳住。
        let _ = w.set_decorations(false);
        let _ = w.set_min_size(Some(tauri::PhysicalSize::new(1u32, 1u32)));
    }
    // 分帧过渡交给后台线程：命令线程里同步 sleep 会占住窗口的消息泵，
    // 过渡会被压成「一步到位」——正是用户说的「啪一下变成小条」。
    ANIMATING.store(true, std::sync::atomic::Ordering::SeqCst);
    std::thread::spawn(move || {
        if let Err(e) = window_chrome::animate_window(hwnd, current, r, window_chrome::ANIM_MS) {
            println!("[took][窗口] 收起过渡失败，直接落到目标尺寸：{e}");
            let _ = window_chrome::place_window(hwnd, r);
        }
        ANIMATING.store(false, std::sync::atomic::Ordering::SeqCst);
        println!(
            "[took][窗口] 已收起成小三角 {}×{} @({}, {})，原尺寸 {:?} 已记住；调度线程不受影响",
            r.w, r.h, r.x, r.y, current
        );
    });
    Ok(true)
}

/// 收起成小三角（前端「收起」按钮 / 设置页「收起」走这里）。
#[tauri::command]
fn collapse_window(
    app: tauri::AppHandle,
    state: tauri::State<'_, db::Db>,
) -> Result<WindowChromeStatus, String> {
    collapse_now(&app, &state)?;
    Ok(chrome_status(&app, &state))
}

/// 展开：恢复收起前的尺寸与位置。
#[tauri::command]
fn expand_window(
    app: tauri::AppHandle,
    state: tauri::State<'_, db::Db>,
) -> Result<WindowChromeStatus, String> {
    let hwnd = main_hwnd(&app).ok_or("主窗口不存在，无法展开")?;
    let current = window_chrome::window_rect(hwnd)?;
    let target = with_collapse(|st| st.expand());
    // 收起时摘掉的装饰与最小尺寸，展开必须**先**恢复再放大：
    // 反过来的话窗口会先变成一根没有标题栏的大白条。
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.set_decorations(true);
        let _ = w.set_min_size(Some(tauri::PhysicalSize::new(640u32, 560u32)));
    }
    match target {
        Some(r) => {
            // 展开也走同一套分帧过渡，方向相反（小三角滑开成整页）
            ANIMATING.store(true, std::sync::atomic::Ordering::SeqCst);
            std::thread::spawn(move || {
                if let Err(e) =
                    window_chrome::animate_window(hwnd, current, r, window_chrome::ANIM_MS)
                {
                    println!("[took][窗口] 展开过渡失败，直接落到目标尺寸：{e}");
                    let _ = window_chrome::place_window(hwnd, r);
                }
                ANIMATING.store(false, std::sync::atomic::Ordering::SeqCst);
                println!("[took][窗口] 已展开回 {}×{} @({}, {})", r.w, r.h, r.x, r.y);
            });
        }
        None => {
            // 没记过原尺寸（例如收起后进程被强杀）：至少保证窗口是个能用的大小，
            // 不能让用户点了展开却还是一根小条。
            let cur = window_chrome::window_rect(hwnd)?;
            if cur.w < 640 || cur.h < 560 {
                let screen = window_chrome::monitor_work_area(hwnd);
                let w = 1280.min(screen.w).max(640);
                let h = 900.min(screen.h).max(560);
                window_chrome::place_window(
                    hwnd,
                    window_chrome::Rect::new(
                        screen.x + (screen.w - w) / 2,
                        screen.y + (screen.h - h) / 2,
                        w,
                        h,
                    ),
                )?;
                println!("[took][窗口] 没有记下的原尺寸，按默认 1280×900 居中展开");
            }
        }
    }
    Ok(chrome_status(&app, &state))
}

/// Moved 事件 → 纯函数判边 → 贴过去。返回是否真的吸附了（供日志与验收判断）。
fn try_snap(hwnd: isize, edge: window_chrome::Edge) -> bool {
    if edge == window_chrome::Edge::None {
        return false;
    }
    let (Ok(win), screen) = (window_chrome::window_rect(hwnd), window_chrome::monitor_work_area(hwnd))
    else {
        return false;
    };
    match window_chrome::snap_target(edge, win, screen) {
        Some((x, y)) if x != win.x || y != win.y => {
            if window_chrome::place_window(hwnd, window_chrome::Rect::new(x, y, win.w, win.h)).is_ok() {
                println!("[took][窗口] 吸附到 {} 边缘：({}, {})", edge.as_str(), x, y);
                return true;
            }
            false
        }
        _ => false,
    }
}

/// 给主窗口挂上「移动即吸附」的监听。
///
/// 只在真的靠边时才 SetWindowPos：否则每次拖动都会被写一次位置，
/// 拖动手感会变粘。`snapAutoHide` 打开时，吸附后再延迟 1.5 秒收起。
fn wire_snap_listener<R: tauri::Runtime>(win: &tauri::WebviewWindow<R>) {
    let handle = win.clone();
    let app = win.app_handle().clone();
    win.on_window_event(move |event| {
        if let tauri::WindowEvent::Moved(_) = event {
            // 收起态下窗口就贴在那条边上，不能再按「拖动」处理，否则会把小条吸走
            if is_collapsed() {
                return;
            }
            // 过渡动画每帧都在 SetWindowPos，会自己触发 Moved；这期间不能当拖动处理
            if is_animating() {
                return;
            }
            let db = match app.try_state::<db::Db>() {
                Some(d) => d,
                None => return,
            };
            let edge = stored_edge(&db);
            if edge == window_chrome::Edge::None {
                return;
            }
            let Ok(hwnd) = handle.hwnd() else { return };
            if !try_snap(hwnd.0 as isize, edge) {
                return;
            }
            if !stored_auto_hide(&db) {
                return;
            }
            // 延迟 1.5 秒收起。用独立线程而不是 sleep 在窗口线程上：窗口线程不能卡，
            // 一卡整个 WebView 就不响应了。
            //
            // ★2026-10-27 修 bug：这里原来只 `w.eval("window.__tookAutoCollapse()")`，
            //   而那个前端钩子当时只做了「显示小三角」的页面标记、**没有调 collapse_window**，
            //   于是窗口根本没缩 —— 控制台那句「自动收起成小三角」是下面这行 println!
            //   无条件打出来的，日志在骗人。现在：
            //     1. 真正收窗口走 Rust 的 collapse_now（与手动「收起」同一条路径）；
            //     2. 前端钩子只负责把页面切到小三角视图；
            //     3. 日志只在**真的收起来了**（is_collapsed() 为真）之后才打印。
            let app2 = app.clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(1500));
                // 这 1.5 秒里用户可能已经手动展开了 / 又拖走了 —— 收之前再确认一次
                if is_collapsed() {
                    return;
                }
                let db2 = match app2.try_state::<db::Db>() {
                    Some(d) => d,
                    None => return,
                };
                match collapse_now(&app2, &db2) {
                    Ok(true) => {
                        // 先让页面切成小三角视图，再报成功（日志不再早于事实）
                        if let Some(w) = app2.get_webview_window("main") {
                            let _ = w.eval("window.__tookAutoCollapse && window.__tookAutoCollapse()");
                        }
                        if is_collapsed() {
                            println!("[took][窗口] 吸附后 1.5 秒，已自动收起成小三角（is_collapsed=true）");
                        } else {
                            println!("[took][窗口] 吸附后自动收起失败：collapse_now 返回成功但 is_collapsed=false");
                        }
                    }
                    Ok(false) => {
                        println!("[took][窗口] 吸附后自动收起跳过：窗口已在收起态");
                    }
                    Err(e) => println!("[took][窗口] 吸附后自动收起失败：{e}"),
                }
            });
        }
    });
}

/// 启动时把存下来的透明度与吸附设置恢复回来。
///
/// 注意**不恢复收起态**：任务书要求「重启后如果上次是收起状态，恢复成展开」。
fn restore_window_chrome<R: tauri::Runtime>(app: &tauri::AppHandle<R>, db: &db::Db) {
    let pct = stored_opacity(db);
    match apply_opacity_now(app, db, pct) {
        Ok(p) => println!("[took][窗口] 启动恢复透明度 {p}%"),
        Err(e) => println!("[took][窗口] 启动恢复透明度失败（保持不透明）：{e}"),
    }
    let edge = stored_edge(db);
    let auto = stored_auto_hide(db);
    println!(
        "[took][窗口] 启动恢复吸附设置：边缘={} 自动收起={auto}；收起态一律恢复成展开",
        edge.as_str()
    );
    // 固定方式：贴壁纸 / 置顶 / 普通。**三个都要恢复** —— 只恢复贴壁纸的话，
    // 上次设成「置顶」的用户重启后窗口就不置顶了，而按钮还显示「置顶」。
    // setup 里贴壁纸那一段已经贴过了（默认开的老行为），这里按 pin_mode 再对齐一次，
    // apply_pin_style 是幂等的，重复贴同一种方式不会出问题。
    let wallpaper_enabled = db.get_state(WALLPAPER_KEY).ok().flatten().as_deref() != Some("0");
    let (style, plan) = window_chrome::restore_plan(db, wallpaper_enabled);
    match apply_pin_style(app, db, style) {
        Ok(s) => println!(
            "[took][固定方式] 启动恢复 → {}（{}）：贴壁纸={} 置顶={}",
            s.label_cn(),
            s.as_str(),
            plan.wallpaper,
            plan.always_on_top
        ),
        Err(e) => println!("[took][固定方式] 启动恢复失败（保持当前窗口状态）：{e}"),
    }
}

/// 建主窗口。窗口定义从 tauri.conf.json 挪到这里，理由只有一个：
/// Tauri 2 的 additional_browser_args 只能在代码里设，而 CDP 验收需要它。
///
/// 生产路径（不设 TOOK_CDP_PORT）与原来逐字一致：1280×820、最小 640×560、可缩放。
/// 验收路径额外开远程调试端口 —— 必须同时换一个 WebView2 数据目录，
/// 否则 WebView2 会挂到已有的浏览器进程上并忽略这些参数（实测踩过）。
/// 建主窗口（可在运行期重复调用：贴壁纸把窗口挂成子窗口后，宿主要是一销毁，
/// **Windows 会连带销毁我们的子窗口** —— 实测 lastErr=1400 ERROR_INVALID_WINDOW_HANDLE，
/// 连线程号都已经是 0。这种情况只能重建窗口，翻回顶层是不够的）。
fn make_main_window<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
) -> Result<tauri::WebviewWindow<R>, Box<dyn std::error::Error>> {
    let mut builder = tauri::WebviewWindowBuilder::new(
        app,
        "main",
        tauri::WebviewUrl::App("index.html".into()),
    )
    .title("Tool · 周期打卡日历")
    // 900 而不是 820：顶部工具条占了 64px，扣掉后日历卡片高度与只有月历时还一样，
    // 否则最满的那格（10-20 有 4 条任务）会被 fitTags 收掉一条。
    .inner_size(1280.0, 900.0)
    .min_inner_size(640.0, 560.0);

    if let Ok(port) = std::env::var("TOOK_CDP_PORT") {
        let port = port.trim().to_string();
        if !port.is_empty() {
            let dir = app.path().app_data_dir()?.join("webview-cdp");
            std::fs::create_dir_all(&dir)?;
            builder = builder.data_directory(dir).additional_browser_args(&format!(
                "--remote-debugging-port={port} \
                 --disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection"
            ));
            println!("[took] 远程调试端口：{port}（由 TOOK_CDP_PORT 打开）");
        }
    }
    Ok(builder.build()?)
}

/// 关窗即隐藏：窗口关掉后进程与调度线程继续活着（托盘图标可再打开）。
fn wire_close_to_hide<R: tauri::Runtime>(win: &tauri::WebviewWindow<R>) {
    let handle = win.clone();
    win.on_window_event(move |event| {
        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            let _ = handle.hide();
            println!("[took][提醒] 主窗口已隐藏，调度线程继续运行（托盘图标可再打开，托盘菜单可退出）");
        }
    });
}

fn build_main_window(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let win = make_main_window(&app.handle())?;
    wire_close_to_hide(&win);
    wire_snap_listener(&win);
    Ok(())
}

/// 重建尝试次数（重试到上限就停，别把日志刷爆）
static RECREATE_FAILS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

/// 窗口被系统连带销毁后重建，并按用户意愿恢复贴壁纸。
fn recreate_main_window<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    println!("[took][贴壁纸] 主窗口已随宿主一起被销毁，重建一个");
    // Tauri 那边还登记着同 label 的旧窗口（原生窗口已被系统销毁，注册表里却还在），
    // 不先摘掉就会 "a webview with label `main` already exists"。
    // destroy() 之后要**等注册表真的清掉**再建，否则抢跑同样会撞名。
    if let Some(old) = app.get_webview_window("main") {
        match old.destroy() {
            Ok(()) => println!("[took][贴壁纸] 旧窗口 destroy 已发出"),
            Err(e) => println!("[took][贴壁纸] 旧窗口 destroy 失败：{e}"),
        }
    }
    for i in 0..15 {
        if app.get_webview_window("main").is_none() {
            break;
        }
        if i == 14 {
            // 实测结论（不是猜）：窗口被系统连带销毁后，Tauri 的窗口注册表里那一项**清不掉**
            // —— destroy() 对已经没有原生句柄的窗口不触发 tauri://destroyed，
            // 于是 on_window_close 永远不跑，label "main" 一直被占着。
            // 这里重试到上限就停，并把状态记成 Disabled，避免每 2 秒刷一次日志。
            let n = RECREATE_FAILS.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
            if n >= 3 {
                println!(
                    "[took][贴壁纸] 主窗口已随宿主一起被系统销毁，且 Tauri 无法重建同 label 的窗口\
                     （注册表项清不掉）。贴壁纸已自动关闭，请重启 Took 恢复窗口。"
                );
                wallpaper::set_wanted(false);
                wallpaper::set_mode(wallpaper::PinMode::Disabled, 0);
            } else {
                println!("[took][贴壁纸] 旧窗口登记迟迟不清（第 {n} 次），下次 tick 再试");
            }
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(200));
    }
    let win = match make_main_window(app) {
        Ok(w) => w,
        Err(e) => {
            println!("[took][贴壁纸] 重建主窗口失败：{e}");
            return;
        }
    };
    wire_close_to_hide(&win);
    wire_snap_listener(&win);
    let _ = win.show();
    // 重建后把透明度补回去：新窗口没有 WS_EX_LAYERED，不重设就变回全不透明
    if let Some(db) = app.try_state::<db::Db>() {
        if let Err(e) = apply_opacity_now(app, &db, stored_opacity(&db)) {
            println!("[took][窗口] 重建后恢复透明度失败：{e}");
        }
    }
    // 重建后的窗口没有 WS_EX_TOPMOST，也没有壁纸层父级 —— 按 pin_mode 整套补回去，
    // 而不是只补贴壁纸那一半（否则「置顶」模式下窗口一重建就掉到后面去了）。
    if let Some(db) = app.try_state::<db::Db>() {
        let wallpaper_enabled =
            db.get_state(WALLPAPER_KEY).ok().flatten().as_deref() != Some("0");
        let (style, _) = window_chrome::restore_plan(&db, wallpaper_enabled);
        if let Err(e) = apply_pin_style(app, &db, style) {
            println!("[took][固定方式] 重建后恢复失败：{e}");
        }
    }
}

/// 托盘图标 + 关窗即隐藏。
///
/// 这是「窗口关掉后调度线程还在跑」的**可见形态**：用户点关闭，窗口消失但进程还在，
/// 托盘里有图标可以再打开；提醒照样触发，托盘菜单里能真正退出（退出才停调度）。
/// 没有这一层，「关窗不退出」在 Windows 上是不成立的 —— 关掉唯一的窗口，Tauri 默认就让进程结束。
fn build_tray(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    use tauri::menu::MenuBuilder;
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

    let menu = MenuBuilder::new(app)
        .text("show", "打开主窗口")
        .text("poke", "立刻对表一次")
        .text("wallpaper", "切换贴壁纸模式")
        .separator()
        .text("quit", "退出（停止调度）")
        .build()?;

    let mut builder = TrayIconBuilder::with_id("took-tray")
        .tooltip("Tool · 周期打卡日历")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => show_main(app),
            "poke" => scheduler::poke(),
            "wallpaper" => toggle_wallpaper(app),
            "quit" => {
                // 真正退出：先停铃，再退进程（调度线程随进程结束）
                alarm::stop();
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                show_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}


/// 托盘菜单「切换贴壁纸模式」：读当前固定方式、在「贴壁纸 / 普通」之间取反，
/// 走同一条 apply_pin_style（不留第二套语义）。当前若是「置顶」，切一下也变成普通窗口。
fn toggle_wallpaper<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    let db = match app.try_state::<db::Db>() {
        Some(d) => d,
        None => return,
    };
    let on = db.get_state(WALLPAPER_KEY).ok().flatten().as_deref() != Some("0");
    let style = if on {
        window_chrome::PinStyle::Normal
    } else {
        window_chrome::PinStyle::Wallpaper
    };
    match apply_pin_style(app, &db, style) {
        Ok(s) => println!(
            "[took][固定方式] 托盘切换 → {}，壁纸层实际模式 {}",
            s.label_cn(),
            wallpaper::current_mode().as_str()
        ),
        Err(e) => println!("[took][固定方式] 托盘切换失败：{e}"),
    }
}

/// Explorer 重启后自动重附着：每 2 秒看一眼宿主还在不在。
///
/// 为什么轮询而不是监听 TaskbarCreated：Tauri 的窗口消息循环由运行时接管，
/// 插一条自定义窗口消息进去要额外的 WndProc 钩子，成本远大于收益；
/// 2 秒一次 IsWindow + GetParent 是几次系统调用，代价可以忽略。
fn start_wallpaper_watch<R: tauri::Runtime>(app: tauri::AppHandle<R>) {
    std::thread::Builder::new()
        .name("took-wallpaper".into())
        .spawn(move || loop {
            std::thread::sleep(std::time::Duration::from_secs(2));
            if !wallpaper::wanted() {
                continue;
            }
            // 窗口本身被系统连带销毁（贴成子窗口后宿主一走，子窗口跟着没了）→ 重建。
            // 注意：这里不能只看 IsWindow(hwnd)，因为窗口没了就拿不到 hwnd 了。
            let win = match app.get_webview_window("main") {
                Some(w) => w,
                None => {
                    let a2 = app.clone();
                    let _ = app.run_on_main_thread(move || recreate_main_window(&a2));
                    std::thread::sleep(std::time::Duration::from_secs(2));
                    continue;
                }
            };
            let hwnd = match win.hwnd() {
                Ok(h) => h.0 as isize,
                Err(_) => {
                    let a2 = app.clone();
                    let _ = app.run_on_main_thread(move || recreate_main_window(&a2));
                    std::thread::sleep(std::time::Duration::from_secs(2));
                    continue;
                }
            };
            if !wallpaper::window_alive(hwnd) {
                let a2 = app.clone();
                let _ = app.run_on_main_thread(move || recreate_main_window(&a2));
                std::thread::sleep(std::time::Duration::from_secs(2));
                continue;
            }
            let _ = app.run_on_main_thread(move || {
                wallpaper::watch(hwnd, None);
            });
        })
        .ok();
}

fn show_main<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    if let Some(w) = app.get_webview_window("main") {
        // 隐藏期间 Explorer 可能重启过、宿主窗口被销毁 —— 先把挂载复原再显示，
        // 否则用户点了「打开主窗口」却发现桌面上什么都没有
        if wallpaper::wanted() {
            if let Ok(hwnd) = w.hwnd() {
                let h = hwnd.0 as isize;
                let _ = app.run_on_main_thread(move || {
                    wallpaper::watch(h, None);
                });
            }
        }
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            let path = dir.join("took.db");
            let handle = db::Db::open(&path)?;
            println!("[took] 本地库：{}", path.display());
            println!("[took] 同步地址：{}", handle.sync_url());
            app.manage(handle);
            app.manage(scheduler::ReminderScheduler::new());
            build_main_window(app)?;
            build_tray(app)?;
            // 贴壁纸层的监视线程（Explorer 重启后自动重附着）。启动时到底贴不贴、
            // 贴哪一种，统一交给下面的 restore_window_chrome 按 pin_mode 决定 ——
            // 这里再单独贴一次会让「上次是置顶」的用户先被贴上壁纸再被摘下来。
            start_wallpaper_watch(app.handle().clone());
            // 窗口外观的启动恢复（透明度 / 吸附设置 / 固定方式；收起态一律回展开）
            restore_window_chrome(app.handle(), &app.state::<db::Db>());
            // 调度线程在窗口之外：窗口关掉它照跑，只有进程退出才停（设置页会显示这一条真相）
            scheduler::start(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            month_grid,
            range_grid,
            list_rules,
            toggle_done,
            create_rule,
            update_rule,
            delete_rule,
            add_task,
            rename_task,
            set_task_enabled,
            delete_task,
            create_memo,
            update_memo,
            delete_memo,
            list_memos,
            get_reminder,
            save_reminder,
            clear_reminder,
            reminder_status,
            reminder_upcoming,
            snooze_reminder,
            stop_reminder,
            poke_scheduler,
            sync_now,
            sync_status,
            set_sync_url,
            set_sync_token,
            sync_probe,
            export_data,
            wallpaper_status,
            set_wallpaper_pin,
            pin_mode_status,
            set_pin_mode,
            set_wallpaper_preset,
            wallpaper_probe,
            set_opacity,
            window_opacity,
            window_chrome_status,
            set_snap_edge,
            set_snap_auto_hide,
            snap_now,
            window_anim_trace,
            window_anim_errors,
            collapse_window,
            expand_window
        ])
        .run(tauri::generate_context!())
        .expect("Tauri 启动失败");
}