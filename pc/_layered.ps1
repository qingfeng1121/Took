
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class L {
  [DllImport("user32.dll")] public static extern IntPtr GetWindowLongPtr(IntPtr h, int i);
  [DllImport("user32.dll")] public static extern bool GetLayeredWindowAttributes(IntPtr h, out int key, out byte alpha, out int flags);
}
"@
$p = Get-Process -Name took -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $p) { Write-Output '{"ok":false,"why":"no window"}'; exit }
$h = $p.MainWindowHandle
$ex = [L]::GetWindowLongPtr($h, -20).ToInt64()
$layered = (($ex -band 0x80000) -ne 0)
$key = 0; $alpha = [byte]0; $flags = 0
$got = [L]::GetLayeredWindowAttributes($h, [ref]$key, [ref]$alpha, [ref]$flags)
Write-Output ("{""ok"":true,""hwnd"":" + $h.ToInt64() + ",""exstyle"":" + $ex + ",""layered"":" + $layered.ToString().ToLower() + ",""alpha"":" + $alpha + ",""flags"":" + $flags + ",""got"":" + $got.ToString().ToLower() + "}")
