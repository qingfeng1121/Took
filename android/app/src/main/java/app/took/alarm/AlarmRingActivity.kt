package app.took.alarm

import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.media.MediaPlayer
import android.media.RingtoneManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.util.Log
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.took.data.TookDb
import app.took.data.TookRepository
import app.took.ui.semanticsLabel
import app.took.ui.TookTheme
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * 全屏闹钟（定稿 §6.3.5）：锁屏上也直接弹出来，响铃 + 震动，**必须手动关**。
 *
 * 为什么铃声活在 Activity 里而不是前台服务：闹钟的入口是 fullScreenIntent / 直启 Activity，
 * 界面本身就是前台，进程不会被回收；再叠一个 FOREGROUND_SERVICE_SPECIAL_USE 只是多一层
 * Android 14 的前台服务类型申报风险，换不到额外保障。响铃期间锁屏被 Activity 占住，
 * 5 分钟无操作自动停（定稿要求，避免手机变砖），通知保留。
 *
 * 「贪睡」与「停止」都只是发一条广播回 [ReminderReceiver] —— 排下一次闹钟的逻辑只有一份。
 */
class AlarmRingActivity : ComponentActivity() {

    private var player: MediaPlayer? = null
    private var vibrator: Vibrator? = null
    private var ringHandler: Handler? = null
    private var stopped = false
    private var reminderId = ""
    private var ruleId = ""
    private var ruleTitle = ""
    private var body = ""
    private var snoozeMin = 0

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        reminderId = intent.getStringExtra(ReminderNotifier.EXTRA_REMINDER_ID).orEmpty()
        ruleId = intent.getStringExtra(ReminderNotifier.EXTRA_RULE_ID).orEmpty()
        ruleTitle = intent.getStringExtra(ReminderNotifier.EXTRA_TITLE).orEmpty()
        body = intent.getStringExtra(ReminderNotifier.EXTRA_TEXT).orEmpty()
        snoozeMin = intent.getIntExtra(ReminderNotifier.EXTRA_SNOOZE_MIN, 0)
        if (reminderId.isBlank()) {
            finish()
            return
        }

        showOverLockScreen()
        startRinging()
        // 5 分钟无操作自动停铃（定稿 §6.3.5），通知留着，用户回来还能看见
        ringHandler = Handler(Looper.getMainLooper())
        ringHandler?.postDelayed({ stopRingOnly() }, AUTO_STOP_MILLIS)

        setContent {
            TookTheme {
                AlarmRingScreen(
                    time = SimpleDateFormat("HH:mm", Locale.CHINA).format(Date()),
                    title = ruleTitle,
                    body = body,
                    snoozeMin = snoozeMin,
                    onSnooze = { snooze() },
                    onStop = { stop() },
                )
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        // fullScreenIntent 与直启可能先后到达：同一实例，不重复起铃
    }

    override fun onDestroy() {
        releaseRing()
        ringHandler?.removeCallbacksAndMessages(null)
        super.onDestroy()
    }

    private fun showOverLockScreen() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true)
            setTurnScreenOn(true)
        } else {
            @Suppress("DEPRECATION")
            window.addFlags(
                WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or
                    WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON,
            )
        }
        // 锁屏上直接显示，不让系统先要求解锁
        val km = getSystemService(android.app.KeyguardManager::class.java)
        km?.requestDismissKeyguard(this, null)
    }

    private fun startRinging() {
        if (stopped) return
        try {
            val uri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM)
                ?: RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION)
            val mp = MediaPlayer()
            mp.setAudioAttributes(
                AudioAttributes.Builder()
                    // 走闹钟音量通道：手机静音、媒体音量为 0 也照样响（定稿 §6.3.5）
                    .setUsage(AudioAttributes.USAGE_ALARM)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                    .build(),
            )
            mp.setDataSource(this, uri)
            mp.isLooping = true
            mp.prepare()
            mp.start()
            player = mp
        } catch (e: Exception) {
            Log.w(TAG, "铃声播放失败（继续震动）：${e.message}")
        }
        try {
            val v = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                getSystemService(VibratorManager::class.java)?.defaultVibrator
            } else {
                @Suppress("DEPRECATION")
                getSystemService(Vibrator::class.java)
            }
            if (v != null && v.hasVibrator()) {
                v.vibrate(VibrationEffect.createWaveform(longArrayOf(0, 1000, 1000), 0))
                vibrator = v
            }
        } catch (e: Exception) {
            Log.w(TAG, "震动失败：${e.message}")
        }
    }

    private fun stopRingOnly() {
        if (stopped) return
        stopped = true
        releaseRing()
    }

    private fun releaseRing() {
        try {
            player?.stop()
        } catch (e: Exception) {
            // 已经停了
        }
        player?.release()
        player = null
        try {
            vibrator?.cancel()
        } catch (e: Exception) {
            // 忽略
        }
        vibrator = null
    }

    private fun snooze() {
        stopRingOnly()
        if (snoozeMin > 0) {
            sendAction(ReminderReceiver.ACTION_SNOOZE, snoozeMin)
        }
        finish()
    }

    private fun stop() {
        stopRingOnly()
        sendAction(ReminderReceiver.ACTION_STOP, snoozeMin)
        finish()
    }

    private fun sendAction(action: String, snooze: Int) {
        val i = Intent(this, ReminderReceiver::class.java).setAction(action).apply {
            putExtra(ReminderNotifier.EXTRA_REMINDER_ID, reminderId)
            putExtra(ReminderNotifier.EXTRA_RULE_ID, ruleId)
            putExtra(ReminderNotifier.EXTRA_SNOOZE_MIN, snooze)
        }
        sendBroadcast(i)
    }

    companion object {
        private const val TAG = "TookReminder"
        private const val AUTO_STOP_MILLIS = 5 * 60 * 1000L

        fun intent(
            context: Context,
            reminderId: String,
            ruleId: String,
            title: String,
            text: String,
            snoozeMin: Int,
        ): Intent = Intent(context, AlarmRingActivity::class.java).apply {
            putExtra(ReminderNotifier.EXTRA_REMINDER_ID, reminderId)
            putExtra(ReminderNotifier.EXTRA_RULE_ID, ruleId)
            putExtra(ReminderNotifier.EXTRA_TITLE, title)
            putExtra(ReminderNotifier.EXTRA_TEXT, text)
            putExtra(ReminderNotifier.EXTRA_SNOOZE_MIN, snoozeMin)
        }
    }
}

/** 全屏闹钟界面：大字号时间 + 规则名 + 贪睡（左，次要）/ 停止（右）。 */
@Composable
private fun AlarmRingScreen(
    time: String,
    title: String,
    body: String,
    snoozeMin: Int,
    onSnooze: () -> Unit,
    onStop: () -> Unit,
) {
    Column(
        Modifier.fillMaxSize().background(Color(0xFF14100E)).padding(28.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Text(time, fontSize = 72.sp, fontWeight = FontWeight.Bold, color = Color.White)
        Spacer(Modifier.height(18.dp))
        Text(
            text = title,
            fontSize = 22.sp,
            fontWeight = FontWeight.SemiBold,
            color = Color(0xFFFFB778),
            textAlign = TextAlign.Center,
            modifier = Modifier.semanticsLabel("闹钟 $title"),
        )
        Spacer(Modifier.height(10.dp))
        Text(
            text = body,
            fontSize = 13.sp,
            color = Color(0xFFBFA79A),
            textAlign = TextAlign.Center,
        )
        Spacer(Modifier.height(56.dp))
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(14.dp)) {
            if (snoozeMin > 0) {
                AlarmButton(
                    label = "贪睡 $snoozeMin 分钟",
                    primary = false,
                    modifier = Modifier.weight(1f),
                    onClick = onSnooze,
                )
            }
            AlarmButton(
                label = "停止",
                primary = true,
                modifier = Modifier.weight(if (snoozeMin > 0) 1f else 3f),
                onClick = onStop,
            )
        }
        Spacer(Modifier.height(20.dp))
        Text(
            text = "必须手动关闭 · 5 分钟无操作自动停铃",
            fontSize = 11.sp,
            color = Color(0xFF7A6A62),
        )
    }
}

@Composable
private fun AlarmButton(
    label: String,
    primary: Boolean,
    modifier: Modifier,
    onClick: () -> Unit,
) {
    Box(
        modifier
            .height(54.dp)
            .clip(RoundedCornerShape(16.dp))
            .background(if (primary) Color(0xFFE4572E) else Color(0xFF2A2320))
            .clickable(onClick = onClick)
            .semanticsLabel(label),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = label,
            fontSize = 15.sp,
            fontWeight = FontWeight.SemiBold,
            color = Color.White,
        )
    }
}
