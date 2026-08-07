//! Native messaging host: the bridge between the browser extension and a running Sandwich.
//!
//! Chrome and Firefox launch this process themselves and speak to it over stdin/stdout using
//! their native messaging framing — a little-endian u32 length followed by that many bytes of
//! JSON. Nothing else can reach it: there is no socket and no port, which is why this exists
//! rather than a localhost HTTP endpoint that any page on the machine could post to.
//!
//! The host finds the running engine through the handoff file Sandwich writes at startup, and
//! forwards the download with the browser's own request context attached. Passing the cookies,
//! referrer and user agent along is what makes downloads behind a login work: without them the
//! origin sees an unauthenticated stranger and refuses, which is the single most common way a
//! download manager fails on a link that works fine in the browser.

use serde::{Deserialize, Serialize};
use std::io::{Read, Write};
use std::path::PathBuf;

#[derive(Deserialize)]
struct Request {
    url: String,
    #[serde(default)]
    filename: Option<String>,
    #[serde(default)]
    referrer: Option<String>,
    #[serde(default)]
    user_agent: Option<String>,
    #[serde(default)]
    cookie: Option<String>,
}

#[derive(Serialize)]
struct Response {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    gid: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

impl Response {
    fn ok(gid: String) -> Self {
        Self {
            ok: true,
            gid: Some(gid),
            error: None,
        }
    }
    fn failed(message: impl Into<String>) -> Self {
        Self {
            ok: false,
            gid: None,
            error: Some(message.into()),
        }
    }
}

#[derive(Deserialize)]
struct Handoff {
    endpoint: String,
    secret: String,
}

fn data_dir() -> PathBuf {
    if let Some(path) = std::env::var_os("SANDWICH_DATA_DIR") {
        return PathBuf::from(path);
    }
    dirs::data_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join("dev.sandwich.download-manager")
}

fn is_restricted_store_url(value: &str) -> bool {
    let Ok(parsed) = url::Url::parse(value) else {
        return false;
    };
    let host = parsed.host_str().unwrap_or_default().to_ascii_lowercase();
    host == "youtu.be" || host == "youtube.com" || host.ends_with(".youtube.com")
}

fn safe_header_value(value: &str) -> Option<&str> {
    (!value.is_empty() && !value.contains(['\r', '\n'])).then_some(value)
}

fn read_handoff() -> Option<Handoff> {
    let raw = std::fs::read_to_string(data_dir().join("engine.json")).ok()?;
    serde_json::from_str(&raw).ok()
}

/// Reads one native-messaging frame. Returns None on a clean end of stream.
///
/// `first` is true for the first frame on the stream: some hosts prepend a UTF-8 byte order
/// mark to a child's stdin (Windows PowerShell 5.1 does, via .NET Framework), and read as a
/// length prefix those three bytes turn the real header into a gigabyte-sized nonsense frame.
/// Browsers never send one, but a host this small costs nothing to make scriptable.
fn read_frame(input: &mut impl Read, first: bool) -> Option<Vec<u8>> {
    let mut header = [0u8; 4];
    input.read_exact(&mut header).ok()?;
    if first && header[..3] == [0xEF, 0xBB, 0xBF] {
        let mut rest = [0u8; 3];
        input.read_exact(&mut rest).ok()?;
        header = [header[3], rest[0], rest[1], rest[2]];
    }
    let length = u32::from_le_bytes(header) as usize;
    // Browsers cap outgoing messages at 1 MB; anything larger is not from a browser.
    if length == 0 || length > 1024 * 1024 {
        return None;
    }
    let mut body = vec![0u8; length];
    input.read_exact(&mut body).ok()?;
    Some(body)
}

fn write_frame(output: &mut impl Write, value: &Response) {
    let Ok(body) = serde_json::to_vec(value) else {
        return;
    };
    let _ = output.write_all(&(body.len() as u32).to_le_bytes());
    let _ = output.write_all(&body);
    let _ = output.flush();
}

/// Hands one download to the engine, carrying the browser's request context with it.
fn queue(handoff: &Handoff, request: &Request) -> Result<String, String> {
    // Sandwich owns URL and filename policy no matter who submits the download. The browser
    // is not a trusted source of filenames: a hostile site chooses Content-Disposition.
    download_policy::validate_url(&request.url).map_err(|error| error.to_string())?;
    if is_restricted_store_url(&request.url)
        || request
            .referrer
            .as_deref()
            .is_some_and(is_restricted_store_url)
    {
        return Err("YouTube is not available in the store build".to_owned());
    }

    let mut headers: Vec<String> = Vec::new();
    if let Some(referrer) = request.referrer.as_deref().and_then(safe_header_value) {
        headers.push(format!("Referer: {referrer}"));
    }
    if let Some(cookie) = request.cookie.as_deref().and_then(safe_header_value) {
        headers.push(format!("Cookie: {cookie}"));
    }

    let mut options = serde_json::Map::new();
    if !headers.is_empty() {
        options.insert("header".into(), serde_json::json!(headers));
    }
    if let Some(agent) = request
        .user_agent
        .as_ref()
        .and_then(|value| safe_header_value(value))
    {
        options.insert("user-agent".into(), serde_json::json!(agent));
    }
    if let Some(name) = request.filename.as_deref() {
        let safe = download_policy::sanitize_filename(name).map_err(|error| error.to_string())?;
        options.insert("out".into(), serde_json::json!(safe));
    }

    let body = serde_json::json!({
        "jsonrpc": "2.0",
        "id": "sandwich-browser",
        "method": "aria2.addUri",
        "params": [
            format!("token:{}", handoff.secret),
            [request.url.clone()],
            options,
        ]
    });

    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|error| error.to_string())?;
    let response: serde_json::Value = client
        .post(&handoff.endpoint)
        .json(&body)
        .send()
        .map_err(|_| "Sandwich is not running".to_owned())?
        .json()
        .map_err(|error| error.to_string())?;

    if let Some(error) = response.get("error") {
        return Err(error
            .get("message")
            .and_then(|value| value.as_str())
            .unwrap_or("the engine rejected the download")
            .to_owned());
    }
    response
        .get("result")
        .and_then(|value| value.as_str())
        .map(str::to_owned)
        .ok_or_else(|| "the engine returned no download id".to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn store_host_blocks_youtube_without_blocking_similar_names() {
        assert!(is_restricted_store_url("https://www.youtube.com/watch?v=1"));
        assert!(is_restricted_store_url("https://youtu.be/abc"));
        assert!(!is_restricted_store_url("https://notyoutube.com/file.mp4"));
    }

    #[test]
    fn native_headers_cannot_add_another_header() {
        assert_eq!(safe_header_value("session=one"), Some("session=one"));
        assert_eq!(safe_header_value("session=one\r\nX-Evil: yes"), None);
    }
}

fn main() {
    let mut input = std::io::stdin().lock();
    let mut output = std::io::stdout().lock();

    let mut first = true;
    while let Some(frame) = read_frame(&mut input, std::mem::take(&mut first)) {
        let response = match serde_json::from_slice::<Request>(&frame) {
            Err(error) => Response::failed(format!("malformed request: {error}")),
            Ok(request) => match read_handoff() {
                None => Response::failed("Sandwich is not running"),
                Some(handoff) => match queue(&handoff, &request) {
                    Ok(gid) => Response::ok(gid),
                    Err(error) => Response::failed(error),
                },
            },
        };
        write_frame(&mut output, &response);
    }
}
