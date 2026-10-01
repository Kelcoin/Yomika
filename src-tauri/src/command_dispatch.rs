//! 命令调度的不变量：什么可以留在 WebView2 的 UI 线程上。
//!
//! 一条 `#[tauri::command]` 挂在**同步** `pub fn` 上时，tauri 把它编成
//! `ExecutionContext::Blocking`，命令体就在 IPC handler 里**就地**执行；那个 handler
//! 是 wry 在 `WebResourceRequested` 回调里调的，也就是 tao / WebView2 的消息循环线程。
//! Windows 把 `WM_MOVING`、`WM_SIZE`、`WM_NCLBUTTONDOWN` 都投给同一条线程——所以
//! 「命令体里跑了什么」直接决定窗口拖起来顺不顺：一个几百毫秒的查询就是一个几百毫秒的
//! 卡死，用户看到的是「拖不动，过一会儿才响应」。
//!
//! 这里把三条最容易再犯回去的组合钉死：
//!
//! 1. 同步命令体里 `block_on`——命令包装跑在 tokio worker 上，在运行时内部 `block_on`
//!    会 **panic**（`Cannot start a runtime from within a runtime`），响应永远发不出去。
//! 2. 同步命令体里锁那把全局库锁——`src/db/mod.rs` 只有一把
//!    `Mutex<rusqlite::Connection>`，而后台线程会在持有它的时候做整文件读、哈希、删改
//!    文件，所以哪怕一句单行 UPDATE 也可能等上任意长时间。
//! 3. 同步命令体里等一个子进程——`.output()` / `.status()` 会等它跑完。
//!
//! 测试读的是 crate 自己的源码（`include_str!`），不碰文件系统，也不会因为工作目录不同
//! 而变。它只沿**命令体自己的文本**判断，不展开它调用的辅助函数：跨函数那条路靠
//! `debug_outputs/audit_blocking_commands2.py` 那份调用图审计（人工跑），这里守的是
//! 「新写的命令别把已经搬走的东西又搬回 UI 线程」。签名上有没有 `State<'_, Database>`
//! 一并检查，是因为那正是「命令自己没锁、锁在辅助函数里」这条路的入口。

#[cfg(test)]
mod tests {
    /// 每个含 `#[tauri::command]` 的源文件，路径相对 `src/`。
    const SOURCES: &[(&str, &str)] = &[
        ("app_release.rs", include_str!("app_release.rs")),
        ("cache.rs", include_str!("cache.rs")),
        ("commands/eh.rs", include_str!("commands/eh.rs")),
        ("commands/legacy.rs", include_str!("commands/legacy.rs")),
        ("commands/library.rs", include_str!("commands/library.rs")),
        ("commands/platform.rs", include_str!("commands/platform.rs")),
        ("commands/sync.rs", include_str!("commands/sync.rs")),
        ("compute_center.rs", include_str!("compute_center.rs")),
        ("credentials.rs", include_str!("credentials.rs")),
        ("dedup.rs", include_str!("dedup.rs")),
        ("dlssnr/commands.rs", include_str!("dlssnr/commands.rs")),
        ("dlssnr/mod.rs", include_str!("dlssnr/mod.rs")),
        ("error_log.rs", include_str!("error_log.rs")),
        ("inference.rs", include_str!("inference.rs")),
        ("lib.rs", include_str!("lib.rs")),
        ("model_release.rs", include_str!("model_release.rs")),
        ("settings.rs", include_str!("settings.rs")),
        // 新命令落进新文件时这里也要补一行，否则它就不在这条不变量底下——托盘菜单那份
        // 就是这么被发现的（`tray_menu_state` 曾经在同步命令里取库锁）。
        ("tray_menu.rs", include_str!("tray_menu.rs")),
    ];

    /// 一条挂在同步 `pub fn` 上的 `#[tauri::command]`。
    struct SyncCommand {
        /// 属性所在行（1 起，对着源文件）。
        line: usize,
        name: String,
        /// 参数与返回类型（从 `pub fn` 到 `{`），空白已去掉。
        signature: String,
        /// 函数体，空白已去掉。
        body: String,
    }

    /// 去掉注释：整行 `//`（含 `///`、`//!`）、以及 `/* */`（含 `/** */` 文档块）。
    ///
    /// 文档注释里会提到 `block_on`（解释为什么不能用它），那不是代码。整行 `//` 先判，
    /// 所以 `/// ... image/* ...` 这种「注释里带 /*」的行整条丢掉，不会误开一个块注释。
    fn strip_comments(source: &str) -> String {
        let mut out = String::with_capacity(source.len());
        let mut in_block = false;
        for line in source.lines() {
            if !in_block && line.trim_start().starts_with("//") {
                out.push('\n');
                continue;
            }
            let mut rest = line;
            loop {
                if in_block {
                    match rest.find("*/") {
                        Some(at) => {
                            rest = &rest[at + 2..];
                            in_block = false;
                        }
                        None => {
                            rest = "";
                            break;
                        }
                    }
                }
                match rest.find("/*") {
                    Some(at) => {
                        out.push_str(&rest[..at]);
                        rest = &rest[at + 2..];
                        in_block = true;
                    }
                    None => {
                        out.push_str(rest);
                        break;
                    }
                }
            }
            out.push('\n');
        }
        out
    }

    fn compact(text: &str) -> String {
        text.chars()
            .filter(|character| !character.is_whitespace())
            .collect()
    }

    /// 从签名所在行起按花括号配对取出函数体，返回（正文, 结束行号）。
    fn take_body(lines: &[&str], start: usize) -> (String, usize) {
        let mut depth = 0_i32;
        let mut body = String::new();
        let mut started = false;
        for (offset, line) in lines.iter().enumerate().skip(start) {
            for character in line.chars() {
                match character {
                    '{' => {
                        depth += 1;
                        started = true;
                    }
                    '}' => depth -= 1,
                    _ => {}
                }
                if started {
                    body.push(character);
                }
                if started && depth == 0 {
                    return (body, offset);
                }
            }
            body.push('\n');
        }
        (body, lines.len().saturating_sub(1))
    }

    fn sync_commands(source: &str) -> Vec<SyncCommand> {
        let cleaned = strip_comments(source);
        let lines: Vec<&str> = cleaned.lines().collect();
        let mut commands = Vec::new();
        let mut index = 0;
        while index < lines.len() {
            if lines[index].trim() != "#[tauri::command]" {
                index += 1;
                continue;
            }
            let attribute_line = index + 1;
            let mut signature = index + 1;
            while signature < lines.len()
                && !lines[signature].trim_start().starts_with("pub fn ")
                && !lines[signature].trim_start().starts_with("pub async fn ")
            {
                signature += 1;
            }
            if signature >= lines.len() {
                break;
            }
            // `#[tauri::command(async)]` 与 `pub async fn` 都不在 UI 线程上跑，
            // 这三条不变量管不到它们。
            if !lines[signature].trim_start().starts_with("pub fn ") {
                index = signature + 1;
                continue;
            }
            let name = lines[signature]
                .trim_start()
                .trim_start_matches("pub fn ")
                .split(['(', '<'])
                .next()
                .unwrap_or("?")
                .trim()
                .to_string();
            // 签名可能跨行，到第一个 `{` 为止。
            let mut signature_text = String::new();
            let mut cursor = signature;
            while cursor < lines.len() {
                match lines[cursor].find('{') {
                    Some(at) => {
                        signature_text.push_str(&lines[cursor][..at]);
                        break;
                    }
                    None => {
                        signature_text.push_str(lines[cursor]);
                        signature_text.push(' ');
                    }
                }
                cursor += 1;
            }
            let (body, last) = take_body(&lines, signature);
            commands.push(SyncCommand {
                line: attribute_line,
                name,
                signature: compact(&signature_text),
                body: compact(&body),
            });
            index = last + 1;
        }
        commands
    }

    fn all_sync_commands() -> Vec<(&'static str, SyncCommand)> {
        let mut found = Vec::new();
        for (file, source) in SOURCES {
            for command in sync_commands(source) {
                found.push((*file, command));
            }
        }
        found
    }

    #[test]
    fn the_source_walk_actually_finds_commands() {
        // 扫描器自己坏了必须响亮地失败，否则下面几条会「通过」得毫无意义。
        let found = all_sync_commands();
        let names: Vec<&str> = found
            .iter()
            .map(|(_, command)| command.name.as_str())
            .collect();
        assert!(
            found.len() > 8,
            "只认出 {} 条同步命令，扫描器多半坏了",
            found.len()
        );
        // 一条已知的同步命令：真扫不到就说明按行匹配的假设不成立。
        assert!(
            names.contains(&"frontend_ready"),
            "认不出 frontend_ready，扫描器坏了"
        );
        // 一条已知的 async 命令不该出现在这里。
        assert!(
            !names.contains(&"cache_stats"),
            "cache_stats 是 (async)，不该被当成同步命令"
        );
        // 文件标签要对得上，否则报错信息里指不出文件。
        assert!(
            found
                .iter()
                .any(|(file, command)| *file == "commands/platform.rs"
                    && command.name == "frontend_ready"),
            "commands/platform.rs 没被扫到，或文件标签错了"
        );
        // 命令散在多个文件里；只扫到一个文件说明遍历坏了。
        let files: std::collections::BTreeSet<&str> = found.iter().map(|(file, _)| *file).collect();
        assert!(files.len() >= 3, "只扫到 {} 个文件：{files:?}", files.len());
    }

    #[test]
    fn no_synchronous_command_blocks_on_a_runtime() {
        // `tauri::async_runtime::block_on` 只有在调用线程**不在**异步运行时里时才成立。
        // 命令包装跑在 tokio worker 上，所以在里面 `block_on` 直接 panic
        //（`data/logs/crash.log` 里的 "Cannot start a runtime from within a runtime"），
        // 响应永远发不出去——写它的那个命令会永久失效。改成 `pub async fn` 再 `.await`。
        let offenders: Vec<String> = all_sync_commands()
            .into_iter()
            .filter(|(_, command)| command.body.contains("block_on"))
            .map(|(file, command)| format!("{}:{} {}", file, command.line, command.name))
            .collect();
        assert!(
            offenders.is_empty(),
            "同步命令里出现 block_on（会 panic 且响应永不返回）：{offenders:?}"
        );
    }

    #[test]
    fn no_synchronous_command_takes_or_locks_the_shared_database() {
        // 进程只有一把库锁（`src/db/mod.rs`），后台线程会在持有它的时候做整文件读、哈希
        // 与删改文件，所以等在 UI 线程上就是窗口冻住。两条一起查：命令自己锁的，和命令
        // 拿得到库句柄的（后者正说明锁可能藏在它调的辅助函数里）。
        let offenders: Vec<String> = all_sync_commands()
            .into_iter()
            .filter(|(_, command)| {
                command.body.contains(".connection.lock()")
                    || command.signature.contains("State<'_,Database>")
                    || command.signature.contains("State<'_,crate::db::Database>")
            })
            .map(|(file, command)| format!("{}:{} {}", file, command.line, command.name))
            .collect();
        assert!(
            offenders.is_empty(),
            "同步命令碰了全局库锁（UI 线程要等最慢的持锁者）：{offenders:?}"
        );
    }

    #[test]
    fn no_synchronous_command_waits_on_a_child_process() {
        // `.spawn()` 只创建进程，`.output()` / `.status()` 会等它跑完；后者在 UI 线程上
        // 就是拿窗口去换一个子进程的启动时间（`reg.exe` 实测 50–200ms 起）。
        let offenders: Vec<String> = all_sync_commands()
            .into_iter()
            .filter(|(_, command)| {
                command.body.contains("std::process::Command")
                    && (command.body.contains(".output()") || command.body.contains(".status()"))
            })
            .map(|(file, command)| format!("{}:{} {}", file, command.line, command.name))
            .collect();
        assert!(
            offenders.is_empty(),
            "同步命令在等一个子进程：{offenders:?}"
        );
    }

    #[test]
    fn no_synchronous_command_reads_the_credential_vault() {
        // 系统安全存储（Windows 凭据管理器 / keyring）是一次阻塞的系统调用，偶尔会
        // 明显更慢。它不属于上面任何一类，但同理：等在 UI 线程上就是窗口卡一下。
        // `.spawn()` 那条不覆盖它，所以单独钉。
        //
        // 现在凭据统一从 `secret_store` 进出（移动端换成了数据目录里 `secrets.json`
        // 的整份读改写，那也是一次实实在在的文件系统调用），所以那个模块名一并算进来：
        // 命令直接写 `secret_store::get_secret(...)` 而绕过下面两个 store 结构体时，
        // 只认旧名字就会漏判。
        let offenders: Vec<String> = all_sync_commands()
            .into_iter()
            .filter(|(_, command)| {
                command.body.contains("SystemCredentialStore")
                    || command.body.contains("SystemWebdavCredentialStore")
                    || command.body.contains("secret_store::")
                    || command.body.contains("keyring::Entry")
            })
            .map(|(file, command)| format!("{}:{} {}", file, command.line, command.name))
            .collect();
        assert!(
            offenders.is_empty(),
            "同步命令在读系统凭据库（阻塞的系统调用）：{offenders:?}"
        );
    }
}
