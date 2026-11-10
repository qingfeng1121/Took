package app.took.data

import app.took.calendar.MonthGridLayout
import app.took.ui.MemoFormats
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 契约 §10.3 的 M1~M6：记事 / 倒数日 / 笔记本的写路径与月历命中。
 *
 * 库换成内存实现（[MemoStore] 端口），展开与命中判定走生产代码
 * [MonthExpander.memosOn] / [MemoEditPolicy.activeOn]，与真机同一条路径，不需要模拟器。
 */
class MemoEditServiceTest {

    private class MemoryMemoStore : MemoStore {
        val rows = LinkedHashMap<String, MemoRow>()
        override fun memo(id: String): MemoRow? = rows[id]
        override fun memos(): List<MemoRow> = rows.values.toList()
        override fun putMemo(memo: MemoRow) {
            rows[memo.id] = memo
        }

        fun alive(): List<MemoRow> = rows.values.filter { it.deleted == 0 }
    }

    private var now = 1_700_000_000_000L
    private var seq = 0

    private fun service(store: MemoryMemoStore) = MemoEditService(
        store = store,
        clock = { now },
        idGen = { "m_gen" + (++seq) },
    )

    private fun hits(store: MemoryMemoStore, year: Int, month: Int): List<String> {
        val rows = store.alive()
        return MonthGridLayout.dates(year, month).filter { MonthExpander.memosOn(it, rows).isNotEmpty() }
    }

    private fun note(hits: List<String>): List<String> = hits

    /* ------------------------------ M1 ------------------------------ */

    /** M1：新建记事（不排期，start/end 都空）→ 落库成功；月历上任何一天都不出现；列表能看到。 */
    @Test
    fun m1_noteWithoutDatesSavesAndNeverShowsOnCalendar() {
        val store = MemoryMemoStore()
        val svc = service(store)

        val outcome = svc.createMemo(MemoDraft(id = "m_note", kind = MemoKind.NOTE, title = "读书笔记"))

        assertTrue("落库成功", outcome is MemoOutcome.Saved)
        val row = assertNotNull("行已写入", store.memo("m_note")).let { store.memo("m_note")!! }
        assertEquals("dirty=1 才会被推送", 1, row.dirty)
        assertEquals("updated_at 用时钟", now, row.updatedAt)
        assertEquals("不排期 = 两个日期都空", null, row.startDate)
        assertEquals(null, row.endDate)
        assertEquals("列表能看到", listOf("m_note"), svc.listMemos(MemoKind.NOTE).map { it.id })
        assertEquals("42 格一整月", 42, MonthGridLayout.dates(2026, 10).size)
        assertTrue("月历任何一天都不出现", hits(store, 2026, 10).isEmpty())
    }

    /* ------------------------------ M2 ------------------------------ */

    /** M2：把记事改成时间段 10/27~10/29 → 月历上三天都出现；10/26 与 10/30 不出现。 */
    @Test
    fun m2_noteDateRangeHitsExactlyTheThreeDays() {
        val store = MemoryMemoStore()
        val svc = service(store)
        svc.createMemo(MemoDraft(id = "m_note", kind = MemoKind.NOTE, title = "出差"))

        now += 60_000
        val outcome = svc.updateMemo(
            MemoDraft(id = "m_note", kind = MemoKind.NOTE, title = "出差", startDate = "2026-10-27", endDate = "2026-10-29"),
        )

        assertTrue("原地改成功", outcome is MemoOutcome.Saved)
        assertEquals(
            "只有这三天命中",
            listOf("2026-10-27", "2026-10-28", "2026-10-29"),
            note(hits(store, 2026, 10)),
        )
        val rows = store.alive()
        assertTrue("10-26 不出现", MonthExpander.memosOn("2026-10-26", rows).isEmpty())
        assertTrue("10-30 不出现", MonthExpander.memosOn("2026-10-30", rows).isEmpty())
        assertEquals("改区间是原地改，id 不变", 1, store.rows.size)
    }

    /* ------------------------------ M3 ------------------------------ */

    /** M3：新建倒数日（目标日 2027-03-15）→ 落库成功；不进月历；列表显示目标日。 */
    @Test
    fun m3_countdownSavesAndStaysOutOfCalendar() {
        val store = MemoryMemoStore()
        val svc = service(store)

        val outcome = svc.createMemo(
            MemoDraft(id = "m_cd", kind = MemoKind.COUNTDOWN, title = "生日", startDate = "2027-03-15"),
        )

        assertTrue("落库成功", outcome is MemoOutcome.Saved)
        val row = store.memo("m_cd")!!
        assertEquals("目标日落在 start_date", "2027-03-15", row.startDate)
        assertEquals("倒数日没有结束日期", null, row.endDate)
        assertEquals("dirty=1", 1, row.dirty)
        assertEquals("列表显示目标日", listOf("m_cd"), svc.listMemos(MemoKind.COUNTDOWN).map { it.id })
        assertEquals("不进记事列表", emptyList<String>(), svc.listMemos(MemoKind.NOTE).map { it.id })
        assertTrue("月历上那一天也不出现", MonthExpander.memosOn("2027-03-15", store.alive()).isEmpty())
        assertTrue("整月都不出现", hits(store, 2027, 3).isEmpty())
    }

    /* ------------------------------ M4 ------------------------------ */

    /** M4：新建笔记本（分类「习惯」）→ 落库成功；不进月历；分类正确。 */
    @Test
    fun m4_notebookKeepsCategoryAndStaysOutOfCalendar() {
        val store = MemoryMemoStore()
        val svc = service(store)

        val outcome = svc.createMemo(
            MemoDraft(id = "m_book", kind = MemoKind.NOTEBOOK, title = "晨间流程", content = "起床后先喝水", category = "习惯"),
        )

        assertTrue("落库成功", outcome is MemoOutcome.Saved)
        val row = store.memo("m_book")!!
        assertEquals("分类正确", "习惯", row.category)
        assertEquals("笔记本没有日期", null, row.startDate)
        assertEquals("dirty=1", 1, row.dirty)
        assertTrue("不进月历", hits(store, 2026, 10).isEmpty())
        assertEquals("只在笔记本列表里", listOf("m_book"), svc.listMemos(MemoKind.NOTEBOOK).map { it.id })

        // 分类留空 → 未分类（§10.1）
        now += 1_000
        svc.updateMemo(MemoDraft(id = "m_book", kind = MemoKind.NOTEBOOK, title = "晨间流程", content = "起床后先喝水", category = " "))
        assertEquals("空分类归一为未分类", MemoKind.CATEGORY_NONE, store.memo("m_book")!!.category)
    }

    /* ------------------------------ M5 ------------------------------ */

    /** M5：删除记事 → deleted=1、updated_at 变大、dirty=1；列表不再显示它。 */
    @Test
    fun m5_deleteNoteIsSoftAndDisappearsFromList() {
        val store = MemoryMemoStore()
        val svc = service(store)
        svc.createMemo(
            MemoDraft(id = "m_note", kind = MemoKind.NOTE, title = "周报", startDate = "2026-10-27", endDate = "2026-10-29"),
        )
        val before = store.memo("m_note")!!

        now += 5_000
        val outcome = svc.deleteMemo("m_note")

        assertTrue("软删成功", outcome is MemoOutcome.Deleted)
        val after = store.memo("m_note")!!
        assertEquals("deleted=1", 1, after.deleted)
        assertTrue("updated_at 变大（LWW 靠它）", after.updatedAt > before.updatedAt)
        assertEquals("dirty=1", 1, after.dirty)
        assertEquals("没有物理删除", 1, store.rows.size)
        assertEquals("列表不再显示", emptyList<String>(), svc.listMemos(MemoKind.NOTE).map { it.id })
        assertTrue("月历上也不再出现", MonthExpander.memosOn("2026-10-27", store.alive()).isEmpty())
        assertEquals("重复删除被拒绝", MemoOutcome.Rejected::class.java, svc.deleteMemo("m_note")::class.java)
    }

    /* ------------------------------ M6 ------------------------------ */

    /** M6：三类的新建/编辑/删除后 → 所有被改过的行 dirty 都为 1（待同步）。 */
    @Test
    fun m6_everyTouchedMemoRowIsDirty() {
        val store = MemoryMemoStore()
        val svc = service(store)

        // 新建三类
        svc.createMemo(MemoDraft(id = "m_note", kind = MemoKind.NOTE, title = "记事一", startDate = "2026-10-20"))
        svc.createMemo(MemoDraft(id = "m_cd", kind = MemoKind.COUNTDOWN, title = "纪念日", startDate = "2025-10-19"))
        svc.createMemo(MemoDraft(id = "m_book", kind = MemoKind.NOTEBOOK, title = "笔记一", content = "正文", category = "工作"))
        assertEquals("新建的三条都 dirty", listOf(1, 1, 1), store.rows.values.map { it.dirty })

        // 各自原地改一次
        now += 1_000
        svc.updateMemo(MemoDraft(id = "m_note", kind = MemoKind.NOTE, title = "记事一改名", startDate = "2026-10-27", endDate = "2026-10-29"))
        svc.updateMemo(MemoDraft(id = "m_cd", kind = MemoKind.COUNTDOWN, title = "纪念日", startDate = "2025-10-19", content = "第七年"))
        svc.updateMemo(MemoDraft(id = "m_book", kind = MemoKind.NOTEBOOK, title = "笔记一", content = "改过的正文", category = "生活"))
        assertEquals("改过的三条仍 dirty", listOf(1, 1, 1), store.rows.values.map { it.dirty })
        assertEquals("原地改不新增行", 3, store.rows.size)

        // 删一条：连墓碑一起看，被改过的行都必须 dirty
        now += 1_000
        svc.deleteMemo("m_cd")
        assertEquals("含墓碑在内的三行都 dirty", listOf(1, 1, 1), store.rows.values.map { it.dirty })
        assertEquals("软删没有新增行", 3, store.rows.size)
    }

    /* ------------------------- 写入层校验（§10.1） ------------------------- */

    @Test
    fun writePathRejectsNonStrictDates() {
        val store = MemoryMemoStore()
        val svc = service(store)

        val bad = listOf("2026-1-5", "2026/10/01", "2026-02-30")
        bad.forEach { raw ->
            val outcome = svc.createMemo(
                MemoDraft(id = "m_note", kind = MemoKind.NOTE, title = "记事", startDate = raw),
            )
            assertTrue("$raw 必须被写入层拒绝", outcome is MemoOutcome.Invalid)
        }
        assertTrue("一条都没落库", store.rows.isEmpty())
    }

    @Test
    fun noteRejectsEndBeforeStartAndEndWithoutStart() {
        val store = MemoryMemoStore()
        val svc = service(store)

        val reversed = svc.createMemo(
            MemoDraft(id = "m_a", kind = MemoKind.NOTE, title = "反序", startDate = "2026-10-29", endDate = "2026-10-27"),
        )
        assertTrue("end < start 被拒", reversed is MemoOutcome.Invalid)

        val endOnly = svc.createMemo(
            MemoDraft(id = "m_b", kind = MemoKind.NOTE, title = "只有结束日", endDate = "2026-10-29"),
        )
        assertTrue("只有 end 被拒", endOnly is MemoOutcome.Invalid)

        val noTitle = svc.createMemo(MemoDraft(id = "m_c", kind = MemoKind.NOTE, title = "  "))
        assertTrue("记事标题必填", noTitle is MemoOutcome.Invalid)
        assertTrue("一条都没落库", store.rows.isEmpty())
    }

    @Test
    fun countdownRequiresTargetAndRejectsEndDate() {
        val store = MemoryMemoStore()
        val svc = service(store)

        assertTrue(
            "没有目标日被拒",
            svc.createMemo(MemoDraft(id = "m_a", kind = MemoKind.COUNTDOWN, title = "生日")) is MemoOutcome.Invalid,
        )
        assertTrue(
            "带结束日期被拒",
            svc.createMemo(
                MemoDraft(id = "m_b", kind = MemoKind.COUNTDOWN, title = "生日", startDate = "2027-03-15", endDate = "2027-03-16"),
            ) is MemoOutcome.Invalid,
        )
        assertTrue("一条都没落库", store.rows.isEmpty())
    }

    @Test
    fun notebookRequiresTitleOrContent() {
        val store = MemoryMemoStore()
        val svc = service(store)

        assertTrue(
            "标题与正文都空被拒",
            svc.createMemo(MemoDraft(id = "m_a", kind = MemoKind.NOTEBOOK, title = " ", content = "  ")) is MemoOutcome.Invalid,
        )
        assertTrue(
            "有正文没标题可以",
            svc.createMemo(MemoDraft(id = "m_b", kind = MemoKind.NOTEBOOK, content = "只有正文")) is MemoOutcome.Saved,
        )
        assertEquals("一条落库", 1, store.rows.size)
    }

    @Test
    fun noteSingleDayOnlyHitsThatDay() {
        val store = MemoryMemoStore()
        val svc = service(store)
        svc.createMemo(MemoDraft(id = "m_note", kind = MemoKind.NOTE, title = "单日", startDate = "2026-10-20"))

        assertEquals("单日只在当天命中", listOf("2026-10-20"), note(hits(store, 2026, 10)))
        assertFalse(
            "10-21 不命中",
            MonthExpander.memosOn("2026-10-21", store.alive()).isNotEmpty(),
        )
    }

    /* --------------------- 元信息文案（契约 §10.4） --------------------- */

    @Test
    fun noteMetaFollowsContractWording() {
        assertEquals("未排期", MemoFormats.rangeShort(null, null))
        assertEquals("未排期", MemoFormats.rangeShort("", ""))
        assertEquals("10/20", MemoFormats.rangeShort("2026-10-20", ""))
        assertEquals("10/20", MemoFormats.rangeShort("2026-10-20", "2026-10-20"))
        assertEquals("10/27 ~ 10/29", MemoFormats.rangeShort("2026-10-27", "2026-10-29"))
        assertEquals("列表副标题用完整日期", "2026-10-27 ~ 2026-10-29", MemoFormats.rangeFull("2026-10-27", "2026-10-29"))
    }

    /** 笔记本元信息是「更新于」，不是「创建日」：memo 表没有 created_at。 */
    @Test
    fun notebookMetaUsesUpdatedAtAndWordCount() {
        val ms = java.time.ZonedDateTime.of(2026, 10, 24, 18, 24, 0, 0, java.time.ZoneId.of("Asia/Shanghai"))
            .toInstant().toEpochMilli()
        val meta = MemoFormats.bookMeta(ms, "一二三 四五\n六", java.time.ZoneId.of("Asia/Shanghai"))
        assertEquals("字数只数非空白字符", 6, MemoFormats.words("一二三 四五\n六"))
        assertEquals("更新于 10月24日 下午6:24 ｜ 6 字", meta)
        assertTrue("不出现创建日字样", !meta.contains("创建"))
    }

    @Test
    fun countdownTextHandlesPastTodayAndFuture() {
        assertEquals("就是今天", MemoFormats.countdown("2026-10-24", "2026-10-24"))
        assertEquals("还有 3 天", MemoFormats.countdown("2026-10-27", "2026-10-24"))
        assertEquals("已经 3 天", MemoFormats.countdown("2026-10-21", "2026-10-24"))
        assertEquals("没有目标日", MemoFormats.countdown("", "2026-10-24"))
    }
}
