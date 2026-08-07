import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "extension");
const dist = join(root, "dist");
const webExt = join(root, "node_modules", "web-ext", "bin", "web-ext.js");
const lintOnly = process.argv.includes("--lint-only");
const reproducibleTimestamp = new Date("2000-01-01T00:00:00.000Z");

const runtimeFiles = [
  "background.js",
  "policy.js",
  "content.js",
  "popup.html",
  "popup.js",
  "onboarding.html",
  "onboarding.js",
  "icon16.png",
  "icon32.png",
  "icon48.png",
  "icon128.png"
];

const chromiumManifest = JSON.parse(await readFile(join(source, "manifest.json"), "utf8"));
const firefoxManifest = JSON.parse(await readFile(join(source, "manifest.firefox.json"), "utf8"));
if (chromiumManifest.version !== firefoxManifest.version) {
  throw new Error("Chromium and Firefox manifest versions do not match");
}

function runWebExt(args) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [webExt, ...args], { cwd: root, stdio: "inherit" });
    child.on("error", rejectRun);
    child.on("close", (code) => code === 0 ? resolveRun() : rejectRun(new Error(`web-ext exited with ${code}`)));
  });
}

async function stage(manifestName, label) {
  const staging = await mkdtemp(join(tmpdir(), `sandwich-extension-${label}-`));
  for (const file of runtimeFiles) await stageFile(file, file, staging);
  await stageFile(manifestName, "manifest.json", staging);
  return staging;
}

async function stageFile(sourceName, destinationName, staging) {
  const input = await readFile(join(source, sourceName));
  const output = /\.(?:html|js|json)$/.test(sourceName)
    ? Buffer.from(input.toString("utf8").replace(/\r\n?/g, "\n"), "utf8")
    : input;
  const destination = join(staging, destinationName);
  await writeFile(destination, output);
  await chmod(destination, 0o644);
  await utimes(destination, reproducibleTimestamp, reproducibleTimestamp);
}

async function buildArchive(staging, destination) {
  const zip = new JSZip();
  for (const file of ["manifest.json", ...runtimeFiles].sort()) {
    zip.file(file, await readFile(join(staging, file)), {
      date: reproducibleTimestamp,
      createFolders: false,
      unixPermissions: 0o100644
    });
  }
  const bytes = await zip.generateAsync({
    type: "nodebuffer",
    platform: "UNIX",
    compression: "DEFLATE",
    compressionOptions: { level: 9 }
  });
  await writeFile(destination, bytes);
}

const firefoxStage = await stage("manifest.firefox.json", "firefox");
try {
  await runWebExt(["lint", "--source-dir", firefoxStage, "--warnings-as-errors"]);
  if (!lintOnly) {
    await mkdir(dist, { recursive: true });
    const chromiumStage = await stage("manifest.json", "chromium");
    try {
      const version = chromiumManifest.version;
      const chromiumName = `sandwich-extension-chrome-${version}.zip`;
      const firefoxName = `sandwich-extension-firefox-${version}.zip`;
      const edgeName = `sandwich-extension-edge-${version}.zip`;
      await buildArchive(chromiumStage, join(dist, chromiumName));
      await buildArchive(firefoxStage, join(dist, firefoxName));
      await copyFile(join(dist, chromiumName), join(dist, edgeName));

      for (const name of [chromiumName, edgeName, firefoxName]) {
        const bytes = await readFile(join(dist, name));
        console.log(`${createHash("sha256").update(bytes).digest("hex")}  ${basename(name)}`);
      }
    } finally {
      await rm(chromiumStage, { recursive: true, force: true });
    }
  }
} finally {
  await rm(firefoxStage, { recursive: true, force: true });
}
