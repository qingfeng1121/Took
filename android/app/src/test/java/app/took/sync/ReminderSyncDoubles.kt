package app.took.sync

/**
 * 提醒同步的双测替身（契约 §11.4 R5 用）。
 *
 * 为什么不用真后端：server/main.go 当前只实现 /api/health、/api/rules、/api/month，
 * 契约 §7.1 的 /api/sync/push、/api/sync/pull 与 reminder 表**尚未实现**（本轮范围限定只改
 * android/，不能顺手加后端接口）。因此这里按 §7.1 / §7.2 的报文形状与 LWW 仲裁实现替身：
 * 客户端这一侧（SyncBatch 序列化 → push → 清 dirty → pull → Merge 合并 → 推进游标）是真跑的。
 * 后端补完接口后，把这两个替身换成真地址即可，断言不用改。
 */

/** 内存版 SyncStore：只装 reminders，仲裁走生产代码 [Merge]。 */
internal class MemorySyncStore : SyncStore {

    /** 协议字段名 → 值。断言直接读它，避免再写一层映射。 */
    val rows = LinkedHashMap<String, JsonObject>()
    private var cursor = 0L

    fun putReminder(row: app.took.data.ReminderRow) {
        rows[row.id] = linkedMapOf(
            "id" to row.id,
            "owner_kind" to row.ownerKind.toLong(),
            "owner_id" to row.ownerId,
            "notify_on" to (if (row.notifyOn) 1L else 0L),
            "alarm_on" to (if (row.alarmOn) 1L else 0L),
            "time_of_day" to row.timeOfDay,
            "notify_text" to row.notifyText,
            "offset_days" to row.offsetDays.toLong(),
            "repeat_rule" to row.repeatRule.toLong(),
            "snooze_min" to row.snoozeMin.toLong(),
            "enabled" to (if (row.enabled) 1L else 0L),
            "rev" to row.rev,
            "updated_at" to row.updatedAt,
            "deleted" to row.deleted.toLong(),
            "dirty" to row.dirty.toLong(),
        )
    }

    private fun dirty(): List<JsonObject> = rows.values.filter { Merge.num(it["dirty"]) == 1L }

    override fun lastPulledRev(): Long = cursor

    override fun setLastPulledRev(rev: Long) {
        cursor = rev
    }

    override fun dirtyCount(): Int = dirty().size

    override fun dirtyRows(): SyncBatch = SyncBatch(reminders = dirty())

    override fun markClean(pushed: SyncBatch) {
        pushed.reminders.forEach { row ->
            val id = row["id"]?.toString() ?: return@forEach
            rows[id]?.let { rows[id] = it + ("dirty" to 0L) }
        }
    }

    override fun applyPulled(pulled: SyncBatch): Int {
        var applied = 0
        pulled.reminders.forEach { row ->
            val id = row["id"]?.toString() ?: return@forEach
            if (!Merge.remoteWins(rows[id], row)) return@forEach
            rows[id] = row + ("dirty" to 0L)
            applied++
        }
        return applied
    }
}

/**
 * 假服务端：只认协议里的表名，push 时**先过一遍 JSON**（写 + 解析），
 * 所以「reminders 真的在报文里」由这层证明，而不是由对象引用证明。
 * 每条落库时由服务端盖 rev（真后端也是这么做的），pull 按 rev > since 返回。
 */
internal class FakeSyncApi : SyncApi {

    private val table = LinkedHashMap<String, LinkedHashMap<String, JsonObject>>()
    private var rev = 0L
    val pushBodies = ArrayList<String>()

    fun rows(name: String): Map<String, JsonObject> = table[name].orEmpty()

    override fun push(batch: SyncBatch): PushResponse {
        val wire = Json.write(batch.toJson())
        pushBodies += wire
        val parsed = SyncBatch.fromJson(Json.parse(wire) as JsonObject)
        val accepted = LinkedHashMap<String, Int>()
        SyncTables.ALL.forEach { name ->
            val rows = linkedMapOf<String, JsonObject>()
            parsed.rows(name).forEach { row ->
                val id = row["id"]?.toString() ?: return@forEach
                rows[id] = row + ("rev" to (++rev))
            }
            if (rows.isNotEmpty()) {
                table.getOrPut(name) { LinkedHashMap() }.putAll(rows)
                accepted[name] = rows.size
            }
        }
        return PushResponse(accepted, rev)
    }

    override fun pull(since: Long): PullResponse {
        fun rowsOf(name: String) = table[name].orEmpty().values.filter { Merge.num(it["rev"]) > since }
        return PullResponse(
            batch = SyncBatch(
                rules = rowsOf(SyncTables.RULES),
                tasks = rowsOf(SyncTables.TASKS),
                memos = rowsOf(SyncTables.MEMOS),
                reminders = rowsOf(SyncTables.REMINDERS),
                completions = rowsOf(SyncTables.COMPLETIONS),
            ),
            maxRev = rev,
            hasMore = false,
        )
    }
}
