package app.took.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
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
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.took.data.TookRepository
import app.took.engine.DateKeys
import app.took.stats.StatsEngine
import app.took.stats.StatsResult
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * 统计分析页（定稿 §3.7 口径 / 原型 #anScreen 形态）。
 *
 * 两个维度各自独立：**时间范围**（本周 / 本月 / 近 30 天 / 全部）× **统计类型**
 * （完成率 / 按规则分组 / 连续打卡）。切换任一个都重新 [TookRepository.stats] 现算 ——
 * 页面上没有一个写死的数字，全部来自 rule + task + completion 三张表的当前内容。
 *
 * 界面上「已完成周期」这个 KPI 与明细表「已完成」列的合计同源（[StatsResult.totalDone]
 * 就是明细行求和），所以两个数字不可能对不上（§3.7 末段）。
 */
@Composable
fun AnalysisDialog(repo: TookRepository, todayKey: String, onClose: () -> Unit) {
    SlideInPanel(onDismiss = onClose) { requestClose ->
        AnalysisPage(repo = repo, todayKey = todayKey, onClose = requestClose)
    }
}

@Composable
private fun AnalysisPage(repo: TookRepository, todayKey: String, onClose: () -> Unit) {
    var rangeId by remember { mutableIntStateOf(StatsEngine.RANGE_MONTH) }
    var typeId by remember { mutableIntStateOf(StatsEngine.TYPE_RATE) }
    var result by remember { mutableStateOf<StatsResult?>(null) }
    var pickerOpen by remember { mutableStateOf(false) }

    // rangeId 变了就重算：计算在 IO 线程（全部是纯逻辑，不碰界面）
    LaunchedEffect(rangeId, todayKey) {
        result = withContext(Dispatchers.IO) { repo.stats(rangeId, todayKey) }
    }

    Box(Modifier.fillMaxWidth().fillMaxHeight().background(TookColors.bg)) {
        Column(Modifier.fillMaxWidth().fillMaxHeight()) {
            Row(
                Modifier.fillMaxWidth().height(54.dp).padding(start = 6.dp, end = 12.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                TookIconButton(label = "返回", onClick = onClose) {
                    Text("‹", fontSize = 22.sp, color = TookColors.text)
                }
                Spacer(Modifier.width(4.dp))
                // 标题按自身宽度占位，不参与挤压：之前 weight(1f) 在字号放大后被两个下拉
                // 挤到只剩一个字宽，「统计分析」被硬裁成「统计」。
                Text(
                    text = "统计分析",
                    fontSize = 17.sp,
                    maxLines = 1,
                    fontWeight = FontWeight.SemiBold,
                    letterSpacing = (-0.3).sp,
                    color = TookColors.text,
                )
                Spacer(Modifier.weight(1f))
                // 两个下拉：范围 / 类型（原型里就是两个 mini 下拉，不是左右滑动的 tab）。
                // 不给权重：权重会把「类型 完成率」压成「类型 完…」，宁可整条右对齐。
                DropdownChip(
                    keyLabel = "范围",
                    value = StatsEngine.RANGE_LABELS[rangeId],
                    label = "时间范围",
                    onClick = { pickerOpen = true },
                )
                Spacer(Modifier.width(6.dp))
                DropdownChip(
                    keyLabel = "类型",
                    value = StatsEngine.TYPE_LABELS[typeId],
                    label = "统计类型",
                    onClick = { pickerOpen = true },
                )
            }
            HorizontalDivider(thickness = 1.dp, color = TookColors.line)

            Column(
                Modifier
                    .fillMaxWidth()
                    .weight(1f)
                    .verticalScroll(rememberScrollState())
                    .padding(start = TookDims.pageX, end = TookDims.pageX, top = 10.dp, bottom = 20.dp),
            ) {
                val data = result
                // 首帧还没算完：不画假数据，留空
                if (data == null) Spacer(Modifier.height(120.dp))
                else {
                    MetaLine(data)
                    Spacer(Modifier.height(10.dp))
                    KpiRow(data)
                    when (typeId) {
                        StatsEngine.TYPE_RULE -> RuleGroupCard(data)
                        StatsEngine.TYPE_STREAK -> StreakCard(data)
                        else -> RateCard(data)
                    }
                    Spacer(Modifier.height(12.dp))
                    TaskDetailCard(data)
                    Spacer(Modifier.height(12.dp))
                    Footnote(
                        "口径（定稿 §3.7）：按周期统计，不按天统计。完成率 = 已完成周期 ÷ 应完成周期，" +
                            "同一周期内多个命中日只计一次；未来还没到的日子不计入应完成。",
                    )
                }
            }
        }

        if (pickerOpen) {
            StatsPicker(
                rangeId = rangeId,
                typeId = typeId,
                onPickRange = { rangeId = it; pickerOpen = false },
                onPickType = { typeId = it; pickerOpen = false },
                onDismiss = { pickerOpen = false },
            )
        }
    }
}

@Composable
private fun DropdownChip(
    keyLabel: String,
    value: String,
    label: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val shape = RoundedCornerShape(TookDims.controlRadiusSmall)
    Box(
        modifier
            .height(TookDims.touch)
            .clip(shape)
            .tap(onClick = onClick)
            .semanticsLabel(label + "：" + value + "，点击切换")
            .padding(horizontal = 2.dp),
        contentAlignment = Alignment.Center,
    ) {
        Row(
            // 不 fillMaxWidth：父级是 Row，撑满会把另一颗下拉挤成 0 宽
            Modifier
                .height(32.dp)
                .clip(shape)
                .background(TookColors.surface)
                .border(1.dp, TookColors.stroke, shape)
                .padding(horizontal = 9.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(keyLabel, fontSize = 11.5.sp, color = TookColors.text2)
            Spacer(Modifier.width(4.dp))
            // 下拉宽 = 内容宽（父级不再给权重），最长也用不着省略号
            Text(
                value,
                fontSize = 11.5.sp,
                fontWeight = FontWeight.SemiBold,
                color = TookColors.accentText,
                maxLines = 1,
            )
            Spacer(Modifier.width(2.dp))
            Text("›", fontSize = 11.5.sp, color = TookColors.text2)
        }
    }
}

/**
 * 区间说明行：统计区间 + 天数 + 明细条数（原型 an-meta）。
 *
 * 用 FlowRow 而不是 Row：字号放大后一行放不下，Row 会把最后一段挤成 1 个字宽的窄条，
 * 屏幕上就成了「4 / 条 / 任 / 务」竖排。FlowRow 以整段为单位换行。
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun MetaLine(data: StatsResult) {
    FlowRow(
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        Text("区间 ", fontSize = 11.5.sp, color = TookColors.text2)
        Text(data.range.describe(), fontSize = 11.5.sp, fontWeight = FontWeight.SemiBold, color = TookColors.text)
        Text("·", fontSize = 11.5.sp, color = TookColors.text3)
        Text(data.taskCount.toString() + " 条任务", fontSize = 11.5.sp, color = TookColors.text2)
    }
}

/** KPI 四宫格：已完成周期 / 应完成周期 / 完成率 / 连续天数。全部现算，前两项互为分子分母。 */
@Composable
private fun KpiRow(data: StatsResult) {
    Column(verticalArrangement = Arrangement.spacedBy(TookDims.gap)) {
        Row(horizontalArrangement = Arrangement.spacedBy(TookDims.gap)) {
            Kpi("已完成周期", data.totalDone.toString(), "个", "与明细表合计同源", Modifier.weight(1f))
            Kpi("应完成周期", data.totalExpected.toString(), "个", data.range.days.toString() + " 天内命中", Modifier.weight(1f))
        }
        Row(horizontalArrangement = Arrangement.spacedBy(TookDims.gap)) {
            Kpi("完成率", pct(data.rate), "%", "已完成 ÷ 应完成", Modifier.weight(1f))
            Kpi("连续打卡", data.currentStreak.toString(), "天", "区间最长 " + data.bestStreak + " 天", Modifier.weight(1f))
        }
    }
}

@Composable
private fun Kpi(label: String, value: String, unit: String, sub: String, modifier: Modifier) {
    val shape = RoundedCornerShape(TookDims.cardRadius)
    Column(
        modifier
            .clip(shape)
            .background(TookColors.surface)
            .padding(horizontal = 13.dp, vertical = 12.dp),
    ) {
        Text(label, fontSize = 11.5.sp, color = TookColors.text2, maxLines = 1, overflow = TextOverflow.Ellipsis)
        Row(Modifier.padding(top = 6.dp), verticalAlignment = Alignment.Bottom) {
            Text(
                text = value,
                fontSize = 22.sp,
                fontWeight = FontWeight.Bold,
                letterSpacing = (-0.6).sp,
                color = TookColors.text,
            )
            Spacer(Modifier.width(3.dp))
            Text(unit, modifier = Modifier.padding(bottom = 4.dp), fontSize = 11.5.sp, color = TookColors.text2)
        }
        Text(
            sub,
            modifier = Modifier.padding(top = 6.dp),
            fontSize = 11.sp,
            color = TookColors.text3,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}


/* ------------------------------ 类型一：完成率 ------------------------------ */

@Composable
private fun RateCard(data: StatsResult) {
    StatsCard(
        "逐日完成情况",
        StatsEngine.bucketName(StatsEngine.bucketSize(data.days.size)) + " · 柱高 = 应完成周期，橙色为已完成",
    ) {
        if (data.totalExpected == 0) {
            TookEmpty("这个区间里没有命中的任务\n先在配置页建规则与任务", vertical = 20.dp)
        } else {
            BarPlot(data)
        }
    }
}

/**
 * 柱状图：柱总高 = 该桶应完成周期数的相对比例，橙色段 = 已完成部分（原型 an-plot 同一画法）。
 *
 * 全部用 weight + fillMaxHeight 画，不引图表库：桶内 done/expected 决定橙色占比，
 * 桶间 expected/最大 expected 决定柱高。数字仍全部来自 StatsEngine 的现算结果。
 */
@Composable
private fun BarPlot(data: StatsResult) {
    val buckets = StatsEngine.buckets(data.days)
    val maxExpected = buckets.maxOfOrNull { it.expected }?.coerceAtLeast(1) ?: 1
    Column(Modifier.fillMaxWidth()) {
        Row(
            Modifier.fillMaxWidth().height(132.dp).padding(top = 4.dp),
            horizontalArrangement = Arrangement.spacedBy(3.dp),
            verticalAlignment = Alignment.Bottom,
        ) {
            buckets.forEach { bucket ->
                val totalH = (bucket.expected.toFloat() / maxExpected).coerceIn(0f, 1f)
                val doneShare = if (bucket.expected == 0) 0f else bucket.done.toFloat() / bucket.expected
                Box(Modifier.weight(1f).fillMaxHeight(), contentAlignment = Alignment.BottomCenter) {
                    Box(
                        Modifier
                            .fillMaxWidth()
                            .fillMaxHeight(if (totalH <= 0f) 0.02f else totalH)
                            .clip(RoundedCornerShape(topStart = 4.dp, topEnd = 4.dp))
                            .background(TookColors.fill2)
                            .semanticsLabel(shortDate(bucket.date) + " " + bucket.done + "/" + bucket.expected),
                    )
                    if (doneShare > 0f) {
                        Box(
                            Modifier
                                .fillMaxWidth()
                                .fillMaxHeight((totalH * doneShare).coerceIn(0.01f, 1f))
                                .clip(RoundedCornerShape(topStart = 4.dp, topEnd = 4.dp))
                                .background(TookColors.accent),
                        )
                    }
                }
            }
        }
        Row(Modifier.fillMaxWidth().padding(top = 6.dp)) {
            Text(shortDate(buckets.firstOrNull()?.date), fontSize = 11.sp, color = TookColors.text3)
            Spacer(Modifier.weight(1f))
            Text(shortDate(buckets.lastOrNull()?.date), fontSize = 11.sp, color = TookColors.text3)
        }
    }
}

/* ------------------------------ 类型二：按规则分组 ------------------------------ */

@Composable
private fun RuleGroupCard(data: StatsResult) {
    StatsCard("各规则完成率", "Σ 其下每个任务已打卡周期 ÷ Σ 应完成周期") {
        if (data.rules.isEmpty()) {
            TookEmpty("这个区间里还没有任何规则命中", vertical = 20.dp)
        } else {
            data.rules.forEachIndexed { index, rule ->
                if (index > 0) {
                    HorizontalDivider(
                        modifier = Modifier.padding(vertical = 8.dp),
                        thickness = 1.dp,
                        color = TookColors.line,
                    )
                }
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        text = rule.ruleTitle,
                        modifier = Modifier.weight(1f),
                        fontSize = 12.5.sp,
                        fontWeight = FontWeight.SemiBold,
                        color = TookColors.text,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                    Text(
                        text = pct(rule.rate) + "%",
                        fontSize = 12.sp,
                        fontWeight = FontWeight.SemiBold,
                        color = TookColors.accentText,
                    )
                }
                Text(
                    text = rule.done.toString() + " / " + rule.expected + " 个周期 · " + rule.tasks.size + " 个任务",
                    modifier = Modifier.padding(top = 4.dp),
                    fontSize = 11.5.sp,
                    color = TookColors.text2,
                )
                ProgressBar(rule.rate, Modifier.padding(top = 6.dp))
                rule.tasks.forEach { task ->
                    Row(
                        Modifier.fillMaxWidth().padding(top = 4.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(
                            text = task.taskTitle,
                            modifier = Modifier.weight(1f).padding(start = 8.dp),
                            fontSize = 11.5.sp,
                            color = TookColors.text2,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                        Text(
                            text = task.done.toString() + " / " + task.expected,
                            fontSize = 11.sp,
                            color = TookColors.text3,
                        )
                    }
                }
            }
        }
    }
}

/* ------------------------------ 类型三：连续打卡 ------------------------------ */

@Composable
private fun StreakCard(data: StatsResult) {
    StatsCard("连续打卡", "当天所有命中任务的周期都完成才算一天；当天没有命中任务是中性日，不中断连续") {
        Row(horizontalArrangement = Arrangement.spacedBy(TookDims.gap)) {
            Kpi("当前连续", data.currentStreak.toString(), "天", "从今天往前数", Modifier.weight(1f))
            Kpi("区间最长", data.bestStreak.toString(), "天", data.range.label, Modifier.weight(1f))
        }
        Spacer(Modifier.height(10.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(TookDims.gap)) {
            Kpi("打卡天数", data.activeDays.toString(), "天", "至少完成一个周期", Modifier.weight(1f))
            Kpi("全勤天数", data.completeDays.toString(), "天", "当天命中全部完成", Modifier.weight(1f))
        }
        Text(
            text = "最近 14 天",
            modifier = Modifier.padding(top = 12.dp, bottom = 6.dp),
            fontSize = 11.5.sp,
            color = TookColors.text2,
        )
        StreakStrip(data)
    }
}

/** 连续打卡的逐日色块：完成=橙、有命中未完成=灰、中性日=浅线。 */
@Composable
private fun StreakStrip(data: StatsResult) {
    val last = data.days.takeLast(14)
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(3.dp)) {
        last.forEach { day ->
            val bg = when {
                day.complete -> TookColors.accent
                day.neutral -> TookColors.line
                else -> TookColors.fill2
            }
            Box(
                Modifier
                    .weight(1f)
                    .height(26.dp)
                    .clip(RoundedCornerShape(4.dp))
                    .background(bg)
                    .semanticsLabel(
                        shortDate(day.date) + if (day.neutral) " 中性日" else " " + day.done + "/" + day.expected,
                    ),
            )
        }
    }
    Row(Modifier.fillMaxWidth().padding(top = 6.dp)) {
        Text(shortDate(last.firstOrNull()?.date), fontSize = 11.sp, color = TookColors.text3)
        Spacer(Modifier.weight(1f))
        Text(shortDate(last.lastOrNull()?.date), fontSize = 11.sp, color = TookColors.text3)
    }
}

/* ------------------------------ 任务明细 ------------------------------ */

@Composable
private fun TaskDetailCard(data: StatsResult) {
    StatsCard(
        "任务明细",
        "应完成 ÷ 已完成，一个周期只计一次（合计 " + data.totalDone + " / " + data.totalExpected + "）",
    ) {
        if (data.tasks.isEmpty()) {
            TookEmpty("这个区间里没有命中的任务", vertical = 18.dp)
        } else {
            data.tasks.forEach { task ->
                Row(
                    Modifier.fillMaxWidth().padding(vertical = 5.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Column(Modifier.weight(1f)) {
                        Text(
                            text = task.taskTitle,
                            fontSize = 12.sp,
                            color = TookColors.text,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                        Text(
                            text = task.ruleTitle +
                                if (task.lastDone.isEmpty()) "" else " · 最近 " + shortDate(task.lastDone),
                            modifier = Modifier.padding(top = 3.dp),
                            fontSize = 11.sp,
                            color = TookColors.text3,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                    Text(
                        text = task.done.toString() + " / " + task.expected,
                        fontSize = 11.5.sp,
                        fontWeight = FontWeight.SemiBold,
                        color = if (task.done > 0) TookColors.accentText else TookColors.text3,
                    )
                    Spacer(Modifier.width(8.dp))
                    Text(
                        text = pct(task.rate) + "%",
                        modifier = Modifier.width(46.dp),
                        textAlign = TextAlign.End,
                        fontSize = 11.sp,
                        color = TookColors.text2,
                    )
                }
            }
        }
    }
}

/* --------------------------------- 选择层 --------------------------------- */

@Composable
private fun StatsPicker(
    rangeId: Int,
    typeId: Int,
    onPickRange: (Int) -> Unit,
    onPickType: (Int) -> Unit,
    onDismiss: () -> Unit,
) {
    Box(
        Modifier
            .fillMaxWidth()
            .fillMaxHeight()
            .background(TookColors.scrim)
            .tap(onClick = onDismiss),
        contentAlignment = Alignment.Center,
    ) {
        Column(
            Modifier
                .fillMaxWidth()
                .padding(horizontal = 20.dp)
                .clip(RoundedCornerShape(18.dp))
                .background(TookColors.surface)
                // 卡片自身吞掉点击，避免点选项时穿透到遮罩把它关掉
                .tap(onClick = {})
                .padding(16.dp),
        ) {
            Text("时间范围", fontSize = 12.sp, fontWeight = FontWeight.SemiBold, color = TookColors.text2)
            Column(Modifier.padding(top = 6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                StatsEngine.RANGE_LABELS.forEachIndexed { id, label ->
                    PickerRow(label, id == rangeId) { onPickRange(id) }
                }
            }
            Spacer(Modifier.height(14.dp))
            Text("统计类型", fontSize = 12.sp, fontWeight = FontWeight.SemiBold, color = TookColors.text2)
            Column(Modifier.padding(top = 6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                StatsEngine.TYPE_LABELS.forEachIndexed { id, label ->
                    PickerRow(label, id == typeId) { onPickType(id) }
                }
            }
            TookButton(
                label = "完成",
                onClick = onDismiss,
                modifier = Modifier.padding(top = 14.dp).fillMaxWidth(),
                tone = TookButtonTone.Secondary,
            )
        }
    }
}

@Composable
private fun PickerRow(label: String, on: Boolean, onClick: () -> Unit) {
    val shape = RoundedCornerShape(TookDims.controlRadiusSmall)
    Box(
        Modifier
            .fillMaxWidth()
            .height(TookDims.touch)
            .clip(shape)
            .background(if (on) TookColors.accentWeak else TookColors.fill)
            .tap(onClick = onClick)
            .padding(horizontal = 12.dp)
            .semanticsLabel(label + if (on) " 已选中" else ""),
        contentAlignment = Alignment.CenterStart,
    ) {
        Text(
            text = label,
            fontSize = 12.5.sp,
            fontWeight = if (on) FontWeight.SemiBold else FontWeight.Normal,
            color = if (on) TookColors.accentText else TookColors.text,
        )
    }
}

/* --------------------------------- 小组件 --------------------------------- */

@Composable
private fun StatsCard(title: String, sub: String, content: @Composable () -> Unit) {
    val shape = RoundedCornerShape(TookDims.cardRadius)
    Column(
        Modifier
            .fillMaxWidth()
            .padding(top = 12.dp)
            .clip(shape)
            .background(TookColors.surface)
            .padding(horizontal = 14.dp, vertical = 13.dp),
    ) {
        Text(title, fontSize = 13.sp, fontWeight = FontWeight.SemiBold, color = TookColors.text)
        Text(
            text = sub,
            modifier = Modifier.padding(top = 4.dp, bottom = 10.dp),
            fontSize = 11.5.sp,
            lineHeight = 17.sp,
            color = TookColors.text2,
        )
        content()
    }
}

@Composable
private fun ProgressBar(rate: Double, modifier: Modifier = Modifier) {
    Box(
        modifier
            .fillMaxWidth()
            .height(6.dp)
            .clip(RoundedCornerShape(999.dp))
            .background(TookColors.fill2),
    ) {
        Box(
            Modifier
                .fillMaxWidth(rate.coerceIn(0.0, 1.0).toFloat())
                .fillMaxHeight()
                .background(TookColors.accent, RoundedCornerShape(999.dp)),
        )
    }
}

/** 百分比：保留一位小数（与原型 anPct 一致），但页面内每处都用同一个函数。 */
private fun pct(v: Double): String = String.format(java.util.Locale.US, "%.1f", v * 100)

/** 2026-10-25 → 10/25；解析不了原样回显（读层不抛异常）。 */
private fun shortDate(key: String?): String {
    val t = key?.trim().orEmpty()
    if (t.isEmpty()) return ""
    return runCatching { DateKeys.parse(t) }.fold(
        onSuccess = { it.monthValue.toString() + "/" + it.dayOfMonth },
        onFailure = { t },
    )
}

