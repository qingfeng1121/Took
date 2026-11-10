package app.took.ui

import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.tween
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/** 设计令牌逐字取自 prototype/android.html 的 :root（浅色主题）。 */
object TookColors {
    val bg = Color(0xFFEEF0F4)
    val surface = Color(0xFFFFFFFF)
    val line = Color(0xFFF0F2F5)
    val text = Color(0xFF1F2329)
    val text2 = Color(0xFF8A9099)
    val text3 = Color(0xFFCED3DA)
    val today = Color(0xFFE53935)
    val todayWash = Color(0x0EE53935)
    val accent = Color(0xFFF97316)
    val accentWeak = Color(0xFFFFF4EC)
    val accentLine = Color(0xFFFBBF94)
    val accentText = Color(0xFFD9600F)
    val stroke = Color(0xFFE6E9EE)
    val fill = Color(0xFFF4F6F8)
    val fill2 = Color(0xFFE9ECF1)
    val mute = Color(0xFF98A0AA)
    val dotBorder = Color(0xFFA4ABB5)
    val dotOff = Color(0xFFB8BDC4)
    val more = Color(0xFFAAB0B8)
    val tabBar = Color(0xF2FFFFFF)
    val danger = Color(0xFFE53935)
    val dangerText = Color(0xFFC62828)
    val scrim = Color(0x66000000)
    /** 倒数日深色卡片（照系统日历的倒数日卡）：底色 / 卡上小字 / 卡上大数字。 */
    val countdownBg = Color(0xFF1F2329)
    val countdownSmall = Color(0xFF9AA3AE)
    val countdownBig = Color(0xFFFFFFFF)
}

/**
 * 间距 / 圆角 / 阴影的唯一出处。
 *
 * 之前各页各写一套（卡片 18dp 但内边距 14/12、控件 9~14dp、行高 30~46dp），
 * 屏幕上就出现「忽大忽小」。这里定死：页面左右 12、卡片内 14/12、卡片间距 8、
 * 卡片圆角 18 + 阴影 6、控件圆角 12（小控件 10）、所有可点控件高 44。
 */
object TookDims {
    val pageX = 12.dp
    val cardX = 14.dp
    val cardY = 12.dp
    val gap = 8.dp
    val gapLarge = 12.dp
    val cardRadius = 18.dp
    val cardShadow = 6.dp
    val controlRadius = 12.dp
    val controlRadiusSmall = 10.dp
    /** 触控目标下限：所有可点控件的**命中区**不小于这个值。 */
    val touch = 44.dp
    /** 控件视觉高度（主/次按钮、输入框）。 */
    val controlHeight = 44.dp
    /** 列表行高。 */
    val rowHeight = 44.dp
    val tabBarHeight = 58.dp

    /**
     * 月历格子（用户 2026-10-26 返工）：
     *  - **宽度** = 7 列均分，正好铺满屏宽，**不横向滚动**（1.5 倍宽那版已作废）；
     *  - **高度 76dp**：宽度回到 1/7 屏宽后 98dp 会瘦高得像卡片，76dp 让每格接近 1:1.1，
     *    一整月（6 行）+ 星期条 + 图例仍能在首屏放下大半，且日期数字与圆点不挤；
     *  - 翻月改成**纵向滑动**（上滑下个月 / 下滑上个月），顶部 ‹ › 按钮保留。
     */
    /**
 * 格子高宽比。**不再写死高度**——宽度随屏幕走（1/7 屏宽），高度若写死，
 * 窄屏上格子会被拉成 1.5:1 的瘦长条（用户 2026-10-28：「日期的格子比例有点失调」）。
 * 1.15 是「比正方略高」的比例：容得下日期 + 一行圆点 + 一点呼吸位，
 * 又不会让日期与圆点之间空出一大块。
 */
const val calendarCellAspect = 1.15f

/** 兜底高度：仅当布局拿不到宽度约束时才用（正常路径由 aspectRatio 决定）。 */
val calendarCellHeight = 76.dp

    /**
     * 连续滚动月历的**可视高度**（用户 2026-10-26 返工：「日历就像一张长长的纸，一行一行连续滚」）。
     *
     * 5 行 × 76dp + 半行：露出的半行就是「下面还有、可以继续滑」的提示；
     * 高度固定后卡片不会随 200+ 行内容撑开，页面其余部分（今日条 / 倒数日）位置稳定。
     * 原来「纵向下滑翻月」的阈值（calendarFlipThreshold）随整月替换一起废弃。
     */
    val calendarViewportHeight = 420.dp

    /**
     * 格子里的日期数字与今天的圆底（用户 2026-10-26：「首页日期字号小一点，参考这个日历」——
     * 系统日历的字相对格子偏小、留白多）。字号 17 → 15sp 后圆底同步 34 → 30dp。
     */
    val calendarDateFont = 15.sp
    val calendarTodayCircle = 30.dp
}

/**
 * 统一动效。**全项目只从这一个对象取动画规格**，不要在别处写裸 tween/spring：
 * 散落的规格会让「同样是一次侧滑」在不同页面快慢不一，用户能直接感觉到。
 *
 * - [slide] / [fade]：弹出层进场退场（260ms / 180ms）
 * - [swipe]:  列表行侧滑后回弹。原来用 Animatable.animateTo 的默认 spring，
 *             与 popup 的 tween 手感不一致；统一成同样的缓动族。
 * - [press]:  按钮按压的缩放反馈，比进场的 260ms 短，否则按下去像卡住。
 */
object TookMotion {
    const val DURATION_MS = 260
    const val FADE_MS = 180
    /** 侧滑回弹比进场略快：手指刚离开就要「归位」，慢了像在拖尾。 */
    const val SWIPE_MS = 220
    /** 按压反馈必须短，超过 120ms 会觉得「按了没反应」。 */
    const val PRESS_MS = 110

    val easing = FastOutSlowInEasing

    fun <T> slide() = tween<T>(durationMillis = DURATION_MS, easing = easing)
    fun <T> fade() = tween<T>(durationMillis = FADE_MS, easing = easing)
    fun <T> swipe() = tween<T>(durationMillis = SWIPE_MS, easing = easing)
    fun <T> press() = tween<T>(durationMillis = PRESS_MS, easing = easing)
}

@Composable
fun TookTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = lightColorScheme(
            primary = TookColors.accent,
            background = TookColors.bg,
            surface = TookColors.surface,
            onBackground = TookColors.text,
            onSurface = TookColors.text,
            error = TookColors.danger,
        ),
        content = content,
    )
}
