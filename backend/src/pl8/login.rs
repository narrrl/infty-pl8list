//! pl8list's passwordless login: POST email, pl8list mails a 6-digit code, POST code.
//!
//! The site keeps the pending login in its `_session` cookie, so one flow holds that
//! cookie between the two steps. After `verify` succeeds the cookie is a fully
//! logged-in pl8list session. It is handed to the caller exactly once and is never
//! logged or kept in the flow; only an opted-in device stores it, encrypted
//! (see `link.rs`).

use base64::{
    Engine,
    alphabet,
    engine::{DecodePaddingMode, GeneralPurpose, GeneralPurposeConfig},
};
use percent_encoding::percent_decode_str;
use secrecy::{ExposeSecret, SecretString};
use serde_json::Value;

use super::{Pl8, UserSession};

#[derive(Debug)]
pub struct LoginError(pub String);

impl std::fmt::Display for LoginError {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

fn err(msg: impl Into<String>) -> LoginError {
    LoginError(msg.into())
}

/// The pl8list account that just signed in.
#[derive(Clone, Debug)]
pub struct Pl8User {
    pub id: i64,
    pub handle: String,
    pub name: Option<String>,
    pub img: Option<String>,
}

pub struct LoginFlow {
    pub email: String,
    session: Option<SecretString>,
}

struct Reply {
    status: u16,
    remix_redirect: Option<String>,
    payload: Option<Value>,
}

impl LoginFlow {
    pub fn new(email: String) -> Self {
        LoginFlow { email, session: None }
    }

    async fn call(&mut self, pl8: &Pl8, path: &str, query: &[(&str, &str)], route: &str, form: Option<&[(&str, &str)]>) -> Result<Reply, LoginError> {
        let mut url = pl8.url(&[path]);
        {
            let mut q = url.query_pairs_mut();
            for (k, v) in query {
                q.append_pair(k, v);
            }
            q.append_pair("_data", route);
        }
        let mut req = match form {
            Some(fields) => pl8.http().post(url).form(fields),
            None => pl8.http().get(url),
        };
        if let Some(s) = &self.session {
            req = req.header("Cookie", format!("_session={}", s.expose_secret()));
        }
        let res = req.send().await.map_err(|e| err(format!("pl8list unreachable: {}", e.without_url())))?;
        for c in res.headers().get_all("set-cookie") {
            if let Some(v) = c.to_str().ok().and_then(|c| c.strip_prefix("_session=")) {
                let v = v.split(';').next().unwrap_or_default();
                self.session = (!v.is_empty()).then(|| SecretString::from(v.to_string()));
            }
        }
        let status = res.status().as_u16();
        let remix_redirect = res.headers().get("x-remix-redirect").and_then(|v| v.to_str().ok()).map(String::from);
        let payload = res.bytes().await.ok().and_then(|b| serde_json::from_slice(&b).ok());
        Ok(Reply { status, remix_redirect, payload })
    }

    /// The guest id pl8list stores in its cookie; the login forms echo it back.
    fn guest_id(&self) -> String {
        let Some(s) = &self.session else { return String::new() };
        let raw = percent_decode_str(s.expose_secret()).decode_utf8_lossy();
        let first = raw.split('.').next().unwrap_or_default();
        let engine = GeneralPurpose::new(
            &alphabet::STANDARD,
            GeneralPurposeConfig::new().with_decode_padding_mode(DecodePaddingMode::Indifferent),
        );
        engine
            .decode(first)
            .ok()
            .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
            .and_then(|v| v.get("pl8list_guest_id").and_then(Value::as_str).map(String::from))
            .unwrap_or_default()
    }

    fn payload_str(reply: &Reply, key: &str) -> Option<String> {
        reply.payload.as_ref()?.get(key)?.as_str().map(String::from)
    }

    /// Ask pl8list to mail a login code.
    pub async fn start(&mut self, pl8: &Pl8) -> Result<(), LoginError> {
        self.call(pl8, "login", &[], "routes/login", None).await?;
        let guest = self.guest_id();
        let email = self.email.clone();
        let reply = self
            .call(pl8, "login", &[], "routes/login", Some(&[("email", &email), ("pl8list_guest_id", &guest)]))
            .await?;
        if !reply.remix_redirect.as_deref().unwrap_or_default().contains("/verify") {
            return Err(err(Self::payload_str(&reply, "error")
                .unwrap_or_else(|| format!("pl8list refused the login (HTTP {})", reply.status))));
        }
        Ok(())
    }

    pub async fn resend(&mut self, pl8: &Pl8) -> Result<(), LoginError> {
        let guest = self.guest_id();
        let email = self.email.clone();
        let query = [("email", email.as_str()), ("mode", "login")];
        let reply = self
            .call(pl8, "verify", &query, "routes/verify", Some(&[("action", "resend"), ("pl8list_guest_id", &guest)]))
            .await?;
        match Self::payload_str(&reply, "resendError") {
            Some(e) => Err(err(e)),
            None => Ok(()),
        }
    }

    /// Submit the code. On success returns the account and its logged-in pl8list session;
    /// the flow no longer holds the session afterwards.
    pub async fn verify(&mut self, pl8: &Pl8, code: &str) -> Result<(Pl8User, SecretString), LoginError> {
        let guest = self.guest_id();
        let email = self.email.clone();
        let query = [("email", email.as_str()), ("mode", "login")];
        let reply = self
            .call(pl8, "verify", &query, "routes/verify", Some(&[("action", "verify"), ("code", code), ("pl8list_guest_id", &guest)]))
            .await?;
        if let Some(e) = Self::payload_str(&reply, "error") {
            return Err(err(e));
        }
        let session = self.session.take().ok_or_else(|| err("login failed, try again"))?;
        let mut user_session = UserSession::new(session);
        let root = pl8.root(Some(&mut user_session)).await.ok().flatten();
        let session = user_session.into_cookie();
        let user = root.as_ref().and_then(|r| r.get("currentUser")).filter(|u| u.is_object());
        let Some(user) = user else {
            // Not logged in after all; nothing to end at pl8list.
            return Err(err("login failed, try again"));
        };
        let handle = user.get("handle").and_then(Value::as_str).filter(|h| !h.is_empty());
        let (Some(id), Some(handle)) = (user.get("id").and_then(Value::as_i64), handle) else {
            pl8.logout(&session).await;
            return Err(err("finish setting up your account on pl8list.com first (choose a handle)"));
        };
        let text = |k: &str| user.get(k).and_then(Value::as_str).map(String::from);
        Ok((Pl8User { id, handle: handle.to_string(), name: text("name"), img: text("img") }, session))
    }
}
