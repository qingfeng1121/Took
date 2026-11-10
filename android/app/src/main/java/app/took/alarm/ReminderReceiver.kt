package app.took.alarm

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import app.took.data.ReminderRow
import app.took.data.RuleRow
import app.took.data.TookDb
import app.took.data.TookRepository

/**
 * 提醒到点的入口（定稿 §6.3.4 的「触发」那一步）：BroadcastReceiver → 查库 → 发通知 / 起全屏闹钟。
 *
 * 三件事严格解耦：
 *  - **响 ≠ 打卡**：这里一行 completion 都不写，打卡还是用户自己在月历里点；
 *  - 通知与闹钟是两个独立分支，各自走自己的渠道与 PendingIntent；
 *  - 响完立刻排下一次，不依赖应用下次启动。
 */
class ReminderReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        val reminderId = intent.getStringExtra(ReminderNotifier.EXTRA_REMINDER_ID) ?: return
        when (intent.action) {
            ReminderScheduler.ACTION_FIRE -> onFire(context, reminderId)
            ACTION_SNOOZE -> onSnooze(
                context,
                reminderId,
                intent.getIntExtra(ReminderNotifier.EXTRA_SNOOZE_MIN, 0),
            )
            ACTION_STOP -> onStop(context, reminderId)
        }
    }

    private fun onFire(context: Context, reminderId: String) {
        val repo = TookRepository(TookDb.shared(context))
        val reminder = repo.reminder(reminderId)
        val rule = reminder?.let { repo.rule(it.ownerId) }
        if (reminder == null || reminder.deleted != 0 || !reminder.enabled ||
            (!reminder.notifyOn && !reminder.alarmOn) || rule == null
        ) {
            // 提醒已被删 / 关掉：顺手把这个僵尸闹钟与通知清干净
            ReminderScheduler(context, repo).rescheduleAll()
            return
        }

        val body = ReminderNotifier.bodyOf(reminder.notifyText, rule.title)
        var posted = false
        if (reminder.notifyOn) {
            posted = ReminderNotifier.post(
                context, reminder.id, rule.id, rule.title, body,
                alarm = false, snoozeMin = 0,
            ) or posted
        }
        // 闹钟已经交给系统时钟时，响铃/贪睡/界面全归时钟 App —— 这里绝不能再响一次
        val clockOwns = repo.systemAlarm(rule.id)?.reminderId == reminder.id
        if (reminder.alarmOn && !clockOwns) {
            posted = ReminderNotifier.post(
                context, reminder.id, rule.id, rule.title, body,
                alarm = true, snoozeMin = reminder.snoozeMin,
            ) or posted
            // fullScreenIntent 是官方路径；直启 Activity 只是 MIUI 上多一次机会（10+ 后台启动可能被拦，
            // 拦了就由通知接管，反正两者指向同一个 singleTask Activity，不会叠两个界面）
            startRing(context, reminder, rule, body)
        }
        if (!posted && reminder.notifyOn) {
            // 没给 POST_NOTIFICATIONS：闹钟照样响了（AlarmManager 不需要通知权限），
            // 但用户看不到任何东西 —— 这条日志就是「UI 显示未授权」之外的服务端证据
            Log.w(TAG, "提醒 ${reminderId} 已触发，但通知被系统拒收（未授予 POST_NOTIFICATIONS）")
        }

        ReminderScheduler(context, repo).afterFire(reminder, rule, System.currentTimeMillis())
    }

    private fun startRing(
        context: Context,
        reminder: ReminderRow,
        rule: RuleRow,
        body: String,
    ) {
        val i = AlarmRingActivity.intent(
            context = context,
            reminderId = reminder.id,
            ruleId = rule.id,
            title = rule.title,
            text = body,
            snoozeMin = reminder.snoozeMin,
        ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        try {
            context.startActivity(i)
        } catch (e: Exception) {
            Log.w(TAG, "直启全屏闹钟被系统拦下，交给 fullScreenIntent：${e.message}")
        }
    }

    private fun onSnooze(context: Context, reminderId: String, snoozeMin: Int) {
        val repo = TookRepository(TookDb.shared(context))
        val reminder = repo.reminder(reminderId) ?: return
        val rule = repo.rule(reminder.ownerId) ?: return
        ReminderNotifier.cancel(context, reminderId)
        val at = ReminderScheduler(context, repo).snooze(reminder, rule, snoozeMin)
        Log.i(TAG, "贪睡 $snoozeMin 分钟 → ${at ?: "不贪睡（snooze_min=0）"}")
    }

    private fun onStop(context: Context, reminderId: String) {
        ReminderNotifier.cancel(context, reminderId)
        val repo = TookRepository(TookDb.shared(context))
        ReminderScheduler(context, repo).rescheduleAll()
    }

    companion object {
        const val ACTION_SNOOZE = "app.took.action.REMINDER_SNOOZE"
        const val ACTION_STOP = "app.took.action.REMINDER_STOP"
        private const val TAG = "TookReminder"
    }
}
