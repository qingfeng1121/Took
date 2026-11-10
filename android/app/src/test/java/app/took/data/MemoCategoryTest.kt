package app.took.data

import app.took.ui.MemoFormats
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 笔记本分类管理（定稿 §10.2 / 用户 2026-10-25 要求）：
 * **改名 = 批量原地更新所有该分类的 memo.category**、**删除分类 = 改为「未分类」而不是删笔记本**。
 *
 * 分类不是一张表，只是 memo.category 的一个取值，所以这两件事都必须：
 *  1. 只动 category / updated_at / dirty 三列，id、正文、rev、deleted 一条不动；
 *  2. 影响的条数可数且与确认文案一致（「该分类下有 N 条笔记」）。
 */
class MemoCategoryTest {

    private class MemoryMemoStore : MemoStore {
        val rows = LinkedHashMap<String, MemoRow>()
        override fun memo(id: String): MemoRow? = rows[id]
        override fun memos(): List<MemoRow> = rows.values.toList()
        override fun putMemo(memo: MemoRow) {
            rows[memo.id] = memo
        }
    }

    private var now = 1_700_000_000_000L
    private var seq = 0

    private fun service(store: MemoryMemoStore) = MemoEditService(
        store = store,
        clock = { now },
        idGen = { "m_gen" + (++seq) },
    )

    /** 三条「工作」+ 一条「生活」+ 一条未分类（分类留空）+ 一条记事（不该被分类管理碰到）。 */
    private fun seed(svc: MemoEditService) {
        svc.createMemo(MemoDraft(id = "b1", kind = MemoKind.NOTEBOOK, title = "周报", content = "一", category = "工作"))
        svc.createMemo(MemoDraft(id = "b2", kind = MemoKind.NOTEBOOK, title = "方案", content = "二", category = "工作"))
        svc.createMemo(MemoDraft(id = "b3", kind = MemoKind.NOTEBOOK, title = "复盘", content = "三", category = "工作"))
        svc.createMemo(MemoDraft(id = "b4", kind = MemoKind.NOTEBOOK, title = "菜谱", content = "四", category = "生活"))
        svc.createMemo(MemoDraft(id = "b5", kind = MemoKind.NOTEBOOK, title = "随手", content = "五", category = ""))
        svc.createMemo(MemoDraft(id = "n1", kind = MemoKind.NOTE, title = "记事", startDate = "2026-10-20"))
    }

    /* ------------------------------ 分类现状 ------------------------------ */

    @Test
    fun categoryStatsCountsAliveNotebooksOnly() {
        val store = MemoryMemoStore()
        val svc = service(store)
        seed(svc)

        val stats = svc.categories()
        assertEquals("未分类固定在最前", MemoKind.CATEGORY_NONE, stats.first().name)
        assertEquals(1, stats.first().count)
        assertEquals(listOf("工作" to 3, "生活" to 1), stats.drop(1).map { it.name to it.count })
        assertEquals("记事不进分类统计", 5, stats.sumOf { it.count })
    }

    @Test
    fun categoryCountFeedsTheConfirmCopy() {
        val store = MemoryMemoStore()
        val svc = service(store)
        seed(svc)

        assertEquals("改名前的影响条数", 3, svc.categoryCount("工作"))
        assertEquals(1, svc.categoryCount(MemoKind.CATEGORY_NONE))
        assertEquals("不存在的分类是 0 条", 0, svc.categoryCount("不存在"))
    }

    /* ------------------------------ 改名 ------------------------------ */

    /** 改名 = 批量原地更新：三条「工作」全部变成「项目」，id / 正文 / rev 一条不动，也不新增行。 */
    @Test
    fun renameUpdatesEveryNotebookInThatCategory() {
        val store = MemoryMemoStore()
        val svc = service(store)
        seed(svc)
        val before = store.rows.mapValues { it.value.copy() }
        now += 60_000

        val outcome = svc.renameCategory("工作", "项目")

        assertTrue(outcome is CategoryOutcome.Renamed)
        assertEquals(3, (outcome as CategoryOutcome.Renamed).affected)
        assertEquals("工作", outcome.from)
        assertEquals("项目", outcome.to)

        listOf("b1", "b2", "b3").forEach { id ->
            val row = store.memo(id)!!
            assertEquals("$id 分类已改", "项目", row.category)
            assertEquals("$id 正文不动", before[id]!!.content, row.content)
            assertEquals("$id 标题不动", before[id]!!.title, row.title)
            assertEquals("$id rev 不动", before[id]!!.rev, row.rev)
            assertEquals("$id 未删", 0, row.deleted)
            assertEquals("$id dirty=1", 1, row.dirty)
            assertTrue("$id updated_at 变大（LWW 靠它）", row.updatedAt > before[id]!!.updatedAt)
        }
        assertEquals("其它分类一条不动", "生活", store.memo("b4")!!.category)
        assertEquals("未分类仍是未分类", MemoKind.CATEGORY_NONE, store.memo("b5")!!.category)
        assertEquals("记事不参与分类改名", null, store.memo("n1")!!.category)
        assertEquals("原地改不新增行", before.size, store.rows.size)

        assertEquals("改名后旧分类消失", 0, svc.categoryCount("工作"))
        assertEquals(3, svc.categoryCount("项目"))
    }

    /** 改到已有分类名下 = 合并到那个分类（不新建第三个名字）。 */
    @Test
    fun renameIntoExistingCategoryMergesThem() {
        val store = MemoryMemoStore()
        val svc = service(store)
        seed(svc)

        svc.renameCategory("工作", "生活")

        assertEquals("合并后共 4 条", 4, svc.categoryCount("生活"))
        assertEquals(0, svc.categoryCount("工作"))
        assertEquals("只剩两个分类", listOf(MemoKind.CATEGORY_NONE, "生活"), svc.categories().map { it.name })
    }

    @Test
    fun renameToBlankFallsBackToUncategorized() {
        val store = MemoryMemoStore()
        val svc = service(store)
        seed(svc)

        val outcome = svc.renameCategory("工作", "   ")

        assertTrue(outcome is CategoryOutcome.Renamed)
        assertEquals(MemoKind.CATEGORY_NONE, (outcome as CategoryOutcome.Renamed).to)
        assertEquals("原有 1 条未分类 + 并入的 3 条", 4, svc.categoryCount(MemoKind.CATEGORY_NONE))
    }

    @Test
    fun renameRejectsInvalidTargets() {
        val store = MemoryMemoStore()
        val svc = service(store)
        seed(svc)
        val before = store.rows.mapValues { it.value }

        assertTrue("空名被拒", svc.renameCategory("  ", "新名") is CategoryOutcome.Rejected)
        assertTrue("未分类不能改名", svc.renameCategory(MemoKind.CATEGORY_NONE, "新名") is CategoryOutcome.Rejected)
        assertTrue("同名被拒", svc.renameCategory("工作", " 工作 ") is CategoryOutcome.Rejected)
        assertTrue("不存在的分类被拒", svc.renameCategory("不存在", "新名") is CategoryOutcome.Rejected)
        assertEquals("被拒后库一行没动", before.mapValues { it.value.category }, store.rows.mapValues { it.value.category })
    }

    /* ------------------------------ 删除分类 ------------------------------ */

    /** 删除分类：该分类下的笔记本**改为未分类**，笔记本一条都不删（deleted 仍为 0）。 */
    @Test
    fun deleteCategoryMovesNotebooksToUncategorizedInsteadOfDeleting() {
        val store = MemoryMemoStore()
        val svc = service(store)
        seed(svc)
        val before = store.rows.mapValues { it.value.copy() }
        now += 60_000

        val outcome = svc.deleteCategory("工作")

        assertTrue(outcome is CategoryOutcome.Deleted)
        assertEquals(3, (outcome as CategoryOutcome.Deleted).affected)
        assertEquals("工作", outcome.name)

        listOf("b1", "b2", "b3").forEach { id ->
            val row = store.memo(id)!!
            assertEquals("$id 改为未分类", MemoKind.CATEGORY_NONE, row.category)
            assertEquals("$id 没有被删", 0, row.deleted)
            assertEquals("$id 正文保留", before[id]!!.content, row.content)
            assertEquals("$id 标题保留", before[id]!!.title, row.title)
            assertEquals("$id dirty=1", 1, row.dirty)
        }
        assertEquals("没有物理删除", before.size, store.rows.size)
        assertEquals("全部笔记本仍在列表里", 5, svc.listMemos(MemoKind.NOTEBOOK).size)
        assertEquals("未分类条数 = 原有 1 + 并入 3", 4, svc.categoryCount(MemoKind.CATEGORY_NONE))
        assertEquals("该分类消失", 0, svc.categoryCount("工作"))
        assertTrue("分类列表里没有它了", svc.categories().none { it.name == "工作" })
    }

    @Test
    fun deleteCategoryRejectsInvalidTargets() {
        val store = MemoryMemoStore()
        val svc = service(store)
        seed(svc)

        assertTrue("空名被拒", svc.deleteCategory(" ") is CategoryOutcome.Rejected)
        assertTrue("未分类不能删", svc.deleteCategory(MemoKind.CATEGORY_NONE) is CategoryOutcome.Rejected)
        assertTrue("不存在的分类被拒", svc.deleteCategory("不存在") is CategoryOutcome.Rejected)
        assertEquals("被拒后「工作」仍是 3 条", 3, svc.categoryCount("工作"))
    }

    /* ------------------------------ 与月历的关系 ------------------------------ */

    /** 分类改名/删除只是笔记本的事：记事与月历命中完全不受影响。 */
    @Test
    fun categoryOperationsDoNotTouchNotesOrCalendar() {
        val store = MemoryMemoStore()
        val svc = service(store)
        seed(svc)
        val noteBefore = store.memo("n1")!!

        svc.renameCategory("工作", "项目")
        svc.deleteCategory("项目")

        val noteAfter = store.memo("n1")!!
        assertEquals("记事分类仍为空", noteBefore.category, noteAfter.category)
        assertEquals("记事日期不动", noteBefore.startDate, noteAfter.startDate)
        assertEquals("记事未变 dirty 状态", noteBefore.dirty, noteAfter.dirty)
        assertTrue(
            "记事仍然在 2026-10-20 命中",
            MonthExpander.memosOn("2026-10-20", listOf(noteAfter)).isNotEmpty(),
        )
        assertEquals("笔记本永不进月历", 0, MonthExpander.memosOn("2026-10-20", svc.listMemos(MemoKind.NOTEBOOK)).size)
    }

    /* ------------------------------ 倒数日卡片数据源 ------------------------------ */

    /**
     * 首页倒数日卡片的排序口径（§6.5）：未来的排前面（目标日升序，最近的先到），
     * 过去的排后面（离今天最近的先出现）。只按日期字符串比会把 2025 的纪念日排到 2027 的生日前面。
     */
    @Test
    fun countdownOrderPutsUpcomingFirst() {
        val today = "2026-10-25"
        val rows = listOf(
            MemoRow("past_far", MemoKind.COUNTDOWN, "很久以前", null, "2025-10-19", null, null),
            MemoRow("future_far", MemoKind.COUNTDOWN, "生日", null, "2027-03-15", null, null),
            MemoRow("soon", MemoKind.COUNTDOWN, "考试", null, "2026-11-01", null, null),
            MemoRow("past_near", MemoKind.COUNTDOWN, "上周", null, "2026-10-20", null, null),
            MemoRow("broken", MemoKind.COUNTDOWN, "脏数据", null, "2026-1-5", null, null),
            MemoRow("noTarget", MemoKind.COUNTDOWN, "没填目标日", null, null, null, null),
        )
        val ordered = MemoEditPolicy.countdownOrder(rows, today)
        assertEquals(
            "未来升序 → 过去降序 → 解析不了的最后（两条脏数据按标题排）",
            listOf("soon", "future_far", "past_near", "past_far", "noTarget", "broken"),
            ordered.map { it.id },
        )
    }

    /** 同一天：即使全是过去的，也必须按「离今天最近」排，而不是按年份从早到晚。 */
    @Test
    fun countdownOrderNeverSortsPastByAscendingDate() {
        val rows = listOf(
            MemoRow("y2024", MemoKind.COUNTDOWN, "两年前", null, "2024-01-01", null, null),
            MemoRow("y2026", MemoKind.COUNTDOWN, "今年初", null, "2026-01-01", null, null),
            MemoRow("y2025", MemoKind.COUNTDOWN, "去年", null, "2025-01-01", null, null),
        )
        assertEquals(
            listOf("y2026", "y2025", "y2024"),
            MemoEditPolicy.countdownOrder(rows, "2026-10-25").map { it.id },
        )
    }

    /** 卡片上的天数文案与方向（§6.5）：未来「还有」、当天「就是今天」、过去「已经」。 */
    @Test
    fun countdownCardLabelsMatchTheSpecTable() {
        assertEquals("还有 152 天", MemoFormats.countdown("2027-03-15", "2026-10-14"))
        assertEquals("就是今天", MemoFormats.countdown("2026-10-25", "2026-10-25"))
        assertEquals("已经 365 天", MemoFormats.countdown("2025-10-19", "2026-10-19"))
        assertEquals("没有目标日", MemoFormats.countdown("", "2026-10-19"))
    }

    @Test
    fun countdownCardTitleAndTargetAreRealColumns() {
        val store = MemoryMemoStore()
        val svc = service(store)
        svc.createMemo(MemoDraft(id = "cd", kind = MemoKind.COUNTDOWN, title = "纪念日", startDate = "2025-10-19", content = "第七年"))

        val row = svc.memo("cd")!!
        assertEquals("标题来自 title", "纪念日", row.title)
        assertEquals("目标日来自 start_date", "2025-10-19", row.startDate)
        assertEquals("备注在 content", "第七年", row.content)
        assertNull("倒数日没有分类", row.category)
        assertEquals(MemoKind.COUNTDOWN, row.kind)
    }
}
