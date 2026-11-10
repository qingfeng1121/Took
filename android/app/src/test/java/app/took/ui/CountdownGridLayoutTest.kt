package app.took.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 首页倒数日区「2 列 × 4 行」网格的纯逻辑（用户 2026-10-26：「app 内的倒数日为什么要改成
 * 2*2，改成 2*4」）。
 *
 * 断言三件事：
 *  1. 每行固定 2 张，最后一行不足 2 张时补空位（卡片不被拉宽成整行）；
 *  2. 一屏 4 行 = 8 张，第 9 张起继续往下排（不截断、不隐藏）；
 *  3. 卡片是 2:1 的横向卡（宽高比 2）。
 */
class CountdownGridLayoutTest {

    @Test
    fun perRowIsTwo() {
        assertEquals(2, CountdownGridLayout.PER_ROW)
    }

    @Test
    fun oneScreenIsTwoColumnsTimesFourRows() {
        assertEquals(4, CountdownGridLayout.VISIBLE_ROWS)
        assertEquals(8, CountdownGridLayout.BLOCK_SIZE)
    }

    /** 卡片是横向卡：宽 : 高 = 2 : 1。 */
    @Test
    fun cardIsHorizontalTwoToOne() {
        assertEquals(2f, CountdownGridLayout.ASPECT, 0.0001f)
    }

    /** 5 张 → 3 行（2 + 2 + 1），最后一行只有 1 张。 */
    @Test
    fun fiveItems_spanThreeRows() {
        val rows = CountdownGridLayout.rows(listOf("a", "b", "c", "d", "e"))
        assertEquals(3, rows.size)
        assertEquals(listOf(2, 2, 1), rows.map { it.size })
        assertEquals(3, CountdownGridLayout.rowCount(5))
    }

    /** 8 张正好填满一个 2×4 块（4 行），不产生空行。 */
    @Test
    fun eightItems_fillExactlyFourRows() {
        val rows = CountdownGridLayout.rows((1..8).toList())
        assertEquals(4, rows.size)
        assertTrue("每行都是满的", rows.all { it.size == 2 })
        assertEquals(CountdownGridLayout.BLOCK_SIZE, rows.sumOf { it.size })
    }

    /** 第 9 张起继续往下排 —— 一屏 4 行是形态，不是硬上限（藏起来等于把倒数日弄丢）。 */
    @Test
    fun ninthItem_continuesToFifthRow() {
        val rows = CountdownGridLayout.rows((1..9).toList())
        assertEquals(5, rows.size)
        assertEquals(listOf(2, 2, 2, 2, 1), rows.map { it.size })
        assertEquals(9, rows.sumOf { it.size })
    }

    @Test
    fun emptyList_hasNoRows() {
        assertEquals(0, CountdownGridLayout.rows(emptyList<Any>()).size)
        assertEquals(0, CountdownGridLayout.rowCount(0))
    }

    @Test
    fun singleItem_isOneRowOfOne() {
        val rows = CountdownGridLayout.rows(listOf("only"))
        assertEquals(1, rows.size)
        assertEquals(1, rows[0].size)
        assertEquals(1, CountdownGridLayout.rowCount(1))
    }
}
