//! Flatten pl8list loader JSON into `tracks` rows.

use serde_json::Value;

use crate::db::Track;

#[derive(Default)]
struct Extra {
    full_access: bool,
    saves: i64,
    downloads: i64,
    purchases: i64,
    comments: i64,
}

fn int(v: Option<&Value>) -> i64 {
    v.and_then(|v| v.as_i64().or_else(|| v.as_f64().map(|f| f as i64))).unwrap_or(0)
}

fn text(t: &Value, key: &str) -> Option<String> {
    t.get(key).and_then(Value::as_str).filter(|s| !s.is_empty()).map(String::from)
}

fn num(t: &Value, key: &str) -> Option<f64> {
    t.get(key).and_then(Value::as_f64)
}

fn json_text(t: &Value, key: &str) -> Option<String> {
    t.get(key).filter(|v| !v.is_null() && v.as_array().is_none_or(|a| !a.is_empty())).map(Value::to_string)
}

/// A loader track item (`{track, hasFullAccess, saveCount, ...}`).
pub fn item(item: &Value) -> Option<Track> {
    track(item.get("track")?, Extra {
        full_access: item.get("hasFullAccess").and_then(Value::as_bool).unwrap_or(false),
        saves: int(item.get("saveCount")),
        downloads: int(item.get("downloadCount")),
        purchases: int(item.get("purchaseCount")),
        comments: int(item.get("commentCount")),
    })
}

pub fn items(list: Option<&Value>) -> Vec<Track> {
    list.and_then(Value::as_array).map(|a| a.iter().filter_map(item).collect()).unwrap_or_default()
}

/// The related loader returns bare tracks plus per-id maps for access and counts.
pub fn related(data: &Value) -> Vec<Track> {
    let counts = data.get("counts");
    let count = |name: &str, k: &str| int(counts.and_then(|c| c.get(name)).and_then(|m| m.get(k)));
    let Some(tracks) = data.get("tracks").and_then(Value::as_array) else { return vec![] };
    tracks
        .iter()
        .filter_map(|t| {
            let k = t.get("id")?.as_i64()?.to_string();
            track(t, Extra {
                full_access: data.get("access").and_then(|a| a.get(&k)).and_then(Value::as_bool).unwrap_or(false),
                saves: count("saveCount", &k),
                downloads: count("downloadCount", &k),
                purchases: count("purchaseCount", &k),
                comments: count("commentCount", &k),
            })
        })
        .collect()
}

fn track(t: &Value, extra: Extra) -> Option<Track> {
    let user = t.get("user")?;
    let handle = text(user, "handle")?;
    if t.get("isDeleted").and_then(Value::as_bool) == Some(true) || t.get("isPublic").and_then(Value::as_bool) == Some(false) {
        return None;
    }
    let slug = text(t, "slug")?;
    Some(Track {
        id: t.get("id")?.as_i64()?,
        artist_name: text(user, "name").unwrap_or_else(|| handle.clone()),
        artist_img: text(user, "img"),
        artist_verified: user.get("isVerified").and_then(Value::as_bool).unwrap_or(false),
        title: text(t, "title").or_else(|| text(t, "filename")).unwrap_or_else(|| slug.clone()),
        description: text(t, "description"),
        bpm: num(t, "bpm"),
        key: text(t, "key"),
        duration: num(t, "duration"),
        preview_duration: num(t, "previewDuration"),
        preview_start: num(t, "previewStart"),
        price: num(t, "price").unwrap_or(0.0),
        created_at: text(t, "createdAt"),
        upload_id: text(t, "uploadId"),
        preview_upload_id: text(t, "previewUploadId"),
        waveform: json_text(t, "waveform"),
        preview_waveform: json_text(t, "previewWaveform"),
        full_access: extra.full_access,
        saves: extra.saves,
        downloads: extra.downloads,
        purchases: extra.purchases,
        comments: extra.comments,
        related_of: None,
        handle,
        slug,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn item_flattens_and_skips_private() {
        let i = json!({
            "track": {"id": 5, "slug": "s", "title": "T", "price": 4.99, "bpm": 140,
                      "waveform": [1, 2], "user": {"handle": "h", "isVerified": true}},
            "hasFullAccess": false, "saveCount": 3
        });
        let t = item(&i).unwrap();
        assert_eq!((t.id, t.handle.as_str(), t.artist_name.as_str()), (5, "h", "h"));
        assert_eq!((t.price, t.bpm, t.saves), (4.99, Some(140.0), 3));
        assert_eq!(t.waveform.as_deref(), Some("[1,2]"));
        let private = json!({"track": {"id": 6, "slug": "s", "isPublic": false, "user": {"handle": "h"}}});
        assert!(item(&private).is_none());
    }

    #[test]
    fn related_reads_count_maps() {
        let d = json!({
            "tracks": [{"id": 9, "slug": "x", "user": {"handle": "a"}}],
            "access": {"9": true},
            "counts": {"saveCount": {"9": 4}}
        });
        let r = related(&d);
        assert_eq!(r.len(), 1);
        assert!(r[0].full_access);
        assert_eq!(r[0].saves, 4);
    }
}
