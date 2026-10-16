//! S3 兼容对象存储（Cloudflare R2、MinIO、Backblaze B2 的 S3 端点…）。
//!
//! 同步只需要「读一份文档、条件写回、删掉它」三件事，所以这里不引 SDK：AWS
//! Signature Version 4 手写，只覆盖我们用到的 GET/PUT/DELETE 与几个必需请求头。
//! 签名实现对的是 AWS 官方测试向量（见本文件测试：`aws-sig-v4-test-suite`）。
use std::time::{SystemTime, UNIX_EPOCH};

use reqwest::{Client, Method, StatusCode};
use sha2::{Digest, Sha256};
use url::Url;

use super::remote::{RemoteError, RemoteState};

/// R2 的 region 固定是 `auto`；其它 S3 兼容服务按各自的值填。
pub const DEFAULT_REGION: &str = "auto";
const SERVICE: &str = "s3";
const ALGORITHM: &str = "AWS4-HMAC-SHA256";

pub struct S3Client {
    endpoint: Url,
    bucket: String,
    access_key: String,
    secret: String,
    region: String,
    client: Client,
    /// 固定的签名时刻：只有测试会用，真实请求取系统时间。
    #[cfg(test)]
    fixed_clock: Option<SystemTime>,
}

impl S3Client {
    pub fn new(
        endpoint: &str,
        bucket: &str,
        access_key: &str,
        secret: &str,
        region: &str,
    ) -> Result<Self, RemoteError> {
        let parsed = Url::parse(endpoint).map_err(|error| RemoteError::InvalidUrl(error.to_string()))?;
        if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
            return Err(RemoteError::Request(format!(
                "Object storage endpoint must be an http(s) URL: {endpoint}"
            )));
        }
        Ok(Self {
            endpoint: parsed,
            bucket: bucket.trim_matches('/').to_string(),
            access_key: access_key.to_string(),
            secret: secret.to_string(),
            region: if region.trim().is_empty() { DEFAULT_REGION.to_string() } else { region.to_string() },
            client: Client::builder()
                .timeout(std::time::Duration::from_secs(60))
                .build()
                .map_err(|error| RemoteError::Request(error.to_string()))?,
            #[cfg(test)]
            fixed_clock: None,
        })
    }

    /// 账户在这个桶里的对象键。和 WebDAV 那边同一条路径形状，换后端不用迁移数据思路。
    fn state_key(account_id: &str) -> String {
        format!("Yomika/{account_id}.json.enc")
    }

    /// 桶根（探测用）：HeadBucket 打的就是它。
    fn bucket_url(&self) -> Result<Url, RemoteError> {
        let mut url = self.endpoint.clone();
        let base = url.path().trim_end_matches('/').to_string();
        url.set_path(&format!("{base}/{}", self.bucket));
        Ok(url)
    }

    fn object_url(&self, account_id: &str) -> Result<Url, RemoteError> {
        let mut url = self.endpoint.clone();
        let base = url.path().trim_end_matches('/').to_string();
        url.set_path(&format!("{base}/{}/{}", self.bucket, Self::state_key(account_id)));
        Ok(url)
    }

    fn clock(&self) -> SystemTime {
        #[cfg(test)]
        if let Some(fixed) = self.fixed_clock {
            return fixed;
        }
        SystemTime::now()
    }

    async fn send(
        &self,
        method: Method,
        url: Url,
        query: &str,
        body: Option<&[u8]>,
        extra: &[(&str, String)],
    ) -> Result<reqwest::Response, RemoteError> {
        let payload_hash = hex(&Sha256::digest(body.unwrap_or(&[])));
        // 参与签名的头：host 与 x-amz-* 必需，条件写的两个头也要签，否则中间人可以改。
        let host = match url.port() {
            Some(port) if !url.port_or_known_default().is_some_and(|default| default == port) => {
                format!("{}:{port}", url.host_str().unwrap_or_default())
            }
            _ => url.host_str().unwrap_or_default().to_string(),
        };
        let now = self.clock();
        let (amz_date, date) = amz_timestamps(now);
        let mut headers: Vec<(String, String)> = vec![
            ("host".to_string(), host),
            ("x-amz-content-sha256".to_string(), payload_hash.clone()),
            ("x-amz-date".to_string(), amz_date.clone()),
        ];
        for (name, value) in extra {
            headers.push((name.to_ascii_lowercase(), value.clone()));
        }
        headers.sort_by(|left, right| left.0.cmp(&right.0));

        let canonical_headers = headers
            .iter()
            .map(|(name, value)| format!("{name}:{}\n", value.trim()))
            .collect::<String>();
        let signed_headers = headers
            .iter()
            .map(|(name, _)| name.as_str())
            .collect::<Vec<_>>()
            .join(";");
        let (path, query) = split_path_query(&url, query);
        let canonical_request = format!(
            "{method}\n{path}\n{query}\n{canonical_headers}\n{signed_headers}\n{payload_hash}"
        );
        let scope = format!("{date}/{}/{SERVICE}/aws4_request", self.region);
        let string_to_sign = format!(
            "{ALGORITHM}\n{amz_date}\n{scope}\n{}",
            hex(&Sha256::digest(canonical_request.as_bytes()))
        );
        let signature = hex(&hmac_sha256(
            &signing_key(&self.secret, &date, &self.region, SERVICE),
            string_to_sign.as_bytes(),
        ));
        let authorization = format!(
            "{ALGORITHM} Credential={}/{scope}, SignedHeaders={signed_headers}, Signature={signature}",
            self.access_key
        );

        let mut request = self
            .client
            .request(method, url)
            .header("x-amz-content-sha256", payload_hash)
            .header("x-amz-date", amz_date)
            .header("authorization", authorization);
        for (name, value) in extra {
            request = request.header(*name, value);
        }
        if let Some(bytes) = body {
            request = request.body(bytes.to_vec());
        }
        request
            .send()
            .await
            .map_err(|error| RemoteError::Request(error.to_string()))
    }

    /// 「测试」按钮用：HeadBucket。200＝端点、桶、密钥三者都对；403＝密钥没权限或
    /// 写错了；404＝桶不存在（多半是名字拼错或不是这个账号下的桶）。
    pub async fn probe(&self) -> Result<(), RemoteError> {
        let response = self
            .send(Method::HEAD, self.bucket_url()?, "", None, &[])
            .await?;
        let status = response.status();
        if status.is_success() {
            return Ok(());
        }
        if status == StatusCode::NOT_FOUND {
            return Err(RemoteError::Request(format!(
                "存储桶不存在：确认桶名「{}」与端点属于同一个账号",
                self.bucket
            )));
        }
        Err(RemoteError::Http(status))
    }

    pub async fn get_state(&self, account_id: &str) -> Result<Option<RemoteState>, RemoteError> {
        let response = self.send(Method::GET, self.object_url(account_id)?, "", None, &[]).await?;
        if response.status() == StatusCode::NOT_FOUND {
            return Ok(None);
        }
        if !response.status().is_success() {
            return Err(RemoteError::Http(response.status()));
        }
        let etag = response
            .headers()
            .get(reqwest::header::ETAG)
            .and_then(|value| value.to_str().ok())
            .map(str::to_string);
        let ciphertext = response
            .bytes()
            .await
            .map_err(|error| RemoteError::Request(error.to_string()))?
            .to_vec();
        Ok(Some(RemoteState { ciphertext, etag }))
    }

    /// 条件写：有 ETag 就必须匹配，没有就只能「仅当不存在时创建」。
    /// R2 与 S3 都支持这两个条件头，返回 412 表示别人先写了一版。
    pub async fn put_state(
        &self,
        account_id: &str,
        bytes: &[u8],
        etag: Option<&str>,
    ) -> Result<(), RemoteError> {
        let conditional = match etag {
            Some(etag) => ("If-Match", etag.to_string()),
            None => ("If-None-Match", "*".to_string()),
        };
        let response = self
            .send(Method::PUT, self.object_url(account_id)?, "", Some(bytes), &[conditional])
            .await?;
        if response.status() == StatusCode::PRECONDITION_FAILED {
            return Err(RemoteError::StateConflict);
        }
        if !response.status().is_success() {
            return Err(RemoteError::Http(response.status()));
        }
        Ok(())
    }

    pub async fn update_state_with_retry<F>(
        &self,
        account_id: &str,
        mut ciphertext: Vec<u8>,
        mut etag: Option<String>,
        merge: F,
    ) -> Result<Vec<u8>, RemoteError>
    where
        F: Fn(&[u8]) -> Result<Vec<u8>, RemoteError>,
    {
        for attempt in 0..3 {
            match self.put_state(account_id, &ciphertext, etag.as_deref()).await {
                // 与 WebDAV 同一条规矩：交回真正写上去的那一份，调用方才不会拿冲突
                // 之前的那一版去应用本地（远端已经有别的设备的对象了）。
                Ok(()) => return Ok(ciphertext),
                Err(RemoteError::StateConflict) if attempt < 2 => {
                    let remote = self.get_state(account_id).await?;
                    match remote {
                        Some(remote) => {
                            ciphertext = merge(&remote.ciphertext)?;
                            etag = remote.etag;
                        }
                        None => etag = None,
                    }
                }
                Err(error) => return Err(error),
            }
        }
        Err(RemoteError::StateConflict)
    }

    pub async fn delete_state(&self, account_id: &str) -> Result<(), RemoteError> {
        let response = self.send(Method::DELETE, self.object_url(account_id)?, "", None, &[]).await?;
        if response.status().is_success() || response.status() == StatusCode::NOT_FOUND {
            Ok(())
        } else {
            Err(RemoteError::Http(response.status()))
        }
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// Canonical URI 与 query。路径按 RFC 3986 逐段编码（`/` 保留），查询串按参数名排序。
fn split_path_query(url: &Url, query: &str) -> (String, String) {
    let path = if url.path().is_empty() { "/" } else { url.path() };
    let encoded_path = path
        .split('/')
        .map(|segment| uri_encode(segment, true))
        .collect::<Vec<_>>()
        .join("/");
    let mut pairs = query
        .split('&')
        .filter(|pair| !pair.is_empty())
        .map(|pair| match pair.split_once('=') {
            Some((key, value)) => (key.to_string(), value.to_string()),
            None => (pair.to_string(), String::new()),
        })
        .collect::<Vec<_>>();
    // 按编码后的参数名排序：AWS 的规则是「按名字的字节序」，键要先编码。
    pairs.sort_by(|left, right| {
        uri_encode(&left.0, true)
            .cmp(&uri_encode(&right.0, true))
            .then_with(|| uri_encode(&left.1, true).cmp(&uri_encode(&right.1, true)))
    });
    let canonical_query = pairs
        .iter()
        .map(|(key, value)| format!("{}={}", uri_encode(key, true), uri_encode(value, true)))
        .collect::<Vec<_>>()
        .join("&");
    (encoded_path, canonical_query)
}

/// AWS 的 URI 编码：非保留字符原样，其余按 `%XX` 大写十六进制。
fn uri_encode(value: &str, encode_slash: bool) -> String {
    let mut encoded = String::with_capacity(value.len());
    for byte in value.as_bytes() {
        let unreserved = byte.is_ascii_alphanumeric() || matches!(*byte, b'-' | b'_' | b'.' | b'~');
        if unreserved || (*byte == b'/' && !encode_slash) {
            encoded.push(*byte as char);
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    encoded
}

/// `(20150830T123600Z, 20150830)`：SigV4 要的两副时间戳，都是 UTC。
fn amz_timestamps(now: SystemTime) -> (String, String) {
    let seconds = now
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or(0);
    let (year, month, day) = civil_from_days(seconds.div_euclid(86_400));
    let remainder = seconds.rem_euclid(86_400);
    let (hour, minute, second) = (remainder / 3600, (remainder % 3600) / 60, remainder % 60);
    let date = format!("{year:04}{month:02}{day:02}");
    (format!("{date}T{hour:02}{minute:02}{second:02}Z"), date)
}

/// Howard Hinnant 的 `civil_from_days`：把 1970-01-01 起的天数换成公历日期。
fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let day_of_era = z - era * 146_097;
    let year_of_era = (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_prime = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_prime + 2) / 5 + 1;
    let month = if month_prime < 10 { month_prime + 3 } else { month_prime - 9 };
    (year + i64::from(month <= 2), month, day)
}

fn hmac_sha256(key: &[u8], data: &[u8]) -> [u8; 32] {
    const BLOCK: usize = 64;
    let mut key_block = [0_u8; BLOCK];
    if key.len() > BLOCK {
        key_block[..32].copy_from_slice(&Sha256::digest(key));
    } else {
        key_block[..key.len()].copy_from_slice(key);
    }
    let mut inner = Vec::with_capacity(BLOCK + data.len());
    let mut outer = Vec::with_capacity(BLOCK + 32);
    for byte in key_block {
        inner.push(byte ^ 0x36);
        outer.push(byte ^ 0x5c);
    }
    inner.extend_from_slice(data);
    let inner = Sha256::digest(&inner);
    outer.extend_from_slice(&inner);
    Sha256::digest(&outer).into()
}

fn signing_key(secret: &str, date: &str, region: &str, service: &str) -> [u8; 32] {
    let date_key = hmac_sha256(format!("AWS4{secret}").as_bytes(), date.as_bytes());
    let region_key = hmac_sha256(&date_key, region.as_bytes());
    let service_key = hmac_sha256(&region_key, service.as_bytes());
    hmac_sha256(&service_key, b"aws4_request")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 官方向量：`aws-sig-v4-test-suite` 的 AKIDEXAMPLE 一组，
    /// 密钥 wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY，2015-08-30T12:36:00Z。
    const SUITE_KEY: &str = "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY";

    fn suite_clock() -> SystemTime {
        UNIX_EPOCH + std::time::Duration::from_secs(1_440_938_160)
    }

    fn signature_for(canonical_request: &str) -> String {
        let (amz_date, date) = amz_timestamps(suite_clock());
        assert_eq!(amz_date, "20150830T123600Z");
        let scope = format!("{date}/us-east-1/service/aws4_request");
        let string_to_sign = format!(
            "{ALGORITHM}\n{amz_date}\n{scope}\n{}",
            hex(&Sha256::digest(canonical_request.as_bytes()))
        );
        hex(&hmac_sha256(
            &signing_key(SUITE_KEY, &date, "us-east-1", "service"),
            string_to_sign.as_bytes(),
        ))
    }

    #[test]
    fn canonical_request_and_signature_match_the_aws_vectors() {
        // get-vanilla：空载荷、只有 host 与 x-amz-date。
        let (path, query) = split_path_query(&Url::parse("https://example.amazonaws.com/").expect("url"), "");
        let canonical = format!(
            "GET\n{path}\n{query}\nhost:example.amazonaws.com\nx-amz-date:20150830T123600Z\n\nhost;x-amz-date\n{}",
            hex(&Sha256::digest(b""))
        );
        assert_eq!(canonical, "GET\n/\n\nhost:example.amazonaws.com\nx-amz-date:20150830T123600Z\n\nhost;x-amz-date\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
        assert_eq!(
            signature_for(&canonical),
            "5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31"
        );

        // post-x-www-form-urlencoded：带载荷、多一个 content-type。
        let body = "Param1=value1";
        let canonical = format!(
            "POST\n/\n\ncontent-length:13\ncontent-type:application/x-www-form-urlencoded\nhost:example.amazonaws.com\nx-amz-date:20150830T123600Z\n\ncontent-length;content-type;host;x-amz-date\n{}",
            hex(&Sha256::digest(body.as_bytes()))
        );
        assert_eq!(
            signature_for(&canonical),
            "fec50118d90ecf934441dd37fb9a49bd7f5adb6450802ca3a0977623bbb7c27f"
        );

        // get-vanilla-query-order-key-case：查询串按参数名排序后参与签名。
        let (path, query) = split_path_query(
            &Url::parse("https://example.amazonaws.com/?Param2=value2&Param1=value1").expect("url"),
            "Param2=value2&Param1=value1",
        );
        let canonical = format!(
            "GET\n{path}\n{query}\nhost:example.amazonaws.com\nx-amz-date:20150830T123600Z\n\nhost;x-amz-date\n{}",
            hex(&Sha256::digest(b""))
        );
        assert_eq!(canonical, "GET\n/\nParam1=value1&Param2=value2\nhost:example.amazonaws.com\nx-amz-date:20150830T123600Z\n\nhost;x-amz-date\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
        assert_eq!(
            signature_for(&canonical),
            "b97d918cfa904a5beff61c982a1b6f458b799221646efd99d3219ec94cdf2500"
        );
    }

    #[test]
    fn hmac_matches_rfc_4231() {
        // RFC 4231 用例 2：key "Jefe"、data "what do ya want for nothing?"。
        assert_eq!(
            hex(&hmac_sha256(b"Jefe", b"what do ya want for nothing?")),
            "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"
        );
        // 密钥长于分组时先哈希：用例 6（131 字节的 0xaa）。
        assert_eq!(
            hex(&hmac_sha256(&[0xaa; 131], b"Test Using Larger Than Block-Size Key - Hash Key First")),
            "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54"
        );
    }

    #[test]
    fn timestamps_are_utc_swithout_a_date_library() {
        assert_eq!(
            amz_timestamps(UNIX_EPOCH + std::time::Duration::from_secs(1_440_938_160)),
            ("20150830T123600Z".to_string(), "20150830".to_string())
        );
        // 2026-02-17T04:24:56Z 与 2027-01-15T08:00:00Z：跨年、闰月边界之外的两点。
        assert_eq!(
            amz_timestamps(UNIX_EPOCH + std::time::Duration::from_secs(1_771_302_296)),
            ("20260217T042456Z".to_string(), "20260217".to_string())
        );
        assert_eq!(
            amz_timestamps(UNIX_EPOCH + std::time::Duration::from_secs(1_800_000_000)),
            ("20270115T080000Z".to_string(), "20270115".to_string())
        );
    }

    #[tokio::test]
    async fn probing_reports_bucket_missing_and_credentials_separately() {
        // 三种回答必须分得开：能连但桶名错、密钥没权限、一切正常。
        for (status, expect) in [
            ("200 OK", None),
            ("404 Not Found", Some("存储桶不存在")),
            ("403 Forbidden", Some("HTTP 403")),
        ] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("listener");
            let address = listener.local_addr().expect("address");
            let captured = std::sync::Arc::new(std::sync::Mutex::new(String::new()));
            let shared = std::sync::Arc::clone(&captured);
            let response_status = status.to_string();
            tokio::spawn(async move {
                let (mut stream, _) = listener.accept().await.expect("accept");
                let mut buffer = vec![0_u8; 8192];
                let read = tokio::io::AsyncReadExt::read(&mut stream, &mut buffer).await.expect("read");
                *shared.lock().expect("request") = String::from_utf8_lossy(&buffer[..read]).to_string();
                let response = format!("HTTP/1.1 {response_status}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
                tokio::io::AsyncWriteExt::write_all(&mut stream, response.as_bytes()).await.expect("write");
            });
            let client = S3Client::new(
                &format!("http://{address}"),
                "yomika",
                "ACCESSKEY",
                "secret",
                "",
            )
            .expect("client");
            let result = client.probe().await;
            match expect {
                None => result.expect("a reachable bucket probes clean"),
                Some(fragment) => {
                    let message = result.expect_err("probe should fail").to_string();
                    assert!(message.contains(fragment), "unexpected message: {message}");
                }
            }
            // 探测打的是桶根，不是对象键。
            assert!(captured.lock().expect("request").starts_with("HEAD /yomika "));
        }
    }

    #[test]
    fn object_keys_keep_the_shared_remote_shape() {
        let client = S3Client::new("https://account.r2.cloudflarestorage.com", "yomika", "AKIA", "secret", "")
            .expect("client");
        assert_eq!(client.region, "auto");
        assert_eq!(
            client.object_url("dav-1").expect("url").path(),
            "/yomika/Yomika/dav-1.json.enc"
        );
    }

    #[test]
    fn encoded_paths_survive_spaces_and_non_ascii() {
        assert_eq!(uri_encode("a b/c", true), "a%20b%2Fc");
        assert_eq!(uri_encode("Yomika/dav-1.json.enc", false), "Yomika/dav-1.json.enc");
        assert_eq!(uri_encode("中文", true), "%E4%B8%AD%E6%96%87");
    }
}
