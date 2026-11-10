# took/pc — PC 端（Tauri 2 + Rust + 纯 HTML/CSS/JS）

首期（只读月历）之上加了四件事：**打卡写路径**、**同步客户端**、**界面补齐（配置页 / 设置页）**、
**规则与任务的编辑入口（契约 §9 写路径）**。
交互约定不变：格子里任务名仍是纯预览，只有「点日期 → 面板里点任务」才能打卡。

> 改重复设置（repeat_mode / weekdays_mask / repeat_every / month_day / year_month / year_day / start_date）
> **不会原地改**：旧规则 `repeat_until = 昨天`（原地写、刷 updated_at），另建一条新规则
> `start_date = 今天` 承载新设置；旧规则下的任务与 completion 一条不动。
> 裂开后弹「复制 N 个任务到新规则」，**默认勾选**（N = 旧规则的任务数）：复制产出的是新 id 的任务，
> 历史打卡仍挂旧规则，所以默认复制风险为零；取消勾选也合法（新规则先留空，之后自己加）。
> 只改 title / enabled / 结束日期 → 原地改，不裂开。

## 命令（前端 → Rust）

| 命令 | 作用 |
|---|---|
| month_grid(y, m) | 某月每天命中的任务与打卡状态（结构同 Go 后端 /api/month） |
| list_rules(includeEnded, today) | 规则 + 其下任务。**默认只返回未结束的**（契约 §9.2）；includeEnded=true 连历史一起返回（配置页用），today 由前端传本机日期 |
| create_rule(ruleJson, tasks) | 新增规则 + 其下任务（§9.1 校验：名称 / 严格日期 / 周重复至少一天 / 每 N 天 1..3660 / 至少一个任务），返回新 id |
| update_rule(ruleJson, today) | 改规则：重复设置变了就**裂开**（§9.2），否则原地改 title / enabled / end_date。返回 {split, old_rule_id, new_rule_id?, old_repeat_until} |
| delete_rule(id) | 软删规则 + 其下所有任务，**completion 不删**（§9.3），返回 {rule_id, tasks_deleted} |
| add_task(ruleId, title) / rename_task(taskId, title) / set_task_enabled(taskId, enabled) / delete_task(taskId) | 任务增删改（§9.4），删除为软删、打卡历史保留 |
| toggle_done(taskId, periodStart, done) | 打卡 / 取消打卡：写 completion 的 status、updated_at=当前毫秒、dirty=1，**rev 保持**；返回写入后的真相 + period_start 当天的展开数据 |
| sync_now() | 先 push dirty=1，成功后本地清 dirty；再 pull since=lastPulledRev 并按契约 §7.2 仲裁落库；返回 {pushed, pulled, ok, error} |
| sync_status() | {url, last_sync_at, dirty, last_error, last_pulled_rev}（设置页用） |
| set_sync_url(url) | 改同步地址（只收 http/https 字面地址） |

| reminder_status() | 调度器的真实状态：{scheduled, next_fire_at, next_fire_text, next_fire_title, last_error, last_fired_*, fired_count, thread_alive, notify_ok, ringing, tick_secs, sound_playing} |
| reminder_upcoming(limit) | 接下来的 N 条提醒 [{title, at, text, occur_date, fire_date}]（设置页「接下来要响的」） |
| snooze_reminder(reminderId) | 贪睡：按该提醒自己的 snooze_min 推后重响；0 = 不贪睡直接停 |
| stop_reminder(reminderId) | 停止响铃（关闹钟窗 + 停铃声 + 取消主窗口置顶），幂等 |
| poke_scheduler() | 请后台线程立刻对一次表（保存/清除提醒后本来就会自动 poke） |

day.tasks[] 每条都带 period_start：前端据此把「同一周期内所有命中日」一起重绘，打卡后不需要重新拉整月。

## 提醒的真实调度（定稿 §6.3.4 ~ §6.3.5）

**与「在前端 JS 里设 setInterval」的本质区别：调度是 Rust 侧的一条独立线程**，窗口关不关与它无关。

| 环节 | 做法 | 为什么 |
|---|---|---|
| 触发时刻 | `reminder.rs::next_fire` 纯函数 | 这是唯一真会算错的地方（repeat_rule / offset_days / 已过时刻 / 月末钳制 / 2-29 平年 / 每 N 天跨月），必须能单测逐条断言 |
| 调度 | 独立线程，每 30 秒对表（`scheduler.rs`） | 不依赖窗口；每轮重新读库，改完提醒下一轮就生效，不需要跨线程唤醒协议 |
| 到点判定 | `(now-60s, now]` 窗口 + `(reminder_id, fire_at)` 去重 | 线程 30 秒才醒一次，触发点几乎总落在两次醒之间；容差 60 秒 > TICK 才不漏，再久就不补响（契约 §11：不能补响过去） |
| 通知 | `tauri-plugin-notification`（Windows toast） | 走系统通知中心，可在「操作中心」里查到 |
| 闹钟 | 置顶唤起主窗口 + `winmm PlaySoundW` 循环 `C:\Windows\Media\AlarmNN.wav` + 独立置顶闹钟窗 | 定稿 §6.3.5 的「全屏 + 响铃 + 必须手动关」 |
| 贪睡 | 响时按钮 → 内存队列 `snooze_until = now + snooze_min`，到点重排 | 贪睡是运行时状态，不改数据库（`snooze_min` 才是用户配置） |
| 响铃上限 | 5 分钟无操作自动停 | 定稿 §6.3.5：不能无限响 |
| 关窗后 | 主窗口 `CloseRequested` → `prevent_close` + `hide`，托盘图标留着 | Windows 上关掉唯一窗口默认就让进程结束；不拦住，「关窗后还在跑」就是假的 |

**已实测**（证据在 `shots/`，脚本可复跑）：

- `verify-reminder-fire.cjs`：约 1 分钟后到点 → 闹钟窗弹出 + Windows toast 弹出（`shots/reminder-fired.png`）。
- `verify-reminder-closed-window.cjs`：对主窗口发真 `WM_CLOSE` → `visible_count=0`、进程仍在 → 到点照样发通知（`shots/reminder-fired-window-closed.png`）。
- `verify-reminder-snooze.cjs`：响 → 贪睡 1 分钟 → `fired_count` 1→2 且铃声再次响起（`shots/reminder-snooze.json`）。

**已知差异（如实记录，不假装与 Android 等价）**：

| 项 | Android | PC（本期） |
|---|---|---|
| 音量通道 | `USAGE_ALARM` 独立通道，不受媒体音量影响 | `PlaySoundW` 走系统默认输出，**受媒体音量影响**；要做到独立需 WASAPI 会话，本期不做 |
| 震动 | 有 | 无（PC 无此能力） |
| 响铃时长 | 5 分钟自动停 | 同 |
| 锁屏唤醒 | `setShowWhenLocked` | 无锁屏概念；闹钟窗置顶 + 抢焦点 |
| 重启恢复 | `BOOT_COMPLETED` 重建 | 不需要：提醒是从库里现算的，每次启动第一轮对表就恢复 |
| 精确性 | `setAlarmClock` 系统级精确 | 30 秒轮询，**最坏晚 30 秒**；系统休眠/待机时不保证（进程被挂起则暂停） |

页面在设置 → 提醒里显示：后台线程是否在跑、已排程条数、下一次触发、最近一次触发、正在响铃、通知通道、最近一次错误、以及未来的 5 条提醒。**这些数字全部来自后端命令**，不是前端猜测。

## 目录

    pc/
      src-tauri/
        src/engine.rs     重复规则引擎：occurs_on / period_start_of（契约 §3.2 / §3.3）+ 14 条测试
        src/db.rs         SQLite：建表、种子、月历展开、打卡写入、规则/任务的编辑写路径（§9，含 needs_split
                          判定与裂开）、同步落库与 LWW 仲裁、local_state
        src/sync.rs       同步客户端（HTTP/1.1 手写在 TcpStream 上，零新依赖）+ 进程内 mock 后端测试
        src/schema.sql    契约 §2 的四张表（与 server 逐字一致，未改动）
        src/reminder.rs   提醒的触发时刻纯计算（契约 §11.2 / 定稿 §6.3.4）：repeat_rule、offset_days、
                          已过时刻、月末钳制、2-29 平年、每 N 天跨月 + 12 条单测
        src/scheduler.rs  后台调度线程（每 30 秒对表）+ 通知/闹钟/贪睡 + 8 条单测
        src/alarm.rs      Windows 响铃（winmm PlaySoundW 循环闹钟音）+ 1 条状态机单测
        src/lib.rs        Tauri 入口、18 个命令、主窗口 / 托盘 / 关窗即隐藏（含 TOOK_CDP_PORT 验收钩子）
        tauri.conf.json   frontendDist = ../ui；windows 改为在 lib.rs 里创建（CDP 需要代码化窗口参数）
      ui/
        index.html        顶栏 + 月历 + 配置层 + 设置层 + 当天面板 + 规则表单层 + 全局确认框
        style.css         设计令牌与组件样式，逐字取自 prototype/pc.html（含 .topbar / .screen / .set-* / .card / .row / .btn / .inp）
        app.js            42 格、三档密度、当天面板打卡、可编辑配置页（规则表单 / 裂开确认 / 任务增删改）、
                          设置页（提醒/同步/关于）、同步定时器
        alarm.html        闹钟全屏窗：大字号时间 + 标题 + 「稍后提醒 N 分钟 / 停止」两个真按钮
        mock.js           非 Tauri 环境的兜底数据源：同种子、同语义，同样能 toggle_done 与 §9 全部写命令
      verify.cjs          浏览器验收：CDP 驱动 Chrome，44 条断言 + 截图（走 mock.js，含兜底打卡）
      verify-visual.cjs   视觉一致性：与 prototype/pc.html 逐项比对计算样式
      verify-tauri.cjs    真窗口验收：CDP 直连 WebView2，34 条（真命令数据 + 面板打卡全流程 + 配置/设置页）
      verify-edit.cjs     真窗口编辑验收：CDP 直连 WebView2，70 条（新建规则 → 月历命中 → 改 weekdays 裂开 →
                          已结束的旧规则 + 新规则 + 旧打卡仍在 → 默认勾选复制任务（新 id）→ 取消勾选留空 →
                          任务增/改名/启停/删 → 删除规则）
      verify-sync.cjs     真同步验收：真 Go 后端（server/）+ 真窗口，22 条（push / pull / 失败静默 / 落库）
      verify-reminder-fire.cjs           提醒真触发：建 5 分钟后到点的提醒 → 等它响 → 截图 + 窗口列表
      verify-reminder-closed-window.cjs  关窗后仍调度：WM_CLOSE 真关主窗口 → 可见窗口 0 → 到点照样发通知
      verify-reminder-snooze.cjs         贪睡重排：响 → 贪睡 1 分钟 → fired_count 1→2 且铃声再响
      verify-reminder-panel.cjs          设置页「提醒」面板：数字来自后端 + 面板截图
      shots/              验收截图（tauri-window-toggle / -settings / -config / -sync / -sync-error /
                          reminder-fired / -fired-window-closed / -panel / -ringing / -snoozed）

## 构建与测试

环境变量（本机）：

    export RUSTUP_HOME="D:\work\rust\rustup"
    export CARGO_HOME="D:\work\rust\cargo"
    export PATH="/d/work/rust/cargo/bin:$PATH"
    # cargo 需要 MSVC 链接器：
    #   cmd /c "call D:\work\vs-buildtools\VC\Auxiliary\Build\vcvars64.bat && cargo test"

    cd pc/src-tauri
    cargo test      # 77 个测试（engine 19 + db 41 + sync 4 + reminder 12 + scheduler 8 + alarm 1）
    cargo build     # 产出 target/debug/took.exe

> **前端资源在编译期嵌进 exe**（tauri-codegen 读 ../ui）。改完 ui/** 必须重新 `cargo build`，
> 否则窗口里跑的还是上一版 JS——验收脚本改用 Debugger.getScriptSource 核对过这一点。

新增测试覆盖：

| 关注点 | 测试 |
|---|---|
| 打卡后同周期其他天也变完成 | db::tests::toggle_done_shares_status_across_period |
| 取消打卡后恢复、updated_at 必须变大 | db::tests::untoggle_restores_and_bumps_updated_at |
| 写入层严格校验（非法日期 / 任务不存在） | db::tests::toggle_done_rejects_bad_input |
| 同步冲突仲裁（updated_at 大的赢，相等比 rev，再相等幂等） | db::tests::pull_arbitrates_by_newer_updated_at |
| 本地更新更晚时保留 dirty | db::tests::pull_keeps_local_dirty_when_local_wins |
| push 清 dirty 但不清更新的本地改动 | db::tests::mark_pushed_clears_dirty_but_keeps_newer_local_edit |
| push→pull 真协议往返（进程内 mock 后端） | sync::tests::push_then_pull_round_trip_against_mock_server |
| 失败保留 dirty、不回滚、不刷新上次同步时间 | sync::tests::sync_failure_keeps_dirty_and_never_rolls_back |
| 地址解析 / chunked 解码 / HTTP 错误码 | sync::tests::parse_base_rules / decodes_chunked_body / http_error_status_is_reported |
| local_state 默认值与更新 | db::tests::local_state_defaults_and_update |
| §9.6 E1 只改 title → 原地改，repeat_until 不动、历史打卡在 | db::tests::e1_title_only_edit_stays_in_place |
| §9.6 E2 weekdays_mask 31→42 → 裂开（旧规则收尾到昨天 / 新规则起始今天 / 任务与打卡不动） | db::tests::e2_weekdays_mask_change_splits |
| §9.6 E3 删规则 → 规则与 2 个任务 deleted=1，completion 行数不变 | db::tests::e3_delete_rule_soft_deletes_tasks_keeps_completions |
| §9.6 E4 加任务 → rule_id 正确、sort_order 递增、dirty=1 | db::tests::e4_add_task_appends_sort_order |
| §9.6 E5 删任务 → deleted=1，completion 行数不变 | db::tests::e5_delete_task_keeps_completions |
| §9.6 E6 编辑后不存在「被改过却没置 dirty」的行 | db::tests::e6_every_edited_row_is_dirty |
| 裂开判定只看 7 个重复字段 | db::tests::split_predicate_only_watches_repeat_fields |
| 防重复裂开（已结束规则再改重复设置被拒、新 id 撞车被拒） | db::tests::split_refuses_to_split_an_ended_rule_twice |
| 裂开后默认勾选复制：新规则任务数=旧规则、任务 id 全不相同 | db::tests::split_copy_default_copies_tasks_with_new_ids |
| 取消勾选：新规则 0 任务，旧规则任务与打卡不动 | db::tests::split_without_copy_leaves_new_rule_without_tasks |
| §9.1 新增校验（无任务 / 周重复没选天 / 非法日期 / 每 N 天越界） | db::tests::create_rule_writes_rule_and_tasks |

## 运行

    ./target/debug/took.exe

本地库落在 %APPDATA%\app.took.desktop\took.db（首次启动建表 + 写种子）；删掉即回到初始种子。
同步游标与设置存在同一库的 local_state 表（PC 本地独有、不参与 push/pull，所以 schema.sql 与后端仍逐字一致）。

同步行为：**启动后 1.2s 尝试一次，之后每 5 分钟一次**（ui/app.js 里的定时器，只在真 Tauri 里跑）。
失败一律静默：不弹窗、不回滚本地数据，只把错误写进设置页的「最近一次错误」。
同一时刻只跑一趟同步（正在跑时再点「立即同步」会搭上同一趟，不会把按钮卡死）。

## 验收入口

    cd pc
    node verify.cjs          # 浏览器 44 条（mock.js，含三档密度实宽切换 + 兜底打卡）
    node verify-visual.cjs   # 51 条计算样式比对
    node verify-tauri.cjs    # 真窗口 34 条：含「点日期 → 面板点任务 → 整周变 → 再点恢复」
    node verify-edit.cjs     # 真窗口 70 条：编辑 / 裂开 / 默认复制任务（+取消勾选）/ 任务增删改 / 删除确认
    node verify-sync.cjs     # 真后端 22 条：需先起 server/（cd server && go build -o ../tmp.exe .; ./tmp.exe -addr :8420）

### WebView2 远程调试（真窗口断言靠它）

WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9333 在本机实测**不一定生效**：
只要该 WebView2 数据目录下已有浏览器进程在跑，新参数就会被忽略（实测浏览器进程命令行里没有该 flag）。
所以 lib.rs 里主窗口改成代码创建，并给了个环境变量钩子：设 TOOK_CDP_PORT=9333 时用**独立数据目录**
（…/webview-cdp）+ additional_browser_args 打开调试端口；不设该变量时生产路径与原来一致
（1280×900，最小 640×560，可缩放。高度从 820 提到 900 是因为顶部工具条占 64px，扣掉后日历区高度不变）。

## 与契约的对应

| 契约 | 落点 |
|---|---|
| §3.1 周期归属 | engine::period_start_of |
| §3.4 日期一律 YYYY-MM-DD | engine::parse_date 严格校验；打卡写路径先校验再落库 |
| §3.5 12 条用例 | engine.rs 的 case01..case12 + db.rs::period_done_shared_within_week |
| §5.3 三档密度 | app.js 的 DENSITY_BREAKPOINTS（<720 / 720~1080 / >1080）+ fitTags 按像素再收缩 |
| §5.4 点击规则 | 网格 gridEl.click 里 .tag / .dots 直接 return；打卡入口只在面板 sheetListEl 的 .mtask 按钮 |
| §7.1 两个接口 | sync::sync_now（POST /api/sync/push → GET /api/sync/pull?since=） |
| §7.2 冲突仲裁 | db::remote_wins（updated_at 大者赢；相等比 rev；再相等保留本地） |
| §7.4 客户端状态 | local_state 表：last_pulled_rev / sync_url / last_sync_at / last_error；dirty 列在各表 |
| §2 四张表 | src/schema.sql（未改动） |
| §9.1 新增校验 | db::validate_rule（名称 / 严格日期 / 周重复 ≥1 天 / 每 N 天 1..3660 / 至少一个任务） |
| §9.2 裂开 | db::needs_split（7 个字段的判定）+ db::Db::update_rule（旧规则 repeat_until=昨天、新规则 start_date=今天、任务不搬） |
| §9.3 删规则 | db::Db::delete_rule（规则 + 任务软删，completion 不动） |
| §9.4 任务增删改 | db::Db::add_task / rename_task / set_task_enabled / delete_task |
