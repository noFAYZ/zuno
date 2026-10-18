//! Android has no Discord IPC socket to talk to, so presence is a no-op there. Same surface as
//! `discord_rpc`, so the commands in `lib.rs` compile unchanged.

use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct DiscordPresenceData {
    pub title: String,
    pub artist: String,
    pub album: String,
    pub artwork_url: Option<String>,
    pub song_url: Option<String>,
    pub artist_url: Option<String>,
    pub album_url: Option<String>,
    pub duration: u64,
    pub current_time: u64,
    pub is_playing: bool,
}

#[derive(Default)]
pub struct DiscordRpcManager;

impl DiscordRpcManager {
    pub fn new() -> Self {
        Self
    }

    pub fn update_presence(&self, _data: DiscordPresenceData) -> Result<(), String> {
        Ok(())
    }

    pub fn clear_presence(&self) -> Result<(), String> {
        Ok(())
    }
}
