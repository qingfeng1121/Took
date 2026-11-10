package app.took.ui

import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
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
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.compose.ui.unit.sp
import app.took.alarm.ReminderScheduler
import app.took.data.EditOutcome
import app.took.data.ReminderButton
import app.took.data.ReminderDraft
import app.took.data.ReminderEditPolicy
import app.took.data.ReminderOutcome
import app.took.data.ReminderOwner
import app.took.data.ReminderPicker
import app.took.data.RuleDraft
import app.took.data.SplitResult
import app.took.data.TookRepository
import app.took.engine.MONTH_DAY_LAST
import app.took.engine.RepeatMode
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * 规则编辑页（新建 / 修改），视觉照 prototype/android.html 的表单：分段控件选重复方式、
 * 「＋ 添加任务」的任务列表、底部保存。
 *
 * 契约 §9.2 的交互：命中裂开条件时**先确认再写库**。确认框文案固定
 * 「修改重复设置会结束当前规则并新建一条，历史打卡保留」，
 * 真正的判定与落库都在 RuleEditPolicy / RuleEditService 里，本文件不重复实现一份。
 */
private data class TaskEdit(
    val id: String?,
    val originalTitle: String,
    val originalEnabled: Boolean,
    val title: String,
    val enabled: Boolean,
    val removed: Boolean = false,
)

/**
 * 编辑页外壳：放进 Dialog（独立窗口）而不是页内叠加层。
 *
 * 原因是实测出来的：页内叠加时，下层配置列表与上层的星期圆**会同时收到同一次点击**
 * （Compose 会把指针事件发给所有命中的兄弟节点，遮盖并不会自动吞掉）。
 * 后果很隐蔽：点一下星期几，底下的规则卡片也被点开，编辑页状态被换成另一条规则的值。
 * 独立窗口天然隔离触摸与无障碍树，同时保留「从右侧滑入」的视觉。
 */
@Composable
fun RuleEditorDialog(
    repo: TookRepository,
    ruleId: String?,
    onClose: (changed: Boolean) -> Unit,
) {
    var changed by remember { mutableStateOf(false) }
    SlideInPanel(onDismiss = { onClose(changed) }) { requestClose ->
        RuleEditorPage(
            repo = repo,
            ruleId = ruleId,
            // 保存成功/删除都先播完出场动画，再由 onDismiss 把 changed 报给外层
            onClose = { result ->
                if (result) changed = true
                requestClose()
            },
        )
    }
}

@Composable
private fun RuleEditorPage(
    repo: TookRepository,
    ruleId: String?,
    onClose: (changed: Boolean) -> Unit,
) {
    val today = remember { repo.today() }
    val scope = rememberCoroutineScope()
    val context = LocalContext.current

    var title by remember(ruleId) { mutableStateOf("") }
    var enabled by remember(ruleId) { mutableStateOf(true) }
    var mode by remember(ruleId) { mutableIntStateOf(RepeatMode.WEEKLY) }
    var mask by remember(ruleId) { mutableIntStateOf(0) }
    var every by remember(ruleId) { mutableStateOf("2") }
    var monthDay by remember(ruleId) { mutableStateOf("1") }
    var monthLast by remember(ruleId) { mutableStateOf(false) }
    var yearMonth by remember(ruleId) { mutableStateOf("1") }
    var yearDay by remember(ruleId) { mutableStateOf("1") }
    var startDate by remember(ruleId) { mutableStateOf(today) }
    var endDate by remember(ruleId) { mutableStateOf("") }
    var repeatUntil by remember(ruleId) { mutableStateOf("") }
    var ended by remember(ruleId) { mutableStateOf(false) }
    var tasks by remember(ruleId) { mutableStateOf<List<TaskEdit>>(emptyList()) }
    var errors by remember(ruleId) { mutableStateOf<List<String>>(emptyList()) }
    var busy by remember(ruleId) { mutableStateOf(false) }
    var pendingSplit by remember(ruleId) { mutableStateOf<EditOutcome.NeedsConfirm?>(null) }
    var splitResult by remember(ruleId) { mutableStateOf<SplitResult?>(null) }

    // 契约 §9.2：裂开后「复制任务到新规则」默认勾选（复制生成新 id，旧规则任务与打卡一条不动）
    var copyTasksOnSplit by remember(ruleId) { mutableStateOf(true) }

    // 契约 §11：提醒。picker 是「不提醒 / 通知 / 闹钟」三按钮背后的真实状态，两个开关独立；
    // 「不提醒」= isNone，所以任何点击序列都不会出现三项全灭（§11.1）。
    var picker by remember(ruleId) { mutableStateOf(ReminderPicker(notifyOn = false, alarmOn = false)) }
    var reminderId by remember(ruleId) { mutableStateOf("") }
    // 系统时钟里删不掉的旧闹钟（契约 §11.5）。非空时在对话框顶部如实告知，不假装清理过。
    var staleNotice by remember(ruleId) { mutableStateOf("") }
    var reminderTime by remember(ruleId) { mutableStateOf("") }
    var reminderText by remember(ruleId) { mutableStateOf("") }
    var reminderEachDay by remember(ruleId) { mutableStateOf(true) }
    var reminderSnooze by remember(ruleId) { mutableStateOf(false) }
    var reminderOffset by remember(ruleId) { mutableStateOf("0") }

    LaunchedEffect(ruleId) {
        if (ruleId == null) return@LaunchedEffect
        val data = withContext(Dispatchers.IO) { repo.ruleWithTasks(ruleId) } ?: return@LaunchedEffect
        title = data.rule.title
        enabled = data.rule.enabled
        mode = data.rule.repeatMode
        mask = data.rule.weekdaysMask
        every = (data.rule.repeatEvery ?: 2).toString()
        monthDay = (data.rule.monthDay?.takeIf { it > 0 } ?: 1).toString()
        monthLast = data.rule.monthDay == MONTH_DAY_LAST
        yearMonth = (data.rule.yearMonth ?: 1).toString()
        yearDay = (data.rule.yearDay ?: 1).toString()
        startDate = data.rule.startDate
        endDate = data.rule.endDate.orEmpty()
        repeatUntil = data.rule.repeatUntil.orEmpty()
        ended = data.ended
        tasks = data.tasks.map { TaskEdit(it.id, it.title, it.enabled, it.title, it.enabled) }
        val reminder = withContext(Dispatchers.IO) { repo.reminderOf(ruleId) }
        if (reminder != null) {
            reminderId = reminder.id
            picker = ReminderPicker(reminder.notifyOn, reminder.alarmOn)
            reminderTime = reminder.timeOfDay
            reminderText = reminder.notifyText.orEmpty()
            reminderEachDay = reminder.repeatRule == 1
            reminderSnooze = reminder.snoozeMin > 0
            reminderOffset = reminder.offsetDays.toString()
        }
    }

    fun buildDraft(): RuleDraft = RuleDraft(
        id = ruleId.orEmpty(),
        title = title,
        enabled = enabled,
        repeatMode = mode,
        // 与当前重复方式无关的字段必须发 null：库里那些列本来就是 NULL，
        // 发 UI 默认值会被判成「改过重复设置」而白白裂开一条
        weekdaysMask = if (mode == RepeatMode.WEEKLY) mask else 0,
        repeatEvery = if (mode == RepeatMode.EVERY) every.trim().toIntOrNull() else null,
        monthDay = when {
            mode != RepeatMode.MONTHLY -> null
            monthLast -> MONTH_DAY_LAST
            else -> monthDay.trim().toIntOrNull()
        },
        yearMonth = if (mode == RepeatMode.YEARLY) yearMonth.trim().toIntOrNull() else null,
        yearDay = if (mode == RepeatMode.YEARLY) yearDay.trim().toIntOrNull() else null,
        startDate = startDate.trim(),
        endDate = endDate.trim().ifBlank { null },
        repeatUntil = repeatUntil.trim().ifBlank { null },
    )

    /** 规则的写操作完成后才动任务：裂开时新加的任务挂在**新**规则下，旧任务原地改（§9.4 原地改）。 */
    suspend fun applyTaskEdits(targetRuleId: String) {
        val snapshot = tasks
        val failure = withContext(Dispatchers.IO) {
            snapshot.firstNotNullOfOrNull { t ->
                when {
                    t.id == null && !t.removed -> repo.addTask(targetRuleId, t.title)
                    t.id != null && t.removed -> repo.deleteTask(t.id)
                    else -> {
                        val id = t.id ?: return@firstNotNullOfOrNull null
                        if (t.title.trim() != t.originalTitle) repo.renameTask(id, t.title)
                        else if (t.enabled != t.originalEnabled) repo.setTaskEnabled(id, t.enabled)
                        else null
                    }
                }
            }
        }
        if (failure != null) errors = listOf(failure)
    }

    /**
     * 提醒的落库（§11.1 / §11.4）：
     *  - 三按钮停在「不提醒」→ 软删该行（R3），列表摘要随之消失；
     *  - 否则把两个开关与其余字段整份写回（R1 / R2），写入层再拦一次「两个都关」（R4）。
     * 任务不写提醒：规则下的任务继承所属规则的提醒，不单独配（§11 开头）。
     */
    suspend fun persistReminder(targetRuleId: String) {
        val outcome = withContext(Dispatchers.IO) {
            if (picker.isNone) {
                repo.clearReminder(targetRuleId)
            } else {
                repo.saveReminder(
                    ReminderDraft(
                        id = reminderId,
                        ownerKind = ReminderOwner.RULE,
                        ownerId = targetRuleId,
                        notifyOn = picker.notifyOn,
                        alarmOn = picker.alarmOn,
                        timeOfDay = reminderTime,
                        notifyText = reminderText,
                        offsetDays = reminderOffset.trim().toIntOrNull() ?: 0,
                        repeatRule = if (reminderEachDay) 1 else 0,
                        snoozeMin = if (picker.alarmOn && reminderSnooze) SNOOZE_MINUTES else 0,
                        enabled = true,
                    ),
                )
            }
        }
        when (outcome) {
            is ReminderOutcome.Invalid -> errors = outcome.errors
            is ReminderOutcome.Rejected -> errors = listOf(outcome.reason)
            is ReminderOutcome.Saved -> reminderId = outcome.reminderId
            is ReminderOutcome.Cleared -> reminderId = ""
        }
        // 改完提醒立刻重排：AlarmManager 里躺着的是旧时刻算出来的 PendingIntent，
        // 不主动重排的话「改成 2 分钟后」要等下一次启动才生效
        withContext(Dispatchers.IO) {
            val report = ReminderScheduler(context.applicationContext, repo).rescheduleAll()
            // 契约 §11.5：系统时钟的旧闹钟删不掉，必须让用户知道——报告不能只写进日志
            staleNotice = report.staleLabels.joinToString("、")
        }
    }

    fun save(confirmSplit: Boolean) {
        if (busy) return
        val draft = buildDraft()
        val creating = ruleId == null
        busy = true
        errors = emptyList()
        scope.launch {
            val outcome = withContext(Dispatchers.IO) {
                if (creating) {
                    repo.createRule(draft, tasks.filter { !it.removed }.map { it.title })
                } else {
                    repo.updateRule(draft, confirmSplit)
                }
            }
            busy = false
            when (outcome) {
                is EditOutcome.Invalid -> errors = outcome.errors
                is EditOutcome.Rejected -> errors = listOf(outcome.reason)
                // 裂开必须先拿到确认：服务层此时一个字都没写
                is EditOutcome.NeedsConfirm -> pendingSplit = outcome
                is EditOutcome.Saved -> {
                    if (!creating) applyTaskEdits(outcome.ruleId)
                    // 提醒挂在规则上：裂开时挂到**新**规则（编辑的正是新规则的设置）
                    persistReminder(outcome.ruleId)
                    if (errors.isNotEmpty()) return@launch
                    val split = outcome.split
                    if (split != null) splitResult = split else onClose(true)
                }
                is EditOutcome.Deleted -> onClose(true)
            }
        }
    }

    // 整页吞掉点击：编辑页打开时不能让触摸穿透到下面的配置列表
    Box(
        Modifier
            .fillMaxSize()
            .background(TookColors.bg)
            .pointerInput(Unit) { detectTapGestures { } },
    ) {
        Column(Modifier.fillMaxSize()) {
            Row(
                Modifier.fillMaxWidth().height(54.dp).padding(start = 8.dp, end = 14.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Box(
                    Modifier
                        .defaultMinSize(minWidth = TookDims.touch, minHeight = TookDims.touch)
                        .clip(RoundedCornerShape(TookDims.controlRadiusSmall))
                        .tap { onClose(false) }
                        .padding(horizontal = 10.dp)
                        .semanticsLabel("返回配置页"),
                    contentAlignment = Alignment.Center,
                ) {
                    Text("‹ 返回", fontSize = 13.sp, color = TookColors.accentText)
                }
                Spacer(Modifier.width(4.dp))
                Text(
                    text = if (ruleId == null) "新建规则" else "编辑规则",
                    fontSize = 17.sp,
                    fontWeight = FontWeight.SemiBold,
                    letterSpacing = (-0.3).sp,
                    color = TookColors.text,
                )
                Spacer(Modifier.weight(1f))
                if (ended) TookPill("已结束", TookColors.fill2, TookColors.mute)
            }

            Column(
                Modifier
                    .fillMaxWidth()
                    .weight(1f)
                    .verticalScroll(rememberScrollState())
                    .padding(start = 12.dp, end = 12.dp),
            ) {
                if (ended) {
                    Notice("该规则已结束（至 ${repeatUntil.ifBlank { endDate }}），重复设置不可再改。历史打卡仍可查看。")
                }

                FieldLabel("名称")
                TookInput(title, { title = it }, placeholder = "例如：工作日常规")
                if (ruleId != null) {
                    Spacer(Modifier.height(10.dp))
                    SwitchRow("启用", "关掉后这条规则不再出现在月历里", enabled, !ended) { enabled = it }
                }

                FieldLabel("重复方式")
                RepeatPills(mode, !ended) { mode = it }
                when (mode) {
                    RepeatMode.WEEKLY -> {
                        // 契约 §3.1：bit0=周一 … bit6=周日。传进来的是序号，异或要用 (1 shl 序号)
                        WeekdayChips(mask, !ended) { index -> mask = mask xor (1 shl index) }
                        Hint("一个周期只打卡一次：本周任一天打卡，本周所有命中日一起变已完成。")
                    }
                    RepeatMode.EVERY -> {
                        InlineRow(prefix = "每") {
                            TookInput(every, { every = it }, placeholder = "1~3660", numeric = true, enabled = !ended, modifier = Modifier.weight(1f))
                        }
                        Hint("从开始日期起每 N 天为一段，每段只打卡一次（最长 3660 天）。")
                    }
                    RepeatMode.MONTHLY -> {
                        InlineRow(prefix = "每月") {
                            TookInput(
                                monthDay, { monthDay = it },
                                placeholder = "1~31", numeric = true, enabled = !ended && !monthLast,
                                modifier = Modifier.weight(1f),
                            )
                        }
                        SwitchRow("每月最后一天", "开启后忽略上面的日期", monthLast, !ended) { monthLast = it }
                        Hint("大月没有 31 日时落在该月最后一天；该月只有一次。")
                    }
                    RepeatMode.YEARLY -> {
                        InlineRow(prefix = "每年") {
                            TookInput(yearMonth, { yearMonth = it }, placeholder = "月", numeric = true, enabled = !ended, modifier = Modifier.weight(1f))
                            Text("月", fontSize = 12.5.sp, color = TookColors.text2)
                            TookInput(yearDay, { yearDay = it }, placeholder = "日", numeric = true, enabled = !ended, modifier = Modifier.weight(1f))
                        }
                        Hint("2 月 29 日在平年会落在 2 月 28 日；其余月份按当月天数钳制。")
                    }
                    else -> Hint("只在开始日期那一天出现一次。")
                }

                Row(Modifier.fillMaxWidth().padding(top = 14.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    Column(Modifier.weight(1f)) {
                        FieldLabel("开始日期", top = 0.dp)
                        TookInput(startDate, { startDate = it }, placeholder = "YYYY-MM-DD", enabled = !ended)
                    }
                    Column(Modifier.weight(1f)) {
                        FieldLabel("结束日期", top = 0.dp)
                        TookInput(endDate, { endDate = it }, placeholder = "留空不限", enabled = !ended)
                    }
                }
                Hint("日期一律 YYYY-MM-DD；留空表示不限。改开始日期同样会触发裂开。")

                FieldLabel("任务")
                tasks.forEachIndexed { index, task ->
                    TaskRowView(
                        task = task,
                        onChange = { next -> tasks = tasks.toMutableList().also { it[index] = next } },
                        onRemove = {
                            tasks = tasks.toMutableList().also {
                                it[index] = task.copy(removed = true)
                            }
                        },
                    )
                    Spacer(Modifier.height(8.dp))
                }
                GhostButton("＋ 添加任务") {
                    tasks = tasks + TaskEdit(null, "", true, "", true)
                }
                Hint("重复方式对规则下所有任务共享；打卡按任务独立，勾掉一个不影响另一个。")

                FieldLabel("提醒")
                ReminderSegment(picker, !ended) { button ->
                    // 先按状态机算出新状态，再补缺省时间：顺序反过来会用到上一次的时间
                    ReminderEditPolicy.suggestTime(button, reminderTime)?.let { reminderTime = it }
                    picker = ReminderEditPolicy.click(picker, button)
                }
                Hint(
                    "两个开关独立：通知与闹钟可以同时开。「不提醒」是互斥重置（点它把两个都清零）；" +
                        "任何点击顺序都不会出现三个都不亮的状态。任务继承所属规则的提醒，不单独配。",
                )

                // 只有开着提醒时才展开字段（§11.1：两个都关 = 不提醒，字段没有意义）
                if (!picker.isNone) {
                    Row(
                        Modifier.fillMaxWidth().padding(top = 12.dp),
                        horizontalArrangement = Arrangement.spacedBy(10.dp),
                    ) {
                        Column(Modifier.weight(1f)) {
                            FieldLabel("提醒时间", top = 0.dp)
                            TookInput(reminderTime, { reminderTime = it }, placeholder = "HH:mm", enabled = !ended)
                        }
                        Column(Modifier.weight(1f)) {
                            FieldLabel("提前/延后天数", top = 0.dp)
                            TookInput(
                                reminderOffset, { reminderOffset = it },
                                placeholder = "0", numeric = true, enabled = !ended,
                            )
                        }
                    }
                    Hint("时间精确到分钟（HH:mm）；提前 N 天填负数。")
                    if (picker.notifyOn) {
                        FieldLabel("通知文案")
                        TookInput(
                            reminderText, { reminderText = it },
                            placeholder = "该打卡了：" + title.ifBlank { "规则名" },
                            enabled = !ended,
                        )
                        Hint("留空则用「该打卡了：规则名」。")
                    }
                    SwitchRow(
                        "每个重复日都提醒",
                        "关闭则只在周期第一个命中日提醒",
                        reminderEachDay,
                        !ended,
                    ) { reminderEachDay = it }
                    if (picker.alarmOn) {
                        SwitchRow("贪睡", "响铃后 $SNOOZE_MINUTES 分钟再提醒一次", reminderSnooze, !ended) {
                            reminderSnooze = it
                        }
                    }
                }

                if (staleNotice.isNotBlank()) {
                    Spacer(Modifier.height(10.dp))
                    Column(
                        Modifier
                            .fillMaxWidth()
                            .clip(RoundedCornerShape(12.dp))
                            .background(TookColors.accentWeak)
                            .border(1.dp, TookColors.accentLine, RoundedCornerShape(12.dp))
                            .padding(horizontal = 12.dp, vertical = 10.dp),
                    ) {
                        Text(
                            text = "系统时钟里有旧闹钟，应用删不掉，请在时钟 App 里手动删除：$staleNotice",
                            fontSize = 11.5.sp,
                            lineHeight = 18.sp,
                            color = TookColors.accentText,
                        )
                    }
                }

                if (errors.isNotEmpty()) {
                    Spacer(Modifier.height(10.dp))
                    Column(
                        Modifier
                            .fillMaxWidth()
                            .clip(RoundedCornerShape(12.dp))
                            .background(Color(0xFFFFF2F2))
                            .border(1.dp, Color(0xFFFFCDD2), RoundedCornerShape(12.dp))
                            .padding(horizontal = 12.dp, vertical = 10.dp),
                    ) {
                        errors.forEach { Text("· $it", fontSize = 11.5.sp, lineHeight = 18.sp, color = Color(0xFFC62828)) }
                    }
                }

                Spacer(Modifier.height(20.dp))
            }

            Box(
                Modifier
                    .fillMaxWidth()
                    .background(TookColors.surface)
                    .border(1.dp, TookColors.line)
                    .navigationBarsPadding()
                    .imePadding()
                    .padding(horizontal = 14.dp, vertical = 12.dp),
            ) {
                TookButton(
                    label = if (busy) "保存中…" else "保存",
                    onClick = { save(false) },
                    modifier = Modifier.fillMaxWidth(),
                    tone = TookButtonTone.Primary,
                    enabled = !busy,
                )
            }
        }

        pendingSplit?.let { info ->
            TookDialog(onDismiss = { pendingSplit = null }) { closeDialog ->
                TookConfirmCard(
                    title = "修改重复设置会结束当前规则并新建一条，历史打卡保留",
                    lines = listOf(
                        "旧规则「${info.oldTitle}」止于 ${info.closedUntil}",
                        "新规则从 ${info.newStartDate} 开始，承载新的重复设置",
                        "旧规则下的 ${info.taskCount} 个任务与打卡记录一条不动；下一步默认把任务复制到新规则（可取消勾选）",
                    ),
                    confirm = "确认裂开",
                    dismiss = "取消",
                    onConfirm = {
                        closeDialog()
                        pendingSplit = null
                        save(true)
                    },
                    onDismiss = {
                        closeDialog()
                        pendingSplit = null
                    },
                    danger = false,
                )
            }
        }

        splitResult?.let { split ->
            TookDialog(onDismiss = { }) { closeDialog ->
                PostSplitCard(
                    split = split,
                    copyTasks = copyTasksOnSplit,
                    onToggleCopy = { copyTasksOnSplit = it },
                    onConfirm = {
                        val done = split
                        val copy = copyTasksOnSplit
                        closeDialog()
                        splitResult = null
                        scope.launch {
                            if (copy) {
                                withContext(Dispatchers.IO) {
                                    repo.copyTasksTo(done.oldRuleId, done.newRuleId)
                                }
                            }
                            onClose(true)
                        }
                    },
                )
            }
        }
    }
}

/* --------------------------------- 表单元件 --------------------------------- */

/** 贪睡的固定间隔（分钟）。首期只存不调度（§11.3），所以不给用户调这个数。 */
private const val SNOOZE_MINUTES = 5

/**
 * 契约 §11.1 的三按钮：视觉照 prototype/android.html 的 `.seg`（一行三段，选中项白底加粗）。
 *
 * 亮起状态完全由 [ReminderPicker.pressed] 决定 —— 「不提醒」的亮 = 两个开关都关，
 * 所以这个控件画不出「三项全灭」；它与状态机共用同一份判断，不是各写一套。
 */
@Composable
private fun ReminderSegment(picker: ReminderPicker, enabled: Boolean, onClick: (Int) -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(12.dp))
            .background(TookColors.fill2)
            .padding(3.dp),
        horizontalArrangement = Arrangement.spacedBy(3.dp),
    ) {
        ReminderButton.ALL.forEach { button ->
            val on = picker.pressed(button)
            val label = ReminderButton.label(button)
            Box(
                Modifier
                    .weight(1f)
                    .height(TookDims.controlHeight)
                    .clip(RoundedCornerShape(TookDims.controlRadiusSmall))
                    .background(if (on) TookColors.surface else Color.Transparent)
                    .tap(enabled = enabled) { onClick(button) }
                    .semanticsLabel("提醒 $label" + if (on) " 已选中" else " 未选中"),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    text = label,
                    fontSize = 11.5.sp,
                    fontWeight = if (on) FontWeight.SemiBold else FontWeight.Normal,
                    color = if (on) TookColors.accentText else TookColors.text2,
                )
            }
        }
    }
}

@Composable
internal fun FieldLabel(text: String, top: androidx.compose.ui.unit.Dp = 16.dp) {
    Text(
        text = text,
        modifier = Modifier.padding(start = 4.dp, top = top, bottom = 6.dp),
        fontSize = 11.5.sp,
        fontWeight = FontWeight.SemiBold,
        letterSpacing = 0.2.sp,
        color = TookColors.text2,
    )
}

@Composable
internal fun Hint(text: String) {
    Text(
        text = text,
        modifier = Modifier.padding(start = 4.dp, end = 4.dp, top = 6.dp),
        fontSize = 11.5.sp,
        lineHeight = 18.sp,
        color = TookColors.text3,
    )
}

@Composable
internal fun Notice(text: String) {
    Box(
        Modifier
            .fillMaxWidth()
            .padding(top = 8.dp)
            .clip(RoundedCornerShape(12.dp))
            .background(TookColors.fill)
            .padding(horizontal = 12.dp, vertical = 10.dp),
    ) {
        Text(text = text, fontSize = 11.sp, lineHeight = 17.sp, color = TookColors.text2)
    }
}

@Composable
internal fun TookInput(
    value: String,
    onChange: (String) -> Unit,
    placeholder: String = "",
    numeric: Boolean = false,
    enabled: Boolean = true,
    modifier: Modifier = Modifier.fillMaxWidth(),
) {
    val shape = RoundedCornerShape(12.dp)
    Box(
        modifier
            .heightIn(min = TookDims.controlHeight)
            .clip(shape)
            .background(if (enabled) TookColors.surface else TookColors.fill)
            .border(1.dp, TookColors.stroke, shape)
            .padding(horizontal = 12.dp, vertical = 11.dp),
        contentAlignment = Alignment.CenterStart,
    ) {
        if (value.isEmpty() && placeholder.isNotEmpty()) {
            Text(placeholder, fontSize = 13.sp, color = TookColors.text3)
        }
        BasicTextField(
            value = value,
            onValueChange = onChange,
            enabled = enabled,
            singleLine = true,
            textStyle = TextStyle(fontSize = 13.5.sp, color = TookColors.text),
            cursorBrush = SolidColor(TookColors.accent),
            keyboardOptions = KeyboardOptions(
                keyboardType = if (numeric) KeyboardType.Number else KeyboardType.Text,
            ),
            modifier = Modifier.fillMaxWidth(),
        )
    }
}

@Composable
private fun InlineRow(prefix: String, content: @Composable androidx.compose.foundation.layout.RowScope.() -> Unit) {
    Row(
        Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(prefix, fontSize = 12.5.sp, color = TookColors.text2)
        content()
    }
}

@Composable
private fun RepeatPills(current: Int, enabled: Boolean, onSelect: (Int) -> Unit) {
    val options = listOf(
        RepeatMode.WEEKLY to "每周",
        RepeatMode.EVERY to "每 N 天",
        RepeatMode.MONTHLY to "每月",
        RepeatMode.YEARLY to "每年",
        RepeatMode.NONE to "不重复",
    )
    Row(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(12.dp))
            .background(TookColors.fill)
            .padding(3.dp),
        horizontalArrangement = Arrangement.spacedBy(3.dp),
    ) {
        options.forEach { (value, label) ->
            val active = value == current
            Box(
                Modifier
                    .weight(1f)
                    .height(TookDims.controlHeight)
                    .clip(RoundedCornerShape(TookDims.controlRadiusSmall))
                    .background(if (active) TookColors.surface else Color.Transparent)
                    .tap(enabled = enabled) { onSelect(value) }
                    .semanticsLabel("重复方式 $label" + if (active) " 已选中" else ""),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    text = label,
                    fontSize = 11.5.sp,
                    fontWeight = if (active) FontWeight.SemiBold else FontWeight.Normal,
                    color = if (active) TookColors.accentText else TookColors.text2,
                )
            }
        }
    }
}

/**
 * 星期多选：七个固定尺寸的圆，逐个 clickable。
 *
 * 刻意不用 weight + Arrangement.spacedBy 的等分布局 —— 实测在模拟器上那种排布的
 * 点按区域会和视觉位置错位（点周三、亮的是周二），换成固定尺寸 + SpaceBetween 后
 * 位置与行为一一对应，与任务行里「启用/停用」按钮同一套写法。
 */
@Composable
private fun WeekdayChips(mask: Int, enabled: Boolean, onToggle: (Int) -> Unit) {
    val labels = listOf("一", "二", "三", "四", "五", "六", "日")
    Row(
        Modifier.fillMaxWidth().padding(top = 10.dp),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        labels.forEachIndexed { bit, label ->
            val on = (mask shr bit) and 1 == 1
            Box(
                Modifier
                    .size(width = 44.dp, height = TookDims.touch)
                    .clip(CircleShape)
                    .background(if (on) TookColors.accent else TookColors.fill)
                    .border(1.dp, if (on) TookColors.accent else TookColors.stroke, CircleShape)
                    .tap(enabled = enabled) { onToggle(bit) }
                    .semanticsLabel("周" + label + if (on) " 已选中" else " 未选中"),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    text = label,
                    fontSize = 12.sp,
                    fontWeight = if (on) FontWeight.Bold else FontWeight.Normal,
                    color = if (on) Color.White else TookColors.text2,
                    textAlign = TextAlign.Center,
                )
            }
        }
    }
}

@Composable
private fun SwitchRow(label: String, sub: String, checked: Boolean, enabled: Boolean, onChange: (Boolean) -> Unit) {
    Row(
        Modifier.fillMaxWidth().padding(top = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(label, fontSize = 13.sp, color = TookColors.text)
            Text(sub, modifier = Modifier.padding(top = 2.dp), fontSize = 11.5.sp, lineHeight = 17.sp, color = TookColors.text3)
        }
        TookSwitch(checked, enabled) { onChange(!checked) }
    }
}

@Composable
internal fun TookSwitch(checked: Boolean, enabled: Boolean, onToggle: () -> Unit) {
    val w = 44.dp
    val h = 26.dp
    Box(
        Modifier
            .size(width = w, height = h)
            .clip(RoundedCornerShape(999.dp))
            .background(if (checked) TookColors.accent else TookColors.fill2)
            .tap(enabled = enabled, onClick = onToggle)
            .semanticsLabel(if (checked) "已开启" else "已关闭"),
    ) {
        Box(
            Modifier
                .align(if (checked) Alignment.CenterEnd else Alignment.CenterStart)
                .padding(horizontal = 3.dp)
                .size(20.dp)
                .clip(CircleShape)
                .background(Color.White),
        )
    }
}

@Composable
private fun TaskRowView(task: TaskEdit, onChange: (TaskEdit) -> Unit, onRemove: () -> Unit) {
    if (task.removed) return
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.weight(1f)) {
            TookInput(
                value = task.title,
                onChange = { onChange(task.copy(title = it)) },
                placeholder = "任务名",
            )
        }
        Spacer(Modifier.width(8.dp))
        Box(
            Modifier
                .size(width = 54.dp, height = TookDims.touch)
                .clip(RoundedCornerShape(TookDims.controlRadius))
                .background(if (task.enabled) TookColors.accentWeak else TookColors.fill)
                .border(
                    1.dp,
                    if (task.enabled) TookColors.accentLine else TookColors.stroke,
                    RoundedCornerShape(TookDims.controlRadius),
                )
                .tap { onChange(task.copy(enabled = !task.enabled)) }
                .semanticsLabel(if (task.enabled) "停用该任务" else "启用该任务"),
            contentAlignment = Alignment.Center,
        ) {
            Text(
                text = if (task.enabled) "启用" else "停用",
                fontSize = 11.sp,
                color = if (task.enabled) TookColors.accentText else TookColors.text2,
            )
        }
        Spacer(Modifier.width(6.dp))
        Box(
            Modifier
                .size(TookDims.touch)
                .clip(RoundedCornerShape(TookDims.controlRadius))
                .background(TookColors.fill)
                .tap(onClick = onRemove)
                .semanticsLabel("删除任务 ${task.title}"),
            contentAlignment = Alignment.Center,
        ) {
            Text("✕", fontSize = 13.sp, color = TookColors.mute)
        }
    }
}

@Composable
private fun GhostButton(label: String, onClick: () -> Unit) {
    Box(
        Modifier
            .fillMaxWidth()
            .height(TookDims.controlHeight)
            .clip(RoundedCornerShape(TookDims.controlRadius))
            .border(1.dp, TookColors.stroke, RoundedCornerShape(TookDims.controlRadius))
            .tap(onClick = onClick)
            .semanticsLabel(label),
        contentAlignment = Alignment.Center,
    ) {
        Text(label, fontSize = 12.5.sp, color = TookColors.text2)
    }
}

/**
 * 裂开后的第二段对话框（契约 §9.2）：勾选项**默认勾上**，主按钮「确定」按当前勾选状态执行。
 * 复制不是搬家 —— 生成新 id 的新任务，旧规则下的任务与打卡一条不动；取消勾选也合法（新规则先留空）。
 */
@Composable
private fun PostSplitCard(
    split: SplitResult,
    copyTasks: Boolean,
    onToggleCopy: (Boolean) -> Unit,
    onConfirm: () -> Unit,
) {
    val shape = RoundedCornerShape(18.dp)
    Column(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = 22.dp)
            .shadow(elevation = 12.dp, shape = shape, clip = false)
            .background(TookColors.surface, shape)
            .padding(horizontal = 16.dp, vertical = 16.dp),
    ) {
        Text(
            text = "已结束旧规则并新建一条",
            fontSize = 14.sp,
            fontWeight = FontWeight.SemiBold,
            lineHeight = 21.sp,
            color = TookColors.text,
        )
        Column(Modifier.padding(top = 10.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(
                "· 旧规则止于 ${split.oldRepeatUntil}，历史打卡仍在",
                fontSize = 11.5.sp, lineHeight = 18.sp, color = TookColors.text2,
            )
            Text(
                "· 新规则从 ${split.newStartDate} 开始",
                fontSize = 11.5.sp, lineHeight = 18.sp, color = TookColors.text2,
            )
        }
        Row(
            Modifier
                .fillMaxWidth()
                .padding(top = 12.dp)
                .clip(RoundedCornerShape(12.dp))
                .background(TookColors.fill)
                .tap { onToggleCopy(!copyTasks) }
                .semanticsLabel(
                    if (copyTasks) "复制任务到新规则 已勾选" else "复制任务到新规则 未勾选",
                )
                .padding(horizontal = 12.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            TookCheckbox(copyTasks)
            Spacer(Modifier.width(10.dp))
            Column(Modifier.weight(1f)) {
                Text(
                    text = "复制 ${split.oldTaskCount} 个任务到新规则",
                    fontSize = 12.5.sp,
                    color = TookColors.text,
                )
                Text(
                    text = if (copyTasks) {
                        "将复制 ${split.oldTaskCount} 个任务：新 id，旧记录不动"
                    } else {
                        "新规则先留空"
                    },
                    modifier = Modifier.padding(top = 3.dp),
                    fontSize = 11.5.sp,
                    lineHeight = 17.sp,
                    color = TookColors.text3,
                )
            }
        }
        Text(
            text = "取消勾选也合法：新规则先留空，之后在配置页自己添加任务。",
            modifier = Modifier.padding(top = 8.dp),
            fontSize = 11.5.sp,
            lineHeight = 18.sp,
            color = TookColors.text3,
        )
        TookButton(
            label = "确定",
            onClick = onConfirm,
            modifier = Modifier.padding(top = 16.dp).fillMaxWidth(),
            tone = TookButtonTone.Primary,
        )
    }
}

@Composable
private fun TookCheckbox(checked: Boolean) {
    val shape = RoundedCornerShape(6.dp)
    Box(
        Modifier
            .size(20.dp)
            .clip(shape)
            .background(if (checked) TookColors.accent else TookColors.surface)
            .border(1.5.dp, if (checked) TookColors.accent else TookColors.dotBorder, shape),
        contentAlignment = Alignment.Center,
    ) {
        if (checked) Text("✓", fontSize = 12.sp, fontWeight = FontWeight.Bold, color = Color.White)
    }
}
