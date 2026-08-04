# Sandwich Download Manager

A free, open-source download manager for Windows.

Internet Download Manager is the tool most Windows users reach for, and it stops being free
after a trial. Sandwich is the same idea without the licence: segmented downloads, reliable
resume, and a queue that is actually pleasant to look at — free permanently, source open,
no subscription and no nag screens.

> **Status: early.** Version 0.1 runs, downloads, and has handled multi-gigabyte transfers,
> but it is not yet signed and has been tested by very few people. Expect rough edges.

## What it does today

- **Segmented downloads** — each file is fetched over several connections at once
- **Pause, resume and cancel** that survive closing the app, losing the network, or a crash
- **A live segment map** — the progress bar shows which pieces of the file have actually
  landed, not just an estimate
- **Clipboard capture** — copy a link and Sandwich offers to fetch it
- **Categories** — downloads grouped by state and file type, with live counts
- **Keyboard and screen-reader support** throughout
- **Browser integration** — an extension for Chrome, Edge and Firefox that hands downloads
  to Sandwich, carrying the page's cookies, referrer and user agent so links behind a login
  still work

## What it does not do yet

Being straight about this, because these are the reasons you might stay with IDM:

- **No scheduler or bandwidth limiting.**
- **No video capture from streaming sites.** A deliberate exclusion, not an oversight.
- **Windows only.** The core is portable; macOS and Linux come after Windows is solid.
- **Not code-signed**, so Windows SmartScreen will warn on first run. Choose
  *More info → Run anyway*. Signing is planned.

## Browser extension

The extension lives in `extension/`. It is not in the web stores yet, so it is loaded
unpacked:

1. Install and run Sandwich.
2. Chrome or Edge: open `chrome://extensions`, enable **Developer mode**, choose
   **Load unpacked**, and select the `extension` folder. Copy the extension ID it shows.
   Firefox: open `about:debugging`, choose **Load Temporary Add-on**, and select
   `extension/manifest.json`.
3. Register the bridge so the browser is allowed to talk to Sandwich:

   ```
   cd extension
   .egister-host.ps1 -ChromeExtensionId <the id from step 2>
   ```

Downloads larger than 1 MB are then handed to Sandwich automatically, and any link can be
sent explicitly with **Download with Sandwich** in the right-click menu. If Sandwich is not
running, the browser keeps the download rather than losing it.

## Install

Download the latest installer from the [Releases](../../releases) page and run it. It installs
per-user, so it does not ask for administrator rights, and it brings everything it needs.

## Build from source

Requires [Rust](https://rustup.rs) and Node.js.

```
cargo test --workspace
npx @tauri-apps/cli@2 build --config apps/desktop/tauri.conf.json
```

Installers are written to `target/release/bundle/`.

To look at the interface without building the app:

```
node tests/frontend/serve-ui.js
```

then open <http://127.0.0.1:4317/index.html?fixture>.

## How it is put together

| Crate | Role |
|---|---|
| `apps/desktop` | Tauri application — window, commands, queue polling |
| `packages/aria2-client` | Supervises the transfer engine and speaks JSON-RPC to it |
| `packages/download-policy` | Decides what is safe to fetch and safe to write |
| `src/` | Interface: plain HTML, CSS and ES modules, no framework |

Transfers are performed by [aria2](https://aria2.github.io/), which has handled proxies,
redirects, retries and resume for fifteen years. Sandwich deliberately keeps one thing to
itself: **URL and filename policy**. aria2 will write whatever filename it is told to, so
path traversal and Windows reserved device names are defused before a transfer is ever
queued, with tests covering each case.

## Licence

Sandwich is released under the **GPL-3.0**. That is a deliberate choice rather than a default:
a permissive licence would let someone take this, close the source, and sell it — recreating
exactly the paid product this exists to replace. Derivatives have to stay open.

The bundled aria2 binary is GPL-2.0-or-later and links OpenSSL; its licence texts ship
alongside it in `apps/desktop/binaries/`.

## Contributing

Issues and pull requests are welcome. The most useful contribution right now is simply
running it and reporting what breaks.
