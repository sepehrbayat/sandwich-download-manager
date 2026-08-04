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
