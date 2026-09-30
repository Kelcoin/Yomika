//! 本体（应用自己）有没有新版本。
//!
//! 这件事只能由原生侧去问：CSP 的 `connect-src` 里没有 api.github.com，网页那边
//! 根本发不出这个请求。GitHub 的 REST 接口还要求请求带 `User-Agent`，缺了会被 403
//! 挡掉，所以这里自己建一个带 UA 与超时的 client，而不是像 `model_release.rs` 里那样
//! 直接用 `reqwest::blocking::get`（那几处打的是 raw.githubusercontent.com，不查 UA）。
//!
//! 判断「有没有新版本」只在版本号的数字段上做：`v1.2.3` 与 `1.2.3` 是同一版，
//! `1.10.0` 比 `1.9.0` 新（按字符串比会得到相反答案）。标签解析不出来时一律当作
//! 「没有新版本」——宁可漏报，也不要在启动时蹦一个错的弹窗。

use std::time::Duration;

use crate::domain::result::CommandResult;

/// 产品仓库。`package.json` 的 `repository` 说的是同一件事，Rust 侧只在这里用。
const APP_REPOSITORY: &str = "Kelcoin/Yomika";
/// GitHub 对没有 `User-Agent` 的请求回 403；顺带用它说明这是谁在问。
const USER_AGENT: &str = concat!("Yomika/", env!("CARGO_PKG_VERSION"));
/// 查最新发布等不了太久：启动时的一次网络请求，失败了也不该拖着界面。
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);

/// `releases/latest` 只回最新一次正式发布：草稿与预发布都不算。
fn latest_api_url() -> String {
    format!("https://api.github.com/repos/{APP_REPOSITORY}/releases/latest")
}

/// 兜底用的 release 页地址——它永远存在，而负载里的 `html_url` 不一定。
fn releases_page_url() -> String {
    format!("https://github.com/{APP_REPOSITORY}/releases/latest")
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppRelease {
    /// 这份二进制自己的版本，来自 `Cargo.toml`（`app_build_info` 报的是同一个值）。
    pub current: String,
    /// 最新一次正式发布的版本号，已去掉标签的 `v` 前缀。
    pub latest: String,
    pub update_available: bool,
    /// 「前往下载」要打开的地址。
    pub page_url: String,
    pub published_at: Option<String>,
}

/// `v1.2.3` → `1.2.3`；`1.2.3` 原样返回。
fn normalize_version(tag: &str) -> String {
    tag.trim().trim_start_matches(['v', 'V']).trim().to_string()
}

/// 版本号拆成（数字段, 有没有预发布后缀）。`1.2.3-beta.1` → (`[1,2,3]`, true)。
///
/// 任何一段找不到数字就当作不是版本号（返回 `None`）：`latest`、`nightly` 这类标签
/// 不该被拿去比较。
fn version_parts(version: &str) -> Option<(Vec<u64>, bool)> {
    let (core, suffix) = match version.split_once('-') {
        Some((core, suffix)) => (core, !suffix.is_empty()),
        None => (version, false),
    };
    let mut parts = Vec::new();
    for piece in core.split('.') {
        let digits: String = piece.chars().take_while(char::is_ascii_digit).collect();
        if digits.is_empty() {
            return None;
        }
        parts.push(digits.parse::<u64>().ok()?);
    }
    if parts.is_empty() {
        return None;
    }
    Some((parts, suffix))
}

/// `candidate` 是否比 `current` 新。比较不出来（任一侧不是版本号）就是 false。
fn is_newer(candidate: &str, current: &str) -> bool {
    let (Some((mut next, next_pre)), Some((mut now, now_pre))) =
        (version_parts(candidate), version_parts(current))
    else {
        return false;
    };
    let width = next.len().max(now.len());
    next.resize(width, 0);
    now.resize(width, 0);
    match next.cmp(&now) {
        std::cmp::Ordering::Greater => true,
        std::cmp::Ordering::Less => false,
        // 数字一样时，正式发布比它自己的预发布新。
        std::cmp::Ordering::Equal => now_pre && !next_pre,
    }
}

/// 从 `releases/latest` 的负载里取出我们要的两三件事。
fn parse_release(current: &str, payload: &serde_json::Value) -> Result<AppRelease, String> {
    let tag = payload
        .get("tag_name")
        .and_then(|value| value.as_str())
        .unwrap_or_default();
    let latest = normalize_version(tag);
    if latest.is_empty() {
        return Err("Release 里没有版本号".into());
    }
    let page_url = payload
        .get("html_url")
        .and_then(|value| value.as_str())
        .filter(|url| url.starts_with("http"))
        .map(str::to_string)
        .unwrap_or_else(releases_page_url);
    Ok(AppRelease {
        current: current.to_string(),
        update_available: is_newer(&latest, current),
        latest,
        page_url,
        published_at: payload
            .get("published_at")
            .and_then(|value| value.as_str())
            .filter(|value| !value.is_empty())
            .map(str::to_string),
    })
}

/// 问一次 GitHub：有没有比这份二进制更新的正式发布。
///
/// 失败一律回 `retryable`：离线、限流、GitHub 抽风都会走到这里，而前端只在成功且
/// 真有新版本时才弹窗，所以这类失败只是「这次没查到」。
#[tauri::command(async)]
pub fn app_release_latest() -> CommandResult<AppRelease> {
    let current = env!("CARGO_PKG_VERSION");
    let client = match reqwest::blocking::Client::builder()
        .user_agent(USER_AGENT)
        .timeout(REQUEST_TIMEOUT)
        .build()
    {
        Ok(client) => client,
        Err(error) => {
            return CommandResult::failure(
                "APP_RELEASE_CHECK_FAILED",
                format!("无法建立 HTTP 客户端：{error}"),
                true,
            )
        }
    };
    let payload = client
        .get(latest_api_url())
        .header("Accept", "application/vnd.github+json")
        .send()
        .and_then(|response| response.error_for_status())
        .and_then(|response| response.json::<serde_json::Value>());
    match payload {
        Ok(payload) => match parse_release(current, &payload) {
            Ok(release) => CommandResult::success(release),
            Err(error) => CommandResult::failure("APP_RELEASE_CHECK_FAILED", error, true),
        },
        Err(error) => CommandResult::failure(
            "APP_RELEASE_UNREACHABLE",
            format!("查不到最新版本：{error}"),
            true,
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_a_leading_v_from_a_tag() {
        assert_eq!(normalize_version("v1.2.3"), "1.2.3");
        assert_eq!(normalize_version(" V1.2.3 "), "1.2.3");
        assert_eq!(normalize_version("1.2.3"), "1.2.3");
    }

    #[test]
    fn compares_versions_numerically_rather_than_as_text() {
        assert!(is_newer("1.10.0", "1.9.0"));
        assert!(!is_newer("1.9.0", "1.10.0"));
        assert!(!is_newer("1.0.0", "1.0.0"));
        // 段数与段宽都可能不一样：缺的段当 0。
        assert!(is_newer("2", "1.9.9"));
        assert!(is_newer("1.0.1", "1.0"));
        assert!(!is_newer("1.0", "1.0.0"));
    }

    #[test]
    fn treats_a_prerelease_as_older_than_its_own_release() {
        assert!(!is_newer("1.1.0-beta.1", "1.1.0"));
        assert!(is_newer("1.1.0", "1.1.0-beta.1"));
        // 但预发布仍然比它下面那个正式版新。
        assert!(is_newer("1.1.0-beta.2", "1.0.9"));
    }

    #[test]
    fn refuses_to_guess_when_the_tag_is_not_a_version() {
        assert!(!is_newer("latest", "1.0.0"));
        assert!(!is_newer("", "1.0.0"));
        assert!(!is_newer("nightly", "nightly"));
    }

    #[test]
    fn reads_the_latest_release_payload() {
        let payload = serde_json::json!({
            "tag_name": "v1.2.0",
            "html_url": "https://github.com/Kelcoin/Yomika/releases/tag/v1.2.0",
            "published_at": "2026-10-01T09:00:00Z",
        });
        assert_eq!(
            parse_release("1.0.0", &payload).expect("payload"),
            AppRelease {
                current: "1.0.0".into(),
                latest: "1.2.0".into(),
                update_available: true,
                page_url: "https://github.com/Kelcoin/Yomika/releases/tag/v1.2.0".into(),
                published_at: Some("2026-10-01T09:00:00Z".into()),
            }
        );
    }

    #[test]
    fn falls_back_to_the_releases_page_without_a_usable_url() {
        let payload = serde_json::json!({ "tag_name": "v1.2.0", "html_url": "not-a-url" });
        let release = parse_release("1.0.0", &payload).expect("payload");
        assert_eq!(release.page_url, releases_page_url());
        assert_eq!(release.published_at, None);
        assert_eq!(release.latest, "1.2.0");
    }

    #[test]
    fn reports_no_update_when_the_published_tag_is_not_newer() {
        let payload = serde_json::json!({ "tag_name": "v1.0.0" });
        assert!(!parse_release("1.0.0", &payload).expect("payload").update_available);
    }

    #[test]
    fn fails_when_the_payload_has_no_tag() {
        assert!(parse_release("1.0.0", &serde_json::json!({ "name": "Yomika" })).is_err());
    }

    /// 仓库 slug 只有一处，两个地址都必须由它拼出来。
    #[test]
    fn points_at_the_product_repository() {
        assert_eq!(
            latest_api_url(),
            "https://api.github.com/repos/Kelcoin/Yomika/releases/latest"
        );
        assert_eq!(releases_page_url(), "https://github.com/Kelcoin/Yomika/releases/latest");
    }
}
