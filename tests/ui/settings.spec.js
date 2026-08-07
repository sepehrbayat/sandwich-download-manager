import { expect, test } from "@playwright/test";

const FIXTURE = "/index.html?fixture";

const savedSettings = (page) => page.evaluate(() => window.__sandwichSettings);

test.beforeEach(async ({ page }) => {
  await page.goto(FIXTURE);
  await page.waitForSelector(".download-card");
});

test("transfer limits open from the title bar without duplicating concurrency", async ({ page }) => {
  await expect(page.locator("#settings")).toBeHidden();
  await page.locator("#open-settings").click();

  await expect(page.locator("#settings")).toBeVisible();
  await expect(page.locator("#open-settings")).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator("#limit-speed")).toBeFocused();
  await expect(page.locator("#schedule-concurrent")).toHaveCount(1);

  await page.locator("#close-settings").click();
  await expect(page.locator("#settings")).toBeHidden();
  await expect(page.locator("#open-settings")).toBeFocused();
});

test("a total speed limit is stored as bytes per second and survives reload", async ({ page }) => {
  await page.locator("#open-settings").click();
  await expect(page.locator("#speed-limit-controls")).toBeHidden();

  await page.locator("#limit-speed").check();
  await expect(page.locator("#speed-limit-controls")).toBeVisible();
  await page.locator("#speed-limit").fill("2");
  await page.locator("#speed-unit").selectOption("1048576");
  await expect.poll(async () => (await savedSettings(page)).speed_limit_bytes).toBe(2097152);

  await page.reload();
  await page.waitForSelector(".download-card");
  await page.locator("#open-settings").click();
  await expect(page.locator("#limit-speed")).toBeChecked();
  await expect(page.locator("#speed-limit")).toHaveValue("2");
  await expect(page.locator("#speed-unit")).toHaveValue("1048576");
});

test("switching the speed limit off sends aria2's unlimited value", async ({ page }) => {
  await page.locator("#open-settings").click();
  await page.locator("#limit-speed").check();
  await page.locator("#speed-limit").fill("500");
  await page.locator("#speed-unit").selectOption("1024");
  await expect.poll(async () => (await savedSettings(page)).speed_limit_bytes).toBe(512000);

  await page.locator("#limit-speed").uncheck();
  await expect(page.locator("#speed-limit-controls")).toBeHidden();
  await expect.poll(async () => (await savedSettings(page)).speed_limit_bytes).toBe(0);
});

test("settings writes stay ordered when an older save is slow", async ({ page }) => {
  await page.evaluate(() => {
    window.__sandwichSaveCalls = [];
    window.__sandwichSettingsGate = async (settings) => {
      window.__sandwichSaveCalls.push(settings.speed_limit_bytes);
      if (window.__sandwichSaveCalls.length === 1) {
        await new Promise((resolve) => { window.__releaseFirstSettingsSave = resolve; });
      }
    };
  });

  await page.locator("#open-settings").click();
  await page.locator("#limit-speed").check();
  await expect.poll(() => page.evaluate(() => window.__sandwichSaveCalls)).toEqual([1048576]);

  await page.locator("#speed-limit").fill("2");
  await page.locator("#speed-limit").press("Tab");
  await page.waitForTimeout(100);
  expect(await page.evaluate(() => window.__sandwichSaveCalls)).toEqual([1048576]);

  await page.evaluate(() => window.__releaseFirstSettingsSave());
  await expect.poll(() => page.evaluate(() => window.__sandwichSaveCalls)).toEqual([1048576, 2097152]);
  await expect.poll(async () => (await savedSettings(page)).speed_limit_bytes).toBe(2097152);
});

test("transfer settings stay reachable when a narrow title bar also shows the schedule", async ({ page }) => {
  await page.setViewportSize({ width: 720, height: 700 });
  const tomorrow = Math.floor((Date.now() + 86_400_000) / 1000);
  await page.evaluate((nextChange) => {
    window.__sandwichScheduleStatus = {
      enabled: true, open: false, next_change_at: nextChange, waiting: 2,
    };
    return window.__sandwichRefresh();
  }, tomorrow);

  await expect(page.locator("#schedule-pill")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)).toBe(false);
  await page.locator("#open-settings").click();
  await expect(page.locator("#settings")).toBeVisible();
});
