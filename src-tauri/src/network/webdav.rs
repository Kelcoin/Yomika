#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    use super::*;

    async fn mock_server(statuses: Vec<&'static str>) -> (String, Arc<Mutex<Vec<String>>>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("listener");
        let address = listener.local_addr().expect("address");
        let requests = Arc::new(Mutex::new(Vec::new()));
        let captured = Arc::clone(&requests);
        tokio::spawn(async move {
            for status in statuses {
                let (mut stream, _) = listener.accept().await.expect("accept");
                let mut buffer = vec![0_u8; 8192];
                let read = stream.read(&mut buffer).await.expect("read");
                captured
                    .lock()
                    .expect("requests")
                    .push(String::from_utf8_lossy(&buffer[..read]).to_string());
                let body = if status.starts_with("200") {
                    b"ciphertext".as_slice()
                } else {
                    b"".as_slice()
                };
                let response = format!(
                    "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                stream
                    .write_all(response.as_bytes())
                    .await
                    .expect("response");
                stream.write_all(body).await.expect("body");
            }
        });
        (format!("http://{address}"), requests)
    }

    #[tokio::test]
    async fn probing_separates_missing_path_from_rejected_credentials() {
        // 207＝目录在、凭据可用；404＝路径不对；401＝凭据不对。三种说法要分开。
        let (base_url, requests) = mock_server(vec![
            "207 Multi-Status",
            "404 Not Found",
            "401 Unauthorized",
        ])
        .await;
        let client = WebdavClient::new(&format!("{base_url}/dav/Yomika"), "user", "password")
            .expect("client");
        client.probe().await.expect("a reachable collection probes clean");
        let first = requests.lock().expect("requests")[0].lines().next().unwrap_or_default().to_string();
        assert!(first.starts_with("PROPFIND /dav/Yomika"), "unexpected request line: {first}");

        let missing = client.probe().await.expect_err("404 is not healthy").to_string();
        assert!(missing.contains("地址不存在"), "unexpected message: {missing}");
        let rejected = client.probe().await.expect_err("401 is not healthy").to_string();
        assert!(rejected.contains("HTTP 401"), "unexpected message: {rejected}");
    }

    #[tokio::test]
    async fn writing_the_document_creates_the_root_collection_first() {
        // MKCOL Yomika, then the PUT. Anything that already exists answers 405.
        let (base_url, requests) = mock_server(vec!["405 Method Not Allowed", "201 Created"]).await;
        let client = WebdavClient::new(&base_url, "", "").expect("client");
        client
            .put_state("account-a", b"ciphertext", None)
            .await
            .expect("first state put");
        let requests = requests.lock().expect("requests");
        assert!(requests[0].starts_with("MKCOL /Yomika"));
        assert!(requests[1].starts_with("PUT /Yomika/account-a.json.enc"));
    }

    #[tokio::test]
    async fn configured_subpath_survives_every_request() {
        let (base_url, requests) = mock_server(vec!["404 Not Found"]).await;
        let client = WebdavClient::new(&format!("{base_url}/dav/Yomika"), "user", "password")
            .expect("client");
        client.get_state("account-a").await.expect("missing");
        assert!(requests.lock().expect("requests")[0]
            .starts_with("GET /dav/Yomika/Yomika/account-a.json.enc"));
    }

    #[tokio::test]
    async fn the_first_write_is_conditional_on_the_document_not_existing() {
        // MKCOL 已存在（405）+ 首次 PUT（201）。
        let (base_url, requests) = mock_server(vec!["405 Method Not Allowed", "201 Created"]).await;
        let client = WebdavClient::new(&base_url, "", "").expect("client");
        client
            .put_state("account-a", b"ciphertext", None)
            .await
            .expect("first state put");
        assert!(
            requests.lock().expect("requests")[1]
                .to_ascii_lowercase()
                .contains("if-none-match: *"),
            "an unconditional first PUT can overwrite another device's document"
        );
    }

    #[tokio::test]
    async fn a_412_maps_to_a_conflict_and_keeps_the_etag_precondition() {
        let (base_url, requests) =
            mock_server(vec!["405 Method Not Allowed", "412 Precondition Failed"]).await;
        let client = WebdavClient::new(&base_url, "user", "password").expect("client");
        let error = client
            .put_state("account-a", b"encrypted", Some("etag-a"))
            .await
            .unwrap_err();
        assert!(matches!(error, RemoteError::StateConflict));
        assert!(requests.lock().expect("requests")[1]
            .to_ascii_lowercase()
            .contains("if-match: etag-a"));
    }

    #[tokio::test]
    async fn get_state_returns_ciphertext_and_etag_or_none_for_404() {
        let (base_url, requests) = mock_server(vec!["200 OK", "404 Not Found"]).await;
        let client = WebdavClient::new(&base_url, "user", "password").expect("client");
        let found = client
            .get_state("account-a")
            .await
            .expect("state")
            .expect("present");
        assert_eq!(found.ciphertext, b"ciphertext");
        assert_eq!(client.get_state("account-a").await.expect("missing"), None);
        assert!(requests.lock().expect("requests")[0]
            .starts_with("GET /Yomika/account-a.json.enc"));
    }

    #[tokio::test]
    async fn a_conflict_refetches_merges_and_retries_with_the_new_etag() {
        let (base_url, requests) = mock_server(vec![
            "405 Method Not Allowed",
            "412 Precondition Failed",
            "200 OK\r\nETag: etag-new",
            "201 Created",
        ])
        .await;
        let client = WebdavClient::new(&base_url, "user", "password").expect("client");
        client
            .update_state_with_retry(
                "account-a",
                b"local".to_vec(),
                Some("etag-old".to_string()),
                |remote| {
                    assert_eq!(remote, b"ciphertext");
                    Ok(b"merged".to_vec())
                },
            )
            .await
            .expect("retry update");
        let requests = requests.lock().expect("requests");
        assert!(requests[1]
            .to_ascii_lowercase()
            .contains("if-match: etag-old"));
        assert!(requests[2].starts_with("GET /Yomika/account-a.json.enc"));
        assert!(requests[3].starts_with("PUT /Yomika/account-a.json.enc"));
        assert!(requests[3]
            .to_ascii_lowercase()
            .contains("if-match: etag-new"));
    }

    #[tokio::test]
    async fn deleting_the_document_tolerates_a_missing_one() {
        let (base_url, requests) = mock_server(vec!["204 No Content", "404 Not Found"]).await;
        let client = WebdavClient::new(&base_url, "user", "password").expect("client");
        client.delete_state("account-a").await.expect("delete");
        client.delete_state("account-a").await.expect("delete again");
        assert!(requests.lock().expect("requests")[1]
            .starts_with("DELETE /Yomika/account-a.json.enc"));
    }
}
use reqwest::{Client, StatusCode};

use super::remote::{RemoteError, RemoteState};

pub struct WebdavClient {
    base_url: reqwest::Url,
    client: Client,
    username: String,
    password: String,
    /// Directory chains this client already created on the server. A client
    /// lives for one sync run, so the memo never outlives its account.
    ensured_collections: std::sync::Mutex<std::collections::HashSet<String>>,
}

impl WebdavClient {
    pub fn new(base_url: &str, username: &str, password: &str) -> Result<Self, RemoteError> {
        let mut url = reqwest::Url::parse(base_url)
            .map_err(|error| RemoteError::InvalidUrl(error.to_string()))?;
        if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
            return Err(RemoteError::InvalidUrl(
                "WebDAV URL must use http(s)".to_string(),
            ));
        }
        // The base URL is a directory the app's paths hang off. Without the
        // trailing slash a later segment join would replace the last path
        // entry (`/dav/files/user` + `Yomika` → `/dav/files/Yomika`).
        if !url.path().ends_with('/') {
            let directory = format!("{}/", url.path());
            url.set_path(&directory);
        }
        Ok(Self {
            base_url: url,
            // Without an explicit timeout a stalled WebDAV server keeps the sync
            // task hanging forever; the LANraragi and E-Hentai clients already
            // set one.
            client: Client::builder()
                .timeout(std::time::Duration::from_secs(30))
                .build()
                .map_err(|error| RemoteError::Request(error.to_string()))?,
            username: username.to_string(),
            password: password.to_string(),
            ensured_collections: std::sync::Mutex::new(std::collections::HashSet::new()),
        })
    }

    /// Resolves an app-relative path against the configured base URL. The path
    /// is joined segment by segment instead of with `Url::join`: an absolute
    /// join argument (`/Yomika/...`) would replace the base's own sub-path
    /// (`/remote.php/dav/files/user`), which is exactly what Nextcloud-style
    /// endpoints need kept.
    fn endpoint(&self, path: &str) -> Result<reqwest::Url, RemoteError> {
        let mut url = self.base_url.clone();
        {
            let mut segments = url
                .path_segments_mut()
                .map_err(|()| RemoteError::InvalidUrl("WebDAV URL path cannot be joined".to_string()))?;
            segments.pop_if_empty();
            for segment in path.split('/') {
                if !segment.is_empty() {
                    segments.push(segment);
                }
            }
        }
        Ok(url)
    }

    fn request(&self, method: reqwest::Method, url: reqwest::Url) -> reqwest::RequestBuilder {
        self.client
            .request(method, url)
            .basic_auth(&self.username, Some(&self.password))
    }

    /// Creates one collection, tolerating the answers that mean "already
    /// there": 405 is RFC 4918's MKCOL-on-existing, and some servers answer
    /// 409 when they auto-create intermediates. Anything else surfaces — the
    /// following PUT is the authoritative test of whether the tree is usable.
    async fn ensure_collection(&self, directory: &str) -> Result<(), RemoteError> {
        let response = self
            .request(
                reqwest::Method::from_bytes(b"MKCOL").expect("MKCOL method"),
                self.endpoint(directory)?,
            )
            .send()
            .await
            .map_err(|error| RemoteError::Request(error.to_string()))?;
        let status = response.status();
        if status.is_success()
            || status == StatusCode::METHOD_NOT_ALLOWED
            || status == StatusCode::CONFLICT
        {
            Ok(())
        } else {
            Err(RemoteError::Http(status))
        }
    }

    /// Makes sure the account's directory chain exists before the first write
    /// to it. Per-run memoized: the chain only grows downward, so one pass is
    /// enough for the whole sync.
    async fn ensure_collection_chain(&self, directories: &[String]) -> Result<(), RemoteError> {
        let pending: Vec<String> = {
            let ensured = self
                .ensured_collections
                .lock()
                .map_err(|_| RemoteError::Request("collection memo poisoned".to_string()))?;
            directories
                .iter()
                .filter(|directory| !ensured.contains(directory.as_str()))
                .cloned()
                .collect()
        };
        if pending.is_empty() {
            return Ok(());
        }
        for directory in &pending {
            self.ensure_collection(directory).await?;
        }
        self.ensured_collections
            .lock()
            .map_err(|_| RemoteError::Request("collection memo poisoned".to_string()))?
            .extend(pending);
        Ok(())
    }

    /// The one file a sync account owns. Everything a device knows lives in it
    /// (see `SyncStateDocument`), so the remote is a single encrypted document
    /// instead of an index plus per-device segment trees.
    fn state_path(account_id: &str) -> String {
        format!("Yomika/{account_id}.json.enc")
    }

    async fn ensure_remote_root(&self) -> Result<(), RemoteError> {
        self.ensure_collection_chain(&["Yomika".to_string()]).await
    }

    /// 「测试」按钮用：对 base_url 这一层做一次 PROPFIND（Depth: 0），确认
    /// 地址存在、凭据被接受、这个账号至少能读。207/200 都算通；404 是路径不存在，
    /// 401/403 是凭据或权限问题——三种说法对使用者来说完全不一样，所以要分开报。
    pub async fn probe(&self) -> Result<(), RemoteError> {
        let response = self
            .request(
                reqwest::Method::from_bytes(b"PROPFIND").expect("PROPFIND method"),
                self.endpoint("")?,
            )
            .header("Depth", "0")
            .send()
            .await
            .map_err(|error| RemoteError::Request(error.to_string()))?;
        let status = response.status();
        if status.is_success() || status == StatusCode::MULTI_STATUS {
            return Ok(());
        }
        if status == StatusCode::NOT_FOUND {
            return Err(RemoteError::Request(
                "地址不存在：确认 WebDAV 目录路径正确".to_string(),
            ));
        }
        Err(RemoteError::Http(status))
    }

    pub async fn get_state(&self, account_id: &str) -> Result<Option<RemoteState>, RemoteError> {
        let response = self
            .request(
                reqwest::Method::GET,
                self.endpoint(&Self::state_path(account_id))?,
            )
            .send()
            .await
            .map_err(|error| RemoteError::Request(error.to_string()))?;
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

    pub async fn put_state(
        &self,
        account_id: &str,
        bytes: &[u8],
        etag: Option<&str>,
    ) -> Result<(), RemoteError> {
        self.ensure_remote_root().await?;
        let mut request = self
            .request(
                reqwest::Method::PUT,
                self.endpoint(&Self::state_path(account_id))?,
            )
            .body(bytes.to_vec());
        // The write is always conditional. With an ETag it must match the
        // remote; without one the PUT may only CREATE the document — otherwise
        // two devices racing their first sync silently overwrite each other.
        if let Some(etag) = etag {
            request = request.header("If-Match", etag);
        } else {
            request = request.header("If-None-Match", "*");
        }
        let response = request
            .send()
            .await
            .map_err(|error| RemoteError::Request(error.to_string()))?;
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
                // 交回**真正写上去的那一份**。冲突重试期间远端可能又多了别的设备的
                // 对象，调用方拿自己一开始合并出来的那一版去应用本地，这一轮同步就
                // 白跑了：远端明明已经收下了那些对象，本机却当没看见。
                Ok(()) => return Ok(ciphertext),
                Err(RemoteError::StateConflict) if attempt < 2 => {
                    let remote = self.get_state(account_id).await?;
                    if let Some(remote) = remote {
                        ciphertext = merge(&remote.ciphertext)?;
                        etag = remote.etag;
                    } else {
                        etag = None;
                    }
                }
                Err(error) => return Err(error),
            }
        }
        Err(RemoteError::StateConflict)
    }

    /// 删掉账户的远端文档（「重置远端」）。本来就不存在也算成功。
    pub async fn delete_state(&self, account_id: &str) -> Result<(), RemoteError> {
        let response = self
            .request(
                reqwest::Method::DELETE,
                self.endpoint(&Self::state_path(account_id))?,
            )
            .send()
            .await
            .map_err(|error| RemoteError::Request(error.to_string()))?;
        if response.status().is_success() || response.status() == StatusCode::NOT_FOUND {
            Ok(())
        } else {
            Err(RemoteError::Http(response.status()))
        }
    }
}
