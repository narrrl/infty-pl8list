//! Configuration from the environment (or `.env` next to the working directory).

use std::{env, path::PathBuf};

pub struct Config {
    pub host: String,
    pub port: u16,
    pub db_path: PathBuf,
    /// Reverse proxies in front of us that append to `X-Forwarded-For`. 0 = none.
    pub proxy_hops: usize,
    /// `https://host` the site is served from. Used for the Origin check; when unset
    /// the Origin must match the Host header.
    pub public_origin: Option<String>,
    /// Off only for plain-http development on another machine: drops `Secure`,
    /// the `__Host-` cookie prefix and HSTS.
    pub secure: bool,
    pub cache_dir: PathBuf,
    pub cache_max_bytes: u64,
    /// Server half of the key for stored pl8list sessions: `LINK_KEY` (base64, 32
    /// bytes), else the file `LINK_KEY_FILE` (created on first start).
    pub link_key: Option<String>,
    pub link_key_file: PathBuf,
    /// pl8list itself; only changed by tests.
    pub pl8_base: String,
    pub legal: Legal,
}

/// Operator details for the Impressum and the privacy policy. Kept out of the repository.
#[derive(Clone, Default)]
pub struct Legal {
    pub name: String,
    pub address: String,
    pub email: String,
    pub phone: String,
    pub hosting: String,
}

impl Legal {
    pub fn is_complete(&self) -> bool {
        !self.name.is_empty() && !self.address.is_empty() && !self.email.is_empty()
    }
}

fn var(name: &str) -> Option<String> {
    env::var(name).ok().map(|v| v.trim().to_string()).filter(|v| !v.is_empty())
}

fn flag(name: &str) -> Option<bool> {
    var(name).map(|v| matches!(v.as_str(), "1" | "true" | "yes"))
}

pub fn load_dotenv(path: &str) {
    let Ok(text) = std::fs::read_to_string(path) else { return };
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if let Some((k, v)) = line.split_once('=') {
            let k = k.trim();
            if env::var_os(k).is_none() {
                // SAFETY: called once at startup before any other thread exists.
                unsafe { env::set_var(k, v.trim().trim_matches(|c| c == '"' || c == '\'')) };
            }
        }
    }
}

impl Config {
    pub fn from_env() -> Self {
        let db_path = PathBuf::from(var("PL8_DB").unwrap_or_else(|| "pl8list.db".into()));
        let link_key_file = var("LINK_KEY_FILE").map(PathBuf::from).unwrap_or_else(|| {
            db_path.parent().map(|p| p.join("link.key")).unwrap_or_else(|| PathBuf::from("link.key"))
        });
        let cache_dir = var("CACHE_DIR").map(PathBuf::from).unwrap_or_else(|| {
            db_path.parent().map(|p| p.join("cache")).unwrap_or_else(|| PathBuf::from("cache"))
        });
        // TRUST_PROXY=1 from the Python version means one proxy hop.
        let proxy_hops = var("TRUSTED_PROXY_HOPS")
            .and_then(|v| v.parse().ok())
            .unwrap_or(if flag("TRUST_PROXY") == Some(true) { 1 } else { 0 });
        Config {
            host: var("HOST").unwrap_or_else(|| "127.0.0.1".into()),
            port: var("PORT").and_then(|v| v.parse().ok()).unwrap_or(8790),
            db_path,
            proxy_hops,
            public_origin: var("PUBLIC_ORIGIN").map(|o| o.trim_end_matches('/').to_string()),
            secure: flag("INSECURE_COOKIES") != Some(true),
            cache_dir,
            cache_max_bytes: var("CACHE_MAX_MB").and_then(|v| v.parse().ok()).unwrap_or(2048u64) << 20,
            link_key: var("LINK_KEY"),
            link_key_file,
            pl8_base: var("PL8_BASE").unwrap_or_else(|| "https://pl8list.com".into()),
            legal: Legal {
                name: var("IMPRESSUM_NAME").unwrap_or_default(),
                // One line per address line; "\n" or "|" separate lines in .env.
                address: var("IMPRESSUM_ADDRESS").unwrap_or_default().replace("\\n", "\n").replace('|', "\n"),
                email: var("IMPRESSUM_EMAIL").unwrap_or_default(),
                phone: var("IMPRESSUM_PHONE").unwrap_or_default(),
                hosting: var("HOSTING_PROVIDER").unwrap_or_default().replace("\\n", "\n").replace('|', "\n"),
            },
        }
    }
}
