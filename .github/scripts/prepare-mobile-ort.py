#!/usr/bin/env python3
"""Build the API-27 target runtime; emit Cargo environment into GITHUB_ENV.

Requires Python, Git, CMake and Ninja, plus the platform SDK. No prebuilt host
runtime is accepted. Git object identity pins source; ORT's CMake dependency
manifest pins and verifies its third-party downloads.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]
REVISION = "8f0278c77bf44b0cc83c098c6c722b92a36ac4b5"
VERSION = "1.27.0"


def run(*args):
    subprocess.run([str(a) for a in args], check=True)


def stage_library(source, destination):
    # Tauri may have left an SDK symlink here. Replace the link itself; never
    # follow it and overwrite the developer's NDK installation.
    if destination.is_symlink():
        destination.unlink()
    shutil.copy2(source, destination)


def reuse_android(output):
    """Reuse only a complete, fingerprinted target build, and restage JNI files."""
    manifest_path = output / "android-runtime.json"
    if not manifest_path.is_file():
        return None
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    expected = {"version": VERSION, "revision": REVISION, "api": 27, "platform": "android"}
    if any(manifest.get(key) != value for key, value in expected.items()):
        raise RuntimeError("Cached mobile ORT source/API identity mismatch; rebuild the runtime")
    native = output / "android/Release/libonnxruntime.so"
    data = native.read_bytes()
    if hashlib.sha256(data).hexdigest() != manifest.get("sha256"):
        raise RuntimeError("Cached mobile ORT checksum mismatch; rebuild the runtime")
    if data[:5] != b"\x7fELF\x02" or int.from_bytes(data[18:20], "little") != 183:
        raise RuntimeError("Cached mobile ORT is not an Android ARM64 library")
    stage = ROOT / "src-tauri/gen/android/app/src/main/jniLibs/arm64-v8a"
    stage.mkdir(parents=True, exist_ok=True)
    stage_library(native, stage / native.name)
    ndk = Path(os.environ["ANDROID_NDK_HOME"])
    host = "windows-x86_64" if sys.platform == "win32" else ("darwin-x86_64" if sys.platform == "darwin" else "linux-x86_64")
    stage_library(ndk / "toolchains/llvm/prebuilt" / host / "sysroot/usr/lib/aarch64-linux-android/libc++_shared.so", stage / "libc++_shared.so")
    return {"ORT_SKIP_DOWNLOAD": "1", "ORT_LIB_PATH": str(native.parent), "ORT_PREFER_DYNAMIC_LINK": "1"}


def prepare(platform, output):
    output = output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    source = output / "source"
    if not source.exists():
        run("git", "-c", "http.version=HTTP/1.1", "clone", "--depth", "1", "--branch", f"v{VERSION}", "--no-checkout",
            "https://github.com/microsoft/onnxruntime.git", source)
    run("git", "-C", source, "checkout", "--detach", REVISION)
    actual = subprocess.check_output(["git", "-C", str(source), "rev-parse", "HEAD"], text=True).strip()
    if actual != REVISION:
        raise RuntimeError("ORT source identity mismatch")
    run("git", "-C", source, "diff", "--exit-code", "HEAD", "--")
    run("git", "-C", source, "submodule", "update", "--init", "--recursive")
    header = (source / "include/onnxruntime/core/session/onnxruntime_c_api.h").read_text()
    if "#define ORT_API_VERSION 27" not in header:
        raise RuntimeError("Pinned ORT does not implement API 27")
    build = output / platform
    cmake = shutil.which("cmake")
    if not cmake:
        import cmake as cmake_package
        cmake = str(Path(cmake_package.CMAKE_BIN_DIR) / ("cmake.exe" if sys.platform == "win32" else "cmake"))
    args = [sys.executable, source / "tools/ci_build/build.py", "--build_dir", build,
            "--config", "Release", "--update", "--build", "--parallel", os.environ.get("YOMIKA_ORT_BUILD_JOBS", "2"), "--skip_tests",
            "--cmake_path", cmake,
            "--cmake_extra_defines", "onnxruntime_BUILD_UNIT_TESTS=OFF"]
    env = {"ORT_SKIP_DOWNLOAD": "1"}
    if platform == "android":
        if not shutil.which("ninja"):
            import ninja
            os.environ["PATH"] = ninja.BIN_DIR + os.pathsep + os.environ["PATH"]
        sdk = Path(os.environ.get("ANDROID_HOME", os.environ.get("ANDROID_SDK_ROOT", "")))
        ndk = Path(os.environ.get("ANDROID_NDK_HOME", str(sdk / "ndk/28.2.13676358")))
        if not (ndk / "source.properties").is_file():
            raise RuntimeError("Set ANDROID_NDK_HOME to NDK 28.2.13676358")
        args += ["--android", "--android_sdk_path", sdk, "--android_ndk_path", ndk,
                 "--android_abi", "arm64-v8a", "--android_api", "24", "--use_nnapi",
                 "--build_shared_lib", "--android_cpp_shared", "--cmake_generator", "Ninja"]
        run(*args)
        native = build / "Release/libonnxruntime.so"
        stage = ROOT / "src-tauri/gen/android/app/src/main/jniLibs/arm64-v8a"
        stage.mkdir(parents=True, exist_ok=True)
        stage_library(native, stage / native.name)
        host = "windows-x86_64" if sys.platform == "win32" else ("darwin-x86_64" if sys.platform == "darwin" else "linux-x86_64")
        stage_library(ndk / "toolchains/llvm/prebuilt" / host / "sysroot/usr/lib/aarch64-linux-android/libc++_shared.so", stage / "libc++_shared.so")
        env.update(ORT_LIB_PATH=str(native.parent), ORT_PREFER_DYNAMIC_LINK="1")
    else:
        if sys.platform != "darwin":
            raise RuntimeError("iOS runtime requires macOS and Xcode")
        args += ["--ios", "--cmake_generator", "Xcode", "--apple_sysroot", "iphoneos", "--osx_arch", "arm64",
                 "--apple_deploy_target", "14.0", "--use_coreml", "--build_apple_framework", "--build_shared_lib"]
        run(*args)
        frameworks = list(build.glob("**/static_framework/onnxruntime.framework"))
        if len(frameworks) != 1:
            raise RuntimeError(f"Expected one device framework: {frameworks}")
        native = frameworks[0] / "onnxruntime"
        if not native.read_bytes().startswith(b"!<arch>\n"):
            raise RuntimeError("iOS delivery requires the static framework archive")
        xcf = output / "onnxruntime.xcframework"
        if xcf.exists():
            raise RuntimeError(f"Remove old {xcf} before rebuilding")
        run("xcodebuild", "-create-xcframework", "-framework", frameworks[0], "-output", xcf)
        env["ORT_IOS_XCFWK_PATH"] = str(xcf)
    manifest = {"version": VERSION, "revision": REVISION, "api": 27,
                "platform": platform, "sha256": hashlib.sha256(native.read_bytes()).hexdigest()}
    (output / f"{platform}-runtime.json").write_text(json.dumps(manifest, indent=2) + "\n")
    for key, value in env.items():
        print(f"{key}={value}")
    if os.environ.get("GITHUB_ENV"):
        with open(os.environ["GITHUB_ENV"], "a", encoding="utf-8") as handle:
            handle.writelines(f"{key}={value}\n" for key, value in env.items())
    return env


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("platform", choices=["android", "ios"])
    parser.add_argument("--output", type=Path, default=ROOT / "src-tauri/target/mobile-ort")
    parser.add_argument("--reuse-if-valid", action="store_true")
    parser.add_argument("--env-file", type=Path, help="Write the target Cargo environment as JSON")
    options = parser.parse_args()
    output = options.output.resolve()
    env = reuse_android(output) if options.reuse_if_valid and options.platform == "android" else None
    if env is None:
        env = prepare(options.platform, output)
    if options.env_file:
        options.env_file.parent.mkdir(parents=True, exist_ok=True)
        options.env_file.write_text(json.dumps(env, indent=2) + "\n", encoding="utf-8")
