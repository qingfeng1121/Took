package app.took.sync

/**
 * 冲突仲裁（契约 §7.2）：rule / task / memo / completion **一律** LWW by updated_at。
 *
 * 为什么不给 completion 用「取 status 最大值」：打卡可撤销，max(status) 会让
 * 「取消打卡」永远同步不到另一端，那端永远显示已完成。这里只有一条规则，
 * 表无关，也就没有「这张表特殊」的口子可开。
 *
 * 相同 updated_at 比 rev；再相同保留本地（即远端不覆盖），保证重复 pull 幂等。
 */
object Arbiter {

    fun remoteWins(localUpdatedAt: Long, localRev: Long, remoteUpdatedAt: Long, remoteRev: Long): Boolean {
        if (remoteUpdatedAt != localUpdatedAt) return remoteUpdatedAt > localUpdatedAt
        if (remoteRev != localRev) return remoteRev > localRev
        return false
    }
}
