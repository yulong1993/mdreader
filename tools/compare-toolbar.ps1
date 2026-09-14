# 对比两张图顶部工具栏区域的按钮分布（无函数、无泛型版本）
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$out = New-Object System.Text.StringBuilder

foreach ($pair in @(
  @("USER-BROKEN", "C:\Users\gongs\.zcode\cli\image-cache\sess_fed24083-551c-4a24-8d8c-c4c8bd28211c\image-999b4cea8a0cfc68f2a931232293e97d.png"),
  @("MY-HEALTHY", "$env:TEMP\mdr-window.png")
)) {
  $label = $pair[0]; $path = $pair[1]
  $img = [System.Drawing.Image]::FromFile($path)
  $bmp = New-Object System.Drawing.Bitmap($img)
  $w = $bmp.Width
  [void]$out.AppendLine("=== $label (${w}x$($bmp.Height)) ===")
  for ($x = 0; $x -lt $w; $x += 20) {
    $c = 0
    for ($y = 55; $y -lt 150; $y += 2) {
      $p = $bmp.GetPixel($x, $y)
      if ($p.R -lt 150 -or $p.G -lt 150 -or $p.B -lt 150) { $c++ }
    }
    if ($c -gt 0) { [void]$out.Append("x$x=$c ") }
  }
  [void]$out.AppendLine("")
  $bmp.Dispose(); $img.Dispose()
}
$out.ToString() | Write-Output
