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

  it('strips the prebuilt native libraries that AGP leaves alone', () => {
    const gradle = read('../../src-tauri/gen/android/app/build.gradle.kts');
    const cargo = read('../../src-tauri/Cargo.toml');

    // 发布版的原生库不该带调试信息或静态符号表。APK 里它们是不压缩存放的
    // （extractNativeLibs=false，为的是能从 APK 直接 mmap），所以符号表有多大一目了然
    // 地落在下载里：改之前 .so 64.30MB（其中 17MB 是 .symtab/.strtab）。
    expect(cargo).toMatch(/\[profile\.release\]\nstrip = "symbols"/);
    // AGP 的 stripUniversalReleaseDebugSymbols 对**预编译** jniLibs 是空操作（实测它
    // 的输出与输入逐字节相同），所以 release 变体的中间产物要自己再 strip 一遍；
    // debug 变体不碰，jni 调试要留符号。
    expect(gradle).toMatch(/it\.name\.endsWith\("ReleaseNativeLibs"\) \|\| it\.name\.endsWith\("ReleaseDebugSymbols"\)/);
    expect(gradle).toContain('"--strip-all"');
    // 只动中间产物：源目录那份 libc++_shared.so 是指向 NDK sysroot 的符号链接，
    // 就地 strip 等于改掉本机的 NDK 安装。（注释里提到它不算——所以先去掉注释再判。）
    expect(gradle).toContain('intermediates/merged_native_libs');
    expect(gradle).toContain('intermediates/stripped_native_libs');
    expect(gradle.replace(/\/\/[^\n]*/g, '')).not.toContain('src/main/jniLibs');
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
