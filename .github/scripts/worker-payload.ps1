# 读主 exe 里那份 worker 载荷：交付只有一个文件，跑起来还是两个进程。
#
# 载荷容器的格式在三处各写了一遍，必须逐字节相同：
#   * 打包端 src-tauri/build.rs 的 pack_worker_payload
#   * 解码端 src-tauri/src/compute/worker_binary.rs 的 unpack
#   * 这一份（给打包自检、清单与冷启动用）
# 布局：记号 22 字节（`YOMIKA-WORKER-PAYLOAD` 21 个字母 + 0x01）+ u32 压缩长度 + u32 原始长度 + 32 字节 sha256(原始) + deflate 正文。
# 三份拷贝对得上与否，最终由打包冷启动证明：宿主解出来的必须是能跑起来、戳也对的那一份。
#
# 这个文件可以当库用（`. <这个文件>` 之后调 Read-WorkerPayload），也可以直接跑：
# `pwsh -File worker-payload.ps1 -HostExePath <yomika.exe>`。
#
# 参数刻意不叫 `-Path`／`-Package`：这个文件是被点源进调用者的作用域里的，而调用者
# （verify-compute-package.ps1、release-manifest.ps1）自己就有同名的参数——点源一次就
# 会把它们清成空串。
[CmdletBinding()]
param([string] $HostExePath = '')

$script:PayloadMagic = 'YOMIKA-WORKER-PAYLOAD' + [char]0x01
$script:PayloadHeader = 22 + 4 + 4 + 32

function Read-WorkerPayload {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)] [string] $HostExe)

    $missing = @{ Ok = $false; Reason = ''; Bytes = $null; Digest = '' }
    if (-not (Test-Path -LiteralPath $HostExe -PathType Leaf)) {
        $missing.Reason = "找不到这一份主 exe：$HostExe"
        return $missing
    }
    try {
        $bytes = [System.IO.File]::ReadAllBytes($HostExe)
    } catch {
        $missing.Reason = "读不了主 exe：$($_.Exception.Message)"
        return $missing
    }
    # Latin-1 是逐字节的：这样 IndexOf 找记号时不会因为 UTF-8 多字节而被挪位。
    $latin = [System.Text.Encoding]::GetEncoding(28591).GetString($bytes)
    $at = $latin.IndexOf($script:PayloadMagic, [System.StringComparison]::Ordinal)
    if ($at -lt 0) {
        $missing.Reason = '主 exe 里没有 worker 载荷（这一份没带 worker）'
        return $missing
    }
    $head = $at + $script:PayloadMagic.Length
    if ($bytes.Length -lt $head + 40) {
        $missing.Reason = '载荷头被截断了'
        return $missing
    }
    $packedLength = [System.BitConverter]::ToUInt32($bytes, $head)
    $rawLength = [System.BitConverter]::ToUInt32($bytes, $head + 4)
    $expected = [byte[]]::new(32)
    [Array]::Copy($bytes, $head + 8, $expected, 0, 32)
    $blobAt = $head + 40
    if ($bytes.Length -lt $blobAt + $packedLength) {
        $missing.Reason = "载荷正文被截断了（头说 $packedLength 字节，文件里只剩 $($bytes.Length - $blobAt)）"
        return $missing
    }
    $slice = [byte[]]::new($packedLength)
    [Array]::Copy($bytes, $blobAt, $slice, 0, $packedLength)
    try {
        $input = [System.IO.MemoryStream]::new($slice)
        $inflate = [System.IO.Compression.DeflateStream]::new($input, [System.IO.Compression.CompressionMode]::Decompress)
        $output = [System.IO.MemoryStream]::new()
        try {
            $inflate.CopyTo($output)
            $raw = $output.ToArray()
        } finally {
            $inflate.Dispose()
            $input.Dispose()
            $output.Dispose()
        }
    } catch {
        $missing.Reason = "载荷解不开：$($_.Exception.Message)"
        return $missing
    }
    if ($raw.Length -ne $rawLength) {
        $missing.Reason = "解出来 $($raw.Length) 字节，载荷头说 $rawLength"
        return $missing
    }
    $actual = [System.Security.Cryptography.SHA256]::Create().ComputeHash($raw)
    for ($index = 0; $index -lt 32; $index++) {
        if ($actual[$index] -ne $expected[$index]) {
            $missing.Reason = '解出来的字节与载荷头里的摘要对不上'
            return $missing
        }
    }
    return @{
        Ok     = $true
        Reason = "载荷完好：$($raw.Length) 字节"
        Bytes  = $raw
        Digest = (($actual | ForEach-Object { $_.ToString('x2') }) -join '')
    }
}

if ($HostExePath) {
    $reading = Read-WorkerPayload -HostExe $HostExePath
    if ($reading.Ok) {
        Write-Host "$($reading.Reason)；sha256 $($reading.Digest)"
    } else {
        Write-Host "[BAD] $($reading.Reason)"
        exit 1
    }
}
