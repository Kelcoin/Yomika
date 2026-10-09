# 发布清单：把这个包「是什么、装了哪几样、怎么核对」写成机器可读的一份 + 给人看的一份。
#
# 为什么单独一份：Task 10 要「文档/运行命令/工件hash/许可证/已知限制」（docs/71:666）。
# 工件 hash 写在 CI 的 step summary 里，那是一次性的、翻不回来的；清单落进 artifacts/，
# 谁下载了包都能拿它对一遍。清单里不写「应该有什么」——只写**从包里读出来的**：
# 逐文件 sha256、随包模型的 id/版本/哈希、两份可执行文件的构建戳、协议大版本。
#
# 用法：
#   pwsh -NoProfile -File .github/scripts/release-manifest.ps1 -Package <目录|zip>
#        [-Out <json>] [-Platform windows-x64] [-KnownLimits docs/14-release-and-operations.md]
# 退出码：0 = 写出清单；1 = 包里缺了该有的东西（缺了就写不出诚实的清单）。
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string] $Package,
    [string] $Out = '',
    [string] $Platform = 'windows-x64',
    [string] $KnownLimits = 'docs/14-release-and-operations.md',
    [string] $ColdStartReport = '',
    [string] $ColdStartLegacyReport = '',
    [string] $Archive = ''
)

$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$packagePath = (Resolve-Path $Package).Path
if (-not $Out) { $Out = Join-Path (Split-Path -Parent $packagePath) 'release-manifest.json' }
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Out) | Out-Null

# 反引号在双引号串里是转义符，而**嵌在 `$( … )` 子表达式里的双引号串再放转义反引号
# 会当场判成「字符串缺少终止符」**（本轮实测：第 146/162 行，同样的东西不嵌套就没事）。
# 所以两个反引号一律在这里拼，调用处只写 `$(Quote $x)`。
function Quote([string] $text) { return '``' + $text + '``' }

# 包可能是一个目录（CI 里 stage 那一步摆出来的），也可能已经是 zip。zip 时先摊到
# 一个临时目录里读——清单要读的是**里面**的逐文件哈希，不是压缩包自己的哈希。
$temp = $null
$content = $packagePath
if (Test-Path -LiteralPath $packagePath -PathType Leaf) {
    $temp = Join-Path $env:TEMP ("yomika-manifest-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
    Expand-Archive -LiteralPath $packagePath -DestinationPath $temp -Force
    $content = $temp
}

function Get-FileEntry([string] $base, [string] $relative) {
    $path = Join-Path $base $relative
    if (-not (Test-Path -LiteralPath $path)) { return $null }
    $item = Get-Item -LiteralPath $path
    return [ordered]@{
        name    = $relative.Replace('\', '/')
        bytes   = $item.Length
        sha256  = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLower()
        modified = $item.LastWriteTime.ToString('yyyy-MM-dd HH:mm:ss')
    }
}

$required = @('yomika.exe', 'DirectML.dll')
$missing = @()
foreach ($name in $required) { if (-not (Test-Path -LiteralPath (Join-Path $content $name))) { $missing += $name } }
if ($missing.Count -gt 0) {
    Write-Host "[BAD] 包里缺了该有的东西：$($missing -join '、')"
    if ($temp) { Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue }
    exit 1
}

$files = @()
foreach ($entry in Get-ChildItem -LiteralPath $content -Recurse -File | Sort-Object FullName) {
    $relative = $entry.FullName.Substring($content.Length).TrimStart('\')
    $files += [ordered]@{
        name    = $relative.Replace('\', '/')
        bytes   = $entry.Length
        sha256  = (Get-FileHash -LiteralPath $entry.FullName -Algorithm SHA256).Hash.ToLower()
    }
}

# 随包模型：`data/models/<id>/<version>/yomika-model.json` 是它自己的身份，
# 清单照抄，不替它算一个「应该是多少」。
$models = @()
foreach ($descriptor in @(Get-ChildItem -LiteralPath (Join-Path $content 'data\models') -Recurse -File -Filter 'yomika-model.json' -ErrorAction SilentlyContinue)) {
    $meta = Get-Content -LiteralPath $descriptor.FullName -Raw | ConvertFrom-Json
    $modelFile = Join-Path $descriptor.DirectoryName 'model.onnx'
    $models += [ordered]@{
        id       = $meta.id
        version  = $meta.version
        format   = $meta.format
        scale    = $meta.scale
        declaredSha256 = $meta.sha256
        path     = $modelFile.Substring($content.Length).TrimStart('\').Replace('\', '/')
        bytes    = (Get-Item -LiteralPath $modelFile).Length
        sha256   = (Get-FileHash -LiteralPath $modelFile -Algorithm SHA256).Hash.ToLower()
        matches  = ((Get-FileHash -LiteralPath $modelFile -Algorithm SHA256).Hash.ToLower() -eq "$($meta.sha256)")
    }
}

# 构建戳：不自己扫字节猜，直接问那个已经写好判据的脚本。worker 现在**在主 exe 里**
# （交付只有一个文件），所以要先把载荷解出来写成临时文件，再拿同一个脚本去验它——
# 解出来的那一份必须与主 exe 同源，否则 10-a 的握手会拒跑。
$commit = ''
try { $commit = (& git -C $repo rev-parse --short=12 HEAD).Trim() } catch { }
$stampScript = Join-Path $PSScriptRoot 'verify-build-stamp.ps1'
. (Join-Path $PSScriptRoot 'worker-payload.ps1')
$stamps = [ordered]@{ commit = $commit; main = $false; worker = $false }
try {
    $null = & $stampScript -Path (Join-Path $content 'yomika.exe') -Commit $commit 2>&1
    $stamps['main'] = $true
} catch { $stamps['main'] = $false }
$payloadInfo = $null
$reading = Read-WorkerPayload -HostExe (Join-Path $content 'yomika.exe')
if ($reading.Ok) {
    $scratch = Join-Path $env:TEMP ("yomika-manifest-worker-" + [guid]::NewGuid().ToString('N').Substring(0, 8) + '.exe')
    try {
        [System.IO.File]::WriteAllBytes($scratch, $reading.Bytes)
        # 那个脚本对不上就 throw，所以「有没有抛」才是判据；`$LASTEXITCODE` 是上一条
        # 本机命令留下的数，拿它当结论会把两种现场读成一样。
        try {
            $null = & $stampScript -Path $scratch -Commit $commit 2>&1
            $stamps['worker'] = $true
        } catch { $stamps['worker'] = $false }
    } finally {
        Remove-Item -LiteralPath $scratch -Force -ErrorAction SilentlyContinue
    }
    $payloadInfo = [ordered]@{
        where  = 'embedded in yomika.exe'
        bytes  = $reading.Bytes.Length
        sha256 = $reading.Digest
        stamp  = $stamps['worker']
    }
}

$version = '1.0.0'
$tauriConf = Join-Path $repo 'src-tauri\tauri.conf.json'
if (Test-Path -LiteralPath $tauriConf) { $version = (Get-Content -LiteralPath $tauriConf -Raw | ConvertFrom-Json).version }
$protocolMajor = 0
$protocolSource = Join-Path $repo 'src-tauri\crates\compute-protocol\src\messages.rs'
if (Test-Path -LiteralPath $protocolSource) {
    $match = [regex]::Match([System.IO.File]::ReadAllText($protocolSource), 'PROTOCOL_MAJOR:\s*u32\s*=\s*(\d+)')
    if ($match.Success) { $protocolMajor = [int]$match.Groups[1].Value }
}

$licensed = @($files | Where-Object { $_.name -match '(?i)license' } | ForEach-Object { $_.name })
$coldStart = $null
if ($ColdStartReport -and (Test-Path -LiteralPath $ColdStartReport)) {
    $coldStart = (Get-Content -LiteralPath $ColdStartReport -Raw | ConvertFrom-Json)
}
$coldStartLegacy = $null
if ($ColdStartLegacyReport -and (Test-Path -LiteralPath $ColdStartLegacyReport)) {
    $coldStartLegacy = (Get-Content -LiteralPath $ColdStartLegacyReport -Raw | ConvertFrom-Json)
}
# 交付的**是一个 zip**（不是这棵 stage 目录）：那就把压缩包自己的字节数与 sha256 也记下来。
# 以前这里给的是 stage 目录，于是 `package.zip` 恒为空串，谁拿到清单都得回 CI 的日志里翻。
$archiveInfo = $null
if ($Archive -and (Test-Path -LiteralPath $Archive -PathType Leaf)) {
    $archiveItem = Get-Item -LiteralPath $Archive
    $archiveInfo = [ordered]@{
        path   = $archiveItem.FullName
        bytes  = $archiveItem.Length
        sha256 = (Get-FileHash -LiteralPath $archiveItem.FullName -Algorithm SHA256).Hash.ToLower()
    }
}

$manifest = [ordered]@{
    product       = 'Yomika'
    version       = $version
    commit        = $commit
    platform      = $Platform
    protocolMajor = $protocolMajor
    buildStamps   = $stamps
    generatedAt   = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
    package       = [ordered]@{
        source  = $packagePath
        zip     = $(if ($archiveInfo) { $archiveInfo.sha256 } else { $(if (Test-Path -LiteralPath $packagePath -PathType Leaf) { (Get-FileHash -LiteralPath $packagePath -Algorithm SHA256).Hash.ToLower() } else { '' }) })
        archive = $archiveInfo
        files   = $files.Count
        bytes   = ($files | Measure-Object -Property bytes -Sum).Sum
    }
    required      = $required
    files         = $files
    workerPayload = $payloadInfo
    models        = $models
    licenses      = $licensed
    knownLimits   = $KnownLimits
    coldStart     = $coldStart
    coldStartLegacy = $coldStartLegacy
}

$manifest | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $Out -Encoding utf8
$mdPath = [System.IO.Path]::ChangeExtension($Out, '.md')
$lines = New-Object System.Collections.ArrayList
[void]$lines.Add("# 发布清单：Yomika $version（$Platform）")
[void]$lines.Add('')
[void]$lines.Add("- 构建：commit ``$commit``；构建戳 主 exe $(if ($stamps.main) { '对' } else { '**不对**' })、worker $(if ($stamps.worker) { '对' } else { '**不对**' })")
[void]$lines.Add("- 协议大版本：$protocolMajor")
if ($payloadInfo) {
    [void]$lines.Add("- 计算进程：**嵌在主 exe 里**（$($payloadInfo.bytes) 字节，解出来 sha256 ``$($payloadInfo.sha256)``；跑起来仍是独立进程）")
} else {
    [void]$lines.Add("- 计算进程：**主 exe 里没找到 worker 载荷**")
}
$zipNote = ''
if ($manifest.package.zip) { $zipNote = "；zip 的 sha256 " + (Quote $manifest.package.zip) }
if ($manifest.package.archive) {
    $zipNote = $zipNote + "（交付的 zip $(($manifest.package.archive.bytes / 1MB).ToString('0.0')) MiB）"
}
[void]$lines.Add("- 包：$($files.Count) 个文件，$([Math]::Round(($files | Measure-Object -Property bytes -Sum).Sum / 1MB, 1)) MiB$zipNote")
[void]$lines.Add('')
[void]$lines.Add('## 逐文件')
[void]$lines.Add('')
[void]$lines.Add('| 文件 | 字节 | sha256 |')
[void]$lines.Add('| --- | --- | --- |')
foreach ($file in $files) { [void]$lines.Add("| ``$($file.name)`` | $($file.bytes) | ``$($file.sha256)`` |") }
[void]$lines.Add('')
[void]$lines.Add('## 随包模型')
[void]$lines.Add('')
foreach ($model in $models) {
    [void]$lines.Add("- ``$($model.id)`` $($model.version)（$($model.format)，缩放 $($model.scale)）：$($model.bytes) 字节，sha256 ``$($model.sha256)``，与模型自己的 ``yomika-model.json`` $(if ($model.matches) { '一致' } else { '**对不上**' })")
}
[void]$lines.Add('')
[void]$lines.Add("## 许可证与已知限制")
[void]$lines.Add('')
$licenseText = '一个都没有'
if ($licensed.Count) { $licenseText = (@($licensed | ForEach-Object { Quote $_ }) -join '、') }
[void]$lines.Add("- 包内许可证文件：$licenseText")
[void]$lines.Add("- 仓库许可证：``LICENSE``（随源码，不随包）")
[void]$lines.Add("- 已知限制与运行命令：``$KnownLimits``")
if ($coldStart) {
    [void]$lines.Add('')
    [void]$lines.Add("## 冷启动自检")
    [void]$lines.Add('')
    [void]$lines.Add("- 期望 ``$($coldStart.expect)``，结果：$(if ($coldStart.bad -eq 0) { '全过' } else { "**$($coldStart.bad) 项不对**" })")
    foreach ($row in $coldStart.results) { [void]$lines.Add("- ``$($row.name)``：$(if ($row.ok) { 'ok' } else { '**BAD**' }) — $($row.detail)") }
}
if ($coldStartLegacy) {
    [void]$lines.Add('')
    [void]$lines.Add("## 冷启动自检（旧机器上留下来的数据）")
    [void]$lines.Add('')
    [void]$lines.Add("- 期望 ``$($coldStartLegacy.expect)``，结果：$(if ($coldStartLegacy.bad -eq 0) { '全过' } else { "**$($coldStartLegacy.bad) 项不对**" })")
    foreach ($row in $coldStartLegacy.results) { [void]$lines.Add("- ``$($row.name)``：$(if ($row.ok) { 'ok' } else { '**BAD**' }) — $($row.detail)") }
}
$lines -join "`r`n" | Set-Content -LiteralPath $mdPath -Encoding utf8
if ($temp) { Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue }

Write-Host "发布清单：$Out"
Write-Host "给人看的那一份：$mdPath"
Write-Host "逐文件 $($files.Count) 个；随包模型 $($models.Count) 个；构建戳 主 exe=$(if ($stamps.main) { 'ok' } else { 'BAD' }) worker=$(if ($stamps.worker) { 'ok' } else { 'BAD' })"
exit 0
