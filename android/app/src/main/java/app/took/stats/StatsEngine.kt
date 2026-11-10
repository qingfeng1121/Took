package app.took.stats

import app.took.data.RuleRow
import app.took.data.TaskRow
import app.took.engine.DateKeys
import app.took.engine.Engine
import java.time.LocalDate

/**
 * 统计分析（定稿 §3.7）：完成率 / 按规则分组 / 连续打卡，两个维度（时间范围 × 统计类型）各自独立。
 *
 * 两条硬口径：
 *  1. **全部现算**：输入只有 rule / task / completion 三张表的当前内容，不缓存、不写死任何数字；
 *  2. **按周期计**：完成率 = 已完成周期 ÷ 应出现周期，同一周期内多个命中日只算一次
 *     （周一做完 A，这一周的 A 就永远是完成态，不会因为周二三四没再点而掉回去）。
 *
 * [Result.totalDone] / [Result.totalExpected] 由明细行 [TaskStat] 求和得出 —— 界面上的
 * 「已完成周期」与明细表「已完成」列的合计是同一个数字，不可能对不上（§3.7 末段的要求）。
 *
 * 纯 Kotlin，无 Android 依赖，JVM 单测直接覆盖（StatsEngineTest）。
 */
typealias StatsResult = StatsEngine.Result

object StatsEngine {

    const val RANGE_WEEK = 0
    const val RANGE_MONTH = 1
    const val RANGE_D30 = 2
    const val RANGE_ALL = 3
    val RANGE_LABELS = listOf("本周", "本月", "近 30 天", "全部")

    const val TYPE_RATE = 0
    const val TYPE_RULE = 1
    const val TYPE_STREAK = 2
    val TYPE_LABELS = listOf("完成率", "按规则分组", "连续打卡")

    /** 统计区间。结束日一律压到今天：**未来还没到的日子不计入「应完成」**，否则完成率被人为压低。 */
    data class Range(val id: Int, val label: String, val start: LocalDate, val end: LocalDate) {
        val days: Int get() = (DateKeys.daysBetween(start, end) + 1).toInt()

        fun keys(): List<String> = (0 until days).map { DateKeys.key(start.plusDays(it.toLong())) }

        /** `2026-10-20 ~ 2026-10-25 · 6 天` */
        fun describe(): String = DateKeys.key(start) + " ~ " + DateKeys.key(end) + " · " + days + " 天"
    }

    /** 任务明细的一行：应出现周期数 / 已完成周期数（同一周期只计一次）。 */
    data class TaskStat(
        val taskId: String,
        val taskTitle: String,
        val ruleId: String,
        val ruleTitle: String,
        val expected: Int,
        val done: Int,
        val lastDone: String,
    ) {
        val rate: Double get() = if (expected <= 0) 0.0 else done.toDouble() / expected
    }

    /** 规则级汇总：Σ 其下每个任务应完成周期 / Σ 已完成周期。 */
    data class RuleStat(
        val ruleId: String,
        val ruleTitle: String,
        val expected: Int,
        val done: Int,
        val tasks: List<TaskStat>,
    ) {
        val rate: Double get() = if (expected <= 0) 0.0 else done.toDouble() / expected
    }

    /** 逐日情况：当天命中多少个 (任务, 周期)，其中多少个周期已完成。用于柱状图与连续天数。 */
    data class DayStat(val date: String, val expected: Int, val done: Int) {
        val complete: Boolean get() = expected > 0 && done == expected
        val neutral: Boolean get() = expected == 0
    }

    data class Result(
        val range: Range,
        val tasks: List<TaskStat>,
        val rules: List<RuleStat>,
        val days: List<DayStat>,
        val currentStreak: Int,
        val bestStreak: Int,
    ) {
        /** 与明细行严格同源（§3.7）。 */
        val totalExpected: Int get() = tasks.sumOf { it.expected }
        val totalDone: Int get() = tasks.sumOf { it.done }
        val rate: Double get() = if (totalExpected <= 0) 0.0 else totalDone.toDouble() / totalExpected
        val taskCount: Int get() = tasks.size
        val activeDays: Int get() = days.count { it.done > 0 }
        val completeDays: Int get() = days.count { it.complete }
        val rulesHit: Int get() = rules.count { it.done > 0 }
    }

    /** 时间范围 → 具体区间。id 非法时退回「本月」。 */
    fun range(id: Int, today: String, rules: List<RuleRow>): Range {
        val d = DateKeys.parse(today)
        val start: LocalDate
        val naturalEnd: LocalDate
        val label: String
        when (id) {
            RANGE_WEEK -> {
                // 周一起始（与月历 weekStart=mon 一致）
                start = d.minusDays((d.dayOfWeek.value - 1).toLong())
                naturalEnd = start.plusDays(6)
                label = "本周"
            }
            RANGE_D30 -> {
                start = d.minusDays(29)
                naturalEnd = d
                label = "近 30 天"
            }
            RANGE_ALL -> {
                val earliest = rules
                    .mapNotNull { runCatching { DateKeys.parse(it.startDate) }.getOrNull() }
                    .minOrNull() ?: d
                start = earliest
                naturalEnd = d
                label = "全部"
            }
            else -> {
                start = d.withDayOfMonth(1)
                naturalEnd = d.withDayOfMonth(d.lengthOfMonth())
                label = "本月"
            }
        }
        val end = if (naturalEnd.isAfter(d)) d else naturalEnd
        return Range(if (id in RANGE_LABELS.indices) id else RANGE_MONTH, label, start, end)
    }

    /**
     * 现算一份统计结果。
     *
     * 逐条规则在区间内展开命中日 → 归属周期（§3.2）→ 每个任务的应完成/已完成周期；
     * 任何一天/一条规则解析失败都只让它自己不参与（§3.4 的读层分层：不抛异常整片崩掉）。
     */
    fun compute(
        range: Range,
        rules: List<RuleRow>,
        tasksByRule: Map<String, List<TaskRow>>,
        doneKeys: Set<String>,
        today: String,
    ): Result {
        val dates = range.keys()
        val dayExpected = IntArray(dates.size)
        val dayDone = IntArray(dates.size)
        val tasks = ArrayList<TaskStat>()
        val ruleStats = ArrayList<RuleStat>()

        for (rule in rules) {
            if (!rule.enabled) continue
            val engine = runCatching { rule.toEngine() }.getOrNull() ?: continue

            // 区间内的命中日 → 各自归属的周期起始日
            val hits = ArrayList<Pair<Int, String>>() // 天序号 → periodStart
            dates.forEachIndexed { index, key ->
                val period = runCatching {
                    if (!Engine.occursOn(engine, key)) null else Engine.periodStartOf(engine, key)
                }.getOrNull() ?: return@forEachIndexed
                hits.add(index to period)
            }
            if (hits.isEmpty()) continue

            // 同一周期只计一次：区间内同一 periodStart 的多个命中日合并
            val periods = hits.map { it.second }.toSortedSet()
            val ruleTasks = tasksByRule[rule.id].orEmpty().filter { it.enabled }
            if (ruleTasks.isEmpty()) continue

            val stats = ruleTasks.map { task ->
                val donePeriods = periods.filter { Engine.completionKey(task.id, it) in doneKeys }
                TaskStat(
                    taskId = task.id,
                    taskTitle = task.title,
                    ruleId = rule.id,
                    ruleTitle = rule.title,
                    expected = periods.size,
                    done = donePeriods.size,
                    lastDone = donePeriods.lastOrNull().orEmpty(),
                )
            }
            tasks.addAll(stats)
            ruleStats.add(
                RuleStat(
                    ruleId = rule.id,
                    ruleTitle = rule.title,
                    expected = stats.sumOf { it.expected },
                    done = stats.sumOf { it.done },
                    tasks = stats.sortedBy { it.ruleId + ":" + it.taskId },
                ),
            )

            // 逐日柱：当天每个命中任务各算一格（同一周期内多个命中日都会亮，这是「打卡分布」不是「周期数」）
            for ((index, period) in hits) {
                dayExpected[index] += ruleTasks.size
                dayDone[index] += ruleTasks.count { Engine.completionKey(it.id, period) in doneKeys }
            }
        }

        val days = dates.mapIndexed { i, key -> DayStat(key, dayExpected[i], dayDone[i]) }

        // 连续：从区间末尾（今天）往前，当天命中任务所在周期全部完成才算一天；
        // 当天没有任何命中任务的日子是中性日 —— 跳过，不当作断签（§3.7 的措辞是「所有命中任务都已完成」）。
        var current = 0
        var cursor = days.lastIndex
        while (cursor >= 0) {
            val day = days[cursor]
            if (day.neutral) {
                cursor--
                continue
            }
            if (!day.complete) break
            current++
            cursor--
        }

        // 最长：区间内连续「完成日」的最长一段；中性日会中断这一段（隔了一天就不算连续）
        var best = 0
        var run = 0
        days.forEach { day ->
            run = if (day.complete) run + 1 else 0
            if (run > best) best = run
        }

        return Result(
            range = range,
            tasks = tasks.sortedWith(compareBy({ it.ruleTitle }, { it.taskTitle }, { it.taskId })),
            rules = ruleStats.sortedWith(compareByDescending<RuleStat> { it.rate }.thenBy { it.ruleTitle }),
            days = days,
            currentStreak = current,
            bestStreak = best,
        )
    }

    /**
     * 柱状图分桶（照原型 anGranularity）：≤31 天逐日，≤100 天每 3 天，更长按 7 天。
     * 只影响画法，不改口径 —— 分桶后的 expected/done 仍是逐日值之和。
     */
    fun bucketSize(days: Int): Int = when {
        days <= 31 -> 1
        days <= 100 -> 3
        else -> 7
    }

    fun bucketName(size: Int): String = when (size) {
        1 -> "每日"
        3 -> "每 3 天"
        else -> "每周"
    }

    fun buckets(days: List<DayStat>): List<DayStat> {
        val size = bucketSize(days.size)
        if (size == 1) return days
        return days.chunked(size).map { chunk ->
            DayStat(
                date = chunk.first().date,
                expected = chunk.sumOf { it.expected },
                done = chunk.sumOf { it.done },
            )
        }
    }
}
