#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use download_engine::{Control, DownloadManifest, DownloadStatus, TransferHooks, TransferMetrics};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::Arc,
    time::Instant,
};
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;
use tokio::sync::{RwLock, mpsc, watch};

const SEGMENTS_PER_DOWNLOAD: usize = 4;

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
}

/// Payload carried by `clipboard-url-offer`; the UI hands it straight back on confirmation.
#[derive(Deserialize)]
struct ClipboardOffer {
    url: String,
}

#[derive(Default)]
struct DesktopState {
    downloads: RwLock<HashMap<String, Snapshot>>,
    /// One control channel per live transfer. Pause and cancel send on this and the engine polls
    /// it between chunks, which is what makes the queue buttons real rather than cosmetic.
    controls: RwLock<HashMap<String, watch::Sender<Control>>>,
}
type SharedState = Arc<DesktopState>;

fn snapshot(id: String, manifest: DownloadManifest, elapsed: std::time::Duration) -> Snapshot {
    let metrics = TransferMetrics::from_manifest(&manifest, elapsed);
    Snapshot {
        id,
        filename: manifest
            .output
            .file_name()
            .and_then(|v| v.to_str())
            .unwrap_or("download")
            .to_owned(),
        status: manifest.status,
        total_bytes: metrics.total_bytes,
        completed_bytes: metrics.completed_bytes,
        bytes_per_second: metrics.bytes_per_second,
        eta_seconds: metrics.eta_seconds,
        output: manifest.output,
    }
}

enum Transfer {
    Fresh {
        url: String,
        folder: PathBuf,
        filename: String,
    },
    Resume {
        manifest: PathBuf,
    },
}

/// Runs one transfer to completion, forwarding engine progress to the UI as it arrives.
fn spawn_transfer(
    app: AppHandle,
    shared: SharedState,
    id: String,
    transfer: Transfer,
    control: watch::Receiver<Control>,
) {
    tauri::async_runtime::spawn(async move {
        let (progress, mut updates) = mpsc::unbounded_channel::<TransferMetrics>();
        let reporter = {
            let app = app.clone();
            let shared = shared.clone();
            let id = id.clone();
            tauri::async_runtime::spawn(async move {
                while let Some(metrics) = updates.recv().await {
                    let current = {
                        let mut downloads = shared.downloads.write().await;
                        let Some(item) = downloads.get_mut(&id) else {
                            continue;
                        };
                        item.status = DownloadStatus::Active;
                        item.total_bytes = metrics.total_bytes;
                        item.completed_bytes = metrics.completed_bytes;
                        item.bytes_per_second = metrics.bytes_per_second;
                        item.eta_seconds = metrics.eta_seconds;
                        item.clone()
                    };
                    let _ = app.emit("download-snapshot", current);
                }
            })
        };

        let started = Instant::now();
        let result = match transfer {
            Transfer::Fresh {
                url,
                folder,
                filename,
            } => {
                download_engine::download_with_control(
                    &url,
                    &folder,
                    &filename,
                    SEGMENTS_PER_DOWNLOAD,
                    TransferHooks::new(control, progress),
                )
                .await
            }
            Transfer::Resume { manifest } => {
                download_engine::resume_with_control(
                    &manifest,
                    TransferHooks::new(control, progress),
                )
                .await
            }
        };
        // The engine dropped the sender, so the reporter ends; await it so no progress update
        // lands after the terminal state and leaves the queue showing a stale "Downloading".
        let _ = reporter.await;

        let final_state = {
            let mut downloads = shared.downloads.write().await;
            let Some(item) = downloads.get_mut(&id) else {
                return;
            };
            match result {
                Ok(manifest) => {
                    let settled = snapshot(id.clone(), manifest, started.elapsed());
                    item.status = settled.status;
                    item.total_bytes = settled.total_bytes;
                    item.completed_bytes = settled.completed_bytes;
                    item.bytes_per_second = 0;
                    item.eta_seconds = None;
                    item.output = settled.output;
                }
                Err(error) => {
                    item.status = DownloadStatus::Failed;
                    eprintln!("download {id} failed: {error}");
                }
            }
            item.clone()
        };
        shared.controls.write().await.remove(&id);
        let _ = app.emit("download-snapshot", final_state);
    });
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
    app: AppHandle,
    shared: SharedState,
    url: String,
    destination: String,
    organize_by_type: bool,
) -> Result<Snapshot, String> {
    download_engine::validate_url(&url).map_err(|error| error.to_string())?;
    let filename = download_engine::sanitize_filename(&derived_filename(&url))
        .map_err(|error| error.to_string())?;
    let mut folder = PathBuf::from(destination);
    if organize_by_type {
        let category = Path::new(&filename)
            .extension()
            .and_then(|v| v.to_str())
            .filter(|v| !v.is_empty())
            .unwrap_or("other");
        folder.push(category.to_ascii_lowercase());
    }
    let id = format!(
        "{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|error| error.to_string())?
            .as_nanos()
    );
    let queued = Snapshot {
        id: id.clone(),
        filename: filename.clone(),
        status: DownloadStatus::Queued,
        total_bytes: 0,
        completed_bytes: 0,
        bytes_per_second: 0,
        eta_seconds: None,
        output: folder.join(&filename),
    };
    shared
        .downloads
        .write()
        .await
        .insert(id.clone(), queued.clone());
    let (sender, receiver) = watch::channel(Control::Run);
    shared.controls.write().await.insert(id.clone(), sender);
    spawn_transfer(
        app,
        shared.clone(),
        id,
        Transfer::Fresh {
            url,
            folder,
            filename,
        },
        receiver,
    );
    Ok(queued)
}

#[tauri::command]
async fn list_downloads(state: State<'_, SharedState>) -> Result<Vec<Snapshot>, String> {
    Ok(state.downloads.read().await.values().cloned().collect())
}

#[tauri::command]
async fn choose_destination(app: AppHandle) -> Result<Option<String>, String> {
    let folder = app.dialog().file().blocking_pick_folder();
    Ok(folder.map(|value| value.to_string()))
}

#[tauri::command]
async fn submit_url(
    app: AppHandle,
    state: State<'_, SharedState>,
    url: String,
    destination: String,
    organize_by_type: bool,
) -> Result<Snapshot, String> {
    queue_download(
        app,
        state.inner().clone(),
        url,
        destination,
        organize_by_type,
    )
    .await
}

#[tauri::command]
async fn confirm_clipboard_offer(
    app: AppHandle,
    state: State<'_, SharedState>,
    offer: ClipboardOffer,
    destination: String,
    organize_by_type: bool,
) -> Result<Snapshot, String> {
    queue_download(
        app,
        state.inner().clone(),
        offer.url,
        destination,
        organize_by_type,
    )
    .await
}

#[tauri::command]
async fn control_download(
    app: AppHandle,
    state: State<'_, SharedState>,
    download_id: String,
    action: String,
) -> Result<Snapshot, String> {
    match action.as_str() {
        "pause" | "cancel" => {
            let signal = if action == "pause" {
                Control::Pause
            } else {
                Control::Cancel
            };
            if let Some(sender) = state.controls.read().await.get(&download_id) {
                let _ = sender.send(signal);
            }
            let mut downloads = state.downloads.write().await;
            let item = downloads
                .get_mut(&download_id)
                .ok_or("download not found")?;
            // The engine settles the terminal state; this reflects the request immediately so the
            // queue does not look frozen while the transfer winds down.
            item.status = if action == "pause" {
                DownloadStatus::Paused
            } else {
                DownloadStatus::Cancelled
            };
            Ok(item.clone())
        }
        "resume" => {
            let existing = state
                .downloads
                .read()
                .await
                .get(&download_id)
                .cloned()
                .ok_or("download not found")?;
            if existing.status == DownloadStatus::Cancelled {
                return Err("a cancelled download cannot be resumed".into());
            }
            let manifest = existing.output.with_extension("sandwich.json");
            let (sender, receiver) = watch::channel(Control::Run);
            state
                .controls
                .write()
                .await
                .insert(download_id.clone(), sender);
            spawn_transfer(
                app,
                state.inner().clone(),
                download_id.clone(),
                Transfer::Resume { manifest },
                receiver,
            );
            let mut downloads = state.downloads.write().await;
            let item = downloads
                .get_mut(&download_id)
                .ok_or("download not found")?;
            item.status = DownloadStatus::Active;
            Ok(item.clone())
        }
        _ => Err("unsupported download action".into()),
    }
}

async fn completed_path(state: &SharedState, id: &str) -> Result<PathBuf, String> {
    let downloads = state.downloads.read().await;
    let item = downloads.get(id).ok_or("download not found")?;
    if item.status != DownloadStatus::Completed {
        return Err("download is not complete".into());
    }
    Ok(item.output.clone())
}

#[tauri::command]
async fn open_completed_file(
    app: AppHandle,
    state: State<'_, SharedState>,
    download_id: String,
) -> Result<(), String> {
    let path = completed_path(state.inner(), &download_id).await?;
    app.opener()
        .open_path(path.to_string_lossy(), None::<&str>)
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn reveal_completed_file(
    app: AppHandle,
    state: State<'_, SharedState>,
    download_id: String,
) -> Result<(), String> {
    let path = completed_path(state.inner(), &download_id).await?;
    app.opener()
        .reveal_item_in_dir(path)
        .map_err(|error| error.to_string())
}

fn main() {
    let shared = Arc::new(DesktopState::default());
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(shared)
        .setup(|app| {
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let mut previous = String::new();
                loop {
                    if let Ok(value) = handle.clipboard().read_text() {
                        if value != previous && download_engine::validate_url(&value).is_ok() {
                            previous = value.clone();
                            let _ = handle.emit(
                                "clipboard-url-offer",
                                serde_json::json!({ "display_url": value, "url": previous }),
                            );
                        }
                    }
                    tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_downloads,
            choose_destination,
            submit_url,
            confirm_clipboard_offer,
            control_download,
            open_completed_file,
            reveal_completed_file
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Sandwich Download Manager");
}
