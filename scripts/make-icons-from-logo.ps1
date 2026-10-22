# ============================================================
#  Build the app icon set from logo.png
#
#  Why this exists instead of "npx tauri icon logo.png":
#  logo.png is only 305x294. tauri icon upscales it to 1024 and then
#  derives 32/48/64 from that upscale -- two resamples, and every small
#  size ends up soft. Worse, the artwork's main stroke is 8px at 305
#  wide, i.e. 0.9px at 32px, which is below the ~1.5px needed to look
#  crisp no matter how good the resampler is.
#
#  So: render each size straight from the source, then apply a contrast
#  stretch around the ink/cream midpoint at small sizes. That pushes
#  near-background pixels back to pure cream (no muddy background) and
#  makes the stroke cores solid, which is what actually reads clean at
#  16-48px. Large sizes get little or no stretch.
#
#  Sizes and stretch gains live in the table below. Rerun after
#  replacing logo.png:
#     powershell -NoProfile -ExecutionPolicy Bypass -File scripts/make-icons-from-logo.ps1
#  then: npm run icons:web ; bump the ?v= on the favicon links in
#  index.html (browsers cache favicons by URL) ; npm run build.
# ============================================================

Add-Type -AssemblyName System.Drawing

$root  = Split-Path -Parent $PSScriptRoot
$srcP  = Join-Path $root 'logo.png'
$icons = Join-Path $root 'src-tauri\icons'

# size -> contrast gain (1.0 = none)
$plan = @(
  @{ size = 16;  gain = 2.6 },
  @{ size = 24;  gain = 2.6 },
  @{ size = 32;  gain = 2.6 },
  @{ size = 48;  gain = 2.6 },
  @{ size = 64;  gain = 2.2 },
  @{ size = 128; gain = 1.8 },
  @{ size = 256; gain = 1.4 },
  @{ size = 512; gain = 1.0 },
  @{ size = 1024; gain = 1.0 }
)

$CREAM = @(233, 233, 221)
$INK   = @(43, 43, 42)
$INSET = 12       # drop the outer border/shadow painted into logo.png
$CORNER = 0.225   # corner radius as a fraction of the side

function New-SquareSource {
  $img = [System.Drawing.Bitmap]::FromFile($srcP)
  try {
    $cw = $img.Width - $INSET * 2
    $ch = $img.Height - $INSET * 2
    $side = [Math]::Max($cw, $ch)
    $sq = New-Object System.Drawing.Bitmap($side, $side, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($sq)
    try {
      $g.Clear([System.Drawing.Color]::FromArgb(255, $CREAM[0], $CREAM[1], $CREAM[2]))
      $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
      $dst = New-Object System.Drawing.Rectangle ([int](($side - $cw) / 2)), ([int](($side - $ch) / 2)), $cw, $ch
      $src = New-Object System.Drawing.Rectangle $INSET, $INSET, $cw, $ch
      $g.DrawImage($img, $dst, $src, [System.Drawing.GraphicsUnit]::Pixel)
    } finally { $g.Dispose() }
    return $sq
  } finally { $img.Dispose() }
}

function Render-Icon([int]$size, [double]$gain) {
  $sq = New-SquareSource
  $bmp = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  try {
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.Clear([System.Drawing.Color]::FromArgb(255, $CREAM[0], $CREAM[1], $CREAM[2]))
    $g.DrawImage($sq, 0, 0, $size, $size)
  } finally { $g.Dispose(); $sq.Dispose() }

  if ($gain -ne 1.0) {
    $creamL = 0.299 * $CREAM[0] + 0.587 * $CREAM[1] + 0.114 * $CREAM[2]
    $inkL   = 0.299 * $INK[0] + 0.587 * $INK[1] + 0.114 * $INK[2]
    for ($y = 0; $y -lt $size; $y++) {
      for ($x = 0; $x -lt $size; $x++) {
        $p = $bmp.GetPixel($x, $y)
        $lum = 0.299 * $p.R + 0.587 * $p.G + 0.114 * $p.B
        $c = ($creamL - $lum) / ($creamL - $inkL)
        if ($c -le 0.001) { continue }
        if ($c -gt 1) { $c = 1 }
        $cp = ($c - 0.5) * $gain + 0.5
        if ($cp -lt 0) { $cp = 0 }
        if ($cp -gt 1) { $cp = 1 }
        $f = $cp / $c
        $r = [int][Math]::Min(255, [Math]::Max(0, $CREAM[0] + ($p.R - $CREAM[0]) * $f))
        $gr = [int][Math]::Min(255, [Math]::Max(0, $CREAM[1] + ($p.G - $CREAM[1]) * $f))
        $b = [int][Math]::Min(255, [Math]::Max(0, $CREAM[2] + ($p.B - $CREAM[2]) * $f))
        $bmp.SetPixel($x, $y, [System.Drawing.Color]::FromArgb(255, $r, $gr, $b))
      }
    }
  }

  # rounded corner mask: opaque inside the rounded rect, transparent outside
  $rad = [double]$size * $CORNER
  $dia = [float]($rad * 2)
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $path.AddArc(0, 0, $dia, $dia, 180, 90)
  $path.AddArc([float]($size - $dia), 0, $dia, $dia, 270, 90)
  $path.AddArc([float]($size - $dia), [float]($size - $dia), $dia, $dia, 0, 90)
  $path.AddArc(0, [float]($size - $dia), $dia, $dia, 90, 90)
  $path.CloseFigure()

  $out = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $go = [System.Drawing.Graphics]::FromImage($out)
  try {
    $go.Clear([System.Drawing.Color]::Transparent)
    $go.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $go.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
    $brush = New-Object System.Drawing.TextureBrush($bmp, [System.Drawing.Drawing2D.WrapMode]::Clamp)
    try { $go.FillPath($brush, $path) } finally { $brush.Dispose() }
  } finally { $go.Dispose(); $path.Dispose(); $bmp.Dispose() }
  return $out
}

function Save-Png($bmp, [string]$path) {
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
}

# --- render every size once, keep the 16..256 renders for the .ico ---
New-Item -ItemType Directory -Force -Path $icons | Out-Null
$rendered = @{}
foreach ($p in $plan) {
  $b = Render-Icon $p.size $p.gain
  $rendered[$p.size] = $b
  Write-Host ("  {0,4}x{0,-4} gain {1}" -f $p.size, $p.gain)
}

Save-Png $rendered[32]   (Join-Path $icons '32x32.png')
Save-Png $rendered[128]  (Join-Path $icons '128x128.png')
Save-Png $rendered[256]  (Join-Path $icons '128x128@2x.png')
Save-Png $rendered[512]  (Join-Path $icons 'icon-512.png')
Save-Png $rendered[1024] (Join-Path $icons 'icon.png')

# --- pack icon.ico: 16/24/32/48/64/128/256 as PNG payloads ---
$icoSizes = @(16, 24, 32, 48, 64, 128, 256)
$payloads = @()
foreach ($s in $icoSizes) {
  $ms = New-Object System.IO.MemoryStream
  $rendered[$s].Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $payloads += , @($s, $ms.ToArray())
  $ms.Dispose()
}
$icoPath = Join-Path $icons 'icon.ico'
$fs = [System.IO.File]::Create($icoPath)
$bw = New-Object System.IO.BinaryWriter($fs)
try {
  $bw.Write([uint16]0)                  # reserved
  $bw.Write([uint16]1)                  # type: icon
  $bw.Write([uint16]$payloads.Count)
  $offset = 6 + 16 * $payloads.Count
  foreach ($item in $payloads) {
    $s = $item[0]; $bytes = $item[1]
    $dim = if ($s -ge 256) { 0 } else { $s }
    $bw.Write([byte]$dim); $bw.Write([byte]$dim)
    $bw.Write([byte]0); $bw.Write([byte]0)
    $bw.Write([uint16]1)                # color planes
    $bw.Write([uint16]32)               # bits per pixel
    $bw.Write([uint32]$bytes.Length)
    $bw.Write([uint32]$offset)
    $offset += $bytes.Length
  }
  foreach ($item in $payloads) { $bw.Write($item[1]) }
} finally { $bw.Dispose(); $fs.Dispose() }

foreach ($k in @($rendered.Keys)) { $rendered[$k].Dispose() }

Write-Host ''
Write-Host ("icon.ico  {0:N1} KB  ({1} sizes: {2})" -f ((Get-Item $icoPath).Length / 1KB), $icoSizes.Count, ($icoSizes -join '/'))
Write-Host 'done. next: npm run icons:web   then bump ?v= in index.html and npm run build'
