# Full-screen ASCII overview around MD Reader window
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$chars = " .:-=+*#%@"
$bmp = New-Object System.Drawing.Bitmap("$env:TEMP\mdr-wide.png")
$w = $bmp.Width; $h = $bmp.Height
Write-Output "capture ${w}x${h} (window ends at x~2226)"
$y = 0
while ($y -lt ($h - 10)) {
  $line = ""
  $x = 0
  while ($x -lt ($w - 8)) {
    $p = $bmp.GetPixel($x, $y)
    $avg = ($p.R + $p.G + $p.B) / 3
    $idx = [int]((255 - $avg) / 26)
    if ($idx -gt 9) { $idx = 9 }
    $line = $line + $chars[$idx]
    $x = $x + 25
  }
  Write-Output $line
  $y = $y + 40
}
$bmp.Dispose()
