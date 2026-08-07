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
    path::{Path, PathBuf},
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
    /// aria2's numeric exit code for the transfer, as a string ("3" = not found, "9" = disk
    /// full, "24" = authorization failed…). The message alone is not enough for the UI to
    /// explain failures in words a person can act on.
    #[serde(default)]
    pub error_code: Option<String>,
    #[serde(default)]
    pub error_message: Option<String>,
    #[serde(default)]
    pub files: Vec<Aria2File>,
    /// Hex piece map: which chunks of the file are already on disk. This is what makes the
    /// segmented progress view real rather than decorative.
    #[serde(default)]
    pub bitfield: String,
    #[serde(default)]
    pub num_pieces: String,
    #[serde(default)]
    pub piece_length: String,
    #[serde(default)]
    pub connections: String,
    #[serde(default)]
    pub dir: String,
}

#[derive(Debug, Deserialize)]
pub struct Aria2File {
    #[serde(default)]
    pub path: String,
    #[serde(default)]
    pub uris: Vec<Aria2Uri>,
}

#[derive(Debug, Deserialize)]
pub struct Aria2Uri {
    #[serde(default)]
    pub uri: String,
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
    pub fn pieces(&self) -> u32 {
        self.num_pieces.parse().unwrap_or(0)
    }
    pub fn connection_count(&self) -> u32 {
        self.connections.parse().unwrap_or(0)
    }
    pub fn source_url(&self) -> String {
        self.files
            .first()
            .and_then(|file| file.uris.first())
            .map(|uri| uri.uri.clone())
            .unwrap_or_default()
    }
    pub fn eta_seconds(&self) -> Option<u64> {
        let speed = self.speed();
        (speed > 0 && self.completed() < self.total())
            .then(|| self.total().saturating_sub(self.completed()) / speed)
    }
}

/// Ties the engine's process tree to this process's lifetime.
///
/// `Drop` is not sufficient: Tauri exits without unwinding, and a force-kill or crash never
/// runs destructors at all. Both leak an aria2 that keeps downloading invisibly. A Job Object
/// makes the kernel do the cleanup — when this process dies for any reason its handles close,
/// and `KILL_ON_JOB_CLOSE` terminates every process in the job, grandchildren included. That
/// matters here because `aria2c` on PATH is often a shim that spawns the real binary.
#[cfg(windows)]
mod job {
    use std::io;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
        SetInformationJobObject,
    };
    use windows_sys::Win32::System::Threading::{
        OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE,
    };

    pub struct ProcessTree(HANDLE);

    // The handle is only closed in Drop and never dereferenced elsewhere.
    unsafe impl Send for ProcessTree {}
    unsafe impl Sync for ProcessTree {}

    impl ProcessTree {
        pub fn capture(pid: u32) -> io::Result<Self> {
            unsafe {
                let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
                if job.is_null() {
                    return Err(io::Error::last_os_error());
                }
                let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
                limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                let ok = SetInformationJobObject(
                    job,
                    JobObjectExtendedLimitInformation,
                    &limits as *const _ as *const _,
                    size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                );
                if ok == 0 {
                    let error = io::Error::last_os_error();
                    CloseHandle(job);
                    return Err(error);
                }
                let process = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid);
                if process.is_null() {
                    let error = io::Error::last_os_error();
                    CloseHandle(job);
                    return Err(error);
                }
                let assigned = AssignProcessToJobObject(job, process);
                CloseHandle(process);
                if assigned == 0 {
                    let error = io::Error::last_os_error();
                    CloseHandle(job);
                    return Err(error);
                }
                Ok(Self(job))
            }
        }
    }

    impl Drop for ProcessTree {
        fn drop(&mut self) {
            unsafe { CloseHandle(self.0) };
        }
    }
}

/// Browser-compatible, with Sandwich identified at the end so operators can still see who we
/// are in their logs.
const USER_AGENT: &str = "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Sandwich/0.6";

/// Where transfers land when no destination is supplied.
fn default_download_dir() -> PathBuf {
    dirs::download_dir()
        .filter(|path| path.is_dir())
        .unwrap_or_else(std::env::temp_dir)
}

pub struct Aria2 {
    endpoint: String,
    secret: String,
    client: reqwest::Client,
    // Behind a mutex so `Aria2` stays Sync and can be shared by the commands and the
    // progress poller without serialising every RPC call.
    child: std::sync::Mutex<Option<Child>>,
    // Held for the process lifetime; closing it is what kills the engine tree.
    #[cfg(windows)]
    _tree: Option<job::ProcessTree>,
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
    /// Where this engine is listening, and the token needed to talk to it.
    pub fn connection(&self) -> (&str, &str) {
        (&self.endpoint, &self.secret)
    }

    /// Starts a private aria2c and waits for it to answer.
    ///
    /// `engine` is the binary to run. Callers pass the copy shipped beside the app so an
    /// installed Sandwich does not depend on the user happening to have aria2 on PATH.
    pub async fn start_with(engine: &Path, session_dir: &Path) -> Result<Self, Aria2Error> {
        Self::launch(engine.as_os_str().to_owned(), session_dir).await
    }

    /// Starts a private aria2c and waits for it to answer.
    pub async fn start(session_dir: &Path) -> Result<Self, Aria2Error> {
        Self::launch("aria2c".into(), session_dir).await
    }

    async fn launch(program: std::ffi::OsString, session_dir: &Path) -> Result<Self, Aria2Error> {
        let port = free_loopback_port()?;
        let secret = random_secret();
        let session = session_dir.join("sandwich.session");
        if let Some(parent) = session.parent() {
            let _ = std::fs::create_dir_all(parent);
        }

        let mut command = Command::new(&program);
        command
            .arg("--enable-rpc")
            .arg("--rpc-listen-all=false")
            .arg(format!("--rpc-listen-port={port}"))
            .arg(format!("--rpc-secret={secret}"))
            // Resume and integrity.
            // Without an explicit default, aria2 writes to its working directory — which for an
            // installed app is the install folder. Every path through the UI supplies a
            // destination, but a default that lands in Program Files is not one to rely on.
            .arg(format!("--dir={}", default_download_dir().display()))
            .arg("--continue=true")
            .arg("--auto-file-renaming=true")
            .arg("--allow-overwrite=false")
            .arg("--file-allocation=none")
            // Segmentation: this is the speed story.
            .arg("--split=8")
            .arg("--max-connection-per-server=8")
            .arg("--min-split-size=1M")
            // Resilience on poor networks.
            // Many origins reject unfamiliar agents outright: the same URL that works in a
            // browser returns 403 to aria2's default string. Presenting a browser-compatible
            // agent is what every download manager does, and without it a sizeable share of
            // real links simply fail.
            .arg(format!("--user-agent={USER_AGENT}"))
            .arg("--http-accept-gzip=true")
            // Keep the origin's timestamp on the finished file rather than "now".
            .arg("--remote-time=true")
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

        // Capture the engine's whole tree before it can spawn anything we would lose track of.
        #[cfg(windows)]
        let tree = match job::ProcessTree::capture(child.id()) {
            Ok(tree) => Some(tree),
            Err(error) => {
                eprintln!("could not contain the engine process tree: {error}");
                None
            }
        };

        let engine = Self {
            endpoint: format!("http://127.0.0.1:{port}/jsonrpc"),
            secret,
            client: reqwest::Client::builder()
                .timeout(Duration::from_secs(20))
                .build()
                .map_err(|error| Aria2Error::Spawn(error.to_string()))?,
            #[cfg(windows)]
            _tree: tree,
            child: std::sync::Mutex::new(Some(child)),
        };

        // aria2 normally binds in well under a second, but the first launch of a newly
        // installed executable can spend several seconds in antivirus inspection on Windows.
        // Four seconds proved too short on clean hosted runners: the UI opened, then Sandwich
        // killed an otherwise healthy engine just before it became ready. Keep polling with a
        // finite ceiling so slow machines get a working download manager without hiding a
        // genuinely broken sidecar forever.
        for _ in 0..150 {
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
        let result = self
            .call("aria2.removeDownloadResult", serde_json::json!([gid]))
            .await
            .map(|_| ());
        // Flush immediately: the periodic save runs every 10 s, and this process only ever
        // dies by Job Object kill. A cancel inside that window would otherwise be undone on
        // the next launch — cancelled downloads resurrecting, still downloading.
        self.save_session().await;
        result
    }

    /// Changes an engine-wide option on the running process.
    ///
    /// Used for `max-concurrent-downloads`, which the schedule owns. Note that aria2 applies a
    /// *lowered* limit only to transfers that have not started yet — already-active ones keep
    /// running past the new cap until something forces a recalculation. Callers that need the
    /// limit honoured immediately have to nudge the excess themselves; see `renegotiate`.
    pub async fn change_global_option(&self, key: &str, value: &str) -> Result<(), Aria2Error> {
        self.set_global_options(serde_json::json!({ key: value }))
            .await
    }

    /// Applies a group of global options to the running engine in one RPC call.
    ///
    /// aria2 accepts the total speed ceiling live, so changing it does not require restarting
    /// the engine and interrupting every transfer already in progress.
    pub async fn set_global_options(&self, options: serde_json::Value) -> Result<(), Aria2Error> {
        self.call("aria2.changeGlobalOption", serde_json::json!([options]))
            .await
            .map(|_| ())
    }

    /// The engine's current global options, kept as strings exactly as aria2 reports them.
    pub async fn global_options(&self) -> Result<serde_json::Value, Aria2Error> {
        self.call("aria2.getGlobalOption", serde_json::json!([]))
            .await
    }

    /// Puts a running transfer back through the engine's queueing decision.
    ///
    /// aria2 re-evaluates `max-concurrent-downloads` when a transfer is unpaused, and only
    /// then. A pause immediately followed by an unpause therefore demotes a download that is
    /// over a freshly lowered cap to waiting, while leaving it queued and resumable — which is
    /// what "run 2 at a time" has to mean for downloads that were already running when the
    /// setting changed.
    pub async fn renegotiate(&self, gid: &str) -> Result<(), Aria2Error> {
        self.pause(gid).await?;
        self.resume(gid).await
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

    /// Asks the engine to write its session file right now.
    ///
    /// The periodic save (`--save-session-interval`) leaves a window: anything removed or
    /// finished in the last few seconds is lost if the process is killed before the next
    /// tick — and the Job Object kill on app exit guarantees exactly that. Ghost downloads
    /// then resurrect on the next launch and quietly occupy transfer slots.
    pub async fn save_session(&self) {
        let _ = self.call("aria2.saveSession", serde_json::json!([])).await;
    }

    pub async fn shutdown(&self) {
        // Save first: shutdown also saves, but if it stalls waiting on a slow tracker the
        // session is already safe on disk before the backstop kill lands.
        self.save_session().await;
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
