# 计算响应性与回收的读数入口（`docs/71` §12.5 点名要的那一个）。
#
# 它只做三件事，每件都留机器可读的凭据：
#   1. 把这一档该跑的套件**严格串行**跑一遍，每个命令的 exitcode 与 passed/failed/ignored
#      都记进 JSON（§12.5：「每个命令的 exitcode 与 passed/failed/ignored 都保存」）；
#   2. 跑 §12.4 的 soak（`--ignored`，页数由 `-Pages` 给），把每页的私有提交与峰值收进来
#      （读的是测试自己打的那一行 `SOAK_JSON`，不在这个脚本里重算一遍）；
#   3. 输出 `measure-<时间戳>.json` ＋ `summary.md`，并且**明确写出哪些门槛这一跑量不到**。
#
# 第 4 件事（`-UiProbe`）是 §12.3 那一档：CDP 连上正在跑的那份实例，用浏览器自己的输入管线派
# ≥100 次键鼠，量「输入到下一次呈现」「掉帧」「JS 长任务」「导航可见」，并把 §12.4 ⑤ 的
# renderer 那一份补上（`.github/scripts/compute-ui-probe.mjs` 是驱动）。为什么默认不跑：它要
# 一份带 `--remote-debugging-port` 的实例（dev 构建还要配 Vite），而且会真的动窗口、真的杀进程。
# 为什么不能省：界面的门槛没有代用品，写个估计值比不写更坏。
#
# 用法：
#   pwsh -File .github/scripts/measure-compute-responsiveness.ps1 -Backend cpu -Pages 32
#   pwsh -File .github/scripts/measure-compute-responsiveness.ps1 -Backend all -Label round47
#   pwsh -File .github/scripts/measure-compute-responsiveness.ps1 -SkipSuites -GpuSoak -Pages 12
#   pwsh -File .github/scripts/measure-compute-responsiveness.ps1 -SkipSuites -SkipSoak -Layers 1,3,5
#   pwsh -File .github/scripts/measure-compute-responsiveness.ps1 -SkipSuites -SkipSoak -UiProbe
#   pwsh -File .github/scripts/measure-compute-responsiveness.ps1 -SkipSuites -SkipSoak -UiProbe -UiKillWorker <pid>
#   pwsh -File .github/scripts/measure-compute-responsiveness.ps1 -SkipSuites -SkipSoak -UiProbe -DropFrames -UiKillWorker -1
#   pwsh -File .github/scripts/measure-compute-responsiveness.ps1 -SkipSuites -SkipSoak   # 只采机器信息
param(
  [ValidateSet('cpu', 'directml', 'dlssnr', 'all')] [string] $Backend = 'cpu',
  [string] $FixtureManifest = '',
  [string] $OutputDir = '',
  [string] $Label = 'measure',
  # 0 = 按档位缺省（cpu 32、其余 8）；§12.4 的两个档是 32 与 100。
  [int] $Pages = 0,
  # §12.4 ③ 的大页档（5MP/10MP/25MP，1/3/5 层那半句本机跑不到）：默认不跑，
  # 因为它要连着算好几分钟，而它量的是「预算门挡住了之后进程还在不在」，与 ② 不是同一件事。
  [int] $LargePages = 0,
  # §12.4 ⑤ 的真 GPU 档（DirectML 那条页级 soak）：默认不跑——它要独占一张显卡一段时间。
  # 显存那一栏不在脚本里重算：DXGI 的 CurrentUsage 在本机恒为 0（预算 31 419 MiB 读得出、
  # 用量读不出），所以这一档由 harness 侧的 nvidia-smi 在它前后各采一遍（并持续采），
  # 测试自己那一份进 GPU_SOAK_JSON。
  [switch] $GpuSoak,
  # §12.4 ②/③ 的「层」：产品里「层」就是 DLSSNR 的 passes（协议里的 `layers` 没有一处代码
  # 读它）。给一个或多个层数（-Layers 1,3,5 或 -Layers "1,3,5"），每档跑一次真 NGX 的 32 页
  # 私有提交 soak。**收成字符串自己切**：`pwsh -File … -Layers 1,3,5` 传进来的是「135」
  # （`-File` 那一侧的逗号会被吞掉），收成 `[int[]]` 就会把一个不存在的档跑成绿的。
  [string] $Layers = '',
  # §12.3 的真窗口档：CDP 连上正在跑的那份实例，用浏览器自己的输入管线派 ≥100 次键鼠，
  # 量「输入到下一次呈现」「掉帧」「JS 长任务」「导航可见」，并顺手采 renderer 那一份内存。
  # 默认不跑：它要求机器上有一份带 `--remote-debugging-port` 的实例（dev 构建还要配 Vite），
  # 而且会真的动窗口、真的杀进程。
  [switch] $UiProbe,
  # 主窗的 CDP 端口。一个进程里有两个 WebView2 环境，同一个端口会分别绑在 IPv4 与 IPv6 上：
  # 127.0.0.1 那一侧只出托盘菜单页，[::1] 那一侧才是主窗——挑法写在 Get-ComputeUiTarget 里。
  [int] $UiPort = 9333,
  # 'auto' = 让驱动自己进档案库取第一条档案，换成阅读器地址（列表布局会变，不靠卡片选择器）。
  [string] $UiReaderUrl = 'auto',
  # 这一档量的是**打包构建**（`http://tauri.localhost/`）。那边 import 不了 `/src/**`，所以驱动
  # 挑不出档案（必须点名 -UiReaderUrl），也改不了偏好（驱动收到 --no-quiet）——把偏好先关掉
  # 这件事就落在这份读数的前提里：跑在库的副本上，副本里本来就是关的。dev 那一档（Vite）不用它。
  [switch] $UiBundled,
  # §12.3 要求至少 100 次键盘/指针操作。
  [int] $UiInputs = 120,
  # 导航要采几次。§12.3 的门槛是 p95，一次的印象不算数。
  [int] $UiNavigations = 3,
  # 点名要杀的计算进程号；给了就在跑完输入之后再量一次「UI 还动不动、多久给状态」。
  # **-1** = 让驱动自己去问应用「这一代 worker 是谁」再杀（只有压机器那一趟才有），要同时带 -DropFrames。
  [int] $UiKillWorker = 0,
  # §12.3 「对同场景空载，重载渲染掉帧比例增加 ≤ 5 个百分点」：跑两趟——先空载一趟，再把同一串
  # 输入在「同一份构建、同一个页面」上跑一遍，同时用应用自己的路（`compute_submit_reader_page`）
  # 提交一批重任务。两趟的掉帧比例之差就是那个数。默认不跑：它要活实例，还要真的算几十秒。
  [switch] $DropFrames,
  # 压机器那一趟提交多少件重任务（默认 24：CPU 档一页约 1.5 秒，够把输入那 20 秒压满）。
  [int] $UiLoadPages = 24,
  [switch] $SkipSuites,
  [switch] $SkipSoak
)

$ErrorActionPreference = 'Continue'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
Set-Location $root
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
if (-not $OutputDir) { $OutputDir = Join-Path $root "debug_outputs\measure\$stamp" }
if (-not [System.IO.Path]::IsPathRooted($OutputDir)) { $OutputDir = Join-Path $root $OutputDir }
New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null
$manifest = 'src-tauri\Cargo.toml'
# 2026-10-18：原来指 debug_outputs\cargo-target（与开发构建各一份 50 GB 级 debug 产物），
# 现在与整轮、开发构建共用 src-tauri\target —— 下面的 targetDir 读的就是这个变量。
$env:CARGO_TARGET_DIR = Join-Path $root 'src-tauri\target'

if (-not $FixtureManifest) {
  # 这里只要一份「这一跑用的是哪套素材」的指纹（下一行把它哈希进报告），不读里面的内容。
  # 默认值原来指着 `resources/models/models-v1.manifest.json`——那是去码包（Aletheia-Lens）
  # 的清单，2026-10-14 随去码整条链路一起删了，于是改成同样随包、而且还会长期存在的那份
  # DLSSNR 变体清单。
  $FixtureManifest = Join-Path $root 'src-tauri\resources\dlssnr\dlssnr-manifest.json'
}
if (-not (Test-Path $FixtureManifest)) { throw "素材清单不在：$FixtureManifest" }
$fixtureHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $FixtureManifest).Hash

if (-not $Pages) { $Pages = if ($Backend -eq 'cpu') { 32 } else { 8 } }

# 层数那一栏收成数组的地方只有这里；给得不对就当场报错，不许悄悄跑成别的档。
$layerTiers = @()
if ($Layers) {
  foreach ($piece in ($Layers -split ',')) {
    $trimmed = $piece.Trim()
    if (-not $trimmed) { continue }
    $value = 0
    if (-not [int]::TryParse($trimmed, [ref] $value) -or $value -lt 1 -or $value -gt 8) {
      throw "层数给得不对（只认 1..8）：$trimmed"
    }
    $layerTiers += $value
  }
  if ($layerTiers.Count -eq 0) { throw "给了 -Layers 却一个层数都没认出来：$Layers" }
}

# 这一跑必须安静：别人也在开模型的话，量出来的是别人的账。
$noisy = @(Get-Process -Name yomika, yomika-compute-worker -ErrorAction SilentlyContinue)
if ($noisy.Count -gt 0) {
  Write-Host "[warn] 现在有 $($noisy.Count) 个 yomika/worker 进程在跑——读数会混进别人的账"
}

# 整卡用量（厂商工具那一栏）。DXGI 的 CurrentUsage 在本机恒为 0，而整卡真的在动：12 页 DML
# 期间 nvidia-smi 记到整卡用了 5873–6256 MiB、util 有到 8% 的尖峰。这一栏是 harness 侧对
# 「GPU 预算」唯一量得到的数。量不到就返回 $null——不知道不是 0。
function Get-GpuUsedMib {
  $row = & nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits 2>$null | Select-Object -First 1
  if (-not $row) { return $null }
  return [double]$row
}

function Get-Machine {
  $cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
  $os = Get-CimInstance Win32_OperatingSystem
  $gpu = @()
  $nvidia = & nvidia-smi --query-gpu=name,driver_version,memory.total --format=csv,noheader 2>$null
  foreach ($line in @($nvidia)) { if ($line) { $gpu += $line.Trim() } }
  return [ordered]@{
    os        = "$($os.Caption) $($os.Version)"
    cpu       = "$($cpu.Name) $($cpu.NumberOfCores)C/$($cpu.NumberOfLogicalProcessors)T"
    ramGiB    = [math]::Round($os.TotalVisibleMemorySize / 1048576, 1)
    gpu       = $gpu
    rustc     = (& rustc --version 2>$null)
    node      = (& node --version 2>$null)
    head      = (& git rev-parse HEAD 2>$null)
    targetDir = $env:CARGO_TARGET_DIR
  }
}

# 主窗的 CDP 地址。这两步缺一不可：
#   1. 一个 yomika 进程里有两个 WebView2 环境（主窗设了 data_directory、托盘菜单没设），
#      同一个 `--remote-debugging-port` 会分别绑在 IPv4 与 IPv6 上；
#   2. `127.0.0.1` 那一侧只出 `/tray-menu.html`，主窗在 `[::1]` 那一侧。
# 所以两个地址都问、按「不是托盘那一页」挑。挑不到就直接红——§12.3 的每一个数都要真窗口。
function Get-ComputeUiTarget([int] $Port) {
  $found = @()
  foreach ($host_ in @('127.0.0.1', '[::1]')) {
    $body = & curl.exe -sS --max-time 5 "http://$host_`:$Port/json/list" 2>$null
    if (-not $body) { continue }
    foreach ($entry in @($body | ConvertFrom-Json)) {
      if ($entry.type -ne 'page') { continue }
      if ($entry.url -like '*tray-menu*') { continue }
      $found += $entry
    }
  }
  if ($found.Count -eq 0) {
    throw "没找到主窗的 CDP 地址（http://[::1]:$Port/json/list）。要在实例上设 WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=$Port 再启动。"
  }
  return $found[0]
}

# renderer 那一份私有提交（§12.4 ⑤）。本机量得到的只有「这台机器上所有 msedgewebview2 进程
# 的私有字节之和」——它把两个 WebView2 环境都算进来了，这是这一栏已知的重复计数限制；
# 逐进程归属要 ETW/GPUView，归 9-f 之后。量不到就返回 $null：不知道不是 0。
function Get-RendererCommitMib {
  $rows = Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" -ErrorAction SilentlyContinue
  if (-not $rows) { return $null }
  $sum = ($rows | Measure-Object -Property PrivatePageCount -Sum).Sum
  if (-not $sum) { return $null }
  return [math]::Round($sum / 1MB, 1)
}

# 按进程名采私有提交（host/worker 两个名字都走这里）。同一份进程数不出来就返回 $null。
function Get-ProcessCommitMib([string] $Name) {
  $rows = Get-CimInstance Win32_Process -Filter "Name='$Name'" -ErrorAction SilentlyContinue
  if (-not $rows) { return $null }
  $sum = ($rows | Measure-Object -Property PrivatePageCount -Sum).Sum
  if (-not $sum) { return $null }
  return [math]::Round($sum / 1MB, 1)
}

# 一个命令的读数：exitcode ＋ 日志里的 passed/failed/ignored。
function Invoke-Measured([string] $name, [scriptblock] $body, [string] $expect) {
  $log = Join-Path $OutputDir "$name.log"
  Write-Host "== $name"
  $started = Get-Date
  & $body 2>&1 | Tee-Object -FilePath $log | Out-Null
  $code = $LASTEXITCODE
  $seconds = [math]::Round(((Get-Date) - $started).TotalSeconds, 2)
  $text = if (Test-Path $log) { Get-Content -LiteralPath $log -Raw } else { '' }

  $passed = 0; $failed = 0; $ignored = 0
  foreach ($match in [regex]::Matches($text, 'test result: \w+\. (\d+) passed; (\d+) failed; (\d+) ignored')) {
    $passed += [int]$match.Groups[1].Value
    $failed += [int]$match.Groups[2].Value
    $ignored += [int]$match.Groups[3].Value
  }
  if ($text -match 'Tests\s+(\d+) passed') { $passed += [int]$Matches[1] }
  if ($text -match 'Tests\s+(\d+) failed') { $failed += [int]$Matches[1] }

  # 「绿」不只是 exit 0：那个日志里得有它该有的字样（与 verify-round.ps1 同一条规矩）。
  $evidence = switch ($expect) {
    'none' { $true }
    'vitest' {
      ($text -match 'Tests\s+[1-9]\d* passed') -and ($text -notmatch 'Tests\s+\d+ failed') -and
      ($text -notmatch 'Unhandled Error') -and ($text -notmatch 'Test Files\s+\d+ failed')
    }
    'cargo' { ($text -match 'test result: ok\. [1-9]\d* passed') -and ($text -notmatch 'test result: FAILED') }
    default { $true }
  }
  $green = ($code -eq 0) -and $evidence
  Write-Host ("   exit={0} evidence={1} {2}s passed={3} failed={4} ignored={5}" -f `
    $code, $(if ($evidence) { 'ok' } else { 'MISSING' }), $seconds, $passed, $failed, $ignored)
  return [ordered]@{
    name = $name; exitCode = $code; evidence = $evidence; green = $green
    seconds = $seconds; passed = $passed; failed = $failed; ignored = $ignored
    log = (Split-Path -Leaf $log)
  }
}

$commands = @()
if (-not $SkipSuites) {
  # §12.5 的「抽取后建议入口」在这个仓库里对应的真名字。名字对不上的地方按本仓库的
  # 真目标写，并且**不另造空测试文件**（`docs/71:748` 明说了不许那么干）。
  $commands += @{ name = 'typecheck'; expect = 'none'; body = { npx tsc -b --pretty false } }
  $commands += @{ name = 'vitest'; expect = 'vitest'; body = { npx vitest run --configLoader runner } }
  $commands += @{ name = 'check-ws'; expect = 'none'; body = { cargo check --manifest-path $manifest --workspace --all-targets } }
  $commands += @{ name = 'protocol'; expect = 'cargo'; body = { cargo test --manifest-path $manifest -p yomika-compute-protocol } }
  $commands += @{ name = 'worker'; expect = 'cargo'; body = { cargo test --manifest-path $manifest -p yomika-compute-worker } }
  $commands += @{ name = 'manager-it'; expect = 'cargo'; body = { cargo test --manifest-path $manifest --test compute_manager } }
  # §12.4 ⑥ 的 20 轮：它也是「一份读数」，所以进这张表，而不是只活在手工跑里。
  # 要 `--nocapture`：这条用例的证据是它自己打的「取消几次、强杀几次、熔断亮了几次」。
  $commands += @{ name = 'restart-it'; expect = 'cargo'; body = { cargo test --manifest-path $manifest --test compute_restart_storm -- --nocapture --test-threads=1 } }
  if ($Backend -in @('cpu', 'all')) {
    $commands += @{ name = 'core-cpu'; expect = 'cargo'; body = { cargo test --manifest-path $manifest -p yomika-compute-core --features cpu } }
    $commands += @{ name = 'chain-it'; expect = 'cargo'; body = { cargo test --manifest-path $manifest --test compute_model_chain } }
  }
  if ($Backend -in @('directml', 'all')) {
    $commands += @{ name = 'core-dml'; expect = 'cargo'; body = { cargo test --manifest-path $manifest -p yomika-compute-core --features directml } }
  }
  if ($Backend -in @('dlssnr', 'all')) {
    $commands += @{ name = 'core-dlssnr'; expect = 'cargo'; body = { cargo test --manifest-path $manifest -p yomika-compute-core --features dlssnr -- --nocapture } }
    $commands += @{ name = 'core-meta'; expect = 'cargo'; body = { cargo test --manifest-path $manifest -p yomika-compute-core --lib --test dlssnr_metadata } }
  }
}

$results = @()
foreach ($command in $commands) {
  $results += Invoke-Measured -name $command.name -body $command.body -expect $command.expect
}

# §12.4 的 soak：页数由调用方给，读数由测试自己打的那一行 `SOAK_JSON` 交出来。
$soak = $null
if (-not $SkipSoak) {
  $env:YOMIKA_SOAK_PAGES = "$Pages"
  $log = Join-Path $OutputDir 'soak.log'
  Write-Host "== soak（$Pages 页）"
  $started = Get-Date
  # `--exact`：这个文件里现在有两条 `#[ignore]` 用例（② 的小规格与 ③ 的大页档），
  # 光给 `--ignored` 会把两条都拖进来——几分钟的活，而且 `SOAK_JSON` 会有两行，
  # 下面那句 `Select-Object -Last 1` 就会读到隔壁那一条的读数。名字只能钉死一条。
  & cargo test --manifest-path $manifest --test compute_soak -- --ignored --nocapture --test-threads=1 --exact a_page_soak_shows_where_the_compute_process_memory_goes 2>&1 |
    Tee-Object -FilePath $log | Out-Null
  $code = $LASTEXITCODE
  $seconds = [math]::Round(((Get-Date) - $started).TotalSeconds, 2)
  $text = if (Test-Path $log) { Get-Content -LiteralPath $log -Raw } else { '' }
  $line = ($text -split "`n" | Where-Object { $_ -like 'SOAK_JSON *' } | Select-Object -Last 1)
  if (-not $line) { throw "soak 没打出 SOAK_JSON（exit=$code），读 $log" }
  $soak = $line.Substring('SOAK_JSON '.Length) | ConvertFrom-Json
  $soakGreen = ($code -eq 0) -and ($text -match 'test result: ok\. 1 passed')
  Write-Host ("   exit={0} evidence={1} {2}s 峰值 {3} MiB，涨 {4} MiB，交回掉 {5} MiB" -f `
    $code, $(if ($soakGreen) { 'ok' } else { 'MISSING' }), $seconds, $soak.peakMib, $soak.growthMib, $soak.handback.droppedMib)
  $soakResult = [ordered]@{
    name = 'soak'; exitCode = $code; green = $soakGreen; seconds = $seconds; pages = $Pages
    log = (Split-Path -Leaf $log); reading = $soak
  }
} else {
  $soakResult = [ordered]@{ name = 'soak'; skipped = $true }
}

# §12.4 ③ 的大页档：默认不跑（几分钟），由 `-LargePages` 点名。它量的是另一件事——
# 一页大到过不了预算门时，判决是不是那句 `resource_limit`、被拒之后这一代 worker 还在不在、
# 缓存里有没有留下半成品。层数那半句（1/3/5 层）本机跑不到，测试自己在读数里写明了原因。
$soakLarge = $null
if ($LargePages -gt 0) {
  # `-LargePages` 给的是**真算的页数**（每档 1 页热身 + 这么多页）；25 MP 那档固定 100 页
  # （§12.4 ③ 的原话），所以不设 `YOMIKA_SOAK_LARGE_PAGES`，用测试自己的缺省。
  $env:YOMIKA_SOAK_LARGE_REAL = "$LargePages"
  $log = Join-Path $OutputDir 'soak-large.log'
  Write-Host "== 大页 soak（真算那两档各 $LargePages 页，25MP 那档固定 100 页）"
  $started = Get-Date
  & cargo test --manifest-path $manifest --test compute_soak -- --ignored --nocapture --test-threads=1 --exact a_hundred_large_pages_complete_without_taking_the_process_down 2>&1 |
    Tee-Object -FilePath $log | Out-Null
  $code = $LASTEXITCODE
  $seconds = [math]::Round(((Get-Date) - $started).TotalSeconds, 2)
  $text = if (Test-Path $log) { Get-Content -LiteralPath $log -Raw } else { '' }
  $line = ($text -split "`n" | Where-Object { $_ -like 'SOAK_JSON *' } | Select-Object -Last 1)
  if (-not $line) { throw "大页 soak 没打出 SOAK_JSON（exit=$code），读 $log" }
  $soakLarge = $line.Substring('SOAK_JSON '.Length) | ConvertFrom-Json
  $largeGreen = ($code -eq 0) -and ($text -match 'test result: ok\. 1 passed')
  Write-Host ("   exit={0} evidence={1} {2}s 真算 {3} 页，被挡 {4} 页" -f `
    $code, $(if ($largeGreen) { 'ok' } else { 'MISSING' }), $seconds, $soakLarge.computedPages, $soakLarge.refusedPages)
  $soakLargeResult = [ordered]@{
    name = 'soak-large'; exitCode = $code; green = $largeGreen; seconds = $seconds
    realPages = $LargePages; log = (Split-Path -Leaf $log); reading = $soakLarge
  }
} else {
  $soakLargeResult = [ordered]@{ name = 'soak-large'; skipped = $true }
}

# §12.4 ⑤ 的真 GPU 档：一条 DirectML 的页级 soak，外加厂商工具在它前后与**持续**采的整卡用量。
# 为什么显存那一栏不写死门槛：DXGI 的 CurrentUsage 是整张卡的数（邻居也抬它），而且本机这一栏
# 恒为 0——把 0 当「没占显存」或者钉死一个数，都是在报告里编。这里只报数、写清哪一栏读得出。
$soakGpu = $null
if ($GpuSoak) {
  $log = Join-Path $OutputDir 'soak-gpu.log'
  $csv = Join-Path $OutputDir 'gpu-used.csv'
  Write-Host "== 真 GPU 档（DirectML，$Pages 页）"
  $env:YOMIKA_SOAK_PAGES = "$Pages"
  $before = Get-GpuUsedMib
  't,usedMib,util' | Set-Content -LiteralPath $csv -Encoding utf8
  $sampler = Start-Job -ScriptBlock {
    param($path)
    while ($true) {
      $row = & nvidia-smi --query-gpu=memory.used,utilization.gpu --format=csv,noheader,nounits 2>$null | Select-Object -First 1
      if ($row) { ('{0},{1}' -f (Get-Date).ToString('HH:mm:ss.fff'), ($row -replace '\s*,\s*', ',')) | Add-Content -LiteralPath $path }
      Start-Sleep -Milliseconds 250
    }
  } -ArgumentList $csv
  $started = Get-Date
  & cargo test --manifest-path $manifest --test compute_soak -- --ignored --nocapture --test-threads=1 --exact a_directml_page_soak_runs_on_the_gpu_and_keeps_its_vram_bounded 2>&1 |
    Tee-Object -FilePath $log | Out-Null
  $code = $LASTEXITCODE
  $seconds = [math]::Round(((Get-Date) - $started).TotalSeconds, 2)
  $after = Get-GpuUsedMib
  Stop-Job $sampler -ErrorAction SilentlyContinue
  Remove-Job $sampler -Force -ErrorAction SilentlyContinue
  $text = if (Test-Path $log) { Get-Content -LiteralPath $log -Raw } else { '' }
  $line = ($text -split "`n" | Where-Object { $_ -like 'GPU_SOAK_JSON *' } | Select-Object -Last 1)
  if (-not $line) { throw "GPU 档没打出 GPU_SOAK_JSON（exit=$code），读 $log" }
  $soakGpu = $line.Substring('GPU_SOAK_JSON '.Length) | ConvertFrom-Json
  $gpuGreen = ($code -eq 0) -and ($text -match 'test result: ok\. 1 passed')
  $used = @()
  if (Test-Path $csv) { $used = @(Import-Csv -LiteralPath $csv | ForEach-Object { [double]$_.usedMib }) }
  $duringMax = if ($used.Count -gt 0) { ($used | Measure-Object -Maximum).Maximum } else { $null }
  $duringMin = if ($used.Count -gt 0) { ($used | Measure-Object -Minimum).Minimum } else { $null }
  Write-Host ("   exit={0} evidence={1} {2}s 政策 {3}、回退 {4}；worker 提交 {5} MiB（涨 {6} MiB）" -f `
    $code, $(if ($gpuGreen) { 'ok' } else { 'MISSING' }), $seconds, $soakGpu.policy, `
    $(if ($null -eq $soakGpu.engineFallback) { '无' } else { $soakGpu.engineFallback }), $soakGpu.warmCommitMib, $soakGpu.growthMib)
  Write-Host ("   整卡用量（nvidia-smi，{0} 个样本）：开工前 {1} MiB、期间 {2}–{3} MiB、收摊后 {4} MiB" -f `
    $used.Count, $before, $duringMin, $duringMax, $after)
  $soakGpuResult = [ordered]@{
    name = 'soak-gpu'; exitCode = $code; green = $gpuGreen; seconds = $seconds; pages = $Pages
    log = (Split-Path -Leaf $log); reading = $soakGpu
    gpuUsedBeforeMib = $before; gpuUsedAfterMib = $after
    gpuUsedDuringMinMib = $duringMin; gpuUsedDuringMaxMib = $duringMax; gpuUsedSamples = $used.Count
    gpuUsedCsv = (Split-Path -Leaf $csv)
  }
} else {
  $soakGpuResult = [ordered]@{ name = 'soak-gpu'; skipped = $true }
}

# §12.4 ②/③ 的「层」：真 NGX、真 DLL，32 页一跑，逐档记私有提交的平台与交回后的回落。
# 为什么层数旋钮在核心的测试里而不是协议里：协议那个 `layers` 字段没有一处代码读它，
# 产品里「层」就是 DLSSNR 的 `settings.passes`。这一档量的是内存与层数的关系，不是产品行为。
$layersSweep = @()
if ($layerTiers.Count -gt 0) {
  Write-Host "== 层数档（$($layerTiers -join '/') 层，真 NGX）"
  foreach ($passes in $layerTiers) {
    $log = Join-Path $OutputDir "layers-$passes.log"
    $env:YOMIKA_DLSSNR_PASSES = "$passes"
    $started = Get-Date
    & cargo test --manifest-path $manifest -p yomika-compute-core --features dlssnr --lib -- --ignored --exact --nocapture dlssnr::tests::repeated_pages_keep_private_commit_bounded_and_release_workspaces 2>&1 |
      Tee-Object -FilePath $log | Out-Null
    $code = $LASTEXITCODE
    $seconds = [math]::Round(((Get-Date) - $started).TotalSeconds, 2)
    $text = if (Test-Path $log) { Get-Content -LiteralPath $log -Raw } else { '' }
    $line = ($text -split "`n" | Where-Object { $_ -like 'DLSSNR private commit: passes=*' } | Select-Object -Last 1)
    if (-not $line) { throw "层数档 $passes 没打出读数（exit=$code），读 $log" }
    $matched = [regex]::Match($line, 'passes=(\d+) warm=(\d+) MiB, after32=(\d+) MiB, released=(\d+) MiB')
    if (-not $matched.Success) { throw "层数档 $passes 的读数认不出来：$line" }
    $green = ($code -eq 0) -and ($text -match 'test result: ok\. 1 passed')
    $layersSweep += [ordered]@{
      passes = [int]$matched.Groups[1].Value; warmMib = [int]$matched.Groups[2].Value
      after32Mib = [int]$matched.Groups[3].Value; releasedMib = [int]$matched.Groups[4].Value
      green = $green; seconds = $seconds; log = (Split-Path -Leaf $log)
    }
    Write-Host ("   {0} 层：warm {1} MiB，32 页之后 {2} MiB，交回之后 {3} MiB（{4}s）" -f `
      $matched.Groups[1].Value, $matched.Groups[2].Value, $matched.Groups[3].Value, $matched.Groups[4].Value, $seconds)
  }
  Remove-Item Env:\YOMIKA_DLSSNR_PASSES -ErrorAction SilentlyContinue
}
$layersResult = [ordered]@{
  name = 'layers'; skipped = ($layerTiers.Count -eq 0); requested = @($layerTiers); rows = $layersSweep
  green = if ($layerTiers.Count -eq 0) { $null } else { (@($layersSweep | Where-Object { -not $_.green }).Count -eq 0) }
}

# §12.3 的真窗口档。读数由驱动的 `UI_PROBE_JSON` 交出来（脚本不在这里重算），驱动自己负责
# 「怎么连、怎么注入、怎么算」。这一档**必须真跑**：拿不到目标、拿不到读数就直接红——
# 界面的门槛没有代用品，写个估计值比不写更坏。
#
# 这一跑可以跑两趟（`-DropFrames`）：先空载一趟（机器上什么计算都没有），再把输入脚本
# 原样跑一遍、但同时在应用自己的那条路上提交一批重任务（`--load`），两趟的掉帧比例之差
# 就是「重载相对空载」那个数。**两趟必须是同一份构建、同一个页面、同一串输入**，否则
# 比出来的不是重载的账。
function Invoke-UiProbePass([string] $name, [int] $LoadPages, [int] $KillPid) {
  $json = Join-Path $OutputDir "ui-probe-$name.json"
  $log = Join-Path $OutputDir "ui-probe-$name.log"
  $arguments = @($driver, '--ws', $target.webSocketDebuggerUrl, '--out', $json, '--reader-url', $UiReaderUrl, '--inputs', "$UiInputs", '--navigations', "$UiNavigations")
  if ($LoadPages -gt 0) { $arguments += @('--load', "$LoadPages") }
  if ($KillPid -ne 0) { $arguments += @('--kill-worker', "$KillPid") }
  if ($UiBundled) { $arguments += @('--no-quiet') }
  $started = Get-Date
  & node @arguments 2>&1 | Tee-Object -FilePath $log | Out-Null
  $code = $LASTEXITCODE
  $seconds = [math]::Round(((Get-Date) - $started).TotalSeconds, 2)
  $text = Get-Content -LiteralPath $log -Raw -ErrorAction SilentlyContinue
  $line = ($text -split "`n" | Where-Object { $_ -like 'UI_PROBE_JSON *' } | Select-Object -Last 1)
  if (-not $line) { throw "UI 档（$name）没打出 UI_PROBE_JSON（exit=$code），读 $log" }
  $reading = $line.Substring('UI_PROBE_JSON '.Length) | ConvertFrom-Json
  # 空表守卫：§12.3 每一条都要有样本。少一条就当场红，别拿一张空表交差。
  if (-not $reading.inputs -or [int]$reading.inputs.total -lt $UiInputs) {
    throw "UI 档（$name）的输入样本不够（要 $UiInputs 条，读到 $($reading.inputs.total)）：$log"
  }
  if (-not $reading.navigation -or [int]$reading.navigation.count -lt 1) { throw "UI 档（$name）没有导航样本：$log" }
  if (-not $reading.frames -or [int]$reading.frames.count -lt 100) { throw "UI 档（$name）的帧样本太少：$log" }
  return [pscustomobject]@{ name = $name; exitCode = $code; seconds = $seconds; log = (Split-Path -Leaf $log); reading = $reading }
}

if ($UiProbe) {
  $target = Get-ComputeUiTarget -Port $UiPort
  Write-Host "== UI 档（CDP 端口 $UiPort，页面 $($target.url)）"
  $driver = Join-Path $root '.github\scripts\compute-ui-probe.mjs'
  if (-not (Test-Path $driver)) { throw "驱动不在：$driver" }
  if ($UiBundled -and $UiReaderUrl -eq 'auto') {
    throw "-UiBundled 量的是打包构建：那边 import 不了 /src/**，挑不出档案，必须点名 -UiReaderUrl"
  }
  if ($UiKillWorker -eq -1 -and -not $DropFrames) {
    throw "-UiKillWorker -1 是「杀掉压机器那一跑正在算的那个计算进程」，所以要同时带 -DropFrames"
  }
  $idle = Invoke-UiProbePass 'idle' 0 0
  $uiReading = $idle.reading
  $green = ($idle.exitCode -eq 0)
  # §12.4 ⑤ 的四栏。renderer 那一份是所有 msedgewebview2 进程之和（两个环境都算进来了），
  # 共享页会重复计数——这一栏的限制写在读数里，不假装它是一份干净的账。
  $uiMemory = [ordered]@{
    hostMib     = Get-ProcessCommitMib 'yomika.exe'
    workerMib   = Get-ProcessCommitMib 'yomika-compute-worker.exe'
    rendererMib = Get-RendererCommitMib
    gpuUsedMib  = Get-GpuUsedMib
    note        = 'renderer 是所有 msedgewebview2 进程私有字节之和（两个 WebView2 环境都在内，共享页重复计数）；GPU 那一栏是整张卡的用量，逐进程显存本机量不到（Task 0 记过计数器集为空）'
  }
  $sum = 0.0
  $counted = 0
  foreach ($key in @('hostMib', 'workerMib', 'rendererMib', 'gpuUsedMib')) {
    if ($uiMemory[$key] -ne $null) { $sum += [double]$uiMemory[$key]; $counted += 1 }
  }
  $uiMemory['totalMib'] = [math]::Round($sum, 1)
  $uiMemory['columnsCounted'] = $counted
  Write-Host ("   空载：导航 p50 {0} ms / p95 {1} ms（{2} 次）；输入 p95 {3} ms；掉帧 {4}/{5}；长任务 {6} 条（最长 {7} ms）" -f `
    $uiReading.navigation.p50Ms, $uiReading.navigation.p95Ms, $uiReading.navigation.count, `
    $uiReading.inputs.p95, $uiReading.frames.dropped, $uiReading.frames.count, `
    $uiReading.longTasks.count, $uiReading.longTasks.worstMs)
  Write-Host ("   总内存（host {0} ＋ worker {1} ＋ renderer {2} ＋ 整卡 {3} = {4} MiB，{5}/4 栏）" -f `
    $uiMemory.hostMib, $uiMemory.workerMib, $uiMemory.rendererMib, $uiMemory.gpuUsedMib, $uiMemory.totalMib, $uiMemory.columnsCounted)

  $framesDelta = $null
  $loaded = $null
  if ($DropFrames) {
    Write-Host "== UI 档：重载那一趟（同时在应用自己的路上提交 $UiLoadPages 件重任务）"
    # §12.4 ⑤ 的总内存要在**机器真被压着**的时候采：空载那一趟采的时候计算进程根本还没起来
    # （worker 那一栏是空的），拿那一次说「四栏的总内存」等于把最要紧的一栏漏掉。这一趟从起
    # 到收之间每 500 ms 采一行，结束后取峰值——峰值才是「重载时占了多少」。
    $samplerLog = Join-Path $OutputDir 'load-memory.csv'
    $sampler = Start-Job -ArgumentList $samplerLog -ScriptBlock {
      param($path)
      for ($i = 0; $i -lt 600; $i++) {
        $hostMib = [math]::Round(((Get-CimInstance Win32_Process -Filter "Name='yomika.exe'" -ErrorAction SilentlyContinue | Measure-Object -Property PrivatePageCount -Sum).Sum) / 1MB, 1)
        $workerMib = [math]::Round(((Get-CimInstance Win32_Process -Filter "Name='yomika-compute-worker.exe'" -ErrorAction SilentlyContinue | Measure-Object -Property PrivatePageCount -Sum).Sum) / 1MB, 1)
        $rendererMib = [math]::Round(((Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" -ErrorAction SilentlyContinue | Measure-Object -Property PrivatePageCount -Sum).Sum) / 1MB, 1)
        $gpu = (& nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits 2>$null | Select-Object -First 1)
        Add-Content -LiteralPath $path -Value "$hostMib,$workerMib,$rendererMib,$gpu"
        Start-Sleep -Milliseconds 500
      }
    }
    $loadedPass = Invoke-UiProbePass 'loaded' $UiLoadPages $UiKillWorker
    Stop-Job $sampler -ErrorAction SilentlyContinue
    Remove-Job $sampler -Force -ErrorAction SilentlyContinue
    $loaded = $loadedPass.reading
    $loadMemory = $null
    if (Test-Path $samplerLog) {
      $rows = Get-Content -LiteralPath $samplerLog | Where-Object { $_ -match '^\s*[\d.]+,' }
      if ($rows.Count -gt 0) {
        $pick = {
          param($index)
          $values = @()
          foreach ($row in $rows) {
            $cells = $row -split ','
            if ($cells.Count -gt $index -and $cells[$index] -ne '' -and $cells[$index] -ne $null) { $values += [double]$cells[$index] }
          }
          if ($values.Count -eq 0) { return $null }
          return [math]::Round(($values | Measure-Object -Maximum).Maximum, 1)
        }
        $loadMemory = [ordered]@{
          hostPeakMib     = (& $pick 0)
          workerPeakMib   = (& $pick 1)
          rendererPeakMib = (& $pick 2)
          gpuPeakMib      = (& $pick 3)
          samples         = $rows.Count
          note            = '重载那一趟每 500 ms 采一行取峰值；renderer 同样含两个 WebView2 环境的共享页重复计数，GPU 那一栏是整张卡'
        }
        $loadSum = 0.0
        $loadCounted = 0
        foreach ($key in @('hostPeakMib', 'workerPeakMib', 'rendererPeakMib', 'gpuPeakMib')) {
          if ($loadMemory[$key] -ne $null) { $loadSum += [double]$loadMemory[$key]; $loadCounted += 1 }
        }
        $loadMemory['totalMib'] = [math]::Round($loadSum, 1)
        $loadMemory['columnsCounted'] = $loadCounted
        Write-Host ("   重载时总内存（host 峰值 {0} ＋ worker 峰值 {1} ＋ renderer 峰值 {2} ＋ 整卡峰值 {3} = {4} MiB，{5}/4 栏，{6} 行样本）" -f `
          $loadMemory.hostPeakMib, $loadMemory.workerPeakMib, $loadMemory.rendererPeakMib, $loadMemory.gpuPeakMib, `
          $loadMemory.totalMib, $loadMemory.columnsCounted, $loadMemory.samples)
      }
    }
    # 这一跑的读数说「机器被压起来了」要有别人证：驱动问的是应用自己的 worker 状态与任务表。
    if (-not $loaded.load -or [int]$loaded.load.submitted -lt 1) {
      throw "压机器那一趟没交出读数（load 是空的或一件都没提交）：读 $($loadedPass.log)"
    }
    if (-not $loaded.load.worker -or $loaded.load.worker.kind -eq 'stopped') {
      throw "压机器那一趟提交了任务，可这一代 worker 从没起来过（$($loaded.load.worker.kind)）：读 $($loadedPass.log)"
    }
    $idleRatio = [double]$idle.reading.frames.droppedRatio
    $loadedRatio = [double]$loaded.frames.droppedRatio
    $deltaPp = [math]::Round(100 * ($loadedRatio - $idleRatio), 2)
    $framesDelta = [ordered]@{
      name = 'frames-delta'
      idleDropped = [int]$idle.reading.frames.dropped; idleFrames = [int]$idle.reading.frames.count; idleRatio = $idleRatio
      loadedDropped = [int]$loaded.frames.dropped; loadedFrames = [int]$loaded.frames.count; loadedRatio = $loadedRatio
      deltaPp = $deltaPp
      budgetPp = 5
      withinBudget = ($deltaPp -le 5)
      submitted = [int]$loaded.load.submitted
      load = $loaded.load
      log = $loadedPass.log
      exitCode = $loadedPass.exitCode
      seconds = $loadedPass.seconds
    }
    Write-Host ("   重载：提交 {0} 件（{1}）；掉帧 {2}/{3}（{4}%）对空载 {5}/{6}（{7}%）⇒ 增加 {8} 个百分点（门槛 5）" -f `
      $loaded.load.submitted, $loaded.load.worker.kind, `
      $loaded.frames.dropped, $loaded.frames.count, [math]::Round(100 * $loadedRatio, 2), `
      $idle.reading.frames.dropped, $idle.reading.frames.count, [math]::Round(100 * $idleRatio, 2), $deltaPp)
    if ($loaded.load.jobError) { Write-Host "   [warn] 提交那一批里有失败的：$($loaded.load.jobError)" }
  }
  $uiResult = [ordered]@{
    name = 'ui-probe'; exitCode = $idle.exitCode; green = $green; seconds = $idle.seconds; log = $idle.log
    # 读数来自哪一份构建要跟着数走：dev（Vite）那一档的导航里含 Vite 的冷启动，打包那一档不含，
    # 两个数不能互相解释。「打包那一档没还偏好」这件事由 reading.quiet 那一栏说清。
    bundled = [bool]$UiBundled; targetUrl = $target.url
    reading = $uiReading; memory = $uiMemory
    loaded = $loaded; framesDelta = $framesDelta; memoryUnderLoad = $loadMemory
  }
} else {
  $uiResult = [ordered]@{ name = 'ui-probe'; skipped = $true }
}

# 这一跑量到了什么、没量到什么。**没量的不许留空**：写清是什么、为什么、现场在哪。
$measured = [ordered]@{
  perPagePeaks        = '每页的 worker 私有提交与进程峰值（§12.4 ③ 的「每页记 peak」）'
  warmPlateauAndGrowth = '热身之后的平台与整段 soak 的增量（§12.4 ② 的 <32 MiB 守卫）'
  handbackBytes       = '交回前后的字节差与份数（9-c 只钉了份数，字节是这一跑补的）'
  workerExitZero      = '收摊后 worker 进程真的不在了（§12.4 ④ 的后半句）'
  commandResults      = '每个命令的 exitcode 与 passed/failed/ignored（§12.5）'
  restartStorm        = '§12.4 ⑥ 的 20 轮「启动→取消/强杀→重启→读同页」：孤儿进程、staging 遗留、错误 cache、重复终态四样，外加拿同一页再读一次（restart-it）'
  largePageBudgetGate = '§12.4 ③ 被拒那一档的判决码、被拒之后这一代 worker 还在不在、每档各自的增量（-LargePages）'
  gpuTier             = '§12.4 ⑤ 的真 GPU 档：政策是不是 gpu、有没有悄悄回退、worker 私有提交、整卡用量（-GpuSoak）'
  layerSweep          = '§12.4 ②/③ 的层数那一维：1/3/5 层各自的私有提交平台与交回后的回落（-Layers）'
  uiInputToPaint      = '§12.3 输入到下一次呈现的 p95/p99：真窗口、浏览器自己的输入管线派 ≥100 次键鼠（-UiProbe）'
  uiNavigation        = '§12.3 简单导航可见的多次采样 p50/p95（以「页面里出现有像素的图」当呈现，-UiProbe）'
  uiLongTasks         = '§12.3 JS 长任务 >50 ms 的条数与最长时长（renderer 的 PerformanceObserver，-UiProbe）'
  uiRendererMemory    = '§12.4 ⑤ 的四栏：宿主＋worker＋renderer（msedgewebview2 之和）＋整卡用量（-UiProbe；重载那一趟另给一份峰值，-DropFrames）'
  loadedFramesDelta   = '§12.3 重载相对空载的掉帧比例之差（同一份构建、同一个页面、同一串输入跑两趟，重载那趟同时提交重任务）（-DropFrames）'
}
$notMeasured = @(
  [ordered]@{ what = '§12.3 输入到下一次呈现的 p95 ≤ 100 ms / p99 ≤ 200 ms'; why = '要真窗口 + 真 WebView2 renderer 进程的 rAF/input 时间戳，这台机器上跑不出这个数' },
  [ordered]@{ what = '§12.3 submit/cancel/promote 的 ACK p95 ≤ 100 ms'; why = '调度器内部那一段由三连的 queue-ack 用例给出（p50/p95/p99，纯时刻、不含 IPC）；从输入到界面拿到回执的那一段要真窗口 trace，没采' },
  [ordered]@{ what = '§12.3 简单导航与返回原图可见 p95 ≤ 150 ms'; why = '同上（jsdom 没有布局，量不到「可见」）' },
  [ordered]@{ what = '§12.3 重载时掉帧比例增加 ≤ 5 个百分点'; why = '要真窗口的 present 时间线；-UiProbe 给的是空载自身的掉帧比例，**没有重载那一段做对照**——没有对照就没有「增加多少」' },
  [ordered]@{ what = '§12.3 JS 长任务 >50 ms 的数量与最长时长'; why = '要真 renderer 的 PerformanceObserver；现场见 debug_outputs/task8h6/real-window-probe.ps1' },
  [ordered]@{ what = '§12.3 worker crash/kill/hang 时重启 ≤ 2 秒内给出「正在恢复/不可用」'; why = '界面那一半要真窗口；调度器那一半由 compute_manager 与 compute_restart_storm 的用例覆盖' },
  [ordered]@{ what = '§12.4 ⑤ 总内存（host＋worker＋renderer/GPU 一起计）'; why = 'renderer 进程只有真窗口才点得着；这里的数字是 host＋worker 的下界' },
  [ordered]@{ what = '§12.4 ③ 的 1/3/5 层'; why = '协议里的 `layers` 没有一处代码读得到；§12.4 说的层数是 DLSSNR 的 `settings.passes`，只有真 NGX + GPU 那条路跑得到，本机没有' }
)
if (-not $soak) {
  $notMeasured += [ordered]@{ what = '§12.4 ② 的页级 soak'; why = '这一跑带了 -SkipSoak' }
}
if ($LargePages -le 0) {
  $notMeasured += [ordered]@{ what = '§12.4 ③ 的 5MP/10MP/25MP 大页档'; why = '默认不跑（几分钟）；要这一档请带 -LargePages <每档真算的页数>' }
}
if (-not $soakLargeResult.skipped) {
  # 跑了大页档就把「每页记 peak」那半句补上；层数那半句仍然量不到，留在上面。
  $notMeasured = @($notMeasured | Where-Object { $_.what -notlike '§12.4 ③ 的 5MP*' })
} elseif ($LargePages -gt 0) {
  # 点了名要它跑，却什么都没跑出来 —— 这种「悄悄没做」比报错更坏，出口也不许是绿的。
  throw "要了大页档（-LargePages $LargePages）却没跑：soak-large 那一段没留下读数"
}
if (-not $soakGpuResult.skipped) {
  # GPU 档自己把「政策是 gpu / 有没有回退 / worker 提交 / 整卡用量」都量了，但 renderer 那一份
  # 仍然点不着（它只有真窗口才有），所以 §12.4 ⑤ 这一条改成说清「还差谁」，而不是整条撤掉。
  $notMeasured = @($notMeasured | Where-Object { $_.what -notlike '§12.4 ⑤*' })
  $notMeasured += [ordered]@{ what = '§12.4 ⑤ 里的 renderer 那一份'; why = 'renderer 是 WebView2 的进程，只有真窗口那条路才点得着；GPU 档给的是 host＋worker＋整卡用量，缺 renderer' }
} elseif ($GpuSoak) {
  throw "要了 GPU 档（-GpuSoak）却没跑：soak-gpu 那一段没留下读数"
}
if ($layerTiers.Count -gt 0) {
  if (@($layersSweep).Count -ne $layerTiers.Count) { throw "要了 $($layerTiers.Count) 个层数档，只跑出 $(@($layersSweep).Count) 个" }
  $notMeasured = @($notMeasured | Where-Object { $_.what -notlike '§12.4 ③ 的 1/3/5 层' })
  $notMeasured += [ordered]@{ what = '§12.4 ③ 层数 × 页大小那一格'; why = '层数是在 512×768 的 32 页 soak 上量的；「5 层 × 25 MP」那种交叉要真 NGX 与真大页一起上，没跑' }
}
if (-not $uiResult.skipped) {
  # 真窗口跑了，就把它真的量到的那几条从 notMeasured 里撤下来；**没量到的留在原处**——
  # 「跑过 UI 档」不等于「§12.3 全都量到了」。撤下来的三条各有各的样本：
  # 输入到呈现的 p95/p99、导航可见的多次采样 p50/p95、JS 长任务、renderer 那一份内存。
  $notMeasured = @($notMeasured | Where-Object {
    $_.what -notlike '§12.3 输入到下一次呈现*' -and
    $_.what -notlike '§12.3 简单导航*' -and
    $_.what -notlike '§12.3 JS 长任务*' -and
    $_.what -notlike '§12.4 ⑤*'
  })
  # 「重载时掉帧增加」只有跑了重载那一趟（-DropFrames）才算量到；同名两条读起来像量了两件事，
  # 所以这里只撤那一条，不另起一条新的话。
  if ($uiResult.framesDelta) {
    $notMeasured = @($notMeasured | Where-Object { $_.what -notlike '§12.3 重载时掉帧比例增加*' })
  }
  if ($UiKillWorker -eq 0) {
    $notMeasured += [ordered]@{ what = '§12.3 worker crash/kill/hang 时 UI 仍可操作'; why = '这一跑没带 -UiKillWorker，没杀过计算进程；「2 秒内给状态」那半句在上面那条里，调度器那一半由 compute_manager 与 compute_restart_storm 覆盖' }
  } else {
    $notMeasured = @($notMeasured | Where-Object { $_.what -notlike '§12.3 worker crash/kill/hang*' })
    # 杀的是哪一趟里的 worker，读数就在哪一趟里：`-UiKillWorker <pid>` 杀空载那一趟，
    # `-UiKillWorker -1` 杀的是压机器那一趟正在算的那个。
    $killReading = if ($uiResult.loaded -and $uiResult.loaded.workerKill) { $uiResult.loaded } else { $uiResult.reading }
    $kill = $killReading.workerKill
    if (-not $kill -or -not $kill.inputAnswered) { throw "杀了 worker 却没量到 UI 还答不答输入：读 $($killReading.readerUrl)，读数在 ui-probe-*.log" }
  }
  # 「量到了」不等于「达到了」：§12.3 这一条的门槛是 p95 ≤ 150 ms。上面把这一行从 notMeasured 里
  # 撤掉，是因为它有样本了；可样本超了门槛就必须**换一条写着真实数字的**说法回来——撤掉不补，
  # 读起来就像达标了。§12.3 原话：baseline 本来就慢时先修 baseline 或报相对变化，不能当通过理由。
  $navP95 = [double]$uiReading.navigation.p95Ms
  if ($navP95 -gt 150) {
    $notMeasured += [ordered]@{
      what = "§12.3 简单导航/返回原图可见 p95 ≤ 150 ms（量到了，没达到：这一跑 p95 = $navP95 ms）"
      why = '这一档量的是一次「导航到阅读器并看见有像素的图」，里面含档案清单与首页图片那条路（dev 那一档还含 Vite 的冷启动）。本机 baseline 就慢，门槛这一跑够不着，相对变化看同机两档之差'
    }
  }
}

$report = [ordered]@{
  label = $Label
  stamp = $stamp
  backend = $Backend
  pages = $Pages
  fixtureManifest = [ordered]@{ path = $FixtureManifest; sha256 = $fixtureHash }
  machine = Get-Machine
  commands = $results
  soak = $soakResult
  soakLarge = $soakLargeResult
  soakGpu = $soakGpuResult
  layers = $layersResult
  ui = $uiResult
  measured = $measured
  notMeasured = $notMeasured
}
$jsonPath = Join-Path $OutputDir "measure-$stamp.json"
$report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $jsonPath -Encoding utf8

# summary.md：人看的那一份，与 JSON 同一批数字。
$lines = New-Object System.Collections.Generic.List[string]
$lines.Add("# 计算响应性与回收：$Label（$stamp）")
$lines.Add('')
$lines.Add("后端档位 ``$Backend``，soak $Pages 页；素材清单 ``$FixtureManifest``（sha256 $($fixtureHash.Substring(0,16))…）。")
$lines.Add('')
$lines.Add('## 机器')
$lines.Add('')
$lines.Add('| 项 | 值 |')
$lines.Add('| --- | --- |')
foreach ($key in $report.machine.Keys) {
  $value = $report.machine[$key]
  if ($value -is [array]) { $value = ($value -join ' / ') }
  $lines.Add("| $key | $value |")
}
$lines.Add('')
$lines.Add('## 命令')
$lines.Add('')
$lines.Add('| 命令 | exit | 证据 | 秒 | passed | failed | ignored | 日志 |')
$lines.Add('| --- | --- | --- | --- | --- | --- | --- | --- |')
foreach ($row in $results) {
  $lines.Add("| $($row.name) | $($row.exitCode) | $(if ($row.evidence) { 'ok' } else { '缺' }) | $($row.seconds) | $($row.passed) | $($row.failed) | $($row.ignored) | $($row.log) |")
}
$lines.Add('')
if ($soak) {
  $reading = $soakResult.reading
  # 拿空表交差的守卫：JSON 那份是从读数直接序列化出来的，一定对；人读的这一份是**再写一遍**
  # 的，写错变量名只会让表格空着，而「这一跑全绿」照样打出来（本文件第一次跑就是这样：
  # JSON 里 32 行齐全、md 里一行都没有）。所以这里量一遍「行数 == 页数」。
  if (@($reading.rows).Count -ne [int]$reading.pages) {
    throw "soak 读数里页数对不上：$(@($reading.rows).Count) 行 vs $($reading.pages) 页（md 不能拿空表交差）"
  }
  $lines.Add('## soak（§12.4）')
  $lines.Add('')
  $lines.Add("$($reading.pages) 页 $($reading.page.width)×$($reading.page.height)（源图 $($reading.page.sourceBytes) 字节），热身 $($reading.warmup) 页。")
  $lines.Add('')
  $lines.Add('| 页 | worker 提交 MiB | worker 峰值 MiB | 宿主提交 MiB | 本页 ms |')
  $lines.Add('| --- | --- | --- | --- | --- |')
  foreach ($row in $reading.rows) {
    $lines.Add("| $($row.page) | $($row.workerCommitMib) | $($row.workerPeakMib) | $($row.hostCommitMib) | $($row.elapsedMs) |")
  }
  $lines.Add('')
  $lines.Add("- 热身之后平台 $($reading.warmCommitMib) MiB，跑完 $($reading.finalCommitMib) MiB（涨 $($reading.growthMib) MiB），进程峰值 $($reading.peakMib) MiB。")
  $lines.Add("- 交回：报 $($reading.handback.count) 份，$($reading.handback.beforeMib) → $($reading.handback.afterMib) MiB（掉 $($reading.handback.droppedMib) MiB）；再跑一页回到 $($reading.handback.reloadedMib) MiB；第二次交回掉 $($reading.handback.secondDroppedMib) MiB。")
  $lines.Add("- 收摊后 worker 进程（pid $($reading.workerPid)）不在了：它的私有提交按定义归零。")
  $lines.Add('')
}
if ($soakLarge) {
  $reading = $soakLargeResult.reading
  # 同一道空表守卫：JSON 是直接序列化的，md 是再写一遍的。
  if (@($reading.rows).Count -ne [int]($reading.computedPages)) {
    throw "大页 soak 读数里页数对不上：$(@($reading.rows).Count) 行 vs 预期 $(($reading.computedPages)) 行（md 不能拿空表交差）"
  }
  $lines.Add('## 大页 soak（§12.4 ③）')
  $lines.Add('')
  $tierText = ($reading.tiers | ForEach-Object { "$($_.width)×$($_.height)（$([math]::Round($_.pixels / 1000000, 1)) MP）" }) -join '、'
  $lines.Add("三档：$tierText；源上限 $($reading.allowedSourcePixels) 像素（由预算门自己算出来），超出输出预算时先等比缩小输入，再执行超分。")
  $lines.Add('')
  $lines.Add('| 档 | 热身 MiB | 最坏涨 MiB | 峰值 MiB | 峰值涨 MiB |')
  $lines.Add('| --- | --- | --- | --- | --- |')
  foreach ($tier in $reading.perTier) {
    $lines.Add("| $($tier.width)×$($tier.height) | $($tier.warmCommitMib) | $($tier.growthMib) | $($tier.peakMib) | $($tier.peakGrowthMib) |")
  }
  $lines.Add('')
  $lines.Add("- 真算 $($reading.computedPages) 页；预算拒绝 $($reading.refusedPages) 页；25 MP 档也实际执行超分。")
  $lines.Add("- 层数：$($reading.layers.why)")
  $lines.Add("- 收摊后 worker 进程（pid $($reading.workerPid)）不在了。")
  $lines.Add('')
}
if (-not $soakGpuResult.skipped) {
  $reading = $soakGpuResult.reading
  if (@($reading.rows).Count -ne [int]$reading.pages) {
    throw "GPU 档读数里页数对不上：说要 $($reading.pages) 页，只有 $(@($reading.rows).Count) 页（md 不能拿空表交差）"
  }
  $lines.Add('## 真 GPU 档（§12.4 ⑤）')
  $lines.Add('')
  $lines.Add("模型 ``$($reading.model)``、政策 ``$($reading.policy)``、回退 ``$(if ($null -eq $reading.engineFallback) { '无' } else { $reading.engineFallback })``、$($reading.pages) 页（热身 $($reading.warmupPages) 页）。")
  $lines.Add('')
  $lines.Add('| 页 | worker 提交 MiB | worker 峰值 MiB | 宿主提交 MiB | DXGI 整卡用量 MiB | 端到端 ms |')
  $lines.Add('| --- | --- | --- | --- | --- | --- |')
  foreach ($row in $reading.rows) {
    $lines.Add("| $($row.page) | $($row.workerCommitMib) | $($row.workerPeakMib) | $($row.hostCommitMib) | $($row.adapterUsedMib) | $($row.elapsedMs) |")
  }
  $lines.Add('')
  $lines.Add("- 热身之后 worker 提交 $($reading.warmCommitMib) MiB（涨 $($reading.growthMib) MiB，门槛 $($reading.growthLimitMib) MiB）；每页端到端 p50 $($reading.latencyMs.p50) ms、p95 $($reading.latencyMs.p95) ms、p99 $($reading.latencyMs.p99) ms。")
  $lines.Add("- 总内存（§12.4 ⑤）：宿主 $($reading.rows[-1].hostCommitMib) MiB ＋ worker $($reading.warmCommitMib) MiB ＋ 整卡用量（nvidia-smi）：开工前 $($soakGpuResult.gpuUsedBeforeMib) MiB、期间 $($soakGpuResult.gpuUsedDuringMinMib)–$($soakGpuResult.gpuUsedDuringMaxMib) MiB（$($soakGpuResult.gpuUsedSamples) 个样本）、收摊后 $($soakGpuResult.gpuUsedAfterMib) MiB。")
  $lines.Add("- DXGI 那一栏（预算 $($reading.adapterBudgetMib) MiB）量到的用量是 $($reading.adapterUsedAfterMib) MiB：**本机这半栏读不出数**，所以显存账走厂商工具那一行；它是整张卡的数，含别的进程。")
  $lines.Add("- 收摊后 worker 进程（pid $($reading.workerPid)）不在了。")
  $lines.Add('')
}
if ($layerTiers.Count -gt 0) {
  if (@($layersSweep).Count -ne $layerTiers.Count) {
    throw "层数档少跑了：要 $($layerTiers.Count) 个，只有 $(@($layersSweep).Count) 个（md 不能拿空表交差）"
  }
  $lines.Add('## 层数档（§12.4 ② 的「3 层」与 ③ 的「1/3/5 层」，真 NGX）')
  $lines.Add('')
  $lines.Add('| 层 | 热身 MiB | 32 页之后 MiB | 交回之后 MiB | 秒 |')
  $lines.Add('| --- | --- | --- | --- | --- |')
  foreach ($row in $layersSweep) {
    $lines.Add("| $($row.passes) | $($row.warmMib) | $($row.after32Mib) | $($row.releasedMib) | $($row.seconds) |")
  }
  $lines.Add('')
  $lines.Add('- 「层」在产品里就是 DLSSNR 的 passes（协议里的 `layers` 没有一处代码读它）；这一档量的是层数变多时内存怎么走，产品行为一个字没动。')
  $lines.Add('')
}
if (-not $uiResult.skipped) {
  $reading = $uiResult.reading
  # 同一道空表守卫：JSON 是读数直接序列化出来的，md 是**再写一遍**的。
  if ([int]$reading.inputs.total -lt $UiInputs) {
    throw "UI 档读数里输入样本对不上：$(($reading.inputs.total)) 条 vs 要 $UiInputs 条（md 不能拿空表交差）"
  }
  if (@($reading.navigation.samples).Count -ne [int]$reading.navigation.count) {
    throw "UI 档读数里导航样本对不上：$(@($reading.navigation.samples).Count) 条 vs $($reading.navigation.count) 次"
  }
  $lines.Add('## 真窗口（§12.3）')
  $lines.Add('')
  $lines.Add("主页面 ``$($reading.readerUrl)``；派了 $($reading.inputs.total) 次输入（键盘 $($reading.inputs.kinds.key)、指针 $($reading.inputs.kinds.pointer)、滚轮 $($reading.inputs.kinds.wheel)），导航 $($reading.navigation.count) 次。")
  $lines.Add('')
  # 这一栏是 dev 还是打包，直接决定导航那两行能不能拿去比：dev 那份每次导航都在等 Vite 现编。
  if ($uiResult.bundled) {
    $lines.Add("- 这一档量的是**打包构建**（``$($uiResult.targetUrl)``）：驱动不 import 应用模块、也不动偏好（$(if ($reading.quiet.skipped) { $reading.quiet.skipped } else { '偏好是它自己在开场关的' })）。")
  } else {
    $lines.Add("- 这一档量的是 **dev 构建**（``$($uiResult.targetUrl)``，前端来自 Vite）：导航那两行里含着 Vite 的冷启动，不能拿去代表打包产物。")
  }
  $lines.Add('')
  $lines.Add('| 指标 | 值 |')
  $lines.Add('| --- | --- |')
  $lines.Add("| 输入到下一次呈现 p50 / p95 / p99（ms） | $($reading.inputs.p50) / $($reading.inputs.p95) / $($reading.inputs.p99) |")
  $lines.Add("| 输入到呈现最坏（ms） | $($reading.inputs.worst) |")
  $lines.Add("| 导航可见 p50 / p95 / 最坏（ms） | $($reading.navigation.p50Ms) / $($reading.navigation.p95Ms) / $($reading.navigation.worstMs) |")
  $lines.Add("| 帧间隔 p50 / p95（ms） | $($reading.frames.p50Ms) / $($reading.frames.p95Ms) |")
  $lines.Add("| 掉帧（超过 1.5×中位） | $($reading.frames.dropped)/$($reading.frames.count)（$(100 * $reading.frames.droppedRatio)%） |")
  $lines.Add("| JS 长任务 >50 ms | $($reading.longTasks.count) 条，最长 $($reading.longTasks.worstMs) ms |")
  $lines.Add("| renderer JS 堆（字节） | $($reading.renderer.jsHeapUsedBytes) |")
  $lines.Add("| 首次绘制 / 首个内容绘制（ms） | $(($reading.timing.paint | ForEach-Object { "$($_.name) $($_.ms)" }) -join '、') |")
  $lines.Add('')
  $lines.Add('### 总内存（§12.4 ⑤ 的四栏）')
  $lines.Add('')
  $lines.Add('| 栏 | MiB |')
  $lines.Add('| --- | --- |')
  $lines.Add("| 宿主（yomika.exe） | $($uiResult.memory.hostMib) |")
  $lines.Add("| 计算进程（yomika-compute-worker.exe） | $($uiResult.memory.workerMib) |")
  $lines.Add("| renderer（所有 msedgewebview2 进程之和） | $($uiResult.memory.rendererMib) |")
  $lines.Add("| 整卡用量（nvidia-smi） | $($uiResult.memory.gpuUsedMib) |")
  $lines.Add("| 合计（$($uiResult.memory.columnsCounted)/4 栏） | $($uiResult.memory.totalMib) |")
  $lines.Add('')
  $lines.Add("- 限制：$($uiResult.memory.note)。")
  if ($reading.workerKill) {
    $kill = $reading.workerKill
    $lines.Add("- 杀掉 worker（pid $($kill.pid)）之后：界面给出了状态条（``$($kill.state)``）「$($kill.text)」用了 $($kill.statusMs) ms（2 秒之内：$($kill.withinBudget)），随后的键盘输入照样被应答：$($kill.inputAnswered)。")
  }
  if ($uiResult.framesDelta) {
    $delta = $uiResult.framesDelta
    $lines.Add('')
    $lines.Add('### 重载相对空载的掉帧（§12.3）')
    $lines.Add('')
    # 两趟的样本数也要对得上；md 不能拿一张对不上的表交差。
    if ([int]$delta.idleFrames -lt 100 -or [int]$delta.loadedFrames -lt 100) {
      throw "重载对照的两趟帧样本有一趟太少：$($delta.idleFrames) / $($delta.loadedFrames)"
    }
    if ([int]$delta.submitted -lt 1) { throw '重载那一趟一件重任务都没提交成功（md 不能只说「压了机器」）' }
    $lines.Add("| 那一趟 | 提交的重任务 | 掉帧 | 帧数 | 比例 |")
    $lines.Add('| --- | --- | --- | --- | --- |')
    $lines.Add("| 空载 | 0 | $($delta.idleDropped) | $($delta.idleFrames) | $([math]::Round(100 * $delta.idleRatio, 2))% |")
    $lines.Add("| 重载 | $($delta.submitted) | $($delta.loadedDropped) | $($delta.loadedFrames) | $([math]::Round(100 * $delta.loadedRatio, 2))% |")
    $lines.Add("| **增加** | —— | —— | —— | **$($delta.deltaPp) 个百分点**（门槛 $($delta.budgetPp)） |")
    $lines.Add('')
    $lines.Add("- 重载那一趟的计算进程：``$($delta.load.worker.kind)``（pid $($delta.load.worker.peerPid)）；两趟都是同一份构建、同一个页面、同一串输入。")
    $loadedMemory = $uiResult.memoryUnderLoad
    if ($loadedMemory) {
      $lines.Add("- 重载时的四栏总内存（§12.4 ⑤，每 500 ms 采一行取峰值，$($loadedMemory.samples) 行样本）：宿主 $($loadedMemory.hostPeakMib) MiB ＋ worker $($loadedMemory.workerPeakMib) MiB ＋ renderer $($loadedMemory.rendererPeakMib) MiB ＋ 整卡 $($loadedMemory.gpuPeakMib) MiB = **$($loadedMemory.totalMib) MiB**（$($loadedMemory.columnsCounted)/4 栏）。")
    } else {
      $lines.Add("- 重载时的四栏总内存：没采到峰值样本（读数里 `memoryUnderLoad` 是空的）——这一栏这一跑不算量到。")
    }
    if (-not $delta.withinBudget) {
      $lines.Add("- **这一栏超了**：掉帧比例增加了 $($delta.deltaPp) 个百分点，门槛是 $($delta.budgetPp)。超了就要按 §12.3 最后那句降级（不启后台/降档），不许当成通过。")
    }
    if ($uiResult.loaded -and $uiResult.loaded.workerKill) {
      $kill = $uiResult.loaded.workerKill
      $lines.Add("- 重载那一趟末尾杀掉 worker（pid $($kill.pid)）之后：界面给出了状态条（``$($kill.state)``）「$($kill.text)」用了 $($kill.statusMs) ms（2 秒之内：$($kill.withinBudget)），随后的键盘输入照样被应答：$($kill.inputAnswered)。")
    }
  }
  $lines.Add('')
}
$lines.Add('## 这一跑量到了什么')
$lines.Add('')
foreach ($key in $measured.Keys) { $lines.Add("- ``$key``：$($measured[$key])") }
$lines.Add('')
$lines.Add('## 这一跑没量到什么（不许当成通过）')
$lines.Add('')
foreach ($item in $notMeasured) { $lines.Add("- **$($item.what)** —— $($item.why)") }
$lines.Add('')
$failures = @($results | Where-Object { -not $_.green })
$red = @()
if ($soakResult.green -eq $false) { $red += 'soak' }
if ($soakLargeResult.green -eq $false) { $red += 'soak-large' }
if ($soakGpuResult.green -eq $false) { $red += 'soak-gpu' }
if ($layersResult.green -eq $false) { $red += 'layers' }
if ($uiResult.green -eq $false) { $red += 'ui-probe' }
# 重载相对空载的掉帧超了门槛（> 5 个百分点）也是红：§12.3 要求这时明确降级（不启后台/降档），
# 不许把它留在报告里当没看见。
if ($uiResult.framesDelta -and -not $uiResult.framesDelta.withinBudget) { $red += 'frames-delta' }
$verdict = if ($failures.Count -eq 0 -and $red.Count -eq 0) { '这一跑全绿。' } else { "这一跑有红：$((($failures | ForEach-Object { $_.name }) + $red) -join '、')。" }
$lines.Add("**结论**：$verdict")
$mdPath = Join-Path $OutputDir 'summary.md'
Set-Content -LiteralPath $mdPath -Value ($lines -join "`r`n") -Encoding utf8

Write-Host ''
Write-Host "读数落在 $OutputDir"
Write-Host "  $jsonPath"
Write-Host "  $mdPath"
Write-Host $verdict
if ($failures.Count -gt 0 -or $red.Count -gt 0) { exit 1 }
exit 0
