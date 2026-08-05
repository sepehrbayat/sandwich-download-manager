import { expect, test } from "@playwright/test";

// Every case here corresponds to a bug that shipped and was found by hand. The frontend unit
// tests cover formatting; nothing covered rendering, focus or layout, which is where the real
// defects were. A fixture supplies the engine, so these run without the desktop app.

const FIXTURE = "/index.html?fixture";

/** Replaces the fixture's queue so a test can describe the exact state it needs. */
async function seed(page, downloads) {
  await page.evaluate((items) => {
    const original = window.__SANDWICH_TEST_BRIDGE__.invoke;
    window.__SANDWICH_TEST_BRIDGE__.invoke = async (command, payload) =>
      command === "list_downloads" ? items : original(command, payload);
  }, downloads);
  await page.evaluate(() => window.__sandwichRefresh());
  await page.waitForFunction(
    (count) => document.querySelectorAll(".download-card").length === count,
    downloads.length,
  );
}

test.beforeEach(async ({ page }) => {
  await page.goto(FIXTURE);
  await page.waitForSelector(".download-card");
});

test("the queue renders every download the engine reports", async ({ page }) => {
  await expect(page.locator(".download-card")).toHaveCount(4);
  await expect(page.locator("#empty-state")).toBeHidden();
});

test("category counts agree with what the filter actually shows", async ({ page }) => {
  for (const item of await page.locator(".rail-item").all()) {
    const badge = Number(await item.locator(".rail-count").innerText());
    await item.click();
    await expect(page.locator(".download-card")).toHaveCount(badge);
    // An empty result must say so rather than showing a blank panel.
    await expect(page.locator("#empty-state")).toBeVisible({ visible: badge === 0 });
  }
});

test("keyboard focus survives a progress update", async ({ page }) => {
  // The original bug: every engine event rebuilt the list, so the button under the user's
  // finger was destroyed and focus fell back to the body mid-interaction.
  const pause = page.locator('button[aria-label^="Pause"]').first();
  await pause.focus();
  const before = await page.evaluate(() => document.activeElement?.getAttribute("aria-label"));

  // Trigger the refresh code path programmatically so the only thing that can move focus
  // is the render itself.
  await page.evaluate(() => window.__sandwichRefresh());
  await page.waitForTimeout(200);

  const after = await page.evaluate(() => document.activeElement?.getAttribute("aria-label"));
  expect(after).toBe(before);
  expect(after).not.toBeNull();
});

test("focus moves to the replacement control when the actions change", async ({ page }) => {
  // Pausing legitimately swaps Pause for Resume. Focus has to follow, which the first fix got
  // wrong: disabling the button blurred it before the re-render could find it.
  const pause = page.locator('button[aria-label^="Pause"]').first();
  await pause.focus();
  await pause.click();

  await expect(page.locator('button[aria-label^="Resume"]').first()).toBeFocused();
});

test("the segment bar sizes its cells from the rendered width", async ({ page }) => {
  // The bar was measured before the card was in the document, so a new download always sized
  // itself from a fallback width and rendered the wrong number of cells.
  const cells = page.locator(".download-card").first().locator(".piece");
  await expect(cells.first()).toBeVisible();

  const width = await cells.first().evaluate((el) => el.getBoundingClientRect().width);
  expect(width).toBeGreaterThan(8);
  expect(width).toBeLessThan(26);
});

test("a file with fewer pieces than cells still fills the bar evenly", async ({ page }) => {
  // A one-piece file used to render as a single enormous block spanning the whole bar.
  await seed(page, [
    {
      id: "tiny", filename: "note.pdf", status: "active",
      completed_bytes: 1024, total_bytes: 2048, bytes_per_second: 512,
      eta_seconds: 2, connections: 1, num_pieces: 1, bitfield: "0",
      source_url: "https://example.com/note.pdf", directory: "C:\\Downloads",
    },
  ]);
  const cells = page.locator(".piece");
  expect(await cells.count()).toBeGreaterThan(10);
  const width = await cells.first().evaluate((el) => el.getBoundingClientRect().width);
  expect(width).toBeLessThan(26);
});

test("a download of unknown size does not claim to be 0% of 0 B", async ({ page }) => {
  await seed(page, [
    {
      id: "unknown", filename: "stream.bin", status: "active",
      completed_bytes: 12345, total_bytes: 0, bytes_per_second: 1024,
      eta_seconds: null, connections: 2, num_pieces: 0, bitfield: "",
      source_url: "https://example.com/stream.bin", directory: "C:\\Downloads",
    },
  ]);
  await expect(page.locator(".percent").first()).toHaveText("—");
  await expect(page.locator(".size").first()).toContainText("so far");
  await expect(page.locator(".size").first()).not.toContainText("of 0 B");
});

test("details expose where the file came from and where it is going", async ({ page }) => {
  const card = page.locator(".download-card").first();
  await card.locator(".disclosure").click();
  await expect(card.locator(".details")).toBeVisible();
  await expect(card.locator(".detail-url")).not.toBeEmpty();
  await expect(card.locator(".detail-dir")).not.toBeEmpty();
  await expect(card.locator(".disclosure")).toHaveAttribute("aria-expanded", "true");
});

test("submitting without a destination explains itself", async ({ page }) => {
  await page.click("#open-add");
  await page.fill("#url", "https://example.com/file.zip");
  await page.click('#download-form button[type="submit"]');
  await expect(page.locator("#form-error")).toBeVisible();
  await expect(page.locator("#form-error")).toContainText("destination");
});

test("the interface stays usable at a narrow window", async ({ page }) => {
  await page.setViewportSize({ width: 720, height: 700 });
  await page.waitForTimeout(300);
  const overflows = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth + 1,
  );
  expect(overflows).toBe(false);
  await expect(page.locator(".download-card").first()).toBeVisible();
});

test("a failed download explains itself in words, not transport codes", async ({ page }) => {
  const failed = page.locator('.download-card[data-status="failed"]').first();
  // The engine's raw "status=403" line must not reach the card face…
  await expect(failed.locator(".error-headline")).toContainText("Access denied");
  await expect(failed.locator(".download-error")).not.toContainText("response status is not successful");
  // …and the hint says what to do next.
  await expect(failed.locator(".error-hint")).not.toBeEmpty();
  // The raw engine text stays reachable for diagnosis under details.
  await failed.locator(".disclosure").click();
  await expect(failed.locator(".detail-raw")).toContainText("status=403");
});

test("a failed card is compact: no skeleton progress bar, no dashed-out metrics", async ({ page }) => {
  const failed = page.locator('.download-card[data-status="failed"]').first();
  await expect(failed.locator(".stack")).toBeHidden();
  await expect(failed.locator(".metrics")).toBeHidden();
  // Recovery lives on the card itself.
  await expect(failed.locator("button", { hasText: "Retry" })).toBeVisible();
});

test("retrying a failed download replaces it with a live transfer", async ({ page }) => {
  await page.locator('.download-card[data-status="failed"] button', { hasText: "Retry" }).first().click();
  await expect(page.locator('.download-card[data-status="failed"]')).toHaveCount(0);
  await expect(page.locator(".download-card")).toHaveCount(4);
});

test("bulk failure controls appear only while something has failed", async ({ page }) => {
  await expect(page.locator("#retry-failed")).toBeVisible();
  await expect(page.locator("#clear-failed")).toBeVisible();
  await seed(page, [
    {
      id: "only", filename: "fine.zip", status: "active",
      completed_bytes: 10, total_bytes: 100, bytes_per_second: 5,
      eta_seconds: 18, connections: 1, num_pieces: 1, bitfield: "0",
      source_url: "https://example.com/fine.zip", directory: "C:\\Downloads",
    },
  ]);
  await expect(page.locator("#retry-failed")).toBeHidden();
  await expect(page.locator("#clear-failed")).toBeHidden();
});

test("every card names the domain it downloads from", async ({ page }) => {
  const sources = page.locator(".download-card .download-source");
  await expect(sources.first()).toContainText("releases.example.com");
  // Full URL stays one hover away.
  await expect(sources.first()).toHaveAttribute("title", /https:\/\//);
});

test("live transfers sort above failures regardless of arrival order", async ({ page }) => {
  await seed(page, [
    {
      id: "f1", filename: "broken.zip", status: "failed", completed_bytes: 0, total_bytes: 10,
      bytes_per_second: 0, connections: 0, num_pieces: 1, bitfield: "0",
      error: { message: "x" }, source_url: "https://a.example.com/broken.zip", directory: "C:\\D",
    },
    {
      id: "a1", filename: "moving.zip", status: "active", completed_bytes: 5, total_bytes: 10,
      bytes_per_second: 1, eta_seconds: 5, connections: 1, num_pieces: 1, bitfield: "0",
      source_url: "https://b.example.com/moving.zip", directory: "C:\\D",
    },
  ]);
  await expect(page.locator(".download-card").first()).toHaveAttribute("data-status", "active");
});

test("search narrows the queue by name and address", async ({ page }) => {
  await page.fill("#queue-search", "album");
  await expect(page.locator(".download-card")).toHaveCount(1);
  await expect(page.locator(".filename").first()).toHaveText("album.flac");
  await page.fill("#queue-search", "");
  await expect(page.locator(".download-card")).toHaveCount(4);
});

test("every download is reachable through some file-type filter", async ({ page }) => {
  // The sidebar's type arithmetic must add up to the total, or downloads silently
  // disappear from every filter — the "7 of 10 invisible" bug.
  const counts = await page.evaluate(() => {
    const all = Number(document.querySelector('[data-count="all"]').textContent);
    const types = [...document.querySelectorAll('[data-count^="type:"]')]
      .reduce((sum, node) => sum + Number(node.textContent), 0);
    return { all, types };
  });
  expect(counts.types).toBe(counts.all);
});

test("every control carries an accessible name", async ({ page }) => {
  const unnamed = await page.evaluate(() =>
    [...document.querySelectorAll("button")].filter(
      (button) => !button.textContent.trim() && !button.getAttribute("aria-label"),
    ).length,
  );
  expect(unnamed).toBe(0);

  // The segment bar is meaningless to a screen reader without a description.
  const described = await page.evaluate(() =>
    [...document.querySelectorAll(".stack")].every((bar) => bar.getAttribute("aria-label")),
  );
  expect(described).toBe(true);
});
