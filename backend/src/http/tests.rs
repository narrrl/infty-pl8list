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
use crate::{config::{Config, Legal}, crawler::Crawler, db::Db, link::LinkKey, pl8::Pl8};

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
        link_key: None,
        link_key_file: db_path.parent().unwrap().join("link.key"),
        pl8_base: pl8_base.into(),
        legal: Legal::default(),
    };
    let db = Db::open(&db_path).unwrap();
    let pl8 = Arc::new(Pl8::new(pl8_base, Duration::ZERO).unwrap());
    let crawler = Crawler::new(pl8.clone(), db.clone());
    let app = App::new(cfg, db, pl8, crawler, LinkKey::fixed(9));
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

async fn wait_for(pl8: &MockServer, what: impl Fn(&wiremock::Request) -> bool) -> bool {
    for _ in 0..50 {
        if pl8.received_requests().await.unwrap().iter().any(&what) {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    false
}

async fn sign_in(r: &Router, body: &str) -> (String, serde_json::Value) {
    let res = r.clone().oneshot(req("POST", "/auth/start", Some(r#"{"email":"a@b.de"}"#), None, "203.0.113.9")).await.unwrap();
    let login = cookie_pair(&set_cookies(&res), "__Host-pl8inf_login");
    let res = r.clone().oneshot(req("POST", "/auth/verify", Some(body), Some(&login), "203.0.113.9")).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let session = cookie_pair(&set_cookies(&res), "__Host-pl8inf");
    let bytes = axum::body::to_bytes(res.into_body(), 1 << 16).await.unwrap();
    (session, serde_json::from_slice(&bytes).unwrap())
}

async fn json_body(res: axum::response::Response) -> serde_json::Value {
    serde_json::from_slice(&axum::body::to_bytes(res.into_body(), 1 << 20).await.unwrap()).unwrap()
}

const REFRESHED: &str = "REFRESHED-PL8-SESSION-SECRET";

#[tokio::test]
async fn connected_device_syncs_library_and_pushes_likes_and_follows() {
    use wiremock::matchers::path_regex;
    let pl8 = fake_pl8list(0).await;
    // pl8list hands out a new cookie with the feed; later calls must use it.
    Mock::given(method("GET")).and(path("/api/feed"))
        .respond_with(ResponseTemplate::new(200).set_body_string(r#"{"tracks":[],"totalPages":1}"#)
            .insert_header("set-cookie", format!("_session={REFRESHED}; Max-Age=7776000; Path=/").as_str()))
        .with_priority(1)
        .mount(&pl8).await;
    Mock::given(method("GET")).and(path("/library/tracks")).and(query_param("_data", "routes/library.tracks"))
        .respond_with(ResponseTemplate::new(200).set_body_string(
            r#"{"items":[{"track":{"id":77,"slug":"song","title":"Song","user":{"handle":"artist1"}}}],"totalPages":1}"#))
        .mount(&pl8).await;
    Mock::given(method("GET")).and(path("/library/artists")).and(query_param("_data", "routes/library.artists"))
        .respond_with(ResponseTemplate::new(200).set_body_string(r#"{"items":[{"handle":"artist2"}],"totalPages":1}"#))
        .mount(&pl8).await;
    Mock::given(method("POST")).and(path_regex(r"^/api/.+/add-to-library$")).and(query_param("addOnly", "true"))
        .and(has_header("cookie", format!("_session={REFRESHED}").as_str()))
        .respond_with(ResponseTemplate::new(200).set_body_string(r#"{"success":true,"wasInLibrary":false}"#))
        .expect(2)
        .mount(&pl8).await;
    Mock::given(method("GET")).and(path("/logout"))
        .and(has_header("cookie", format!("_session={REFRESHED}").as_str()))
        .respond_with(ResponseTemplate::new(204))
        .expect(1)
        .mount(&pl8).await;
    let (r, app, db_path) = setup("connected", &pl8.uri()).await;

    let (session, body) = sign_in(&r, r#"{"code":"123456","connect":true}"#).await;
    assert_eq!(body["connected"], true);
    assert!(wait_for(&pl8, |q| q.url.path() == "/library/artists").await, "library not synced");
    tokio::time::sleep(Duration::from_millis(200)).await;

    let me = json_body(r.clone().oneshot(req("GET", "/local/me", None, Some(&session), "203.0.113.9")).await.unwrap()).await;
    assert_eq!(me["pl8list"]["connected"], true);
    // Saved tracks became likes, saved artists follows.
    let likes = json_body(r.clone().oneshot(req("GET", "/local/likes", None, Some(&session), "203.0.113.9")).await.unwrap()).await;
    assert_eq!(likes["tracks"][0]["id"], 77);
    let follows = app.db.call(|c| crate::db::follows(c, 42)).await.unwrap();
    assert!(follows.contains("artist2"));

    // The stored session is encrypted: neither cookie appears in the files.
    let raw = [std::fs::read(&db_path).unwrap(), std::fs::read(db_path.with_extension("db-wal")).unwrap_or_default()].concat();
    for secret in [LOGGED_IN, REFRESHED] {
        assert!(!raw.windows(secret.len()).any(|w| w == secret.as_bytes()), "{secret} stored in plain text");
    }

    let res = r.clone().oneshot(req("POST", "/local/event", Some(r#"{"track_id":77,"kind":"like"}"#), Some(&session), "203.0.113.9")).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let res = r.clone().oneshot(req("POST", "/local/follow", Some(r#"{"handle":"artist3","follow":true}"#), Some(&session), "203.0.113.9")).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    assert!(wait_for(&pl8, |q| q.url.path() == "/api/artist1/song/add-to-library").await);
    assert!(wait_for(&pl8, |q| q.url.path() == "/api/artist3/add-to-library").await);

    // Resync works once, then is rate limited.
    let res = r.clone().oneshot(req("POST", "/account/pl8list/sync", Some("{}"), Some(&session), "203.0.113.9")).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let res = r.clone().oneshot(req("POST", "/account/pl8list/sync", Some("{}"), Some(&session), "203.0.113.9")).await.unwrap();
    assert_eq!(res.status(), StatusCode::TOO_MANY_REQUESTS);
    tokio::time::sleep(Duration::from_millis(300)).await;

    let res = r.clone().oneshot(req("POST", "/account/pl8list/disconnect", Some("{}"), Some(&session), "203.0.113.9")).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let me = json_body(r.clone().oneshot(req("GET", "/local/me", None, Some(&session), "203.0.113.9")).await.unwrap()).await;
    assert_eq!(me["pl8list"]["connected"], false);
    let res = r.clone().oneshot(req("POST", "/account/pl8list/sync", Some("{}"), Some(&session), "203.0.113.9")).await.unwrap();
    assert_eq!(res.status(), StatusCode::CONFLICT);
    pl8.verify().await;
}

#[tokio::test]
async fn expired_pl8list_session_disconnects_the_device() {
    let pl8 = fake_pl8list(0).await;
    Mock::given(method("GET")).and(path("/api/feed"))
        .respond_with(ResponseTemplate::new(302).insert_header("location", "/login?continue=%2Fapi%2Ffeed"))
        .with_priority(1)
        .mount(&pl8).await;
    let (r, _app, _) = setup("expired", &pl8.uri()).await;
    let (session, _) = sign_in(&r, r#"{"code":"123456","connect":true}"#).await;
    let mut connected = true;
    for _ in 0..50 {
        let me = json_body(r.clone().oneshot(req("GET", "/local/me", None, Some(&session), "203.0.113.9")).await.unwrap()).await;
        connected = me["pl8list"]["connected"].as_bool().unwrap();
        if !connected {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(!connected, "expired session still stored");
}

#[tokio::test]
async fn token_rotation_keeps_the_pl8list_connection() {
    let (r, app, _) = setup("rotate", "http://127.0.0.1:9").await;
    let token = app
        .db
        .call(|c| {
            crate::db::upsert_user(c, 5, "tester", None, None)?;
            crate::db::create_session(c, 5)
        })
        .await
        .unwrap();
    let blob = app.sync.key.sealer(&token, 5).seal(&secrecy::SecretString::from("PL8".to_string()));
    let hash = crate::db::hash_token(&token);
    app.db
        .call(move |c| {
            crate::db::set_link(c, &hash, &blob, Some(crate::db::now()))?;
            c.execute("UPDATE sessions SET created_at = created_at - 8 * 86400", [])
        })
        .await
        .unwrap();
    let res = r.oneshot(req("GET", "/local/me", None, Some(&format!("__Host-pl8inf={token}")), "203.0.113.1")).await.unwrap();
    let new = cookie_pair(&set_cookies(&res), "__Host-pl8inf").trim_start_matches("__Host-pl8inf=").to_string();
    assert_ne!(new, token);
    assert_eq!(json_body(res).await["pl8list"]["connected"], true);
    let (new_hash, old_hash) = (crate::db::hash_token(&new), crate::db::hash_token(&token));
    let (new_blob, old_blob) = app
        .db
        .call(move |c| {
            let get = |h: &str| c.query_row("SELECT pl8_link FROM sessions WHERE token_hash=?", [h], |r| r.get::<_, Option<Vec<u8>>>(0));
            Ok((get(&new_hash)?, get(&old_hash)?))
        })
        .await
        .unwrap();
    use secrecy::ExposeSecret;
    assert_eq!(app.sync.key.sealer(&new, 5).open(&new_blob.unwrap()).unwrap().expose_secret(), "PL8");
    assert!(old_blob.is_none());
}
