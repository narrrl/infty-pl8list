//! End-to-end tests of the HTTP API against a fake pl8list.

use std::{collections::HashMap, net::SocketAddr, path::PathBuf, sync::Arc, time::Duration};

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
    known_track(&app, 78, "artist3").await;
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

#[tokio::test]
async fn feed_modes_filter_and_tag_tracks() {
    let (r, app, _) = setup("modes", "http://127.0.0.1:9").await;
    let token = app
        .db
        .call(|c| {
            let t = |id, title: &str, bpm| crate::db::Track {
                id,
                handle: "h".into(),
                artist_name: "H".into(),
                slug: format!("s{id}"),
                title: title.into(),
                bpm: Some(bpm),
                full_access: true,
                ..Default::default()
            };
            crate::db::upsert_tracks(c, &[t(1, "Riddim VIP", 140.0), t(2, "Roller", 174.0)], None)?;
            crate::db::upsert_user(c, 5, "tester", None, None)?;
            crate::db::create_session(c, 5)
        })
        .await
        .unwrap();
    let cookie = format!("__Host-pl8inf={token}");
    let get = |uri: &str| r.clone().oneshot(req("GET", uri, None, Some(&cookie), "203.0.113.1"));
    let res = get("/local/feed?mode=riddim").await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let body = json_body(res).await;
    let tracks = body["tracks"].as_array().unwrap();
    assert_eq!(tracks.len(), 1);
    assert_eq!(tracks[0]["tags"], serde_json::json!(["140", "riddim", "vip"]));
    for bad in ["/local/feed?mode=nope", "/local/feed?mode=artist", "/local/feed?mode=artist&artist=..%2Fx"] {
        assert_eq!(get(bad).await.unwrap().status(), StatusCode::BAD_REQUEST, "{bad}");
    }
    let res = get("/local/feed?mode=artist&artist=h").await.unwrap();
    assert_eq!(json_body(res).await["tracks"].as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn track_links_and_taking_a_dislike_back() {
    let (r, app, _) = setup("track", "http://127.0.0.1:9").await;
    let token = app
        .db
        .call(|c| {
            let t = crate::db::Track {
                id: 1,
                handle: "a".into(),
                artist_name: "A".into(),
                slug: "riddim-one".into(),
                title: "Riddim one".into(),
                bpm: Some(140.0),
                full_access: true,
                ..Default::default()
            };
            crate::db::upsert_tracks(c, &[t], None)?;
            crate::db::upsert_user(c, 5, "tester", None, None)?;
            crate::db::create_session(c, 5)
        })
        .await
        .unwrap();
    let cookie = format!("__Host-pl8inf={token}");
    let get = |uri: &str| r.clone().oneshot(req("GET", uri, None, Some(&cookie), "203.0.113.1"));
    let res = get("/local/track?handle=a&slug=riddim-one").await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let body = json_body(res).await;
    assert_eq!(body["track"]["id"], 1);
    assert_eq!(body["track"]["followed"], false);
    assert_eq!(get("/local/track?handle=a&slug=nope").await.unwrap().status(), StatusCode::NOT_FOUND);
    assert_eq!(get("/local/track?handle=a&slug=..").await.unwrap().status(), StatusCode::BAD_REQUEST);
    let anon = r.clone().oneshot(req("GET", "/local/track?handle=a&slug=riddim-one", None, None, "203.0.113.1")).await.unwrap();
    assert_eq!(anon.status(), StatusCode::UNAUTHORIZED);

    for kind in ["dislike", "undislike"] {
        let body = format!(r#"{{"track_id":1,"kind":"{kind}"}}"#);
        let res = r.clone().oneshot(req("POST", "/local/event", Some(&body), Some(&cookie), "203.0.113.1")).await.unwrap();
        assert_eq!(res.status(), StatusCode::OK, "{kind}");
    }
    let taste = app.db.call(|c| crate::ranker::taste(c, 5)).await.unwrap();
    assert_eq!(taste.artist.get("a").copied().unwrap_or(0.0), 0.0);
}

#[tokio::test]
async fn artist_sheet_and_radio_reasons() {
    let (r, app, _) = setup("radio", "http://127.0.0.1:9").await;
    let token = app
        .db
        .call(|c| {
            let t = |id, handle: &str, title: &str| crate::db::Track {
                id,
                handle: handle.into(),
                artist_name: handle.to_uppercase(),
                slug: format!("s{id}"),
                title: title.into(),
                bpm: Some(140.0),
                full_access: true,
                ..Default::default()
            };
            crate::db::upsert_tracks(c, &[t(1, "a", "Riddim one"), t(2, "b", "Two"), t(3, "c", "Three")], None)?;
            crate::db::add_related(c, 1, &["b".into()])?;
            crate::db::add_related(c, 2, &["c".into()])?;
            crate::db::upsert_user(c, 5, "tester", None, None)?;
            crate::db::create_session(c, 5)
        })
        .await
        .unwrap();
    let cookie = format!("__Host-pl8inf={token}");
    let get = |uri: &str| r.clone().oneshot(req("GET", uri, None, Some(&cookie), "203.0.113.1"));

    let res = get("/local/artist?handle=a").await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let body = json_body(res).await;
    assert_eq!(body["artist"]["name"], "A");
    assert_eq!(body["tags"], serde_json::json!(["riddim"]));
    assert_eq!(body["neighbours"][0]["handle"], "b");
    assert_eq!(body["exploring"], true);
    assert_eq!(get("/local/artist?handle=..").await.unwrap().status(), StatusCode::BAD_REQUEST);
    assert_eq!(get("/local/artist?handle=nobody").await.unwrap().status(), StatusCode::NOT_FOUND);

    let res = get("/local/feed?mode=artist&artist=a").await.unwrap();
    let body = json_body(res).await;
    let why: HashMap<i64, serde_json::Value> =
        body["tracks"].as_array().unwrap().iter().map(|t| (t["id"].as_i64().unwrap(), t["why"].clone())).collect();
    assert_eq!(why[&1], serde_json::json!({ "kind": "seed" }));
    assert_eq!(why[&2], serde_json::json!({ "kind": "related" }));
    assert_eq!(why[&3], serde_json::json!({ "kind": "via", "handle": "b", "name": "B" }));
}

/// A track (and so its artist) in the catalogue; events and follows only take known ones.
async fn known_track(app: &crate::http::App, id: i64, handle: &str) {
    let t = crate::db::Track { id, handle: handle.into(), artist_name: handle.into(), slug: format!("track-{id}"), title: "T".into(), ..Default::default() };
    app.db.call(move |c| crate::db::upsert_tracks(c, &[t], None)).await.unwrap();
}

#[tokio::test]
async fn guests_listen_and_keep_it_all_when_they_sign_in() {
    let pl8 = fake_pl8list(1).await;
    let (r, app, _) = setup("guest", &pl8.uri()).await;
    known_track(&app, 7, "motus").await;
    let res = r.clone().oneshot(req("POST", "/auth/guest", Some("{}"), None, "203.0.113.20")).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let guest = cookie_pair(&set_cookies(&res), "__Host-pl8inf");
    assert_eq!(json_body(res).await["user"]["guest"], true);
    let me = json_body(r.clone().oneshot(req("GET", "/local/me", None, Some(&guest), "203.0.113.20")).await.unwrap()).await;
    assert_eq!(me["user"]["guest"], true);
    for (uri, body) in [("/local/event", r#"{"track_id":7,"kind":"like"}"#), ("/local/follow", r#"{"handle":"motus","follow":true}"#)] {
        let res = r.clone().oneshot(req("POST", uri, Some(body), Some(&guest), "203.0.113.20")).await.unwrap();
        assert_eq!(res.status(), StatusCode::OK, "{uri}");
    }
    // Nothing the catalogue does not know.
    for (uri, body) in [("/local/event", r#"{"track_id":999,"kind":"like"}"#), ("/local/follow", r#"{"handle":"nobody-here","follow":true}"#)] {
        let res = r.clone().oneshot(req("POST", uri, Some(body), Some(&guest), "203.0.113.20")).await.unwrap();
        assert_eq!(res.status(), StatusCode::NOT_FOUND, "{uri}");
    }

    // Signing in on the same device takes the guest's likes and follows along.
    let res = r.clone().oneshot(req("POST", "/auth/start", Some(r#"{"email":"a@b.de"}"#), None, "203.0.113.20")).await.unwrap();
    let login = cookie_pair(&set_cookies(&res), "__Host-pl8inf_login");
    let both = format!("{login}; {guest}");
    let res = r.clone().oneshot(req("POST", "/auth/verify", Some(r#"{"code":"123456"}"#), Some(&both), "203.0.113.20")).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let (likes, follows, guests) = app
        .db
        .call(|c| {
            c.query_row(
                "SELECT (SELECT COUNT(*) FROM events WHERE user_id=42 AND kind='like' AND track_id=7), \
                 (SELECT COUNT(*) FROM follows WHERE user_id=42 AND handle='motus'), (SELECT COUNT(*) FROM users WHERE id < 0)",
                [],
                |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?, r.get::<_, i64>(2)?)),
            )
        })
        .await
        .unwrap();
    assert_eq!((likes, follows, guests), (1, 1, 0));
    let res = r.clone().oneshot(req("GET", "/local/me", None, Some(&guest), "203.0.113.20")).await.unwrap();
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
    // The one sync after signing in logs the pl8list session out in the background.
    assert!(wait_for(&pl8, |q| q.url.path() == "/logout").await);
}

#[tokio::test]
async fn guests_leave_nothing_behind_and_are_capped_per_ip() {
    let (r, app, _) = setup("guest-gone", "http://127.0.0.1:9").await;
    known_track(&app, 7, "motus").await;
    let res = r.clone().oneshot(req("POST", "/auth/guest", Some("{}"), None, "203.0.113.21")).await.unwrap();
    let guest = cookie_pair(&set_cookies(&res), "__Host-pl8inf");
    // A device with a session gets no second guest.
    let res = r.clone().oneshot(req("POST", "/auth/guest", Some("{}"), Some(&guest), "203.0.113.21")).await.unwrap();
    assert!(set_cookies(&res).is_empty());
    let res = r.clone().oneshot(req("POST", "/local/event", Some(r#"{"track_id":7,"kind":"like"}"#), Some(&guest), "203.0.113.21")).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let res = r.clone().oneshot(req("POST", "/auth/logout", Some("{}"), Some(&guest), "203.0.113.21")).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let count = "SELECT (SELECT COUNT(*) FROM users) + (SELECT COUNT(*) FROM sessions) + (SELECT COUNT(*) FROM events)";
    assert_eq!(app.db.call(move |c| c.query_row(count, [], |r| r.get::<_, i64>(0))).await.unwrap(), 0);

    // A guest whose session ran out is purged with what they did.
    let res = r.clone().oneshot(req("POST", "/auth/guest", Some("{}"), None, "203.0.113.21")).await.unwrap();
    let guest = cookie_pair(&set_cookies(&res), "__Host-pl8inf");
    r.clone().oneshot(req("POST", "/local/event", Some(r#"{"track_id":7,"kind":"play"}"#), Some(&guest), "203.0.113.21")).await.unwrap();
    app.db.call(|c| c.execute("UPDATE sessions SET expires_at=0", [])).await.unwrap();
    app.purge().await;
    assert_eq!(app.db.call(move |c| c.query_row(count, [], |r| r.get::<_, i64>(0))).await.unwrap(), 0);

    let mut statuses = vec![];
    for _ in 0..10 {
        statuses.push(r.clone().oneshot(req("POST", "/auth/guest", Some("{}"), None, "203.0.113.21")).await.unwrap().status());
    }
    assert_eq!(statuses.iter().filter(|s| **s == StatusCode::TOO_MANY_REQUESTS).count(), 2);
}

#[tokio::test]
async fn guest_staying_connected_saves_what_they_liked_to_pl8list() {
    let pl8 = fake_pl8list(0).await;
    let (r, app, _) = setup("guest-push", &pl8.uri()).await;
    known_track(&app, 7, "motus").await;
    let res = r.clone().oneshot(req("POST", "/auth/guest", Some("{}"), None, "203.0.113.22")).await.unwrap();
    let guest = cookie_pair(&set_cookies(&res), "__Host-pl8inf");
    for (uri, body) in [("/local/event", r#"{"track_id":7,"kind":"like"}"#), ("/local/follow", r#"{"handle":"motus","follow":true}"#)] {
        let res = r.clone().oneshot(req("POST", uri, Some(body), Some(&guest), "203.0.113.22")).await.unwrap();
        assert_eq!(res.status(), StatusCode::OK, "{uri}");
    }
    let res = r.clone().oneshot(req("POST", "/auth/start", Some(r#"{"email":"a@b.de"}"#), None, "203.0.113.22")).await.unwrap();
    let login = cookie_pair(&set_cookies(&res), "__Host-pl8inf_login");
    let both = format!("{login}; {guest}");
    let res = r.clone().oneshot(req("POST", "/auth/verify", Some(r#"{"code":"123456","connect":true}"#), Some(&both), "203.0.113.22")).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    assert!(wait_for(&pl8, |q| q.url.path() == "/api/motus/add-to-library").await, "follow not saved");
    assert!(wait_for(&pl8, |q| q.url.path() == "/api/motus/track-7/add-to-library").await, "like not saved");
}

#[tokio::test]
async fn radio_of_an_unknown_artist_is_not_found() {
    let (r, _app, _) = setup("explore-unknown", "http://127.0.0.1:9").await;
    let res = r.clone().oneshot(req("POST", "/auth/guest", Some("{}"), None, "203.0.113.23")).await.unwrap();
    let guest = cookie_pair(&set_cookies(&res), "__Host-pl8inf");
    let res = r.clone().oneshot(req("GET", "/local/artist?handle=made-up-handle", None, Some(&guest), "203.0.113.23")).await.unwrap();
    assert_eq!(res.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn comments_come_sorted_by_moment_and_cached() {
    let pl8 = MockServer::start().await;
    let page = |n: i64, at: f64| {
        serde_json::json!({ "totalPages": 2, "comments": [
            { "id": n, "body": format!("c{n}"), "timestampSeconds": at, "user": { "handle": "h", "name": "H" } }
        ]})
    };
    for (n, at) in [(1, 30.0), (2, 10.0)] {
        Mock::given(method("GET")).and(path("/api/a/track-1/comments")).and(query_param("page", n.to_string()))
            .respond_with(ResponseTemplate::new(200).set_body_json(page(n, at)))
            .expect(1)
            .mount(&pl8).await;
    }
    let (r, app, _) = setup("comments", &pl8.uri()).await;
    known_track(&app, 1, "a").await;
    let token = app.db.call(|c| { crate::db::upsert_user(c, 5, "tester", None, None)?; crate::db::create_session(c, 5) }).await.unwrap();
    let cookie = format!("__Host-pl8inf={token}");
    let get = |uri: &str| r.clone().oneshot(req("GET", uri, None, Some(&cookie), "203.0.113.1"));
    for _ in 0..2 {
        let res = get("/local/comments?id=1").await.unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let body = json_body(res).await;
        let ids: Vec<i64> = body["comments"].as_array().unwrap().iter().map(|c| c["id"].as_i64().unwrap()).collect();
        assert_eq!(ids, [2, 1]);
    }
    assert_eq!(get("/local/comments?id=99").await.unwrap().status(), StatusCode::NOT_FOUND);
    assert_eq!(get("/local/comments?id=x").await.unwrap().status(), StatusCode::BAD_REQUEST);
}
