//! 随包 worker：**交付一个文件，跑起来还是两个进程**（`docs/71` §11 Task 10 第①条）。
//!
//! 为什么不是把引擎链进主 exe：宿主一旦持有 ORT/NGX 的代码，Task 8 的出口条件
//! （`docs/71:645`「宿主无 ORT/NGX 资源」）与打包自检里的 `no-host-ort` / `no-host-ngx`
//! 就都成了空话，而「worker 被杀 UI 仍可操作」「取消/预算/优先级/换代熔断」这一整套也
//! 都建立在「worker 是一个能被杀掉、能被换代的**独立进程**」之上。
//!
//! 这里做的是另一件事：`build.rs` 把编好的 worker 压进主 exe（`WORKER_PAYLOAD`），
//! 运行时把它落成一份真文件（名字里带着它自己的摘要），再照旧当独立进程拉起来。
//!
//! 压过再嵌还有第二个理由：宿主字节里于是不会出现 `DirectML.dll` / `onnxruntime` /
//! `yomika_ngx_init` 这些字样，`.github/scripts/verify-compute-package.ps1` 里那两条
//! **字节级**判据仍然咬得住——它们原本的用途正是「宿主有没有把引擎链进去」。

use sha2::Digest;
use std::io::Read;
use std::path::{Path, PathBuf};

include!(concat!(env!("OUT_DIR"), "/worker_payload.rs"));

/// 载荷容器的记号。`build.rs` 里打包那一段、这里解包这一段、以及
/// `.github/scripts/worker-payload.ps1` 里那份 PowerShell 解码，三处**逐字相同**
/// （契约里有一条判据同时钉这三处，改了一处另外两处就会红）。
const MAGIC: &[u8] = b"YOMIKA-WORKER-PAYLOAD\x01";
/// 记号 + 压缩后长度（u32 LE）+ 原长度（u32 LE）+ 原字节的 sha256。
const DIGEST_OFFSET: usize = MAGIC.len() + 4 + 4;
const HEADER_LEN: usize = DIGEST_OFFSET + 32;

/// 编进主 exe 的那一份载荷。开发机构建（没编 worker，或者没开 `YOMIKA_EMBED_WORKER`）
/// 时它是空的——那时宿主的做法与从前一字不差：找不到同级的 worker 就说找不到。
pub fn payload() -> Option<&'static [u8]> {
    if WORKER_PAYLOAD.is_empty() {
        None
    } else {
        Some(WORKER_PAYLOAD)
    }
}

fn u32_at(bytes: &[u8], offset: usize) -> u32 {
    let mut raw = [0u8; 4];
    raw.copy_from_slice(&bytes[offset..offset + 4]);
    u32::from_le_bytes(raw)
}

/// 载荷头里记的那 32 字节摘要（原字节的 sha256）。记号不对就是「这不是我们的载荷」。
pub fn header_digest(payload: &[u8]) -> Option<[u8; 32]> {
    if payload.len() < HEADER_LEN || &payload[..MAGIC.len()] != MAGIC {
        return None;
    }
    let mut digest = [0u8; 32];
    digest.copy_from_slice(&payload[DIGEST_OFFSET..HEADER_LEN]);
    Some(digest)
}

/// 从载荷里取出 worker 的字节。压缩流解不开、长度不对、摘要对不上都算拒——
/// 这三条任一成立时那份字节都不该被当成可执行文件交给系统。
pub fn unpack(payload: &[u8]) -> Result<Vec<u8>, String> {
    let digest = header_digest(payload).ok_or_else(|| "开头不是这份载荷记号".to_string())?;
    let compressed_len = u32_at(payload, MAGIC.len()) as usize;
    let original_len = u32_at(payload, MAGIC.len() + 4) as usize;
    let body = payload
        .get(HEADER_LEN..HEADER_LEN + compressed_len)
        .ok_or_else(|| "载荷被截断".to_string())?;
    let mut bytes = Vec::with_capacity(original_len);
    flate2::read::DeflateDecoder::new(body)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("解压失败：{error}"))?;
    if bytes.len() != original_len {
        return Err(format!("解出来的长度不对：{} 字节，载荷头说 {original_len}", bytes.len()));
    }
    if sha2::Sha256::digest(&bytes)[..] != digest[..] {
        return Err("解出来的字节与载荷头记的摘要对不上".to_string());
    }
    Ok(bytes)
}

/// 把载荷打成容器。宿主自己不用它，只有测试用；打包那一份住在 `build.rs`
/// （构建脚本与库是两个 crate，共用不了同一个函数——所以两边各留一份，靠打包冷启动
/// 证明它们真的对得上）。
#[cfg(test)]
fn pack(bytes: &[u8]) -> Vec<u8> {
    let mut encoder =
        flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::new(9));
    std::io::Write::write_all(&mut encoder, bytes).expect("压缩");
    let compressed = encoder.finish().expect("压缩");
    let mut payload = Vec::with_capacity(HEADER_LEN + compressed.len());
    payload.extend_from_slice(MAGIC);
    payload.extend_from_slice(&(compressed.len() as u32).to_le_bytes());
    payload.extend_from_slice(&(bytes.len() as u32).to_le_bytes());
    payload.extend_from_slice(&sha2::Sha256::digest(bytes));
    payload.extend_from_slice(&compressed);
    payload
}

/// 让 worker 在 `target` 那个位置上真的存在，并返回该用哪一个路径去起进程。
///
/// 顺序是：主 exe 里带着载荷 ⇒ **载荷赢**，落成一份**名字带摘要**的副本再用它；没有载荷
/// （开发机构建、绿色目录、`YOMIKA_EMBED_WORKER` 没开）才认同级目录里那一份，它也没有
/// 就把原路径原样还回去，`maybe_spawn` 于是照旧说「找不到 worker 可执行文件」。
///
/// 为什么有载荷时同级那份**不许**赢（这一条是上一版写反的地方）：同级目录里那个固定的
/// `yomika-compute-worker.exe` 是**上一版**的字节（就地升级只换主 exe），10-a 的构建戳
/// 会把它拒掉；而宿主的「重试」只重起同一个已经定死的路径（`manager.rs` 的
/// `Command::RetryWorker` 不清 `worker_path`），于是拒了再重试、重试再拒——界面上一句
/// 「计算进程不可用」永远撤不掉，日志里则是每一页两行 `INFERENCE_UNAVAILABLE`。
/// 认自己**这一份**载荷，这件事才有解；同级那份旧字节随后由 [forget_older] 收走。
///
/// 落点先试主 exe 旁边（便携包、开发机都在这儿），写不进去（装在 `Program Files` 下、
/// 或者主程序就是从一张只读的盘上跑的）就退到 `fallback_dir`——按定义它可写，否则这个
/// 应用本来也起不来。两处落出来的名字一样带摘要，所以「哪一代」这个问题在哪儿都一样。
///
/// 为什么落出来的副本名字里要带摘要，而不是直接叫 `yomika-compute-worker.exe`：
/// 便携安装是就地升级（只换主 exe），旧名字会被下一版当成「同级目录里已经有的一份」
/// 捡起来——那一份是上一版的字节，10-a 的判据会把它拒掉，而且**永远拒下去**。名字
/// 带摘要之后，新版落新名字，旧的那一份最多是废文件，随后被 [forget_older] 收走。
pub fn ensure(beside: &Path, fallback_dir: &Path, payload: Option<&[u8]>) -> PathBuf {
    let Some(payload) = payload else {
        // 没有载荷可落：这一条路与从前一字不差——同级目录里那一份就是它要的（开发机构建、
        // 绿色目录、用户手工换过一份），没有就把原路径还回去让 maybe_spawn 说找不到。
        return beside.to_path_buf();
    };
    let Some(digest) = header_digest(payload) else {
        eprintln!("yomika: 主 exe 里那份 worker 载荷读不出来（开头不是这份记号）");
        return beside.to_path_buf();
    };
    let Some((stem, extension)) = split_name(&beside.file_name().unwrap_or_default().to_string_lossy())
    else {
        return beside.to_path_buf();
    };
    let name = format!("{stem}-{}{extension}", short_hex(&digest));
    // 名字里带摘要只能说明「这一份是本代写下的」，说明不了「里面还是这些字节」：
    // 截断还能靠长度看出来，等长损坏（改了内容、长度不变）只有实打实算一遍摘要才看得见。
    // 所以这里过一遍 sha256——24 MB 一次，只在启动路径上发生，换来的是坏副本当场重铺，
    // 而不是「握手拒一次 → 重试还拉起同一份 → 再拒一次」那个自己咬自己的圈。
    let wanted = u64::from(u32_at(payload, MAGIC.len() + 4));
    let mut directories: Vec<&Path> = Vec::new();
    if let Some(parent) = beside.parent() {
        directories.push(parent);
    }
    if !fallback_dir.as_os_str().is_empty() && fallback_dir != beside.parent().unwrap_or(Path::new("")) {
        directories.push(fallback_dir);
    }
    let mut last = beside.to_path_buf();
    for directory in directories {
        let extracted = directory.join(&name);
        last = extracted.clone();
        if extracted.is_file() {
            match std::fs::metadata(&extracted) {
                Ok(meta) if meta.len() == wanted && file_matches_digest(&extracted, &digest) => {
                    forget_older(&extracted, &stem, &extension);
                    return extracted;
                }
                _ => {}
            }
        }
        match unpack(payload) {
            Ok(bytes) => {
                if let Err(error) = write_atomically(&extracted, &bytes) {
                    eprintln!("yomika: 把随包的 worker 落到 {} 失败：{error}", extracted.display());
                    continue;
                }
                eprintln!(
                    "yomika: 把随包的 worker 落到 {}（{} 字节）",
                    extracted.display(),
                    bytes.len()
                );
                forget_older(&extracted, &stem, &extension);
                return extracted;
            }
            Err(why) => {
                eprintln!("yomika: 主 exe 里那份 worker 载荷读不出来（{why}）");
                return beside.to_path_buf();
            }
        }
    }
    last
}

/// 落在磁盘上的这一份，是不是载荷头记的那份字节。
///
/// 名字里已经带摘要，但名字证明的是「谁写的这一份」，证明不了「里面的字节还是不是它」：
/// 被截断还能靠长度对不上看出来，等长损坏只看长度则完全看不出来。这里每个候选目录最多
/// 算一次（目录数是固定的：主 exe 旁边、必要时再退一处），所以启动路径上的代价是有界的。
fn file_matches_digest(path: &Path, expected: &[u8; 32]) -> bool {
    match std::fs::read(path) {
        Ok(bytes) => sha2::Sha256::digest(&bytes)[..] == expected[..],
        Err(_) => false,
    }
}

/// 先写临时名再 `rename`：中途崩了也只会留下一个 `.part-*`，不会留下一份「看着在、
/// 其实是半截」的可执行文件。
fn write_atomically(target: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let parent = target.parent().unwrap_or_else(|| Path::new("."));
    std::fs::create_dir_all(parent)?;
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_nanos())
        .unwrap_or(0);
    let name = target.file_name().unwrap_or_default().to_string_lossy().to_string();
    let temp = parent.join(format!(".{name}.part-{}-{nanos}", std::process::id()));
    std::fs::write(&temp, bytes)?;
    std::fs::rename(&temp, target)
}

/// 收走上一代落下来的副本（一份 24 MB，升级几次就是几百兆）。
///
/// 只认我们自己那种命名（`{stem}-<16 位十六进制>{后缀}`）：别的文件一律不碰。正在跑的
/// 那一个删不掉（Windows 上占用中的可执行文件删不掉），所以一律忽略错误——它是缓存，
/// 不是账。
///
/// `stem`/`extension` 由调用方给的是**基名**（`yomika-compute-worker` + `.exe`），不是
/// `current` 那个已经带摘要的文件名：拿带摘要的名字去推基名，推出来的是
/// `yomika-compute-worker-<这一代的摘要>`，上一代的那一份就对不上了（单元测试咬过这一口）。
fn forget_older(current: &Path, stem: &str, extension: &str) {
    let (Some(parent), Some(name)) = (
        current.parent(),
        current.file_name().map(|name| name.to_string_lossy().to_string()),
    ) else {
        return;
    };
    let Ok(entries) = std::fs::read_dir(parent) else {
        return;
    };
    for entry in entries.flatten() {
        let candidate = entry.file_name().to_string_lossy().to_string();
        if candidate == name || !is_extraction_of(&candidate, stem, extension) {
            continue;
        }
        let _ = std::fs::remove_file(entry.path());
    }
}

/// `yomika-compute-worker.exe` → (`yomika-compute-worker`, `.exe`)；没有后缀就是空后缀。
fn split_name(name: &str) -> Option<(String, String)> {
    if name.is_empty() {
        return None;
    }
    match name.rsplit_once('.') {
        Some((stem, extension)) if !stem.is_empty() => {
            Some((stem.to_string(), format!(".{extension}")))
        }
        Some(_) => None,
        None => Some((name.to_string(), String::new())),
    }
}

fn is_extraction_of(candidate: &str, stem: &str, extension: &str) -> bool {
    let Some(rest) = candidate.strip_prefix(&format!("{stem}-")) else {
        return false;
    };
    let Some(short) = rest.strip_suffix(extension) else {
        return false;
    };
    short.len() == 16 && short.bytes().all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn short_hex(digest: &[u8; 32]) -> String {
    digest.iter().take(8).map(|byte| format!("{byte:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_packed_worker_comes_back_byte_for_byte() {
        let bytes = vec![0x4du8; 4096];
        let payload = pack(&bytes);
        assert_eq!(unpack(&payload).expect("解出来"), bytes);
    }

    #[test]
    fn a_payload_whose_bytes_or_header_were_tampered_with_is_refused() {
        let bytes = vec![7u8; 2048];
        let mut payload = pack(&bytes);

        // 正文改一个字节：摘要对不上。压缩流本身就多半解不出来，两条路都算拒。
        let last = payload.len() - 1;
        payload[last] ^= 0xff;
        assert!(unpack(&payload).is_err());

        // 记号不对：这不是我们的载荷。
        let mut payload = pack(&bytes);
        payload[0] = b'X';
        assert!(unpack(&payload).is_err());

        // 摘要那 32 字节改一位：即使正文完好也必须拒。
        let mut payload = pack(&bytes);
        let digest = header_digest(&payload).expect("载荷头");
        payload[MAGIC.len() + 4 + 4] ^= 0x01;
        assert_ne!(header_digest(&payload).expect("载荷头"), digest);
        assert!(unpack(&payload).is_err());
    }

    #[test]
    fn a_host_that_carries_a_payload_lays_it_down_beside_itself() {
        let sandbox = tempfile::tempdir().expect("临时目录");
        let bytes = vec![0x11u8; 64 * 1024];
        let payload = pack(&bytes);
        let target = sandbox.path().join("yomika-compute-worker.exe");

        let resolved = ensure(&target, &sandbox.path().join("data"), Some(&payload));

        // 落出来的那一份不是 canonical 名字：名字里带着摘要，于是升级之后旧的那一份
        // 永远不会被当成新的一份捡起来（10-a 的「不是同一次构建就拒跑」正是这么判的）。
        assert_ne!(resolved, target);
        assert!(resolved.is_file(), "随包的 worker 该被落出来：{resolved:?}");
        assert_eq!(std::fs::read(&resolved).expect("读回来"), bytes);
        assert_eq!(
            resolved.parent(),
            Some(sandbox.path()),
            "主 exe 旁边写得进去，就不该退到数据目录"
        );
        let name = resolved.file_name().and_then(|name| name.to_str()).unwrap_or_default();
        let digest = header_digest(&payload).expect("载荷头");
        let short = digest.iter().map(|byte| format!("{byte:02x}")).collect::<String>();
        assert_eq!(name, format!("yomika-compute-worker-{}.exe", &short[..16]));
        // 落盘是原子的：不许留下 .part 之类的半成品。
        let leftovers = std::fs::read_dir(sandbox.path())
            .expect("目录")
            .filter_map(|entry| entry.ok())
            .filter(|entry| entry.file_name().to_string_lossy().contains(".part-"))
            .count();
        assert_eq!(leftovers, 0, "落盘留下的半成品要清干净");
    }

    #[test]
    fn a_beside_that_cannot_be_written_falls_back_to_the_data_directory() {
        let sandbox = tempfile::tempdir().expect("临时目录");
        let bytes = vec![0x55u8; 32 * 1024];
        let payload = pack(&bytes);
        // 主程序旁边写不进去的那种现场：把「同级目录」做成一个**文件**，于是
        // `create_dir_all` / `rename` 必然失败（装到 `Program Files` 下是同一个形状）。
        let blocked = sandbox.path().join("read-only");
        std::fs::write(&blocked, b"not a directory").expect("摆一个挡路的文件");
        let beside = blocked.join("yomika-compute-worker.exe");
        let fallback = sandbox.path().join("data");

        let resolved = ensure(&beside, &fallback, Some(&payload));

        assert_eq!(
            resolved.parent(),
            Some(fallback.as_path()),
            "写不进去就该落到还能写的那一处，而不是把这一页交回去"
        );
        assert_eq!(std::fs::read(&resolved).expect("读回来"), bytes);
    }

    #[test]
    fn a_stale_worker_beside_the_host_does_not_beat_the_payload() {
        let sandbox = tempfile::tempdir().expect("临时目录");
        let target = sandbox.path().join("yomika-compute-worker.exe");
        // 上一位住在这儿的宿主留下的那一份（就地升级只换主 exe，这一份会留在原地）。
        std::fs::write(&target, b"hand-placed").expect("摆一份");
        let bytes = vec![0x22u8; 4096];
        let payload = pack(&bytes);

        let resolved = ensure(&target, &sandbox.path().join("data"), Some(&payload));

        assert_ne!(
            resolved, target,
            "同级目录里那一份是上一版的字节，认它就等于每一页都拒一次，重试也只重起它"
        );
        assert_eq!(std::fs::read(&resolved).expect("读回来"), bytes, "要跑的是这一份载荷");
        assert_eq!(
            std::fs::read(&target).expect("读回来"),
            b"hand-placed",
            "别人的文件不许动（它是用户的，不是我们的缓存）"
        );
    }

    #[test]
    fn a_host_without_a_payload_still_reports_the_plain_path() {
        let sandbox = tempfile::tempdir().expect("临时目录");
        let target = sandbox.path().join("yomika-compute-worker.exe");

        // 开发机构建：没嵌载荷。这一条路必须与旧行为一字不差——`maybe_spawn` 会照旧
        // 说「找不到 worker 可执行文件：<这个路径>」；而同时摆着的那一份要照旧被认。
        assert_eq!(ensure(&target, &sandbox.path().join("data"), None), target);
        assert!(!target.exists());
        std::fs::write(&target, b"hand-placed").expect("摆一份");
        assert_eq!(
            ensure(&target, &sandbox.path().join("data"), None),
            target,
            "没有载荷时才认同级目录里那一份：开发机构建、绿色目录都靠它"
        );
    }

    #[test]
    fn older_extractions_are_forgotten_once_the_new_one_is_down() {
        let sandbox = tempfile::tempdir().expect("临时目录");
        let target = sandbox.path().join("yomika-compute-worker.exe");
        let stale = sandbox.path().join("yomika-compute-worker-0000000000000000.exe");
        let stranger = sandbox.path().join("yomika-compute-worker-next.exe");
        std::fs::write(&stale, b"old").expect("摆一份旧的");
        std::fs::write(&stranger, b"not ours").expect("摆一份不像我们落的");

        let resolved = ensure(
            &target,
            &sandbox.path().join("data"),
            Some(&pack(&vec![0x33u8; 4096])),
        );

        assert!(!stale.exists(), "上一代那一份该被收走（24 MB 一份，升级几次就是几百兆）");
        assert!(stranger.exists(), "名字不像我们落的文件不许碰");
        assert!(resolved.is_file());
    }

    /// 名字里带的是这一代的摘要，可字节已经被换成了**等长**的别的东西（磁盘坏块、上一代
    /// 进程写坏、杀毒软件改过）。只比长度的话这里会把它当成完好的缓存原样交出去——握手
    /// 于是每一页都拒一次，而「重试」只重起同一份坏文件，永远好不了。
    #[test]
    fn a_same_length_corrupted_extraction_is_repaired_from_the_payload() {
        let sandbox = tempfile::tempdir().expect("临时目录");
        let bytes = vec![0x5au8; 21];
        let payload = pack(&bytes);
        let target = sandbox.path().join("yomika-compute-worker.exe");

        let first = ensure(&target, &sandbox.path().join("data"), Some(&payload));
        assert_eq!(std::fs::read(&first).expect("读回来"), bytes, "首次提取的是载荷里那一条");

        std::fs::write(&first, vec![b'X'; bytes.len()]).expect("等长覆盖");
        let second = ensure(&target, &sandbox.path().join("data"), Some(&payload));

        assert_eq!(
            std::fs::read(&second).expect("读回来"),
            bytes,
            "等长损坏的副本必须用载荷重铺，不能原样交出去"
        );
        assert_eq!(first, second, "重铺还是同一个受控名字：随身载荷在哪一代，落地名就在哪一代");
    }

    /// 截断的副本（`.part` 之外的一种：写了一半就被打断）与「首选目录写不进去、只能落到
    /// 数据目录」这两种现场也要能好——后者的那一份同样是等长损坏的。
    #[test]
    fn a_truncated_copy_and_a_read_only_preferred_directory_are_recovered() {
        let sandbox = tempfile::tempdir().expect("临时目录");
        let bytes = vec![0x44u8; 4096];
        let payload = pack(&bytes);

        // ① 截断：长度对不上。
        let target = sandbox.path().join("yomika-compute-worker.exe");
        let first = ensure(&target, &sandbox.path().join("data"), Some(&payload));
        std::fs::write(&first, &bytes[..7]).expect("截断");
        let repaired = ensure(&target, &sandbox.path().join("data"), Some(&payload));
        assert_eq!(std::fs::read(&repaired).expect("读回来"), bytes, "截断的副本要重铺");

        // ② 首选目录写不进去（装到 `Program Files` 下是同一个形状）：落点退到数据目录，
        //    那一份等长损坏之后仍然要在数据目录里就地重铺。
        let blocked = sandbox.path().join("read-only");
        std::fs::write(&blocked, b"not a directory").expect("摆一个挡路的文件");
        let beside = blocked.join("yomika-compute-worker.exe");
        let fallback = sandbox.path().join("data");
        let resolved = ensure(&beside, &fallback, Some(&payload));
        assert_eq!(resolved.parent(), Some(fallback.as_path()));
        std::fs::write(&resolved, vec![b'Y'; bytes.len()]).expect("等长覆盖");
        let repaired = ensure(&beside, &fallback, Some(&payload));
        assert_eq!(
            std::fs::read(&repaired).expect("读回来"),
            bytes,
            "首选目录只读时，也要在还能写的那一处把损坏的缓存铺好"
        );
    }

    /// 「进程占用」那一种现场：这一代的缓存已经有了、还是**等长损坏**的，而它正被一个
    /// 进程独占打开（正在跑的那一份 worker 就是这种形状）。首选目录里既改不了也删不掉，
    /// 那就退到还能写的那一处铺一份好的——而不是把坏的那份原样交回去，让握手反复拒、
    /// 「重试」反复重起同一份坏文件。
    #[cfg(windows)]
    #[test]
    fn a_corrupted_extraction_held_open_by_a_process_is_replaced_elsewhere() {
        use std::os::windows::fs::OpenOptionsExt;
        let sandbox = tempfile::tempdir().expect("临时目录");
        let bytes = vec![0x66u8; 4096];
        let payload = pack(&bytes);
        let target = sandbox.path().join("yomika-compute-worker.exe");
        let fallback = sandbox.path().join("data");

        let first = ensure(&target, &fallback, Some(&payload));
        std::fs::write(&first, vec![b'Z'; bytes.len()]).expect("等长覆盖");
        // share_mode(0)：谁都别想改它、删它、顶替它——Windows 上的「占用」就是这一档。
        let held = std::fs::OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(&first)
            .expect("独占打开这一份");

        let resolved = ensure(&target, &fallback, Some(&payload));

        assert_eq!(
            resolved.parent(),
            Some(fallback.as_path()),
            "首选目录里那一份被占着换不了，就该落到还能写的那一处"
        );
        assert_eq!(
            std::fs::read(&resolved).expect("读回来"),
            bytes,
            "换不过去也要有一份好的可跑"
        );
        drop(held);
        assert_eq!(
            std::fs::read(&first).expect("读回来"),
            vec![b'Z'; bytes.len()],
            "被占着的那一份不许动（改不动是事实，但不是我们把它删了）"
        );
    }

    /// 「两个实例竞争提取」：两个宿主同时把同一代缓存铺到同一个目录里（另一条进程、
    /// 或者同一台机器上开了两个实例）。落盘是「先 `.part` 再 rename」，所以谁先谁后
    /// 都不该让哪一边读到半截；这一条钉的是「竞争下的可见性」，不是摘要修复本身。
    #[test]
    fn two_instances_racing_to_extract_both_get_the_whole_worker() {
        let sandbox = tempfile::tempdir().expect("临时目录");
        let bytes = vec![0x5au8; 64 * 1024];
        let payload = pack(&bytes);
        let target = sandbox.path().join("yomika-compute-worker.exe");
        let fallback = sandbox.path().join("data");
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
        let handles: Vec<_> = (0..2)
            .map(|_| {
                let target = target.clone();
                let fallback = fallback.clone();
                let payload = payload.clone();
                let barrier = std::sync::Arc::clone(&barrier);
                std::thread::spawn(move || {
                    barrier.wait();
                    let resolved = ensure(&target, &fallback, Some(&payload));
                    std::fs::read(&resolved).expect("读回来")
                })
            })
            .collect();
        for handle in handles {
            let landed = handle.join().expect("线程");
            assert_eq!(landed, bytes, "竞争提取时每一边都必须拿到完整的 worker");
        }
    }
}
