//! 窗口外观三件事：整体透明度、收起成小三角、吸附边缘。
//!
//! 三条都是**真窗口行为**，不是页面里的假动作：
//!
//! - **透明度**：Win32 `WS_EX_LAYERED` + `SetLayeredWindowAttributes`。
//!   任务书假设 Tauri 2 有 `WebviewWindow::set_opacity(f64)` —— 实测没有：
//!   在 tauri 2.12.5 / tauri-runtime 2.12.2 / tauri-runtime-wry 2.12.3 / tao 0.37.1 /
//!   wry 0.57.0 的整棵依赖树里 grep -i opacity 命中 0 次。所以这一层自己走 Win32。
//!
//! - **收起**：把**窗口本身**缩成贴边的 26×48 小条，页面只渲染那个小三角。
//!   没有选「隐藏主窗 + 另开一个独立小窗」，理由是可验证的：贴壁纸把主窗 SetParent
//!   到 WorkerW 之后，宿主一销毁窗口会被系统连带销毁（lib.rs 里已有重建逻辑）；
//!   再挂一个小窗，每个生命周期分支都要复制一遍那套重建与重附着，漏一处就是
//!   「收起后再也展不开」。单窗口方案里收起只是改尺寸，没有新生命周期。
//!
//! - **吸附**：`WindowEvent::Moved` → 纯函数判边 → SetWindowPos 贴过去。
//!   判定逻辑（`snap_target`）是纯函数，不碰系统调用，所以能单元测试。

/// 透明度下限（%）。用户明确要求能调到 40，不许为了可读性偷偷抬到 80。
pub const OPACITY_MIN: u8 = 40;
/// 透明度上限（%）。
pub const OPACITY_MAX: u8 = 100;
/// 距屏幕边缘多少像素以内算「靠近」，触发吸附。
pub const SNAP_THRESHOLD: i32 = 20;
/// 收起后小条的尺寸（逻辑像素，照 prototype/pc.html 的 .snap-handle）。
pub const COLLAPSED_W: i32 = 26;
pub const COLLAPSED_H: i32 = 48;

/// 吸附到哪条边。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Edge {
    None,
    Left,
    Right,
    Top,
    Bottom,
}

impl Edge {
    /// 宽松解析：不认识的一律当 None（读旧数据用，不该因为脏数据就起不来）。
    pub fn parse(raw: &str) -> Edge {
        match raw.trim() {
            "left" => Edge::Left,
            "right" => Edge::Right,
            "top" => Edge::Top,
            "bottom" => Edge::Bottom,
            _ => Edge::None,
        }
    }

    /// 严格解析：设置页传进来的值必须是枚举里那五个，否则报错不静默。
    pub fn parse_strict(raw: &str) -> Result<Edge, String> {
        match raw.trim() {
            "none" => Ok(Edge::None),
            "left" => Ok(Edge::Left),
            "right" => Ok(Edge::Right),
            "top" => Ok(Edge::Top),
            "bottom" => Ok(Edge::Bottom),
            other => Err(format!(
                "吸附边缘只接受 none / left / right / top / bottom，收到：{other}"
            )),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Edge::None => "none",
            Edge::Left => "left",
            Edge::Right => "right",
            Edge::Top => "top",
            Edge::Bottom => "bottom",
        }
    }

    /// 收起时小条贴哪条边。未吸附时照原型落在右边（`snapHandle.dataset.edge = 'right'`）。
    pub fn handle_edge(self) -> Edge {
        if self == Edge::None { Edge::Right } else { self }
    }
}

/* ---------- 固定方式：贴壁纸 / 置顶 / 普通（三选一，互斥） ----------
   用户的诉求是「在设置旁边点一下就切，不用进设置页」。三种方式**互斥**：
   同一时刻只允许一种生效，切换时必须先把上一种的效果撤掉 —— 否则会出现
   「贴壁纸还挂着、同时又置顶」这种谁也说不清的状态。 */

/// 固定方式。持久化在 local_state 的 `pin_mode`。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum PinStyle {
    /// 贴桌面壁纸层（Win32 SetParent 到 WorkerW / Progman）
    Wallpaper,
    /// 置顶窗口（WS_EX_TOPMOST）
    Top,
    /// 普通窗口（两者都不）
    Normal,
}

impl PinStyle {
    /// 宽松解析：读旧数据用，脏值一律当普通窗口（不该因为脏数据就起不来）。
    pub fn parse(raw: &str) -> PinStyle {
        match raw.trim() {
            "wallpaper" => PinStyle::Wallpaper,
            "top" => PinStyle::Top,
            _ => PinStyle::Normal,
        }
    }

    /// 严格解析：命令传进来的值必须是这三个之一，否则报错不静默。
    pub fn parse_strict(raw: &str) -> Result<PinStyle, String> {
        match raw.trim() {
            "wallpaper" => Ok(PinStyle::Wallpaper),
            "top" => Ok(PinStyle::Top),
            "normal" => Ok(PinStyle::Normal),
            other => Err(format!(
                "固定方式只接受 wallpaper / top / normal，收到：{other}"
            )),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            PinStyle::Wallpaper => "wallpaper",
            PinStyle::Top => "top",
            PinStyle::Normal => "normal",
        }
    }

    /// 按钮上显示的两个字（与设置页同一个口径，不各写一套文案）。
    pub fn label_cn(self) -> &'static str {
        match self {
            PinStyle::Wallpaper => "贴壁纸",
            PinStyle::Top => "置顶",
            PinStyle::Normal => "普通",
        }
    }
}

/// 一种固定方式要落到窗口上的两件事。两件都是 bool，互斥关系由 `plan_for` 一处决定。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct PinPlan {
    /// 是否把窗口挂到桌面壁纸层
    pub wallpaper: bool,
    /// 是否把窗口置顶
    pub always_on_top: bool,
}

/// **互斥表**：三选一，任何一种方式都不会同时点亮两件事。
pub fn plan_for(style: PinStyle) -> PinPlan {
    match style {
        PinStyle::Wallpaper => PinPlan { wallpaper: true, always_on_top: false },
        PinStyle::Top => PinPlan { wallpaper: false, always_on_top: true },
        PinStyle::Normal => PinPlan { wallpaper: false, always_on_top: false },
    }
}

/// 固定方式的持久化键（与 `wallpaper_pin` 同一张 local_state 表，没有第二套配置系统）
pub const PIN_MODE_KEY: &str = "pin_mode";

/// 解析「当前该用哪种固定方式」。
///
/// `pin_mode` 是新键；老版本只存了 `wallpaper_pin`（开 / 关）。升级上来的库没有
/// `pin_mode`，这时按老键回落：开着 → 贴壁纸，关着 → 普通。**不做一次性迁移写盘**，
/// 因为读路径要保持只读；真正落库发生在第一次切换或启动恢复时。
pub fn resolve_style(stored: Option<&str>, wallpaper_enabled: bool) -> PinStyle {
    match stored.map(str::trim) {
        Some(v) if !v.is_empty() => PinStyle::parse(v),
        _ => {
            if wallpaper_enabled {
                PinStyle::Wallpaper
            } else {
                PinStyle::Normal
            }
        }
    }
}

/// 读库里的固定方式（旧库回落到 `wallpaper_pin`）。
pub fn stored_pin_style(db: &crate::db::Db, wallpaper_enabled: bool) -> PinStyle {
    let stored = db.get_state(PIN_MODE_KEY).ok().flatten();
    resolve_style(stored.as_deref(), wallpaper_enabled)
}

/// 落库。命令与启动恢复都走这一条。
pub fn save_pin_style(db: &crate::db::Db, style: PinStyle) -> Result<(), String> {
    db.set_state(PIN_MODE_KEY, style.as_str())
}

/// 启动恢复：读库 → 给出「用哪种方式」与「要应用的两件事」。
///
/// 单独抽成纯函数是为了能在单元测试里证明恢复逻辑（真窗口恢复由 lib.rs 调）。
pub fn restore_plan(db: &crate::db::Db, wallpaper_enabled: bool) -> (PinStyle, PinPlan) {
    let style = stored_pin_style(db, wallpaper_enabled);
    (style, plan_for(style))
}

/// 夹取透明度。越界**报错**，不静默改数 —— 前端滑块被绕过时用户要能看到原因。
pub fn clamp_opacity(v: i32) -> Result<u8, String> {
    if v < OPACITY_MIN as i32 || v > OPACITY_MAX as i32 {
        return Err(format!(
            "透明度 {v}% 越界：只接受 {OPACITY_MIN}~{OPACITY_MAX}%"
        ));
    }
    Ok(v as u8)
}

/// 屏幕上的一个矩形（物理像素，左上角原点）。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

impl Rect {
    pub fn new(x: i32, y: i32, w: i32, h: i32) -> Rect {
        Rect { x, y, w, h }
    }
    pub fn right(&self) -> i32 {
        self.x + self.w
    }
    pub fn bottom(&self) -> i32 {
        self.y + self.h
    }
}

/// 判断窗口是否已经贴到指定边，返回**吸附后应该落到的左上角**。
///
/// 纯函数：只吃两个矩形，不读系统状态，所以每条分支都能单元测试。
/// 判定口径是「窗口边缘到屏幕边缘的距离」；窗口已经越界（负距离）同样算贴边。
/// 未吸附（`Edge::None`）或距离超阈值时返回 `None`，调用方据此不动窗口。
pub fn snap_target(edge: Edge, win: Rect, screen: Rect) -> Option<(i32, i32)> {
    let gap_left = win.x - screen.x;
    let gap_right = screen.right() - win.right();
    let gap_top = win.y - screen.y;
    let gap_bottom = screen.bottom() - win.bottom();
    let near = |gap: i32| gap.abs() <= SNAP_THRESHOLD;

    match edge {
        Edge::None => None,
        Edge::Left if near(gap_left) => Some((screen.x, win.y)),
        Edge::Right if near(gap_right) => Some((screen.right() - win.w, win.y)),
        Edge::Top if near(gap_top) => Some((win.x, screen.y)),
        Edge::Bottom if near(gap_bottom) => Some((win.x, screen.bottom() - win.h)),
        _ => None,
    }
}

/* ---------- 收起 / 展开的过渡动画 ---------- */

/// 过渡总时长（毫秒）。用户要求「像抽屉滑入滑出」，一步到位被明确否决。
pub const ANIM_MS: u64 = 200;
/// 每帧间隔（毫秒），约 60fps。
pub const ANIM_FRAME_MS: u64 = 16;

/// ease-out 缓动（三次方）：先快后慢，收尾自然。
pub fn ease_out(t: f64) -> f64 {
    let t = t.clamp(0.0, 1.0);
    1.0 - (1.0 - t).powi(3)
}

/// 在 from 与 to 之间按进度 p（0~1，**已缓动**）插值出这一帧的矩形。
/// 纯函数：不碰系统调用，所以能单元测试。
pub fn lerp_rect(from: Rect, to: Rect, p: f64) -> Rect {
    let p = p.clamp(0.0, 1.0);
    let mix = |a: i32, b: i32| a + (((b - a) as f64) * p).round() as i32;
    Rect::new(
        mix(from.x, to.x),
        mix(from.y, to.y),
        mix(from.w, to.w),
        mix(from.h, to.h),
    )
}

/// 一次过渡的逐帧矩形序列。**最后一帧精确等于 to**（不受取整影响）。
///
/// 纯函数：验收要的「收起过程中至少 3 个不同的中间宽度」就是拿它算出来的，
/// 不需要真窗口也能断言。
pub fn anim_frames(from: Rect, to: Rect, total_ms: u64) -> Vec<Rect> {
    let total = if total_ms == 0 { ANIM_MS } else { total_ms };
    let n = (total / ANIM_FRAME_MS).max(1);
    (1..=n)
        .map(|i| {
            if i == n {
                to
            } else {
                lerp_rect(from, to, ease_out(i as f64 / n as f64))
            }
        })
        .collect()
}

/// 收起 / 展开的状态机。
///
/// 两条不变量：
/// 1. **幂等**：重复收起不会用「已经缩小的尺寸」覆盖掉保存的原尺寸；
/// 2. **重启即展开**：`collapsed` 不跨进程恢复（见 lib.rs 的启动恢复），
///    否则用户重开就只看到一个小三角，会以为程序坏了。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub struct CollapseState {
    pub collapsed: bool,
    pub saved: Option<Rect>,
}

impl CollapseState {
    pub fn new() -> CollapseState {
        CollapseState::default()
    }

    /// 收起。返回**要应用到窗口上的矩形**；已经在收起态时返回 `None`（不改任何东西）。
    ///
    /// `scale` 是窗口的 DPI 缩放：26×48 是逻辑像素，SetWindowPos 吃物理像素。
    pub fn collapse(
        &mut self,
        current: Rect,
        edge: Edge,
        screen: Rect,
        scale: f64,
    ) -> Option<Rect> {
        if self.collapsed {
            return None;
        }
        let s = if scale > 0.0 { scale } else { 1.0 };
        let w = ((COLLAPSED_W as f64) * s).round().max(1.0) as i32;
        let h = ((COLLAPSED_H as f64) * s).round().max(1.0) as i32;
        let (x, y) = match edge.handle_edge() {
            Edge::Left => (screen.x, screen.y + (screen.h - h) / 2),
            Edge::Top => (screen.x + (screen.w - w) / 2, screen.y),
            Edge::Bottom => (
                screen.x + (screen.w - w) / 2,
                screen.bottom() - h,
            ),
            // Right 以及一切兜底
            _ => (screen.right() - w, screen.y + (screen.h - h) / 2),
        };
        self.saved = Some(current);
        self.collapsed = true;
        Some(Rect::new(x, y, w, h))
    }

    /// 展开。返回要恢复的矩形；本来就没收起时返回 `None`。
    pub fn expand(&mut self) -> Option<Rect> {
        if !self.collapsed {
            return None;
        }
        self.collapsed = false;
        self.saved.take()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn screen() -> Rect {
        Rect::new(0, 0, 1920, 1080)
    }

    /* ---------- 透明度 ---------- */

    #[test]
    fn opacity_accepts_the_whole_range() {
        assert_eq!(clamp_opacity(40).unwrap(), 40);
        assert_eq!(clamp_opacity(100).unwrap(), 100);
        assert_eq!(clamp_opacity(65).unwrap(), 65);
    }

    #[test]
    fn opacity_rejects_out_of_range_instead_of_clamping() {
        // 任务书要求「越界报错不静默」，所以不是夹到 40/100，而是 Err
        assert!(clamp_opacity(39).is_err());
        assert!(clamp_opacity(0).is_err());
        assert!(clamp_opacity(101).is_err());
        assert!(clamp_opacity(-5).is_err());
        let e = clamp_opacity(20).unwrap_err();
        assert!(e.contains("40") && e.contains("100"), "错误里要写明范围：{e}");
    }

    /* ---------- 吸附判定 ---------- */

    #[test]
    fn snap_left_hits_inside_threshold() {
        let win = Rect::new(12, 300, 800, 600);
        assert_eq!(snap_target(Edge::Left, win, screen()), Some((0, 300)));
    }

    #[test]
    fn snap_left_misses_beyond_threshold() {
        let win = Rect::new(21, 300, 800, 600);
        assert_eq!(snap_target(Edge::Left, win, screen()), None);
        let far = Rect::new(400, 300, 800, 600);
        assert_eq!(snap_target(Edge::Left, far, screen()), None);
    }

    #[test]
    fn snap_right_uses_right_edge_gap() {
        // 1920 - (1120 + 790) = 10 → 贴右边
        let win = Rect::new(1120, 200, 790, 600);
        assert_eq!(snap_target(Edge::Right, win, screen()), Some((1130, 200)));
        // 离右边很远 → 不动，即使它贴着左边（Left 才管左）
        let left = Rect::new(0, 200, 790, 600);
        assert_eq!(snap_target(Edge::Right, left, screen()), None);
    }

    #[test]
    fn snap_top_and_bottom() {
        let top = Rect::new(500, 8, 800, 600);
        assert_eq!(snap_target(Edge::Top, top, screen()), Some((500, 0)));
        // 1080 - (470 + 600) = 10 → 贴底
        let bottom = Rect::new(500, 470, 800, 600);
        assert_eq!(snap_target(Edge::Bottom, bottom, screen()), Some((500, 480)));
    }

    #[test]
    fn snap_never_moves_when_edge_is_none() {
        let win = Rect::new(0, 0, 800, 600);
        assert_eq!(snap_target(Edge::None, win, screen()), None);
    }

    #[test]
    fn snap_treats_overshoot_as_near() {
        // 拖动时可能一帧就越过了边界（负距离），同样要吸回去
        let win = Rect::new(-9, 300, 800, 600);
        assert_eq!(snap_target(Edge::Left, win, screen()), Some((0, 300)));
    }

    #[test]
    fn snap_threshold_is_twenty_pixels() {
        assert_eq!(SNAP_THRESHOLD, 20);
        let inside = Rect::new(20, 300, 800, 600);
        let outside = Rect::new(21, 300, 800, 600);
        assert!(snap_target(Edge::Left, inside, screen()).is_some());
        assert!(snap_target(Edge::Left, outside, screen()).is_none());
    }

    /* ---------- 收起 / 展开状态机 ---------- */

    #[test]
    fn collapse_shrinks_to_handle_size_and_remembers_original() {
        let mut st = CollapseState::new();
        let original = Rect::new(300, 200, 1280, 900);
        let got = st.collapse(original, Edge::Right, screen(), 1.0).unwrap();
        assert_eq!((got.w, got.h), (COLLAPSED_W, COLLAPSED_H));
        // 贴右边、垂直居中
        assert_eq!(got.x, 1920 - COLLAPSED_W);
        assert_eq!(got.y, (1080 - COLLAPSED_H) / 2);
        assert!(st.collapsed);
        assert_eq!(st.saved, Some(original));
    }

    #[test]
    fn collapse_is_idempotent_and_keeps_the_first_saved_rect() {
        let mut st = CollapseState::new();
        let original = Rect::new(300, 200, 1280, 900);
        st.collapse(original, Edge::Left, screen(), 1.0).unwrap();
        // 第二次收起：窗口已经只有 26×48，绝不能把它当成「原尺寸」存下来
        let again = st.collapse(Rect::new(0, 500, COLLAPSED_W, COLLAPSED_H), Edge::Left, screen(), 1.0);
        assert_eq!(again, None);
        assert_eq!(st.saved, Some(original));
    }

    #[test]
    fn expand_restores_exactly_what_was_saved() {
        let mut st = CollapseState::new();
        let original = Rect::new(300, 200, 1280, 900);
        st.collapse(original, Edge::Top, screen(), 1.0).unwrap();
        assert_eq!(st.expand(), Some(original));
        assert!(!st.collapsed);
        assert_eq!(st.saved, None);
    }

    #[test]
    fn expand_when_not_collapsed_is_a_no_op() {
        let mut st = CollapseState::new();
        assert_eq!(st.expand(), None);
        assert!(!st.collapsed);
    }

    #[test]
    fn collapse_round_trip_is_stable_across_dpi_scales() {
        for scale in [1.0_f64, 1.25, 1.5, 2.0] {
            let mut st = CollapseState::new();
            let original = Rect::new(100, 100, 1280, 900);
            let got = st.collapse(original, Edge::Right, screen(), scale).unwrap();
            assert_eq!(got.w, ((COLLAPSED_W as f64) * scale).round() as i32, "scale={scale}");
            assert_eq!(got.h, ((COLLAPSED_H as f64) * scale).round() as i32, "scale={scale}");
            assert_eq!(st.expand(), Some(original));
        }
    }

    #[test]
    fn collapse_without_snap_lands_on_the_right_edge_like_the_prototype() {
        let mut st = CollapseState::new();
        let got = st.collapse(Rect::new(300, 200, 1280, 900), Edge::None, screen(), 1.0).unwrap();
        assert_eq!(got.x, 1920 - COLLAPSED_W);
    }

    /* ---------- 收起 / 展开的过渡动画 ---------- */

    #[test]
    fn ease_out_starts_at_zero_ends_at_one_and_is_monotonic() {
        assert_eq!(ease_out(0.0), 0.0);
        assert_eq!(ease_out(1.0), 1.0);
        // 越界一律夹到端点，不产生飞出屏幕的帧
        assert_eq!(ease_out(-3.0), 0.0);
        assert_eq!(ease_out(9.0), 1.0);
        let mut prev = -1.0;
        for i in 0..=20 {
            let v = ease_out(i as f64 / 20.0);
            assert!(v >= prev, "缓动必须单调不减：{prev} → {v}");
            prev = v;
        }
        // ease-out 是「先快后慢」：中点已经走完一半以上
        assert!(ease_out(0.5) > 0.5, "ease-out 中点应过半，实测 {}", ease_out(0.5));
    }

    #[test]
    fn lerp_rect_hits_both_ends_exactly() {
        let a = Rect::new(300, 200, 1280, 900);
        let b = Rect::new(1894, 516, 26, 48);
        assert_eq!(lerp_rect(a, b, 0.0), a);
        assert_eq!(lerp_rect(a, b, 1.0), b);
        let mid = lerp_rect(a, b, 0.5);
        assert!(mid.w < a.w && mid.w > b.w, "中点宽度应在两端之间：{mid:?}");
        // 越界进度不越界
        assert_eq!(lerp_rect(a, b, -1.0), a);
        assert_eq!(lerp_rect(a, b, 2.0), b);
    }

    #[test]
    fn anim_frames_produce_many_intermediate_sizes_and_land_exactly() {
        let from = Rect::new(300, 200, 1280, 900);
        let to = Rect::new(1894, 516, 26, 48);
        let frames = anim_frames(from, to, ANIM_MS);
        assert!(frames.len() >= 8, "200ms / 16ms 应产生 ≥8 帧，实测 {}", frames.len());
        // 最后一帧必须精确落到目标，不能差一两个像素
        assert_eq!(*frames.last().unwrap(), to);
        // 第一帧必须已经开始动（不是等 200ms 再一步到位）
        assert!(frames[0].w < from.w && frames[0].w > to.w, "首帧应在两端之间：{:?}", frames[0]);
        // 验收口径：至少 3 个不同的中间宽度
        let mut widths: Vec<i32> = frames.iter().map(|r| r.w).collect();
        widths.dedup();
        let mut uniq = widths.clone();
        uniq.sort_unstable();
        uniq.dedup();
        assert!(uniq.len() >= 3, "中间宽度至少 3 个不同值，实测 {uniq:?}");
    }

    #[test]
    fn anim_frames_is_monotonic_towards_the_target() {
        let from = Rect::new(0, 0, 1280, 900);
        let to = Rect::new(1894, 516, 26, 48);
        let frames = anim_frames(from, to, ANIM_MS);
        let mut prev_w = from.w;
        for f in &frames {
            assert!(f.w <= prev_w, "宽度必须单调收缩：{prev_w} → {}", f.w);
            prev_w = f.w;
        }
        // 展开是反向：宽度单调增大
        let back = anim_frames(to, from, ANIM_MS);
        let mut prev_w = to.w;
        for f in &back {
            assert!(f.w >= prev_w, "展开时宽度必须单调增大：{prev_w} → {}", f.w);
            prev_w = f.w;
        }
    }

    #[test]
    fn anim_frames_of_zero_duration_still_lands_on_the_target() {
        let from = Rect::new(0, 0, 1280, 900);
        let to = Rect::new(1894, 516, 26, 48);
        let frames = anim_frames(from, to, 0);
        assert!(!frames.is_empty());
        assert_eq!(*frames.last().unwrap(), to);
    }

    #[test]
    fn edge_parsing_is_strict_for_commands_and_lenient_for_storage() {
        assert_eq!(Edge::parse_strict("left").unwrap(), Edge::Left);
        assert!(Edge::parse_strict("diagonal").is_err());
        // 读库走宽松解析：脏数据不该让程序起不来
        assert_eq!(Edge::parse("diagonal"), Edge::None);
        assert_eq!(Edge::parse(""), Edge::None);
        assert_eq!(Edge::parse("bottom"), Edge::Bottom);
        assert_eq!(Edge::Left.as_str(), "left");
    }

    /* ---------- 固定方式：三模式互斥 / 持久化 / 启动恢复 ---------- */

    #[test]
    fn pin_styles_are_mutually_exclusive() {
        // 三种方式各自只点亮一件事，任何两种都不会重叠 —— 这就是「互斥」的可执行定义
        let w = plan_for(PinStyle::Wallpaper);
        let t = plan_for(PinStyle::Top);
        let n = plan_for(PinStyle::Normal);
        assert_eq!(w, PinPlan { wallpaper: true, always_on_top: false });
        assert_eq!(t, PinPlan { wallpaper: false, always_on_top: true });
        assert_eq!(n, PinPlan { wallpaper: false, always_on_top: false });
        for p in [w, t, n] {
            assert!(!(p.wallpaper && p.always_on_top), "两种效果不许同时生效：{p:?}");
        }
    }

    #[test]
    fn pin_style_parsing_is_strict_for_commands_and_lenient_for_storage() {
        assert_eq!(PinStyle::parse_strict("wallpaper").unwrap(), PinStyle::Wallpaper);
        assert_eq!(PinStyle::parse_strict("top").unwrap(), PinStyle::Top);
        assert_eq!(PinStyle::parse_strict("normal").unwrap(), PinStyle::Normal);
        let e = PinStyle::parse_strict("topmost").unwrap_err();
        assert!(e.contains("wallpaper") && e.contains("top") && e.contains("normal"), "{e}");
        // 读库走宽松解析：脏数据当普通窗口，不让程序起不来
        assert_eq!(PinStyle::parse("garbage"), PinStyle::Normal);
        assert_eq!(PinStyle::parse(""), PinStyle::Normal);
        assert_eq!(PinStyle::parse(" top "), PinStyle::Top);
    }

    #[test]
    fn pin_style_labels_match_the_button_text() {
        // 按钮上显示的两个字，与设置页同一个口径
        assert_eq!(PinStyle::Wallpaper.label_cn(), "贴壁纸");
        assert_eq!(PinStyle::Top.label_cn(), "置顶");
        assert_eq!(PinStyle::Normal.label_cn(), "普通");
        assert_eq!(PinStyle::Wallpaper.as_str(), "wallpaper");
        assert_eq!(PinStyle::Top.as_str(), "top");
        assert_eq!(PinStyle::Normal.as_str(), "normal");
    }

    #[test]
    fn pin_mode_persists_and_round_trips_through_the_db() {
        let db = crate::db::Db::open_in_memory().expect("内存库");
        // 老库没有 pin_mode：按 wallpaper_pin 回落（默认开 → 贴壁纸）
        assert_eq!(stored_pin_style(&db, true), PinStyle::Wallpaper);
        assert_eq!(stored_pin_style(&db, false), PinStyle::Normal);
        // 写进去再读回来，三种都要原样
        for style in [PinStyle::Top, PinStyle::Normal, PinStyle::Wallpaper] {
            save_pin_style(&db, style).expect("落库");
            assert_eq!(db.get_state(PIN_MODE_KEY).unwrap().as_deref(), Some(style.as_str()));
            // 一旦存过 pin_mode，就以它为准，不再看 wallpaper_pin 的旧值
            assert_eq!(stored_pin_style(&db, !matches!(style, PinStyle::Wallpaper)), style);
        }
    }

    #[test]
    fn startup_restore_follows_pin_mode_then_falls_back_to_the_legacy_key() {
        let db = crate::db::Db::open_in_memory().expect("内存库");
        // 1) 新库 + 老键开着 → 恢复成贴壁纸
        assert_eq!(restore_plan(&db, true).0, PinStyle::Wallpaper);
        assert_eq!(restore_plan(&db, true).1, plan_for(PinStyle::Wallpaper));
        // 2) 新库 + 老键关着 → 恢复成普通
        assert_eq!(restore_plan(&db, false).0, PinStyle::Normal);
        assert_eq!(restore_plan(&db, false).1, plan_for(PinStyle::Normal));
        // 3) 存过「置顶」→ 启动就恢复置顶，且不再贴壁纸（互斥）
        save_pin_style(&db, PinStyle::Top).expect("落库");
        let (style, plan) = restore_plan(&db, true);
        assert_eq!(style, PinStyle::Top);
        assert_eq!(plan, PinPlan { wallpaper: false, always_on_top: true });
        assert!(!plan.wallpaper, "从贴壁纸切到置顶后，启动恢复不许还挂着壁纸层");
    }
}

/* ============================================================================
   Win32 落地层
   ============================================================================
   非 Windows 平台保留同名函数（返回 Err），这样 lib.rs 的命令签名不用 cfg 分叉，
   前端读到的错误信息也是真的（「此平台不支持」），不是静默成功。 */

/// 把透明度作用到真窗口。`pct` 已在调用方夹取过。
#[cfg(windows)]
pub fn apply_opacity(hwnd: isize, pct: u8) -> Result<(), String> {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetWindowLongPtrW, SetLayeredWindowAttributes, SetWindowLongPtrW, GWL_EXSTYLE, LWA_ALPHA,
        WS_EX_LAYERED,
    };
    if hwnd == 0 {
        return Err("拿不到主窗口句柄，透明度没有应用".into());
    }
    unsafe {
        let hwnd = hwnd as windows_sys::Win32::Foundation::HWND;
        // WS_EX_LAYERED 是 SetLayeredWindowAttributes 的前置条件，没有它调用会失败（err=87）。
        let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32;
        if ex & WS_EX_LAYERED == 0 {
            SetWindowLongPtrW(hwnd, GWL_EXSTYLE, (ex | WS_EX_LAYERED) as isize);
        }
        // 100% 也要显式设成 255：用户从 40 拖回 100 时得真的恢复不透明。
        let alpha = ((pct as u32 * 255) / 100) as u8;
        let ok = SetLayeredWindowAttributes(hwnd, 0, alpha, LWA_ALPHA);
        if ok == 0 {
            return Err(format!(
                "SetLayeredWindowAttributes 失败，GetLastError={}",
                windows_sys::Win32::Foundation::GetLastError()
            ));
        }
    }
    Ok(())
}

#[cfg(not(windows))]
pub fn apply_opacity(_hwnd: isize, _pct: u8) -> Result<(), String> {
    Err("此平台不支持窗口透明度（仅 Windows）".into())
}

/// 读回真窗口当前的不透明度（0~255）。验收脚本用它证明「真的变了」而不是只改了 DOM。
#[cfg(windows)]
pub fn read_opacity(hwnd: isize) -> Result<u8, String> {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetLayeredWindowAttributes, GetWindowLongPtrW, GWL_EXSTYLE, WS_EX_LAYERED,
    };
    if hwnd == 0 {
        return Err("拿不到主窗口句柄".into());
    }
    unsafe {
        let hwnd = hwnd as windows_sys::Win32::Foundation::HWND;
        let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32;
        if ex & WS_EX_LAYERED == 0 {
            return Err("窗口没有 WS_EX_LAYERED，说明透明度从未被应用".into());
        }
        let mut alpha: u8 = 0;
        let mut flags = 0u32;
        let ok = GetLayeredWindowAttributes(hwnd, std::ptr::null_mut(), &mut alpha, &mut flags);
        if ok == 0 {
            return Err(format!(
                "GetLayeredWindowAttributes 失败，GetLastError={}",
                windows_sys::Win32::Foundation::GetLastError()
            ));
        }
        Ok(alpha)
    }
}

#[cfg(not(windows))]
pub fn read_opacity(_hwnd: isize) -> Result<u8, String> {
    Err("此平台不支持窗口透明度（仅 Windows）".into())
}

/// 把窗口置顶 / 取消置顶。
///
/// 走 `SetWindowPos(HWND_TOPMOST / HWND_NOTOPMOST)`，不走 Tauri 的
/// `set_always_on_top`：验收要的是 `GWL_EXSTYLE` 里的 `WS_EX_TOPMOST` 位，
/// 这两条系统调用改的是同一个位，读回来的值与系统一致。贴壁纸把窗口
/// SetParent 成子窗口之后，Tauri 那套窗口语义会变，Win32 直调没有这个问题。
#[cfg(windows)]
pub fn apply_always_on_top(hwnd: isize, on: bool) -> Result<(), String> {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        SetWindowPos, HWND_NOTOPMOST, HWND_TOPMOST, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE,
    };
    if hwnd == 0 {
        return Err("拿不到主窗口句柄，置顶没有应用".into());
    }
    unsafe {
        let after = if on { HWND_TOPMOST } else { HWND_NOTOPMOST };
        let ok = SetWindowPos(
            hwnd as windows_sys::Win32::Foundation::HWND,
            after,
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
        );
        if ok == 0 {
            return Err(format!(
                "SetWindowPos(置顶={on}) 失败，GetLastError={}",
                windows_sys::Win32::Foundation::GetLastError()
            ));
        }
    }
    Ok(())
}

#[cfg(not(windows))]
pub fn apply_always_on_top(_hwnd: isize, _on: bool) -> Result<(), String> {
    Err("此平台不支持窗口置顶（仅 Windows）".into())
}

/// 读回真窗口的 `WS_EX_TOPMOST` 位。验收脚本与设置页都读它 —— 不是前端猜的状态。
#[cfg(windows)]
pub fn read_always_on_top(hwnd: isize) -> Result<bool, String> {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetWindowLongPtrW, GWL_EXSTYLE, WS_EX_TOPMOST,
    };
    if hwnd == 0 {
        return Err("拿不到主窗口句柄".into());
    }
    unsafe {
        let ex = GetWindowLongPtrW(
            hwnd as windows_sys::Win32::Foundation::HWND,
            GWL_EXSTYLE,
        ) as u32;
        Ok(ex & WS_EX_TOPMOST != 0)
    }
}

#[cfg(not(windows))]
pub fn read_always_on_top(_hwnd: isize) -> Result<bool, String> {
    Err("此平台不支持窗口置顶（仅 Windows）".into())
}

/// 读窗口在屏幕上的物理矩形。
#[cfg(windows)]
pub fn window_rect(hwnd: isize) -> Result<Rect, String> {
    use windows_sys::Win32::Foundation::RECT;
    use windows_sys::Win32::UI::WindowsAndMessaging::GetWindowRect;
    if hwnd == 0 {
        return Err("拿不到主窗口句柄".into());
    }
    unsafe {
        let mut r: RECT = std::mem::zeroed();
        if GetWindowRect(hwnd as windows_sys::Win32::Foundation::HWND, &mut r) == 0 {
            return Err("GetWindowRect 失败".into());
        }
        Ok(Rect::new(r.left, r.top, r.right - r.left, r.bottom - r.top))
    }
}

#[cfg(not(windows))]
pub fn window_rect(_hwnd: isize) -> Result<Rect, String> {
    Err("此平台不支持窗口矩形读取（仅 Windows）".into())
}

/// 窗口所在显示器的**工作区**（不含任务栏）。多显示器时取离窗口最近的那块。
#[cfg(windows)]
pub fn monitor_work_area(hwnd: isize) -> Rect {
    use windows_sys::Win32::Foundation::RECT;
    use windows_sys::Win32::Graphics::Gdi::{
        GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST,
    };
    unsafe {
        let mon = MonitorFromWindow(hwnd as windows_sys::Win32::Foundation::HWND, MONITOR_DEFAULTTONEAREST);
        if mon.is_null() {
            return Rect::new(0, 0, 1920, 1080);
        }
        let mut mi: MONITORINFO = std::mem::zeroed();
        mi.cbSize = std::mem::size_of::<MONITORINFO>() as u32;
        if GetMonitorInfoW(mon, &mut mi) == 0 {
            return Rect::new(0, 0, 1920, 1080);
        }
        let RECT { left, top, right, bottom } = mi.rcWork;
        Rect::new(left, top, right - left, bottom - top)
    }
}

#[cfg(not(windows))]
pub fn monitor_work_area(_hwnd: isize) -> Rect {
    Rect::new(0, 0, 1920, 1080)
}

/// 把窗口挪到/缩到指定矩形（物理像素）。
#[cfg(windows)]
pub fn place_window(hwnd: isize, r: Rect) -> Result<(), String> {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        SetWindowPos, SWP_NOACTIVATE, SWP_NOZORDER,
    };
    if hwnd == 0 {
        return Err("拿不到主窗口句柄".into());
    }
    unsafe {
        let ok = SetWindowPos(
            hwnd as windows_sys::Win32::Foundation::HWND,
            std::ptr::null_mut(),
            r.x,
            r.y,
            r.w,
            r.h,
            // 不改 z-order：贴壁纸层由 wallpaper.rs 管，这里乱动会把窗口压到壁纸后面
            SWP_NOZORDER | SWP_NOACTIVATE,
        );
        if ok == 0 {
            return Err(format!(
                "SetWindowPos 失败，GetLastError={}",
                windows_sys::Win32::Foundation::GetLastError()
            ));
        }
    }
    Ok(())
}

#[cfg(not(windows))]
pub fn place_window(_hwnd: isize, _r: Rect) -> Result<(), String> {
    Err("此平台不支持移动窗口（仅 Windows）".into())
}

/// 分帧把窗口从 from 挪到 to：每帧一次 SetWindowPos，ease-out 缓动。
///
/// **必须在后台线程调用**：窗口重绘靠主线程的消息泵，在命令线程里同步 sleep
/// 会把整个过渡压成「一步到位」——那正是用户反馈的「啪一下变成小条」。
/// 最近一次过渡**真的** SetWindowPos 过的每一帧（验收用：证明不是一步到位）。
/// 存的是每帧实际写入的矩形，不是计划值。
pub static LAST_ANIM_FRAMES: std::sync::Mutex<Vec<Rect>> = std::sync::Mutex::new(Vec::new());

fn record_frame(r: Rect) {
    let mut g = LAST_ANIM_FRAMES.lock().unwrap_or_else(|e| e.into_inner());
    g.push(r);
}

/// 读回最近一次过渡的逐帧矩形（空 = 还没做过过渡）。
pub fn last_anim_frames() -> Vec<Rect> {
    let g = LAST_ANIM_FRAMES.lock().unwrap_or_else(|e| e.into_inner());
    g.clone()
}

/// 读回最近一次过渡里被系统拒掉的帧数（0 = 每帧都成功）。
pub fn last_anim_error_count() -> usize {
    let g = LAST_ANIM_ERRORS.lock().unwrap_or_else(|e| e.into_inner());
    g.len()
}

/// 最近一次过渡里失败的帧数（验收/诊断用：个别帧在窗口正被系统重排时可能被拒）。
pub static LAST_ANIM_ERRORS: std::sync::Mutex<Vec<String>> = std::sync::Mutex::new(Vec::new());

#[cfg(windows)]
pub fn animate_window(hwnd: isize, from: Rect, to: Rect, total_ms: u64) -> Result<(), String> {
    {
        let mut g = LAST_ANIM_FRAMES.lock().unwrap_or_else(|e| e.into_inner());
        g.clear();
    }
    {
        let mut e = LAST_ANIM_ERRORS.lock().unwrap_or_else(|x| x.into_inner());
        e.clear();
    }
    let frames = anim_frames(from, to, total_ms);
    let mut failed = 0usize;
    for frame in frames {
        // 单帧失败**不能中断整段动画**：收起/展开过程中窗口正在被系统重排，
        // 个别 SetWindowPos 会被拒（实测第 3 帧就可能失败），一 bail 就退化成
        // 「两帧 + 一步到位」，正是用户抱怨的那种生硬。失败的帧跳过，继续走完。
        match place_window(hwnd, frame) {
            Ok(()) => record_frame(frame),
            Err(e) => {
                failed += 1;
                let mut g = LAST_ANIM_ERRORS.lock().unwrap_or_else(|x| x.into_inner());
                g.push(e);
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(ANIM_FRAME_MS));
    }
    // 最后一帧必须落到目标：前面若有失败，这里补一次，绝不停在半路。
    if failed > 0 {
        place_window(hwnd, to)?;
        record_frame(to);
    }
    Ok(())
}

#[cfg(not(windows))]
pub fn animate_window(_hwnd: isize, _from: Rect, _to: Rect, _total_ms: u64) -> Result<(), String> {
    Err("此平台不支持窗口过渡动画（仅 Windows）".into())
}
