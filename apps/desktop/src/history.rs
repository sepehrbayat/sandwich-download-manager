//! When downloads happened. aria2 remembers everything about a transfer except time — its
//! session file has no timestamps — so date grouping and "downloaded today" filters need this
//! sidecar: a small JSON map from gid to when it was added and when it finished.
//!
//! Same durability approach as settings.rs: atomic temp+rename writes, forgiving reads. Losing
//! this file loses nothing but dates, so a corrupt or missing store is an empty one, never an
//! error the user sees.

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Clone, Copy, Default, Serialize, Deserialize)]
pub struct Times {
    pub added_at: Option<u64>,
    pub completed_at: Option<u64>,
}

pub struct HistoryStore {
    path: PathBuf,
    entries: HashMap<String, Times>,
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or(0)
}

impl HistoryStore {
    pub fn load(dir: &Path) -> Self {
        let path = dir.join("history.json");
        let entries = std::fs::read_to_string(&path)
            .ok()
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_default();
        Self { path, entries }
    }

    fn save(&self) {
        if let Some(parent) = self.path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let temp = self.path.with_extension("json.tmp");
        if let Ok(raw) = serde_json::to_string(&self.entries) {
            if std::fs::write(&temp, raw).is_ok() {
                let _ = std::fs::rename(&temp, &self.path);
            }
        }
    }

    /// Idempotent: a second call keeps the first timestamp, so a poll-loop race cannot
    /// move a download's date.
    pub fn record_added(&mut self, gid: &str) {
        let entry = self.entries.entry(gid.to_owned()).or_default();
        if entry.added_at.is_none() {
            entry.added_at = Some(now());
            self.save();
        }
    }

    pub fn record_completed(&mut self, gid: &str) {
        let entry = self.entries.entry(gid.to_owned()).or_default();
        if entry.completed_at.is_none() {
            entry.completed_at = Some(now());
            self.save();
        }
    }

    pub fn get(&self, gid: &str) -> Times {
        self.entries.get(gid).copied().unwrap_or_default()
    }

    /// Drops entries for downloads the engine no longer knows, so the file tracks the queue
    /// instead of growing forever.
    pub fn prune(&mut self, live: &HashSet<String>) {
        let before = self.entries.len();
        self.entries.retain(|gid, _| live.contains(gid));
        if self.entries.len() != before {
            self.save();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// One directory per test, not per process: cargo runs tests on parallel threads, and a
    /// shared directory that each test wipes on entry is a race the local machine happened
    /// to win and CI happened to lose.
    fn scratch(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("sandwich-history-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn round_trips_through_disk() {
        let dir = scratch("roundtrip");
        let mut store = HistoryStore::load(&dir);
        store.record_added("g1");
        store.record_completed("g1");

        let reloaded = HistoryStore::load(&dir);
        let times = reloaded.get("g1");
        assert!(times.added_at.is_some());
        assert!(times.completed_at.is_some());
    }

    #[test]
    fn timestamps_are_first_write_wins() {
        let dir = scratch("firstwrite");
        let mut store = HistoryStore::load(&dir);
        store.record_added("g1");
        let first = store.get("g1").added_at;
        store.record_added("g1");
        assert_eq!(store.get("g1").added_at, first);
    }

    #[test]
    fn a_corrupt_file_is_an_empty_store() {
        let dir = scratch("corrupt");
        std::fs::write(dir.join("history.json"), "{ not json").unwrap();
        let store = HistoryStore::load(&dir);
        assert!(store.get("anything").added_at.is_none());
    }

    #[test]
    fn prune_keeps_only_live_gids() {
        let dir = scratch("prune");
        let mut store = HistoryStore::load(&dir);
        store.record_added("keep");
        store.record_added("drop");
        store.prune(&HashSet::from(["keep".to_owned()]));
        assert!(store.get("keep").added_at.is_some());
        assert!(store.get("drop").added_at.is_none());
    }
}
