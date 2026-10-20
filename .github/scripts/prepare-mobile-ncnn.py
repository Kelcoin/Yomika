#!/usr/bin/env python3
"""Prepare the pinned ARM64 Android Vulkan runtime and export Cargo's link path."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[2]
VERSION = '20260113'
SHA256 = '41944630a7b305b190e7caea4b405bc6d103c6383dc4988e9e85616058e3cccd'
URL = f'https://github.com/Tencent/ncnn/releases/download/{VERSION}/ncnn-{VERSION}-android-vulkan.zip'


def prepare(output, smoke=False):
    output = output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    archive = output / 'sdk.zip'
    if not archive.is_file() or hashlib.sha256(archive.read_bytes()).hexdigest() != SHA256:
        temporary = output / 'sdk.download'
        urllib.request.urlretrieve(URL, temporary)
        if hashlib.sha256(temporary.read_bytes()).hexdigest() != SHA256:
            temporary.unlink()
            raise RuntimeError('ncnn Android SDK checksum mismatch')
        temporary.replace(archive)
    sdk = output / f'ncnn-{VERSION}-android-vulkan'
    # Always extract the verified archive; never trust an arbitrary preinstalled SDK.
    with zipfile.ZipFile(archive) as source:
        source.extractall(output)
    sdk_root = Path(os.environ.get('ANDROID_HOME', os.environ.get('ANDROID_SDK_ROOT', str(Path(os.environ.get('LOCALAPPDATA', '')) / 'Android/Sdk'))))
    ndk = Path(os.environ.get('ANDROID_NDK_HOME', str(sdk_root / 'ndk/28.2.13676358')))
    if not (ndk / 'build/cmake/android.toolchain.cmake').is_file():
        raise RuntimeError('Install Android NDK 28.2.13676358 or set ANDROID_NDK_HOME')
    cmake = shutil.which('cmake')
    ninja = shutil.which('ninja')
    if not cmake:
        candidates = sorted((sdk_root / 'cmake').glob('*/bin/cmake*'))
        if candidates:
            cmake = str(candidates[-1])
            ninja = str(candidates[-1].parent / ('ninja.exe' if sys.platform == 'win32' else 'ninja'))
        else:
            import cmake as package
            cmake = str(Path(package.CMAKE_BIN_DIR) / ('cmake.exe' if sys.platform == 'win32' else 'cmake'))
    if not ninja:
        import ninja as package
        ninja = str(Path(package.BIN_DIR) / ('ninja.exe' if sys.platform == 'win32' else 'ninja'))
    build = output / 'build'
    subprocess.run([cmake, '-S', str(ROOT / 'src-tauri/crates/compute-core/native/ncnn'), '-B', str(build), '-G', 'Ninja',
                    f'-DCMAKE_MAKE_PROGRAM={ninja}', f'-DCMAKE_TOOLCHAIN_FILE={ndk}/build/cmake/android.toolchain.cmake',
                    '-DANDROID_ABI=arm64-v8a', '-DANDROID_PLATFORM=android-24', '-DANDROID_STL=c++_shared',
                    '-DCMAKE_BUILD_TYPE=Release', f'-DNCNN_SDK_DIR={sdk}', f'-DYOMIKA_NCNN_SMOKE={"ON" if smoke else "OFF"}'], check=True)
    subprocess.run([cmake, '--build', str(build), '--parallel', '2'], check=True)
    native = build / 'libyomika_ncnn.so'
    stage = ROOT / 'src-tauri/gen/android/app/src/main/jniLibs/arm64-v8a'
    stage.mkdir(parents=True, exist_ok=True)
    destination = stage / native.name
    if destination.is_symlink():
        destination.unlink()
    shutil.copy2(native, destination)
    environment = {'YOMIKA_NCNN_LIB_DIR': str(build)}
    (output / 'cargo-env.json').write_text(json.dumps(environment, indent=2), encoding='utf-8')
    if os.environ.get('GITHUB_ENV'):
        with open(os.environ['GITHUB_ENV'], 'a', encoding='utf-8') as file:
            for key, value in environment.items():
                file.write(f'{key}={value}\n')
    return environment


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=ROOT / 'src-tauri/target/mobile-ncnn')
    parser.add_argument('--smoke', action='store_true')
    args = parser.parse_args()
    print(json.dumps(prepare(args.output, args.smoke)))
