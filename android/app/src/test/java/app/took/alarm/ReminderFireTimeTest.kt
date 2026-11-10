package app.took.alarm

import app.took.data.ReminderRow
import app.took.engine.RepeatMode
import app.took.engine.Rule
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.LocalDateTime
import java.time.ZoneId

/**
 * 「下一次触发时刻怎么算」的逐条断言（定稿 §6.3.4）。
 *
 * 这是本轮唯一必须靠单测锁死的东西：AlarmManager / 通知 / 全屏都只能真机验证，
 * 但**什么时候该响**是纯函数，写错了真机只会安静地少响一次，肉眼几乎发现不了。
 *
 * 时区固定 Asia/Shanghai，所有时间点都是「墙上时间」，避免抖动。
 * 2026-10-19 是周一（与 TookDb 种子里的「本周起始日」一致），下面所有周几都按这个推。
 */
class ReminderFireTimeTest {

    private val zone = ZoneId.of("Asia/Shanghai")

    private fun at(y: Int, mo: Int, d: Int, h: Int, mi: Int): Long =
        LocalDateTime.of(y, mo, d, h, mi).atZone(zone).toInstant().toEpochMilli()

    private fun reminder(
        notifyOn: Boolean = true,
        alarmOn: Boolean = false,
        timeOfDay: String = "21:00",
        repeatRule: Int = 1,
        snoozeMin: Int = 0,
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
        snoozeMin = snoozeMin,
        offsetDays = offsetDays,
        enabled = enabled,
    )

    /** 每天命中（repeat_mode=1，每 1 天）。 */
    private fun daily(start: String = "2026-01-01", until: String? = null) = Rule(
        id = "r_t",
        repeatMode = RepeatMode.EVERY,
        startDate = start,
        repeatEvery = 1,
        repeatUntil = until,
    )

    /** 周一~周五（mask=31）。 */
    private fun workdays(until: String? = null) = Rule(
        id = "r_t",
        repeatMode = RepeatMode.WEEKLY,
        startDate = "2026-10-01",
        weekdaysMask = 31,
        repeatUntil = until,
    )

    @Test
    fun 通知_时间还没到_就今天响() {
        val point = ReminderFireTime.nextFire(
            daily(), reminder(timeOfDay = "21:00"), at(2026, 10, 20, 8, 0), zone,
        )
        assertEquals("2026-10-20", point?.fireDate)
        assertEquals(at(2026, 10, 20, 21, 0), point?.fireAt)
    }

    @Test
    fun 通知_时间已经过去_跳到明天同一时刻() {
        val point = ReminderFireTime.nextFire(
            daily(), reminder(timeOfDay = "21:00"), at(2026, 10, 20, 22, 30), zone,
        )
        assertEquals("2026-10-21", point?.occurDate)
        assertEquals(at(2026, 10, 21, 21, 0), point?.fireAt)
    }

    @Test
    fun 恰好等于当前分钟_视为已过_不补响() {
        // 「现在就是 21:00:00」这一毫秒不能立刻响，否则每次打开应用都会炸一次提醒
        val now = at(2026, 10, 20, 21, 0)
        val point = ReminderFireTime.nextFire(daily(), reminder(timeOfDay = "21:00"), now, zone)
        assertEquals("2026-10-21", point?.occurDate)
    }

    @Test
    fun repeatRule1_每个命中日都响_周三的下一次是周四() {
        // 2026-10-21 周三 10:00，09:00 已过 → 下一个命中日是周四
        val point = ReminderFireTime.nextFire(
            workdays(), reminder(timeOfDay = "09:00", repeatRule = 1), at(2026, 10, 21, 10, 0), zone,
        )
        assertEquals("2026-10-22", point?.occurDate)
        // 周期归属仍是本周的周一（契约 §3.3），不是触发当天
        assertEquals("2026-10-19", point?.periodStart)
    }

    @Test
    fun repeatRule1_周四的时间还没到_就是今天() {
        val point = ReminderFireTime.nextFire(
            workdays(), reminder(timeOfDay = "09:00", repeatRule = 1), at(2026, 10, 22, 8, 0), zone,
        )
        assertEquals("2026-10-22", point?.occurDate)
    }

    @Test
    fun repeatRule0_只在周期第一个命中日响_周三跳过到下周() {
        // 周一 10-19 是这个周期第一个命中日，已经过去 → 只能等 10-26（下周一）
        val point = ReminderFireTime.nextFire(
            workdays(), reminder(timeOfDay = "09:00", repeatRule = 0), at(2026, 10, 21, 10, 0), zone,
        )
        assertEquals("2026-10-26", point?.occurDate)
        assertEquals("2026-10-26", point?.periodStart)
    }

    @Test
    fun repeatRule0_周一还没到点_就今天响() {
        val point = ReminderFireTime.nextFire(
            workdays(), reminder(timeOfDay = "09:00", repeatRule = 0), at(2026, 10, 26, 8, 0), zone,
        )
        assertEquals("2026-10-26", point?.occurDate)
    }

    @Test
    fun repeatRule0_周一到周五里只有周一算周期首日() {
        val rule = workdays()
        assertTrue(ReminderFireTime.isFirstHitOfPeriod(rule, java.time.LocalDate.of(2026, 10, 19)))
        assertFalse(ReminderFireTime.isFirstHitOfPeriod(rule, java.time.LocalDate.of(2026, 10, 21)))
        assertFalse(ReminderFireTime.isFirstHitOfPeriod(rule, java.time.LocalDate.of(2026, 10, 23)))
        // 下周一又是新的周期首日
        assertTrue(ReminderFireTime.isFirstHitOfPeriod(rule, java.time.LocalDate.of(2026, 10, 26)))
    }

    @Test
    fun repeatRule0_每N天规则_只在每段的头一天响() {
        val rule = Rule(
            id = "r_t",
            repeatMode = RepeatMode.EVERY,
            startDate = "2026-10-01",
            repeatEvery = 3,
        )
        // 段：[10-01,10-04) / [10-04,10-07) …；每段的头一天分别是 10-01、10-04、10-07
        assertTrue(ReminderFireTime.isFirstHitOfPeriod(rule, java.time.LocalDate.of(2026, 10, 1)))
        assertFalse(ReminderFireTime.isFirstHitOfPeriod(rule, java.time.LocalDate.of(2026, 10, 2)))
        assertTrue(ReminderFireTime.isFirstHitOfPeriod(rule, java.time.LocalDate.of(2026, 10, 4)))
        assertFalse(ReminderFireTime.isFirstHitOfPeriod(rule, java.time.LocalDate.of(2026, 10, 5)))
        // now = 10-02，只有 10-04 才是下一次（10-01 已过，10-02/10-03 不在头一天）
        val point = ReminderFireTime.nextFire(
            rule, reminder(timeOfDay = "09:00", repeatRule = 0), at(2026, 10, 2, 8, 0), zone,
        )
        assertEquals("2026-10-04", point?.occurDate)
    }

    @Test
    fun 跨天_月末到次月() {
        val point = ReminderFireTime.nextFire(
            daily(), reminder(timeOfDay = "09:00"), at(2026, 10, 31, 22, 30), zone,
        )
        assertEquals("2026-11-01", point?.fireDate)
        assertEquals(at(2026, 11, 1, 9, 0), point?.fireAt)
    }

    @Test
    fun 跨天_年末到次年() {
        val point = ReminderFireTime.nextFire(
            daily(), reminder(timeOfDay = "08:30"), at(2026, 12, 31, 23, 0), zone,
        )
        assertEquals("2027-01-01", point?.fireDate)
        assertEquals(at(2027, 1, 1, 8, 30), point?.fireAt)
    }

    @Test
    fun offsetDays为负数_提前三天响_命中日仍是当天() {
        val rule = Rule(
            id = "r_t",
            repeatMode = RepeatMode.MONTHLY,
            startDate = "2026-01-01",
            monthDay = 20,
        )
        val point = ReminderFireTime.nextFire(
            rule, reminder(timeOfDay = "09:00", offsetDays = -3), at(2026, 10, 1, 0, 0), zone,
        )
        assertEquals("2026-10-20", point?.occurDate)
        assertEquals("2026-10-17", point?.fireDate)
        assertEquals(at(2026, 10, 17, 9, 0), point?.fireAt)
    }

    @Test
    fun offsetDays为正数_延后两天响() {
        val rule = Rule(
            id = "r_t",
            repeatMode = RepeatMode.MONTHLY,
            startDate = "2026-01-01",
            monthDay = 20,
        )
        val point = ReminderFireTime.nextFire(
            rule, reminder(timeOfDay = "09:00", offsetDays = 2), at(2026, 10, 1, 0, 0), zone,
        )
        assertEquals("2026-10-22", point?.fireDate)
    }

    @Test
    fun 每年规则_返回明年那一天() {
        val rule = Rule(
            id = "r_t",
            repeatMode = RepeatMode.YEARLY,
            startDate = "2026-01-01",
            yearMonth = 3,
            yearDay = 15,
        )
        val point = ReminderFireTime.nextFire(
            rule, reminder(timeOfDay = "09:00"), at(2026, 10, 24, 12, 0), zone,
        )
        assertEquals("2027-03-15", point?.occurDate)
    }

    @Test
    fun 只开闹钟也照样算得出来() {
        val point = ReminderFireTime.nextFire(
            daily(), reminder(notifyOn = false, alarmOn = true, timeOfDay = "06:30"),
            at(2026, 10, 20, 6, 0), zone,
        )
        assertEquals(at(2026, 10, 20, 6, 30), point?.fireAt)
    }

    @Test
    fun 提醒被关掉_算不出来() {
        assertNull(
            ReminderFireTime.nextFire(
                daily(), reminder(enabled = false), at(2026, 10, 20, 8, 0), zone,
            ),
        )
    }

    @Test
    fun 两个开关都关_算不出来() {
        assertNull(
            ReminderFireTime.nextFire(
                daily(), reminder(notifyOn = false, alarmOn = false), at(2026, 10, 20, 8, 0), zone,
            ),
        )
    }

    @Test
    fun 时间脏数据_算不出来而不是抛异常() {
        assertNull(ReminderFireTime.timeOfDay("25:00"))
        assertNull(ReminderFireTime.timeOfDay("9:00"))
        assertNull(
            ReminderFireTime.nextFire(
                daily(), reminder(timeOfDay = "25:00"), at(2026, 10, 20, 8, 0), zone,
            ),
        )
    }

    @Test
    fun 规则已结束_算不出来() {
        assertNull(
            ReminderFireTime.nextFire(
                daily(until = "2026-10-01"), reminder(), at(2026, 10, 20, 8, 0), zone,
            ),
        )
    }

    @Test
    fun 连续三个触发点_按时间升序且逐日() {
        val points = ReminderFireTime.nextFires(
            daily(), reminder(timeOfDay = "09:00"), at(2026, 10, 20, 10, 0), zone, limit = 3,
        )
        assertEquals(3, points.size)
        assertEquals(
            listOf("2026-10-21", "2026-10-22", "2026-10-23"),
            points.map { it.fireDate },
        )
        assertTrue(points[0].fireAt < points[1].fireAt)
        assertTrue(points[1].fireAt < points[2].fireAt)
    }

    @Test
    fun 贪睡0分钟等于不贪睡() {
        assertNull(ReminderFireTime.snoozeAt(1_000_000L, 0))
        assertNull(ReminderFireTime.snoozeAt(1_000_000L, -5))
    }

    @Test
    fun 贪睡5分钟_往后推300000毫秒() {
        assertEquals(1_300_000L, ReminderFireTime.snoozeAt(1_000_000L, 5))
    }

    @Test
    fun 同一墙上时间在不同时区的毫秒值不同_按设备时区算() {
        val now = at(2026, 10, 20, 8, 0)
        val shanghai = ReminderFireTime.nextFire(daily(), reminder(timeOfDay = "21:00"), now, zone)
        val utc = ReminderFireTime.nextFire(
            daily(), reminder(timeOfDay = "21:00"), now, ZoneId.of("UTC"),
        )
        // 「21:00」是墙上时间：上海比 UTC 早 8 小时，所以同一时刻的毫秒值少 8 小时
        assertTrue(utc!!.fireAt - shanghai!!.fireAt == 8L * 3_600_000L)
    }

    @Test
    fun 默认通知文案_空则用规则名() {
        assertEquals("该打卡了：健身", ReminderNotifier.bodyOf(null, "健身"))
        assertEquals("该打卡了：健身", ReminderNotifier.bodyOf("   ", "健身"))
        assertEquals("该练了", ReminderNotifier.bodyOf("该练了", "健身"))
    }

    @Test
    fun 请求码只由提醒id决定_同一提醒永远同一码() {
        val a = ReminderScheduler.stableRequestCode("rm_abcd")
        assertEquals(a, ReminderScheduler.stableRequestCode("rm_abcd"))
        assertTrue(ReminderScheduler.stableRequestCode("rm_other") != a)
        // 低位留给贪睡/动作，两者不重叠（定稿 §6.3.4 的「互相覆盖」就是这个坑）
        assertTrue(ReminderScheduler.snoozeCode("rm_abcd") != a)
    }
}
