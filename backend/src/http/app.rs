//! The feed, likes and listening events.

use std::{collections::HashMap, time::Duration};

use axum::{
    Extension, Json,
    extract::{Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde_json::{Value, json};
use tokio::time::Instant;

use super::{CurrentUser, Res, St, json_error, no_store};
use crate::{db, ranker};

const EVENT_KINDS: &[&str] = &["play", "like", "unlike", "skip", "complete", "dislike"];
/// On a cold start the crawler needs a few seconds before there is anything to serve.
const FEED_WAIT: Duration = Duration::from_secs(10);

pub async fn me(Extension(current): Extension<CurrentUser>) -> Response {
    match current.user {
        Some(u) => (no_store(), Json(json!({ "user": { "handle": u.handle, "name": u.name, "img": u.img } }))).into_response(),
        None => json_error(StatusCode::UNAUTHORIZED, "not signed in"),
    }
}

fn num(q: &HashMap<String, String>, name: &str) -> Option<f64> {
    q.get(name).and_then(|v| v.parse::<f64>().ok()).filter(|v| v.is_finite())
}

pub async fn feed(State(app): St, Extension(current): Extension<CurrentUser>, Query(q): Query<HashMap<String, String>>) -> Res {
    let user = match current.require() {
        Ok(u) => u.clone(),
        Err(r) => return Ok(r),
    };
    let Some(ranker) = ranker::by_name(q.get("mode").map(String::as_str)) else {
        return Ok(json_error(StatusCode::BAD_REQUEST, "unknown mode"));
    };
    let n = num(&q, "n").map(|n| n as usize).unwrap_or(10).clamp(1, 30);
    let filters = ranker::Filters {
        free_only: q.get("free").map(String::as_str) == Some("1"),
        bpm_min: num(&q, "bpm_min"),
        bpm_max: num(&q, "bpm_max"),
    };
    let deadline = Instant::now() + FEED_WAIT;
    let uid = user.id;
    let tracks = loop {
        let tracks = app.db.call(move |c| ranker::pick(c, uid, n, filters, ranker)).await?;
        if !tracks.is_empty() || Instant::now() >= deadline {
            break tracks;
        }
        tokio::time::sleep(Duration::from_millis(1500)).await;
    };
    let ids: Vec<i64> = tracks.iter().filter_map(|t| t["id"].as_i64()).collect();
    let stats = app
        .db
        .call(move |c| {
            for id in ids {
                db::add_event(c, uid, id, "served", None)?;
            }
            let mut s = db::stats(c, uid)?;
            s.liked = ranker::taste(c, uid)?.liked_ids.len();
            Ok(s)
        })
        .await?;
    Ok((no_store(), Json(json!({ "tracks": tracks, "stats": stats }))).into_response())
}

pub async fn likes(State(app): St, Extension(current): Extension<CurrentUser>) -> Res {
    let uid = match current.require() {
        Ok(u) => u.id,
        Err(r) => return Ok(r),
    };
    let tracks = app.db.call(move |c| ranker::likes(c, uid)).await?;
    Ok((no_store(), Json(json!({ "tracks": tracks }))).into_response())
}

pub async fn event(State(app): St, Extension(current): Extension<CurrentUser>, Json(body): Json<Value>) -> Res {
    let uid = match current.require() {
        Ok(u) => u.id,
        Err(r) => return Ok(r),
    };
    let track_id = body.get("track_id").and_then(|v| v.as_i64().or_else(|| v.as_str()?.parse().ok()));
    let kind = body.get("kind").and_then(Value::as_str).filter(|k| EVENT_KINDS.contains(k));
    let seconds = match body.get("seconds") {
        None | Some(Value::Null) => Some(None),
        Some(v) => v.as_f64().filter(|s| s.is_finite() && *s >= 0.0).map(Some),
    };
    let (Some(track_id), Some(kind), Some(seconds)) = (track_id, kind, seconds) else {
        return Ok(StatusCode::BAD_REQUEST.into_response());
    };
    if !app.limits.events.allow(&uid.to_string()) {
        return Ok(StatusCode::TOO_MANY_REQUESTS.into_response());
    }
    let kind = kind.to_string();
    let k = kind.clone();
    app.db.call(move |c| db::add_event(c, uid, track_id, &k, seconds)).await?;
    if kind == "like" || kind == "complete" {
        app.crawler.on_positive(track_id).await;
    }
    Ok((no_store(), Json(json!({ "ok": true }))).into_response())
}
