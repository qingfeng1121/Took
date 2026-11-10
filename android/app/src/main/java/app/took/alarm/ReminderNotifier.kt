package app.took.alarm

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.os.Build
import app.took.MainActivity
import app.took.R

/**
 * 通知渠道（定稿 §6.3.2）：普通通知走 DEFAULT，闹钟走 HIGH + 全屏。
 *
 * 渠道的 importance 一旦建过就改不了（系统限制），所以这里只在**首次创建**时定档；
 * 想改必须换 channel id。resume 时常驻复查权限，见 [ReminderPermissions]。
 */
object ReminderChannels {
    const val NOTIFY = "took_reminder_notify"
    const val ALARM = "took_alarm"

    fun ensure(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val nm = context.getSystemService(NotificationManager::class.java) ?: return
        if (nm.getNotificationChannel(NOTIFY) == null) {
            nm.createNotificationChannel(
                NotificationChannel(NOTIFY, "打卡提醒", NotificationManager.IMPORTANCE_DEFAULT).apply {
                    description = "到点提醒打卡：状态栏 + 提示音，不打断"
                },
            )
        }
        if (nm.getNotificationChannel(ALARM) == null) {
            nm.createNotificationChannel(
                NotificationChannel(ALARM, "打卡闹钟", NotificationManager.IMPORTANCE_HIGH).apply {
                    description = "到点闹钟：全屏 + 响铃 + 震动，必须手动停"
                    enableVibration(true)
                    vibrationPattern = longArrayOf(0, 1000, 1000)
                    lockscreenVisibility = Notification.VISIBILITY_PUBLIC
                    val alarm = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM)
                        ?: RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION)
                    if (alarm != null) {
                        setSound(
                            alarm,
                            AudioAttributes.Builder()
                                .setUsage(AudioAttributes.USAGE_ALARM)
                                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                                .build(),
                        )
                    }
                },
            )
        }
    }
}


/**
 * 发通知 / 发闹钟通知（含 fullScreenIntent）。
 *
 * 与调度层的分工：**能不能排上**是 [ReminderScheduler] 的事，**排上了但发不出去**是这里的事
 * （没给 POST_NOTIFICATIONS 时系统会静默丢掉）。所以这里如实返回是否真的递交给系统，
 * UI 才能说「未授权」而不是假装响过。
 */
object ReminderNotifier {

    const val EXTRA_REMINDER_ID = "reminder_id"
    const val EXTRA_RULE_ID = "rule_id"
    const val EXTRA_TITLE = "title"
    const val EXTRA_TEXT = "text"
    const val EXTRA_SNOOZE_MIN = "snooze_min"
    const val EXTRA_SNOOZE_COUNT = "snooze_count"
    /** 有没有通知权限。没给时系统会静默丢弃，所以发之前先问一句。 */
    fun canPost(context: Context): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
            context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) ==
            PackageManager.PERMISSION_GRANTED
    /** 通知正文：notify_text 优先，空则「该打卡了：<规则名>」（契约 §11.2）。 */
    fun bodyOf(notifyText: String?, ruleTitle: String): String =
        notifyText?.takeIf { it.isNotBlank() } ?: "该打卡了：$ruleTitle"

    fun notificationIdOf(reminderId: String): Int = ReminderScheduler.stableRequestCode(reminderId)

    /**
     * 递交一条提醒通知。[alarm]=true 时走高优先级渠道并挂 fullScreenIntent（拉起 [AlarmRingActivity]）。
     *
     * 返回 false = 系统层面拒收（没给通知权限），调用方据此记录「没发出去」。
     */
    fun post(
        context: Context,
        reminderId: String,
        ruleId: String,
        title: String,
        text: String,
        alarm: Boolean,
        snoozeMin: Int,
    ): Boolean {
        val nm = context.getSystemService(NotificationManager::class.java) ?: return false
        ReminderChannels.ensure(context)
        val channel = if (alarm) ReminderChannels.ALARM else ReminderChannels.NOTIFY
        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(context, channel)
        } else {
            Notification.Builder(context)
        }

        val openIntent = Intent(context, AlarmRingActivity::class.java).apply {
            putExtra(EXTRA_REMINDER_ID, reminderId)
            putExtra(EXTRA_RULE_ID, ruleId)
            putExtra(EXTRA_TITLE, title)
            putExtra(EXTRA_TEXT, text)
            putExtra(EXTRA_SNOOZE_MIN, snoozeMin)
        }
        val openPi = PendingIntent.getActivity(
            context,
            ReminderScheduler.stableRequestCode(reminderId),
            openIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        builder
            // 通知栏小图标：系统只取 alpha 并统一染白，所以必须是纯白单色矢量
            // （res/drawable/ic_stat_took.xml）。不能用启动图标——带彩色的小图标会变成白方块。
            .setSmallIcon(R.drawable.ic_stat_took)
            .setContentTitle(title)
            .setContentText(text)
            .setStyle(Notification.BigTextStyle().bigText(text))
            .setWhen(System.currentTimeMillis())
            .setShowWhen(true)
            .setContentIntent(if (alarm) openPi else appIntent(context))
            .setAutoCancel(!alarm)

        if (alarm) {
            builder.setCategory(Notification.CATEGORY_ALARM)
                .setOngoing(true)
                .setVisibility(Notification.VISIBILITY_PUBLIC)
                .setFullScreenIntent(openPi, true)
            // 贪睡只在 snooze_min > 0 时出现；0 = 不贪睡（契约 §11.2），按钮一律不给
            if (snoozeMin > 0) {
                builder.addAction(
                    Notification.Action.Builder(
                        null,
                        "稍后提醒 $snoozeMin 分钟",
                        actionPi(context, ReminderReceiver.ACTION_SNOOZE, reminderId, ruleId, snoozeMin),
                    ).build(),
                )
            }
            builder.addAction(
                Notification.Action.Builder(
                    null,
                    "停止",
                    actionPi(context, ReminderReceiver.ACTION_STOP, reminderId, ruleId, snoozeMin),
                ).build(),
            )
        } else {
            builder.setCategory(Notification.CATEGORY_REMINDER)
        }

        return try {
            nm.notify(notificationIdOf(reminderId), builder.build())
            true
        } catch (e: SecurityException) {
            // Android 13+ 未授权时 notify 会直接抛；如实告诉调用方没发出去
            false
        }
    }

    fun cancel(context: Context, reminderId: String) {
        context.getSystemService(NotificationManager::class.java)?.cancel(notificationIdOf(reminderId))
    }

    private fun appIntent(context: Context): PendingIntent {
        val i = Intent(context, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        return PendingIntent.getActivity(
            context,
            0,
            i,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }

    private fun actionPi(
        context: Context,
        action: String,
        reminderId: String,
        ruleId: String,
        snoozeMin: Int,
    ): PendingIntent {
        val i = Intent(context, ReminderReceiver::class.java).setAction(action).apply {
            putExtra(EXTRA_REMINDER_ID, reminderId)
            putExtra(EXTRA_RULE_ID, ruleId)
            putExtra(EXTRA_SNOOZE_MIN, snoozeMin)
        }
        // 与 fire / snooze 的 requestCode 分开，否则三个 PendingIntent 互相覆盖
        val code = ReminderScheduler.stableRequestCode(reminderId) xor
            (if (action == ReminderReceiver.ACTION_SNOOZE) 0x2000 else 0x4000)
        return PendingIntent.getBroadcast(
            context, code, i, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }
}
