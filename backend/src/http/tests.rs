//! End-to-end tests of the HTTP API against a fake pl8list.

use std::{net::SocketAddr, path::PathBuf, sync::Arc, time::Duration};

use axum::{
    Router,
    body::Body,
    extract::ConnectInfo,
    http::{Request, StatusCode, header},
};
use base64::Engine;
use tower::ServiceExt;
use wiremock::{
    Mock, MockServer, ResponseTemplate,
    matchers::{body_string_contains, header as has_header, method, path, query_param},
};

use super::{App, router};
use crate::{config::{Config, Legal}, crawler::Crawler, db::Db, pl8::Pl8};

const LOGGED_IN: &str = "LOGGED-IN-PL8-SESSION-SECRET";

fn db_path(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("pl8inf-test-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir.join("test.db")
}

async fn setup(name: &str, pl8_base: &str) -> (Router, Arc<App>, PathBuf) {
    let db_path = db_path(name);
    let cfg = Config {
        host: "127.0.0.1".into(),
        port: 0,
        db_path: db_path.clone(),
        proxy_hops: 1,
        public_origin: Some("https://pl8.example".into()),
        secure: true,
        cache_dir: db_path.parent().unwrap().join("cache"),
        cache_max_bytes: 1 << 20,
        pl8_base: pl8_base.into(),
        legal: Legal::default(),
    };
    let db = Db::open(&db_path).unwrap();
    let pl8 = Arc::new(Pl8::new(pl8_base, Duration::ZERO).unwrap());
    let crawler = Crawler::new(pl8.clone(), db.clone());
    let app = App::new(cfg, db, pl8, crawler);
    (router(app.clone()), app, db_path)
}

fn req(method: &str, uri: &str, body: Option<&str>, cookie: Option<&str>, xff: &str) -> Request<Body> {
    let mut b = Request::builder()
        .method(method)
        .uri(uri)
        .header(header::HOST, "pl8.example")
        .header("x-forwarded-for", xff);
    if body.is_some() {
        b = b.header(header::CONTENT_TYPE, "application/json").header(header::ORIGIN, "https://pl8.example");
    }
    if let Some(c) = cookie {
        b = b.header(header::COOKIE, c);
    }
    let mut r = b.body(Body::from(body.unwrap_or_default().to_string())).unwrap();
    r.extensions_mut().insert(ConnectInfo(SocketAddr::from(([172, 18, 0, 2], 4000))));
    r
}

fn set_cookies(res: &axum::response::Response) -> Vec<String> {
    res.headers().get_all(header::SET_COOKIE).iter().map(|v| v.to_str().unwrap().to_string()).collect()
}

fn cookie_pair(cookies: &[String], name: &str) -> String {
    cookies.iter().find(|c| c.starts_with(&format!("{name}="))).unwrap().split(';').next().unwrap().to_string()
}

async fn fake_pl8list(logouts: u64) -> MockServer {
    let server = MockServer::start().await;
    let guest = base64::engine::general_purpose::STANDARD.encode(r#"{"pl8list_guest_id":"g-1"}"#);
    Mock::given(method("GET")).and(path("/login"))
        .respond_with(ResponseTemplate::new(200).insert_header("set-cookie", format!("_session={guest}.sig; Path=/; HttpOnly").as_str()))
        .mount(&server).await;
    Mock::given(method("POST")).and(path("/login")).and(body_string_contains("pl8list_guest_id=g-1"))
        .respond_with(ResponseTemplate::new(204).insert_header("x-remix-redirect", "/verify?email=a%40b.de&mode=login"))
        .mount(&server).await;
    Mock::given(method("POST")).and(path("/verify")).and(body_string_contains("code=000000"))
        .respond_with(ResponseTemplate::new(200).set_body_string(r#"{"error":"wrong code"}"#))
        .mount(&server).await;
    Mock::given(method("POST")).and(path("/verify")).and(body_string_contains("code=123456"))
        .respond_with(ResponseTemplate::new(200).set_body_string("{}")
            .insert_header("set-cookie", format!("_session={LOGGED_IN}; Path=/; HttpOnly").as_str()))
        .mount(&server).await;
    Mock::given(method("GET")).and(path("/")).and(query_param("_data", "root"))
        .and(has_header("cookie", format!("_session={LOGGED_IN}").as_str()))
        .respond_with(ResponseTemplate::new(200).set_body_string(r#"{"currentUser":{"id":42,"handle":"tester","name":"T"}}"#))
        .mount(&server).await;
    Mock::given(method("GET")).and(path("/api/feed"))
        .respond_with(ResponseTemplate::new(200).set_body_string(r#"{"tracks":[],"totalPages":1}"#))
        .mount(&server).await;
    Mock::given(method("GET")).and(path("/logout"))
        .and(has_header("cookie", format!("_session={LOGGED_IN}").as_str()))
        .respond_with(ResponseTemplate::new(204))
        .expect(logouts)
        .named("logout of the user's pl8list session")
        .mount(&server).await;
    server
}

#[tokio::test]
async fn login_logs_pl8list_session_out_and_never_stores_it() {
    let pl8 = fake_pl8list(1).await;
    let (r, _app, db_path) = setup("login", &pl8.uri()).await;

    let res = r.clone().oneshot(req("POST", "/auth/start", Some(r#"{"email":"A@b.de"}"#), None, "203.0.113.1")).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let login = cookie_pair(&set_cookies(&res), "__Host-pl8inf_login");

    let res = r.clone().oneshot(req("POST", "/auth/verify", Some(r#"{"code":"000000"}"#), Some(&login), "203.0.113.1")).await.unwrap();
    assert_eq!(res.status(), StatusCode::BAD_REQUEST);

    let res = r.clone().oneshot(req("POST", "/auth/verify", Some(r#"{"code":"123456"}"#), Some(&login), "203.0.113.1")).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let cookies = set_cookies(&res);
    assert!(cookies.iter().any(|c| c.starts_with("__Host-pl8inf=") && c.contains("Secure") && c.contains("HttpOnly")));
    let session = cookie_pair(&cookies, "__Host-pl8inf");

    let res = r.clone().oneshot(req("GET", "/local/me", None, Some(&session), "203.0.113.1")).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);

    // The feed crawl logs the pl8list session out in the background.
    for _ in 0..50 {
        let logged_out = pl8.received_requests().await.unwrap().iter().any(|q| q.url.path() == "/logout");
        if logged_out {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    pl8.verify().await;

    let raw = std::fs::read(&db_path).unwrap();
    let wal = std::fs::read(db_path.with_extension("db-wal")).unwrap_or_default();
    let needle = LOGGED_IN.as_bytes();
    assert!(!raw.windows(needle.len()).any(|w| w == needle), "pl8list session found in database file");
    assert!(!wal.windows(needle.len()).any(|w| w == needle), "pl8list session found in WAL");
    assert!(!raw.windows(5).any(|w| w == b"a@b.d") && !wal.windows(5).any(|w| w == b"a@b.d"), "email stored");
}

#[tokio::test]
async fn spoofed_forwarded_for_does_not_reset_ip_limit() {
    let pl8 = fake_pl8list(0).await;
    let (r, _app, _) = setup("xff", &pl8.uri()).await;
    let mut statuses = vec![];
    for i in 0..7 {
        let body = format!(r#"{{"email":"u{i}@b.de"}}"#);
        let xff = format!("6.6.6.{i}, 198.51.100.7");
        statuses.push(r.clone().oneshot(req("POST", "/auth/start", Some(&body), None, &xff)).await.unwrap().status());
    }
    assert_eq!(&statuses[..5], &[StatusCode::OK; 5]);
    assert_eq!(&statuses[5..], &[StatusCode::TOO_MANY_REQUESTS; 2]);
}

#[tokio::test]
async fn cross_site_posts_and_anonymous_reads_are_refused() {
    let (r, _app, _) = setup("csrf", "http://127.0.0.1:9").await;
    let mut cross = req("POST", "/auth/logout", Some("{}"), None, "203.0.113.1");
    cross.headers_mut().insert(header::ORIGIN, "https://evil.example".parse().unwrap());
    assert_eq!(r.clone().oneshot(cross).await.unwrap().status(), StatusCode::FORBIDDEN);

    for uri in ["/local/feed", "/local/likes", "/account/export", "/img/abc", "/api/a/b/hls/playlist.m3u8"] {
        let res = r.clone().oneshot(req("GET", uri, None, None, "203.0.113.1")).await.unwrap();
        assert_eq!(res.status(), StatusCode::UNAUTHORIZED, "{uri}");
    }
    let res = r.clone().oneshot(req("GET", "/", None, None, "203.0.113.1")).await.unwrap();
    let h = res.headers();
    assert!(h["content-security-policy"].to_str().unwrap().contains("script-src 'self';"));
    assert!(h.contains_key("strict-transport-security"));
    assert_eq!(h["cross-origin-opener-policy"], "same-origin");
}

#[tokio::test]
async fn delete_account_needs_handle_and_removes_data() {
    let (r, app, _) = setup("delete", "http://127.0.0.1:9").await;
    let token = app
        .db
        .call(|c| {
            crate::db::upsert_user(c, 5, "tester", None, None)?;
            crate::db::add_event(c, 5, 1, "like", None)?;
            crate::db::create_session(c, 5)
        })
        .await
        .unwrap();
    let cookie = format!("__Host-pl8inf={token}");
    let res = r.clone().oneshot(req("POST", "/account/delete", Some(r#"{"confirm":"nope"}"#), Some(&cookie), "203.0.113.1")).await.unwrap();
    assert_eq!(res.status(), StatusCode::BAD_REQUEST);
    let res = r.clone().oneshot(req("GET", "/account/export", None, Some(&cookie), "203.0.113.1")).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let res = r.clone().oneshot(req("POST", "/account/delete", Some(r#"{"confirm":"tester"}"#), Some(&cookie), "203.0.113.1")).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let left = app
        .db
        .call(|c| c.query_row("SELECT (SELECT COUNT(*) FROM users) + (SELECT COUNT(*) FROM sessions) + (SELECT COUNT(*) FROM events)", [], |r| r.get::<_, i64>(0)))
        .await
        .unwrap();
    assert_eq!(left, 0);
    let res = r.clone().oneshot(req("GET", "/local/me", None, Some(&cookie), "203.0.113.1")).await.unwrap();
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn legacy_cookie_moves_to_host_prefix() {
    let (r, app, _) = setup("legacy", "http://127.0.0.1:9").await;
    let token = app
        .db
        .call(|c| {
            crate::db::upsert_user(c, 5, "tester", None, None)?;
            crate::db::create_session(c, 5)
        })
        .await
        .unwrap();
    let res = r.oneshot(req("GET", "/local/me", None, Some(&format!("pl8inf={token}")), "203.0.113.1")).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let cookies = set_cookies(&res);
    assert!(cookies.iter().any(|c| c.starts_with(&format!("__Host-pl8inf={token};"))));
    assert!(cookies.iter().any(|c| c.starts_with("pl8inf=;") && c.contains("Max-Age=0")));
}
