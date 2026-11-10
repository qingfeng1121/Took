package app.took.countdownwidget

import androidx.datastore.preferences.core.stringPreferencesKey

/**
 * 每个组件实例自己的配置，存在 Glance 的 Preferences（DataStore）里。
 *
 * **按实例隔离**：Glance 的 Preferences 是按 GlanceId 分开存的，
 * 因此桌面上放两个「倒数日」组件、各自 [KEY_MEMO_ID] 不同 → 两个组件显示不同的倒数日。
 * 这是「多个倒数日靠选择而不是全塞」能成立的前提。
 *
 * 只存 memoId（一个字符串），**不存标题/天数/日期**：那些每天都会变，
 * 存快照就会出现「组件显示的天数和 App 里不一致」。渲染时按 id 现查库。
 */
object CountdownWidgetState {

    /**
     * Preferences 里的键名原文。
     *
     * 单独抽成常量是为了让 JVM 单测能断言键名（[KEY_MEMO_ID] 是 DataStore 的 Key 对象，
     * 单测里不引 Android 依赖）。改名等于让已配置的组件全部失效，因此它是不变量。
     */
    const val KEY_MEMO_ID_NAME = "memoId"

    /** 本实例选中的倒数日 id；不存在 = 没配置过（取排序后的第一个兜底）。 */
    val KEY_MEMO_ID = stringPreferencesKey(KEY_MEMO_ID_NAME)
}
