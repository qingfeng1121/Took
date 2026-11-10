package app.took.stats

import app.took.data.RuleRow
import app.took.data.TaskRow
import app.took.engine.Engine
import app.took.engine.RepeatMode
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.LocalDate

/**
 * 定稿 §3.7 的统计口径：完成率 / 按规则分组 / 连续打卡，全部由 rule + completion 现算。
 *
 * 这些用例是「统计页数字不是写死的」的硬证据：同一份规则与打卡输入，
 * 只改 range 或只加一条 completion，结果必须跟着变；且 KPI 总数必须等于明细行合计。
 */
class StatsEngineTest {

    /* ------------------------------ 构造工具 ------------------------------ */

    private fun rule(
        id: String,
        title: String,
        mode: Int,
        start: String,
        mask: Int = 0,
        every: Int? = null,
        monthDay: Int? = null,
        yearMonth: Int? = null,
        yearDay: Int? = null,
        enabled: Boolean = true,
        until: String? = null,
    ) = RuleRow(
        id = id,
        title = title,
        enabled = enabled,
        repeatMode = mode,
        weekdaysMask = mask,
        repeatEvery = every,
        monthDay = monthDay,
        yearMonth = yearMonth,
        yearDay = yearDay,
        startDate = start,
        endDate = null,
        repeatUntil = until,
    )

    private fun task(id: String, ruleId: String, title: String, enabled: Boolean = true) =
        TaskRow(id = id, ruleId = ruleId, title = title, enabled = enabled, sortOrder = 0)

    private fun done(vararg pairs: Pair<String, String>): Set<String> =
        pairs.map { Engine.completionKey(it.first, it.second) }.toSet()

    /** 2026-10-25 是周日：本周 = 10-19(周一) ~ 10-25(周日)。 */
    private val today = "2026-10-25"

    private fun compute(
        rangeId: Int,
        rules: List<RuleRow>,
        tasks: Map<String, List<TaskRow>>,
        doneKeys: Set<String>,
        todayKey: String = today,
    ) = StatsEngine.compute(
        range = StatsEngine.range(rangeId, todayKey, rules),
        rules = rules,
        tasksByRule = tasks,
        doneKeys = doneKeys,
        today = todayKey,
    )

    /* ------------------------------ 区间 ------------------------------ */

    @Test
    fun weekRangeStartsOnMondayAndStopsAtToday() {
        val r = StatsEngine.range(StatsEngine.RANGE_WEEK, today, emptyList())
        assertEquals("2026-10-19", r.start.toString())
        assertEquals("今天之前不含未来日：本周只到 10-25", "2026-10-25", r.end.toString())
        assertEquals(7, r.days)
        assertEquals("本周", r.label)
    }

    @Test
    fun monthAndLast30DaysRanges() {
        val month = StatsEngine.range(StatsEngine.RANGE_MONTH, today, emptyList())
        assertEquals("2026-10-01", month.start.toString())
        assertEquals("2026-10-25", month.end.toString())

        val d30 = StatsEngine.range(StatsEngine.RANGE_D30, today, emptyList())
        assertEquals("2026-09-26", d30.start.toString())
        assertEquals(30, d30.days)
    }

    @Test
    fun allRangeStartsFromEarliestRuleStart() {
        val rules = listOf(
            rule("r1", "早", RepeatMode.EVERY, "2026-09-01", every = 1),
            rule("r2", "晚", RepeatMode.EVERY, "2026-10-10", every = 1),
        )
        val all = StatsEngine.range(StatsEngine.RANGE_ALL, today, rules)
        assertEquals("最早规则起始日", "2026-09-01", all.start.toString())
        assertEquals("全部", all.label)
    }

    /* --------------------------- 完成率（核心） --------------------------- */

    /** 每周一的规则：本周只应出现 1 个周期；打了卡就是 1/1 = 100%（不是 7 天各算一次）。 */
    @Test
    fun weeklyRuleCountsOnePeriodPerWeekNotSeven() {
        val rules = listOf(rule("r_week", "每周一", RepeatMode.WEEKLY, "2026-10-01", mask = 1))
        val tasks = mapOf("r_week" to listOf(task("t1", "r_week", "跑步")))
        val res = compute(StatsEngine.RANGE_WEEK, rules, tasks, done("t1" to "2026-10-19"))

        assertEquals("一周只算一个周期", 1, res.totalExpected)
        assertEquals(1, res.totalDone)
        assertEquals(1.0, res.rate, 0.0001)
        assertEquals("9 天？不，本周 7 天，其中只有周一命中", 1, res.days.count { it.expected > 0 })
    }

    @Test
    fun completionRateReflectsOnlyRealData() {
        val rules = listOf(rule("r_daily", "每日", RepeatMode.EVERY, "2026-10-01", every = 1))
        val tasks = mapOf("r_daily" to listOf(task("t1", "r_daily", "背单词")))
        // 本周 7 天里打了 3 天
        val res = compute(
            StatsEngine.RANGE_WEEK,
            rules,
            tasks,
            done("t1" to "2026-10-19", "t1" to "2026-10-21", "t1" to "2026-10-25"),
        )
        assertEquals("7 天都应完成", 7, res.totalExpected)
        assertEquals("实际打了 3 天", 3, res.totalDone)
        assertEquals(3.0 / 7.0, res.rate, 0.0001)
        assertEquals("KPI 必须等于明细合计", res.totalDone, res.tasks.sumOf { it.done })
        assertEquals(res.totalExpected, res.tasks.sumOf { it.expected })
    }

    /** 同一周期内重复打卡只计一次：同一天勾两次（或同一周期多个命中日都勾）不放大分子。 */
    @Test
    fun samePeriodCompletedTwiceCountsOnce() {
        val rules = listOf(rule("r_week", "每周一三五", RepeatMode.WEEKLY, "2026-10-01", mask = 0b10101))
        val tasks = mapOf("r_week" to listOf(task("t1", "r_week", "跑步")))
        // 10-19 / 10-21 / 10-23 属于同一周 → 同一个 period_start 2026-10-19
        val res = compute(
            StatsEngine.RANGE_WEEK,
            rules,
            tasks,
            done("t1" to "2026-10-19", "t1" to "2026-10-21", "t1" to "2026-10-23"),
        )
        assertEquals("一周一个周期", 1, res.totalExpected)
        assertEquals("只计一次", 1, res.totalDone)
    }

    /** 负向证据：把打卡删掉，完成率立刻变 0 —— 说明数字来自库而不是常量。 */
    @Test
    fun removingCompletionDropsRateToZero() {
        val rules = listOf(rule("r_daily", "每日", RepeatMode.EVERY, "2026-10-01", every = 1))
        val tasks = mapOf("r_daily" to listOf(task("t1", "r_daily", "背单词")))
        val withDone = compute(StatsEngine.RANGE_WEEK, rules, tasks, done("t1" to "2026-10-25"))
        val without = compute(StatsEngine.RANGE_WEEK, rules, tasks, emptySet())
        assertTrue(withDone.rate > 0)
        assertEquals(0.0, without.rate, 0.0001)
    }

    /** 停用的规则 / 停用的任务不参与统计（否则完成率永远算不满）。 */
    @Test
    fun disabledRuleAndTaskAreExcluded() {
        val rules = listOf(
            rule("r_on", "启用", RepeatMode.EVERY, "2026-10-01", every = 1),
            rule("r_off", "停用", RepeatMode.EVERY, "2026-10-01", every = 1, enabled = false),
        )
        val tasks = mapOf(
            "r_on" to listOf(task("t1", "r_on", "启用任务"), task("t2", "r_on", "停用任务", enabled = false)),
            "r_off" to listOf(task("t3", "r_off", "停用规则下的任务")),
        )
        val res = compute(StatsEngine.RANGE_WEEK, rules, tasks, emptySet())
        assertEquals("只有一条任务参与", listOf("t1"), res.tasks.map { it.taskId })
        assertEquals("一周 7 天 × 1 任务", 7, res.totalExpected)
    }

    /** 规则起始日之前的日期不算应完成 —— 否则「本月」会把规则生效前的空白月也摊进来。 */
    @Test
    fun daysBeforeRuleStartAreNotExpected() {
        val rules = listOf(rule("r_new", "新建", RepeatMode.EVERY, "2026-10-23", every = 1))
        val tasks = mapOf("r_new" to listOf(task("t1", "r_new", "新任务")))
        val res = compute(StatsEngine.RANGE_WEEK, rules, tasks, emptySet())
        assertEquals("只有 10-23 起 3 天", 3, res.totalExpected)
    }

    /* --------------------------- 按规则分组 --------------------------- */

    /** 规则级完成率 = Σ 其下每个任务已打卡周期 ÷ Σ 应完成周期（§3.7 第一段末）。 */
    @Test
    fun ruleGroupSumsItsTasks() {
        val rules = listOf(rule("r1", "工作日", RepeatMode.WEEKLY, "2026-10-01", mask = 0b11111))
        val tasks = mapOf("r1" to listOf(task("t1", "r1", "健身"), task("t2", "r1", "早起")))
        val res = compute(
            StatsEngine.RANGE_WEEK,
            rules,
            tasks,
            done("t1" to "2026-10-19", "t2" to "2026-10-19"),
        )
        val group = res.rules.single()
        assertEquals("一周一个周期 × 2 个任务", 2, group.expected)
        assertEquals(2, group.done)
        assertEquals(1.0, group.rate, 0.0001)
        assertEquals("规则组的合计必须等于其任务明细之和", res.totalExpected, group.expected)
        assertEquals(res.totalDone, group.done)
    }

    @Test
    fun ruleGroupRateIsNotAverageOfTaskRates() {
        // t1 全勤、t2 全空：正确算法是 Σdone/Σexp = 1/2 = 50%，不是 (100%+0%)/2 的巧合同值
        val rules = listOf(rule("r1", "混合", RepeatMode.EVERY, "2026-10-01", every = 1))
        val tasks = mapOf("r1" to listOf(task("t1", "r1", "全勤"), task("t2", "r1", "不打卡")))
        val res = compute(StatsEngine.RANGE_WEEK, rules, tasks, done("t1" to "2026-10-19", "t1" to "2026-10-20"))
        val group = res.rules.single()
        assertEquals(14, group.expected)
        assertEquals(2, group.done)
        assertEquals(2.0 / 14.0, group.rate, 0.0001)
        assertEquals("明细里有 2 行", 2, group.tasks.size)
    }

    @Test
    fun ruleGroupsShareTotalsWithTaskDetails() {
        val rules = listOf(
            rule("r1", "每日", RepeatMode.EVERY, "2026-10-01", every = 1),
            rule("r2", "每周一", RepeatMode.WEEKLY, "2026-10-01", mask = 1),
        )
        val tasks = mapOf(
            "r1" to listOf(task("t1", "r1", "背单词")),
            "r2" to listOf(task("t2", "r2", "跑步")),
        )
        val res = compute(
            StatsEngine.RANGE_WEEK,
            rules,
            tasks,
            done("t1" to "2026-10-19", "t2" to "2026-10-19"),
        )
        assertEquals(res.totalExpected, res.rules.sumOf { it.expected })
        assertEquals(res.totalDone, res.rules.sumOf { it.done })
    }

    /* --------------------------- 连续打卡 --------------------------- */

    /** 从今天往前连续全勤 3 天，第 4 天断了 → 当前连续 3。 */
    @Test
    fun currentStreakCountsBackwardsFromToday() {
        val rules = listOf(rule("r", "每日", RepeatMode.EVERY, "2026-10-01", every = 1))
        val tasks = mapOf("r" to listOf(task("t1", "r", "背单词")))
        val res = compute(
            StatsEngine.RANGE_WEEK,
            rules,
            tasks,
            done(
                "t1" to "2026-10-25", "t1" to "2026-10-24", "t1" to "2026-10-23",
                "t1" to "2026-10-21", "t1" to "2026-10-20", "t1" to "2026-10-19",
            ),
        )
        assertEquals("10-25/24/23 连续，10-22 断", 3, res.currentStreak)
        assertEquals("整周最长也是 3 天", 3, res.bestStreak)
    }

    @Test
    fun streakRequiresAllHitTasksDone() {
        val rules = listOf(rule("r", "每日", RepeatMode.EVERY, "2026-10-01", every = 1))
        val tasks = mapOf("r" to listOf(task("t1", "r", "背单词"), task("t2", "r", "喝水")))
        // 今天只完成一半 → 连续从 0 起算
        val res = compute(
            StatsEngine.RANGE_WEEK,
            rules,
            tasks,
            done("t1" to "2026-10-25", "t1" to "2026-10-24", "t2" to "2026-10-24"),
        )
        assertEquals("今天漏了一半任务", 0, res.currentStreak)
        assertEquals("昨天两个都完成", 1, res.bestStreak)
    }

    @Test
    fun neutralDaysDoNotBreakCurrentStreak() {
        val rules = listOf(rule("r", "每周一", RepeatMode.WEEKLY, "2026-10-01", mask = 1))
        val tasks = mapOf("r" to listOf(task("t1", "r", "跑步")))
        // 只有周一命中；本周一周已打卡 → 其余 6 天是中性日，不算断签
        val res = compute(StatsEngine.RANGE_WEEK, rules, tasks, done("t1" to "2026-10-19"))
        assertEquals("中性日跳过", 1, res.currentStreak)
        assertEquals(1, res.completeDays)
    }

    /* --------------------------- 分桶（只影响画法） --------------------------- */

    @Test
    fun bucketSizeFollowsRangeLength() {
        assertEquals(1, StatsEngine.bucketSize(7))
        assertEquals(1, StatsEngine.bucketSize(31))
        assertEquals(3, StatsEngine.bucketSize(32))
        assertEquals(7, StatsEngine.bucketSize(101))
        assertEquals("每日", StatsEngine.bucketName(1))
        assertEquals("每 3 天", StatsEngine.bucketName(3))
        assertEquals("每周", StatsEngine.bucketName(7))
    }

    @Test
    fun bucketsSumBackToDailyTotals() {
        val days = (1..31).map { StatsEngine.DayStat("2026-10-01", 2, 1) }
        val small = StatsEngine.buckets(days)
        assertEquals("≤31 天逐日，不分桶", 31, small.size)
        val many = (1..32).map { StatsEngine.DayStat("2026-10-01", 2, 1) }
        val grouped = StatsEngine.buckets(many)
        assertEquals("分桶不改口径：32 × 2 = 64", 64, grouped.sumOf { it.expected })
        assertEquals(32, grouped.sumOf { it.done })
        assertEquals("11 桶（3+3+…+2）", 11, grouped.size)
    }

    /* --------------------------- 健壮性（§3.4） --------------------------- */

    /** 脏数据（非法 start_date）只让这一条不参与，绝不把整页统计打挂。 */
    @Test
    fun dirtyRuleStartDateDoesNotCrashWholeStats() {
        val rules = listOf(
            rule("r_bad", "脏数据", RepeatMode.EVERY, "2026-1-5", every = 1),
            rule("r_ok", "正常", RepeatMode.EVERY, "2026-10-01", every = 1),
        )
        val tasks = mapOf(
            "r_bad" to listOf(task("t_bad", "r_bad", "脏任务")),
            "r_ok" to listOf(task("t_ok", "r_ok", "正常任务")),
        )
        val res = compute(StatsEngine.RANGE_WEEK, rules, tasks, emptySet())
        assertEquals("只有正常规则参与", listOf("t_ok"), res.tasks.map { it.taskId })
        assertEquals(7, res.totalExpected)
    }

    @Test
    fun emptyDatabaseGivesZeroNotCrash() {
        val res = compute(StatsEngine.RANGE_WEEK, emptyList(), emptyMap(), emptySet())
        assertEquals(0, res.totalExpected)
        assertEquals(0.0, res.rate, 0.0001)
        assertEquals(0, res.currentStreak)
        assertEquals("7 天全是中性日", 7, res.days.count { it.neutral })
    }

    /** 结果与「今天」强相关：同一条每周一规则，换个今天就是不同区间。 */
    @Test
    fun resultDependsOnTodayParameter() {
        val rules = listOf(rule("r", "每周一", RepeatMode.WEEKLY, "2026-10-01", mask = 1))
        val tasks = mapOf("r" to listOf(task("t1", "r", "跑步")))
        // 同一份打卡数据（10-19 已打），今天不同 → 落在不同区间，结论必须跟着变
        val thisWeek = compute(StatsEngine.RANGE_WEEK, rules, tasks, done("t1" to "2026-10-19"), today)
        val nextWeek = compute(StatsEngine.RANGE_WEEK, rules, tasks, done("t1" to "2026-10-19"), "2026-10-26")
        assertEquals("2026-10-19 ~ 2026-10-25", 1, thisWeek.totalExpected)
        assertEquals("2026-10-26 ~ 2026-11-01", 1, nextWeek.totalExpected)
        assertEquals("上周的打卡算在本周", 1, thisWeek.totalDone)
        assertEquals("同一份数据换到今天就不再覆盖", 0, nextWeek.totalDone)
    }

    /** 区间描述用得上，且天数自洽（柱状图分桶依赖它）。 */
    @Test
    fun rangeDescribeShowsRealWindow() {
        assertEquals("2026-10-19 ~ 2026-10-25 · 7 天", StatsEngine.range(StatsEngine.RANGE_WEEK, today, emptyList()).describe())
        val d = LocalDate.parse(today)
        assertEquals(d.dayOfWeek.value, 7)
    }
}
