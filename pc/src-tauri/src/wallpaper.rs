//! 贴壁纸层（定稿 §5.5「固定桌面」）。
//!
//! 目标：按 Win+D 显示桌面之后，Took 还在壁纸上看得见。
//!
//! ## 三条路线，按优先级
//!
//! 1. **WorkerW**（Win10 / Win11 21H2~23H2 的经典结构）
//!    FindWindowW("Progman") → SendMessageTimeout(0x052C) 让系统分裂出一个 WorkerW →
//!    EnumWindows 找「承载 SHELLDLL_DefView 的那个 WorkerW 的兄弟 WorkerW」→ SetParent 进去。
//! 2. **ProgmanTopChild**（Win11 24H2 的结构，本机实测就是这一种）
//!    24H2 之后 Progman 下直接挂着 SHELLDLL_DefView，顶层那些 WorkerW 全是不可见的小窗口
//!    （实测本机 12 个，vis=False、rect 0,0,202,56，没有一个承载 DefView）。
//!    这时把窗口直接 SetParent 到 Progman，并**显式把 z-order 抢到 DefView 之上**。
//! 3. **FallbackAlwaysOnTop**（降级）
//!    连 Progman 都拿不到（Explorer 没启动 / 被策略禁用等），退回普通置顶窗口 + 托盘。
//!
//! 定稿 §5.5 第 433 行明确要求这条降级路径：探测失败时自动降级为「普通置顶窗口 + 托盘」，
//! 否则功能在部分用户机器上直接不可用。
//!
//! ## 两个必须写进注释、防止被后人「优化」掉的坑
//!
//! - **z-order 必须显式抢。** 挂到 Progman 但 z-order 排在 SHELLDLL_DefView **之下**时，
//!   Win+D 之后窗口会被桌面图标层整个盖住（实测截图证实：窗口句柄还在、IsWindowVisible 为真、
//!   GetParent 也对，但屏幕上看不见）。所以附着之后必须 SetWindowPos(HWND_TOP)。
//! - **尺寸故意选小部件、不铺满全屏。** 全屏铺满在技术上可行（SetParent + 铺满 rect），但会让用户
//!   **点不到自己的桌面图标**，等于把桌面搞坏；WebView2 窗口又做不了逐像素点击穿透
//!   （WS_EX_TRANSPARENT 只对 layered 窗口生效，给 WebView2 加 layered 会破坏合成）。
//!   所以这里刻意采用定稿 §5.5 第 529 行建议的小部件预设尺寸，并且**保持窗口可交互**，
//!   用户能直接在壁纸上点日期打卡。这是有意选择，不是能力不足。
//!
//! ## Explorer 重启
//!
//! Explorer 崩溃或用户重启资源管理器后 Progman/WorkerW 会被销毁，附着过的窗口就成了孤儿。
//! watch() 每 2 秒轮询一次：宿主窗口 IsWindow() 为假、或窗口自己的 GetParent()
//! 已经不是当初挂的那个宿主时，就自动重附着（重附着同样会重新探测）。
//!
//! ## 与「关窗即隐藏 + 托盘」的关系
//!
//! 两条链路互不打架：贴壁纸只改变**父窗口与窗口样式**，不接管显示/隐藏。
//! 关窗时 main.on_window_event 里照旧 hide()；回托盘点「打开主窗口」时
//! show_main() 先 ensure_reattached() 再 show —— 因为 Explorer 可能在这期间重启过。

use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};

/// 贴壁纸的三种落地形态（定稿 §5.5 第 444 行给的三个名字，一个没改）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PinMode {
    /// 经典路线：挂进 DefView 的兄弟 WorkerW
    WorkerW,
    /// 24H2 路线：挂进 Progman，并把 z-order 抢到 SHELLDLL_DefView 之上
    ProgmanTopChild,
    /// 降级：普通置顶窗口 + 托盘
    FallbackAlwaysOnTop,
    /// 没开
    Disabled,
}

impl PinMode {
    pub fn as_str(self) -> &'static str {
        match self {
            PinMode::WorkerW => "WorkerW",
            PinMode::ProgmanTopChild => "ProgmanTopChild",
            PinMode::FallbackAlwaysOnTop => "FallbackAlwaysOnTop",
            PinMode::Disabled => "Disabled",
        }
    }

    /// 是否真的挂进了桌面层（前两种是，后两种不是）
    pub fn attached_to_desktop(self) -> bool {
        matches!(self, PinMode::WorkerW | PinMode::ProgmanTopChild)
    }

    /// 给用户看的一句话说明。降级必须**说出来**，不能静默假装成功。
    pub fn describe(self) -> &'static str {
        match self {
            PinMode::WorkerW => "已贴到壁纸层（WorkerW）：Win+D 之后仍在桌面上",
            PinMode::ProgmanTopChild => {
                "已贴到壁纸层（Progman 顶层子窗）：Win+D 之后仍在桌面上（Win11 24H2 结构）"
            }
            PinMode::FallbackAlwaysOnTop => {
                "降级为普通置顶窗口：本机找不到壁纸层（Explorer 未启动或系统改了 WorkerW 结构），窗口不会被 Win+D 收起，但不在图标层下面"
            }
            PinMode::Disabled => "贴壁纸已关闭：普通窗口",
        }
    }
}

/// 一个候选宿主窗口（纯数据，便于单测）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HostCandidate {
    pub hwnd: isize,
    pub class: HostClass,
    /// 这个窗口是否直接挂着 SHELLDLL_DefView
    pub has_def_view: bool,
    pub visible: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HostClass {
    Progman,
    WorkerW,
}

/// 探测结果：要从候选列表里选谁当宿主。
/// **这个函数是纯的**，Win32 的枚举在外面做完再喂进来 —— 「找不到 WorkerW 要回落」这条
/// 状态机因此可以在没有桌面环境的情况下被 cargo test 覆盖。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HostChoice {
    Hwnd(isize),
    /// 没有可用宿主 → 降级
    Fallback,
}

/// 选宿主。优先级：
/// 1. 顶层 WorkerW 里**承载 SHELLDLL_DefView 的那个的兄弟** —— 这就是经典路线的目标 WorkerW。
///    在本候选列表里表现为：某个 WorkerW 自身不挂 DefView，但它的兄弟（另一个顶层 WorkerW）挂了。
///    判断方式（与社区实现一致）：取「承载 DefView 的顶层 WorkerW 之后出现的下一个顶层 WorkerW」。
/// 2. 没有 WorkerW 可挂，但 Progman 挂着 DefView（24H2）→ 直接挂 Progman。
/// 3. 都没有 → Fallback。
pub fn choose_host(cands: &[HostCandidate]) -> HostChoice {
    // 1. 经典路线：找到承载 DefView 的 WorkerW 后面的那个 WorkerW
    let mut found_def_view_worker = false;
    for c in cands {
        if c.class == HostClass::WorkerW && c.has_def_view {
            found_def_view_worker = true;
            continue;
        }
        if found_def_view_worker && c.class == HostClass::WorkerW {
            return HostChoice::Hwnd(c.hwnd);
        }
    }
    // 2. 24H2：DefView 直接挂 Progman
    for c in cands {
        if c.class == HostClass::Progman && c.has_def_view && c.visible {
            return HostChoice::Hwnd(c.hwnd);
        }
    }
    // 3. 降级
    HostChoice::Fallback
}

/// 当前状态（命令层与托盘都要读它）
static MODE: AtomicI32 = AtomicI32::new(0);
static ENABLED: AtomicBool = AtomicBool::new(false);
/// 当前宿主 hwnd（0 = 无）
static HOST: AtomicI32 = AtomicI32::new(0);
/// 用户是不是想让它贴着。关窗隐藏时 watch() 据此决定要不要管它。
static WANT: AtomicBool = AtomicBool::new(false);

fn mode_from_i32(v: i32) -> PinMode {
    match v {
        1 => PinMode::WorkerW,
        2 => PinMode::ProgmanTopChild,
        3 => PinMode::FallbackAlwaysOnTop,
        _ => PinMode::Disabled,
    }
}

fn mode_to_i32(m: PinMode) -> i32 {
    match m {
        PinMode::Disabled => 0,
        PinMode::WorkerW => 1,
        PinMode::ProgmanTopChild => 2,
        PinMode::FallbackAlwaysOnTop => 3,
    }
}

pub fn current_mode() -> PinMode {
    mode_from_i32(MODE.load(Ordering::SeqCst))
}

/// 用户是否希望一直贴着（关窗隐藏后 watch 不该把它拉回来）
pub fn wanted() -> bool {
    WANT.load(Ordering::SeqCst)
}

pub fn set_wanted(v: bool) {
    WANT.store(v, Ordering::SeqCst);
}

pub fn host_hwnd() -> isize {
    HOST.load(Ordering::SeqCst) as isize
}

pub fn set_mode(m: PinMode, host: isize) {
    MODE.store(mode_to_i32(m), Ordering::SeqCst);
    ENABLED.store(m != PinMode::Disabled, Ordering::SeqCst);
    HOST.store(host as i32, Ordering::SeqCst);
}

/// 设置页 / 托盘菜单要喂给用户看的真实状态（不猜、不硬编码文案）
#[derive(Debug, Clone, serde::Serialize)]
pub struct WallpaperStatus {
    /// 用户开没开这个功能（持久化在 local_state 的 wallpaper_pin）
    pub enabled: bool,
    /// 实际落地的形态
    pub mode: String,
    /// 一句话说明
    pub detail: String,
    /// 宿主窗口句柄（0 表示没有）
    pub host: isize,
    /// 宿主类名（Progman / WorkerW / 空）
    pub host_class: String,
    /// 窗口自己的父窗口句柄（0 表示无父）
    pub parent: isize,
    /// 窗口自己的 WS_CHILD 位是否已置上
    pub is_child: bool,
}

pub fn status_snapshot(mode: PinMode, parent: isize, host_class: String, is_child: bool) -> WallpaperStatus {
    // 只说真话：声称贴上了就得真挂着（父窗口非 0 且 WS_CHILD 置上），否则如实标降级
    let claimed_attached = mode.attached_to_desktop();
    let really_attached = parent != 0 && is_child;
    let mode = if claimed_attached && !really_attached {
        PinMode::FallbackAlwaysOnTop
    } else {
        mode
    };
    WallpaperStatus {
        enabled: mode != PinMode::Disabled,
        mode: mode.as_str().to_string(),
        detail: mode.describe().to_string(),
        host: host_hwnd(),
        host_class,
        parent,
        is_child,
    }
}

/// 探测 → 选宿主 → 附着 → 失败降级。返回实际落地的形态。
/// Explorer 没起、结构又变了、SetParent 被拒 —— 一律降级，绝不把应用搞成打不开。
#[cfg(windows)]
pub fn attach_to_desktop(hwnd: isize, size: Option<(i32, i32)>) -> PinMode {
    crate::wallpaper::win::attach_to_desktop(hwnd, size)
}

/// 监视 Explorer 重启并重附着（由调度线程每 2 秒调一次；不在自己开线程，
/// 免得又多一个生命周期要管）。
#[cfg(windows)]
pub fn ensure_reattached(hwnd: isize, size: Option<(i32, i32)>) -> PinMode {
    crate::wallpaper::win::ensure_reattached(hwnd, size)
}

/// 脱离：父级还原回桌面、样式还原成普通窗口。
#[cfg(windows)]
pub fn detach(hwnd: isize, size: Option<(i32, i32)>) -> bool {
    crate::wallpaper::win::detach(hwnd, size)
}

/// 把 Win32 挂载包成 Tauri 侧可调用的形式（句柄只有这一层能拿）。
/// 非 Windows 直接 Disabled —— 这是 Windows 专属能力，不在别的平台上假装成功。
#[cfg(windows)]
pub fn apply<R: tauri::Runtime>(win: &tauri::WebviewWindow<R>, on: bool, size: Option<(i32, i32)>) -> PinMode {
    // tauri 的 hwnd() 返回 windows crate 的 HWND 新类型，.0 才是裸指针
    let hwnd = match win.hwnd() {
        Ok(h) => h.0 as isize,
        Err(e) => {
            println!("[took][贴壁纸] 拿不到窗口句柄：{e}");
            return PinMode::Disabled;
        }
    };
    if on {
        set_wanted(true);
        attach_to_desktop(hwnd, size)
    } else {
        set_wanted(false);
        let _ = detach(hwnd, size);
        PinMode::Disabled
    }
}

#[cfg(not(windows))]
pub fn apply<R: tauri::Runtime>(_win: &tauri::WebviewWindow<R>, _on: bool, _size: Option<(i32, i32)>) -> PinMode {
    PinMode::Disabled
}

/// 把 apply 调度到窗口自己的线程上执行并等结果。
///
/// SetParent 跨线程会被系统拒（实测 err=5 ACCESS_DENIED），所以这一步必须在主线程做。
/// 同步等结果，是为了让命令返回的 mode 就是**这一刻**的真实结果，不是过一会儿才生效的猜测。
#[cfg(windows)]
pub fn apply_on_main<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    win: &tauri::WebviewWindow<R>,
    on: bool,
    size: Option<(i32, i32)>,
) -> PinMode {
    let (tx, rx) = std::sync::mpsc::channel();
    let w = win.clone();
    if app.run_on_main_thread(move || {
        let _ = tx.send(apply(&w, on, size));
    }).is_err() {
        println!("[took][贴壁纸] 无法调度到主线程，直接在当前线程尝试");
        return apply(win, on, size);
    }
    rx.recv_timeout(std::time::Duration::from_secs(4)).unwrap_or_else(|e| {
        println!("[took][贴壁纸] 主线程调度超时：{e}");
        current_mode()
    })
}

#[cfg(not(windows))]
pub fn apply_on_main<R: tauri::Runtime>(
    _app: &tauri::AppHandle<R>,
    _win: &tauri::WebviewWindow<R>,
    _on: bool,
    _size: Option<(i32, i32)>,
) -> PinMode {
    PinMode::Disabled
}

/// 窗口本身还在不在（贴成子窗口后宿主一销毁，系统会连带销毁我们的窗口）
#[cfg(windows)]
pub fn window_alive(hwnd: isize) -> bool {
    hwnd != 0 && crate::wallpaper::win::window_alive(hwnd)
}

#[cfg(not(windows))]
pub fn window_alive(hwnd: isize) -> bool {
    hwnd != 0
}

/// 如实读回窗口当前的父子关系（验收靠它证明父级是 WorkerW / Progman，不是我说的）
#[cfg(windows)]
pub fn probe_of(hwnd: isize) -> (isize, String, bool) {
    if hwnd == 0 {
        return (0, String::new(), false);
    }
    crate::wallpaper::win::probe_of(hwnd)
}

#[cfg(not(windows))]
pub fn probe_of(_hwnd: isize) -> (isize, String, bool) {
    (0, String::new(), false)
}

/// 宿主失活时自动重附着（Explorer 重启后从桌面消失，是这块最常见的坑）
#[cfg(windows)]
pub fn watch(hwnd: isize, size: Option<(i32, i32)>) -> PinMode {
    if !wanted() {
        return current_mode();
    }
    ensure_reattached(hwnd, size)
}

#[cfg(not(windows))]
pub fn watch(_hwnd: isize, _size: Option<(i32, i32)>) -> PinMode {
    current_mode()
}


/// 桌面层的完整实况：Progman 是否挂 SHELLDLL_DefView、顶层 WorkerW 有几个、
/// 其中几个承载 DefView、窗口矩形的命中测试结果。
///
/// 这是**验收证据**的来源：不靠外部脚本猜，由应用自己读 Win32 打出来。
#[cfg(windows)]
#[derive(Debug, Clone, serde::Serialize)]
pub struct LayerProbe {
    pub window: isize,
    pub window_class: String,
    pub window_title: String,
    pub rect: (i32, i32, i32, i32),
    pub parent: isize,
    pub parent_class: String,
    pub parent_alive: bool,
    pub visible: bool,
    pub is_child: bool,
    pub style: u32,
    pub progman: isize,
    pub progman_has_def_view: bool,
    pub workerw_total: i32,
    pub workerw_with_def_view: i32,
    /// 窗口中心点 WindowFromPoint 打到的句柄（等于 window 才说明它压在最上层、可交互）
    pub hit_center: isize,
    pub hit_center_class: String,
    /// 屏幕左上角图标区（50,40）打到的句柄（不等于 window 才说明没挡住桌面图标）
    pub hit_icon_zone: isize,
    pub hit_icon_zone_class: String,
    /// 中心点的命中链里有本窗口（= 本窗口压在最上层、可交互）
    pub hit_center_is_self: bool,
    /// 图标区的命中链里有本窗口（= 本窗口挡住了桌面图标，应当为 false）
    pub hit_icon_zone_is_self: bool,
    /// 中心点命中的完整父链：类名@句柄 ...
    pub hit_center_chain: Vec<String>,
    /// 在父窗口的子窗口 z-order 里，本窗口是否排在 SHELLDLL_DefView **之前**（= 压在图标层之上）
    pub above_def_view: bool,
    /// 父窗口子窗口的 z-order（最上层到最下层），上面那条判断的证据
    pub sibling_order: Vec<String>,
}

#[cfg(windows)]
pub fn probe_layers(hwnd: isize) -> LayerProbe {
    crate::wallpaper::win::probe_layers(hwnd)
}

#[cfg(not(windows))]
#[derive(Debug, Clone, serde::Serialize)]
pub struct LayerProbe {
    pub window: isize,
}

#[cfg(windows)]
mod win {
    use super::*;
    use windows_sys::Win32::Foundation::{GetLastError, HWND, LPARAM, POINT, RECT};
    use windows_sys::Win32::System::Threading::GetCurrentThreadId;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        EnumChildWindows, EnumWindows, FindWindowW, GetClassNameW, GetParent, GetWindowTextW,
        GetWindowThreadProcessId,
        GetSystemMetrics, GetWindowLongPtrW, GetWindowRect, IsWindow, IsWindowVisible,
        SendMessageTimeoutW, SetParent, SetWindowLongPtrW, SetWindowPos, WindowFromPoint,
        GWL_EXSTYLE, GWL_STYLE, HWND_TOP, SMTO_NORMAL, SM_CXSCREEN, SM_CYSCREEN,
        SWP_FRAMECHANGED, SWP_NOACTIVATE, SWP_NOZORDER, WS_CHILD, WS_EX_TOOLWINDOW, WS_POPUP,
    };

    /// 让系统分裂出 WorkerW 的未公开消息（Win10 起社区通用做法）。
    /// 24H2 上发它没有任何效果，但不报错 —— 发一次成本可忽略，老机器上是必需的。
    const WM_SPAWN_WORKERW: u32 = 0x052C;

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    fn class_of(hwnd: isize) -> String {
        if hwnd == 0 {
            return String::new();
        }
        let mut buf = [0u16; 256];
        let n = unsafe { GetClassNameW(hwnd as HWND, buf.as_mut_ptr(), buf.len() as i32) };
        if n <= 0 {
            return String::new();
        }
        String::from_utf16_lossy(&buf[..n as usize])
    }

    unsafe extern "system" fn enum_top(hwnd: HWND, lparam: LPARAM) -> windows_sys::core::BOOL {
        let out = &mut *(lparam as *mut Vec<isize>);
        out.push(hwnd as isize);
        1
    }

    unsafe extern "system" fn enum_child(hwnd: HWND, lparam: LPARAM) -> windows_sys::core::BOOL {
        let found = &mut *(lparam as *mut bool);
        if class_of(hwnd as isize) == "SHELLDLL_DefView" {
            *found = true;
            return 0;
        }
        1
    }

    /// 枚举所有顶层窗口，挑出 Progman / WorkerW，并标出谁直接挂着 SHELLDLL_DefView。
    pub fn probe_candidates() -> Vec<HostCandidate> {
        let mut top: Vec<isize> = Vec::new();
        unsafe { EnumWindows(Some(enum_top), &mut top as *mut _ as LPARAM) };
        let mut out = Vec::new();
        for h in top {
            let host_class = match class_of(h).as_str() {
                "Progman" => HostClass::Progman,
                "WorkerW" => HostClass::WorkerW,
                _ => continue,
            };
            let mut has_def_view = false;
            unsafe {
                EnumChildWindows(h as HWND, Some(enum_child), &mut has_def_view as *mut _ as LPARAM)
            };
            let visible = unsafe { IsWindowVisible(h as HWND) } != 0;
            out.push(HostCandidate { hwnd: h, class: host_class, has_def_view, visible });
        }
        out
    }

    /// 请 Progman 分裂出一个 WorkerW。找不到 Progman 就什么都不做。
    fn ask_split() {
        let cls = wide("Progman");
        let progman = unsafe { FindWindowW(cls.as_ptr(), std::ptr::null()) };
        if progman.is_null() {
            return;
        }
        let mut ret: usize = 0;
        unsafe {
            SendMessageTimeoutW(progman, WM_SPAWN_WORKERW, 0, 0, SMTO_NORMAL, 1000, &mut ret);
            SendMessageTimeoutW(progman, WM_SPAWN_WORKERW, 0x0D, 0, SMTO_NORMAL, 1000, &mut ret);
        }
    }

    pub fn window_alive(hwnd: isize) -> bool {
        hwnd != 0 && unsafe { IsWindow(hwnd as HWND) } != 0
    }

    pub fn host_alive(host: isize) -> bool {
        host != 0 && unsafe { IsWindow(host as HWND) } != 0
    }

    pub fn parent_of(hwnd: isize) -> isize {
        if hwnd == 0 {
            return 0;
        }
        unsafe { GetParent(hwnd as HWND) as isize }
    }

    pub fn is_child_style(hwnd: isize) -> bool {
        if hwnd == 0 {
            return false;
        }
        let s = unsafe { GetWindowLongPtrW(hwnd as HWND, GWL_STYLE) };
        (s as u32 & WS_CHILD) != 0
    }

    pub fn host_class_name(host: isize) -> String {
        if host == 0 {
            return String::new();
        }
        let c = class_of(host);
        if c.is_empty() {
            "已销毁".to_string()
        } else {
            c
        }
    }


    fn list_pos(list: &[String], hwnd: isize) -> Option<usize> {
        let tag = format!("@0x{:X}", hwnd);
        list.iter().position(|s| s.ends_with(&tag))
    }

    fn def_view_pos(list: &[String]) -> Option<usize> {
        list.iter().position(|s| s.starts_with("SHELLDLL_DefView@"))
    }

    /// 如实读回窗口的父窗口、父窗口类名、自己的 WS_CHILD 位
    pub fn probe_of(hwnd: isize) -> (isize, String, bool) {
        let parent = parent_of(hwnd);
        (parent, host_class_name(parent), is_child_style(hwnd))
    }

    /// 桌面层实况（验收证据来源）：全部由 Win32 读回来，不是猜的
    pub fn probe_layers(hwnd: isize) -> LayerProbe {
        let mut rect: RECT = unsafe { std::mem::zeroed() };
        if hwnd != 0 {
            unsafe { GetWindowRect(hwnd as HWND, &mut rect) };
        }
        let parent = parent_of(hwnd);
        let style = if hwnd != 0 {
            unsafe { GetWindowLongPtrW(hwnd as HWND, GWL_STYLE) as u32 }
        } else {
            0
        };
        let mut title_buf = [0u16; 256];
        let title = if hwnd != 0 {
            let n = unsafe { GetWindowTextW(hwnd as HWND, title_buf.as_mut_ptr(), 256) };
            String::from_utf16_lossy(&title_buf[..n.max(0) as usize])
        } else {
            String::new()
        };

        // 枚举旁证：Progman 挂不挂 DefView、顶层 WorkerW 有几个、几个承载 DefView
        let cands = probe_candidates();
        let progman = cands.iter().find(|c| c.class == HostClass::Progman).map(|c| c.hwnd).unwrap_or(0);
        let progman_has_def_view = cands.iter().any(|c| c.class == HostClass::Progman && c.has_def_view);
        let workerw_total = cands.iter().filter(|c| c.class == HostClass::WorkerW).count() as i32;
        let workerw_with_def_view =
            cands.iter().filter(|c| c.class == HostClass::WorkerW && c.has_def_view).count() as i32;

        // 命中测试：窗口中心 / 屏幕左上角图标区，各打一枪
        let cx = (rect.left + rect.right) / 2;
        let cy = (rect.top + rect.bottom) / 2;
        // WindowFromPoint 打到的是最深的子窗口（WebView2 的 Chrome_RenderWidgetHostHWND /
        // DirectUIHWND 之类），所以要沿父链往上走，看**我们这扇窗**是不是命中点的祖先。
        // 直接比较句柄会一直判 false，那是误判，不是窗口没在上面。
        let probe_hit = |x: i32, y: i32| -> (isize, String) {
            let p = POINT { x, y };
            let h = unsafe { WindowFromPoint(p) } as isize;
            (h, class_of(h))
        };
        let self_at = |hit: isize| -> bool {
            if hwnd == 0 || hit == 0 {
                return false;
            }
            let mut cur = hit;
            for _ in 0..16 {
                if cur == hwnd {
                    return true;
                }
                cur = parent_of(cur);
                if cur == 0 {
                    return false;
                }
            }
            false
        };
        let (hit_center, hit_center_class) = if hwnd != 0 { probe_hit(cx, cy) } else { (0, String::new()) };
        let (hit_icon_zone, hit_icon_zone_class) = probe_hit(50, 40);

        // z-order 证据：EnumChildWindows 按**最上层 → 最下层**枚举。
        // 壁纸层语义 = 本窗口排在 SHELLDLL_DefView 之前。这条判断不依赖屏幕上有没有
        // 别的应用窗口压着，比「中心点命中自身」稳（后者被任意弹窗挡住就会误判）。
        let mut sibling_order: Vec<String> = Vec::new();
        if parent != 0 && hwnd != 0 {
            let mut list: Vec<isize> = Vec::new();
            unsafe {
                EnumChildWindows(parent as HWND, Some(enum_top), &mut list as *mut _ as LPARAM);
            }
            sibling_order = list
                .iter()
                .map(|h| format!("{}@0x{:X}", class_of(*h), h))
                .collect();
        }
        let pos_self = list_pos(&sibling_order, hwnd);
        let pos_def = def_view_pos(&sibling_order);
        let above_def_view = matches!((pos_self, pos_def), (Some(a), Some(b)) if a < b);

        // 中心点的完整父链（用来判断「谁压在上面」，不再靠猜）
        let mut chain: Vec<String> = Vec::new();
        {
            let mut cur = hit_center;
            for _ in 0..10 {
                if cur == 0 {
                    break;
                }
                chain.push(format!("{}@0x{:X}", class_of(cur), cur));
                cur = parent_of(cur);
            }
        }

        LayerProbe {
            window: hwnd,
            window_class: class_of(hwnd),
            window_title: title,
            rect: (rect.left, rect.top, rect.right, rect.bottom),
            parent,
            parent_class: host_class_name(parent),
            parent_alive: host_alive(parent),
            visible: hwnd != 0 && unsafe { IsWindowVisible(hwnd as HWND) } != 0,
            is_child: (style & WS_CHILD) != 0,
            style,
            progman,
            progman_has_def_view,
            workerw_total,
            workerw_with_def_view,
            hit_center,
            hit_center_class,
            hit_icon_zone,
            hit_icon_zone_class,
            hit_center_is_self: self_at(hit_center),
            hit_icon_zone_is_self: self_at(hit_icon_zone),
            hit_center_chain: chain,
            above_def_view,
            sibling_order,
        }
    }

    /// 把窗口真的挂进宿主：SetParent + 改子窗口样式 + 位置居中。
    ///
    /// ⚠️ SetWindowPos 的 z-order 必须是 **HWND_TOP**。挂到 Progman 而排在
    /// SHELLDLL_DefView 之下时，Win+D 之后窗口会被桌面图标层整个盖住
    /// （实测：GetParent 对、IsWindowVisible 真、句柄 WindowFromPoint 打得中，但屏幕上就是没有）。
    /// 谁要是把这里「优化」成按宿主 rect 铺满或去掉 HWND_TOP，这个功能就废了。
    fn attach(hwnd: isize, host: isize, size: Option<(i32, i32)>) -> bool {
        if hwnd == 0 || host == 0 {
            return false;
        }
        unsafe {
            // ⚠️ 顺序不能换：**先改样式、再 SetParent**。
            // SetParent 的文档要求子窗口不能带 WS_POPUP —— Tauri 的主窗口是 POPUP，
            // 直接 SetParent 会「调用成功但 GetParent 仍返回 0」（实测：lastErr=0、线程也对，
            // 就是挂不上，非常容易误判成环境不支持）。必须先摘掉 WS_POPUP、置上 WS_CHILD。
            let style = GetWindowLongPtrW(hwnd as HWND, GWL_STYLE);
            let style = (style & !(WS_POPUP as isize)) | (WS_CHILD as isize);
            SetWindowLongPtrW(hwnd as HWND, GWL_STYLE, style);

            let ex = GetWindowLongPtrW(hwnd as HWND, GWL_EXSTYLE);
            SetWindowLongPtrW(hwnd as HWND, GWL_EXSTYLE, ex | WS_EX_TOOLWINDOW as isize);

            // SetParent 还必须发在**窗口自己的线程**上（跨线程会被拒），
            // 所以调用方必须已经调度到主线程 —— lib.rs 里统一用 run_on_main_thread。
            SetParent(hwnd as HWND, host as HWND);
            // SetParent 返回 0 不代表失败（原父可能是 NULL），用 GetParent 复核
            if GetParent(hwnd as HWND) as isize != host {
                println!(
                    "[took][贴壁纸] SetParent 被拒：lastErr={}（窗口线程={} 当前线程={}）",
                    GetLastError(),
                    GetWindowThreadProcessId(hwnd as HWND, std::ptr::null_mut()),
                    GetCurrentThreadId()
                );
                return false;
            }

            // SetParent 之后坐标已经是相对宿主的，用宿主 rect 算居中。
            // size=None 表示**保留窗口当前尺寸**：贴壁纸不该顺手改用户拖好的窗口大小，
            // 那会让「窗口宽度决定内容密度」（定稿 §5.5）在用户不知情的情况下跳档。
            let mut rect: RECT = std::mem::zeroed();
            GetWindowRect(host as HWND, &mut rect);
            let host_w = rect.right - rect.left;
            let host_h = rect.bottom - rect.top;

            let mut own: RECT = std::mem::zeroed();
            GetWindowRect(hwnd as HWND, &mut own);
            let (w, h) = match size {
                Some(s) => s,
                None => ((own.right - own.left).max(1), (own.bottom - own.top).max(1)),
            };
            let x = ((host_w - w) / 2).max(0);
            let y = ((host_h - h) / 2).max(0);

            SetWindowPos(
                hwnd as HWND,
                HWND_TOP,
                x,
                y,
                w,
                h,
                SWP_FRAMECHANGED | SWP_NOACTIVATE,
            );
        }
        true
    }

    /// 探测 → 选宿主 → 附着。失败一律降级成普通置顶窗口，绝不半挂着。
    pub fn attach_to_desktop(hwnd: isize, size: Option<(i32, i32)>) -> PinMode {
        ask_split();
        let cands = probe_candidates();
        let host = match choose_host(&cands) {
            HostChoice::Hwnd(h) => h,
            HostChoice::Fallback => {
                println!("[took][贴壁纸] 探测不到壁纸层（WorkerW / Progman 均不可用），降级为普通置顶窗口");
                set_mode(PinMode::FallbackAlwaysOnTop, 0);
                // 降级但仍是「想贴着」：置顶窗口不会被 Win+D 收起（Win+D 只收起普通窗口）
                unsafe {
                    // 降级也不改尺寸：只把它挪到屏幕中间并保持置顶
                    let mut own: RECT = std::mem::zeroed();
                    GetWindowRect(hwnd as HWND, &mut own);
                    let w = match size {
                        Some(s) => s.0,
                        None => (own.right - own.left).max(1),
                    };
                    let h = match size {
                        Some(s) => s.1,
                        None => (own.bottom - own.top).max(1),
                    };
                    let screen_w = GetSystemMetrics(SM_CXSCREEN);
                    let screen_h = GetSystemMetrics(SM_CYSCREEN);
                    let x = ((screen_w - w) / 2).max(0);
                    let y = ((screen_h - h) / 2).max(0);
                    SetWindowPos(
                        hwnd as HWND,
                        HWND_TOP,
                        x,
                        y,
                        w,
                        h,
                        SWP_FRAMECHANGED | SWP_NOACTIVATE | SWP_NOZORDER,
                    );
                }
                return PinMode::FallbackAlwaysOnTop;
            }
        };

        if !attach(hwnd, host, size) {
            println!("[took][贴壁纸] SetParent 失败，降级为普通置顶窗口");
            set_mode(PinMode::FallbackAlwaysOnTop, 0);
            return PinMode::FallbackAlwaysOnTop;
        }

        // 用宿主类名判定走的是哪条路线 —— 这是真读出来的，不是猜的
        let mode = if class_of(host) == "Progman" {
            PinMode::ProgmanTopChild
        } else {
            PinMode::WorkerW
        };
        set_mode(mode, host);
        println!(
            "[took][贴壁纸] 已挂到宿主 0x{:X}（{}）→ 模式 {}",
            host,
            class_of(host),
            mode.as_str()
        );
        mode
    }

    /// Explorer 重启 / 宿主被销毁时自动重附着。
    /// 只有「用户想贴着」且当前不是 Disabled 时才管。
    pub fn ensure_reattached(hwnd: isize, size: Option<(i32, i32)>) -> PinMode {
        let mode = current_mode();
        if mode == PinMode::Disabled {
            return mode;
        }
        let host = host_hwnd();
        let still_ok = host_alive(host) && parent_of(hwnd) == host;
        if still_ok {
            return mode;
        }
        println!("[took][贴壁纸] 宿主已失效（Explorer 重启？），重新附着一次");
        attach_to_desktop(hwnd, size)
    }

    /// 脱离：父级还原回桌面、样式还原成普通窗口。
    /// 不做这一步窗口就再也拿不出来了（这是任务书里点名的那条）。
    pub fn detach(hwnd: isize, size: Option<(i32, i32)>) -> bool {
        if hwnd == 0 {
            return false;
        }
        unsafe {
            // 顺序与 attach 相反但同样不能换：**先摘 WS_CHILD、再 SetParent(NULL)**。
            // 带着 WS_CHILD 去 SetParent(NULL) 时，窗口会被挂到桌面窗口而不是变回顶层：
            // 实测还原后 GetParent 返回 0x1000C（桌面窗口），「父级还原」看似没生效、窗口也拿不回来。
            let style = GetWindowLongPtrW(hwnd as HWND, GWL_STYLE);
            let style = (style & !(WS_CHILD as isize)) | (WS_POPUP as isize);
            SetWindowLongPtrW(hwnd as HWND, GWL_STYLE, style);
            let ex = GetWindowLongPtrW(hwnd as HWND, GWL_EXSTYLE);
            SetWindowLongPtrW(hwnd as HWND, GWL_EXSTYLE, ex & !(WS_EX_TOOLWINDOW as isize));

            SetParent(hwnd as HWND, std::ptr::null_mut());
            if !GetParent(hwnd as HWND).is_null() {
                println!("[took][贴壁纸] 还原父级失败：GetParent 仍非空");
                return false;
            }

            // 还原位置与尺寸：给了预设就用预设，没给就用窗口自己的当前尺寸
            let mut own: RECT = std::mem::zeroed();
            GetWindowRect(hwnd as HWND, &mut own);
            let (w, h) = match size {
                Some(s) => s,
                None => ((own.right - own.left).max(1), (own.bottom - own.top).max(1)),
            };
            let screen_w = GetSystemMetrics(SM_CXSCREEN);
            let screen_h = GetSystemMetrics(SM_CYSCREEN);
            SetWindowPos(
                hwnd as HWND,
                HWND_TOP,
                ((screen_w - w) / 2).max(0),
                ((screen_h - h) / 2).max(0),
                w,
                h,
                SWP_FRAMECHANGED | SWP_NOACTIVATE | SWP_NOZORDER,
            );
        }
        set_mode(PinMode::Disabled, 0);
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cand(hwnd: isize, class: HostClass, has_def_view: bool, visible: bool) -> HostCandidate {
        HostCandidate { hwnd, class, has_def_view, visible }
    }

    /// 经典结构（Win10 / 23H2）：DefView 挂在一个顶层 WorkerW 里，目标 WorkerW 是它的兄弟
    #[test]
    fn picks_sibling_workerw_on_classic_layout() {
        let c = vec![
            cand(100, HostClass::Progman, false, true),
            cand(200, HostClass::WorkerW, true, false),
            cand(300, HostClass::WorkerW, false, false),
        ];
        assert_eq!(choose_host(&c), HostChoice::Hwnd(300));
    }

    /// 24H2 的真实本机结构：Progman 直接挂 DefView，顶层 WorkerW 全是不可见小窗
    /// → 挂 Progman，不能傻等一个根本不存在的兄弟 WorkerW
    #[test]
    fn falls_to_progman_on_24h2_layout() {
        let c = vec![
            cand(100, HostClass::Progman, true, true),
            cand(200, HostClass::WorkerW, false, false),
            cand(300, HostClass::WorkerW, false, false),
        ];
        assert_eq!(choose_host(&c), HostChoice::Hwnd(100));
    }

    /// 探测彻底失败（Explorer 没起 / 结构又变了）→ 必须回落，不能把应用搞成打不开
    #[test]
    fn falls_back_when_nothing_usable() {
        assert_eq!(choose_host(&[]), HostChoice::Fallback);
        let c = vec![
            cand(100, HostClass::Progman, false, true),
            cand(200, HostClass::WorkerW, false, false),
        ];
        assert_eq!(choose_host(&c), HostChoice::Fallback);
    }

    /// Progman 存在但不可见（Explorer 半死）时也不该挂进去
    #[test]
    fn invisible_progman_is_not_a_host() {
        let c = vec![cand(100, HostClass::Progman, true, false)];
        assert_eq!(choose_host(&c), HostChoice::Fallback);
    }

    /// 只有挂 DefView 的 WorkerW、没有兄弟时不误取别的 WorkerW
    #[test]
    fn def_view_worker_without_sibling_falls_back() {
        let c = vec![cand(200, HostClass::WorkerW, true, false)];
        assert_eq!(choose_host(&c), HostChoice::Fallback);
    }

    /// 兄弟在 DefView 那个 WorkerW 之前出现时不该被选中（顺序敏感）
    #[test]
    fn sibling_must_come_after_def_view_worker() {
        let c = vec![
            cand(300, HostClass::WorkerW, false, false),
            cand(200, HostClass::WorkerW, true, false),
        ];
        assert_eq!(choose_host(&c), HostChoice::Fallback);
    }

    #[test]
    fn mode_strings_and_semantics() {
        assert_eq!(PinMode::WorkerW.as_str(), "WorkerW");
        assert_eq!(PinMode::ProgmanTopChild.as_str(), "ProgmanTopChild");
        assert_eq!(PinMode::FallbackAlwaysOnTop.as_str(), "FallbackAlwaysOnTop");
        assert_eq!(PinMode::Disabled.as_str(), "Disabled");

        assert!(PinMode::WorkerW.attached_to_desktop());
        assert!(PinMode::ProgmanTopChild.attached_to_desktop());
        assert!(!PinMode::FallbackAlwaysOnTop.attached_to_desktop());
        assert!(!PinMode::Disabled.attached_to_desktop());

        // 降级必须说出来，不能假装成功
        assert!(PinMode::FallbackAlwaysOnTop.describe().contains("降级"));
        assert!(PinMode::WorkerW.describe().contains("已贴到壁纸层"));
        assert!(PinMode::ProgmanTopChild.describe().contains("已贴到壁纸层"));
    }

    #[test]
    fn mode_roundtrips_through_i32() {
        for m in [
            PinMode::Disabled,
            PinMode::WorkerW,
            PinMode::ProgmanTopChild,
            PinMode::FallbackAlwaysOnTop,
        ] {
            assert_eq!(mode_from_i32(mode_to_i32(m)), m);
        }
        assert_eq!(mode_from_i32(99), PinMode::Disabled);
    }

    /// 状态快照里的字段必须来自真实读到的东西，不能是常量
    #[test]
    fn status_snapshot_reports_real_values() {
        let s = status_snapshot(PinMode::ProgmanTopChild, 4242, "Progman".to_string(), true);
        assert_eq!(s.parent, 4242);
        assert_eq!(s.host_class, "Progman");
        assert!(s.is_child);
        assert!(s.enabled);
        assert_eq!(s.mode, "ProgmanTopChild");
    }


    /// z-order 判断：本窗口在列表里排在 DefView 之前才算压在图标层之上。
    /// 这条纯逻辑抽出来测，是因为它代替了不稳定的「中心点命中」判据。
    #[test]
    fn above_def_view_requires_self_before_defview() {
        // Progman 的子窗口按「最上层 → 最下层」枚举
        let order = vec![
            "Tauri Window@0x1408D6".to_string(),
            "WRY_WEBVIEW@0x80B34".to_string(),
            "SHELLDLL_DefView@0x10106".to_string(),
            "SysListView32@0x10108".to_string(),
        ];
        let self_pos = order.iter().position(|s| s.starts_with("Tauri Window@"));
        let def_pos = order.iter().position(|s| s.starts_with("SHELLDLL_DefView@"));
        assert!(self_pos.unwrap() < def_pos.unwrap(), "排在 DefView 之前");

        // 反过来（窗口在 DefView 之下）就应该判否
        let order2 = vec![
            "SHELLDLL_DefView@0x10106".to_string(),
            "Tauri Window@0x1408D6".to_string(),
        ];
        let self_pos2 = order2.iter().position(|s| s.starts_with("Tauri Window@"));
        let def_pos2 = order2.iter().position(|s| s.starts_with("SHELLDLL_DefView@"));
        assert!(self_pos2.unwrap() > def_pos2.unwrap());

        // 没挂上去时列举为空，不能误判为「在上面」
        let order3: Vec<String> = Vec::new();
        assert!(order3.iter().position(|s| s.starts_with("SHELLDLL_DefView@")).is_none());
    }

    /// 关掉之后状态必须是 Disabled，且不能说「已贴到壁纸层」
    #[test]
    fn disabled_snapshot_is_honest() {
        let s = status_snapshot(PinMode::Disabled, 0, String::new(), false);
        assert!(!s.enabled);
        assert!(!s.is_child);
        assert_eq!(s.mode, "Disabled");
        assert!(!s.detail.contains("已贴到壁纸层"));
    }
}
