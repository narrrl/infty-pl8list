//! Sync with a user's pl8list account.
//!
//! In: the personal feed (tracks of artists they follow), saved tracks (become likes
//! here) and saved artists (become follows). Out, only for devices that stay
//! connected: likes and follows made here are saved to their pl8list library.
//! Saving is add-only; nothing here ever removes anything from a pl8list account.
//!
//! Without "stay connected" a sign-in syncs once, then the session is logged out at
//! pl8list. With it, the session is stored encrypted (`link.rs`) and used again only
//! inside that device's own requests: a resync when the last one is older than
//! `RESYNC_AFTER`, the resync button, and pushing likes and follows.

use std::{
    collections::HashSet,
    sync::{Arc, Mutex},
    time::Duration,
};

use secrecy::SecretString;
use serde_json::Value;

use crate::{
    crawler::Crawler,
    db::{self, Db},
    link::{LinkKey, Sealer},
    pl8::{Pl8, SessionExpired, UserSession, normalize},
};

/// A connected device resyncs on use once its last sync is this old.
pub const RESYNC_AFTER: f64 = 6.0 * 3600.0;
const MAX_PAGES: i64 = 20;
const DEADLINE: Duration = Duration::from_secs(120);

pub struct Syncer {
    pl8: Arc<Pl8>,
    db: Db,
    crawler: Arc<Crawler>,
    pub key: LinkKey,
    /// Users with a sync running, so a burst of requests starts only one.
    running: Mutex<HashSet<i64>>,
}

/// What to do with the pl8list session once a task is done with it.
enum After {
    Logout,
    Store(Sealer),
}

fn text(v: &Value, k: &str) -> Option<String> {
    v.get(k).and_then(Value::as_str).filter(|s| !s.is_empty()).map(String::from)
}

/// Library items are `{track, ...}` like feed items; accept a bare track too.
fn library_track(item: &Value) -> Option<db::Track> {
    normalize::item(item).or_else(|| normalize::item(&serde_json::json!({ "track": item })))
}

fn library_artist(item: &Value) -> Option<String> {
    text(item, "handle")
        .or_else(|| item.get("user").and_then(|u| text(u, "handle")))
        .or_else(|| item.get("artist").and_then(|u| text(u, "handle")))
}

impl Syncer {
    pub fn new(pl8: Arc<Pl8>, db: Db, crawler: Arc<Crawler>, key: LinkKey) -> Arc<Self> {
        Arc::new(Syncer { pl8, db, crawler, key, running: Mutex::new(HashSet::new()) })
    }

    fn claim(&self, user_id: i64) -> bool {
        self.running.lock().unwrap_or_else(|e| e.into_inner()).insert(user_id)
    }

    fn release(&self, user_id: i64) {
        self.running.lock().unwrap_or_else(|e| e.into_inner()).remove(&user_id);
    }

    /// Sync once with a fresh sign-in session, then log it out at pl8list.
    pub fn once(self: &Arc<Self>, user_id: i64, session: SecretString) {
        self.spawn_sync(user_id, session, After::Logout);
    }

    /// Sync with a connected device's session. Returns false if one is already running.
    pub fn linked(self: &Arc<Self>, sealer: Sealer, session: SecretString) -> bool {
        self.spawn_sync(sealer.user_id, session, After::Store(sealer))
    }

    fn spawn_sync(self: &Arc<Self>, user_id: i64, session: SecretString, after: After) -> bool {
        if !self.claim(user_id) {
            if let After::Logout = after {
                // Never keep a one-time session around just because a sync is running.
                let pl8 = self.pl8.clone();
                tokio::spawn(async move { pl8.logout(&session).await });
            }
            return false;
        }
        let me = self.clone();
        tokio::spawn(async move {
            if let After::Store(sealer) = &after {
                let hash = sealer.token_hash.clone();
                if let Err(e) = me.db.call(move |c| db::mark_synced(c, &hash)).await {
                    tracing::warn!("marking sync: {e:#}");
                }
            }
            let mut s = UserSession::new(session);
            let res = tokio::time::timeout(DEADLINE, me.read_account(user_id, &mut s)).await;
            let expired = match &res {
                Ok(Ok((feed, likes, follows))) => {
                    tracing::info!("synced pl8list: {feed} feed pages, {likes} new likes, {follows} new follows");
                    false
                }
                Ok(Err(e)) => {
                    tracing::warn!("pl8list sync failed: {e:#}");
                    e.is::<SessionExpired>()
                }
                Err(_) => {
                    tracing::warn!("pl8list sync timed out");
                    false
                }
            };
            me.finish(s, after, expired).await;
            me.release(user_id);
        });
        true
    }

    /// Save a liked track to the user's pl8list library.
    pub fn push_like(self: &Arc<Self>, sealer: Sealer, session: SecretString, handle: String, slug: String) {
        let me = self.clone();
        tokio::spawn(async move {
            let mut s = UserSession::new(session);
            let res = me.pl8.save(&mut s, &[&handle, &slug]).await;
            me.after_push(s, sealer, res).await;
        });
    }

    /// Save a followed artist to the user's pl8list library.
    pub fn push_follow(self: &Arc<Self>, sealer: Sealer, session: SecretString, handle: String) {
        let me = self.clone();
        tokio::spawn(async move {
            let mut s = UserSession::new(session);
            let res = me.pl8.save(&mut s, &[&handle]).await;
            me.after_push(s, sealer, res).await;
        });
    }

    async fn after_push(&self, s: UserSession, sealer: Sealer, res: anyhow::Result<()>) {
        let expired = match &res {
            Ok(()) => false,
            Err(e) => {
                tracing::warn!("pl8list save failed: {e:#}");
                e.is::<SessionExpired>()
            }
        };
        self.finish(s, After::Store(sealer), expired).await;
    }

    /// Log a one-time session out, or store a refreshed cookie, or forget an expired one.
    async fn finish(&self, s: UserSession, after: After, expired: bool) {
        match after {
            After::Logout => {
                if !expired {
                    self.pl8.logout(s.cookie()).await;
                }
            }
            After::Store(sealer) => {
                let hash = sealer.token_hash.clone();
                let res = if expired {
                    tracing::info!("pl8list session expired, device disconnected");
                    self.db.call(move |c| db::clear_link(c, &hash)).await
                } else if s.changed {
                    let blob = sealer.seal(s.cookie());
                    self.db.call(move |c| db::set_link(c, &hash, &blob, None)).await
                } else {
                    Ok(())
                };
                if let Err(e) = res {
                    tracing::warn!("storing pl8list session: {e:#}");
                }
            }
        }
    }

    /// Feed, saved tracks and saved artists. Returns (feed pages, new likes, new follows).
    async fn read_account(&self, user_id: i64, s: &mut UserSession) -> anyhow::Result<(i64, usize, usize)> {
        let mut feed_pages = 0;
        for page in 1..=MAX_PAGES {
            let d = self.pl8.feed(s, page).await?.unwrap_or(Value::Null);
            let rows = normalize::items(d.get("tracks"));
            self.crawler.discovered_artists(rows.iter().map(|r| r.handle.clone()));
            self.db.call(move |c| db::upsert_tracks(c, &rows, None)).await?;
            feed_pages = page;
            if page >= d.get("totalPages").and_then(Value::as_i64).unwrap_or(0) {
                break;
            }
        }

        let mut likes = 0;
        for page in 1..=MAX_PAGES {
            let d = self.pl8.library_tracks(s, page).await?.unwrap_or(Value::Null);
            let rows: Vec<db::Track> =
                d.get("items").and_then(Value::as_array).map(|a| a.iter().filter_map(library_track).collect()).unwrap_or_default();
            let ids: Vec<i64> = rows.iter().map(|r| r.id).collect();
            self.crawler.discovered_artists(rows.iter().map(|r| r.handle.clone()));
            likes += self
                .db
                .call(move |c| {
                    db::upsert_tracks(c, &rows, None)?;
                    db::import_likes(c, user_id, &ids)
                })
                .await?;
            if page >= d.get("totalPages").and_then(Value::as_i64).unwrap_or(0) {
                break;
            }
        }

        let mut follows = 0;
        for page in 1..=MAX_PAGES {
            let d = self.pl8.library_artists(s, page).await?.unwrap_or(Value::Null);
            let handles: Vec<String> =
                d.get("items").and_then(Value::as_array).map(|a| a.iter().filter_map(library_artist).collect()).unwrap_or_default();
            self.crawler.discovered_artists(handles.clone());
            follows += self.db.call(move |c| db::add_follows(c, user_id, &handles, "pl8list")).await?;
            if page >= d.get("totalPages").and_then(Value::as_i64).unwrap_or(0) {
                break;
            }
        }
        Ok((feed_pages, likes, follows))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn library_items_in_either_shape() {
        let wrapped = json!({"track": {"id": 1, "slug": "s", "user": {"handle": "h"}}});
        let bare = json!({"id": 2, "slug": "s", "user": {"handle": "h"}});
        assert_eq!(library_track(&wrapped).unwrap().id, 1);
        assert_eq!(library_track(&bare).unwrap().id, 2);
        assert_eq!(library_artist(&json!({"handle": "a"})).as_deref(), Some("a"));
        assert_eq!(library_artist(&json!({"user": {"handle": "b"}})).as_deref(), Some("b"));
        assert_eq!(library_artist(&json!({"name": "c"})), None);
    }
}
