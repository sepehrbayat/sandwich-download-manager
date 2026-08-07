import { expect, test } from "@playwright/test";

// The download window is the one feature whose correct behaviour is *nothing happening*, so
// every check here is really the same question: when the queue stops itself, does the interface
// say so, and can the user still get their file?

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

/** Puts the backend's view of the window into the state a test needs, then re-syncs. */
async function setWindowState(page, status) {
  await page.evaluate((value) => {
    window.__sandwichScheduleStatus = value;
    return window.__sandwichRefresh();
  }, status);
}

const savedSchedule = (page) => page.evaluate(() => window.__sandwichSettings.schedule);

test.beforeEach(async ({ page }) => {
  await page.goto(FIXTURE);
  await page.waitForSelector(".download-card");
});

test("the schedule panel opens from the title bar with a day for every day", async ({ page }) => {
  await expect(page.locator("#schedule")).toBeHidden();
  await page.locator("#open-schedule").click();

  await expect(page.locator("#schedule")).toBeVisible();
  await expect(page.locator("#schedule-days input[type=checkbox]")).toHaveCount(7);
  for (const day of ["Monday", "Wednesday", "Sunday"]) {
    await expect(page.getByRole("checkbox", { name: day })).toBeChecked();
  }
});

test("the window controls stay inert until the window is switched on", async ({ page }) => {
  // Fields that look editable but do nothing are worse than fields that admit they are off.
  await page.locator("#open-schedule").click();
  await expect(page.locator("#schedule-start")).toBeDisabled();

  await page.locator("#schedule-enabled").check();
  await expect(page.locator("#schedule-start")).toBeEnabled();
  // "How many at once" is a transfer limit, so it remains live outside the schedule panel.
  await page.locator("#open-settings").click();
  await expect(page.locator("#schedule-concurrent")).toBeEnabled();
});

test("an overnight window is stored as the minutes the backend expects", async ({ page }) => {
  await page.locator("#open-schedule").click();
  await page.locator("#schedule-enabled").check();
  await page.locator("#schedule-start").fill("22:00");
  await page.locator("#schedule-end").fill("06:00");

  await expect.poll(() => savedSchedule(page)).toMatchObject({
    enabled: true,
    start_minute: 22 * 60,
    end_minute: 6 * 60,
  });
});

test("choosing weekdays only is saved as Monday-first days", async ({ page }) => {
  await page.locator("#open-schedule").click();
  await page.locator("#schedule-enabled").check();
  await page.getByRole("checkbox", { name: "Saturday" }).uncheck();
  await page.getByRole("checkbox", { name: "Sunday" }).uncheck();

  await expect.poll(() => savedSchedule(page)).toMatchObject({
    days: [true, true, true, true, true, false, false],
  });
});

test("a schedule with no days ticked says so instead of silently downloading nothing", async ({ page }) => {
  await page.locator("#open-schedule").click();
  await page.locator("#schedule-enabled").check();
  for (const day of ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]) {
    await page.getByRole("checkbox", { name: day }).uncheck();
  }

  await expect(page.locator("#schedule-error")).toBeVisible();
  await expect(page.locator("#schedule-error")).toContainText(/tick at least one day/i);
});

test("the simultaneous-downloads figure is clamped to something workable", async ({ page }) => {
  await page.locator("#open-settings").click();
  await page.locator("#schedule-concurrent").fill("99");
  await page.locator("#schedule-concurrent").blur();
  await expect.poll(() => savedSchedule(page)).toMatchObject({ max_concurrent: 16 });
  await expect(page.locator("#schedule-concurrent")).toHaveValue("16");

  // Zero at once is a stopped queue with no way to tell that is what you asked for.
  await page.locator("#schedule-concurrent").fill("0");
  await page.locator("#schedule-concurrent").blur();
  await expect.poll(() => savedSchedule(page)).toMatchObject({ max_concurrent: 1 });
  await expect(page.locator("#schedule-concurrent")).toHaveValue("1");
});

test("a closed window explains itself in the title bar and opens the panel when clicked", async ({ page }) => {
  // Tomorrow at 02:00, so the wording has a real moment to name.
  const tomorrowAtTwo = new Date();
  tomorrowAtTwo.setDate(tomorrowAtTwo.getDate() + 1);
  tomorrowAtTwo.setHours(2, 0, 0, 0);

  await expect(page.locator("#schedule-pill")).toBeHidden();
  await setWindowState(page, {
    enabled: true,
    open: false,
    next_change_at: Math.floor(tomorrowAtTwo.getTime() / 1000),
    waiting: 2,
  });

  await expect(page.locator("#schedule-pill")).toBeVisible();
  await expect(page.locator("#schedule-pill")).toContainText(/downloads start/i);

  // The indicator is what someone clicks when asking "why is nothing downloading?", so it has
  // to lead to the answer.
  await page.locator("#schedule-pill").click();
  await expect(page.locator("#schedule")).toBeVisible();
  await expect(page.locator("#schedule-detail")).toContainText(/2 downloads waiting/);
});

test("an open window keeps the title bar quiet", async ({ page }) => {
  await setWindowState(page, {
    enabled: true,
    open: true,
    next_change_at: Math.floor(Date.now() / 1000) + 3600,
    waiting: 0,
  });
  await expect(page.locator("#schedule-pill")).toBeHidden();

  await page.locator("#open-schedule").click();
  await expect(page.locator("#schedule-headline")).toContainText(/window open/i);
});

test("a download held for the window says so and offers to start anyway", async ({ page }) => {
  await seed(page, [
    {
      id: "held-1", filename: "big.iso", status: "paused", scheduled: true,
      completed_bytes: 0, total_bytes: 4194304, bytes_per_second: 0,
      connections: 0, num_pieces: 16, bitfield: "0",
      source_url: "https://example.com/big.iso", directory: "C:\\Downloads",
    },
  ]);

  const card = page.locator(".download-card").first();
  await expect(card.locator(".download-state")).toHaveText("Waiting for the download window");
  // "Resume" would answer a question nobody asked; "Start now" names the override.
  await expect(card.getByRole("button", { name: /^Start now/ })).toBeVisible();
  await expect(card.getByRole("button", { name: /^Resume/ })).toHaveCount(0);
});

test("a download the user paused is not confused with one the schedule holds", async ({ page }) => {
  await seed(page, [
    {
      id: "user-paused", filename: "album.flac", status: "paused", scheduled: false,
      completed_bytes: 1048576, total_bytes: 4194304, bytes_per_second: 0,
      connections: 0, num_pieces: 16, bitfield: "f000",
      source_url: "https://example.com/album.flac", directory: "C:\\Downloads",
    },
  ]);

  const card = page.locator(".download-card").first();
  await expect(card.locator(".download-state")).toHaveText("Paused");
  await expect(card.getByRole("button", { name: /^Resume/ })).toBeVisible();
});

test("a stored schedule is what the panel opens showing", async ({ page }) => {
  // The startup path, not a round trip through the form: a window saved last week has to be
  // the one on screen, or the first thing the user does is set it again.
  await page.addInitScript(() => {
    window.__sandwichSettings = {
      destination: "", organize_by_type: false, theme: "",
      schedule: {
        enabled: true,
        start_minute: 23 * 60 + 30,
        end_minute: 6 * 60,
        days: [true, true, true, true, true, false, false],
        max_concurrent: 2,
      },
    };
  });
  await page.goto(FIXTURE);
  await page.waitForSelector(".download-card");

  await page.locator("#open-schedule").click();
  await expect(page.locator("#schedule-enabled")).toBeChecked();
  await expect(page.locator("#schedule-start")).toHaveValue("23:30");
  await expect(page.locator("#schedule-end")).toHaveValue("06:00");
  await page.locator("#open-settings").click();
  await expect(page.locator("#schedule-concurrent")).toHaveValue("2");
  await expect(page.getByRole("checkbox", { name: "Friday" })).toBeChecked();
  await expect(page.getByRole("checkbox", { name: "Saturday" })).not.toBeChecked();
});
