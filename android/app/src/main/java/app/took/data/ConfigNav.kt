package app.took.data

/**
 * 配置页顶部「类型导航」的四类 + 纯逻辑（过滤 / 条数 / 置顶排序）。
 *
 * 为什么单独一个文件：这三件事必须能在 JVM 单测里断言（不需要模拟器、不需要 Android 依赖），
 * Compose 侧只做接线。MemoRow 本身是纯 data class，所以本文件不 import 任何 Android 类型。
 */
object ConfigCategory {
    const val RULE = "rule"
    const val NOTE = "note"
    const val COUNTDOWN = "countdown"
    const val NOTEBOOK = "notebook"

    val ALL = listOf(RULE, NOTE, COUNTDOWN, NOTEBOOK)

    fun label(id: String): String = when (id) {
        RULE -> "规则"
        NOTE -> "记事"
        COUNTDOWN -> "倒数日"
        NOTEBOOK -> "笔记本"
        else -> "未知分类 " + id
    }

    /** 导航项要显示的文案：类名 + 条数（空格分隔，空类也显示 0）。 */
    fun tabText(id: String, count: Int): String = label(id) + " " + count

    /** 该类对应的 memo.kind；规则没有 memo.kind（返回 null）。 */
    fun memoKindOf(id: String): Int? = when (id) {
        NOTE -> MemoKind.NOTE
        COUNTDOWN -> MemoKind.COUNTDOWN
        NOTEBOOK -> MemoKind.NOTEBOOK
        else -> null
    }

    /** 该类右上角新建按钮的文案；规则另有「＋ 新建规则」。 */
    fun newLabel(id: String): String = "＋ 新建" + label(id)
}

object ConfigListLogic {

    /** 四类各多少条：规则 + 三类 memo（memo 只数未删的，listMemos 已经过滤过）。 */
    fun counts(ruleCount: Int, memos: List<MemoRow>): Map<String, Int> = mapOf(
        ConfigCategory.RULE to ruleCount,
        ConfigCategory.NOTE to memos.count { it.kind == MemoKind.NOTE },
        ConfigCategory.COUNTDOWN to memos.count { it.kind == MemoKind.COUNTDOWN },
        ConfigCategory.NOTEBOOK to memos.count { it.kind == MemoKind.NOTEBOOK },
    )

    /**
     * 按类型过滤列表：点某一类，下面只留该类内容（用户原话「下方列表只显示该类内容」）。
     * 规则类的行不在这里，调用方直接从 loadRulesWithTasks() 拿；这里只处理三类 memo。
     */
    fun memosOf(memos: List<MemoRow>, category: String): List<MemoRow> {
        val kind = ConfigCategory.memoKindOf(category) ?: return emptyList()
        return memos.filter { it.kind == kind }
    }

    /**
     * 置顶排序：pinnedIds 里的排前面（顺序 = 置顶顺序，最后置顶的在最前），
     * 其余保持原有相对顺序（稳定排序，不重排未置顶的行）。
     *
     * pinnedIds 里可能有已经不存在的 id（被删掉了）：直接忽略，不占位。
     */
    fun <T> pinFirst(items: List<T>, pinnedIds: List<String>, idOf: (T) -> String): List<T> {
        if (pinnedIds.isEmpty() || items.isEmpty()) return items
        val byId = items.associateBy(idOf)
        val head = ArrayList<T>()
        val used = HashSet<String>()
        pinnedIds.forEach { id ->
            val row = byId[id] ?: return@forEach
            if (!used.add(id)) return@forEach
            head += row
        }
        val rest = items.filter { idOf(it) !in used }
        return head + rest
    }

    /**
     * 置顶/取消置顶后的新 pinnedIds。
     *
     * 置顶 = 把它挪到最前（再次点了别人也不会丢失之前的置顶顺序）；
     * 已置顶的再点一次 = 取消置顶（否则列表顺序会永久锁死，用户没有回头路）。
     */
    fun togglePin(pinnedIds: List<String>, id: String): List<String> =
        if (pinnedIds.contains(id)) pinnedIds.filter { it != id } else listOf(id) + pinnedIds
}
