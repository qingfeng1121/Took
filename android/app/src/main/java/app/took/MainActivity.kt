package app.took

import android.Manifest
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import app.took.alarm.ReminderChannels
import app.took.alarm.ReminderPermissions
import app.took.alarm.ReminderScheduler
import app.took.data.ConfigPins
import app.took.data.SqliteSyncStore
import app.took.data.TookDb
import app.took.data.TookRepository
import app.took.sync.SyncController
import app.took.sync.SyncScheduler
import app.took.sync.SyncSettings
import app.took.ui.TookApp
import app.took.ui.TookTheme
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {

    /** 同步用后台域：与界面生命周期同生共死（见 SyncScheduler 注释里的取舍）。 */
    private val syncScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var scheduler: SyncScheduler? = null

    private lateinit var repo: TookRepository

    /** 每次回到前台 +1：设置页据此重读权限与「下一次提醒」，不做假缓存。 */
    private var resumeTick by mutableIntStateOf(0)

    /** 桌面「月历」组件点某天传来的日期；应用据此一进来就打开当天面板（null = 正常首页）。 */
    private var pendingOpenDate by mutableStateOf<String?>(null)

    /** 桌面「倒数日」组件点某张卡传来的 memo id；应用据此一进来就打开该条编辑页。 */
    private var pendingOpenMemo by mutableStateOf<String?>(null)

    /** 上一次看到的精确闹钟权限。撤销/恢复后旧闹钟会失效，必须重排（定稿 §6.3.4）。 */
    private var lastExact: Boolean? = null

    /**
     * Android 13+ 的 POST_NOTIFICATIONS 运行时申请。
     *
     * 拒了也**不假装**：提醒照排（AlarmManager 不需要这个权限），但设置页会显示「通知：未授权」，
     * 并且给一个真的能跳到系统通知页的按钮。
     */
    private val notificationPermission =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) {
            scheduleAll()
            resumeTick++
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // 首次启动建表并写入与 Go 后端一致的种子（TookDb.onCreate）
        val db = TookDb.shared(this)
        // 从桌面「月历」点某天进来：把日期交给首页，打开时直接定位那一天
        pendingOpenDate = intent?.getStringExtra(app.took.homewidget.EXTRA_OPEN_DATE)
        // 从桌面「倒数日」点某张卡进来：打开该条的编辑页（与月历的「打开某天」是两条独立通道）
        pendingOpenMemo = intent?.getStringExtra(app.took.countdownwidget.EXTRA_OPEN_MEMO)
        // 置顶偏好只在本机（SharedPreferences），不进库也不同步——见 ConfigPins 的注释
        repo = TookRepository(db, ConfigPins(this))
        val settings = SyncSettings(applicationContext)
        val controller = SyncController(settings, SqliteSyncStore(db, settings))

        // 通知渠道必须在发第一条通知之前建好，否则 Android 8+ 会直接丢掉通知
        ReminderChannels.ensure(this)
        if (ReminderPermissions.needsNotificationRuntimePermission(this)) {
            notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
        // 启动即重排：AlarmManager 里的条目重启后全丢，而「打开应用」是用户最常碰的恢复点
        scheduleAll()

        // 启动即尝试一次，之后每 5 分钟一次；失败静默（细节进设置页）
        scheduler = SyncScheduler(syncScope) { controller.runNow() }.also { it.start() }

        setContent {
            TookTheme {
                TookApp(
                    repo = repo,
                    syncController = controller,
                    resumeTick = resumeTick,
                    openDateFromWidget = pendingOpenDate,
                    openMemoFromWidget = pendingOpenMemo,
                )
            }
        }
    }

    override fun onNewIntent(intent: android.content.Intent) {
        super.onNewIntent(intent)
        // 应用已在后台时点组件：走 onNewIntent 而不是 onCreate，同一个 extra 还要再读一次
        setIntent(intent)
        intent.getStringExtra(app.took.homewidget.EXTRA_OPEN_DATE)?.let { pendingOpenDate = it }
        intent.getStringExtra(app.took.countdownwidget.EXTRA_OPEN_MEMO)?.let { pendingOpenMemo = it }
    }

    override fun onResume() {
        super.onResume()
        val exact = ReminderScheduler(this, repo).canScheduleExact()
        // 用户刚从系统设置里改了精确闹钟开关：旧的注册全部失效，必须立刻重排
        if (lastExact != null && lastExact != exact) scheduleAll()
        lastExact = exact
        resumeTick++
    }

    private fun scheduleAll() {
        val app = applicationContext
        syncScope.launch {
            runCatching { ReminderScheduler(app, repo).rescheduleAll() }
        }
    }

    override fun onDestroy() {
        scheduler?.stop()
        syncScope.cancel()
        super.onDestroy()
    }
}
