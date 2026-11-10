package app.took.homewidget

import app.took.calendar.MonthGridLayout
import app.took.data.DayCell

/**
 * 首页日历组件「月历」的纯逻辑层：没有任何 Android / Glance 依赖，JVM 单测直接覆盖。
 *
 * 与首页同一套口径，不另立规矩：
 *  - 42 格 / 周一起始 —— 直接取 MonthGridLayout.dates；
 *  - 圆点 —— 先取 MonthGridLayout.dotPlan（已完成实心 / 未完成空心 / 超 6 补 +N），
 *    再按组件档位砍掉画不下的部分；砍掉的进 more，不静默丢任务；
 *  - 今天 —— 日期串相等，只由 [MonthWidgetPlan.isToday] 判定，渲染与单测同源。
 *
 * 尺寸取舍：格子越小越先砍圆点（MINI 全砍 / MEDIUM 留 3 个 / LARGE 留 6 个 + 「+N」），
 * **日期数字与今天标记永远保留**——认不出日期就不是日历。
 */

/**
 * 一档尺寸。取哪一档由 [MonthWidgetPlan.tierForSize] 按 dp 判，内容取舍在这里定死。
 *
 * [maxDots] 是这一档一格真的画得出几个圆点（0 = 不画）；[showMore] 决定要不要画「+N」。
 * [rows] 是这一档能完整摆下的行数 —— 尺寸不够时宁可少显示下周的补位日，也不缩成一团。
 */
enum class MonthWidgetTier(
    val weekdaySp: Int,
    val dateSp: Int,
    val dotSp: Int,
    val maxDots: Int,
    val showMore: Boolean,
    val rows: Int,
    /** 每行固定高度（dp）。行距靠它均分，不再用 padding 叠加撑开 —— 用户 2026-10-28：「间距都不固定」。 */
    val rowHeightDp: Int,
    /** 底部图例（已完成 / 未完成 / 今天）。太小放不下就不画，别把日期挤没。 */
    val showLegend: Boolean,
) {
    /** 极小（2x2 及以下）：只有日期数字 + 今天标记，圆点全砍，无图例。 */
    MINI(weekdaySp = 8, dateSp = 9, dotSp = 6, maxDots = 0, showMore = false, rows = 6, rowHeightDp = 22, showLegend = false),

    /** 中等（约 3x3 / 4x3）：日期数字 + 最多 3 个圆点，不画「+N」，有图例（用户 4x3 组件就在这一档）。 */
    MEDIUM(weekdaySp = 9, dateSp = 10, dotSp = 6, maxDots = 3, showMore = false, rows = 6, rowHeightDp = 26, showLegend = true),

    /** 宽松（4x4 / 5x5）：日期数字 + 最多 6 个圆点 + 「+N」+ 底部图例。 */
    LARGE(weekdaySp = 10, dateSp = 12, dotSp = 7, maxDots = MonthGridLayout.DOT_MAX, showMore = true, rows = 6, rowHeightDp = 30, showLegend = true),
}

/**
 * 一格实际画出来的圆点：已完成 [done]、未完成 [undone]、画不下的 [more]。
 *
 * 与 MonthGridLayout.DotPlan 同形，但多一道「这一档画得下几个」的裁剪 ——
 * 裁剪只改显示，不改「有 N 个任务」这个事实（[more] 会如实带出来）。
 */
data class MonthWidgetDots(val done: Int, val undone: Int, val more: Int) {
    val total: Int get() = done + undone
}

/** 一格的呈现计划。[dots] 为 null = 这一档根本不画圆点（极小档）。 */
data class MonthWidgetCell(
    val date: String,
    val dayOfMonth: Int,
    val inMonth: Boolean,
    val isToday: Boolean,
    val dots: MonthWidgetDots?,
    /** 语义串：uiautomator 靠它断一格里有日期数字、今天标记、几个任务、几个已完成。 */
    val label: String,
)

/** 组件上的一整月。 */
data class MonthWidgetPlan(
    val year: Int,
    val month: Int,
    val today: String,
    val cells: List<MonthWidgetCell>,
) {

    /** 组件标题，与首页 AppBar 同为「2026 年 10 月」。 */
    val title: String get() = "$year 年 $month 月"

    val weekTitles: List<String> get() = MonthGridLayout.WEEK_TITLES

    /** 按行切，固定 6 行 7 列 —— 渲染只认这个，不自己算下标。 */
    fun rows(): List<List<MonthWidgetCell>> = cells.chunked(MonthGridLayout.COLS)

    /**
     * 实际要渲染的行：**砍掉末尾整行都是下月补位的空行**。
     *
     * 为什么：42 格固定按 6 行切，但 28 天的 2 月只要 4 行、30 天的月份常常 5 行就够，
     * 第 6 行全是下月补位日 —— 组件底部会留一大片空白（用户 2026-10-28 截图里那块白）。
     * 这里只砍「整行都不在本月」的尾部行，中间行哪怕跨月也保留（那是真实的一周）。
     */
    fun visibleRows(tier: MonthWidgetTier): List<List<MonthWidgetCell>> {
        val all = rows().take(tier.rows)
        var end = all.size
        while (end > 1 && all[end - 1].none { it.inMonth }) end--
        return all.subList(0, end)
    }

    companion object {

        /** 今天判定：日期串是否就是要红字高亮的那一天（app 内 --today = #E53935）。 */
        fun isToday(date: String, today: String): Boolean = date == today

        /**
         * 按组件实际尺寸选档位。宽度与高度**任一**不够就降档：
         * 7 列挤进 160dp 时圆点没有可读性；6 行挤进 150dp 时日期数字会糊。
         */
        fun tierForSize(widthDp: Float, heightDp: Float): MonthWidgetTier = when {
            widthDp < 200f || heightDp < 190f -> MonthWidgetTier.MINI
            widthDp < 300f || heightDp < 300f -> MonthWidgetTier.MEDIUM
            else -> MonthWidgetTier.LARGE
        }

        /**
         * 圆点裁剪：两个上限叠加 —— MonthGridLayout 的 6 个（与首页同一条规则）与档位上限，
         * 取更小的那个；砍掉的一律进 more，不静默丢任务。
         *
         * 截断顺序沿用入参顺序（未完成在前、已完成在后，与首页格子一致），
         * 因此小档位先保住的是未完成的空心点 —— 与首页看到的是同一批点。
         */
        fun dotsFor(doneFlags: List<Boolean>, tier: MonthWidgetTier): MonthWidgetDots? {
            if (tier.maxDots <= 0) return null
            val limit = tier.maxDots.coerceAtMost(MonthGridLayout.DOT_MAX)
            val shown = doneFlags.take(limit)
            val done = shown.count { it }
            return MonthWidgetDots(
                done = done,
                undone = shown.size - done,
                more = (doneFlags.size - shown.size).coerceAtLeast(0),
            )
        }

        /**
         * 把某月的 42 格折成组件计划。
         *
         * [cells] 来自 TookRepository.loadGrid（已按 MonthGridLayout.dates 排好）。
         * 读不到那一格时按「非本月空位」处理，不抛异常 ——
         * 组件在桌面上，任何一次崩溃都会被用户直接看到。
         */
        fun of(
            year: Int,
            month: Int,
            today: String,
            cells: List<DayCell>,
            tier: MonthWidgetTier,
        ): MonthWidgetPlan {
            val byDate = cells.associateBy { it.date }
            val out = MonthGridLayout.dates(year, month).map { date ->
                val cell = byDate[date]
                // 未完成在前、已完成在后：与首页 DayCellView 的显示排序一致
                val flags = cell?.items?.sortedBy { it.done }?.map { it.done }.orEmpty()
                val day = dayOfMonthOf(date)
                MonthWidgetCell(
                    date = date,
                    dayOfMonth = day,
                    inMonth = cell?.inMonth ?: false,
                    isToday = isToday(date, today),
                    dots = dotsFor(flags, tier),
                    label = label(date, day, today, cell, flags, tier),
                )
            }
            return MonthWidgetPlan(year = year, month = month, today = today, cells = out)
        }

        /** 日期串第 8 位起是日：2026-10-05 → 5。解析不出来按 0，让格子留白而不是崩。 */
        fun dayOfMonthOf(date: String): Int =
            if (date.length >= 10) date.substring(8).toIntOrNull() ?: 0 else 0

        /**
         * 一格的语义串。形状与首页 DayCellView 一致（日期 + 任务数 + 已完成数），
         * 今天的格子额外带「今天」二字 —— 真机 dump 里就能直接搜到。
         */
        fun label(
            date: String,
            day: Int,
            today: String,
            cell: DayCell?,
            flags: List<Boolean>,
            tier: MonthWidgetTier,
        ): String = buildString {
            append(date).append(" ").append(day).append(" 日")
            if (isToday(date, today)) append(" 今天")
            append("，").append(flags.size).append(" 个任务")
            if (flags.isNotEmpty()) append(" ").append(flags.count { it }).append(" 个已完成")
            val memoCount = cell?.memos?.size ?: 0
            if (memoCount > 0) append("，记事 ").append(memoCount).append(" 条")
            val dots = dotsFor(flags, tier)
            if (dots != null && dots.more > 0) append("，还有 ").append(dots.more).append(" 个")
        }
    }
}
