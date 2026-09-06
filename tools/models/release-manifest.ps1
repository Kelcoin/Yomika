param(
  [Parameter(Mandatory=$true)][string]$Tag,
  [string]$ModelRoot = "docs/Aletheia-Lens/_internal/models-fp16",
  [string]$Output = "src-tauri/resources/models/$Tag.manifest.json"
)
$ErrorActionPreference = 'Stop'
$assets = Get-ChildItem -LiteralPath $ModelRoot -File -Recurse | ForEach-Object {
  $relative = [IO.Path]::GetRelativePath($ModelRoot, $_.FullName).Replace('\','/')
  $hash = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
  [ordered]@{ role = if ($relative -like 'mrcnn/*') {'detector'} elseif ($relative -like 'deepcreampy/*') {'inpainting'} else {'upscaler'}; path = $relative; size = $_.Length; sha256 = $hash; companions = @() }
}
$manifest = [ordered]@{ tag = $Tag; assets = @($assets) }
$parent = Split-Path -Parent $Output
New-Item -ItemType Directory -Force $parent | Out-Null
$manifest | ConvertTo-Json -Depth 8 | Set-Content -Encoding UTF8 $Output
Write-Output "Manifest: $Output"
Write-Output "Upload assets with: gh release upload $Tag <model-files>"
