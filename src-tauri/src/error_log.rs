//! 本次运行的错误记录。
//!
//! 一个纯文本文件（`<data>/logs/error.log`），启动时清空——它描述的是「这一次
//! 运行出了什么问题」，跨次累积的日志对用户没有意义，只会让最新的一次淹没在旧
//! 记录里。每条一行，制表符分隔，方便直接打开看，也方便原样导出。
//!
//! 敏感值不进日志：前端写入前已经用 redaction 处理过（API key、Authorization
//! 这类字段会被替换掉），这里只负责落盘。

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;

use crate::data_paths;
use crate::domain::result::CommandResult;

/// 一次运行最多保留这么多条：日志是给人看的现场，不是无限追加的账本。
const MAX_ENTRIES: usize = 2000;
/// 单条消息的长度上限，免得一个巨大的对象把文件撑爆。
const MAX_FIELD_CHARS: usize = 4000;

#[derive(Clone, Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ErrorLogAppendInput {
    /// 前端给的 ISO-8601 时间；缺了就用当前时刻。
    #[serde(default)]
    pub at: Option<String>,
    pub level: String,
    pub source: String,
    pub message: String,
    #[serde(default)]
    pub detail: Option<String>,
}

#[derive(Clone, Debug, serde::Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ErrorLogEntry {
    /// ISO-8601（前端给的浏览器时间）；Rust 侧的 panic 写的是 `epoch:<毫秒>`，
    /// 因为这里没有本地时间格式化，界面按需转换。
    pub at: String,
    pub level: String,
    pub source: String,
    pub message: String,
    pub detail: Option<String>,
}

fn log_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let directory = data_paths::data_dir(app)
        .map_err(|error| error.to_string())?
        .join("logs");
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    Ok(directory.join("error.log"))
}

fn field(value: &str) -> String {
    let flat = value.replace(['\r', '\n', '\t'], " ");
    if flat.chars().count() <= MAX_FIELD_CHARS {
        return flat;
    }
    flat.chars().take(MAX_FIELD_CHARS).collect::<String>() + "…"
}

fn append_entry(app: &tauri::AppHandle, entry: &ErrorLogEntry) -> Result<(), String> {
    let path = log_path(app)?;
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|error| error.to_string())?;
    writeln!(
        file,
        "{}\t{}\t{}\t{}\t{}",
        field(&entry.at),
        field(&entry.level),
        field(&entry.source),
        field(&entry.message),
        field(entry.detail.as_deref().unwrap_or("")),
    )
    .map_err(|error| error.to_string())
}

/// 启动时调用：这一次运行从空日志开始。
pub fn reset(app: &tauri::AppHandle) {
    if let Ok(path) = log_path(app) {
        let _ = fs::write(&path, "");
    }
}

/// 当前时刻，unix 毫秒。Rust 侧没有本地时间格式化，界面按需转换这个标记。
fn now_stamp() -> String {
    match std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH) {
        Ok(elapsed) => format!("epoch:{}", elapsed.as_millis()),
        Err(_) => String::from("epoch:0"),
    }
}

/// 内核 panic 也进这份日志：那是用户最看不到的一类错误，而它恰恰最需要现场。
pub fn install_panic_hook(app: &tauri::AppHandle) {
    let handle = app.clone();
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let at = now_stamp();
        let location = info
            .location()
            .map(|place| format!("{}:{}", place.file(), place.line()))
            .unwrap_or_else(|| String::from("unknown"));
        let message = match info.payload().downcast_ref::<&str>() {
            Some(text) => (*text).to_string(),
            None => match info.payload().downcast_ref::<String>() {
                Some(text) => text.clone(),
                None => String::from("panic"),
            },
        };
        let _ = append_entry(
            &handle,
            &ErrorLogEntry {
                at,
                level: String::from("error"),
                source: String::from("core/panic"),
                message,
                detail: Some(location),
            },
        );
        previous(info);
    }));
}

fn parse_entries(text: &str) -> Vec<ErrorLogEntry> {
    let mut entries: Vec<ErrorLogEntry> = text
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| {
            let mut parts = line.splitn(5, '\t');
            let at = parts.next().unwrap_or_default().to_string();
            let level = parts.next().unwrap_or("error").to_string();
            let source = parts.next().unwrap_or_default().to_string();
            let message = parts.next().unwrap_or_default().to_string();
            let detail = parts.next().unwrap_or_default();
            ErrorLogEntry {
                at,
                level,
                source,
                message,
                detail: (!detail.is_empty()).then(|| detail.to_string()),
            }
        })
        .collect();
    if entries.len() > MAX_ENTRIES {
        entries.drain(..entries.len() - MAX_ENTRIES);
    }
    entries
}

fn read_entries(app: &tauri::AppHandle) -> Result<Vec<ErrorLogEntry>, String> {
    let path = log_path(app)?;
    match fs::read_to_string(&path) {
        Ok(text) => Ok(parse_entries(&text)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(error) => Err(error.to_string()),
    }
}

#[tauri::command]
pub fn error_log_append(
    app: tauri::AppHandle,
    input: ErrorLogAppendInput,
) -> CommandResult<()> {
    if input.message.trim().is_empty() {
        return CommandResult::success(());
    }
    error_log_write(
        &app,
        &ErrorLogEntry {
            at: input
                .at
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(now_stamp),
            level: input.level,
            source: input.source,
            message: input.message,
            detail: input.detail.filter(|value| !value.trim().is_empty()),
        },
    )
}

/// 一批一次落盘：错误风暴时前端是整批交过来的，逐条 IPC 往返
/// 只会让桥上全是日志流量。
#[tauri::command]
pub fn error_log_append_batch(
    app: tauri::AppHandle,
    inputs: Vec<ErrorLogAppendInput>,
) -> CommandResult<()> {
    let entries = inputs
        .into_iter()
        .filter(|input| !input.message.trim().is_empty())
        .map(|input| ErrorLogEntry {
            at: input
                .at
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(now_stamp),
            level: input.level,
            source: input.source,
            message: input.message,
            detail: input.detail.filter(|value| !value.trim().is_empty()),
        })
        .collect::<Vec<_>>();
    if entries.is_empty() {
        return CommandResult::success(());
    }
    error_log_write_all(&app, &entries)
}

fn error_log_write(app: &tauri::AppHandle, entry: &ErrorLogEntry) -> CommandResult<()> {
    error_log_write_all(app, std::slice::from_ref(entry))
}

fn error_log_write_all(app: &tauri::AppHandle, entries: &[ErrorLogEntry]) -> CommandResult<()> {
    let path = match log_path(app) {
        Ok(path) => path,
        Err(_) => return CommandResult::failure("UNKNOWN", "Error log write failed", true),
    };
    let write = || -> Result<(), String> {
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .map_err(|error| error.to_string())?;
        for entry in entries {
            writeln!(
                file,
                "{}\t{}\t{}\t{}\t{}",
                field(&entry.at),
                field(&entry.level),
                field(&entry.source),
                field(&entry.message),
                field(entry.detail.as_deref().unwrap_or("")),
            )
            .map_err(|error| error.to_string())?;
        }
        Ok(())
    };
    match write() {
        Ok(()) => CommandResult::success(()),
        Err(_) => CommandResult::failure("UNKNOWN", "Error log write failed", true),
    }
}

#[tauri::command]
pub fn error_log_read(app: tauri::AppHandle) -> CommandResult<Vec<ErrorLogEntry>> {
    match read_entries(&app) {
        Ok(entries) => CommandResult::success(entries),
        Err(_) => CommandResult::failure("UNKNOWN", "Error log unavailable", true),
    }
}

/// 导出到用户选定的路径（由前端弹保存对话框）。源文件原样复制，方便直接发给人
/// 看，而不是让导出这一步再加工一遍内容。
#[tauri::command]
pub fn error_log_export(app: tauri::AppHandle, path: String) -> CommandResult<String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return CommandResult::failure("INVALID_INPUT", "Export path is empty", false);
    }
    let source = match log_path(&app) {
        Ok(value) => value,
        Err(_) => return CommandResult::failure("PLATFORM_UNAVAILABLE", "App data directory unavailable", true),
    };
    if fs::read_to_string(&source).is_err() {
        return CommandResult::failure("NOT_FOUND", "Error log is empty", false);
    }
    match fs::copy(&source, trimmed) {
        Ok(_) => CommandResult::success(trimmed.to_string()),
        Err(error) => CommandResult::failure("UNKNOWN", error.to_string(), true),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fields_are_flattened_and_capped() {
        let long = "x".repeat(MAX_FIELD_CHARS + 50);
        let flat = field(&format!("line one\nline two\t{long}"));
        assert!(!flat.contains('\n'));
        assert!(!flat.contains('\t'));
        assert!(flat.chars().count() <= MAX_FIELD_CHARS + 1);
        assert!(flat.ends_with('…'));
    }

    #[test]
    fn entries_round_trip_through_their_line() {
        let line = "2026-09-16T10:00:00.000Z\terror\tcommand/list_archives\tLANraragi unreachable\thttps://lrr.test/api/info";
        assert_eq!(
            parse_entries(line),
            vec![ErrorLogEntry {
                at: String::from("2026-09-16T10:00:00.000Z"),
                level: String::from("error"),
                source: String::from("command/list_archives"),
                message: String::from("LANraragi unreachable"),
                detail: Some(String::from("https://lrr.test/api/info")),
            }]
        );
        // 没有 detail 的行也是合法的：那一位留空。
        assert_eq!(
            parse_entries("epoch:1\twarn\treader\t页面加载失败\t")[0].detail,
            None
        );
        // 空行（被清空过的文件）解析成空列表，而不是一条空记录。
        assert!(parse_entries("").is_empty());
        assert!(parse_entries("\n\n").is_empty());
    }

    #[test]
    fn parsing_keeps_only_the_newest_entries() {
        let text = (0..MAX_ENTRIES + 25)
            .map(|index| format!("epoch:{index}\terror\tsource\tmessage\t"))
            .collect::<Vec<_>>()
            .join("\n");
        let entries = parse_entries(&text);
        assert_eq!(entries.len(), MAX_ENTRIES);
        assert_eq!(entries[0].at, format!("epoch:{}", 25));
        assert_eq!(entries[entries.len() - 1].at, format!("epoch:{}", MAX_ENTRIES + 24));
    }
}
