import test from "node:test";
import assert from "node:assert/strict";
import {
  aggregateStatus, batchProgressLabel, batchTotals, describePreview
} from "../../src/formatters.js";

const part = (overrides) => ({
  status: "active",
  completed_bytes: 0,
  total_bytes: 1000,
  bytes_per_second: 0,
  connections: 0,
  scheduled: false,
  ...overrides
});

/* ── One state for the whole set ─────────────────────────────────────────── */

test("a batch still transferring reports as downloading", () => {
  const members = [part({ status: "active" }), part({ status: "queued" })];
  assert.equal(aggregateStatus(members), "active");
});

test("a failure among running parts does not stop the batch reading as active", () => {
  // The transfer genuinely is in progress. Calling the whole batch failed because one of fifty
  // parts died would send the user looking for a problem that is still resolving itself.
  const members = [part({ status: "active" }), part({ status: "failed" })];
  assert.equal(aggregateStatus(members), "active");
});

test("once nothing is running, a failure becomes the batch's own state", () => {
  const members = [part({ status: "completed" }), part({ status: "failed" })];
  assert.equal(aggregateStatus(members), "failed", "this one needs a decision");
});

test("a batch is only complete when every part is", () => {
  assert.equal(
    aggregateStatus([part({ status: "completed" }), part({ status: "completed" })]),
    "completed"
  );
  assert.equal(
    aggregateStatus([part({ status: "completed" }), part({ status: "paused" })]),
    "paused"
  );
});

test("an empty batch is not pretending to be anything", () => {
  assert.equal(aggregateStatus([]), "cancelled");
});

/* ── Adding the parts up ─────────────────────────────────────────────────── */

test("bytes add up across every part, speed only across the running ones", () => {
  const totals = batchTotals([
    part({ status: "completed", completed_bytes: 1000, total_bytes: 1000, bytes_per_second: 0 }),
    part({ status: "active", completed_bytes: 400, total_bytes: 1000, bytes_per_second: 250, connections: 4 }),
    // A stale reading on a paused part would inflate the headline speed of the whole batch.
    part({ status: "paused", completed_bytes: 100, total_bytes: 1000, bytes_per_second: 999, connections: 8 })
  ]);
  assert.equal(totals.completed_bytes, 1500);
  assert.equal(totals.total_bytes, 3000);
  assert.equal(totals.bytes_per_second, 250);
  assert.equal(totals.connections, 4);
  assert.equal(totals.count, 3);
  assert.equal(totals.done, 1);
});

test("one part of unknown size makes the batch total a floor, not a figure", () => {
  const totals = batchTotals([
    part({ total_bytes: 1000 }),
    part({ total_bytes: 0 })
  ]);
  assert.equal(totals.sizeKnown, false);
  assert.equal(totals.total_bytes, 1000, "what is known still counts");
});

test("failed and scheduled parts are counted, not just totalled", () => {
  const totals = batchTotals([
    part({ status: "failed" }),
    part({ status: "failed" }),
    part({ status: "paused", scheduled: true })
  ]);
  assert.equal(totals.failed, 2);
  assert.equal(totals.scheduled, 1);
});

test("the card counts files, because bytes alone do not say how far in you are", () => {
  assert.equal(
    batchProgressLabel({ done: 12, count: 50, failed: 0 }),
    "12 of 50 files"
  );
  assert.equal(
    batchProgressLabel({ done: 47, count: 50, failed: 3 }),
    "47 of 50 files · 3 failed"
  );
});

/* ── The preview, before anything is queued ──────────────────────────────── */

test("a clean paste says how many files are ready", () => {
  const summary = describePreview({ links: ["a", "b", "c"], rejected: [], duplicates: 0 });
  assert.equal(summary.tone, "ok");
  assert.equal(summary.headline, "3 files ready");
  assert.equal(summary.detail, "");
});

test("one file is not '1 files'", () => {
  assert.equal(describePreview({ links: ["a"], rejected: [], duplicates: 0 }).headline, "1 file ready");
});

test("repeats and skips are reported rather than silently applied", () => {
  // Quietly dropping three lines is how someone ends up with 47 of 50 parts and no idea which
  // three are missing.
  const summary = describePreview({
    links: ["a", "b"],
    rejected: [{ link: "x", reason: "nope" }],
    duplicates: 2
  });
  assert.equal(summary.tone, "warn");
  assert.match(summary.detail, /2 repeats removed/);
  assert.match(summary.detail, /1 line skipped/);
});

test("a truncated list says so", () => {
  const summary = describePreview({ links: ["a"], rejected: [], duplicates: 0, truncated: true });
  assert.equal(summary.tone, "warn");
  assert.match(summary.detail, /only the first 1/);
});

test("an empty box invites a paste; an unusable one explains itself", () => {
  const empty = describePreview({ links: [], rejected: [], duplicates: 0 });
  assert.equal(empty.tone, "error");
  assert.match(empty.detail, /part\[01-50\]/, "the range syntax is where it is needed");

  const allBad = describePreview({ links: [], rejected: [{ link: "x", reason: "nope" }], duplicates: 0 });
  assert.match(allBad.headline, /Nothing here/);
});

test("a missing preview does not throw", () => {
  assert.equal(describePreview(undefined).tone, "error");
  assert.equal(describePreview({}).tone, "error");
});
