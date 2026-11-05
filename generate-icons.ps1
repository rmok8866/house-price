param (
    [string]$SourcePath = "icons/icon_concept_1_fintech.jpg"
)

Add-Type -AssemblyName System.Drawing

$workspace = Get-Location
$fullSrc = Join-Path $workspace $SourcePath

if (-not (Test-Path $fullSrc)) {
    Write-Error "Source image not found at: $fullSrc"
    exit 1
}

$srcBitmap = [System.Drawing.Bitmap]::FromFile($fullSrc)
Write-Host "Loaded source image: $($srcBitmap.Width) x $($srcBitmap.Height)" -ForegroundColor Cyan

# Define Android mipmap sizes
$sizes = @(
    @{ Name = "mipmap-mdpi"; Size = 48 },
    @{ Name = "mipmap-hdpi"; Size = 72 },
    @{ Name = "mipmap-xhdpi"; Size = 96 },
    @{ Name = "mipmap-xxhdpi"; Size = 144 },
    @{ Name = "mipmap-xxxhdpi"; Size = 192 }
)

$resDir = Join-Path $workspace "android\app\src\main\res"

function Resize-SquareImage($src, $targetSize) {
    $dest = New-Object System.Drawing.Bitmap($targetSize, $targetSize)
    $g = [System.Drawing.Graphics]::FromImage($dest)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality

    $rect = New-Object System.Drawing.Rectangle(0, 0, $targetSize, $targetSize)
    $g.DrawImage($src, $rect)
    $g.Dispose()
    return $dest
}

function Create-RoundImage($src, $targetSize) {
    $dest = New-Object System.Drawing.Bitmap($targetSize, $targetSize, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($dest)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality

    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $path.AddEllipse(0, 0, $targetSize, $targetSize)
    $g.SetClip($path)

    $rect = New-Object System.Drawing.Rectangle(0, 0, $targetSize, $targetSize)
    $g.DrawImage($src, $rect)
    $path.Dispose()
    $g.Dispose()
    return $dest
}

foreach ($item in $sizes) {
    $dirPath = Join-Path $resDir $item.Name
    if (-not (Test-Path $dirPath)) {
        New-Item -ItemType Directory -Path $dirPath -Force | Out-Null
    }

    # Standard square/squircle icon
    $sq = Resize-SquareImage $srcBitmap $item.Size
    $sqPath = Join-Path $dirPath "ic_launcher.png"
    $sq.Save($sqPath, [System.Drawing.Imaging.ImageFormat]::Png)
    $sq.Dispose()

    # Round icon for adaptive launchers
    $rd = Create-RoundImage $srcBitmap $item.Size
    $rdPath = Join-Path $dirPath "ic_launcher_round.png"
    $rd.Save($rdPath, [System.Drawing.Imaging.ImageFormat]::Png)
    $rd.Dispose()

    Write-Host " Generated $($item.Name) ($($item.Size)x$($item.Size)) -> ic_launcher.png & ic_launcher_round.png" -ForegroundColor Green
}

# Generate web favicon & PWA icons
$webIcons = @(
    @{ Name = "icon-192.png"; Size = 192 },
    @{ Name = "icon-512.png"; Size = 512 },
    @{ Name = "favicon.png"; Size = 64 }
)

foreach ($wi in $webIcons) {
    $outBmp = Resize-SquareImage $srcBitmap $wi.Size
    $outPath = Join-Path $workspace $wi.Name
    $outBmp.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
    
    # Also save to deploy folder
    $deployPath = Join-Path $workspace "deploy\$($wi.Name)"
    $outBmp.Save($deployPath, [System.Drawing.Imaging.ImageFormat]::Png)
    
    $outBmp.Dispose()
    Write-Host " Generated Web Icon $($wi.Name) ($($wi.Size)x$($wi.Size))" -ForegroundColor Yellow
}

$srcBitmap.Dispose()
Write-Host "`nAll icons generated successfully!" -ForegroundColor Green
