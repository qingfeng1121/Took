package app.took.homewidget

import android.content.Context
import android.content.Intent
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.DpSize
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.glance.GlanceId
import androidx.glance.GlanceModifier
import androidx.glance.LocalContext
import androidx.glance.LocalSize
import androidx.glance.action.clickable
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.SizeMode
import androidx.glance.action.actionStartActivity
// glance 与 glance-appwidget 各有一个 actionStartActivity：下面这个吃 Intent（带 extra），
// 上面那个是 reified Class 版（打开首页用）。两者只能靠别名共存。
import androidx.glance.appwidget.action.actionStartActivity as actionStartActivityIntent
import androidx.glance.appwidget.appWidgetBackground
import androidx.glance.appwidget.cornerRadius
import androidx.glance.appwidget.provideContent
import androidx.glance.background
import androidx.glance.layout.Alignment
import androidx.glance.layout.Column
import androidx.glance.layout.Row
import androidx.glance.layout.RowScope
import androidx.glance.layout.fillMaxSize
import androidx.glance.layout.fillMaxWidth
import androidx.glance.layout.height
import androidx.glance.layout.padding
import androidx.glance.semantics.contentDescription
import androidx.glance.semantics.semantics
import androidx.glance.text.FontWeight
import androidx.glance.text.Text
import androidx.glance.text.TextAlign
import androidx.glance.text.TextStyle
import androidx.glance.unit.ColorProvider
import app.took.MainActivity
import app.took.data.TookDb
import app.took.data.TookRepository
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.time.LocalDate

/**
 * 桌面小组件「月历」：把首页整个日历（42 格 / 周一起始 / 圆点 / 今天红）搬到桌面。
 *
 * 与「今日概览」([app.took.widget.TodayWidget]) 是两个**独立**组件：各自的 receiver、
 * appwidget-info 与 sizeMode 互不相干，因此两个可以同时放在桌面上。
 *
 * 数据只读本地 SQLite（一次 loadGrid 是毫秒级），不联网、不读同步状态。
 * 跨天刷新**复用** [app.took.widget.WidgetTickScheduler] 的零点闹钟：闹钟广播由既有的
 * WidgetTickReceiver 接，本组件的 receiver 只补「每次重画都把下一个零点续上」，
 * 不重复造第二套闹钟（两套零点闹钟会互相覆盖 requestCode）。
 */
class MonthWidget : GlanceAppWidget() {

    /**
     * 三档尺寸。4x4 / 5x5 落 LARGE，约 3x3 落 MEDIUM，2x2 及以下落 MINI；
     * 实际按 LocalSize 的 dp 判（[MonthWidgetPlan.tierForSize]），不认格子数。
     */
    override val sizeMode: SizeMode = SizeMode.Responsive(
        setOf(
            DpSize(150.dp, 150.dp),
            DpSize(240.dp, 220.dp),
            DpSize(320.dp, 320.dp),
        ),
    )

    override suspend fun provideGlance(context: Context, id: GlanceId) {
        val appContext = context.applicationContext
        val plan = withContext(Dispatchers.IO) {
            val today = LocalDate.now()
            val repo = TookRepository(TookDb.shared(appContext))
            val cells = repo.loadGrid(today.year, today.monthValue)
            // 先按最大档折计划；真正用哪一档由渲染时的 LocalSize 决定 ——
            // 因此 MINI / MEDIUM 直接复用这份 42 格数据，切档不必重读库。
            MonthWidgetPlan.of(
                year = today.year,
                month = today.monthValue,
                today = today.toString(),
                cells = cells,
                tier = MonthWidgetTier.LARGE,
            )
        }
        provideContent { MonthWidgetContent(plan) }
    }
}

/* --------------------------------- 渲染 --------------------------------- */

private val BG = ColorProvider(Color(0xFFFFFFFF))
private val TEXT = ColorProvider(Color(0xFF1F2329))
private val TEXT2 = ColorProvider(Color(0xFF8A9099))
/** 非本月日期：对应首页 DayCellView 的 alpha(0.5f) 灰化，取等效色而非半透明。 */
private val OUT_OF_MONTH = ColorProvider(Color(0xFFC3C8CF))
/** 今天：app 内 --today = #E53935，组件与 App 同一红。 */
private val TODAY = ColorProvider(Color(0xFFE53935))
private val ACCENT = ColorProvider(Color(0xFFF97316))
private val DOT_OFF = ColorProvider(Color(0xFFB8BDC4))

/** 组件根。浅色固定、不跟随系统深色 —— 与「今日概览」同一取舍（桌面壁纸是用户自己的）。 */
@Composable
fun MonthWidgetContent(plan: MonthWidgetPlan) {
    val size = LocalSize.current
    val tier = MonthWidgetPlan.tierForSize(size.width.value, size.height.value)

    // 行高自适应，但**精确扣掉非网格部分**，余量只留给图例下方那一点。
    //
    // 两次踩坑记录（用户 2026-10-28「图例别太贴着下面」）：
    //   ① 行高完全吸收余量 → 图例永远贴底（距底 58px 是图例自身高度，加 padding 无效）；
    //   ② 行高完全固定 → 余量全堆底部（距底 348px，更糟）。
    // 正解：行高吸收余量，但 chromeDp 里把「图例 + 目标底部留白」算进去，
    // 这样图例自然落到底部留白之上。
    val rowsToDraw = plan.visibleRows(tier)
    // 标题(约 22) + 星期行(约 20) + 上下内边距(3+3) = 48
    // 图例：文字行约 18 + top 4 + bottom 目标 8px≈3dp → 25
    // 46 = 标题(约 20) + 星期行(约 18) + 上下内边距(3+3)
    // 图例存在时再加 20（图例文字 + 其上下留白）
    val chromeDp = 46f + if (tier.showLegend) 20f else 0f
    val rowH = ((size.height.value - chromeDp) / rowsToDraw.size.coerceAtLeast(1))
        .coerceAtLeast(tier.rowHeightDp.toFloat())

    Column(
        modifier = GlanceModifier
            .fillMaxSize()
            .appWidgetBackground()
            .cornerRadius(18.dp)
            .background(BG)
            .padding(start = 8.dp, end = 8.dp, top = 3.dp, bottom = 0.dp)
            // 点组件任意处 → 打开 App 首页
            .clickable(actionStartActivity<MainActivity>()),
        verticalAlignment = Alignment.Vertical.Top,
        horizontalAlignment = Alignment.Horizontal.Start,
    ) {
        Text(
            text = plan.title,
            style = TextStyle(color = TEXT, fontSize = (tier.dateSp + 1).sp, fontWeight = FontWeight.Bold),
            maxLines = 1,
        )

        // 星期标题：每格等分，与下面 42 格同列对齐（defaultWeight 是 RowScope 的成员扩展）
        Row(modifier = GlanceModifier.fillMaxWidth().padding(top = 2.dp)) {
            plan.weekTitles.forEach { w ->
                Text(
                    text = w,
                    modifier = GlanceModifier.defaultWeight(),
                    style = TextStyle(color = TEXT2, fontSize = tier.weekdaySp.sp, textAlign = TextAlign.Center),
                    maxLines = 1,
                )
            }
        }

        // 行：每行固定高度，行与行之间只在一处加间距。
        // 用户 2026-10-28：「间距都不固定」——原来 Row 的 padding(top=1dp) 与格子
        // Column 的 padding(vertical=1dp) 叠加，行高由内容撑，肉眼忽大忽小。
        rowsToDraw.forEachIndexed { index, row ->
            Row(
                modifier = GlanceModifier
                    .fillMaxWidth()
                    .height(rowH.dp)
                    .padding(top = 2.dp),
            ) {
                row.forEach { cell -> DayCellGlance(cell = cell, tier = tier) }
            }
        }

        // 底部图例：照首页 CalFoot 的形态（实心橙=已完成 / 空心灰=未完成 / 实心红=今天）。
        // 靠右对齐（用户：「右下角有已完成未完成等提示」）。MINI/MEDIUM 高度不够就不画。
        //
        // 图例之前先放一个吸收剩余高度的占位：Column 是 Top 对齐，
        // 不加它的话所有余量都堆在底部，图例被顶到卡片中部（实测图例下方空 63px）。
        // 加了它之后余量在图例上方被吃掉，图例自然落到卡片底部。
        // 吸收剩余高度：Glance 没有 Box，Spacer 又不产出 View，
        // 用「空内容的 Column + defaultWeight」当弹簧，把图例顶到卡片底部。
        if (tier.showLegend) {
            Column(modifier = GlanceModifier.fillMaxWidth().defaultWeight()) { }
        }
        if (tier.showLegend) {
            Row(
                modifier = GlanceModifier
                    .fillMaxWidth()
                    // 图例往下挪一点，别贴着卡片底边（用户 2026-10-28：「避免它太贴着下面」）。
                    // 同时给 top 留白，与上面最后一行日期分开。
                    .padding(top = 4.dp, bottom = 3.dp)
                    .semantics { contentDescription = "图例：已完成 未完成 今天" },
                horizontalAlignment = Alignment.Horizontal.End,
                verticalAlignment = Alignment.Vertical.CenterVertically,
            ) {
                LegendItem("已完成", ACCENT, filled = true, tier)
                LegendItem("未完成", DOT_OFF, filled = false, tier)
                LegendItem("今天", TODAY, filled = true, tier)
            }
        }
    }
}

/** 图例一项：圆点 + 文字，形态与格子里的圆点一致（否则图例和格子对不上）。 */
@Composable
private fun LegendItem(label: String, color: ColorProvider, filled: Boolean, tier: MonthWidgetTier) {
    Row(
        modifier = GlanceModifier.padding(start = 6.dp),
        verticalAlignment = Alignment.Vertical.CenterVertically,
    ) {
        Text(
            text = if (filled) "●" else "○",
            style = TextStyle(color = color, fontSize = (tier.dotSp - 1).sp),
            maxLines = 1,
        )
        Text(
            text = label,
            modifier = GlanceModifier.padding(start = 1.dp),
            style = TextStyle(color = TEXT2, fontSize = (tier.weekdaySp - 1).sp),
            maxLines = 1,
        )
    }
}

/**
 * 一格：日期数字 + 圆点，今天红字加粗。
 *
 * Glance 没有 Canvas，圆点用 ● / ○ 文字画（与首页圆点观感一致），
 * 数量与分档完全来自 [MonthWidgetCell.dots]，不在渲染里现算。
 *
 * 点这一格 → 打开 App 并定位到这一天：Intent 带 extra，由 MainActivity 读走。
 */
@Composable
private fun RowScope.DayCellGlance(cell: MonthWidgetCell, tier: MonthWidgetTier) {
    val dateColor = when {
        cell.isToday -> TODAY
        !cell.inMonth -> OUT_OF_MONTH
        else -> TEXT
    }

    Column(
        modifier = GlanceModifier
            .defaultWeight()
            // 不再加 vertical padding：行高已由 Row 固定，这里再加会与行距叠加，
            // 表现为「有的行宽有的行窄」（用户 2026-10-28 反馈的「间距都不固定」）。
            .clickable(openDayIntent(cell.date))
            .semantics { contentDescription = cell.label },
        horizontalAlignment = Alignment.Horizontal.CenterHorizontally,
        verticalAlignment = Alignment.Vertical.CenterVertically,
    ) {
        // 今天的标记不只靠颜色：加粗 + 红字，两者在最小档都保留
        Text(
            text = cell.dayOfMonth.toString(),
            style = TextStyle(
                color = dateColor,
                fontSize = tier.dateSp.sp,
                fontWeight = if (cell.isToday) FontWeight.Bold else FontWeight.Normal,
                textAlign = TextAlign.Center,
            ),
            maxLines = 1,
        )

        cell.dots?.let { dots ->
            if (dots.total > 0) {
                // 圆点字号按**数量**自适应收缩，与首页 DayCellView 的 DotsRow 同一口径。
                //
                // 为什么要收：组件一格宽约 40dp（7 列挤在 300dp 里），
                // 5 个圆点按 tier.dotSp（6~7sp）排开约 30dp，加上字形本身的左右留白，
                // 相邻两格的圆点在视觉上会连成一条虚线（用户 2026-11-06：「圆点连成虚线」）。
                // 这里按「数量越多字号越小」压到 4.5sp 下限，保证每组之间留得出缝。
                val n = dots.total
                val dotSp: Float = when {
                    n <= 2 -> tier.dotSp.toFloat()
                    n <= 3 -> tier.dotSp - 0.5f
                    n <= 4 -> tier.dotSp - 1.0f
                    else -> tier.dotSp - 1.5f
                }.coerceAtLeast(4.5f)
                Row(verticalAlignment = Alignment.Vertical.CenterVertically) {
                    // 已完成画实心橙点，未完成画空心灰点：与首页「实心=完成」同一口径
                    repeat(dots.done) { bullet(ACCENT, filled = true, dotSp) }
                    repeat(dots.undone) { bullet(DOT_OFF, filled = false, dotSp) }
                    if (tier.showMore && dots.more > 0) {
                        Text(
                            text = "+" + dots.more,
                            style = TextStyle(color = TEXT2, fontSize = dotSp.sp),
                            maxLines = 1,
                        )
                    }
                }
            }
        }
    }
}

/** 一个圆点。用字形撑大小（Glance 没有画布，也不为圆点引图片资源）。 */
@Composable
private fun bullet(color: ColorProvider, filled: Boolean, dotSp: Float) {
    Text(
        text = if (filled) "●" else "○",
        style = TextStyle(color = color, fontSize = dotSp.sp),
        maxLines = 1,
    )
}

/**
 * 「打开 App 并定位到这一天」。
 *
 * 用的是 glance-appwidget 里的 **Intent 版** actionStartActivity（不是 Class 版）：
 * 它经 ActionTrampolineActivity 转发原 Intent，extra 会原样到达 MainActivity。
 * 组件进程不该直接持有 Activity 的 Intent，走 trampoline 是官方路径。
 */
@Composable
private fun openDayIntent(date: String) = actionStartActivityIntent(
    Intent(LocalContext.current, MainActivity::class.java)
        .putExtra(EXTRA_OPEN_DATE, date),
)

/** 组件点击要跳的那一天；MainActivity 读它并让首页直接打开当天面板。 */
const val EXTRA_OPEN_DATE = "app.took.extra.OPEN_DATE"
