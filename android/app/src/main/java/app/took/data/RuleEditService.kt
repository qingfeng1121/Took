package app.took.data

import app.took.engine.RepeatMode
import java.util.UUID

/**
 * 编辑写路径的结果。
 *
 * NeedsConfirm 是刻意的：命中 §9.2 的裂开条件时，**没拿到用户确认就不写库**。
 * 服务层自己拦一道，UI 忘了弹框也不会把历史记录洗掉。
 */
sealed interface EditOutcome {
    /** 已落库。split 非空表示这次是「旧规则封口 + 新建一条」。 */
    data class Saved(val ruleId: String, val split: SplitResult? = null) : EditOutcome

    /** 需要用户确认裂开；此时库里一个字都没改。 */
    data class NeedsConfirm(
        val oldRuleId: String,
        val oldTitle: String,
        val closedUntil: String,
        val newStartDate: String,
        val taskCount: Int,
    ) : EditOutcome

    data class Invalid(val errors: List<String>) : EditOutcome
    data class Rejected(val reason: String) : EditOutcome
    data class Deleted(val ruleId: String, val taskCount: Int) : EditOutcome
}

/** 裂开一次产生两条记录：旧规则《封口到 yesterday》+ 新规则《从今天开始》。 */
data class SplitResult(
    val oldRuleId: String,
    val oldRepeatUntil: String,
    val newRuleId: String,
    val newStartDate: String,
    val oldTaskCount: Int,
)

/**
 * 契约 §9 的写路径。全部写库动作统一：`updated_at = now`、`dirty = 1`、`rev` 不变、删除一律软删。
 *
 * split 判定的唯一入口是 [RuleEditPolicy.needsSplit]，服务层不自己再判断一遍字段；
 * 「避免重复裂开」靠三层：
 *  1. 比对的是**库里的现有行**与草稿 —— 原样保存永远不裂开；
 *  2. 已结束的规则（上界早于今天）拒绝改重复设置 → 同一段历史不可能被封口两次；
 *  3. 裂开必须带 confirmSplit=true，UI 与服务层各拦一次。
 */
class RuleEditService(
    private val store: RuleStore,
    private val clock: () -> Long = System::currentTimeMillis,
    private val today: () -> String = { java.time.LocalDate.now().toString() },
    private val ruleIdGen: () -> String = { "r_" + UUID.randomUUID().toString().replace("-", "").take(16) },
    private val taskIdGen: () -> String = { "t_" + UUID.randomUUID().toString().replace("-", "").take(16) },
    /** 删除规则时级联软删它的提醒（§9.3）。null = 这副规则库里还没有提醒表，只做规则与任务。 */
    private val reminders: ReminderStore? = null,
) {

    /* --------------------------- 规则：增 / 改 / 删 --------------------------- */

    /** §9.1 新增规则：客户端生成 id，至少一个任务。 */
    fun createRule(draft: RuleDraft, taskTitles: List<String>): EditOutcome {
        val errors = RuleEditPolicy.validateCreate(draft, taskTitles)
        if (errors.isNotEmpty()) return EditOutcome.Invalid(errors)
        val now = clock()
        val ruleId = ruleIdGen()
        store.putRule(draft.copy(id = ruleId, title = draft.title.trim()).toRow(now = now, rev = 0))
        taskTitles.map { it.trim() }.forEachIndexed { index, title ->
            store.putTask(
                TaskRow(
                    id = taskIdGen(),
                    ruleId = ruleId,
                    title = title,
                    enabled = true,
                    sortOrder = index,
                    updatedAt = now,
                    dirty = 1,
                ),
            )
        }
        return EditOutcome.Saved(ruleId)
    }

    /**
     * §9.2 修改规则：先由 [RuleEditPolicy.needsSplit] 分流。
     *  - 只改 title / enabled / 起止上界 → 原地改；
     *  - 改重复设置或开始日期 → 裂开（必须 confirmSplit=true，否则只返回 NeedsConfirm）。
     */
    fun updateRule(draft: RuleDraft, confirmSplit: Boolean = false): EditOutcome {
        val old = store.rule(draft.id) ?: return EditOutcome.Rejected("规则不存在：${draft.id}")
        if (old.deleted != 0) return EditOutcome.Rejected("规则已删除：${draft.id}")
        val errors = RuleEditPolicy.validateUpdate(draft)
        if (errors.isNotEmpty()) return EditOutcome.Invalid(errors)

        val now = clock()
        val todayKey = today()

        if (!RuleEditPolicy.needsSplit(old, draft)) {
            // 原地改：title / enabled / end_date / repeat_until 都不影响「哪天命中」
            store.putRule(
                old.copy(
                    title = draft.title.trim(),
                    enabled = draft.enabled,
                    endDate = draft.endDate,
                    repeatUntil = draft.repeatUntil,
                    updatedAt = now,
                    dirty = 1,
                ),
            )
            return EditOutcome.Saved(old.id)
        }

        // 命中 §9.2 的裂开条件
        if (RuleEditPolicy.isEnded(old, todayKey)) {
            return EditOutcome.Rejected(
                "该规则已结束（至 ${RuleEditPolicy.upperBound(old)}），重复设置不可再改；请新建规则",
            )
        }
        val closedUntil = RuleEditPolicy.closedRepeatUntil(old, todayKey)
        if (closedUntil == null) {
            // end_date 已有更早上界：封口写不进去，但新规则仍应从今天开始，属于数据异常
            return EditOutcome.Rejected("该规则已有更早的结束日期，无法封口；请先清空结束日期再改重复设置")
        }
        val newStart = todayKey
        draft.endDate?.takeIf { it.isNotBlank() }?.let { end ->
            val parsed = runCatching { app.took.engine.DateKeys.parse(end) }.getOrNull()
            if (parsed != null && parsed.isBefore(app.took.engine.DateKeys.parse(newStart))) {
                return EditOutcome.Invalid(listOf("结束日期不能早于今天：裂开后新规则从 $newStart 开始"))
            }
        }
        if (!confirmSplit) {
            return EditOutcome.NeedsConfirm(
                oldRuleId = old.id,
                oldTitle = old.title,
                closedUntil = closedUntil,
                newStartDate = newStart,
                taskCount = store.tasksOf(old.id).size,
            )
        }

        // 旧规则：原地改，只封口；任务与 completion 一条不动
        store.putRule(
            old.copy(
                title = draft.title.trim(),
                enabled = draft.enabled,
                repeatUntil = closedUntil,
                updatedAt = now,
                dirty = 1,
            ),
        )
        // 新规则：新 id、start_date = 今天、承载新设置；任务不自动搬（§9.2）
        val newId = ruleIdGen()
        store.putRule(
            draft.copy(id = newId, title = draft.title.trim(), startDate = newStart)
                .toRow(now = now, rev = 0),
        )
        return EditOutcome.Saved(
            ruleId = newId,
            split = SplitResult(
                oldRuleId = old.id,
                oldRepeatUntil = closedUntil,
                newRuleId = newId,
                newStartDate = newStart,
                oldTaskCount = store.tasksOf(old.id).size,
            ),
        )
    }

    /**
     * §9.3 删除规则：规则、其下所有任务、以及**它的提醒**一并软删；
     * completion 不删（历史事实 + 防复活）。
     *
     * 提醒必须级联：提醒挂在规则上，规则没了提醒就没有意义。留着不删是指向已删规则的孤儿行，
     * 既浪费同步流量，将来做「恢复规则」还会把旧提醒意外带回来。
     */
    fun deleteRule(ruleId: String): EditOutcome {
        val rule = store.rule(ruleId) ?: return EditOutcome.Rejected("规则不存在：$ruleId")
        if (rule.deleted != 0) return EditOutcome.Rejected("规则已删除：$ruleId")
        val now = clock()
        val tasks = store.tasksOf(ruleId)
        store.putRule(rule.copy(deleted = 1, updatedAt = now, dirty = 1))
        tasks.forEach { store.putTask(it.copy(deleted = 1, updatedAt = now, dirty = 1)) }
        reminders?.let { reminderStore ->
            reminderStore.reminders()
                .filter {
                    it.ownerKind == ReminderOwner.RULE && it.ownerId == ruleId && it.deleted == 0
                }
                .forEach { reminderStore.putReminder(it.copy(deleted = 1, updatedAt = now, dirty = 1)) }
        }
        return EditOutcome.Deleted(ruleId, tasks.size)
    }

    /* ------------------------------ 任务：增删改 ------------------------------ */

    /** §9.4：新任务的 sort_order = 当前最大值 + 1。返回 null 表示成功。 */
    fun addTask(ruleId: String, title: String): String? {
        val rule = store.rule(ruleId)
        if (rule == null || rule.deleted != 0) return "规则不存在：$ruleId"
        if (title.isBlank()) return "任务名不能为空"
        val next = (store.tasksOf(ruleId).maxOfOrNull { it.sortOrder } ?: -1) + 1
        store.putTask(
            TaskRow(
                id = taskIdGen(),
                ruleId = ruleId,
                title = title.trim(),
                enabled = true,
                sortOrder = next,
                updatedAt = clock(),
                dirty = 1,
            ),
        )
        return null
    }

    fun renameTask(taskId: String, title: String): String? {
        if (title.isBlank()) return "任务名不能为空"
        val task = store.task(taskId)
        if (task == null || task.deleted != 0) return "任务不存在：$taskId"
        if (task.title == title.trim()) return null
        store.putTask(task.copy(title = title.trim(), updatedAt = clock(), dirty = 1))
        return null
    }

    fun setTaskEnabled(taskId: String, enabled: Boolean): String? {
        val task = store.task(taskId)
        if (task == null || task.deleted != 0) return "任务不存在：$taskId"
        if (task.enabled == enabled) return null
        store.putTask(task.copy(enabled = enabled, updatedAt = clock(), dirty = 1))
        return null
    }

    /** §9.4 删除任务：软删；它名下的打卡记录不删。 */
    fun deleteTask(taskId: String): String? {
        val task = store.task(taskId)
        if (task == null || task.deleted != 0) return "任务不存在：$taskId"
        store.putTask(task.copy(deleted = 1, updatedAt = clock(), dirty = 1))
        return null
    }

    /**
     * §9.2「任务不自动搬，由用户点『复制任务到新规则』才搬」。
     * 复制而不是移动：旧规则下的任务与打卡记录必须原地不动。
     */
    fun copyTasksTo(sourceRuleId: String, targetRuleId: String): Int {
        val source = store.tasksOf(sourceRuleId)
        if (source.isEmpty()) return 0
        val now = clock()
        var next = (store.tasksOf(targetRuleId).maxOfOrNull { it.sortOrder } ?: -1) + 1
        source.forEach { task ->
            store.putTask(
                TaskRow(
                    id = taskIdGen(),
                    ruleId = targetRuleId,
                    title = task.title,
                    enabled = task.enabled,
                    sortOrder = next++,
                    updatedAt = now,
                    dirty = 1,
                ),
            )
        }
        return source.size
    }

    /** 规则下任务数：删除确认文案要用（§9.3「含 N 个任务」）。 */
    fun taskCount(ruleId: String): Int = store.tasksOf(ruleId).size
}

/** 草稿 → 库行。与本轮无关的字段按 repeat_mode 归零，与种子数据的写法一致。 */
private fun RuleDraft.toRow(now: Long, rev: Long = 0): RuleRow = RuleRow(
    id = id,
    title = title.trim(),
    enabled = enabled,
    repeatMode = repeatMode,
    weekdaysMask = if (repeatMode == RepeatMode.WEEKLY) weekdaysMask else 0,
    repeatEvery = if (repeatMode == RepeatMode.EVERY) repeatEvery else null,
    monthDay = if (repeatMode == RepeatMode.MONTHLY) monthDay else null,
    yearMonth = if (repeatMode == RepeatMode.YEARLY) yearMonth else null,
    yearDay = if (repeatMode == RepeatMode.YEARLY) yearDay else null,
    startDate = startDate,
    endDate = endDate?.takeIf { it.isNotBlank() },
    repeatUntil = repeatUntil?.takeIf { it.isNotBlank() },
    rev = rev,
    updatedAt = now,
    deleted = 0,
    dirty = 1,
)
