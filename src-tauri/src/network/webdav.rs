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
        assert!(matches!(error, WebdavError::StateConflict));
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

#[derive(Debug)]
pub enum WebdavError {
    InvalidUrl(String),
    Request(String),
    StateConflict,
    Http(StatusCode),
    Verification(String),
}

impl std::fmt::Display for WebdavError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidUrl(value) | Self::Request(value) | Self::Verification(value) => {
                formatter.write_str(value)
            }
            Self::StateConflict => formatter.write_str("WebDAV sync document conflict"),
            Self::Http(status) => write!(formatter, "WebDAV HTTP {}", status),
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub struct RemoteState {
    pub ciphertext: Vec<u8>,
    pub etag: Option<String>,
}

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
    pub fn new(base_url: &str, username: &str, password: &str) -> Result<Self, WebdavError> {
        let mut url = reqwest::Url::parse(base_url)
            .map_err(|error| WebdavError::InvalidUrl(error.to_string()))?;
        if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
            return Err(WebdavError::InvalidUrl(
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
                .map_err(|error| WebdavError::Request(error.to_string()))?,
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
    fn endpoint(&self, path: &str) -> Result<reqwest::Url, WebdavError> {
        let mut url = self.base_url.clone();
        {
            let mut segments = url
                .path_segments_mut()
                .map_err(|()| WebdavError::InvalidUrl("WebDAV URL path cannot be joined".to_string()))?;
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
    async fn ensure_collection(&self, directory: &str) -> Result<(), WebdavError> {
        let response = self
            .request(
                reqwest::Method::from_bytes(b"MKCOL").expect("MKCOL method"),
                self.endpoint(directory)?,
            )
            .send()
            .await
            .map_err(|error| WebdavError::Request(error.to_string()))?;
        let status = response.status();
        if status.is_success()
            || status == StatusCode::METHOD_NOT_ALLOWED
            || status == StatusCode::CONFLICT
        {
            Ok(())
        } else {
            Err(WebdavError::Http(status))
        }
    }

    /// Makes sure the account's directory chain exists before the first write
    /// to it. Per-run memoized: the chain only grows downward, so one pass is
    /// enough for the whole sync.
    async fn ensure_collection_chain(&self, directories: &[String]) -> Result<(), WebdavError> {
        let pending: Vec<String> = {
            let ensured = self
                .ensured_collections
                .lock()
                .map_err(|_| WebdavError::Request("collection memo poisoned".to_string()))?;
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
            .map_err(|_| WebdavError::Request("collection memo poisoned".to_string()))?
            .extend(pending);
        Ok(())
    }

    /// The one file a sync account owns. Everything a device knows lives in it
    /// (see `SyncStateDocument`), so the remote is a single encrypted document
    /// instead of an index plus per-device segment trees.
    fn state_path(account_id: &str) -> String {
        format!("Yomika/{account_id}.json.enc")
    }

    async fn ensure_remote_root(&self) -> Result<(), WebdavError> {
        self.ensure_collection_chain(&["Yomika".to_string()]).await
    }

    pub async fn get_state(&self, account_id: &str) -> Result<Option<RemoteState>, WebdavError> {
        let response = self
            .request(
                reqwest::Method::GET,
                self.endpoint(&Self::state_path(account_id))?,
            )
            .send()
            .await
            .map_err(|error| WebdavError::Request(error.to_string()))?;
        if response.status() == StatusCode::NOT_FOUND {
            return Ok(None);
        }
        if !response.status().is_success() {
            return Err(WebdavError::Http(response.status()));
        }
        let etag = response
            .headers()
            .get(reqwest::header::ETAG)
            .and_then(|value| value.to_str().ok())
            .map(str::to_string);
        let ciphertext = response
            .bytes()
            .await
            .map_err(|error| WebdavError::Request(error.to_string()))?
            .to_vec();
        Ok(Some(RemoteState { ciphertext, etag }))
    }

    pub async fn put_state(
        &self,
        account_id: &str,
        bytes: &[u8],
        etag: Option<&str>,
    ) -> Result<(), WebdavError> {
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
            .map_err(|error| WebdavError::Request(error.to_string()))?;
        if response.status() == StatusCode::PRECONDITION_FAILED {
            return Err(WebdavError::StateConflict);
        }
        if !response.status().is_success() {
            return Err(WebdavError::Http(response.status()));
        }
        Ok(())
    }

    pub async fn update_state_with_retry<F>(
        &self,
        account_id: &str,
        mut ciphertext: Vec<u8>,
        mut etag: Option<String>,
        merge: F,
    ) -> Result<(), WebdavError>
    where
        F: Fn(&[u8]) -> Result<Vec<u8>, WebdavError>,
    {
        for attempt in 0..3 {
            match self.put_state(account_id, &ciphertext, etag.as_deref()).await {
                Ok(()) => return Ok(()),
                Err(WebdavError::StateConflict) if attempt < 2 => {
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
        Err(WebdavError::StateConflict)
    }

    /// 删掉账户的远端文档（「重置远端」）。本来就不存在也算成功。
    pub async fn delete_state(&self, account_id: &str) -> Result<(), WebdavError> {
        let response = self
            .request(
                reqwest::Method::DELETE,
                self.endpoint(&Self::state_path(account_id))?,
            )
            .send()
            .await
            .map_err(|error| WebdavError::Request(error.to_string()))?;
        if response.status().is_success() || response.status() == StatusCode::NOT_FOUND {
            Ok(())
        } else {
            Err(WebdavError::Http(response.status()))
        }
    }
}
