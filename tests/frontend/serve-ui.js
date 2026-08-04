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
            { id: "active-1", filename: "ubuntu-24.04.iso", status: "active", completed_bytes: 5242880, total_bytes: 10485760, bytes_per_second: 1048576, eta_seconds: 5, connections: 8, num_pieces: 40, bitfield: "ffffe000000000000000", source_url: "https://releases.example.com/ubuntu-24.04.iso", directory: "C:\\Users\\Tester\\Downloads" },
            { id: "paused-1", filename: "album.flac", status: "paused", completed_bytes: 1048576, total_bytes: 4194304, bytes_per_second: 0, connections: 0, num_pieces: 16, bitfield: "f000", source_url: "https://music.example.com/album.flac", directory: "C:\\Users\\Tester\\Downloads" },
            { id: "failed-1", filename: "report.pdf", status: "failed", completed_bytes: 0, total_bytes: 2048, bytes_per_second: 0, connections: 0, num_pieces: 1, bitfield: "0", error: { message: "The destination is unavailable." }, source_url: "https://docs.example.com/report.pdf", directory: "C:\\Users\\Tester\\Downloads" },
            { id: "completed-1", filename: "setup.exe", status: "completed", completed_bytes: 4096, total_bytes: 4096, bytes_per_second: 0, connections: 0, num_pieces: 8, bitfield: "ff", source_url: "https://apps.example.com/setup.exe", directory: "C:\\Users\\Tester\\Downloads" }
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
    // No caching: a stale ES module in the browser is indistinguishable from a broken change,
    // which is a genuinely expensive way to lose an afternoon.
    response.writeHead(200, {
      "Content-Type": types[extname(path)] ?? "application/octet-stream",
      "Cache-Control": "no-store, must-revalidate"
    });
    response.end(content);
  }
  catch { response.writeHead(404).end("Not found"); }
}).listen(4317, "127.0.0.1", () => console.log("Sandwich UI: http://127.0.0.1:4317"));
