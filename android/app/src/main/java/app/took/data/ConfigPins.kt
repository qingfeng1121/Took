package app.took.data

import android.content.Context

/**
 * 配置页「置顶」的存储端口：只在本机，不进库、不进同步。
 *
 * 为什么不做成 memo/rule 的新列：rule 与 memo 的 DDL 与同步 JSON 是三端同构的
 * （server/internal/store/schema.sql、docs/schema 下的 json、PC 端 Rust 结构体），
 * 在 Android 单边加一列会让 pull/push 多出一个别人不认识的字段。
 * 置顶是「这台设备上我怎么看这个列表」的偏好，与打卡事实无关，所以落 SharedPreferences。
 * 代价：换手机不同步置顶顺序（与 reminder_schedule 同一取舍）。
 */
interface PinStore {
    fun pinned(category: String): List<String>
    fun save(category: String, ids: List<String>)

    /** 单测 / 无 Context 场景：永远空、不落盘。 */
    object Empty : PinStore {
        override fun pinned(category: String): List<String> = emptyList()
        override fun save(category: String, ids: List<String>) = Unit
    }
}

/** SharedPreferences 实现：一个分类一条 "|" 分隔的 id 串。 */
class ConfigPins(context: Context) : PinStore {

    private val prefs = context.applicationContext.getSharedPreferences(FILE, Context.MODE_PRIVATE)

    /** 某一类的置顶 id 列表：第一个 = 最前。 */
    override fun pinned(category: String): List<String> =
        prefs.getString(KEY_PREFIX + category, null)
            ?.split(SEP)
            ?.filter { it.isNotBlank() }
            ?: emptyList()

    /** 写入新顺序；空列表 = 清掉这个 key（不留一堆分隔符进磁盘）。 */
    override fun save(category: String, ids: List<String>) {
        val clean = ids.filter { it.isNotBlank() }.distinct()
        if (clean.isEmpty()) {
            prefs.edit().remove(KEY_PREFIX + category).apply()
        } else {
            prefs.edit().putString(KEY_PREFIX + category, clean.joinToString(SEP)).apply()
        }
    }

    private companion object {
        const val FILE = "took_config_pins"
        const val KEY_PREFIX = "pinned_"
        const val SEP = "|"
    }
}
