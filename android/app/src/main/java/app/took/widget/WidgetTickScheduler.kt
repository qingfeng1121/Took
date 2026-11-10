package app.took.widget

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import java.time.Instant
import java.time.ZoneId

/**
 * 跨天刷新：「今天」是一个随时间自己变化的口径，而 updatePeriodMillis 只保证
 * 大约每 30 分钟醒一次 —— 两者叠加最坏情况是换日后的第一小时里仍显示昨天的任务。
 * 所以额外在**下一个本地零点**排一个一次性闹钟，醒来的那一刻重画并排下一天。
 *
 * 为什么用 AlarmManager 而不是 WorkManager：
 *  1. WorkManager 的周期任务最小间隔 15 分钟、且会被 Doze / App Standby 攒批延后，
 *     在零点这个「用户一睁眼就要对」的时刻没有保证；一次性闹钟是确定时刻。
 *  2. WorkManager 会多建一套任务库与 JobScheduler 条目，还要处理约束与重试；
 *     这里只需要「零点醒一次」，一条 RTC 闹钟就是全部需求，且本工程已有
 *     ReminderScheduler 用同一套 AlarmManager 记账习惯，出错面不会变宽。
 * 代价：闹钟在重启 / 覆盖安装 / 改时间后全部丢失，必须自己重排
 * （WidgetTickReceiver 接 BOOT_COMPLETED / MY_PACKAGE_REPLACED / TIME_SET / TIMEZONE_CHANGED）。
 */
class WidgetTickScheduler(context: Context) {

    private val appContext: Context = context.applicationContext

    /** 排下一个零点。已有条目被同 requestCode 覆盖，重复调用是幂等的。 */
    fun scheduleNextMidnight(now: Long = System.currentTimeMillis()) {
        val am = appContext.getSystemService(AlarmManager::class.java) ?: return
        val at = nextMidnightMillis(now)
        try {
            // 零点不需要「分秒不差」，但必须能在深度休眠里醒：setAndAllowWhileIdle 就够，
            // 也因此**不依赖** SCHEDULE_EXACT_ALARM 是否被用户关掉（少一条权限分支）。
            am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pendingIntent())
        } catch (e: SecurityException) {
            // 理论上不会发生（用的是非精确 API）；真被 OEM 拦了也不能崩掉组件刷新
        }
    }

    fun cancel() {
        val am = appContext.getSystemService(AlarmManager::class.java) ?: return
        val pi = PendingIntent.getBroadcast(
            appContext,
            REQUEST_CODE,
            tickIntent(),
            PendingIntent.FLAG_NO_CREATE or PendingIntent.FLAG_IMMUTABLE,
        ) ?: return
        am.cancel(pi)
        pi.cancel()
    }

    private fun pendingIntent(): PendingIntent = PendingIntent.getBroadcast(
        appContext,
        REQUEST_CODE,
        tickIntent(),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )

    private fun tickIntent(): Intent = Intent(appContext, WidgetTickReceiver::class.java).setAction(ACTION_TICK)

    companion object {
        const val ACTION_TICK = "app.took.action.WIDGET_TICK"
        const val REQUEST_CODE = 0x7A11

        /**
         * 下一个本地零点的毫秒时刻。纯函数（只依赖传入的 now 与时区），JVM 可测。
         * 用 atStartOfDay(zone) 而不是「当天 00:00 加 24 小时」：夏令时切换当天不会偏一小时。
         */
        fun nextMidnightMillis(now: Long, zone: ZoneId = ZoneId.systemDefault()): Long {
            val today = Instant.ofEpochMilli(now).atZone(zone).toLocalDate()
            return today.plusDays(1).atStartOfDay(zone).toInstant().toEpochMilli()
        }
    }
}
