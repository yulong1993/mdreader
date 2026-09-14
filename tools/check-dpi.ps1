# Compare DPI awareness context of mdreader windows
Add-Type '
using System;
using System.Text;
using System.Runtime.InteropServices;
public class DPI {
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern IntPtr GetWindowDpiAwarenessContext(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetAwarenessFromDpiAwarenessContext(IntPtr ctx);
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr h);
  public struct RECT2 { public int L, T, R, B; }
  delegate bool EnumWindowsProc(IntPtr h, IntPtr l);
  public static void Go(uint target) {
    EnumWindows((h, l) => {
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (pid == target) {
        var sb = new StringBuilder(256); GetWindowText(h, sb, 256);
        if (sb.ToString() == "MD Reader") {
          IntPtr ctx = GetWindowDpiAwarenessContext(h);
          uint aware = GetAwarenessFromDpiAwarenessContext(ctx);
          uint dpi = GetDpiForWindow(h);
          WriteOut(string.Format("hwnd={0} awareness={1} (0=unaware,1=system,2=permonitor) windowDpi={2}", h, aware, dpi));
        }
      }
      return true;
    }, IntPtr.Zero);
  }
  public static Action<string> WriteOut = (s) => Console.WriteLine(s);
}'
[DPI]::Go([uint32]$args[0])
