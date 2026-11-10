package app.took.widget

import android.app.PendingIntent
import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.glance.appwidget.GlanceAppWidgetManager
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

/**
 * 「把今日概览放到桌面」的入口（`am start -a app.took.action.PIN_WIDGET`）。
 *
 * 走系统的 requestPinAppWidget 确认框：由用户在桌面确认，**不自己往 Launcher 的库里塞条目**
 * ——宿主是 com.miui.personalassistant，不是 AppWidgetHost 暴露的公开接口面。
 *
 * 系统不弹框时如实显示「这个桌面不支持自动添加」，不假装成功（用户级规则：不给假按钮/假文案）。
 */
class WidgetPinActivity : ComponentActivity() {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        var message by mutableStateOf("正在请求添加到桌面…")
        setContent {
            Box(Modifier.fillMaxSize().padding(24.dp), contentAlignment = Alignment.Center) {
                Text(message, fontSize = 14.sp)
            }
        }

        scope.launch {
            val manager = GlanceAppWidgetManager(applicationContext)
            val ok = runCatching {
                manager.requestPinGlanceAppWidget(
                    receiver = TodayWidgetReceiver::class.java,
                    preview = TodayWidget(),
                    previewState = null,
                    successCallback = PendingIntent.getBroadcast(
                        this@WidgetPinActivity,
                        0,
                        Intent(this@WidgetPinActivity, WidgetPinActivity::class.java)
                            .setAction(ACTION_PINNED),
                        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
                    ),
                )
            }.getOrDefault(false)

            // ok=true 只代表「确认框请求已发出」：系统把 com.miui.home/.launcher.AddItemActivity
            // 叠在**本 Activity 的任务**之上。实测（小米 13 / Android 15）这里若立刻 finish()，
            // 任务被销毁连带确认框一起消失，看起来像「点了没反应」。所以保留本页等用户确认，
            // 确认成功由 successCallback 广播 → WidgetTickReceiver 收尾。
            if (!ok) {
                message = "这个桌面不支持自动添加，请长按桌面 → 小部件 → 找到「今天」"
            }
        }
    }

    override fun onDestroy() {
        scope.cancel()
        super.onDestroy()
    }

    companion object {
        const val ACTION_PIN_WIDGET = "app.took.action.PIN_WIDGET"
        const val ACTION_PINNED = "app.took.action.WIDGET_PINNED"
    }
}
