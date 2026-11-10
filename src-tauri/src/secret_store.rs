//! 凭据落盘：一处入口，两种后端。
//!
//! 桌面（Windows / macOS / Linux）仍旧走系统凭据库（keyring），**条目名与格式一个字节
//! 都没变**——Windows 上还是 `LegacyGeneric:target=scope_ba325455….app.yomika.reader`
//! 那样一条，老条目照读不误。
//!
//! 移动（Android / iOS）必须换一条路：keyring 3.6.3 没有任何移动后端，当目标平台上没有
//! 可用的平台存储特性时它会退化成一个平台无关的 mock（`src/mock.rs` 的
//! `CredentialPersistence::EntryOnly`，原文「There is no persistence other than in the
//! entry itself」）——每次 `Entry::new` 都 `build` 出一个**全新的空**对象。于是写进去的
//! API Key 当场丢在一个马上被丢弃的临时对象里，之后每次读都是 `NoEntry`，档案库、E-H
//! Cookie 等凭据在手机上全部「凭据不可用」。这里改成数据目录（`init` 记下的那个）
//! 下的一份 `secrets.json`。
//!
//! 明文落盘是移动端不得不做的取舍：Android/iOS 上没有一个 keyring 能用的系统凭据库，
//! 而「读不出来」不是可接受的现状。文件权限收到 0600，且只放在应用自己的数据目录里。
//!
//! 文件存储的实现放在 [`file_store`]——**不被 cfg 关掉**，所以它在 Windows 宿主上照样
//! 编译、照样单测；cfg 只决定入口走 keyring 还是走文件。

use std::path::Path;

#[cfg(any(target_os = "android", target_os = "ios"))]
use std::path::PathBuf;
#[cfg(any(target_os = "android", target_os = "ios"))]
use std::sync::Mutex;

/// 移动端真的用的那一份，也原样编进桌面构建（单测要跑它）。桌面构建里没人调用它，
/// 所以允许 `dead_code`。
#[cfg_attr(not(any(target_os = "android", target_os = "ios")), allow(dead_code))]
mod file_store {
    use std::io::Write;
    use std::path::Path;
    use std::sync::{Mutex, PoisonError};

    /// 落在 `data_paths::prepare` 建好的数据目录里。
    pub(super) const FILE_NAME: &str = "secrets.json";

    /// 读不到条目时的文案：与 keyring 的 `Error::NoEntry` 显示文本**逐字一致**，这样
    /// `commands::library::credential_read_error` 那条「服务器凭据不可用，请重新保存
    /// API Key」的友好文案在移动端照样命中（它按这两段子串判断）。
    pub(super) const NO_MATCHING_ENTRY: &str = "No matching entry found in secure storage";

    /// 读写共用的那把锁。`secrets.json` 的每次改动都是「读整份 → 改一条 → 写整份」，
    /// 两个线程交错就会丢掉一条（Android 上 WebView 的命令线程与后台同步线程都可能来写）。
    static LOCK: Mutex<()> = Mutex::new(());

    /// 一条凭据。选 `{service, account, value}` 的**数组**，而不是
    /// `"service/account": value` 那种 map：service 与 account 都是用户数据（scope_id 里
    /// 有 `.`、有 `:`），拼成 map 的键就得先定义一套转义/分隔约定，数组把两个字段各自
    /// 原样存着，一条约定都不需要。
    #[derive(serde::Serialize, serde::Deserialize)]
    struct Entry {
        service: String,
        account: String,
        value: String,
    }

    fn lock() -> std::sync::MutexGuard<'static, ()> {
        // 中毒只说明别的线程持锁时 panic 了，文件本身没被写坏（写入是原子的）。接着用，
        // 不要把 panic 一路传下去。
        LOCK.lock().unwrap_or_else(PoisonError::into_inner)
    }

    pub(super) fn set(
        dir: &Path,
        service: &str,
        account: &str,
        value: &str,
    ) -> Result<(), String> {
        let _guard = lock();
        let mut entries = read(dir)?;
        match entries
            .iter_mut()
            .find(|entry| entry.service == service && entry.account == account)
        {
            Some(entry) => entry.value = value.to_string(),
            None => entries.push(Entry {
                service: service.to_string(),
                account: account.to_string(),
                value: value.to_string(),
            }),
        }
        write(dir, &entries)
    }

    pub(super) fn get(dir: &Path, service: &str, account: &str) -> Result<String, String> {
        let _guard = lock();
        read(dir)?
            .into_iter()
            .find(|entry| entry.service == service && entry.account == account)
            .map(|entry| entry.value)
            .ok_or_else(|| NO_MATCHING_ENTRY.to_string())
    }

    pub(super) fn delete(dir: &Path, service: &str, account: &str) -> Result<(), String> {
        let _guard = lock();
        let mut entries = read(dir)?;
        let before = entries.len();
        entries.retain(|entry| !(entry.service == service && entry.account == account));
        if entries.len() == before {
            return Err(NO_MATCHING_ENTRY.to_string());
        }
        write(dir, &entries)
    }

    /// 文件不存在、或者是空文件，都算「一条都没有」：`get` 于是落到
    /// [`NO_MATCHING_ENTRY`]，`set` 于是新建一份——第一次保存不需要先有人建文件。
    fn read(dir: &Path) -> Result<Vec<Entry>, String> {
        let path = dir.join(FILE_NAME);
        let text = match std::fs::read_to_string(&path) {
            Ok(text) => text,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(format!("读取凭据文件失败：{error}")),
        };
        if text.trim().is_empty() {
            return Ok(Vec::new());
        }
        // 损坏的 JSON 只报错，绝不 panic：这个文件是用户数据目录里的一份普通文件，
        // 半截的写入、手工编辑、换设备拷贝都可能让它不成形。
        serde_json::from_str(&text).map_err(|error| {
            format!(
                "凭据文件 {} 已损坏（不是有效的 JSON）：{error}",
                path.display()
            )
        })
    }

    /// 先写同目录的临时文件、`sync_all` 之后再 `rename`：中途掉电留下的是临时文件，
    /// `secrets.json` 要么是旧的完整内容、要么是新的完整内容，不会是一半。
    ///
    /// 临时文件必须与目标**同目录**（跨文件系统的 `rename` 会失败），名字带上 pid
    /// 免得两个进程挑中同一个临时文件。
    fn write(dir: &Path, entries: &[Entry]) -> Result<(), String> {
        let path = dir.join(FILE_NAME);
        let temp = dir.join(format!("{}.{}.tmp", FILE_NAME, std::process::id()));
        let serialized =
            serde_json::to_vec_pretty(entries).map_err(|error| format!("序列化凭据失败：{error}"))?;
        let written = (|| -> std::io::Result<()> {
            let mut file = std::fs::File::create(&temp)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                // 明文文件，只有属主能读。Android/iOS 上文件也在应用沙箱里，这层是
                // 沙箱之外的第二道。
                file.set_permissions(std::fs::Permissions::from_mode(0o600))?;
            }
            file.write_all(&serialized)?;
            // 先落盘再改名：否则掉电后可能出现「名字是新的、内容是空的」。
            file.sync_all()?;
            // Windows 上 rename 到已存在的文件也是替换语义（MOVEFILE_REPLACE_EXISTING），
            // 但句柄必须先关掉，所以这里显式 drop。
            drop(file);
            std::fs::rename(&temp, &path)
        })();
        if let Err(error) = written {
            let _ = std::fs::remove_file(&temp);
            return Err(format!("写入凭据文件失败：{error}"));
        }
        Ok(())
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        /// 每个测试一个自己的目录，`Drop` 里删掉：断言失败也不会在 `temp_dir` 里留垃圾。
        struct TempDir(std::path::PathBuf);

        impl TempDir {
            fn new(label: &str) -> Self {
                let dir = std::env::temp_dir().join(format!(
                    "yomika-secret-store-{label}-{}",
                    std::process::id()
                ));
                let _ = std::fs::remove_dir_all(&dir);
                std::fs::create_dir_all(&dir).expect("temp dir");
                Self(dir)
            }

            fn path(&self) -> &Path {
                &self.0
            }

            fn raw(&self) -> String {
                std::fs::read_to_string(self.path().join(FILE_NAME)).expect("secrets file")
            }
        }

        impl Drop for TempDir {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }

        #[test]
        fn a_written_secret_reads_back_and_an_overwrite_wins() {
            let dir = TempDir::new("roundtrip");
            set(dir.path(), "app.yomika.reader", "scope-a", "first").expect("set");
            assert_eq!(
                get(dir.path(), "app.yomika.reader", "scope-a").expect("get"),
                "first"
            );

            set(dir.path(), "app.yomika.reader", "scope-a", "second").expect("overwrite");
            assert_eq!(
                get(dir.path(), "app.yomika.reader", "scope-a").expect("get after overwrite"),
                "second"
            );

            // 覆盖写是改那一条，不是又追加一条。
            let entries: Vec<serde_json::Value> =
                serde_json::from_str(&dir.raw()).expect("json array");
            assert_eq!(entries.len(), 1);
        }

        #[test]
        fn an_absent_file_or_entry_reports_the_no_matching_entry_text() {
            let dir = TempDir::new("absent");
            // 文件还不存在。
            assert_eq!(
                get(dir.path(), "app.yomika.reader", "scope-a").unwrap_err(),
                NO_MATCHING_ENTRY
            );

            set(dir.path(), "app.yomika.reader", "scope-a", "value").expect("set");
            // 文件在，但这一个 (service, account) 不在。
            assert_eq!(
                get(dir.path(), "app.yomika.reader", "scope-b").unwrap_err(),
                NO_MATCHING_ENTRY
            );
            assert_eq!(
                get(dir.path(), "app.yomika.eh", "scope-a").unwrap_err(),
                NO_MATCHING_ENTRY
            );
        }

        #[test]
        fn two_services_and_two_accounts_do_not_interfere() {
            let dir = TempDir::new("isolation");
            set(dir.path(), "app.yomika.reader", "scope-a", "reader-a").expect("set reader a");
            set(dir.path(), "app.yomika.reader", "scope-b", "reader-b").expect("set reader b");
            set(dir.path(), "app.yomika.eh", "scope-a", "eh-a").expect("set eh a");

            delete(dir.path(), "app.yomika.reader", "scope-a").expect("delete reader a");

            assert_eq!(
                get(dir.path(), "app.yomika.reader", "scope-b").expect("reader b survives"),
                "reader-b"
            );
            assert_eq!(
                get(dir.path(), "app.yomika.eh", "scope-a").expect("eh a survives"),
                "eh-a"
            );
            assert_eq!(
                get(dir.path(), "app.yomika.reader", "scope-a").unwrap_err(),
                NO_MATCHING_ENTRY
            );
        }

        #[test]
        fn deleting_an_absent_entry_is_an_error_with_the_same_text() {
            let dir = TempDir::new("delete");
            assert_eq!(
                delete(dir.path(), "app.yomika.reader", "scope-a").unwrap_err(),
                NO_MATCHING_ENTRY
            );

            set(dir.path(), "app.yomika.reader", "scope-a", "value").expect("set");
            delete(dir.path(), "app.yomika.reader", "scope-a").expect("delete");
            assert_eq!(
                get(dir.path(), "app.yomika.reader", "scope-a").unwrap_err(),
                NO_MATCHING_ENTRY
            );
            // 删光了也要留一份合法的空数组，而不是把文件删掉或留下半个 JSON。
            assert_eq!(dir.raw().trim(), "[]");
        }

        #[test]
        fn the_file_round_trips_as_an_array_of_service_account_value() {
            let dir = TempDir::new("shape");
            set(dir.path(), "app.yomika.test", "ref-1", "unicode-密钥-🔑").expect("set");

            let parsed: serde_json::Value = serde_json::from_str(&dir.raw()).expect("valid json");
            assert_eq!(
                parsed,
                serde_json::json!([
                    { "service": "app.yomika.test", "account": "ref-1", "value": "unicode-密钥-🔑" }
                ])
            );
            assert!(parsed.is_array(), "格式是数组（见模块内的取舍说明）");
        }

        #[test]
        fn a_write_leaves_no_temporary_file_behind() {
            let dir = TempDir::new("atomic");
            set(dir.path(), "app.yomika.reader", "scope-a", "value").expect("set");

            let leftovers: Vec<String> = std::fs::read_dir(dir.path())
                .expect("read dir")
                .map(|entry| entry.expect("dir entry").file_name().to_string_lossy().into_owned())
                .filter(|name| name != FILE_NAME)
                .collect();
            assert!(
                leftovers.is_empty(),
                "临时文件应当已经 rename 成 secrets.json，留下的是：{leftovers:?}"
            );
        }

        #[test]
        fn a_corrupt_file_is_reported_instead_of_panicking() {
            let dir = TempDir::new("corrupt");
            std::fs::write(dir.path().join(FILE_NAME), "{ not json at all")
                .expect("write corrupt file");

            let read_error = get(dir.path(), "app.yomika.reader", "scope-a").unwrap_err();
            assert!(
                read_error.contains("已损坏") && read_error.contains(FILE_NAME),
                "错误要说清是哪份文件坏了：{read_error}"
            );
            // 也绝不能顺手把用户文件覆盖掉。
            assert_eq!(dir.raw(), "{ not json at all");

            let write_error = set(dir.path(), "app.yomika.reader", "scope-a", "x").unwrap_err();
            assert!(write_error.contains("已损坏"), "写之前也要先读：{write_error}");
        }

        /// 权限只在 unix 上能断言；Android/iOS 也走这一段（它们是 unix）。
        #[cfg(unix)]
        #[test]
        fn the_file_is_only_readable_by_its_owner() {
            use std::os::unix::fs::PermissionsExt;

            let dir = TempDir::new("permissions");
            let mode = |dir: &TempDir| -> u32 {
                std::fs::metadata(dir.path().join(FILE_NAME))
                    .expect("metadata")
                    .permissions()
                    .mode()
                    & 0o777
            };

            set(dir.path(), "app.yomika.reader", "scope-a", "first").expect("set");
            assert_eq!(mode(&dir), 0o600);

            // 覆盖写换的是临时文件，新文件同样要是 0600（不能退回 umask 的 0644）。
            set(dir.path(), "app.yomika.reader", "scope-a", "second").expect("overwrite");
            assert_eq!(mode(&dir), 0o600);
        }
    }
}

/// 记下数据目录（移动端的 `secrets.json` 就放这里，由 `data_paths::prepare` 建好并调用）。
///
/// 桌面端凭据在系统凭据库里，与这个目录无关，所以那边这个函数什么都不做——签名一致，
/// 启动链路只有一处调用。
pub(crate) fn init(dir: &Path) {
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        *DIR
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(dir.to_path_buf());
    }
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        let _ = dir;
    }
}

#[cfg(any(target_os = "android", target_os = "ios"))]
static DIR: Mutex<Option<PathBuf>> = Mutex::new(None);

/// 没 `init` 就没有可写的地方：**不要**退回临时目录——那样每次启动看上去「能存」，
/// 重启后又全丢，用户看到的还是同一个 bug，只是更难查。明确报错。
#[cfg(any(target_os = "android", target_os = "ios"))]
fn data_dir() -> Result<PathBuf, String> {
    DIR.lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .clone()
        .ok_or_else(|| "凭据文件存储尚未初始化（secret_store::init 没有被调用）".to_string())
}

/// 存一条凭据。桌面：系统凭据库；移动：数据目录里的 `secrets.json`。
pub(crate) fn set_secret(service: &str, account: &str, value: &str) -> Result<(), String> {
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        // 与改动之前逐字相同：服务名、账户名、底层 Windows 凭据条目的形状都没动，
        // 老的 `LegacyGeneric:target=scope_….app.yomika.reader` 条目继续能读。
        keyring::Entry::new(service, account)
            .map_err(|error| error.to_string())?
            .set_password(value)
            .map_err(|error| error.to_string())
    }
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        file_store::set(&data_dir()?, service, account, value)
    }
}

/// 读一条凭据。读不到时两边给出同一句
/// `No matching entry found in secure storage`（桌面来自 keyring 的 `NoEntry`，
/// 移动来自 `file_store::NO_MATCHING_ENTRY`）。
pub(crate) fn get_secret(service: &str, account: &str) -> Result<String, String> {
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        keyring::Entry::new(service, account)
            .map_err(|error| error.to_string())?
            .get_password()
            .map_err(|error| error.to_string())
    }
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        file_store::get(&data_dir()?, service, account)
    }
}

/// 删一条凭据。删掉不存在的条目按「读不到」报错，与 keyring 的 `NoEntry` 一致；
/// 调用点本来都在清理路径上忽略返回值（`let _ = credentials.delete_credential(...)`）。
pub(crate) fn delete_secret(service: &str, account: &str) -> Result<(), String> {
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        keyring::Entry::new(service, account)
            .map_err(|error| error.to_string())?
            .delete_credential()
            .map_err(|error| error.to_string())
    }
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        file_store::delete(&data_dir()?, service, account)
    }
}
