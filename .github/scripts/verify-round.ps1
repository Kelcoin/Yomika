# 一轮的完整验证：三连 + 每一套件，**严格串行**。
#
# 为什么必须串行：cargo 与 vitest 同时跑会让宿主 lib 里两条对时序敏感的用例假红
# （`cache::tests::the_database_lock_is_free_while_a_blob_is_read` 这类），也会让两个
# 动画用例（只走 worker 单进程的那两条）拿到互相干扰的 dlssnr 加载顺序。
#
# 为什么宿主 lib 要拆成四段（第 31 轮改过名字的那一段见下）：老 dlssnr 在同一进程里会互相
# 干扰，所以
#   `--lib -- --skip dlssnr`（大头）
#   `--lib "dlssnr::"`（dlssnr 自己那一段）
#   `--lib --exact --test-threads=1 compute_center::tests::the_dlssnr_op_no_longer_computes_in_this_process`
#   `--lib --exact --test-threads=1 compute_center::tests::an_animated_page_reaches_dlssnr_as_an_animation`
# 逐段单跑，四段相加才是宿主 lib 的总数。
#
# `center-op` 那一段原来指向 `compute_center::tests::a_tiny_animated_page_is_handed_back_by_dlssnr`：
# 第 31 轮把算力中心那条 DLSSNR 路也搬出宿主之后，那条用例被同文件里那条「没有编排时它不该在
# 本进程里算」替掉了。**替换之后没人动过这个脚本**，于是那一步筛到 0 条用例、`0 passed` 而
# cargo 照样 exit 0 —— 一道「筛不到东西的空跑」混在摘要里，看退出码永远看不出来。现在两步的
# 用例名都由判据里的 `[1-9]\d* passed` 守着。
#
# 每步的输出都进 `<logDir>\<label>-<step>.log`，stdout 只留一行 `step exit=N evidence=…`，
# 最后打印一份摘要（每个日志里的 `test result:` 行与任何 `panicked at`）。
#
# 第 32 轮起是 **18 步**：`core-meta` 夹在 `core-dlssnr` 后面，它**不带任何 feature**
# 编一次核心（元数据那一半 + `tests/dlssnr_metadata.rs`）。那一步的绿是「宿主摘掉
# `dlssnr` feature 之后仍然要用的那一半真的能单独编、单独跑」的唯一证据。
# 第 18 步（8-h②）是 `center-it`：**真中心 + 真调度器 + 真 worker**（`tests/remote_compute_center.rs`），
# 它管的是「远端来的那一页也走同一条调度/产物路、认证与 ping 不等 GPU、客户端走了只取消
# 它自己那一次订阅」——这三件事没有一条能被纯单测看见。
#
# 第 33 轮起多一步 `core-gpu`（现在共 21 步）：Anime4K 的 wgpu 执行体与 CPU 解释器逐像素
# 对齐、外加「分块管道对它隐形」。它要 `anime4k-gpu` feature，也要一张真显卡——这台机器上
# 是 `NVIDIA GeForce RTX 5090 D (Vulkan, NVIDIA 617.42)`。拿不到设备时用例打印
# `跳过：这台机器上拿不到计算设备` 就走，evidence 判据把这种空转当红（与 `core-dlssnr` 同口径）。
#
# **判绿是算出来的**（第 31 轮补上）：每一步必须 exit 0 **且**那个日志里有该有的字样
# （`Test-StepEvidence`），缺一条就 exit 1。在此之前这个脚本从头到尾没有一句判据，末尾的
# 退出码只是最后一句 `Write-Host` 的 0 —— 「TRIO_EXIT=0」并不证明任何一步过了。
# 空跑（`-Only` 写歪导致一步没跑）另算，直接 exit 9。
#
# 用法：
#     pwsh -File .github/scripts/verify-round.ps1 -Label task8a
#     pwsh -File .github/scripts/verify-round.ps1 -Label task8a -Only tsc,vitest

param(
  [string] $RepoRoot = "",
  [string] $Label = "final",
  [string] $LogDir = "",
  [string[]] $Only = @()
)

$ErrorActionPreference = "Continue"
if (-not $RepoRoot) {
  # 从前这里写死了这台机器的绝对路径。脚本的位置就说明了一切：`.github/scripts/` 在仓库根下
  # 两层（它原来在 `scripts/compute/`，同样两层），所以「脚本目录的上两级」就是根。
  $RepoRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
}
Set-Location $RepoRoot

# `pwsh -File script.ps1 -Only a,b,c` 会把整串当成**一个**字符串塞给 $Only，
# 于是每个 Step 都 `-notcontains` 命中、全部跳过、而退出码仍是 0 —— 空跑看起来像全绿。
# 所以在开头把它拆开，并在末尾对「一步都没跑」直接报错退出。
$Only = @($Only | ForEach-Object { $_ -split "," } | ForEach-Object { $_.Trim() } | Where-Object { $_ })
# 从前这里把 CARGO_TARGET_DIR 指到 debug_outputs\cargo-target：整轮与开发构建各用一份目标
# 目录，于是磁盘上并排躺着两份 50 GB 级的 debug 产物，每一轮还得重新把第二份热起来。2026-10-18
# 改成共用 src-tauri\target（对 src-tauri/Cargo.toml 来说 cargo 的默认目标目录就是它），那份
# 51.7 GB 的副本随之删掉，整轮反而更快。交付侧另有一条契约兜着：编 worker 时必须显式传
# --target-dir（tests/contracts/native-config.test.ts「产物一律进 src-tauri\target」），
# 所以共用目标目录不会把交付物带跑。
if (-not $LogDir) { $LogDir = Join-Path $RepoRoot "debug_outputs\verify" }
if (-not [System.IO.Path]::IsPathRooted($LogDir)) { $LogDir = Join-Path $RepoRoot $LogDir }
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

$manifest = "src-tauri\Cargo.toml"
$script:Steps = New-Object System.Collections.Generic.List[object]

# 一步「算过了」不只是 exit 0：那个日志里得出现它该出现的字样。少了这一半，一个跑歪了的
# 步骤（过滤条件改坏、编译产物是旧的、只打印了帮助）也会以 exit 0 混进摘要里。
function Test-StepEvidence([string] $name, [string] $log) {
  $text = if (Test-Path $log) { Get-Content -LiteralPath $log -Raw } else { "" }
  switch ($name) {
    # tsc 的绿就是「没报错」，日志是空的（71 B 那种），没有可找的字样。
    "tsc" { return $true }
    # vitest：池子抖动会让某条 worker 掉线（`Unhandled Error` + `Worker forks emitted error`），
    # 而用例数一个不少、失败数为 0 —— 那种红要重跑，不能算这一轮过了。
    "vitest" {
      if ($text -notmatch 'Tests\s+[1-9]\d* passed') { return $false }
      if ($text -match 'Tests\s+\d+ failed') { return $false }
      if ($text -match 'Unhandled Error') { return $false }
      if ($text -match 'Test Files\s+\d+ failed') { return $false }
      return $true
    }
    # 只编译不跑用例的那一步：exit 0 就是全部证据（error[…] 会让 cargo 非零退出）。
    "check-ws" { return $true }
    # 能力守卫不许悄悄空转（docs/71:639「保留 COM 引用计数红/绿守卫、取消后 workspace 状态
    # 及动画测试」）：那几条守卫没 DLL / GPU 起不来时会打印跳过就走，而**跳过的用例在
    # `test result` 里照样算 passed** —— 那就是把「跳过」当成了「量过」。这三个记号一出现就报红，
    # 只有显式设了 YOMIKA_ALLOW_VACUOUS_GUARDS=1（这台机器本来就没有那份 165MB 片段）才放行。
    "core-dlssnr" {
      if ($text -notmatch 'test result: ok\. [1-9]\d* passed') { return $false }
      if ($text -match 'test result: FAILED') { return $false }
      $vacuous = @(
        '跳过：没有找到 nvngx_dlssnr.dll',
        '跳过：DLSSNR 没跑起来',
        'SKIP: no DLSSNR DLL'
      ) | Where-Object { $text.Contains($_) }
      if ($vacuous.Count -gt 0) {
        Write-Host ("[warn] core-dlssnr 里有能力守卫空转（跳过≠通过）：{0}" -f ($vacuous -join '；'))
        if ($env:YOMIKA_ALLOW_VACUOUS_GUARDS -ne '1') { return $false }
      }
      return $true
    }
    # 第 33 轮起多一步 `core-gpu`：Anime4K 的 GPU 执行体与 CPU 解释器的逐像素比对
    # （`crates/compute-core/tests/anime4k_gpu.rs`，要 `anime4k-gpu` feature）。它和
    # `core-dlssnr` 同一口径：这台机器上拿不到计算设备时那几条会打印「跳过：」就走，
    # 而跳过的用例在 `test result` 里照样算 passed —— 那就是把跳过当成了量过。
    "core-gpu" {
      if ($text -notmatch 'test result: ok\. [1-9]\d* passed') { return $false }
      if ($text -match 'test result: FAILED') { return $false }
      if ($text.Contains('跳过：这台机器上拿不到计算设备')) {
        Write-Host "[warn] core-gpu 里没有计算设备（跳过≠通过）"
        if ($env:YOMIKA_ALLOW_VACUOUS_GUARDS -ne '1') { return $false }
      }
      return $true
    }
    default {
      if ($text -notmatch 'test result: ok\. [1-9]\d* passed') { return $false }
      if ($text -match 'test result: FAILED') { return $false }
      return $true
    }
  }
}

# 参数**不能**叫 `$args`（PowerShell 自动变量，绑不上）。
# 基础设施抖动：vitest 的 fork 池偶发猝死（日志里只有 pool 错误，没有一条失败用例，
# 文件/用例数也没跑满）。这种要复跑取证，但真失败绝不重试——那会把缺陷盖掉。
function Test-InfrastructureFlake([string] $name, [string] $log) {
  if ($name -ne 'vitest') { return $false }
  if (-not (Test-Path $log)) { return $false }
  $text = Get-Content $log -Raw
  if ($text -notmatch 'Worker forks emitted error|Worker exited unexpectedly') { return $false }
  if ($text -match '(?m)^\s*(FAIL|×)\s') { return $false }
  if ($text -match 'Tests\s+\d+ failed') { return $false }
  return $true
}

function Step([string] $name, [scriptblock] $body) {
  if ($Only.Count -gt 0 -and ($Only -notcontains $name)) { return }
  $log = Join-Path $LogDir "$Label-$name.log"
  # 每一步的墙钟时间也记下来（2026-10-18 构建提速轮加的）：整轮的成本只落在少数几步上，
  # 没有读数就只能靠感觉优化——Android 那边白编一遍就是这么发现的。
  $seconds = 0.0
  $attempts = 0
  while ($true) {
    $attempts++
    $clock = [System.Diagnostics.Stopwatch]::StartNew()
    & $body *> $log
    $code = $LASTEXITCODE
    $seconds = [Math]::Round($seconds + $clock.Elapsed.TotalSeconds, 1)
    $evidence = Test-StepEvidence $name $log
    if ($evidence -or $attempts -ge 2 -or -not (Test-InfrastructureFlake $name $log)) { break }
    # 抖动的那一份日志留着（`-flake1`），复跑的结果照旧写主日志。
    Copy-Item -LiteralPath $log -Destination "$log.flake1" -Force
    Write-Host ("[warn] {0} 这次是基础设施抖动（池子猝死、没有失败用例），复跑一次取证" -f $name)
  }
  $script:Steps.Add([pscustomobject]@{ Name = $name; Code = $code; Log = $log; Evidence = $evidence; Seconds = $seconds })
  Write-Host ("{0,-12} exit={1}  evidence={2}  {3}s{4}" -f $name, $code, $(if ($evidence) { "ok" } else { "MISSING" }), $seconds, $(if ($attempts -gt 1) { "（复跑 $($attempts - 1) 次）" } else { "" }))
}

Step "tsc"      { npx tsc -b --pretty false }
Step "vitest"   { npx vitest run --configLoader runner }
Step "lib-skip" { cargo test --manifest-path $manifest --lib -- --skip dlssnr }
Step "lib-dlssnr" { cargo test --manifest-path $manifest --lib "dlssnr::" }
Step "center-op" { cargo test --manifest-path $manifest --lib -- --exact --test-threads=1 compute_center::tests::the_dlssnr_op_no_longer_computes_in_this_process }
Step "anim2"    { cargo test --manifest-path $manifest --lib -- --exact --test-threads=1 compute_center::tests::an_animated_page_reaches_dlssnr_as_an_animation }
Step "protocol" { cargo test --manifest-path $manifest -p yomika-compute-protocol }
Step "core-cpu" { cargo test --manifest-path $manifest -p yomika-compute-core --features cpu }
Step "core-dml" { cargo test --manifest-path $manifest -p yomika-compute-core --features directml }
# DLSSNR 引擎（8-g④）跟着核心走，所以它有自己的一段：NGX 垫片由那个 crate 的 build.rs
# 现编，`ngx_core` 那两条分支、设备/工作区的驻留规矩都在这一段里。
# `--nocapture` 不是为了日志好看：这一档里那几条真机守卫（COM 引用计数、取消保住工作区、
# 交回工作区、一次提交失败只丢那一份上下文）在没 DLL / GPU 起不来时会**自己打印跳过就走**，
# 而输出被捕获的话那份「跳过」根本进不了日志——下面 `core-dlssnr` 的空转判据就是一句空话。
Step "core-dlssnr" { cargo test --manifest-path $manifest -p yomika-compute-core --features dlssnr -- --nocapture }
# 第 17 步（8-g④-b1）：**不带任何 feature** 编一次核心，跑元数据那一半与它的
# `tests/dlssnr_metadata.rs`。宿主摘掉 `dlssnr` feature 之后仍然要用的东西（设置、变体
# 身份、产物身份、探针记账、合成图、status 的拼装）必须有它自己的证据——挂在 feature 上的
# 测试在这条路上一律不存在，`core-dlssnr` 那一段再绿也证明不了它们。
Step "core-meta" { cargo test --manifest-path $manifest -p yomika-compute-core --lib --test dlssnr_metadata }
# Anime4K 的 GPU 执行体（第 33 轮）：三条预设与 CPU 解释器逐像素对齐 + 分块管道隐形。
# 这一步要在**有显卡的机器上**真跑；拿不到设备时它打印「跳过：」——上面的 evidence 判据
# 会把那种空转当红（除非 YOMIKA_ALLOW_VACUOUS_GUARDS=1）。
Step "core-gpu" { cargo test --manifest-path $manifest -p yomika-compute-core --features anime4k-gpu --test anime4k_gpu -- --nocapture --test-threads=1 }
Step "worker"   { cargo test --manifest-path $manifest -p yomika-compute-worker }
Step "manager-it" { cargo test --manifest-path $manifest --test compute_manager }
# 第 19 步（9-c3）：§12.4 ⑥ 的 20 轮「启动计算 → 取消/强杀 → 重启 → 读同页」。
# 要 `--nocapture`：这一条的证据是它自己打出来的那一行（取消几次、强杀几次、熔断亮了几次），
# 只看 `1 passed` 会把「熔断那一段路到底走没走」漏掉——而那段路正是这条用例要压的。
Step "restart-it" { cargo test --manifest-path $manifest --test compute_restart_storm -- --nocapture --test-threads=1 }
# 远端那条路（8-h②）：真中心 + 真调度器 + 真 worker。远端请求要落在同一条调度/产物路上，
# 认证与 `/v2/ping` 在 worker 忙着的时候也要照答，掉一条连接只取消它自己那一次订阅。
Step "center-it" { cargo test --manifest-path $manifest --test remote_compute_center -- --test-threads=1 }
Step "chain-it" { cargo test --manifest-path $manifest --test compute_model_chain }
Step "proxy-it" { cargo test --manifest-path $manifest --test legacy_upscale_proxy }
Step "check-ws" { cargo check --manifest-path $manifest --workspace --all-targets }
# 第 20 步（9-d）：§12.3 第一条那句「submit/cancel/promote ACK p95<=100ms」在**调度器这一侧**
# 的读数。要 `--nocapture`：这一条的证据是它自己打出来的 p50/p95/p99，不是 `1 passed`——阈值
# 是三个数量级之外的护栏，绿了也说明不了数字在哪儿，而这一轮的报告要引用的正是那个数字。
#
# 排在最后是因为它最快、最便宜：上面那 19 步里任何一步红了，这一条也不该被拖住（它不是那条
# 路的证明）。名字同时要加进下面那张「每个日志的 test result」表里，顺序与这里一致。
Step "queue-ack" { cargo test --manifest-path $manifest --lib -- --exact --nocapture --test-threads=1 compute::scheduler::tests::the_acks_the_interface_waits_for_stay_under_the_ui_threshold }

Write-Host ""
if ($script:Steps.Count -eq 0) {
  Write-Host "没有任何一步真的跑了（-Only 写歪了？）：这是一次空跑，不是通过。"
  exit 9
}
Write-Host "=== 摘要 ==="
foreach ($step in $script:Steps) {
  Write-Host ("{0,-12} exit={1}  evidence={2}  -> {3}" -f $step.Name, $step.Code, $(if ($step.Evidence) { "ok" } else { "MISSING" }), $step.Log)
}
Write-Host ""
Write-Host "=== 每个日志的 test result / panic ==="
foreach ($name in @("tsc", "vitest", "lib-skip", "lib-dlssnr", "center-op", "anim2", "protocol", "core-cpu", "core-dml", "core-dlssnr", "core-meta", "core-gpu", "worker", "manager-it", "restart-it", "center-it", "chain-it", "proxy-it", "check-ws", "queue-ack")) {
  if ($Only.Count -gt 0 -and ($Only -notcontains $name)) { continue }
  $log = Join-Path $LogDir "$Label-$name.log"
  if (-not (Test-Path $log)) { continue }
  $results = (Select-String -Path $log -Pattern "test result:|Tests +[0-9]|Test Files|panicked at|^error" |
    ForEach-Object { $_.Line.Trim() })
  Write-Host "--- $name"
  if ($results.Count -eq 0) { Write-Host "    （没有 test result 行）" }
  foreach ($line in $results) { Write-Host "    $line" }
}

Write-Host ""
# 慢到快列一遍：整轮的账要能看出钱花在哪一步（`-Only` 迭代时也照打，方便对比）。
$slowest = @($script:Steps | Sort-Object -Property Seconds -Descending)
$total = [Math]::Round((($script:Steps | Measure-Object -Property Seconds -Sum).Sum), 1)
Write-Host ("耗时（合计 {0}s）：" -f $total)
foreach ($step in $slowest) { Write-Host ("  {0,7}s  {1}" -f $step.Seconds, $step.Name) }

Write-Host ""
$failed = @($script:Steps | Where-Object { $_.Code -ne 0 -or -not $_.Evidence })
if ($failed.Count -eq 0) {
  Write-Host "这一轮通过：$($script:Steps.Count) 步，每步 exit 0 且日志里有该有的字样。"
  exit 0
}
Write-Host "这一轮没通过：$($failed.Count) 步不对（exit≠0 或日志里缺字样）"
foreach ($step in $failed) {
  Write-Host ("  - {0}：exit={1}，evidence={2}" -f $step.Name, $step.Code, $(if ($step.Evidence) { "ok" } else { "MISSING" }))
}
exit 1
