//! 只做一件事：给 worker 编进一份构建戳（Task 10 第 2 条）。
//!
//! 宿主那一份在 `src-tauri/build.rs` 里，用的是同一个环境变量、同一段「缺省取 git」的
//! 逻辑——两处必须逐字同意，否则「主 exe 与 worker 构建戳一致」就成了一句空话。抄一份
//! 而不是共享一个 crate：这两个 build script 属于两个不同的包，共享就得再添一个只为了
//! 几十行的 crate；而这里真正要防的是**漂移**，防它的手段是打包脚本一次构建里给两半
//! 同一个 `YOMIKA_BUILD_COMMIT`，以及 `verify-compute-package.ps1` 把两串都读出来比。
//!
//! 没有它的时候 worker exe 里一个戳都没有（`YOMIKA_BUILD_COMMIT` 字面量 0 次），
//! 于是 `verify-build-stamp.ps1` 对这个文件无从下手，宿主也无法判断手里的 worker 是不是
//! 自己这一次构建出来的。

use std::process::Command;

/// 编译时间与提交号，与宿主 `build.rs` 的 `stamp_build_info` 同源同名。
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
    // 提交号一变就重跑：只改源码、没碰别的东西时，产物会带着**上一个**提交号，
    // 而那正好是最容易骗过「两半戳一致」检查的一种现场。
    println!("cargo:rerun-if-env-changed=YOMIKA_BUILD_COMMIT");
    println!("cargo:rerun-if-env-changed=YOMIKA_BUILD_TIME");
    // 与宿主那一份同样的理由（见 `src-tauri/build.rs` 里那段注释）：没有打包脚本设
    // `YOMIKA_BUILD_COMMIT` 时，提交号是这里 `git rev-parse` 出来的，而「提交」这件事本身
    // 不改这一份脚本的任何输入——不盯 `.git` 里那三处，worker 就会带着上一个提交号的戳，
    // 与宿主判不成「同一次构建」（2026-10-08 实测撞到）。
    for watched in ["../../.git/HEAD", "../../.git/refs/heads", "../../.git/packed-refs"] {
        println!("cargo:rerun-if-changed={watched}");
    }
    // 戳变了要跟着重编的是 `lib.rs` 里那一条 `env!`（`main.rs` 只是引那个常量），
    // 不需要把整个 worker 拖下水。
    println!("cargo:rerun-if-changed=build.rs");

    stamp_build_info();
}
