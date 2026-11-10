package app.took.data

import android.content.ContentValues
import android.database.sqlite.SQLiteDatabase

/**
 * 规则 / 任务的存储端口。
 *
 * 为什么抽象成端口：split 判定与软删级联是契约 §9 里最容易写错的两处，
 * 它们必须能在 JVM 单测里断言（E1~E6），不能只在模拟器上验。
 * 读方法的语义故意分开：`rule/task` 含软删（写路径要看得见墓碑），
 * `tasksOf` 只返回 deleted=0（复制 / 排序只关心活着的任务）。
 */
interface RuleStore {
    fun rule(id: String): RuleRow?
    fun rules(): List<RuleRow>
    fun putRule(rule: RuleRow)

    fun task(id: String): TaskRow?
    fun tasksOf(ruleId: String): List<TaskRow>
    fun allTasks(): List<TaskRow>
    fun putTask(task: TaskRow)
}

/** SQLite 实现：整行写入（含同步四件套），调用方负责先算好 updated_at / dirty / deleted。 */
class SqliteRuleStore(private val db: TookDb) : RuleStore {

    override fun rule(id: String): RuleRow? {
        db.readableDatabase.rawQuery(
            "SELECT ${RULE_COLUMNS} FROM rule WHERE id=?",
            arrayOf(id),
        ).use { c ->
            if (!c.moveToFirst()) return null
            return readRule(c)
        }
    }

    override fun rules(): List<RuleRow> {
        val out = ArrayList<RuleRow>()
        db.readableDatabase.rawQuery(
            "SELECT ${RULE_COLUMNS} FROM rule ORDER BY start_date, title",
            null,
        ).use { c ->
            while (c.moveToNext()) out.add(readRule(c))
        }
        return out
    }

    override fun putRule(rule: RuleRow) {
        val v = ContentValues().apply {
            put("id", rule.id)
            put("title", rule.title)
            put("enabled", if (rule.enabled) 1 else 0)
            put("repeat_mode", rule.repeatMode)
            put("weekdays_mask", rule.weekdaysMask)
            put("repeat_every", rule.repeatEvery)
            put("month_day", rule.monthDay)
            put("year_month", rule.yearMonth)
            put("year_day", rule.yearDay)
            put("start_date", rule.startDate)
            put("end_date", rule.endDate)
            put("repeat_until", rule.repeatUntil)
            put("rev", rule.rev)
            put("updated_at", rule.updatedAt)
            put("deleted", rule.deleted)
            put("dirty", rule.dirty)
        }
        db.writableDatabase.insertWithOnConflict("rule", null, v, SQLiteDatabase.CONFLICT_REPLACE)
    }

    override fun task(id: String): TaskRow? {
        db.readableDatabase.rawQuery(
            "SELECT ${TASK_COLUMNS} FROM task WHERE id=?",
            arrayOf(id),
        ).use { c ->
            if (!c.moveToFirst()) return null
            return readTask(c)
        }
    }

    override fun tasksOf(ruleId: String): List<TaskRow> {
        val out = ArrayList<TaskRow>()
        db.readableDatabase.rawQuery(
            "SELECT ${TASK_COLUMNS} FROM task WHERE rule_id=? AND deleted=0 ORDER BY sort_order",
            arrayOf(ruleId),
        ).use { c ->
            while (c.moveToNext()) out.add(readTask(c))
        }
        return out
    }

    override fun allTasks(): List<TaskRow> {
        val out = ArrayList<TaskRow>()
        db.readableDatabase.rawQuery(
            "SELECT ${TASK_COLUMNS} FROM task ORDER BY rule_id, sort_order",
            null,
        ).use { c ->
            while (c.moveToNext()) out.add(readTask(c))
        }
        return out
    }

    override fun putTask(task: TaskRow) {
        val v = ContentValues().apply {
            put("id", task.id)
            put("rule_id", task.ruleId)
            put("title", task.title)
            put("enabled", if (task.enabled) 1 else 0)
            put("sort_order", task.sortOrder)
            put("rev", task.rev)
            put("updated_at", task.updatedAt)
            put("deleted", task.deleted)
            put("dirty", task.dirty)
        }
        db.writableDatabase.insertWithOnConflict("task", null, v, SQLiteDatabase.CONFLICT_REPLACE)
    }

    private fun readRule(c: android.database.Cursor) = RuleRow(
        id = c.getString(0),
        title = c.getString(1),
        enabled = c.getInt(2) == 1,
        repeatMode = c.getInt(3),
        weekdaysMask = c.getInt(4),
        repeatEvery = if (c.isNull(5)) null else c.getInt(5),
        monthDay = if (c.isNull(6)) null else c.getInt(6),
        yearMonth = if (c.isNull(7)) null else c.getInt(7),
        yearDay = if (c.isNull(8)) null else c.getInt(8),
        startDate = c.getString(9),
        endDate = if (c.isNull(10)) null else c.getString(10),
        repeatUntil = if (c.isNull(11)) null else c.getString(11),
        rev = c.getLong(12),
        updatedAt = c.getLong(13),
        deleted = c.getInt(14),
        dirty = c.getInt(15),
    )

    private fun readTask(c: android.database.Cursor) = TaskRow(
        id = c.getString(0),
        ruleId = c.getString(1),
        title = c.getString(2),
        enabled = c.getInt(3) == 1,
        sortOrder = c.getInt(4),
        rev = c.getLong(5),
        updatedAt = c.getLong(6),
        deleted = c.getInt(7),
        dirty = c.getInt(8),
    )

    private companion object {
        const val RULE_COLUMNS =
            "id, title, enabled, repeat_mode, weekdays_mask, repeat_every, month_day, " +
                "year_month, year_day, start_date, end_date, repeat_until, rev, updated_at, deleted, dirty"
        const val TASK_COLUMNS =
            "id, rule_id, title, enabled, sort_order, rev, updated_at, deleted, dirty"
    }
}
