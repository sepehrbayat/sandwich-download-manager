//! Safety policy tests.
//!
//! These cover the decisions Sandwich makes *before* handing a transfer to aria2. aria2 will
//! happily write whatever filename it is told to, so these are the protections that stop a
//! hostile server from choosing a path on the user's disk.

use download_policy::{DownloadStatus, sanitize_filename, validate_url};

#[test]
fn only_plain_http_and_https_urls_are_accepted() {
    assert!(validate_url("https://example.com/file.bin").is_ok());
    assert!(validate_url("http://example.com/file.bin").is_ok());

    // Non-web schemes could reach the local filesystem or arbitrary services.
    assert!(validate_url("file:///C:/Windows/System32/config/SAM").is_err());
    assert!(validate_url("ftp://example.com/file.bin").is_err());
    assert!(validate_url("javascript:alert(1)").is_err());
    assert!(validate_url("not a url at all").is_err());

    // Credentials in the URL would be persisted into the queue and the aria2 session file.
    assert!(validate_url("https://user:secret@example.com/file.bin").is_err());
    assert!(validate_url("https://user@example.com/file.bin").is_err());
}

#[test]
fn filenames_cannot_escape_the_destination_folder() {
    assert_eq!(sanitize_filename("../../etc/passwd").unwrap(), "passwd");
    assert_eq!(
        sanitize_filename("..\\..\\Windows\\win.ini").unwrap(),
        "win.ini"
    );
    assert_eq!(
        sanitize_filename("/absolute/path/file.zip").unwrap(),
        "file.zip"
    );

    // Characters Windows forbids in a filename.
    assert_eq!(sanitize_filename("evil?.exe").unwrap(), "evil_.exe");

    // A bare traversal token leaves no usable name, so it falls back to a safe default
    // rather than failing: the user still gets the file, just not at a path they did not pick.
    assert_eq!(sanitize_filename("..").unwrap(), "download");
    assert_eq!(sanitize_filename("../..").unwrap(), "download");
}

#[test]
fn windows_reserved_device_names_are_defused() {
    // Writing to CON, PRN, NUL and friends targets a device, not a file.
    assert_eq!(sanitize_filename("../../CON.txt").unwrap(), "_CON.txt");
    assert_eq!(sanitize_filename("COM1").unwrap(), "_COM1");
    assert_eq!(sanitize_filename("LPT9.dat").unwrap(), "_LPT9.dat");

    // A name that merely begins with a reserved word is legitimate.
    assert_eq!(sanitize_filename("console.log").unwrap(), "console.log");
}

#[test]
fn an_unusable_name_still_yields_something_writable() {
    assert_eq!(sanitize_filename("").unwrap(), "download");
    assert_eq!(sanitize_filename("   ").unwrap(), "download");
}

#[test]
fn the_status_vocabulary_matches_what_the_ui_renders() {
    // The UI has a label for exactly these seven states. Adding one here without adding a
    // label there would render a raw enum name to the user.
    let all = [
        DownloadStatus::Queued,
        DownloadStatus::Active,
        DownloadStatus::Paused,
        DownloadStatus::RecoverablyInterrupted,
        DownloadStatus::Failed,
        DownloadStatus::Cancelled,
        DownloadStatus::Completed,
    ];
    let serialised: Vec<String> = all
        .iter()
        .map(|status| {
            serde_json::to_string(status)
                .unwrap()
                .trim_matches('"')
                .to_owned()
        })
        .collect();
    assert_eq!(
        serialised,
        [
            "queued",
            "active",
            "paused",
            "recoverably_interrupted",
            "failed",
            "cancelled",
            "completed"
        ]
    );
}
