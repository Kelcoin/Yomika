param([Parameter(Mandatory=$true)][string]$TargetDir, [Parameter(Mandatory=$true)][ValidateSet('windows','macos','linux')][string]$Platform)
$ErrorActionPreference = 'Stop'
$patterns = switch ($Platform) {
  windows { @('*.dll') }
  macos { @('*.dylib') }
  linux { @('*.so','*.so.*') }
}
Get-ChildItem -LiteralPath $TargetDir -File -Recurse | Where-Object {
  $name = $_.Name.ToLowerInvariant()
  -not ($patterns | Where-Object { $name -like $_ })
} | Where-Object { $_.Name -match 'onnxruntime|directml|cuda|cudnn' } | Remove-Item -Force
Write-Output "Pruned runtime files for $Platform in $TargetDir"
