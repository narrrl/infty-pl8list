//! Audio and image proxy.
//!
//! The browser only talks to us, so visitors' addresses never reach pl8list. Only
//! HLS playlists, their segments and artist images are proxied, each with a fixed
//! or allowlisted content type, so nothing pl8list returns can run as script on
//! our origin. Previews and free tracks stream fine as a guest.
//!
//! Segments and images are cached on disk. A segment URL carries a signed token
//! (`st`) that changes with every playlist, so the cache key is the upload id inside
//! that token. We cannot check pl8list's signature, so we only trust tokens that
//! came out of a playlist we fetched ourselves.

use std::{
    collections::HashMap,
    net::SocketAddr,
    sync::Mutex,
    time::{Duration, Instant},
};

use axum::{
    Extension,
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use bytes::{Bytes, BytesMut};
use futures_util::StreamExt;
use serde::Deserialize;
use serde_json::Value;

use super::{App, CurrentUser, Peer, Res, St, client_ip};
use crate::cache::{self, IMAGE_TYPES, SEGMENT_TYPES};

const MAX_PLAYLIST: usize = 256 << 10;
const MAX_SEGMENT: usize = 16 << 20;
const MAX_IMAGE: usize = 5 << 20;
const TOKEN_TTL: Duration = Duration::from_secs(6 * 3600);
const MAX_TOKENS: usize = 50_000;

/// Segment tokens seen in playlists from pl8list, with the upload they belong to.
#[derive(Default)]
pub struct SegmentKeys(Mutex<HashMap<String, (String, Instant)>>);

impl SegmentKeys {
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, (String, Instant)>> {
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn insert(&self, token: String, upload: String) {
        let mut m = self.lock();
        if m.len() >= MAX_TOKENS {
            m.retain(|_, (_, t)| t.elapsed() < TOKEN_TTL);
            if m.len() >= MAX_TOKENS {
                m.clear();
            }
        }
        m.insert(token, (upload, Instant::now()));
    }

    fn upload(&self, token: &str) -> Option<String> {
        self.lock().get(token).filter(|(_, t)| t.elapsed() < TOKEN_TTL).map(|(u, _)| u.clone())
    }

    pub fn prune(&self) {
        self.lock().retain(|_, (_, t)| t.elapsed() < TOKEN_TTL);
    }
}

/// Handles, slugs and upload ids on pl8list only use these characters.
fn safe_segment(s: &str, max: usize) -> bool {
    !s.is_empty()
        && s.len() <= max
        && s != "."
        && s != ".."
        && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'.' || b == b'-')
}

/// The upload id pl8list put into a segment token (`base64url(json).signature`).
fn token_upload(token: &str) -> Option<String> {
    let payload = URL_SAFE_NO_PAD.decode(token.split('.').next()?).ok()?;
    let v: Value = serde_json::from_slice(&payload).ok()?;
    v.get("u")?.as_str().filter(|u| safe_segment(u, 128)).map(String::from)
}

fn require_user(app: &App, current: &CurrentUser, headers: &HeaderMap, peer: SocketAddr) -> Result<(), Response> {
    let user = current.require()?;
    if !app.limits.proxy.allow(&user.id.to_string()) || !app.limits.proxy_ip.allow(&client_ip(app, headers, peer)) {
        return Err(StatusCode::TOO_MANY_REQUESTS.into_response());
    }
    Ok(())
}

/// Read an upstream body, giving up past `max` bytes.
async fn read_capped(res: reqwest::Response, max: usize) -> Result<Bytes, StatusCode> {
    if res.content_length().is_some_and(|l| l as usize > max) {
        return Err(StatusCode::BAD_GATEWAY);
    }
    let mut body = BytesMut::new();
    let mut stream = res.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| StatusCode::BAD_GATEWAY)?;
        if body.len() + chunk.len() > max {
            return Err(StatusCode::BAD_GATEWAY);
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body.freeze())
}

async fn fetch(app: &App, url: url::Url) -> Result<reqwest::Response, StatusCode> {
    let res = app.pl8.request(url, None).send().await.map_err(|e| {
        tracing::debug!("proxy: {}", e.without_url());
        StatusCode::BAD_GATEWAY
    })?;
    match res.status().as_u16() {
        200 => Ok(res),
        403 => Err(StatusCode::FORBIDDEN),
        404 => Err(StatusCode::NOT_FOUND),
        _ => Err(StatusCode::BAD_GATEWAY),
    }
}

fn media(ctype: &'static str, body: Bytes, cache_control: &'static str) -> Response {
    ([(header::CONTENT_TYPE, ctype), (header::CACHE_CONTROL, cache_control)], body).into_response()
}

#[derive(Deserialize)]
pub struct PlaylistQuery {
    v: Option<String>,
    preview: Option<String>,
}

pub async fn playlist(
    State(app): St,
    Extension(current): Extension<CurrentUser>,
    peer: Peer,
    headers: HeaderMap,
    Path((handle, slug)): Path<(String, String)>,
    Query(q): Query<PlaylistQuery>,
) -> Res {
    if let Err(r) = require_user(&app, &current, &headers, peer.0) {
        return Ok(r);
    }
    if !safe_segment(&handle, 64) || !safe_segment(&slug, 160) || q.v.as_deref().is_some_and(|v| !safe_segment(v, 128)) {
        return Ok(StatusCode::NOT_FOUND.into_response());
    }
    let mut url = app.pl8.url(&["api", &handle, &slug, "hls", "playlist.m3u8"]);
    {
        let mut qp = url.query_pairs_mut();
        if let Some(v) = &q.v {
            qp.append_pair("v", v);
        }
        if q.preview.as_deref() == Some("true") {
            qp.append_pair("preview", "true");
        }
    }
    let body = match fetch(&app, url).await {
        Ok(res) => match read_capped(res, MAX_PLAYLIST).await {
            Ok(b) => b,
            Err(s) => return Ok(s.into_response()),
        },
        Err(s) => return Ok(s.into_response()),
    };
    let Ok(text) = std::str::from_utf8(&body) else { return Ok(StatusCode::BAD_GATEWAY.into_response()) };
    if !text.starts_with("#EXTM3U") {
        return Ok(StatusCode::BAD_GATEWAY.into_response());
    }
    for line in text.lines().filter(|l| l.starts_with("segment/")) {
        if let Some(token) = line.split_once("st=").map(|(_, t)| t.split('&').next().unwrap_or_default())
            && let Some(upload) = token_upload(token) {
                app.segments.insert(token.to_string(), upload);
            }
    }
    Ok(media("application/vnd.apple.mpegurl", body, "no-store"))
}

#[derive(Deserialize)]
pub struct SegmentQuery {
    st: Option<String>,
}

pub async fn segment(
    State(app): St,
    Extension(current): Extension<CurrentUser>,
    peer: Peer,
    headers: HeaderMap,
    Path((handle, slug, n)): Path<(String, String, String)>,
    Query(q): Query<SegmentQuery>,
) -> Res {
    if let Err(r) = require_user(&app, &current, &headers, peer.0) {
        return Ok(r);
    }
    let token = q.st.unwrap_or_default();
    let valid_token = token.len() <= 2048 && token.bytes().all(|b| b.is_ascii_alphanumeric() || b"_.-".contains(&b));
    let Ok(n) = n.parse::<u32>() else { return Ok(StatusCode::NOT_FOUND.into_response()) };
    if !safe_segment(&handle, 64) || !safe_segment(&slug, 160) || !valid_token {
        return Ok(StatusCode::NOT_FOUND.into_response());
    }
    let key = app.segments.upload(&token).map(|u| format!("seg:{u}:{n}"));
    if let Some(k) = &key
        && let Some((body, ctype)) = app.cache.get(k).await {
            return Ok(media(ctype, body, "private, max-age=86400"));
        }
    let mut url = app.pl8.url(&["api", &handle, &slug, "hls", "segment", &n.to_string()]);
    if !token.is_empty() {
        url.query_pairs_mut().append_pair("st", &token);
    }
    let res = match fetch(&app, url).await {
        Ok(r) => r,
        Err(s) => return Ok(s.into_response()),
    };
    let upstream_type = res.headers().get(header::CONTENT_TYPE).and_then(|v| v.to_str().ok());
    let Some((ctype, ext)) = cache::allowed_type(upstream_type, SEGMENT_TYPES) else {
        return Ok(StatusCode::BAD_GATEWAY.into_response());
    };
    let body = match read_capped(res, MAX_SEGMENT).await {
        Ok(b) => b,
        Err(s) => return Ok(s.into_response()),
    };
    if let Some(k) = &key {
        app.cache.put(k, ext, &body).await;
    }
    Ok(media(ctype, body, "private, max-age=86400"))
}

pub async fn image(State(app): St, Extension(current): Extension<CurrentUser>, peer: Peer, headers: HeaderMap, Path(id): Path<String>) -> Res {
    if let Err(r) = require_user(&app, &current, &headers, peer.0) {
        return Ok(r);
    }
    if id.len() > 64 || id.is_empty() || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') {
        return Ok(StatusCode::NOT_FOUND.into_response());
    }
    let key = format!("img:{id}");
    if let Some((body, ctype)) = app.cache.get(&key).await {
        return Ok(media(ctype, body, "private, max-age=86400"));
    }
    let res = match fetch(&app, app.pl8.url(&["img", &id])).await {
        Ok(r) => r,
        Err(s) => return Ok(s.into_response()),
    };
    let upstream_type = res.headers().get(header::CONTENT_TYPE).and_then(|v| v.to_str().ok());
    let Some((ctype, ext)) = cache::allowed_type(upstream_type, IMAGE_TYPES) else {
        return Ok(StatusCode::BAD_GATEWAY.into_response());
    };
    let body = match read_capped(res, MAX_IMAGE).await {
        Ok(b) => b,
        Err(s) => return Ok(s.into_response()),
    };
    app.cache.put(&key, ext, &body).await;
    Ok(media(ctype, body, "private, max-age=86400"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn path_segments() {
        assert!(safe_segment("garp-chorus-flute-vip-final-v5", 160));
        assert!(!safe_segment("..", 160));
        assert!(!safe_segment(".", 160));
        assert!(!safe_segment("a/b", 160));
        assert!(!safe_segment("a%2Fb", 160));
        assert!(!safe_segment("", 160));
    }

    #[test]
    fn reads_upload_from_token() {
        let t = "eyJ1IjoiMjU1YzhmZGUtYTUyYy00Njc2LTk2MzgtMGExOGZkNTRmN2UyLndhdiIsImgiOiJnYXJwYmUiLCJzIjoiZ2FycC1zY290dGlzY2gtc3F1YXJlLWZpbmFsLXYzLTIiLCJlIjoxNzkzNTMwMTgwfQ.nPGK9LdPDvmHDwhqlCbHbaEtJhLLqCwUIS26MlCvYR8";
        assert_eq!(token_upload(t).as_deref(), Some("255c8fde-a52c-4676-9638-0a18fd54f7e2.wav"));
        assert_eq!(token_upload("garbage"), None);
    }

    #[test]
    fn unknown_tokens_get_no_cache_key() {
        let keys = SegmentKeys::default();
        keys.insert("known".into(), "u1".into());
        assert_eq!(keys.upload("known").as_deref(), Some("u1"));
        assert_eq!(keys.upload("forged"), None);
    }
}
