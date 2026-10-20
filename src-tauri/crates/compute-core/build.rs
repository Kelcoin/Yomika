//! 核心的构建脚本只做一件事：把 NGX 垫片（`src-tauri/vendor/ngx/ngx_shim.c` + NVIDIA 的
//! `nvsdk_ngx_s.lib`）编成一个小 DLL，好让 `dlssnr/ngx.rs` 的 `include_bytes!` 有东西可嵌。
//!
//! 为什么由**核心**编而不是宿主编：`docs/71` Task 8 的出口要求宿主不再持有 NGX 资源，
//! 而 NGX 只能在计算进程里初始化——引擎因此住在核心这一层（`src/dlssnr/mod.rs` 的抬头），
//! 垫片跟着引擎走：它在哪一份二进制里，NGX 就在哪一份里。宿主那边不再编它。
//!
//! 这里编不出来不是错误：退化成「这个构建没有 NGX 核心」，DLSS5 那一组会明说原因，
//! 离线、没有 MSVC 也照样能编译（和搬过来之前的行为一致）。

use std::path::{Path, PathBuf};
use std::process::Command;

/// 仓库里 `vendor/ngx/` 的位置。构建脚本的当前目录是 `CARGO_MANIFEST_DIR`
/// （= `src-tauri/crates/compute-core`），所以往上两级才是 `src-tauri/`。
fn vendor_ngx() -> PathBuf {
    PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join("vendor/ngx")
}

/// 把 NGX 核心垫片编成一个小 DLL：`vendor/ngx/ngx_shim.c` + NVIDIA 的
/// `nvsdk_ngx_s.lib`（DLSS SDK 静态库，/MT）。为什么要垫这一层见那份 .c 的抬头。
///
/// 不能用 `cc::Build::compile`：那个函数只会编出目标文件交给 Rust 的链接步骤，而
/// 我们需要的是一个独立的 DLL（/MT 的世界要关在它自己里面）。所以这里自己调
/// `cl.exe /LD`——工具链位置交给 `cc` 去问 VS 注册表，省得自己找 vswhere。
fn build_ngx_shim() -> bool {
    let target = std::env::var("TARGET").unwrap_or_default();
    let Some(tool) = cc::windows_registry::find_tool(&target, "cl.exe") else {
        println!("cargo:warning=找不到 cl.exe（MSVC 工具链）：这个构建没有 NGX 核心，DLSS5 会被跳过");
        return false;
    };
    let out = PathBuf::from(std::env::var("OUT_DIR").expect("OUT_DIR"));
    // 自己拼路径而不是 canonicalize()：后者会给出 `\\?\E:\…` 这种带 verbatim
    // 前缀的路径，cl.exe 读不了（会报「无法打开源文件」）。
    let vendor = vendor_ngx();
    let source = vendor.join("ngx_shim.c");
    let library = vendor.join("nvsdk_ngx_s.lib");

    let mut command = Command::new(tool.path());
    for (key, value) in tool.env() {
        command.env(key, value);
    }
    let output = command
        .current_dir(&out)
        // /LD 出 DLL，/MT 与静态库一致（这才是垫这一层的原因），/utf-8 是因为那份
        // .c 的注释是 UTF-8，/O2 放开优化。
        .args(["/nologo", "/LD", "/O2", "/MT", "/W3", "/utf-8"])
        .arg("/Fe:yomika_ngx.dll")
        .arg("/Fo:ngx_shim.obj")
        .arg(&source)
        .arg("/link")
        // /WHOLEARCHIVE：SDK 的全局对象（注册表/日志/特性注册表）初始化在别的
        // .obj 里，按需链接会把它们丢掉，跑起来就是「读 0x0」。
        .arg(format!("/WHOLEARCHIVE:{}", library.display()))
        // SDK 自己要用注册表（找 NGX 的安装路径）与 user32 里的进程信息。
        .args(["advapi32.lib", "user32.lib", "/MAP:yomika_ngx.map"])
        .output();
    match output {
        Ok(result) if result.status.success() && out.join("yomika_ngx.dll").is_file() => true,
        Ok(result) => {
            // 编译失败也要留一个（空的）目标文件：`ngx.rs` 用 include_bytes!
            // 把它嵌进二进制，文件不存在就是编译错误，而不是「这个构建没有核心」。
            let _ = std::fs::write(out.join("yomika_ngx.dll"), b"");
            let stdout = String::from_utf8_lossy(&result.stdout);
            let stderr = String::from_utf8_lossy(&result.stderr);
            println!(
                "cargo:warning=编 NGX 垫片失败（{}）：{}{}",
                result.status,
                stdout.trim().replace('\n', " | "),
                stderr.trim().replace('\n', " | ")
            );
            false
        }
        Err(error) => {
            let _ = std::fs::write(out.join("yomika_ngx.dll"), b"");
            println!("cargo:warning=调 cl.exe 失败：{error}");
            false
        }
    }
}

fn main() {
    // `ngx.rs` 的两条路（真的有垫片 / 只有一句「这个构建没有核心」）由这个 cfg 选，
    // 登记一次省得 check-cfg 在别的目标上抱怨。
    println!("cargo:rustc-check-cfg=cfg(ngx_core)");

    require_mobile_ort();
    link_mobile_ncnn();

    // 只对 Windows 目标编，而且只有开了 `dlssnr` 才有那个模块（没开时
    // `include_bytes!` 根本不会被求值，编了也没人要）。
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows") {
        return;
    }
    if std::env::var_os("CARGO_FEATURE_DLSSNR").is_none() {
        return;
    }

    let vendor = vendor_ngx();
    println!("cargo:rerun-if-changed={}", vendor.join("ngx_shim.c").display());
    println!("cargo:rerun-if-changed={}", vendor.join("nvsdk_ngx_s.lib").display());
    let library = vendor.join("nvsdk_ngx_s.lib");
    let ready = Path::new(&library).is_file()
        && Path::new(&vendor.join("ngx_shim.c")).is_file()
        && build_ngx_shim();
    if ready {
        println!("cargo:rustc-cfg=ngx_core");
    } else if !library.is_file() {
        println!(
            "cargo:warning=缺少 src-tauri/vendor/ngx/nvsdk_ngx_s.lib：这个构建没有 NGX 核心，DLSS5 会被跳过"
        );
    }
}

/// 移动端开了 `ort` 就必须能在**编译时**找到 ONNX Runtime。
///
/// `ort-sys` 找不到时不会报错：它把错误藏成一个链接期占位符（`link_error_generic`，
/// 见 `src/link_error.rs`）——共享库里留成未定义符号，于是 `cargo build` 绿、APK 也打
/// 出来了，装到手机上 `System.loadLibrary` 直接失败（实测：`libyomika_lib.so` 的
/// NEEDED 里没有 `libonnxruntime.so`，`OrtGetApiBase` 是 `UND`）。这里把它变成一句能
/// 读懂的编译失败：缺哪个变量，消息里就写哪个。
///
/// 变量名取自 `ort-sys` 的 `build/vars.rs`（`ORT_LIB_PATH` / `ORT_LIB_LOCATION`）与
/// `src/link_error.rs`（iOS 用 `ORT_IOS_XCFWK_PATH`）。两者都由
/// `.github/scripts/prepare-mobile-ort.py` 产出：本地 Android 构建走 `build-android.ps1`
/// （它把 `cargo-env.json` 读进进程环境），CI 走工作流里那一步。
fn require_mobile_ort() {
    let target = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    if target != "android" && target != "ios" {
        return;
    }
    if std::env::var_os("CARGO_FEATURE_ORT").is_none() {
        return;
    }
    let linked = std::env::var_os("ORT_LIB_PATH").is_some()
        || std::env::var_os("ORT_LIB_LOCATION").is_some()
        || std::env::var_os("ORT_IOS_XCFWK_PATH").is_some();
    if linked {
        return;
    }
    panic!(
        "这个 {target} 构建开了 `ort`，但既没有 ORT_LIB_PATH / ORT_LIB_LOCATION（Android）\
         也没有 ORT_IOS_XCFWK_PATH（iOS）：ort-sys 会退化成链接期占位符，库编得出来、\
         装到设备上却加载失败。先跑 `.github/scripts/prepare-mobile-ort.py {target}`\
         （本地 Android 构建脚本已内置这一步）。"
    );
}

fn link_mobile_ncnn() {
    println!("cargo:rerun-if-env-changed=YOMIKA_NCNN_LIB_DIR");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("android") || std::env::var_os("CARGO_FEATURE_NCNN_VULKAN").is_none() { return; }
    let dir = std::env::var("YOMIKA_NCNN_LIB_DIR").expect("Run prepare-mobile-ncnn.py / build-android.ps1 before building Android");
    assert!(Path::new(&dir).join("libyomika_ncnn.so").is_file(), "Missing Android Vulkan runtime");
    println!("cargo:rustc-link-search=native={dir}");
    println!("cargo:rustc-link-lib=dylib=yomika_ncnn");
}
