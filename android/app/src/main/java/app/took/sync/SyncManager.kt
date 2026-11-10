package app.took.sync

/**
 * 同步客户端（契约 §7）：push 本地 dirty=1 → 成功后清 dirty → pull since=lastPulledRev
 * → 按 §7.2 仲裁落库 → 推进游标。
 *
 * 失败语义（§7.4）：**不回滚**。push 失败只意味着 dirty 还在，下次重试；
 * pull 失败只意味着游标没动，本地渲染继续用旧数据。网络失败不是错误，是稍后再试。
 */
class SyncManager(private val store: SyncStore, private val api: SyncApi) {

    fun syncOnce(): SyncOutcome {
        val dirty = store.dirtyRows()
        var pushed = 0
        if (dirty.total > 0) {
            try {
                api.push(dirty)
            } catch (e: Exception) {
                return SyncOutcome(false, 0, 0, store.lastPulledRev(), describe(e))
            }
            // 服务端已接收 → 才允许清 dirty；响应里的 accepted 是计数，逐条回执协议里没有
            store.markClean(dirty)
            pushed = dirty.total
        }

        var since = store.lastPulledRev()
        var pulled = 0
        var page = 0
        while (page < MAX_PULL_PAGES) {
            val resp = try {
                api.pull(since)
            } catch (e: Exception) {
                return SyncOutcome(false, pushed, pulled, store.lastPulledRev(), describe(e))
            }
            pulled += store.applyPulled(resp.batch)
            if (resp.maxRev > since) since = resp.maxRev
            store.setLastPulledRev(since)
            if (!resp.hasMore) break
            page++
        }
        return SyncOutcome(true, pushed, pulled, since)
    }

    private fun describe(e: Exception): String =
        e.message?.takeIf { it.isNotBlank() } ?: e.javaClass.simpleName

    companion object {
        /** hasMore=true 时的翻页上限，防止服务端游标异常导致死循环。 */
        const val MAX_PULL_PAGES = 20
    }
}
