package app.took.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
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
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.took.data.CategoryOutcome
import app.took.data.CategoryStat
import app.took.data.MemoKind
import app.took.data.TookRepository
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/* ---------------------- 笔记本分类管理（改名 / 删除，§10.2） ---------------------- */

/**
 * 分类管理页：列出现有分类与条数，支持**改名**（批量原地更新该分类下所有笔记本的 category）
 * 与**删除**（把它们改为「未分类」，笔记本一条都不删）。
 *
 * 两个操作都走**独立 Dialog 二次确认**（不是页内叠加层 —— 页内叠加层挡不住下层卡片，
 * 会「点确认结果下面那条也被点开」，这条教训在项目笔记里记过）。
 * 文案里的 N 来自 [TookRepository.categories] 的现算结果，与实际执行条数同源。
 */
@Composable
fun CategoryDialog(repo: TookRepository, onClose: (changed: Boolean) -> Unit) {
    var changed by remember { mutableStateOf(false) }
    SlideInPanel(onDismiss = { onClose(changed) }) { requestClose ->
        CategoryPage(
            repo = repo,
            onClose = {
                if (changed) changed = true
                requestClose()
            },
            onChanged = { changed = true },
        )
    }
}

@Composable
private fun CategoryPage(
    repo: TookRepository,
    onClose: () -> Unit,
    onChanged: () -> Unit,
) {
    val scope = rememberCoroutineScope()
    var stats by remember { mutableStateOf<List<CategoryStat>>(emptyList()) }
    var loading by remember { mutableStateOf(true) }
    var notice by remember { mutableStateOf<String?>(null) }
    var renameTarget by remember { mutableStateOf<CategoryStat?>(null) }
    var deleteTarget by remember { mutableStateOf<CategoryStat?>(null) }
    var tick by remember { mutableIntStateOf(0) }

    LaunchedEffect(tick) {
        stats = withContext(Dispatchers.IO) { repo.categories() }
        loading = false
    }

    Column(Modifier.fillMaxWidth().fillMaxHeight().background(TookColors.bg)) {
        Row(
            Modifier.fillMaxWidth().height(54.dp).padding(start = 6.dp, end = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            TookIconButton(label = "返回", onClick = onClose) {
                Text("‹", fontSize = 22.sp, color = TookColors.text)
            }
            Spacer(Modifier.width(4.dp))
            Text(
                text = "笔记本分类",
                fontSize = 17.sp,
                fontWeight = FontWeight.SemiBold,
                letterSpacing = (-0.3).sp,
                color = TookColors.text,
            )
        }
        HorizontalDivider(thickness = 1.dp, color = TookColors.line)

        Column(
            Modifier
                .fillMaxWidth()
                .weight(1f)
                .verticalScroll(rememberScrollState())
                .padding(start = TookDims.pageX, end = TookDims.pageX, top = 6.dp, bottom = 20.dp),
        ) {
            notice?.let {
                Text(
                    text = it,
                    modifier = Modifier.padding(start = 4.dp, top = 4.dp, bottom = 4.dp).semanticsLabel("分类操作结果"),
                    fontSize = 11.5.sp,
                    color = TookColors.accentText,
                )
            }
            TookGroupHeader("分类 · " + stats.size + " 个") {
                TookChip("＋ 新建笔记") { notice = "新建笔记请到配置页的笔记本分组" }
            }
            if (loading) {
                Box(Modifier.fillMaxWidth().height(80.dp))
            } else if (stats.isEmpty()) {
                TookCard(paddingY = 0.dp) { TookEmpty("还没有任何笔记本\n在配置页新建笔记本时可填分类") }
            } else {
                stats.forEach { stat ->
                    CategoryRow(
                        stat = stat,
                        onRename = { renameTarget = stat },
                        onDelete = { deleteTarget = stat },
                    )
                    Spacer(Modifier.height(TookDims.gap))
                }
            }
            Spacer(Modifier.height(6.dp))
            Footnote(
                "分类不是独立实体，它就是笔记本上的一个字段（memo.category）。" +
                    "「未分类」是兜底分类，不能改名也不能删除；改名与删除都只动分类字段，" +
                    "笔记本本身一条都不会被删。",
            )
        }
    }

    renameTarget?.let { target ->
        RenameCategoryDialog(
            target = target,
            onDismiss = { renameTarget = null },
            onConfirm = { newName ->
                renameTarget = null
                scope.launch {
                    val outcome = withContext(Dispatchers.IO) { repo.renameCategory(target.name, newName) }
                    notice = when (outcome) {
                        is CategoryOutcome.Renamed ->
                            "已把「" + outcome.from + "」改名为「" + outcome.to + "」，共更新 " + outcome.affected + " 条笔记"
                        is CategoryOutcome.Rejected -> outcome.reason
                        else -> null
                    }
                    if (outcome is CategoryOutcome.Renamed) onChanged()
                    tick++
                }
            },
        )
    }

    deleteTarget?.let { target ->
        TookDialog(onDismiss = { deleteTarget = null }) { requestClose ->
            TookConfirmCard(
                title = "删除分类「" + target.name + "」",
                lines = listOf(
                    "该分类下有 " + target.count + " 条笔记，删除后它们将变为未分类",
                    "笔记本身一条都不会被删除，标题与正文全部保留",
                ),
                confirm = "删除分类",
                dismiss = "取消",
                onConfirm = {
                    requestClose()
                    deleteTarget = null
                    scope.launch {
                        val outcome = withContext(Dispatchers.IO) { repo.deleteCategory(target.name) }
                        notice = when (outcome) {
                            is CategoryOutcome.Deleted ->
                                "已删除分类「" + outcome.name + "」，" + outcome.affected + " 条笔记改为未分类"
                            is CategoryOutcome.Rejected -> outcome.reason
                            else -> null
                        }
                        if (outcome is CategoryOutcome.Deleted) onChanged()
                        tick++
                    }
                },
                onDismiss = {
                    requestClose()
                    deleteTarget = null
                },
            )
        }
    }
}

@Composable
private fun CategoryRow(stat: CategoryStat, onRename: () -> Unit, onDelete: () -> Unit) {
    val locked = stat.name == MemoKind.CATEGORY_NONE
    TookCard(paddingY = 10.dp) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(
                Modifier
                    .size(30.dp)
                    .clip(RoundedCornerShape(TookDims.controlRadiusSmall))
                    .background(if (locked) TookColors.fill else TookColors.accentWeak),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    text = if (locked) "·" else "类",
                    fontSize = 12.sp,
                    fontWeight = FontWeight.SemiBold,
                    color = if (locked) TookColors.mute else TookColors.accentText,
                )
            }
            Spacer(Modifier.width(10.dp))
            Column(Modifier.weight(1f)) {
                Text(
                    text = stat.name,
                    fontSize = 14.sp,
                    fontWeight = FontWeight.SemiBold,
                    color = TookColors.text,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Text(
                    text = if (locked) {
                        stat.count.toString() + " 条笔记 · 兜底分类，不可改名或删除"
                    } else {
                        stat.count.toString() + " 条笔记"
                    },
                    modifier = Modifier.padding(top = 3.dp),
                    fontSize = 11.sp,
                    color = TookColors.text2,
                )
            }
            Spacer(Modifier.width(6.dp))
            TookChip("改名", enabled = !locked) { onRename() }
            Spacer(Modifier.width(6.dp))
            TookChip("删除", enabled = !locked) { onDelete() }
        }
    }
}

/** 改名确认：先填新名，再二次确认（文案写明影响条数）。 */
@Composable
private fun RenameCategoryDialog(
    target: CategoryStat,
    onDismiss: () -> Unit,
    onConfirm: (String) -> Unit,
) {
    var name by remember(target.name) { mutableStateOf(target.name) }
    TookDialog(onDismiss = onDismiss) { requestClose ->
        val shape = RoundedCornerShape(TookDims.cardRadius)
        Column(
            Modifier
                .padding(horizontal = 22.dp)
                .shadow(elevation = TookDims.cardShadow * 2, shape = shape, clip = false)
                .background(TookColors.surface, shape)
                .padding(horizontal = 16.dp, vertical = 16.dp),
        ) {
            Text(
                text = "分类改名",
                fontSize = 14.sp,
                fontWeight = FontWeight.SemiBold,
                color = TookColors.text,
            )
            Text(
                text = "该分类下有 " + target.count + " 条笔记，改名后它们会一起跟着变",
                modifier = Modifier.padding(top = 8.dp),
                fontSize = 11.5.sp,
                lineHeight = 18.sp,
                color = TookColors.text2,
            )
            TookInput(
                value = name,
                onChange = { name = it },
                placeholder = "新分类名",
                modifier = Modifier.fillMaxWidth().padding(top = 12.dp).semanticsLabel("新分类名"),
            )
            Row(
                Modifier.fillMaxWidth().padding(top = 14.dp),
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                TookButton(
                    label = "取消",
                    onClick = {
                        requestClose()
                        onDismiss()
                    },
                    modifier = Modifier.weight(1f),
                    tone = TookButtonTone.Secondary,
                )
                TookButton(
                    label = "确认改名",
                    onClick = {
                        val fresh = name.trim()
                        requestClose()
                        onConfirm(fresh)
                    },
                    modifier = Modifier.weight(1f),
                    tone = TookButtonTone.Primary,
                )
            }
        }
    }
}
