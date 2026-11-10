#!/usr/bin/env bash
# 配置页类型导航 + 左滑操作的真机验证（用户 2026-10-25 截图需求）。
# 用法：bash verify/ui-cfg-verify.sh   （需先持有 .device-lock.md 第 4 节的设备锁）
set -u
ADB="D:/work/android-sdk/platform-tools/adb.exe"
DEV="-s 5bf0cda4"
APK="app/build/outputs/apk/debug/app-debug.apk"
PKG="app.took"
OUT="verify"

say() { echo "== $* =="; }
dump() {
  "$ADB" $DEV shell uiautomator dump /sdcard/w.xml >/dev/null 2>&1
  "$ADB" $DEV pull /sdcard/w.xml "$OUT/w-cfg.xml" >/dev/null 2>&1
}

say install
"$ADB" $DEV install -r "$APK" 2>&1 | tail -2
"$ADB" $DEV shell am force-stop $PKG
"$ADB" $DEV shell am start -n $PKG/.MainActivity 2>&1 | tail -1
sleep 3

SIZE=$("$ADB" $DEV shell wm size | tr -d '\r')
W=$(echo "$SIZE" | sed -E 's/.* ([0-9]+)x([0-9]+).*/\1/')
H=$(echo "$SIZE" | sed -E 's/.* ([0-9]+)x([0-9]+).*/\2/')
echo "screen ${W}x${H}"

TABX=$(( W / 2 ))
TABY=$(( H - 60 ))
say "open config tab at ${TABX},${TABY}"
"$ADB" $DEV shell input tap $TABX $TABY
sleep 2
dump
"$ADB" $DEV exec-out screencap -p > "$OUT/ui-cfg-tabs-rule.png"

# 从 dump 里按 content-desc 找元素中心点
nodexy() {
  python - "$OUT/w-cfg.xml" "$1" <<PY
import re,sys
x=open(sys.argv[1],encoding="utf-8").read()
want=sys.argv[2]
for m in re.finditer(r"<node[^>]*>",x):
    t=m.group(0)
    d=re.search(r'content-desc="([^"]*)"',t)
    b=re.search(r'bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"',t)
    if d and b and d.group(1).strip()==want:
        x1,y1,x2,y2=map(int,b.groups())
        print((x1+x2)//2, (y1+y2)//2); break
PY
}

for pair in "记事:note" "倒数日:countdown" "笔记本:notebook"; do
  want=$(echo "$pair" | cut -d: -f1)
  slug=$(echo "$pair" | cut -d: -f2)
  xy=$(nodexy "类型 $want")
  if [ -z "$xy" ]; then echo "WARN: 没找到类型项 $want"; continue; fi
  say "tap 类型 $want at $xy"
  "$ADB" $DEV shell input tap $xy
  sleep 2
  dump
  "$ADB" $DEV exec-out screencap -p > "$OUT/ui-cfg-tabs-$slug.png"
done

xy=$(nodexy "类型 规则")
[ -n "$xy" ] && "$ADB" $DEV shell input tap $xy && sleep 2
dump
say "before-pin dump saved"
cp "$OUT/w-cfg.xml" "$OUT/ui-cfg-order-before.xml"

# 第一张规则卡的 y：取 y 最小的「N 个任务」文本节点
ROW=$(python - "$OUT/w-cfg.xml" <<PY
import re,sys
x=open(sys.argv[1],encoding="utf-8").read()
best=None
for m in re.finditer(r"<node[^>]*>",x):
    t=m.group(0)
    tx=re.search(r'text="([^"]*)"',t)
    b=re.search(r'bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"',t)
    if tx and b and tx.group(1).endswith("个任务"):
        x1,y1,x2,y2=map(int,b.groups())
        if best is None or y1<best[1]: best=(x1,y1,x2,y2)
print("%d %d %d %d" % best if best else "")
PY
)
echo "first rule row bounds: $ROW"
set -- $ROW
if [ $# -eq 4 ]; then
  RY=$(( ($2 + $4) / 2 ))
  SW=$(( W * 45 / 100 ))
  say "swipe left on row y=$RY"
  "$ADB" $DEV shell input swipe $(( W * 80 / 100 )) $RY $(( W * 80 / 100 - SW )) $RY 400
  sleep 1
  dump
  "$ADB" $DEV exec-out screencap -p > "$OUT/ui-cfg-swipe.png"
fi
