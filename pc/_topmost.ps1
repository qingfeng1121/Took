Add-Type @"
using System;
using System.Runtime.InteropServices;
public class P {
  [DllImport("user32.dll")] public static extern IntPtr GetWindowLongPtr(IntPtr h, int i);
}
"@
$p = Get-Process -Name took -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $p) { Write-Output '{"ok":false,"why":"no window"}'; exit }
$h = $p.MainWindowHandle
$ex = [P]::GetWindowLongPtr($h, -20).ToInt64()
$top = (($ex -band 0x8) -ne 0)
Write-Output ("{""ok"":true,""hwnd"":" + $h.ToInt64() + ",""exstyle"":" + $ex + ",""topmost"":" + $top.ToString().ToLower() + ",""pid"":" + $p.Id + "}")
