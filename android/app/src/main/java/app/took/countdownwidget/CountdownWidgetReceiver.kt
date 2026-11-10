package app.took.countdownwidget

import android.appwidget.AppWidgetManager
import android.content.Context
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.GlanceAppWidgetReceiver
import app.took.widget.WidgetTickScheduler

/**
 * 「倒数日」组件的入口。
 *
 * 与「今日概览」「月历」的 receiver 各自独立 —— 一个桌面可以同时放三个组件，
 * 互不影响对方的尺寸档、重画时机与添加流程。
 *
 * 零点闹钟**复用** [WidgetTickScheduler]（同一个 requestCode、同一个广播、同一个
 * WidgetTickReceiver），这里只负责每次重画时把它续上，**不新建第二套闹钟**：
 * 两套零点闹钟会用同一个 requestCode 互相覆盖。
 *
 * 已知边界（与「月历」同一条，不是本组件引入的）：WidgetTickReceiver 到点只 updateAll 了
 * TodayWidget 与 MonthWidget，本组件不在其中。因此跨天重画实际靠 updatePeriodMillis
 * （30 分钟）+ 尺寸/添加事件兜底。要让它也走零点刷新，得改 widget/WidgetTickReceiver ——
 * 本次约束禁止改 widget/，故如实记为遗留项，不新建第二套闹钟去绕。
 */
class CountdownWidgetReceiver : GlanceAppWidgetReceiver() {
    override val glanceAppWidget: GlanceAppWidget = CountdownWidget()

    override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) {
        super.onUpdate(context, manager, ids)
        WidgetTickScheduler(context).scheduleNextMidnight()
    }
}
