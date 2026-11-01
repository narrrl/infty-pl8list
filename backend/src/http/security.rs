//! Client address, Origin check, cookies and response headers.

use std::net::{IpAddr, SocketAddr};

use axum::{
    extract::Request,
    http::{HeaderMap, HeaderValue, header},
    middleware::Next,
    response::Response,
};

/// The address rate limits use.
///
/// Each trusted proxy appends the address it saw to `X-Forwarded-For`, so with
/// `hops` proxies the client is the `hops`-th entry from the right. Everything to
/// the left of it was written by the client and is ignored.
pub fn client_ip(headers: &HeaderMap, peer: SocketAddr, hops: usize) -> IpAddr {
    if hops == 0 {
        return peer.ip();
    }
    let entries: Vec<&str> = headers
        .get_all("x-forwarded-for")
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(','))
        .map(str::trim)
        .collect();
    entries
        .len()
        .checked_sub(hops)
        .and_then(|i| entries[i].parse().ok())
        .unwrap_or(peer.ip())
}

/// Rate-limit key for an address. IPv6 users usually get a whole /64, so limit by that.
pub fn ip_key(ip: IpAddr) -> String {
    match ip {
        IpAddr::V4(v4) => v4.to_string(),
        IpAddr::V6(v6) => match v6.to_ipv4_mapped() {
            Some(v4) => v4.to_string(),
            None => {
                let s = v6.segments();
                format!("{:x}:{:x}:{:x}:{:x}::/64", s[0], s[1], s[2], s[3])
            }
        },
    }
}

/// Reject cross-site POSTs. Browsers send Origin on every POST and Sec-Fetch-Site
/// on every request; either one pointing elsewhere is enough to refuse.
pub fn same_origin(headers: &HeaderMap, public_origin: Option<&str>) -> bool {
    if let Some(site) = headers.get("sec-fetch-site").and_then(|v| v.to_str().ok())
        && site != "same-origin" && site != "none" {
            return false;
        }
    let Some(origin) = headers.get(header::ORIGIN).and_then(|v| v.to_str().ok()) else { return true };
    match public_origin {
        Some(expected) => origin == expected,
        None => {
            let host = headers.get(header::HOST).and_then(|v| v.to_str().ok()).unwrap_or_default();
            origin.split_once("://").map(|(_, h)| h) == Some(host)
        }
    }
}

pub fn cookie<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(';'))
        .filter_map(|c| c.trim().split_once('='))
        .find(|(k, _)| *k == name)
        .map(|(_, v)| v)
        .filter(|v| !v.is_empty())
}

pub struct Cookies {
    pub secure: bool,
}

impl Cookies {
    /// `__Host-` makes browsers refuse the cookie unless it is Secure, host-only and Path=/.
    pub fn name(&self, base: &str) -> String {
        if self.secure { format!("__Host-{base}") } else { base.to_string() }
    }

    pub fn set(&self, base: &str, value: &str, max_age: i64) -> HeaderValue {
        let secure = if self.secure { "; Secure" } else { "" };
        let v = format!("{}={value}; Path=/; HttpOnly; SameSite=Lax; Max-Age={max_age}{secure}", self.name(base));
        HeaderValue::from_str(&v).expect("cookie values are URL-safe base64")
    }

    pub fn clear(&self, base: &str) -> HeaderValue {
        self.set(base, "", 0)
    }

    /// Remove a cookie that was set without the prefix by the Python version.
    pub fn clear_legacy(&self, name: &str) -> HeaderValue {
        HeaderValue::from_str(&format!("{name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0")).expect("static")
    }
}

const CSP: &str = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; \
    media-src 'self' blob:; worker-src 'self' blob:; connect-src 'self'; object-src 'none'; \
    base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

const PERMISSIONS: &str = "camera=(), microphone=(), geolocation=(), payment=(), usb=(), \
    browsing-topics=(), interest-cohort=()";

/// Headers on every response.
pub async fn headers(secure: bool, req: Request, next: Next) -> Response {
    let mut res = next.run(req).await;
    let h = res.headers_mut();
    let set = |h: &mut HeaderMap, k: &'static str, v: &'static str| {
        h.entry(k).or_insert(HeaderValue::from_static(v));
    };
    set(h, "content-security-policy", CSP);
    set(h, "x-content-type-options", "nosniff");
    set(h, "referrer-policy", "strict-origin-when-cross-origin");
    set(h, "x-frame-options", "DENY");
    set(h, "permissions-policy", PERMISSIONS);
    set(h, "cross-origin-opener-policy", "same-origin");
    set(h, "cross-origin-resource-policy", "same-origin");
    if secure {
        set(h, "strict-transport-security", "max-age=31536000; includeSubDomains");
    }
    res
}

#[cfg(test)]
mod tests {
    use super::*;

    fn h(pairs: &[(&'static str, &'static str)]) -> HeaderMap {
        let mut m = HeaderMap::new();
        for (k, v) in pairs {
            m.append(*k, HeaderValue::from_static(v));
        }
        m
    }

    #[test]
    fn xff_uses_entry_added_by_proxy() {
        let peer: SocketAddr = "172.18.0.2:5000".parse().unwrap();
        let spoofed = h(&[("x-forwarded-for", "6.6.6.6, 203.0.113.9")]);
        assert_eq!(client_ip(&spoofed, peer, 1).to_string(), "203.0.113.9");
        assert_eq!(client_ip(&spoofed, peer, 2).to_string(), "6.6.6.6");
        assert_eq!(client_ip(&spoofed, peer, 0), peer.ip());
        // Fewer entries than proxies, or garbage: fall back to the peer.
        assert_eq!(client_ip(&spoofed, peer, 3), peer.ip());
        assert_eq!(client_ip(&h(&[("x-forwarded-for", "nonsense")]), peer, 1), peer.ip());
        assert_eq!(client_ip(&HeaderMap::new(), peer, 1), peer.ip());
    }

    #[test]
    fn ipv6_is_grouped_by_64() {
        let a: IpAddr = "2001:db8:1:2:aaaa::1".parse().unwrap();
        let b: IpAddr = "2001:db8:1:2:bbbb::9".parse().unwrap();
        assert_eq!(ip_key(a), ip_key(b));
    }

    #[test]
    fn origin_check() {
        assert!(same_origin(&h(&[("host", "pl8.narl.io"), ("origin", "https://pl8.narl.io")]), None));
        assert!(!same_origin(&h(&[("host", "pl8.narl.io"), ("origin", "https://evil.example")]), None));
        assert!(!same_origin(&h(&[("sec-fetch-site", "cross-site")]), None));
        assert!(same_origin(&h(&[("origin", "https://pl8.narl.io")]), Some("https://pl8.narl.io")));
        assert!(!same_origin(&h(&[("origin", "http://pl8.narl.io")]), Some("https://pl8.narl.io")));
    }

    #[test]
    fn cookie_attributes() {
        let c = Cookies { secure: true };
        let v = c.set("pl8inf", "tok", 60);
        assert_eq!(v.to_str().unwrap(), "__Host-pl8inf=tok; Path=/; HttpOnly; SameSite=Lax; Max-Age=60; Secure");
        let jar = h(&[("cookie", "a=1; __Host-pl8inf=tok; b=")]);
        assert_eq!(cookie(&jar, "__Host-pl8inf"), Some("tok"));
        assert_eq!(cookie(&jar, "b"), None);
    }
}
