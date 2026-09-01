[CmdletBinding()]
param(
    [switch]$Release,
    [switch]$SkipFrontend,
    [switch]$Clean,
    [switch]$UseHostTools,
    [string]$ToolchainRoot
)

$ErrorActionPreference = "Stop"
$ToolchainRoot = if ($ToolchainRoot) { $ToolchainRoot } else { Join-Path $PSScriptRoot "toolchain" }
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path

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
    }
    if (-not $SkipFrontend) {
        & $npm run build
    }
    $tauriArgs = @("run", "tauri", "build", "--", "--ci")
    if (-not $Release) {
        $tauriArgs += "--debug"
    }
    & $npm @tauriArgs
    if ($LASTEXITCODE -ne 0) { throw "Tauri build failed with exit code $LASTEXITCODE." }
    $configuration = if ($Release) { "release" } else { "debug" }
    $output = Join-Path $repoRoot "src-tauri\target\$configuration\yomika.exe"
    Write-Host "Windows portable executable: $output"
} finally {
    Pop-Location
    $env:Path = $oldPath
}
