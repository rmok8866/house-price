# PowerShell script to build HousePriceUK Android APK
$ErrorActionPreference = "Stop"

Write-Host "======================================================" -ForegroundColor Cyan
Write-Host " Building UK House Price History Android APK..." -ForegroundColor Cyan
Write-Host "======================================================" -ForegroundColor Cyan

$workspace = Split-Path -Parent $MyInvocation.MyCommand.Path

# 1. Sync web assets
Write-Host "`n[1/3] Syncing latest web assets to Android project..." -ForegroundColor Yellow
Copy-Item "$workspace\index.html", "$workspace\styles.css", "$workspace\app.js", "$workspace\manifest.json" `
          -Destination "$workspace\android\app\src\main\assets\" -Force
Write-Host "  -> Synced index.html, styles.css, app.js, manifest.json." -ForegroundColor Green

# 2. Configure Android SDK environment if not set
if (-not $env:ANDROID_HOME) {
    $defaultSdk = "C:\Users\RMOK\AppData\Local\Android\Sdk"
    if (Test-Path $defaultSdk) {
        $env:ANDROID_HOME = $defaultSdk
        $env:ANDROID_SDK_ROOT = $defaultSdk
        Write-Host "[2/3] Setting ANDROID_HOME to: $defaultSdk" -ForegroundColor Yellow
    }
}

# 3. Build APK with Gradle
Write-Host "`n[3/3] Compiling Android APK with Gradle..." -ForegroundColor Yellow
Push-Location "$workspace\android"
try {
    .\gradlew.bat assembleDebug
    Pop-Location

    $apkPath = "$workspace\android\app\build\outputs\apk\debug\app-debug.apk"
    if (Test-Path $apkPath) {
        $rootApk = "$workspace\HousePrice-History.apk"
        Copy-Item $apkPath $rootApk -Force
        $file = Get-Item $rootApk
        $sizeMb = [math]::Round($file.Length / 1MB, 2)
        Write-Host "`n======================================================" -ForegroundColor Green
        Write-Host " SUCCESS! APK BUILT SUCCESSFULLY:" -ForegroundColor Green
        Write-Host " Root File: $rootApk" -ForegroundColor White
        Write-Host " File Size: $sizeMb MB" -ForegroundColor White
        Write-Host "======================================================`n" -ForegroundColor Green
    } else {
        Write-Host "Gradle finished. Check android/app/build/outputs/apk/ for outputs." -ForegroundColor Yellow
    }
} catch {
    Pop-Location
    Write-Host "`nBuild failed: $_" -ForegroundColor Red
    exit 1
}
