# 验证 MD Reader 主窗口：非最小化 + 尺寸约 2226x1591 物理 + 最大化/还原循环后仍正确
param([int]$ProcId)
Add-Type '
using System;
using System.Text;
using System.Runtime.InteropServices;
using System.Collections.Generic;
public class WCheck {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  public struct RECT { public int L, T, R, B; }
  delegate bool EnumWindowsProc(IntPtr h, IntPtr l);
  public static IntPtr mainHwnd = IntPtr.Zero;
  public static string Snap(uint target) {
    var sbOut = new StringBuilder();
    EnumWindows((h, l) => {
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (pid == target) {
        var sb = new StringBuilder(256); GetWindowText(h, sb, 256);
        if (sb.ToString() == "MD Reader") {
          mainHwnd = h;
          RECT r; GetWindowRect(h, out r);
          sbOut.AppendFormat("iconic={0} rect=({1},{2})-({3},{4}) {5}x{6}",
            IsIconic(h), r.L, r.T, r.R, r.B, r.R - r.L, r.B - r.T);
        }
      }
      return true;
    }, IntPtr.Zero);
    return sbOut.ToString();
  }
}'
function Snap($label) {
  $s = [WCheck]::Snap([uint32]$ProcId)
  Write-Host "$label $s"
  return $s
}
[WCheck]::SetProcessDPIAware() | Out-Null   # 拿真实物理坐标，避免 DPI 虚拟化假象
Start-Sleep -Milliseconds 500
$s1 = Snap "init:  "
if ([WCheck]::mainHwnd -eq [IntPtr]::Zero) { Write-Host "FAIL no main window"; exit 1 }
[WCheck]::ShowWindow([WCheck]::mainHwnd, 3) | Out-Null   # SW_MAXIMIZE
Start-Sleep -Milliseconds 600
[WCheck]::ShowWindow([WCheck]::mainHwnd, 9) | Out-Null   # SW_RESTORE
Start-Sleep -Milliseconds 900
$s2 = Snap "restored:"
$fail = $false
foreach ($s in @($s1, $s2)) {
  if ($s -match "iconic=True") { Write-Host "FAIL minimized"; $fail = $true }
  if ($s -match "(\d+)x(\d+)$") {
    $w = [int]$Matches[1]; $hgt = [int]$Matches[2]
    if ([math]::Abs($w - 2226) -gt 60 -or [math]::Abs($hgt - 1591) -gt 60) {
      Write-Host "FAIL bad size ${w}x${hgt}(expect ~2226x1591)"; $fail = $true
    }
  }
}
if (-not $fail) { Write-Host "PASS size and state OK" }
