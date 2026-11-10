package app.took.ui

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import kotlinx.coroutines.delay

/**
 * 所有弹出层的唯一外壳：Dialog 独立窗口 + **纯水平**滑入（右 → 左）与滑出（左 → 右）。
 *
 * 两条硬约束（用户 2026-10-25 明确要求）：
 *  1. 只允许水平位移：进场 `slideInHorizontally`，出场 `slideOutHorizontally`，
 *     绝不夹带垂直位移（原来的当天面板是 ModalBottomSheet，从下往上弹，已废弃）；
 *  2. 动画参数只有一份：260ms + FastOutSlowInEasing（见 TookMotion），各页不许各写一套。
 *
 * 为什么用 Dialog 而不是页内叠加层：Compose 会把指针事件发给**同时命中**的兄弟节点，
 * 页内遮罩挡不住下层卡片（项目笔记里记过这条教训）。Dialog 是独立窗口，
 * 触摸与无障碍树天然隔离。
 *
 * @param widthFraction 1f = 全屏页面（规则编辑 / 记事 / 笔记本 / 倒数日）；
 *                      小于 1 时是右侧抽屉（当天打卡面板），左侧带可点遮罩。
 * @param content 收到一个 requestClose：面板内所有「返回 / 关闭 / 取消」都调它，
 *                这样出场动画不会被跳过。
 */
@Composable
fun SlideInPanel(
    onDismiss: () -> Unit,
    widthFraction: Float = 1f,
    content: @Composable (requestClose: () -> Unit) -> Unit,
) {
    var visible by remember { mutableStateOf(false) }
    var started by remember { mutableStateOf(false) }
    val requestClose: () -> Unit = { visible = false }

    // 进场：先让 AnimatedVisibility 从 false 起步，下一帧置 true 才会真的播动画
    LaunchedEffect(Unit) {
        started = true
        visible = true
    }
    // 出场：滑完再把 Dialog 撤掉，否则会「啪」地消失
    LaunchedEffect(visible, started) {
        if (started && !visible) {
            delay(TookMotion.DURATION_MS.toLong())
            onDismiss()
        }
    }

    val properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)
    Dialog(onDismissRequest = requestClose, properties = properties) {
        Box(Modifier.fillMaxSize()) {
            if (widthFraction < 1f) {
                val alpha by animateFloatAsState(
                    targetValue = if (visible) 1f else 0f,
                    animationSpec = TookMotion.fade(),
                    label = "scrim",
                )
                Box(
                    Modifier
                        .fillMaxSize()
                        .background(TookColors.scrim.copy(alpha = 0.44f * alpha))
                        .clickable(
                            interactionSource = remember { MutableInteractionSource() },
                            indication = null,
                            onClick = requestClose,
                        ),
                )
            }
            AnimatedVisibility(
                visible = visible,
                enter = slideInHorizontally(animationSpec = TookMotion.slide(), initialOffsetX = { it }) +
                    fadeIn(animationSpec = TookMotion.fade()),
                exit = slideOutHorizontally(animationSpec = TookMotion.slide(), targetOffsetX = { it }) +
                    fadeOut(animationSpec = TookMotion.fade()),
                modifier = Modifier.align(Alignment.CenterEnd).fillMaxSize(),
            ) {
                Box(Modifier.fillMaxSize(), contentAlignment = Alignment.CenterEnd) {
                    val panelModifier = if (widthFraction < 1f) {
                        Modifier.fillMaxHeight().fillMaxWidth(widthFraction)
                    } else {
                        Modifier.fillMaxSize()
                    }
                    Box(panelModifier) { content(requestClose) }
                }
            }
        }
    }
}

/**
 * 二次确认类弹层的统一外壳：仍是 Dialog（触摸隔离），卡片居中，
 * 但入场同样只有水平位移 —— 用户要求「任何 Dialog 都从右侧水平滑入」，
 * 小卡片用 320dp 的水平位移 + 淡入，不做缩放、不做上下跳。
 */
@Composable
fun TookDialog(onDismiss: () -> Unit, content: @Composable (requestClose: () -> Unit) -> Unit) {
    var visible by remember { mutableStateOf(false) }
    var started by remember { mutableStateOf(false) }
    val requestClose: () -> Unit = { visible = false }
    LaunchedEffect(Unit) {
        started = true
        visible = true
    }
    LaunchedEffect(visible, started) {
        if (started && !visible) {
            delay(TookMotion.DURATION_MS.toLong())
            onDismiss()
        }
    }
    val properties = DialogProperties(usePlatformDefaultWidth = true)
    Dialog(onDismissRequest = requestClose, properties = properties) {
        AnimatedVisibility(
            visible = visible,
            enter = slideInHorizontally(animationSpec = TookMotion.slide(), initialOffsetX = { it / 4 }) +
                fadeIn(animationSpec = TookMotion.fade()),
            exit = slideOutHorizontally(animationSpec = TookMotion.slide(), targetOffsetX = { it / 4 }) +
                fadeOut(animationSpec = TookMotion.fade()),
        ) {
            content(requestClose)
        }
    }
}

