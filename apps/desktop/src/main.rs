#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod settings;

use aria2_client::{Aria2, Aria2Status};
use download_policy::DownloadStatus;
use serde::{Deserialize, Serialize};
use std::{
    path::{Path, PathBuf},
    sync::Arc,
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
    let status = engine
        .status(&gid)
        .await
        .map_err(|error| error.to_string())?;
    Ok(to_snapshot(&status))
}

#[tauri::command]
async fn list_downloads(state: State<'_, AppState>) -> Result<Vec<Snapshot>, String> {
    let all = state
        .engine()?
        .all()
        .await
        .map_err(|error| error.to_string())?;
    Ok(all.iter().map(to_snapshot).collect())
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
    queue_download(state.engine()?, url, destination, organize_by_type).await
}

#[tauri::command]
async fn confirm_clipboard_offer(
    state: State<'_, AppState>,
    offer: ClipboardOffer,
    destination: String,
    organize_by_type: bool,
) -> Result<Snapshot, String> {
    queue_download(state.engine()?, offer.url, destination, organize_by_type).await
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
        let status = engine.status(&gid).await.map_err(|error| error.to_string())?;
        return Ok(to_snapshot(&status));
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
            error: None,
        });
        snapshot.status = DownloadStatus::Cancelled;
        snapshot.bytes_per_second = 0;
        snapshot.eta_seconds = None;
        return Ok(snapshot);
    }
    let status = engine
        .status(&download_id)
        .await
        .map_err(|error| error.to_string())?;
    Ok(to_snapshot(&status))
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

#[tauri::command]
async fn open_completed_file(
    app: AppHandle,
    state: State<'_, AppState>,
    download_id: String,
) -> Result<(), String> {
    let path = completed_path(state.engine()?, &download_id).await?;
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
    app.opener()
        .reveal_item_in_dir(path)
        .map_err(|error| error.to_string())
}

/// Pushes queue changes to the UI. Only transfers whose visible state actually changed are
/// emitted, so a stalled queue stays silent instead of repeating itself to assistive tech.
fn spawn_progress_poller(app: AppHandle, engine: Arc<Aria2>) {
    tauri::async_runtime::spawn(async move {
        let mut previous: std::collections::HashMap<String, (u64, DownloadStatus, u32)> =
            std::collections::HashMap::new();
        loop {
            if let Ok(all) = engine.all().await {
                for status in &all {
                    let snapshot = to_snapshot(status);
                    let key = (
                        snapshot.completed_bytes,
                        snapshot.status.clone(),
                        snapshot.connections,
                    );
                    if previous.get(&snapshot.id) != Some(&key) {
                        previous.insert(snapshot.id.clone(), key);
                        let _ = app.emit("download-snapshot", snapshot);
                    }
                }
            }
            tokio::time::sleep(POLL_INTERVAL).await;
        }
    });
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
            if let Some(engine) = engine.as_ref() {
                spawn_progress_poller(handle.clone(), engine.clone());
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
        .run(tauri::generate_context!())
        .expect("failed to run Sandwich Download Manager");
}
