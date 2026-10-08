//! 宿主授权输入的边界（docs/71 §7.1、§7.2）。
//!
//! 这些用例是纯逻辑，但必须落在**真的文件系统**上：要验的东西（reparse point、
//! 段尾空格点、设备名、硬链接）都不是字符串问题，用假的路径糊过去等于没测。
//! 每个用例自己造一个沙箱目录，互不干扰（`--test-threads` 随便跑）。

use std::fs;
use std::path::{Path, PathBuf};

use yomika_compute_core::inputs::{
    resolve_granted, verify_file, InputError, MAX_RELATIVE_PATH_BYTES,
};

const CONTENT: &[u8] = b"yomika-compute-input";

fn sandbox(tag: &str) -> PathBuf {
    let root = std::env::temp_dir().join(format!("yomika-inputs-{}-{tag}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(&root).expect("造沙箱目录");
    root
}

fn write(root: &Path, relative: &str, bytes: &[u8]) -> PathBuf {
    let path = root.join(relative);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).expect("造父目录");
    }
    fs::write(&path, bytes).expect("写文件");
    path
}

fn blake3_hex(bytes: &[u8]) -> String {
    blake3::hash(bytes).to_hex().to_string()
}

#[test]
fn a_granted_file_inside_the_root_resolves_and_verifies() {
    let root = sandbox("ok");
    write(&root, "in/page.png", CONTENT);

    let path = resolve_granted(&root, "in/page.png").expect("授权文件应当解析成功");
    assert_eq!(fs::read(&path).expect("读回来"), CONTENT);
    verify_file(&path, &blake3_hex(CONTENT), CONTENT.len() as u64).expect("hash 与长度都对");
}

#[test]
fn a_nested_grant_is_resolved_under_the_root() {
    let root = sandbox("nested");
    let path = write(&root, "a/b/c/deep.bin", CONTENT);
    let real_root = fs::canonicalize(&root).expect("解析沙箱根");

    let resolved = resolve_granted(&root, "a/b/c/deep.bin").expect("应当解析成功");
    assert!(
        resolved.starts_with(&real_root),
        "解析结果 {} 必须仍在授权根 {} 之内",
        resolved.display(),
        real_root.display()
    );
    assert_eq!(fs::canonicalize(&path).expect("解析原路径"), resolved);
}

#[test]
fn an_absolute_path_is_refused() {
    let root = sandbox("absolute");
    for relative in [
        "C:\\Windows\\win.ini",
        "c:/windows/win.ini",
        "\\\\server\\share\\page.png",
        "/etc/passwd",
    ] {
        let error = resolve_granted(&root, relative).expect_err(relative);
        assert!(
            matches!(
                error,
                InputError::NotRelative { .. } | InputError::ForbiddenChar { .. }
            ),
            "{relative} 应当被判成不是相对路径，实际 {error:?}"
        );
    }
}

#[test]
fn a_path_that_asks_for_the_parent_is_refused() {
    let root = sandbox("parent");
    write(&root, "inside.png", CONTENT);
    // 沙箱的上一级是临时目录，那里确实有东西——正因为如此，越界必须被拒。
    fs::write(root.parent().expect("临时目录").join("yomika-inputs-outside.png"), CONTENT)
        .expect("造一个越界目标");

    for relative in ["../yomika-inputs-outside.png", "a/../../outside.png", "..\\outside.png", "."]
    {
        let error = resolve_granted(&root, relative).expect_err(relative);
        assert!(
            matches!(error, InputError::NotRelative { .. }),
            "{relative} 应当被拒，实际 {error:?}"
        );
    }
}

#[test]
fn an_alternate_data_stream_or_drive_letter_is_refused() {
    let root = sandbox("ads");
    write(&root, "page.png", CONTENT);
    for relative in ["page.png:stream", "page.png::$DATA", "C:page.png"] {
        let error = resolve_granted(&root, relative).expect_err(relative);
        assert!(
            matches!(error, InputError::ForbiddenChar { ch: ':' }),
            "{relative} 应当因为额外的冒号被拒，实际 {error:?}"
        );
    }
}

#[test]
fn control_characters_and_empty_segments_are_refused() {
    let root = sandbox("shape");
    write(&root, "a/b.bin", CONTENT);
    assert!(matches!(resolve_granted(&root, "").expect_err("空"), InputError::Empty));
    for relative in ["a\0b", "a\nb", "a\tb"] {
        let error = resolve_granted(&root, relative).expect_err(relative);
        assert!(
            matches!(error, InputError::ForbiddenChar { .. }),
            "{relative} 应当因为控制字符被拒，实际 {error:?}"
        );
    }
    for relative in ["a//b.bin", "a/", "/a/b.bin", "a/./b.bin"] {
        let error = resolve_granted(&root, relative).expect_err(relative);
        assert!(
            matches!(error, InputError::NotRelative { .. }),
            "{relative} 应当因为路径形状被拒，实际 {error:?}"
        );
    }
    let long = "a".repeat(MAX_RELATIVE_PATH_BYTES + 1);
    assert!(matches!(
        resolve_granted(&root, &long).expect_err("超长"),
        InputError::TooLong { .. }
    ));
}

#[test]
fn a_segment_that_windows_would_trim_is_refused() {
    let root = sandbox("trim");
    write(&root, "a.bin", CONTENT);
    // Windows 会把「名字末尾的点/空格」悄悄去掉再建文件，于是「检查的名字」与
    // 「真正打开的文件」不是同一个——这种别名必须挡在解析阶段。
    for relative in ["a.bin./x", "a.bin /x", "page.png.", "page.png "] {
        let error = resolve_granted(&root, relative).expect_err(relative);
        assert!(
            matches!(error, InputError::NotRelative { .. }),
            "{relative} 应当因为段尾的点或空格被拒，实际 {error:?}"
        );
    }
}

#[test]
fn a_dos_device_name_is_refused() {
    let root = sandbox("device");
    for relative in ["con", "NUL", "aux.txt", "com1", "LPT9.bin", "sub/PRN"] {
        let error = resolve_granted(&root, relative).expect_err(relative);
        assert!(
            matches!(error, InputError::DeviceName { .. }),
            "{relative} 应当因为是设备名被拒，实际 {error:?}"
        );
    }
}

#[test]
fn a_directory_is_not_an_input_file() {
    let root = sandbox("dir");
    fs::create_dir_all(root.join("sub")).expect("造子目录");
    let error = resolve_granted(&root, "sub").expect_err("目录不是文件");
    assert!(matches!(error, InputError::NotAFile { .. }), "实际 {error:?}");

    let missing = resolve_granted(&root, "nope.png").expect_err("不存在的文件");
    assert!(matches!(missing, InputError::NotFound { .. }), "实际 {missing:?}");
}

#[test]
fn a_hardlink_is_a_regular_file_and_is_accepted() {
    // 宿主就是用硬链接把缓存里的图挂进输入根的（§7.1）——这条要保证那条路可行。
    let root = sandbox("hardlink");
    let original = write(&root, "cache-original.bin", CONTENT);
    let link = root.join("inputs").join("linked.bin");
    fs::create_dir_all(link.parent().expect("父目录")).expect("造输入根");
    if fs::hard_link(&original, &link).is_err() {
        eprintln!("跳过：本机不支持在这个目录里建硬链接");
        return;
    }

    let resolved = resolve_granted(&root, "inputs/linked.bin").expect("硬链接应当被接受");
    assert_eq!(fs::read(&resolved).expect("读回来"), CONTENT);
    verify_file(&resolved, &blake3_hex(CONTENT), CONTENT.len() as u64).expect("硬链接也能校验");
}

#[test]
fn a_reparse_point_is_refused() {
    let root = sandbox("symlink");
    let outside = write(&root, "outside.bin", CONTENT);
    fs::create_dir_all(root.join("inputs")).expect("造输入根");
    let outside_dir = root.join("outside-dir");
    fs::create_dir_all(&outside_dir).expect("造根外目录");
    fs::write(outside_dir.join("inside.png"), CONTENT).expect("写根外文件");

    if make_file_symlink(&outside, &root.join("linked.bin")).is_ok() {
        let resolved = resolve_granted(&root, "linked.bin");
        assert!(
            matches!(resolved, Err(InputError::Reparse { .. })),
            "符号链接应当被拒，实际 {resolved:?}"
        );
        return;
    }

    // 文件符号链接要特权，目录 junction 不要。没开开发者模式的机器上，这条
    // 仍然能测到「路径中间某一段是重解析点」——那才是真正的绕过方式。
    if make_dir_junction(&outside_dir, &root.join("junction")).is_ok() {
        let resolved = resolve_granted(&root, "junction/inside.png");
        assert!(
            matches!(resolved, Err(InputError::Reparse { .. })),
            "junction 应当被拒，实际 {resolved:?}"
        );
        return;
    }

    // 跳过 ≠ 通过：两条都造不出来时，这条边界没被测到。
    eprintln!("跳过：本机既建不出符号链接也建不出 junction");
}

#[cfg(windows)]
fn make_file_symlink(target: &Path, link: &Path) -> std::io::Result<()> {
    std::os::windows::fs::symlink_file(target, link)
}

#[cfg(not(windows))]
fn make_file_symlink(target: &Path, link: &Path) -> std::io::Result<()> {
    std::os::unix::fs::symlink(target, link)
}

#[cfg(windows)]
fn make_dir_junction(target: &Path, link: &Path) -> std::io::Result<()> {
    // `mklink /J` 不需要开发者模式，也不需要 SeCreateSymbolicLinkPrivilege。
    let status = std::process::Command::new("cmd")
        .args(["/C", "mklink", "/J"])
        .arg(link)
        .arg(target)
        .status()?;
    if status.success() {
        Ok(())
    } else {
        Err(std::io::Error::other(format!("mklink /J 退出码 {status}")))
    }
}

#[cfg(not(windows))]
fn make_dir_junction(target: &Path, link: &Path) -> std::io::Result<()> {
    std::os::unix::fs::symlink(target, link)
}

#[test]
fn a_hash_that_does_not_match_the_declaration_is_refused() {
    let root = sandbox("hash");
    let path = write(&root, "page.png", CONTENT);
    let error = verify_file(&path, &blake3_hex(b"something else"), CONTENT.len() as u64)
        .expect_err("hash 对不上");
    match error {
        InputError::HashMismatch { expected, actual } => {
            assert_eq!(expected, blake3_hex(b"something else"));
            assert_eq!(actual, blake3_hex(CONTENT));
        }
        other => panic!("应当报 hash 不匹配，实际 {other:?}"),
    }
}

#[test]
fn a_length_that_does_not_match_the_declaration_is_refused() {
    let root = sandbox("length");
    let path = write(&root, "page.png", CONTENT);
    let error = verify_file(&path, &blake3_hex(CONTENT), CONTENT.len() as u64 + 1)
        .expect_err("长度对不上");
    match error {
        InputError::LengthMismatch { expected, actual } => {
            assert_eq!(expected, CONTENT.len() as u64 + 1);
            assert_eq!(actual, CONTENT.len() as u64);
        }
        other => panic!("应当报长度不匹配，实际 {other:?}"),
    }
}

#[test]
fn every_input_failure_explains_itself_in_chinese() {
    // 这些串会一路走到前端与日志里，别出现 `InvalidInput` 这种没头没尾的英文。
    let root = sandbox("message");
    write(&root, "a.bin", CONTENT);
    for relative in ["", "../escape", "con", "nope"] {
        let error = resolve_granted(&root, relative).expect_err(relative);
        let message = error.message();
        assert!(!message.is_empty(), "{relative} 的错误没有说明");
        assert!(
            message.chars().any(|c| ('\u{4e00}'..='\u{9fff}').contains(&c)),
            "{relative} 的说明不是中文：{message}"
        );
        assert_eq!(error.code(), "COMPUTE_INPUT_INVALID", "{relative} 的错误码");
    }
}
