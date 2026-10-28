#!/usr/bin/env python3
"""Stage pinned LiteRT + vendor native compilers (no Java or proprietary SDK needed)."""
import hashlib
import shutil
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
GOOGLE = 'https://dl.google.com/dl/android/maven2/com/google/ai/edge/litert'
PACKAGES = [
    ('litert', f'{GOOGLE}/litert/2.3.2/litert-2.3.2.aar', '4d1f26b47f89e501940cbfb6e165faf3e600a7213af02e9816d39a49614bf702'),
    ('litert-npu-runtime-qualcomm', f'{GOOGLE}/litert-npu-runtime-qualcomm/2.3.2/litert-npu-runtime-qualcomm-2.3.2.aar', '6808cd32464ebade002fbe8a5f6722a5002e608c33209db462845ee83c28bc8f'),
    ('litert-npu-runtime-mediatek', f'{GOOGLE}/litert-npu-runtime-mediatek/2.3.2/litert-npu-runtime-mediatek-2.3.2.aar', '415193f408fafef9ad3ef740e86e2a7bc9292789b0f243c025b18f2e07dbbc32'),
    ('qnn-runtime', 'https://repo.maven.apache.org/maven2/com/qualcomm/qti/qnn-runtime/2.51.0/qnn-runtime-2.51.0.aar', '6388face1d5aa5e8958d745e5a547e92b5bec6fc332dfb1b438b1e17ffa02861'),
]


def prepare():
    cache = ROOT / 'src-tauri/target'
    stage = ROOT / 'src-tauri/gen/android/app/src/main/jniLibs/arm64-v8a'
    stage.mkdir(parents=True, exist_ok=True)
    cache.mkdir(parents=True, exist_ok=True)
    for name, url, digest in PACKAGES:
        archive = cache / f'{name}.aar'
        if not archive.is_file() or hashlib.sha256(archive.read_bytes()).hexdigest() != digest:
            temporary = archive.with_suffix('.download')
            urllib.request.urlretrieve(url, temporary)
            if hashlib.sha256(temporary.read_bytes()).hexdigest() != digest:
                raise RuntimeError(f'{name}: native runtime fingerprint mismatch')
            temporary.replace(archive)
        notices = ROOT / 'src-tauri/gen/android/app/src/main/assets/licenses/npu' / name
        notices.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(archive) as source:
            for notice in ('LICENSE', 'LICENSE.pdf', 'NOTICE.txt', 'THIRD_PARTY_NOTICE.txt'):
                if notice in source.namelist():
                    (notices / notice).write_bytes(source.read(notice))
            for entry in source.infolist():
                if not entry.filename.startswith('jni/arm64-v8a/') or not entry.filename.endswith('.so'):
                    continue
                filename = Path(entry.filename).name
                # Only HTP is used. The GPU/DSP backends are unrelated payloads.
                if name == 'qnn-runtime' and not filename.startswith(('libQnnHtp', 'libQnnSystem')):
                    continue
                with source.open(entry) as data, (stage / filename).open('wb') as output:
                    shutil.copyfileobj(data, output)
        print(f'{name}: verified and staged')


if __name__ == '__main__':
    prepare()
