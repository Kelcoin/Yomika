$ErrorActionPreference = 'Stop'
$targetDir = Join-Path ([IO.Path]::GetTempPath()) ('yomika-runtime-test-' + [guid]::NewGuid())
try {
    New-Item -ItemType Directory -Path $targetDir | Out-Null
    foreach ($name in @('yomika.exe', 'DirectML.dll', 'libonnxruntime.so', 'libonnxruntime.dylib', 'libdirectml.so')) {
        [IO.File]::WriteAllText((Join-Path $targetDir $name), 'fixture')
    }
    $source = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'build.ps1') -Raw
    $start = $source.IndexOf('    # Windows package keeps only Windows runtime libraries.')
    $end = $source.IndexOf('    # ort', $start)
    if ($start -lt 0 -or $end -lt 0) { throw 'Runtime cleanup block not found.' }
    & ([scriptblock]::Create($source.Substring($start, $end - $start)))
    foreach ($name in @('yomika.exe', 'DirectML.dll')) {
        if (-not (Test-Path -LiteralPath (Join-Path $targetDir $name))) { throw "Cleanup deleted $name" }
    }
    foreach ($name in @('libonnxruntime.so', 'libonnxruntime.dylib', 'libdirectml.so')) {
        if (Test-Path -LiteralPath (Join-Path $targetDir $name)) { throw "Cleanup retained $name" }
    }
    Write-Output 'Runtime cleanup preserves Windows artifacts.'
} finally {
    if (Test-Path -LiteralPath $targetDir) { Remove-Item -LiteralPath $targetDir -Recurse -Force }
}
