import test from "node:test";
import assert from "node:assert/strict";
import {
  clockToMinutes, formatWindowMoment, minutesToClock, relativeDay, scheduleSummary, statusLabel
} from "../../src/formatters.js";

// Fixed reference: Wednesday 2026-08-05, 13:00 local time.
const NOW = new Date(2026, 7, 5, 13, 0, 0).getTime();
const at = (day, hour, minute = 0) => new Date(2026, 7, day, hour, minute, 0).getTime() / 1000;

/* ── Clock conversion ───────────────────────────────────────────────────── */

test("minutes round trip through the clock format a time input speaks", () => {
  assert.equal(minutesToClock(0), "00:00");
  assert.equal(minutesToClock(2 * 60), "02:00");
  assert.equal(minutesToClock(22 * 60 + 30), "22:30");
  assert.equal(minutesToClock(24 * 60 - 1), "23:59");
  for (const minutes of [0, 1, 125, 725, 1439]) {
    assert.equal(clockToMinutes(minutesToClock(minutes)), minutes);
  }
});

test("out-of-range minutes are clamped rather than wrapped", () => {
  // Wrapping would turn a nonsense stored value into a plausible-looking different window,
  // which is worse than pinning it to an edge the user can see and correct.
  assert.equal(minutesToClock(-5), "00:00");
  assert.equal(minutesToClock(99_999), "23:59");
  assert.equal(minutesToClock(undefined), "00:00");
});

test("an unreadable time is null, not midnight", () => {
  // A time input is legitimately empty between keystrokes. Reading that as 00:00 would move
  // the user's window while they were still typing it.
  assert.equal(clockToMinutes(""), null);
  assert.equal(clockToMinutes("2"), null);
  assert.equal(clockToMinutes("24:00"), null);
  assert.equal(clockToMinutes("07:60"), null);
  assert.equal(clockToMinutes(null), null);
  assert.equal(clockToMinutes("07:30"), 7 * 60 + 30);
  assert.equal(clockToMinutes("7:30"), 7 * 60 + 30);
});

/* ── Naming the moment ──────────────────────────────────────────────────── */

test("an upcoming time is named by calendar day, not by hours elapsed", () => {
  assert.equal(relativeDay(at(5, 23), NOW), "today");
  assert.equal(relativeDay(at(6, 2), NOW), "tomorrow");
  // Still under 24 hours away, but a different day — and "today" would be a lie at 02:00.
  assert.equal(relativeDay(at(7, 2), NOW), "Friday");
  assert.equal(relativeDay(at(20, 2), NOW), relativeDay(at(20, 2), NOW));
  assert.notEqual(relativeDay(at(20, 2), NOW), "tomorrow");
});

test("late at night, three hours ahead is tomorrow", () => {
  const lateNight = new Date(2026, 7, 5, 23, 0, 0).getTime();
  assert.equal(relativeDay(at(6, 2), lateNight), "tomorrow");
});

test("a window edge reads correctly after a verb", () => {
  // "Downloads pause at 19:00" and "Downloads start tomorrow at 02:00" both have to come out
  // of the same helper without the caller stitching prepositions together.
  assert.match(formatWindowMoment(at(5, 19), NOW), /^at /);
  assert.match(formatWindowMoment(at(6, 2), NOW), /^tomorrow at /);
  assert.equal(formatWindowMoment(null, NOW), "");
  assert.equal(formatWindowMoment(0, NOW), "");
});

/* ── The summary shown to the user ──────────────────────────────────────── */

test("a disabled schedule says downloads run at any time and shows no indicator", () => {
  const summary = scheduleSummary({ enabled: false, open: true }, NOW);
  assert.equal(summary.state, "off");
  assert.equal(summary.pill, "", "nothing is being restricted, so nothing to announce");
});

test("an open window names when it closes and stays out of the title bar", () => {
  const summary = scheduleSummary(
    { enabled: true, open: true, next_change_at: at(5, 19), waiting: 0 },
    NOW
  );
  assert.equal(summary.state, "open");
  assert.match(summary.detail, /pause at /i);
  assert.equal(summary.pill, "", "a running queue needs no explanation");
});

test("a closed window says when downloads start, in the panel and the title bar", () => {
  const summary = scheduleSummary(
    { enabled: true, open: false, next_change_at: at(6, 2), waiting: 3 },
    NOW
  );
  assert.equal(summary.state, "closed");
  assert.match(summary.detail, /start tomorrow at /i);
  assert.match(summary.detail, /3 downloads waiting/);
  assert.match(summary.pill, /tomorrow at /i);
});

test("one waiting download is not '1 downloads'", () => {
  const summary = scheduleSummary(
    { enabled: true, open: false, next_change_at: at(6, 2), waiting: 1 },
    NOW
  );
  assert.match(summary.detail, /1 download waiting/);
});

test("a schedule that never opens says so instead of promising a time", () => {
  // No days ticked: there is no next change to name, and silence here would leave a
  // permanently idle queue with no explanation anywhere in the interface.
  const summary = scheduleSummary(
    { enabled: true, open: false, next_change_at: undefined, waiting: 2 },
    NOW
  );
  assert.equal(summary.state, "closed");
  assert.match(summary.detail, /No days are ticked/i);
  assert.match(summary.detail, /2 downloads waiting/);
  assert.ok(summary.pill.length > 0, "the title bar still has to admit nothing will run");
});

/* ── The card ───────────────────────────────────────────────────────────── */

test("a scheduled pause is labelled as waiting, not as paused", () => {
  assert.equal(
    statusLabel({ status: "paused", scheduled: true }),
    "Waiting for the download window"
  );
  assert.equal(statusLabel({ status: "paused", scheduled: false }), "Paused");
  assert.equal(statusLabel({ status: "active" }), "Downloading");
  // The flag only means anything on a paused transfer: a completed download that happens to
  // still carry a stale hold must not claim to be waiting for anything.
  assert.equal(statusLabel({ status: "completed", scheduled: true }), "Completed");
});
