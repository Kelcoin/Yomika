param(
  [Parameter(Mandatory=$true)][string]$Tag,
  [string]$ModelRoot = "docs/Aletheia-Lens/_internal/models-fp16",
  [string]$LicensePath = "docs/Aletheia-Lens/LICENSE",
  # Not named $Output: that collides with PowerShell's automatic variable.
  [string]$ManifestOutput = "src-tauri/resources/models/$Tag.manifest.json"
)
$ErrorActionPreference = 'Stop'
$rootFullPath = (Resolve-Path -LiteralPath $ModelRoot).Path.TrimEnd('\')
$assets = Get-ChildItem -LiteralPath $ModelRoot -File -Recurse | ForEach-Object {
  # Windows PowerShell 5 has no [IO.Path]::GetRelativePath; trim the root prefix.
  $relative = $_.FullName.Substring($rootFullPath.Length + 1).Replace('\', '/')
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
$parent = Split-Path -Parent $ManifestOutput
New-Item -ItemType Directory -Force $parent | Out-Null
$manifest | ConvertTo-Json -Depth 8 | Set-Content -Encoding UTF8 $ManifestOutput
Write-Output "Manifest: $ManifestOutput"
Write-Output "Upload each source file using its downloadName from the manifest."
