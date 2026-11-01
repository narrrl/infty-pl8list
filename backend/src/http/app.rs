//! The feed, likes, follows and listening events.

use std::{collections::HashMap, time::Duration};

use axum::{
    Extension, Json,
    extract::{Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde_json::{Value, json};
use tokio::time::Instant;

use super::{App, CurrentUser, Res, St, json_error, no_store};
use crate::{db, ranker, sync};

const EVENT_KINDS: &[&str] = &["play", "like", "unlike", "skip", "complete", "dislike"];
/// On a cold start the crawler needs a few seconds before there is anything to serve.
const FEED_WAIT: Duration = Duration::from_secs(10);

pub async fn me(Extension(current): Extension<CurrentUser>) -> Response {
    match current.user {
        Some(u) => (
            no_store(),
            Json(json!({
                "user": { "handle": u.handle, "name": u.name, "img": u.img },
                "pl8list": { "connected": current.link.is_some(), "synced_at": current.synced_at },
            })),
        )
            .into_response(),
        None => json_error(StatusCode::UNAUTHORIZED, "not signed in"),
    }
}

/// Mark tracks by artists the user follows.
async fn mark_followed(app: &App, uid: i64, tracks: &mut [Value]) -> anyhow::Result<()> {
    let follows = app.db.call(move |c| db::follows(c, uid)).await?;
    for t in tracks {
        let followed = t["handle"].as_str().is_some_and(|h| follows.contains(h));
        t["followed"] = json!(followed);
    }
    Ok(())
}

/// A connected device resyncs in the background once its last sync is old enough.
async fn resync_if_due(app: &App, current: &CurrentUser) {
    if current.link.is_none() || current.synced_at.is_some_and(|t| t > db::now() - sync::RESYNC_AFTER) {
        return;
    }
    if let Some((sealer, session)) = app.connected(current).await {
        app.sync.linked(sealer, session);
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
    let artist = q.get("artist").map(String::as_str).filter(|h| valid_handle(h));
    let Some(mode) = ranker::Mode::parse(q.get("mode").map(String::as_str), artist) else {
        return Ok(json_error(StatusCode::BAD_REQUEST, "unknown mode"));
    };
    // The artist graph is thin at first: crawl the radio's artist and their related pages.
    if let ranker::Mode::Artist(h) = &mode {
        app.crawler.explore_artist(h.clone()).await;
    }
    let n = num(&q, "n").map(|n| n as usize).unwrap_or(10).clamp(1, 30);
    let filters = ranker::Filters {
        free_only: q.get("free").map(String::as_str) == Some("1"),
        bpm_min: num(&q, "bpm_min"),
        bpm_max: num(&q, "bpm_max"),
    };
    resync_if_due(&app, &current).await;
    let deadline = Instant::now() + FEED_WAIT;
    let uid = user.id;
    let mut tracks = loop {
        let mode = mode.clone();
        let tracks = app.db.call(move |c| ranker::pick(c, uid, n, filters, &*mode.ranker(c)?)).await?;
        if !tracks.is_empty() || Instant::now() >= deadline {
            break tracks;
        }
        tokio::time::sleep(Duration::from_millis(1500)).await;
    };
    mark_followed(&app, uid, &mut tracks).await?;
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
    let mut tracks = app.db.call(move |c| ranker::likes(c, uid)).await?;
    mark_followed(&app, uid, &mut tracks).await?;
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
    if kind == "like" && app.limits.pl8_writes.allow(&uid.to_string()) {
        let row = app.db.call(move |c| db::track_path(c, track_id)).await?;
        if let (Some((handle, slug)), Some((sealer, session))) = (row, app.connected(&current).await) {
            app.sync.push_like(sealer, session, handle, slug);
        }
    }
    Ok((no_store(), Json(json!({ "ok": true }))).into_response())
}

/// Valid pl8list handles, as seen in every handle crawled so far.
fn valid_handle(h: &str) -> bool {
    (1..=64).contains(&h.len()) && h.bytes().all(|b| b.is_ascii_alphanumeric() || b"_.-".contains(&b)) && h != "." && h != ".."
}

/// Follow or unfollow an artist. Unfollowing only affects this app; on a connected
/// device a follow is also saved to the user's pl8list library.
pub async fn follow(State(app): St, Extension(current): Extension<CurrentUser>, Json(body): Json<Value>) -> Res {
    let uid = match current.require() {
        Ok(u) => u.id,
        Err(r) => return Ok(r),
    };
    let handle = body.get("handle").and_then(Value::as_str).filter(|h| valid_handle(h)).map(String::from);
    let on = body.get("follow").and_then(Value::as_bool);
    let (Some(handle), Some(on)) = (handle, on) else {
        return Ok(StatusCode::BAD_REQUEST.into_response());
    };
    if !app.limits.events.allow(&uid.to_string()) {
        return Ok(StatusCode::TOO_MANY_REQUESTS.into_response());
    }
    let h = handle.clone();
    let added = app
        .db
        .call(move |c| if on { db::add_follows(c, uid, &[h], "local") } else { db::unfollow(c, uid, &h).map(|_| 0) })
        .await?;
    if added > 0 {
        app.crawler.discovered_artists([handle.clone()]);
        if app.limits.pl8_writes.allow(&uid.to_string()) && let Some((sealer, session)) = app.connected(&current).await {
            app.sync.push_follow(sealer, session, handle);
        }
    }
    Ok((no_store(), Json(json!({ "ok": true, "followed": on }))).into_response())
}
