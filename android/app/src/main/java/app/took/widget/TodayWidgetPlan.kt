package app.took.widget

import app.took.data.DayItem

/**
 * 「今日概览」组件的纯逻辑层：没有任何 Android 依赖，JVM 单测直接覆盖。
 *
 * 三档尺寸（定稿 §6.2.1 的思路：卡片越小，越只保留「未完成」）：
 *  - 紧凑：只放 1 行 + 未完成条数（小尺寸只够一条任务名）；
 *  - 标准：放 3 行；
 *  - 宽松：放 6 行。
 * 溢出统一折成「还有 N 条」，不静默丢任务。
 */
enum class WidgetTier(val rows: Int) {
    COMPACT(1),
    MEDIUM(3),
    LARGE(6),
}

/** 组件上的一行。done 只影响颜色与标记，**已完成的任务不会从组件上消失**（定稿 §6.2）。 */
data class WidgetTask(val title: String, val done: Boolean)

/**
 * 某一天在组件上的呈现计划。
 *
 * [tasks] 已按「未完成优先、已完成在后」排好，两组内部都保持入参顺序
 * （入参是 MonthExpander 按规则 + task.sort_order 展开的）。
 */
data class TodayWidgetPlan(
    val dateKey: String,
    val tasks: List<WidgetTask>,
    val doneCount: Int,
    val undoneCount: Int,
) {

    val total: Int get() = tasks.size

    /** 头部右侧的一句话摘要。空 / 全完成 / 有未完成 三种口径分开，不用「0 件未完成」这种绕的写法。 */
    val headline: String
        get() = when {
            total == 0 -> "今天没有安排"
            undoneCount == 0 -> "全部完成 $doneCount/$total"
            else -> "$undoneCount/$total 未完成"
        }

    /** 这一档能放的条数。 */
    fun visible(limit: Int): List<WidgetTask> = tasks.take(limit.coerceAtLeast(0))

    /** 被尺寸挤掉、只以「还有 N 条」体现的条数。 */
    fun overflow(limit: Int): Int = (total - visible(limit).size).coerceAtLeast(0)

    companion object {

        /**
         * 把当天命中的任务折成组件计划。
         *
         * 排序规则与定稿 §6.2.1 第 4 条一致：未完成排前面，已完成的排在后面但**保留**。
         */
        fun of(dateKey: String, items: List<DayItem>): TodayWidgetPlan {
            val undone = items.filterNot { it.done }.map { WidgetTask(it.title, done = false) }
            val done = items.filter { it.done }.map { WidgetTask(it.title, done = true) }
            return TodayWidgetPlan(
                dateKey = dateKey,
                tasks = undone + done,
                doneCount = done.size,
                undoneCount = undone.size,
            )
        }

        /**
         * 按组件实际尺寸选档位。高度是主判据（和定稿 §6.2.1 用高度分档一致），
         * 极窄的宽度也降为紧凑档 —— 1×N 的竖条放不下两行文字。
         */
        fun tierForSize(widthDp: Float, heightDp: Float): WidgetTier = when {
            widthDp < 170f || heightDp <= 110f -> WidgetTier.COMPACT
            heightDp <= 240f -> WidgetTier.MEDIUM
            else -> WidgetTier.LARGE
        }
    }
}
