package app.took.countdownwidget

import app.took.data.MemoEditPolicy
import app.took.data.MemoKind
import app.took.data.MemoRow
import app.took.ui.MemoFormats

/**
 * 桌面小组件「倒数日」的纯逻辑层：没有任何 Android / Glance 依赖，JVM 单测直接覆盖。
 *
 * **一个组件实例 = 一个倒数日**（用户 2026-10-26 原话：「2*2 为什么要塞两个倒数日？
 * 一个只能显示一个」）。选哪一条由本实例自己的 Glance Preferences 里的
 * [CountdownWidgetState.KEY_MEMO_ID] 决定，配置页写、组件读；多条倒数日靠
 * 「再加一个组件、再选一条」区分，而不是把多条挤进同一个格子。
 *
 * 口径与 App 内倒数日卡完全同源，不另立规矩：
 *  - 取数：[app.took.data.TookRepository.listMemos] 的 kind=1（[MemoKind.COUNTDOWN]）；
 *  - 排序：[MemoEditPolicy.countdownOrder] —— 未来升序在前、过去降序在后、解析不了的最后；
 *  - 文案：[MemoFormats.countdownParts]（还有 N 天 / 已经 N 天 / 就是今天）；
 *  - 日期：[MemoFormats.compactDate]（2026.2.6，点分隔不补零）。
 *
 * 尺寸只影响字号与留白，**永远只画一张卡**：2×2 与 2×4 的差别是「数字更大、留白更多」，
 * 不是「多塞一条」。
 */

/**
 * 一档尺寸，只决定字号与留白。
 *
 * 与「放几张卡」无关 —— 这个枚举里**没有** maxCards：任何尺寸都只显示一个倒数日，
 * 放大只是让数字更大。
 */
enum class CountdownWidgetTier(
    /** 组件最外层留白（白底与深色卡之间的那圈）。 */
    val rootPad: Int,
    /** 深色卡自己的内边距。 */
    val cardPad: Int,
    /** 卡上标题字号。 */
    val titleSp: Int,
    /** 卡上目标日字号。 */
    val dateSp: Int,
    /** 超大数字的下限：再挤也不小于它，否则数字没有存在意义。 */
    val minNumberSp: Float,
    /** 超大数字的上限：2×4 这类高组件也不无限放大，避免数字比卡片还抢眼。 */
    val maxNumberSp: Float,
) {
    /** 1×1 这类最小格子：字号收一档，但数字与目标日仍在。 */
    COMPACT(rootPad = 4, cardPad = 6, titleSp = 9, dateSp = 9, minNumberSp = 12f, maxNumberSp = 30f),

    /** 2×2（组件的最小尺寸，也是默认尺寸）：App 内那张卡在桌面上的等比版本。 */
    REGULAR(rootPad = 5, cardPad = 8, titleSp = 10, dateSp = 10, minNumberSp = 14f, maxNumberSp = 44f),

    /** 2×4 及以上：留白更多、数字更大，**依旧只画一条**。 */
    ROOMY(rootPad = 6, cardPad = 10, titleSp = 12, dateSp = 11, minNumberSp = 16f, maxNumberSp = 64f),
}

/**
 * 组件上的一张卡（一个实例只有一张）。
 *
 * [number] 只放数字（参考图里没有「还有/天」夹着数字），方向词单独进 [direction]；
 * 没有目标日时 [number] 是「—」而不是编一个数字出来。
 */
data class CountdownWidgetItem(
    val id: String,
    val title: String,
    val number: String,
    val direction: String,
    val dateText: String,
    /** 目标日就是今天：数字走红色（与 App 内卡片同一处 [app.took.ui.TookColors.today]）。 */
    val today: Boolean,
    /** 目标日已经过去（决定「已经」还是「还有」）。 */
    val past: Boolean,
    /** 语义串：uiautomator 靠它断这张卡是哪个倒数日、几天、哪一天。 */
    val label: String,
)

/**
 * 这个实例选中的是哪一条 —— 组件渲染只认这四种状态，没有第五种。
 */
enum class CountdownWidgetSelection {
    /** 没有配置过（旧版升级上来的实例）：自动取排序后的第一个，保证不是空白。 */
    AUTO,

    /** 配置过且这条还在：只显示它。 */
    EXPLICIT,

    /** 配置过，但那一条已经被删了：显示「该倒数日已删除」+ 提示重新选择，不崩也不空白。 */
    MISSING,

    /** 一条倒数日都没有：显示「还没有倒数日」。 */
    EMPTY,
}

/**
 * 一个组件实例要画的东西。
 *
 * [items] 是**全部**倒数日（排序后），用于配置页与兜底；
 * [item] 是**这一张**要画的卡，null 表示没得画（[MISSING] / [EMPTY]）。
 */
data class CountdownWidgetPlan(
    val today: String,
    val items: List<CountdownWidgetItem>,
    /** 本实例配置里写的 memoId（未配置为 null）；[MISSING] 时就是那条已失效的 id。 */
    val requestedId: String?,
    val selection: CountdownWidgetSelection,
    val item: CountdownWidgetItem?,
) {

    val total: Int get() = items.size

    /** 一条倒数日都没有：组件显示 [EMPTY_TEXT]，不是一块空白。 */
    val empty: Boolean get() = selection == CountdownWidgetSelection.EMPTY

    /** 配置的那条已被删除：组件显示 [DELETED_TEXT]。 */
    val missing: Boolean get() = selection == CountdownWidgetSelection.MISSING

    /** 是否由「未配置 → 取第一个」兜底而来（配置页用来提示「当前是自动选择」）。 */
    val autoSelected: Boolean get() = selection == CountdownWidgetSelection.AUTO

    companion object {

        /** 空状态文案：明确的「还没有倒数日」，与 App 内「整块不渲染」不同 —— 桌面上留白会被当成加载失败。 */
        const val EMPTY_TEXT = "还没有倒数日"
        const val EMPTY_HINT = "打开 Tool 添加一个"

        /** 选中的倒数日被删了：说清事实 + 给出下一步，不留空白也不崩。 */
        const val DELETED_TEXT = "该倒数日已删除"
        const val DELETED_HINT = "长按组件重新选择"

        /** 未配置时自动取第一个，配置页据此提示用户「这不是你选的」。 */
        const val AUTO_HINT = "未选择，当前显示最近的一个"

        /** 未配置（旧版升级 / 拖上桌面还没选）时的入口：什么都不配也要有内容。 */
        fun of(memos: List<MemoRow>, today: String): CountdownWidgetPlan = resolve(memos, today, null)

        /**
         * 把 memo 列表 + 本实例配置的 memoId 折成「这一张卡」。
         *
         * 只认 kind=1 且未软删的行（[app.took.data.MemoEditService.listMemos] 已经过滤过一遍，
         * 这里再挡一次是为了让单测可以直接传原始列表，也避免脏行混进组件）。
         * 排序完全交给 [MemoEditPolicy.countdownOrder]，组件不自己写第二套排序规则。
         *
         * 三种兜底按用户要求逐条落地：
         *  - 未配置（memoId 为 null / 空串）→ [CountdownWidgetSelection.AUTO]，取排序后的第一个；
         *  - 配了但已删 → [CountdownWidgetSelection.MISSING]，显示「该倒数日已删除」；
         *  - 一条都没有 → [CountdownWidgetSelection.EMPTY]，显示「还没有倒数日」。
         */
        fun resolve(memos: List<MemoRow>, today: String, memoId: String?): CountdownWidgetPlan {
            val alive = memos.filter { it.kind == MemoKind.COUNTDOWN && it.deleted == 0 }
            val items = MemoEditPolicy.countdownOrder(alive, today).map { itemOf(it, today) }
            val wanted = memoId?.trim()?.takeIf { it.isNotEmpty() }

            if (items.isEmpty()) {
                return CountdownWidgetPlan(today, items, wanted, CountdownWidgetSelection.EMPTY, null)
            }
            if (wanted == null) {
                return CountdownWidgetPlan(today, items, null, CountdownWidgetSelection.AUTO, items.first())
            }
            val hit = items.firstOrNull { it.id == wanted }
                ?: return CountdownWidgetPlan(today, items, wanted, CountdownWidgetSelection.MISSING, null)
            return CountdownWidgetPlan(today, items, wanted, CountdownWidgetSelection.EXPLICIT, hit)
        }

        /** 一条 memo → 一张卡。解析失败不抛异常，退化成「没有目标日」。 */
        fun itemOf(memo: MemoRow, today: String): CountdownWidgetItem {
            val parts = MemoFormats.countdownParts(memo.startDate, today)
            val dateText = MemoFormats.compactDate(memo.startDate)
            val number = if (parts.days == null) "—" else parts.days.toString()
            val direction = when {
                parts.days == null -> "没有目标日"
                parts.prefix.isEmpty() -> "就是今天"
                else -> parts.prefix + " " + parts.days + " 天"
            }
            return CountdownWidgetItem(
                id = memo.id,
                title = memo.title,
                number = number,
                direction = direction,
                dateText = dateText,
                today = parts.days != null && parts.days == 0L,
                past = parts.past,
                label = "倒数日 " + memo.title + "，" + direction + "，目标日 " + dateText,
            )
        }

        /**
         * 按组件真实尺寸选字号档。
         *
         * 只决定字号与留白，**不决定条数** —— 任何档位都只画一条倒数日。
         */
        fun tierForSize(widthDp: Float, heightDp: Float): CountdownWidgetTier = when {
            widthDp < 110f || heightDp < 110f -> CountdownWidgetTier.COMPACT
            heightDp < 200f -> CountdownWidgetTier.REGULAR
            else -> CountdownWidgetTier.ROOMY
        }

        /**
         * 一行文字的实占高度：字号 × 行高系数。1.6 是实测偏保守的值 ——
         * Glance 的 Text 落到 RemoteViews 的 TextView 上，行高比字号大约 1.35~1.45 倍，
         * 取 1.6 留出余量，宁可数字小一号也不要底部目标日被裁。
         */
        const val LINE_FACTOR = 1.6f

        /** 数字自己的行高系数：粗体大字比正文更紧，1.25 与 App 内卡片 1.06 同量级取稳。 */
        const val NUMBER_LINE_FACTOR = 1.25f

        /** 数字上下的额外留白（渲染里那条 padding(vertical = 2.dp) 的上下两条）。 */
        const val NUMBER_EXTRA_DP = 4f

        /**
         * 排版余量。算出来刚好装满的卡在真机上一定会裁掉最后一行 ——
         * TextView 的行高有取整、卡片圆角内缩也会吃掉一点。留 14dp 换「一定看得见」。
         */
        const val SAFETY_DP = 14f

        /**
         * 这张卡**真正能用的**高度：组件总高扣掉外层留白（上下各 rootPad）。
         *
         * 只有一张卡，不再按张数均分 —— 之前「总高 / 张数」的分档逻辑随「一个实例只显示一条」
         * 一起删掉了（那是把 2 条挤进 2×2 的根源）。
         */
        fun cardHeightDp(totalHeightDp: Float, tier: CountdownWidgetTier): Float =
            (totalHeightDp - 2f * tier.rootPad).coerceAtLeast(0f)

        /**
         * 这张卡**真正能用的**宽度：组件总宽扣掉外层留白与卡片自己的左右内边距。
         * 数字位数多（1000 天以上）时靠它压字号，避免数字横向溢出被裁。
         */
        fun cardWidthDp(totalWidthDp: Float, tier: CountdownWidgetTier): Float =
            (totalWidthDp - 2f * tier.rootPad - 2f * tier.cardPad).coerceAtLeast(0f)

        /**
         * 一张卡的最终排版。
         *
         * 行是**逐级让位**的：标题 > 方向词都是可选的，数字与目标日永远保留。
         */
        data class CardLayout(
            val numberSp: Float,
            val showTitle: Boolean,
            val showDirection: Boolean,
        )

        /**
         * 按卡的实际高度决定排版：从「标题 + 方向 + 数字 + 日期」四行开始，
         * 装不下就依次砍掉方向词、标题，直到数字能落在这一档的下限之上。
         *
         * 砍到只剩「数字 + 日期」还装不下时，按最低限度硬塞 —— 日期是这张卡的另一半
         * 信息（「还有 12 天」到哪天），不能被裁掉；此时数字取这一档的下限。
         */
        fun cardLayout(cardHeightDp: Float, tier: CountdownWidgetTier): CardLayout {
            fun fit(withTitle: Boolean, withDirection: Boolean): Float {
                val titleBlock = if (withTitle) tier.titleSp * LINE_FACTOR else 0f
                val directionBlock = if (withDirection) (tier.titleSp - 1) * LINE_FACTOR else 0f
                val chrome = 2f * tier.cardPad +
                    titleBlock +
                    directionBlock +
                    tier.dateSp * LINE_FACTOR +
                    NUMBER_EXTRA_DP +
                    SAFETY_DP
                return (cardHeightDp - chrome) / NUMBER_LINE_FACTOR
            }
            for ((t, d) in listOf(true to true, true to false, false to false)) {
                val sp = fit(t, d)
                if (sp >= tier.minNumberSp) {
                    return CardLayout(sp.coerceAtMost(tier.maxNumberSp), showTitle = t, showDirection = d)
                }
            }
            // 最省的两行都装不下：数字取下限，日期照画（宁可数字小，也不丢日期）
            return CardLayout(tier.minNumberSp, showTitle = false, showDirection = false)
        }

        /**
         * 按宽度再压一次字号：4 位数（1000 天以上）在高卡上会被高度算成 64sp，
         * 但卡宽只放得下 3 位 —— 不压就会横向溢出、数字被裁一半。
         *
         * 粗体数字的实测步进约 0.78 字宽（1 / 1.28），与 App 内 CountdownCard 同一公式。
         */
        fun numberSpFittingWidth(numberSp: Float, cardWidthDp: Float, digits: Int): Float {
            if (digits <= 0 || cardWidthDp <= 0f) return numberSp
            val byWidth = cardWidthDp / digits * 1.28f
            return numberSp.coerceAtMost(byWidth)
        }
    }
}
