package app.took.ui

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * 倒数日方形卡底部目标日的紧凑格式（参考图 `2026.2.6`：点分隔、月日都不补零）。
 *
 * 与 [MemoFormats.rangeFull]（列表副标题的 `2026-02-06`）是两个用途，别互相替换。
 */
class MemoFormatsTest {

    @Test
    fun compactDateDropsLeadingZerosAndUsesDots() {
        assertEquals("2026.2.6", MemoFormats.compactDate("2026-02-06"))
        assertEquals("2026.10.27", MemoFormats.compactDate("2026-10-27"))
        assertEquals("2025.1.1", MemoFormats.compactDate("2025-01-01"))
    }

    @Test
    fun compactDateKeepsFullYear() {
        // 参考图就是 4 位年，不能被格式化吃掉
        assertEquals("2027.3.15", MemoFormats.compactDate("2027-03-15"))
    }

    @Test
    fun compactDateFallsBackOnEmptyOrDirty() {
        assertEquals("未排期", MemoFormats.compactDate(null))
        assertEquals("未排期", MemoFormats.compactDate("  "))
        // 脏数据原样回显，绝不抛异常
        assertEquals("not-a-date", MemoFormats.compactDate("not-a-date"))
    }

    @Test
    fun compactDateDoesNotChangeRangeFullContract() {
        // 定稿 §10.4 的横线格式不受影响
        assertEquals("2026-02-06", MemoFormats.rangeFull("2026-02-06", null))
    }
}
