package app.took.ui

import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics

/** 给纯视觉元件补无障碍标签（日期数字 / 翻月按钮）。 */
internal fun Modifier.semanticsLabel(label: String): Modifier =
    this.semantics { contentDescription = label }
