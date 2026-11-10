package app.took.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 配置页类型导航 + 置顶排序的纯逻辑（用户 2026-10-25 截图需求）。
 *
 * 这里断言的是 Compose 侧真正会调用的那两个函数：
 *  - 「点某一类只显示该类」= [ConfigListLogic.memosOf]；
 *  - 「置顶后排到最前」= [ConfigListLogic.pinFirst] + [ConfigListLogic.togglePin]。
 * 所以单测跑通即代表界面上的过滤与排序口径，不需要模拟器。
 */
class ConfigListLogicTest {

    private fun memo(id: String, kind: Int, title: String) = MemoRow(
        id = id,
        kind = kind,
        title = title,
        content = null,
        startDate = null,
        endDate = null,
        category = null,
    )

    /** 三类各两条 + 一条已软删的（listMemos 已经滤过，这里模拟它只返回未删行）。 */
    private val memos = listOf(
        memo("n1", MemoKind.NOTE, "记事一"),
        memo("n2", MemoKind.NOTE, "记事二"),
        memo("c1", MemoKind.COUNTDOWN, "生日"),
        memo("c2", MemoKind.COUNTDOWN, "纪念日"),
        memo("b1", MemoKind.NOTEBOOK, "周报"),
        memo("b2", MemoKind.NOTEBOOK, "方案"),
    )

    /* --------------------------- 1. 按类型过滤列表 --------------------------- */

    @Test
    fun memosOfKeepsOnlyTheSelectedKind() {
        val notes = ConfigListLogic.memosOf(memos, ConfigCategory.NOTE)
        assertEquals(listOf("n1", "n2"), notes.map { it.id })
        assertTrue("记事里不该混进倒数日或笔记本", notes.all { it.kind == MemoKind.NOTE })

        assertEquals(listOf("c1", "c2"), ConfigListLogic.memosOf(memos, ConfigCategory.COUNTDOWN).map { it.id })
        assertEquals(listOf("b1", "b2"), ConfigListLogic.memosOf(memos, ConfigCategory.NOTEBOOK).map { it.id })
    }

    @Test
    fun memosOfRuleCategoryIsEmpty() {
        // 规则类的行不在 memo 里：点「规则」时这里必须是空，而不是把三类 memo 也带上
        assertEquals(emptyList<MemoRow>(), ConfigListLogic.memosOf(memos, ConfigCategory.RULE))
    }

    @Test
    fun countsMatchEachCategorySize() {
        val counts = ConfigListLogic.counts(ruleCount = 4, memos = memos)
        assertEquals(4, counts[ConfigCategory.RULE])
        assertEquals(2, counts[ConfigCategory.NOTE])
        assertEquals(2, counts[ConfigCategory.COUNTDOWN])
        assertEquals(2, counts[ConfigCategory.NOTEBOOK])
    }

    @Test
    fun emptyCategoryCountsAsZero() {
        // 空类别要显示「记事 0」而不是不显示这一类
        val counts = ConfigListLogic.counts(ruleCount = 4, memos = emptyList())
        assertEquals(ConfigCategory.ALL, counts.keys.toList().sortedBy { ConfigCategory.ALL.indexOf(it) })
        assertEquals(0, counts[ConfigCategory.NOTE])
        assertEquals("记事 0", ConfigCategory.tabText(ConfigCategory.NOTE, 0))
        assertEquals("规则 4", ConfigCategory.tabText(ConfigCategory.RULE, 4))
    }

    /* ----------------------------- 2. 置顶后排序 ----------------------------- */

    @Test
    fun pinFirstMovesPinnedRowToHead() {
        val ordered = ConfigListLogic.pinFirst(memos, listOf("c2")) { it.id }
        assertEquals("c2", ordered.first().id)
        // 其余保持原相对顺序（稳定排序，未置顶的行不许被重排）
        assertEquals(listOf("n1", "n2", "c1", "b1", "b2"), ordered.drop(1).map { it.id })
    }

    @Test
    fun newestPinGoesFirst() {
        // 先置顶 c1，再置顶 b1：最后置顶的在最前，之前置顶的紧随其后
        var pinned = ConfigListLogic.togglePin(emptyList(), "c1")
        pinned = ConfigListLogic.togglePin(pinned, "b1")
        val ordered = ConfigListLogic.pinFirst(memos, pinned) { it.id }
        assertEquals(listOf("b1", "c1"), ordered.take(2).map { it.id })
        assertEquals(memos.size, ordered.size)
    }

    @Test
    fun pinningTwiceCancelsIt() {
        val once = ConfigListLogic.togglePin(emptyList(), "n2")
        assertEquals(listOf("n2"), once)
        val twice = ConfigListLogic.togglePin(once, "n2")
        assertEquals("再点一次 = 取消置顶，列表回到原顺序", emptyList<String>(), twice)
        assertEquals(memos.map { it.id }, ConfigListLogic.pinFirst(memos, twice) { it.id }.map { it.id })
    }

    @Test
    fun pinnedIdsOfDeletedRowsDoNotOccupyPlaces() {
        // 置顶过的行被删了：它不能占位，也不能让列表变短
        val ordered = ConfigListLogic.pinFirst(memos, listOf("gone", "n2")) { it.id }
        assertEquals("n2", ordered.first().id)
        assertEquals(memos.size, ordered.size)
        assertEquals(emptyList<String>(), ordered.map { it.id }.filter { it == "gone" })
    }

    @Test
    fun pinFirstWithoutPinsIsIdentity() {
        val same = ConfigListLogic.pinFirst(memos, emptyList<String>()) { row: MemoRow -> row.id }
        assertEquals(memos, same)
        val none = ConfigListLogic.pinFirst(emptyList<MemoRow>(), listOf("n1")) { row: MemoRow -> row.id }
        assertEquals(emptyList<MemoRow>(), none)
    }

    /* --------------------- 3. 类型与标题的口径（导航文案） --------------------- */

    @Test
    fun categoryLabelsAndMemoKindsLineUp() {
        assertEquals("规则", ConfigCategory.label(ConfigCategory.RULE))
        assertEquals("记事", ConfigCategory.label(ConfigCategory.NOTE))
        assertEquals("倒数日", ConfigCategory.label(ConfigCategory.COUNTDOWN))
        assertEquals("笔记本", ConfigCategory.label(ConfigCategory.NOTEBOOK))
        assertEquals(null, ConfigCategory.memoKindOf(ConfigCategory.RULE))
        assertEquals(MemoKind.NOTE, ConfigCategory.memoKindOf(ConfigCategory.NOTE))
        assertEquals(MemoKind.COUNTDOWN, ConfigCategory.memoKindOf(ConfigCategory.COUNTDOWN))
        assertEquals(MemoKind.NOTEBOOK, ConfigCategory.memoKindOf(ConfigCategory.NOTEBOOK))
        // 导航文案与 MemoKind.label 必须一致，否则「记事」和「记事」两处会走样
        MemoKind.ALL.forEach { kind ->
            val nav = ConfigCategory.ALL.first { ConfigCategory.memoKindOf(it) == kind }
            assertEquals(MemoKind.label(kind), ConfigCategory.label(nav))
        }
    }
}
