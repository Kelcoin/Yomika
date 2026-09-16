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
    expect(read('../../build_exe.bat')).toContain('.github\\scripts\\build-windows.ps1');
  });
});
