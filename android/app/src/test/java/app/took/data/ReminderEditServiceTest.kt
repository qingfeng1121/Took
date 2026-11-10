package app.took.data

import app.took.engine.RepeatMode
import app.took.sync.FakeSyncApi
import app.took.sync.MemorySyncStore
import app.took.sync.SyncManager
import app.took.ui.ReminderFormat
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 契约 §11.4 的 R1~R5：提醒的存 / 显示 / 同步。
 *
 * 库换成内存实现（[ReminderStore] 端口），摘要与三按钮状态机走生产代码
 * [ReminderFormat] / [ReminderEditPolicy]，同步走生产代码 SyncManager → Merge → Json，
 * 与真机同一条路径，不需要模拟器。
 *
 * 一个契约层面的口径说明：reminder.schema.json 只有**一个** time_of_day（精确到分钟），
 * 没有分通道时间。所以「通知 21:00 + 闹钟 09:00」这种两个不同时间的摘要在这份 schema 下
 * 不可能出现——同时在开时两个通道共用同一个时间，摘要形如「通知 21:00 + 闹钟 21:00」。
 * R2 因此按「开闹钟时把时间改成 09:00」来断言拼接格式。
 */
class ReminderEditServiceTest {

    private class MemoryReminderStore : ReminderStore {
        val rows = LinkedHashMap<String, ReminderRow>()
        override fun reminder(id: String): ReminderRow? = rows[id]
        override fun reminders(): List<ReminderRow> = rows.values.toList()
        override fun putReminder(reminder: ReminderRow) {
            rows[reminder.id] = reminder
        }

        fun alive(): List<ReminderRow> = rows.values.filter { it.deleted == 0 }
    }

    /** 只为级联删除用的最小规则库。 */
    private class MemoryRuleStore : RuleStore {
        val rules = LinkedHashMap<String, RuleRow>()
        val tasks = LinkedHashMap<String, TaskRow>()
        override fun rule(id: String): RuleRow? = rules[id]
        override fun rules(): List<RuleRow> = rules.values.toList()
        override fun putRule(rule: RuleRow) {
            rules[rule.id] = rule
        }

        override fun task(id: String): TaskRow? = tasks[id]
        override fun tasksOf(ruleId: String): List<TaskRow> =
            tasks.values.filter { it.ruleId == ruleId && it.deleted == 0 }

        override fun allTasks(): List<TaskRow> = tasks.values.toList()
        override fun putTask(task: TaskRow) {
            tasks[task.id] = task
        }
    }

    private var now = 1_700_000_000_000L

    private fun service(store: MemoryReminderStore, id: String = "rm_gen") =
        ReminderEditService(store = store, clock = { now }, idGen = { id })

    private fun ruleDraft(
        id: String = "",
        notify: Boolean,
        alarm: Boolean,
        time: String = "21:00",
        text: String = "",
        eachDay: Boolean = true,
    ) = ReminderDraft(
        id = id,
        ownerKind = ReminderOwner.RULE,
        ownerId = "r_work",
        notifyOn = notify,
        alarmOn = alarm,
        timeOfDay = time,
        notifyText = text,
        repeatRule = if (eachDay) 1 else 0,
        enabled = true,
    )

    /* ------------------------------ R1 ------------------------------ */

    /** R1：规则配「通知 21:00」→ notify_on=1、alarm_on=0、dirty=1；摘要「通知 21:00」。 */
    @Test
    fun r1_notifyOnlyPersistsDirtyAndShowsNotifySummary() {
        val store = MemoryReminderStore()
        val svc = service(store)

        val outcome = svc.save(ruleDraft(notify = true, alarm = false, time = "21:00"))

        assertTrue("落库成功：" + outcome, outcome is ReminderOutcome.Saved)
        val row = store.reminder("rm_gen")!!
        assertEquals("notify_on=1", true, row.notifyOn)
        assertEquals("alarm_on=0", false, row.alarmOn)
        assertEquals("time_of_day=21:00", "21:00", row.timeOfDay)
        assertEquals("owner_kind=0（挂规则）", ReminderOwner.RULE, row.ownerKind)
        assertEquals("owner_id=规则 id", "r_work", row.ownerId)
        assertEquals("dirty=1 才会被推送", 1, row.dirty)
        assertEquals("updated_at 用时钟", now, row.updatedAt)
        assertEquals("新建 rev=0", 0L, row.rev)
        assertEquals("摘要", "通知 21:00", ReminderFormat.summary(row))
        assertEquals("规则列表能取到", "rm_gen", svc.ruleReminders()["r_work"]?.id)
    }

    /* ------------------------------ R2 ------------------------------ */

    /** R2：再开闹钟（时间 09:00）→ notify_on=1、alarm_on=1；摘要「… + …」。 */
    @Test
    fun r2_alarmAddedKeepsBothSwitchesAndSummaryJoinsBoth() {
        val store = MemoryReminderStore()
        val svc = service(store)
        svc.save(ruleDraft(notify = true, alarm = false, time = "21:00"))

        now += 5_000
        val outcome = svc.save(ruleDraft(id = "rm_gen", notify = true, alarm = true, time = "09:00"))

        assertTrue("原地改成功：" + outcome, outcome is ReminderOutcome.Saved)
        val row = store.reminder("rm_gen")!!
        assertEquals("notify_on 保持 1", true, row.notifyOn)
        assertEquals("alarm_on 变 1", true, row.alarmOn)
        assertEquals("一个宿主只有一行", 1, store.rows.size)
        assertEquals("改是原地改，id 不变", "rm_gen", row.id)
        assertEquals("updated_at 前进", now, row.updatedAt)
        assertEquals("摘要两个通道都带时间", "通知 09:00 + 闹钟 09:00", ReminderFormat.summary(row))

        // 同一时间时同样是「 + 」拼接（schema 只有单个 time_of_day）
        now += 5_000
        svc.save(ruleDraft(id = "rm_gen", notify = true, alarm = true, time = "21:00"))
        assertEquals(
            "两个通道共用同一个时间",
            "通知 21:00 + 闹钟 21:00",
            ReminderFormat.summary(store.reminder("rm_gen")!!),
        )
    }

    /* ------------------------------ R3 ------------------------------ */

    /** R3：点「不提醒」→ 该行软删、dirty=1；摘要不再显示。 */
    @Test
    fun r3_clickingNoneSoftDeletesAndHidesSummary() {
        val store = MemoryReminderStore()
        val svc = service(store)
        svc.save(ruleDraft(notify = true, alarm = true, time = "21:00"))
        val before = store.reminder("rm_gen")!!

        now += 7_000
        val outcome = svc.clear(ReminderOwner.RULE, "r_work")

        assertTrue("清除成功：" + outcome, outcome is ReminderOutcome.Cleared)
        val row = store.reminder("rm_gen")!!
        assertEquals("删之前是活着的", 0, before.deleted)
        assertEquals("软删而不是物理删除（否则会被另一端同步回来复活）", 1, row.deleted)
        assertEquals("dirty=1 让墓碑能推上去", 1, row.dirty)
        assertEquals("updated_at = now", now, row.updatedAt)
        assertNull("规则上不再有生效的提醒", svc.reminderOf(ReminderOwner.RULE, "r_work"))
        assertNull("列表摘要取不到", svc.ruleReminders()["r_work"])
        assertTrue("行还在库里（墓碑）", store.rows.containsKey("rm_gen"))
        assertEquals("没有提醒行时再清一次也不报错", "", (svc.clear(ReminderOwner.RULE, "r_work") as ReminderOutcome.Cleared).reminderId)
    }

    /* ------------------------------ R4 ------------------------------ */

    /** R4：两个开关都关的提醒，写入层必须拒绝，且一个字都不落库。 */
    @Test
    fun r4_bothSwitchesOffIsRejectedByWriteLayer() {
        val store = MemoryReminderStore()
        val svc = service(store)

        val outcome = svc.save(ruleDraft(notify = false, alarm = false))

        assertTrue("必须是 Invalid：" + outcome, outcome is ReminderOutcome.Invalid)
        val errors = (outcome as ReminderOutcome.Invalid).errors
        assertTrue(
            "错误里说明「至少要开一个」：" + errors,
            errors.any { it.contains("至少要开一个") },
        )
        assertTrue("没有任何行落库", store.rows.isEmpty())
        assertEquals("库里没有行，摘要也就无从显示", "不提醒", ReminderFormat.summaryOf(false, false, "21:00"))
    }

    /* ------------------------------ R5 ------------------------------ */

    /** R5：提醒随规则一起同步 —— push 后服务端 reminder 表有该行，另一台 pull 得到。 */
    @Test
    fun r5_reminderTravelsWithItsRuleThroughPushAndPull() {
        val store = MemoryReminderStore()
        val svc = service(store)
        svc.save(ruleDraft(notify = true, alarm = true, time = "21:00"))

        val local = MemorySyncStore().also { it.putReminder(store.reminder("rm_gen")!!) }
        val api = FakeSyncApi()

        val push = SyncManager(local, api).syncOnce()

        assertTrue("同步成功：" + push.error, push.ok)
        assertEquals("推送 1 条", 1, push.pushed)
        assertEquals("push 成功后 dirty 清零", 0, local.dirtyCount())
        assertTrue("报文里有 reminders 数组", api.pushBodies.first().contains("\"reminders\""))
        val serverRow = assertNotNull("服务端 reminder 表有该行", api.rows("reminders")["rm_gen"]).let { api.rows("reminders")["rm_gen"]!! }
        assertEquals("owner_kind=0", 0L, serverRow["owner_kind"])
        assertEquals("owner_id 指向规则", "r_work", serverRow["owner_id"])
        assertEquals("notify_on=1", 1L, serverRow["notify_on"])
        assertEquals("alarm_on=1", 1L, serverRow["alarm_on"])
        assertEquals("time_of_day 原样过去", "21:00", serverRow["time_of_day"])

        // 另一台机器：同一个服务端，pull 得到同一条
        val other = MemorySyncStore()
        val pull = SyncManager(other, api).syncOnce()

        assertTrue("另一台同步成功：" + pull.error, pull.ok)
        assertEquals("拉到 1 条", 1, pull.pulled)
        val pulled = other.rows["rm_gen"]!!
        assertEquals("拉下来的提醒仍是两个通道都开", 1L, pulled["notify_on"])
        assertEquals(1L, pulled["alarm_on"])
        assertEquals("拉下来的行不是脏的", 0L, pulled["dirty"])
        assertEquals("协议表名 → 本地表名", "reminder", app.took.sync.SyncTables.sqlTable("reminders"))
        assertEquals("提醒表主键就是 id", listOf("id"), app.took.sync.SyncTables.pkColumns("reminders"))
    }

    /* --------------------- 契约补条：删除规则级联软删提醒 §9.3 --------------------- */

    /** 删除规则时，该规则的提醒一并软删（deleted=1、updated_at=now、dirty=1）。 */
    @Test
    fun deleteRuleCascadesSoftDeleteToItsReminder() {
        val reminderStore = MemoryReminderStore()
        val svc = service(reminderStore)
        svc.save(ruleDraft(notify = true, alarm = true, time = "21:00"))

        val ruleStore = MemoryRuleStore()
        ruleStore.putRule(
            RuleRow(
                id = "r_work", title = "工作日常规", enabled = true,
                repeatMode = RepeatMode.WEEKLY, weekdaysMask = 31,
                repeatEvery = null, monthDay = null, yearMonth = null, yearDay = null,
                startDate = "2026-10-01", endDate = null, repeatUntil = null,
                updatedAt = 1, dirty = 0,
            ),
        )
        ruleStore.putTask(TaskRow(id = "t_fit", ruleId = "r_work", title = "健身", enabled = true, sortOrder = 0))
        val editor = RuleEditService(ruleStore, clock = { now }, reminders = reminderStore)

        now += 3_000
        val outcome = editor.deleteRule("r_work")

        assertTrue("删除成功：" + outcome, outcome is EditOutcome.Deleted)
        val row = reminderStore.reminder("rm_gen")!!
        assertEquals("提醒随规则一起软删", 1, row.deleted)
        assertEquals("updated_at = now", now, row.updatedAt)
        assertEquals("dirty=1 让墓碑能推上去", 1, row.dirty)
        assertNull("规则上不再有生效的提醒", svc.reminderOf(ReminderOwner.RULE, "r_work"))
        assertNull("列表摘要也跟着消失", svc.ruleReminders()["r_work"])
    }

    /**
     * 墓碑豁免（§11.1）：删除时常先把两个开关清零再打删除标记，
     * 这条路不能被「至少开一个」拦下 —— 否则删除永远同步不到对端。
     */
    @Test
    fun tombstoneWithBothSwitchesClearedIsNotBlockedByValidation() {
        val store = MemoryReminderStore()
        val svc = service(store)
        // 模拟另一端先清零、还没打删除标记的中间行
        store.putReminder(
            ReminderRow(
                id = "rm_legacy", ownerKind = ReminderOwner.RULE, ownerId = "r_work",
                notifyOn = false, alarmOn = false, timeOfDay = "21:00",
                updatedAt = now - 1_000, dirty = 0,
            ),
        )

        val outcome = svc.clear(ReminderOwner.RULE, "r_work")

        assertTrue("墓碑能写下去：" + outcome, outcome is ReminderOutcome.Cleared)
        val row = store.reminder("rm_legacy")!!
        assertEquals("deleted=1", 1, row.deleted)
        assertEquals("dirty=1 让墓碑推得上去", 1, row.dirty)
        assertEquals("开关保持清零的样子", false, row.notifyOn || row.alarmOn)
        // 存活行仍然严格校验：同样的开关组合，保存必被拒（R4 不因墓碑豁免而放松）
        assertTrue(
            "存活行（deleted=0）不许两个都关",
            svc.save(ruleDraft(notify = false, alarm = false)) is ReminderOutcome.Invalid,
        )
    }

    /* ------------------------- R1~R5 的公共前提 ------------------------- */

    /**
     * 三按钮状态机：穷举长度 1~4 的所有点击序列，断言**从来不出现「三项全灭」**，
     * 且「不提醒」的亮 = 两个开关都关（§11.1 的真实语义，不是三选一）。
     */
    @Test
    fun reminderButtonSequencesNeverTurnAllThreeOff() {
        val buttons = ReminderButton.ALL
        var sequences = 0

        fun walk(prefix: List<Int>) {
            var state = ReminderPicker(notifyOn = false, alarmOn = false)
            prefix.forEach { button -> state = ReminderEditPolicy.click(state, button) }
            assertTrue(
                "点击序列 " + prefix.map { ReminderButton.label(it) } + " 后三项全灭：" + state,
                state.pressedCount >= 1,
            )
            assertEquals(
                "「不提醒」的亮 = 两个开关都关：" + prefix,
                state.isNone,
                state.pressed(ReminderButton.NONE),
            )
            assertEquals(
                "通知按钮的亮 = notifyOn：" + prefix,
                state.notifyOn,
                state.pressed(ReminderButton.NOTIFY),
            )
            assertEquals(
                "闹钟按钮的亮 = alarmOn：" + prefix,
                state.alarmOn,
                state.pressed(ReminderButton.ALARM),
            )
            if (prefix.size < 4) buttons.forEach { walk(prefix + it) }
        }

        buttons.forEach { first ->
            walk(listOf(first))
            sequences++
            buttons.forEach { second ->
                walk(listOf(first, second))
                sequences++
            }
        }

        assertEquals(
            "点「不提醒」= 互斥重置",
            ReminderPicker(false, false),
            ReminderEditPolicy.click(ReminderPicker(true, true), ReminderButton.NONE),
        )
        assertEquals(
            "通知独立切换：闹钟不受影响",
            ReminderPicker(false, true),
            ReminderEditPolicy.click(ReminderPicker(true, true), ReminderButton.NOTIFY),
        )
        assertEquals(
            "通知独立切换：闹钟不受影响",
            ReminderPicker(true, false),
            ReminderEditPolicy.click(ReminderPicker(true, true), ReminderButton.ALARM),
        )
        assertTrue("确实枚举了多条序列：" + sequences, sequences >= 12)
    }
}
