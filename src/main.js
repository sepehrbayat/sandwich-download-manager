import {
  aggregateStatus, batchProgressLabel, batchTotals, describePreview,
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
  schedulePillText: document.querySelector("#schedule-pill-text"),
  modeSingle: document.querySelector("#mode-single"),
  modeMany: document.querySelector("#mode-many"),
  singleMode: document.querySelector("#single-mode"),
  manyMode: document.querySelector("#many-mode"),
  batchInput: document.querySelector("#batch-input"),
  batchName: document.querySelector("#batch-name"),
  batchState: document.querySelector("#batch-state"),
  batchHeadline: document.querySelector("#batch-headline"),
  batchDetail: document.querySelector("#batch-detail"),
  batchRejects: document.querySelector("#batch-rejects"),
  batchRejectsSummary: document.querySelector("#batch-rejects-summary"),
  batchRejectList: document.querySelector("#batch-reject-list"),
  submitBatch: document.querySelector("#submit-batch"),
  submitSingle: document.querySelector("#submit-single")
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
  // A batch is acted on as one thing — that is the whole reason it is one card. Per-part
  // recovery lives on the member rows inside it, where a single broken part can be retried
  // without touching the other forty-nine.
  if (item.isBatch) {
    if (["queued", "active"].includes(status)) return [["Pause all", "pause"], ["Cancel all", "cancel"]];
    if (item.scheduled && status === "paused") return [["Start all now", "resume"], ["Cancel all", "cancel"]];
    if (status === "paused") return [["Resume all", "resume"], ["Cancel all", "cancel"]];
    if (status === "completed") return [["Show in folder", "reveal"]];
    return [["Retry failed", "retry"], ["Remove all", "cancel"]];
  }
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

/**
 * Carries out a batch-level action.
 *
 * Pause, resume and cancel are one call because the backend owns the group. "Retry failed" is
 * deliberately not: it re-queues each broken part through the ordinary single-download path, so
 * a retried part gets the same policy, destination and scheduling treatment as any other — and
 * the backend keeps it in the batch by swapping the id in place.
 */
async function runBatchAction(item, action, label) {
  if (action === "reveal") {
    const anywhere = item.members.find((member) => member.status === "completed") ?? item.members[0];
    await openDownloadTarget(anywhere, true);
    return;
  }

  if (action === "retry") {
    const broken = item.members.filter((member) => ["failed", "cancelled"].includes(member.status));
    if (broken.length === 0) {
      toast("Nothing in this batch has failed", { tone: "info" });
      return;
    }
    let restarted = 0;
    for (const member of broken) {
      try {
        const updated = await bridge.invoke("control_download", { downloadId: member.id, action: "retry" });
        downloads = downloads.filter((entry) => entry.id !== member.id);
        downloads.unshift(updated);
        restarted += 1;
      } catch { /* one part that will not restart must not stop the others */ }
    }
    render();
    // Report what happened, not what was attempted. "Retrying 3 failed files" while all three
    // stayed failed is worse than saying nothing.
    if (restarted === 0) {
      const message = `Could not restart any of the ${broken.length} failed file${broken.length === 1 ? "" : "s"} in ${item.filename}`;
      elements.queueStatus.textContent = `${message}.`;
      toast(message, { tone: "error" });
      return;
    }
    const message = `Retrying ${restarted} failed file${restarted === 1 ? "" : "s"} in ${item.filename}`;
    elements.queueStatus.textContent = `${message}.`;
    toast(message, { tone: "info" });
    return;
  }

  const result = await bridge.invoke("control_batch", { batchId: item.batch_id, action });
  // Only what the engine confirmed is gone leaves the list. A cancel that half succeeded leaves
  // the survivors on screen rather than hiding transfers that are still running.
  const gone = new Set(result?.removed ?? []);
  if (gone.size > 0) downloads = downloads.filter((entry) => !gone.has(entry.id));
  for (const snapshot of result?.updated ?? []) {
    const index = downloads.findIndex((entry) => entry.id === snapshot.id);
    if (index < 0) downloads.unshift(snapshot); else downloads[index] = snapshot;
  }
  render();

  if (action === "cancel") {
    const stranded = item.members.length - gone.size;
    if (stranded > 0) {
      const message = `${stranded} file${stranded === 1 ? "" : "s"} in ${item.filename} could not be cancelled`;
      elements.queueStatus.textContent = `${message}.`;
      toast(message, { tone: "error" });
      return;
    }
    elements.queueStatus.textContent = `${item.filename} removed from the list.`;
    toast(`Cancelled ${item.filename}`, { tone: "info" });
    return;
  }
  elements.queueStatus.textContent = `${item.filename}: ${label.toLowerCase()}.`;
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
    // A batch is live if anything in it still is. Asking "this will stop" about a batch whose
    // parts have all failed is the same nagging the single-download path deliberately skips.
    const runnable = (status) => ["active", "queued", "paused", "recoverably_interrupted"].includes(status);
    const live = item.isBatch
      ? item.members.some((member) => runnable(member.status))
      : runnable(item.status);
    if (action === "cancel" && live) {
      // Cancelling a batch throws away the progress of every part at once, so it says how many
      // and how much rather than asking about "this download" as though it were one file.
      const sure = await confirmDialog({
        title: item.isBatch ? `Cancel all ${item.members.length} files?` : "Cancel this download?",
        body: item.isBatch
          ? `${item.filename} will stop, including the ${item.totals.done} already finished. Partial data stays on disk and a retry can pick it back up.`
          : `${item.filename} will stop. Partial data stays on disk and a retry can pick it back up.`,
        confirmLabel: item.isBatch ? "Cancel the batch" : "Cancel download",
        cancelLabel: "Keep downloading",
        tone: "danger"
      });
      if (!sure) return;
    }

    button.disabled = true;
    try {
      if (item.isBatch) {
        await runBatchAction(item, action, label);
      } else if (action === "open" || action === "reveal") await openDownloadTarget(item, action === "reveal");
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
    memberList: card.querySelector(".member-list"),
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

/**
 * Lists a batch's parts inside its expanded card.
 *
 * Compact rows rather than nested cards: fifty full cards inside one card is the mess the
 * grouping exists to prevent. Only a broken part gets a control, because a broken part is the
 * only one a person needs to do something about individually.
 */
function buildMemberRow(entry, member) {
  const row = document.createElement("li");
  row.className = "member";

  const name = document.createElement("span");
  name.className = "member-name";

  const state = document.createElement("span");
  state.className = "member-state";

  // Always present, hidden until it is needed. Adding and removing it as parts fail and recover
  // would destroy the button under a keyboard user's finger on the next poll.
  const retry = document.createElement("button");
  retry.type = "button";
  retry.className = "quiet member-retry";
  retry.textContent = "Retry";
  retry.addEventListener("click", async () => {
    const target = row.dataset.id;
    retry.disabled = true;
    try {
      const updated = await bridge.invoke("control_download", { downloadId: target, action: "retry" });
      downloads = downloads.filter((existing) => existing.id !== target);
      downloads.unshift(updated);
      render();
      toast(`Retrying ${row.dataset.filename}`, { tone: "info" });
    } catch (error) {
      toast(`Could not retry ${row.dataset.filename}: ${error.message ?? error}`, { tone: "error" });
    } finally {
      if (retry.isConnected) retry.disabled = false;
    }
  });

  row.append(name, state, retry);
  entry.memberRows.set(member.id, { row, name, state, retry });
  return row;
}

function updateMemberRow(parts, member) {
  const { row, name, state, retry } = parts;
  row.dataset.status = member.status;
  row.dataset.id = member.id;
  row.dataset.filename = member.filename;
  name.textContent = member.filename;
  name.title = member.source_url || member.filename;
  state.textContent = member.status === "active"
    ? `${Math.round(progressPercent(member.completed_bytes, member.total_bytes))}%`
    : statusLabel(member);
  retry.hidden = !["failed", "cancelled"].includes(member.status);
  retry.setAttribute("aria-label", `Retry ${member.filename}`);
}

/**
 * Lists a batch's parts inside its expanded card.
 *
 * Compact rows rather than nested cards: fifty full cards inside one card is the mess the
 * grouping exists to prevent. Reconciled in place for the same reason the queue itself is —
 * rebuilding fifty rows twice a second would throw away the row a keyboard user is standing on,
 * and their click would never land.
 */
function renderMembers(entry, item) {
  entry.memberRows ??= new Map();
  const key = item.members.map((member) => member.id).join("|");
  if (entry.memberKey !== key) {
    entry.memberRows = new Map();
    entry.memberList.replaceChildren(...item.members.map((member) => buildMemberRow(entry, member)));
    entry.memberKey = key;
  }
  for (const member of item.members) {
    const parts = entry.memberRows.get(member.id);
    if (parts) updateMemberRow(parts, member);
  }
}

function updateCard(entry, item) {
  const percent = progressPercent(item.completed_bytes, item.total_bytes);
  const label = statusLabel(item);
  const rounded = Math.round(percent);
  const dead = ["failed", "cancelled"].includes(item.status);

  // A batch takes the glyph of what it holds — fifty .rar parts are a compressed batch.
  entry.kind.textContent = kindGlyph(kindOf(item.isBatch ? item.members[0].filename : item.filename));
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
  // A batch counts files, not just bytes. "31.2 GB of 100 GB" does not answer the question
  // someone waiting on a fifty-part download actually has, which is how many parts are left.
  entry.size.textContent = item.isBatch
    ? `${batchProgressLabel(item.totals)}${sizeKnown ? ` · ${formatBytes(item.completed_bytes)} of ${formatBytes(item.total_bytes)}` : ""}`
    : sizeKnown
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
    // Pieces and resume describe one transfer's segmentation. On a batch they would report the
    // member count as chunk sizes — "50 × 0 B" whenever a part has not declared its size — and
    // claim a resume guarantee for a set rather than a file. The member list below says
    // everything true about a batch's shape, so these two rows stand down for it.
    entry.detailPieces.closest("div").hidden = Boolean(item.isBatch);
    entry.detailResume.closest("div").hidden = Boolean(item.isBatch);
    if (!item.isBatch) {
      entry.detailPieces.textContent = item.num_pieces
        ? `${item.num_pieces} × ${formatBytes(Math.round(item.total_bytes / item.num_pieces))}`
        : "—";
      entry.detailResume.textContent = item.num_pieces > 1 ? "Supported" : "Not reported";
    }
    entry.detailRawRow.hidden = !item.error?.message;
    entry.detailRaw.textContent = item.error?.message ?? "";
    if (item.isBatch) renderMembers(entry, item);
  }
  entry.memberList.hidden = !(isOpen && item.isBatch);

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

/* ── Batches: many transfers, one row ───────────────────────────────────── */

/**
 * Builds the aggregate item that stands in for a whole batch.
 *
 * Deliberately shaped like an ordinary download, so the card renderer, the segmented bar, the
 * sort and the date shelves all keep working unchanged. The batch's identity is the card's id,
 * which is what lets the reconciler treat it as one thing that persists across polls.
 */
function aggregateBatch(batchId, members) {
  const totals = batchTotals(members);
  const remaining = totals.total_bytes - totals.completed_bytes;
  const first = members[0];
  const added = members.map((member) => member.added_at).filter(Boolean);
  const finished = members.map((member) => member.completed_at).filter(Boolean);
  return {
    id: batchId,
    batch_id: batchId,
    isBatch: true,
    members,
    totals,
    filename: first.batch_name || "Batch",
    status: aggregateStatus(members),
    // An unknown total anywhere makes the sum a floor rather than a figure, and the card
    // already knows how to say "size unknown" rather than draw a confident bar.
    total_bytes: totals.sizeKnown ? totals.total_bytes : 0,
    completed_bytes: totals.completed_bytes,
    bytes_per_second: totals.bytes_per_second,
    eta_seconds: totals.bytes_per_second > 0 && remaining > 0
      ? Math.round(remaining / totals.bytes_per_second)
      : null,
    connections: totals.connections,
    num_pieces: totals.count,
    bitfield: "",
    source_url: first.source_url,
    directory: first.directory,
    // Only when every part is waiting does the window explain the whole card. One part started
    // by hand means the batch is moving, whatever the rest are doing.
    scheduled: totals.count > 0 && totals.scheduled === totals.count,
    added_at: added.length ? Math.min(...added) : undefined,
    // A batch finishes when its last part does, so an unfinished one has no completion date.
    completed_at: finished.length === members.length && members.length > 0
      ? Math.max(...finished)
      : undefined
  };
}

/** The queue's rows: loose downloads as themselves, batch members collapsed into one each. */
function groupIntoRows(items) {
  const members = new Map();
  const rows = [];
  for (const item of items) {
    if (!item.batch_id) {
      rows.push(item);
      continue;
    }
    let group = members.get(item.batch_id);
    if (!group) {
      group = [];
      members.set(item.batch_id, group);
      // A placeholder holds the batch's position at its first member's place in the queue.
      rows.push({ batchPlaceholder: item.batch_id });
    }
    group.push(item);
  }
  return rows.map((row) =>
    row.batchPlaceholder ? aggregateBatch(row.batchPlaceholder, members.get(row.batchPlaceholder)) : row
  );
}

/* ── Filtering and rendering ────────────────────────────────────────────── */

function matchesFilter(item, active) {
  if (active === "all") return true;
  // A batch answers for its parts: searching Programs should find the batch of installers, and
  // Failed should surface a batch with a broken part in it even while the rest still runs.
  if (item.isBatch) {
    if (active.startsWith("type:")) {
      return item.members.some((member) => kindOf(member.filename) === active.slice(5));
    }
    if (active === "failed") return item.totals.failed > 0;
  }
  if (active.startsWith("type:")) return kindOf(item.filename) === active.slice(5);
  if (active === "active") return item.status === "active" || item.status === "queued";
  if (active === "failed") return item.status === "failed";
  if (active === "completed") return item.status === "completed";
  if (active === "paused") return item.status === "paused" || item.status === "recoverably_interrupted";
  return true;
}

function matchesSearch(item) {
  if (!searchQuery) return true;
  // Searching a part's name has to find the batch holding it — otherwise the grouping hides
  // the very file the user is looking for.
  const haystack = item.isBatch
    ? `${item.filename} ${item.members.map((member) => `${member.filename} ${member.source_url ?? ""}`).join(" ")}`
    : `${item.filename} ${item.source_url ?? ""}`;
  return haystack.toLowerCase().includes(searchQuery);
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

// Counts are of rows, not of transfers: the sidebar has to agree with what the queue shows, and
// a batch is one card. "50 downloading" beside a single visible card is a sidebar that lies.
function updateCounts(rows) {
  const counts = { all: rows.length };
  for (const name of ["active", "paused", "completed", "failed"]) {
    counts[name] = rows.filter((item) => matchesFilter(item, name)).length;
  }
  // "other" included: every download must be reachable through some type filter, or the
  // sidebar's arithmetic quietly stops adding up to the total.
  for (const kind of [...Object.keys(KINDS), "other"]) {
    counts[`type:${kind}`] = rows.filter((item) => matchesFilter(item, `type:${kind}`)).length;
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
  // Group before filtering, so a batch is judged as the one thing the user sees rather than
  // appearing half-populated whenever a filter excludes some of its parts.
  const rows = groupIntoRows(downloads);
  const visible = orderDownloads(
    rows.filter((item) => matchesFilter(item, filter) && matchesSearch(item) && matchesDate(item))
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
  updateCounts(rows);
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
  if (!destination) elements.chooseFolder.focus();
  else if (intakeMode === "many") elements.batchInput.focus();
  else elements.url.focus();
});
elements.closeAdd.addEventListener("click", () => {
  elements.intake.hidden = true;
  elements.openAdd.focus();
});

/* ── One link or several ────────────────────────────────────────────────── */

let intakeMode = "single";

function setIntakeMode(mode) {
  intakeMode = mode;
  const many = mode === "many";
  elements.manyMode.hidden = !many;
  elements.singleMode.hidden = many;
  // Disabled, not merely hidden. #url is type="url", so a half-typed address left behind in it
  // would fail the form's constraint validation on submit — and because the field is hidden the
  // browser cannot show the user what it is complaining about. The submit event never fires and
  // adding a batch appears to do nothing at all.
  elements.url.disabled = many;
  elements.modeMany.classList.toggle("is-selected", many);
  elements.modeSingle.classList.toggle("is-selected", !many);
  elements.modeMany.setAttribute("aria-pressed", String(many));
  elements.modeSingle.setAttribute("aria-pressed", String(!many));
  showError("");
  if (many) {
    refreshBatchPreview();
    elements.batchInput.focus();
  } else {
    elements.url.focus();
  }
}

elements.modeSingle.addEventListener("click", () => setIntakeMode("single"));
elements.modeMany.addEventListener("click", () => setIntakeMode("many"));

// The most recent preview the backend returned, so submitting does not have to guess what the
// user was shown.
let batchPreview = null;

async function refreshBatchPreview() {
  const input = elements.batchInput.value;
  let unreachable = false;
  try {
    batchPreview = await bridge.invoke("preview_batch", { input });
  } catch {
    batchPreview = null;
    unreachable = true;
  }
  // A backend that cannot answer is not the same as an empty box. Telling someone who just
  // pasted fifty links that there are none hides the real fault and reads as their mistake.
  const summary = unreachable
    ? {
        tone: "error",
        headline: "Could not check those links",
        detail: "The download engine is not responding, so the list cannot be prepared yet."
      }
    : describePreview(batchPreview);
  elements.batchHeadline.textContent = summary.headline;
  elements.batchDetail.textContent = summary.detail;
  elements.batchState.dataset.tone = summary.tone;
  elements.submitBatch.disabled = !batchPreview?.links?.length;

  // Which lines were skipped, not just how many. Three missing parts out of fifty is a
  // question ("which three?") that a count alone cannot answer.
  const rejected = batchPreview?.rejected ?? [];
  elements.batchRejects.hidden = rejected.length === 0;
  if (rejected.length > 0) {
    elements.batchRejectsSummary.textContent =
      `${rejected.length} line${rejected.length === 1 ? "" : "s"} will be skipped`;
    elements.batchRejectList.replaceChildren(...rejected.map((entry) => {
      const row = document.createElement("li");
      const link = document.createElement("code");
      link.textContent = entry.link;
      const reason = document.createElement("span");
      reason.className = "reject-reason";
      reason.textContent = entry.reason;
      row.append(link, reason);
      return row;
    }));
  }
  if (batchPreview?.suggested_name && !elements.batchName.value) {
    elements.batchName.placeholder = batchPreview.suggested_name;
  }
}

// Debounced: a fifty-line paste would otherwise ask the backend to expand and validate the
// whole list on every keystroke.
let previewTimer = null;
elements.batchInput.addEventListener("input", () => {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(refreshBatchPreview, 150);
});

elements.form.addEventListener("submit", async (event) => {
  event.preventDefault();
  showError("");
  if (!destination) {
    showError("Choose a destination folder before adding a download.");
    elements.chooseFolder.focus();
    return;
  }
  const submit = intakeMode === "many" ? elements.submitBatch : elements.submitSingle;
  submit.disabled = true;
  try {
    if (intakeMode === "many") await submitBatch();
    else await submitSingle();
  } catch (error) {
    showError(error.message ?? String(error));
  } finally {
    // The batch button's enabled state belongs to the preview, which a successful submit has
    // just reset for an empty box. Clearing the flag unconditionally would leave "Add batch"
    // live beside an empty textarea, and a second click would submit nothing.
    if (intakeMode === "many") elements.submitBatch.disabled = !batchPreview?.links?.length;
    else elements.submitSingle.disabled = false;
  }
});

async function submitSingle() {
  const snapshot = await bridge.invoke("submit_url", {
    url: elements.url.value,
    destination,
    organizeByType: elements.organize.checked
  });
  mergeDownload(snapshot, `${snapshot.filename} added to the queue.`);
  toast(`Queued ${snapshot.filename}`, { tone: "success" });
  elements.url.value = "";
  elements.url.focus();
}

async function submitBatch() {
  const result = await bridge.invoke("submit_batch", {
    input: elements.batchInput.value,
    destination,
    organizeByType: elements.organize.checked,
    name: elements.batchName.value.trim() || null
  });
  for (const snapshot of result.queued ?? []) {
    const index = downloads.findIndex((entry) => entry.id === snapshot.id);
    if (index < 0) downloads.unshift(snapshot); else downloads[index] = snapshot;
  }
  render();

  const count = result.queued?.length ?? 0;
  elements.queueStatus.textContent = `${result.name}: ${count} files added to the queue.`;
  toast(`Queued ${count} file${count === 1 ? "" : "s"} as ${result.name}`, { tone: "success" });
  // The engine refusing some addresses after policy passed them is rare and worth saying out
  // loud — the batch is real but incomplete, and only the user can decide what to do.
  if (result.failed?.length) {
    toast(
      `${result.failed.length} address${result.failed.length === 1 ? "" : "es"} in ${result.name} could not be queued.`,
      { tone: "error" }
    );
  }

  elements.batchInput.value = "";
  elements.batchName.value = "";
  await refreshBatchPreview();
  elements.batchInput.focus();
}

let dismissSettingsToast = null;
let settingsSaveQueue = Promise.resolve();

function settingsSnapshot() {
  return {
    destination,
    organize_by_type: elements.organize.checked,
    theme,
    speed_limit_bytes: currentSpeedLimit(),
    schedule: { ...schedule, days: [...schedule.days] }
  };
}

function persistSettings() {
  // Capture now, then serialize writes. A slow older RPC must never land after a newer snapshot
  // and overwrite it on disk.
  const settings = settingsSnapshot();
  const save = settingsSaveQueue.then(() => bridge.invoke("save_settings", { settings }));
  settingsSaveQueue = save.catch(() => {});

  return save.then((status) => {
    // The backend applies the schedule as part of saving and hands back what that did, so the
    // panel can say "downloads start at 02:00" from the same round trip rather than guessing.
    if (status) showScheduleStatus(status);
    // One quiet receipt, replaced rather than stacked when settings change in a burst.
    dismissSettingsToast?.();
    dismissSettingsToast = toast("Settings saved", { tone: "success" });
  }).catch(() => {
    // Preferences are a convenience; failing to store them must not interrupt a download —
    // but it must not be silent either, or the user finds out on the next launch.
    dismissSettingsToast?.();
    dismissSettingsToast = toast("Settings could not be saved — they apply for now but may not survive a restart.", { tone: "error" });
  });
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
