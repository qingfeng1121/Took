package app.took.data

import app.took.engine.Rule

/**
 * 规则表的读视图。可空字段对应 schema 里的 null。
 *
 * 同步四件套（rev / updated_at / deleted / dirty）挂在末尾并带默认值：
 * 只读查询（月历展开）不关心它们，写路径（RuleEditService）要用它们表达
 * 「软删 + dirty=1 + 新 updated_at」这条契约 §9 的统一约定。
 */
data class RuleRow(
    val id: String,
    val title: String,
    val enabled: Boolean,
    val repeatMode: Int,
    val weekdaysMask: Int,
    val repeatEvery: Int?,
    val monthDay: Int?,
    val yearMonth: Int?,
    val yearDay: Int?,
    val startDate: String,
    val endDate: String?,
    val repeatUntil: String?,
    val rev: Long = 0,
    val updatedAt: Long = 0,
    val deleted: Int = 0,
    val dirty: Int = 0,
) {
    fun toEngine(): Rule = Rule(
        id = id,
        repeatMode = repeatMode,
        startDate = startDate,
        weekdaysMask = weekdaysMask,
        repeatEvery = repeatEvery ?: 0,
        monthDay = monthDay ?: 0,
        yearMonth = yearMonth ?: 0,
        yearDay = yearDay ?: 0,
        endDate = endDate,
        repeatUntil = repeatUntil,
    )

    fun toDraft(): RuleDraft = RuleDraft(
        id = id,
        title = title,
        enabled = enabled,
        repeatMode = repeatMode,
        weekdaysMask = weekdaysMask,
        repeatEvery = repeatEvery,
        monthDay = monthDay,
        yearMonth = yearMonth,
        yearDay = yearDay,
        startDate = startDate,
        endDate = endDate,
        repeatUntil = repeatUntil,
    )
}

data class TaskRow(
    val id: String,
    val ruleId: String,
    val title: String,
    val enabled: Boolean,
    val sortOrder: Int,
    val rev: Long = 0,
    val updatedAt: Long = 0,
    val deleted: Int = 0,
    val dirty: Int = 0,
)

data class CompletionRow(val taskId: String, val periodStart: String, val status: Int)

/**
 * 记事 / 倒数日 / 笔记本（契约 §10）。kind：0 记事 / 1 倒数日 / 2 笔记本。
 *
 * 与 [RuleRow] 同一套同步四件套：读月历只关心 kind 与日期，写路径（MemoEditService）
 * 要用 rev / updated_at / deleted / dirty 表达「原地改 + dirty=1 + 软删」。
 * 注意表里**没有 created_at**——笔记本元信息显示「更新于」，见契约 §10.4。
 */
data class MemoRow(
    val id: String,
    val kind: Int,
    val title: String,
    val content: String?,
    val startDate: String?,
    val endDate: String?,
    val category: String?,
    val rev: Long = 0,
    val updatedAt: Long = 0,
    val deleted: Int = 0,
    val dirty: Int = 0,
)

/**
 * memo 的编辑载荷（新建 / 修改共用）。空字符串表示「这一栏留空」，
 * 落库时统一转成 NULL，与 PC 端 empty_to_null 同一口径。
 */
data class MemoDraft(
    val id: String = "",
    val kind: Int,
    val title: String = "",
    val content: String = "",
    val startDate: String = "",
    val endDate: String = "",
    val category: String = "",
)

fun MemoRow.toDraft(): MemoDraft = MemoDraft(
    id = id,
    kind = kind,
    title = title,
    content = content.orEmpty(),
    startDate = startDate.orEmpty(),
    endDate = endDate.orEmpty(),
    category = category.orEmpty(),
)

/** 某天命中的一个任务。done 由 (task_id, period_start) 决定，同一周期内共享。 */
data class DayItem(
    val taskId: String,
    val title: String,
    val ruleId: String,
    val ruleTitle: String,
    val periodStart: String,
    val done: Boolean,
)

/**
 * 提醒（契约 §11）：挂在规则（owner_kind=0）或 memo（1/2）上，落独立的 reminder 表。
 *
 * notifyOn / alarmOn 是**两个独立布尔**，`!notifyOn && !alarmOn` 是非法状态
 * （schema 用 anyOf 拦死，写入层 ReminderEditPolicy.validate 再拦一次）。
 * 规则下的任务继承所属规则的提醒，没有 task 级别的提醒行。
 */
data class ReminderRow(
    val id: String,
    val ownerKind: Int,
    val ownerId: String,
    val notifyOn: Boolean = false,
    val alarmOn: Boolean = false,
    val timeOfDay: String = "09:00",
    val notifyText: String? = null,
    val offsetDays: Int = 0,
    val repeatRule: Int = 0,
    val snoozeMin: Int = 0,
    val enabled: Boolean = true,
    val rev: Long = 0,
    val updatedAt: Long = 0,
    val deleted: Int = 0,
    val dirty: Int = 0,
) {
    fun toDraft(): ReminderDraft = ReminderDraft(
        id = id,
        ownerKind = ownerKind,
        ownerId = ownerId,
        notifyOn = notifyOn,
        alarmOn = alarmOn,
        timeOfDay = timeOfDay,
        notifyText = notifyText.orEmpty(),
        offsetDays = offsetDays,
        repeatRule = repeatRule,
        snoozeMin = snoozeMin,
        enabled = enabled,
    )
}

/** 提醒的编辑载荷。空串一律表示「这一栏留空」，落库时转 NULL（与 MemoDraft 同口径）。 */
data class ReminderDraft(
    val id: String = "",
    val ownerKind: Int,
    val ownerId: String,
    val notifyOn: Boolean = false,
    val alarmOn: Boolean = false,
    val timeOfDay: String = "",
    val notifyText: String = "",
    val offsetDays: Int = 0,
    val repeatRule: Int = 0,
    val snoozeMin: Int = 0,
    val enabled: Boolean = true,
)

/**
 * 月历里的一格。inMonth=false 表示补位的上月/下月日期。
 *
 * memos 与 PC 的 Day.memos 对齐：只有记事（kind=0）且当天落在区间里才会出现，
 * 倒数日与笔记本永远为空（契约 §10.1）。
 */
data class DayCell(
    val date: String,
    val inMonth: Boolean,
    val items: List<DayItem>,
    val memos: List<MemoRow> = emptyList(),
)
