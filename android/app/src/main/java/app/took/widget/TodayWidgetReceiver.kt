package app.took.widget

import android.content.Context
import android.content.Intent
import app.took.countdownwidget.CountdownWidget
import app.took.homewidget.MonthWidget
import android.util.Log
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.GlanceAppWidgetReceiver
import androidx.glance.appwidget.updateAll
import kotlinx.coroutines.runBlocking

/**
 * 组件的入口。GlanceAppWidgetReceiver 已经包了 APPWIDGET_UPDATE 的 onUpdate
 * 与尺寸变化时的 resize，这里只补一件事：**每次重画都把下一个零点的闹钟续上**
 * —— 否则跨天刷新只发生在「用户碰了桌面」这种偶然时刻。
 */
class TodayWidgetReceiver : GlanceAppWidgetReceiver() {
    override val glanceAppWidget: GlanceAppWidget = TodayWidget()

    override fun onUpdate(context: Context, manager: android.appwidget.AppWidgetManager, ids: IntArray) {
        super.onUpdate(context, manager, ids)
        WidgetTickScheduler(context).scheduleNextMidnight()
    }
}

/**
 * 零点 / 重启 / 改时间 / 时区变化 → 重画组件并排下一个零点。
 *
 * 用 goAsync 把 SQLite 读取挪出 onReceive（只有 10 秒预算），
 * runBlocking 放在后台线程里，不阻塞广播线程。
 */
class WidgetTickReceiver : android.content.BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        val appContext = context.applicationContext
        val pending = goAsync()
        Thread {
            try {
                WidgetTickScheduler(appContext).scheduleNextMidnight()
                // 三个组件都要重画 —— 原来只 updateAll(TodayWidget)，
                // 月历和倒数日只能靠 updatePeriodMillis=30 分钟被动刷新，
                // 跨零点后最长 30 分钟还显示昨天的天数（用户会以为算错）。
                // 单个组件失败不能让其余组件也不刷新，所以各自 try。
                for (each in listOf(TodayWidget(), MonthWidget(), CountdownWidget())) {
                    try {
                        runBlocking { each.updateAll(appContext) }
                    } catch (e: Exception) {
                        Log.e(TAG, "组件 " + each.javaClass.simpleName + " 刷新失败：${e.message}")
                    }
                }
            } catch (e: Exception) {
                Log.e(TAG, "组件刷新失败：${e.message}")
            } finally {
                pending.finish()
            }
        }.start()
    }

    companion object {
        private const val TAG = "TookWidget"
    }
}
