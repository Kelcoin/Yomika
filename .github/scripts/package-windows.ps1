# 打 Windows 便携包：把「发布的 zip 里该有哪几样」写成一处定义。
#
# 为什么要有它：这一步原来长在 `.github/workflows/build-packages.yml` 里（一段
# `Copy-Item` + `Compress-Archive`），而它**漏了计算进程那一份可执行文件**——
# 10-a 起 `build-windows.ps1` 会把 `yomika-compute-worker.exe` 编进 `target/release`，
# 打包那一步却没带上它。冷启动自检（`verify-cold-start.ps1 -Expect ready`）在
# 2026-10-08 就是这么红的：主窗起来了、导航走得动，算力那一栏写着
# 「找不到 worker 可执行文件：…\app\yomika-compute-worker.exe」。
#
# **2026-10-09 起交付只剩一个文件**：worker 的字节被压进主 exe（`docs/71` §11 Task 10
# 第①条，解码在 `src/compute/worker_binary.rs`），跑起来仍是两个进程。所以
# ① 这里**不许**再拷第二份可执行文件，② 自检反过来查「包面没有第二份 worker」，
# ③ 那份载荷解得开、解出来的字节带着这一次的构建戳。
#
# 移到这里还有第二个好处：CI 与本地跑的是**同一条命令**，冷启动自检与清单都能
# 在交付前自己跑一遍，不必等 push 之后看 CI。
#
# 用法：
#   pwsh -NoProfile -File .github/scripts/package-windows.ps1
#        [-TargetDir src-tauri/target/release] [-Stage artifacts/yomika-windows]
#        [-Output artifacts/yomika-windows.zip] [-Manifest artifacts/release-manifest.json]
#        [-SkipSelfCheck] [-ColdStart]
# 退出码：0 = 摆好、压好、自检查过；1 = 缺件或自检不过（红）。
[CmdletBinding()]
param(
    [string] $TargetDir = 'src-tauri\target\release',
    [string] $Stage = 'artifacts\yomika-windows',
    [string] $Output = 'artifacts\yomika-windows.zip',
    [string] $Manifest = 'artifacts\release-manifest.json',
    [switch] $SkipSelfCheck,
    [switch] $ColdStart
)

$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
function Resolve-InRepo([string] $path) {
    if ([System.IO.Path]::IsPathRooted($path)) { return $path }
    return (Join-Path $repo $path)
}
$targetDir = Resolve-InRepo $TargetDir
$stage = Resolve-InRepo $Stage
$output = Resolve-InRepo $Output
$manifestPath = Resolve-InRepo $Manifest

# 包里该有的三样，**一件都不能少**。少一件就当场说清楚是少哪一件——这正是这一轮修的
# 那个洞的教训：原来只查了三样，worker 不在也没人问。
#
# worker 不再单列：它现在在主 exe 的载荷里，由自检那三条（`no-separate-worker` /
# `worker-payload` / `worker-payload-stamp`）把关。多列一项「worker-exe」等于要求包里
# 出现第二个文件，与「交付只有一个文件」正好相反。
$required = [ordered]@{
    'main-exe'    = Join-Path $targetDir 'yomika.exe'
    'directml'    = Join-Path $targetDir 'DirectML.dll'
    'bundled-model' = Join-Path $targetDir 'data\models\waifu2x-upconv7'
}
$missing = @()
foreach ($key in $required.Keys) {
    $path = $required[$key]
    if (-not (Test-Path -LiteralPath $path)) { $missing += "$key（$path）" }
}
if ($missing.Count -gt 0) {
    Write-Host '[BAD] 交付包里缺了该有的东西：'
    foreach ($item in $missing) { Write-Host "      - $item" }
    Write-Host '      先跑 build-windows.ps1 -Release 把主 exe 编出来（worker 的字节由它嵌进去）。'
    exit 1
}

if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
New-Item -ItemType Directory -Force -Path $stage | Out-Null
foreach ($name in @('yomika.exe', 'DirectML.dll')) {
    Copy-Item -LiteralPath (Join-Path $targetDir $name) -Destination (Join-Path $stage $name) -Force
    Write-Host "拷进包：$name（$((Get-Item -LiteralPath (Join-Path $stage $name)).Length) 字节）"
}
New-Item -ItemType Directory -Force -Path (Join-Path $stage 'data\models') | Out-Null
Copy-Item -LiteralPath $required['bundled-model'] -Destination (Join-Path $stage 'data\models\waifu2x-upconv7') -Recurse -Force
$modelFiles = @(Get-ChildItem -LiteralPath (Join-Path $stage 'data\models\waifu2x-upconv7') -Recurse -File)
Write-Host "拷进包：随包模型 waifu2x-upconv7，$($modelFiles.Count) 个文件"

New-Item -ItemType Directory -Force -Path (Split-Path -Parent $output) | Out-Null
if (Test-Path -LiteralPath $output) { Remove-Item -LiteralPath $output -Force }
Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $output -Force
$zip = Get-Item -LiteralPath $output
Write-Host "打包：$output（$([Math]::Round($zip.Length / 1MB, 1)) MiB）"

# 捧到「用户见到它的样子」上自检一遍。**单起一个 pwsh**：那个脚本用 exit 1 报不过，
# 同进程 `&` 调会把整个会话结束掉。
#
# 这里给的是 **`-Path $stage`**，不是 `-Stage $stage`：那个脚本带着 `-Stage` 时会先按白名单
# 从源目录**往这个目录里补文件**，于是「stage 里少了什么」这种洞会被它自己补上、自检
# 照样报全过——而 zip 是在自检**之前**压好的。这不是设想：变异 A 把拷贝清单里的
# worker 删掉之后，zip 里没有 worker，自检却全绿（2026-10-08 实测，日志
# `debug_outputs/task10d/mut-a-copy-list.log`），那份 zip 拿去冷启动就是
# 「找不到 worker 可执行文件」。自检要读的是**即将发布的那一份**本身。
if (-not $SkipSelfCheck) {
    & pwsh -NoProfile -File (Join-Path $PSScriptRoot 'verify-compute-package.ps1') -Path $stage
    if ($LASTEXITCODE -ne 0) { throw "交付包自检没过（exit=$LASTEXITCODE）" }
}

# 发布清单：逐文件 sha256、随包模型、构建戳、协议大版本、许可证、已知限制、zip 自己的 hash。
$coldStartReport = ''
$coldStartLegacyReport = ''
if ($ColdStart) {
    $artifactsDir = Split-Path -Parent $output
    # 用**刚打出来的那个 zip** 跑冷启动：自检读的是里面的字节，冷启动读的是
    # 「解开来在一台干净点的机器上真跑一次」，两件事只有合起来才算交付前把关。
    $coldOut = Join-Path $artifactsDir 'cold-start'
    & pwsh -NoProfile -File (Join-Path $PSScriptRoot 'verify-cold-start.ps1') -Package $output -Expect ready -Out $coldOut
    if ($LASTEXITCODE -ne 0) { throw "冷启动自检没过（exit=$LASTEXITCODE）" }
    $coldStartReport = (Get-ChildItem -LiteralPath $coldOut -Filter 'cold-start-*.json' | Sort-Object LastWriteTime | Select-Object -Last 1).FullName

    # 升级那一半（docs/71:668）：同一份包里先摆一个第 10 档的旧库和一份用户自己的文件，
    # 看它升完之后备份在不在、行还在不在、那份文件动没动。读数写在另一个目录里，
    # 免得两种冷启动的 json 混在一起、「最后一个就是它」这种取法自己骗自己。
    $coldOutLegacy = Join-Path $artifactsDir 'cold-start-legacy'
    & pwsh -NoProfile -File (Join-Path $PSScriptRoot 'verify-cold-start.ps1') -Package $output -SeedLegacy -Expect ready -Out $coldOutLegacy
    if ($LASTEXITCODE -ne 0) { throw "旧库升级自检没过（exit=$LASTEXITCODE）" }
    $coldStartLegacyReport = (Get-ChildItem -LiteralPath $coldOutLegacy -Filter 'cold-start-*.json' | Sort-Object LastWriteTime | Select-Object -Last 1).FullName
}
& pwsh -NoProfile -File (Join-Path $PSScriptRoot 'release-manifest.ps1') -Package $stage -Out $manifestPath -Archive $output -ColdStartReport $coldStartReport -ColdStartLegacyReport $coldStartLegacyReport
if ($LASTEXITCODE -ne 0) { throw "发布清单没写出来（exit=$LASTEXITCODE）" }

Write-Host ''
Write-Host "包：$output"
Write-Host "  字节：$($zip.Length)"
Write-Host "  sha256：$((Get-FileHash -LiteralPath $output -Algorithm SHA256).Hash.ToLower())"
Write-Host "清单：$manifestPath"
exit 0
