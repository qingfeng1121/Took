package app.took.data

import app.took.engine.Engine
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 打卡写路径的三条硬要求：同周期共享、取消能恢复、写入带 dirty。
 * 表里的库换成内存实现，展开逻辑走生产的 MonthExpander，判定路径与真机一致。
 */
class CheckinSharingTest {

    private class MemoryDao : CompletionDao {
        val rows = LinkedHashMap<String, CompletionRecord>()

        override fun find(taskId: String, periodStart: String): CompletionRecord? =
            rows[Engine.completionKey(taskId, periodStart)]

        override fun save(record: CompletionRecord) {
            rows[Engine.completionKey(record.taskId, record.periodStart)] = record
        }

        /** 与 TookRepository.doneKeys() 同语义：deleted=0 且 status=1 才算完成。 */
        fun doneKeys(): Set<String> = rows.values
            .filter { it.deleted == 0 && it.status == 1 }
            .map { Engine.completionKey(it.taskId, it.periodStart) }
            .toSet()
    }

    private val weekly = RuleRow(
        id = "r_work", title = "工作日常规", enabled = true, repeatMode = 0,
        weekdaysMask = 31, repeatEvery = null, monthDay = null, yearMonth = null, yearDay = null,
        startDate = "2026-10-01", endDate = null, repeatUntil = null,
    )
    private val weekdayTasks = mapOf("r_work" to listOf(TaskRow("t_fit", "r_work", "健身", true, 0)))

    private val workdays = listOf("2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23")

    private fun doneOn(dao: MemoryDao, date: String): Boolean =
        MonthExpander.itemsOn(date, listOf(weekly), weekdayTasks, dao.doneKeys())
            .firstOrNull { it.taskId == "t_fit" }?.done ?: false

    private fun hit(dao: MemoryDao, date: String): Boolean =
        MonthExpander.itemsOn(date, listOf(weekly), weekdayTasks, dao.doneKeys()).any { it.taskId == "t_fit" }

    /** 在周三（10-21）打卡，周一到周五都要变已完成 —— 键是周期，不是某一天。 */
    @Test
    fun checkinOnOneDayCompletesWholePeriod() {
        val dao = MemoryDao()
        val service = CheckinService(dao) { 1_700_000_000_000L }

        val rec = service.setDone("t_fit", Engine.periodStartOf(weekly.toEngine(), "2026-10-21"), true)

        assertEquals("status 写 1", 1, rec.status)
        assertEquals("必须置 dirty，否则推送不会带上它", 1, rec.dirty)
        assertEquals(1_700_000_000_000L, rec.updatedAt)
        assertEquals("周期起点是周一", "2026-10-19", rec.periodStart)
        workdays.forEach { day -> assertTrue("$day 应显示已完成", doneOn(dao, day)) }
        // 下一个周期不能受影响
        assertFalse("10-26 起回到未完成", doneOn(dao, "2026-10-26"))
        // 周末本来就不命中工作日规则
        assertFalse("10-24(六) 不命中", hit(dao, "2026-10-24"))
    }

    /** 取消打卡同样作用于整个周期，且写的是 status=0 + 新时间戳，不是删行。 */
    @Test
    fun cancelRestoresWholePeriod() {
        val dao = MemoryDao()
        var now = 1_700_000_000_000L
        val service = CheckinService(dao) { now }

        service.setDone("t_fit", "2026-10-19", true)
        workdays.forEach { assertTrue("$it 先置完成", doneOn(dao, it)) }

        now += 60_000
        val cancelled = service.toggle("t_fit", "2026-10-19")

        assertEquals("取消写 status=0", 0, cancelled.status)
        assertEquals("取消也要置 dirty，反向变更同样要能推出去", 1, cancelled.dirty)
        assertEquals("updated_at 必须更新，LWW 靠它", 1_700_000_060_000L, cancelled.updatedAt)
        assertEquals("仍是同一行，没有物理删除", 1, dao.rows.size)
        workdays.forEach { assertFalse("$it 应恢复未完成", doneOn(dao, it)) }

        // 再点一次又变完成，切换是可逆的
        val again = service.toggle("t_fit", "2026-10-19")
        assertEquals(1, again.status)
        workdays.forEach { assertTrue("$it 再次完成", doneOn(dao, it)) }
    }

    /** 每 N 天：10-06 与 10-09 属于不同周期，不会互相带。 */
    @Test
    fun everyRuleDoesNotLeakAcrossPeriods() {
        val every = RuleRow(
            id = "r_words", title = "单词打卡", enabled = true, repeatMode = 1,
            weekdaysMask = 0, repeatEvery = 8, monthDay = null, yearMonth = null, yearDay = null,
            startDate = "2026-10-01", endDate = null, repeatUntil = null,
        )
        val tasks = mapOf("r_words" to listOf(TaskRow("t_words", "r_words", "背单词", true, 0)))
        val dao = MemoryDao()
        val service = CheckinService(dao) { 1_700_000_000_000L }

        service.setDone("t_words", Engine.periodStartOf(every.toEngine(), "2026-10-01"), true)

        fun done(date: String) = MonthExpander.itemsOn(date, listOf(every), tasks, dao.doneKeys())
            .firstOrNull { it.taskId == "t_words" }?.done ?: false

        assertTrue("10-01 命中且已完成", done("2026-10-01"))
        assertFalse("10-09 是下一周期，未完成", done("2026-10-09"))
        assertFalse("10-06 不命中该规则", MonthExpander.itemsOn("2026-10-06", listOf(every), tasks, dao.doneKeys()).isNotEmpty())
    }
}
