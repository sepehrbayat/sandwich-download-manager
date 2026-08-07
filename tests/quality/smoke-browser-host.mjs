import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const hostBinary = process.argv[2];
if (!hostBinary) throw new Error("usage: node smoke-browser-host.mjs <native-host-binary>");

const dataDir = await mkdtemp(join(tmpdir(), "sandwich-native-host-"));
await mkdir(dataDir, { recursive: true });

const rpcBodies = [];
const server = createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  rpcBodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ jsonrpc: "2.0", id: "sandwich-browser", result: "gid-smoke" }));
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address();

await writeFile(join(dataDir, "engine.json"), JSON.stringify({
  endpoint: `http://127.0.0.1:${port}/jsonrpc`,
  secret: "smoke-secret"
}));

function frame(value) {
  const body = Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  return Buffer.concat([header, body]);
}

function decodeFrames(buffer) {
  const values = [];
  let offset = 0;
  while (offset + 4 <= buffer.length) {
    const length = buffer.readUInt32LE(offset);
    if (offset + 4 + length > buffer.length) break;
    values.push(JSON.parse(buffer.subarray(offset + 4, offset + 4 + length).toString("utf8")));
    offset += 4 + length;
  }
  return values;
}

const child = spawn(hostBinary, [], {
  env: { ...process.env, SANDWICH_DATA_DIR: dataDir },
  stdio: ["pipe", "pipe", "inherit"]
});
const output = [];
child.stdout.on("data", (chunk) => output.push(chunk));
child.stdin.end(Buffer.concat([
  frame({
    url: "https://downloads.example.test/video.mp4",
    filename: "../unsafe.mp4",
    referrer: "https://example.test/watch",
    user_agent: "Sandwich smoke browser",
    cookie: "session=local-only"
  }),
  frame({ url: "https://www.youtube.com/watch?v=blocked" })
]));

const exitCode = await new Promise((resolve) => child.on("close", resolve));
server.close();
assert.equal(exitCode, 0);

const replies = decodeFrames(Buffer.concat(output));
assert.deepEqual(replies[0], { ok: true, gid: "gid-smoke" });
assert.equal(replies[1].ok, false);
assert.match(replies[1].error, /YouTube/);
assert.equal(rpcBodies.length, 1, "the blocked request must not reach the engine");
assert.deepEqual(rpcBodies[0].params[0], "token:smoke-secret");
assert.deepEqual(rpcBodies[0].params[1], ["https://downloads.example.test/video.mp4"]);
assert.equal(rpcBodies[0].params[2].out, "unsafe.mp4");
assert.deepEqual(rpcBodies[0].params[2].header, [
  "Referer: https://example.test/watch",
  "Cookie: session=local-only"
]);
assert.equal(rpcBodies[0].params[2]["user-agent"], "Sandwich smoke browser");

console.log("native messaging smoke passed: framing, context, filename policy, and YouTube guard");
