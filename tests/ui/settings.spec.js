import { expect, test } from "@playwright/test";

// The speed ceiling is a number the user types in one unit and the engine receives in another,
// so every check here follows a value across that boundary: what reaches the backend, and what
// comes back into the controls afterwards.

const FIXTURE = "/index.html?fixture";

/** What the fixture's settings store holds — the payload the engine would have received. */
const storedSettings = (page) => page.evaluate(() => window.__sandwichSettings);

/**
 * Seeds stored settings before the page loads, so the startup restore path runs for real
 * rather than being simulated after the fact.
 */
async function withStoredSettings(page, settings) {
  await page.addInitScript((value) => {
    window.__sandwichSettings = value;
  }, settings);
}

const BASE_SETTINGS = {
  destination: "C:\\Users\\Tester\\Downloads",
  organize_by_type: false,
  theme: "",
  schedule: {
    enabled: false, start_minute: 120, end_minute: 420,
    days: [true, true, true, true, true, true, true], max_concurrent: 5,
  },
  speed_limit_bytes: 0,
};

test("the amount and unit stay hidden until a limit is actually wanted", async ({ page }) => {
  await page.goto(FIXTURE);
  await page.waitForSelector(".download-card");
  await page.locator("#open-settings").click();

  await expect(page.locator("#settings")).toBeVisible();
  // Two controls that mean nothing while the limit is off are clutter, not configuration.
  await expect(page.locator("#speed-limit-controls")).toBeHidden();

  await page.locator("#limit-speed").check();
  await expect(page.locator("#speed-limit-controls")).toBeVisible();
});

test("a limit reaches the engine as bytes per second", async ({ page }) => {
  await page.goto(FIXTURE);
  await page.waitForSelector(".download-card");
  await page.locator("#open-settings").click();
  await page.locator("#limit-speed").check();

  await page.locator("#speed-limit").fill("2");
  await page.locator("#speed-unit").selectOption("1048576");
  await expect
    .poll(async () => (await storedSettings(page)).speed_limit_bytes)
    .toBe(2097152);

  await page.locator("#speed-unit").selectOption("1024");
  await expect
    .poll(async () => (await storedSettings(page)).speed_limit_bytes)
    .toBe(2048);
});

test("saving a limit does not discard the schedule sharing the same settings file", async ({ page }) => {
  // Both panels write the whole Settings struct. A save from one that forgot the other's
  // half would silently switch off a download window the user had set.
  await withStoredSettings(page, {
    ...BASE_SETTINGS,
    schedule: { ...BASE_SETTINGS.schedule, enabled: true, max_concurrent: 3 },
  });
  await page.goto(FIXTURE);
  await page.waitForSelector(".download-card");

  await page.locator("#open-settings").click();
  await page.locator("#limit-speed").check();
  await expect
    .poll(async () => (await storedSettings(page)).speed_limit_bytes)
    .toBeGreaterThan(0);

  const saved = await storedSettings(page);
  expect(saved.schedule.enabled).toBe(true);
  expect(saved.schedule.max_concurrent).toBe(3);
});

test("switching the limit off asks the engine for no limit rather than a tiny one", async ({ page }) => {
  await page.goto(FIXTURE);
  await page.waitForSelector(".download-card");
  await page.locator("#open-settings").click();
  await page.locator("#limit-speed").check();
  await page.locator("#speed-limit").fill("500");
  await page.locator("#speed-unit").selectOption("1024");
  await expect
    .poll(async () => (await storedSettings(page)).speed_limit_bytes)
    .toBe(512000);

  await page.locator("#limit-speed").uncheck();
  await expect(page.locator("#speed-limit-controls")).toBeHidden();
  // Zero is aria2's word for unlimited. A leftover 500 here would keep throttling in silence.
  await expect
    .poll(async () => (await storedSettings(page)).speed_limit_bytes)
    .toBe(0);
});

test("a stored limit is restored as the number that was typed", async ({ page }) => {
  // 2 MB/s, not the 2048 KB/s it is equal to.
  await withStoredSettings(page, { ...BASE_SETTINGS, speed_limit_bytes: 2097152 });
  await page.goto(FIXTURE);
  await page.waitForSelector(".download-card");
  await page.locator("#open-settings").click();

  await expect(page.locator("#limit-speed")).toBeChecked();
  await expect(page.locator("#speed-limit-controls")).toBeVisible();
  await expect(page.locator("#speed-limit")).toHaveValue("2");
  await expect(page.locator("#speed-unit")).toHaveValue("1048576");
});

test("a settings file from before the limit existed opens unlimited", async ({ page }) => {
  // The upgrade path: no speed_limit_bytes key at all. Starting someone's app throttled
  // because a field was absent would be a restriction they never chose and could not explain.
  const { speed_limit_bytes, ...withoutLimit } = BASE_SETTINGS;
  await withStoredSettings(page, withoutLimit);
  await page.goto(FIXTURE);
  await page.waitForSelector(".download-card");
  await page.locator("#open-settings").click();

  await expect(page.locator("#limit-speed")).not.toBeChecked();
  await expect(page.locator("#speed-limit-controls")).toBeHidden();
});
