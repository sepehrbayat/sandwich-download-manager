use std::path::Path;

fn main() {
    // Cargo has no idea the frontend exists, so editing the UI did not rebuild the binary: the
    // app kept running a stale copy of the embedded assets and UI fixes appeared to do nothing.
    // Watch the frontend explicitly so changing it triggers a re-embed.
    let frontend = Path::new("../../src");
    println!("cargo:rerun-if-changed={}", frontend.display());
    if let Ok(entries) = std::fs::read_dir(frontend) {
        for entry in entries.flatten() {
            println!("cargo:rerun-if-changed={}", entry.path().display());
        }
    }

    stage_browser_host();

    tauri_build::build()
}

/// Copies the freshly built browser bridge next to the other bundled binaries.
///
/// The bridge is a separate crate, so nothing would otherwise place it where `bundle.resources`
/// expects it and the installer shipped without it — browser integration was dead on every
/// installed copy while working perfectly from a development tree. Doing the copy here rather
/// than in `beforeBuildCommand` keeps it out of a shell: the quoting of a chained PowerShell
/// copy did not survive the round trip and the command was echoed instead of run.
fn stage_browser_host() {
    let source = Path::new("../../target/release/sandwich-browser-host.exe");
    let destination = Path::new("binaries/sandwich-browser-host.exe");
    println!("cargo:rerun-if-changed={}", source.display());

    if !source.exists() {
        // A debug build of the desktop app alone is a normal thing to do, and the bundle is not
        // being produced, so a missing bridge is not an error here. The release path is covered:
        // `beforeBuildCommand` builds the bridge before the bundle asks for the resource.
        println!("cargo:warning=browser bridge not built yet; skipping bundle staging");
        return;
    }
    if let Some(parent) = destination.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Err(error) = std::fs::copy(source, destination) {
        // Windows refuses to overwrite a running executable. Say which file, because the
        // bundle failure it causes names only the resource path.
        println!("cargo:warning=could not stage {}: {error}", source.display());
    }
}
