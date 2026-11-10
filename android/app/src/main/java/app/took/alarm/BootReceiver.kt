package app.took.alarm

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import app.took.data.TookDb
import app.took.data.TookRepository

/**
 * 重启 / 重装 / 改时间 / 换时区之后把闹钟全部重建（定稿 §6.3.4 的「重启」那一步）。
 *
 * 这是 Android 的硬规则：AlarmManager 里的一切在重启后**全部消失**，没有任何自动恢复。
 * 四个 action 都要接：
 *  - BOOT_COMPLETED —— 重启（普通权限，但必须自己重建）；
 *  - MY_PACKAGE_REPLACED —— 覆盖安装；
 *  - TIME_SET / TIMEZONE_CHANGED —— 时刻表整体平移了，旧触发点不再对应同一个「墙上时间」。
 */
class BootReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        val action = intent.action ?: return
        if (action !in ACTIONS) return
        ReminderChannels.ensure(context)
        // 用 goAsync 把 SQLite + AlarmManager 挪出主线程：onReceive 只有 10 秒，别拿它跑库
        val pending = goAsync()
        val appContext = context.applicationContext
        Thread {
            try {
                val repo = TookRepository(TookDb.shared(appContext))
                val report = ReminderScheduler(appContext, repo).rescheduleAll()
                Log.i(TAG, "$action 后重排：${report.summary()}")
            } catch (e: Exception) {
                Log.e(TAG, "$action 后排提醒失败：${e.message}")
            } finally {
                pending.finish()
            }
        }.start()
    }

    private companion object {
        const val TAG = "TookReminder"
        val ACTIONS = setOf(
            Intent.ACTION_BOOT_COMPLETED,
            Intent.ACTION_MY_PACKAGE_REPLACED,
            Intent.ACTION_TIME_CHANGED,
            Intent.ACTION_TIMEZONE_CHANGED,
        )
    }
}
