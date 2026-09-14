# Capture screen region: window rect + 400px margin right, analyze ink distribution
Add-Type '
using System;
using System.Runtime.InteropServices;
public class PF9 { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }'
[PF9]::SetProcessDPIAware() | Out-Null
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$procId = (Get-Process mdreader).Id
Add-Type '
using System;
using System.Text;
using System.Runtime.InteropServices;
public class PF3 {
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
[PF3]::Find([uint32]$procId)
$L = [PF3]::wr.L; $T = [PF3]::wr.T; $R = [PF3]::wr.R; $B = [PF3]::wr.B
Write-Output "window-rect: ($L,$T)-($R,$B)"

$capW = ($R - $L) + 400
$capH = ($B - $T) + 60
$bmp = New-Object System.Drawing.Bitmap($capW, $capH)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($L, $T, 0, 0, $bmp.Size)
$g.Dispose()

# Column ink profile over the FULL capture (window + margin)
$prof = New-Object System.Text.StringBuilder
$x = 0
while ($x -lt $capW) {
  $c = 0
  $y = 120
  while ($y -lt ($capH - 20)) {
    $p = $bmp.GetPixel($x, $y)
    if (($p.R -lt 200) -and ($p.G -lt 200) -and ($p.B -lt 200)) { $c = $c + 1 }
    $y = $y + 6
  }
  if ($x -ge (($R - $L) - 60) -or (($x % 100) -eq 0)) {
    [void]$prof.Append("x$x=$c ")
  }
  $x = $x + 20
}
Write-Output ("ink-profile (content band y120+): " + $prof.ToString())

# What is in the 400px margin right of the window? (desktop vs content)
$mStart = $R - $L
$c2 = 0
$x = $mStart + 20
while ($x -lt $capW) {
  $y = 150
  while ($y -lt ($capH - 40)) {
    $p = $bmp.GetPixel($x, $y)
    if (($p.R -lt 200) -and ($p.G -lt 200) -and ($p.B -lt 200)) { $c2 = $c2 + 1 }
    $y = $y + 6
  }
  $x = $x + 40
}
Write-Output "margin-right-of-window ink samples: $c2"

$bmp.Save("$env:TEMP\mdr-wide.png", [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Output "saved: $env:TEMP\mdr-wide.png"
