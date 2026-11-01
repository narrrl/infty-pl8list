//! Client for pl8list.com.
//!
//! pl8list is a Remix app, so every page loader can be read as JSON by adding
//! `?_data=<route id>` to the page URL. Resource routes under /api/ return JSON
//! directly. All JSON requests share one throttle so we stay polite.
//!
//! Public data (artist pages, related tracks, previews, free tracks) works without
//! an account, so the crawler runs as a guest. A user's own session is only needed
//! for login and for syncing with their account (feed, library, saves).

pub mod login;
pub mod normalize;

use std::time::Duration;

use reqwest::{StatusCode, redirect};
use secrecy::{ExposeSecret, SecretString};
use serde_json::Value;
use tokio::{sync::Mutex, time::Instant};
use url::Url;

pub const USER_AGENT: &str = "pl8list-wrapper/0.3 (infinite-scroll client, https://pl8.narl.io)";
/// Signed storage URLs for audio and images point here.
const FILES_HOST: &str = "files.pl8list.com";

pub struct Pl8 {
    http: reqwest::Client,
    base: Url,
    min_interval: Duration,
    last: Mutex<Instant>,
}

impl Pl8 {
    pub fn new(base: &str, min_interval: Duration) -> anyhow::Result<Self> {
        let base = Url::parse(base)?;
        let own_host = base.host_str().unwrap_or_default().to_string();
        let own_scheme = base.scheme().to_string();
        // Follow redirects only to pl8list and its storage host, never anywhere else.
        let policy = redirect::Policy::custom(move |attempt| {
            let url = attempt.url();
            let host = url.host_str().unwrap_or_default();
            let ok_host = host == own_host || host == FILES_HOST;
            let ok_scheme = url.scheme() == "https" || url.scheme() == own_scheme;
            if attempt.previous().len() >= 3 || !ok_host || !ok_scheme {
                attempt.stop()
            } else {
                attempt.follow()
            }
        });
        let http = reqwest::Client::builder()
            .user_agent(USER_AGENT)
            .redirect(policy)
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(30))
            .build()?;
        Ok(Pl8 { http, base, min_interval, last: Mutex::new(Instant::now() - min_interval) })
    }

    async fn throttle(&self) {
        let mut last = self.last.lock().await;
        let next = *last + self.min_interval;
        tokio::time::sleep_until(next).await;
        *last = Instant::now();
    }

    /// URL on pl8list from already-decoded path segments.
    pub fn url(&self, segments: &[&str]) -> Url {
        let mut url = self.base.clone();
        url.path_segments_mut().expect("base is a URL with a path").clear().extend(segments);
        url
    }

    pub fn request(&self, url: Url, session: Option<&SecretString>) -> reqwest::RequestBuilder {
        with_session(self.http.get(url), session)
    }

    /// JSON GET with retries on overload. 403/404 give `None`. With a user session,
    /// a redirect to the login page gives `SessionExpired`.
    pub async fn get_json(
        &self,
        segments: &[&str],
        params: &[(&str, String)],
        route: Option<&str>,
        mut session: Option<&mut UserSession>,
    ) -> anyhow::Result<Option<Value>> {
        let mut url = self.url(segments);
        {
            let mut q = url.query_pairs_mut();
            for (k, v) in params {
                q.append_pair(k, v);
            }
            if let Some(r) = route {
                q.append_pair("_data", r);
            }
        }
        for attempt in 0..4u32 {
            self.throttle().await;
            let res = self.request(url.clone(), session.as_deref().map(|s| &s.cookie)).send().await?;
            if let Some(s) = session.as_deref_mut() {
                s.update(&res)?;
            }
            match res.status() {
                s if s.is_success() => {
                    let body = res.bytes().await?;
                    return Ok(if body.is_empty() { None } else { Some(serde_json::from_slice(&body)?) });
                }
                StatusCode::TOO_MANY_REQUESTS | StatusCode::BAD_GATEWAY | StatusCode::SERVICE_UNAVAILABLE
                | StatusCode::GATEWAY_TIMEOUT
                    if attempt < 3 =>
                {
                    tokio::time::sleep(Duration::from_secs(3 << attempt)).await;
                }
                StatusCode::FORBIDDEN | StatusCode::NOT_FOUND => return Ok(None),
                s => anyhow::bail!("pl8list {} for {}", s, url.path()),
            }
        }
        Ok(None)
    }

    // Loaders -------------------------------------------------------------
    //
    // Paginated loaders ignore `page` unless `pagination=true` is also set,
    // which is what the site's own useInfiniteLoading hook sends.

    pub async fn root(&self, session: Option<&mut UserSession>) -> anyhow::Result<Option<Value>> {
        self.get_json(&[], &[], Some("root"), session).await
    }

    pub async fn home(&self) -> anyhow::Result<Option<Value>> {
        self.get_json(&[], &[], Some("routes/_index"), None).await
    }

    pub async fn feed(&self, session: &mut UserSession, page: i64) -> anyhow::Result<Option<Value>> {
        let p = [("page", page.to_string()), ("pagination", "true".into())];
        self.get_json(&["api", "feed"], &p, None, Some(session)).await
    }

    /// Tracks the user saved on pl8list (`items`, `totalPages`).
    pub async fn library_tracks(&self, session: &mut UserSession, page: i64) -> anyhow::Result<Option<Value>> {
        let p = [("page", page.to_string()), ("pagination", "true".into())];
        self.get_json(&["library", "tracks"], &p, Some("routes/library.tracks"), Some(session)).await
    }

    /// Artists the user saved (follows) on pl8list (`items`, `totalPages`).
    pub async fn library_artists(&self, session: &mut UserSession, page: i64) -> anyhow::Result<Option<Value>> {
        let p = [("page", page.to_string()), ("pagination", "true".into())];
        self.get_json(&["library", "artists"], &p, Some("routes/library.artists"), Some(session)).await
    }

    pub async fn artist(&self, handle: &str, page: i64) -> anyhow::Result<Option<Value>> {
        let p = [("page", page.to_string()), ("pagination", "true".into())];
        self.get_json(&[handle], &p, Some("routes/$handle"), None).await
    }

    pub async fn related(&self, handle: &str, slug: &str) -> anyhow::Result<Option<Value>> {
        self.get_json(&[handle, slug, "related"], &[], Some("routes/$handle_.$slug.related"), None).await
    }

    pub async fn best_selling_artists(&self) -> anyhow::Result<Option<Value>> {
        self.get_json(&["best-selling-artists"], &[], Some("routes/best-selling-artists"), None).await
    }

    pub async fn activity_ticker(&self) -> anyhow::Result<Option<Value>> {
        self.get_json(&["api", "activity-ticker"], &[], None, None).await
    }

    pub async fn search_users(&self, q: &str, page: i64) -> anyhow::Result<Option<Value>> {
        let p = [("q", q.to_string()), ("page", page.to_string()), ("pagination", "true".into())];
        self.get_json(&["search", "users"], &p, Some("routes/search.users"), None).await
    }

    /// Save a track (`[handle, slug]`) or an artist (`[handle]`) to the user's pl8list
    /// library. `addOnly` makes the toggle idempotent: it never removes anything.
    pub async fn save(&self, session: &mut UserSession, target: &[&str]) -> anyhow::Result<()> {
        let mut segments = vec!["api"];
        segments.extend_from_slice(target);
        segments.push("add-to-library");
        let mut url = self.url(&segments);
        url.query_pairs_mut().append_pair("addOnly", "true");
        self.throttle().await;
        let res = with_session(self.http.post(url), Some(&session.cookie)).send().await?;
        session.update(&res)?;
        let status = res.status();
        let body: Value = res.json().await.unwrap_or(Value::Null);
        if !status.is_success() || body.get("success").and_then(Value::as_bool) == Some(false) {
            anyhow::bail!("pl8list refused the save (HTTP {status})");
        }
        Ok(())
    }

    /// End a session at pl8list. Errors are ignored: we drop the session either way.
    pub async fn logout(&self, session: &SecretString) {
        let mut url = self.url(&["logout"]);
        url.query_pairs_mut().append_pair("_data", "routes/logout");
        if let Err(e) = self.request(url, Some(session)).send().await {
            tracing::warn!("pl8list logout failed: {}", e.without_url());
        }
    }

    pub fn http(&self) -> &reqwest::Client {
        &self.http
    }
}

fn with_session(req: reqwest::RequestBuilder, session: Option<&SecretString>) -> reqwest::RequestBuilder {
    match session {
        Some(s) => req.header("Cookie", format!("_session={}", s.expose_secret())),
        None => req,
    }
}

/// pl8list no longer accepts the session; the user has to sign in again.
#[derive(Debug)]
pub struct SessionExpired;

impl std::fmt::Display for SessionExpired {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        f.write_str("pl8list session expired")
    }
}

impl std::error::Error for SessionExpired {}

/// A signed-in pl8list session used on a user's behalf. pl8list may send a new
/// cookie with any response; `changed` tells the owner to store it again.
pub struct UserSession {
    cookie: SecretString,
    pub changed: bool,
}

impl UserSession {
    pub fn new(cookie: SecretString) -> Self {
        UserSession { cookie, changed: false }
    }

    pub fn cookie(&self) -> &SecretString {
        &self.cookie
    }

    pub fn into_cookie(self) -> SecretString {
        self.cookie
    }

    /// Take a refreshed cookie from `res`, and notice when pl8list sends us to its login.
    fn update(&mut self, res: &reqwest::Response) -> Result<(), SessionExpired> {
        let to_login = |p: &str| p == "/login" || p.starts_with("/login?");
        let remix_redirect = res.headers().get("x-remix-redirect").and_then(|v| v.to_str().ok());
        if to_login(res.url().path()) || remix_redirect.is_some_and(to_login) {
            return Err(SessionExpired);
        }
        for c in res.headers().get_all("set-cookie") {
            let Some(v) = c.to_str().ok().and_then(|c| c.strip_prefix("_session=")) else { continue };
            let v = v.split(';').next().unwrap_or_default();
            if v.is_empty() {
                return Err(SessionExpired);
            }
            if v != self.cookie.expose_secret() {
                self.cookie = SecretString::from(v.to_string());
                self.changed = true;
            }
        }
        Ok(())
    }
}
