# Took · Android 端（月历 + 打卡 + 规则/任务编辑）

Kotlin + Jetpack Compose，compileSdk 34 / minSdk 26 / targetSdk 34，**不接 Glance 卡片**。
行为语义逐条对齐 docs/本地优先契约.md。

## 构建与验证

系统 Gradle 8.7（不用 wrapper，避免重复下载发行版）：

    export JAVA_HOME='D:\work\JDK\Jdk21'
    export ANDROID_HOME='D:\work\android-sdk'
    export GRADLE_USER_HOME='D:\work\gradle-home'
    export PATH="/d/work/JDK/Jdk21/bin:/d/work/android-sdk/platform-tools:/d/work/gradle/gradle-8.7/bin:$PATH"

    cd D:/work/Project/Took/android
    gradle.bat testDebugUnitTest --rerun-tasks   # 37 个单测（含契约 §9.6 的 E1~E6）
    gradle.bat assembleDebug  # 产物 app/build/outputs/apk/debug/app-debug.apk

模拟器（AVD shiroha_pc，android-34）：

    emulator.exe -avd shiroha_pc -no-window -gpu swiftshader_indirect &
    adb -s emulator-5554 install -r app/build/outputs/apk/debug/app-debug.apk
    adb -s emulator-5554 shell am start -n app.took/.MainActivity

## 目录

| 路径 | 内容 |
|---|---|
| engine/Engine.kt | 契约 §3.2 occursOn / §3.3 periodStartOf / §3.4 日期解析 |
| calendar/MonthGridLayout.kt | 42 格、周一起始的排布（纯 Kotlin，可 JVM 单测） |
| data/TookDb.kt | 四表建表 + 首启种子（与 Go 后端 ensureSeed 逐条一致） |
| data/TookRepository.kt | 查询 + 写路径接线：月历 42 格 / 当天命中 / 规则与任务编辑 |
| data/RuleEditPolicy.kt | 契约 §9.2 的 split 判定、封口上界、字段校验（纯 Kotlin，可 JVM 单测） |
| data/RuleEditService.kt | 写路径：新增 / 修改 / 裂开 / 删除规则，任务增删改，复制任务到新规则 |
| data/RuleStore.kt | 规则 / 任务存储端口 + SQLite 实现（整行写入，含同步四件套） |
| ui/RuleEditorPage.kt | 规则编辑页（Dialog 独立窗口，从右侧滑入） |
| ui/CalendarScreen.kt | 应用栏 + 月历卡 + 今日概览条 + 底部三 tab |
| ui/DayPanel.kt | 当天面板（只读，无打卡入口） |
| verify/ | 模拟器截图、uiautomator dump、设备库副本与校验脚本 |

## 两个技术决定

**1. 用 SQLiteOpenHelper 而不是 Room。** 首期只读，没有迁移 / Flow 观察 / 关系映射需求；
Room 需要 KSP 注解处理器，KSP 版本必须与 Kotlin 精确对齐，本机 Gradle 缓存里没有任何 KSP 产物
（caches/modules-2/files-2.1/com.google.devtools.ksp 为空），引入即多一层解析风险。
建表 DDL 与 server/internal/store/schema.sql 同构，日后换 Room 可原样搬。

**2. DayOfWeek 换算。** 契约 bit0=周一…bit6=周日；Kotlin 的 DayOfWeek 是 MONDAY=1…SUNDAY=7，
因此位号 = dayOfWeek.value - 1。这里**不能**照抄 Go 的 (weekday+6)%7 —— 那是「周日=0」体系的换算。

## 与契约的差异（唯一一处，属契约内部不一致）

§3.4 要求非法日期格式「必须报错，不得静默兜底」，而 Go 的 OccursOn 在解析失败时静默返回 false。
Kotlin 端按 §3.4 字样实现：DateKeys.parse 与 Engine.occursOn/periodStartOf 遇到
2026-1-5、2026/10/01、2026-02-30 一律抛 IllegalArgumentException（有单测覆盖）。

## 编辑语义（契约 §9，2026-10-24 起）

- **改重复设置必须裂开**：`repeat_mode / weekdays_mask / repeat_every / month_day / year_month /
  year_day / start_date` 任一变化 → 旧规则原地写 `repeat_until = 昨天`，另建一条新规则
  （客户端生成新 id、`start_date = 今天`）；旧规则下的任务与 completion 一条不动。
- **只改 title / enabled / 起止上界 → 原地改**。
- split 判定只写在 `RuleEditPolicy.needsSplit`，比对的是「库里的现有行」与草稿，所以原样保存
  永远不会裂开；已结束的规则（上界早于今天）拒绝改重复设置，同一段历史不可能被封口两次；
  裂开必须 `confirmSplit = true`（服务层默认拒绝，UI 再弹一次确认）。
- `changedFields` **只比对与当前 repeat_mode 相关的字段**：库里与模式无关的列是 NULL，而表单
  对这些字段有默认值，若「所有字段都比」，weekly 规则改个标题也会被判成改了 repeat_every 而白白
  裂开一条（2026-10-24 实测抓到的 bug，`unchangedWeeklyRuleIgnoresIrrelevantFieldDefaults` 守住）。
- 裂开后第二段对话框里的「复制 N 个任务到新规则」**默认勾选**，主按钮「确定」按勾选状态执行
  （契约 §9.2：默认不勾会让用户误判「任务全没了」；复制生成新 id、旧规则任务与打卡一条不动，
  取消勾选也合法 → 新规则先留空）。
- 删除规则 = 规则 + 其下任务软删；completion 永不删（历史事实，且删了会在另一端复活）。

## 明确没做

- Glance 桌面卡片、memo 三类的渲染（表和读通路已建，界面未用）。
- 密度三档中的 standard / loose：手机宽度固定 compact（1 个任务名 + +N + 圆点）。
- 提醒设置：rule 表没有提醒列（契约 §2 字段表里没有），编辑页只做重复方式与日期。