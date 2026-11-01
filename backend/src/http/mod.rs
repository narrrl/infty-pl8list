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

use crate::{
    cache::Cache,
    config::Config,
    crawler::Crawler,
    db::{self, Db, User},
    pl8::Pl8,
    ratelimit::RateLimiter,
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
}

pub struct App {
    pub cfg: Config,
    pub db: Db,
    pub pl8: Arc<Pl8>,
    pub crawler: Arc<Crawler>,
    pub cache: Cache,
    pub logins: auth::PendingLogins,
    pub limits: Limits,
    pub cookies: Cookies,
    pub segments: proxy::SegmentKeys,
    pub legal: legal::Pages,
}

pub type St = State<Arc<App>>;

impl App {
    pub fn new(cfg: Config, db: Db, pl8: Arc<Pl8>, crawler: Arc<Crawler>) -> Arc<Self> {
        let cache = Cache::open(cfg.cache_dir.clone(), cfg.cache_max_bytes);
        let legal = legal::Pages::render(&cfg.legal);
        Arc::new(App {
            cookies: Cookies { secure: cfg.secure },
            limits: Limits {
                login_ip: RateLimiter::new(5, 900),
                login_email: RateLimiter::new(3, 900),
                login_global: RateLimiter::new(30, 600),
                events: RateLimiter::new(600, 600),
                proxy: RateLimiter::new(1200, 60),
            },
            logins: auth::PendingLogins::default(),
            segments: proxy::SegmentKeys::default(),
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
        match self.db.call(|c| db::purge(c)).await {
            Ok((s, e)) if s + e > 0 => tracing::info!("purged {s} expired sessions, {e} old served events"),
            Ok(_) => {}
            Err(e) => tracing::warn!("purge failed: {e:#}"),
        }
        self.logins.prune();
        self.segments.prune();
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
    let mut current = CurrentUser { user: None, token: token.clone() };
    if let Some(t) = token {
        let lookup = t.clone();
        if let Ok(Some(hit)) = app.db.call(move |c| db::session_user(c, &lookup)).await {
            let mut new_token = None;
            if hit.created_at < db::now() - ROTATE_AFTER {
                let (old, uid) = (t.clone(), hit.user.id);
                new_token = app.db.call(move |c| db::rotate_session(c, &old, uid)).await.ok();
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

#[derive(Embed)]
#[folder = "../static/"]
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
    match Static::get(path) {
        Some(f) => ([(header::CONTENT_TYPE, content_type(path)), (header::CACHE_CONTROL, "no-cache")], f.data).into_response(),
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

async fn index() -> Response {
    static_file("index.html")
}

async fn static_route(Path(path): Path<String>) -> Response {
    static_file(&path)
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
        .route("/healthz", get(healthz))
        .route("/impressum", get(legal::impressum))
        .route("/datenschutz", get(legal::datenschutz))
        .route("/privacy", get(legal::datenschutz))
        .route("/auth/start", post(auth::start))
        .route("/auth/resend", post(auth::resend))
        .route("/auth/verify", post(auth::verify))
        .route("/auth/logout", post(auth::logout))
        .route("/local/me", get(app::me))
        .route("/local/feed", get(app::feed))
        .route("/local/likes", get(app::likes))
        .route("/local/event", post(app::event))
        .route("/account/export", get(account::export))
        .route("/account/delete", post(account::delete))
        .route("/account/logout-all", post(account::logout_all))
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
