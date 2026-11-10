package app.took.sync

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** 契约 §7.2：四张表一律 LWW by updated_at；相等比 rev；再相等保留本地。 */
class ArbiterTest {

    @Test
    fun remoteWinsWhenUpdatedAtNewer() {
        assertTrue(Arbiter.remoteWins(localUpdatedAt = 1000, localRev = 9, remoteUpdatedAt = 2000, remoteRev = 1))
    }

    @Test
    fun localWinsWhenUpdatedAtNewer() {
        assertFalse(Arbiter.remoteWins(localUpdatedAt = 3000, localRev = 1, remoteUpdatedAt = 2000, remoteRev = 99))
    }

    @Test
    fun tieOnUpdatedAtFallsBackToRev() {
        assertTrue(Arbiter.remoteWins(1000, 3, 1000, 4))
        assertFalse(Arbiter.remoteWins(1000, 4, 1000, 3))
    }

    @Test
    fun tieOnBothKeepsLocalForIdempotency() {
        assertFalse(Arbiter.remoteWins(1000, 7, 1000, 7))
    }

    /**
     * 打卡库最容易被写错的一条：远端 status=1 但时间更旧，必须让本地的 status=0 赢。
     * 即「取消打卡」不能被旧记录复活 —— 所以 completion 不许用 max(status)。
     */
    @Test
    fun olderDoneDoesNotUndoNewerCancellation() {
        val localCancelled = linkedMapOf<String, Any?>("status" to 0L, "updated_at" to 5000L, "rev" to 2L)
        val remoteOldDone = linkedMapOf<String, Any?>("status" to 1L, "updated_at" to 1000L, "rev" to 8L)
        assertFalse(Merge.remoteWins(localCancelled, remoteOldDone))
        assertTrue("反过来，新的完成必须覆盖旧的未完成", Merge.remoteWins(remoteOldDone, localCancelled))
    }

    @Test
    fun missingLocalRowAlwaysAcceptsRemote() {
        assertTrue(Merge.remoteWins(null, linkedMapOf("updated_at" to 0L)))
    }
}
