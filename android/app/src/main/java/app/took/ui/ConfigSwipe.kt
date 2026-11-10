package app.took.ui

import androidx.compose.animation.core.Animatable
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.launch
import kotlin.math.roundToInt

/** 左滑露出的一个操作按钮：置顶 / 编辑 / 删除。 */
data class SwipeAction(
    val label: String,
    val bg: Color,
    val fg: Color,
    val onClick: () -> Unit,
)

/** 三个按钮等分 200dp（每个约 66dp，仍在 44dp 触控下限之上）。 */
internal val SwipeRevealWidth = 200.dp

/**
 * 列表行左滑露操作（用户原话「子类可以支持左划显示删除编辑置顶」）。
 *
 * 几个刻意的选择：
 *  - **跟手**：拖拽时 offset 跟着手指走（snapTo），松手按位移是否过半判定开/关；
 *  - 拖拽用 detectHorizontalDragGestures：它只在**水平**超过 slop 后才消费事件，
 *    竖向滑动与父容器的 verticalScroll 不受影响；
 *  - 点按完全不变：拖拽检测器不消费 tap，行内原本的 clickable 照旧收到点击（→ 打开编辑页）；
 *  - 收起时操作区**从无障碍树里摘掉**（clearAndSetSemantics）：否则每一行都会多出
 *    三个读屏节点（「置顶 / 编辑 / 删除」），读屏用户听到的全是看不见的按钮；
 *  - 开合同步交给外部（isOpen）：一行展开时别的行自动收回，不给「同时开两行」的空档。
 */
@Composable
internal fun SwipeRevealRow(
    isOpen: Boolean,
    onOpenChange: (Boolean) -> Unit,
    actions: List<SwipeAction>,
    modifier: Modifier = Modifier,
    revealWidth: Dp = SwipeRevealWidth,
    content: @Composable () -> Unit,
) {
    val scope = rememberCoroutineScope()
    val revealPx = with(LocalDensity.current) { revealWidth.toPx() }
    val offsetX = remember { Animatable(0f) }
    /** 是否已经露出按钮（只用来决定操作区要不要进无障碍树，不含动画值）。 */
    var revealed by remember { mutableStateOf(isOpen) }

    // 外部要把这一行收起（点了别的行 / 切了类型 / 执行完操作）：位移弹回去
    LaunchedEffect(isOpen) {
        revealed = isOpen
        val target = if (isOpen) -revealPx else 0f
        if (offsetX.value != target) offsetX.animateTo(target, TookMotion.swipe())
    }

    Box(modifier.fillMaxWidth()) {
        // 操作区高度跟随卡片：外层 matchParentSize 只在卡片量完尺寸后才生效，
        // 内层再限定成右侧 revealWidth 宽 —— 三个按钮等分这 200dp。
        Box(
            Modifier
                .matchParentSize()
                .then(if (revealed) Modifier else Modifier.clearAndSetSemantics {}),
        ) {
            Row(
                Modifier
                    .align(Alignment.CenterEnd)
                    .width(revealWidth)
                    .fillMaxHeight()
                    .clip(RoundedCornerShape(TookDims.cardRadius)),
            ) {
                actions.forEach { action ->
                    Box(
                        Modifier
                            .weight(1f)
                            .fillMaxHeight()
                            .background(action.bg)
                            .tap { action.onClick() }
                            .semanticsLabel(action.label),
                        contentAlignment = Alignment.Center,
                    ) {
                        Text(
                            text = action.label,
                            fontSize = 12.5.sp,
                            fontWeight = FontWeight.SemiBold,
                            color = action.fg,
                            maxLines = 1,
                        )
                    }
                }
            }
        }
        Box(
            Modifier
                .offset { IntOffset(offsetX.value.roundToInt(), 0) }
                .pointerInput(revealPx) {
                    detectHorizontalDragGestures(
                        onHorizontalDrag = { change, dragAmount ->
                            change.consume()
                            val next = (offsetX.value + dragAmount).coerceIn(-revealPx, 0f)
                            scope.launch { offsetX.snapTo(next) }
                            // 只在跨过阈值那一刻重排一次，不跟着每一帧重排
                            val nowRevealed = next < -1f
                            if (nowRevealed != revealed) revealed = nowRevealed
                        },
                        onDragEnd = {
                            val open = offsetX.value <= -revealPx * 0.4f
                            revealed = open
                            scope.launch { offsetX.animateTo(if (open) -revealPx else 0f, TookMotion.swipe()) }
                            onOpenChange(open)
                        },
                        onDragCancel = {
                            val open = offsetX.value <= -revealPx * 0.4f
                            revealed = open
                            scope.launch { offsetX.animateTo(if (open) -revealPx else 0f, TookMotion.swipe()) }
                            onOpenChange(open)
                        },
                    )
                },
        ) {
            content()
        }
    }
}
