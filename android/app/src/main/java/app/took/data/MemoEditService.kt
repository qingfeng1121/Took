package app.took.data

import java.util.UUID

/**
 * memo 写路径的结果。与 EditOutcome 分开是因为规则那边要表达「裂开」，
 * 而 memo 没有历史保护问题——任何字段都可原地改（契约 §10 开头）。
 */
/**
 * 分类批量操作的结果。改名与删除都只动 category 一列，所以要带回影响的条数：
 * 二次确认文案里的「该分类下有 N 条笔记」与实际执行的条数必须来自同一份计算。
 */
sealed interface CategoryOutcome {
    data class Renamed(val from: String, val to: String, val affected: Int) : CategoryOutcome
    data class Deleted(val name: String, val affected: Int) : CategoryOutcome
    data class Rejected(val reason: String) : CategoryOutcome
}

sealed interface MemoOutcome {
    /** 已落库。新建时 memoId 是客户端生成的 id。 */
    data class Saved(val memoId: String) : MemoOutcome
    data class Invalid(val errors: List<String>) : MemoOutcome
    data class Rejected(val reason: String) : MemoOutcome
    data class Deleted(val memoId: String, val kind: Int) : MemoOutcome
}

/**
 * 契约 §10 的 memo 写路径：新建 / 原地改 / 软删 / 列表。
 *
 * 全部写库动作统一（§10.2）：updated_at = now、dirty = 1、rev 保持、
 * 删除一律软删 deleted = 1（绝不物理 DELETE，否则会被另一端同步回来复活）。
 *
 * 校验的唯一入口是 MemoEditPolicy.validate，本类不重复判断字段——
 * 单测（M1~M6）用内存 MemoStore 就能覆盖，不需要模拟器。
 */
class MemoEditService(
    private val store: MemoStore,
    private val clock: () -> Long = System::currentTimeMillis,
    private val idGen: () -> String = { "m_" + UUID.randomUUID().toString().replace("-", "").take(16) },
) {

    /** 契约 §10.1 的列表：只返回未删的行；kind 为空 = 三类全要。 */
    fun listMemos(kind: Int? = null): List<MemoRow> {
        val alive = store.memos().filter { it.deleted == 0 }
        val rows = if (kind == null) alive else alive.filter { it.kind == kind }
        return rows.sortedWith(compareBy({ it.kind }, { it.updatedAt }, { it.id }))
    }

    /** 编辑页按 id 取一行：已软删的当作不存在（列表里也看不到它）。 */
    fun memo(id: String): MemoRow? = store.memo(id)?.takeIf { it.deleted == 0 }

    /** 新建（§10.1 + §10.2）：客户端生成 id，落库即 dirty=1。 */
    fun createMemo(draft: MemoDraft): MemoOutcome {
        val errors = MemoEditPolicy.validate(draft)
        if (errors.isNotEmpty()) return MemoOutcome.Invalid(errors)
        val id = draft.id.trim().ifEmpty { idGen() }
        // 同 id 的行（含墓碑）已存在时拒绝：REPLACE 会把别人的记录整行覆盖掉
        if (store.memo(id) != null) return MemoOutcome.Rejected("memo id 已存在：" + id)
        store.putMemo(MemoEditPolicy.toRow(draft, id = id, now = clock(), rev = 0))
        return MemoOutcome.Saved(id)
    }

    /** 修改（§10.2）：记事改日期区间、笔记本改分类都是原地改；rev 保持不动。 */
    fun updateMemo(draft: MemoDraft): MemoOutcome {
        val id = draft.id.trim()
        if (id.isEmpty()) return MemoOutcome.Rejected("修改 memo 需要 id")
        val old = store.memo(id) ?: return MemoOutcome.Rejected("memo 不存在：" + id)
        if (old.deleted != 0) return MemoOutcome.Rejected("memo 已删除：" + id)
        val errors = MemoEditPolicy.validate(draft)
        if (errors.isNotEmpty()) return MemoOutcome.Invalid(errors)
        // 用 old.copy 而不是重建整行：rev 保持库里原值，deleted 不动
        val fresh = MemoEditPolicy.toRow(draft, id = id, now = clock(), rev = old.rev)
        store.putMemo(
            old.copy(
                title = fresh.title,
                content = fresh.content,
                startDate = fresh.startDate,
                endDate = fresh.endDate,
                category = fresh.category,
                updatedAt = fresh.updatedAt,
                dirty = 1,
            ),
        )
        return MemoOutcome.Saved(id)
    }

    /* --------------------- 笔记本分类管理（改名 / 删除） --------------------- */

    /** 当前分类现状：未分类固定在最前，其余按条数降序（数的是未删的笔记本）。 */
    fun categories(): List<CategoryStat> = MemoEditPolicy.categoryStats(store.memos())

    /** 该分类下有多少条未删的笔记本 —— 二次确认文案里的 N 就是它。 */
    fun categoryCount(name: String): Int = categories().firstOrNull { it.name == name }?.count ?: 0

    /**
     * 分类改名：**批量原地改该分类下所有笔记本的 category**，id / rev / 笔记正文一律不动。
     *
     * 分类是 memo 的字段而不是一张表，所以改名 = 对该分类的每一行执行一次「原地改 + dirty=1」，
     * 与 updateMemo 同一条写库口径（§10.2）：绝不新增行、绝不改 id、绝不物理删。
     * 目标名为空 / 未分类 → 等同于「全部归到未分类」，语义与删分类一致，但仍按改名处理。
     */
    fun renameCategory(from: String, to: String): CategoryOutcome {
        val oldName = from.trim()
        if (oldName.isEmpty()) return CategoryOutcome.Rejected("分类名不能为空")
        if (oldName == MemoKind.CATEGORY_NONE) {
            return CategoryOutcome.Rejected("「未分类」不是真正的分类，不能改名")
        }
        val newName = to.trim().ifEmpty { MemoKind.CATEGORY_NONE }
        if (newName == oldName) return CategoryOutcome.Rejected("新分类名与原分类名相同：$oldName")

        val targets = categoryRows(oldName)
        if (targets.isEmpty()) return CategoryOutcome.Rejected("分类不存在：" + oldName)

        val now = clock()
        targets.forEach { memo ->
            // 原地改：只动 category / updated_at / dirty，rev 与 id 保持库里原值
            store.putMemo(memo.copy(category = newName, updatedAt = now, dirty = 1))
        }
        return CategoryOutcome.Renamed(oldName, newName, targets.size)
    }

    /**
     * 删除分类：该分类下的笔记本**改为未分类**，笔记本本身一条都不删（不动 deleted）。
     *
     * 这是与「删除笔记本」最容易混淆的地方，所以只改 category 一列：
     * 标题、正文、id、rev 全部保留，月历与列表里的这条笔记仍在，只是分类回到「未分类」。
     */
    fun deleteCategory(name: String): CategoryOutcome {
        val target = name.trim()
        if (target.isEmpty()) return CategoryOutcome.Rejected("分类名不能为空")
        if (target == MemoKind.CATEGORY_NONE) {
            return CategoryOutcome.Rejected("「未分类」是兜底分类，不能删除")
        }
        val targets = categoryRows(target)
        if (targets.isEmpty()) return CategoryOutcome.Rejected("分类不存在：" + target)

        val now = clock()
        targets.forEach { memo ->
            store.putMemo(memo.copy(category = MemoKind.CATEGORY_NONE, updatedAt = now, dirty = 1))
        }
        return CategoryOutcome.Deleted(target, targets.size)
    }

    private fun categoryRows(name: String): List<MemoRow> = store.memos().filter {
        it.kind == MemoKind.NOTEBOOK && it.deleted == 0 && MemoEditPolicy.categoryNameOf(it) == name
    }

    /** 删除（§10.2）：软删 + 新 updated_at + dirty=1；不涉及打卡记录，无需提示历史保留。 */
    fun deleteMemo(id: String): MemoOutcome {
        val old = store.memo(id) ?: return MemoOutcome.Rejected("memo 不存在：" + id)
        if (old.deleted != 0) return MemoOutcome.Rejected("memo 已删除：" + id)
        store.putMemo(old.copy(deleted = 1, updatedAt = clock(), dirty = 1))
        return MemoOutcome.Deleted(id, old.kind)
    }
}
