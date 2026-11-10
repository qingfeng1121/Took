package app.took.widget

import app.took.data.DayItem
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.LocalDate
import java.time.ZoneId

/**
 * 组件「显示哪些任务」的纯逻辑（验收要求新增测试覆盖这段）。
 *
 * 三件事在这里断言，都不需要模拟器：
 *  1. 已完成的任务**不会消失**，只是排到未完成之后（定稿 §6.2 的核心行为）；
 *  2. 三档尺寸各自能放几条、溢出多少（小尺寸只留一条）；
 *  3. 跨天闹钟落在下一个本地零点。
 */
class TodayWidgetPlanTest {

    private fun item(title: String, done: Boolean, period: String = "2026-10-25") = DayItem(
        taskId = "t_$title",
        title = title,
        ruleId = "r1",
        ruleTitle = "规则",
        periodStart = period,
        done = done,
    )

    @Test
    fun empty_day_showsNoRowsAndPlainHeadline() {
        val plan = TodayWidgetPlan.of("2026-10-25", emptyList())
        assertEquals(0, plan.total)
        assertEquals("今天没有安排", plan.headline)
        assertTrue(plan.visible(3).isEmpty())
        assertEquals(0, plan.overflow(1))
    }

    @Test
    fun undoneTasksComeFirst_butDoneOnesStayVisible() {
        val plan = TodayWidgetPlan.of(
            "2026-10-25",
            listOf(
                item("健身", done = true),
                item("早起", done = false),
                item("交房租", done = true),
                item("背单词", done = false),
            ),
        )
        // 未完成优先，两组内部保持入参顺序
        assertEquals(listOf("早起", "背单词", "健身", "交房租"), plan.tasks.map { it.title })
        assertEquals(listOf(false, false, true, true), plan.tasks.map { it.done })
        assertEquals(4, plan.total)
        assertEquals(2, plan.doneCount)
        assertEquals(2, plan.undoneCount)
        assertEquals("2/4 未完成", plan.headline)
    }

    @Test
    fun allDone_saysAllDoneInsteadOfZeroUndone() {
        val plan = TodayWidgetPlan.of("2026-10-25", listOf(item("健身", true), item("早起", true)))
        assertEquals("全部完成 2/2", plan.headline)
        assertEquals(0, plan.undoneCount)
    }

    @Test
    fun compactOnlyShowsTheFirstRow_andCountsOverflow() {
        val plan = TodayWidgetPlan.of(
            "2026-10-25",
            listOf(item("a", false), item("b", false), item("c", false)),
        )
        val rows = plan.visible(WidgetTier.COMPACT.rows)
        assertEquals(listOf("a"), rows.map { it.title })
        assertEquals(2, plan.overflow(WidgetTier.COMPACT.rows))
    }

    @Test
    fun tierRows_areOneThreeSix() {
        assertEquals(1, WidgetTier.COMPACT.rows)
        assertEquals(3, WidgetTier.MEDIUM.rows)
        assertEquals(6, WidgetTier.LARGE.rows)
    }

    @Test
    fun largeTierListsSixRows_maximum() {
        val eight = (1..8).map { item("任务$it", done = false) }
        val plan = TodayWidgetPlan.of("2026-10-25", eight)
        assertEquals(6, plan.visible(WidgetTier.LARGE.rows).size)
        assertEquals(2, plan.overflow(WidgetTier.LARGE.rows))
    }

    @Test
    fun limitLargerThanList_hasNoOverflow() {
        val plan = TodayWidgetPlan.of("2026-10-25", listOf(item("a", false)))
        assertEquals(0, plan.overflow(6))
        assertEquals(1, plan.visible(6).size)
    }

    /** 尺寸分档：高度是主判据，极窄也降为紧凑（1×N 竖条放不下两行）。 */
    @Test
    fun tierForSize_followsHeightAndNarrowWidth() {
        assertEquals(WidgetTier.COMPACT, TodayWidgetPlan.tierForSize(150f, 60f))
        assertEquals(WidgetTier.COMPACT, TodayWidgetPlan.tierForSize(160f, 300f))  // 太窄
        assertEquals(WidgetTier.MEDIUM, TodayWidgetPlan.tierForSize(250f, 150f))
        assertEquals(WidgetTier.MEDIUM, TodayWidgetPlan.tierForSize(320f, 240f))
        assertEquals(WidgetTier.LARGE, TodayWidgetPlan.tierForSize(320f, 260f))
        assertEquals(WidgetTier.LARGE, TodayWidgetPlan.tierForSize(400f, 500f))
    }

    /** 跨天闹钟必须落在下一个本地零点，且不受夏令时「加 24 小时」影响。 */
    @Test
    fun nextMidnight_isTheFollowingLocalZero() {
        val zone = ZoneId.of("Asia/Shanghai")
        val now = LocalDate.of(2026, 10, 25).atTime(13, 41).atZone(zone).toInstant().toEpochMilli()
        val at = WidgetTickScheduler.nextMidnightMillis(now, zone)
        assertEquals(
            LocalDate.of(2026, 10, 26).atStartOfDay(zone).toInstant().toEpochMilli(),
            at,
        )
        assertTrue("必须严格晚于当前时刻", at > now)
    }

    @Test
    fun nextMidnight_fromAfternoonIsAlwaysTodayPlusOne() {
        val zone = ZoneId.of("Europe/Berlin")
        // 2026-03-29 是柏林夏令时切换日（当天 02:00 → 03:00），用 atStartOfDay 不会偏一小时
        val now = LocalDate.of(2026, 3, 29).atTime(12, 0).atZone(zone).toInstant().toEpochMilli()
        val at = WidgetTickScheduler.nextMidnightMillis(now, zone)
        assertEquals(
            LocalDate.of(2026, 3, 30).atStartOfDay(zone).toInstant().toEpochMilli(),
            at,
        )
        assertTrue(at > now)
    }
}
