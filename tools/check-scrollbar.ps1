# Check bottom band of window for a wide horizontal scrollbar
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$bmp = New-Object System.Drawing.Bitmap("$env:TEMP\mdr-window.png")
$w = $bmp.Width; $h = $bmp.Height
# 扫描底部 120px：统计每行中"浅灰(180-235)"像素数——滚动条轨道特征
$y = $h - 120
while ($y -lt $h) {
  $c = 0
  $x = 600
  while ($x -lt ($w - 60)) {
    $p = $bmp.GetPixel($x, $y)
    if (($p.R -ge 175) -and ($p.R -le 240) -and ([Math]::Abs($p.R - $p.G) -lt 10) -and ([Math]::Abs($p.G - $p.B) -lt 10)) { $c = $c + 1 }
    $x = $x + 4
  }
  if ($c -gt 50) { Write-Output "y=$y gray-line-pixels=$c (scrollbar track?)" }
  $y = $y + 2
}
Write-Output "done"
$bmp.Dispose()
