//! 标签补全排序数据（docs/30）：E-Hentai 标签的全站使用频次。
//!
//! 为什么下载放在 Rust 里：数据源是 GitHub release 资产，而它的终点
//! `release-assets.githubusercontent.com` **不发** `Access-Control-Allow-Origin`
//! ——真浏览器实测 `TypeError: Failed to fetch`（`debug_outputs/tagcount/cors-probe.mjs`
//! 的读数；同一份探针里 `api.github.com` 是 `type: cors` 的 200）。前端 fetch 无论
//! 怎么改 CSP 白名单都读不到这份数据，只有绕开 CORS 的本地 HTTP 客户端能拿。
//! 顺带的好处：`connect-src` 不需要为它开任何外部 host。
//!
//! 这一层只负责「取字节、解压、变成 `key<TAB>count` 行」；「哪些条目参与排序」仍旧
//! 只有前端 `installTagCounts` 一处说了算（`TAG_COUNT_MIN_COUNT`）。

use crate::domain::result::CommandResult;
use std::io::Read;

/// 与 JHenTai 同一份数据源：`mokurin000/e-hentai-tag-count` 每天一个 release，
/// 资产 `tagname_count.csv.gz`（行格式 `namespace:key,count`，首行 `tag_name,len`）。
/// `releases/latest/download/...` 是免 API 的直达地址：一次请求、不占 GitHub API
/// 那 60 次/小时的未认证配额（旧写法先问 `api.github.com`，实测会 403）。
const TAG_COUNT_ASSET_URL: &str =
    "https://github.com/mokurin000/e-hentai-tag-count/releases/latest/download/tagname_count.csv.gz";

/// 与 eh.rs 同一件外衣：这一份数据与登录态无关，只用它让请求看起来像普通浏览器。
const TAG_COUNT_CLIENT_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

/// 前端要的东西：版本（用来判断要不要重新装表）与那张表本身。
#[derive(Debug, serde::Serialize)]
pub struct TagCountTable {
    /// 这次应答对应的数据版本：资产的 `Last-Modified`（每天一个 release，够用），
    /// 拿不到时退回 `ETag`。前端把它存下来，下次刷新时回传，同版本就不再下载正文。
    pub version: String,
    /// 版本与前端手里的那份一致、正文没下载时为 true；此时 `data` 是 `None`。
    pub unchanged: bool,
    /// `key<TAB>count` 按行拼成的整表（`namespace:key` 保留原样，前端按同一个键查）。
    /// 数据没变时为 `None`。
    pub data: Option<String>,
}

fn tag_count_client() -> Result<reqwest::Client, String> {
    static CLIENT: std::sync::OnceLock<Result<reqwest::Client, String>> = std::sync::OnceLock::new();
    CLIENT
        .get_or_init(|| {
            reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(120))
                .user_agent(TAG_COUNT_CLIENT_UA)
                .build()
                .map_err(|error| error.to_string())
        })
        .clone()
}

/// `Last-Modified` 优先，`ETag` 兜底，都没有就空串（空串永远不等于前端的旧版本，
/// 于是照常下载正文——宁可多下一次，也不要误判成「没变」）。
fn version_of(response: &reqwest::Response) -> String {
    let header = |name: reqwest::header::HeaderName| {
        response
            .headers()
            .get(&name)
            .and_then(|value| value.to_str().ok())
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
    };
    header(reqwest::header::LAST_MODIFIED)
        .or_else(|| header(reqwest::header::ETAG))
        .unwrap_or_default()
}

/// 能不能省掉正文：只有**两边都非空且相同**才算「没变」。前端手里的版本号可能为空
/// （清过 localStorage、或第一次装），响应也可能没给 `Last-Modified`（退回 `ETag`，
/// 再没有就是空串）——空串撞空串不能当成「没变」，否则表会静悄悄地空掉。
///
/// `since` 先剪空白：`Some("")` 与 `Some("   ")` 都不是一个版本号。
pub fn same_version(since: Option<&str>, version: &str) -> bool {
    !version.is_empty() && since.map(str::trim) == Some(version)
}

/// 解压并转成 `key<TAB>count` 行。表头、不含逗号的行、`count` 不是数字的行都丢掉；
/// 逗号取**最后**一个，与前端原来的解析口径一致。
pub fn decode_rows(bytes: &[u8]) -> Result<String, String> {
    let mut text = String::new();
    flate2::read::GzDecoder::new(bytes)
        .read_to_string(&mut text)
        .map_err(|error| format!("标签频次数据解压失败：{error}"))?;

    let tab = char::from_u32(9).expect("tab");
    let mut rows = String::with_capacity(text.len());
    for line in text.split('\n') {
        let line = line.trim_end_matches('\r');
        // 表头（`tag_name,len`）不单独认：它的 `count` 不是数字，和别的坏行走同一条闸门。
        let Some(comma) = line.rfind(',') else { continue };
        if comma == 0 {
            continue;
        }
        let key = line[..comma].replace('"', "");
        let key = key.trim();
        let count = line[comma + 1..].trim();
        if key.is_empty() || count.parse::<u32>().is_err() {
            continue;
        }
        // 与前端 `installTagCounts` 的序列化格式一致（它写 localStorage 用的就是这一份）。
        rows.push_str(key);
        rows.push(tab);
        rows.push_str(count);
        rows.push('\n');
    }
    if rows.is_empty() {
        return Err("标签频次数据是空的".to_string());
    }
    Ok(rows)
}

/// 这次取数为什么不成，以及它在 `src/domain/errors.ts` 那张闭集里叫什么码。
///
/// 那张表是闭集，桥接拿它校验**整条**错误信封：没登记过的码不是「原样透传」，而是整条
/// 被判成 `INVALID_RESPONSE`——真正的理由（网络、资产没发布、字节坏了）反而看不见。
#[derive(Debug)]
struct TagCountFailure {
    code: &'static str,
    message: String,
    retryable: bool,
}

impl TagCountFailure {
    /// 还没拿到可用的字节：建客户端、发请求、读正文失败，或者 HTTP 非 2xx。
    /// 过一会儿再试通常就好了，所以标成可重试。
    fn network(message: impl Into<String>) -> Self {
        Self { code: "NETWORK", message: message.into(), retryable: true }
    }

    /// 字节到手了、但这份内容不能用（不是 gzip、整表空）。同一份资产再下一遍还是这个
    /// 样子，标成可重试只会让设置页白转圈，所以不可重试。
    fn payload(message: impl Into<String>) -> Self {
        Self { code: "INVALID_RESPONSE", message: message.into(), retryable: false }
    }
}

/// 精解压、成表那一半。与网络无关，于是「坏字节给什么码」能离线测。
fn table_from_bytes(version: String, bytes: &[u8]) -> Result<TagCountTable, TagCountFailure> {
    let data = decode_rows(bytes).map_err(TagCountFailure::payload)?;
    Ok(TagCountTable { version, unchanged: false, data: Some(data) })
}

/// 取一份最新的标签频次表。`since` 是前端手里的版本（没有就传 `None`）：
/// 与本次应答的版本相同就只回报 `unchanged`，正文一个字节都不读。
///
/// 应答**必须**走 `CommandResult` 这层信封。`src/bridge/invoke.ts` 先按
/// `{ ok: true, value }` / `{ ok: false, error }` 判一次，之后才轮到值 schema；裸
/// `Result` 成功时序列化成 `{"version":…}`、失败时序列化成一个**字符串**，两种都不像
/// 信封，于是**每一次**调用都在桥里落成
/// `bridge/fetch_tag_counts  Native command returned an invalid response`
/// （用户 2026-10-12 的 `data/error.log` 就是这个形状：`{"request":{"since":null}}`，
/// 连第一次刷新都失败，标签补全排序因此一条频次都拿不到）。
#[tauri::command]
pub async fn fetch_tag_counts(since: Option<String>) -> CommandResult<TagCountTable> {
    match load_tag_counts(since).await {
        Ok(table) => CommandResult::success(table),
        Err(failure) => CommandResult::failure(failure.code, failure.message, failure.retryable),
    }
}

async fn load_tag_counts(since: Option<String>) -> Result<TagCountTable, TagCountFailure> {
    let response = tag_count_client()
        .map_err(TagCountFailure::network)?
        .get(TAG_COUNT_ASSET_URL)
        .send()
        .await
        .map_err(|error| TagCountFailure::network(format!("标签频次数据下载失败：{error}")))?;
    let status = response.status();
    if !status.is_success() {
        return Err(TagCountFailure::network(format!(
            "标签频次数据下载失败：HTTP {}",
            status.as_u16()
        )));
    }

    let version = version_of(&response);
    if same_version(since.as_deref(), &version) {
        return Ok(TagCountTable { version, unchanged: true, data: None });
    }

    let bytes = response
        .bytes()
        .await
        .map_err(|error| TagCountFailure::network(format!("标签频次数据读取失败：{error}")))?;
    table_from_bytes(version, &bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn gzip(text: &str) -> Vec<u8> {
        let mut encoder =
            flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        encoder.write_all(text.as_bytes()).expect("write gzip");
        encoder.finish().expect("finish gzip")
    }

    #[test]
    fn turns_the_release_csv_into_the_line_format_the_frontend_installs() {
        // 取自真实资产的前几行（表头 + 普通行 + 大小写/空格照旧），再加三条必须被丢掉的坏行。
        let csv = "tag_name,len\n\
                   female:big breasts,1306417\n\
                   male:sole male,832841\n\
                   language:chinese,560954\n\
                   \n\
                   nonsense-without-comma\n\
                   ,1234\n\
                   female:broken,not-a-number\n";
        let rows = decode_rows(&gzip(csv)).expect("decode");
        assert_eq!(
            rows,
            "female:big breasts\t1306417\nmale:sole male\t832841\nlanguage:chinese\t560954\n",
            "表头要丢、坏行要丢、其余原样"
        );
    }

    #[test]
    fn keeps_the_last_comma_so_a_quoted_name_cannot_shift_the_count() {
        // 真实数据里没有引号，但解析口径与前端原实现一样取最后一个逗号：名字里有逗号
        // 也只是名字的一部分。
        let csv = "\"female:weird,name\",42\n";
        let rows = decode_rows(&gzip(csv)).expect("decode");
        assert_eq!(rows, "female:weird,name\t42\n");
    }

    #[test]
    fn a_body_without_any_usable_row_is_an_error_not_an_empty_table() {
        let error = decode_rows(&gzip("tag_name,len\n")).expect_err("empty table");
        assert!(error.contains("空的"), "{error}");
    }

    #[test]
    fn only_skips_the_body_when_both_sides_really_carry_the_same_version() {
        assert!(same_version(Some("Sat, 10 Oct 2026 16:54:00 GMT"), "Sat, 10 Oct 2026 16:54:00 GMT"));
        assert!(!same_version(Some("Sat, 10 Oct 2026 16:54:00 GMT"), "Sat, 11 Oct 2026 16:54:00 GMT"));
        // 空串撞空串：前端没版本、或响应没给版本，都得老老实实下正文。
        assert!(!same_version(Some(""), ""));
        assert!(!same_version(Some("   "), "Sat, 10 Oct 2026 16:54:00 GMT"));
        assert!(!same_version(Some("Sat, 10 Oct 2026 16:54:00 GMT"), ""));
        assert!(!same_version(None, "Sat, 10 Oct 2026 16:54:00 GMT"));
    }

    /// 这一条钉的是桥接那一层：应答必须是信封，而且三个字段名、`data` 的 null 写法都要与
    /// 前端 schema 对得上。夹具 `tests/fixtures/tagcount-envelope.json` 是两边共用的那一份：
    /// Rust 在这里断言「我序列化出来的就是它」，前端 `tests/lib/tag-count-table.test.ts`
    /// 拿同一个文件喂给真桥与真服务。裸 `Result` 的成功形状（`{"version":…}`）在同一份
    /// 夹具上会直接对不上——修前的缺陷就是这个形状。
    #[test]
    fn answers_in_the_bridge_envelope_the_frontend_reads() {
        let expected: serde_json::Value = serde_json::from_str(include_str!(
            "../../tests/fixtures/tagcount-envelope.json"
        ))
        .expect("fixture");

        let full = CommandResult::success(TagCountTable {
            version: "Sat, 10 Oct 2026 16:54:00 GMT".to_string(),
            unchanged: false,
            data: Some("female:big breasts\t1306417\nfemale:big ass\t332586\n".to_string()),
        });
        assert_eq!(serde_json::to_value(full).expect("serialize"), expected["full"], "带正文的成功应答");

        let unchanged = CommandResult::success(TagCountTable {
            version: "Sat, 10 Oct 2026 16:54:00 GMT".to_string(),
            unchanged: true,
            data: None,
        });
        assert_eq!(
            serde_json::to_value(unchanged).expect("serialize"),
            expected["unchanged"],
            "版本没变时 data 要是 null：前端 schema 写的是 nullish"
        );

        let failure: CommandResult<TagCountTable> =
            CommandResult::failure("NETWORK", "标签频次数据下载失败：HTTP 503", true);
        assert_eq!(
            serde_json::to_value(failure).expect("serialize"),
            expected["failure"],
            "失败要落在 error 信封里，而不是把理由塞进 value"
        );
    }

    #[test]
    fn a_body_that_cannot_become_a_table_is_an_invalid_response_not_a_retry() {
        let broken = table_from_bytes("v".to_string(), b"not gzip at all").expect_err("bad gzip");
        assert_eq!(broken.code, "INVALID_RESPONSE");
        assert!(!broken.retryable, "同一份资产再下一遍还是这个样子，别让设置页白转圈");

        let empty = table_from_bytes("v".to_string(), &gzip("tag_name,len\n")).expect_err("empty");
        assert_eq!(empty.code, "INVALID_RESPONSE");

        let table = table_from_bytes(
            "v".to_string(),
            &gzip("tag_name,len\nfemale:big breasts,1306417\nbroken,not-a-number\n"),
        )
        .expect("table");
        assert_eq!(table.version, "v");
        assert!(!table.unchanged);
        assert_eq!(table.data.as_deref(), Some("female:big breasts\t1306417\n"));
    }

    /// 真数据核对（网络）：`cargo test --lib -- --ignored --nocapture tag_count`。
    /// 它证明的不是「函数能跑」，而是「实际拿到的那份库真的能喂进排序规则」——
    /// 行数、命名空间数、过了 `TAG_COUNT_MIN_COUNT` 的条目数都打出来。
    #[test]
    #[ignore = "需要网络：跑一次拿真实资产的行数与分布"]
    fn real_release_lands_enough_rows_to_order_by_frequency() {
        let bytes = reqwest::blocking::get(TAG_COUNT_ASSET_URL)
            .expect("download")
            .bytes()
            .expect("bytes");
        println!("REAL gz bytes={}", bytes.len());
        let rows = decode_rows(&bytes).expect("decode");
        let total = rows.lines().count();
        let kept = rows
            .lines()
            .filter(|line| {
                line.rsplit('\t')
                    .next()
                    .and_then(|count| count.parse::<u32>().ok())
                    .is_some_and(|count| count >= 5)
            })
            .count();
        let namespaces = rows
            .lines()
            .filter_map(|line| line.split(':').next())
            .collect::<std::collections::BTreeSet<_>>()
            .len();
        println!("REAL rows={total} kept_at_5={kept} namespaces={namespaces}");

        // 真实字节走完整条成形路径：落的还得是桥接那层信封（前端 schema 要的三个键都在）。
        let table = table_from_bytes("real".to_string(), &bytes).expect("table");
        let answer = serde_json::to_value(CommandResult::success(table)).expect("serialize");
        println!("REAL envelope={answer}");
        assert_eq!(answer["ok"], serde_json::Value::Bool(true));
        let value = answer.get("value").expect("value");
        for key in ["version", "unchanged", "data"] {
            assert!(value.get(key).is_some(), "信封里缺 {key}");
        }

        assert!(total > 100_000, "真实资产的行数不该这么少：{total}");
        assert!(kept > 50_000, "过了频次门槛的条目太少：{kept}");
        assert!(namespaces > 5, "命名空间太少：{namespaces}");
    }
}
