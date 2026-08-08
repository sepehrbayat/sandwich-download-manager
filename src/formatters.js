export function formatBytes(value) {
  if (!Number.isFinite(value) || value < 0) return "Unknown";
  if (value < 1024) return `${Math.round(value)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let amount = value / 1024;
  let index = 0;
  while (amount >= 1024 && index < units.length - 1) {
    amount /= 1024;
    index += 1;
  }
  return `${amount >= 10 ? amount.toFixed(0) : amount.toFixed(1)} ${units[index]}`;
}

export function formatEta(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "Unknown";
  if (seconds < 60) return `About ${Math.max(1, Math.ceil(seconds))} sec left`;
  if (seconds < 3600) return `About ${Math.ceil(seconds / 60)} min left`;
  return `About ${Math.ceil(seconds / 3600)} hr left`;
}

export function progressPercent(completed, total) {
  if (!Number.isFinite(completed) || !Number.isFinite(total) || total <= 0) return 0;
  return Math.min(100, Math.max(0, (completed / total) * 100));
}

/**
 * How much of a cell row byte progress fills, strictly left to right.
 *
 * Returns { full, partial }: `full` whole cells, then one frontier cell `partial` (0..1) built.
 * The bar used to draw aria2's raw piece map, which was true — segmented downloads really do
 * finish pieces out of order — but read as random noise. Progress people can follow beats
 * fidelity to internals nobody asked about.
 */
export function orderedCells(capacity, completed, total) {
  if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(completed) || completed <= 0) {
    return { full: 0, partial: 0 };
  }
  const exact = Math.min(1, completed / total) * capacity;
  const full = Math.min(capacity, Math.floor(exact));
  return { full, partial: full >= capacity ? 0 : exact - full };
}

/** Units offered by the total-speed control, expressed as bytes per second. */
export const SPEED_UNITS = { KB: 1024, MB: 1024 * 1024, GB: 1024 * 1024 * 1024 };

/** Converts an amount and unit to aria2's byte ceiling, or zero for unlimited. */
export function speedLimitBytes(amount, unitBytes) {
  const value = Number(amount);
  const unit = Number(unitBytes);
  if (!Number.isFinite(value) || !Number.isFinite(unit) || value <= 0 || unit <= 0) return 0;
  const bytes = value * unit;
  // JSON numbers above this point cannot round-trip exactly into Rust's u64. Treat an absurd
  // or fractional byte count as invalid/unlimited rather than silently changing the ceiling.
  return Number.isSafeInteger(bytes) && bytes > 0 ? bytes : 0;
}

/** Returns the largest tidy unit for a stored byte ceiling. */
export function speedLimitParts(bytes) {
  const value = Number(bytes);
  if (!Number.isSafeInteger(value) || value <= 0) {
    return { amount: 1, unitBytes: SPEED_UNITS.MB };
  }
  const unitBytes =
    [SPEED_UNITS.GB, SPEED_UNITS.MB, SPEED_UNITS.KB].find((unit) => value % unit === 0)
    ?? SPEED_UNITS.KB;
  // Powers-of-two units keep every safe integer byte value exact in binary floating point. That
  // lets an unusual stored ceiling (for example 1500 B/s) survive restore and re-save unchanged.
  return { amount: value / unitBytes, unitBytes };
}

export const statusLabels = {
  queued: "Queued",
  active: "Downloading",
  paused: "Paused",
  recoverably_interrupted: "Interrupted — ready to resume",
  failed: "Download failed",
  cancelled: "Cancelled",
  completed: "Completed"
};

/**
 * What a download's state should be called on its card.
 *
 * The engine reports a scheduled transfer and an abandoned one identically — both are simply
 * "paused" — so a queue held for the night would otherwise read as one somebody stopped and
 * forgot about, and the obvious fix would look like clicking Resume on every card.
 */
export function statusLabel(item) {
  if (item?.scheduled && item.status === "paused") return "Waiting for the download window";
  return statusLabels[item?.status] ?? item?.status ?? "";
}

/* ── The download window ─────────────────────────────────────────────────── */

/** Monday first, matching the order the schedule stores its days in. */
export const WEEKDAYS = [
  { short: "Mon", long: "Monday" },
  { short: "Tue", long: "Tuesday" },
  { short: "Wed", long: "Wednesday" },
  { short: "Thu", long: "Thursday" },
  { short: "Fri", long: "Friday" },
  { short: "Sat", long: "Saturday" },
  { short: "Sun", long: "Sunday" }
];

const MINUTES_PER_DAY = 24 * 60;

/** Minutes since midnight as the "HH:MM" a time input speaks. */
export function minutesToClock(minutes) {
  const value = Number(minutes);
  const safe = Number.isFinite(value) ? Math.min(MINUTES_PER_DAY - 1, Math.max(0, Math.round(value))) : 0;
  return `${String(Math.floor(safe / 60)).padStart(2, "0")}:${String(safe % 60).padStart(2, "0")}`;
}

/**
 * "HH:MM" back to minutes since midnight, or null if it is not a time.
 *
 * Null rather than a fallback number on purpose: a time input can legitimately be empty
 * mid-edit, and silently reading that as midnight would move the user's window while they
 * were still typing it.
 */
export function clockToMinutes(value) {
  const match = /^(\d{1,2}):([0-5]\d)$/.exec(String(value ?? "").trim());
  if (!match) return null;
  const hours = Number(match[1]);
  if (hours > 23) return null;
  return hours * 60 + Number(match[2]);
}

/**
 * Which calendar day an upcoming instant lands on, said the way a person would.
 *
 * Compared by local midnight rather than by elapsed hours: at 23:00, something happening in
 * three hours is "tomorrow", not "today", and the difference is exactly what makes a schedule
 * message trustworthy.
 */
export function relativeDay(epochSeconds, nowMs) {
  const then = new Date(epochSeconds * 1000);
  const now = new Date(nowMs);
  const startOf = (date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const days = Math.round((startOf(then) - startOf(now)) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "tomorrow";
  // The surrounding interface is English. Pin the language while keeping local calendar-day
  // arithmetic, otherwise a Persian or German Windows locale injects one foreign word into an
  // otherwise English sentence and makes the same build behave differently across machines.
  if (days < 7) return then.toLocaleDateString("en-US", { weekday: "long" });
  return then.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function formatClockTime(epochSeconds) {
  return new Date(epochSeconds * 1000)
    .toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

/**
 * A window edge as a phrase that reads correctly after a verb: "downloads start **at 02:00**",
 * "downloads pause **tomorrow at 02:00**".
 */
export function formatWindowMoment(epochSeconds, nowMs) {
  if (!epochSeconds) return "";
  const day = relativeDay(epochSeconds, nowMs);
  const time = formatClockTime(epochSeconds);
  return day === "today" ? `at ${time}` : `${day} at ${time}`;
}

/**
 * The schedule explained in one headline and one detail line, shared by the settings panel and
 * the title-bar indicator.
 *
 * A queue that has stopped itself must always say so somewhere visible. A download manager
 * sitting idle with no explanation is indistinguishable from a broken one, and the first thing
 * a user does about it is uninstall.
 */
export function scheduleSummary(status, nowMs) {
  if (!status?.enabled) {
    return { state: "off", headline: "Downloads run at any time", detail: "", pill: "" };
  }
  const moment = formatWindowMoment(status.next_change_at, nowMs);
  const waiting = Number(status.waiting) || 0;
  const queued = waiting > 0 ? ` ${waiting} download${waiting === 1 ? "" : "s"} waiting.` : "";

  if (status.open) {
    return {
      state: "open",
      headline: "Download window open",
      detail: moment ? `Downloads pause ${moment}.` : "Downloads run all day on the days you ticked.",
      pill: ""
    };
  }
  if (!moment) {
    return {
      state: "closed",
      headline: "Nothing will download",
      detail: `No days are ticked, so the window never opens.${queued}`,
      pill: "No days ticked"
    };
  }
  return {
    state: "closed",
    headline: "Waiting for the download window",
    detail: `Downloads start ${moment}.${queued}`,
    pill: `Downloads start ${moment}`
  };
}

/**
 * Which history shelf a Unix timestamp belongs on, relative to a "now" also in Unix seconds.
 * Boundaries are local midnights — "Today" means the calendar day the user is living in,
 * not the last rolling 24 hours.
 */
export function dateGroup(epochSeconds, nowEpochSeconds) {
  if (!epochSeconds) return "Older";
  const now = new Date(nowEpochSeconds * 1000);
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() / 1000;
  if (epochSeconds >= midnight) return "Today";
  if (epochSeconds >= midnight - 86400) return "Yesterday";
  if (epochSeconds >= midnight - 6 * 86400) return "This week";
  if (epochSeconds >= midnight - 29 * 86400) return "This month";
  return "Older";
}

/** The domain a download came from, for showing provenance without the whole URL. */
export function sourceHost(url) {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

// What the HTTP status actually means for the person watching the download, plus the one
// thing they can do about it. Keyed by status because the server's own reason phrase is
// written for developers.
const HTTP_EXPLANATIONS = {
  401: ["Sign-in required (401)", "The server wants credentials. Downloading from the browser extension passes your session along."],
  403: ["Access denied (403)", "The server refused this link. It may need a sign-in, or the link may have expired — try downloading from the browser extension, which sends your cookies."],
  404: ["File not found (404)", "The file is not on the server any more. The link is broken or has expired — check the page it came from for a newer one."],
  410: ["File removed (410)", "The server says this file has been taken down permanently."],
  429: ["Too many requests (429)", "The server is rate-limiting. Wait a little and retry."],
  500: ["Server error (500)", "The problem is on the server's side. Retrying later usually works."],
  502: ["Server error (502)", "The problem is on the server's side. Retrying later usually works."],
  503: ["Server unavailable (503)", "The server is overloaded or down for maintenance. Retry later."]
};

// aria2's exit codes, for failures that never got as far as an HTTP status.
const ENGINE_EXPLANATIONS = {
  3: ["File not found", "The server says there is nothing at this address. The link is broken or has expired."],
  6: ["Network problem", "The connection to the server was lost. Check your network and retry."],
  9: ["Not enough disk space", "Free up space in the destination folder, then retry."],
  16: ["Could not create the file", "The destination folder may be read-only or missing. Choose a different folder and retry."],
  19: ["Server address not found", "The site's name could not be looked up. Check the link and your connection."],
  24: ["Sign-in required", "The server wants credentials. Downloading from the browser extension passes your session along."]
};

/* ── Batches ─────────────────────────────────────────────────────────────── */

/**
 * The one state a batch is in, worked out from the states of its parts.
 *
 * A batch that is still moving reports as downloading even with a failure among its parts: the
 * transfer genuinely is in progress, and the failures are counted separately so the card can
 * say "3 failed" without pretending the whole thing has stopped. Only once nothing is running
 * does a failure become the batch's own state, because then it is the thing needing a decision.
 */
export function aggregateStatus(members) {
  if (!members.length) return "cancelled";
  const has = (status) => members.some((member) => member.status === status);
  if (members.every((member) => member.status === "completed")) return "completed";
  if (has("active")) return "active";
  if (has("queued")) return "queued";
  if (has("paused") || has("recoverably_interrupted")) return "paused";
  if (has("failed")) return "failed";
  return "cancelled";
}

/**
 * Adds a batch's parts up into the numbers one card has to show.
 *
 * Speed and connections count only the parts actually running: a batch of fifty where two are
 * transferring should report those two, not fifty stale readings.
 */
export function batchTotals(members) {
  const totals = {
    count: members.length,
    done: 0,
    failed: 0,
    scheduled: 0,
    total_bytes: 0,
    completed_bytes: 0,
    bytes_per_second: 0,
    connections: 0,
    // False once any part has not reported its size: the total is then a floor, not a figure,
    // and a card that rounds that to a confident number is lying about how much is left.
    sizeKnown: true
  };
  for (const member of members) {
    if (member.status === "completed") totals.done += 1;
    if (member.status === "failed") totals.failed += 1;
    if (member.scheduled) totals.scheduled += 1;
    totals.completed_bytes += member.completed_bytes || 0;
    if (member.total_bytes > 0) totals.total_bytes += member.total_bytes;
    else totals.sizeKnown = false;
    if (member.status === "active") {
      totals.bytes_per_second += member.bytes_per_second || 0;
      totals.connections += member.connections || 0;
    }
  }
  return totals;
}

/** What a batch card says where a single download names its size: progress in files. */
export function batchProgressLabel(totals) {
  const parts = [`${totals.done} of ${totals.count} files`];
  if (totals.failed > 0) {
    parts.push(`${totals.failed} failed`);
  }
  return parts.join(" · ");
}

/**
 * The one line under the paste box, before anything is queued.
 *
 * Says what will happen rather than what was typed. Silently dropping repeats or bad lines is
 * how someone ends up with 47 of the 50 parts of a game and no idea which three are missing.
 */
export function describePreview(preview) {
  const accepted = preview?.links?.length ?? 0;
  const rejected = preview?.rejected?.length ?? 0;
  const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;

  if (accepted === 0) {
    return {
      tone: "error",
      headline: rejected > 0 ? "Nothing here can be downloaded" : "No links yet",
      detail: rejected > 0
        ? `${plural(rejected, "address")} could not be used.`
        : "Paste one address per line, or use a range like part[01-50].bin."
    };
  }

  const notes = [];
  if (preview.duplicates > 0) notes.push(`${plural(preview.duplicates, "repeat")} removed`);
  if (rejected > 0) notes.push(`${plural(rejected, "line")} skipped`);
  if (preview.truncated) notes.push(`only the first ${accepted} will be added`);

  return {
    tone: rejected > 0 || preview.truncated ? "warn" : "ok",
    headline: `${plural(accepted, "file")} ready`,
    detail: notes.join(" · ")
  };
}

/**
 * Turns an engine failure into words a person can act on.
 *
 * Raw engine text like "The response status is not successful. status=403" leaks a transport
 * detail and answers none of the questions a user actually has: what happened, why, and what
 * to do next. Returns { headline, hint } — the raw message stays available under details.
 */
export function describeError(error) {
  const message = error?.message ?? "";
  const httpStatus = Number(/status=(\d{3})/.exec(message)?.[1]);
  if (HTTP_EXPLANATIONS[httpStatus]) {
    const [headline, hint] = HTTP_EXPLANATIONS[httpStatus];
    return { headline, hint };
  }
  if (httpStatus >= 400) {
    return {
      headline: `The server refused the download (${httpStatus})`,
      hint: "Retry, or check the link in your browser."
    };
  }
  if (ENGINE_EXPLANATIONS[error?.code]) {
    const [headline, hint] = ENGINE_EXPLANATIONS[error.code];
    return { headline, hint };
  }
  if (/not found/i.test(message)) {
    return {
      headline: "File not found",
      hint: "The server says there is nothing at this address. The link is broken or has expired."
    };
  }
  return {
    headline: "The download could not finish",
    hint: message || "Retry, or check the link in your browser."
  };
}
