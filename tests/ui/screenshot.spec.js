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
