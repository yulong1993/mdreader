# 测量大纲面板右边框位置：从左往右找第一条"贯穿性竖线"（连续 800px 高的浅灰竖线）
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

foreach ($pair in @(
  ,@("USER-BROKEN", "C:\Users\gongs\.zcode\cli\image-cache\sess_fed24083-551c-4a24-8d8c-c4c8bd28211c\image-999b4cea8a0cfc68f2a931232293e97d.png")
  ,@("MY-HEALTHY", "$env:TEMP\mdr-window.png")
)) {
  $label = $pair[0]
  $path = $pair[1]
  $img = [System.Drawing.Image]::FromFile($path)
  $bmp = New-Object System.Drawing.Bitmap($img)
  $w = $bmp.Width
  $h = $bmp.Height
  Write-Output "=== $label ($w x $h) ==="
  $best = -1
  $bestScore = 0
  $x = 100
  while ($x -lt 900) {
    $score = 0
    $y = 150
    while ($y -lt 1450) {
      $p = $bmp.GetPixel($x, $y)
      if (($p.R -gt 120) -and ($p.R -lt 235) -and ([Math]::Abs($p.R - $p.G) -lt 12) -and ([Math]::Abs($p.G - $p.B) -lt 12)) {
        $score++
      }
      $y = $y + 5
    }
    if ($score -gt $bestScore) { $bestScore = $score; $best = $x }
    $x = $x + 1
  }
  Write-Output "outline-right-border: x=$best score=$bestScore/260 (outline-width=$best phys, $($best/2) logical@2x)"
  $bmp.Dispose()
  $img.Dispose()
}
