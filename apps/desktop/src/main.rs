#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod history;
mod schedule;
mod settings;

use aria2_client::{Aria2, Aria2Status};
use chrono::Local;
use download_policy::DownloadStatus;
use history::HistoryStore;
use schedule::{HeldStore, Schedule};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
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

/// How often the download window is re-judged. The window's own resolution is a minute, so a
/// twenty-second tick keeps the worst-case overshoot well under one — close enough that
/// "downloads start at 2am" is true as written, without waking up constantly to learn nothing.
const SCHEDULE_INTERVAL: Duration = Duration::from_secs(20);

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
    /// Paused by the download window rather than by the user. The engine reports both as
    /// "paused"; only Sandwich knows the difference, and the card has to say which it is or a
    /// scheduled queue looks like one somebody stopped and forgot about.
    scheduled: bool,
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
    held: Arc<Mutex<HeldStore>>,
    /// The live copy of the download window. Kept in memory as well as on disk so the ticker
    /// and the poller do not read the settings file several times a second.
    schedule: Arc<Mutex<Schedule>>,
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
        scheduled: false,
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

/// Joins the two sidecar stores onto a snapshot: when the download happened, and whether the
/// schedule is the reason it is not moving. `to_snapshot` stays a pure translation of engine
/// state; everything the engine does not itself know is deliberately added at the edges, where
/// the stores are in reach.
fn stamped(
    mut snapshot: Snapshot,
    history: &Mutex<HistoryStore>,
    held: &Mutex<HeldStore>,
) -> Snapshot {
    if let Ok(store) = history.lock() {
        let times = store.get(&snapshot.id);
        snapshot.added_at = times.added_at;
        snapshot.completed_at = times.completed_at;
    }
    if let Ok(store) = held.lock() {
        snapshot.scheduled = store.holds(&snapshot.id);
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

/// Whether the download window currently allows transfers.
///
/// A poisoned lock answers "open". The schedule is a convenience; failing to read it must never
/// be what stops someone downloading a file.
fn window_is_open(schedule: &Mutex<Schedule>) -> bool {
    schedule
        .lock()
        .map(|current| current.is_open_at(Local::now()))
        .unwrap_or(true)
}

/// Parks a freshly queued transfer when the window is shut.
///
/// Without this a download added at lunchtime would start immediately and only be paused by
/// the next tick — twenty seconds of transfer that the user explicitly asked not to happen
/// until 2am. It also covers downloads handed over by the browser extension, which reach the
/// engine directly and never pass through the commands above.
async fn hold_if_closed(
    engine: &Aria2,
    held: &Mutex<HeldStore>,
    schedule: &Mutex<Schedule>,
    gid: &str,
) -> bool {
    if window_is_open(schedule) {
        return false;
    }
    // An explicit "start this one now" outranks the window.
    if held.lock().map(|store| store.allows(gid)).unwrap_or(false) {
        return false;
    }
    if engine.pause(gid).await.is_err() {
        return false;
    }
    if let Ok(mut store) = held.lock() {
        store.hold(gid);
    }
    true
}

/// Shared by manual submission and clipboard confirmation so both follow one code path.
async fn queue_download(
    engine: &Aria2,
    history: &Mutex<HistoryStore>,
    held: &Mutex<HeldStore>,
    schedule: &Mutex<Schedule>,
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
    hold_if_closed(engine, held, schedule, &gid).await;
    let status = engine
        .status(&gid)
        .await
        .map_err(|error| error.to_string())?;
    Ok(stamped(to_snapshot(&status), history, held))
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
        .map(|status| stamped(to_snapshot(status), &state.history, &state.held))
        .collect())
}

#[tauri::command]
fn load_settings(state: State<'_, AppState>) -> settings::Settings {
    settings::load(&state.config_dir)
}

#[tauri::command]
async fn save_settings(
    state: State<'_, AppState>,
    settings: settings::Settings,
) -> Result<ScheduleStatus, String> {
    let normalized = settings.schedule.normalized();
    let normalized_settings = settings::Settings {
        schedule: normalized.clone(),
        ..settings
    };
    settings::save(&state.config_dir, &normalized_settings).map_err(|error| error.to_string())?;
    if let Ok(mut current) = state.schedule.lock() {
        *current = normalized;
    }
    // Apply both kinds of limit now. The speed ceiling reaches active transfers through RPC;
    // the scheduler applies and, when needed, renegotiates the concurrency cap.
    if let Some(engine) = state.engine.as_ref() {
        if let Err(error) = engine
            .set_global_options(settings::engine_options(&normalized_settings))
            .await
        {
            // Saving is the command's durable promise. An unavailable engine already has a
            // visible banner, and the stored choice will be replayed on the next launch.
            eprintln!("could not apply transfer preferences: {error}");
        }
        apply_schedule(engine, &state.schedule, &state.held).await;
    }
    Ok(schedule_snapshot(&state.schedule, &state.held))
}

/// What the UI needs to explain the window: whether it is open, and when that next changes.
#[derive(Clone, Serialize)]
struct ScheduleStatus {
    enabled: bool,
    open: bool,
    /// Unix seconds. None when the window never changes state — disabled, always open, or set
    /// to no days at all.
    #[serde(skip_serializing_if = "Option::is_none")]
    next_change_at: Option<i64>,
    /// How many transfers are waiting on the window right now.
    waiting: usize,
}

fn schedule_snapshot(schedule: &Mutex<Schedule>, held: &Mutex<HeldStore>) -> ScheduleStatus {
    let current = schedule
        .lock()
        .map(|value| value.clone())
        .unwrap_or_default();
    let now = Local::now();
    ScheduleStatus {
        enabled: current.enabled,
        open: current.is_open_at(now),
        next_change_at: current.next_change_at(now).map(|at| at.timestamp()),
        waiting: held.lock().map(|store| store.count()).unwrap_or(0),
    }
}

#[tauri::command]
fn schedule_status(state: State<'_, AppState>) -> ScheduleStatus {
    schedule_snapshot(&state.schedule, &state.held)
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
        &state.held,
        &state.schedule,
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
        &state.held,
        &state.schedule,
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
        if let Ok(mut store) = state.held.lock() {
            store.forget(&download_id);
        }
        let gid = engine
            .add_uri(&url, &directory, &filename)
            .await
            .map_err(|error| error.to_string())?;
        // The retry is a new transfer and gets today's date; anything else would file a
        // download the user just started under last week.
        if let Ok(mut store) = state.history.lock() {
            store.record_added(&gid);
        }
        // A retry outside the window joins the queue for the next one, exactly like a newly
        // added download. Letting it run because it happens to be a second attempt would be a
        // hole straight through the schedule.
        hold_if_closed(engine, &state.held, &state.schedule, &gid).await;
        let status = engine
            .status(&gid)
            .await
            .map_err(|error| error.to_string())?;
        return Ok(stamped(to_snapshot(&status), &state.history, &state.held));
    }

    match action.as_str() {
        "pause" => engine.pause(&download_id).await,
        "resume" => engine.resume(&download_id).await,
        "cancel" => engine.cancel(&download_id).await,
        _ => return Err("unsupported download action".into()),
    }
    .map_err(|error| error.to_string())?;

    // The schedule's claim on a transfer only survives while the user has not overruled it.
    // Resuming outside the window is an explicit "start this one now", and it has to stick, or
    // the next tick would pause it again and the button would look broken.
    if let Ok(mut store) = state.held.lock() {
        match action.as_str() {
            "resume" => store.allow(&download_id),
            _ => store.forget(&download_id),
        }
    }

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
            scheduled: false,
            error: None,
        });
        snapshot.status = DownloadStatus::Cancelled;
        snapshot.bytes_per_second = 0;
        snapshot.eta_seconds = None;
        return Ok(stamped(snapshot, &state.history, &state.held));
    }
    let status = engine
        .status(&download_id)
        .await
        .map_err(|error| error.to_string())?;
    Ok(stamped(to_snapshot(&status), &state.history, &state.held))
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

/// What the UI needs to offer an update: the number to show and the notes to summarize.
#[derive(Clone, Serialize)]
struct UpdateInfo {
    version: String,
    notes: Option<String>,
}

/// Asks the release endpoint whether a newer signed build exists. Errors are returned, not
/// swallowed — the caller decides whether a failed background check is worth mentioning
/// (at startup it is not; a user-invoked check would be).
#[tauri::command]
async fn check_for_update(app: AppHandle) -> Result<Option<UpdateInfo>, String> {
    use tauri_plugin_updater::UpdaterExt;
    let updater = app.updater().map_err(|error| error.to_string())?;
    let found = updater.check().await.map_err(|error| error.to_string())?;
    Ok(found.map(|update| UpdateInfo {
        version: update.version.clone(),
        notes: update.body.clone(),
    }))
}

/// Downloads, verifies and installs the update, then restarts into the new version.
/// Re-checks rather than caching the earlier result: the moment between "offered" and
/// "accepted" can span hours, and installing a stale artifact would be worse than a
/// second network round trip.
#[tauri::command]
async fn install_update(app: AppHandle) -> Result<(), String> {
    use tauri_plugin_updater::UpdaterExt;
    let updater = app.updater().map_err(|error| error.to_string())?;
    let Some(update) = updater.check().await.map_err(|error| error.to_string())? else {
        return Err("no update is available any more".into());
    };
    let progress = app.clone();
    update
        .download_and_install(
            move |chunk, total| {
                let _ = progress.emit(
                    "update-progress",
                    serde_json::json!({ "chunk": chunk, "total": total }),
                );
            },
            || {},
        )
        .await
        .map_err(|error| error.to_string())?;
    // The engine dies with us (job object), the session file preserves the queue, and the
    // new version restores it — restarting mid-download is safe by construction.
    app.restart();
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

/// Brings the queue into line with the download window, in whichever direction is needed.
///
/// Idempotent by construction, because it runs on a timer, on startup, and again the moment
/// the user saves a change: every branch asks the engine what is true right now rather than
/// remembering what it did last time. That also makes it correct after a crash, where the only
/// surviving state is aria2's session file and the two sidecar stores.
async fn apply_schedule(engine: &Aria2, schedule: &Mutex<Schedule>, held: &Mutex<HeldStore>) {
    let current = schedule
        .lock()
        .map(|value| value.clone())
        .unwrap_or_default();
    let open = current.is_open_at(Local::now());
    // A closed window normally pauses everything, but the user can explicitly start one item
    // anyway. Keep the engine's promotion limit current even in that state, so overrides do
    // not fall back to aria2's default until the window opens again.
    if !open {
        let _ = engine
            .change_global_option(
                "max-concurrent-downloads",
                &current.max_concurrent.to_string(),
            )
            .await;
    }
    let Ok(all) = engine.all().await else {
        return;
    };

    if open {
        // Resume what the schedule stopped, and only that. Anything the user paused by hand
        // stays paused: 2am is not permission to restart a download they walked away from.
        let mut resumed = false;
        for status in &all {
            let ours = held
                .lock()
                .map(|store| store.holds(&status.gid))
                .unwrap_or(false);
            if !ours {
                continue;
            }
            if status.status == "paused" && engine.resume(&status.gid).await.is_err() {
                continue;
            }
            if let Ok(mut store) = held.lock() {
                store.release(&status.gid);
            }
            resumed = true;
        }
        // The window is open for everyone now, so a "start this one anyway" has nothing left
        // to override — and keeping it would exempt that download from tonight's close too.
        if let Ok(mut store) = held.lock() {
            store.clear_overrides();
        }
        if resumed {
            engine.save_session().await;
        }
        enforce_concurrency(engine, current.max_concurrent).await;
        return;
    }

    let mut paused = false;
    for status in &all {
        if !matches!(status.status.as_str(), "active" | "waiting") {
            continue;
        }
        if held
            .lock()
            .map(|store| store.allows(&status.gid))
            .unwrap_or(false)
        {
            continue;
        }
        if engine.pause(&status.gid).await.is_err() {
            continue;
        }
        if let Ok(mut store) = held.lock() {
            store.hold(&status.gid);
        }
        paused = true;
    }
    if paused {
        // Flush now for the same reason a cancel does: this process only ever dies by Job
        // Object kill, and a pause lost inside the ten-second save window would come back
        // downloading at the next launch — in the middle of the night the user reserved.
        engine.save_session().await;
    }
}

/// Holds the queue to the configured number of simultaneous transfers.
///
/// Two halves, and both are needed. Telling the engine the limit governs what it promotes from
/// here on; it does *not* touch transfers already running, which sail past a freshly lowered
/// cap until something makes the engine think again. Nudging the excess through
/// pause-and-unpause is that something — see `Aria2::renegotiate`. With only the first half,
/// turning the dial from 8 down to 2 mid-evening appears to do nothing until every current
/// download finishes; with only the second, the engine promotes the queue straight back up to
/// the old number as soon as a slot frees.
///
/// Setting the option here rather than once at startup means it is re-asserted on every tick,
/// so it survives an engine that had to be restarted underneath us.
async fn enforce_concurrency(engine: &Aria2, cap: u32) {
    let _ = engine
        .change_global_option("max-concurrent-downloads", &cap.to_string())
        .await;
    let Ok(all) = engine.all().await else {
        return;
    };
    let active: Vec<&Aria2Status> = all
        .iter()
        .filter(|status| status.status == "active")
        .collect();
    if active.len() as u32 <= cap {
        return;
    }
    // Demote from the end of aria2's active list: those are the most recently promoted, so the
    // transfers closest to finishing keep their slots and the queue drains rather than churns.
    for status in active.into_iter().skip(cap as usize) {
        let _ = engine.renegotiate(&status.gid).await;
    }
}

fn spawn_schedule_ticker(
    engine: Arc<Aria2>,
    schedule: Arc<Mutex<Schedule>>,
    held: Arc<Mutex<HeldStore>>,
) {
    tauri::async_runtime::spawn(async move {
        loop {
            apply_schedule(&engine, &schedule, &held).await;
            tokio::time::sleep(SCHEDULE_INTERVAL).await;
        }
    });
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
///
/// It is also where downloads that appear from outside the app — the browser extension hands
/// them straight to the engine — first become visible, so it is the earliest point at which a
/// closed window can be enforced on them.
fn spawn_progress_poller(
    app: AppHandle,
    engine: Arc<Aria2>,
    history: Arc<Mutex<HistoryStore>>,
    held: Arc<Mutex<HeldStore>>,
    schedule: Arc<Mutex<Schedule>>,
) {
    tauri::async_runtime::spawn(async move {
        let mut previous: std::collections::HashMap<String, (u64, DownloadStatus, u32)> =
            std::collections::HashMap::new();
        loop {
            if let Ok(all) = engine.all().await {
                for status in &all {
                    // A transfer nobody has told us about, running while the window is shut.
                    // Park it now: half a second of unwanted transfer is the most this can
                    // cost, against twenty if it waited for the next schedule tick.
                    let unseen = !previous.contains_key(&status.gid);
                    let running = matches!(status.status.as_str(), "active" | "waiting");
                    if unseen
                        && running
                        && hold_if_closed(&engine, &held, &schedule, &status.gid).await
                    {
                        // Emit nothing this round: the pause has been issued but the status in
                        // hand still says "active", and announcing a transfer as running when
                        // it is already stopping is a flicker with no information in it. The
                        // next poll reports it paused and scheduled, which is the truth.
                        let pending = to_snapshot(status);
                        previous.insert(
                            status.gid.clone(),
                            (pending.completed_bytes, pending.status, pending.connections),
                        );
                        continue;
                    }
                    let snapshot = stamped(to_snapshot(status), &history, &held);
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
        .plugin(tauri_plugin_updater::Builder::new().build())
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
            let aria2_name = format!("aria2c{}", std::env::consts::EXE_SUFFIX);
            let bundled = app
                .path()
                .resolve(
                    PathBuf::from("binaries").join(aria2_name),
                    tauri::path::BaseDirectory::Resource,
                )
                .ok()
                .filter(|path| path.exists());
            let started = match bundled {
                Some(path) => {
                    tauri::async_runtime::block_on(Aria2::start_with(&path, &session_dir))
                }
                None => tauri::async_runtime::block_on(Aria2::start(&session_dir)),
            };
            let engine_error = data_dir.join("engine-error.log");
            let engine = match started {
                Ok(engine) => {
                    let _ = std::fs::remove_file(&engine_error);
                    Some(Arc::new(engine))
                }
                Err(error) => {
                    eprintln!("download engine unavailable: {error}");
                    let _ = std::fs::create_dir_all(&data_dir)
                        .and_then(|()| std::fs::write(&engine_error, error.to_string()));
                    None
                }
            };
            let history = Arc::new(Mutex::new(HistoryStore::load(&data_dir)));
            let held = Arc::new(Mutex::new(HeldStore::load(&data_dir)));
            let stored_settings = settings::load(&data_dir);
            // The window is read once here and kept in memory; the settings file stays the
            // durable copy, but the ticker and the poller must not go to disk to consult it.
            let schedule = Arc::new(Mutex::new(stored_settings.schedule.normalized()));
            if let Some(engine) = engine.as_ref() {
                // aria2 starts with its own unlimited default. Replay the persisted ceiling
                // before the first frame so an update or restart cannot silently drop it.
                if let Err(error) = tauri::async_runtime::block_on(
                    engine.set_global_options(settings::engine_options(&stored_settings)),
                ) {
                    eprintln!("could not apply stored transfer preferences: {error}");
                }
                // Trim both sidecars to what the engine still knows, so they track the queue
                // instead of growing forever.
                if let Ok(all) = tauri::async_runtime::block_on(engine.all()) {
                    let live: HashSet<String> =
                        all.iter().map(|status| status.gid.clone()).collect();
                    if let Ok(mut store) = history.lock() {
                        store.prune(&live);
                        // Session-restored downloads predate the store (or survived a wipe):
                        // give them an added date of "now" rather than no date at all.
                        for status in &all {
                            store.record_added(&status.gid);
                        }
                    }
                    if let Ok(mut store) = held.lock() {
                        store.retain_live(&live);
                    }
                }
                // Judge the window before the first frame, and apply the concurrency cap with
                // it. A launch at three in the afternoon with an overnight schedule must not
                // spend twenty seconds downloading first.
                tauri::async_runtime::block_on(apply_schedule(engine, &schedule, &held));
                spawn_schedule_ticker(engine.clone(), schedule.clone(), held.clone());
                spawn_progress_poller(
                    handle.clone(),
                    engine.clone(),
                    history.clone(),
                    held.clone(),
                    schedule.clone(),
                );
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
                held,
                schedule,
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
            schedule_status,
            control_download,
            open_completed_file,
            reveal_completed_file,
            check_for_update,
            install_update
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
                        let _ =
                            tokio::time::timeout(Duration::from_secs(3), engine.shutdown()).await;
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
