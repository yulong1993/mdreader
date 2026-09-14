# 像素取证 v2：抓窗口区域，程序化分析墨水分布
Add-Type '
using System;
using System.Runtime.InteropServices;
public class PF0 { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }'
[PF0]::SetProcessDPIAware() | Out-Null
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$proc = Get-Process mdreader
$procId = $proc.Id
Add-Type '
using System;
using System.Text;
using System.Runtime.InteropServices;
public class PF2 {
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  public struct RECT { public int L, T, R, B; }
  public static RECT wr;
  delegate bool EnumWindowsProc(IntPtr h, IntPtr l);
  public static void Find(uint target) {
    EnumWindows((h, l) => {
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (pid == target) {
        var sb = new StringBuilder(256); GetWindowText(h, sb, 256);
        if (sb.ToString() == "MD Reader") { RECT r; GetWindowRect(h, out r); wr = r; }
      }
      return true;
    }, IntPtr.Zero);
  }
}'
[PF2]::Find([uint32]$procId)
$L = [PF2]::wr.L; $T = [PF2]::wr.T; $R = [PF2]::wr.R; $B = [PF2]::wr.B
$w = $R - $L; $h = $B - $T
Write-Output "window-rect: ($L,$T)-($R,$B) size=${w}x${h}"

$sw = [System.Windows.Forms.SystemInformation]::VirtualScreen.Width
$sh = [System.Windows.Forms.SystemInformation]::VirtualScreen.Height
$bmp = New-Object System.Drawing.Bitmap($sw, $sh)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen(0, 0, 0, 0, $bmp.Size)
$g.Dispose()

$win = $bmp.Clone([System.Drawing.Rectangle]::new($L, $T, $w, $h), $bmp.PixelFormat)
$win.Save("$env:TEMP\mdr-window.png", [System.Drawing.Imaging.ImageFormat]::Png)

$rightInk = -1
for ($x = $w - 1; $x -ge 0; $x -= 2) {
  for ($y = 0; $y -lt $h; $y += 3) {
    $p = $win.GetPixel($x, $y)
    if ($p.R -lt 240 -or $p.G -lt 240 -or $p.B -lt 240) { $rightInk = $x; break }
  }
  if ($rightInk -ge 0) { break }
}
$leftInk = -1
for ($x = 0; $x -lt $w; $x += 2) {
  for ($y = 0; $y -lt $h; $y += 3) {
    $p = $win.GetPixel($x, $y)
    if ($p.R -lt 240 -or $p.G -lt 240 -or $p.B -lt 240) { $leftInk = $x; break }
  }
  if ($leftInk -ge 0) { break }
}
$bottomInk = -1
for ($y = $h - 1; $y -ge 0; $y -= 2) {
  for ($x = 0; $x -lt $w; $x += 3) {
    $p = $win.GetPixel($x, $y)
    if ($p.R -lt 240 -or $p.G -lt 240 -or $p.B -lt 240) { $bottomInk = $y; break }
  }
  if ($bottomInk -ge 0) { break }
}
Write-Output "ink-extents: left=$leftInk right=$rightInk bottom=$bottomInk (window ${w}x${h})"

$step = [Math]::Max(1, [int]($w / 50))
$prof = New-Object System.Collections.Generic.List[string]
for ($x = 0; $x -lt $w; $x += $step) {
  $c = 0
  for ($y = 0; $y -lt $h; $y += 4) {
    $p = $win.GetPixel($x, $y)
    if ($p.R -lt 240 -or $p.G -lt 240 -or $p.B -lt 240) { $c++ }
  }
  $prof.Add("x$x`:$c")
}
Write-Output ("profile: " + ($prof -join ","))

$bmp.Dispose(); $win.Dispose()
Write-Output "saved: $env:TEMP\mdr-window.png"
