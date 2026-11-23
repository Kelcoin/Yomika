# 编出计算 worker 并把它放到便携目录里（docs/71 §11 Task 10 第①条）。
#
# 为什么要单独一个脚本：`cargo build -p yomika` **不会**顺手编它（worker 不是主 exe 的
# 依赖，见 `src-tauri/src/compute/mod.rs` 里 `worker_binary_path()` 的注释）。开发时它靠
# `cargo test` 顺带编出来，打包时没有人顺带——少了一步，交付的便携目录里就没有这一份
# exe，而宿主找不到它时只会在用户点开阅读器之后说「计算进程起不来」。
#
# 构建戳必须与主 exe 同源：两半都读同一个 `YOMIKA_BUILD_COMMIT`（缺省取 git HEAD），
# 握手时互相对一次，对不上就拒跑（Task 10 第②条）。所以这里也从 git 取一次，和
# `build-windows.ps1` 用同一行命令。

[CmdletBinding()]
param(
    # 交付用的是 release；开发机上想快就 -DebugBuild，但那样主 exe 也得是 debug 才配得上。
    #
    # 名字不能叫 `-Debug`：`[CmdletBinding()]` 自带一个通用参数 `Debug`，重名会让整个脚本
    # 在**参数绑定**那一步就死（`已为命令多次定义名为"Debug"的参数`），一行都跑不到。
    [switch]$DebugBuild,
    [switch]$UseHostTools,
    [string]$ToolchainRoot,
    # 编完把 exe 拷到哪儿。缺省就是 cargo 的产物目录（也就地修 DirectML.dll 的链接）。
    [string]$Destination
)

$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
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

# `DirectML.dll` 必须是一份**真文件**：ort 的 copy-dylibs 会在目标目录留一个指向
# per-user 下载缓存的符号链接，那种目录换台机器就是「文件在、加载不了」。主 exe 那一侧
# 由 `build-windows.ps1` 处理；worker 这一侧也得处理——它自己就导入 `DirectML.dll`。
function Resolve-DirectMl([string]$Directory) {
    $directMl = Join-Path $Directory "DirectML.dll"
    $item = Get-Item -LiteralPath $directMl -Force -ErrorAction SilentlyContinue
    if (-not $item) {
        Write-Warning "目标目录里没有 DirectML.dll：这份 worker 在别的机器上起不来（OR/T DirectML 那一半要靠它）。"
        return
    }
    if ($item.LinkType -eq "SymbolicLink") {
        $resolved = $item.Target | Select-Object -First 1
        if ($resolved -and (Test-Path -LiteralPath $resolved -PathType Leaf)) {
            Remove-Item -LiteralPath $directMl -Force
            Copy-Item -LiteralPath $resolved -Destination $directMl
            Write-Host "Replaced the DirectML.dll symlink with the real library."
        } else {
            throw "DirectML.dll 是指向 '$resolved' 的链接，而那份文件不在：不能把这种目录交出去。"
        }
    }
}

$cargo = Resolve-Tool "rust\bin\cargo.exe" "cargo"
$rustc = Resolve-Tool "rust\bin\rustc.exe" "rustc"
$toolBin = @((Split-Path -Parent $cargo), (Split-Path -Parent $rustc)) -join [IO.Path]::PathSeparator

$configuration = if ($DebugBuild) { "debug" } else { "release" }
# 显式钉住产物目录：这个仓库的开发环境里 `CARGO_TARGET_DIR` 常被指到 `debug_outputs\`
# 下去（那些是调试产物）。交付目录必须是 `src-tauri\target\<配置>`——打包脚本按这个位置
# 找 exe，`cargo` 的默认值又会被环境变量顶掉。
$targetDir = Join-Path $repoRoot "src-tauri\target"

$oldPath = $env:Path
try {
    $env:Path = "$toolBin$([IO.Path]::PathSeparator)$oldPath"
    Push-Location $repoRoot

    # 与 `build-windows.ps1` 逐字同源的取戳方式（两半必须报同一串）。
    $git = Get-Command git -ErrorAction SilentlyContinue
    if ($git) {
        $head = & $git.Source -C $repoRoot rev-parse --short=12 HEAD 2>$null
        if ($LASTEXITCODE -eq 0 -and $head) {
            $env:YOMIKA_BUILD_COMMIT = "$head".Trim()
            Write-Host "Build stamp: $($env:YOMIKA_BUILD_COMMIT)"
        }
    }
    if (-not $env:YOMIKA_BUILD_COMMIT) { Write-Warning "拿不到 git 提交号：这一份 worker 不会带构建戳，宿主会判成「不是同一次构建」。" }

    $buildArgs = @(
        "build",
        "--manifest-path", (Join-Path $repoRoot "src-tauri\Cargo.toml"),
        "--target-dir", $targetDir,
        "-p", "yomika-compute-worker"
    )
    if (-not $DebugBuild) { $buildArgs += "--release" }
    # ort-sys stages its runtime DLL in these directories during its build
    # script. Create them up front so staging can also run on a clean checkout.
    $profileDir = Join-Path $targetDir $configuration
    foreach ($directory in @($profileDir, (Join-Path $profileDir "examples"), (Join-Path $profileDir "deps"))) {
        New-Item -ItemType Directory -Force -Path $directory | Out-Null
    }
    & $cargo @buildArgs
    if ($LASTEXITCODE -ne 0) { throw "cargo build -p yomika-compute-worker failed with exit code $LASTEXITCODE." }

    $built = Join-Path $targetDir "$configuration\yomika-compute-worker.exe"
    if (-not (Test-Path -LiteralPath $built -PathType Leaf)) { throw "Built worker missing: $built" }

    $finalDir = if ($Destination) {
        New-Item -ItemType Directory -Force -Path $Destination | Out-Null
        (Resolve-Path -LiteralPath $Destination).Path
    } else {
        Split-Path -Parent $built
    }
    $final = Join-Path $finalDir "yomika-compute-worker.exe"
    if ($final -ne $built) {
        Copy-Item -LiteralPath $built -Destination $final -Force
        Write-Host "Worker copied to: $final"
    }

    # 这一份 exe 里必须真的有构建戳：`verify-build-stamp.ps1` 扫的是字节，而 worker 在
    # 加 `build.rs` 之前一个戳都没有（那次是「脚本对这份文件无从下手」而不是「戳不对」）。
    & (Join-Path $PSScriptRoot "verify-build-stamp.ps1") -Path $final

    Resolve-DirectMl $finalDir

    # 交付目录里不该出现 onnxruntime 的动态库：这一份 ort 是**静态**链进 exe 的
    # （`download-binaries` + `ort-sys` 的静态链接），旁边多一份 dll 反而会让用户以为
    # 那是必需的。看见就报出来，别默默留着。
    $strays = @(Get-ChildItem -LiteralPath $finalDir -File -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -like 'onnxruntime*' -or $_.Name -like 'DirectML*.so' })
    if ($strays.Count -gt 0) {
        throw "交付目录里出现了不该有的运行库（ORT 是静态链的）：$($strays.Name -join ', ')"
    }

    Write-Host "Compute worker: $final"
} finally {
    Pop-Location
    $env:Path = $oldPath
}
