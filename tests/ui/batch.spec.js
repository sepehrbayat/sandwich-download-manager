import { expect, test } from "@playwright/test";

// A game shipped as fifty parts is the case this feature exists for. Every check here is the
// same question in a different place: does fifty transfers behave as one thing the user can
// see, act on, and get an honest account of?

const FIXTURE = "/index.html?fixture";

async function seed(page, downloads) {
  await page.evaluate((items) => {
    window.__sandwichBatchMembers = items.filter((item) => item.batch_id);
    const original = window.__SANDWICH_TEST_BRIDGE__.invoke;
    window.__SANDWICH_TEST_BRIDGE__.invoke = async (command, payload) =>
      command === "list_downloads" ? items : original(command, payload);
  }, downloads);
  await page.evaluate(() => window.__sandwichRefresh());
}

/** Fifty parts of one batch, with the states a real half-finished download would have. */
function parts({ count = 5, batch = "b1", name = "Cyberpunk", done = 0, failed = 0 } = {}) {
  return Array.from({ length: count }, (_, index) => {
    let status = "queued";
    if (index < done) status = "completed";
    else if (index < done + failed) status = "failed";
    else if (index === done + failed) status = "active";
    return {
      id: `${batch}-${index}`,
      filename: `${name}.part${String(index + 1).padStart(2, "0")}.rar`,
      status,
      completed_bytes: status === "completed" ? 2_000_000 : status === "active" ? 500_000 : 0,
      total_bytes: 2_000_000,
      bytes_per_second: status === "active" ? 250_000 : 0,
      connections: status === "active" ? 4 : 0,
      num_pieces: 8,
      bitfield: "0",
      source_url: `https://cdn.example.com/${name}.part${index + 1}.rar`,
      directory: "C:\\Downloads",
      batch_id: batch,
      batch_name: name
    };
  });
}

test.beforeEach(async ({ page }) => {
  await page.goto(FIXTURE);
  await page.waitForSelector(".download-card");
});

/* ── Getting fifty links in ──────────────────────────────────────────────── */

test("the add panel offers several links without becoming a panel of its own", async ({ page }) => {
  await page.locator("#open-add").click();
  await expect(page.locator("#batch-input")).toBeHidden();

  await page.locator("#mode-many").click();
  await expect(page.locator("#batch-input")).toBeVisible();
  await expect(page.locator("#url")).toBeHidden();
});

test("a range stands for every file it covers, and says so before anything is queued", async ({ page }) => {
  await page.locator("#open-add").click();
  await page.locator("#mode-many").click();
  await page.locator("#batch-input").fill("https://cdn.example.com/Cyberpunk.part[01-50].rar");

  await expect(page.locator("#batch-headline")).toHaveText("50 files ready");
  await expect(page.locator("#batch-rejects")).toBeHidden();
  // The suggested name is the thing itself, not the scaffolding around the sequence.
  await expect(page.locator("#batch-name")).toHaveAttribute("placeholder", "Cyberpunk");
});

test("repeats and bad lines are reported, and the bad ones are named", async ({ page }) => {
  // Silently dropping lines is how somebody ends up with 47 of 50 parts and no idea which
  // three are missing.
  await page.locator("#open-add").click();
  await page.locator("#mode-many").click();
  await page.locator("#batch-input").fill(
    [
      "https://cdn.example.com/a.rar",
      "https://cdn.example.com/a.rar",
      "ftp://cdn.example.com/b.rar",
      "https://cdn.example.com/c.rar"
    ].join("\n")
  );

  await expect(page.locator("#batch-headline")).toHaveText("2 files ready");
  await expect(page.locator("#batch-detail")).toContainText("1 repeat removed");
  await expect(page.locator("#batch-detail")).toContainText("1 line skipped");

  const rejects = page.locator("#batch-rejects");
  await expect(rejects).toBeVisible();
  await rejects.locator("summary").click();
  await expect(rejects).toContainText("ftp://cdn.example.com/b.rar");
});

test("a backwards range is refused rather than quietly sorted", async ({ page }) => {
  await page.locator("#open-add").click();
  await page.locator("#mode-many").click();
  await page.locator("#batch-input").fill("https://cdn.example.com/game.part[50-01].rar");

  await expect(page.locator("#batch-headline")).toContainText(/Nothing here/i);
  await expect(page.locator("#submit-batch")).toBeDisabled();
});

test("an empty box explains the range syntax instead of just refusing", async ({ page }) => {
  await page.locator("#open-add").click();
  await page.locator("#mode-many").click();
  await expect(page.locator("#batch-detail")).toContainText("part[01-50]");
  await expect(page.locator("#submit-batch")).toBeDisabled();
});

/* ── Fifty transfers, one card ───────────────────────────────────────────── */

test("a batch is one card, not fifty", async ({ page }) => {
  await seed(page, parts({ count: 50, done: 12 }));
  await expect(page.locator(".download-card")).toHaveCount(1);
  await expect(page.locator(".download-card .filename")).toHaveText("Cyberpunk");
});

test("the card counts files, because bytes alone do not say how far in you are", async ({ page }) => {
  await seed(page, parts({ count: 50, done: 12 }));
  await expect(page.locator(".download-card .size")).toContainText("12 of 50 files");
});

test("a failure among running parts is counted without stopping the batch reading as active", async ({ page }) => {
  await seed(page, parts({ count: 10, done: 4, failed: 3 }));
  const card = page.locator(".download-card").first();
  await expect(card.locator(".download-state")).toHaveText("Downloading");
  await expect(card.locator(".size")).toContainText("3 failed");
});

test("the sidebar counts cards, not transfers", async ({ page }) => {
  // A sidebar reading "50 downloading" beside a single visible card is a sidebar that lies.
  await seed(page, parts({ count: 50 }));
  await expect(page.locator('[data-count="all"]')).toHaveText("1");
});

test("expanding a batch lists its parts, and only broken ones get a control", async ({ page }) => {
  await seed(page, parts({ count: 6, done: 2, failed: 1 }));
  await page.locator(".download-card .disclosure").first().click();

  const members = page.locator(".member-list .member");
  await expect(members).toHaveCount(6);
  await expect(members.first()).toContainText("Cyberpunk.part01.rar");
  // One offered retry, for the one failed part — not six. The control exists on every row so
  // that focus survives a poll, but it is only shown where it means something.
  await expect(page.locator(".member-retry:not([hidden])")).toHaveCount(1);
});

test("batch actions act on the whole set", async ({ page }) => {
  await seed(page, parts({ count: 5, done: 1 }));
  const card = page.locator(".download-card").first();
  await expect(card.getByRole("button", { name: /Pause all/ })).toBeVisible();
  await expect(card.getByRole("button", { name: /Cancel all/ })).toBeVisible();
  // The single-download wording must not leak onto a group.
  await expect(card.getByRole("button", { name: /^Pause Cyberpunk$/ })).toHaveCount(0);
});

test("cancelling a batch says how many files it is about to throw away", async ({ page }) => {
  await seed(page, parts({ count: 50, done: 12 }));
  await page.locator(".download-card").first().getByRole("button", { name: /Cancel all/ }).click();

  const dialog = page.locator("#app-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("50 files");
  await expect(dialog).toContainText("12 already finished");
});

test("searching for one part finds the batch that holds it", async ({ page }) => {
  // Grouping must not hide the very file someone is looking for.
  await seed(page, parts({ count: 20 }));
  await page.locator("#queue-search").fill("part07");
  await expect(page.locator(".download-card")).toHaveCount(1);
  await expect(page.locator(".download-card .filename")).toHaveText("Cyberpunk");
});

test("a loose download beside a batch stays its own card", async ({ page }) => {
  await seed(page, [
    ...parts({ count: 4 }),
    {
      id: "loose", filename: "holiday.mp4", status: "active",
      completed_bytes: 100, total_bytes: 1000, bytes_per_second: 50,
      connections: 1, num_pieces: 4, bitfield: "0",
      source_url: "https://example.com/holiday.mp4", directory: "C:\\Downloads"
    }
  ]);
  await expect(page.locator(".download-card")).toHaveCount(2);
  await expect(page.locator(".download-card .filename")).toContainText(["Cyberpunk", "holiday.mp4"]);
});

/* ── Ways this went wrong in review ──────────────────────────────────────── */

test("a half-typed URL left in the other mode does not silently block the batch", async ({ page }) => {
  // #url is type="url". Left holding an invalid value it fails the form's constraint check on
  // submit, and because it is hidden the browser cannot show what it is complaining about —
  // the submit event never fires and Add batch appears to do nothing at all.
  await page.locator("#open-add").click();
  await page.locator("#url").fill("not-a-url");
  await page.locator("#mode-many").click();
  await page.locator("#batch-input").fill("https://cdn.example.com/a[1-3].rar");
  await expect(page.locator("#submit-batch")).toBeEnabled();

  await page.locator("#submit-batch").click();
  // Reaching the destination complaint proves the submit handler ran at all.
  await expect(page.locator("#form-error")).toContainText(/destination folder/i);
});

test("focus survives a refresh while a batch is expanded", async ({ page }) => {
  // The same defect the queue itself was fixed for once: rebuilding every row on each poll
  // throws away the button under a keyboard user's finger.
  await seed(page, parts({ count: 6, done: 2, failed: 1 }));
  await page.locator(".download-card .disclosure").first().click();

  const retry = page.locator(".member-retry:not([hidden])").first();
  await retry.focus();
  const before = await page.evaluate(() => document.activeElement?.getAttribute("aria-label"));

  await page.evaluate(() => window.__sandwichRefresh());
  await page.waitForTimeout(200);

  const after = await page.evaluate(() => document.activeElement?.getAttribute("aria-label"));
  expect(after).toBe(before);
  expect(after).not.toBeNull();
});

test("a batch with nothing left running is removed without being asked about", async ({ page }) => {
  // "This will stop" about a batch whose parts have all failed is the nagging the
  // single-download path deliberately skips.
  const dead = parts({ count: 4 }).map((member) => ({ ...member, status: "failed" }));
  await seed(page, dead);
  const card = page.locator(".download-card").first();
  await expect(card.getByRole("button", { name: /Remove all/ })).toBeVisible();
  await card.getByRole("button", { name: /Remove all/ }).click();
  await expect(page.locator("#app-dialog")).toBeHidden();
});

test("a cancel that only half succeeds keeps the survivors on screen", async ({ page }) => {
  await seed(page, parts({ count: 4 }));
  // Two parts the engine will not let go of.
  await page.evaluate(() => { window.__sandwichUncancellable = ["b1-2", "b1-3"]; });

  await page.locator(".download-card").first().getByRole("button", { name: /Cancel all/ }).click();
  await page.locator("#app-dialog").getByRole("button", { name: /Cancel the batch/ }).click();

  // Hiding a transfer that is still running would be worse than the failed cancel itself.
  await expect(page.locator(".download-card")).toHaveCount(1);
  await expect(page.locator(".toast")).toContainText(/2 files .* could not be cancelled/i);
});

test("the expanded batch does not claim a piece size it cannot know", async ({ page }) => {
  // num_pieces carries the member count on a batch, so the single-download reading of it
  // produces "50 x 0 B" the moment any part has not declared a size.
  const unsized = parts({ count: 5 }).map((member, index) =>
    index === 0 ? { ...member, total_bytes: 0 } : member
  );
  await seed(page, [
    ...unsized,
    {
      id: "loose", filename: "holiday.mp4", status: "active",
      completed_bytes: 100, total_bytes: 1000, bytes_per_second: 50,
      connections: 1, num_pieces: 4, bitfield: "0",
      source_url: "https://example.com/holiday.mp4", directory: "C:\\Downloads"
    }
  ]);

  const batchCard = page.locator(".download-card").first();
  await batchCard.locator(".disclosure").click();
  await expect(batchCard.locator(".detail-pieces")).toBeHidden();
  await expect(batchCard.locator(".detail-resume")).toBeHidden();
  await expect(page.locator(".member-list .member")).toHaveCount(5);

  // And they still mean something on an ordinary download, so this is a batch exemption
  // rather than the rows being removed for everyone.
  const looseCard = page.locator(".download-card").nth(1);
  await looseCard.locator(".disclosure").click();
  await expect(looseCard.locator(".detail-pieces")).toBeVisible();
  await expect(looseCard.locator(".detail-resume")).toBeVisible();
});

test("a batch held for the download window says so once, not fifty times", async ({ page }) => {
  const held = parts({ count: 8 }).map((member) => ({ ...member, status: "paused", scheduled: true }));
  await seed(page, held);
  const card = page.locator(".download-card").first();
  await expect(card.locator(".download-state")).toHaveText("Waiting for the download window");
  await expect(card.getByRole("button", { name: /Start all now/ })).toBeVisible();
});
