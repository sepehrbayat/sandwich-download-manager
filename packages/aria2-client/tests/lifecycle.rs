//! End-to-end proof that the aria2-backed engine actually transfers, pauses, resumes and
//! cancels. These drive a real aria2c process against a real HTTP server on loopback.
//!
//! Skipped automatically when aria2c is not installed, so the suite stays green on a machine
//! without it rather than failing for an environmental reason.

use std::{
    io::{Read, Write},
    net::TcpListener,
    path::PathBuf,
    process::Command,
    time::Duration,
};

fn aria2_available() -> bool {
    Command::new("aria2c")
        .arg("--version")
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

/// Serves `payload` with Range support, dribbled out slowly so a pause lands mid-transfer.
fn slow_range_server(payload: Vec<u8>) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut socket) = stream else { break };
            let body = payload.clone();
            std::thread::spawn(move || {
                let mut request = vec![0u8; 4096];
                let read = socket.read(&mut request).unwrap_or(0);
                let text = String::from_utf8_lossy(&request[..read]);
                let range = text
                    .lines()
                    .find(|line| line.to_ascii_lowercase().starts_with("range:"))
                    .and_then(|line| line.split('=').nth(1).map(str::trim).map(str::to_owned));
                let (status, bytes, extra) = match range {
                    Some(spec) => {
                        let mut bounds = spec.split('-');
                        let start: usize = bounds.next().unwrap_or("0").parse().unwrap_or(0);
                        let end: usize = bounds
                            .next()
                            .and_then(|value| value.parse().ok())
                            .unwrap_or(body.len().saturating_sub(1))
                            .min(body.len().saturating_sub(1));
                        (
                            "206 Partial Content",
                            body[start..=end].to_vec(),
                            format!(
                                "Content-Range: bytes {start}-{end}/{}\r\nAccept-Ranges: bytes\r\n",
                                body.len()
                            ),
                        )
                    }
                    None => (
                        "200 OK",
                        body.clone(),
                        "Accept-Ranges: bytes\r\n".to_owned(),
                    ),
                };
                let head = format!(
                    "HTTP/1.1 {status}\r\nContent-Length: {}\r\n{extra}Connection: close\r\n\r\n",
                    bytes.len()
                );
                if socket.write_all(head.as_bytes()).is_err() {
                    return;
                }
                for piece in bytes.chunks(16 * 1024) {
                    if socket.write_all(piece).is_err() {
                        return;
                    }
                    let _ = socket.flush();
                    std::thread::sleep(Duration::from_millis(15));
                }
            });
        }
    });
    format!("http://{address}/payload.bin")
}

use aria2_client::Aria2;

#[tokio::test]
async fn transfers_pause_resume_and_complete_with_correct_bytes() {
    if !aria2_available() {
        eprintln!("skipping: aria2c not installed");
        return;
    }
    let payload: Vec<u8> = (0..=255u8).cycle().take(2_000_000).collect();
    let url = slow_range_server(payload.clone());
    let temp = std::env::temp_dir().join(format!("sandwich-aria2-{}", std::process::id()));
    let _ = std::fs::create_dir_all(&temp);

    let engine = Aria2::start(&temp).await.expect("engine should start");
    let gid = engine
        .add_uri(&url, &temp, "payload.bin")
        .await
        .expect("download should queue");

    // Let some bytes land, then pause and confirm progress stopped short of completion.
    let mut progressed = 0u64;
    for _ in 0..40 {
        tokio::time::sleep(Duration::from_millis(100)).await;
        let status = engine.status(&gid).await.expect("status");
        progressed = status.completed();
        if progressed > 0 && progressed < status.total() {
            break;
        }
    }
    assert!(progressed > 0, "no bytes were transferred");

    engine.pause(&gid).await.expect("pause should be accepted");
    tokio::time::sleep(Duration::from_millis(400)).await;
    let paused = engine.status(&gid).await.expect("status after pause");
    assert_eq!(
        paused.status, "paused",
        "engine did not report a paused transfer"
    );
    let at_pause = paused.completed();
    assert!(
        at_pause > 0 && at_pause < paused.total(),
        "pause did not land mid-transfer"
    );

    engine
        .resume(&gid)
        .await
        .expect("resume should be accepted");
    let mut finished = false;
    for _ in 0..150 {
        tokio::time::sleep(Duration::from_millis(200)).await;
        let status = engine.status(&gid).await.expect("status while resuming");
        if status.status == "complete" {
            finished = true;
            break;
        }
        if status.status == "error" {
            panic!("transfer failed: {:?}", status.error_message);
        }
    }
    assert!(finished, "resumed transfer never completed");

    let written = std::fs::read(PathBuf::from(&temp).join("payload.bin")).expect("output file");
    assert_eq!(
        written, payload,
        "resumed file does not match the source bytes"
    );

    let _ = std::fs::remove_dir_all(&temp);
}

#[tokio::test]
async fn cancel_stops_a_transfer() {
    if !aria2_available() {
        eprintln!("skipping: aria2c not installed");
        return;
    }
    let payload: Vec<u8> = (0..=255u8).cycle().take(2_000_000).collect();
    let url = slow_range_server(payload);
    let temp = std::env::temp_dir().join(format!("sandwich-aria2-cancel-{}", std::process::id()));
    let _ = std::fs::create_dir_all(&temp);

    let engine = Aria2::start(&temp).await.expect("engine should start");
    let gid = engine
        .add_uri(&url, &temp, "payload.bin")
        .await
        .expect("download should queue");
    tokio::time::sleep(Duration::from_millis(500)).await;

    engine
        .cancel(&gid)
        .await
        .expect("cancel should be accepted");
    tokio::time::sleep(Duration::from_millis(300)).await;

    // A cancelled transfer is forgotten: aria2 no longer reports it at all.
    let remaining = engine.all().await.expect("listing");
    assert!(
        !remaining
            .iter()
            .any(|status| status.gid == gid && status.status == "active"),
        "cancelled transfer is still active"
    );

    let _ = std::fs::remove_dir_all(&temp);
}

#[tokio::test]
async fn a_cancel_reaches_disk_before_any_shutdown() {
    // The engine only ever dies by Job Object kill - there is no graceful exit in
    // production. So a cancel must be IN THE SESSION FILE the moment the call returns:
    // waiting for the 10-second periodic save left a window where killing the app undid
    // the cancel, and the download came back from the dead on the next launch, still
    // transferring. This test reads the file straight after cancel(), no shutdown, no
    // waiting, exactly like a kill at the worst moment.
    if !aria2_available() {
        eprintln!("skipping: aria2c not installed");
        return;
    }
    let payload: Vec<u8> = (0..=255u8).cycle().take(2_000_000).collect();
    let url = slow_range_server(payload);
    let temp =
        std::env::temp_dir().join(format!("sandwich-aria2-cancelflush-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&temp);
    let _ = std::fs::create_dir_all(&temp);

    let engine = Aria2::start(&temp).await.expect("engine should start");
    let gid = engine
        .add_uri(&url, &temp, "payload.bin")
        .await
        .expect("download should queue");
    tokio::time::sleep(Duration::from_millis(500)).await;

    // Baseline: put the active download IN the file first. Without this the test passes
    // vacuously before the first periodic save, fix or no fix, because an absent session
    // file contains nothing.
    engine.save_session().await;
    let baseline = std::fs::read_to_string(temp.join("sandwich.session")).unwrap_or_default();
    assert!(
        baseline.contains("payload.bin"),
        "baseline save should record the active download"
    );

    engine
        .cancel(&gid)
        .await
        .expect("cancel should be accepted");

    let session = std::fs::read_to_string(temp.join("sandwich.session")).unwrap_or_default();
    assert!(
        !session.contains("payload.bin"),
        "a killed process would resurrect this cancelled download; session still holds it:\n{session}"
    );

    let _ = std::fs::remove_dir_all(&temp);
}
