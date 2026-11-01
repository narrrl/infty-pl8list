//! Tags for a track, read from its title, description, artist name and BPM.
//!
//! pl8list has no genre field, so this is keyword work. Producers name their files
//! after what they are ("… VIP", "… [DUBPACK]", "… (X FLIP) v2.wav"), which says a
//! lot about versions, and a little about style. Style tags are sparse: most riddim
//! is not called riddim. `ranker::tag_affinity` spreads them from tagged tracks to
//! their artists and the artists pl8list relates them to.
//!
//! Bump `VERSION` when the rules change; the catalogue is retagged on the next start.

pub const VERSION: i64 = 2;

fn words(text: &str) -> Vec<String> {
    text.split(|c: char| !c.is_alphanumeric())
        .filter(|w| !w.is_empty())
        .map(str::to_lowercase)
        .collect()
}

/// Tags of one track, sorted and without duplicates.
pub fn of(title: &str, description: Option<&str>, artist: &str, handle: &str, bpm: Option<f64>) -> Vec<&'static str> {
    let amp = title.contains(" & ");
    // File names: "x_y-z.wav" splits into words like any other title.
    let title = words(title);
    let mut text = title.clone();
    text.extend(words(description.unwrap_or("")));
    let has = |w: &str| text.iter().any(|t| t == w);
    let pair = |a: &[&str], b: &[&str]| text.windows(2).any(|p| a.contains(&p[0].as_str()) && b.contains(&p[1].as_str()));
    let triple = |a: &str, b: &[&str], c: &str| text.windows(3).any(|p| p[0] == a && b.contains(&p[1].as_str()) && p[2] == c);

    let dnb = has("dnb") || pair(&["drum"], &["bass"]) || triple("drum", &["and", "n"], "bass");

    let mut tags = vec![];
    let mut tag = |on: bool, t: &'static str| {
        if on {
            tags.push(t);
        }
    };

    let name = format!("{artist} {handle}").to_lowercase();
    tag(has("riddim") || has("riddims") || has("riddimz") || name.contains("riddim"), "riddim");
    tag(has("tearout") || pair(&["tear"], &["out"]), "tearout");
    tag(has("deathstep"), "deathstep");
    tag(has("brostep"), "brostep");
    tag(has("colourbass") || has("colorbass") || pair(&["colour", "color"], &["bass"]), "colourbass");
    tag(has("melodic"), "melodic");
    tag(has("wonk") || has("wonky"), "wonk");
    tag(has("halftime") || pair(&["half"], &["time"]), "halftime");
    tag(dnb, "dnb");
    tag(has("jungle"), "jungle");
    tag(has("garage") || has("ukg") || has("2step"), "garage");
    tag(has("grime"), "grime");
    tag(has("trap"), "trap");

    tag(has("vip"), "vip");
    tag(has("dubpack") || pair(&["dub"], &["pack"]), "dubpack");
    tag(has("dub") && !pair(&["dub"], &["pack"]), "dub");
    tag(has("remix") || has("rmx"), "remix");
    tag(has("flip"), "flip");
    tag(has("bootleg"), "bootleg");
    tag(has("edit"), "edit");
    tag(has("spesh") || has("special"), "special");
    let between = |w: &str| title.len() > 2 && title[1..title.len() - 1].iter().any(|t| t == w);
    tag(has("collab") || has("ft") || has("feat") || between("x") || between("vs") || amp && !dnb, "collab");
    tag(has("wip") || has("unfinished") || text.iter().any(|w| w.len() > 1 && w.starts_with('v') && w[1..].bytes().all(|b| b.is_ascii_digit())), "wip");

    if let Some(b) = bpm.filter(|b| *b > 0.0) {
        tag((138.0..=152.0).contains(&b) || (69.0..=76.0).contains(&b), "140");
        tag((165.0..=180.0).contains(&b) || (82.5..=90.0).contains(&b), "170");
    }
    tags.sort_unstable();
    tags.dedup();
    tags
}

#[cfg(test)]
mod tests {
    use super::*;

    fn t(title: &str) -> Vec<&'static str> {
        of(title, None, "Someone", "someone", None)
    }

    #[test]
    fn reads_versions_from_file_names() {
        assert_eq!(t("THRAX x JADHA - MR.WAYNE V1.wav"), ["collab", "wip"]);
        assert_eq!(t("4. VIRTU - GANG VIP [THE VAULT DUBPACK VOL. 1].wav"), ["dubpack", "vip"]);
        assert_eq!(t("KOH - FRACTURE [Cmadden SPESH].wav"), ["special"]);
        assert_eq!(t("MOTUS & LOWER - FEENZ"), ["collab"]);
        assert_eq!(t("LV VS 5CHIZO - HARDIONICFLOW.wav"), ["collab"]);
        assert_eq!(t("Drum & Bass Roller"), ["dnb"]);
        assert_eq!(t("Riddimo - Stacked Vip v1.mp3"), ["vip", "wip"]);
        assert_eq!(t("SOMETHING (DUB)"), ["dub"]);
        // Words inside other words do not count.
        assert_eq!(t("VIPER - EDITION X"), Vec::<&str>::new());
    }

    #[test]
    fn style_from_text_and_artist() {
        assert_eq!(of("Track", Some("#Khmer #DNB #174bpm"), "A", "a", Some(174.0)), ["170", "dnb"]);
        assert_eq!(of("Heavy one", None, "Riddim Lord", "lord", Some(70.0)), ["140", "riddim"]);
        assert_eq!(of("tear out weapon", Some("drum n bass"), "A", "a", None), ["dnb", "tearout"]);
        assert_eq!(of("x", None, "A", "a", Some(100.0)), Vec::<&str>::new());
    }
}
