package app.took.ui

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.List
import androidx.compose.material.icons.filled.DateRange
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.took.calendar.MonthGridLayout
import app.took.calendar.WeekScroll
import app.took.data.DayCell
import app.took.data.DayItem
import app.took.data.MemoRow
import app.took.data.TookRepository
import app.took.data.WeekRow
import app.took.engine.DateKeys
import app.took.sync.SyncController
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.time.LocalDate

/** 底部三 tab。 */
enum class Tab(val label: String, val icon: ImageVector) {
    HOME("首页", Icons.Filled.DateRange),
    CONFIG("配置", Icons.AutoMirrored.Filled.List),
    SETTINGS("设置", Icons.Filled.Settings),
}

/**
 * 首页格子只放圆点、不放任务名（用户 2026-10-25 原话：「下方就不要显示具体的任务了，改成点点就可以了」）。
 * 圆点上限与「+N」规则在 MonthGridLayout.DOT_MAX / dotPlan 里，纯逻辑可单测。
 */

@Composable
fun TookApp(
    repo: TookRepository,
    syncController: SyncController,
    /** 每次回到前台 +1：设置页据此重读提醒权限与「下一次提醒」。 */
    resumeTick: Int = 0,
    today: LocalDate = LocalDate.now(),
    /** 桌面「月历」组件点某天传来的日期：非空时一进来就打开当天的打卡面板。 */
    openDateFromWidget: String? = null,
    /** 桌面「倒数日」组件点某张卡传来的 memo id：非空时一进来就打开该条的编辑页。 */
    openMemoFromWidget: String? = null,
) {
    val todayKey = remember(today) { DateKeys.key(today) }
    var tab by remember { mutableStateOf(Tab.HOME) }
    /** 连续滚动用的预生成范围：当月前后各 24 个月（约 50 个月 ≈ 210 行），一次读库到底。 */
    val weekRange = remember(todayKey) { WeekScroll.rangeFor(todayKey) }
    var weeks by remember { mutableStateOf<List<WeekRow>>(emptyList()) }
    var openDate by remember { mutableStateOf<String?>(null) }
    var todayItems by remember { mutableStateOf<List<DayItem>>(emptyList()) }
    /** 首页倒数日卡片（定稿 §6.5）：memo 表 kind=1，未来在前、过去在后。 */
    var countdowns by remember { mutableStateOf<List<MemoRow>>(emptyList()) }
    /** 打开某个倒数日的编辑页（null = 没开；"" = 新建）。 */
    var countdownEditId by remember { mutableStateOf<String?>(null) }
    /** 统计分析页（定稿 §3.7）。 */
    var analysisOpen by remember { mutableStateOf(false) }

    // 打卡/同步都会改库里的状态：用一个自增 tick 逼整月网格与今日条重读
    var refreshTick by remember { mutableIntStateOf(0) }

    /**
     * 从桌面「月历」点某天进来：直接打开那一天的面板。
     *
     * 只依赖这个入参，用户关掉面板不会把它弹回来（关闭只改 openDate，不回写入参）。
     */
    LaunchedEffect(openDateFromWidget) {
        if (!openDateFromWidget.isNullOrEmpty()) openDate = openDateFromWidget
    }

    /**
     * 从桌面「倒数日」点某张卡进来：直接打开该条的编辑页。
     *
     * 与上面那条是**两条独立通道**：月历传的是日期（打开某天的打卡面板），
     * 倒数日传的是 memo id（打开某条倒数日的编辑页），互不覆盖。
     */
    LaunchedEffect(openMemoFromWidget) {
        if (!openMemoFromWidget.isNullOrEmpty()) countdownEditId = openMemoFromWidget
    }

    LaunchedEffect(tab, weekRange, refreshTick) {
        if (tab == Tab.HOME) {
            weeks = withContext(Dispatchers.IO) { repo.loadWeeks(weekRange.first, weekRange.second) }
        }
    }
    LaunchedEffect(todayKey, refreshTick) {
        todayItems = withContext(Dispatchers.IO) { repo.loadDay(todayKey) }
    }
    // 倒数日卡片与今日条同一份刷新节奏：打卡、编辑、同步之后一起重读，避免首页各区块状态不同步
    LaunchedEffect(todayKey, refreshTick) {
        countdowns = withContext(Dispatchers.IO) { repo.countdowns(todayKey) }
    }

    Scaffold(
        containerColor = TookColors.bg,
        bottomBar = { TookTabBar(current = tab, onSelect = { tab = it }) },
    ) { inner ->
        Box(Modifier.fillMaxSize().padding(inner)) {
            when (tab) {
                Tab.HOME -> HomePage(
                    weeks = weeks,
                    todayKey = todayKey,
                    openDate = openDate,
                    todayItems = todayItems,
                    countdowns = countdowns,
                    onOpenDay = { openDate = it },
                    onOpenCountdown = { countdownEditId = it },
                    onOpenAnalysis = { analysisOpen = true },
                )
                Tab.CONFIG -> ConfigPage(repo = repo)
                Tab.SETTINGS -> SettingsPage(
                    repo = repo,
                    controller = syncController,
                    resumeTick = resumeTick,
                )
            }
        }
    }

    // 倒数日点击 → 打开该条编辑页（与配置页共用 CountdownFormDialog，改完刷新首页卡片）
    countdownEditId?.let { id ->
        CountdownFormDialog(
            repo = repo,
            memoId = id.takeIf { it.isNotEmpty() },
            onClose = { changed ->
                countdownEditId = null
                if (changed) refreshTick++
            },
        )
    }

    if (analysisOpen) {
        AnalysisDialog(repo = repo, todayKey = todayKey, onClose = { analysisOpen = false })
    }

    openDate?.let { date ->
        DayPanelScreen(
            date = date,
            repo = repo,
            onDismiss = { openDate = null },
            // 同一周期的其他命中日也要立刻变，所以刷新的是整月网格，不只是这一个面板
            onChanged = { refreshTick++ },
        )
    }
}

/* ---------------------------------- 首页 ---------------------------------- */

@Composable
private fun HomePage(
    weeks: List<WeekRow>,
    todayKey: String,
    openDate: String?,
    todayItems: List<DayItem>,
    countdowns: List<MemoRow>,
    onOpenDay: (String) -> Unit,
    onOpenCountdown: (String) -> Unit,
    onOpenAnalysis: () -> Unit,
) {
    val listState = rememberLazyListState()
    val scope = rememberCoroutineScope()
    val weekDates = remember(weeks) { weeks.map { it.date } }

    // 数据到位后**一次**跳到今天所在的那一行（列表本身是从 24 个月前开始的，
    // 不跳就会停在两年前）。之后打卡/同步刷新不会再跳，滚动位置保持不变。
    // 初始定位：数据首次到位时跳到**今天所在的那一行**，之后不再跳（打卡/同步刷新不打断阅读）。
    //
    // 2026-11-06 修正：原来 jumpedToToday 只在 todayKey 变化时重置，而 weeks 首次为空、
    // 第二次才有数据 —— 空列表那次把 jumpedToToday 置 true 后就不再跳，视口停在列表开头
    // （两年前），标题随之显示成很久以前的月份，与「今天」红圈所在位置完全脱节。
    // 现在用「是否已经成功定位过」这个更严格的条件：只有真的滚到位才算跳完。
    var jumpedToToday by remember(todayKey) { mutableStateOf(false) }
    LaunchedEffect(weeks, todayKey) {
        if (!jumpedToToday && weeks.isNotEmpty()) {
            val idx = WeekScroll.indexOfWeekContaining(weekDates, todayKey)
            listState.scrollToItem(idx)
            jumpedToToday = true
        }
    }

    /**
     * 顶部标题跟着**滚动位置**走：取当前屏幕最上面那一周的主月（[WeekScroll.headerMonth]）。
     *
     * 用 firstVisibleItemIndex 而不是「第一个完全可见项」：手指一推标题就跟着变，
     * 与系统日历一致；月份是「这一行 7 天里天数最多的那个月」，
     * 所以 2026-10-26~11-01 这种跨月行仍显示 10 月，下一行才变 11 月 —— 不会在月中乱跳。
     * derivedStateOf 保证只有「最上面那一行」变化时才重组标题，滚动途中不逐帧重组。
     */
    // 注意：不能套 remember(weeks, todayKey) —— 滚动时 weeks 不变，
    // remember 块不会重建，derivedStateOf 捕获的 listState 快照会失效，
    // 结果标题停在上一次算出的月份，与视口内容脱节（2026-11-07 实测）。
    // 直接每次重组都算：视口内最多 7 行 × 7 格 = 49 次字符串操作，开销可忽略。
    val headerMonth = run {
            // 标题 = **视口内所有可见天里天数最多的那个月**。
            //
            // 2026-11-07 第三次修正。前两版都错在「只看一行」：
            //   ① 看 firstVisibleItemIndex —— 滚动途中那行可能只露半截；
            //   ② 看第一个完整可见行 —— 该行 10/26~11/01 有 6 天属 10 月，于是标题判成 10 月，
            //      但视口里下面 4 行全是 11 月，用户看到的主体明明是 11 月，标题与内容完全脱节。
            // 正解：把可见的每一行 × 每格都算进去，按月累计天数，取最多的那个。
            // 这样标题永远跟着「你眼睛看到的主体月份」走，不会因为顶部一行跨月就跳错。
            val layout = listState.layoutInfo
            val visibleRows = layout.visibleItemsInfo.filter {
                it.offset + it.size > 0 && it.offset < layout.viewportEndOffset
            }
            val counts = HashMap<String, Int>()
            for (info in visibleRows) {
                val w = weeks.getOrNull(info.index) ?: continue
                for (c in w.cells) {
                    val k = c.date.substring(0, 7)
                    counts[k] = (counts[k] ?: 0) + 1
                }
            }
            counts.maxByOrNull { it.value }?.key
                ?: WeekScroll.headerMonth(WeekScroll.weekStart(todayKey))
    }

    /**
     * ‹ › 按钮：**平滑滚动**到上/下个月的第一行（不是整月替换，也不改变数据）。
     *
     * 目标月按「当前标题的月份 ±1」算；范围外（预生成 50 个月之外）直接不动。
     */
    val gotoMonth: (Int) -> Unit = { delta ->
        val target = WeekScroll.shiftMonth(headerMonth, delta)
        val idx = WeekScroll.indexOfFirstWeekOfMonth(weekDates, target)
        if (idx >= 0) scope.launch { listState.animateScrollToItem(idx) }
    }

    Column(Modifier.fillMaxSize()) {
        AppBar(
            title = WeekScroll.monthTitle(headerMonth),
            onPrev = { gotoMonth(-1) },
            onNext = { gotoMonth(1) },
            onAnalysis = onOpenAnalysis,
        )
        Column(
            Modifier
                .fillMaxWidth()
                .weight(1f)
                .verticalScroll(rememberScrollState())
                .padding(start = TookDims.pageX, end = TookDims.pageX, bottom = 16.dp),
        ) {
            CalendarCard(
                weeks = weeks,
                todayKey = todayKey,
                openDate = openDate,
                listState = listState,
                currentMonth = headerMonth,
                onOpenDay = onOpenDay,
            )
            Spacer(Modifier.height(TookDims.gapLarge))
            TodayStrip(todayKey = todayKey, items = todayItems, onView = { onOpenDay(todayKey) })
            // 倒数日卡片区（定稿 §6.5）：**日历下方**，无倒数日时整块隐藏，不留空标题占位
            if (countdowns.isNotEmpty()) {
                Spacer(Modifier.height(TookDims.gapLarge))
                CountdownSection(
                    items = countdowns,
                    todayKey = todayKey,
                    onOpen = onOpenCountdown,
                )
            }
        }
    }
}

/* ------------------------------ 倒数日卡片区 ------------------------------ */

/**
 * 倒数日**横向卡**的内边距（水平 / 垂直）。数字字号按「右侧数字区的实测宽高」折算，
 * 改这里要同步改下面 numberSize 的公式。
 */
private const val COUNTDOWN_PAD_H = 14f
private const val COUNTDOWN_PAD_V = 10f

/** 目标日就是今天时，方向行写什么（不写「还有 0 天」也不写「已经 0 天」）。 */
private const val LATER_TODAY = "就是今天"

/**
 * 首页倒数日卡片区：**2 列 × 4 行**网格（用户 2026-10-26：「app 内的倒数日为什么要改成
 * 2*2，改成 2*4」）。
 *
 * 每行 2 张、卡片宽高比 2:1 的**横向卡**（[CountdownGridLayout.ASPECT]）：
 * 左侧竖排「标题 / 方向小字 / 点分目标日」，右侧单独一个**超大数字**区。
 * 横向卡比 1:1 方形卡更适合这里 —— 方形卡在 2 列网格里只有 164dp 见方，
 * 数字最多 ~28sp；横向卡把数字单独放到右半，数字能到 ~44sp，才是「一眼看到天数」。
 *
 * 「4 行」是这一块的形态（一屏 8 张），不是硬上限：第 9 张起继续往下排，
 * 由页面的纵向滚动接住 —— 藏起来等于把倒数日弄丢。
 * 无倒数日时整块不渲染（不画空壳，§6.7 的同一口径）。
 */
@Composable
private fun CountdownSection(items: List<MemoRow>, todayKey: String, onOpen: (String) -> Unit) {
    Column(Modifier.fillMaxWidth()) {
        Row(
            Modifier.fillMaxWidth().padding(start = 4.dp, top = 2.dp, bottom = 2.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                text = "倒数日",
                fontSize = 11.5.sp,
                fontWeight = FontWeight.SemiBold,
                letterSpacing = 0.2.sp,
                color = TookColors.text2,
            )
            Spacer(Modifier.width(6.dp))
            Text(text = items.size.toString() + " 个", fontSize = 11.5.sp, color = TookColors.text3)
        }
        // 2 列 × N 行：每行 2 张横向卡。行数由条数决定（一屏 4 行 = 8 张，之后继续往下）。
        Column(
            Modifier.fillMaxWidth().padding(top = TookDims.gap),
            verticalArrangement = Arrangement.spacedBy(TookDims.gap),
        ) {
            CountdownGridLayout.rows(items).forEach { row ->
                Row(horizontalArrangement = Arrangement.spacedBy(TookDims.gap)) {
                    row.forEach { memo ->
                        CountdownCard(
                            modifier = Modifier.weight(1f),
                            memo = memo as MemoRow,
                            todayKey = todayKey,
                            onOpen = { onOpen(memo.id) },
                        )
                    }
                    // 最后一行只有一张卡：留出半格空位，卡片不被拉宽成整行
                    if (row.size == 1) Spacer(Modifier.weight(1f))
                }
            }
        }
    }
}

/**
 * 倒数日**横向卡**（2 列网格里的一格，宽高比 2:1）。
 *
 * 左边一列从上到下 = 浅灰小字标题（最多 2 行，左对齐）→ 方向小字（已经 N 天 / 还有 N 天）
 * → 点分目标日（2026.2.6）；右边独占一块 = **只放数字**的超大白色 Bold 数字。
 *
 * 视觉仍是深色底 + 大数字 + 点分日期（[TookColors.countdownBg] 等三个令牌与组件同源），
 * 只是把方形改成横向：数字从「被标题和日期夹在中间」变成「独占右半边」，
 * 这才是 2:1 卡片真正的收益。
 */
@Composable
private fun CountdownCard(
    modifier: Modifier = Modifier,
    memo: MemoRow,
    todayKey: String,
    onOpen: () -> Unit,
) {
    val parts = MemoFormats.countdownParts(memo.startDate, todayKey)
    val shape = RoundedCornerShape(TookDims.cardRadius)
    Row(
        modifier
            .aspectRatio(CountdownGridLayout.ASPECT)
            .shadow(elevation = TookDims.cardShadow, shape = shape, clip = false)
            .background(TookColors.countdownBg, shape)
            // 卡片可点：命中区就是整张卡（远大于 44dp），点击进入该倒数日的编辑页
            .tap(onClick = onOpen)
            .semanticsLabel(
                "倒数日 " + memo.title + "，目标日 " + MemoFormats.rangeFull(memo.startDate, null) + "，" + parts.text,
            )
            .padding(horizontal = COUNTDOWN_PAD_H.dp, vertical = COUNTDOWN_PAD_V.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        // 左：标题 / 方向 / 目标日（三行小字，全部左对齐，长标题 2 行省略）
        Column(Modifier.weight(1f)) {
            // memo.title 原样（不篡改用户写的「在一起」「与王语婕的纪念日」），
            // 长标题给 2 行 + 省略号，绝不硬裁半个字
            Text(
                text = memo.title,
                modifier = Modifier.fillMaxWidth(),
                fontSize = 13.sp,
                lineHeight = 16.sp,
                fontWeight = FontWeight.Medium,
                color = TookColors.countdownSmall,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
            // 方向小字单独一行：标题是用户的字，不往里塞方向词
            if (parts.days != null) {
                Spacer(Modifier.height(2.dp))
                Text(
                    text = if (parts.prefix.isEmpty()) LATER_TODAY else parts.prefix + " " + parts.days + " 天",
                    fontSize = 11.sp,
                    lineHeight = 14.sp,
                    color = TookColors.countdownSmall,
                    maxLines = 1,
                )
            }
            Spacer(Modifier.height(3.dp))
            // 底部：小字目标日，点分隔不补零（2026.2.6），与参考图一致
            Text(
                text = MemoFormats.compactDate(memo.startDate),
                fontSize = 11.sp,
                lineHeight = 14.sp,
                color = TookColors.countdownSmall,
                maxLines = 1,
                overflow = TextOverflow.Clip,
            )
        }

        Spacer(Modifier.width(8.dp))

        // 右：**只有数字**（参考图里没有方向词、没有「天」），独占右半边
        BoxWithConstraints(
            Modifier.weight(1f).fillMaxHeight(),
            contentAlignment = Alignment.Center,
        ) {
            if (parts.days == null) {
                // 没有目标日：只显示事实，不编一个数字
                Text(
                    text = parts.text,
                    fontSize = 13.sp,
                    fontWeight = FontWeight.SemiBold,
                    color = TookColors.countdownSmall,
                    textAlign = TextAlign.Center,
                )
            } else {
                // 宽度：字号 ≈ 可用宽 / 位数 × 1.28（粗体数字实测步进约 0.78 字宽）；
                // 高度：字号上限 = 可用高 / 1.06（行高系数）。两者取小后夹到 22~56sp。
                val digits = parts.days.toString().length
                val byWidth = maxWidth.value / digits * 1.28f
                val byHeight = maxHeight.value / 1.06f
                val numberSize = minOf(byWidth, byHeight).coerceIn(22f, 56f)
                Text(
                    text = parts.days.toString(),
                    fontSize = numberSize.sp,
                    lineHeight = (numberSize * 1.06f).sp,
                    fontWeight = FontWeight.Bold,
                    letterSpacing = (-numberSize * 0.03f).sp,
                    maxLines = 1,
                    softWrap = false,
                    textAlign = TextAlign.Center,
                    color = if (parts.prefix.isEmpty()) TookColors.today else TookColors.countdownBig,
                )
            }
        }
    }
}

@Composable
private fun AppBar(title: String, onPrev: () -> Unit, onNext: () -> Unit, onAnalysis: () -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .height(58.dp)
            .padding(start = 18.dp, end = TookDims.pageX),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text = title,
            fontSize = 19.sp,
            lineHeight = 24.sp,
            fontWeight = FontWeight.SemiBold,
            letterSpacing = (-0.3).sp,
            color = TookColors.text,
        )
        Spacer(Modifier.weight(1f))
        // 入口照原型 #navAnalysis：首页应用栏的柱状图按钮（视觉 34 / 命中 44）。
        // material-icons-core 里没有 BarChart（属于扩展集，不为此加依赖），用三条等高柱手绘。
        TookIconButton(label = "统计分析", onClick = onAnalysis) {
            Row(
                modifier = Modifier.size(18.dp),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.Bottom,
            ) {
                listOf(6.dp, 12.dp, 9.dp).forEach { h ->
                    Box(
                        Modifier
                            .width(3.dp)
                            .height(h)
                            .clip(RoundedCornerShape(1.dp))
                            .background(TookColors.accentText),
                    )
                }
            }
        }
        Spacer(Modifier.width(4.dp))
        // 翻月：命中区 44dp（原来 34dp，点不准）
        TookIconButton(label = "上个月", onClick = onPrev) {
            Text("‹", fontSize = 21.sp, color = TookColors.text2)
        }
        Spacer(Modifier.width(4.dp))
        TookIconButton(label = "下个月", onClick = onNext) {
            Text("›", fontSize = 20.sp, color = TookColors.text2)
        }
    }
}

/**
 * 月历卡 —— **连续滚动**版（用户 2026-10-26 返工，验收重点是体感）。
 *
 * 用户原话：「向下滑，日历就像一张长长的纸，一天一天、一周一周（一行一行）地连续往下滚动。
 * 滚动到月底后，无缝衔接下一月。」以及「不要出现下滑就是滚动一个月」。
 *
 *  - 内容 = [LazyColumn]，**一项 = 一周**（周一到周日 7 格），周与周之间日期严格 +7 天，
 *    跨月/跨年都是同一张纸上的下一行，没有任何分页、替换或动画；
 *  - 轻滑 = 滚一两行，大力滑 = LazyColumn 自带的 fling 惯性连续滚多行；
 *  - 高度固定在 [TookDims.calendarViewportHeight]（约 5 行）：卡片不会随内容撑到 200+ 行，
 *    露出的半行就是「还能继续往下滑」的提示；
 *  - 顶部星期条固定不滚（滚动的是它下面的日期行）；
 *  - 格子点击照旧打开当天面板。
 *
 * 性能：整段范围（约 210 行）在 [TookRepository.loadWeeks] 里**一次**读库展开完，
 * 滚动时只做布局不做计算；[LazyColumn] 的 key 是周起始日，打卡刷新后滚动位置不跳。
 */
@Composable
private fun CalendarCard(
    weeks: List<WeekRow>,
    todayKey: String,
    openDate: String?,
    listState: LazyListState,
    /** 当前显示的真实月份（'YYYY-MM'），用于灰化非本月日期。 */
    currentMonth: String,
    onOpenDay: (String) -> Unit,
) {
    val shape = RoundedCornerShape(TookDims.cardRadius)
    Box(
        Modifier
            .fillMaxWidth()
            .shadow(elevation = TookDims.cardShadow, shape = shape, clip = false)
            .background(TookColors.surface, shape),
    ) {
        Column(Modifier.padding(start = 8.dp, end = 8.dp, top = 12.dp, bottom = 10.dp)) {
            BoxWithConstraints(Modifier.fillMaxWidth()) {
                val cellWidth = with(LocalDensity.current) {
                    MonthGridLayout.cellWidthPx(constraints.maxWidth).toDp()
                }
                Column {
                    WeekHeader(cellWidth = cellWidth)
                    // 滚动区自身的语义串 = 「起始周 <周一日期>」：uiautomator dump 里会连
                    // 只露半行的项一起列出，光看格子分不清「视口最上面是哪一周」；
                    // 这个标记直接给出答案，轻滑几行、有没有整月跳都能一眼断言。
                    val anchor = weeks.getOrNull(listState.firstVisibleItemIndex)?.date
                    LazyColumn(
                        state = listState,
                        modifier = Modifier
                            .fillMaxWidth()
                            .height(TookDims.calendarViewportHeight)
                            .semanticsLabel(CALENDAR_SCROLL_TAG + " 起始周 " + (anchor ?: "-")),
                    ) {
                        items(
                            items = weeks,
                            // key = 周起始日：打卡/同步刷新后同一周仍是同一项，滚动位置不跳
                            key = { it.date },
                            // contentType：所有周都是同一种布局，明确告诉 LazyColumn 可以复用
                            contentType = { "week" },
                        ) { week ->
                            WeekRowView(
                                week = week,
                                cellWidth = cellWidth,
                                todayKey = todayKey,
                                openDate = openDate,
                                currentMonth = currentMonth,
                                onOpenDay = onOpenDay,
                            )
                        }
                    }
                }
            }
            CalFoot()
        }
    }
}

/** 连续滚动列表的 testTag / 语义标记：真机 dump 靠它认出「日历滚动区」。 */
internal const val CALENDAR_SCROLL_TAG = "calendar-weeks"

/**
 * 一行 = 一周（7 格）。
 *
 * [WeekRow.cells] 在数据层已经算好（一次读库），这里只做布局：
 * 用 [remember] 按 week 缓存这份列表的引用，滚动时同一行不会重复取列表。
 */
@Composable
private fun WeekRowView(
    week: WeekRow,
    cellWidth: androidx.compose.ui.unit.Dp,
    todayKey: String,
    openDate: String?,
    /** 当前显示的真实月份（'YYYY-MM'），由顶部标题同一个 headerMonth 给出。 */
    currentMonth: String,
    onOpenDay: (String) -> Unit,
) {
    // 不在这里重建 cells：那会每跨一次月就 map+copy 42 个对象（用户 2026-11-06「滑动一卡一卡」）。
    // 灰化判定下沉到 DayCellView，只传一个 String，零对象分配。
    val cells = remember(week) { week.cells }
    // 行高 = 列宽 × 比例。写死高度会在不同屏宽上产生不同比例（1080px 屏上 50×76 = 1.51:1，瘦长）；
    // 按列宽算则任何屏幕都是同一个高宽比（用户 2026-10-28：「日期的格子比例有点失调」）。
    val rowHeight = cellWidth * TookDims.calendarCellAspect
    Row(Modifier.height(rowHeight)) {
        for (cell in cells) {
            Box(Modifier.width(cellWidth).fillMaxHeight()) {
                DayCellView(
                    cell = cell,
                    todayKey = todayKey,
                    openDate = openDate,
                    currentMonth = currentMonth,
                    onOpen = { onOpenDay(cell.date) },
                )
            }
        }
    }
}

/** 星期标题条：每格宽度与下面的日期格子**逐列对齐**（共用 cellWidth，7 列正好铺满）。 */
@Composable
private fun WeekHeader(cellWidth: androidx.compose.ui.unit.Dp) {
    Column {
        Row(Modifier.padding(bottom = 6.dp)) {
            MonthGridLayout.WEEK_TITLES.forEachIndexed { i, t ->
                Box(Modifier.width(cellWidth), contentAlignment = Alignment.Center) {
                    Text(
                        text = t,
                        textAlign = TextAlign.Center,
                        fontSize = 12.5.sp,
                        fontWeight = FontWeight.Medium,
                        color = if (i >= 5) TookColors.text3 else TookColors.text2,
                    )
                }
            }
        }
        HorizontalDivider(thickness = 1.dp, color = TookColors.line)
    }
}


/**
 * 一格：日期数字 + 记事小字 + 一行圆点。
 *
 * 用户 2026-10-25：「下方不要显示具体的任务了，改成点点就可以了」——
 * 任务名整条移除，只剩圆点（已完成实心橙 / 未完成空心灰 / 超 6 个补「+N」）。
 * 任务名不再是文字，点击不再需要区分「点任务名还是点格子」：整格可点即打开当天面板。
 * 任务明细保留在整格的 content-desc 里（uiautomator 仍可断言每天有几个任务、几个已完成）。
 */
@Composable
private fun DayCellView(
    cell: DayCell,
    todayKey: String,
    openDate: String?,
    /** 当前显示的真实月份（'YYYY-MM'）。灰化按它判，不按「这一行的主月」。 */
    currentMonth: String,
    onOpen: () -> Unit,
) {
    val isToday = cell.date == todayKey
    val isOpen = cell.date == openDate
    // 灰化按**真实当前月**判（用户 2026-11-06）：
    //   当前显示 2027 年 12 月 → 12/1~12/31 全部深色；11/27~30 与 1/1~13 全部置灰。
    // 不能用 cell.inMonth（那是「这一行的主月」，会导致 12/1 落在 11 月为主月的行里被误灰、
    // 12/31 落在 1 月为主月的行里被误灰 —— 正是用户截图里的现象）。
    val inCurrentMonth = cell.date.startsWith(currentMonth)
    val bg = when {
        isOpen -> TookColors.accentWeak
        isToday -> TookColors.todayWash
        else -> Color.Transparent
    }
    // 用「日期 + 完成状态串」当 remember key，而不是 List 引用 ——
    // List 每次重组引用都可能变，导致排序与 dotPlan 白算一遍（滚动时每帧都触发）。
    // 日期唯一确定一格，完成状态串能捕捉打卡变化，两者拼起来既稳定又准确。
    val stateKey = cell.date + "|" + cell.items.joinToString("") { if (it.done) "1" else "0" }
    val items = remember(stateKey) { cell.items.sortedBy { it.done } }
    val memos = cell.memos
    val dots = remember(stateKey) { MonthGridLayout.dotPlan(cell.items.map { it.done }) }
    val taskCount = items.size
    val doneCount = items.count { it.done }

    // 整格的语义：日期 + 任务数 + 已完成数（用户要求 uiautomator 能验到「3 个任务 1 个已完成」）
    val cellLabel = buildString {
        append(cell.date)
        // 调试标记：dump 里能直接看到这一格的月份判定，便于验证灰化逻辑
        append(if (inCurrentMonth) " 本月" else " 非本月")
        append(" 当天安排")
        append("，").append(taskCount).append(" 个任务")
        if (taskCount > 0) append(" ").append(doneCount).append(" 个已完成")
        if (memos.isNotEmpty()) {
            append("，记事 ").append(memos.size).append(" 条：")
            append(memos.joinToString("，") { it.title })
        }
    }

    Column(
        Modifier
            .fillMaxSize()
            .clip(RoundedCornerShape(TookDims.controlRadiusSmall))
            .background(bg)
            // 不再用整格 alpha：那会把圆点、记事一起淡掉，且与「文字置灰」的常规日历观感不同。
            // 非本月只改文字颜色，圆点保持原样（任务事实不因月份归属而变）。
            .clickable(onClick = onOpen)
            .semanticsLabel(cellLabel)
            .padding(top = 8.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        // 日期数字：15sp（用户 2026-10-26 参考系统日历「字小留白多」的要求，从 17sp 降下来）。
        // 圆底同步 34 → 30dp，否则字小了圆还那么大，看着空。
        // 格子宽度回到 1/7 屏宽后这里**不再缩字**：15sp 在约 46dp 宽的格子里仍留得下两位数，
        // 圆点 7dp、记事 11sp 也都保留（用户明确不许把日期/圆点缩到看不见）。
        Box(
            Modifier
                .size(TookDims.calendarTodayCircle)
                .clip(CircleShape)
                .background(if (isToday) TookColors.today else Color.Transparent),
            contentAlignment = Alignment.Center,
        ) {
            Text(
                text = cell.date.substring(8).trimStart('0'),
                fontSize = TookDims.calendarDateFont,
                lineHeight = 20.sp,
                fontWeight = if (isToday) FontWeight.Bold else FontWeight.Medium,
                // 非本月用弱化色，本月用主文本色（常规日历观感）。
                color = when {
                    isToday -> Color.White
                    !inCurrentMonth -> TookColors.mute
                    else -> TookColors.text
                },
            )
        }

        // 日期与下方内容之间给 2dp 固定间距：原来靠底部 weight Box 撑开，现在显式给
        if (memos.isNotEmpty() || items.isNotEmpty()) {
            Spacer(Modifier.height(2.dp))
            // 记事仍用一行小字：格子够宽，11sp + 2 行也不会挤（任务名才是用户要去掉的那一项）
            if (memos.isNotEmpty()) {
                Column(
                    Modifier.fillMaxWidth().padding(top = 1.dp, start = 4.dp, end = 4.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    memos.take(2).forEach { memo ->
                        Text(
                            text = memo.title,
                            modifier = Modifier.fillMaxWidth(),
                            fontSize = 11.sp,
                            lineHeight = 15.sp,
                            maxLines = 1,
                            overflow = TextOverflow.Clip,
                            textAlign = TextAlign.Center,
                            color = TookColors.text2,
                            fontWeight = FontWeight.Medium,
                        )
                    }
                    if (memos.size > 2) {
                        Text(
                            text = "+" + (memos.size - 2),
                            fontSize = 11.sp,
                            lineHeight = 14.sp,
                            color = TookColors.more,
                        )
                    }
                }
            }
            if (items.isNotEmpty()) {
                DotsRow(dots = dots, gapStart = memos.isNotEmpty())
            }
        }

        // 圆点之后**不再用 weight 吸空**。
        // 用户 2026-10-28：「日期的格子比例有点失调」——原来这里放 Box(weight(1f))，
        // 把格子多出来的高度全塞在圆点下方，结果日期贴着顶、圆点贴着底，中间空一大块。
        // 现在内容自上而下紧凑排列，多余空间留在整格底部（视觉上就是格子里的下留白）。
    }
}

/**
 * 一行圆点：已完成 = 实心橙点，未完成 = 空心灰点，超过 6 个在末尾补「+N」文字。
 * 圆点本身不吃点击（整格已经是可点目标），语义靠格子的 content-desc 兜住。
 */
@Composable
private fun DotsRow(dots: MonthGridLayout.DotPlan, gapStart: Boolean) {
    // 圆点尺寸与间距按**实际数量**自适应收缩。
    //
    // 为什么必须收：格子宽约 50dp，去掉左右各 2dp 只剩 46dp。
    // 原来固定「7dp 点 + 4dp 间距」，5 个点需要 5×7 + 4×4 = 51dp > 46dp，
    // 溢出后相邻两格的圆点在视觉上连成一条虚线（用户 2026-10-28：「比例失调」），
    // 7 个格子看起来就是一条长点线，分不清哪格有几个点。
    //
    // 取法：先按理想尺寸 7dp/4dp 算总宽，放不下就等比缩到 4dp/2dp 下限；
    // 圆点最小 4dp 仍能分辨实心/空心，再小就没意义了。
    // 可用宽度只占格宽的约 68%，**两侧各留 16% 空白**。
    // 这是让「相邻格子的圆点不连成一条线」的关键：格子本身无边框、底色全透明，
    // 若圆点铺满格宽（原 92%），7 个格子的圆点之间只剩几像素缝隙，视觉上就是一条长虚线。
    // 留出 16% + 16% 后，格与格之间的空白达到格宽的 32%，一眼能分出每组。
    val n = dots.done + dots.undone
    val availDp = 34f
    val ideal = n * 7f + (n - 1).coerceAtLeast(0) * 4f
    val scale = if (ideal <= availDp) 1f else (availDp / ideal).coerceAtLeast(0.5f)
    val dotSize = (7f * scale).coerceAtLeast(3.5f)
    val dotGap = (4f * scale).coerceAtLeast(1.5f)
    val borderW = (1.5f * scale).coerceAtLeast(1f)

    Row(
        // 这里**不能**再挂 pointerInput 吞点击：圆点行占格子下半截，吞掉就等于格子下半截点不动。
        // 整格统一由 DayCellView 的 clickable 接收，圆点只是画上去的。
        Modifier.padding(top = if (gapStart) 4.dp else 2.dp, start = 2.dp, end = 2.dp),
        horizontalArrangement = Arrangement.spacedBy(dotGap.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        repeat(dots.done) {
            Box(Modifier.size(dotSize.dp).clip(CircleShape).background(TookColors.accent))
        }
        repeat(dots.undone) {
            Box(
                Modifier
                    .size(dotSize.dp)
                    .clip(CircleShape)
                    .border(borderW.dp, TookColors.dotBorder, CircleShape),
            )
        }
        if (dots.more > 0) {
            Text(
                text = "+" + dots.more,
                fontSize = 10.sp,
                lineHeight = 12.sp,
                fontWeight = FontWeight.Medium,
                color = TookColors.more,
            )
        }
    }
}

@Composable
private fun CalFoot() {
    Column(Modifier.fillMaxWidth()) {
        HorizontalDivider(
            modifier = Modifier.padding(top = 8.dp),
            thickness = 1.dp,
            color = TookColors.line,
        )
        Row(
            Modifier
                .fillMaxWidth()
                .height(40.dp)
                .padding(horizontal = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            LegendDot("已完成", TookColors.accent, filled = true)
            Spacer(Modifier.width(14.dp))
            LegendDot("未完成", TookColors.dotBorder, filled = false)
            Spacer(Modifier.width(14.dp))
            LegendDot("今天", TookColors.today, filled = true)
            Spacer(Modifier.weight(1f))
            // 月历 7 列铺满、竖直滑动翻月；原来的「紧凑档」标签不成立，保持去掉
        }
    }
}

/** 图例：与格子里的圆点同一形态（实心/空心、尺寸一致），否则图例和格子对不上。 */
@Composable
private fun LegendDot(label: String, color: Color, filled: Boolean) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        TookDot(color, size = 7.dp, filled = filled)
        Spacer(Modifier.width(6.dp))
        Text(label, fontSize = 12.sp, color = TookColors.text2)
    }
}

@Composable
private fun TodayStrip(todayKey: String, items: List<DayItem>, onView: () -> Unit) {
    val shape = RoundedCornerShape(TookDims.cardRadius)
    val doneCount = items.count { it.done }
    val sub = if (items.isEmpty()) "今天没有任务" else items.size.toString() + " 条任务 · " + doneCount + " 已完成"
    Box(
        Modifier
            .fillMaxWidth()
            .shadow(elevation = TookDims.cardShadow, shape = shape, clip = false)
            .background(TookColors.surface, shape)
            .padding(start = 16.dp, end = 10.dp, top = 12.dp, bottom = 12.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(
                    text = "今天 · " + DayFormats.dayWithWeekday(todayKey),
                    fontSize = 13.5.sp,
                    fontWeight = FontWeight.SemiBold,
                    letterSpacing = (-0.1).sp,
                    color = TookColors.text,
                )
                Text(
                    text = sub,
                    fontSize = 11.5.sp,
                    color = TookColors.text2,
                    modifier = Modifier.padding(top = 3.dp),
                )
            }
            Spacer(Modifier.width(10.dp))
            TookChip("查看", onClick = onView)
        }
    }
}

/* -------------------------------- 底部导航 -------------------------------- */

@Composable
private fun TookTabBar(current: Tab, onSelect: (Tab) -> Unit) {
    Column(Modifier.fillMaxWidth().background(TookColors.tabBar).navigationBarsPadding()) {
        HorizontalDivider(thickness = 1.dp, color = TookColors.line)
        Row(Modifier.fillMaxWidth().height(TookDims.tabBarHeight)) {
            Tab.entries.forEach { tab ->
                val active = tab == current
                val tint by animateColorAsState(
                    targetValue = if (active) TookColors.accent else TookColors.text2,
                    animationSpec = TookMotion.fade(),
                    label = "tabTint",
                )
                val barWidth by animateDpAsState(
                    targetValue = if (active) 18.dp else 0.dp,
                    animationSpec = TookMotion.slide(),
                    label = "tabBar",
                )
                Column(
                    Modifier
                        .weight(1f)
                        .fillMaxHeight()
                        .tap { onSelect(tab) },
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.Center,
                ) {
                    // 选中指示条：纯水平尺寸动画，不上下跳
                    Box(
                        Modifier
                            .height(3.dp)
                            .width(barWidth)
                            .clip(RoundedCornerShape(2.dp))
                            .background(TookColors.accent),
                    )
                    Spacer(Modifier.height(4.dp))
                    Icon(
                        imageVector = tab.icon,
                        contentDescription = tab.label,
                        modifier = Modifier.size(21.dp),
                        tint = tint,
                    )
                    Text(
                        text = tab.label,
                        modifier = Modifier.padding(top = 3.dp),
                        fontSize = 11.sp,
                        color = tint,
                        fontWeight = if (active) FontWeight.SemiBold else FontWeight.Normal,
                    )
                }
            }
        }
    }
}
