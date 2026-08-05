import test from "node:test";
import assert from "node:assert/strict";
import { describeError, formatBytes, formatEta, progressPercent, sourceHost, statusLabels } from "../../src/formatters.js";

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
