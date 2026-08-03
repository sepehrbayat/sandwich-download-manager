use download_engine::{
    DownloadManifest, DownloadStatus, MAX_SEGMENTS_PER_DOWNLOAD, SegmentState, TransferMetrics,
    backup_manifest, download, load_manifest, restore_manifest, sanitize_filename,
};
use std::{
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};

async fn server(payload: Vec<u8>, ranges: bool) -> (String, Arc<AtomicUsize>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let hits = Arc::new(AtomicUsize::new(0));
    let observed = hits.clone();
    tokio::spawn(async move {
        loop {
            let Ok((mut socket, _)) = listener.accept().await else {
                break;
            };
            let body = payload.clone();
            let counter = observed.clone();
            tokio::spawn(async move {
                let mut request = vec![0; 4096];
                let read = socket.read(&mut request).await.unwrap();
                let text = String::from_utf8_lossy(&request[..read]);
                let range = text
                    .lines()
                    .find(|line| line.to_ascii_lowercase().starts_with("range:"));
                let (status, bytes, extra) = if ranges {
                    if let Some(line) = range {
                        counter.fetch_add(1, Ordering::SeqCst);
                        let spec = line.split('=').nth(1).unwrap();
                        let mut bounds = spec.split('-');
                        let start: usize = bounds.next().unwrap().parse().unwrap();
                        let end: usize = bounds.next().unwrap().trim().parse().unwrap();
                        (
                            "206 Partial Content",
                            body[start..=end].to_vec(),
                            format!(
                                "Content-Range: bytes {start}-{end}/{}\r\nAccept-Ranges: bytes\r\n",
                                body.len()
                            ),
                        )
                    } else {
                        ("200 OK", body.clone(), String::new())
                    }
                } else {
                    ("200 OK", body.clone(), String::new())
                };
                let head = format!(
                    "HTTP/1.1 {status}\r\nContent-Length: {}\r\n{extra}Connection: close\r\n\r\n",
                    bytes.len()
                );
                socket.write_all(head.as_bytes()).await.unwrap();
                socket.write_all(&bytes).await.unwrap();
            });
        }
    });
    (format!("http://{address}/file.bin"), hits)
}

#[test]
fn transfer_metrics_are_bounded_and_handle_terminal_progress() {
    let state = DownloadManifest {
        schema_version: 1,
        url: "https://example.com/file.bin".into(),
        output: PathBuf::from("file.bin"),
        status: DownloadStatus::Active,
        total_bytes: 1_000,
        segments: vec![
            SegmentState {
                start: 0,
                end: 499,
                completed: 500,
            },
            SegmentState {
                start: 500,
                end: 999,
                completed: 250,
            },
        ],
    };
    let metrics = TransferMetrics::from_manifest(&state, std::time::Duration::from_secs(3));
    assert_eq!(metrics.completed_bytes, 750);
    assert_eq!(metrics.bytes_per_second, 250);
    assert_eq!(metrics.eta_seconds, Some(1));
    assert_eq!(MAX_SEGMENTS_PER_DOWNLOAD, 8);

    let complete = DownloadManifest {
        status: DownloadStatus::Completed,
        segments: vec![SegmentState {
            start: 0,
            end: 999,
            completed: 1_000,
        }],
        ..state
    };
    assert_eq!(
        TransferMetrics::from_manifest(&complete, std::time::Duration::from_secs(2)).eta_seconds,
        None
    );
}

#[tokio::test]
async fn manifest_backup_restore_and_validation_are_runtime_safe() {
    let temp = tempfile::tempdir().unwrap();
    let live = temp.path().join("state.json");
    let backup = temp.path().join("state.backup.json");
    let state = DownloadManifest {
        schema_version: 1,
        url: "https://example.com/file.bin".into(),
        output: temp.path().join("file.bin"),
        status: DownloadStatus::Paused,
        total_bytes: 10,
        segments: vec![SegmentState {
            start: 0,
            end: 9,
            completed: 4,
        }],
    };
    tokio::fs::write(&live, serde_json::to_vec(&state).unwrap())
        .await
        .unwrap();
    backup_manifest(&live, &backup).await.unwrap();
    tokio::fs::write(&live, b"corrupt").await.unwrap();
    assert!(load_manifest(&live).await.is_err());
    restore_manifest(&backup, &live).await.unwrap();
    let restored = load_manifest(&live).await.unwrap();
    assert_eq!(restored.status, DownloadStatus::Paused);
    assert_eq!(restored.segments[0].completed, 4);

    let invalid = DownloadManifest {
        schema_version: 2,
        ..state
    };
    tokio::fs::write(&live, serde_json::to_vec(&invalid).unwrap())
        .await
        .unwrap();
    assert!(load_manifest(&live).await.is_err());
}

#[tokio::test]
async fn segmented_and_fallback_downloads_are_byte_correct() {
    let payload: Vec<u8> = (0..=255).cycle().take(32_000).collect();
    for ranges in [true, false] {
        let (url, hits) = server(payload.clone(), ranges).await;
        let temp = tempfile::tempdir().unwrap();
        let result = download(&url, temp.path(), "payload.bin", 4).await.unwrap();
        assert_eq!(tokio::fs::read(result.output).await.unwrap(), payload);
        if ranges {
            assert!(hits.load(Ordering::SeqCst) >= 5);
        } else {
            assert_eq!(result.segments.len(), 1);
        }
    }
}

#[tokio::test]
async fn restart_recovers_active_manifest_and_filename_is_contained() {
    assert_eq!(sanitize_filename("../../CON.txt").unwrap(), "_CON.txt");
    assert_eq!(
        sanitize_filename("../folder/evil?.exe").unwrap(),
        "evil_.exe"
    );
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("state.json");
    let state = DownloadManifest {
        schema_version: 1,
        url: "https://example.com/a".into(),
        output: PathBuf::from("a"),
        status: DownloadStatus::Active,
        total_bytes: 10,
        segments: vec![SegmentState {
            start: 0,
            end: 9,
            completed: 4,
        }],
    };
    tokio::fs::write(&path, serde_json::to_vec(&state).unwrap())
        .await
        .unwrap();
    let recovered = load_manifest(&path).await.unwrap();
    assert_eq!(recovered.status, DownloadStatus::RecoverablyInterrupted);
    assert_eq!(recovered.segments[0].completed, 4);
}

// --- pause / resume / cancel -------------------------------------------------

use download_engine::{Control, TransferHooks, download_with_control, resume_with_control};
use tokio::sync::{mpsc, watch};

/// Serves the payload slowly enough that a pause lands mid-transfer.
async fn slow_server(payload: Vec<u8>) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(async move {
        loop {
            let Ok((mut socket, _)) = listener.accept().await else {
                break;
            };
            let body = payload.clone();
            tokio::spawn(async move {
                let mut request = vec![0; 4096];
                let read = socket.read(&mut request).await.unwrap();
                let text = String::from_utf8_lossy(&request[..read]);
                let range = text
                    .lines()
                    .find(|line| line.to_ascii_lowercase().starts_with("range:"));
                let (status, bytes, extra) = if let Some(line) = range {
                    let spec = line.split('=').nth(1).unwrap();
                    let mut bounds = spec.split('-');
                    let start: usize = bounds.next().unwrap().parse().unwrap();
                    let end: usize = bounds.next().unwrap().trim().parse().unwrap();
                    (
                        "206 Partial Content",
                        body[start..=end].to_vec(),
                        format!(
                            "Content-Range: bytes {start}-{end}/{}\r\nAccept-Ranges: bytes\r\n",
                            body.len()
                        ),
                    )
                } else {
                    ("200 OK", body.clone(), String::new())
                };
                let head = format!(
                    "HTTP/1.1 {status}\r\nContent-Length: {}\r\n{extra}Connection: close\r\n\r\n",
                    bytes.len()
                );
                socket.write_all(head.as_bytes()).await.unwrap();
                // Dribble the body out so a control signal can arrive between chunks.
                for piece in bytes.chunks(1024) {
                    if socket.write_all(piece).await.is_err() {
                        return;
                    }
                    socket.flush().await.ok();
                    tokio::time::sleep(std::time::Duration::from_millis(4)).await;
                }
            });
        }
    });
    format!("http://{address}/file.bin")
}

#[tokio::test]
async fn pause_persists_offsets_and_resume_completes_the_exact_bytes() {
    let payload: Vec<u8> = (0..=255u8).cycle().take(300_000).collect();
    let url = slow_server(payload.clone()).await;
    let temp = tempfile::tempdir().unwrap();
    let (tx, rx) = watch::channel(Control::Run);
    let (progress, mut updates) = mpsc::unbounded_channel();

    let handle = tokio::spawn({
        let folder = temp.path().to_path_buf();
        let hooks = TransferHooks::new(rx, progress);
        async move { download_with_control(&url, &folder, "payload.bin", 4, hooks).await }
    });

    tokio::time::sleep(std::time::Duration::from_millis(120)).await;
    tx.send(Control::Pause).unwrap();
    let paused = handle.await.unwrap().unwrap();

    assert_eq!(paused.status, DownloadStatus::Paused);
    let done: u64 = paused.segments.iter().map(|s| s.completed).sum();
    assert!(done > 0, "pause captured no progress at all");
    assert!(done < paused.total_bytes, "pause happened after completion");

    // Live progress must have been reported during the transfer, not just at the end.
    let mut seen = 0;
    while updates.try_recv().is_ok() {
        seen += 1;
    }
    assert!(seen > 0, "no progress updates were emitted");

    let manifest = temp.path().join("payload.sandwich.json");
    let persisted = load_manifest(&manifest).await.unwrap();
    let recorded: u64 = persisted.segments.iter().map(|s| s.completed).sum();
    assert_eq!(
        recorded, done,
        "persisted offsets disagree with returned state"
    );

    let (_keep, rx) = watch::channel(Control::Run);
    let finished = resume_with_control(
        &manifest,
        TransferHooks {
            control: Some(rx),
            progress: None,
        },
    )
    .await
    .unwrap();
    assert_eq!(finished.status, DownloadStatus::Completed);
    assert_eq!(
        tokio::fs::read(temp.path().join("payload.bin"))
            .await
            .unwrap(),
        payload,
        "resumed file does not match the source bytes"
    );
}

#[tokio::test]
async fn cancel_stops_the_transfer_and_discards_the_partial_file() {
    let payload: Vec<u8> = (0..=255u8).cycle().take(300_000).collect();
    let url = slow_server(payload).await;
    let temp = tempfile::tempdir().unwrap();
    let (tx, rx) = watch::channel(Control::Run);

    let handle = tokio::spawn({
        let folder = temp.path().to_path_buf();
        let hooks = TransferHooks {
            control: Some(rx),
            progress: None,
        };
        async move { download_with_control(&url, &folder, "payload.bin", 4, hooks).await }
    });

    tokio::time::sleep(std::time::Duration::from_millis(120)).await;
    tx.send(Control::Cancel).unwrap();
    let cancelled = handle.await.unwrap().unwrap();

    assert_eq!(cancelled.status, DownloadStatus::Cancelled);
    assert!(
        !temp.path().join("payload.sandwich-part").exists(),
        "cancel left the partial file behind"
    );
    assert!(
        !temp.path().join("payload.bin").exists(),
        "cancel produced an output file"
    );
    assert!(
        resume_with_control(
            &temp.path().join("payload.sandwich.json"),
            TransferHooks::default()
        )
        .await
        .is_err(),
        "a cancelled download must not resume"
    );
}
