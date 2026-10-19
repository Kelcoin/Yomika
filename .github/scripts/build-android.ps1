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
# 首次准备移动端 ORT 还需要 Python、Git、CMake、Ninja 和 Python numpy/packaging；
# 后续构建复用校验通过的目标运行库，不再重复下载和编译。
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
$ndk = Join-Path $sdk "ndk/28.2.13676358"
if (-not (Test-Path -LiteralPath $ndk -PathType Container)) { throw "Install Android NDK 28.2.13676358 (the app's pinned NDK)." }
$env:ANDROID_NDK_ROOT = $ndk
$env:ANDROID_NDK_HOME = $ndk
Write-Host "Android NDK: 28.2.13676358"

# 签名：release 变体只有在 `release.keystore` + 三个口令变量齐了才会被签名
# （见 gen/android/app/build.gradle.kts）。没签名的 APK 装不上（Android 报
# INSTALL_PARSE_FAILED_NO_CERTIFICATES: Attempt to get length of null array），
# 所以这里把本地的口令文件读进来，缺了就明确说一声——「构建成功但装不上」是最没必要
# 踩的坑。两个文件都进了 .gitignore，只存在于开发机上。
if ($Release) {
    $keystoreProperties = Join-Path $repoRoot "src-tauri/gen/android/keystore.local.properties"
    if (Test-Path -LiteralPath $keystoreProperties) {
        Get-Content -LiteralPath $keystoreProperties | ForEach-Object {
            if ($_ -match '^\s*([^#=]+)=(.*)$') {
                $name = $Matches[1].Trim()
                $value = $Matches[2].Trim()
                if ($name -eq 'storePassword') { $env:ANDROID_KEYSTORE_PASSWORD = $value }
                elseif ($name -eq 'keyAlias') { $env:ANDROID_KEY_ALIAS = $value }
                elseif ($name -eq 'keyPassword') { $env:ANDROID_KEY_PASSWORD = $value }
            }
        }
    }
    $keystore = Join-Path $repoRoot "src-tauri/gen/android/release.keystore"
    $signingReady = (Test-Path -LiteralPath $keystore) -and $env:ANDROID_KEYSTORE_PASSWORD -and $env:ANDROID_KEY_ALIAS -and $env:ANDROID_KEY_PASSWORD
    if ($signingReady) {
        Write-Host "Signing with $keystore (alias $($env:ANDROID_KEY_ALIAS))"
    } else {
        Write-Warning "没有签名密钥：这次出来的 APK 是 unsigned 的，装不到手机上。"
        Write-Warning "本地做一份能装的："
        Write-Warning "  keytool -genkeypair -keystore src-tauri/gen/android/release.keystore -alias yomika-test -keyalg RSA -keysize 2048 -validity 10000 -storepass <口令> -keypass <口令> -dname CN=Yomika"
        Write-Warning "  再把 storePassword / keyAlias / keyPassword 写进 src-tauri/gen/android/keystore.local.properties"
    }
}

Push-Location $repoRoot
try {
    # The runtime must be linked into the host, not merely copied into the APK.
    # A missing ORT_LIB_PATH otherwise leaves ort-sys' unresolved error sentinel
    # in an Android shared library and System.loadLibrary fails at cold launch.
    $runtimeOutput = Join-Path $repoRoot "src-tauri/target/mobile-ort"
    $legacyOutput = Join-Path $repoRoot "src-tauri/target/mobile-ort-shallow"
    if ($env:YOMIKA_MOBILE_ORT_OUTPUT) { $runtimeOutput = $env:YOMIKA_MOBILE_ORT_OUTPUT }
    elseif (-not (Test-Path (Join-Path $runtimeOutput "android-runtime.json")) -and (Test-Path (Join-Path $legacyOutput "android-runtime.json"))) { $runtimeOutput = $legacyOutput }
    $runtimeEnvironment = Join-Path $runtimeOutput "cargo-env.json"
    & python (Join-Path $PSScriptRoot "prepare-mobile-ort.py") android --output $runtimeOutput --reuse-if-valid --env-file $runtimeEnvironment
    if ($LASTEXITCODE -ne 0) { throw "Android ONNX Runtime preparation failed." }
    $runtimeVariables = Get-Content -LiteralPath $runtimeEnvironment -Raw | ConvertFrom-Json
    foreach ($property in $runtimeVariables.PSObject.Properties) {
        [Environment]::SetEnvironmentVariable($property.Name, [string]$property.Value, "Process")
    }
    $configuration = if ($Release) { "release" } else { "debug" }
    Write-Host "Building the $configuration APK for aarch64 (frontend first: tauri runs npm run build)."
    # 与 build-windows.ps1 同一个理由：`build.rs` 把编译时刻与
    # `git rev-parse --short=12 HEAD` 写进 `YOMIKA_BUILD_COMMIT`，而它的重跑由
    # `tauri_build::try_build` 注册的 `rerun-if-changed=tauri.conf.json`（与图标）决定。
    # 只改源码、没碰这些文件时，这条链会复用上一次的 build script 输出，`.so` 里带的
    # 就是**上一个** commit 号（实测：HEAD 已是 b842e5f，APK 里却是 bc204cc）。
    # 改成两条腿走路：① 提交号当**显式输入**放进环境变量（`build.rs` 里登记了
    # `rerun-if-env-changed`，它一变那边必定重跑）；② 时间戳照旧碰一下（那一下同时管着
    # 前端 dist 的重新嵌入）。收尾时再用 `verify-build-stamp.ps1` 把 APK 里的 `.so` 与
    # 实际 HEAD 对一次（审计 P2-3）。
    $git = Get-Command git -ErrorAction SilentlyContinue
    if ($git) {
        $head = & $git.Source -C $repoRoot rev-parse --short=12 HEAD 2>$null
        if ($LASTEXITCODE -eq 0 -and $head) {
            $env:YOMIKA_BUILD_COMMIT = "$head".Trim()
            Write-Host "Build stamp: $($env:YOMIKA_BUILD_COMMIT)"
        }
    }
    if (-not $env:YOMIKA_BUILD_COMMIT) { Write-Warning "拿不到 git 提交号：这一份产物不会带构建戳。" }
    $tauriConfig = Join-Path $repoRoot "src-tauri\tauri.conf.json"
    if (Test-Path -LiteralPath $tauriConfig -PathType Leaf) {
        (Get-Item -LiteralPath $tauriConfig -Force).LastWriteTime = Get-Date
    }
    $tauriArgs = @("run", "tauri", "android", "build", "--", "--ci", "--apk", "--target", "aarch64")
    if (-not $Release) { $tauriArgs = @("run", "tauri", "android", "build", "--", "--ci", "--debug", "--apk", "--target", "aarch64") }
    & npm @tauriArgs
    if ($LASTEXITCODE -ne 0) { throw "Tauri Android build failed with exit code $LASTEXITCODE." }

    $apk = Get-ChildItem -Path (Join-Path $repoRoot "src-tauri\gen\android\app\build\outputs\apk") -Recurse -Filter "*.apk" -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName -match $configuration } |
        Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if (-not $apk) { throw "No $configuration APK under src-tauri\gen\android\app\build\outputs\apk." }
    $readelf = Join-Path $ndk "toolchains/llvm/prebuilt/windows-x86_64/bin/llvm-readelf.exe"
    & python (Join-Path $PSScriptRoot "verify-mobile-runtime.py") $apk.FullName --readelf $readelf
    if ($LASTEXITCODE -ne 0) { throw "APK native runtime/linkage verification failed." }
    # APK 里那个 `.so` 的构建戳必须等于构建时的 HEAD（审计 P2-3）；对不上就失败，别让
    # 一份带旧戳的包发出去。
    & (Join-Path $PSScriptRoot "verify-build-stamp.ps1") -Path $apk.FullName -InsideApk
    Write-Host "Android package: $($apk.FullName)"
    Write-Host "Install on a connected device: adb install -r `"$($apk.FullName)`""
    Write-Host "Live-reload instead: npm run tauri android dev   (then chrome://inspect for the WebView devtools)"
} finally {
    Pop-Location
}
