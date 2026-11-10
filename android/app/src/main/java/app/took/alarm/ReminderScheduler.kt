package app.took.alarm

import android.util.Log

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import app.took.MainActivity
import app.took.data.ReminderRow
import app.took.data.RuleRow
import app.took.data.TookRepository

/** 一次全量重排的结果（UI 照实显示，不把所有情况都说成「已排上」）。 */
data class ScheduleReport(
    val scheduled: Int = 0,
    val cancelled: Int = 0,
    val exact: Boolean = true,
    val degraded: Boolean = false,
    val skipped: List<String> = emptyList(),
    /** 这次真递交给系统时钟的闹钟条数。 */
    val systemAlarms: Int = 0,
    /** 系统时钟用不了，闹钟回落到应用自己的全屏响铃。 */
    val systemFallback: Boolean = false,
    /** 需要用户去时钟 App 手动删掉的旧闹钟（Android 删不掉，只能告知）。 */
    val staleLabels: List<String> = emptyList(),
) {
    fun summary(): String {
        if (scheduled == 0 && systemAlarms == 0) return "没有需要排的提醒"
        val parts = ArrayList<String>(3)
        if (systemAlarms > 0) parts += "已交给系统时钟 $systemAlarms 条"
        if (scheduled > 0) {
            parts += if (degraded) {
                "已排 $scheduled 条（降级：缺精确闹钟权限，最多可能晚几十分钟）"
            } else if (exact) {
                "已排 $scheduled 条（精确）"
            } else {
                "已排 $scheduled 条（不精确）"
            }
        }
        if (systemFallback) parts += "系统时钟不可用，闹钟走应用内响铃"
        if (staleLabels.isNotEmpty()) {
            parts += "请在时钟 App 里删除旧闹钟：" + staleLabels.joinToString("、")
        }
        return parts.joinToString(" · ")
    }
}

/**
 * 把 `reminder` 表变成真的 AlarmManager 条目（定稿 §6.3.4）。
 *
 * 两条刻意的设计取舍：
 *  1. **每条提醒只注册「最近的一次」**，响过之后由 [ReminderReceiver] 立刻重排下一次。
 *     定稿原话是「未来 90 天滚动写入」，但那样 N 条规则 × 90 天 = 几百个 PendingIntent，
 *     取消/重排的成本和出错面都大得多；一条一次的效果等价，且 `dumpsys alarm` 里一眼能看清。
 *  2. **requestCode 只由 reminder_id 决定**（不是「hash shl 8 or dayIndex」）。稳定且唯一才是
 *     要害——定稿点名的那个经典 bug 是两条提醒互相覆盖，靠的正是「同一提醒永远同一 code」；
 *     混进 dayIndex 反而让「重排时取消旧的」变成猜谜。
 *
 * 精确性：`alarm_on=1` 且拿到精确闹钟权限 → `setAlarmClock()`（最强，深度休眠也准，状态栏带闹钟图标）；
 * 只发通知 → `setExactAndAllowWhileIdle()`；没权限 → `setAndAllowWhileIdle()` 并把
 * [ScheduleReport.degraded] 置 true，绝不假装精确。
 */
class ReminderScheduler(
    context: Context,
    private val repo: TookRepository,
    private val clock: () -> Long = System::currentTimeMillis,
) {

    private val appContext: Context = context.applicationContext

    fun canScheduleExact(): Boolean {
        if (android.os.Build.VERSION.SDK_INT < android.os.Build.VERSION_CODES.S) return true
        val am = appContext.getSystemService(AlarmManager::class.java) ?: return false
        return am.canScheduleExactAlarms()
    }

    /**
     * 全量重排：先按当前库算出每条提醒的下一触发点重新注册，再取消掉已经不该存在的条目。
     *
     * 调用时机：应用启动 / BOOT_COMPLETED / 时区或时间被改 / 保存或清除提醒之后 / 权限变化。
     */
    fun rescheduleAll(): ScheduleReport {
        val now = clock()
        val exact = canScheduleExact()
        val rules: Map<String, RuleRow> = repo.rules().associateBy { it.id }
        val reminders = repo.activeRuleReminders()
        var scheduled = 0
        var cancelled = 0
        var degraded = false
        var systemAlarms = 0
        var systemFallback = false
        val staleLabels = ArrayList<String>()
        val skipped = ArrayList<String>()
        val clockAvailable = SystemClockAlarm.clockAppAvailable(appContext)
        Log.i("TookReminder", "调度开始：clockAvailable=" + clockAvailable + " reminders=" + reminders.size)

        val alive = HashSet<String>()
        for ((ruleId, reminder) in reminders) {
            val rule = rules[ruleId]
            if (rule == null || !rule.enabled) {
                cancelled += cancelOne(reminder.id)
                continue
            }
            val point = ReminderFireTime.nextFire(rule.toEngine(), reminder, now)
            if (point == null) {
                // 规则已结束 / 400 天内不再命中：如实取消，不留下一个永不触发的假闹钟
                cancelled += cancelOne(reminder.id)
                repo.deleteSchedule(reminder.id)
                skipped += rule.title
                continue
            }
            // 闹钟优先交给系统时钟（用户要的是「跟系统统一」的那种闹钟）；
            // 交不出去才回落到应用自己的全屏响铃，绝不两套同时响。
            var ringHere = reminder.alarmOn
            if (reminder.alarmOn && clockAvailable) {
                val spec = SystemAlarmPlanner.spec(rule.toEngine(), reminder, rule.title, point.fireAt)
                if (spec != null) {
                    val plan = SystemAlarmPlanner.plan(spec, repo.systemAlarm(ruleId))
                    if (plan.create) {
                        if (SystemClockAlarm.hand(appContext, spec)) {
                            repo.putSystemAlarm(
                                SystemAlarmRecord(
                                    ruleId = ruleId,
                                    reminderId = reminder.id,
                                    label = spec.label,
                                    hour = spec.hour,
                                    minute = spec.minute,
                                    days = spec.days,
                                    fingerprint = spec.fingerprint,
                                    createdAt = now,
                                ),
                            )
                            systemAlarms++
                        } else {
                            systemFallback = true
                        }
                    }
                    plan.stale?.let { staleLabels += it }
                    // 已经（或刚刚）交给系统时钟：本机不再响铃，只保留「推进下一次」的定时
                    if (repo.systemAlarm(ruleId) != null) ringHere = false
                }
            } else if (reminder.alarmOn) {
                systemFallback = true
            }
            val precise = register(reminder, rule, point, exact, now, ringHere)
            if (!precise) degraded = true
            repo.putSchedule(
                ScheduleRow(
                    reminderId = reminder.id,
                    ruleId = ruleId,
                    occurDate = point.occurDate,
                    fireAt = point.fireAt,
                    snoozeCount = 0,
                    firedAt = null,
                    updatedAt = now,
                ),
            )
            alive += reminder.id
            scheduled++
        }

        // 库里已经没有对应提醒（被软删 / 关闭 / 规则被删）的调度条目一律清掉
        for (row in repo.schedules()) {
            if (row.reminderId in alive) continue
            cancelled += cancelOne(row.reminderId)
            repo.deleteSchedule(row.reminderId)
        }
        return ScheduleReport(
            scheduled = scheduled,
            cancelled = cancelled,
            exact = exact,
            degraded = degraded,
            skipped = skipped,
            systemAlarms = systemAlarms,
            systemFallback = systemFallback,
            staleLabels = staleLabels,
        )
    }

    /** 响过之后：把这一条标记 fired_at，并排上下一次。 */
    fun afterFire(reminder: ReminderRow, rule: RuleRow, firedAt: Long) {
        val now = clock()
        val point = ReminderFireTime.nextFire(rule.toEngine(), reminder, now)
        if (point == null) {
            cancelOne(reminder.id)
            repo.deleteSchedule(reminder.id)
            return
        }
        val clockOwns = repo.systemAlarm(rule.id) != null
        register(reminder, rule, point, canScheduleExact(), now, ringHere = !clockOwns)
        repo.putSchedule(
            ScheduleRow(
                reminderId = reminder.id,
                ruleId = rule.id,
                occurDate = point.occurDate,
                fireAt = point.fireAt,
                snoozeCount = repo.schedule(reminder.id)?.snoozeCount ?: 0,
                firedAt = firedAt,
                updatedAt = now,
            ),
        )
    }

    /**
     * 贪睡（定稿 §6.3.5）：按 snooze_min 再排一次**一次性**闹钟，用独立 requestCode，
     * 不覆盖下一次常规触发。返回实际排上的时刻；0 = 不贪睡，返回 null。
     */
    fun snooze(reminder: ReminderRow, rule: RuleRow, snoozeMin: Int): Long? {
        val now = clock()
        val at = ReminderFireTime.snoozeAt(now, snoozeMin) ?: return null
        val i = fireIntent(reminder.id, rule.id, at, snoozeFrom = true)
        val pi = PendingIntent.getBroadcast(
            appContext,
            snoozeCode(reminder.id),
            i,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val am = appContext.getSystemService(AlarmManager::class.java)
        val exact = canScheduleExact()
        try {
            if (exact) am?.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi)
            else am?.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi)
        } catch (e: SecurityException) {
            am?.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi)
        }
        val old = repo.schedule(reminder.id)
        if (old != null) {
            repo.putSchedule(
                old.copy(fireAt = at, snoozeCount = old.snoozeCount + 1, updatedAt = now),
            )
        } else {
            repo.putSchedule(
                ScheduleRow(
                    reminderId = reminder.id,
                    ruleId = rule.id,
                    occurDate = "",
                    fireAt = at,
                    snoozeCount = 1,
                    updatedAt = now,
                ),
            )
        }
        return at
    }

    /** 停止：取消通知与可能存在的贪睡闹钟，并保证常规的下一次还在。 */
    fun cancelSnooze(reminderId: String) {
        val am = appContext.getSystemService(AlarmManager::class.java) ?: return
        val pi = PendingIntent.getBroadcast(
            appContext,
            snoozeCode(reminderId),
            fireIntent(reminderId, "", 0L, snoozeFrom = true),
            PendingIntent.FLAG_NO_CREATE or PendingIntent.FLAG_IMMUTABLE,
        )
        if (pi != null) {
            am.cancel(pi)
            pi.cancel()
        }
    }

    /* ------------------------------- 内部 ------------------------------- */

    /**
     * [ringHere] = 这次触发要不要由**本应用**响铃（全屏 + 铃声 + 震动）。
     * 为 false 时只做「到点推进下一次」的登记，用 setExactAndAllowWhileIdle，不抢占任何界面。
     */
    private fun register(
        reminder: ReminderRow,
        rule: RuleRow,
        point: FirePoint,
        exact: Boolean,
        now: Long,
        ringHere: Boolean,
    ): Boolean {
        val am = appContext.getSystemService(AlarmManager::class.java) ?: return false
        val showPi = PendingIntent.getActivity(
            appContext,
            0,
            Intent(appContext, MainActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val pi = PendingIntent.getBroadcast(
            appContext,
            stableRequestCode(reminder.id),
            fireIntent(reminder.id, rule.id, point.fireAt, snoozeFrom = false),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        return try {
            when {
                ringHere && exact ->
                    am.setAlarmClock(AlarmManager.AlarmClockInfo(point.fireAt, showPi), pi)
                ringHere ->
                    // 没有精确闹钟权限：setAlarmClock 会直接抛 SecurityException，只能降级
                    am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, point.fireAt, pi)
                exact -> am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, point.fireAt, pi)
                else -> am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, point.fireAt, pi)
            }
            exact
        } catch (e: SecurityException) {
            am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, point.fireAt, pi)
            false
        }
    }

    private fun fireIntent(
        reminderId: String,
        ruleId: String,
        fireAt: Long,
        snoozeFrom: Boolean,
    ): Intent = Intent(appContext, ReminderReceiver::class.java).setAction(ACTION_FIRE).apply {
        putExtra(ReminderNotifier.EXTRA_REMINDER_ID, reminderId)
        putExtra(ReminderNotifier.EXTRA_RULE_ID, ruleId)
        putExtra(EXTRA_FIRE_AT, fireAt)
        putExtra(EXTRA_SNOOZE_FIRE, snoozeFrom)
    }

    private fun cancelOne(reminderId: String): Int {
        val am = appContext.getSystemService(AlarmManager::class.java) ?: return 0
        var n = 0
        val i = fireIntent(reminderId, "", 0L, snoozeFrom = false)
        PendingIntent.getBroadcast(
            appContext,
            stableRequestCode(reminderId),
            i,
            PendingIntent.FLAG_NO_CREATE or PendingIntent.FLAG_IMMUTABLE,
        )?.let {
            am.cancel(it)
            it.cancel()
            n++
        }
        cancelSnooze(reminderId)
        ReminderNotifier.cancel(appContext, reminderId)
        return n
    }

    companion object {
        const val ACTION_FIRE = "app.took.action.REMINDER_FIRE"
        const val EXTRA_FIRE_AT = "fire_at"
        const val EXTRA_SNOOZE_FIRE = "snooze"

        /**
         * 稳定且唯一的 requestCode：只由 reminder_id 决定，低位清零后给贪睡/动作留出互不重叠的槽位。
         * 同一个 reminder 的常规闹钟永远拿到同一个 code —— 重排时才能精确取消旧的（定稿 §6.3.4 的坑）。
         */
        fun stableRequestCode(reminderId: String): Int = (reminderId.hashCode() * 31) and 0x7FFFFF00

        fun snoozeCode(reminderId: String): Int = stableRequestCode(reminderId) or 0x1000
    }
}
