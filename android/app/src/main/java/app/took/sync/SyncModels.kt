package app.took.sync

/** 同步里的表名，与契约 §7.1 的请求/响应字段名逐字一致。 */
typealias JsonObject = Map<String, Any?>

object SyncTables {
    const val RULES = "rules"
    const val TASKS = "tasks"
    const val MEMOS = "memos"
    const val REMINDERS = "reminders"
    const val COMPLETIONS = "completions"

    val ALL = listOf(RULES, TASKS, MEMOS, REMINDERS, COMPLETIONS)

    /** 协议里的复数名 → 本地 SQLite 表名。 */
    fun sqlTable(name: String): String = when (name) {
        RULES -> "rule"
        TASKS -> "task"
        MEMOS -> "memo"
        REMINDERS -> "reminder"
        COMPLETIONS -> "completion"
        else -> throw IllegalArgumentException("未知同步表：$name")
    }

    /** completion 是复合主键，其余表用 id。 */
    fun pkColumns(name: String): List<String> = when (name) {
        COMPLETIONS -> listOf("task_id", "period_start")
        else -> listOf("id")
    }
}

/** 一次 push / pull 的五张表（提醒是独立的 reminder 表，随规则一起推拉）。 */
data class SyncBatch(
    val rules: List<JsonObject> = emptyList(),
    val tasks: List<JsonObject> = emptyList(),
    val memos: List<JsonObject> = emptyList(),
    val reminders: List<JsonObject> = emptyList(),
    val completions: List<JsonObject> = emptyList(),
) {
    val total: Int get() = rules.size + tasks.size + memos.size + reminders.size + completions.size

    fun rows(table: String): List<JsonObject> = when (table) {
        SyncTables.RULES -> rules
        SyncTables.TASKS -> tasks
        SyncTables.MEMOS -> memos
        SyncTables.REMINDERS -> reminders
        SyncTables.COMPLETIONS -> completions
        else -> emptyList()
    }

    fun toJson(): JsonObject = linkedMapOf(
        SyncTables.RULES to rules,
        SyncTables.TASKS to tasks,
        SyncTables.MEMOS to memos,
        SyncTables.REMINDERS to reminders,
        SyncTables.COMPLETIONS to completions,
    )

    companion object {
        val EMPTY = SyncBatch()

        fun fromJson(obj: JsonObject?): SyncBatch {
            if (obj == null) return EMPTY
            fun rows(key: String): List<JsonObject> =
                (obj[key] as? List<*>).orEmpty().mapNotNull { it as? JsonObject }
            return SyncBatch(
                rules = rows(SyncTables.RULES),
                tasks = rows(SyncTables.TASKS),
                memos = rows(SyncTables.MEMOS),
                reminders = rows(SyncTables.REMINDERS),
                completions = rows(SyncTables.COMPLETIONS),
            )
        }
    }
}

data class PushResponse(val accepted: Map<String, Int>, val maxRev: Long)

data class PullResponse(val batch: SyncBatch, val maxRev: Long, val hasMore: Boolean)

/** 一次同步的结果。ok=false 时本地数据一字不改（契约 §7.4：失败不回滚，只保留 dirty）。 */
data class SyncOutcome(
    val ok: Boolean,
    val pushed: Int,
    val pulled: Int,
    val rev: Long,
    val error: String? = null,
)

/** 网络端口：Android 用 HttpURLConnection 实现，单测用 mock 服务器实现。 */
interface SyncApi {
    fun push(batch: SyncBatch): PushResponse
    fun pull(since: Long): PullResponse
}

/** 本地库端口：SQLite 实现 + 单测用的内存实现。 */
interface SyncStore {
    fun lastPulledRev(): Long
    fun setLastPulledRev(rev: Long)
    fun dirtyCount(): Int
    fun dirtyRows(): SyncBatch

    /** push 成功：把这些记录的 dirty 清零。 */
    fun markClean(pushed: SyncBatch)

    /** pull 落库：按 §7.2 仲裁，只写入远端更该赢的记录。返回实际写入条数。 */
    fun applyPulled(pulled: SyncBatch): Int
}
