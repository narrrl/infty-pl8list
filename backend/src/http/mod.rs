//! Routes, shared state and the middleware every request goes through.

pub mod account;
pub mod app;
pub mod auth;
pub mod legal;
pub mod proxy;
pub mod security;
#[cfg(test)]
mod tests;

use std::{net::SocketAddr, sync::Arc, time::Duration};

use axum::{
    Json, Router,
    extract::{ConnectInfo, DefaultBodyLimit, Path, Request, State},
    http::{HeaderMap, HeaderValue, Method, StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use rust_embed::Embed;
use serde_json::json;
use tower::limit::GlobalConcurrencyLimitLayer;
use tower_http::timeout::TimeoutLayer;

use secrecy::SecretString;

use crate::{
    cache::Cache,
    config::Config,
    crawler::Crawler,
    db::{self, Db, User},
    link::{LinkKey, Sealer},
    pl8::Pl8,
    ratelimit::RateLimiter,
    sync::Syncer,
};
use security::Cookies;

pub const SESSION_COOKIE: &str = "pl8inf";
pub const LOGIN_COOKIE: &str = "pl8inf_login";
/// Sessions get a new token once they are this old.
const ROTATE_AFTER: f64 = 7.0 * 86400.0;

pub struct Limits {
    pub login_ip: RateLimiter,
    pub login_email: RateLimiter,
    /// Every start and resend makes pl8list send a mail; cap them for the whole server.
    pub login_global: RateLimiter,
    pub events: RateLimiter,
    pub proxy: RateLimiter,
    /// Saves to a user's pl8list library (likes and follows pushed from here).
    pub pl8_writes: RateLimiter,
    /// The resync button.
    pub resync: RateLimiter,
    /// Guests made per IP: each is a row in the database.
    pub guests: RateLimiter,
}

pub struct App {
    pub cfg: Config,
    pub db: Db,
    pub pl8: Arc<Pl8>,
    pub crawler: Arc<Crawler>,
    pub sync: Arc<Syncer>,
    pub cache: Cache,
    pub logins: auth::PendingLogins,
    pub limits: Limits,
    pub cookies: Cookies,
    pub segments: proxy::SegmentKeys,
    pub legal: legal::Pages,
}

pub type St = State<Arc<App>>;

impl App {
    pub fn new(cfg: Config, db: Db, pl8: Arc<Pl8>, crawler: Arc<Crawler>, link: LinkKey) -> Arc<Self> {
        let cache = Cache::open(cfg.cache_dir.clone(), cfg.cache_max_bytes);
        let sync = Syncer::new(pl8.clone(), db.clone(), crawler.clone(), link);
        let legal = legal::Pages::render(&cfg.legal);
        Arc::new(App {
            cookies: Cookies { secure: cfg.secure },
            limits: Limits {
                login_ip: RateLimiter::new(5, 900),
                login_email: RateLimiter::new(3, 900),
                login_global: RateLimiter::new(30, 600),
                events: RateLimiter::new(600, 600),
                proxy: RateLimiter::new(1200, 60),
                pl8_writes: RateLimiter::new(60, 600),
                resync: RateLimiter::new(1, 120),
                guests: RateLimiter::new(10, 3600),
            },
            logins: auth::PendingLogins::default(),
            segments: proxy::SegmentKeys::default(),
            sync,
            cache,
            legal,
            cfg,
            db,
            pl8,
            crawler,
        })
    }

    /// Hourly housekeeping.
    pub async fn purge(&self) {
        match self.db.call(db::purge).await {
            Ok((s, e, g)) if s + e + g > 0 => tracing::info!("purged {s} expired sessions, {e} old served events, {g} gone guests"),
            Ok(_) => {}
            Err(e) => tracing::warn!("purge failed: {e:#}"),
        }
        self.logins.prune();
        self.segments.prune();
        self.limits.guests.prune();
    }

    /// This device's stored pl8list session, if it stays connected. A blob that no
    /// longer opens (for example after the server key changed) is dropped.
    pub async fn connected(&self, current: &CurrentUser) -> Option<(Sealer, SecretString)> {
        let (Some(user), Some(token), Some(blob)) = (&current.user, &current.token, &current.link) else { return None };
        let sealer = self.sync.key.sealer(token, user.id);
        match sealer.open(blob) {
            Some(session) => Some((sealer, session)),
            None => {
                let hash = sealer.token_hash.clone();
                let _ = self.db.call(move |c| db::clear_link(c, &hash)).await;
                None
            }
        }
    }
}

// Errors ------------------------------------------------------------------

pub struct AppError(anyhow::Error);

impl<E: Into<anyhow::Error>> From<E> for AppError {
    fn from(e: E) -> Self {
        AppError(e.into())
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        tracing::error!("{:#}", self.0);
        StatusCode::INTERNAL_SERVER_ERROR.into_response()
    }
}

pub type Res = Result<Response, AppError>;

pub fn json_error(status: StatusCode, msg: &str) -> Response {
    (status, no_store(), Json(json!({ "error": msg }))).into_response()
}

pub fn no_store() -> [(header::HeaderName, &'static str); 1] {
    [(header::CACHE_CONTROL, "no-store")]
}

// Session -----------------------------------------------------------------

/// The signed-in user, put into request extensions by `session`.
#[derive(Clone)]
pub struct CurrentUser {
    pub user: Option<User>,
    pub token: Option<String>,
    /// Encrypted pl8list session of this device (see `link.rs`).
    pub link: Option<Vec<u8>>,
    pub synced_at: Option<f64>,
}

impl CurrentUser {
    pub fn require(&self) -> Result<&User, Response> {
        self.user.as_ref().ok_or_else(|| StatusCode::UNAUTHORIZED.into_response())
    }
}

/// Look up the session cookie, rotate old tokens and move the Python version's
/// unprefixed cookie to the `__Host-` one.
async fn session(State(app): St, mut req: Request, next: Next) -> Response {
    let name = app.cookies.name(SESSION_COOKIE);
    let headers = req.headers();
    let (token, legacy) = match security::cookie(headers, &name) {
        Some(t) => (Some(t.to_string()), false),
        None if app.cookies.secure => (security::cookie(headers, SESSION_COOKIE).map(String::from), true),
        None => (None, false),
    };
    let mut set_cookie: Vec<HeaderValue> = vec![];
    let mut current = CurrentUser { user: None, token: token.clone(), link: None, synced_at: None };
    if let Some(t) = token {
        let lookup = t.clone();
        if let Ok(Some(hit)) = app.db.call(move |c| db::session_user(c, &lookup)).await {
            let mut new_token = None;
            current.link = hit.link.clone();
            current.synced_at = hit.synced_at;
            if hit.created_at < db::now() - ROTATE_AFTER {
                let (old, uid) = (t.clone(), hit.user.id);
                // The stored pl8list session is encrypted for the old token; move it over.
                let reopened = hit.link.as_deref().and_then(|b| app.sync.key.sealer(&t, uid).open(b));
                let key = &app.sync.key;
                let synced = hit.synced_at;
                new_token = match app.db.call(move |c| db::rotate_session(c, &old, uid)).await {
                    Ok(nt) => {
                        if let Some(session) = reopened {
                            let new = key.sealer(&nt, uid);
                            let blob = new.seal(&session);
                            let old_hash = db::hash_token(&t);
                            let stored = blob.clone();
                            let _ = app
                                .db
                                .call(move |c| {
                                    db::set_link(c, &new.token_hash, &stored, synced)?;
                                    db::clear_link(c, &old_hash)
                                })
                                .await;
                            current.link = Some(blob);
                        } else {
                            current.link = None;
                        }
                        Some(nt)
                    }
                    Err(_) => None,
                };
            } else if legacy {
                new_token = Some(t.clone());
            }
            if let Some(nt) = new_token {
                set_cookie.push(app.cookies.set(SESSION_COOKIE, &nt, (db::SESSION_IDLE_DAYS * 86400.0) as i64));
                current.token = Some(nt);
            }
            current.user = Some(hit.user);
        }
        if legacy {
            set_cookie.push(app.cookies.clear_legacy(SESSION_COOKIE));
        }
    }
    req.extensions_mut().insert(current);
    let mut res = next.run(req).await;
    // Handlers that set the session cookie themselves (sign-in, sign-out) win.
    let handled = res.headers().get_all(header::SET_COOKIE).iter().any(|v| v.as_bytes().starts_with(format!("{name}=").as_bytes()));
    if !handled {
        for c in set_cookie {
            res.headers_mut().append(header::SET_COOKIE, c);
        }
    }
    res
}

/// POSTs must come from our own pages.
async fn origin_check(State(app): St, req: Request, next: Next) -> Response {
    if req.method() == Method::POST && !security::same_origin(req.headers(), app.cfg.public_origin.as_deref()) {
        return StatusCode::FORBIDDEN.into_response();
    }
    next.run(req).await
}

pub fn client_ip(app: &App, headers: &HeaderMap, peer: SocketAddr) -> String {
    security::ip_key(security::client_ip(headers, peer, app.cfg.proxy_hops))
}

pub type Peer = ConnectInfo<SocketAddr>;

// Static files ------------------------------------------------------------

/// The built front end (`web/`, `npm run build`). Hashed asset names, so they
/// can be cached for good; index.html and fixed-name files are revalidated.
#[derive(Embed)]
#[folder = "../web/dist/"]
struct Static;

fn content_type(path: &str) -> &'static str {
    match path.rsplit('.').next().unwrap_or_default() {
        "html" => "text/html; charset=utf-8",
        "js" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "png" => "image/png",
        "svg" => "image/svg+xml",
        "webmanifest" => "application/manifest+json",
        "txt" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

fn static_file(path: &str) -> Response {
    let cache = if path.starts_with("assets/") { "public, max-age=31536000, immutable" } else { "no-cache" };
    match Static::get(path) {
        Some(f) => ([(header::CONTENT_TYPE, content_type(path)), (header::CACHE_CONTROL, cache)], f.data).into_response(),
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

async fn index() -> Response {
    static_file("index.html")
}

async fn static_route(Path(path): Path<String>) -> Response {
    static_file(&path)
}

/// The service worker, at the root so its scope covers the whole app.
async fn service_worker() -> Response {
    static_file("sw.js")
}

async fn healthz() -> Response {
    (no_store(), Json(json!({ "ok": true }))).into_response()
}

// Router ------------------------------------------------------------------

pub fn router(app: Arc<App>) -> Router {
    let secure = app.cfg.secure;
    Router::new()
        .route("/", get(index))
        .route("/static/{*path}", get(static_route))
        .route("/sw.js", get(service_worker))
        .route("/healthz", get(healthz))
        .route("/impressum", get(legal::impressum))
        .route("/datenschutz", get(legal::datenschutz))
        .route("/privacy", get(legal::datenschutz))
        .route("/auth/start", post(auth::start))
        .route("/auth/resend", post(auth::resend))
        .route("/auth/verify", post(auth::verify))
        .route("/auth/logout", post(auth::logout))
        .route("/auth/guest", post(auth::guest))
        .route("/local/me", get(app::me))
        .route("/local/feed", get(app::feed))
        .route("/local/likes", get(app::likes))
        .route("/local/track", get(app::track))
        .route("/local/artist", get(app::artist))
        .route("/local/event", post(app::event))
        .route("/local/follow", post(app::follow))
        .route("/account/export", get(account::export))
        .route("/account/delete", post(account::delete))
        .route("/account/logout-all", post(account::logout_all))
        .route("/account/pl8list/sync", post(account::sync))
        .route("/account/pl8list/disconnect", post(account::disconnect))
        .route("/api/{handle}/{slug}/hls/playlist.m3u8", get(proxy::playlist))
        .route("/api/{handle}/{slug}/hls/segment/{n}", get(proxy::segment))
        .route("/img/{id}", get(proxy::image))
        .layer(middleware::from_fn_with_state(app.clone(), session))
        .layer(middleware::from_fn_with_state(app.clone(), origin_check))
        .layer(DefaultBodyLimit::max(4096))
        .layer(TimeoutLayer::with_status_code(StatusCode::REQUEST_TIMEOUT, Duration::from_secs(30)))
        .layer(GlobalConcurrencyLimitLayer::new(512))
        .layer(middleware::from_fn(move |req, next| security::headers(secure, req, next)))
        .with_state(app)
}
