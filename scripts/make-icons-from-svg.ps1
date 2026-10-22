# ============================================================
#  Build the app icon set from logo.svg (vector source)
#
#  Why vector: the old logo.png was 305x294 and its main stroke was
#  8px wide there, i.e. 0.9px at 32px -- below the ~1.5px that can
#  look crisp, no matter which resampler does the scaling. A vector
#  source has no such floor: every size is drawn, not interpolated.
#
#  Pipeline:
#    1. headless Edge renders logo.svg once at 1024x1024 (transparent)
#    2. every icon size is downscaled from that single crisp raster
#    3. small sizes get a mild contrast stretch around the cream/ink
#       midpoint so the strokes stay solid rather than grey mush
#    4. icon.ico is assembled by hand (7 sizes, PNG payloads)
#
#  Needs Microsoft Edge (it is a browser-render step; there is no
#  SVG rasterizer in .NET). Run:
#     powershell -NoProfile -ExecutionPolicy Bypass -File scripts/make-icons-from-svg.ps1
#  Then: npm run icons:web  ->  bump ?v= in index.html  ->  npm run build
# ============================================================

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$root  = Split-Path -Parent $PSScriptRoot
$svgP  = Join-Path $root 'logo.svg'
$icons = Join-Path $root 'src-tauri\icons'
$work  = Join-Path $root '.icons-work'

if (-not (Test-Path $svgP)) { throw "missing logo.svg" }

# size -> contrast gain at that size (1.0 = untouched)
$gains = @{ 16 = 1.5; 24 = 1.5; 32 = 1.5; 48 = 1.2; 64 = 1.2; 128 = 1.0; 256 = 1.0; 512 = 1.0; 1024 = 1.0 }

# ---------------- 1. vector -> 1024 raster ----------------

$edge = @(
  'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe',
  'C:\Program Files\Microsoft\Edge\Application\msedge.exe'
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $edge) { throw "Microsoft Edge not found; it is needed to rasterize the SVG" }

if (Test-Path $work) { Remove-Item $work -Recurse -Force }
New-Item -ItemType Directory -Path $work | Out-Null
$svgText = [System.IO.File]::ReadAllText($svgP, [System.Text.Encoding]::UTF8)
$html = '<!doctype html><meta charset="utf-8"><style>html,body{margin:0;padding:0;background:transparent;overflow:hidden}svg{display:block;width:100vw;height:100vh}</style>' + $svgText
$htmlPath = Join-Path $work 'page.html'
[System.IO.File]::WriteAllText($htmlPath, $html, (New-Object System.Text.UTF8Encoding($false)))

$raster = Join-Path $work 'base-1024.png'
$edgeArgs = @(
  '--headless', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1',
  '--default-background-color=00000000', '--window-size=1024,1024', '--virtual-time-budget=3000',
  "--user-data-dir=$(Join-Path $work 'profile')", "--screenshot=$raster", ([uri]$htmlPath).AbsoluteUri
)
Start-Process -FilePath $edge -ArgumentList $edgeArgs -Wait -WindowStyle Hidden | Out-Null
if (-not (Test-Path $raster)) { throw "Edge did not produce a screenshot" }

$base = [System.Drawing.Bitmap]::FromFile($raster)
if ($base.Width -ne 1024 -or $base.Height -ne 1024) { throw "unexpected raster size $($base.Width)x$($base.Height)" }
# sanity: a corner must be transparent (rounded card) and the middle band opaque
if ($base.GetPixel(2, 2).A -gt 8) { throw "corner is opaque - the SVG is missing its rounded card rect" }
Write-Host ("raster 1024x1024  cornerA={0}" -f $base.GetPixel(2, 2).A)

# ---------------- 2/3. derive every size ----------------

function New-Sized([int]$size) {
  $bmp = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  try {
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
    $g.Clear([System.Drawing.Color]::Transparent)
    $g.DrawImage($base, 0, 0, $size, $size)
  } finally { $g.Dispose() }

  $gain = [double]$gains[$size]
  if ($gain -ne 1.0) {
    for ($y = 0; $y -lt $size; $y++) {
      for ($x = 0; $x -lt $size; $x++) {
        $p = $bmp.GetPixel($x, $y)
        if ($p.A -lt 8) { continue }
        $lum = 0.299 * $p.R + 0.587 * $p.G + 0.114 * $p.B
        $c = (233.0 - $lum) / (233.0 - 43.0)
        if ($c -le 0.001) { continue }
        if ($c -gt 1) { $c = 1 }
        $cp = ($c - 0.5) * $gain + 0.5
        if ($cp -lt 0) { $cp = 0 }
        if ($cp -gt 1) { $cp = 1 }
        $f = $cp / $c
        $r  = [int][Math]::Min(255, [Math]::Max(0, 233 + ($p.R - 233) * $f))
        $gg = [int][Math]::Min(255, [Math]::Max(0, 235 + ($p.G - 235) * $f))
        $bb = [int][Math]::Min(255, [Math]::Max(0, 227 + ($p.B - 227) * $f))
        $bmp.SetPixel($x, $y, [System.Drawing.Color]::FromArgb($p.A, $r, $gg, $bb))
      }
    }
  }
  return $bmp
}

New-Item -ItemType Directory -Force -Path $icons | Out-Null
$cache = @{}
foreach ($s in 16, 32, 48, 64, 128, 256, 512, 1024) {
  $b = New-Sized $s
  $cache[$s] = $b
  Write-Host ("  {0,4}x{0,-4} gain {1}" -f $s, $gains[$s])
}

$cache[32].Save((Join-Path $icons '32x32.png'), [System.Drawing.Imaging.ImageFormat]::Png)
$cache[128].Save((Join-Path $icons '128x128.png'), [System.Drawing.Imaging.ImageFormat]::Png)
$cache[256].Save((Join-Path $icons '128x128@2x.png'), [System.Drawing.Imaging.ImageFormat]::Png)
$cache[512].Save((Join-Path $icons 'icon-512.png'), [System.Drawing.Imaging.ImageFormat]::Png)
$cache[1024].Save((Join-Path $icons 'icon.png'), [System.Drawing.Imaging.ImageFormat]::Png)

# ---------------- 4. assemble icon.ico ----------------

$icoSizes = @(16, 32, 48, 64, 128, 256)
$payloads = @()
foreach ($s in $icoSizes) {
  $ms = New-Object System.IO.MemoryStream
  $cache[$s].Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $payloads += , @($s, $ms.ToArray())
  $ms.Dispose()
}
$icoPath = Join-Path $icons 'icon.ico'
$fs = [System.IO.File]::Create($icoPath)
$bw = New-Object System.IO.BinaryWriter($fs)
try {
  $bw.Write([uint16]0)
  $bw.Write([uint16]1)
  $bw.Write([uint16]$payloads.Count)
  $offset = 6 + 16 * $payloads.Count
  foreach ($item in $payloads) {
    $dim = if ($item[0] -ge 256) { 0 } else { $item[0] }
    $bw.Write([byte]$dim); $bw.Write([byte]$dim)
    $bw.Write([byte]0); $bw.Write([byte]0)
    $bw.Write([uint16]1); $bw.Write([uint16]32)
    $bw.Write([uint32]$item[1].Length)
    $bw.Write([uint32]$offset)
    $offset += $item[1].Length
  }
  foreach ($item in $payloads) { $bw.Write($item[1]) }
} finally { $bw.Dispose(); $fs.Dispose() }

foreach ($k in @($cache.Keys)) { $cache[$k].Dispose() }
$base.Dispose()
Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue

Write-Host ''
Write-Host ("icon.ico  {0:N1} KB  ({1} sizes: {2})" -f ((Get-Item $icoPath).Length / 1KB), $icoSizes.Count, ($icoSizes -join '/'))
Write-Host 'done. next: npm run icons:web  ->  bump ?v= in index.html  ->  npm run build'
