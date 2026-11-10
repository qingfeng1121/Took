package app.took.data

import app.took.engine.DateKeys
import app.took.engine.MONTH_DAY_LAST
import app.took.engine.RepeatMode

/** 规则编辑的输入草稿；新增时 id 留空，由客户端生成全局唯一 id（契约 §9.1）。 */
data class RuleDraft(
    val id: String = "",
    val title: String = "",
    val enabled: Boolean = true,
    val repeatMode: Int = RepeatMode.WEEKLY,
    val weekdaysMask: Int = 0,
    val repeatEvery: Int? = null,
    val monthDay: Int? = null,
    val yearMonth: Int? = null,
    val yearDay: Int? = null,
    val startDate: String = "",
    val endDate: String? = null,
    val repeatUntil: String? = null,
)

/**
 * 写路径的纯逻辑：**split 判定**、旧规则的封口上界、字段校验。
 *
 * 契约 §9.2 是这里唯一的裁决标准：
 *  - 改 title / enabled / 提醒 → 原地改，历史记录天然保留；
 *  - 改 repeat_mode / weekdays_mask / repeat_every / month_day / year_month / year_day / start_date
 *    → 必须裂开：旧规则 repeat_until = 昨天（原地改），另建一条新规则承载新设置。
 *    原地改会重算历史命中日，等于洗掉上个月的打卡记录。
 *
 * 这个对象没有任何 Android 依赖，JVM 单测直接覆盖（E1~E6）。
 */
object RuleEditPolicy {

    /** §9.2 右栏那七个字段：动它们就必须裂开。 */
    val SPLIT_FIELDS = listOf(
        "repeat_mode",
        "weekdays_mask",
        "repeat_every",
        "month_day",
        "year_month",
        "year_day",
        "start_date",
    )

    /**
     * 逐字段比对，返回发生变化的列名（沿用库里的列名，便于排错）。
     *
     * **只比较与当前 repeat_mode 相关的字段**：库里与模式无关的列一律是 NULL
     * （种子数据就是这样写的），而编辑器表单对这些字段有默认值（每 N 天默认 2、每月默认 1 日…）。
     * 若照「所有字段都比」实现，weekly 规则改个标题也会因为 draft.repeatEvery=2 vs 库里 NULL
     * 被判成「改了 repeat_every」而白白裂开一次 —— 这正是 2026-10-24 实测抓到的 bug。
     * 模式本身变化时 repeat_mode 已经是差异，所以忽略其余字段不会漏判。
     */
    fun changedFields(old: RuleRow, draft: RuleDraft): List<String> {
        val out = ArrayList<String>(4)
        if (old.startDate != draft.startDate) out.add("start_date")
        if (old.repeatMode != draft.repeatMode) {
            out.add("repeat_mode")
            return out
        }
        when (old.repeatMode) {
            RepeatMode.WEEKLY -> if (old.weekdaysMask != draft.weekdaysMask) out.add("weekdays_mask")
            RepeatMode.EVERY -> if (old.repeatEvery != draft.repeatEvery) out.add("repeat_every")
            RepeatMode.MONTHLY -> if (old.monthDay != draft.monthDay) out.add("month_day")
            RepeatMode.YEARLY -> {
                if (old.yearMonth != draft.yearMonth) out.add("year_month")
                if (old.yearDay != draft.yearDay) out.add("year_day")
            }
            else -> Unit // none：只看 start_date
        }
        return out
    }

    /**
     * 是否需要裂开。比对的是**库里的现有行**与草稿，
     * 所以「原样保存」永远得到 false —— 不会因为一次无改动的保存凭空多裂一条。
     */
    fun needsSplit(old: RuleRow, draft: RuleDraft): Boolean =
        changedFields(old, draft).any { it in SPLIT_FIELDS }

    /** 契约 §9.2：「昨天」= 今天 − 1 天，格式 YYYY-MM-DD。 */
    fun yesterday(today: String): String = DateKeys.key(DateKeys.parse(today).minusDays(1))

    /** 规则的实际上界：repeat_until 优先，其次 end_date，都空则不限。 */
    fun upperBound(rule: RuleRow): String? =
        rule.repeatUntil?.takeIf { it.isNotBlank() } ?: rule.endDate?.takeIf { it.isNotBlank() }

    /** 上界早于今天 = 已结束（配置页显示「已结束」，重复设置不可再改）。 */
    fun isEnded(rule: RuleRow, today: String): Boolean {
        val upper = upperBound(rule) ?: return false
        val parsed = runCatching { DateKeys.parse(upper) }.getOrNull() ?: return false
        return parsed.isBefore(DateKeys.parse(today))
    }

    /**
     * 裂开时写进旧规则的 repeat_until。
     * 契约 §9.2：只有 end_date 与 repeat_until **都为空**才写「昨天」；
     * 已有更早的上界则不覆盖（返回原值），保住那段更短的历史。
     */
    fun closedRepeatUntil(rule: RuleRow, today: String): String? =
        if (rule.repeatUntil.isNullOrBlank() && rule.endDate.isNullOrBlank()) yesterday(today)
        else rule.repeatUntil

    /** 新增（§9.1）：必填 title + start_date，且至少一个任务。 */
    fun validateCreate(draft: RuleDraft, taskTitles: List<String>): List<String> {
        val errors = validateRuleFields(draft).toMutableList()
        if (taskTitles.none { it.isNotBlank() }) errors += "至少需要一个任务"
        if (taskTitles.any { it.isBlank() }) errors += "任务名不能为空"
        return errors
    }

    /** 修改：字段本身合法即可（是否裂开由 needsSplit 决定，不在校验里）。 */
    fun validateUpdate(draft: RuleDraft): List<String> = validateRuleFields(draft)

    private fun validateRuleFields(draft: RuleDraft): List<String> {
        val errors = ArrayList<String>()
        if (draft.title.isBlank()) errors += "名称不能为空"

        val start = runCatching { DateKeys.parse(draft.startDate) }.getOrNull()
        if (start == null) {
            errors += "开始日期必须是 YYYY-MM-DD：\"${draft.startDate}\""
        }

        // 契约 §3.4 写入层：非法日期必须拒绝，不许静默兜底
        draft.endDate?.takeIf { it.isNotBlank() }?.let { end ->
            val parsed = runCatching { DateKeys.parse(end) }.getOrNull()
            when {
                parsed == null -> errors += "结束日期必须是 YYYY-MM-DD：\"$end\""
                start != null && parsed.isBefore(start) -> errors += "结束日期不能早于开始日期"
            }
        }
        draft.repeatUntil?.takeIf { it.isNotBlank() }?.let { until ->
            if (runCatching { DateKeys.parse(until) }.getOrNull() == null) {
                errors += "重复截止必须是 YYYY-MM-DD：\"$until\""
            }
        }

        when (draft.repeatMode) {
            RepeatMode.WEEKLY -> {
                if (draft.weekdaysMask == 0) errors += "每周重复至少要选一天"
                else if (draft.weekdaysMask and 0x7F != draft.weekdaysMask) errors += "星期掩码越界"
            }
            RepeatMode.EVERY -> {
                val every = draft.repeatEvery ?: 0
                if (every < 1 || every > 3660) errors += "每 N 天的 N 必须在 1..3660"
            }
            RepeatMode.MONTHLY -> {
                val day = draft.monthDay ?: 0
                if (day != MONTH_DAY_LAST && (day < 1 || day > 31)) errors += "每月日期必须在 1..31，或选最后一天"
            }
            RepeatMode.YEARLY -> {
                val month = draft.yearMonth ?: 0
                val day = draft.yearDay ?: 0
                if (month < 1 || month > 12) errors += "每年的月份必须在 1..12"
                if (day < 1 || day > 31) errors += "每年的日期必须在 1..31"
            }
            RepeatMode.NONE -> Unit
            else -> errors += "未知的重复方式 ${draft.repeatMode}"
        }
        return errors
    }
}
