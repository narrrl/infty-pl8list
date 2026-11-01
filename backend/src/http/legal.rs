//! Impressum (§ 5 DDG, § 18 MStV) and Datenschutzerklärung (Art. 13 GDPR).
//!
//! The texts live in `templates/`; operator details come from the environment so
//! they are not committed. Pages are rendered once at startup.

use axum::{
    http::header,
    response::{IntoResponse, Response},
};

use crate::config::Legal;

const IMPRESSUM: &str = include_str!("../../templates/impressum.html");
const DATENSCHUTZ: &str = include_str!("../../templates/datenschutz.html");
const UPDATED: &str = "1. November 2026";

pub struct Pages {
    impressum: String,
    datenschutz: String,
}

fn escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;").replace('\'', "&#39;")
}

fn lines(s: &str) -> String {
    s.lines().map(|l| escape(l.trim())).filter(|l| !l.is_empty()).collect::<Vec<_>>().join("<br>\n")
}

fn fill(template: &str, l: &Legal) -> String {
    let missing = "<strong>[nicht konfiguriert]</strong>";
    let or_missing = |v: String| if v.is_empty() { missing.to_string() } else { v };
    let email = if l.email.is_empty() {
        missing.to_string()
    } else {
        format!("<a href=\"mailto:{0}\">{0}</a>", escape(&l.email))
    };
    let phone = if l.phone.is_empty() { String::new() } else { format!("<br>\nTelefon: {}", escape(&l.phone)) };
    template
        .replace("{{name}}", &or_missing(escape(&l.name)))
        .replace("{{address}}", &or_missing(lines(&l.address)))
        .replace("{{email}}", &email)
        .replace("{{phone}}", &phone)
        .replace("{{hosting}}", &or_missing(lines(&l.hosting)))
        .replace("{{updated}}", UPDATED)
}

impl Pages {
    pub fn render(l: &Legal) -> Self {
        if !l.is_complete() {
            tracing::warn!("IMPRESSUM_NAME, IMPRESSUM_ADDRESS and IMPRESSUM_EMAIL are not all set; the Impressum is incomplete");
        }
        if l.hosting.is_empty() {
            tracing::warn!("HOSTING_PROVIDER is not set; the privacy policy names no hosting provider");
        }
        Pages { impressum: fill(IMPRESSUM, l), datenschutz: fill(DATENSCHUTZ, l) }
    }
}

fn html(body: String) -> Response {
    ([(header::CONTENT_TYPE, "text/html; charset=utf-8"), (header::CACHE_CONTROL, "no-cache")], body).into_response()
}

pub async fn impressum(axum::extract::State(app): super::St) -> Response {
    html(app.legal.impressum.clone())
}

pub async fn datenschutz(axum::extract::State(app): super::St) -> Response {
    html(app.legal.datenschutz.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn operator_details_are_escaped() {
        let l = Legal { name: "A <b>".into(), address: "Str. 1\n12345 Ort".into(), email: "a@b.de".into(), ..Default::default() };
        let p = Pages::render(&l);
        assert!(p.impressum.contains("A &lt;b&gt;"));
        assert!(p.impressum.contains("Str. 1<br>\n12345 Ort"));
        assert!(!p.impressum.contains("{{"));
        assert!(!p.datenschutz.contains("{{"));
    }
}
