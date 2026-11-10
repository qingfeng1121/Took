package app.took.countdownwidget

import app.took.data.MemoKind
import app.took.data.MemoRow
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 组件「显示哪一个倒数日、怎么显示」的纯逻辑。
 *
 * 2026-10-26 返工后的口径（用户原话：「2*2 为什么要塞两个倒数日？一个只能显示一个」）：
 *  1. **一个实例 = 一个倒数日**，任何尺寸都只画一张卡（没有 maxCards 这种概念）；
 *  2. 选中哪条由本实例的 Preferences 里的 memoId 决定 → 两个实例可以显示不同的倒数日；
 *  3. 未配置（旧版升级 / 刚拖上桌面）→ 自动取排序后的第一个，不留空白；
 *  4. 配了但已删 → 「该倒数日已删除」+ 重新选择提示，不崩不空白；
 *  5. 排序 / 文案 / 点分日期仍与 App 内卡片同源（MemoEditPolicy.countdownOrder + MemoFormats）。
 */
class CountdownWidgetPlanTest {

    private fun memo(
        title: String,
        target: String?,
        id: String = "m_" + title,
        kind: Int = MemoKind.COUNTDOWN,
        deleted: Int = 0,
    ) = MemoRow(
        id = id,
        kind = kind,
        title = title,
        content = null,
        startDate = target,
        endDate = null,
        category = null,
        deleted = deleted,
    )

    private val today = "2026-10-26"

    /** 三条倒数日：a（最近）→ b → c（最远）。 */
    private fun threeMemos() = listOf(
        memo("a", "2026-11-01", id = "id_a"),
        memo("b", "2026-12-01", id = "id_b"),
        memo("c", "2027-01-01", id = "id_c"),
    )

    /* ------------------------- ① 单实例只显示一个 ------------------------- */

    /**
     * 核心回归：不管几条倒数日，一个实例只产出**一张**卡。
     *
     * 上一版按尺寸分档（MINI 1 / MEDIUM 2 / LARGE 4），2×2 会塞 2 个 —— 用户说的「太丑」。
     */
    @Test
    fun oneInstanceShowsExactlyOneCard_neverTwo() {
        val plan = CountdownWidgetPlan.of(threeMemos(), today)
        assertNotNull("必须有一张卡", plan.item)
        assertEquals(1, listOfNotNull(plan.item).size)
        assertEquals("只画最近的那一条", "a", plan.item!!.title)
    }

    /** 全部 4 条也只会画 1 条 —— 没有「2 条 / 4 条」的分档了。 */
    @Test
    fun fourCountdowns_stillRenderOne() {
        val plan = CountdownWidgetPlan.of(
            listOf(
                memo("a", "2026-11-01", id = "id_a"),
                memo("b", "2026-11-02", id = "id_b"),
                memo("c", "2026-11-03", id = "id_c"),
                memo("d", "2026-11-04", id = "id_d"),
            ),
            today,
        )
        assertEquals(1, listOfNotNull(plan.item).size)
        assertEquals("a", plan.item!!.title)
    }

    /** 2×2（约 145dp）与 2×4（145×300dp）都落在能画完整卡的档上，且都只画一条。 */
    @Test
    fun twoByTwo_andTwoByFour_bothRenderSingleCard() {
        val plan = CountdownWidgetPlan.of(threeMemos(), today)
        assertEquals(CountdownWidgetTier.REGULAR, CountdownWidgetPlan.tierForSize(145f, 145f))
        assertEquals(CountdownWidgetTier.ROOMY, CountdownWidgetPlan.tierForSize(145f, 300f))
        assertEquals("a", plan.item!!.title)
    }

    /** 更小的格子（旧版 1×1）也仍然只画一条，只是字号收一档。 */
    @Test
    fun compactTier_stillKeepsNumberAndDate() {
        val tier = CountdownWidgetPlan.tierForSize(70f, 70f)
        assertEquals(CountdownWidgetTier.COMPACT, tier)
        val card = CountdownWidgetPlan.of(listOf(memo("在一起", "2027-02-06")), today).item!!
        assertEquals("103", card.number)
        assertEquals("2027.2.6", card.dateText)
    }

    /* --------------------- ② 多个实例靠选择而不是全塞 --------------------- */

    /**
     * 两个实例选不同的 memoId → 两个实例显示不同的倒数日。
     * 这是「放两个 2×2 组件、分别选不同倒数日」在纯逻辑层的确证。
     */
    @Test
    fun twoInstancesWithDifferentMemoId_showDifferentCountdowns() {
        val memos = threeMemos()
        val instanceA = CountdownWidgetPlan.resolve(memos, today, "id_a")
        val instanceB = CountdownWidgetPlan.resolve(memos, today, "id_c")

        assertEquals("a", instanceA.item!!.title)
        assertEquals("c", instanceB.item!!.title)
        assertTrue("两个实例内容必须不同", instanceA.item!!.title != instanceB.item!!.title)
        // 各自仍然只有一条
        assertEquals(1, listOfNotNull(instanceA.item).size)
        assertEquals(1, listOfNotNull(instanceB.item).size)
    }

    /** 选中的那条就是「配置页点的那条」，不受排序影响（选最远的那条也照样显示它）。 */
    @Test
    fun explicitSelection_ignoresSortOrder() {
        val plan = CountdownWidgetPlan.resolve(threeMemos(), today, "id_b")
        assertEquals(CountdownWidgetSelection.EXPLICIT, plan.selection)
        assertEquals("b", plan.item!!.title)
        assertFalse(plan.autoSelected)
    }

    /** 选过去的倒数日也照样显示（「已经 N 天」），不会被排序或过滤掉。 */
    @Test
    fun explicitSelection_ofPastCountdown_works() {
        val memos = threeMemos() + memo("纪念日", "2025-10-21", id = "id_past")
        val plan = CountdownWidgetPlan.resolve(memos, today, "id_past")
        assertEquals("纪念日", plan.item!!.title)
        assertEquals("370", plan.item!!.number)
        assertEquals("已经 370 天", plan.item!!.direction)
        assertTrue(plan.item!!.past)
    }

    /* ----------------------- ③ 未配置 → 取排序后第一个 ----------------------- */

    /**
     * 未配置过（旧版升级上来的实例、或刚拖上桌面还没选）→ 自动取排序后的第一个，
     * 保证组件不是空白。
     */
    @Test
    fun unconfigured_fallsBackToFirstSorted() {
        val plan = CountdownWidgetPlan.of(threeMemos(), today)
        assertEquals(CountdownWidgetSelection.AUTO, plan.selection)
        assertTrue(plan.autoSelected)
        assertNull("未配置时没有 requestedId", plan.requestedId)
        assertEquals("a", plan.item!!.title)
    }

    /** 空串 / 全空白等同于「未配置」，不能当成一个真实 id 去查（会误判成已删除）。 */
    @Test
    fun blankMemoId_isTreatedAsUnconfigured() {
        listOf("", "   ", null).forEach { blank ->
            val plan = CountdownWidgetPlan.resolve(threeMemos(), today, blank)
            assertEquals("blank=[" + blank + "] 应视为未配置", CountdownWidgetSelection.AUTO, plan.selection)
            assertEquals("a", plan.item!!.title)
        }
    }

    /** 只有一条倒数日时，「未配置取第一个」与「显式选它」结果一致。 */
    @Test
    fun singleCountdown_autoAndExplicitAgree() {
        val memos = listOf(memo("唯一", "2026-12-01", id = "only"))
        val auto = CountdownWidgetPlan.of(memos, today)
        val explicit = CountdownWidgetPlan.resolve(memos, today, "only")
        assertEquals("唯一", auto.item!!.title)
        assertEquals("唯一", explicit.item!!.title)
        assertEquals(CountdownWidgetSelection.AUTO, auto.selection)
        assertEquals(CountdownWidgetSelection.EXPLICIT, explicit.selection)
    }

    /* ------------------------- ④ memoId 失效兜底 ------------------------- */

    /**
     * 配了的那条被删了 → MISSING：显示「该倒数日已删除」+ 重新选择提示。
     * **不崩、不空白、也不偷偷换成别的倒数日**（用户会以为选错了）。
     */
    @Test
    fun deletedSelection_reportsMissing_notBlank() {
        val plan = CountdownWidgetPlan.resolve(threeMemos(), today, "id_gone")
        assertEquals(CountdownWidgetSelection.MISSING, plan.selection)
        assertTrue(plan.missing)
        assertNull("失效时不画别的倒数日", plan.item)
        assertEquals("id_gone", plan.requestedId)
        assertEquals("该倒数日已删除", CountdownWidgetPlan.DELETED_TEXT)
        assertEquals("长按组件重新选择", CountdownWidgetPlan.DELETED_HINT)
    }

    /** 那条倒数日被软删（deleted=1）→ 同样走 MISSING，而不是显示一条墓碑数据。 */
    @Test
    fun softDeletedSelection_isMissing() {
        val memos = listOf(memo("还在", "2026-11-01", id = "id_alive")) +
            memo("删了", "2026-12-01", id = "id_dead", deleted = 1)
        val plan = CountdownWidgetPlan.resolve(memos, today, "id_dead")
        assertEquals(CountdownWidgetSelection.MISSING, plan.selection)
        assertNull(plan.item)
    }

    /** 一条倒数日都没有时是 EMPTY（而不是 MISSING）—— 先告诉用户「还没有」，再谈选择。 */
    @Test
    fun noCountdownsAtAll_isEmptyNotMissing() {
        val plan = CountdownWidgetPlan.resolve(emptyList(), today, "id_gone")
        assertEquals(CountdownWidgetSelection.EMPTY, plan.selection)
        assertTrue(plan.empty)
        assertFalse(plan.missing)
        assertNull(plan.item)
        assertEquals("还没有倒数日", CountdownWidgetPlan.EMPTY_TEXT)
    }

    /** 只有记事（kind=0）没有倒数日：同样是空状态，不把记事当倒数日显示。 */
    @Test
    fun onlyNotes_isStillEmpty() {
        val plan = CountdownWidgetPlan.of(listOf(memo("会议纪要", "2026-11-01", kind = MemoKind.NOTE)), today)
        assertTrue(plan.empty)
        assertNull(plan.item)
    }

    /* ------------------------------- 排序 ------------------------------- */

    /** 未来升序在前（最近的先到），过去降序在后（离今天最近的先出现）。 */
    @Test
    fun futureAscendingThenPastDescending() {
        val plan = CountdownWidgetPlan.of(
            listOf(
                memo("远的", "2027-02-06"),
                memo("过去的近", "2026-10-20"),
                memo("近的", "2026-11-01"),
                memo("过去的远", "2025-01-01"),
            ),
            today,
        )
        assertEquals(listOf("近的", "远的", "过去的近", "过去的远"), plan.items.map { it.title })
        // 未配置时取第一个 = 最近的未来
        assertEquals("近的", plan.item!!.title)
    }

    /** 目标日解析不了的排到最后，绝不因为一行脏数据把整块组件打挂。 */
    @Test
    fun unparsableTargetGoesLast_andShowsDash() {
        val plan = CountdownWidgetPlan.of(
            listOf(memo("脏数据", "不是日期"), memo("正常的", "2026-12-01")),
            today,
        )
        assertEquals(listOf("正常的", "脏数据"), plan.items.map { it.title })
        val dirty = plan.items.last()
        assertEquals("—", dirty.number)
        assertEquals("没有目标日", dirty.direction)
        assertFalse(dirty.past)
        assertFalse(dirty.today)
    }

    /* ---------------------------- 天数与日期 ---------------------------- */

    @Test
    fun futureTarget_saysHaiYou() {
        val item = CountdownWidgetPlan.of(listOf(memo("生日", "2026-11-05")), today).item!!
        assertEquals("10", item.number)
        assertEquals("还有 10 天", item.direction)
        assertFalse(item.past)
        assertFalse(item.today)
    }

    @Test
    fun pastTarget_saysYiJing_andIsPast() {
        val item = CountdownWidgetPlan.of(listOf(memo("在一起", "2025-10-21")), today).item!!
        assertEquals("370", item.number)
        assertEquals("已经 370 天", item.direction)
        assertTrue(item.past)
        assertFalse(item.today)
    }

    @Test
    fun targetToday_saysJiuShiJinTian() {
        val item = CountdownWidgetPlan.of(listOf(memo("今天的事", today)), today).item!!
        assertEquals("0", item.number)
        assertEquals("就是今天", item.direction)
        assertTrue("今天走红色", item.today)
        assertFalse(item.past)
    }

    /** 点分日期不补零：2027-02-06 → 2027.2.6（与 App 内 MemoFormats.compactDate 同一口径）。 */
    @Test
    fun compactDate_dropsLeadingZeros() {
        val plan = CountdownWidgetPlan.of(
            listOf(memo("a", "2027-02-06"), memo("b", "2027-12-31")),
            today,
        )
        assertEquals(listOf("2027.2.6", "2027.12.31"), plan.items.map { it.dateText })
    }

    /** 没有目标日：日期文案是「未排期」，数字位是「—」，不编一个 0 出来。 */
    @Test
    fun missingTarget_showsUnscheduled() {
        val item = CountdownWidgetPlan.of(listOf(memo("没写日期", null)), today).item!!
        assertEquals("未排期", item.dateText)
        assertEquals("—", item.number)
        assertFalse(item.today)
    }

    /** 语义串：uiautomator 靠它断这张卡是哪个倒数日、几天、哪一天。 */
    @Test
    fun labelCarriesTitleDirectionAndDate() {
        val item = CountdownWidgetPlan.of(listOf(memo("在一起", "2027-02-06")), today).item!!
        assertEquals("倒数日 在一起，还有 103 天，目标日 2027.2.6", item.label)
    }

    /* ------------------------------ 排版 ------------------------------ */

    /** 超大数字字号：卡越高字越大，且永远落在这一档的上下限内。 */
    @Test
    fun numberSize_scalesWithCardHeight_andStaysInRange() {
        val tall = CountdownWidgetPlan.cardLayout(250f, CountdownWidgetTier.ROOMY).numberSp
        val short = CountdownWidgetPlan.cardLayout(60f, CountdownWidgetTier.ROOMY).numberSp
        assertTrue("高卡的字号必须更大", tall > short)
        assertTrue("下限", short >= CountdownWidgetTier.ROOMY.minNumberSp)
        assertTrue("上限", tall <= CountdownWidgetTier.ROOMY.maxNumberSp)
        val tiny = CountdownWidgetPlan.cardLayout(0f, CountdownWidgetTier.COMPACT).numberSp
        assertEquals(CountdownWidgetTier.COMPACT.minNumberSp, tiny, 0.01f)
    }

    /** 卡高只扣外层留白 —— 只有一张卡，不再按张数均分。 */
    @Test
    fun cardHeight_onlySubtractsRootPadding() {
        val tier = CountdownWidgetTier.REGULAR
        val h = CountdownWidgetPlan.cardHeightDp(145f, tier)
        assertEquals(145f - 2f * tier.rootPad, h, 0.01f)
    }

    /** 卡宽扣掉外层留白与卡片左右内边距 —— 用来给 4 位数压字号。 */
    @Test
    fun cardWidth_subtractsRootAndCardPadding() {
        val tier = CountdownWidgetTier.REGULAR
        val w = CountdownWidgetPlan.cardWidthDp(145f, tier)
        assertEquals(145f - 2f * tier.rootPad - 2f * tier.cardPad, w, 0.01f)
    }

    /** 4 位数（1000 天以上）在 2×2 里必须按宽度压下来，否则横向溢出被裁半个数字。 */
    @Test
    fun fourDigitNumber_isShrunkToFitWidth() {
        val tier = CountdownWidgetTier.REGULAR
        val width = CountdownWidgetPlan.cardWidthDp(145f, tier)
        val byHeight = 44f
        val fitted = CountdownWidgetPlan.numberSpFittingWidth(byHeight, width, 4)
        assertTrue("4 位数必须比按高度算出来的小", fitted < byHeight)
        // 压完之后宽度仍然装得下 4 位数
        assertTrue(fitted * 4 / 1.28f <= width + 0.01f)
    }

    /** 位数少时不该被压（byWidth 远大于 byHeight）。 */
    @Test
    fun oneOrTwoDigits_areNotShrunkByWidth() {
        val width = CountdownWidgetPlan.cardWidthDp(145f, CountdownWidgetTier.REGULAR)
        assertEquals(44f, CountdownWidgetPlan.numberSpFittingWidth(44f, width, 1), 0.01f)
        assertEquals(44f, CountdownWidgetPlan.numberSpFittingWidth(44f, width, 2), 0.01f)
    }

    /** 把一份排版折算成它真的占掉的高度（数字行 + 其余各行 + 内边距）。 */
    private fun usedHeight(tier: CountdownWidgetTier, layout: CountdownWidgetPlan.Companion.CardLayout): Float =
        2f * tier.cardPad +
            (if (layout.showTitle) tier.titleSp * CountdownWidgetPlan.LINE_FACTOR else 0f) +
            (if (layout.showDirection) (tier.titleSp - 1) * CountdownWidgetPlan.LINE_FACTOR else 0f) +
            tier.dateSp * CountdownWidgetPlan.LINE_FACTOR +
            CountdownWidgetPlan.NUMBER_EXTRA_DP +
            layout.numberSp * CountdownWidgetPlan.NUMBER_LINE_FACTOR

    /** 字号必须给底部目标日留够位置：所有行加起来不能超过卡高。 */
    @Test
    fun numberSize_leavesRoomForDateLine() {
        val tier = CountdownWidgetTier.REGULAR
        val cardH = CountdownWidgetPlan.cardHeightDp(145f, tier)
        val layout = CountdownWidgetPlan.cardLayout(cardH, tier)
        assertTrue("排完所有行必须装得进卡里", usedHeight(tier, layout) <= cardH + 0.01f)
    }

    /** 三档都要装得下 —— 真机 2×2 / 2×4 / 4×4 的典型尺寸逐个验一遍。 */
    @Test
    fun everyTierFitsAtTypicalSizes() {
        val cases = listOf(
            70f to CountdownWidgetTier.COMPACT,
            110f to CountdownWidgetTier.REGULAR,
            145f to CountdownWidgetTier.REGULAR,
            300f to CountdownWidgetTier.ROOMY,
            420f to CountdownWidgetTier.ROOMY,
        )
        cases.forEach { (total, tier) ->
            val cardH = CountdownWidgetPlan.cardHeightDp(total, tier)
            val layout = CountdownWidgetPlan.cardLayout(cardH, tier)
            assertTrue(
                tier.name + " total=" + total + " cardH=" + cardH + " sp=" + layout.numberSp +
                    " title=" + layout.showTitle + " dir=" + layout.showDirection + " 装不下",
                usedHeight(tier, layout) <= cardH + 0.01f,
            )
        }
    }

    /** 排得越挤，被砍掉的行越多，但数字永远不小于这一档的下限、日期永远保留。 */
    @Test
    fun tighterCard_dropsLinesButKeepsNumberAndDate() {
        val tier = CountdownWidgetTier.ROOMY
        val tight = CountdownWidgetPlan.cardLayout(CountdownWidgetPlan.cardHeightDp(110f, tier), tier)
        assertFalse("挤的时候先砍方向词", tight.showDirection)
        assertTrue("数字仍然不小于下限", tight.numberSp >= tier.minNumberSp)

        val roomy = CountdownWidgetPlan.cardLayout(CountdownWidgetPlan.cardHeightDp(600f, tier), tier)
        assertTrue("宽松时四行齐全", roomy.showTitle && roomy.showDirection)
    }

    /** 卡高为 0（极端异常尺寸）也不能崩，且数字取下限、行全部让位。 */
    @Test
    fun zeroHeight_fallsBackToMinimumWithoutCrash() {
        val tier = CountdownWidgetTier.REGULAR
        val layout = CountdownWidgetPlan.cardLayout(0f, tier)
        assertEquals(tier.minNumberSp, layout.numberSp, 0.01f)
        assertFalse(layout.showTitle)
        assertFalse(layout.showDirection)
    }

    /* --------------------------- Preferences 键 --------------------------- */

    /** 键名是不变量：改名等于让桌面上已配置的组件全部失效。 */
    @Test
    fun memoIdKeyName_isStable() {
        assertEquals("memoId", CountdownWidgetState.KEY_MEMO_ID_NAME)
    }
}
