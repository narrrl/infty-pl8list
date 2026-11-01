//! Data export, account deletion and signing out everywhere (Art. 15, 17, 20 GDPR).

use axum::{
    Extension, Json,
    extract::State,
    http::{StatusCode, header},
    response::IntoResponse,
};
use serde_json::{Value, json};

use super::{CurrentUser, Res, St, auth::signed_out, json_error};
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
    app.db.call(move |c| db::delete_user(c, uid)).await?;
    tracing::info!("account deleted");
    Ok(signed_out(&app, json!({ "ok": true })))
}

pub async fn logout_all(State(app): St, Extension(current): Extension<CurrentUser>) -> Res {
    let uid = match current.require() {
        Ok(u) => u.id,
        Err(r) => return Ok(r),
    };
    app.db.call(move |c| db::delete_user_sessions(c, uid)).await?;
    Ok(signed_out(&app, json!({ "ok": true })))
}
