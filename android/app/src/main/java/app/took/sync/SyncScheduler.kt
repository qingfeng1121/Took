package app.took.sync

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

/**
 * 「启动时一次 + 每 5 分钟一次」的定时器（契约 §7.5）。
 *
 * 为什么用协程循环而不是 WorkManager：
 *  1. WorkManager 的周期任务下限是 15 分钟（PeriodicWorkRequest.MIN_PERIODIC_INTERVAL_MILLIS），
 *     满足不了 5 分钟这一条，用它只能是妥协；
 *  2. 多一个 androidx.work 依赖 + 一个 ContentProvider 初始化，收益却拿不到（局域网同步不需要 Doze 保活）；
 *  3. 进程活着时的定时用协程足够，进程死了由下次启动的首次同步补齐。
 * 代价（明说，不藏）：进程被杀后不再定时，只在前台存活期间同步。需要后台常驻时再迁 WorkManager + 15 分钟。
 */
class SyncScheduler(
    private val scope: CoroutineScope,
    private val intervalMs: Long = INTERVAL_MS,
    private val tick: suspend () -> Unit,
) {
    private var job: Job? = null

    fun start() {
        if (job != null) return
        job = scope.launch {
            while (isActive) {
                tick()
                delay(intervalMs)
            }
        }
    }

    fun stop() {
        job?.cancel()
        job = null
    }

    companion object {
        const val INTERVAL_MS = 5 * 60 * 1000L
    }
}
