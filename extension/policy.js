// Shared, side-effect-free policy used by the background page, service worker and content script.
// Keep this file classic JavaScript: Firefox loads it as a background script while Chromium's
// service worker imports it with importScripts().
(function exposePolicy(scope) {
  const RESTRICTED_MEDIA_HOSTS = [
    "youtube.com",
    "youtu.be"
  ];

  function hostname(value) {
    try { return new URL(value).hostname.toLowerCase(); } catch { return ""; }
  }

  function hostMatches(host, domain) {
    return host === domain || host.endsWith(`.${domain}`);
  }

  function isRestrictedMediaSite(value) {
    const host = hostname(value);
    return RESTRICTED_MEDIA_HOSTS.some((domain) => hostMatches(host, domain));
  }

  function directMediaUrl(value, pageUrl = "") {
    if (isRestrictedMediaSite(pageUrl) || isRestrictedMediaSite(value)) return "";
    try {
      const parsed = new URL(value);
      return ["http:", "https:"].includes(parsed.protocol) ? parsed.href : "";
    } catch {
      return "";
    }
  }

  scope.SandwichExtensionPolicy = Object.freeze({
    RESTRICTED_MEDIA_HOSTS,
    directMediaUrl,
    isRestrictedMediaSite
  });
})(globalThis);
