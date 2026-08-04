//! Preferences that survive a restart.
//!
//! Small enough to be a single JSON file. Anything that fails to load falls back to defaults
//! rather than blocking startup: a corrupt preferences file must never stop the app from
//! opening, because the user cannot fix it if they cannot get in.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    /// Where finished files are written. Empty until the user picks a folder.
    pub destination: String,
    /// Sort completed files into per-type subfolders.
    pub organize_by_type: bool,
}

fn settings_path(config_dir: &Path) -> PathBuf {
    config_dir.join("settings.json")
}

pub fn load(config_dir: &Path) -> Settings {
    std::fs::read_to_string(settings_path(config_dir))
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

pub fn save(config_dir: &Path, settings: &Settings) -> std::io::Result<()> {
    std::fs::create_dir_all(config_dir)?;
    let path = settings_path(config_dir);
    // Write beside the target and rename, so an interrupted save cannot leave a truncated
    // file that would silently reset the user's preferences on the next launch.
    let temp = path.with_extension("json.tmp");
    std::fs::write(
        &temp,
        serde_json::to_vec_pretty(settings).map_err(std::io::Error::other)?,
    )?;
    std::fs::rename(&temp, &path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_or_corrupt_preferences_fall_back_to_defaults() {
        let dir = std::env::temp_dir().join(format!("sandwich-settings-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);

        // Nothing written yet.
        assert_eq!(load(&dir).destination, "");
        assert!(!load(&dir).organize_by_type);

        // Round trip.
        let stored = Settings {
            destination: "D:\\Downloads".into(),
            organize_by_type: true,
        };
        save(&dir, &stored).unwrap();
        let read_back = load(&dir);
        assert_eq!(read_back.destination, "D:\\Downloads");
        assert!(read_back.organize_by_type);

        // Corrupt content must not panic or block startup.
        std::fs::write(settings_path(&dir), b"{ not json").unwrap();
        assert_eq!(load(&dir).destination, "");

        let _ = std::fs::remove_dir_all(&dir);
    }
}
