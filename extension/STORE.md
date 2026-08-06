# Store submission kit

Everything needed to publish the extension, so submission day is paste-and-click. Build the
package first:

```
powershell -ExecutionPolicy Bypass -File tools/package-extension.ps1
```

One zip serves all three stores. Accounts are the only thing this kit cannot provide:
Chrome Web Store charges a one-time $5 developer fee; Edge Add-ons and Firefox AMO are free.

**After publication**, two follow-ups matter:
1. The store-assigned extension ID becomes permanent. Bake it into `register-host.ps1` as the
   default `-ChromeExtensionId`, and have the Sandwich installer register the native host with
   that ID — the manual registration step disappears for users.
2. Update README's "Browser extension" section to point at the store pages.

## Listing copy

**Name:** Sandwich Download Manager

**Summary (short):**
Send downloads to Sandwich — the free, open-source download manager for Windows.

**Description:**

Sandwich is a free, open-source download manager for Windows. This extension connects it to
your browser.

- Downloads larger than 1 MB are handed to Sandwich automatically, where they run segmented,
  resumable, and pause-safe.
- Right-click any link, video, audio or image → **Download with Sandwich**.
- Your session travels with the download: cookies, referrer and user agent go along, so
  links that need a login work in Sandwich exactly as they do in the browser.
- If Sandwich isn't running, the browser keeps the download. A failed hand-off never costs
  you a file.

Requires the Sandwich desktop app (free, GPL-3.0):
https://github.com/sepehrbayat/sandwich-download-manager

**Category:** Productivity (Chrome/Edge) · Download Management (AMO)

## Permission justifications

Reviewers ask for these one by one; answers below are honest and specific.

| Permission | Why it is needed |
|---|---|
| `downloads` | To see a download starting and cancel the browser's copy once Sandwich has accepted it — never before. |
| `nativeMessaging` | The only channel to the desktop app. There is no socket or HTTP port; the OS-mediated stdio pipe is the security model. |
| `cookies` | Read-only, to forward the cookies the origin would have received had the browser downloaded the file itself. Without them, downloads behind a login fail. Nothing is stored or sent anywhere except to that origin via the local desktop app. |
| `storage` | The user's own toggle (automatic interception on/off, size threshold). |
| `contextMenus` | The "Download with Sandwich" right-click entry. |
| `notifications` | "Sent to Sandwich" / "Sandwich unavailable" — the outcome of a hand-off. |
| `http://*/*`, `https://*/*` (host) | Downloads can start from any site; cookie forwarding must work for the site the download came from. The extension reads no page content — there is no content script at all. |

**Single purpose statement (Chrome asks):** hand browser downloads to the Sandwich desktop
download manager, with the request context needed for them to succeed.

**Data disclosure (all stores):** the extension collects nothing, transmits nothing off the
machine, and has no analytics. Cookies for a download's origin are passed to the local
desktop app over native messaging and used only for that transfer.

## Firefox notes

- AMO signs every listed build; the temporary-load path in the README stops being needed
  once listed.
- `browser_specific_settings.gecko.id` is already set (`sandwich@sandwich.dev`) and must
  never change between versions.
- AMO will ask for source access since the package is unminified plain JS — link the GitHub
  repository; nothing further is required.

## Assets stores ask for

- Icon 128×128: `extension/icon128.png` (already in the package)
- Screenshots 1280×800: take from a running Sandwich with the extension popup open —
  one of the popup over a download page, one of the Sandwich queue receiving it.
- Promo tile (Chrome, optional, 440×280): crop of the logo on the cream background.
