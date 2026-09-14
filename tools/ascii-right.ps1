# ASCII render of toolbar right region: x1800..width, y10..90, cell 8x8
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$chars = " .:-=+*#%@"

$jobs = @(
  ,@("USER-NEW", "C:\Users\gongs\.zcode\cli\image-cache\sess_fed24083-551c-4a24-8d8c-c4c8bd28211c\image-b4bfab03902d9f0458f526d630361a74.png")
  ,@("MY-HEALTHY", "$env:TEMP\mdr-window.png")
)

foreach ($job in $jobs) {
  $label = $job[0]
  $path = $job[1]
  $img = [System.Drawing.Image]::FromFile($path)
  $bmp = New-Object System.Drawing.Bitmap($img)
  $w = $bmp.Width
  Write-Output "=== $label (w=$w) x1800..$w ==="
  $y = 12
  while ($y -lt 88) {
    $line = ""
    $x = 1800
    while ($x -lt ($w - 4)) {
      $p = $bmp.GetPixel($x, $y)
      $avg = ($p.R + $p.G + $p.B) / 3
      $idx = [int]((255 - $avg) / 26)
      if ($idx -gt 9) { $idx = 9 }
      $line = $line + $chars[$idx]
      $x = $x + 8
    }
    Write-Output $line
    $y = $y + 8
  }
  $bmp.Dispose()
  $img.Dispose()
}
