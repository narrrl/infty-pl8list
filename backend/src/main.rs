//! Infinite-scroll front end for pl8list, with sign-in through pl8list accounts.
//!
//!     pl8inf                 # then open http://127.0.0.1:8790
//!     pl8inf --healthcheck   # exit 0 if the server on $PORT answers /healthz
//!
//! Users sign in with their pl8list email: pl8list mails them a code, they type it
//! here, and this server checks it with pl8list. Afterwards they get a session
//! cookie for this app only. Their pl8list session is used once to sync their
//! library, then logged out at pl8list, unless they opt in to stay connected on
//! that device; then it is stored encrypted with a key only their browser can
//! unlock (see `link.rs`).
//! See `config.rs` for the environment variables.

#![allow(clippy::result_large_err)] // handlers return axum `Response` as their error

mod cache;
mod config;
mod crawler;
mod db;
mod http;
mod link;
mod pl8;
mod ranker;
mod ratelimit;
mod sync;
mod tags;

use std::{
    io::{Read, Write},
    net::{SocketAddr, TcpStream},
    sync::Arc,
    time::Duration,
};

use config::Config;

fn healthcheck() -> std::process::ExitCode {
    let port = std::env::var("PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(8790u16);
    let ok = (|| -> std::io::Result<bool> {
        let mut s = TcpStream::connect_timeout(&SocketAddr::from(([127, 0, 0, 1], port)), Duration::from_secs(2))?;
        s.set_read_timeout(Some(Duration::from_secs(2)))?;
        s.write_all(b"GET /healthz HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")?;
        let mut head = [0u8; 12];
        s.read_exact(&mut head)?;
        Ok(head.ends_with(b"200"))
    })();
    if matches!(ok, Ok(true)) { std::process::ExitCode::SUCCESS } else { std::process::ExitCode::FAILURE }
}

async fn shutdown() {
    let ctrl_c = tokio::signal::ctrl_c();
    #[cfg(unix)]
    {
        let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).expect("signal handler");
        tokio::select! { _ = ctrl_c => {}, _ = term.recv() => {} }
    }
    #[cfg(not(unix))]
    let _ = ctrl_c.await;
}

#[tokio::main]
async fn main() -> anyhow::Result<std::process::ExitCode> {
    if std::env::args().any(|a| a == "--healthcheck") {
        return Ok(healthcheck());
    }
    config::load_dotenv(".env");
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "pl8inf=info".into()),
        )
        .with_target(false)
        .init();

    let cfg = Config::from_env();
    if !cfg.secure {
        tracing::warn!("INSECURE_COOKIES=1: cookies without Secure, no HSTS. Use only for local development.");
    }
    let db = db::Db::open(&cfg.db_path)?;
    let link = link::LinkKey::load(cfg.link_key.as_deref(), &cfg.link_key_file)?;
    let pl8 = Arc::new(pl8::Pl8::new(&cfg.pl8_base, Duration::from_millis(700))?);
    let crawler = crawler::Crawler::new(pl8.clone(), db.clone());
    crawler.start();

    let addr: SocketAddr = format!("{}:{}", cfg.host, cfg.port).parse()?;
    let app = http::App::new(cfg, db, pl8, crawler, link);
    {
        let app = app.clone();
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(Duration::from_secs(3600));
            loop {
                tick.tick().await;
                app.purge().await;
            }
        });
    }

    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!("listening on http://{addr}");
    axum::serve(listener, http::router(app).into_make_service_with_connect_info::<SocketAddr>())
        .with_graceful_shutdown(shutdown())
        .await?;
    Ok(std::process::ExitCode::SUCCESS)
}
