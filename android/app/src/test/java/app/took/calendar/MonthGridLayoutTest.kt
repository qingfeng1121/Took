package app.took.calendar

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.DayOfWeek
import java.time.LocalDate

/** 契约 §5.3：42 格、周一起始。 */
class MonthGridLayoutTest {

    @Test
    fun october2026_is42CellsMondayFirst() {
        val dates = MonthGridLayout.dates(2026, 10)
        assertEquals("格数固定 42", 42, dates.size)
        // 2026-10-01 是周四 → 前置 3 格，第一格是 2026-09-28 周一
        assertEquals("2026-09-28", dates.first())
        assertEquals("2026-10-01", dates[3])
        assertEquals("2026-10-31", dates[33])
        assertEquals("2026-11-08", dates.last())
        // 连续递增，不跳日不重复
        dates.zipWithNext().forEach { (a, b) ->
            assertEquals(LocalDate.parse(a).plusDays(1), LocalDate.parse(b))
        }
        // 每行第一格都是周一
        dates.forEachIndexed { i, key ->
            if (i % 7 == 0) assertEquals(DayOfWeek.MONDAY, LocalDate.parse(key).dayOfWeek)
        }
    }

    @Test
    fun june2026_startsExactlyOnFirst() {
        // 2026-06-01 是周一 → 第一格就是本月 1 日
        assertEquals("2026-06-01", MonthGridLayout.dates(2026, 6).first())
    }

    @Test
    fun february2028_leapYear() {
        val dates = MonthGridLayout.dates(2028, 2)
        assertEquals(42, dates.size)
        assertTrue(dates.contains("2028-02-28"))
        assertTrue(dates.contains("2028-02-29"))
    }

    /* ------------- 格子铺满屏宽、不横向滚动（用户 2026-10-26 返工） ------------- */

    /**
     * 用户 2026-10-26：「日历日期格子太大了宽度不要大于屏幕，可以支持下滑不比侧滑好用」。
     * 1.5 倍宽（一屏 4.5 天 + 左右滑）作废，格子宽度回到 7 列均分。
     */
    @Test
    fun cellScale_isExactlyOne_noMoreZoom() {
        assertEquals("格子不再放大，必须正好 1.0", 1.0f, MonthGridLayout.CELL_SCALE, 0.0001f)
    }

    /** 屏幕可用宽 1000px 时：7 列均分 = 142px（向下取整），不再乘任何倍数。 */
    @Test
    fun cellWidth_isSeventhOfAvailable() {
        assertEquals(142, 1000 / MonthGridLayout.COLS)
        assertEquals(142, MonthGridLayout.cellWidthPx(1000))
        assertEquals(98, MonthGridLayout.cellWidthPx(690))  // 真机可用宽量级
    }

    /**
     * 内容宽 = 7 格 × 单格宽，**永远 ≤ 可用宽**（向下取整最多少 6px），
     * 也就是「不会有横向滚动、不会截断任何一列」。
     */
    @Test
    fun gridWidth_neverExceedsScreen_noHorizontalScroll() {
        assertEquals(994, MonthGridLayout.gridWidthPx(1000))
        assertEquals(686, MonthGridLayout.gridWidthPx(690))  // 真机可用宽量级
        // 极窄容器（可用宽 < 7px）会被 coerceAtLeast(1) 兜底，此时内容宽必然大于可用宽；
        // 真实屏幕宽都远大于这个量级，只对「能放下 7 列」的宽度断言不溢出。
        listOf(30, 690, 1000, 1080, 1440).forEach { w ->
            assertTrue("可用宽 " + w + " 时内容宽不得超出", MonthGridLayout.gridWidthPx(w) <= w)
        }
        val visibleCells = 1000f / MonthGridLayout.cellWidthPx(1000)
        assertTrue("一屏至少放得下 7 格整（不截断）", visibleCells >= 7f)
        assertTrue("也不会宽松到一屏 8 格（说明还在均分）", visibleCells < 8f)
    }

    /** 极窄容器也不能算出 0 宽（会整月看不见）。 */
    @Test
    fun cellWidth_neverCollapsesToZero() {
        assertEquals(1, MonthGridLayout.cellWidthPx(0))
        assertEquals(1, MonthGridLayout.cellWidthPx(1))
        assertTrue(MonthGridLayout.cellWidthPx(30) >= 1)
    }

    /* ------------------------ 圆点规则（用户 2026-10-25） ------------------------ */

    /** 空格子：一个点都不画，也不显示 +N。 */
    @Test
    fun dotPlan_emptyCell() {
        val plan = MonthGridLayout.dotPlan(emptyList())
        assertEquals(0, plan.done)
        assertEquals(0, plan.undone)
        assertEquals(0, plan.more)
        assertEquals(0, plan.total)
    }

    /** 已完成 = 实心点、未完成 = 空心点，各自计数分开（渲染顺序即入参顺序）。 */
    @Test
    fun dotPlan_splitsDoneAndUndone() {
        val plan = MonthGridLayout.dotPlan(listOf(false, true, false, false, true))
        assertEquals(2, plan.done)
        assertEquals(3, plan.undone)
        assertEquals(0, plan.more)
        assertEquals(5, plan.total)
    }

    /** 正好 6 个：全画出来，没有 +N。 */
    @Test
    fun dotPlan_exactlyMax_noOverflow() {
        val plan = MonthGridLayout.dotPlan(List(6) { it % 2 == 0 })
        assertEquals(6, plan.total)
        assertEquals(0, plan.more)
            // 3 个 true(下标 0,2,4)、3 个 false
        assertEquals(3, plan.done)
        assertEquals(3, plan.undone)
    }

    /** 超过 6 个：只画前 6 个点，剩下的用「+N」文字收尾。 */
    @Test
    fun dotPlan_overSix_showsPlusN() {
        val plan = MonthGridLayout.dotPlan(List(9) { it < 4 })  // 4 已完成 + 5 未完成
        assertEquals(6, plan.total)
        assertEquals(3, plan.more)
        assertEquals(4, plan.done)
        assertEquals(2, plan.undone)
    }

    /** 全部完成的 10 个任务：6 个实心点 + 「+4」。 */
    @Test
    fun dotPlan_allDone_overSix() {
        val plan = MonthGridLayout.dotPlan(List(10) { true })
        assertEquals(6, plan.done)
        assertEquals(0, plan.undone)
        assertEquals(4, plan.more)
    }

    /** 一个任务都没有时 total=0；只有一个未完成时只画一个空心点（不显示 +N 文字）。 */
    @Test
    fun dotPlan_singleUndone() {
        val plan = MonthGridLayout.dotPlan(listOf(false))
        assertEquals(1, plan.total)
        assertEquals(0, plan.done)
        assertEquals(1, plan.undone)
        assertEquals(0, plan.more)
    }

    /* ------------------ 纵向下滑翻月（用户 2026-10-26 返工） ------------------ */

    /** 慢拖：位移过阈值就翻，方向按「上滑看下个月、下滑看上个月」。 */
    @Test
    fun monthFlip_slowDragByDistance() {
        val threshold = 120f
        assertEquals("上滑 → 下个月", 1, MonthGridLayout.monthFlip(dragPx = -200f, velocityPxPerSec = -100f, thresholdPx = threshold))
        assertEquals("下滑 → 上个月", -1, MonthGridLayout.monthFlip(dragPx = 200f, velocityPxPerSec = 100f, thresholdPx = threshold))
    }

    /** 位移不够就一律不翻（手指抖一下不能换月）。 */
    @Test
    fun monthFlip_shortDragDoesNothing() {
        val threshold = 120f
        assertEquals(0, MonthGridLayout.monthFlip(dragPx = -50f, velocityPxPerSec = -300f, thresholdPx = threshold))
        assertEquals(0, MonthGridLayout.monthFlip(dragPx = 40f, velocityPxPerSec = 200f, thresholdPx = threshold))
        assertEquals(0, MonthGridLayout.monthFlip(dragPx = 0f, velocityPxPerSec = 0f, thresholdPx = threshold))
    }

    /** 快甩：位移不到阈值也翻，方向以甩动速度为准。 */
    @Test
    fun monthFlip_fastFlickByVelocity() {
        val threshold = 120f
        assertEquals(1, MonthGridLayout.monthFlip(dragPx = -20f, velocityPxPerSec = -2000f, thresholdPx = threshold))
        assertEquals(-1, MonthGridLayout.monthFlip(dragPx = 20f, velocityPxPerSec = 2000f, thresholdPx = threshold))
    }
}
