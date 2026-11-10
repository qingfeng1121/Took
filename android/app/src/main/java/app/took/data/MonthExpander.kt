package app.took.data

import app.took.engine.Engine

/**
 * 规则展开的纯函数层：没有任何 Android 依赖，JVM 单测可直接覆盖。
 *
 * 契约 §3.4 的分层要求：**读取/展开层**遇到脏数据只能返回 false，不许抛异常整片崩掉。
 * 因此单条规则的命中判定整体包在 runCatching 里 —— 库里的 start_date 哪怕是 '2026-1-5'，
 * 这一条规则不命中，其余规则照常渲染。
 */
object MonthExpander {

    /**
     * 一条规则 + 它的引擎对象 + 它的任务。**规则转引擎只做一次**。
     *
     * 为什么要有这个：原 [itemsOn] 在「每天 × 每条规则」的循环里调 `r.toEngine()`，
     * 连续滚动一次要算 109 周 × 7 天 = 763 天，× 4 条规则 = 3052 次对象创建，
     * 全部在 UI 线程同步跑 —— 用户 2026-11-06 反馈的「上下滑动一卡一卡」主要来自这里。
     * 现在规则与任务的转换提前到 [prepare]，逐日只做日期判定。
     */
    class Prepared(val rule: RuleRow, val engine: app.took.engine.Rule, val tasks: List<TaskRow>)

    /** 把规则表与任务表预转成逐日判定用的结构（一次）。 */
    fun prepare(rules: List<RuleRow>, tasksByRule: Map<String, List<TaskRow>>): List<Prepared> =
        rules.filter { it.enabled }.mapNotNull { r ->
            runCatching { Prepared(r, r.toEngine(), tasksByRule[r.id].orEmpty().filter { it.enabled }) }
                .getOrNull()
        }

    /** 用 [prepare] 的结果算某一天，不再重复转换规则。 */
    fun itemsOn(date: String, prepared: List<Prepared>, doneKeys: Set<String>): List<DayItem> {
        val out = ArrayList<DayItem>()
        for (p in prepared) {
            val periodStart = runCatching {
                if (!Engine.occursOn(p.engine, date)) return@runCatching null
                Engine.periodStartOf(p.engine, date)
            }.getOrNull() ?: continue
            for (t in p.tasks) {
                out.add(
                    DayItem(
                        taskId = t.id,
                        title = t.title,
                        ruleId = p.rule.id,
                        ruleTitle = p.rule.title,
                        periodStart = periodStart,
                        done = Engine.completionKey(t.id, periodStart) in doneKeys,
                    ),
                )
            }
        }
        return out
    }

    /** 兼容旧签名（单测与其它调用方还在用）。内部转一次规则表。 */
    fun itemsOn(
        date: String,
        rules: List<RuleRow>,
        tasksByRule: Map<String, List<TaskRow>>,
        doneKeys: Set<String>,
    ): List<DayItem> = itemsOn(date, prepare(rules, tasksByRule), doneKeys)

    /**
     * 某天命中的记事（契约 §10.1）：只有 kind=0 且当天落在 [start_date, end_date] 区间里才命中，
     * 不排期（两日期都空）的记事永远不出现；倒数日与笔记本永不进月历。
     * 与 PC 的 Day.memos 同一口径，判定逻辑在 [MemoEditPolicy.activeOn]。
     */
    fun memosOn(date: String, memos: List<MemoRow>): List<MemoRow> =
        memos.filter { MemoEditPolicy.activeOn(it, date) }
}
