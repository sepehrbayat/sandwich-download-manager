import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const root = normalize(join(import.meta.dirname, "..", "..", "src"));
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };
createServer(async (request, response) => {
  const url = new URL(request.url, "http://127.0.0.1");
  const relative = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
  const path = normalize(join(root, relative));
  if (!path.startsWith(root)) { response.writeHead(403).end(); return; }
  try {
    let content = await readFile(path);
    if (relative === "index.html" && url.searchParams.has("fixture")) {
      const fixture = `<script>window.__SANDWICH_TEST_BRIDGE__ = {
        invoke: async (command, payload) => {
          if (command === "list_downloads") return [
            { id: "active-1", filename: "example.zip", status: "active", completed_bytes: 5242880, total_bytes: 10485760, bytes_per_second: 1048576, eta_seconds: 5 },
            { id: "paused-1", filename: "paused.iso", status: "paused", completed_bytes: 1048576, total_bytes: 4194304, bytes_per_second: 0 },
            { id: "failed-1", filename: "failed.pdf", status: "failed", completed_bytes: 0, total_bytes: 2048, bytes_per_second: 0, error: { message: "The destination is unavailable." } },
            { id: "completed-1", filename: "finished.png", status: "completed", completed_bytes: 4096, total_bytes: 4096, bytes_per_second: 0 }
          ];
          if (command === "choose_destination") return "C:\\\\Users\\\\Tester\\\\Downloads";
          if (command === "submit_url") return { id: "queued-2", filename: "manual.iso", status: "queued", completed_bytes: 0, total_bytes: 2097152, bytes_per_second: 0 };
          if (command === "control_download") return { id: payload.downloadId, filename: "example.zip", status: payload.action === "pause" ? "paused" : "cancelled", completed_bytes: 5242880, total_bytes: 10485760, bytes_per_second: 0 };
        },
        listen: async (event, handler) => {
          if (event === "clipboard-url-offer") setTimeout(() => handler({ payload: { display_url: "https://example.com/copied.zip", token: "fixture-offer" } }), 50);
          return () => {};
        }
      };</script>`;
      content = Buffer.from(content.toString().replace('<script type="module" src="./main.js"></script>', fixture + '<script type="module" src="./main.js"></script>'));
    }
    response.writeHead(200, { "Content-Type": types[extname(path)] ?? "application/octet-stream" }); response.end(content);
  }
  catch { response.writeHead(404).end("Not found"); }
}).listen(4317, "127.0.0.1", () => console.log("Sandwich UI: http://127.0.0.1:4317"));
