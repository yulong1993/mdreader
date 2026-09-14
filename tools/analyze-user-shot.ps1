# 分析用户截图的墨水分布，与健康渲染对比
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$img = [System.Drawing.Image]::FromFile("C:\Users\gongs\.zcode\cli\image-cache\sess_fed24083-551c-4a24-8d8c-c4c8bd28211c\image-999b4cea8a0cfc68f2a931232293e97d.png")
$w = $img.Width; $h = $img.Height
Write-Output "image-size: ${w}x${h}"
$bmp = New-Object System.Drawing.Bitmap($img)

$step = [Math]::Max(1, [int]($w / 60))
$prof = New-Object System.Collections.Generic.List[string]
for ($x = 0; $x -lt $w; $x += $step) {
  $c = 0
  for ($y = 0; $y -lt $h; $y += 4) {
    $p = $bmp.GetPixel($x, $y)
    if ($p.R -lt 240 -or $p.G -lt 240 -or $p.B -lt 240) { $c++ }
  }
  $prof.Add("x$x`:$c")
}
Write-Output ("profile: " + ($prof -join ","))

# 右缘 40px 内有墨列数（判断内容是否顶到图像右缘）
$edge = 0
for ($x = $w - 40; $x -lt $w; $x += 2) {
  for ($y = 0; $y -lt $h; $y += 3) {
    $p = $bmp.GetPixel($x, $y)
    if ($p.R -lt 240 -or $p.G -lt 240 -or $p.B -lt 240) { $edge++; break }
  }
}
Write-Output "right-edge-ink-columns: $edge / 20"

# 顶栏（工具栏区域 y=60..130 采样）非白分布——工具栏按钮被裁的判断
$tb = New-Object System.Collections.Generic.List[string]
for ($x = ($w - 500); $x -lt $w; $x += 25) {
  $c = 0
  for ($y = 60; $y -lt 140; $y += 2) {
    $p = $bmp.GetPixel($x, $y)
    if ($p.R -lt 200 -or $p.G -lt 200 -or $p.B -lt 200) { $c++ }
  }
  $tb.Add("x$x`:$c")
}
Write-Output ("toolbar-right-profile: " + ($tb -join ","))

$bmp.Dispose(); $img.Dispose()
