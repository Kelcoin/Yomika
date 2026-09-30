//! 错误记录：留**本次与上次两轮**运行。
//!
//! 目录是 `<data>/logs`，一份内容一个文件、一轮运行一份：
//!
//! | 本轮 | 上一轮 | 内容 |
//! | --- | --- | --- |
//! | `error.log` | `error.previous.log` | 前端与命令记下的错误，制表符分隔，一行一条 |
//! | `crash.log` | `crash.previous.log` | 黑匣子（`record_step` 与 panic），JSON 行 |
//! | `java-crash.log` | `java-crash.previous.log` | Kotlin 侧未捕获异常，JSON 行 |
//!
//! 启动时 `rotate` 把「本轮」翻成「上一轮」。留存两轮是刻意的：一轮太少——闪退正是发生
//! 在应用即将消失的时候，而「本次」的日志在下次启动本来就要清空，现场会在用户能看一眼之
//! 前消失；再多就是把最新的一次淹没在旧记录里。
//!
//! 界面拿到的顺序就是**从新到旧**：本次运行的错误在最上面，然后是本次的黑匣子、上次的
//! 黑匣子、上次的错误。「上次运行 ·」前缀来自这里，前端按它把两轮分开数。
//!
//! 敏感值不进日志：前端写入前已经用 redaction 处理过（API key、Authorization
//! 这类字段会被替换掉），这里只负责落盘。

use std::collections::HashSet;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use crate::data_paths;
use crate::domain::result::CommandResult;

/// 一次运行最多保留这么多条：日志是给人看的现场，不是无限追加的账本。
const MAX_ENTRIES: usize = 2000;
/// 单条消息的长度上限，免得一个巨大的对象把文件撑爆。
const MAX_FIELD_CHARS: usize = 4000;
/// 崩溃记录最多留这么多行（一次登录会写好几条，不封顶的话这份文件只增不减）。
const MAX_CRASH_LINES: usize = 200;
/// 上一轮记录的来源前缀。前端 `ErrorLogPanel` 拼的是同一个字符串。
const CARRIED_PREFIX: &str = "上次运行 · ";

const ERROR_LOG: &str = "error.log";
const ERROR_PREVIOUS: &str = "error.previous.log";
const CRASH_LOG: &str = "crash.log";
const CRASH_PREVIOUS: &str = "crash.previous.log";
const JAVA_CRASH_LOG: &str = "java-crash.log";
const JAVA_CRASH_PREVIOUS: &str = "java-crash.previous.log";

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

/// `Deserialize` 是给黑匣子用的：那两份文件按 JSON 行存（Rust 与 Kotlin 都往里写），
/// 重启后要读回来。
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ErrorLogEntry {
    /// ISO-8601（前端给的浏览器时间）；Rust 与 Kotlin 写的是 `epoch:<毫秒>`，
    /// 因为这里没有本地时间格式化，界面按需转换。
    pub at: String,
    pub level: String,
    pub source: String,
    pub message: String,
    pub detail: Option<String>,
}

fn log_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let directory = data_paths::data_dir(app)
        .map_err(|error| error.to_string())?
        .join("logs");
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    Ok(directory)
}

fn log_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(log_dir(app)?.join(ERROR_LOG))
}

/// 崩溃记录的去处。它和 `error.log` 同一套轮转：崩溃之后应用是死的，「本次」那份在下次
/// 启动就翻成「上次」，现场才留得住。
fn crash_path(app: &tauri::AppHandle, name: &str) -> Result<PathBuf, String> {
    Ok(log_dir(app)?.join(name))
}

fn field(value: &str) -> String {
    let flat = value.replace(['\r', '\n', '\t'], " ");
    if flat.chars().count() <= MAX_FIELD_CHARS {
        return flat;
    }
    flat.chars().take(MAX_FIELD_CHARS).collect::<String>() + "…"
}

/// 文本日志的一行：制表符分隔，方便直接打开看。
fn text_line(entry: &ErrorLogEntry) -> String {
    format!(
        "{}\t{}\t{}\t{}\t{}",
        field(&entry.at),
        field(&entry.level),
        field(&entry.source),
        field(&entry.message),
        field(entry.detail.as_deref().unwrap_or("")),
    )
}

fn append_lines(path: &Path, lines: &[String]) -> Result<(), String> {
    if lines.is_empty() {
        return Ok(());
    }
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|error| error.to_string())?;
    for line in lines {
        writeln!(file, "{line}").map_err(|error| error.to_string())?;
    }
    Ok(())
}

/// JSON 行：黑匣子用这个格式，Rust（`record_step`、panic）与 Kotlin（未捕获异常）都往里写，
/// 一份格式，两边读得懂。
fn append_json_lines(path: &Path, entries: &[ErrorLogEntry]) -> Result<(), String> {
    let lines = entries
        .iter()
        .map(|entry| {
            serde_json::json!({
                "at": entry.at,
                "level": entry.level,
                "source": entry.source,
                "message": entry.message,
                "detail": entry.detail,
            })
            .to_string()
        })
        .collect::<Vec<_>>();
    append_lines(path, &lines)
}

/// 启动时调用：把本轮的三份文件翻成上一轮，本轮从空开始。
///
/// 只留两轮，所以每次启动都是「删掉再旧的一轮、把本轮的挪过去」。**不清理本轮文件**：
/// `error.log` 之类的由写入方按需创建，先建空文件只会让「有没有这一份」失去意义。
pub fn rotate(app: &tauri::AppHandle) {
    let Ok(directory) = log_dir(app) else {
        return;
    };
    let pairs = [
        (ERROR_LOG, ERROR_PREVIOUS),
        (CRASH_LOG, CRASH_PREVIOUS),
        (JAVA_CRASH_LOG, JAVA_CRASH_PREVIOUS),
    ];
    // 三对之间一一对应，名单本身见 LOG_FILES（清空那边用的是同一批文件）。
    for (current, previous) in pairs {
        let previous_path = directory.join(previous);
        let current_path = directory.join(current);
        let _ = fs::remove_file(&previous_path);
        if current_path.exists() {
            let _ = fs::rename(&current_path, &previous_path);
        }
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
        let entry = ErrorLogEntry {
            at,
            level: String::from("error"),
            source: String::from("core/panic"),
            message,
            detail: Some(location),
        };
        let _ = append_json_lines_at(&handle, CRASH_LOG, std::slice::from_ref(&entry));
        let _ = append_json_lines_at(&handle, ERROR_LOG, std::slice::from_ref(&entry));
        previous(info);
    }));
}

fn append_json_lines_at(
    app: &tauri::AppHandle,
    name: &str,
    entries: &[ErrorLogEntry],
) -> Result<(), String> {
    append_json_lines(&crash_path(app, name)?, entries)
}

/// 黑匣子：记一步「我正要做什么」。
///
/// panic hook 只接得住 Rust panic——Android 上的闪退往往是 Java/原生层的异常（线程约束、
/// JNI 崩溃、视图被换掉…），那边崩起来一行 Rust 都不会跑。所以关键步骤**动手之前先写一
/// 条**：进程怎么死的都留下痕迹，下次启动读出来就能看出「它停在哪一步」。条目多、无所谓：
/// 文件有上限，超了从最早的开始丢。
pub(crate) fn record_step(app: &tauri::AppHandle, source: &str, step: &str) {
    let entry = ErrorLogEntry {
        at: now_stamp(),
        level: String::from("warn"),
        source: source.to_string(),
        message: step.to_string(),
        detail: None,
    };
    let Ok(path) = crash_path(app, CRASH_LOG) else {
        return;
    };
    let _ = append_json_lines(&path, std::slice::from_ref(&entry));
    let _ = cap_lines(&path, MAX_CRASH_LINES);
}

/// 行数超了就重写一份只留尾部的（原子性够用：先写临时文件再改名）。
fn cap_lines(path: &Path, limit: usize) -> Result<(), String> {
    let Ok(text) = fs::read_to_string(path) else {
        return Ok(());
    };
    let lines: Vec<&str> = text.lines().filter(|line| !line.trim().is_empty()).collect();
    if lines.len() <= limit {
        return Ok(());
    }
    let tail = lines[lines.len() - limit..].join("\n") + "\n";
    let temp = path.with_extension("tmp");
    fs::write(&temp, tail).map_err(|error| error.to_string())?;
    fs::rename(&temp, path).map_err(|error| error.to_string())
}

/// 文本日志按制表符拆行读回来。
fn parse_text(text: &str) -> Vec<ErrorLogEntry> {
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

/// 黑匣子按 JSON 行存（一次一行，追加）。坏行丢掉：一份被截断的文件不该让整页读不出来。
fn parse_json_lines(text: &str) -> Vec<ErrorLogEntry> {
    let mut entries: Vec<ErrorLogEntry> = text
        .lines()
        .filter(|line| !line.trim().is_empty())
        .filter_map(|line| serde_json::from_str::<ErrorLogEntry>(line).ok())
        .collect();
    if entries.len() > MAX_ENTRIES {
        entries.drain(..entries.len() - MAX_ENTRIES);
    }
    entries
}

/// 一份文件读成条目，缺文件当空。
fn read_file(directory: &Path, name: &str, carried: bool) -> Vec<ErrorLogEntry> {
    let Ok(text) = fs::read_to_string(directory.join(name)) else {
        return Vec::new();
    };
    // `error*` 两份是制表符文本（前端在用），黑匣子两份是 JSON 行（Rust 与 Kotlin 都在写）。
    let entries = if name.starts_with("error") {
        parse_text(&text)
    } else {
        parse_json_lines(&text)
    };
    entries
        .into_iter()
        .map(|mut entry| {
            if carried {
                entry.source = format!("{CARRIED_PREFIX}{}", entry.source);
            }
            entry
        })
        .collect()
}

/// 界面要的那一份：从新到旧，本次在前、上次在后。
///
/// 每一份文件里的顺序就是写入顺序（也就是时间顺序），所以倒着读一份文件就是「新的在上」，
/// 不需要再按时间排序——`at` 有两种写法（ISO 与 `epoch:`），混在一起排序反而会把顺序弄乱。
fn read_all(app: &tauri::AppHandle) -> Result<Vec<ErrorLogEntry>, String> {
    let directory = log_dir(app)?;
    // 本次运行：错误在最上面，然后是黑匣子（真的崩了的话，那几步就在最顶上）。
    let buckets = [
        (ERROR_LOG, false),
        (CRASH_LOG, false),
        (JAVA_CRASH_LOG, false),
        // 上次运行：崩溃现场比普通错误更要紧，排在上面。
        (JAVA_CRASH_PREVIOUS, true),
        (CRASH_PREVIOUS, true),
        (ERROR_PREVIOUS, true),
    ];
    let mut entries: Vec<ErrorLogEntry> = Vec::new();
    for (name, carried) in buckets {
        let mut bucket = read_file(&directory, name, carried);
        bucket.reverse();
        entries.extend(bucket);
    }
    // panic 既写黑匣子也写文本日志（活下来的那次要在「本次运行」里看得见），轮到「上次」
    // 时两边都会读出来——同一件事说两遍只会让人以为崩了两次。
    let mut seen = HashSet::new();
    entries.retain(|entry| {
        seen.insert((
            entry.at.clone(),
            entry.level.clone(),
            entry.source.clone(),
            entry.message.clone(),
        ))
    });
    entries.truncate(MAX_ENTRIES);
    Ok(entries)
}

#[tauri::command(async)]
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
#[tauri::command(async)]
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
    let lines = entries.iter().map(text_line).collect::<Vec<_>>();
    match append_lines(&path, &lines) {
        Ok(()) => CommandResult::success(()),
        Err(_) => CommandResult::failure("UNKNOWN", "Error log write failed", true),
    }
}

/// 按**数据目录**记一条（不是 `AppHandle`）。
///
/// 存在的理由：重活跑在 `spawn_blocking` 里，那里没有 handle；而日志的位置、格式与轮转
/// 必须和 `error_log_write` 完全同一套（`<data>/logs/error.log`、同一份制表符文本），
/// 否则界面那个「错误日志」面板就看不到它。调用方自己保证不写图片内容与凭据。
pub(crate) fn record_at_data_dir(
    data_dir: &Path,
    level: &str,
    source: &str,
    message: &str,
    detail: Option<&str>,
) -> Result<(), String> {
    if message.trim().is_empty() {
        return Ok(());
    }
    let directory = data_dir.join("logs");
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    let entry = ErrorLogEntry {
        at: now_stamp(),
        level: level.to_string(),
        source: source.to_string(),
        message: message.to_string(),
        detail: detail
            .filter(|value| !value.trim().is_empty())
            .map(|value| value.to_string()),
    };
    append_lines(&directory.join(ERROR_LOG), &[text_line(&entry)])
}

/// 清空两轮的全部记录。
///
/// 删文件而不是截断成空：`rotate` 靠「文件在不在」判断哪一轮有没有东西（见它的注释），
/// 留一个空文件会让「上次运行」那一栏永远是有的。返回删掉了几条，界面拿它说一声。
#[tauri::command(async)]
pub fn error_log_clear(app: tauri::AppHandle) -> CommandResult<usize> {
    let dropped = read_all(&app).map(|entries| entries.len()).unwrap_or(0);
    let Ok(directory) = log_dir(&app) else {
        return CommandResult::failure("UNKNOWN", "Error log unavailable", true);
    };
    remove_log_files(&directory);
    CommandResult::success(dropped)
}

/// 两轮的全部记录文件。
const LOG_FILES: [&str; 6] = [
    ERROR_LOG,
    ERROR_PREVIOUS,
    CRASH_LOG,
    CRASH_PREVIOUS,
    JAVA_CRASH_LOG,
    JAVA_CRASH_PREVIOUS,
];

fn remove_log_files(directory: &Path) {
    for name in LOG_FILES {
        let _ = fs::remove_file(directory.join(name));
    }
}

#[tauri::command(async)]
pub fn error_log_read(app: tauri::AppHandle) -> CommandResult<Vec<ErrorLogEntry>> {
    match read_all(&app) {
        Ok(entries) => CommandResult::success(entries),
        Err(_) => CommandResult::failure("UNKNOWN", "Error log unavailable", true),
    }
}

/// 把界面上的那份日志写到用户选定的位置。内容由**调用方**给：导出的是用户眼前这一份，
/// 而不是这里再拼一次的另一个版本——「导出的日志是空的」正是两次拼装走散的产物。
///
/// Android 上 `dialog.save` 交回来的是 SAF 的 `content://` URI（系统的「新建文档」已经
/// 把文件建好了，零字节），`std::fs` 对它无能为力，得走原生那层 ContentResolver。
#[tauri::command]
pub async fn error_log_export(
    app: tauri::AppHandle,
    path: String,
    contents: String,
) -> Result<CommandResult<String>, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Ok(CommandResult::failure("INVALID_INPUT", "Export path is empty", false));
    }
    if contents.trim().is_empty() {
        return Ok(CommandResult::failure("INVALID_INPUT", "Error log is empty", false));
    }
    match write_export(&app, trimmed, &contents).await {
        Ok(()) => Ok(CommandResult::success(trimmed.to_string())),
        Err(message) => Ok(CommandResult::failure("UNKNOWN", message, true)),
    }
}

#[cfg(target_os = "android")]
async fn write_export(app: &tauri::AppHandle, path: &str, contents: &str) -> Result<(), String> {
    crate::mobile_host::write_text_file(app, path, contents).await
}

#[cfg(not(target_os = "android"))]
async fn write_export(_app: &tauri::AppHandle, path: &str, contents: &str) -> Result<(), String> {
    fs::write(path, contents).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_crash_file_keeps_only_its_tail() {
        let dir = std::env::temp_dir().join(format!("yomika-crash-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("temp dir");
        let path = dir.join(CRASH_LOG);
        let lines: Vec<String> = (0..250)
            .map(|index| {
                serde_json::json!({ "at": format!("epoch:{index}"), "level": "warn", "source": "s", "message": format!("step {index}"), "detail": null }).to_string()
            })
            .collect();
        fs::write(&path, lines.join("\n") + "\n").expect("seed");
        cap_lines(&path, 200).expect("cap");
        let entries = parse_json_lines(&fs::read_to_string(&path).expect("read"));
        assert_eq!(entries.len(), 200);
        // 丢掉的是最早的，留下的是最新的——崩溃现场的尾巴才是我们要的。
        assert_eq!(entries[0].message, "step 50");
        assert_eq!(entries[199].message, "step 249");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn crash_records_survive_a_restart_and_bad_lines_are_dropped() {
        // 黑匣子是「上一次运行为什么没了」的唯一线索：它必须能被读回来，且一条坏行
        // （写到一半断电）不能把整页拖没。
        let good = serde_json::json!({
            "at": "epoch:1700000000000",
            "level": "error",
            "source": "core/panic",
            "message": "attempt to unwrap None",
            "detail": "src/commands/eh.rs:900",
        });
        let text = format!("{good}\n{{ truncated\n\n{}", serde_json::json!({
            "at": "epoch:1700000001000",
            "level": "error",
            "source": "core/panic",
            "message": "second",
            "detail": null,
        }));
        let entries = parse_json_lines(&text);
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].message, "attempt to unwrap None");
        assert_eq!(entries[0].detail.as_deref(), Some("src/commands/eh.rs:900"));
        assert_eq!(entries[1].message, "second");
    }

    #[test]
    fn clearing_removes_both_rounds_and_the_black_box() {
        let dir = std::env::temp_dir().join(format!("yomika-clear-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("temp dir");
        for name in LOG_FILES {
            fs::write(dir.join(name), "2026-09-28T00:00:00Z	error	b	m
").expect("seed");
        }
        remove_log_files(&dir);
        for name in LOG_FILES {
            assert!(!dir.join(name).exists(), "{name} 还在");
        }
        // 清空之后再写一条：文件按需重建（rotate 靠「文件在不在」认这一轮有没有东西）。
        let path = dir.join(ERROR_LOG);
        append_lines(&path, &[String::from("2026-09-28T00:00:01Z	error	b	m
")]).expect("append");
        assert!(path.exists());
        let _ = fs::remove_dir_all(&dir);
    }

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
            parse_text(line),
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
            parse_text("epoch:1\twarn\treader\t页面加载失败\t")[0].detail,
            None
        );
        // 空行（被清空过的文件）解析成空列表，而不是一条空记录。
        assert!(parse_text("").is_empty());
        assert!(parse_text("\n\n").is_empty());
        // 写回去还是同一行（导出的文本就是这些字段）。
        let entry = parse_text(line).remove(0);
        assert_eq!(text_line(&entry), line);
    }

    #[test]
    fn parsing_keeps_only_the_newest_entries() {
        let text = (0..MAX_ENTRIES + 25)
            .map(|index| format!("epoch:{index}\terror\tsource\tmessage\t"))
            .collect::<Vec<_>>()
            .join("\n");
        let entries = parse_text(&text);
        assert_eq!(entries.len(), MAX_ENTRIES);
        assert_eq!(entries[0].at, format!("epoch:{}", 25));
        assert_eq!(entries[entries.len() - 1].at, format!("epoch:{}", MAX_ENTRIES + 24));
    }

    #[test]
    fn each_file_is_read_newest_first_and_last_run_comes_after_this_one() {
        let dir = std::env::temp_dir().join(format!("yomika-buckets-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("temp dir");
        fs::write(dir.join(ERROR_LOG), "epoch:1\terror\tfront\ta\t\nepoch:2\terror\tfront\tb\t\n").expect("seed");
        fs::write(dir.join(CRASH_LOG), "{\"at\":\"epoch:3\",\"level\":\"warn\",\"source\":\"eh/in-app-login\",\"message\":\"step\",\"detail\":null}\n").expect("seed");
        fs::write(dir.join(CRASH_PREVIOUS), "{\"at\":\"epoch:0\",\"level\":\"warn\",\"source\":\"eh/in-app-login\",\"message\":\"old step\",\"detail\":null}\n").expect("seed");
        fs::write(dir.join(ERROR_PREVIOUS), "epoch:-1\terror\tfront\told\t\n").expect("seed");

        let mut entries = Vec::new();
        for (name, carried) in [
            (ERROR_LOG, false),
            (CRASH_LOG, false),
            (JAVA_CRASH_LOG, false),
            (JAVA_CRASH_PREVIOUS, true),
            (CRASH_PREVIOUS, true),
            (ERROR_PREVIOUS, true),
        ] {
            let mut bucket = read_file(&dir, name, carried);
            bucket.reverse();
            entries.extend(bucket);
        }
        let messages: Vec<&str> = entries.iter().map(|entry| entry.message.as_str()).collect();
        // 本次：文本日志新的在上，然后是黑匣子；上次的排在最后，带前缀。
        assert_eq!(messages, vec!["b", "a", "step", "old step", "old"]);
        assert!(!entries[0].source.starts_with(CARRIED_PREFIX));
        assert!(entries[3].source.starts_with(CARRIED_PREFIX));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_panic_written_to_both_files_shows_up_once() {
        // panic 同时进黑匣子和文本日志：轮到「上次运行」时两边都能读出来，去重后只该剩一条。
        let entry = ErrorLogEntry {
            at: String::from("epoch:1700000000000"),
            level: String::from("error"),
            source: String::from("core/panic"),
            message: String::from("boom"),
            detail: Some(String::from("src/lib.rs:1")),
        };
        let mut entries = vec![entry.clone(), entry.clone()];
        let mut seen = HashSet::new();
        entries.retain(|entry| {
            seen.insert((
                entry.at.clone(),
                entry.level.clone(),
                entry.source.clone(),
                entry.message.clone(),
            ))
        });
        assert_eq!(entries.len(), 1);
    }
}
