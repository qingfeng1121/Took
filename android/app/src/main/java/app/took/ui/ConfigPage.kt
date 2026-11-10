package app.took.ui

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.took.data.ConfigCategory
import app.took.data.ConfigListLogic
import app.took.data.EditOutcome
import app.took.data.MemoKind
import app.took.data.MemoOutcome
import app.took.data.MemoRow
import app.took.data.RuleRow
import app.took.data.RuleWithTasks
import app.took.data.TookRepository
import app.took.engine.RepeatMode
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * 配置页：规则与任务（契约 §9）+ 记事 / 倒数日 / 笔记本（契约 §10）。
 *
 * 交互（2026-10-25 按用户截图改）：
 *  - 顶部是**类型导航**（规则 / 记事 / 倒数日 / 笔记本，各带条数），点哪类下面只显示哪类，
 *    不再把所有类堆成一条长滚动；选中态是橙色下划线（与首页底部 tab 同一套视觉）；
 *  - 每个列表行支持**左滑**露出「置顶 / 编辑 / 删除」三个按钮（见 SwipeRevealRow）：
 *    置顶 = 排到列表最前（顺序存本机偏好，不动库、不同步），编辑 = 打开对应编辑页，
 *    删除 = 走原来的二次确认；
 *  - **点行仍然打开编辑页**，左滑只露按钮，不抢点击；
 *  - 行尾的「⋯」更多按钮与**长按菜单**已删除（用户 2026-10-26：「三个点点更多按钮可以去掉，
 *    当前左滑的功能与更多的功能重合了」）——「置顶 / 编辑 / 删除」只剩左滑一个入口；
 *  - 删除确认是**独立 Dialog**（不是页内叠加层）：页内叠加挡不住下层卡片，
 *    会出现「点确认，底下的规则也被点开」——这就是用户说的「按钮跟内容对不上」；
 *  - 所有可点元素都走 Modifier.tap，一定带 ripple。
 */
@Composable
fun ConfigPage(repo: TookRepository) {
    val scope = rememberCoroutineScope()
    /** 当前类型（ConfigCategory.RULE / NOTE / COUNTDOWN / NOTEBOOK）。 */
    var category by remember { mutableStateOf(ConfigCategory.RULE) }
    var rules by remember { mutableStateOf<List<RuleWithTasks>?>(null) }
    var memos by remember { mutableStateOf<List<MemoRow>>(emptyList()) }
    var tick by remember { mutableIntStateOf(0) }
    var editorOpen by remember { mutableStateOf(false) }
    var editorRuleId by remember { mutableStateOf<String?>(null) }
    var deleteTarget by remember { mutableStateOf<RuleWithTasks?>(null) }
    var notice by remember { mutableStateOf<String?>(null) }
    var memoEditor by remember { mutableStateOf<MemoEditorTarget?>(null) }
    var memoDeleteTarget by remember { mutableStateOf<MemoRow?>(null) }
    /** 笔记本分类管理页（改名 / 删除分类）。 */
    var categoryOpen by remember { mutableStateOf(false) }
    /** 当前左滑展开的那一行（id）；同一时刻只允许一行展开，切类型时清空。 */
    var swipeOpen by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(tick) {
        rules = withContext(Dispatchers.IO) { repo.loadPinnedRules() }
        // 三类分别按各自的置顶顺序取，再按类型分组（记事 / 倒数日 / 笔记本互不干扰）
        memos = withContext(Dispatchers.IO) {
            MemoKind.ALL.flatMap { repo.loadPinnedMemos(it) }
        }
    }

    val ruleList = rules.orEmpty()
    val counts = ConfigListLogic.counts(ruleList.size, memos)
    // 切类型 → 已经展开的滑动行要收回，否则新列表里那一行会莫名是打开的
    LaunchedEffect(category) { swipeOpen = null }

    Column(Modifier.fillMaxSize()) {
        Row(
            Modifier
                .fillMaxWidth()
                .padding(start = 18.dp, end = TookDims.pageX, top = 0.dp, bottom = 0.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                text = "配置",
                modifier = Modifier.weight(1f),
                fontSize = 17.5.sp,
                fontWeight = FontWeight.SemiBold,
                letterSpacing = (-0.3).sp,
                color = TookColors.text,
            )
            if (category == ConfigCategory.NOTEBOOK) {
                TookChip("分类管理") { categoryOpen = true }
                Spacer(Modifier.width(6.dp))
            }
            TookChip(
                if (category == ConfigCategory.RULE) "＋ 新建规则"
                else ConfigCategory.newLabel(category),
            ) {
                if (category == ConfigCategory.RULE) {
                    editorRuleId = null
                    editorOpen = true
                } else {
                    memoEditor = MemoEditorTarget(ConfigCategory.memoKindOf(category)!!, null)
                }
            }
        }
        Column(
            Modifier
                .fillMaxWidth()
                .weight(1f)
                .verticalScroll(rememberScrollState())
                .padding(start = TookDims.pageX, end = TookDims.pageX, bottom = 20.dp),
        ) {
            notice?.let {
                Text(
                    text = it,
                    modifier = Modifier.padding(start = 4.dp, top = 4.dp, bottom = 4.dp),
                    fontSize = 11.sp,
                    color = TookColors.accentText,
                )
            }
            ConfigTypeNav(
                current = category,
                counts = counts,
                onSelect = { category = it },
            )
            if (category == ConfigCategory.RULE) {
                val list = rules
                when {
                    list == null -> Unit
                    list.isEmpty() -> TookCard {
                        TookEmpty("还没有任何规则\n点右上角「＋ 新建规则」开始", vertical = 18.dp)
                    }
                    else -> list.forEach { item ->
                        val id = item.rule.id
                        SwipeRevealRow(
                            isOpen = swipeOpen == id,
                            onOpenChange = { open -> swipeOpen = if (open) id else null },
                            actions = listOf(
                                SwipeAction("置顶", TookColors.accentWeak, TookColors.accentText) {
                                    swipeOpen = null
                                    togglePin(scope, repo, ConfigCategory.RULE, id, item.rule.title) { msg ->
                                        notice = msg
                                        tick++
                                    }
                                },
                                SwipeAction("编辑", TookColors.fill, TookColors.text) {
                                    swipeOpen = null
                                    editorRuleId = id
                                    editorOpen = true
                                },
                                SwipeAction("删除", TookColors.danger, androidx.compose.ui.graphics.Color.White) {
                                    swipeOpen = null
                                    deleteTarget = item
                                },
                            ),
                        ) {
                            RuleCard(
                                item = item,
                                onOpen = {
                                    editorRuleId = id
                                    editorOpen = true
                                },
                            )
                        }
                        Spacer(Modifier.height(TookDims.gap))
                    }
                }
            } else {
                val kind = ConfigCategory.memoKindOf(category) ?: MemoKind.NOTE
                val group = ConfigListLogic.memosOf(memos, category)
                if (group.isEmpty()) {
                    TookCard {
                        TookEmpty(
                            "还没有" + MemoKind.label(kind) + "\n点右上角「" +
                                ConfigCategory.newLabel(category) + "」新建一条",
                            vertical = 18.dp,
                        )
                    }
                } else {
                    group.forEach { memo ->
                        SwipeRevealRow(
                            isOpen = swipeOpen == memo.id,
                            onOpenChange = { open -> swipeOpen = if (open) memo.id else null },
                            actions = listOf(
                                SwipeAction("置顶", TookColors.accentWeak, TookColors.accentText) {
                                    swipeOpen = null
                                    togglePin(scope, repo, category, memo.id, memoTitleOf(memo)) { msg ->
                                        notice = msg
                                        tick++
                                    }
                                },
                                SwipeAction("编辑", TookColors.fill, TookColors.text) {
                                    swipeOpen = null
                                    memoEditor = MemoEditorTarget(memo.kind, memo.id)
                                },
                                SwipeAction("删除", TookColors.danger, androidx.compose.ui.graphics.Color.White) {
                                    swipeOpen = null
                                    memoDeleteTarget = memo
                                },
                            ),
                        ) {
                            MemoCard(
                                memo = memo,
                                onOpen = { memoEditor = MemoEditorTarget(memo.kind, memo.id) },
                            )
                        }
                        Spacer(Modifier.height(TookDims.gap))
                    }
                }
            }
            Spacer(Modifier.height(14.dp))
            Footnote(
                "Tool · 周期打卡日历 · 一个周期只打卡一次。" +
                    "改重复设置（每周/每 N 天/每月/每年/开始日期）不会原地改：" +
                    "旧规则结束在昨天，另建一条从今天开始，历史打卡留在旧规则下。" +
                    "左滑一行可置顶 / 编辑 / 删除；置顶只影响本机列表顺序，不进同步。",
            )
        }
    }

    // 编辑页从右侧滑入（独立窗口，见 SlideInPanel 的注释）
    if (editorOpen) {
        RuleEditorDialog(
            repo = repo,
            ruleId = editorRuleId,
            onClose = { changed ->
                editorOpen = false
                if (changed) tick++
            },
        )
    }

    deleteTarget?.let { target ->
        TookDialog(onDismiss = { deleteTarget = null }) { requestClose ->
            TookConfirmCard(
                title = "删除规则",
                lines = listOf(
                    "将删除该规则及其 ${target.tasks.size} 个任务（打卡历史保留）",
                    "「${target.rule.title}」· ${RepeatFormat.describe(target.rule)}",
                ),
                confirm = "删除",
                dismiss = "取消",
                onConfirm = {
                    requestClose()
                    deleteTarget = null
                    scope.launch {
                        val outcome = withContext(Dispatchers.IO) { repo.deleteRule(target.rule.id) }
                        when (outcome) {
                            is EditOutcome.Deleted -> {
                                notice = "已删除「${target.rule.title}」及其 ${outcome.taskCount} 个任务"
                                tick++
                            }
                            is EditOutcome.Invalid -> notice = outcome.errors.joinToString("；")
                            is EditOutcome.Rejected -> notice = outcome.reason
                            else -> Unit
                        }
                    }
                },
                onDismiss = {
                    requestClose()
                    deleteTarget = null
                },
            )
        }
    }

    if (categoryOpen) {
        CategoryDialog(
            repo = repo,
            onClose = { changed ->
                categoryOpen = false
                if (changed) tick++
            },
        )
    }

    // 记事 / 笔记本走文档式全屏页，倒数日走普通表单（契约 §10.4）
    memoEditor?.let { target ->
        val close: (Boolean) -> Unit = { changed ->
            memoEditor = null
            if (changed) tick++
        }
        when (target.kind) {
            MemoKind.COUNTDOWN -> CountdownFormDialog(repo = repo, memoId = target.memoId, onClose = close)
            else -> DocEditorDialog(repo = repo, kind = target.kind, memoId = target.memoId, onClose = close)
        }
    }

    memoDeleteTarget?.let { target ->
        TookDialog(onDismiss = { memoDeleteTarget = null }) { requestClose ->
            TookConfirmCard(
                title = "删除" + MemoKind.label(target.kind),
                lines = listOf(
                    "将删除" + MemoKind.label(target.kind) + "「" + memoTitleOf(target) + "」，删除后不可恢复",
                    if (target.kind == MemoKind.NOTE) "月历上命中的那几天会同时消失" else "它不进月历，也未参与打卡",
                ),
                confirm = "删除",
                dismiss = "取消",
                onConfirm = {
                    requestClose()
                    memoDeleteTarget = null
                    scope.launch {
                        val outcome = withContext(Dispatchers.IO) { repo.deleteMemo(target.id) }
                        when (outcome) {
                            is MemoOutcome.Deleted -> {
                                notice = "已删除" + MemoKind.label(target.kind) + "「" + memoTitleOf(target) + "」"
                                tick++
                            }
                            is MemoOutcome.Invalid -> notice = outcome.errors.joinToString("；")
                            is MemoOutcome.Rejected -> notice = outcome.reason
                            else -> Unit
                        }
                    }
                },
                onDismiss = {
                    requestClose()
                    memoDeleteTarget = null
                },
            )
        }
    }
}

/**
 * 置顶 / 取消置顶：写本机偏好后立刻重读整页，并回一句「已置顶 / 已取消置顶」。
 *
 * 再点一次已置顶的行 = 取消置顶（否则顺序会被永久锁死，用户没有回头路）。
 */
private fun togglePin(
    scope: kotlinx.coroutines.CoroutineScope,
    repo: TookRepository,
    category: String,
    id: String,
    title: String,
    onDone: (String) -> Unit,
) {
    scope.launch {
        val wasPinned = withContext(Dispatchers.IO) { repo.pinnedIds(category) }.contains(id)
        withContext(Dispatchers.IO) { repo.togglePin(category, id) }
        onDone(if (wasPinned) "已取消置顶「" + title + "」" else "已置顶「" + title + "」，已排到最前")
    }
}

/**
 * 类型导航：四个横向分段，每段「类名 + 条数」，选中态 = 橙色文字 + 橙色下划线
 * （与首页底部 tab 的选中样式同一套：3dp 圆角指示条 + 颜色动画）。
 *
 * 用 [TookDims.touch] 保证每段命中区不低于 44dp；四段等分整行宽度。
 */
@Composable
private fun ConfigTypeNav(
    current: String,
    counts: Map<String, Int>,
    onSelect: (String) -> Unit,
) {
    Row(
        Modifier
            .fillMaxWidth()
            .padding(top = 2.dp, bottom = 2.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        ConfigCategory.ALL.forEach { id ->
            val active = id == current
            val tint by animateColorAsState(
                targetValue = if (active) TookColors.accentText else TookColors.text2,
                animationSpec = TookMotion.fade(),
                label = "cfgNavTint",
            )
            val barWidth by animateDpAsState(
                targetValue = if (active) 22.dp else 0.dp,
                animationSpec = TookMotion.slide(),
                label = "cfgNavBar",
            )
            Column(
                Modifier
                    .weight(1f)
                    .height(TookDims.touch)
                    .tap { onSelect(id) }
                    .semanticsLabel("类型 " + ConfigCategory.label(id)),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.Center,
            ) {
                Text(
                    text = ConfigCategory.tabText(id, counts[id] ?: 0),
                    fontSize = 13.sp,
                    fontWeight = if (active) FontWeight.SemiBold else FontWeight.Normal,
                    color = tint,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Spacer(Modifier.height(4.dp))
                Box(
                    Modifier
                        .height(3.dp)
                        .width(barWidth)
                        .clip(RoundedCornerShape(2.dp))
                        .background(TookColors.accent),
                )
            }
        }
    }
    HorizontalDivider(thickness = 1.dp, color = TookColors.line)
}

/** 配置页里正在编辑的 memo：kind 决定用哪种编辑页，memoId 为空 = 新建。 */
private data class MemoEditorTarget(val kind: Int, val memoId: String?)

private fun memoTitleOf(memo: MemoRow): String = when {
    memo.title.isNotBlank() -> memo.title
    memo.kind == MemoKind.NOTEBOOK -> "无标题笔记"
    else -> "（无标题）"
}

/** memo 类型的小徽标：左图标位（列表行统一「左图标 + 标题 + 副标题 + 右控件」）。 */
@Composable
private fun MemoBadge(memo: MemoRow) {
    val text = when (memo.kind) {
        MemoKind.NOTE -> "记"
        MemoKind.COUNTDOWN -> "日"
        else -> "本"
    }
    Box(
        Modifier
            .size(30.dp)
            .clip(RoundedCornerShape(TookDims.controlRadiusSmall))
            .background(TookColors.accentWeak),
        contentAlignment = Alignment.Center,
    ) {
        Text(text, fontSize = 12.sp, fontWeight = FontWeight.SemiBold, color = TookColors.accentText)
    }
}

@Composable
private fun MemoCard(memo: MemoRow, onOpen: () -> Unit) {
    TookCard(paddingY = 10.dp) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            MemoBadge(memo)
            Spacer(Modifier.width(10.dp))
            Column(
                Modifier
                    .weight(1f)
                    .clip(RoundedCornerShape(TookDims.controlRadiusSmall))
                    .tap(onClick = onOpen)
                    .padding(vertical = 4.dp),
            ) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        text = memoTitleOf(memo),
                        fontSize = 14.sp,
                        fontWeight = FontWeight.SemiBold,
                        color = TookColors.text,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f, fill = false),
                    )
                    if (memo.kind == MemoKind.NOTEBOOK) {
                        Spacer(Modifier.width(6.dp))
                        TookPill(
                            text = memo.category?.takeIf { it.isNotBlank() } ?: MemoKind.CATEGORY_NONE,
                            bg = TookColors.fill,
                            fg = TookColors.text2,
                        )
                    }
                }
                Text(
                    text = memoSubtitle(memo),
                    modifier = Modifier.padding(top = 4.dp),
                    fontSize = 11.sp,
                    color = TookColors.text2,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            // 行尾不再放「⋯」：置顶 / 编辑 / 删除只剩左滑一个入口
        }
    }
}

/** 列表副标题：记事 = 日期段；倒数日 = 目标日 + 剩余天数；笔记本 = 分类 + 正文首段。 */
private fun memoSubtitle(memo: MemoRow): String = when (memo.kind) {
    MemoKind.NOTE -> MemoFormats.rangeFull(memo.startDate, memo.endDate)
    MemoKind.COUNTDOWN -> {
        val target = memo.startDate.orEmpty()
        "目标日 " + target.replace("-", "/") + " · " + MemoFormats.countdown(target, java.time.LocalDate.now().toString())
    }
    else -> memo.content?.trim()?.takeIf { it.isNotEmpty() } ?: "还没有正文"
}

@Composable
private fun RuleCard(
    item: RuleWithTasks,
    onOpen: () -> Unit,
) {
    TookCard(paddingY = 10.dp) {
        Row(
            Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(TookDims.controlRadius))
                // 点行 = 进编辑。**不再有长按菜单**：长按原本弹出的「编辑 / 删除」
                // 与左滑露出的按钮完全重复（用户 2026-10-26：「三个点点更多按钮可以去掉，
                // 当前左滑的功能与更多的功能重合了」），左滑是唯一入口。
                .tap(onClick = onOpen)
                .padding(vertical = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(Modifier.weight(1f)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        text = item.rule.title,
                        fontSize = 14.sp,
                        fontWeight = FontWeight.SemiBold,
                        color = TookColors.text,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f, fill = false),
                    )
                    if (item.ended) {
                        Spacer(Modifier.width(6.dp))
                        TookPill("已结束", TookColors.fill2, TookColors.mute)
                    }
                    if (!item.rule.enabled) {
                        Spacer(Modifier.width(6.dp))
                        TookPill("已停用", TookColors.fill, TookColors.text2)
                    }
                }
                Text(
                    text = RepeatFormat.describe(item.rule),
                    modifier = Modifier.padding(top = 4.dp),
                    fontSize = 11.sp,
                    color = TookColors.text2,
                )
                // 契约 §11.3：规则列表显示提醒摘要「通知 21:00 + 闹钟 09:00」
                item.reminder?.let { reminder ->
                    Text(
                        text = ReminderFormat.summary(reminder),
                        modifier = Modifier.padding(top = 3.dp),
                        fontSize = 11.sp,
                        color = TookColors.text3,
                    )
                }
            }
            Spacer(Modifier.width(8.dp))
            // 行尾不再放「⋯」：置顶 / 编辑 / 删除只剩左滑一个入口
            Text(
                text = "${item.tasks.size} 个任务",
                fontSize = 11.sp,
                maxLines = 1,
                color = TookColors.text3,
            )
        }
        if (item.tasks.isNotEmpty()) {
            HorizontalDivider(
                modifier = Modifier.padding(top = 8.dp),
                thickness = 1.dp,
                color = TookColors.line,
            )
            Column(
                Modifier.fillMaxWidth().padding(top = 8.dp),
                verticalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                item.tasks.forEach { task ->
                    Row(
                        Modifier.fillMaxWidth(),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Box(
                            Modifier
                                .size(5.dp)
                                .clip(CircleShape)
                                .background(if (task.enabled) TookColors.accent else TookColors.dotOff),
                        )
                        Spacer(Modifier.width(8.dp))
                        Text(
                            text = task.title,
                            fontSize = 12.5.sp,
                            color = TookColors.text,
                        )
                        Spacer(Modifier.width(6.dp))
                        Text(
                            text = if (task.enabled) task.id else "${task.id} · 已停用",
                            fontSize = 11.sp,
                            color = TookColors.text3,
                        )
                    }
                }
            }
        }
    }
}

/** 重复方式的中文描述，只做展示，不参与命中判定。 */
object RepeatFormat {
    private val WEEK = listOf("一", "二", "三", "四", "五", "六", "日")

    fun describe(rule: RuleRow): String {
        val repeat = when (rule.repeatMode) {
            RepeatMode.WEEKLY -> {
                val days = WEEK.filterIndexed { bit, _ -> (rule.weekdaysMask shr bit) and 1 == 1 }
                if (days.isEmpty()) "每周（未选星期）" else "每周" + days.joinToString("、")
            }
            RepeatMode.EVERY -> "每 ${rule.repeatEvery ?: 0} 天"
            RepeatMode.MONTHLY -> when (val d = rule.monthDay ?: 0) {
                -1 -> "每月最后一天"
                else -> "每月 $d 日"
            }
            RepeatMode.YEARLY -> "每年 ${rule.yearMonth ?: 0} 月 ${rule.yearDay ?: 0} 日"
            RepeatMode.NONE -> "不重复"
            else -> "未知重复方式 ${rule.repeatMode}"
        }
        val upper = rule.repeatUntil?.takeIf { it.isNotBlank() } ?: rule.endDate?.takeIf { it.isNotBlank() }
        val start = "自 ${rule.startDate}"
        return if (upper == null) "$repeat · $start" else "$repeat · $start 至 $upper"
    }
}

@Composable
internal fun PageHeader(title: String) {
    Row(
        Modifier.fillMaxWidth().height(54.dp).padding(start = 18.dp, end = 18.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text = title,
            fontSize = 17.5.sp,
            fontWeight = FontWeight.SemiBold,
            letterSpacing = (-0.3).sp,
            color = TookColors.text,
        )
    }
}

@Composable
internal fun GroupTitle(text: String) {
    TookGroupHeader(text)
}

@Composable
internal fun Footnote(text: String) {
    Box(
        Modifier
            .fillMaxWidth()
            .padding(start = 4.dp, end = 4.dp, top = 10.dp),
    ) {
        Text(text = text, fontSize = 11.5.sp, lineHeight = 18.sp, color = TookColors.text3)
    }
}
