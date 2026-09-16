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
} finally {
    Pop-Location
    $env:Path = $oldPath
}
