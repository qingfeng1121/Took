# 倒数日桌面组件 · 验收记录（2026-10-26）

只改 `D:\work\Project\Took\android`。新建 `app/src/main/java/app/took/countdownwidget/`，
未改动 `widget/`（今天）与 `homewidget/`（月历）任何文件。

## 一句话结论

**用户在系统「添加小部件」列表里能看到「倒数日」**（Took 分组下第 3 个，2x2）。
证据：`ui-widget-picker-countdown.png` + `widget-picker-countdown.xml`。

## 1. 单元测试

```
gradle testDebugUnitTest --rerun-tasks
BUILD SUCCESSFUL
classes 17 / tests 204 / failures 0 / errors 0
```

基线 181 条一条未回退，新增 **23 条**（`CountdownWidgetPlanTest`）：
排序（未来升序/过去降序/脏数据最后）、分档（MINI 1 / MEDIUM 2 / LARGE 4）、
空状态、点分日期 `2026.2.6`、天数（还有/已经/就是今天）、
卡高与字号的排版自适配（挤的时候逐级砍标题/方向词，数字与日期永远保留）。

## 2. 构建与安装

```
gradle assembleDebug            → BUILD SUCCESSFUL
adb -s 5bf0cda4 install -r      → Success
```

## 3. 系统是否认识这个组件（硬指标）

```
$ adb -s 5bf0cda4 shell dumpsys appwidget | grep countdownwidget
  [467] provider ProviderId{user:0, app:10039,
        cmp:ComponentInfo{app.took/app.took.countdownwidget.CountdownWidgetReceiver}}
    min=(10241x10241) minResize=(10241x10241) updatePeriodMillis=1800000
    resizeMode=3 widgetCategory=1 autoAdvanceViewId=-1 zombie=false
```

`app.took/app.took.countdownwidget.CountdownWidgetReceiver` + `widgetCategory=1`（home_screen）。

广播接收器也注册成功：

```
$ adb -s 5bf0cda4 shell cmd package query-receivers -a android.appwidget.action.APPWIDGET_UPDATE
    app.took/.widget.TodayWidgetReceiver
    app.took/.homewidget.MonthWidgetReceiver
    app.took/.countdownwidget.CountdownWidgetReceiver
```

## 4. 系统小部件列表里能看到「倒数日」（核心证据）

系统原生「添加小部件」页（com.miui.home）的 Took 分组：

```
{"label":"Took","bounds":"[113,1577][1080,1627]","id":"com.miui.home:id/widget_line_title"}
{"label":"今天","bounds":"[60,1644][330,2002]","clickable":"true"}
{"label":"今天","bounds":"[82,1881][308,1935]","id":"...item_title"}   4x2
{"label":"月历","bounds":"[345,1644][615,2002]","clickable":"true"}
{"label":"月历","bounds":"[367,1881][593,1935]","id":"...item_title"}   4x4
{"label":"倒数日","bounds":"[630,1644][900,2002]","clickable":"true"}
{"label":"倒数日","bounds":"[652,1881][878,1935]","id":"...item_title"} 2x2
```

截图 `ui-widget-picker-countdown.png` 里可以直接看到三个预览图：
今天（白卡）、月历（安卓默认占位）、**倒数日（深色卡 + 365 + 2026.2.6）**。

## 5. 真机上确实放上去了

```
$ adb -s 5bf0cda4 shell dumpsys appwidget | grep -B2 'app.took/app.took.countdownwidget'
  [7] id=523
    host=HostId{user:0, app:10137, hostId:1024, pkg:com.miui.home}
    provider=ComponentId{app.took/app.took.countdownwidget.CountdownWidgetReceiver}
```

三个组件**同时在桌面**（同一个 host `com.miui.home`）：

| 实例 | 组件 |
|---|---|
| id=521 | `app.took.widget.TodayWidgetReceiver`（今天） |
| id=522 | `app.took.homewidget.MonthWidgetReceiver`（月历） |
| id=523 | `app.took.countdownwidget.CountdownWidgetReceiver`（倒数日） |

渲染（桌面第 4 页，`ui-widget-countdown.png` + `widget-countdown-home.xml`）：

```
{"label":"倒数日 TogetherDays，已经 262 天，目标日 2026.2.6"}
{"label":"262","bounds":"[621,1342][967,1425]"}
{"label":"2026.2.6","bounds":"[722,1425][866,1469]"}
{"label":"倒数日 AnniversaryTook，已经 372 天，目标日 2025.10.19"}
{"label":"372","bounds":"[621,1555][967,1638]"}
{"label":"2025.10.19","bounds":[705,1638][882,1683]"}
```

## 6. 踩到并修掉的三个 Glance 坑（都是真机才暴露）

1. **`SizeMode.Responsive` 永远落最小档** —— 它按 appwidget-provider 的 minWidth/minHeight
   去挑预设，不是真实格子尺寸（本机 440dpi、2x2 真实约 145dp，而 1x1 下限 40dp 让它选了 70dp 那档），
   结果 2x2 被渲染成 MINI：标题消失、只显示 1 个。改成 **`SizeMode.Exact`** 用 LocalSize 真实 dp。
2. **嵌套 `defaultWeight` 会把数字压成 0 高** —— Column 里再套一个带 weight 的 Box，
   外层是 wrap_content，里层拿不到剩余高度，卡上只剩标题/方向/日期、中间一片空。去掉 Box 直接画。
3. **字号按「总高/张数」算会把底部日期裁掉** —— 没扣根留白、卡间距与方向小字那一行。
   现在 `cardHeightDp()` 逐项扣，`cardLayout()` 按实测卡高逐级让位（标题 → 方向词），
   并留 `SAFETY_DP=14` 余量；单测 `everyTierFitsAtTypicalSizes` 把这些尺寸钉死。

## 7. 没做到的

- **App 内 Pin 入口在 MIUI 上不弹确认框**：`am start -a app.took.action.PIN_COUNTDOWN_WIDGET`
  能启动 `CountdownWidgetPinActivity`（dumpsys 有记录），但 `requestPinAppWidget` 在
  com.miui.home 上没有可见确认框。这与「今天」「月历」两个既有组件同一条实测结论一致，
  PinActivity 里的兜底文案（长按桌面 → 小部件 → 找到「倒数日」）就是为此写的。
- **拖拽动作本身没有用 uiautomator 复现**：拖拽是跨进程手势，脚本化的点击/滑动拿不到
  「拖到桌面并松手」这一步。因此改为提供**更可控的证据链**：系统列表里能看到「倒数日」
  （截图+dump）+ 该组件确实已被 host 装载并渲染真实数据（id=523 + 桌面截图）。
- **跨天零点刷新对倒数日不生效**：`WidgetTickReceiver` 到点只 updateAll 了 TodayWidget/MonthWidget，
  本组件不在其中。修它要改 `widget/WidgetTickReceiver`，本次约束禁止改 `widget/`，
  故按 `updatePeriodMillis=1800000`（30 分钟）+ 尺寸/添加事件兜底，记为遗留项。
  「还有 N 天」是相对当天的值，最坏延迟 30 分钟，不会显示错误的天数口径（只是晚一点更新）。

## 8. 证据文件

| 文件 | 内容 |
|---|---|
| `ui-widget-countdown.png` | 桌面上的倒数日组件（两个倒数日、深色卡、大数字、点分日期） |
| `widget-countdown-home.xml` | 同上的 uiautomator dump |
| `ui-widget-picker-countdown.png` | 系统「添加小部件」里 Took 分组的三个组件，含「倒数日 2x2」 |
| `widget-picker-countdown.xml` | 同上的 uiautomator dump |
| `_cd-*.xml` | 中间过程 dump（分档、picker 扫描等） |
