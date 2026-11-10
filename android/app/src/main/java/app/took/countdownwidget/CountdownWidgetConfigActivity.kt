package app.took.countdownwidget

import android.app.Activity
import android.appwidget.AppWidgetManager
import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.glance.appwidget.GlanceAppWidgetManager
import androidx.glance.appwidget.state.updateAppWidgetState
import app.took.data.MemoKind
import app.took.data.MemoRow
import app.took.data.TookDb
import app.took.data.TookRepository
import app.took.ui.MemoFormats
import app.took.ui.TookColors
import app.took.ui.TookDims
import app.took.ui.TookTheme
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.time.LocalDate

/**
 * 「这个组件显示哪一条倒数日」的选择页 —— 系统 appwidget 的 **configure activity**。
 *
 * 用户 2026-10-26：「如果有多个倒数日不能选择吗？为什么非要塞进一个组件里面。」
 * 这就是那个「选择」：一个组件实例绑一条倒数日，多条倒数日就放多个组件、各选一条。
 *
 * 三条入口都走这里：
 *  1. 首次拖到桌面（appwidget-provider 的 android:configure）—— 选完 [RESULT_OK]，桌面才落位；
 *  2. 长按组件 → 重新配置 —— 系统用同一个 Activity 重新拉起，[AppWidgetManager.EXTRA_APPWIDGET_ID]
 *     带着已有实例的 id，页面会勾出当前选中的那条；
 *  3. 组件显示「该倒数日已删除」时用户点进来重选。
 *
 * 写盘只写本实例自己的 Preferences（Glance 按 GlanceId 隔离），
 * 因此两个组件选不同的倒数日 → 两个组件显示不同内容，互不覆盖。
 */
class CountdownWidgetConfigActivity : ComponentActivity() {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)

    /** 本页在配置哪个组件实例；[AppWidgetManager.INVALID_APPWIDGET_ID] 表示拿不到（异常入口）。 */
    private var appWidgetId = AppWidgetManager.INVALID_APPWIDGET_ID

    /** 是否「重新配置」：true 时取消要能回到桌面而不清掉已有配置。 */
    private var reconfiguring = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // 配置页取消 / 完成前，桌面显示的还是占位；不设 result 时系统会把组件直接丢掉，
        // 因此这里先默认 RESULT_CANCELED，选完再改成 RESULT_OK。
        setResult(Activity.RESULT_CANCELED)

        appWidgetId = intent?.extras?.getInt(
            AppWidgetManager.EXTRA_APPWIDGET_ID,
            AppWidgetManager.INVALID_APPWIDGET_ID,
        ) ?: AppWidgetManager.INVALID_APPWIDGET_ID
        reconfiguring = intent?.getBooleanExtra(EXTRA_RECONFIGURE, false) == true ||
            intent?.action == ACTION_RECONFIGURE

        var loading by mutableStateOf(true)
        var memos by mutableStateOf<List<MemoRow>>(emptyList())
        var currentId by mutableStateOf<String?>(null)
        var today by mutableStateOf(LocalDate.now().toString())

        setContent {
            TookTheme {
                ConfigPage(
                    loading = loading,
                    memos = memos,
                    currentId = currentId,
                    today = today,
                    reconfiguring = reconfiguring,
                    onPick = { memo -> save(memo.id) },
                    onCancel = { finish() },
                )
            }
        }

        scope.launch {
            val loaded = withContext(Dispatchers.IO) {
                val repo = TookRepository(TookDb.shared(applicationContext))
                val t = LocalDate.now().toString()
                val list = repo.listMemos(MemoKind.COUNTDOWN)
                val sorted = app.took.data.MemoEditPolicy.countdownOrder(
                    list.filter { it.kind == MemoKind.COUNTDOWN && it.deleted == 0 },
                    t,
                )
                sorted to t
            }
            memos = loaded.first
            today = loaded.second
            currentId = readCurrentId()
            loading = false
        }
    }

    /** 读本实例已有的选择（重新配置时用来勾出当前那条）。 */
    private suspend fun readCurrentId(): String? {
        if (appWidgetId == AppWidgetManager.INVALID_APPWIDGET_ID) return null
        return runCatching {
            val manager = GlanceAppWidgetManager(applicationContext)
            val glanceId = manager.getGlanceIdBy(appWidgetId)
            androidx.glance.appwidget.state.getAppWidgetState(
                applicationContext,
                androidx.glance.state.PreferencesGlanceStateDefinition,
                glanceId,
            )[CountdownWidgetState.KEY_MEMO_ID]
        }.getOrNull()
    }

    /**
     * 写入本实例的 memoId → 立刻重画这一个实例 → [RESULT_OK] 收工。
     *
     * 顺序很重要：**先写 Preferences 再 update**，否则组件会先用旧值重画一次；
     * **先 update 再 finish**，否则桌面可能拿不到新内容就落位成空白。
     */
    private fun save(memoId: String) {
        if (appWidgetId == AppWidgetManager.INVALID_APPWIDGET_ID) {
            finish()
            return
        }
        scope.launch {
            val ok = runCatching {
                val manager = GlanceAppWidgetManager(applicationContext)
                val glanceId = manager.getGlanceIdBy(appWidgetId)
                withContext(Dispatchers.IO) {
                    updateAppWidgetState(applicationContext, glanceId) { prefs ->
                        prefs[CountdownWidgetState.KEY_MEMO_ID] = memoId
                    }
                }
                CountdownWidget().update(applicationContext, glanceId)
            }.isSuccess

            if (ok) {
                setResult(
                    Activity.RESULT_OK,
                    Intent().putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, appWidgetId),
                )
            }
            finish()
        }
    }

    override fun onDestroy() {
        scope.cancel()
        super.onDestroy()
    }

    companion object {
        /** 长按组件重新配置时由系统带上的 action（部分 ROM 用它区分「重新配置」）。 */
        const val ACTION_RECONFIGURE = "android.appwidget.action.APPWIDGET_RECONFIGURE"

        /** 应用内显式跳过来重选时用的 extra（非系统入口）。 */
        const val EXTRA_RECONFIGURE = "app.took.extra.COUNTDOWN_RECONFIGURE"
    }
}

/* ---------------------------------- UI ---------------------------------- */

/**
 * 选择页：一列倒数日，点一条即完成。
 *
 * 每行按「标题 + 还有/已经 N 天 + 目标日」排列，与组件上那张卡同一套信息，
 * 用户选之前就能确认选对了。
 */
@Composable
private fun ConfigPage(
    loading: Boolean,
    memos: List<MemoRow>,
    currentId: String?,
    today: String,
    reconfiguring: Boolean,
    onPick: (MemoRow) -> Unit,
    onCancel: () -> Unit,
) {
    Column(
        Modifier
            .fillMaxSize()
            .background(TookColors.bg)
            .padding(horizontal = TookDims.pageX, vertical = 16.dp),
    ) {
        Text(
            text = "选择要显示的倒数日",
            fontSize = 18.sp,
            fontWeight = FontWeight.SemiBold,
            color = TookColors.text,
        )
        Spacer(Modifier.height(4.dp))
        Text(
            text = "一个组件显示一个倒数日。要看多个，就在桌面上再放一个组件、各选一条。",
            fontSize = 12.sp,
            color = TookColors.text2,
        )
        Spacer(Modifier.height(14.dp))

        when {
            loading -> CenterHint("读取中…")
            memos.isEmpty() -> CenterHint("还没有倒数日。先在 Tool 里添加一个，再回来选。")
            else -> LazyColumn(
                modifier = Modifier.weight(1f).fillMaxWidth(),
                verticalArrangement = Arrangement.spacedBy(TookDims.gap),
            ) {
                items(memos, key = { it.id }) { memo ->
                    MemoPickRow(
                        memo = memo,
                        today = today,
                        selected = memo.id == currentId,
                        onClick = { onPick(memo) },
                    )
                }
            }
        }

        Spacer(Modifier.height(12.dp))
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
            TextButton(onClick = onCancel) {
                Text(if (reconfiguring) "取消" else "取消添加", fontSize = 14.sp)
            }
        }
    }
}

/** 一行候选：选中态用橙色描边，避免用户不知道当前绑的是哪条。 */
@Composable
private fun MemoPickRow(memo: MemoRow, today: String, selected: Boolean, onClick: () -> Unit) {
    val parts = MemoFormats.countdownParts(memo.startDate, today)
    val shape = RoundedCornerShape(TookDims.controlRadius)
    Row(
        Modifier
            .fillMaxWidth()
            .clip(shape)
            .background(if (selected) TookColors.accentWeak else TookColors.surface)
            .clickable(onClick = onClick)
            .padding(horizontal = TookDims.cardX, vertical = TookDims.cardY),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(
                text = memo.title,
                fontSize = 15.sp,
                fontWeight = FontWeight.Medium,
                color = TookColors.text,
                maxLines = 1,
            )
            Spacer(Modifier.height(3.dp))
            Text(
                text = parts.text + " · " + MemoFormats.compactDate(memo.startDate),
                fontSize = 12.sp,
                color = TookColors.text2,
                maxLines = 1,
            )
        }
        if (selected) {
            Spacer(Modifier.width(8.dp))
            Text(text = "当前", fontSize = 12.sp, color = TookColors.accentText)
        }
    }
}

/** 空态 / 加载态：居中一句话，不画空白列表（用掉剩下的整块高度，按钮不会被顶到屏幕中间）。 */
@Composable
private fun ColumnScope.CenterHint(text: String) {
    Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center) {
        Text(text = text, fontSize = 13.sp, color = TookColors.text2)
    }
}
