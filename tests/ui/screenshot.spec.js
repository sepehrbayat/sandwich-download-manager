import { test } from "@playwright/test";

// Not a test: a camera. `npx playwright test screenshot` drops current-state captures in
// test-results/ so a human (or an agent) can judge what the CSS actually looks like —
// assertions upstream check structure, but nobody's eyes are in CI.
test("capture queue in each theme", async ({ page }) => {
  await page.goto("/index.html?fixture");
  await page.waitForSelector(".download-card");
  await page.screenshot({ path: "test-results/capture-classic.png", fullPage: true });

  for (const theme of ["rye", "sesame", "pistachio", "toast"]) {
    await page.locator(`.theme-swatch[data-theme-choice="${theme}"]`).click();
    await page.waitForTimeout(150);
    await page.screenshot({ path: `test-results/capture-${theme}.png`, fullPage: true });
  }
  await page.evaluate(() => localStorage.removeItem("sandwich-theme"));
});

test("capture a batch: the paste box and the card it becomes", async ({ page }) => {
  await page.goto("/index.html?fixture");
  await page.waitForSelector(".download-card");

  await page.locator("#open-add").click();
  await page.locator("#mode-many").click();
  await page.locator("#batch-input").fill(
    "https://cdn.example.com/Cyberpunk.part[01-50].rar\nftp://cdn.example.com/readme.txt"
  );
  await page.waitForTimeout(250);
  await page.screenshot({ path: "test-results/capture-batch-paste.png", fullPage: true });

  // The card fifty transfers collapse into, half finished with a couple of failures.
  await page.locator("#close-add").click();
  await page.locator("#dismiss-offer").click();
  await page.evaluate(() => {
    const members = Array.from({ length: 50 }, (_, index) => {
      let status = "queued";
      if (index < 22) status = "completed";
      else if (index < 24) status = "failed";
      else if (index < 27) status = "active";
      return {
        id: `cp-${index}`,
        filename: `Cyberpunk.part${String(index + 1).padStart(2, "0")}.rar`,
        status,
        completed_bytes: status === "completed" ? 2_147_483_648 : status === "active" ? 900_000_000 : 0,
        total_bytes: 2_147_483_648,
        bytes_per_second: status === "active" ? 4_200_000 : 0,
        connections: status === "active" ? 8 : 0,
        num_pieces: 40, bitfield: "0",
        source_url: `https://cdn.example.com/Cyberpunk.part${index + 1}.rar`,
        directory: "C:\\Users\\Tester\\Downloads",
        batch_id: "cp", batch_name: "Cyberpunk"
      };
    });
    const original = window.__SANDWICH_TEST_BRIDGE__.invoke;
    window.__SANDWICH_TEST_BRIDGE__.invoke = async (command, payload) =>
      command === "list_downloads" ? members : original(command, payload);
    return window.__sandwichRefresh();
  });
  await page.waitForSelector(".download-card");
  await page.locator(".download-card .disclosure").first().click();
  await page.waitForTimeout(200);
  await page.screenshot({ path: "test-results/capture-batch-card.png", fullPage: true });
});

test("capture the schedule panel, open and closed window", async ({ page }) => {
  await page.goto("/index.html?fixture");
  await page.waitForSelector(".download-card");

  await page.locator("#open-schedule").click();
  await page.locator("#schedule-enabled").check();
  await page.locator("#schedule-start").fill("22:00");
  await page.locator("#schedule-end").fill("06:00");
  await page.getByRole("checkbox", { name: "Saturday" }).uncheck();
  await page.getByRole("checkbox", { name: "Sunday" }).uncheck();

  // The state that matters most: the window is shut, the queue is holding, and the interface
  // has to make that legible rather than looking broken.
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(2, 0, 0, 0);
  await page.evaluate((next) => {
    window.__sandwichScheduleStatus = { enabled: true, open: false, next_change_at: next, waiting: 2 };
    const original = window.__SANDWICH_TEST_BRIDGE__.invoke;
    window.__SANDWICH_TEST_BRIDGE__.invoke = async (command, payload) => command === "list_downloads"
      ? [
          { id: "held-1", filename: "ubuntu-24.04.iso", status: "paused", scheduled: true, completed_bytes: 3145728, total_bytes: 10485760, bytes_per_second: 0, connections: 0, num_pieces: 40, bitfield: "0", source_url: "https://releases.example.com/ubuntu-24.04.iso", directory: "C:\\Users\\Tester\\Downloads" },
          { id: "held-2", filename: "album.flac", status: "paused", scheduled: true, completed_bytes: 0, total_bytes: 4194304, bytes_per_second: 0, connections: 0, num_pieces: 16, bitfield: "0", source_url: "https://music.example.com/album.flac", directory: "C:\\Users\\Tester\\Downloads" },
          { id: "user-paused", filename: "holiday.mp4", status: "paused", scheduled: false, completed_bytes: 2097152, total_bytes: 8388608, bytes_per_second: 0, connections: 0, num_pieces: 24, bitfield: "0", source_url: "https://video.example.com/holiday.mp4", directory: "C:\\Users\\Tester\\Downloads" }
        ]
      : original(command, payload);
    return window.__sandwichRefresh();
  }, Math.floor(tomorrow.getTime() / 1000));

  await page.waitForSelector("#schedule-pill:not([hidden])");
  await page.screenshot({ path: "test-results/capture-schedule-closed.png", fullPage: true });

  // And the queue underneath it, which is where a held download either explains itself or
  // looks like a bug.
  await page.locator("#dismiss-offer").click();
  await page.locator("#close-schedule").click();
  await page.waitForTimeout(150);
  await page.screenshot({ path: "test-results/capture-schedule-queue.png", fullPage: true });

  await page.evaluate(() => {
    window.__sandwichScheduleStatus = { enabled: true, open: true, next_change_at: Math.floor(Date.now() / 1000) + 5400, waiting: 0 };
    return window.__sandwichRefresh();
  });
  await page.waitForTimeout(150);
  await page.screenshot({ path: "test-results/capture-schedule-open.png", fullPage: true });
});
