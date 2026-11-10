package app.took.alarm

import app.took.data.ReminderRow
import app.took.engine.RepeatMode
import app.took.engine.Rule
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.LocalDateTime
import java.time.ZoneId

/**
 * 「交给系统时钟的闹钟怎么算」的断言（用户要求：闹钟必须是系统原生，且不能每次保存都新建一条）。
 *
 * 这里只测纯逻辑：星期翻译、一次性降级、指纹去重、旧闹钟提示。
 * 真正能不能被系统时钟接受，只能在真机上看（SystemClockAlarm 那层）。
 */
class SystemAlarmPlannerTest {

    private val zone = ZoneId.of("Asia/Shanghai")

    private fun at(y: Int, mo: Int, d: Int, h: Int, mi: Int): Long =
        LocalDateTime.of(y, mo, d, h, mi).atZone(zone).toInstant().toEpochMilli()

    private fun reminder(
        alarmOn: Boolean = true,
        notifyOn: Boolean = false,
        timeOfDay: String = "09:00",
        repeatRule: Int = 1,
        offsetDays: Int = 0,
        enabled: Boolean = true,
    ) = ReminderRow(
        id = "rm_t",
        ownerKind = 0,
        ownerId = "r_t",
        notifyOn = notifyOn,
        alarmOn = alarmOn,
        timeOfDay = timeOfDay,
        repeatRule = repeatRule,
        offsetDays = offsetDays,
        enabled = enabled,
    )

    private fun weekly(mask: Int) = Rule(
        id = "r_t",
        repeatMode = RepeatMode.WEEKLY,
        startDate = "2026-10-01",
        weekdaysMask = mask,
    )

    private fun everyN(n: Int) = Rule(
        id = "r_t",
        repeatMode = RepeatMode.EVERY,
        startDate = "2026-10-01",
        repeatEvery = n,
    )

    @Test
    fun 标题带前缀_方便在时钟App里认出来() {
        assertEquals("[Tool] 健身", SystemAlarmPlanner.labelOf("健身"))
        assertEquals("[Tool] 健身", SystemAlarmPlanner.labelOf("  健身 "))
    }

    @Test
    fun 每周一到周五_重复规则1_翻译成五个系统星期() {
        val spec = SystemAlarmPlanner.spec(
            weekly(31), reminder(repeatRule = 1), "工作日常规", at(2026, 10, 26, 9, 0), zone,
        )!!
        // Calendar：SUNDAY=1 … SATURDAY=7 → 周一~周五 = 2,3,4,5,6
        assertEquals(listOf(2, 3, 4, 5, 6), spec.days)
        assertEquals(9, spec.hour)
        assertEquals(0, spec.minute)
        assertEquals("[Tool] 工作日常规", spec.label)
        assertNull(spec.oneShotDate)
    }

    @Test
    fun 每周一到周五_重复规则0_只保留周期第一个命中星期() {
        val spec = SystemAlarmPlanner.spec(
            weekly(31), reminder(repeatRule = 0), "工作日常规", at(2026, 10, 26, 9, 0), zone,
        )!!
        // 只在周一响 → 系统闹钟只重复周一
        assertEquals(listOf(2), spec.days)
    }

    @Test
    fun 周一加周日_跨周边界的星期映射() {
        // bit0=周一, bit6=周日 → mask = 1 + 64 = 65
        val spec = SystemAlarmPlanner.spec(
            weekly(65), reminder(repeatRule = 1), "跨周", at(2026, 10, 26, 9, 0), zone,
        )!!
        assertEquals(listOf(1, 2), spec.days)
    }

    @Test
    fun 每N天_系统闹钟表达不了_降级成一次性() {
        val fireAt = at(2026, 10, 28, 9, 0)
        val spec = SystemAlarmPlanner.spec(everyN(3), reminder(), "单词打卡", fireAt, zone)!!
        assertTrue(spec.days.isEmpty())
        assertEquals("2026-10-28", spec.oneShotDate)
        assertEquals(9, spec.hour)
    }

    @Test
    fun 每周规则带offsetDays_星期对不上_也降级成一次性() {
        val spec = SystemAlarmPlanner.spec(
            weekly(31), reminder(offsetDays = -1), "提前一天", at(2026, 10, 26, 9, 0), zone,
        )!!
        assertTrue(spec.days.isEmpty())
        assertNotNull(spec.oneShotDate)
    }

    @Test
    fun 每周规则的指纹与日期无关_不会每次启动都新建() {
        val a = SystemAlarmPlanner.spec(weekly(31), reminder(), "日常", at(2026, 10, 26, 9, 0), zone)!!
        val b = SystemAlarmPlanner.spec(weekly(31), reminder(), "日常", at(2026, 11, 2, 9, 0), zone)!!
        assertEquals(a.fingerprint, b.fingerprint)
    }

    @Test
    fun 一次性闹钟的指纹含日期_响过之后才会推进到下一条() {
        val a = SystemAlarmPlanner.spec(everyN(3), reminder(), "背单词", at(2026, 10, 28, 9, 0), zone)!!
        val b = SystemAlarmPlanner.spec(everyN(3), reminder(), "背单词", at(2026, 10, 31, 9, 0), zone)!!
        assertTrue(a.fingerprint != b.fingerprint)
    }

    @Test
    fun 已有同指纹的闹钟_不再创建() {
        val spec = SystemAlarmPlanner.spec(weekly(31), reminder(), "日常", at(2026, 10, 26, 9, 0), zone)!!
        val existing = recordOf(spec, ruleId = "r_t")
        val plan = SystemAlarmPlanner.plan(spec, existing)
        assertTrue("同一时刻同一星期集合不能重复建", !plan.create)
        assertNull(plan.stale)
    }

    @Test
    fun 改了时间_创建新闹钟并提示旧的要手动删() {
        val old = SystemAlarmPlanner.spec(
            weekly(31), reminder(timeOfDay = "09:00"), "日常", at(2026, 10, 26, 9, 0), zone,
        )!!
        val now = SystemAlarmPlanner.spec(
            weekly(31), reminder(timeOfDay = "21:00"), "日常", at(2026, 10, 26, 21, 0), zone,
        )!!
        val plan = SystemAlarmPlanner.plan(now, recordOf(old, ruleId = "r_t"))
        assertTrue(plan.create)
        assertEquals("[Tool] 日常", plan.stale)
    }

    @Test
    fun 没有旧记录_直接创建() {
        val spec = SystemAlarmPlanner.spec(weekly(31), reminder(), "日常", at(2026, 10, 26, 9, 0), zone)!!
        assertTrue(SystemAlarmPlanner.plan(spec, null).create)
    }

    @Test
    fun 只开通知_不生成系统闹钟() {
        assertNull(SystemAlarmPlanner.spec(everyN(1), reminder(alarmOn = false), "日常", at(2026, 10, 26, 9, 0), zone))
    }

    @Test
    fun 时间脏数据_不生成系统闹钟() {
        assertNull(
            SystemAlarmPlanner.spec(weekly(31), reminder(timeOfDay = "9:0"), "日常", at(2026, 10, 26, 9, 0), zone),
        )
    }

    @Test
    fun 提醒被关掉_不生成系统闹钟() {
        assertNull(
            SystemAlarmPlanner.spec(weekly(31), reminder(enabled = false), "日常", at(2026, 10, 26, 9, 0), zone),
        )
    }

    private fun recordOf(spec: SystemAlarmSpec, ruleId: String) = SystemAlarmRecord(
        ruleId = ruleId,
        reminderId = "rm_t",
        label = spec.label,
        hour = spec.hour,
        minute = spec.minute,
        days = spec.days,
        fingerprint = spec.fingerprint,
        createdAt = 0,
    )
}
