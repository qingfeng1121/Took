package app.took.calendar

import app.took.data.DayCell
import app.took.data.MonthExpander
import app.took.data.RuleRow
import app.took.data.TaskRow
import app.took.data.WeekRows
import app.took.engine.DateKeys
import app.took.engine.Engine
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.DayOfWeek
import java.time.LocalDate

/**
 * 连续滚动月历（用户 2026-10-26 返工）：
 * 「向下滑，日历就像一张长长的纸，一天一天、一周一周（一行一行）地连续往下滚动。
 * 滚动到月底后，无缝衔接下一月。」以及「不要出现下滑就是滚动一个月」。
 *
 * 这一组断言的就是那条体感：**行与行之间是 +7 天，没有任何整月跳跃**。
 */
class WeekScrollTest {

    private fun date(s: String): LocalDate = LocalDate.parse(s)

    /* ---------------------------- 周一起始 ---------------------------- */

    @Test
    fun weekStart_isAlwaysMonday() {
        // 周四、周日、周一各来一个：结果都必须回落到当周周一
        assertEquals("2026-09-28", WeekScroll.weekStart("2026-10-01"))  // 周四
        assertEquals("2026-10-05", WeekScroll.weekStart("2026-10-11"))  // 周日
        assertEquals("2026-10-05", WeekScroll.weekStart("2026-10-05"))  // 本来就是周一
        assertEquals("2027-01-04", WeekScroll.weekStart("2027-01-10"))  // 跨年后的周日
        listOf("2026-09-28", "2026-10-05", "2027-01-04").forEach {
            assertEquals(it, DayOfWeek.MONDAY, date(it).dayOfWeek)
        }
    }

    /* ------------------------ 连续：行行 +7 天 ------------------------ */

    /** 相邻两行严格相隔 7 天 —— 跨月那两行也不例外，这就是「无缝」。 */
    @Test
    fun weeks_areConsecutiveSevenDaySteps() {
        val weeks = WeekScroll.weeks("2026-09-01", "2026-12-31")
        assertTrue("范围里得有内容", weeks.size > 10)
        weeks.zipWithNext().forEach { (a, b) ->
            assertEquals("$a 的下一行必须是 +7 天", date(a).plusDays(7), date(b))
        }
        weeks.forEach { assertEquals(DayOfWeek.MONDAY, date(it).dayOfWeek) }
    }

    /** 跨月边界：10 月最后一周之后的下一行就是 11 月第一周，中间不跳、不回退。 */
    @Test
    fun weeks_crossOctoberToNovemberWithoutGap() {
        val weeks = WeekScroll.weeks("2026-10-01", "2026-11-30")
        val idx = weeks.indexOf("2026-10-26")
        assertTrue("10/26 那一周必须在列表里", idx >= 0)
        assertEquals("2026-11-02", weeks[idx + 1])
        // 10/26 起的这一周自己就跨了月：10/26~10/31 + 11/01
        val monday = date("2026-10-26")
        assertEquals("2026-11-01", DateKeys.key(monday.plusDays(6)))
        assertEquals("2026-11-01", date(weeks[idx]).plusDays(6).toString())
    }

    /** 跨年 12 → 1 月：2026-12-28 那一周的下一行是 2027-01-04，没有断档。 */
    @Test
    fun weeks_crossYearDecemberToJanuary() {
        val weeks = WeekScroll.weeks("2026-12-01", "2027-01-31")
        val idx = weeks.indexOf("2026-12-28")
        assertTrue("12/28 那一周必须在列表里", idx >= 0)
        assertEquals("2027-01-04", weeks[idx + 1])
        assertEquals("2027-01-03", date(weeks[idx]).plusDays(6).toString())
        assertEquals("2026-12", WeekScroll.monthKey(weeks[idx]))
        assertEquals("2027-01", WeekScroll.monthKey(weeks[idx + 1]))
    }

    /** 起止日落在周中时也要覆盖到：from 是周三、to 是下周二，两行都算。 */
    @Test
    fun weeks_coverPartialWeeks() {
        val weeks = WeekScroll.weeks("2026-10-07", "2026-10-13")  // 周三 → 下周二
        assertEquals(listOf("2026-10-05", "2026-10-12"), weeks)
    }

    /** 反向区间返回空列表，不抛异常。 */
    @Test
    fun weeks_emptyWhenReversed() {
        assertTrue(WeekScroll.weeks("2026-10-31", "2026-10-01").isEmpty())
    }

    /* --------------------------- 顶部标题月份 --------------------------- */

    /**
     * 标题取「这一行 7 天里天数最多的那个月」：
     * 2026-10-26~11-01 是 10 月 6 天 + 11 月 1 天 → 10 月；下一行才变 11 月。
     */
    @Test
    fun headerMonth_majorityOfTheWeek() {
        assertEquals("2026-10", WeekScroll.headerMonth("2026-10-26"))
        assertEquals("2026-11", WeekScroll.headerMonth("2026-11-02"))
        // 2026-09-28 起的这周：9/28~9/30 三天 + 10/1~10/4 四天 → 已经是 10 月
        assertEquals("2026-10", WeekScroll.headerMonth("2026-09-28"))
        // 2027-01-25 起的这周：1/25~1/31 七天全在 1 月
        assertEquals("2027-01", WeekScroll.headerMonth("2027-01-25"))
    }

    /** 标题文案与改造前 AppBar 完全一致（「2026 年 10 月」）。 */
    @Test
    fun monthTitle_matchesPreviousAppBarFormat() {
        assertEquals("2026 年 10 月", WeekScroll.monthTitle("2026-10"))
        assertEquals("2027 年 1 月", WeekScroll.monthTitle("2027-01"))
    }

    /* --------------------------- ‹ › 按钮定位 --------------------------- */

    /** › 一次：从 10 月标题滚到 11 月第一行 —— 按下之后标题必须真的变。 */
    @Test
    fun indexOfFirstWeekOfMonth_movesHeaderForward() {
        val weeks = WeekScroll.weeks("2026-01-01", "2027-12-31")
        val nov = WeekScroll.indexOfFirstWeekOfMonth(weeks, "2026-11")
        assertTrue("11 月第一行必须在范围里", nov >= 0)
        assertEquals("2026-11", WeekScroll.headerMonth(weeks[nov]))
        // 上一行的主月仍是 10 月，说明这里正好是「第一行」
        assertEquals("2026-10", WeekScroll.headerMonth(weeks[nov - 1]))
        val oct = WeekScroll.indexOfFirstWeekOfMonth(weeks, "2026-10")
        assertTrue("‹ 回得去", oct < nov)
        assertEquals("2026-10", WeekScroll.headerMonth(weeks[oct]))
    }

    /** 范围外的月份返回 -1（按钮据此不动，不会滚出列表）。 */
    @Test
    fun indexOfFirstWeekOfMonth_outOfRange() {
        val weeks = WeekScroll.weeks("2026-10-01", "2026-11-30")
        assertEquals(-1, WeekScroll.indexOfFirstWeekOfMonth(weeks, "2030-01"))
    }

    /** 初始位置：今天在哪一行。范围外（数据没加载）落到最近一行，不返回 -1。 */
    @Test
    fun indexOfWeekContaining_todayAndOutOfRange() {
        val weeks = WeekScroll.weeks("2026-01-01", "2026-12-31")
        val idx = WeekScroll.indexOfWeekContaining(weeks, "2026-10-26")
        assertEquals("2026-10-26", weeks[idx])
        // 比范围还早的日期 → 第 0 行
        assertEquals(0, WeekScroll.indexOfWeekContaining(weeks, "2020-05-05"))
        // 比范围还晚 → 最后一行
        assertEquals(weeks.lastIndex, WeekScroll.indexOfWeekContaining(weeks, "2030-05-05"))
        // 空列表也不崩
        assertEquals(0, WeekScroll.indexOfWeekContaining(emptyList(), "2026-10-26"))
    }

    /* ------------------------- 预生成范围（±24 个月） ------------------------- */

    @Test
    fun rangeFor_covers24MonthsEachSide() {
        val (from, to) = WeekScroll.rangeFor("2026-10-26")
        assertEquals("2024-10-01", from)
        assertEquals("2028-10-31", to)
        val weeks = WeekScroll.weeks(from, to)
        // 50 个月 ≈ 210+ 行：足够「一直往下滚」，又不会一次生成太多
        assertTrue("行数应 >= 200，实际 " + weeks.size, weeks.size >= 200)
        assertTrue("行数应 < 260，实际 " + weeks.size, weeks.size < 260)
    }

    /** 月份平移：跨年也对（2026-01 减 1 个月 = 2025-12）。 */
    @Test
    fun shiftMonth_crossesYearBoundary() {
        assertEquals("2025-12", WeekScroll.shiftMonth("2026-01", -1))
        assertEquals("2027-01", WeekScroll.shiftMonth("2026-12", 1))
        assertEquals("2026-10", WeekScroll.shiftMonth("2026-10", 0))
    }

    /* ----------------------- 行内容：7 格、连续、可灰化 ----------------------- */

    private val weekly = RuleRow(
        id = "r_work", title = "工作日常规", enabled = true, repeatMode = 0,
        weekdaysMask = 31, repeatEvery = null, monthDay = null, yearMonth = null, yearDay = null,
        startDate = "2026-10-01", endDate = null, repeatUntil = null,
    )
    private val tasks = mapOf("r_work" to listOf(TaskRow("t_fit", "r_work", "健身", true, 0)))
    private val doneKeys = setOf(Engine.completionKey("t_fit", "2026-10-26"))

    /** 每行恰好 7 格，格与格之间日期 +1 天；跨月那一行也不断。 */
    @Test
    fun buildRows_sevenConsecutiveCells() {
        val rows = WeekRows.build("2026-10-19", "2026-11-08") { date, inMonth ->
            DayCell(date = date, inMonth = inMonth, items = emptyList())
        }
        assertTrue(rows.isNotEmpty())
        rows.forEach { row ->
            assertEquals("每行 7 格", 7, row.cells.size)
            assertEquals("首格是周一", DayOfWeek.MONDAY, date(row.date).dayOfWeek)
            row.cells.zipWithNext().forEach { (a, b) ->
                assertEquals(date(a.date).plusDays(1), date(b.date))
            }
        }
        // 整段连续：上一行最后一格的次日 = 下一行第一格
        rows.zipWithNext().forEach { (a, b) ->
            assertEquals(date(a.cells.last().date).plusDays(1), date(b.cells.first().date))
        }
        // 覆盖到跨月那一行：2026-10-26 起，末格是 2026-11-01
        val cross = rows.first { it.date == "2026-10-26" }
        assertEquals("2026-10-26", cross.cells.first().date)
        assertEquals("2026-11-01", cross.cells.last().date)
    }

    /** 灰化：跨月行里少数那侧的日子 inMonth=false，主月那侧 true（同一行颜色恒定）。 */
    @Test
    fun buildRows_greysMinoritySideOfCrossMonthRow() {
        val rows = WeekRows.build("2026-09-28", "2026-11-08") { date, inMonth ->
            DayCell(date = date, inMonth = inMonth, items = emptyList())
        }
        // 2026-09-28 起的这周：9/28~9/30 灰，10/1~10/4 正常
        val sep = rows.first { it.date == "2026-09-28" }
        assertEquals(
            listOf("2026-09-28", "2026-09-29", "2026-09-30"),
            sep.cells.filter { !it.inMonth }.map { it.date },
        )
        // 2026-10-26 起的这周：10/26~10/31 正常，只有 11/01 灰
        val oct = rows.first { it.date == "2026-10-26" }
        assertEquals(listOf("2026-11-01"), oct.cells.filter { !it.inMonth }.map { it.date })
        // 整月居中的那一行全都不灰
        val mid = rows.first { it.date == "2026-10-12" }
        assertTrue(mid.cells.all { it.inMonth })
    }

    /** 内容走生产的 MonthExpander：打卡状态、命中日与整月网格同一口径。 */
    @Test
    fun buildRows_fillsContentThroughRealExpander() {
        val rows = WeekRows.build("2026-10-26", "2026-11-01") { date, inMonth ->
            DayCell(
                date = date,
                inMonth = inMonth,
                items = MonthExpander.itemsOn(date, listOf(weekly), tasks, doneKeys),
            )
        }
        val cells = rows.flatMap { it.cells }.associateBy { it.date }
        // 周一到周五命中，周末不命中
        assertTrue(cells.getValue("2026-10-26").items.isNotEmpty())
        assertTrue(cells.getValue("2026-10-30").items.isNotEmpty())
        assertTrue(cells.getValue("2026-10-31").items.isEmpty())
        assertTrue(cells.getValue("2026-11-01").items.isEmpty())
        // 同一周期共享完成状态：10/26 打的卡，同周 10/30 也是已完成
        assertTrue(cells.getValue("2026-10-26").items.first().done)
        assertTrue(cells.getValue("2026-10-30").items.first().done)
        // 下一周（11-02 起）是新周期，未完成
        val nextWeek = WeekRows.build("2026-11-02", "2026-11-08") { date, inMonth ->
            DayCell(
                date = date,
                inMonth = inMonth,
                items = MonthExpander.itemsOn(date, listOf(weekly), tasks, doneKeys),
            )
        }
        assertTrue(nextWeek.first().cells.first().items.isNotEmpty())
        assertNotEquals(true, nextWeek.first().cells.first().items.first().done)
    }
}
