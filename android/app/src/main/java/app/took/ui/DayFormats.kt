package app.took.ui

import app.took.engine.DateKeys

/** 日期只做展示格式化，一律从 'YYYY-MM-DD' 字符串算，不碰时间戳。 */
object DayFormats {
    private val WEEKDAYS = listOf("周一", "周二", "周三", "周四", "周五", "周六", "周日")

    /** "10 月 23 日 周五" */
    fun dayWithWeekday(key: String): String {
        val d = DateKeys.parse(key)
        // Kotlin 的 DayOfWeek：MONDAY=1 … SUNDAY=7
        return "${d.monthValue} 月 ${d.dayOfMonth} 日 ${WEEKDAYS[d.dayOfWeek.value - 1]}"
    }
}
