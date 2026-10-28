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
        assert "lib/arm64-v8a/libyomika_ncnn.so" in libraries, "APK omits Vulkan inference runtime"
        assert ort in libraries, "APK omits target ONNX Runtime"
        assert "lib/arm64-v8a/libc++_shared.so" in libraries, "APK omits C++ runtime"
        assert not any(name.endswith(".dll") for name in apk.namelist()), "Host DLL in APK"
        packaged = {Path(name).name for name in libraries}
        system = {"libandroid.so", "liblog.so", "libm.so", "libdl.so", "libc.so", "libz.so", "libvulkan.so", "libEGL.so", "libGLESv2.so", "libGLESv3.so", "libjnigraphics.so", "libmediandk.so", "libnativewindow.so", "libneuralnetworks.so"}
        for name in libraries:
            assert name.startswith("lib/arm64-v8a/"), f"Unexpected ABI: {name}"
            data = apk.read(name)
            if re.fullmatch(r"libQnnHtpV(?:68|69|73|75|79|81)Skel\.so", Path(name).name):
                # Signed Hexagon DSP payload, intentionally not an ARM library.
                assert data[:4] == b"\x7fELF" and struct.unpack_from("<H", data, 18)[0] == 164, f"Not Hexagon: {name}"
                continue
            assert data[:5] == b"\x7fELF\x02", f"Not ELF64: {name}"
            assert struct.unpack_from("<H", data, 18)[0] == 183, f"Not AArch64: {name}"
            extracted = Path(temp) / Path(name).name
            extracted.write_bytes(data)
            report = subprocess.check_output([readelf, "-d", str(extracted)], text=True)
            dependencies = set(re.findall(r"\(NEEDED\).*?\[(.*?)\]", report))
            if Path(name).name == "libyomika_lib.so":
                assert "libyomika_ncnn.so" in dependencies, "App is not linked to Vulkan inference runtime"
                assert "libonnxruntime.so" in dependencies, (
                    "App library is not linked to ONNX Runtime; copying the runtime into the APK "
                    "does not fix an ort-sys build without ORT_LIB_PATH"
                )
            for needed in dependencies:
                if needed == "libcdsprpc.so" and re.fullmatch(r"libQnnHtpV(?:68|69|73|75|79|81)Stub\.so", Path(name).name):
                    continue  # Optional vendor driver declared in AndroidManifest.xml.
                assert needed in packaged | system, f"Unpackaged dependency {needed} in {name}"
            if name == ort:
                symbols = subprocess.check_output([readelf, "--dyn-syms", "--wide", str(extracted)], text=True)
                for symbol in ("OrtGetApiBase", "OrtSessionOptionsAppendExecutionProvider_Nnapi"):
                    matches = [line for line in symbols.splitlines() if re.search(rf"\b{symbol}(?:@@\S+)?$", line)]
                    assert any(" UND " not in line for line in matches), f"Missing native export {symbol}"


MACHO_MAGICS = (b"\xcf\xfa\xed\xfe", b"\xce\xfa\xed\xfe", b"\xca\xfe\xba\xbe", b"\xbe\xba\xfe\xca")


def verify_ios(path):
    """iOS 静态库：既要真的引用 ORT 的 C API，又不能带着 ort-sys 的链接占位符。

    iOS 这一侧最终链接发生在 Xcode（`-framework onnxruntime`），所以 Rust 静态库里
    `_OrtGetApiBase` 以**未定义引用**出现才算对。ort-sys 找不到框架时留下的不是这个
    符号，而是一个名字里写着错误说明的假符号（`src/link_error.rs`）——Xcode 那一侧于是
    永远不去链真正的 ONNX Runtime，装到设备上就是「加载主库直接失败」的 iOS 版本。
    """
    blob = path.read_bytes()
    assert blob.startswith(b"!<arch>\n") or blob[:4] in MACHO_MAGICS, f"{path} is not a static archive or Mach-O"
    assert b"OrtGetApiBase" in blob, (
        f"{path} does not reference the ONNX Runtime C API: the Rust side was built without "
        "ORT_IOS_XCFWK_PATH, so -framework onnxruntime has nothing to resolve"
    )
    assert b"ort-sys crate could not link to ONNX Runtime" not in blob, (
        f"{path} carries ort-sys' link-error placeholder: the iOS build ran without "
        "ORT_IOS_XCFWK_PATH (see .github/scripts/prepare-mobile-ort.py ios)"
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("artifact", type=Path)
    parser.add_argument("--readelf", default="llvm-readelf")
    parser.add_argument("--ios", action="store_true", help="Verify an iOS static library instead of an APK")
    args = parser.parse_args()
    if args.ios:
        verify_ios(args.artifact)
        print("iOS static library references the real ONNX Runtime C API and carries no ort-sys placeholder.")
    else:
        verify_apk(args.artifact, args.readelf)
        print("APK ARM64 runtime and dependency closure verified; device execution remains required.")
