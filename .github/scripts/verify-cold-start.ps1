# 冷启动自检：把交付包放到一台「干净点的机器」上真的跑一次。
#
# 为什么要有它：`verify-compute-package.ps1` 查的是**包里的字节**（有没有 worker、有没有
# 宿主侧的引擎、构建戳对不对），16 项里 11 项是静态判据。那些判据全绿也可能一跑就死——
# 合同第 10 条要的是「clean 包可运行」（docs/71:668），那就得真起一个进程、真连上它的
# 主窗、真问一句算力那一栏是什么状态。
#
# 它按**交付时的打包逻辑**把包摆出来（zip 直接解；给目录就按 workflow 那份白名单拷：
# yomika.exe、yomika-compute-worker.exe、DirectML.dll、data/ 那一棵），然后：
#   ① 用一份**洗过的环境变量**起 exe：不留 CARGO_TARGET_DIR / RUSTUP_HOME / JAVA_HOME /
#      ANDROID_*，PATH 只留系统目录——「不依赖开发机 Cargo cache symlink、全局 PATH 或
#      已安装 CUDA」（docs/71:662）这句话只有这样才测得到；
#   ② 等 WebView2 的调试端口，挑出主窗那一页（一个进程两个 WebView2 环境，托盘菜单在
#      IPv4、主窗在 IPv6，9-f 的现场）；
#   ③ 让 `cold-start-probe.mjs` 去问界面、把计算进程叫起来、按 `-Expect` 核对状态、再走
#      一次导航；
#   ④ 查文件面：`data/yomika.sqlite3` 有没有被建出来、`crash.log` 是不是空的；
#   ⑤ `-Runs 2` 时在同一份拷贝里再来一遍，比一比用户数据还在不在（「用户数据无破坏」）。
#   ⑥ `-SeedLegacy` 时先摆一个**旧机器上留下来的库**（第 10 档 + 一台服务器、一份档案、
#      一个读到一半的位置、一行设置）和一份用户自己的文件，再看这一版把它升成什么样：
#      主库升到本版档位、行都还在、升级前那一份留在旁边且还是第 10 档、
#      用户那份文件一字没动（「升级/回退可恢复」docs/71:668）。
#
# 用法：
#   pwsh -NoProfile -File .github/scripts/verify-cold-start.ps1 -Package <zip|目录> `
#        [-Expect ready|broken|any] [-Needle <理由里该有的话>] [-SwapHost <别处的 yomika.exe>]
#        [-BreakPayload] [-SeedLegacy] [-Runs 2] [-Out <目录>] [-Keep]
# 退出码：0 = 每一条都成立；1 = 任何一条不成立。
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string] $Package,
    [ValidateSet('any', 'ready', 'broken')][string] $Expect = 'ready',
    [string] $Needle = '',
    [string] $SwapHost = '',
    [switch] $BreakPayload,
    [switch] $SeedLegacy,
    [int] $Runs = 1,
    [int] $Port = 0,
    [string] $Out = '',
    [int] $TimeoutSec = 120,
    [switch] $Keep
)

$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
if (-not $Out) { $Out = Join-Path $repo 'debug_outputs\cold-start' }
New-Item -ItemType Directory -Force -Path $Out | Out-Null
$root = Join-Path $env:TEMP "yomika-cold-$stamp"
$app = Join-Path $root 'app'
New-Item -ItemType Directory -Force -Path $app | Out-Null

$results = New-Object System.Collections.ArrayList
$script:bad = 0
function Say([string] $text) { Write-Host $text }
function Note([string] $name, [bool] $ok, [string] $detail) {
    [void]$results.Add([ordered]@{ name = $name; ok = $ok; detail = $detail })
    if ($ok) { Say "[ok] ${name}：$detail" } else { Say "[BAD] ${name}：$detail"; $script:bad += 1 }
}

# 把 `legacy-database.mjs --inspect` 的读数读进来。表可能是这一版才有的（升级前那份
# 备份里就没有），所以那边每一问都是独立兜底；读不出来是「不知道」，不是「没有」。
function Get-LegacyReading([string] $dbPath) {
    if (-not (Test-Path -LiteralPath $dbPath)) { return $null }
    $raw = & node (Join-Path $repo '.github\scripts\legacy-database.mjs') --inspect $dbPath 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $raw) { return $null }
    try { return (($raw -join "`n") | ConvertFrom-Json) } catch { return $null }
}

# ---- 摆包 -------------------------------------------------------------------
$packagePath = (Resolve-Path $Package).Path
if (Test-Path -LiteralPath $packagePath -PathType Container) {
    # 目录：按 workflow 那份白名单搬（整棵 target\release 有几十 GB 的构建中间物，
    # 搬过来只会把「干净」两个字弄脏）。
    # 2026-10-09 起交付只有**一个可执行文件**：worker 的字节压在主 exe 的载荷里，所以
    # 白名单里没有 `yomika-compute-worker.exe`。第二份文件出现在包里反而是缺陷
    # （`verify-compute-package.ps1` 的 `no-separate-worker` 正是这么判的）。
    $wanted = @('yomika.exe', 'DirectML.dll')
    foreach ($name in $wanted) {
        $source = Join-Path $packagePath $name
        if (Test-Path -LiteralPath $source) { Copy-Item -LiteralPath $source -Destination (Join-Path $app $name) -Force }
    }
    # 只搬**随包的那一个模型**（`waifu2x-upconv7`）。搬整棵 `data/models` 是错的：
    # 开发机上那棵里还躺着用户自己下的 realcugan/realesrgan/mrcnn（几百 MB），
    # 一起搬过来就把「干净」两个字弄脏了——workflow 里那一步也只拷这一个目录。
    $models = Join-Path $packagePath 'data\models\waifu2x-upconv7'
    if (Test-Path -LiteralPath $models) {
        New-Item -ItemType Directory -Force -Path (Join-Path $app 'data\models') | Out-Null
        Copy-Item -LiteralPath $models -Destination (Join-Path $app 'data\models\waifu2x-upconv7') -Recurse -Force
    }
    Note 'package-shape' $true "从目录按白名单摆：$packagePath"
} else {
    Expand-Archive -LiteralPath $packagePath -DestinationPath $app -Force
    Note 'package-shape' $true "解压：$packagePath"
}

$exe = Join-Path $app 'yomika.exe'
if (-not (Test-Path -LiteralPath $exe)) {
    Note 'main-exe' $false "包里没有 yomika.exe：$app"
    Say "冷启动自检不通过：包不完整。"
    exit 1
}
# 「计算进程起不来」这一族现场在新形状下有两个等价物，都改在**主 exe** 上动手：
#   `-BreakPayload` 把宿主里那份载荷正文翻一个字节（等价于旧形状里「worker 文件不在」）；
#   `-SwapHost` 换一份别处的 `yomika.exe`（它带着**自己的**载荷与构建戳，等价于旧形状里
#   「另一代的 worker」——握手那一步该照旧拒跑，而主窗不许被挡住）。
$payloadReading = $null
if ($BreakPayload) {
    $bytes = [System.IO.File]::ReadAllBytes($exe)
    $at = [System.Text.Encoding]::GetEncoding(28591).GetString($bytes).IndexOf('YOMIKA-WORKER-PAYLOAD' + [char]0x01, [System.StringComparison]::Ordinal)
    if ($at -lt 0) { throw "这一份主 exe 里本来就没有 worker 载荷，没法弄坏：$exe" }
    # 头 = 记号(22：`YOMIKA-WORKER-PAYLOAD` 21 个字母 + 0x01) + 压缩长度(4) + 原始长度(4)
    # + 摘要(32)，正文从这之后开始。翻**正文的最后一个字节**（不是文件的最后一个字节：
    # 载荷躺在文件中间，文件尾巴与它没关系），这样解压本身就会失败，把「载荷读不出来」
    # 那条路走到。
    $head = $at + 22
    $compressed = [System.BitConverter]::ToUInt32($bytes, $head)
    $last = $head + 8 + 32 + $compressed - 1
    if ($last -ge $bytes.Length) { throw "载荷头说正文有 $compressed 字节，文件里放不下：$exe" }
    $bytes[$last] = $bytes[$last] -bxor 0xFF
    [System.IO.File]::WriteAllBytes($exe, $bytes)
}
if ($SwapHost) {
    if (-not (Test-Path -LiteralPath $SwapHost)) { throw "要换进去的主 exe 不在：$SwapHost" }
    Copy-Item -LiteralPath $SwapHost -Destination $exe -Force
}
if (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'worker-payload.ps1')) {
    . (Join-Path $PSScriptRoot 'worker-payload.ps1')
    $payloadReading = Read-WorkerPayload -HostExe $exe
}

$inventory = @()
foreach ($name in @('yomika.exe', 'DirectML.dll')) {
    $path = Join-Path $app $name
    if (Test-Path -LiteralPath $path) {
        $item = Get-Item -LiteralPath $path
        $inventory += [ordered]@{ name = $name; bytes = $item.Length; sha256 = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLower() }
    } else {
        $inventory += [ordered]@{ name = $name; bytes = 0; sha256 = ''; missing = $true }
    }
}
$modelFiles = @(Get-ChildItem -LiteralPath (Join-Path $app 'data\models') -Recurse -File -ErrorAction SilentlyContinue)
Note 'package-inventory' $true ("主 exe {0:N0} B；包面第二份 worker {1}；DirectML.dll {2}；随包模型 {3} 个文件" -f `
    ($inventory | Where-Object { $_.name -eq 'yomika.exe' }).bytes,
    $(if (Test-Path -LiteralPath (Join-Path $app 'yomika-compute-worker.exe')) { '在（说好只有一个文件，这是缺陷）' } else { '不在（就该不在）' }),
    $(if ($inventory | Where-Object { $_.name -eq 'DirectML.dll' -and -not $_.missing }) { '在' } else { '不在' }),
    $modelFiles.Count)
# 载荷这一条是**单文件**这条交付承诺的直接判据：宿主里解得开、摘得到，才谈得上
# 「主 exe 自己把 worker 摆出来再拉起来」。`-BreakPayload`/`-SwapHost` 这两族负现场
# 就是冲着它来的。
if ($payloadReading) {
    if ($BreakPayload) {
        # 这一跑故意把载荷弄坏了：要量的是「坏了之后界面还能不能用」，所以这一条在这里
        # 不是判据，而是一句**说明**——写成 [BAD] 会让「期望的行为」与「故意造的现场」
        # 混成一件事，读报告的人再也分不清哪一条是真的缺陷。
        Note 'worker-payload' $true "故意弄坏（这一跑量的是它坏掉之后会怎样）：$($payloadReading.Reason)"
    } else {
        Note 'worker-payload' $payloadReading.Ok ("宿主里的 worker 载荷：" + $(if ($payloadReading.Ok) { "{0:N0} 字节，sha256 $($payloadReading.Digest)" -f $payloadReading.Bytes.Length } else { $payloadReading.Reason }))
    }
}

# ---- 旧机器上留下来的数据（-SeedLegacy） -------------------------------------
# 「升级/回退可恢复、用户数据无破坏」（docs/71:668）在一台干净机器上就只有这一种量法：
# 摆一个**真旧库**（仓库自己的迁移 SQL 跑到第 10 档，再塞一台服务器、一份档案、一个读到
# 一半的位置、一行设置）和一份用户自己的文件，然后看这一版会把它变成什么样。
# 夹具由 `legacy-database.mjs` 现场造（node:sqlite，Node 24 自带），不在仓库里放二进制 ——
# 手抄一份建表语句的夹具，迟早会和真正的老库长得不一样。
$seedMarkerPath = ''
$seedMarkerText = '这台机器上原来就有的一个文件：升级不该动它。'
if ($SeedLegacy) {
    $seedPath = Join-Path $root 'legacy\yomika-v10.sqlite3'
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $seedPath) | Out-Null
    & node (Join-Path $repo '.github\scripts\legacy-database.mjs') --make $seedPath --up-to 10
    if ($LASTEXITCODE -ne 0) { throw "旧库夹具没造出来（exit=$LASTEXITCODE）：$seedPath" }
    $seedReading = Get-LegacyReading $seedPath
    if (-not $seedReading) { throw "旧库夹具读不回来：$seedPath" }
    $dataDir = Join-Path $app 'data'
    New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
    Copy-Item -LiteralPath $seedPath -Destination (Join-Path $dataDir 'yomika.sqlite3') -Force
    $seedMarkerPath = Join-Path $dataDir 'notes-from-the-old-machine.txt'
    Set-Content -LiteralPath $seedMarkerPath -Value $seedMarkerText -NoNewline -Encoding utf8
    Note 'seed-database' ($seedReading.version -eq 10 -and [bool] $seedReading.archive) "摆了一个旧库：档位 $($seedReading.version)、$($seedReading.bytes) 字节、表 $($seedReading.tables) 张、档案「$($seedReading.archive)」、读到第 $($seedReading.readingPage) 页"
}

# ---- 洗过的环境 -------------------------------------------------------------
function Get-CleanEnvironment([int] $port) {
    $env2 = @{}
    $env2['SystemRoot'] = $env:SystemRoot
    $env2['windir'] = $env:SystemRoot
    $env2['ComSpec'] = $env:ComSpec
    $env2['PATHEXT'] = $env:PATHEXT
    $env2['PATH'] = "$env:SystemRoot\system32;$env:SystemRoot"
    $env2['TEMP'] = $env:TEMP
    $env2['TMP'] = $env:TMP
    $env2['USERPROFILE'] = $env:USERPROFILE
    $env2['LOCALAPPDATA'] = $env:LOCALAPPDATA
    $env2['APPDATA'] = $env:APPDATA
    $env2['NUMBER_OF_PROCESSORS'] = "$env:NUMBER_OF_PROCESSORS"
    $env2['PROCESSOR_ARCHITECTURE'] = $env:PROCESSOR_ARCHITECTURE
    $env2['WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS'] = "--remote-debugging-port=$port"
    return $env2
}

function Start-ColdProcess([hashtable] $env2) {
    $psi = [System.Diagnostics.ProcessStartInfo]::new()
    $psi.FileName = $exe
    $psi.WorkingDirectory = $app
    $psi.UseShellExecute = $false
    $psi.Environment.Clear()
    foreach ($key in $env2.Keys) { $psi.Environment[$key] = $env2[$key] }
    return [System.Diagnostics.Process]::Start($psi)
}

function Get-MainPage([int] $port, [int] $timeoutSec) {
    $deadline = (Get-Date).AddSeconds($timeoutSec)
    while ((Get-Date) -lt $deadline) {
        foreach ($hostName in @('127.0.0.1', '[::1]')) {
            $raw = & curl.exe -sS --max-time 2 "http://${hostName}:$port/json/list" 2>$null
            if ($LASTEXITCODE -ne 0 -or -not $raw) { continue }
            $list = $null
            try { $list = $raw | ConvertFrom-Json } catch { continue }
            # 两扇窗刚起来时**都还是 about:blank**：那时只看「不是托盘菜单」会把托盘
            # 那一页当主窗接上（2026-10-08 实测：探针挂在托盘页上等满 60 秒，日志
            # 写着「主窗起来了：about:blank」，其实是接错了）。所以要求它已经落在
            # 自己的页面上（http…）且不是托盘菜单，等不到就继续等。
            $page = @($list) | Where-Object { $_.type -eq 'page' -and $_.url -like 'http*' -and $_.url -notlike '*tray-menu*' } | Select-Object -First 1
            if ($page) { return $page }
        }
        Start-Sleep -Milliseconds 500
    }
    return $null
}

function Stop-ColdProcesses([int] $port) {
    # 只杀**这一份拷贝**里的进程：可执行文件路径或命令行里带着临时根目录/端口才算数。
    # 用户的实例不在这个根下面，怎么都不会被碰。
    $targets = @()
    foreach ($process in @(Get-Process -Name 'yomika', 'yomika-compute-worker' -ErrorAction SilentlyContinue)) {
        try {
            if ($process.Path -and $process.Path.StartsWith($app, [System.StringComparison]::OrdinalIgnoreCase)) { $targets += $process.Id }
        } catch { }
    }
    foreach ($process in @(Get-CimInstance Win32_Process -Filter "Name = 'msedgewebview2.exe'" -ErrorAction SilentlyContinue)) {
        if ($process.CommandLine -and ($process.CommandLine -like "*$root*" -or $process.CommandLine -like "*$port*")) { $targets += [int]$process.ProcessId }
    }
    foreach ($id in ($targets | Select-Object -Unique)) {
        try { Stop-Process -Id $id -Force -ErrorAction Stop } catch { }
    }
    Start-Sleep -Milliseconds 800
}

function Get-DataFiles {
    $dataDir = Join-Path $app 'data'
    if (-not (Test-Path -LiteralPath $dataDir)) { return @() }
    return @(Get-ChildItem -LiteralPath $dataDir -Recurse -File -ErrorAction SilentlyContinue |
        ForEach-Object { $_.FullName.Substring($dataDir.Length).TrimStart('\') })
}

function Invoke-Round([int] $index, [int] $port) {
    $env2 = Get-CleanEnvironment $port
    $logPath = Join-Path $Out "cold-$stamp-run$index.log"
    $probeOut = Join-Path $Out "cold-$stamp-run$index.json"
    $process = Start-ColdProcess $env2
    Say "== 第 $index 跑：pid $($process.Id)，调试端口 $port"
    $page = Get-MainPage $port $TimeoutSec
    if (-not $page) {
        Note "run${index}-window" $false "等了 ${TimeoutSec} 秒也没等到主窗的调试端口（进程 $(if ($process.HasExited) { '已经退出' } else { '还活着' })）"
        Stop-ColdProcesses $port
        return $null
    }
    $probeArgs = @(
        (Join-Path $repo '.github\scripts\cold-start-probe.mjs'),
        '--ws', $page.webSocketDebuggerUrl,
        # 也把端口给它：列表里那一条 url 是快照，连上去时可能已经换了文档，
        # 探针要能自己重新挑一页（2026-10-08 实测：列表说 tauri.localhost，
        # 连上去 `location.href` 是 about:blank）。
        '--port', "$port",
        '--out', $probeOut,
        '--expect', $Expect,
        '--nav', '设置'
    )
    if ($Needle) { $probeArgs += @('--needle', $Needle) }
    & node @probeArgs *>&1 | Tee-Object -FilePath $logPath | Out-Null
    $probeExit = $LASTEXITCODE
    $reading = $null
    if (Test-Path -LiteralPath $probeOut) { $reading = Get-Content -LiteralPath $probeOut -Raw | ConvertFrom-Json }
    Note "run${index}-window" $true "主窗起来了：$($page.url)"
    Note "run${index}-probe" ($probeExit -eq 0) ("探针 exit=$probeExit；界面 $(if ($reading) { $reading.checks.uiReady } else { '没写出读数' })、算力那一栏 $(if ($reading -and $reading.worker) { $reading.worker.kind } else { '没读到' })、导航 $(if ($reading) { $reading.checks.navigationWorks } else { '没写出读数' })$(if ($reading -and $reading.failure) { "；半路出错：$($reading.failure)" })")
    if ($reading -and $reading.worker) {
        Note "run${index}-worker-expectation" ($reading.checks.workerMatchesExpectation -eq $true) ("期望 $Expect，读到 $(($reading.worker.history) -join ' → ')；理由：$(if ($reading.worker.reason) { $reading.worker.reason } else { '（没有理由，不是 broken）' })")
        # 交出去的那件活**必须走到一个如实的结论**，不许一直躺在排队里：算力这一栏
        # 坏了可以是 `COMPUTE_WORKER_UNAVAILABLE`（worker 不在），算力这一栏好好的
        # 就是 `COMPUTE_INPUT_INVALID`（合成提交没有源图，被如实拒掉）。
        # 这条也顺带钉住「读数里那个终态是个名字，不是一坨对象」——2026-10-08 之前
        # 探针把 `JobState` 的带数据变体当成字符串比，于是永远读不到结论。
        $jobState = "$($reading.worker.jobState)"
        $jobCode = "$($reading.worker.jobCode)"
        $wantedCodes = @('COMPUTE_INPUT_INVALID', 'COMPUTE_WORKER_UNAVAILABLE')
        Note "run${index}-job-conclusion" ($jobState -eq 'failed' -and $wantedCodes -contains $jobCode) "交的那件活：状态 $jobState、码 $jobCode"
    }
    Start-Sleep -Milliseconds 500
    $dbPath = Join-Path $app 'data\yomika.sqlite3'
    Note "run${index}-database" (Test-Path -LiteralPath $dbPath) "data/yomika.sqlite3 $(if (Test-Path -LiteralPath $dbPath) { "在，$((Get-Item -LiteralPath $dbPath).Length) 字节" } else { '不在' })"
    if ($SeedLegacy) {
        # 升级前那一份要真的留在旁边，而且里面还是升级前那一档 —— 「回退可恢复」靠的就是它。
        $backupPath = Join-Path $app 'data\yomika.sqlite3.pre-v10.bak'
        $backupReading = Get-LegacyReading $backupPath
        Note "run${index}-seed-backup" ([bool] ($backupReading -and $backupReading.version -eq 10 -and $backupReading.archive -and $backupReading.setting)) "升级前的备份$(if ($backupReading) { "在：档位 $($backupReading.version)、档案「$($backupReading.archive)」、读到第 $($backupReading.readingPage) 页、设置 $($backupReading.setting)" } else { "不在：$backupPath" })"
        # 主库要升到这一版的档位，那些行要原样还在，后面几档才有的列/表也得出现
        # （列在、行在，才说明这个库真的被迁移过，而不是原样放着）。
        # 档位跟着最新迁移走：从 migrations/ 里取最大的编号，再加迁移就不用改这里。
        $expectedVersion = (Get-ChildItem -LiteralPath (Join-Path $repo 'src-tauri\migrations') -Filter '*.sql' |
            ForEach-Object { [int](($_.Name -split '_')[0]) } | Measure-Object -Maximum).Maximum
        $upgraded = Get-LegacyReading $dbPath
        Note "run${index}-seed-upgraded" ([bool] ($upgraded -and $upgraded.version -eq $expectedVersion -and $upgraded.archive -eq '这台机器上原来就有的档案' -and $upgraded.readingPage -eq 7 -and $upgraded.setting -eq '{"left_over":"这台机器上原来就有"}' -and $upgraded.addedAtColumn -eq 1 -and $upgraded.localArchivesTable -eq 1)) "升完：档位 $(if ($upgraded) { $upgraded.version } else { '读不到' })、档案「$(if ($upgraded) { $upgraded.archive } else { '' })」、读到第 $(if ($upgraded) { $upgraded.readingPage } else { '' }) 页、后加的列/表 $(if ($upgraded) { "$($upgraded.addedAtColumn)/$($upgraded.localArchivesTable)" } else { '' })、设置 $(if ($upgraded) { $upgraded.setting } else { '' })"
        $markerNow = if (Test-Path -LiteralPath $seedMarkerPath) { Get-Content -LiteralPath $seedMarkerPath -Raw } else { $null }
        Note "run${index}-seed-marker" ($markerNow -eq $seedMarkerText) "data/notes-from-the-old-machine.txt $(if ($markerNow -eq $seedMarkerText) { '一字没动' } else { '被动过或者没了' })"
    }
    $crash = Join-Path $app 'data\crash.log'
    $crashBytes = 0
    if (Test-Path -LiteralPath $crash) { $crashBytes = (Get-Item -LiteralPath $crash).Length }
    Note "run${index}-no-crash-log" ($crashBytes -eq 0) "data/crash.log $(if ($crashBytes -eq 0) { '空' } else { "$crashBytes 字节" })"
    $logDir = Join-Path $app 'data\logs'
    $errorLog = Join-Path $app 'data\error.log'
    $errorBytes = 0
    if (Test-Path -LiteralPath $errorLog) { $errorBytes = (Get-Item -LiteralPath $errorLog).Length }
    Note "run${index}-error-log" $true "data/error.log $errorBytes 字节$(if (Test-Path -LiteralPath $logDir) { '（另有 logs/）' } else { '' })"
    Stop-ColdProcesses $port
    $leftover = @(Get-Process -Name 'yomika', 'yomika-compute-worker' -ErrorAction SilentlyContinue |
        Where-Object { $_.Path -and $_.Path.StartsWith($app, [System.StringComparison]::OrdinalIgnoreCase) })
    Note "run${index}-processes-gone" ($leftover.Count -eq 0) "关掉之后这一份拷贝里还剩 $($leftover.Count) 个进程（关不干净会留下孤儿）"
    return $reading
}

if ($Port -eq 0) {
    $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
    $listener.Start()
    $Port = ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port
    $listener.Stop()
}

$dataBefore = Get-DataFiles
$readings = @()
for ($index = 1; $index -le [Math]::Max(1, $Runs); $index += 1) {
    $readings += [ordered]@{ run = $index; reading = (Invoke-Round $index $Port) }
}
if ($Runs -ge 2) {
    $dataAfter = Get-DataFiles
    $lost = @($dataBefore | Where-Object { $_ -notin $dataAfter })
    Note 'data-survives' ($lost.Count -eq 0) ("第二跑之后第一跑的 data/ 文件少了 $($lost.Count) 个$(if ($lost.Count) { "：$($lost -join '、')" })")
}

$report = [ordered]@{
    stamp           = $stamp
    repo            = $repo
    package         = $packagePath
    expect          = $Expect
    needle          = $Needle
    breakPayload    = [bool] $BreakPayload
    swapHost        = $SwapHost
    seedLegacy      = [bool] $SeedLegacy
    runs            = [Math]::Max(1, $Runs)
    port            = $Port
    root            = $root
    inventory       = $inventory
    modelFiles      = $modelFiles.Count
    readings        = @($readings | ForEach-Object { $_.reading })
    results         = $results.ToArray()
    bad             = $script:bad
}
$jsonPath = Join-Path $Out "cold-start-$stamp.json"
$report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $jsonPath -Encoding utf8

$lines = New-Object System.Collections.ArrayList
[void]$lines.Add("# 冷启动自检（$stamp）")
[void]$lines.Add('')
[void]$lines.Add("- 包：``$packagePath``")
[void]$lines.Add("- 摆出来的位置：``$app``（调试端口 $Port）")
# 这一行原来把「理由里要有 `xxx`」直接写成嵌套引号里的字符串：PowerShell 对
# `$( … "…``$X``…" … )` 这种「嵌套引号里再放转义反引号」的解析会当场判成
# 「字符串缺少终止符」。先拼好再塞进去，读起来也更清楚。
$expectDetail = "- 期望：``$Expect``"
if ($Needle) { $expectDetail = $expectDetail + "；理由里要有 ``$Needle``" }
[void]$lines.Add("$expectDetail；跑了 $([Math]::Max(1, $Runs)) 遍")
if ($SeedLegacy) {
    [void]$lines.Add("- 旧机器上留下来的数据：``data/yomika.sqlite3``（第 10 档的夹具）与 ``data/notes-from-the-old-machine.txt``")
}
[void]$lines.Add('')
[void]$lines.Add('| 项 | 结果 | 细节 |')
[void]$lines.Add('| --- | --- | --- |')
foreach ($row in $results) {
    [void]$lines.Add("| ``$($row.name)`` | $(if ($row.ok) { 'ok' } else { '**BAD**' }) | $($row.detail -replace '\|', '\|') |")
}
[void]$lines.Add('')
foreach ($entry in $readings) {
    $reading = $entry.reading
    if ($null -eq $reading) {
        [void]$lines.Add("## 第 $($entry.run) 跑：没写出读数（见上面那一行 BAD）")
        [void]$lines.Add('')
        continue
    }
    [void]$lines.Add("## 第 $($entry.run) 跑：算力那一栏读到的")
    [void]$lines.Add('')
    [void]$lines.Add("- 目标页：``$($reading.target.url)``")
    [void]$lines.Add("- 状态轨迹：$(($reading.worker.history) -join ' → ')")
    [void]$lines.Add("- 理由：$(if ($reading.worker.reason) { $reading.worker.reason } else { '（不是 broken）' })")
    [void]$lines.Add("- 合成提交：$($reading.worker.submitted | ConvertTo-Json -Depth 6 -Compress)")
    [void]$lines.Add("- 那件任务的结论：$($reading.worker.jobState) $(if ($reading.worker.jobCode) { "（$($reading.worker.jobCode)）" })")
    [void]$lines.Add("- 导航：从 ``$($reading.navigation.before)`` 到 ``$($reading.navigation.pathname)``，成没成：$($reading.navigation.done)")
    [void]$lines.Add('')
}
[void]$lines.Add("读数：``$jsonPath``")
[void]$lines.Add('')
$summaryPath = Join-Path $Out "cold-start-$stamp.md"
$lines -join "`r`n" | Set-Content -LiteralPath $summaryPath -Encoding utf8

if (-not $Keep) { Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue }
Say ''
if ($script:bad -eq 0) {
    Say "冷启动自检通过：$(($results | Where-Object { $_.ok }).Count) 项。"
    exit 0
}
Say "冷启动自检不通过：$($script:bad) 项不对。读数在 $jsonPath"
exit 1
