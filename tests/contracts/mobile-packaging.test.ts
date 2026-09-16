import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

function read(path: string): string {
  return readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(read(path)) as Record<string, unknown>;
}

describe('mobile packaging', () => {
  it('declares the feature the Tauri CLI switches on for release builds', () => {
    // `cfg(dev)` comes from this cargo feature, not from the debug/release profile: a
    // build without it is a development build, and on mobile that means every asset
    // request is proxied to `devUrl` instead of being served from the binary.
    expect(read('../../src-tauri/Cargo.toml')).toContain('custom-protocol = ["tauri/custom-protocol"]');
  });

  it('builds the iOS library in release mode with that feature', () => {
    const workflow = read('../../.github/workflows/build-packages.yml');

    // The iOS job rolls its own cargo invocation (the Tauri Xcode phase is disabled),
    // so it does not get the feature from the CLI and has to pass it explicitly.
    expect(workflow).toContain(
      'cargo build --release --target aarch64-apple-ios --features custom-protocol',
    );
    expect(workflow).toContain('src-tauri/target/aarch64-apple-ios/release');
  });

  it('writes the project icons into both generated mobile projects', () => {
    const workflow = read('../../.github/workflows/build-packages.yml');
    const runs = workflow.split('npx tauri icon src-tauri/icons/icon-manifest.json').length - 1;

    // `android init` / `ios init` each generate a project carrying Tauri's default
    // launcher icon; `tauri icon` is the step that replaces it with ours.
    expect(runs).toBe(2);
    expect(readJson('../../src-tauri/icons/icon-manifest.json')).toMatchObject({
      default: '../../assets/yomika-mark-print.svg',
      bg_color: '#0D0D0D',
      android_fg: 'android-foreground.svg',
    });
  });

  it('composes the Android launcher icon from our foreground and background', () => {
    const res = '../../src-tauri/gen/android/app/src/main/res';

    expect(read(`${res}/mipmap-anydpi-v26/ic_launcher.xml`)).toContain(
      '<foreground android:drawable="@mipmap/ic_launcher_foreground"/>',
    );
    // The template's leftover `drawable/ic_launcher_background.xml` (a green vector) and
    // its white `#fff` color are what made the icon look like a black square on a white
    // plate: the foreground must be the mark alone, over the app's own black.
    expect(read(`${res}/mipmap-anydpi-v26/ic_launcher.xml`)).toContain(
      '<background android:drawable="@color/ic_launcher_background"/>',
    );
    expect(read(`${res}/values/ic_launcher_background.xml`)).toContain('#0D0D0D');
  });
});
