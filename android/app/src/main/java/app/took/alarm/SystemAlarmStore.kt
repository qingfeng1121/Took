package app.took.alarm

import android.content.ContentValues
import android.database.Cursor
import app.took.data.TookDb

/**
 * system_alarm 的存储端口：记住「哪些闹钟已经交给系统时钟了」（本地记账，不参与同步）。
 *
 * 为什么必须记账：Android 没有任何 API 能查「系统时钟里有没有这条闹钟」，也不能程序化删除。
 * 没有这张表就只能每次保存都发一条 ACTION_SET_ALARM —— 几十条重复闹钟堆在用户的时钟 App 里，
 * 比不做还糟。有了指纹才能做到「同一规则同一时刻只建一次」。
 */
interface SystemAlarmStore {
    fun systemAlarms(): List<SystemAlarmRecord>
    fun systemAlarm(ruleId: String): SystemAlarmRecord?
    fun putSystemAlarm(record: SystemAlarmRecord)
    fun deleteSystemAlarm(ruleId: String)
    fun clearSystemAlarms()
}

class SqliteSystemAlarmStore(private val db: TookDb) : SystemAlarmStore {

    override fun systemAlarms(): List<SystemAlarmRecord> {
        val out = ArrayList<SystemAlarmRecord>()
        db.readableDatabase.rawQuery(
            "SELECT rule_id, reminder_id, label, hour, minute, days, fingerprint, created_at " +
                "FROM system_alarm ORDER BY hour, minute",
            null,
        ).use { c ->
            while (c.moveToNext()) out.add(read(c))
        }
        return out
    }

    override fun systemAlarm(ruleId: String): SystemAlarmRecord? {
        db.readableDatabase.rawQuery(
            "SELECT rule_id, reminder_id, label, hour, minute, days, fingerprint, created_at " +
                "FROM system_alarm WHERE rule_id=?",
            arrayOf(ruleId),
        ).use { c ->
            if (!c.moveToFirst()) return null
            return read(c)
        }
    }

    override fun putSystemAlarm(record: SystemAlarmRecord) {
        val v = ContentValues().apply {
            put("rule_id", record.ruleId)
            put("reminder_id", record.reminderId)
            put("label", record.label)
            put("hour", record.hour)
            put("minute", record.minute)
            put("days", record.days.joinToString(","))
            put("fingerprint", record.fingerprint)
            put("created_at", record.createdAt)
        }
        db.writableDatabase.insertWithOnConflict(
            "system_alarm", null, v, android.database.sqlite.SQLiteDatabase.CONFLICT_REPLACE,
        )
    }

    override fun deleteSystemAlarm(ruleId: String) {
        db.writableDatabase.delete("system_alarm", "rule_id=?", arrayOf(ruleId))
    }

    override fun clearSystemAlarms() {
        db.writableDatabase.delete("system_alarm", null, null)
    }

    private fun read(c: Cursor) = SystemAlarmRecord(
        ruleId = c.getString(0),
        reminderId = c.getString(1),
        label = c.getString(2),
        hour = c.getInt(3),
        minute = c.getInt(4),
        days = c.getString(5).split(",").mapNotNull { it.trim().toIntOrNull() },
        fingerprint = c.getString(6),
        createdAt = c.getLong(7),
    )
}
