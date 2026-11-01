//! Opt-in "stay connected to pl8list": a device keeps its pl8list session, encrypted.
//!
//! Each stored session is encrypted with a key derived from two secrets:
//!
//! - the device's local session token, which only the browser holds (the database
//!   has just its SHA-256 hash), and
//! - a server key kept outside the database (`LINK_KEY`, or a key file).
//!
//! A copy of the database, even together with the server key, opens nothing, and a
//! stolen browser cookie only reaches our API. The server can decrypt a session only
//! while that device is making a request; background jobs never can.

use std::{fs, io::Write, path::Path};

use base64::Engine;
use chacha20poly1305::{
    XChaCha20Poly1305, XNonce,
    aead::{Aead, KeyInit, Payload},
};
use hkdf::Hkdf;
use rand::Rng;
use secrecy::{ExposeSecret, SecretString};
use sha2::Sha256;
use zeroize::Zeroizing;

use crate::db;

const VERSION: u8 = 1;
const INFO: &[u8] = b"pl8inf pl8list link v1";
const NONCE_LEN: usize = 24;

pub struct LinkKey(Zeroizing<[u8; 32]>);

impl LinkKey {
    /// `LINK_KEY` (base64, 32 bytes) if set, else the key file, created on first start.
    pub fn load(env: Option<&str>, file: &Path) -> anyhow::Result<Self> {
        let b64 = base64::engine::general_purpose::STANDARD;
        let decode = |s: &str| -> anyhow::Result<Self> {
            let raw = Zeroizing::new(b64.decode(s.trim())?);
            let key: [u8; 32] = raw.as_slice().try_into().map_err(|_| anyhow::anyhow!("LINK_KEY must be 32 bytes"))?;
            Ok(LinkKey(Zeroizing::new(key)))
        };
        if let Some(s) = env.filter(|s| !s.trim().is_empty()) {
            return decode(s);
        }
        if let Ok(s) = fs::read_to_string(file) {
            return decode(&s);
        }
        let mut key = Zeroizing::new([0u8; 32]);
        rand::rng().fill_bytes(key.as_mut());
        let mut opts = fs::OpenOptions::new();
        opts.write(true).create_new(true);
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut opts, 0o600);
        opts.open(file)?.write_all(b64.encode(key.as_ref()).as_bytes())?;
        tracing::info!("created link key {}", file.display());
        Ok(LinkKey(key))
    }

    #[cfg(test)]
    pub fn fixed(byte: u8) -> Self {
        LinkKey(Zeroizing::new([byte; 32]))
    }

    /// Everything needed to seal and open one device's pl8list session. Holds the
    /// derived key, not the token.
    pub fn sealer(&self, token: &str, user_id: i64) -> Sealer {
        let mut key = Zeroizing::new([0u8; 32]);
        Hkdf::<Sha256>::new(Some(self.0.as_ref()), token.as_bytes())
            .expand(INFO, key.as_mut())
            .expect("32 bytes is a valid HKDF-SHA256 output length");
        Sealer { key, user_id, token_hash: db::hash_token(token) }
    }
}

pub struct Sealer {
    key: Zeroizing<[u8; 32]>,
    pub user_id: i64,
    pub token_hash: String,
}

impl Sealer {
    /// Binds the ciphertext to this user and this session row.
    fn aad(&self) -> Vec<u8> {
        let mut aad = self.user_id.to_le_bytes().to_vec();
        aad.extend_from_slice(self.token_hash.as_bytes());
        aad
    }

    fn cipher(&self) -> XChaCha20Poly1305 {
        XChaCha20Poly1305::new_from_slice(self.key.as_ref()).expect("key is 32 bytes")
    }

    pub fn seal(&self, session: &SecretString) -> Vec<u8> {
        let mut nonce = [0u8; NONCE_LEN];
        rand::rng().fill_bytes(&mut nonce);
        let aad = self.aad();
        let sealed = self
            .cipher()
            .encrypt(&XNonce::from(nonce), Payload { msg: session.expose_secret().as_bytes(), aad: &aad })
            .expect("encryption with a valid key does not fail");
        let mut out = Vec::with_capacity(1 + NONCE_LEN + sealed.len());
        out.push(VERSION);
        out.extend_from_slice(&nonce);
        out.extend_from_slice(&sealed);
        out
    }

    pub fn open(&self, blob: &[u8]) -> Option<SecretString> {
        let (&version, rest) = blob.split_first()?;
        if version != VERSION || rest.len() < NONCE_LEN {
            return None;
        }
        let (nonce, sealed) = rest.split_at(NONCE_LEN);
        let nonce: [u8; NONCE_LEN] = nonce.try_into().ok()?;
        let aad = self.aad();
        let plain = Zeroizing::new(self.cipher().decrypt(&XNonce::from(nonce), Payload { msg: sealed, aad: &aad }).ok()?);
        let text = std::str::from_utf8(&plain).ok()?;
        Some(SecretString::from(text.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opens_only_with_the_same_token_key_and_user() {
        let key = LinkKey::fixed(1);
        let s = key.sealer("token-a", 7);
        let blob = s.seal(&SecretString::from("cookie-value".to_string()));
        assert!(!blob.windows(12).any(|w| w == b"cookie-value"));
        assert_eq!(s.open(&blob).unwrap().expose_secret(), "cookie-value");
        assert!(key.sealer("token-b", 7).open(&blob).is_none());
        assert!(key.sealer("token-a", 8).open(&blob).is_none());
        assert!(LinkKey::fixed(2).sealer("token-a", 7).open(&blob).is_none());
        let mut tampered = blob.clone();
        *tampered.last_mut().unwrap() ^= 1;
        assert!(s.open(&tampered).is_none());
    }

    #[test]
    fn key_file_is_created_once() {
        let dir = std::env::temp_dir().join(format!("pl8inf-link-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join("link.key");
        let _ = fs::remove_file(&file);
        let a = LinkKey::load(None, &file).unwrap();
        let b = LinkKey::load(None, &file).unwrap();
        assert_eq!(a.0.as_ref(), b.0.as_ref());
        fs::remove_dir_all(&dir).unwrap();
    }
}
