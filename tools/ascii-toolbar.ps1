# 顶部区域 ASCII 可视化（单像素采样，最简语法）
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$chars = " .:-=+*#%@"

$jobs = @(
  ,@("USER-BROKEN", "C:\Users\gongs\.zcode\cli\image-cache\sess_fed24083-551c-4a24-8d8c-c4c8bd28211c\image-999b4cea8a0cfc68f2a931232293e97d.png")
  ,@("MY-HEALTHY", "$env:TEMP\mdr-window.png")
)

foreach ($job in $jobs) {
  $label = $job[0]
  $path = $job[1]
  $img = [System.Drawing.Image]::FromFile($path)
  $bmp = New-Object System.Drawing.Bitmap($img)
  $w = $bmp.Width
  Write-Output "=== $label ($w x $($bmp.Height)) x1900..end y6..90 ==="
  $y = 10
  while ($y -lt 90) {
    $line = ""
    $x = 1900
    while ($x -lt ($w - 4)) {
      $p = $bmp.GetPixel($x, $y)
      $avg = ($p.R + $p.G + $p.B) / 3
      $idx = [int]((255 - $avg) / 26)
      if ($idx -gt 9) { $idx = 9 }
      $line = $line + $chars[$idx]
      $x = $x + 10
    }
    Write-Output $line
    $y = $y + 12
  }
  $bmp.Dispose()
  $img.Dispose()
}
