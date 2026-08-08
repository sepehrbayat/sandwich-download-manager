<p align="center">
  <img src="assets/logo.png" alt="Sandwich Download Manager" width="390">
</p>

<p align="center">
  A free, open-source download manager for Windows, macOS and Linux.
</p>

Internet Download Manager is the tool most Windows users reach for, and it stops being free
after a trial. Sandwich is the same idea without the licence: segmented downloads, reliable
resume, and a queue that is actually pleasant to look at — free permanently, source open,
no subscription and no nag screens.

> **Status: early.** Version 0.5 is the current public Windows release. Version 0.6 adds native
> macOS/Linux packages and store-ready browser extensions; those artifacts remain prerelease
> until their native CI, signing, and store-review gates pass. Expect rough edges.

## What it does today

- **Segmented downloads** — each file is fetched over several connections at once
- **Pause, resume and cancel** that survive closing the app, losing the network, or a crash
- **A progress bar that assembles sandwiches** — cells fill left to right from real byte
  progress, each with its own filling, and the cell where bytes are landing is the one that
  pulses
- **Completion that says so** — a toast with *Open* / *Show in folder*, a native Windows
  notification when the window is in the background, and a straight answer if the file has
  since been moved or deleted
- **Batches** — a game shipped as fifty 2 GB parts goes in as one line. Paste the addresses, or
  write the range once as `game.part[01-50].rar` and let it stand for all fifty; the zero
  padding comes from the pattern rather than a separate field. Sandwich shows exactly what will
  be queued before it queues anything, names which lines it will skip and why, then puts the
  set in the queue as **one card** you can pause, resume or cancel in a single action. Expand it
  for the parts, and retry a broken one without touching the other forty-nine
- **Scheduled downloading** — set the hours transfers may run (`22:00`–`06:00`, weekdays only,
  whatever suits your connection) and how many run at once. Outside the window the queue holds
  itself, says so in the title bar, and starts on its own at the hour you named. A download you
  start by hand is still yours to start
- **Self-update** — installed copies check the latest release, verify its cryptographic
  signature against a key baked into the app, and restart into the new version with the
  queue intact
- **Dated history** — sort by newest with Today / Yesterday / This week shelves, filter by
  period
- **Five themes** — the canvas changes, the sandwich doesn't; every pairing passes WCAG AA
- **Clipboard capture** — copy a link and Sandwich offers to fetch it
- **Categories** — downloads grouped by state and file type, with live counts
- **Keyboard and screen-reader support** throughout
- **Browser integration** — an extension for Chrome, Edge and Firefox that hands downloads
  to Sandwich. With permission, it can carry the page's cookies, referrer and user agent so
  links behind a login still work
- **Direct-media action** — hover or play a direct HTTP(S) video or audio file and a
  **Download with Sandwich** action appears beside it

## What it does not do yet

Being straight about this, because these are the reasons you might stay with IDM:

- **No per-download bandwidth allocation.** Sandwich can cap total download speed, but cannot
  yet give different transfers their own limits or priorities.
- **No YouTube extraction, DRM bypass, or paywall bypass.** The listed browser extension
  handles direct media that the site exposes as an ordinary HTTP(S) file. Chrome explicitly
  rejects extensions that facilitate YouTube downloads, so claiming both unrestricted YouTube
  capture and Chrome Web Store distribution would be misleading.
- **macOS/Linux are prerelease until their native CI artifacts are signed and installed-smoked.**
  The repository has native build configurations; the current public release remains Windows.
- **Installers are not Authenticode-signed**, so Windows SmartScreen warns on first run.
  Choose *More info → Run anyway*. Updates delivered through the app **are** signed and
  verified. See [SIGNING.md](SIGNING.md) for the full picture.

## Browser extension

The extension lives in `extension/`. Separate Chrome, Edge, and Firefox packages are produced
because Firefox and Chromium use different Manifest V3 background models. Until the listings
are approved, load it unpacked for development:

1. Install and run Sandwich.
2. Chrome or Edge: open `chrome://extensions`, enable **Developer mode**, choose
   **Load unpacked**, and select the `extension` folder. Copy the extension ID it shows.
   Firefox: first package the extension and extract
   `dist/sandwich-extension-firefox-0.6.1.zip`; then open `about:debugging`, choose
   **Load Temporary Add-on**, and select `manifest.json` from the extracted folder.
3. Register the bridge so the browser is allowed to talk to Sandwich:

   ```powershell
   cd extension
   .\register-host.ps1 -ChromeExtensionId <chrome id> -EdgeExtensionId <edge id>
   ```

Downloads larger than 1 MB are then handed to Sandwich automatically, and any link can be
sent explicitly with **Download with Sandwich** in the right-click menu. If Sandwich is not
running, the browser keeps the download rather than losing it. First-run consent is required;
cookie forwarding is a separate optional choice.

## Install

Download the latest installer from the [Releases](../../releases) page and run it. The current
public Windows installer installs per-user and brings everything it needs. macOS and Linux
packages will appear there only after their native release gates pass.

## Build from source

Requires [Rust](https://rustup.rs) and Node.js.

```bash
cargo test --workspace
npx @tauri-apps/cli@2 build --config apps/desktop/tauri.conf.json --config apps/desktop/tauri.<platform>.conf.json --config apps/desktop/tauri.keyless.conf.json
```

Installers are written to `target/release/bundle/`. The `keyless` overlay skips the updater
artifacts: with an update public key in the config, Tauri refuses to build them unsigned, and
only the release machine holds the private key (see [SIGNING.md](SIGNING.md)). Your build is
a working Sandwich in every other respect.

To look at the interface without building the app:

```
node tests/frontend/serve-ui.js
```

then open <http://127.0.0.1:4317/index.html?fixture>.

## How it is put together

| Crate | Role |
|---|---|
| `apps/desktop` | Tauri application — window, commands, queue polling, update checks |
| `packages/aria2-client` | Supervises the transfer engine and speaks JSON-RPC to it |
| `packages/browser-host` | Native messaging bridge the browser extension talks to |
| `packages/download-policy` | Decides what is safe to fetch and safe to write |
| `src/` | Interface: plain HTML, CSS and ES modules, no framework |

The schedule lives in `apps/desktop/src/schedule.rs`. Its window arithmetic is pure — it is
handed the instant to judge rather than reading the clock — so overnight windows, unticked
days and daylight-saving edges are all testable without waiting for 2am. The engine reports a
scheduled pause and an abandoned one identically, so a sidecar file records which pauses were
Sandwich's own: reopening the window resumes those and nothing else, and a download the user
starts by hand is exempt until the window next opens.

Batches follow the same shape, in `apps/desktop/src/batch.rs`. aria2 has no notion of a group,
so a sidecar records which transfers belong together and the queue collapses them into one
aggregate row; a retried part keeps its place by swapping its id in the batch rather than
falling out as a loose card. Both a single download and every member of a batch are queued
through the same function, so a batch cannot quietly acquire different safety, destination or
scheduling behaviour from a download added on its own.

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

## Contributors and dedication

Sandwich is a shared open-source project shaped by its maintainers, contributors, and users.
Thank you to [Hassan Amini](https://github.com/hassan95eb) for the transfer-limit work and to
[Sajjad Dehghan](https://github.com/sedwna) for scheduling and release automation, alongside
maintainer [Sepehr Bayat](https://github.com/sepehrbayat). Their pull requests and review made
the project materially better.

We dedicate Sandwich to the global open-source community: to builders seeking the freedom to
read, change, share, and learn from code, and to everyone working toward a more just and
accessible digital world. That commitment is practical, not ceremonial—the source stays open,
contributions receive credit, and the software remains free to use.
