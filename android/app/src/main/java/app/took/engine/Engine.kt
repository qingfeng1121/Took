// 周期打卡的重复规则引擎 —— 与 docs/本地优先契约.md 第 3 节逐字对齐。
//
// 三条不可违反的约定（契约 §3.4）：
//  1. 日期一律 'YYYY-MM-DD' 字符串，绝不用 epoch 毫秒 —— 跨时区/夏令时会整片漂移一格。
//  2. 非法日期格式必须抛错，不得静默兜底。
//  3. 周期由规则算出，打卡以 (task_id, period_start) 为键，同一周期内所有命中日共享状态。
package app.took.engine

import java.time.LocalDate
import java.time.temporal.ChronoUnit

/** 重复方式，与 docs/schema/rule.schema.json 的 repeat_mode 一一对应。 */
object RepeatMode {
    const val WEEKLY = 0   // 每周固定几天
    const val EVERY = 1    // 每 N 天
    const val MONTHLY = 2  // 每月某日
    const val YEARLY = 3   // 每年某月某日
    const val NONE = 4     // 不重复
}

/** month_day = -1 表示「每月最后一天」。 */
const val MONTH_DAY_LAST = -1

/**
 * 参与命中判定的规则字段子集（不关心同步四件套）。
 * 可空语义：endDate / repeatUntil 为 null 表示不限。
 */
data class Rule(
    val id: String,
    val repeatMode: Int,
    val startDate: String,
    val weekdaysMask: Int = 0,
    val repeatEvery: Int = 0,
    val monthDay: Int = 0,
    val yearMonth: Int = 0,
    val yearDay: Int = 0,
    val endDate: String? = null,
    val repeatUntil: String? = null,
)

object DateKeys {
    private val PATTERN = Regex("""^\d{4}-\d{2}-\d{2}$""")

    /** 解析 'YYYY-MM-DD'；'2026-1-5'、'2026/10/01' 一律抛 IllegalArgumentException。 */
    fun parse(key: String): LocalDate {
        if (!PATTERN.matches(key)) {
            throw IllegalArgumentException("日期必须是 YYYY-MM-DD：\"$key\"")
        }
        // 2026-02-30 这类能过正则但不是真实日期的，同样必须报错而不是被静默调整
        return LocalDate.parse(key)
    }

    /** 把 LocalDate 格式化成 'YYYY-MM-DD'。 */
    fun key(date: LocalDate): String = date.toString()

    /** 整日差，正数表示 b 晚于 a。 */
    fun daysBetween(a: LocalDate, b: LocalDate): Long = ChronoUnit.DAYS.between(a, b)
}

object Engine {

    /**
     * 契约 §3.1：bit0=周一 … bit6=周日。
     * Kotlin 的 DayOfWeek：MONDAY=1 … SUNDAY=7，所以位号 = value - 1。
     * 注意别写成 Go 的 (weekday+6)%7 —— 这里没有「周日=0」这回事。
     */
    private fun weekdayBit(date: LocalDate): Int = date.dayOfWeek.value - 1

    /**
     * 该月实际命中的日号。monthDay=-1 取当月最后一天；超过当月天数时钳制到月末，
     * 但**不改写用户填的值**（填 31，2 月落 28，3 月仍回 31）。
     */
    fun monthTargetDay(monthDay: Int, year: Int, month: Int): Int {
        val last = LocalDate.of(year, month, 1).lengthOfMonth()
        if (monthDay == MONTH_DAY_LAST) return last
        return if (monthDay > last) last else monthDay
    }

    private fun inRange(rule: Rule, date: LocalDate): Boolean {
        val start = DateKeys.parse(rule.startDate)
        if (date.isBefore(start)) return false
        val upper = rule.repeatUntil?.takeIf { it.isNotBlank() }
            ?: rule.endDate?.takeIf { it.isNotBlank() }
            ?: return true
        return !date.isAfter(DateKeys.parse(upper))
    }

    /** 契约 §3.2：命中判定。 */
    fun occursOn(rule: Rule, date: String): Boolean {
        val d = DateKeys.parse(date)
        if (!inRange(rule, d)) return false
        return when (rule.repeatMode) {
            RepeatMode.NONE -> DateKeys.key(DateKeys.parse(rule.startDate)) == date
            RepeatMode.WEEKLY -> {
                val bit = weekdayBit(d)
                (rule.weekdaysMask shr bit) and 1 == 1
            }
            RepeatMode.EVERY -> {
                if (rule.repeatEvery < 1) return false
                val days = DateKeys.daysBetween(DateKeys.parse(rule.startDate), d)
                days >= 0 && days % rule.repeatEvery == 0L
            }
            RepeatMode.MONTHLY ->
                d.dayOfMonth == monthTargetDay(rule.monthDay, d.year, d.monthValue)
            RepeatMode.YEARLY -> {
                if (d.monthValue != rule.yearMonth) return false
                val last = d.lengthOfMonth()
                val target = if (rule.yearDay > last) last else rule.yearDay // 2/29 平年落 2/28，不溢出到 3/1
                d.dayOfMonth == target
            }
            else -> false
        }
    }

    /** 契约 §3.3：周期归属，返回该周期的起始日 'YYYY-MM-DD'。 */
    fun periodStartOf(rule: Rule, date: String): String {
        val d = DateKeys.parse(date)
        return when (rule.repeatMode) {
            RepeatMode.WEEKLY -> DateKeys.key(d.minusDays(weekdayBit(d).toLong())) // 周一为一周之始
            RepeatMode.EVERY -> {
                require(rule.repeatEvery >= 1) { "repeat_every 必须 >= 1，实际 ${rule.repeatEvery}" }
                val start = DateKeys.parse(rule.startDate)
                val days = DateKeys.daysBetween(start, d)
                require(days >= 0) { "$date 早于规则起始日 ${rule.startDate}" }
                DateKeys.key(start.plusDays((days / rule.repeatEvery) * rule.repeatEvery))
            }
            else -> DateKeys.key(d) // monthly / yearly / none：一个周期就是一天
        }
    }

    /** 打卡键 = taskId + ":" + periodStart。 */
    fun completionKey(taskId: String, periodStart: String): String = "$taskId:$periodStart"
}
