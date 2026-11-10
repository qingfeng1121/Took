package app.took.engine

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * docs/本地优先契约.md §3.5 的 12 条三端共同验收用例，逐条对应。
 * 任何一条改动都意味着三端语义变更，必须同步 Go / Rust / Kotlin 与本表。
 */
class EngineTest {

    private fun rule(
        mode: Int,
        start: String = "2026-10-01",
        mask: Int = 0,
        every: Int = 0,
        monthDay: Int = 0,
        yearMonth: Int = 0,
        yearDay: Int = 0,
        end: String? = null,
        until: String? = null,
    ) = Rule(
        id = "r", repeatMode = mode, startDate = start, weekdaysMask = mask, repeatEvery = every,
        monthDay = monthDay, yearMonth = yearMonth, yearDay = yearDay, endDate = end, repeatUntil = until,
    )

    /** #1 weekly mask=31（周一~周五） */
    @Test
    fun case01_weeklyMask31() {
        val r = rule(RepeatMode.WEEKLY, mask = 31)
        assertTrue("2026-10-19(一)", Engine.occursOn(r, "2026-10-19"))
        assertFalse("2026-10-24(六)", Engine.occursOn(r, "2026-10-24"))
        assertFalse("2026-10-25(日)", Engine.occursOn(r, "2026-10-25"))
        // 每个 bit 对应的星期必须对：bit0=周一 … bit6=周日
        val week = listOf("2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23", "2026-10-24", "2026-10-25")
        week.forEachIndexed { bit, day ->
            assertTrue("bit$bit 应命中 $day", Engine.occursOn(rule(RepeatMode.WEEKLY, mask = 1 shl bit), day))
        }
    }

    /** #2 every=8 起点 2026-10-01 */
    @Test
    fun case02_every8() {
        val r = rule(RepeatMode.EVERY, every = 8)
        assertTrue("10-01", Engine.occursOn(r, "2026-10-01"))
        assertTrue("10-09", Engine.occursOn(r, "2026-10-09"))
        assertFalse("10-10", Engine.occursOn(r, "2026-10-10"))
        assertFalse("09-30", Engine.occursOn(r, "2026-09-30"))
    }

    /** #3 monthly monthDay=20 */
    @Test
    fun case03_monthly20() {
        val r = rule(RepeatMode.MONTHLY, monthDay = 20)
        assertTrue("10-20", Engine.occursOn(r, "2026-10-20"))
        assertTrue("11-20", Engine.occursOn(r, "2026-11-20"))
        assertFalse("10-21", Engine.occursOn(r, "2026-10-21"))
    }

    /** #4 monthly monthDay=31：小月钳制到月末，但不改写用户填的值 */
    @Test
    fun case04_monthly31Clamped() {
        val r = rule(RepeatMode.MONTHLY, monthDay = 31, start = "2026-01-01")
        assertTrue("10-31", Engine.occursOn(r, "2026-10-31"))
        assertTrue("11-30", Engine.occursOn(r, "2026-11-30"))
        assertFalse("11-29", Engine.occursOn(r, "2026-11-29"))
        assertTrue("2027-02-28", Engine.occursOn(r, "2027-02-28"))
        assertFalse("2027-02-27", Engine.occursOn(r, "2027-02-27"))
        assertTrue("2028-02-29", Engine.occursOn(r, "2028-02-29"))
        // 填 31 的规则在 3 月仍回 31
        assertTrue("2027-03-31", Engine.occursOn(r, "2027-03-31"))
        assertFalse("2027-03-30", Engine.occursOn(r, "2027-03-30"))
    }

    /** #5 monthly monthDay=-1（每月最后一天） */
    @Test
    fun case05_monthlyLastDay() {
        val r = rule(RepeatMode.MONTHLY, monthDay = MONTH_DAY_LAST, start = "2026-01-01")
        assertTrue("2026-01-31", Engine.occursOn(r, "2026-01-31"))
        assertTrue("2026-04-30", Engine.occursOn(r, "2026-04-30"))
        assertTrue("2027-02-28", Engine.occursOn(r, "2027-02-28"))
        assertTrue("2028-02-29", Engine.occursOn(r, "2028-02-29"))
        assertFalse("2026-04-29 不是月末", Engine.occursOn(r, "2026-04-29"))
    }

    /** #6 yearly 3/15 */
    @Test
    fun case06_yearly315() {
        val r = rule(RepeatMode.YEARLY, yearMonth = 3, yearDay = 15)
        assertTrue("2027-03-15", Engine.occursOn(r, "2027-03-15"))
        assertFalse("2027-03-14", Engine.occursOn(r, "2027-03-14"))
    }

    /** #7 yearly 2/29：平年落 2/28，不溢出到 3/1 */
    @Test
    fun case07_yearlyFeb29() {
        val r = rule(RepeatMode.YEARLY, yearMonth = 2, yearDay = 29)
        assertTrue("2028-02-29", Engine.occursOn(r, "2028-02-29"))
        assertTrue("2027-02-28", Engine.occursOn(r, "2027-02-28"))
        assertFalse("2027-03-01 不许溢出", Engine.occursOn(r, "2027-03-01"))
    }

    /** #8 weekly periodStart：10-19~10-25 全归 2026-10-19 */
    @Test
    fun case08_weeklyPeriodStart() {
        val r = rule(RepeatMode.WEEKLY, mask = 127)
        listOf("2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23", "2026-10-24", "2026-10-25")
            .forEach { assertEquals(it, "2026-10-19", Engine.periodStartOf(r, it)) }
        assertEquals("2026-10-26", Engine.periodStartOf(r, "2026-10-26"))
    }

    /** #9 every=8 periodStart */
    @Test
    fun case09_everyPeriodStart() {
        val r = rule(RepeatMode.EVERY, every = 8)
        assertEquals("2026-10-01", Engine.periodStartOf(r, "2026-10-06"))
        assertEquals("2026-10-09", Engine.periodStartOf(r, "2026-10-09"))
    }

    /** #10 起始日之前不命中 */
    @Test
    fun case10_beforeStartDate() {
        val r = rule(RepeatMode.MONTHLY, monthDay = 20, start = "2026-10-01")
        assertFalse("2026-09-20", Engine.occursOn(r, "2026-09-20"))
    }

    /** #11 repeat_until 之后不命中 */
    @Test
    fun case11_afterRepeatUntil() {
        val r = rule(RepeatMode.MONTHLY, monthDay = 20, start = "2026-01-01", until = "2026-11-30")
        assertTrue("2026-11-20", Engine.occursOn(r, "2026-11-20"))
        assertFalse("2026-12-20", Engine.occursOn(r, "2026-12-20"))
    }

    /**
     * #12 打卡共享：只给 (t_fit, 2026-10-19) 打一次卡，10-19 那一周内所有命中日都显示已完成，
     * 10-26 起回到未完成。断言范围与 Go 的 TestCheckinSharedWithinPeriod 一致：
     * 只检查任务真正命中的那些天（周末不命中工作日规则，不在断言范围内）。
     */
    @Test
    fun case12_completionSharedWithinPeriod() {
        val gym = rule(RepeatMode.WEEKLY, mask = 31, start = "2026-10-01")
        val done = setOf(Engine.completionKey("t_fit", "2026-10-19"))

        // 同一个周周期：10-19~10-25 任意一天算出的 periodStart 都是 2026-10-19
        listOf("2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23", "2026-10-24", "2026-10-25")
            .forEach { assertEquals(it, "2026-10-19", Engine.periodStartOf(gym, it)) }

        // 命中日（周一~周五）共享同一个完成状态
        listOf("2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23").forEach { day ->
            assertTrue("$day 应命中工作日规则", Engine.occursOn(gym, day))
            assertTrue(
                "$day 属于 10-19 那一周，应显示为已完成",
                Engine.completionKey("t_fit", Engine.periodStartOf(gym, day)) in done,
            )
        }

        // 下一周回到未完成
        listOf("2026-10-26", "2026-10-27", "2026-10-29").forEach { day ->
            assertFalse(
                "$day 属于下一周，不该显示为已完成",
                Engine.completionKey("t_fit", Engine.periodStartOf(gym, day)) in done,
            )
        }
    }

    /** 契约 §3.4：非法格式必须报错，不得静默兜底 */
    @Test
    fun dateKeyRejectsInvalidFormats() {
        listOf("2026-1-5", "2026/10/01", "2026-10-1", "26-10-01", "2026-02-30", "").forEach { bad ->
            var thrown = false
            try {
                DateKeys.parse(bad)
            } catch (e: java.time.DateTimeException) {
                thrown = true
            } catch (e: IllegalArgumentException) {
                thrown = true
            }
            assertTrue("\"$bad\" 应当抛错", thrown)
        }
        assertEquals("2026-10-19", DateKeys.key(DateKeys.parse("2026-10-19")))
    }
}
