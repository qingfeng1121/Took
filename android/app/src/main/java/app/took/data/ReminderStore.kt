package app.took.data

import android.content.ContentValues
import android.database.Cursor
import android.database.sqlite.SQLiteDatabase

/**
 * reminder（契约 §11）的存储端口。
 *
 * 与 [RuleStore] / [MemoStore] 同一套做法：校验与三按钮状态机必须能在 JVM 单测里断言
 * （R1~R5），所以具体的 SQL 退到这层实现后面，测试用内存实现即可跑。
 * 读方法**含软删行**：写路径要看得见墓碑，否则「删了又建同 id」会把墓碑整行覆盖掉。
 */
interface ReminderStore {
    fun reminder(id: String): ReminderRow?

    /** 全部提醒（含软删）。 */
    fun reminders(): List<ReminderRow>
    fun putReminder(reminder: ReminderRow)
}

/** SQLite 实现：整行写入（含同步四件套），调用方负责算好 updated_at / dirty / deleted。 */
class SqliteReminderStore(private val db: TookDb) : ReminderStore {

    override fun reminder(id: String): ReminderRow? {
        db.readableDatabase.rawQuery(
            "SELECT $COLUMNS FROM reminder WHERE id=?",
            arrayOf(id),
        ).use { c ->
            if (!c.moveToFirst()) return null
            return readReminder(c)
        }
    }

    override fun reminders(): List<ReminderRow> {
        val out = ArrayList<ReminderRow>()
        db.readableDatabase.rawQuery(
            "SELECT $COLUMNS FROM reminder ORDER BY owner_kind, owner_id, updated_at",
            null,
        ).use { c ->
            while (c.moveToNext()) out.add(readReminder(c))
        }
        return out
    }

    override fun putReminder(reminder: ReminderRow) {
        val v = ContentValues().apply {
            put("id", reminder.id)
            put("owner_kind", reminder.ownerKind)
            put("owner_id", reminder.ownerId)
            put("notify_on", if (reminder.notifyOn) 1 else 0)
            put("alarm_on", if (reminder.alarmOn) 1 else 0)
            put("time_of_day", reminder.timeOfDay)
            // 空串落 NULL：与 memo 的 empty_to_null 同一口径，避免同构库里出现两种「空」
            put("notify_text", reminder.notifyText?.takeIf { it.isNotBlank() })
            put("offset_days", reminder.offsetDays)
            put("repeat_rule", reminder.repeatRule)
            put("snooze_min", reminder.snoozeMin)
            put("enabled", if (reminder.enabled) 1 else 0)
            put("rev", reminder.rev)
            put("updated_at", reminder.updatedAt)
            put("deleted", reminder.deleted)
            put("dirty", reminder.dirty)
        }
        db.writableDatabase.insertWithOnConflict("reminder", null, v, SQLiteDatabase.CONFLICT_REPLACE)
    }

    private fun readReminder(c: Cursor) = ReminderRow(
        id = c.getString(0),
        ownerKind = c.getInt(1),
        ownerId = c.getString(2),
        notifyOn = c.getInt(3) == 1,
        alarmOn = c.getInt(4) == 1,
        timeOfDay = c.getString(5),
        notifyText = if (c.isNull(6)) null else c.getString(6),
        offsetDays = c.getInt(7),
        repeatRule = c.getInt(8),
        snoozeMin = c.getInt(9),
        enabled = c.getInt(10) == 1,
        rev = c.getLong(11),
        updatedAt = c.getLong(12),
        deleted = c.getInt(13),
        dirty = c.getInt(14),
    )

    private companion object {
        const val COLUMNS =
            "id, owner_kind, owner_id, notify_on, alarm_on, time_of_day, notify_text, " +
                "offset_days, repeat_rule, snooze_min, enabled, rev, updated_at, deleted, dirty"
    }
}
