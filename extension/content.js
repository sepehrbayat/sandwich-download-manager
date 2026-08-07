// A single floating action follows the media element the user is interacting with. It does not
// reparent or restyle the site's player, which avoids breaking custom controls and full-screen UI.
const policy = globalThis.SandwichExtensionPolicy;
const extensionApi = globalThis.browser ?? globalThis.chrome;

if (!policy.isRestrictedMediaSite(location.href)) {
  const host = document.createElement("div");
  host.setAttribute("data-sandwich-media-action", "");
  Object.assign(host.style, {
    all: "initial",
    position: "fixed",
    display: "none",
    zIndex: "2147483647",
    pointerEvents: "auto"
  });

  const shadow = host.attachShadow({ mode: "open" });
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "Download with Sandwich";
  button.title = "Send this direct media file to Sandwich Download Manager";
  button.setAttribute("aria-label", "Download this media with Sandwich");
  Object.assign(button.style, {
    appearance: "none",
    border: "1px solid #5f3a26",
    borderRadius: "7px",
    background: "#fff8ed",
    color: "#2a1f17",
    boxShadow: "0 2px 10px rgb(0 0 0 / 28%)",
    cursor: "pointer",
    font: "600 12px/1.2 system-ui, sans-serif",
    padding: "8px 10px"
  });
  shadow.append(button);
  document.documentElement.append(host);

  let activeMedia = null;
  let hideTimer = null;

  function mediaUrl(media) {
    return policy.directMediaUrl(media?.currentSrc || media?.src || "", location.href);
  }

  function place(media) {
    const url = mediaUrl(media);
    const rect = media?.getBoundingClientRect();
    if (!url || !rect || rect.width < 120 || rect.height < 70 || rect.bottom < 0 || rect.top > innerHeight) {
      host.style.display = "none";
      return;
    }
    activeMedia = media;
    host.style.display = "block";
    host.style.left = `${Math.max(8, Math.min(innerWidth - 190, rect.right - 182))}px`;
    host.style.top = `${Math.max(8, rect.top + 8)}px`;
  }

  function scheduleHide() {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => { host.style.display = "none"; }, 900);
  }

  document.addEventListener("pointerover", (event) => {
    const media = event.target?.closest?.("video, audio");
    if (media) place(media);
  }, true);
  document.addEventListener("play", (event) => {
    if (event.target?.matches?.("video, audio")) place(event.target);
  }, true);
  document.addEventListener("pointerout", (event) => {
    if (event.target === activeMedia) scheduleHide();
  }, true);
  host.addEventListener("pointerenter", () => clearTimeout(hideTimer));
  host.addEventListener("pointerleave", scheduleHide);
  addEventListener("scroll", () => activeMedia && place(activeMedia), { passive: true });
  addEventListener("resize", () => activeMedia && place(activeMedia), { passive: true });

  button.addEventListener("click", async () => {
    const url = mediaUrl(activeMedia);
    if (!url) return;
    button.disabled = true;
    button.textContent = "Sending…";
    try {
      const reply = await extensionApi.runtime.sendMessage({
        type: "sandwich-direct-media",
        url,
        referrer: location.href,
        label: document.title || undefined
      });
      button.textContent = reply?.ok ? "Sent to Sandwich" : (reply?.error || "Sandwich unavailable");
    } catch {
      button.textContent = "Sandwich unavailable";
    }
    setTimeout(() => {
      button.disabled = false;
      button.textContent = "Download with Sandwich";
      scheduleHide();
    }, 1800);
  });
}
