import {
  WEEKDAYS, clockToMinutes, dateGroup, describeError, formatBytes, formatEta, minutesToClock,
  orderedCells, progressPercent, scheduleSummary, sourceHost, speedLimitBytes, speedLimitParts,
  statusLabel
} from "./formatters.js";
import { confirmDialog, messageDialog, toast } from "./feedback.js";

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
  settingsPanel: document.querySelector("#settings"),
  openSettings: document.querySelector("#open-settings"),
  closeSettings: document.querySelector("#close-settings"),
  limitSpeed: document.querySelector("#limit-speed"),
  speedLimitControls: document.querySelector("#speed-limit-controls"),
  speedLimit: document.querySelector("#speed-limit"),
  speedUnit: document.querySelector("#speed-unit"),
  list: document.querySelector("#download-list"),
  empty: document.querySelector("#empty-state"),
  emptyTitle: document.querySelector("#empty-state .empty-title"),
  emptyHint: document.querySelector("#empty-state .empty-hint"),
  template: document.querySelector("#download-template"),
  queueStatus: document.querySelector("#queue-status"),
  queueTitle: document.querySelector("#downloads-title"),
  engineBanner: document.querySelector("#engine-banner"),
  throughput: document.querySelector("#throughput-value"),
  search: document.querySelector("#queue-search"),
  sort: document.querySelector("#queue-sort"),
  dateFilter: document.querySelector("#date-filter"),
  pauseAll: document.querySelector("#pause-all"),
  resumeAll: document.querySelector("#resume-all"),
  retryFailed: document.querySelector("#retry-failed"),
  clearFailed: document.querySelector("#clear-failed"),
  offer: document.querySelector("#clipboard-offer"),
  offerUrl: document.querySelector("#clipboard-url"),
  confirmOffer: document.querySelector("#confirm-offer"),
  dismissOffer: document.querySelector("#dismiss-offer"),
  rail: document.querySelectorAll(".rail-item"),
  openSchedule: document.querySelector("#open-schedule"),
  closeSchedule: document.querySelector("#close-schedule"),
  schedulePanel: document.querySelector("#schedule"),
  scheduleEnabled: document.querySelector("#schedule-enabled"),
  scheduleWindow: document.querySelector("#schedule-window"),
  scheduleStart: document.querySelector("#schedule-start"),
  scheduleEnd: document.querySelector("#schedule-end"),
  scheduleDays: document.querySelector("#schedule-days"),
  scheduleConcurrent: document.querySelector("#schedule-concurrent"),
  scheduleState: document.querySelector("#schedule-state"),
  scheduleHeadline: document.querySelector("#schedule-headline"),
  scheduleDetail: document.querySelector("#schedule-detail"),
  scheduleError: document.querySelector("#schedule-error"),
  schedulePill: document.querySelector("#schedule-pill"),
  schedulePillText: document.querySelector("#schedule-pill-text")
};

/* ── Theme ──────────────────────────────────────────────────────────────── */

const THEMES = ["classic", "rye", "sesame", "pistachio", "toast"];
let theme = "";

function applyTheme(name, { persist } = {}) {
  theme = THEMES.includes(name) ? name : "";
  if (theme) document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
  document.querySelectorAll(".theme-swatch").forEach((swatch) => {
    swatch.setAttribute("aria-pressed", String(swatch.dataset.themeChoice === theme));
  });
  // Settings live in Rust and load asynchronously; this mirror lets the next launch paint
  // the right canvas before that round trip instead of flashing cream first.
  try {
    localStorage.setItem("sandwich-theme", theme);
  } catch { /* a blocked localStorage costs only the instant first paint */ }
  if (persist) persistSettings();
}

// Before first render: the mirror knows the last choice.
try {
  const remembered = localStorage.getItem("sandwich-theme");
  if (remembered) applyTheme(remembered);
} catch { /* fall through to the OS preference */ }

document.querySelectorAll(".theme-swatch").forEach((swatch) => {
  swatch.addEventListener("click", () => applyTheme(swatch.dataset.themeChoice, { persist: true }));
});

let downloads = [];
let destination = "";
// Mirrors the Rust-side default, so the panel is filled in before settings load rather than
// flashing empty fields.
let schedule = {
  enabled: false,
  start_minute: 2 * 60,
  end_minute: 7 * 60,
  days: [true, true, true, true, true, true, true],
  max_concurrent: 5
};
let clipboardOffer = null;
let filter = "all";
let searchQuery = "";
let sortMode = "status";
let dateRange = "all";
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

// Six fillings in a fixed assembly order, repeating down the row: classic, cheese, tomato,
// lettuce, pickle, chicken. Deterministic by cell position — the same file always builds the
// same sandwich, so the row reads as a deli counter filling up, not confetti.
const FILLING_COUNT = 6;

function cellCapacity(width) {
  return Math.max(MIN_CELLS, Math.min(MAX_CELLS, Math.floor(width / TARGET_CELL_PX)));
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

  const { full, partial } = orderedCells(capacity, item.completed_bytes, item.total_bytes);

  if (container.childElementCount !== capacity) {
    container.replaceChildren(...Array.from({ length: capacity }, (_, index) => {
      const cell = document.createElement("span");
      // The filling is a property of the position, not the progress: cell 3 is always the
      // tomato one, so a growing bar assembles the same deli counter every time.
      cell.className = `piece f${index % FILLING_COUNT}`;
      return cell;
    }));
  }

  container.childNodes.forEach((cell, index) => {
    const frontier = index === full && full < capacity;
    cell.classList.toggle("is-done", index < full);
    // Only claim a partly-built sandwich once there is visibly something on the bun.
    cell.classList.toggle("is-partial", frontier && partial > 0.15);
    // The frontier cell is where bytes are actually landing right now, so it is what pulses.
    cell.classList.toggle("is-active", item.status === "active" && frontier);
  });
}

/* ── Cards ──────────────────────────────────────────────────────────────── */

function actionsFor(item) {
  const status = item.status;
  if (["queued", "active"].includes(status)) return [["Pause", "pause"], ["Cancel", "cancel"]];
  // Held by the schedule rather than by the user: "Resume" would answer a question nobody
  // asked, where "Start now" names the thing the button actually does — override the window
  // for this one download.
  if (item.scheduled && status === "paused") return [["Start now", "resume"], ["Cancel", "cancel"]];
  if (["paused", "recoverably_interrupted"].includes(status)) return [["Resume", "resume"], ["Cancel", "cancel"]];
  if (status === "completed") return [["Open file", "open"], ["Show in folder", "reveal"]];
  // Recovery belongs on the thing that failed. Sending the user to a queue-wide control for
  // a single broken download is a scavenger hunt.
  if (["failed", "cancelled"].includes(status)) return [["Retry", "retry"], ["Remove", "cancel"]];
  return [];
}

/**
 * Opens a finished file, or reveals it in Explorer — after finding out whether it still
 * exists. The file system moves on without telling us: users move and delete downloads, and
 * clicking "Show in folder" on a ghost used to either error cryptically or open the wrong
 * folder. A missing file gets a straight answer and the two useful ways forward.
 */
async function openDownloadTarget(item, reveal) {
  try {
    await bridge.invoke(reveal ? "reveal_completed_file" : "open_completed_file", { downloadId: item.id });
  } catch (error) {
    if (String(error?.message ?? error) !== "missing") {
      toast(`Could not ${reveal ? "show" : "open"} ${item.filename}: ${error.message ?? error}`, { tone: "error" });
      return;
    }
    const choice = await messageDialog({
      title: "File not found",
      body: `${item.filename} no longer exists in ${item.directory || "its folder"}. It may have been moved or deleted.`,
      actions: [
        { id: "close", label: "Close" },
        { id: "remove", label: "Remove from list" },
        { id: "redownload", label: "Download again", className: "primary" }
      ]
    });
    if (choice === "redownload") {
      const updated = await bridge.invoke("control_download", { downloadId: item.id, action: "retry" });
      if (updated.id !== item.id) downloads = downloads.filter((entry) => entry.id !== item.id);
      mergeDownload(updated, `${item.filename}: downloading again.`);
      toast(`Downloading ${item.filename} again`, { tone: "info" });
    } else if (choice === "remove") {
      await bridge.invoke("control_download", { downloadId: item.id, action: "cancel" });
      downloads = downloads.filter((entry) => entry.id !== item.id);
      render();
      toast(`${item.filename} removed from the list`, { tone: "info" });
    }
  }
}

function actionButton(label, action, item) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = action === "cancel" ? "quiet danger" : "secondary";
  button.textContent = label;
  button.setAttribute("aria-label", `${label} ${item.filename}`);
  button.addEventListener("click", async () => {
    if (document.activeElement === button) pendingFocusId = item.id;

    // Killing a live transfer throws away real progress, so it gets a question first.
    // Removing an already-dead entry only clears a line from a list; asking would be nagging.
    const live = ["active", "queued", "paused", "recoverably_interrupted"].includes(item.status);
    if (action === "cancel" && live) {
      const sure = await confirmDialog({
        title: "Cancel this download?",
        body: `${item.filename} will stop. Partial data stays on disk and a retry can pick it back up.`,
        confirmLabel: "Cancel download",
        cancelLabel: "Keep downloading",
        tone: "danger"
      });
      if (!sure) return;
    }

    button.disabled = true;
    try {
      if (action === "open" || action === "reveal") await openDownloadTarget(item, action === "reveal");
      else if (action === "cancel" && !live) {
        // On a dead transfer this button reads "Remove": the user is clearing the entry,
        // so take it off the list now rather than leaving a card that waits for a poll.
        await bridge.invoke("control_download", { downloadId: item.id, action });
        downloads = downloads.filter((entry) => entry.id !== item.id);
        render();
        elements.queueStatus.textContent = `${item.filename} removed from the list.`;
      } else {
        const updated = await bridge.invoke("control_download", { downloadId: item.id, action });
        // A retry is a new transfer with a new id; the failed original it replaces goes away.
        if (updated.id !== item.id) downloads = downloads.filter((entry) => entry.id !== item.id);
        mergeDownload(updated, `${item.filename}: ${statusLabel(updated)}`);
        if (action === "retry") toast(`Retrying ${item.filename}`, { tone: "info" });
      }
    } catch (error) {
      toast(`${label} failed for ${item.filename}: ${error.message ?? error}`, { tone: "error" });
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
    source: card.querySelector(".download-source"),
    percent: card.querySelector(".percent"),
    disclosure: card.querySelector(".disclosure"),
    stack: card.querySelector(".stack"),
    pieces: card.querySelector(".stack-pieces"),
    size: card.querySelector(".size"),
    speed: card.querySelector(".speed"),
    eta: card.querySelector(".eta"),
    conns: card.querySelector(".conns"),
    error: card.querySelector(".download-error"),
    errorHeadline: card.querySelector(".error-headline"),
    errorHint: card.querySelector(".error-hint"),
    details: card.querySelector(".details"),
    detailUrl: card.querySelector(".detail-url"),
    detailDir: card.querySelector(".detail-dir"),
    detailPieces: card.querySelector(".detail-pieces"),
    detailResume: card.querySelector(".detail-resume"),
    detailRawRow: card.querySelector(".detail-raw-row"),
    detailRaw: card.querySelector(".detail-raw"),
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
  const label = statusLabel(item);
  const rounded = Math.round(percent);
  const dead = ["failed", "cancelled"].includes(item.status);

  entry.kind.textContent = kindGlyph(kindOf(item.filename));
  entry.filename.textContent = item.filename;
  entry.filename.title = item.filename;
  entry.state.textContent = label;
  // Provenance beside the state: three cards all named "download" are indistinguishable
  // without it, and for an executable the origin is a safety fact.
  const host = sourceHost(item.source_url);
  entry.source.textContent = host;
  entry.source.hidden = !host;
  if (host) entry.source.title = item.source_url;

  // Some servers never send a length. Claiming "0% of 0 B" is worse than admitting we
  // do not know: the transfer is running fine, the size simply is not knowable yet.
  const sizeKnown = item.total_bytes > 0;
  // A dead transfer has no meaningful percentage; a lone "—" in its corner reads as a
  // mystery control, so show nothing at all.
  entry.percent.hidden = dead;
  entry.percent.textContent = dead ? "" : sizeKnown ? `${rounded}%` : "—";
  entry.size.textContent = sizeKnown
    ? `${formatBytes(item.completed_bytes)} of ${formatBytes(item.total_bytes)}`
    : `${formatBytes(item.completed_bytes)} so far`;
  entry.speed.textContent = item.status === "active" && item.bytes_per_second > 0
    ? `${formatBytes(item.bytes_per_second)}/s`
    : "—";
  entry.eta.textContent = item.status === "active" ? formatEta(item.eta_seconds) : "—";
  entry.conns.textContent = item.status === "active" ? String(item.connections || 0) : "—";
  // A metric whose value is "—" is noise, not information: hide the pair, not just the value.
  for (const metric of [entry.speed, entry.eta, entry.conns]) {
    metric.closest(".metric").hidden = metric.textContent === "—";
  }

  if (item.error?.message) {
    const { headline, hint } = describeError(item.error);
    entry.errorHeadline.textContent = headline;
    entry.errorHint.textContent = hint;
    entry.error.hidden = false;
  } else {
    entry.error.hidden = true;
  }
  entry.card.dataset.status = item.status;
  entry.card.dataset.scheduled = String(Boolean(item.scheduled));

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
    entry.detailRawRow.hidden = !item.error?.message;
    entry.detailRaw.textContent = item.error?.message ?? "";
  }

  // Replacing the buttons destroys keyboard focus, so only do it when the actions change.
  const actions = actionsFor(item);
  // Keyed on the labels too, not just the actions: "Resume" and "Start now" are the same
  // command with different meanings, and only the wording tells the user which one they are
  // about to do.
  const key = actions.map((pair) => pair.join(":")).join("|");
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

function matchesSearch(item) {
  if (!searchQuery) return true;
  const haystack = `${item.filename} ${item.source_url ?? ""}`.toLowerCase();
  return haystack.includes(searchQuery);
}

/** A download's place on the calendar: when it finished, or failing that, when it started. */
function itemDate(item) {
  return item.completed_at ?? item.added_at ?? 0;
}

function matchesDate(item) {
  if (dateRange === "all") return true;
  const stamp = itemDate(item);
  if (!stamp) return false;
  const now = new Date();
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() / 1000;
  if (dateRange === "today") return stamp >= midnight;
  if (dateRange === "week") return stamp >= midnight - 6 * 86400;
  if (dateRange === "month") return stamp >= midnight - 29 * 86400;
  return true;
}

function updateCounts() {
  const counts = { all: downloads.length };
  for (const name of ["active", "paused", "completed", "failed"]) {
    counts[name] = downloads.filter((item) => matchesFilter(item, name)).length;
  }
  // "other" included: every download must be reachable through some type filter, or the
  // sidebar's arithmetic quietly stops adding up to the total.
  for (const kind of [...Object.keys(KINDS), "other"]) {
    counts[`type:${kind}`] = downloads.filter((item) => kindOf(item.filename) === kind).length;
  }
  document.querySelectorAll("[data-count]").forEach((node) => {
    node.textContent = String(counts[node.dataset.count] ?? 0);
  });
}

// What the user most needs to see comes first: work in motion, then things they could act
// on, then failures needing a decision, then history.
const STATUS_ORDER = {
  active: 0, queued: 1, paused: 2, recoverably_interrupted: 2, failed: 3, cancelled: 4, completed: 5
};

function orderDownloads(items) {
  const ranked = items.map((item, index) => ({ item, index }));
  const by = {
    status: (a, b) => (STATUS_ORDER[a.item.status] ?? 9) - (STATUS_ORDER[b.item.status] ?? 9),
    newest: (a, b) => itemDate(b.item) - itemDate(a.item),
    name: (a, b) => a.item.filename.localeCompare(b.item.filename, undefined, { sensitivity: "base" }),
    size: (a, b) => (b.item.total_bytes || 0) - (a.item.total_bytes || 0)
  }[sortMode] ?? (() => 0);
  // Stable within equal keys, so cards do not shuffle as progress events arrive.
  ranked.sort((a, b) => by(a, b) || a.index - b.index);
  return ranked.map(({ item }) => item);
}

function updateThroughput() {
  const total = downloads
    .filter((item) => item.status === "active")
    .reduce((sum, item) => sum + (item.bytes_per_second || 0), 0);
  elements.throughput.textContent = total > 0 ? `${formatBytes(total)}/s` : "0 B/s";
}

// Shelf labels between cards when the queue is sorted by date. Cached per label so the
// reconciler can move them without rebuilding, like the cards themselves.
const groupHeaders = new Map();
function groupHeader(label) {
  let header = groupHeaders.get(label);
  if (!header) {
    header = document.createElement("li");
    header.className = "date-group";
    header.textContent = label;
    // Presentation only: the card's aria-label already tells the whole story, and a list
    // item that is not a download would trip up "3 of 7 items" narration.
    header.setAttribute("aria-hidden", "true");
    groupHeaders.set(label, header);
  }
  return header;
}

// Reconciles by download id and mutates cards in place. A full rebuild would destroy the
// button a keyboard user is standing on every time a progress event arrives.
function render() {
  const visible = orderDownloads(
    downloads.filter((item) => matchesFilter(item, filter) && matchesSearch(item) && matchesDate(item))
  );
  const keep = new Set(visible.map((item) => item.id));

  for (const [id, entry] of cards) {
    if (!keep.has(id)) {
      entry.card.remove();
      cards.delete(id);
    }
  }

  // The list is cards plus, under date sort, a shelf label wherever the calendar changes.
  const nodes = [];
  const pending = [];
  let lastShelf = null;
  const nowSeconds = Date.now() / 1000;
  for (const item of visible) {
    if (sortMode === "newest") {
      const shelf = dateGroup(itemDate(item), nowSeconds);
      if (shelf !== lastShelf) {
        nodes.push(groupHeader(shelf));
        lastShelf = shelf;
      }
    }
    let entry = cards.get(item.id);
    if (!entry) {
      entry = createCard(item);
      cards.set(item.id, entry);
    }
    nodes.push(entry.card);
    pending.push([entry, item]);
  }
  for (const [label, header] of groupHeaders) {
    if (!nodes.includes(header)) {
      header.remove();
      groupHeaders.delete(label);
    }
  }
  nodes.forEach((node, index) => {
    if (elements.list.children[index] !== node) {
      elements.list.insertBefore(node, elements.list.children[index] ?? null);
    }
  });
  // Fill cards in only once they are placed: an element outside the document measures zero,
  // and the segmented bar sizes itself from its own rendered width.
  for (const [entry, item] of pending) updateCard(entry, item);

  elements.empty.hidden = visible.length > 0;
  if (visible.length === 0) {
    // Say *why* the plate is empty: "no results for your search" and "you have no downloads"
    // call for different next moves, and one generic message hides that.
    if (searchQuery) {
      elements.emptyTitle.textContent = `No downloads match “${elements.search.value.trim()}”`;
      elements.emptyHint.textContent = "Check the spelling, or clear the search to see the whole queue.";
    } else if (dateRange !== "all" && downloads.length > 0) {
      elements.emptyTitle.textContent = "Nothing in this period";
      elements.emptyHint.textContent = "Widen the date filter to see older downloads.";
    } else if (filter !== "all" && downloads.length > 0) {
      elements.emptyTitle.textContent = `Nothing under ${elements.queueTitle.textContent}`;
      elements.emptyHint.textContent = "Downloads appear here as soon as one reaches this state.";
    } else {
      elements.emptyTitle.textContent = "Nothing on the plate yet";
      elements.emptyHint.textContent = "Add a URL, or copy a link and Sandwich will offer to fetch it.";
    }
  }
  updateCounts();
  updateThroughput();

  // Bulk failure controls only exist while there is a failure to act on.
  const failed = downloads.filter((item) => item.status === "failed");
  elements.retryFailed.hidden = failed.length === 0;
  elements.clearFailed.hidden = failed.length === 0;
}

function mergeDownload(snapshot, announcement) {
  const index = downloads.findIndex((item) => item.id === snapshot.id);
  if (index < 0) downloads.unshift(snapshot); else downloads[index] = snapshot;
  render();
  if (announcement) elements.queueStatus.textContent = announcement;
}

async function refresh() {
  // The window opens on the clock with nothing for the user to click, so the indicator has to
  // keep itself honest. This costs no engine round trip — it reads the schedule and a counter.
  refreshScheduleStatus();
  try {
    downloads = await bridge.invoke("list_downloads");
    // Connectivity is only news when it is bad. A permanent "connected" badge is plumbing.
    elements.engineBanner.hidden = true;
    render();
  } catch {
    elements.engineBanner.hidden = false;
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
    elements.queueTitle.textContent = button.querySelector(".rail-label").textContent;
    render();
  });
});

elements.openAdd.addEventListener("click", () => {
  elements.intake.hidden = false;
  // First run lands on the decision still to make; once a folder is set it sticks, so
  // returning users go straight to the URL without paying a click for the new field order.
  if (destination) elements.url.focus();
  else elements.chooseFolder.focus();
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
    toast(`Queued ${snapshot.filename}`, { tone: "success" });
    elements.url.value = "";
    elements.url.focus();
  } catch (error) {
    showError(error.message ?? String(error));
  } finally {
    submit.disabled = false;
  }
});

let dismissSettingsToast = null;

async function persistSettings() {
  try {
    // The backend applies the schedule as part of saving and hands back what that did, so the
    // panel can say "downloads start at 02:00" from the same round trip rather than guessing
    // and being corrected a moment later.
    const status = await bridge.invoke("save_settings", {
      settings: {
        destination,
        organize_by_type: elements.organize.checked,
        theme,
        speed_limit_bytes: currentSpeedLimit(),
        schedule
      }
    });
    if (status) showScheduleStatus(status);
    // One quiet receipt, replaced rather than stacked when settings change in a burst.
    dismissSettingsToast?.();
    dismissSettingsToast = toast("Settings saved", { tone: "success" });
  } catch {
    // Preferences are a convenience; failing to store them must not interrupt a download —
    // but it must not be silent either, or the user finds out on the next launch.
    dismissSettingsToast?.();
    dismissSettingsToast = toast("Settings could not be saved — they apply for now but may not survive a restart.", { tone: "error" });
  }
}

elements.chooseFolder.addEventListener("click", async () => {
  try {
    const selected = await bridge.invoke("choose_destination");
    if (selected) {
      destination = selected;
      elements.destination.textContent = selected;
      persistSettings();
    }
  } catch (error) {
    showError(error.message ?? String(error));
  }
});

elements.organize.addEventListener("change", persistSettings);

/* ── Transfer limits ────────────────────────────────────────────────────── */

/** Zero when switched off, which is aria2's own value for unlimited. */
function currentSpeedLimit() {
  if (!elements.limitSpeed.checked) return 0;
  return speedLimitBytes(elements.speedLimit.value, elements.speedUnit.value);
}

/** Paints a stored byte ceiling back as a readable amount and unit. */
function showSpeedLimit(bytes) {
  const value = Number(bytes);
  const limited = Number.isSafeInteger(value) && value > 0;
  elements.limitSpeed.checked = limited;
  elements.speedLimitControls.hidden = !limited;
  const { amount, unitBytes } = speedLimitParts(limited ? value : 0);
  elements.speedLimit.value = String(amount);
  elements.speedUnit.value = String(unitBytes);
}

elements.openSettings.addEventListener("click", () => {
  const opening = elements.settingsPanel.hidden;
  elements.settingsPanel.hidden = !opening;
  elements.openSettings.setAttribute("aria-expanded", String(opening));
  if (opening) elements.limitSpeed.focus();
});
elements.closeSettings.addEventListener("click", () => {
  elements.settingsPanel.hidden = true;
  elements.openSettings.setAttribute("aria-expanded", "false");
  elements.openSettings.focus();
});

elements.limitSpeed.addEventListener("change", () => {
  elements.speedLimitControls.hidden = !elements.limitSpeed.checked;
  if (elements.limitSpeed.checked) elements.speedLimit.focus();
  persistSettings();
});

// Commit completed edits rather than every keystroke: typing 500 must not briefly apply 5 B/s.
for (const control of [elements.speedLimit, elements.speedUnit]) {
  control.addEventListener("change", () => {
    if (elements.limitSpeed.checked) showSpeedLimit(currentSpeedLimit());
    persistSettings();
  });
}

/* ── Schedule ───────────────────────────────────────────────────────────── */

// The day boxes are generated rather than written out seven times, so the labels, the order and
// the schedule's own Monday-first indexing cannot drift apart.
const dayBoxes = WEEKDAYS.map((day, index) => {
  const label = document.createElement("label");
  label.className = "day-choice";
  const box = document.createElement("input");
  box.type = "checkbox";
  box.dataset.day = String(index);
  box.setAttribute("aria-label", day.long);
  const text = document.createElement("span");
  text.textContent = day.short;
  text.setAttribute("aria-hidden", "true");
  label.append(box, text);
  elements.scheduleDays.append(label);
  box.addEventListener("change", commitSchedule);
  return box;
});

/** Paints the controls from the schedule we hold. Never reads them; that is `readSchedule`. */
function showSchedule() {
  elements.scheduleEnabled.checked = schedule.enabled;
  elements.scheduleStart.value = minutesToClock(schedule.start_minute);
  elements.scheduleEnd.value = minutesToClock(schedule.end_minute);
  elements.scheduleConcurrent.value = String(schedule.max_concurrent);
  dayBoxes.forEach((box, index) => { box.checked = Boolean(schedule.days[index]); });
  // The window controls are meaningless while the window is off, and a disabled fieldset says
  // so in a way both a mouse and a screen reader understand. Concurrency lives in Transfer
  // limits because it applies whether or not the hours are restricted.
  elements.scheduleWindow.disabled = !schedule.enabled;
}

/**
 * Reads the controls back into a schedule, or reports why it cannot.
 *
 * A half-typed time is the normal case, not an error state — time inputs are empty between
 * keystrokes — so an unreadable field leaves the stored value alone instead of writing
 * midnight over the user's window.
 */
function readSchedule() {
  const start = clockToMinutes(elements.scheduleStart.value);
  const end = clockToMinutes(elements.scheduleEnd.value);
  const days = dayBoxes.map((box) => box.checked);
  const requested = Number(elements.scheduleConcurrent.value);
  const concurrent = Number.isFinite(requested)
    ? Math.min(16, Math.max(1, Math.round(requested)))
    : schedule.max_concurrent;

  const next = {
    enabled: elements.scheduleEnabled.checked,
    start_minute: start ?? schedule.start_minute,
    end_minute: end ?? schedule.end_minute,
    days,
    max_concurrent: concurrent
  };

  // Two ways to write a schedule that silently downloads nothing. Both are easy to do by
  // accident and impossible to diagnose from the queue, so they are called out here rather
  // than left to be discovered at 2am.
  let problem = "";
  if (next.enabled && days.every((day) => !day)) {
    problem = "No days are ticked, so nothing will download. Tick at least one day.";
  } else if (next.enabled && (start === null || end === null)) {
    problem = "Enter both times as hours and minutes.";
  }
  return { next, problem };
}

function commitSchedule() {
  const { next, problem } = readSchedule();
  elements.scheduleError.textContent = problem;
  elements.scheduleError.hidden = !problem;
  schedule = next;
  // Show the normalized value instead of leaving the field to disagree with the backend.
  elements.scheduleConcurrent.value = String(schedule.max_concurrent);
  elements.scheduleWindow.disabled = !schedule.enabled;
  persistSettings();
}

/** Puts the backend's answer about the window into both places that report it. */
function showScheduleStatus(status) {
  const summary = scheduleSummary(status, Date.now());
  elements.scheduleHeadline.textContent = summary.headline;
  elements.scheduleDetail.textContent = summary.detail;
  elements.scheduleState.dataset.state = summary.state;
  elements.schedulePill.hidden = !summary.pill;
  elements.schedulePillText.textContent = summary.pill;
}

async function refreshScheduleStatus() {
  try {
    showScheduleStatus(await bridge.invoke("schedule_status"));
  } catch {
    // The engine being unreachable already has its own banner; a second alarm about the
    // schedule would be the same news twice.
  }
}

elements.scheduleEnabled.addEventListener("change", commitSchedule);
elements.scheduleConcurrent.addEventListener("change", commitSchedule);
// Times commit on change rather than on input: "change" fires when the field holds a complete
// time, so a window is never briefly saved as 02:00–00:00 while the second field is half typed.
elements.scheduleStart.addEventListener("change", commitSchedule);
elements.scheduleEnd.addEventListener("change", commitSchedule);

function openSchedulePanel() {
  elements.schedulePanel.hidden = false;
  refreshScheduleStatus();
  elements.scheduleEnabled.focus();
}
elements.openSchedule.addEventListener("click", openSchedulePanel);
// The indicator is the thing people will actually click when they want to know why nothing is
// downloading, so it opens the panel that answers that.
elements.schedulePill.addEventListener("click", openSchedulePanel);
elements.closeSchedule.addEventListener("click", () => {
  elements.schedulePanel.hidden = true;
  elements.openSchedule.focus();
});

async function forEachVisible(action) {
  const targets = downloads.filter((item) => matchesFilter(item, filter));
  let touched = 0;
  for (const item of targets) {
    const applicable = action === "pause"
      ? ["active", "queued"].includes(item.status)
      : ["paused", "recoverably_interrupted"].includes(item.status);
    if (!applicable) continue;
    try {
      const updated = await bridge.invoke("control_download", { downloadId: item.id, action });
      mergeDownload(updated);
      touched += 1;
    } catch { /* one failure must not stop the rest of the queue */ }
  }
  const verb = action === "pause" ? "Paused" : "Resumed";
  elements.queueStatus.textContent = `${verb} the queue.`;
  // "Pause all" with nothing to pause is a click into the void without this.
  toast(touched > 0 ? `${verb} ${touched} download${touched === 1 ? "" : "s"}` : "Nothing to " + action, { tone: "info" });
}

elements.pauseAll.addEventListener("click", () => forEachVisible("pause"));
elements.resumeAll.addEventListener("click", () => forEachVisible("resume"));

// Bulk recovery for failures: retry re-queues each one; clear removes them from the list.
async function forEachFailed(action, announcement) {
  for (const item of downloads.filter((entry) => entry.status === "failed")) {
    try {
      const updated = await bridge.invoke("control_download", { downloadId: item.id, action });
      downloads = downloads.filter((entry) => entry.id !== item.id);
      if (action === "retry") downloads.unshift(updated);
    } catch { /* one failure must not stop the rest */ }
  }
  render();
  elements.queueStatus.textContent = announcement;
}
elements.retryFailed.addEventListener("click", async () => {
  await forEachFailed("retry", "Retrying every failed download.");
  toast("Retrying every failed download", { tone: "info" });
});
elements.clearFailed.addEventListener("click", async () => {
  const count = downloads.filter((item) => item.status === "failed").length;
  const sure = await confirmDialog({
    title: "Clear failed downloads?",
    body: `${count} failed download${count === 1 ? "" : "s"} will be removed from the list. Files already on disk stay where they are.`,
    confirmLabel: "Clear failed",
    tone: "danger"
  });
  if (!sure) return;
  await forEachFailed("cancel", "Cleared the failed downloads.");
  toast(`Cleared ${count} failed download${count === 1 ? "" : "s"}`, { tone: "info" });
});

elements.search.addEventListener("input", () => {
  searchQuery = elements.search.value.trim().toLowerCase();
  render();
});
elements.sort.addEventListener("change", () => {
  sortMode = elements.sort.value;
  render();
});
elements.dateFilter.addEventListener("change", () => {
  dateRange = elements.dateFilter.value;
  render();
});

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
    toast(`Queued ${snapshot.filename}`, { tone: "success" });
  } catch (error) {
    toast(`Could not add the copied link: ${error.message ?? error}`, { tone: "error" });
  }
});

bridge.listen("download-snapshot", ({ payload }) => {
  const previous = downloads.find((item) => item.id === payload.id);
  // Announce state changes only. A progress tick every half second would flood a screen reader.
  // "Scheduled" counts as a state: a download going from running to waiting for the window is
  // exactly the kind of thing somebody not watching the screen needs told.
  const unchanged = previous
    && previous.status === payload.status
    && Boolean(previous.scheduled) === Boolean(payload.scheduled);
  mergeDownload(payload, unchanged ? null : `${payload.filename}: ${statusLabel(payload)}`);
});

/* ── Updates ────────────────────────────────────────────────────────────── */

// Checked shortly after startup and every few hours while running: a download manager stays
// open for days, so "on launch" alone would miss most of the fleet. A failed background
// check is logged, never surfaced — nagging about a flaky network to someone who didn't ask
// anything teaches them to dismiss real messages.
const UPDATE_RECHECK_MS = 4 * 60 * 60 * 1000;
let updateOffered = "";

async function offerUpdateIfAvailable() {
  let update = null;
  try {
    update = await bridge.invoke("check_for_update");
  } catch (error) {
    console.warn("update check failed:", error);
    return;
  }
  if (!update || update.version === updateOffered) return;
  updateOffered = update.version;
  toast(`Sandwich ${update.version} is available`, {
    tone: "info",
    sticky: true,
    actions: [{
      label: "Update now",
      onClick: async () => {
        const progress = toast("Downloading the update — Sandwich will restart itself when it is ready.", { tone: "info", sticky: true });
        try {
          await bridge.invoke("install_update");
        } catch (error) {
          progress();
          // The raw plugin error can be a 400-character signature dump. Sort the failure into
          // the two cases a person can act on differently, keep the forensics in the console.
          console.error("update install failed:", error);
          const message = String(error?.message ?? error);
          const explanation = /signature|verify|decode/i.test(message)
            ? "The update's signature could not be verified, so it was not installed. The download may be corrupted — or not the real thing. Your current version keeps running."
            : "The update could not be downloaded. Check your connection and try again later — Sandwich will also re-check on its own.";
          toast(explanation, { tone: "error" });
        }
      }
    }]
  });
}

setTimeout(offerUpdateIfAvailable, 15_000);
setInterval(offerUpdateIfAvailable, UPDATE_RECHECK_MS);

bridge.listen("download-completed", ({ payload }) => {
  toast(`${payload.filename} finished downloading`, {
    tone: "success",
    actions: [
      { label: "Open", onClick: () => openDownloadTarget(payload, false) },
      { label: "Show in folder", onClick: () => openDownloadTarget(payload, true) }
    ]
  });
});

bridge.listen("clipboard-url-offer", ({ payload }) => {
  clipboardOffer = payload;
  elements.offerUrl.textContent = payload.display_url;
  elements.offer.hidden = false;
  elements.queueStatus.textContent = "A copied download link is ready for confirmation.";
});

async function restoreSettings() {
  try {
    const stored = await bridge.invoke("load_settings");
    if (stored?.destination) {
      destination = stored.destination;
      elements.destination.textContent = stored.destination;
    }
    elements.organize.checked = Boolean(stored?.organize_by_type);
    showSpeedLimit(stored?.speed_limit_bytes ?? 0);
    // The Rust store is the durable truth; the localStorage mirror only bridged the gap
    // until this load finished.
    if (stored?.theme) applyTheme(stored.theme);
    // A settings file written before scheduling existed has no schedule at all; the defaults
    // already loaded stand in, and they are the ones that restrict nothing.
    if (stored?.schedule) schedule = { ...schedule, ...stored.schedule };
  } catch {
    // First run, or preferences unavailable: the defaults in the markup already apply.
  }
  showSchedule();
}

restoreSettings().finally(refresh);

// Snapshot events carry live progress; this slow full re-sync is the safety net that catches
// anything they miss (a removed transfer, an engine restart) and clears the outage banner.
// It also replaces the manual Refresh button: a real-time queue asking to be refreshed by
// hand was an implementation detail showing through the paint.
setInterval(refresh, 5000);

// Deliberate test hook: the UI suite needs to trigger the exact refresh code path without a
// user-facing control existing for it.
window.__sandwichRefresh = refresh;
