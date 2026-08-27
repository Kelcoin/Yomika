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
        let (base_url, requests) = mock_server(vec!["201 Created", "200 OK", "201 Created"]).await;
        let client = WebdavClient::new(&base_url, "user", "password").expect("client");
        let result = client
            .upload_segment("account-a", "device-a", 1, 2, b"ciphertext")
            .await
            .expect("upload");
        assert!(result.ends_with("/changes/device-a/1-2.jsonl.enc"));
        let requests = requests.lock().expect("requests");
        assert!(
            requests[0].starts_with("PUT /Yomika/v1/account-a/changes/device-a/1-2.jsonl.enc.tmp-")
        );
        assert!(
            requests[1].starts_with("GET /Yomika/v1/account-a/changes/device-a/1-2.jsonl.enc.tmp-")
        );
        assert!(requests[2]
            .starts_with("MOVE /Yomika/v1/account-a/changes/device-a/1-2.jsonl.enc.tmp-"));
        assert!(requests[2].to_ascii_lowercase().contains("destination:"));
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
            Self::InvalidUrl(value) | Self::Request(value) | Self::Verification(value) => formatter.write_str(value),
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
}

impl WebdavClient {
    pub fn new(base_url: &str, username: &str, password: &str) -> Result<Self, WebdavError> {
        let url = reqwest::Url::parse(base_url)
            .map_err(|error| WebdavError::InvalidUrl(error.to_string()))?;
        if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
            return Err(WebdavError::InvalidUrl(
                "WebDAV URL must use http(s)".to_string(),
            ));
        }
        Ok(Self {
            base_url: url,
            client: Client::new(),
            username: username.to_string(),
            password: password.to_string(),
        })
    }

    fn endpoint(&self, path: &str) -> Result<reqwest::Url, WebdavError> {
        self.base_url
            .join(path)
            .map_err(|error| WebdavError::InvalidUrl(error.to_string()))
    }

    fn request(&self, method: reqwest::Method, url: reqwest::Url) -> reqwest::RequestBuilder {
        self.client
            .request(method, url)
            .basic_auth(&self.username, Some(&self.password))
    }

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
        let nonce = format!(
            "{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_err(|error| WebdavError::Request(error.to_string()))?
                .as_nanos()
        );
        let temp_path = format!("{final_path}.tmp-{nonce}");
        let put = self
            .request(reqwest::Method::PUT, self.endpoint(&temp_path)?)
            .body(bytes.to_vec())
            .send()
            .await
            .map_err(|error| WebdavError::Request(error.to_string()))?;
        if !put.status().is_success() {
            return Err(WebdavError::Http(put.status()));
        }
        let read = self
            .request(reqwest::Method::GET, self.endpoint(&temp_path)?)
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
                self.endpoint(&temp_path)?,
            )
            .header("Destination", self.endpoint(&final_path)?.as_str())
            .header("Overwrite", "F")
            .send()
            .await
            .map_err(|error| WebdavError::Request(error.to_string()))?;
        if !moved.status().is_success() {
            return Err(WebdavError::Http(moved.status()));
        }
        Ok(final_path)
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
        if let Some(etag) = etag {
            request = request.header("If-Match", etag);
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
