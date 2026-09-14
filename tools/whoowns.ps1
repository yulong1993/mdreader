# Identify which window owns the pixels right of the main window's right edge
Add-Type '
using System;
using System.Text;
using System.Runtime.InteropServices;
public class WF {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint flags);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  public struct RECT { public int L, T, R, B; }
}'
[WF]::SetProcessDPIAware() | Out-Null

$mdr = Get-Process mdreader
foreach ($sx in @(2300, 2360, 2420, 2480, 2540, 2600)) {
  $pt = New-Object WF+POINT
  $pt.X = $sx; $pt.Y = 800
  $h = [WF]::WindowFromPoint($pt)
  $root = [WF]::GetAncestor($h, 2)
  $sb = New-Object System.Text.StringBuilder 256
  [void][WF]::GetClassName($root, $sb, 256)
  $cls = $sb.ToString()
  $pid2 = 0
  [void][WF]::GetWindowThreadProcessId($root, [ref]$pid2)
  $pr = New-Object WF+RECT
  [void][WF]::GetWindowRect($root, [ref]$pr)
  $procName = try { (Get-Process -Id $pid2 -ErrorAction Stop).ProcessName } catch { "?" }
  Write-Output "screen-x=$sx -> hwnd=$h root=$root class=$cls pid=$pid2 proc=$procName rect=($($pr.L),$($pr.T))-($($pr.R),$($pr.B))"
}
