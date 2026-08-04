import { formatBytes, formatEta, progressPercent, statusLabels } from "./formatters.js";

const invoke = window.__TAURI__?.core?.invoke ?? window.__TAURI_INTERNALS__?.invoke;
const listen = window.__TAURI__?.event?.listen;

// A missing listen() is not a degraded mode, it is a silent one: the queue would render once
// and then never move again. Fail loudly instead of quietly doing nothing.
function unavailableListen() {
  console.error("Tauri event API unavailable - live progress is disabled. Check capabilities/default.json.");
  return async () => () => {};
}

const bridge = window.__SANDWICH_TEST_BRIDGE__ ?? {
  invoke: invoke
    ? (command, payload) => invoke(command, payload)
    : async () => { throw new Error("Download engine is unavailable."); },
  listen: listen ? (event, handler) => listen(event, handler) : unavailableListen()
};

const elements = {
  intake: document.querySelector("#intake"),
  openAdd: document.querySelector("#open-add"),
  closeAdd: document.querySelector("#close-add"),
  form: document.querySelector("#download-form"),
  url: document.querySelector("#url"),
  error: document.querySelector("#form-error"),
  destination: document.querySelector("#destination"),
  chooseFolder: document.querySelector("#choose-folder"),
  organize: document.querySelector("#organize"),
  list: document.querySelector("#download-list"),
  empty: document.querySelector("#empty-state"),
  template: document.querySelector("#download-template"),
  queueStatus: document.querySelector("#queue-status"),
  queueScope: document.querySelector("#queue-scope"),
  connection: document.querySelector("#connection-status"),
  throughput: document.querySelector("#throughput-value"),
  refresh: document.querySelector("#refresh"),
  pauseAll: document.querySelector("#pause-all"),
  resumeAll: document.querySelector("#resume-all"),
  offer: document.querySelector("#clipboard-offer"),
  offerUrl: document.querySelector("#clipboard-url"),
  confirmOffer: document.querySelector("#confirm-offer"),
  dismissOffer: document.querySelector("#dismiss-offer"),
  rail: document.querySelectorAll(".rail-item")
};

let downloads = [];
let destination = "";
let clipboardOffer = null;
let filter = "all";
const cards = new Map();
const expanded = new Set();
// Disabling a focused button blurs it immediately, so by the time a re-render runs the browser
// has already moved focus to <body>. Record which download the user was acting on at click time.
let pendingFocusId = null;

/* ── File kinds ─────────────────────────────────────────────────────────── */

const KINDS = {
  video: { label: "▶", exts: ["mp4", "mkv", "avi", "mov", "flv", "webm", "wmv", "m4v", "ogv"] },
  audio: { label: "♪", exts: ["mp3", "flac", "wav", "aac", "ogg", "m4a", "wma", "opus"] },
  archive: { label: "◫", exts: ["zip", "rar", "7z", "tar", "gz", "bz2", "xz", "iso"] },
  document: { label: "▭", exts: ["pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "txt", "epub", "csv"] },
  program: { label: "▣", exts: ["exe", "msi", "dmg", "deb", "rpm", "appimage", "apk", "pkg"] }
};

function kindOf(filename) {
  const ext = (filename.split(".").pop() ?? "").toLowerCase();
  for (const [kind, spec] of Object.entries(KINDS)) {
    if (spec.exts.includes(ext)) return kind;
  }
  return "other";
}

function kindGlyph(kind) {
  return KINDS[kind]?.label ?? "▦";
}

/* ── The stack: aria2's piece map, drawn as a sandwich cross-section ─────── */

// Cell size is fixed and the count follows the available width, rather than the reverse.
// A segmented indicator has to stay legible as an object; 16px is the smallest width at which
// the four bands of a sandwich still read as layers rather than mush.
const TARGET_CELL_PX = 16;
const PROVISIONAL_WIDTH_PX = 640; // only used until the bar has been laid out once
const MIN_CELLS = 8;
const MAX_CELLS = 120;

/** Decodes aria2's hex bitfield into one boolean per piece. */
function decodePieces(bitfield, count) {
  if (!bitfield || !count) return [];
  const done = [];
  for (let index = 0; index < count; index += 1) {
    const nibble = parseInt(bitfield[index >> 2] ?? "0", 16);
    done.push(Boolean(nibble & (8 >> (index & 3))));
  }
  return done;
}

function cellCapacity(width) {
  return Math.max(MIN_CELLS, Math.min(MAX_CELLS, Math.floor(width / TARGET_CELL_PX)));
}

/**
 * Collapses the piece list to the number of cells that fit.
 *
 * Returns 1 for a fully complete cell, 0.5 for one that is partly there, 0 for untouched.
 * The middle value matters: treating "99 of 100 pieces done" as empty would understate real
 * progress, and treating it as done would overstate it. A half-built sandwich is the honest
 * answer, and it happens to be exactly what a piece in flight looks like.
 */
function bucketPieces(done, capacity) {
  if (done.length <= capacity) return done.map((complete) => (complete ? 1 : 0));
  const size = Math.ceil(done.length / capacity);
  const buckets = [];
  for (let start = 0; start < done.length; start += size) {
    const slice = done.slice(start, start + size);
    const complete = slice.filter(Boolean).length;
    buckets.push(complete === 0 ? 0 : complete === slice.length ? 1 : 0.5);
  }
  return buckets;
}

// The cell count depends on how wide the bar actually is, which a window-resize listener does
// not reliably capture (a card can change width without the window doing so). Observing the
// element itself is the correct signal.
const stackOwners = new WeakMap();
const stackObserver = typeof ResizeObserver === "function"
  ? new ResizeObserver((observed) => {
      for (const entry of observed) {
        const item = stackOwners.get(entry.target);
        if (item) renderStack(entry.target, item);
      }
    })
  : null;

/** Even cells filled from byte progress, with the boundary cell shown as partly built. */
function proportionalCells(capacity, percent) {
  const exact = (percent / 100) * capacity;
  const full = Math.floor(exact);
  return Array.from({ length: capacity }, (_, index) => {
    if (index < full) return 1;
    if (index === full && exact - full > 0.15) return 0.5;
    return 0;
  });
}

function renderStack(container, item) {
  stackOwners.set(container, item);
  if (stackObserver) stackObserver.observe(container);

  // Before first paint the bar has no width. Rendering nothing would leave it blank whenever
  // the frame loop is throttled (minimised window, background tab), and guessing a width would
  // lock in a cell count that does not match the bar. So draw a provisional stack now and
  // correct it as soon as a real measurement exists — the queue re-renders twice a second
  // anyway, and the observer catches any later resize.
  const width = container.clientWidth;
  const capacity = cellCapacity(width || PROVISIONAL_WIDTH_PX);
  if (!width) requestAnimationFrame(() => renderStack(container, item));
  const decoded = decodePieces(item.bitfield, item.num_pieces);

  // The piece map is only worth drawing when it is finer than the bar. A file of one or eight
  // pieces would otherwise stretch into a handful of enormous blocks, which looks broken and
  // says nothing extra: at that granularity, byte progress carries the same information.
  const cells = decoded.length >= capacity
    ? bucketPieces(decoded, capacity)
    : proportionalCells(capacity, progressPercent(item.completed_bytes, item.total_bytes));

  if (container.childElementCount !== cells.length) {
    container.replaceChildren(...cells.map(() => {
      const cell = document.createElement("span");
      cell.className = "piece";
      return cell;
    }));
  }

  const partial = cells.some((value) => value === 0.5);
  container.childNodes.forEach((cell, index) => {
    const value = cells[index];
    cell.classList.toggle("is-done", value === 1);
    cell.classList.toggle("is-partial", value === 0.5);
    // Partly-filled cells are genuinely where work is happening, so those are what pulse.
    // With few enough pieces that no cell aggregates, fall back to the first incomplete cell,
    // which is an approximation and marked as such.
    const live = item.status === "active"
      && (partial ? value === 0.5 : value === 0 && (index === 0 || cells[index - 1] === 1));
    cell.classList.toggle("is-active", live);
  });
}

/* ── Cards ──────────────────────────────────────────────────────────────── */

function actionsFor(status) {
  if (["queued", "active"].includes(status)) return [["Pause", "pause"], ["Cancel", "cancel"]];
  if (["paused", "recoverably_interrupted"].includes(status)) return [["Resume", "resume"], ["Cancel", "cancel"]];
  if (status === "completed") return [["Open file", "open"], ["Show in folder", "reveal"]];
  return [];
}

function actionButton(label, action, item) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = action === "cancel" ? "quiet danger" : "secondary";
  button.textContent = label;
  button.setAttribute("aria-label", `${label} ${item.filename}`);
  button.addEventListener("click", async () => {
    if (document.activeElement === button) pendingFocusId = item.id;
    button.disabled = true;
    try {
      if (action === "open") await bridge.invoke("open_completed_file", { downloadId: item.id });
      else if (action === "reveal") await bridge.invoke("reveal_completed_file", { downloadId: item.id });
      else {
        const updated = await bridge.invoke("control_download", { downloadId: item.id, action });
        mergeDownload(updated, `${item.filename}: ${statusLabels[updated.status] ?? updated.status}`);
      }
    } catch (error) {
      elements.queueStatus.textContent = `${label} failed for ${item.filename}: ${error.message ?? error}`;
    } finally {
      if (button.isConnected) button.disabled = false;
    }
  });
  return button;
}

function createCard(item) {
  const card = elements.template.content.cloneNode(true).querySelector("li");
  const entry = {
    card,
    kind: card.querySelector(".file-kind"),
    filename: card.querySelector(".filename"),
    state: card.querySelector(".download-state"),
    percent: card.querySelector(".percent"),
    disclosure: card.querySelector(".disclosure"),
    stack: card.querySelector(".stack"),
    pieces: card.querySelector(".stack-pieces"),
    size: card.querySelector(".size"),
    speed: card.querySelector(".speed"),
    eta: card.querySelector(".eta"),
    conns: card.querySelector(".conns"),
    error: card.querySelector(".download-error"),
    details: card.querySelector(".details"),
    detailUrl: card.querySelector(".detail-url"),
    detailDir: card.querySelector(".detail-dir"),
    detailPieces: card.querySelector(".detail-pieces"),
    detailResume: card.querySelector(".detail-resume"),
    actions: card.querySelector(".download-actions"),
    actionsKey: null
  };
  entry.disclosure.addEventListener("click", () => {
    if (expanded.has(item.id)) expanded.delete(item.id);
    else expanded.add(item.id);
    render();
  });
  return entry;
}

function updateCard(entry, item) {
  const percent = progressPercent(item.completed_bytes, item.total_bytes);
  const label = statusLabels[item.status] ?? item.status;
  const rounded = Math.round(percent);

  entry.kind.textContent = kindGlyph(kindOf(item.filename));
  entry.filename.textContent = item.filename;
  entry.state.textContent = label;
  // Some servers never send a length. Claiming "0% of 0 B" is worse than admitting we
  // do not know: the transfer is running fine, the size simply is not knowable yet.
  const sizeKnown = item.total_bytes > 0;
  entry.percent.textContent = sizeKnown ? `${rounded}%` : "—";
  entry.size.textContent = sizeKnown
    ? `${formatBytes(item.completed_bytes)} of ${formatBytes(item.total_bytes)}`
    : `${formatBytes(item.completed_bytes)} so far`;
  entry.speed.textContent = item.status === "active" && item.bytes_per_second > 0
    ? `${formatBytes(item.bytes_per_second)}/s`
    : "—";
  entry.eta.textContent = item.status === "active" ? formatEta(item.eta_seconds) : "—";
  entry.conns.textContent = item.status === "active" ? String(item.connections || 0) : "—";
  entry.error.textContent = item.error?.message ?? "";
  entry.error.hidden = !item.error?.message;
  entry.card.dataset.status = item.status;

  entry.stack.setAttribute(
    "aria-label",
    sizeKnown ? `${item.filename}: ${rounded} percent complete, ${label}` : `${item.filename}: ${label}, size unknown`
  );
  entry.card.classList.toggle("is-indeterminate", !sizeKnown && item.status === "active");
  renderStack(entry.pieces, item);

  const isOpen = expanded.has(item.id);
  entry.details.hidden = !isOpen;
  entry.disclosure.setAttribute("aria-expanded", String(isOpen));
  entry.disclosure.textContent = isOpen ? "Hide details" : "Details";
  if (isOpen) {
    entry.detailUrl.textContent = item.source_url || "—";
    entry.detailDir.textContent = item.directory || "—";
    entry.detailPieces.textContent = item.num_pieces
      ? `${item.num_pieces} × ${formatBytes(Math.round(item.total_bytes / item.num_pieces))}`
      : "—";
    entry.detailResume.textContent = item.num_pieces > 1 ? "Supported" : "Not reported";
  }

  // Replacing the buttons destroys keyboard focus, so only do it when the actions change.
  const actions = actionsFor(item.status);
  const key = actions.map(([, action]) => action).join("|");
  if (key !== entry.actionsKey) {
    const hadFocus = entry.actions.contains(document.activeElement) || pendingFocusId === item.id;
    entry.actions.replaceChildren(...actions.map(([text, action]) => actionButton(text, action, item)));
    entry.actionsKey = key;
    if (hadFocus) entry.actions.querySelector("button")?.focus();
  }
  if (pendingFocusId === item.id) pendingFocusId = null;
}

/* ── Filtering and rendering ────────────────────────────────────────────── */

function matchesFilter(item, active) {
  if (active === "all") return true;
  if (active.startsWith("type:")) return kindOf(item.filename) === active.slice(5);
  if (active === "active") return item.status === "active" || item.status === "queued";
  if (active === "failed") return item.status === "failed";
  if (active === "completed") return item.status === "completed";
  if (active === "paused") return item.status === "paused" || item.status === "recoverably_interrupted";
  return true;
}

function updateCounts() {
  const counts = { all: downloads.length };
  for (const name of ["active", "paused", "completed", "failed"]) {
    counts[name] = downloads.filter((item) => matchesFilter(item, name)).length;
  }
  for (const kind of Object.keys(KINDS)) {
    counts[`type:${kind}`] = downloads.filter((item) => kindOf(item.filename) === kind).length;
  }
  document.querySelectorAll("[data-count]").forEach((node) => {
    node.textContent = String(counts[node.dataset.count] ?? 0);
  });
}

function updateThroughput() {
  const total = downloads
    .filter((item) => item.status === "active")
    .reduce((sum, item) => sum + (item.bytes_per_second || 0), 0);
  elements.throughput.textContent = total > 0 ? `${formatBytes(total)}/s` : "0 B/s";
}

// Reconciles by download id and mutates cards in place. A full rebuild would destroy the
// button a keyboard user is standing on every time a progress event arrives.
function render() {
  const visible = downloads.filter((item) => matchesFilter(item, filter));
  const keep = new Set(visible.map((item) => item.id));

  for (const [id, entry] of cards) {
    if (!keep.has(id)) {
      entry.card.remove();
      cards.delete(id);
    }
  }
  visible.forEach((item, index) => {
    let entry = cards.get(item.id);
    if (!entry) {
      entry = createCard(item);
      cards.set(item.id, entry);
    }
    // Place the card before filling it in: an element outside the document measures zero,
    // and the segmented bar sizes itself from its own rendered width.
    if (elements.list.children[index] !== entry.card) {
      elements.list.insertBefore(entry.card, elements.list.children[index] ?? null);
    }
    updateCard(entry, item);
  });

  elements.empty.hidden = visible.length > 0;
  updateCounts();
  updateThroughput();
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
    elements.connection.textContent = "Engine connected";
    render();
  } catch (error) {
    elements.connection.textContent = "Engine unavailable";
    showError(error.message ?? String(error));
  }
}

function showError(message) {
  elements.error.textContent = message;
  elements.error.hidden = !message;
  if (message) elements.intake.hidden = false;
}

/* ── Wiring ─────────────────────────────────────────────────────────────── */

elements.rail.forEach((button) => {
  button.addEventListener("click", () => {
    filter = button.dataset.filter;
    elements.rail.forEach((other) => {
      const selected = other === button;
      other.classList.toggle("is-selected", selected);
      if (selected) other.setAttribute("aria-current", "true");
      else other.removeAttribute("aria-current");
    });
    elements.queueScope.textContent = button.querySelector(".rail-label").textContent;
    render();
  });
});

elements.openAdd.addEventListener("click", () => {
  elements.intake.hidden = false;
  elements.url.focus();
});
elements.closeAdd.addEventListener("click", () => {
  elements.intake.hidden = true;
  elements.openAdd.focus();
});

elements.form.addEventListener("submit", async (event) => {
  event.preventDefault();
  showError("");
  if (!destination) {
    showError("Choose a destination folder before adding a download.");
    elements.chooseFolder.focus();
    return;
  }
  const submit = elements.form.querySelector("button[type=submit]");
  submit.disabled = true;
  try {
    const snapshot = await bridge.invoke("submit_url", {
      url: elements.url.value,
      destination,
      organizeByType: elements.organize.checked
    });
    mergeDownload(snapshot, `${snapshot.filename} added to the queue.`);
    elements.url.value = "";
    elements.url.focus();
  } catch (error) {
    showError(error.message ?? String(error));
  } finally {
    submit.disabled = false;
  }
});

elements.chooseFolder.addEventListener("click", async () => {
  try {
    const selected = await bridge.invoke("choose_destination");
    if (selected) {
      destination = selected;
      elements.destination.textContent = selected;
    }
  } catch (error) {
    showError(error.message ?? String(error));
  }
});

async function forEachVisible(action) {
  const targets = downloads.filter((item) => matchesFilter(item, filter));
  for (const item of targets) {
    const applicable = action === "pause"
      ? ["active", "queued"].includes(item.status)
      : ["paused", "recoverably_interrupted"].includes(item.status);
    if (!applicable) continue;
    try {
      const updated = await bridge.invoke("control_download", { downloadId: item.id, action });
      mergeDownload(updated);
    } catch { /* one failure must not stop the rest of the queue */ }
  }
  elements.queueStatus.textContent = action === "pause" ? "Paused the queue." : "Resumed the queue.";
}

elements.pauseAll.addEventListener("click", () => forEachVisible("pause"));
elements.resumeAll.addEventListener("click", () => forEachVisible("resume"));
elements.refresh.addEventListener("click", refresh);

elements.dismissOffer.addEventListener("click", () => {
  clipboardOffer = null;
  elements.offer.hidden = true;
  elements.queueStatus.textContent = "Clipboard suggestion dismissed.";
});

elements.confirmOffer.addEventListener("click", async () => {
  if (!destination) {
    elements.offer.hidden = true;
    showError("Choose a destination folder before adding a download.");
    elements.chooseFolder.focus();
    return;
  }
  try {
    const snapshot = await bridge.invoke("confirm_clipboard_offer", {
      offer: clipboardOffer,
      destination,
      organizeByType: elements.organize.checked
    });
    clipboardOffer = null;
    elements.offer.hidden = true;
    mergeDownload(snapshot, `${snapshot.filename} added from the clipboard.`);
  } catch (error) {
    elements.queueStatus.textContent = `Could not add the copied link: ${error.message ?? error}`;
  }
});

bridge.listen("download-snapshot", ({ payload }) => {
  const previous = downloads.find((item) => item.id === payload.id);
  // Announce state changes only. A progress tick every half second would flood a screen reader.
  const announcement = previous && previous.status === payload.status
    ? null
    : `${payload.filename}: ${statusLabels[payload.status] ?? payload.status}`;
  mergeDownload(payload, announcement);
});

bridge.listen("clipboard-url-offer", ({ payload }) => {
  clipboardOffer = payload;
  elements.offerUrl.textContent = payload.display_url;
  elements.offer.hidden = false;
  elements.queueStatus.textContent = "A copied download link is ready for confirmation.";
});

refresh();
