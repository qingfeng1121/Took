package app.took.alarm

import android.content.ContentValues
import android.database.Cursor
import app.took.data.TookDb

/**
 * `reminder_schedule` 的一行：某条提醒**当前排上的那一次**（定稿 §6.3.4）。
 *
 * 一条提醒只保留一条「下一次」记录：注册成功即写、响过更新 fired_at、贪睡把 fire_at 往后推。
 * 不做「未来 90 天整片落库」—— AlarmsManager 侧也只注册最近的一次，
 * 响过由 receiver 重排下一次（见 ReminderScheduler 的注释）。
 */
data class ScheduleRow(
    val reminderId: String,
    val ruleId: String,
    val occurDate: String,
    val fireAt: Long,
    val snoozeCount: Int = 0,
    val firedAt: Long? = null,
    val updatedAt: Long = 0,
)

/** reminder_schedule 的存储端口（单测不需要它，但保持与其它 store 同一套写法）。 */
interface ReminderScheduleStore {
    fun schedules(): List<ScheduleRow>
    fun schedule(reminderId: String): ScheduleRow?
    fun putSchedule(row: ScheduleRow)
    fun deleteSchedule(reminderId: String)
    fun clearSchedules()
}

class SqliteReminderScheduleStore(private val db: TookDb) : ReminderScheduleStore {

    override fun schedules(): List<ScheduleRow> {
        val out = ArrayList<ScheduleRow>()
        db.readableDatabase.rawQuery(
            "SELECT reminder_id, rule_id, occur_date, fire_at, snooze_count, fired_at, updated_at " +
                "FROM reminder_schedule ORDER BY fire_at",
            null,
        ).use { c ->
            while (c.moveToNext()) out.add(read(c))
        }
        return out
    }

    override fun schedule(reminderId: String): ScheduleRow? {
        db.readableDatabase.rawQuery(
            "SELECT reminder_id, rule_id, occur_date, fire_at, snooze_count, fired_at, updated_at " +
                "FROM reminder_schedule WHERE reminder_id=?",
            arrayOf(reminderId),
        ).use { c ->
            if (!c.moveToFirst()) return null
            return read(c)
        }
    }

    override fun putSchedule(row: ScheduleRow) {
        val v = ContentValues().apply {
            put("reminder_id", row.reminderId)
            put("rule_id", row.ruleId)
            put("occur_date", row.occurDate)
            put("fire_at", row.fireAt)
            put("snooze_count", row.snoozeCount)
            if (row.firedAt == null) putNull("fired_at") else put("fired_at", row.firedAt)
            put("updated_at", row.updatedAt)
        }
        db.writableDatabase.insertWithOnConflict(
            "reminder_schedule", null, v, android.database.sqlite.SQLiteDatabase.CONFLICT_REPLACE,
        )
    }

    override fun deleteSchedule(reminderId: String) {
        db.writableDatabase.delete("reminder_schedule", "reminder_id=?", arrayOf(reminderId))
    }

    override fun clearSchedules() {
        db.writableDatabase.delete("reminder_schedule", null, null)
    }

    private fun read(c: Cursor) = ScheduleRow(
        reminderId = c.getString(0),
        ruleId = c.getString(1),
        occurDate = c.getString(2),
        fireAt = c.getLong(3),
        snoozeCount = c.getInt(4),
        firedAt = if (c.isNull(5)) null else c.getLong(5),
        updatedAt = c.getLong(6),
    )
}
