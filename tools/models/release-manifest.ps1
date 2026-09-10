param(
  [Parameter(Mandatory=$true)][string]$Tag,
  [string]$ModelRoot = "docs/Aletheia-Lens/_internal/models-fp16",
  [string]$LicensePath = "docs/Aletheia-Lens/LICENSE",
  [string]$Output = "src-tauri/resources/models/$Tag.manifest.json"
)
$ErrorActionPreference = 'Stop'
$assets = Get-ChildItem -LiteralPath $ModelRoot -File -Recurse | ForEach-Object {
  $relative = [IO.Path]::GetRelativePath($ModelRoot, $_.FullName).Replace('\','/')
  $hash = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
  # GitHub Release preserves an asset's filename, not the source directory.
  # Keep the bundle path in `path` and publish a flat, collision-free name.
  [ordered]@{ role = if ($relative -like 'mrcnn/*') {'detector'} elseif ($relative -like 'deepcreampy/*') {'inpainting'} else {'upscaler'}; path = $relative; downloadName = $relative.Replace('/','--'); size = $_.Length; sha256 = $hash; companions = @() }
}
if (Test-Path -LiteralPath $LicensePath -PathType Leaf) {
  $licenseHash = (Get-FileHash -LiteralPath $LicensePath -Algorithm SHA256).Hash.ToLowerInvariant()
  $assets += [ordered]@{ role = 'license'; path = 'LICENSE'; downloadName = 'Aletheia-Lens-LICENSE'; size = (Get-Item -LiteralPath $LicensePath).Length; sha256 = $licenseHash; companions = @() }
}
$manifest = [ordered]@{ tag = $Tag; assets = @($assets) }
$parent = Split-Path -Parent $Output
New-Item -ItemType Directory -Force $parent | Out-Null
$manifest | ConvertTo-Json -Depth 8 | Set-Content -Encoding UTF8 $Output
Write-Output "Manifest: $Output"
Write-Output "Upload each source file using its downloadName from the manifest."
