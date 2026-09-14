[CmdletBinding()]
param(
  [string]$Tag = 'models-v1',
  [string]$Repository = 'Kelcoin/Yomika-Models',
  [string]$ModelRoot = 'docs/Aletheia-Lens/_internal/models'
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$modelRoot = Join-Path $repoRoot $ModelRoot
$releaseDir = Join-Path $repoRoot "artifacts\model-release\$Tag"
$manifest = Join-Path $releaseDir "$Tag.manifest.json"

if (-not (Test-Path -LiteralPath $modelRoot -PathType Container)) {
  throw "Aletheia-Lens model directory not found: $modelRoot"
}

& (Join-Path $PSScriptRoot 'release-manifest.ps1') -Tag $Tag -ModelRoot $modelRoot -Output $manifest
if ($LASTEXITCODE -ne 0) { throw 'Failed to generate model release manifest.' }

$release = Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json
foreach ($asset in $release.assets) {
  $source = if ($asset.path -eq 'LICENSE') {
    Join-Path $repoRoot 'docs\Aletheia-Lens\LICENSE'
  } else {
    Join-Path $modelRoot ($asset.path.Replace('/', [IO.Path]::DirectorySeparatorChar))
  }
  $target = Join-Path $releaseDir $asset.downloadName
  Copy-Item -LiteralPath $source -Destination $target -Force
}

$assetPaths = @($manifest) + @($release.assets | ForEach-Object { Join-Path $releaseDir $_.downloadName })
& gh release view $Tag --repo $Repository *> $null
if ($LASTEXITCODE -ne 0) {
  & gh release create $Tag --repo $Repository --title "Aletheia Lens model bundle $Tag" --notes "Aletheia-Lens GPL-3.0 model bundle for Yomika."
  if ($LASTEXITCODE -ne 0) { throw "Failed to create GitHub release $Tag." }
}

& gh release upload $Tag @assetPaths --repo $Repository --clobber
if ($LASTEXITCODE -ne 0) { throw "Failed to upload model release assets for $Tag." }

Write-Output "Published model release $Tag to $Repository."
