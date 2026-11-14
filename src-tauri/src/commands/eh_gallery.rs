//! Authenticated gallery details and the same popup favorite form used by JHenTai.
use super::*;
use base64::Engine;
use scraper::{Html, Selector};
use tauri::Manager;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GalleryDetails {
    title: String,
    category: String,
    uploader: String,
    page_count: u32,
    size: String,
    posted: String,
    tags: Vec<String>,
    cover: Option<String>,
    favorite_category: Option<u8>,
    favorite_categories: Vec<String>,
    favorite_note: String,
    thumbnails: Vec<GalleryThumbnail>,
    thumbnail_page_count: u32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GalleryThumbnail {
    url: String,
    page: u32,
    width: u32,
    height: u32,
    offset: i32,
}

fn selector(value: &str) -> Selector {
    Selector::parse(value).expect("static gallery selector")
}
fn text(document: &Html, query: &str) -> String {
    document
        .select(&selector(query))
        .next()
        .map(|node| node.text().collect::<String>().trim().to_owned())
        .unwrap_or_default()
}

fn style_image(style: &str) -> Option<String> {
    let start = style.find("url(")? + 4;
    Some(
        style[start..]
            .split(')')
            .next()?
            .trim()
            .trim_matches(['\'', '"'])
            .to_owned(),
    )
}

fn parse_thumbnails(doc: &Html) -> Vec<GalleryThumbnail> {
    let dimension = |style: &str, name: &str| -> Option<u32> {
        regex::Regex::new(&format!(r"(?:^|;)\s*{name}\s*:\s*(\d+)px"))
            .ok()?
            .captures(style)?[1]
            .parse()
            .ok()
    };
    doc.select(&selector("#gdt a[href]"))
        .filter_map(|anchor| {
            let page = anchor
                .value()
                .attr("href")?
                .trim_end_matches('/')
                .rsplit('-')
                .next()?
                .parse()
                .ok()?;
            let image = anchor.select(&selector("img")).next();
            let styled = anchor
                .select(&selector("[style]"))
                .find(|node| node.value().attr("style").and_then(style_image).is_some())
                .or_else(|| {
                    anchor
                        .parent()
                        .and_then(scraper::ElementRef::wrap)
                        .filter(|node| node.value().attr("style").and_then(style_image).is_some())
                });
            let style = styled
                .and_then(|node| node.value().attr("style"))
                .unwrap_or("");
            let url = image
                .and_then(|node| node.value().attr("src"))
                .map(str::to_owned)
                .or_else(|| style_image(style))?;
            let offset = regex::Regex::new(r"\)\s*(-?\d+)px\s")
                .ok()?
                .captures(style)
                .and_then(|cap| cap[1].parse().ok())
                .unwrap_or(0);
            let filename = url
                .rsplit('/')
                .next()
                .unwrap_or("")
                .split('-')
                .collect::<Vec<_>>();
            let encoded_width = filename.get(2).and_then(|value| value.parse::<u32>().ok());
            let encoded_height = filename.get(3).and_then(|value| value.parse::<u32>().ok());
            Some(GalleryThumbnail {
                url,
                page,
                width: dimension(style, "width")
                    .or_else(|| image.and_then(|img| img.value().attr("width")?.parse().ok()))
                    .or(encoded_width)
                    .unwrap_or(200)
                    .clamp(1, 2000),
                height: dimension(style, "height")
                    .or_else(|| image.and_then(|img| img.value().attr("height")?.parse().ok()))
                    .or(encoded_height)
                    .unwrap_or(280)
                    .clamp(1, 2000),
                offset,
            })
        })
        .collect()
}

fn image_url(raw: &str, host: &str) -> Option<(Url, bool)> {
    let url = Url::parse(&format!("https://{host}/"))
        .ok()?
        .join(raw)
        .ok()?;
    let domain = url.host_str()?;
    let under = |root: &str| {
        domain == root
            || domain
                .strip_suffix(root)
                .is_some_and(|prefix| prefix.ends_with('.'))
    };
    if url.scheme() != "https"
        || url.port_or_known_default() != Some(443)
        || !url.username().is_empty()
        || url.password().is_some()
        || !["e-hentai.org", "exhentai.org", "ehgt.org", "hath.network"]
            .iter()
            .any(|root| under(root))
    {
        return None;
    }
    let authenticated = under(host);
    Some((url, authenticated))
}

#[tauri::command]
pub async fn get_eh_gallery_image(
    app: tauri::AppHandle,
    account_id: String,
    url: String,
    database: State<'_, Database>,
) -> Result<CommandResult<String>, String> {
    let (cookie, host, _) = match credentials(&database, &account_id, "0", "0") {
        Ok(value) => value,
        Err(error) => return Ok(CommandResult::failure("EH_UNAVAILABLE", error, false)),
    };
    let Some((url, authenticated)) = image_url(&url, &host) else {
        return Ok(CommandResult::failure(
            "INVALID_RESPONSE",
            "无效的画廊图片地址",
            false,
        ));
    };
    // Reuse the normal image quota, clear-cache action and verified blob store.
    // Account/credential isolation prevents serving another login's private images.
    let identity = crate::cache::CacheImageIdentity::new(
        &format!("eh:{account_id}:{}", blake3::hash(cookie.as_bytes()).to_hex()),
        &blake3::hash(url.as_str().as_bytes()).to_hex().to_string(),
        "page-thumbnail",
        0,
    );
    let app_data = app.path().app_data_dir().ok();
    if let Some(path) = &app_data {
        let cache_app = app.clone();
        let path = path.clone();
        let key = identity.clone();
        if let Ok(Ok(Some(cached))) = tauri::async_runtime::spawn_blocking(move || {
            crate::cache::read_cached_image(&cache_app.state::<Database>(), &path, &key)
        }).await {
            return Ok(CommandResult::success(format!("data:{};base64,{}", cached.mime,
                base64::engine::general_purpose::STANDARD.encode(cached.bytes))));
        }
    }
    let client = match eh_http_client() {
        Ok(value) => value,
        Err(error) => return Ok(CommandResult::failure("EH_UNAVAILABLE", error, true)),
    };
    let mut request = client
        .get(url)
        .header("Referer", format!("https://{host}/"));
    if authenticated {
        request = request.header("Cookie", cookie);
    }
    let mut response = match request.send().await {
        Ok(value) => value,
        Err(_) => {
            return Ok(CommandResult::failure(
                "EH_UNAVAILABLE",
                "画廊图片加载失败",
                true,
            ))
        }
    };
    let mime = response
        .headers()
        .get("content-type")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_owned();
    if !response.status().is_success()
        || !matches!(
            mime.as_str(),
            "image/jpeg" | "image/png" | "image/webp" | "image/gif" | "image/avif"
        )
    {
        return Ok(CommandResult::failure(
            "EH_UNAVAILABLE",
            "画廊图片不可用，请重试",
            true,
        ));
    }
    let mut bytes = Vec::new();
    loop {
        match response.chunk().await {
            Ok(Some(chunk)) if bytes.len() + chunk.len() <= 8 * 1024 * 1024 => {
                bytes.extend_from_slice(&chunk)
            }
            Ok(None) if !bytes.is_empty() => break,
            _ => {
                return Ok(CommandResult::failure(
                    "EH_UNAVAILABLE",
                    "画廊图片读取失败或超出大小限制",
                    true,
                ))
            }
        }
    }
    if let Some(path) = app_data {
        let cache_app = app.clone();
        let cache_bytes = bytes.clone();
        let cache_mime = mime.clone();
        let _ = tauri::async_runtime::spawn_blocking(move || {
            crate::cache::write_cached_image(&cache_app.state::<Database>(), &path, &identity, &cache_mime, &cache_bytes)
        }).await;
    }
    Ok(CommandResult::success(format!(
        "data:{mime};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    )))
}

fn favorite_category(body: &str) -> Option<u8> {
    let doc = Html::parse_document(body);
    // JHenTai reads the favorite icon's sprite offset: (offset - 2) / 19.
    let icon = doc.select(&selector("#fav > .i, #gdf .i")).next()?;
    let style = icon.value().attr("style")?;
    let capture = regex::Regex::new(r"background-position:\s*0px\s+-(\d+)px")
        .unwrap()
        .captures(style)?;
    let offset = capture[1].parse::<u32>().ok()?;
    let index = offset.checked_sub(2)? / 19;
    (index < 10).then_some(index as u8)
}

fn is_favorite(body: &str) -> Option<bool> {
    if favorite_category(body).is_some() {
        return Some(true);
    }
    gallery_favorite_state(body).or_else(|| {
        let label = text(&Html::parse_document(body), "#favoritelink");
        (!label.is_empty()).then(|| !label.eq_ignore_ascii_case("Add to Favorites"))
    })
}

fn parse_gallery(body: &str) -> Option<(GalleryDetails, Option<String>)> {
    let doc = Html::parse_document(body);
    let title = text(&doc, "#gj");
    let title = if title.is_empty() {
        text(&doc, "#gn")
    } else {
        title
    };
    if title.is_empty() {
        return None;
    }
    let mut details = GalleryDetails {
        title,
        category: text(&doc, "#gdc"),
        uploader: text(&doc, "#gdn"),
        page_count: 0,
        size: String::new(),
        posted: String::new(),
        tags: Vec::new(),
        cover: None,
        favorite_category: favorite_category(body),
        favorite_categories: (1..=10).map(|i| format!("收藏夹 {i}")).collect(),
        favorite_note: String::new(),
        thumbnails: parse_thumbnails(&doc),
        thumbnail_page_count: doc
            .select(&selector(".ptt a[href], .ptb a[href]"))
            .filter_map(|a| {
                let url = Url::parse("https://e-hentai.org/")
                    .ok()?
                    .join(a.value().attr("href")?)
                    .ok()?;
                url.query_pairs()
                    .find(|(key, _)| key == "p")
                    .and_then(|(_, value)| value.parse::<u32>().ok())
                    .map(|page| page.saturating_add(1))
            })
            .max()
            .unwrap_or(1),
    };
    for row in doc.select(&selector("#gdd tr")) {
        let cells = row
            .select(&selector("td"))
            .map(|cell| cell.text().collect::<String>())
            .collect::<Vec<_>>();
        if cells.len() < 2 {
            continue;
        }
        match cells[0].trim().trim_end_matches(':') {
            "Posted" => details.posted = cells[1].trim().to_owned(),
            "File Size" => details.size = cells[1].trim().to_owned(),
            "Length" => {
                details.page_count = cells[1]
                    .split_whitespace()
                    .next()
                    .and_then(|n| n.parse().ok())
                    .unwrap_or(0)
            }
            _ => (),
        }
    }
    for row in doc.select(&selector("#taglist tr")) {
        let namespace = row
            .select(&selector("td.tc"))
            .next()
            .map(|cell| cell.text().collect::<String>())
            .unwrap_or_default();
        let containers = row.select(&selector("div[id^='td_']")).collect::<Vec<_>>();
        let tags = if containers.is_empty() {
            row.select(&selector("a[id^='ta_']")).collect::<Vec<_>>()
        } else {
            containers
        };
        for tag in tags {
            // EH places the stable namespace/key on the tag container; the
            // anchor itself has no id in some layouts (as in JHenTai).
            let id = tag.value().attr("id").unwrap_or("");
            let pair = id.strip_prefix("td_").or_else(|| id.strip_prefix("ta_"));
            let value = match pair {
                Some(pair) if pair.contains(':') => pair.replace('_', " "),
                _ => format!(
                    "{}:{}",
                    namespace.trim().trim_end_matches(':'),
                    tag.text().collect::<String>().trim()
                ),
            };
            details.tags.push(value);
        }
    }
    let cover = doc
        .select(&selector("#gd1 img"))
        .next()
        .and_then(|node| node.value().attr("src"))
        .map(str::to_owned)
        .or_else(|| {
            doc.select(&selector("#gd1[style], #gd1 [style]"))
                .find_map(|node| {
                    let style = node.value().attr("style")?;
                    let start = style.find("url(")? + 4;
                    Some(
                        style[start..]
                            .split(')')
                            .next()?
                            .trim_matches(['\'', '"', ' '])
                            .to_owned(),
                    )
                })
        });
    Some((details, cover))
}

fn parse_favorite_form(body: &str, details: &mut GalleryDetails) {
    let doc = Html::parse_document(body);
    let mut categories = vec![String::new(); 10];
    for input in doc.select(&selector(
        "input[name='favcat'], select[name='favcat'] option",
    )) {
        let value = input.value();
        let Some(category) = value
            .attr("value")
            .and_then(|n| n.parse::<usize>().ok())
            .filter(|n| *n < 10)
        else {
            continue;
        };
        let label = value
            .attr("id")
            .and_then(|id| {
                doc.select(&selector("label"))
                    .find(|label| label.value().attr("for") == Some(id))
            })
            .map(|label| label.text().collect::<String>())
            .or_else(|| {
                input
                    .ancestors()
                    .filter_map(scraper::ElementRef::wrap)
                    .find_map(|node| {
                        if node.select(&selector("input[name='favcat']")).count() != 1 {
                            return None;
                        }
                        let label = node.text().collect::<String>();
                        (!label.trim().is_empty()).then_some(label)
                    })
            })
            .unwrap_or_else(|| input.text().collect::<String>());
        categories[category] = if label.trim().is_empty() {
            format!("收藏夹 {}", category + 1)
        } else {
            label.trim().to_owned()
        };
        if value.attr("checked").is_some() || value.attr("selected").is_some() {
            details.favorite_category = Some(category as u8);
        }
    }
    details.favorite_categories = categories
        .into_iter()
        .enumerate()
        .map(|(index, name)| {
            if name.is_empty() {
                format!("收藏夹 {}", index + 1)
            } else {
                name
            }
        })
        .collect();
    details.favorite_note = doc
        .select(&selector("textarea[name='favnote']"))
        .next()
        .map(|node| node.text().collect::<String>())
        .or_else(|| {
            doc.select(&selector("input[name='favnote']"))
                .next()
                .and_then(|node| node.value().attr("value"))
                .map(str::to_owned)
        })
        .unwrap_or_default();
}

fn credentials(
    database: &Database,
    account_id: &str,
    gallery_id: &str,
    token: &str,
) -> Result<(String, String, String), String> {
    if gallery_id.is_empty()
        || token.is_empty()
        || !gallery_id.chars().all(|c| c.is_ascii_digit())
        || !token.chars().all(|c| c.is_ascii_hexdigit())
    {
        return Err("Invalid gallery identity".into());
    }
    let connection = database
        .connection
        .lock()
        .map_err(|_| crate::cache::LOCK_FAILED.to_string())?;
    read_account_cookie(&connection, &SystemEhCookieReader, account_id)
}

async fn fetch_gallery(
    cookie: &str,
    host: &str,
    gallery_id: &str,
    token: &str,
) -> Result<String, (&'static str, String, bool)> {
    fetch_gallery_page(cookie, host, gallery_id, token, 0).await
}

async fn fetch_gallery_page(
    cookie: &str,
    host: &str,
    gallery_id: &str,
    token: &str,
    page: u32,
) -> Result<String, (&'static str, String, bool)> {
    let client = eh_http_client().map_err(|e| ("EH_UNAVAILABLE", e, true))?;
    let (status, body) = read_http_response(
        client
            .get(format!("https://{host}/g/{gallery_id}/{token}/"))
            .query(&[("p", page.to_string())])
            .header("Cookie", cookie)
            .header("Cache-Control", "no-cache"),
    )
    .await
    .map_err(|e| ("EH_UNAVAILABLE", e, true))?;
    if let Some(error) = classify_eh_status(status, &body) {
        return Err(error);
    }
    Ok(body)
}

#[tauri::command]
pub async fn get_eh_gallery(
    account_id: String,
    gallery_id: String,
    token: String,
    database: State<'_, Database>,
    page: Option<u32>,
) -> Result<CommandResult<GalleryDetails>, String> {
    Ok(get_gallery_impl(account_id, gallery_id, token, page.unwrap_or(0), &database).await)
}

async fn get_gallery_impl(
    account_id: String,
    gallery_id: String,
    token: String,
    page: u32,
    database: &Database,
) -> CommandResult<GalleryDetails> {
    let (cookie, host, _) = match credentials(&database, &account_id, &gallery_id, &token) {
        Ok(value) => value,
        Err(e) => return CommandResult::failure("EH_UNAVAILABLE", e, false),
    };
    let body = match fetch_gallery_page(&cookie, &host, &gallery_id, &token, page).await {
        Ok(body) => body,
        Err((code, message, retryable)) => return CommandResult::failure(code, message, retryable),
    };
    let Some((mut details, cover_url)) = parse_gallery(&body) else {
        return CommandResult::failure("EH_UNEXPECTED_PAGE", "无法读取画廊详情", false);
    };
    if page == 0 {
        let client = match eh_http_client() {
            Ok(value) => value,
            Err(e) => return CommandResult::failure("EH_UNAVAILABLE", e, true),
        };
        let popup = client
            .get(format!("https://{host}/gallerypopups.php"))
            .query(&[
                ("gid", gallery_id.as_str()),
                ("t", token.as_str()),
                ("act", "addfav"),
            ])
            .header("Cookie", &cookie);
        if let Ok((status, popup_body)) = read_http_response(popup).await {
            if classify_eh_status(status, &popup_body).is_none() {
                parse_favorite_form(&popup_body, &mut details);
            }
        }
    }
    // A popup can preselect a default category for a gallery not in favorites.
    if is_favorite(&body) != Some(true) {
        details.favorite_category = None;
    } else if let Some(index) = favorite_category(&body) {
        details.favorite_category = Some(index);
    }
    details.cover = cover_url;
    CommandResult::success(details)
}

#[tauri::command]
pub async fn set_eh_gallery_favorite(
    account_id: String,
    gallery_id: String,
    token: String,
    category: u8,
    note: String,
    database: State<'_, Database>,
) -> Result<CommandResult<()>, String> {
    Ok(set_favorite_impl(account_id, gallery_id, token, category, note, &database).await)
}

async fn set_favorite_impl(
    account_id: String,
    gallery_id: String,
    token: String,
    category: u8,
    note: String,
    database: &Database,
) -> CommandResult<()> {
    if category > 9 || note.len() > 4000 {
        return CommandResult::failure("INVALID_RESPONSE", "收藏参数无效", false);
    }
    let (cookie, host, _) = match credentials(&database, &account_id, &gallery_id, &token) {
        Ok(value) => value,
        Err(e) => return CommandResult::failure("EH_UNAVAILABLE", e, false),
    };
    let client = match eh_http_client() {
        Ok(value) => value,
        Err(e) => return CommandResult::failure("EH_UNAVAILABLE", e, true),
    };
    let url = format!("https://{host}/gallerypopups.php");
    let popup = client
        .get(&url)
        .query(&[
            ("gid", gallery_id.as_str()),
            ("t", token.as_str()),
            ("act", "addfav"),
        ])
        .header("Cookie", &cookie);
    let (status, body) = match read_http_response(popup).await {
        Ok(value) => value,
        Err(e) => return CommandResult::failure("EH_UNAVAILABLE", e, true),
    };
    if let Some((code, message, retryable)) = classify_eh_status(status, &body) {
        return CommandResult::failure(code, message, retryable);
    }
    let Some((_, mut fields)) = favorite_form_fields(&body) else {
        return CommandResult::failure("EH_UNEXPECTED_PAGE", "无法读取收藏表单", false);
    };
    fields.retain(|(key, _)| !matches!(key.as_str(), "favcat" | "favnote" | "apply" | "update"));
    fields.extend([
        ("favcat".into(), category.to_string()),
        ("favnote".into(), note),
        ("apply".into(), "Add to Favorites".into()),
        ("update".into(), "1".into()),
    ]);
    let request = client
        .post(&url)
        .query(&[
            ("gid", gallery_id.as_str()),
            ("t", token.as_str()),
            ("act", "addfav"),
        ])
        .header("Cookie", &cookie)
        .header(
            "Referer",
            format!("{url}?gid={gallery_id}&t={token}&act=addfav"),
        )
        .form(&fields);
    let (status, body) = match read_http_response(request).await {
        Ok(value) => value,
        Err(e) => return CommandResult::failure("EH_UNAVAILABLE", e, true),
    };
    if let Some((code, message, retryable)) = classify_eh_status(status, &body) {
        return CommandResult::failure(code, message, retryable);
    }
    match fetch_gallery(&cookie, &host, &gallery_id, &token).await {
        Ok(body) if favorite_category(&body) == Some(category) => CommandResult::success(()),
        Ok(_) => CommandResult::failure(
            "EH_UNEXPECTED_PAGE",
            "无法确认收藏结果，请刷新后重试",
            false,
        ),
        Err((code, message, retryable)) => CommandResult::failure(code, message, retryable),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parses_current_and_legacy_thumbnails_and_pagination() {
        let body = r#"<h1 id="gn">Gallery</h1><div id="gd1" style="background: url('/t/cover.jpg')"></div>
          <div id="gdt" class="gt200"><a href="https://exhentai.org/s/abc/123-41"><div style="width: 100px; height: 150px; background: url(&quot;https://x.hath.network/sprite.jpg&quot;) -200px 0px no-repeat"></div></a>
          <a href="/s/def/123-42"><div style="width:200px;height:300px;background:url(https://s.exhentai.org/t/single.jpg) 0px 0px"></div></a></div>
          <table class="ptt"><tr><td><a href="?p=4">5</a></td><td><a href="?p=5">6</a></td></tr></table>"#;
        let (details, cover) = parse_gallery(body).unwrap();
        assert_eq!(cover.as_deref(), Some("/t/cover.jpg"));
        assert_eq!(details.thumbnail_page_count, 6);
        assert_eq!(details.thumbnails.len(), 2);
        assert_eq!(details.thumbnails[0].page, 41);
        assert_eq!(details.thumbnails[0].width, 100);
        assert_eq!(details.thumbnails[0].height, 150);
        assert_eq!(details.thumbnails[0].offset, -200);
        assert_eq!(
            details.thumbnails[0].url,
            "https://x.hath.network/sprite.jpg"
        );
        let doc = Html::parse_document(
            r#"<div id="gdt"><div class="gdtm"><div style="width:100px;height:150px;background:url(https://ehgt.org/s.jpg) -100px 0px"><a href="/s/abc/123-1"></a></div></div><div class="gdtl"><a href="/s/def/123-2"><img src="https://ehgt.org/l.jpg" width="200" height="300"></a></div></div>"#,
        );
        let thumbs = parse_thumbnails(&doc);
        assert_eq!(thumbs.len(), 2);
        assert_eq!(thumbs[0].offset, -100);
        assert_eq!(thumbs[1].height, 300);
    }

    #[test]
    fn images_use_account_cookie_only_on_its_own_image_hosts() {
        assert!(
            image_url("https://s.exhentai.org/t/cover.jpg", "exhentai.org")
                .unwrap()
                .1
        );
        assert_eq!(
            image_url("/t/cover.jpg", "exhentai.org")
                .unwrap()
                .0
                .as_str(),
            "https://exhentai.org/t/cover.jpg"
        );
        for url in [
            "https://ehgt.org/c.jpg",
            "https://x.hath.network/sprite.jpg",
            "https://e-hentai.org/c.jpg",
        ] {
            assert!(!image_url(url, "exhentai.org").unwrap().1);
        }
        for url in [
            "https://exhentai.org.evil.test/c.jpg",
            "https://evilexhentai.org/c.jpg",
            "http://exhentai.org/c.jpg",
            "https://exhentai.org:999/c.jpg",
            "https://user:pass@exhentai.org/c.jpg",
            "file:///tmp/c.jpg",
        ] {
            assert!(image_url(url, "exhentai.org").is_none());
        }
    }

    #[test]
    fn parses_gallery_and_favorite_popup() {
        let body = r#"<h1 id="gn">Title &amp; name</h1><div id="gd1"><div style="background: url(https://ehgt.org/cover.jpg) center"></div></div><div id="gdd"><table><tr><td>Length:</td><td>42 pages</td></tr><tr><td>File Size:</td><td>20 MB</td></tr></table></div><div id="taglist"><table><tr><td class="tc">artist:</td><td><a id="ta_artist:test">Test</a></td></tr></table></div>"#;
        let (mut details, cover) = parse_gallery(body).unwrap();
        assert_eq!(details.title, "Title & name");
        assert_eq!(details.page_count, 42);
        assert_eq!(details.tags, ["artist:test"]);
        assert_eq!(cover.as_deref(), Some("https://ehgt.org/cover.jpg"));
        parse_favorite_form(
            r#"<input name="favcat" id="fav3" value="3" checked><label for="fav3">My category</label><textarea name="favnote">A &amp; B</textarea>"#,
            &mut details,
        );
        assert_eq!(details.favorite_category, Some(3));
        assert_eq!(details.favorite_categories[3], "My category");
        assert_eq!(details.favorite_note, "A & B");
        assert!(parse_gallery("<h1>Cloudflare</h1>").is_none());
        let (details, _) = parse_gallery(r#"<h1 id="gn">Gallery</h1><div id="taglist"><table><tr><td><div id="td_artist:some_artist"><a>some artist</a></div><div id="td_language:english"><a>english</a></div></td></tr></table></div>"#).unwrap();
        assert_eq!(details.tags, ["artist:some artist", "language:english"]);
    }

    #[test]
    fn favorite_membership_comes_from_gallery_not_popup_default() {
        for index in 0..10 {
            let body = format!(
                r#"<div id="fav"><div class="i" style="background-position:0px -{}px"></div></div>"#,
                2 + index * 19
            );
            assert_eq!(favorite_category(&body), Some(index));
            assert_eq!(is_favorite(&body), Some(true));
        }
        assert_eq!(
            favorite_category(
                r#"<div id="fav"><div class="i" style="background-position:0px -1px"></div></div>"#
            ),
            None
        );
        assert_eq!(
            is_favorite(r#"<a id="favoritelink">Add to Favorites</a>"#),
            Some(false)
        );
        let (mut details, _) = parse_gallery(r#"<h1 id="gn">Gallery</h1>"#).unwrap();
        parse_favorite_form(
            r#"<select name="favcat"><option value="0">Default</option><option value="7" selected>Saved category</option></select><input name="favnote" value="Note &amp; text">"#,
            &mut details,
        );
        assert_eq!(details.favorite_category, Some(7));
        assert_eq!(details.favorite_categories[7], "Saved category");
        assert_eq!(details.favorite_note, "Note & text");
    }
}
