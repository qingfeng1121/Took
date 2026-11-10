package app.took.data

import android.content.ContentValues
import android.database.sqlite.SQLiteDatabase

/** CompletionDao 的 SQLite 实现：写 status / updated_at / dirty=1，其余列保持原值。 */
class SqliteCompletionDao(private val db: TookDb) : CompletionDao {

    override fun find(taskId: String, periodStart: String): CompletionRecord? {
        db.readableDatabase.rawQuery(
            "SELECT status, updated_at, rev, deleted, dirty FROM completion WHERE task_id=? AND period_start=?",
            arrayOf(taskId, periodStart),
        ).use { c ->
            if (!c.moveToFirst()) return null
            return CompletionRecord(
                taskId = taskId,
                periodStart = periodStart,
                status = c.getInt(0),
                updatedAt = c.getLong(1),
                rev = c.getLong(2),
                deleted = c.getInt(3),
                dirty = c.getInt(4),
            )
        }
    }

    override fun save(record: CompletionRecord) {
        val v = ContentValues().apply {
            put("task_id", record.taskId)
            put("period_start", record.periodStart)
            put("status", record.status)
            put("updated_at", record.updatedAt)
            put("rev", record.rev)
            put("deleted", record.deleted)
            put("dirty", record.dirty)
        }
        db.writableDatabase.insertWithOnConflict("completion", null, v, SQLiteDatabase.CONFLICT_REPLACE)
    }
}
