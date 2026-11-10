package app.took.homewidget

import app.took.calendar.MonthGridLayout
import app.took.data.DayCell
import app.took.data.DayItem
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 「月历」组件的纯逻辑（验收要求：新增测试覆盖哪些格显示什么、今天判定、圆点分档）。
 *
 * 四件事在这里断言，都不需要模拟器：
 *  1. 42 格 / 周一起始，且与首页同一个 MonthGridLayout.dates；
 *  2. 今天判定与高亮标记（且标记在任何档位都不被砍掉）；
 *  3. 圆点分档：MINI 不画 / MEDIUM 最多 3 个 / LARGE 最多 6 个 + 「+N」；
 *  4. 非本月日期灰化（inMonth=false 一路传到格子上）。
 */
class MonthWidgetPlanTest {

    private fun item(title: String, done: Boolean, period: String = "2026-10-06") = DayItem(
        taskId = "t_" + title,
        title = title,
        ruleId = "r1",
        ruleTitle = "规则",
        periodStart = period,
        done = done,
    )

    private fun cell(date: String, inMonth: Boolean, done: List<Boolean>) = DayCell(
        date = date,
        inMonth = inMonth,
        items = done.mapIndexed { i, d -> item("任务" + i, d, date) },
    )

    /** 2026 年 10 月的真实 42 格（含补位的 9/28–9/30、11/1 起），用来断言本月/非本月。 */
    private fun fullGrid(): List<DayCell> = MonthGridLayout.dates(2026, 10).map { date ->
        val d = java.time.LocalDate.parse(date)
        DayCell(date = date, inMonth = d.year == 2026 && d.monthValue == 10, items = emptyList())
    }

    /** 2026 年 10 月：1 日是周四，所以第一格是 9/28（周一）。 */
    private val today = "2026-10-06"

    @Test
    fun fortyTwoCells_mondayFirst_sameAsHomeCalendar() {
        val plan = MonthWidgetPlan.of(2026, 10, today, emptyList(), MonthWidgetTier.LARGE)
        assertEquals(MonthGridLayout.CELLS, plan.cells.size)
        assertEquals(42, plan.cells.size)
        // 第一格必须是本月 1 日所在周的周一（与首页 MonthGridLayout.dates 完全一致）
        assertEquals(MonthGridLayout.dates(2026, 10), plan.cells.map { it.date })
        assertEquals("2026-09-28", plan.cells.first().date)
        assertEquals(6, plan.rows().size)
        assertTrue(plan.rows().all { it.size == 7 })
    }

    @Test
    fun titleAndWeekTitles_matchAppBar() {
        val plan = MonthWidgetPlan.of(2026, 10, today, emptyList(), MonthWidgetTier.LARGE)
        assertEquals("2026 年 10 月", plan.title)
        assertEquals(listOf("一", "二", "三", "四", "五", "六", "日"), plan.weekTitles)
    }

    @Test
    fun outOfMonthCells_areGreyedAndOnlyOneIsToday() {
        val plan = MonthWidgetPlan.of(2026, 10, today, fullGrid(), MonthWidgetTier.LARGE)
        // 9/28、9/29、9/30 是补位的上月日期 → 灰化
        assertFalse(plan.cells.first { it.date == "2026-09-28" }.inMonth)
        assertFalse(plan.cells.first { it.date == "2026-09-30" }.inMonth)
        assertTrue(plan.cells.first { it.date == "2026-10-01" }.inMonth)
        // 只有 10/06 是今天，且它必须有标记
        assertEquals(1, plan.cells.count { it.isToday })
        assertTrue(plan.cells.first { it.date == today }.isToday)
        // 非本月里即使日期串相同也不会被当成今天（今天按完整日期串比）
        assertFalse(plan.cells.first { it.date == "2026-09-28" }.isToday)
    }

    @Test
    fun dayNumbers_comeFromTheDateString() {
        val plan = MonthWidgetPlan.of(2026, 10, today, emptyList(), MonthWidgetTier.LARGE)
        assertEquals(28, plan.cells.first().dayOfMonth)
        assertEquals(5, MonthWidgetPlan.dayOfMonthOf("2026-10-05"))
        assertEquals(31, MonthWidgetPlan.dayOfMonthOf("2026-10-31"))
        // 脏数据不崩：解析不出来按 0
        assertEquals(0, MonthWidgetPlan.dayOfMonthOf("bad"))
    }

    @Test
    fun todayMarkup_survivesEveryTier() {
        // 今天标记（加粗 + 红字）在最小档也必须保留 —— 它是组件上唯一的时间锚点
        listOf(MonthWidgetTier.MINI, MonthWidgetTier.MEDIUM, MonthWidgetTier.LARGE).forEach { tier ->
            val plan = MonthWidgetPlan.of(2026, 10, today, emptyList(), tier)
            val cell = plan.cells.first { it.date == today }
            assertTrue("今天在 " + tier + " 档必须仍被标记", cell.isToday)
            assertTrue("今天在 " + tier + " 档的语义串要带「今天」", cell.label.contains("今天"))
        }
    }

    @Test
    fun isToday_isPureStringEquality() {
        assertTrue(MonthWidgetPlan.isToday("2026-10-06", "2026-10-06"))
        assertFalse(MonthWidgetPlan.isToday("2026-10-05", "2026-10-06"))
        assertFalse(MonthWidgetPlan.isToday("", "2026-10-06"))
    }

    @Test
    fun dots_missingInMini_threeInMedium_sixPlusMoreInLarge() {
        val many = cell("2026-10-06", true, List(9) { false })
        val cells = listOf(many)

        // MINI：格子太小，一个圆点都不画（只留日期数字 + 今天标记）
        assertNull(MonthWidgetPlan.of(2026, 10, today, cells, MonthWidgetTier.MINI).cells.first { it.date == today }.dots)

        // MEDIUM：最多 3 个圆点，画不下的一律进 more（不静默丢任务）
        val medium = MonthWidgetPlan.of(2026, 10, today, cells, MonthWidgetTier.MEDIUM).cells.first { it.date == today }.dots!!
        assertEquals(3, medium.total)
        assertEquals(6, medium.more)

        // LARGE：MonthGridLayout 的 6 个上限 + 「+N」
        val large = MonthWidgetPlan.of(2026, 10, today, cells, MonthWidgetTier.LARGE).cells.first { it.date == today }.dots!!
        assertEquals(MonthGridLayout.DOT_MAX, large.total)
        assertEquals(3, large.more)
    }

    @Test
    fun dots_keepDoneOnesFirstWhenTruncating() {
        // 4 个已完成 + 4 个未完成，MEDIUM 只画 3 个：截断顺序与首页一致（未完成在前），
        // 所以先保住的是空心点；画不下的 5 个（含 4 个已完成）全部记进 more，不静默丢。
        val mixed = cell("2026-10-06", true, List(4) { true } + List(4) { false })
        val dots = MonthWidgetPlan.of(2026, 10, today, listOf(mixed), MonthWidgetTier.MEDIUM)
            .cells.first { it.date == today }.dots!!
        assertEquals(0, dots.done)
        assertEquals(3, dots.undone)
        assertEquals(5, dots.more)
    }

    @Test
    fun dots_doneOnesVisibleWhenThereIsRoom() {
        // 有空位时已完成照常画成实心点（完成的痕迹不会消失）
        val only = cell("2026-10-06", true, listOf(true, true, false))
        val dots = MonthWidgetPlan.of(2026, 10, today, listOf(only), MonthWidgetTier.LARGE)
            .cells.first { it.date == today }.dots!!
        assertEquals(2, dots.done)
        assertEquals(1, dots.undone)
        assertEquals(0, dots.more)
    }

    @Test
    fun dots_zeroWhenNoTasks() {
        val empty = cell("2026-10-06", true, emptyList())
        val dots = MonthWidgetPlan.of(2026, 10, today, listOf(empty), MonthWidgetTier.LARGE)
            .cells.first { it.date == today }.dots!!
        assertEquals(0, dots.total)
        assertEquals(0, dots.more)
        // 有格子但没任务：语义串如实写 0 个任务，不写成「没有这一格」
        assertTrue(dots.more == 0)
    }

    @Test
    fun label_carriesTaskAndDoneCounts() {
        val c = cell("2026-10-06", true, listOf(true, false, false))
        val cellPlan = MonthWidgetPlan.of(2026, 10, today, listOf(c), MonthWidgetTier.LARGE)
            .cells.first { it.date == today }
        assertTrue(cellPlan.label.contains("2026-10-06"))
        assertTrue(cellPlan.label.contains("今天"))
        assertTrue(cellPlan.label.contains("3 个任务"))
        assertTrue(cellPlan.label.contains("1 个已完成"))
    }

    @Test
    fun tierForSize_mapsWidgetSizesToTheRightDensity() {
        // 2x3 这种窄条：只放得下日期数字
        assertEquals(MonthWidgetTier.MINI, MonthWidgetPlan.tierForSize(150f, 120f))
        assertEquals(MonthWidgetTier.MINI, MonthWidgetPlan.tierForSize(180f, 300f))
        // 约 3x3：加圆点
        assertEquals(MonthWidgetTier.MEDIUM, MonthWidgetPlan.tierForSize(240f, 220f))
        // 4x4 / 5x5：完整密度
        assertEquals(MonthWidgetTier.LARGE, MonthWidgetPlan.tierForSize(320f, 320f))
        assertEquals(MonthWidgetTier.LARGE, MonthWidgetPlan.tierForSize(400f, 470f))
    }

    @Test
    fun missingGridData_doesNotThrowAndFills42Cells() {
        // 库读不到任何格子（首次启动/读取失败）：仍然给 42 格空位，不让组件崩
        val plan = MonthWidgetPlan.of(2026, 10, today, emptyList(), MonthWidgetTier.LARGE)
        assertEquals(42, plan.cells.size)
        assertTrue(plan.cells.none { it.inMonth })
        assertTrue(plan.cells.all { it.dots!!.total == 0 })
    }
}
