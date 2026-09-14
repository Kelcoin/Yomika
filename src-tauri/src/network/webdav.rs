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
    async fn upload_uses_temporary_put_verification_and_move() {
        // HEAD probe, five MKCOLs, then the PUT / GET / MOVE trio.
        let (base_url, requests) = mock_server(vec![
            "404 Not Found",
            "201 Created",
            "201 Created",
            "201 Created",
            "201 Created",
            "201 Created",
            "201 Created",
            "200 OK",
            "201 Created",
        ])
        .await;
        let client = WebdavClient::new(&base_url, "user", "password").expect("client");
        let result = client
            .upload_segment("account-a", "device-a", 1, 2, b"ciphertext")
            .await
            .expect("upload");
        assert!(result.ends_with("/changes/device-a/1-2.jsonl.enc"));
        let requests = requests.lock().expect("requests");
        assert!(
            requests[0].starts_with("HEAD /Yomika/v1/account-a/changes/device-a/1-2.jsonl.enc")
        );
        assert!(requests[1].starts_with("MKCOL /Yomika"));
        assert!(
            requests[6].starts_with("PUT /Yomika/v1/account-a/changes/device-a/1-2.jsonl.enc.tmp-")
        );
        assert!(
            requests[7].starts_with("GET /Yomika/v1/account-a/changes/device-a/1-2.jsonl.enc.tmp-")
        );
        assert!(requests[8]
            .starts_with("MOVE /Yomika/v1/account-a/changes/device-a/1-2.jsonl.enc.tmp-"));
        assert!(requests[8].to_ascii_lowercase().contains("destination:"));
    }

    /// A configured base URL with a sub-path (Nextcloud's
    /// `/remote.php/dav/files/<user>/`) must survive every request: joining an
    /// absolute path with `Url::join` replaces the base path entirely.
    #[tokio::test]
    async fn configured_subpath_survives_every_request() {
        let (base_url, requests) = mock_server(vec!["404 Not Found"]).await;
        let client = WebdavClient::new(
            &format!("{base_url}/remote.php/dav/files/tester/"),
            "",
            "",
        )
        .expect("client");
        client
            .get_manifest("account-a")
            .await
            .expect("manifest probe");
        assert!(
            requests.lock().expect("requests")[0]
                .starts_with("GET /remote.php/dav/files/tester/Yomika/v1/account-a/"),
            "the configured WebDAV sub-path was discarded"
        );
    }

    /// A fresh WebDAV account has no collections yet, so the first segment PUT
    /// would 404/409: the client creates the account's directory chain first.
    #[tokio::test]
    async fn fresh_account_creates_its_collection_chain_before_uploading() {
        let (base_url, requests) = mock_server(vec![
            "404 Not Found",
            "201 Created",
            "201 Created",
            "201 Created",
            "201 Created",
            "201 Created",
            "201 Created",
            "200 OK",
            "201 Created",
        ])
        .await;
        let client = WebdavClient::new(&base_url, "", "").expect("client");
        client
            .upload_segment("account-a", "device-a", 1, 2, b"ciphertext")
            .await
            .expect("upload");
        let requests = requests.lock().expect("requests");
        assert!(requests[1].starts_with("MKCOL /Yomika "), "first MKCOL misses the root collection: {}", requests[1]);
        assert!(requests[2].starts_with("MKCOL /Yomika/v1 "));
        assert!(requests[3].starts_with("MKCOL /Yomika/v1/account-a "));
        assert!(requests[4].starts_with("MKCOL /Yomika/v1/account-a/changes "));
        assert!(requests[5].starts_with("MKCOL /Yomika/v1/account-a/changes/device-a "));
    }

    #[tokio::test]
    async fn first_manifest_put_is_conditional_on_the_manifest_not_existing() {
        let (base_url, requests) = mock_server(vec!["201 Created"]).await;
        let client = WebdavClient::new(&base_url, "", "").expect("client");
        client
            .put_manifest("account-a", b"ciphertext", None)
            .await
            .expect("first manifest put");
        assert!(
            requests.lock().expect("requests")[0]
                .to_ascii_lowercase()
                .contains("if-none-match: *"),
            "an unconditional first PUT can overwrite another device's first manifest"
        );
    }

    #[tokio::test]
    async fn retrying_an_already_moved_segment_succeeds() {
        // Attempt 1 moves the segment into place but (off-screen) the manifest
        // update fails. Attempt 2 re-uploads the same range: the HEAD probe
        // finds the final file and the upload succeeds without a MOVE.
        let (base_url, requests) = mock_server(vec![
            "404 Not Found",
            "201 Created",
            "201 Created",
            "201 Created",
            "201 Created",
            "201 Created",
            "201 Created",
            "200 OK",
            "201 Created",
            "200 OK",
        ])
        .await;
        let client = WebdavClient::new(&base_url, "", "").expect("client");
        client
            .upload_segment("account-a", "device-a", 1, 2, b"ciphertext")
            .await
            .expect("first upload");
        client
            .upload_segment("account-a", "device-a", 1, 2, b"ciphertext")
            .await
            .expect("retry after a lost manifest update");
        assert!(
            requests.lock().expect("requests")[9].starts_with("HEAD "),
            "the retry should stop at the HEAD probe"
        );
    }

    #[tokio::test]
    async fn a_move_that_races_a_concurrent_upload_still_succeeds() {
        // MOVE hits an existing destination (412), and the destination check
        // finds the file — the concurrent attempt already uploaded this range.
        let (base_url, requests) = mock_server(vec![
            "404 Not Found",
            "201 Created",
            "201 Created",
            "201 Created",
            "201 Created",
            "201 Created",
            "201 Created",
            "200 OK",
            "412 Precondition Failed",
            "200 OK",
            "204 No Content",
        ])
        .await;
        let client = WebdavClient::new(&base_url, "", "").expect("client");
        client
            .upload_segment("account-a", "device-a", 1, 2, b"ciphertext")
            .await
            .expect("race-resolved upload");
        assert!(
            requests.lock().expect("requests")[8].starts_with("MOVE "),
            "the fourth request after HEAD/MKCOLs/PUT/GET is the MOVE"
        );
    }

    #[tokio::test]
    async fn conditional_manifest_put_maps_412_conflict() {
        let (base_url, requests) = mock_server(vec!["412 Precondition Failed"]).await;
        let client = WebdavClient::new(&base_url, "user", "password").expect("client");
        let error = client
            .put_manifest("account-a", b"encrypted", Some("etag-a"))
            .await
            .unwrap_err();
        assert!(matches!(error, WebdavError::ManifestConflict));
        assert!(requests.lock().expect("requests")[0]
            .to_ascii_lowercase()
            .contains("if-match: etag-a"));
    }

    #[tokio::test]
    async fn get_manifest_returns_ciphertext_and_etag_or_none_for_404() {
        let (base_url, requests) = mock_server(vec!["200 OK", "404 Not Found"]).await;
        let client = WebdavClient::new(&base_url, "user", "password").expect("client");
        let found = client
            .get_manifest("account-a")
            .await
            .expect("manifest")
            .expect("present");
        assert_eq!(found.ciphertext, b"ciphertext");
        assert_eq!(
            client.get_manifest("account-a").await.expect("missing"),
            None
        );
        assert!(requests.lock().expect("requests")[0]
            .starts_with("GET /Yomika/v1/account-a/manifest.json.enc"));
    }

    #[tokio::test]
    async fn manifest_conflict_refetches_merges_and_retries_with_new_etag() {
        let (base_url, requests) = mock_server(vec![
            "412 Precondition Failed",
            "200 OK\r\nETag: etag-new",
            "201 Created",
        ])
        .await;
        let client = WebdavClient::new(&base_url, "user", "password").expect("client");
        client
            .update_manifest_with_retry(
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
        assert!(requests[0]
            .to_ascii_lowercase()
            .contains("if-match: etag-old"));
        assert!(requests[1].starts_with("GET /Yomika/v1/account-a/manifest.json.enc"));
        assert!(requests[2].starts_with("PUT /Yomika/v1/account-a/manifest.json.enc"));
        assert!(requests[2]
            .to_ascii_lowercase()
            .contains("if-match: etag-new"));
    }

    #[tokio::test]
    async fn segment_download_gets_the_immutable_file() {
        let (base_url, requests) = mock_server(vec!["200 OK", "404 Not Found"]).await;
        let client = WebdavClient::new(&base_url, "user", "password").expect("client");
        let bytes = client
            .download_segment("account-a", "device-b", 5, 9)
            .await
            .expect("download");
        assert_eq!(bytes, b"ciphertext");
        assert!(client
            .download_segment("account-a", "device-b", 5, 9)
            .await
            .is_err());
        let requests = requests.lock().expect("requests");
        assert!(requests[0]
            .starts_with("GET /Yomika/v1/account-a/changes/device-b/5-9.jsonl.enc"));
    }
}
use reqwest::{Client, StatusCode};

#[derive(Debug)]
pub enum WebdavError {
    InvalidUrl(String),
    Request(String),
    ManifestConflict,
    Http(StatusCode),
    Verification(String),
}

impl std::fmt::Display for WebdavError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidUrl(value) | Self::Request(value) | Self::Verification(value) => {
                formatter.write_str(value)
            }
            Self::ManifestConflict => formatter.write_str("WebDAV manifest conflict"),
            Self::Http(status) => write!(formatter, "WebDAV HTTP {}", status),
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub struct RemoteManifest {
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

    /// The five collections between the server root and one device's segment
    /// directory.
    fn collection_chain(account_id: &str, device_id: &str) -> Vec<String> {
        vec![
            "Yomika".to_string(),
            "Yomika/v1".to_string(),
            format!("Yomika/v1/{account_id}"),
            format!("Yomika/v1/{account_id}/changes"),
            format!("Yomika/v1/{account_id}/changes/{device_id}"),
        ]
    }

    /// Uploads one immutable change segment. Segments are content-addressed by
    /// their name (`device/start-end`): the same name always carries the same
    /// journal rows, so an existing final file means this batch is already on
    /// the server — the ciphertext bytes differ between builds only by the
    /// encryption nonce. That pre-check is what makes the retry after a lost
    /// manifest update succeed instead of colliding with `Overwrite: F`.
    pub async fn upload_segment(
        &self,
        account_id: &str,
        device_id: &str,
        start: i64,
        end: i64,
        bytes: &[u8],
    ) -> Result<String, WebdavError> {
        let final_path =
            format!("/Yomika/v1/{account_id}/changes/{device_id}/{start}-{end}.jsonl.enc");
        let probe = self
            .request(reqwest::Method::HEAD, self.endpoint(&final_path[1..])?)
            .send()
            .await
            .map_err(|error| WebdavError::Request(error.to_string()))?;
        if probe.status().is_success() {
            return Ok(final_path);
        }
        self.ensure_collection_chain(&Self::collection_chain(account_id, device_id))
            .await?;
        let nonce = format!(
            "{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_err(|error| WebdavError::Request(error.to_string()))?
                .as_nanos()
        );
        let temp_path = format!("{final_path}.tmp-{nonce}");
        let put = self
            .request(reqwest::Method::PUT, self.endpoint(&temp_path[1..])?)
            .body(bytes.to_vec())
            .send()
            .await
            .map_err(|error| WebdavError::Request(error.to_string()))?;
        if !put.status().is_success() {
            return Err(WebdavError::Http(put.status()));
        }
        let read = self
            .request(reqwest::Method::GET, self.endpoint(&temp_path[1..])?)
            .send()
            .await
            .map_err(|error| WebdavError::Request(error.to_string()))?;
        if !read.status().is_success() {
            return Err(WebdavError::Http(read.status()));
        }
        let downloaded = read
            .bytes()
            .await
            .map_err(|error| WebdavError::Request(error.to_string()))?;
        if downloaded.as_ref() != bytes {
            return Err(WebdavError::Verification(
                "temporary segment verification failed".to_string(),
            ));
        }
        let moved = self
            .request(
                reqwest::Method::from_bytes(b"MOVE").expect("MOVE method"),
                self.endpoint(&temp_path[1..])?,
            )
            .header("Destination", self.endpoint(&final_path[1..])?.as_str())
            .header("Overwrite", "F")
            .send()
            .await
            .map_err(|error| WebdavError::Request(error.to_string()))?;
        if !moved.status().is_success() {
            // The pre-check raced another attempt that moved the same range
            // into place in between; the destination check tells a lost race
            // (already uploaded — done) from a real failure.
            let existing = self
                .request(reqwest::Method::GET, self.endpoint(&final_path[1..])?)
                .send()
                .await;
            if existing
                .as_ref()
                .map(|response| response.status().is_success())
                .unwrap_or(false)
            {
                let _ = self
                    .request(
                        reqwest::Method::DELETE,
                        self.endpoint(&temp_path[1..])?,
                    )
                    .send()
                    .await;
                return Ok(final_path);
            }
            return Err(WebdavError::Http(moved.status()));
        }
        Ok(final_path)
    }

    /// Fetches another device's immutable change segment for local merge. The
    /// file is content-addressed by its name, so a plain GET is enough — no
    /// verification round trip like the upload's temporary file needs.
    pub async fn download_segment(
        &self,
        account_id: &str,
        device_id: &str,
        start: i64,
        end: i64,
    ) -> Result<Vec<u8>, WebdavError> {
        let response = self
            .request(
                reqwest::Method::GET,
                self.endpoint(&format!(
                    "/Yomika/v1/{account_id}/changes/{device_id}/{start}-{end}.jsonl.enc"
                ))?,
            )
            .send()
            .await
            .map_err(|error| WebdavError::Request(error.to_string()))?;
        if !response.status().is_success() {
            return Err(WebdavError::Http(response.status()));
        }
        let bytes = response
            .bytes()
            .await
            .map_err(|error| WebdavError::Request(error.to_string()))?;
        if bytes.is_empty() {
            return Err(WebdavError::Verification(
                "remote change segment is empty".to_string(),
            ));
        }
        Ok(bytes.to_vec())
    }

    pub async fn put_manifest(
        &self,
        account_id: &str,
        bytes: &[u8],
        etag: Option<&str>,
    ) -> Result<(), WebdavError> {
        let mut request = self
            .request(
                reqwest::Method::PUT,
                self.endpoint(&format!("/Yomika/v1/{account_id}/manifest.json.enc"))?,
            )
            .body(bytes.to_vec());
        // A manifest write is always conditional. With an ETag it must match
        // the remote; without one the PUT may only CREATE the manifest —
        // otherwise two devices racing their first sync silently overwrite
        // each other's segment index.
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
            return Err(WebdavError::ManifestConflict);
        }
        if !response.status().is_success() {
            return Err(WebdavError::Http(response.status()));
        }
        Ok(())
    }

    pub async fn get_manifest(
        &self,
        account_id: &str,
    ) -> Result<Option<RemoteManifest>, WebdavError> {
        let response = self
            .request(
                reqwest::Method::GET,
                self.endpoint(&format!("/Yomika/v1/{account_id}/manifest.json.enc"))?,
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
        Ok(Some(RemoteManifest { ciphertext, etag }))
    }

    pub async fn update_manifest_with_retry<F>(
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
            match self
                .put_manifest(account_id, &ciphertext, etag.as_deref())
                .await
            {
                Ok(()) => return Ok(()),
                Err(WebdavError::ManifestConflict) if attempt < 2 => {
                    let remote = self.get_manifest(account_id).await?;
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
        Err(WebdavError::ManifestConflict)
    }
}
