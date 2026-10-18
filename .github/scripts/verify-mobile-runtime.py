#!/usr/bin/env python3
"""Inspect packaged native code, without substituting host library checks."""
import argparse
from pathlib import Path
import re
import struct
import subprocess
import tempfile
import zipfile


def verify_apk(path, readelf):
    with zipfile.ZipFile(path) as apk, tempfile.TemporaryDirectory() as temp:
        libraries = [name for name in apk.namelist() if name.endswith(".so")]
        ort = "lib/arm64-v8a/libonnxruntime.so"
        assert ort in libraries, "APK omits target ONNX Runtime"
        assert "lib/arm64-v8a/libc++_shared.so" in libraries, "APK omits C++ runtime"
        assert not any(name.endswith(".dll") for name in apk.namelist()), "Host DLL in APK"
        packaged = {Path(name).name for name in libraries}
        system = {"libandroid.so", "liblog.so", "libm.so", "libdl.so", "libc.so", "libz.so", "libvulkan.so", "libEGL.so", "libGLESv2.so", "libGLESv3.so", "libjnigraphics.so", "libmediandk.so", "libnativewindow.so"}
        for name in libraries:
            assert name.startswith("lib/arm64-v8a/"), f"Unexpected ABI: {name}"
            data = apk.read(name)
            assert data[:5] == b"\x7fELF\x02", f"Not ELF64: {name}"
            assert struct.unpack_from("<H", data, 18)[0] == 183, f"Not AArch64: {name}"
            extracted = Path(temp) / Path(name).name
            extracted.write_bytes(data)
            report = subprocess.check_output([readelf, "-d", str(extracted)], text=True)
            for needed in re.findall(r"\(NEEDED\).*?\[(.*?)\]", report):
                assert needed in packaged | system, f"Unpackaged dependency {needed} in {name}"
            if name == ort:
                symbols = subprocess.check_output([readelf, "--dyn-syms", "--wide", str(extracted)], text=True)
                for symbol in ("OrtGetApiBase", "OrtSessionOptionsAppendExecutionProvider_Nnapi"):
                    matches = [line for line in symbols.splitlines() if re.search(rf"\b{symbol}(?:@@\S+)?$", line)]
                    assert any(" UND " not in line for line in matches), f"Missing native export {symbol}"


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("apk", type=Path)
    parser.add_argument("--readelf", default="llvm-readelf")
    args = parser.parse_args()
    verify_apk(args.apk, args.readelf)
    print("APK ARM64 runtime and dependency closure verified; device execution remains required.")
