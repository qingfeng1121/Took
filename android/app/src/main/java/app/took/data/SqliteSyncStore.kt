package app.took.data

import android.content.ContentValues
import android.database.Cursor
import android.database.sqlite.SQLiteDatabase
import app.took.sync.JsonObject
import app.took.sync.Merge
import app.took.sync.SyncBatch
import app.took.sync.SyncSettings
import app.took.sync.SyncStore
import app.took.sync.SyncTables

/**
 * SyncStore 的 SQLite 实现。
 *
 * 两个刻意的取舍：
 *  1. 列名即协议字段名（契约 §2 的 snake_case），因此按 cursor 的列名动态成行，
 *     不写 4 张表的字段清单 —— 加字段时同步层不用跟着改；
 *  2. 落库前用 PRAGMA table_info 过滤未知列：服务端若先上了新字段，客户端忽略而不是整批失败。
 */
class SqliteSyncStore(
    private val db: TookDb,
    private val settings: SyncSettings,
) : SyncStore {

    private val columnCache = HashMap<String, Set<String>>()

    override fun lastPulledRev(): Long = settings.lastPulledRev

    override fun setLastPulledRev(rev: Long) {
        settings.lastPulledRev = rev
    }

    override fun dirtyCount(): Int {
        var n = 0
        for (t in SyncTables.ALL) {
            db.readableDatabase.rawQuery(
                "SELECT COUNT(*) FROM ${SyncTables.sqlTable(t)} WHERE dirty=1",
                null,
            ).use { c -> if (c.moveToFirst()) n += c.getInt(0) }
        }
        return n
    }

    override fun dirtyRows(): SyncBatch {
        val byTable = SyncTables.ALL.associateWith { readDirty(SyncTables.sqlTable(it)) }
        return SyncBatch(
            rules = byTable[SyncTables.RULES].orEmpty(),
            tasks = byTable[SyncTables.TASKS].orEmpty(),
            memos = byTable[SyncTables.MEMOS].orEmpty(),
            reminders = byTable[SyncTables.REMINDERS].orEmpty(),
            completions = byTable[SyncTables.COMPLETIONS].orEmpty(),
        )
    }

    override fun markClean(pushed: SyncBatch) {
        val w = db.writableDatabase
        val clean = ContentValues().apply { put("dirty", 0) }
        for (t in SyncTables.ALL) {
            for (row in pushed.rows(t)) {
                val clause = whereFor(t, row) ?: continue
                w.update(SyncTables.sqlTable(t), clean, clause.first, clause.second)
            }
        }
    }

    override fun applyPulled(pulled: SyncBatch): Int {
        val w = db.writableDatabase
        var applied = 0
        w.beginTransaction()
        try {
            for (t in SyncTables.ALL) {
                val table = SyncTables.sqlTable(t)
                val known = columnsOf(table)
                for (row in pulled.rows(t)) {
                    val fields = row.filterKeys { it in known }
                    val clause = whereFor(t, fields) ?: continue
                    val local = localRow(w, table, clause.first, clause.second)
                    if (!Merge.remoteWins(local, fields)) continue
                    val values = ContentValues()
                    fields.forEach { (k, v) -> putValue(values, k, v) }
                    values.put("dirty", 0)
                    w.insertWithOnConflict(table, null, values, SQLiteDatabase.CONFLICT_REPLACE)
                    applied++
                }
            }
            w.setTransactionSuccessful()
        } finally {
            w.endTransaction()
        }
        return applied
    }

    private fun readDirty(table: String): List<JsonObject> {
        val out = ArrayList<JsonObject>()
        db.readableDatabase.rawQuery("SELECT * FROM $table WHERE dirty=1", null).use { c ->
            while (c.moveToNext()) out.add(rowOf(c))
        }
        return out
    }

    private fun rowOf(c: Cursor): JsonObject {
        val row = LinkedHashMap<String, Any?>()
        for (i in c.columnNames.indices) {
            row[c.columnNames[i]] = when (c.getType(i)) {
                Cursor.FIELD_TYPE_NULL -> null
                Cursor.FIELD_TYPE_INTEGER -> c.getLong(i)
                Cursor.FIELD_TYPE_FLOAT -> c.getDouble(i)
                else -> c.getString(i)
            }
        }
        return row
    }

    private fun localRow(w: SQLiteDatabase, table: String, where: String, args: Array<String>): JsonObject? {
        w.rawQuery("SELECT * FROM $table WHERE $where", args).use { c ->
            if (!c.moveToFirst()) return null
            return rowOf(c)
        }
    }

    private fun whereFor(table: String, row: JsonObject): Pair<String, Array<String>>? {
        val pk = SyncTables.pkColumns(table)
        if (pk.any { row[it] == null }) return null
        return pk.joinToString(" AND ") { "$it=?" } to pk.map { row[it].toString() }.toTypedArray()
    }

    private fun columnsOf(table: String): Set<String> = columnCache.getOrPut(table) {
        val out = HashSet<String>()
        db.readableDatabase.rawQuery("PRAGMA table_info($table)", null).use { c ->
            val nameIdx = c.getColumnIndex("name")
            while (c.moveToNext()) out.add(c.getString(nameIdx))
        }
        out
    }

    private fun putValue(v: ContentValues, key: String, value: Any?) {
        when (value) {
            null -> v.putNull(key)
            is Boolean -> v.put(key, if (value) 1 else 0)
            is Int -> v.put(key, value)
            is Long -> v.put(key, value)
            is Double -> v.put(key, value)
            else -> v.put(key, value.toString())
        }
    }
}
