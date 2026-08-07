# Architecture decisions

## ADR-0001: Store-safe media capture and platform-specific desktop bundles

**Status:** Accepted

**Date:** 2026-08-07

**Deciders:** Sepehr Bayat and project maintainers

### Context

Sandwich must add a visible action for playable media, ship its extension in Chrome, Edge, and
Firefox, and produce desktop packages for Windows, macOS, and Linux.

The stores impose a hard boundary. Chrome's enforcement guidance names facilitating YouTube
downloads as a rejection reason. YouTube permits downloading only when the service, the rights
holder, or applicable law allows it. Microsoft also forbids enabling unauthorized downloads of
copyrighted media. One unrestricted package would put all store listings and their developer
accounts at risk.

The original desktop bundle was Windows-specific: `.exe` resources, MSI/NSIS-only targets, and
Windows environment variables in the native host.

### Decision

1. The listed extension exposes **Download with Sandwich** only for a direct HTTP(S) source on
   an HTML video or audio element. It does not bypass DRM, decrypt manifests, bypass paywalls, or
   extract YouTube.
2. YouTube is denied in the content script, background worker, and native host. A context-menu
   or forged extension message cannot accidentally re-enable it.
3. Automatic interception and cookie forwarding require an informed first-run choice. Cookies
   are optional and travel only to the local native app for that transfer.
4. Any future community media helper must be separately packaged, require an explicit
   ownership/licence attestation, and remain non-DRM. It is not a store artifact.
5. Tauri uses a common config plus `tauri.windows.conf.json`, `tauri.macos.conf.json`, and
   `tauri.linux.conf.json`. Each native runner packages its own aria2 and browser-host binaries.
6. macOS/Linux releases must pass native-runner tests, resource inspection, and installed or
   sandboxed smoke checks. A public macOS release also requires Apple signing and notarization.

### Options considered

| Option | Complexity | Store acceptance | Result |
|---|---:|---:|---|
| One unrestricted extension | Medium | Unacceptable | Rejected |
| Store-safe direct media plus separate community capability | Medium | Best available | Selected |
| Desktop-only URL input | Low | High | Rejected: poor media UX |

### Consequences

- Ordinary direct MP4, WebM, MP3, Ogg, and similar HTTP(S) media can be handed to Sandwich.
- Blob URLs, encrypted media, muxer-dependent manifests, and YouTube pages are not advertised as
  downloadable by the store build.
- Firefox gets a background page; Chromium gets a service worker. Separate artifacts prevent
  either store from receiving a knowingly incompatible manifest.
- Chrome and Edge assign different listing IDs. Those IDs must be added to native-host manifests
  after store drafts are created and before the final signed desktop release.
- Apple Developer membership and a signing identity are release gates, not build gates.

### Delivery gates

- [ ] Direct-media UI, consent, policy tests, and three named store artifacts
- [ ] Native Windows, macOS, and Linux packages with aria2 and browser-host resources
- [ ] Chrome and Edge listing IDs baked into native-host registration
- [ ] macOS signed and notarized after owner payment/setup
- [ ] Exact-release SHA and public download/read-back verification
