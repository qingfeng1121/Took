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
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import app.took.data.MemoDraft
import app.took.data.MemoKind
import app.took.data.MemoOutcome
import app.took.data.MemoRow
import app.took.data.TookRepository
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * 记事（kind 0）与笔记本（kind 2）的文档式全屏页（契约 §10.4，形态照 prototype/android.html 的 note-screen）。
 *
 * 形态与 PC 的 #bookScreen 一一对应：
 *  - 顶栏：返回 + （记事）日期区间两个输入 /（笔记本）分类 chip；
 *  - 大号标题 + 元信息（记事 = 日期段；笔记本 = 更新于 … ｜ N 字）+ 无边框正文；
 *  - 600ms 静默自动保存（停顿后才写，输入期间不打断）。
 *
 * 外壳复用 RuleEditorDialog 已验证的做法：放进 Dialog 独立窗口 + 从右侧滑入。
 * 页内叠加层挡不住下层触摸（Compose 会把指针事件发给所有命中的兄弟节点），
 * 那条教训写进过项目笔记，这里不再踩第二次。
 */
@Composable
fun DocEditorDialog(
    repo: TookRepository,
    kind: Int,
    memoId: String?,
    onClose: (changed: Boolean) -> Unit,
) {
    var changed by remember { mutableStateOf(false) }
    SlideInPanel(onDismiss = { onClose(changed) }) { requestClose ->
        DocEditorPage(
            repo = repo,
            kind = kind,
            memoId = memoId,
            onClose = { result ->
                if (result) changed = true
                requestClose()
            },
        )
    }
}

/** 笔记本分类：未分类 + 现有笔记本用过且不是「未分类」的分类名（不建分类表，§10.2）。 */
private fun categoryNames(repo: TookRepository): List<String> {
    val used = repo.listMemos(MemoKind.NOTEBOOK)
        .mapNotNull { it.category?.trim() }
        .filter { it.isNotEmpty() && it != MemoKind.CATEGORY_NONE }
        .distinct()
    return listOf(MemoKind.CATEGORY_NONE) + used
}

@Composable
private fun DocEditorPage(
    repo: TookRepository,
    kind: Int,
    memoId: String?,
    onClose: (changed: Boolean) -> Unit,
) {
    val scope = rememberCoroutineScope()
    val isBook = kind == MemoKind.NOTEBOOK

    var key by remember(memoId) { mutableStateOf(memoId.orEmpty()) }
    var title by remember(memoId) { mutableStateOf("") }
    var body by remember(memoId) { mutableStateOf("") }
    var startDate by remember(memoId) { mutableStateOf("") }
    var endDate by remember(memoId) { mutableStateOf("") }
    var category by remember(memoId) { mutableStateOf(MemoKind.CATEGORY_NONE) }
    var updatedAt by remember(memoId) { mutableStateOf(0L) }
    var categories by remember(memoId) { mutableStateOf(listOf(MemoKind.CATEGORY_NONE)) }
    var error by remember(memoId) { mutableStateOf<String?>(null) }
    var busy by remember(memoId) { mutableStateOf(false) }
    var dirty by remember(memoId) { mutableStateOf(false) }
    var everSaved by remember(memoId) { mutableStateOf(memoId != null) }
    var editTick by remember(memoId) { mutableIntStateOf(0) }
    var pickerOpen by remember { mutableStateOf(false) }
    var newCategory by remember { mutableStateOf("") }
    var closing by remember { mutableStateOf(false) }

    LaunchedEffect(memoId) {
        categories = withContext(Dispatchers.IO) { categoryNames(repo) }
        if (memoId == null) return@LaunchedEffect
        val m: MemoRow = withContext(Dispatchers.IO) { repo.memo(memoId) } ?: return@LaunchedEffect
        title = m.title
        body = m.content.orEmpty()
        startDate = m.startDate.orEmpty()
        endDate = m.endDate.orEmpty()
        category = m.category?.takeIf { it.isNotBlank() } ?: MemoKind.CATEGORY_NONE
        updatedAt = m.updatedAt
    }

    fun touch() {
        dirty = true
        editTick++
    }

    suspend fun save(): Boolean {
        if (busy) return false
        val draft = MemoDraft(
            id = key,
            kind = kind,
            title = title,
            content = body,
            startDate = if (isBook) "" else startDate,
            endDate = if (isBook) "" else endDate,
            category = if (isBook) category else "",
        )
        // 空页不落库：新建时标题与正文都空就不写（与 PC 的 saveBook 同一口径）
        if (key.isEmpty() && draft.title.isBlank() && draft.content.isBlank()) return false
        busy = true
        val outcome = withContext(Dispatchers.IO + NonCancellable) {
            if (key.isEmpty()) repo.createMemo(draft) else repo.updateMemo(draft)
        }
        busy = false
        return when (outcome) {
            is MemoOutcome.Saved -> {
                key = outcome.memoId
                dirty = false
                error = null
                everSaved = true
                val fresh = withContext(Dispatchers.IO) { repo.memo(outcome.memoId) }
                if (fresh != null) {
                    updatedAt = fresh.updatedAt
                    if (isBook) category = fresh.category?.takeIf { it.isNotBlank() } ?: MemoKind.CATEGORY_NONE
                }
                if (isBook) categories = withContext(Dispatchers.IO) { categoryNames(repo) }
                true
            }
            is MemoOutcome.Invalid -> {
                error = outcome.errors.joinToString("；")
                false
            }
            is MemoOutcome.Rejected -> {
                error = outcome.reason
                false
            }
            is MemoOutcome.Deleted -> false
        }
    }

    // 600ms 静默自动保存：每次编辑 +1 tick，停顿后才写
    LaunchedEffect(editTick) {
        if (editTick == 0) return@LaunchedEffect
        delay(600)
        if (dirty) save()
    }

    fun goBack() {
        if (closing) return
        closing = true
        scope.launch {
            if (dirty) save()
            onClose(everSaved)
        }
    }

    val meta = if (isBook) MemoFormats.bookMeta(updatedAt, body) else MemoFormats.rangeShort(startDate, endDate)

    Box(
        Modifier
            .fillMaxSize()
            .background(TookColors.surface)
            .pointerInput(Unit) { detectTapGestures { } },
    ) {
        Column(Modifier.fillMaxSize()) {
            Row(
                Modifier.fillMaxWidth().height(56.dp).padding(horizontal = 10.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                BackButton(onClick = { goBack() })
                Spacer(Modifier.weight(1f))
                if (isBook) {
                    CategoryChip(category = category, onClick = { pickerOpen = true })
                } else {
                    DateField(
                        value = startDate,
                        placeholder = "开始日期",
                        label = "开始日期",
                        modifier = Modifier.width(104.dp),
                        onChange = { startDate = it; touch() },
                    )
                    Text(
                        text = "~",
                        modifier = Modifier.padding(horizontal = 6.dp),
                        fontSize = 11.5.sp,
                        color = TookColors.text3,
                    )
                    DateField(
                        value = endDate,
                        placeholder = "结束日期",
                        label = "结束日期（可留空）",
                        modifier = Modifier.width(104.dp),
                        onChange = { endDate = it; touch() },
                    )
                }
            }
            HorizontalDivider(thickness = 1.dp, color = TookColors.line)

            Column(
                Modifier
                    .fillMaxWidth()
                    .weight(1f)
                    .verticalScroll(rememberScrollState())
                    .padding(start = 20.dp, end = 20.dp, top = 18.dp, bottom = 20.dp),
            ) {
                BasicTextField(
                    value = title,
                    onValueChange = { title = it; touch() },
                    singleLine = false,
                    maxLines = 3,
                    textStyle = TextStyle(
                        fontSize = 25.sp,
                        lineHeight = 33.sp,
                        fontWeight = FontWeight.Bold,
                        letterSpacing = (-0.5).sp,
                        color = TookColors.text,
                    ),
                    cursorBrush = SolidColor(TookColors.accent),
                    decorationBox = { inner ->
                        Box(Modifier.fillMaxWidth()) {
                            if (title.isEmpty()) {
                                Text(
                                    text = "标题",
                                    fontSize = 25.sp,
                                    lineHeight = 33.sp,
                                    fontWeight = FontWeight.Bold,
                                    letterSpacing = (-0.5).sp,
                                    color = TookColors.text3,
                                )
                            }
                            inner()
                        }
                    },
                    modifier = Modifier.fillMaxWidth().defaultMinSize(minHeight = 40.dp),
                )
                Text(
                    text = meta,
                    modifier = Modifier.padding(top = 8.dp),
                    fontSize = 11.sp,
                    color = TookColors.text3,
                )
                error?.let { msg ->
                    Text(
                        text = msg,
                        modifier = Modifier.padding(top = 8.dp),
                        fontSize = 11.sp,
                        lineHeight = 16.sp,
                        color = TookColors.accentText,
                    )
                }
                BasicTextField(
                    value = body,
                    onValueChange = { body = it; touch() },
                    singleLine = false,
                    textStyle = TextStyle(
                        fontSize = 15.sp,
                        lineHeight = 26.sp,
                        color = TookColors.text,
                    ),
                    cursorBrush = SolidColor(TookColors.accent),
                    decorationBox = { inner ->
                        Box(Modifier.fillMaxWidth()) {
                            if (body.isEmpty()) {
                                Text(
                                    text = "开始书写…",
                                    fontSize = 15.sp,
                                    lineHeight = 26.sp,
                                    color = TookColors.text3,
                                )
                            }
                            inner()
                        }
                    },
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(top = 14.dp)
                        .defaultMinSize(minHeight = 260.dp),
                )
            }
        }

        if (pickerOpen) {
            CategoryPicker(
                current = category,
                categories = categories,
                newCategory = newCategory,
                onNewCategoryChange = { newCategory = it },
                onPick = { picked ->
                    category = picked
                    pickerOpen = false
                    touch()
                },
                onCreate = {
                    val name = newCategory.trim()
                    if (name.isNotEmpty()) {
                        category = name
                        if (categories.none { it == name }) categories = categories + name
                        newCategory = ""
                        pickerOpen = false
                        touch()
                    }
                },
                onDismiss = { pickerOpen = false },
            )
        }
    }
}

@Composable
private fun BackButton(onClick: () -> Unit) {
    TookIconButton(label = "返回", onClick = onClick) {
        Text("‹", fontSize = 22.sp, color = TookColors.text)
    }
}

/** 顶栏的分类 chip（笔记本专用）：原型里就是「分类名 + 可点切换」。 */
@Composable
private fun CategoryChip(category: String, onClick: () -> Unit) {
    Box(
        Modifier
            .defaultMinSize(minWidth = TookDims.touch, minHeight = TookDims.touch)
            .tap(onClick = onClick)
            .semanticsLabel("分类：" + category + "，点击切换"),
        contentAlignment = Alignment.Center,
    ) {
        Box(
            Modifier
                .height(30.dp)
                .clip(RoundedCornerShape(TookDims.controlRadiusSmall))
                .background(TookColors.fill)
                .padding(horizontal = 10.dp),
            contentAlignment = Alignment.Center,
        ) {
            Text(category, fontSize = 11.5.sp, color = TookColors.text2)
        }
    }
}

/** 顶栏的日期输入（记事专用）：目标是「严格 YYYY-MM-DD」，校验在 MemoEditPolicy 里做。 */
@Composable
private fun DateField(
    value: String,
    placeholder: String,
    label: String,
    modifier: Modifier,
    onChange: (String) -> Unit,
) {
    val shape = RoundedCornerShape(9.dp)
    Box(
        modifier
            .height(TookDims.touch)
            .clip(shape)
            .background(TookColors.surface)
            .border(1.dp, TookColors.line, shape)
            .padding(horizontal = 8.dp),
        contentAlignment = Alignment.CenterStart,
    ) {
        if (value.isEmpty()) {
            Text(placeholder, fontSize = 11.5.sp, color = TookColors.text3)
        }
        BasicTextField(
            value = value,
            onValueChange = onChange,
            singleLine = true,
            textStyle = TextStyle(fontSize = 11.5.sp, color = TookColors.text),
            cursorBrush = SolidColor(TookColors.accent),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Text),
            modifier = Modifier.fillMaxWidth().semanticsLabel(label),
        )
    }
}

/** 分类选择层：页内叠加层（外层已是独立 Dialog，不会穿透到配置列表）。 */
@Composable
private fun CategoryPicker(
    current: String,
    categories: List<String>,
    newCategory: String,
    onNewCategoryChange: (String) -> Unit,
    onPick: (String) -> Unit,
    onCreate: () -> Unit,
    onDismiss: () -> Unit,
) {
    Box(
        Modifier
            .fillMaxSize()
            .background(Color(0x66000000))
            .pointerInput(Unit) { detectTapGestures { } },
        contentAlignment = Alignment.Center,
    ) {
        val shape = RoundedCornerShape(18.dp)
        Column(
            Modifier
                .fillMaxWidth()
                .padding(horizontal = 24.dp)
                .clip(shape)
                .background(TookColors.surface)
                .padding(16.dp),
        ) {
            Text("移动到分类", fontSize = 14.sp, fontWeight = FontWeight.SemiBold, color = TookColors.text)
            Text(
                "分类只影响笔记本列表的筛选与分组",
                modifier = Modifier.padding(top = 5.dp),
                fontSize = 11.5.sp,
                lineHeight = 17.sp,
                color = TookColors.text3,
            )
            Column(Modifier.padding(top = 10.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                categories.forEach { name ->
                    val on = name == current
                    Box(
                        Modifier
                            .fillMaxWidth()
                            .height(TookDims.touch)
                            .clip(RoundedCornerShape(TookDims.controlRadiusSmall))
                            .background(if (on) TookColors.accentWeak else TookColors.fill)
                            .tap { onPick(name) }
                            .padding(horizontal = 12.dp)
                            .semanticsLabel("选择分类 " + name + if (on) " 已选中" else ""),
                        contentAlignment = Alignment.CenterStart,
                    ) {
                        Text(name, fontSize = 12.5.sp, color = if (on) TookColors.accentText else TookColors.text)
                    }
                }
            }
            Row(
                Modifier.fillMaxWidth().padding(top = 10.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                TookInput(
                    value = newCategory,
                    onChange = onNewCategoryChange,
                    placeholder = "新建分类",
                    modifier = Modifier.weight(1f),
                )
                TookButton(
                    label = "新建",
                    onClick = onCreate,
                    modifier = Modifier.semanticsLabel("新建分类"),
                    tone = TookButtonTone.Secondary,
                )
            }
            TookButton(
                label = "完成",
                onClick = onDismiss,
                modifier = Modifier.padding(top = 12.dp).fillMaxWidth(),
                tone = TookButtonTone.Secondary,
            )
        }
    }
}

/**
 * 倒数日（kind 1）沿用普通表单（契约 §10.4 末条）：标题 + 目标日 + 备注。
 *
 * 与文档式页的区别是刻意的——倒数日没有正文与元信息，只有三个字段。
 * 表单样式复用 RuleEditorPage 的 internal 表单元件（TookInput / FieldLabel / Hint）。
 */
@Composable
fun CountdownFormDialog(
    repo: TookRepository,
    memoId: String?,
    onClose: (changed: Boolean) -> Unit,
) {
    var changed by remember { mutableStateOf(false) }
    SlideInPanel(onDismiss = { onClose(changed) }) { requestClose ->
        CountdownFormPage(
            repo = repo,
            memoId = memoId,
            onClose = { result ->
                if (result) changed = true
                requestClose()
            },
        )
    }
}

@Composable
private fun CountdownFormPage(
    repo: TookRepository,
    memoId: String?,
    onClose: (changed: Boolean) -> Unit,
) {
    val scope = rememberCoroutineScope()
    val today = remember { repo.today() }
    var title by remember(memoId) { mutableStateOf("") }
    var target by remember(memoId) { mutableStateOf("") }
    var note by remember(memoId) { mutableStateOf("") }
    var errors by remember(memoId) { mutableStateOf<List<String>>(emptyList()) }
    var busy by remember(memoId) { mutableStateOf(false) }

    LaunchedEffect(memoId) {
        if (memoId == null) return@LaunchedEffect
        val m = withContext(Dispatchers.IO) { repo.memo(memoId) } ?: return@LaunchedEffect
        title = m.title
        target = m.startDate.orEmpty()
        note = m.content.orEmpty()
    }

    fun save() {
        if (busy) return
        busy = true
        errors = emptyList()
        val draft = MemoDraft(
            id = memoId.orEmpty(),
            kind = MemoKind.COUNTDOWN,
            title = title,
            content = note,
            startDate = target,
        )
        scope.launch {
            val outcome = withContext(Dispatchers.IO) {
                if (memoId == null) repo.createMemo(draft) else repo.updateMemo(draft)
            }
            busy = false
            when (outcome) {
                is MemoOutcome.Saved -> onClose(true)
                is MemoOutcome.Invalid -> errors = outcome.errors
                is MemoOutcome.Rejected -> errors = listOf(outcome.reason)
                is MemoOutcome.Deleted -> Unit
            }
        }
    }

    Box(
        Modifier
            .fillMaxSize()
            .background(TookColors.bg)
            .pointerInput(Unit) { detectTapGestures { } },
    ) {
        Column(Modifier.fillMaxSize()) {
            Row(
                Modifier.fillMaxWidth().height(54.dp).padding(start = 10.dp, end = 14.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                BackButton(onClick = { onClose(false) })
                Spacer(Modifier.width(4.dp))
                Text(
                    text = if (memoId == null) "新建倒数日" else "编辑倒数日",
                    fontSize = 17.5.sp,
                    fontWeight = FontWeight.SemiBold,
                    letterSpacing = (-0.3).sp,
                    color = TookColors.text,
                )
            }
            Column(
                Modifier
                    .fillMaxWidth()
                    .weight(1f)
                    .verticalScroll(rememberScrollState())
                    .padding(horizontal = 14.dp),
            ) {
                FieldLabel("标题", top = 6.dp)
                TookInput(
                    value = title,
                    onChange = { title = it },
                    placeholder = "例如：生日",
                    modifier = Modifier.fillMaxWidth().semanticsLabel("倒数日标题"),
                )
                FieldLabel("目标日")
                TookInput(
                    value = target,
                    onChange = { target = it },
                    placeholder = "YYYY-MM-DD",
                    modifier = Modifier.fillMaxWidth().semanticsLabel("目标日"),
                )
                Hint("目标日可以是过去（显示「已经 N 天」）或未来（「还有 N 天」）。倒数日不进月历格子。")
                FieldLabel("备注")
                val shape = RoundedCornerShape(12.dp)
                Box(
                    Modifier
                        .fillMaxWidth()
                        .clip(shape)
                        .background(TookColors.surface)
                        .border(1.dp, TookColors.stroke, shape)
                        .padding(horizontal = 12.dp, vertical = 11.dp),
                ) {
                    if (note.isEmpty()) {
                        Text("可留空", fontSize = 13.sp, color = TookColors.text3)
                    }
                    BasicTextField(
                        value = note,
                        onValueChange = { note = it },
                        singleLine = false,
                        textStyle = TextStyle(fontSize = 13.5.sp, lineHeight = 22.sp, color = TookColors.text),
                        cursorBrush = SolidColor(TookColors.accent),
                        modifier = Modifier
                            .fillMaxWidth()
                            .defaultMinSize(minHeight = 88.dp)
                            .semanticsLabel("备注"),
                    )
                }
                if (target.isNotBlank()) {
                    Hint("当前：" + MemoFormats.countdown(target, today))
                }
                errors.forEach { msg -> Notice(msg) }
                Spacer(Modifier.height(16.dp))
            }
            Row(
                Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 12.dp),
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                TookButton(
                    label = "取消",
                    onClick = { onClose(false) },
                    modifier = Modifier.weight(1f),
                    tone = TookButtonTone.Secondary,
                )
                TookButton(
                    label = "保存",
                    onClick = { save() },
                    modifier = Modifier.weight(1f),
                    tone = TookButtonTone.Primary,
                    enabled = !busy,
                )
            }
        }
    }
}
