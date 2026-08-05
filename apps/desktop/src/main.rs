#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod history;
mod settings;

use aria2_client::{Aria2, Aria2Status};
use download_policy::DownloadStatus;
use history::HistoryStore;
use serde::{Deserialize, Serialize};
use std::{
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

/// How often the queue is refreshed from the engine. Fast enough to feel live, slow enough
/// that a screen reader is not flooded with announcements.
const POLL_INTERVAL: Duration = Duration::from_millis(500);

#[derive(Clone, Serialize)]
struct Snapshot {
    id: String,
    filename: String,
    status: DownloadStatus,
    total_bytes: u64,
    completed_bytes: u64,
    bytes_per_second: u64,
    eta_seconds: Option<u64>,
    output: PathBuf,
    /// Hex piece map driving the segmented progress view.
    bitfield: String,
    num_pieces: u32,
    connections: u32,
    source_url: String,
    directory: String,
    /// Unix seconds, from the sidecar history store — aria2 itself keeps no clocks.
    #[serde(skip_serializing_if = "Option::is_none")]
    added_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    completed_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<DownloadError>,
}

#[derive(Clone, Serialize)]
struct DownloadError {
    /// aria2's numeric exit code, when it reported one. The UI keys its human explanation off
    /// this; the raw message stays available under details for anyone diagnosing.
    #[serde(skip_serializing_if = "Option::is_none")]
    code: Option<u32>,
    message: String,
}

/// Payload emitted with `clipboard-url-offer`; the UI hands it straight back on confirmation.
#[derive(Deserialize)]
struct ClipboardOffer {
    url: String,
}

struct AppState {
    engine: Option<Arc<Aria2>>,
    config_dir: PathBuf,
    history: Arc<Mutex<HistoryStore>>,
}

impl AppState {
    fn engine(&self) -> Result<&Arc<Aria2>, String> {
        self.engine
            .as_ref()
            .ok_or_else(|| "the download engine is unavailable".to_owned())
    }
}

/// aria2's vocabulary mapped onto the seven states the UI knows how to render.
fn map_status(raw: &str) -> DownloadStatus {
    match raw {
        "active" => DownloadStatus::Active,
        "waiting" => DownloadStatus::Queued,
        "paused" => DownloadStatus::Paused,
        "complete" => DownloadStatus::Completed,
        "removed" => DownloadStatus::Cancelled,
        _ => DownloadStatus::Failed,
    }
}

fn to_snapshot(status: &Aria2Status) -> Snapshot {
    let output = status
        .files
        .first()
        .map(|file| PathBuf::from(&file.path))
        .unwrap_or_default();
    Snapshot {
        id: status.gid.clone(),
        filename: output
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("download")
            .to_owned(),
        status: map_status(&status.status),
        total_bytes: status.total(),
        completed_bytes: status.completed(),
        bytes_per_second: status.speed(),
        eta_seconds: status.eta_seconds(),
        output,
        bitfield: status.bitfield.clone(),
        num_pieces: status.pieces(),
        connections: status.connection_count(),
        source_url: status.source_url(),
        directory: status.dir.clone(),
        added_at: None,
        completed_at: None,
        error: status
            .error_message
            .as_ref()
            .filter(|message| !message.is_empty())
            .map(|message| DownloadError {
                code: status
                    .error_code
                    .as_deref()
                    .and_then(|code| code.parse().ok()),
                message: message.clone(),
            }),
    }
}

/// Joins the sidecar timestamps onto a snapshot. `to_snapshot` stays a pure translation of
/// engine state; time is deliberately stamped at the edges, where the store is in reach.
fn stamped(mut snapshot: Snapshot, history: &Mutex<HistoryStore>) -> Snapshot {
    if let Ok(store) = history.lock() {
        let times = store.get(&snapshot.id);
        snapshot.added_at = times.added_at;
        snapshot.completed_at = times.completed_at;
    }
    snapshot
}

fn derived_filename(value: &str) -> String {
    url::Url::parse(value)
        .ok()
        .and_then(|url| url.path_segments()?.next_back().map(str::to_owned))
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "download".to_owned())
}

/// Shared by manual submission and clipboard confirmation so both follow one code path.
async fn queue_download(
    engine: &Aria2,
    history: &Mutex<HistoryStore>,
    url: String,
    destination: String,
    organize_by_type: bool,
) -> Result<Snapshot, String> {
    // Sandwich keeps ownership of safety policy even though aria2 performs the transfer.
    download_policy::validate_url(&url).map_err(|error| error.to_string())?;
    let filename = download_policy::sanitize_filename(&derived_filename(&url))
        .map_err(|error| error.to_string())?;
    let mut folder = PathBuf::from(destination);
    if organize_by_type {
        let category = Path::new(&filename)
            .extension()
            .and_then(|value| value.to_str())
            .filter(|value| !value.is_empty())
            .unwrap_or("other");
        folder.push(category.to_ascii_lowercase());
    }
    let gid = engine
        .add_uri(&url, &folder, &filename)
        .await
        .map_err(|error| error.to_string())?;
    if let Ok(mut store) = history.lock() {
        store.record_added(&gid);
    }
    let status = engine
        .status(&gid)
        .await
        .map_err(|error| error.to_string())?;
    Ok(stamped(to_snapshot(&status), history))
}

#[tauri::command]
async fn list_downloads(state: State<'_, AppState>) -> Result<Vec<Snapshot>, String> {
    let all = state
        .engine()?
        .all()
        .await
        .map_err(|error| error.to_string())?;
    Ok(all
        .iter()
        .map(|status| stamped(to_snapshot(status), &state.history))
        .collect())
}

#[tauri::command]
fn load_settings(state: State<'_, AppState>) -> settings::Settings {
    settings::load(&state.config_dir)
}

#[tauri::command]
fn save_settings(state: State<'_, AppState>, settings: settings::Settings) -> Result<(), String> {
    settings::save(&state.config_dir, &settings).map_err(|error| error.to_string())
}

#[tauri::command]
async fn choose_destination(app: AppHandle) -> Result<Option<String>, String> {
    let folder = app.dialog().file().blocking_pick_folder();
    Ok(folder.map(|value| value.to_string()))
}

#[tauri::command]
async fn submit_url(
    state: State<'_, AppState>,
    url: String,
    destination: String,
    organize_by_type: bool,
) -> Result<Snapshot, String> {
    queue_download(
        state.engine()?,
        &state.history,
        url,
        destination,
        organize_by_type,
    )
    .await
}

#[tauri::command]
async fn confirm_clipboard_offer(
    state: State<'_, AppState>,
    offer: ClipboardOffer,
    destination: String,
    organize_by_type: bool,
) -> Result<Snapshot, String> {
    queue_download(
        state.engine()?,
        &state.history,
        offer.url,
        destination,
        organize_by_type,
    )
    .await
}

#[tauri::command]
async fn control_download(
    state: State<'_, AppState>,
    download_id: String,
    action: String,
) -> Result<Snapshot, String> {
    let engine = state.engine()?;

    // Cancelling makes aria2 forget the transfer, so capture what the user sees *first*.
    // Reporting it back with an empty name would blank the card they just acted on.
    let before = if action == "cancel" {
        engine
            .status(&download_id)
            .await
            .ok()
            .map(|s| to_snapshot(&s))
    } else {
        None
    };

    // A failed transfer cannot be resumed — aria2 has already given up on it — so retrying
    // means queueing the same URL to the same place again and letting `--continue` pick up
    // whatever partial file is on disk. The old failed entry is removed so the queue shows
    // one download, not the corpse and its replacement side by side.
    if action == "retry" {
        let old = engine
            .status(&download_id)
            .await
            .map_err(|error| error.to_string())?;
        let url = old.source_url();
        if url.is_empty() {
            return Err("the original address of this download is no longer known".into());
        }
        let filename = old
            .files
            .first()
            .and_then(|file| Path::new(&file.path).file_name())
            .and_then(|name| name.to_str())
            .map(str::to_owned)
            .unwrap_or_else(|| derived_filename(&url));
        let directory = PathBuf::from(&old.dir);
        let _ = engine.cancel(&download_id).await;
        let gid = engine
            .add_uri(&url, &directory, &filename)
            .await
            .map_err(|error| error.to_string())?;
        // The retry is a new transfer and gets today's date; anything else would file a
        // download the user just started under last week.
        if let Ok(mut store) = state.history.lock() {
            store.record_added(&gid);
        }
        let status = engine
            .status(&gid)
            .await
            .map_err(|error| error.to_string())?;
        return Ok(stamped(to_snapshot(&status), &state.history));
    }

    match action.as_str() {
        "pause" => engine.pause(&download_id).await,
        "resume" => engine.resume(&download_id).await,
        "cancel" => engine.cancel(&download_id).await,
        _ => return Err("unsupported download action".into()),
    }
    .map_err(|error| error.to_string())?;

    if action == "cancel" {
        let mut snapshot = before.unwrap_or_else(|| Snapshot {
            id: download_id.clone(),
            filename: "Download".to_owned(),
            status: DownloadStatus::Cancelled,
            total_bytes: 0,
            completed_bytes: 0,
            bytes_per_second: 0,
            eta_seconds: None,
            output: PathBuf::new(),
            bitfield: String::new(),
            num_pieces: 0,
            connections: 0,
            source_url: String::new(),
            directory: String::new(),
            added_at: None,
            completed_at: None,
            error: None,
        });
        snapshot.status = DownloadStatus::Cancelled;
        snapshot.bytes_per_second = 0;
        snapshot.eta_seconds = None;
        return Ok(stamped(snapshot, &state.history));
    }
    let status = engine
        .status(&download_id)
        .await
        .map_err(|error| error.to_string())?;
    Ok(stamped(to_snapshot(&status), &state.history))
}

async fn completed_path(engine: &Aria2, id: &str) -> Result<PathBuf, String> {
    let status = engine.status(id).await.map_err(|error| error.to_string())?;
    if status.status != "complete" {
        return Err("download is not complete".into());
    }
    status
        .files
        .first()
        .map(|file| PathBuf::from(&file.path))
        .ok_or_else(|| "download has no output file".to_owned())
}

/// Stable sentinel the UI matches on to show its "file was moved or deleted" dialog.
/// The engine still lists the download, but the file system has moved on: users move and
/// delete finished files, and without this check "open" errored cryptically while "reveal"
/// silently opened the wrong folder.
const MISSING_FILE: &str = "missing";

#[tauri::command]
async fn open_completed_file(
    app: AppHandle,
    state: State<'_, AppState>,
    download_id: String,
) -> Result<(), String> {
    let path = completed_path(state.engine()?, &download_id).await?;
    if !path.exists() {
        return Err(MISSING_FILE.into());
    }
    app.opener()
        .open_path(path.to_string_lossy(), None::<&str>)
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn reveal_completed_file(
    app: AppHandle,
    state: State<'_, AppState>,
    download_id: String,
) -> Result<(), String> {
    let path = completed_path(state.engine()?, &download_id).await?;
    if !path.exists() {
        return Err(MISSING_FILE.into());
    }
    app.opener()
        .reveal_item_in_dir(path)
        .map_err(|error| error.to_string())
}

/// True exactly when a download the poller has been watching crosses into Completed.
/// A gid first seen already complete (session restore after a restart) is old news, not an
/// event — announcing it would greet every launch with a wall of stale notifications.
fn is_new_completion(previous: Option<&DownloadStatus>, current: &DownloadStatus) -> bool {
    *current == DownloadStatus::Completed
        && matches!(previous, Some(old) if *old != DownloadStatus::Completed)
}

/// Pushes queue changes to the UI. Only transfers whose visible state actually changed are
/// emitted, so a stalled queue stays silent instead of repeating itself to assistive tech.
fn spawn_progress_poller(app: AppHandle, engine: Arc<Aria2>, history: Arc<Mutex<HistoryStore>>) {
    tauri::async_runtime::spawn(async move {
        let mut previous: std::collections::HashMap<String, (u64, DownloadStatus, u32)> =
            std::collections::HashMap::new();
        loop {
            if let Ok(all) = engine.all().await {
                for status in &all {
                    let snapshot = stamped(to_snapshot(status), &history);
                    let finished = is_new_completion(
                        previous.get(&snapshot.id).map(|(_, status, _)| status),
                        &snapshot.status,
                    );
                    if finished {
                        if let Ok(mut store) = history.lock() {
                            store.record_completed(&snapshot.id);
                        }
                        announce_completion(&app, &snapshot);
                    }
                    let key = (
                        snapshot.completed_bytes,
                        snapshot.status.clone(),
                        snapshot.connections,
                    );
                    if previous
                        .get(&snapshot.id)
                        .map(|entry| entry != &key)
                        .unwrap_or(true)
                    {
                        previous.insert(snapshot.id.clone(), key);
                        let _ = app.emit("download-snapshot", snapshot);
                    }
                }
            }
            tokio::time::sleep(POLL_INTERVAL).await;
        }
    });
}

/// The in-app toast always fires; the OS notification only when the window is not focused.
/// Notifying someone about the window they are already looking at is noise, not news.
fn announce_completion(app: &AppHandle, snapshot: &Snapshot) {
    use tauri_plugin_notification::NotificationExt;

    let _ = app.emit("download-completed", snapshot.clone());
    let focused = app
        .webview_windows()
        .values()
        .next()
        .and_then(|window| window.is_focused().ok())
        .unwrap_or(false);
    if !focused {
        let _ = app
            .notification()
            .builder()
            .title("Download complete")
            .body(&snapshot.filename)
            .show();
    }
}

fn spawn_clipboard_watcher(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut previous = String::new();
        loop {
            if let Ok(value) = app.clipboard().read_text() {
                if value != previous && download_policy::validate_url(&value).is_ok() {
                    previous = value.clone();
                    let _ = app.emit(
                        "clipboard-url-offer",
                        serde_json::json!({ "display_url": value, "url": previous }),
                    );
                }
            }
            tokio::time::sleep(Duration::from_secs(2)).await;
        }
    });
}

fn main() {
    tauri::Builder::default()
        // A second launch must not start a second engine. Two instances write the same
        // session file and race each other over it, and the browser bridge can only point at
        // one of them — so the second copy quietly breaks the first. Focus the existing
        // window instead, which is what the user meant by clicking the shortcut again.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.webview_windows().values().next() {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            let handle = app.handle().clone();
            let data_dir = app
                .path()
                .app_data_dir()
                .unwrap_or_else(|_| std::env::temp_dir());
            let session_dir = data_dir.join("engine");

            // Starting the engine before the window is ready keeps the first render honest:
            // the UI never claims "connected" while the queue is unavailable.
            // Prefer the engine shipped beside the app; fall back to PATH for a dev run from
            // the workspace, where no bundle exists yet.
            let bundled = app
                .path()
                .resolve("binaries/aria2c.exe", tauri::path::BaseDirectory::Resource)
                .ok()
                .filter(|path| path.exists());
            let started = match bundled {
                Some(path) => {
                    tauri::async_runtime::block_on(Aria2::start_with(&path, &session_dir))
                }
                None => tauri::async_runtime::block_on(Aria2::start(&session_dir)),
            };
            let engine = match started {
                Ok(engine) => Some(Arc::new(engine)),
                Err(error) => {
                    eprintln!("download engine unavailable: {error}");
                    None
                }
            };
            let history = Arc::new(Mutex::new(HistoryStore::load(&data_dir)));
            if let Some(engine) = engine.as_ref() {
                // Trim history to what the engine still knows, so the sidecar tracks the
                // queue instead of growing forever.
                if let Ok(all) = tauri::async_runtime::block_on(engine.all()) {
                    let live = all.iter().map(|status| status.gid.clone()).collect();
                    if let Ok(mut store) = history.lock() {
                        store.prune(&live);
                        // Session-restored downloads predate the store (or survived a wipe):
                        // give them an added date of "now" rather than no date at all.
                        for status in &all {
                            store.record_added(&status.gid);
                        }
                    }
                }
                spawn_progress_poller(handle.clone(), engine.clone(), history.clone());
                // Publish how to reach the engine so the browser native host can hand
                // downloads to this running instance. The token inside is what protects the
                // endpoint, so the file lives in the user's own app data and nowhere else.
                let (endpoint, secret) = engine.connection();
                let handoff = data_dir.join("engine.json");
                let payload = serde_json::json!({ "endpoint": endpoint, "secret": secret });
                if let Err(error) = std::fs::create_dir_all(&data_dir)
                    .and_then(|()| std::fs::write(&handoff, payload.to_string()))
                {
                    eprintln!("could not publish the engine handoff file: {error}");
                }
            }
            app.manage(AppState {
                engine,
                config_dir: data_dir,
                history,
            });
            spawn_clipboard_watcher(handle);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_downloads,
            choose_destination,
            submit_url,
            confirm_clipboard_offer,
            load_settings,
            save_settings,
            control_download,
            open_completed_file,
            reveal_completed_file
        ])
        .build(tauri::generate_context!())
        .expect("failed to run Sandwich Download Manager")
        .run(|app_handle, event| {
            if let tauri::RunEvent::Exit = event {
                // A graceful goodbye, so the session file records reality. Without it the
                // Job Object kills aria2 before its next periodic save, and anything
                // removed or finished in the final seconds resurrects on the next launch —
                // ghost transfers that silently occupy the engine's download slots.
                let state = app_handle.state::<AppState>();
                if let Some(engine) = state.engine.clone() {
                    tauri::async_runtime::block_on(async move {
                        let _ = tokio::time::timeout(Duration::from_secs(3), engine.shutdown())
                            .await;
                    });
                }
            }
        });
}

#[cfg(test)]
mod completion_tests {
    use super::*;

    #[test]
    fn a_watched_download_finishing_is_news() {
        assert!(is_new_completion(
            Some(&DownloadStatus::Active),
            &DownloadStatus::Completed
        ));
    }

    #[test]
    fn an_already_complete_download_is_not_news_again() {
        assert!(!is_new_completion(
            Some(&DownloadStatus::Completed),
            &DownloadStatus::Completed
        ));
    }

    #[test]
    fn a_download_first_seen_complete_is_history_not_news() {
        // Session restore after a restart: everything in the queue arrives at once, some of
        // it already complete. Greeting every launch with stale notifications would teach
        // people to ignore the real ones.
        assert!(!is_new_completion(None, &DownloadStatus::Completed));
    }

    #[test]
    fn progress_alone_is_not_completion() {
        assert!(!is_new_completion(
            Some(&DownloadStatus::Active),
            &DownloadStatus::Active
        ));
    }
}
