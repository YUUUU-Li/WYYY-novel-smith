# ============================================================
#  Build the *browser tab / app-window* icon from logo2.jpg
#
#  Scope note: this touches ONLY public/favicon.ico + public/favicon.png,
#  i.e. what the web version (启动.vbs -> Edge app window) shows in the
#  tab and in the taskbar. The exe / installer / shortcut icons come from
#  src-tauri/icons and are left alone on purpose.
#
#  logo2.jpg is 573x534 -- cleaner than logo.png (305x294) and needs a
#  smaller upscale, so edges come out tidier. Its stroke is 17/573 = 2.97%
#  of the width, i.e. ~0.95px at 32px: the same sub-pixel thinness as
#  before. So the size loop below applies a contrast stretch around the
#  cream/ink midpoint to keep the strokes solid at 16-48px.
#
#  Run:
#     powershell -NoProfile -ExecutionPolicy Bypass -File scripts/make-favicon.ps1
#  Then bump the ?v= number on the favicon links in index.html and
#  rebuild (browsers cache favicons by URL).
# ============================================================

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$srcP = Join-Path $root 'logo2.jpg'
$outDir = Join-Path $root 'public'
if (-not (Test-Path $srcP)) { throw "missing logo2.jpg" }
if (-not (Test-Path $outDir)) { New-Item -ItemType Directory -Path $outDir | Out-Null }

# size -> contrast gain
$plan = @(
  @{ size = 16;  gain = 3.0 },
  @{ size = 32;  gain = 3.0 },
  @{ size = 48;  gain = 2.4 },
  @{ size = 128; gain = 1.8 }
)

$src = [System.Drawing.Bitmap]::FromFile($srcP)
try {
  # centre square crop, keeping the rounded card and dropping outer shadow
  $side = [Math]::Min($src.Width, $src.Height) - 48
  $ox = [int](($src.Width - $side) / 2)
  $oy = [int](($src.Height - $side) / 2)
  $sq = New-Object System.Drawing.Bitmap($side, $side, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($sq)
  try {
    $g.DrawImage($src,
      (New-Object System.Drawing.Rectangle(0, 0, $side, $side)),
      (New-Object System.Drawing.Rectangle($ox, $oy, $side, $side)),
      [System.Drawing.GraphicsUnit]::Pixel)
  } finally { $g.Dispose() }
} finally { $src.Dispose() }

function New-Favicon([int]$size, [double]$gain) {
  $bmp = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  try {
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.Clear([System.Drawing.Color]::Transparent)
    $g.DrawImage($sq, 0, 0, $size, $size)
  } finally { $g.Dispose() }

  for ($y = 0; $y -lt $size; $y++) {
    for ($x = 0; $x -lt $size; $x++) {
      $p = $bmp.GetPixel($x, $y)
      if ($p.A -lt 8) { continue }
      $lum = 0.299 * $p.R + 0.587 * $p.G + 0.114 * $p.B
      $c = (235.0 - $lum) / (235.0 - 43.0)
      if ($c -le 0.001) { continue }
      if ($c -gt 1) { $c = 1 }
      $cp = ($c - 0.5) * $gain + 0.5
      if ($cp -lt 0) { $cp = 0 }
      if ($cp -gt 1) { $cp = 1 }
      $f = $cp / $c
      $r  = [int][Math]::Min(255, [Math]::Max(0, 235 + ($p.R - 235) * $f))
      $gg = [int][Math]::Min(255, [Math]::Max(0, 235 + ($p.G - 235) * $f))
      $bb = [int][Math]::Min(255, [Math]::Max(0, 227 + ($p.B - 227) * $f))
      $bmp.SetPixel($x, $y, [System.Drawing.Color]::FromArgb(255, $r, $gg, $bb))
    }
  }

  # rounded transparent corners
  $rad = [double]$size * 0.225
  $d = [float]($rad * 2)
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $path.AddArc(0, 0, $d, $d, 180, 90)
  $path.AddArc([float]($size - $d), 0, $d, $d, 270, 90)
  $path.AddArc([float]($size - $d), [float]($size - $d), $d, $d, 0, 90)
  $path.AddArc(0, [float]($size - $d), $d, $d, 90, 90)
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

$rendered = @{}
foreach ($p in $plan) {
  $rendered[$p.size] = New-Favicon $p.size $p.gain
  Write-Host ("  {0,3}px gain {1}" -f $p.size, $p.gain)
}
$sq.Dispose()

$rendered[128].Save((Join-Path $outDir 'favicon.png'), [System.Drawing.Imaging.ImageFormat]::Png)

# favicon.ico: 16/32/48 as PNG payloads
$icoSizes = @(16, 32, 48)
$payloads = @()
foreach ($s in $icoSizes) {
  $ms = New-Object System.IO.MemoryStream
  $rendered[$s].Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $payloads += , @($s, $ms.ToArray())
  $ms.Dispose()
}
$icoPath = Join-Path $outDir 'favicon.ico'
$fs = [System.IO.File]::Create($icoPath)
$bw = New-Object System.IO.BinaryWriter($fs)
try {
  $bw.Write([uint16]0); $bw.Write([uint16]1); $bw.Write([uint16]$payloads.Count)
  $offset = 6 + 16 * $payloads.Count
  foreach ($item in $payloads) {
    $bw.Write([byte]$item[0]); $bw.Write([byte]$item[0])
    $bw.Write([byte]0); $bw.Write([byte]0)
    $bw.Write([uint16]1); $bw.Write([uint16]32)
    $bw.Write([uint32]$item[1].Length); $bw.Write([uint32]$offset)
    $offset += $item[1].Length
  }
  foreach ($item in $payloads) { $bw.Write($item[1]) }
} finally { $bw.Dispose(); $fs.Dispose() }

foreach ($k in @($rendered.Keys)) { $rendered[$k].Dispose() }
Write-Host ''
Write-Host ("favicon.ico {0:N1} KB  favicon.png {1:N1} KB" -f ((Get-Item $icoPath).Length / 1KB), ((Get-Item (Join-Path $outDir 'favicon.png')).Length / 1KB))
Write-Host 'done. bump ?v= in index.html, then npm run build'
