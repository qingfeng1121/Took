package app.took.sync

/**
 * pull 落库前的仲裁判定，纯函数、行级、表无关。
 *
 * 与 SqliteSyncStore 共用同一份实现，所以单测用内存库跑出来的结论
 * 就是真机上 SQLite 会走的那条判断（不是「测试里另写一套」）。
 */
object Merge {

    /** true = 远端这一行覆盖本地；本地没有该行时本来就是插入。 */
    fun remoteWins(local: JsonObject?, remote: JsonObject): Boolean {
        if (local == null) return true
        return Arbiter.remoteWins(
            localUpdatedAt = num(local["updated_at"]),
            localRev = num(local["rev"]),
            remoteUpdatedAt = num(remote["updated_at"]),
            remoteRev = num(remote["rev"]),
        )
    }

    fun num(v: Any?): Long = (v as? Number)?.toLong() ?: 0L
}
