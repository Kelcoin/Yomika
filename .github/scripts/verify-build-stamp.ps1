[CmdletBinding()]
param(
    # 要验的产物：Windows 的 `yomika.exe`，或 Android 的 `.so`。
    [Parameter(Mandatory = $true)][string]$Path,
    # 产物是 APK（一个 zip）：在它里面的 `.so` 上验。
    [switch]$InsideApk,
    # 期望的提交号。不给就取当前 HEAD。
    [string]$Commit
)

# 构建戳：`build.rs` 把 `YOMIKA_BUILD_COMMIT`（构建脚本没给就自己跑
# `git rev-parse --short=12 HEAD`）编进二进制，错误日志的「相关信息」用的就是它，也是
# 「这一份产物是哪来的」的唯一答案。
#
# 为什么必须构建完再验一次：`build.rs` 的重跑由 tauri-build 注册的
# `rerun-if-changed=tauri.conf.json`（与图标）决定，只改源码时它会复用上一次的输出，
# 产物里带的是**上一个**提交号（实测：HEAD 已是 b842e5f，APK 里却是 bc204cc；Windows
# 侧也见过 exe 停在 1ae33da）。脚本打印的「构建成功」与产物里的戳是两件事，这里把它们
# 钉在一起：对不上就让构建失败，别让一份带旧戳的包发出去。
$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
if (-not $Commit) {
    $git = Get-Command git -ErrorAction SilentlyContinue
    if ($git) {
        $head = & $git.Source -C $repoRoot rev-parse --short=12 HEAD 2>$null
        if ($LASTEXITCODE -eq 0 -and $head) { $Commit = "$head".Trim() }
    }
}
if (-not $Commit) {
    Write-Warning "拿不到提交号（没有 git，或这份产物不是从仓库里编的）：跳过构建戳校验。"
    return
}

function Test-Stamp([byte[]]$Bytes, [string]$Stamp) {
    # Latin-1：一个字节对一个字符，于是可以直接用字符串搜索。.NET 的 `IndexOf` 是带
    # SIMD 的序号搜索，比在 PowerShell 里逐字节扫一个 60MB 的 exe 快几个数量级。
    $text = [System.Text.Encoding]::GetEncoding(28591).GetString($Bytes)
    return $text.IndexOf($Stamp, [System.StringComparison]::Ordinal) -ge 0
}

$target = (Resolve-Path -LiteralPath $Path).Path

if ($InsideApk) {
    Add-Type -AssemblyName System.IO.Compression.FileSystem | Out-Null
    $archive = [System.IO.Compression.ZipFile]::OpenRead($target)
    try {
        $libraries = @($archive.Entries | Where-Object { $_.FullName -like '*.so' })
        if ($libraries.Count -eq 0) { throw "APK 里没有 .so，验不了构建戳：$target" }
        foreach ($library in $libraries) {
            $stream = $library.Open()
            try {
                $memory = New-Object System.IO.MemoryStream
                $stream.CopyTo($memory)
                if (Test-Stamp $memory.ToArray() $Commit) {
                    Write-Host "构建戳：$target 里的 $($library.FullName) 带 $Commit"
                    return
                }
            } finally {
                $stream.Dispose()
            }
        }
        throw "构建戳不对：$target 里没有一个 .so 带 $Commit（build.rs 大概复用了上一次的输出）。"
    } finally {
        $archive.Dispose()
    }
}

if (-not (Test-Stamp ([System.IO.File]::ReadAllBytes($target)) $Commit)) {
    throw ("构建戳不对：$target 里找不到 $Commit（build.rs 大概复用了上一次的输出）。" +
        "把 src-tauri\tauri.conf.json 的时间戳碰一下，或 cargo clean 之后重来。")
}
Write-Host "构建戳：$target 带 $Commit"
