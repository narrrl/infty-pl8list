//! Background discovery crawler.
//!
//! There is no "all tracks" endpoint, so the pool grows by snowballing:
//! home page sections, the activity ticker, best-selling artists and user search
//! give us artists; artist pages give us their tracks; "related" pages of tracks
//! users liked or finished pull in neighbours. Everything goes through one priority
//! queue so feedback is crawled first.
//!
//! The catalogue is shared by all users and crawled as a guest. The crawler runs
//! at full pace only while someone has used the app recently.
//!
//! A user's pl8list session never enters the queue; account sync (`sync.rs`) reads
//! with it and only hands the artists it found to `discovered_artists`.

use std::{
    cmp::Reverse,
    collections::{BinaryHeap, HashMap, HashSet},
    sync::{Arc, Mutex},
    time::Duration,
};

use serde_json::Value;
use tokio::{sync::Notify, time::Instant};

use crate::{
    db::{self, Db},
    pl8::{Pl8, normalize},
};

/// Search needs at least 3 characters. Genre-ish words find lots of artist handles.
/// Riddim and its neighbours are searched first.
const STYLE_TERMS: &[&str] = &["riddim", "dubstep", "tearout", "dubz", "wonk", "deathstep", "brostep", "halftime", "140"];
const SEARCH_TERMS: &[&str] = &[
    "dub", "bass", "dnb", "jungle", "garage", "grime", "trap", "techno", "house", "beats", "music",
    "sound", "prod", "audio", "records", "drill", "breaks", "wave", "deep", "dark", "the",
    "official", "dj", "mc", "lofi", "neuro", "tek",
];

// Lower number = sooner.
const P_FEEDBACK: i64 = 0;
const P_SEED: i64 = 10;
const P_ARTIST_FIRST: i64 = 20;
const P_STYLE: i64 = 15;
const P_RELATED: i64 = 30;
const P_ARTIST_MORE: i64 = 40;
const P_SEARCH: i64 = 60;

const ACTIVE_WINDOW: f64 = 1800.0; // a user seen this recently counts as active
const IDLE_DELAY: Duration = Duration::from_secs(20); // extra wait between requests when nobody is active
const MIN_POOL: i64 = 500; // crawl at full pace until the catalogue has this many tracks
const REFRESH_AFTER: f64 = 86400.0; // re-check an artist's newest page for uploads this often
const RESEED_EVERY: Duration = Duration::from_secs(600);
/// An artist radio crawls its artist's neighbourhood at most this often.
const EXPLORE_EVERY: Duration = Duration::from_secs(600);
/// Jobs waiting at most. Past this only seed and feedback jobs get in, so nothing
/// from outside can grow the queue without end.
const MAX_QUEUE: usize = 20_000;
/// This many failed jobs in a row means pl8list is down or has changed its API.
const FAILURES_ALARM: u32 = 25;

#[derive(Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Debug)]
enum Job {
    Home,
    Ticker,
    BestArtists,
    Search(String),
    Artist(String),
    ArtistRefresh(String),
    Related(i64, String, String),
}

struct Queue {
    heap: BinaryHeap<Reverse<(i64, u64, Job)>>,
    queued: HashSet<Job>,
    seq: u64,
}

pub struct Crawler {
    pl8: Arc<Pl8>,
    db: Db,
    queue: Mutex<Queue>,
    wake: Notify,
    explored: Mutex<HashMap<String, Instant>>,
}

fn s(v: &Value, k: &str) -> Option<String> {
    v.get(k).and_then(Value::as_str).filter(|s| !s.is_empty()).map(String::from)
}

impl Crawler {
    pub fn new(pl8: Arc<Pl8>, db: Db) -> Arc<Self> {
        Arc::new(Crawler {
            pl8,
            db,
            queue: Mutex::new(Queue { heap: BinaryHeap::new(), queued: HashSet::new(), seq: 0 }),
            wake: Notify::new(),
            explored: Mutex::new(HashMap::new()),
        })
    }

    fn push(&self, priority: i64, job: Job) {
        let mut q = self.queue.lock().unwrap_or_else(|e| e.into_inner());
        if q.heap.len() >= MAX_QUEUE && priority > P_SEED {
            return;
        }
        if !q.queued.insert(job.clone()) {
            return;
        }
        q.seq += 1;
        let seq = q.seq;
        q.heap.push(Reverse((priority, seq, job)));
        drop(q);
        self.wake.notify_one();
    }

    fn try_pop(&self) -> Option<Job> {
        let mut q = self.queue.lock().unwrap_or_else(|e| e.into_inner());
        let Reverse((_, _, job)) = q.heap.pop()?;
        q.queued.remove(&job);
        Some(job)
    }

    async fn pop(&self) -> Job {
        loop {
            if let Some(job) = self.try_pop() {
                return job;
            }
            if tokio::time::timeout(Duration::from_secs(30), self.wake.notified()).await.is_err()
                && let Err(e) = self.refill().await {
                    tracing::warn!("crawler refill: {e:#}");
                }
        }
    }

    // Feedback hooks, called from the web server ----------------------------

    /// Liked or listened through: crawl its related tracks and its artist's catalogue.
    pub async fn on_positive(&self, track_id: i64) {
        let row = self
            .db
            .call(move |c| {
                rusqlite::OptionalExtension::optional(c.query_row(
                    "SELECT handle, slug FROM tracks WHERE id=?",
                    [track_id],
                    |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
                ))
            })
            .await;
        if let Ok(Some((handle, slug))) = row {
            self.push(P_FEEDBACK, Job::Related(track_id, handle.clone(), slug));
            self.push(P_FEEDBACK, Job::Artist(handle));
        }
    }

    /// Artists found in a user's pl8list feed or library: crawl them soon.
    pub fn discovered_artists(&self, handles: impl IntoIterator<Item = String>) {
        for h in handles {
            self.push(P_ARTIST_FIRST, Job::Artist(h));
        }
    }

    /// An artist radio was opened: crawl the artist, and the related pages of their
    /// best tracks that were not read yet, to fill in the artist graph around them.
    /// Only artists already in the catalogue: a handle typed into a URL queues nothing.
    pub async fn explore_artist(&self, handle: String) {
        let h = handle.clone();
        if !self.db.read(move |c| db::artist_known(c, &h)).await.unwrap_or(false) {
            return;
        }
        {
            let mut explored = self.explored.lock().unwrap_or_else(|e| e.into_inner());
            let now = Instant::now();
            explored.retain(|_, at| now.duration_since(*at) < EXPLORE_EVERY);
            if explored.insert(handle.clone(), now).is_some() {
                return;
            }
        }
        self.push(P_FEEDBACK, Job::Artist(handle.clone()));
        let h = handle.clone();
        let tracks = self
            .db
            .call(move |c| {
                c.prepare("SELECT id, slug FROM tracks WHERE handle=? AND related_fetched=0 ORDER BY saves + downloads DESC LIMIT 3")?
                    .query_map([&h], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))?
                    .collect::<Result<Vec<_>, _>>()
            })
            .await;
        for (id, slug) in tracks.unwrap_or_default() {
            self.push(P_FEEDBACK, Job::Related(id, handle.clone(), slug));
        }
    }

    // Main loop -------------------------------------------------------------

    pub fn start(self: &Arc<Self>) {
        let me = self.clone();
        tokio::spawn(async move { me.run().await });
    }

    async fn run(&self) {
        self.seed();
        let mut last_seed = Instant::now();
        let mut failures = 0u32;
        loop {
            let job = self.pop().await;
            match self.run_job(job.clone()).await {
                Ok(()) => {
                    if failures >= FAILURES_ALARM {
                        tracing::info!("crawler: pl8list answers again after {failures} failed jobs");
                    }
                    failures = 0;
                }
                Err(e) => {
                    tracing::warn!("crawl {job:?} failed: {e:#}");
                    failures += 1;
                    if failures == FAILURES_ALARM {
                        tracing::error!(
                            "crawler: {failures} jobs in a row failed. pl8list is down, or its routes changed \
                             (a move from Remix `?_data=` to React Router `.data` would look like this)"
                        );
                    }
                }
            }
            if !self.busy().await {
                tokio::time::sleep(IDLE_DELAY).await;
            }
            if last_seed.elapsed() > RESEED_EVERY {
                self.seed();
                last_seed = Instant::now();
            }
        }
    }

    /// Crawl at full pace while someone is listening or the catalogue is still small.
    async fn busy(&self) -> bool {
        self.db
            .call(|c| Ok(db::active_since(c, db::now() - ACTIVE_WINDOW)? > 0 || db::track_count(c)? < MIN_POOL))
            .await
            .unwrap_or(true)
    }

    fn seed(&self) {
        self.push(P_SEED, Job::Home);
        self.push(P_SEED, Job::Ticker);
        self.push(P_SEED, Job::BestArtists);
        for term in STYLE_TERMS {
            self.push(P_STYLE, Job::Search(term.to_string()));
        }
        for term in SEARCH_TERMS {
            self.push(P_SEARCH, Job::Search(term.to_string()));
        }
    }

    /// Queue ran dry: queue more artist pages, related lookups and stale artists.
    async fn refill(&self) -> anyhow::Result<()> {
        let (more, related, stale) = self
            .db
            .call(|c| {
                let col = |sql: &str, arg: Option<f64>| -> rusqlite::Result<Vec<String>> {
                    let mut st = c.prepare(sql)?;
                    
                    match arg {
                        Some(a) => st.query_map([a], |r| r.get(0))?.collect(),
                        None => st.query_map([], |r| r.get(0))?.collect(),
                    }
                };
                let more = col(
                    "SELECT handle FROM artists WHERE total_pages IS NULL OR pages_fetched < total_pages \
                     ORDER BY verified DESC, pages_fetched ASC LIMIT 20",
                    None,
                )?;
                let related: Vec<(i64, String, String)> = c
                    .prepare(
                        "SELECT id, handle, slug FROM tracks t WHERE related_fetched=0 ORDER BY \
                         EXISTS (SELECT 1 FROM track_tags g WHERE g.track_id = t.id AND g.tag = 'riddim') DESC, \
                         saves + downloads DESC LIMIT 10",
                    )?
                    .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
                    .collect::<Result<_, _>>()?;
                let stale = col(
                    "SELECT handle FROM artists WHERE pages_fetched > 0 AND last_crawled < ? \
                     ORDER BY last_crawled LIMIT 20",
                    Some(db::now() - REFRESH_AFTER),
                )?;
                Ok((more, related, stale))
            })
            .await?;
        for h in more {
            self.push(P_ARTIST_MORE, Job::Artist(h));
        }
        for (id, h, s) in related {
            self.push(P_RELATED, Job::Related(id, h, s));
        }
        for h in stale {
            self.push(P_ARTIST_MORE, Job::ArtistRefresh(h));
        }
        Ok(())
    }

    // Jobs ------------------------------------------------------------------

    async fn add_artist(&self, handle: String, source: &'static str, name: Option<String>, img: Option<String>, verified: bool, priority: i64) -> anyhow::Result<()> {
        let h = handle.clone();
        let known: Option<i64> = self
            .db
            .call(move |c| {
                let known = rusqlite::OptionalExtension::optional(c.query_row(
                    "SELECT pages_fetched FROM artists WHERE handle=?",
                    [&h],
                    |r| r.get::<_, Option<i64>>(0),
                ))?
                .flatten();
                db::upsert_artist(c, &h, name.as_deref(), img.as_deref(), verified, source)?;
                Ok(known)
            })
            .await?;
        if known.unwrap_or(0) == 0 {
            self.push(priority, Job::Artist(handle));
        }
        Ok(())
    }

    async fn upsert(&self, rows: Vec<db::Track>, related_of: Option<i64>) -> anyhow::Result<usize> {
        self.db.call(move |c| db::upsert_tracks(c, &rows, related_of)).await
    }

    async fn ticker_events(&self, events: Option<&Value>) -> anyhow::Result<()> {
        for e in events.and_then(Value::as_array).into_iter().flatten() {
            if let Some(h) = s(e, "artistHandle") {
                self.add_artist(h, "ticker", s(e, "artistName"), None, false, P_ARTIST_FIRST).await?;
            }
        }
        Ok(())
    }

    async fn run_job(&self, job: Job) -> anyhow::Result<()> {
        match job {
            Job::Home => {
                let d = self.pl8.home().await?.unwrap_or(Value::Null);
                let mut found = 0;
                for section in ["bestSellers", "recommended"] {
                    let rows = normalize::items(d.get(section).and_then(|s| s.get("items")));
                    found += rows.len();
                    self.upsert(rows, None).await?;
                }
                self.ticker_events(d.get("tickerEvents")).await?;
                // The home page always lists tracks; none means its shape changed.
                if found == 0 {
                    anyhow::bail!("home page has no tracks in bestSellers or recommended; did pl8list change its data?");
                }
                Ok(())
            }
            Job::Ticker => {
                let d = self.pl8.activity_ticker().await?.unwrap_or(Value::Null);
                self.ticker_events(d.get("events")).await
            }
            Job::BestArtists => {
                let d = self.pl8.best_selling_artists().await?.unwrap_or(Value::Null);
                for a in d.get("artists").and_then(Value::as_array).into_iter().flatten() {
                    if let Some(h) = s(a, "artist_handle") {
                        let verified = a.get("artist_isVerified").and_then(Value::as_bool).unwrap_or(false);
                        self.add_artist(h, "best_sellers", s(a, "artist_name"), s(a, "artist_img"), verified, P_SEED).await?;
                    }
                }
                self.upsert(normalize::items(d.get("recommended").and_then(|r| r.get("items"))), None).await?;
                Ok(())
            }
            Job::ArtistRefresh(handle) => {
                // Newest uploads are on page 1, so re-reading it catches new tracks.
                if let Some(d) = self.pl8.artist(&handle, 1).await? {
                    let new = self.upsert(normalize::items(d.get("tracks")), None).await?;
                    if new > 0 {
                        tracing::info!("artist {handle}: {new} new uploads");
                    }
                }
                self.db
                    .call(move |c| c.execute("UPDATE artists SET last_crawled=? WHERE handle=?", rusqlite::params![db::now(), handle]))
                    .await?;
                Ok(())
            }
            Job::Artist(handle) => self.artist_page(handle).await,
            Job::Related(track_id, handle, slug) => {
                let d = self.pl8.related(&handle, &slug).await?;
                self.db.call(move |c| c.execute("UPDATE tracks SET related_fetched=1 WHERE id=?", [track_id])).await?;
                let Some(d) = d else { return Ok(()) };
                let rows = normalize::related(&d);
                let artists: Vec<_> = rows.iter().map(|r| (r.handle.clone(), r.artist_name.clone(), r.artist_img.clone(), r.artist_verified)).collect();
                self.upsert(rows, Some(track_id)).await?;
                let handles: Vec<String> = artists.iter().map(|a| a.0.clone()).collect();
                self.db.call(move |c| db::add_related(c, track_id, &handles)).await?;
                for (h, name, img, verified) in artists {
                    self.add_artist(h, "related", Some(name), img, verified, P_RELATED).await?;
                }
                Ok(())
            }
            Job::Search(term) => self.search_page(term).await,
        }
    }

    async fn artist_page(&self, handle: String) -> anyhow::Result<()> {
        let h = handle.clone();
        let (fetched, total) = self
            .db
            .call(move |c| {
                Ok(rusqlite::OptionalExtension::optional(c.query_row(
                    "SELECT pages_fetched, total_pages FROM artists WHERE handle=?",
                    [&h],
                    |r| Ok((r.get::<_, Option<i64>>(0)?.unwrap_or(0), r.get::<_, Option<i64>>(1)?)),
                ))?
                .unwrap_or((0, None)))
            })
            .await?;
        if total.is_some_and(|t| fetched >= t) {
            return Ok(());
        }
        let page = fetched + 1;
        let h = handle.clone();
        let Some(d) = self.pl8.artist(&handle, page).await? else {
            self.db
                .call(move |c| c.execute("UPDATE artists SET total_pages=0, last_crawled=? WHERE handle=?", rusqlite::params![db::now(), h]))
                .await?;
            return Ok(());
        };
        let new = self.upsert(normalize::items(d.get("tracks")), None).await?;
        let total = d.get("totalPages").and_then(Value::as_i64).unwrap_or(0);
        self.db
            .call(move |c| {
                c.execute(
                    "UPDATE artists SET pages_fetched=?, total_pages=?, last_crawled=? WHERE handle=?",
                    rusqlite::params![page, total, db::now(), h],
                )
            })
            .await?;
        tracing::info!("artist {handle} page {page}/{total}: {new} new tracks");
        if page < total {
            self.push(P_ARTIST_MORE + page, Job::Artist(handle));
        }
        Ok(())
    }

    async fn search_page(&self, term: String) -> anyhow::Result<()> {
        let t = term.clone();
        let (fetched, total) = self
            .db
            .call(move |c| {
                Ok(rusqlite::OptionalExtension::optional(c.query_row(
                    "SELECT pages_fetched, total_pages FROM search_terms WHERE term=?",
                    [&t],
                    |r| Ok((r.get::<_, Option<i64>>(0)?.unwrap_or(0), r.get::<_, Option<i64>>(1)?)),
                ))?
                .unwrap_or((0, None)))
            })
            .await?;
        if total.is_some_and(|t| fetched >= t) {
            return Ok(());
        }
        let page = fetched + 1;
        let d = self.pl8.search_users(&term, page).await?.unwrap_or(Value::Null);
        for item in d.get("items").and_then(Value::as_array).into_iter().flatten() {
            let Some(a) = item.get("artist") else { continue };
            if let Some(h) = s(a, "handle") {
                let verified = a.get("isVerified").and_then(Value::as_bool).unwrap_or(false);
                let riddim = s(a, "name").into_iter().chain([h.clone()]).any(|n| n.to_lowercase().contains("riddim"));
                let prio = if verified || riddim { P_ARTIST_FIRST } else { P_SEARCH + 5 };
                self.add_artist(h, "search", s(a, "name"), s(a, "img"), verified, prio).await?;
            }
        }
        let total = d.get("totalPages").and_then(Value::as_i64).unwrap_or(0);
        let t = term.clone();
        self.db
            .call(move |c| {
                c.execute(
                    "INSERT INTO search_terms (term, pages_fetched, total_pages) VALUES (?,?,?) \
                     ON CONFLICT(term) DO UPDATE SET pages_fetched=excluded.pages_fetched, total_pages=excluded.total_pages",
                    rusqlite::params![t, page, total],
                )
            })
            .await?;
        if page < total {
            self.push(P_SEARCH + page, Job::Search(term));
        }
        Ok(())
    }
}
