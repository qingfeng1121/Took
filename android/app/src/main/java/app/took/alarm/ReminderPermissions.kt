package app.took.alarm

import android.Manifest
import android.app.AlarmManager
import android.app.NotificationManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings

/**
 * 能不能真的响——权限与 ROM 限制的唯一真相来源（定稿 §6.3.3）。
 *
 * 三件事分开算，因为它们的系统入口完全不同：
 *  - 通知权限（Android 13+ 运行时授予，拒了系统静默丢通知）；
 *  - 精确闹钟（Android 14 起 `SCHEDULE_EXACT_ALARM` 默认关，跳 ACTION_REQUEST_SCHEDULE_EXACT_ALARM）；
 *  - 全屏通知（Android 14+ 收紧，跳 ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT）。
 *
 * 再加两条 ROM 限制：电池优化白名单（可跳）与小米自启动/锁屏显示（只能引导，见 [Jump]）。
 */
data class ReminderPermissionState(
    val notifications: Boolean,
    val exactAlarms: Boolean,
    val fullScreenIntent: Boolean,
    val ignoringBatteryOptimizations: Boolean,
) {
    /** 通知与精确闹钟都到位才算「能真的响」；全屏缺失只影响闹钟形态。 */
    val canRing: Boolean get() = notifications && exactAlarms
}

/**
 * 一个真实的跳转：[intent] 为 null 表示这台机器上**没有可用的系统页**，
 * 此时 UI 只显示 [path] 文字路径，绝不画一个点了没反应的按钮。
 */
data class Jump(val intent: Intent?, val path: String)

object ReminderPermissions {

    fun read(context: Context): ReminderPermissionState {
        val nm = context.getSystemService(NotificationManager::class.java)
        val am = context.getSystemService(AlarmManager::class.java)
        val pm = context.getSystemService(PowerManager::class.java)
        val notify = Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
            context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) ==
            PackageManager.PERMISSION_GRANTED
        val exact = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            am?.canScheduleExactAlarms() == true
        } else {
            true
        }
        val fullScreen = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            nm?.canUseFullScreenIntent() == true
        } else {
            true
        }
        val battery = pm?.isIgnoringBatteryOptimizations(context.packageName) == true
        return ReminderPermissionState(notify, exact, fullScreen, battery)
    }

    /** 运行时申请 POST_NOTIFICATIONS 需要它；Android 13 以下不用问。 */
    fun needsNotificationRuntimePermission(context: Context): Boolean =
        Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU && !read(context).notifications

    /**
     * 通知权限的系统页。已经问过一次就别再弹运行时对话框（用户可能永久拒绝），
     * 直接跳应用通知页 —— 这是唯一能真的把开关打开的地方。
     */
    fun notificationsJump(context: Context): Jump {
        val intent = Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
            .putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        return Jump(resolvable(context, intent), "设置 › 应用管理 › Tool › 通知")
    }

    fun exactAlarmsJump(context: Context): Jump? {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return null
        val intent = Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM)
            .setData(Uri.parse("package:${context.packageName}"))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        return Jump(resolvable(context, intent), "设置 › 应用管理 › Tool › 闹钟和提醒")
    }

    fun fullScreenJump(context: Context): Jump? {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.UPSIDE_DOWN_CAKE) return null
        val intent = Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT)
            .setData(Uri.parse("package:${context.packageName}"))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        return Jump(resolvable(context, intent), "设置 › 应用管理 › Tool › 全屏通知")
    }

    fun batteryJump(context: Context): Jump {
        val direct = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS)
            .setData(Uri.parse("package:${context.packageName}"))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        val list = Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        val intent = resolvable(context, direct) ?: resolvable(context, list)
        return Jump(intent, "设置 › 应用管理 › Tool › 省电策略 › 无限制")
    }

    /**
     * 自启动（小米 = 自启动管理）。MIUI/HyperOS 没有公开 API，只能试已知的厂商组件；
     * 一个都不可用就返回 intent=null，让 UI 明说路径。
     */
    fun autostartJump(context: Context): Jump {
        val candidates = listOf(
            ComponentName(
                "com.miui.securitycenter",
                "com.miui.permcenter.autostart.AutoStartManagementActivity",
            ),
            ComponentName(
                "com.miui.securitycenter",
                "com.miui.powercenter.PowerSettings",
            ),
        )
        for (c in candidates) {
            val i = Intent().setComponent(c).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            resolvable(context, i)?.let {
                return Jump(it, "安全中心 › 应用管理 › 权限 › 自启动")
            }
        }
        return Jump(null, "安全中心 › 应用管理 › 权限 › 自启动（本机没有可直接跳转的入口）")
    }

    /** 小米「锁屏显示」与「后台弹窗」：全屏闹钟能不能弹出来全靠这两个。 */
    fun miuiFullScreenJump(context: Context): Jump {
        val intent = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS)
            .setData(Uri.parse("package:${context.packageName}"))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        return Jump(resolvable(context, intent), "设置 › 应用管理 › Tool › 其他权限 › 锁屏显示 / 后台弹出界面")
    }

    /** 解析不了就返回 null —— 用来区分「能跳」与「只能写路径」。 */
    private fun resolvable(context: Context, intent: Intent): Intent? =
        if (context.packageManager.resolveActivity(intent, PackageManager.MATCH_DEFAULT_ONLY) != null) {
            intent
        } else {
            null
        }

    fun isMiui(): Boolean =
        Build.MANUFACTURER.contains("xiaomi", ignoreCase = true) ||
            Build.BRAND.contains("redmi", ignoreCase = true) ||
            Build.BRAND.contains("poco", ignoreCase = true)
}
