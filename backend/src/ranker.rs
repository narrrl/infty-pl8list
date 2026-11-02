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
//! A `Ranker` supplies the weights, may narrow the candidates and may add a bonus.
//! Discovery modes (`Mode`) are further `Ranker`s chosen with `?mode=`.

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
    /// Drop candidates the SQL condition cannot express.
    fn keep(&self, _track: &Track) -> bool {
        true
    }
    /// Added to a candidate's score.
    fn bonus(&self, _track: &Track) -> f64 {
        0.0
    }
    /// Why a picked track is in this feed, sent along as `why`.
    fn reason(&self, _track: &Track) -> Option<Value> {
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

/// Discovery modes, chosen with `?mode=` (and `&artist=` for an artist radio).
#[derive(Clone, Debug, PartialEq)]
pub enum Mode {
    Classic,
    /// 140 BPM tracks, riddim first: tagged riddim, or by artists who make it or sit
    /// next to them in the artist graph.
    Riddim,
    /// Little-known tracks: popularity counts against a track.
    Deep,
    /// Uploads of the last few weeks.
    Fresh,
    /// "More like this artist": the artist and their neighbours in the artist graph.
    Artist(String),
}

impl Mode {
    pub fn parse(mode: Option<&str>, artist: Option<&str>) -> Option<Mode> {
        Some(match mode.unwrap_or("") {
            "" | "classic" => Mode::Classic,
            "riddim" => Mode::Riddim,
            "deep" => Mode::Deep,
            "fresh" => Mode::Fresh,
            "artist" => Mode::Artist(artist?.to_string()),
            _ => return None,
        })
    }

    pub fn ranker(&self, conn: &Connection) -> rusqlite::Result<Box<dyn Ranker>> {
        Ok(match self {
            Mode::Classic => Box::new(Classic),
            Mode::Riddim => Box::new(Riddim { affinity: tag_affinity(conn, "riddim")? }),
            Mode::Deep => Box::new(Deep),
            Mode::Fresh => Box::new(Fresh),
            Mode::Artist(h) => Box::new(ArtistRadio { seed: h.clone(), near: neighbourhood(conn, h)? }),
        })
    }
}

struct Riddim {
    affinity: HashMap<String, f64>,
}

const RIDDIM: Weights = Weights { popularity: 0.8, ..CLASSIC };

impl Ranker for Riddim {
    fn weights(&self) -> &Weights {
        &RIDDIM
    }
    fn condition(&self) -> Option<&str> {
        Some("EXISTS (SELECT 1 FROM track_tags g WHERE g.track_id = t.id AND g.tag = '140')")
    }
    fn bonus(&self, t: &Track) -> f64 {
        2.0 * self.affinity.get(&t.handle).copied().unwrap_or(0.0)
    }
}

struct Deep;

const DEEP: Weights = Weights {
    popularity: -0.8,
    freshness: 0.3,
    artist: 0.6,
    tempo: 1.0,
    key: 0.3,
    related: 0.5,
    unknown_artist: 1.0,
    exploration: 0.8,
};

impl Ranker for Deep {
    fn weights(&self) -> &Weights {
        &DEEP
    }
    fn condition(&self) -> Option<&str> {
        Some("t.saves <= 15")
    }
}

struct Fresh;

const FRESH: Weights = Weights { freshness: 3.0, popularity: 0.6, ..CLASSIC };

impl Ranker for Fresh {
    fn weights(&self) -> &Weights {
        &FRESH
    }
    // pl8list dates look like 2026-10-31T18:34:13.657Z, so they compare as text.
    fn condition(&self) -> Option<&str> {
        Some("t.created_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-45 days')")
    }
}

struct ArtistRadio {
    seed: String,
    near: HashMap<String, Near>,
}

const RADIO: Weights = Weights { artist: 0.5, related: 0.5, ..CLASSIC };

impl Ranker for ArtistRadio {
    fn weights(&self) -> &Weights {
        &RADIO
    }
    fn keep(&self, t: &Track) -> bool {
        t.handle == self.seed || self.near.contains_key(&t.handle)
    }
    // The artist themselves now and then; mostly the ones around them.
    fn bonus(&self, t: &Track) -> f64 {
        if t.handle == self.seed { 1.0 } else { 2.0 * self.near.get(&t.handle).map_or(0.0, |n| n.score) }
    }
    fn reason(&self, t: &Track) -> Option<Value> {
        if t.handle == self.seed {
            return Some(json!({ "kind": "seed" }));
        }
        Some(match &self.near.get(&t.handle)?.via {
            None => json!({ "kind": "related" }),
            Some(via) => json!({ "kind": "via", "handle": via }),
        })
    }
}

/// An artist near a radio's seed.
#[derive(Debug, PartialEq)]
pub struct Near {
    /// 0..1 by how closely linked.
    pub score: f64,
    /// For a second hop: the seed's neighbour that leads here.
    pub via: Option<String>,
}

/// Neighbours of an artist up to two hops away. A second-hop artist scores at most
/// 0.4 of the link that leads to it.
fn neighbourhood(conn: &Connection, seed: &str) -> rusqlite::Result<HashMap<String, Near>> {
    let first = scaled_neighbours(conn, seed)?;
    let mut near: HashMap<String, Near> = first.iter().map(|(h, w)| (h.clone(), Near { score: *w, via: None })).collect();
    for (h, w) in first.into_iter().take(10) {
        for (h2, w2) in scaled_neighbours(conn, &h)? {
            if h2 == seed {
                continue;
            }
            let score = 0.4 * w * w2;
            let n = near.entry(h2).or_insert(Near { score: 0.0, via: Some(h.clone()) });
            if n.via.is_some() && score > n.score {
                *n = Near { score, via: Some(h.clone()) };
            }
        }
    }
    Ok(near)
}

/// Direct neighbours of an artist, closest first, scored 0..1 against the closest.
pub fn scaled_neighbours(conn: &Connection, handle: &str) -> rusqlite::Result<Vec<(String, f64)>> {
    let links = crate::db::artist_neighbours(conn, handle)?;
    let max = links.iter().map(|l| l.1).max().unwrap_or(1).max(1) as f64;
    let mut out: Vec<(String, f64)> = links.into_iter().map(|(h, n)| (h, (n as f64 / max).sqrt())).collect();
    out.sort_by(|a, b| b.1.total_cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    Ok(out)
}

/// How strongly each artist is linked to `tag`, 0..1: their own tagged tracks (three
/// or more count fully), or half of what the artists next to them in the graph have.
pub fn tag_affinity(conn: &Connection, tag: &str) -> rusqlite::Result<HashMap<String, f64>> {
    let own: HashMap<String, f64> = crate::db::tag_counts(conn, tag)?.into_iter().map(|(h, n)| (h, (n as f64 / 3.0).min(1.0))).collect();
    let mut spread: HashMap<String, (f64, f64)> = HashMap::new();
    for (a, b, n) in crate::db::artist_links(conn)? {
        let n = n as f64;
        for (from, to) in [(&a, &b), (&b, &a)] {
            let e = spread.entry(to.clone()).or_default();
            e.0 += n * own.get(from).copied().unwrap_or(0.0);
            e.1 += n;
        }
    }
    let mut out = own;
    for (h, (sum, total)) in spread {
        let s = out.entry(h).or_default();
        *s = s.max(0.5 * sum / total);
    }
    out.retain(|_, v| *v > 0.0);
    Ok(out)
}

/// Per-event contributions to artist affinity.
fn event_signal(kind: &str) -> f64 {
    match kind {
        "like" => 3.0,
        "unlike" => -3.0,
        "complete" => 1.5,
        "skip" => -1.0,
        "dislike" => -3.0,
        // Taking a dislike back.
        "undislike" => 3.0,
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
         WHERE e.user_id = ? AND e.kind IN ('like', 'unlike', 'complete', 'skip', 'dislike', 'undislike') ORDER BY e.ts",
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

#[cfg(test)]
pub fn pick(conn: &Connection, user_id: i64, n: usize, f: Filters, ranker: &dyn Ranker) -> rusqlite::Result<Vec<Value>> {
    pick_with(conn, user_id, n, f, ranker, &taste(conn, user_id)?)
}

/// `pick` with the user's taste worked out already.
pub fn pick_with(conn: &Connection, user_id: i64, n: usize, f: Filters, ranker: &dyn Ranker, t: &Taste) -> rusqlite::Result<Vec<Value>> {
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
    let mut cands: Vec<Track> = conn.prepare(&sql)?.query_map(params_from_iter(args), Track::from_row)?.collect::<Result<_, _>>()?;
    cands.retain(|t| ranker.keep(t));
    if cands.is_empty() {
        return Ok(vec![]);
    }

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
                + w.exploration * -(-u.ln()).ln()
                + ranker.bonus(&r);
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
        let mut v = serialize(&r, Some(s));
        if let Some(why) = ranker.reason(&r) {
            v["why"] = why;
        }
        out.push(v);
    }
    add_tags(conn, &mut out)?;
    name_reasons(conn, &mut out)?;
    Ok(out)
}

/// Artist names for reasons that point at another artist.
fn name_reasons(conn: &Connection, tracks: &mut [Value]) -> rusqlite::Result<()> {
    for t in tracks {
        if let Some(h) = t["why"]["handle"].as_str().map(String::from) {
            t["why"]["name"] = json!(crate::db::artist(conn, &h)?.map_or(h, |a| a.name));
        }
    }
    Ok(())
}

fn add_tags(conn: &Connection, tracks: &mut [Value]) -> rusqlite::Result<()> {
    for t in tracks {
        if let Some(id) = t["id"].as_i64() {
            t["tags"] = json!(crate::db::track_tags(conn, id)?);
        }
    }
    Ok(())
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

/// One track by its pl8list path, for links into the app.
pub fn track_by_path(conn: &Connection, handle: &str, slug: &str) -> rusqlite::Result<Option<Value>> {
    let mut stmt = conn.prepare_cached("SELECT * FROM tracks WHERE handle=? AND slug=?")?;
    let Some(t) = rusqlite::OptionalExtension::optional(stmt.query_row([handle, slug], Track::from_row))? else {
        return Ok(None);
    };
    let mut out = vec![serialize(&t, None)];
    add_tags(conn, &mut out)?;
    Ok(out.pop())
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
    add_tags(conn, &mut out)?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::db;

    fn track(id: i64, handle: &str, title: &str, bpm: f64, saves: i64) -> Track {
        Track {
            id,
            handle: handle.into(),
            artist_name: handle.into(),
            slug: format!("s{id}"),
            title: title.into(),
            bpm: Some(bpm),
            saves,
            full_access: true,
            created_at: Some("2020-01-01T00:00:00.000Z".into()),
            ..Default::default()
        }
    }

    fn ids(conn: &Connection, mode: Mode, n: usize) -> Vec<i64> {
        let r = mode.ranker(conn).unwrap();
        let mut out: Vec<i64> = pick(conn, 1, n, Filters::default(), &*r).unwrap().iter().map(|t| t["id"].as_i64().unwrap()).collect();
        out.sort();
        out
    }

    #[test]
    fn riddim_mode_keeps_140_and_ranks_riddim_artists_and_their_neighbours_first() {
        let mut c = db::memory();
        let rows = [
            track(1, "rid", "Wobble riddim", 140.0, 0),
            track(2, "rid", "Other", 140.0, 0),
            track(3, "near", "Plain", 140.0, 0),
            track(4, "far", "Plain", 140.0, 500),
            track(5, "dnb", "Roller", 174.0, 900),
        ];
        db::upsert_tracks(&mut c, &rows, None).unwrap();
        db::add_related(&mut c, 3, &["rid".into()]).unwrap();
        let aff = tag_affinity(&c, "riddim").unwrap();
        assert!((aff["rid"] - 1.0 / 3.0).abs() < 1e-9);
        assert!(aff["near"] > 0.0 && aff["near"] < aff["rid"]);
        assert!(!aff.contains_key("far"));
        assert_eq!(ids(&c, Mode::Riddim, 10), [1, 2, 3, 4]);
        let r = Mode::Riddim.ranker(&c).unwrap();
        assert!(r.bonus(&rows[0]) > r.bonus(&rows[2]) && r.bonus(&rows[2]) > r.bonus(&rows[3]));
    }

    #[test]
    fn artist_radio_stays_near_the_artist() {
        let mut c = db::memory();
        let rows = [track(1, "a", "T", 140.0, 0), track(2, "b", "T", 140.0, 0), track(3, "c", "T", 140.0, 0), track(4, "z", "T", 140.0, 0)];
        db::upsert_tracks(&mut c, &rows, None).unwrap();
        db::add_related(&mut c, 1, &["b".into()]).unwrap();
        db::add_related(&mut c, 2, &["c".into()]).unwrap();
        let near = neighbourhood(&c, "a").unwrap();
        assert_eq!(near["b"], Near { score: 1.0, via: None });
        assert!((near["c"].score - 0.4).abs() < 1e-9);
        assert_eq!(near["c"].via.as_deref(), Some("b"));
        assert_eq!(ids(&c, Mode::Artist("a".into()), 10), [1, 2, 3]);
    }

    #[test]
    fn deep_and_fresh_narrow_the_catalogue() {
        let mut c = db::memory();
        let mut new = track(3, "c", "T", 140.0, 0);
        new.created_at = Some(c.query_row("SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 day')", [], |r| r.get(0)).unwrap());
        db::upsert_tracks(&mut c, &[track(1, "a", "T", 140.0, 2), track(2, "b", "T", 140.0, 400), new], None).unwrap();
        assert_eq!(ids(&c, Mode::Deep, 10), [1, 3]);
        assert_eq!(ids(&c, Mode::Fresh, 10), [3]);
        assert_eq!(ids(&c, Mode::Classic, 10), [1, 2, 3]);
    }

    #[test]
    fn modes_parse() {
        assert_eq!(Mode::parse(None, None), Some(Mode::Classic));
        assert_eq!(Mode::parse(Some("riddim"), None), Some(Mode::Riddim));
        assert_eq!(Mode::parse(Some("artist"), Some("x")), Some(Mode::Artist("x".into())));
        assert_eq!(Mode::parse(Some("artist"), None), None);
        assert_eq!(Mode::parse(Some("nope"), None), None);
    }

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
