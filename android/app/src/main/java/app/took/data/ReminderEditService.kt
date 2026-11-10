package app.took.data

import java.util.UUID

/** 提醒写路径的结果。 */
sealed interface ReminderOutcome {
    data class Saved(val reminderId: String, val row: ReminderRow) : ReminderOutcome
    data class Invalid(val errors: List<String>) : ReminderOutcome
    data class Rejected(val reason: String) : ReminderOutcome

    /** 「不提醒」（§11.1 的互斥重置 / §11.4 R3）：该行软删，摘要随之消失。 */
    data class Cleared(val reminderId: String) : ReminderOutcome
}

/**
 * 契约 §11 的提醒写路径：get / save / clear。
 *
 * 与规则、memo 同一套约定（§9.5 / §10.2）：updated_at = now、dirty = 1、rev 保持，
 * 「不提醒」走软删 deleted = 1（绝不物理 DELETE，否则会被另一端同步回来复活）。
 *
 * 一个宿主（规则或 memo）最多一条提醒行：save 时先按 (owner_kind, owner_id) 找现有行，
 * 找到就原地改（rev 不动），找不到才生成新 id。
 */
class ReminderEditService(
    private val store: ReminderStore,
    private val clock: () -> Long = System::currentTimeMillis,
    private val idGen: () -> String = { "rm_" + UUID.randomUUID().toString().replace("-", "").take(16) },
) {

    /** 宿主当前生效的提醒行；已软删的当作不存在。 */
    fun reminderOf(ownerKind: Int, ownerId: String): ReminderRow? =
        store.reminders().firstOrNull {
            it.ownerKind == ownerKind && it.ownerId == ownerId && it.deleted == 0
        }

    /** 当前生效（enabled）的提醒行；宿主没有提醒或已停用时为 null。 */
    fun activeOf(ownerKind: Int, ownerId: String): ReminderRow? =
        reminderOf(ownerKind, ownerId)?.takeIf { it.enabled }

    /** 规则的提醒（规则列表与编辑页共用）。 */
    fun ruleReminders(): Map<String, ReminderRow> {
        val out = HashMap<String, ReminderRow>()
        store.reminders()
            .filter { it.ownerKind == ReminderOwner.RULE && it.deleted == 0 && it.enabled }
            .forEach { row ->
                // 同一宿主原则上只有一行；万一同 id 多条，取 updated_at 最新的那条
                val old = out[row.ownerId]
                if (old == null || row.updatedAt >= old.updatedAt) out[row.ownerId] = row
            }
        return out
    }

    /**
     * 保存（R1 / R2）：两个开关都关的草稿一律 [ReminderOutcome.Invalid]——
     * 想不提醒请走 [clear]。
     */
    fun save(draft: ReminderDraft): ReminderOutcome {
        val errors = ReminderEditPolicy.validate(draft)
        if (errors.isNotEmpty()) return ReminderOutcome.Invalid(errors)

        val requested = draft.id.trim()
        val existing = if (requested.isNotEmpty()) {
            store.reminder(requested)?.takeIf { it.deleted == 0 }
                ?: return ReminderOutcome.Rejected("提醒不存在：$requested")
        } else {
            reminderOf(draft.ownerKind, draft.ownerId)
        }

        val now = clock()
        return if (existing == null) {
            val id = if (requested.isEmpty()) idGen() else requested
            val row = ReminderEditPolicy.toRow(draft, id = id, now = now, rev = 0)
            store.putReminder(row)
            ReminderOutcome.Saved(id, row)
        } else {
            // 原地改：rev 保持库里原值，id 不变
            val row = ReminderEditPolicy.toRow(draft, id = existing.id, now = now, rev = existing.rev)
            store.putReminder(row)
            ReminderOutcome.Saved(existing.id, row)
        }
    }

    /** 「不提醒」（R3）：软删 + 新 updated_at + dirty=1。没有提醒行时视为已满足，不报错。 */
    fun clear(ownerKind: Int, ownerId: String): ReminderOutcome {
        val row = reminderOf(ownerKind, ownerId)
            ?: return ReminderOutcome.Cleared("")
        val fresh = row.copy(deleted = 1, updatedAt = clock(), dirty = 1)
        store.putReminder(fresh)
        return ReminderOutcome.Cleared(row.id)
    }
}
