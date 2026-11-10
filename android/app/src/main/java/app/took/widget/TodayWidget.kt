package app.took.widget

import android.content.Context
import android.content.Intent
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.DpSize
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.glance.GlanceId
import androidx.glance.GlanceModifier
import androidx.glance.LocalSize
import androidx.glance.action.actionStartActivity
import androidx.glance.action.clickable
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.SizeMode
import androidx.glance.appwidget.appWidgetBackground
import androidx.glance.appwidget.cornerRadius
import androidx.glance.appwidget.provideContent
import androidx.glance.background
import androidx.glance.layout.Alignment
import androidx.glance.layout.Column
import androidx.glance.layout.Row
import androidx.glance.layout.Spacer
import androidx.glance.layout.fillMaxSize
import androidx.glance.layout.fillMaxWidth
import androidx.glance.layout.padding
import androidx.glance.text.FontWeight
import androidx.glance.text.Text
import androidx.glance.text.TextStyle
import androidx.glance.unit.ColorProvider
import app.took.MainActivity
import app.took.data.TookDb
import app.took.data.TookRepository
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.time.LocalDate

/**
 * 桌面小组件「今日概览」。
 *
 * 数据只用本地 [TookRepository]，**不联网、不读同步状态** —— 组件在桌面上，
 * 任何一次卡顿或弹窗都会被用户直接看到；本地 SQLite 一次 loadDay 是毫秒级。
 *
 * 尺寸：SizeMode.Responsive 三档（定稿 §6.2.1 的思路），实际内容密度由 [TodayWidgetPlan.tierForSize]
 * 决定 —— 三档的「放几行」是纯逻辑，JVM 单测直接覆盖，不需要跑模拟器。
 */
class TodayWidget : GlanceAppWidget() {

    override val sizeMode: SizeMode = SizeMode.Responsive(
        setOf(
            DpSize(150.dp, 60.dp),    // 紧凑：1×1 / 2×1
            DpSize(250.dp, 150.dp),   // 标准：4×2 / 4×3
            DpSize(320.dp, 260.dp),   // 宽松：4×4 及以上
        ),
    )

    override suspend fun provideGlance(context: Context, id: GlanceId) {
        val appContext = context.applicationContext
        val plan = withContext(Dispatchers.IO) {
            val date = LocalDate.now().toString()
            val repo = TookRepository(TookDb.shared(appContext))
            TodayWidgetPlan.of(date, repo.loadDay(date))
        }
        provideContent { WidgetContent(plan) }
    }
}

/* --------------------------------- 渲染 --------------------------------- */

private val BG = ColorProvider(Color(0xFFFFFFFF))
private val TEXT = ColorProvider(Color(0xFF1F2329))
private val TEXT2 = ColorProvider(Color(0xFF8A9099))
private val DONE = ColorProvider(Color(0xFFB0B6BE))
private val ACCENT = ColorProvider(Color(0xFFF97316))
private val DOT_OFF = ColorProvider(Color(0xFFCED3DA))

/** 组件根的样式固定（浅色，与 app 主题 #eef0f4 / 白卡一致），不跟随系统深色 —— 见下方说明。 */
@Composable
fun WidgetContent(plan: TodayWidgetPlan) {
    val size = LocalSize.current
    val tier = TodayWidgetPlan.tierForSize(size.width.value, size.height.value)
    val rows = plan.visible(tier.rows)
    val overflow = plan.overflow(tier.rows)

    Column(
        modifier = GlanceModifier
            .fillMaxSize()
            .appWidgetBackground()
            .cornerRadius(18.dp)
            .background(BG)
            .padding(horizontal = 14.dp, vertical = 12.dp)
            .clickable(openApp()),
        verticalAlignment = Alignment.Vertical.Top,
        horizontalAlignment = Alignment.Horizontal.Start,
    ) {
        Row(
            modifier = GlanceModifier.fillMaxWidth(),
            verticalAlignment = Alignment.Vertical.CenterVertically,
        ) {
            Text(
                text = "今天",
                style = TextStyle(color = TEXT, fontSize = 14.sp, fontWeight = FontWeight.Bold),
            )
            // defaultWeight 是 RowScope 的成员扩展：只能在 Row/Column 的 content 里调，没有顶层 import
            Spacer(GlanceModifier.defaultWeight())
            Text(
                text = plan.headline,
                style = TextStyle(color = if (plan.total > 0 && plan.undoneCount == 0) ACCENT else TEXT2, fontSize = 11.sp),
                maxLines = 1,
            )
        }

        if (rows.isEmpty()) {
            Spacer(GlanceModifier.padding(top = 6.dp))
            Text(
                text = "今天没有安排，打开看看日历",
                style = TextStyle(color = TEXT2, fontSize = 12.sp),
                maxLines = 2,
            )
        }

        rows.forEach { task ->
            Row(
                modifier = GlanceModifier.fillMaxWidth().padding(top = 6.dp),
                verticalAlignment = Alignment.Vertical.CenterVertically,
            ) {
                // 同一天里已完成的任务**不消失**，只用主色圆点 + 灰字区分（定稿 §6.2 的「完成痕迹永远在」）
                Text(
                    text = if (task.done) "●" else "○",
                    style = TextStyle(color = if (task.done) ACCENT else DOT_OFF, fontSize = 9.sp),
                )
                // 注意：Glance 的 Spacer 不产出任何 View（不是「有宽度的空盒子」），
                // 间距必须写在下一个元素自己的 padding 上，否则会连带把后面的 Text 挤没。
                Text(
                    text = task.title,
                    modifier = GlanceModifier.padding(start = 6.dp),
                    style = TextStyle(
                        color = if (task.done) DONE else TEXT,
                        fontSize = 13.sp,
                        fontWeight = if (task.done) FontWeight.Normal else FontWeight.Medium,
                    ),
                    maxLines = 1,
                )
            }
        }

        if (overflow > 0) {
            Text(
                text = "还有 $overflow 条",
                modifier = GlanceModifier.padding(top = 6.dp),
                style = TextStyle(color = TEXT2, fontSize = 11.sp),
                maxLines = 1,
            )
        }
    }
}

/**
 * 点组件任意处 → 打开 App 首页。
 *
 * 用 androidx.glance.action 的 reified actionStartActivity<MainActivity>()：传的是 Activity 的 Class，
 * 由 Glance 的 ActionTrampolineActivity 在应用进程里补 NEW_TASK 启动 —— 桌面进程不该直接持有
 * 应用 Activity 的 Intent（导出/权限边界会变），走 trampoline 是官方路径。
 * 注意 glide-appwidget 里另有一个 Intent 版同名函数，两者只有一个能 import。
 */
private fun openApp() = actionStartActivity<MainActivity>()
