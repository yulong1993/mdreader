param([int]$ProcId, [switch]$Restore)
Add-Type '
using System;
using System.Text;
using System.Runtime.InteropServices;
using System.Collections.Generic;
public class WinEnum {
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int i);
  public struct RECT { public int L, T, R, B; }
  delegate bool EnumWindowsProc(IntPtr h, IntPtr l);
  public static List<string> Go(uint target) {
    var outp = new List<string>();
    EnumWindows((h, l) => {
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (pid == target) {
        var sb = new StringBuilder(256); GetWindowText(h, sb, 256);
        RECT r; GetWindowRect(h, out r);
        int style = GetWindowLong(h, -16);
        outp.Add(string.Format("hwnd={0} vis={1} iconic={2} rect=({3},{4})-({5},{6}) style={7:X} title={8}",
          h, IsWindowVisible(h), IsIconic(h), r.L, r.T, r.R, r.B, style, sb));
      }
      return true;
    }, IntPtr.Zero);
    return outp;
  }
}' -PassThru
$cls = $AddTypeResult 2>$null
foreach ($line in [WinEnum]::Go([uint32]$ProcId)) { Write-Host $line }
if ($Restore) {
  # 恢复标题为 MD Reader 的主窗口
  foreach ($line in [WinEnum]::Go([uint32]$ProcId)) {
    if ($line -match 'hwnd=(\d+).*title=MD Reader') {
      [WinEnum]::ShowWindow([IntPtr][long]$Matches[1], 9) | Out-Null
      Write-Host "restored hwnd=$($Matches[1])"
    }
  }
  Start-Sleep -Milliseconds 800
  foreach ($line in [WinEnum]::Go([uint32]$ProcId)) { Write-Host $line }
}
