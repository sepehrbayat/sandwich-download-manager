const HOST = "dev.sandwich.download_manager";

async function load() {
  const { enabled = true, minimumBytes = 1048576 } = await chrome.storage.local.get(["enabled", "minimumBytes"]);
  document.querySelector("#enabled").checked = enabled;
  document.querySelector("#minimum").value = Math.round(minimumBytes / 1048576);
}

document.querySelector("#enabled").addEventListener("change", (event) => {
  chrome.storage.local.set({ enabled: event.target.checked });
});

document.querySelector("#minimum").addEventListener("change", (event) => {
  const mb = Math.max(0, Number(event.target.value) || 0);
  chrome.storage.local.set({ minimumBytes: mb * 1048576 });
});

// Report whether the desktop app is actually reachable, rather than letting the user discover
// it only when a download silently falls back to the browser.
async function probe() {
  const status = document.querySelector("#status");
  try {
    const reply = await chrome.runtime.sendNativeMessage(HOST, { url: "" });
    // An empty URL is rejected by policy, which still proves the host and app are reachable.
    const reachable = reply && (reply.ok || /url/i.test(reply.error ?? ""));
    status.innerHTML = reachable
      ? '<span class="ok">Connected to Sandwich.</span>'
      : `<span class="bad">${reply?.error ?? "Sandwich is not running."}</span>`;
  } catch {
    status.innerHTML = '<span class="bad">Sandwich is not installed or not running.</span>';
  }
}

load().then(probe);
