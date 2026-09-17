[CmdletBinding()]
param(
    [switch]$Release
)

# 本地编 Android 包，省得每改一处都等 Actions。
#
# 默认出 debug APK：不需要签名密钥，adb 直接装到手机上调试；release 包要 CI 里那套
# 签名 secret（ANDROID_KEYSTORE_*），本地只在显式 -Release 时才走。`-Debug` 这个名字
# 不能用作参数——CmdletBinding 已经带了同名的公共参数（写出来会直接报重名）。
#
# 依赖：JDK 17+（PATH 或 JAVA_HOME）、Android SDK（ANDROID_HOME 或默认位置）并带
# NDK，rustup 装了 aarch64-linux-android 目标。
$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$sdk = if ($env:ANDROID_HOME) { $env:ANDROID_HOME }
    elseif ($env:ANDROID_SDK_ROOT) { $env:ANDROID_SDK_ROOT }
    else { Join-Path $env:LOCALAPPDATA "Android\Sdk" }
if (-not (Test-Path -LiteralPath $sdk -PathType Container)) {
    throw "Android SDK not found at '$sdk'. Install it or set ANDROID_HOME."
}
$env:ANDROID_HOME = $sdk
$env:ANDROID_SDK_ROOT = $sdk
$ndk = Join-Path $sdk "ndk"
if (Test-Path -LiteralPath $ndk -PathType Container) {
    $newest = Get-ChildItem -LiteralPath $ndk -Directory | Sort-Object Name | Select-Object -Last 1
    if ($newest) { $env:ANDROID_NDK_ROOT = $newest.FullName; Write-Host "Android NDK: $($newest.Name)" }
}

Push-Location $repoRoot
try {
    $configuration = if ($Release) { "release" } else { "debug" }
    Write-Host "Building the $configuration APK for aarch64 (frontend first: tauri runs npm run build)."
    $tauriArgs = @("run", "tauri", "android", "build", "--", "--ci", "--apk", "--target", "aarch64")
    if (-not $Release) { $tauriArgs = @("run", "tauri", "android", "build", "--", "--ci", "--debug", "--apk", "--target", "aarch64") }
    & npm @tauriArgs
    if ($LASTEXITCODE -ne 0) { throw "Tauri Android build failed with exit code $LASTEXITCODE." }

    $apk = Get-ChildItem -Path (Join-Path $repoRoot "src-tauri\gen\android\app\build\outputs\apk") -Recurse -Filter "*.apk" -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName -match $configuration } |
        Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if (-not $apk) { throw "No $configuration APK under src-tauri\gen\android\app\build\outputs\apk." }
    Write-Host "Android package: $($apk.FullName)"
    Write-Host "Install on a connected device: adb install -r `"$($apk.FullName)`""
    Write-Host "Live-reload instead: npm run tauri android dev   (then chrome://inspect for the WebView devtools)"
} finally {
    Pop-Location
}
