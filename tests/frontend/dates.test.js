import test from "node:test";
import assert from "node:assert/strict";
import { dateGroup } from "../../src/formatters.js";

// Fixed reference: 2026-08-05 15:00 local time.
const NOW = new Date(2026, 7, 5, 15, 0, 0).getTime() / 1000;
const MIDNIGHT = new Date(2026, 7, 5, 0, 0, 0).getTime() / 1000;

test("this morning is Today", () => {
  assert.equal(dateGroup(MIDNIGHT + 60, NOW), "Today");
});

test("just before midnight is Yesterday", () => {
  assert.equal(dateGroup(MIDNIGHT - 60, NOW), "Yesterday");
});

test("six days ago is This week, eight days ago is This month", () => {
  assert.equal(dateGroup(MIDNIGHT - 6 * 86400 + 60, NOW), "This week");
  assert.equal(dateGroup(MIDNIGHT - 8 * 86400, NOW), "This month");
});

test("beyond a month is Older, and no date at all is Older", () => {
  assert.equal(dateGroup(MIDNIGHT - 45 * 86400, NOW), "Older");
  assert.equal(dateGroup(undefined, NOW), "Older");
  assert.equal(dateGroup(0, NOW), "Older");
});
