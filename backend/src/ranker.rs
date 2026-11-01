//! Pick the next batch of tracks for the scroll feed.
//!
//! Each unserved playable track gets a score:
//!
//!     popularity   log-scaled saves/downloads/purchases/comments, normalised to 0..1
//!     freshness    exp(-age / 21 days)
//!     artist       learned from your events on that artist's tracks (likes, full listens, skips)
//!                  and whether you follow them
//!     tempo / key  closeness to the BPM and key of tracks you liked or finished
//!     related      track came from the "related" page of something you liked
//!     exploration  Gumbel noise, so the feed never freezes into one niche
//!
//! The batch is then picked greedily with a penalty for repeating an artist.
//! A `Ranker` supplies the weights and may narrow the candidates; discovery modes
//! are further `Ranker`s chosen with `?mode=`.

use std::collections::{HashMap, HashSet};

use rand::RngExt;
use rusqlite::{Connection, params_from_iter, types::Value as Sql};
use serde_json::{Value, json};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

use crate::db::Track;

pub struct Weights {
    pub popularity: f64,
    pub freshness: f64,
    pub artist: f64,
    pub tempo: f64,
    pub key: f64,
    pub related: f64,
    pub unknown_artist: f64,
    pub exploration: f64,
}

pub trait Ranker: Send + Sync {
    fn weights(&self) -> &Weights;
    /// Extra SQL condition on `tracks t`, for modes that only want part of the catalogue.
    fn condition(&self) -> Option<&str> {
        None
    }
}

/// The original mix.
pub struct Classic;

const CLASSIC: Weights = Weights {
    popularity: 1.2,
    freshness: 0.8,
    artist: 1.5,
    tempo: 1.0,
    key: 0.3,
    related: 1.0,
    unknown_artist: 0.2,
    exploration: 0.6,
};

impl Ranker for Classic {
    fn weights(&self) -> &Weights {
        &CLASSIC
    }
}

pub fn by_name(mode: Option<&str>) -> Option<&'static dyn Ranker> {
    match mode.unwrap_or("") {
        "" | "classic" => Some(&Classic),
        _ => None,
    }
}

/// Per-event contributions to artist affinity.
fn event_signal(kind: &str) -> f64 {
    match kind {
        "like" => 3.0,
        "unlike" => -3.0,
        "complete" => 1.5,
        "skip" => -1.0,
        "dislike" => -3.0,
        _ => 0.0,
    }
}
/// Following an artist (here or on pl8list) counts like a few likes of their tracks.
const FOLLOW_SIGNAL: f64 = 4.0;
const REPEAT_ARTIST_PENALTY: f64 = 1.5;
const RECENT_ARTIST_WINDOW: i64 = 6;

fn age_days(iso: Option<&str>) -> f64 {
    let Some(t) = iso.and_then(|s| OffsetDateTime::parse(s, &Rfc3339).ok()) else { return 365.0 };
    ((OffsetDateTime::now_utc() - t).as_seconds_f64() / 86400.0).max(0.0)
}

/// Gaussian closeness to any liked tempo, also counting half/double time as a match.
fn tempo_match(bpm: Option<f64>, liked: &[f64]) -> f64 {
    let Some(bpm) = bpm.filter(|b| *b > 0.0) else { return 0.0 };
    liked
        .iter()
        .map(|b| {
            let d = (bpm - b).abs().min((bpm * 2.0 - b).abs()).min((bpm / 2.0 - b).abs());
            (-(d / 6.0).powi(2)).exp()
        })
        .fold(0.0, f64::max)
}

pub struct Taste {
    pub artist: HashMap<String, f64>,
    pub bpms: Vec<f64>,
    pub keys: HashSet<String>,
    pub positive_ids: HashSet<i64>,
    pub liked_ids: Vec<i64>,
}

/// Summarise a user's listening history into artist affinity, liked tempos/keys and liked track ids.
pub fn taste(conn: &Connection, user_id: i64) -> rusqlite::Result<Taste> {
    let mut stmt = conn.prepare_cached(
        "SELECT e.track_id, e.kind, t.handle, t.bpm, t.key FROM events e JOIN tracks t ON t.id = e.track_id \
         WHERE e.user_id = ? AND e.kind IN ('like', 'unlike', 'complete', 'skip', 'dislike') ORDER BY e.ts",
    )?;
    let mut artist: HashMap<String, f64> = HashMap::new();
    // (track id, bpm, key), in the order they became positive.
    let mut liked: Vec<(i64, Option<f64>, Option<String>)> = vec![];
    let mut completed: Vec<(i64, Option<f64>, Option<String>)> = vec![];
    let rows = stmt.query_map([user_id], |r| {
        Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, Option<f64>>(3)?, r.get::<_, Option<String>>(4)?))
    })?;
    for row in rows {
        let (id, kind, handle, bpm, key) = row?;
        *artist.entry(handle).or_default() += event_signal(&kind);
        match kind.as_str() {
            "like" => {
                liked.retain(|l| l.0 != id);
                liked.push((id, bpm, key));
            }
            "unlike" => liked.retain(|l| l.0 != id),
            "complete" => {
                completed.retain(|l| l.0 != id);
                completed.push((id, bpm, key));
            }
            _ => {}
        }
    }
    for handle in crate::db::follows(conn, user_id)? {
        *artist.entry(handle).or_default() += FOLLOW_SIGNAL;
    }
    let liked_set: HashSet<i64> = liked.iter().map(|l| l.0).collect();
    let positive: Vec<_> = completed.iter().filter(|c| !liked_set.contains(&c.0)).chain(liked.iter()).collect();
    let bpms: Vec<f64> = positive.iter().filter_map(|p| p.1).collect();
    Ok(Taste {
        artist: artist.into_iter().map(|(h, v)| (h, (v / 4.0).tanh())).collect(),
        bpms: bpms[bpms.len().saturating_sub(50)..].to_vec(),
        keys: positive.iter().filter_map(|p| p.2.clone()).collect(),
        positive_ids: positive.iter().map(|p| p.0).collect(),
        liked_ids: liked.iter().rev().map(|l| l.0).collect(),
    })
}

#[derive(Default, Clone, Copy)]
pub struct Filters {
    pub free_only: bool,
    pub bpm_min: Option<f64>,
    pub bpm_max: Option<f64>,
}

pub fn pick(conn: &Connection, user_id: i64, n: usize, f: Filters, ranker: &dyn Ranker) -> rusqlite::Result<Vec<Value>> {
    let mut sql = String::from(
        "SELECT * FROM tracks t WHERE (t.full_access=1 OR t.preview_upload_id IS NOT NULL) \
         AND NOT EXISTS (SELECT 1 FROM events e WHERE e.user_id=? AND e.kind='served' AND e.track_id=t.id)",
    );
    let mut args = vec![Sql::Integer(user_id)];
    if f.free_only {
        sql.push_str(" AND t.price = 0");
    }
    if let Some(b) = f.bpm_min {
        sql.push_str(" AND t.bpm >= ?");
        args.push(Sql::Real(b));
    }
    if let Some(b) = f.bpm_max {
        sql.push_str(" AND t.bpm <= ?");
        args.push(Sql::Real(b));
    }
    if let Some(c) = ranker.condition() {
        sql.push_str(" AND (");
        sql.push_str(c);
        sql.push(')');
    }
    let cands: Vec<Track> = conn.prepare(&sql)?.query_map(params_from_iter(args), Track::from_row)?.collect::<Result<_, _>>()?;
    if cands.is_empty() {
        return Ok(vec![]);
    }

    let t = taste(conn, user_id)?;
    let recent: Vec<String> = conn
        .prepare_cached(
            "SELECT t.handle FROM events e JOIN tracks t ON t.id=e.track_id \
             WHERE e.user_id=? AND e.kind='served' ORDER BY e.ts DESC LIMIT ?",
        )?
        .query_map(rusqlite::params![user_id, RECENT_ARTIST_WINDOW], |r| r.get(0))?
        .collect::<Result<_, _>>()?;

    let pop_raw = |r: &Track| {
        (r.saves as f64).ln_1p() + 0.7 * (r.downloads as f64).ln_1p() + (r.purchases as f64).ln_1p()
            + 0.5 * (r.comments as f64).ln_1p()
    };
    let max_pop = cands.iter().map(pop_raw).fold(0.0, f64::max);
    let max_pop = if max_pop > 0.0 { max_pop } else { 1.0 };
    let w = ranker.weights();
    let mut rng = rand::rng();
    let mut scored: Vec<(f64, Track)> = cands
        .into_iter()
        .map(|r| {
            let aff = t.artist.get(&r.handle).copied();
            let u: f64 = rng.random::<f64>().max(1e-12);
            let s = w.popularity * pop_raw(&r) / max_pop
                + w.freshness * (-age_days(r.created_at.as_deref()) / 21.0).exp()
                + w.artist * aff.unwrap_or(0.0)
                + w.tempo * tempo_match(r.bpm, &t.bpms)
                + w.key * if r.key.as_ref().is_some_and(|k| t.keys.contains(k)) { 1.0 } else { 0.0 }
                + w.related * if r.related_of.is_some_and(|id| t.positive_ids.contains(&id)) { 1.0 } else { 0.0 }
                + w.unknown_artist * if aff.is_none() { 1.0 } else { 0.0 }
                + w.exploration * -(-u.ln()).ln();
            (s, r)
        })
        .collect();

    scored.sort_by(|a, b| b.0.total_cmp(&a.0));
    scored.truncate((n * 8).max(60));
    let mut seen = recent;
    let mut out = vec![];
    while !scored.is_empty() && out.len() < n {
        let penalised = |(s, r): &(f64, Track)| s - REPEAT_ARTIST_PENALTY * seen.iter().filter(|h| **h == r.handle).count() as f64;
        let best = (0..scored.len()).max_by(|&a, &b| penalised(&scored[a]).total_cmp(&penalised(&scored[b]))).unwrap_or(0);
        let (s, r) = scored.remove(best);
        seen.push(r.handle.clone());
        out.push(serialize(&r, Some(s)));
    }
    Ok(out)
}

pub fn serialize(r: &Track, score: Option<f64>) -> Value {
    let preview = !r.full_access;
    let wave = if preview && r.preview_waveform.is_some() { &r.preview_waveform } else { &r.waveform };
    let price = if r.price.fract() == 0.0 { json!(r.price as i64) } else { json!(r.price) };
    json!({
        "id": r.id,
        "handle": r.handle,
        "slug": r.slug,
        "title": r.title,
        "description": r.description,
        "artist_name": r.artist_name,
        "artist_img": r.artist_img,
        "artist_verified": r.artist_verified,
        "bpm": r.bpm,
        "key": r.key,
        "duration": if preview && r.preview_duration.is_some() { r.preview_duration } else { r.duration },
        "price": price,
        "created_at": r.created_at,
        "saves": r.saves,
        "downloads": r.downloads,
        "purchases": r.purchases,
        "comments": r.comments,
        "preview": preview,
        "upload_id": if preview { &r.preview_upload_id } else { &r.upload_id },
        "waveform": wave.as_deref().and_then(|w| serde_json::from_str::<Value>(w).ok()),
        "score": score.map(|s| (s * 1000.0).round() / 1000.0),
    })
}

/// Liked tracks, newest like first.
pub fn likes(conn: &Connection, user_id: i64) -> rusqlite::Result<Vec<Value>> {
    let ids = taste(conn, user_id)?.liked_ids;
    if ids.is_empty() {
        return Ok(vec![]);
    }
    let mut stmt = conn.prepare_cached("SELECT * FROM tracks WHERE id=?")?;
    let mut out = vec![];
    for id in ids {
        if let Some(t) = rusqlite::OptionalExtension::optional(stmt.query_row([id], Track::from_row))? {
            out.push(serialize(&t, None));
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tempo_counts_half_and_double_time() {
        assert!(tempo_match(Some(140.0), &[140.0]) > 0.99);
        assert!(tempo_match(Some(70.0), &[140.0]) > 0.99);
        assert!(tempo_match(Some(100.0), &[140.0]) < 0.01);
        assert_eq!(tempo_match(None, &[140.0]), 0.0);
    }

    #[test]
    fn unknown_dates_count_as_a_year_old() {
        assert_eq!(age_days(None), 365.0);
        assert_eq!(age_days(Some("garbage")), 365.0);
        assert!(age_days(Some("2020-01-01T00:00:00.000Z")) > 365.0);
    }
}
