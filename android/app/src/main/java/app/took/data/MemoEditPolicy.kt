package app.took.data

import app.took.engine.DateKeys
import java.time.LocalDate

/**
 * 一个笔记本分类的现状：分类名 + 该分类下的笔记条数。
 *
 * 分类不是一个实体（没有分类表，§10.2），它只是 `memo.category` 的一个取值，
 * 所以「该分类下有 N 条笔记」必须每次从当前未删的笔记本数出来。
 */
data class CategoryStat(val name: String, val count: Int)

/** 契约 §10.1 的三类 memo。 */
object MemoKind {
    const val NOTE = 0
    const val COUNTDOWN = 1
    const val NOTEBOOK = 2
    val ALL = listOf(NOTE, COUNTDOWN, NOTEBOOK)

    /** 笔记本的缺省分类：分类名就存在 category 字段里，不单独建分类表（§10.2）。 */
    const val CATEGORY_NONE = "未分类"

    fun label(kind: Int): String = when (kind) {
        NOTE -> "记事"
        COUNTDOWN -> "倒数日"
        NOTEBOOK -> "笔记本"
        else -> "未知 memo 类型 $kind"
    }
}

/**
 * 契约 §10.1 / §10.2 的纯逻辑：写入层校验 + 读取层命中判定。
 *
 * 分层与 §3.4 一致：
 *  - 写入（validate）：格式不合法必须拒绝，绝不落库；
 *  - 读取（activeOn）：库里有脏数据也只是这一条不命中，绝不抛异常把月历整片打挂。
 */
object MemoEditPolicy {

    /** 契约 §10.1 的字段约束，返回错误列表（空 = 通过）。 */
    fun validate(draft: MemoDraft): List<String> {
        if (draft.kind !in MemoKind.ALL) {
            return listOf("memo.kind 必须是 0/1/2，实际 ${draft.kind}")
        }
        val errors = ArrayList<String>()
        val title = draft.title.trim()
        when (draft.kind) {
            MemoKind.NOTE -> {
                if (title.isEmpty()) errors += "记事标题不能为空"
                val start = dateOf(draft.startDate, "记事的开始日期", errors)
                val end = dateOf(draft.endDate, "记事的结束日期", errors)
                if (draft.startDate.isBlank() && draft.endDate.isNotBlank()) {
                    errors += "记事填了结束日期就必须同时填开始日期"
                }
                if (start != null && end != null && end.isBefore(start)) {
                    errors += "记事的结束日期不能早于开始日期：${draft.endDate} < ${draft.startDate}"
                }
            }
            MemoKind.COUNTDOWN -> {
                if (title.isEmpty()) errors += "倒数日标题不能为空"
                if (draft.startDate.isBlank()) {
                    errors += "倒数日必须填目标日"
                } else {
                    dateOf(draft.startDate, "倒数日的目标日", errors)
                }
                if (draft.endDate.isNotBlank()) errors += "倒数日没有结束日期"
            }
            else -> {
                if (title.isEmpty() && draft.content.trim().isEmpty()) {
                    errors += "笔记本标题与正文不能都为空"
                }
                if (draft.startDate.isNotBlank() || draft.endDate.isNotBlank()) {
                    errors += "笔记本没有日期，不会进月历"
                }
            }
        }
        return errors
    }

    /** 空串 = 这一栏不填（返回 null）；非空则严格校验，非法日期进 errors。 */
    private fun dateOf(raw: String, what: String, errors: MutableList<String>): LocalDate? {
        val t = raw.trim()
        if (t.isEmpty()) return null
        return runCatching { DateKeys.parse(t) }.getOrElse {
            errors += "$what 必须是 YYYY-MM-DD：\"$raw\""
            null
        }
    }

    /**
     * 记事是否命中某一天（契约 §10.1）：不排期 = 永不出现；只有 start = 单日；
     * start+end = 区间内每天。倒数日与笔记本永不进月历。
     */
    fun activeOn(memo: MemoRow, date: String): Boolean {
        if (memo.kind != MemoKind.NOTE || memo.deleted != 0) return false
        val startRaw = memo.startDate?.takeIf { it.isNotBlank() } ?: return false
        // 读取层：任何一侧解析失败都只让这一条不命中，不抛异常
        val day = runCatching { DateKeys.parse(date) }.getOrNull() ?: return false
        val start = runCatching { DateKeys.parse(startRaw) }.getOrNull() ?: return false
        val end = memo.endDate?.takeIf { it.isNotBlank() }
            ?.let { runCatching { DateKeys.parse(it) }.getOrNull() }
        if (end == null || end == start) return day == start
        return !day.isBefore(start) && !day.isAfter(end)
    }

    /**
     * 分类统计（笔记本分类管理用）：name → 条数，只数未删的笔记本。
     *
     * 分类就是 `memo.category` 字段（没有分类表，§10.2），所以「分类是否存在」等价于
     * 「有没有笔记用了这个名字」；空分类一律归到 [MemoKind.CATEGORY_NONE]。
     * 排序：未分类固定在最前，其余按条数降序、同条数按名字。
     */
    fun categoryStats(memos: List<MemoRow>): List<CategoryStat> =
        memos
            .filter { it.kind == MemoKind.NOTEBOOK && it.deleted == 0 }
            .groupingBy { categoryNameOf(it) }
            .eachCount()
            .map { (name, count) -> CategoryStat(name, count) }
            .sortedWith(compareBy({ it.name != MemoKind.CATEGORY_NONE }, { -it.count }, { it.name }))

    /**
     * 首页倒数日卡片的排序（定稿 §6.5）：**未来的排前面**（目标日升序，最近的先到），
     * 过去的排后面（目标日降序，离今天最近的那条先出现）。
     *
     * 只按日期字符串比是错的 —— 那样 2025 年的纪念日会排到 2027 年的生日前面。
     * 目标日解析不了的排到最后，绝不因为一行脏数据把整块卡片打挂（§3.4 读层分层）。
     */
    fun countdownOrder(memos: List<MemoRow>, today: String): List<MemoRow> {
        val now = runCatching { DateKeys.parse(today) }.getOrNull()
        fun delta(memo: MemoRow): Long? {
            val raw = memo.startDate?.trim()?.takeIf { it.isNotEmpty() } ?: return null
            val target = runCatching { DateKeys.parse(raw) }.getOrNull() ?: return null
            return if (now == null) null else DateKeys.daysBetween(now, target)
        }
        return memos.sortedWith(
            compareBy<MemoRow> { delta(it) == null }
                .thenBy { memo -> (delta(memo) ?: 0L) < 0 }        // 未来(false) 排在 过去(true) 之前
                .thenBy { memo -> val d = delta(memo) ?: 0L; if (d < 0) -d else d }
                .thenBy { it.title }
                .thenBy { it.id },
        )
    }

    /** 一行的分类名：空 / 全空白 → 未分类。 */
    fun categoryNameOf(memo: MemoRow): String =
        memo.category?.trim()?.takeIf { it.isNotEmpty() } ?: MemoKind.CATEGORY_NONE

    /** 分类归一（§10.1）：只有笔记本有分类，空则「未分类」；其余两类不发分类。 */
    fun categoryOf(draft: MemoDraft): String? {
        if (draft.kind != MemoKind.NOTEBOOK) return null
        val t = draft.category.trim()
        return if (t.isEmpty()) MemoKind.CATEGORY_NONE else t
    }

    /** 草稿 → 库行：与本类无关的字段一律 NULL，避免脏列混进同步。 */
    fun toRow(draft: MemoDraft, id: String, now: Long, rev: Long = 0): MemoRow = MemoRow(
        id = id,
        kind = draft.kind,
        title = draft.title.trim(),
        content = draft.content.takeIf { it.isNotBlank() },
        startDate = if (draft.kind == MemoKind.NOTEBOOK) null else draft.startDate.trim().takeIf { it.isNotBlank() },
        endDate = if (draft.kind == MemoKind.NOTE) draft.endDate.trim().takeIf { it.isNotBlank() } else null,
        category = categoryOf(draft),
        rev = rev,
        updatedAt = now,
        deleted = 0,
        dirty = 1,
    )
}
