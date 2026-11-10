package app.took.data

import app.took.alarm.ScheduleRow
import app.took.alarm.SqliteReminderScheduleStore
import app.took.alarm.SqliteSystemAlarmStore
import app.took.alarm.SystemAlarmRecord
import app.took.calendar.MonthGridLayout
import app.took.engine.Engine
import app.took.stats.StatsEngine
import app.took.stats.StatsResult
import java.time.LocalDate

/**
 * 一条规则 + 它下面的任务 + 它的提醒。
 *
 * reminder 为 null = 这条规则没有生效的提醒（没配、已软删、或 enabled=0）；
 * 任务没有自己的提醒行，一律继承所属规则的（契约 §11 开头）。
 */
data class RuleWithTasks(
    val rule: RuleRow,
    val tasks: List<TaskRow>,
    val ended: Boolean = false,
    val reminder: ReminderRow? = null,
)

/**
 * 数据通路：读月历 + 打卡写路径 + 规则/任务编辑写路径（契约 §9）。
 *
 * 编辑逻辑全部落在两个纯 Kotlin 类里，本类只做接线：
 *  - [RuleEditPolicy]：split 判定（§9.2）、封口上界、字段校验；
 *  - [RuleEditService]：写库（一律 updated_at=now + dirty=1 + 软删）。
 * 这样 E1~E6 能在 JVM 单测里断言，不需要跑模拟器。
 */
class TookRepository(
    private val db: TookDb,
    /** 配置页的置顶偏好（本机 SharedPreferences，不进库、不同步）；单测可注入内存实现。 */
    val pins: PinStore = PinStore.Empty,
) {

    private val checkin = CheckinService(SqliteCompletionDao(db))
    private val reminderStore = SqliteReminderStore(db)

    // 调度状态（定稿 §6.3.4）：只在本机，不参与同步
    private val schedules = SqliteReminderScheduleStore(db)
    // 已交给系统时钟的闹钟记账（Android 查不到也删不掉系统闹钟，只能自己记）
    private val systemAlarms = SqliteSystemAlarmStore(db)

    // 删规则要级联软删它的提醒（§9.3），所以规则写路径也拿到同一个提醒库
    private val editor = RuleEditService(SqliteRuleStore(db), reminders = reminderStore)
    private val memoEditor = MemoEditService(SqliteMemoStore(db))
    private val reminderEditor = ReminderEditService(reminderStore)

    /** 契约 §3.3：打卡键 = taskId + ":" + periodStart。 */
    fun doneKeys(): Set<String> {
        val out = HashSet<String>()
        db.readableDatabase.rawQuery(
            "SELECT task_id, period_start FROM completion WHERE deleted=0 AND status=1",
            null,
        ).use { c ->
            while (c.moveToNext()) out.add(Engine.completionKey(c.getString(0), c.getString(1)))
        }
        return out
    }

    fun rules(): List<RuleRow> {
        val out = ArrayList<RuleRow>()
        db.readableDatabase.rawQuery(
            """
            SELECT id, title, enabled, repeat_mode, weekdays_mask, repeat_every, month_day,
                   year_month, year_day, start_date, end_date, repeat_until
              FROM rule WHERE deleted=0 ORDER BY start_date, title
            """.trimIndent(),
            null,
        ).use { c ->
            while (c.moveToNext()) {
                out.add(
                    RuleRow(
                        id = c.getString(0),
                        title = c.getString(1),
                        enabled = c.getInt(2) == 1,
                        repeatMode = c.getInt(3),
                        weekdaysMask = c.getInt(4),
                        repeatEvery = if (c.isNull(5)) null else c.getInt(5),
                        monthDay = if (c.isNull(6)) null else c.getInt(6),
                        yearMonth = if (c.isNull(7)) null else c.getInt(7),
                        yearDay = if (c.isNull(8)) null else c.getInt(8),
                        startDate = c.getString(9),
                        endDate = if (c.isNull(10)) null else c.getString(10),
                        repeatUntil = if (c.isNull(11)) null else c.getString(11),
                    ),
                )
            }
        }
        return out
    }

    private fun tasksByRule(): Map<String, List<TaskRow>> {
        val map = HashMap<String, MutableList<TaskRow>>()
        db.readableDatabase.rawQuery(
            "SELECT id, rule_id, title, enabled, sort_order FROM task WHERE deleted=0 ORDER BY rule_id, sort_order",
            null,
        ).use { c ->
            while (c.moveToNext()) {
                val row = TaskRow(
                    id = c.getString(0),
                    ruleId = c.getString(1),
                    title = c.getString(2),
                    enabled = c.getInt(3) == 1,
                    sortOrder = c.getInt(4),
                )
                map.getOrPut(row.ruleId) { ArrayList() }.add(row)
            }
        }
        return map
    }

    /** 某天命中的任务 + 打卡状态；未命中返回空列表。 */
    fun loadDay(date: String): List<DayItem> = MonthExpander.itemsOn(date, rules(), tasksByRule(), doneKeys())

    /**
     * 42 格月历数据：周一起始，含补位的上月/下月日期。
     *
     * 记事（kind=0）只要落在 [start_date, end_date] 区间里就逐日命中，与任务一起进格子
     * （契约 §10.1 / §10.3 M2）；倒数日与笔记本永不进月历，所以只取 kind=0 那段。
     */
    fun loadGrid(year: Int, month: Int): List<DayCell> {
        val rules = rules()
        val tasks = tasksByRule()
        val done = doneKeys()
        val notes = listMemos(MemoKind.NOTE)
        return MonthGridLayout.dates(year, month).map { date ->
            val d = LocalDate.parse(date)
            DayCell(
                date = date,
                inMonth = d.year == year && d.monthValue == month,
                items = MonthExpander.itemsOn(date, rules, tasks, done),
                memos = MonthExpander.memosOn(date, notes),
            )
        }
    }

    /**
     * 连续滚动月历的数据：[fromDate, toDate] 覆盖到的每一周，每行周一到周日 7 格。
     *
     * 与 [loadGrid] 共用同一套展开（[MonthExpander.itemsOn] / [memosOn] / [doneKeys]），
     * 只是把「固定 42 格」换成「连续的周」——用户 2026-10-26 原话：
     * 「向下滑，日历就像一张长长的纸，一天一天、一周一周（一行一行）地连续往下滚动」。
     *
     * 整段只读一次库（规则 / 任务 / 打卡 / 记事各查一遍），再逐格展开 ——
     * 约 50 个月 ≈ 210 行的范围也是一次查询，滚动时不再碰数据库。
     */
    fun loadWeeks(fromDate: String, toDate: String): List<WeekRow> {
        val rules = rules()
        val tasks = tasksByRule()
        val done = doneKeys()
        val notes = listMemos(MemoKind.NOTE)
        // 规则→引擎只转一次：原来在 763 天 × N 规则的循环里每天重转，
        // 是「上下滑动一卡一卡」的主要来源（用户 2026-11-06）。
        val prepared = MonthExpander.prepare(rules, tasks)
        return WeekRows.build(fromDate, toDate) { date, inMonth ->
            DayCell(
                date = date,
                inMonth = inMonth,
                items = MonthExpander.itemsOn(date, prepared, done),
                memos = MonthExpander.memosOn(date, notes),
            )
        }
    }

    fun today(): String = LocalDate.now().toString()

    /* ------------------------- 倒数日卡片（定稿 §6.5） ------------------------- */

    /**
     * 首页倒数日卡片的数据源：memo 表 kind=1，按目标日升序。
     *
     * 「还有 N 天」（目标在未来）排在「已经 N 天」（目标已过去）之前，
     * 天数文案由 [app.took.ui.MemoFormats.countdown] 现算，与编辑页/配置页同一口径。
     */
    fun countdowns(today: String = today()): List<MemoRow> =
        MemoEditPolicy.countdownOrder(listMemos(MemoKind.COUNTDOWN), today)

    /* ------------------------- 统计分析（定稿 §3.7） ------------------------- */

    /** 现算一份统计：rule / task / completion 全部读当前库，不做任何缓存或写死。 */
    fun stats(rangeId: Int, today: String = today()): StatsResult {
        val rules = rules()
        return StatsEngine.compute(
            range = StatsEngine.range(rangeId, today, rules),
            rules = rules,
            tasksByRule = tasksByRule(),
            doneKeys = doneKeys(),
            today = today,
        )
    }

    /** 配置页：规则及其任务（含「是否已结束」，决定能否改重复设置）。 */
    fun loadRulesWithTasks(): List<RuleWithTasks> {
        val tasks = tasksByRule()
        val reminders = reminderEditor.ruleReminders()
        val today = today()
        return rules().map { rule ->
            RuleWithTasks(
                rule = rule,
                tasks = tasks[rule.id].orEmpty(),
                ended = RuleEditPolicy.isEnded(rule, today),
                reminder = reminders[rule.id],
            )
        }
    }

    fun ruleWithTasks(ruleId: String): RuleWithTasks? = loadRulesWithTasks().firstOrNull { it.rule.id == ruleId }

    /* ------------------------- 配置页类型导航 + 置顶（本机偏好） ------------------------- */

    /** 某一类的置顶 id 顺序（本机偏好，不进库、不同步）。 */
    fun pinnedIds(category: String): List<String> = pins.pinned(category)

    /** 置顶 / 取消置顶：写完即返回新顺序，调用方直接拿去排序。 */
    fun togglePin(category: String, id: String): List<String> {
        val next = ConfigListLogic.togglePin(pinnedIds(category), id)
        pins.save(category, next)
        return next
    }

    /** 规则列表按置顶顺序排好（未置顶的保持原来的 start_date/title 相对顺序）。 */
    fun loadPinnedRules(): List<RuleWithTasks> {
        val pinned = pinnedIds(ConfigCategory.RULE)
        return ConfigListLogic.pinFirst(loadRulesWithTasks(), pinned) { it.rule.id }
    }

    /** 某类 memo 按置顶顺序排好；kind 为空 = 三类全要。 */
    fun loadPinnedMemos(kind: Int? = null): List<MemoRow> {
        val pinned = when (kind) {
            MemoKind.NOTE -> pinnedIds(ConfigCategory.NOTE)
            MemoKind.COUNTDOWN -> pinnedIds(ConfigCategory.COUNTDOWN)
            MemoKind.NOTEBOOK -> pinnedIds(ConfigCategory.NOTEBOOK)
            else -> emptyList()
        }
        return ConfigListLogic.pinFirst(listMemos(kind), pinned) { it.id }
    }


    /* ------------------------------ 编辑写路径 ------------------------------ */

    fun createRule(draft: RuleDraft, taskTitles: List<String>): EditOutcome = editor.createRule(draft, taskTitles)

    fun updateRule(draft: RuleDraft, confirmSplit: Boolean = false): EditOutcome =
        editor.updateRule(draft, confirmSplit)

    fun deleteRule(ruleId: String): EditOutcome = editor.deleteRule(ruleId)

    fun addTask(ruleId: String, title: String): String? = editor.addTask(ruleId, title)

    fun renameTask(taskId: String, title: String): String? = editor.renameTask(taskId, title)

    fun setTaskEnabled(taskId: String, enabled: Boolean): String? = editor.setTaskEnabled(taskId, enabled)

    fun deleteTask(taskId: String): String? = editor.deleteTask(taskId)

    fun copyTasksTo(sourceRuleId: String, targetRuleId: String): Int = editor.copyTasksTo(sourceRuleId, targetRuleId)

    fun taskCount(ruleId: String): Int = editor.taskCount(ruleId)

    /**
     * 打卡写路径：status 0/1 + 新 updated_at + dirty=1。
     * 键是 (taskId, periodStart)，所以同一周期内所有命中日一起变；取消打卡同样走这里。
     */
    /* --------------------- 记事 / 倒数日 / 笔记本（契约 §10） --------------------- */

    /** 列表：kind 为空 = 三类全要；只返回未删的行。 */
    fun listMemos(kind: Int? = null): List<MemoRow> = memoEditor.listMemos(kind)

    /** 编辑页按 id 取一行（已软删视为不存在）。 */
    fun memo(id: String): MemoRow? = memoEditor.memo(id)

    fun createMemo(draft: MemoDraft): MemoOutcome = memoEditor.createMemo(draft)

    fun updateMemo(draft: MemoDraft): MemoOutcome = memoEditor.updateMemo(draft)

    fun deleteMemo(id: String): MemoOutcome = memoEditor.deleteMemo(id)

    /* ------------------------- 笔记本分类管理（§10.2） ------------------------- */

    /** 分类现状（名 + 条数），供分类管理页与改名/删除前的影响条数使用。 */
    fun categories(): List<CategoryStat> = memoEditor.categories()

    fun renameCategory(from: String, to: String): CategoryOutcome = memoEditor.renameCategory(from, to)

    fun deleteCategory(name: String): CategoryOutcome = memoEditor.deleteCategory(name)

    /* ------------------------------- 提醒（契约 §11） ------------------------------- */

    /** 编辑页按规则取提醒：已软删视为没有。 */
    fun reminderOf(ruleId: String): ReminderRow? = reminderEditor.reminderOf(ReminderOwner.RULE, ruleId)

    fun saveReminder(draft: ReminderDraft): ReminderOutcome = reminderEditor.save(draft)

    /** 「不提醒」（§11.1 互斥重置 → §11.4 R3）：软删该行。 */
    fun clearReminder(ruleId: String): ReminderOutcome = reminderEditor.clear(ReminderOwner.RULE, ruleId)

    /** 按 id 取规则：闹钟触发的 receiver 只有 reminder_id，要自己走回规则。 */
    fun rule(id: String): RuleRow? = rules().firstOrNull { it.id == id }

    /** 按 id 取提醒行（**含软删**，receiver 要自己判 deleted / enabled）。 */
    fun reminder(id: String): ReminderRow? = reminderStore.reminder(id)

    /** 生效中的规则提醒：调度器**只排这些**（未配 / 软删 / enabled=0 一律不排）。 */
    fun activeRuleReminders(): Map<String, ReminderRow> = reminderEditor.ruleReminders()

    /* --------------------- 调度状态（定稿 §6.3.4，不参与同步） --------------------- */

    fun schedules(): List<ScheduleRow> = schedules.schedules()

    fun schedule(reminderId: String): ScheduleRow? = schedules.schedule(reminderId)

    fun putSchedule(row: ScheduleRow) = schedules.putSchedule(row)

    fun deleteSchedule(reminderId: String) = schedules.deleteSchedule(reminderId)

    /* ----------------- 系统时钟闹钟记账（定稿 §6.3.2，不参与同步） ----------------- */

    fun systemAlarms(): List<SystemAlarmRecord> = systemAlarms.systemAlarms()

    fun systemAlarm(ruleId: String): SystemAlarmRecord? = systemAlarms.systemAlarm(ruleId)

    fun putSystemAlarm(record: SystemAlarmRecord) = systemAlarms.putSystemAlarm(record)

    fun deleteSystemAlarm(ruleId: String) = systemAlarms.deleteSystemAlarm(ruleId)

    fun setDone(taskId: String, periodStart: String, done: Boolean): Boolean =
        checkin.setDone(taskId, periodStart, done).status == 1

    fun isDone(taskId: String, periodStart: String): Boolean = checkin.isDone(taskId, periodStart)
}
