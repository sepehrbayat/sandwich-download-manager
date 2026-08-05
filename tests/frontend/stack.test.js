import test from "node:test";
import assert from "node:assert/strict";
import { orderedCells } from "../../src/formatters.js";

test("fills strictly left to right from byte progress", () => {
  assert.deepEqual(orderedCells(10, 45, 100), { full: 4, partial: 0.5 });
  assert.deepEqual(orderedCells(10, 100, 100), { full: 10, partial: 0 });
  assert.deepEqual(orderedCells(10, 0, 100), { full: 0, partial: 0 });
});

test("an unknown total fills nothing rather than guessing", () => {
  assert.deepEqual(orderedCells(10, 5000, 0), { full: 0, partial: 0 });
});

test("progress never overflows the bar", () => {
  // aria2 can briefly report completed > total while it reconciles a resumed file.
  assert.deepEqual(orderedCells(10, 120, 100), { full: 10, partial: 0 });
});

test("the frontier partial is the exact sub-cell fraction", () => {
  const { full, partial } = orderedCells(8, 1, 3);
  assert.equal(full, 2);
  assert.ok(Math.abs(partial - 2 / 3) < 1e-9);
});
