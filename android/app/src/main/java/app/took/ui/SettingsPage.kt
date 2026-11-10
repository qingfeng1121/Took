package app.took.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.took.alarm.Jump
import app.took.alarm.ReminderPermissions
import app.took.alarm.ReminderScheduler
import app.took.alarm.SystemAlarmRecord
import app.took.alarm.SystemClockAlarm
import app.took.data.TookRepository
import app.took.sync.SyncController
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/** 设置页里「下一次提醒」的一行：规则名 + 真实注册进 AlarmManager 的时刻。 */
private data class NextReminder(val title: String, val fireAt: Long, val snoozeCount: Int)

/**
 * 设置页：同步配置（地址 / 立即同步 / 上次同步时间 / 待推送条数 / 最近错误）+ 提醒权限 + 提醒调度 + 关于。
 *
 * 提醒这两段是本轮「从存得住到真的会响」的落地口径：
 *  - **权限只报真实状态**（读 NotificationManager / AlarmManager / PowerManager），
 *    未授权就写「未授权」并给一个**真能跳**的系统页按钮；跳不了就把路径写出来，不画假按钮；
 *  - **下一次提醒只显示 reminder_schedule 里真实排上的那一刻**，排不上就说排不上。
 *
 * 地址默认 http://127.0.0.1:8420；模拟器访问宿主机要填 http://10.0.2.2:8420。
 * 明文 HTTP 由 res/xml/network_security_config.xml 放行（Android 9+ 默认禁止）。
 */
@Composable
fun SettingsPage(repo: TookRepository, controller: SyncController, resumeTick: Int = 0) {
    var baseUrl by remember { mutableStateOf(controller.baseUrl()) }
    var lastSyncAt by remember { mutableLongStateOf(controller.lastSyncAt()) }
    var lastError by remember { mutableStateOf(controller.lastError()) }
    var dirty by remember { mutableStateOf(0) }
    var syncing by remember { mutableStateOf(false) }
    var note by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()

    val context = LocalContext.current
    var perms by remember { mutableStateOf(ReminderPermissions.read(context)) }
    var nextReminders by remember { mutableStateOf<List<NextReminder>>(emptyList()) }
    var systemAlarms by remember { mutableStateOf<List<SystemAlarmRecord>>(emptyList()) }
    var clockAvailable by remember { mutableStateOf(true) }
    var scheduleNote by remember { mutableStateOf<String?>(null) }
    var permissionNote by remember { mutableStateOf<String?>(null) }
    var rescheduling by remember { mutableStateOf(false) }

    suspend fun refresh() {
        dirty = withContext(Dispatchers.IO) { controller.dirtyCount() }
        lastSyncAt = controller.lastSyncAt()
        lastError = controller.lastError()
    }

    suspend fun loadSystemAlarms(): List<SystemAlarmRecord> = withContext(Dispatchers.IO) {
        repo.systemAlarms()
    }

    suspend fun loadNextReminders(): List<NextReminder> = withContext(Dispatchers.IO) {
        repo.schedules().map { row ->
            NextReminder(
                title = repo.rule(row.ruleId)?.title ?: row.ruleId,
                fireAt = row.fireAt,
                snoozeCount = row.snoozeCount,
            )
        }
    }

    LaunchedEffect(Unit) { refresh() }
    // resumeTick 每次回到前台 +1：从系统设置页回来立刻看到真实的授权状态，不是缓存的旧值
    LaunchedEffect(resumeTick) {
        perms = ReminderPermissions.read(context)
        nextReminders = loadNextReminders()
        systemAlarms = loadSystemAlarms()
        clockAvailable = SystemClockAlarm.clockAppAvailable(context)
    }

    fun runSync() {
        if (syncing) return
        syncing = true
        note = null
        scope.launch {
            controller.setBaseUrl(baseUrl)
            val outcome = withContext(Dispatchers.IO) { controller.runNow() }
            refresh()
            syncing = false
            note = if (outcome.ok) {
                "同步完成 · 推送 ${outcome.pushed} 条 · 拉取 ${outcome.pulled} 条 · 游标 rev=${outcome.rev}"
            } else {
                "同步失败 · ${outcome.error ?: "未知错误"}（本地数据未受影响，dirty 保留待重试）"
            }
        }
    }

    fun rescheduleNow() {
        if (rescheduling) return
        rescheduling = true
        scope.launch {
            val report = withContext(Dispatchers.IO) {
                ReminderScheduler(context.applicationContext, repo).rescheduleAll()
            }
            perms = ReminderPermissions.read(context)
            nextReminders = loadNextReminders()
            systemAlarms = loadSystemAlarms()
            scheduleNote = report.summary()
            rescheduling = false
        }
    }

    Column(Modifier.fillMaxSize()) {
        PageHeader("设置")
        Column(
            Modifier
                .fillMaxWidth()
                .weight(1f)
                .verticalScroll(rememberScrollState())
                .padding(start = 12.dp, end = 12.dp, bottom = 20.dp),
        ) {
            GroupTitle("同步")
            SettingsCard {
                Text("服务地址", fontSize = 13.sp, color = TookColors.text)
                OutlinedTextField(
                    value = baseUrl,
                    onValueChange = {
                        baseUrl = it
                        controller.setBaseUrl(it)
                    },
                    modifier = Modifier.fillMaxWidth().padding(top = 8.dp).semanticsLabel("同步服务地址"),
                    singleLine = true,
                    placeholder = { Text("http://127.0.0.1:8420", fontSize = 12.5.sp) },
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
                    textStyle = androidx.compose.ui.text.TextStyle(fontSize = 13.sp),
                    colors = OutlinedTextFieldDefaults.colors(
                        focusedBorderColor = TookColors.accentLine,
                        unfocusedBorderColor = TookColors.stroke,
                        focusedContainerColor = TookColors.fill,
                        unfocusedContainerColor = TookColors.fill,
                    ),
                    shape = RoundedCornerShape(11.dp),
                )
                Spacer(Modifier.height(10.dp))
                TookButton(
                    label = if (syncing) "同步中…" else "立即同步",
                    onClick = { runSync() },
                    modifier = Modifier.fillMaxWidth(),
                    tone = TookButtonTone.Secondary,
                    enabled = !syncing,
                )
                Text(
                    text = "启动时一次 + 每 5 分钟一次，失败静默",
                    modifier = Modifier.padding(top = 6.dp, start = 2.dp),
                    fontSize = 11.5.sp,
                    lineHeight = 17.sp,
                    color = TookColors.text3,
                )

                Spacer(Modifier.height(12.dp))
                InfoRow("上次同步", formatTime(lastSyncAt))
                InfoRow("待推送", "$dirty 条")
                InfoRow("最近错误", lastError ?: "无")
                note?.let {
                    Text(
                        text = it,
                        modifier = Modifier.fillMaxWidth().padding(top = 8.dp).semanticsLabel("同步结果"),
                        fontSize = 11.sp,
                        lineHeight = 17.sp,
                        color = if (it.startsWith("同步完成")) TookColors.accentText else TookColors.today,
                    )
                }
            }
            Footnote("地址留空回落到 http://127.0.0.1:8420。模拟器访问宿主机请填 http://10.0.2.2:8420；" +
                "真机填后端所在电脑的局域网 IP。明文 HTTP 由 network_security_config 放行（Android 9+ 默认禁止）。")

            GroupTitle("提醒权限")
            SettingsCard {
                PermissionLine(
                    label = "通知",
                    granted = perms.notifications,
                    sub = "到点提醒要在状态栏出现。Android 13+ 需运行时授权，拒绝后系统会静默丢弃通知。",
                    jump = ReminderPermissions.notificationsJump(context),
                    onNote = { permissionNote = it },
                )
                PermissionLine(
                    label = "精确闹钟",
                    granted = perms.exactAlarms,
                    sub = "闹钟要准到分钟。Android 14 起该权限默认关闭，关闭时只能降级为不精确闹钟（最多晚几十分钟）。",
                    jump = ReminderPermissions.exactAlarmsJump(context),
                    onNote = { permissionNote = it },
                )
                PermissionLine(
                    label = "全屏通知",
                    granted = perms.fullScreenIntent,
                    sub = "闹钟要全屏弹出而不是只在状态栏。Android 14+ 需单独授权，缺失时退化为高优先级通知。",
                    jump = ReminderPermissions.fullScreenJump(context),
                    onNote = { permissionNote = it },
                )
                PermissionLine(
                    label = "电池优化白名单",
                    granted = perms.ignoringBatteryOptimizations,
                    sub = "被系统判定为受限应用时，Doze 可能让闹钟延后。加入白名单（无限制）最稳。",
                    jump = ReminderPermissions.batteryJump(context),
                    onNote = { permissionNote = it },
                )
                if (!perms.canRing) {
                    Text(
                        text = "当前状态：提醒不会真的响 —— 通知与精确闹钟都要授权。" +
                            "调度仍然会注册，但请按上面两项逐条打开。",
                        modifier = Modifier.fillMaxWidth().padding(top = 8.dp).semanticsLabel("提醒不可用提示"),
                        fontSize = 11.sp,
                        lineHeight = 17.sp,
                        color = TookColors.today,
                    )
                }
                permissionNote?.let {
                    Text(
                        text = it,
                        modifier = Modifier.fillMaxWidth().padding(top = 6.dp).semanticsLabel("权限跳转结果"),
                        fontSize = 11.sp,
                        lineHeight = 17.sp,
                        color = TookColors.text2,
                    )
                }
            }
            Footnote("这四行读的都是系统里的真实开关，不是本地记忆值。未授权一律显示「未授权」并给出" +
                "能真跳的系统页；系统页不存在时写明手动路径，不画点了没反应的按钮。")

            GroupTitle("下一次提醒")
            SettingsCard {
                if (nextReminders.isEmpty()) {
                    Text(
                        text = "没有排上的提醒（没配提醒，或规则已结束）",
                        modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp).semanticsLabel("没有排上的提醒"),
                        fontSize = 12.sp,
                        color = TookColors.text2,
                    )
                } else {
                    nextReminders.forEach { item ->
                        InfoRow(
                            item.title,
                            formatFireAt(item.fireAt) +
                                if (item.snoozeCount > 0) " · 已贪睡 ${item.snoozeCount} 次" else "",
                        )
                    }
                }
                Spacer(Modifier.height(10.dp))
                TookButton(
                    label = if (rescheduling) "重排中…" else "立即重排",
                    onClick = { rescheduleNow() },
                    modifier = Modifier.fillMaxWidth(),
                    tone = TookButtonTone.Secondary,
                    enabled = !rescheduling,
                )
                Text(
                    text = scheduleNote ?: "启动 / 重启 / 改时间后自动重排",
                    modifier = Modifier.padding(top = 6.dp, start = 2.dp).semanticsLabel("重排结果"),
                    fontSize = 11.5.sp,
                    lineHeight = 18.sp,
                    color = TookColors.text3,
                )
            }
            Footnote("上面每一行都是 AlarmManager 里真实注册的那一次（表 reminder_schedule）。" +
                "响过一次之后自动排下一次；贪睡会把这一行的时间往后推并累计次数。" +
                "snooze_min = 0 表示不贪睡，闹钟上就不会出现「稍后提醒」。")

            GroupTitle("系统闹钟")
            SettingsCard {
                if (!clockAvailable) {
                    Text(
                        text = "本机没有可用的时钟 App：闹钟降级为应用内全屏响铃。",
                        modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp)
                            .semanticsLabel("系统时钟不可用"),
                        fontSize = 11.5.sp,
                        lineHeight = 17.sp,
                        color = TookColors.today,
                    )
                } else if (systemAlarms.isEmpty()) {
                    Text(
                        text = "还没有交给系统时钟的闹钟（闹钟开关打开后会自动创建）",
                        modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp)
                            .semanticsLabel("没有系统闹钟"),
                        fontSize = 12.sp,
                        color = TookColors.text2,
                    )
                } else {
                    systemAlarms.forEach { record ->
                        InfoRow(record.label, systemAlarmText(record))
                    }
                    Text(
                        text = "以上闹钟在系统「时钟」App 里，界面、铃声、贪睡、关闭全部由系统提供，" +
                            "与手机自带闹钟一致。Android 不允许应用查询或删除系统闹钟 —— 要删请到时钟 App 里手动删除。",
                        modifier = Modifier.fillMaxWidth().padding(top = 8.dp).semanticsLabel("系统闹钟说明"),
                        fontSize = 11.5.sp,
                        lineHeight = 18.sp,
                        color = TookColors.text3,
                    )
                }
            }
            Footnote("规则是「每周」时会被翻译成系统闹钟的重复（周一起算；repeat_rule=0 只保留周期第一个命中星期）。" +
                "每 N 天 / 每月某日 / 每年这类系统闹钟表达不了，只能为下一次时刻建一次性闹钟，" +
                "因此每响过一次就可能留下一条旧闹钟，需要你到时钟 App 里手动删除 —— 应用不会假装帮你清理了。")

            if (ReminderPermissions.isMiui()) {
                GroupTitle("小米 / HyperOS 额外设置")
                SettingsCard {
                    GuideLine(
                        label = "自启动",
                        sub = "不开启时，应用被清后台后闹钟不会触发。这一项系统没有开放读取接口，" +
                            "应用只能引导，是否已开请到系统页确认。",
                        jump = ReminderPermissions.autostartJump(context),
                        onNote = { permissionNote = it },
                    )
                    GuideLine(
                        label = "锁屏显示 / 后台弹出界面",
                        sub = "小米默认拦后台弹窗：不开这一项，全屏闹钟根本出不来（只会剩一条通知）。",
                        jump = ReminderPermissions.miuiFullScreenJump(context),
                        onNote = { permissionNote = it },
                    )
                }
                Footnote("MIUI / HyperOS 的后台限制无法用代码绕过，只能引导。路径：设置 › 应用管理 › Tool " +
                    "› 权限 › 自启动；以及 其他权限 › 锁屏显示、后台弹出界面。再确认省电策略为「无限制」。")
            }

            GroupTitle("关于")
            SettingsCard {
                InfoRow("应用", "Tool · 周期打卡日历")
                InfoRow("版本", "0.2.0（首期 + 打卡 / 同步 / 界面补齐 + 真实提醒调度）")
                InfoRow("数据", "本地 SQLite（五张表 + reminder_schedule + 同步四件套）")
                InfoRow("同步协议", "契约 §7 局域网推拉 · LWW by updated_at")
                InfoRow("打卡语义", "一个周期只打卡一次，同周期所有命中日共享")
            }
            Footnote("当前同步实现：HttpURLConnection（未引入 OkHttp）；定时用协程循环而非 WorkManager，" +
                "因为 WorkManager 周期任务下限 15 分钟，满足不了 5 分钟这一条。")
        }
    }
}

@Composable
private fun SettingsCard(content: @Composable () -> Unit) {
    TookCard { Column(verticalArrangement = Arrangement.spacedBy(2.dp)) { content() } }
}

@Composable
private fun InfoRow(label: String, value: String) {
    Row(
        Modifier.fillMaxWidth().heightIn(min = 30.dp).padding(vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            label,
            modifier = Modifier.weight(0.45f),
            fontSize = 12.5.sp,
            color = TookColors.text,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        Spacer(Modifier.weight(1f))
        Text(
            text = value,
            modifier = Modifier.semanticsLabel("$label：$value"),
            fontSize = 11.5.sp,
            color = TookColors.text2,
            maxLines = 2,
            textAlign = androidx.compose.ui.text.style.TextAlign.End,
        )
    }
}

/**
 * 一行权限：状态（已授权 / 未授权）+ 说明 + 一个**真的会跳**的按钮。
 *
 * 跳不动（[Jump.intent] == null 或 startActivity 抛异常）时把路径原样写出来 ——
 * 「有按钮但按了没反应」是这一页最不能出现的东西。
 */
@Composable
private fun PermissionLine(
    label: String,
    granted: Boolean,
    sub: String,
    jump: Jump?,
    onNote: (String) -> Unit,
) {
    val context = LocalContext.current
    Column(Modifier.fillMaxWidth().padding(vertical = 6.dp)) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text(label, fontSize = 12.5.sp, color = TookColors.text)
            Spacer(Modifier.weight(1f))
            Text(
                text = if (granted) "已授权" else "未授权",
                modifier = Modifier.semanticsLabel("$label 权限" + if (granted) "已授权" else "未授权"),
                fontSize = 11.5.sp,
                fontWeight = FontWeight.SemiBold,
                color = if (granted) TookColors.accentText else TookColors.today,
            )
        }
        Text(sub, fontSize = 11.5.sp, lineHeight = 18.sp, color = TookColors.text3)
        if (!granted) {
            JumpAction(label = label, jump = jump, onNote = onNote, context = context)
        }
    }
}

/** ROM 限制类引导：没有「已授权」可读，就只给入口和路径，不臆造状态。 */
@Composable
private fun GuideLine(
    label: String,
    sub: String,
    jump: Jump?,
    onNote: (String) -> Unit,
) {
    val context = LocalContext.current
    Column(Modifier.fillMaxWidth().padding(vertical = 6.dp)) {
        Text(label, fontSize = 12.5.sp, color = TookColors.text)
        Text(sub, fontSize = 11.5.sp, lineHeight = 18.sp, color = TookColors.text3)
        JumpAction(label = label, jump = jump, onNote = onNote, context = context)
    }
}

@Composable
private fun JumpAction(
    label: String,
    jump: Jump?,
    onNote: (String) -> Unit,
    context: android.content.Context,
) {
    val path = jump?.path.orEmpty()
    val intent = jump?.intent
    if (intent == null) {
        Text(
            text = "手动前往：$path",
            modifier = Modifier.padding(top = 6.dp).semanticsLabel("$label 手动路径"),
            fontSize = 11.5.sp,
            lineHeight = 18.sp,
            color = TookColors.text2,
        )
        return
    }
    TookButton(
        label = "去开启",
        onClick = {
            val ok = runCatching { context.startActivity(intent) }.isSuccess
            if (!ok) onNote("系统设置页打不开，请手动前往：$path")
        },
        modifier = Modifier.padding(top = 8.dp).semanticsLabel("$label 去开启"),
        tone = TookButtonTone.Secondary,
    )
}

private fun formatTime(millis: Long): String {
    if (millis <= 0L) return "从未同步"
    return SimpleDateFormat("MM-dd HH:mm", Locale.CHINA).format(Date(millis))
}

private fun formatFireAt(millis: Long): String =
    SimpleDateFormat("MM-dd HH:mm", Locale.CHINA).format(Date(millis))

/** 系统闹钟一行的描述：一次性 / 每周哪几天 + HH:mm。 */
private fun systemAlarmText(record: SystemAlarmRecord): String {
    val time = String.format(Locale.CHINA, "%02d:%02d", record.hour, record.minute)
    if (record.days.isEmpty()) return "一次性 $time"
    return "每周 " + record.days.joinToString("、") { weekdayLabel(it) } + " $time"
}

private fun weekdayLabel(calendarDay: Int): String = when (calendarDay) {
    1 -> "日"
    2 -> "一"
    3 -> "二"
    4 -> "三"
    5 -> "四"
    6 -> "五"
    7 -> "六"
    else -> "?"
}
