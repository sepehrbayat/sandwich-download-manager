import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const context = vm.createContext({ URL });
vm.runInContext(readFileSync(new URL("../../extension/policy.js", import.meta.url), "utf8"), context);
const policy = context.SandwichExtensionPolicy;

test("direct media accepts HTTP sources and rejects opaque browser blobs", () => {
  assert.equal(policy.directMediaUrl("https://cdn.example/video.mp4", "https://example/page"), "https://cdn.example/video.mp4");
  assert.equal(policy.directMediaUrl("blob:https://example/id", "https://example/page"), "");
  assert.equal(policy.directMediaUrl("data:video/mp4;base64,AAAA", "https://example/page"), "");
});

test("the store policy blocks YouTube at both page and source boundaries", () => {
  assert.equal(policy.isRestrictedMediaSite("https://music.youtube.com/watch?v=1"), true);
  assert.equal(policy.isRestrictedMediaSite("https://notyoutube.com/video"), false);
  assert.equal(policy.directMediaUrl("https://cdn.example/video.mp4", "https://www.youtube.com/watch?v=1"), "");
  assert.equal(policy.directMediaUrl("https://youtu.be/file.mp4", "https://example/page"), "");
});

test("Chromium and Firefox packages advertise the same release and permissions", () => {
  const chromium = JSON.parse(readFileSync(new URL("../../extension/manifest.json", import.meta.url), "utf8"));
  const firefox = JSON.parse(readFileSync(new URL("../../extension/manifest.firefox.json", import.meta.url), "utf8"));
  assert.equal(chromium.version, firefox.version);
  assert.deepEqual(chromium.permissions, firefox.permissions);
  assert.deepEqual(chromium.host_permissions, firefox.host_permissions);
  assert.equal(chromium.background.service_worker, "background.js");
  assert.deepEqual(firefox.background.scripts, ["policy.js", "background.js"]);
});
