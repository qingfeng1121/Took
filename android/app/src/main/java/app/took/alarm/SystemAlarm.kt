package app.took.alarm

import android.content.Context
import android.content.Intent
import android.provider.AlarmClock
import android.util.Log
import app.took.data.ReminderRow
import app.took.engine.RepeatMode
import app.took.engine.Rule
import java.time.Instant
import java.time.ZoneId

/**
 * 一条「交给系统时钟 App」的闹钟（定稿 §6.3.2 的原生形态）。
 *
 * [days] 为空 = 一次性闹钟，非空 = 每周重复（值域是 Calendar 的 SUNDAY=1 … SATURDAY=7）。
 * [fingerprint] 是用来去重的指纹：同一规则同一时刻同一重复集合 = 同一个闹钟，绝不重复创建。
 */
data class SystemAlarmSpec(
    val label: String,
    val hour: Int,
    val minute: Int,
    val days: List<Int>,
    val fingerprint: String,
    val oneShotDate: String? = null,
)

/** 计划：该建、还是已经有了；若已有一条**变了**的旧闹钟，它是删不掉、只能请用户手动删的。 */
data class SystemAlarmPlan(
    val spec: SystemAlarmSpec,
    val create: Boolean,
    val stale: String? = null,
)

/**
 * 「把闹钟交给系统时钟」的纯逻辑（可单测，不碰 Android）。
 *
 * 为什么这么做：用户原话是「当前的闹钟不是调用原生的而是自己软件自己的，太丑了，改成调用原生的，
 * 与当前闹钟保持跟系统统一」。自己画的全屏页无论怎么美化都是另一套交互，而
 * [AlarmClock.ACTION_SET_ALARM] 交给系统时钟后，**界面、铃声、贪睡、音量通道、勿扰行为
 * 全部由系统提供**，与手机自带闹钟完全一致。
 *
 * 能力边界（如实标注，不假装能表达一切）：
 *  - 每周规则 → 可以翻译成系统闹钟的「重复」：repeat_rule=1 取全部命中星期，
 *    repeat_rule=0 只取周期第一个命中星期（周一起算），语义完全对得上；
 *  - 每 N 天 / 每月某日 / 每年某月某日 / 不重复 → **系统闹钟表达不了**，只能为下一次时刻建
 *    一次性闹钟；响过之后由应用下次启动时另建一条新的（旧的那条会留在时钟里，见 [stale]）；
 *  - offset_days != 0 会把触发日整体平移，星期对不上，同样降级成一次性。
 */
object SystemAlarmPlanner {

    /** 系统时钟里能一眼认出是 Tool 建的闹钟。 */
    const val LABEL_PREFIX = "[Tool] "

    /** bit0=周一 … bit6=周日（契约 §3.1）→ Calendar 的 SUNDAY=1 … SATURDAY=7。 */
    private fun calendarDayOf(bit: Int): Int = if (bit == 6) 1 else bit + 2

    fun labelOf(ruleTitle: String): String = LABEL_PREFIX + ruleTitle.trim()

    /**
     * 由规则 + 提醒 + 下一触发点算出该交给系统时钟的闹钟；返回 null = 这条提醒不该建成系统闹钟。
     * [ruleTitle] 只是显示名，标题为空时退化成规则名/宿主 id。
     */
    fun spec(
        rule: Rule,
        reminder: ReminderRow,
        ruleTitle: String,
        nextFireAt: Long,
        zone: ZoneId = ZoneId.systemDefault(),
    ): SystemAlarmSpec? {
        if (!reminder.alarmOn || !reminder.enabled) return null
        val time = ReminderFireTime.timeOfDay(reminder.timeOfDay) ?: return null
        val label = labelOf(ruleTitle.ifBlank { reminder.ownerId })
        val weekly = rule.repeatMode == RepeatMode.WEEKLY && reminder.offsetDays == 0
        if (weekly) {
            val days = weekdaysFor(rule, reminder.repeatRule)
            if (days.isNotEmpty()) {
                return SystemAlarmSpec(
                    label = label,
                    hour = time.hour,
                    minute = time.minute,
                    days = days,
                    fingerprint = fingerprintOf(label, time.hour, time.minute, days),
                )
            }
        }
        // 一次性：用已经算好的那个触发时刻，不重算（避免两次计算漂移一分钟）
        val fireLocal = Instant.ofEpochMilli(nextFireAt).atZone(zone).toLocalDateTime()
        val date = fireLocal.toLocalDate().toString()
        return SystemAlarmSpec(
            label = label,
            hour = fireLocal.hour,
            minute = fireLocal.minute,
            days = emptyList(),
            // 一次性闹钟把目标日期也编进指纹：响过一次之后下一次算出新指纹，才会另建一条，
            // 否则「每 N 天」这类规则交给系统时钟后就只响一次、再也不响
            fingerprint = fingerprintOf(label, fireLocal.hour, fireLocal.minute, emptyList()) + "|" + date,
            oneShotDate = date,
        )
    }

    /** 规则里真正要响的星期；repeat_rule=0 只保留周期第一个命中星期。 */
    fun weekdaysFor(rule: Rule, repeatRule: Int): List<Int> {
        val bits = (0..6).filter { (rule.weekdaysMask shr it) and 1 == 1 }
        if (bits.isEmpty()) return emptyList()
        val keep = if (repeatRule == 0) listOf(bits.first()) else bits
        return keep.map(::calendarDayOf).sorted()
    }

    fun fingerprintOf(label: String, hour: Int, minute: Int, days: List<Int>): String =
        label + "|" + hour + ":" + minute + "|" + days.sorted().joinToString(",")

    /**
     * 与库里已有那条比对：create=false 表示系统时钟里已经就是这条，**不要再建**（否则会堆成几十条）。
     */
    fun plan(spec: SystemAlarmSpec, existing: SystemAlarmRecord?): SystemAlarmPlan = when {
        existing == null -> SystemAlarmPlan(spec, create = true)
        existing.fingerprint == spec.fingerprint -> SystemAlarmPlan(spec, create = false)
        else -> SystemAlarmPlan(spec, create = true, stale = existing.label)
    }
}

/** 本地记一条「我们交给系统时钟的闹钟」—— Android 没有查询/删除系统闹钟的 API，只能自己记账。 */
data class SystemAlarmRecord(
    val ruleId: String,
    val reminderId: String,
    val label: String,
    val hour: Int,
    val minute: Int,
    val days: List<Int>,
    val fingerprint: String,
    val createdAt: Long,
)

/**
 * 真正递给系统时钟 App（MIUI 上就是「时钟」）。
 *
 * EXTRA_SKIP_UI = true 表示静默创建、不弹时钟界面；系统时钟若拒绝（个别 ROM 要求带界面），
 * 返回 false，调用方回落到我们自己的 AlarmRingActivity。
 */
object SystemClockAlarm {

    private const val TAG = "TookReminder"

    fun clockAppAvailable(context: Context): Boolean {
        val r = try { resolve(context, sampleIntent()) } catch (e: Exception) {
            Log.w(TAG, "clockAppAvailable resolve 异常：" + e.message); null
        }
        Log.i(TAG, "clockAppAvailable = " + (r != null) + "  resolved=" + r?.activityInfo?.name)
        return r != null
    }

    /** 返回 true = 已交给系统时钟；false = 这台机器上没有可用的时钟 App。 */
    fun hand(context: Context, spec: SystemAlarmSpec): Boolean {
        val intent = Intent(AlarmClock.ACTION_SET_ALARM)
            .putExtra(AlarmClock.EXTRA_HOUR, spec.hour)
            .putExtra(AlarmClock.EXTRA_MINUTES, spec.minute)
            .putExtra(AlarmClock.EXTRA_MESSAGE, spec.label)
            .putExtra(AlarmClock.EXTRA_SKIP_UI, true)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        if (spec.days.isNotEmpty()) {
            intent.putExtra(AlarmClock.EXTRA_DAYS, ArrayList(spec.days))
        }
        if (resolve(context, intent) == null) return false
        return try {
            context.startActivity(intent)
            Log.i(TAG, "已交给系统时钟：label=" + spec.label + " " + spec.hour + ":" + spec.minute + " days=" + spec.days)
            true
        } catch (e: Exception) {
            Log.w(TAG, "交给系统时钟失败：" + e.message)
            false
        }
    }

    private fun sampleIntent(): Intent = Intent(AlarmClock.ACTION_SET_ALARM)
        .putExtra(AlarmClock.EXTRA_SKIP_UI, true)

    private fun resolve(context: Context, intent: Intent) =
        context.packageManager.resolveActivity(intent, 0)
}
