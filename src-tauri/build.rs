use std::path::{Path, PathBuf};
use std::process::Command;

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
    // 自己拼绝对路径而不是 canonicalize()：后者会给出 `\\?\E:\…` 这种带 verbatim
    // 前缀的路径，cl.exe 读不了（会报「无法打开源文件」）。
    let root = std::env::current_dir().expect("当前目录");
    let source = root.join("vendor/ngx/ngx_shim.c");
    let library = root.join("vendor/ngx/nvsdk_ngx_s.lib");

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

/// 给链接器一份应用清单：`tauri` 的 `tray-icon` 特性（Windows 上的托盘图标）经 `muda`
/// 从 comctl32 导入 `TaskDialogIndirect`，而它只存在于 **v6** 那一份——side-by-side
/// 程序集里的 comctl32。只有进程带清单声明了这个依赖，加载器才会去解析它；没有清单时
/// 绑定的是 system32 里的 v5，缺这个导出，进程在**加载阶段**就死掉
/// （0xc0000139 STATUS_ENTRYPOINT_NOT_FOUND）。
///
/// 这份清单本来由 tauri-build 作为**资源**塞进 `resource.lib`，而资源里的清单只跟着
/// bin 走：`cargo test` 编出来的二进制拿不到，于是整个 Rust 套件一行都跑不出来。改由
/// 链接器生成（`/MANIFESTINPUT`）就落在**每个**二进制上；代价是必须让 tauri-build 别
/// 再塞那份资源，否则同一个进程里两份 `RT_MANIFEST`（资源一份、链接器一份）会让
/// CVTRES 直接报 CVT1100（资源重复）——见 `main()` 里的 `try_build`。
///
/// 内容与 tauri-build 自己那份（`windows-app-manifest.xml`）逐字相同，所以应用的行为
/// 一点没变：清单里的依赖仍然只有 Common-Controls v6。
fn embed_windows_manifest() {
    const MANIFEST: &str = r#"<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <dependency>
    <dependentAssembly>
      <assemblyIdentity
        type="win32"
        name="Microsoft.Windows.Common-Controls"
        version="6.0.0.0"
        processorArchitecture="*"
        publicKeyToken="6595b64144ccf1df"
        language="*"
      />
    </dependentAssembly>
  </dependency>
</assembly>
"#;
    if std::env::var("CARGO_CFG_TARGET_ENV").as_deref() != Ok("msvc") {
        return;
    }
    let out = PathBuf::from(std::env::var("OUT_DIR").expect("OUT_DIR"));
    let manifest = out.join("yomika-app.manifest");
    if std::fs::write(&manifest, MANIFEST).is_err() {
        return;
    }
    println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
    println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
}

/// 编译时间与提交号：错误日志的「相关信息」里写的就是它们（`app_build_info` 读）。
///
/// 只在**重新编译**时更新，而那正是「这一份二进制是哪来的」的答案。取不到 git 就留空，
/// 界面按缺项处理，不编假值。
///
/// 构建脚本可以在编译前把这两项放进环境变量（`YOMIKA_BUILD_COMMIT` /
/// `YOMIKA_BUILD_TIME`）——那是**显式**输入，配合下面的 `rerun-if-env-changed`：提交号
/// 一变这一份 build script 就会重跑。只靠 `tauri.conf.json` 的时间戳是不够的（审计
/// P2-3：只改源码、没碰配置时，产物会留着上一个提交号）。
fn stamp_build_info() {
    let seconds = std::env::var("YOMIKA_BUILD_TIME")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| {
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|elapsed| elapsed.as_secs())
                .unwrap_or(0)
                .to_string()
        });
    println!("cargo:rustc-env=YOMIKA_BUILD_TIME={seconds}");
    let commit = std::env::var("YOMIKA_BUILD_COMMIT")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .or_else(|| {
            Command::new("git")
                .args(["rev-parse", "--short=12", "HEAD"])
                .output()
                .ok()
                .filter(|output| output.status.success())
                .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string())
                .filter(|value| !value.is_empty())
        })
        .unwrap_or_default();
    println!("cargo:rustc-env=YOMIKA_BUILD_COMMIT={commit}");
}

fn main() {
    // 只对 Windows 目标编：其它平台根本没有这条路径（`src/dlssnr` 整个模块不在）。
    // 编不出来就退化成「这个构建没有 NGX 核心」：DLSS5 那一组会明说原因，构建照常
    // 完成——离线、没有 MSVC 也能编译，而不是把整个应用卡住。
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        println!("cargo:rerun-if-changed=vendor/ngx/ngx_shim.c");
        println!("cargo:rerun-if-changed=vendor/ngx/nvsdk_ngx_s.lib");
        let ready = Path::new("vendor/ngx/nvsdk_ngx_s.lib").is_file()
            && Path::new("vendor/ngx/ngx_shim.c").is_file()
            && build_ngx_shim();
        if ready {
            println!("cargo:rustc-cfg=ngx_core");
        } else if !Path::new("vendor/ngx/nvsdk_ngx_s.lib").is_file() {
            println!(
                "cargo:warning=缺少 vendor/ngx/nvsdk_ngx_s.lib：这个构建没有 NGX 核心，DLSS5 会被跳过"
            );
        }
    }
    println!("cargo:rustc-check-cfg=cfg(ngx_core)");

    // 构建戳的显式输入：构建脚本会先把当前 HEAD 放进这个变量（见 `stamp_build_info`）。
    // 只改了源码、没碰 `tauri.conf.json` 与图标时，tauri-build 注册的
    // `rerun-if-changed` 不会让这一份 build script 重跑，产物就会带着**上一个**提交号；
    // 登记这两个变量之后，提交号一变这里必定重跑（审计 P2-3）。
    println!("cargo:rerun-if-env-changed=YOMIKA_BUILD_COMMIT");
    println!("cargo:rerun-if-env-changed=YOMIKA_BUILD_TIME");

    embed_windows_manifest();
    stamp_build_info();

    // 清单已交给链接器（见 `embed_windows_manifest`），所以让 tauri-build 别再往资源里
    // 塞一份：两份 `RT_MANIFEST` 会让 CVTRES 报 CVT1100（资源重复），应用直接链接失败。
    // 图标与版本信息仍然由它写进 `resource.lib`，只有清单这一项换成链接器生成、且因此
    // 也覆盖到测试二进制。
    let attributes = tauri_build::Attributes::new()
        .windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest());
    if let Err(error) = tauri_build::try_build(attributes) {
        panic!("tauri-build 失败：{error:#}");
    }
}
