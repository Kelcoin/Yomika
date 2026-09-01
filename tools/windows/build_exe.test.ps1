$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$entrypoint = Join-Path $repoRoot 'build_exe.bat'

if (-not (Test-Path -LiteralPath $entrypoint -PathType Leaf)) {
    throw "Missing local EXE build entrypoint: $entrypoint"
}

$content = Get-Content -LiteralPath $entrypoint -Raw
if ($content -notmatch 'pushd "%~dp0"') {
    throw 'The entrypoint must run from the repository root.'
}
if ($content -notmatch 'tools\\windows\\build\.ps1') {
    throw 'The entrypoint must invoke tools\\windows\\build.ps1.'
}
if ($content -notmatch '%\*') {
    throw 'The entrypoint must forward caller arguments to the PowerShell build script.'
}
