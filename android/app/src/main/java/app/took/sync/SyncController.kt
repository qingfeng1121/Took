package app.took.sync

/**
 * 把 SyncManager 接到「当前配置」上：读地址 → 跑一次 → 记时间/错误。
 * 失败静默：界面只在设置页展示最近错误，不弹窗、不打断打卡。
 */
class SyncController(
    private val settings: SyncSettings,
    private val store: SyncStore,
    private val apiFactory: (String) -> SyncApi = { HttpSyncApi(it) },
) {

    fun runNow(): SyncOutcome {
        val outcome = try {
            SyncManager(store, apiFactory(settings.baseUrl)).syncOnce()
        } catch (e: Exception) {
            SyncOutcome(false, 0, 0, settings.lastPulledRev, e.message ?: e.javaClass.simpleName)
        }
        if (outcome.ok) {
            settings.lastSyncAt = System.currentTimeMillis()
            settings.lastError = null
        } else {
            settings.lastError = outcome.error
        }
        return outcome
    }

    fun dirtyCount(): Int = store.dirtyCount()

    fun baseUrl(): String = settings.baseUrl

    fun setBaseUrl(raw: String) {
        settings.baseUrl = raw
    }

    fun lastSyncAt(): Long = settings.lastSyncAt

    fun lastError(): String? = settings.lastError
}
