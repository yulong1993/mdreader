param([int]$ProcId, [int]$NewX = 300, [int]$NewY = 200)
Add-Type '
using System;
using System.Text;
using System.Runtime.InteropServices;
public class MV2 {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int cx, int cy, uint f);
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr h);
  delegate bool EnumWindowsProc(IntPtr h, IntPtr l);
  public static IntPtr Found = IntPtr.Zero;
  public static bool Cb(IntPtr h, IntPtr l) {
    uint pid; GetWindowThreadProcessId(h, out pid);
    if (pid == (uint)Target && GetWindowText(h, SB, 256) > 0 && SB.ToString() == "MD Reader") { Found = h; return false; }
    return true;
  }
  public static uint Target;
  public static StringBuilder SB = new StringBuilder(256);
}'
[MV2]::SetProcessDPIAware() | Out-Null
[MV2]::Target = [uint32]$ProcId
[MV2]::EnumWindows([MV2+EnumWindowsProc]::new([MV2]::Cb), [IntPtr]::Zero) | Out-Null
if ([MV2]::Found -eq [IntPtr]::Zero) { Write-Output "not-found"; exit 1 }
Write-Output ("dpi-before=" + [MV2]::GetDpiForWindow([MV2]::Found))
[MV2]::SetWindowPos([MV2]::Found, [IntPtr]::Zero, $NewX, $NewY, 0, 0, 0x0005) | Out-Null
Start-Sleep -Milliseconds 1500
Write-Output ("dpi-after=" + [MV2]::GetDpiForWindow([MV2]::Found))
Write-Output "moved"
