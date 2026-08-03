import { formatBytes, formatEta, progressPercent, statusLabels } from "./formatters.js";

const invoke = window.__TAURI_INTERNALS__?.invoke;
const listen = window.__TAURI__?.event?.listen;
const bridge = window.__SANDWICH_TEST_BRIDGE__ ?? {
  invoke: invoke ? (command, payload) => invoke(command, payload) : async () => { throw new Error("Download engine is unavailable."); },
  listen: listen ? (event, handler) => listen(event, handler) : async () => () => {}
};

const elements = {
  form: document.querySelector("#download-form"), url: document.querySelector("#url"), error: document.querySelector("#form-error"),
  destination: document.querySelector("#destination"), chooseFolder: document.querySelector("#choose-folder"), organize: document.querySelector("#organize"),
  list: document.querySelector("#download-list"), empty: document.querySelector("#empty-state"), template: document.querySelector("#download-template"),
  queueStatus: document.querySelector("#queue-status"), connection: document.querySelector("#connection-status"), refresh: document.querySelector("#refresh"),
  offer: document.querySelector("#clipboard-offer"), offerUrl: document.querySelector("#clipboard-url"), confirmOffer: document.querySelector("#confirm-offer"), dismissOffer: document.querySelector("#dismiss-offer")
};

let downloads = [];
let destination = "";
let clipboardOffer = null;
const cards = new Map();

function showError(message) {
  elements.error.textContent = message;
  elements.error.hidden = !message;
}

function actionButton(label, action, item) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = action === "cancel" ? "quiet danger" : "secondary";
  button.textContent = label;
  button.setAttribute("aria-label", `${label} ${item.filename}`);
  button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      if (action === "open") await bridge.invoke("open_completed_file", { downloadId: item.id });
      else if (action === "reveal") await bridge.invoke("reveal_completed_file", { downloadId: item.id });
      else {
        const updated = await bridge.invoke("control_download", { downloadId: item.id, action });
        mergeDownload(updated, `${item.filename}: ${statusLabels[updated.status] ?? updated.status}`);
      }
    } catch (error) {
      elements.queueStatus.textContent = `${label} failed for ${item.filename}: ${error.message}`;
    } finally {
      // Cards now survive updates, so a button that is still mounted has to be re-enabled.
      // One replaced by a status change is detached and must be left alone.
      if (button.isConnected) button.disabled = false;
    }
  });
  return button;
}

function actionsFor(status) {
  if (["queued", "active"].includes(status)) return [["Pause", "pause"], ["Cancel", "cancel"]];
  if (["paused", "recoverably_interrupted"].includes(status)) return [["Resume", "resume"], ["Cancel", "cancel"]];
  if (status === "completed") return [["Open file", "open"], ["Show in folder", "reveal"]];
  return [];
}

function createCard(item) {
  const card = elements.template.content.cloneNode(true).querySelector("li");
  const entry = {
    card,
    filename: card.querySelector(".filename"),
    state: card.querySelector(".download-state"),
    percent: card.querySelector(".percent"),
    progress: card.querySelector("progress"),
    size: card.querySelector(".size"),
    speed: card.querySelector(".speed"),
    eta: card.querySelector(".eta"),
    error: card.querySelector(".download-error"),
    actions: card.querySelector(".download-actions"),
    actionsKey: null
  };
  entry.progress.setAttribute("aria-label", `${item.filename} progress`);
  return entry;
}

function updateCard(entry, item) {
  const percent = progressPercent(item.completed_bytes, item.total_bytes);
  const label = statusLabels[item.status] ?? item.status;
  entry.filename.textContent = item.filename;
  entry.state.textContent = label;
  entry.percent.textContent = `${Math.round(percent)}%`;
  entry.progress.value = percent;
  entry.progress.setAttribute("aria-valuetext", `${Math.round(percent)} percent, ${label}`);
  entry.size.textContent = `${formatBytes(item.completed_bytes)} of ${formatBytes(item.total_bytes)}`;
  entry.speed.textContent = item.status === "active" && item.bytes_per_second > 0 ? `${formatBytes(item.bytes_per_second)}/s` : "—";
  entry.eta.textContent = item.status === "active" ? formatEta(item.eta_seconds) : "—";
  entry.error.textContent = item.error?.message ?? "";
  entry.error.hidden = !item.error?.message;
  entry.card.dataset.status = item.status;

  // Replacing the buttons destroys keyboard focus, so only do it when the available actions
  // actually change. A progress tick must never rebuild them.
  const actions = actionsFor(item.status);
  const key = actions.map(([, action]) => action).join("|");
  if (key !== entry.actionsKey) {
    const hadFocus = entry.actions.contains(document.activeElement);
    entry.actions.replaceChildren(...actions.map(([text, action]) => actionButton(text, action, item)));
    entry.actionsKey = key;
    if (hadFocus) entry.actions.querySelector("button")?.focus();
  }
}

// Reconciles by download id and mutates cards in place. A full rebuild would destroy the
// button a keyboard user is standing on every time a progress event arrives.
function render() {
  for (const [id, entry] of cards) {
    if (!downloads.some((item) => item.id === id)) {
      entry.card.remove();
      cards.delete(id);
    }
  }
  downloads.forEach((item, index) => {
    let entry = cards.get(item.id);
    if (!entry) {
      entry = createCard(item);
      cards.set(item.id, entry);
    }
    updateCard(entry, item);
    if (elements.list.children[index] !== entry.card) {
      elements.list.insertBefore(entry.card, elements.list.children[index] ?? null);
    }
  });
  elements.empty.hidden = downloads.length > 0;
}

function mergeDownload(snapshot, announcement) {
  const index = downloads.findIndex((item) => item.id === snapshot.id);
  if (index < 0) downloads.unshift(snapshot); else downloads[index] = snapshot;
  render();
  if (announcement) elements.queueStatus.textContent = announcement;
}

async function refresh() {
  try {
    downloads = await bridge.invoke("list_downloads");
    elements.connection.textContent = "Download engine connected";
    render();
  } catch (error) {
    elements.connection.textContent = "Download engine unavailable";
    showError(error.message);
  }
}

elements.form.addEventListener("submit", async (event) => {
  event.preventDefault(); showError("");
  if (!destination) { showError("Choose a destination folder before adding a download."); elements.chooseFolder.focus(); return; }
  const submit = elements.form.querySelector("button[type=submit]"); submit.disabled = true;
  try {
    const snapshot = await bridge.invoke("submit_url", { url: elements.url.value, destination, organizeByType: elements.organize.checked });
    mergeDownload(snapshot, `${snapshot.filename} added to the download queue.`);
    elements.url.value = ""; elements.url.focus();
  } catch (error) { showError(error.message); }
  finally { submit.disabled = false; }
});

elements.chooseFolder.addEventListener("click", async () => {
  try {
    const selected = await bridge.invoke("choose_destination");
    if (selected) { destination = selected; elements.destination.textContent = selected; }
  } catch (error) { showError(error.message); }
});
elements.refresh.addEventListener("click", refresh);
elements.dismissOffer.addEventListener("click", () => { clipboardOffer = null; elements.offer.hidden = true; elements.queueStatus.textContent = "Clipboard suggestion dismissed."; });
elements.confirmOffer.addEventListener("click", async () => {
  if (!destination) { elements.offer.hidden = true; showError("Choose a destination folder before adding a download."); elements.chooseFolder.focus(); return; }
  try {
    const snapshot = await bridge.invoke("confirm_clipboard_offer", { offer: clipboardOffer, destination, organizeByType: elements.organize.checked });
    clipboardOffer = null; elements.offer.hidden = true; mergeDownload(snapshot, `${snapshot.filename} added from clipboard.`);
  } catch (error) { elements.queueStatus.textContent = `Could not add clipboard link: ${error.message}`; }
});

bridge.listen("download-snapshot", ({ payload }) => {
  const previousStatus = downloads.find((item) => item.id === payload.id)?.status;
  mergeDownload(payload, previousStatus !== payload.status ? `${payload.filename}: ${statusLabels[payload.status] ?? payload.status}` : "");
});
bridge.listen("clipboard-url-offer", ({ payload }) => {
  clipboardOffer = payload; elements.offerUrl.textContent = payload.display_url; elements.offer.hidden = false;
  elements.queueStatus.textContent = "A copied download link is ready for confirmation.";
});
refresh();
