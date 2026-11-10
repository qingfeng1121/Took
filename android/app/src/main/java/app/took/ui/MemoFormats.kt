package app.took.ui

import app.took.engine.DateKeys
import java.time.Instant
import java.time.ZoneId

/**
 * memo 的展示格式化（纯 Kotlin，无 Android 依赖，可直接跑 JVM 单测）。
 *
 * 口径与契约 §10.4 / PC 端 app.js 的 noteRangeLabel / stampText 一致：
 *  - 记事元信息：`10/27 ~ 10/29`、`10/20`、`未排期`；
 *  - 笔记本元信息：`更新于 10月24日 下午6:24 ｜ N 字`（**不是**「创建日」——
 *    memo 表只有 updated_at，没有 created_at，也不为此加列）。
 */
object MemoFormats {

    /** 记事的短日期段：未排期 / 10/20 / 10/27 ~ 10/29。 */
    fun rangeShort(start: String?, end: String?): String {
        val s = start?.trim().orEmpty()
        if (s.isEmpty()) return "未排期"
        val e = end?.trim().orEmpty()
        if (e.isEmpty() || e == s) return md(s)
        return md(s) + " ~ " + md(e)
    }

    /** 记事的完整日期段（列表副标题用）：未排期 / 2026-10-20 / 2026-10-27 ~ 2026-10-29。 */
    fun rangeFull(start: String?, end: String?): String {
        val s = start?.trim().orEmpty()
        if (s.isEmpty()) return "未排期"
        val e = end?.trim().orEmpty()
        if (e.isEmpty() || e == s) return s
        return s + " ~ " + e
    }

    /**
     * 倒数日卡片底部的紧凑目标日：`2026-02-06` → `2026.2.6`（**点分隔、月和日都不补零**）。
     *
     * 与 [rangeFull] 的 `2026-02-06` 是两个用途：rangeFull 是列表副标题（契约 §10.4 的横线格式），
     * 这里专给倒数日卡（参考图就是 `2026.2.6`）。解析不了就原样回显（含空值 → 未排期）。
     */
    fun compactDate(key: String?): String {
        val s = key?.trim().orEmpty()
        if (s.isEmpty()) return "未排期"
        val d = runCatching { DateKeys.parse(s) }.getOrNull() ?: return s
        return d.year.toString() + "." + d.monthValue + "." + d.dayOfMonth
    }

    /** `2026-10-27` → `10/27`；解析不了就原样回显，绝不因为一行脏数据抛异常。 */
    fun md(key: String): String {
        val d = runCatching { DateKeys.parse(key) }.getOrNull() ?: return key
        return d.monthValue.toString() + "/" + d.dayOfMonth
    }

    /** 字数只数非空白字符，与 PC 的 wordsOf 同一口径。 */
    fun words(content: String?): Int = content.orEmpty().count { !it.isWhitespace() }

    /** 笔记本的「更新于」时间戳：`10月24日 下午6:24`。 */
    fun updatedStamp(ms: Long, zone: ZoneId = ZoneId.systemDefault()): String {
        val t = Instant.ofEpochMilli(if (ms > 0) ms else System.currentTimeMillis()).atZone(zone)
        val hour = t.hour
        val ampm = if (hour < 12) "上午" else "下午"
        val h12 = when {
            hour % 12 == 0 -> 12
            else -> hour % 12
        }
        val minute = t.minute.toString().padStart(2, '0')
        return (t.monthValue) .toString() + "月" + t.dayOfMonth + "日 " + ampm + h12 + ":" + minute
    }

    /** 笔记本元信息整行：`更新于 10月24日 下午6:24 ｜ 42 字`（契约 §10.4）。 */
    fun bookMeta(updatedAt: Long, content: String?, zone: ZoneId = ZoneId.systemDefault()): String =
        "更新于 " + updatedStamp(updatedAt, zone) + " ｜ " + words(content) + " 字"

    /**
     * 倒数日卡片拆成三段（定稿 §6.5 的卡片形态：标题 / 大号天数 / 单位）：
     * `还有 152 天` → ("还有", 152)；`已经 365 天` → ("已经", 365)；`就是今天` → ("", 0)。
     *
     * days 为 null = 没有目标日或解析失败，卡片上只显示标题与「没有目标日」，不抛异常。
     */
    data class CountdownParts(val prefix: String, val days: Long?, val text: String) {
        /** 目标日是否已经过去（决定「已经」还是「还有」）。 */
        val past: Boolean get() = prefix == "已经"
    }

    fun countdownParts(target: String?, today: String): CountdownParts {
        val t = target?.trim().orEmpty()
        val text = countdown(t, today)
        if (t.isEmpty()) return CountdownParts("", null, text)
        val targetDate = runCatching { DateKeys.parse(t) }.getOrNull()
            ?: return CountdownParts("", null, text)
        val todayDate = runCatching { DateKeys.parse(today) }.getOrNull()
            ?: return CountdownParts("", null, text)
        val delta = DateKeys.daysBetween(todayDate, targetDate)
        return when {
            delta < 0 -> CountdownParts("已经", -delta, text)
            delta == 0L -> CountdownParts("", 0L, text)
            else -> CountdownParts("还有", delta, text)
        }
    }

    /**
     * 倒数日的天数差：目标日可以是过去（「已经 N 天」）或未来（「还有 N 天」）（契约 §10.1）。
     * 解析失败只返回「没有目标日」，不抛异常。
     */
    fun countdown(target: String?, today: String): String {
        val t = target?.trim().orEmpty()
        if (t.isEmpty()) return "没有目标日"
        val targetDate = runCatching { DateKeys.parse(t) }.getOrNull() ?: return "没有目标日"
        val todayDate = runCatching { DateKeys.parse(today) }.getOrNull() ?: return "没有目标日"
        val delta = DateKeys.daysBetween(todayDate, targetDate)
        return when {
            delta < 0 -> "已经 " + (-delta) + " 天"
            delta == 0L -> "就是今天"
            else -> "还有 " + delta + " 天"
        }
    }
}
