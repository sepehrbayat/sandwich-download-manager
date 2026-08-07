# Privacy policy

**Effective date:** 2026-08-07

**Applies to:** Sandwich Download Manager desktop app and browser extension

Sandwich is local-first software. It has no user account, advertising, analytics, telemetry,
or cloud service operated by the project.

## Data the browser extension handles

The extension can handle the following only to perform a download the user requests:

- the download URL and the page URL;
- the browser user agent and referrer;
- an optional suggested filename;
- cookies belonging to the download's own site, only if the user separately enables cookie
  forwarding.

First-run consent is required before URLs are sent to the desktop app. Cookie forwarding is
off by default and requires a separate choice. The extension does not sell data, use it for
advertising or profiling, or send it to Sandwich project servers.

## Where the data goes

The browser passes the request directly to the Sandwich app on the same computer through the
operating system's native-messaging channel. The app uses that request context only to ask the
source website for the requested file. Cookies are not written to Sandwich's history or logs.

The source website and network provider can still receive the normal information involved in
an HTTP(S) download. Their privacy terms apply to them.

## Data stored locally

The desktop app stores download history, settings, schedule state, and the destination paths
needed to resume and manage downloads. The extension stores its consent choices and download
threshold locally in the browser profile. Users can remove this data by clearing the app data
and browser-extension storage or by uninstalling the software.

## Media boundaries

The listed extension does not extract YouTube, bypass DRM, or bypass paywalls. Users are
responsible for downloading only material they own or are permitted to save.

## Changes and contact

Material policy changes will be committed to this repository with their effective date. For
privacy questions, open an issue at
<https://github.com/sepehrbayat/sandwich-download-manager/issues>.
