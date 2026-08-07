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
    /// Canvas theme name. Empty means "never chosen", which lets the UI follow the OS
    /// light/dark preference until the user picks one; a stored choice always wins.
    pub theme: String,
    /// Ceiling on the combined speed of every transfer, in bytes per second. Zero is aria2's
    /// own convention for "no limit", so an older settings file remains unlimited.
    pub speed_limit_bytes: u64,
    /// When downloads are allowed to run, and how many at a time. Absent from an older
    /// settings file, in which case the default schedule (off) applies — upgrading must never
    /// switch a restriction on behind the user's back.
    pub schedule: crate::schedule::Schedule,
}

/// The aria2 global options owned by preferences rather than by the scheduler.
///
/// Concurrency deliberately does not appear here: `Schedule::max_concurrent` is the single
/// source of truth for that limit and `apply_schedule` also renegotiates already-running
/// transfers when it is lowered. Duplicating it here would let the two features fight.
pub fn engine_options(settings: &Settings) -> serde_json::Value {
    serde_json::json!({
        "max-overall-download-limit": settings.speed_limit_bytes.to_string(),
    })
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
            theme: "rye".into(),
            speed_limit_bytes: 2 * 1024 * 1024,
            schedule: crate::schedule::Schedule {
                enabled: true,
                start_minute: 22 * 60,
                end_minute: 6 * 60,
                days: [true, true, true, true, true, false, false],
                max_concurrent: 3,
            },
        };
        save(&dir, &stored).unwrap();
        let read_back = load(&dir);
        assert_eq!(read_back.destination, "D:\\Downloads");
        assert!(read_back.organize_by_type);
        assert_eq!(read_back.speed_limit_bytes, 2 * 1024 * 1024);
        assert_eq!(read_back.schedule, stored.schedule);

        // Corrupt content must not panic or block startup.
        std::fs::write(settings_path(&dir), b"{ not json").unwrap();
        assert_eq!(load(&dir).destination, "");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_settings_file_from_before_scheduling_keeps_its_answers_and_gains_a_disabled_schedule() {
        // Upgrading must not switch a download restriction on behind the user's back, and it
        // must not throw away the preferences they already set to do it.
        let dir =
            std::env::temp_dir().join(format!("sandwich-settings-old-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            settings_path(&dir),
            br#"{"destination":"D:\\Downloads","organize_by_type":true,"theme":"toast"}"#,
        )
        .unwrap();

        let loaded = load(&dir);
        assert_eq!(loaded.destination, "D:\\Downloads");
        assert_eq!(loaded.theme, "toast");
        assert_eq!(loaded.speed_limit_bytes, 0, "an absent limit is unlimited");
        assert!(!loaded.schedule.enabled);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn engine_options_pass_the_total_limit_through_as_bytes_per_second() {
        let limited = engine_options(&Settings {
            speed_limit_bytes: 1_500_000,
            ..Settings::default()
        });
        assert_eq!(limited["max-overall-download-limit"], "1500000");
        assert!(
            limited.get("max-concurrent-downloads").is_none(),
            "the scheduler owns concurrency"
        );

        let unlimited = engine_options(&Settings::default());
        assert_eq!(unlimited["max-overall-download-limit"], "0");
    }
}
