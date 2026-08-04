//! Supervises a private aria2c process and talks to it over JSON-RPC.
//!
//! aria2 owns the transfer: segmentation, resume, retries, proxies, authentication and
//! server-hostile edge cases. Sandwich owns product policy — URL and filename safety,
//! destination rules, and the queue the user sees.
//!
//! The RPC listener is bound to loopback only, on an ephemeral port, behind a per-run secret.

use serde::Deserialize;
use std::{
    hash::{BuildHasher, Hasher, RandomState},
    net::TcpListener,
    path::Path,
    process::{Child, Command, Stdio},
    time::Duration,
};

#[derive(Debug)]
pub enum Aria2Error {
    Spawn(String),
    Rpc(String),
    NotReady,
}

impl std::fmt::Display for Aria2Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Spawn(detail) => write!(f, "could not start the download engine: {detail}"),
            Self::Rpc(detail) => write!(f, "download engine rejected the request: {detail}"),
            Self::NotReady => write!(f, "the download engine did not become ready"),
        }
    }
}

/// One aria2 transfer, normalised into the shape the UI consumes.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Aria2Status {
    pub gid: String,
    pub status: String,
    #[serde(default)]
    pub total_length: String,
    #[serde(default)]
    pub completed_length: String,
    #[serde(default)]
    pub download_speed: String,
    #[serde(default)]
    pub error_message: Option<String>,
    #[serde(default)]
    pub files: Vec<Aria2File>,
}

#[derive(Debug, Deserialize)]
pub struct Aria2File {
    #[serde(default)]
    pub path: String,
}

impl Aria2Status {
    pub fn total(&self) -> u64 {
        self.total_length.parse().unwrap_or(0)
    }
    pub fn completed(&self) -> u64 {
        self.completed_length.parse().unwrap_or(0)
    }
    pub fn speed(&self) -> u64 {
        self.download_speed.parse().unwrap_or(0)
    }
    pub fn eta_seconds(&self) -> Option<u64> {
        let speed = self.speed();
        (speed > 0 && self.completed() < self.total())
            .then(|| self.total().saturating_sub(self.completed()) / speed)
    }
}

pub struct Aria2 {
    endpoint: String,
    secret: String,
    client: reqwest::Client,
    // Behind a mutex so `Aria2` stays Sync and can be shared by the commands and the
    // progress poller without serialising every RPC call.
    child: std::sync::Mutex<Option<Child>>,
}

/// 128 bits from the OS-seeded hasher std already uses to defend HashMap against collisions.
/// Avoids pulling in an RNG crate for a loopback-only secret.
fn random_secret() -> String {
    let one = RandomState::new().build_hasher().finish();
    let two = RandomState::new().build_hasher().finish();
    format!("{one:016x}{two:016x}")
}

fn free_loopback_port() -> Result<u16, Aria2Error> {
    let listener = TcpListener::bind("127.0.0.1:0")
        .map_err(|error| Aria2Error::Spawn(format!("no free local port: {error}")))?;
    let port = listener
        .local_addr()
        .map_err(|error| Aria2Error::Spawn(error.to_string()))?
        .port();
    drop(listener);
    Ok(port)
}

impl Aria2 {
    /// Starts a private aria2c and waits for it to answer.
    pub async fn start(session_dir: &Path) -> Result<Self, Aria2Error> {
        let port = free_loopback_port()?;
        let secret = random_secret();
        let session = session_dir.join("sandwich.session");
        if let Some(parent) = session.parent() {
            let _ = std::fs::create_dir_all(parent);
        }

        let mut command = Command::new("aria2c");
        command
            .arg("--enable-rpc")
            .arg("--rpc-listen-all=false")
            .arg(format!("--rpc-listen-port={port}"))
            .arg(format!("--rpc-secret={secret}"))
            // Resume and integrity.
            .arg("--continue=true")
            .arg("--auto-file-renaming=true")
            .arg("--allow-overwrite=false")
            .arg("--file-allocation=none")
            // Segmentation: this is the speed story.
            .arg("--split=8")
            .arg("--max-connection-per-server=8")
            .arg("--min-split-size=1M")
            // Resilience on poor networks.
            .arg("--max-tries=5")
            .arg("--retry-wait=3")
            .arg("--connect-timeout=15")
            .arg("--timeout=30")
            // Survive restarts: aria2 reloads unfinished transfers from this session file.
            .arg(format!("--save-session={}", session.display()))
            .arg("--save-session-interval=10")
            .arg("--auto-save-interval=10")
            .arg("--quiet=true")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped());
        if session.exists() {
            command.arg(format!("--input-file={}", session.display()));
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            command.creation_flags(CREATE_NO_WINDOW);
        }

        let child = command.spawn().map_err(|error| {
            Aria2Error::Spawn(format!(
                "{error}. Is aria2c installed and on PATH? Sandwich ships it with the installer."
            ))
        })?;

        let engine = Self {
            endpoint: format!("http://127.0.0.1:{port}/jsonrpc"),
            secret,
            client: reqwest::Client::builder()
                .timeout(Duration::from_secs(20))
                .build()
                .map_err(|error| Aria2Error::Spawn(error.to_string()))?,
            child: std::sync::Mutex::new(Some(child)),
        };

        // aria2 needs a moment to bind; poll rather than sleeping a fixed guess.
        for _ in 0..40 {
            if engine
                .call("aria2.getVersion", serde_json::json!([]))
                .await
                .is_ok()
            {
                return Ok(engine);
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        Err(Aria2Error::NotReady)
    }

    async fn call(
        &self,
        method: &str,
        params: serde_json::Value,
    ) -> Result<serde_json::Value, Aria2Error> {
        let mut full = vec![serde_json::json!(format!("token:{}", self.secret))];
        if let Some(items) = params.as_array() {
            full.extend(items.clone());
        }
        let body = serde_json::json!({
            "jsonrpc": "2.0", "id": "sandwich", "method": method, "params": full
        });
        let response = self
            .client
            .post(&self.endpoint)
            .json(&body)
            .send()
            .await
            .map_err(|error| Aria2Error::Rpc(error.to_string()))?;
        let payload: serde_json::Value = response
            .json()
            .await
            .map_err(|error| Aria2Error::Rpc(error.to_string()))?;
        if let Some(error) = payload.get("error") {
            let message = error
                .get("message")
                .and_then(|m| m.as_str())
                .unwrap_or("unknown error");
            return Err(Aria2Error::Rpc(message.to_owned()));
        }
        Ok(payload
            .get("result")
            .cloned()
            .unwrap_or(serde_json::Value::Null))
    }

    /// Queues a download and returns aria2's transfer id.
    pub async fn add_uri(
        &self,
        url: &str,
        directory: &Path,
        filename: &str,
    ) -> Result<String, Aria2Error> {
        let options = serde_json::json!({
            "dir": directory.to_string_lossy(),
            "out": filename,
        });
        let result = self
            .call("aria2.addUri", serde_json::json!([[url], options]))
            .await?;
        result
            .as_str()
            .map(str::to_owned)
            .ok_or_else(|| Aria2Error::Rpc("engine did not return a transfer id".into()))
    }

    pub async fn pause(&self, gid: &str) -> Result<(), Aria2Error> {
        self.call("aria2.pause", serde_json::json!([gid]))
            .await
            .map(|_| ())
    }

    pub async fn resume(&self, gid: &str) -> Result<(), Aria2Error> {
        self.call("aria2.unpause", serde_json::json!([gid]))
            .await
            .map(|_| ())
    }

    /// Stops a transfer and forgets it. aria2 leaves the partial file for `--continue`,
    /// so the caller decides whether to delete it.
    pub async fn cancel(&self, gid: &str) -> Result<(), Aria2Error> {
        let _ = self
            .call("aria2.forceRemove", serde_json::json!([gid]))
            .await;
        self.call("aria2.removeDownloadResult", serde_json::json!([gid]))
            .await
            .map(|_| ())
    }

    pub async fn status(&self, gid: &str) -> Result<Aria2Status, Aria2Error> {
        let result = self
            .call("aria2.tellStatus", serde_json::json!([gid]))
            .await?;
        serde_json::from_value(result).map_err(|error| Aria2Error::Rpc(error.to_string()))
    }

    /// Every transfer aria2 knows about: running, queued, and finished.
    pub async fn all(&self) -> Result<Vec<Aria2Status>, Aria2Error> {
        let mut everything = Vec::new();
        for (method, params) in [
            ("aria2.tellActive", serde_json::json!([])),
            ("aria2.tellWaiting", serde_json::json!([0, 1000])),
            ("aria2.tellStopped", serde_json::json!([0, 1000])),
        ] {
            if let Ok(result) = self.call(method, params).await {
                if let Ok(batch) = serde_json::from_value::<Vec<Aria2Status>>(result) {
                    everything.extend(batch);
                }
            }
        }
        Ok(everything)
    }

    pub async fn shutdown(&self) {
        let _ = self.call("aria2.shutdown", serde_json::json!([])).await;
    }
}

impl Drop for Aria2 {
    fn drop(&mut self) {
        // The RPC shutdown is best-effort and async; killing guarantees no orphan survives
        // the app, which is the failure users notice as "downloads kept running after I quit".
        if let Ok(mut guard) = self.child.lock() {
            if let Some(mut child) = guard.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
}
