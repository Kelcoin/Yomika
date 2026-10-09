[CmdletBinding()]
param(
    # 要验的包目录（缺省 `src-tauri\target\release`，也就是 `build-windows.ps1` 填出来的
    # 那个便携目录）。目录旁边通常是用户自己的活数据，所以这里一律**只读**。
    [string] $Path = '',
    # 只把「包该有的那一份」拷到这里再验。源目录里还躺着 `deps/`、`.fingerprint/`、
    # 547MB 的静态库与用户 3.4 GB 的缓存——「便携目录」到底指哪一堆文件，得有人说话，
    # 这个开关就是那句话：白名单以外的文件不进包里，也就不参与下面的每一条检查。
    [string] $Stage = '',
    # 这是跑过的安装目录（`data/` 里已经有缓存、日志、用户自备的 DLSSNR 片段），
    # 于是跳过「`data/` 干净」那一条。别的检查一字不改。
    [switch] $Installed,
    # 机器可读读数落这里。
    [string] $Json = '',
    # 要验的是 Android 的 APK（一个 zip），不是那个便携目录。这时只查 `docs/71:665`
    # 那一件：**这个包里没有 desktop 可执行依赖**——Windows 那两半、引擎运行库、
    # 垫片与片段一个都不许在，`arm64-v8a` 那一份 `.so` 必须在，而且带这一次的构建戳。
    [string] $Apk = ''
)

# 交付包的自检（`docs/71:662`/`:664`）：主 exe 在、是**这一次**构建编的、**里面那份 worker
# 载荷解得开且同源**、运行库是真文件而不是开发机上的符号链接、包里没有 ORT/CUDA/Vulkan 这些
# 「装了才能跑」的东西，也没有随包的 NGX 垫片与片段。
#
# 「一个文件」这件事是 2026-10-09 定的（`docs/71` §11 Task 10 第①条）：worker 的字节被压进
# 主 exe，跑起来仍是两个进程。所以包面**不许**再有第二份 `yomika-compute-worker.exe`——
# 有它就说明打包脚本还在拷第二个文件。
#
# 为什么不是「跑一遍看看」：这个包最终要去一台没装 CUDA、没装 Vulkan、甚至没有 N 卡的
# 机器上跑，本机跑得动证明不了那件事。这里的每一条都是**包面事实**——文件在不在、是不是
# 链接、字节里有没有那串名字——它们在换机器之后仍然成立。
$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path

$script:results = New-Object System.Collections.Generic.List[object]
$script:bad = 0
function Note([string] $Name, [bool] $Ok, [string] $Detail) {
    $script:results.Add([pscustomobject]@{ name = $Name; ok = $Ok; detail = $Detail })
    if (-not $Ok) { $script:bad++ }
    $tag = 'BAD'
    if ($Ok) { $tag = 'ok' }
    Write-Host ("[{0}] {1}：{2}" -f $tag, $Name, $Detail)
}

# Latin-1：一个字节对一个字符，于是可以直接用带 SIMD 的 `IndexOf` 找字面量。跟
# `verify-build-stamp.ps1` 用的是同一招，理由也一样（60MB 的 exe 逐字节扫太慢）。
#
# **针要先编成 UTF-8**：Latin-1 是一字节一字符，而 .NET 字符串里的中文是 U+4E2D 那类
# 码位——直接 `IndexOf` 是拿两张不同的字母表在比，永远找不到。ASCII 的针编出来与原文
# 一致，所以这一改对老判据是零影响。2026-10-03 在 Android 那一份 `.so` 上撞到过：
# `DLSSNR 只在 Windows 桌面端可用` 明明在（UTF-8 第 2045379 字节），第一次却报「没有」。
function Find-Literals([byte[]] $Bytes, [string[]] $Needles) {
    $text = [System.Text.Encoding]::GetEncoding(28591).GetString($Bytes)
    $found = New-Object System.Collections.Generic.List[string]
    foreach ($needle in $Needles) {
        $pattern = [System.Text.Encoding]::GetEncoding(28591).GetString([System.Text.Encoding]::UTF8.GetBytes($needle))
        if ($text.IndexOf($pattern, [System.StringComparison]::Ordinal) -ge 0) { $found.Add($needle) }
    }
    return $found.ToArray()
}

function Get-Sha256([string] $FilePath) {
    return (Get-FileHash -LiteralPath $FilePath -Algorithm SHA256).Hash.ToLowerInvariant()
}

# `deps/`、`build/`、`.fingerprint/`、`incremental/`、`.npm-cache/`、`examples/` 是构建
# 残渣，不是包；`data/` 另外处理（跑起来之后它会装满用户的东西）。
$script:skipDirs = @('deps', 'build', '.fingerprint', 'incremental', '.npm-cache', 'examples')
function Get-PackageFiles([string] $Root, [switch] $WithData) {
    $files = Get-ChildItem -LiteralPath $Root -Recurse -File -Force -ErrorAction SilentlyContinue
    return @($files | Where-Object {
            $relative = $_.FullName.Substring($Root.Length).TrimStart([char]92, [char]47)
            $top = ($relative -split '[\\/]')[0]
            if ($script:skipDirs -contains $top) { return $false }
            if (-not $WithData -and $top -eq 'data') { return $false }
            return $true
        })
}

# 两条来路（便携目录 / APK）共用同一份收尾：读数落盘、绿了说项数、红了 `exit 1`。
# 抽成函数是因为 APK 那一条要在读完 zip 之后就收尾，不能顺着往下走到「验目录」。
function Write-Report([bool] $Ok, [int] $Bad, [string] $Subject) {
    if ($Json) {
        $jsonPath = $Json
        if (-not [System.IO.Path]::IsPathRooted($jsonPath)) { $jsonPath = Join-Path $repoRoot $jsonPath }
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $jsonPath) | Out-Null
        [ordered]@{
            path      = $Subject
            source    = $Subject
            installed = $Installed.IsPresent
            ok        = $Ok
            bad       = $Bad
            results   = $script:results.ToArray()
        } | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $jsonPath -Encoding utf8
        Write-Host "读数：$jsonPath"
    }

    if ($Ok) {
        Write-Host "交付包自检通过：$($script:results.Count) 项。"
    } else {
        Write-Host "交付包自检有 $Bad 项不过（共 $($script:results.Count) 项）。"
        exit 1
    }
}

# 两条来路都要用它，所以放在分岔之前。原来它写在「验目录」那一段里，于是 APK 那一条走到
# `& $stampScript` 时它是 `$null`，换来的是一句 `管道元素中 '&' 后面的表达式生成了无效对象`
# ——第一版正是这么红的：6 项绿、1 项红，红在自检自己身上。
$stampScript = Join-Path $PSScriptRoot "verify-build-stamp.ps1"

# 交付只有一个文件之后，「第二份 worker 在不在」这件事变成了「主 exe 里那份载荷解不解得开」。
# 解码器与打包自检、清单共用一份（点源进来；它自己的参数叫 `-HostExePath`，刻意避开这个
# 文件里的 `-Path`）。
. (Join-Path $PSScriptRoot "worker-payload.ps1")

# ---- Android 那一份（`docs/71:665`）-------------------------------------------------
#
# 一个 APK 就是一个 zip，于是「包里有没有 desktop 可执行依赖」是可以当场读出来的事实：
# 条目名里有没有 exe/dll/worker/DirectML/NGX/ONNX Runtime 这些东西，`arm64-v8a` 那一份
# `.so` 在不在、是不是只有它和 `libc++_shared.so`，它的字节里有没有跑引擎的名字，构建戳
# 是不是这一次的。
#
# **为什么不等跑起来看**：APK 最终要装到一台没有桌面 exe、也没有 N 卡的手机或平板上，
# 本机跑不起来；而且「哪几个条目」这种事实换机器之后仍然成立。
#
# 反过来也要查一句：非 Windows 这一侧不是「少了一块」，是**换了一条会说实话的路**——
# DLSSNR 的命令壳在 Android 上回「DLSSNR 只在 Windows 桌面端可用」，宿主找不到 worker
# 时回「找不到 worker 可执行文件」。这两句都在包里，才说明这一份构建是诚实地不可用，
# 而不是把入口悄悄删了（前端按名字调，删了就是一句没人接的话）。
if ($Apk) {
    $apkPath = $Apk
    if (-not [System.IO.Path]::IsPathRooted($apkPath)) { $apkPath = Join-Path $repoRoot $apkPath }
    if (-not (Test-Path -LiteralPath $apkPath -PathType Leaf)) { throw "找不到要验的 APK：$apkPath" }
    $apkItem = Get-Item -LiteralPath $apkPath
    Write-Host "== APK：$($apkItem.FullName)"
    Note 'apk' ($apkItem.Length -gt 10MB) ("{0}，{1:N0} 字节，{2}" -f $apkItem.Name, $apkItem.Length, $apkItem.LastWriteTime)

    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [System.IO.Compression.ZipFile]::OpenRead($apkItem.FullName)
    $libBytes = $null
    try {
        $entries = @($archive.Entries)

        # 名字面：桌面那两半是 `.exe`，运行库/垫片/片段都是 `.dll`。
        $desktopHits = @($entries | Where-Object {
                $_.FullName -match '(?i)(\.exe$|\.dll$|worker|directml|ngx|onnxruntime|cuda|vulkan)'
            } | ForEach-Object { $_.FullName })
        $ok = $desktopHits.Count -eq 0
        $detail = "包里 $($entries.Count) 个条目，没有一条像桌面可执行/Windows 运行库（exe、dll、worker、DirectML、NGX、ONNX Runtime、CUDA、Vulkan）"
        if (-not $ok) { $detail = "包里有：$($desktopHits -join ', ')" }
        Note 'apk-no-desktop-exe' $ok $detail

        # 这一份 APK 只该有 arm64-v8a 的两份 `.so`：C++ 运行库与宿主自己那一份。
        $libs = @($entries | Where-Object { $_.FullName -like '*.so' })
        $libNames = @($libs | ForEach-Object { $_.FullName })
        $expectedLibs = @('lib/arm64-v8a/libc++_shared.so', 'lib/arm64-v8a/libyomika_lib.so')
        $missingLibs = @($expectedLibs | Where-Object { $libNames -notcontains $_ })
        $extraLibs = @($libNames | Where-Object { $expectedLibs -notcontains $_ })
        $ok = ($missingLibs.Count -eq 0) -and ($extraLibs.Count -eq 0)
        $detail = "两份 .so 都在，也没有别的：$($libNames -join ', ')"
        if (-not $ok) {
            $parts = @()
            if ($missingLibs.Count -gt 0) { $parts += "少了 $($missingLibs -join ', ')" }
            if ($extraLibs.Count -gt 0) { $parts += "多了 $($extraLibs -join ', ')" }
            $detail = $parts -join '；'
        }
        Note 'apk-libs' $ok $detail

        $mainLib = $libs | Where-Object { $_.FullName -eq 'lib/arm64-v8a/libyomika_lib.so' } | Select-Object -First 1
        if (-not $mainLib) {
            Note 'apk-no-host-engine' $false '包里没有 lib/arm64-v8a/libyomika_lib.so，没有字节可查'
            Note 'apk-answers-honestly' $false '同上'
            Note 'apk-stamp' $false '同上'
        } else {
            $libStream = $mainLib.Open()
            try {
                $libMemory = New-Object System.IO.MemoryStream
                $libStream.CopyTo($libMemory)
                $libBytes = $libMemory.ToArray()
                $libMemory.Dispose()
            } finally { $libStream.Dispose() }

            # 宿主那一半的引擎名字：垫片的导出名、D3D12、DirectML、片段名、ONNX Runtime。
            #
            # **不查 `ort-api`**：那是协议里的 `WORKER_RUNTIME_LABEL`，宿主拿它当派生缓存
            # 身份、与 worker 报的核对，Android 这一份里**本来就该带着它**（实测 UTF-8 第
            # 14801401 字节）。拿它当「宿主链了 ORT」的证据会误报——10-b 在 Windows 上就是
            # 被这个误报教过一次，这里不再踩。
            $found = Find-Literals $libBytes @('yomika_ngx_init', 'd3d12.dll', 'DirectML.dll', 'nvngx_dlssnr', 'onnxruntime')
            $ok = $found.Count -eq 0
            $detail = "libyomika_lib.so 是这一份构建编的（{0:N0} 字节），字节里没有引擎的名字" -f $libBytes.Length
            if (-not $ok) { $detail = "libyomika_lib.so 字节里有：$($found -join ', ')" }
            Note 'apk-no-host-engine' $ok $detail

            $found = Find-Literals $libBytes @('找不到 worker 可执行文件', 'DLSSNR 只在 Windows 桌面端可用')
            $ok = $found.Count -eq 2
            $detail = '两句诚实的回答都在包里：找不到 worker、DLSSNR 只在 Windows 桌面端可用'
            if (-not $ok) { $detail = "只找到 $($found.Count) 句（$($found -join '、')）：少哪一句，那个入口在这一份构建上就不是「诚实不可用」，而是没了" }
            Note 'apk-answers-honestly' $ok $detail

            # 换版本那一幕（`docs/71:663`）：APK 里这一份 `.so` 必须带这一次的构建戳，
            # 而且不是靠第一条 `.so` 碰巧撞上的——`verify-build-stamp.ps1 -InsideApk`
            # 会逐个 `.so` 找，找不到就 throw。
            $stampOk = $true
            $stampText = ''
            try { $stampText = (& $stampScript -Path $apkItem.FullName -InsideApk *>&1 | Out-String).Trim() } catch {
                $stampOk = $false
                $stampText = $_.Exception.Message
            }
            Note 'apk-stamp' $stampOk $stampText
        }

        # 内嵌的那份前端配置：`yomika-image:` 是资产协议要用的 scheme。它不在，说明这一份
        # APK 是资产协议之前建的（`data/` 那一套图就上不了屏），或者 CSP 又被改回去了。
        $configEntry = $entries | Where-Object { $_.FullName -eq 'assets/tauri.conf.json' } | Select-Object -First 1
        if (-not $configEntry) {
            Note 'apk-config' $false 'APK 里没有 assets/tauri.conf.json'
        } else {
            $configReader = New-Object System.IO.StreamReader($configEntry.Open())
            try { $configText = $configReader.ReadToEnd() } finally { $configReader.Dispose() }
            $ok = $configText.Contains('yomika-image:')
            $detail = '内嵌配置里的 CSP 有资产协议的 yomika-image:'
            if (-not $ok) { $detail = '内嵌配置里没有 yomika-image:（这一份包早于资产协议，或者 CSP 又被改回去了）' }
            Note 'apk-config' $ok $detail
        }
    } finally { $archive.Dispose() }

    Write-Report ($script:bad -eq 0) $script:bad $apkItem.FullName
    exit 0
}

$source = Join-Path $repoRoot "src-tauri\target\release"
if ($Path) { $source = (Resolve-Path -LiteralPath $Path).Path }
if (-not (Test-Path -LiteralPath $source -PathType Container)) { throw "找不到要验的包目录：$source" }

$target = $source
if ($Stage) {
    if (-not (Test-Path -LiteralPath $Stage -PathType Container)) { New-Item -ItemType Directory -Force -Path $Stage | Out-Null }
    $stageFull = (Resolve-Path -LiteralPath $Stage).Path
    # 白名单。源目录旁边可能是用户 219 MB 的档案库与 3.4 GB 的缓存，多拷一个字节都算
    # 破坏，所以这里是枚举而不是「整个目录去掉几个」。
    #
    # **worker 不在这一行里**：交付只有一个文件，worker 的字节在主 exe 的载荷里
    # （`docs/71` §11 Task 10 第①条；见 `.github/scripts/worker-payload.ps1`）。
    foreach ($name in @('yomika.exe', 'DirectML.dll')) {
        $from = Join-Path $source $name
        if (Test-Path -LiteralPath $from -PathType Leaf) {
            Copy-Item -LiteralPath $from -Destination (Join-Path $stageFull $name) -Force
        }
    }
    $modelSource = Join-Path $source 'data\models\waifu2x-upconv7'
    if (Test-Path -LiteralPath $modelSource -PathType Container) {
        $modelStage = Join-Path $stageFull 'data\models\waifu2x-upconv7'
        New-Item -ItemType Directory -Force -Path $modelStage | Out-Null
        Get-ChildItem -LiteralPath $modelSource -Recurse -File -Force | ForEach-Object {
            $relative = $_.FullName.Substring($modelSource.Length).TrimStart([char]92, [char]47)
            $destination = Join-Path $modelStage $relative
            New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destination) | Out-Null
            Copy-Item -LiteralPath $_.FullName -Destination $destination -Force
        }
    }
    $target = $stageFull
    Write-Host "== 只把包该有的那一份拷出来验：$target"
}
Write-Host "== 包：$target"

# ---- 主 exe 在，而且是这一次构建编的 ----------------------------------------------
$hostExe = Join-Path $target 'yomika.exe'
$hostExists = Test-Path -LiteralPath $hostExe -PathType Leaf
if (-not $hostExists) {
    Note 'main-exe' $false "包里没有 yomika.exe"
} else {
    $hostLength = (Get-Item -LiteralPath $hostExe).Length
    $detail = "{0}，{1:N0} 字节" -f $hostExe, $hostLength
    Note 'main-exe' ($hostLength -gt 20MB) $detail
    $stampOk = $true
    $stampText = ''
    # `*>&1`：构建戳脚本是用 `Write-Host` 报「带 <戳>」的，那是信息流（6），光写 `2>&1`
    # 收不到，红的绿的都会是一条空细节。
    try { $stampText = (& $stampScript -Path $hostExe *>&1 | Out-String).Trim() } catch {
        $stampOk = $false
        $stampText = $_.Exception.Message
    }
    Note 'main-exe-stamp' $stampOk $stampText
}

# ---- 交付只有一个文件：worker 的字节在主 exe 的载荷里，包面不该再有第二份 ------------
#
# 这三条是一组：① 包面不许有 canonical 名字的那份 worker（有就说明打包脚本还在拷第二个
# 文件，「单文件」只是嘴上说说）；② 宿主里那份载荷解得开、摘要对得上、大小像话；
# ③ 解出来的字节带着**这一次**的构建戳——与主 exe 同源，10-a 的握手才有得比。
$separateWorker = Join-Path $target 'yomika-compute-worker.exe'
if (Test-Path -LiteralPath $separateWorker -PathType Leaf) {
    Note 'no-separate-worker' $false "包里另有一份 $separateWorker（说好是一个文件，worker 的字节该在主 exe 里）"
} else {
    Note 'no-separate-worker' $true '包里没有第二份 worker，它的字节在主 exe 里'
}

$workerBytes = $null
if ($hostExists) {
    $reading = Read-WorkerPayload -HostExe $hostExe
    $payloadOk = $reading.Ok -and $reading.Bytes.Length -gt 5MB
    $detail = $reading.Reason
    if ($reading.Ok -and -not $payloadOk) {
        $detail = "载荷只有 {0:N0} 字节（worker 本体是二十几 MB，这么小就说明嵌错了东西）" -f $reading.Bytes.Length
    }
    Note 'worker-payload' $payloadOk $detail
    if ($reading.Ok) {
        $workerBytes = $reading.Bytes
        # 把解出来的那一份写到临时文件上再交给戳脚本：它只会读文件。
        $scratch = Join-Path ([System.IO.Path]::GetTempPath()) ("yomika-payload-stamp-" + [guid]::NewGuid().ToString('N').Substring(0, 8) + ".exe")
        try {
            [System.IO.File]::WriteAllBytes($scratch, $workerBytes)
            $stampOk = $true
            $stampText = ''
            try { $stampText = (& $stampScript -Path $scratch *>&1 | Out-String).Trim() } catch {
                $stampOk = $false
                $stampText = $_.Exception.Message
            }
            Note 'worker-payload-stamp' $stampOk $stampText
        } finally {
            Remove-Item -LiteralPath $scratch -Force -ErrorAction SilentlyContinue
        }
    } else {
        Note 'worker-payload-stamp' $false '载荷没解出来，没法验它带的是不是这一次的戳'
    }
} else {
    # 主 exe 都不在时这两条也得留下名字：**空转的守卫什么都不算**（8-h⑤ 的教训），报告
    # 里少两行比多两行红更容易被当成「这一项过了」。
    Note 'worker-payload' $false '包里没有主 exe，无从谈载荷'
    Note 'worker-payload-stamp' $false '包里没有主 exe，无从谈载荷'
}

# ---- 宿主不再持有 NGX / ONNX Runtime 资源（Task 8 的出口，也是这一条的「版本一致」） ----
if ($hostExists) {
    $hostBytes = [System.IO.File]::ReadAllBytes($hostExe)
    # 垫片的导出名只有编进宿主时才可能出现——它出现就说明这一份宿主又把 shim 带上了。
    $found = Find-Literals $hostBytes @('yomika_ngx_init')
    $ok = $found.Count -eq 0
    $detail = '宿主字节里没有垫片的导出名'
    if (-not $ok) { $detail = "宿主字节里有：$($found -join ', ')" }
    Note 'no-host-ngx' $ok $detail
    # ORT 那一半：D3D12 与 DirectML 的导入名，以及 ONNX Runtime 自己的名字。
    #
    # **不查 `ort-api`**：那是 `compute-protocol` 里的常量（`WORKER_RUNTIME_LABEL`），宿主
    # 拿它当派生缓存身份、与 worker 报的核对（宿主不再链 ORT，问不了运行库自己），所以
    # 它**本来就该**在这份宿主的字节里。拿它当「宿主链了 ORT」的证据会误报——这一条就是
    # 被这个误报教出来的：第一版查了，新编的宿主上红了，而红的那一串是设计的一部分。
    $found = Find-Literals $hostBytes @('d3d12.dll', 'DirectML.dll', 'onnxruntime')
    $ok = $found.Count -eq 0
    $detail = '宿主字节里没有 D3D12/DirectML/ONNX Runtime 的痕迹'
    if (-not $ok) { $detail = "宿主字节里有：$($found -join ', ')" }
    Note 'no-host-ort' $ok $detail
}

# ---- worker 这一半要的正好相反：NGX 在内，运行库标签与协议里那一份一致 --------------
if ($workerBytes) {
    $found = Find-Literals $workerBytes @('yomika_ngx_init')
    $ok = $found.Count -gt 0
    $detail = 'worker 里有垫片的导出名（引擎在它这一侧）'
    if (-not $ok) { $detail = 'worker 里找不到垫片的导出名：NGX 那一档到这台机器上就只剩「不可用」' }
    Note 'worker-has-ngx' $ok $detail

    $protocolSource = Get-Content -LiteralPath (Join-Path $repoRoot 'src-tauri\crates\compute-protocol\src\messages.rs') -Raw
    $labelMatch = [regex]::Match($protocolSource, 'WORKER_RUNTIME_LABEL:\s*&str\s*=\s*"([^"]+)"')
    if (-not $labelMatch.Success) {
        Note 'worker-runtime-label' $false '协议源码里找不到 WORKER_RUNTIME_LABEL'
    } else {
        $label = $labelMatch.Groups[1].Value
        $found = Find-Literals $workerBytes @($label)
        # 运行库标签是缓存身份的一部分：worker 报的与协议里写的是两串不同的话，同一份
        # 输入会在缓存里分成两行，谁也不知道哪一行是哪一档算的。
        $ok = $found.Count -gt 0
        $detail = "worker 里带着协议那一份标签：$label"
        if (-not $ok) { $detail = "worker 里没有协议写的运行库标签 $label" }
        Note 'worker-runtime-label' $ok $detail
    }
} else {
    # 同上：载荷解不出来时这两条不是「不适用」，是「没得查」——报告里必须照样出现，
    # 否则红的份数会随包的形状变，读的人分不清「过了」与「没跑」。
    Note 'worker-has-ngx' $false 'worker 的字节没解出来，查不了'
    Note 'worker-runtime-label' $false 'worker 的字节没解出来，查不了'
}

# ---- DirectML.dll 必须是真文件（`ort` 的 copy-dylibs 会留一个指向开发机缓存的链接）---
$directMl = Join-Path $target 'DirectML.dll'
if (-not (Test-Path -LiteralPath $directMl -PathType Leaf)) {
    Note 'directml-real-file' $false '包里没有 DirectML.dll（DirectML 那一档到别的机器上会加载失败）'
} else {
    $item = Get-Item -LiteralPath $directMl -Force
    $isLink = ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0
    # 链接指向的是**这台机器**的 ONNX Runtime 下载缓存，拷走就断；所以要么真文件，要么
    # 这一条红。大小也顺手看一眼：真正的那份是十几 MB，占位文件不是。
    $ok = (-not $isLink) -and ($item.Length -gt 1MB)
    $detail = "DirectML.dll 是真文件，{0:N0} 字节" -f $item.Length
    if ($isLink) { $detail = 'DirectML.dll 是符号链接（指向开发机的缓存，换台机器就断）' }
    Note 'directml-real-file' $ok $detail
}

# ---- 包面不许有 reparse point（「不要依赖开发机 Cargo cache symlink」）---------------
$packageFiles = Get-PackageFiles $target
$links = @($packageFiles | Where-Object { ($_.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0 })
if ($links.Count -eq 0) {
    Note 'no-reparse-points' $true "$($packageFiles.Count) 个文件，没有一个是符号链接/junction"
} else {
    Note 'no-reparse-points' $false "有 reparse point：$((@($links | ForEach-Object { $_.Name }) -join ', '))"
}

# ---- 包里没有「装了才能跑」的运行库 ------------------------------------------------
$names = @($packageFiles | ForEach-Object { $_.Name })
$ort = @($names | Where-Object { $_ -like 'onnxruntime*.dll' -or $_ -like 'libonnxruntime*' })
if ($ort.Count -eq 0) {
    Note 'no-ort-runtime' $true '包里没有 ONNX Runtime 运行库（静态链，不靠拷 DLL）'
} else {
    Note 'no-ort-runtime' $false "包里有：$($ort -join ', ')"
}

$cuda = @($names | Where-Object {
        $_ -like 'cudart*' -or $_ -like 'cublas*' -or $_ -like 'cudnn*' -or $_ -like 'nvrtc*' -or
        $_ -like 'cufft*' -or $_ -like 'curand*' -or $_ -like 'cusolver*' -or $_ -like 'cusparse*' -or
        $_ -like 'nvcuda.dll' -or $_ -like 'nvml.dll' -or $_ -like 'nvapi64.dll'
    })
if ($cuda.Count -eq 0) {
    Note 'no-cuda-dll' $true '包里没有 CUDA 运行库（这一档没接，见 compute-core 的 cuda feature 注释）'
} else {
    Note 'no-cuda-dll' $false "包里有：$($cuda -join ', ')"
}

$vulkan = @($names | Where-Object { $_ -like 'vulkan-1.dll' -or $_ -like 'nvoglv*' -or $_ -like 'vulkaninfo*' })
if ($vulkan.Count -eq 0) {
    Note 'no-vulkan-dll' $true '包里没有 Vulkan 运行库（ncnn-vulkan 那一档还没接）'
} else {
    Note 'no-vulkan-dll' $false "包里有：$($vulkan -join ', ')"
}

# ---- NGX 垫片与片段都不随包：垫片由宿主在运行期落进 data/，片段是用户自备的 ----------
$topNames = @((Get-ChildItem -LiteralPath $target -File -Force -ErrorAction SilentlyContinue) | ForEach-Object { $_.Name })
$shim = @($topNames | Where-Object { $_ -eq 'yomika_ngx.dll' -or $_ -eq 'nvngx_dlssnr.dll' })
if ($shim.Count -eq 0) {
    Note 'no-bundled-ngx' $true '包面没有 NGX 垫片，也没有 nvngx_dlssnr.dll 片段'
} else {
    Note 'no-bundled-ngx' $false "包面有：$($shim -join ', ')"
}

# ---- 随包模型与它自己的清单对得上 -------------------------------------------------
$modelManifest = Join-Path $repoRoot 'src-tauri\resources\models\waifu2x-upconv7\yomika-model.json'
$modelInPackage = Join-Path $target 'data\models\waifu2x-upconv7\1\model.onnx'
if (-not (Test-Path -LiteralPath $modelInPackage -PathType Leaf)) {
    Note 'bundled-model' $false "包里没有随包模型：$modelInPackage"
} elseif (-not (Test-Path -LiteralPath $modelManifest -PathType Leaf)) {
    Note 'bundled-model' $false "找不到随包模型的清单：$modelManifest"
} else {
    $expected = (Get-Content -LiteralPath $modelManifest -Raw | ConvertFrom-Json).sha256.ToLowerInvariant()
    $actual = Get-Sha256 $modelInPackage
    $ok = $actual -eq $expected
    $detail = "随包模型的 sha256 与清单一致：$actual"
    if (-not $ok) { $detail = "随包模型 sha256 不一致：包里 $actual，清单 $expected" }
    Note 'bundled-model' $ok $detail
}

# ---- 干净语义：`data/` 里只有随包模型 --------------------------------------------
if ($Installed) {
    Note 'clean-data' $true '这是跑过的安装目录（-Installed），data/ 里的用户东西不算问题'
} else {
    $dataRoot = Join-Path $target 'data'
    if (-not (Test-Path -LiteralPath $dataRoot -PathType Container)) {
        Note 'clean-data' $true 'data/ 还没建（首次启动会自己建），这一条没有可查的'
    } else {
        $dataTop = @((Get-ChildItem -LiteralPath $dataRoot -Force) | ForEach-Object { $_.Name })
        $unexpected = @($dataTop | Where-Object { $_ -ne 'models' })
        $modelDirs = @()
        $modelsRoot = Join-Path $dataRoot 'models'
        if (Test-Path -LiteralPath $modelsRoot -PathType Container) {
            $modelDirs = @((Get-ChildItem -LiteralPath $modelsRoot -Force) | ForEach-Object { $_.Name } | Where-Object { $_ -ne 'waifu2x-upconv7' })
        }
        $ok = ($unexpected.Count -eq 0) -and ($modelDirs.Count -eq 0)
        if ($ok) {
            Note 'clean-data' $true 'data/ 里只有随包模型这一棵'
        } else {
            $extra = @($unexpected) + @($modelDirs) | Sort-Object -Unique
            Note 'clean-data' $false "data/ 里还多了：$($extra -join ', ')"
        }
    }
}

Write-Report ($script:bad -eq 0) $script:bad $target
