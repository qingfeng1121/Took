package app.took.data

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper

/**
 * 本地库：四张表，字段与 docs/schema 下的 *.json 及 server/internal/store/schema.sql 一致。
 *
 * 为什么手写 SQLiteOpenHelper 而不是 Room：
 *  1. 首期只读，没有迁移 / Flow 观察 / 关系映射的需求，Room 的收益拿不到；
 *  2. Room 依赖 KSP 注解处理器，KSP 版本必须与 Kotlin 精确对齐，本机 Gradle 缓存里
 *     没有 KSP 产物（实测 caches/modules-2/files-2.1/com.google.devtools.ksp 为空），
 *     引入即多一层解析风险；SQLiteOpenHelper 是框架类，零额外依赖。
 * 后续需要增量同步与迁移时再上 Room 也不迟——建表 DDL 可以照搬。
 */
class TookDb(context: Context) : SQLiteOpenHelper(context, NAME, null, VERSION) {

    override fun onCreate(db: SQLiteDatabase) {
        SCHEMA.forEach { db.execSQL(it) }
        seed(db)
    }

    /**
     * 增量升级，只有 CREATE IF NOT EXISTS，没有 DROP —— 软删语义要求永不物理删除。
     *  v1 → v2：新增 reminder 表（契约 §11）；
     *  v2 → v3：新增 reminder_schedule 表（定稿 §6.3.4 的「实际注册的闹钟」+ 贪睡状态）。
     */
    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
        if (oldVersion < 2) {
            REMINDER_DDL.forEach { db.execSQL(it) }
        }
        if (oldVersion < 3) {
            SCHEDULE_DDL.forEach { db.execSQL(it) }
        }
        if (oldVersion < 4) {
            SYSTEM_ALARM_DDL.forEach { db.execSQL(it) }
        }
    }

    /**
     * 与 Go 后端 ensureSeed 逐条一致：4 条规则 / 5 个任务，
     * 并把「健身」在本周（2026-10-19 起）的周期置为已完成。
     * 只在 rule 表为空时写入，避免重复插入。
     */
    private fun seed(db: SQLiteDatabase) {
        if (hasAnyRule(db)) return
        val now = System.currentTimeMillis()

        fun rule(
            id: String, title: String, mode: Int, start: String,
            mask: Int = 0, every: Int? = null, monthDay: Int? = null,
            yearMonth: Int? = null, yearDay: Int? = null,
        ) {
            val v = ContentValues().apply {
                put("id", id)
                put("title", title)
                put("enabled", 1)
                put("repeat_mode", mode)
                put("weekdays_mask", mask)
                put("repeat_every", every)
                put("month_day", monthDay)
                put("year_month", yearMonth)
                put("year_day", yearDay)
                put("start_date", start)
                putNull("end_date")
                putNull("repeat_until")
                put("rev", 0)
                put("updated_at", now)
                put("deleted", 0)
                put("dirty", 0)
            }
            db.insertOrThrow("rule", null, v)
        }

        fun task(id: String, ruleId: String, title: String, sortOrder: Int) {
            val v = ContentValues().apply {
                put("id", id)
                put("rule_id", ruleId)
                put("title", title)
                put("enabled", 1)
                put("sort_order", sortOrder)
                put("rev", 0)
                put("updated_at", now)
                put("deleted", 0)
                put("dirty", 0)
            }
            db.insertOrThrow("task", null, v)
        }

        // 工作日常规：每周一~周五，两个任务
        rule("r_work", "工作日常规", 0, "2026-10-01", mask = 31)
        task("t_fit", "r_work", "健身", 0)
        task("t_early", "r_work", "早起", 1)
        // 单词打卡：每 1 天
        rule("r_words", "单词打卡", 1, "2026-10-01", every = 1)
        task("t_words", "r_words", "背单词", 0)
        // 房租：每月 20 日
        rule("r_rent", "房租", 2, "2026-01-01", monthDay = 20)
        task("t_rent", "r_rent", "交房租", 0)
        // 年度体检：每年 3/15
        rule("r_med", "年度体检", 3, "2026-01-01", yearMonth = 3, yearDay = 15)
        task("t_med", "r_med", "体检", 0)

        // 演示打卡：本周（2026-10-19 起）的健身已完成
        val c = ContentValues().apply {
            put("task_id", "t_fit")
            put("period_start", "2026-10-19")
            put("status", 1)
            put("rev", 0)
            put("updated_at", now)
            put("deleted", 0)
            put("dirty", 0)
        }
        db.insertOrThrow("completion", null, c)
    }

    private fun hasAnyRule(db: SQLiteDatabase): Boolean {
        db.rawQuery("SELECT COUNT(*) FROM rule", null).use { c ->
            return c.moveToFirst() && c.getInt(0) > 0
        }
    }

    companion object {
        const val NAME = "took.db"

        /** 4 = 加了 system_alarm（交给系统时钟的闹钟记账）；3 = reminder_schedule；2 = reminder。 */
        const val VERSION = 4

        /**
         * 全应用共用一个 helper。
         *
         * 提醒链路会在 4 个地方同时要库：Activity（界面）、BroadcastReceiver（响铃）、
         * BootReceiver（重排）、Compose 里的调度器。每个地方 new 一个 SQLiteOpenHelper 就是
         * 多条连接 + 各自的升级状态，是 sleep 与 database locked 的经典来源，所以收成一个。
         */
        @Volatile
        private var sharedInstance: TookDb? = null

        fun shared(context: Context): TookDb =
            sharedInstance ?: synchronized(this) {
                sharedInstance ?: TookDb(context.applicationContext).also { sharedInstance = it }
            }

        /**
         * reminder 表（契约 §11 / docs/schema/reminder.schema.json）。
         *
         * notify_on 与 alarm_on 是**两个独立布尔**，schema 的 anyOf 要求至少开一个；
         * 本地是裸 SQLite，DDL 写不出这种跨列约束，闸门放在 ReminderEditPolicy.validate（R4）。
         */
        private val REMINDER_DDL = listOf(
            """

            CREATE TABLE IF NOT EXISTS reminder (
              id          TEXT PRIMARY KEY,
              owner_kind  INTEGER NOT NULL,
              owner_id    TEXT NOT NULL,
              notify_on   INTEGER NOT NULL DEFAULT 0,
              alarm_on    INTEGER NOT NULL DEFAULT 0,
              time_of_day TEXT NOT NULL,
              notify_text TEXT,
              offset_days INTEGER NOT NULL DEFAULT 0,
              repeat_rule INTEGER NOT NULL DEFAULT 0,
              snooze_min  INTEGER NOT NULL DEFAULT 0,
              enabled     INTEGER NOT NULL DEFAULT 1,
              rev         INTEGER NOT NULL DEFAULT 0,
              updated_at  INTEGER NOT NULL,
              deleted     INTEGER NOT NULL DEFAULT 0,
              dirty       INTEGER NOT NULL DEFAULT 0
            )
            """.trimIndent(),
            "CREATE INDEX IF NOT EXISTS idx_reminder_owner ON reminder(owner_kind, owner_id)",
        )

        /**
         * reminder_schedule（定稿 §6.3.4）：每条提醒**当前排上的那一次**。
         *
         * 一行 = 一个 PendingIntent 的真身：occur_date 是周期命中日，fire_at 是要响的毫秒时刻，
         * 贪睡把它往后推并记 snooze_count，响过写 fired_at。UI 的「下一次提醒」读的就是这张表。
         * 它**不是**同步表（rev/updated_at/dirty 一套都没有）—— 调度是设备本地的既有事实，
         * 换台手机要重新按自己的时区与权限算，同步过去只会制造两头不一致。
         */
        private val SCHEDULE_DDL = listOf(
            """
            CREATE TABLE IF NOT EXISTS reminder_schedule (
              reminder_id  TEXT PRIMARY KEY,
              rule_id      TEXT NOT NULL,
              occur_date   TEXT NOT NULL DEFAULT '',
              fire_at      INTEGER NOT NULL,
              snooze_count INTEGER NOT NULL DEFAULT 0,
              fired_at     INTEGER,
              updated_at   INTEGER NOT NULL DEFAULT 0
            )
            """.trimIndent(),
            "CREATE INDEX IF NOT EXISTS idx_schedule_fire ON reminder_schedule(fire_at)",
        )

        /**
         * system_alarm：已经交给系统时钟 App 的闹钟（本地记账，绝不参与同步）。
         *
         * fingerprint 是去重键：同一规则、同一时刻、同一重复星期集合 = 同一个系统闹钟。
         * 一次性闹钟把目标日期也编进指纹，所以响过之后下一次会算出新指纹、另建一条 ——
         * 旧那条删不掉，由设置页明确提示用户去时钟里删（不假装自动清理）。
         */
        private val SYSTEM_ALARM_DDL = listOf(
            """
            CREATE TABLE IF NOT EXISTS system_alarm (
              rule_id     TEXT PRIMARY KEY,
              reminder_id TEXT NOT NULL,
              label       TEXT NOT NULL,
              hour        INTEGER NOT NULL,
              minute      INTEGER NOT NULL,
              days        TEXT NOT NULL DEFAULT '',
              fingerprint TEXT NOT NULL,
              created_at  INTEGER NOT NULL DEFAULT 0
            )
            """.trimIndent(),
        )

        /** 与 server/internal/store/schema.sql 同构。 */
        private val SCHEMA = listOf(
            """
            CREATE TABLE IF NOT EXISTS rule (
              id            TEXT PRIMARY KEY,
              title         TEXT NOT NULL,
              enabled       INTEGER NOT NULL DEFAULT 1,
              repeat_mode   INTEGER NOT NULL,
              weekdays_mask INTEGER NOT NULL DEFAULT 0,
              repeat_every  INTEGER,
              month_day     INTEGER,
              year_month    INTEGER,
              year_day      INTEGER,
              start_date    TEXT NOT NULL,
              end_date      TEXT,
              repeat_until  TEXT,
              rev           INTEGER NOT NULL DEFAULT 0,
              updated_at    INTEGER NOT NULL,
              deleted       INTEGER NOT NULL DEFAULT 0,
              dirty         INTEGER NOT NULL DEFAULT 0
            )
            """.trimIndent(),
            """
            CREATE TABLE IF NOT EXISTS task (
              id          TEXT PRIMARY KEY,
              rule_id     TEXT NOT NULL REFERENCES rule(id),
              title       TEXT NOT NULL,
              enabled     INTEGER NOT NULL DEFAULT 1,
              sort_order  INTEGER NOT NULL DEFAULT 0,
              rev         INTEGER NOT NULL DEFAULT 0,
              updated_at  INTEGER NOT NULL,
              deleted     INTEGER NOT NULL DEFAULT 0,
              dirty       INTEGER NOT NULL DEFAULT 0
            )
            """.trimIndent(),
            "CREATE INDEX IF NOT EXISTS idx_task_rule ON task(rule_id)",
            """
            CREATE TABLE IF NOT EXISTS completion (
              task_id       TEXT NOT NULL REFERENCES task(id),
              period_start  TEXT NOT NULL,
              status        INTEGER NOT NULL DEFAULT 0,
              rev           INTEGER NOT NULL DEFAULT 0,
              updated_at    INTEGER NOT NULL,
              deleted       INTEGER NOT NULL DEFAULT 0,
              dirty         INTEGER NOT NULL DEFAULT 0,
              PRIMARY KEY (task_id, period_start)
            )
            """.trimIndent(),
            "CREATE INDEX IF NOT EXISTS idx_completion_period ON completion(period_start)",
            """
            CREATE TABLE IF NOT EXISTS memo (
              id          TEXT PRIMARY KEY,
              kind        INTEGER NOT NULL,
              title       TEXT NOT NULL,
              content     TEXT,
              start_date  TEXT,
              end_date    TEXT,
              category    TEXT,
              rev         INTEGER NOT NULL DEFAULT 0,
              updated_at  INTEGER NOT NULL,
              deleted     INTEGER NOT NULL DEFAULT 0,
              dirty       INTEGER NOT NULL DEFAULT 0
            )
            """.trimIndent(),
        ) + REMINDER_DDL + SCHEDULE_DDL + SYSTEM_ALARM_DDL
    }
}
