package app.took.calendar

import app.took.engine.DateKeys
import java.time.LocalDate
import java.time.YearMonth

/**
 * 连续滚动月历的**周**排布：纯 Kotlin，无 Android 依赖，可直接跑 JVM 单测。
 *
 * 用户 2026-10-26 返工（原话）：「向下滑，日历就像一张长长的纸，一天一天、一周一周（一行一行）
 * 地连续往下滚动。滚动到月底后，无缝衔接下一月。」——
 * 因此这里不再有「42 格整月」的概念，只有**连续的周**：每一行是周一到周日 7 格，
 * 相邻两行的日期严格 +7 天，跨月/跨年都不换轨（[weeks] 的连续性就是这条判据）。
 */
object WeekScroll {

    /** 一行 7 格（周一起始）。 */
    const val CELLS = 7

    /** 预生成范围：当前月前后各 24 个月（约 50 个月 × 4~5 行 ≈ 210+ 行）。 */
    const val MONTHS_EACH_SIDE = 24

    /** 任意日期 → 它所在周的周一（周一起始，与 [MonthGridLayout.WEEK_TITLES] 对齐）。 */
    fun weekStart(date: String): String {
        val d = LocalDate.parse(date)
        return DateKeys.key(d.minusDays((d.dayOfWeek.value - 1).toLong()))
    }

    /**
     * [fromDate, toDate] 覆盖到的每一周的周一，按时间升序、逐周 +7 天。
     *
     * 这是「无缝」的判据：返回值的第 i 项 + 7 天必然等于第 i+1 项，
     * 所以跨月那两行（如 2026-10-26 → 2026-11-02）之间没有任何空档或重复。
     */
    fun weeks(fromDate: String, toDate: String): List<String> {
        if (toDate < fromDate) return emptyList()
        var cur = LocalDate.parse(weekStart(fromDate))
        val last = LocalDate.parse(weekStart(toDate))
        val out = ArrayList<String>()
        while (!cur.isAfter(last)) {
            out.add(DateKeys.key(cur))
            cur = cur.plusDays(CELLS.toLong())
        }
        return out
    }

    /** 预生成范围的首末日：当月 1 日往前 [monthsEachSide] 个月的 1 日 → 当月月末往后同样月数的月末。 */
    fun rangeFor(today: String, monthsEachSide: Int = MONTHS_EACH_SIDE): Pair<String, String> {
        val ym = YearMonth.from(LocalDate.parse(today))
        val start = ym.minusMonths(monthsEachSide.toLong()).atDay(1)
        val end = ym.plusMonths(monthsEachSide.toLong()).atEndOfMonth()
        return DateKeys.key(start) to DateKeys.key(end)
    }

    /** 'YYYY-MM-DD' → 'YYYY-MM'。 */
    fun monthKey(date: String): String = date.substring(0, 7)

    /** 月份平移（'2026-01' 减 1 个月 = '2025-12'），供 ‹ › 按钮算目标月。 */
    fun shiftMonth(monthKey: String, delta: Int): String =
        YearMonth.parse(monthKey).plusMonths(delta.toLong()).toString()

    /**
     * 顶部标题取哪个月：**这一周里占天数最多的那个月**。
     *
     * 7 天最多跨 2 个月，多数必然是 4:3 或更悬殊，不存在平票。
     * 例：2026-10-26 起的这一周 = 10/26~10/31 六天 + 11/01 一天 → 2026-10。
     */
    fun headerMonth(weekStartDate: String): String {
        val start = LocalDate.parse(weekStartDate)
        val counts = HashMap<String, Int>()
        for (i in 0 until CELLS) {
            val key = monthKey(DateKeys.key(start.plusDays(i.toLong())))
            counts[key] = (counts[key] ?: 0) + 1
        }
        // 天数相同是不可能的（7 天只能切成 4:3 / 5:2 / 6:1 / 7:0），maxBy 已足够
        return counts.maxByOrNull { it.value }!!.key
    }

    /** 包含 [date] 的那一行在 [weekStarts] 里的下标；不在范围内则落到最近的一行（不返回 -1）。 */
    fun indexOfWeekContaining(weekStarts: List<String>, date: String): Int {
        if (weekStarts.isEmpty()) return 0
        val target = weekStart(date)
        val hit = weekStarts.binarySearch(target)
        if (hit >= 0) return hit
        val insert = -hit - 1
        return (insert - 1).coerceIn(0, weekStarts.lastIndex)
    }

    /**
     * 标题第一次变成 [monthKey] 的那一行在 [weekStarts] 里的下标 —— ‹ › 按钮滚到这里。
     *
     * 判据与 [headerMonth] 完全同源（而不是「含当月 1 日的那一行」）：
     * 2026-10 的第一行是 2026-09-28 起的这周（9/28~9/30 三天 + 10/1~10/4 四天 → 主月已是 10 月），
     * 这样按一次 › 标题必然从 10 月变 11 月，不会出现「滚过去了但标题没变、再按一次没反应」。
     *
     * 范围里没有这个月时返回 -1（按钮据此什么都不做，不会滚到列表外）。
     */
    fun indexOfFirstWeekOfMonth(weekStarts: List<String>, monthKey: String): Int =
        weekStarts.indexOfFirst { headerMonth(it) == monthKey }

    /** 'YYYY-MM' → 顶部标题「2026 年 10 月」（与改造前的 AppBar 同一写法）。 */
    fun monthTitle(monthKey: String): String {
        val ym = YearMonth.parse(monthKey)
        return ym.year.toString() + " 年 " + ym.monthValue + " 月"
    }
}
