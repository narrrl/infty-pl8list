//! Data export, account deletion and signing out everywhere (Art. 15, 17, 20 GDPR),
//! plus the pl8list connection of this device.

use axum::{
    Extension, Json,
    extract::State,
    http::{StatusCode, header},
    response::IntoResponse,
};
use serde_json::{Value, json};

use super::{CurrentUser, Res, St, auth::signed_out, json_error, no_store};
use crate::db;

pub async fn export(State(app): St, Extension(current): Extension<CurrentUser>) -> Res {
    let user = match current.require() {
        Ok(u) => u.clone(),
        Err(r) => return Ok(r),
    };
    let uid = user.id;
    let data = app.db.call(move |c| db::export_user(c, uid)).await?;
    let body = serde_json::to_vec_pretty(&data)?;
    let safe: String = user.handle.chars().filter(|c| c.is_ascii_alphanumeric() || "_.-".contains(*c)).collect();
    let disposition = format!("attachment; filename=\"pl8inf-{safe}.json\"");
    Ok((
        [
            (header::CONTENT_TYPE, "application/json".to_string()),
            (header::CACHE_CONTROL, "no-store".to_string()),
            (header::CONTENT_DISPOSITION, disposition),
        ],
        body,
    )
        .into_response())
}

pub async fn delete(State(app): St, Extension(current): Extension<CurrentUser>, Json(body): Json<Value>) -> Res {
    let user = match current.require() {
        Ok(u) => u.clone(),
        Err(r) => return Ok(r),
    };
    if body.get("confirm").and_then(Value::as_str) != Some(&user.handle) {
        return Ok(json_error(StatusCode::BAD_REQUEST, "type your handle to confirm"));
    }
    let uid = user.id;
    // Other devices' stored sessions can't be opened without their cookies; deleting
    // the rows makes them unusable. This device's one is logged out at pl8list too.
    if let Some((_, session)) = app.connected(&current).await {
        app.pl8.logout(&session).await;
    }
    app.db.call(move |c| db::delete_user(c, uid)).await?;
    tracing::info!("account deleted");
    Ok(signed_out(&app, json!({ "ok": true })))
}

pub async fn logout_all(State(app): St, Extension(current): Extension<CurrentUser>) -> Res {
    let uid = match current.require() {
        Ok(u) => u.id,
        Err(r) => return Ok(r),
    };
    if let Some((_, session)) = app.connected(&current).await {
        app.pl8.logout(&session).await;
    }
    app.db.call(move |c| db::delete_user_sessions(c, uid)).await?;
    Ok(signed_out(&app, json!({ "ok": true })))
}

/// The resync button. A connected device syncs with its stored session; any other
/// device has to sign in with pl8list again (409 tells the page to show the sign-in).
pub async fn sync(State(app): St, Extension(current): Extension<CurrentUser>) -> Res {
    let uid = match current.require() {
        Ok(u) => u.id,
        Err(r) => return Ok(r),
    };
    let Some((sealer, session)) = app.connected(&current).await else {
        return Ok(json_error(StatusCode::CONFLICT, "sign in with pl8list again to sync"));
    };
    if !app.limits.resync.allow(&uid.to_string()) {
        return Ok(json_error(StatusCode::TOO_MANY_REQUESTS, "synced a moment ago, try again in two minutes"));
    }
    let started = app.sync.linked(sealer, session);
    Ok((no_store(), Json(json!({ "ok": true, "started": started }))).into_response())
}

/// Stop staying connected on this device: log the session out at pl8list and delete it.
pub async fn disconnect(State(app): St, Extension(current): Extension<CurrentUser>) -> Res {
    if let Err(r) = current.require() {
        return Ok(r);
    }
    if let Some((_, session)) = app.connected(&current).await {
        app.pl8.logout(&session).await;
    }
    if let Some(token) = current.token.clone() {
        app.db.call(move |c| db::clear_link(c, &db::hash_token(&token))).await?;
    }
    Ok((no_store(), Json(json!({ "ok": true }))).into_response())
}
