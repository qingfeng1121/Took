package app.took.ui

/**
 * 首页倒数日卡片区的网格口径（纯 Kotlin，JVM 单测可断言）。
 *
 * 用户 2026-10-26：「app 内的倒数日为什么要改成 2*2，改成 2*4」。
 * 落地为 **2 列 × 4 行**的网格：每行 2 张、卡片是宽高比 2:1 的**横向卡**。
 *
 * 为什么是 2:1 而不是继续用 1:1 方形：
 *  - 1:1 方形卡在 2 列网格里只有 164dp 见方，一行只放得下 1 位数的大数字；
 *  - 2:1 横向卡把「标题 / 方向 / 目标日」竖排在左、把**超大数字**单独放右，
 *    数字能拿到 ~40sp（方形卡里只有 ~28sp），这才是「一眼看到天数」。
 *
 * 「4 行」是这一块的**形态**（2 列 × 4 行 = 一屏 8 张），不是硬上限：
 * 第 9 张起继续往下排，由页面自身的纵向滚动接住 —— 藏起来等于把倒数日弄丢。
 */
object CountdownGridLayout {

    /** 每行几张卡。 */
    const val PER_ROW = 2

    /** 一屏（一个 2×4 块）装几张卡。 */
    const val VISIBLE_ROWS = 4
    const val BLOCK_SIZE = PER_ROW * VISIBLE_ROWS

    /** 卡片宽高比（宽 : 高 = 2 : 1）——横向卡。 */
    const val ASPECT = 2f

    /** 按每行 2 张切行；最后一行不足 2 张时补一个空位（卡片不被拉宽成整行）。 */
    fun rows(items: List<*>): List<List<*>> = items.chunked(PER_ROW)

    /** 需要几行 —— 一屏 4 行，超出后继续往下排（不截断）。 */
    fun rowCount(count: Int): Int = (count + PER_ROW - 1) / PER_ROW
}
