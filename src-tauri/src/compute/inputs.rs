//! 宿主侧的输入交接（docs/71 §7.1）：把要算的那张图安全地摆进 worker 的输入根。
//!
//! 分工说清楚：这里只负责「按内容把一份源文件放进授权根、返回相对路径」。能不能
//! 算这张图（哪个档案、哪一页、设置合不合法、用户有没有权限）是调用方查完数据库
//! 之后的事，核心 crate 与 worker 都不该知道。
//!
//! 为什么是「内容寻址 + 硬链接优先」：源文件是宿主缓存里内容寻址的 blob，同一份
//! 内容反复算（换设置、换后端）时不该反复复制几十 MB。硬链接共享 inode，而缓存的
//! 发布是 create-new + rename（Task 5），从不就地改一个已存在的 blob，所以共享 inode
//! 不会让正在算的输入中途变样；跨卷或权限不允许时退回复制。两条路都要复核长度与
//! hash——硬链接省的是 IO，不是信任。
//!
//! worker 侧会拿着这个相对路径重新解析、再复核一次长度与 hash
//! （`yomika_compute_core::inputs`），所以就算这里被绕过，worker 也不会去读授权根
//! 之外的任何东西。

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use yomika_compute_core::inputs::{verify_file, InputError};

use super::artifacts::{is_safe_staged_name, HASH_HEX_BYTES};

/// 输入根：`compute/staging` 的兄弟目录，也就是 `<data_root>/compute/inputs`。
///
/// 用兄弟目录而不是 staging 的子目录：worker 只被允许在 staging 根下**平铺**写
/// 一个文件（§7.2），产物与输入混在一层里迟早会有人把输入当产物收走。
pub fn inputs_root_for(staging_root: &Path) -> PathBuf {
    match staging_root.parent() {
        Some(parent) => parent.join("inputs"),
        // staging 本身就是卷根这种畸形情况：退化成子目录，也仍然是绝对路径。
        None => staging_root.join("inputs"),
    }
}

/// 输入根里多久没人碰过就算没人要了。比 staging 的零宽限保守得多：输入是宿主放
/// 在那儿的，随时可能被另一件任务复用；而 staging 里的半成品只属于某一次运行，
/// 握手那一刻确定没有写者，所以那边可以立刻扫。
pub const INPUT_SWEEP_GRACE: Duration = Duration::from_secs(3600);

/// 把一个源文件按内容放进输入根，返回 worker 用的相对路径（`/` 分隔）。
///
/// `content_hash` 由调用方给出（宿主在读缓存时算好并记下来的那一份），所以这里
/// 只在落盘之后独立复核一次，不信任何口径。
pub fn stage(inputs_root: &Path, source: &Path, content_hash: &str) -> Result<String, InputError> {
    let hash = content_hash.to_ascii_lowercase();
    if hash.len() != HASH_HEX_BYTES || !hash.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(InputError::Io {
            path: source.to_path_buf(),
            detail: format!("内容 hash 必须是 {HASH_HEX_BYTES} 位十六进制，收到 {content_hash}"),
        });
    }
    let length = fs::metadata(source)
        .map_err(|error| io_error(source, &error))?
        .len();

    let relative = relative_for(&hash, source);
    let destination = inputs_root.join(&relative);
    let parent = destination.parent().ok_or_else(|| InputError::Io {
        path: destination.clone(),
        detail: "输入根拼出来的路径没有父目录".to_string(),
    })?;
    fs::create_dir_all(parent).map_err(|error| io_error(parent, &error))?;

    if reusable(&destination, &hash, length) {
        return Ok(relative);
    }

    let part = part_path(&destination);
    // 先硬链接（同卷、权限允许时省一整个文件的复制），不行再复制。
    if fs::hard_link(source, &part).is_err() {
        fs::copy(source, &part).map_err(|error| io_error(source, &error))?;
    }
    if let Err(error) = verify_file(&part, &hash, length) {
        let _ = fs::remove_file(&part);
        return Err(error);
    }
    publish_part(&part, &destination, &hash, length, relative)
}

/// 把**已经在内存里的**字节按内容放进输入根，返回 worker 用的相对路径。
///
/// 与 [`stage`] 的分工只有一处：`stage` 的源是盘上的一个文件，所以能硬链接省一次
/// 复制；这里拿到的是字节——旧命令代理手里的正是缓存交出来的 `Vec<u8>`
/// （`inference::cached_derived` 给的就是字节）。为了硬链接再按路径把同一个文件读
/// 一次，等于把「取字节」与「放输入」之间的窗口留给别人（那个文件可能刚好被缓存的
/// 清扫收走），而写一份进去只有一次写，代价是明确的。内容寻址名与复核完全一样：
/// 落盘之后独立算一次 hash 与长度。
pub fn stage_bytes(
    inputs_root: &Path,
    bytes: &[u8],
    content_hash: &str,
    extension: &str,
) -> Result<String, InputError> {
    let hash = content_hash.to_ascii_lowercase();
    if hash.len() != HASH_HEX_BYTES || !hash.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(InputError::Io {
            path: inputs_root.to_path_buf(),
            detail: format!("内容 hash 必须是 {HASH_HEX_BYTES} 位十六进制，收到 {content_hash}"),
        });
    }
    let length = bytes.len() as u64;
    if length == 0 {
        return Err(InputError::Io {
            path: inputs_root.to_path_buf(),
            detail: "输入是空的，不放".to_string(),
        });
    }

    let relative = relative_named(&hash, sane_extension(Some(extension)).as_deref());
    let destination = inputs_root.join(&relative);
    let parent = destination.parent().ok_or_else(|| InputError::Io {
        path: destination.clone(),
        detail: "输入根拼出来的路径没有父目录".to_string(),
    })?;
    fs::create_dir_all(parent).map_err(|error| io_error(parent, &error))?;

    if reusable(&destination, &hash, length) {
        return Ok(relative);
    }

    let part = part_path(&destination);
    fs::write(&part, bytes).map_err(|error| io_error(&part, &error))?;
    if let Err(error) = verify_file(&part, &hash, length) {
        let _ = fs::remove_file(&part);
        return Err(error);
    }
    publish_part(&part, &destination, &hash, length, relative)
}

/// 半成品的名字：同一目标名后面加 `.part`，落在同一个前缀目录里（清扫认得它）。
fn part_path(destination: &Path) -> PathBuf {
    destination.with_file_name(format!(
        "{}.part",
        destination
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("staged")
    ))
}

/// 把已经复核过的半成品放到最终名字上，处理「同一份内容已经有人放好了」的竞争。
fn publish_part(
    part: &Path,
    destination: &Path,
    hash: &str,
    length: u64,
    relative: String,
) -> Result<String, InputError> {
    match fs::rename(part, destination) {
        Ok(()) => Ok(relative),
        Err(error) => {
            if verify_file(destination, hash, length).is_ok() {
                let _ = fs::remove_file(part);
                touch(destination);
                return Ok(relative);
            }
            let _ = fs::remove_file(part);
            Err(io_error(destination, &error))
        }
    }
}

/// 一个盘上文件的内容哈希（blake3，与 [`stage`] 要的那一栏同一个口径）。
///
/// 为什么要有它：`stage` 要调用方**先**给出内容哈希，而有的输入是一百多兆的二进制
/// （DLSSNR 的片段 DLL），既不该整个读进内存、也不该被拷一份再算。按块流过去，算完
/// 把结果交给 `stage` 去硬链接——一次读、零次复制。
pub fn hash_file(path: &Path) -> Result<String, InputError> {
    use std::io::Read;

    let mut file = fs::File::open(path).map_err(|error| io_error(path, &error))?;
    let mut hasher = blake3::Hasher::new();
    let mut buffer = vec![0u8; HASH_CHUNK_BYTES];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| io_error(path, &error))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hasher.finalize().to_hex().to_string())
}

/// 算哈希时一次读多少：1 MiB 在顺序读上已经跑满盘，也不至于让宿主多占几兆内存。
const HASH_CHUNK_BYTES: usize = 1 << 20;

/// 清掉输入根里超过宽限没人碰过的输入。只认两位十六进制的前缀目录与普通文件，
/// 别的（子目录、重解析点、怪名字）都不是我们放的，宁可不碰——与 staging 清扫
/// 同一口径。返回删掉的个数。
pub fn sweep_inputs(inputs_root: &Path, grace: Duration) -> usize {
    let Ok(prefixes) = fs::read_dir(inputs_root) else {
        // 目录还没建：没东西可扫，不是错误。
        return 0;
    };
    let now = SystemTime::now();
    let mut removed = 0usize;
    for prefix in prefixes.flatten() {
        let directory = prefix.path();
        let Some(name) = directory.file_name().and_then(|value| value.to_str()) else {
            continue;
        };
        if name.len() != 2 || !name.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            continue;
        }
        let Ok(entries) = fs::read_dir(&directory) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let Some(file_name) = path.file_name().and_then(|value| value.to_str()) else {
                continue;
            };
            if !is_safe_staged_name(file_name) {
                continue;
            }
            let Ok(metadata) = fs::symlink_metadata(&path) else {
                continue;
            };
            if !metadata.is_file() || metadata.file_type().is_symlink() {
                continue;
            }
            let stale = metadata
                .modified()
                .ok()
                .and_then(|modified| now.duration_since(modified).ok())
                .is_some_and(|age| age >= grace);
            if stale && fs::remove_file(&path).is_ok() {
                removed += 1;
            }
        }
        // 只在真的空了的时候成功；还有东西就留着。
        let _ = fs::remove_dir(&directory);
    }
    removed
}

/// 已经放好的那一份还算不算数：是普通文件、长度与内容都对得上。
fn reusable(destination: &Path, hash: &str, length: u64) -> bool {
    if !destination.is_file() {
        return false;
    }
    if verify_file(destination, hash, length).is_err() {
        // 对不上就当没有：下面的复制会盖掉它，不会被一份坏内容冒充成功。
        return false;
    }
    touch(destination);
    true
}

/// 刷新修改时间。清扫看的就是它，所以复用一次也算「有人还在用」。
fn touch(path: &Path) {
    if let Ok(file) = fs::File::options().write(true).open(path) {
        let _ = file.set_modified(SystemTime::now());
    }
}

/// 输入根里的相对路径：`<hash 前两位>/<hash>.<扩展名>`，扩展名保留是为了让
/// worker 那边的解码器能按同样的方式认类型（认不出来也能靠文件头兜住）。
fn relative_for(hash: &str, source: &Path) -> String {
    relative_named(
        hash,
        sane_extension(source.extension().and_then(|value| value.to_str())).as_deref(),
    )
}

/// 只有「短、全是字母数字」的扩展名才原样带上；别的（含中文、带空格）一律丢掉名字。
fn sane_extension(candidate: Option<&str>) -> Option<String> {
    candidate
        .map(|value| value.to_ascii_lowercase())
        .filter(|value| {
            !value.is_empty()
                && value.len() <= 8
                && value.chars().all(|c| c.is_ascii_alphanumeric())
        })
}

fn relative_named(hash: &str, extension: Option<&str>) -> String {
    match extension {
        Some(extension) => format!("{}/{hash}.{extension}", &hash[..2]),
        None => format!("{}/{hash}", &hash[..2]),
    }
}

fn io_error(path: &Path, error: &std::io::Error) -> InputError {
    InputError::Io {
        path: path.to_path_buf(),
        detail: error.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;
    use yomika_compute_core::inputs::resolve_granted;

    const PNG: &[u8] = b"\x89PNG\r\n\x1a\nnot-really-a-png-but-bytes";

    fn sandbox(tag: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "yomika-host-inputs-{}-{tag}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).expect("造沙箱");
        root
    }

    fn hash(bytes: &[u8]) -> String {
        blake3::hash(bytes).to_hex().to_string()
    }

    #[test]
    fn the_input_root_is_a_sibling_of_staging() {
        let staging = PathBuf::from("C:\\data\\compute\\staging");
        assert_eq!(
            inputs_root_for(&staging),
            PathBuf::from("C:\\data\\compute\\inputs")
        );
    }

    /// 盘上文件的内容哈希必须与小段字节算出来的一致——包括跨过内部读块边界的那种。
    ///
    /// 3 MiB 是故意挑的：它比 `HASH_CHUNK_BYTES` 大，所以这条用例真的会走「读满一块、
    /// 再读一块」那条路。DLSSNR 的片段是一百多兆，算错一个字节就是「授权里说的那份」
    /// 与「worker 手上那份」对不上——那是 worker 拒收，不是算出一张怪图。
    #[test]
    fn a_file_on_disk_hashes_the_same_as_its_bytes() {
        let root = sandbox("hash-file");
        let path = root.join("big.bin");
        let bytes: Vec<u8> = (0..3 * 1024 * 1024u32).map(|index| index as u8).collect();
        fs::write(&path, &bytes).expect("写大文件");

        assert_eq!(
            hash_file(&path).expect("算哈希"),
            hash(&bytes),
            "盘上这份文件的内容哈希与小段字节算出来的不一致"
        );
        // 走一遍真的摆进去：算出来的哈希必须正好是这份文件的名字。
        let inputs = root.join("inputs");
        let relative = stage(&inputs, &path, &hash(&bytes)).expect("应当暂存成功");
        assert_eq!(relative, format!("{}/{}.bin", &hash(&bytes)[..2], hash(&bytes)));
    }

    #[test]
    fn hashing_a_file_that_is_not_there_is_an_error_not_a_guess() {
        let root = sandbox("hash-missing");
        let error = hash_file(&root.join("nothing-here.bin")).expect_err("不存在的文件要报错");
        assert_eq!(error.code(), "COMPUTE_INPUT_INVALID");
        assert!(!error.message().is_empty(), "报错要说清是哪一份");
    }

    #[test]
    fn a_staged_file_lands_where_the_worker_will_look_for_it() {
        let root = sandbox("stage");
        let inputs = root.join("inputs");
        let source = root.join("cache-blob.bin");
        fs::write(&source, PNG).expect("写源文件");

        let relative = stage(&inputs, &source, &hash(PNG)).expect("应当暂存成功");
        assert_eq!(relative, format!("{}/{}.bin", &hash(PNG)[..2], hash(PNG)));

        // 关键一步：用 worker 那一侧的解析/复核代码把这份输入读回来。宿主说
        // 「放好了」不算数，worker 认它才算。
        let resolved = resolve_granted(&inputs, &relative).expect("worker 侧应当解析成功");
        assert_eq!(fs::read(&resolved).expect("读回来"), PNG);
        verify_file(&resolved, &hash(PNG), PNG.len() as u64).expect("长度与 hash 都对");
    }

    #[test]
    fn staging_the_same_content_twice_reuses_the_same_path() {
        let root = sandbox("reuse");
        let inputs = root.join("inputs");
        let source = root.join("cache-blob.png");
        fs::write(&source, PNG).expect("写源文件");

        let first = stage(&inputs, &source, &hash(PNG)).expect("第一次");
        let staged = inputs.join(&first);
        let stamp = fs::metadata(&staged)
            .and_then(|meta| meta.modified())
            .expect("拿修改时间");
        std::thread::sleep(Duration::from_millis(20));
        let second = stage(&inputs, &source, &hash(PNG)).expect("第二次");

        assert_eq!(first, second, "同一份内容应当复用同一条路径");
        let refreshed = fs::metadata(&staged)
            .and_then(|meta| meta.modified())
            .expect("拿修改时间");
        assert!(refreshed > stamp, "复用一次也算有人还在用，时间要刷新");
    }

    #[test]
    fn a_stale_copy_that_no_longer_matches_is_replaced() {
        let root = sandbox("replace");
        let inputs = root.join("inputs");
        let source = root.join("cache-blob.png");
        fs::write(&source, PNG).expect("写源文件");

        let relative = stage(&inputs, &source, &hash(PNG)).expect("第一次");
        let staged = inputs.join(&relative);
        // 注意先删再写：暂存走的是硬链接，**从暂存路径就地写会把源文件一起写掉**
        // （同一个 inode）。要模拟「有人把放好的那份改坏了」，得先把链接断开。
        fs::remove_file(&staged).expect("断开硬链接");
        fs::write(&staged, b"tampered").expect("把放好的那份改坏");
        assert_eq!(fs::read(&staged).expect("读回来"), b"tampered");
        assert_eq!(fs::read(&source).expect("读源文件"), PNG, "暂存不许动源文件");

        let again = stage(&inputs, &source, &hash(PNG)).expect("第二次应当重放");
        assert_eq!(again, relative);
        assert_eq!(fs::read(&staged).expect("读回来"), PNG, "坏掉的那份要被覆盖");
    }

    /// 上面那条的另一半：**源文件自己**不再匹配它声明的 hash 时，宁可拒，不给错。
    ///
    /// 这条顺带把硬链接的耦合关系钉住：从暂存路径就地写，源文件也会变（同一个 inode）。
    /// 于是第二次 `stage` 复核不过，直接 `HashMismatch` —— 不拿一份对不上的字节去冒充。
    #[test]
    fn a_source_that_stopped_matching_its_hash_is_refused_rather_than_guessed() {
        let root = sandbox("source-drift");
        let inputs = root.join("inputs");
        let source = root.join("cache-blob.bin");
        fs::write(&source, PNG).expect("写源文件");

        let relative = stage(&inputs, &source, &hash(PNG)).expect("第一次");
        // 「就地写」走的是同一个 inode：源和暂存那份一起变。
        fs::write(inputs.join(&relative), b"tampered").expect("把这一份就地写坏");
        assert_eq!(fs::read(&source).expect("读源文件"), b"tampered");

        let error = stage(&inputs, &source, &hash(PNG)).expect_err("对不上就该拒");
        assert!(
            matches!(error, InputError::HashMismatch { .. }),
            "实际 {error:?}"
        );
    }

    #[test]
    fn a_hash_that_is_not_hexadecimal_is_refused() {
        let root = sandbox("badhash");
        let source = root.join("cache-blob.png");
        fs::write(&source, PNG).expect("写源文件");
        for bad in ["", "abc", &"z".repeat(64), &"a".repeat(63)] {
            let error = stage(&root.join("inputs"), &source, bad).expect_err(bad);
            assert!(matches!(error, InputError::Io { .. }), "实际 {error:?}");
        }
    }

    #[test]
    fn a_source_that_cannot_be_read_is_reported_not_ignored() {
        let root = sandbox("missing");
        let error = stage(&root.join("inputs"), &root.join("nope.bin"), &hash(PNG))
            .expect_err("源文件不存在");
        assert!(matches!(error, InputError::Io { .. }), "实际 {error:?}");
    }

    #[test]
    fn sweeping_only_takes_old_files_in_prefix_directories() {
        let root = sandbox("sweep");
        let inputs = root.join("inputs");
        let fresh_source = root.join("fresh.bin");
        fs::write(&fresh_source, PNG).expect("写源文件");
        let fresh = stage(&inputs, &fresh_source, &hash(PNG)).expect("放一份新的");

        // 一份很旧的输入，以及三个「不是我们放的东西」。
        let old_relative = format!("{}/{}.bin", &hash(b"old")[..2], hash(b"old"));
        let old_path = inputs.join(&old_relative);
        fs::create_dir_all(old_path.parent().expect("父目录")).expect("造前缀目录");
        fs::write(&old_path, b"old bytes").expect("写旧文件");
        let old_time = SystemTime::now() - Duration::from_secs(7200);
        fs::File::options()
            .write(true)
            .open(&old_path)
            .expect("打开旧文件")
            .set_modified(old_time)
            .expect("改时间");
        let stray_dir = inputs.join("not-a-prefix");
        fs::create_dir_all(&stray_dir).expect("造怪目录");
        fs::write(stray_dir.join("keep.bin"), b"keep").expect("写怪目录里的文件");
        let stray_file = inputs.join("loose.bin");
        fs::write(&stray_file, b"keep").expect("写顶层散文件");

        let removed = sweep_inputs(&inputs, Duration::from_secs(3600));
        assert_eq!(removed, 1, "只该删掉那一条过期的输入");
        assert!(!old_path.exists(), "过期的输入要没了");
        assert!(inputs.join(&fresh).exists(), "新的输入不能被扫掉");
        assert!(stray_dir.join("keep.bin").exists(), "不是我们放的目录不动");
        assert!(stray_file.exists(), "顶层散文件不动");

        // 空掉的前缀目录顺手收掉，留着也不影响，但不能把有东西的删掉。
        assert!(!old_path.parent().expect("前缀目录").exists());
        assert!(stray_dir.exists());
    }

    #[test]
    fn sweeping_an_input_root_that_does_not_exist_yet_is_not_an_error() {
        let root = sandbox("nodir");
        assert_eq!(sweep_inputs(&root.join("inputs"), Duration::ZERO), 0);
    }

    #[test]
    fn bytes_already_in_hand_are_staged_where_the_worker_will_look_for_them() {
        let root = sandbox("stage-bytes");
        let inputs = root.join("inputs");

        let relative = stage_bytes(&inputs, PNG, &hash(PNG), "png").expect("应当暂存成功");
        assert_eq!(relative, format!("{}/{}.png", &hash(PNG)[..2], hash(PNG)));

        // 与 `stage` 同一条验收：**worker 那一侧**的表达能把它解析回来、复核得过。
        let resolved = resolve_granted(&inputs, &relative).expect("worker 侧应当解析成功");
        assert_eq!(fs::read(&resolved).expect("读回来"), PNG);
        verify_file(&resolved, &hash(PNG), PNG.len() as u64).expect("长度与 hash 都对");

        // 同一份内容再放一次走的是复用，不重写。
        let again = stage_bytes(&inputs, PNG, &hash(PNG), "png").expect("第二次");
        assert_eq!(again, relative, "同一份内容复用同一条路径");
    }

    #[test]
    fn staged_bytes_are_checked_against_the_hash_they_came_with() {
        let root = sandbox("stage-bytes-wrong");
        let inputs = root.join("inputs");
        // 声明的 hash 与真给的字节不是一回事：落盘之后复核要挡住它，且不留半成品。
        let error = stage_bytes(&inputs, PNG, &hash(b"something else"), "png")
            .expect_err("对不上就该拒");
        assert!(
            matches!(error, InputError::HashMismatch { .. }),
            "实际 {error:?}"
        );
        let leftovers: Vec<_> = fs::read_dir(&inputs)
            .map(|entries| entries.flatten().map(|entry| entry.path()).collect())
            .unwrap_or_default();
        assert!(
            leftovers.iter().all(|path| !path.is_file()),
            "复核不过的半成品不许留在输入根里：{leftovers:?}"
        );
    }

    #[test]
    fn staged_bytes_refuse_the_impossible_before_touching_the_disk() {
        let root = sandbox("stage-bytes-bad");
        let inputs = root.join("inputs");
        for bad in ["", "abc", &"z".repeat(64)] {
            let error = stage_bytes(&inputs, PNG, bad, "png").expect_err(bad);
            assert!(matches!(error, InputError::Io { .. }), "实际 {error:?}");
        }
        let error = stage_bytes(&inputs, b"", &hash(b""), "png").expect_err("空输入");
        assert!(matches!(error, InputError::Io { .. }), "实际 {error:?}");
        assert!(!inputs.exists(), "一条都不合法时连目录都不该建");
    }

    #[test]
    fn the_relative_path_keeps_a_sane_extension_only() {
        let cases: BTreeMap<&str, &str> = BTreeMap::from([
            ("page.png", "png"),
            ("PAGE.PNG", "png"),
            ("page", ""),
            ("page.thisisaverylongextension", ""),
            ("page.p n g", ""),
        ]);
        for (name, expected) in cases {
            let source = Path::new(name);
            let relative = relative_for(&hash(b"x"), source);
            if expected.is_empty() {
                assert_eq!(relative, format!("{}/{}", &hash(b"x")[..2], hash(b"x")), "{name}");
            } else {
                assert_eq!(
                    relative,
                    format!("{}/{}.{}", &hash(b"x")[..2], hash(b"x"), expected),
                    "{name}"
                );
            }
        }
    }
}
