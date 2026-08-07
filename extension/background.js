// Sandwich browser integration.
//
// Watches for downloads the browser is about to start, hands them to Sandwich instead, and
// cancels the browser's own copy. The request context travels with the URL: without the
// cookies, referrer and user agent the origin sees an unauthenticated stranger and refuses,
// which is why "it downloads in my browser but not in my download manager" is such a common
// complaint. Getting that right is most of the value of this extension.

if (!globalThis.SandwichExtensionPolicy && typeof importScripts === "function") {
  importScripts("policy.js");
}
const policy = globalThis.SandwichExtensionPolicy;
const extensionApi = globalThis.browser ?? globalThis.chrome;
const HOST = "dev.sandwich.download_manager";

const DEFAULTS = {
  enabled: false,
  consentVersion: 0,
  shareCookies: false,
  // Small files are usually part of the page rather than something worth managing, and
  // intercepting them is more annoying than helpful.
  minimumBytes: 1024 * 1024,
  // Text and images that the browser renders inline; taking these over would be surprising.
  skipTypes: ["text/html", "text/css", "application/javascript", "image/png", "image/jpeg", "image/gif", "image/svg+xml", "image/webp"]
};

async function settings() {
  const stored = await extensionApi.storage.local.get(DEFAULTS);
  return { ...DEFAULTS, ...stored };
}

function notify(title, message) {
  // Notifications are best-effort; a missing icon or a denied permission must not break a
  // download that has already been handed over successfully.
  try {
    extensionApi.notifications?.create({
      type: "basic",
      iconUrl: "icon128.png",
      title,
      message
    });
  } catch { /* ignore */ }
}

function friendlyNativeError(error) {
  const detail = error?.message || String(error || "");
  return /native messaging|host.*not found|disconnected/i.test(detail)
    ? "Open the Sandwich desktop app and finish browser setup"
    : detail || "Sandwich did not respond";
}

/** Cookies the origin would have received had the browser performed the download itself. */
async function cookieHeaderFor(url, allowed) {
  if (!allowed) return "";
  try {
    const jar = await extensionApi.cookies.getAll({ url });
    if (!jar.length) return "";
    return jar.map((c) => `${c.name}=${c.value}`).join("; ");
  } catch {
    return "";
  }
}

async function handOver({ url, filename, referrer }) {
  if (policy.isRestrictedMediaSite(url) || policy.isRestrictedMediaSite(referrer || "")) {
    throw new Error("This store build cannot download from YouTube");
  }
  const config = await settings();
  if (config.consentVersion < 1) throw new Error("Open Sandwich settings and enable browser integration first");
  const [cookie, agent] = await Promise.all([
    cookieHeaderFor(url, config.shareCookies),
    Promise.resolve(navigator.userAgent)
  ]);

  const reply = await extensionApi.runtime.sendNativeMessage(HOST, {
    url,
    filename: filename || undefined,
    referrer: referrer || undefined,
    user_agent: agent,
    cookie: cookie || undefined
  });

  if (!reply?.ok) throw new Error(reply?.error ?? "Sandwich did not respond");
  return reply.gid;
}

function shouldIntercept(item, config) {
  if (!config.enabled || config.consentVersion < 1) return false;
  if (!/^https?:/i.test(item.finalUrl || item.url || "")) return false;
  if (policy.isRestrictedMediaSite(item.finalUrl || item.url || "")) return false;
  // A known size below the threshold is not worth taking over. An unknown size usually means
  // a streamed attachment, which is exactly the kind of thing worth managing.
  if (item.fileSize > 0 && item.fileSize < config.minimumBytes) return false;
  if (item.mime && config.skipTypes.includes(item.mime.toLowerCase())) return false;
  return true;
}

extensionApi.downloads.onCreated.addListener(async (item) => {
  const config = await settings();
  if (!shouldIntercept(item, config)) return;

  const url = item.finalUrl || item.url;
  const filename = item.filename ? item.filename.split(/[\\/]/).pop() : undefined;

  try {
    await handOver({ url, filename, referrer: item.referrer });
    // Only cancel once Sandwich has accepted it. Cancelling first would lose the download
    // entirely if the hand-off failed.
    await extensionApi.downloads.cancel(item.id);
    await extensionApi.downloads.erase({ id: item.id });
    notify("Sent to Sandwich", filename || url);
  } catch (error) {
    // Leave the browser's own download running: a failed hand-off must never cost the user
    // their file.
    console.warn("Sandwich hand-off failed, leaving it to the browser:", error);
    notify("Sandwich unavailable", `${friendlyNativeError(error)}. The browser will download it instead.`);
  }
});

// Explicit "download with Sandwich" on any link, which also covers everything the automatic
// rules deliberately skip.
extensionApi.runtime.onInstalled.addListener(() => {
  extensionApi.contextMenus.removeAll().then(() => {
    extensionApi.contextMenus.create({
      id: "sandwich-download",
      title: "Download with Sandwich",
      contexts: ["link", "video", "audio", "image"]
    });
  });
});

extensionApi.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === "install") extensionApi.tabs.create({ url: extensionApi.runtime.getURL("onboarding.html") });
});

extensionApi.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "sandwich-direct-media") return false;
  const url = policy.directMediaUrl(message.url, message.referrer);
  if (!url) {
    sendResponse({ ok: false, error: "This media source is protected or is not a direct web file" });
    return false;
  }
  handOver({ url, referrer: message.referrer })
    .then((gid) => {
      notify("Sent media to Sandwich", message.label || url);
      sendResponse({ ok: true, gid });
    })
    .catch((error) => sendResponse({ ok: false, error: friendlyNativeError(error) }));
  return true;
});

extensionApi.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== "sandwich-download") return;
  const url = info.linkUrl || info.srcUrl;
  if (!url) return;
  if (policy.isRestrictedMediaSite(url) || policy.isRestrictedMediaSite(tab?.url || "")) {
    notify("Not available in the store build", "YouTube downloads are prohibited by Chrome Web Store policy.");
    return;
  }
  try {
    await handOver({ url, referrer: tab?.url });
    notify("Sent to Sandwich", url);
  } catch (error) {
    notify("Sandwich unavailable", friendlyNativeError(error));
  }
});
