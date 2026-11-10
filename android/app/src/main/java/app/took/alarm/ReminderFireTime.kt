package app.took.alarm

import app.took.data.ReminderRow
import app.took.engine.DateKeys
import app.took.engine.Engine
import app.took.engine.Rule
import java.time.Instant
import java.time.LocalDate
import java.time.LocalTime
import java.time.ZoneId

/**
 * 一个真实触发点：`reminder` 行 + 规则 + 时间算出来的「哪一刻响」。
 *
 * occurDate 是**周期命中日**（Engine.occursOn 为真的那天），fireDate 是它加上
 * `offset_days` 之后的**实际触发日**（倒数日提前 N 天就是这里为负）。
 * 两者相同是任务类提醒的常态。
 */
data class FirePoint(
    val fireAt: Long,
    val occurDate: String,
    val fireDate: String,
    val periodStart: String,
)

/**
 * 「下一次触发时刻」的纯计算（契约 §11.2 + 定稿 §6.3.4）。
 *
 * 这里**不碰任何 Android 类**：AlarmManager / 通知 / 权限都在 [ReminderScheduler] 与
 * [ReminderNotifier] 里。之所以把这段拆出来，是因为它才是提醒唯一真正会算错的地方
 * （repeat_rule、跨天、已过时刻、offset_days、规则结束），必须能在 JVM 单测里逐条断言，
 * 而不是靠真机等 2 分钟看有没有响。
 */
object ReminderFireTime {

    /** 往后最多找这么多天。规则可能整整一年才命中一次（repeat_mode=YEARLY），所以横向给到 400 天。 */
    const val HORIZON_DAYS = 400

    /** 与 reminder.schema.json 的 time_of_day pattern 逐字一致。 */
    private val TIME_OF_DAY = Regex("^([01][0-9]|2[0-3]):[0-5][0-9]$")

    /**
     * 解析 HH:mm。返回 null = 这个提醒**不该响**（脏数据），调用方跳过而不是抛异常 ——
     * BroadcastReceiver 里抛异常等于闹钟静默失效，比不响更糟。
     */
    fun timeOfDay(text: String): LocalTime? {
        val t = text.trim()
        if (!TIME_OF_DAY.matches(t)) return null
        return LocalTime.of(t.substring(0, 2).toInt(), t.substring(3, 5).toInt())
    }

    /**
     * `occurDate` 是否是它所在周期里的**第一个命中日**（`repeat_rule=0` 只在这天响）。
     *
     * 做法就是老老实实从周期起始日往后走：周一起始的周规则里，周一命中就返回「周一才是第一个」，
     * 于是周三查出来 false。monthly / yearly / none 的周期只有一天，恒为 true。
     */
    fun isFirstHitOfPeriod(rule: Rule, occurDate: LocalDate): Boolean {
        val periodStart = DateKeys.parse(Engine.periodStartOf(rule, occurDate.toString()))
        var day = periodStart
        while (!day.isAfter(occurDate)) {
            if (Engine.occursOn(rule, day.toString())) return day == occurDate
            day = day.plusDays(1)
        }
        return false
    }

    /** 某天的 HH:mm 在给定时区里的毫秒时间戳。 */
    fun fireAt(date: LocalDate, time: LocalTime, zone: ZoneId): Long =
        date.atTime(time).atZone(zone).toInstant().toEpochMilli()

    /**
     * 从现在起往后的前 [limit] 个触发点（升序）。
     *
     * 跳过条件全部在这里，缺一不可：
     *  - 提醒行本身没生效（`enabled=0` / 两个开关都关）；
     *  - `time_of_day` 脏；
     *  - `repeat_rule=0` 且该命中日不是周期第一个命中日；
     *  - 触发时刻已经过去（**今天 21:00 的提醒在 21:30 打开应用，不能立刻补响一次**）；
     *  - 规则根本没命中，或者 400 天内都不会再命中（已结束的规则）。
     */
    fun nextFires(
        rule: Rule,
        reminder: ReminderRow,
        nowMillis: Long,
        zone: ZoneId = ZoneId.systemDefault(),
        limit: Int = 1,
    ): List<FirePoint> {
        if (!reminder.enabled || (!reminder.notifyOn && !reminder.alarmOn)) return emptyList()
        val time = timeOfDay(reminder.timeOfDay) ?: return emptyList()
        val today = Instant.ofEpochMilli(nowMillis).atZone(zone).toLocalDate()
        val out = ArrayList<FirePoint>(limit)
        // offset_days 为负时触发日早于命中日，所以从「今天」起扫而不是从触发日起扫；
        // 已经过去的触发时刻由 fireAt <= now 这一条统一滤掉。
        for (i in 0..HORIZON_DAYS) {
            val occur = today.plusDays(i.toLong())
            val occurKey = occur.toString()
            if (!occurs(rule, occurKey)) continue
            if (reminder.repeatRule == 0 && !isFirstHitOfPeriod(rule, occur)) continue
            val fireDate = occur.plusDays(reminder.offsetDays.toLong())
            val at = fireAt(fireDate, time, zone)
            if (at <= nowMillis) continue
            out += FirePoint(
                fireAt = at,
                occurDate = occurKey,
                fireDate = fireDate.toString(),
                periodStart = Engine.periodStartOf(rule, occurKey),
            )
            if (out.size >= limit) break
        }
        return out
    }

    /** 最近的一个触发点；null = 不会再有（已结束 / 关闭 / 脏数据）。 */
    fun nextFire(
        rule: Rule,
        reminder: ReminderRow,
        nowMillis: Long,
        zone: ZoneId = ZoneId.systemDefault(),
    ): FirePoint? = nextFires(rule, reminder, nowMillis, zone, 1).firstOrNull()

    /**
     * 贪睡：从 now 起 [snoozeMin] 分钟。0（或不合法）= 不贪睡，返回 null。
     * 契约 §11.2：`snooze_min = 0` 就是「不贪睡」，不是「贪睡 0 分钟」。
     */
    fun snoozeAt(nowMillis: Long, snoozeMin: Int): Long? =
        if (snoozeMin <= 0) null else nowMillis + snoozeMin * 60_000L

    /** 命中判定包一层：脏规则（repeat_every 非法等）当作不命中，不给 receiver 抛异常的机会。 */
    private fun occurs(rule: Rule, dateKey: String): Boolean =
        runCatching { Engine.occursOn(rule, dateKey) }.getOrDefault(false)
}
