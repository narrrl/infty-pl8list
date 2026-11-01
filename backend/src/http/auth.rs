//! Sign-in through pl8list: email, emailed 6-digit code, then our own session cookie.

use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU32, Ordering},
    },
    time::{Duration, Instant},
};

use axum::{
    Extension, Json,
    extract::State,
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
};
use serde_json::{Value, json};

use super::{App, CurrentUser, LOGIN_COOKIE, Peer, Res, SESSION_COOKIE, St, client_ip, json_error, no_store, security};
use crate::{db, pl8::login::LoginFlow};

const LOGIN_TTL: Duration = Duration::from_secs(900);
const MAX_PENDING: usize = 500;
const MAX_RESENDS: u32 = 2;
const MAX_CODE_ATTEMPTS: u32 = 5;
const TOO_MANY: &str = "too many attempts, wait a few minutes";

/// A login waiting for its emailed code, keyed by a random id in a short-lived cookie.
pub struct Pending {
    created: Instant,
    attempts: AtomicU32,
    resends: AtomicU32,
    /// Also serialises resend/verify calls of one login.
    flow: tokio::sync::Mutex<LoginFlow>,
}

#[derive(Default)]
pub struct PendingLogins(Mutex<HashMap<String, Arc<Pending>>>);

impl PendingLogins {
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, Arc<Pending>>> {
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Returns the new flow id, or `None` when too many logins are pending.
    fn add(&self, flow: LoginFlow) -> Option<(String, Arc<Pending>)> {
        let mut map = self.lock();
        map.retain(|_, p| p.created.elapsed() < LOGIN_TTL);
        if map.len() >= MAX_PENDING {
            return None;
        }
        let id = db::new_token();
        let p = Arc::new(Pending {
            created: Instant::now(),
            attempts: AtomicU32::new(0),
            resends: AtomicU32::new(0),
            flow: tokio::sync::Mutex::new(flow),
        });
        map.insert(id.clone(), p.clone());
        Some((id, p))
    }

    fn get(&self, id: Option<&str>) -> Option<Arc<Pending>> {
        let p = self.lock().get(id?).cloned()?;
        (p.created.elapsed() < LOGIN_TTL).then_some(p)
    }

    fn drop(&self, id: &str) {
        self.lock().remove(id);
    }

    pub fn prune(&self) {
        self.lock().retain(|_, p| p.created.elapsed() < LOGIN_TTL);
    }
}

fn valid_email(e: &str) -> bool {
    let Some((local, domain)) = e.split_once('@') else { return false };
    e.len() <= 254
        && (1..=64).contains(&local.len())
        && !domain.contains('@')
        && domain.split('.').count() >= 2
        && domain.split('.').all(|p| !p.is_empty())
        && !e.chars().any(|c| c.is_whitespace() || c.is_control())
}

fn str_field(body: &Value, key: &str) -> String {
    body.get(key).and_then(Value::as_str).unwrap_or_default().trim().to_string()
}

fn allow_login_mail(app: &App, ip: &str, email: &str) -> bool {
    app.limits.login_ip.allow(ip) && app.limits.login_email.allow(email) && app.limits.login_global.allow("")
}

pub async fn start(State(app): St, peer: Peer, headers: HeaderMap, Json(body): Json<Value>) -> Res {
    let email = str_field(&body, "email").to_lowercase();
    if !valid_email(&email) {
        return Ok(json_error(StatusCode::BAD_REQUEST, "enter a valid email"));
    }
    if !allow_login_mail(&app, &client_ip(&app, &headers, peer.0), &email) {
        return Ok(json_error(StatusCode::TOO_MANY_REQUESTS, TOO_MANY));
    }
    let Some((id, pending)) = app.logins.add(LoginFlow::new(email.clone())) else {
        return Ok(json_error(StatusCode::TOO_MANY_REQUESTS, "too many sign-ins right now, try again in a few minutes"));
    };
    if let Err(e) = pending.flow.lock().await.start(&app.pl8).await {
        app.logins.drop(&id);
        return Ok(json_error(StatusCode::BAD_REQUEST, &e.0));
    }
    let cookie = app.cookies.set(LOGIN_COOKIE, &id, LOGIN_TTL.as_secs() as i64);
    Ok(([(header::SET_COOKIE, cookie)], no_store(), Json(json!({ "ok": true, "email": email }))).into_response())
}

fn login_cookie<'a>(app: &App, headers: &'a HeaderMap) -> Option<&'a str> {
    security::cookie(headers, &app.cookies.name(LOGIN_COOKIE))
}

fn expired() -> Response {
    json_error(StatusCode::BAD_REQUEST, "login expired, start again")
}

pub async fn resend(State(app): St, peer: Peer, headers: HeaderMap) -> Res {
    let Some(pending) = app.logins.get(login_cookie(&app, &headers)) else { return Ok(expired()) };
    if pending.resends.fetch_add(1, Ordering::SeqCst) >= MAX_RESENDS {
        return Ok(json_error(StatusCode::TOO_MANY_REQUESTS, "no more resends, start again"));
    }
    let mut flow = pending.flow.lock().await;
    if !allow_login_mail(&app, &client_ip(&app, &headers, peer.0), &flow.email) {
        return Ok(json_error(StatusCode::TOO_MANY_REQUESTS, TOO_MANY));
    }
    if let Err(e) = flow.resend(&app.pl8).await {
        return Ok(json_error(StatusCode::BAD_REQUEST, &e.0));
    }
    Ok((no_store(), Json(json!({ "ok": true }))).into_response())
}

pub async fn verify(State(app): St, headers: HeaderMap, Json(body): Json<Value>) -> Res {
    let id = login_cookie(&app, &headers).map(String::from);
    let Some(pending) = app.logins.get(id.as_deref()) else { return Ok(expired()) };
    let id = id.unwrap_or_default();
    let code = str_field(&body, "code");
    if code.len() != 6 || !code.bytes().all(|b| b.is_ascii_digit()) {
        return Ok(json_error(StatusCode::BAD_REQUEST, "the code has 6 digits"));
    }
    if pending.attempts.fetch_add(1, Ordering::SeqCst) >= MAX_CODE_ATTEMPTS {
        app.logins.drop(&id);
        return Ok(json_error(StatusCode::TOO_MANY_REQUESTS, "too many wrong codes, start again"));
    }
    let result = pending.flow.lock().await.verify(&app.pl8, &code).await;
    let (user, pl8_session) = match result {
        Ok(ok) => ok,
        Err(e) => return Ok(json_error(StatusCode::BAD_REQUEST, &e.0)),
    };
    app.logins.drop(&id);
    // The pl8list session goes straight to the feed crawl, which logs it out afterwards.
    app.crawler.crawl_feed(pl8_session);
    let u = user.clone();
    let token = app
        .db
        .call(move |c| {
            db::upsert_user(c, u.id, &u.handle, u.name.as_deref(), u.img.as_deref())?;
            db::create_session(c, u.id)
        })
        .await?;
    tracing::info!("signed in: {}", user.handle);
    let mut res = (no_store(), Json(json!({ "user": { "handle": user.handle, "name": user.name } }))).into_response();
    let h = res.headers_mut();
    h.append(header::SET_COOKIE, app.cookies.set(SESSION_COOKIE, &token, (db::SESSION_IDLE_DAYS * 86400.0) as i64));
    h.append(header::SET_COOKIE, app.cookies.clear(LOGIN_COOKIE));
    Ok(res)
}

pub async fn logout(State(app): St, Extension(current): Extension<CurrentUser>) -> Res {
    if let Some(token) = current.token {
        app.db.call(move |c| db::delete_session(c, &token)).await?;
    }
    Ok(signed_out(&app, json!({ "ok": true })))
}

/// Response that removes the session cookie (and the Python version's one).
pub fn signed_out(app: &App, body: Value) -> Response {
    let mut res = (no_store(), Json(body)).into_response();
    res.headers_mut().append(header::SET_COOKIE, app.cookies.clear(SESSION_COOKIE));
    if app.cookies.secure {
        res.headers_mut().append(header::SET_COOKIE, app.cookies.clear_legacy(SESSION_COOKIE));
    }
    res
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn email_validation() {
        assert!(valid_email("a@b.co"));
        assert!(!valid_email("a@b"));
        assert!(!valid_email("a b@c.de"));
        assert!(!valid_email("@c.de"));
        assert!(!valid_email("a@@c.de"));
        assert!(!valid_email("a@c..de"));
        assert!(!valid_email(&format!("{}@c.de", "x".repeat(65))));
    }
}
