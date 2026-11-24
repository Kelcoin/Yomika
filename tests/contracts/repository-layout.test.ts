import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

function read(path: string): string {
  return readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(read(path)) as Record<string, unknown>;
}

// Through a variable on purpose: a literal url inside `new URL(…, import.meta.url)`
// is an asset reference that Vite rewrites at transform time.
function exists(path: string): boolean {
  return existsSync(fileURLToPath(new URL(path, import.meta.url)));
}

describe('repository layout', () => {
  it('ships the MIT license the manifests declare', () => {
    const license = read('../../LICENSE');

    expect(license).toContain('MIT License');
    expect(license).toContain('Copyright (c) 2026 Yomika contributors');
    expect(license).toContain('Permission is hereby granted, free of charge');
    expect(license).toContain('WITHOUT WARRANTY OF ANY KIND');
    expect(readJson('../../package.json')).toMatchObject({ license: 'MIT' });
    expect(read('../../src-tauri/Cargo.toml')).toContain('license = "MIT"');
    expect(read('../../README.md')).toContain('## 许可证');
  });

  it('keeps local tooling out of the tree but the Windows build script in it', () => {
    const ignore = read('../../.gitignore');
    const workflow = read('../../.github/workflows/build-packages.yml');

    // `tools/` holds the portable toolchain, the local entrypoint wrapper and one-off
    // packaging scripts: none of it belongs in the repository.
    expect(ignore).toMatch(/^\/tools\/$/m);
    expect(ignore).not.toMatch(/^\/tools\/windows\//m);
    // The one piece CI needs is checked in outside that directory, and both the
    // packaging job and the local build_exe.bat run this same file.
    expect(workflow).toContain('.github/scripts/build-windows.ps1');
    expect(exists('../../.github/scripts/build-windows.ps1')).toBe(true);
    // 本地编 Android 走同一套路：脚本进仓库，入口 bat 与 SDK 一样留在本地。
    expect(exists('../../.github/scripts/build-android.ps1')).toBe(true);
    expect(ignore).toMatch(/^\/build_apk\.bat$/m);
    expect(read('../../build_exe.bat')).toContain('.github\\scripts\\build-windows.ps1');
  });

  it('publishes versioned packages and keeps the release to one build', () => {
    const workflow = read('../../.github/workflows/build-packages.yml');
    const publish = read('../../.github/scripts/publish-assets.sh');

    // One publish per platform; the script owns naming and cleanup.
    expect(workflow.split('bash .github/scripts/publish-assets.sh').length - 1).toBe(3);
    // app-test is the rolling test draft; real releases name their tag explicitly.
    expect(workflow).toContain("default: 'app-test'");
    // Android ships as an APK only: an .aab cannot be installed by hand, and the app
    // is not published on Google Play.
    expect(workflow).toContain('npx tauri android build --ci --apk --target aarch64');
    expect(workflow).not.toContain('--aab');

    // yomika-<version>-<sha>-<platform>.<ext> — name, version, commit, platform,
    // extension last, the order Node, ripgrep and uv use. The SHA-256 of each
    // package is reported in the run summary instead of a sidecar file.
    expect(publish).toContain("require('./src-tauri/tauri.conf.json').version");
    expect(publish).toContain('git rev-parse --short=8 HEAD');
    expect(publish).toContain('name="yomika-${version}-${sha}-${platform}.${package##*.}"');
    expect(publish).not.toContain('$name.sha256');
    expect(publish).toContain('GITHUB_STEP_SUMMARY');
    // Only this platform's earlier assets are dropped, so the three jobs can run
    // at the same time and the release still ends up holding the newest build.
    expect(publish).toContain('gh release delete-asset');
    expect(publish).toContain('yomika-*"$platform"*');
    // prepare-release creates the draft up front, but it can be deleted while the
    // run is going — that is how the iOS package once failed to attach with
    // "release not found" at the end of an otherwise good build.
    expect(exists('../../.github/scripts/ensure-release.sh')).toBe(true);
    expect(publish).toContain('ensure-release.sh');
  });

  it('keeps the test runner out of the build directory', () => {
    const config = read('../../vitest.config.ts');
    const prepare = read('../../.github/scripts/prepare-mobile-ort.py');

    // `prepare-mobile-ort.py` extracts the pinned ONNX Runtime **source tree**
    // under `src-tauri/target/mobile-ort*/`，and that tree ships its own Detox
    // e2e `*.test.js` (it needs a device). Sweeping it turns the whole run red
    // on someone else's test, so the build directory has to stay excluded.
    expect(prepare).toContain('mobile-ort');
    expect(config).toContain("'src-tauri/target/**'");
    // 参考项目的只读副本同理：`docs/` 里的测试也不是我们该跑的。
    expect(config).toContain("'docs/**'");
  });
});
