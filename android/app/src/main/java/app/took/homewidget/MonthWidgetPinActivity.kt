package app.took.homewidget

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
 * 「把月历放到桌面」的入口（`am start -a app.took.action.PIN_MONTH_WIDGET`）。
 *
 * 与「今天」的 WidgetPinActivity 同一套路，但**换成了月历的 receiver 与预览**：
 * 两套入口各管各的组件，用户在应用内可以分别添加，也可以两个都加。
 *
 * 走系统的 requestPinAppWidget 确认框，不自己往 Launcher 的库里塞条目；
 * 系统不弹框时如实显示「这个桌面不支持自动添加」，不假装成功。
 */
class MonthWidgetPinActivity : ComponentActivity() {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        var message by mutableStateOf("正在把月历添加到桌面…")
        setContent {
            Box(Modifier.fillMaxSize().padding(24.dp), contentAlignment = Alignment.Center) {
                Text(message, fontSize = 14.sp)
            }
        }

        scope.launch {
            val manager = GlanceAppWidgetManager(applicationContext)
            val ok = runCatching {
                manager.requestPinGlanceAppWidget(
                    receiver = MonthWidgetReceiver::class.java,
                    preview = MonthWidget(),
                    previewState = null,
                    successCallback = PendingIntent.getBroadcast(
                        this@MonthWidgetPinActivity,
                        0,
                        Intent(this@MonthWidgetPinActivity, MonthWidgetPinActivity::class.java)
                            .setAction(ACTION_PINNED),
                        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
                    ),
                )
            }.getOrDefault(false)

            // ok=true 只代表「确认框请求已发出」：系统把 Launcher 的添加页叠在本 Activity 的任务之上，
            // 这里立刻 finish() 会连确认框一起销毁（与「今天」同样的实测结论）。
            if (!ok) {
                message = "这个桌面不支持自动添加，请长按桌面 → 小部件 → 找到「月历」"
            }
        }
    }

    override fun onDestroy() {
        scope.cancel()
        super.onDestroy()
    }

    companion object {
        const val ACTION_PIN_MONTH_WIDGET = "app.took.action.PIN_MONTH_WIDGET"
        const val ACTION_PINNED = "app.took.action.MONTH_WIDGET_PINNED"
    }
}
