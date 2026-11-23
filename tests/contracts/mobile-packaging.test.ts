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
  it('links mobile ORT API 27 from the pinned target build and packages its dependencies', () => {
    const core = read('../../src-tauri/crates/compute-core/Cargo.toml');
    expect(core).toContain('default-features = false, features = ["std", "ndarray", "tracing", "api-27"]');
    const prepare = read('../../.github/scripts/prepare-mobile-ort.py');
    expect(prepare).toContain('8f0278c77bf44b0cc83c098c6c722b92a36ac4b5');
    expect(prepare).toContain('#define ORT_API_VERSION 27');
    expect(prepare).toContain('"--use_nnapi"');
    expect(prepare).toContain('"--use_coreml"');
    expect(prepare).toContain('ORT_IOS_XCFWK_PATH');
    expect(prepare).toContain('libc++_shared.so');
    const workflow = read('../../.github/workflows/build-packages.yml');
    expect(workflow).toContain('prepare-mobile-ort.py android');
    expect(workflow).toContain('prepare-mobile-ort.py ios');
    expect(workflow).toContain('verify-mobile-runtime.py');
  });

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
    expect(cargo).toMatch(/\[profile\.release\]\r?\nstrip = "symbols"/);
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

    // The OS owns the branded launch; the activity supplies only a canvas.
    const drawable = read(`${res}/drawable/splash_background.xml`);
    expect(drawable).toContain('@color/splash_canvas');
    expect(drawable).not.toContain('@mipmap/');
    const activity = read('../../src-tauri/gen/android/app/src/main/java/app/yomika/reader/MainActivity.kt');
    const host = read('../../src-tauri/gen/android/app/src/main/java/app/yomika/reader/MobileHost.kt');
    expect(activity).toContain('getSharedPreferences("yomika_startup", MODE_PRIVATE)');
    expect(host).toContain('putString("canvas", background)');

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

  it('never compiles the same Android Rust library twice in one build', () => {
    // `tauri android build` 先自己编一遍 Rust 库，Gradle 的 rust 插件随后又编一遍
    // （实测一个平台 111.85 s 里有一半是白编的）。第一遍之后那个 .so 里已经有构建戳，
    // 所以第二遍按戳跳过。戳还必须由工作流**先**落进环境：Gradle 守护进程的环境里没有
    // `ORT_LIB_PATH`，它那一遍编出来的主库不会链 ONNX Runtime —— APK 里带着
    // libonnxruntime.so 却「加载主库直接失败」，就是这么来的。
    const gradle = read('../../src-tauri/gen/android/app/build.gradle.kts');
    expect(gradle).toContain('val androidBuildStamp = System.getenv("YOMIKA_BUILD_COMMIT")');
    expect(gradle).toContain('tasks.matching { it.name.startsWith("rustBuild") }.configureEach {');
    expect(gradle).toContain('onlyIf {');
    expect(gradle).toContain('../../../target/aarch64-linux-android/release/libyomika_lib.so');

    const workflow = read('../../.github/workflows/build-packages.yml');
    expect(workflow).toContain('YOMIKA_BUILD_COMMIT=$(git rev-parse --short=12 HEAD)');
    expect(workflow.indexOf('Pin the build stamp')).toBeLessThan(workflow.indexOf('npx tauri android build'));
  });

  it('fails a mobile build loudly when the runtime it is supposed to link is missing', () => {
    // ort-sys 找不到运行时时不报错，只留下一个链接期占位符（`src/link_error.rs`）：
    // 库编得出来、APK 也打得出来，装到设备上加载即失败。构建脚本要把这件事变成一句
    // 编译失败，并且说清缺的是哪个变量。
    const build = read('../../src-tauri/crates/compute-core/build.rs');
    expect(build).toContain('fn require_mobile_ort()');
    expect(build).toContain('require_mobile_ort();');
    expect(build).toContain('CARGO_FEATURE_ORT');
    // 断言整句 `var_os("…")` 而不是裸变量名：裸名会被 `ORT_LIB_PATH_UNUSED` 这种改名
    // 蒙过去（子串仍在），变异检查 m3 第一次就是这么假绿的。
    expect(build).toContain('std::env::var_os("ORT_LIB_PATH")');
    expect(build).toContain('std::env::var_os("ORT_LIB_LOCATION")');
    expect(build).toContain('std::env::var_os("ORT_IOS_XCFWK_PATH")');
    expect(build).toContain('prepare-mobile-ort.py');
  });

  it('proves the iOS library handed to Xcode links the runtime', () => {
    // iOS 的最终链接在 Xcode 那一侧（`-framework onnxruntime`），所以只能在真正交给
    // Xcode 的那份静态库上验：既要有对 ORT C API 的引用，也不能带着 ort-sys 的占位符。
    const workflow = read('../../.github/workflows/build-packages.yml');
    expect(workflow).toContain(
      'verify-mobile-runtime.py src-tauri/gen/apple/Externals/arm64/release/libapp.a --ios',
    );
    const verifier = read('../../.github/scripts/verify-mobile-runtime.py');
    expect(verifier).toContain('def verify_ios(path):');
    expect(verifier).toContain('OrtGetApiBase');
    expect(verifier).toContain('ort-sys crate could not link to ONNX Runtime');
  });
});

// Native Android owns the visual settle. Updating the React page window on
// release lets its slot cleanup interrupt the animation that's still drawing it.
it('publishes a native reader turn only when its visual settle finishes', () => {
  const reader = read('../../src-tauri/gen/android/app/src/main/java/app/yomika/reader/ReaderTiles.kt');
  const settle = reader.split('private fun finishSwipe(')[1]!.split('private fun tryTurn(')[0]!;
  const turn = reader.split('private fun tryTurn(')[1]!.split('private fun forward(')[0]!;
  expect(settle).toMatch(/view\.translationX = 0f[\s\S]+pair\.onSettled\?\.invoke\(\)/);
  expect(turn).toMatch(/requestPresentation\(id\)[\s\S]+onSettled = publishTurn[\s\S]+animateSwipe\([\s\S]+else \{\s+publishTurn\(\)/);
  expect(reader).toMatch(/MotionEvent\.ACTION_DOWN -> \{[\s\S]+?finishSwipe\("touch"\)[\s\S]+?down = MotionEvent\.obtain\(e\)/);
});

// The old slot's cleanup can run before React selects the newly shown slot.
it('moves Android gesture ownership in the same transaction as a ready same-page replacement', () => {
  const reader = read('../../src-tauri/gen/android/app/src/main/java/app/yomika/reader/ReaderTiles.kt');
  const present = reader.split('private fun updateUnderlay()')[1]!.split('private fun staticTileSize(')[0]!;
  expect(present).toMatch(/underlay = next[\s\S]*?if \(next != null && id != null\)[\s\S]*?if \(previous != null && slots\[selected\] === previous && previous\.tag == next\.tag\) \{\s+selected = id[\s\S]*?yomika-reader-tile-presented/);
});

it('returns an Android double-tap zoom to fit through the native animation', () => {
  const reader = read('../../src-tauri/gen/android/app/src/main/java/app/yomika/reader/ReaderTiles.kt');
  const doubleTap = reader.split('private fun doubleTap(')[1]!.split('private fun stopZoomAnimation(')[0]!;
  expect(doubleTap).toMatch(/val scale = if \(reset\) tiles\.minScale/);
  expect(doubleTap).toMatch(/ValueAnimator\.ofFloat[\s\S]*?setScaleAndCenter\(frame\.scale[\s\S]*?if \(zoomAnimation !== animation\) return[\s\S]*?if \(reset\) hide\(\)/);
});

it('previews Android page turns before touch slop and uses slop for release classification', () => {
  const reader = read('../../src-tauri/gen/android/app/src/main/java/app/yomika/reader/ReaderTiles.kt');
  const dispatch = reader.split('fun dispatch(e: MotionEvent')[1]!.split('private fun finishNativeTouch')[0]!;
  const move = dispatch.split('MotionEvent.ACTION_MOVE -> if (singleTouch)')[1]!.split('MotionEvent.ACTION_POINTER_DOWN,')[0]!;
  expect(move).toMatch(/val horizontal = kotlin\.math\.abs\(dx\) > kotlin\.math\.abs\(dy\)/);
  expect(move).toMatch(/if \(horizontalTurnDrag\)[\s\S]*?if \(previewSwipe\(e, dx, dy, normal\)\) return true/);
  expect(move.replace(/turnExceededSlop = .*\r?\n/, '')).not.toContain('touchSlop');
  expect(move).toMatch(/if \(webSwipe\) return normal\(e\)[\s\S]*?if \(active == null \|\| canSwipe\(active, dx, dy\)\)[\s\S]*?webSwipe = true/);
  expect(dispatch.split('MotionEvent.ACTION_UP -> if (singleTouch)')[1]).toMatch(/if \(webSwipe\)[\s\S]*?return result[\s\S]*?if \(tryTurn/);
  expect(dispatch).toMatch(/!turnExceededSlop[\s\S]*?finishSwipe\(\)[\s\S]*?normal\(start\)[\s\S]*?normal\(e\)/);
});

it('keeps a stationary black Android canvas behind translated native pages', () => {
  const reader = read('../../src-tauri/gen/android/app/src/main/java/app/yomika/reader/ReaderTiles.kt');
  const background = reader.split('private fun updateWebBackground()')[1]!.split('private fun placeContinuous')[0]!;
  expect(background).toMatch(/setBackgroundColor\(Color\.BLACK\)[\s\S]*?parent\.addView\(backdrop, 0,[\s\S]*?web\.setBackgroundColor\(Color\.TRANSPARENT\)/);
  expect(background).toMatch(/web\.background = previousWebBackground[\s\S]*?removeView\(backdrop\)/);
});

it('leaves iOS single-finger paging and panning on the same touch stream', () => {
  const gestures = read('../../src-tauri/src/native_reader/ios_host/pinch.rs');
  expect(gestures).toContain('UIPinchGestureRecognizer::initWithTarget_action');
  expect(gestures).toContain('recognizer.setCancelsTouchesInView(false)');
  expect(gestures).not.toContain('UIPanGestureRecognizer::initWithTarget_action');
});
