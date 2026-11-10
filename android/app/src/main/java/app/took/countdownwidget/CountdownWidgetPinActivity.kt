package app.took.countdownwidget

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
 * 「把倒数日放到桌面」的入口（`am start -a app.took.action.PIN_COUNTDOWN_WIDGET`）。
 *
 * 与「今天」「月历」两个 PinActivity 同一套路，但换成倒数日的 receiver 与预览：
 * 三套入口各管各的组件，用户可以分别添加，也可以三个都加。
 *
 * 走系统的 requestPinAppWidget 确认框，不自己往 Launcher 的库里塞条目。
 *
 * ⚠️ 实测（小米 13 / Android 15 / MIUI）**ok=true 也不弹确认框** —— 桌面是 com.miui.home，
 * 它没实现 requestPinAppWidget 的确认流程。所以下面的兜底文案不是「出错了才显示」，
 * 而是**绝大多数情况下真正可用的添加路径**：长按桌面 → 小部件 → 找到「倒数日」→ 拖到桌面。
 */
class CountdownWidgetPinActivity : ComponentActivity() {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        var message by mutableStateOf("正在把倒数日添加到桌面…")
        setContent {
            Box(Modifier.fillMaxSize().padding(24.dp), contentAlignment = Alignment.Center) {
                Text(message, fontSize = 14.sp)
            }
        }

        scope.launch {
            val manager = GlanceAppWidgetManager(applicationContext)
            val ok = runCatching {
                manager.requestPinGlanceAppWidget(
                    receiver = CountdownWidgetReceiver::class.java,
                    preview = CountdownWidget(),
                    previewState = null,
                    successCallback = PendingIntent.getBroadcast(
                        this@CountdownWidgetPinActivity,
                        0,
                        Intent(this@CountdownWidgetPinActivity, CountdownWidgetPinActivity::class.java)
                            .setAction(ACTION_PINNED),
                        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
                    ),
                )
            }.getOrDefault(false)

            // ok=true 只代表「确认框请求已发出」：MIUI 上它既不弹框也不报错，
            // 因此这里**不据此宣称成功**，一律把真正可行的路径写在页面上。
            // 不立刻 finish()：若系统真弹了框，finish 会连确认框一起销毁（与「今天」同样的实测结论）。
            if (!ok) {
                message = UNAVAILABLE
            }
        }
    }

    override fun onDestroy() {
        scope.cancel()
        super.onDestroy()
    }

    companion object {
        const val ACTION_PIN_COUNTDOWN_WIDGET = "app.took.action.PIN_COUNTDOWN_WIDGET"
        const val ACTION_PINNED = "app.took.action.COUNTDOWN_WIDGET_PINNED"

        /** 兜底文案：ok=false 时显示。MIUI 上 ok=true 同样不弹框，所以这同时是主路径说明。 */
        const val UNAVAILABLE = "这个桌面不支持自动添加，请长按桌面 → 小部件 → 找到「倒数日」"
    }
}
