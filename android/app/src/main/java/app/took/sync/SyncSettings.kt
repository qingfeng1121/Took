package app.took.sync

import android.content.Context

/**
 * 同步配置与客户端状态，落在 SharedPreferences（契约 §7.4：本地存 lastPulledRev 与错误信息）。
 * 服务地址默认 http://127.0.0.1:8420，与后端 -addr 的默认值一致。
 */
class SyncSettings(context: Context) {

    private val prefs = context.applicationContext.getSharedPreferences(FILE, Context.MODE_PRIVATE)

    var baseUrl: String
        get() = prefs.getString(KEY_BASE_URL, null) ?: DEFAULT_BASE_URL
        set(value) {
            prefs.edit().putString(KEY_BASE_URL, normalize(value)).apply()
        }

    var lastPulledRev: Long
        get() = prefs.getLong(KEY_REV, 0L)
        set(value) {
            prefs.edit().putLong(KEY_REV, value).apply()
        }

    /** 上次成功同步的时刻（毫秒），0 表示从未同步。 */
    var lastSyncAt: Long
        get() = prefs.getLong(KEY_LAST_SYNC, 0L)
        set(value) {
            prefs.edit().putLong(KEY_LAST_SYNC, value).apply()
        }

    /** 最近一次失败原因，成功时清空。 */
    var lastError: String?
        get() = prefs.getString(KEY_ERROR, null)
        set(value) {
            prefs.edit().putString(KEY_ERROR, value).apply()
        }

    companion object {
        const val DEFAULT_BASE_URL = "http://127.0.0.1:8420"
        private const val FILE = "took_sync"
        private const val KEY_BASE_URL = "base_url"
        private const val KEY_REV = "last_pulled_rev"
        private const val KEY_LAST_SYNC = "last_sync_at"
        private const val KEY_ERROR = "last_error"

        /** 空串回落到默认地址；去掉尾斜杠，避免拼出 //api/sync/push。 */
        fun normalize(raw: String): String {
            val t = raw.trim()
            if (t.isEmpty()) return DEFAULT_BASE_URL
            return t.trimEnd('/')
        }
    }
}
