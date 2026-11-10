package app.took.data

import app.took.calendar.WeekScroll
import app.took.engine.DateKeys
import java.time.LocalDate

/**
 * 连续滚动月历里的一行 = 一周（周一到周日 7 格）。
 *
 * [date] 是这一周的周一（'YYYY-MM-DD'），同时是 LazyColumn 的 key ——
 * 刷新数据（打卡、同步）后同一周仍是同一项，滚动位置不会跳。
 */
data class WeekRow(
    val date: String,
    /** 恰好 7 格，周一起始，日期连续 +1 天。 */
    val cells: List<DayCell>,
)

/**
 * 把「周列表 + 取格函数」拼成 [WeekRow] 的纯逻辑层：没有数据库、没有 Android 依赖，JVM 单测可直接覆盖。
 *
 * 周与周之间的数学全部在 [WeekScroll]（同一份逻辑也负责顶部标题与 ‹ › 定位），
 * 这里只负责「给每一格填内容」这一步，方便单测用假数据断言连续性。
 */
object WeekRows {

    /**
     * [fromDate, toDate] 覆盖到的每一周，每行 7 格。
     *
     * [cellOf] 拿到 (日期, 是否属于这一周的主月)，返回该格的内容。
     *
     * **主月**（[WeekScroll.headerMonth]）：一周 7 天跨两个月时，天数多的那个月是主月。
     * 连续滚动里没有「本月 / 补位的上月下月」这种概念了 —— 灰化靠这个标记：
     * 跨月行里少数那侧的日子灰掉，且**颜色只在这一行跨过月界时变**，滚动途中不会整屏闪烁。
     */
    fun build(
        fromDate: String,
        toDate: String,
        cellOf: (date: String, inMonth: Boolean) -> DayCell,
    ): List<WeekRow> = WeekScroll.weeks(fromDate, toDate).map { weekStart ->
        val majorMonth = WeekScroll.headerMonth(weekStart)
        val monday = LocalDate.parse(weekStart)
        WeekRow(
            date = weekStart,
            cells = (0 until WeekScroll.CELLS).map { i ->
                val date = DateKeys.key(monday.plusDays(i.toLong()))
                cellOf(date, WeekScroll.monthKey(date) == majorMonth)
            },
        )
    }
}
