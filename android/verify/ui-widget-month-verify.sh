#!/usr/bin/env bash
# 月历桌面组件真机取证（小米 13 / Android 15，5bf0cda4）。
# 输出：verify/ui-widget-month.png（组件在桌面）、ui-widget-month-picker.png（添加路径）、
#       ui-widget-month.xml（uiautomator dump，证明格子里有日期数字与今天高亮）。
set -u
ADB="adb -s 5bf0cda4"
OUT="$(cd "$(dirname "$0")" && pwd)"

echo "== 1. 安装 =="
$ADB install -r app/build/outputs/apk/debug/app-debug.apk

echo "== 2. 触发系统添加确认框（月历） =="
$ADB shell am start -a app.took.action.PIN_MONTH_WIDGET -n app.took/.homewidget.MonthWidgetPinActivity
sleep 3
$ADB exec-out screencap -p > "$OUT/ui-widget-month-picker.png"

echo "== 3. 桌面截图 + dump =="
$ADB shell input keyevent KEYCODE_HOME
sleep 2
$ADB exec-out screencap -p > "$OUT/ui-widget-month.png"
$ADB shell uiautomator dump /sdcard/month.xml >/dev/null 2>&1
$ADB pull /sdcard/month.xml "$OUT/ui-widget-month.xml"

echo "== 4. 组件是否真的被系统登记 =="
$ADB shell dumpsys appwidget | grep -i "app.took" 
echo "== 5. dump 里能否搜到日期数字与今天标记 =="
grep -o "今天" "$OUT/ui-widget-month.xml" | head -3
grep -o "月历" "$OUT/ui-widget-month.xml" | head -3
