import test from "node:test";
import assert from "node:assert/strict";
import { formatBytes, formatEta, progressPercent, statusLabels } from "../../src/formatters.js";

test("formats transfer metrics without misleading invalid values", () => {
  assert.equal(formatBytes(1536), "1.5 KB");
  assert.equal(formatBytes(Number.NaN), "Unknown");
  assert.equal(formatEta(undefined), "Unknown");
  assert.equal(formatEta(61), "About 2 min left");
  assert.equal(progressPercent(150, 100), 100);
  assert.equal(progressPercent(10, 0), 0);
});

test("provides understandable labels for every canonical state", () => {
  assert.deepEqual(Object.keys(statusLabels).sort(), ["active", "cancelled", "completed", "failed", "paused", "queued", "recoverably_interrupted"].sort());
});
