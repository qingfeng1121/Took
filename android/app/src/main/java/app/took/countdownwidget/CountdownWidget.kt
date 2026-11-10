package app.took.countdownwidget

import android.content.Context
import android.content.Intent
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.glance.GlanceId
import androidx.glance.GlanceModifier
import androidx.glance.LocalContext
import androidx.glance.LocalSize
import androidx.glance.action.clickable
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.SizeMode
import androidx.glance.appwidget.appWidgetBackground
import androidx.glance.appwidget.cornerRadius
import androidx.glance.appwidget.provideContent
import androidx.glance.appwidget.state.getAppWidgetState
import androidx.glance.background
import androidx.glance.layout.Alignment
import androidx.glance.layout.Column
import androidx.glance.layout.fillMaxSize
import androidx.glance.layout.fillMaxWidth
import androidx.glance.layout.padding
import androidx.glance.semantics.contentDescription
import androidx.glance.semantics.semantics
import androidx.glance.state.PreferencesGlanceStateDefinition
import androidx.glance.text.FontWeight
import androidx.glance.text.Text
import androidx.glance.text.TextAlign
import androidx.glance.text.TextStyle
import androidx.glance.unit.ColorProvider
import app.took.MainActivity
import app.took.data.MemoKind
import app.took.data.TookDb
import app.took.data.TookRepository
// glance 与 glance-appwidget 各有一个 actionStartActivity：reified Class 版打开首页，
// Intent 版（带 extra）打开某条倒数日。两者只能靠别名共存 —— 与 MonthWidget 同一处理。
import androidx.glance.appwidget.action.actionStartActivity as actionStartActivityIntent
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.time.LocalDate

/**
 * 桌面小组件「倒数日」：**一个实例 = 一个倒数日**，整块就是 App 内那张深色倒数日卡。
 *
 * 用户 2026-10-26 的原话：「这个倒数日太丑，为什么 2*2 要塞两个倒数日？一个只能显示一个」。
 * 因此这里不再按尺寸分「放几张」：任何尺寸都只画一条，放大只是数字更大、留白更多。
 * 多个倒数日靠「再拖一个组件 + 各自选一条」区分（选择页见 [CountdownWidgetConfigActivity]）。
 *
 * 与「今日概览」([app.took.widget.TodayWidget])、「月历」([app.took.homewidget.MonthWidget])
 * 是三个**独立**组件：各自的 receiver、appwidget-info 与 sizeMode 互不相干，
 * 因此三个可以同时放在桌面上，互不覆盖对方的尺寸档与重画时机。
 *
 * 数据只读本地 SQLite（一次 listMemos(kind=1) 是毫秒级），不联网、不读同步状态。
 * 跨天刷新**复用** [app.took.widget.WidgetTickScheduler] 的零点闹钟，不新建第二套闹钟。
 */
class CountdownWidget : GlanceAppWidget() {

    /**
     * **Exact，不是 Responsive**。
     *
     * Responsive 的做法是「从给定的几档里挑**装得下**的那一档」，而它拿到的是
     * appwidget-provider 里的 minWidth/minHeight 换算值、不是真实格子尺寸：本机
     * 440dpi、2×2 格子的真实尺寸约 145×145dp，而 Responsive 会拿下限去比，
     * 结果**永远落最小那档**（实测 2×2 被渲染成最小档、标题消失）。
     *
     * Exact 直接用 LocalSize 的真实 dp，[CountdownWidgetPlan.tierForSize] 拿到的就是
     * 用户实际拖出来的尺寸。
     */
    override val sizeMode: SizeMode = SizeMode.Exact

    override suspend fun provideGlance(context: Context, id: GlanceId) {
        val appContext = context.applicationContext
        // 本实例自己的配置（Glance 的 Preferences 按 GlanceId 隔离 → 两个实例互不干扰）
        val prefs = getAppWidgetState(appContext, PreferencesGlanceStateDefinition, id)
        val memoId = prefs[CountdownWidgetState.KEY_MEMO_ID]

        val plan = withContext(Dispatchers.IO) {
            val today = LocalDate.now().toString()
            val repo = TookRepository(TookDb.shared(appContext))
            CountdownWidgetPlan.resolve(repo.listMemos(MemoKind.COUNTDOWN), today, memoId)
        }
        provideContent { CountdownWidgetContent(plan) }
    }
}

/* --------------------------------- 渲染 --------------------------------- */

/** 卡底：与 App 内 CountdownCard 的 TookColors.countdownBg 同一个值。 */
private val CARD_BG = ColorProvider(Color(0xFF1F2329))
/** 卡上小字：TookColors.countdownSmall。 */
private val CARD_SMALL = ColorProvider(Color(0xFF9AA3AE))
/** 卡上大数字：TookColors.countdownBig。 */
private val CARD_BIG = ColorProvider(Color(0xFFFFFFFF))
/** 目标日就是今天：TookColors.today，与 App 内同一处红。 */
private val TODAY = ColorProvider(Color(0xFFE53935))

/**
 * 组件根：**整块就是那张深色卡**。
 *
 * 上一版是「白底 + 里面塞一到两张深色卡」，2×2 里两张卡各分一半高度，
 * 数字被压扁 —— 用户说的「太丑」就是这个。现在一个实例只有一张卡，
 * 白边那圈留白没有存在意义，直接让卡铺满组件。
 */
@Composable
fun CountdownWidgetContent(plan: CountdownWidgetPlan) {
    val size = LocalSize.current
    val tier = CountdownWidgetPlan.tierForSize(size.width.value, size.height.value)

    val item = plan.item
    Column(
        modifier = GlanceModifier
            .fillMaxSize()
            .appWidgetBackground()
            .cornerRadius(18.dp)
            .background(CARD_BG)
            .padding(tier.rootPad.dp)
            // TEMP-PLACE-START
            // .clickable(
            //     if (item != null) openMemoIntent(item.id)
            //     else actionStartActivityIntent(Intent(LocalContext.current, MainActivity::class.java)),
            // )
            // TEMP-PLACE-END
            .semantics { contentDescription = item?.label ?: plan.stateLabel() },
        verticalAlignment = Alignment.Vertical.CenterVertically,
        horizontalAlignment = Alignment.Horizontal.CenterHorizontally,
    ) {
        when {
            plan.missing -> Message(CountdownWidgetPlan.DELETED_TEXT, CountdownWidgetPlan.DELETED_HINT, tier)
            plan.empty -> Message(CountdownWidgetPlan.EMPTY_TEXT, CountdownWidgetPlan.EMPTY_HINT, tier)
            item != null -> SingleCard(item, tier, size.width.value, size.height.value)
        }
    }
}

/** 这一张卡：浅灰小字标题 → 方向小字 → **超大白色数字** → 点分目标日（与 App 内同一套层次）。 */
@Composable
private fun SingleCard(
    item: CountdownWidgetItem,
    tier: CountdownWidgetTier,
    widthDp: Float,
    heightDp: Float,
) {
    val layout = CountdownWidgetPlan.cardLayout(CountdownWidgetPlan.cardHeightDp(heightDp, tier), tier)
    // 先按高度定字号，再按宽度压一次：4 位数在高卡上会被高度算得很大，不压就横向溢出被裁。
    val numberSp = CountdownWidgetPlan.numberSpFittingWidth(
        numberSp = layout.numberSp,
        cardWidthDp = CountdownWidgetPlan.cardWidthDp(widthDp, tier),
        digits = item.number.length,
    )

    Column(
        modifier = GlanceModifier.fillMaxSize().padding(tier.cardPad.dp),
        verticalAlignment = Alignment.Vertical.CenterVertically,
        horizontalAlignment = Alignment.Horizontal.CenterHorizontally,
    ) {
        if (layout.showTitle) {
            Text(
                text = item.title,
                modifier = GlanceModifier.fillMaxWidth(),
                style = TextStyle(
                    color = CARD_SMALL,
                    fontSize = tier.titleSp.sp,
                    fontWeight = FontWeight.Medium,
                    textAlign = TextAlign.Center,
                ),
                maxLines = 1,
            )
            if (layout.showDirection) {
                Text(
                    text = item.direction,
                    modifier = GlanceModifier.padding(top = 1.dp),
                    style = TextStyle(color = CARD_SMALL, fontSize = (tier.titleSp - 1).sp, textAlign = TextAlign.Center),
                    maxLines = 1,
                )
            }
        }

        // 数字直接按算好的字号画，**不套 Box + defaultWeight**：
        // Glance 的 Column 是 RemoteViews 的 LinearLayout，里层再套一个 weight 的子项时
        // 外层高度是 wrap_content，里层的 weight 拿不到剩余高度 → 数字被压成 0 高直接消失。
        Text(
            text = item.number,
            modifier = GlanceModifier.fillMaxWidth().padding(vertical = 2.dp),
            style = TextStyle(
                color = if (item.today) TODAY else CARD_BIG,
                fontSize = numberSp.sp,
                fontWeight = FontWeight.Bold,
                textAlign = TextAlign.Center,
            ),
            maxLines = 1,
        )

        // 底部目标日：点分不补零（2026.2.6），与 App 内卡片同一个 MemoFormats.compactDate
        Text(
            text = item.dateText,
            style = TextStyle(color = CARD_SMALL, fontSize = tier.dateSp.sp, textAlign = TextAlign.Center),
            maxLines = 1,
        )
    }
}

/**
 * 非正常状态的两行文案（还没有倒数日 / 该倒数日已删除）。
 *
 * 桌面上留白会被当成「加载失败」，所以两种状态都必须有字；
 * 第二行给出下一步动作，用户不用猜。
 */
@Composable
private fun Message(title: String, hint: String, tier: CountdownWidgetTier) {
    Column(
        modifier = GlanceModifier.fillMaxSize().padding(tier.cardPad.dp),
        verticalAlignment = Alignment.Vertical.CenterVertically,
        horizontalAlignment = Alignment.Horizontal.CenterHorizontally,
    ) {
        Text(
            text = title,
            style = TextStyle(color = CARD_BIG, fontSize = (tier.titleSp + 2).sp, fontWeight = FontWeight.Medium, textAlign = TextAlign.Center),
            maxLines = 1,
        )
        Text(
            text = hint,
            modifier = GlanceModifier.padding(top = 3.dp),
            style = TextStyle(color = CARD_SMALL, fontSize = tier.titleSp.sp, textAlign = TextAlign.Center),
            maxLines = 2,
        )
    }
}

/** 非正常状态的无障碍标签（uiautomator 靠它断状态）。 */
private fun CountdownWidgetPlan.stateLabel(): String = when {
    missing -> CountdownWidgetPlan.DELETED_TEXT
    else -> CountdownWidgetPlan.EMPTY_TEXT
}

/**
 * 点这张卡 → 打开 App 并定位到该倒数日的编辑页。
 *
 * 用 glance-appwidget 的 **Intent 版** actionStartActivity（不是 Class 版）：
 * 它经 ActionTrampolineActivity 转发原 Intent，extra 会原样到达 MainActivity。
 *
 * 选 EXTRA_OPEN_MEMO 而不是复用 EXTRA_OPEN_DATE：后者是「打开某一天的面板」，
 * 把倒数日塞进去会在首页弹出那一天的打卡面板，与该条的编辑页是两件事。
 */
@Composable
private fun openMemoIntent(memoId: String) = actionStartActivityIntent(
    Intent(LocalContext.current, MainActivity::class.java).putExtra(EXTRA_OPEN_MEMO, memoId),
)

/** 组件点击要打开的那条倒数日；MainActivity 读它并让首页直接打开该条编辑页。 */
const val EXTRA_OPEN_MEMO = "app.took.extra.OPEN_MEMO"
