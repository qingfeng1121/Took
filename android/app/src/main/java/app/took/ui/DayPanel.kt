package app.took.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.took.data.DayItem
import app.took.data.TookRepository
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * 当天面板：本轮起承担打卡写路径。
 *
 * 交互契约（用户约定，不许破坏）：
 *  - 面板**只能**由「点日期数字 / 格子空白」打开；格子里的任务名永远是纯预览；
 *  - 打开面板后，点任务行（或它前面的完成圆圈）切换该 (task_id, period_start) 的 status；
 *  - 同一周期的所有命中日共享状态，所以写完要回调外层刷新整月网格，不能等重新进页面。
 *
 * 形态（2026-10-25 改）：从 **ModalBottomSheet（下往上）** 换成右侧抽屉 ——
 * 抽屉从屏幕右缘水平滑入、关闭时向右滑出，位移只有 X 轴；圆角只在左侧两角。
 */
@Composable
fun DayPanelScreen(
    date: String,
    repo: TookRepository,
    onDismiss: () -> Unit,
    onChanged: () -> Unit,
) {
    SlideInPanel(onDismiss = onDismiss, widthFraction = 0.92f) { requestClose ->
        DayPanelBody(
            date = date,
            repo = repo,
            requestClose = requestClose,
            onChanged = onChanged,
        )
    }
}

@Composable
private fun DayPanelBody(
    date: String,
    repo: TookRepository,
    requestClose: () -> Unit,
    onChanged: () -> Unit,
) {
    var items by remember(date) { mutableStateOf<List<DayItem>?>(null) }
    var busyTaskId by remember(date) { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()

    LaunchedEffect(date) {
        items = withContext(Dispatchers.IO) { repo.loadDay(date) }
    }

    fun toggle(item: DayItem) {
        if (busyTaskId != null) return
        val target = !item.done
        busyTaskId = item.taskId
        scope.launch {
            withContext(Dispatchers.IO) { repo.setDone(item.taskId, item.periodStart, target) }
            items = items?.map {
                if (it.taskId == item.taskId && it.periodStart == item.periodStart) it.copy(done = target) else it
            }
            busyTaskId = null
            onChanged()
        }
    }

    val list = items
    val doneCount = list?.count { it.done } ?: 0
    val sub = when {
        list == null -> "读取中…"
        list.isEmpty() -> "这一天还没有安排"
        else -> "${list.size} 条任务 · $doneCount 已完成"
    }

    Column(
        Modifier
            .fillMaxSize()
            .clip(RoundedCornerShape(topStart = TookDims.cardRadius, bottomStart = TookDims.cardRadius))
            .background(TookColors.surface)
            .navigationBarsPadding(),
    ) {
        // 顶栏：日期 + 摘要 + 关闭（44dp 命中区）
        Row(
            Modifier
                .fillMaxWidth()
                .padding(start = 16.dp, end = 8.dp, top = 12.dp, bottom = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(Modifier.weight(1f)) {
                Text(
                    text = DayFormats.dayWithWeekday(date),
                    fontSize = 16.sp,
                    fontWeight = FontWeight.SemiBold,
                    letterSpacing = (-0.2).sp,
                    color = TookColors.text,
                )
                Text(
                    text = sub,
                    modifier = Modifier.padding(top = 3.dp),
                    fontSize = 11.5.sp,
                    color = TookColors.text2,
                )
            }
            TookIconButton(label = "关闭当天面板", onClick = requestClose, visual = 34.dp) {
                Icon(
                    imageVector = Icons.Filled.Close,
                    contentDescription = null,
                    modifier = Modifier.size(15.dp),
                    tint = TookColors.text2,
                )
            }
        }
        TookDivider()

        Column(
            Modifier
                .fillMaxWidth()
                .weight(1f)
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 14.dp, vertical = 12.dp),
            verticalArrangement = Arrangement.spacedBy(TookDims.gap),
        ) {
            when {
                list == null -> Unit
                list.isEmpty() -> TookEmpty("这一天还没有安排", vertical = 26.dp)
                else -> {
                    Text(
                        text = "点任务即可打卡 / 取消，同一周期内所有命中日一起变",
                        modifier = Modifier.padding(start = 2.dp, bottom = 2.dp),
                        fontSize = 11.5.sp,
                        lineHeight = 17.sp,
                        color = TookColors.text3,
                    )
                    list.forEach { item ->
                        DayRow(item = item, busy = busyTaskId == item.taskId) { toggle(item) }
                    }
                }
            }
        }
    }
}

@Composable
private fun DayRow(item: DayItem, busy: Boolean, onToggle: () -> Unit) {
    val shape = RoundedCornerShape(TookDims.controlRadius)
    Row(
        Modifier
            .fillMaxWidth()
            .heightIn(min = 60.dp)
            .clip(shape)
            .border(1.dp, if (item.done) TookColors.accentLine else TookColors.line, shape)
            .background(if (item.done) TookColors.accentWeak else TookColors.surface)
            .tap(enabled = !busy, onClick = onToggle)
            .semanticsLabel("${item.title} 打卡 ${if (item.done) "已完成" else "未完成"}")
            .padding(horizontal = 12.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        // 完成任务前的状态圆：点它或点整行都能切换
        Box(
            Modifier
                .size(22.dp)
                .clip(CircleShape)
                .background(if (item.done) TookColors.accent else Color.Transparent)
                .border(1.5.dp, if (item.done) TookColors.accent else TookColors.dotBorder, CircleShape),
            contentAlignment = Alignment.Center,
        ) {
            if (item.done) {
                Text("✓", fontSize = 13.sp, fontWeight = FontWeight.Bold, color = Color.White)
            }
        }
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
            Text(
                text = item.title,
                fontSize = 14.sp,
                color = if (item.done) TookColors.accentText else TookColors.text,
                fontWeight = if (item.done) FontWeight.Bold else FontWeight.Normal,
            )
            Text(
                text = "${item.ruleTitle} · 周期 ${item.periodStart}",
                modifier = Modifier.padding(top = 3.dp),
                fontSize = 11.sp,
                color = TookColors.text2,
            )
        }
        Spacer(Modifier.width(10.dp))
        Text(
            text = if (item.done) "已完成" else "未完成",
            fontSize = 11.5.sp,
            fontWeight = if (item.done) FontWeight.SemiBold else FontWeight.Normal,
            color = if (item.done) TookColors.accent else TookColors.text3,
        )
    }
}
