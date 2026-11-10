package app.took.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Text
import androidx.compose.material3.ripple
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/**
 * 可点元素的统一写法：**一定带 ripple**。
 *
 * 之前规则卡用的是 `pointerInput { detectTapGestures }`（为了同时接长按），
 * 那条路没有 indication —— 点下去屏幕上没有任何反馈，用户的原话是「点了没反应」。
 * 需要长按的地方改用 combinedClickable（见 ConfigPage）。
 */
@Composable
internal fun Modifier.tap(enabled: Boolean = true, onClick: () -> Unit): Modifier =
    this.clickable(
        interactionSource = remember { MutableInteractionSource() },
        indication = ripple(bounded = true),
        enabled = enabled,
        onClick = onClick,
    )

/** 卡片：圆角 18 + 阴影 6 + 1dp line 边框 + 统一内边距。 */
@Composable
internal fun TookCard(
    modifier: Modifier = Modifier,
    paddingX: Dp = TookDims.cardX,
    paddingY: Dp = TookDims.cardY,
    content: @Composable () -> Unit,
) {
    val shape = RoundedCornerShape(TookDims.cardRadius)
    Box(
        modifier
            .fillMaxWidth()
            .shadow(elevation = TookDims.cardShadow, shape = shape, clip = false)
            .background(TookColors.surface, shape)
            .border(1.dp, TookColors.line, shape)
            .padding(horizontal = paddingX, vertical = paddingY),
    ) {
        Column(modifier = Modifier.fillMaxWidth()) { content() }
    }
}

/** 空状态：一行居中灰字。空列表不许留白板（用户明确要求）。 */
@Composable
internal fun TookEmpty(text: String, modifier: Modifier = Modifier, vertical: Dp = 22.dp) {
    Text(
        text = text,
        modifier = modifier.fillMaxWidth().padding(vertical = vertical),
        fontSize = 12.5.sp,
        lineHeight = 19.sp,
        color = TookColors.text3,
        textAlign = TextAlign.Center,
    )
}

/** 分组小标题（配置页/设置页同一套）。 */
@Composable
internal fun TookGroupHeader(
    title: String,
    modifier: Modifier = Modifier,
    trailing: (@Composable () -> Unit)? = null,
) {
    Row(
        modifier
            .fillMaxWidth()
            .heightIn(min = TookDims.touch)
            .padding(start = 4.dp, top = 10.dp, bottom = 2.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text = title,
            fontSize = 11.5.sp,
            fontWeight = FontWeight.SemiBold,
            letterSpacing = 0.2.sp,
            color = TookColors.text2,
        )
        Spacer(Modifier.weight(1f))
        trailing?.invoke()
    }
}

@Composable
internal fun TookDivider() {
    HorizontalDivider(thickness = 1.dp, color = TookColors.line)
}

/** 按钮四档：主（实心橙）/ 次（浅底）/ 文字（纯文字）/ 危险（实心红）。高度一律 44dp。 */
enum class TookButtonTone { Primary, Secondary, Text, Danger }

@Composable
internal fun TookButton(
    label: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    tone: TookButtonTone = TookButtonTone.Primary,
    enabled: Boolean = true,
) {
    val shape = RoundedCornerShape(TookDims.controlRadius)
    val bg = when (tone) {
        TookButtonTone.Primary -> if (enabled) TookColors.accent else TookColors.fill2
        TookButtonTone.Secondary -> if (enabled) TookColors.fill else TookColors.fill2
        TookButtonTone.Text -> Color.Transparent
        TookButtonTone.Danger -> if (enabled) TookColors.danger else TookColors.fill2
    }
    val fg = when (tone) {
        TookButtonTone.Primary -> Color.White
        TookButtonTone.Secondary -> TookColors.text
        TookButtonTone.Text -> TookColors.accentText
        TookButtonTone.Danger -> Color.White
    }
    Box(
        modifier
            .height(TookDims.controlHeight)
            .clip(shape)
            .background(bg, shape)
            .tap(enabled = enabled, onClick = onClick)
            .semanticsLabel(label),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = label,
            fontSize = if (tone == TookButtonTone.Text) 13.sp else 13.5.sp,
            fontWeight = FontWeight.SemiBold,
            color = if (enabled) fg else TookColors.mute,
            textAlign = TextAlign.Center,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

/**
 * 图标/字符按钮：**命中区固定 44dp**，视觉尺寸由 visual 决定。
 * 之前翻月 ‹ › 是 34dp、列表行原有的「⋯」更多按钮是 30dp、文档页返回是 34dp —— 都点不准。
 * （「⋯」按钮本身已于 2026-10-26 从配置页移除：与左滑重复，左滑是唯一入口。）
 */
@Composable
internal fun TookIconButton(
    label: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    visual: Dp = 34.dp,
    enabled: Boolean = true,
    content: @Composable () -> Unit,
) {
    Box(
        modifier
            .defaultMinSize(minWidth = TookDims.touch, minHeight = TookDims.touch)
            .tap(enabled = enabled, onClick = onClick)
            .semanticsLabel(label),
        contentAlignment = Alignment.Center,
    ) {
        Box(
            Modifier
                .defaultMinSize(minWidth = visual, minHeight = visual)
                .clip(RoundedCornerShape(TookDims.controlRadiusSmall))
                .background(TookColors.fill),
            contentAlignment = Alignment.Center,
        ) {
            content()
        }
    }
}

/** 胶囊小按钮（＋ 新建规则 / ＋ 新建记事 …）：视觉 34dp，命中区 44dp。 */
@Composable
internal fun TookChip(
    label: String,
    modifier: Modifier = Modifier,
    selected: Boolean = false,
    enabled: Boolean = true,
    onClick: () -> Unit,
) {
    val pill = RoundedCornerShape(999.dp)
    Box(
        modifier
            .height(TookDims.touch)
            .tap(enabled = enabled, onClick = onClick)
            .semanticsLabel(label.removePrefix("＋ ").trim()),
        contentAlignment = Alignment.Center,
    ) {
        Box(
            Modifier
                .height(34.dp)
                .clip(pill)
                .background(if (selected) TookColors.accent else TookColors.accentWeak)
                .border(1.dp, if (selected) TookColors.accent else TookColors.accentLine, pill)
                .padding(horizontal = 12.dp),
            contentAlignment = Alignment.Center,
        ) {
            Text(
                text = label,
                fontSize = 12.sp,
                fontWeight = FontWeight.SemiBold,
                color = if (selected) Color.White else TookColors.accentText,
                maxLines = 1,
            )
        }
    }
}

/** 灰色胶囊（不是主操作，例如「紧凑档」「分类」标签）。 */
@Composable
internal fun TookPill(text: String, bg: Color, fg: Color, modifier: Modifier = Modifier) {
    Box(
        modifier
            .clip(RoundedCornerShape(999.dp))
            .background(bg)
            .padding(horizontal = 8.dp, vertical = 3.dp),
    ) {
        Text(text, fontSize = 11.sp, lineHeight = 14.sp, color = fg)
    }
}

/**
 * 二次确认卡片：删除规则 / 删除 memo / 裂开确认共用。
 * 卡片本身居中，水平滑入由外壳 TookDialog 负责（不做缩放、不做上下位移）。
 */
@Composable
internal fun TookConfirmCard(
    title: String,
    lines: List<String>,
    confirm: String,
    dismiss: String,
    onConfirm: () -> Unit,
    onDismiss: () -> Unit,
    danger: Boolean = true,
) {
    val shape = RoundedCornerShape(TookDims.cardRadius)
    Column(
        Modifier
            .padding(horizontal = 22.dp)
            .shadow(elevation = TookDims.cardShadow * 2, shape = shape, clip = false)
            .background(TookColors.surface, shape)
            .padding(horizontal = 16.dp, vertical = 16.dp),
    ) {
        Text(
            text = title,
            fontSize = 14.sp,
            fontWeight = FontWeight.SemiBold,
            lineHeight = 21.sp,
            color = TookColors.text,
        )
        Column(Modifier.padding(top = 10.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            lines.forEach {
                Text("· $it", fontSize = 11.5.sp, lineHeight = 18.sp, color = TookColors.text2)
            }
        }
        Row(
            Modifier.fillMaxWidth().padding(top = 16.dp),
            horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            TookButton(
                label = dismiss,
                onClick = onDismiss,
                modifier = Modifier.weight(1f),
                tone = TookButtonTone.Secondary,
            )
            TookButton(
                label = confirm,
                onClick = onConfirm,
                modifier = Modifier.weight(1f),
                tone = if (danger) TookButtonTone.Danger else TookButtonTone.Primary,
            )
        }
    }
}

/** 状态圆点（图例、任务前的小圆）。 */
@Composable
internal fun TookDot(color: Color, size: Dp = 6.dp, filled: Boolean = true) {
    Box(
        Modifier
            .defaultMinSize(minWidth = size, minHeight = size)
            .clip(CircleShape)
            .background(if (filled) color else Color.Transparent)
            .border(1.dp, color, CircleShape),
    )
}