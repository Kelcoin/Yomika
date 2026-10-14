import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

function read(path: string): string {
  return readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');
}

// 路径先落进变量再交给 `new URL`：直接写字面量时 Vite 会把它当成静态资源改写成一个
// 非 file 的方案，`fileURLToPath` 于是抛 `The URL must be of scheme file`。
function pathOf(path: string): string {
  return fileURLToPath(new URL(path, import.meta.url));
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
      // 打包的图标源是**从母版派生的那一份**（`.github/scripts/derive-logo.mjs`），
      // 不是母版本身：母版里的颜色是 YOMIKA_PLATE / YOMIKA_INK 两个槽名，打包器
      // 认不了，只有派生文件才是字面量墨色。这一条与「一份几何，处处派生」那条
      // 契约（tests/design-system-contract.test.ts）配套，改一处必须改两处。
      default: 'app-icon.svg',
      bg_color: '#0D0D0D',
      android_fg: 'android-foreground.svg',
    });
  });

  it('keeps the fallback mobile icon set identical to the generated one', () => {
    // `tauri icon` writes into the **generated** project when one exists, and only falls
    // back to `src-tauri/icons/android` when it doesn't. 这个仓库两样都有，于是同一次
    // 派生会落成两份拷贝——而只有 gen/ 那份会随每次 `tauri icon` 更新，icons/android
    // 那份会**静静地停在上一代几何上**（实测就是这样：改完母版重生成之后，20 张
    // mipmap 全部与 gen/ 不一致，其中前景层还是描边版的旧字形）。`android init` 恰恰
    // 是从 icons/android 拷贝的，所以漂移的那份会把旧字形重新种回新工程里。
    //
    // 判据不是"看起来像"，是逐字节相同——两份拷贝没有理由不同。
    const fallback = '../../src-tauri/icons/android';
    const generated = '../../src-tauri/gen/android/app/src/main/res';
    const densities = ['mdpi', 'hdpi', 'xhdpi', 'xxhdpi', 'xxxhdpi'];
    const variants = [
      'ic_launcher.png',
      'ic_launcher_round.png',
      'ic_launcher_foreground.png',
      'ic_launcher_monochrome.png',
    ];
    const files = [
      ...densities.flatMap((density) => variants.map((v) => `mipmap-${density}/${v}`)),
      'mipmap-anydpi-v26/ic_launcher.xml',
      'values/ic_launcher_background.xml',
    ];
    for (const rel of files) {
      const a = readFileSync(pathOf(`${fallback}/${rel}`));
      const b = readFileSync(pathOf(`${generated}/${rel}`));
      expect(a.equals(b), `${rel} 在 icons/android 与 gen/android 之间已经漂移`).toBe(true);
    }
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

  it('keeps the Android splash on the app canvas in every theme variant', () => {
    const res = '../../src-tauri/gen/android/app/src/main/res';

    // 画布色＝应用主题的 --surface-canvas（tokens.css 的浅色 :88 / 深色 :473），
    // 不是品牌 Canvas #0B0B0F：应用主题默认跟随系统，钉死品牌色时浅色机器上窗口背景
    // 是近黑、网页帧是近白，用户看到的就是两张开屏页（doc 30）。
    expect(read(`${res}/values/colors.xml`)).toMatch(/<color name="splash_canvas">#fbf8f3<\/color>/);
    expect(read(`${res}/values-night/colors.xml`)).toMatch(/<color name="splash_canvas">#121412<\/color>/);
    // 注释里可以提品牌 Canvas，画布色本身不行。
    expect(read(`${res}/values/colors.xml`)).not.toMatch(/<color name="splash_canvas">#0B0B0F<\/color>/);

    // 每个主题变体都要有窗口背景：夜间那份从前一个 item 都没有，于是回落父主题，
    // 深色机器冷启动先白一帧，再接 webview 的深色帧。
    for (const variant of ['values', 'values-night']) {
      expect(read(`${res}/${variant}/themes.xml`)).toMatch(
        /<item name="android:windowBackground">@drawable\/splash_background<\/item>/,
      );
    }

    // Android 12+ 的系统开屏：version 变体与 night+version 变体都要齐。资源限定符里
    // night 优先于 version，只留 values-v31 时夜间机器会把这三条整份丢掉。
    for (const variant of ['values-v31', 'values-night-v31']) {
      const theme = read(`${res}/${variant}/themes.xml`);
      expect(theme).toContain('<item name="android:windowSplashScreenBackground">@color/splash_canvas</item>');
      // 图标要带印板（自适应图标＝`#0D0D0D` 印板 + 白线条）：画布现在是浅色，
      // 只画前景那几根白线在浅底上等于没画。
      expect(theme).toContain('<item name="android:windowSplashScreenAnimatedIcon">@mipmap/ic_launcher</item>');
    }

    // 窗口背景里那张印记要与网页帧同尺寸：网页帧的印板是 128px，自适应图标 108dp 画布
    // 里裁出来的印板是 2/3，所以 item 给 192dp（192 × 2/3 = 128）。从前是 96dp 且不带
    // 印板，印记既小一截又看不见。
    const drawable = read(`${res}/drawable/splash_background.xml`);
    expect(drawable).toContain('android:width="192dp"');
    expect(drawable).toContain('android:height="192dp"');
    expect(drawable).toContain('android:drawable="@mipmap/ic_launcher"');
    expect(drawable).not.toContain('ic_launcher_foreground');

    // WebView 一挂上就用自己的背景色盖住窗口背景，而它到页面画出首帧之间有一段空档：
    // 不透明时印记在那段里整个消失（用户看到的就是「闪一下又出来」）。alpha 0 会被
    // Tauri 采纳成透明的 webview 层，窗口背景（画布 + 印记）继续透出来。
    const config = JSON.parse(read('../../src-tauri/tauri.conf.json')) as {
      app: { windows: { backgroundColor?: string }[] };
    };
    expect(config.app.windows[0]?.backgroundColor).toBe('#0B0B0F00');
  });

  it('keeps double hyphens out of the Android resource comments', () => {
    // aapt 的资源合并直接拒绝这种注释（`注释中不允许出现字符串 "--"`），而且它只在真的
    // 跑 gradle 时才咬人：`npx vitest` 读的是文本，一路绿，Android 构建却在这里红
    // （2026-10-12 那一轮就栽在 values/colors.xml 的注释里写着 `--surface-canvas`）。
    // XML 注释里写 CSS 自定义属性名要省掉那两个连字符。
    const root = pathOf('../../src-tauri/gen/android/app/src/main/res');
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.xml')) files.push(full);
      }
    };
    walk(root);
    expect(files.length).toBeGreaterThan(10);

    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      for (const comment of text.matchAll(/<!--([\s\S]*?)-->/g)) {
        const body = comment[1] ?? '';
        if (body.includes('--')) offenders.push(`${file.slice(root.length + 1)}: ${body.trim().slice(0, 48)}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
