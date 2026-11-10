package app.took.calendar

import app.took.engine.DateKeys
import java.time.LocalDate

/**
 * 月历排布：固定 42 格（6 行 × 7 列），周一起始。
 * 纯 Kotlin，无 Android 依赖，可直接跑 JVM 单测。
 */
object MonthGridLayout {

    /** 一行 7 格 × 6 行 = 42 格。 */
    const val ROWS = 6
    const val COLS = 7
    const val CELLS = ROWS * COLS

    /** 周一起始的星期标题（与原型 WEEK_SHORT 一致）。 */
    val WEEK_TITLES = listOf("一", "二", "三", "四", "五", "六", "日")

    /** 一格最多画几个圆点；超出的用「+N」文字收尾（不是圆点）。 */
    const val DOT_MAX = 6

    /**
     * 格子宽度 = 可用宽度均分 7 列，**正好铺满屏宽，不横向滚动**。
     *
     * 用户 2026-10-26 原话：「日历日期格子太大了宽度不要大于屏幕，可以支持下滑不比侧滑好用」——
     * 原先的 1.5 倍宽（一屏 4.5 天 + 左右滑）作废，回到 7 列铺满；翻月改成**纵向滑动**。
     * 保留这个常量是为了把「不再缩放」写成可断言的契约（值必须是 1.0）。
     */
    const val CELL_SCALE = 1.0f

    /** 格子宽度（px）：可用宽度均分 7 列，不足 1px 按 1px。 */
    fun cellWidthPx(availableWidthPx: Int): Int =
        (availableWidthPx.toFloat() / COLS * CELL_SCALE).toInt().coerceAtLeast(1)

    /**
     * 整月内容宽度（px）= 7 格 × 单格宽。
     *
     * 向下取整会让它比可用宽**最多少 6px**，绝不超出 —— 这就是「不会有横向滚动」的判据。
     */
    fun gridWidthPx(availableWidthPx: Int): Int = cellWidthPx(availableWidthPx) * COLS

    /**
     * 竖直拖动的翻月判定（纯逻辑，可单测）：返回 -1 上一个月、+1 下一个月、0 不翻。
     *
     * **已废弃（2026-10-26 第二次返工）**：用户原话「下滑就是滚动一个月」体感不对，
     * 首页月历改成 [WeekScroll] 的**连续周滚动**（LazyColumn，一项一周），UI 不再调用本方法。
     * 保留是为了不打断既有 3 条单测（它们是这套判定的回归网）；真正删的时候要连
     * MonthGridLayoutTest 里 monthFlip_* 那三条一起删，并同步删掉本方法。
     */
    fun monthFlip(dragPx: Float, velocityPxPerSec: Float, thresholdPx: Float): Int {
        val farEnough = kotlin.math.abs(dragPx) >= thresholdPx
        val fastEnough = kotlin.math.abs(velocityPxPerSec) >= FLIP_VELOCITY_PX_PER_SEC
        if (!farEnough && !fastEnough) return 0
        // 用速度定方向（甩动的方向才是用户真实意图）；速度可忽略时退回位移方向
        val byVelocity = -velocityPxPerSec
        val byDrag = -dragPx
        val direction = if (kotlin.math.abs(byVelocity) >= FLIP_VELOCITY_PX_PER_SEC) byVelocity else byDrag
        return if (direction > 0f) 1 else -1
    }

    /** 快甩阈值：约 1/5 屏宽每秒，正常手速一次甩动都在这个量级之上。 */
    const val FLIP_VELOCITY_PX_PER_SEC = 1200f

    /**
     * 一格下方的圆点方案（用户 2026-10-25：「下方不要具体的任务了，改成点点」）。
     *
     * 规则：最多画 [DOT_MAX] 个圆点；已完成 = 实心橙点（done），未完成 = 空心灰点（undone）；
     * 超出 [DOT_MAX] 的部分不画点，收尾显示「+N」文字（more）。
     * 渲染顺序沿用调用方给的「未完成在前、已完成在后」。
     */
    data class DotPlan(val done: Int, val undone: Int, val more: Int) {
        /** 实际画出的圆点总数（不含 +N 文字）。 */
        val total: Int get() = done + undone
    }

    fun dotPlan(doneFlags: List<Boolean>): DotPlan {
        val shown = doneFlags.take(DOT_MAX)
        val done = shown.count { it }
        return DotPlan(
            done = done,
            undone = shown.size - done,
            more = (doneFlags.size - shown.size).coerceAtLeast(0),
        )
    }

    /** 返回覆盖 year/month 的 42 个 'YYYY-MM-DD'，第一格是本月 1 日所在周的周一。 */
    fun dates(year: Int, month: Int): List<String> {
        val first = LocalDate.of(year, month, 1)
        // Kotlin 的 DayOfWeek：MONDAY=1 … SUNDAY=7；周一起始时前置格数 = value - 1
        val lead = first.dayOfWeek.value - 1
        val start = first.minusDays(lead.toLong())
        return (0 until CELLS).map { DateKeys.key(start.plusDays(it.toLong())) }
    }
}
