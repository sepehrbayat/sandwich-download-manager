import test from "node:test";
import assert from "node:assert/strict";
import { toastQueueReducer } from "../../src/feedback.js";

test("a fourth toast evicts the oldest", () => {
  let queue = [];
  for (const id of [1, 2, 3, 4]) queue = toastQueueReducer(queue, { add: { id } });
  assert.deepEqual(queue.map((t) => t.id), [2, 3, 4]);
});

test("errors are sticky by default, info is not", () => {
  let queue = toastQueueReducer([], { add: { id: 1, tone: "error" } });
  assert.equal(queue[0].sticky, true);
  queue = toastQueueReducer([], { add: { id: 2, tone: "info" } });
  assert.equal(queue[0].sticky, false);
});

test("remove takes out exactly the named toast", () => {
  let queue = [];
  for (const id of [1, 2, 3]) queue = toastQueueReducer(queue, { add: { id } });
  queue = toastQueueReducer(queue, { remove: 2 });
  assert.deepEqual(queue.map((t) => t.id), [1, 3]);
});
