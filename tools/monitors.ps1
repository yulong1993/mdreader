# Enumerate ALL monitors with DPI-aware coordinates (C#5-compatible)
Add-Type '
using System;
using System.Runtime.InteropServices;
public class Mon {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool EnumDisplayMonitors(IntPtr hdc, IntPtr clip, MonEnumProc cb, IntPtr data);
  [DllImport("user32.dll")] public static extern uint GetDpiForMonitor(IntPtr h, uint type, out uint dx, out uint dy);
  public struct RECTM { public int L, T, R, B; }
  public delegate bool MonEnumProc(IntPtr h, IntPtr hdc, ref RECTM rect, IntPtr data);
  public static string Out = "";
  public static bool Cb(IntPtr h, IntPtr hdc, ref RECTM rect, IntPtr data) {
    uint dx = 0; uint dy = 0;
    GetDpiForMonitor(h, 0, out dx, out dy);
    Out += string.Format("monitor h={0} rect=({1},{2})-({3},{4}) size={5}x{6} dpi={7}", h, rect.L, rect.T, rect.R, rect.B, rect.R - rect.L, rect.B - rect.T, dx);
    return true;
  }
  public static void Go() {
    EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, new MonEnumProc(Cb), IntPtr.Zero);
  }
}'
[Mon]::SetProcessDPIAware() | Out-Null
[Mon]::Go()
Write-Output ([Mon]::Out)
