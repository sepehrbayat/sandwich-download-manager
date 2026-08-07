const HOST = "dev.sandwich.download_manager";
const extensionApi = globalThis.browser ?? globalThis.chrome;

async function load() {
  const { enabled = false, minimumBytes = 1048576, consentVersion = 0 } = await extensionApi.storage.local.get(["enabled", "minimumBytes", "consentVersion"]);
  document.querySelector("#enabled").checked = enabled;
  document.querySelector("#enabled").disabled = consentVersion < 1;
  document.querySelector("#minimum").value = Math.round(minimumBytes / 1048576);
  document.querySelector("#consent-note").hidden = consentVersion >= 1;
}

document.querySelector("#enabled").addEventListener("change", (event) => {
  extensionApi.storage.local.set({ enabled: event.target.checked });
});

document.querySelector("#minimum").addEventListener("change", (event) => {
  const mb = Math.max(0, Number(event.target.value) || 0);
  extensionApi.storage.local.set({ minimumBytes: mb * 1048576 });
});

document.querySelector("#open-settings").addEventListener("click", () => extensionApi.runtime.openOptionsPage());

// Report whether the desktop app is actually reachable, rather than letting the user discover
// it only when a download silently falls back to the browser.
async function probe() {
  const status = document.querySelector("#status");
  const showStatus = (message, ok) => {
    const line = document.createElement("span");
    line.className = ok ? "ok" : "bad";
    line.textContent = message;
    status.replaceChildren(line);
  };
  try {
    const reply = await extensionApi.runtime.sendNativeMessage(HOST, { url: "" });
    // An empty URL is rejected by policy, which still proves the host and app are reachable.
    const reachable = reply && (reply.ok || /url/i.test(reply.error ?? ""));
    showStatus(reachable ? "Connected to Sandwich." : (reply?.error ?? "Sandwich is not running."), reachable);
  } catch {
    showStatus("Sandwich is not installed or not running.", false);
  }
}

load().then(probe);
