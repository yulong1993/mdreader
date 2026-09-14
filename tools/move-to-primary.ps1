param([int]$ProcId)
Add-Type '
using System;
using System.Text;
using System.Runtime.InteropServices;
public class MV {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int cx, int cy, uint f);
  [DllImport("user32.dll")] public static extern IntPtr FindWindow(string c, string t);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  public struct RECT { public int L, T, R, B; }
}'
[MV]::SetProcessDPIAware() | Out-Null
$h = [MV]::FindWindow($null, "MD Reader")
if ($h -eq [IntPtr]::Zero) { Write-Output "window not found"; exit 1 }
$r = New-Object MV+RECT
[MV]::GetWindowRect($h, [ref]$r) | Out-Null
Write-Output "before: ($($r.L),$($r.T))-($($r.R),$($r.B))"
# move to primary monitor, keep size
[MV]::SetWindowPos($h, [IntPtr]::Zero, 300, 200, 0, 0, 0x0005) | Out-Null  # SWP_NOSIZE|SWP_NOZORDER
Start-Sleep -Milliseconds 1500
$r2 = New-Object MV+RECT
[MV]::GetWindowRect($h, [ref]$r2) | Out-Null
Write-Output "after: ($($r2.L),$($r2.T))-($($r2.R),$($r2.B))"
