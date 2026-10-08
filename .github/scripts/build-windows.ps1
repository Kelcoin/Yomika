[CmdletBinding()]
param(
    [switch]$Release,
    [switch]$SkipFrontend,
    [switch]$Clean,
    [switch]$UseHostTools,
    [string]$ToolchainRoot
)

$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
# The portable toolchain stays a local-only directory (its layout is pinned by
# tools/windows/toolchain-manifest.json). This script is the one piece of `tools/`
# that is checked in, and it lives here so the packaging job and a local build run
# the same file.
$ToolchainRoot = if ($ToolchainRoot) { $ToolchainRoot } else { Join-Path $repoRoot "tools\windows\toolchain" }

function Resolve-Tool([string]$RelativePath, [string]$Name) {
    $candidate = Join-Path $ToolchainRoot $RelativePath
    if (Test-Path -LiteralPath $candidate -PathType Leaf) {
        return (Resolve-Path -LiteralPath $candidate).Path
    }
    if ($UseHostTools) {
        $command = Get-Command $Name -ErrorAction SilentlyContinue
        if ($command) { return $command.Source }
    }
    throw "Missing $Name. Put the portable tool at '$candidate' or rerun with -UseHostTools. See docs/19-windows-local-build.md."
}

$node = Resolve-Tool "node\node.exe" "node"
$npm = Resolve-Tool "node\npm.cmd" "npm"
$cargo = Resolve-Tool "rust\bin\cargo.exe" "cargo"
$rustc = Resolve-Tool "rust\bin\rustc.exe" "rustc"

$toolBin = @(
    (Split-Path -Parent $node),
    (Split-Path -Parent $cargo),
    (Split-Path -Parent $rustc)
) -join [IO.Path]::PathSeparator
$oldPath = $env:Path
try {
    # Process-local only: this is not persisted with setx or registry changes.
    $env:Path = "$toolBin$([IO.Path]::PathSeparator)$oldPath"
    Push-Location $repoRoot
    if ($Clean) {
        & $cargo clean --manifest-path (Join-Path $repoRoot "src-tauri\Cargo.toml")
        if ($LASTEXITCODE -ne 0) { throw "Cargo clean failed with exit code $LASTEXITCODE." }
    }
    if (-not $SkipFrontend) {
        & $npm run build
        if ($LASTEXITCODE -ne 0) { throw "Frontend build failed with exit code $LASTEXITCODE." }
    }
    # tauri-build embeds the frontend assets during build.rs; cargo's incremental
    # cache does NOT rerun it when only `dist/` changed, so a stale asset snapshot
    # used to ship in otherwise fresh exes (rebuilding looked successful but the
    # embedded frontend lagged behind). Touching the config forces build.rs to
    # rerun and re-embed whatever `dist/` currently holds.
    $tauriConfig = Join-Path $repoRoot "src-tauri\tauri.conf.json"
    if (Test-Path -LiteralPath $tauriConfig -PathType Leaf) {
        (Get-Item -LiteralPath $tauriConfig -Force).LastWriteTime = Get-Date
    }
    # 构建戳的**显式**输入（审计 P2-3）：`build.rs` 登记了
    # `rerun-if-env-changed=YOMIKA_BUILD_COMMIT`，提交号一变它就重跑，不再只靠上面那个
    # 「把配置文件的时间戳碰一下」的副作用（那一下现在只为重新嵌入 dist 而留）。
    # 收尾时 `verify-build-stamp.ps1` 还会把产物里的戳与实际 HEAD 对一次。
    $git = Get-Command git -ErrorAction SilentlyContinue
    if ($git) {
        $head = & $git.Source -C $repoRoot rev-parse --short=12 HEAD 2>$null
        if ($LASTEXITCODE -eq 0 -and $head) {
            $env:YOMIKA_BUILD_COMMIT = "$head".Trim()
            Write-Host "Build stamp: $($env:YOMIKA_BUILD_COMMIT)"
        }
    }
    if (-not $env:YOMIKA_BUILD_COMMIT) { Write-Warning "拿不到 git 提交号：这一份产物不会带构建戳。" }
    $tauriArgs = @("run", "tauri", "build", "--", "--ci")
    if (-not $Release) {
        $tauriArgs += "--debug"
    }
    & $npm @tauriArgs
    if ($LASTEXITCODE -ne 0) { throw "Tauri build failed with exit code $LASTEXITCODE." }
    $configuration = if ($Release) { "release" } else { "debug" }
    $targetDir = Join-Path $repoRoot "src-tauri\target\$configuration"
    $output = Join-Path $targetDir "yomika.exe"

    # Windows package keeps only Windows runtime libraries.
    Get-ChildItem -LiteralPath $targetDir -File -Recurse -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -like 'libonnxruntime*.so' -or $_.Name -like 'libonnxruntime*.dylib' -or $_.Name -like 'libdirectml*.so' } |
        Remove-Item -Force

    # ort's `copy-dylibs` leaves DirectML.dll as a symlink into the per-user ONNX
    # Runtime download cache. That resolves on the machine that built it and
    # nowhere else, so a copied folder would fail to load the upscaler. Replace
    # the link with the file it points at.
    $directMl = Join-Path $targetDir "DirectML.dll"
    $link = Get-Item -LiteralPath $directMl -Force -ErrorAction SilentlyContinue
    if ($link -and $link.LinkType -eq "SymbolicLink") {
        $resolved = $link.Target | Select-Object -First 1
        if ($resolved -and (Test-Path -LiteralPath $resolved -PathType Leaf)) {
            Remove-Item -LiteralPath $directMl -Force
            Copy-Item -LiteralPath $resolved -Destination $directMl
            Write-Host "Replaced the DirectML.dll symlink with the real library."
        } else {
            Write-Warning "DirectML.dll is a symlink to '$resolved', which is missing; upscaling will not load on another machine."
        }
    }

    if (-not (Test-Path -LiteralPath $output -PathType Leaf)) { throw "Built executable missing: $output" }
    # 产物里的构建戳必须等于构建时的 HEAD（审计 P2-3）。对不上就在这里失败：脚本打印
    # 「构建成功」与产物真的换了是两件事。
    & (Join-Path $PSScriptRoot "verify-build-stamp.ps1") -Path $output

    # 计算 worker 是**另一份 exe**，`cargo build -p yomika` 不会顺手编它（Task 10 第①条）。
    # 宿主按 exe 同级目录找它，所以交付目录 = 主 exe 所在目录；两半读同一个
    # `YOMIKA_BUILD_COMMIT`（上面已经放进环境），握手时对得上才肯用。
    $workerArgs = @{
        Destination = $targetDir
    }
    if (-not $Release) { $workerArgs["DebugBuild"] = $true }
    if ($UseHostTools) { $workerArgs["UseHostTools"] = $true }
    if ($ToolchainRoot) { $workerArgs["ToolchainRoot"] = $ToolchainRoot }
    & (Join-Path $PSScriptRoot "build-compute-worker.ps1") @workerArgs
    # Ship the bundled model beside the portable executable so a fresh package
    # works immediately and uses the same fixed data/models path as the app.
    $bundledModel = Join-Path $repoRoot "src-tauri\resources\models\waifu2x-upconv7"
    $portableModel = Join-Path $targetDir "data\models\waifu2x-upconv7\1"
    if (Test-Path -LiteralPath $bundledModel -PathType Container) {
        New-Item -ItemType Directory -Force -Path $portableModel | Out-Null
        Get-ChildItem -LiteralPath $bundledModel -Recurse -File | ForEach-Object {
            $relative = $_.FullName.Substring($bundledModel.Length).TrimStart([char]92, [char]47)
            $destination = Join-Path $portableModel $relative
            $parent = Split-Path -Parent $destination
            New-Item -ItemType Directory -Force -Path $parent | Out-Null
            Copy-Item -LiteralPath $_.FullName -Destination $destination -Force
        }
        Write-Host "Bundled model copied to: $portableModel"
    }
    Write-Host "Windows portable executable: $output"

    # 交付包自检（`docs/71:660`）：主 exe / worker / 运行库 / 随包模型这一份便携目录得自洽
    # ——版本一致、运行库是真文件、没有随包的 NGX 垫片与片段。用 `-Stage`：源目录旁边是
    # 开发机的构建残渣与用户的活数据，把那些算成包只会让这条判据在开发机上永远红着。
    #
    # 单起一个 pwsh：那个脚本用 `exit 1` 报不过，同一个进程里 `&` 调用会把这一趟构建
    # 一起结束掉（`exit` 退的是整个会话，不只是那个脚本）。
    $packageCheck = Join-Path ([System.IO.Path]::GetTempPath()) ("yomika-package-check-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
    try {
        & pwsh -NoProfile -File (Join-Path $PSScriptRoot "verify-compute-package.ps1") -Stage $packageCheck
        if ($LASTEXITCODE -ne 0) { throw "交付包自检没过（exit=$LASTEXITCODE）" }
    } finally {
        if (Test-Path -LiteralPath $packageCheck) { Remove-Item -LiteralPath $packageCheck -Recurse -Force }
    }
} finally {
    Pop-Location
    $env:Path = $oldPath
}
