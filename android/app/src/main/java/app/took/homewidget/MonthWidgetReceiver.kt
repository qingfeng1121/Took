package app.took.homewidget

import android.appwidget.AppWidgetManager
import android.content.Context
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.GlanceAppWidgetReceiver
import app.took.widget.WidgetTickScheduler

/**
 * 「月历」组件的入口。
 *
 * 与「今日概览」的 receiver 各自独立 —— 一个桌面可以同时放两个组件，
 * 互不影响对方的尺寸档、重画时机与添加流程。
 *
 * 零点闹钟**复用** [WidgetTickScheduler]（同一个 requestCode、同一个广播），
 * 这里只负责每次重画时把它续上，不新增第二套闹钟。既有 WidgetTickReceiver
 * 到点时会同时刷新两个组件。
 */
class MonthWidgetReceiver : GlanceAppWidgetReceiver() {
    override val glanceAppWidget: GlanceAppWidget = MonthWidget()

    override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) {
        super.onUpdate(context, manager, ids)
        WidgetTickScheduler(context).scheduleNextMidnight()
    }
}
