package app.took.data

import app.took.engine.Engine
import app.took.engine.RepeatMode
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 契约 §9.6 的 E1~E6：编辑语义的 JVM 单测。
 *
 * 库换成内存实现（与 CheckinSharingTest 同一手法），被测的是**生产代码**：
 * RuleEditPolicy 做 split 判定，RuleEditService 落库。
 * 每个用例都用 engine.Engine 复核命中日，确认历史没被重算。
 */
class RuleEditServiceTest {

    private val today = "2026-10-24"
    private val yesterday = "2026-10-23"
    private val seedAt = 1_000L
    private val now = 1_700_000_000_000L

    private class MemoryStore : RuleStore {
        val rules = LinkedHashMap<String, RuleRow>()
        val tasks = LinkedHashMap<String, TaskRow>()

        /** 打卡记录只读：编辑路径不许碰它，长度不变就是「历史仍在」的硬证据。 */
        val completions = ArrayList<Pair<String, String>>()
        var seq = 0

        override fun rule(id: String): RuleRow? = rules[id]
        override fun rules(): List<RuleRow> = rules.values.toList()
        override fun putRule(rule: RuleRow) {
            rules[rule.id] = rule
        }

        override fun task(id: String): TaskRow? = tasks[id]
        override fun tasksOf(ruleId: String): List<TaskRow> =
            tasks.values.filter { it.ruleId == ruleId && it.deleted == 0 }.sortedBy { it.sortOrder }

        override fun allTasks(): List<TaskRow> = tasks.values.toList()
        override fun putTask(task: TaskRow) {
            tasks[task.id] = task
        }
    }

    /** 种子与真库一致：每周一~五、两个任务、三条历史打卡。 */
    private fun seed(): MemoryStore {
        val store = MemoryStore()
        store.putRule(
            RuleRow(
                id = "r_work", title = "工作日常规", enabled = true,
                repeatMode = RepeatMode.WEEKLY, weekdaysMask = 31,
                repeatEvery = null, monthDay = null, yearMonth = null, yearDay = null,
                startDate = "2026-10-01", endDate = null, repeatUntil = null,
                updatedAt = seedAt, dirty = 0,
            ),
        )
        store.putTask(TaskRow("t_fit", "r_work", "健身", true, 0, updatedAt = seedAt, dirty = 0))
        store.putTask(TaskRow("t_early", "r_work", "早起", true, 1, updatedAt = seedAt, dirty = 0))
        store.completions += "t_fit" to "2026-10-12"
        store.completions += "t_fit" to "2026-10-19"
        store.completions += "t_early" to "2026-10-19"
        return store
    }

    private fun service(store: MemoryStore, todayKey: String = today) = RuleEditService(
        store = store,
        clock = { now },
        today = { todayKey },
        ruleIdGen = { "r_new${++store.seq}" },
        taskIdGen = { "t_new${++store.seq}" },
    )

    /* -------------------------------- E1 -------------------------------- */

    @Test
    fun E1_titleOnlyEditKeepsSameRuleAndHistory() {
        val store = seed()
        val before = store.completions.toList()
        val draft = store.rules["r_work"]!!.toDraft().copy(title = "工作日常规 2")

        val outcome = service(store).updateRule(draft)

        assertTrue("只改 title 必须是原地改：$outcome", outcome is EditOutcome.Saved)
        assertEquals("E1 规则 id 不变", "r_work", (outcome as EditOutcome.Saved).ruleId)
        assertNull("E1 不裂开，不能出现第二条规则", outcome.split)
        assertEquals("E1 库里仍只有一条规则", 1, store.rules.size)
        val after = store.rules["r_work"]!!
        assertEquals("E1 标题已改", "工作日常规 2", after.title)
        assertNull("E1 repeat_until 不变（仍为空）", after.repeatUntil)
        assertEquals("E1 开始日期不变", "2026-10-01", after.startDate)
        assertEquals("E1 写入必须带 dirty", 1, after.dirty)
        assertEquals("E1 updated_at 刷新", now, after.updatedAt)
        assertEquals("E1 历史打卡一条不少", before, store.completions)
        assertEquals("E1 任务仍是两个，且没被软删", 2, store.tasksOf("r_work").size)
    }

    /* -------------------------------- E2 -------------------------------- */

    @Test
    fun E2_changingWeekdaysSplitsOldRuleAndKeepsHistory() {
        val store = seed()
        val before = store.completions.toList()
        val draft = store.rules["r_work"]!!.toDraft().copy(weekdaysMask = 42)
        val svc = service(store)

        // 第一道闸：没确认就不许写库
        val gate = svc.updateRule(draft, confirmSplit = false)
        assertTrue("命中 split 必须先要确认，实际 $gate", gate is EditOutcome.NeedsConfirm)
        assertEquals("未确认时不许新增规则", 1, store.rules.size)
        assertNull("未确认时旧规则的 repeat_until 不能被改", store.rules["r_work"]!!.repeatUntil)

        // 确认后裂开
        val outcome = svc.updateRule(draft, confirmSplit = true)
        assertTrue("确认后应落库，实际 $outcome", outcome is EditOutcome.Saved)
        val saved = outcome as EditOutcome.Saved
        val split = saved.split
        assertTrue("E2 必须裂开", split != null)
        assertEquals("E2 旧规则 id 保持", "r_work", split!!.oldRuleId)
        assertNotEquals("E2 新规则用客户端生成的新 id", "r_work", split.newRuleId)

        val old = store.rules["r_work"]!!
        val fresh = store.rules[split.newRuleId]!!
        assertEquals("E2 旧规则 repeat_until = 昨天", yesterday, old.repeatUntil)
        assertEquals("E2 旧规则 dirty=1", 1, old.dirty)
        assertEquals("E2 旧规则 updated_at 刷新", now, old.updatedAt)
        assertEquals("E2 旧规则重复方式不动", 31, old.weekdaysMask)
        assertEquals("E2 新规则 start_date = 今天", today, fresh.startDate)
        assertEquals("E2 新规则承载新设置", 42, fresh.weekdaysMask)
        assertEquals("E2 新规则 dirty=1", 1, fresh.dirty)
        assertEquals("E2 两条记录都要能推出去", 2, store.rules.size)

        assertEquals("E2 旧规则下任务一条不少", 2, store.tasksOf("r_work").size)
        assertTrue("E2 任务不自动搬", store.tasksOf(split.newRuleId).isEmpty())
        assertEquals("E2 打卡历史一条不少", before, store.completions)

        // 命中日复核：裂口正好落在昨天，今天起不再命中旧规则，昨天的历史仍然命中
        val oldEngine = old.toEngine()
        assertTrue("2026-10-23(五) 仍在旧规则命中", Engine.occursOn(oldEngine, yesterday))
        assertFalse("2026-10-24 旧规则已封口", Engine.occursOn(oldEngine, today))
        assertTrue("新规则从今天起命中（每周二四六里今天不是周六，先看 10-27 周二）", Engine.occursOn(fresh.toEngine(), "2026-10-27"))
    }

    /** 反例：原样保存不得裂开 —— 避免「多点了一次保存」凭空多出一条规则。 */
    @Test
    fun saveWithoutChangesNeverSplits() {
        val store = seed()
        val draft = store.rules["r_work"]!!.toDraft()

        val outcome = service(store).updateRule(draft, confirmSplit = false)

        assertTrue("无改动应直接原地保存，实际 $outcome", outcome is EditOutcome.Saved)
        assertEquals("绝不能裂开", 1, store.rules.size)
        assertEquals("无改动也不许清掉上界", null, store.rules["r_work"]!!.repeatUntil)
    }

    /** 反例：已结束的规则拒绝改重复设置 —— 同一段历史不可能被封口两次。 */
    @Test
    fun endedRuleRejectsRepeatChange() {
        val store = seed()
        // 规则已经在上个月封过口
        store.putRule(store.rules["r_work"]!!.copy(repeatUntil = "2026-09-30", dirty = 0))
        val draft = store.rules["r_work"]!!.toDraft().copy(weekdaysMask = 42)

        val outcome = service(store).updateRule(draft, confirmSplit = true)

        assertTrue("已结束的规则必须拒绝，实际 $outcome", outcome is EditOutcome.Rejected)
        assertEquals("拒绝时不许产生新规则", 1, store.rules.size)
        assertEquals("封口日期不覆盖", "2026-09-30", store.rules["r_work"]!!.repeatUntil)
    }

    /* -------------------------------- E3 -------------------------------- */

    @Test
    fun E3_deletingRuleSoftDeletesItsTasksAndKeepsCompletions() {
        val store = seed()
        val before = store.completions.toList()

        val outcome = service(store).deleteRule("r_work")

        assertTrue("删除规则应成功，实际 $outcome", outcome is EditOutcome.Deleted)
        assertEquals("E3 影响 2 个任务", 2, (outcome as EditOutcome.Deleted).taskCount)
        assertEquals("E3 规则软删", 1, store.rules["r_work"]!!.deleted)
        assertEquals("E3 规则 dirty=1", 1, store.rules["r_work"]!!.dirty)
        assertEquals("E3 规则 updated_at 刷新", now, store.rules["r_work"]!!.updatedAt)
        store.allTasks().forEach { task ->
            assertEquals("E3 任务 ${task.id} 软删", 1, task.deleted)
            assertEquals("E3 任务 ${task.id} dirty=1", 1, task.dirty)
        }
        assertEquals("E3 completion 行数不变", before.size, store.completions.size)
        assertEquals("E3 活着的任务归零", 0, store.tasksOf("r_work").size)
    }

    /* -------------------------------- E4 -------------------------------- */

    @Test
    fun E4_addingTaskInheritsRuleAndIncrementsSortOrder() {
        val store = seed()

        val error = service(store).addTask("r_work", "  拉伸  ")

        assertNull("加任务不该报错：$error", error)
        val added = store.tasksOf("r_work").last()
        assertEquals("E4 继承当前 rule_id", "r_work", added.ruleId)
        assertEquals("E4 名字去掉首尾空格", "拉伸", added.title)
        assertEquals("E4 sort_order = 当前最大值 + 1", 2, added.sortOrder)
        assertEquals("E4 dirty=1", 1, added.dirty)
        assertEquals("E4 未删除", 0, added.deleted)
        assertEquals("E4 任务数变成 3", 3, store.tasksOf("r_work").size)
    }

    /* -------------------------------- E5 -------------------------------- */

    @Test
    fun E5_deletingTaskKeepsItsCompletions() {
        val store = seed()
        val before = store.completions.toList()

        val error = service(store).deleteTask("t_early")

        assertNull("删任务不该报错：$error", error)
        assertEquals("E5 任务软删", 1, store.tasks["t_early"]!!.deleted)
        assertEquals("E5 dirty=1", 1, store.tasks["t_early"]!!.dirty)
        assertEquals("E5 updated_at 刷新", now, store.tasks["t_early"]!!.updatedAt)
        assertEquals("E5 只剩一个活任务", 1, store.tasksOf("r_work").size)
        assertEquals("E5 completion 行数不变", before.size, store.completions.size)
        assertTrue("E5 该任务的打卡记录仍在", store.completions.any { it.first == "t_early" })
    }

    /* -------------------------------- E6 -------------------------------- */

    @Test
    fun E6_everyEditedRowCarriesDirtyFlag() {
        val store = seed()
        val seededRules = store.rules.keys.toSet()
        val seededTasks = store.tasks.keys.toSet()
        val svc = service(store)

        // 三种写路径各走一遍：原地改、裂开、任务增删
        svc.updateRule(store.rules["r_work"]!!.toDraft().copy(weekdaysMask = 42), confirmSplit = true)
        val activeRuleId = store.rules.keys.first { it !in seededRules }
        svc.addTask(activeRuleId, "新任务")
        svc.renameTask("t_fit", "健身房")
        svc.deleteTask("t_early")

        val touchedRules = store.rules.values.filter { it.updatedAt > seedAt }
        val touchedTasks = store.tasks.values.filter { it.updatedAt > seedAt }

        assertTrue("必须真的改过东西", touchedRules.isNotEmpty() && touchedTasks.isNotEmpty())
        touchedRules.forEach {
            assertEquals("E6 改过的规则 ${it.id} 必须 dirty=1", 1, it.dirty)
        }
        touchedTasks.forEach {
            assertEquals("E6 改过的任务 ${it.id} 必须 dirty=1", 1, it.dirty)
        }
        // 反向断言：不存在「updated_at 变了但 dirty=0」的行
        store.rules.values.forEach {
            if (it.dirty == 0) assertEquals("E6 没改过的规则 ${it.id} 不该被刷新时间戳", seedAt, it.updatedAt)
        }
        store.tasks.values.forEach {
            if (it.dirty == 0) assertEquals("E6 没改过的任务 ${it.id} 不该被刷新时间戳", seedAt, it.updatedAt)
        }
        assertEquals("E6 收尾：活规则两条（旧封口 + 新）", 2, store.rules.values.count { it.deleted == 0 })
    }

    /**
     * 回归：weekly 规则的库里 repeat_every / month_day 都是 NULL，而表单对这些字段有默认值
     * （每 N 天默认 2、每月默认 1）。若「所有字段都比」，改个标题也会被判成改了重复设置而白白裂开。
     * 只改名称 + 带上无关字段默认值时，必须仍然原地改。
     */
    @Test
    fun unchangedWeeklyRuleIgnoresIrrelevantFieldDefaults() {
        val store = seed()
        val draft = store.rules["r_work"]!!.toDraft().copy(
            title = "工作日常规 v2",
            repeatEvery = 2,   // 表单默认值，库里是 NULL
            monthDay = 1,      // 表单默认值，库里是 NULL
            yearMonth = 1,
            yearDay = 1,
        )

        val outcome = service(store).updateRule(draft, confirmSplit = false)

        assertTrue("不该裂开，实际 $outcome", outcome is EditOutcome.Saved)
        assertNull("没有第二段对话框", (outcome as EditOutcome.Saved).split)
        assertEquals("规则仍只有一条", 1, store.rules.size)
        assertEquals("标题确实改了", "工作日常规 v2", store.rules["r_work"]!!.title)
        assertNull("无关字段不会被写脏", store.rules["r_work"]!!.repeatEvery)
    }

    /* ------------------ 裂开后的「复制任务到新规则」（契约 §9.2） ------------------ */

    /** 默认勾选 → 点「确定」即复制：新规则任务数与旧规则相同、id 全新、旧记录不动。 */
    @Test
    fun postSplitCopyCheckedDuplicatesTasksWithNewIds() {
        val store = seed()
        val before = store.completions.toList()
        val svc = service(store)
        val oldTasks = store.tasksOf("r_work").map { it.id }.toSet()

        val split = (svc.updateRule(store.rules["r_work"]!!.toDraft().copy(weekdaysMask = 42), confirmSplit = true)
            as EditOutcome.Saved).split!!

        // UI 默认勾选 → 主按钮「确定」执行复制
        assertEquals("默认勾选时应复制 2 个任务", 2, svc.copyTasksTo(split.oldRuleId, split.newRuleId))

        val copied = store.tasksOf(split.newRuleId)
        assertEquals("新规则任务数 = 旧规则任务数", store.tasksOf(split.oldRuleId).size, copied.size)
        assertTrue("新任务必须用新 id", copied.map { it.id }.none { it in oldTasks })
        copied.forEach {
            assertEquals("新任务挂新规则", split.newRuleId, it.ruleId)
            assertEquals("复制出来的任务同样 dirty=1", 1, it.dirty)
        }
        assertEquals("旧任务仍挂旧规则", oldTasks, store.tasksOf(split.oldRuleId).map { it.id }.toSet())
        assertEquals("completion 行数不变", before, store.completions)
        assertEquals("复制不产生打卡记录", 0, store.completions.count { it.first in copied.map { t -> t.id } })
    }

    /** 手动取消勾选 → 新规则留空，旧规则任务与打卡都不动。 */
    @Test
    fun postSplitCopyUncheckedLeavesNewRuleWithoutTasks() {
        val store = seed()
        val before = store.completions.toList()
        val svc = service(store)
        val oldTasks = store.tasksOf("r_work").map { it.id }.toSet()

        val split = (svc.updateRule(store.rules["r_work"]!!.toDraft().copy(weekdaysMask = 42), confirmSplit = true)
            as EditOutcome.Saved).split!!

        // 取消勾选 → 不调用 copyTasksTo，等同于「确定」但不复制
        assertEquals("新规则应留空", 0, store.tasksOf(split.newRuleId).size)
        assertEquals("旧规则任务不动", oldTasks, store.tasksOf(split.oldRuleId).map { it.id }.toSet())
        assertEquals("completion 行数不变", before, store.completions)
    }
}

