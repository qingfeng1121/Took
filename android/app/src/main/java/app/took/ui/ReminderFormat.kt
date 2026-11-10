package app.took.ui

import app.took.data.ReminderRow

/**
 * 提醒摘要（契约 §11.3）：规则列表上显示「通知 21:00 + 闹钟 09:00」。
 *
 * 与 prototype/android.html 的 remindText 同一口径：两个通道各自带时间、用「 + 」拼接；
 * 都没有则「不提醒」（正常不会出现——两个都关的行在写入层就被拦下，见 §11.1）。
 */
object ReminderFormat {

    const val NONE = "不提醒"

    fun summary(row: ReminderRow): String = summaryOf(row.notifyOn, row.alarmOn, row.timeOfDay)

    fun summaryOf(notifyOn: Boolean, alarmOn: Boolean, timeOfDay: String): String {
        val time = timeOfDay.ifBlank { "09:00" }
        val parts = ArrayList<String>(2)
        if (notifyOn) parts += "通知 $time"
        if (alarmOn) parts += "闹钟 $time"
        return if (parts.isEmpty()) NONE else parts.joinToString(" + ")
    }
}
