package app.took.data

/** 提醒的宿主（契约 §11 开头）：规则 0 / 记事 1 / 倒数日 2。 */
object ReminderOwner {
    const val RULE = 0
    const val MEMO_NOTE = 1
    const val COUNTDOWN = 2
    val ALL = listOf(RULE, MEMO_NOTE, COUNTDOWN)

    fun label(kind: Int): String = when (kind) {
        RULE -> "规则"
        MEMO_NOTE -> "记事"
        COUNTDOWN -> "倒数日"
        else -> "未知提醒宿主 $kind"
    }
}

/** UI 上那三个按钮（契约 §11.1）。 */
object ReminderButton {
    const val NONE = 0
    const val NOTIFY = 1
    const val ALARM = 2
    val ALL = listOf(NONE, NOTIFY, ALARM)

    fun label(button: Int): String = when (button) {
        NONE -> "不提醒"
        NOTIFY -> "通知"
        ALARM -> "闹钟"
        else -> "未知按钮 $button"
    }
}

/**
 * 「不提醒 / 通知 / 闹钟」三按钮背后的真实状态 —— 两个独立布尔。
 *
 * 关键不变量：`isNone` **就是**「不提醒」被按下，因此三个按钮永远恰好/至少有一个是亮的，
 * 「三项全灭」在这个类型上不可能表达出来（§11.1 明令禁止的中间态）。
 */
data class ReminderPicker(val notifyOn: Boolean, val alarmOn: Boolean) {

    val isNone: Boolean get() = !notifyOn && !alarmOn

    fun pressed(button: Int): Boolean = when (button) {
        ReminderButton.NONE -> isNone
        ReminderButton.NOTIFY -> notifyOn
        ReminderButton.ALARM -> alarmOn
        else -> false
    }

    /** 按下的按钮个数：恒 >= 1，单测按任意点击序列断言。 */
    val pressedCount: Int get() = if (isNone) 1 else (if (notifyOn) 1 else 0) + (if (alarmOn) 1 else 0)
}

/**
 * 契约 §11.1 / §11.4 的纯逻辑：写入层校验 + 三按钮状态机。
 *
 * 分层与 §3.4 / §10 一致：
 *  - 写入（validate）：非法状态必须拒绝，绝不落库（R4 就是这条）；
 *  - 交互（click）：纯函数，UI 只做「把结果画出来」，不自己拼开关。
 */
object ReminderEditPolicy {

    /** 先开通知时的缺省时间；先开闹钟时是 [DEFAULT_ALARM_TIME]（与 prototype/android.html 一致）。 */
    const val DEFAULT_NOTIFY_TIME = "21:00"
    const val DEFAULT_ALARM_TIME = "09:00"

    /** 与 reminder.schema.json 的 pattern 逐字一致：00:00 ~ 23:59。 */
    private val TIME_OF_DAY = Regex("^([01][0-9]|2[0-3]):[0-5][0-9]$")
    const val NOTIFY_TEXT_MAX = 60
    val OFFSET_DAYS = -30..30
    val SNOOZE_MIN = 0..60

    /**
     * 点一下某个按钮之后的状态（§11.1）。
     *
     * 「不提醒」是**互斥重置**（两个开关清零），「通知」「闹钟」各自独立切换；
     * 独立切换把最后一个亮着的开关关掉时，状态自然回到「不提醒」——那正是「不提醒」被按下，
     * 所以不存在「三项全灭」。prototype/android.html 的 setRemind 是同一套语义。
     */
    fun click(current: ReminderPicker, button: Int): ReminderPicker = when (button) {
        ReminderButton.NONE -> ReminderPicker(notifyOn = false, alarmOn = false)
        ReminderButton.NOTIFY -> ReminderPicker(notifyOn = !current.notifyOn, alarmOn = current.alarmOn)
        ReminderButton.ALARM -> ReminderPicker(notifyOn = current.notifyOn, alarmOn = !current.alarmOn)
        else -> current
    }

    /** 打开某个通道且时间还空着时给的缺省时间；返回 null 表示不必动时间。 */
    fun suggestTime(button: Int, currentTime: String): String? {
        if (currentTime.isNotBlank()) return null
        return when (button) {
            ReminderButton.NOTIFY -> DEFAULT_NOTIFY_TIME
            ReminderButton.ALARM -> DEFAULT_ALARM_TIME
            else -> null
        }
    }

    /** 草稿 → 库行：notify_text 空串落 null，其余按 schema 归一。 */
    fun toRow(draft: ReminderDraft, id: String, now: Long, rev: Long = 0): ReminderRow = ReminderRow(
        id = id,
        ownerKind = draft.ownerKind,
        ownerId = draft.ownerId,
        notifyOn = draft.notifyOn,
        alarmOn = draft.alarmOn,
        timeOfDay = draft.timeOfDay.trim(),
        notifyText = draft.notifyText.trim().takeIf { it.isNotEmpty() },
        offsetDays = draft.offsetDays,
        repeatRule = draft.repeatRule,
        snoozeMin = draft.snoozeMin,
        enabled = draft.enabled,
        rev = rev,
        updatedAt = now,
        deleted = 0,
        dirty = 1,
    )

    /**
     * 校验（R4 的写入层拦截：两个开关都关必须拒绝）。
     *
     * 之所以在服务层再拦一次：schema 的 anyOf 是给同步与后端用的，本地库是裸 SQLite，
     * 没有任何东西会替你执行 schema —— 写入层是唯一的闸门。
     *
     * 墓碑豁免（§11.1）：本方法只校验**存活行**。deleted=1 的行是删除标记、不是提醒状态
     * （删除时常先把两个开关清零再打标记），墓碑一律不走校验，否则删除永远同步不到对端。
     * enabled=0 不豁免 —— 它仍是「要提醒但暂时关掉」的存活行。
     */
    fun validate(draft: ReminderDraft): List<String> {
        val errors = ArrayList<String>()
        if (draft.ownerKind !in ReminderOwner.ALL) {
            errors += "reminder.owner_kind 必须是 0/1/2，实际 ${draft.ownerKind}"
        }
        if (draft.ownerId.isBlank()) {
            errors += "reminder.owner_id 不能为空"
        }
        if (!draft.notifyOn && !draft.alarmOn) {
            errors += "提醒至少要开一个：通知与闹钟不能同时关闭（不提醒请软删该提醒或置 enabled=0）"
        }
        if (!TIME_OF_DAY.matches(draft.timeOfDay.trim())) {
            errors += "提醒时间必须是 HH:mm（00:00~23:59），实际 \"${draft.timeOfDay}\""
        }
        if (draft.notifyText.trim().length > NOTIFY_TEXT_MAX) {
            errors += "通知文案最多 $NOTIFY_TEXT_MAX 字，实际 ${draft.notifyText.trim().length} 字"
        }
        if (draft.offsetDays !in OFFSET_DAYS) {
            errors += "提前/延后天数必须在 ${OFFSET_DAYS.first}~${OFFSET_DAYS.last} 之间，实际 ${draft.offsetDays}"
        }
        if (draft.snoozeMin !in SNOOZE_MIN) {
            errors += "贪睡间隔必须在 ${SNOOZE_MIN.first}~${SNOOZE_MIN.last} 分钟之间，实际 ${draft.snoozeMin}"
        }
        if (draft.repeatRule != 0 && draft.repeatRule != 1) {
            errors += "repeat_rule 只能是 0（只在周期第一个命中日）或 1（每个命中日），实际 ${draft.repeatRule}"
        }
        return errors
    }
}
