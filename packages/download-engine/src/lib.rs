use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use std::{
    path::{Component, Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};
use thiserror::Error;
use tokio::{
    fs,
    io::{AsyncSeekExt, AsyncWriteExt},
    sync::{mpsc, watch},
};
use url::Url;

/// Bounded transfer settings shared by every adapter.
pub const MAX_SEGMENTS_PER_DOWNLOAD: usize = 8;

/// Smallest gap between progress notifications, so a fast transfer cannot flood the UI.
const PROGRESS_INTERVAL: Duration = Duration::from_millis(200);

/// Runtime instruction for an in-flight transfer.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Control {
    Run,
    Pause,
    Cancel,
}

/// Optional runtime attachments for a transfer.
///
/// Both are `None` by default, which reproduces the original fire-and-forget behaviour.
/// `control` is polled between chunks, so pausing takes effect within one chunk rather
/// than at the end of the download.
#[derive(Clone, Default)]
pub struct TransferHooks {
    pub control: Option<watch::Receiver<Control>>,
    pub progress: Option<mpsc::UnboundedSender<TransferMetrics>>,
}

impl TransferHooks {
    pub fn new(
        control: watch::Receiver<Control>,
        progress: mpsc::UnboundedSender<TransferMetrics>,
    ) -> Self {
        Self {
            control: Some(control),
            progress: Some(progress),
        }
    }

    fn signal(&self) -> Control {
        self.control
            .as_ref()
            .map(|control| *control.borrow())
            .unwrap_or(Control::Run)
    }
}

fn metrics(completed_bytes: u64, total_bytes: u64, elapsed: Duration) -> TransferMetrics {
    let bytes_per_second = if elapsed.as_nanos() == 0 {
        0
    } else {
        (completed_bytes as f64 / elapsed.as_secs_f64()) as u64
    };
    let eta_seconds = (bytes_per_second > 0 && completed_bytes < total_bytes)
        .then(|| total_bytes.saturating_sub(completed_bytes) / bytes_per_second);
    TransferMetrics {
        completed_bytes,
        total_bytes,
        bytes_per_second,
        eta_seconds,
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct TransferMetrics {
    pub completed_bytes: u64,
    pub total_bytes: u64,
    pub bytes_per_second: u64,
    pub eta_seconds: Option<u64>,
}

impl TransferMetrics {
    pub fn from_manifest(state: &DownloadManifest, elapsed: std::time::Duration) -> Self {
        let completed_bytes = state
            .segments
            .iter()
            .map(|segment| segment.completed)
            .sum::<u64>()
            .min(state.total_bytes);
        let bytes_per_second = if elapsed.as_nanos() == 0 {
            0
        } else {
            (completed_bytes as f64 / elapsed.as_secs_f64()) as u64
        };
        let eta_seconds = (bytes_per_second > 0 && completed_bytes < state.total_bytes)
            .then(|| state.total_bytes.saturating_sub(completed_bytes) / bytes_per_second);
        Self {
            completed_bytes,
            total_bytes: state.total_bytes,
            bytes_per_second,
            eta_seconds,
        }
    }
}

#[derive(Debug, Error)]
pub enum EngineError {
    #[error("only HTTP and HTTPS download URLs are supported")]
    UnsafeUrl,
    #[error("unsafe destination or filename")]
    UnsafePath,
    #[error("download was cancelled")]
    Cancelled,
    #[error(transparent)]
    Http(#[from] reqwest::Error),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    State(#[from] serde_json::Error),
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DownloadStatus {
    Queued,
    Active,
    Paused,
    RecoverablyInterrupted,
    Failed,
    Cancelled,
    Completed,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SegmentState {
    pub start: u64,
    pub end: u64,
    pub completed: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DownloadManifest {
    pub schema_version: u8,
    pub url: String,
    pub output: PathBuf,
    pub status: DownloadStatus,
    pub total_bytes: u64,
    pub segments: Vec<SegmentState>,
}

pub fn validate_url(value: &str) -> Result<Url, EngineError> {
    let url = Url::parse(value).map_err(|_| EngineError::UnsafeUrl)?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(EngineError::UnsafeUrl);
    }
    Ok(url)
}

pub fn sanitize_filename(value: &str) -> Result<String, EngineError> {
    let leaf = value
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or("")
        .trim()
        .trim_matches('.');
    let mut clean: String = leaf
        .chars()
        .map(|c| {
            if c.is_control() || "<>:\"/\\|?*".contains(c) {
                '_'
            } else {
                c
            }
        })
        .collect();
    if clean.is_empty() {
        clean = "download".into();
    }
    let stem = clean
        .split('.')
        .next()
        .unwrap_or("")
        .trim_end_matches([' ', '.']);
    let reserved = [
        "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
        "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    ];
    if reserved.iter().any(|name| name.eq_ignore_ascii_case(stem)) {
        clean.insert(0, '_');
    }
    if clean == "." || clean == ".." {
        return Err(EngineError::UnsafePath);
    }
    Ok(clean)
}

pub async fn collision_safe_path(
    destination: &Path,
    filename: &str,
) -> Result<PathBuf, EngineError> {
    if !destination
        .components()
        .all(|c| !matches!(c, Component::ParentDir))
    {
        return Err(EngineError::UnsafePath);
    }
    let safe = sanitize_filename(filename)?;
    let source = Path::new(&safe);
    for index in 0..10_000u32 {
        let candidate_name = if index == 0 {
            safe.clone()
        } else {
            let stem = source
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("download");
            let ext = source
                .extension()
                .and_then(|s| s.to_str())
                .map(|s| format!(".{s}"))
                .unwrap_or_default();
            format!("{stem} ({index}){ext}")
        };
        let candidate = destination.join(candidate_name);
        if !candidate.exists() {
            return Ok(candidate);
        }
    }
    Err(EngineError::UnsafePath)
}

async fn persist(path: &Path, state: &DownloadManifest) -> Result<(), EngineError> {
    validate_manifest(state)?;
    let temp = path.with_extension("json.tmp");
    fs::write(&temp, serde_json::to_vec_pretty(state)?).await?;
    let backup = path.with_extension("json.previous");
    if fs::try_exists(path).await? {
        let _ = fs::remove_file(&backup).await;
        fs::rename(path, &backup).await?;
    }
    if let Err(error) = fs::rename(&temp, path).await {
        if fs::try_exists(&backup).await.unwrap_or(false) {
            let _ = fs::rename(&backup, path).await;
        }
        return Err(error.into());
    }
    let _ = fs::remove_file(backup).await;
    Ok(())
}

pub fn validate_manifest(state: &DownloadManifest) -> Result<(), EngineError> {
    if state.schema_version != 1 || state.segments.is_empty() {
        return Err(EngineError::UnsafePath);
    }
    validate_url(&state.url)?;
    let mut covered = 0u64;
    for segment in &state.segments {
        if segment.end < segment.start
            || segment.completed > segment.end - segment.start + 1
            || segment.start != covered
        {
            return Err(EngineError::UnsafePath);
        }
        covered = segment.end.checked_add(1).ok_or(EngineError::UnsafePath)?;
    }
    if state.total_bytes > 0 && covered != state.total_bytes {
        return Err(EngineError::UnsafePath);
    }
    if state.status == DownloadStatus::Completed
        && state
            .segments
            .iter()
            .any(|segment| segment.completed != segment.end - segment.start + 1)
    {
        return Err(EngineError::UnsafePath);
    }
    Ok(())
}

pub async fn backup_manifest(path: &Path, backup: &Path) -> Result<(), EngineError> {
    let state: DownloadManifest = serde_json::from_slice(&fs::read(path).await?)?;
    validate_manifest(&state)?;
    let temp = backup.with_extension("backup.tmp");
    fs::write(&temp, serde_json::to_vec_pretty(&state)?).await?;
    if fs::try_exists(backup).await? {
        fs::remove_file(backup).await?;
    }
    fs::rename(temp, backup).await?;
    Ok(())
}

pub async fn restore_manifest(backup: &Path, path: &Path) -> Result<(), EngineError> {
    let state: DownloadManifest = serde_json::from_slice(&fs::read(backup).await?)?;
    validate_manifest(&state)?;
    persist(path, &state).await
}

pub async fn load_manifest(path: &Path) -> Result<DownloadManifest, EngineError> {
    let mut state: DownloadManifest = serde_json::from_slice(&fs::read(path).await?)?;
    validate_manifest(&state)?;
    if state.status == DownloadStatus::Active {
        state.status = DownloadStatus::RecoverablyInterrupted;
        persist(path, &state).await?;
    }
    Ok(state)
}

fn build_client() -> Result<reqwest::Client, EngineError> {
    Ok(reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::limited(10))
        .build()?)
}

/// Returns whether the origin honours Range, and the total length it reports.
async fn probe_source(client: &reqwest::Client, url: &Url) -> Result<(bool, u64), EngineError> {
    let probe = client
        .get(url.clone())
        .header(reqwest::header::RANGE, "bytes=0-0")
        .send()
        .await?;
    let supports_range = probe.status() == reqwest::StatusCode::PARTIAL_CONTENT;
    let total = if supports_range {
        probe
            .headers()
            .get(reqwest::header::CONTENT_RANGE)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.rsplit('/').next())
            .and_then(|v| v.parse().ok())
            .unwrap_or(0)
    } else {
        probe.content_length().unwrap_or(0)
    };
    Ok((supports_range, total))
}

fn plan_segments(supports_range: bool, total: u64, count: u64) -> Vec<SegmentState> {
    if supports_range && total > 1 {
        let parts = count.min(total);
        (0..parts)
            .map(|i| SegmentState {
                start: i * total / parts,
                end: ((i + 1) * total / parts) - 1,
                completed: 0,
            })
            .collect()
    } else {
        vec![SegmentState {
            start: 0,
            end: total.saturating_sub(1),
            completed: 0,
        }]
    }
}

/// Streams one segment to disk chunk by chunk.
///
/// Writing incrementally (rather than buffering the whole segment) is what makes pause,
/// cancel and live progress possible: the control signal is checked between chunks and the
/// bytes already written stay on disk, so `completed` is a truthful resume point.
#[allow(clippy::too_many_arguments)]
async fn transfer_segment(
    client: reqwest::Client,
    url: Url,
    supports_range: bool,
    mut segment: SegmentState,
    part: PathBuf,
    counter: Arc<AtomicU64>,
    total: u64,
    started: Instant,
    hooks: TransferHooks,
) -> Result<(SegmentState, Control), EngineError> {
    let span = segment.end.saturating_sub(segment.start) + 1;
    if supports_range && segment.completed >= span {
        return Ok((segment, Control::Run));
    }
    let signal = hooks.signal();
    if signal != Control::Run {
        return Ok((segment, signal));
    }
    let offset = segment.start + segment.completed;
    let mut request = client.get(url);
    if supports_range {
        request = request.header(
            reqwest::header::RANGE,
            format!("bytes={}-{}", offset, segment.end),
        );
    }
    let response = request.send().await?;
    if supports_range && response.status() != reqwest::StatusCode::PARTIAL_CONTENT {
        return Err(EngineError::UnsafePath);
    }
    let mut file = fs::OpenOptions::new().write(true).open(&part).await?;
    file.seek(std::io::SeekFrom::Start(offset)).await?;
    let mut body = response.bytes_stream();
    // `None` means "report the first chunk immediately"; throttling applies only afterwards,
    // otherwise a short transfer finishes before the first interval and never reports at all.
    let mut last_report: Option<Instant> = None;
    while let Some(chunk) = body.next().await {
        let signal = hooks.signal();
        if signal != Control::Run {
            file.flush().await?;
            return Ok((segment, signal));
        }
        let chunk = chunk?;
        file.write_all(&chunk).await?;
        segment.completed += chunk.len() as u64;
        let done = counter.fetch_add(chunk.len() as u64, Ordering::Relaxed) + chunk.len() as u64;
        if let Some(progress) = hooks.progress.as_ref() {
            let due = last_report
                .map(|at| at.elapsed() >= PROGRESS_INTERVAL)
                .unwrap_or(true);
            if due {
                last_report = Some(Instant::now());
                let _ = progress.send(metrics(done, total, started.elapsed()));
            }
        }
    }
    file.flush().await?;
    Ok((segment, Control::Run))
}

#[allow(clippy::too_many_arguments)]
async fn run_transfer(
    client: reqwest::Client,
    url: Url,
    supports_range: bool,
    part: PathBuf,
    manifest_path: PathBuf,
    output: PathBuf,
    mut state: DownloadManifest,
    hooks: TransferHooks,
) -> Result<DownloadManifest, EngineError> {
    let started = Instant::now();
    let already: u64 = state.segments.iter().map(|segment| segment.completed).sum();
    let counter = Arc::new(AtomicU64::new(already));
    let total = state.total_bytes;
    let transfers = state.segments.clone().into_iter().map(|segment| {
        transfer_segment(
            client.clone(),
            url.clone(),
            supports_range,
            segment,
            part.clone(),
            counter.clone(),
            total,
            started,
            hooks.clone(),
        )
    });

    let mut outcome = Control::Run;
    for (index, result) in futures_util::future::join_all(transfers)
        .await
        .into_iter()
        .enumerate()
    {
        let (segment, control) = result?;
        state.segments[index] = segment;
        outcome = match (outcome, control) {
            (Control::Cancel, _) | (_, Control::Cancel) => Control::Cancel,
            (Control::Pause, _) | (_, Control::Pause) => Control::Pause,
            _ => Control::Run,
        };
    }

    // Persist the real offsets before reporting the outcome, so a resume after pause,
    // cancel or crash starts from bytes that are actually on disk.
    match outcome {
        Control::Cancel => {
            state.status = DownloadStatus::Cancelled;
            persist(&manifest_path, &state).await?;
            let _ = fs::remove_file(&part).await;
            return Ok(state);
        }
        Control::Pause => {
            state.status = DownloadStatus::Paused;
            persist(&manifest_path, &state).await?;
            return Ok(state);
        }
        Control::Run => {}
    }

    // A source without Range and without Content-Length only reveals its size once drained.
    if !supports_range && state.total_bytes == 0 {
        let written = state.segments[0].completed;
        state.segments[0].end = written.saturating_sub(1);
        state.total_bytes = written;
    }

    if supports_range {
        for segment in &state.segments {
            if segment.completed != segment.end - segment.start + 1 {
                state.status = DownloadStatus::RecoverablyInterrupted;
                persist(&manifest_path, &state).await?;
                return Err(EngineError::Io(std::io::Error::new(
                    std::io::ErrorKind::UnexpectedEof,
                    "segment length mismatch",
                )));
            }
        }
    }

    let written = fs::metadata(&part).await?.len();
    if state.total_bytes > 0 && written != state.total_bytes {
        state.status = DownloadStatus::RecoverablyInterrupted;
        persist(&manifest_path, &state).await?;
        return Err(EngineError::Io(std::io::Error::new(
            std::io::ErrorKind::UnexpectedEof,
            "download length mismatch",
        )));
    }
    fs::rename(&part, &output).await?;
    state.status = DownloadStatus::Completed;
    persist(&manifest_path, &state).await?;
    if let Some(progress) = hooks.progress.as_ref() {
        let _ = progress.send(metrics(
            state.total_bytes,
            state.total_bytes,
            started.elapsed(),
        ));
    }
    Ok(state)
}

pub async fn download(
    url: &str,
    destination: &Path,
    filename: &str,
    segment_count: usize,
) -> Result<DownloadManifest, EngineError> {
    download_with_control(
        url,
        destination,
        filename,
        segment_count,
        TransferHooks::default(),
    )
    .await
}

/// Starts a transfer that honours pause and cancel and reports progress.
pub async fn download_with_control(
    url: &str,
    destination: &Path,
    filename: &str,
    segment_count: usize,
    hooks: TransferHooks,
) -> Result<DownloadManifest, EngineError> {
    let url = validate_url(url)?;
    fs::create_dir_all(destination).await?;
    let output = collision_safe_path(destination, filename).await?;
    let part = output.with_extension("sandwich-part");
    let manifest_path = output.with_extension("sandwich.json");
    let client = build_client()?;
    let (supports_range, total) = probe_source(&client, &url).await?;
    let count = segment_count.clamp(1, MAX_SEGMENTS_PER_DOWNLOAD) as u64;
    let state = DownloadManifest {
        schema_version: 1,
        url: url.to_string(),
        output: output.clone(),
        status: DownloadStatus::Active,
        total_bytes: total,
        segments: plan_segments(supports_range, total, count),
    };
    persist(&manifest_path, &state).await?;
    let file = fs::File::create(&part).await?;
    if total > 0 {
        file.set_len(total).await?;
    }
    drop(file);
    run_transfer(
        client,
        url,
        supports_range,
        part,
        manifest_path,
        output,
        state,
        hooks,
    )
    .await
}

/// Continues a paused or interrupted transfer from its persisted segment offsets.
pub async fn resume_with_control(
    manifest_path: &Path,
    hooks: TransferHooks,
) -> Result<DownloadManifest, EngineError> {
    let mut state = load_manifest(manifest_path).await?;
    match state.status {
        DownloadStatus::Completed => return Ok(state),
        DownloadStatus::Cancelled => return Err(EngineError::Cancelled),
        _ => {}
    }
    let url = validate_url(&state.url)?;
    let output = state.output.clone();
    let part = output.with_extension("sandwich-part");
    // Without the partial file the recorded offsets describe bytes that no longer exist.
    if !fs::try_exists(&part).await? {
        let file = fs::File::create(&part).await?;
        if state.total_bytes > 0 {
            file.set_len(state.total_bytes).await?;
        }
        drop(file);
        for segment in &mut state.segments {
            segment.completed = 0;
        }
    }
    let client = build_client()?;
    let (supports_range, _) = probe_source(&client, &url).await?;
    state.status = DownloadStatus::Active;
    persist(manifest_path, &state).await?;
    run_transfer(
        client,
        url,
        supports_range,
        part,
        manifest_path.to_path_buf(),
        output,
        state,
        hooks,
    )
    .await
}
