import test from "node:test";
import assert from "node:assert/strict";
import { describeError, formatBytes, formatEta, progressPercent, sourceHost, SPEED_UNITS, speedLimitBytes, speedLimitParts, statusLabels } from "../../src/formatters.js";

test("a speed limit converts to bytes per second, and nonsense means no limit", () => {
  assert.equal(speedLimitBytes(2, SPEED_UNITS.MB), 2097152);
  assert.equal(speedLimitBytes(500, SPEED_UNITS.KB), 512000);
  assert.equal(speedLimitBytes(3, SPEED_UNITS.GB), 3221225472);

  // Anything unusable has to read as "unlimited", never as a near-zero throttle: a 1 B/s
  // ceiling is indistinguishable from a download that has broken.
  assert.equal(speedLimitBytes(0, SPEED_UNITS.MB), 0);
  assert.equal(speedLimitBytes(-5, SPEED_UNITS.MB), 0);
  assert.equal(speedLimitBytes("", SPEED_UNITS.MB), 0);
  assert.equal(speedLimitBytes(Number.NaN, SPEED_UNITS.MB), 0);
});

test("a stored limit comes back as the number the user typed", () => {
  // 2 MB/s must not reappear as 2048 KB/s.
  assert.deepEqual(speedLimitParts(2097152), { amount: 2, unitBytes: SPEED_UNITS.MB });
  // Not a whole number of megabytes, so kilobytes is the honest unit.
  assert.deepEqual(speedLimitParts(512000), { amount: 500, unitBytes: SPEED_UNITS.KB });
  // A whole number of gigabytes is also a whole number of megabytes and kilobytes; the
  // largest unit has to win, or 1 GB/s would come back as 1024 MB/s.
  assert.deepEqual(speedLimitParts(1073741824), { amount: 1, unitBytes: SPEED_UNITS.GB });
  // One megabyte short of a gigabyte still belongs in megabytes.
  assert.deepEqual(speedLimitParts(1072693248), { amount: 1023, unitBytes: SPEED_UNITS.MB });
  // Round trip through both directions leaves the value untouched.
  for (const bytes of [1024, 512000, 1048576, 2097152, 15728640, 1073741824]) {
    const { amount, unitBytes } = speedLimitParts(bytes);
    assert.equal(speedLimitBytes(amount, unitBytes), bytes);
  }
  // An absent limit still yields a sane starting point for the controls.
  assert.deepEqual(speedLimitParts(0), { amount: 1, unitBytes: SPEED_UNITS.MB });
});

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

test("extracts the source domain and swallows unparseable URLs", () => {
  assert.equal(sourceHost("https://cdn.example.com/files/a.zip?sig=1"), "cdn.example.com");
  assert.equal(sourceHost("not a url"), "");
  assert.equal(sourceHost(undefined), "");
});

test("explains an HTTP failure instead of leaking the transport detail", () => {
  const denied = describeError({ code: 22, message: "The response status is not successful. status=403" });
  assert.match(denied.headline, /Access denied \(403\)/);
  assert.match(denied.hint, /sign-in|expired/i);
  assert.doesNotMatch(denied.headline, /response status is not successful/);

  const missing = describeError({ code: 22, message: "The response status is not successful. status=404" });
  assert.match(missing.headline, /not found \(404\)/i);
});

test("explains engine-level failures from aria2's exit code", () => {
  assert.match(describeError({ code: 9, message: "There is not enough disk space available." }).headline, /disk space/i);
  assert.match(describeError({ code: 6, message: "Network problem has occurred." }).headline, /network/i);
  assert.match(describeError({ code: 3, message: "Resource not found" }).headline, /not found/i);
});

test("an unrecognised failure still gets a calm headline and keeps the detail as the hint", () => {
  const odd = describeError({ message: "something exotic went wrong" });
  assert.equal(odd.headline, "The download could not finish");
  assert.match(odd.hint, /something exotic/);
  const empty = describeError(undefined);
  assert.ok(empty.headline.length > 0);
  assert.ok(empty.hint.length > 0);
});
