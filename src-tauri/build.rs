use std::path::PathBuf;
use std::process::Command;

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

/// 把编好的 worker 压进主 exe：交付只有**一个文件**，跑起来还是两个进程（`docs/71` §11
/// Task 10 第①条；解码那一端在 `src/compute/worker_binary.rs`）。
///
/// 什么时候嵌：`YOMIKA_EMBED_WORKER=1`（打包脚本设）。日常 `cargo test` 不嵌——一份
/// 24 MB 的载荷会让每个测试二进制都多背约 9 MB，而开发机上 worker 本来就并排躺在旁边，
/// 走的是「同级目录里已经有一份」那条路。
///
/// 找哪一份：`YOMIKA_WORKER_BINARY`（显式），否则按 cargo 的产物布局猜。开了开关却
/// 找不到就**让构建失败**：一份「说好是单文件、其实里面什么都没有」的宿主，比一次构建
/// 失败糟得多——前者要到用户点开阅读器时才发现。
fn embed_worker_binary() {
    println!("cargo:rerun-if-env-changed=YOMIKA_EMBED_WORKER");
    println!("cargo:rerun-if-env-changed=YOMIKA_WORKER_BINARY");
    let out = PathBuf::from(std::env::var("OUT_DIR").expect("OUT_DIR"));
    let generated = out.join("worker_payload.rs");
    // 只有 Windows 桌面那一份会带 worker：Android 上没有这个进程（也没有它的目标），
    // mac/Linux 没实测，谁都不该在这儿凭空多背一份引擎。
    let wanted = std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")
        && matches!(std::env::var("YOMIKA_EMBED_WORKER").as_deref(), Ok("1") | Ok("true"));
    if !wanted {
        std::fs::write(&generated, GENERATED_WITHOUT_WORKER).expect("写 worker_payload.rs");
        return;
    }
    let candidates: Vec<PathBuf> = std::env::var("YOMIKA_WORKER_BINARY")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .into_iter()
        .chain(worker_binary_candidates())
        .collect();
    let Some(worker) = candidates.iter().find(|path| path.is_file()) else {
        let looked: Vec<String> = candidates
            .iter()
            .map(|path| path.display().to_string())
            .collect();
        panic!(
            "YOMIKA_EMBED_WORKER 开着，却找不到 worker 可执行文件。找过：{}；先跑 .github/scripts/build-compute-worker.ps1（或者把 YOMIKA_WORKER_BINARY 指给它）。",
            looked.join("、")
        );
    };
    let bytes = std::fs::read(worker).expect("读 worker");
    let payload = pack_worker_payload(&bytes);
    let blob = out.join("worker_payload.bin");
    std::fs::write(&blob, &payload).expect("写 worker 载荷");
    // 换了一份 worker 就要重新嵌：这一条登记的是**源**（上面那个 blob 由它生成）。
    println!("cargo:rerun-if-changed={}", worker.display());
    std::fs::write(
        &generated,
        format!(
            "/// 编进主 exe 的 worker 载荷（`build.rs` 生成，解析在 `src/compute/worker_binary.rs`）。\n\
             pub static WORKER_PAYLOAD: &[u8] = include_bytes!(r\"{}\");\n",
            blob.display()
        ),
    )
    .expect("写 worker_payload.rs");
}

const GENERATED_WITHOUT_WORKER: &str =
    "/// 这一份宿主没背 worker（开发机构建，或者不是 Windows 桌面）：与从前一字不差的\n\
     /// 「同级目录里找 worker」那条路。\n\
     pub static WORKER_PAYLOAD: &[u8] = &[];\n";

/// cargo 把 worker 放在哪儿：默认 `target/<profile>/`；开发机常把 `CARGO_TARGET_DIR`
/// 指到别处，交叉编译还要多一层 target 三元组目录。
fn worker_binary_candidates() -> Vec<PathBuf> {
    let target_dir = match std::env::var("CARGO_TARGET_DIR") {
        Ok(dir) if !dir.trim().is_empty() => PathBuf::from(dir),
        _ => PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"))
            .join("target"),
    };
    let profile = std::env::var("PROFILE").unwrap_or_else(|_| "debug".to_string());
    let mut roots = Vec::new();
    if let (Ok(target), Ok(host)) = (std::env::var("TARGET"), std::env::var("HOST")) {
        if target != host {
            roots.push(target_dir.join(target));
        }
    }
    roots.push(target_dir);
    roots
        .into_iter()
        .map(|root| root.join(&profile).join("yomika-compute-worker.exe"))
        .collect()
}

/// 载荷容器的打包端。格式与 `src/compute/worker_binary.rs` 的解码端、以及
/// `.github/scripts/worker-payload.ps1` 里那份 PowerShell 解码逐字节相同（构建脚本与库是
/// 两个 crate，共用不了同一个函数，所以格式这一处是三份拷贝；真正证明它们对得上的是
/// 打包冷启动：宿主解出来的必须是能跑的那一份 exe）。
fn pack_worker_payload(bytes: &[u8]) -> Vec<u8> {
    use sha2::Digest;
    use std::io::Write;
    let mut encoder = flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::new(9));
    encoder.write_all(bytes).expect("压缩 worker");
    let compressed = encoder.finish().expect("压缩 worker");
    let mut header = Vec::new();
    header.extend_from_slice(b"YOMIKA-WORKER-PAYLOAD\x01");
    header.extend_from_slice(&(compressed.len() as u32).to_le_bytes());
    header.extend_from_slice(&(bytes.len() as u32).to_le_bytes());
    header.extend_from_slice(&sha2::Sha256::digest(bytes));
    header.extend_from_slice(&compressed);
    header
}

fn main() {
    // Native mobile code is linked into the app, never borrowed from the host.
    // ort-sys consumes the paths below before this build script executes.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("ios") {
        for framework in ["CoreML", "Metal", "Foundation", "Accelerate"] {
            println!("cargo:rustc-link-lib=framework={framework}");
        }
        println!("cargo:rustc-link-lib=c++");
    }
    // 构建戳的显式输入：构建脚本会先把当前 HEAD 放进这个变量（见 `stamp_build_info`）。
    // 只改了源码、没碰 `tauri.conf.json` 与图标时，tauri-build 注册的
    // `rerun-if-changed` 不会让这一份 build script 重跑，产物就会带着**上一个**提交号；
    // 登记这两个变量之后，提交号一变这里必定重跑（审计 P2-3）。
    println!("cargo:rerun-if-env-changed=YOMIKA_BUILD_COMMIT");
    println!("cargo:rerun-if-env-changed=YOMIKA_BUILD_TIME");

    // 上面那两条**不够**：`YOMIKA_BUILD_COMMIT` 是**打包脚本**才设的变量，日常 `cargo test`
    // 里是空的，提交号此时是这一份 build script 自己 `git rev-parse` 出来的——提交之后
    // 它一行输入都没变，cargo 不会重跑，产物于是带着**上一个**提交号。宿主与 worker 各拿
    // 一个旧戳时，握手那一步会把它们判成「不是同一次构建」而拒绝配对（2026-10-08 实测：
    // worker 停在 `04ddc5f…`、宿主已经是 `6ecea1b…`，`proxy-it` 整档红）。所以盯 `.git`
    // 里真正会变的那三处；**不能**盯整个 `.git`：objects 每提交都在动，那等于每次编译都要
    // 重跑 build script。
    for watched in ["../.git/HEAD", "../.git/refs/heads", "../.git/packed-refs"] {
        println!("cargo:rerun-if-changed={watched}");
    }

    embed_windows_manifest();
    stamp_build_info();
    // 嵌进去的那一份 worker 字节里带着**同一个**构建戳：`build-compute-worker.ps1` 与
    // 这里读的是同一个 `YOMIKA_BUILD_COMMIT`，两半对不上时握手会拒跑（Task 10 第②条）。
    embed_worker_binary();

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
