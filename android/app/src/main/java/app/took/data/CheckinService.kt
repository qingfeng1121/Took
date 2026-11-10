package app.took.data

/**
 * 打卡写路径的纯逻辑（契约 §3.3 + §7.2）。
 *
 * 三条硬约束：
 *  1. 键是 (task_id, period_start)，不是「某一天」—— 同一周期内所有命中日共享同一状态；
 *  2. 取消打卡写 status=0 而不是删行 —— 否则同一周期在另一端会「复活」，
 *     且 §7.2 明确禁止用 max(status) 仲裁，撤销必须靠 updated_at 传过去；
 *  3. 任何本地写都置 dirty=1（§7.4），推送成功后才由 SyncManager 清零。
 */
data class CompletionRecord(
    val taskId: String,
    val periodStart: String,
    val status: Int,
    val updatedAt: Long,
    val rev: Long = 0,
    val deleted: Int = 0,
    val dirty: Int = 1,
)

/** 存储端口，Android 侧由 SQLiteOpenHelper 实现，单测用内存实现。 */
interface CompletionDao {
    fun find(taskId: String, periodStart: String): CompletionRecord?
    fun save(record: CompletionRecord)
}

class CheckinService(
    private val dao: CompletionDao,
    private val clock: () -> Long = System::currentTimeMillis,
) {

    fun isDone(taskId: String, periodStart: String): Boolean {
        val cur = dao.find(taskId, periodStart) ?: return false
        return cur.deleted == 0 && cur.status == 1
    }

    /** 写入指定状态，返回落库后的记录。 */
    fun setDone(taskId: String, periodStart: String, done: Boolean): CompletionRecord {
        val cur = dao.find(taskId, periodStart)
        val rec = CompletionRecord(
            taskId = taskId,
            periodStart = periodStart,
            status = if (done) 1 else 0,
            updatedAt = clock(),
            rev = cur?.rev ?: 0,
            deleted = 0,
            dirty = 1,
        )
        dao.save(rec)
        return rec
    }

    /** 切换：已完成 → 取消，未完成 → 完成。返回切换后的记录。 */
    fun toggle(taskId: String, periodStart: String): CompletionRecord =
        setDone(taskId, periodStart, !isDone(taskId, periodStart))
}
