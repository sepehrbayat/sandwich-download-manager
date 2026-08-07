import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";

const extensionPath = resolve("extension");
const profile = await mkdtemp(join(tmpdir(), "sandwich-extension-profile-"));
const server = createServer((request, response) => {
  if (request.url === "/media.mp4") {
    response.writeHead(200, { "content-type": "video/mp4", "content-length": "0" });
    return response.end();
  }
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end('<video style="width:640px;height:360px" controls src="/media.mp4"></video>');
});
await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));

const channel = process.env.PLAYWRIGHT_BROWSER === "chromium" ? "chromium" : "msedge";
let context;
try {
  context = await chromium.launchPersistentContext(profile, {
    channel,
    headless: true,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`
    ]
  });

  await assert.doesNotReject(async () => {
    await context.waitForEvent("serviceworker", { timeout: 10_000 }).catch(() => {});
    assert.ok(context.serviceWorkers()[0], "Chromium did not start the extension service worker");
  });
  const extensionId = new URL(context.serviceWorkers()[0].url()).host;

  const onboarding = await context.newPage();
  await onboarding.goto(`chrome-extension://${extensionId}/onboarding.html`);
  await onboarding.waitForFunction(() => !document.querySelector("#consent").disabled);
  await onboarding.locator("#consent").check();
  await onboarding.locator("#save").click();
  await onboarding.locator("#saved").waitFor({ state: "visible" });
  assert.deepEqual(
    await onboarding.evaluate(() => chrome.storage.local.get(["consentVersion", "enabled"])),
    { consentVersion: 1, enabled: true }
  );

  const media = await context.newPage();
  await media.goto(`http://127.0.0.1:${server.address().port}/`);
  await media.locator("video").hover();
  const action = media.locator("[data-sandwich-media-action] button");
  await action.waitFor({ state: "visible" });
  assert.equal(await action.textContent(), "Download with Sandwich");
  await action.click();
  await assert.doesNotReject(() => action.getByText("Open the Sandwich desktop app and finish browser setup").waitFor());

  const blocked = await context.newPage();
  await blocked.route("https://www.youtube.com/**", (route) => route.fulfill({
    status: 200,
    contentType: "text/html",
    body: '<video src="https://cdn.example.test/video.mp4"></video>'
  }));
  await blocked.goto("https://www.youtube.com/watch?v=policy-smoke");
  await blocked.locator("video").hover();
  assert.equal(await blocked.locator("[data-sandwich-media-action]").count(), 0);

  console.log(`extension smoke passed in ${channel}: consent, direct media action, and YouTube exclusion`);
} finally {
  await context?.close();
  server.close();
}
