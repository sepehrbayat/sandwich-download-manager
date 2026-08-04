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

    tauri_build::build()
}
