//! Credential store for Android, standing in for the `keyring` crate (which has no Android
//! backend). Same surface as the parts of `keyring` the app uses: `Entry`, `Error::NoEntry`.
//!
//! Secrets live in a JSON file inside the app's private data directory. On Android that
//! directory is sandboxed to this app (other apps and non-rooted users cannot read it) and is
//! covered by the device's file-based encryption, which is the same protection the platform
//! offers app-level secrets without going through the Keystore.

use std::collections::HashMap;
use std::fmt;
use std::fs;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

static STORE_PATH: OnceLock<PathBuf> = OnceLock::new();
static STORE_LOCK: Mutex<()> = Mutex::new(());

/// Called once from `setup`, before any command can reach a credential.
pub fn init(dir: PathBuf) {
    let _ = fs::create_dir_all(&dir);
    let _ = STORE_PATH.set(dir.join("credentials-v1.json"));
}

#[derive(Debug)]
pub enum Error {
    NoEntry,
    Storage(String),
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::NoEntry => write!(f, "no matching entry found"),
            Error::Storage(message) => write!(f, "{message}"),
        }
    }
}

impl std::error::Error for Error {}

pub struct Entry {
    key: String,
}

impl Entry {
    pub fn new(service: &str, user: &str) -> Result<Self, Error> {
        if STORE_PATH.get().is_none() {
            return Err(Error::Storage("credential store not initialised".to_string()));
        }
        Ok(Self { key: format!("{service}\u{1f}{user}") })
    }

    pub fn get_password(&self) -> Result<String, Error> {
        let _guard = STORE_LOCK.lock().map_err(|_| poisoned())?;
        read_all()?.remove(&self.key).ok_or(Error::NoEntry)
    }

    pub fn set_password(&self, password: &str) -> Result<(), Error> {
        let _guard = STORE_LOCK.lock().map_err(|_| poisoned())?;
        let mut all = read_all()?;
        all.insert(self.key.clone(), password.to_string());
        write_all(&all)
    }

    pub fn delete_credential(&self) -> Result<(), Error> {
        let _guard = STORE_LOCK.lock().map_err(|_| poisoned())?;
        let mut all = read_all()?;
        if all.remove(&self.key).is_none() {
            return Err(Error::NoEntry);
        }
        write_all(&all)
    }
}

fn poisoned() -> Error {
    Error::Storage("credential store lock poisoned".to_string())
}

fn path() -> Result<&'static PathBuf, Error> {
    STORE_PATH
        .get()
        .ok_or_else(|| Error::Storage("credential store not initialised".to_string()))
}

fn read_all() -> Result<HashMap<String, String>, Error> {
    match fs::read_to_string(path()?) {
        Ok(text) => serde_json::from_str(&text)
            .map_err(|error| Error::Storage(format!("credential store is corrupt: {error}"))),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(HashMap::new()),
        Err(error) => Err(Error::Storage(format!("credential store unreadable: {error}"))),
    }
}

fn write_all(all: &HashMap<String, String>) -> Result<(), Error> {
    let path = path()?;
    let text = serde_json::to_string(all)
        .map_err(|error| Error::Storage(format!("credential store encode failed: {error}")))?;
    // Write-then-rename so a crash mid-write cannot truncate the existing secrets.
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, text)
        .and_then(|_| fs::rename(&tmp, path))
        .map_err(|error| Error::Storage(format!("credential store write failed: {error}")))
}
