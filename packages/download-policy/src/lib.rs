//! Sandwich's download *policy*: what is safe to fetch and safe to write.
//!
//! The transfer itself is performed by aria2 (see the `aria2-client` crate). This crate
//! deliberately keeps ownership of URL and filename safety, because delegating filename
//! derivation to the transfer engine would silently drop the traversal and Windows
//! reserved-name protections the tests below pin down.

use serde::{Deserialize, Serialize};
use thiserror::Error;
use url::Url;

#[derive(Debug, Error)]
pub enum EngineError {
    #[error("only HTTP and HTTPS download URLs are supported")]
    UnsafeUrl,
    #[error("unsafe destination or filename")]
    UnsafePath,
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
