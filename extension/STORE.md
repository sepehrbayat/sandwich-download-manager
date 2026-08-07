# Browser-store submission kit

This kit covers Chrome Web Store, Microsoft Edge Add-ons, and Firefox AMO. Build and validate
the three store-specific packages with:

```powershell
npm ci
npm run package:extension
```

The output is:

- `dist/sandwich-extension-chrome-0.6.1.zip`
- `dist/sandwich-extension-edge-0.6.1.zip`
- `dist/sandwich-extension-firefox-0.6.1.zip`

Do not upload one browser's ZIP to another store. Chromium uses a service worker; Firefox uses
background scripts and Mozilla-specific data declarations. `npm run package:extension` runs
Mozilla's validator and fails on errors, warnings, or notices.

## Owner account gates

The code cannot create or verify accounts in the owner's legal identity:

1. **Chrome Web Store:** register the intended permanent Google account and pay the one-time
   **US$5** developer fee in the Developer Dashboard.
2. **Microsoft Edge Add-ons:** enroll the intended Microsoft account in the Edge program in
   Partner Center. Microsoft currently charges no registration fee, but verifies the account.
3. **Firefox AMO:** sign in with the intended Mozilla account, set its public developer display
   name, and accept the distribution agreement. Mozilla documents no registration payment.

Create Chrome and Edge draft listings before the final desktop release. Each store assigns a
different extension ID. Put those IDs into the native-host registration defaults and rebuild
the signed desktop installers; otherwise users must register the bridge manually.

## Listing copy

**Name:** Sandwich Download Manager

**Short summary:**

Send browser downloads and permitted direct media to the free, open-source Sandwich app.

**Description:**

Sandwich connects your browser to the free, open-source Sandwich Download Manager for Windows,
macOS, and Linux.

- Send any link explicitly with **Download with Sandwich**.
- Hand larger browser downloads to Sandwich for segmented, resumable transfer.
- See a download action beside video or audio when the page exposes a direct HTTP(S) media file.
- Optionally include cookies from the download's own site for files behind a login.
- Keep the browser download when the desktop app is unavailable; a failed hand-off never loses
  the file.

The extension requires first-run consent, has no analytics or advertising, and communicates
only with the Sandwich app installed on the same computer. It does not extract YouTube, bypass
DRM, or bypass paywalls. Download only material you own or are permitted to save.

Desktop app and source code:
<https://github.com/sepehrbayat/sandwich-download-manager>

**Category:** Productivity (Chrome/Edge); Download Management (Firefox)

**Privacy policy:**
<https://github.com/sepehrbayat/sandwich-download-manager/blob/main/PRIVACY.md>

## Permission justifications

| Permission | Reviewer explanation |
|---|---|
| `downloads` | Observe a browser download and cancel that copy only after the local Sandwich app accepts it. |
| `nativeMessaging` | Send the requested transfer to the locally installed desktop app through the operating system's native-messaging channel. |
| `cookies` | Optional and off by default. If enabled, read cookies only for the download URL's own site so an authenticated file request can succeed. |
| `storage` | Save consent choices, automatic-interception state, and the size threshold in the browser profile. |
| `contextMenus` | Provide the user-invoked **Download with Sandwich** menu item on links and media. |
| `notifications` | Report whether a user-invoked hand-off succeeded or whether the desktop app needs setup. |
| `http://*/*`, `https://*/*` | Downloads and direct media can originate on any site. The content script inspects only video/audio elements to expose the local download action; it does not transmit page content. |

**Single-purpose statement:** Hand user-selected browser downloads and permitted direct media to
the locally installed Sandwich Download Manager with the minimum request context needed for the
transfer to succeed.

**Data-use disclosure:** Website activity (download/page addresses and request context) is sent
only to the local desktop app after consent. Authentication information (same-site cookies) is
optional and off by default. No data is sold, used for advertising or profiling, or sent to
project servers. See `PRIVACY.md`.

## Reviewer test instructions

1. Install and open Sandwich Download Manager 0.6.1.
2. Install the submitted extension and approve URL sharing on the onboarding page. Leave cookie
   sharing off for the basic test.
3. Open a page containing an HTML `<video>` whose `src` is an ordinary HTTPS MP4/WebM file.
4. Hover or play the media and select **Download with Sandwich**. Confirm the transfer appears
   in the desktop queue.
5. Right-click an ordinary HTTPS link and select **Download with Sandwich**. Confirm it appears
   in the queue.
6. Close the desktop app and start a browser download larger than the configured threshold.
   Confirm the browser retains its own download and the user receives a setup message.
7. Open a YouTube page. Confirm no media action is injected and no URL is handed to the app.

Provide reviewers with a public, non-authenticated direct-media test page and the matching
desktop prerelease installer. Never provide production credentials.

## Firefox submission notes

- The stable add-on ID is `sandwich@sandwich.dev`; never change it between versions.
- Upload the Firefox ZIP and choose listed distribution and all desktop platforms.
- The submitted JS is plain, unminified, and unbundled. If AMO asks whether a build step is
  required for the extension source, answer no and link this repository.
- AMO signs approved builds. Replace the unsigned CI ZIP with the AMO-signed artifact for public
  Firefox distribution.

## Visual assets

- Icons: `extension/icon48.png` and `extension/icon128.png`.
- Screenshot: `extension/store-assets/onboarding-1280x800.png`.
- Screenshot: `extension/store-assets/direct-media-1280x800.png`, showing the
  **Download with Sandwich** action on a direct-media test page.
- Optional Chrome promotional tile: 440x280, project logo on the cream brand background.

Screenshots must use public sample media and contain no account, cookie, token, or personal data.

## Submission checklist

- [ ] Owner completes Chrome registration and payment
- [ ] Owner completes Edge and Mozilla account verification
- [ ] Chrome and Edge draft IDs are recorded in native-host defaults
- [ ] Privacy-policy URL is public on `main`
- [ ] Three ZIP hashes match the release checksums
- [ ] Store copy, permissions, data disclosures, reviewer instructions, and screenshots uploaded
- [ ] Firefox source/build answers completed
- [ ] Desktop installers supplied to reviewers
- [ ] Submit for review only after the exact desktop release SHA passes native CI
- [ ] Record listing URLs and replace manual-install directions after approval
