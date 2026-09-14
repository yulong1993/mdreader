# Measure toolbar dark-glyph clusters in y15-85 band. ASCII-only for PS5.1 safety.
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

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
  Write-Output "=== $label (w=$w) ==="
  $cols = @{}
  for ($x = 0; $x -lt $w; $x++) {
    $c = 0
    for ($y = 15; $y -lt 85; $y += 2) {
      $p = $bmp.GetPixel($x, $y)
      if (($p.R -lt 160) -and ($p.G -lt 160) -and ($p.B -lt 160)) { $c = $c + 1 }
    }
    $cols[$x] = $c
  }
  $start = -1
  $lastInk = -99
  $sum = 0
  for ($x = 0; $x -lt $w; $x++) {
    $v = 0
    if ($cols.ContainsKey($x)) { $v = $cols[$x] }
    if ($v -gt 0) {
      if ($start -lt 0) { $start = $x }
      $lastInk = $x
      $sum = $sum + $v
    } else {
      if ($start -ge 0 -and (($x - $lastInk) -gt 12)) {
        Write-Output ("cluster x" + $start + "-" + $lastInk + " ink=" + $sum)
        $start = -1
        $sum = 0
      }
    }
  }
  if ($start -ge 0) { Write-Output ("cluster x" + $start + "-" + $lastInk + " ink=" + $sum) }
  $bmp.Dispose()
  $img.Dispose()
}
