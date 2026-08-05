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

export const statusLabels = {
  queued: "Queued",
  active: "Downloading",
  paused: "Paused",
  recoverably_interrupted: "Interrupted — ready to resume",
  failed: "Download failed",
  cancelled: "Cancelled",
  completed: "Completed"
};

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
