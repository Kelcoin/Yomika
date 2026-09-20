import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("rust")
}

val tauriProperties = Properties().apply {
    val propFile = file("tauri.properties")
    if (propFile.exists()) {
        propFile.inputStream().use { load(it) }
    }
}

val releaseKeystore = rootProject.file("release.keystore")
val releaseStorePassword = System.getenv("ANDROID_KEYSTORE_PASSWORD")
val releaseKeyAlias = System.getenv("ANDROID_KEY_ALIAS")
val releaseKeyPassword = System.getenv("ANDROID_KEY_PASSWORD")

android {
    compileSdk = 36
    // Pinned to the NDK the mobile-build workflow installs; without this AGP
    // falls back to its own default NDK and auto-downloads it on CI.
    ndkVersion = "28.2.13676358"
    namespace = "app.yomika.reader"
    defaultConfig {
        manifestPlaceholders["usesCleartextTraffic"] = "false"
        applicationId = "app.yomika.reader"
        minSdk = 24
        targetSdk = 36
        versionCode = tauriProperties.getProperty("tauri.android.versionCode", "1").toInt()
        versionName = tauriProperties.getProperty("tauri.android.versionName", "1.0")
    }
    buildTypes {
        getByName("debug") {
            manifestPlaceholders["usesCleartextTraffic"] = "true"
            isDebuggable = true
            isJniDebuggable = true
            isMinifyEnabled = false
            packaging {                jniLibs.keepDebugSymbols.add("*/arm64-v8a/*.so")
                jniLibs.keepDebugSymbols.add("*/armeabi-v7a/*.so")
                jniLibs.keepDebugSymbols.add("*/x86/*.so")
                jniLibs.keepDebugSymbols.add("*/x86_64/*.so")
            }
        }
        getByName("release") {
            isMinifyEnabled = true
            if (releaseKeystore.exists() && releaseStorePassword != null && releaseKeyAlias != null && releaseKeyPassword != null) {
                signingConfig = signingConfigs.create("release") {
                    storeFile = releaseKeystore
                    storePassword = releaseStorePassword
                    keyAlias = releaseKeyAlias
                    keyPassword = releaseKeyPassword
                }
            }
            proguardFiles(
                *fileTree(".") { include("**/*.pro") }
                    .plus(getDefaultProguardFile("proguard-android-optimize.txt"))
                    .toList().toTypedArray()
            )
        }
    }
    kotlinOptions {
        jvmTarget = "1.8"
    }
    buildFeatures {
        buildConfig = true
    }
}

rust {
    rootDirRel = "../../../"
}

dependencies {
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("androidx.appcompat:appcompat:1.7.1")
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.lifecycle:lifecycle-process:2.10.0")
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.1.4")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.5.0")
}

apply(from = "tauri.build.gradle.kts")

// Release 的预编译原生库再 strip 一遍。
//
// AGP 那个 `stripUniversalReleaseDebugSymbols` 只处理它自己编出来的库：工程里的原生库是
// 以**预编译** jniLibs 的形式交进去的，实测它的输入与输出逐字节相同。于是 NDK 那份
// libc++_shared.so 原样进包——9.24MB 里有 7.6MB 是 DWARF（`.debug_info` / `.debug_loc` /
// `.debug_str`…），真正的代码只有 `.text` 0.55MB。而 APK 里原生库是不压缩存放的
// （`extractNativeLibs=false`，为了能从 APK 直接 mmap），这 7.6MB 就直接落到下载里。
//
// 在 merge / strip 两个中间产物目录里就地 strip：只掉调试信息与静态符号表，`.dynsym` /
// `.dynstr` 与 NEEDED 一个不少（实测 strip 后仍有 2505 个动态符号、3 条 NEEDED）。
// **不能**去 strip 源目录里那份：`app/src/main/jniLibs/arm64-v8a/libc++_shared.so` 是指向
// NDK sysroot 的符号链接，就地跑等于改掉本机的 NDK 安装。
//
// 只管 release：debug 变体要留着符号做 jni 调试（那正是 buildTypes.debug 里
// `keepDebugSymbols` 的用途）。找不到 llvm-strip 时只告警——包大一点，不该因此编不过。
fun yomikaStripNativeLibs(taskName: String, roots: List<File>, ndk: File?, log: org.gradle.api.logging.Logger) {
    val executable = if (System.getProperty("os.name").lowercase().contains("win")) "llvm-strip.exe" else "llvm-strip"
    val strip = ndk?.let { File(it, "toolchains/llvm/prebuilt").listFiles()?.map { dir -> File(dir, "bin/$executable") }?.firstOrNull { it.isFile } }
    if (strip == null) {
        log.warn("Yomika: llvm-strip not found (ndk=$ndk), native libs stay unstripped")
        return
    }
    val taskDirs = roots.filter { it.isDirectory }.flatMap { root -> root.walkTopDown().filter { it.isDirectory && it.name == taskName }.toList() }
    for (lib in taskDirs.flatMap { dir -> dir.walkTopDown().filter { it.isFile && it.extension == "so" }.toList() }) {
        val before = lib.length()
        val process = ProcessBuilder(strip.absolutePath, "--strip-all", lib.absolutePath).redirectErrorStream(true).start()
        val output = process.inputStream.bufferedReader().use { it.readText() }
        if (process.waitFor() != 0) {
            log.warn("Yomika: llvm-strip failed for ${lib.name}: $output")
        } else if (before != lib.length()) {
            log.lifecycle("Yomika: stripped ${lib.name} ${before / 1024}KB -> ${lib.length() / 1024}KB")
        }
    }
}

tasks.matching { it.name.endsWith("ReleaseNativeLibs") || it.name.endsWith("ReleaseDebugSymbols") }.configureEach {
    val roots = listOf(
        layout.buildDirectory.dir("intermediates/merged_native_libs").get().asFile,
        layout.buildDirectory.dir("intermediates/stripped_native_libs").get().asFile,
    )
    doLast {
        val ndk = try { android.ndkDirectory } catch (error: Exception) { null }
        yomikaStripNativeLibs(name, roots, ndk, logger)
    }
}
